/**
 * 插件中心纯函数模型与分类过滤
 *
 * 提供插件分类推导、多维检索（名称/ID/工具/动作）、状态筛选及指标统计。
 */
import type { PluginSummary } from '@helm/protocol'

export type PluginStatusFilter = 'all' | 'enabled' | 'disabled'
export type PluginCategory = 'all' | 'builtin' | 'orchestration' | 'tools' | 'external'
export type PluginCategoryTab =
  | 'all'
  | 'runtime'
  | 'tools'
  | 'orchestration'
  | 'system'
  | 'enabled'

export interface PluginFilterState {
  query: string
  status?: PluginStatusFilter
  category?: PluginCategory
  categoryTab?: PluginCategoryTab
}

export interface PluginSummaryStats {
  total: number
  enabled: number
  disabled: number
  failed: number
  totalTools: number
  totalActions: number
}

export interface PluginCategoryCounts {
  all: number
  runtime: number
  tools: number
  orchestration: number
  system: number
  enabled: number
  builtin?: number
  external?: number
}

/**
 * 根据插件 ID 推导其业务类别
 *
 * - orchestration: 协同编排类（如 builtin:workflow, builtin:herdr, builtin:superagent）
 * - tools: 工具扩展类（如 builtin:tools, tools:*）
 * - builtin: 核心系统内置插件（如 builtin:profile, builtin:triggers）
 * - external: 外部三方及社区自定义插件
 */
export function derivePluginCategory(id: string): PluginCategory {
  const normalized = (id ?? '').trim().toLowerCase()
  if (
    normalized === 'builtin:workflow' ||
    normalized === 'builtin:herdr' ||
    normalized === 'builtin:superagent' ||
    normalized === 'workflow' ||
    normalized === 'herdr' ||
    normalized === 'superagent'
  ) {
    return 'orchestration'
  }
  if (
    normalized === 'builtin:tools' ||
    normalized === 'tools' ||
    normalized.startsWith('tool:') ||
    normalized.startsWith('tools:')
  ) {
    return 'tools'
  }
  if (normalized.startsWith('builtin:')) {
    return 'builtin'
  }
  return 'external'
}

/**
 * 判断插件是否属于指定的分类药丸标签
 */
export function isPluginInTab(plugin: PluginSummary, tab: PluginCategoryTab): boolean {
  if (tab === 'all') return true
  if (tab === 'enabled') return Boolean(plugin.enabled)
  const id = (plugin.id ?? '').toLowerCase()
  const category = derivePluginCategory(plugin.id)

  if (tab === 'orchestration') {
    return category === 'orchestration'
  }
  if (tab === 'runtime') {
    return (
      id.includes('herdr') ||
      id.includes('runtime') ||
      id.includes('node') ||
      id.includes('sandbox') ||
      (plugin.actions ?? []).some((a) => a.includes('bridge') || a.includes('exec') || a.includes('node'))
    )
  }
  if (tab === 'tools') {
    return category === 'tools' || (plugin.tools?.length ?? 0) > 0
  }
  if (tab === 'system') {
    return category === 'builtin' && !id.includes('herdr')
  }
  return false
}

/**
 * 计算多维分类标签与状态的数量徽章统计
 */
export function buildCategoryCounts(plugins: PluginSummary[]): PluginCategoryCounts {
  const list = Array.isArray(plugins) ? plugins : []
  let enabled = 0
  let runtime = 0
  let tools = 0
  let orchestration = 0
  let system = 0
  let builtin = 0
  let external = 0

  for (const p of list) {
    if (p.enabled) enabled++
    if (isPluginInTab(p, 'runtime')) runtime++
    if (isPluginInTab(p, 'tools')) tools++
    if (isPluginInTab(p, 'orchestration')) orchestration++
    if (isPluginInTab(p, 'system')) system++
    const cat = derivePluginCategory(p.id)
    if (cat === 'builtin') builtin++
    if (cat === 'external') external++
  }

  return {
    all: list.length,
    runtime,
    tools,
    orchestration,
    system,
    enabled,
    builtin,
    external,
  }
}

/**
 * 判定插件是否处于故障态：
 * - status === 'failed'（宿主显式标记加载或启用失败）；
 * - 或携带结构化诊断错误（error !== undefined，兼容旧内核未填 status 的降级诊断）。
 */
export function isPluginFailed(plugin: PluginSummary): boolean {
  return plugin.status === 'failed' || plugin.error !== undefined
}

/**
 * 按多维条件过滤插件列表（纯函数，返回新数组，不修改原数组）
 */
export function filterPlugins(plugins: PluginSummary[], filter: PluginFilterState): PluginSummary[] {
  if (!Array.isArray(plugins)) return []
  const query = filter.query?.trim().toLowerCase() ?? ''
  const status = filter.status ?? 'all'
  const category = filter.category ?? 'all'
  const categoryTab = filter.categoryTab ?? 'all'

  return plugins.filter((plugin) => {
    // 1. 状态筛选
    if (status === 'enabled' && !plugin.enabled) return false
    if (status === 'disabled' && plugin.enabled) return false

    // 2. 分类筛选
    if (category !== 'all') {
      const pluginCategory = derivePluginCategory(plugin.id)
      if (pluginCategory !== category) return false
    }

    // 3. 药丸标签分类筛选
    if (categoryTab !== 'all') {
      if (!isPluginInTab(plugin, categoryTab)) return false
    }

    // 4. 关键字搜索匹配（name / id / tools / actions）
    if (query) {
      const matchName = (plugin.name ?? '').toLowerCase().includes(query)
      const matchId = (plugin.id ?? '').toLowerCase().includes(query)
      const matchTools = (plugin.tools ?? []).some((tool) => (tool ?? '').toLowerCase().includes(query))
      const matchActions = (plugin.actions ?? []).some((action) => (action ?? '').toLowerCase().includes(query))
      if (!matchName && !matchId && !matchTools && !matchActions) {
        return false
      }
    }

    return true
  })
}

/**
 * 汇总插件列表统计指标
 */
export function summarizePlugins(plugins: PluginSummary[]): PluginSummaryStats {
  if (!Array.isArray(plugins)) {
    return {
      total: 0,
      enabled: 0,
      disabled: 0,
      failed: 0,
      totalTools: 0,
      totalActions: 0,
    }
  }

  let enabled = 0
  let disabled = 0
  let failed = 0
  let totalTools = 0
  let totalActions = 0

  for (const plugin of plugins) {
    if (plugin.enabled) {
      enabled++
    } else {
      disabled++
    }
    if (isPluginFailed(plugin)) failed++
    totalTools += plugin.tools?.length ?? 0
    totalActions += plugin.actions?.length ?? 0
  }

  return {
    total: plugins.length,
    enabled,
    disabled,
    failed,
    totalTools,
    totalActions,
  }
}
