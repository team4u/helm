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

export interface ComposerDirtySummary {
  readonly anyDirty: boolean
  readonly conversationIds: ReadonlyArray<number>
  readonly hasUnscopedDirty: boolean
}

export const EMPTY_COMPOSER_DIRTY_SUMMARY: ComposerDirtySummary = {
  anyDirty: false,
  conversationIds: [],
  hasUnscopedDirty: false,
}

interface ComposerDirtyReport {
  snapshot: ComposerDirtySnapshot
  conversationId?: number
}

const reports = new Map<string, ComposerDirtyReport>()
const listeners = new Set<() => void>()
let cachedSummary: ComposerDirtySummary = EMPTY_COMPOSER_DIRTY_SUMMARY

function computeSummary(): ComposerDirtySummary {
  const idSet = new Set<number>()
  let anyDirty = false
  let hasUnscopedDirty = false
  for (const report of reports.values()) {
    if (!isComposerDirtySnapshot(report.snapshot)) continue
    anyDirty = true
    if (report.conversationId !== undefined) idSet.add(report.conversationId)
    else hasUnscopedDirty = true
  }
  if (!anyDirty) return EMPTY_COMPOSER_DIRTY_SUMMARY
  return {
    anyDirty,
    conversationIds: Array.from(idSet).sort((a, b) => a - b),
    hasUnscopedDirty,
  }
}

function sameSummary(a: ComposerDirtySummary, b: ComposerDirtySummary): boolean {
  if (a.anyDirty !== b.anyDirty || a.hasUnscopedDirty !== b.hasUnscopedDirty) return false
  if (a.conversationIds.length !== b.conversationIds.length) return false
  for (let i = 0; i < a.conversationIds.length; i++) {
    if (a.conversationIds[i] !== b.conversationIds[i]) return false
  }
  return true
}

function syncSummaryAndNotify(): void {
  const next = computeSummary()
  if (sameSummary(cachedSummary, next)) return
  cachedSummary = next
  for (const listener of listeners) listener()
}

/** Aggregate verdict: any mounted Composer carries unsubmitted local state. */
export function composerDirty(): boolean {
  return cachedSummary.anyDirty
}

/** Referentially stable summary of dirty Composer instances (for useSyncExternalStore). */
export function getComposerDirtySummary(): ComposerDirtySummary {
  return cachedSummary
}

/** Pure function: whether a single snapshot carries unsubmitted local state. */
export function isComposerDirtySnapshot(snapshot: ComposerDirtySnapshot): boolean {
  return snapshot.hasDraftText || snapshot.editingEntry || snapshot.hasAttachments || snapshot.busy
}

/** Report (or update) one Composer instance's dirty snapshot. */
export function setComposerDirty(key: string, snapshot: ComposerDirtySnapshot, conversationId?: number): void {
  reports.set(key, conversationId !== undefined ? { snapshot, conversationId } : { snapshot })
  syncSummaryAndNotify()
}

/** Clear one Composer instance's report (component unmount). */
export function clearComposerDirty(key: string): void {
  if (!reports.has(key)) return
  reports.delete(key)
  syncSummaryAndNotify()
}

/** Subscribe to aggregated dirty-state changes (getSnapshot uses composerDirty). */
export function subscribeComposerDirty(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
