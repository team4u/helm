# Herdr 终端协同插件

`builtin:herdr` 把 Helm 的子代理派生能力延伸到终端 CLI Agent 世界：拦截 `agent_spawn` 请求，把 `herdr:<kind>` 形式的任务改道到本机或远端节点的 Herdr 终端窗格执行，执行「终端跑过程、文件交结果」，并以带 CAS 乐观锁的审批桥打通 Web 端与终端的 blocked 交互。适合需要让 claude / codex / pi 等终端 CLI 参与编排的使用者。上层编排（`builtin:workflow` 的 `subagent` / `SubagentWorkflow`）对此透明——`agentType` 写 `herdr:agy` 即可。

## 当前状态

默认停用，显式 `helm plugins enable builtin:herdr` 启用。连接纪律是**一次启用一个冻结连接配置**：启用时解析 `config.session` / `socketPath` 为冻结 `HerdrTarget`，本启用周期内所有命令、事件、文件与清理（含远端 pane）统一走同一目标；不热换连接（防误关另一台服务器同 ID 人类窗格），配置变更在下次启用生效。`service.start` 才真正连接（subscribe ack 先于 snapshot 对账），半途失败自行清理已获取资源。

## 能力和入口

### `agent_spawn` 拦截与执行行

插件以 priority 100 注册 `agent_spawn` 钩子。任务来源双入口：

- **显式前缀**：`agentType` 为 `herdr:<kind>` 或 `herdr:<kind>@<nodeId>`（含 `@local` 显式本机）。kind 不做枚举硬编码、交由 Herdr 校验（实测全集 23 种：pi、claude、codex、gemini、cursor、devin、agy、cline、omp、mastracode、opencode、copilot、kimi、kiro、droid、amp、grok、hermes、kilo、qodercli、qwen、maki、muse；`profileRuntime.agentSuggestions` 候选同源）；
- **Profile 绑定**：`agentType` 为已存在 Profile ID 且 `profile.runtime.kind === 'herdr'`（`runtime.agent` 指定 kind，可附 `runtime.nodeId` / `runtime.workspace` / `runtime.args` / `runtime.env`）。

非上述两种返回 `continue` 交还内核原生执行行。节点选定优先级链：显式 `@nodeId` > `runtime.nodeId` > Profile 顶层 `nodeId` > 父会话绑定节点 > 本机。CLI 私有参数仅来自 `runtime.args` 原样透传，非法输入显式抛错，绝不猜测私有 flag。

完整执行行为是八段序列：**建窗（普通 `tab.create` 或 worktree 模式 `worktree.create` + 补建带 env 的 tab 两步）、`agent.start`、权威就绪等待、`agent.prompt --wait`、blocked 审批桥、文件交接（含一次自愈）、gate 恰好一次、双轨保活清理**。启动序列遵守真实服务端语义：`agent.start` 可能返回 `unknown + launch_pending`，必须 `agent.wait` 权威就绪后再投递，不把 unknown 当终态失败、不提前 prompt。

- **文件交接**：结果写入窗格实际 cwd 下 `.helm/<outputFileName>`；读取后按 JSON Schema 或 md 稳定性校验，失败仅自愈一次（同形追问），再失败显式 `herdr_output_contract_violation` 并附 `agent.read recent_unwrapped` 40 行脱敏快照，绝不截终端脏文本冒充结果。
- **窗格环境最小授权**：缺省不携带任何父会话 SecretStash 机密；需要时由 spawn 请求显式 `secretNames` 逐名授予（需在父会话 stash 现存，缺失显式报错），按次授予、resume 不自动沿用。
- **Gate 恰好一次**：文件成功后若有 `gate` 命令，在窗格实际节点与实际 cwd、以建窗同一 env 执行恰好一次（本机 `runLocalGate`，远端经节点通道）。Herdr 路径不支持 `gateTimeoutMs`（`unsupported_runtime` 拒绝），原生执行行不受影响。
- **超时安全边界**：无安全 stop/CAS 手段停止底层 CLI——超时只保存诊断并保留 pane（标 failed，不关窗、不发键）；resume 在任何 prompt 发送前经权威 `agent.get` 复核，仅 `idle` / `done` 放行。
- **归属校验与孤儿回收**：自有资源操作前做精确 `agent.name === 登记值` 验证（不 startsWith）；启动对账按窗格状态分流——working / blocked / unknown、携带持久 `outputFileName` 待 `reattach` 验收的 `running` 窗格与归属活跃 workflow 的 `keepalive` 窗格均保留（绝不误杀或伪装结束），failed 保留现场，无在途重挂与 workflow 归属的已结束孤儿安全回收；`runtime.started` 后按 workflow 终态二次兜底收敛。
- **跨 Hub 重启窗格保活与 `reattach` 对账**：`ManagedDoc.panes[i]` 持久化最新 `outputFileName`（含 `steer` 重定向后的文件名；恢复时按 `OUTPUT_FILE_PATTERN` 严格校验，非法值显式抛 `herdr_managed_invalid`；结算/清理后置空）。Hub 进程优雅关停（`ctx.host.isClosing === true`）仅断开本进程 Socket 订阅、停止心跳定时器并取消进程内 pending Ask 协调句柄，不对 `running`（及仍归 workflow 管辖的 `keepalive`）窗格调 `closePane`；重启后 `service.prepare()` 先行就位本地登记与执行器，`executor.handle` 接管归属 Herdr 的 `request.reattach.executionId`（与 `resume` / `fork` 互斥，缺失记录或缺失 `outputFileName` 显式抛 `herdr_reattach_missing`）：先 `onResolved` 回传坐标，再**优先检查 `.helm/<outputFileName>`**（已就绪即过 Schema 与 `gate` 结算）；文件未生成时调 `agent.get`——`working` / `blocked` / `launch_pending` 重新挂载阶段跟踪、事件等待与 CAS 审批桥（冲突 ID 自动推进 `:r<N>`），`idle` / `done` 走既有单次原地追问自愈，窗格已丢失（404）或自愈后仍无效则附尾部 40 行脱敏快照显式抛 `herdr_pane_lost` / `herdr_output_contract_violation` 并将窗格标 `failed`，绝不截取终端屏幕脏文本冒充成功结果。

### 带 CAS 乐观锁的审批桥

终端 Agent blocked 时桥接为 Web 端 AskDoc：权威 `agent.get` 现查真实 `stateChangeSeq` 创建 Ask（预分配 ID `herdr:<nodeId>:<pane>:<seq>`），快照尾部提取菜单结构生成选项与按键映射。双向防冲突：**人类先在 Web 审批**——提交时现查权威 seq，一致才以带 `expected_state_seq` 的 `agent.send_keys`（要求服务端 `ping` 通告 `capabilities.send_keys_expected_state_seq`；水位不匹配返回 `stale_state` 且零按键写入）一次性发送；**人类先在终端按键**——终端 seq 推进后 AskDoc 自动流转 `superseded` 销单，绝不重复发键。发键后仍停留同 seq 时退避防抖，连续无进展即重开审批，不无限死锁。

### `$helm` 状态 Token 投射

经 `pane.report_metadata` 向终端侧栏投射 `$helm` 状态 Token（如 `run:helm-wf-abc`、`ask:herdr:local:p1:3`）。去重签名用业务 token 字符串（绝不用被 metadata 推进的 pane revision，防自激环），仅 token 变化或 TTL 心跳到期（默认 30s 的一半刷新）时投射。

### 动作、连接与 UI

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `list` | `helm herdr list` | 列出本插件管理的窗格（nodeId / pane / 状态 / 归属 / 父会话 / workflowRunId） |
| `read` | `helm herdr read <paneId>` | 终端尾部 40 行脱敏快照；跨节点同 ID 用 `--node-id` 消歧（歧义 409） |
| `focus` | `helm herdr focus <paneId>` | 在 Herdr 终端聚焦窗格（用户显式操作；同样支持 nodeId 消歧） |
| `steer` | `helm herdr steer` | 向受管且由 workflow run 派生的窗格插话（`--execution-id` / `--node-id` / `--workflow-run-id` / `--parent-conversation-id` / `--text`）；使用现有 `agent.prompt`，`guardLevel=preflight` 表示发送前预检。通常用 `helm workflows steer <runId> --text` 自动路由，勿手动拼坐标 |

连接架构：本机走 Herdr 行协议 IPC（Linux/macOS Unix Domain Socket，Windows Named Pipe；端点优先级 `socketPath` 配置 > `HERDR_SOCKET_PATH` > 会话目录）；远端节点复用内核 EnvFabric 通道（`ctx.host.nodeIpc`，单行 JSON 经节点通道直达目标节点上的 Herdr IPC，端点由目标节点自行解析），不为 Herdr 单独搭建 SSH 通道。

UI 贡献：左栏「Herdr 终端」入口 + `overview` 全屏总览（窗格与审批状态）、`profileRuntime`（`kind: 'herdr'` 外部运行时候选与 agent 建议）。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `session` | string | 空 | Herdr 会话名（本机 `herdr sessions/<name>` 子目录） |
| `socketPath` | string | 空 | Socket 路径覆盖（缺省 `HERDR_SOCKET_PATH` 或默认会话路径） |
| `startupTimeoutMs` | number | 30000 | agent 启动超时（3001..300000 毫秒） |

持久文档：公开 `overview`（版本化投影：panes + asks + stale 标记）与私有 `managed`（窗格登记，含持久 `outputFileName`）。启动对账只回收确认自有的无主资源。

## 停用与失败语义

停用（`ctx.host.isClosing === false`）时清理订阅、定时器、全部 pending Ask 与全部非 `failed`/`settled` 自有 pane（`failed` 保留现场供排错）；停用后不再触达任何服务器。宿主整体关停（`ctx.host.isClosing === true`）走保活断连路径，保留 `running` 窗格在 Herdr 守护进程中继续运行。在途窗格执行占用会在停用预检中体现（`plugin_has_live_tasks`）。`turn_settled` 与 `workflow.settled` 双轨保活清理：workflow 轨道按 run 结算清理其窗格，单回合轨道按父回合结算清理；清理失败如实通知跳过，不伪装结束。传输 IO / SSH / 权限错误如实抛诊断（`herdr_output_missing` 404 是唯一可自愈边界码），绝不把其它错误当缺文件重投任务。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/herdr.ts` |
| 执行行 / 交接 / 续接 / 重挂 / 插话 | `packages/plugins/src/herdr/executor*.ts` |
| 审批桥 / 状态投射 / 窗格登记 | `packages/plugins/src/herdr/approval-bridge.ts`、`metadata.ts`、`panes.ts`、`asks.ts` |
| spawn 规则与 RPC | `packages/plugins/src/herdr/spawn-rules.ts`、`rpc.ts`、`transport*.ts` |
| 测试 | `packages/plugins/test/herdr*.test.ts`（执行行、CAS 发键、交接、steer、节点路由、Windows 管道等，含 `herdr-server-fixture.ts` / `herdr-node-fixture.ts` 真实服务器夹具） |

## 相关文档

- [工作流与子代理编排](workflow.md)：外部执行体如何被 `subagent` / steer 消费
- [EnvFabric 分布式执行底座](../architecture/envfabric.md)：`nodeIpc` 节点通道机制
- [pi-durable 持久会话](../architecture/pi-durable.md)：AskDoc CAS 乐观锁与归属权红线
