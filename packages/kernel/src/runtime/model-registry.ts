/**
 * 模型集合注册表：Models 实例生命周期 / 运行时供应商 / 动态目录刷新 /
 * 全局默认模型与思考档位。
 *
 * 从 runtime.ts 拆出（上帝类的模型全家职责簇）。串行约束：reload /
 * register / unregister / refresh 全部经 modelsChain 排队，避免并发重建后
 * 旧集合覆盖新集合；外部注入 Models（测试/嵌入）时集合归调用方，空操作。
 */
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Models, Provider } from '@earendil-works/pi-ai/models'
import type { ModelsStore } from '@earendil-works/pi-ai'
import type { ModelCatalog, ModelProvidersRefreshResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConfigService, CredentialService, ProviderService, SecretStash } from '../services/index.js'
import { listModelCatalog, listModelProviders, buildModels } from './models.js'

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
 * config.json.disabledModels 结构解析（providerId -> modelId[]）；缺省空集，
 * 非法形状显式抛 config_corrupt（绝不静默丢弃）。
 */
function parseDisabledModelsConfig(raw: unknown): Record<string, string[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('config_corrupt', 'config.json.disabledModels 必须为对象（providerId -> modelId[]）', 500)
  }
  const result: Record<string, string[]> = {}
  for (const [providerId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerId !== 'string' || providerId === '') {
      throw new HelmError('config_corrupt', `config.json.disabledModels 键需为非空 provider id：${String(providerId)}`, 500)
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
      throw new HelmError('config_corrupt', `config.json.disabledModels['${providerId}'] 必须为非空字符串数组`, 500)
    }
    result[providerId] = [...(ids as string[])]
  }
  return result
}

export interface ModelRegistryOptions {
  readonly dataDir: string
  readonly providersSvc: ProviderService
  readonly credentialsSvc: CredentialService
  readonly configSvc: ConfigService
  readonly stash: SecretStash
  readonly modelsStore: ModelsStore
  /** 热替换槽位（Harness models getter 经它读到最新集合）。 */
  readonly setModels: (m: Models) => void
  /** 外部注入 Models（测试）：注入时本注册表全部变更路径空操作/拒绝。 */
  readonly externalModels: boolean
  readonly events: { publish(type: 'models.changed', payload: { providers: string[] }): void }
  /** pluginHost 热注入（assertProviderAvailable 预检用）。 */
  readonly pluginHost: () => { assertProviderAvailable(pluginId: string): void } | undefined
  /** 对齐全部会话生效模型（默认模型变化后；宿主实现）。 */
  readonly alignAllConversations: () => Promise<void>
}

export class ModelRegistry {
  private readonly providersSvc: ProviderService
  private readonly credentialsSvc: CredentialService
  private readonly configSvc: ConfigService
  private readonly stash: SecretStash
  private readonly modelsStore: ModelRegistryOptions['modelsStore']
  private readonly setModels: (m: Models) => void
  private readonly externalModels: boolean
  private readonly events: ModelRegistryOptions['events']
  private readonly pluginHost: ModelRegistryOptions['pluginHost']
  private readonly alignAllConversations: ModelRegistryOptions['alignAllConversations']
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
  /** 同步读 key 缓存（启动预热 + reload 刷新；buildModels 闭包消费）。 */
  readonly apiKeyCache: Record<string, string> = {}
  private modelsCurrent: Models
  defaultModel: string | undefined
  defaultThinkingLevel: string | undefined
  /** 未配置模型时的 hooks 载荷占位（提交时 requireModelRef 显式报错）。 */
  modelPlaceholder = 'unconfigured'
  /** 用户显式禁用的模型（providerId -> modelId[]；config.json.disabledModels）。 */
  private disabledModels: Record<string, string[]> = {}

  constructor(options: ModelRegistryOptions, initialModels: Models, defaults: { model?: string; thinkingLevel?: string }) {
    this.providersSvc = options.providersSvc
    this.credentialsSvc = options.credentialsSvc
    this.configSvc = options.configSvc
    this.stash = options.stash
    this.modelsStore = options.modelsStore
    this.setModels = options.externalModels ? () => { /* 外部注入：热重载不得替换调用方模型集合 */ } : options.setModels
    this.externalModels = options.externalModels
    this.events = options.events
    this.pluginHost = options.pluginHost
    this.alignAllConversations = options.alignAllConversations
    this.modelsCurrent = initialModels
    this.defaultModel = defaults.model
  }

  get models(): Models {
    return this.modelsCurrent
  }

  get refreshAbortController(): AbortController | undefined {
    return this.modelsRefreshAbort
  }

  /** modelsChain 尾排队执行（异常向后传播，不阻断后续排队）。 */
  private enqueueModelsChange<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.modelsChain.then(fn, fn)
    this.modelsChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 关停前等待全部在途模型变更收敛。 */
  async dispose(): Promise<void> {
    await this.modelsChain
  }

  async listModels(): Promise<ModelCatalog> {
    return listModelCatalog(this.modelsCurrent, {
      model: this.defaultModel,
      thinkingLevel: this.defaultThinkingLevel,
      disabledModels: this.disabledModels,
    })
  }

  listModelProviders() {
    return listModelProviders(this.modelsCurrent, this.runtimeProviderOwners)
  }

  /** 从 config.json 读取全局默认模型与思考档位（启动时；格式非法显式抛）。 */
  async loadDefaultsFromConfig(): Promise<void> {
    const raw: Record<string, unknown> = (await this.configSvc.get()) as Record<string, unknown>
    if (this.defaultModel === undefined) {
      const configured = raw['model']
      if (configured !== undefined && configured !== '') {
        if (typeof configured !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configured)) {
          throw new HelmError('config_corrupt', 'config.json.model 必须为 provider/model 形式的字符串', 500)
        }
        this.defaultModel = configured
      }
    }
    if (this.defaultThinkingLevel === undefined) {
      const configuredLevel = raw['thinkingLevel'] as string | undefined | null
      if (configuredLevel !== undefined && configuredLevel !== '') {
        // 枚举校验由宿主注入的校验器完成（THINKING_LEVELS 属 spawn 契约）。
        await this.configuredThinkingLevelValidated(configuredLevel as string)
        this.defaultThinkingLevel = configuredLevel as string
      }
    }
    this.disabledModels = parseDisabledModelsConfig(raw['disabledModels'])
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
  }

  /** 思考档位枚举校验回调（宿主注入，避免本模块依赖 spawn 的 THINKING_LEVELS）。 */
  private configuredThinkingLevelValidated = async (_level: string): Promise<void> => {
    throw new HelmError('config_corrupt', '内部错误：thinkingLevel 校验器未注入', 500)
  }

  /** 注入思考档位枚举校验器（构造后立刻调用；loadDefaultsFromConfig 前生效）。 */
  setThinkingLevelValidator(validate: (level: string) => Promise<void>): void {
    this.configuredThinkingLevelValidated = validate
  }

  /** 设置全局默认模型与思考档位（config.json）：格式校验后原子写入并即时生效；空串删除键。 */
  async setDefaultModel(
    model: string | undefined,
    thinkingLevel: string | undefined,
    validateThinkingLevel: (level: string) => void,
  ): Promise<void> {
    const trimmed = model?.trim()
    if (trimmed !== undefined && trimmed !== '') {
      const ref = this.parseModelRefOrThrow(trimmed)
      this.assertModelEnabled(ref.provider, ref.modelId)
    }
    let nextLevel: string | undefined
    if (thinkingLevel !== undefined) {
      const level = thinkingLevel.trim()
      if (level !== '') validateThinkingLevel(level)
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
    await this.alignAllConversations()
  }

  /** 校验 'provider/model' 引用（create/update 共用）。 */
  parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
    }
    return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
  }

  /** 同步查询模型是否被用户显式禁用（会话解析入口过滤用）。 */
  isModelDisabled(providerId: string, modelId: string): boolean {
    return this.disabledModels[providerId]?.includes(modelId) === true
  }

  /** 模型禁用时显式拒绝（409 model_disabled），供显式选用入口复用。 */
  assertModelEnabled(providerId: string, modelId: string): void {
    if (this.isModelDisabled(providerId, modelId)) {
      throw new HelmError(
        'model_disabled',
        `模型 ${providerId}/${modelId} 已被禁用：请在「模型与凭证中心」或 helm models filter 重新启用后选用`,
        409,
        { provider: providerId, modelId },
      )
    }
  }

  /**
   * 设置模型禁用集（PUT /api/models/filter）：provider 为 undefined 时清空全部
   * （此时 modelIds 必须为空数组）；写入 config.json 原子持久化并返回最新目录。
   * 后端不校验模型存在性（存储自由字符串；目录标注仅命中目录内模型）。
   */
  async setDisabledModels(provider: string | undefined, modelIds: string[]): Promise<ModelCatalog> {
    if (provider === undefined || provider === '') {
      if (modelIds.length > 0) {
        throw new HelmError('validation_error', '未指定 provider 时只能清空全部禁用项（disabledModels 必须为空数组）', 400)
      }
    }
    const unique: string[] = []
    for (const id of modelIds) {
      // modelId 允许含 '/'：聚合网关（OpenRouter、magpie）的模型 id 本身就是
      // 'vendor/model' 形态，斜杠是模型名的一部分，不带 provider 前缀。
      if (typeof id !== 'string' || id === '') {
        throw new HelmError('validation_error', `模型 ID 必须为非空字符串：${String(id)}`, 400)
      }
      if (!unique.includes(id)) unique.push(id)
    }
    const next = await this.configSvc.updateBy((current) => {
      const merged: Record<string, unknown> = { ...current }
      if (provider === undefined || provider === '') {
        delete merged['disabledModels']
      } else {
        const existing = parseDisabledModelsConfig(merged['disabledModels'])
        if (unique.length === 0) delete existing[provider]
        else existing[provider] = unique
        if (Object.keys(existing).length === 0) delete merged['disabledModels']
        else merged['disabledModels'] = existing
      }
      return merged
    })
    this.disabledModels = parseDisabledModelsConfig(next['disabledModels'])
    // 内存快照已生效：发布 models.changed 让已连接的 Web 客户端重拉目录
    //（publish 侧组装/脱敏失败会同步抛出，不静默吞掉）。
    this.events.publish('models.changed', { providers: provider ? [provider] : [] })
    return this.listModels()
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

  /** 已在 modelsChain 内执行的重建（外部注入集合空操作）。 */
  private async rebuildModelsLocked(): Promise<void> {
    if (this.externalModels) return
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
    this.setModels(this.modelsCurrent)
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
    if (this.externalModels) {
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
    if (this.externalModels) return
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
  async refreshModels(isClosed: () => boolean, options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    return this.enqueueModelsChange(() => this.refreshModelsLocked(isClosed, options))
  }

  private async refreshModelsLocked(isClosed: () => boolean, options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    if (isClosed()) throw new HelmError('runtime_closing', '内核正在关闭，不能刷新模型目录', 409)
    if (this.externalModels) {
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
      errors[providerId] = this.stash.redact(err instanceof Error ? err.message : String(err))
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

  /** 关停时中止在途 refresh。 */
  abortRefresh(reason: Error): void {
    this.modelsRefreshAbort?.abort(reason)
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
      if (owner !== undefined) this.pluginHost()?.assertProviderAvailable(owner)
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
}
