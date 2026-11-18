/**
 * Per-conversation in-memory mirror (ConversationMirror): aggregates all per-conversation
 * lifecycle runtime state inside ConversationTracker.
 *
 * Why aggregate: previously 30+ Map<number, ...> fields were managed separately, forcing stopObserving
 * to manually delete from ~40 maps—any missed deletion caused leaks across repeated create/delete cycles.
 * With aggregation, stopObserving reclaims the entire conversation in a single delete; field semantics remain 1:1.
 *
 * Lifecycle: created on observe or first write; observer.end clears only detach (retaining the rest of the mirror
 * for re-observation and summary derivation); stopObserving deletes the entire mirror.
 * Exceptions (outside mirror, kept at tracker top-level):
 * - settledRuns: cross-conversation deduplication set (`${conversationId}:${taskId}` prefixed global key);
 * - notifiedCompactionFailures: persists across stopObserving (re-observing within the same runtime
 *   must never re-report the same compaction failure);
 * - contextUsage cache/refresh chain: independent lifecycle (in-flight refreshes can outlive stopObserving),
 *   see context-usage-refresh.ts.
 */

import type { ConversationInput, ConversationLive, InputOrigin, WhenBusy } from '@helm/protocol'
import type { LiveCompactionFailureShape, LiveCompactionShape } from './context-usage.js'

/** Subset of SDK pi.live document structure (observed shape used by tracker). */
export interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number; first?: number }
  generation?: { attempt?: unknown; message?: unknown; retry?: unknown; deferred?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
  /** Active compaction tasks (ordered by taskId; subset of SDK CompactionStatus). */
  compactions?: LiveCompactionShape[]
  /** Most recent compaction failure (subset of SDK CompactionFailure). */
  compactionFailure?: LiveCompactionFailureShape
}

/** Subset of pi.inbox document structure (queued submissions: submissionId -> entry payload). */
export interface InboxItemShape {
  id: number
  mode: 'steer' | 'followUp' | 'write'
  entry?: { kind?: string; data?: unknown }
}

/** Payload shape for helm.input entries / inbox item metadata. */
export interface HelmInputMeta {
  id?: string
  text?: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: unknown
}

/** Per-conversation aggregate mirror: fields correspond 1:1 with the prior per-tracker Maps. */
export interface ConversationMirror {
  /** Detach handle returned by SDK observer (populated while actively observing; cleared by observer.end / stopObserving). */
  detach: (() => void) | undefined
  /** Current pi.live mirror (latest pushed snapshot; initialized to an object on adopt/adoptInitial). */
  live: LiveStateShape | undefined
  /** Current pi.inbox queued items mirror (used to derive queuedInputs and push live updates). */
  inbox: ReadonlyArray<InboxItemShape> | undefined
  /** requestId (= input.id) -> input metadata (unique tracking identity; submission registration and entry/inbox
   * reconstruction merge idempotently into a single record keyed by requestId). */
  trackedInputs: Map<string, ConversationInput>
  /** submissionId -> requestId: SDK boundary correlation index (live.run.inputs / runFailure.inputs / withdrawal
   * all use submissionId, which maps back to tracking identity here).
   *
   * Writers: bindSubmission (on submit), adoptInputsFromInbox (inbox item id is submissionId), restart recovery
   * submission query; cleared on settlement or withdrawal. */
  submissionIndex: Map<number, string>
  /** Lower-bound entry ID for input reconstruction (monotonically non-decreasing: new runs advance to run.first
   * and run end leaves it untouched so settled helm.input entries in the window never resurrect on the next snapshot). */
  runFirstEntry: number | undefined
  /** Set of requestIds consumed during this turn (accumulated across the active run, including generation
   * handOver rounds; reset only when a new logical run starts). */
  consumedInputs: Set<string> | undefined
  /** taskId of the generation currently owning the active run (changes on same-run handOver after each tool
   * round; logical run identity is compared via run first/inputs, see isContinuedRun in conversations.ts). */
  runTaskId: number | undefined
  /** Insertion order of settled runKeys (for bounded eviction, synchronized with global settledRuns). */
  settledRunOrder: string[]
  /** taskId of the most recently settled run (prevents double reporting on explicit abort). */
  lastSettledRun: number | undefined
  /** Count of in-flight turn_settled callbacks (awaited per conversation by waitForIdle). */
  settledInflight: number
  /** First error captured in the callback chain (cleared once counter returns to 0 and restarts; rethrown by waitForIdle). */
  settledError: unknown
  /** Waiters on in-flight turn_settled callbacks (woken when counter drops to 0). */
  settledWaiters: Array<() => void>
  /** Highest entry ID already emitted via conversation.entry (monotonic within observe window). */
  lastEmittedEntry: number
  /** Highest entry ID seen in the latest snapshot scan (used to detect newly persisted pi.compaction entries even
   * when no onEntryCommitted sink is attached). */
  lastSeenEntryId: number
  /** Pending throttled live snapshot (latest snapshot inside throttle window; flushed forcefully on settlement). */
  pendingLive: ConversationLive | undefined
  /** Throttled live flush timer (must be cleared on stopObserving/close to prevent post-deletion ghost events). */
  liveTimer: ReturnType<typeof setTimeout> | undefined
  /** Content fingerprint of last emitted live frame (suppresses identical frames). */
  lastLiveKey: string | undefined
  /** Content fingerprint of last emitted queuedInputs (drives 0ms queue/dequeue flushes; unset counts as '[]'). */
  lastQueuedLiveKey: string | undefined
  /** Semantic fingerprint of last emitted summary (status|doing|pendingAsk; suppresses duplicates). */
  lastSummaryKey: string | undefined
  /** Unique token per observe session; deleted along with mirror on stopObserving so stale async results cannot re-populate. */
  observeGeneration: symbol | undefined
  /** Cache of latest assistant text (data source for getLastAssistantText). */
  lastAssistant: { entryId: number; text: string } | undefined
  /** Count of pending AskDocs (drives blocked status and CAS watermarks). */
  pendingAskCount: number
}

export function createConversationMirror(): ConversationMirror {
  return {
    detach: undefined,
    live: undefined,
    inbox: undefined,
    trackedInputs: new Map(),
    submissionIndex: new Map(),
    runFirstEntry: undefined,
    consumedInputs: undefined,
    runTaskId: undefined,
    settledRunOrder: [],
    lastSettledRun: undefined,
    settledInflight: 0,
    settledError: undefined,
    settledWaiters: [],
    lastEmittedEntry: 0,
    lastSeenEntryId: 0,
    pendingLive: undefined,
    liveTimer: undefined,
    lastLiveKey: undefined,
    lastQueuedLiveKey: undefined,
    lastSummaryKey: undefined,
    observeGeneration: undefined,
    lastAssistant: undefined,
    pendingAskCount: 0,
  }
}

/** Reconstruct a ConversationInput from a helm.input entry / inbox payload without fabricating missing fields. */
export function inputFromMeta(meta: HelmInputMeta): ConversationInput {
  return {
    id: meta.id!,
    text: meta.text!,
    origin: meta.origin ?? 'human',
    ...(typeof meta.whenBusy === 'string' ? { whenBusy: meta.whenBusy } : {}),
    createdAt: meta.createdAt ?? Date.now(),
    // Reconstruct meta from entry.data for downstream turn_settled payloads (already validated at boundary
    // to be a plain object; drop non-object shapes rather than fabricating).
    ...(isPlainRecord(meta.meta) ? { meta: meta.meta } : {}),
    ...(Array.isArray(meta.attachments)
      ? { attachments: meta.attachments as ConversationInput['attachments'] }
      : {}),
  }
}

/** Merge two metadata records for the same input.id: rebuilt values win, while richer in-memory fields are preserved. */
export function mergeInputMeta(existing: ConversationInput, rebuilt: ConversationInput): ConversationInput {
  return {
    ...rebuilt,
    ...(existing.meta !== undefined && rebuilt.meta === undefined ? { meta: existing.meta } : {}),
    ...(existing.attachments !== undefined && rebuilt.attachments === undefined
      ? { attachments: existing.attachments }
      : {}),
    ...(existing.whenBusy !== undefined && rebuilt.whenBusy === undefined
      ? { whenBusy: existing.whenBusy }
      : {}),
  }
}

/** Plain-object check (rejects null, primitives, and class instances). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
