/**
 * Pure public-doc data models for the builtin:swarm client components (zero
 * React/DOM exports, Fast Refresh compliant).
 *
 * Parsing is lenient at the client boundary: a not-yet-arrived doc (undefined)
 * resolves to empty lists without fabricating placeholder data.
 */
import type { ConversationSummary } from '@helmx/protocol'
import type { CollabGroupSummary } from './board-model.ts'

/**
 * Fully-qualified workbench panel target for swarm client components.
 * Locked by tests to the panel id registered in `swarm/ui.ts` ('groups').
 */
export const SWARM_WORKBENCH_PANEL_TARGET = 'plugin:builtin:swarm/groups' as const

/** Lightweight active worker pointer in public doc 'index'. */
export interface SwarmIndexWorkerItem {
  conversationId: number
  coordinatorConversationId: number
  parentConversationId?: number
  profileId: string
  groupId: string
  name: string
  createdAt: number
}

/** Public doc 'index' projected by builtin:swarm. */
export interface SwarmIndexDoc {
  version?: 1
  workers?: SwarmIndexWorkerItem[]
  groups?: CollabGroupSummary[]
}

/** Build a lookup map from conversation id to summary (over live useConversations()). */
export function buildConversationMap(
  conversations: ReadonlyArray<ConversationSummary>,
): Map<number, ConversationSummary> {
  const map = new Map<number, ConversationSummary>()
  for (const c of conversations) {
    map.set(c.id, c)
  }
  return map
}
