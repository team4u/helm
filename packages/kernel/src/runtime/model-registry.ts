/**
 * Model catalog registry: manages `Models` instances, runtime providers, dynamic catalog refreshes,
 * and global default model / reasoning effort configuration.
 *
 * Extracted from `runtime.ts` (decomposing god-class model responsibilities). Serialization guarantee:
 * reload / register / unregister / refresh all queue onto `modelsChain` so stale concurrent rebuilds
 * cannot overwrite newer sets; when `Models` is externally injected (tests/embedded), ownership stays
 * with the caller and mutating paths no-op.
 */
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Models, Provider } from '@earendil-works/pi-ai/models'
import type { ModelsStore } from '@earendil-works/pi-ai'
import type { ModelCatalog, ModelProvidersRefreshResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConfigService, CredentialService, ProviderService, SecretStash } from '../services/index.js'
import { listModelCatalog, listModelProviders, buildModels } from './models.js'

/** Built-in PI provider ID set (lazily built once for registration conflict preflight without hardcoding lists). */
const builtinProviderIds = new Set(builtinProviders().map((p) => p.id))

/**
 * File-level corruption detection for `models-store.json`: SDK refresh packages store I/O errors into
 * `result.errors` (without rejecting so one failing provider doesn't abort others), but file corruption is a
 * global failure — silently falling back to an empty catalog would drop all cached dynamic catalogs. Rethrows explicitly.
 */
function assertModelsStoreHealthy(result: { errors: ReadonlyMap<string, Error> }): void {
  for (const [providerId, err] of result.errors) {
    if (err instanceof HelmError && err.code === 'models_store_corrupted') {
      throw new HelmError(
        'models_store_corrupted',
        `models-store.json is corrupted (discovered while reading ${providerId}): ${err.message}`,
        500,
      )
    }
  }
}

/**
 * Parse `config.json.disabledModels` (`providerId -> modelId[]`); defaults to `{}` and throws
 * `config_corrupt` explicitly on malformed structure (never silently discarded).
 */
function parseDisabledModelsConfig(raw: unknown): Record<string, string[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('config_corrupt', 'config.json.disabledModels must be an object (providerId -> modelId[])', 500)
  }
  const result: Record<string, string[]> = {}
  for (const [providerId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerId !== 'string' || providerId === '') {
      throw new HelmError('config_corrupt', `config.json.disabledModels key must be a non-empty provider ID: ${String(providerId)}`, 500)
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
      throw new HelmError('config_corrupt', `config.json.disabledModels['${providerId}'] must be an array of non-empty strings`, 500)
    }
    result[providerId] = [...(ids as string[])]
  }
  return result
}

/**
 * Parse `config.json.modelThinkingLevels` (`'provider/modelId' -> thinking level`); defaults to `{}` and throws
 * `config_corrupt` explicitly on malformed structure (never silently discarded). Keys keep the full reference
 * verbatim (model IDs may themselves contain `/`, e.g. aggregate gateways), so lookups rebuild the key from
 * `provider + '/' + modelId` instead of re-parsing. Synchronous (used inside `configSvc.updateBy` locks);
 * level enum validation happens at the load boundary.
 */
function parseModelThinkingLevelsConfig(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('config_corrupt', 'config.json.modelThinkingLevels must be an object (model reference -> thinking level)', 500)
  }
  const result: Record<string, string> = {}
  for (const [ref, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ref !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(ref)) {
      throw new HelmError('config_corrupt', `config.json.modelThinkingLevels key must be a 'provider/model' reference: ${ref}`, 500)
    }
    if (typeof level !== 'string' || level.trim() === '') {
      throw new HelmError('config_corrupt', `config.json.modelThinkingLevels['${ref}'] must be a non-empty thinking level`, 500)
    }
    result[ref] = level
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
  /** Hot-swap slot (`Harness` `models` getter reads the latest instance through this). */
  readonly setModels: (m: Models) => void
  /** Externally injected `Models` (tests): all mutating registry paths become no-ops or reject. */
  readonly externalModels: boolean
  readonly events: { publish(type: 'models.changed', payload: { providers: string[] }): void }
  /** Lazily injected `PluginHost` (used for `assertProviderAvailable` preflight). */
  readonly pluginHost: () => { assertProviderAvailable(pluginId: string): void } | undefined
  /** Align effective models across all conversations after default model changes (host implementation). */
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
  /** Runtime dynamically registered providers (injected by plugins via `HostOptions.providers.register`). */
  private readonly runtimeProviders = new Map<string, Provider>()
  /** Runtime provider ownership (`providerId` -> owning `pluginId`; cleared on unregister). */
  private readonly runtimeProviderOwners = new Map<string, string>()
  /** Serial chain for `models` mutations (shared by reload/register/unregister to prevent stale overwrites). */
  private modelsChain: Promise<unknown> = Promise.resolve()
  private modelsRefreshAbort: AbortController | undefined
  /** Monotonic generation counter (incremented per published set; prevents in-flight refreshes from publishing stale snapshots). */
  private modelsGeneration = 0
  /** In-flight usage counter for runtime providers (`providerId` -> active stream/refresh count; teardown preflight). */
  private readonly runtimeProviderUsage = new Map<string, number>()
  /** Retiring markers (held briefly inside the `modelsChain` critical section): ensures newly started streams/refreshes
   * during `rebuild`'s await window fail deterministically and eliminates the TOCTOU gap between idle check and ownership
   * deletion (usage increments occur outside this serial chain — see `wrapRuntimeProvider`). */
  private readonly retiringRuntimeProviders = new Set<string>()
  /** Synchronously readable API key cache (warmed on startup, refreshed on reload, consumed by `buildModels` closure). */
  readonly apiKeyCache: Record<string, string> = {}
  private modelsCurrent: Models
  defaultModel: string | undefined
  defaultThinkingLevel: string | undefined
  /** Per-model thinking defaults keyed by full `'provider/modelId'` reference (`config.json.modelThinkingLevels`). */
  modelThinkingLevels: Record<string, string> = {}
  defaultCompactionModel: string | undefined
  defaultCompactionThinkingLevel: string | undefined
  /** Placeholder used in hook payloads when no model is configured (submissions still reject via `requireModelRef`). */
  modelPlaceholder = 'unconfigured'
  /** Explicitly disabled models (`providerId -> modelId[]`; from `config.json.disabledModels`). */
  private disabledModels: Record<string, string[]> = {}

  constructor(
    options: ModelRegistryOptions,
    initialModels: Models,
    defaults: { model?: string; thinkingLevel?: string; compactionModel?: string; compactionThinkingLevel?: string },
  ) {
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
    this.defaultCompactionModel = defaults.compactionModel
    this.defaultCompactionThinkingLevel = defaults.compactionThinkingLevel
  }

  get models(): Models {
    return this.modelsCurrent
  }

  get refreshAbortController(): AbortController | undefined {
    return this.modelsRefreshAbort
  }

  /** Enqueue work onto `modelsChain` (errors propagate to caller without blocking subsequent queued work). */
  private enqueueModelsChange<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.modelsChain.then(fn, fn)
    this.modelsChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Wait for all in-flight model changes to settle before shutdown. */
  async dispose(): Promise<void> {
    await this.modelsChain
  }

  async listModels(): Promise<ModelCatalog> {
    return listModelCatalog(this.modelsCurrent, {
      model: this.defaultModel,
      thinkingLevel: this.defaultThinkingLevel,
      modelThinkingLevels: this.modelThinkingLevels,
      compactionModel: this.defaultCompactionModel,
      compactionThinkingLevel: this.defaultCompactionThinkingLevel,
      disabledModels: this.disabledModels,
    })
  }

  listModelProviders() {
    return listModelProviders(this.modelsCurrent, this.runtimeProviderOwners)
  }

  /** Read global default model and reasoning effort from `config.json` at startup (throws on invalid format). */
  async loadDefaultsFromConfig(): Promise<void> {
    const raw: Record<string, unknown> = (await this.configSvc.get()) as Record<string, unknown>
    if (this.defaultModel === undefined) {
      const configured = raw['model']
      if (configured !== undefined && configured !== '') {
        if (typeof configured !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configured)) {
          throw new HelmError('config_corrupt', 'config.json.model must be a string in provider/model format', 500)
        }
        this.defaultModel = configured
      }
    }
    if (this.defaultThinkingLevel === undefined) {
      const configuredLevel = raw['thinkingLevel'] as string | undefined | null
      if (configuredLevel !== undefined && configuredLevel !== '') {
        // Enum validation is injected by host (THINKING_LEVELS belongs to spawn contract).
        await this.configuredThinkingLevelValidated(configuredLevel as string)
        this.defaultThinkingLevel = configuredLevel as string
      }
    }
    if (this.defaultCompactionModel === undefined) {
      const configuredCompaction = raw['compactionModel']
      if (configuredCompaction !== undefined && configuredCompaction !== '') {
        if (typeof configuredCompaction !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configuredCompaction)) {
          throw new HelmError('config_corrupt', 'config.json.compactionModel must be a string in provider/model format', 500)
        }
        this.defaultCompactionModel = configuredCompaction
      }
    }
    if (this.defaultCompactionThinkingLevel === undefined) {
      const configuredCompactionLevel = raw['compactionThinkingLevel'] as string | undefined | null
      if (configuredCompactionLevel !== undefined && configuredCompactionLevel !== '') {
        await this.configuredThinkingLevelValidated(configuredCompactionLevel as string)
        this.defaultCompactionThinkingLevel = configuredCompactionLevel as string
      }
    }
    this.modelThinkingLevels = parseModelThinkingLevelsConfig(raw['modelThinkingLevels'])
    for (const level of new Set(Object.values(this.modelThinkingLevels))) {
      await this.configuredThinkingLevelValidated(level)
    }
    this.disabledModels = parseDisabledModelsConfig(raw['disabledModels'])
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
  }

  /** Reasoning effort enum validation callback (host-injected so this module avoids depending on spawn's THINKING_LEVELS). */
  private configuredThinkingLevelValidated = async (_level: string): Promise<void> => {
    throw new HelmError('config_corrupt', 'Internal error: thinkingLevel validator was not injected', 500)
  }

  /** Inject reasoning effort enum validator (call right after construction, before `loadDefaultsFromConfig`). */
  setThinkingLevelValidator(validate: (level: string) => Promise<void>): void {
    this.configuredThinkingLevelValidated = validate
  }

  /** Set global default model, reasoning effort, compaction model, and compaction reasoning effort (`config.json`). */
  async setDefaultModel(
    model: string | undefined,
    thinkingLevel: string | undefined,
    validateThinkingLevel: (level: string) => void,
    compactionModel?: string | undefined,
    compactionThinkingLevel?: string | undefined,
    modelThinkingLevels?: Record<string, string>,
    modelThinkingUpdate?: { model: string; level: string },
  ): Promise<void> {
    const trimmed = model?.trim()
    if (trimmed !== undefined && trimmed !== '') {
      const ref = this.parseModelRefOrThrow(trimmed)
      this.assertModelEnabled(ref.provider, ref.modelId)
    }
    const trimmedCompaction = compactionModel?.trim()
    if (trimmedCompaction !== undefined && trimmedCompaction !== '') {
      const ref = this.parseModelRefOrThrow(trimmedCompaction)
      this.assertModelEnabled(ref.provider, ref.modelId)
    }
    const normalizeLevel = (rawLevel: string | undefined): string | undefined => {
      if (rawLevel === undefined) return undefined
      const level = rawLevel.trim()
      if (level !== '') validateThinkingLevel(level)
      return level === '' ? undefined : level
    }
    const nextLevel = normalizeLevel(thinkingLevel)
    const nextCompactionLevel = normalizeLevel(compactionThinkingLevel)
    const nextModelThinkingLevels = modelThinkingLevels === undefined
      ? undefined
      : this.validateModelThinkingLevels(modelThinkingLevels, validateThinkingLevel)
    const nextModelThinkingUpdate = modelThinkingUpdate === undefined
      ? undefined
      : this.validateModelThinkingUpdate(modelThinkingUpdate, validateThinkingLevel)
    const updatedModelThinkingLevels = nextModelThinkingLevels !== undefined || nextModelThinkingUpdate !== undefined
    let nextResolvedModelThinkingLevels: Record<string, string> | undefined
    await this.configSvc.updateBy((current) => {
      const next = { ...current }
      if (trimmed === '') delete next.model
      else if (trimmed !== undefined) next.model = trimmed
      if (thinkingLevel === undefined) {
        // Leave existing thinkingLevel key untouched when omitted.
      } else if (nextLevel === undefined) {
        delete next.thinkingLevel
      } else {
        next.thinkingLevel = nextLevel
      }
      if (trimmedCompaction === '') delete next.compactionModel
      else if (trimmedCompaction !== undefined) next.compactionModel = trimmedCompaction
      if (compactionThinkingLevel === undefined) {
        // Leave existing compactionThinkingLevel key untouched when omitted.
      } else if (nextCompactionLevel === undefined) {
        delete next.compactionThinkingLevel
      } else {
        next.compactionThinkingLevel = nextCompactionLevel
      }
      if (updatedModelThinkingLevels) {
        const resolved = nextModelThinkingLevels !== undefined
          ? { ...nextModelThinkingLevels }
          : parseModelThinkingLevelsConfig(next['modelThinkingLevels'])
        if (nextModelThinkingUpdate !== undefined) {
          if (nextModelThinkingUpdate.level === '') delete resolved[nextModelThinkingUpdate.model]
          else resolved[nextModelThinkingUpdate.model] = nextModelThinkingUpdate.level
        }
        nextResolvedModelThinkingLevels = resolved
        if (Object.keys(resolved).length === 0) delete next.modelThinkingLevels
        else next.modelThinkingLevels = resolved
      }
      return next
    })
    if (trimmed !== undefined) this.defaultModel = trimmed === '' ? undefined : trimmed
    if (thinkingLevel !== undefined) this.defaultThinkingLevel = nextLevel
    if (trimmedCompaction !== undefined) {
      this.defaultCompactionModel = trimmedCompaction === '' ? undefined : trimmedCompaction
    }
    if (compactionThinkingLevel !== undefined) {
      this.defaultCompactionThinkingLevel = nextCompactionLevel
    }
    if (nextResolvedModelThinkingLevels !== undefined) this.modelThinkingLevels = nextResolvedModelThinkingLevels
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
    // Independent override fields: conversations with a model override still inherit the global reasoning effort.
    if (trimmed !== undefined || thinkingLevel !== undefined || updatedModelThinkingLevels) {
      await this.alignAllConversations()
    }
  }

  private validateModelThinkingLevels(
    levels: Record<string, string>,
    validateThinkingLevel: (level: string) => void,
  ): Record<string, string> {
    if (levels === null || typeof levels !== 'object' || Array.isArray(levels)) {
      throw new HelmError('validation_error', 'modelThinkingLevels must be an object mapping model references to thinking levels', 400)
    }
    const validated: Record<string, string> = {}
    for (const [model, rawLevel] of Object.entries(levels)) {
      if (!/^[^/\s]+\/[^\s]+$/.test(model)) {
        throw new HelmError('validation_error', `modelThinkingLevels key must be a 'provider/model' reference: ${model}`, 400)
      }
      this.parseModelRefOrThrow(model)
      if (typeof rawLevel !== 'string' || rawLevel.trim() === '') {
        throw new HelmError('validation_error', `modelThinkingLevels['${model}'] must be a non-empty thinking level`, 400)
      }
      const level = rawLevel.trim()
      validateThinkingLevel(level)
      validated[model] = level
    }
    return validated
  }

  private validateModelThinkingUpdate(
    update: { model: string; level: string },
    validateThinkingLevel: (level: string) => void,
  ): { model: string; level: string } {
    if (!/^[^/\s]+\/[^\s]+$/.test(update.model)) {
      throw new HelmError('validation_error', `modelThinking key must be a 'provider/model' reference: ${update.model}`, 400)
    }
    this.parseModelRefOrThrow(update.model)
    const level = update.level.trim()
    if (level !== '') validateThinkingLevel(level)
    return { model: update.model, level }
  }

  /** Validate `'provider/model'` reference (shared by create/update). */
  parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
    const slash = ref.indexOf('/')
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new HelmError('validation_error', `Model reference must be in 'provider/model' format: ${ref}`)
    }
    return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
  }

  /** Look up the per-model thinking default for a resolved reference (keyed by the full `'provider/modelId'` string). */
  modelThinkingLevelOf(ref: { provider: string; modelId: string }): string | undefined {
    return this.modelThinkingLevels[`${ref.provider}/${ref.modelId}`]
  }

  /**
   * Set or clear one per-model thinking default (`config.json.modelThinkingLevels`): empty `level` clears the
   * single entry, and the field itself is removed once the map becomes empty. Alignment then refreshes every
   * conversation whose effective model matches, so the new default takes effect without touching explicit
   * conversation overrides (which keep ranking above per-model defaults).
   */
  async setModelThinkingDefault(
    model: string,
    level: string,
    validateThinkingLevel: (level: string) => void,
  ): Promise<void> {
    const trimmedModel = model.trim()
    if (trimmedModel === '') {
      throw new HelmError('validation_error', 'Per-model thinking default requires a model reference', 400)
    }
    const ref = this.parseModelRefOrThrow(trimmedModel)
    this.assertModelEnabled(ref.provider, ref.modelId)
    const trimmedLevel = level.trim()
    if (trimmedLevel !== '') validateThinkingLevel(trimmedLevel)
    const next = await this.configSvc.updateBy((current) => {
      const merged: Record<string, unknown> = { ...current }
      const existing = parseModelThinkingLevelsConfig(merged['modelThinkingLevels'])
      if (trimmedLevel === '') delete existing[trimmedModel]
      else existing[trimmedModel] = trimmedLevel
      if (Object.keys(existing).length === 0) delete merged['modelThinkingLevels']
      else merged['modelThinkingLevels'] = existing
      return merged
    })
    this.modelThinkingLevels = parseModelThinkingLevelsConfig(next['modelThinkingLevels'])
    await this.alignAllConversations()
  }

  /** Synchronously check whether a model is explicitly disabled by the user (used for conversation resolution filtering). */
  isModelDisabled(providerId: string, modelId: string): boolean {
    return this.disabledModels[providerId]?.includes(modelId) === true
  }

  /** Reject explicitly when a model is disabled (`409 model_disabled`), reused across explicit selection paths. */
  assertModelEnabled(providerId: string, modelId: string): void {
    if (this.isModelDisabled(providerId, modelId)) {
      throw new HelmError(
        'model_disabled',
        `Model ${providerId}/${modelId} is disabled; re-enable it in Settings -> Models or via 'helm models filter' before selecting it`,
        409,
        { provider: providerId, modelId },
      )
    }
  }

  /**
   * Set disabled model list (`PUT /api/models/filter`): omitting `provider` clears all disabled entries
   * (`modelIds` must be empty); persists atomically to `config.json` and returns updated catalog.
   * Backend stores strings verbatim without verifying model existence (catalog flags match catalog entries only).
   */
  async setDisabledModels(provider: string | undefined, modelIds: string[]): Promise<ModelCatalog> {
    if (provider === undefined || provider === '') {
      if (modelIds.length > 0) {
        throw new HelmError('validation_error', 'Clearing disabled models without specifying a provider requires an empty disabledModels array', 400)
      }
    }
    const unique: string[] = []
    for (const id of modelIds) {
      // `modelId` may contain `/` (aggregate gateways like OpenRouter/Magpie name models `'vendor/model'`; the slash belongs to the model ID).
      if (typeof id !== 'string' || id === '') {
        throw new HelmError('validation_error', `Model ID must be a non-empty string: ${String(id)}`, 400)
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
    // In-memory snapshot updated: emit models.changed so connected Web clients reload the catalog
    // (subscriber assembly/redaction failures propagate synchronously instead of being swallowed).
    this.events.publish('models.changed', { providers: provider ? [provider] : [] })
    return this.listModels()
  }

  /**
   * Rebuild and publish the active model collection (shared across `providers.json`, credentials, and runtime provider changes).
   * Serialized via `modelsChain` so stale concurrent rebuilds cannot overwrite newer sets;
   * no-ops when `Models` is externally injected (caller owns the set).
   */
  async reloadModels(): Promise<void> {
    await this.enqueueModelsChange(async () => {
      await this.rebuildModelsLocked()
    })
  }

  /** Perform rebuild while holding `modelsChain` (no-op for externally injected sets). */
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
      throw new HelmError('runtime_provider_conflict', `Gateway '${collision.id}' conflicts with a plugin-registered provider`, 409)
    }
    const models = buildModels({
      providers: providerConfigs,
      apiKeys: () => nextKeys,
      modelsStore: this.modelsStore,
      extraProviders: [...this.runtimeProviders.values()],
    })
    // Restore cached catalog offline (`allowNetwork: false`). `models-store.json` corruption is a file-level failure
    // rather than a single-provider error: SDK puts it in `result.errors` without rejecting, so throw explicitly
    // here instead of silently falling back to an empty catalog.
    await assertModelsStoreHealthy(await models.refresh({ allowNetwork: false }))
    // Publish atomically only after full load succeeds; replace keys in place so deleted secrets also clear from cache.
    for (const id of Object.keys(this.apiKeyCache)) delete this.apiKeyCache[id]
    Object.assign(this.apiKeyCache, nextKeys)
    this.modelsGeneration += 1
    this.modelsCurrent = models
    this.setModels(this.modelsCurrent)
    this.events.publish('models.changed', { providers: [] })
  }

  /**
   * Register a dynamic runtime provider (injected by plugins via `HostOptions.providers.register`).
   * Rejects conflicts (never overrides any existing provider): built-in providers, `providers.json` custom gateways,
   * and providers registered by other owners; disabled `providers.json` entries with the same ID still reserve the namespace.
   * Explicitly unsupported when `Models` is externally injected (caller owns the set; succeeding silently would lie).
   * Returns an idempotent unregister callback that deletes and rebuilds only if the map still points to this instance.
   */
  async registerRuntimeProvider(provider: Provider, pluginId?: string): Promise<() => Promise<void>> {
    if (this.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        'Runtime provider registration is unsupported when Models is externally injected (caller owns model set)',
        400,
      )
    }
    if (typeof provider?.id !== 'string' || provider.id === '') {
      throw new HelmError('validation_error', `Runtime provider ID must be a non-empty string: ${String(provider?.id)}`, 400)
    }
    // Capture this registration's wrapped instance so stale disposers never delete a later same-named registration.
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
        // Roll back on failure so an orphaned map entry isn't picked up by subsequent reloads.
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

  /** Conflict detection: returns error message if conflicting (`undefined` = no conflict) across built-in/custom gateways/runtime owners. */
  private async findRuntimeProviderConflict(providerId: string): Promise<string | undefined> {
    const existing = this.runtimeProviders.get(providerId)
    if (existing !== undefined) {
      const owner = this.runtimeProviderOwners.get(providerId)
      return `Provider ID '${providerId}' is already registered at runtime${owner !== undefined ? ` (plugin ${owner})` : ''}; cannot override`
    }
    const config = await this.providersSvc.get(providerId)
    if (config !== undefined) {
      return `Provider ID '${providerId}' conflicts with a custom gateway in providers.json (enabled: ${String(config.enabled)})`
    }
    const builtin = builtinProviderIds.has(providerId)
    if (builtin) {
      return `Provider ID '${providerId}' conflicts with a built-in PI provider; cannot override`
    }
    return undefined
  }

  /** Unregister only when the map still points to the same instance (idempotent; skips rebuild if already overwritten/deleted). */
  private async unregisterRuntimeProvider(provider: Provider): Promise<void> {
    if (this.externalModels) return
    await this.enqueueModelsChange(async () => {
      if (this.runtimeProviders.get(provider.id) !== provider) return
      const owner = this.runtimeProviderOwners.get(provider.id)
      if ((this.runtimeProviderUsage.get(provider.id) ?? 0) > 0) {
        throw new HelmError('plugin_has_live_tasks', `Provider '${provider.id}' still has requests in flight`, 409, { providers: [provider.id] })
      }
      // No `await` between usage check and retiring mark (synchronous inside the serial chain): ensures any new
      // stream attempt during `rebuild`'s await window (before `modelsCurrent` swaps) fails explicitly, guaranteeing
      // no in-flight streams remain once unregister returns (preventing missed detections after ownership deletion).
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
   * Refresh dynamic model catalogs (`POST /api/models/refresh`).
   * Holds in-flight counters on target runtime providers across the whole cycle (so teardown preflight rejects mid-refresh);
   * captures instance and generation at start to avoid publishing stale snapshot events if replaced mid-flight;
   * redacts errors via stash before returning.
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
    if (isClosed()) throw new HelmError('runtime_closing', 'Kernel is closing; cannot refresh model catalog', 409)
    if (this.externalModels) {
      throw new HelmError(
        'runtime_provider_unsupported',
        'Dynamic catalog refresh is unsupported when Models is externally injected (caller owns model set)',
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
        if (!provider) throw new HelmError('model_provider_not_found', `Provider '${id}' is not registered`, 404)
        if (!provider.refreshModels) throw new HelmError('model_provider_static', `Provider '${id}' uses a static model catalog and does not support dynamic refresh`, 400)
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
    // File-level corruption (models_store_corrupted) affects the whole store rather than one provider; propagate explicitly.
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

  /** Abort in-flight refreshes on shutdown. */
  abortRefresh(reason: Error): void {
    this.modelsRefreshAbort?.abort(reason)
  }

  /**
   * Teardown preflight: throws `409 plugin_has_live_tasks` if any runtime provider owned by `pluginId`
   * has streams or refreshes in flight (prevents marking a plugin disabled while its provider remains live).
   * Preserves current state while busy (model references stay available for subsequent turns).
   */
  assertRuntimeProvidersIdle(pluginId: string): void {
    const busy: string[] = []
    for (const [id, owner] of this.runtimeProviderOwners) {
      if (owner === pluginId && (this.runtimeProviderUsage.get(id) ?? 0) > 0) busy.push(id)
    }
    if (busy.length > 0) {
      throw new HelmError(
        'plugin_has_live_tasks',
        `Plugin '${pluginId}' still has in-flight model requests on runtime providers: ${busy.join(', ')}`,
        409,
        { providers: busy },
      )
    }
  }

  /** In-flight usage guard: increments per target provider and returns an idempotent release function. */
  private acquireRuntimeProviders(ids: readonly string[]): () => void {
    for (const id of ids) {
      // Fail fast during unregistration window so new requests don't slip through after ownership deletion.
      if (this.retiringRuntimeProviders.has(id)) {
        throw new HelmError(
          'runtime_provider_retiring',
          `Provider '${id}' is currently retiring (plugin disabling); rejecting new model request`,
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
   * Usage-counting wrapper for runtime providers: increments on `stream`/`streamSimple` call and decrements
   * when `stream.result()` settles (done/error/end) without consuming `asyncIterator`.
   * Also wraps `refreshModels` so teardown preflight rejects during catalog refreshes.
   */
  private wrapRuntimeProvider(provider: Provider): Provider {
    const acquire = () => this.acquireRuntimeProviders([provider.id])
    // Pass-through wrapper: acquires before opening stream and releases via `result().then(release, release)`
    // (synchronous throws release immediately); never consumes `asyncIterator` or mutates `options`.
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
