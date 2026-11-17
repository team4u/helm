/**
 * ConversationTracker:pi-durable conversation helm view layer.
 *
 * core mechanism:observeConversation sync observer (advance inside forbidden await, only do record),
 * in snapshot push enter when sync maintain memory mirror and queue up side effect (SSE push in micro task in out).
 *
 * state layout (see conversation-mirror.ts / context-usage-refresh.ts):
 * - each conversation run state aggregate is single ConversationMirror(mirrors),stopObserving once
 *   delete whole reclaim; across conversation index (settledRuns dedupe set) and stop observe after still must fidelity
 *   notifiedCompactionFailures in tracker top-level;
 * - contextUsage cache/refresh chain independent into ContextUsageRefresh(in-flight refresh can across exceeds stop observe).
 *
 * turn_settled precise catch:
 * - input with durable input.id(i.e. SDK requestId) is unique append trace identity:registerInput
 *   before commit register,bindSubmission back fill submissionId→requestId related index;
 *   observe path (helm.input entry / pi.inbox rebuild) directly by requestId and idempotent
 *   merge unique record;entry rebuild only recognize when before run zone between (run.first and after) and when before
 *   inbox, already compute run history helm.input does not resurrect; restart restore leap run when via
 *   live.run.inputs right threat manifest + submission precise query patch complete metadata and index;
 * - each run(taskId) many tool round cumulative consume input (new taskId only then reset);
 * - run disappear (complete/failed) precise compute once (settledRuns guard against double report; failed take
 *   runFailure.inputs precise manifest);
 * - abort by runtime.abortConversation explicit compute (observe path does not repeat report aborted);
 * - run observe to failure after again explicit abort: only patch aborted(does not repeat failed);
 * - run leap during (start / doing semantics change) push real-time summary (emitRunSummary,
 *   semantics refer grain dedupe, do not one by one token; terminal state still by emitSettled exactly once negative duty).
 */

import type {
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationStatus,
  ConversationSummary,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConvMeta, HelmStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'
import { coveredByRewind, rewindIntervalOf, type RewindInterval } from './runtime-helpers.js'
import { emitDiagnostic, type KernelDiagnosticInput, type KernelDiagnosticSink } from './diagnostics.js'
import { compactionFailureNoticeOf } from './context-usage.js'
import { ContextUsageRefresh, type ContextUsageHost } from './context-usage-refresh.js'
import {
  type ConversationMirror,
  createConversationMirror,
  type HelmInputMeta,
  type InboxItemShape,
  inputFromMeta,
  type LiveStateShape,
  mergeInputMeta,
} from './conversation-mirror.js'

export type { LiveStateShape }

export interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): Promise<void> | void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
  /** new timeline item written to the database (only new item, each id exactly once; initial observe history do not heavy). */
  onEntryCommitted?(conversationId: number, entry: ConversationEntry): void
  /** conversation real-time incremental (streaming text cumulative snapshot + tool card; node stream push, terminal state conflict refresh eventually state). */
  onLiveChanged?(live: ConversationLive): void
  /** compress failed etc. async exception once explicit on report (EventHub notification channel). */
  onNotification?(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string; conversationId: number }): void
}

/** live node stream window (milli second):50-100ms zone between take 75ms, balance SSE frame rate and commit pressure. */
const LIVE_THROTTLE_MS = 75

/** single conversation settledRunOrder keep cap (guard against 7×24 long run without boundary increase long;runId single tune, eliminate forever do not re- now). */
const SETTLED_RUNS_PER_CONVERSATION = 64

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmStore
  private readonly events: TrackerEvents
  /** conversation -> single conversation aggregate mirror (observe establish or first time write when create;stopObserving whole delete). */
  private readonly mirrors = new Map<number, ConversationMirror>()
  /** already compute run(guard against done+failure+abort double report). across conversation prefix key (`${id}:${taskId}`)
   * global dedupe, does not enter mirror (stopObserving by prefix clean up). */
  private readonly settledRuns = new Set<string>()
  /** conversation -> already compress failed notify taskId(the same failed duplicate snapshot does not repeat notify;
   * do not follow stopObserving clear - - same runtime inside heavy observe must not again report the same failed). */
  private readonly notifiedCompactionFailures = new Map<number, number>()
  /** contextUsage cache/refresh chain (in-flight refresh can across exceeds stop observe, state does not enter mirror). */
  private readonly usage: ContextUsageRefresh
  /** conversation -> latest visible timeline entry ID (`0` when none; excludes `pi.system` and rewound intervals). */
  private readonly lastEntryIds = new Map<number, number>()
  /** tracker close guard (close() or host isClosed placement after reject late to async for account side effect). */
  private closed = false

  constructor(options: {
    harness: Harness
    store: HelmStore
    events: TrackerEvents
    /** error summary for outside redaction (and runtime SecretStash same source); default constant etc. (only test environment). */
    redactError?: (text: string) => string
    /** conversation ownership right now read (Runtime inject ownership.getOwnership); default treated as human.
     * only used to turn compute unread policy: background derive sub-conversation do not fabricate person class not read. */
    ownershipOf?: (id: number) => 'helm' | 'bot' | 'human'
    /** when before Models set now read (contextUsage window parse use); default do not parse
     * (contextWindow omit, never fabricate). */
    models?: () => Models
    /** host close state call back (and tracker.close() double keep risk). */
    isClosed?: () => boolean
    /** diagnose channel sink(default away defaultDiagnosticSink). */
    onDiagnostic?: KernelDiagnosticSink
  }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
    this.redactError = options.redactError ?? ((text) => text)
    this.ownershipOf = options.ownershipOf
    this.modelsOf = options.models
    this.isClosedFn = options.isClosed
    this.diagnosticSink = options.onDiagnostic
    const host: ContextUsageHost = {
      harness: this.harness,
      store: this.store,
      onSummaryChanged: (summary) => this.events.onSummaryChanged(summary),
      modelsOf: () => this.modelsOf?.(),
      generationOf: (id) => this.mirrors.get(id)?.observeGeneration,
      liveOf: (id) => this.mirrors.get(id)?.live,
      summaryOf: (id) => this.summaryOf(id),
      isClosing: () => this.isClosing,
      emitDiagnostic: (input) => this.reportDiagnostic(input),
    }
    this.usage = new ContextUsageRefresh(host)
  }

  /** error diagnose summary redaction (Runtime inject stashService.redact; guard against provider error back visible already register secret). */
  private readonly redactError: (text: string) => string

  /** diagnose channel sink(Runtime construct after can inject; default away defaultDiagnosticSink). */
  private diagnosticSink: KernelDiagnosticSink | undefined

  /** mount or replace diagnose channel sink(supply KernelRuntime construct phase connect line). */
  setDiagnosticSink(sink: KernelDiagnosticSink | undefined): void {
    this.diagnosticSink = sink
  }

  private reportDiagnostic(input: KernelDiagnosticInput): void {
    emitDiagnostic(this.diagnosticSink, this.redactError, input)
  }

  /** conversation ownership right now read (default constant human); only turn compute unread policy consume. */
  private readonly ownershipOf: ((id: number) => 'helm' | 'bot' | 'human') | undefined

  /** when before Models set now read (default do not parse: window omit). */
  private readonly modelsOf: (() => Models) | undefined

  /** host close state now read (default constant false; and tracker.closed double keep risk). */
  private readonly isClosedFn: (() => boolean) | undefined

  private get isClosing(): boolean {
    return this.closed || (this.isClosedFn?.() ?? false)
  }

  /** take (must want when create) conversation mirror: all write path unique entry. */
  private mirrorOf(id: number): ConversationMirror {
    let mirror = this.mirrors.get(id)
    if (mirror === undefined) {
      mirror = createConversationMirror()
      this.mirrors.set(id, mirror)
    }
    return mirror
  }

  /** hang connect designate conversation sync observer; leap run restore when first patch right threat input metadata again return. */
  async observe(id: number): Promise<void> {
    if (this.mirrors.get(id)?.detach !== undefined) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        const mirror = this.mirrors.get(id)
        if (mirror !== undefined) mirror.detach = undefined
        this.clearLiveTimer(id)
      },
    }
    const observation: Observation<ConversationView> = await this.harness.observeConversation(
      id as never,
      observer,
      BACKGROUND_CONTEXT,
    )
    const mirror = this.mirrorOf(id)
    mirror.detach = () => observation.detach()
    // initial snapshot: window inside already has item do not heavy (first time attach only align watermark line).
    // proxy count guard:await after if already stopObserving(or heavy observe swap proxy), do not to mirror back write.
    const generation = Symbol('conversation observation')
    mirror.observeGeneration = generation
    await this.adoptInitial(id, observation.value, generation)
  }

  /** first time attach: only register watermark line and internal mirror, do not entry/live event.
   *
   * leap run restore (restart/heavy hang observer) when, this run  helm.input entry may already slide out
   * observe window (long run many item), sync rebuild will lose input metadata. this where by SDK right threat mapping patch complete:
   * live.run.inputs is this run already put placement submissionId precise sequence, one by one via
   * harness.submission() take its entry id, again precise query (minEntryId=maxEntryId)
   * helm.input entry patch origin/meta/attachments;queued items via pi.inbox patch.
   * never with expand large observe window or concept rate sort replace right threat mapping. */
  private async adoptInitial(
    id: number,
    view: ConversationView,
    generation: symbol,
  ): Promise<void> {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    mirror.live = live ?? {}
    // restart/heavy hang i.e. see to legacy failed same not silently (each runtime lifecycle exactly report once).
    this.noteCompactionFailure(id, live)
    let watermark = mirror.lastEmittedEntry
    // context trigger watermark line and entry event watermark line the same initial value align: initial snapshot inside history mark record
    // (pi.compaction etc.) does not trigger after continue adopt duplicate refresh (initial refresh see under way scheduling).
    let usageWatermark = -1
    let seenEntryId = mirror.lastSeenEntryId
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (Number.isFinite(numeric) && numeric > watermark) watermark = numeric
      if (Number.isFinite(numeric) && numeric > usageWatermark) usageWatermark = numeric
      if (Number.isFinite(numeric) && numeric > seenEntryId) seenEntryId = numeric
    }
    mirror.lastEmittedEntry = watermark
    mirror.lastSeenEntryId = seenEntryId
    if (usageWatermark >= 0) this.usage.advanceWatermarkTo(id, usageWatermark)
    const windowEntries = view.entries as never as ReadonlyArray<EntryRecordLike>
    let initialLastEntryId = latestVisibleEntryIdOf(windowEntries)
    this.lastEntryIds.set(id, Math.max(this.lastEntryIds.get(id) ?? 0, initialLastEntryId))
    this.store.setLastEntryId?.(id, this.lastEntryIds.get(id)!)
    // inbox mirror register first at run decide: restart/stop run but inbox still has queue up input when,
    // queuedInputs derive and listLiveViews snapshot do not lose queue up fact (do not in web fabricate queue).
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)
    // first time hang connect i.e. fill context use amount cache (restart/fork/creates new conversation initial read path);
    // idle conversation same need to (otherwise only leap run conversation has initial value, history conversation open after without pill).
    this.usage.schedule(id)
    if (initialLastEntryId === 0 && (view as { before?: unknown }).before !== undefined) {
      initialLastEntryId = await this.scanLatestVisibleEntryId(id)
      if (this.mirrors.get(id)?.observeGeneration !== generation) return
      const merged = Math.max(this.lastEntryIds.get(id) ?? 0, initialLastEntryId)
      this.lastEntryIds.set(id, merged)
      this.store.setLastEntryId?.(id, merged)
    }
    if (!live?.run) return
    mirror.runTaskId = live.run.taskId
    mirror.consumedInputs = new Set<string>()
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    if (first !== undefined) mirror.runFirstEntry = first
    // this run already put placement input:SDK right threat submissionId -> entry precise back read, register
    // requestId append trace record and submissionId->requestId index (markConsumed can hit).
    const loaded = await this.loadRunInputEntries(id, live.run.inputs as number[])
    // stop observe swap proxy: async back read result act abandon, never to already clean up mirror re- item.
    if (this.mirrors.get(id)?.observeGeneration !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.indexRestoredSubmissions(id, loaded.pairs)
    // queued(not put placement) input:inbox entry payload direct read (on side already register mirror, this where only patch input metadata).
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
    // restore leap run already body now snapshot summary (listConversations): register semantics refer grain i.e. can,
    // after continue advance only in real change when push, do not patch redundant working frame.
    if (this.store.getConv(id)) mirror.lastSummaryKey = summaryKeyOf(this.summaryOf(id))
  }

  /** back read result:helm.input entry list + (submissionId, requestId) right threat for. */
  private async loadRunInputEntries(
    id: number,
    submissionIds: number[],
  ): Promise<{ entries: Array<Record<string, unknown>>; pairs: Array<{ submissionId: number; requestId: string }> }> {
    if (submissionIds.length === 0) return { entries: [], pairs: [] }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) return { entries: [], pairs: [] }
    const out: Array<Record<string, unknown>> = []
    const pairs: Array<{ submissionId: number; requestId: string }> = []
    for (const submissionId of submissionIds) {
      const submission = await this.harness.submission(submissionId as never, BACKGROUND_CONTEXT)
      if (!submission) continue
      const record = (await submission.status(BACKGROUND_CONTEXT)) as {
        entry?: number
        requestId?: string
      }
      const entryId = record.entry
      if (entryId === undefined) continue
      const page = await conversation.entries(
        { minEntryId: entryId as never, maxEntryId: entryId as never, order: 'ascending' },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      )
      const raw = page.items[0] as Record<string, unknown> | undefined
      if (raw !== undefined) out.push(raw)
      if (record.requestId !== undefined) pairs.push({ submissionId, requestId: record.requestId })
    }
    return { entries: out, pairs }
  }

  /** restore input right threat (submissionId, requestId) for register enter related index. */
  private indexRestoredSubmissions(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const index = this.mirrorOf(id).submissionIndex
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
  }

  /** inbox queued items rebuild (not put placement input origin/meta/attachments patch complete + index register). */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmInputMeta | undefined
      if (item.entry?.kind !== 'helm.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // inbox items id i.e. SDK submissionId: register related index (out queue put placement after markConsumed can hit).
      this.mirrorOf(id).submissionIndex.set(item.id, data.id)
      this.upsertTrackedInput(id, data.id, data)
    }
  }

  /** close tracker: stop observe all conversation and block assert in-flight async streamline for account again side effect. */
  close(): void {
    this.closed = true
    for (const id of [...this.mirrors.keys()]) {
      this.stopObserving(id)
    }
  }

  stopObserving(id: number): void {
    const mirror = this.mirrors.get(id)
    mirror?.detach?.()
    // clean timer and discard await snapshot: delete/stop observe after never out ghost event.
    this.clearLiveTimer(id)
    // context use amount mirror one and clean up: stop observe/after deletion late to refresh via proxy count guard discard, does not resurrect;
    // refresh chain wait for first row resolve(wake come after self inspect cache/metadata and exit, do not forever long suspended).
    this.usage.clearConversation(id)
    // completely clean up the conversation all memory mirror: in-flight turn_settled wait for first resolve(guard against forever long
    // suspended) after whole delete, then clean global settledRuns prefix key. otherwise reverse re- create delete conversation process
    // (CLI/Web manage side) will follow time unbounded accumulated leftover item.
    const settledWaiters = mirror?.settledWaiters ?? []
    for (const resolve of settledWaiters) resolve()
    this.mirrors.delete(id)
    this.lastEntryIds.delete(id)
    for (const runKey of this.settledRuns) {
      if (runKey.startsWith(`${id}:`)) this.settledRuns.delete(runKey)
    }
  }

  /** Scan backwards from tail when the initial 50-entry view window contained only hidden entries. */
  private async scanLatestVisibleEntryId(id: number): Promise<number> {
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation || typeof conversation.entries !== 'function') return 0
    const cuts: RewindInterval[] = []
    let cursor: unknown = undefined
    for (;;) {
      const page = await conversation.entries(
        { order: 'descending' },
        100,
        cursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const raw of page.items as never as ReadonlyArray<EntryRecordLike>) {
        if (raw.kind === 'helm.rewind') {
          const cut = rewindIntervalOf(raw)
          if (cut !== undefined) cuts.push(cut)
        }
        const numeric = Number(raw.id)
        if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
        if (raw.kind === 'pi.system') continue
        if (raw.kind !== 'helm.rewind' && coveredByRewind(numeric, cuts)) continue
        return numeric
      }
      if (page.next === undefined) return 0
      cursor = page.next
    }
  }

  /** clean up live node stream timer(idempotent). */
  private clearLiveTimer(id: number): void {
    const mirror = this.mirrors.get(id)
    const timer = mirror?.liveTimer
    if (timer !== undefined && mirror !== undefined) {
      clearTimeout(timer)
      mirror.liveTimer = undefined
    }
  }

  /** before commit register input metadata (with durable input.id i.e. requestId is append trace identity;
   * submit return after bindSubmission register submissionId related index). */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.mirrorOf(conversationId).trackedInputs
    // same requestId may already has entry/inbox observe rebuild record (such as rewind transaction commit
    // first at register): only patch missing (memory in more complete metadata takes precedence), do not creates new duplicate record.
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
  }

  /** submit return after register submissionId→requestId related index (SDK run.inputs etc.
   * all with submissionId express, via index mapping back append trace identity;HelmError when dropInput
   * remove register). */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.mirrorOf(conversationId).submissionIndex.set(submissionId, requestId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.mirrors.get(conversationId)?.trackedInputs.delete(requestId)
  }

  /** withdraw back queue up commit: clean up related index items and requestId append trace record (withdraw use). */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const resolved = requestId ?? mirror.submissionIndex.get(submissionId)
    mirror.submissionIndex.delete(submissionId)
    if (resolved !== undefined) mirror.trackedInputs.delete(resolved)
  }

  /** this turn (when before run) input manifest (before_turn payload use):run.inputs precise
   * sequence (steer append in inside)+ not yet related submissionId register (submit in-flight),
   * by input.id dedupe unique. */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const run = mirror?.live?.run
    if (!run || !mirror) return []
    const map = mirror.trackedInputs
    const index = mirror.submissionIndex
    const out: ConversationInput[] = []
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    // run.inputs is this run already put placement submissionId precise sequence (contains already consume items),
    // via related index mapping back append trace identity.
    for (const submissionId of run.inputs) {
      const requestId = index.get(submissionId)
      if (requestId !== undefined) collect(map.get(requestId))
    }
    // not yet related submissionId register:submit in-flight (busy in followUp input in manual not put placement).
    const bound = new Set(index.values())
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
    }
    return out
  }

  /** wait for this conversation all in-flight turn_settled call back complete (waitForIdle use, non- global promise). */
  async waitTurnSettled(conversationId: number): Promise<void> {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined && mirror.settledInflight > 0) {
      await new Promise<void>((resolve) => {
        mirror.settledWaiters.push(resolve)
      })
    }
    const settledError = this.mirrors.get(conversationId)?.settledError
    if (settledError !== undefined) throw settledError
  }

  private settledInflightCount(conversationId: number): number {
    return this.mirrors.get(conversationId)?.settledInflight ?? 0
  }

  private beginSettled(conversationId: number): void {
    const mirror = this.mirrorOf(conversationId)
    if (mirror.settledInflight === 0) mirror.settledError = undefined
    mirror.settledInflight += 1
  }

  private endSettled(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.settledInflight === 0) return
    mirror.settledInflight -= 1
    if (mirror.settledInflight > 0) return
    const waiters = mirror.settledWaiters
    mirror.settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** conversation is otherwise has in-flight work (close abort compute decide: idle do not fabricate aborted compute). */
  hasLiveWork(conversationId: number): boolean {
    return this.mirrors.get(conversationId)?.live?.run !== undefined
  }

  /** conversation is otherwise has in progress context streamline task (do not count hasLiveWork, avoid fabricate turn_settled). */
  isCompacting(conversationId: number): boolean {
    return (this.mirrors.get(conversationId)?.live?.compactions?.length ?? 0) > 0
  }

  /** SSE snapshot use real-time view manifest: only leap run, streaming generation or non-empty queued conversation.
   *
   * from live/inbox right threat mirror sync derive (independent of on time push cache): reconnect first frame i.e. restore queue up
   * pill and streaming text; idle conversation does not resurrect (without content can show). */
  listLiveViews(): ConversationLive[] {
    const out: ConversationLive[] = []
    for (const [id, mirror] of this.mirrors) {
      const live = mirror.live
      const inboxItems = mirror.inbox
      const hasRun = live?.run !== undefined
      const hasStream =
        live?.generation !== undefined || (live?.tools?.length ?? 0) > 0 || (live?.nestedTools?.length ?? 0) > 0
      if (!hasRun && !hasStream && (inboxItems?.length ?? 0) === 0) continue
      const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
      // idle conversation only in derive out non-empty queued when keep (queue-only); does not resurrect idle empty live.
      if (!hasRun && !hasStream && (snapshot.queuedInputs?.length ?? 0) === 0) continue
      out.push(snapshot)
    }
    return out
  }

  /** abort compute (runtime.abortConversation invoke; and observe path guard against double report). */
  settleAborted(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    const taskId = mirror?.runTaskId
    if (taskId !== undefined && mirror?.lastSettledRun === taskId) {
      // observe path already compute the run(aborted/failed/completed): does not repeat.
      this.resetRunState(conversationId)
      return
    }
    if (taskId !== undefined) {
      this.noteSettledRun(conversationId, `${conversationId}:${taskId}`)
    }
    const all = this.takeCurrentRunInputs(conversationId)
    this.resetRunState(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
  }

  /** non- leap run state under explicit abort after clean up leftover queue up append trace register (conversation.abort()
   * already withdraw back pi.inbox, will not trigger settleAborted; only in when before without leap live.run when clean up,
   * never trigger touch concurrency start new run). */
  clearQueuedTracking(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.live?.run !== undefined) return
    for (const [submissionId, requestId] of [...mirror.submissionIndex]) {
      mirror.submissionIndex.delete(submissionId)
      mirror.trackedInputs.delete(requestId)
    }
  }

  /** take when before run all input (abort compute): already put placement (run.inputs via index)+ already consume collection +
   * not yet related submissionId register, by input.id dedupe; never iterate history run 
   * append trace record (already compute input no longer re-,origin and duplicate input do not by old history pollute). */
  private takeCurrentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const out: ConversationInput[] = []
    if (mirror === undefined) return out
    const run = mirror.live?.run
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    if (run !== undefined) {
      for (const submissionId of run.inputs) {
        const requestId = mirror.submissionIndex.get(submissionId)
        if (requestId !== undefined) collect(mirror.trackedInputs.get(requestId))
      }
    }
    for (const requestId of mirror.consumedInputs ?? []) {
      collect(mirror.trackedInputs.get(requestId))
    }
    const bound = new Set(mirror.submissionIndex.values())
    for (const [requestId, input] of mirror.trackedInputs) {
      if (!bound.has(requestId)) collect(input)
    }
    mirror.trackedInputs = new Map()
    mirror.submissionIndex = new Map()
    return out
  }

  private resetRunState(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.consumedInputs = undefined
    // runTaskId keep: explicit abort path must it compare lastSettledRun guard against heavy;
    // new run at startup (live.run.taskId change) self however override.
  }

  /** register already compute runKey, and by conversation restrict keep capacity (most old eliminate, guard against without boundary increase long).
   *
   * runId(taskId) all store single tune pass increase: by eliminate most old key cannot can again appear, new run start when
   *  settledRuns.delete(runKey) only effect at most near key (must in capacity inside), semantics do not change. */
  private noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.mirrorOf(conversationId).settledRunOrder
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
  }

  /** from capacity order in remove designate runKey(new run start when sync clean settledRuns use). */
  private dropSettledRunFromOrder(conversationId: number, runKey: string): void {
    const order = this.mirrors.get(conversationId)?.settledRunOrder
    if (order === undefined) return
    const index = order.indexOf(runKey)
    if (index >= 0) order.splice(index, 1)
  }

  private adopt(id: number, view: ConversationView): void {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = mirror.live
    mirror.live = live ?? {}

    // compress failed must not static default: new compactionFailure exactly once error notification.
    this.noteCompactionFailure(id, live)

    // context boundary change (compress/reset/original ground override heavy item persisted, or compress real-time state change):
    // scheduling async refresh (sync dedupe;observe call back inside forbidden await).
    this.usage.noteBoundary(id, view, prev, live)

    // assistant text: window tail part most new pi.assistant entry.
    // encounter helm.rewind / pi.reset immediately stop back scan: original ground override heavy just write truncate mark record (new
    // answer not yet generate) when, mark record before old pi.assistant already by override, never can again trigger
    // onAssistantText old answer re- write FTS5(guard against old answer re- burn).
    for (let i = view.entries.length - 1; i >= 0; i -= 1) {
      const entry = view.entries[i] as
        | { kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }
        | undefined
      if (entry === undefined) continue
      if (entry.kind === 'helm.rewind' || entry.kind === 'pi.reset') break
      if (entry.kind === 'pi.assistant') {
        const text = assistantTextOf(entry)
        if (text !== '') {
          this.events.onAssistantText(id, entry.id, text)
          break
        }
      }
    }

    // helm.input entry observe: only recognize when before run zone between (run.first and after) new item,
    // history helm.input does not resurrect (already compute run input no longer enter trackedInputs).
    const first = mirror.runFirstEntry
    const candidates: Array<Record<string, unknown>> = []
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (first !== undefined && (!Number.isFinite(numeric) || numeric < first)) continue
      candidates.push(raw as unknown as Record<string, unknown>)
    }
    this.adoptInputsFromEntries(id, candidates)
    // inbox queued items same rebuild (busy in followUp/steer input not put placement but must in manual).
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)

    // new written to the database item: by id order for each exactly once (commit order keep,SDK same commit collapse when
    // window still is all order, one by one push enter watermark line).
    this.emitNewEntries(id, view.entries as never as ReadonlyArray<EntryRecordLike>)

    // detect this snapshot is otherwise new pi.compaction item (independent at onEntryCommitted sink).
    const prevSeenEntryId = mirror.lastSeenEntryId
    let nextSeenEntryId = prevSeenEntryId
    let hasNewCompactionEntry = false
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= prevSeenEntryId) continue
      if (numeric > nextSeenEntryId) nextSeenEntryId = numeric
      if (raw.kind === 'pi.compaction') hasNewCompactionEntry = true
    }
    mirror.lastSeenEntryId = nextSeenEntryId

    // streamline task end and not pi.compaction, when before without leap run/the rest streamline task:
    // scheduling async for account (adopt inside strictly forbidden await), screen empty skip vs abort/failed.
    const prevCompactions = prev?.compactions ?? []
    const nextCompactions = live?.compactions ?? []
    const nextTaskIds = new Set(nextCompactions.map((c) => c.taskId))
    const finishedCompactions = prevCompactions.filter((c) => !nextTaskIds.has(c.taskId))
    if (
      finishedCompactions.length > 0 &&
      nextCompactions.length === 0 &&
      !hasNewCompactionEntry &&
      live?.run === undefined
    ) {
      void this.reconcileFinishedCompaction(id, mirror.observeGeneration, finishedCompactions)
    }

    // Update latest visible entry watermark before emitSettled / emitRunSummary so emitted upserts carry it.
    const prevLastEntryId = this.lastEntryIds.get(id) ?? this.store.getConv(id)?.lastEntryId ?? 0
    const windowLatestVisible = latestVisibleEntryIdOf(view.entries as never as ReadonlyArray<EntryRecordLike>)
    const nextLastEntryId = Math.max(prevLastEntryId, windowLatestVisible)
    const lastEntryAdvanced = nextLastEntryId > prevLastEntryId
    if (lastEntryAdvanced) {
      this.lastEntryIds.set(id, nextLastEntryId)
      this.store.setLastEntryId?.(id, nextLastEntryId)
    }

    // first compute already end prev run(contains same snapshot collapse:run1 end + run2 start same commit).
    let settledInAdopt = false
    if (prev?.run && (!live?.run || live.run.taskId !== prev.run.taskId)) {
      settledInAdopt = true
      const prevRun = prev.run
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.noteSettledRun(id, runKey)
        mirror.lastSettledRun = prevRun.taskId
        const failure = live?.runFailure
        if (failure && failure.taskId === prevRun.taskId) {
          for (const submissionId of failure.inputs) this.markConsumed(id, submissionId)
          const consumed = this.takeConsumed(id)
          if (failure.reason === 'aborted') {
            // abort terminal state (observe path): once aborted compute, no longer away failed.
            this.emitSettled(id, 'aborted', consumed, undefined)
          } else {
            this.emitSettled(
              id,
              'failed',
              consumed,
              `${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`,
            )
          }
        } else {
          const consumed = this.takeConsumed(id)
          this.emitSettled(id, 'completed', consumed, undefined)
        }
      }
      this.resetRunState(id)
      // input rebuild under boundary single tune push enter to this snapshot tail part: already compute run all item (contains its
      // helm.input) into is history, after continue snapshot window again scan to also does not resurrect.
      const tail = view.entries.length
        ? Number((view.entries[view.entries.length - 1] as EntryRecordLike).id)
        : undefined
      if (tail !== undefined && Number.isFinite(tail)) {
        if (mirror.runFirstEntry === undefined || tail > mirror.runFirstEntry) mirror.runFirstEntry = tail
      }
    }

    if (live?.run) {
      const runKey = `${id}:${live.run.taskId}`
      if (mirror.runTaskId !== live.run.taskId) {
        // new run start: reset this turn consume collection (same run many tool round do not reset).
        mirror.runTaskId = live.run.taskId
        mirror.consumedInputs = new Set<string>()
        this.settledRuns.delete(runKey)
        this.dropSettledRunFromOrder(id, runKey)
        const first = live.run.first !== undefined ? Number(live.run.first) : undefined
        if (first !== undefined) {
          if (mirror.runFirstEntry === undefined || first > mirror.runFirstEntry) mirror.runFirstEntry = first
        }
      }
      for (const submissionId of live.run.inputs) {
        this.markConsumed(id, submissionId)
      }
      // complete phase (answered,inputs empty) do not motion consumedInputs- - keep already consume record.
    }

    // real-time view: node stream push (terminal state in emitSettled inside force conflict refresh).
    this.emitLiveThrottled(id, live)
    // run leap during real-time summary:run start and doing semantics change (first token before i.e. has working).
    this.emitRunSummary(id)
    // When idle visible entries advance without a run settlement (e.g. compaction, reset, rewind, or write),
    // push conversation.upsert so reconnect SWR watermarks stay current.
    if (!settledInAdopt && !live?.run && lastEntryAdvanced && this.store.getConv(id) !== undefined) {
      const summary = this.summaryOf(id)
      this.mirrorOf(id).lastSummaryKey = summaryKeyOf(summary)
      this.events.onSummaryChanged(summary)
    }
  }

  /** new written to the database item: by id order push enter watermark line, each exactly once. */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.events.onEntryCommitted
    if (sink === undefined) return
    const mirror = this.mirrors.get(id)
    let watermark = mirror?.lastEmittedEntry ?? 0
    let advanced = false
    for (const raw of entries) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= watermark) continue
      // convert failed (non- JSON payload) explicit throw:SDK will with listener_error end observe,
      // never static default discard or fabricate fall back (honest discipline).
      sink(id, toConversationEntry(raw))
      watermark = numeric
      advanced = true
    }
    if (advanced && mirror !== undefined) mirror.lastEmittedEntry = watermark
  }

  /** node stream push real-time view: window inside only keep most new snapshot, same content does not resend frame.
   *
   * queuedInputs change (queue/out queue) bypass 75ms node stream immediately conflict refresh: user commit
   * steer / followUp after timeline tail part pill as soon as possible visible (subject to observe commit when order affect). */
  private emitLiveThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.events.onLiveChanged === undefined) return
    const mirror = this.mirrors.get(id)
    const inboxItems = mirror?.inbox
    const queuedEmpty =
      !live?.run &&
      !live?.generation &&
      (live?.tools?.length ?? 0) === 0 &&
      (live?.nestedTools?.length ?? 0) === 0 &&
      (inboxItems?.length ?? 0) === 0
    if (queuedEmpty) {
      // idle view do not push (terminal state conflict refresh by emitSettled negative duty); but before queued,
      // now right threat inbox already empty when cannot short route discard clean up frame (otherwise client pill leftover).
      const prevQueued = mirror?.lastQueuedLiveKey
      if (prevQueued === undefined || prevQueued === '[]') return
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendLiveNow(id, cleanup)
      return
    }
    const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
    const key = this.liveKeyOf(snapshot)
    // on time already queued refer grain unify semantics: not register treated as empty queue '[]'(first time empty queue
    // do not therefore mistakenly immediately conflict refresh path); only queue change bypass 75ms node stream.
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    const prevQueuedKey = mirror?.lastQueuedLiveKey ?? '[]'
    if (key === mirror?.lastLiveKey && queuedKey === prevQueuedKey) return
    if (queuedKey !== prevQueuedKey) {
      // queue/out queue real-time takes precedence: clean timer sync conflict refresh, do not etc. 75ms node stream.
      this.clearLiveTimer(id)
      this.sendLiveNow(id, snapshot)
      return
    }
    const m = this.mirrorOf(id)
    m.pendingLive = snapshot
    if (m.liveTimer !== undefined) return
    const timer = setTimeout(() => {
      m.liveTimer = undefined
      this.flushPendingLive(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    m.liveTimer = timer
  }

  /** live frame content refer grain:text/thinking/tools/generation/queuedInputs(send and dedupe two where shared use the same public style).
   * generation reference and refer grain: pure tool-call parameter streaming during text/thinking constant empty,
   * do not count generation then parameter increase long fully do not frame. */
  private liveKeyOf(snapshot: ConversationLive): string {
    return JSON.stringify([
      snapshot.text,
      snapshot.thinking ?? '',
      snapshot.tools,
      snapshot.generation ?? null,
      snapshot.queuedInputs ?? [],
    ])
  }

  /** sync send one frame live(terminal state conflict refresh / queued clean up shared use): register two where refer grain. */
  private sendLiveNow(id: number, snapshot: ConversationLive): void {
    this.clearLiveTimer(id)
    const mirror = this.mirrorOf(id)
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** conflict refresh window inside await snapshot (timer expires or queuedInputs change immediately conflict refresh). */
  private flushPendingLive(id: number): void {
    const mirror = this.mirrors.get(id)
    const snapshot = mirror?.pendingLive
    if (mirror === undefined || snapshot === undefined) return
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** terminal state force conflict refresh: with when before live mirror is allow sync frame (clean timer, discard expired window snapshot). */
  private flushLiveFinal(conversationId: number): void {
    this.clearLiveTimer(conversationId)
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.pendingLive = undefined
    if (this.events.onLiveChanged === undefined) return
    const snapshot = deriveConversationLive(
      conversationId,
      mirror?.live,
      Date.now(),
      mirror?.inbox,
    )
    const key = this.liveKeyOf(snapshot)
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    if (key === mirror?.lastLiveKey && queuedKey === (mirror?.lastQueuedLiveKey ?? '[]')) return
    const m = this.mirrorOf(conversationId)
    m.lastLiveKey = key
    m.lastQueuedLiveKey = queuedKey
    this.events.onLiveChanged(snapshot)
  }

  /** from helm.input entry data register input (by input.id i.e. requestId idempotent merge unique record).
   *
   * happy path register/bind already has right threat record:entry observe only back fill metadata missing opening (origin/
   * meta/attachments), do not creates new duplicate record. */
  private adoptInputsFromEntries(id: number, entries: ReadonlyArray<unknown>): void {
    for (const raw of entries) {
      const entry = raw as { kind?: string; data?: unknown }
      // self define input entry:SDK pickInputEntry  {kind:'helm.input', data} write
      // entry.data,model only carry UserMessage(do not in model[0].data).
      if (entry?.kind !== 'helm.input') continue
      const meta = entry.data as HelmInputMeta | undefined
      if (!meta || typeof meta.id !== 'string' || typeof meta.text !== 'string') continue
      this.upsertTrackedInput(id, meta.id, meta)
    }
  }

  /** single helm.input metadata register/merge (by input.id idempotent, unique record; caller already
   * validate meta.id/text is string). */
  private upsertTrackedInput(id: number, requestId: string, meta: HelmInputMeta): void {
    const map = this.mirrorOf(id).trackedInputs
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    map.set(requestId, existing === undefined ? rebuilt : mergeInputMeta(existing, rebuilt))
  }

  /** mark record submissionId already by when before run consume: via related index mapping back requestId after
   * exactly once register (onInputCommitted exactly once). index missing (bind/back fill not yet occur) when
   * static default skip, under once snapshot heavy scan run.inputs when patch record. */
  private markConsumed(conversationId: number, submissionId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const requestId = mirror.submissionIndex.get(submissionId)
    const input = requestId === undefined ? undefined : mirror.trackedInputs.get(requestId)
    if (!input) return
    const consumedSet = mirror.consumedInputs ?? new Set<string>()
    if (consumedSet.has(input.id)) return
    consumedSet.add(input.id)
    mirror.consumedInputs = consumedSet
    this.events.onInputCommitted(conversationId, input)
  }

  /** compute take this run already consume input and clean up register:requestId set each items exactly a record,
   * append trace record and related index one and clear, history does not resurrect. */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const consumedSet = mirror?.consumedInputs
    const out: ConversationInput[] = []
    if (mirror !== undefined && consumedSet !== undefined) {
      for (const requestId of consumedSet) {
        const input = mirror.trackedInputs.get(requestId)
        if (input !== undefined) out.push(input)
      }
      // already compute input append trace record and index items one and clear.
      for (const [submissionId, requestId] of mirror.submissionIndex) {
        if (consumedSet.has(requestId)) mirror.submissionIndex.delete(submissionId)
      }
      for (const requestId of consumedSet) mirror.trackedInputs.delete(requestId)
    }
    if (mirror !== undefined) mirror.consumedInputs = undefined
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const generation = this.mirrors.get(conversationId)?.observeGeneration
    this.beginSettled(conversationId)
    let completion: Promise<void> | void
    try {
      // real-time view terminal state conflict refresh: first at turn_settled out (empty tools/text means stream end).
      this.flushLiveFinal(conversationId)
      // first push enter durable watermark, again construct compute snapshot; plugin and read interface observe the same terminal state.
      // completionSeq push enter + unread placement (human explicit patch only then clean zero).
      // background derive sub-conversation (ownedBy non- human and has parent chain, such as managed subagent / SuperAgent
      // Worker) complete do not fabricate person class not read; person class fork(has parent chain but human ownership) and top-level
      // direct connect conversation keep unread semantics. failed/abort one rule do not placement unread(since has contract).
      const meta = this.store.getConv(conversationId)
      if (meta) {
        const unread = outcome === 'completed' && !this.isBackgroundDerived(conversationId, meta)
        const updated: ConvMeta = {
          ...meta,
          unread,
          completionSeq: meta.completionSeq + 1,
          stateChangeSeq: meta.stateChangeSeq + 1,
          updatedAt: Date.now(),
        }
        this.store.upsertConv(updated)
        const settledStatus = unread ? 'done' : statusNow(updated, outcome)
        // failed terminal state diagnose summary and summaryOf same source:emitSettled do not via tracker derive path,
        // must in this same carry lastError(otherwise first conversation.upsert event leak reason);
        // contextUsage same from sync cache additional (compute frame after async refresh again new value frame).
        const settledRaw = summaryOf(
          updated,
          settledStatus,
          0,
          undefined,
          settledStatus === 'error' ? lastErrorOf(this.mirrors.get(conversationId)?.live, this.redactError) : undefined,
          this.lastEntryIds.get(conversationId) ?? updated.lastEntryId ?? 0,
        )
        const cachedUsage = this.usage.peek(conversationId)
        const settledSummary = cachedUsage === undefined ? settledRaw : { ...settledRaw, contextUsage: cachedUsage }
        // terminal state summary register semantics refer grain: after continue idle snapshot does not repeat push the same terminal state.
        this.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(settledSummary)
        this.events.onSummaryChanged(settledSummary)
        // turn compute after context already set: async refresh use amount (change only then patch upsert; do not push enter seq).
        this.usage.schedule(conversationId, { publishWhenReady: cachedUsage === undefined })
      }
      const payload: TurnSettledPayload = {
        conversation: this.summaryOf(conversationId, outcome),
        inputs,
        outcome,
        error,
        settledAt: Date.now(),
      }
      completion = this.events.onTurnSettled(payload, inputs)
    } catch (error) {
      this.endSettled(conversationId)
      throw error
    }
    if (completion === undefined) {
      this.endSettled(conversationId)
    } else {
      void completion.then(
        () => {
          if (this.mirrors.get(conversationId)?.observeGeneration === generation) this.endSettled(conversationId)
        },
        (error: unknown) => {
          const mirror = this.mirrors.get(conversationId)
          if (mirror === undefined || mirror.observeGeneration !== generation) return
          mirror.settledError = error
          this.endSettled(conversationId)
        },
      )
    }
  }

  /** background derive sub-conversation decide: has parent chain and ownership non- human(managed subagent / Worker etc.).
   * ownership call back default or failed to read (contains deleted) one rule by human handle - - rather many read do not leak report,
   * never because ownership do not while swallow person class not read notify. */
  private isBackgroundDerived(conversationId: number, meta: ConvMeta): boolean {
    if (meta.parentConversationId === undefined) return false
    if (this.ownershipOf === undefined) return false
    try {
      return this.ownershipOf(conversationId) !== 'human'
    } catch {
      return false
    }
  }

  /** by store meta + live mirror derive five state (blocked takes precedence at working derive conflict when). */  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.store.getConv(conversationId)
    if (!meta) throw new HelmError('not_found', `conversation missing:${conversationId}`, 404)
    const mirror = this.mirrors.get(conversationId)
    const live = mirror?.live
    const pendingAsks =
      typeof pendingAskOverride === 'number'
        ? pendingAskOverride
        : (mirror?.pendingAskCount ?? 0)
    let status: ConversationStatus
    if (pendingAskOverride === 'aborted') {
      status = 'idle'
    } else if (pendingAsks > 0) {
      // await answer approval override run state, directly expose when before person class decide policy point.
      status = 'blocked'
    } else if (live?.run) {
      status = 'working'
    } else if (live?.runFailure && live.runFailure.reason !== 'aborted') {
      status = 'error'
    } else {
      status = meta.unread ? 'done' : 'idle'
    }
    const doing = live?.run
      ? live.tools && live.tools.length > 0
        ? `${live.tools[live.tools.length - 1]?.name}: ${live.tools[live.tools.length - 1]?.status ?? 'running'}`
        : 'thinking...'
      : undefined
    // failed diagnose summary only follow error state carry (new run after startup live.runFailure by clear, self however sync disappear).
    const lastError = status === 'error' ? lastErrorOf(live, this.redactError) : undefined
    const lastEntryId = this.lastEntryIds.get(conversationId) ?? meta.lastEntryId ?? 0
    const summary = summaryOf(meta, status, pendingAsks, doing, lastError, lastEntryId)
    const usage = this.usage.cachedOrSchedule(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
  }

  /** scheduling async context use amount refresh (delegate refresh chain module; for outside port keep to service/ops consumer). */
  scheduleContextUsageRefresh(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    this.usage.schedule(conversationId, options)
  }

  /** models.changed after set to force complete context use amount cache.
   *
   * directory refresh/set rebuild may let the same model window from unknown change known (or reverse, count value change,
   * provider no longer supply should): already observe/already cache conversation old use amount must append on, otherwise idle conversation
   * do not new input then forever stop in old window. only scheduling since has refresh chain (in-flight placement dirty force complete,
   * proxy count guard, refer grain dedupe), no new async mechanism, does not trigger LLM request;usage-only
   * update do not push enter stateChangeSeq(applyContextUsage since has discipline).
   *
   * - providers non-empty: only refresh takes effect model belongs to these provider conversation (event set to);
   * - providers empty: directory whole may already swap, all append complete;
   * - only see already observe (mirror inside has observe proxy count) or already has use amount cache conversation: do not scan all amount history
   *   conversation (startup phase/large directory under expensive N time scan), not observe and not cache conversation first time
   *   wave take when self however by new directory compute.
   */
  onModelsChanged(providers: readonly string[]): void {
    const wanted = providers.length > 0 ? new Set(providers) : undefined
    const targets = new Set([...this.usage.cachedConversationIds(), ...this.observedConversationIds()])
    for (const id of targets) {
      const meta = this.store.getConv(id)
      if (!meta || meta.model === '') continue
      const slash = meta.model.indexOf('/')
      const provider = slash > 0 ? meta.model.slice(0, slash) : meta.model
      if (wanted !== undefined && !wanted.has(provider)) continue
      this.usage.schedule(id)
    }
  }

  /** already observe conversation manifest (mirror memory in observe proxy count; and migration before observeGenerations key domain consistent). */
  private observedConversationIds(): number[] {
    const out: number[] = []
    for (const [id, mirror] of this.mirrors) {
      if (mirror.observeGeneration !== undefined) out.push(id)
    }
    return out
  }

  /** ensure the conversation contextUsage cache already fill and refresh chain archive silent (first detail situation read etc. sync visible path). */
  async ensureContextUsage(conversationId: number): Promise<void> {
    await this.usage.ensure(conversationId)
  }

  /** compress failed must not static default: new compactionFailure(by taskId dedupe, the same failed
   * duplicate snapshot does not repeat notify) once redaction error notification.SDK only in under once succeeded
   * compress when clear compactionFailure, after success new failed is all new taskId, self however again report. */
  private noteCompactionFailure(id: number, live: LiveStateShape | undefined): void {
    const failure = live?.compactionFailure
    if (failure === undefined) return
    if (this.notifiedCompactionFailures.get(id) === failure.taskId) return
    this.notifiedCompactionFailures.set(id, failure.taskId)
    this.events.onNotification?.({
      level: 'error',
      title: 'context streamline failed',
      body: compactionFailureNoticeOf(failure, this.redactError),
      conversationId: id,
    })
  }

  /**
   * without pi.compaction streamline end async for account (adopt sync snapshot outside execute):
   * - one by one task query right threat terminal state, only when store in clean complete (status='terminal' and
   *   outcome.status='completed', without summary write and non- compactionFailure) when treated as
   *   empty skip (selectCut === undefined or beforeCompact decline);
   * - aborted / failed task one rule ignore (never mistakenly report when before context no need to streamline, also never in
   *   not streamline context on without permission conflict refresh queue up input);
   * - confirm clean empty skip after: if has manual trigger info notify; if inbox still has steer/followUp
   *   queue up input and when before idle without compress, via continue automatically start under one turn.
   */
  private async reconcileFinishedCompaction(
    id: number,
    generation: symbol | undefined,
    finished: ReadonlyArray<{ taskId: number; trigger: string; blocking: boolean }>,
  ): Promise<void> {
    try {
      if (this.isClosing || !this.store.getConv(id)) return
      const initialMirror = this.mirrors.get(id)
      if (initialMirror === undefined || initialMirror.observeGeneration !== generation) return

      let hasCleanEmpty = false
      let hasManualEmpty = false
      for (const task of finished) {
        const record = await this.harness.getTask(task.taskId as never, BACKGROUND_CONTEXT)
        if (this.isClosing || !this.store.getConv(id)) return
        const currentMirror = this.mirrors.get(id)
        if (currentMirror === undefined || currentMirror.observeGeneration !== generation) return
        if (record === undefined) continue
        if (record.state.status !== 'terminal' || record.state.outcome.status !== 'completed') continue
        if (currentMirror.live?.compactionFailure?.taskId === task.taskId) continue
        const result = record.state.outcome.result as { entryId?: unknown; submissionId?: unknown } | undefined
        if (result?.entryId !== undefined || result?.submissionId !== undefined) continue
        hasCleanEmpty = true
        if (task.trigger === 'manual') hasManualEmpty = true
      }
      if (!hasCleanEmpty) return

      const mirror = this.mirrors.get(id)
      if (mirror === undefined || mirror.observeGeneration !== generation) return

      if (hasManualEmpty) {
        this.events.onNotification?.({
          level: 'info',
          title: 'when before context no need to streamline',
          body: 'history message not exceeds keep window, not generate new summary.',
          conversationId: id,
        })
      }

      const hasQueuedInputs = (mirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!hasQueuedInputs || mirror.live?.run !== undefined || (mirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      const conv = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (this.isClosing || !this.store.getConv(id)) return
      const latestMirror = this.mirrors.get(id)
      if (latestMirror === undefined || latestMirror.observeGeneration !== generation) return
      const stillQueued = (latestMirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!stillQueued || latestMirror.live?.run !== undefined || (latestMirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      try {
        await conv?.submit({ type: 'continue' }, BACKGROUND_CONTEXT)
      } catch (error) {
        const name = (error as { name?: string })?.name
        const code = (error as { code?: string })?.code
        if (name === 'ConversationBusy' || code === 'not_found') return
        throw error
      }
    } catch (error) {
      if (this.isClosing) return
      this.reportDiagnostic({
        level: 'error',
        source: 'tracker.compaction',
        message: 'streamline end for account failed',
        error,
        conversationId: id,
      })
    }
  }

  setPendingAskCount(conversationId: number, count: number): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.pendingAskCount
    if (prev === count) return
    mirror.pendingAskCount = count
    // seq durable pass increase:pendingAsk change is state change (CAS watermark line dependency).
    const meta = this.store.getConv(conversationId)
    if (meta) {
      const updated: ConvMeta = {
        ...meta,
        stateChangeSeq: meta.stateChangeSeq + 1,
        updatedAt: Date.now(),
      }
      this.store.upsertConv(updated)
    }
    const summary = this.summaryOf(conversationId, count)
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.events.onSummaryChanged(summary)
  }

  /** run leap during real-time summary push:run start and doing semantics change when each exactly once.
   *
   * - only when this snapshot store in leap run only then push (only may appear working/blocked two state);
   *   terminal state one rule by emitSettled negative duty:adopt does not repeat compute, does not resurrect already compute turn;
   * - with (status, doing, pendingAskCount) semantics refer grain dedupe: pure streaming token push enter
   *   (doing do not change) do not push, do not one by one token summary;
   * - stateChangeSeq follow real state change single tune push enter (protocol contract), and setPendingAskCount
   *   the same mechanism;live node stream window (75ms) do not subject to affect.
   */
  private emitRunSummary(id: number): void {
    const mirror = this.mirrors.get(id)
    if (!mirror?.live?.run) return
    const meta = this.store.getConv(id)
    if (!meta) return
    if (mirror.lastSummaryKey === summaryKeyOf(this.summaryOf(id))) return
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.summaryOf(id)
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.events.onSummaryChanged(summary)
  }

  /** observe to most new assistant text (getLastAssistantText data source). */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.lastAssistant
    if (prev !== undefined && prev.entryId === entryId) return
    mirror.lastAssistant = { entryId, text }
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.mirrors.get(conversationId)?.lastAssistant?.text
  }

  /** expires rewind override zone between lastAssistant cache (original ground override heavy after).
   *
   * only when cache points to entry in [from, through] inside only then clear: new answer on failure
   * getLastAssistantText must not return already by override old answer proposal, while zone between outside (more early turn)
   * cache still valid.*/
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    const mirror = this.mirrors.get(conversationId)
    const cached = mirror?.lastAssistant
    if (cached === undefined) return
    if (cached.entryId >= from && cached.entryId <= through) {
      mirror!.lastAssistant = undefined
    }
  }
}

function statusNow(meta: ConvMeta, outcome: TurnOutcome): ConversationStatus {
  if (outcome === 'failed') return 'error'
  if (outcome === 'aborted') return 'idle'
  return meta.unread ? 'done' : 'idle'
}

/** summary semantics refer grain:status/doing/pendingAskCount/lastError(the rest field does not participate push dedupe). */
function summaryKeyOf(summary: ConversationSummary): string {
  return `${summary.status}|${summary.doing ?? ''}|${summary.pendingAskCount}|${summary.lastError ?? ''}`
}

/** from live.runFailure construct can read diagnose summary ('reason: detail';aborted/reset non- failed does not carry). */
function lastErrorOf(
  live: LiveStateShape | undefined,
  redact: (text: string) => string,
): string | undefined {
  const failure = live?.runFailure
  if (!failure || failure.reason === 'aborted' || failure.reason === 'reset') return undefined
  const detail =
    typeof failure.detail === 'string' && failure.detail.trim() !== ''
      ? `: ${redact(failure.detail).slice(0, 400)}`
      : ''
  return `${failure.reason}${detail}`
}

// input append trace identity i.e. durable input.id(requestId), no need to temporary key allocate.

/** extract assistant entry text chunk content. */
function assistantTextOf(entry: {
  model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }>
}): string {
  const blocks = entry.model?.[0]?.content
  if (!blocks) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export { deriveTitle }

/** Compute latest visible entry ID (excluding `pi.system` and entries covered by `helm.rewind`; `0` when none). */
function latestVisibleEntryIdOf(entries: ReadonlyArray<EntryRecordLike>): number {
  const cuts: RewindInterval[] = []
  for (const raw of entries) {
    if (raw.kind !== 'helm.rewind') continue
    const cut = rewindIntervalOf(raw)
    if (cut !== undefined) cuts.push(cut)
  }
  let latest = 0
  for (const raw of entries) {
    const numeric = Number(raw.id)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
    if (raw.kind === 'pi.system') continue
    if (raw.kind !== 'helm.rewind' && coveredByRewind(numeric, cuts)) continue
    if (numeric > latest) latest = numeric
  }
  return latest
}

/** first input title: strip code chunk and newline, take before 36 valid character. */
function deriveTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 36) || 'new conversation'
}
