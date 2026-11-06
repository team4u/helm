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
// Events / Plugins
// ---------------------------------------------------------------------------

/**
 * 全局事件枢纽（kernel.events）。HTTP 层只消费 response()：由 runtime
 * 提供 Web Standard SSE Response（流式、帧内自行脱敏），客户端断开
 * （request.signal abort）由实现负责清理。HTTP 层不做缓存/转换/兜底。
 */
export interface EventHub {
  /** SSE 响应：立即返回 Response（流式），客户端断开自动清理。 */
  response(request: Request): Response
}

export interface PluginRouteInfo {
  pluginId: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 完整挂载路径（如 '/api/plugins/<id>/webhook/:t'）；声明时强制专属前缀。 */
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
  readonly artifacts: ArtifactService
  readonly plugins: PluginHost
  /**
   * 机密脱敏钩子（真实 kernel 的 SecretStash）。出站 JSON 的字符串值与
   * 服务端错误日志都先经它擦除已登记秘密，绝不外发明文或还原 marker。
   */
  readonly stash?: { redact(text: string): string }
  /**
   * 模型热重载端口：providers/credentials 变更后 await，使后续
   * listModels 反映新配置（仅持久化 JSON 而不重载等于热配置无效）。
   * 可选：runtime 未提供时 HTTP 层不阻塞写路径。
   */
  reloadModels?(): Promise<void>

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
