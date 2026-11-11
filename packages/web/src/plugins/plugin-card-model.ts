/**
 * 插件描述裁决纯函数（无组件，供 PluginCard / PluginDetailDrawer 共用）。
 *
 * - 优先展示插件定义自带的 description（summaryOf 透传，外部插件同样生效）；
 * - 未声明时依据能力透视生成（tools/actions/hooks 计数），不按插件 ID
 *   硬编码任何业务特判——描述是插件自己的事，前端只负责展示。
 */
import type { PluginSummary } from '@helm/protocol'

export function getPluginDescription(plugin: PluginSummary): string {
  if (plugin.description && plugin.description.trim() !== '') {
    return plugin.description
  }

  const toolCount = plugin.tools?.length ?? 0
  const actionCount = plugin.actions?.length ?? 0
  const hookCount = plugin.hooks?.length ?? 0

  if (toolCount > 0 || actionCount > 0 || hookCount > 0) {
    const parts: string[] = []
    if (toolCount > 0) parts.push(`${toolCount} 个工具`)
    if (actionCount > 0) parts.push(`${actionCount} 个动作`)
    if (hookCount > 0) parts.push(`${hookCount} 个钩子`)
    return `提供 ${parts.join('、')}能力支持。`
  }

  return '系统扩展插件组件。'
}

/** 故障阶段面向用户的可读文案（PluginDiagnosticError.stage）。 */
export const PLUGIN_ERROR_STAGE_LABELS: Record<string, string> = {
  scan: '清单/入口解析（scan）',
  load: '模块加载（load）',
  define: '定义注册（define）',
  enable: '启用激活（enable）',
}

export function pluginErrorStageLabel(stage?: string): string {
  return (stage !== undefined && PLUGIN_ERROR_STAGE_LABELS[stage]) || '未知阶段'
}

/** 409 plugin_in_use 错误 details.usages 中的占用项形状。 */
export interface PluginUsageItem {
  kind: string
  id: string
  label: string
}

/**
 * 从 ApiClientError（409 plugin_in_use）的 details.usages 提取占用清单；
 * 形状非法时返回空数组（由调用方回退到原始错误文案展示）。
 */
export function extractPluginUsages(details?: Record<string, unknown>): PluginUsageItem[] {
  const raw = details?.['usages']
  if (!Array.isArray(raw)) return []
  const items: PluginUsageItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record['kind'] !== 'string' || typeof record['id'] !== 'string') continue
    const label = typeof record['label'] === 'string' ? record['label'] : record['id']
    items.push({ kind: record['kind'], id: record['id'], label })
  }
  return items
}
