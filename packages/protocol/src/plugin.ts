/**
 * PluginHost 唯一强类型插件契约：definePlugin(ctx)。
 * 后端 7 大可组合生命周期 Hook + ctx.action 单点 Schema 五端复用 + 宿主运行时 API。
 * 本文件只定义类型，不含任何运行时；动作合法性（如 watchdog_tick 不允许 block）
 * 由 host 在运行时校验。
 */

import type { AskCreateSpec, AskResult } from './ask.js'
import type {
  ConversationInit,
  ConversationInput,
  ConversationPatch,
  ConversationScope,
  ConversationStatus,
  ConversationSummary,
  InputOrigin,
  TurnSettledPayload,
  WhenBusy,
} from './conversation.js'
import type { WorkflowRunSummary } from './workflow.js'
import type { PluginUiContribution, PluginUiRegistry } from './ui.js'

/** JSON Schema 对象；由宿主在边界处统一校验。 */
export type JsonSchema = Record<string, unknown>

export type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Hook 管道：8 个挂载点（tool_call / tool_result 分列）
// ---------------------------------------------------------------------------

export type HookName =
  | 'trigger'
  | 'input'
  | 'before_turn'
  | 'tool_call'
  | 'tool_result'
  | 'agent_spawn'
  | 'turn_settled'
  | 'watchdog_tick'

/**
 * 外部入站事件信封（cron / webhook 经 defang 防逃逸包裹后投递）。
 * 命中 threadKey 订阅时可被 transform 改写 targetConversationId 直投 Worker。
 */
export interface ExternalTriggerEnvelope {
  id: string
  /** 事件源标识，如 'cron'、'webhook:<id>'。 */
  source: string
  /** defang 包裹后的载荷文本。 */
  text: string
  /** 订阅直通键（ThreadSubscriptionDoc 路由）。 */
  threadKey?: string
  /** 定向投递会话；缺省投递常驻入口 Conversation #1。 */
  targetConversationId?: number
  metadata?: Record<string, unknown>
  createdAt: number
}

/** input 钩子载荷。 */
export interface InputHookPayload {
  conversationId: number
  input: ConversationInput
}

/** before_turn 钩子载荷：原地修改 tools / sections / messages。 */
export interface BeforeTurnHookPayload {
  conversation: ConversationSummary
  inputs: ConversationInput[]
  tools: PluginToolSpec[]
  /** 注入系统提示词的命名段落。 */
  sections: Array<{ id: string; text: string }>
  /** 原始消息数组（pi-durable entry 形状，保持透明）。 */
  messages: Array<Record<string, unknown>>
}

export interface ToolCallHookPayload {
  conversationId: number
  callId: string
  toolName: string
  input: Record<string, unknown>
}

export interface ToolResultHookPayload {
  conversationId: number
  callId: string
  toolName: string
  input: Record<string, unknown>
  result: unknown
}

/**
 * 子代理派生请求：agent_spawn 钩子载荷。
 * agentType 为普通 Profile ID 时内核默认走 pi-durable 原生子会话；
 * 为 'herdr:<kind>' 时由 builtin:herdr 拦截接管。
 */
export interface AgentSpawnRequest {
  parentConversationId: number
  prompt: string
  /** 编排宿主分配的稳定调用标识，用于续接与取消。 */
  agentId?: string
  /** Profile ID 或 'herdr:<kind>' 外部运行时标识。 */
  agentType?: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  /**
   * 执行环境确定后回传（原生子会话或外部运行时均适用）；
   * 编排宿主据此把 conversationId / worktree 等元数据写回节点状态。
   */
  onResolved?: (info: AgentExecutionInfo) => void
  /** gate 命令由实际执行环境内恰好一次执行后回传结果；宿主引擎可免二次执行。 */
  onGateResult?: (result: AgentGateResult) => void
  /** 发起本次派生的 workflow run；非工作流派生缺省。 */
  workflowRunId?: string
  cwd?: string
  /** 结构化输出 JSON Schema（文件交接时强制落盘校验）。 */
  schema?: JsonSchema
  /** Shell 验收门禁命令；唯一命令来源，宿主不得另行叠加。 */
  gate?: string
  /** 续接既有子代理的标识。 */
  resume?: string
  /** 随本次子代理派生传递的产物 ID 列表。 */
  attachments?: string[]
  /** 取消信号，由宿主注入。 */
  signal?: AbortSignal
}

/**
 * 子代理实际执行环境元数据（onResolved 回传）。
 * 原生路径至少回传 conversationId；外部运行时（如 herdr）至少回传 executionId。
 */
export interface AgentExecutionInfo {
  conversationId?: number
  /** 外部运行时内的执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效的工作目录绝对路径。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 时分配的隔离工作树。 */
  worktree?: { path: string; branch: string }
}

/** gate 命令执行结果；output 为失败时展示给用户的命令输出。 */
export interface AgentGateResult {
  ok: boolean
  output: string
}

/**
 * Watchdog 探针归属权：'human' 会话/终端窗格严禁发送按键或中止指令，
 * 仅允许只读诊断与通知（红线由 host 与插件共同遵守）。
 */
export type WatchdogOwnership = 'helm' | 'bot' | 'human'

/** 探针目标类别：conversation = 原生会话；external = 外部运行时目标（如 Herdr 窗格）。 */
export type WatchdogTargetKind = 'conversation' | 'external'

/** 单个巡检探针采集到的事实。 */
export interface WatchdogProbe {
  /** 探针目标：会话 ID 或 Herdr 窗格 ID 等外部标识。 */
  targetId: string
  /** 目标类别；未声明类别的探针不作为自动干预授权。 */
  targetKind?: WatchdogTargetKind
  /** targetKind 为 conversation 时的原生目标会话 ID（仅目标本身；外部 pane 的父会话不得冒充此字段）。 */
  conversationId?: number
  /** targetKind 为 external 时的目标节点 ID（'local' 或 BYOM 节点 ID）。 */
  nodeId?: string
  /** 兼容别名：目标节点 ID。 */
  machine?: string
  ownedBy: WatchdogOwnership
  /** 目标当前状态（通用字符串，容纳会话五态与 Herdr 窗格状态）。 */
  status: string
  /** 权威状态变化序号（会话 stateChangeSeq / 外部 state_change_seq）；无法读取权威值时必须省略，绝不猜造。 */
  stateChangeSeq?: number
  /** 停滞毫秒数。 */
  stalledMs?: number
  /** 连续报错次数。 */
  consecutiveErrors?: number
  /** 附加事实（如终端尾部快照摘要）。 */
  facts?: Record<string, unknown>
}

/** watchdog_tick 钩子载荷：探针采集快照。 */
export interface WatchdogTickHookPayload {
  timestamp: number
  conversations: ConversationSummary[]
  probes: WatchdogProbe[]
}

/** 每个钩子的完整载荷类型映射。 */
export interface HookPayloadMap {
  trigger: ExternalTriggerEnvelope
  input: InputHookPayload
  before_turn: BeforeTurnHookPayload
  tool_call: ToolCallHookPayload
  tool_result: ToolResultHookPayload
  agent_spawn: AgentSpawnRequest
  turn_settled: TurnSettledPayload
  watchdog_tick: WatchdogTickHookPayload
}

/**
 * Hook 处理器返回值：
 * - continue  放行
 * - transform 原地改写载荷交由后续处理器与内核消费
 * - handled   短路接管，终止默认行为（result 为接管产物）
 * - block     门控拦截（仅部分钩子允许，由 host 运行时校验）
 */
export type HookResult<TPayload, TResult = unknown> =
  | { action: 'continue' }
  | { action: 'transform'; value: TPayload }
  | { action: 'handled'; result?: TResult }
  | { action: 'block'; reason: string }

/** 同步或异步处理器；返回 void 等价于 continue。 */
export type HookHandler<K extends HookName> = (
  payload: HookPayloadMap[K],
) => MaybePromise<HookResult<HookPayloadMap[K]> | void>

export type TriggerHookHandler = HookHandler<'trigger'>
export type InputHookHandler = HookHandler<'input'>
export type BeforeTurnHookHandler = HookHandler<'before_turn'>
export type ToolCallHookHandler = HookHandler<'tool_call'>
export type ToolResultHookHandler = HookHandler<'tool_result'>
export type AgentSpawnHookHandler = HookHandler<'agent_spawn'>
export type TurnSettledHookHandler = HookHandler<'turn_settled'>
export type WatchdogTickHookHandler = HookHandler<'watchdog_tick'>

export interface HookOptions {
  /** 优先级，默认 0；数值大的先执行。 */
  priority?: number
}

export interface PluginHookRegistry {
  onTrigger(fn: TriggerHookHandler, opts?: HookOptions): void
  onInput(fn: InputHookHandler, opts?: HookOptions): void
  onBeforeTurn(fn: BeforeTurnHookHandler, opts?: HookOptions): void
  onToolCall(fn: ToolCallHookHandler, opts?: HookOptions): void
  onToolResult(fn: ToolResultHookHandler, opts?: HookOptions): void
  onAgentSpawn(fn: AgentSpawnHookHandler, opts?: HookOptions): void
  onTurnSettled(fn: TurnSettledHookHandler, opts?: HookOptions): void
  onWatchdogTick(fn: WatchdogTickHookHandler, opts?: HookOptions): void
}

// ---------------------------------------------------------------------------
// ctx.action：单点 Schema，HTTP / CLI / Agent Tool / Workflow / Web 五端复用
// ---------------------------------------------------------------------------

/**
 * 动作调用上下文：人工 HTTP/CLI 可无 conversationId；
 * 模型路径（run_action 元工具）与 Workflow 路径必须携带 conversationId，
 * 供宿主校验 scope（防绕过会话作用域）。
 */
export interface PluginActionContext {
  conversationId?: number
  signal?: AbortSignal
}

export interface PluginActionCliSpec {
  /** 顶层命令路径；缺省为 [去掉 builtin: 的 pluginId, actionId]。 */
  command?: string[]
  /** CLI 帮助文案；缺省沿用 action description。 */
  description?: string
  /** true 时不出现在顶层 `helm <plugin> <action>` 命令中。 */
  hidden?: boolean
}

export interface PluginActionSpec<TIn, TOut> {
  /** 动作 ID（plugin 内唯一）；映射为 POST /api/actions/:pluginId/:actionId。 */
  id: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  /** CLI 暴露微调；缺省自动挂载为 `helm <plugin> <action>`。 */
  cli?: PluginActionCliSpec
  /** true 直接注入模型工具列表；否则经元工具 run_action 按需调用。 */
  exposeAsTool?: boolean
  /** 会话作用域：提供 conversationId 的调用（含 run_action/workflow）必须命中才可执行；人工 HTTP/CLI 不受限制。 */
  scope?: ConversationScope
  handler(input: TIn, context: PluginActionContext): MaybePromise<TOut>
}

/** ctx.tool：模型专用工具。 */
export interface PluginToolContext {
  conversationId: number
  signal?: AbortSignal
}

export interface PluginToolSpec<TIn = Record<string, unknown>> {
  name: string
  description: string
  inputSchema: JsonSchema
  /** 会话作用域：工具可见性与 executeTool 的双重过滤条件。 */
  scope?: ConversationScope
  execute(input: TIn, context: PluginToolContext): MaybePromise<unknown>
}

// ---------------------------------------------------------------------------
// 持久状态、后台服务与原始路由
// ---------------------------------------------------------------------------

/** 插件自有持久文档句柄（state.sqlite）；同步接口方便 pi-durable store 直用。 */
export interface PluginDocHandle<T> {
  get(): T
  set(value: T): void
  update(fn: (current: T) => T): void
}

/** 插件公共文档快照（跨端可读；逐值 JSON 校验/脱敏后发布，默认不公开）。 */
export interface PublicPluginDoc {
  pluginId: string
  name: string
  value: unknown
}

export interface PluginDocOptions {
  /** true 时文档进入公共快照与 plugin.doc.updated 事件；默认私有。 */
  public?: boolean
}

export interface PluginServiceSpec {
  id: string
  start(): MaybePromise<void>
  stop(): MaybePromise<void>
  /** 返回仍需本服务保活的任务标签；宿主在停用/卸载前同步检查。 */
  liveTasks?(): string[]
}

/** Web Standard 原始路由（Request/Response 为 DOM lib 类型）。 */
export interface PluginRouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 以插件 ID 为前缀挂载的相对路径。 */
  path: string
  /** true 时跳过 Token 鉴权（webhook 回调等）。 */
  public?: boolean
  handler(req: Request): MaybePromise<Response>
}

/** 插件配置字段 Schema；secret: true 自动分离至 credentials.json。 */
export interface PluginConfigFieldSchema {
  type: 'string' | 'number' | 'boolean'
  label?: string
  description?: string
  default?: string | number | boolean
  secret?: boolean
  required?: boolean
}

// ---------------------------------------------------------------------------
// 可串行化清单（GET /api/plugins 与 GET /api/actions）
// ---------------------------------------------------------------------------

export interface PluginSummary {
  id: string
  name: string
  version?: string
  /** 常驻不可卸载（如 builtin:assistant）。 */
  locked: boolean
  enabled: boolean
  hooks: HookName[]
  actions: string[]
  tools: string[]
}

/** 单个已注册动作的可串行化清单，供 CLI / Web / Workflow 消费。 */
export interface ActionManifest {
  pluginId: string
  id: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  exposeAsTool?: boolean
  cli?: PluginActionCliSpec
  scope?: ConversationScope
}

// ---------------------------------------------------------------------------
// 宿主运行时能力
// ---------------------------------------------------------------------------

/** ctx.host：插件可调用的宿主内核能力（插件拿到的实现已绑定其 pluginId，不可伪造他人身份）。 */
export interface HelmHostApi {
  dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  submitInput(
    conversationId: number,
    text: string,
    opts?: { origin?: InputOrigin; whenBusy?: WhenBusy; meta?: Record<string, unknown> },
  ): Promise<void>
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  listConversations(filter?: { profileId?: string; tag?: string; status?: ConversationStatus }): ConversationSummary[]
  /** 读取单个会话摘要；不存在时抛 HelmError。 */
  getConversation(id: number): ConversationSummary
  /** 部分更新会话；返回更新后的摘要。 */
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  /**
   * 声明插件对本会话的管理权（如 superagent 的 router/watchdog 会话）：
   * 受管期间会话删除保护（409 conversation_managed_by_plugin），
   * 返回释放函数；插件停用/回滚时宿主自动释放。
   */
  manageConversation(id: number): () => void
  /** 标记会话归属权；'human' 会话严禁自动按键/中止（Watchdog 红线）。 */
  markConversationOwnership(id: number, owner: 'helm' | 'bot' | 'human'): void
  /**
   * 创建 AskDoc 并等待终态：正常三态（answered/cancelled/superseded）均 resolve，
   * 只有验证/I/O/宿主失败才 reject。secret 字段答案为 stash 引用。
   */
  createAsk(spec: AskCreateSpec): Promise<AskResult>
  cancelAsk(askId: string, reason?: 'cancelled' | 'superseded'): Promise<void>
  /** 注册 askId -> 当前 stateChangeSeq 解析器（AskDoc CAS 乐观锁用，可为异步——真实水位需远端 IO）；返回注销函数。 */
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void
  /** 监听工作流 run 终态（completed/failed/aborted，每 run 恰好一次）；插件停用时自动解除。 */
  onWorkflowSettled(listener: (run: WorkflowRunSummary) => MaybePromise<void>): () => void
  emitEvent(type: string, payload: unknown): void
}

// ---------------------------------------------------------------------------
// 唯一插件定义入口
// ---------------------------------------------------------------------------

export interface HelmPluginContext<TConfig = Record<string, unknown>> {
  readonly pluginId: string
  /** 插件专属数据目录（~/.helm/plugins/<id>/）。 */
  readonly dataDir: string
  getConfig(): TConfig

  /** 声明式配置 Schema（secret: true 自动分离至 credentials.json）。 */
  configSchema(schema: Record<string, PluginConfigFieldSchema>): void

  /** 后端 7 大可组合生命周期 Hook。 */
  hook: PluginHookRegistry

  /** 单点 Schema 动作总线（五端复用）。 */
  action<TIn, TOut>(spec: PluginActionSpec<TIn, TOut>): void

  /** 模型专用工具。 */
  tool<TIn>(spec: PluginToolSpec<TIn>): void

  /** Web Standard 原始路由。 */
  route(spec: PluginRouteSpec): void

  /** 持久状态文档；opts.public = true 时进入公共快照与 plugin.doc.updated 事件。 */
  doc<TState>(name: string, initial: TState, opts?: PluginDocOptions): PluginDocHandle<TState>

  /** 后台服务（随插件启停生命周期管理）。 */
  service(spec: PluginServiceSpec): void

  /** 前端 7 大全界面扩展点。 */
  ui: PluginUiRegistry

  /** 宿主运行时能力。 */
  host: HelmHostApi
}

export interface PluginDefinition {
  /** 插件 ID，如 'builtin:assistant'、'builtin:herdr'。 */
  id: string
  name?: string
  version?: string
  /** true 表示常驻不可卸载（builtin:assistant）。 */
  locked?: boolean
  definePlugin(ctx: HelmPluginContext): MaybePromise<void>
}
