/**
 * HTTP 层依赖的内核运行时契约（结构化类型）。
 *
 * 各服务由并行代理实现且已就位（services/*）；本文件约束 HTTP 消费的形状。
 * KernelRuntime 实例传入时结构化兼容即可（ structural typing ）。
 */
import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  ConversationInit,
  ConversationPatch,
  ConversationStatus,
  ConversationSummary,
  HelmEventType,
  PluginConfigFieldSchema,
  PluginSummary,
  ProviderConfig,
  SkillSummary,
  WorkflowRunRequest,
  WorkflowRunSummary,
  Profile,
} from '@helm/protocol'
import type {
  AuthService as RealAuthService,
  ArtifactService as RealArtifactService,
  CredentialService as RealCredentialService,
  ProfileService as RealProfileService,
  ProviderService as RealProviderService,
  SkillService as RealSkillService,
} from '../services/index.js'

export type { RealAuthService }
export type {
  RealArtifactService,
  RealCredentialService,
  RealProfileService,
  RealProviderService,
  RealSkillService,
}

// 重新导出真实服务类型供 HTTP 消费方使用
export type AuthService = RealAuthService
export type ArtifactService = RealArtifactService
export type CredentialService = RealCredentialService
export type ProfileService = RealProfileService
export type ProviderService = RealProviderService
export type SkillService = RealSkillService

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HelmEventEnvelope {
  type: HelmEventType | string
  payload: unknown
}

/** 全局事件枢纽（kernel.events）。 */
export interface EventHub {
  /** 订阅事件流；返回取消订阅函数。 */
  subscribe(listener: (event: HelmEventEnvelope) => void): () => void
  /**
   * SSE 响应：立即返回 Response（流式），客户端断开（request.signal abort）
   * 自动取消订阅。runtime 提供；HTTP 层仅透传。
   */
  response(request: Request): Response
  /** 快照单帧响应（事件管道不可用时的兜底）。 */
  snapshotResponse(): Response
  publish(type: HelmEventType | string, payload: unknown): void
}

// ---------------------------------------------------------------------------
// Models / Plugins / KernelRuntime
// ---------------------------------------------------------------------------

export interface ModelService {
  list(): Promise<unknown[]> | unknown[]
}

export interface PluginRouteInfo {
  pluginId: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 插件声明的相对 path（如 'webhook/:id'）；实际挂载命名空间由 HTTP 层强制。 */
  path: string
  public?: boolean
  handler(req: Request): Response | Promise<Response>
}

export interface PluginHost {
  list(): PluginSummary[] | Promise<PluginSummary[]>
  enable(id: string): Promise<void> | void
  disable(id: string): Promise<void> | void
  listActions(): ActionManifest[] | Promise<ActionManifest[]>
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number },
  ): Promise<unknown> | unknown
  /** raw 配置（可能含 secret 明文）；HTTP 输出前必须按 schema 脱敏。 */
  getConfig(id: string): Record<string, unknown> | Promise<Record<string, unknown>>
  /** 声明式配置 schema（含 secret 标记，供 HTTP 脱敏）。 */
  getConfigSchema(id: string): Record<string, PluginConfigFieldSchema> | Promise<Record<string, PluginConfigFieldSchema>>
  setConfig(id: string, values: Record<string, unknown>): Promise<void> | void
  /** 动态路由清单（实际挂载命名空间 /api/plugins/<encodedId>/routes/...）。 */
  listRoutes(): PluginRouteInfo[]
}

export interface SearchHit {
  [key: string]: unknown
}

/** HTTP 消费的 KernelRuntime 形状（真实 KernelRuntime 结构化兼容于它）。 */
export interface KernelRuntimeLike {
  readonly dataDir: string
  readonly auth: AuthService
  readonly events: EventHub
  readonly profiles: ProfileService
  readonly skills: SkillService
  readonly credentials: CredentialService
  readonly providers: ProviderService
  readonly models: ModelService
  readonly artifacts: ArtifactService
  readonly plugins: PluginHost

  listConversations(filter?: {
    tag?: string
    status?: ConversationStatus
  }): Promise<ConversationSummary[]> | ConversationSummary[]
  getConversation(id: number): Promise<ConversationSummary> | ConversationSummary
  createConversation(init?: ConversationInit): Promise<ConversationSummary> | ConversationSummary
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> | ConversationSummary
  deleteConversation(id: number): Promise<void> | void
  submitInput(
    id: number,
    text: string,
    opts?: { origin?: 'human' | 'agent' | 'trigger'; whenBusy?: 'steer' | 'followUp' | 'reject' },
  ): Promise<unknown> | unknown
  abortConversation(id: number): Promise<void> | void

  listAsks(): Promise<AskSpec[]> | AskSpec[]
  answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<unknown> | unknown
  cancelAsk(id: string): Promise<void> | void

  search(query: string): Promise<SearchHit[]> | SearchHit[]
  listModels(): Promise<unknown[]> | unknown[]
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunHandle {
  runId: string
}

export interface WorkflowServiceLike {
  list(): Promise<unknown[]> | unknown[]
  run(request: WorkflowRunRequest): Promise<WorkflowRunSummary | WorkflowRunHandle> | WorkflowRunSummary | WorkflowRunHandle
  getRun(runId: string): Promise<WorkflowRunSummary | undefined> | WorkflowRunSummary | undefined
  abort(runId: string): Promise<void> | void
}

/** startHub 选项与返回。 */
export interface StartHubOptions {
  kernel: KernelRuntimeLike
  workflows: WorkflowServiceLike
  /** 默认 3202（HELM_PORT 约定；测试请用 0）。 */
  port?: number
  /** 默认 127.0.0.1。 */
  hostname?: string
}

export interface HubHandle {
  url: string
  close(): Promise<void>
}

// 导出供测试构造完整 Profile
export type { Profile, ProviderConfig, SkillSummary, ArtifactMetadata, AskSpec, ConversationSummary, PluginSummary, ActionManifest, WorkflowRunSummary, WorkflowRunRequest }
