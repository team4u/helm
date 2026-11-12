/**
 * 模型与凭证中心纯函数模型与检索过滤
 *
 * 覆盖：
 * - 供应商与模型数据结构定义；
 * - 内置主流大语言模型供应商静态元数据（Anthropic, OpenAI, DeepSeek, Gemini, Ollama 等）；
 * - 多维检索（按供应商名称、ID、描述及所包含的模型名称搜索）；
 * - 指标统计与默认模型选项构建。
 * - 遵循前端规范：纯属性驱动，零 ID 字符串硬编码推测。
 */
import type { ModelProviderSummary, ProviderConfig } from '@helm/protocol'
import type { CredentialSummary, ModelDescriptor } from '../lib/api.js'

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

export interface FilterProvidersOptions {
  query?: string
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
    configured: false,
    modelsCount: 3,
    description: '原生多模态大模型，支持百万级超长上下文与原生工具调用。',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tags: ['超长上下文', '2M'], enabled: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tags: ['低延迟', '多模态'], enabled: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tags: ['极速响应'], enabled: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    configured: false,
    modelsCount: 0,
    baseUrl: 'http://127.0.0.1:11434',
    dynamic: true,
    description: '本地私有化大模型运行平台，通过本地守护进程提供零外部依赖推理服务。',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: false,
    modelsCount: 0,
    baseUrl: 'https://openrouter.ai/api/v1',
    dynamic: true,
    description: '聚合全球数百家模型供应商的统一网关，支持智能路由与模型弹性调度。',
    models: [],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    configured: false,
    modelsCount: 3,
    description: '欧洲顶级开源与商业大模型系列，兼具优秀的多语言与逻辑推理能力。',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', tags: ['旗舰基座', '128K'], enabled: true },
      { id: 'codestral-latest', name: 'Codestral', tags: ['代码生成', '32K'], enabled: true },
      { id: 'ministral-8b-latest', name: 'Ministral 8B', tags: ['端侧极速'], enabled: true },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
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
    configured: false,
    modelsCount: 1,
    baseUrl: 'http://127.0.0.1:8000/v1',
    description: '连接自建 vLLM、SGLang、OneAPI 或第三方兼容 OpenAI 协议的自定义端点。',
    models: [
      { id: 'custom-model', name: 'Custom Model', tags: ['自定义兼容'], enabled: true },
    ],
  },
]

/**
 * 多维过滤供应商列表：
 * 匹配关键字（供应商名称、ID、描述或包含的模型 ID/名称）。
 */
export function filterProviders(
  providers: ProviderItem[],
  options: FilterProvidersOptions,
): ProviderItem[] {
  const term = (options.query ?? '').trim().toLowerCase()

  return providers.filter((provider) => {
    // 搜索词匹配
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
 * - 仅列出目录中可用且未被用户禁用的模型；
 * - 当前值不在可选列表（凭据失效/外部模型/已禁用）时保留并标注「目录外」或「已禁用」，
 *   不静默丢失；标注项不重复添加。
 */
export function buildDefaultModelOptions(
  models: ModelDescriptor[],
  currentValue?: string,
): Array<{ value: string; label: string; meta?: string }> {
  const options: Array<{ value: string; label: string; meta?: string }> = [
    { value: UNSET_MODEL_VALUE, label: '未设置（继承系统基线）' },
  ]

  for (const m of models) {
    if (!m.available || m.disabled === true) continue
    options.push({
      value: m.id,
      label: m.label || m.modelId,
      meta: m.provider,
    })
  }

  // 若当前配置的模型不在可选列表中（如历史配置、已删除提供商、凭据未配或被禁用），
  // 保留为首选显示项防静默丢失；已禁用单独标注（与目录外区分，提示需重新启用）。
  const trimmed = currentValue?.trim()
  if (
    trimmed &&
    trimmed !== UNSET_MODEL_VALUE &&
    !options.some((opt) => opt.value === trimmed)
  ) {
    const disabled = models.some((m) => m.id === trimmed && m.disabled === true)
    options.push({
      value: trimmed,
      label: disabled ? `${trimmed}（已禁用）` : `${trimmed}（当前配置）`,
      meta: disabled ? '已禁用' : '目录外',
    })
  }

  return options
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
        configured: Boolean(gw.enabled),
        modelsCount: 0,
        baseUrl: gw.baseUrl,
        custom: true,
        description: '运行时动态注册的模型网关。',
      })
    }
  }

  // 4. 校准凭据状态与模型数量（以 credentials 与实时目录为准）
  for (const [key, p] of providerMap.entries()) {
    const remoteModels = modelsByProvider.get(key)
    const isConfiguredByKey = configuredIds.has(key)
    const hasAvailableModel = Boolean(remoteModels && remoteModels.some((m) => m.available))
    p.configured = Boolean(p.configured || isConfiguredByKey || hasAvailableModel)

    // 5. 聚合实时目录模型并更新模型数量。勾选态是「路由启用」：仅由 disabled
    //    决定，与凭据可用性（available）解耦——否则未配凭据的供应商填写密钥
    //    保存时会把全部模型误写成禁用；available 供模型选择器/默认模型选项过滤。
    if (remoteModels && remoteModels.length > 0) {
      p.modelsCount = remoteModels.length
      p.models = remoteModels.map((m) => ({
        id: m.modelId,
        name: m.label || m.modelId,
        enabled: m.disabled !== true,
        tags: m.thinkingLevels && m.thinkingLevels.length > 1 ? ['思考模型'] : undefined,
      }))
    }
  }

  // 6. 排序：已配置优先，其次按名称字母升序
  return Array.from(providerMap.values()).sort(
    (a, b) =>
      Number(b.configured) - Number(a.configured) ||
      a.name.localeCompare(b.name),
  )
}
