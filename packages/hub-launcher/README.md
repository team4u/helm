# @helm/hub-launcher

稳定的本机 Hub launcher/updater：管理 Hub npm payload（`@team4u/helm-hub`）的检查、安装、启动、停止、健康门控更新与失败回滚。每个成员本机一个独立 Hub；launcher 是外部稳定安装，绝不被它管理的 release 覆盖。

## 产品边界

- **只做本地单实例**：无云端 Hub、无 Supervisor 常驻进程、无分享、无多租户。`check`/`update` 可直接被系统 cron / `helm` 触发器组合成定时检查（`helm-hub-launcher update --start`）。
- **程序状态与用户数据严格分离**：release/state 全部在安装根目录（默认 `~/.helm-hub`，env `HELM_HUB_INSTALL_ROOT`）；Hub 自己的 `~/.helm`（`HELM_DATA_DIR`）与插件状态 launcher 从不写入。
- **通用更新机制零复制**：registry 元数据、SHA512 校验下载、不可变 staging（`.complete` 标记与复用重校验）、更新锁、npm runner 全部来自共享 `@helm/update`（见 `src/update-core.ts` 端口与绑定计划）；本包只保留 Hub 产品策略（pid 管理、健康门控、回滚、launch 配置）。

## 安装根目录布局

```text
~/.helm-hub/
  releases/<ver>/<uuid>/   不可变候选（npm 布局 node_modules/<pkg>/start.mjs + 依赖已装齐）
  current.json             已提交 release 指针（version/releaseDir/entryPath/updatedAt，0600）
  update-blocked.json      候选健康检查失败后的冷却标记（默认 30 分钟，env 可覆盖）
  hub.pid                  分离进程身份（pid/version/port/host/dataDir/startedAt）
  launch.json              粘性启动配置（port/host/dataDir/model/webDistDir；仅显式值，无秘密）
  logs/hub.log             分离 Hub 进程 stdout/stderr
  start.lock / update.lock 并发互斥（O_EXCL）
```

## 命令

```bash
helm-hub-launcher check                          # 查询 registry 最新版（无状态变更）
helm-hub-launcher update [--version <ver>]       # staging → （运行中则优雅停止）→ 原子提交 current
                                                 #   → 启动候选 → 健康门控；失败回滚旧版并写 blocked
helm-hub-launcher update --tarball <path> --version <ver>   # 本地 tgz 安装（同样 npm 安装 + 自检）
helm-hub-launcher start [--port|--host|--data-dir|--model|--web-dist-dir]
helm-hub-launcher stop                           # 身份核验（health 探针）→ SIGTERM → 超时升级进程树终止
helm-hub-launcher restart
helm-hub-launcher status                         # 安装/运行/blocked 概览（--json 机器可读）
```

`--json` 全局生效：成功输出 JSON 到 stdout，失败输出 `{ ok: false, error: { code, message } }` 到 stderr 并退出 1。

## 更新流程与诚实性

1. 目标版本解析（`--version` 或 registry latest，严格 SemVer）；
2. blocked 冷却门（同版本默认 30 分钟，`--force` 或不同版本放行）；同版本 no-op；降级显式拒绝（`--force` 覆盖）；
3. staging：registry 下载（SHA512 SRI 校验，经 `@helm/update`）或本地 tarball → 候选目录内 `npm install --omit=dev --ignore-scripts`（payload 自带 `file:./<pkg>.tgz` 依赖闭包）→ 校验包名/版本与 `start.mjs`/`manifest.json` 契约 → 执行 `node start.mjs check` 自检（绝不启动 Hub）；
4. 提交序列：**先**优雅停止运行中的 Hub（身份无法核验则中止，状态零变更），**再**原子写 `current.json`；
5. 启动候选并轮询公开端点 `GET /api/auth/status`；失败则恢复旧 `current.json`、重启旧版、写 `update-blocked.json`，并输出完整诊断链（含 `logs/hub.log` 尾部 40 行）；
6. 绝不在同一 dataDir 上并行运行两个 Hub（SQLite 互斥由「先停后启」保证；`start` 自带防双启）。

并发 `start` 恰逢更新提交窗口时，更新显式报 `update_race_with_start` 并保留已提交指针，不误判为候选失败。

## 跨平台边界

- 优雅关停是 POSIX 优先：Windows 上 `process.kill(pid, 'SIGTERM')` 无法触发处理器，`stop` 退化为短暂宽限后进程树升级终止（`taskkill /F /T`，与 `@helm/env-io` 的 `killProcessTree` 一致）。
- npm 调用（win32 `npm-cli.js` 解析、无 shell、超时进程组终止）由 `@helm/update` 的 `runNpm` 提供。
- 身份纪律：pid 存活但 health 端点不可达时拒绝发送任何信号（可能是 pid 复用），要求人工核验。

## 配置优先级

CLI flags > 环境变量（`HELM_PORT`/`HELM_HOST`/`HELM_DATA_DIR`/`HELM_MODEL`/`HELM_WEB_DIST_DIR`）> `launch.json` 粘性配置 > 默认（3202 / 127.0.0.1）。启动成功后把生效配置持久化进 `launch.json`，更新重启沿用。其它 env：`HELM_HUB_INSTALL_ROOT`、`HELM_NPM_REGISTRY`、`HELM_PAYLOAD_PACKAGE`（默认 `@team4u/helm-hub`）、`HELM_HUB_BLOCKED_COOLDOWN_MS`。

## `@helm/update` 绑定状态（重要）

共享引擎抽取（黑板 #15）合入前，`resolveUpdateCore()` 返回 `null`：`check`/`update` 以 `update_core_unavailable` 显式失败，`start`/`stop`/`restart`/`status` 不受影响。绑定落在 `src/update-core.ts`（适配 `fetchLatestVersion` / `downloadVerifiedTarball` / `runNpm` / `stageImmutableRelease` / `withUpdateLock`），随后在 `package.json` 增加 `@helm/update` 依赖。测试通过注入 fake core（`test/fixtures.ts`）覆盖全部编排路径，包括 staging 布局契约与 `.complete` 复用。

## 测试

`test/records.test.ts`（状态记录/配置解析）、`test/lifecycle.test.ts`（真实分离进程的启停/身份/升级终止/诊断）、`test/update-flow.test.ts`（staging/提交/健康回滚/blocked/锁/缓存复用）、`test/cli.test.ts`（解析纪律与端到端命令）。真实 npm + 网络的 smoke 验收（真实 `npm pack` payload 安装）沿用 `PAYLOAD_NPM_SMOKE` 模式留待 CI 门控，见 `@helm/payload`。
