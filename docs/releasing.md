# helm 发布流程

本文面向执行版本发布的维护者，描述 `.github/workflows/` 三条工作流的真实边界：本地能验什么、CI 验什么、release 流水线发布什么、哪些环节没有覆盖（签名/公证、部分网络场景）。读完你应当能安全地打 tag 发版并知道每一步失败时去哪里找现场。开发阶段的日常验证见 [AGENTS.md](../AGENTS.md) 与[安装与配置指南](getting-started/installation.md)。

## 当前状态：三条工作流各管一段

| 工作流 | 触发 | 职责 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR | 全仓验证：typecheck → lint → `check:hygiene` → build → POSIX 全量 `test:all`、Windows `test:unit` + 跨平台路径回归 |
| `desktop-ci.yml` | push(main) / PR / 手动 | 桌面三平台（Linux/Windows/macOS）：desktop 包 typecheck/build → 测试 → `dist:dir` 解包应用 → 打包 App 冒烟 → `dist --publish never` 产出安装包 artifact（绝不自动发布） |
| `release.yml` | 仅 `v*` tag | 发布：verify → build → desktop-package×3 → npm-payload → desktop-release（草稿 Release） |

`desktop-ci.yml` 不重复跑全仓测试（那是 `ci.yml` 的职责），`release.yml` 的 `build` 作业承担发布门槛（等价 ci.yml 的 ubuntu 通道 + payload pack/install/start 网络验收）。

## release.yml 职责链

| 作业 | 职责 | 触达面 |
| :--- | :--- | :--- |
| `verify` | 校验 tag 形态（`v<semver>`）、探测 payload 组装器 | 仅读仓库 |
| `build` | ubuntu 全量构建与测试 + payload 网络验收（`PAYLOAD_NPM_SMOKE=1`） | 仅读仓库 |
| `desktop-package` | 三平台打安装包（`--publish never`）+ 打包 App 冒烟，产物作 workflow artifact | 仅读仓库 |
| `npm-payload` | npm Hub payload 条件发布（仅 ubuntu 一次，provenance） | npm registry |
| `desktop-release` | 汇总三平台安装包，创建草稿 Release 并上传附件 | GitHub Releases |

依赖关系：`verify → build → desktop-package×3 → npm-payload → desktop-release`。npm 发布必须等全量测试与三平台打包/冒烟全部通过；`desktop-release` 同时需要 `npm-payload` 有确定结果（成功或明确跳过），npm 发布失败不创建草稿。

## npm Hub payload 发布（单一入口）

发布依据**只有** `packages/payload/dist/package.json`（构建产物；默认 name `@team4u/helm-hub`，构建期 env `HELM_PAYLOAD_PACKAGE` 可覆盖）。不做全仓 non-private 扫描。两条铁律：

- **绝不 `pnpm pack` workspace 包**：`@helm/payload` 永远 `private: true`，是组装器不是发布物。对它 pack 会把 manifest 垫进 `dist/` 路径前缀，updater 按根布局探测必然落空。发布必须进入 `packages/payload/dist` 目录 `npm pack` / `npm publish`（tarball 根即 payload 根）；
- **绝不伪称已发布**：Release 说明的 npm 状态由 `npm-payload` 作业实际输出渲染，成功 / 明确跳过 / 未完成三种结论如实陈述。

发布门槛（全部满足才 `npm publish`）：`packages/payload` 存在 → 构建后 `dist/package.json` 存在（缺失即组装器契约破裂显式失败）→ `private !== true`（`private: true` 走占位跳过分支，绿色成功不 publish）→ `version` 与 tag 锁步 + `repository` 字段存在（provenance 必需）→ `NPM_TOKEN` secret 已配置（注入为 `NODE_AUTH_TOKEN`；缺失快速失败给指引）。满足后在 dist 内 `npm pack` 打 tarball 再 `npm publish <tarball> --provenance --access public`（provenance 依赖 OIDC，作业声明 `id-token: write`）。npm Trusted Publishing（OIDC 免令牌）当前未启用。

## 桌面安装包（Electron）

- `desktop-package` 流程：install frozen → 契约检查（`scripts/desktop-ci-contract.mjs`）→ 全仓 build（`assemble-hub` 依赖 workspace dist）→ `dist:dir` → 冒烟（`scripts/desktop-smoke.mjs --packaged`：定位解包可执行文件、隔离 `HELM_DATA_DIR`、固定端口（被占 preflight 拒绝、绝不 attach 既有服务）、60s 超时杀树，依据 `smoke.json` 的 `ok: true` 判定；Linux 需 `xvfb-run` 与 `libasound2t64`）→ `dist --publish never` 产出安装包；
- 安装包目录是 **`packages/desktop/release/`**（electron-builder 输出；`dist/` 是 tsc 产物目录，两回事）。上传集合：`*.exe`（NSIS）/ `*.dmg` / `*.zip` / `*.AppImage` / `*.deb`，`if-no-files-found: error`；`desktop-release` 下载后再兜底校验非空，绝不发布空附件草稿；
- 冒烟报告（`smoke.json` / 截图 / 日志）`if: always()` 上传，失败现场永远保留；
- **签名与公证的真实边界：当前无证书资产，全部安装包未签名 / 未公证（mac `identity: null`）**，草稿说明如实陈述；macOS / Windows 首次安装可能触发系统开发者验证提示。Electron 底座更新走托盘「下载桌面新版」打开 GitHub Releases，完整应用的无人值守替换尚未接入；
- 草稿 Release（`--generate-notes`）需人工核对后手动 Publish；重复运行同一 tag 用 `--clobber` 覆盖附件。

## 发布操作步骤

```bash
# 1. 全量锁步 bump 版本（payload 版本单一来源需与 tag 一致）
# 2. 提交变更
git commit -am "chore(release): v0.1.0"
# 3. 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
# 4. 在 Actions 观察 verify → build → desktop-package×3 → npm-payload → desktop-release
# 5. 核对草稿 Release 内容（npm 状态行、安装包清单、未签名说明）后手动 Publish
```

## 本地校验

本地能覆盖的检查与流水线的边界：

```bash
# 全量验收（等价发布门槛的测试面）
pnpm build && pnpm typecheck && pnpm lint && pnpm check:hygiene && pnpm test:all

# payload 组装与契约（网络验收默认跳过，CI 在 release 的 build 作业以 PAYLOAD_NPM_SMOKE=1 执行）
pnpm --filter @helm/payload run build

# 桌面打包 App 冒烟（需先 dist:dir；本机 3202 有真实 Hub 时显式传测试端口）
pnpm --filter @helm/desktop run dist:dir
node scripts/desktop-smoke.mjs --packaged --port=32020

# 工作流 YAML 静态检查（可选）
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

本地**不**覆盖：三平台交叉打包（各平台 runner 自行 assemble，不能拿 Linux 依赖交叉打 macOS）、npm 真实 publish、GitHub Release 创建、真实 npm registry 下载链路（桌面 updater 的完整端到端）。

## 排错速查

| 现象 | 原因与处理 |
| :--- | :--- |
| `verify` 失败：tag 不是 v\<semver\> | 改用合法 tag（如 `v0.1.0`、`v1.2.3-rc.1`） |
| `npm-payload`：dist/package.json 缺失 | 组装器契约破裂：`pnpm build` 后 `packages/payload/dist` 根必须有可发布 package.json |
| `npm-payload`：版本与 tag 不一致 | payload 版本单一来源锁步 tag 后重新打 tag |
| `npm-payload`：未配置 NPM_TOKEN | Settings -> Secrets and variables -> Actions 配置后重跑 |
| `npm publish` 被 registry 拒绝（provenance） | 确认 payload `repository` 与实际仓库一致、令牌有目标包权限 |
| `desktop-package` 冒烟失败 | 下载 `release-smoke-<os>` artifact 看 `smoke.json` / 截图 / 日志尾部 |
| `desktop-package` 上传失败：no files found | `packages/desktop/release/` 无安装包产物，检查 electron-builder 日志 |
| `desktop-release`：未下载到任何安装包 | 矩阵 artifact 缺失（上游失败时本作业不会运行；此处为兜底断言） |

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 三条工作流 | `.github/workflows/ci.yml`、`desktop-ci.yml`、`release.yml` |
| 桌面冒烟脚本 | `scripts/desktop-smoke.mjs` |
| 桌面包契约检查 | `scripts/desktop-ci-contract.mjs` |
| payload 组装器 | `packages/payload/build.mjs` |
| 桌面打包配置 | `packages/desktop/electron-builder.yml`、`scripts/assemble-hub.mjs` |
| 测试 | `packages/payload/test/payload.test.ts`（含网络验收用例）、`packages/desktop/test/` |

## 相关文档

- [@helm/payload README](../packages/payload/README.md)：payload 布局与依赖补齐契约
- [Helm Desktop README](../packages/desktop/README.md)：桌面监督、更新与环境变量
- [安装与配置指南](getting-started/installation.md)：端口与数据目录规划
