# @helm/desktop — helm Electron 桌面壳（最小骨架）

全平台 Electron 桌面壳：**不直接 import kernel/web**（五包边界不动），Hub 一律以子进程
attach-or-spawn，BrowserWindow 只加载 `http://127.0.0.1:<port>`。核心监督器为纯 Node
模块，无显示环境可完整测试与运行（headless 模式）。

## 结构

```
src/
  config.ts        配置解析（env HELM_DESKTOP_* + 显式覆盖；端口铁律校验）
  runners.ts       Hub 子进程运行器选择 + 运行期能力探测（Node >= 24.12.0 且 node:sqlite）
  supervisor.ts    attach-or-spawn 监督器（纯 Node；崩溃退避重启、优雅/强制停止、诚实诊断）
  updater.ts       payload updater 契约 + 占位实现（见文末 TODO）
  electron-api.ts  Electron API 结构化类型 + 惰性 require（仓库无 electron 依赖也过 typecheck）
  main.ts          主进程：单实例锁 / BrowserWindow(hidden→show) / 托盘 / 关闭隐藏 / headless
  smoke.ts         端到端 smoke（真实 kernel dist Hub；崩溃自愈 + 优雅停止）
test/              纯 Node 测试（mini-hub 夹具，零 GUI 依赖，integration 档）
```

## 配置（环境变量，均 `HELM_DESKTOP_` 前缀）

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `HELM_DESKTOP_PORT` | `3202` | Hub 端口（铁律：禁 3000/3001/3002/3101/3102） |
| `HELM_DESKTOP_DATA_DIR` | Hub 缺省 `~/.helm` | 透传子进程 `HELM_DATA_DIR` |
| `HELM_DESKTOP_WEB_DIST` | Hub 缺省探测 | 透传子进程 `HELM_WEB_DIST_DIR` |
| `HELM_DESKTOP_PAYLOAD_ENTRY` | 无 | npm Hub payload 的 hub 入口 JS；设置后优先于仓库 kernel dist |
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

## Payload updater（TODO，未实现下载器）

骨架只提供契约（`src/updater.ts`）：`check()` / `downloadAndInstall(latest)`，当前为
`StubPayloadUpdater`（check 如实返回 `updater_not_configured`，install 显式
`updater_not_implemented`）。未来实现必须遵守：

1. **制品边界**：updater 只管理 payload 制品（下载 → `<dataDir>/payload-staging` → 原子
   换名），失败不得破坏当前可运行 payload；
2. **生命周期协调**：换装只允许在 `supervisor.stop()` 之后（桌面壳独占 Hub 生命周期），
   避免与 payload 内部 agent 的会话写盘冲突；换装后由桌面壳重启 Hub；
3. **诚实性**：下载必须校验完整性与来源签名（方案待定）；任何失败显式报错，禁止静默
   回退旧版却宣称成功；
4. **不越权**：updater 不感知会话、不重启用户会话、不调用 Hub 业务 API；
5. **与 payload agent 的分工**：payload 内 agent（未来 npm payload 可自带）负责自身业务
   自更新时，必须与桌面壳 updater 二选一（`HELM_DESKTOP_PAYLOAD_ENTRY` 指向的制品由谁
   管理需在 payload manifest 声明），避免双更新器竞争。
