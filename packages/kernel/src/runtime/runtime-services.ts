/**
 * RuntimeServices：KernelRuntime 服务依赖装配工厂（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - 集中装配与连接内核内部各项子服务；
 * - 解决服务间的互相依赖与闭包接线（toolDeps, tracker, conversations, hookBridge 等）；
 * - 保证单向依赖与清晰生命周期，避免在 KernelRuntime 构造器中堆砌 300+ 行接线代码。
 */

import type {
  ConversationInit,
  ConversationPatch,
  ConversationSummary,
} from '@helm/protocol'
import type { ConversationOwnership } from './runtime-ownership.js'
import {
  ArtifactService as SvcArtifactService,
  AuthService as SvcAuthService,
  ConfigService,
  CredentialService,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
} from '../services/index.js'
import { createEnvFabric, tokenAuthenticator, type EnvFabric } from '../env/index.js'
import { AskService } from './asks.js'
import { ConversationTracker } from './conversations.js'
import { EventHub, SessionDocEventHub } from './events.js'
import type { HelmStore } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { buildManagedEnv } from './tools.js'
import { HelmPluginConfigStore } from './plugin-config-store.js'
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
import { RuntimeOwnershipManager } from './runtime-ownership.js'
import { createGlobalDocumentStore } from './runtime-host-backend.js'
import type { KernelRuntime } from './runtime.js'
import type { BootstrappedKernelContext } from './runtime-bootstrap.js'

export interface RuntimeServicesInit extends BootstrappedKernelContext {
  defaultModel?: string
  cwd: string
  hubUrl?: string
  seedKeyCache: Record<string, string>
  autoResume: boolean
  externalModels?: unknown
  nodeUpgradeTimeoutMs: number
}

export interface AssembledRuntimeServices {
  profilesSvc: ProfileService
  skillsSvc: SkillService
  configSvc: ConfigService
  credentialsSvc: CredentialService
  providersSvc: ProviderService
  pluginConfig: HelmPluginConfigStore
  artifactsSvc: SvcArtifactService
  authSvc: SvcAuthService
  modelsRegistry: ModelRegistry
  envFabric: EnvFabric
  toolDeps: HelmToolDeps
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
    store: HelmStore
    stashService: SecretStash
    handledToolCalls: Map<string, { conversationId: number | undefined; result: { output: Array<{ type: 'text'; text: string }>; isError: boolean } }>
    dispatchTurnSettled(payload: unknown, consumed: unknown): Promise<void>
    onSettleInflight(run: Promise<void>): void
    safeSummary(id: number): ConversationSummary | undefined
    submitInput(id: number, text: string, opts?: Parameters<ConversationService['submitInput']>[2]): Promise<unknown>
    createConversation(init: ConversationInit): Promise<ConversationSummary>
    updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  },
): AssembledRuntimeServices {
  const profilesSvc = new ProfileService(init.dataDir)
  const skillsSvc = new SkillService(init.dataDir)
  const configSvc = new ConfigService(init.dataDir)
  const credentialsSvc = init.credentials
  const providersSvc = init.providersSvc
  const pluginConfig = new HelmPluginConfigStore({ config: configSvc, credentials: credentialsSvc })

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

  const sessionDocLifecycleRelease = events.subscribe((frame) => {
    const event = frame.event
    if (event.type === 'plugin.changed' && 'plugin' in event && event.plugin.enabled === false) {
      sessionDocStreams.closeForPlugin(event.plugin.id)
    } else if (event.type === 'conversation.deleted' && 'conversationId' in event) {
      sessionDocStreams.closeForConversation(event.conversationId)
    }
  })

  // ---- 模型集合注册表 ----
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

  // ---- 跨平台节点底座（EnvFabric）----
  const envFabric = createEnvFabric({
    authenticate: tokenAuthenticator((nodeId) => nodes?.nodeDigestOf(nodeId)),
    cliBinDir: () => nodes?.cliBinDir,
    envOptions: ({ conversationId, cwd, nodeId }) =>
      buildManagedEnv(toolDeps, cwd, conversationId, nodeId),
  })

  // ---- 工具依赖面 ----
  const toolDeps: HelmToolDeps = {
    dataDir: init.dataDir,
    defaultCwd: init.cwd,
    get hubUrl(): string { return runtime.hubUrl },
    stashEnvFor: (id) => options.stashService.envFor(id),
    redact: (t) => options.stashService.redact(t),
    processToken: () => runtime.processToken,
    artifacts: artifactsSvc,
    envFabric,
    nodeIdOf: (id) => options.store.getConv(id)?.nodeId ?? 'local',
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

  // ---- 会话归属权管理器 ----
  const ownership = new RuntimeOwnershipManager({
    store: options.store,
    documentStore: createGlobalDocumentStore(options.store),
    events,
    conversations: {
      summaryWithOwnership: (id) => conversations.summaryWithOwnership(id),
    },
  })

  // ---- 追踪器 ----
  tracker = new ConversationTracker({
    harness: init.harness,
    store: options.store,
    redactError: (text) => options.stashService.redact(text),
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
        events.publish('conversation.live', { live })
      },
      onTurnSettled: (payload, consumed) => {
        const run = options.dispatchTurnSettled(payload, consumed)
        options.onSettleInflight(run)
        return run
      },
    },
  })

  // ---- 异步审批服务 ----
  asks = new AskService({
    store: options.store,
    stash: options.stashService,
    validateConversation: (id) => options.store.getConv(id) !== undefined,
    onEvent: (type, payload) => events.publish(type, payload),
    onConvPendingChanged: (id) => {
      tracker.setPendingAskCount(id, asks.pendingCount(id))
    },
  })

  // ---- hook 桥 ----
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

  // ---- 会话服务 ----
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
    defaultModel: () => modelsRegistry.defaultModel,
    defaultThinkingLevel: () => modelsRegistry.defaultThinkingLevel,
    models: () => modelsRegistry.models,
    parseModelRefOrThrow: (ref) => modelsRegistry.parseModelRefOrThrow(ref),
    assertModelEnabled: (provider, modelId) => modelsRegistry.assertModelEnabled(provider, modelId),
  })

  // ---- 原生子代理派生 ----
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

  // ---- 触发器分发器 ----
  const triggers = new RuntimeTriggerDispatcher({
    store: options.store,
    hookBridge,
    getConversation: (id) => runtime.getConversation(id),
    getConversationOwnership: (id) => ownership.getOwnership(id),
    createConversation: (cInit) => options.createConversation(cInit),
    submitInput: (id, text, opts) => options.submitInput(id, text, opts),
  })

  // ---- 工具装配器 ----
  const toolRegistry = new RuntimeToolRegistry({
    registry: init.registry,
    toolDeps,
    getPluginHost: () => runtime.plugins,
    isArtifactAuthorized: (convId, artifactConvId) =>
      conversations.isArtifactAuthorized(convId, artifactConvId),
    redact: (t) => options.stashService.redact(t),
    handledToolCalls: options.handledToolCalls,
  })

  // ---- 资产热重载协调器 ----
  const assetReloader = new AssetReloader({
    dataDir: init.dataDir,
    externalModels: init.externalModels !== undefined,
    reloadModels: () => runtime.reloadModels(),
    reloadPluginConfig: () => pluginConfig.load(),
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
