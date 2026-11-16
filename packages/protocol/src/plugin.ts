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
  ConversationListFilter,
  ConversationPatch,
  ConversationScope,
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
  NodePathUsage,
  RpcResult,
} from './env-rpc.js'
import type { PluginUiContribution, PluginUiRegistry } from './ui.js'
import type { AgentNamespacedMeta } from './meta.js'
import type {
  ActionManifest,
  AgentExecutionInfo,
  AgentGateResult,
  ExternalTriggerEnvelope,
  GuardedMutationExpectation,
  HookName,
  JsonSchema,
  MaybePromise,
  PluginActionCliSpec,
  PluginConfigFieldSchema,
  PluginDoctorReport,
  PluginInUseItem,
  PluginInstallResult,
  PluginPromptFields,
  PluginRemoveResult,
  PluginSummary,
  PluginUpdateResult,
} from './plugin-dto.js'

export * from './plugin-dto.js'

// ---------------------------------------------------------------------------
// Hook 管道：8 个挂载点（tool_call / tool_result 分列）
// ---------------------------------------------------------------------------

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
  /**
   * 命名空间业务扩展（机制面）：键为声明方插件 ID（如 'builtin:workflow'），
   * 值为该插件私有的 JSON-safe 对象（runId / 派生深度上限等业务字段）。内核
   * 只校验 envelope（JSON-safe、有界、无函数/循环），不解释任何命名空间
   * 内容；各命名空间业务值由其所有方插件在边界用自身 schema 验证（非法
   * 显式拒绝）。改写请求的 agent_spawn continuation 应原样透传未消费的
   * 命名空间。
   */
  meta?: AgentNamespacedMeta
  cwd?: string
  /** 结构化输出 JSON Schema（文件交接时强制落盘校验）。 */
  schema?: JsonSchema
  /** Shell 验收门禁命令；唯一命令来源，宿主不得另行叠加。 */
  gate?: string
  /**
   * 单次门禁命令超时毫秒数（可选，缺省由执行方默认 120_000，上限 600_000）。
   * 原生执行行的 runGate 消费：超时终止整个进程组并按门禁失败如实回传
   * （AgentGateResult.exitCode=null、timedOut=true）；外部运行时（如 herdr）
   * 按自身执行环境解释同一语义。
   */
  gateTimeoutMs?: number
  /** 续接既有子代理的标识。 */
  resume?: string
  /**
   * Optional cross-restart idempotent submission key: passed through by the native execution
   * runner to pi-durable `conversation.submit({ requestId })`, returning the existing durable
   * SubmissionHandle on duplicate submission without appending duplicate input messages.
   */
  requestId?: string
  /**
   * Optional cross-restart in-place reattach target (mutually exclusive with `resume` and
   * `fork`): references a child conversation or external execution handle created before restart
   * so the caller can wait for its in-flight turn to settle and run schema/gate verification.
   */
  reattach?: {
    conversationId?: number
    executionId?: string
    effectiveCwd?: string
  }
  /**
   * 从父会话当前已完成上下文分叉派生原生子会话（可选，缺省 false；与 resume 互斥）。
   * 仅原生 Profile 子会话支持；外部运行时显式拒绝（400 unsupported_runtime）。
   */
  fork?: boolean
  /** 随本次子代理派生传递的产物 ID 列表。 */
  attachments?: string[]
  /**
   * 显式授予外部运行时（如 herdr 窗格）注入的父会话机密环境变量名列表。
   * 缺省不携带任何父会话机密（最小授权；受管 HELM_* 不受影响）；逐名授予，
   * 名字需在父会话 SecretStash 内现存，缺失在 spawn 边界显式拒绝。仅外部
   * 运行时消费：原生子会话工具环境按子会话自身 stash 计算，无法承接本授予——
   * agent_spawn 钩子未接管（无外部运行时）而非空 secretNames 到达原生执行行时
   * 显式拒绝（unsupported_secret_grant），绝不假装子代理已取得机密；空数组
   * 等同未授予。按次授予，resume 不自动沿用。
   */
  secretNames?: string[]
  /** 取消信号，由宿主注入。 */
  signal?: AbortSignal
}

/*
 * 外部执行 steer 委托契约（ExternalSteerRequest / ExternalSteerResult 与
 * 执行控制引用 AgentExecutionControls）属插件层业务，已迁至内置插件包共享
 * 契约模块（packages/plugins/src/contracts.ts；workflow 编排层
 * 与外部执行插件（如 builtin:herdr）共同消费）；protocol 不再出口。
 */

/*
 * 探针契约（WatchdogProbe 等）已移出 protocol 核心，由内置插件包共享契约
 * 模块提供（packages/plugins/src/diagnostics.ts，'diagnostics.collect'
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

export interface PluginActionSpec<TIn, TOut> extends PluginPromptFields {
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

export interface PluginToolSpec<TIn = Record<string, unknown>> extends PluginPromptFields {
  name: string
  description: string
  inputSchema: JsonSchema
  /** 可选的结构化输出 Schema（声明后支持返回 { output, structuredOutput, isError }）。 */
  structuredOutputSchema?: JsonSchema
  /** 会话作用域：工具可见性与 executeTool 的双重过滤条件。 */
  scope?: ConversationScope
  /**
   * Cross-restart replay safety for tool calls (defaults to `'unsafe'`): declare `'safe'`
   * only when the tool implementation guarantees strict durable idempotency per
   * `(conversationId, callId)`. Forwarded by RuntimeToolRegistry to pi-durable `defineTool`.
   */
  replay?: 'safe' | 'unsafe'
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

/** 节点 IPC 机制端口（经内核 EnvFabric 跨节点 Unix Socket / Named Pipe；不静默回退本机）。 */
export interface HelmHostNodeIpcPort {
  /** 节点是否在线（'local' 恒 true）。 */
  isOnline(nodeId: string): boolean
  /** 节点注册时上报的可达 Hub URL（若有）。 */
  getNodeHubUrl?(nodeId: string): string | undefined
  /** 节点注册时上报的可信平台（如 win32 / linux / darwin）；未上报或离线返回 undefined。 */
  nodePlatform?(nodeId: string): string | undefined
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
      /** 仅向现有运行投递；SDK 在接纳输入时原子拒绝已空闲的会话。 */
      whenIdle?: 'reject'
      meta?: Record<string, unknown>
      /** 跨重启幂等提交标识（重复提交同一 requestId 自动跳过）。 */
      requestId?: string
    },
    guard?: GuardedMutationExpectation,
  ): Promise<void>
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  /**
   * 从源会话指定可见条目分叉新会话（与 POST /api/conversations/:id/fork 同源）。
   * 源会话或条目不存在抛 404 not_found；entryId 非安全正整数抛 400 validation_error。
   */
  forkConversation(
    id: number,
    opts: { entryId: number; title?: string },
  ): Promise<ConversationSummary>
  listConversations(filter?: ConversationListFilter): ConversationSummary[]
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
   *
   * 相位自适应（通用取消机制，无专用恢复方法）：
   * - SDK 调度器已运行：SDK Conversation.abort + 等待会话空闲（既有语义）。
   * - 调度器仍处 paused（全局服务 prepare 屏障、resume 之前）：对会话名下
   *   的全部存活 SDK 任务只提交持久 abort 标记（harness.abortTask），不唤醒
   *   调度器、不等待结算——恢复编排（如 workflow 的 prepareRecovery）据此
   *   在调度器启动前持久取消自己登记的中断子会话，且逐个不可逆动作前同步
   *   复核归属（human 一律拒绝）。内核绝不批量取消任意会话：目标会话永远
   *   由调用方逐个显式给出。
   */
  abortConversationGuarded(id: number, guard: GuardedMutationExpectation): Promise<void>
  /** 会话归属权现读（Watchdog 红线判定唯一可信来源；未标记一律 human）。 */
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
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
  /**
   * 全局文本脱敏（SecretStash 明文 -> marker）：诊断/日志出站前、以及插件
   * 持久化自身元数据（如含路径/分支的工作树记录）前统一过此脱敏，防已
   * 登记机密落库（唯一脱敏入口，无并行同名方法）。
   */
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
   * 外部 spawn 环境变量（受管 HELM_* 回连集合；绝不携带宿主 process.env）。
   * 缺省不携带任何父会话 SecretStash 机密（外部窗格最小授权）；仅当显式传
   * secretNames 时逐名注入（需在父会话 stash 内现存，缺失显式抛错）。
   * nodeId 为实际选定目标节点。
   */
  buildSpawnEnv(
    conversationId: number,
    cwd: string,
    nodeId: string,
    options?: { secretNames?: string[] },
  ): Record<string, string>
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
      gateTimeoutMs?: number
    },
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }>
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
  /**
   * 通用 spawn 靶点解析（机制，零业务语义）：按与原生执行行同一权威链
   * 解析源目录与目标节点，并返回父会话 cwd 供插件层在分配资源前解析源目录：
   * - 普通或跨角色 fork：cwd 链 `request.cwd > profile.cwd > 父会话 cwd`，
   *   节点链 `显式 profile.nodeId > 父会话绑定节点 > 'local'`；
   * - 同角色 fork（fork=true 且使用父会话同一 Profile）：cwd 链
   *   `request.cwd > 父会话 cwd > profile.cwd`，节点链 `父会话绑定节点 > profile.nodeId > 'local'`。
   * 链实现由内核唯一提取函数提供（原生子会话派生与本端口同源），插件不得自行复制规则。
   * 返回值是内核权威事实；节点离线校验不在本端口（由 execEnv/gate 各自执行）。
   *
   * 为何按需求值而非预归一化进请求字段：agent_spawn around 链上任一前置
   * 插件可经 next(finalRequest) 改写 cwd/agentType，continuation（如
   * worktree 预分配）必须按改写后的当前请求解析靶点，管道入口快照必然
   * 过期；原生执行行在链收敛后重新走同一权威链（cwd 可能已被改写为隔离
   * 树路径）。且 request.cwd === undefined 承载「走继承链」的显式语义
   * （resume 严格沿用原子会话 cwd，绝不重算），预填即破坏。故本端口是
   * 同一纯函数在链上任意时点的按需求值，不缓存、不驻留请求字段。
   */
  resolveSpawnTarget(input: {
    parentConversationId: number
    /** Profile ID（非 fork 缺省 'assistant'；fork=true 缺省继承父会话 profileId）；Profile 不存在时抛 not_found。 */
    profileId?: string
    /** 显式请求 cwd（优先于 Profile/父会话 cwd）。 */
    requestCwd?: string
    /** 是否按上下文分叉派生规则解析（缺省 false）。 */
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
  /**
   * 当前进程内仍在执行的 spawn 执行事实（通用机制面）：包含每次在途
   * spawnAgent 的 execution 元数据镜像（含插件层回传的 worktree 等扩展字段）。
   * 供插件层判定路径占用（如拒绝清理在途工作树）；已结束的执行不出现。
   */
  listActiveSpawnExecutions(): AgentExecutionInfo[]
  /**
   * 目标节点进程占用快照（删除前诊断面，通用机制、零业务语义）：目标节点
   * 上 cwd 或打开 fd 引用目标绝对路径（含子目录，路径分量边界匹配）的
   * 进程清单（PID/进程名/引用路径；绝不读 cmdline/environ）。快照不完整
   * （权限不足/扫描上限）时 complete=false，调用方必须 fail-closed，绝不
   * 当作 0 占用。节点离线 / 守护进程版本不支持 / 平台不支持均显式 reject
   * （HelmError），绝不静默回退本机扫描。这是诊断快照而非跨进程互斥：
   * 扫描之后新启动的进程不在保护范围；内核也绝不基于此自动终止任何进程。
   * Linux /proc 扫描实现在 @helm/env-io（kernel 与 @helm/node 共享同一实现）。
   */
  inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<NodePathUsage>
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
