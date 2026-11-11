/**
 * PluginHost 唯一强类型插件契约：definePlugin(ctx)。
 * 后端 7 大可组合生命周期 Hook + ctx.action 单点 Schema 五端复用 + 宿主运行时 API。
 * 本文件只定义类型，不含任何运行时；动作合法性（如 tool_call 允许 block、
 * before_turn 只允许原地改写）由 host 在运行时校验。
 */

import type { Provider } from '@earendil-works/pi-ai'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
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

// ---------------------------------------------------------------------------
// 可串行化清单（GET /api/plugins 与 GET /api/actions）
// ---------------------------------------------------------------------------

export interface PluginSummary {
  id: string
  name: string
  /** 插件简短功能描述（来自插件定义，前端直接展示，不做 ID 特判）。 */
  description?: string
  version?: string
  /** 常驻不可卸载（如 builtin:profile）。 */
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
  version?: string
  /** true 表示常驻不可卸载（builtin:profile）。 */
  locked?: boolean
  /**
   * 客户端源根目录（绝对路径，可选）：声明了 client.tsx 组件引用（UiSpecBase.client）
   * 的插件必须提供。宿主只允许 ClientComponentRef.module 解析到该目录内的相对
   * .ts/.tsx 源文件，编译产物按源内容（含本地依赖）hash 缓存；未声明时一切
   * client 引用在注册边界拒绝（不允许无法编译的悬空引用）。由可信插件定义传入，
   * 不属于用户可配置面。
   */
  clientRoot?: string
  /** 插件自带的受控 npm 依赖（内置插件声明；外部插件不支持）：说明符 -> 提供包的解析根。
   * 解析根须为内核包根（含锁定版本的 node_modules）；编译器把声明的说明符解析进
   * bundle 并逐文件 containment 校验，随依赖 hash 与缓存复查。 */
  npmDependencies?: Readonly<Record<string, string>>
  definePlugin(ctx: HelmPluginContext): MaybePromise<void>
}
