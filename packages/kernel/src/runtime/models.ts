/**
 * Model gateway: all built-in pi-ai providers + `providers.json` compatibility gateway.
 *
 * Verified facts (from `@earendil-works/pi-ai` 1.5.0 source):
 * - `createProvider({ auth })`'s `auth` is `ProviderAuth` (`apiKey?: ApiKeyAuth` +
 *   `oauth?: OAuthAuth`); `ApiKeyAuth.resolve` receives `{ ctx, credential?, signal }` and
 *   returns `AuthResult | undefined` (`undefined` = unconfigured channel, a valid state).
 * - `Model` requires `provider` (must equal the registered provider id for request dispatch)
 *   and `baseUrl` (passed directly to `openai-completions` string URL building); four `cost` rates are required.
 * - Built-in providers handle credentials, env vars, and provider-specific config themselves; helm only injects
 *   already-stored keys as `credential` into native `ApiKeyAuth` without replacing native auth verification or OAuth policy.
 *
 * `providers.json`'s `models: string[]` contains only static model IDs without capability metadata;
 * unprobed capabilities (`contextWindow`, etc.) are explicitly flagged with conservative defaults rather than posing as probed values.
 * When no model is configured, throws `model_not_configured` explicitly rather than fabricating answers.
 */

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  clampThinkingLevel as clampToModelLevels,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AuthResult,
  type Model,
  type ModelInputModality,
  type ModelThinkingLevel,
  type Models,
  type ModelsStore,
  type Provider,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { HelmError, type ModelCatalog, type ModelCatalogEntry, type ModelProviderSummary, type ProviderConfig } from '@helm/protocol'

// Shared catalog entry types re-exported from `@helm/protocol` (preserved here so existing consumer import paths keep working).
export type { ModelCatalog, ModelCatalogEntry }

export interface ModelGatewayOptions {
  /** Entries from `providers.json`. */
  providers: ProviderConfig[]
  /** `providerId` -> API key (resolved by host credentials). */
  apiKeys: () => Record<string, string>
  /** Persistent dynamic model catalog cache (`models-store.json`); defaults to in-memory (no persistence). */
  modelsStore?: ModelsStore
  /** Dynamically registered extra providers at runtime (plugin-registered; credentials injected same as built-in providers). */
  extraProviders?: Provider[]
}

/**
 * Helm-specific source metadata attached to pi model objects (internal cross-cutting type; excluded from SDK contract).
 *
 * `helmContextWindowKnown`: whether `contextWindow` is a genuinely known value. pi-ai's `Model` contract
 * requires `contextWindow` as a number, so static sources (`providers.json` compat gateway or upstream
 * catalogs missing window sizes for Magpie items) can only supply conservative defaults — these models are
 * explicitly flagged `false`; built-in providers and explicit catalog windows are curated facts and default
 * (`undefined`) to known. Fields are preserved on model objects through `Models.setProvider`/`getModel`.
 */
export interface HelmModelSourceMeta {
  helmContextWindowKnown?: boolean
}

/** Returns a model's genuinely known context window only when positive, finite, and not flagged as a static default;
 * returns `undefined` when unknown (missing model / flagged `false` / non-positive or non-finite), never fabricating. */
export function knownContextWindowOf(model: Model<Api> | undefined): number | undefined {
  if (model === undefined) return undefined
  if ((model as Model<Api> & HelmModelSourceMeta).helmContextWindowKnown === false) return undefined
  return Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined
}

/** Conservative defaults for static compat-gateway models: `providers.json` supplies only model IDs (`string[]`),
 * while pi-ai's `Model` contract requires numeric `contextWindow` / `maxTokens` / `cost`.
 * These are minimal defaults so requests can go out — NOT probed real capabilities (which come only from
 * upstream catalogs like `/v1/models`).
 */
const COMPAT_MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  /** Unknown cost rates default to 0: pi-ai uses these for `usage.cost`; unknown rates compute as 0 and are noted as such. */
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const

/** Compat-gateway static model (concrete `Model` type, zero `as` casts). */
function compatModel(
  id: string,
  config: ProviderConfig,
): Model<'openai-completions'> | Model<'anthropic-messages'> {
  const shared = {
    id,
    name: id,
    provider: config.id,
    baseUrl: config.baseUrl,
    input: ['text'] as ModelInputModality[],
    ...COMPAT_MODEL_DEFAULTS,
    // Static default window is unprobed: mark explicitly unknown (skipped by knownContextWindowOf).
    helmContextWindowKnown: false,
  }
  return config.protocol === 'anthropic'
    ? { ...shared, api: 'anthropic-messages', reasoning: false }
    : { ...shared, api: 'openai-completions', reasoning: false }
}

/** Compat-gateway `ApiKeyAuth`: credential key (host-injected) takes precedence; returns `undefined` if unconfigured. */
function compatApiKeyAuth(providerId: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name: `${providerId} API key`,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted()
      const effective = credential?.key ?? apiKey
      if (!effective) return undefined
      const result: AuthResult = {
        auth: { apiKey: effective },
        source: credential?.key ? 'stored credential' : 'helm providers.json credentials',
      }
      return result
    },
  }
}

function buildCompatProvider(config: ProviderConfig, apiKey: string | undefined): Provider {
  return createProvider({
    id: config.id,
    name: config.label ?? config.id,
    baseUrl: config.baseUrl,
    auth: { apiKey: compatApiKeyAuth(config.id, apiKey) },
    models: config.models.map((m) => compatModel(m, config)),
    api: config.protocol === 'anthropic' ? anthropicMessagesApi() : openAICompletionsApi(),
  })
}

/**
 * Build the current `Models` registry. Rebuilt by host after `providers.json`/credential changes and hot-applied
 * via `HarnessOptions.models` getter without restarting the harness.
 * Registration precedence: built-in providers -> runtime dynamic providers (`extraProviders`) -> custom compat
 * gateways; later registrations override matching IDs from earlier ones (matching `reloadModels` conflict pre-validation).
 */
export function buildModels(options: ModelGatewayOptions): Models {
  const models = createModels(options.modelsStore ? { modelsStore: options.modelsStore } : undefined)
  const keys = options.apiKeys()

  for (const provider of builtinProviders()) {
    models.setProvider(withInjectedKey(provider, keys[provider.id]))
  }

  for (const provider of options.extraProviders ?? []) {
    models.setProvider(withInjectedKey(provider, keys[provider.id]))
  }

  for (const config of options.providers) {
    if (!config.enabled) continue
    models.setProvider(buildCompatProvider(config, keys[config.id]))
  }
  return models
}

/** Preserve provider's native auth resolution; OAuth-only providers must never receive fabricated API key methods. */
function withInjectedKey(provider: Provider, injectedKey: string | undefined): Provider {
  const base = provider.auth.apiKey
  if (!injectedKey || !base) return provider
  const injectCredential = (input: Parameters<ApiKeyAuth['resolve']>[0]) => ({
    ...input,
    credential: { ...input.credential, type: 'api_key' as const, key: input.credential?.key ?? injectedKey },
  })
  const apiKey: ApiKeyAuth = {
    ...base,
    ...(base.check ? { check: (input) => base.check!(injectCredential(input)) } : {}),
    resolve: (input) => base.resolve(injectCredential(input)),
  }
  return { ...provider, auth: { ...provider.auth, apiKey } }
}

/**
 * Expose only public metadata; never serialize SDK providers' internal headers or auth callbacks.
 * `dynamic`: provider implements `refreshModels` for remote catalog refreshing;
 * `baseUrl` / `pluginId`: non-secret display fields and owning plugin provenance (passed from runtime registry).
 */
export function listModelProviders(
  models: Models,
  providerOwners?: ReadonlyMap<string, string>,
): ModelProviderSummary[] {
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    modelCount: models.getModels(provider.id).length,
    authMethods: [
      ...(provider.auth.apiKey ? [{ type: 'api_key' as const, label: provider.auth.apiKey.name }] : []),
      ...(provider.auth.oauth ? [{ type: 'oauth' as const, label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
    ],
    ...(typeof provider.refreshModels === 'function' ? { dynamic: true } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(providerOwners?.get(provider.id) ? { pluginId: providerOwners.get(provider.id) } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface ModelRefParts {
  provider: string
  modelId: string
}

export function parseModelRef(ref: string): ModelRefParts {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash >= ref.length - 1) {
    throw new HelmError('validation_error', `Model reference must be in 'provider/model' format: ${ref}`)
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/**
 * List full model catalog (including unconfigured providers, marked `available=false`) and per-model effort levels.
 * `checkAuth` semantics: `undefined` = validly unconfigured credentials (only case marked `available=false`);
 * read/protocol errors (`ModelsError` code `auth`, etc.) propagate for diagnostics rather than silently swallowing.
 * `contextWindow` exposes only genuinely known windows (`knownContextWindowOf`); static defaults, missing upstream
 * windows, and non-positive/non-finite values are omitted rather than fabricating a 128k fallback.
 * `disabledModels`: `providerId ->` explicitly disabled model IDs (does not change `available`; marked `disabled` in
 * catalog and filtered during conversation model resolution).
 */
export async function listModelCatalog(
  models: Models,
  defaults?: {
    model?: string
    thinkingLevel?: string
    compactionModel?: string
    compactionThinkingLevel?: string
    disabledModels?: Readonly<Record<string, readonly string[]>>
  },
): Promise<ModelCatalog> {
  const entries: ModelCatalogEntry[] = []
  const thinkingLevels: Record<string, string[]> = {}
  for (const provider of models.getProviders()) {
    const auth = await models.checkAuth(provider.id)
    const disabled = defaults?.disabledModels?.[provider.id]
    for (const model of models.getModels(provider.id)) {
      const contextWindow = knownContextWindowOf(model)
      entries.push({
        provider: provider.id,
        modelId: model.id,
        available: auth !== undefined,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(disabled !== undefined && disabled.includes(model.id) ? { disabled: true } : {}),
      })
      thinkingLevels[`${provider.id}/${model.id}`] = [...getSupportedThinkingLevels(model)]
    }
  }
  return {
    models: entries,
    thinkingLevels,
    ...(defaults?.model ? { defaultModel: defaults.model } : {}),
    ...(defaults?.thinkingLevel ? { defaultThinkingLevel: defaults.thinkingLevel } : {}),
    ...(defaults?.compactionModel ? { defaultCompactionModel: defaults.compactionModel } : {}),
    ...(defaults?.compactionThinkingLevel ? { defaultCompactionThinkingLevel: defaults.compactionThinkingLevel } : {}),
  }
}

/** Resolve default model reference; missing config fails explicitly instead of fabricating a model. */
export function requireModelRef(ref: string | undefined): ModelRefParts {
  if (!ref || ref.trim() === '') {
    throw new HelmError(
      'model_not_configured',
      'No model configured: configure one in providers.json / Profile or set HELM_MODEL',
      503,
    )
  }
  return parseModelRef(ref)
}

/**
 * Clamp reasoning effort level to target model capabilities (converged in kernel on `setModel` -> `setThinkingLevel`).
 *
 * Verified facts (pi-ai 1.5.0 source):
 * - `getSupportedThinkingLevels`: `reasoning: false` -> `['off']`; `reasoning: true` without
 *   `thinkingLevelMap` -> `['off'..'high']` (`xhigh`/`max` require explicit mapping);
 * - `clampThinkingLevel`: clamps unsupported levels to the nearest supported level in the SDK list
 *   (searches upward first for nearest supported level, then downward).
 *
 * Pass-through exemptions (missing capabilities must not break contracts):
 * - Models absent from current `Models` registry (mock test models, catalog refresh windows, externally injected sets)
 *   pass through unchanged — helm never fabricates capabilities or overwrites user config on missing metadata;
 * - Models with `reasoning: false` and no `thinkingLevelMap` have no declared boundary and pass levels through
 *   for the underlying adapter to determine behavior.
 *
 * Empty strings (unconfigured) pass through unchanged so the inheritance chain is never misread as explicit `'off'`.
 */
export function clampThinkingLevelForModel(
  models: Models,
  modelRef: ModelRefParts | undefined,
  level: string | undefined,
): string | undefined {
  if (modelRef === undefined || level === undefined || level === '') return level
  const model = models.getModel(modelRef.provider, modelRef.modelId)
  if (model === undefined) return level
  // Capability boundary check: explicit `thinkingLevelMap` is authoritative; `reasoning: true` without
  // a map clamps against pi-ai's default levels (`off..high`, e.g. `max` -> `high`).
  if (model.reasoning !== true && model.thinkingLevelMap === undefined) return level
  const supported = getSupportedThinkingLevels(model)
  if (supported.includes(level as ModelThinkingLevel)) return level
  // SDK `'off'` semantics (`thinkingLevel === 'off'` omits reasoning parameter) work for every model;
  // never clamp upward to the smallest supported level when the user explicitly disabled reasoning.
  if (level === 'off') return 'off'
  return clampToModelLevels(model, level as ModelThinkingLevel)
}

export interface CompactionModelResolution {
  model: string | undefined
  thinkingLevel?: string | undefined
  isDisabled: (providerId: string, modelId: string) => boolean
}

const COMPACTION_SYSTEM_PROMPT_PREFIX = 'You are a context summarization assistant.'

function isCompactionSummarizationCall(
  context: Parameters<Models['completeSimple']>[1],
  options: Parameters<Models['completeSimple']>[2],
): boolean {
  if (options?.cacheRetention !== 'none') return false
  if (!Array.isArray(context.messages) || context.messages.length !== 2) return false
  const [sys, user] = context.messages
  if (sys?.role !== 'system' || typeof sys.content !== 'string') return false
  if (!sys.content.startsWith(COMPACTION_SYSTEM_PROMPT_PREFIX)) return false
  if (user?.role !== 'user') return false
  return true
}

function compactionErrorMessage(
  fallbackModel: Model<Api>,
  provider: string,
  modelId: string,
  errorMessage: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: fallbackModel.api,
    provider,
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  }
}

/**
 * Wrap a `Models` instance for `Harness`: when a global compaction model is configured,
 * routes `pi.compaction` summarization `completeSimple` calls to that model (clamping
 * `maxTokens` and `reasoning` to its capabilities, and failing explicitly without silent
 * fallback if the configured model is disabled or unavailable). When unset, passes through
 * unchanged to the conversation's current model.
 */
export function wrapModelsForCompaction(
  base: Models,
  resolveCompaction: () => CompactionModelResolution,
  cache?: WeakMap<Models, Models>,
): Models {
  const cached = cache?.get(base)
  if (cached !== undefined) return cached

  const wrapped = new Proxy(base, {
    get(target, prop) {
      if (prop === 'completeSimple') {
        return async (
          model: Model<Api>,
          context: Parameters<Models['completeSimple']>[1],
          options?: Parameters<Models['completeSimple']>[2],
        ): Promise<AssistantMessage> => {
          const { model: compactionRef, thinkingLevel: compactionThinkingLevel, isDisabled } = resolveCompaction()
          if ((!compactionRef && !compactionThinkingLevel) || !isCompactionSummarizationCall(context, options)) {
            return target.completeSimple(model, context, options)
          }
          let targetModel = model
          if (compactionRef) {
            let ref: ModelRefParts
            try {
              ref = parseModelRef(compactionRef)
            } catch (err) {
              return compactionErrorMessage(
                model,
                model.provider,
                model.id,
                err instanceof Error ? err.message : String(err),
              )
            }
            if (isDisabled(ref.provider, ref.modelId)) {
              return compactionErrorMessage(
                model,
                ref.provider,
                ref.modelId,
                `Compaction model ${ref.provider}/${ref.modelId} is disabled`,
              )
            }
            const resolved = target.getModel(ref.provider, ref.modelId)
            if (resolved === undefined) {
              return compactionErrorMessage(
                model,
                ref.provider,
                ref.modelId,
                `Compaction model ${ref.provider}/${ref.modelId} is not available`,
              )
            }
            targetModel = resolved
          }
          const next = { ...(options ?? {}) }
          if (compactionRef && targetModel.maxTokens > 0 && next.maxTokens !== undefined) {
            next.maxTokens = Math.min(next.maxTokens, targetModel.maxTokens)
          }
          const desiredThinking = compactionThinkingLevel ?? next.reasoning
          if (desiredThinking !== undefined) {
            const clamped = clampToModelLevels(targetModel, desiredThinking as ModelThinkingLevel)
            if (clamped === 'off') {
              delete next.reasoning
            } else {
              next.reasoning = clamped
            }
          }
          const effectiveOptions = options === undefined && Object.keys(next).length === 0 ? undefined : next
          return target.completeSimple(targetModel, context, effectiveOptions)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  cache?.set(base, wrapped)
  return wrapped
}
