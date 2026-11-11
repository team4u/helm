/**
 * 插件中心纯函数模型与检索过滤
 *
 * 提供多维检索（名称/ID/工具/动作）、状态筛选及指标统计。
 * 遵循前端规范：纯属性驱动，零 ID 硬编码猜测。
 */
import type { PluginSummary } from '@helm/protocol'

export type PluginStatusFilter = 'all' | 'enabled' | 'disabled'

export interface PluginFilterState {
  query?: string
  status?: PluginStatusFilter
}

export interface PluginSummaryStats {
  total: number
  enabled: number
  disabled: number
  failed: number
  totalTools: number
  totalActions: number
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

  return plugins.filter((plugin) => {
    // 1. 状态筛选
    if (status === 'enabled' && !plugin.enabled) return false
    if (status === 'disabled' && plugin.enabled) return false

    // 2. 关键字搜索匹配（name / id / tools / actions）
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
