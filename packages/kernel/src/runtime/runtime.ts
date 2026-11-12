/**
 * @helm/kernel 极简运行时主类（微内核底座）。
 *
 * 职责：
 * - 组装并连接全部内核机制（pi-durable / SQLite / FTS5 / EnvFabric / PluginHost / Models）；
 * - 统一生命周期管理（open / initialize / start / close）；
 * - 提供外部 HTTP 路由与 CLI 消费的强类型门面 API；
 * - 复杂业务编排与操作委托给专门的高内聚子模块：
 *   RuntimeNodeOperations、RuntimeTriggerDispatcher、RuntimeAgentSpawn、
 *   RuntimeOwnershipManager、createPluginHostBackend 与 RuntimeToolRegistry。
 */

import {
  HelmError,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type AskCreateSpec,
  type AskResult,
  type AskSpec,
  type ConversationDetail,
  type ConversationInit,
  type ConversationInputResult,
  type ConversationPatch,
  type ConversationSummary,
  type ConversationWithdrawResponse,
  type EnvExecRequest,
  type EnvExecResponse,
  type ExternalTriggerEnvelope,
  type MaybePromise,
  type ModelCatalog,
  type ModelProvidersRefreshResult,
  type NodeInfo,
  type NodeIssuedToken,
  type NodeUpgradeCheckInput,
  type NodeUpgradeCheckResult,
  type NodeUpgradeResult,
  type PluginSkillAsset,
} from '@helm/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationOwnership } from './runtime-ownership.js'
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import {
  ArtifactService as SvcArtifactService,
  AuthService as SvcAuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
} from '../services/index.js'
import { PluginHost } from '../plugins/index.js'
import { PluginPackageManager } from '../plugins/package-manager.js'
import { PluginPackageManagerStore } from '../plugins/package-store.js'
import type { EnvFabric } from '../env/index.js'
import type { EventHub, SessionDocEventHub } from './events.js'
import type { HelmDatabase } from './sqlite.js'
import type { HelmStore } from './store.js'
import { THINKING_LEVELS } from './spawn.js'
import type { HelmPluginConfigStore } from './plugin-config-store.js'
import type { ConversationService } from './conversation-service.js'
import type { NodeManager } from './node-manager.js'
import type { ModelRegistry } from './model-registry.js'
import {
  assertProfileIdPublic,
  completeConversationTextHelper,
  profileDirectoryHelper,
  skillDirectoryHelper,
  summaryOfFallback,
} from './runtime-helpers.js'
import type { RuntimeNodeOperations } from './runtime-nodes.js'
import {
  createGlobalDocumentStore,
  createPluginHostBackend,
  createPluginSessionDocStore,
} from './runtime-host-backend.js'
import {
  bootstrapKernelRuntime,
  ensureInitialConversation,
  recoverExistingConversations,
  teardownKernelRuntime,
  type KernelBootOptions,
} from './runtime-bootstrap.js'
import {
  assembleRuntimeServices,
  type AssembledRuntimeServices,
  type RuntimeServicesInit,
} from './runtime-services.js'

export type KernelRuntimeOptions = KernelBootOptions

export class KernelRuntime {
  readonly dataDir: string
  private readonly database: HelmDatabase
  private readonly harness: Harness
  readonly registry: Registry<ToolRegistration<object, JsonValue>>
  private readonly store: HelmStore
  readonly events: EventHub
  /** 会话文档专用事件面（HTTP sessionDocEvents 端口；同一实例，构造器中接线）。 */
  readonly sessionDocEvents: SessionDocEventHub
  private readonly stashService = new SecretStash()
  private readonly hostEventListeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  readonly envFabric: EnvFabric
  private processTokenHandle: { tokenOf(): string | undefined; dispose(): void } | undefined
  private hubUrlValue: string
  private pluginHost: PluginHost | undefined
  private started = false
  private startPromise: Promise<void> | undefined
  private closed = false
  private readonly handledToolCalls = new Map<
    string,
    {
      conversationId: number | undefined
      result: { output: Array<{ type: 'text'; text: string }>; isError: boolean }
    }
  >()
  private settledInflight: Promise<void> = Promise.resolve()
  readonly nodes: NodeManager
  readonly conversations: ConversationService
  readonly modelsRegistry: ModelRegistry
  readonly nodeOps: RuntimeNodeOperations
  private readonly svc: AssembledRuntimeServices

  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush(): Promise<void>
  }

  static async open(options: KernelRuntimeOptions = {}): Promise<KernelRuntime> {
    const boot = await bootstrapKernelRuntime(options)
    const runtime = new KernelRuntime({
      ...boot,
      defaultModel: options.model || process.env['HELM_MODEL'] || undefined,
      cwd: options.cwd ?? process.cwd(),
      hubUrl: options.hubUrl,
      seedKeyCache: boot.apiKeyCache,
      autoResume: options.autoResume !== false,
      externalModels: options.models,
      nodeUpgradeTimeoutMs: options.nodeUpgradeTimeoutMs ?? 120_000,
    })
    try {
      await runtime.initialize()
    } catch (error) {
      await runtime.close().catch(() => {})
      throw error
    }
    return runtime
  }

  private constructor(private readonly init: RuntimeServicesInit) {
    this.dataDir = init.dataDir
    this.database = init.database
    this.harness = init.harness
    this.registry = init.registry
    this.store = init.store
    this.hubUrlValue = init.hubUrl ?? `http://127.0.0.1:${process.env['HELM_PORT'] ?? '3202'}`
    this.documentStore = createGlobalDocumentStore(this.store)

    // 组装并连接全部内核内部服务
    this.svc = assembleRuntimeServices(this, init, {
      store: this.store,
      stashService: this.stashService,
      handledToolCalls: this.handledToolCalls,
      dispatchTurnSettled: (payload, consumed) => this.dispatchTurnSettled(payload, consumed),
      onSettleInflight: (run) => {
        this.settledInflight = Promise.all([this.settledInflight, run]).then(() => undefined)
        void this.settledInflight.catch(() => {})
      },
      safeSummary: (id) => this.safeSummary(id),
      submitInput: (id, text, opts) => this.submitInput(id, text, opts),
      createConversation: (cInit) => this.createConversation(cInit),
      updateConversation: (id, patch) => this.updateConversation(id, patch),
    })

    this.modelsRegistry = this.svc.modelsRegistry
    this.envFabric = this.svc.envFabric
    this.nodes = this.svc.nodes
    this.nodeOps = this.svc.nodeOps
    this.events = this.svc.events
    this.sessionDocEvents = this.svc.sessionDocStreams
    this.conversations = this.svc.conversations

    this.nodeOps.bindEvents()

    // 受管进程 token
    const managed = this.svc.authSvc.createProcessToken()
    this.processTokenHandle = {
      tokenOf: () => managed.token,
      dispose: () => managed.dispose(),
    }
    this.stashService.addRedaction(managed.token)
    if (process.env['HELM_TOKEN']) {
      this.stashService.addRedaction(process.env['HELM_TOKEN'])
    }
    this.init.redactReport((t) => this.stashService.redact(t))
  }

  private async initialize(): Promise<void> {
    await this.nodeOps.initialize()
    await this.svc.profilesSvc.ensureDefault()
    this.modelsRegistry.setThinkingLevelValidator(async (level) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError('config_corrupt', `config.json.thinkingLevel 非法（合法值：${[...THINKING_LEVELS].join(' | ')}）`, 500)
      }
    })
    await this.modelsRegistry.loadDefaultsFromConfig()

    this.svc.toolRegistry.installKernelTools()
    this.svc.hookBridge.install()

    await this.svc.pluginConfig.load()
    this.pluginHost = new PluginHost({
      dataDir: this.dataDir,
      deferServices: true,
      redactText: (text) => this.stashService.redact(text),
      providers: {
        register: (provider, pluginId) => this.modelsRegistry.registerRuntimeProvider(provider, pluginId),
        assertIdle: (pluginId) => this.modelsRegistry.assertRuntimeProvidersIdle(pluginId),
      },
      host: createPluginHostBackend(this),
      docs: this.documentStore,
      sessionDocs: createPluginSessionDocStore(this.store),
      config: this.svc.pluginConfig,
    })
    // 受管包安装记录预热（config.json pluginPackages；损坏显式上抛）后接线安装器。
    const packageStore = new PluginPackageManagerStore(this.svc.configSvc)
    await packageStore.load()
    this.pluginHost.attachPackageManager(
      new PluginPackageManager({
        dataDir: this.dataDir,
        cwd: this.init.cwd,
        store: packageStore,
        host: this.pluginHost.asPackageManagerHost(),
      }),
      packageStore,
    )

    await ensureInitialConversation({
      harness: this.harness,
      store: this.store,
      tracker: this.svc.tracker,
      conversations: this.conversations,
      modelsRegistry: this.modelsRegistry,
      cwd: this.init.cwd,
    })
    this.svc.asks.reportOrphans()
    await recoverExistingConversations({
      conversations: this.conversations,
      harness: this.harness,
      store: this.store,
      defaultCwd: this.svc.toolDeps.defaultCwd,
    })
    this.svc.assetReloader.start()
    if (this.init.autoResume) await this.start()
  }

  async ensurePluginSkill(asset: PluginSkillAsset, pluginId: string): Promise<void> {
    const managed = /^managedByPlugin:[ \t]*['\"]?([^'\"\n]+)['\"]?[ \t]*$/m.exec(asset.skillMd)
    if (managed?.[1]?.trim() !== pluginId) {
      throw new HelmError(
        'invalid_plugin_skill',
        `插件 ${pluginId} 自举技能 ${asset.id} 的 SKILL.md frontmatter 必须声明 managedByPlugin: ${pluginId}（实际：${managed?.[1] ?? '缺失'}）`,
        400,
        { pluginId, skillId: asset.id },
      )
    }
    await this.svc.skillsSvc.ensureSkill(asset)
  }

  emitHostEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void> {
    if (options?.broadcast === false) {
      if (type === 'plugin.changed' || type === 'plugin.session_doc.updated' || type.trim() === '') {
        throw new HelmError('invalid_event', '宿主生命周期事件不可改为私有分发', 400)
      }
      return this.dispatchInternalEvent(type, payload)
    }
    if (type === 'plugin.changed') {
      this.refreshPluginTools()
      const envelope = payload as { type?: string; plugin?: unknown; ui?: unknown } | undefined
      this.events.publish('plugin.changed', {
        type: 'plugin.changed',
        plugin: envelope?.plugin ?? {},
        ui: Array.isArray(envelope?.ui) ? envelope!.ui : [],
      })
      return
    }
    if (type === 'plugin.session_doc.updated') {
      this.svc.sessionDocStreams.dispatch(payload)
      return this.dispatchInternalEvent(type, payload)
    }
    this.events.publish(type, payload)
    return this.dispatchInternalEvent(type, payload)
  }

  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
    let listeners = this.hostEventListeners.get(type)
    if (listeners === undefined) {
      listeners = new Set()
      this.hostEventListeners.set(type, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners!.delete(listener)
      if (listeners!.size === 0) this.hostEventListeners.delete(type)
    }
  }

  private dispatchInternalEvent(type: string, payload: unknown): MaybePromise<void> {
    const listeners = this.hostEventListeners.get(type)
    if (listeners === undefined || listeners.size === 0) return
    const run = (async () => {
      for (const listener of [...listeners]) {
        await listener(payload)
      }
    })()
    return run
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      if (this.pluginHost) await this.pluginHost.start()
      this.harness.resume()
      this.started = true
    })()
    return this.startPromise
  }

  async prepareInterruptedConversations(ids: number[]): Promise<void> {
    const targets = new Set(ids)
    if (targets.size === 0) return
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT)
    if (inspection.scheduling !== 'paused') {
      throw new HelmError('recovery_already_started', '必须在调度器恢复之前标记中断子代理，拒绝不安全的恢复顺序', 409)
    }
    for (const task of inspection.tasks) {
      if (targets.has(task.record.conversationId as number)) {
        await this.harness.abortTask(task.record.id, BACKGROUND_CONTEXT)
      }
    }
  }

  setHubUrl(url: string): void {
    if (typeof url !== 'string' || url === '') {
      throw new HelmError('validation_error', `hub URL 必须是非空字符串：${String(url)}`, 400)
    }
    this.hubUrlValue = url
  }

  buildSpawnEnv(conversationId: number, cwd: string, nodeId?: string): Record<string, string> {
    return this.svc.agentSpawn.buildSpawnEnv(conversationId, cwd, nodeId)
  }

  // ------------------------------------------------------------------
  // 节点管理委托（RuntimeNodeOperations）
  // ------------------------------------------------------------------

  async listNodes(): Promise<NodeInfo[]> {
    return this.nodeOps.listNodes()
  }

  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    return this.nodeOps.issueNodeToken(nodeId)
  }

  async removeNode(nodeId: string): Promise<void> {
    return this.nodeOps.removeNode(nodeId)
  }

  async checkNodeUpgrade(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> {
    return this.nodeOps.checkNodeUpgrade(nodeId, input)
  }

  async upgradeNode(
    nodeId: string,
    input?: { targetVersion?: string; registryUrl?: string; force?: boolean },
  ): Promise<NodeUpgradeResult> {
    return this.nodeOps.upgradeNode(nodeId, input)
  }

  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    return this.nodeOps.execEnv(req, onChunk, signal)
  }

  // ------------------------------------------------------------------
  // 产物授权 / 附件委托（ConversationService）
  // ------------------------------------------------------------------

  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    return this.conversations.isArtifactAuthorized(conversationId, artifactConversationId)
  }

  async resolveAuthorizedAttachments(conversationId: number, attachmentIds: readonly string[]) {
    return this.conversations.resolveAuthorizedAttachments(conversationId, attachmentIds)
  }

  async resolveAuthorizedAttachment(conversationId: number, artifactId: string) {
    return this.conversations.resolveAuthorizedAttachment(conversationId, artifactId)
  }

  // ------------------------------------------------------------------
  // 插件工具热装
  // ------------------------------------------------------------------

  attachPluginHost(host: PluginHost): void {
    this.pluginHost = host
    this.svc.toolRegistry.installPluginTools(host.listTools())
  }

  refreshPluginTools(): void {
    if (this.pluginHost === undefined) return
    this.svc.toolRegistry.installPluginTools(this.pluginHost.listTools())
  }

  get plugins(): PluginHost {
    if (this.pluginHost === undefined) {
      throw new HelmError('internal_error', 'PluginHost 尚未接入 KernelRuntime（initialize 未调用）', 500)
    }
    return this.pluginHost
  }

  private async dispatchTurnSettled(payload: unknown, consumed: unknown): Promise<void> {
    const convId = (payload as { conversationId: number }).conversationId
    for (const [id, entry] of this.handledToolCalls) {
      if (entry.conversationId === convId) this.handledToolCalls.delete(id)
    }
    const turnEvent = { ...(payload as Record<string, unknown>), inputs: consumed }
    const outcome = await this.svc.hookBridge.runHookChain('turn_settled', turnEvent)
    if (outcome?.action === 'handled') return
    this.events.publish('turn.settled', outcome?.action === 'transform' ? outcome.value : turnEvent)
  }

  // ------------------------------------------------------------------
  // 会话操作委托（ConversationService）
  // ------------------------------------------------------------------

  listConversations(filter?: { profileId?: string; tag?: string; status?: string }): ConversationSummary[] {
    return this.conversations.listConversations(filter)
  }

  getConversation(id: number): ConversationSummary {
    return this.conversations.getConversation(id)
  }

  getConversationDetail(id: number, options?: Parameters<ConversationService['getConversationDetail']>[1]): Promise<ConversationDetail> {
    return this.conversations.getConversationDetail(id, options)
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    return this.conversations.createConversation(init)
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    return this.conversations.updateConversation(id, patch)
  }

  async deleteConversation(id: number): Promise<void> {
    return this.conversations.deleteConversation(id)
  }

  async submitInput(
    id: number,
    text: string,
    opts?: Parameters<ConversationService['submitInput']>[2],
  ): Promise<{ submissionId: string }> {
    return this.conversations.submitInput(id, text, opts)
  }

  async waitForInput(id: number, submissionId: string): Promise<ConversationInputResult> {
    return this.conversations.waitForInput(id, submissionId)
  }

  async abortConversation(id: number): Promise<void> {
    return this.conversations.abortConversation(id)
  }

  async withdrawQueuedInput(id: number, opts: { submissionId: number }): Promise<ConversationWithdrawResponse> {
    return this.conversations.withdrawQueuedInput(id, opts)
  }

  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    return this.conversations.resetConversation(id, opts)
  }

  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    return this.conversations.compactConversation(id, opts)
  }

  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    return this.conversations.forkConversation(id, opts)
  }

  async waitForIdle(id: number): Promise<void> {
    return this.conversations.waitForIdle(id)
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.conversations.getLastAssistantText(id)
  }

  async search(query: string): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    return this.conversations.search(query)
  }

  async rebuildFts(): Promise<void> {
    await this.conversations.rebuildFts(() => this.listConversations().map((c) => ({ id: c.id, title: c.title })))
  }

  async alignProfileConversations(profileId: string): Promise<void> {
    return this.conversations.alignProfileConversations(profileId)
  }

  async completeConversationText(input: {
    conversationId: number
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string> {
    return completeConversationTextHelper(
      {
        store: this.store,
        conversations: this.conversations,
        modelsRegistry: this.modelsRegistry,
        stash: this.stashService,
      },
      input,
    )
  }

  // ------------------------------------------------------------------
  // 触发器委托（RuntimeTriggerDispatcher）
  // ------------------------------------------------------------------

  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    return this.svc.triggers.dispatchTrigger(envelope)
  }

  // ------------------------------------------------------------------
  // 子代理派生委托（RuntimeAgentSpawn）
  // ------------------------------------------------------------------

  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    return this.svc.agentSpawn.spawnAgent(request)
  }

  runGate(
    command: string,
    options: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
    } = {},
  ): Promise<{ ok: boolean; output: string }> {
    return this.svc.agentSpawn.runGate(command, options)
  }

  async resolveSpawnTarget(input: {
    parentConversationId: number
    profileId?: string
    requestCwd?: string
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }> {
    return this.svc.agentSpawn.resolveSpawnTarget(input)
  }

  listActiveSpawnExecutions(): AgentExecutionInfo[] {
    return this.svc.agentSpawn.listActiveSpawnExecutions()
  }

  async probeNodeFs(input: {
    nodeId: string
    op: 'exists' | 'canonicalPath'
    path: string
    signal?: AbortSignal
  }): Promise<{ value: string | boolean }> {
    return this.svc.agentSpawn.probeNodeFs(input)
  }

  // ------------------------------------------------------------------
  // 目录坐标查询
  // ------------------------------------------------------------------

  async skillDirectory(id: string): Promise<string> {
    return skillDirectoryHelper(this.dataDir, id)
  }

  async profileDirectory(id: string): Promise<string> {
    return profileDirectoryHelper(this.dataDir, id)
  }

  // ------------------------------------------------------------------
  // 会话归属与运行事实委托（RuntimeOwnershipManager）
  // ------------------------------------------------------------------

  getConversationOwnership(conversationId: number): ConversationOwnership {
    return this.svc.ownership.getOwnership(conversationId)
  }

  getConversationActivity(conversationId: number): { stalledMs?: number; consecutiveErrors: number } {
    const meta = this.store.getConv(conversationId)
    if (meta === undefined || this.store.isDeleted(conversationId)) {
      throw new HelmError('not_found', `会话不存在：${conversationId}`, 404, { conversationId })
    }
    return this.svc.tracker.getProbeFacts(conversationId)
  }

  // ------------------------------------------------------------------
  // 异步审批委托（AskService）
  // ------------------------------------------------------------------

  listAsks(status?: string): AskSpec[] {
    return this.svc.asks.listAsks(status)
  }

  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    return this.svc.asks.createAsk(spec)
  }

  async answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<AskSpec> {
    return this.svc.asks.answerAsk(id, answers, expectedStateSeq)
  }

  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    await this.svc.asks.cancelAsk(id, reason ?? 'cancelled')
  }

  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    return this.svc.asks.registerSeqResolver(resolver)
  }

  // ------------------------------------------------------------------
  // 模型集合与 Provider 管理委托（ModelRegistry）
  // ------------------------------------------------------------------

  async listModels(): Promise<ModelCatalog> {
    return this.modelsRegistry.listModels()
  }

  /** 设置模型禁用集（PUT /api/models/filter）：undefined provider 清空全部。 */
  async setDisabledModels(provider: string | undefined, disabledModels: string[]): Promise<ModelCatalog> {
    return this.modelsRegistry.setDisabledModels(provider, disabledModels)
  }

  async setDefaultModel(model?: string, thinkingLevel?: string): Promise<void> {
    const validateLevel = (level: string) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `thinkingLevel '${level}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
    }
    await this.modelsRegistry.setDefaultModel(model, thinkingLevel, validateLevel)
  }

  listModelProviders() {
    return this.modelsRegistry.listModelProviders()
  }

  async reloadModels(): Promise<void> {
    return this.modelsRegistry.reloadModels()
  }

  async registerRuntimeProvider(
    provider: Parameters<ModelRegistry['registerRuntimeProvider']>[0],
    pluginId?: string,
  ): Promise<() => Promise<void>> {
    return this.modelsRegistry.registerRuntimeProvider(provider, pluginId)
  }

  assertRuntimeProvidersIdle(pluginId: string): void {
    this.modelsRegistry.assertRuntimeProvidersIdle(pluginId)
  }

  async refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    return this.modelsRegistry.refreshModels(() => this.closed, options)
  }

  markConversationOwnership(conversationId: number, owner: ConversationOwnership): void {
    this.svc.ownership.markOwnership(conversationId, owner)
  }

  manageConversation(conversationId: number, pluginId: string): () => void {
    return this.svc.ownership.manage(conversationId, pluginId)
  }

  // ------------------------------------------------------------------
  // 服务与上下文 Getters
  // ------------------------------------------------------------------

  get hubUrl(): string { return this.hubUrlValue }
  get processToken(): string | undefined { return this.processTokenHandle?.tokenOf() }
  get pluginConfigStore(): HelmPluginConfigStore { return this.svc.pluginConfig }
  get profiles(): ProfileService { return this.svc.profilesSvc }
  get skills(): SkillService { return this.svc.skillsSvc }
  get artifacts(): SvcArtifactService { return this.svc.artifactsSvc }
  get auth(): SvcAuthService { return this.svc.authSvc }
  get credentials(): CredentialService { return this.svc.credentialsSvc }
  get providers(): ProviderService { return this.svc.providersSvc }
  get stash(): SecretStash { return this.stashService }
  /** @internal 供测试与内部协调读取 tracker */
  private get tracker() { return this.svc.tracker }
  /** @internal 供测试读取内部 toolDeps */
  private get toolDeps() { return this.svc.toolDeps }

  get services(): {
    profiles: ProfileService
    skills: SkillService
    artifacts: SvcArtifactService
    auth: SvcAuthService
    credentials: CredentialService
    providers: ProviderService
    stash: SecretStash
  } {
    return {
      profiles: this.svc.profilesSvc,
      skills: this.svc.skillsSvc,
      artifacts: this.svc.artifactsSvc,
      auth: this.svc.authSvc,
      credentials: this.svc.credentialsSvc,
      providers: this.svc.providersSvc,
      stash: this.stashService,
    }
  }

  private safeSummary(id: number): ConversationSummary | undefined {
    const meta = this.store.getConv(id)
    if (!meta) return undefined
    try {
      return this.conversations.withOwnership(this.svc.tracker.summaryOf(id))
    } catch {
      return this.conversations.withOwnership(summaryOfFallback(meta, 'idle', 0))
    }
  }

  get isClosing(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await teardownKernelRuntime({
      modelsRegistry: this.modelsRegistry,
      assetReloader: this.svc.assetReloader,
      nodes: this.nodes,
      settledInflight: () => this.settledInflight,
      store: this.store,
      harness: this.harness,
      tracker: this.svc.tracker,
      pluginHost: this.pluginHost,
      envFabric: this.envFabric,
      processTokenHandle: this.processTokenHandle,
      database: this.database,
      events: this.events,
      sessionDocStreams: this.svc.sessionDocStreams,
      sessionDocLifecycleRelease: this.svc.sessionDocLifecycleRelease,
      stashService: this.stashService,
    })
    this.processTokenHandle = undefined
  }
}
