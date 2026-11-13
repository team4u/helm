# @helm/desktop — helm Electron 桌面壳（最小骨架）

全平台 Electron 桌面壳：**不直接 import kernel/web**（五包边界不动），Hub 一律以子进程
attach-or-spawn，BrowserWindow 只加载 `http://127.0.0.1:<port>`。核心监督器为纯 Node
模块，无显示环境可完整测试与运行（headless 模式）。

## 结构

```
src/
  config.ts        配置解析（env HELM_DESKTOP_* / HELM_PAYLOAD_* + 显式覆盖；端口铁律校验）
  runners.ts       Hub 子进程运行器选择 + 运行期能力探测（Node >= 24.12.0 且 node:sqlite）
  supervisor.ts    attach-or-spawn 监督器（纯 Node；崩溃退避重启、优雅/强制停止、诚实诊断）
  updater.ts       npm payload 更新器（check / downloadAndInstall / resolveCurrent）
  payload-tar.ts   最小安全 tar.gz 解包器（containment 强校验、类型白名单、上限防护）
  payload-lock.ts  跨进程安装锁（O_EXCL + pid 存活/超时接管，进程内串行化）
  payload-json.ts  原子 JSON 状态文件（tmp+fsync+rename；损坏显式报错）
  npm-installer.ts payload 依赖安装器（可注入 NpmInstaller + 宿主 npm 生产实现）
  electron-api.ts  Electron API 结构化类型 + 惰性 require（仓库无 electron 依赖也过 typecheck）
  main.ts          主进程：单实例锁 / BrowserWindow(hidden→show) / 托盘 / 关闭隐藏 / headless / 已安装 payload 入口选择
  smoke.ts         端到端 smoke（真实 kernel dist Hub；崩溃自愈 + 优雅停止）
test/              纯 Node 测试（mini-hub 与假 registry 夹具，零 GUI 依赖，integration 档）
```

## 配置（环境变量，均 `HELM_DESKTOP_` 前缀）

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `HELM_DESKTOP_PORT` | `3202` | Hub 端口（铁律：禁 3000/3001/3002/3101/3102） |
| `HELM_DESKTOP_DATA_DIR` | Hub 缺省 `~/.helm` | 透传子进程 `HELM_DATA_DIR` |
| `HELM_DESKTOP_WEB_DIST` | Hub 缺省探测 | 透传子进程 `HELM_WEB_DIST_DIR` |
| `HELM_DESKTOP_PAYLOAD_ENTRY` | 无 | npm Hub payload 的 hub 入口 JS；设置后优先于仓库 kernel dist（见下文 updater 契约：应指向 kernel 入口而非 start.mjs） |
| `HELM_DESKTOP_PAYLOAD_ENTRY_ARGS` | 无 | payload 入口附加参数（空格拆分；仅 PAYLOAD_ENTRY 配置后可用，如 `start`） |
| `HELM_PAYLOAD_PACKAGE` | 无 | npm payload 包名（updater 启用条件；不硬编码任何 @helm 名称） |
| `HELM_PAYLOAD_REGISTRY` | `https://registry.npmjs.org` | npm registry base URL（http(s)） |
| `HELM_PAYLOAD_VERSION` | `latest` | 锁定精确版本；缺省跟踪 dist-tags.latest |
| `HELM_DESKTOP_HUB_ENTRY` | `<repo>/packages/kernel/dist/main.js` | 仓库内核入口覆写 |
| `HELM_DESKTOP_HUB_CMD` | 无 | 完整命令覆写（空格拆分，最高优先，不做能力探测） |
| `HELM_DESKTOP_HUB_NODE` | 自动选择 | 指定运行 Hub 的 node 可执行文件 |
| `HELM_DESKTOP_HEADLESS` | 无 | `1` = 纯监督器模式（无窗口，CI/无显示验证） |

## 运行

```bash
pnpm build                                # 先构建（kernel/web dist 为 Hub 子进程与窗口内容）
pnpm --filter @helm/desktop test          # 纯 Node 测试（无需 electron / 显示）
pnpm --filter @helm/desktop run smoke     # 真实 kernel dist 端到端 smoke

# GUI（需要 electron，当前未列为 devDependency，避免全仓 install 强制下载二进制）：
pnpm --filter @helm/desktop add -D electron   # 一次性：本地安装 electron 到桌面包（合入 pnpm-workspace allowBuilds 需同步审阅）
npx electron packages/desktop                 # 加载 dist/main.js（先 pnpm --filter @helm/desktop build）

# 无显示环境（CI / 服务器）：
HELM_DESKTOP_HEADLESS=1 HELM_DESKTOP_PORT=3399 pnpm --filter @helm/desktop run start
```

## Hub 子进程运行器与兼容性实测

选择顺序：`HELM_DESKTOP_HUB_CMD` > `HELM_DESKTOP_HUB_NODE` > Electron 内嵌 Node
（`ELECTRON_RUN_AS_NODE=1`）> 宿主 Node。除 custom 命令外全部经**运行期探测**
（Node >= `24.12.0` 且 `node:sqlite` 可用），不满足则如实记录并回退/报错。

实测结论（Electron 45.3.1，内嵌 Node 24.22.2，2025-04）：

- `ELECTRON_RUN_AS_NODE=1` 下 `node:sqlite` 可用、native esbuild 可用；
- kernel `dist/main.js` 完整启动（真实数据目录、HTTP 探测、SIGTERM 优雅退出）；
- `utilityProcess` 需完整 Electron app 上下文，无显示环境无法独立验证，骨架统一使用
  `child_process.spawn`（已验证路径）；utilityProcess 留作后续进程隔离增强，接口不变。

已知缺口：kernel 构建曾不复制 `src/builtin-plugins/*/client` 资产，导致 dist 单独启动抛
`<plugin>_client_missing`；已由 `packages/kernel/scripts/copy-plugin-clients.mjs`（build 内
联步骤）修复。

## Payload updater（npm 制品更新器）

`src/updater.ts` 提供真实实现（`createPayloadUpdater`）：`check()` / `downloadAndInstall({name, version})` /
`resolveCurrent()`。未配置 `HELM_PAYLOAD_PACKAGE` 时诚实返回 `updater_not_configured`，安装显式拒绝。

安装流程（对齐 `packages/payload/README.md` 的真实路线，不宣称解决 npm 自包含）：

1. 从 registry 读取包元数据（dist-tags.latest 或锁定版本），边界校验 name / version /
   `dist.integrity`（必须 sha512）与 tarball URL；
2. 下载 tgz 到 `<dataDir>/payload/staging` 临时区，流式落盘时校验 sha512；
3. 解包（`payload-tar.ts`：拒绝绝对路径 / `..` 穿越 / 非 `package/` 前缀 / 危险类型，
   条目数与字节上限防护）到 staging/extract，读取 manifest 契约（formatVersion=1、
   entries.kernel 必须存在且不得指向 launcher）；
4. 运行 `start.mjs check` 验收：exit 3（依赖缺失）时经可注入 `NpmInstaller`
   （默认 `HostNpmInstaller`：子进程执行宿主 `npm install --omit=dev`，超时与 stderr 尾部
   诊断，npm 不可执行显式报错不静默跳过）安装后复检；exit 1（布局/checksum 损坏）
   与其余失败显式报错；
5. 验收通过后原子换名为 `<dataDir>/payload/releases/<name>/<version>/` 不可变目录，
   原子写 `current.json`；制品缺陷类失败（integrity/manifest/check/tar 结构）记入
   `blocked.json` 阻断该版本，任何失败均不破坏当前可运行 payload；
6. 并发安装由 `<payload>/.lock` 文件锁串行（死 pid / 超时持有自动接管）。

磁盘布局：`<dataDir>/payload/{staging,releases/<name>/<version>,current.json,blocked.json,.lock}`。

### 启动参数契约与生命周期

- payload 的 `start.mjs` 是**带命令参数的启动器**（`check` / `start`），不是 Hub 入口。
  updater 返回的 `entryPath` 恒为 `manifest.entries.kernel`（kernel 入口，直接 spawn，
  `entryArgs` 恒空）；manifest 校验显式拒绝 `entries.kernel` 指向 launcher。手动配置
  `HELM_DESKTOP_PAYLOAD_ENTRY` 指向 start.mjs 时，必须同时设置
  `HELM_DESKTOP_PAYLOAD_ENTRY_ARGS=start`（runners 会拼接入命令行）。
- 生命周期分工：updater 只管制品，不重启 Hub。换装只发生在 `supervisor.stop()` 之后、
  下一次 `start()` 采用新入口：`main.ts` 启动时经 `resolveCurrent()` 选择已安装 payload
  （`current.json` 损坏时如实记录并回退仓库 kernel dist，payload 是可选叠加层）；
  updater 不感知会话、不重启用户会话、不调用 Hub 业务 API。

### 未解决（勿宣称）

- **npm 自包含未解决**：tarball 不含 node_modules，依赖靠 NpmInstaller 在安装期落盘；
  esbuild 等平台原生依赖按宿主平台解析，vendored / 单文件 bundle 路线见
  `packages/payload/README.md`；
- **Electron 未捆绑 npm CLI**：宿主 npm 缺失时安装显式失败（`npm_installer_unavailable`）；
  Electron 打包版需自带 npm-cli.js 并经 `HostNpmInstaller({ command: ['node', npmCliJs] })`
  注入，未验证；
- **发布侧未物化**：`@helm/protocol` 等仍是 `workspace:*` 链接，payload 尚不可真实发布
  到公开 registry（见 payload README 的阻塞清单）。
