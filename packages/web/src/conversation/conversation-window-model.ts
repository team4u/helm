/**
 * Conversation window keep-alive model (pure module: constants, pure functions, context — no
 * components, honoring the Fast Refresh split):
 *
 * - The primary pane keeps a bounded LRU set of mounted conversation windows. Switching the
 *   primary conversation only flips each window's <Activity> mode, so timeline scroll offsets,
 *   composer drafts and other component-local state survive navigation; windows beyond the
 *   capacity (or whose conversation was deleted) unmount for real and re-initialize on reopen.
 * - The module also carries the Activity-hide dirty-draft bridge: react-dom destroys effects
 *   inside a hidden Activity subtree, which would clear a Composer's composer-dirty report
 *   while its draft still lives in component state. The owning window frame (outside the
 *   Activity boundary) re-publishes the last visible snapshot for as long as the window stays
 *   hidden, so version auto-refresh never mistakes a kept-alive draft for a cleared one.
 */
import { createContext, useContext } from 'react'
import type { ComposerDirtySnapshot } from './composer-dirty.js'

/** One kept-alive conversation window slot in the primary stage. */
export interface ConversationWindowEntry {
  conversationId: number
  /** Monotonic activation counter; larger means used more recently. */
  lastUsedAt: number
}

/** Default keep-alive capacity for the primary conversation window pool. */
export const DEFAULT_CONVERSATION_WINDOW_LIMIT = 10

/**
 * Insert or refresh the active window and evict least-recently-used overflow. The active
 * window is never evicted; render order stays insertion-stable so React never reorders DOM
 * nodes of surviving windows. Returns a new list (call sites run this only on activation).
 */
export function touchConversationWindows(
  windows: ReadonlyArray<ConversationWindowEntry>,
  activeConversationId: number,
  limit: number,
): Array<ConversationWindowEntry> {
  const now = (windows.length > 0 ? Math.max(...windows.map((w) => w.lastUsedAt)) : 0) + 1
  const next = windows.some((w) => w.conversationId === activeConversationId)
    ? windows.map((w) => (w.conversationId === activeConversationId ? { ...w, lastUsedAt: now } : w))
    : [...windows, { conversationId: activeConversationId, lastUsedAt: now }]
  while (next.length > limit) {
    let victimIndex = -1
    for (let i = 0; i < next.length; i++) {
      if (next[i]!.conversationId === activeConversationId) continue
      if (victimIndex === -1 || next[i]!.lastUsedAt < next[victimIndex]!.lastUsedAt) victimIndex = i
    }
    if (victimIndex === -1) break // Only active windows left: overflow stays mounted.
    next.splice(victimIndex, 1)
  }
  return next
}

/**
 * Drop windows whose conversation no longer exists. Returns the same reference when nothing
 * changes so the caller's setState bails out (this runs on every conversations snapshot
 * update).
 */
export function pruneConversationWindows(
  windows: ReadonlyArray<ConversationWindowEntry>,
  existingIds: ReadonlySet<number>,
): ReadonlyArray<ConversationWindowEntry> {
  const kept = windows.filter((w) => existingIds.has(w.conversationId))
  return kept.length === windows.length ? windows : kept
}

/**
 * Mutable per-window sink the mounted Composer writes its latest dirty snapshot into. The
 * frame reads it when hiding; `publish` lets async completion while hidden push updated state
 * back to the frame without waiting for wake. Plain ref object, stable identity per window.
 */
export type ConversationDirtySink = {
  current: ComposerDirtySnapshot | null
  publish?: (snapshot: ComposerDirtySnapshot) => void
}

/** Null outside a keep-alive window (split panes, drawers keep their standalone behavior). */
export const ConversationDirtySinkContext = createContext<ConversationDirtySink | null>(null)

export function useConversationDirtySink(): ConversationDirtySink | null {
  return useContext(ConversationDirtySinkContext)
}
