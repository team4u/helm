# Herdr 终端协同主控插件

`builtin:herdr` 把 Helm 的子代理派生能力延伸到终端 CLI Agent 世界（可选启用）：拦截 `agent_spawn` 请求，把 `herdr:<kind>` 形式的任务改道到本机或远端节点的 Herdr 终端窗格执行，执行「终端跑过程、文件交结果」，并以带 CAS 乐观锁的审批桥打通 Web 端与终端的 blocked 交互。上层编排（`builtin:workflow` 的 `subagent` / `SubagentWorkflow`）对此完全透明——`agentType` 写 `herdr:agy` 即可。

## 连接架构与冻结目标

本机连接走 Herdr 官方行协议 IPC：Linux/macOS 直连 Unix Domain Socket，Windows 按 interprocess 实际规则把 marker 文件路径换算为 Named Pipe 名。端点解析优先级为显式 `socketPath` 配件 > `HERDR_SOCKET_PATH` 环境变量 > 会话目录（`config.session` 或默认 `~/.config/herdr/herdr.sock`）。远端节点复用内核 `EnvFabric` 通道（`ctx.host.nodeIpc`）：单行 JSON 经节点通道直达目标节点上运行的本机 Herdr IPC，端点路径由目标节点自行解析，本机解析规则绝不下发；架构内不为 Herdr 单独搭建 SSH 通道。

**冻结连接纪律**：启用时解析 `config.session` / `socketPath` 为冻结的 `HerdrTarget`，本启用周期内所有命令、事件、文件与清理（含远端 pane）统一走同一目标；不热换连接——防止误关另一台服务器上同 ID 的人类窗格。配置变更在下次启用生效。事件订阅断线时指数退避自愈重连（封顶 60s），成功后重建订阅并复位退避。

三个配置项经 `ctx.configSchema` 声明：`session`（会话名）、`socketPath`（显式路径覆盖）、`startupTimeoutMs`（agent 启动超时，3001..300000，默认 30000）。

## `agent_spawn` 拦截与执行行

插件以 priority 100 注册 `agent_spawn` 钩子。任务来源双入口：

- **显式前缀**：`agentType` 为 `herdr:<kind>` 或 `herdr:<kind>@<nodeId>`（含 `@local` 显式本机）。kind 为 Herdr 支持的 CLI Agent 标识，不做枚举硬编码、交由 Herdr 校验（实测全集 23 种：pi、claude、codex、gemini、cursor、devin、agy、cline、omp、mastracode、opencode、copilot、kimi、kiro、droid、amp、grok、hermes、kilo、qodercli、qwen、maki、muse）；
- **Profile 绑定**：`agentType` 为已存在的 Profile ID 且 `profile.runtime.kind === 'herdr'`（`runtime.agent` 指定 kind，可附 `runtime.nodeId` / `runtime.workspace` / `runtime.args` / `runtime.env`）。

非上述两种（普通 Profile / 未知前缀）返回 `continue` 交还内核原生执行行。节点选定优先级链：显式 `@nodeId`（含 `@local` 显式覆盖远端父节点）> `runtime.nodeId` > Profile 顶层 `nodeId` > 父会话绑定节点 > 本机。CLI 私有参数仅来自 `runtime.args` 原样透传，非法输入显式抛错，绝不猜测私有 flag。

完整执行行为：**建窗（普通 `tab.create` 或 worktree 模式 `worktree.create` + 补建带 env 的 tab 两步）、`agent.start`、权威就绪等待、`agent.prompt --wait`、blocked 审批桥、文件交接（含一次自愈）、gate 恰好一次、双轨保活清理**八段序列。`agent.start` 真实启动序列返回 `unknown + launch_pending`：必须 `agent.wait` 等权威就绪后再投递，不得把 unknown 当终态失败、也不得提前 prompt。

### 后台窗格隔离与文件交接

插件在 Herdr 内创建 `helm-wf-` 前缀命名的窗格后台静默执行，不干扰前台。任务 prompt 末尾附「helm 交接契约」：要求 agent 完成后把最终结果写入 `<effectiveCwd>/.helm/wf-out-<hash>.json|.md`——声明了 `schema` 时为满足 JSON Schema 的单个 JSON 值，否则为 Markdown 全文。「写文件是交付结果的唯一方式；未写文件视为任务失败」。

**原地追问自愈**：首次读取交接文件时，缺失、非法 JSON、Schema 校验失败或空文件均触发一次原地追问（注入明确的失败原因与重写指令，同轮走审批桥等待真实进展后再读）；二次仍失败则抛 `herdr_output_contract_violation`（附 `agent.read` 尾部 40 行脱敏快照），窗格保留现场供人工排查。**严禁静默截取终端脏屏幕文本冒充成功结果**——这是本插件最核心的诚实性红线。`herdr_output_missing`（404）是唯一可自愈边界码；其余 IO/SSH/权限错误如实抛诊断，不当缺文件重投任务。成功后交接文件即被清理。

Herdr 原生 `agent.prompt` 支持向 `working` 状态的代理继续提交输入；`blocked` 时返回 `agent_blocked` 且不写入终端。输入通过 Herdr 的 Agent 接口发送，具体是立即插话还是排队，由目标 CLI 决定；`--wait` 只观察生命周期状态，不确认某条补充指令已经执行完成。

### 运行中插话（steer 动作）与 `agent_prompt_guard_v1` 拟议契约

`builtin:herdr` 提供 `steer` 动作（HTTP `POST /api/actions/builtin:herdr/steer`、CLI `helm herdr steer`、`run_action` 与 Workflow `action()` 同权；不 `exposeAsTool`，模型统一走 `builtin:workflow.steer`）。`onResolved` 同时回传 `controls.steer = { pluginId: 'builtin:herdr', actionId: 'steer' }`，`builtin:workflow.steer` 据此把外部节点的插话动态委托到本动作（零硬编码路由；混合原生/外部候选歧义拒绝）。直调同样独立做调用方祖先链授权（模型路径的会话上下文由内核注入；HTTP 自报 `conversationId` 仅作用域提示、非认证）、父会话/run 强匹配与受管 `(nodeId, paneId)` 精确定位，不能经 `run_action` 绕开。仅限 workflow run 管理下的窗格：`workflowRunId` / `parentConversationId` 为必填外部控制契约。

门禁链（任何一步失败确定性拒绝，绝不静默降级）：仅在任务执行期（task 阶段；startup/handoff/gate/keepalive/failed/settled 一律拒绝，按 pane 互斥拒绝重入）；预检 `agent.get` 核验 name/tab/pane/terminal 完整身份、`working` 且非 `launch_pending`（`blocked` 交原审批桥，`idle/done/unknown` 拒绝且绝不新建回合）；能力门禁后以 `agent.prompt` 携带 `guard`、**不传 `wait`**、短超时单次投递，断线/超时/坏响应如实上抛（可能已部分投递的不确定结果），绝不重试。投递文本附原文件交接契约提醒；`steered=true` 仅代表投递成功，不代表该指导已被执行。

**拟议能力契约（Helm 侧提案，等待 Herdr 服务端配套；当前历史服务端不提供）**：

- 能力通告：`ping` 返回 `pong.capabilities.agent_prompt_guard_v1 === true`（严格布尔，缺失如实视为不支持）；
- 请求字段：`agent.prompt` params 增 `guard: { terminal_id, pane_id, tab_id, agent_name, state_change_seq, agent_status: 'working' }`，不携带 `wait`；`terminal_id` 必须取权威 `agent.get` 回传的真实值；
- 守卫语义（硬性要求）：服务端在写入任何 PTY 字节前原子核验完整身份四元组 + 水位 + `working`，且**守卫覆盖完整「文本 + 回车」投递期**（真实投递是先粘贴文本、延时后回车的多步序列，仅首字节前核验不足以保证整个 submission；需服务端以原子提交或输入保留实现）；核验不符返回 `stale_state` / `agent_not_ready` / `agent_blocked` 且零字节写入；部分写入后发生的异常必须如实报告为不确定结果，调用方不得重试；
- 现状证据（服务端源码只读核实，herdr 0.9.5 / protocol 22）：`AgentPromptParams` 仅 `{target, text, wait}`，无 guard 字段；旧服务端 serde 会静默忽略未知 guard 字段并照常投递。因此未通告该能力的服端被 fail-closed 拒绝（`409 herdr_steer_guard_unsupported`，附服务端 version/protocol 诊断），**绝不盲发**。在服务端配套发布前，不能声称真实 Herdr 全链路可用；仓内测试用的是实现该拟议契约的 fixture，不代表实际 Herdr 能力。

原 `driveTask` 在结算等待中排空在途 steer 并做权威复查：首个 `idle/done` 可能早于 steer 投递完成被 `agent.wait` 观察到，不能直接进入文件交接——排空后以 `agent.get` 复查，`working` 回到等待、`blocked` 交审批桥，真实 settled 才进入交接阶段并立即拒绝后续 steer。不用固定延时声称证明指令消费（CLI 内部队列消费不由协议保证）。不能用运行中 `resume` 代替插话（`resumeInto` 拒绝被占用窗格）；`resume` 仍只适用于存在、空闲且归属验证通过的执行。外部运行时不改变派生方会话的后台缺省策略（见 workflow 插件文档「默认后台协同」）。

**Gate 恰好一次验收**：文件成功后若请求带 `gate` 命令，在窗格实际节点与实际 cwd（worktree 模式为隔离树路径）、以建窗时的同一 env 执行恰好一次门禁命令（本机 `runLocalGate`，远端经节点通道）；`exit != 0` 即失败。

### 归属校验与孤儿回收

所有自有资源操作前做精确归属验证：`agent.name` 必须严格等于登记的 `agentName`（不 startsWith——`helm-wf-abc` 不能认领 `helm-wf-abcde`），身份不符即放弃所有权不误关。启动对账（`subscribe ack` 后 `session.snapshot` 扫描）按窗格状态分流：仍在 `working / blocked / unknown` 的保留并报告（绝不伪装结束自动回收）；持久 `failed` 的保留屏幕现场供排错；已结束且无在途 spawn 的孤儿窗格安全回收。停用时清理订阅、定时器、全部 pending Ask 与可回收自有 pane（failed 保留）。

## 带 CAS 乐观锁的审批桥

终端 Agent 阻塞等待交互（信任确认、菜单选择）时，插件把该阻塞桥接为 Web 端 AskDoc：权威 `agent.get` 现查窗格真实 `stateChangeSeq`，以该序号创建 Ask（预分配 ID `herdr:<nodeId>:<pane>:<seq>`），快照尾部自动提取游标菜单结构生成选项与按键映射（正则快路径识别标准菜单；非标 TUI 才异步调 AI 解析候选按键，失败回退通用选项并显式通知）。

CAS 语义双向防冲突：**人类先在 Web 审批**——提交时经 `registerAskSeqResolver` 注册的异步解析器现查权威 seq，序号一致才把人类选择映射为按键序列，并以带 `expected_state_seq` 的 `agent.send_keys`（要求 Herdr 服务端 `ping` 通告 `capabilities.send_keys_expected_state_seq === true`；服务端当前水位不匹配返回 `stale_state` 且零按键写入，未通告该能力的旧服务端被门禁显式拒绝）一次性发送终端；**人类先在终端按键**——终端 `stateChangeSeq` 推进后，对应 AskDoc 自动流转 `superseded` 销单，绝不向终端重复发送按键。发键后仍停留同 seq 的 blocked 时先退避防抖，连续退避仍无进展即重开审批让人类对照快照重选，绝不无限死锁。单飞协调器（`AskCoordinator`）保证同一 `(pane, seq)` 双路径（socket 事件与 spawn wait）只有先到者创建 Ask、后到者等待同一结算 promise。

## `$helm` 状态 Token 投射

插件经 `pane.report_metadata` 向 Herdr 终端侧栏投射 `$helm` 状态 Token（如 `run:helm-wf-abc`、`ask:herdr:local:p1:3`），让终端侧直观可见 Helm 任务态势。防自激环设计：`report_metadata` 本身产生 pane 事件，若每次事件后无条件再投射会无限循环——去重签名用业务状态 token 字符串（绝不用被 metadata 自身推进的 pane revision），仅 token 变化或 TTL 心跳到期（默认 30s 的一半刷新）时投射。心跳定时器随服务启停，服务正常退出时清理；崩溃后 Token 在 TTL 到期后自然消失。

## 受管动作（五端复用）

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `list` | `helm herdr list` | 列出本插件管理的全部窗格（nodeId / pane / 状态 / 归属 / 父会话 / workflowRunId） |
| `read` | `helm herdr read <paneId>` | 读取窗格终端尾部 40 行脱敏快照（`agent.read recent_unwrapped`） |
| `focus` | `helm herdr focus <paneId>` | 在 Herdr 终端聚焦指定窗格（用户显式操作） |

`read` 与 `focus` 支持 `--node-id` 消歧：多节点存在同 ID 窗格且未提供 `nodeId` 时显式 `409 pane_ambiguous`（附候选节点清单），拒绝猜谜执行；不由本插件管理的窗格显式 `404`。

## 巡检探针与诊断采集

内核不内置巡检定时器；`builtin:superagent` 的 Watchdog 服务巡检时经宿主进程内事件 `diagnostics.collect` 采集外部事实，本插件监听该事件并追加自有窗格的真实探针：并发 `agent.get`（单窗格 5s 短超时 + `Promise.all`，防单点慢节点卡死采集预算），报告 status、权威 seq、停滞水位（口径如实标注 `stalledBasis: 'since-last-state-change'`——只反映状态翻转间隔，不含 working 内部活动，不冒充总运行时长）、连续不可达计数与待答审批数。采集失败如实上抛给发起方，绝不静默吞。human 归属红线在此同样生效：非自有 pane 不产生 probe，总览重取为只读采集。

## UI 扩展与 Profile 运行时声明

插件注册三个 UI 贡献：左栏 `sidebarItem`（`Herdr 终端`，指向全屏总览 Screen）、全屏 `screen`（`HerdrOverviewScreen`，实时订阅公开 `overview` 文档展示全部受管窗格与待答 Ask 状态，支持 stale 标记与订阅断线提示）、`profileRuntime`（`kind: 'herdr'`，声明外部运行时元数据与 23 种 agent 候选建议，供角色中心的 runtime 配置表单与 `builtin:profile` 协作目录的运行时事实判定）。Profile 绑定 Herdr 运行时后，`builtin:profile` 的目录与补全将其标为 `external:herdr` 候选。
