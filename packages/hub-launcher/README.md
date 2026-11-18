# @helm/hub-launcher

稳定的本机 Hub launcher/updater：管理 Hub npm payload（`@team4u/helm-hub`）的检查、安装、启动、停止、就绪门控更新与失败回滚。每个成员本机一个独立 Hub；launcher 是外部稳定安装，绝不被它管理的 release 覆盖。

## 产品边界

- **只做本地单实例**：无云端 Hub、无云端 Supervisor、无分享、无多租户。定时检查有两条等价路径：系统 cron / `helm` 触发器组合 `helm-hub-launcher update --start`（launcher 不常驻），或 `helm-hub-launcher run` 前台常驻监督（见下）。
- **程序状态与用户数据严格分离**：release/state 全部在安装根目录（默认 `~/.helm-hub`，env `HELM_HUB_INSTALL_ROOT`）；Hub 自己的 `~/.helm`（`HELM_DATA_DIR`）与插件状态 launcher 从不写入，staging 与启动双向校验两者互不嵌套。
- **通用更新机制零复制**：registry 元数据、SHA512 校验下载、不可变 staging（`.complete` 标记与复用重校验）、更新锁、npm runner 全部来自共享 `@helm/update`（生产绑定在 `src/update-core.ts` 的 `defaultUpdateCore()`）；本包只保留 Hub 产品策略（pid 管理、就绪门控、回滚、launch 配置）。
- **`current.json`/`update-blocked.json` 归引擎所有**：launcher 不维护第二份引擎状态；`current.json` 为共享 entries 格式（`entries.entryPath` 指向已提交 payload 的 `start.mjs`），回滚按引擎记录逐字恢复。

## 安装根目录布局

```text
~/.helm-hub/
  releases/<ver>/<uuid>/   不可变候选（解包后的 payload 位于候选根：start.mjs/manifest.json/
                           package.json + node_modules/ 依赖闭包已装齐）
  current.json             已提交 release 指针（version/updatedAt/entries.entryPath，0600，@helm/update 所有）
  update-blocked.json      候选就绪失败后的冷却标记（默认 30 分钟，HELM_UPGRADE_BLOCK_COOLDOWN_MS 覆盖）
  hub.pid                  分离进程身份（pid/version/port/host/dataDir/startedAt/Linux startTime）
  launch.json              粘性启动配置（port/host/dataDir/model/webDistDir；仅显式值，无秘密）
  logs/hub.log             分离 Hub 进程 stdout/stderr（就绪扫描的数据源）
  lifecycle.lock           start/stop 与更新提交窗口的互斥（O_EXCL）
  upgrade.lock             跨进程更新互斥（@helm/update 引擎，O_EXCL）
```

## 命令

```bash
helm-hub-launcher check [--tag <tag>]            # 查询 registry dist-tag 最新版（无状态变更）
helm-hub-launcher update [--version <ver>] [--tag <tag>]
                                                 # staging → （运行中则优雅停止）→ 原子提交 current
                                                 #   → 启动候选 → 就绪门控；失败回滚旧版并写 blocked
helm-hub-launcher update --tarball <path> --version <ver>   # 本地 tgz 安装（同样解包 + npm 安装 + 自检）
helm-hub-launcher run [--interval-ms N] [--tag <tag>] [--port …]
                                                 # 前台常驻监督：首次安装并启动，之后按间隔检查
                                                 #   dist-tag；SIGINT/SIGTERM 优雅关闭本 launcher
                                                 #   自己启动的 Hub 后退出（见下节）
helm-hub-launcher start [--port|--host|--data-dir|--model|--web-dist-dir]
helm-hub-launcher stop                           # 身份核验（Linux startTime / health 探针）→ SIGTERM
                                                 #   → 超时升级进程树终止
helm-hub-launcher restart
helm-hub-launcher status                         # 安装/运行/blocked 概览（--json 机器可读）
```

`--json` 全局生效（`run` 除外——它输出人类可读的进度行，显式拒绝 `--json`）：成功输出 JSON 到 stdout，失败输出 `{ ok: false, error: { code, message } }` 到 stderr 并退出 1。

## `run`：受监督的前台生命周期

`helm-hub-launcher run` 是一个长期前台进程，面向 systemd/容器或交互终端：

- **启动**：未安装任何 release 时先按 dist-tag（`--tag`，默认 `latest`，env `HELM_HUB_UPDATE_TAG`）安装并启动；已安装则直接启动已提交版本。已有别的 Hub 在运行时显式拒绝（`run_refuses_existing_hub`）——本 launcher 只监督自己 spawn 的进程；
- **周期检查**：每 `--interval-ms`（默认 6 小时，env `HELM_HUB_UPDATE_INTERVAL_MS`）查询 dist-tag，有新版走与 `update` 完全相同的编排（staging → 停旧 → 提交 → 启动 → 就绪门控回滚）；检查失败或候选坏只记录错误并继续下一轮，**绝不退出、绝不静默降级**，旧 Hub 持续服务；
- **进程归属**：本 launcher 启动的每个 Hub 都以 `ChildProcess` 句柄持有（更新与回滚经 `HubLifecycleDriver` 复用同一受控启动流程），SIGINT/SIGTERM 通过句柄优雅关闭**它能证明归属的** Hub（SIGTERM → 超时升级进程树终止），pid 记录同步清理后以退出码 0 退出；第二次信号不再等待在途更新周期，直接强杀并退出（锁与原子写保证崩溃安全，Hub 可能存活）；
- **诚实边界**：信号到达时若更新周期在途，先等周期完成再关停（绝不与提交交错）；受监督 Hub 意外退出（崩溃或被他人停止）时 launcher 以退出码 1 结束并给出 `logs/hub.log` 指引，不与其余管理方争夺实例。

## 就绪契约

启动的候选以**自身 stdout 打印的精确 `Helm Hub: <url>` 行**为主判据（`@helm/hub` 仅在 HTTP 监听成功后打印该行），同时要求子进程存活；launcher 从 spawn 前的日志偏移起扫描 `logs/hub.log`，监听 URL 必须与启动配置的 host/port 一致，否则显式报错。`GET /api/auth/status` 仅作辅助确认与身份核验，绝不单独作为就绪依据（避免端口被其它进程占用时误判健康）。

## 更新流程与诚实性

1. 目标版本解析（`--version` 或 registry latest，严格 SemVer）；
2. blocked 冷却门（同版本默认 30 分钟，`--force` 或不同版本放行）；同版本 no-op；降级显式拒绝（`--force` 覆盖）；
3. staging：registry 下载（SHA512 SRI 校验，经 `@helm/update`）或本地 tarball（先复制进候选目录，两通道共用）→ **安全解包**到候选根（剥离 npm-pack `package/` 前缀；仅允许 `package/` 内常规文件/目录，拒绝链接/逃逸/部分解析告警/空归档；解包后复核磁盘上只有常规文件与目录——`src/tarball.ts`）→ 解包根内 `npm install --omit=dev --ignore-scripts`（payload 自带 `file:./<pkg>.tgz` 依赖闭包，只有解包后 npm 才能解析，直接 `npm install <outer.tgz>` 会 ENOENT）→ 校验包名/版本与 `start.mjs`/`manifest.json` 契约（含 `manifest.nodeEngines` 楼层对当前 Node 的校验）→ 执行 `node start.mjs check` 自检（绝不启动 Hub）；
4. 提交序列在 `lifecycle.lock` 单一原子段内：**先**优雅停止运行中的 Hub（身份无法核验则中止，状态零变更），**再**原子写 `current.json`，随后启动候选；
5. 候选就绪失败则恢复旧 `current.json`（引擎记录逐字还原）、重启旧版、写 `update-blocked.json`，并输出完整诊断链（含 `logs/hub.log` 尾部 40 行与退出码）；
6. 绝不在同一 dataDir 上并行运行两个 Hub（SQLite 互斥由「先停后启」保证；`start` 自带防双启）。

并发 `start` 恰逢更新提交窗口时被 `lifecycle.lock` 串行化；更新显式报 `update_race_with_start` 并保留已提交指针，不误判为候选失败。

## 跨平台边界

- 优雅关停是 POSIX 优先：Windows 上 `process.kill(pid, 'SIGTERM')` 无法触发处理器，`stop` 退化为短暂宽限后进程树升级终止（`taskkill /F /T`，与 `@helm/env-io` 的 `killProcessTree` 一致）。
- npm 调用（win32 `npm-cli.js` 解析、无 shell、超时进程组终止）由 `@helm/update` 的 `runNpm` 提供。
- 身份纪律（stop 的三道门）：
  1. **`run` 前台生命周期**持有所启动 Hub 的 `ChildProcess`，信号关停经句柄直达，天然无 pid 复用风险；
  2. 跨进程 `stop` 在 Linux 上核对 `hub.pid` 记录的 `/proc/<pid>/stat` startTime（pid 生命周期内不可变）：不匹配即 pid 复用，即使端口上仍有 hub 形响应也拒绝发信号；
  3. 无 startTime 证明（非 Linux 平台）时退回 health 探针：pid 存活但端点不可达即拒绝发信号，要求人工核验。

## 配置优先级

CLI flags > 环境变量（`HELM_PORT`/`HELM_HOST`/`HELM_DATA_DIR`/`HELM_MODEL`/`HELM_WEB_DIST_DIR`）> `launch.json` 粘性配置 > 默认（3202 / 127.0.0.1）。启动成功后把生效配置持久化进 `launch.json`，更新重启沿用。其它 env：`HELM_HUB_INSTALL_ROOT`、`HELM_NPM_REGISTRY`、`HELM_PAYLOAD_PACKAGE`（默认 `@team4u/helm-hub`）、`HELM_UPGRADE_BLOCK_COOLDOWN_MS`。

## 测试

`test/records.test.ts`（状态记录/startTime 解析/配置解析/隔离护栏/dist-tag 与间隔 env）、`test/lifecycle.test.ts`（真实分离进程的启停/身份（含 Linux startTime 篡改拒杀）/升级终止/就绪判据/陈旧横幅/错误端口横幅/锁互斥）、`test/update-flow.test.ts`（staging/提交/就绪回滚/blocked/锁/缓存复用/nodeEngines/嵌套护栏 + 真实 `npm pack` 黄金路径）、`test/tarball.test.ts`（解包安全策略：手造 ustar 恶意归档的链接/逃逸/绝对路径/异根/反斜杠/空归档拒绝 + 嵌套 `file:./dep.tgz` 依赖的双通道真实 npm 黄金安装）、`test/run.test.ts`（监督生命周期：初次安装、周期换版、检查失败存活、坏候选回滚、拒收外来 Hub、意外死亡退出码 1，及真实 CLI 进程 + 本地 HTTP registry + SIGINT 的端到端）、`test/cli.test.ts`（解析纪律、真实引擎绑定与端到端命令）。policy 测试注入 fake core（`test/fixtures.ts`：registry/npm 桩 + 真实引擎 staging + 真实 `package/` 归档下载，语义零漂移）。
