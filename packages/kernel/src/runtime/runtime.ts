/**
 * KernelRuntime：helm 微内核运行时组合根。
 *
 * 职责（机制，不含业务策略）：
 * - 打开单一 state.sqlite（pi-durable + helm 表 + FTS 共享 adapter 队列）；
 * - Harness（models getter 热更新 / registry 插件热装 / followUpMode: 'all'）；
 * - PluginHost 组合（config/credentials 分离持久、工具热装、plugin.changed 事件）；
 * - root #1 创建（先 ensureDefault profiles；root 不注入业务 system prompt，
 *   SYSTEM/MEMORY 由 assistant 插件经 before_turn sections 注入真实 system 段）；
 * - 7 类 hook 管道真实串联（trigger/input/before_turn/tool_call/tool_result/
 *   agent_spawn/turn_settled/watchdog_tick），全部作用于真实 SDK 行为；
 * - 会话 CRUD / 输入 / abort / 等待 / 五态派生 / SSE 事件；
 * - AskService（CAS + secret stash）/ subagent / gate / workflow runner 挂接点；
 * - 内核编排工具：subagent / SubagentWorkflow / run_action；
 * - AssetWatcher 静态资产热重载（providers/credentials 变更串行 reloadModels）。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { JsonValue } from '@earendil-works/chord'
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  type AgentChange,
  type Extension,
  type Registry,
  type ToolRegistration,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable'
import { GenerationTask, ToolTask } from '@earendil-works/pi-durable'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  AskCreateSpec,
  AskResult,
  AskSpec,
  ArtifactMetadata,
  ConversationAttachmentRef,
  ConversationDetail,
  ConversationEntry,
  ConversationInit,
  ConversationInput,
  ConversationInputResult,
  ConversationPatch,
  ConversationSummary,
  ExternalTriggerEnvelope,
  InputOrigin,
  WhenBusy,
  ToolResultHookPayload,
  WorkflowRunSummary,
} from '@helm/protocol'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { HelmError, ROOT_CONVERSATION_ID as PROTO_ROOT, type MaybePromise, type EnvExecRequest, type EnvExecResponse, type ModelProvidersRefreshResult, type NodeHealthSnapshot, type NodeInfo, type NodeIssuedToken } from '@helm/protocol'
import { randomBytes, randomUUID } from 'node:crypto'
import { hostname, loadavg, freemem, totalmem, uptime } from 'node:os'
import { chmod, mkdir, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  assertProfileId,
  ensureDataDir,
  resolveDataDir,
  type ArtifactRepository,
  type Profile,
} from '../services/index.js'
import { PluginHost, type DerivedToolSpec } from '../plugins/index.js'
import { createEnvFabric, sha256hex, tokenAuthenticator, type EnvFabric } from '../env/index.js'
import { AskService } from './asks.js'
import { ConversationTracker, deriveTitle } from './conversations.js'
import { EventHub } from './events.js'
import { createFileModelsStore } from './models-store.js'
import { buildModels, listModelCatalog, listModelProviders, requireModelRef } from './models.js'
import type { ModelCatalog } from '@helm/protocol'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Models, Provider } from '@earendil-works/pi-ai/models'
import type { ModelsStore, Model, ModelThinkingLevel, TranscriptContext } from '@earendil-works/pi-ai'
import { openHelmDatabase, type HelmDatabase } from './sqlite.js'
import { HelmStore, type ConvMeta } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { toConversationEntry } from './entries.js'
import { buildManagedEnv, createBashTool, createEditTool, createReadArtifactTool, createReadTool, createWriteTool, isAbsoluteTargetPath, runGate, runShell } from './tools.js'
import { runNativeSpawn, THINKING_LEVELS } from './spawn.js'
import { HelmPluginConfigStore } from './plugin-config-store.js'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { redactJsonValue } from '../redact.js'

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
   * 组合层（createHelm）传 false：先注册 assistant 插件 / 挂 WorkflowRunner，
   * 再 await start() 启动恢复，防止恢复任务在工具未注册时被判 orphaned。
   */
  autoResume?: boolean
  /**
   * watchdog 巡检间隔毫秒（默认 15000；start 后启动 singleflight 定时器）。
   * 传 0 关闭定时巡检（测试用；仍可手动 watchdogTick）。
   */
  watchdogIntervalMs?: number
}

export interface WorkflowRunnerFn {
  (request: Record<string, unknown>, conversationId: number, signal?: AbortSignal): Promise<unknown>
}

/** plugin.changed 宿主事件（PluginHost emitEvent 入参的既有约定形状）。 */
interface PluginChangedEmit {
  type: 'plugin.changed'
  plugin: unknown
  ui?: unknown[]
}

type HookDecision =
  | { action: 'continue' }
  | { action: 'transform'; value: unknown }
  | { action: 'handled'; result?: unknown }
  | { action: 'block'; reason: string }

/** XML 属性/文本转义（defang 防逃逸与 ownership 标记共用）。 */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** watchdog 默认巡检间隔（singleflight 定时器；0 关闭）。 */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000

/** PI 内置供应商 id 集（惰性一次构建；注册冲突预检用，不硬编码清单）。 */
const builtinProviderIds = new Set(builtinProviders().map((p) => p.id))

/**
 * models-store.json 文件级损坏检测：SDK refresh 把 store 读写错误包进
 * result.errors（不 reject，避免单供应商失败阻断其余），但文件损坏是全局
 * 事故——静默降级空目录等于丢失全部已缓存动态目录。此处显式上抛。
 */
function assertModelsStoreHealthy(result: { errors: ReadonlyMap<string, Error> }): void {
  for (const [providerId, err] of result.errors) {
    if (err instanceof HelmError && err.code === 'models_store_corrupted') {
      throw new HelmError(
        'models_store_corrupted',
        `models-store.json 损坏（读取 ${providerId} 时发现）：${err.message}`,
        500,
      )
    }
  }
}

/**
 * subagent 工具 effort 合法枚举（与 spawn.ts 原生执行行 THINKING_LEVELS 同源：
 * pi-ai ModelThinkingLevel）。声明处直接校验，拒绝任意字符串且不静默丢弃。
 */
const SPAWN_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 图片类 mime：附件拼装多模态 ImageContent 的判定集。 */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** entry.model 消息数组 -> assistant 文本块拼接（waitForInput 提取回答用）。 */
function assistantTextOfModel(model: unknown[] | undefined): string {
  if (model === undefined) return ''
  const out: string[] = []
  for (const message of model) {
    const blocks = (message as { content?: ReadonlyArray<{ type: string; text?: string }> }).content
    if (!blocks) continue
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

/** SDK pi.live 快照 -> 协议 ConversationLive 已由 entries.ts deriveConversationLive 提供。 */

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

/** 文本块提取（消息 content 数组 -> 纯文本）。 */
function textBlocksOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out.push((block as { text: string }).text)
    }
  }
  return out
}

export class KernelRuntime {
  readonly dataDir: string
  private readonly database: HelmDatabase
  private readonly harness: Harness
  private readonly registry: Registry
  private readonly store: HelmStore
  readonly events: EventHub
  private readonly tracker: ConversationTracker
  private readonly asks: AskService
  private readonly stashService = new SecretStash()
  /** 未配置模型时的 hooks 载荷占位（提交时 requireModelRef 显式报错）。 */
  private modelPlaceholder = 'unconfigured'
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
  private readonly setModelsSlot: (m: Models) => void = () => {}
  private modelsCurrent: Models
  private defaultModel: string | undefined
  private defaultThinkingLevel: string | undefined
  /** 同一会话的配置变更串行提交，避免继承刷新与显式覆盖互相覆盖。 */
  private readonly conversationChanges = new Map<number, Promise<unknown>>()
  private pluginHost: PluginHost | undefined
  private workflowRunner: WorkflowRunnerFn | undefined
  /** workflow run 摘要 provider（SSE snapshot 用；缺省 []）。 */
  private workflowRunProvider: () => WorkflowRunSummary[] = () => []
  /** onWorkflowSettled 监听器（app 接线；每 run 终态通知一次）。 */
  private readonly workflowSettledListeners = new Set<(run: WorkflowRunSummary) => void | Promise<void>>()
  /** 会话插件管理权：conversationId -> 持有 pluginId 集合（删除保护）。 */
  private readonly managedConversations = new Map<number, Set<string>>()
  /** 跨平台节点执行底座（local + 远端 BYOM 节点池；node-server 网关接线消费）。 */
  readonly envFabric: EnvFabric
  /** config.json 中登记的节点签发记录（nodeId -> sha256(token)）。 */
  private readonly nodeTokenIndex = new Map<string, string>()
  /** helm CLI 包装脚本目录（ensureCliBinDir 生成后非空）。 */
  private cliBinDirValue: string | undefined = undefined
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
  /** local 节点磁盘统计缓存（fs.statfs 异步采集；同步快照直接复用）。 */
  private localDiskStats: { diskFreeBytes: number; diskTotalBytes: number } | undefined
  /** local 磁盘统计后台刷新定时器（unref；close 时清理）。 */
  private localDiskRefreshTimer: NodeJS.Timeout | undefined
  /** local 磁盘统计在途刷新（singleflight，防重入叠加）。 */
  private localDiskRefreshing: Promise<void> = Promise.resolve()
  /** 动态模型目录持久缓存（models-store.json，0600 原子落盘）。 */
  private readonly modelsStore: ModelsStore
  /** 运行时动态注册的供应商（插件经 HostOptions.providers.register 注入）。 */
  private readonly runtimeProviders = new Map<string, Provider>()
  /** 运行时供应商归属（providerId -> 注册它的 pluginId；注销一并清除）。 */
  private readonly runtimeProviderOwners = new Map<string, string>()
  /** models 变更串行链：reload / register / unregister 共用，避免 stale 替换。 */
  private modelsChain: Promise<unknown> = Promise.resolve()
  private modelsRefreshAbort: AbortController | undefined
  /** models 集合代数（每次成功发布新集合 +1；在途 refresh 防旧集合重新发布）。 */
  private modelsGeneration = 0
  /** 运行时供应商在途使用计数（providerId -> streaming/refresh 未结算数；teardown 预检用）。 */
  private readonly runtimeProviderUsage = new Map<string, number>()

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
    // 离线恢复：从 models-store.json 恢复已缓存的动态目录（不发网络请求；
    // 文件损坏时 refresh 内部 read 抛 models_store_corrupted，显式失败不静默）。
    if (!modelsExternal) {
      // 离线恢复：从 models-store.json 恢复已缓存动态目录（不发网络请求；
      // 文件损坏时显式抛 models_store_corrupted，不静默降级空目录）。
      await assertModelsStoreHealthy(await modelsInstance.refresh({ allowNetwork: false }))
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
    this.defaultModel = init.defaultModel
    // 目录与 Harness 必须使用同一集合，不能在构造器另建一个缺少凭据的空配置集合。
    this.modelsCurrent = init.models
    this.modelsStore = init.modelsStore
    this.setModelsSlot = init.setModels
    if (init.externalModels) this.setModelsSlot = () => {
      /* 外部注入：热重载不得替换调用方模型集合 */
    }
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
    const artifactRepo: ArtifactRepository = {
      get: (id) => this.store.getArtifact(id),
      list: (conversationId) => this.store.listArtifacts(conversationId),
      put: (meta) => {
        this.store.putArtifact(meta)
      },
      deleteByConversation: (conversationId: number) => {
        this.store.deleteArtifactsByConversation(conversationId)
      },
    }
    this.artifactsSvc = new SvcArtifactService(init.dataDir, artifactRepo, this.stashService)
    this.authSvc = new SvcAuthService(init.dataDir)
    Object.assign(this.apiKeyCache, init.seedKeyCache)

    const hubUrl =
      init.hubUrl ?? `http://127.0.0.1:${process.env['HELM_PORT'] ?? '3202'}`
    this.hubUrlValue = hubUrl
    this.watchdogIntervalMs = init.watchdogIntervalMs

    // ---- 跨平台节点底座（EnvFabric）------------------------------------
    // fail-closed 鉴权：仅 config.json nodes 登记的 sha256(token) 可注册。
    // 加载失败（config 损坏）在 initialize 阶段显式上抛，不静默无鉴权运行。
    this.envFabric = createEnvFabric({
      authenticate: tokenAuthenticator((nodeId) => this.nodeTokenIndex.get(nodeId)),
      envOptions: ({ conversationId, cwd, nodeId }) =>
        buildManagedEnv(this.toolDeps, cwd, conversationId, nodeId),
    })
    // 节点上下线 -> node.changed SSE 事件（Web/CLI 实时感知）。
    // removeNode 已先删 nodeTokenIndex 再触发 registry.disconnect 时，
    // 离线事件交由 removeNode 统一发布（带 removed: true），此处不重复发。
    this.envFabric.registry.onNodeChanged((nodeId, online) => {
      if (!online && !this.nodeTokenIndex.has(nodeId)) return
      const conn = online ? this.envFabric.registry.get(nodeId) : undefined
      this.events.publish('node.changed', {
        type: 'node.changed',
        node: {
          id: nodeId,
          kind: 'byom',
          online,
          ...(conn?.hostname !== undefined ? { hostname: conn.hostname } : {}),
          ...(conn?.platform !== undefined ? { platform: conn.platform } : {}),
          ...(conn?.hubUrl !== undefined ? { hubUrl: conn.hubUrl } : {}),
          ...(conn?.connectedAt !== undefined ? { connectedAt: conn.connectedAt } : {}),
          ...(conn?.lastSeenAt !== undefined ? { lastSeenAt: conn.lastSeenAt } : {}),
          ...(conn?.health !== undefined ? { health: conn.health } : {}),
        } satisfies NodeInfo,
      })
    })
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
        return runtimeSelf.cliBinDirValue
      },
    }
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
        workflowRuns: this.workflowRunProvider(),
        // snapshot.nodes 与 node.changed 同源（listNodes 读取同一注册表），
        // 首帧即携带全部已知节点与在线状态，重连凭水位对齐。
        nodes: this.listNodesSync(),
      }),
      persistSeq: (seq) => this.store.setEventSeq(seq),
    })
    this.events.redactFn = (t) => this.stashService.redact(t)

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
          this.events.publish('conversation.upsert', this.withOwnership(summary))
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
  }

  private async initialize(): Promise<void> {
    // 0) 跨平台节点底座先行：加载 config.json 节点签发表（损坏显式上抛），
    //    生成 helm CLI 包装脚本（受管子进程可直接运行 helm）。
    await this.loadNodeTokens()
    await this.ensureCliBinDir()
    // 预热 local 磁盘统计：首个 SSE 快照（listNodesSync）即含磁盘字段。
    await this.ensureLocalDiskStats()
    // 1) 默认 profiles 先于 root 创建（root 绑定 assistant profile）。
    // 全局来源在内核统一解析；assistant Profile 的模型只属于该 Profile。
    await this.profilesSvc.ensureDefault()
    if (this.defaultModel === undefined) {
      const configured = (await this.configSvc.get()).model
      if (configured !== undefined && configured !== '') {
        if (typeof configured !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configured)) {
          throw new HelmError('config_corrupt', 'config.json.model 必须为 provider/model 形式的字符串', 500)
        }
        this.defaultModel = configured
      }
    }
    if (this.defaultThinkingLevel === undefined) {
      const configuredLevel = (await this.configSvc.get()).thinkingLevel
      if (configuredLevel !== undefined && configuredLevel !== '') {
        if (typeof configuredLevel !== 'string' || !THINKING_LEVELS.has(configuredLevel)) {
          throw new HelmError('config_corrupt', `config.json.thinkingLevel 非法（合法值：${[...THINKING_LEVELS].join(' | ')}）`, 500)
        }
        this.defaultThinkingLevel = configuredLevel
      }
    }
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'

    // 2) 内核工具（bash/read/read_artifact + subagent/SubagentWorkflow/run_action）
    //    经扩展注册；插件工具由 attachPluginHost 热装。
    this.installKernelTools()

    // 3) hook 桥：SDK GenerationTask/ToolTask 钩子 -> helm 7 hook 管道。
    this.installHookBridges()

    // 4) PluginHost：内核内创建并接入（app 只消费 runtime.plugins，不再自建）。
    //    config/credentials 分离持久经 HelmPluginConfigStore；损坏显式上抛。
    await this.pluginConfig.load()
    const host = new PluginHost({
      dataDir: this.dataDir,
      providers: {
        register: (provider, pluginId) => this.registerRuntimeProvider(provider, pluginId),
        assertIdle: (pluginId) => this.assertRuntimeProvidersIdle(pluginId),
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
        // PluginHost 在插件侧绑定身份，后端必须接收明确的 pluginId。
        manageConversation: (id, pluginId) => this.manageConversation(id, pluginId),
        markConversationOwnership: (id, owner) => this.markConversationOwnership(id, owner),
        createAsk: (spec) => this.createAsk(spec),
        cancelAsk: (askId, reason) => this.cancelAsk(askId, reason),
        registerAskSeqResolver: (resolver) => this.registerAskSeqResolver(resolver),
        onWorkflowSettled: (listener) => this.onWorkflowSettled(listener),
        emitEvent: (type, payload) => this.emitHostEvent(type, payload),
      },
      docs: this.documentStore,
      config: this.pluginConfig,
    })
    this.pluginHost = host

    // 5) root #1（不注入业务 system；SYSTEM/MEMORY 由 assistant 插件 before_turn
    //    sections 注入，经 SDK PromptSection 真实进入模型请求）。
    // root 模型与普通会话同链：显式 override（无）> assistant profile.model > 全局。
    // 思考档位同链：assistant profile.thinkingLevel > 全局默认；均未设置不注入。
    const rootThinking = await this.resolveEffectiveThinkingLevel(undefined, 'assistant')
    const rootEffective = await this.resolveEffectiveModel(undefined, 'assistant')
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

    // 6) 恢复：autoResume 时立即启动调度；否则等组合层 await start()。
    this.asks.reportOrphans()
    await this.recoverConversations()
    this.startAssetWatcher()
    if (this.init.autoResume) await this.start()
  }

  /** 内核工具（bash/read/write/edit/read_artifact + subagent/SubagentWorkflow/run_action）
   *  统一注册（与插件工具同一 registry 机制；execute 统一包 handled 接管）。 */
  private installKernelTools(): void {
    const kernelTools = [
      createBashTool(this.toolDeps),
      createReadTool(this.toolDeps),
      createWriteTool(this.toolDeps),
      createEditTool(this.toolDeps),
      createReadArtifactTool(this.toolDeps, (convId: number, artifactConvId: number) =>
        this.isArtifactAuthorized(convId, artifactConvId),
      ),
      this.createSubagentTool(),
      this.createWorkflowTool(),
      this.createRunActionTool(),
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
   * subagent 工具：模型内派生子代理（走 agent_spawn hook 链）。
   * 入参完整覆盖 §2：prompt / agentType / cwd / isolation / schema / gate /
   * resume / model / effort，原样转发 spawnAgent；onResolved 捕获执行环境
   * 元数据（conversationId / executionId / effectiveCwd / worktree），独立于
   * 业务 result 回报（模型据 conversationId 续接 resume，不混入 result）。
   */
  private createSubagentTool(): ToolRegistration {
    const runtime = this
    return defineTool({
      name: 'subagent',
      description:
        '派生一个子代理执行任务并等待结果。prompt 为任务指令；agentType 为 Profile ID 或外部运行时标识（如 herdr:agy）；可选 schema（JSON Schema，子代理最终输出需满足）、gate（shell 验收命令）、cwd、isolation（worktree）、model（provider/model）、effort。续接时将上次 execution.conversationId 或 execution.executionId 作为 resume。业务 result 与执行元数据独立返回。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '子代理任务指令' },
          agentType: { type: 'string', description: 'Profile ID 或外部运行时标识（缺省 assistant）' },
          cwd: { type: 'string', description: '子代理工作目录（绝对路径；缺省用 Profile/会话缺省）' },
          isolation: {
            type: 'string',
            enum: ['worktree'],
            description: '隔离模式（可选；worktree 需要支持隔离执行的外部运行时插件接管，例如 herdr）',
          },
          schema: { type: 'object', description: '结构化输出 JSON Schema（可选）' },
          gate: { type: 'string', description: '验收 shell 命令（可选，exit≠0 失败）' },
          resume: { type: 'string', description: '上次 execution.conversationId 或 execution.executionId，续接同一执行上下文' },
          model: { type: 'string', description: "模型覆盖 'provider/model'（可选）" },
          effort: {
            type: 'string',
            enum: [...SPAWN_EFFORT_LEVELS],
            description: '思考力度（可选）',
          },
          attachments: { type: 'array', items: { type: 'string' }, description: '随任务传递给子代理的产物 ID 列表（可选）' },
        },
        required: ['prompt'],
        additionalProperties: false,
      } as Record<string, unknown>,
      structuredOutputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          result: {},
          execution: {
            type: 'object',
            properties: {
              conversationId: { type: 'number' },
              executionId: { type: 'string' },
              effectiveCwd: { type: 'string' },
              worktree: {
                type: 'object',
                properties: { path: { type: 'string' }, branch: { type: 'string' } },
                required: ['path', 'branch'],
              },
            },
          },
        },
        required: ['ok'],
      } as Record<string, unknown>,
      async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
        // 防御性二次校验（SDK 已按 parameters 校验；直调路径同样拒绝非法值，
        // 绝不静默丢弃字段后降级执行）。
        if (args['isolation'] !== undefined && args['isolation'] !== 'worktree') {
          return {
            output: [
              {
                type: 'text',
                text: `subagent_failed: isolation 仅允许 'worktree'（收到 ${JSON.stringify(args['isolation'])}），不合法值绝不静默丢弃`,
              },
            ],
            isError: true,
            structuredOutput: { ok: false, result: `invalid isolation: ${JSON.stringify(args['isolation'])}` } as JsonValue,
          }
        }
        // 附件参数防御性校验：非空字符串数组之外一律显式拒绝（不静默丢弃）。
        if (args['attachments'] !== undefined) {
          const list = args['attachments']
          if (
            !Array.isArray(list) ||
            list.some((item) => typeof item !== 'string' || item.length === 0)
          ) {
            return {
              output: [
                {
                  type: 'text',
                  text: 'subagent_failed: attachments 需为非空字符串数组（产物 ID 列表）',
                },
              ],
              isError: true,
              structuredOutput: { ok: false, result: 'invalid attachments: 需为非空字符串数组' } as JsonValue,
            }
          }
        }
        let resolved: AgentExecutionInfo | undefined
        try {
          const result = await runtime.spawnAgent({
            parentConversationId: api.conversationId,
            prompt: String(args['prompt']),
            ...(args['agentType'] !== undefined ? { agentType: String(args['agentType']) } : {}),
            ...(args['cwd'] !== undefined ? { cwd: String(args['cwd']) } : {}),
            ...(args['isolation'] !== undefined ? { isolation: 'worktree' } : {}),
            ...(args['schema'] !== undefined ? { schema: args['schema'] as Record<string, unknown> } : {}),
            ...(args['gate'] !== undefined ? { gate: String(args['gate']) } : {}),
            ...(args['resume'] !== undefined ? { resume: String(args['resume']) } : {}),
            ...(args['model'] !== undefined ? { model: String(args['model']) } : {}),
            ...(args['effort'] !== undefined ? { effort: String(args['effort']) } : {}),
            ...(Array.isArray(args['attachments'])
              ? { attachments: args['attachments'] as string[] }
              : {}),
            onResolved: (info) => {
              resolved = info
            },
            signal: context.abortSignal,
          })
          // 元数据独立于业务 result 回报：文本尾行带续接标识（模型可复制为 resume）。
          const body = safeResultText(result, (text) => runtime.stash.redact(text))
          const footer = subagentFooter(args['resume'] !== undefined ? String(args['resume']) : undefined, resolved)
          return {
            output: [{ type: 'text', text: footer === '' ? body : `${body}\n${footer}` }],
            structuredOutput: {
              ok: true,
              result: result as JsonValue,
              ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
            } as JsonValue,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            output: [{ type: 'text', text: `subagent_failed: ${message}` }],
            isError: true,
            structuredOutput: { ok: false, result: message } as JsonValue,
          }
        }
      },
    } as never)
  }

  /**
   * SubagentWorkflow 工具：确定性编排（真实 WorkflowService，不假完成）。
   * 入参完整支持 script / scriptPath / name / args（任意 JSON，原样透传不
   * String 化）/ resumeFromRunId，全部转发 runWorkflow。
   */
  private createWorkflowTool(): ToolRegistration {
    const runtime = this
    return defineTool({
      name: 'SubagentWorkflow',
      description:
        '执行一个 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本。返回真实执行 summary（runId/status/nodes/result）。编排引擎未挂接时显式报错。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: '编排脚本源码（内联）' },
          scriptPath: { type: 'string', description: '编排脚本文件路径（与 script、name 择一）' },
          name: { type: 'string', description: '已保存工作流名（与 script、scriptPath 择一）' },
          args: { description: '传给脚本的任意 JSON args（对象/数组/标量均可，原样透传）' },
          resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId（可选）' },
        },
        additionalProperties: false,
      } as Record<string, unknown>,
      structuredOutputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: {},
        },
        required: ['ok'],
      } as Record<string, unknown>,
      async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
        const input: Record<string, unknown> = {}
        if (args['script'] !== undefined) input['script'] = String(args['script'])
        if (args['scriptPath'] !== undefined) input['scriptPath'] = String(args['scriptPath'])
        if (args['name'] !== undefined) input['name'] = String(args['name'])
        // args 任意 JSON：原样透传（绝不 String 化——脚本内 args.items.map 等用法依赖真实结构）。
        if (args['args'] !== undefined) input['args'] = args['args']
        if (args['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(args['resumeFromRunId'])
        try {
          const summary = await runtime.runWorkflow(input, api.conversationId, context.abortSignal)
          return {
            output: [{ type: 'text', text: safeResultText(summary, (text) => runtime.stash.redact(text)) }],
            structuredOutput: { ok: true, summary: summary as JsonValue } as JsonValue,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            output: [{ type: 'text', text: `workflow_failed: ${message}` }],
            isError: true,
            structuredOutput: { ok: false, summary: message } as JsonValue,
          }
        }
      },
    } as never)
  }

  /** run_action 元工具：按需调用插件动作（qualifiedId，输入输出 schema 边界校验）。 */
  private createRunActionTool(): ToolRegistration {
    const runtime = this
    return defineTool({
      name: 'run_action',
      description:
        '调用插件声明的动作（pluginId.actionId 全限定 ID）。动作清单由系统提示注入；输入校验失败显式报错。',
      parameters: {
        type: 'object',
        properties: {
          actionId: { type: 'string', description: 'pluginId.actionId 全限定动作 ID' },
          input: { type: 'object', description: '动作输入（按动作 inputSchema）' },
        },
        required: ['actionId'],
        additionalProperties: false,
      } as Record<string, unknown>,
      async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
        const host = runtime.pluginHost
        if (!host) {
          return {
            output: [{ type: 'text', text: 'run_action_failed: 插件宿主未初始化' }],
            isError: true,
          }
        }
        const qualified = String(args['actionId'])
        const dot = qualified.indexOf('.')
        if (dot <= 0) {
          return {
            output: [{ type: 'text', text: `run_action_failed: 非法动作 ID（期望 pluginId.actionId）：${qualified}` }],
            isError: true,
          }
        }
        try {
          const result = await host.invokeAction(qualified.slice(0, dot), qualified.slice(dot + 1), args['input'] ?? {}, {
            conversationId: api.conversationId,
            signal: context.abortSignal,
          })
          return {
            output: [{ type: 'text', text: safeResultText(result, (text) => runtime.stash.redact(text)) }],
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            output: [{ type: 'text', text: `run_action_failed: ${message}` }],
            isError: true,
          }
        }
      },
    } as never)
  }

  /** 插件宿主事件：plugin.changed 携带完整事件对象（{type, plugin, ui}）。 */
  private emitHostEvent(type: string, payload: unknown): void {
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
    this.events.publish(type, payload)
  }

  /**
   * 显式启动调度（幂等）：组合层（createHelm）在完成 assistant 插件注册、
   * WorkflowService 实例化与 setWorkflowRunner 后调用，随后恢复的
   * update_memory / load_skill / SubagentWorkflow 任务才不会因工具未注册
   * 被判 missing/orphaned。独立 open（autoResume 默认 true）无需再调。
   */
  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
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
  // 跨平台节点管理（EnvFabric / nodes）
  // ------------------------------------------------------------------

  /** 加载 config.json 的 nodes 签发表（nodeId -> sha256(token)）；损坏显式上抛。 */
  private async loadNodeTokens(): Promise<void> {
    const config = await this.configSvc.get()
    const nodes = config['nodes']
    this.nodeTokenIndex.clear()
    if (nodes === undefined) return
    if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) {
      throw new HelmError('config_corrupt', 'config.json.nodes 需为对象（nodeId -> sha256(token)）', 500)
    }
    for (const [nodeId, digest] of Object.entries(nodes as Record<string, unknown>)) {
      if (typeof digest !== 'string' || digest === '') {
        throw new HelmError('config_corrupt', `config.json.nodes['${nodeId}'] 需为非空字符串摘要`, 500)
      }
      this.nodeTokenIndex.set(nodeId, digest)
    }
  }

  /** 把当前签发表写回 config.json.nodes。 */
  private async persistNodeTokens(): Promise<void> {
    const nodes: Record<string, string> = {}
    for (const [nodeId, digest] of this.nodeTokenIndex) nodes[nodeId] = digest
    await this.configSvc.update({ nodes })
  }

  /**
   * 在 dataDir 下生成 <dataDir>/bin/helm 可执行包装脚本：
   * `#!/bin/sh\nexec <node> <tsx cli.mjs> <repo cli index> "$@"`（0o755）。
   * 使受管子进程在 PATH 中直接运行 helm 命令（--current 语义开箱即通）。
   * 幂等：内容变化时重写，权限恒 0o755。
   */
  private async ensureCliBinDir(): Promise<void> {
    const binDir = join(this.dataDir, 'bin')
    const helmPath = join(binDir, 'helm')
    // tsx CLI 与仓库 CLI 入口：以当前模块位置推导（源码运行与 dist 运行同构）。
    const kernelDir = dirname(fileURLToPath(import.meta.url))
    const repoRoot = this.resolveRepoRoot(kernelDir)
    const compiledCli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
    const sourceCli = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
    const fs = await import('node:fs/promises')
    const compiled = await fs.access(compiledCli).then(() => true, () => false)
    const args = compiled
      ? [process.execPath, compiledCli]
      : [process.execPath, join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), sourceCli]
    const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
    const script = `#!/bin/sh\nexec ${args.map(shellQuote).join(' ')} "$@"\n`
    try {
      await mkdir(binDir, { recursive: true })
      const existing = await import('node:fs/promises').then((fs) =>
        fs.readFile(helmPath, 'utf8').catch(() => undefined),
      )
      if (existing !== script) {
        await writeFile(helmPath, script, 'utf8')
      }
      await chmod(helmPath, 0o755)
      if (process.platform === 'win32') {
        const cmdArgs = args.map((value) => `"${value.replaceAll('%', '%%')}"`).join(' ')
        await writeFile(join(binDir, 'helm.cmd'), `@echo off\r\n${cmdArgs} %*\r\n`, 'utf8')
      }
      this.cliBinDirValue = binDir
    } catch (error) {
      // 包装脚本生成失败不阻断内核启动（受管子进程仍可用绝对路径），
      // 但显式通知（不静默吞）。
      this.events.publish('notification', {
        level: 'warning',
        title: 'helm CLI 包装脚本生成失败',
        body: String(error instanceof Error ? error.message : error),
      })
    }
  }

  /** 从 kernel 模块位置推导仓库根（src/runtime -> 上溯两级；dist 同构）。 */
  private resolveRepoRoot(kernelDir: string): string {
    // src/runtime 或 dist/runtime → packages/kernel/<x> → 仓库根。
    return dirname(dirname(dirname(dirname(kernelDir))))
  }

  /** local 磁盘统计后台刷新间隔（unref 定时器，不阻退出）。 */
  private static readonly LOCAL_DISK_REFRESH_MS = 30_000

  /** 单次 fs.statfs(dataDir) 采集 local 磁盘空间（失败时保留上次缓存，不阻断列表）。 */
  private async refreshLocalDiskStats(): Promise<void> {
    try {
      const st = await statfs(this.dataDir)
      this.localDiskStats = {
        diskFreeBytes: Number(st.bavail) * Number(st.bsize),
        diskTotalBytes: Number(st.blocks) * Number(st.bsize),
      }
    } catch {
      // 磁盘统计失败不影响节点列表主体（health 磁盘字段缺省），
      // 保留最近一次有效缓存。
    }
  }

  /** 异步刷新 local 磁盘缓存（singleflight）；首次调用同时启动后台定时刷新。 */
  private ensureLocalDiskStats(): Promise<void> {
    this.localDiskRefreshing = this.localDiskRefreshing.then(() => this.refreshLocalDiskStats())
    if (this.localDiskRefreshTimer === undefined) {
      this.localDiskRefreshTimer = setInterval(
        () => void this.ensureLocalDiskStats(),
        KernelRuntime.LOCAL_DISK_REFRESH_MS,
      )
      this.localDiskRefreshTimer.unref()
    }
    return this.localDiskRefreshing
  }

  /** local 节点实时健康快照（内存/负载实时采集；磁盘用最近一次缓存）。 */
  private localHealthSnapshot(): NodeHealthSnapshot {
    const [la1, la5, la15] = loadavg()
    const health: NodeHealthSnapshot = {
      collectedAt: Date.now(),
      uptimeSec: uptime(),
      loadAvg: [la1 ?? 0, la5 ?? 0, la15 ?? 0],
      memFreeBytes: freemem(),
      memTotalBytes: totalmem(),
    }
    const disk = this.localDiskStats
    if (disk !== undefined) {
      health.diskFreeBytes = disk.diskFreeBytes
      health.diskTotalBytes = disk.diskTotalBytes
    }
    return health
  }

  /** 节点列表：首项恒为 local；随后为 config.json 登记节点与实时在线状态。 */
  async listNodes(): Promise<NodeInfo[]> {
    await this.ensureLocalDiskStats()
    return this.listNodesSync()
  }

  /** 同步版（SSE snapshot provider 用；与 listNodes 同一数据源）。 */
  private listNodesSync(): NodeInfo[] {
    const out: NodeInfo[] = [
      {
        id: 'local',
        kind: 'local',
        online: true,
        hostname: hostname(),
        platform: process.platform,
        health: this.localHealthSnapshot(),
      },
    ]
    for (const nodeId of this.nodeTokenIndex.keys()) {
      const conn = this.envFabric.registry.get(nodeId)
      out.push({
        id: nodeId,
        kind: 'byom',
        online: conn !== undefined,
        ...(conn?.hostname !== undefined ? { hostname: conn.hostname } : {}),
        ...(conn?.platform !== undefined ? { platform: conn.platform } : {}),
        ...(conn?.hubUrl !== undefined ? { hubUrl: conn.hubUrl } : {}),
        ...(conn?.connectedAt !== undefined ? { connectedAt: conn.connectedAt } : {}),
        ...(conn?.lastSeenAt !== undefined ? { lastSeenAt: conn.lastSeenAt } : {}),
        ...(conn?.health !== undefined ? { health: conn.health } : {}),
      })
    }
    return out
  }

  /** 签发节点接入令牌：明文 token 仅本次返回，服务端只存 sha256。 */
  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_issue_local', "local 是内建节点，无需接入令牌", 400, { nodeId })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
      throw new HelmError(
        'validation_error',
        'nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/' +
          '（字母数字开头，可含 . _ -，最长 128 字符）',
        400,
        { nodeId },
      )
    }
    const secret = randomBytes(24).toString('base64url')
    const token = `${nodeId}:${secret}`
    this.nodeTokenIndex.set(nodeId, sha256hex(token))
    await this.persistNodeTokens()
    // 明文 token 入出站脱敏（绝不落库/进模型上下文/出现在日志）。
    this.stashService.addRedaction(token)
    this.stashService.addRedaction(secret)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: this.envFabric.isOnline(nodeId) },
    })
    return { nodeId, token, createdAt: Date.now() }
  }

  /** 移除节点：从签发表删除并立即掐断在途 WS 连接。 */
  async removeNode(nodeId: string): Promise<void> {
    if (nodeId === 'local') {
      throw new HelmError('cannot_remove_local_node', 'local 是内建节点，不可移除', 400, { nodeId })
    }
    if (!this.nodeTokenIndex.has(nodeId)) {
      throw new HelmError('not_found', `节点不存在：${nodeId}`, 404, { nodeId })
    }
    this.nodeTokenIndex.delete(nodeId)
    await this.persistNodeTokens()
    // 先掐断在途连接（可能触发 onNodeChanged 离线回调；彼时 nodeTokenIndex
    // 已删除，回调侧会跳过），再统一发布带 removed: true 的移除事件。
    this.envFabric.registry.disconnect(nodeId)
    this.events.publish('node.changed', {
      type: 'node.changed',
      node: { id: nodeId, kind: 'byom', online: false },
      removed: true,
    })
  }

  /**
   * 跨节点命令执行（POST /api/env/exec）：在目标 (nodeId, cwd) 执行命令。
   * 远端节点离线时 409 node_offline（绝不回退 local）；onChunk 逐块回放
   * stdout/stderr（NDJSON 流式模式用）；signal 传播取消（杀远端进程树）。
   */
  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    if (typeof req.command !== 'string' && !Array.isArray(req.command)) {
      throw new HelmError('validation_error', 'command 需为字符串或字符串数组', 400)
    }
    // 靶点解析：显式 nodeId/cwd > 会话绑定 (nodeId, cwd) > 'local'/Hub cwd。
    // 缺省参数绝不误跑 Hub：带 conversationId 时继承该会话的远端绑定。
    let nodeId = req.nodeId
    let cwd = req.cwd
    if (req.conversationId !== undefined) {
      const meta = this.store.getConv(req.conversationId)
      if (meta === undefined) {
        throw new HelmError('not_found', `会话不存在：${req.conversationId}`, 404, {
          conversationId: req.conversationId,
        })
      }
      if (nodeId === undefined) nodeId = meta.nodeId ?? 'local'
      if (cwd === undefined) cwd = meta.cwd
    }
    nodeId = nodeId ?? 'local'
    if (cwd === undefined) cwd = nodeId === 'local' ? this.toolDeps.defaultCwd : undefined
    // cwd 绝对性按目标形状判定（POSIX / 与 Windows 盘符/UNC 均合法），
    // 盘符相对（C:relative）拒绝；绝不用 Hub 宿主 isAbsolute 拒 Windows 路径。
    if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsoluteTargetPath(cwd))) {
      throw new HelmError(
        'validation_error',
        `cwd 需为绝对路径（POSIX / 开头或 Windows 盘符/UNC；拒绝盘符相对与相对路径。收到 ${String(cwd)}）`,
        400,
        { cwd },
      )
    }
    // 远端且未给定 cwd：拒绝盲跑（节点守护进程 dataDir 不是用户的意图靶点；
    // 安全目标：缺省参数绝不把远端会话命令误跑 Hub 或随机目录）。
    if (nodeId !== 'local' && cwd === undefined) {
      throw new HelmError(
        'validation_error',
        `远端节点 ${nodeId} 执行需显式 cwd 或绑定会话（拒绝盲跑节点默认目录）`,
        400,
        { nodeId },
      )
    }
    if (nodeId !== 'local' && !this.envFabric.isOnline(nodeId)) {
      throw new HelmError('node_offline', `节点 ${nodeId} 离线或未接入，拒绝执行（绝不回退本机）`, 409, {
        nodeId,
      })
    }
    const result = await runShell(this.toolDeps, req.command as string, {
      ...(cwd !== undefined ? { cwd } : {}),
      nodeId,
      conversationId: req.conversationId,
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      signal,
      // 流式模式：逐块回调透传（客户端自行限流）；Hub 侧聚合预算由
      // runShell 的 STREAM_AGGREGATE_LIMIT_BYTES 统一收敛（旧 64MiB 全文
      // 复制是内存泄漏）——流式客户端已收到全部逐块输出，终态 output
      // 仅作诊断聚合，超限显式 output_limit_exceeded（不改变帧协议）。
      ...(onChunk !== undefined ? { onOutputChunk: onChunk } : {}),
    })
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
      timedOut: result.timedOut,
    }
  }

  /** 产物授权：当前会话或其父链（子会话可读父会话产物）；最多 32 层防环。 */
  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    if (conversationId === artifactConversationId) return true
    let current: number | undefined = conversationId
    const seen = new Set<number>()
    for (let depth = 0; depth < 32 && current !== undefined && !seen.has(current); depth += 1) {
      seen.add(current)
      if (current === artifactConversationId) return true
      current = this.store.getConv(current)?.parentConversationId
    }
    return false
  }

  /**
   * 解析并授权校验附件产物 ID 列表：
   * - 产物必须存在（FileNotFoundError -> 404 not_found，附 artifactId）；
   * - 产物会话必须是当前会话或其父链（越权挂载 403 artifact_forbidden）；
   * - 返回轻量指针（ref）+ 完整元数据 + 绝对路径（供提示词与多模态拼装）。
   */
  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<
    Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>
  > {
    const unique = [...new Set(attachmentIds)]
    const out: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> = []
    for (const artifactId of unique) {
      const metadata = await this.artifactsSvc.get(artifactId).catch((error: unknown) => {
        if (error instanceof FileNotFoundError) {
          throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmError(
          'artifact_forbidden',
          `产物 ${artifactId} 不属于会话 ${conversationId} 或其父会话链，拒绝越权挂载`,
          403,
          { conversationId, artifactId, artifactConversationId: metadata.conversationId },
        )
      }
      out.push({
        ref: { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size },
        metadata,
        absPath: join(this.dataDir, metadata.path),
      })
    }
    return out
  }

  /** 单附件授权解析（app 组合层/herdr 插件依赖注入用；错误语义同上）。 */
  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    const [resolved] = await this.resolveAuthorizedAttachments(conversationId, [artifactId])
    if (resolved === undefined) {
      throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
    }
    return { ...resolved.ref, absPath: resolved.absPath }
  }

  private async recoverConversations(): Promise<void> {
    // 真实分页扫描（page.next 翻页）：未删除会话全部 observe——重启后凭 store
    // 元件即可定位，但观察者必须重建（否则永久 idle/丢 assistant 文本）。
    let cursor: unknown = undefined
    for (;;) {
      const page = await this.database.storage.scanConversations(
        {},
        500,
        cursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const record of page.items) {
        const id = record.id as number
        if (this.store.isDeleted(id)) continue
        if (!this.store.getConv(id)) {
          const now = Date.now()
          const conversation = await this.harness.conversation(record.id, BACKGROUND_CONTEXT)
          const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined) : undefined
          this.store.upsertConv({
            id,
            title: `会话 ${id}`,
            profileId: 'assistant',
            tags: [],
            parentConversationId: record.parent?.conversationId as number | undefined,
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
        }
        // 启动对齐：无显式 override 的会话按 profile/全局重算生效模型，
        // SDK 配置与镜像同步（profile 文件改动后重启即生效）。
        await this.alignConversationModel(id)
        await this.tracker.observe(id)
      }
      if (!page.next) break
      cursor = page.next
    }
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
  // hooks
  // ------------------------------------------------------------------

  private installHookBridges(): void {
    const self = this
    this.registry.install(
      defineExtension({
        name: 'helm-hook-bridge',
        hooks: [
          hook(ToolTask, {
            /** tool_call：transform 改写参数 / block 拦截。 */
            beforeTool: async (call, api) => {
              const outcome = await self.runHookChain('tool_call', {
                conversationId: api.conversationId as number,
                callId: call.id,
                toolName: call.name,
                input: call.arguments as Record<string, unknown>,
              })
              if (outcome?.action === 'block') {
                return { block: self.stash.redact(outcome.reason ?? 'blocked') }
              }
              if (outcome?.action === 'handled') {
                // 接管：结果登记到 execute 层缓存（wrapToolCalls 包装器消费）；
                // 同时记录归属会话，回合终态/abort/删除时兑底清理未消费残留。
                self.handledToolCalls.set(call.id, {
                  conversationId: api.conversationId as number,
                  result: toolResultOf(outcome.result),
                })
                return undefined
              }
              if (outcome?.action === 'transform') {
                const value = outcome.value as { input?: Record<string, unknown> }
                return { arguments: (value.input ?? call.arguments) as never }
              }
              return undefined
            },
            /** 所有工具最终输出都在持久化前经过同一脱敏与 Spill 边界。 */
            afterTool: async (call, result, api) => {
              self.handledToolCalls.delete(call.id)
              try {
                const outcome = await self.runHookChain('tool_result', {
                  conversationId: api.conversationId as number,
                  callId: call.id,
                  toolName: call.name,
                  input: call.arguments as Record<string, unknown>,
                  result,
                })
                let effective = result
                if (outcome?.action === 'transform') {
                  const payload = outcome.value as ToolResultHookPayload
                  const transformed = normalizeToolResult(payload.result)
                  if (!transformed) throw new HelmError('invalid_hook_result', 'tool_result 必须返回合法工具结果', 500)
                  effective = transformed as ToolExecutionResult
                } else if (outcome?.action === 'handled') {
                  const handled = normalizeToolResult(outcome.result)
                  if (!handled) throw new HelmError('invalid_hook_result', 'tool_result 接管产物不是合法工具结果', 500)
                  effective = handled as ToolExecutionResult
                }
                return await self.prepareToolResult(api.conversationId as number, effective)
              } catch (error) {
                return {
                  isError: true,
                  output: [{ type: 'text', text: self.stash.redact(`tool_result_failed: ${error instanceof Error ? error.message : String(error)}`) }],
                }
              }
            },
          }),
          hook(GenerationTask, {
            /**
             * before_turn 桥：SDK 原生 sections（PromptSection）与 tools 已在
             * prepare 阶段解析（request.messages 内含 pi.system 段消息），
             * beforeRequest 收到的 messages 是最终模型消息（含 system 前导）。
             * 这里把 sections/tools/messages 真实载荷交给插件，transform 结果
             * 通过 system 消息 sections / toolsAdded 真正改写模型请求。
             */
            beforeRequest: async (request, api) => {
              const conversationId = api.conversationId as number
              const summary = self.safeSummary(conversationId)
              if (!summary) return undefined
              const runtimeTools = getCurrentTools(request.messages)
              const payload = {
                conversation: summary,
                inputs: self.tracker.currentRunInputs(conversationId),
                tools: runtimeTools.map((spec) => ({
                  name: spec.name,
                  description: spec.description,
                  inputSchema: spec.parameters as Record<string, unknown>,
                })),
                sections: systemSectionsOf(request.messages as unknown as Array<Record<string, unknown>>),
                messages: request.messages as unknown as Array<Record<string, unknown>>,
              }
              const outcome = await self.runHookChain('before_turn', payload)
              if (outcome?.action !== 'transform') return undefined
              const value = outcome.value as typeof payload

              // sections 变更 -> 改写前导 system 消息的 sections（SDK 原生机制）。
              // messages 变更 -> 整体替换（插件显式要求时）。
              const original = request.messages as unknown as Array<Record<string, unknown>>
              let messages = original
              const sectionsChanged = !sectionsEqual(value.sections, payload.sections)
              const messagesChanged = value.messages !== payload.messages
              if (messagesChanged) messages = value.messages
              if (sectionsChanged) messages = withSections(messages, value.sections)

              const initialNames = new Set(runtimeTools.map((tool) => tool.name))
              const declared = new Set(value.tools.map((tool) => tool.name))
              if (declared.size !== initialNames.size || [...declared].some((name) => !initialNames.has(name))) {
                messages = withToolDeclarations(messages, declared, runtimeTools)
              }
              if (messages === original) return undefined
              return { messages: messages as unknown as typeof request.messages }
            },
          }),
        ],
      }) as Extension,
    )
  }

  private async prepareToolResult(conversationId: number, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    // SDK 结果的可选属性可为 undefined；先按 JSON 语义省略，再逐字符串脱敏。
    const safe = redactJsonValue(JSON.parse(JSON.stringify(result)), (text) => this.stash.redact(text)) as ToolExecutionResult
    const output = safe.output ?? []
    const text = output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const spill = await this.artifacts.spill(conversationId, `tool-${randomUUID()}`, text)
    if (!spill.artifact) return safe
    return { ...safe, output: [{ type: 'text', text: spill.text }, ...output.filter((block) => block.type !== 'text')] }
  }

  /** 统一 hook 管道执行；返回最终决定（continue 归一为 undefined 由调用方走默认）。 */
  private async runHookChain(name: string, payload: unknown): Promise<HookDecision | undefined> {
    const host = this.pluginHost
    if (!host) return undefined
    const result = await host.runHook(name as never, payload as never)
    if (result.action === 'continue') return undefined
    return result as HookDecision
  }

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
        async execute(args: unknown, api: never, context: { abortSignal?: AbortSignal }) {
          const toolApi = api as unknown as { conversationId: number }
          const result = await host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
            signal: context.abortSignal,
          })
          // 插件工具返回任意值：包成 SDK ToolExecutionResult 契约（content/text）。
          return pluginToolResult(result, (text) => runtime.stash.redact(text))
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

  private dispatchTurnSettled(payload: unknown, consumed: ConversationInput[]): Promise<void> {
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
  // public：conversations
  // ------------------------------------------------------------------

  listConversations(filter?: { profileId?: string; tag?: string; status?: string }): ConversationSummary[] {
    return this.store
      .listConvs()
      .map((meta) => this.summaryWithOwnership(meta.id))
      .filter((s) => (filter?.profileId ? s.profileId === filter.profileId : true))
      .filter((s) => (filter?.tag ? s.tags.includes(filter.tag) : true))
      .filter((s) => (filter?.status ? s.status === filter.status : true))
  }

  getConversation(id: number): ConversationSummary {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    return this.summaryWithOwnership(id)
  }

  /** 摘要 + 实时归属投射：tracker 摘要不读 ownership doc，此处统一附加（缺省 human）。 */
  private summaryWithOwnership(id: number): ConversationSummary {
    return { ...this.tracker.summaryOf(id), ownedBy: this.getConversationOwnership(id) }
  }

  /** 已构造摘要沿用权威归属；删除后的 tracker 回调在发布前丢弃。 */
  private withOwnership(summary: ConversationSummary): ConversationSummary {
    return { ...summary, ownedBy: this.getConversationOwnership(summary.id) }
  }

  /** cursor 最大编码长度（base64url 后；超长拒绝防滥用）。 */
  private static readonly DETAIL_CURSOR_MAX_LENGTH = 2048

  /**
   * 会话详情（摘要 + 分页时间线）：
   * - 默认最新 100 条，SDK descending 取页后 reverse 为显示（升序）顺序；
   * - cursor 是 base64url(JSON{conversationId,cursor:SDK next})：绑定会话、
   *   长度/JSON 合法性校验、limit 钳制 1..500；不静默截断；
   * - entry 保留 model 消息与 data，出界前经事件同源脱敏（发布路径统一）。
   */
  async getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const summary = this.getConversation(id)
    const limit = options?.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HelmError('validation_error', `limit 必须是 1..500 的整数（收到 ${limit}）`, 400, {
        limit,
      })
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    // SDK descending（最新在前）取页，再 reverse 为时间正序（展示顺序）。
    const page = await conversation.entries({ order: 'descending' }, limit, sdkCursor as never, BACKGROUND_CONTEXT)
    const entries = [...page.items]
      .reverse()
      .map((raw) => toConversationEntry(raw as { id: number; kind: string }))
    return {
      ...summary,
      entries,
      ...(page.next !== undefined ? { nextCursor: this.encodeDetailCursor(id, page.next) } : {}),
    }
  }

  /** 编码分页 cursor：base64url(JSON{conversationId,cursor})。 */
  private encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** 解码并校验分页 cursor：绑定会话、长度与 JSON 合法性（非法显式拒绝）。 */
  private decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > KernelRuntime.DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmError('validation_error', 'cursor 超过最大长度', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmError('validation_error', 'cursor 不是合法的 base64url JSON', 400)
    }
    const shape = decoded as { conversationId?: unknown; cursor?: unknown }
    if (
      shape === null ||
      typeof shape !== 'object' ||
      Number(shape.conversationId) !== conversationId ||
      typeof shape.cursor !== 'object' ||
      shape.cursor === null
    ) {
      throw new HelmError(
        'validation_error',
        `cursor 不属于会话 ${conversationId} 或结构非法`,
        400,
      )
    }
    return shape.cursor
  }

  /** 校验 'provider/model' 引用（create/update 共用）。 */
  private parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
    }
    return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
  }

  /** Profile 读取失败与不存在分开报告，避免损坏文件被当成缺少模型配置。 */
  private async readProfile(profileId: string): Promise<Profile | undefined> {
    try {
      assertProfileId(profileId)
    } catch (error) {
      throw new HelmError('validation_error', error instanceof Error ? error.message : String(error), 400)
    }
    try {
      return await this.profilesSvc.get(profileId)
    } catch (error) {
      throw new HelmError(
        'profile_read_failed',
        `读取 Profile ${profileId} 失败：${error instanceof Error ? error.message : String(error)}`,
        500,
        { profileId },
      )
    }
  }

  /** 会话覆盖 > Profile.model > 全局；Profile 文件每次实时读取。 */
  private async resolveEffectiveModel(
    override: string | undefined,
    profileId: string,
  ): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('profile_not_found', `会话引用的 Profile 不存在：${profileId}`, 404, { profileId })
    }
    return override || profile.model || this.defaultModel
  }

  private async withConversationChange<T>(id: number, change: () => Promise<T>): Promise<T> {
    const previous = this.conversationChanges.get(id) ?? Promise.resolve()
    const run = previous.then(change, change)
    this.conversationChanges.set(id, run)
    try {
      return await run
    } finally {
      if (this.conversationChanges.get(id) === run) this.conversationChanges.delete(id)
    }
  }

  /** 模型与思考档位分别继承；始终核对 SDK，以修复重启或 fork 的历史快照。 */
  private async alignConversationModel(id: number, emitEvent = false): Promise<void> {
    await this.withConversationChange(id, async () => {
      const meta = this.store.getConv(id)
      if (!meta) return
      const effective = await this.resolveEffectiveModel(meta.modelOverride, meta.profileId)
      const thinking = await this.resolveEffectiveThinkingLevel(meta.thinkingLevelOverride, meta.profileId)
      const ref = effective ? this.parseModelRefOrThrow(effective) : undefined
      const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      const agent = await conversation.agent(BACKGROUND_CONTEXT)
      const change: AgentChange = {
        ...(agent.model?.provider !== ref?.provider || agent.model?.modelId !== ref?.modelId
          ? { model: ref ?? null } : {}),
        ...(agent.thinkingLevel !== (thinking ?? 'off')
          ? { thinkingLevel: (thinking as ModelThinkingLevel | undefined) ?? null } : {}),
      }
      const sdkChanged = Object.keys(change).length > 0
      if (sdkChanged) await conversation.configure(change, BACKGROUND_CONTEXT)
      if (!sdkChanged && meta.model === (effective ?? '') && meta.thinkingLevel === (thinking ?? '')) return
      const latest = this.store.getConv(id)
      if (!latest) return
      this.store.upsertConv({
        ...latest,
        model: effective ?? '',
        thinkingLevel: thinking ?? '',
        stateChangeSeq: latest.stateChangeSeq + 1,
        updatedAt: Date.now(),
      })
      if (emitEvent) this.events.publish('conversation.upsert', this.summaryWithOwnership(id))
    })
  }

  /** Profile 保存后的即时继承刷新（覆盖值由各自的解析链保护）。 */
  async alignProfileConversations(profileId: string): Promise<void> {
    for (const meta of this.store.listConvs()) {
      if (meta.profileId === profileId) await this.alignConversationModel(meta.id, true)
    }
  }

  /** 仅省略 profileId 时选择 assistant；显式 ID 必须对应真实 Profile。 */
  private async resolveProfileForCreate(init: ConversationInit): Promise<string> {
    const requested = init.profileId ?? 'assistant'
    const found = await this.readProfile(requested)
    if (!found) {
      throw new HelmError('validation_error', `profile 不存在：${requested}（先创建 profiles/${requested}）`, 400)
    }
    return requested
  }

  /** 思考档位覆盖 > Profile.thinkingLevel > 全局默认。 */
  private async resolveEffectiveThinkingLevel(override: string | undefined, profileId: string): Promise<string | undefined> {
    const profile = await this.readProfile(profileId)
    if (!profile) throw new HelmError('profile_not_found', `会话引用的 Profile 不存在：${profileId}`, 404, { profileId })
    return override || profile.thinkingLevel || this.defaultThinkingLevel
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    const profileId = await this.resolveProfileForCreate(init)
    const profile = await this.readProfile(profileId)
    // init.model 是显式覆盖（非全局继承）：仅在提供时校验并落 override。
    if (init.model !== undefined && init.model !== '') this.parseModelRefOrThrow(init.model)
    const effectiveModel = await this.resolveEffectiveModel(init.model, profileId)
    const effectiveRef = effectiveModel ? this.parseModelRefOrThrow(effectiveModel) : undefined
    // nodeId 解析链：init.nodeId > profile.nodeId > parent.nodeId > 'local'。
    const parentMeta =
      init.parentConversationId !== undefined ? this.store.getConv(init.parentConversationId) : undefined
    const nodeId =
      init.nodeId ?? profile?.nodeId ?? parentMeta?.nodeId ?? 'local'
    // cwd 解析链（只算一次，SDK agent.cwd 与 store 镜像同一个值）：
    // init.cwd > profile.cwd > parent.cwd > local 用 Hub 缺省 cwd；
    // 远端节点两者皆无时显式拒绝（节点守护进程目录非用户意图靶点，拒绝盲跑）。
    // 注：不对继承 cwd 做 Hub realpath/resolve 污染——目标节点可能与 Hub
    // 异平台（如 Windows C:\workspace），保持原样交给目标节点语义。
    const inheritedCwd = init.cwd ?? profile?.cwd ?? parentMeta?.cwd
    let effectiveCwd: string
    if (inheritedCwd !== undefined) {
      effectiveCwd = inheritedCwd
    } else if (nodeId === 'local') {
      effectiveCwd = this.toolDeps.defaultCwd
    } else {
      throw new HelmError(
        'validation_error',
        `会话绑定远端节点 ${nodeId} 但未提供 cwd（Profile.cwd / 父会话 cwd / init.cwd 均缺失；拒绝盲跑节点默认目录）`,
        400,
        { nodeId },
      )
    }
    const effectiveThinking = await this.resolveEffectiveThinkingLevel(undefined, profileId)
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          cwd: effectiveCwd,
          ...(effectiveRef ? { model: { provider: effectiveRef.provider, modelId: effectiveRef.modelId } } : {}),
          ...(effectiveThinking ? { thinkingLevel: effectiveThinking as ModelThinkingLevel } : {}),
        },
      },
      BACKGROUND_CONTEXT,
    )
    const id = conv.id as number
    const now = Date.now()
    this.store.upsertConv({
      id,
      title: init.title ?? '',
      profileId,
      tags: init.tags ?? [],
      parentConversationId: init.parentConversationId,
      nodeId,
      cwd: effectiveCwd,
      model: effectiveModel ?? '',
      thinkingLevel: effectiveThinking ?? '',
      ...(init.model !== undefined && init.model !== '' ? { modelOverride: init.model } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.tracker.observe(id)
    const summary = this.summaryWithOwnership(id)
    this.events.publish('conversation.upsert', summary)
    return summary
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    return this.withConversationChange(id, () => this.updateConversationConfiguration(id, patch))
  }

  private async updateConversationConfiguration(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    if (patch.profileId !== undefined) {
      const found = await this.readProfile(patch.profileId)
      if (!found) {
        throw new HelmError('validation_error', `profile 不存在：${patch.profileId}`, 400)
      }
    }
    // model 语义：'' = 清除显式覆盖（重算继承链）；非空 = 显式覆盖（校验格式）。
    let nextOverride: string | undefined
    if (patch.model === undefined) {
      nextOverride = meta.modelOverride
    } else if (patch.model !== '') {
      this.parseModelRefOrThrow(patch.model)
      nextOverride = patch.model
    }
    // thinkingLevel：'' = 清除（跟随缺省）；非空必须在枚举内（拒绝任意字符串）。
    let nextThinkingOverride: string | undefined
    if (patch.thinkingLevel === undefined) {
      nextThinkingOverride = meta.thinkingLevelOverride
    } else {
      const level = patch.thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `thinkingLevel '${level}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextThinkingOverride = level || undefined
    }
    const nextProfileId = patch.profileId ?? meta.profileId
    // 换 profile 且无 override 时重算生效模型（跨 profile 隔离不残留旧模型）。
    const effectiveModel = await this.resolveEffectiveModel(nextOverride, nextProfileId)
    const effectiveRef = effectiveModel ? this.parseModelRefOrThrow(effectiveModel) : undefined
    const nextThinking = await this.resolveEffectiveThinkingLevel(nextThinkingOverride, nextProfileId)
    // SDK null 删除字段；undefined 保持原值。先提交 SDK，再发布生效镜像。
    const configureChange: AgentChange = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      model: effectiveRef ?? null,
      thinkingLevel: (nextThinking as ModelThinkingLevel | undefined) ?? null,
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.configure(configureChange, BACKGROUND_CONTEXT)
    const latest = this.store.getConv(id)
    if (!latest) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const updated: typeof meta = {
      ...latest,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.profileId !== undefined ? { profileId: patch.profileId } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      model: effectiveModel ?? '',
      thinkingLevel: nextThinking ?? '',
      thinkingLevelOverride: nextThinkingOverride,
      ...(nextOverride !== undefined ? { modelOverride: nextOverride } : { modelOverride: undefined }),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      // unread 仅人类显式 PATCH 清零；API 读取不清零。
      ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
      stateChangeSeq: latest.stateChangeSeq + 1,
      updatedAt: Date.now(),
    }
    this.store.upsertConv(updated)
    // 靶点（nodeId/cwd）变更即释放旧靶点底座缓存：旧实例上的在途 exec/reader
    // 不受影响（evict 只移缓存不杀进程），后续 exec 落在新靶点新实例。
    if (patch.nodeId !== undefined || patch.cwd !== undefined) {
      this.envFabric.evictConversation(id)
    }
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /**
   * 删除会话：root 保护；abort 在途 -> 取消 asks -> 清 artifacts（物理文件）->
   * FTS 行 -> Helm 索引移除 + tombstone。
   * 注：SDK 无 deleteConversation 写 API，pi_* 内部历史由 SDK 保留，
   * helm 侧重启后凭 tombstone 不再重新导入（逻辑删除）。
   */
  async deleteConversation(id: number): Promise<void> {
    if (id === PROTO_ROOT) {
      throw new HelmError('root_conversation_protected', '根会话 #1 不可删除', 403)
    }
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    // 插件管理权保护：任何活跃 owner 持有时拒绝（在一切清理副作用之前）。
    const owners = [...(this.managedConversations.get(id) ?? [])]
    if (owners.length > 0) {
      throw new HelmError(
        'conversation_managed_by_plugin',
        `会话 ${id} 正被插件管理（${owners.join(', ')}），先释放管理权再删除`,
        409,
        { conversationId: id, owners },
      )
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    // 级联取消等待真实落盘；IO 失败必须向上 reject（阻止后续删除副作用），
    // 绝不吞错很成功。
    await this.asks.cancelByConversation(id)
    await this.artifactsSvc.deleteConversation(id)
    this.events.publish('notification', {
      level: 'info',
      title: '会话已删除',
      body: `会话 ${id} 及其产物/待答 AskDoc 已清理`,
      conversationId: id,
    })
    this.tracker.stopObserving(id)
    this.store.deleteConv(id)
    // 删除兑底：清理该会话的 handled 接管残留与 EnvFabric 会话靶点缓存
    //（bases 中该 conversationId 的 env 与其输出 sink 注册）。
    this.evictHandledToolCalls(id)
    this.envFabric.evictConversation(id)
    // 清除归属登记，防止重建同号会话时继承已删除会话的自动化权限。
    this.markConversationOwnership(id, 'human')
    this.events.publish('conversation.deleted', { conversationId: id })
  }

  /**
   * 提交输入：input hook（transform 生效——text/origin/whenBusy/id 全部取最终
   * payload；conversationId 被 transform 视为身份违规拒绝）-> SDK submit。
   */
  async submitInput(
    id: number,
    text: string,
    opts?: {
      origin?: InputOrigin
      whenBusy?: WhenBusy
      meta?: Record<string, unknown>
      attachments?: string[]
    },
  ): Promise<{ submissionId: string }> {
    if (this.closed) throw new HelmError('runtime_closed', '内核正在关闭，拒绝提交新输入', 503)
    const convMeta = this.store.getConv(id)
    if (!convMeta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    // 模型解析链统一入口：全部缺失时只在提交时显式拒绝（其他读路径不报错）。
    const effectiveModelRef = await this.resolveEffectiveModel(convMeta.modelOverride, convMeta.profileId)
    if (!effectiveModelRef) {
      throw new HelmError(
        'model_not_configured',
        `会话 ${id}（profile ${convMeta.profileId}）与全局均未配置模型：请在 Profile、HELM_MODEL、config.json.model 或会话中配置 model`,
        503,
        { conversationId: id, profileId: convMeta.profileId },
      )
    }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    // 初始附件：提交时先解析存在性与父链授权（越权 403 / 不存在 404）。
    const initialAttachments =
      opts?.attachments !== undefined && opts.attachments.length > 0
        ? await this.resolveAuthorizedAttachments(id, opts.attachments)
        : undefined

    const origin: InputOrigin = opts?.origin ?? 'human'
    const inputId = randomUUID()
    const createdAt = Date.now()
    // 边界脱敏：meta 值经 stash redact 后入库（受管 Token 等绝不经 meta 透传）。
    // text 原样交给 input 钩子（hook 可感知/改写原始输入），最终消费前统一脱敏。
    const safeMeta =
      opts?.meta !== undefined
        ? (redactJsonValue(opts.meta, (t) => this.stash.redact(t)) as Record<string, unknown>)
        : undefined
    const payload: { conversationId: number; input: ConversationInput } = {
      conversationId: id,
      input: {
        id: inputId,
        text,
        origin,
        whenBusy: opts?.whenBusy,
        createdAt,
        ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
        ...(initialAttachments !== undefined
          ? { attachments: initialAttachments.map((r) => r.ref) }
          : {}),
      },
    }
    const hookOutcome = await this.runHookChain('input', payload)
    if (hookOutcome?.action === 'block') {
      throw new HelmError('input_blocked', hookOutcome.reason ?? '输入被 input 钩子拦截')
    }
    if (hookOutcome?.action === 'handled') {
      return { submissionId: `handled:${randomUUID()}` }
    }
    let finalInput: ConversationInput = payload.input
    let finalWhenBusy: WhenBusy | undefined = opts?.whenBusy
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as typeof payload
      if (value.conversationId !== id) {
        throw new HelmError(
          'input_identity_changed',
          `input 钩子不得改写 conversationId（${id} -> ${String(value.conversationId)}）`,
          400,
        )
      }
      finalInput = value.input
      finalWhenBusy = finalInput.whenBusy ?? finalWhenBusy
    }
    // transform 可能改写 attachments：对最终 ID 列表再次校验并取权威元数据
    //（钩子产物与直接输入同权，绝不让 transform 绕过授权门禁）。
    let resolvedAttachments = initialAttachments
    const finalIds = finalInput.attachments?.map((a) => a.id) ?? []
    if (finalIds.length > 0 || initialAttachments !== undefined) {
      resolvedAttachments =
        finalIds.length > 0 ? await this.resolveAuthorizedAttachments(id, finalIds) : undefined
    }
    // 最终输入统一脱敏（直接输入与 transform 产物同权）：text/effectiveText 与
    // meta 均不得携带已登记秘密明文（受管 Token、SecretStash 秘密）。此后的
    // 自动标题、tracker、helm.input entry、SDK content 与持久化全部使用脱敏值。
    if (finalInput.meta !== undefined) {
      finalInput = {
        ...finalInput,
        meta: redactJsonValue(finalInput.meta, (t) => this.stash.redact(t)) as Record<string, unknown>,
      }
    }
    const effectiveText = this.stash.redact(finalInput.text)
    // SQLite 零膨胀：helm.input entry 的 attachments 仅存轻量指针
    //（{id,name,mimeType,size}），绝不含 base64 字节。
    finalInput = {
      ...finalInput,
      text: effectiveText,
      ...(resolvedAttachments !== undefined
        ? { attachments: resolvedAttachments.map((r) => r.ref) }
        : { attachments: undefined }),
    }

    // input Hook 可能执行异步 IO；期间开始关停时不得继续写入或创建 SDK 回合。
    if (this.closed) throw new HelmError('runtime_closed', '内核正在关闭，拒绝提交新输入', 503)
    // 首输入自动标题。
    if (convMeta.title === '') {
      const title = deriveTitle(effectiveText)
      this.store.upsertConv({ ...convMeta, title, stateChangeSeq: convMeta.stateChangeSeq + 1, updatedAt: Date.now() })
    }

    // 模型可见内容：无附件保持纯文本；有附件拼接 [Attached Files] 清单，
    // 图片附件额外构造多模态 ImageContent 块（字节 base64 进模型上下文）。
    const content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> =
      resolvedAttachments !== undefined
        ? await this.buildAttachmentContent(effectiveText, resolvedAttachments)
        : effectiveText

    const key = this.tracker.registerInput(id, finalInput)
    try {
      const submission = await conversation.submit(
        {
          type: 'input',
          content: content as never,
          whenBusy: finalWhenBusy ?? 'followUp',
          // 最终 payload 的 origin/id/meta 落入 helm.input entry（模型可见来源标记）。
          entry: {
            kind: 'helm.input',
            data: {
              id: finalInput.id,
              text: effectiveText,
              origin: finalInput.origin,
              createdAt: finalInput.createdAt,
              ...(finalInput.meta !== undefined ? { meta: finalInput.meta } : {}),
              ...(resolvedAttachments !== undefined
                ? { attachments: resolvedAttachments.map((r) => r.ref) }
                : {}),
            } as unknown as JsonValue,
          },
          requestId: finalInput.id,
        },
        BACKGROUND_CONTEXT,
      )
      this.tracker.bindSubmission(id, key, submission.id as number)
      return { submissionId: String(submission.id) }
    } catch (error) {
      this.tracker.dropInput(id, key)
      throw normalizeBusyError(error)
    }
  }

  /** [Attached Files] 纯文本清单块（spawn 任务提示词用；无正文前缀）。 */
  private buildAttachmentBlock(
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): string {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    return `[Attached Files]\n${lines.join('\n')}`
  }

  /**
   * 构造带附件的模型可见内容：
   * - [Attached Files] 清单（含拉取指引）拼在正文后；
   * - 存在图片附件时返回多模态块数组（文本块 + 图片 ImageContent base64）；
   * - 无图片附件时返回拼接后的纯文本。
   */
  private async buildAttachmentContent(
    effectiveText: string,
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): Promise<
    string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  > {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    const attachedBlock = `[Attached Files]\n${lines.join('\n')}`
    const modelText = effectiveText.length > 0 ? `${effectiveText}\n\n${attachedBlock}` : attachedBlock
    const hasImage = resolved.some(({ ref }) => IMAGE_MIMES.has(ref.mimeType))
    if (!hasImage) return modelText
    const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: modelText },
    ]
    for (const item of resolved) {
      if (!IMAGE_MIMES.has(item.ref.mimeType)) continue
      const bytes = await this.artifactsSvc.readBuffer(item.ref.id)
      contentParts.push({
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: item.ref.mimeType,
      })
    }
    return contentParts
  }

  /**
   * 等待单次提交的精确结果（send --wait / POST ?wait=1）：
   * - 以 harness.submission 核对身份（conversationId/id/type）后 await wait；
   * - done 后按 answer entryId 精确读取条目（minEntryId=maxEntryId），保留 model
   *   消息，assistant 文本逐值脱敏；
   * - failed/aborted 显式抛错（turn_failed/turn_aborted），绝不伪造回答；
   * - handled:* 的提交没有真实 SDK submission，显式不适用而非造成功。
   */
  async waitForInput(id: number, submissionId: string): Promise<ConversationInputResult> {
    if (submissionId.startsWith('handled:')) {
      throw new HelmError(
        'wait_not_applicable',
        `提交 ${submissionId} 被 input 钩子接管，无真实回合可等待`,
        409,
        { conversationId: id, submissionId },
      )
    }
    const numericId = Number(submissionId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new HelmError('validation_error', `非法 submissionId：${submissionId}`, 400)
    }
    if (!this.store.getConv(id)) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const submission = await this.harness.submission(numericId as never, BACKGROUND_CONTEXT)
    if (!submission) {
      throw new HelmError('not_found', `提交不存在：${submissionId}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const status = (await submission.status(BACKGROUND_CONTEXT)) as unknown as {
      conversationId?: unknown
      id?: unknown
      type?: string
    }
    if (
      String(status.conversationId) !== String(id) ||
      String(status.id) !== submissionId ||
      status.type !== 'input'
    ) {
      throw new HelmError('not_found', `提交 ${submissionId} 不属于会话 ${id}`, 404, {
        conversationId: id,
        submissionId,
      })
    }
    const settled = (await submission.wait(BACKGROUND_CONTEXT)) as unknown as {
      status: 'queued' | 'placed' | 'done' | 'unanswered'
      answer?: number
      reason?: string
      detail?: unknown
    }
    if (settled.status === 'unanswered') {
      // 终态未获回答：按 reason 区分失败/中止（aborted/faulted/model_error 等），
      // 绝不伪造回答文本。
      const reason = settled.reason ?? 'unknown'
      const aborted = reason === 'aborted' || reason === 'interrupted' || reason === 'reset'
      throw new HelmError(
        aborted ? 'turn_aborted' : 'turn_failed',
        `会话 ${id} 本轮未获回答（${reason}${settled.detail !== undefined ? `：${String(settled.detail)}` : ''}）`,
        aborted ? 499 : 502,
        {
          conversationId: id,
          submissionId,
          reason,
          detail: settled.detail,
        },
      )
    }
    if (settled.status !== 'done' || settled.answer === undefined) {
      // 理论不可达（wait 只回终态）；防御性显式报错而非吞。
      throw new HelmError('turn_failed', `提交 ${submissionId} 结算为非终态 ${settled.status}`, 502, {
        conversationId: id,
        submissionId,
        status: settled.status,
      })
    }
    // 精确读取 answer entry（保留 model；文本逐值脱敏）。
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const page = await conversation.entries(
      { minEntryId: settled.answer as never, maxEntryId: settled.answer as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    const raw = page.items[0] as
      | { id: number; kind: string; data?: unknown; model?: unknown[] }
      | undefined
    if (raw === undefined || raw.id !== settled.answer) {
      throw new HelmError('not_found', `回答条目缺失：${settled.answer}`, 502, {
        conversationId: id,
        submissionId,
      })
    }
    const entry = toConversationEntry(raw)
    const text = this.stash.redact(assistantTextOfModel(entry.model))
    return { conversationId: id, submissionId, text, entry }
  }

  async abortConversation(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const wasBusy = this.tracker.hasLiveWork(id)
    await conversation.abort(BACKGROUND_CONTEXT)
    // 仅在途会话结算 aborted；空闲 abort 不伪造终态（已完成/已失败回合不覆盖）。
    if (wasBusy) this.tracker.settleAborted(id)
    // abort 兑底：未被 execute 消费的 handled 接管残留一并清理。
    this.evictHandledToolCalls(id)
  }

  /** 内核关闭守卫（上下文操作共用）。 */
  private assertNotClosedForContextOp(): void {
    if (this.closed) throw new HelmError('runtime_closed', '内核正在关闭', 503)
  }

  /** 取已存在的会话元数据与 SDK 句柄（不存在统一 404）。 */
  private async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    return { meta, conversation }
  }

  /** 重置会话上下文：SDK reset(handoff) 后推进 stateChangeSeq 并广播摘要。 */
  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertNotClosedForContextOp()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeHandoff =
      opts?.handoff !== undefined && opts.handoff !== '' ? this.stash.redact(opts.handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /** 手动压缩：SDK compact(instructions) 返回后台任务 ID；返回 { taskId, conversation }。 */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertNotClosedForContextOp()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeInstructions =
      opts?.instructions !== undefined && opts.instructions !== ''
        ? this.stash.redact(opts.instructions)
        : undefined
    const taskId = await conversation.compact(safeInstructions, BACKGROUND_CONTEXT)
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * 从指定条目分叉新会话：SDK fork(entryId) 后登记 helm 镜像
   *（继承 profile/tags/cwd/model/override；父链指向源会话）并对齐模型。
   */
  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertNotClosedForContextOp()
    if (!Number.isSafeInteger(opts.entryId) || opts.entryId <= 0) {
      throw new HelmError('validation_error', `entryId 需为安全正整数（收到 ${String(opts.entryId)}）`, 400, {
        entryId: opts.entryId,
      })
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // 条目存在性精确校验（min=max=entryId 取 1 条；不存在 404）。
    const page = await sourceConv.entries(
      { minEntryId: opts.entryId as never, maxEntryId: opts.entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || (page.items[0] as { id: number }).id !== opts.entryId) {
      throw new HelmError('not_found', `条目 ${opts.entryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: opts.entryId,
      })
    }
    const forked = await sourceConv.fork(
      opts.entryId as never,
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `会话 ${id}`
    const title =
      opts.title !== undefined && opts.title.trim() !== ''
        ? this.stash.redact(opts.title.trim())
        : `${baseTitle} (分叉)`
    this.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: id,
      nodeId: sourceMeta.nodeId ?? 'local',
      cwd: sourceMeta.cwd,
      model: sourceMeta.model,
      thinkingLevel: sourceMeta.thinkingLevel,
      thinkingLevelOverride: sourceMeta.thinkingLevelOverride,
      ...(sourceMeta.modelOverride !== undefined ? { modelOverride: sourceMeta.modelOverride } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.alignConversationModel(newId)
    await this.tracker.observe(newId)
    const summary = this.tracker.summaryOf(newId)
    this.events.publish('conversation.upsert', this.withOwnership(summary))
    return summary
  }

  /** 等待会话空闲（含本会话 turn_settled 钩子异步执行完成）。 */
  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    await this.tracker.waitTurnSettled(id)
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.tracker.getLastAssistantText(id) ?? ''
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
    const outcome = await this.runHookChain('trigger', initial)
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
    // 附件门禁在进入 hook 链之前：agent_spawn 钩子与原生执行行均受统一授权
    // 保护（产物存在 + 父会话链归属）；transform 改写后再校验一次。
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    const outcome = await this.runHookChain('agent_spawn', request)
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
    return runNativeSpawn(
      {
        ...this.toolDeps,
        harness: this.harness,
        getLastAssistantText: (id) => this.tracker.getLastAssistantText(id),
        resolveModel: () => {
          const ref = requireModelRef(this.defaultModel)
          return ref
        },
        resolveThinkingLevel: () => this.defaultThinkingLevel,
        agentSessions: this.agentSessions,
        resolveAttachmentsForPrompt:
          resolvedAttachments !== undefined
            ? async () => this.buildAttachmentBlock(resolvedAttachments)
            : undefined,
        registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel) => {
          const profile = await this.readProfile(profileId)
          const now = Date.now()
          this.store.upsertConv({
            id: childId,
            title: `子代理 ${childId}`,
            profileId,
            // 内核零角色硬编码：tags 由调用方策略决定（原生 spawn 传 []）。
            tags,
            parentConversationId: parentId,
            // 与普通创建一致：Profile 节点优先于父会话缺省节点。
            nodeId: profile?.nodeId ?? this.store.getConv(parentId)?.nodeId ?? 'local',
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
        },
        resolveProfile: async (profileId) => {
          const profile = await this.readProfile(profileId)
          if (!profile) return undefined
          return {
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
            ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
            ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}),
            ...(profile.runtime !== undefined ? { runtime: profile.runtime } : {}),
          }
        },
        getModelOverride: (childId) => this.store.getConv(childId)?.modelOverride,
        getParentOfConversation: (childId) =>
          this.store.getConv(childId)?.parentConversationId,
        // resume 配置基线端口：镜像读取与真实更新（SDK configure + 持久化 +
        // 模型继承链，复用宿主 updateConversation，不重建身份字段）。
        getConversation: (childId) => {
          const meta = this.store.getConv(childId)
          return meta ? this.tracker.summaryOf(childId) : undefined
        },
        updateConversation: (childId, patch) => this.updateConversation(childId, patch),
        installChildExtension: (extension) => {
          this.registry.install(extension)
        },
      },
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

  /** workflow 执行注入（主代理组合 WorkflowService 后调用）。 */
  setWorkflowRunner(fn: WorkflowRunnerFn): void {
    this.workflowRunner = fn
  }

  /** workflow run 摘要 provider（SSE snapshot.workflowRuns 用；缺省 []）。 */
  setWorkflowRunProvider(provider: () => WorkflowRunSummary[]): void {
    this.workflowRunProvider = provider
  }

  /**
   * 订阅工作流 run 终态（completed/failed/aborted，每 run 恰好一次）；
   * 返回解除函数。监听器异常向上抛（app->kernel 通知插件清理失败必须显式，
   * 禁止吞错伪成功）。
   */
  onWorkflowSettled(listener: (run: WorkflowRunSummary) => void | Promise<void>): () => void {
    this.workflowSettledListeners.add(listener)
    return () => {
      this.workflowSettledListeners.delete(listener)
    }
  }

  /**
   * 工作流 run 终态通知（app 接线 WorkflowService.onRunSettled -> 此处）：
   * 串行执行全部监听器；任一异常原样向上抛（调用方据此让清理失败显式），
   * 绝不假成功。
   */
  async notifyWorkflowSettled(run: WorkflowRunSummary): Promise<void> {
    for (const listener of [...this.workflowSettledListeners]) {
      await listener(run)
    }
  }

  /** 内部使用的 workflow 执行（spawnAgent 同源的 hook 链）。 */
  async runWorkflow(request: Record<string, unknown>, conversationId: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.workflowRunner) {
      throw new HelmError('unsupported_runtime', 'Workflow 引擎尚未挂接（setWorkflowRunner 未调用）', 503)
    }
    return this.workflowRunner(request, conversationId, signal)
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
      const outcome = await this.runHookChain('watchdog_tick', payload)
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
  // asks / search / models / services
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

  async search(query: string): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    return this.store.search(query)
  }

  async rebuildFts(): Promise<void> {
    await this.store.rebuildFts(async (index) => {
      for (const conv of this.listConversations()) {
        const conversation = await this.harness.conversation(conv.id as never, BACKGROUND_CONTEXT)
        if (!conversation) continue
        let cursor: unknown = undefined
        for (;;) {
          const page = await conversation.entries(
            { order: 'ascending' },
            50,
            cursor as never,
            BACKGROUND_CONTEXT,
          )
          for (const entry of page.items) {
            const text = entryModelText(entry as never)
            if (text) index(conv.id, `entry:${entry.id}`, conv.title, this.stashService.redact(text))
          }
          if (!page.next) break
          cursor = page.next
        }
      }
    })
  }

  async listModels(): Promise<ModelCatalog> {
    return listModelCatalog(this.modelsCurrent, { model: this.defaultModel, thinkingLevel: this.defaultThinkingLevel })
  }

  /** 设置全局默认模型与思考档位（config.json）：格式校验后原子写入并即时生效；空串删除键。 */
  async setDefaultModel(model?: string, thinkingLevel?: string): Promise<void> {
    const trimmed = model?.trim()
    if (trimmed !== undefined && trimmed !== '') this.parseModelRefOrThrow(trimmed)
    let nextLevel: string | undefined
    if (thinkingLevel !== undefined) {
      const level = thinkingLevel.trim()
      if (level !== '' && !THINKING_LEVELS.has(level)) {
        throw new HelmError(
          'validation_error',
          `thinkingLevel '${level}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
          400,
        )
      }
      nextLevel = level === '' ? undefined : level
    }
    await this.configSvc.updateBy((current) => {
      const next = { ...current }
      if (trimmed === '') delete next.model
      else if (trimmed !== undefined) next.model = trimmed
      if (thinkingLevel === undefined) {
        // 未传入则不动既有思考档位键。
      } else if (nextLevel === undefined) {
        delete next.thinkingLevel
      } else {
        next.thinkingLevel = nextLevel
      }
      return next
    })
    if (trimmed !== undefined) this.defaultModel = trimmed === '' ? undefined : trimmed
    if (thinkingLevel !== undefined) this.defaultThinkingLevel = nextLevel
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
    // 两个覆盖字段互相独立，模型被覆盖的会话仍可继承全局思考档位。
    for (const meta of this.store.listConvs()) {
      await this.alignConversationModel(meta.id, true)
    }
  }

  listModelProviders() {
    return listModelProviders(this.modelsCurrent, this.runtimeProviderOwners)
  }

  /**
   * 重建并发布模型集（providers.json / credentials / 运行时供应商变化共用）。
   * 串行：经 modelsChain 排队，避免并发重建至后旧集合覆盖新集合；
   * 外部注入 Models（测试/嵌入场景）空操作（模型集合归调用方）。
   */
  async reloadModels(): Promise<void> {
    await this.enqueueModelsChange(async () => {
      await this.rebuildModelsLocked()
    })
  }

  /** modelsChain 尾排队执行（异常向后传播，不阻断后续排队）。 */
  private enqueueModelsChange<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.modelsChain.then(fn, fn)
    this.modelsChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 已在 modelsChain 内执行的重建（外部注入集合空操作）。 */
  private async rebuildModelsLocked(): Promise<void> {
    if (this.init.externalModels) return
    const providerConfigs = await this.providersSvc.list()
    const nextKeys: Record<string, string> = {}
    for (const id of await this.credentialsSvc.list()) {
      const key = await this.credentialsSvc.get(id)
      if (key) nextKeys[id] = key
    }
    const collision = providerConfigs.find((config) => this.runtimeProviders.has(config.id))
    if (collision) {
      throw new HelmError('runtime_provider_conflict', `网关 ${collision.id} 与插件注册的供应商冲突`, 409)
    }
    const models = buildModels({
      providers: providerConfigs,
      apiKeys: () => nextKeys,
      modelsStore: this.modelsStore,
      extraProviders: [...this.runtimeProviders.values()],
    })
    // 离线恢复缓存目录（allowNetwork:false 不发网络请求）。models-store.json 损坏
    // 是文件级事故（非单供应商失败）：SDK 会把它包进 result.errors 而不 reject，
    // 这里必须显式上抛，绝不静默降级空目录。
    await assertModelsStoreHealthy(await models.refresh({ allowNetwork: false }))
    // 完整读取成功后才发布；整体替换，确保删除密钥后旧缓存也失效。
    for (const id of Object.keys(this.apiKeyCache)) delete this.apiKeyCache[id]
    Object.assign(this.apiKeyCache, nextKeys)
    this.modelsGeneration += 1
    this.modelsCurrent = models
    this.setModelsSlot(this.modelsCurrent)
    this.events.publish('models.changed', { providers: [] })
  }

  /**
   * 运行时注册动态供应商（插件经 HostOptions.providers.register 注入）。
   * 冲突拒绝（不覆盖任何已有供应商）：内置 provider / providers.json 自定义网关 /
   * 其他 owner 已注册的同 id；providers.json 当前未启用的同 id 网关同样占用命名空间。
   * 外部注入 Models 场景显式 unsupported（集合归调用方，注册成功却目录不变即欺骗）。
   * 返回幂等注销函数：仅当 map 仍指向同一 provider 实例时删除并重建。
   */
  async registerRuntimeProvider(provider: Provider, pluginId?: string): Promise<() => Promise<void>> {
    if (this.init.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        '外部注入 Models 时不支持运行时供应商注册（模型集合归调用方所有）',
        400,
      )
    }
    if (typeof provider?.id !== 'string' || provider.id === '') {
      throw new HelmError('validation_error', `运行时供应商 id 需为非空字符串：${String(provider?.id)}`, 400)
    }
    // 捕获本次注册的包装实例；旧释放句柄不得寻址后续同名注册。
    const registered = await this.enqueueModelsChange(async () => {
      const conflict = await this.findRuntimeProviderConflict(provider.id)
      if (conflict !== undefined) {
        throw new HelmError('runtime_provider_conflict', conflict, 409)
      }
      const registered = this.wrapRuntimeProvider(provider)
      this.runtimeProviders.set(provider.id, registered)
      if (pluginId !== undefined) this.runtimeProviderOwners.set(provider.id, pluginId)
      try {
        await this.rebuildModelsLocked()
      } catch (error) {
        // 回滚：注册失败不留孤儿 map 项（下次 reload 也不会再包含它）。
        this.runtimeProviders.delete(provider.id)
        this.runtimeProviderOwners.delete(provider.id)
        throw error
      }
      return registered
    })
    let disposed = false
    let disposing: Promise<void> | undefined
    return () => {
      if (disposed) return Promise.resolve()
      if (disposing) return disposing
      disposing = this.unregisterRuntimeProvider(registered)
        .then(() => { disposed = true })
        .finally(() => { disposing = undefined })
      return disposing
    }
  }

  /** 冲突检测：返回错误消息（undefined = 无冲突）。内置/自定义网关/其他 owner 互斥。 */
  private async findRuntimeProviderConflict(providerId: string): Promise<string | undefined> {
    const existing = this.runtimeProviders.get(providerId)
    if (existing !== undefined) {
      const owner = this.runtimeProviderOwners.get(providerId)
      return `供应商 id '${providerId}' 已被运行时注册${owner !== undefined ? `（插件 ${owner}）` : ''}，不得覆盖`
    }
    const config = await this.providersSvc.get(providerId)
    if (config !== undefined) {
      return `供应商 id '${providerId}' 与 providers.json 自定义网关冲突（enabled: ${String(config.enabled)}）`
    }
    const builtin = builtinProviderIds.has(providerId)
    if (builtin) {
      return `供应商 id '${providerId}' 与 PI 内置供应商冲突，不得覆盖`
    }
    return undefined
  }

  /** 注销：仅当 map 仍指向同一实例时删除（幂等；被覆盖/已删时不重复重建）。 */
  private async unregisterRuntimeProvider(provider: Provider): Promise<void> {
    if (this.init.externalModels) return
    await this.enqueueModelsChange(async () => {
      if (this.runtimeProviders.get(provider.id) !== provider) return
      const owner = this.runtimeProviderOwners.get(provider.id)
      if ((this.runtimeProviderUsage.get(provider.id) ?? 0) > 0) {
        throw new HelmError('plugin_has_live_tasks', `供应商 ${provider.id} 仍有在途请求`, 409, { providers: [provider.id] })
      }
      this.runtimeProviders.delete(provider.id)
      this.runtimeProviderOwners.delete(provider.id)
      try {
        await this.rebuildModelsLocked()
      } catch (error) {
        this.runtimeProviders.set(provider.id, provider)
        if (owner !== undefined) this.runtimeProviderOwners.set(provider.id, owner)
        throw error
      }
    })
  }

  /**
   * 刷新动态模型目录（POST /api/models/refresh）。
   * 目标运行时供应商在途计数覆盖整个 refresh 周期（teardown 预检拒绝中途回收）；
   * 捕获调用时集合与代数：等待期间集合被替换时不再发布旧集合快照事件；
   * 错误消息经 stash 脱敏后返回。
   */
  async refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    return this.enqueueModelsChange(() => this.refreshModelsLocked(options))
  }

  private async refreshModelsLocked(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    if (this.closed) throw new HelmError('runtime_closing', '内核正在关闭，不能刷新模型目录', 409)
    if (this.init.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        '外部注入 Models 时不支持动态目录刷新（模型集合归调用方所有）',
        400,
      )
    }
    const instanceAtStart = this.modelsCurrent
    const generationAtStart = this.modelsGeneration
    const targets =
      options?.providers && options.providers.length > 0
        ? options.providers.filter((id) => this.runtimeProviders.has(id))
        : [...this.runtimeProviders.keys()]
    const release = this.acquireRuntimeProviders(targets)
    const controller = new AbortController()
    this.modelsRefreshAbort = controller
    let result: { aborted: boolean; errors: ReadonlyMap<string, Error> }
    try {
      for (const id of options?.providers ?? []) {
        const provider = instanceAtStart.getProvider(id)
        if (!provider) throw new HelmError('model_provider_not_found', `供应商 ${id} 未注册`, 404)
        if (!provider.refreshModels) throw new HelmError('model_provider_static', `供应商 ${id} 使用静态模型目录，不支持动态刷新`, 400)
      }
      result = await instanceAtStart.refresh({
        signal: controller.signal,
        allowNetwork: options?.allowNetwork ?? true,
        force: options?.force ?? true,
        ...(options?.providers && options.providers.length > 0 ? { providers: options.providers } : {}),
      })
    } finally {
      if (this.modelsRefreshAbort === controller) this.modelsRefreshAbort = undefined
      release()
    }
    // 文件级损坏（models_store_corrupted）不是单供应商失败，显式上抛。
    await assertModelsStoreHealthy(result)
    const errors: Record<string, string> = {}
    for (const [providerId, err] of result.errors) {
      errors[providerId] = this.stashService.redact(err instanceof Error ? err.message : String(err))
    }
    const snapshotStale =
      instanceAtStart !== this.modelsCurrent || generationAtStart !== this.modelsGeneration
    if (!snapshotStale) {
      this.events.publish('models.changed', { providers: options?.providers ? [...options.providers] : [] })
    }
    return {
      providers: options?.providers ? [...options.providers] : [],
      aborted: result.aborted || snapshotStale,
      errors,
      models: (await this.listModels()).models,
      providerCatalog: this.listModelProviders(),
    }
  }

  /**
   * teardown 预检：插件 owner 的运行时供应商若有在途 streaming/refresh 则抛
   * 409 plugin_has_live_tasks（防止插件标为 disabled 但 provider 仍在目录）。
   * 只要 busy 就保留现状（模型引用保留且下一回合可用）。
   */
  assertRuntimeProvidersIdle(pluginId: string): void {
    const busy: string[] = []
    for (const [id, owner] of this.runtimeProviderOwners) {
      if (owner === pluginId && (this.runtimeProviderUsage.get(id) ?? 0) > 0) busy.push(id)
    }
    if (busy.length > 0) {
      throw new HelmError(
        'plugin_has_live_tasks',
        `插件 ${pluginId} 的运行时供应商仍有在途模型请求：${busy.join(', ')}`,
        409,
        { providers: busy },
      )
    }
  }

  /** 在途使用计数：目标 provider 各 +1；返回幂等释放函数（各 -1，归零清除）。 */
  private acquireRuntimeProviders(ids: readonly string[]): () => void {
    for (const id of ids) {
      const owner = this.runtimeProviderOwners.get(id)
      if (owner !== undefined) this.pluginHost?.assertProviderAvailable(owner)
    }
    for (const id of ids) {
      this.runtimeProviderUsage.set(id, (this.runtimeProviderUsage.get(id) ?? 0) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const remaining = (this.runtimeProviderUsage.get(id) ?? 0) - 1
        if (remaining <= 0) this.runtimeProviderUsage.delete(id)
        else this.runtimeProviderUsage.set(id, remaining)
      }
    }
  }

  /**
   * 运行时供应商使用计数包装：stream/streamSimple 真正调用时 +1，事件流终态
   * （result() 在 done/error/end 时 resolve）后 -1；不消费 asyncIterator。
   * refreshModels 同样计数（目录刷新在途时 teardown 预检拒绝）。
   */
  private wrapRuntimeProvider(provider: Provider): Provider {
    const acquire = () => this.acquireRuntimeProviders([provider.id])
    // 通用包装：先取流后 result().finally 释放（同步抛同样释放，不留永久 busy）；
    // 不消费 asyncIterator、不改写 options（泛型参数仅随具体化签名传递）。
    const counted = (open: () => AssistantMessageEventStream): AssistantMessageEventStream => {
      const release = acquire()
      let stream: AssistantMessageEventStream
      try {
        stream = open()
      } catch (err) {
        release()
        throw err
      }
      void stream.result().then(release, release)
      return stream
    }
    const wrapped: Provider = {
      ...provider,
      get baseUrl() { return provider.baseUrl },
      stream: (model, context, options) =>
        counted(() => provider.stream(model, context, options)),
      streamSimple: (model, context, options) =>
        counted(() => provider.streamSimple(model, context, options)),
    }
    if (typeof provider.refreshModels === 'function') {
      const base = provider.refreshModels.bind(provider)
      wrapped.refreshModels = async (context) => {
        const release = acquire()
        try {
          return await base(context)
        } finally {
          release()
        }
      }
    }
    return wrapped
  }

  /** 同步读 key 缓存（启动预热 + reload 刷新）。 */
  private readonly apiKeyCache: Record<string, string> = {}

  /**
   * 全局文档存储端口（WorkflowService / PluginHost docs 共用同一 SQLite 镜像与队列）：
   * - get(key, initial)：同步读，缺省返回 initial（不落盘）；
   * - set(key, value)：同步镜像 + 排队持久化（helm_plugin_docs 全局命名空间）；
   * - flush()：等待队列冲刷完成（失败显式抛 store_flush_failed）。
   * 命名空间约定：'<owner>/<name>'（如 'workflow/runs-index'、'<pluginId>/<doc>'）。
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
    this.events.publish('conversation.upsert', this.summaryWithOwnership(conversationId))
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
      return this.withOwnership(this.tracker.summaryOf(id))
    } catch {
      return this.withOwnership(summaryOfFallback(meta, 'idle', 0))
    }
  }

  get isClosing(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.modelsRefreshAbort?.abort(new Error('kernel closing'))
    // 1) 停定时器与资产监听（不再产生新副作用）。
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
    this.watcher?.close()
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    if (this.localDiskRefreshTimer !== undefined) {
      clearInterval(this.localDiskRefreshTimer)
      this.localDiskRefreshTimer = undefined
    }
    await this.localDiskRefreshing
    // 先等已进入 Hook 管道的巡检收敛，避免插件释放后仍有回调写旧 Doc。
    await this.watchdogPending
    // 2) 等待在途 reloadModels（可能还在写 models 引用）。
    await this.reloadChain
    await this.modelsChain
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
    this.stashService.clear()
    if (storeError !== undefined) {
      throw new HelmError('store_flush_failed', `退出时持久化失败：${String(storeError)}`, 500, {
        error: String(storeError),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 工具结果契约 helpers（插件/钩子产物 -> SDK ToolExecutionResult）
// ---------------------------------------------------------------------------

/** 任意值 -> 模型可见文本（对象 JSON 序列化）。 */
function safeResultText(value: unknown, redact: (text: string) => string = (text) => text): string {
  if (typeof value === 'string') return redact(value)
  if (value === undefined) return ''
  return JSON.stringify(redactJsonValue(value, redact))
}

/** AgentExecutionInfo -> structuredOutput.execution（仅保留已回传字段，JSON-safe）。 */
function executionOf(info: AgentExecutionInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (info.conversationId !== undefined) out['conversationId'] = info.conversationId
  if (info.executionId !== undefined) out['executionId'] = info.executionId
  if (info.effectiveCwd !== undefined) out['effectiveCwd'] = info.effectiveCwd
  if (info.worktree !== undefined) {
    out['worktree'] = { path: info.worktree.path, branch: info.worktree.branch }
  }
  return out
}

/**
 * subagent 工具输出尾行：续接标识（resume 标识与实际执行环境元数据）。
 * 模型可把 conversationId / executionId 原样作为下次 resume 入参。
 */
function subagentFooter(resumeRef: string | undefined, resolved: AgentExecutionInfo | undefined): string {
  const parts: string[] = []
  if (resumeRef !== undefined) parts.push(`resume=${resumeRef}`)
  if (resolved?.conversationId !== undefined) parts.push(`conversationId=${resolved.conversationId}`)
  if (resolved?.executionId !== undefined) parts.push(`executionId=${resolved.executionId}`)
  if (resolved?.effectiveCwd !== undefined) parts.push(`cwd=${resolved.effectiveCwd}`)
  if (resolved?.worktree !== undefined) {
    parts.push(`worktree=${resolved.worktree.path}@${resolved.worktree.branch}`)
  }
  return parts.length === 0 ? '' : `[subagent ${parts.join(' ')}]`
}

/** 插件工具原始返回 -> SDK ToolExecutionResult（裸文本/对象统一包 content；无 schema 不传 structuredOutput）。 */
function pluginToolResult(raw: unknown, redact: (text: string) => string): {
  output: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { output?: unknown }).output)
  ) {
    // 已是契约形状（或另一工具结果）——原样透传。
    return raw as { output: Array<{ type: 'text'; text: string }>; isError?: boolean }
  }
  // 未声明 structuredOutputSchema 的工具不得返回 structuredOutput（SDK 契约）：
  // 结果统一走 output 文本通道。
  return { output: [{ type: 'text', text: safeResultText(raw, redact) }] }
}

/** tool_call handled 的接管产物 -> 合法 ToolExecutionResult（非法形状显式错误结果）。 */
function toolResultOf(handled: unknown): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
} {
  const normalized = normalizeToolResult(handled)
  if (normalized !== undefined) {
    return normalized as { output: Array<{ type: 'text'; text: string }>; isError: boolean }
  }
  return {
    output: [{ type: 'text', text: 'tool_call handled 钩子返回了非法结果形状（已按错误落盘）' }],
    isError: true,
  }
}

/** tool_result transform 产物规整：必须形如 ToolExecutionResult，否则 undefined（保持原结果）。 */
function normalizeToolResult(value: unknown): ToolExecutionResultShape | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as ToolExecutionResultShape
  if (candidate.output === undefined && candidate.structuredOutput === undefined && candidate.isError === undefined) {
    return undefined
  }
  // output 必须是 content 数组（字符串包成单文本块；SDK 契约只接受数组）。
  if (typeof candidate.output === 'string') {
    return { ...candidate, output: [{ type: 'text', text: candidate.output }] }
  }
  if (candidate.output !== undefined && !Array.isArray(candidate.output)) return undefined
  return candidate
}

interface ToolExecutionResultShape {
  output?: Array<{ type: string; text?: string }> | string
  structuredOutput?: JsonValue
  isError?: boolean
  details?: JsonValue
}

/** 从模型消息提取当前生效 system sections（含前导声明与后续 patch 回放）。 */
function systemSectionsOf(messages: ReadonlyArray<{ role?: string; sections?: unknown }>): Array<{ id: string; text: string }> {
  const sections = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    if (message.sections === null || typeof message.sections !== 'object') continue
    for (const [key, value] of Object.entries(message.sections as Record<string, unknown>)) {
      if (value === null) sections.delete(key)
      else if (typeof value === 'string') sections.set(key, value)
    }
  }
  return [...sections.entries()].map(([id, text]) => ({ id, text }))
}

function sectionsEqual(a: Array<{ id: string; text: string }>, b: Array<{ id: string; text: string }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.text !== b[i]!.text) return false
  }
  return true
}

/**
 * 把前导 system 消息的 sections 整体替换为 desired（保留 base content）。
 * 后续 system 段消息的旧 sections patch 通过 null 清除，避免回放残留。
 */
function withSections(
  messages: ReadonlyArray<Record<string, unknown>>,
  desired: Array<{ id: string; text: string }>,
): Array<Record<string, unknown>> {
  if (messages.length === 0) return [...messages]
  const out: Array<Record<string, unknown>> = [...messages]
  const lead = out[0]!
  if (lead['role'] !== 'system') return out
  const previous = lead['sections']
  const previousKeys =
    previous !== null && typeof previous === 'object'
      ? Object.keys(previous as Record<string, unknown>)
      : []
  // 新声明集；旧键不在新集中的以 null 移除（回放语义）。
  const next: Record<string, string | null> = {}
  for (const [i, section] of desired.entries()) {
    void i
    next[section.id] = section.text
  }
  for (const key of previousKeys) {
    if (!(key in next)) next[key] = null
  }
  out[0] = { ...lead, sections: next }
  return out
}

/**
 * 工具集变更：在前导 system 消息追加 toolsRemoved/toolsAdded 声明。
 * 模型侧由 pi-ai 回放机制解析（getCurrentTools），下一轮即生效。
 */
function withToolDeclarations(
  messages: ReadonlyArray<Record<string, unknown>>,
  declared: Set<string>,
  tools: ReturnType<typeof getCurrentTools>,
): Array<Record<string, unknown>> {
  const available = new Map(tools.map((tool) => [tool.name, tool]))
  const added: Array<Record<string, unknown>> = []
  for (const name of declared) {
    const tool = available.get(name)
    if (!tool) throw new HelmError('unknown_tool', `before_turn 选择了未注册工具：${name}`, 500)
    added.push({ ...tool })
  }
  if (messages.length === 0 || messages[0]!['role'] !== 'system') return [...messages]
  const lead = messages[0]!
  // 完整重声明：移除全部旧声明再加新集（等价重放，防顺序漂移）。
  const next: Record<string, unknown> = { ...lead }
  const sections = lead['sections']
  next['sections'] =
    sections !== null && typeof sections === 'object'
      ? { ...(sections as Record<string, unknown>) }
      : {}
  next['toolsRemoved'] = currentToolNames(messages).filter((name) => declared.has(name) === false).map((name) => ({ name }))
  next['toolsAdded'] = added
  return [{ ...next }, ...messages.slice(1)]
}

/** 回放消息中的当前工具名清单。 */
function currentToolNames(messages: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message['role'] !== 'system') continue
    for (const tool of message['toolsAdded'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof tool?.name === 'string') names.add(tool.name)
    }
    for (const ref of message['toolsRemoved'] as Array<{ name?: string }> | undefined ?? []) {
      if (typeof ref?.name === 'string') names.delete(ref.name)
    }
  }
  return [...names]
}

/** 剥离已有 external_event 包裹（trigger transform 后再 defang 防双重包裹；保留包裹外追加文本）。 */
function stripEnvelope(text: string): string {
  const match = /[\s\S]*?<external_event[^>]*>\n([\s\S]*?)\n<\/external_event>([\s\S]*)/.exec(text)
  if (match === null) return text
  const body = match[1] ?? ''
  const tail = match[2] ?? ''
  const unescaped = body
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
  return tail.trim() === '' ? unescaped : `${unescaped}${tail}`
}

function summaryOfFallback(
  meta: ConvMeta,
  status: ConversationSummary['status'],
  pendingAskCount: number,
): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    ...(meta as { parentConversationId?: number }).parentConversationId !== undefined
      ? { parentConversationId: (meta as { parentConversationId?: number }).parentConversationId }
      : {},
    cwd: meta.cwd,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    ...(meta.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: meta.thinkingLevelOverride } : {}),
    status,
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

function normalizeBusyError(error: unknown): unknown {
  const name = (error as { name?: string })?.name
  if (name === 'ConversationBusy') {
    return new HelmError('conversation_busy', '会话正忙且 whenBusy=reject', 409)
  }
  if (name === 'ConversationIdle') {
    return new HelmError('conversation_idle', '会话空闲与 whenIdle=reject 冲突', 409)
  }
  return error
}

function entryModelText(entry: { model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }): string {
  const blocks = entry.model?.[0]?.content
  if (!blocks) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export { PROTO_ROOT }
