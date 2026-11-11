/**
 * RuntimeOwnershipManager：会话归属权与插件会话管理权维护（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - 会话归属权判定与持久标记（getOwnership, markOwnership）；
 * - 插件会话管理权持有与释放（manage, release）；
 * - 归属变化投射 conversation.upsert 事件。
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
  /** 会话插件管理权：conversationId -> 持有 pluginId 集合（删除保护）。 */
  readonly managedConversations = new Map<number, Set<string>>()

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  /**
   * 会话归属权现读（Watchdog 红线判定唯一可信来源）：
   * - 会话不存在（含已删除 tombstone）时抛 not_found；
   * - 未标记/标记非法值一律 human（宁漏管不越权）。
   */
  getOwnership(conversationId: number): ConversationOwnership {
    const meta = this.deps.store.getConv(conversationId)
    if (meta === undefined || this.deps.store.isDeleted(conversationId)) {
      throw new HelmError('not_found', `会话不存在：${conversationId}`, 404, { conversationId })
    }
    const owners = this.deps.documentStore.get<Record<string, string>>('conversation-ownership', {})
    const marked = owners[String(conversationId)]
    return marked === 'helm' || marked === 'bot' ? marked : 'human'
  }

  /**
   * 会话归属权标记（Watchdog 红线判定唯一可信来源）：
   * - 不依赖用户可改的 tags/parent 推断；未标记一律视为 human；
   * - 持久化于全局 doc（'conversation-ownership'），重启保留。
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
   * 插件会话管理权（删除保护）：仅已启用插件可持有；返回释放函数。
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
