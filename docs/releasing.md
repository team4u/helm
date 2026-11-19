# helm 发布流程

本文面向执行版本发布的维护者，描述 `.github/workflows/` 工作流的真实边界：本地能验什么、CI 验什么、release 流水线发布什么。读完你应当能安全地打 tag 发版并知道每一步失败时去哪里找现场。开发阶段的日常验证见 [AGENTS.md](../AGENTS.md) 与[安装与配置指南](getting-started/installation.md)。

## 当前状态：两条工作流各管一段

| 工作流 | 触发 | 职责 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR | 全仓验证：typecheck → lint → `check:hygiene` → build → POSIX 全量 `test:all`、Windows `test:unit` + 跨平台路径回归 |
| `release.yml` | 仅 `v*` tag | 发布：verify → build → npm-publish（payload 与 CLI 两制品） |

`release.yml` 的 `build` 作业承担发布门槛（等价 ci.yml 的 ubuntu 通道 + payload 与 CLI 制品的网络验收，均在 `packages/payload/test/payload.test.ts` 单文件内执行——两个制品共享同一次组装）。

## release.yml 职责链

| 作业 | 职责 | 触达面 |
| :--- | :--- | :--- |
| `verify` | 校验 tag 形态（`v<semver>`）与 dist-tag 归属（预发布 → `beta`）；探测 payload 组装器（占位可跳过）；**硬性要求 CLI 包存在** | 仅读仓库 |
| `build` | ubuntu 全量构建与测试 + 制品网络验收（`PAYLOAD_NPM_SMOKE=1`：payload e2e（含 bundle CLI 真实 HTTP `status`）、CLI 真实 tarball 全局安装、黄金序列） | 仅读仓库 |
| `npm-publish` | 两制品条件发布（共享一次 checkout/install/build，payload 先、CLI 后，各仅一次，provenance） | npm registry |

依赖关系：`verify → build → npm-publish`。npm 发布必须等全量测试通过；CLI 在同作业内晚于 payload 发布（其默认更新路径从 registry 解析 payload）。

## npm 制品发布（每个制品一个 manifest 权威）

发布依据**只有**各制品的构建产物 manifest：Hub payload 认 `packages/payload/dist/package.json`（默认 name `@team4u/helm-hub`，构建期 env `HELM_PAYLOAD_PACKAGE` 可覆盖），CLI 认 `packages/payload/dist-cli/package.json`（默认 name `@team4u/helm`、唯一 bin `helm`，构建期 env `HELM_CLI_PACKAGE` 可覆盖；由 `@helm/payload` 组装器把 `packages/cli` 的 dist 入口连同 `@helm/hub-launcher` → `@helm/update` 依赖闭包与 `tar` 打成零依赖单文件 bundle——完整控制 CLI，一步 `npm install -g` 即用；Hub payload 内的 `cli/dist/index.js` 是同一份 bundle 字节）。不做全仓 non-private 扫描。三条铁律：

- **绝不 `pnpm pack` workspace 包**：`@helm/payload` 与 `@helm/cli` 永远 `private: true`，前者是组装器、后者是源码包，都不是发布物。对它们 pack 会把 manifest 垫进 `dist*` 路径前缀，updater 按根布局探测必然落空。发布必须分别进入 `packages/payload/dist` / `packages/payload/dist-cli` 目录 `npm pack` / `npm publish`（tarball 根即制品根）；
- **CLI 制品必须零依赖**：它以单文件 bundle 交付（bin `helm`），消费者一步 `npm install -g` 即用。任何 `workspace:` / `file:` / `@helm/*` 依赖都会让全局安装直接失败（本仓库不发布任何 `@helm/*` 源码包），组装期（esbuild metafile 硬校验外部 `@helm/*` import）与发布期双重硬校验；`plugins build` 的编译器按机制边界运行期解析（见[安装指南](getting-started/installation.md)），不构成依赖；
- **绝不伪称已发布**：发布记录的 npm 状态由各作业实际输出渲染，成功 / 明确跳过 / 未完成三种结论如实陈述。

发布门槛（两个制品同构，全部满足才 `npm publish`）：制品源包存在（payload → `packages/payload`，占位期可跳过；CLI → `packages/cli`，**硬性要求**，verify 阶段缺失即失败）→ 构建后制品 manifest 存在（缺失即组装器契约破裂显式失败）→ `private !== true`（`private: true` 走占位跳过分支，绿色成功不 publish）→ `version` 与 tag 锁步 + `repository` 字段存在（provenance 必需）→ `NPM_TOKEN` secret 已配置（注入为 `NODE_AUTH_TOKEN`；缺失快速失败给指引）。满足后在各自制品目录内 `npm pack` 打 tarball 再 `npm publish <tarball> --provenance --access public`（provenance 依赖 OIDC，作业声明 `id-token: write`）。npm Trusted Publishing（OIDC 免令牌）当前未启用。

dist-tag 策略（两个制品一致，`verify` 作业按 semver 判定一次）：版本核心含连字符（预发布，如 `1.2.3-rc.1`）→ `npm publish --tag beta`；build 元数据（`+` 之后）不算预发布（如 `1.2.3+build-7` 仍走 `latest`）。预发布绝不隐式进入 `latest`，消费者 `npm install -g` 与 CLI 的 `latest` 解析默认只看到正式版（CLI 侧的 beta 通道由 `helm update --channel beta` 显式选择）。

CLI 的两条附加门：

- **零依赖硬校验**：`dist-cli/package.json` 声明任何运行时依赖即显式失败（组装期 `build.mjs` 已以 esbuild metafile 拒绝外部 `@helm/*` import 的 bundle，此处为发布期第二道门；bin 必须唯一为 `helm`）；
- **payload 已发布才发 CLI**：CLI 的默认更新路径从 npm registry 解析 Hub payload；`npm-payload` 未成功发布（`published=false`）时 CLI 显式跳过，不发布一个默认流程 404 的「一次安装」入口。

## 发布操作步骤

```bash
# 1. 全量锁步 bump 版本（payload 版本单一来源需与 tag 一致；CLI 制品与 payload 同源）
# 2. 提交变更
git commit -am "chore(release): v0.1.0"
# 3. 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
# 4. 在 Actions 观察 verify → build → npm-publish
```

## 本地校验

本地能覆盖的检查与流水线的边界：

```bash
# 全量验收（等价发布门槛的测试面）
pnpm build && pnpm typecheck && pnpm lint && pnpm check:hygiene && pnpm test:all

# payload 组装与契约（同时产出 dist/ 与 dist-cli/；网络验收默认跳过，
# CI 在 release 的 build 作业以 PAYLOAD_NPM_SMOKE=1 执行）
pnpm --filter @helm/payload run build

# 制品验收（payload + CLI 组装契约、真实 tarball npm install -g；
# 网络验收含黄金序列需 PAYLOAD_NPM_SMOKE=1）
node scripts/run-tests.mjs packages/payload/test/payload.test.ts

# 工作流 YAML 静态检查（可选）
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

本地**不**覆盖：npm 真实 publish。

## 排错速查

| 现象 | 原因与处理 |
| :--- | :--- |
| `verify` 失败：tag 不是 v\<semver\> | 改用合法 tag（如 `v0.1.0`、`v1.2.3-rc.1`） |
| `verify` 失败：`packages/cli` 缺失 | CLI 为发布硬依赖：该 tag 无法产出 CLI 制品，先合入 CLI 包 |
| `npm-publish`：dist/package.json 缺失 | 组装器契约破裂：`pnpm build` 后 `packages/payload/dist` 根必须有可发布 package.json |
| `npm-publish`：dist-cli/package.json 缺失 | CLI 组装契约破裂：确认 `pnpm build` 产出 `dist-cli/` bundle |
| `npm-publish`：CLI 声明了运行时依赖 | bundle 不完整：`build.mjs` 应把 CLI 的 workspace 闭包全部内联，检查 `dist-cli/index.js` 是否残留外部 `@helm/*` import |
| `npm-publish`：CLI 因 payload 未发布而跳过 | 如实跳过：先解决 payload 发布步骤的失败/跳过原因，CLI 与 payload 需同轮发布 |
| `npm-publish`：版本与 tag 不一致 | 版本单一来源锁步 tag 后重新打 tag |
| `npm-publish`：未配置 NPM_TOKEN | Settings -> Secrets and variables -> Actions 配置后重跑 |
| `npm publish` 被 registry 拒绝（provenance） | 确认制品 `repository` 与实际仓库一致、令牌有目标包权限 |

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 两条工作流 | `.github/workflows/ci.yml`、`release.yml` |
| payload 组装器 | `packages/payload/build.mjs`（CLI 制品组装在 `packages/payload/src/assemble-cli.mjs`） |
| 测试 | `packages/payload/test/payload.test.ts`（payload 契约、CLI 制品验收与黄金序列网络验收，单文件共享一次组装） |

## 相关文档

- [@helm/payload README](../packages/payload/README.md)：payload 布局与依赖补齐契约
- [安装与配置指南](getting-started/installation.md)：端口与数据目录规划
