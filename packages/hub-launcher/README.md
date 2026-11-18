# @helm/hub-launcher

稳定的本机 Hub launcher/updater：管理 Hub npm payload（`@team4u/helm-hub`）的检查、安装、启动、停止、就绪门控更新与失败回滚，以及前台定时自动更新（`run`）。每个成员本机一个独立 Hub；launcher 是外部稳定安装，绝不被它管理的 release 覆盖。

## 产品边界

- **只做本地单实例**：无云端 Hub、无分享、无多租户。定时自动更新由前台 `run` 入口承担（外部稳定 supervisor，禁止 Hub 用内部 cron 重启自己）；也可用系统 cron 组合 `helm-hub-launcher update --start`。
- **程序状态与用户数据严格分离**：release/state 全部在安装根目录（默认 `~/.helm-hub`，env `HELM_HUB_INSTALL_ROOT`）；Hub 自己的 `~/.helm`（`HELM_DATA_DIR`）与插件状态 launcher 从不写入，staging 与启动双向校验两者互不嵌套。
- **通用更新机制零复制**：registry 元数据、SHA512 校验下载、不可变 staging（`.complete` 标记与复用重校验）、更新锁、npm runner 全部来自共享 `@helm/update`（生产绑定在 `src/update-core.ts` 的 `defaultUpdateCore()`）；本包只保留 Hub 产品策略（pid 管理、就绪门控、回滚、launch 配置）。
- **`current.json`/`update-blocked.json` 归引擎所有**：launcher 不维护第二份引擎状态；`current.json` 为共享 entries 格式（`entries.entryPath` 指向已提交 payload 的 `start.mjs`），回滚按引擎记录逐字恢复。

## 安装根目录布局

```text
~/.helm-hub/
  releases/<ver>/<uuid>/   不可变候选（npm 布局 node_modules/<pkg>/start.mjs + 依赖已装齐）
  current.json             已提交 release 指针（version/updatedAt/entries.entryPath，0600，@helm/update 所有）
  update-blocked.json      候选就绪失败后的冷却标记（默认 30 分钟，HELM_UPGRADE_BLOCK_COOLDOWN_MS 覆盖）
  hub.pid                  分离进程身份（pid/version/port/host/dataDir/startedAt）
  launch.json              粘性启动配置（port/host/dataDir/model/webDistDir；仅显式值，无秘密）
  logs/hub.log             分离 Hub 进程 stdout/stderr（就绪扫描的数据源）
  lifecycle.lock           start/stop 与更新提交窗口的互斥（O_EXCL）
  upgrade.lock             跨进程更新互斥（@helm/update 引擎，O_EXCL）
```

## 命令

```bash
helm-hub-launcher check                          # 查询 registry 最新版（无状态变更）
helm-hub-launcher update [--version <ver>]       # staging → （运行中则优雅停止）→ 原子提交 current
                                                 #   → 启动候选 → 就绪门控；失败回滚旧版并写 blocked
helm-hub-launcher update --tarball <path> --version <ver>   # 本地 tgz 安装（同样 npm 安装 + 自检）
helm-hub-launcher start [--port|--host|--data-dir|--model|--web-dist-dir]
helm-hub-launcher stop                           # 身份核验（health 探针）→ SIGTERM → 超时升级进程树终止
helm-hub-launcher restart
helm-hub-launcher status                         # 安装/运行/blocked 概览（--json 机器可读）
```

`--json` 全局生效：成功输出 JSON 到 stdout，失败输出 `{ ok: false, error: { code, message } }` 到 stderr 并退出 1。

## 定时自动更新（`run`）

```bash
helm-hub-launcher run [--interval <seconds>] [--tag <dist-tag>] [启动旗标]
```

前台 supervisor 循环：**单一进程控制模型**（与 start/stop/update 同一套 detached spawn + 横幅就绪 + `lifecycle.lock` + pid 身份核验，无第二套控制路径）：

1. 引导：无已装 release 则先安装；确保恰有一个 Hub 在运行（缺失/已死则启动，已在运行则收养）；
2. 每周期（首查立即执行，之后每 `--interval` 秒，默认 `HELM_HUB_UPDATE_INTERVAL` 或 3600）：按 dist-tag（`--tag`，默认 `HELM_PAYLOAD_DIST_TAG` 或 `latest`，如 `beta`）查询 registry，有新版本则执行完整就绪门控更新（优雅停 → 原子提交 → 横幅门控启动，失败回滚）；
3. 失败韧性：registry 不可达 / staging 失败 / 候选被拒都不退出循环、不打扰运行中的 Hub——失败版本进入 blocked 冷却，下一轮重试；
4. 优雅重启语义：更新中的停机是优雅 SIGTERM——进行中的回合至多被打断一次，内核账本在新 release 上恢复；stop→start 窗口是诚实的短暂停机，不是零停机金丝雀；
5. 退出（Ctrl-C / SIGTERM）：优雅停止本循环持有的 Hub（与 `stop` 相同的身份核验 + 升级终止），launcher 退出。

`--json` 输出 JSONL 事件流（installed/already-running/started/no-update/updated/check-failed/update-failed/stopping/stopped 等）+ 结束摘要。

## 就绪契约

启动的候选以**自身 stdout 打印的精确 `Helm Hub: <url>` 行**为主判据（`@helm/hub` 仅在 HTTP 监听成功后打印该行），同时要求子进程存活；launcher 从 spawn 前的日志偏移起扫描 `logs/hub.log`，监听 URL 必须与启动配置的 host/port 一致，否则显式报错。`GET /api/auth/status` 仅作辅助确认与身份核验，绝不单独作为就绪依据（避免端口被其它进程占用时误判健康）。

## 更新流程与诚实性

1. 目标版本解析（`--version` 或 registry latest，严格 SemVer）；
2. blocked 冷却门（同版本默认 30 分钟，`--force` 或不同版本放行）；同版本 no-op；降级显式拒绝（`--force` 覆盖）；
3. staging：registry 下载（引擎 `downloadVerifiedTarball`：精确版本 manifest + SHA512 SRI 校验）或本地 tarball → **先解包**到候选根（`tar` 依赖，只接受 `package/` 前缀内的常规文件/目录，拒绝链接与路径逃逸；npm 只有在解包后才能解析 payload 内嵌的 `file:./<pkg>.tgz` 依赖闭包）→ 候选目录内 `npm install <解包目录> --omit=dev --ignore-scripts` → 校验包名/版本与 `start.mjs`/`manifest.json` 契约（含 `manifest.nodeEngines` 楼层对当前 Node 的校验）→ 执行 `node start.mjs check` 自检（绝不启动 Hub）；
3b. 缓存复用重校验：引擎 `.complete` 缓存命中只做结构性检查（入口文件存在），launcher 对复用候选重跑完整契约校验 + payload 自检，失败则丢弃缓存强制重建（旧候选按引擎不可变契约保留）；
4. 提交序列在 `lifecycle.lock` 单一原子段内：**先**优雅停止运行中的 Hub（身份无法核验则中止，状态零变更），**再**原子写 `current.json`，随后启动候选；
5. 候选就绪失败则恢复旧 `current.json`（引擎记录逐字还原）、重启旧版、写 `update-blocked.json`，并输出完整诊断链（含 `logs/hub.log` 尾部 40 行与退出码）；
6. 绝不在同一 dataDir 上并行运行两个 Hub（SQLite 互斥由「先停后启」保证；`start` 自带防双启）。

并发 `start` 恰逢更新提交窗口时被 `lifecycle.lock` 串行化；更新显式报 `update_race_with_start` 并保留已提交指针，不误判为候选失败。

## 跨平台边界

- 优雅关停是 POSIX 优先：Windows 上 `process.kill(pid, 'SIGTERM')` 无法触发处理器，`stop` 退化为短暂宽限后进程树升级终止（`taskkill /F /T`，与 `@helm/env-io` 的 `killProcessTree` 一致）。
- npm 调用（win32 `npm-cli.js` 解析、无 shell、超时进程组终止）由 `@helm/update` 的 `runNpm` 提供。
- 身份纪律：pid 存活但 health 端点不可达时拒绝发送任何信号（可能是 pid 复用），要求人工核验。进程外 PID 管理的最小化（前台常驻 launcher 持有 ChildProcess、或经确认实例的本机 IPC 控制）是后续与发布/分发联动的演进方向。

## 配置优先级

CLI flags > 环境变量（`HELM_PORT`/`HELM_HOST`/`HELM_DATA_DIR`/`HELM_MODEL`/`HELM_WEB_DIST_DIR`）> `launch.json` 粘性配置 > 默认（3202 / 127.0.0.1）。启动成功后把生效配置持久化进 `launch.json`，更新重启沿用。其它 env：`HELM_HUB_INSTALL_ROOT`、`HELM_NPM_REGISTRY`、`HELM_PAYLOAD_PACKAGE`（默认 `@team4u/helm-hub`）、`HELM_PAYLOAD_DIST_TAG`（默认 latest）、`HELM_HUB_UPDATE_INTERVAL`（秒，默认 3600）、`HELM_UPGRADE_BLOCK_COOLDOWN_MS`。

## 测试

`test/records.test.ts`（状态记录/配置解析/隔离护栏）、`test/lifecycle.test.ts`（真实分离进程的启停/身份/升级终止/就绪判据/陈旧横幅/错误端口横幅/锁互斥）、`test/update-flow.test.ts`（staging/提交/就绪回滚/blocked/锁/缓存复用与篡改重校验/nodeEngines/嵌套护栏/dist-tag + 真实 `npm pack` 黄金路径：生产 extractor 全链路（假 registry 元数据 + 真实 SHA512 校验 + 真实解包 + 真实 npm install + 真实自检 + 真实启动），含内嵌 `file:./dep.tgz` 依赖的 #88 形态）、`test/run-loop.test.ts`（定时自动更新：引导/收养/跨版本升级真实进程替换/registry 故障韧性/优雅关停）、`test/cli.test.ts`（解析纪律、真实引擎绑定与端到端命令）。policy 测试注入 fake core（`test/fixtures.ts`：registry/npm 桩 + 真实引擎 staging，语义零漂移）。
