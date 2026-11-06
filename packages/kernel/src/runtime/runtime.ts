/**
 * KernelRuntime：helm 微内核运行时组合根。
 *
 * 职责（机制，不含业务策略）：
 * - 打开单一 state.sqlite（pi-durable + helm 表 + FTS 共享 adapter 队列）；
 * - Harness（models getter 热更新 / registry 插件热装 / followUpMode: 'all'）；
 * - root #1 创建（先 ensureDefault profiles；root 不注入业务 system prompt，
 *   SYSTEM/MEMORY 由 assistant 插件经 before_turn 注入）；
 * - 7 类 hook 管道真实串联（trigger/input/before_turn/tool_call/tool_result/
 *   agent_spawn/turn_settled/watchdog_tick）；
 * - 会话 CRUD / 输入 / abort / 等待 / 五态派生 / SSE 事件；
 * - AskService（CAS + secret stash）/ subagent / gate / workflow runner 挂接点。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  type Extension,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { GenerationTask, ToolTask } from '@earendil-works/pi-durable'
import type {
  AgentSpawnRequest,
  AskCreateSpec,
  AskSpec,
  ConversationInit,
  ConversationInput,
  ConversationPatch,
  ConversationSummary,
  ExternalTriggerEnvelope,
  InputOrigin,
  ProviderConfig,
  WhenBusy,
} from '@helm/protocol'
import { HelmError, ROOT_CONVERSATION_ID as PROTO_ROOT } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import {
  ArtifactService as SvcArtifactService,
  AuthService as SvcAuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
  ensureDataDir,
  resolveDataDir,
} from '../services/index.js'
import { PluginHost, type DerivedToolSpec } from '../plugins/index.js'
import { AskService } from './asks.js'
import { ConversationTracker, deriveTitle } from './conversations.js'
import { EventHub } from './events.js'
import { buildModels, listModelCatalog, requireModelRef } from './models.js'
import type { Models } from '@earendil-works/pi-ai/models'
import { openHelmDatabase, type HelmDatabase } from './sqlite.js'
import { HelmStore, summaryOf } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { createBashTool, createReadArtifactTool, createReadTool, runGate } from './tools.js'
import { runNativeSpawn } from './spawn.js'

export interface KernelRuntimeOptions {
  dataDir?: string
  cwd?: string
  /** 默认模型 'provider/model'（app 从 HELM_MODEL 传入）。 */
  model?: string
  /** hub URL（测试 port:0 时注入；缺省按 HELM_PORT 生成）。 */
  hubUrl?: string
  /**
   * 外部注入 Models（测试用 faux provider 时传入；产品路径不传，
   * 由 buildModels 按 providers.json + credentials 构建）。
   */
  models?: Models
  /**
   * 是否在 open 内立即 resume 调度（默认 true，独立 runtime 即用）。
   * 组合层（createHelm）传 false：先注册 assistant 插件 / 挂 WorkflowRunner，
   * 再 await start() 启动恢复，防止恢复任务在工具未注册时被判 orphaned。
   */
  autoResume?: boolean
}

export interface WorkflowRunnerFn {
  (request: Record<string, unknown>, conversationId: number, signal?: AbortSignal): Promise<unknown>
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
  private readonly stash = new SecretStash()
  /** 未配置模型时的 hooks 载荷占位（提交时 requireModelRef 显式报错）。 */
  private modelPlaceholder = 'unconfigured'
  private readonly toolDeps: HelmToolDeps
  private readonly profiles: ProfileService
  private readonly skills: SkillService
  private readonly artifacts: SvcArtifactService
  private readonly auth: SvcAuthService
  private readonly credentials: CredentialService
  private readonly providersSvc: ProviderService
  private readonly agentSessions = new Map<string, number>()
  private modelsRef: ReturnType<typeof buildModels>
  private defaultModel: string | undefined
  private pluginHost: PluginHost | undefined
  /** 插件工具的 SDK 扩展名（重装热更新用）。 */
  private pluginToolsVersion = 0
  private workflowRunner: WorkflowRunnerFn | undefined
  /** turn_settled 钩子的在途执行（waitForIdle 前等待）。 */
  private settledInflight: Promise<void> = Promise.resolve()
  private closed = false
  /** start() 幂等守护：组合层完成插件/Workflow 挂接后显式启动调度。 */
  private started = false
  private startPromise: Promise<void> | undefined

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
    // 预热 key 缓存（后续 set 后 reloadModels 刷新）。
    for (const id of ['openai', 'anthropic', ...providerConfigs.map((p) => p.id)]) {
      const key = await credentials.get(id).catch(() => undefined)
      if (key) apiKeyCache[id] = key
    }
    const modelsInstance = options.models ?? buildModels({
      providers: providerConfigs,
      apiKeys: () => apiKeyCache,
    })
    const registry = createRegistry()

    const harness = await Harness.open(
      database.storage,
      {
        models: () => modelsInstance,
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
          console.error('[helm] durable report:', description, (report as { error?: unknown }).error)
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
      getModels: () => modelsInstance,
      setModels: () => {},
      defaultModel: options.model ?? process.env['HELM_MODEL'],
      cwd: options.cwd ?? process.cwd(),
      hubUrl: options.hubUrl,
      seedKeyCache: apiKeyCache,
      autoResume: options.autoResume !== false,
    })
    await runtime.initialize()
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
    getModels(): ReturnType<typeof buildModels>
    setModels(m: ReturnType<typeof buildModels>): void
    defaultModel?: string
    cwd: string
    hubUrl?: string
    seedKeyCache: Record<string, string>
    autoResume: boolean
  }) {
    this.dataDir = init.dataDir
    this.database = init.database
    this.harness = init.harness
    this.registry = init.registry
    this.store = init.store
    this.defaultModel = init.defaultModel
    this.modelsRef = init.getModels()
    this.profiles = new ProfileService(init.dataDir)
    this.skills = new SkillService(init.dataDir)
    // 同步镜像仓库（满足 ArtifactRepository 同步契约；持久化经 store 排队）。
    const artifactRepo = {
      get: (id: string) => this.store.getArtifact(id),
      list: (conversationId: number) => this.store.listArtifacts(conversationId),
      put: (meta: never) => {
        this.store.putArtifact(meta as never)
      },
      deleteByConversation: (conversationId: number) => {
        this.store.deleteArtifactsByConversation(conversationId)
      },
    }
    this.artifacts = new SvcArtifactService(init.dataDir, artifactRepo as never)
    this.auth = new SvcAuthService(init.dataDir)
    this.credentials = init.credentials
    this.providersSvc = init.providersSvc
    Object.assign(this.apiKeyCache, init.seedKeyCache)

    const hubUrl =
      init.hubUrl ?? `http://127.0.0.1:${process.env['HELM_PORT'] ?? '3202'}`
    this.toolDeps = {
      dataDir: init.dataDir,
      defaultCwd: init.cwd,
      hubUrl,
      stashEnvFor: (id) => this.stash.envFor(id),
      redact: (t) => this.stash.redact(t),
      artifacts: this.artifacts as unknown as HelmToolDeps["artifacts"],
    }
    this.store.ftsRedact = (t) => this.stash.redact(t)

    this.events = new EventHub({
      initialSeq: this.store.eventSeqNow,
      snapshot: () => ({
        seq: this.store.eventSeqNow,
        conversations: this.listConversations(),
        pendingAsks: this.asks.listAsks('pending'),
        plugins: [],
      }),
      persistSeq: (seq) => this.store.setEventSeq(seq),
    })
    this.events.redactFn = (t) => this.stash.redact(t)

    this.asks = new AskService({
      store: this.store,
      stash: this.stash,
      onEvent: (type, payload) => this.events.publish(type, payload),
      onConvPendingChanged: (id) => {
        this.tracker.setPendingAskCount(id, this.asks.pendingCount(id))
      },
    })

    this.tracker = new ConversationTracker({
      harness: this.harness,
      store: this.store,
      events: {
        onSummaryChanged: (summary) => this.events.publish('conversation.upsert', summary),
        onInputCommitted: (conversationId, input) => {
          this.store.indexFts(conversationId, `input:${input.id}`, this.store.getConv(conversationId)?.title ?? '', input.text)
        },
        onAssistantText: (conversationId, entryId, text) => {
          this.tracker.recordAssistantText(conversationId, entryId, text)
          this.store.indexFts(conversationId, `entry:${entryId}`, this.store.getConv(conversationId)?.title ?? '', text)
        },
        onTurnSettled: (payload, consumed) => {
          const run = this.dispatchTurnSettled(payload, consumed)
          this.settledInflight = run
          void run.catch(() => {})
        },
      },
    })
  }

  private async initialize(): Promise<void> {
    // 1) 默认 profiles 先于 root 创建（root 绑定 assistant profile）。
    const rootProfile = await this.profiles.ensureDefault()
    if (!this.defaultModel && rootProfile.model) {
      this.defaultModel = rootProfile.model
    }
    // hooks 载荷校验要求 model 非空；未配置时用显式占位并上报（提交时才硬报错）。
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'

    // 2) 内核工具（bash/read/read_artifact）经扩展注册；插件工具由 attachPluginHost 热装。
    const kernelTools = [
      createBashTool(this.toolDeps),
      createReadTool(this.toolDeps),
      createReadArtifactTool(this.toolDeps, (convId: number, artifactConvId: number) =>
        this.isArtifactAuthorized(convId, artifactConvId),
      ),
    ] as unknown as ToolRegistration[]
    this.registry.install(
      defineExtension({ name: 'helm-core', tools: kernelTools }) as Extension,
    )

    // 3) hook 桥：SDK GenerationTask/ToolTask 钩子 -> helm 7 hook 管道。
    this.installHookBridges()

    // 4) root #1（不注入业务 system；SYSTEM/MEMORY 由 assistant 插件 before_turn 注入）。
    const modelRef = this.defaultModel ? requireModelRef(this.defaultModel) : undefined
    const root = await this.harness.root(BACKGROUND_CONTEXT, {
      agent: modelRef
        ? { model: { provider: modelRef.provider, modelId: modelRef.modelId } }
        : undefined,
    })
    if (!this.store.getConv(root.id as number)) {
      this.store.upsertConv({
        id: root.id as number,
        title: '个人助理',
        profileId: 'assistant',
        tags: ['assistant'],
        cwd: this.init.cwd,
        model: this.defaultModel ?? this.modelPlaceholder,
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    await this.tracker.observe(root.id as number)

    // 5) 恢复：autoResume 时立即启动调度；否则等组合层 await start()。
    this.asks.reportOrphans()
    await this.recoverConversations()
    if (this.init.autoResume) await this.start()
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
      this.started = true
    })()
    return this.startPromise
  }

  /** 重启后为既有 SDK 会话补建镜像（tombstone 除外；root 恒在）。 */
  /** 产物授权：当前会话或其父链（子会话可读父会话产物）。 */
  private isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    let current: number | undefined = conversationId
    const seen = new Set<number>()
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      if (current === artifactConversationId) return true
      current = this.store.getConv(current)?.parentConversationId
    }
    return false
  }

  private async recoverConversations(): Promise<void> {
    const page = await this.database.storage.scanConversations({}, 500, undefined, BACKGROUND_CONTEXT)
    for (const record of page.items) {
      const id = record.id as number
      if (this.store.getConv(id) || this.store.isDeleted(id)) continue
      const now = Date.now()
      const conversation = await this.harness.conversation(record.id, BACKGROUND_CONTEXT)
      const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined) : undefined
      this.store.upsertConv({
        id,
        title: `会话 ${id}`,
        profileId: 'default',
        tags: [],
        parentConversationId: record.parent?.conversationId as number | undefined,
        cwd: agent?.cwd ?? this.toolDeps.defaultCwd,
        model: this.defaultModel ?? (agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : ''),
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: now,
        updatedAt: now,
      })
      await this.tracker.observe(id)
    }
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
            /** tool_call：continue/transform(block)/handled。 */
            beforeTool: async (call, api) => {
              const outcome = await self.runHookChain('tool_call', {
                conversationId: api.conversationId as number,
                callId: call.id,
                toolName: call.name,
                input: call.arguments as Record<string, unknown>,
              })
              if (outcome?.action === 'block') return { block: outcome.reason ?? 'blocked' }
              if (outcome?.action === 'transform') {
                const value = outcome.value as { input?: Record<string, unknown> }
                return { arguments: (value.input ?? call.arguments) as never }
              }
              return undefined
            },
            /** tool_result：transform 改写结果（含 spill 之后的文本）。 */
            afterTool: async (call, result, api) => {
              const outcome = await self.runHookChain('tool_result', {
                conversationId: api.conversationId as number,
                callId: call.id,
                toolName: call.name,
                input: call.arguments as Record<string, unknown>,
                result,
              })
              if (outcome?.action === 'transform') return outcome.value as typeof result
              return undefined
            },
          }),
          hook(GenerationTask, {
            /** before_turn：sections/messages 实际进入模型请求。 */
            beforeRequest: async (request, api, context) => {
              const conversationId = api.conversationId as number
              const summary = self.safeSummary(conversationId)
              if (!summary) return undefined
              const payload = {
                conversation: summary,
                inputs: [],
                tools: [],
                sections: [] as Array<{ id: string; text: string }>,
                messages: request.messages as unknown as Array<Record<string, unknown>>,
              }
              const outcome = await self.runHookChain('before_turn', payload)
              if (outcome?.action === 'transform') {
                const value = outcome.value as typeof payload
                let messages = request.messages
                if (value.sections.length > 0) {
                  const sectionText = value.sections.map((s) => `<${s.id}>\n${s.text}\n</${s.id}>`).join('\n\n')
                  messages = [
                    {
                      role: 'user',
                      content: [{ type: 'text', text: `以下为系统注入上下文：\n${sectionText}` }],
                    } as unknown as (typeof request.messages)[number],
                    ...request.messages,
                  ]
                }
                if (value.messages && value.messages !== payload.messages) {
                  messages = value.messages as unknown as typeof request.messages
                }
                return { messages }
              }
              return undefined
            },
          }),
        ],
      }) as Extension,
    )
  }

  /** 统一 hook 管道执行（priority 降序）；返回最后非 continue 的决定。 */
  private async runHookChain(name: string, payload: unknown): Promise<{ action: string; value?: unknown; result?: unknown; reason?: string } | undefined> {
    const host = this.pluginHost
    if (!host) return undefined
    let current = payload
    const result = await host.runHook(name as never, current as never)
    if (result.action === 'transform') current = result.value
    if (result.action === 'continue') return undefined
    return { ...result, value: current }
  }

  /**
   * 插件宿主接入（app 组合层调用：new PluginHost({ dataDir, host, docs, config? })）。
   * listTools() 的 DerivedToolSpec 只有清单字段，缺 execute；这里 map 到
   * host.executeTool 闭包生成真实 SDK 工具并经 registry 热装（重装同扩展名原地替换，
   * 新回合生效，不影响在途回合）。
   */
  attachPluginHost(host: PluginHost): void {
    this.pluginHost = host
    this.installPluginTools(host.listTools())
  }

  /** 插件启停后由 app 重新调用，热更新工具集。 */
  refreshPluginTools(): void {
    if (!this.pluginHost) return
    this.installPluginTools(this.pluginHost.listTools())
  }

  private installPluginTools(specs: DerivedToolSpec[]): void {
    const host = this.pluginHost
    if (!host) return
    this.pluginToolsVersion += 1
    // 同名扩展原地替换（registry.install 语义）；每次重建闭包绑定最新 executeTool。
    const tools = specs.map((spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: (spec.inputSchema ?? { type: 'object', properties: {} }) as Record<string, object>,
        async execute(args: unknown, api: never) {
          const toolApi = api as unknown as { conversationId: number }
          return host.executeTool(spec.name, args, {
            conversationId: toolApi.conversationId,
          })
        },
      } as never)
    )
    this.registry.install(defineExtension({ name: 'helm-plugins', tools }) as Extension)
  }

  get plugins(): PluginHost | undefined {
    return this.pluginHost
  }

  private dispatchTurnSettled(payload: unknown, consumed: ConversationInput[]): Promise<void> {
    void consumed
    const host = this.pluginHost
    if (!host) return Promise.resolve()
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

  // ------------------------------------------------------------------
  // public：conversations
  // ------------------------------------------------------------------

  listConversations(filter?: { tag?: string; status?: string }): ConversationSummary[] {
    return this.store
      .listConvs()
      .map((meta) => this.tracker.summaryOf(meta.id))
      .filter((s) => (filter?.tag ? s.tags.includes(filter.tag) : true))
      .filter((s) => (filter?.status ? s.status === filter.status : true))
  }

  getConversation(id: number): ConversationSummary {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    return this.tracker.summaryOf(id)
  }

  async createConversation(init: ConversationInit = {}): Promise<ConversationSummary> {
    const modelRef = init.model
      ? (() => {
          const slash = init.model!.indexOf('/')
          if (slash <= 0) throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${init.model}`)
          return { provider: init.model!.slice(0, slash), modelId: init.model!.slice(slash + 1) }
        })()
      : this.defaultModel
        ? (() => requireModelRef(this.defaultModel))()
        : undefined
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: modelRef
          ? { model: { provider: modelRef.provider, modelId: modelRef.modelId } }
          : undefined,
      },
      BACKGROUND_CONTEXT,
    )
    const id = conv.id as number
    const now = Date.now()
    this.store.upsertConv({
      id,
      title: init.title ?? '',
      profileId: init.profileId ?? 'default',
      tags: init.tags ?? [],
      parentConversationId: init.parentConversationId,
      cwd: init.cwd ?? this.toolDeps.defaultCwd,
      model: init.model ?? this.defaultModel ?? '',
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.tracker.observe(id)
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', summary)
    return summary
  }

  async updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const updated = {
      ...meta,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.profileId !== undefined ? { profileId: patch.profileId } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      // unread 仅人类显式 PATCH 清零；API 读取不清零。
      ...(patch.unread !== undefined ? { unread: patch.unread } : {}),
      stateChangeSeq: meta.stateChangeSeq + 1,
      updatedAt: Date.now(),
    }
    this.store.upsertConv(updated)
    if (patch.cwd || patch.model) {
      await this.harness
        .conversation(id as never, BACKGROUND_CONTEXT)
        .then((c) =>
          c?.configure(
            {
              ...(patch.cwd ? { cwd: patch.cwd } : {}),
              ...(patch.model
                ? {
                    model: (() => {
                      const slash = patch.model!.indexOf('/')
                      return slash > 0
                        ? { provider: patch.model!.slice(0, slash), modelId: patch.model!.slice(slash + 1) }
                        : undefined
                    })(),
                  }
                : {}),
            },
            BACKGROUND_CONTEXT,
          ),
        )
    }
    const summary = this.tracker.summaryOf(id)
    this.events.publish('conversation.upsert', summary)
    return summary
  }

  /**
   * 删除会话：root 保护；abort 在途 -> 取消 asks -> 清 artifacts（物理文件）->
   * FTS 行 -> 插件上下文（钩子）-> Helm 索引移除 + tombstone。
   * 注：SDK 无 deleteConversation 写 API，pi_* 内部历史由 SDK 保留，
   * helm 侧重启后凭 tombstone 不再重新导入（逻辑删除）。
   */
  async deleteConversation(id: number): Promise<void> {
    if (id === PROTO_ROOT) {
      throw new HelmError('root_conversation_protected', '根会话 #1 不可删除', 403)
    }
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (conversation) await conversation.abort(BACKGROUND_CONTEXT)
    this.asks.cancelByConversation(id)
    await this.artifacts.deleteConversation(id)
    // 插件上下文释放经 turn_settled/notification 通知（无独立 conversation_deleted hook 点）。
    this.events.publish('notification', {
      level: 'info',
      title: '会话已删除',
      body: `会话 ${id} 及其产物/待答 AskDoc 已清理`,
      conversationId: id,
    })
    this.tracker.stopObserving(id)
    this.store.deleteConv(id)
    this.events.publish('conversation.deleted', { conversationId: id })
  }

  /**
   * 提交输入：input hook（transform 生效 + origin 写入 helm.input entry data）->
   * SDK submit（requestId 幂等）。
   */
  async submitInput(
    id: number,
    text: string,
    opts?: { origin?: InputOrigin; whenBusy?: WhenBusy },
  ): Promise<{ submissionId: string }> {
    const meta = this.store.getConv(id)
    if (!meta) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    // 未配置模型时显式拒绝（绝不 faux fallback 假装回答）。
    if (!this.defaultModel) requireModelRef(this.defaultModel)
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    const origin: InputOrigin = opts?.origin ?? 'human'
    let effectiveText = text
    const inputId = randomUUID()
    const hookOutcome = await this.runHookChain('input', {
      conversationId: id,
      input: { id: inputId, text, origin, whenBusy: opts?.whenBusy, createdAt: Date.now() },
    })
    let inputMeta: ConversationInput = { id: inputId, text, origin, createdAt: Date.now() }
    if (hookOutcome?.action === 'transform') {
      const value = hookOutcome.value as { input?: Partial<ConversationInput> }
      if (value.input?.text !== undefined) effectiveText = value.input.text
      inputMeta = { ...inputMeta, ...value.input }
    }
    if (hookOutcome?.action === 'block') {
      throw new HelmError('input_blocked', hookOutcome.reason ?? '输入被 input 钩子拦截')
    }
    if (hookOutcome?.action === 'handled') {
      return { submissionId: `handled:${randomUUID()}` }
    }

    // 首输入自动标题。
    if (meta.title === '') {
      const title = deriveTitle(effectiveText)
      this.store.upsertConv({ ...meta, title, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }

    const key = this.tracker.registerInput(id, inputMeta)
    try {
      const submission = await conversation.submit(
        {
          type: 'input',
          content: effectiveText,
          whenBusy: opts?.whenBusy ?? 'followUp',
          entry: {
            kind: 'helm.input',
            data: { id: inputId, text: effectiveText, origin, createdAt: inputMeta.createdAt },
          },
          requestId: inputId,
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

  async abortConversation(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.abort(BACKGROUND_CONTEXT)
    this.tracker.settleAborted(id)
  }

  /** 等待会话空闲（含 turn_settled 钩子异步执行完成）。 */
  async waitForIdle(id: number): Promise<void> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    await this.settledInflight
  }

  async getLastAssistantText(id: number): Promise<string> {
    return this.tracker.getLastAssistantText(id) ?? ''
  }

  // ------------------------------------------------------------------
  // trigger / spawn / workflow / watchdog
  // ------------------------------------------------------------------

  /** defang 防逃逸信封。 */
  private defang(envelope: ExternalTriggerEnvelope): string {
    return `<external_event id="${envelope.id}" source="${envelope.source}" untrusted="true">\n${envelope.text}\n</external_event>`
  }

  /** 外部触发：trigger hook -> 默认投递 #1。 */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    const payload: ExternalTriggerEnvelope = { ...envelope, text: this.defang(envelope) }
    const outcome = await this.runHookChain('trigger', payload)
    if (outcome?.action === 'handled') return
    const target =
      outcome?.action === 'transform'
        ? ((outcome.value as ExternalTriggerEnvelope).targetConversationId ?? PROTO_ROOT)
        : (payload.targetConversationId ?? PROTO_ROOT)
    await this.submitInput(target, payload.text, { origin: 'trigger', whenBusy: 'followUp' })
  }

  /** 子代理派生：agent_spawn hook -> 默认原生 subagent。 */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    const outcome = await this.runHookChain('agent_spawn', request)
    if (outcome?.action === 'handled') return outcome.result
    return runNativeSpawn(
      {
        ...this.toolDeps,
        harness: this.harness,
        getLastAssistantText: (id) => this.tracker.getLastAssistantText(id),
        resolveModel: () => {
          const ref = requireModelRef(this.defaultModel)
          return ref
        },
        agentSessions: this.agentSessions,
        registerChildConversation: async (childId, parentId, profileId) => {
          const now = Date.now()
          this.store.upsertConv({
            id: childId,
            title: `子代理 ${childId}`,
            profileId: profileId ?? 'default',
            tags: ['worker'],
            parentConversationId: parentId,
            cwd: request.cwd ?? this.toolDeps.defaultCwd,
            model: request.model ?? this.defaultModel ?? '',
            unread: false,
            pinned: false,
            stateChangeSeq: 1,
            completionSeq: 0,
            createdAt: now,
            updatedAt: now,
          })
          await this.tracker.observe(childId)
        },
      },
      request,
    )
  }

  /** gate 门禁（独立 spawn 与 Workflow adapter 共用，只执行一次）。 */
  runGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal } = {}): Promise<{ ok: boolean; output: string }> {
    return runGate(this.toolDeps, command, options)
  }

  /** workflow 执行行注入（主代理组合 WorkflowService 后调用）。 */
  setWorkflowRunner(fn: WorkflowRunnerFn): void {
    this.workflowRunner = fn
  }

  /** 内部使用的 workflow 执行（spawnAgent 同源的 hook 链）。 */
  async runWorkflow(request: Record<string, unknown>, conversationId: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.workflowRunner) {
      throw new HelmError('unsupported_runtime', 'Workflow 引擎尚未挂接（setWorkflowRunner 未调用）', 503)
    }
    return this.workflowRunner(request, conversationId, signal)
  }

  /** watchdog tick：只采集通用事实，无业务策略、不自动操作。 */
  async watchdogTick(): Promise<unknown> {
    const summaries = this.listConversations()
    const probes = summaries.map((summary) => ({
      targetId: String(summary.id),
      /**
       * 归属权保守判定：root #1 与用户直连会话一律 'human'（只读红线）；
       * 仅 spawnAgent 创建、父会话在仓且带 worker 标签的后台子会话标 'helm'。
       * 判不准时宁 human 只读，绝不越权允许未来规则表中止人类会话。
       */
      ownedBy: this.watchdogOwnershipOf(summary) as 'human' | 'helm',
      status: summary.status,
      facts: { doing: summary.doing, pendingAskCount: summary.pendingAskCount },
    }))
    const payload = { timestamp: Date.now(), conversations: summaries, probes }
    await this.runHookChain('watchdog_tick', payload)
    return payload
  }

  private watchdogOwnershipOf(summary: ConversationSummary): 'human' | 'helm' {
    if (summary.id === PROTO_ROOT) return 'human'
    if (!summary.tags.includes('worker')) return 'human'
    const parent = summary.parentConversationId
    if (parent === undefined) return 'human'
    return this.store.getConv(parent) !== undefined ? 'helm' : 'human'
  }

  // ------------------------------------------------------------------
  // asks / search / models / services
  // ------------------------------------------------------------------

  listAsks(status?: string): AskSpec[] {
    return this.asks.listAsks(status)
  }

  async createAsk(spec: AskCreateSpec): Promise<Record<string, string>> {
    return this.asks.createAsk(spec)
  }

  async answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<AskSpec> {
    return this.asks.answerAsk(id, answers, expectedStateSeq)
  }

  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    await this.asks.cancelAsk(id, reason ?? 'cancelled')
  }

  registerAskSeqResolver(resolver: (askId: string) => number | undefined): () => void {
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
            if (text) index(conv.id, `entry:${entry.id}`, conv.title, this.stash.redact(text))
          }
          if (!page.next) break
          cursor = page.next
        }
      }
    })
  }

  async listModels(): Promise<Array<{ provider: string; modelId: string; available: boolean }>> {
    return listModelCatalog(this.modelsRef)
  }

  /** providers.json / credentials 变化后重建模型集（getter 热生效）。 */
  async reloadModels(): Promise<void> {
    const providerConfigs = await this.providersSvc.list()
    for (const p of providerConfigs) {
      const key = await this.credentials.get(p.id).catch(() => undefined)
      if (key) this.apiKeyCache[p.id] = key
    }
    this.modelsRef = buildModels({
      providers: providerConfigs,
      apiKeys: () => this.apiKeyCache,
    })
    this.init.setModels(this.modelsRef)
  }

  /** 同步读 key 缓存（启动预热 + reload 刷新）。 */
  private apiKeyCache: Record<string, string> = {}

  /**
   * 全局文档存储端口（WorkflowService / PluginHost docs 共用同一 SQLite 镜像与队列）：
   * - get(key, initial)：同步读，缺省返回 initial（不落盘）；
   * - set(key, value)：同步镜像 + 排队持久化（helm_plugin_docs 全局命名空间）；
   * - flush()：等待队列冲刷完成。
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
      profiles: this.profiles,
      skills: this.skills,
      artifacts: this.artifacts,
      auth: this.auth,
      credentials: this.credentials,
      providers: this.providersSvc,
      stash: this.stash,
    }
  }

  get safeSummaryRef() {
    return (id: number) => this.safeSummary(id)
  }

  private safeSummary(id: number): ConversationSummary | undefined {
    const meta = this.store.getConv(id)
    if (!meta) return undefined
    try {
      return this.tracker.summaryOf(id)
    } catch {
      return summaryOf(meta, 'idle', 0)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.settledInflight
    const storeError = await this.store.close()
    await this.harness.close(BACKGROUND_CONTEXT)
    await this.database.close()
    if (storeError !== undefined) {
      throw new HelmError('store_flush_failed', `退出时持久化失败：${String(storeError)}`, 500, {
        error: String(storeError),
      })
    }
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
