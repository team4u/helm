/**
 * PluginSlot pure logic: contribution matching plus stable ordering (no
 * component exports; directly unit-testable).
 *
 * Ordering rule: priority desc -> order asc -> contribution order (the array
 * order inside groupedUi.pluginSlots, first registered wins); the three keys
 * compose into a single stable sort.
 */
import type { ConversationScope, PluginSlotContributionSpec } from '@helmx/protocol/browser'
import type { QualifiedUiSpec } from '../lib/types.js'

export type SlotContribution = QualifiedUiSpec<PluginSlotContributionSpec>

/** Format check for the fully qualified slot name '<ownerPluginId>/<slotName>' (exactly one '/'). */
export function isValidSlotTarget(target: string): boolean {
  const slash = target.indexOf('/')
  return slash > 0 && slash < target.length - 1 && target.indexOf('/', slash + 1) < 0
}

/**
 * Collect contributions hitting the target slot: exact target match + scope
 * filter + stable ordering. The caller binds scopeFilter to the current
 * conversation (matchesUiScope); without conversation context only
 * contributions without a scope declaration hit (same semantics as the
 * conversation-scoped UI extension points).
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
  // Stable ordering: priority desc, order asc (default 100), ties keep contribution order
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
