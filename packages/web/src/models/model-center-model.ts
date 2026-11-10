/**
 * 模型与凭证中心纯函数模型与分类过滤
 *
 * 覆盖：
 * - 供应商与模型数据结构定义；
 * - 内置主流大语言模型供应商静态元数据（Anthropic, OpenAI, DeepSeek, Gemini, Ollama 等）；
 * - 多维检索（按供应商名称、ID、描述及所包含的模型名称搜索）；
 * - 分类过滤（全部、已配置、商业云端、本地私有）；
 * - 分类计数与指标统计。
 */
import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol'
import type { CredentialSummary, ModelDescriptor } from '../lib/api.js'

export type ProviderType = 'commercial' | 'local'

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
  type: ProviderType
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

export type ProviderCategoryTab = 'all' | 'configured' | 'commercial' | 'local'

export interface FilterProvidersOptions {
  query: string
  categoryTab: ProviderCategoryTab
}

export interface ProviderSummaryStats {
  total: number
  configured: number
}

/**
 * 内置主流供应商静态元数据列表
 */
export const DEFAULT_PROVIDERS: ProviderItem[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'commercial',
    configured: false,
    modelsCount: 3,
    description: 'Claude 系列前沿模型，支持超长上下文窗口与深度逻辑推理。',
    models: [
      { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', tags: ['混合推理', '代码', '200K'], enabled: true },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', tags: ['全能基座', '代码', '200K'], enabled: true },
      { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', tags: ['极速响应', '轻量'], enabled: true },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'commercial',
    configured: false,
    modelsCount: 4,
    description: 'GPT-4o 与 o1/o3 深度推理大模型，行业顶级通用基座能力。',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tags: ['多模态', '高智能', '128K'], enabled: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tags: ['高性价比', '极速'], enabled: true },
      { id: 'o1', name: 'o1', tags: ['深度推理', '数学逻辑'], enabled: true },
      { id: 'o3-mini', name: 'o3-mini', tags: ['轻量推理', 'STEM'], enabled: true },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'commercial',
    configured: false,
    modelsCount: 2,
    description: '深度求索通用基座与 R1 满血强化学习推理大模型，极致高性价比。',
    models: [
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', tags: ['深度思考', '强化学习', '64K'], enabled: true },
      { id: 'deepseek-chat', name: 'DeepSeek V3', tags: ['通用对话', '高性价比', '64K'], enabled: true },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'commercial',
    configured: false,
    modelsCount: 3,
    description: '原生多模态大模型，支持百万级超长上下文与原生工具调用。',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tags: ['极速', '多模态', '1M'], enabled: true },
      { id: 'gemini-2.0-pro', name: 'Gemini 2.0 Pro', tags: ['旗舰分析', '2M'], enabled: true },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', tags: ['长文本', '多模态'], enabled: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'local',
    configured: false,
    modelsCount: 3,
    baseUrl: 'http://127.0.0.1:11434',
    description: '本地部署开源模型运行引擎，数据完全本地私密，无需外网凭证。',
    models: [
      { id: 'llama3.3:70b', name: 'Llama 3.3 70B', tags: ['开源旗舰', '本地私有'], enabled: true },
      { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B', tags: ['代码专家', '本地'], enabled: true },
      { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', tags: ['本地推理', '蒸馏'], enabled: true },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'commercial',
    configured: false,
    modelsCount: 3,
    description: '大模型统一聚合路由网关，单一 API 密钥自由调度全球各家顶尖模型。',
    models: [
      { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet (Router)', tags: ['聚合路由'], enabled: true },
      { id: 'openai/gpt-4o', name: 'GPT-4o (Router)', tags: ['聚合路由'], enabled: true },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Router)', tags: ['开源聚合'], enabled: true },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    type: 'commercial',
    configured: false,
    modelsCount: 3,
    description: '欧洲领先开源大模型提供商，在多语言逻辑、推理与代码生成表现优异。',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', tags: ['旗舰推理', '128K'], enabled: true },
      { id: 'codestral-latest', name: 'Codestral', tags: ['代码补全', '256K'], enabled: true },
      { id: 'mistral-small-latest', name: 'Mistral Small', tags: ['低延迟', '高并发'], enabled: true },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'commercial',
    configured: false,
    modelsCount: 2,
    description: '基于自研 LPU 芯片的超高吞吐推理加速平台，数百 Token/s 极低延迟响应。',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', tags: ['超低延迟', 'LPU'], enabled: true },
      { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill 70B', tags: ['极速推理'], enabled: true },
    ],
  },
  {
    id: 'magpie',
    name: 'Magpie 网关',
    type: 'local',
    configured: false,
    modelsCount: 0,
    dynamic: true,
    pluginId: 'builtin:magpie',
    description: '内置 Magpie 模型网关接入，支持多路由组、动态配额调度与高可用故障转移。',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    type: 'local',
    configured: false,
    modelsCount: 1,
    baseUrl: 'http://127.0.0.1:8000/v1',
    description: '连接自建 vLLM、SGLang、OneAPI 或第三方兼容 OpenAI 协议的自定义端点。',
    models: [
      { id: 'custom-model', name: 'Custom Model', tags: ['自定义兼容'], enabled: true },
    ],
  },
]

export const PROVIDER_CATEGORY_TABS: Array<{ key: ProviderCategoryTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'configured', label: '已配置' },
  { key: 'commercial', label: '商业云端' },
  { key: 'local', label: '本地私有' },
]

/**
 * 根据供应商 ID 推导线性矢量图标名称
 */
export function getProviderIconName(id: string): string {
  const norm = (id ?? '').toLowerCase().trim()
  if (norm.includes('anthropic') || norm.includes('claude')) return 'sparkles'
  if (norm.includes('openai') || norm.includes('gpt')) return 'bot'
  if (norm.includes('deepseek')) return 'cpu'
  if (norm.includes('gemini') || norm.includes('google')) return 'sparkles'
  if (norm.includes('ollama')) return 'hard-drive'
  if (norm.includes('openrouter')) return 'network'
  if (norm.includes('mistral')) return 'zap'
  if (norm.includes('groq')) return 'zap'
  if (norm.includes('magpie')) return 'sparkles'
  if (norm.includes('custom')) return 'sliders'
  return 'cpu'
}

/**
 * 多维过滤供应商列表：
 * 1. 过滤分类 Tab（all / configured / commercial / local）；
 * 2. 匹配关键字（供应商名称、ID、描述或包含的模型 ID/名称）。
 */
export function filterProviders(
  providers: ProviderItem[],
  options: FilterProvidersOptions,
): ProviderItem[] {
  const term = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return providers.filter((provider) => {
    // 1. 分类匹配
    if (tab === 'configured' && !provider.configured) return false
    if (tab === 'commercial' && provider.type !== 'commercial') return false
    if (tab === 'local' && provider.type !== 'local') return false

    // 2. 搜索词匹配
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
 * 全局默认模型下拉选项的空值哨兵：
 * Radix Select 把空字符串 value 视为 placeholder 语义（选中后 onValueChange 不触发），
 * 因此「未设置」用非空哨兵值承载，提交时再映射回空串。
 */
export const UNSET_MODEL_VALUE = '__unset__'

/**
 * 构造全局默认模型下拉选项：
 * - 首项恒为「未设置」哨兵项（显式表达清除语义）；
 * - 仅列出目录中可用的模型；
 * - 当前值不在可用目录（凭据失效/外部模型）时保留并标注「目录外」。
 */
export function buildDefaultModelOptions(
  models: ModelDescriptor[],
  currentModel: string,
): Array<{ value: string; label: string; meta?: string }> {
  const list: Array<{ value: string; label: string; meta?: string }> = [
    { value: UNSET_MODEL_VALUE, label: '未设置（未配置模型的会话无法回复）' },
  ]
  for (const m of models) {
    if (!m.available) continue
    list.push({ value: m.id, label: m.label ? `${m.label} (${m.id})` : m.id, meta: m.provider })
  }
  if (
    currentModel !== '' &&
    currentModel !== UNSET_MODEL_VALUE &&
    !models.some((m) => m.id === currentModel && m.available)
  ) {
    list.push({ value: currentModel, label: currentModel, meta: '目录外' })
  }
  return list
}

/**
 * 汇总各分类 Tab 下的供应商数量
 */
export function buildProviderCategoryCounts(
  providers: ProviderItem[],
): Record<ProviderCategoryTab, number> {
  const counts: Record<ProviderCategoryTab, number> = {
    all: providers.length,
    configured: 0,
    commercial: 0,
    local: 0,
  }

  for (const p of providers) {
    if (p.configured) counts.configured += 1
    if (p.type === 'commercial') counts.commercial += 1
    if (p.type === 'local') counts.local += 1
  }

  return counts
}

/**
 * 计算供应商总数与已配置数
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
 * 判断供应商是否属于本地私有类型
 */
export function isLocalProvider(id: string): boolean {
  const norm = (id ?? '').toLowerCase()
  return (
    norm.includes('ollama') ||
    norm.includes('lmstudio') ||
    norm.includes('local') ||
    norm.includes('custom') ||
    norm.includes('magpie')
  )
}

/**
 * 将预设供应商与后端真实目录、运行时凭证、自定义网关及目录模型全量融合
 */
export function buildMergedProviders(
  baseProviders: ProviderItem[] = DEFAULT_PROVIDERS,
  credentials?: Array<{ id: string; configured?: boolean }>,
  gateways?: ProviderConfig[],
  catalogModels?: ModelDescriptor[],
  catalog?: ModelProviderSummary[],
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

  // 1. 建立以 ID 为键的映射表，优先以 baseProviders 提供的高精元数据初始化
  const providerMap = new Map<string, ProviderItem>()
  for (const base of baseProviders) {
    providerMap.set(base.id.toLowerCase(), { ...base })
  }

  // 2. 融入后端实时拉取的完整供应商目录（包含 magpie 与全部插件或外部注册的供应商）
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
        type: isLocalProvider(cat.id) ? 'local' : 'commercial',
        configured: false,
        modelsCount: cat.modelCount ?? 0,
        baseUrl: cat.baseUrl,
        dynamic: Boolean(cat.dynamic),
        pluginId: cat.pluginId,
        authMethods: cat.authMethods,
        description: cat.dynamic
          ? '支持动态模型目录刷新的大语言模型供应商。'
          : `${cat.name || cat.id} 模型供应商。`,
      })
    }
  }

  // 3. 融入自定义网关（store.providers）
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
        type: 'local',
        custom: true,
        configured: Boolean(gw.enabled),
        baseUrl: gw.baseUrl,
        modelsCount: gw.models?.length ?? 1,
        description: '自定义 OpenAI 兼容协议接口网关。',
        models: gw.models?.map((mid) => ({
          id: mid,
          name: mid,
          tags: ['自定义'],
          enabled: true,
        })) ?? [{ id: 'default', name: 'Default Model', tags: ['自定义'], enabled: true }],
      })
    }
  }

  // 4. 计算每个供应商的模型与已配置状态
  const result: ProviderItem[] = []
  for (const provider of providerMap.values()) {
    const remoteModels = modelsByProvider.get(provider.id)
    const isConfiguredByKey = configuredIds.has(provider.id.toLowerCase())
    const hasAvailableModel = Boolean(remoteModels && remoteModels.some((m) => m.available))
    const isConfigured = provider.configured || isConfiguredByKey || hasAvailableModel

    let models = provider.models
    let modelsCount = provider.modelsCount

    if (remoteModels && remoteModels.length > 0) {
      models = remoteModels.map((rm) => ({
        id: rm.modelId,
        name: rm.label || rm.modelId,
        tags: rm.thinkingLevels?.filter((l) => l !== 'off').length > 0 ? ['思考模型'] : [],
        enabled: rm.available,
      }))
      modelsCount = models.length
    }

    result.push({
      ...provider,
      configured: isConfigured,
      models,
      modelsCount,
    })
  }

  // 5. 排序：已配置优先，其次按名称字母升序
  return result.sort(
    (a, b) =>
      Number(b.configured) - Number(a.configured) ||
      a.name.localeCompare(b.name),
  )
}
