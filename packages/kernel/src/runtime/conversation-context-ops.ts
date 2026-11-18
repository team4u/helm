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
import type { ConversationSummary, GuardedMutationExpectation } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { requireConv } from './runtime-helpers.js'
import { resolveCleanForkAnchor } from './spawn-fork.js'
import type { HelmStore } from './store.js'

interface ConversationContextOpsHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly stash: SecretStash
  readonly isClosed: () => boolean
  readonly alignConversationModel: (id: number) => Promise<void>
  readonly withOwnership: (summary: ConversationSummary) => ConversationSummary
  /**
   * Guarded-mutation synchronous re-check (ownership human-red-line + optional CAS watermark),
   * injected by ConversationService; invoked with zero await gap before the irreversible SDK call.
   */
  readonly assertMutationGuard: (id: number, guard: GuardedMutationExpectation) => void
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

  /**
   * Reset conversation context: call SDK reset(handoff), increment stateChangeSeq, and broadcast summary.
   * Guarded callers (plugin automation) pass `guard`: ownership + optional CAS watermark are re-checked
   * synchronously right before the irreversible SDK reset call (zero await gap, same invariant as
   * abortConversationGuarded); unguarded callers (HTTP/CLI human paths) omit it.
   */
  async resetConversation(
    id: number,
    opts?: { handoff?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<ConversationSummary> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
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

  /**
   * Manual compaction: call SDK compact(instructions) returning background task ID and updated conversation summary.
   * Guarded callers pass `guard`: re-check runs synchronously right before the irreversible SDK compact enqueue.
   */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
    guard?: GuardedMutationExpectation,
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    if (guard !== undefined) this.host.assertMutationGuard(id, guard)
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
   * Fork a new conversation from a specified entry or latest clean anchor: calls SDK fork(entryId),
   * registers helm mirror (inheriting profile/tags/cwd/model/overrides with parent pointing to source), and aligns model.
   */
  async forkConversation(
    id: number,
    opts?: { entryId?: number; title?: string; parentConversationId?: number },
  ): Promise<ConversationSummary> {
    this.assertOpen()
    const explicitEntryId = opts?.entryId
    if (explicitEntryId !== undefined && (!Number.isSafeInteger(explicitEntryId) || explicitEntryId <= 0)) {
      throw new HelmError(
        'validation_error',
        `entryId must be a positive safe integer (received ${String(explicitEntryId)})`,
        400,
        { entryId: explicitEntryId },
      )
    }
    const explicitParentId = opts?.parentConversationId
    if (explicitParentId !== undefined) {
      if (!Number.isSafeInteger(explicitParentId) || explicitParentId <= 0) {
        throw new HelmError(
          'validation_error',
          `parentConversationId must be a positive safe integer (received ${String(explicitParentId)})`,
          400,
          { parentConversationId: explicitParentId },
        )
      }
      if (this.host.store.getConv(explicitParentId) === undefined || this.host.store.isDeleted(explicitParentId)) {
        throw new HelmError('not_found', `parent conversation not found: ${explicitParentId}`, 404, {
          parentConversationId: explicitParentId,
        })
      }
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    let entryId: number
    if (explicitEntryId !== undefined) {
      // Verify exact entry existence (min=max=entryId limit 1; missing yields 404).
      const page = await sourceConv.entries(
        { minEntryId: explicitEntryId as never, maxEntryId: explicitEntryId as never, order: 'ascending' },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      )
      if (page.items.length === 0 || (page.items[0] as { id: number }).id !== explicitEntryId) {
        throw new HelmError('not_found', `entry ${explicitEntryId} does not exist in conversation ${id}`, 404, {
          conversationId: id,
          entryId: explicitEntryId,
        })
      }
      entryId = explicitEntryId
    } else {
      entryId = await resolveCleanForkAnchor(this.host.harness, id)
    }
    const forked = await sourceConv.fork(
      entryId as never,
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `conversation ${id}`
    const title =
      opts?.title !== undefined && opts.title.trim() !== ''
        ? this.host.stash.redact(opts.title.trim())
        : `${baseTitle} (fork)`
    this.host.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: explicitParentId ?? id,
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
