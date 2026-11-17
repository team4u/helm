/**
 * Pure-function model and search/filter logic for the Models & Credentials
 * Center.
 *
 * Covers:
 * - Provider and model data structures;
 * - static metadata for mainstream built-in LLM providers (Anthropic, OpenAI,
 *   DeepSeek, Gemini, Ollama, ...);
 * - multi-dimensional search (provider name, ID, description and included
 *   model names);
 * - category counting and default-model option building.
 * - Front-end conventions: pure property-driven logic, zero ID-string guessing.
 *
 * i18n: functions that produce display copy take an optional trailing
 * `t` translator (English bridge by default); preset descriptions/tags are
 * constant-table labels and therefore resolved through `t` by the
 * `buildDefaultProviders` builder instead of living as raw literals.
 */
import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol/browser'
import type { CredentialSummary, ModelDescriptor } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { formatTokens } from '../lib/format.js'

export interface ProviderModelItem {
  id: string
  name: string
  tags?: string[]
  enabled: boolean
  description?: string
}

export interface ProviderItem {
  id: string
  name: string
  type?: string
  configured: boolean
  modelsCount: number
  description?: string
  baseUrl?: string
  dynamic?: boolean
  pluginId?: string
  custom?: boolean
  authMethods?: Array<{ type: 'api_key' | 'oauth'; label: string }>
  models?: ProviderModelItem[]
}

export type ProviderFilterTab = 'all' | 'configured'

/**
 * Provider filter pills with labels resolved through the active-locale
 * translator (`common.all` is shared exactly; the configured label is
 * domain copy).
 */
export function buildProviderFilterTabs(
  t: WebMessageTranslator = englishWebTranslator,
): Array<{ key: ProviderFilterTab; label: string }> {
  return [
    { key: 'all', label: t('common.all') },
    { key: 'configured', label: t('models.configured') },
  ]
}

/**
 * English-label constant kept as the pre-i18n compatibility export; migrated
 * call sites use `buildProviderFilterTabs(t)` instead.
 */
export const PROVIDER_FILTER_TABS: Array<{ key: ProviderFilterTab; label: string }> =
  buildProviderFilterTabs()

export interface FilterProvidersOptions {
  query?: string
  statusTab?: ProviderFilterTab
}

export interface ProviderSummaryStats {
  total: number
  configured: number
}

/**
 * Built-in mainstream provider presets with display copy resolved through the
 * translator; brand names, model ids and numeric tokens (200K, LPU, ...) are
 * locale-stable data and stay literal.
 */
export function buildDefaultProviders(
  t: WebMessageTranslator = englishWebTranslator,
): ProviderItem[] {
  return [
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: false,
      modelsCount: 3,
      description: t('models.preset.anthropic.description'),
      models: [
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', tags: [t('models.tag.hybridReasoning'), t('models.tag.code'), '200K'], enabled: true },
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', tags: [t('models.tag.generalFoundation'), t('models.tag.code'), '200K'], enabled: true },
        { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', tags: [t('models.tag.fastResponse'), t('models.tag.lightweight')], enabled: true },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      configured: false,
      modelsCount: 4,
      description: t('models.preset.openai.description'),
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', tags: [t('models.tag.multimodal'), t('models.tag.highIntelligence'), '128K'], enabled: true },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tags: [t('models.tag.greatValue'), t('models.tag.fast')], enabled: true },
        { id: 'o1', name: 'o1', tags: [t('models.tag.deepReasoning'), t('models.tag.mathLogic')], enabled: true },
        { id: 'o3-mini', name: 'o3-mini', tags: [t('models.tag.lightweightReasoning'), 'STEM'], enabled: true },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      configured: false,
      modelsCount: 2,
      description: t('models.preset.deepseek.description'),
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek R1', tags: [t('models.tag.deepThinking'), t('models.tag.reinforcementLearning'), '64K'], enabled: true },
        { id: 'deepseek-chat', name: 'DeepSeek V3', tags: [t('models.tag.generalConversation'), t('models.tag.greatValue'), '64K'], enabled: true },
      ],
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      configured: false,
      modelsCount: 3,
      description: t('models.preset.gemini.description'),
      models: [
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tags: [t('models.tag.veryLongContext'), '2M'], enabled: true },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tags: [t('models.tag.lowLatency'), t('models.tag.multimodal')], enabled: true },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tags: [t('models.tag.fastResponse')], enabled: true },
      ],
    },
    {
      id: 'ollama',
      name: 'Ollama',
      configured: false,
      modelsCount: 0,
      baseUrl: 'http://127.0.0.1:11434',
      dynamic: true,
      description: t('models.preset.ollama.description'),
      models: [],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      configured: false,
      modelsCount: 0,
      baseUrl: 'https://openrouter.ai/api/v1',
      dynamic: true,
      description: t('models.preset.openrouter.description'),
      models: [],
    },
    {
      id: 'mistral',
      name: 'Mistral AI',
      configured: false,
      modelsCount: 3,
      description: t('models.preset.mistral.description'),
      models: [
        { id: 'mistral-large-latest', name: 'Mistral Large', tags: [t('models.tag.flagshipFoundation'), '128K'], enabled: true },
        { id: 'codestral-latest', name: 'Codestral', tags: [t('models.tag.codeGeneration'), '32K'], enabled: true },
        { id: 'ministral-8b-latest', name: 'Ministral 8B', tags: [t('models.tag.edgeFast')], enabled: true },
      ],
    },
    {
      id: 'groq',
      name: 'Groq',
      configured: false,
      modelsCount: 2,
      description: t('models.preset.groq.description'),
      models: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', tags: [t('models.tag.ultraLowLatency'), 'LPU'], enabled: true },
        { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill 70B', tags: [t('models.tag.fastInference')], enabled: true },
      ],
    },
    {
      id: 'custom',
      name: t('models.preset.custom.name'),
      configured: false,
      modelsCount: 1,
      baseUrl: 'http://127.0.0.1:8000/v1',
      description: t('models.preset.custom.description'),
      models: [
        { id: 'custom-model', name: 'Custom Model', tags: [t('models.tag.customCompatible')], enabled: true },
      ],
    },
  ]
}

/**
 * English preset table kept as the pre-i18n compatibility export (also the
 * default `baseProviders` for `buildMergedProviders` at unmigrated call sites).
 */
export const DEFAULT_PROVIDERS: ProviderItem[] = buildDefaultProviders()

/**
 * Count total and configured providers.
 */
export function buildProviderCategoryCounts(
  providers: ProviderItem[],
): Record<ProviderFilterTab, number> {
  let configured = 0
  for (const p of providers) {
    if (p.configured) configured++
  }
  return {
    all: providers.length,
    configured,
  }
}

/**
 * Default provider ordering: configured first, then ascending by name.
 */
export function sortProvidersConfiguredFirst(providers: ProviderItem[]): ProviderItem[] {
  return [...providers].sort(
    (a, b) =>
      Number(b.configured) - Number(a.configured) ||
      a.name.localeCompare(b.name),
  )
}

/**
 * Extract the first N available model short names for the card preview plus
 * the remaining count.
 */
export function summarizeCardModels(
  provider: ProviderItem,
  maxPreview = 3,
): { previewNames: string[]; remainingCount: number } {
  const available = (provider.models ?? []).filter((m) => m.enabled !== false)
  const previewNames = available.slice(0, maxPreview).map((m) => {
    const raw = (m.name || m.id).trim()
    const slashIdx = raw.lastIndexOf('/')
    return slashIdx >= 0 && slashIdx < raw.length - 1 ? raw.slice(slashIdx + 1) : raw
  })
  const totalAvailable = available.length
  return {
    previewNames,
    remainingCount: Math.max(0, totalAvailable - previewNames.length),
  }
}

/**
 * Multi-dimensional provider filtering:
 * matches the category status (all / configured) and a keyword (provider
 * name, ID, description or included model id/name).
 */
export function filterProviders(
  providers: ProviderItem[],
  options: FilterProvidersOptions,
): ProviderItem[] {
  const term = (options.query ?? '').trim().toLowerCase()
  const statusTab = options.statusTab ?? 'all'

  return providers.filter((provider) => {
    if (statusTab === 'configured' && !provider.configured) {
      return false
    }

    // Keyword match
    if (!term) return true

    if (provider.id.toLowerCase().includes(term)) return true
    if (provider.name.toLowerCase().includes(term)) return true
    if (provider.description?.toLowerCase().includes(term)) return true

    if (
      provider.models?.some(
        (m) =>
          m.id.toLowerCase().includes(term) ||
          m.name.toLowerCase().includes(term) ||
          m.tags?.some((t) => t.toLowerCase().includes(term)),
      )
    ) {
      return true
    }

    return false
  })
}

/**
 * Non-empty sentinel value for the "not set" default-model select option:
 * Radix Select treats an empty-string value as placeholder semantics (selecting
 * it never fires onValueChange), so the clear action rides on a sentinel value
 * and is mapped back to the empty string on submit.
 */
export const UNSET_MODEL_VALUE = '__unset__'

/**
 * Build the global default-model select options:
 * - the first entry is always the "not set" sentinel (explicit clear semantics);
 * - only models that are available in the catalog and not user-disabled are listed;
 * - a current value missing from the selectable list (broken credentials,
 *   external model, disabled) is kept and annotated as "not in catalog" or
 *   "disabled" instead of being dropped silently; annotated items are not duplicated.
 */
export function buildDefaultModelOptions(
  models: ModelDescriptor[],
  currentValue?: string,
  t: WebMessageTranslator = englishWebTranslator,
  unsetLabel: string = t('models.defaults.optionUnset'),
): Array<{ value: string; label: string; meta?: string }> {
  const options: Array<{ value: string; label: string; meta?: string }> = [
    { value: UNSET_MODEL_VALUE, label: unsetLabel },
  ]

  for (const m of models) {
    if (!m.available || m.disabled === true) continue
    options.push({
      value: m.id,
      label: m.label || m.modelId,
      meta: m.provider,
    })
  }

  // If the currently configured model is not selectable (historic config,
  // deleted provider, missing credentials or disabled), keep it as a visible
  // entry so it is not silently lost; disabled models get a dedicated
  // annotation (distinct from out-of-catalog, hinting a re-enable is needed).
  const trimmed = currentValue?.trim()
  if (
    trimmed &&
    trimmed !== UNSET_MODEL_VALUE &&
    !options.some((opt) => opt.value === trimmed)
  ) {
    const disabled = models.some((m) => m.id === trimmed && m.disabled === true)
    options.push({
      value: trimmed,
      label: disabled
        ? t('models.defaults.optionDisabled', { model: trimmed })
        : t('models.defaults.optionCurrent', { model: trimmed }),
      meta: disabled ? t('models.defaults.metaDisabled') : t('models.defaults.metaNotInCatalog'),
    })
  }

  return options
}

/**
 * Summarize total and configured provider counts.
 */
export function summarizeProviders(
  providers: ProviderItem[],
): ProviderSummaryStats {
  return {
    total: providers.length,
    configured: providers.filter((p) => p.configured).length,
  }
}

/**
 * Merge the preset providers with the live backend catalog, runtime
 * credentials, custom gateways and catalog models.
 */
export function buildMergedProviders(
  baseProviders: ProviderItem[] = DEFAULT_PROVIDERS,
  credentials?: Array<{ id: string; configured?: boolean }>,
  gateways?: ProviderConfig[],
  catalogModels?: ModelDescriptor[],
  catalog?: ModelProviderSummary[],
  t: WebMessageTranslator = englishWebTranslator,
): ProviderItem[] {
  const configuredIds = new Set(
    (credentials ?? [])
      .filter((c) => Boolean(c.configured))
      .map((c) => c.id.toLowerCase()),
  )

  const modelsByProvider = new Map<string, ModelDescriptor[]>()
  for (const m of catalogModels ?? []) {
    const list = modelsByProvider.get(m.provider) ?? []
    list.push(m)
    modelsByProvider.set(m.provider, list)
  }

  // 1. Seed an id-keyed map from the high-fidelity preset metadata.
  const providerMap = new Map<string, ProviderItem>()
  for (const base of baseProviders) {
    providerMap.set(base.id.toLowerCase(), { ...base })
  }

  // 2. Merge the full backend provider catalog pulled live (magpie plus every
  //    plugin- or externally-registered provider).
  for (const cat of catalog ?? []) {
    const key = cat.id.toLowerCase()
    const existing = providerMap.get(key)
    if (existing) {
      existing.name = existing.name || cat.name || cat.id
      existing.baseUrl = cat.baseUrl || existing.baseUrl
      existing.dynamic = Boolean(cat.dynamic || existing.dynamic)
      existing.pluginId = cat.pluginId || existing.pluginId
      existing.authMethods = cat.authMethods ?? existing.authMethods
      if (cat.modelCount && cat.modelCount > existing.modelsCount) {
        existing.modelsCount = cat.modelCount
      }
    } else {
      providerMap.set(key, {
        id: cat.id,
        name: cat.name || cat.id,
        configured: false,
        modelsCount: cat.modelCount ?? 0,
        baseUrl: cat.baseUrl,
        dynamic: Boolean(cat.dynamic),
        pluginId: cat.pluginId,
        authMethods: cat.authMethods,
        description: cat.dynamic
          ? t('models.catalog.dynamicDescription')
          : t('models.catalog.providerDescription', { name: cat.name || cat.id }),
      })
    }
  }

  // 3. Merge custom gateways (store.providers).
  for (const gw of gateways ?? []) {
    const key = gw.id.toLowerCase()
    const existing = providerMap.get(key)
    if (existing) {
      existing.baseUrl = gw.baseUrl || existing.baseUrl
      existing.custom = true
      if (gw.enabled) existing.configured = true
    } else {
      providerMap.set(key, {
        id: gw.id,
        name: gw.label || gw.id,
        configured: Boolean(gw.enabled),
        modelsCount: 0,
        baseUrl: gw.baseUrl,
        custom: true,
        description: t('models.gatewayDynamicDescription'),
      })
    }
  }

  // 4. Reconcile credential state and model counts (credentials and the live
  //    catalog win).
  for (const [key, p] of providerMap.entries()) {
    const remoteModels = modelsByProvider.get(key)
    const isConfiguredByKey = configuredIds.has(key)
    const hasAvailableModel = Boolean(remoteModels && remoteModels.some((m) => m.available))
    p.configured = Boolean(p.configured || isConfiguredByKey || hasAvailableModel)

    // 5. Aggregate live catalog models and refresh the count. The checked
    //    state means "routing enabled": it is driven by `disabled` only and
    //    decoupled from credential availability — otherwise saving a key for a
    //    provider without credentials would wrongly disable all its models;
    //    `available` feeds the model picker / default-model option filtering.
    if (remoteModels && remoteModels.length > 0) {
      p.modelsCount = remoteModels.length
      p.models = remoteModels.map((m) => {
        // Tag order: thinking models first, then the real known window
        // (positive token count, compact format); never guess or default an
        // unknown window; keep undefined when neither applies (empty semantics
        // suppress the badge rendering).
        const tags: string[] = []
        if (m.thinkingLevels && m.thinkingLevels.length > 1) tags.push(t('models.tag.thinking'))
        if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
          tags.push(t('models.tag.context', { size: formatTokens(m.contextWindow) }))
        }
        return {
          id: m.modelId,
          name: m.label || m.modelId,
          enabled: m.disabled !== true,
          tags: tags.length > 0 ? tags : undefined,
        }
      })
    }
  }

  // 6. Order: configured first, then ascending alphabetically by name.
  return Array.from(providerMap.values()).sort(
    (a, b) =>
      Number(b.configured) - Number(a.configured) ||
      a.name.localeCompare(b.name),
  )
}
