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
 * 将静态预设供应商与运行时凭证、自定义网关及目录模型融合
 */
export function buildMergedProviders(
  baseProviders: ProviderItem[] = DEFAULT_PROVIDERS,
  credentials?: Array<{ id: string; configured?: boolean }>,
  gateways?: ProviderConfig[],
  catalogModels?: ModelDescriptor[],
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

  const result: ProviderItem[] = baseProviders.map((base) => {
    const isConfigured = configuredIds.has(base.id.toLowerCase())
    const remoteModels = modelsByProvider.get(base.id)

    let models = base.models
    let modelsCount = base.modelsCount

    if (remoteModels && remoteModels.length > 0) {
      models = remoteModels.map((rm) => ({
        id: rm.modelId,
        name: rm.label || rm.modelId,
        tags: rm.thinkingLevels?.filter((l) => l !== 'off').length > 0 ? ['思考模型'] : [],
        enabled: rm.available,
      }))
      modelsCount = models.length
    }

    return {
      ...base,
      configured: isConfigured,
      models,
      modelsCount,
    }
  })

  // 融合网关中的自定义提供商
  for (const gw of gateways ?? []) {
    const existing = result.find((r) => r.id === gw.id)
    if (existing) {
      existing.baseUrl = gw.baseUrl || existing.baseUrl
      existing.configured = existing.configured || Boolean(gw.enabled)
    } else {
      result.push({
        id: gw.id,
        name: gw.label || gw.id,
        type: 'local',
        configured: Boolean(gw.enabled),
        baseUrl: gw.baseUrl,
        modelsCount: gw.models?.length ?? 1,
        description: '自定义 OpenAI 兼容接口网关。',
        models: gw.models?.map((mid) => ({
          id: mid,
          name: mid,
          tags: ['自定义'],
          enabled: true,
        })) ?? [{ id: 'default', name: 'Default Model', tags: ['自定义'], enabled: true }],
      })
    }
  }

  return result
}
