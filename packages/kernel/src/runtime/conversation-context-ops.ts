/**
 * Conversation context operations: reset / compact / fork.
 *
 * Responsibilities:
 * - Shutdown guards and context preflight checks;
 * - Conversation context reset (with optional handoff);
 * - Manual conversation compaction (with optional custom instructions);
 * - Forking a conversation from a historical entry (inheriting source metadata and aligning model).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { requireConv } from './runtime-helpers.js'
import type { HelmStore } from './store.js'

export interface ConversationContextOpsHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly stash: SecretStash
  readonly isClosed: () => boolean
  readonly alignConversationModel: (id: number) => Promise<void>
  readonly withOwnership: (summary: ConversationSummary) => ConversationSummary
}

export class ConversationContextOps {
  constructor(private readonly host: ConversationContextOpsHost) {}

  /** Kernel shutdown guard (shared across context operations). */
  assertOpen(): void {
    if (this.host.isClosed()) throw new HelmError('runtime_closed', 'kernel is closing; rejecting new input submission', 503)
  }

  /** Fetch existing conversation metadata and SDK handle (throws 404 if missing). */
  async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = requireConv(this.host.store, id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
    return { meta, conversation }
  }

  /** Reset conversation context: call SDK reset(handoff), increment stateChangeSeq, and broadcast summary. */
  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeHandoff =
      opts?.handoff !== undefined && opts.handoff !== '' ? this.host.stash.redact(opts.handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    // Context resets to zero after reset: trigger usage recalculation immediately (deduplicated alongside pi.reset observe backstop).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return summary
  }

  /** Manual compaction: call SDK compact(instructions) returning background task ID and updated conversation summary. */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeInstructions =
      opts?.instructions !== undefined && opts.instructions !== ''
        ? this.host.stash.redact(opts.instructions)
        : undefined
    const taskId = await conversation.compact(safeInstructions, BACKGROUND_CONTEXT)
    this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    // Manual compaction enqueued: trigger usage recalculation immediately (compacting flag and post-compaction tokens
    // continue updating via live/entry observe triggers; idle conversations don't short-circuit on live frames).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * Fork a new conversation from a specified entry: calls SDK fork(entryId), registers helm mirror
   * (inheriting profile/tags/cwd/model/overrides with parent pointing to source), and aligns model.
   */
  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    if (!Number.isSafeInteger(opts.entryId) || opts.entryId <= 0) {
      throw new HelmError('validation_error', `entryId must be a positive safe integer (received ${String(opts.entryId)})`, 400, {
        entryId: opts.entryId,
      })
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // Verify exact entry existence (min=max=entryId limit 1; missing yields 404).
    const page = await sourceConv.entries(
      { minEntryId: opts.entryId as never, maxEntryId: opts.entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || (page.items[0] as { id: number }).id !== opts.entryId) {
      throw new HelmError('not_found', `entry ${opts.entryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId: opts.entryId,
      })
    }
    const forked = await sourceConv.fork(
      opts.entryId as never,
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `conversation ${id}`
    const title =
      opts.title !== undefined && opts.title.trim() !== ''
        ? this.host.stash.redact(opts.title.trim())
        : `${baseTitle} (fork)`
    this.host.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: id,
      nodeId: sourceMeta.nodeId ?? 'local',
      cwd: sourceMeta.cwd,
      model: sourceMeta.model,
      thinkingLevel: sourceMeta.thinkingLevel,
      thinkingLevelOverride: sourceMeta.thinkingLevelOverride,
      ...(sourceMeta.modelOverride !== undefined ? { modelOverride: sourceMeta.modelOverride } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.host.alignConversationModel(newId)
    await this.host.tracker.observe(newId)
    const summary = this.host.tracker.summaryOf(newId)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return summary
  }
}
