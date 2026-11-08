import type { ActiveModal } from '../lib/types.js'

/**
 * 列表型弹窗（Profiles / Skills / Plugins / Nodes）选中项的三源决策纯函数：
 * - 外部深链（URL 前进后退 / props 变化）：本地跟随，但不写回 store——变更源头
 *   就是 store/URL，写回即回环（还会用旧 selectedId 覆盖用户刚导航到的条目）；
 * - 列表兜底（资产异步到达 / 选中项失效）：仅列表非空且当前选中无效时切首项，
 *   属本地决策，需经守卫写回 store；
 * - 用户点选（select* 事件）：本地决策，经守卫写回。
 * 守卫规则：仅当 activeModal 仍是本弹窗类型时才允许写回，杜绝弹窗已切换类型或
 * 已关闭时把旧弹窗重新拉开的回环。
 */
export type ListModalKind = 'profile-editor' | 'skill-viewer' | 'plugin-settings' | 'nodes'

/** 外部深链变化应切换到的 id；null 表示保持不动（无指定 / 与当前一致即回声）。 */
export function deepLinkSelection(current: string | null, incoming: string | undefined): string | null {
  if (incoming === undefined || incoming === '') return null
  if (incoming === current) return null
  return incoming
}

/** 列表兜底应切换到的 id；null 表示保持不动（当前有效，或列表为空不覆盖深链选中）。 */
export function fallbackSelection(current: string | null, listIds: readonly string[]): string | null {
  if (current !== null && listIds.includes(current)) return null
  if (listIds.length === 0) return null
  const next = listIds[0] ?? null
  return next !== null && next !== current ? next : null
}

const subIdOf = (modal: Exclude<ActiveModal, null>): string | undefined => {
  switch (modal.kind) {
    case 'profile-editor': return modal.profileId
    case 'skill-viewer': return modal.skillId
    case 'plugin-settings': return modal.pluginId
    case 'nodes': return modal.nodeId
    default: return undefined
  }
}

/** 本地选中写回 store 的守卫：弹窗已切换类型或已关闭时绝不写回（防重开回环）。 */
export function shouldSyncSelectionToStore(activeModal: ActiveModal, ownKind: ListModalKind, nextId: string): boolean {
  if (activeModal === null || activeModal.kind !== ownKind) return false
  return subIdOf(activeModal) !== nextId
}

/** 进入新建模式时清掉深链子项 id 的守卫（仅弹窗仍是本类型时才需要清）。 */
export function shouldClearSelectionInStore(activeModal: ActiveModal, ownKind: ListModalKind): boolean {
  return activeModal !== null && activeModal.kind === ownKind && subIdOf(activeModal) !== undefined
}
