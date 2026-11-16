/**
 * model set register table:Models instance lifecycle / runtime provider / motion state directory refresh /
 * global by default model and think Profile.
 *
 * from runtime.ts split out (on emperor class model all household responsibility cluster). serial constraint:reload /
 * register / unregister / refresh all via modelsChain queue up, avoid concurrency rebuild after
 * old set override new set; external inject Models(test/embed) when set archive caller, empty operation.
 */
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Models, Provider } from '@earendil-works/pi-ai/models'
import type { ModelsStore } from '@earendil-works/pi-ai'
import type { ModelCatalog, ModelProvidersRefreshResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConfigService, CredentialService, ProviderService, SecretStash } from '../services/index.js'
import { listModelCatalog, listModelProviders, buildModels } from './models.js'

/** PI inside placement provider id collection (lazy once build; register conflict preflight use, do not hard encode manifest). */
const builtinProviderIds = new Set(builtinProviders().map((p) => p.id))

/**
 * models-store.json file level corrupt detect:SDK refresh  store read write error package enter
 * result.errors(do not reject, avoid single provider failed block assert the rest), but file corrupt is global
 * incident - - static default fall back empty directory equals lose all already cache motion state directory. this where explicit on throw.
 */
function assertModelsStoreHealthy(result: { errors: ReadonlyMap<string, Error> }): void {
  for (const [providerId, err] of result.errors) {
    if (err instanceof HelmError && err.code === 'models_store_corrupted') {
      throw new HelmError(
        'models_store_corrupted',
        `models-store.json corrupt (read ${providerId} when discover):${err.message}`,
        500,
      )
    }
  }
}

/**
 * config.json.disabledModels structure parse (providerId -> modelId[]); default empty collection,
 * illegal shape explicit throw config_corrupt(never static default discard).
 */
function parseDisabledModelsConfig(raw: unknown): Record<string, string[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('config_corrupt', 'config.json.disabledModels must is object (providerId -> modelId[])', 500)
  }
  const result: Record<string, string[]> = {}
  for (const [providerId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerId !== 'string' || providerId === '') {
      throw new HelmError('config_corrupt', `config.json.disabledModels key must be non-empty provider id:${String(providerId)}`, 500)
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
      throw new HelmError('config_corrupt', `config.json.disabledModels['${providerId}'] must is non-empty string array`, 500)
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
  /** hot replace slot (Harness models getter via it read to most new set). */
  readonly setModels: (m: Models) => void
  /** external inject Models(test): inject when this register table all change path empty operation/reject. */
  readonly externalModels: boolean
  readonly events: { publish(type: 'models.changed', payload: { providers: string[] }): void }
  /** pluginHost hot inject (assertProviderAvailable preflight use). */
  readonly pluginHost: () => { assertProviderAvailable(pluginId: string): void } | undefined
  /** align all conversation takes effect model (by default model change after; host implement). */
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
  /** runtime motion state register provider (plugin via HostOptions.providers.register inject). */
  private readonly runtimeProviders = new Map<string, Provider>()
  /** runtime provider ownership (providerId -> register it pluginId; deregister one and clear). */
  private readonly runtimeProviderOwners = new Map<string, string>()
  /** models change serial chain:reload / register / unregister shared use, avoid stale replace. */
  private modelsChain: Promise<unknown> = Promise.resolve()
  private modelsRefreshAbort: AbortController | undefined
  /** models set proxy count (each time succeeded publish new set +1; in-flight refresh guard against old set re- publish). */
  private modelsGeneration = 0
  /** runtime provider in-flight use counter (providerId -> streaming/refresh not compute count;teardown preflight use). */
  private readonly runtimeProviderUsage = new Map<string, number>()
  /** deregister in mark record (only modelsChain serial domain inside short staged in):rebuild  await window inside
   *  new start stream/refresh acquire explicit failed, consolidate check via→window inside in-flight→
   *  cannot detect TOCTOU(usage pass increase do not in this serial domain, see wrapRuntimeProvider). */
  private readonly retiringRuntimeProviders = new Set<string>()
  /** sync read key cache (start warm up + reload refresh;buildModels closed package consume). */
  readonly apiKeyCache: Record<string, string> = {}
  private modelsCurrent: Models
  defaultModel: string | undefined
  defaultThinkingLevel: string | undefined
  /** not config model when hooks payload occupy (commit when requireModelRef explicit errors). */
  modelPlaceholder = 'unconfigured'
  /** user explicit disable model (providerId -> modelId[];config.json.disabledModels). */
  private disabledModels: Record<string, string[]> = {}

  constructor(options: ModelRegistryOptions, initialModels: Models, defaults: { model?: string; thinkingLevel?: string }) {
    this.providersSvc = options.providersSvc
    this.credentialsSvc = options.credentialsSvc
    this.configSvc = options.configSvc
    this.stash = options.stash
    this.modelsStore = options.modelsStore
    this.setModels = options.externalModels ? () => { /* external inject: hot reload must not replace caller model set */ } : options.setModels
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

  /** modelsChain tail queue up execute (exception to after pass broadcast, do not block assert after continue queue up). */
  private enqueueModelsChange<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.modelsChain.then(fn, fn)
    this.modelsChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** closure stop before wait for all in-flight model change converge. */
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

  /** from config.json read global by default model and think Profile (at startup; format illegal explicit throw). */
  async loadDefaultsFromConfig(): Promise<void> {
    const raw: Record<string, unknown> = (await this.configSvc.get()) as Record<string, unknown>
    if (this.defaultModel === undefined) {
      const configured = raw['model']
      if (configured !== undefined && configured !== '') {
        if (typeof configured !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configured)) {
          throw new HelmError('config_corrupt', 'config.json.model must is provider/model form string', 500)
        }
        this.defaultModel = configured
      }
    }
    if (this.defaultThinkingLevel === undefined) {
      const configuredLevel = raw['thinkingLevel'] as string | undefined | null
      if (configuredLevel !== undefined && configuredLevel !== '') {
        // enumeration validate by host inject validate complete (THINKING_LEVELS belong spawn contract).
        await this.configuredThinkingLevelValidated(configuredLevel as string)
        this.defaultThinkingLevel = configuredLevel as string
      }
    }
    this.disabledModels = parseDisabledModelsConfig(raw['disabledModels'])
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
  }

  /** think Profile enumeration validate call back (host inject, avoid this module dependency spawn  THINKING_LEVELS). */
  private configuredThinkingLevelValidated = async (_level: string): Promise<void> => {
    throw new HelmError('config_corrupt', 'internal error:thinkingLevel validate not inject', 500)
  }

  /** inject think Profile enumeration validate (construct after immediately invoke;loadDefaultsFromConfig before takes effect). */
  setThinkingLevelValidator(validate: (level: string) => Promise<void>): void {
    this.configuredThinkingLevelValidated = validate
  }

  /** settings global by default model and think Profile (config.json): format validate after atomic write and i.e. when takes effect; empty string delete key. */
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
        // not pass then do not motion since has think Profile key.
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
    // two override field mutual each other independent, model by override conversation still can inherit global think Profile.
    await this.alignAllConversations()
  }

  /** validate 'provider/model' reference (create/update shared use). */
  parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new HelmError('validation_error', `model reference format should be 'provider/model':${ref}`)
    }
    return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
  }

  /** sync query model is otherwise by user explicit disable (conversation parse entry filter use). */
  isModelDisabled(providerId: string, modelId: string): boolean {
    return this.disabledModels[providerId]?.includes(modelId) === true
  }

  /** model disable when explicit reject (409 model_disabled), supply explicit choose use entry re- use. */
  assertModelEnabled(providerId: string, modelId: string): void {
    if (this.isModelDisabled(providerId, modelId)) {
      throw new HelmError(
        'model_disabled',
        `model ${providerId}/${modelId} already by disable: please in model and rely on verify center or helm models filter re- enable after choose use`,
        409,
        { provider: providerId, modelId },
      )
    }
  }

  /**
   * settings model disable collection (PUT /api/models/filter):provider is undefined when empty all
   * (now modelIds must is empty array); write config.json atomic persist and return most new directory.
   * backend do not validate model store in (store self by string; directory mark note only hit directory inside model).
   */
  async setDisabledModels(provider: string | undefined, modelIds: string[]): Promise<ModelCatalog> {
    if (provider === undefined || provider === '') {
      if (modelIds.length > 0) {
        throw new HelmError('validation_error', 'not designate provider when only can empty all disable items (disabledModels must is empty array)', 400)
      }
    }
    const unique: string[] = []
    for (const id of modelIds) {
      // modelId allows contains '/': aggregate gateway (OpenRouter,magpie) model id itself is exactly
      // 'vendor/model' form, slash is model name one part, do not carries provider prefix.
      if (typeof id !== 'string' || id === '') {
        throw new HelmError('validation_error', `model ID must is non-empty string:${String(id)}`, 400)
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
    // memory snapshot already takes effect: publish models.changed let connected Web client heavy pull directory
    //(publish side group install/redaction failed will sync throw, not silently swallow).
    this.events.publish('models.changed', { providers: provider ? [provider] : [] })
    return this.listModels()
  }

  /**
   * rebuild concurrency publish model collection (providers.json / credentials / runtime provider change shared use).
   * serial: via modelsChain queue up, avoid concurrency rebuild until after old set override new set;
   * external inject Models(test/embed scenario) empty operation (model set archive caller).
   */
  async reloadModels(): Promise<void> {
    await this.enqueueModelsChange(async () => {
      await this.rebuildModelsLocked()
    })
  }

  /** already in modelsChain inside execute rebuild (external inject set empty operation). */
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
      throw new HelmError('runtime_provider_conflict', `gateway ${collision.id} and plugin register provider conflict`, 409)
    }
    const models = buildModels({
      providers: providerConfigs,
      apiKeys: () => nextKeys,
      modelsStore: this.modelsStore,
      extraProviders: [...this.runtimeProviders.values()],
    })
    // offline restore cache directory (allowNetwork:false do not network request).models-store.json corrupt
    // is file level incident (non- single provider failed):SDK will it package enter result.errors while do not reject,
    // this in must explicit on throw, never static default fall back empty directory.
    await assertModelsStoreHealthy(await models.refresh({ allowNetwork: false }))
    // complete read after success only then publish; whole replace, ensure delete secret key after old cache also expires.
    for (const id of Object.keys(this.apiKeyCache)) delete this.apiKeyCache[id]
    Object.assign(this.apiKeyCache, nextKeys)
    this.modelsGeneration += 1
    this.modelsCurrent = models
    this.setModels(this.modelsCurrent)
    this.events.publish('models.changed', { providers: [] })
  }

  /**
   * runtime register motion state provider (plugin via HostOptions.providers.register inject).
   * conflict reject (does not override any already has provider): inside placement provider / providers.json self define gateway /
   * other owner registered same id;providers.json when before not enabled same id gateway same occupy naming empty between.
   * external inject Models scenario explicit unsupported(set archive caller, register succeeded yet directory do not change i.e. deceive).
   * return idempotent deregister function: only when map still points to the same provider instance when delete and rebuild.
   */
  async registerRuntimeProvider(provider: Provider, pluginId?: string): Promise<() => Promise<void>> {
    if (this.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        'external inject Models when unsupported runtime provider register (model set archive caller all)',
        400,
      )
    }
    if (typeof provider?.id !== 'string' || provider.id === '') {
      throw new HelmError('validation_error', `runtime provider id must be a non-empty string:${String(provider?.id)}`, 400)
    }
    // catch this time register wrap instance; old release handle must not seek address after continue same name register.
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
        // rollback: register failed do not orphan child map items (under time reload also will not again contains it).
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

  /** conflict detect: return error message (undefined = without conflict). inside placement/self define gateway/other owner mutual exclusion. */
  private async findRuntimeProviderConflict(providerId: string): Promise<string | undefined> {
    const existing = this.runtimeProviders.get(providerId)
    if (existing !== undefined) {
      const owner = this.runtimeProviderOwners.get(providerId)
      return `provider id '${providerId}' already by runtime register${owner !== undefined ? `(plugin ${owner})` : ''}, must not override`
    }
    const config = await this.providersSvc.get(providerId)
    if (config !== undefined) {
      return `provider id '${providerId}' and providers.json self define gateway conflict (enabled: ${String(config.enabled)})`
    }
    const builtin = builtinProviderIds.has(providerId)
    if (builtin) {
      return `provider id '${providerId}' and PI inside placement provider conflict, must not override`
    }
    return undefined
  }

  /** deregister: only when map still points to the same instance when delete (idempotent; by override/already delete when does not repeat rebuild). */
  private async unregisterRuntimeProvider(provider: Provider): Promise<void> {
    if (this.externalModels) return
    await this.enqueueModelsChange(async () => {
      if (this.runtimeProviders.get(provider.id) !== provider) return
      const owner = this.runtimeProviderOwners.get(provider.id)
      if ((this.runtimeProviderUsage.get(provider.id) ?? 0) > 0) {
        throw new HelmError('plugin_has_live_tasks', `provider ${provider.id} still has in-flight request`, 409, { providers: [provider.id] })
      }
      // usage check and retiring mark record between without await(serial domain inside sync segment): this after
      // rebuild multiple await window in, old set still may by new turn tune start stream(old
      // modelsCurrent not yet replace) - - window inside new acquire explicit failed, guarantee deregister return
      // after no longer appear the provider in-flight stream (otherwise assertRuntimeProvidersIdle because ownership
      // already delete while detect fewer than, deactivate/teardown will and in-flight model stream concurrency).
      this.retiringRuntimeProviders.add(provider.id)
      this.runtimeProviders.delete(provider.id)
      this.runtimeProviderOwners.delete(provider.id)
      try {
        await this.rebuildModelsLocked()
      } catch (error) {
        this.runtimeProviders.set(provider.id, provider)
        if (owner !== undefined) this.runtimeProviderOwners.set(provider.id, owner)
        throw error
      } finally {
        this.retiringRuntimeProviders.delete(provider.id)
      }
    })
  }

  /**
   * refresh motion state model directory (POST /api/models/refresh).
   * target runtime provider in-flight counter override the whole refresh cycle (teardown preflight reject in route reclaim);
   * catch invoke when set and proxy count: wait for during set by replace when no longer publish old set snapshot event;
   * error message via stash redaction after return.
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
    if (isClosed()) throw new HelmError('runtime_closing', 'kernel is now close, cannot refresh model directory', 409)
    if (this.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        'external inject Models when unsupported motion state directory refresh (model set archive caller all)',
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
        if (!provider) throw new HelmError('model_provider_not_found', `provider ${id} not registered`, 404)
        if (!provider.refreshModels) throw new HelmError('model_provider_static', `provider ${id} use static model directory, unsupported motion state refresh`, 400)
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
    // file level corrupt (models_store_corrupted) is not single provider failed, explicit on throw.
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

  /** closure stop when abort in-flight refresh. */
  abortRefresh(reason: Error): void {
    this.modelsRefreshAbort?.abort(reason)
  }

  /**
   * teardown preflight: plugin owner runtime provider if has in-flight streaming/refresh then throw
   * 409 plugin_has_live_tasks(guard against plugin mark is disabled but provider still in directory).
   * as long as busy then keep now state (model reference keep and under one turn available).
   */
  assertRuntimeProvidersIdle(pluginId: string): void {
    const busy: string[] = []
    for (const [id, owner] of this.runtimeProviderOwners) {
      if (owner === pluginId && (this.runtimeProviderUsage.get(id) ?? 0) > 0) busy.push(id)
    }
    if (busy.length > 0) {
      throw new HelmError(
        'plugin_has_live_tasks',
        `plugin ${pluginId} runtime provider still has in-flight model request:${busy.join(', ')}`,
        409,
        { providers: busy },
      )
    }
  }

  /** in-flight use counter: target provider each +1; return idempotent release function (each -1, reset to zero clear). */
  private acquireRuntimeProviders(ids: readonly string[]): () => void {
    for (const id of ids) {
      // deregister window inside new request explicit failed: let through will into is ownership already delete, detect fewer than in-flight stream
      if (this.retiringRuntimeProviders.has(id)) {
        throw new HelmError(
          'runtime_provider_retiring',
          `provider ${id} is now deregister (plugin deactivate in), reject new model request`,
          409,
          { providers: [id] },
        )
      }
    }
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
   * runtime provider use counter wrap:stream/streamSimple truly invoke when +1, event stream terminal state
   * (result() in done/error/end when resolve) after -1; do not consume asyncIterator.
   * refreshModels same counter (directory refresh in-flight when teardown preflight reject).
   */
  private wrapRuntimeProvider(provider: Provider): Provider {
    const acquire = () => this.acquireRuntimeProviders([provider.id])
    // through use wrap: first take stream after result().finally release (sync throw same release, do not forever long busy);
    // do not consume asyncIterator, do not change write options(generic parameter only follow specific signature pass).
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
