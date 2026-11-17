import type { ActiveModal } from '../lib/types.js'

/**
 * Pure functions deciding the selected item of the list modals
 * (Profiles / Skills / Plugins / Nodes) from three sources:
 * - External deep links (URL back/forward, prop changes): follow locally but
 *   never write back to the store — the change source already IS the
 *   store/URL, so writing back loops (and would overwrite the item the user
 *   just navigated to with the stale selectedId);
 * - List fallback (assets arriving async / selected item invalidated): switch
 *   to the first item only when the list is non-empty and the current
 *   selection is invalid; a local decision that must write back through the
 *   guard;
 * - User click (select* events): a local decision, written back through the
 *   guard.
 * Guard rule: write back only while activeModal is still this modal kind, so
 * a modal that already switched kind or closed can never be pulled open
 * again by a stale write.
 */
export type ListModalKind = 'profile-editor' | 'skill-viewer' | 'plugin-settings' | 'nodes'

/** The id an external deep-link change should switch to; null means keep (unset / echo of the current value). */
export function deepLinkSelection(current: string | null, incoming: string | undefined): string | null {
  if (incoming === undefined || incoming === '') return null
  if (incoming === current) return null
  return incoming
}

/** The id the list fallback should switch to; null means keep (current valid, or empty list never overrides the deep-link selection). */
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

/** Guard for writing a local selection back to the store: never write when the modal switched kind or closed (anti-reopen loop). */
export function shouldSyncSelectionToStore(activeModal: ActiveModal, ownKind: ListModalKind, nextId: string): boolean {
  if (activeModal === null || activeModal.kind !== ownKind) return false
  return subIdOf(activeModal) !== nextId
}

/** Guard clearing the deep-link sub id when entering create-new mode (only while the modal is still this kind). */
export function shouldClearSelectionInStore(activeModal: ActiveModal, ownKind: ListModalKind): boolean {
  return activeModal !== null && activeModal.kind === ownKind && subIdOf(activeModal) !== undefined
}
