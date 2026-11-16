/**
 * model access:pi-ai all amount inside placement provider + providers.json compatibility gateway.
 *
 * fact based on (@earendil-works/pi-ai 1.5.0 measured source code):
 * - `createProvider({ auth })`  auth i.e. `ProviderAuth`(`apiKey?: ApiKeyAuth` +
 *   `oauth?: OAuthAuth`),ApiKeyAuth.resolve input `{ ctx, credential?, signal }`,
 *   return `AuthResult | undefined`(undefined = the channel not config, is legal state).
 * - `Model` required `provider`(must equals register provider id, request dispatch by it inspect provider)
 *   and `baseUrl`(openai-completions directly for it do string probe);`cost` four cost rate required.
 * - inside placement provider self row handle credentials, environment variable and provider special has config;helm only already store key
 *   inject original generate ApiKeyAuth  credential, do not replace original generate recognize verify decide or oauth policy.
 *
 * providers.json  `models: string[]` only static model ID, excludes capability metadata;
 * not probe to capability (contextWindow etc.) with explicit mark record keep guard default to out, never smoke fill real probe value.
 * not config model when explicit throw model_not_configured, never faux fallback pretend answer.
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

// sharing directory item type unify from @helm/protocol(this where re- export, consumer no need to change import path).
export type { ModelCatalog, ModelCatalogEntry }

export interface ModelGatewayOptions {
  /** providers.json item. */
  providers: ProviderConfig[]
  /** providerId -> API Key(host credentials parse result). */
  apiKeys: () => Record<string, string>
  /** motion state model directory durable cache (models-store.json); default in-memory (do not). */
  modelsStore?: ModelsStore
  /** runtime motion state register extra provider (plugin register; credentials inject same inside placement provider). */
  extraProviders?: Provider[]
}

/**
 * helm additional in pi model object on source metadata (local cross type, does not enter SDK contract).
 *
 * `helmContextWindowKnown`:contextWindow is otherwise is real known value.pi-ai  Model
 * contract want seek contextWindow required number, static source (providers.json compatibility gateway, upstream
 * directory missing window Magpie item) only can fill keep guard default - - these model explicit mark record false;
 * inside placement provider and explicit model directory window is policy expand data, default (undefined) treated as known.
 * field follow model object via Models.setProvider/getModel original keep (SDK do not trim unknown field).
 */
export interface HelmModelSourceMeta {
  helmContextWindowKnown?: boolean
}

/** model real known context window: only when window is correct finite count and not by mark recorded as static default when
 * return; unknown (model do not in set / mark record false / window non- correct or non- finite) return undefined,
 * do not fabricate. */
export function knownContextWindowOf(model: Model<Api> | undefined): number | undefined {
  if (model === undefined) return undefined
  if ((model as Model<Api> & HelmModelSourceMeta).helmContextWindowKnown === false) return undefined
  return Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined
}

/** compatibility gateway static model keep guard default.providers.json only to model ID(string[]),
 * pi-ai  Model contract want seek contextWindow / maxTokens / cost is required number - -
 * these is let request can out most small default, is not probe to real capability:
 * real capability only can from upstream directory (such as /v1/models probe),helm item before does not probe.
 */
const COMPAT_MODEL_DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  /** cost rate unknown record 0:pi-ai use it compute usage.cost, unknown cost rate by 0 count price and such as mark note. */
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const

/** compatibility gateway static model (real Model type, without any as assertion). */
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
    // static default window is not probe value: explicit mark record unknown (knownContextWindowOf based on this omit).
    helmContextWindowKnown: false,
  }
  return config.protocol === 'anthropic'
    ? { ...shared, api: 'anthropic-messages', reasoning: false }
    : { ...shared, api: 'openai-completions', reasoning: false }
}

/** compatibility gateway ApiKeyAuth:credential key(host parse inject) takes precedence, not config return undefined. */
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
 * build when before Models set.providers.json / credentials change after by host rebuild,
 * via HarnessOptions.models  getter form hot takes effect (no need to heavy open harness).
 * register order: inside placement provider -> runtime motion state register (extraProviders)-> self define compatibility gateway;
 * after register override same id first register (and reloadModels conflict pre- validate match set, this in does not repeat intercept).
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

/** keep provider original generate recognize verify logic;OAuth-only provider must not by inject fabricate API Key way. */
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
 * explicit throw shadow public metadata, never serialization SDK provider inside headers or recognize verify call back.
 * dynamic: implement refreshModels provider support remote directory refresh;
 * baseUrl / pluginId: non- secret render and through use plugin ownership mount (runtime register table pass).
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
    throw new HelmError('validation_error', `model reference format should be 'provider/model':${ref}`)
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/**
 * column out all model directory (contains not config key , mark note available) and each model think Profile.
 * checkAuth semantics:undefined = legal not config credentials; only this case record available=false.
 * read error / protocol error (ModelsError code auth etc.) to on throw diagnose, never static default swallow.
 * contextWindow only throw shadow real known window (knownContextWindowOf): static default,
 * upstream not to window or illegal value (non- correct/non- finite) one rule omit, never 128k honor bottom smoke fill fact.
 * disabledSnapshot:providerId -> user explicit disable model ID collection (availability semantics do not change,
 * disable only as directory mark note; filter in conversation model parse entry execute).
 */
export async function listModelCatalog(
  models: Models,
  defaults?: { model?: string; thinkingLevel?: string; disabledModels?: Readonly<Record<string, readonly string[]>> },
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
  }
}

/** parse by default model reference; any missing all explicit errors (do not false build model). */
export function requireModelRef(ref: string | undefined): ModelRefParts {
  if (!ref || ref.trim() === '') {
    throw new HelmError(
      'model_not_configured',
      'not config any model: please in providers.json / profile in config, or settings HELM_MODEL environment variable',
      503,
    )
  }
  return parseModelRef(ref)
}

/**
 * by target model capability converge think Profile (setModel → setThinkingLevel kernel consolidate).
 *
 * fact based on (pi-ai 1.5.0 source code):
 * - `getSupportedThinkingLevels`:reasoning:false → ['off'];reasoning:true without
 *   thinkingLevelMap → ['off'..'high'](xhigh/max must explicit map only then available);
 * - `clampThinkingLevel`: unsupported Profile by SDK available Profile sequence then near converge
 *   (first to on find most near available Profile, again to under find).
 *
 * pass-through exemption (capability unknown do not break contract):
 * - model do not in when before Models set (faux test model, directory refresh window, external inject set)
 *   when original return - -helm do not virtual construct capability, never because inspect without metadata change write user config;
 * - `reasoning:false` and without `thinkingLevelMap` model do not treated as already declaration capability boundary,
 *   Profile original pass-through, by underlying adapt decide actual parameter behavior.
 *
 * empty string (not config) original return: does not with follow inherit chain mistakenly becomes explicit off.
 */
export function clampThinkingLevelForModel(
  models: Models,
  modelRef: ModelRefParts | undefined,
  level: string | undefined,
): string | undefined {
  if (modelRef === undefined || level === undefined || level === '') return level
  const model = models.getModel(modelRef.provider, modelRef.modelId)
  if (model === undefined) return level
  // capability declaration decide: explicit thinkingLevelMap is unique can message boundary;reasoning:true and
  // without map model by pi-ai default Profile (off..high) converge (e.g. max → high).
  if (model.reasoning !== true && model.thinkingLevelMap === undefined) return level
  const supported = getSupportedThinkingLevels(model)
  if (supported.includes(level as ModelThinkingLevel)) return level
  // SDK off semantics (generation: thinkingLevel==='off' do not reasoning parameter) for any
  // model all can satisfy, do not by clamp lift rise to most small available Profile; user explicit close think intent keep.
  if (level === 'off') return 'off'
  return clampToModelLevels(model, level as ModelThinkingLevel)
}
