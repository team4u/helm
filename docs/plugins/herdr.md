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

完整执行行为：**建窗（普通 `tab.create` 或 worktree 模式 `worktree.create` + 补建带 env 的 tab 两步）、`agent.start`、权威就绪等待、`agent.prompt --wait`、blocked 审批桥、文件交接（含一次自愈）、gate 恰好一次、双轨保活清理**八段序列。新建 PTY 的 shell 尚未就绪时，`agent.start` 可返回 `agent_pane_busy`（未启动 Agent）；Helm 仅对该错误在启动期限内等待再试，取消立即退出，超时或不确定结果不重试。启动成功可能仍是 `unknown + launch_pending`，须继续等权威就绪后再投递，不把 unknown 当终态失败，也不提前 prompt。

**窗格环境最小授权**：窗格 env 由内核 `buildSpawnEnv`（受管 `HELM_*` 回连集合，按确切目标节点构造）与 Profile `runtime.env` 合成。缺省**不携带任何父会话 SecretStash 机密**——外部窗格是独立进程，不自动继承会话机密；需要注入时由 spawn 请求显式 `secretNames` 逐名授予（名字需在父会话 stash 内现存，缺失显式报错，绝不静默降级为空注入），且按次授予、resume 不自动沿用。受管 `HELM_*` 恒由内核权威固定覆盖（Profile 不得覆盖回连/身份变量）；与未注入机密同名的 Profile 显式配置原样保留（不存在「父机密误删 Profile 配置」的交叉影响）。

### 后台窗格隔离与文件交接

插件在 Herdr 内创建 `helm-wf-` 前缀命名的窗格后台静默执行，不干扰前台。任务 prompt 末尾附「helm 交接契约」：要求 agent 完成后把最终结果写入 `<effectiveCwd>/.helm/wf-out-<hash>.json|.md`——声明了 `schema` 时为满足 JSON Schema 的单个 JSON 值，否则为 Markdown 全文。「写文件是交付结果的唯一方式；未写文件视为任务失败」。

**原地追问自愈**：首次读取交接文件时，缺失、非法 JSON、Schema 校验失败或空文件均触发一次原地追问（注入明确的失败原因与重写指令，同轮走审批桥等待真实进展后再读）；二次仍失败则抛 `herdr_output_contract_violation`（附 `agent.read` 尾部 40 行脱敏快照），窗格保留现场供人工排查。**严禁静默截取终端脏屏幕文本冒充成功结果**——这是本插件最核心的诚实性红线。`herdr_output_missing`（404）是唯一可自愈边界码；其余 IO/SSH/权限错误如实抛诊断，不当缺文件重投任务。成功后交接文件即被清理。

Herdr 原生 `agent.prompt` 支持向 `working` 状态的代理继续提交输入；`blocked` 时返回 `agent_blocked` 且不写入终端。输入通过 Herdr 的 Agent 接口发送，具体是立即插话还是排队，由目标 CLI 决定；`--wait` 只观察生命周期状态，不确认某条补充指令已经执行完成。

### 运行中插话（steer 动作）

`builtin:herdr` 提供 `steer` 动作（HTTP `POST /api/actions/builtin:herdr/steer`、CLI `helm herdr steer`、`run_action` 与 Workflow `action()`；模型统一走 `builtin:workflow.steer`）。`onResolved` 回传 `controls.steer = { pluginId: 'builtin:herdr', actionId: 'steer' }`，工作流据此动态委托，不按插件 ID 或 Agent 类型猜测路由。直调同样独立校验调用方祖先链、父会话/run 强匹配和受管 `(nodeId, paneId)`；HTTP 自报 `conversationId` 仅作作用域提示，不是认证。人类手开的窗格不能使用此入口。

Helm 仅在任务执行期接受插话，按窗格单飞；startup、handoff、Gate、关闭和终态拒绝。发送前用 `agent.get` 核对 name/tab/pane、非 `launch_pending` 且为 `working`，随后调用现有 `agent.prompt({ target: agentName, text })`，不附加新能力门槛、`guard` 或 `wait`。这使用 Herdr 0.9.5 / protocol 22 已有的请求格式。

结果标记 `guardLevel: 'preflight'`：`stateChangeSeq` 是发送前观测值，不承诺提交点 CAS。预检已是 `idle/done` 时拒绝；从预检 `working` 到接收请求之间刚变为 `idle`，允许同一受管 Agent 接续一轮。Herdr 在接收请求时拒绝 `blocked`、仍在启动或已不处于前台的 CLI；文本与回车投递期间仍可能发生状态变化，不把这些检查描述为完整提交期的原子保证。审批 `agent.send_keys` 继续使用独立的服务端 CAS 门槛。

每次插话给出一个新的业务结果文件路径，仍为 `<effectiveCwd>/.helm/wf-out-<唯一标识>.json|.md`，并明确旧路径作废。CLI 只需按最新指导写这一个结果文件，原 JSON Schema 和 Gate 不变，不需要额外确认文件。工作流排空在途插话后只读取最新路径；原回合迟到写回旧文件也不会被当作最新结果。投递后仍为 `working/blocked` 时继续等待或走原审批桥；短暂 `idle` 且新文件未出现时，先有界等待状态推进，再走原有单次交接自愈。仅看到 `idle` 不等于已执行指导。

`steered=true` 仅表示投递成功。控制动作不幂等，超时、断线或坏响应不自动重发；不确定投递使原任务显式失败并保留现场，不能回读旧结果或自动追问冒充成功。明确未写入的服务端拒绝保留原任务及其有效交接路径。

不能用运行中 `resume` 代替插话（`resumeInto` 拒绝被占用窗格）；`resume` 仍只适用于存在、空闲且归属验证通过的执行。外部运行时不改变派生方会话的后台缺省策略（见 workflow 插件文档「默认后台协同」）。

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
