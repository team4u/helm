/**
 * 插件描述与图标裁决纯函数（无组件，供 PluginCard / PluginDetailDrawer 共用）。
 *
 * - 优先展示插件定义自带的 description 与 icon（summaryOf 透传，外部插件同样生效）；
 * - 未声明描述时依据能力透视生成（tools/actions/hooks 计数），未声明图标时回退
 *   系统默认占位图标（DEFAULT_PLUGIN_ICON: 'puzzle'）；
 * - 不按插件 ID 硬编码任何业务特判——属性是插件自己的事，前端只负责展示。
 */
import type { PluginSummary, ScreenSpec } from '@helm/protocol'
import type { GroupedUiSpecs } from '../lib/types.js'

/** 插件中心默认占位图标（当插件未显式提供 icon 时使用）。 */
export const DEFAULT_PLUGIN_ICON = 'puzzle'

/**
 * 插件线性矢量图标名称裁决：
 * - 纯数据属性驱动，零 ID 字符串硬编码推测；
 * - 优先展示插件定义自带声明的 icon（无论内置插件或外部插件，均在自身 PluginDefinition.icon 中显式声明）；
 * - 若未提供 icon，统一展示系统默认占位图标（DEFAULT_PLUGIN_ICON: 'puzzle'）。
 */
export function resolvePluginIcon(plugin?: Pick<PluginSummary, 'icon'> | null): string {
  if (plugin && typeof plugin.icon === 'string' && plugin.icon.trim() !== '') {
    return plugin.icon.trim()
  }
  return DEFAULT_PLUGIN_ICON
}

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

// ---------------------------------------------------------------------------
// 插件 ↔ Screen 关联（PluginSummary 不携带 screens，从 grouped UI 左连接）
// ---------------------------------------------------------------------------

export interface PluginScreenRef {
  pluginId: string
  screenId: string
  spec: ScreenSpec
}

/** 取某插件的全部 Screen 贡献（按 grouped UI 注册顺序）。 */
export function listPluginScreens(
  grouped: Pick<GroupedUiSpecs, 'screens'>,
  pluginId: string,
): PluginScreenRef[] {
  return grouped.screens
    .filter((item) => item.pluginId === pluginId)
    .map((item) => ({ pluginId: item.pluginId, screenId: item.spec.id, spec: item.spec }))
}

/** 插件是否具备可打开的主视图（enabled 且至少声明一个 Screen 贡献）。 */
export function pluginHasOpenableScreen(
  grouped: Pick<GroupedUiSpecs, 'screens'>,
  plugin: Pick<PluginSummary, 'id' | 'enabled'>,
): boolean {
  return plugin.enabled && listPluginScreens(grouped, plugin.id).length > 0
}
