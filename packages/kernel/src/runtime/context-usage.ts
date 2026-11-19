/**
 * Conversation context usage estimation (pure functions; aligned with pi-agent 1.5.2 source semantics).
 *
 * Verified against @earendil-works/pi-coding-agent 1.5.2 source:
 * - `dist/core/agent-session.js` `getContextUsage`: valid assistant usage (stopReason not aborted/error and context
 *   tokens > 0) is trusted only after the latest compaction; if no valid assistant remains in projection afterwards, tokens is unknown (null);
 * - `dist/core/compaction/compaction.js` `estimateProjectedContextTokens`:
 *   if the latest usage predates the latest context invalidation (compaction / context_edit), discard it and fall back
 *   to full estimation—first collapsing current effective system message via pi-ai `getCurrentSystemMessage(messages)`
 *   (content append, section patching, tools replay) and estimating it once, then estimating non-system messages
 *   individually (without double-counting updated old system messages);
 * - Same file `estimateTokens`: conservative chars/4 estimate (images count as 4800 chars; system sums content +
 *   sections + toolsAdded chars before `Math.ceil(chars / 4)`).
 *
 * Why extracted locally instead of re-exporting: pi CLI's `estimateTokens` is an internal dist module without a public
 * export—importing private subpaths or pulling the whole CLI package would break package boundaries; pi-ai's public
 * `estimateMessageTokens` uses CHARS_PER_TOKEN=3.5 with different system accounting, so it cannot impersonate the same source.
 * Extracted line-by-line with provenance comments; `calculateContextTokens` and `getCurrentSystemMessage` still reuse pi-ai exports.
 *
 * Helmx semantic mapping (pi branch entries -> pi-durable ContextView):
 * - Both compaction and context edits are context invalidations: the former is a head marker (pi.compaction / pi.reset),
 *   and the latter is an entry with non-empty `edits` (e.g., helmx.rewind omit/replace); anchors are trusted only when strictly newer
 *   than the max of head boundary and latest non-empty edits entry ID (generalized on entry.edits without hardcoding helmx.rewind);
 * - contributions already reflect applied edits (omitted entries contribute []), so checking post-compaction valid assistants
 *   naturally inspects only messages still present in projection.
 */

import type { ContextView } from '@earendil-works/pi-durable'
import { getCurrentSystemMessage, type Message } from '@earendil-works/pi-ai'
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { ConversationContextUsage } from '@helmx/protocol'

/** Valid assistant usage message shape (subset of pi getAssistantUsage predicate). */
type MeasuredAssistant = {
  role: 'assistant'
  usage: Parameters<typeof calculateContextTokens>[0]
}

/** Usage estimation result; tokens=null means true context size is unknown (post-compaction with no measured usage yet). */
interface ContextUsageEstimate {
  tokens: number | null
}

/** `ESTIMATED_IMAGE_CHARS` from pi-agent compaction.js: images count as 4800 characters. */
const ESTIMATED_IMAGE_CHARS = 4800

/** Matches `estimateTextAndImageContentChars` from pi-agent compaction.js:
 * string by length; block arrays sum text block lengths (skipping empty) and fixed cost per image. */
function textAndImageContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue
    const block = raw as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      chars += block.text.length
    } else if (block.type === 'image') {
      chars += ESTIMATED_IMAGE_CHARS
    }
  }
  return chars
}

/**
 * Conservative message token estimate (chars/4), matching pi-agent compaction.js `estimateTokens`;
 * covers all four Message roles in Helmx context (system / user / assistant / toolResult), returning 0 for unknown roles:
 * - system: content + section values + JSON-serialized toolsAdded char lengths;
 * - user / toolResult: text and image char lengths (images count as 4800);
 * - assistant: text / thinking block char lengths + toolCall name and JSON arguments char lengths.
 */
export function estimateTokens(message: Message): number {
  let chars = 0
  switch (message.role) {
    case 'system': {
      chars = textAndImageContentChars(message.content)
      if (message.sections !== undefined) {
        for (const section of Object.values(message.sections)) {
          if (section) chars += section.length
        }
      }
      if (message.toolsAdded !== undefined) chars += JSON.stringify(message.toolsAdded).length
      return Math.ceil(chars / 4)
    }
    case 'user': {
      return Math.ceil(textAndImageContentChars(message.content) / 4)
    }
    case 'assistant': {
      for (const block of message.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'thinking') {
          chars += block.thinking.length
        } else if (block.type === 'toolCall') {
          chars += block.name.length + JSON.stringify(block.arguments).length
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'toolResult': {
      return Math.ceil(textAndImageContentChars(message.content) / 4)
    }
  }
  return 0
}

/** Aligned with pi-agent compaction.js `getAssistantUsage`: role is assistant, stopReason not aborted/error,
 * countable usage with context tokens > 0 (pi-durable contributions already filter aborted/error/deferred messages,
 * and checking here defends against unusual sources so derived UI stats never break refreshes on corrupted entries). */
function isValidMeasuredAssistant(message: unknown): message is MeasuredAssistant {
  if (message === null || typeof message !== 'object') return false
  const m = message as { role?: unknown; usage?: unknown; stopReason?: unknown }
  if (m.role !== 'assistant' || m.usage === null || typeof m.usage !== 'object') return false
  if (m.stopReason === 'aborted' || m.stopReason === 'error') return false
  return calculateContextTokens(m.usage as Parameters<typeof calculateContextTokens>[0]) > 0
}

/**
 * Context usage estimator aligned with pi-agent `getContextUsage`.
 *
 * - Invalidation boundary: max of head marker (compaction/reset) and latest entry with non-empty `edits`;
 *   anchor scan skips the boundary and earlier entries (compaction kept prefix and rewound intervals contain stale usage
 *   that cannot be trusted; pi semantics invalidate all usage prior to the latest invalidation);
 * - Unknown post-compaction: when head is pi.compaction and no valid assistant remains in projection afterwards
 *   (including omitted by subsequent edits), return tokens=null—compaction summary chars must not masquerade as true
 *   context size until the next LLM response reports usage; pi.reset yields a fresh context so full estimate (0) is accurate, not null;
 * - Measured anchor: newest valid assistant after the boundary (last inside contributions); must locate in final
 *   view.messages (defensive fallback to full estimate on miss rather than double-counting usage + full estimate);
 *   tokens = anchor context tokens + chars/4 estimates for each subsequent message;
 * - Full estimate: `getCurrentSystemMessage` collapses effective system once + individual estimates for non-system
 *   messages (matches pi, avoiding double-counting replaced system messages).
 */
export function estimateContextUsage(view: ContextView): ContextUsageEstimate {
  const head = view.head
  const headBoundary = head?.id ?? Number.NEGATIVE_INFINITY
  // Latest entry with non-empty edits (generalized: any context-rewriting entry acts as an invalidation).
  let latestEditBoundary = Number.NEGATIVE_INFINITY
  for (const entry of view.entries) {
    if (entry.edits !== undefined && entry.edits.length > 0 && entry.id > latestEditBoundary) {
      latestEditBoundary = entry.id
    }
  }
  const trustBoundary = Math.max(headBoundary, latestEditBoundary)

  // Reverse scan: anchor = latest valid assistant after boundary; simultaneously check if any valid assistant remains
  // in projection after head (used for post-compaction unknown check regardless of edit boundary—invalidated vs absent are distinct).
  let postHeadValidAssistant = false
  let anchor: MeasuredAssistant | undefined
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]!
    // Skip head marker itself and earlier entries (including kept prefix before compaction); view.entries is NOT strictly
    // ordered by id (head marker precedes kept older entries), so continue instead of breaking early.
    if (entry.id <= headBoundary) continue
    let entryAnchor: MeasuredAssistant | undefined
    for (const message of view.contributions[index]!) {
      if (isValidMeasuredAssistant(message)) {
        postHeadValidAssistant = true
        entryAnchor = message
      }
    }
    if (anchor === undefined && entryAnchor !== undefined && entry.id > trustBoundary) {
      anchor = entryAnchor
    }
  }

  if (head?.kind === 'pi.compaction' && !postHeadValidAssistant) return { tokens: null }

  // Anchor originates from contributions and shares object identity with view.messages (hit via lastIndexOf);
  // if not found (-1), fall back to full estimation rather than double-counting.
  const anchorIndex = anchor === undefined ? -1 : view.messages.lastIndexOf(anchor as Message)
  if (anchor !== undefined && anchorIndex >= 0) {
    let tokens = calculateContextTokens(anchor.usage)
    for (const message of view.messages.slice(anchorIndex + 1)) {
      tokens += estimateTokens(message)
    }
    return { tokens }
  }
  const currentSystem = getCurrentSystemMessage(view.messages)
  let tokens = currentSystem === undefined ? 0 : estimateTokens(currentSystem)
  for (const message of view.messages) {
    if (message.role !== 'system') tokens += estimateTokens(message)
  }
  return { tokens }
}

/** Subset of pi.live compaction state (passthrough shape observed by tracker; matches SDK shape). */
export interface LiveCompactionShape {
  taskId: number
  trigger: string
  blocking: boolean
}

/** Subset of pi.live compactionFailure structure. */
export interface LiveCompactionFailureShape {
  taskId: number
  trigger: string
  error: string
}

/** Subset of pi.live compaction fields (for compactionLiveKeyOf comparison). */
interface LiveCompactionStateShape {
  compactions?: LiveCompactionShape[]
  compactionFailure?: LiveCompactionFailureShape
}

/** Fingerprint of pi.live compaction state (for in-memory comparison only, never published):
 * compactions (taskId, trigger, blocking) list + compactionFailure (taskId, trigger, error). */
export function compactionLiveKeyOf(live: LiveCompactionStateShape | undefined): string {
  if (live === undefined) return ''
  return JSON.stringify([
    (live.compactions ?? []).map((c) => [c.taskId, c.trigger, c.blocking === true]),
    live.compactionFailure !== undefined
      ? [live.compactionFailure.taskId, live.compactionFailure.trigger, live.compactionFailure.error]
      : null,
  ])
}

/** Non-empty pi.live compactions means compaction is running (UI shows compacting indicator;
 * multiple concurrent tasks reduce to true without fabricating trigger specifics). */
export function compactingOf(compactions: readonly LiveCompactionShape[] | undefined): boolean | undefined {
  return compactions !== undefined && compactions.length > 0 ? true : undefined
}

const COMPACTION_TRIGGER_LABEL: Record<string, string> = {
  manual: 'manual',
  threshold: 'threshold',
  overflow: 'overflow',
}

/** Compaction failure notification body (trigger context + redacted error summary, capped at 400 chars).
 * Compaction failures must never be swallowed silently: tracker emits one explicit notification event. */
export function compactionFailureNoticeOf(
  failure: LiveCompactionFailureShape,
  redact: (text: string) => string,
): string {
  const trigger = COMPACTION_TRIGGER_LABEL[failure.trigger] ?? failure.trigger
  const error = redact(failure.error ?? '').trim().slice(0, 400)
  return error === '' ? `${trigger}-triggered context compaction failed (no error details)` : `${trigger}-triggered context compaction failed: ${error}`
}

/**
 * Assemble complete contextUsage (omit optional fields when absent, never fabricate).
 * Caller passes resolved contextWindow from model lookup (undefined when unknown).
 */
export function assembleContextUsage(parts: {
  estimate: ContextUsageEstimate
  contextWindow?: number
  compacting?: boolean
}): ConversationContextUsage {
  return {
    tokens: parts.estimate.tokens,
    ...(parts.contextWindow !== undefined ? { contextWindow: parts.contextWindow } : {}),
    ...(parts.compacting !== undefined ? { compacting: parts.compacting } : {}),
  }
}

/**
 * Semantic contextUsage fingerprint (publish dedupe): emits conversation.upsert only when any payload field changes.
 */
export function contextUsageKeyOf(usage: ConversationContextUsage | undefined): string {
  if (usage === undefined) return ''
  return JSON.stringify([usage.tokens, usage.contextWindow ?? null, usage.compacting ?? null])
}
