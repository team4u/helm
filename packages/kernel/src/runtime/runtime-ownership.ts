/**
 * RuntimeOwnershipManager: conversation ownership right and plugin conversation manage right maintain (from KernelRuntime split out).
 *
 * responsibility:
 * - conversation ownership right decide and durable mark record (getOwnership, markOwnership);
 * - plugin conversation manage right hold has and release (manage, release);
 * - ownership change throw shoot conversation.upsert event.
 */

import type { ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { EventHub } from './events.js'
import type { HelmStore } from './store.js'

export type ConversationOwnership = 'helm' | 'bot' | 'human'

export interface RuntimeOwnershipDeps {
  readonly store: HelmStore
  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
  }
  readonly events: EventHub
  readonly conversations: { summaryWithOwnership(id: number): ConversationSummary }
}

export class RuntimeOwnershipManager {
  /** conversation plugin manage right:conversationId -> hold has pluginId set (delete protect). */
  readonly managedConversations = new Map<number, Set<string>>()

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  /**
   * conversation ownership right now read (Watchdog hard rule decide unique can message source):
   * - conversation missing (contains deleted tombstone) when throw not_found;
   * - not mark record/mark record illegal value one rule human(rather leak manage do not exceeds right).
   */
  getOwnership(conversationId: number): ConversationOwnership {
    const meta = this.deps.store.getConv(conversationId)
    if (meta === undefined || this.deps.store.isDeleted(conversationId)) {
      throw new HelmError('not_found', `conversation missing:${conversationId}`, 404, { conversationId })
    }
    const owners = this.deps.documentStore.get<Record<string, string>>('conversation-ownership', {})
    const marked = owners[String(conversationId)]
    return marked === 'helm' || marked === 'bot' ? marked : 'human'
  }

  /**
   * conversation ownership right mark record (Watchdog hard rule decide unique can message source):
   * - independent of user can change tags/parent push assert; not mark record one rule treated as human;
   * - persist at global doc('conversation-ownership'), restart keep.
   */
  markOwnership(conversationId: number, owner: ConversationOwnership): void {
    const key = 'conversation-ownership'
    const current = this.deps.documentStore.get<Record<string, string>>(key, {})
    const previous = current[String(conversationId)]
    const previousEffective = previous === 'helm' || previous === 'bot' ? previous : 'human'
    if (previousEffective === owner) return
    const next = owner === 'human'
      ? (() => {
          const { [String(conversationId)]: _removed, ...rest } = current
          void _removed
          return rest
        })()
      : { ...current, [String(conversationId)]: owner }
    this.deps.documentStore.set(key, next)
    if (this.deps.store.getConv(conversationId) === undefined || this.deps.store.isDeleted(conversationId)) return
    this.deps.events.publish('conversation.upsert', this.deps.conversations.summaryWithOwnership(conversationId))
  }

  /**
   * plugin conversation manage right (delete protect): only enabled plugin can hold has; return release function.
   */
  manage(conversationId: number, pluginId: string): () => void {
    let owners = this.managedConversations.get(conversationId)
    if (owners === undefined) {
      owners = new Set()
      this.managedConversations.set(conversationId, owners)
    }
    owners.add(pluginId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(conversationId, pluginId)
    }
  }

  release(conversationId: number, pluginId: string): void {
    const owners = this.managedConversations.get(conversationId)
    if (!owners) return
    owners.delete(pluginId)
    if (owners.size === 0) this.managedConversations.delete(conversationId)
  }
}
