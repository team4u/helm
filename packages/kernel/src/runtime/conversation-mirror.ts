/**
 * single conversation memory mirror (ConversationMirror):ConversationTracker all by conversation
 * lifecycle run state aggregate.
 *
 * Why aggregate: this before 30+  Map<number,...> field each is administration,stopObserving must manually work
 * one by one map delete about 40 row, leak delete i.e. leak leak (reverse re- create delete conversation process follow time unbounded accumulated leftover).
 * aggregate after stopObserving once delete i.e. whole reclaim; field semantics and migration before one by one for should.
 *
 * lifecycle: observe establish (observe) or first time write when create;observer.end only clean detach
 * (the rest mirror keep, supply heavy observe and summary derive);stopObserving whole delete.
 * exception (does not enter mirror, still archive tracker top-level):
 * - settledRuns: across conversation dedupe set (`${conversationId}:${taskId}` prefix key global unique);
 * - notifiedCompactionFailures: do not follow stopObserving clear (same runtime inside heavy observe
 *   must not again report the same compress failed);
 * - contextUsage cache/refresh chain: independent lifecycle (in-flight refresh can across exceeds stop observe), see
 *   context-usage-refresh.ts.
 */

import type { ConversationInput, ConversationLive, InputOrigin, WhenBusy } from '@helm/protocol'
import type { LiveCompactionFailureShape, LiveCompactionShape } from './context-usage.js'

/** SDK pi.live document structure sub- collection (tracker observe shape). */
export interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number; first?: number }
  generation?: { attempt?: unknown; message?: unknown; retry?: unknown; deferred?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
  /** in progress compress task (taskId order;SDK CompactionStatus structure sub- collection). */
  compactions?: LiveCompactionShape[]
  /** most near once compress failed (SDK CompactionFailure structure sub- collection). */
  compactionFailure?: LiveCompactionFailureShape
}

/** pi.inbox document structure sub- collection (queued commit:submissionId -> entry payload). */
export interface InboxItemShape {
  id: number
  mode: 'steer' | 'followUp' | 'write'
  entry?: { kind?: string; data?: unknown }
}

/** helm.input entry / inbox item metadata payload shape. */
export interface HelmInputMeta {
  id?: string
  text?: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: unknown
}

/** single conversation aggregate mirror: field and migration before same name Map item one one for should. */
export interface ConversationMirror {
  /** SDK observer return detach(observe store continue phase;observer.end / stopObserving clear). */
  detach: (() => void) | undefined
  /** when before pi.live mirror (most near once advance value;adopt/adoptInitial archive one is object). */
  live: LiveStateShape | undefined
  /** when before pi.inbox queue up items mirror (queuedInputs derive and real-time push use). */
  inbox: ReadonlyArray<InboxItemShape> | undefined
  /** requestId(= input.id)-> input metadata (unique append trace identity; commit register and entry/inbox
   * observe rebuild by requestId idempotent merge is unique record). */
  trackedInputs: Map<string, ConversationInput>
  /** submissionId -> requestId:SDK interface related index (live.run.inputs /
   * runFailure.inputs / withdraw all with submissionId express, via this mapping back append trace identity).
   *
   * write source:bindSubmission(submit return),adoptInputsFromInbox(inbox items
   * id i.e. submissionId), restart restore submission precise query; compute/withdraw back when clean up. */
  submissionIndex: Map<number, string>
  /** input rebuild under boundary entry id(single tune does not fall back: new run take run.first to on push,run end
   * do not clear - - window inside already compute helm.input no longer by under one snapshot re-). */
  runFirstEntry: number | undefined
  /** this turn already consume requestId collection (run store continue during cumulative, new taskId reset). */
  consumedInputs: Set<string> | undefined
  /** when before run  taskId(many tool round do not change; change only then reset consume collection). */
  runTaskId: number | undefined
  /** already compute runKey insert order (capacity eliminate use, and global settledRuns sync maintain). */
  settledRunOrder: string[]
  /** most near a already compute run  taskId(explicit abort guard against heavy). */
  lastSettledRun: number | undefined
  /** in-flight turn_settled call back counter (waitForIdle by conversation wait for). */
  settledInflight: number
  /** call back chain first error (counter reset to zero after new chain clear;waitForIdle replay throw). */
  settledError: unknown
  /** in-flight turn_settled call back chain wait for (counter reset to zero when all wake). */
  settledWaiters: Array<() => void>
  /** already conversation.entry most large entry id(observe window inside single tune). */
  lastEmittedEntry: number
  /** most near once snapshot scan to most large entry id(used to decide pi.compaction is otherwise new written to the database,
   * and onEntryCommitted sink is otherwise hang connect without closure). */
  lastSeenEntryId: number
  /** await live snapshot (node stream window inside most new value; terminal state when force conflict refresh). */
  pendingLive: ConversationLive | undefined
  /** node stream conflict refresh timer(stopObserving/close must clean up, guard against after deletion ghost event). */
  liveTimer: ReturnType<typeof setTimeout> | undefined
  /** on time live content refer grain (identical snapshot does not resend frame). */
  lastLiveKey: string | undefined
  /** on time already queuedInputs refer grain (queue/out queue 0ms conflict refresh decide; not register treated as '[]'). */
  lastQueuedLiveKey: string | undefined
  /** most near once already push summary semantics refer grain (status|doing|pendingAsk; identical do not heavy). */
  lastSummaryKey: string | undefined
  /** each time observe independent token; stop observe i.e. follow mirror delete, late to async result must not re- state. */
  observeGeneration: symbol | undefined
  /** most new assistant text cache (getLastAssistantText data source). */
  lastAssistant: { entryId: number; text: string } | undefined
  /** await answer Ask counter (blocked state derive and CAS watermark line). */
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

/** from helm.input entry / inbox payload rebuild ConversationInput(default field do not fabricate). */
export function inputFromMeta(meta: HelmInputMeta): ConversationInput {
  return {
    id: meta.id!,
    text: meta.text!,
    origin: meta.origin ?? 'human',
    ...(typeof meta.whenBusy === 'string' ? { whenBusy: meta.whenBusy } : {}),
    createdAt: meta.createdAt ?? Date.now(),
    // meta from entry.data rebuild throughout through back turn_settled payload(boundary already validate
    // is ordinary object; non- object shape do not fabricate, directly discard the field).
    ...(isPlainRecord(meta.meta) ? { meta: meta.meta } : {}),
    ...(Array.isArray(meta.attachments)
      ? { attachments: meta.attachments as ConversationInput['attachments'] }
      : {}),
  }
}

/** merge two same input.id metadata: rebuild value takes precedence, memory in more complete field without losing. */
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

/** ordinary object decide (null and non- object do not compute; class instance do not compute). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
