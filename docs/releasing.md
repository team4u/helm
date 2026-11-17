# helm 发布流程

本文面向执行版本发布的维护者，描述 `.github/workflows/` 工作流的真实边界：本地能验什么、CI 验什么、release 流水线发布什么。读完你应当能安全地打 tag 发版并知道每一步失败时去哪里找现场。开发阶段的日常验证见 [AGENTS.md](../AGENTS.md) 与[安装与配置指南](getting-started/installation.md)。

## 当前状态：两条工作流各管一段

| 工作流 | 触发 | 职责 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR | 全仓验证：typecheck → lint → `check:hygiene` → build → POSIX 全量 `test:all`、Windows `test:unit` + 跨平台路径回归 |
| `release.yml` | 仅 `v*` tag | 发布：verify → build → npm-payload |

`release.yml` 的 `build` 作业承担发布门槛（等价 ci.yml 的 ubuntu 通道 + payload pack/install/start 网络验收）。

## release.yml 职责链

| 作业 | 职责 | 触达面 |
| :--- | :--- | :--- |
| `verify` | 校验 tag 形态（`v<semver>`）、探测 payload 组装器 | 仅读仓库 |
| `build` | ubuntu 全量构建与测试 + payload 网络验收（`PAYLOAD_NPM_SMOKE=1`） | 仅读仓库 |
| `npm-payload` | npm Hub payload 条件发布（仅 ubuntu 一次，provenance） | npm registry |

依赖关系：`verify → build → npm-payload`。npm 发布必须等全量测试通过。

## npm Hub payload 发布（单一入口）

发布依据**只有** `packages/payload/dist/package.json`（构建产物；默认 name `@team4u/helm-hub`，构建期 env `HELM_PAYLOAD_PACKAGE` 可覆盖）。不做全仓 non-private 扫描。两条铁律：

- **绝不 `pnpm pack` workspace 包**：`@helm/payload` 永远 `private: true`，是组装器不是发布物。对它 pack 会把 manifest 垫进 `dist/` 路径前缀，updater 按根布局探测必然落空。发布必须进入 `packages/payload/dist` 目录 `npm pack` / `npm publish`（tarball 根即 payload 根）；
- **绝不伪称已发布**：Release 说明的 npm 状态由 `npm-payload` 作业实际输出渲染，成功 / 明确跳过 / 未完成三种结论如实陈述。

发布门槛（全部满足才 `npm publish`）：`packages/payload` 存在 → 构建后 `dist/package.json` 存在（缺失即组装器契约破裂显式失败）→ `private !== true`（`private: true` 走占位跳过分支，绿色成功不 publish）→ `version` 与 tag 锁步 + `repository` 字段存在（provenance 必需）→ `NPM_TOKEN` secret 已配置（注入为 `NODE_AUTH_TOKEN`；缺失快速失败给指引）。满足后在 dist 内 `npm pack` 打 tarball 再 `npm publish <tarball> --provenance --access public`（provenance 依赖 OIDC，作业声明 `id-token: write`）。npm Trusted Publishing（OIDC 免令牌）当前未启用。

## 发布操作步骤

```bash
# 1. 全量锁步 bump 版本（payload 版本单一来源需与 tag 一致）
# 2. 提交变更
git commit -am "chore(release): v0.1.0"
# 3. 打 tag 并推送
git tag v0.1.0
git push origin v0.1.0
# 4. 在 Actions 观察 verify → build → npm-payload
```

## 本地校验

本地能覆盖的检查与流水线的边界：

```bash
# 全量验收（等价发布门槛的测试面）
pnpm build && pnpm typecheck && pnpm lint && pnpm check:hygiene && pnpm test:all

# payload 组装与契约（网络验收默认跳过，CI 在 release 的 build 作业以 PAYLOAD_NPM_SMOKE=1 执行）
pnpm --filter @helm/payload run build

# 工作流 YAML 静态检查（可选）
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

本地**不**覆盖：npm 真实 publish。

## 排错速查

| 现象 | 原因与处理 |
| :--- | :--- |
| `verify` 失败：tag 不是 v\<semver\> | 改用合法 tag（如 `v0.1.0`、`v1.2.3-rc.1`） |
| `npm-payload`：dist/package.json 缺失 | 组装器契约破裂：`pnpm build` 后 `packages/payload/dist` 根必须有可发布 package.json |
| `npm-payload`：版本与 tag 不一致 | payload 版本单一来源锁步 tag 后重新打 tag |
| `npm-payload`：未配置 NPM_TOKEN | Settings -> Secrets and variables -> Actions 配置后重跑 |
| `npm publish` 被 registry 拒绝（provenance） | 确认 payload `repository` 与实际仓库一致、令牌有目标包权限 |

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 两条工作流 | `.github/workflows/ci.yml`、`release.yml` |
| payload 组装器 | `packages/payload/build.mjs` |
| 测试 | `packages/payload/test/payload.test.ts`（含网络验收用例） |

## 相关文档

- [@helm/payload README](../packages/payload/README.md)：payload 布局与依赖补齐契约
- [安装与配置指南](getting-started/installation.md)：端口与数据目录规划
