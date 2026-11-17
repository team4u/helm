/**
 * Conversation history rewrite, rewind, and checkpoint restoration engine.
 *
 * Responsibilities:
 * - Validate in-place overwrite & resend targets and guard against concurrent edits;
 * - Execute atomic rewrite transactions (verify idle inside tx, scan tail, compute omissions, commit new input,
 *   append helm.rewind truncation marker);
 * - Clean up exact overwritten FTS entries, invalidate lastAssistant cache, and register with tracker post-tx;
 * - Scan and aggregate all rewind intervals (consumed by detail projection and FTS rebuilds).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  InboxDoc,
  LiveDoc,
  type Cursor,
  type EntryRecord,
  type Harness,
  type SubmissionId,
  type Tx,
} from '@earendil-works/pi-durable'
import type { ConversationAttachmentRef, ConversationInput } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConversationTracker } from './conversations.js'
import {
  assertEditableHumanInput,
  rewindIntervalOf,
  type RewindInterval,
} from './runtime-helpers.js'
import { asConversationId, asEntryId } from './sdk-ids.js'
import type { HelmStore } from './store.js'

export interface ConversationRewindHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  readonly abortConversation: (id: number) => Promise<void>
}

export interface RewindNewInput {
  finalInput: ConversationInput
  effectiveText: string
  resolvedAttachments?: Array<{ ref: ConversationAttachmentRef; absPath: string }>
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}

export class ConversationRewind {
  private readonly historyEditsInFlight = new Set<number>()

  constructor(private readonly host: ConversationRewindHost) {}

  async withHistoryEdit<T>(id: number, operation: () => Promise<T>): Promise<T> {
    if (this.historyEditsInFlight.has(id)) {
      throw new HelmError('conversation_busy', `conversation ${id} is currently updating message history; retry later`, 409)
    }
    this.historyEditsInFlight.add(id)
    try {
      return await operation()
    } finally {
      this.historyEditsInFlight.delete(id)
    }
  }

  /** Pre-commit boundary validation for in-place overwrite targets (exists / within active context / not overwritten / human input). */
  async validateReplaceTarget(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    raw: number | undefined,
  ): Promise<number | undefined> {
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError(
        'validation_error',
        `replaceFromEntryId must be a positive safe integer (received ${String(raw)})`,
        400,
        { conversationId: id, replaceFromEntryId: raw },
      )
    }
    // Exact entry existence check (min=max=entryId limit 1).
    const entryId = asEntryId(raw)
    const page = await conversation.entries(
      { minEntryId: entryId, maxEntryId: entryId, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || Number(page.items[0]!.id) !== raw) {
      throw new HelmError('not_found', `entry ${raw} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId: raw,
      })
    }
    // Edit targets are restricted to human inputs: agent/trigger injections and assistant/control entries cannot be edited.
    assertEditableHumanInput(page.items[0]!, id, raw)
    const preCtx = await conversation.context(BACKGROUND_CONTEXT)
    if (!preCtx.entries.some((e) => Number(e.id) === raw)) {
      throw new HelmError(
        'entry_before_context_head',
        `entry ${raw} precedes the latest reset or compaction and cannot be overwritten in place; use fork instead`,
        409,
        { conversationId: id, entryId: raw },
      )
    }
    const rewound = preCtx.entries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && raw >= interval.from && raw <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `entry ${raw} has already been overwritten`, 409, {
        conversationId: id,
        entryId: raw,
      })
    }
    return raw
  }

  /** Stale-edit guard: target may have changed concurrently while hooks suspended (left context / already overwritten). */
  async assertTargetStillCurrent(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    targetId: number,
  ): Promise<void> {
    const current = await conversation.context(BACKGROUND_CONTEXT)
    if (!current.entries.some((entry) => Number(entry.id) === targetId)) {
      throw new HelmError('entry_before_context_head', 'edit target is no longer in current context; please re-select message', 409)
    }
    if (current.entries.some((entry) => {
      const cut = rewindIntervalOf(entry)
      return cut !== undefined && targetId >= cut.from && targetId <= cut.through
    })) {
      throw new HelmError('entry_already_rewound', `entry ${targetId} has already been overwritten`, 409)
    }
  }

  /** Scan all raw entries in a conversation to aggregate rewind-covered intervals (used by detail projection). */
  async collectRewindIntervals(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    const intervals: RewindInterval[] = []
    let cursor: Cursor | undefined = undefined
    for (;;) {
      const page = await conversation.entries({ order: 'ascending' }, 100, cursor, BACKGROUND_CONTEXT)
      for (const raw of page.items) {
        if (raw.kind !== 'helm.rewind') continue
        const interval = rewindIntervalOf(raw)
        if (interval !== undefined) intervals.push(interval)
      }
      if (page.next === undefined) break
      cursor = page.next
    }
    return intervals
  }

  /**
   * Atomic commit for in-place overwrite & resend (submitInput replaceFromEntryId path):
   * 1. Async preparation: abort active turn (SDK abort also clears other queued inputs, which is explicit here)
   *    and wait for idle; supersede pending asks one-by-one (errors propagate honestly rather than faking success);
   * 2. Perform all verification and writes inside a single SDK commit (see rewriteTransaction);
   * 3. Post-transaction cleanup: delete exact overwritten FTS keys and await flush/error broadcast, invalidate
   *    lastAssistant cache within covered range, and advance stateChangeSeq.
   *
   * Interval contract: helm.rewind.data declares a closed interval [fromEntryId, throughEntryId], where throughEntryId
   * is the tail before this transaction (PRE_TRANSACTION_TAIL_ID); the new input gets a strictly larger ID and is never
   * accidentally touched by its own interval. Existing rewind markers and the baseline pi.system are kept (not omitted);
   * model message omission relies on SDK-native `edits`.
   */
  async rewriteConversationFrom(
    id: number,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    replaceFromEntryId: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: string }> {
    // Async preparation outside transaction: abort current turn or active compaction per user's authorized history edit.
    const hadLiveRun = this.host.tracker.hasLiveWork(id)
    if (hadLiveRun || this.host.tracker.isCompacting(id)) {
      await this.host.abortConversation(id)
      await conversation.waitForIdle(BACKGROUND_CONTEXT)
      if (hadLiveRun) {
        await this.host.tracker.waitTurnSettled(id)
      }
    }
    // Supersede pending asks: approval cards for overwritten turns are no longer valid;
    // cancellation failures must rethrow honestly (never swallow via .catch).
    await this.host.cancelPendingAsksForRewrite(id)

    const createdAt = Date.now()
    // Return covered range from inside transaction so post-tx cleanup removes only old FTS keys and stale
    // lastAssistant caches without touching the newly submitted input/response.
    const { submissionId, covered, ftsKeys } = await conversation.commit(
      (tx) => this.rewriteTransaction(conversation, tx, id, replaceFromEntryId, createdAt, newInput),
      BACKGROUND_CONTEXT,
    )
    this.registerRewoundInput(id, newInput.finalInput, submissionId)
    this.cleanupRewindSideEffects(id, covered, ftsKeys)
    return { submissionId: String(submissionId) }
  }

  /**
   * Rewind transaction body (runs inside commit callback—never invoke conversation.context() / harness reads that deadlock).
   * Phases: verify idle -> collect tail -> compute omissions -> submit new input -> append rewind marker.
   */
  private async rewriteTransaction(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Tx,
    id: number,
    replaceFromEntryId: number,
    createdAt: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: SubmissionId; covered: { from: number; through: number }; ftsKeys: string[] }> {
    // -- Re-verify inside transaction (pure tx reads before any writes) --
    const { tailId, headLowerBound } = await this.assertRewriteIdle(tx, id, replaceFromEntryId)
    const tailEntries = await this.scanTailEntries(tx, id, replaceFromEntryId)
    const target = tailEntries.find((e) => Number(e.id) === replaceFromEntryId)
    if (target === undefined) {
      throw new HelmError('not_found', `entry ${replaceFromEntryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    assertEditableHumanInput(target, id, replaceFromEntryId)
    // Re-check existing rewind intervals (concurrent writes might have arrived during async preparation).
    const rewound = tailEntries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && replaceFromEntryId >= interval.from && replaceFromEntryId <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `entry ${replaceFromEntryId} has already been overwritten`, 409, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const baselineSystemNumericId = await this.findBaselineSystemId(tx, id, headLowerBound)
    const { omittedEntryIds, omittedInputIds, ftsKeys } = this.collectRewindOmissions(tailEntries, baselineSystemNumericId)
    // Submit replacement input (whenBusy='reject': any concurrent submission fails explicitly instead of queuing).
    // Note: submit(tx, draft) must precede the first tx write.
    const submissionId = await this.submitRewoundInput(conversation, tx, newInput)
    // Append rewind truncation marker covering [replaceFromEntryId, tailId]; the new input entry ID allocated above
    // is strictly > tailId and will never be omitted by its own edits.
    const edits = omittedEntryIds.map((target2) => ({ target: asEntryId(target2), action: 'omit' as const }))
    await tx.appendEntry(asConversationId(id), {
      kind: 'helm.rewind',
      data: copyJson(
        {
          fromEntryId: replaceFromEntryId,
          throughEntryId: tailId,
          omittedEntryIds,
          omittedInputIds,
          createdAt,
        },
        { omitUndefinedProperties: true },
      ),
      ...(edits.length > 0 ? { edits } : {}),
    })
    return {
      submissionId,
      covered: { from: replaceFromEntryId, through: tailId },
      ftsKeys,
    }
  }

  /** Verify idle state inside transaction: no active run / compaction / inbox queue / out-of-range target (incl. context head). */
  private async assertRewriteIdle(
    tx: Tx,
    id: number,
    replaceFromEntryId: number,
  ): Promise<{ tailId: number; headLowerBound: number }> {
    const convId = asConversationId(id)
    const live = await tx.doc(LiveDoc, convId)
    if (live.run !== undefined) {
      throw new HelmError(
        'conversation_busy',
        `conversation ${id} has an active turn; refusing in-place overwrite & resend (no queuing)`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    if ((live.compactions?.length ?? 0) > 0) {
      throw new HelmError(
        'conversation_busy',
        `conversation ${id} has a compaction in progress; refusing in-place overwrite & resend`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const inbox = await tx.doc(InboxDoc, convId)
    if (inbox.items.length > 0) {
      throw new HelmError(
        'conversation_busy',
        `conversation ${id} has ${inbox.items.length} queued submission(s); refusing in-place overwrite & resend (no queuing)`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const headMarker = await tx.latestHeadMarker(convId)
    const latestIdRaw = await tx.latestEntryId(convId)
    if (latestIdRaw === undefined) {
      throw new HelmError('not_found', `entry ${replaceFromEntryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const tailId = Number(latestIdRaw)
    if (replaceFromEntryId > tailId) {
      throw new HelmError('not_found', `entry ${replaceFromEntryId} does not exist in conversation ${id}`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const headLowerBound = headMarker !== undefined ? Number(headMarker.head) : 0
    if (replaceFromEntryId < headLowerBound) {
      throw new HelmError(
        'entry_before_context_head',
        `entry ${replaceFromEntryId} precedes the latest reset or compaction and cannot be overwritten in place; use fork instead`,
        409,
        { conversationId: id, entryId: replaceFromEntryId },
      )
    }
    return { tailId, headLowerBound }
  }

  /** Collect raw entries from target through tail (flat paged scan, shallow nesting). */
  private async scanTailEntries(
    tx: Tx,
    id: number,
    replaceFromEntryId: number,
  ): Promise<EntryRecord[]> {
    const convId = asConversationId(id)
    const minEntryId = asEntryId(replaceFromEntryId)
    const tailEntries: EntryRecord[] = []
    let scanCursor: Cursor | undefined = undefined
    for (;;) {
      const page = await tx.scanEntries(
        {
          conversationId: convId,
          minEntryId,
          order: 'ascending',
        },
        200,
        scanCursor,
      )
      tailEntries.push(...page.items)
      if (page.next === undefined) break
      scanCursor = page.next
    }
    return tailEntries
  }

  /** Locate baseline pi.system: the first one after head marker (keeps messages[0] system prompt intact). */
  private async findBaselineSystemId(
    tx: Tx,
    id: number,
    headMarkerId: number,
  ): Promise<number | undefined> {
    const convId = asConversationId(id)
    const minEntryId = asEntryId(headMarkerId + 1)
    let baselineSystemNumericId: number | undefined
    let baselineCursor: Cursor | undefined = undefined
    for (;;) {
      const page = await tx.scanEntries(
        { conversationId: convId, minEntryId, order: 'ascending' },
        200,
        baselineCursor,
      )
      const baseline = page.items.find((entry) => entry.kind === 'pi.system')
      if (baseline !== undefined) {
        baselineSystemNumericId = Number(baseline.id)
        break
      }
      if (page.next === undefined) break
      baselineCursor = page.next
    }
    return baselineSystemNumericId
  }

  /** Collect omission list and exact FTS keys across overwritten interval (baseline system and rewind markers stay). */
  private collectRewindOmissions(
    tailEntries: ReadonlyArray<EntryRecord>,
    baselineSystemNumericId: number | undefined,
  ): { omittedEntryIds: number[]; omittedInputIds: string[]; ftsKeys: string[] } {
    const omittedEntryIds: number[] = []
    const omittedInputIds: string[] = []
    const ftsKeys: string[] = []
    for (const e of tailEntries) {
      const numericId = Number(e.id)
      // Collect exact FTS keys across the overwritten interval (including retained baseline system and rewind marker
      // entries—they contain no indexed text anyway, and uniform collection avoids parallel lists).
      ftsKeys.push(`entry:${String(e.id)}`)
      if (e.kind === 'helm.input') {
        const inputId = (e.data as { id?: unknown } | undefined)?.id
        if (typeof inputId === 'string' && inputId !== '') {
          ftsKeys.push(`input:${inputId}`)
          omittedInputIds.push(inputId)
        }
      }
      // Target entry itself must be omitted (inclusive [from, through] interval); keep existing rewind markers and baseline pi.system.
      if (e.kind === 'helm.rewind') continue
      if (numericId === baselineSystemNumericId) continue
      omittedEntryIds.push(numericId)
    }
    return { omittedEntryIds, omittedInputIds, ftsKeys }
  }

  /** Submit replacement input inside rewind transaction (whenBusy='reject'; helm.input entry persisted fully redacted). */
  private async submitRewoundInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Tx,
    newInput: RewindNewInput,
  ): Promise<SubmissionId> {
    const inputDraft = {
      type: 'input' as const,
      content: newInput.content,
      whenBusy: 'reject' as const,
      entry: {
        kind: 'helm.input',
        data: copyJson(
          {
            id: newInput.finalInput.id,
            text: newInput.effectiveText,
            origin: newInput.finalInput.origin,
            createdAt: newInput.finalInput.createdAt,
            whenBusy: 'reject',
            ...(newInput.finalInput.meta !== undefined ? { meta: newInput.finalInput.meta } : {}),
            ...(newInput.resolvedAttachments !== undefined
              ? { attachments: newInput.resolvedAttachments.map((r) => r.ref) }
              : {}),
          },
          { omitUndefinedProperties: true },
        ),
      },
      requestId: newInput.finalInput.id,
    }
    return conversation.submit(tx, inputDraft)
  }

  /** Register with tracker after transaction (bindSubmission wires correlation index; observe path idempotently merges by requestId). */
  private registerRewoundInput(id: number, finalInput: ConversationInput, submissionId: SubmissionId): void {
    // Transaction already persisted to DB: register with tracker (commit observer may have merged by requestId first;
    // registerInput idempotently merges into a single record, dropping on bind error to leave zero orphaned state).
    this.host.tracker.registerInput(id, finalInput)
    try {
      this.host.tracker.bindSubmission(id, finalInput.id, submissionId)
    } catch (error) {
      this.host.tracker.dropInput(id, finalInput.id)
      throw error
    }
  }

  /** Post-transaction cleanup: delete exact stale FTS keys, invalidate lastAssistant cache, and advance stateChangeSeq. */
  private cleanupRewindSideEffects(id: number, covered: { from: number; through: number }, ftsKeys: string[]): void {
    // Delete only exact stale FTS keys from the overwritten interval (entry:<id> / input:<requestId>) so observer
    // indices for new inputs/answers remain untouched (reverse scan stops at helm.rewind to never re-burn old answers);
    // errors propagate through the tail queue (flushPublic / search read paths).
    // Invalidate lastAssistant cache only within the overwritten interval so failed resends never return stale answers.
    this.host.store.removeFtsEntries(id, ftsKeys)
    this.host.tracker.invalidateLastAssistantWithin(id, covered.from, covered.through)
    const meta = this.host.store.getConv(id)
    if (meta) {
      this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
  }
}
