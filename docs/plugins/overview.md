# 插件系统设计与契约

本文是 Helm 插件系统的总纲：阐述微内核宿主架构、`definePlugin(ctx)` 强类型契约、10 个内置插件的全景分工，以及动作五端映射、持久文档、停用预检与故障隔离等横切机制。各内置插件的深度文档见同目录下的独立篇章。

## 宿主架构：机制与策略分离

Helm 内核只保留四块通用机制——`pi-durable` 持久会话状态机与原生子会话派生、`EnvFabric` 跨节点执行底座（`NodeRegistry` + 内建 `local` 节点 + 远端 `@helm/node` 守护进程）、Model 与 Auth、以及唯一强类型插件宿主 `PluginHost`。所有业务角色、外部系统对接与高级交互全部下沉到插件层：内核不硬编码 `router / worker / watchdog` 等角色枚举，不内置巡检定时器（无 `watchdog_tick` Hook），Git Worktree 租约与编排引擎也不在内核。这套分离让「内核提供机制、插件提供策略」成为可执行的代码事实，而非口号。

插件是**可信代码**，宿主不提供安全沙箱：隔离是状态与配置层面的（专属数据目录、私有文档命名空间、凭据命名空间），不是权限沙箱。任意插件天然拥有宿主权限，可读环境变量与进程内数据——文档中凡涉及机密边界处均如实声明这一前提。在此约束下，宿主提供四项核心保障：

1. **唯一强类型入口**：每个插件实现 `definePlugin(ctx)`，经 `ctx` 获取全部宿主能力。内置插件的 `createXxxPlugin()` 工厂一律零参数，不接收私有依赖注入。
2. **状态隔离**：每个插件分配专属数据目录 `~/.helm/plugins/<id>/`，`ctx.doc` / `ctx.sessionDoc` 在 state.sqlite 中按插件划分命名空间。
3. **单点动作声明**：一次 `ctx.action()` Schema 声明自动映射到 HTTP / CLI / Agent Tool / Workflow / Web UI 五个消费端。
4. **安全受控停用**：在途任务硬阻断、持久资源知情确认、locked 插件永久保护，详见下文「停用预检」。

## 内置插件全景

内核启动时由组合层（`app.ts`）按固定顺序注册 10 个内置插件。前 7 个默认启用，后 3 个默认停用、按需开启：

| 插件 ID | 名称 | 职责一句话 | 默认状态 | locked |
| :--- | :--- | :--- | :--- | :--- |
| `builtin:profile` | 角色与技能底座 | 按会话 Profile 注入 SYSTEM.md 与技能目录，提供 `load_skill` 工具 | 启用 | 是（常驻不可卸载） |
| `builtin:workflow` | 工作流与子代理编排 | `subagent` / `SubagentWorkflow` / `cleanup_worktree` 工具、DSL 编排引擎与受管 Git Worktree 生命周期 | 启用 | 否 |
| `builtin:memory` | 长期记忆 | 按 Profile 管理 MEMORY.md 注入与启停，提供 `update_memory` 工具 | 启用 | 否 |
| `builtin:json-render` | JSON 卡片渲染 | 接管 ```ui 代码围栏渲染声明式 JSON Spec 卡片，自举 `generative-ui` 技能 | 启用 | 否 |
| `builtin:mermaid` | Mermaid 图表 | 接管 ```mermaid 代码围栏，把 Mermaid 文本渲染为矢量图表 | 启用 | 否 |
| `builtin:apps` | 应用中心 | 全栈微应用目录（`catalog`）、`validate/publish/list/update_meta/remove` 动作、应用中心启动台与 `app-builder` 技能 | 启用 | 否 |
| `builtin:triggers` | 触发器 | Cron 定时与 Webhook 签名入站连接器 | 启用 | 否 |
| `builtin:herdr` | Herdr 终端 | 拦截 `agent_spawn` 驱动本机/远端 Herdr CLI Agent，带 CAS 审批桥 | 停用 | 否 |
| `builtin:superagent` | SuperAgent 中枢 | 双层中枢（总控路由 + 驻留 Worker）与两层巡检看门狗 | 停用 | 否 |
| `builtin:magpie` | Magpie 网关 | 动态模型网关接入：模型目录、配额与路由组诊断 | 停用 | 否 |

10 个插件之间正交且可组合：`builtin:profile` 为所有会话提供认知底座；`builtin:memory` 与之正交（内核对记忆零感知）；`builtin:apps` 经 `ctx.host.plugins` 受管包端口管理用户全栈微应用的预检与发布；`builtin:workflow` 的编排引擎消费 `builtin:herdr` 接管的外部运行时（经 `agent_spawn` 管道，对脚本层透明）；`builtin:superagent` 的 Watchdog 经 `diagnostics.collect` 进程内事件采集 Herdr 窗格探针；`builtin:json-render` 与 `builtin:mermaid` 是扩展点之上的普通消费者，停用即回退普通代码块，不影响其他插件。

## `definePlugin(ctx)` 契约

插件必须导出包含 `definePlugin(ctx)` 的定义对象。内置插件经 TypeScript 工厂函数构造；外部插件在 `plugin.json` 声明入口后 `export default` 定义对象（见 [plugin-development.md](plugin-development.md)）。上下文 `ctx` 的完整能力面如下：

| 接口 | 职责 | 关键约束 |
| :--- | :--- | :--- |
| `ctx.pluginId` / `ctx.dataDir` | 只读身份与专属数据目录 | `~/.helm/plugins/<id>/` |
| `ctx.getConfig()` | 读取当前生效配置 | secret 字段经 `configSchema` 分离至 credentials.json |
| `ctx.configSchema(schema)` | 声明配置字段结构 | `type: string/number/boolean`，`secret: true` 自动入 `SecretStash` |
| `ctx.hook` | 注册 7 个生命周期 Hook | `trigger / input / before_turn / tool_call / tool_result / agent_spawn / turn_settled`，支持 `priority` |
| `ctx.action(spec)` | 注册五端复用动作（含会话目录自动发现） | 强类型 `inputSchema` / `outputSchema`，可选 `promptSnippet` / `promptGuidelines`，见下文 |
| `ctx.tool(spec)` | 注册仅对模型可见的工具 | 支持 `promptSnippet` / `promptGuidelines` / `onUpdate` / `scope` |
| `ctx.route(spec)` | 挂载 Web Standard 原始 HTTP 路由 | `public: true` 跳过 Token 鉴权（webhook 回调用） |
| `ctx.doc(name, initial, opts)` | 声明持久状态文档 | state.sqlite；`public: true` 进全局首帧与 SSE 广播 |
| `ctx.sessionDoc(name, initial, opts)` | 按会话分片的持久文档 | 不进全局首帧/全局 SSE，专用订阅流 |
| `ctx.service(spec)` | 注册后台长驻服务 | `prepare / start / stop / liveTasks / liveWorktrees / inUse` |
| `ctx.provider(provider)` | 注册模型供应商网关 | 启用时挂载、停用后注销，宿主统一协调 |
| `ctx.ui` | 前端全界面扩展点注册表 | 16 个注册方法，见 [extension-points.md](../architecture/extension-points.md) |
| `ctx.host` | 宿主运行时能力 | 见下文「ctx.host 能力面」 |

### 生命周期与全局启动屏障

插件状态机覆盖「注册、启用、执行、停用、卸载」五个阶段。关键时序约束是**全局 prepare 后 start 屏障**：`PluginHost.start` 先对全体已启用服务执行 `prepare()`，全部完成后才依次执行 `start()`，最后恢复会话调度。热启用单个插件同样先 prepare 后 start。这一屏障存在的理由：`builtin:workflow` 需要在任何输入提交之前，先为重启中断的子会话落持久取消标记（`prepareInterruptedConversations`）——如果此刻其他插件的工具尚未注册，任何输入提交都会产生 orphan 回合。

### 插件间依赖（仅 ID，不做版本解析）

插件定义或清单可声明 `dependencies: string[]`（其他插件 ID）。宿主按确定性规则处理：

- **启用门禁**：启用（含注册即启用）时逐项校验依赖已注册且已启用——仅注册未启用不满足，缺失/未启用分别报 `409 plugin_dependency_missing` / `409 plugin_dependency_not_enabled`；提交点同一同步段内终检，并发窗口不留悬挂启用态。
- **环路拒绝**：依赖图成环（含自依赖）在注册边界拒绝（`409 plugin_dependency_cycle`），绝不死锁。
- **拓扑时序**：全局启动屏障按依赖拓扑序 prepare/start（被依赖者先启，同层保持注册序），`stop` / `dispose` 按逆拓扑序。
- **依赖者保护**：停用/注销被依赖插件时，依赖它的已启用插件（含传递依赖者）作为 `plugin_in_use` 占用项拦截；`--force` 停用后依赖者被显式标记为故障态（清单 `status=failed` 附诊断），绝不静默潜伏。

`PluginSummary.dependencies` 透出归一后的依赖清单，CLI / Web 自动消费。

`stop()` 必须取消或等待本服务的全部在途回调。宿主在 await `stop()` 链期间开启**受控停止窗口**：允许本插件当前启用周期的 doc 句柄完成最终写入（`builtin:workflow` 利用此窗口在 stop 内做最终 runs 投影并 `await flush()`）。`stop()` 返回后句柄失效，此后任何写入都会被 epoch 守卫拒绝。`flush()` 冲刷的是共享存储队列而非按文档划分的事务——需要「先落盘再派生副作用」时必须显式 await。

### `ctx.tool`：模型专用工具

与 `ctx.action` 的区别在于消费端：工具直接进入模型回合工具列表，按 `scope`（`ConversationScope`：conversationIds / tags / profileIds / modelProviders 组合）过滤可见性与执行。三个声明性能力值得注意：

- `promptSnippet`：完整段落文本，工具激活时原样注入 `prompt.tools.<name>` 命名 section；
- `promptGuidelines`：要点列表，聚合进 `prompt.tools.guidelines` 共享 section；
- 两者均未声明时不产生任何提示词文本——**未激活的工具绝不留下幻影提示词**，这一纪律贯穿所有内置插件。

执行期间的流式进度经 `context.onUpdate(partial)` 上报：`output` 是至今累计快照（非增量），宿主对全量脱敏后按差量转发进 Web 实时工具卡；结算后的迟到调用静默丢弃，结算前的真实故障显式抛出。

## 动作五端映射与幂等契约

`ctx.action()` 是插件对外暴露业务能力的唯一入口。宿主按声明自动映射到五个执行环境：

| 消费端 | 映射形态 |
| :--- | :--- |
| HTTP | `POST /api/actions/:pluginId/:actionId`（pluginId 含 `:` 时 URI 编码，如 `builtin%3Aworkflow`） |
| CLI | `helm <plugin> <action>` 顶层命令（`cli.command` 可整体改写路径，如 `workflows run`、`worktrees cleanup`） |
| Agent Tool | `exposeAsTool: true` 直接注入工具列表；否则经元工具 `run_action` 按需调用 |
| Workflow | 编排脚本 `action('pluginId.actionId', input, options)` 调度 |
| Web UI | 声明式 Spec `{ type: 'helm:action', pluginId, actionId, input }` 或 `ctx.callAction` |

输入输出在边界处统一 JSON Schema 强校验；输出经宿主统一脱敏后返回。

### 会话动作目录（自动发现）

除五端映射外，运行时把启用且匹配会话 `scope`、未设置 `exposeAsTool: true` 的动作投射进系统提示 `prompt.actions` 段的 `<available_actions>` 目录：每项含全限定 ID、description、可用 CLI 命令与紧凑参数签名，模型经 `run_action` 元工具按需调用（目录仅在 `run_action` 存在时生成）。直接暴露的动作使用模型工具列表展示，避免重复；其工具被剥离时也不会借目录重新推荐。内置与外部插件同权——新插件启用后动作自动入目录，无需修改 SYSTEM.md 或内置技能；插件停用、动作注销或对本会话不可达时条目自动清理，不留幻影提示词。

`PluginActionSpec` 可选 `promptGuidelines: string[]`（使用要点）与 `promptSnippet: string`（完整段落）：经 `run_action` 调用的动作在目录条目中展示指引，直接暴露的动作在其工具实际激活时沿用工具指引投射，不重复注入。目录是摘要：完整 schema 用 `run_action({ actionId, describe: true })` 只读自省（返回完整 manifest，不执行 handler，同样按启用状态与 scope 过滤），或经 CLI `helm actions list --json`。`scope` 同时约束目录可见性、describe 与调用；人工 HTTP/CLI 不受 scope 限制。

`idempotent` 声明是作者对安全重试的**承诺**，不是引擎检测所得：声明 `true` 的动作在工作流账本中成功后进入前缀缓存复用，中断或失败时允许 `resumeFromRunId` 从该步安全重跑；声明 `false`（默认）的动作一旦执行状态不确定（进程崩溃于执行中），账本标记 `workflow_action_uncertain`，恢复时拒绝自动重跑副作用、显式交由人类确认。`prepareAction` 端口提供无副作用的前置校验（插件状态、scope、inputSchema + 定义端 idempotent），供编排引擎在落盘 `action_started` 前判定副作用语义。

## `ctx.doc` 与 `ctx.sessionDoc`

`ctx.doc(name, initial, { public: true })` 声明全局持久文档：写入 state.sqlite，公共文档进入全局 SSE 首帧 `pluginDocs` 并在每次更新时广播 `plugin.doc.updated` 事件，前端 `usePluginDoc` / CLI `helm plugins doc` 直接消费。私有文档（缺省）只在本插件内可见，适合存放开关状态、去重标记等紧凑元数据。公共文档只应存储展示状态，禁止包含未脱敏机密。

高频且只属于单个会话的状态使用 `ctx.sessionDoc`：按 `conversationId` 分片持久化，**不进入全局首帧、不经普通 `/api/events` 广播**，消费方经专用 SSE（`GET /api/plugins/:id/docs/:name/events?conversationId=N`）按需订阅，客户端 `usePluginSessionDoc` 在挂载期间订阅、引用归零时退订。这一分片设计防止「全部会话的详情撑爆全局首帧」——`builtin:workflow` 的完整 `runs` 投影即按此分片，全局仅保留紧凑的 `run-badges` 角标。

同一插件内 `doc` 与 `sessionDoc` 不能同名。句柄读写深拷贝状态，要求会话真实存在；`delete(conversationId)` 复位到初始值并通知订阅者，会话删除时宿主清理对应持久记录。

两类文档共用一条**体积防线**：`initial` / `set` / `update` 的值经 JSON 序列化后超过 **2 MiB** 即在写入镜像、持久层与事件发布之前显式拒绝（`413 plugin_doc_too_large`，details 携带 pluginId / name / kind / bytes / maxBytes），旧值保持不变。文档是紧凑状态而非数据仓库——大体量内容应落盘为文件资产并在文档内保留引用。不可 JSON 序列化的值（undefined、循环引用、非纯对象等）在边界即显式拒绝（`invalid_json_value`）。

## 停用预检与故障隔离

停用一个插件要过三道关卡，顺序固定：

1. **locked 硬拒绝**：声明 `locked: true` 的插件（仅 `builtin:profile`）永久禁止停用或卸载，返回 `403 locked_plugin_cannot_be_disabled`。
2. **在途任务硬阻断**：`liveTasks()` 返回非空（执行中的动作/工具/子代理派生/服务自声明任务）即 `409 plugin_has_live_tasks`，**不可 force 跳过**——状态一致性优先。`liveTasks()` 执行崩溃或返回非法数据时按 `500 plugin_live_tasks_check_failed` 拒绝，宿主绝不默认放行。
3. **持久资源知情确认**：`inUse()` 声明持久生效资源（如 `builtin:triggers` 的已启用 cron 任务与 webhook 端点），非空默认 `409 plugin_in_use` 并列出占用清单；调用方显式 `--force` 可越过（磁盘配置保留，重新启用后恢复）。宿主还会通用探测 Profile.runtime 绑定与模型引用（`profile_runtime` / `profile_model` / `conversation_model`）与依赖它的已启用插件（`plugin_dependency`，含传递依赖者）。

`liveWorktrees()` 声明运行中任务占用的受管工作树路径，供 `builtin:workflow` 的清理链拒绝误碰在途占用——它不参与停用阻断（那是 `liveTasks` 的职责），而是清理安全机制。

故障隔离方面，插件加载或启用失败不拖垮内核：`PluginSummary.status` 置 `failed` 并携带结构化 `error`（`code / message / stage / details`），`stage` 标明故障阶段（`scan` 清单解析 / `load` 模块导入 / `define` 契约校验 / `enable` 服务启动）。失败插件在插件中心可见且诊断可读；修复源码后经 `reload` 或重启恢复。

## `ctx.host` 能力面

`ctx.host`（`HelmHostApi`）是插件调用内核机制的唯一受信通道，实现已绑定插件自身 ID、不可伪造他人身份。按职责分组：

| 分组 | 端口 | 说明 |
| :--- | :--- | :--- |
| 外部事件 | `dispatchTrigger(envelope)` | 投递防逃逸信封进 `trigger` 管道 |
| 输入与会话 | `submitInput(id, text, opts)` / `submitInputGuarded(id, text, opts, guard)` | `requestId` 支持跨重启幂等提交；`origin: human/agent/trigger`；`whenBusy: steer/followUp/reject`；`submitInputGuarded` 在提交点原子复核归属（严禁 human）与 CAS 水位 |
| 会话管理 | `createConversation / listConversations / getConversation / getConversationDetail / updateConversation / abortConversation / abortConversationGuarded` | 全套会话生命周期；`abortConversationGuarded` 在首个不可逆动作前原子复核归属与水位；`manageConversation` 声明删除保护（`409 conversation_managed_by_plugin`）；`markConversationOwnership` 标记归属权 |
| 人机审批 | `createAsk / cancelAsk / registerAskSeqResolver` | AskDoc 创建与 CAS 水位解析器注册 |
| 子代理与执行 | `spawnAgent / runGate / execEnv / prepareInterruptedConversations / resolveSpawnTarget / listActiveSpawnExecutions / probeNodeFs / withFileMutationQueue` | `agent_spawn` 管道派生、门禁命令、跨节点执行（复用 EnvFabric 与脱敏） |
| 动作互调与插件治理 | `prepareAction / invokeAction / listActions / plugins` | 跨插件动作 preflight 与执行；`ctx.host.plugins` 提供受管包生命周期（`list / listUi / doctor / install / update / remove / enable / disable`，拦截自指修改） |
| 资产端口 | `profiles / skills / secrets` | Profile 读写与 SYSTEM.md、技能受管自举、插件私有机密（credentials.json `pluginSecrets.<pluginId>`，恒 0600） |
| 节点与文件 | `nodeIpc / nodeFetch / openTunnel / executionEnv / withFileLock / atomicWriteFile / buildSpawnEnv` | 跨节点 IPC 桥（Herdr 用）、节点 HTTP(S) 透传 `fetch`（任意 host，跨节点访问节点视角的 HTTP/HTTPS/SSE 服务）、任意 TCP 透传隧道（原始 Duplex）、目标节点执行环境、文件锁与原子写 |
| 通用机制 | `redact / redactText / completeText / refreshModels / listPlugins / listUi / setConfig / isClosing` | 脱敏、无工具单次文本补全、目录刷新、清单读取、自身配置更新 |
| 事件 | `onEvent(type, listener) / emitEvent(type, payload, opts)` | 订阅 `workflow.settled`、`conversation.entry` 等事件；`broadcast: false` 仅进程内分发；插件停用自动解除订阅 |

两条使用纪律：其一，受管 Git Worktree 清理不在 `ctx.host`——插件如需清理受管工作树，调用 `builtin:workflow` 的 `cleanup_worktree` 动作（经 `invokeAction` 或 CLI `helm worktrees cleanup`）；其二，`execEnv` 目标节点或目录缺省时继承请求中 `conversationId` 对应会话坐标，节点离线显式报 `409 node_offline`，绝不静默回退本机。

## 延伸阅读

- 各内置插件深度文档：[workflow](workflow.md) · [profile](profile.md) · [memory](memory.md) · [apps](apps.md) · [herdr](herdr.md) · [superagent](superagent.md) · [triggers](triggers.md) · [magpie](magpie.md) · [json-render](json-render.md) · [mermaid](mermaid.md)
- 扩展点契约详解：[后端生命周期 Hook 与前端全界面扩展点](../architecture/extension-points.md)
- 外部插件开发实战：[plugin-development.md](plugin-development.md)
