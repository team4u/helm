/**
 * conversation context operation module:reset / compact / fork.
 *
 * responsibility:
 * - closure stop guard and context pre- validate;
 * - conversation context reset (reset, support handoff);
 * - conversation history manually compress (compact, support self define instructions);
 * - conversation history checkpoint fork (fork, inherit source conversation metadata and align model).
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

  /** kernel close guard (context operation shared use). */
  assertOpen(): void {
    if (this.host.isClosed()) throw new HelmError('runtime_closed', 'kernel is now close, reject commit new input', 503)
  }

  /** take already exists conversation metadata and SDK handle (missing unify 404). */
  async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = requireConv(this.host.store, id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `conversation missing:${id}`, 404)
    return { meta, conversation }
  }

  /** reset conversation context:SDK reset(handoff) after push enter stateChangeSeq and broadcast summary. */
  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeHandoff =
      opts?.handoff !== undefined && opts.handoff !== '' ? this.host.stash.redact(opts.handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    // reset after context from zero start: immediately trigger use amount heavy compute (observe path pi.reset item trigger dedupe honor bottom).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return summary
  }

  /** manually compress:SDK compact(instructions) return background task ID; return { taskId, conversation }. */
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
    // manually compress already subject to: immediately trigger use amount heavy compute (compacting state and compress after tokens by
    // observe path live/entry trigger continue force complete; idle conversation do not via live frame short route).
    this.host.tracker.scheduleContextUsageRefresh(id)
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * from designate item fork new conversation:SDK fork(entryId) after register helm mirror
   *(inherit profile/tags/cwd/model/override; parent chain points to source conversation) and align model.
   */
  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    if (!Number.isSafeInteger(opts.entryId) || opts.entryId <= 0) {
      throw new HelmError('validation_error', `entryId must be security positive integer (receives ${String(opts.entryId)})`, 400, {
        entryId: opts.entryId,
      })
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // item store in precise validate (min=max=entryId take 1 ; missing 404).
    const page = await sourceConv.entries(
      { minEntryId: opts.entryId as never, maxEntryId: opts.entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || (page.items[0] as { id: number }).id !== opts.entryId) {
      throw new HelmError('not_found', `item ${opts.entryId} in conversation ${id} in missing`, 404, {
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
