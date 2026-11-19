/**
 * RuntimeOwnershipManager: conversation ownership and plugin management locks (extracted from KernelRuntime).
 *
 * Responsibilities:
 * - Resolve and persistently record conversation ownership (getOwnership, markOwnership);
 * - Acquire and release plugin conversation management locks (manage, release);
 * - Emit conversation.upsert events when ownership changes.
 */

import type { ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { EventHub } from './events.js'
import type { HelmxStore } from './store.js'

export type ConversationOwnership = 'helmx' | 'bot' | 'human'

interface RuntimeOwnershipDeps {
  readonly store: HelmxStore
  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
  }
  readonly events: EventHub
  readonly conversations: { summaryWithOwnership(id: number): ConversationSummary }
}

export class RuntimeOwnershipManager {
  /** Plugin management locks per conversation: conversationId -> holding pluginIds (protects against deletion). */
  readonly managedConversations = new Map<number, Set<string>>()

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  /**
   * Look up current conversation ownership (single authoritative source for Watchdog invariants):
   * - Missing or tombstoned conversations throw not_found;
   * - Unset or unrecognized marks default to 'human' (fail-safe: better to skip automation than act on human conversations).
   */
  getOwnership(conversationId: number): ConversationOwnership {
    const meta = this.deps.store.getConv(conversationId)
    if (meta === undefined || this.deps.store.isDeleted(conversationId)) {
      throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404, { conversationId })
    }
    const owners = this.deps.documentStore.get<Record<string, string>>('conversation-ownership', {})
    const marked = owners[String(conversationId)]
    return marked === 'helmx' || marked === 'bot' ? marked : 'human'
  }

  /**
   * Record conversation ownership (single authoritative source for Watchdog invariants):
   * - Independent of user-editable tags/parent derivation; unmarked defaults to 'human';
   * - Persisted in global doc 'conversation-ownership' across restarts.
   */
  markOwnership(conversationId: number, owner: ConversationOwnership): void {
    const key = 'conversation-ownership'
    const current = this.deps.documentStore.get<Record<string, string>>(key, {})
    const previous = current[String(conversationId)]
    const previousEffective = previous === 'helmx' || previous === 'bot' ? previous : 'human'
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
   * Acquire a plugin management lock on a conversation (protects against deletion): only enabled plugins should hold
   * one; returns a release callback.
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
