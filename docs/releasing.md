# helm 发布流程（release.yml）

本文描述 `.github/workflows/release.yml` 的职责链、发布门槛与操作步骤。常规 push / PR 校验见 `ci.yml`，桌面三平台日常验证见 `desktop-ci.yml`，互不影响：`release.yml` 仅由 `v*` tag 触发。

## 职责链

| 作业 | 职责 | 触发面 |
| --- | --- | --- |
| `verify` | 校验 tag 形态、探测 payload 组装器 | 仅读取仓库 |
| `build` | ubuntu 全量构建与测试（等价 ci.yml，作为发布门槛） | 仅读取仓库 |
| `npm-payload` | npm Hub payload 条件发布（仅 ubuntu 一次，provenance） | npm registry |
| `desktop-package` | 三平台（Linux/Windows/macOS）打安装包（`--publish never`）+ 打包 App 冒烟，产物作为 workflow artifact | 仅读取仓库 |
| `desktop-release` | 汇总三平台安装包，创建草稿 Release 并上传附件 | GitHub Releases |

依赖关系：`verify → build → (npm-payload ∥ desktop-package×3) → desktop-release`。`desktop-release` 同时需要 `npm-payload` 与全部 `desktop-package` 成功——**三平台打包/冒烟与 npm 发布结论齐备之前绝不创建安装包草稿**；npm-payload 失败则草稿不创建（配置好令牌后重跑即可）。

## npm Hub payload 发布（单一入口）

发布依据**只有** `packages/payload/dist/package.json`（构建产物，由 `@helm/payload` 组装器生成；默认 name `@team4u/helm-hub`，构建期 env `HELM_PAYLOAD_PACKAGE` 可覆盖）。不做全仓 non-private 扫描——workspace 包即使去掉 private 也不会被本流水线发布。

两条铁律：

- **绝不 `pnpm pack` workspace 包**：`@helm/payload` 永远 `private: true`，它是组装器不是发布物。对它 pack 会把 manifest 等内容垫进 `dist/` 路径前缀，updater 按 payload 根布局探测必然落空。发布必须进入 `packages/payload/dist` 目录用 `npm pack` / `npm publish`（tarball 根即 payload 根）。
- **绝不伪称已发布**：Release 说明中的 npm 状态由 `npm-payload` 作业的实际输出（`status-line`）渲染，成功 / 明确跳过 / 未完成三种结论如实陈述；令牌缺失在发布前快速失败。

### 发布门槛（全部满足才执行 `npm publish`）

1. `packages/payload` 存在（缺失则整个作业按占位跳过，notice 说明）。
2. `pnpm build` 后 `packages/payload/dist/package.json` 存在——缺失即组装器契约破裂，作业显式失败。
3. 该 package.json `private !== true`（`private: true` 走占位跳过分支，绿色成功、不 publish）。
4. `version` 与 tag 完全锁步（不一致显式失败）；`repository` 字段存在（npm provenance 必需，须指向本仓库）。
5. `NPM_TOKEN` secret 已配置，注入为 `NODE_AUTH_TOKEN`（`setup-node` 的 `registry-url` 据此写入 runner `~/.npmrc`，npm publish 实际读取的就是它）。缺失则快速失败并给出指引，绝不半途报晦涩错误、绝不假装成功。

满足后在 `packages/payload/dist` 内 `npm pack --pack-destination` 打 tarball，再 `npm publish <tarball> --provenance --access public`（provenance 依赖 OIDC，作业声明 `id-token: write`；npm >= 9.5，Node 24 自带满足）。npm Trusted Publishing（OIDC 免令牌直发）当前未启用，启用后可替换第 5 步。

### 与桌面安装包的关系

npm payload 只在 ubuntu 构建、发布一次。三平台桌面安装包 baseline 同源——各平台在 `desktop-package` 矩阵中自行 `assemble-hub` 组装（不消费 npm 产物）；已发布安装的桌面客户端依赖由桌面端 bundled npm 安装，与本流水线无关。

## 桌面安装包（Electron）

- `desktop-package` 矩阵流程：install frozen → 全仓 build → `dist:dir` 解包应用 → `scripts/desktop-smoke.mjs --packaged` 冒烟（定位 `release/*-unpacked` 可执行文件，隔离 `HELM_DATA_DIR`、固定 3202 端口（可显式 `--port=<测试端口>`，端口被占则 preflight 拒绝、绝不 attach 既有服务）、60s 超时杀树，依据 `smoke.json` 的 `ok:true` + `nativeCompiler:true`（workflow/mermaid 编译真实可用）判定；Linux 包 `xvfb-run`，依赖 `libasound2t64`（ubuntu-24.04 包名））→ `dist -- --publish never` 产出安装包。
- 安装包目录是 **`packages/desktop/release/`**（electron-builder `directories.output`；`dist/` 是 tsc 产物目录，两回事）。上传集合：`*.exe`（NSIS）/ `*.dmg` / `*.zip`（mac）/ `*.AppImage` / `*.deb`（Linux）。矩阵上传步骤 `if-no-files-found: error`——某平台一个安装包都没产出即失败，`desktop-release` 下载后再兜底校验非空，绝不发布空附件草稿。
- 冒烟报告（`smoke.json` / 截图 / `stdout.log` / `stderr.log`）在矩阵与 `desktop-ci.yml` 均 `if: always()` 上传（artifact 名 `release-smoke-<os>` / `smoke-report-<os>`），失败现场永远保留。
- 全部未签名 / 未公证（无证书资产；mac `identity: null`），说明如实写进草稿。
- 草稿 Release（`--generate-notes` 自动变更记录 + npm 状态如实陈述）需人工核对后手动 Publish，流水线不自动公开；重复运行同一 tag 用 `--clobber` 覆盖附件。
- 日常 push / PR 的三平台打包与冒烟在 `desktop-ci.yml`（同样上传安装包 artifact，`--publish never`），本流水线不与之重复跑全量测试（`build` 作业承担发布门槛）。

## 发布操作步骤

```bash
# 1. 全量锁步 bump 版本（packages/payload 及 dist 契约的单一版本源需与 tag 一致）
# 2. 提交变更
git commit -am "chore(release): v0.1.0"
# 3. 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
# 4. 在 Actions 观察 Release 流水线（verify → build → npm-payload ∥ desktop-package×3 → desktop-release）
# 5. 核对草稿 Release 内容后手动 Publish
```

## 本地校验

```bash
# YAML 语法
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); yaml.safe_load(open('.github/workflows/desktop-ci.yml'))"
# 工作流静态检查（可选，若本地安装了 actionlint）
actionlint .github/workflows/release.yml .github/workflows/desktop-ci.yml
# 打包 App 冒烟 wrapper（需先 dist:dir 产出解包应用；本机 3202 有真实 Hub 时显式传测试端口）
node scripts/desktop-smoke.mjs --packaged --port=32020
```

## 排错速查

| 现象 | 原因与处理 |
| --- | --- |
| `verify` 失败：tag 不是 v<semver> | 改用合法 tag（如 `v0.1.0`、`v1.2.3-rc.1`） |
| `npm-payload` 失败：dist/package.json 缺失 | 组装器契约破裂：`pnpm build` 后 `packages/payload/dist` 根必须有可发布 package.json（含 name/version/files） |
| `npm-payload` 失败：版本与 tag 不一致 | payload 版本单一来源锁步 tag 后重新打 tag |
| `npm-payload` 失败：未配置 NPM_TOKEN | Settings -> Secrets and variables -> Actions 配置 `NPM_TOKEN`（建议 Granular Access Token 限定 `@team4u/helm-hub`）后重跑 |
| `npm publish` 被 registry 拒绝（provenance） | 确认 payload package.json 的 `repository` 与实际发布仓库一致、令牌有目标包权限 |
| `desktop-package` 冒烟失败 | 下载 `release-smoke-<os>` artifact 看 `smoke.json` / 截图 / 日志尾部 |
| `desktop-package` 上传失败：no files found | `packages/desktop/release/` 无安装包产物，检查 electron-builder 日志 |
| `desktop-release` 失败：未下载到任何安装包 | 矩阵 artifact 缺失（上游已失败时本作业不会运行；此处为兜底断言） |
