/**
 * builtin:token-speed public contracts: plugin ID, session-doc shapes, and event-payload boundary guards.
 *
 * Design discipline:
 * - All speed computation is this plugin's policy (the kernel only passes through ConversationLive.generation's
 *   generic streaming facts); this file imports no kernel implementation;
 * - High-frequency conversation-scoped state goes only into sessionDoc (dedicated SSE on-demand
 *   subscription), never into global ctx.doc or the conversation summary (the write-amplification red line);
 * - Event payloads get shape guards at the boundary (invalid dropped with diagnostics); never trusted via crude as.
 */
import type { ConversationLiveMessage } from '@helm/protocol'

export const TOKEN_SPEED_PLUGIN_ID = 'builtin:token-speed'

/** Per-conversation speed state doc name (public sessionDoc; subscription stream key (pluginId, name, convId)). */
export const TOKEN_SPEED_DOC = 'speed'

/** Default time sliding window (ms); consistent with the pi-token-speed reference implementation. */
export const DEFAULT_SLIDING_WINDOW_MS = 1000

/** Config-allowed window range (ms); out-of-range values are clamped at read time, not silently rejecting user config. */
export const MIN_SLIDING_WINDOW_MS = 100
export const MAX_SLIDING_WINDOW_MS = 30_000

/** sessionDoc write throttle interval (ms): live frames at least 75ms apart, partial throttle 100ms;
 * 120ms balances live responsiveness and write reduction (first measurement / phase change / terminal written immediately; same-phase trailing frame written late). */
export const DOC_WRITE_INTERVAL_MS = 120

/** Token basis: provider = vendor usage delta; estimate = chars/4 estimation;
 * mixed = both bases present within one measurement. */
export type TokenSpeedSource = 'provider' | 'estimate' | 'mixed'

/** Context-invalidation boundary markers (same basis as the kernel's context-usage): once these entries land,
 * the old context is invisible to the model and speed facts on it cannot be attributed to the new context. */
export const CONTEXT_INVALIDATION_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'pi.reset',
  'pi.compaction',
  'helm.rewind',
])

/** Envelope facts extracted by the conversation.entry event guard (validated before per-kind dispatch). */
export interface ConversationEntryEnvelope {
  conversationId: number
  kind: string
}

/** Per-conversation speed state (the value of sessionDoc `speed`; null = no displayable measurement yet). */
export interface TokenSpeedStatus {
  /** Current phase: decoding = model generating; tools = tool execution (decoding clock paused,
   * keeping this turn's last valid speed displayed); settled = turn settled (the reconciled terminal
   * value, kept until the next turn starts). */
  phase: 'decoding' | 'tools' | 'settled'
  /** Current speed tokens/sec: decoding = time-sliding-window speed (pauses or inter-round TTFT waits
   * keep this turn's last valid value); tools = decoding timer paused, keeping the last valid value;
   * settled = reconciled decoding speed (only responses whose counts and durations pair up). Omitted only
   * when this turn has no reliable first measurement yet or settled has no pairable measurement -- never fake a real speed with 0.0. */
  tps?: number
  /** Cumulative output tokens (basis in source; terminal states reconciled with the final usage.output where possible). */
  outputTokens: number
  /** Cumulative net decoding time (ms): the sum of each decoding segment (first growth observation ->
   * last growth observation); excludes TTFT and tool-execution time. Observation granularity is limited
   * by live throttling (75ms) and pi-durable partial-commit throttling (100ms default) -- a conservative approximation. */
  decodeMs: number
  source: TokenSpeedSource
  /** This turn's first-token latency (ms). The start is the frame time when the plugin first observes an
   * empty generation (the kernel provides no request-start anchor; never fabricated; double throttling may bias it either way). */
  ttftMs?: number
  /** The effective time sliding window (ms); for speed-basis documentation. */
  windowMs: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Event-payload boundary guards
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Sum the cumulative generated character count of a model message's content blocks:
 * text + thinking + toolCall(name + arguments JSON)。
 * The streaming projection (tracker.ts) and the persisted pi.assistant trailing-frame backfill share this formula.
 */
export function contentCharsOfBlocks(content: readonly unknown[]): number {
  let chars = 0
  for (const block of content) {
    if (!isPlainObject(block)) continue
    const type = block['type']
    if (type === 'text' && typeof block['text'] === 'string') {
      chars += block['text'].length
    } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
      chars += block['thinking'].length
    } else if (type === 'toolCall' && typeof block['name'] === 'string') {
      chars += block['name'].length
      if ('arguments' in block && block['arguments'] !== undefined) {
        try {
          const serialized = JSON.stringify(block['arguments'])
          if (typeof serialized === 'string') chars += serialized.length
        } catch {
          // Non-JSON argument shape: skip (never fabricate a length).
        }
      }
    }
  }
  return chars
}

/** The output frame of the conversation.live event guard (the minimal subset consumed by the speed policy).
 * generation identity is a required fact: taskId / attempt are both positive integers (taskId semantics come
 * from SDK live.run.taskId, same source as the pi.assistant entry's taskId -- the join key exactly linking
 * streaming snapshots and the final persisted result) -- frames with missing or invalid identity are rejected
 * wholesale, never consumed degraded. */
export interface TokenSpeedLiveFrame {
  conversationId: number
  generation?: { taskId: number; attempt: number; message?: ConversationLiveMessage }
  hasTools: boolean
  updatedAt: number
}

/**
 * conversation.live event guard (the minimal subset consumed by the speed policy): HelmEvent envelope +
 * live.{conversationId positive integer, generation an optional restricted shape (taskId+attempt positive
 * integers as required identity), updatedAt finite non-negative}. Invalid returns undefined (the caller drops
 * it); never trusted via crude as.
 */
export function asConversationLiveFrame(payload: unknown): TokenSpeedLiveFrame | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.live') return undefined
  const live = payload['live']
  if (!isPlainObject(live)) return undefined
  const conversationId = live['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const updatedAt = live['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined
  const tools = live['tools']
  const hasTools = Array.isArray(tools) && tools.length > 0
  const generation = live['generation']
  if (generation === undefined) return { conversationId, hasTools, updatedAt }
  if (!isPlainObject(generation)) return undefined
  const taskId = generation['taskId']
  if (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0) return undefined
  const attempt = generation['attempt']
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) return undefined
  const message = generation['message']
  if (message === undefined) return { conversationId, generation: { taskId, attempt }, hasTools, updatedAt }
  if (!isPlainObject(message) || !Array.isArray(message['content'])) return undefined
  const usage = message['usage']
  if (usage !== undefined && (!isPlainObject(usage) || typeof usage['output'] !== 'number')) return undefined
  return {
    conversationId,
    generation: { taskId, attempt, message: message as unknown as ConversationLiveMessage },
    hasTools,
    updatedAt,
  }
}

/**
 * conversation.entry event envelope guard (before per-kind dispatch): HelmEvent envelope + conversationId
 * positive integer + entry.{kind non-empty string}. Invalid returns undefined.
 */
export function asConversationEntryEnvelope(payload: unknown): ConversationEntryEnvelope | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = payload['entry']
  if (!isPlainObject(entry) || typeof entry['kind'] !== 'string' || entry['kind'] === '') return undefined
  return { conversationId, kind: entry['kind'] }
}

/** Generic completion facts of a pi.assistant entry (no success filtering: failed / aborted requests equally
 * need to tell the policy layer "this request has ended"; the policy then decides reconcile-or-void by identity).
 * - taskId: entry.taskId (a positive integer from the kernel's byTaskId projection; omitted when unattributed
 *   e.g. scheduler context -- facts with unclear identity neither associate nor guess);
 * - usageOutput: positive finite number (unreported / zero omitted; never reconcile with 0);
 * - stopReason: required (aborted / error are failed attempts; counts and time voided);
 * - contentChars: the cumulative character count when model[0].content is an array (for backfilling the real
 *   trailing delta after cancelling the trailing partial timer; omitted when absent). */
export interface AssistantCompletionFacts {
  conversationId: number
  taskId: number | undefined
  entryId: string | undefined
  usageOutput: number | undefined
  stopReason: string
  contentChars?: number
}

/**
 * conversation.entry event guard (pi.assistant completion-fact extraction): model[0] must be a
 * role = assistant message carrying stopReason; usage.output carried when a positive finite number,
 * contentChars carried when content is an array. No success filtering by stopReason (failed requests'
 * ending facts return too); success handling belongs to the policy layer; invalid payload shapes return undefined.
 */
export function asAssistantCompletion(payload: unknown): AssistantCompletionFacts | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = payload['entry']
  if (!isPlainObject(entry) || entry['kind'] !== 'pi.assistant') return undefined
  const rawTaskId = entry['taskId']
  const taskId =
    typeof rawTaskId === 'number' && Number.isInteger(rawTaskId) && rawTaskId > 0 ? rawTaskId : undefined
  const rawEntryId = entry['id']
  const entryId = typeof rawEntryId === 'string' ? rawEntryId : undefined
  const model = entry['model']
  if (!Array.isArray(model) || !isPlainObject(model[0])) return undefined
  const first = model[0] as Record<string, unknown>
  if (first['role'] !== 'assistant') return undefined
  const stopReason = first['stopReason']
  if (typeof stopReason !== 'string' || stopReason === '') return undefined
  const usage = first['usage']
  let usageOutput: number | undefined
  if (isPlainObject(usage)) {
    const output = usage['output']
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) usageOutput = output
  }
  const content = first['content']
  const contentChars = Array.isArray(content) ? contentCharsOfBlocks(content) : undefined
  return {
    conversationId,
    taskId,
    entryId,
    usageOutput,
    stopReason,
    ...(contentChars !== undefined ? { contentChars } : {}),
  }
}

/** conversation.deleted event guard: returns the conversation id. */
export function asConversationDeletedId(payload: unknown): number | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  const conversationId = payload['conversationId']
  return typeof conversationId === 'number' && Number.isInteger(conversationId) && conversationId > 0
    ? conversationId
    : undefined
}
