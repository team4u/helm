/**
 * PluginHost 唯一强类型插件契约：definePlugin(ctx)。
 * 后端 7 大可组合生命周期 Hook + ctx.action 单点 Schema 五端复用 + 宿主运行时 API。
 * 本文件只定义类型，不含任何运行时；动作合法性（如 tool_call 允许 block、
 * before_turn 只允许原地改写）由 host 在运行时校验。
 */

import type { Provider } from '@earendil-works/pi-ai'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { Duplex } from 'node:stream'
import type { AskCreateSpec, AskResult } from './ask.js'
import type {
  ConversationDetail,
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
import type { ArtifactMetadata } from './artifact.js'
import type { Profile, SkillSummary, ModelProvidersRefreshResult } from './assets.js'
import type {
  EnvExecRequest,
  EnvExecResponse,
  NodeIpcCallInput,
  RpcResult,
} from './env-rpc.js'
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

/** 后端 Hook 挂载点名称唯一真源（与 HookName 类型双向锁定）。 */
export const PLUGIN_HOOK_NAMES = [
  'trigger',
  'input',
  'before_turn',
  'tool_call',
  'tool_result',
  'agent_spawn',
  'turn_settled',
] as const satisfies readonly HookName[]

type _AssertAllHookNamesListed =
  Exclude<HookName, (typeof PLUGIN_HOOK_NAMES)[number]> extends never ? true : never
const _assertAllHookNamesListed: _AssertAllHookNamesListed = true
void _assertAllHookNamesListed

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
  /** 可选定向投递会话；缺省目标由内核按当前 assistant 入口解析。 */
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
 * isolation/worktree 等执行环境要求由插件层经 next(request) 改写最终请求
 * 兑现（内核零 Git 语义，不按业务分支）。
 */
export interface AgentSpawnRequest {
  parentConversationId: number
  /** 发起本次派生的父会话工具调用 ID（可选，供原生子会话登记实时关联）。 */
  parentToolCallId?: string
  prompt: string
  /** 编排宿主分配的稳定调用标识，用于续接与取消。 */
  agentId?: string
  /** Profile ID 或 'herdr:<kind>' 外部运行时标识。 */
  agentType?: string
  model?: string
  effort?: string
  /**
   * 执行环境隔离要求（插件层策略 metadata，如 'worktree'）。
   * 内核不解释该值：由具备对应能力的插件经 agent_spawn continuation 改写
   * 最终请求的 cwd/元数据兑现；无插件兑现而原样到达原生执行行时显式
   * unsupported_runtime（绝不静默忽略）。
   */
  isolation?: string
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
  /** 实际执行节点，由执行方回传；不能从父会话猜测外部插件的目标。 */
  nodeId?: string
  conversationId?: number
  /** 外部运行时内的执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效的工作目录绝对路径。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 时分配的隔离工作树（插件层兑现后回传）。 */
  worktree?: {
    path: string
    branch: string
    /** Helm 受管登记 ID；供 cleanup_worktree 精确定位。 */
    id?: string
    repoRoot?: string
    baseCommit?: string
    dirtySource?: boolean
  }
}

/** gate 命令执行结果；output 为失败时展示给用户的命令输出。 */
export interface AgentGateResult {
  ok: boolean
  output: string
}

/*
 * 探针契约（WatchdogProbe 等）已移出 protocol 核心，由插件侧共享契约模块提供
 *（packages/kernel/src/builtin-plugins/diagnostics.ts，'diagnostics.collect'
 * 内部事件采集）。
 */

/** 每个钩子的完整载荷类型映射。 */
export interface HookPayloadMap {
  trigger: ExternalTriggerEnvelope
  input: InputHookPayload
  before_turn: BeforeTurnHookPayload
  tool_call: ToolCallHookPayload
  tool_result: ToolResultHookPayload
  agent_spawn: AgentSpawnRequest
  turn_settled: TurnSettledPayload
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

/** 同步或异步处理器；返回 void 等价于 continue。
 *
 * agent_spawn 额外提供受控 continuation（第二参数 next）：
 * - 不调用 next 而返回 handled = 完全接管（既有语义不变，如 builtin:herdr）；
 * - await next(finalRequest) = around 包裹：宿主恰好一次执行后续管道与默认
 *   原生执行行（finalRequest 为 transform 后的最终请求）；插件可在 next 前
 *   分配资源、在 next 后按成败收敛（finally 语义）；
 * - next 仅可调用一次：重复调用或与 handled/transform 混用将显式拒绝；
 * - 包裹期间抛错：错误如实上抛（宿主不吞），next 前抛错则后续管道不执行。
 */
export type HookHandler<K extends HookName> = K extends 'agent_spawn'
  ? (
      payload: HookPayloadMap[K],
      next: (request: AgentSpawnRequest) => Promise<unknown>,
    ) => MaybePromise<HookResult<HookPayloadMap[K]> | void> | Promise<unknown>
  : (payload: HookPayloadMap[K]) => MaybePromise<HookResult<HookPayloadMap[K]> | void>

export type TriggerHookHandler = HookHandler<'trigger'>
export type InputHookHandler = HookHandler<'input'>
export type BeforeTurnHookHandler = HookHandler<'before_turn'>
export type ToolCallHookHandler = HookHandler<'tool_call'>
export type ToolResultHookHandler = HookHandler<'tool_result'>
export type AgentSpawnHookHandler = HookHandler<'agent_spawn'>
export type TurnSettledHookHandler = HookHandler<'turn_settled'>

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

export interface PluginActionCliPositionalSpec {
  /** 位置参数写入的 input 字段名。 */
  field: string
  /** 是否必填。 */
  required?: boolean
  /**
   * 若该位置参数在 CLI 本地对应一个存在的文件（或以 ./ ../ / 开头），
   * 自动读取本地文件 UTF-8 文本写入此目标字段（例如 run <file.js> 写入 script），
   * 否则将位置参数字符串写入 field。
   */
  readFileInto?: string
}

export interface PluginActionCliSpec {
  /** 顶层命令路径；缺省为 [去掉 builtin: 的 pluginId, actionId]。 */
  command?: string[]
  /** CLI 帮助文案；缺省沿用 action description。 */
  description?: string
  /** true 时不出现在顶层 `helm <plugin> <action>` 命令中。 */
  hidden?: boolean
  /** 位置参数映射列表（按顺序消费 CLI 位置参数）。 */
  positional?: PluginActionCliPositionalSpec[]
  /** 覆盖 CLI 请求默认超时（毫秒；0 表示无超时，供长耗时动作如 workflow run 使用）。 */
  timeoutMs?: number
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
  /**
   * 该动作是否为幂等/只读操作（默认 false）：
   * - false：中断或失败时账本标记 workflow_action_uncertain，拒绝自动恢复重跑副作用；
   * - true：成功时前缀缓存复用，中断或失败时允许 resumeFromRunId 从该步起安全重跑。
   */
  idempotent?: boolean
  /** 会话作用域：提供 conversationId 的调用（含 run_action/workflow）必须命中才可执行；人工 HTTP/CLI 不受限制。 */
  scope?: ConversationScope
  handler(input: TIn, context: PluginActionContext): MaybePromise<TOut>
}

/** ctx.tool：模型专用工具。 */
export interface PluginToolContext {
  conversationId: number
  /** 当前工具调用 ID（供子会话/工作流绑定 parentToolCallId）。 */
  callId?: string
  signal?: AbortSignal
  /**
   * 流式进度上报（完整 partial 语义，与 SDK ToolExecutionResult 同构）：
   * - output: string | Array<{ type: 'text'; text: string }> —— 至今累计快照
   *   （非增量；宿主对全量脱敏后按差量经 SDK 原生 api.output 转发进 Web
   *   实时工具卡，跨 chunk 拼接的机密不因分片遥漏脱敏）；
   * - isError: true 时提前标记错误态（最终结果仍以 execute 返回为准）；
   * - 结算后的迟到调用静默丢弃；结算前的真实故障显式抛出（不吞）；
   * - 不支持流式的宿主（HTTP 直接调用等）静默丢弃，绝不伪装完成。
   */
  onUpdate?(partial: { output: string | Array<{ type: 'text'; text: string }>; isError?: boolean }): void
}

export interface PluginToolSpec<TIn = Record<string, unknown>> {
  name: string
  description: string
  inputSchema: JsonSchema
  /** 可选的结构化输出 Schema（声明后支持返回 { output, structuredOutput, isError }）。 */
  structuredOutputSchema?: JsonSchema
  /** 会话作用域：工具可见性与 executeTool 的双重过滤条件。 */
  scope?: ConversationScope
  /**
   * 工具使用指引（仅激活工具投射进系统提示词，未激活不产生幻影文本）：
   * - promptSnippet：完整段落文本，原样注入 prompt.tools.<name> 命名 section；
   * - promptGuidelines：要点列表（每项非空字符串），聚合进 prompt.tools.guidelines
   *   共享 section；两者可同时声明；均未声明时仅依赖 provider 原生 tools 声明。
   */
  promptSnippet?: string
  promptGuidelines?: string[]
  execute(input: TIn, context: PluginToolContext): MaybePromise<unknown>
}

// ---------------------------------------------------------------------------
// 持久状态、后台服务与原始路由
// ---------------------------------------------------------------------------

/**
 * 插件自有持久文档句柄（state.sqlite）；get/set/update 同步镜像，
 * flush 等待底层排队写真正落盘完成（失败显式 reject——镜像已写不等于持久化完成，
 * 副作用执行前必须 await flush 防止「未落盘就派生副作用」）。
 */
export interface PluginDocHandle<T> {
  get(): T
  set(value: T): void
  update(fn: (current: T) => T): void
  /** 等待本 store 全部排队写冲刷完成（同一持久化链，无按文档粒度队列）。 */
  flush(): Promise<void>
}

/** 按会话隔离的持久文档；读写深拷贝，生命周期与全局文档相同。 */
export interface PluginSessionDocHandle<TState = unknown> {
  get(conversationId: number): TState
  set(conversationId: number, value: TState): void
  update(conversationId: number, fn: (current: TState) => TState): void
  delete(conversationId: number): void
  listConversationIds(): number[]
  flush(): Promise<void>
}

/** 会话文档不进入全局快照；仅经指定文档的订阅流发布。delete 的 value 为初始值。 */
export interface PublicPluginSessionDoc {
  pluginId: string
  name: string
  conversationId: number
  value: unknown
  deleted?: boolean
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

/** 插件服务声明的静态持久资源占用项（停用前 inUse 预检使用）。 */
export interface PluginInUseItem {
  /** 占用资源类别标识（如 'cron_job'、'webhook_endpoint'、'profile_runtime'、'profile_model'）。 */
  kind: string
  /** 资源唯一标识。 */
  id: string
  /** 面向用户的可读占用说明。 */
  label: string
}

export interface PluginServiceSpec {
  id: string
  /**
   * 预备阶段（全局屏障）：宿主在启动任何服务 start() 之前，先等待全部已启用
   * 服务的 prepare() 完成。用于必须先于调度器唤醒/输入提交的恢复标记
   * （如编排引擎的 prepareRecovery）。热启用同样先 prepare 后 start。
   */
  prepare?(): MaybePromise<void>
  start(): MaybePromise<void>
  /**
   * 停止新回调并等待本服务的在途回调收敛。宿主等待 stop 时允许本插件当前
   * 启用周期的 doc 句柄完成最终写入；stop 返回后句柄失效。此窗口不区分
   * 回调的异步来源，服务必须自行取消或等待残留任务，不能在返回后继续写入。
   */
  stop(): MaybePromise<void>
  /** 返回仍需本服务保活的任务标签；宿主在停用/卸载前同步检查。 */
  liveTasks?(): string[]
  /** 声明本服务当前正在占用的工作树/目录路径（通用机制面：供具备清理或探测能力的消费方拒绝误碰在途占用）。 */
  liveWorktrees?(): Array<{ nodeId: string; path: string }>
  /**
   * 声明本服务当前管辖的持久生效资源（非瞬态运行中任务）。
   * 非空时默认阻止停用（409 plugin_in_use），除非调用方显式指定 force: true。
   * 函数抛错时按「未知即占用」原则拒绝停用，绝不静默当空放行。
   */
  inUse?(): MaybePromise<PluginInUseItem[]>
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

/** 插件自举受管技能资产（ctx.host.skills.ensureSkill 入参；形状与内核 BuiltinSkillAsset 同构）。 */
export interface PluginSkillAsset {
  /** 技能 ID（skills/<id>/ 目录名）。 */
  id: string
  /** SKILL.md 全文（含 frontmatter，managedByPlugin 应指向本插件）。 */
  skillMd: string
  /** references 相对路径 -> 内容。 */
  references: Record<string, string>
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

/** 插件配置字段来源：configured（用户显式持久化覆写）、default（回退 schema.default）、unset（未配置且无 default）。 */
export type PluginConfigFieldSource = 'configured' | 'default' | 'unset'

/** GET /api/plugins/:id/config 响应体。 */
export interface PluginConfigResponse {
  values: Record<string, unknown>
  schema: Record<string, PluginConfigFieldSchema>
  sources?: Record<string, PluginConfigFieldSource>
}

// ---------------------------------------------------------------------------
// 可串行化清单（GET /api/plugins 与 GET /api/actions）
// ---------------------------------------------------------------------------

/** 插件运行状态：active（已启用且正常）、disabled（已停用）、failed（加载或启用失败）。 */
export type PluginStatus = 'active' | 'disabled' | 'failed'

/** 插件加载或启用失败时的结构化诊断信息。 */
export interface PluginDiagnosticError {
  code: string
  message: string
  /** 发生故障的阶段：scan（清单/入口解析）、load（模块导入/契约校验）、define（definePlugin/UI 校验）、enable（Provider 挂载/服务启动）。 */
  stage: 'scan' | 'load' | 'define' | 'enable'
  details?: Record<string, unknown>
}

export interface PluginSummary {
  id: string
  name: string
  /** 插件简短功能描述（来自插件定义，前端直接展示，不做 ID 特判）。 */
  description?: string
  /**
   * 插件线性矢量图标名称（对应 HelmIcon name，可选）。
   * 缺省时前端使用默认图标占位（DEFAULT_PLUGIN_ICON: 'puzzle'）。
   */
  icon?: string
  version?: string
  /** 依赖的其他插件 ID 列表（注册边界去重归一；启用前必须全部已启用）。 */
  dependencies?: string[]
  /** 常驻不可卸载（如 builtin:profile）。 */
  locked: boolean
  enabled: boolean
  /** 插件当前状态：active | disabled | failed。 */
  status?: PluginStatus
  /** 当 status === 'failed' 时携带结构化诊断信息。 */
  error?: PluginDiagnosticError
  hooks: HookName[]
  actions: string[]
  tools: string[]
  /**
   * 受管包安装元数据（additive，可选）：仅当插件来自包安装器
   * （plugins install/update）时存在；手放置入目录的插件缺省。
   * 内置插件（builtin:*）永无该字段。
   */
  managed?: PluginManagedMeta
}

/** 受管插件包元数据（PluginSummary.managed 的形状；additive 可选字段）。 */
export interface PluginManagedMeta {
  /** 安装来源（解析后的规范化形状；含 source 原文回显）。 */
  source: PluginPackageSource
  /** 安装记录 ID（与 PluginPackageRecord.id 一致）。 */
  installId: string
  /** 已安装版本（来自包清单 version；未读到时为空串）。 */
  installedVersion: string
  /** 最近一次安装/更新完成时间（epoch 毫秒）。 */
  installedAt: number
}

/** 单个已注册动作的可串行化清单，供 CLI / Web / Workflow 消费。 */
export interface ActionManifest {
  pluginId: string
  id: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  exposeAsTool?: boolean
  /**
   * 该动作是否为幂等/只读操作（默认 false）：
   * - false：中断或失败时账本标记 workflow_action_uncertain，拒绝自动恢复重跑副作用；
   * - true：成功时前缀缓存复用，中断或失败时允许 resumeFromRunId 从该步起安全重跑。
   */
  idempotent?: boolean
  cli?: PluginActionCliSpec
  scope?: ConversationScope
}

// ---------------------------------------------------------------------------
// 外部插件生态 DX 闭环（doctor / reload / rescan；helm plugins init 为 CLI 本地命令）
// ---------------------------------------------------------------------------

/** doctor 单项检查结果。 */
export interface PluginDoctorCheck {
  /** 检查项标识：manifest / backend / register / client。 */
  id: string
  /** 检查项人类可读标题。 */
  label: string
  /** ok 时省略；失败时为结构化诊断（code / message / details）。 */
  error?: { code: string; message: string; details?: unknown }
}

/** 外部插件源码静态自检报告（POST /api/plugins/doctor）。 */
export interface PluginDoctorReport {
  /** 被检目录的绝对路径（请求方给定或经插件 id 解析后的源目录）。 */
  dir: string
  /** 请求目标：id 模式时为解析出的源目录；path/dir 模式时与 dir 一致。 */
  requestedId?: string
  /** 从目录真实清单/入口推导出的插件 id（未到达定义导出时缺省）。 */
  pluginId?: string
  ok: boolean
  /** 逐项检查结果（按执行顺序）：manifest -> backend -> register -> client。 */
  checks: PluginDoctorCheck[]
  /** doctor 加载真实注册后得到的能力摘要（register 通过时存在）。 */
  summary?: PluginSummary
  /**
   * 真实注册阶段经 ctx.ui.screen 声明并通过原始注册校验的视图 id 列表
   *（register 通过时存在；additive 可选字段）。供上层（如 builtin:apps 的
   * validate/publish）在安装前硬性校验全栈应用至少声明一个 Screen。
   * 只记录真实调用，不做静态扫描或近似推导。
   */
  screens?: string[]
}

/** 受控热重载结果（POST /api/plugins/:id/reload）。 */
export interface PluginReloadResult {
  pluginId: string
  /** 重载前启用状态（重载保持该状态不变）。 */
  wasEnabled: boolean
  /** 本次重载使用的模块代际号（用于诊断，单调递增）。 */
  generation: number
  /** 重载成功后该插件当前清单。 */
  summary: PluginSummary
}

/** 外部插件目录重扫描结果（POST /api/plugins/rescan）。 */
export interface PluginRescanResult {
  /** 本次扫描注册成功的外部插件 id（默认 disabled）。 */
  registered: string[]
  /** 扫描到的纯数据目录 / 已注册插件目录被跳过的数量（诊断用）。 */
  skipped: number
  /** 全部插件当前清单。 */
  plugins: PluginSummary[]
}

// ---------------------------------------------------------------------------
// 外部插件包管理（source grammar / 安装记录 / install / update / remove）
// 仅可串行化类型；具体解析器（source 字符串 -> 规范化形状）与安装执行由
// kernel 实现，protocol 不携带运行时。
// ---------------------------------------------------------------------------

/** npm 注册表来源：`npm:<spec>`（spec 为任意合法 npm 依赖说明符）。 */
export interface PluginSourceNpm {
  kind: 'npm'
  /** 原始 source 字符串（规范回显，如 `npm:helm-plugin-foo@^1.2.0`）。 */
  raw: string
  /** npm 依赖说明符（去 `npm:` 前缀后的部分，如 `helm-plugin-foo@^1.2.0`）。 */
  spec: string
}

/** Git 来源：`git:<repo>@<ref>` 或 HTTPS Git URL（`https://...git[#<ref>]`）。 */
export interface PluginSourceGit {
  kind: 'git'
  /** 原始 source 字符串（规范回显）。 */
  raw: string
  /** Git 仓库地址（如 `https://github.com/user/helm-plugin-foo.git` 或 `git@host:path` 形式的 repo 部分）。 */
  repo: string
  /** 检出的 Git ref（分支/Tag/Commit；缺省由安装器决定，通常仓库默认分支）。 */
  ref?: string
  /** 仓库内子目录（monorepo 布局；缺省为仓库根）。 */
  subdirectory?: string
}

/** 本地路径来源：绝对路径或相对 Hub cwd / 插件根目录的相对路径。 */
export interface PluginSourceLocal {
  kind: 'local'
  /** 原始 source 字符串（规范回显，保留用户写法）。 */
  raw: string
  /** 解析后的绝对路径（安装器规范化；Windows 亦为绝对路径）。 */
  path: string
}

/** 规范化插件包来源（判别联合，kind 判别）。 */
export type PluginPackageSource = PluginSourceNpm | PluginSourceGit | PluginSourceLocal

/** 受管插件包安装记录（持久化于安装器私有存储；非全局首帧/SSE 广播载荷）。 */
export interface PluginPackageRecord {
  /** 安装记录 ID（幂等稳定标识；同一插件重复 install 复用原 ID 更新记录）。 */
  id: string
  /** 安装目标插件 id（包清单声明；如 `my-plugin`）。 */
  pluginId: string
  /** 规范化安装来源。 */
  source: PluginPackageSource
  /** 安装目标磁盘绝对路径（<dataDir>/plugins/<pluginId>）。 */
  installPath: string
  /** 包清单声明版本；未读到时为空串（不虚构）。 */
  version: string
  /** 首次安装完成时间（epoch 毫秒）。 */
  installedAt: number
  /** 最近一次更新完成时间（epoch 毫秒）；从未更新时与 installedAt 相同。 */
  updatedAt: number
  /** 启用状态由插件系统自身管理，不在此记录（避免双源）。 */
}

/** 安装结果（POST /api/plugins/install）。 */
export interface PluginInstallResult {
  /** 安装记录（已持久化）。 */
  record: PluginPackageRecord
  /** 安装后插件当前清单（安装即注册，默认停用，与 rescan 同语义）。 */
  summary: PluginSummary
  /**
   * enable: true 但启用失败时的结构化诊断（additive 可选）：安装与记录
   * 已成功保留（不回滚），启用失败原因如实透出供调用方重试 enable。
   */
  enableError?: { code: string; message: string }
}

/** 更新结果（POST /api/plugins/:id/update）。 */
export interface PluginUpdateResult {
  /** 更新后的安装记录（version / updatedAt 已推进）。 */
  record: PluginPackageRecord
  /** 更新并重载（或重新注册）后的插件清单。 */
  summary: PluginSummary
  /** 本次更新是否实际变更（源未变化时 false，幂等语义如实回报）。 */
  changed: boolean
  /** 更新前版本（诊断用；未读到时为空串）。 */
  previousVersion: string
}

/** 移除结果（POST /api/plugins/:id/remove）。 */
export interface PluginRemoveResult {
  /** 被移除的插件 id。 */
  pluginId: string
  /** 被清理的安装目录绝对路径。 */
  installPath: string
  /** 移除前是否处于启用状态（启用中移除需先停用；此处回显事实）。 */
  wasEnabled: boolean
  /** 移除的安装记录 ID。 */
  installId: string
}

// ---------------------------------------------------------------------------
// 宿主运行时能力
// ---------------------------------------------------------------------------

/** 插件可用的 Profile 数据端口（类型化只读 + 托管写入；服务机制仍在内核）。 */
export interface HelmHostProfilesPort {
  /** 全部 Profile（不含 system 全文）。 */
  list(): Promise<Profile[]>
  /** 单个 Profile；不存在时返回 undefined。id 非法时抛 HelmError。 */
  get(id: string): Promise<Profile | undefined>
  /** 读取 Profile 的 SYSTEM.md 全文；缺失抛 FileNotFoundError 语义（HelmError not_found）。 */
  getSystem(id: string): Promise<string>
  /**
   * 新建或整体保存 Profile（携带 system 时原子同步至 SYSTEM.md）。
   * 供插件自举托管元数据（managedByPlugin）；常规管理仍走 HTTP/CLI。
   */
  save(profile: Profile): Promise<Profile>
  /**
   * Profile 资产目录的真实磁盘绝对路径（仅 id 边界校验 + 坐标返回；目录可能
   * 尚不存在——首次初始化（如 MEMORY.md）由调用方自行创建，宿主不 mkdir）。
   * 供插件管理同目录自有资产文件，不做 ../.. 相对逃逸。
   */
  directory(id: string): Promise<string>
}

/** 插件自举的技能包资产（SKILL.md + references 子文件内容；与 kernel services 同形）。 */
/** 插件可用的技能数据端口（读 + 受管自举）。 */
export interface HelmHostSkillsPort {
  /** 全部技能摘要（含 references 相对路径）。 */
  list(): Promise<SkillSummary[]>
  /** 读取技能内相对路径文件（SKILL.md / references/...）；穿越/绝对路径/软链均拒绝。 */
  readFile(skillId: string, path?: string): Promise<string>
  /**
   * 技能目录的磁盘绝对路径（仅 id 边界校验 + 坐标返回；目录可能尚不存在，
   * 宿主不 mkdir；调用方自管逐文件幂等补齐，不覆盖用户资产）。
   */
  directory(id: string): Promise<string>
  /**
   * 受管自举技能包：以声明版本为准逐文件覆盖，缺失补齐；登记受管后常规
   * 写入口统一 403。边界非法（id/相对路径）整体拒绝，不产生部分文件。
   * 通用受管资产安装机制，内外插件同权。
   */
  ensureSkill(asset: PluginSkillAsset): Promise<void>
}

/**
 * 插件私有 secrets（绑定 pluginId 命名空间）：持久化于 credentials.json
 * pluginSecrets.<pluginId>（恒 0600），明文绝不进入公共文档、事件或模型上下文。
 */
export interface HelmHostSecretsPort {
  /** 读取（不存在返回 undefined）。 */
  get(key: string): Promise<string | undefined>
  /** 写入（空值拒绝）；成功后可逃逸的旧值（若有）仍保留脱敏。 */
  set(key: string, value: string): Promise<void>
  /** 幂等删除。 */
  delete(key: string): Promise<void>
  /** 登记全局逐值脱敏（明文出现在任何日志/事件/文档中自动替换 [REDACTED]）；返回解除函数。 */
  addRedaction(value: string): () => void
}

/** 会话活动事实（Watchdog 探针口径；仅真实活动计数，不猜测）。 */
export interface ConversationActivity {
  /** 无在途 run 时缺省（空闲非停滞）；有 run 且有活动记录时为距今毫秒数。 */
  stalledMs?: number
  /** 连续回合失败次数（无失败为 0）。 */
  consecutiveErrors: number
}

/**
 * 自动化变更守卫期望（guarded mutation）：调用方携带授权时点的事实
 * （探针 ownedBy / stateChangeSeq），内核在会话串行域内、于第一个不可逆
 * 动作（SDK abort/submit 调用）之前同步复核；复核失败抛 409/404 且绝不
 * 执行变更（Watchdog human-owned 红线的内核执行层兑现）。
 */
export interface GuardedMutationExpectation {
  /**
   * 授权时点的归属（探针事实）。内核硬性要求当前归属属自动化域
   * （'bot' | 'helm'，'human' 永远拒绝）；提供具体值时进一步要求当前
   * 归属与之精确相符（bot/helm 间移交视为新事实，保守拒绝）。
   */
  expectedOwnership?: 'bot' | 'helm'
  /** 授权时点的权威水位（stateChangeSeq）；提供时当前值必须相等（CAS）。 */
  expectedStateSeq?: number
}

/** 节点 IPC 机制端口（经内核 EnvFabric 跨节点 Unix Socket / Named Pipe；不静默回退本机）。 */
export interface HelmHostNodeIpcPort {
  /** 节点是否在线（'local' 恒 true）。 */
  isOnline(nodeId: string): boolean
  /** 节点注册时上报的可达 Hub URL（若有）。 */
  getNodeHubUrl?(nodeId: string): string | undefined
  /** 单次行协议 IPC 调用；节点不支持或离线时显式报错。 */
  call(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RpcResult<string>>
  /** 流式行协议 IPC 订阅；返回停止函数。节点不支持时抛错。 */
  subscribe(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string },
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
}

/**
 * 节点本机 HTTP fetch 端口（EnvFabric.nodeFetch 的插件面）：local 返回
 * globalThis.fetch；远端支持任意 host 与 http/https，经节点透传隧道转发，
 * 绝不回退 local。每次调用的返回函数均已纳入插件在途任务跟踪与周期
 * 守卫（新流在停用/停止窗口拒绝）。
 */
export interface HelmHostNodeFetchPort {
  /** 取目标节点的 fetch（可直接调用：fetch(input, init)）。 */
  (nodeId: string): typeof fetch
}

/**
 * 节点透传隧道端口（EnvFabric.openTunnel 的插件面）：建立到目标节点
 * host:port 的任意 TCP Duplex（进程内调用获得原始双工流）。生命周期
 * 受插件在途任务跟踪：建立计入在途任务；返回的 Duplex 关闭（close/error/
 * destroy）即结束任务——插件停用预检可见活动隧道，停用/宿主 dispose 时
 * 统一销毁不泄漏。
 */
export interface HelmHostOpenTunnelPort {
  /** 建立任意 TCP 隧道；host 缺省 127.0.0.1（由目标节点解析连接）。 */
  (nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal): Promise<Duplex>
}

/**
 * 宿主后端的插件治理端口（PluginHostBackend.plugins 的形状；类型层上拆窄：
 * 只读入口复用 HelmHostApi 既有 listPlugins/listUi 成员；写面聚合在
 * doctorPlugin/installPlugin/updatePlugin/removePlugin/enablePlugin/disablePlugin
 * 六个与 PluginHost 公共方法同语义的后端成员）。宿主可整体不接线
 * （undefined：轻量测试宿主），接线后修改操作沿用宿主现有生命周期队列、
 * 在途任务跟踪与 locked/在途保护，不引入第二套包管理器。
 */
export interface BackendPluginsLifecyclePort {
  /** 四阶段静态自检（目录绝对路径或已注册外部插件 id 择一；与 POST /api/plugins/doctor 同链）。 */
  doctorPlugin(target: { dir?: string; id?: string }): Promise<PluginDoctorReport>
  /** 受管安装（npm/git/local source；默认 disabled，enable: true 安装后启用）。 */
  installPlugin(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult>
  /** 受管更新（重取 source + doctor 预检 + 原子热重载，保持启用状态）。 */
  updatePlugin(pluginId: string): Promise<PluginUpdateResult>
  /** 受管卸载（内置 403 / 在途任务 409 / 持久占用非 force 409）。 */
  removePlugin(pluginId: string): Promise<PluginRemoveResult>
  /** 启用已注册插件；返回启用后清单。 */
  enablePlugin(pluginId: string): Promise<PluginSummary>
  /** 停用已注册插件（locked 403 / 在途任务 409 / 持久占用非 force 409）；返回停用后清单。 */
  disablePlugin(pluginId: string, options?: { force?: boolean }): Promise<PluginSummary>
}

/**
 * 插件可用的宿主插件治理端口（ctx.host.plugins）：读面与 ctx.host.listPlugins/
 * listUi 同源；写面为受管包生命周期。所有异步修改操作计入调用方插件的
 * 在途任务跟踪（停用预检可见）；结构化结果出站前经宿主统一脱敏，
 * 不把机密或源码内容无界带出。
 */
export interface HelmHostPluginsPort {
  /** 当前全部已注册插件摘要（与 listPlugins() 同源；只读快照）。 */
  list(): PluginSummary[]
  /** 当前全部已启用插件的 UI 贡献清单（与 listUi() 同源；只读快照）。 */
  listUi(): PluginUiContribution[]
  /** 静态自检：dir 为目录绝对路径，或 id 指向已注册外部插件（择一）；register 通过时报告携带 screens（真实 ctx.ui.screen 声明的视图 id）。 */
  doctor(target: { dir?: string; id?: string }): Promise<PluginDoctorReport>
  /** 受管安装外部插件包；enable: true 时安装后立即启用。 */
  install(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult>
  /** 受管更新（保持启用状态与已有 ctx.doc 数据）。 */
  update(pluginId: string): Promise<PluginUpdateResult>
  /** 受管卸载（内置插件 403，在途任务 409）。 */
  remove(pluginId: string): Promise<PluginRemoveResult>
  /** 启用已注册插件；返回启用后清单。 */
  enable(pluginId: string): Promise<PluginSummary>
  /** 停用已注册插件（locked 403，在途任务 409，持久占用非 force 409）。 */
  disable(pluginId: string, options?: { force?: boolean }): Promise<PluginSummary>
}

/** ctx.host：插件可调用的宿主内核能力（插件拿到的实现已绑定其 pluginId，不可伪造他人身份）。 */
export interface HelmHostApi {
  /** 宿主关闭状态（get）：true 后拒绝新回合/新后台任务，插件据此停投递。 */
  readonly isClosing: boolean
  /** Profile 数据端口（读 + system 读取；写入仍经 HTTP/CLI 管理面）。 */
  readonly profiles: HelmHostProfilesPort
  /** 技能数据端口（读 + 受管自举 ensureSkill）。 */
  readonly skills: HelmHostSkillsPort
  /** 插件私有 secrets（pluginId 命名空间；不进文档/事件/模型上下文）。 */
  readonly secrets: HelmHostSecretsPort
  /** 跨节点 IPC 机制端口（EnvFabric；herdr 等外部运行时桥接用）。 */
  readonly nodeIpc: HelmHostNodeIpcPort
  /**
   * 节点 HTTP(S) fetch 适配层（基于 openTunnel；任意 host 的 http/https，
   * 模型/插件经此访问目标节点视角的服务）。未接线时调用显式报 501，
   * 绝不回退 local。
   */
  readonly nodeFetch: HelmHostNodeFetchPort
  /**
   * 任意 TCP 透传隧道（进程内调用获得原始 Duplex）：local 进程内直连；
   * 远端复用既有节点隧道传输。未接线时调用显式报 501，绝不回退 local。
   * 活动隧道纳入插件在途任务跟踪（停用预检可见；停用/dispose 不泄漏）。
   */
  readonly openTunnel: HelmHostOpenTunnelPort
  /**
   * 宿主插件治理端口（受管包生命周期；编排插件如 builtin:apps 消费）。
   * 后端未接线包管理器时 doctor/install/update/remove 显式 501；
   * 自指 update/remove/disable 一律 409 拒绝（防生命周期队列自等待）。
   */
  readonly plugins: HelmHostPluginsPort
  /**
   * 更新本插件自身配置（不可改其他插件）：与 HTTP PUT /api/plugins/:id/config
   * 同一校验与持久化链（configSchema 边界校验；secret 字段落 credentials.json）。
   * 值为增量合并（未提供字段保留现值）；未知字段拒绝。
   */
  setConfig(patch: Record<string, unknown>): Promise<void>
  dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  submitInput(
    conversationId: number,
    text: string,
    /** whenBusy 省略时内核默认 steer（插话引导）；批处理投递请显式 followUp。 */
    opts?: {
      origin?: InputOrigin
      whenBusy?: WhenBusy
      meta?: Record<string, unknown>
      /** 跨重启幂等提交标识（重复提交同一 requestId 自动跳过）。 */
      requestId?: string
      /** 从指定历史条目起原地覆盖重发（截断该条及后续上下文后写入新输入）。 */
      replaceFromEntryId?: number
    },
  ): Promise<void>
  /**
   * 自动化 guarded 提交（Watchdog 红线内核执行层）：全部准备工作（input 钩子、
   * 模型解析、附件授权）完成后，在提交点（SDK submit 调用前、最后一个 await
   * 之后）同步复核会话存在性、归属（严禁 human）与可选 CAS 水位；复核失败
   * 抛 404/409 且不产生提交副作用（input 钩子可能已观察过输入文本，与普通
   * 拒绝路径同口径）。不支持 replaceFromEntryId（自动化不重写历史）。guard
   * 缺省时仅强制 human 红线（归属属自动化域）。
   */
  submitInputGuarded(
    conversationId: number,
    text: string,
    opts?: {
      origin?: InputOrigin
      whenBusy?: WhenBusy
      meta?: Record<string, unknown>
      /** 跨重启幂等提交标识（重复提交同一 requestId 自动跳过）。 */
      requestId?: string
    },
    guard?: GuardedMutationExpectation,
  ): Promise<void>
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  listConversations(filter?: { profileId?: string; tag?: string; status?: ConversationStatus }): ConversationSummary[]
  /** 读取单个会话摘要；不存在时抛 HelmError。 */
  getConversation(id: number): ConversationSummary
  /** 会话详情（时间线条目 + 元数据；limit 1..500，cursor 分页）。 */
  getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail>
  /** 部分更新会话；返回更新后的摘要。 */
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  /** 中止指定会话的在途执行。 */
  abortConversation(id: number): Promise<void>
  /**
   * 自动化 guarded 中止（Watchdog 红线内核执行层）：在会话串行域内、于
   * 第一个不可逆动作（SDK abort 调用）前同步复核会话存在性、归属（严禁
   * human）与可选 CAS 水位；复核失败抛 404 not_found / 409 ownership_conflict
   * / 409 state_seq_conflict 且绝不发起中止。
   */
  abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void>
  /** 会话归属权现读（Watchdog 红线判定唯一可信来源；未标记一律 human）。 */
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
  /** 会话活动事实（stalledMs / consecutiveErrors；探针口径）。 */
  getConversationActivity(id: number): ConversationActivity
  /** 列出会话产物元数据（本会话全部；明文内容不进返回值）。 */
  listArtifacts(conversationId: number): Promise<ArtifactMetadata[]>
  /**
   * 授权读取单个产物（存在 + 属于会话或父链；越权 403、不存在 404）：
   * 返回轻量元数据 + 绝对路径（内容读取由调用方在目标节点执行）。
   */
  getArtifact(
    artifactId: string,
    conversationId: number,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }>
  /** 全局文本脱敏（SecretStash 明文 -> marker；诊断/日志出站前用）。 */
  redact(text: string): string
  /**
   * 通用无工具单次文本补全（机制，无业务策略）：按会话解析生效模型
   * （会话覆盖 > profile.model > 全局），输入输出均过全局脱敏；
   * stopReason 非成功终态显式拒绝，不返回部分文本。
   */
  completeText(input: {
    conversationId: number
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string>
  /**
   * 在目标节点获取无会话作用域执行环境（短生命周期对象，用后即弃，绝不缓存）：
   * local 进程内直建；远端经 RPC；未知节点返回 Remote env（操作时等待重连），
   * 绝不回落 local。返回 SDK ExecutionEnv 类型（type-only 引自
   * @earendil-works/pi-durable/env，protocol 零运行时重依赖）；宿主 wrapper
   * 为受控代理（方法调用过 assertContextUsable + task 跟踪，停用后旧句柄失效）。
   */
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  /**
   * 按 realpath 的文件锁：同一 Hub 进程内同一路径（含不同相对写法）全局互斥，
   * 闭包执行全窗持锁（停用预检可见在途任务；停用/重启用后旧周期闭包内续用
   * 会被 epoch 守卫拒绝）。仅承诺本 Hub 进程内串行（不含跨进程协议）。
   * 通用文件机制，不注入任何插件业务语义。
   */
  withFileLock<T>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>
  /** 原子写文件（临时文件 + rename；通用机制，失败显式拒绝）。 */
  atomicWriteFile(path: string, content: string): Promise<void>
  /**
   * 外部 spawn 环境变量（目标节点受管回连集合：stash + 受管 HELM_*）；
   * nodeId 为实际选定目标节点；绝不携带宿主 process.env。
   */
  buildSpawnEnv(conversationId: number, cwd: string, nodeId: string): Record<string, string>
  /**
   * 声明插件对本会话的管理权（如 superagent 的 router/watchdog 会话）：
   * 受管期间会话删除保护（409 conversation_managed_by_plugin），
   * 返回释放函数；插件停用/回滚时宿主自动释放。
   */
  manageConversation(id: number): () => void
  /** 标记会话归属权；'human' 会话严禁自动按键/中止（Watchdog 红线）。 */
  markConversationOwnership(id: number, owner: 'helm' | 'bot' | 'human'): void
  /** 派生或续接子代理（经过 agent_spawn Hook 管道 + 原生子会话底座）。 */
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /** 在目标节点/会话工作目录执行验证门禁命令。 */
  runGate(
    command: string,
    options?: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
    },
  ): Promise<{ ok: boolean; output: string }>
  /**
   * 经内核 EnvFabric 跨节点执行命令（复用 local / 远端 @helm/node 通道、SecretStash 注入与脱敏）。
   * 靶点解析优先级：显式 nodeId/cwd > conversationId 绑定 (nodeId, cwd) > 'local'/Hub cwd。
   * 远端节点离线时显式抛 409 node_offline，绝不静默回退本机。
   */
  execEnv(
    req: Omit<EnvExecRequest, 'stream'>,
    opts?: { signal?: AbortSignal },
  ): Promise<EnvExecResponse>
  /**
   * 文件互斥队列（宿主节点通道）：在目标节点 (nodeId, cwd) 内按 canonical 路径
   * 串行执行 fn（读-改-写窗口整体持锁），与内核 write/edit 工具共享同一进程级
   * 队列——同一文件不丢更新；其他文件、其他节点互不等待。锁语义与 pi-durable
   * 的 withFileMutationQueue 对齐：不是对 bash 或其他进程的锁；不可重入
   * （fn 内嵌套对同一文件入队立即显式报错，绝不静默挂死）。
   * 必选能力：后端必须实现（测试 fixture 可显式 throw 不支持）。
   */
  withFileMutationQueue<T>(
    target: { nodeId: string; cwd: string; path: string },
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>
  /**
   * 动作前置校验（与 invokeAction 同源的 prepare/preflight）：校验插件状态、
   * 会话 scope 与 inputSchema（无 handler 副作用），并返回定义端 idempotent。
   * 供编排引擎在落盘 action_started 前判定副作用语义；不能仅以 listActions
   * 清单冒充。
   */
  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): { idempotent: boolean }
  /** 重启恢复前持久标记中断的子会话任务取消（必须在调度器恢复前调用）。 */
  prepareInterruptedConversations(ids: number[]): Promise<void>
  /**
   * 通用 spawn 靶点解析（机制，零业务语义）：按与原生执行行同构的链
   * 「request.cwd > profile.cwd > 父会话 cwd」解析源目录，「显式
   * profile.nodeId > 父会话绑定节点 > 'local'」解析实际执行节点，并返回
   * 父会话 cwd 供插件层在分配资源前解析源目录。
   * 返回值是内核权威事实；节点离线校验不在本端口（由 execEnv/gate 各自执行）。
   */
  resolveSpawnTarget(input: {
    parentConversationId: number
    /** Profile ID（缺省 'assistant'）；Profile 不存在时抛 not_found。 */
    profileId?: string
    /** 显式请求 cwd（优先于 Profile cwd）。 */
    requestCwd?: string
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
  /**
   * 当前进程内仍在执行的 spawn 执行事实（通用机制面）：包含每次在途
   * spawnAgent 的 execution 元数据镜像（含插件层回传的 worktree 等扩展字段）。
   * 供插件层判定路径占用（如拒绝清理在途工作树）；已结束的执行不出现。
   */
  listActiveSpawnExecutions(): AgentExecutionInfo[]
  /**
   * 目标节点真实 fs 探测（通用机制面，零业务语义）：exists / canonicalPath
   * 经内核 EnvFabric 在目标节点真实执行。探测失败（节点离线/权限/超时）
   * 如实 reject（HelmError），绝不编造结果；返回 value 为 boolean（exists）
   * 或绝对路径字符串（canonicalPath）。
   */
  probeNodeFs(input: {
    nodeId: string
    op: 'exists' | 'canonicalPath'
    path: string
    signal?: AbortSignal
  }): Promise<{ value: string | boolean }>
  /**
   * 宿主统一文本脱敏（SecretStash：明文机密 -> 标记）：插件持久化自身
   * 元数据（如含路径/分支的工作树记录）前过此脱敏，防已登记机密落库。
   */
  redactText(text: string): string
  /** 调用任意已启用插件的动作（输出已经过 JSON 校验与宿主统一脱敏）。 */
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): Promise<unknown>
  /** 列出当前全部已启用插件的动作清单。 */
  listActions(): ActionManifest[]
  /** 当前插件清单（含启停状态；只读快照）。 */
  listPlugins(): PluginSummary[]
  /** 当前全部 UI 贡献清单（仅已启用插件；只读快照，供 Profile 目录 runtime 声明事实）。 */
  listUi(): PluginUiContribution[]
  /**
   * 刷新动态模型目录（与 POST /api/models/refresh 同链路；options 现有形状）。
   * 供 provider 插件触发自身目录刷新；错误以 result.errors 返回（不 reject）。
   */
  refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult>
  /**
   * 创建 AskDoc 并等待终态：正常三态（answered/cancelled/superseded）均 resolve，
   * 只有验证/I/O/宿主失败才 reject。secret 字段答案为 stash 引用。
   */
  createAsk(spec: AskCreateSpec): Promise<AskResult>
  cancelAsk(askId: string, reason?: 'cancelled' | 'superseded'): Promise<void>
  /** 注册 askId -> 当前 stateChangeSeq 解析器（AskDoc CAS 乐观锁用，可为异步——真实水位需远端 IO）；返回注销函数。 */
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void
  /** 订阅宿主通用事件（真实 EventHub 广播事件与 broadcast:false 进程内事件；
   * 含 'conversation.entry' 等 core 事件，payload 为 HelmEvent 形状）；
   * 插件停用时自动解除。监听器可异步，发布方会等待其完成。 */
  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void
  /** 发布事件并等待内部监听器；broadcast:false 仅在进程内分发，不进入全局 SSE。 */
  emitEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void>
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

  /** 按会话隔离的文档，不进入全局首帧或全局 SSE；文档名不得与 doc 重复。 */
  sessionDoc<TState>(name: string, initial: TState, opts?: PluginDocOptions): PluginSessionDocHandle<TState>

  /** 后台服务（随插件启停生命周期管理）。 */
  service(spec: PluginServiceSpec): void

  /**
   * 声明插件自带的模型 Provider，随插件启停自动挂载/卸载：
   * - 仅在 definePlugin 执行期间声明；边界校验 id/name/auth/getModels/stream/
   *   streamSimple 最小形状，重复 id 拒绝；
   * - 默认停用探测（register enabled:false）只收集声明不挂载，configSchema 照常可用；
   * - 启用时在服务 start 前依次挂载，停用/卸载时在服务 stop 后逆序卸载；
   * - 宿主未提供 providers 挂载端口时，声明了 provider 的插件在启用阶段显式
   *   失败（501），绝不静默丢弃或假装挂载。
   * Provider 类型来自 @earendil-works/pi-ai（type-only，protocol 零运行时新增依赖）。
   */
  provider(provider: Provider): void

  /** 前端 7 大全界面扩展点。 */
  ui: PluginUiRegistry

  /** 宿主运行时能力。 */
  host: HelmHostApi
}

export interface PluginDefinition {
  /** 插件 ID，如 'builtin:profile'、'builtin:herdr'。 */
  id: string
  name?: string
  /** 插件简短功能描述：面向插件中心卡片与 CLI 列表展示，一句话说明职责边界。 */
  description?: string
  /**
   * 插件线性矢量图标名称（对应 HelmIcon name，可选）。
   * 缺省时使用默认图标占位。
   */
  icon?: string
  version?: string
  /** true 表示常驻不可卸载（builtin:profile）。 */
  locked?: boolean
  /**
   * 插件间依赖契约：依赖的其他插件 ID 列表（仅 ID，不做版本解析）。
   * - 注册边界校验形状（非空字符串、插件 id 字符集）并按声明序去重；
   * - 启用（含注册即启用）时逐项校验：依赖必须已注册且已启用（仅注册未启用的
   *   依赖不满足），否则 409 plugin_dependency_missing / plugin_dependency_not_enabled；
   * - 依赖图出现环路（含自依赖）在注册边界显式 409 plugin_dependency_cycle；
   * - 全局服务启动屏障按依赖拓扑序 prepare/start（同层保持注册序），
   *   stop/dispose 按逆拓扑序。
   */
  dependencies?: ReadonlyArray<string>
  /**
   * 客户端源根目录（绝对路径，可选）：声明了 client.tsx 组件引用（UiSpecBase.client）
   * 的插件必须提供。宿主只允许 ClientComponentRef.module 解析到该目录内的相对
   * .ts/.tsx 源文件，编译产物按源内容（含本地依赖）hash 缓存；未声明时一切
   * client 引用在注册边界拒绝（不允许无法编译的悬空引用）。由可信插件定义传入，
   * 不属于用户可配置面。
   */
  clientRoot?: string
  /** 插件自带的受控 npm 依赖（说明符 -> 提供包的解析根）：解析根须为内核包根
   * （含锁定版本的 node_modules，内置插件声明）或外部插件自身目录（由清单
   * helm.clientDependencies / plugin.json clientDependencies 归一映射产生，见
   * external-loader normalizeDefinition——外部插件不得在代码内自指解析根）。
   * 编译器把声明的说明符解析进 bundle 并逐文件 containment 校验，随依赖
   * hash 与缓存复查。 */
  npmDependencies?: Readonly<Record<string, string>>
  definePlugin(ctx: HelmPluginContext): MaybePromise<void>
}
