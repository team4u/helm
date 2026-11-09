/**
 * KernelRuntime：helm 微内核运行时组合根。
 *
 * 重构后职责（机制组合，不含业务策略）：
 * - 打开单一 state.sqlite（pi-durable + helm 表 + FTS 共享 adapter 队列）；
 * - 构造并组合内聚服务：ConversationService（CRUD/submit/rewrite）、
 *   NodeManager（令牌/升级/execEnv）、ModelRegistry（模型全家）、
 *   HookBridge（7 类生命周期钩子桥）、内核工具工厂；
 * - PluginHost 组合（config/credentials 分离持久、工具热装）；
 * - root #1 创建与恢复调度（open/initialize/start/close）。
 *
 * 各服务的 Why 注释在各自模块；本文件只保留组合顺序与跨服务协同。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import type { ModelThinkingLevel, Models, ModelsStore } from '@earendil-works/pi-ai'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  AskCreateSpec,
  AskResult,
  AskSpec,
  ConversationDetail,
  ConversationInit,
  ConversationInputResult,
  ConversationPatch,
  ConversationSummary,
  ConversationWithdrawResponse,
  ExternalTriggerEnvelope,
  ModelProvidersRefreshResult,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
  WorktreeCleanupRequest,
  WorktreeCleanupResult,
  EnvExecRequest,
  EnvExecResponse,
  MaybePromise,
} from '@helm/protocol'
import { HelmError, ROOT_CONVERSATION_ID as PROTO_ROOT } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import {
  ArtifactService as SvcArtifactService,
  AssetWatcher,
  AuthService as SvcAuthService,
  ConfigService,
  CredentialService,
  FileNotFoundError,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
  ensureDataDir,
  resolveDataDir,
  type Profile,
} from '../services/index.js'
import { PluginHost, type DerivedToolSpec } from '../plugins/index.js'
import { createEnvFabric, tokenAuthenticator, type EnvFabric } from '../env/index.js'
import { AskService } from './asks.js'
import { ConversationTracker } from './conversations.js'
import { EventHub, SessionDocEventHub } from './events.js'
import { createFileModelsStore } from './models-store.js'
import { buildModels, requireModelRef } from './models.js'
import type { ModelCatalog } from '@helm/protocol'
import { openHelmDatabase, type HelmDatabase } from './sqlite.js'
import { HelmStore } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { buildManagedEnv, createBashTool, createEditTool, createReadArtifactTool, createReadTool, createWriteTool, runGate } from './tools.js'
import { runNativeSpawn, THINKING_LEVELS, validateJsonSchema } from './spawn.js'
import { assertSchemaCompilable } from '../plugins/schema.js'
import { WorktreeAllocator } from './worktree.js'
import { gateResultMissingError, sanitizeExecutionInfo, sanitizeGateResult } from './spawn/spawn-exec.js'
import { HelmPluginConfigStore } from './plugin-config-store.js'
import { redactJsonValue } from '../redact.js'
import { ConversationService } from './conversation-service.js'
import { NodeManager } from './node-manager.js'
import { ModelRegistry } from './model-registry.js'
import { HookBridge, prepareToolResultWith } from './hook-bridge.js'
import { createRunActionTool } from './kernel-tools.js'
import { buildSpawnHost } from './spawn-host.js'
import {
  escapeXml,
  pluginToolResult,
  requireConv,
  safeResultText,
  stripEnvelope,
  summaryOfFallback,
} from './runtime-helpers.js'

export interface KernelRuntimeOptions {
  dataDir?: string
  cwd?: string
  /** 全局模型：启动参数 > HELM_MODEL > config.json.model。 */
  model?: string
  /** hub URL（测试 port:0 时注入；缺省按 HELM_PORT 生成）。 */
  hubUrl?: string
  /**
   * 外部注入 Models（测试用 faux provider 时传入）。注入时模型集合完全由
   * 调用方拥有：reloadModels 不重建、热重载不替换（防止把 faux 换成官方集）。
   */
  models?: Models
  /**
   * 是否在 open 内立即 resume 调度（默认 true，独立 runtime 即用）。
   * 组合层（createHelm）传 false：先注册插件 / 待插件服务启动，再 await
   * start() 启动恢复，防止恢复任务在工具未注册时被判 orphaned。
   */
  autoResume?: boolean
  /**
   * watchdog 巡检间隔毫秒（默认 15000；start 后启动 singleflight 定时器）。
   * 传 0 关闭定时巡检（测试用；仍可手动 watchdogTick）。
   */
  watchdogIntervalMs?: number
  /** 节点升级等待 commit 确认的超时毫秒（缺省 120000；测试可缩短）。 */
  nodeUpgradeTimeoutMs?: number
}

/** watchdog 默认巡检间隔（singleflight 定时器；0 关闭）。 */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000

export class KernelRuntime {
  readonly dataDir: string
  private readonly database: HelmDatabase
  private readonly harness: Harness
  private readonly registry: Registry
  private readonly store: HelmStore
  readonly events: EventHub
  /** 会话文档专用事件面（HTTP sessionDocEvents 端口；同一实例，构造器中接线）。 */
  readonly sessionDocEvents: SessionDocEventHub
  private readonly tracker: ConversationTracker
  private readonly asks: AskService
  private readonly stashService = new SecretStash()
  private readonly toolDeps: HelmToolDeps
  private readonly profilesSvc: ProfileService
  private readonly skillsSvc: SkillService
  private readonly artifactsSvc: SvcArtifactService
  private readonly authSvc: SvcAuthService
  private readonly credentialsSvc: CredentialService
  private readonly providersSvc: ProviderService
  private readonly configSvc: ConfigService
  private readonly pluginConfig: HelmPluginConfigStore
  private readonly agentSessions = new Map<string, number>()
  private pluginHost: PluginHost | undefined
  readonly worktrees: WorktreeAllocator
  /** 包含模型回合、结构化输出修复与 gate；用于阻止清理仍在使用的执行目录。 */
  private readonly activeSpawnExecutions = new Map<string, AgentExecutionInfo>()
  /** 会话插件管理权：conversationId -> 持有 pluginId 集合（删除保护）。 */
  private readonly managedConversations = new Map<number, Set<string>>()
  /** 内部通用事件监听器（ctx.host.onEvent 后端；type -> listener 集合）。 */
  private readonly hostEventListeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  /** 跨平台节点执行底座（local + 远端 BYOM 节点池；node-server 网关接线消费）。 */
  readonly envFabric: EnvFabric
  /** 受管进程 token（createProcessToken 产物；close dispose）。 */
  private processTokenHandle: { tokenOf(): string | undefined; dispose(): void } | undefined
  /** watchdog 定时器（singleflight；unref 不阻退出）。 */
  private watchdogTimer: NodeJS.Timeout | undefined
  private watchdogInflight = false
  private watchdogPending: Promise<void> | undefined
  /** turn_settled 钩子的在途执行（waitForIdle 前等待）。 */
  private settledInflight: Promise<void> = Promise.resolve()
  /** tool_call handled 接管缓存（callId -> 结果与归属会话；execute 层包装器消费）。 */
  private readonly handledToolCalls = new Map<
    string,
    { conversationId: number | undefined; result: { output: Array<{ type: 'text'; text: string }>; isError: boolean } }
  >()
  private closed = false
  /** 实际 hub URL（setHubUrl 可更新；工具 env 每次读取最新值）。 */
  private hubUrlValue: string
  private readonly watchdogIntervalMs: number
  /** start() 幂等守护：组合层完成插件/Workflow 挂接后显式启动调度。 */
  private started = false
  private startPromise: Promise<void> | undefined
  /** close 期间是否曾显式 abort 在途会话（保证 abort 结算至少一次）。 */
  private closeAborts: Array<Promise<void>> = []
  private watcher: AssetWatcher | undefined
  /** reloadModels 串行链 + 抖动合并（providers/credentials 热重载共用）。 */
  private reloadChain: Promise<void> = Promise.resolve()
  private reloadTimer: NodeJS.Timeout | undefined
  /** 节点管理（令牌/升级/execEnv/磁盘；从上帝类拆出的内聚服务）。 */
  readonly nodes: NodeManager
  /** 会话服务（CRUD/submit/rewrite/fork/reset；从上帝类拆出的内聚服务）。 */
  readonly conversations: ConversationService
  /** 模型集合注册表（Models/Provider 全家；从上帝类拆出的内聚服务）。 */
  readonly modelsRegistry: ModelRegistry
  /** hook 桥（7 类生命周期钩子 -> PluginHost runHook）。 */
  private readonly hookBridge: HookBridge
  /** 会话文档专用事件面（plugin.session_doc.updated 只进专用 SSE，不进全局广播）。 */
  private readonly sessionDocStreams = new SessionDocEventHub()
  /** 会话文档专用流生命周期订阅（plugin.changed / conversation.deleted 驱动关流）。 */
  private sessionDocLifecycleRelease: (() => void) | undefined

  static async open(options: KernelRuntimeOptions = {}): Promise<KernelRuntime> {
    const dataDir = resolveDataDir(options.dataDir)
    await ensureDataDir(dataDir)
    const database = await openHelmDatabase(dataDir)
    const store = new HelmStore(database)
    await store.load()

    const providersSvc = new ProviderService(dataDir)
    const credentials = new CredentialService(dataDir)

    const providerConfigs = await providersSvc.list()
    const apiKeyCache: Record<string, string> = {}
    // 凭据按实际已存 ID 读取，不再维护内置供应商白名单；存储错误必须显式失败。
    for (const id of await credentials.list()) {
      const key = await credentials.get(id)
      if (key) apiKeyCache[id] = key
    }
    const modelsExternal = options.models
    const modelsStore = createFileModelsStore(dataDir)
    const modelsInstance =
      modelsExternal ??
      buildModels({
        providers: providerConfigs,
        apiKeys: () => apiKeyCache,
        modelsStore,
      })
    // 离线恢复：从 models-store.json 恢复已缓存动态目录（不发网络请求；
    // 文件损坏时 refresh 内部 read 抛 models_store_corrupted，显式失败不静默）。
    if (!modelsExternal) {
      await assertModelsStoreHealthyAtBoot(modelsInstance)
    }
    const registry = createRegistry()

    // Harness models 槽位：open 作用域可变引用，reloadModels 时经 setModels 热替换。
    const modelsSlot = { current: modelsInstance }
    // 脱敏槽位：onReport 先于 runtime 构造注册，经槽位引用 runtime stash
    // （受管 token 创建后生效）；此前保持原样（startup 阶段尚无内部 token）。
    const redactSlot: { current: (text: string) => string } = { current: (t) => t }

    const harness = await Harness.open(
      database.storage,
      {
        // models 用 getter：reloadModels 重建后无需重开 harness 即热生效。
        models: () => modelsSlot.current,
        registry,
        settings: {
          followUpMode: 'all',
          steeringMode: 'all',
        },
        onReport: (report) => {
          // 非致命失败显式上报（extension_error/task_faulted 等），绝不静默。
          const description =
            report.kind === 'extension_error'
              ? `extension_error(${report.extension ?? 'unknown'})`
              : report.kind === 'task_faulted' || report.kind === 'task_interrupted'
                ? `${report.kind}(${report.task.kind})`
                : report.kind
          // 错误诊断统一过全局脱敏：宿主自身输出不得主动泄受管 token。
          const errorText = String((report as { error?: unknown }).error ?? '')
          console.error('[helm] durable report:', description, redactSlot.current(errorText))
        },
      },
      BACKGROUND_CONTEXT,
    )

    const runtime = new KernelRuntime({
      dataDir,
      database,
      harness,
      registry,
      store,
      providersSvc,
      credentials,
      models: modelsInstance,
      setModels: (m) => {
        modelsSlot.current = m
      },
      defaultModel: options.model || process.env['HELM_MODEL'] || undefined,
      cwd: options.cwd ?? process.cwd(),
      hubUrl: options.hubUrl,
      seedKeyCache: apiKeyCache,
      autoResume: options.autoResume !== false,
      externalModels: modelsExternal,
      watchdogIntervalMs: options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS,
      nodeUpgradeTimeoutMs: options.nodeUpgradeTimeoutMs ?? 120_000,
      modelsStore,
      redactReport: (fn: (text: string) => string) => {
        redactSlot.current = fn
      },
    })
    try {
      await runtime.initialize()
    } catch (error) {
      // 初始化失败同样释放本轮已创建资源（受管 token、SDK、数据库），不留泄漏。
      await runtime.close().catch(() => {})
      throw error
    }
    return runtime
  }

  private constructor(private readonly init: {
    dataDir: string
    database: HelmDatabase
    harness: Harness
    registry: Registry
    store: HelmStore
    providersSvc: ProviderService
    credentials: CredentialService
    models: Models
    setModels(m: Models): void
    defaultModel?: string
    cwd: string
    hubUrl?: string
    seedKeyCache: Record<string, string>
    autoResume: boolean
    externalModels?: Models
    watchdogIntervalMs: number
    /** 节点升级等待 commit 确认超时（毫秒；缺省 120000）。 */
    nodeUpgradeTimeoutMs: number
    /** 动态模型目录持久缓存（open 创建，实例全存续期共用）。 */
    modelsStore: ModelsStore
    /** 接管 Harness onReport 诊断脱敏（stash 就绪后由构造器调用）。 */
    redactReport(fn: (text: string) => string): void
  }) {
    this.dataDir = init.dataDir
    this.database = init.database
    this.harness = init.harness
    this.registry = init.registry
    this.store = init.store
    this.profilesSvc = new ProfileService(init.dataDir)
    this.skillsSvc = new SkillService(init.dataDir)
    this.configSvc = new ConfigService(init.dataDir)
    this.credentialsSvc = init.credentials
    this.providersSvc = init.providersSvc
    this.pluginConfig = new HelmPluginConfigStore({
      config: this.configSvc,
      credentials: this.credentialsSvc,
    })
    // 同步镜像仓库（满足 ArtifactRepository 同步契约；持久化经 store 排队）。
    const artifactRepo = {
      get: (id: string) => this.store.getArtifact(id),
      list: (conversationId: number) => this.store.listArtifacts(conversationId),
      put: (meta: never) => {
        this.store.putArtifact(meta)
      },
      deleteByConversation: (conversationId: number) => {
        this.store.deleteArtifactsByConversation(conversationId)
      },
    }
    this.artifactsSvc = new SvcArtifactService(init.dataDir, artifactRepo, this.stashService)
    this.authSvc = new SvcAuthService(init.dataDir)

    const hubUrl =
      init.hubUrl ?? `http://127.0.0.1:${process.env['HELM_PORT'] ?? '3202'}`
    this.hubUrlValue = hubUrl
    this.watchdogIntervalMs = init.watchdogIntervalMs

    // ---- 模型集合注册表（Models/Provider 全家；外部注入时空操作）----
    this.modelsRegistry = new ModelRegistry(
      {
        dataDir: init.dataDir,
        providersSvc: this.providersSvc,
        credentialsSvc: this.credentialsSvc,
        configSvc: this.configSvc,
        stash: this.stashService,
        modelsStore: init.modelsStore,
        setModels: init.setModels,
        externalModels: init.externalModels !== undefined,
        events: { publish: (type, payload) => this.events.publish(type, payload) },
        pluginHost: () => this.pluginHost,
        alignAllConversations: async () => {
          for (const meta of this.store.listConvs()) {
            await this.conversations.alignConversationModel(meta.id, true)
          }
        },
      },
      init.models,
      { model: init.defaultModel },
    )
    Object.assign(this.modelsRegistry.apiKeyCache, init.seedKeyCache)

    // ---- 跨平台节点底座（EnvFabric）------------------------------------
    // fail-closed 鉴权：仅 config.json nodes 登记的 sha256(token) 可注册。
    // 加载失败（config 损坏）在 initialize 阶段显式上抛，不静默无鉴权运行。
    // envOptions 闭包延迟读 this.toolDeps（下一行赋值后才被真正调用）。
    this.envFabric = createEnvFabric({
      authenticate: tokenAuthenticator((nodeId) => this.nodes?.nodeDigestOf(nodeId)),
      envOptions: ({ conversationId, cwd, nodeId }) =>
        buildManagedEnv(this.toolDeps, cwd, conversationId, nodeId),
    })

    // ---- 工具依赖面（hubUrl / cliBinDir 经 getter 每次读最新值）--------
    const runtimeSelf: KernelRuntime = this
    this.toolDeps = {
      dataDir: init.dataDir,
      defaultCwd: init.cwd,
      // getter 每次读最新值：setHubUrl（如 port:0 真实端口）后新 exec 即生效。
      get hubUrl(): string {
        return runtimeSelf.hubUrlValue
      },
      stashEnvFor: (id) => this.stashService.envFor(id),
      redact: (t) => this.stashService.redact(t),
      processToken: () => this.processTokenHandle?.tokenOf(),
      artifacts: this.artifactsSvc,
      envFabric: this.envFabric,
      nodeIdOf: (id) => this.store.getConv(id)?.nodeId ?? 'local',
      get cliBinDir(): string | undefined {
        return runtimeSelf.nodes?.cliBinDir
      },
    }

    this.nodes = new NodeManager({
      dataDir: init.dataDir,
      envFabric: this.envFabric,
      configSvc: this.configSvc,
      stash: this.stashService,
      toolDeps: this.toolDeps,
      events: { publish: (type, payload) => this.events.publish(type, payload) },
      nodeUpgradeTimeoutMs: init.nodeUpgradeTimeoutMs,
      convOf: (id) => requireConv(this.store, id),
    })
    // 节点上下线 -> node.changed SSE 事件（Web/CLI 实时感知）。
    // removeNode 已先删 nodeTokenIndex 再触发 registry.disconnect 时，
    // 离线事件交由 removeNode 统一发布（带 removed: true），此处不重复发。
    this.envFabric.registry.onNodeChanged((nodeId, online) => {
      if (!online && !this.nodes.hasNode(nodeId)) return
      const conn = online ? this.envFabric.registry.get(nodeId) : undefined
      this.events.publish('node.changed', {
        type: 'node.changed',
        node: this.nodes.byomNodeInfo(nodeId, conn),
      })
      // 自动升级（HELM_AUTO_UPGRADE_NODES=1 显式开启）：节点上线且上报版本
      // 严格落后 Hub 时异步触发同一 upgradeNode 路径；不阻塞注册回调。
      if (online && conn !== undefined) void this.nodes.autoUpgradeIfEligible(nodeId, conn.version)
    })
    this.worktrees = new WorktreeAllocator({
      envFabric: this.envFabric,
      docStore: this.documentStore,
      redact: (text) => this.stashService.redact(text),
      isConversationWorking: (id) => {
        if (this.store.getConv(id) === undefined) return false
        const status = this.tracker.summaryOf(id).status
        return status === 'working' || status === 'blocked'
      },
      isPathInUse: (nodeId, path) => this.isPathInUseForWorktrees(nodeId, path),
    })
    this.store.ftsRedact = (t) => this.stashService.redact(t)

    // 受管进程 token：仅内存、入全局脱敏（任何落库/模型上下文/日志不可见明文）。
    const managed = this.authSvc.createProcessToken()
    this.processTokenHandle = {
      tokenOf: () => managed.token,
      dispose: () => managed.dispose(),
    }
    this.stashService.addRedaction(managed.token)
    // 继承的 HELM_TOKEN（宿主自身凭据）同样登记脱敏：工具子进程用受管 token。
    if (process.env['HELM_TOKEN']) {
      this.stashService.addRedaction(process.env['HELM_TOKEN'])
    }
    // Harness onReport 的诊断脱敏接线（槽位在此接管）。
    this.init.redactReport((t) => this.stashService.redact(t))

    this.events = new EventHub({
      initialSeq: this.store.eventSeqNow,
      snapshot: () => ({
        seq: this.store.eventSeqNow,
        conversations: this.listConversations(),
        pendingAsks: this.asks.listAsks('pending'),
        plugins: this.pluginHost ? this.pluginHost.list() : [],
        ui: this.pluginHost ? this.pluginHost.listUi() : [],
        pluginDocs: this.pluginHost?.listPublicDocs() ?? [],
        // 重连首帧即恢复活跃会话实时视图（含 queuedInputs 排队胶囊）：
        // 从 tracker 权威镜像同步派生，不依赖上次推送缓存。
        conversationLives: this.tracker.listLiveViews(),
        // snapshot.nodes 与 node.changed 同源（listNodes 读取同一注册表），
        // 首帧即携带全部已知节点与在线状态，重连凭水位对齐。
        nodes: this.nodes.listNodesSync(),
      }),
      persistSeq: (seq) => this.store.setEventSeq(seq),
    })
    this.events.redactFn = (t) => this.stashService.redact(t)
    this.sessionDocStreams.redact = (t) => this.stashService.redact(t)
    this.sessionDocEvents = this.sessionDocStreams
    // 会话文档专用流的事件驱动终止（非轮询）：plugin.changed enabled=false
    // 关闭该插件的全部专用流，conversation.deleted 关闭该会话的全部专用流；
    // kernel.close 时释放该订阅。
    this.sessionDocLifecycleRelease = this.events.subscribe((frame) => {
      const event = frame.event
      if (event.type === 'plugin.changed' && 'plugin' in event && event.plugin.enabled === false) {
        this.sessionDocStreams.closeForPlugin(event.plugin.id)
      } else if (event.type === 'conversation.deleted' && 'conversationId' in event) {
        this.sessionDocStreams.closeForConversation(event.conversationId)
      }
    })

    this.asks = new AskService({
      store: this.store,
      stash: this.stashService,
      // 创建前校验会话存在：不存在时在 putAsk 之前拒绝，不留孤儿审批。
      validateConversation: (id) => this.store.getConv(id) !== undefined,
      onEvent: (type, payload) => this.events.publish(type, payload),
      onConvPendingChanged: (id) => {
        this.tracker.setPendingAskCount(id, this.asks.pendingCount(id))
      },
    })

    this.tracker = new ConversationTracker({
      harness: this.harness,
      store: this.store,
      events: {
        // tracker 摘要统一附加实时归属（ownedBy）：SSE 消费方（Web store/CLI）
        // 与 getConversation/listConversations 读到同一形状。
        onSummaryChanged: (summary) => {
          if (this.store.getConv(summary.id) === undefined || this.store.isDeleted(summary.id)) return
          this.events.publish('conversation.upsert', this.conversations.withOwnership(summary))
        },
        onInputCommitted: (conversationId, input) => {
          this.store.indexFts(conversationId, `input:${input.id}`, this.store.getConv(conversationId)?.title ?? '', input.text)
        },
        onAssistantText: (conversationId, entryId, text) => {
          this.tracker.recordAssistantText(conversationId, entryId, text)
          this.store.indexFts(conversationId, `entry:${entryId}`, this.store.getConv(conversationId)?.title ?? '', text)
        },
        onEntryCommitted: (conversationId, entry) => {
          // entry 已是协议形状（entries.ts 统一转换）；publish 边界统一脱敏。
          this.events.publish('conversation.entry', { conversationId, entry })
        },
        onLiveChanged: (live) => {
          this.events.publish('conversation.live', { live })
        },
        onTurnSettled: (payload, consumed) => {
          const run = this.dispatchTurnSettled(payload, consumed)
          this.settledInflight = Promise.all([this.settledInflight, run]).then(() => undefined)
          // 关闭路径仍 await 并传播错误；此处仅避免后台 Promise 提前触发 unhandled。
          void this.settledInflight.catch(() => {})
          return run
        },
      },
    })

    // ---- 会话服务（CRUD/submit/rewrite；构造后 tracker/events 已就绪）----
    this.conversations = new ConversationService({
      harness: this.harness,
      storage: this.database.storage,
      store: this.store,
      tracker: this.tracker,
      events: this.events,
      profilesSvc: this.profilesSvc,
      artifactsSvc: this.artifactsSvc,
      stash: this.stashService,
      dataDir: init.dataDir,
      toolDeps: { defaultCwd: init.cwd },
      evictConversationBase: (id) => this.envFabric.evictConversation(id),
      managedConversations: this.managedConversations,
      cleanupWorktree: (request) => this.cleanupWorktree(request),
      worktrees: this.worktrees,
      cancelAsksByConversation: async (id) => {
        await this.asks.cancelByConversation(id)
      },
      cancelPendingAsksForRewrite: async (id) => {
        const pendingAsks = this.asks.listPendingByConversation(id)
        await Promise.all(pendingAsks.map((ask) => this.asks.cancelAsk(ask.id, 'superseded')))
      },
      evictHandledToolCalls: (id) => this.evictHandledToolCalls(id),
      markOwnership: (id, owner) => this.markConversationOwnership(id, owner),
      ownershipOf: (id) => this.getConversationOwnership(id),
      runInputHook: (payload) => this.hookBridge.runHookChain('input', payload),
      isClosed: () => this.closed,
      defaultModel: () => this.modelsRegistry.defaultModel,
      defaultThinkingLevel: () => this.modelsRegistry.defaultThinkingLevel,
      parseModelRefOrThrow: (ref) => this.modelsRegistry.parseModelRefOrThrow(ref),
    })

    // ---- hook 桥（SDK GenerationTask/ToolTask 钩子 -> 7 hook 管道）----
    this.hookBridge = new HookBridge({
      registry: this.registry,
      pluginHost: () => this.pluginHost,
      handledToolCalls: this.handledToolCalls,
      prepareToolResult: (conversationId, result) =>
        prepareToolResultWith(this.artifactsSvc, (t) => this.stash.redact(t), conversationId, result),
      safeSummary: (id) => this.safeSummary(id),
      currentRunInputs: (id) => this.tracker.currentRunInputs(id),
      redact: (t) => this.stashService.redact(t),
      artifacts: this.artifactsSvc,
    })
  }

  private async initialize(): Promise<void> {
    // 0) 跨平台节点底座先行：加载 config.json 节点签发表（损坏显式上抛），
    //    生成 helm CLI 包装脚本（受管子进程可直接运行 helm）。
    await this.nodes.loadNodeTokens()
    await this.nodes.ensureCliBinDir()
    // 预热 local 磁盘统计：首个 SSE 快照（listNodesSync）即含磁盘字段。
    await this.nodes.ensureLocalDiskStats()
    // 1) 默认 profiles 先于 root 创建（root 绑定 assistant profile）。
    // 全局来源在内核统一解析；assistant Profile 的模型只属于该 Profile。
    await this.profilesSvc.ensureDefault()
    this.modelsRegistry.setThinkingLevelValidator(async (level) => {
      if (!THINKING_LEVELS.has(level)) {
        throw new HelmError('config_corrupt', `config.json.thinkingLevel 非法（合法值：${[...THINKING_LEVELS].join(' | ')}）`, 500)
      }
    })
    await this.modelsRegistry.loadDefaultsFromConfig()

    // 2) 内核工具（bash/read/read_artifact + subagent/SubagentWorkflow/run_action）
    //    经扩展注册；插件工具由 attachPluginHost 热装。
    this.installKernelTools()

    // 3) hook 桥：SDK GenerationTask/ToolTask 钩子 -> helm 7 hook 管道。
    this.hookBridge.install()

    // 4) PluginHost：内核内创建并接入（app 只消费 runtime.plugins，不再自建）。
    //    config/credentials 分离持久经 HelmPluginConfigStore；损坏显式上抛。
    await this.pluginConfig.load()
    const host = new PluginHost({
      dataDir: this.dataDir,
      // 启动屏障：注册期只登记服务，全部插件注册完成后由 kernel.start()
      // -> PluginHost.start() 统一 prepare+start，先于调度器 resume。
      deferServices: true,
      // 宿主统一脱敏（SecretStash）：插件间 ctx.host.invokeAction 输出过此脱敏。
      redactText: (text) => this.stashService.redact(text),
      providers: {
        register: (provider, pluginId) => this.modelsRegistry.registerRuntimeProvider(provider, pluginId),
        assertIdle: (pluginId) => this.modelsRegistry.assertRuntimeProvidersIdle(pluginId),
      },
      host: {
        dispatchTrigger: (event) => this.dispatchTrigger(event),
        submitInput: async (id, text, opts) => {
          await this.submitInput(id, text, opts)
        },
        createConversation: (init) => this.createConversation(init),
        listConversations: (filter) => this.listConversations(filter),
        getConversation: (id) => this.getConversation(id),
        updateConversation: (id, patch) => this.updateConversation(id, patch),
        abortConversation: (id) => this.abortConversation(id),
        spawnAgent: (request) => this.spawnAgent(request),
        runGate: (command, options) => this.runGate(command, options),
        prepareInterruptedConversations: (ids) => this.prepareInterruptedConversations(ids),
        cleanupWorktree: (request, signal) => this.cleanupWorktree(request, signal),
        invokeAction: (pluginId, actionId, input, context) => this.plugins.invokeAction(pluginId, actionId, input, context),
        prepareAction: (pluginId, actionId, input, context) =>
          this.plugins.prepareAction(pluginId, actionId, input, context),
        listActions: () => this.plugins.listActions(),
        // PluginHost 在插件侧绑定身份，后端必须接收明确的 pluginId。
        manageConversation: (id, pluginId) => this.manageConversation(id, pluginId),
        markConversationOwnership: (id, owner) => this.markConversationOwnership(id, owner),
        createAsk: (spec) => this.createAsk(spec),
        cancelAsk: (askId, reason) => this.cancelAsk(askId, reason),
        registerAskSeqResolver: (resolver) => this.registerAskSeqResolver(resolver),
        execEnv: async (req, opts) => {
          const res = await this.execEnv(req, undefined, opts?.signal)
          return {
            ...res,
            output: this.stash.redact(res.output),
          }
        },
        onEvent: (type, listener) => this.onEvent(type, listener),
        emitEvent: (type, payload, options) => this.emitHostEvent(type, payload, options),
      },
      docs: this.documentStore,
      sessionDocs: {
        get: (pluginId, name, conversationId) =>
          this.store.getPluginSessionDoc(pluginId, name, conversationId),
        put: (pluginId, name, conversationId, valueJson) =>
          this.store.putPluginSessionDoc(pluginId, name, conversationId, valueJson),
        delete: (pluginId, name, conversationId) =>
          this.store.deletePluginSessionDoc(pluginId, name, conversationId),
        listConversationIds: (pluginId, name) =>
          this.store.listPluginSessionDocConversations(pluginId, name),
        flush: () => this.store.flushPublic(),
      },
      config: this.pluginConfig,
    })
    this.pluginHost = host

    // 5) root #1（不注入业务 system；SYSTEM/MEMORY 由 assistant 插件 before_turn
    //    sections 注入，经 SDK PromptSection 真实进入模型请求）。
    // root 模型与普通会话同链：显式 override（无）> assistant profile.model > 全局。
    // 思考档位同链：assistant profile.thinkingLevel > 全局默认；均未设置不注入。
    await this.ensureRootConversation()

    // 6) 恢复：autoResume 时立即启动调度；否则等组合层 await start()。
    this.asks.reportOrphans()
    await this.conversations.recover(async (id, parentConversationId) => {
      const now = Date.now()
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined) : undefined
      this.store.upsertConv({
        id,
        title: `会话 ${id}`,
        profileId: 'assistant',
        tags: [],
        parentConversationId,
        cwd: agent?.cwd ?? this.toolDeps.defaultCwd,
        model:
          agent?.model !== undefined
            ? `${agent.model.provider}/${agent.model.modelId}`
            : '',
        thinkingLevel: (agent as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? '',
        nodeId: 'local',
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: now,
        updatedAt: now,
      })
    })
    this.startAssetWatcher()
    if (this.init.autoResume) await this.start()
  }

  /** root #1 创建（assistant profile 绑定；模型/思考档位走继承链）。 */
  private async ensureRootConversation(): Promise<void> {
    const rootThinking = await this.conversations.resolveEffectiveThinkingLevel(undefined, 'assistant')
    const rootEffective = await this.conversations.resolveEffectiveModel(undefined, 'assistant')
    const modelRef = rootEffective ? requireModelRef(rootEffective) : undefined
    const root = await this.harness.root(BACKGROUND_CONTEXT, {
      agent: {
        ...(modelRef ? { model: { provider: modelRef.provider, modelId: modelRef.modelId } } : {}),
        ...(rootThinking ? { thinkingLevel: rootThinking as ModelThinkingLevel } : {}),
      },
    })
    if (!this.store.getConv(root.id as number)) {
      this.store.upsertConv({
        id: root.id as number,
        title: '个人助理',
        profileId: 'assistant',
        tags: ['assistant'],
        nodeId: 'local',
        cwd: this.init.cwd,
        model: rootEffective ?? '',
        thinkingLevel: rootThinking ?? '',
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    await this.tracker.observe(root.id as number)
  }

  /**
   * 内核基础工具（bash/read/write/edit/read_artifact + run_action 元工具）
   *   统一注册（与插件工具同一 registry 机制；execute 统一包 handled 接管）。
   *   subagent / SubagentWorkflow / cleanup_worktree 由 builtin:workflow 插件提供。
   */
  private installKernelTools(): void {
    const runtime = this
    const toolHost = {
      invokePluginAction: async (pluginId: string, actionId: string, input: unknown, context: { conversationId: number; signal?: AbortSignal }) => {
        const host = this.pluginHost
        if (!host) throw new HelmError('runtime_not_initialized', '插件宿主未初始化', 503)
        return host.invokeAction(pluginId, actionId, input, context)
      },
      redact: (text: string) => runtime.stash.redact(text),
    }
    const kernelTools = [
      createBashTool(this.toolDeps),
      createReadTool(this.toolDeps),
      createWriteTool(this.toolDeps),
      createEditTool(this.toolDeps),
      createReadArtifactTool(this.toolDeps, (convId: number, artifactConvId: number) =>
        this.conversations.isArtifactAuthorized(convId, artifactConvId),
      ),
      createRunActionTool(toolHost),
    ].map((tool) => {
      const raw = tool as unknown as Record<string, unknown>
      const execute = raw['execute'] as (
        args: never,
        api: never,
        context: never,
      ) => Promise<unknown>
      return {
        ...raw,
        execute: wrapToolExecute(
          this.handledToolCalls,
          execute.bind(raw) as unknown as (
            args: never,
            api: never,
            context: { abortSignal?: AbortSignal },
          ) => Promise<unknown>,
        ),
      } as unknown as ToolRegistration
    })
    this.registry.install(
      defineExtension({ name: 'helm-core', tools: kernelTools }) as Extension,
    )
  }

  /**
   * 插件宿主事件入口（ctx.host.emitEvent 后端）：发布到 SSE；type 为
   * plugin.changed 时同步热装插件工具；其余类型同步触发内部 onEvent 监听器。
   * 可等待：内部监听器（含异步监听器）的完成被同步等待，错误上抛给发布方
   * （如引擎结算等待 herdr 清理监听器；失败进入结算诊断而非后台 notification）。
   * SSE publish 同步完成，其错误同样上抛（不再吞成 notification）。
   */
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
      // 完整透传新 payload（含 ui 贡献）：快照 plugins 由 host.list() 实时提供，
      // 事件只透传插件摘要与当前 UI 贡献，不丢弃字段。
      this.events.publish('plugin.changed', {
        type: 'plugin.changed',
        plugin: envelope?.plugin ?? {},
        ui: Array.isArray(envelope?.ui) ? envelope!.ui : [],
      })
      return
    }
    if (type === 'plugin.session_doc.updated') {
      // 会话文档事件绝不进入全局 /api/events 广播：只投递内部订阅面
      // （会话文档专用 SSE 流在 sessionDocStreams 消费），防止写放大与跨会话泄漏。
      this.sessionDocStreams.dispatch(payload)
      return this.dispatchInternalEvent(type, payload)
    }
    this.events.publish(type, payload)
    return this.dispatchInternalEvent(type, payload)
  }

  /**
   * 内部通用事件订阅（ctx.host.onEvent 后端）：插件监听宿主事件
   * （如 'workflow.settled'）；返回解除函数。插件停用时由 PluginHost
   * 释放句柄统一解除。
   */
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

  /**
   * 触发一类宿主内部事件的全部监听器（同步等待：任一监听器 throw/reject
   * 即中断后续监听器并上抛给发布方——发布方按自身语义处理，如 run 结算
   * 写入诊断；绝不再 fire-and-forget 吞成后台 notification）。
   */
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

  /**
   * 显式启动调度（幂等）：组合层（createHelm）在完成全部插件注册后调用。
   * 内部先执行 PluginHost.start() 服务启动屏障（全局 prepare 先于任何 start，
   * 防止服务 init 提交输入唤醒 SDK 时工具/插件未就绪），再 resume 调度器；
   * 随后恢复的 update_memory / load_skill / SubagentWorkflow 任务不会因工具
   * 未注册被判 missing/orphaned。独立 open（autoResume 默认 true）同样先走
   * host.start 屏障（initialize 内已注册内核工具；插件服务即时启动模式无影响）。
   */
  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      // 服务启动屏障：全部已启用插件 prepare + start 完成后才允许 resume。
      // 屏障失败时保持未启动态（不 resume），错误如实上抛。
      if (this.pluginHost) await this.pluginHost.start()
      this.harness.resume()
      this.startWatchdogTimer()
      this.started = true
    })()
    return this.startPromise
  }

  /**
   * watchdog 定时巡检（默认 15s；intervalMs=0 关闭）：unref 不阻进程退出，
   * singleflight 防重入；tick 异常显式通知（不静默吞）。
   */
  private startWatchdogTimer(): void {
    if (this.watchdogIntervalMs <= 0 || this.watchdogTimer !== undefined) return
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick().catch((error) => {
        this.events.publish('notification', {
          level: 'error',
          title: 'watchdog 巡检失败',
          body: String(error instanceof Error ? error.message : error),
        })
      })
    }, this.watchdogIntervalMs)
    this.watchdogTimer.unref()
  }

  /** 恢复运行服务用：先持久标记旧任务取消，不唤醒 SDK 全局调度器。
   * ids 为空时不触及调度器状态检查：重新启用插件等无遗留任务的 prepare
   * 不因调度器已恢复而被拒（无目标即无unsafe窗口）。 */
  async prepareInterruptedConversations(ids: number[]): Promise<void> {
    const targets = new Set(ids)
    if (targets.size === 0) return
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT)
    if (inspection.scheduling !== 'paused') {
      throw new HelmError('recovery_already_started', '必须在调度器恢复之前标记中断子代理，拒绝不安全的恢复顺序', 409)
    }
    for (const task of inspection.tasks) {
      if (targets.has(task.record.conversationId as number)) {
        // SDK abortTask 仅提交取消标记，不像 Conversation.abort()/submit() 那样 resume。
        await this.harness.abortTask(task.record.id, BACKGROUND_CONTEXT)
      }
    }
  }

  /** 更新实际 hub URL（startHub(port:0) 拿到真实端口后调用；工具 env 即时生效）。 */
  setHubUrl(url: string): void {
    if (typeof url !== 'string' || url === '') {
      throw new HelmError('validation_error', `hub URL 必须是非空字符串：${String(url)}`, 400)
    }
    this.hubUrlValue = url
  }

  /**
   * 外部 spawn 环境变量（如 createHerdrPlugin 驱动远端/新窗格 CLI Agent）：
   * 仅当前会话 SecretStash env + 受管 HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID /
   * HELM_CWD / HELM_DATA_DIR / HELM_TOKEN（固定覆盖 stash 同名注入）；
   * 绝不携带宿主 process.env（远端环境由目标机器自理，PATH/HOME 等不得外泄）。
   * 仅供 app 组合层工厂注入，不进 protocol ctx.host。
   */
  buildSpawnEnv(conversationId: number, cwd: string, nodeId?: string): Record<string, string> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'validation_error',
        `buildSpawnEnv 需要正整数 conversationId（收到 ${String(conversationId)}）`,
        400,
        { conversationId },
      )
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new HelmError('validation_error', `buildSpawnEnv 需要非空 cwd（收到 ${String(cwd)}）`, 400, {
        cwd,
      })
    }
    // 缺省解析会话绑定节点（显式 nodeId 优先；app 组合层注入 Herdr 用）。
    const resolvedNodeId = nodeId ?? this.store.getConv(conversationId)?.nodeId ?? 'local'
    return buildManagedEnv(this.toolDeps, cwd, conversationId, resolvedNodeId)
  }

  // ------------------------------------------------------------------
  // 节点管理（NodeManager 委托）
  // ------------------------------------------------------------------

  async listNodes(): Promise<NodeInfo[]> {
    return this.nodes.listNodes()
  }

  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    return this.nodes.issueNodeToken(nodeId)
  }

  async removeNode(nodeId: string): Promise<void> {
    return this.nodes.removeNode(nodeId)
  }

  async checkNodeUpgrade(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> {
    return this.nodes.checkNodeUpgrade(nodeId, input)
  }

  async upgradeNode(
    nodeId: string,
    input?: { targetVersion?: string; registryUrl?: string; force?: boolean },
  ): Promise<NodeUpgradeResult> {
    return this.nodes.upgradeNode(nodeId, input)
  }

  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    return this.nodes.execEnv(req, onChunk, signal)
  }

  // ------------------------------------------------------------------
  // 产物授权 / 附件（ConversationService 委托）
  // ------------------------------------------------------------------

  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    return this.conversations.isArtifactAuthorized(conversationId, artifactConversationId)
  }

  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ) {
    return this.conversations.resolveAuthorizedAttachments(conversationId, attachmentIds)
  }

  async resolveAuthorizedAttachment(conversationId: number, artifactId: string) {
    return this.conversations.resolveAuthorizedAttachment(conversationId, artifactId)
  }

  // ------------------------------------------------------------------
  // 静态资产热重载（AssetWatcher）
  // ------------------------------------------------------------------

  /**
   * 仅监听静态资产路径（providers.json / credentials.json / config.json /
   * profiles/** / skills/**）。排除 state.sqlite、artifacts、workflows、
   * plugins 数据目录与一切临时文件——它们非「配置输入」，监听只增噪音。
   * models 注入时（外部/测试 Models）模型集合归调用方，绝不重建替换。
   */
  private startAssetWatcher(): void {
    if (this.watcher) return
    this.watcher = new AssetWatcher(
      this.dataDir,
      (changed) => this.onAssetsChanged(changed),
      {
        onError: (err) => {
          // watcher 故障显式通知，不静默吞（热重载降级但主流程不受影响）。
          this.events.publish('notification', {
            level: 'error',
            title: '资产热重载监听失败',
            body: String(err instanceof Error ? err.message : err),
          })
        },
      },
    )
    this.watcher.start()
  }

  private onAssetsChanged(changedPaths: string[]): void {
    let providersTouched = false
    let credentialsTouched = false
    let configTouched = false
    let profilesOrSkills = false
    for (const rel of changedPaths) {
      const [head, second] = rel.split('/')
      if (head === 'providers.json') providersTouched = true
      else if (head === 'credentials.json') credentialsTouched = true
      else if (head === 'config.json') configTouched = true
      else if (head === 'profiles' || head === 'skills') profilesOrSkills = true
      else continue
      void second
    }
    // profiles/skills 每回合 before_turn 都 fresh 读取，无需缓存失效。
    void profilesOrSkills
    if (configTouched) {
      // 插件配置镜像刷新（读取失败显式通知，不吞）。
      void this.pluginConfig
        .load()
        .catch((error) => this.notifyWatcherError('插件配置热重载失败', error))
    }
    if (providersTouched || credentialsTouched) {
      this.scheduleReloadModels()
    }
  }

  private notifyWatcherError(title: string, error: unknown): void {
    this.events.publish('notification', {
      level: 'error',
      title,
      body: error instanceof Error ? error.message : String(error),
    })
  }

  /** 抖动合并 + 串行 reloadModels（外部注入 Models 时空操作）。 */
  private scheduleReloadModels(): void {
    if (this.init.externalModels) return
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      this.reloadChain = this.reloadChain
        .then(() => this.reloadModels())
        .catch((error) => this.notifyWatcherError('模型配置热重载失败', error))
    }, 200)
  }

  // ------------------------------------------------------------------
  // 插件工具热装
  // ------------------------------------------------------------------

  /**
   * 插件宿主接入（外部已自建 PluginHost 的测试场景；正常路径由 initialize 自建）。
   * listTools() 的 DerivedToolSpec 只有清单字段，缺 execute；这里 map 到
   * host.executeTool 闭包生成真实 SDK 工具并经 registry 热装（同名扩展原地
   * 替换，新回合生效，不影响在途回合）。
   */
  attachPluginHost(host: PluginHost): void {
    this.pluginHost = host
    this.installPluginTools(host.listTools())
  }

  /** 插件启停后热更新工具集（app 组合层与 enable/disable 路径调用）。 */
  refreshPluginTools(): void {
    if (!this.pluginHost) return
    this.installPluginTools(this.pluginHost.listTools())
  }

  private installPluginTools(specs: DerivedToolSpec[]): void {
    const runtime = this
    const host = this.pluginHost
    if (!host) return
    // 同名扩展 install 语义为原地替换（registry.install 已核实）；
    // 每次重建闭包绑定最新 executeTool，空集也安装（清空旧插件工具）。
    const tools = specs.map((spec) => {
      const raw = defineTool({
        name: spec.name,
        description: spec.description,
        parameters: (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, object>,
        ...(spec.structuredOutputSchema !== undefined
          ? { structuredOutputSchema: spec.structuredOutputSchema as Record<string, object> }
          : {}),
        async execute(args: unknown, api: never, context: { abortSignal?: AbortSignal }) {
          const toolApi = api as unknown as { conversationId: number; callId?: string }
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
            signal: context.abortSignal,
          })
          // 插件工具返回任意值：包成 SDK ToolExecutionResult 契约（content/text）。
          return pluginToolResult(result, (text) => runtime.stash.redact(text), {
            structuredOutputSchema: spec.structuredOutputSchema,
            toolName: spec.name,
            ...(typeof toolApi.callId === 'string' && toolApi.callId !== '' ? { callId: toolApi.callId } : {}),
          })
        },
      } as never) as unknown as {
        execute: (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown>
      }
      return {
        ...raw,
        execute: wrapToolExecute(
          this.handledToolCalls,
          raw.execute.bind(raw) as unknown as (
            args: never,
            api: never,
            context: { abortSignal?: AbortSignal },
          ) => Promise<unknown>,
        ),
      } as never
    })
    this.registry.install(defineExtension({ name: 'helm-plugins', tools }) as Extension)
  }

  get plugins(): PluginHost {
    if (!this.pluginHost) {
      throw new HelmError('runtime_not_initialized', 'PluginHost 尚未初始化', 503)
    }
    return this.pluginHost
  }

  private dispatchTurnSettled(payload: unknown, consumed: unknown): Promise<void> {
    // 回合终态兑底：清理该会话未被 afterTool 消费的 handled 接管残留
    //（block/abort/异常路径不会走 execute，残留会永久占据内存）。
    const conversationId = (payload as { conversation?: { id?: number } }).conversation?.id
    if (typeof conversationId === 'number') this.evictHandledToolCalls(conversationId)
    const host = this.pluginHost
    if (!host) return Promise.resolve()
    void consumed
    return host
      .runHook('turn_settled', payload as never)
      .then(() => undefined)
      .catch((error) => {
        this.events.publish('notification', {
          level: 'error',
          title: 'turn_settled 钩子执行失败',
          body: String(error),
        })
      })
  }

  /** 清理指定会话在 handledToolCalls 中的未消费残留（回合终态/abort/删除兑底）。 */
  private evictHandledToolCalls(conversationId: number): void {
    for (const [callId, entry] of this.handledToolCalls) {
      if (entry.conversationId === conversationId) this.handledToolCalls.delete(callId)
    }
  }

  // ------------------------------------------------------------------
  // public：conversations（ConversationService 委托）
  // ------------------------------------------------------------------

  listConversations(filter?: { profileId?: string; tag?: string; status?: string }): ConversationSummary[] {
    return this.conversations.listConversations(filter)
  }

  getConversation(id: number): ConversationSummary {
    return this.conversations.getConversation(id)
  }

  async getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
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

  /**
   * 通用单次文本补全端口（机制，不含任何业务策略）：
   * - 模型解析与会话对齐：会话覆盖 > profile.model > 全局（resolveEffectiveModel，
   *   解析失败如实上抛，绝不回退默认模型）；
   * - 无 tools 单次请求（completeSimple），输入输出均过全局脱敏；
   * - stopReason 非成功终态（error/aborted/length 等）显式拒绝，不返回部分文本；
   * - signal 预先 aborted 或请求中取消立即以 aborted 上抛；超时与重试策略由
   *   调用方（插件 helper）决定，本端口不做业务性 deadline。
   */
  async completeConversationText(input: {
    conversationId: number
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<string> {
    input.signal?.throwIfAborted()
    const meta = this.store.getConv(input.conversationId)
    if (meta === undefined) {
      throw new HelmError('not_found', `会话不存在：${input.conversationId}`, 404, { conversationId: input.conversationId })
    }
    const effective = await this.conversations.resolveEffectiveModel(meta.modelOverride, meta.profileId)
    if (effective === undefined || effective === '') {
      throw new HelmError('model_not_configured', `会话 ${input.conversationId} 未解析出生效模型，无法执行文本补全`, 409, { conversationId: input.conversationId })
    }
    const ref = requireModelRef(effective)
    const model = this.modelsRegistry.models.getModel(ref.provider, ref.modelId)
    if (model === undefined) {
      throw new HelmError('model_not_found', `生效模型 '${effective}' 不在当前模型集合中（可能已热重载移除）`, 409, { model: effective })
    }
    // profile 解析是异步间隙：调用前再检查取消，取消后不得发起请求。
    input.signal?.throwIfAborted()
    // maxTokens 属于请求 options（completeSimple 第三参），不是 Context 字段；
    // tools 不传即无工具单次请求。
    const message = await this.modelsRegistry.models.completeSimple(model, {
      systemPrompt: this.stash.redact(input.systemPrompt),
      messages: [
        {
          role: 'user',
          content: this.stash.redact(input.text),
          timestamp: Date.now(),
        },
      ],
    }, {
      signal: input.signal,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    })
    input.signal?.throwIfAborted()
    if (message.stopReason !== 'stop') {
      throw new HelmError(
        'model_completion_unavailable',
        `文本补全未成功结束（stopReason=${message.stopReason}${message.errorMessage !== undefined ? `：${this.stash.redact(String(message.errorMessage)).slice(0, 200)}` : ''}），拒绝返回部分文本`,
        502,
        { stopReason: message.stopReason },
      )
    }
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('')
    return this.stash.redact(text)
  }

  // ------------------------------------------------------------------
  // trigger / spawn / workflow / watchdog
  // ------------------------------------------------------------------

  /** defang 防逃逸信封：所有动态字段 XML 转义（防 </external_event> 注入）。 */
  private defang(envelope: ExternalTriggerEnvelope): string {
    const id = escapeXml(envelope.id)
    const source = escapeXml(envelope.source)
    const body = escapeXml(envelope.text)
    return `<external_event id="${id}" source="${source}" untrusted="true">\n${body}\n</external_event>`
  }

  /** 外部触发：trigger hook -> 默认投递 #1（transform 后 target 与 text 都生效）。 */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    const initial: ExternalTriggerEnvelope = { ...envelope, text: this.defang(envelope) }
    const outcome = await this.hookBridge.runHookChain('trigger', initial)
    if (outcome?.action === 'handled') return
    let final = initial
    if (outcome?.action === 'transform') {
      final = outcome.value as ExternalTriggerEnvelope
      // transform 后的 text 再防一次（插件可能替换了原文）。
      final = { ...final, text: this.defang({ ...final, text: stripEnvelope(final.text) }) }
    }
    const target = final.targetConversationId ?? PROTO_ROOT
    await this.submitInput(target, final.text, { origin: 'trigger', whenBusy: 'followUp' })
  }

  /** 子代理派生：agent_spawn hook -> 默认原生 subagent（transform 传最终 payload）。 */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    if (request.schema !== undefined) assertSchemaCompilable(request.schema)
    const token = randomUUID()
    let succeeded = false
    if (request.resume !== undefined) {
      const resumeId = /^\d+$/.test(request.resume) ? Number(request.resume) : this.agentSessions.get(request.resume)
      const child = resumeId !== undefined ? this.store.getConv(resumeId) : undefined
      if (child !== undefined && child.parentConversationId === request.parentConversationId) {
        if ([...this.activeSpawnExecutions.values()].some((info) => info.conversationId === resumeId)) {
          throw new HelmError('subagent_in_use', `子会话 ${resumeId} 仍有在途执行，不能并发续接`, 409)
        }
        this.activeSpawnExecutions.set(token, { conversationId: resumeId, nodeId: child.nodeId ?? 'local', effectiveCwd: child.cwd })
      }
    }
    const originalResolved = request.onResolved
    let execution: AgentExecutionInfo | undefined
    let gate: ReturnType<typeof sanitizeGateResult> | undefined
    const observed: AgentSpawnRequest = {
      ...request,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        info.nodeId ??= info.conversationId !== undefined ? this.store.getConv(info.conversationId)?.nodeId : undefined
        if (request.isolation === 'worktree' && info.worktree === undefined) {
          throw new HelmError('unsupported_runtime', '执行方未兑现请求的 worktree 隔离，拒绝按非隔离任务继续', 502)
        }
        if (info.worktree !== undefined) {
          if (info.nodeId === undefined) throw new HelmError('execution_info_invalid', '隔离工作树必须回传实际 nodeId，不能推测外部运行时的节点', 502)
          const managed = this.worktrees.findActive({ path: info.worktree.path, nodeId: info.nodeId }) ?? this.worktrees.registerExternal({
            nodeId: info.nodeId, path: info.worktree.path, branch: info.worktree.branch,
            parentConversationId: request.parentConversationId,
            ...(info.conversationId !== undefined ? { conversationId: info.conversationId } : {}),
            ...(info.executionId !== undefined ? { executionId: info.executionId } : {}),
          })
          info.worktree = { ...info.worktree, id: managed.id, ...(managed.repoRoot !== '' ? { repoRoot: managed.repoRoot } : {}), ...(managed.baseCommit !== '' ? { baseCommit: managed.baseCommit, dirtySource: managed.dirtySource } : {}) }
        }
        if (info.worktree !== undefined) {
          const safe = redactJsonValue(info, (text) => this.stashService.redact(text)) as AgentExecutionInfo
          if (JSON.stringify(safe) !== JSON.stringify(info)) {
            throw new HelmError('worktree_metadata_secret', `隔离执行元数据包含已登记机密，拒绝持久化；执行标识 ${safe.executionId ?? safe.conversationId ?? '未知'}`, 400, { execution: safe })
          }
        }
        execution = info
        this.activeSpawnExecutions.set(token, info)
        if (info.worktree !== undefined) {
          const leases = this.documentStore.get<Record<string, AgentExecutionInfo>>('runtime/worktree-execution-leases', {})
          this.documentStore.set('runtime/worktree-execution-leases', { ...leases, [token]: info })
        }
        originalResolved?.(info)
      },
      onGateResult: (raw) => {
        gate = sanitizeGateResult(raw, { agentId: request.agentId ?? 'subagent' })
        request.onGateResult?.(gate)
      },
    }
    try {
      const result = await this.spawnAgentObserved(observed)
      if (request.schema !== undefined) {
        const validation = validateJsonSchema(result, request.schema)
        if (!validation.ok) throw new HelmError('schema_validation_failed', `子代理最终结果未满足 Schema：${validation.errors.join('; ')}`, 502)
      }
      if (request.isolation === 'worktree' && execution?.worktree === undefined) {
        throw new HelmError('unsupported_runtime', '执行方未回传请求的隔离工作树，不能报告成功', 502)
      }
      if (request.gate !== undefined && execution?.executionId !== undefined && gate === undefined) {
        throw gateResultMissingError({ agentId: request.agentId ?? 'subagent', executionId: execution.executionId, command: request.gate })
      }
      if (gate !== undefined && !gate.ok) throw new HelmError('gate_failed', `子代理验收命令失败：${gate.output}`, 502)
      succeeded = true
      return result
    } finally {
      if (execution?.worktree !== undefined && (succeeded || execution.executionId === undefined)) {
        const leases = this.documentStore.get<Record<string, AgentExecutionInfo>>('runtime/worktree-execution-leases', {})
        const updated = Object.fromEntries(Object.entries(leases).filter(([key, info]) => {
          if (key === token) return false
          if (info.nodeId !== execution!.nodeId) return true
          if (execution!.conversationId !== undefined) return info.conversationId !== execution!.conversationId
          return info.executionId !== execution!.executionId
        }))
        this.documentStore.set('runtime/worktree-execution-leases', updated)
      }
      this.activeSpawnExecutions.delete(token)
    }
  }

  private async spawnAgentObserved(request: AgentSpawnRequest): Promise<unknown> {
    // 附件门禁在进入 hook 链之前：agent_spawn 钩子与原生执行行均受统一授权
    // 保护（产物存在 + 父会话链归属）；transform 改写后再校验一次。
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    const outcome = await this.hookBridge.runHookChain('agent_spawn', request)
    if (outcome?.action === 'handled') return outcome.result
    const finalRequest =
      outcome?.action === 'transform' ? (outcome.value as AgentSpawnRequest) : request
    if (
      finalRequest.attachments !== undefined &&
      finalRequest.attachments.length > 0 &&
      finalRequest !== request
    ) {
      await this.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
    }
    const resolvedAttachments =
      finalRequest.attachments !== undefined && finalRequest.attachments.length > 0
        ? await this.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
        : undefined
    // 显式命名的 SpawnHost（原 60+ 行内联对象字面量的提炼）。
    return runNativeSpawn(
      buildSpawnHost({
        finalRequest,
        source: {
          toolDeps: this.toolDeps,
          harness: this.harness,
          tracker: { getLastAssistantText: (id) => this.tracker.getLastAssistantText(id) },
          defaultModel: this.modelsRegistry.defaultModel,
          defaultThinkingLevel: this.modelsRegistry.defaultThinkingLevel,
          agentSessions: this.agentSessions,
          worktrees: this.worktrees,
          resolvedAttachments,
          isNodeOnline: (nodeId) => this.envFabric.isOnline(nodeId),
          buildAttachmentBlock: (resolved) => this.conversations.buildAttachmentBlock(resolved),
          readProfileForSpawn: (profileId) => this.conversations.readProfile(profileId),
          getConvMeta: (childId) => this.store.getConv(childId),
          getConversationSummary: (childId) => {
            const meta = this.store.getConv(childId)
            return meta ? this.tracker.summaryOf(childId) : undefined
          },
          updateConversation: (childId, patch) => this.updateConversation(childId, patch),
          installExtension: (extension) => {
            this.registry.install(extension as never)
          },
          registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, parentToolCallId) => {
            const profile = await this.conversations.readProfile(profileId)
            const now = Date.now()
            this.store.upsertConv({
              id: childId,
              title: `子代理 ${childId}`,
              profileId,
              // 内核零角色硬编码：tags 由调用方策略决定（原生 spawn 传 []）。
              tags,
              parentConversationId: parentId,
              ...(parentToolCallId !== undefined && parentToolCallId !== ''
                ? { parentToolCallId }
                : {}),
              // 与普通创建一致：Profile 节点优先于父会话缺省节点。
              nodeId: nodeId ?? profile?.nodeId ?? this.store.getConv(parentId)?.nodeId ?? 'local',
              cwd: childCwd,
              model: modelMirror,
              thinkingLevel: thinkingLevel ?? '',
              thinkingLevelOverride: finalRequest.effort,
              ...(finalRequest.model !== undefined && finalRequest.model !== '' ? { modelOverride: finalRequest.model } : {}),
              unread: false,
              pinned: false,
              stateChangeSeq: 1,
              completionSeq: 0,
              createdAt: now,
              updatedAt: now,
            })
            // 原生 spawn 自动 helm 归属（Watchdog 红线判定唯一可信来源）。
            this.markConversationOwnership(childId, 'helm')
            await this.tracker.observe(childId)
            // 创建瞬间即广播含 parentConversationId / parentToolCallId 的摘要：
            // 前端在 subagent 运行期 0ms 关联子会话，不等首轮摘要指纹变化。
            if (this.store.getConv(childId) !== undefined && !this.store.isDeleted(childId)) {
              this.events.publish('conversation.upsert', this.conversations.withOwnership(this.tracker.summaryOf(childId)))
            }
          },
          bindChildToolCall: (childId, parentToolCallId) => {
            const meta = this.store.getConv(childId)
            if (meta === undefined || meta.parentToolCallId === parentToolCallId) return
            this.store.upsertConv({ ...meta, parentToolCallId, updatedAt: Date.now() })
            if (!this.store.isDeleted(childId)) {
              this.events.publish('conversation.upsert', this.conversations.withOwnership(this.tracker.summaryOf(childId)))
            }
          },
        },
      }),
      finalRequest,
    )
  }

  /**
   * gate 门禁（独立 spawn 与 Workflow adapter 共用，只执行一次）。
   * env：调用方（herdr 插件）注入 Profile.runtime.env 与管理环境组成的
   * spawnEnv，使本机 Gate 读到与实际 Herdr 任务一致的 CI/工具路径；
   * 受管变量（HELM_* 与受管 token）仍固定覆盖注入值（见 buildToolEnv）。
   */
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
    // 靶点解析与 execEnv 同铨：显式 nodeId > 会话绑定 > 'local'。
    // 远端会话的 gate 必须在远端节点执行（绝不误跑 Hub 本机）。
    let nodeId = options.nodeId
    if (nodeId === undefined && options.conversationId !== undefined) {
      nodeId = this.store.getConv(options.conversationId)?.nodeId
    }
    return runGate(this.toolDeps, command, { ...options, ...(nodeId !== undefined ? { nodeId } : {}) })
  }

  async cleanupWorktree(request: WorktreeCleanupRequest, signal?: AbortSignal): Promise<WorktreeCleanupResult> {
    return this.worktrees.cleanup({ ...request, signal })
  }

  /**
   * watchdog tick（singleflight）：只采集真实事实，无业务策略、不自动恢复；
   * probe 携带 getProbeFacts 的真实 stalledMs/consecutiveErrors；
   * human 归属仅只读诊断（红线由插件与 host 共同遵守）。
   */
  async watchdogTick(): Promise<unknown> {
    if (this.closed) throw new HelmError('runtime_closed', '内核正在关闭，拒绝启动巡检', 503)
    if (this.watchdogInflight) {
      // singleflight：上一轮未结束时不叠加执行（事实采集不重入）。
      return { skipped: true, reason: 'watchdog tick already running' }
    }
    this.watchdogInflight = true
    let finishTick!: () => void
    const pending = new Promise<void>((resolve) => { finishTick = resolve })
    this.watchdogPending = pending
    try {
      const summaries = this.listConversations()
      const probes = summaries.map((summary) => {
        const facts = this.tracker.getProbeFacts(summary.id)
        return {
          targetId: String(summary.id),
          /**
           * 归属权判定依据显式登记的 ownership 标记（conversation-ownership doc），
           * 绝不依赖用户可改的 tags/parent 推断；判不准一律 human 只读
           * （红线：宁可漏管不可越权）。
           */
          ownedBy: this.getConversationOwnership(summary.id),
          status: summary.status,
          targetKind: 'conversation' as const,
          conversationId: summary.id,
          stateChangeSeq: summary.stateChangeSeq,
          ...(facts.stalledMs !== undefined ? { stalledMs: facts.stalledMs } : {}),
          ...(facts.consecutiveErrors > 0 ? { consecutiveErrors: facts.consecutiveErrors } : {}),
          facts: { doing: summary.doing, pendingAskCount: summary.pendingAskCount },
        }
      })
      const payload = { timestamp: Date.now(), conversations: summaries, probes }
      const outcome = await this.hookBridge.runHookChain('watchdog_tick', payload)
      // 插件（如 builtin:herdr）可经 transform 扩充 payload（如附加探针字段）：
      // 巡检调用方拿到的是钩子链最终形态，而非初始快照。
      if (outcome?.action === 'transform' && outcome.value !== undefined) {
        return outcome.value
      }
      return payload
    } finally {
      this.watchdogInflight = false
      if (this.watchdogPending === pending) this.watchdogPending = undefined
      finishTick()
    }
  }

  /**
   * 会话归属权现读（Watchdog 红线判定唯一可信来源；superagent 工厂注入用）：
   * - root #1 恒 human；
   * - 会话不存在（含已删除 tombstone）时抛 not_found，绝不把已删会话的
   *   残留登记当作可执行授权返回；
   * - 未标记/标记非法值一律 human（宁漏管不越权）。
   */
  getConversationOwnership(conversationId: number): 'helm' | 'bot' | 'human' {
    if (conversationId === PROTO_ROOT) return 'human'
    const meta = this.store.getConv(conversationId)
    if (meta === undefined || this.store.isDeleted(conversationId)) {
      throw new HelmError('not_found', `会话不存在：${conversationId}`, 404, { conversationId })
    }
    const owners = this.documentStore.get<Record<string, string>>('conversation-ownership', {})
    const marked = owners[String(conversationId)]
    return marked === 'helm' || marked === 'bot' ? marked : 'human'
  }

  // ------------------------------------------------------------------
  // asks / models / services
  // ------------------------------------------------------------------

  listAsks(status?: string): AskSpec[] {
    return this.asks.listAsks(status)
  }

  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    return this.asks.createAsk(spec)
  }

  async answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<AskSpec> {
    return this.asks.answerAsk(id, answers, expectedStateSeq)
  }

  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    await this.asks.cancelAsk(id, reason ?? 'cancelled')
  }

  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    return this.asks.registerSeqResolver(resolver)
  }

  async listModels(): Promise<ModelCatalog> {
    return this.modelsRegistry.listModels()
  }

  /** 设置全局默认模型与思考档位（config.json）：格式校验后原子写入并即时生效；空串删除键。 */
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

  /** 重建并发布模型集（providers/credentials/运行时供应商变化共用）。 */
  async reloadModels(): Promise<void> {
    return this.modelsRegistry.reloadModels()
  }

  /** 运行时注册动态供应商（插件经 HostOptions.providers.register 注入）。 */
  async registerRuntimeProvider(provider: Parameters<ModelRegistry['registerRuntimeProvider']>[0], pluginId?: string): Promise<() => Promise<void>> {
    return this.modelsRegistry.registerRuntimeProvider(provider, pluginId)
  }

  /** 刷新动态模型目录（POST /api/models/refresh）。 */
  async refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    return this.modelsRegistry.refreshModels(() => this.closed, options)
  }

  /** teardown 预检：插件 owner 的运行时供应商在途请求拒绝（409）。 */
  assertRuntimeProvidersIdle(pluginId: string): void {
    this.modelsRegistry.assertRuntimeProvidersIdle(pluginId)
  }

  /**
   * 全局文档存储端口（PluginHost docs 与内核元数据共用同一 SQLite 镜像与队列）：
   * - get(key, initial)：同步读，缺省返回 initial（不落盘）；
   * - set(key, value)：同步镜像 + 排队持久化（helm_plugin_docs 全局命名空间）；
   * - flush()：等待队列冲刷完成（失败显式抛 store_flush_failed）。
   * PluginHost 使用 '<pluginId>:<doc>' 隔离插件文档，内核元数据使用独立键。
   */
  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush(): Promise<void>
  } = {
    get: <T>(key: string, initial: T): T => {
      const raw = this.store.getPluginDoc('__global', key)
      if (raw === undefined) return initial
      return JSON.parse(raw) as T
    },
    set: <T>(key: string, value: T): void => {
      this.store.putPluginDoc('__global', key, JSON.stringify(value))
    },
    flush: () => this.store.flushPublic(),
  }

  /**
   * 会话归属权标记（Watchdog 红线判定唯一可信来源）：
   * - 不依赖用户可改的 tags/parent 推断；未标记一律视为 human（宁漏管不越权）；
   * - root #1 恒 human，禁止改写（个人助理主入口是人类直连会话）；
   * - 持久化于全局 doc（'conversation-ownership'），重启保留。
   */
  markConversationOwnership(conversationId: number, owner: 'helm' | 'bot' | 'human'): void {
    if (conversationId === PROTO_ROOT && owner !== 'human') {
      throw new HelmError(
        'root_ownership_immutable',
        `根会话 #1 归属恒为 human，禁止标记为 ${owner}`,
        403,
        { conversationId, owner },
      )
    }
    const key = 'conversation-ownership'
    const current = this.documentStore.get<Record<string, string>>(key, {})
    const previous = current[String(conversationId)]
    // 有效值对比：未标记与 human 等价（human = 移除自动化归属），无变化不发布事件。
    const previousEffective = previous === 'helm' || previous === 'bot' ? previous : 'human'
    if (previousEffective === owner) return
    const next = owner === 'human'
      ? (() => {
          // 标记 human = 移除自动化归属（回退默认判定），不留冗余键。
          const { [String(conversationId)]: _removed, ...rest } = current
          void _removed
          return rest
        })()
      : { ...current, [String(conversationId)]: owner }
    this.documentStore.set(key, next)
    // 归属变化即投射：现存会话发 conversation.upsert（携带最新 ownedBy），
    // 前端 store 实时感知；已删会话（deleteConversation 兑底清理）无摘要可发，
    // 静默跳过（conversation.deleted 已另行发布）。
    if (this.store.getConv(conversationId) === undefined || this.store.isDeleted(conversationId)) return
    this.events.publish('conversation.upsert', this.conversations.summaryWithOwnership(conversationId))
  }

  /**
   * 插件会话管理权（删除保护）：仅已启用插件可持有；返回释放函数。
   * 同一插件重复 manage 幂等（一次 release 即全释）；插件停用生命周期由
   * PluginHost 调 releaseConversationOwnership 释放。
   */
  manageConversation(conversationId: number, pluginId: string): () => void {
    let owners = this.managedConversations.get(conversationId)
    if (owners === undefined) {
      owners = new Set()
      this.managedConversations.set(conversationId, owners)
    }
    owners.add(pluginId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseConversationOwnership(conversationId, pluginId)
    }
  }

  /** 释放指定插件对会话的管理权（无持有则幂等同式）。 */
  private releaseConversationOwnership(conversationId: number, pluginId: string): void {
    const owners = this.managedConversations.get(conversationId)
    if (!owners) return
    owners.delete(pluginId)
    if (owners.size === 0) this.managedConversations.delete(conversationId)
  }

  /** HTTP 固定消费面：public services（与 contracts.KernelRuntimeLike 一致）。 */
  get profiles(): ProfileService {
    return this.profilesSvc
  }

  get skills(): SkillService {
    return this.skillsSvc
  }

  get artifacts(): SvcArtifactService {
    return this.artifactsSvc
  }

  get auth(): SvcAuthService {
    return this.authSvc
  }

  get credentials(): CredentialService {
    return this.credentialsSvc
  }

  get providers(): ProviderService {
    return this.providersSvc
  }

  get stash(): SecretStash {
    return this.stashService
  }

  /** 兼容旧消费方的聚合入口（新代码请用具名 getter）。 */
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
      profiles: this.profilesSvc,
      skills: this.skillsSvc,
      artifacts: this.artifactsSvc,
      auth: this.authSvc,
      credentials: this.credentialsSvc,
      providers: this.providersSvc,
      stash: this.stashService,
    }
  }

  get safeSummaryRef() {
    return (id: number) => this.safeSummary(id)
  }

  private safeSummary(id: number): ConversationSummary | undefined {
    const meta = this.store.getConv(id)
    if (!meta) return undefined
    try {
      return this.conversations.withOwnership(this.tracker.summaryOf(id))
    } catch {
      return this.conversations.withOwnership(summaryOfFallback(meta, 'idle', 0))
    }
  }

  get isClosing(): boolean {
    return this.closed
  }

  /** worktree isPathInUse 探测（构造器内闭包用；单方法拆出防构造器膨胀）。 */
  private isPathInUseForWorktrees(nodeId: string, path: string): boolean {
    const contains = (cwd: string) => {
      const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
      const normalize = (value: string) => {
        const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
        return windows ? normalized.toLowerCase() : normalized
      }
      const normalized = normalize(path)
      const candidate = normalize(cwd)
      return candidate === normalized || candidate.startsWith(`${normalized}/`)
    }
    const leases = this.documentStore.get<Record<string, AgentExecutionInfo>>('runtime/worktree-execution-leases', {})
    for (const [leaseId, info] of Object.entries(leases)) {
      if (info.nodeId !== nodeId || info.worktree === undefined || !contains(info.worktree.path)) continue
      if (!this.activeSpawnExecutions.has(leaseId)) {
        throw new HelmError('worktree_execution_unknown', '工作树存在重启中断或未确认停止的执行，不能清理；请先检视并续接收尾，或确认停止后在目标节点手动清理 Git 工作树', 409, { nodeId, path, executionId: info.executionId, conversationId: info.conversationId })
      }
      return true
    }
    return [...this.activeSpawnExecutions.values()].some((info) => info.nodeId === nodeId && info.effectiveCwd !== undefined && contains(info.effectiveCwd)) ||
      this.listConversations().some((conv) => (conv.nodeId ?? 'local') === nodeId && contains(conv.cwd) && (conv.status === 'working' || conv.status === 'blocked')) ||
      (this.pluginHost?.listLiveWorktrees() ?? []).some((wt) => wt.nodeId === nodeId && contains(wt.path))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.modelsRegistry.abortRefresh(new Error('kernel closing'))
    // 1) 停定时器与资产监听（不再产生新副作用）。
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
    this.watcher?.close()
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    await this.nodes.dispose()
    // 先等已进入 Hook 管道的巡检收敛，避免插件释放后仍有回调写旧 Doc。
    await this.watchdogPending
    // 2) 等待在途 reloadModels（可能还在写 models 引用）。
    await this.reloadChain
    await this.modelsRegistry.dispose()
    // 3) 等待 turn_settled 钩子在途执行。
    await this.settledInflight
    // 4) 显式 abort 全部在途会话（SDK 任务收敛 + aborted 结算；空闲会话不结算）。
    for (const meta of this.store.listConvs()) {
      const conversation = await this.harness
        .conversation(meta.id as never, BACKGROUND_CONTEXT)
        .catch(() => undefined)
      if (!conversation) continue
      const wasBusy = this.tracker.hasLiveWork(meta.id)
      this.closeAborts.push(
        conversation
          .abort(BACKGROUND_CONTEXT)
          .then(() => {
            if (wasBusy) this.tracker.settleAborted(meta.id)
          })
          .catch(() => {
            /* abort 失败继续关停其余（close 本身会显式抛 store 错误） */
          }),
      )
    }
    await Promise.allSettled(this.closeAborts)
    await this.settledInflight
    await this.pluginHost?.dispose()
    // 4.5) 节点底座：断开全部远端连接（关 socket/rpc、杀远端命令）。
    await this.envFabric.dispose().catch(() => {
      /* dispose 尽力而为；后续 store 错误仍如实上报 */
    })
    // 5) 受管进程 token 销毁（此后工具子进程鉴权不再认它）。
    this.processTokenHandle?.dispose()
    this.processTokenHandle = undefined
    // 6) SDK 先关（此后无任何 SDK 写），再 flush store，最后关数据库。
    await this.harness.close(BACKGROUND_CONTEXT)
    const storeError = await this.store.close()
    await this.database.close()
    this.events.close()
    this.sessionDocLifecycleRelease?.()
    this.sessionDocLifecycleRelease = undefined
    this.sessionDocStreams.close()
    this.stashService.clear()
    if (storeError !== undefined) {
      throw new HelmError('store_flush_failed', `退出时持久化失败：${String(storeError)}`, 500, {
        error: String(storeError),
      })
    }
  }
}

/** models-store.json 启动损坏检测（open 阶段；语义同 ModelRegistry 内同名逻辑）。 */
async function assertModelsStoreHealthyAtBoot(models: Models): Promise<void> {
  const result = await models.refresh({ allowNetwork: false })
  for (const [, err] of result.errors) {
    if (err instanceof HelmError && err.code === 'models_store_corrupted') {
      throw new HelmError(
        'models_store_corrupted',
        `models-store.json 损坏（读取时发现）：${err.message}`,
        500,
      )
    }
  }
}

/** 内核/插件工具 execute 包装：tool_call handled 接管结果优先返回（不执行真实工具）。 */
function wrapToolExecute(
  handledToolCalls: Map<
    string,
    { conversationId: number | undefined; result: { output: Array<{ type: 'text'; text: string }>; isError: boolean } }
  >,
  execute: (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown>,
): (args: never, api: never, context: { abortSignal?: AbortSignal }) => Promise<unknown> {
  return async (args, api, context) => {
    const callId = (api as unknown as { callId?: string }).callId
    const handled = callId !== undefined ? handledToolCalls.get(callId) : undefined
    if (handled !== undefined) {
      handledToolCalls.delete(callId!)
      return handled.result
    }
    return execute(args, api, context)
  }
}

export { PROTO_ROOT }
