/**
 * Minimal `@helm/kernel` runtime facade (microkernel base).
 *
 * Responsibilities:
 * - Assemble and wire all kernel mechanisms (`pi-durable` / SQLite / FTS5 / `EnvFabric` / `PluginHost` / `Models`);
 * - Manage unified lifecycle (`open` / `initialize` / `start` / `close`);
 * - Expose a strongly-typed facade API for HTTP routes and CLI consumers;
 * - Delegate complex orchestration and operations to cohesive submodules:
 *   `RuntimeNodeOperations`, `RuntimeTriggerDispatcher`, `RuntimeAgentSpawn`,
 *   `RuntimeOwnershipManager`, `createPluginHostBackend`, and `RuntimeToolRegistry`.
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
  readWorkspaceFile,
  type ConversationFileContent,
} from './workspace-files.js'
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
  /** Dedicated event surface for conversation session docs (HTTP `sessionDocEvents` port; single instance wired in constructor). */
  readonly sessionDocEvents: SessionDocEventHub
  private readonly stashService = new SecretStash()
  private readonly hostEventListeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  readonly envFabric: EnvFabric
  /** Hub-side foreground port forwarding (listeners live only during commands; cleaned up on close). */
  readonly nodeForward: NodeForwardService
  private processTokenHandle: { tokenOf(): string | undefined; dispose(): void } | undefined
  private hubUrlValue: string
  private pluginHost: PluginHost | undefined
  /** Startup lifecycle fact (read-only for service wiring; flipped synchronously right after `resume` — see `start()`). */
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
  /** Subagent spawning, target resolution, and occupancy snapshot service (connected directly to host backend without double forwarding). */
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
    if (options.models !== undefined && options.providers !== undefined) {
      throw new HelmError(
        'validation_error',
        'KernelRuntimeOptions.models and KernelRuntimeOptions.providers are mutually exclusive',
        400,
      )
    }
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
      providers: options.providers,
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

    // Assemble and wire all internal kernel services
    this.svc = assembleRuntimeServices(this, init, {
      store: this.store,
      stashService: this.stashService,
      handledToolCalls: this.handledToolCalls,
      dispatchTurnSettled: (payload, consumed) => this.dispatchTurnSettled(payload, consumed),
      onSettleInflight: (run) => {
        // Absorb errors per run: teardown awaits `settledInflight()` three times; any unhandled rejection
        // would abort shutdown (skipping store/database closes and leaking handles) and poison subsequent joins.
        // Failures are logged faithfully rather than silently swallowed.
        const absorbed = run.then(
          () => undefined,
          (error) => {
            this.emitDiagnostic({
              level: 'error',
              source: 'runtime.settle',
              message: 'Turn settlement chain failed (absorbed so shutdown is not blocked)',
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

    // Single delivery boundary for internal host events: after each SSE broadcast, `EventHub.publish` delivers
    // once to `ctx.host.onEvent` listeners (validated + redacted HelmEvent envelope). Kernel automatic events
    // (tracker/asks publishing directly via `events.publish`) are fire-and-forget so synchronous observation paths
    // like SDK advance never block; public `emitHostEvent` awaits delivery per contract without double-dispatching.
    this.events.setHostDispatcher((event) => this.dispatchInternalEvent(event.type, event))

    this.nodeOps.bindEvents()

    // Managed process token
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
    this.init.setCompactionModelResolver(() => ({
      model: this.modelsRegistry.defaultCompactionModel,
      isDisabled: (providerId, modelId) => this.modelsRegistry.isModelDisabled(providerId, modelId),
    }))
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
        throw new HelmError('config_corrupt', `Invalid config.json.thinkingLevel (valid values: ${[...THINKING_LEVELS].join(' | ')})`, 500)
      }
    })
    await this.modelsRegistry.loadDefaultsFromConfig()
    if (this.init.providers !== undefined && this.init.externalModels === undefined) {
      for (const provider of this.init.providers) {
        await this.modelsRegistry.registerRuntimeProvider(provider)
      }
    }

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
    // Warm managed package install records (`config.json` `pluginPackages`; throws on corruption) before attaching manager.
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
        `Managed skill '${asset.id}' for plugin '${pluginId}' must declare 'managedByPlugin: ${pluginId}' in SKILL.md frontmatter (got: ${managed?.[1] ?? 'missing'})`,
        400,
        { pluginId, skillId: asset.id },
      )
    }
    await this.svc.skillsSvc.ensureSkill(asset)
  }

  emitHostEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void> {
    if (options?.broadcast === false) {
      if (type === 'plugin.changed' || type === 'plugin.session_doc.updated' || type.trim() === '') {
        throw new HelmError('invalid_event', 'Host lifecycle events cannot be overridden for private dispatch', 400)
      }
      return this.dispatchInternalEvent(type, payload)
    }
    if (type === 'plugin.changed') {
      try {
        this.refreshPluginTools()
      } catch (error) {
        // Tool hot-install failures must not block publishing `plugin.changed` (clients must still observe plugin state transitions);
        // never leak the exception to the caller either — record diagnostics faithfully.
        this.emitDiagnostic({
          level: 'error',
          source: 'runtime.plugins',
          message: 'Failed to refresh plugin tools after plugin.changed',
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
    // Broadcast internal listener delivery is handled solely by `EventHub` (single delivery after SSE broadcast
    // using the validated + redacted envelope); return `.internal` so `emitEvent` callers can still await delivery.
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
    // Isolate listeners: callers (such as `emitEvent` statements in plugin-host) may neither await nor catch,
    // so throwing in one listener must neither block remaining listeners nor cause an unhandledRejection.
    const run = (async () => {
      for (const listener of [...listeners]) {
        try {
          await listener(payload)
        } catch (error) {
          this.emitDiagnostic({
            level: 'error',
            source: 'runtime.events',
            message: `Internal event listener failed (${type})`,
            error,
          })
        }
      }
    })()
    return run
  }

  /** Fatal storage fault state (read-only): set after a Harness Storage fault or `HelmStore` persistence failure. */
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
            `Fatal storage fault (${source}): ${safeDetail}`,
            500,
            { source },
          )
    if (this.#fatalError === undefined) {
      this.#fatalError = recorded
    }
    this.emitDiagnostic({
      level: 'error',
      source,
      message: source === 'store' ? 'HelmStore persistence failed; kernel entered fatal fault state' : 'Harness closed due to fatal storage fault',
      error,
    })
    if (!this.fatalStorageNotified) {
      this.fatalStorageNotified = true
      const notification = {
        level: 'error' as const,
        title: source === 'store' ? 'Kernel persistence fault' : 'Kernel storage engine exited unexpectedly',
        body: recorded.message,
      }
      try {
        this.events.publish('notification', notification)
      } catch {
        // When store is already in failed state, `persistSeq` throws `store_flush_failed`;
        // still notify internal host listeners at least once without throwing again.
        void this.dispatchInternalEvent('notification', { type: 'notification', ...notification })
      }
    }
  }

  /** Startup lifecycle fact (read-only): true once `start()` completes (same synchronous slice after `harness.resume`). */
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
      // Flipped synchronously right after resume (zero awaits in between): whenever `isStarted()` is true,
      // the scheduler has already left its paused state.
      this.#started = true
      await this.emitHostEvent('runtime.started', {}, { broadcast: false })
    })()
    this.startPromise = attempt
    try {
      await attempt
    } catch (error) {
      // Clear in-flight handle only if it is still this attempt (avoids clobbering concurrent retries).
      if (this.startPromise === attempt) this.startPromise = undefined
      throw error
    }
  }

  setHubUrl(url: string): void {
    if (typeof url !== 'string' || url === '') {
      throw new HelmError('validation_error', `Hub URL must be a non-empty string: ${String(url)}`, 400)
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
  // Node management delegation (RuntimeNodeOperations)
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
  // Hub-side foreground port forwarding (NodeForwardService)
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
  // Artifact authorization / attachments delegation (ConversationService)
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
  // Plugin tool hot installation
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
      throw new HelmError('internal_error', 'PluginHost is not attached to KernelRuntime yet (initialize not called)', 500)
    }
    return this.pluginHost
  }

  private async dispatchTurnSettled(payload: TurnSettledPayload, consumed: ConversationInput[]): Promise<void> {
    const convId = payload.conversation.id
    for (const [id, entry] of this.handledToolCalls) {
      if (entry.conversationId === convId) this.handledToolCalls.delete(id)
    }
    // Reclaim turn-scoped secrets at this turn's authoritative settlement point (unified across completed/failed/aborted;
    // `settledRuns` prevents duplicate firing): must run before entering hook chain so newly registered turn secrets
    // generated inside `turn_settled` receive a higher counter (for the next turn) and are not swept away here; stops
    // injection only while keeping old `byUuid` values redacted.
    this.stashService.settleTurn(convId)
    const turnEvent: TurnSettledPayload = { ...payload, inputs: consumed }
    try {
      const outcome = await this.svc.hookBridge.runHookChain('turn_settled', turnEvent)
      if (outcome?.action === 'handled') return
      this.events.publish('turn.settled', outcome?.action === 'transform' ? outcome.value : turnEvent)
    } catch (error) {
      // Collected into `settledInflight` (joined during teardown): plugin hook or event publish throws
      // must never reject (which would block shutdown and poison the aggregate chain); log diagnostics instead.
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
  // Conversation operations delegation (ConversationService)
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

  /** Fetch a single redacted timeline entry untruncated (`GET /api/conversations/:id/entries/:entryId`). */
  getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    return this.conversations.getConversationEntry(id, entryId)
  }

  /** read a file strictly inside conversation's bound workspace (text files are redacted via SecretStash). */
  async readConversationFile(
    id: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<ConversationFileContent> {
    const summary = this.getConversation(id)
    return readWorkspaceFile({
      nodeId: summary.nodeId ?? 'local',
      cwd: summary.cwd,
      rawPath: path,
      envFabric: this.envFabric,
      redact: (text) => this.stashService.redact(text),
      signal,
    })
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

  /** Guarded automatic abort (Watchdog kernel enforcement): re-check and SDK abort run atomically back-to-back. */
  async abortConversationGuarded(
    id: number,
    guard: Parameters<ConversationService['abortConversationGuarded']>[1],
  ): Promise<void> {
    this.assertWritable()
    return this.conversations.abortConversationGuarded(id, guard)
  }

  /** Guarded automatic submit: re-checks ownership/watermark atomically at commit; 409/404 produces zero side effects. */
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
  // Trigger dispatch delegation (RuntimeTriggerDispatcher)
  // ------------------------------------------------------------------

  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    this.assertWritable()
    return this.svc.triggers.dispatchTrigger(envelope)
  }

  // ------------------------------------------------------------------
  // Subagent spawning delegation (`RuntimeAgentSpawn`: `spawnAgent`/`runGate` public entries;
  // target resolution, occupancy snapshots, and execution facts bind `this.agentSpawn` directly on host backend)
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
  // Directory coordinate lookups
  // ------------------------------------------------------------------

  async skillDirectory(id: string): Promise<string> {
    // Plugin-bootstrapped skills always target the writable `dataDir`; shared roots are read-only via `SkillService.readFile`.
    return this.svc.skillsSvc.directory(id)
  }

  async profileDirectory(id: string): Promise<string> {
    return profileDirectoryHelper(this.dataDir, id)
  }

  // ------------------------------------------------------------------
  // Conversation ownership & live fact delegation (RuntimeOwnershipManager)
  // ------------------------------------------------------------------

  getConversationOwnership(conversationId: number): ConversationOwnership {
    return this.svc.ownership.getOwnership(conversationId)
  }

  // ------------------------------------------------------------------
  // Async approval delegation (AskService)
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
  // Model catalog & provider management delegation (ModelRegistry)
  // ------------------------------------------------------------------

  async listModels(): Promise<ModelCatalog> {
    return this.modelsRegistry.listModels()
  }

  /** Set disabled models (`PUT /api/models/filter`): clears all when `provider` is undefined. */
  async setDisabledModels(provider: string | undefined, disabledModels: string[]): Promise<ModelCatalog> {
    return this.modelsRegistry.setDisabledModels(provider, disabledModels)
  }

  /** Disabled-model preflight (used by HTTP profile saves, etc.; returns `409 model_disabled`). */
  assertModelEnabled(provider: string, modelId: string): void {
    this.modelsRegistry.assertModelEnabled(provider, modelId)
  }

  async setDefaultModel(model?: string, thinkingLevel?: string, compactionModel?: string): Promise<void> {
    const validateLevel = (level: string) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `Invalid thinkingLevel '${level}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
    }
    await this.modelsRegistry.setDefaultModel(model, thinkingLevel, validateLevel, compactionModel)
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
  // Service & context Getters
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
  /** @internal exposed for tests and internal coordinator access */
  private get tracker() { return this.svc.tracker }
  /** @internal exposed for tests to inspect internal `toolDeps` */
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
    // With autoResume=false, `start()` may still be in flight: wait for it to settle first (ignore failures
    // so shutdown proceeds) to avoid racing teardown against plugin service startup (e.g., disposing mid-start).
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
