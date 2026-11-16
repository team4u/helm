/**
 * conversation history heavy write, fall back heavy (rewind) and checkpoint restore engine.
 *
 * responsibility:
 * - original ground override heavy target validate and guard against concurrency mutual exclusion;
 * - original ground override heavy atomic transaction (commit internal validate idle, scan tail part, compute omit, commit new input, write helm.rewind truncate mark record);
 * - transaction after precise allow FTS index clean up,lastAssistant cache expires and tracker register;
 * - all amount rewind override zone between scan aggregate (provide to detail situation throw shadow and FTS rebuild).
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
      throw new HelmError('conversation_busy', `conversation ${id} is now update history message, retry later`, 409)
    }
    this.historyEditsInFlight.add(id)
    try {
      return await operation()
    } finally {
      this.historyEditsInFlight.delete(id)
    }
  }

  /** original ground override target before commit boundary validate (store in / leap context inside / not by override / person class input). */
  async validateReplaceTarget(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    raw: number | undefined,
  ): Promise<number | undefined> {
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError(
        'validation_error',
        `replaceFromEntryId must be security positive integer (receives ${String(raw)})`,
        400,
        { conversationId: id, replaceFromEntryId: raw },
      )
    }
    // item store in precise validate (min=max=entryId take 1 ; missing 404).
    const entryId = asEntryId(raw)
    const page = await conversation.entries(
      { minEntryId: entryId, maxEntryId: entryId, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || Number(page.items[0]!.id) !== raw) {
      throw new HelmError('not_found', `item ${raw} in conversation ${id} in missing`, 404, {
        conversationId: id,
        entryId: raw,
      })
    }
    // edit target limit set person class input:agent/trigger inject,assistant/control item cannot edit.
    assertEditableHumanInput(page.items[0]!, id, raw)
    const preCtx = await conversation.context(BACKGROUND_CONTEXT)
    if (!preCtx.entries.some((e) => Number(e.id) === raw)) {
      throw new HelmError(
        'entry_before_context_head',
        `item ${raw} at most near once reset or compress before, cannot original ground override, use fork (fork)`,
        409,
        { conversationId: id, entryId: raw },
      )
    }
    const rewound = preCtx.entries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && raw >= interval.from && raw <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `item ${raw} already by this before heavy override`, 409, {
        conversationId: id,
        entryId: raw,
      })
    }
    return raw
  }

  /** stale edit guard: hook suspended during target may by concurrency change write (leave context / already by override). */
  async assertTargetStillCurrent(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    targetId: number,
  ): Promise<void> {
    const current = await conversation.context(BACKGROUND_CONTEXT)
    if (!current.entries.some((entry) => Number(entry.id) === targetId)) {
      throw new HelmError('entry_before_context_head', 'edit target already leave when before context, please re- choose message', 409)
    }
    if (current.entries.some((entry) => {
      const cut = rewindIntervalOf(entry)
      return cut !== undefined && targetId >= cut.from && targetId <= cut.through
    })) {
      throw new HelmError('entry_already_rewound', `item ${targetId} already by this before heavy override`, 409)
    }
  }

  /** scan conversation all amount raw entries, aggregate all rewind override zone between (detail situation throw shadow use). */
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
   * original ground override heavy atomic commit (submitInput replaceFromEntryId path):
   * 1. async prepare:abort in-flight turn (SDK abort also withdraw back other queued inputs,
   *    is this time explicit semantics) and wait for idle, suspended Ask one by one deregister single superseded(error such as
   *    on throw, never swallow wrong fake succeeded);
   * 2. single SDK commit inside complete all core verify and write (see rewriteTransaction);
   * 3. transaction after clean up: precise delete by override purpose FTS key and wait for (error pass broadcast),
   *    expires override zone between lastAssistant cache, push enter stateChangeSeq.
   *
   * zone between contract:helm.rewind.data declaration closed zone between [fromEntryId, throughEntryId],
   * throughEntryId is this transaction before tail part (PRE_TRANSACTION_TAIL_ID); new input item
   * ID must however more large, never will by self household zone between mistakenly delete. since has rewind mark record and baseline
   * pi.system keep (do not omit);model messages by omit by SDK original generate edits negative duty.
   */
  async rewriteConversationFrom(
    id: number,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    replaceFromEntryId: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: string }> {
    // async prepare phase (transaction outside): user already authorization history edit abort when before turn or in progress streamline task.
    const hadLiveRun = this.host.tracker.hasLiveWork(id)
    if (hadLiveRun || this.host.tracker.isCompacting(id)) {
      await this.host.abortConversation(id)
      await conversation.waitForIdle(BACKGROUND_CONTEXT)
      if (hadLiveRun) {
        await this.host.tracker.waitTurnSettled(id)
      }
    }
    // suspended Ask deregister single is superseded: by override turn approval card no longer valid;
    // cancel failed such as on throw (honest discipline: never .catch swallow wrong).
    await this.host.cancelPendingAsksForRewrite(id)

    const createdAt = Date.now()
    // coveredRange from transaction inside return: transaction outside precise clean up FTS old key and expires zone between
    // lastAssistant cache (never trigger touch new input/new answer key).
    const { submissionId, covered, ftsKeys } = await conversation.commit(
      (tx) => this.rewriteTransaction(conversation, tx, id, replaceFromEntryId, createdAt, newInput),
      BACKGROUND_CONTEXT,
    )
    this.registerRewoundInput(id, newInput.finalInput, submissionId)
    this.cleanupRewindSideEffects(id, covered, ftsKeys)
    return { submissionId: String(submissionId) }
  }

  /**
   * rewind transaction body (commit call back inside; forbidden conversation.context()/harness read etc.
   * will deadlock interface). phase split: verify idle -> collect tail part -> compute omit manifest ->
   * commit new input -> append rewind mark record.
   */
  private async rewriteTransaction(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Tx,
    id: number,
    replaceFromEntryId: number,
    createdAt: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: SubmissionId; covered: { from: number; through: number }; ftsKeys: string[] }> {
    // - - transaction inside re- verify (all tx reads, first at any table write) - -
    const { tailId, headLowerBound } = await this.assertRewriteIdle(tx, id, replaceFromEntryId)
    const tailEntries = await this.scanTailEntries(tx, id, replaceFromEntryId)
    const target = tailEntries.find((e) => Number(e.id) === replaceFromEntryId)
    if (target === undefined) {
      throw new HelmError('not_found', `item ${replaceFromEntryId} in conversation ${id} in missing`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    assertEditableHumanInput(target, id, replaceFromEntryId)
    // since has rewind zone between heavy core (async prepare during may has concurrency write).
    const rewound = tailEntries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && replaceFromEntryId >= interval.from && replaceFromEntryId <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `item ${replaceFromEntryId} already by this before heavy override`, 409, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const baselineSystemNumericId = await this.findBaselineSystemId(tx, id, headLowerBound)
    const { omittedEntryIds, omittedInputIds, ftsKeys } = this.collectRewindOmissions(tailEntries, baselineSystemNumericId)
    // commit new input (whenBusy 'reject': any concurrency enter in this explicit failed, never queue up).
    // submit(tx, draft) must first at this transaction first table write.
    const submissionId = await this.submitRewoundInput(conversation, tx, newInput)
    // rewind truncate mark record: closed zone between [replaceFromEntryId, tailId], new input item ID
    // already by on way submit allocate (must however > tailId), will not by self household edits mistakenly delete.
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

  /** transaction inside idle verify: leap run / compress / queue up / target out of bounds (contains context head). */
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
        `conversation ${id} store in leap turn, reject original ground override heavy (do not queue up)`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    if ((live.compactions?.length ?? 0) > 0) {
      throw new HelmError(
        'conversation_busy',
        `conversation ${id} store in in progress compress task, reject original ground override heavy`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const inbox = await tx.doc(InboxDoc, convId)
    if (inbox.items.length > 0) {
      throw new HelmError(
        'conversation_busy',
        `conversation ${id} store in ${inbox.items.length} items queue up commit, reject original ground override heavy (do not queue up)`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const headMarker = await tx.latestHeadMarker(convId)
    const latestIdRaw = await tx.latestEntryId(convId)
    if (latestIdRaw === undefined) {
      throw new HelmError('not_found', `item ${replaceFromEntryId} in conversation ${id} in missing`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const tailId = Number(latestIdRaw)
    if (replaceFromEntryId > tailId) {
      throw new HelmError('not_found', `item ${replaceFromEntryId} in conversation ${id} in missing`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const headLowerBound = headMarker !== undefined ? Number(headMarker.head) : 0
    if (replaceFromEntryId < headLowerBound) {
      throw new HelmError(
        'entry_before_context_head',
        `item ${replaceFromEntryId} at most near once reset or compress before, cannot original ground override, use fork (fork)`,
        409,
        { conversationId: id, entryId: replaceFromEntryId },
      )
    }
    return { tailId, headLowerBound }
  }

  /** collect target and after raw entries(fork visible scope; page scan, without deep embed set). */
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

  /** baseline pi.system locate:head mark record after first (keep messages[0] system prompt). */
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

  /** omit manifest and precise FTS key collect (override zone between;baseline system and rewind mark record keep). */
  private collectRewindOmissions(
    tailEntries: ReadonlyArray<EntryRecord>,
    baselineSystemNumericId: number | undefined,
  ): { omittedEntryIds: number[]; omittedInputIds: string[]; ftsKeys: string[] } {
    const omittedEntryIds: number[] = []
    const omittedInputIds: string[] = []
    const ftsKeys: string[] = []
    for (const e of tailEntries) {
      const numericId = Number(e.id)
      // override zone between inside all old purpose precise FTS key (contains by keep baseline system and
      // rewind mark record itself - - they this then without index text, delete do not delete all does not affect, but unify collect
      // avoid tailEntries and clean up manifest two set logic).
      ftsKeys.push(`entry:${String(e.id)}`)
      if (e.kind === 'helm.input') {
        const inputId = (e.data as { id?: unknown } | undefined)?.id
        if (typeof inputId === 'string' && inputId !== '') {
          ftsKeys.push(`input:${inputId}`)
          omittedInputIds.push(inputId)
        }
      }
      // edit target itself must omit(closed zone between contains from boundary); since has rewind mark record and
      // baseline pi.system keep.
      if (e.kind === 'helm.rewind') continue
      if (numericId === baselineSystemNumericId) continue
      omittedEntryIds.push(numericId)
    }
    return { omittedEntryIds, omittedInputIds, ftsKeys }
  }

  /** rewind new input commit (whenBusy 'reject';helm.input entry all amount redaction after written to the database). */
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

  /** transaction after tracker register (bindSubmission register related index, observe path already by requestId first row register). */
  private registerRewoundInput(id: number, finalInput: ConversationInput, submissionId: SubmissionId): void {
    // transaction already written to the database: register tracker(commit observe path may already by requestId first row register,
    // registerInput idempotent merge is unique record, failed then drop undo, never under orphan child register).
    this.host.tracker.registerInput(id, finalInput)
    try {
      this.host.tracker.bindSubmission(id, finalInput.id, submissionId)
    } catch (error) {
      this.host.tracker.dropInput(id, finalInput.id)
      throw error
    }
  }

  /** transaction outside clean up:FTS precise old key delete + lastAssistant cache expires + stateChangeSeq push enter. */
  private cleanupRewindSideEffects(id: number, covered: { from: number; through: number }, ftsKeys: string[]): void {
    // transaction outside clean up: only delete transaction kernel precise old FTS key (entry:<id> / input:<requestId>),
    // observer new input/new answer index do not subject to affect (encounter helm.rewind stop back scan, old answer do not re- burn);
    // error by tail chain unify conflict refresh pass broadcast (flushPublic / search read path such as throw).
    // expires override zone between lastAssistant cache: new answer on failure
    // getLastAssistantText must not return already by override old answer proposal.
    this.host.store.removeFtsEntries(id, ftsKeys)
    this.host.tracker.invalidateLastAssistantWithin(id, covered.from, covered.through)
    const meta = this.host.store.getConv(id)
    if (meta) {
      this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
  }
}
