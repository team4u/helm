/**
 * Local draft-dirty bridging for the conversation Composer (a module-level
 * external store, no components):
 *
 * - The single source of truth stays useComposerSend's React state (text /
 *   edit anchor / attachments / send & upload in flight); this bridge only
 * aggregates the one boolean fact of "unsubmitted local state exists" for the
 * version auto-refresh pending check (use-version-watcher) to subscribe to —
 * no parallel draft system is introduced;
 * - The reporting key is a per-component-instance identifier (React useId):
 * the primary panel / split / drawer may render a Composer for the same
 * conversation simultaneously; instance keys prevent mutual overwrites;
 * unmount clears the report;
 * - Listener callbacks fire only when the aggregated boolean flips
 * (getSnapshot is a primitive, naturally stable).
 */
export interface ComposerDirtySnapshot {
  /** Draft text is non-empty (same trim semantics as sending). */
  hasDraftText: boolean
  /** A history-edit anchor is held (the edit target is not yet persisted). */
  editingEntry: boolean
  /** Pending attachments are held. */
  hasAttachments: boolean
  /** A send or attachment upload is in flight. */
  busy: boolean
}

const reports = new Map<string, ComposerDirtySnapshot>()
const listeners = new Set<() => void>()

function notifyIfChanged(before: boolean): void {
  if (composerDirty() !== before) {
    for (const listener of listeners) listener()
  }
}

/** Aggregate verdict: any mounted Composer carries unsubmitted local state. */
export function composerDirty(): boolean {
  for (const snapshot of reports.values()) {
    if (isComposerDirtySnapshot(snapshot)) return true
  }
  return false
}

/** Pure function: whether a single snapshot carries unsubmitted local state. */
export function isComposerDirtySnapshot(snapshot: ComposerDirtySnapshot): boolean {
  return snapshot.hasDraftText || snapshot.editingEntry || snapshot.hasAttachments || snapshot.busy
}

/** Report (or update) one Composer instance's dirty snapshot. */
export function setComposerDirty(key: string, snapshot: ComposerDirtySnapshot): void {
  const before = composerDirty()
  reports.set(key, snapshot)
  notifyIfChanged(before)
}

/** Clear one Composer instance's report (component unmount). */
export function clearComposerDirty(key: string): void {
  if (!reports.has(key)) return
  const before = composerDirty()
  reports.delete(key)
  notifyIfChanged(before)
}

/** Subscribe to aggregated dirty-state changes (getSnapshot uses composerDirty). */
export function subscribeComposerDirty(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
