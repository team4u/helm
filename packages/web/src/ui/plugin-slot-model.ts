/**
 * PluginSlot 纯逻辑：贡献项匹配与稳定排序（无组件导出，供单测直接验证）。
 *
 * 排序规则：priority 降序 -> order 升序 -> 贡献顺序（groupedUi.pluginSlots
 * 的数组序，先注册先命中）；三者合成一次稳定排序。
 */
import type { ConversationScope, PluginSlotContributionSpec } from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'

export type SlotContribution = QualifiedUiSpec<PluginSlotContributionSpec>

/** 全限定插槽名 '<ownerPluginId>/<slotName>' 的格式校验（恰一个 '/'）。 */
export function isValidSlotTarget(target: string): boolean {
  const slash = target.indexOf('/')
  return slash > 0 && slash < target.length - 1 && target.indexOf('/', slash + 1) < 0
}

/**
 * 收集命中目标插槽的贡献项：target 全等匹配 + scope 过滤 + 稳定排序。
 * scopeFilter 由调用方绑定当前会话（matchesUiScope）；无会话上下文时仅
 * 无 scope 声明的贡献项命中（与会话级 UI 扩展点同一语义）。
 */
export function collectSlotItems(
  contributions: ReadonlyArray<SlotContribution>,
  qualifiedName: string,
  scopeFilter: (scope: ConversationScope | undefined) => boolean,
): SlotContribution[] {
  const matched: SlotContribution[] = []
  for (const item of contributions) {
    if (item.spec.target !== qualifiedName) continue
    if (!scopeFilter(item.spec.scope)) continue
    matched.push(item)
  }
  // 稳定排序：priority 降序、order 升序（缺省 100），同分保持贡献顺序
  return matched
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (b.item.spec.priority ?? 0) - (a.item.spec.priority ?? 0) ||
        (a.item.spec.order ?? 100) - (b.item.spec.order ?? 100) ||
        a.index - b.index,
    )
    .map((entry) => entry.item)
}
