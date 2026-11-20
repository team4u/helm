/**
 * RuntimeServices: service dependency assembly factory for `KernelRuntime` (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - Centrally instantiate and wire internal kernel sub-services;
 * - Resolve mutual dependencies and closure wiring (`toolDeps`, `tracker`, `conversations`, `hookBridge`, etc.);
 * - Maintain clear unidirectional ownership and lifecycles instead of piling 300+ lines of wiring in `KernelRuntime`'s constructor.
 */

import type { Provider } from '@earendil-works/pi-ai'
import type {
  ConversationInit,
  ConversationInput,
  ConversationPatch,
  ConversationSummary,
  ModelsChangedEvent,
  PluginBuildProvider,
  TurnSettledPayload,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { ConversationOwnership } from './runtime-ownership.js'
import {
  ArtifactService as SvcArtifactService,
  AuthService as SvcAuthService,
  ConfigService,
  CredentialService,
  defaultExternalSkillRoots,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
} from '../services/index.js'
import { createEnvFabric, tokenAuthenticator, type EnvFabric } from '../env/index.js'
import { AskService } from './asks.js'
import { ConversationTracker } from './conversations.js'
import { EventHub, SessionDocEventHub } from './events.js'
import type { HelmxStore } from './store.js'
import type { HelmxToolDeps } from './tool-deps.js'
import { buildManagedEnv } from './tools.js'
import { HelmxPluginConfigStore } from './plugin-config-store.js'
import { ConversationService } from './conversation-service.js'
import { NodeManager } from './node-manager.js'
import { ModelRegistry } from './model-registry.js'
import { HookBridge, prepareToolResultWith } from './hook-bridge.js'
import { RuntimeToolRegistry } from './tool-registry.js'
import { AssetReloader } from './asset-reloader.js'
import { requireConv } from './runtime-helpers.js'
import { RuntimeNodeOperations } from './runtime-nodes.js'
import { RuntimeTriggerDispatcher } from './runtime-triggers.js'
import { RuntimeAgentSpawn } from './runtime-agent-spawn.js'
import { trustedPlatformFromEnvFabric } from './target-cwd.js'
import { RuntimeOwnershipManager } from './runtime-ownership.js'
import { createGlobalDocumentStore } from './runtime-host-backend.js'
import type { KernelRuntime } from './runtime.js'
import type { BootstrappedKernelContext } from './runtime-bootstrap.js'

export interface RuntimeServicesInit extends BootstrappedKernelContext {
  /** Injected Hub platform fact (for tests; defaults to `process.platform`). */
  hubPlatform?: () => string | undefined
  defaultModel?: string
  cwd: string
  hubUrl?: string
  seedKeyCache: Record<string, string>
  autoResume: boolean
  /** Startup node-join grace budget (ms; 0 disables) — see `runtime-bootstrap.ts` KernelBootOptions.nodeJoinGraceMs. */
  nodeJoinGraceMs?: number
  externalModels?: unknown
  /** Initial runtime providers passed through `KernelRuntimeOptions.providers`. */
  providers?: ReadonlyArray<Provider>
  /** Machine-level shared skill roots scanned together (defaults to `defaultExternalSkillRoots()`). */
  externalSkillRoots?: readonly string[]
  /** Plugin build port (`KernelBootOptions.buildProvider` passthrough; Hub injects default implementation). */
  buildProvider?: PluginBuildProvider
  nodeUpgradeTimeoutMs: number
}

export interface AssembledRuntimeServices {
  profilesSvc: ProfileService
  skillsSvc: SkillService
  configSvc: ConfigService
  credentialsSvc: CredentialService
  providersSvc: ProviderService
  pluginConfig: HelmxPluginConfigStore
  artifactsSvc: SvcArtifactService
  authSvc: SvcAuthService
  modelsRegistry: ModelRegistry
  envFabric: EnvFabric
  toolDeps: HelmxToolDeps
  nodes: NodeManager
  nodeOps: RuntimeNodeOperations
  ownership: RuntimeOwnershipManager
  agentSpawn: RuntimeAgentSpawn
  events: EventHub
  sessionDocStreams: SessionDocEventHub
  sessionDocLifecycleRelease: () => void
  asks: AskService
  tracker: ConversationTracker
  conversations: ConversationService
  hookBridge: HookBridge
  triggers: RuntimeTriggerDispatcher
  toolRegistry: RuntimeToolRegistry
  assetReloader: AssetReloader
}

export function assembleRuntimeServices(
  runtime: KernelRuntime,
  init: RuntimeServicesInit,
  options: {
    store: HelmxStore
    stashService: SecretStash
    handledToolCalls: Map<string, { conversationId: number | undefined; result: { output: Array<{ type: 'text'; text: string }>; isError: boolean } }>
    dispatchTurnSettled(payload: TurnSettledPayload, consumed: ConversationInput[]): Promise<void>
    onSettleInflight(run: Promise<void>): void
    safeSummary(id: number): ConversationSummary | undefined
    submitInput(id: number, text: string, opts?: Parameters<ConversationService['submitInput']>[2]): Promise<unknown>
    createConversation(init: ConversationInit): Promise<ConversationSummary>
    updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  },
): AssembledRuntimeServices {
  // Scan machine-level shared skill roots alongside workspace skills; pass an empty array to isolate fully in tests.
  const skillsSvc = new SkillService(init.dataDir, {
    externalRoots: init.externalSkillRoots ?? defaultExternalSkillRoots(),
  })
  const configSvc = new ConfigService(init.dataDir)
  const credentialsSvc = init.credentials
  const providersSvc = init.providersSvc
  const pluginConfig = new HelmxPluginConfigStore({ config: configSvc, credentials: credentialsSvc })

  const artifactRepo = {
    get: (id: string) => options.store.getArtifact(id),
    list: (cId: number) => options.store.listArtifacts(cId),
    put: (meta: never) => { options.store.putArtifact(meta) },
    deleteByConversation: (cId: number) => { options.store.deleteArtifactsByConversation(cId) },
  }
  const artifactsSvc = new SvcArtifactService(init.dataDir, artifactRepo, options.stashService)
  const authSvc = new SvcAuthService(init.dataDir)

  options.store.ftsRedact = (t) => options.stashService.redact(t)

  const sessionDocStreams = new SessionDocEventHub()
  sessionDocStreams.redact = (t) => options.stashService.redact(t)

  let asks: AskService
  let tracker: ConversationTracker
  let nodes: NodeManager
  let conversations: ConversationService

  const events = new EventHub({
    initialSeq: options.store.eventSeqNow,
    snapshot: () => ({
      seq: options.store.eventSeqNow,
      conversations: runtime.listConversations(),
      pendingAsks: asks ? asks.listAsks('pending') : [],
      plugins: runtime.plugins ? runtime.plugins.list() : [],
      ui: runtime.plugins ? runtime.plugins.listUi() : [],
      pluginDocs: runtime.plugins?.listPublicDocs() ?? [],
      conversationLives: tracker ? tracker.listLiveViews() : [],
      nodes: nodes ? nodes.listNodesSync() : [],
    }),
    persistSeq: (seq) => options.store.setEventSeq(seq),
  })
  events.redactFn = (t) => options.stashService.redact(t)

  // ProfileService publishes `profile.changed` through the global EventHub after successful save/delete
  // (HTTP/CLI writes and plugin bootstraps), so connected Web clients refresh the profile catalog.
  const profilesSvc = new ProfileService(init.dataDir, { publish: (type, payload) => events.publish(type, payload) })

  const sessionDocLifecycleRelease = events.subscribe((frame) => {
    const event = frame.event
    if (event.type === 'plugin.changed' && 'plugin' in event && event.plugin.enabled === false) {
      sessionDocStreams.closeForPlugin(event.plugin.id)
    } else if (event.type === 'conversation.deleted' && 'conversationId' in event) {
      sessionDocStreams.closeForConversation(event.conversationId)
    } else if (event.type === 'models.changed' && 'payload' in event) {
      // Model windows may change after catalog refresh or rebuild (unknown -> known / value updated / provider gone):
      // force-recompute cached context usage on already-observed conversations. Startup events emitted before
      // tracker assembly are intentionally ignored (caches are empty at startup and compute lazily from the new catalog).
      const providers = (event as ModelsChangedEvent).payload.providers
      tracker?.onModelsChanged(Array.isArray(providers) ? providers : [])
    }
  })

  // ---- Model Registry ----
  const modelsRegistry = new ModelRegistry(
    {
      dataDir: init.dataDir,
      providersSvc,
      credentialsSvc,
      configSvc,
      stash: options.stashService,
      modelsStore: init.modelsStore,
      setModels: init.setModels,
      externalModels: init.externalModels !== undefined,
      events,
      pluginHost: () => runtime.plugins,
      alignAllConversations: async () => {
        for (const meta of options.store.listConvs()) {
          await conversations.alignConversationModel(meta.id, true)
        }
      },
    },
    init.modelsInstance,
    { model: init.defaultModel },
  )
  Object.assign(modelsRegistry.apiKeyCache, init.seedKeyCache)

  // ---- Cross-platform node substrate (EnvFabric) ----
  const envFabric = createEnvFabric({
    hubPlatform: init.hubPlatform,
    authenticate: tokenAuthenticator((nodeId) => nodes?.nodeDigestOf(nodeId)),
    cliBinDir: () => nodes?.cliBinDir,
    envOptions: ({ conversationId, cwd, nodeId }) =>
      buildManagedEnv(toolDeps, cwd, conversationId, nodeId),
  })

  // ---- Tool dependency bundle ----
  const toolDeps: HelmxToolDeps = {
    dataDir: init.dataDir,
    defaultCwd: init.cwd,
    get hubUrl(): string { return runtime.hubUrl },
    stashEnvFor: (id) => options.stashService.envFor(id),
    redact: (t) => options.stashService.redact(t),
    processToken: () => runtime.processToken,
    artifacts: artifactsSvc,
    envFabric,
    nodeIdOf: (id) => options.store.getConv(id)?.nodeId ?? 'local',
    restrictToCwdOf: async (id) => {
      const meta = options.store.getConv(id)
      if (meta?.profileId === undefined) return false
      try {
        return (await profilesSvc.get(meta.profileId))?.restrictToCwd === true
      } catch (error) {
        throw new HelmxError(
          'profile_read_failed',
          `cannot determine restrictToCwd for profile '${meta.profileId}' of conversation ${id}: ${error instanceof Error ? error.message : String(error)}`,
          500,
          { conversationId: id, profileId: meta.profileId },
        )
      }
    },
    get cliBinDir(): string | undefined { return nodes?.cliBinDir },
  }

  nodes = new NodeManager({
    dataDir: init.dataDir,
    envFabric,
    configSvc,
    stash: options.stashService,
    toolDeps,
    events,
    nodeUpgradeTimeoutMs: init.nodeUpgradeTimeoutMs,
    convOf: (id) => requireConv(options.store, id),
  })

  const nodeOps = new RuntimeNodeOperations({
    nodes,
    envFabric,
    events,
  })

  // ---- Conversation ownership management ----
  const ownership = new RuntimeOwnershipManager({
    store: options.store,
    documentStore: createGlobalDocumentStore(options.store),
    events,
    conversations: {
      summaryWithOwnership: (id) => conversations.summaryWithOwnership(id),
    },
  })

  // ---- Conversation tracking ----
  tracker = new ConversationTracker({
    harness: init.harness,
    store: options.store,
    redactError: (text) => options.stashService.redact(text),
    // Turn unread-count policy: background spawned sub-conversations (helmx/bot-owned with a parent chain) are not marked unread.
    ownershipOf: (id) => ownership.getOwnership(id),
    // Context usage: window resolved from live `Models` registry (never fabricated when unknown).
    models: () => modelsRegistry.models,
    isClosed: () => runtime.isClosing,
    events: {
      onSummaryChanged: (summary) => {
        if (options.store.getConv(summary.id) === undefined || options.store.isDeleted(summary.id)) return
        events.publish('conversation.upsert', conversations.withOwnership(summary))
      },
      onInputCommitted: (conversationId, input) => {
        options.store.indexFts(conversationId, `input:${input.id}`, options.store.getConv(conversationId)?.title ?? '', input.text)
      },
      onAssistantText: (conversationId, entryId, text) => {
        tracker.recordAssistantText(conversationId, entryId, text)
        options.store.indexFts(conversationId, `entry:${entryId}`, options.store.getConv(conversationId)?.title ?? '', text)
      },
      onEntryCommitted: (conversationId, entry) => {
        events.publish('conversation.entry', { conversationId, entry })
      },
      onLiveChanged: (live) => {
        events.publishTransientLive(live)
      },
      onNotification: (payload) => {
        events.publish('notification', payload)
      },
      onTurnSettled: (payload, consumed) => {
        const run = options.dispatchTurnSettled(payload, consumed)
        options.onSettleInflight(run)
        return run
      },
    },
  })

  // ---- Async approval service ----
  asks = new AskService({
    store: options.store,
    stash: options.stashService,
    validateConversation: (id) => options.store.getConv(id) !== undefined,
    onEvent: (type, payload) => events.publish(type, payload),
    onConvPendingChanged: (id) => {
      tracker.setPendingAskCount(id, asks.pendingCount(id))
    },
  })

  // ---- hook bridge ----
  const hookBridge = new HookBridge({
    registry: init.registry,
    pluginHost: () => runtime.plugins,
    handledToolCalls: options.handledToolCalls,
    prepareToolResult: (conversationId, result) =>
      prepareToolResultWith(artifactsSvc, (t) => options.stashService.redact(t), conversationId, result),
    safeSummary: (id) => options.safeSummary(id),
    currentRunInputs: (id) => tracker.currentRunInputs(id),
    redact: (t) => options.stashService.redact(t),
    artifacts: artifactsSvc,
  })

  // ---- conversation service ----
  conversations = new ConversationService({
    harness: init.harness,
    storage: init.database.storage,
    store: options.store,
    tracker,
    events,
    profilesSvc,
    artifactsSvc,
    stash: options.stashService,
    dataDir: init.dataDir,
    toolDeps: { defaultCwd: init.cwd },
    evictConversationBase: (id) => envFabric.evictConversation(id),
    managedConversations: ownership.managedConversations,
    cancelAsksByConversation: async (id) => {
      await asks.cancelByConversation(id)
    },
    cancelPendingAsksForRewrite: async (id) => {
      const pendingAsks = asks.listPendingByConversation(id)
      await Promise.all(pendingAsks.map((ask) => asks.cancelAsk(ask.id, 'superseded')))
    },
    evictHandledToolCalls: (convId) => {
      for (const [id, entry] of options.handledToolCalls) {
        if (entry.conversationId === convId) options.handledToolCalls.delete(id)
      }
    },
    markOwnership: (id, owner) => ownership.markOwnership(id, owner),
    ownershipOf: (id) => ownership.getOwnership(id),
    runInputHook: (payload) => hookBridge.runHookChain('input', payload),
    isClosed: () => runtime.isClosing,
    isStarted: () => runtime.started,
    defaultModel: () => modelsRegistry.defaultModel,
    defaultThinkingLevel: () => modelsRegistry.defaultThinkingLevel,
    modelThinkingLevelOf: (ref) => modelsRegistry.modelThinkingLevelOf(ref),
    models: () => modelsRegistry.models,
    parseModelRefOrThrow: (ref) => modelsRegistry.parseModelRefOrThrow(ref),
    assertModelEnabled: (provider, modelId) => modelsRegistry.assertModelEnabled(provider, modelId),
    trustedPlatformOf: trustedPlatformFromEnvFabric(envFabric),
  })

  // ---- Native subagent spawning ----
  const agentSpawn = new RuntimeAgentSpawn({
    store: options.store,
    toolDeps,
    harness: init.harness,
    registry: init.registry,
    tracker,
    conversations,
    events,
    envFabric,
    modelsRegistry,
    hookBridge,
    stashService: options.stashService,
    updateConversation: (id, patch) => options.updateConversation(id, patch),
    markConversationOwnership: (id, owner: ConversationOwnership) => ownership.markOwnership(id, owner),
  })

  // ---- Trigger dispatch ----
  const triggers = new RuntimeTriggerDispatcher({
    store: options.store,
    hookBridge,
    getConversation: (id) => runtime.getConversation(id),
    getConversationOwnership: (id) => ownership.getOwnership(id),
    createConversation: (cInit) => options.createConversation(cInit),
    submitInput: (id, text, opts) => options.submitInput(id, text, opts),
  })

  // ---- Tool installation ----
  const toolRegistry = new RuntimeToolRegistry({
    registry: init.registry,
    toolDeps,
    getPluginHost: () => runtime.plugins,
    isArtifactAuthorized: (convId, artifactConvId) =>
      conversations.isArtifactAuthorized(convId, artifactConvId),
    redact: (t) => options.stashService.redact(t),
    handledToolCalls: options.handledToolCalls,
    getConversation: (id) => runtime.getConversation(id),
  })

  // ---- Asset hot-reload coordinator ----
  const assetReloader = new AssetReloader({
    dataDir: init.dataDir,
    externalModels: init.externalModels !== undefined,
    reloadModels: () => runtime.reloadModels(),
    reloadPluginConfig: async () => {
      // Invalidate in-memory snapshots (e.g. AuthService) when `config.json` is edited/cleared externally, then reload plugin config mirror.
      await configSvc.invalidateCache()
      await pluginConfig.load()
    },
    notifyError: (title, error) => {
      events.publish('notification', {
        level: 'error',
        title,
        body: error instanceof Error ? error.message : String(error),
      })
    },
  })

  return {
    profilesSvc,
    skillsSvc,
    configSvc,
    credentialsSvc,
    providersSvc,
    pluginConfig,
    artifactsSvc,
    authSvc,
    modelsRegistry,
    envFabric,
    toolDeps,
    nodes,
    nodeOps,
    ownership,
    agentSpawn,
    events,
    sessionDocStreams,
    sessionDocLifecycleRelease,
    asks,
    tracker,
    conversations,
    hookBridge,
    triggers,
    toolRegistry,
    assetReloader,
  }
}
