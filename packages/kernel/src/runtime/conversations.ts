/**
 * ConversationTracker: pi-durable conversation view layer for Helmx.
 *
 * Core mechanism: observeConversation synchronous observer (never awaits inside advance, only records),
 * synchronously updating in-memory mirrors on snapshot pushes and queuing side effects (SSE pushes emit in microtasks).
 *
 * State layout (see conversation-mirror.ts / context-usage-refresh.ts):
 * - All per-conversation runtime state aggregates into a single ConversationMirror (mirrors), reclaimed cleanly as a whole
 *   on stopObserving; cross-conversation indexes (settledRuns deduplication set) and compaction failure flags that must
 *   survive stopObserving (notifiedCompactionFailures) stay at tracker top-level;
 * - contextUsage caching and refresh chaining are isolated in ContextUsageRefresh (in-flight refreshes can outlive stopObserving).
 *
 * Exact turn_settled tracking:
 * - Inputs use durable input.id (i.e., SDK requestId) as the unique tracking identity: registerInput registers before submit,
 *   and bindSubmission backfills the submissionId -> requestId correlation index;
 * - Observe paths (helmx.input entries / pi.inbox reconstruction) idempotently merge into the single record by requestId;
 *   entry reconstruction only counts the active run window (>= run.first) and current inbox so settled historical helmx.input
 *   never resurrects; on restart recovery of active runs, live.run.inputs authoritative manifest + submission queries backfill
 *   metadata and indexes;
 * - Runs are identified by LOGICAL identity, not by pi.live.run.taskId: pi-durable hands run control to a new generation
 *   task after every tool round and on onYield continuations (handOver), so taskId changes while the run continues (first
 *   entry kept, inputs carried over). Same-run handOver accumulates consumed inputs across rounds; only a true run end or
 *   replacement (run disappears, or a snapshot carries a different logical run) settles;
 * - Run disappearance (complete/fail) settles exactly once (settledRuns prevents duplicate reports; failures use the
 *   exact runFailure.inputs manifest);
 * - Explicit abort via runtime.abortConversation settles immediately (observe path does not double-report);
 * - Explicit abort after observing failure only patches aborted without re-emitting failure;
 * - While a run is active, live summaries emit on start / semantic doing changes (emitRunSummary, deduplicated at
 *   semantic granularity rather than per token; emitSettled remains solely responsible for terminal state).
 */

import type {
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationStatus,
  ConversationSummary,
  HubActivityCounts,
  TurnOutcome,
  TurnSettledPayload,
} from '@helmx/protocol'
import { HelmxError, isHubActivityBusy } from '@helmx/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConvMeta, HelmxStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'
import { coveredByRewind, rewindIntervalOf, type RewindInterval } from './runtime-helpers.js'
import { emitDiagnostic, type KernelDiagnosticInput, type KernelDiagnosticSink } from './diagnostics.js'
import { compactionFailureNoticeOf } from './context-usage.js'
import { ContextUsageRefresh, type ContextUsageHost } from './context-usage-refresh.js'
import {
  type ConversationMirror,
  createConversationMirror,
  type HelmxInputMeta,
  type InboxItemShape,
  inputFromMeta,
  type LiveStateShape,
  mergeInputMeta,
} from './conversation-mirror.js'

export type { LiveStateShape }

interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): Promise<void> | void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
  /** New timeline entry persisted to store (new items only, once per ID; omits historical entries from initial observe). */
  onEntryCommitted?(conversationId: number, entry: ConversationEntry): void
  /** Live conversation delta (accumulated streaming text snapshot + tool cards; throttled pushes, flushed at settlement). */
  onLiveChanged?(live: ConversationLive): void
  /** Asynchronous failures such as compaction failure reported once explicitly via EventHub notification channel. */
  onNotification?(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string; conversationId: number }): void
}

/** Live throttling window (ms): 75ms inside 50-100ms range balances SSE frame rate against commit load. */
const LIVE_THROTTLE_MS = 75

/** Max settled runs retained per conversation (prevents unbounded growth in 24/7 operation; runIds are monotonic so oldest are evicted). */
const SETTLED_RUNS_PER_CONVERSATION = 64

/** Run shape used by logical-run identity comparison (subset of LiveStateShape.run). */
export interface RunIdentityShape {
  taskId: number
  inputs: number[]
  first?: number
}

/**
 * Whether `next` is the SAME logical run as `prev` after a pi-durable handOver.
 *
 * pi-durable 1.5.x hands run control from one generation task to the next after every tool round and on onYield
 * continuations: `pi.live.run.taskId` changes while the run continues — `first` (the run's first entry) is kept and
 * the previous inputs are carried over (possibly grown by steers admitted at the boundary). A genuinely new run gets
 * a fresh `first` (boundary-placed entry, strictly newer) and disjoint inputs. When `first` was never recorded on
 * either side, fall back to inputs carry-over; ambiguity resolves to "new run" (settle) which matches the
 * run-disappearance semantics.
 */
export function isContinuedRun(prev: RunIdentityShape, next: RunIdentityShape | undefined): boolean {
  if (next === undefined) return false
  if (next.taskId === prev.taskId) return true
  if (prev.first !== undefined && next.first !== undefined) return next.first === prev.first
  return prev.inputs.length > 0 && prev.inputs.every((id) => next.inputs.includes(id))
}

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmxStore
  private readonly events: TrackerEvents
  /** conversation -> per-conversation aggregate mirror (created on observe or first write; deleted wholesale on stopObserving). */
  private readonly mirrors = new Map<number, ConversationMirror>()
  /** Already-settled runs (prevents done+failure+abort double reporting). Keyed globally with conversation prefix (`${id}:${taskId}`)
   * outside mirror so it persists cleanly and is swept by prefix on stopObserving. */
  private readonly settledRuns = new Set<string>()
  /** Idle→busy transition listeners (activity heartbeat; see `onActivityBusyEntered`). */
  private readonly activityBusyListeners = new Set<() => void>()
  /** Last computed aggregate busy predicate (drives idle→busy transition detection). */
  private activityBusyAggregate = false
  /** conversation -> taskId of last notified compaction failure (prevents duplicate notifications across snapshots;
   * intentionally survives stopObserving so re-observing within the same runtime never re-notifies the same failure). */
  private readonly notifiedCompactionFailures = new Map<number, number>()
  /** contextUsage cache/refresh chain (in-flight refreshes can outlive stopObserving, state stays outside mirror). */
  private readonly usage: ContextUsageRefresh
  /** conversation -> latest visible timeline entry ID (`0` when none; excludes `pi.system` and rewound intervals). */
  private readonly lastEntryIds = new Map<number, number>()
  /** Tracker shutdown guard (blocks late async reconciliation side effects after close() or host isClosed becomes true). */
  private closed = false

  constructor(options: {
    harness: Harness
    store: HelmxStore
    events: TrackerEvents
    /** Error summary redactor (shared source with runtime SecretStash); defaults to identity (test environments only). */
    redactError?: (text: string) => string
    /** Current conversation ownership reader (injected by Runtime via ownership.getOwnership); defaults to human.
     * Used solely for unread policy on turn settlement so background derived sub-conversations never mark fake human unreads. */
    ownershipOf?: (id: number) => 'helmx' | 'bot' | 'human'
    /** Current Models catalog reader (for contextUsage window lookup); if omitted, contextWindow stays unset without fabricating. */
    models?: () => Models
    /** Host closing predicate (double protection alongside tracker.close()). */
    isClosed?: () => boolean
    /** Diagnostic channel sink (defaults to defaultDiagnosticSink). */
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

  /** Error summary redactor (Runtime injects stashService.redact so provider errors cannot echo registered secrets). */
  private readonly redactError: (text: string) => string

  /** Diagnostic channel sink (injectable after Runtime construction; defaults to defaultDiagnosticSink). */
  private diagnosticSink: KernelDiagnosticSink | undefined

  /** Attach or replace the diagnostic sink (wired during KernelRuntime construction). */
  setDiagnosticSink(sink: KernelDiagnosticSink | undefined): void {
    this.diagnosticSink = sink
  }

  private reportDiagnostic(input: KernelDiagnosticInput): void {
    emitDiagnostic(this.diagnosticSink, this.redactError, input)
  }

  /** Live conversation ownership reader (defaults to human); consumed solely by unread policy on turn settlement. */
  private readonly ownershipOf: ((id: number) => 'helmx' | 'bot' | 'human') | undefined

  /** Live Models catalog reader (if omitted, window stays unset). */
  private readonly modelsOf: (() => Models) | undefined

  /** Host closing state reader (defaults to false; double guard alongside tracker.closed). */
  private readonly isClosedFn: (() => boolean) | undefined

  private get isClosing(): boolean {
    return this.closed || (this.isClosedFn?.() ?? false)
  }

  /** Get (creating if needed) the mirror for a conversation: single entry point for all write paths. */
  private mirrorOf(id: number): ConversationMirror {
    let mirror = this.mirrors.get(id)
    if (mirror === undefined) {
      mirror = createConversationMirror()
      this.mirrors.set(id, mirror)
    }
    return mirror
  }

  /** Attach a synchronous observer to the conversation; backfills authoritative input metadata for active runs before returning. */
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
    // Initial snapshot: do not replay existing items in the window (first attach only aligns watermarks).
    // Generation guard: if stopObserving runs (or re-observe swaps generation) across await, skip writing back to mirror.
    const generation = Symbol('conversation observation')
    mirror.observeGeneration = generation
    await this.adoptInitial(id, observation.value, generation)
  }

  /** Initial attachment: registers watermarks and internal mirrors without emitting entry/live events.
   *
   * When recovering an active run (restart/re-attach), the run's helmx.input entry may have slid out of the
   * observe window on long runs, causing synchronous reconstruction to lose input metadata. We backfill via
   * SDK authoritative mappings: live.run.inputs gives the exact submissionIds admitted to this run, which we look
   * up via harness.submission() for entry IDs and fetch precisely (minEntryId=maxEntryId) to restore origin/meta/attachments;
   * queued items come from pi.inbox. Never rely on widening the observe window or heuristic sorting instead. */
  private async adoptInitial(
    id: number,
    view: ConversationView,
    generation: symbol,
  ): Promise<void> {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    mirror.live = live ?? {}
    // Report lingering compaction failures even right after restart/re-attach (once per runtime lifecycle).
    this.noteCompactionFailure(id, live)
    let watermark = mirror.lastEmittedEntry
    // Align context trigger watermark with entry event watermark so historical compaction markers in the initial
    // snapshot do not trigger duplicate refreshes on subsequent adopts (initial refresh is scheduled below).
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
    // Register inbox mirror before checking live.run: even after a restart/stopped run with queued inputs remaining,
    // queuedInputs derivation and listLiveViews snapshots preserve queued state honestly without fabricating UI queues.
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)
    // Populate context usage cache on initial attach (initial read path for restart/fork/new conversations),
    // including idle conversations so opening a historical conversation displays its usage pill.
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
    // Admitted inputs for this run: back-read entry via authoritative SDK submissionId -> entry mapping,
    // registering requestId tracking records and submissionId -> requestId indexes so markConsumed hits.
    const loaded = await this.loadRunInputEntries(id, live.run.inputs as number[])
    // If stopObserving swapped generation, discard async read results rather than re-populating a cleaned mirror.
    if (this.mirrors.get(id)?.observeGeneration !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.indexRestoredSubmissions(id, loaded.pairs)
    // Queued (not yet admitted) inputs: read directly from inbox entries (mirror registered above; just backfill input metadata).
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
    // Active recovered runs already appear in snapshot summaries (listConversations): seed the semantic dedupe key
    // so subsequent adopts only emit on actual status/doing transitions instead of pushing redundant working frames.
    if (this.store.getConv(id)) mirror.lastSummaryKey = summaryKeyOf(this.summaryOf(id))
    // Recovered active runs/queues make the runtime busy from the very first mirror write.
    this.noteActivityMutation()
  }

  /** Back-read result: helmx.input entries + authoritative (submissionId, requestId) pairs. */
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

  /** Register restored authoritative (submissionId, requestId) pairs in the correlation index. */
  private indexRestoredSubmissions(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const index = this.mirrorOf(id).submissionIndex
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
  }

  /** Rebuild queued inbox items (backfills origin/meta/attachments and registers indexes for un-admitted inputs). */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmxInputMeta | undefined
      if (item.entry?.kind !== 'helmx.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // Inbox item id is SDK submissionId: register correlation index so markConsumed matches once dequeued.
      this.mirrorOf(id).submissionIndex.set(item.id, data.id)
      this.upsertTrackedInput(id, data.id, data)
    }
  }

  /** Close tracker: stop observing all conversations and block late in-flight async settlement side effects. */
  close(): void {
    this.closed = true
    for (const id of [...this.mirrors.keys()]) {
      this.stopObserving(id)
    }
  }

  stopObserving(id: number): void {
    const mirror = this.mirrors.get(id)
    mirror?.detach?.()
    // Cancel pending timer and discard queued snapshots: never emit ghost events after deletion/unobserve.
    this.clearLiveTimer(id)
    // Clean up contextUsage mirror together: late async refreshes after unobserve/deletion drop via generation guard;
    // unblock refresh waiters immediately so they inspect missing mirror/cache and exit without hanging.
    this.usage.clearConversation(id)
    // Purge all in-memory mirrors for this conversation: resolve turn_settled waiters first (preventing hangs),
    // then clear mirror and global settledRuns prefix keys so repeated create/delete cycles never leak entries.
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
        if (raw.kind === 'helmx.rewind') {
          const cut = rewindIntervalOf(raw)
          if (cut !== undefined) cuts.push(cut)
        }
        const numeric = Number(raw.id)
        if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
        if (raw.kind === 'pi.system') continue
        if (raw.kind !== 'helmx.rewind' && coveredByRewind(numeric, cuts)) continue
        return numeric
      }
      if (page.next === undefined) return 0
      cursor = page.next
    }
  }

  /** Clear live throttling timer (idempotent). */
  private clearLiveTimer(id: number): void {
    const mirror = this.mirrors.get(id)
    const timer = mirror?.liveTimer
    if (timer !== undefined && mirror !== undefined) {
      clearTimeout(timer)
      mirror.liveTimer = undefined
    }
  }

  /** Register input metadata before submission (using durable input.id = requestId as tracking key;
   * bindSubmission registers the submissionId correlation index once submit returns). */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.mirrorOf(conversationId).trackedInputs
    // The same requestId may already have a record from entry/inbox observation (e.g., rewind tx commits
    // before registration finishes): fill only missing fields (richer in-memory metadata wins) without duplicating.
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
  }

  /** Register submissionId -> requestId correlation after submit returns (SDK run.inputs etc. identify inputs
   * by submissionId; maps back to tracking identity, and dropInput removes on HelmxError). */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.mirrorOf(conversationId).submissionIndex.set(submissionId, requestId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.mirrors.get(conversationId)?.trackedInputs.delete(requestId)
  }

  /** Clean up correlation entry and requestId tracking record when a queued submission is withdrawn. */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const resolved = requestId ?? mirror.submissionIndex.get(submissionId)
    mirror.submissionIndex.delete(submissionId)
    if (resolved !== undefined) mirror.trackedInputs.delete(resolved)
  }

  /** Snapshot of inputs belonging to the current active run (used by before_turn payload): exact run.inputs
   * sequence (including steered additions) plus any registered submissions still in flight without a submissionId yet,
   * deduplicated by input.id. */
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
    // run.inputs gives the exact sequence of submissionIds admitted to this run (including already-consumed ones),
    // mapped back to tracking identity via submissionIndex.
    for (const submissionId of run.inputs) {
      const requestId = index.get(submissionId)
      if (requestId !== undefined) collect(map.get(requestId))
    }
    // Registered records without a bound submissionId yet: in-flight submits (e.g., queued followUp before placement).
    const bound = new Set(index.values())
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
    }
    return out
  }

  /** Wait for all in-flight turn_settled callbacks for this conversation to finish (used by waitForIdle; scoped per conversation). */
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
    this.noteActivityMutation()
  }

  private endSettled(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.settledInflight === 0) return
    mirror.settledInflight -= 1
    this.noteActivityMutation()
    if (mirror.settledInflight > 0) return
    const waiters = mirror.settledWaiters
    mirror.settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Whether the conversation currently has live work running (checked before abort settlement so idle stays idle). */
  hasLiveWork(conversationId: number): boolean {
    return this.mirrors.get(conversationId)?.live?.run !== undefined
  }

  /** Whether the conversation has an active context compaction task (separate from hasLiveWork so compaction never fabricates turn_settled). */
  isCompacting(conversationId: number): boolean {
    return (this.mirrors.get(conversationId)?.live?.compactions?.length ?? 0) > 0
  }

  /**
   * Aggregate activity counts over live mirrors for the runtime's activity snapshot (the Hub's
   * process-private heartbeat file backing the launcher's update busy-gate):
   * - `activeConversations`: conversations with an active run (`live.run` — generating, tool
   *   rounds, and approval-blocked runs whose tool call is still in flight; `summaryOf` labels
   *   those `blocked`, the run itself stays live);
   * - `activeCompactions`: in-flight context-compaction tasks;
   * - `queuedConversations`: conversations with queued (not yet admitted) inbox input;
   * - `settlingConversations`: conversations whose `turn_settled` callbacks are still running.
   * Every conversation gets a mirror (startup recovery observes all), so mirror iteration is the
   * complete live view — idle conversations simply contribute zero. A pending approval whose run
   * already ended is durable state (AskDoc + CAS watermarks survive restart) and does not count.
   */
  activitySnapshot(): HubActivityCounts {
    let activeConversations = 0
    let activeCompactions = 0
    let queuedConversations = 0
    let settlingConversations = 0
    for (const mirror of this.mirrors.values()) {
      if (mirror.live?.run !== undefined) activeConversations += 1
      activeCompactions += mirror.live?.compactions?.length ?? 0
      if ((mirror.inbox?.length ?? 0) > 0) queuedConversations += 1
      if (mirror.settledInflight > 0) settlingConversations += 1
    }
    return { activeConversations, activeCompactions, queuedConversations, settlingConversations }
  }

  /**
   * Register a synchronous idle→busy transition listener (the activity heartbeat rewrites its
   * file immediately so no reader can act on a stale idle record). Returns an unsubscribe
   * function. Listeners run inside the tracker's synchronous mutation paths — they must not
   * throw (failures are contained and reported as diagnostics).
   */
  onActivityBusyEntered(listener: () => void): () => void {
    this.activityBusyListeners.add(listener)
    return () => {
      this.activityBusyListeners.delete(listener)
    }
  }

  /**
   * Recompute the aggregate busy predicate after a mirror mutation and notify listeners on an
   * idle→busy flip. Called only from synchronous mutation chokepoints (snapshot adoption,
   * settle begin/end, explicit abort settlement); busy→idle flips need no immediate write — a
   * slightly stale busy record only delays an update by the reader's freshness bound (the safe
   * direction), which the heartbeat's periodic refresh closes anyway.
   */
  private noteActivityMutation(): void {
    const busy = isHubActivityBusy(this.activitySnapshot())
    if (busy === this.activityBusyAggregate) return
    this.activityBusyAggregate = busy
    if (!busy) return
    for (const listener of this.activityBusyListeners) {
      try {
        listener()
      } catch (error) {
        this.reportDiagnostic({
          level: 'warn',
          source: 'tracker.activity',
          message: 'activity busy-transition listener failed (heartbeat may lag until its next periodic write)',
          error,
        })
      }
    }
  }

  /** Live views for SSE snapshot: only conversations with an active run, streaming generation, or non-empty queue.
   *
   * Derived synchronously from live/inbox mirrors (independent of throttled push cache) so reconnect initial frames
   * restore queued pills and streaming text without resurrecting idle conversations that have nothing to show. */
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
      // On idle conversations, keep only when queued inputs exist (queue-only); never emit empty idle live views.
      if (!hasRun && !hasStream && (snapshot.queuedInputs?.length ?? 0) === 0) continue
      out.push(snapshot)
    }
    return out
  }

  /** Abort settlement (called by runtime.abortConversation; guards against double reporting with the observe path). */
  settleAborted(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    const taskId = mirror?.runTaskId
    if (taskId !== undefined && mirror?.lastSettledRun === taskId) {
      // Observe path already settled this run (aborted/failed/completed): do not duplicate.
      this.resetRunState(conversationId)
      return
    }
    if (taskId !== undefined) {
      this.noteSettledRun(conversationId, `${conversationId}:${taskId}`)
    }
    const all = this.takeCurrentRunInputs(conversationId)
    this.resetRunState(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
    // Explicit abort settles outside the snapshot path: recompute the busy aggregate here too
    // (busy→idle needs no sync write, but a replacement run in the same tick must not be missed).
    this.noteActivityMutation()
  }

  /** Clear leftover queued tracking records after an explicit abort while idle (conversation.abort() already withdrew
   * pi.inbox without triggering settleAborted; clears only when no live.run exists, never interfering with new concurrent runs). */
  clearQueuedTracking(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.live?.run !== undefined) return
    for (const [submissionId, requestId] of [...mirror.submissionIndex]) {
      mirror.submissionIndex.delete(submissionId)
      mirror.trackedInputs.delete(requestId)
    }
  }

  /** Collect all inputs of the current run (for abort settlement): admitted inputs (run.inputs via index) + consumed set +
   * registered submissions without a submissionId yet, deduplicated by input.id; never iterates historical runs'
   * tracking records (settled inputs never re-appear, keeping origins accurate and avoiding pollution). */
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

  /** Register a settled runKey while enforcing the per-conversation retention cap (evicts oldest to bound growth).
   *
   * runIds (taskIds) increase monotonically across the store: evicted keys can never recur, and settledRuns.delete(runKey)
   * on new runs only ever touches recent keys within the window, preserving exact semantics. */
  private noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.mirrorOf(conversationId).settledRunOrder
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
  }

  /** Remove a specific runKey from the retention order list (used when clearing settledRuns on new run start). */
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

    // Never drop compaction failures silently: emit an error notification once per new compactionFailure.
    this.noteCompactionFailure(id, live)

    // When a context-changing entry commits (assistant step / compaction / reset / in-place rewrite) or active
    // compaction state changes, schedule an async refresh (deduplicated synchronously; awaiting in observe is forbidden).
    this.usage.noteBoundary(id, view, prev, live)

    // Assistant text: take the newest pi.assistant entry at the window tail.
    // Stop scanning backward immediately upon hitting helmx.rewind / pi.reset: right after an in-place rewrite
    // appends a truncation marker (before a new answer exists), older pi.assistant entries are superseded and must
    // never re-trigger onAssistantText to pollute FTS5 with stale answers.
    for (let i = view.entries.length - 1; i >= 0; i -= 1) {
      const entry = view.entries[i] as
        | { kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }
        | undefined
      if (entry === undefined) continue
      if (entry.kind === 'helmx.rewind' || entry.kind === 'pi.reset') break
      if (entry.kind === 'pi.assistant') {
        const text = assistantTextOf(entry)
        if (text !== '') {
          this.events.onAssistantText(id, entry.id, text)
          break
        }
      }
    }

    // Observe helmx.input entries: only consider new items inside the current run window (>= run.first);
    // historical helmx.input entries must never resurrect settled inputs into trackedInputs.
    const first = mirror.runFirstEntry
    const candidates: Array<Record<string, unknown>> = []
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (first !== undefined && (!Number.isFinite(numeric) || numeric < first)) continue
      candidates.push(raw as unknown as Record<string, unknown>)
    }
    this.adoptInputsFromEntries(id, candidates)
    // Also rebuild queued inbox items (for followUp/steer inputs queued during busy runs before placement).
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)

    // Newly persisted entries: advance watermark strictly in ascending ID order once per entry (preserves commit order
    // even when SDK collapses multiple entries into one snapshot).
    this.emitNewEntries(id, view.entries as never as ReadonlyArray<EntryRecordLike>)

    // Detect whether this snapshot includes a new pi.compaction entry (independent of onEntryCommitted sink).
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

    // When a compaction task finishes without a pi.compaction entry and no other run/compaction is active,
    // schedule async reconciliation (awaiting inside adopt is forbidden) to distinguish skipped no-op vs abort/failure.
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

    // Settle the ended previous run first (including collapsed snapshots where run1 ends and run2 starts together).
    // A changed taskId alone is NOT a run end: the SDK hands the run to a new generation task after every tool round
    // (isContinuedRun keeps same-run handOver going); only run disappearance or a replacement logical run settles.
    let settledInAdopt = false
    const prevRun = prev?.run
    const runContinued = prevRun !== undefined && isContinuedRun(prevRun, live?.run)
    if (prevRun !== undefined && (!live?.run || live.run.taskId !== prevRun.taskId) && !runContinued) {
      settledInAdopt = true
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.noteSettledRun(id, runKey)
        mirror.lastSettledRun = prevRun.taskId
        const failure = live?.runFailure
        if (failure && failure.taskId === prevRun.taskId) {
          for (const submissionId of failure.inputs) this.markConsumed(id, submissionId)
          const consumed = this.takeConsumed(id)
          if (failure.reason === 'aborted') {
            // Aborted terminal state (observe path): settles as aborted without also reporting failed.
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
      // Monotonically advance input-rebuild lower bound to snapshot tail so settled run entries (incl. helmx.input)
      // become history and cannot resurrect on later snapshot scans.
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
        mirror.runTaskId = live.run.taskId
        if (!runContinued) {
          // New logical run: reset the turn's consumed set (same-run generation handOver keeps accumulating).
          mirror.consumedInputs = new Set<string>()
        }
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
      // During completion phase (answered, inputs cleared), leave consumedInputs intact so consumed records remain.
    }

    // Live view: throttled pushes (forced flush on settlement inside emitSettled).
    this.emitLiveThrottled(id, live)
    // Live summary while run is active: covers run start (working even before first token) and semantic doing transitions.
    this.emitRunSummary(id)
    // When idle visible entries advance without a run settlement (e.g. compaction, reset, rewind, or write),
    // push conversation.upsert so reconnect SWR watermarks stay current.
    if (!settledInAdopt && !live?.run && lastEntryAdvanced && this.store.getConv(id) !== undefined) {
      const summary = this.summaryOf(id)
      this.mirrorOf(id).lastSummaryKey = summaryKeyOf(summary)
      this.events.onSummaryChanged(summary)
    }
    // Every snapshot application is a potential run/compaction/queue mutation: recompute the busy
    // aggregate so an idle→busy flip rewrites the activity heartbeat synchronously (see adopt header).
    this.noteActivityMutation()
  }

  /** Newly persisted entries: advance watermark by ascending ID, emitting each exactly once. */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.events.onEntryCommitted
    if (sink === undefined) return
    const mirror = this.mirrors.get(id)
    let watermark = mirror?.lastEmittedEntry ?? 0
    let advanced = false
    for (const raw of entries) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= watermark) continue
      // Throw explicitly on conversion failures (non-JSON payload): SDK terminates observation with listener_error
      // rather than silently dropping or fabricating fallbacks (honesty invariant).
      sink(id, toConversationEntry(raw))
      watermark = numeric
      advanced = true
    }
    if (advanced && mirror !== undefined) mirror.lastEmittedEntry = watermark
  }

  /** Throttled live view emitter: retains only the latest snapshot per window and deduplicates identical content.
   *
   * Changes to queuedInputs (enqueue/dequeue) bypass the 75ms throttle and flush immediately so steer/followUp pills
   * appear at the timeline tail as soon as observed (subject only to observer commit timing). */
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
      // Do not emit idle views (terminal flushes are handled by emitSettled); however, if inputs were previously
      // queued and the authoritative inbox is now empty, emit a cleanup frame so client pills do not linger.
      const prevQueued = mirror?.lastQueuedLiveKey
      if (prevQueued === undefined || prevQueued === '[]') return
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendLiveNow(id, cleanup)
      return
    }
    const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
    const key = this.liveKeyOf(snapshot)
    // Align previous-queue fingerprint: uninitialized means empty '[]' (so first empty queue never falsely skips throttle);
    // only actual queue changes bypass the 75ms throttle.
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    const prevQueuedKey = mirror?.lastQueuedLiveKey ?? '[]'
    if (key === mirror?.lastLiveKey && queuedKey === prevQueuedKey) return
    if (queuedKey !== prevQueuedKey) {
      // Immediate priority for queue enqueue/dequeue: cancel timer and flush synchronously without waiting 75ms.
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

  /** Live frame content fingerprint: text/thinking/tools/generation/queuedInputs (single formula shared by send and dedupe).
   * generation participates in fingerprinting so pure tool-call argument streaming (while text/thinking remain empty)
   * is not suppressed by unchanged snapshots. */
  private liveKeyOf(snapshot: ConversationLive): string {
    return JSON.stringify([
      snapshot.text,
      snapshot.thinking ?? '',
      snapshot.tools,
      snapshot.generation ?? null,
      snapshot.queuedInputs ?? [],
    ])
  }

  /** Synchronously send one live frame (shared by terminal flushes / queue cleanup) and record both fingerprints. */
  private sendLiveNow(id: number, snapshot: ConversationLive): void {
    this.clearLiveTimer(id)
    const mirror = this.mirrorOf(id)
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** Flush pending snapshot inside throttle window (runs on timer expiry or immediate queue change). */
  private flushPendingLive(id: number): void {
    const mirror = this.mirrors.get(id)
    const snapshot = mirror?.pendingLive
    if (mirror === undefined || snapshot === undefined) return
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** Force terminal flush: emits a synchronous frame from current live mirror (canceling timer and dropping stale pending). */
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

  /** Register inputs from helmx.input entry data (idempotent merge into unique record keyed by input.id = requestId).
   *
   * On happy paths register/bind already holds the authoritative record, so entry observation only fills missing metadata
   * fields (origin/meta/attachments) without creating duplicates. */
  private adoptInputsFromEntries(id: number, entries: ReadonlyArray<unknown>): void {
    for (const raw of entries) {
      const entry = raw as { kind?: string; data?: unknown }
      // Custom input entry: SDK pickInputEntry writes {kind:'helmx.input', data} into entry.data;
      // model only holds UserMessage (nothing in model[0].data).
      if (entry?.kind !== 'helmx.input') continue
      const meta = entry.data as HelmxInputMeta | undefined
      if (!meta || typeof meta.id !== 'string' || typeof meta.text !== 'string') continue
      this.upsertTrackedInput(id, meta.id, meta)
    }
  }

  /** Register or merge metadata for a single helmx.input (idempotent by input.id; caller checked meta.id/text are strings). */
  private upsertTrackedInput(id: number, requestId: string, meta: HelmxInputMeta): void {
    const map = this.mirrorOf(id).trackedInputs
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    map.set(requestId, existing === undefined ? rebuilt : mergeInputMeta(existing, rebuilt))
  }

  /** Mark submissionId as consumed by the active run: maps back to requestId via correlation index and registers once
   * (emitting onInputCommitted once). Silently skips if index is missing (bind/backfill pending) to catch on next scan. */
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

  /** Collect inputs consumed by this run on settlement and purge them: once per requestId, clearing both tracking and index
   * entries so history never resurrects. */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const consumedSet = mirror?.consumedInputs
    const out: ConversationInput[] = []
    if (mirror !== undefined && consumedSet !== undefined) {
      for (const requestId of consumedSet) {
        const input = mirror.trackedInputs.get(requestId)
        if (input !== undefined) out.push(input)
      }
      // Purge tracking and correlation index entries for settled inputs together.
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
      // Terminal flush of live view: precedes turn_settled (empty tools/text signals stream completion).
      this.flushLiveFinal(conversationId)
      // Advance durable watermark first, then construct settlement snapshot so plugins and read APIs observe identical state.
      // Increment completionSeq + set unread (cleared only by explicit human PATCH).
      // Background derived sub-conversations (non-human ownership with parent chain, e.g. managed subagents / SuperAgent
      // Workers) never fabricate human unread flags on completion; human forks (parent chain + human ownership) and top-level
      // direct conversations preserve unread semantics. Failures/aborts never set unread (existing contract).
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
        // Failed terminal diagnostic summary shares single source with summaryOf: emitSettled bypasses tracker derivation,
        // so it must include lastError here (otherwise the first conversation.upsert drops the error reason);
        // likewise attach cached contextUsage synchronously (post-settlement async refresh updates later if changed).
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
        // Record terminal summary fingerprint so subsequent idle snapshots do not re-emit identical terminal frames.
        this.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(settledSummary)
        this.events.onSummaryChanged(settledSummary)
        // Context changed after turn settlement: schedule async usage refresh (emits upsert only on change; never bumps seq).
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

  /** Determine whether a conversation is background-derived: has a parent chain and non-human ownership (managed subagent / Worker, etc.).
   * If ownership callback is absent or fails (including deleted), default to human—better to over-emit than suppress human unreads. */
  private isBackgroundDerived(conversationId: number, meta: ConvMeta): boolean {
    if (meta.parentConversationId === undefined) return false
    if (this.ownershipOf === undefined) return false
    try {
      return this.ownershipOf(conversationId) !== 'human'
    } catch {
      return false
    }
  }

  /** Derive the five-state status from store meta + live mirror (blocked takes priority over working on derivation). */
  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.store.getConv(conversationId)
    if (!meta) throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404)
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
      // Pending approval overrides run status, surfacing the human decision point directly.
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
    // Error diagnostic summary travels only with error status (live.runFailure clears when a new run starts, vanishing automatically).
    const lastError = status === 'error' ? lastErrorOf(live, this.redactError) : undefined
    const lastEntryId = this.lastEntryIds.get(conversationId) ?? meta.lastEntryId ?? 0
    const summary = summaryOf(meta, status, pendingAsks, doing, lastError, lastEntryId)
    const usage = this.usage.cachedOrSchedule(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
  }

  /** Schedule an async context usage refresh (delegates to refresh chain module; public port for service/ops consumers). */
  scheduleContextUsageRefresh(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    this.usage.schedule(conversationId, options)
  }

  /** Invalidate context usage cache on models.changed.
   *
   * Catalog refreshes/rebuilds can resolve or change a model's context window (or remove providers): previously
   * observed/cached conversations must recompute rather than remaining stuck with stale windows on idle threads.
   * Schedules the existing refresh chain (in-flight invalidation, generation guard, fingerprint dedupe) without new
   * async machinery or LLM calls; usage-only updates never advance stateChangeSeq (existing discipline in applyContextUsage).
   *
   * - non-empty providers: refresh only conversations whose effective model belongs to those providers;
   * - empty providers: entire catalog may have rotated, so refresh all;
   * - only touches observed or already-cached conversations rather than scanning the entire history store on startup;
   *   unobserved conversations compute using the updated catalog upon first visit.
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

  /** List currently observed conversation IDs (in-memory mirrors with active observeGeneration). */
  private observedConversationIds(): number[] {
    const out: number[] = []
    for (const [id, mirror] of this.mirrors) {
      if (mirror.observeGeneration !== undefined) out.push(id)
    }
    return out
  }

  /** Ensure a conversation's contextUsage cache is populated and its refresh chain settled (first detail read, etc.). */
  async ensureContextUsage(conversationId: number): Promise<void> {
    await this.usage.ensure(conversationId)
  }

  /** Never swallow compaction failures silently: emit one redacted error notification per new compactionFailure
   * (deduplicated by taskId so duplicate snapshots do not re-notify; SDK clears compactionFailure only on the next
   * successful compaction, and later failures get new taskIds so they report cleanly). */
  private noteCompactionFailure(id: number, live: LiveStateShape | undefined): void {
    const failure = live?.compactionFailure
    if (failure === undefined) return
    if (this.notifiedCompactionFailures.get(id) === failure.taskId) return
    this.notifiedCompactionFailures.set(id, failure.taskId)
    this.events.onNotification?.({
      level: 'error',
      title: 'Context compaction failed',
      body: compactionFailureNoticeOf(failure, this.redactError),
      conversationId: id,
    })
  }

  /**
   * Async reconciliation when compaction ends without a pi.compaction entry (runs outside synchronous adopt):
   * - inspect each finished task's authoritative terminal state; only treat as clean skip when status='terminal'
   *   and outcome.status='completed' with no written entry and no compactionFailure (selectCut === undefined or beforeCompact declined);
   * - ignore aborted / failed tasks (never misreport when compaction wasn't needed, and never flush queued inputs on uncompacted context);
   * - after confirming clean skip: emit info notification if triggered manually; if inbox still holds steer/followUp
   *   inputs while idle with no active compaction, auto-start the next turn via continue.
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
          title: 'Current context does not need compaction',
          body: 'History messages are within the retention window; no new summary was generated.',
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
        message: 'compaction end reconciliation failed',
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
    // Advance durable seq: pendingAsk change is a state change (relied upon by CAS watermarks).
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

  /** Emit live summary during an active run: fires once on run start and on semantic `doing` transitions.
   *
   * - only emits when an active run exists in this snapshot (yielding only working/blocked);
   *   emitSettled owns terminal state exclusively so adopt never double-settles or resurrects settled turns;
   * - deduplicates on (status, doing, pendingAskCount) semantic fingerprint so pure streaming token updates
   *   (which leave `doing` unchanged) never emit redundant per-token summary updates;
   * - stateChangeSeq advances monotonically with real state transitions (per protocol contract, same mechanism as
   *   setPendingAskCount); live throttle window (75ms) is unaffected.
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

  /** Record latest observed assistant text (data source for getLastAssistantText). */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.lastAssistant
    if (prev !== undefined && prev.entryId === entryId) return
    mirror.lastAssistant = { entryId, text }
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.mirrors.get(conversationId)?.lastAssistant?.text
  }

  /** Invalidate lastAssistant cache entries inside a rewound interval (after in-place overwrite & resend).
   *
   * Clears only if the cached entry falls within [from, through] so a failed resend does not expose the overwritten
   * answer via getLastAssistantText while earlier turns outside the interval stay valid. */
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

/** Semantic summary fingerprint: status/doing/pendingAskCount/lastError (other fields do not participate in push dedupe). */
function summaryKeyOf(summary: ConversationSummary): string {
  return `${summary.status}|${summary.doing ?? ''}|${summary.pendingAskCount}|${summary.lastError ?? ''}`
}

/** Build human-readable diagnostic summary from live.runFailure ('reason: detail'; omitted for non-error aborted/reset). */
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

// Inputs use durable input.id (requestId) as tracking identity, requiring no temporary key allocation.

/** Extract assistant entry text block contents. */
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

/** Compute latest visible entry ID (excluding `pi.system` and entries covered by `helmx.rewind`; `0` when none). */
function latestVisibleEntryIdOf(entries: ReadonlyArray<EntryRecordLike>): number {
  const cuts: RewindInterval[] = []
  for (const raw of entries) {
    if (raw.kind !== 'helmx.rewind') continue
    const cut = rewindIntervalOf(raw)
    if (cut !== undefined) cuts.push(cut)
  }
  let latest = 0
  for (const raw of entries) {
    const numeric = Number(raw.id)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) continue
    if (raw.kind === 'pi.system') continue
    if (raw.kind !== 'helmx.rewind' && coveredByRewind(numeric, cuts)) continue
    if (numeric > latest) latest = numeric
  }
  return latest
}

/** Title from first input: strip code blocks and newlines, keeping the first 36 meaningful characters. */
function deriveTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 36) || 'New conversation'
}
