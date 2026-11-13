# helm 发布流程（release.yml）

本文描述 `.github/workflows/release.yml` 的职责边界、发布门槛与操作步骤。常规 push / PR 校验见 `ci.yml`，两者互不影响：`release.yml` 仅由 `v*` tag 触发。

## 职责边界

`release.yml` 只做两件事，且严格分离：

| 作业 | 职责 | 接触面 |
| --- | --- | --- |
| `verify` | 校验 tag 与包元数据（版本锁步、repository 字段） | 仅读取仓库 |
| `build` | 构建并测试全部 workspace 包（protocol / kernel / node / cli / web 及未来 payload / desktop） | 仅读取仓库 |
| `npm-payload` | 公开 npm 包（Hub payload）的条件发布，带 provenance | npm registry |
| `desktop-release` | GitHub Release 草稿与 Electron 桌面安装包附件 | GitHub Releases |

`npm-payload` 不碰 GitHub Release；`desktop-release` 不碰 npm registry。

## 触发与版本锁步规则

- 触发条件：推送形如 `v*` 的 tag（如 `v0.1.0`、`v1.2.3-rc.1`）。
- tag 必须是 `v<semver>`，否则 `verify` 直接失败。
- **公开包（未置 `private: true`）版本必须与 tag 完全一致**（锁步），不一致即失败并逐个列出。
- 公开包必须声明 `repository` 字段：npm provenance 会校验发布源仓库与 GitHub 仓库一致，缺失必然被拒，`verify` 提前报错。
- private 包版本不一致仅告警、不阻断（允许桌面端等自有版本节奏）。
- 扫描范围：`packages/` 下至多两层 `package.json`（覆盖未来的 `packages/desktop/payload`），排除 `node_modules` / `dist` / 点开头目录。门槛完全由包元数据驱动，不维护包名单。

## npm Hub payload 发布（当前为占位）

**当前状态（如实）**：workspace 内 5 个包（`@helm/protocol` / `@helm/kernel` / `@helm/node` / `@helm/cli` / `@helm/web`）均为 `private: true`，因此 `publishable-count` 恒为 0，`npm-payload` 稳定走**占位跳过**分支：作业绿色成功、日志给出 notice 说明、不执行任何 `npm publish`。这是有意设计——绝不在没有明确公开包授权（元数据）的情况下，让 tag 发布去执行注定失败或超出授权的 npm 发布。

### 接入一个公开 payload 包的清单

1. 去掉目标包 `package.json` 的 `"private": true`。
2. 补充 `repository` 字段（须指向 `team4u/helm`，provenance 校验依赖）。
3. 版本与 tag 锁步（打 tag 前全量 bump）。
4. 依赖中不得出现未打包的 `workspace:*`（`pnpm pack` 会将其替换为真实版本号，需确保对应包已先行发布；或将依赖打包进 `dist` 产物）。
5. 建议补充 `"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }` 与 `files` 白名单。
6. 若包位于 `packages/<两层路径>`（如 `packages/desktop/payload`），需在 `pnpm-workspace.yaml` 登记使其纳入构建。
7. 在仓库 Settings -> Secrets and variables -> Actions 配置 `NPM_TOKEN`（npmjs.com 的发布令牌，建议 Granular Access Token 并限定目标包）。**令牌只存 secret，严禁入库或写进日志。**

满足以上条件后打 `v*` tag，`npm-payload` 自动进入发布分支：`pnpm pack` 打包后 `npm publish <tarball> --provenance --access public`。

### provenance / OIDC 安全模型

- `npm-payload` 作业声明 `id-token: write`，GitHub 通过 OIDC 向 npm 提供来源证明，`--provenance` 生成可溯源的签名声明（需要 npm >= 9.5，Node 24 自带 npm 满足）。
- 认证令牌通过 `NODE_AUTH_TOKEN` 环境变量引用 `secrets.NPM_TOKEN`，由 `setup-node` 的 `registry-url` 写入 runner 的 `~/.npmrc`，不落仓库。
- 有待发布包但未配置 `NPM_TOKEN` 时，作业在发布前快速失败并给出明确指引，不会半途报晦涩错误。
- 如需完全免令牌的 npm trusted publishing（OIDC 直接认证），需在 npmjs.com 侧配置后微调本工作流，当前未启用。

## 桌面安装包（Electron）占位

- `packages/desktop` **当前不存在**：`desktop-release` 仍会创建占位**草稿** Release（附 npm payload 状态说明与 `--generate-notes` 自动变更记录），不附带任何安装包。
- 接入约定：`packages/desktop` 构建产物输出到 `packages/desktop/dist/`，作业自动将其中全部文件作为附件上传（`--clobber` 支持重复运行覆盖）。
- 桌面包存在但 `dist/` 为空视为真实故障，作业显式失败，不静默发布空 Release。
- 草稿 Release 需人工核对后手动 Publish，流水线不自动公开。

## 发布操作步骤

```bash
# 1. 全量锁步 bump 版本（所有待发布包与 tag 同版本）
# 2. 提交变更
git commit -am "chore(release): v0.1.0"
# 3. 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
# 4. 在 Actions 观察 Release 流水线（verify -> build -> npm-payload / desktop-release）
# 5. 核对草稿 Release 内容后手动 Publish
```

## 本地校验

```bash
# YAML 语法
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
# 工作流静态检查（可选，若本地安装了 actionlint）
actionlint .github/workflows/release.yml
```

## 排错速查

| 现象 | 原因与处理 |
| --- | --- |
| `verify` 失败：公开包版本与 tag 不一致 | 将该包版本改为与 tag 一致（锁步）后重新打 tag |
| `verify` 失败：缺少 repository 字段 | 补充指向本仓库的 `repository` 字段 |
| `npm-payload` 失败：未配置 NPM_TOKEN | 按上文清单第 7 步配置 secret |
| `npm publish` 被 registry 拒绝（provenance） | 确认包 `repository` 与实际发布仓库一致、令牌有目标包权限 |
| `desktop-release` 失败：dist 为空 | 检查 `packages/desktop` 构建产物路径是否符合 `dist/` 约定 |
