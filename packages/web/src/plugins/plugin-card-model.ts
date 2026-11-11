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
