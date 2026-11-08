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
  ConversationCompactResponse,
  ConversationDetail,
  ConversationInit,
  ConversationInputResult,
  ConversationPatch,
  ConversationStatus,
  ConversationSummary,
  EnvExecRequest,
  EnvExecResponse,
  ModelCatalogEntry,
  ModelCatalog,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeInput,
  NodeUpgradeResult,
  ModelProviderSummary,
  ModelProvidersRefreshResult,
  PluginConfigFieldSchema,
  PluginSummary,
  ProviderConfig,
  PublicPluginDoc,
  SavedWorkflowSummary,
  SearchHit,
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
import type { EnvFabric } from '../env/index.js'

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
  /** 读取插件公共文档；私有/停用/不存在一律 404（鉴权不能绕过可见性）。 */
  getPublicDoc(pluginId: string, name: string): Promise<PublicPluginDoc> | PublicPluginDoc
  /**
   * 获取已启用插件 client.tsx 编译产物（GET /api/plugins/:id/client.mjs?module=...）。
   * 停用/未注册/未声明 clientRoot/越根/编译失败显式抛错（HelmError 语义）。
   */
  getClientModule(pluginId: string, moduleRef: string): Promise<{ code: string; contentHash: string }>
}

export type { SearchHit }

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
  readonly stash?: {
    redact(text: string): string
    createStreamingRedactor?(): { push(text: string): string; flush(): string }
  }
  /**
   * 模型热重载端口：providers/credentials 变更后 await，使后续
   * listModels 反映新配置（仅持久化 JSON 而不重载等于热配置无效）。
   * 可选：runtime 未提供时 HTTP 层不阻塞写路径。
   */
  reloadModels?(): Promise<void>

  /**
   * 实际 Hub URL 热更新端口：startHub(port:0) 监听后回调，使 shell 内
   * CLI/工具端点指向真实地址。未提供时 HTTP 层不阻塞。
   */
  setHubUrl?(url: string): void

  listConversations(filter?: {
    profileId?: string
    tag?: string
    status?: ConversationStatus
  }): Promise<ConversationSummary[]> | ConversationSummary[]
  /** GET /api/conversations/:id 消费：摘要 + 分页时间线。 */
  getConversationDetail(
    id: number,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> | ConversationDetail
  createConversation(init?: ConversationInit): Promise<ConversationSummary> | ConversationSummary
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> | ConversationSummary
  deleteConversation(id: number): Promise<void> | void
  submitInput(
    id: number,
    text: string,
    opts?: {
      origin?: 'human' | 'agent' | 'trigger'
      /** 会话正忙策略；省略时内核默认 steer。 */
      whenBusy?: 'steer' | 'followUp' | 'reject'
      meta?: Record<string, unknown>
      attachments?: string[]
    },
  ): Promise<{ submissionId: string }> | { submissionId: string }
  /** ?wait=1：等待单次提交终态并返回本次输入结果；失败/中止抛明确 HelmError。 */
  waitForInput(
    id: number,
    submissionId: string,
  ): Promise<ConversationInputResult> | ConversationInputResult
  abortConversation(id: number): Promise<void> | void
  /** 重置会话上下文（新上下文以 handoff 文本开始）；返回更新后的摘要。 */
  resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> | ConversationSummary
  /** 手动压缩会话上下文；返回压缩任务 ID 与更新后的摘要。 */
  compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<ConversationCompactResponse> | ConversationCompactResponse
  /** 从指定条目分叉新会话（继承 profile/cwd/model，父链指向源会话）。 */
  forkConversation(
    id: number,
    opts: { entryId: number; title?: string },
  ): Promise<ConversationSummary> | ConversationSummary

  listAsks(): Promise<AskSpec[]> | AskSpec[]
  answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<unknown> | unknown
  cancelAsk(id: string): Promise<void> | void

  search(query: string): Promise<SearchHit[]> | SearchHit[]
  listModels(): Promise<ModelCatalog> | ModelCatalog
  /** 设置全局默认模型与思考档位（config.json）；空串清除。未实现时 HTTP 501。 */
  setDefaultModel?(model?: string, thinkingLevel?: string): Promise<void>
  /** Profile 保存后同步绑定会话的模型与思考档位。 */
  alignProfileConversations?(profileId: string): Promise<void>
  listModelProviders(): Promise<ModelProviderSummary[]> | ModelProviderSummary[]
  /**
   * 动态模型目录刷新（POST /api/models/refresh）：目标动态供应商 allowNetwork
   * 拉取最新目录并持久化 models-store.json。可选端口：runtime 未提供时 501。
   */
  refreshModels?(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult>

  // ---------------------------------------------------------------------------
  // 跨平台节点管理（EnvFabric / nodes / env exec）
  // ---------------------------------------------------------------------------

  /** 节点底座（node-server 接 WS 网关用）；未提供时 /ws/node 不挂接。 */
  readonly envFabric?: EnvFabric
  /** 列出 local + 已登记 BYOM 节点与实时在线状态（GET /api/nodes）。 */
  listNodes(): Promise<NodeInfo[]> | NodeInfo[]
  /** 签发节点接入令牌（明文 token 仅本次响应返回；服务端只存 sha256）。 */
  issueNodeToken(nodeId: string): Promise<NodeIssuedToken> | NodeIssuedToken
  /** 移除节点：从签发表删除并立即掐断在途连接（DELETE /api/nodes/:id）。 */
  removeNode(nodeId: string): Promise<void> | void
  /** 检查节点可用更新（GET /api/nodes/:id/upgrade/check）。 */
  checkNodeUpgrade?(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> | NodeUpgradeCheckResult
  /** 触发节点升级并等待 commit 确认（POST /api/nodes/:id/upgrade）。 */
  upgradeNode?(nodeId: string, input?: NodeUpgradeInput): Promise<NodeUpgradeResult> | NodeUpgradeResult
  /**
   * 跨节点命令执行（POST /api/env/exec）：靶点解析为显式 nodeId/cwd >
   * 会话绑定 > local；远端离线 409 node_offline；onChunk 逐块回放
   * （NDJSON 流式模式）；signal 传播取消。
   */
  execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> | EnvExecResponse
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowRunHandle {
  runId: string
}

export interface WorkflowServiceLike {
  list(): Promise<SavedWorkflowSummary[]> | SavedWorkflowSummary[]
  /** 已知全部 run 摘要（含运行中与终态）。 */
  listRuns(): Promise<WorkflowRunSummary[]> | WorkflowRunSummary[]
  run(request: WorkflowRunRequest): Promise<WorkflowRunSummary | WorkflowRunHandle> | WorkflowRunSummary | WorkflowRunHandle
  getRun(runId: string): Promise<WorkflowRunSummary | undefined> | WorkflowRunSummary | undefined
  /** 等待 run 终态并返回结果（历史 run 直接返回 result）。 */
  wait(runId: string): Promise<unknown> | unknown
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
  /**
   * 生产静态托管目录（packages/web/dist）：false 禁用；缺省探测默认位置
   * （存在 index.html 才启用）；字符串为显式目录（失效时启动显式报错）。
   * 透传给 createHubHandler 的同名选项。
   */
  webDistDir?: string | false
}

export interface HubHandle {
  url: string
  close(): Promise<void>
}

// 导出供测试构造完整 Profile
export type { Profile, ProviderConfig, SkillSummary, ArtifactMetadata, AskSpec, ConversationSummary, ConversationDetail, ConversationInputResult, PluginSummary, ActionManifest, WorkflowRunSummary, WorkflowRunRequest, PublicPluginDoc, NodeInfo, NodeIssuedToken, NodeUpgradeCheckInput, NodeUpgradeCheckResult, NodeUpgradeInput, NodeUpgradeResult, EnvExecRequest, EnvExecResponse, ModelCatalogEntry, ModelCatalog, SavedWorkflowSummary, ConversationCompactResponse }
