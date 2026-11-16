/**
 * @helm/kernel extreme simple runtime main class (microkernel bottom seat).
 *
 * responsibility:
 * - group install and connect all kernel mechanism (pi-durable / SQLite / FTS5 / EnvFabric / PluginHost / Models);
 * - unify lifecycle manage (open / initialize / start / close);
 * - provide external HTTP routing and CLI consume strong type gate side API;
 * - complex business orchestration and operation delegate to dedicated high inside gather sub- module:
 *   RuntimeNodeOperations,RuntimeTriggerDispatcher,RuntimeAgentSpawn,
 *   RuntimeOwnershipManager,createPluginHostBackend and RuntimeToolRegistry.
 */

import {
  HelmError,
  type AgentSpawnRequest,
  type AskCreateSpec,
  type AskResult,
  type AskSpec,
  type ConversationDetail,
  type ConversationEntry,
  type ConversationInit,
  type ConversationInputResult,
  type ConversationListFilter,
  type ConversationPatch,
  type ConversationSummary,
  type ConversationWithdrawResponse,
  type ConversationInput,
  type TurnSettledPayload,
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
import type { ConversationOwnership } from './runtime-ownership.js'
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
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
import { NodeForwardService, type NodeForwardEvent, type NodeForwardInput, type NodeForwardSession } from '../env/forward.js'
import type { EventHub, SessionDocEventHub } from './events.js'
import type { HelmDatabase } from './sqlite.js'
import type { HelmStore } from './store.js'
import { THINKING_LEVELS } from './spawn.js'
import type { HelmPluginConfigStore } from './plugin-config-store.js'
import type { ConversationService } from './conversation-service.js'
import type { RuntimeAgentSpawn } from './runtime-agent-spawn.js'
import type { NodeManager } from './node-manager.js'
import type { ModelRegistry } from './model-registry.js'
import {
  assertProfileIdPublic,
  completeConversationTextHelper,
  profileDirectoryHelper,
  summaryOfFallback,
} from './runtime-helpers.js'
import type { RuntimeNodeOperations } from './runtime-nodes.js'
import {
  createGlobalDocumentStore,
  createPluginHostBackend,
  createPluginSessionDocStore,
} from './runtime-host-backend.js'
import { formatDiagnosticError, type KernelDiagnosticInput } from './diagnostics.js'
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
  /** conversation document dedicated use event side (HTTP sessionDocEvents port; the same instance, construct in connect line). */
  readonly sessionDocEvents: SessionDocEventHub
  private readonly stashService = new SecretStash()
  private readonly hostEventListeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  readonly envFabric: EnvFabric
  /** Hub side foreground port forwarding (listener only in command during store in;close unify destroy). */
  readonly nodeForward: NodeForwardService
  private processTokenHandle: { tokenOf(): string | undefined; dispose(): void } | undefined
  private hubUrlValue: string
  private pluginHost: PluginHost | undefined
  /** start lifecycle fact (only read expose to service install match;resume after sync segment placement, see start). */
  #started = false
  private startPromise: Promise<void> | undefined
  private closed = false
  #fatalError: HelmError | undefined
  private fatalStorageNotified = false
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
  /** subagent derive/target parse/occupy snapshot service (host backend direct connect; without two layer forwarding gate side). */
  readonly agentSpawn!: RuntimeAgentSpawn
  readonly modelsRegistry: ModelRegistry
  readonly nodeOps: RuntimeNodeOperations
  private readonly svc: AssembledRuntimeServices

  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    deletePlugin(pluginId: string): void
    flush(): Promise<void>
  }

  static async open(options: KernelRuntimeOptions = {}): Promise<KernelRuntime> {
    const boot = await bootstrapKernelRuntime(options)
    const runtime = new KernelRuntime({
      ...boot,
      hubPlatform: options.hubPlatform,
      defaultModel: options.model || process.env['HELM_MODEL'] || undefined,
      cwd: options.cwd ?? process.cwd(),
      hubUrl: options.hubUrl,
      seedKeyCache: boot.apiKeyCache,
      autoResume: options.autoResume !== false,
      externalModels: options.models,
      externalSkillRoots: options.externalSkillRoots,
      buildProvider: options.buildProvider,
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

    // group install and connect all kernel internal service
    this.svc = assembleRuntimeServices(this, init, {
      store: this.store,
      stashService: this.stashService,
      handledToolCalls: this.handledToolCalls,
      dispatchTurnSettled: (payload, consumed) => this.dispatchTurnSettled(payload, consumed),
      onSettleInflight: (run) => {
        // one by one items absorb error:teardown three where await settledInflight(), any one run reject
        // will interrupt closure stop (after continue store/database close by skip, handle leak leak) and fail-fast
        // toxic after continue all re- together. failed such as record log, never static default swallow.
        const absorbed = run.then(
          () => undefined,
          (error) => {
            this.emitDiagnostic({
              level: 'error',
              source: 'runtime.settle',
              message: 'turn compute chain failed (already absorb, do not block assert closure stop)',
              error,
            })
            return undefined
          },
        )
        this.settledInflight = this.settledInflight.then(() => absorbed)
      },
      safeSummary: (id) => this.safeSummary(id),
      submitInput: (id, text, opts) => this.submitInput(id, text, opts),
      createConversation: (cInit) => this.createConversation(cInit),
      updateConversation: (id, patch) => this.updateConversation(id, patch),
    })

    this.modelsRegistry = this.svc.modelsRegistry
    this.envFabric = this.svc.envFabric
    this.nodeForward = new NodeForwardService(this.svc.envFabric)
    this.nodes = this.svc.nodes
    this.nodeOps = this.svc.nodeOps
    this.events = this.svc.events
    this.sessionDocEvents = this.svc.sessionDocStreams
    this.conversations = this.svc.conversations
    this.agentSpawn = this.svc.agentSpawn

    // internal host event side single one delivery boundary:EventHub each time publish in SSE broadcast after exactly once
    // delivery to ctx.host.onEvent listener (already verify+redaction HelmEvent message seal). kernel automatically
    // event (tracker/asks etc. directly events.publish) ignore return i.e. fire-and-forget,
    // never block publish point (such as SDK advance sync observe path); public emitHostEvent broadcast
    // path await return delivery result (emitEvent contract), no longer self row second dispatch.
    this.events.setHostDispatcher((event) => this.dispatchInternalEvent(event.type, event))

    this.nodeOps.bindEvents()

    // managed process token
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
    this.svc.tracker.setDiagnosticSink(this.init.onDiagnostic)
    this.svc.conversations.setFatalErrorProvider(() => this.#fatalError)
    this.init.setFatalStorageHandler(
      (source, error) => this.handleFatalStorageError(source, error),
      () => this.closed,
    )
  }

  private async initialize(): Promise<void> {
    await this.nodeOps.initialize()
    await this.svc.profilesSvc.ensureDefault()
    this.modelsRegistry.setThinkingLevelValidator(async (level) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError('config_corrupt', `config.json.thinkingLevel illegal (legal value:${[...THINKING_LEVELS].join(' | ')})`, 500)
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
      buildProvider: this.init.buildProvider,
    })
    // managed package install record warm up (config.json pluginPackages; corrupt explicit on throw) after connect line install.
    const packageStore = new PluginPackageManagerStore(this.svc.configSvc)
    await packageStore.load()
    this.pluginHost.attachPackageManager(
      new PluginPackageManager({
        dataDir: this.dataDir,
        cwd: this.init.cwd,
        store: packageStore,
        host: this.pluginHost.asPackageManagerHost(),
        buildProvider: this.init.buildProvider,
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
        `plugin ${pluginId} self raise skill ${asset.id}  SKILL.md frontmatter must declaration managedByPlugin: ${pluginId}(actual:${managed?.[1] ?? 'missing'})`,
        400,
        { pluginId, skillId: asset.id },
      )
    }
    await this.svc.skillsSvc.ensureSkill(asset)
  }

  emitHostEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void> {
    if (options?.broadcast === false) {
      if (type === 'plugin.changed' || type === 'plugin.session_doc.updated' || type.trim() === '') {
        throw new HelmError('invalid_event', 'host lifecycle event cannot change is private dispatch', 400)
      }
      return this.dispatchInternalEvent(type, payload)
    }
    if (type === 'plugin.changed') {
      try {
        this.refreshPluginTools()
      } catch (error) {
        // tool hot install failed must not block assert event publish (client still must gets plugin state change),
        // also do not let exception penetrate caller; error such as record.
        this.emitDiagnostic({
          level: 'error',
          source: 'runtime.plugins',
          message: 'plugin.changed after refresh plugin tool failed',
          error,
        })
      }
      const envelope = payload as { type?: string; plugin?: unknown; ui?: unknown } | undefined
      return this.events.publish('plugin.changed', {
        type: 'plugin.changed',
        plugin: envelope?.plugin ?? {},
        ui: Array.isArray(envelope?.ui) ? envelope!.ui : [],
      }).internal
    }
    if (type === 'plugin.session_doc.updated') {
      this.svc.sessionDocStreams.dispatch(payload)
      return this.dispatchInternalEvent(type, payload)
    }
    // broadcast path internal listener delivery by EventHub single one delivery boundary negative duty (publish exactly once,
    // parameter is already verify+redaction message seal); return its delivery result keep emitEvent can await contract.
    return this.events.publish(type, payload).internal
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
    // one by one listener isolated: caller (plugin-host  emitEvent statement invoke) do not await do not
    // catch, any one listener throws must not block assert the rest listener, also must not becomes unhandledRejection.
    const run = (async () => {
      for (const listener of [...listeners]) {
        try {
          await listener(payload)
        } catch (error) {
          this.emitDiagnostic({
            level: 'error',
            source: 'runtime.events',
            message: `internal event listener failed (${type})`,
            error,
          })
        }
      }
    })()
    return run
  }

  /** lead to life store fault state (only read):Harness Storage fault or HelmStore persist failed after placement. */
  get fatalError(): HelmError | undefined {
    return this.#fatalError
  }

  private emitDiagnostic(input: KernelDiagnosticInput): void {
    this.init.emitDiagnostic(input)
  }

  private assertWritable(): void {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError
    }
  }

  private handleFatalStorageError(source: 'harness' | 'store', error: unknown): void {
    if (this.closed) return
    const safeDetail = this.stashService.redact(formatDiagnosticError(error))
    const recorded =
      error instanceof HelmError
        ? new HelmError(error.code, this.stashService.redact(error.message), error.status, {
            source,
            cause: safeDetail,
          })
        : new HelmError(
            source === 'store' ? 'store_flush_failed' : 'storage_failed',
            `lead to life store fault (${source}):${safeDetail}`,
            500,
            { source },
          )
    if (this.#fatalError === undefined) {
      this.#fatalError = recorded
    }
    this.emitDiagnostic({
      level: 'error',
      source,
      message: source === 'store' ? 'HelmStore persist failed, kernel enter lead to life fault state' : 'Harness because lead to life store fault close',
      error,
    })
    if (!this.fatalStorageNotified) {
      this.fatalStorageNotified = true
      const notification = {
        level: 'error' as const,
        title: source === 'store' ? 'kernel persist fault' : 'kernel store engine exception close',
        body: recorded.message,
      }
      try {
        this.events.publish('notification', notification)
      } catch {
        // store enter fail state when persistSeq will throw store_flush_failed;
        // at least still to internal host listener delivery once notify, never second throws.
        void this.dispatchInternalEvent('notification', { type: 'notification', ...notification })
      }
    }
  }

  /** start lifecycle fact (only read):start() complete (harness.resume after the same sync segment) is true. */
  get started(): boolean {
    return this.#started
  }

  async start(): Promise<void> {
    this.assertWritable()
    if (this.#started) return
    if (this.startPromise) return this.startPromise
    const attempt = (async () => {
      if (this.pluginHost) await this.pluginHost.start()
      this.harness.resume()
      // resume after the same sync segment placement (without await interval): external isStarted() read to true
      // when scheduler must however already leave paused.
      this.#started = true
      await this.emitHostEvent('runtime.started', {}, { broadcast: false })
    })()
    this.startPromise = attempt
    try {
      await attempt
    } catch (error) {
      // failed clear single fly handle (identity validate guard against mistakenly clean concurrency new attempt): after continue invoke can retry,
      // while is not forever receives the same stale reject.
      if (this.startPromise === attempt) this.startPromise = undefined
      throw error
    }
  }

  setHubUrl(url: string): void {
    if (typeof url !== 'string' || url === '') {
      throw new HelmError('validation_error', `hub URL must be non-empty string:${String(url)}`, 400)
    }
    this.hubUrlValue = url
  }

  buildSpawnEnv(
    conversationId: number,
    cwd: string,
    nodeId?: string,
    options?: { secretNames?: string[] },
  ): Record<string, string> {
    return this.agentSpawn.buildSpawnEnv(conversationId, cwd, nodeId, options)
  }

  // ------------------------------------------------------------------
  // node manage delegate (RuntimeNodeOperations)
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
  // Hub side foreground port forwarding (NodeForwardService)
  // ------------------------------------------------------------------

  async startNodeForward(nodeId: string, input: NodeForwardInput): Promise<NodeForwardSession> {
    return await this.nodeForward.start(nodeId, input)
  }

  async stopNodeForward(forwardId: string): Promise<void> {
    await this.nodeForward.stop(forwardId)
  }

  getNodeForward(forwardId: string): NodeForwardSession | undefined {
    return this.nodeForward.get(forwardId)
  }

  listNodeForwards(): NodeForwardSession[] {
    return this.nodeForward.list()
  }

  onNodeForwardEvent(forwardId: string, listener: (event: NodeForwardEvent) => void): () => void {
    return this.nodeForward.onEvent(forwardId, listener)
  }

  onNodeForwardStopped(forwardId: string, listener: () => void): () => void {
    return this.nodeForward.onStopped(forwardId, listener)
  }

  acquireNodeForwardLease(forwardId: string): () => void {
    return this.nodeForward.acquireLease(forwardId)
  }

  // ------------------------------------------------------------------
  // artifact authorization / attachment delegate (ConversationService)
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
  // plugin tool hot install
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
      throw new HelmError('internal_error', 'PluginHost not yet access KernelRuntime(initialize not invoke)', 500)
    }
    return this.pluginHost
  }

  private async dispatchTurnSettled(payload: TurnSettledPayload, consumed: ConversationInput[]): Promise<void> {
    const convId = payload.conversation.id
    for (const [id, entry] of this.handledToolCalls) {
      if (entry.conversationId === convId) this.handledToolCalls.delete(id)
    }
    // turn effect domain secret in this turn right threat compute point reclaim (completed/failed/aborted unify via this,
    // settledRuns guard against double report): first at hook chain push enter compute order - -turn_settled chain inside late register
    //  turn secret out generate order = new counter, belong under one turn, do not by this time mistakenly scan; only stop inject,
    // byUuid old value keep continue redaction.
    this.stashService.settleTurn(convId)
    const turnEvent: TurnSettledPayload = { ...payload, inputs: consumed }
    try {
      const outcome = await this.svc.hookBridge.runHookChain('turn_settled', turnEvent)
      if (outcome?.action === 'handled') return
      this.events.publish('turn.settled', outcome?.action === 'transform' ? outcome.value : turnEvent)
    } catch (error) {
      // this run will by gather settledInflight(teardown in etc. it converge): plugin hook or
      // event publish throws never reject(will interrupt closure stop and toxic aggregate chain), such as record after end.
      this.emitDiagnostic({
        level: 'error',
        source: 'runtime.turn_settled',
        message: 'turn_settled dispatch failed',
        error,
        conversationId: convId,
      })
    }
  }

  // ------------------------------------------------------------------
  // conversation operation delegate (ConversationService)
  // ------------------------------------------------------------------

  listConversations(filter?: ConversationListFilter): ConversationSummary[] {
    return this.conversations.listConversations(filter)
  }

  getConversation(id: number): ConversationSummary {
    return this.conversations.getConversation(id)
  }

  getConversationDetail(id: number, options?: Parameters<ConversationService['getConversationDetail']>[1]): Promise<ConversationDetail> {
    return this.conversations.getConversationDetail(id, options)
  }

  /** single timeline item (not truncate, already redaction;GET /api/conversations/:id/entries/:entryId). */
  getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    return this.conversations.getConversationEntry(id, entryId)
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    this.assertWritable()
    return this.conversations.createConversation(init)
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    this.assertWritable()
    return this.conversations.updateConversation(id, patch)
  }

  async deleteConversation(id: number): Promise<void> {
    this.assertWritable()
    return this.conversations.deleteConversation(id)
  }

  async submitInput(
    id: number,
    text: string,
    opts?: Parameters<ConversationService['submitInput']>[2],
  ): Promise<{ submissionId: string }> {
    this.assertWritable()
    return this.conversations.submitInput(id, text, opts)
  }

  async waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> {
    return this.conversations.waitForInput(id, submissionId, signal)
  }

  async abortConversation(id: number): Promise<void> {
    this.assertWritable()
    return this.conversations.abortConversation(id)
  }

  /** automatically guarded abort (Watchdog hard rule kernel execute layer): re-check and SDK abort invoke atomic adjacent. */
  async abortConversationGuarded(
    id: number,
    guard: Parameters<ConversationService['abortConversationGuarded']>[1],
  ): Promise<void> {
    this.assertWritable()
    return this.conversations.abortConversationGuarded(id, guard)
  }

  /** automatically guarded commit: commit point atomic re-check ownership/watermark; failed 409/404 zero commit side effect. */
  async submitInputGuarded(
    id: number,
    text: string,
    opts?: Parameters<ConversationService['submitInput']>[2],
    guard: Parameters<ConversationService['submitInputGuarded']>[3] = {},
  ): Promise<{ submissionId: string }> {
    this.assertWritable()
    return this.conversations.submitInputGuarded(id, text, opts, guard)
  }

  async withdrawQueuedInput(id: number, opts: { submissionId: number }): Promise<ConversationWithdrawResponse> {
    this.assertWritable()
    return this.conversations.withdrawQueuedInput(id, opts)
  }

  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertWritable()
    return this.conversations.resetConversation(id, opts)
  }

  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertWritable()
    return this.conversations.compactConversation(id, opts)
  }

  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertWritable()
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
    this.assertWritable()
    await this.conversations.rebuildFts(() => this.listConversations().map((c) => ({ id: c.id, title: c.title })))
  }

  async alignProfileConversations(profileId: string): Promise<void> {
    this.assertWritable()
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
  // trigger delegate (RuntimeTriggerDispatcher)
  // ------------------------------------------------------------------

  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    this.assertWritable()
    return this.svc.triggers.dispatchTrigger(envelope)
  }

  // ------------------------------------------------------------------
  // subagent derive delegate (RuntimeAgentSpawn;spawnAgent/runGate is public entry,
  // target parse/occupy snapshot/execute fact by host backend direct connect this.agentSpawn)
  // ------------------------------------------------------------------

  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    this.assertWritable()
    return this.agentSpawn.spawnAgent(request)
  }

  runGate(
    command: string,
    options: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
      gateTimeoutMs?: number
    } = {},
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> {
    return this.agentSpawn.runGate(command, options)
  }

  // ------------------------------------------------------------------
  // directory coordinates query
  // ------------------------------------------------------------------

  async skillDirectory(id: string): Promise<string> {
    // plugin self raise directory always points to can write dataDir; sharing only via SkillService.readFile read.
    return this.svc.skillsSvc.directory(id)
  }

  async profileDirectory(id: string): Promise<string> {
    return profileDirectoryHelper(this.dataDir, id)
  }

  // ------------------------------------------------------------------
  // conversation ownership and run fact delegate (RuntimeOwnershipManager)
  // ------------------------------------------------------------------

  getConversationOwnership(conversationId: number): ConversationOwnership {
    return this.svc.ownership.getOwnership(conversationId)
  }

  // ------------------------------------------------------------------
  // async approval delegate (AskService)
  // ------------------------------------------------------------------

  listAsks(status?: string): AskSpec[] {
    return this.svc.asks.listAsks(status)
  }

  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    this.assertWritable()
    return this.svc.asks.createAsk(spec)
  }

  async answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<AskSpec> {
    this.assertWritable()
    return this.svc.asks.answerAsk(id, answers, expectedStateSeq)
  }

  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    this.assertWritable()
    await this.svc.asks.cancelAsk(id, reason ?? 'cancelled')
  }

  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    return this.svc.asks.registerSeqResolver(resolver)
  }

  // ------------------------------------------------------------------
  // model set and Provider manage delegate (ModelRegistry)
  // ------------------------------------------------------------------

  async listModels(): Promise<ModelCatalog> {
    return this.modelsRegistry.listModels()
  }

  /** settings model disable collection (PUT /api/models/filter):undefined provider empty all. */
  async setDisabledModels(provider: string | undefined, disabledModels: string[]): Promise<ModelCatalog> {
    return this.modelsRegistry.setDisabledModels(provider, disabledModels)
  }

  /** model disable preflight (HTTP profile save etc. entry; disable model 409 model_disabled). */
  assertModelEnabled(provider: string, modelId: string): void {
    this.modelsRegistry.assertModelEnabled(provider, modelId)
  }

  async setDefaultModel(model?: string, thinkingLevel?: string): Promise<void> {
    const validateLevel = (level: string) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `thinkingLevel '${level}' illegal; legal value:${[...THINKING_LEVELS].join(' | ')}`,
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
    this.assertWritable()
    this.svc.ownership.markOwnership(conversationId, owner)
  }

  manageConversation(conversationId: number, pluginId: string): () => void {
    return this.svc.ownership.manage(conversationId, pluginId)
  }

  // ------------------------------------------------------------------
  // service and context Getters
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
  /** @internal supply test and internal coordinate tune read tracker */
  private get tracker() { return this.svc.tracker }
  /** @internal supply test read internal toolDeps */
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
    // autoResume=false when start() may still in-flight: first etc. it converge (failed do not block assert closure stop),
    // avoid teardown and plugin start concurrency hand over wrong (such as service start in route by dispose).
    if (this.startPromise !== undefined) await this.startPromise.catch(() => {})
    await teardownKernelRuntime({
      modelsRegistry: this.modelsRegistry,
      assetReloader: this.svc.assetReloader,
      nodes: this.nodes,
      settledInflight: () => this.settledInflight,
      store: this.store,
      harness: this.harness,
      tracker: this.svc.tracker,
      pluginHost: this.pluginHost,
      nodeForward: this.nodeForward,
      envFabric: this.envFabric,
      processTokenHandle: this.processTokenHandle,
      database: this.database,
      events: this.events,
      sessionDocStreams: this.svc.sessionDocStreams,
      sessionDocLifecycleRelease: this.svc.sessionDocLifecycleRelease,
      stashService: this.stashService,
      emitDiagnostic: (input) => this.emitDiagnostic(input),
    })
    this.processTokenHandle = undefined
  }
}
