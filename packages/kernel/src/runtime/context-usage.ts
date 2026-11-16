/**
 * conversation context use amount compute (pure function; align pi agent 1.5.2 real source code semantics).
 *
 * fact based on (@earendil-works/pi-coding-agent 1.5.2 measured source code):
 * - `dist/core/agent-session.js`  `getContextUsage`: valid assistant usage
 *   (stopReason non- aborted/error and context tokens > 0) at most near once compress after
 *   only then can message; compress after still without still in projection in valid assistant when tokens unknown
 *   (null);
 * - `dist/core/compaction/compaction.js`  `estimateProjectedContextTokens`:
 *   finally once usage if at most near once context invalidation(compaction /
 *   context_edit) before one rule expires, retreat is all amount estimate compute - - first use pi-ai public
 *   `getCurrentSystemMessage(messages)` collapse when before takes effect system(content append,
 *   sections by name patch,tools replay), estimate compute it once, again one by one estimate compute non- system
 *   message (does not repeat count by update old system);
 * - same file `estimateTokens`:chars/4 keep guard estimate compute (diagram piece by 4800 character,system 
 *   content + sections + toolsAdded merge count total character after Math.ceil(/4)).
 *
 * is what local extract while do not re- use now into export:pi CLI  `estimateTokens` not from any public
 * package export (only CLI dist internal module), away private sub- path or introduce the whole CLI package all violate reverse package
 * boundary;pi-ai public `estimateMessageTokens` is CHARS_PER_TOKEN=3.5 another
 * set algorithm (system count method also different), do not smoke fill same source. this where by Pi source code one by one row extract is small pure
 * function and note out where;`calculateContextTokens` and `getCurrentSystemMessage`
 * still re- use pi-ai public export (and Pi the same source public style).
 *
 * helm semantics mapping (pi branch item -> pi-durable ContextView):
 * - compaction / context edit all is context invalidation: before is head mark record
 *   (pi.compaction / pi.reset), after is carry `edits` item (such as helm.rewind
 *    omit/replace); anchor only later thanhead boundary and most new edits non-empty item id 
 *   relatively large only then can message (generalize decide entry.edits, do not hard encode helm.rewind policy);
 * - contributions already by edits should use (omit item contribution is empty array),post-compaction
 *   valid assistant decide day however only see still in projection in message.
 */

import type { ContextView } from '@earendil-works/pi-durable'
import { getCurrentSystemMessage, type Message } from '@earendil-works/pi-ai'
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { ConversationContextUsage } from '@helm/protocol'

/** valid assistant usage message shape (pi getAssistantUsage decide structure sub- collection). */
type MeasuredAssistant = {
  role: 'assistant'
  usage: Parameters<typeof calculateContextTokens>[0]
}

/** estimate compute result;tokens is null means real context unknown (compress after still without valid usage). */
export interface ContextUsageEstimate {
  tokens: number | null
}

/** pi agent compaction.js `ESTIMATED_IMAGE_CHARS`: diagram piece by 4800 character count. */
const ESTIMATED_IMAGE_CHARS = 4800

/** pi agent compaction.js `estimateTextAndImageContentChars` same style:
 * string by length; chunk array cumulative text chunk character and diagram piece fixed character (empty text chunk skip). */
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
 * message tokens keep guard estimate compute (chars/4), one by one row align pi agent compaction.js 
 * `estimateTokens`; override helm context support four Message role
 * (system / user / assistant / toolResult), unknown role count 0:
 * - system:content + sections value + toolsAdded  JSON serialization merge total character;
 * - user / toolResult:text and diagram piece content character (diagram piece by 4800);
 * - assistant:text / thinking chunk character + toolCall  name and parameter JSON character.
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

/** pi agent compaction.js `getAssistantUsage` same style decide:role is assistant,
 * stopReason non- aborted/error,usage shape can compute and context tokens > 0(pi-durable
 *  contributions already remove aborted/error/deferred message, this where by the same rule guard against defend
 * very rule source, derive render data do not because other corrupt item interrupt refresh). */
function isValidMeasuredAssistant(message: unknown): message is MeasuredAssistant {
  if (message === null || typeof message !== 'object') return false
  const m = message as { role?: unknown; usage?: unknown; stopReason?: unknown }
  if (m.role !== 'assistant' || m.usage === null || typeof m.usage !== 'object') return false
  if (m.stopReason === 'aborted' || m.stopReason === 'error') return false
  return calculateContextTokens(m.usage as Parameters<typeof calculateContextTokens>[0]) > 0
}

/**
 * align pi agent `getContextUsage` context estimate compute.
 *
 * - expires boundary:head mark record (compaction/reset) and most new carry non-empty `edits` item
 *   take relatively large; anchor scan skip boundary and more early item (compress keep prefix and by rewind override
 *   zone between inside old usage all cannot message,pi semantics: most new invalidation before usage one rule expires);
 * - compress after unknown:head is pi.compaction and head after no any still in projection
 *   in valid assistant(contains by after continue edit omit case) when tokens=null- - summary
 *   character estimate compute do not smoke fill real context, until under once LLM response on report usage;pi.reset is
 *   all new context, all amount estimate compute (0) i.e. real value, do not is null;
 * - measured anchor: boundary after most near a valid assistant(contributions inside finally a);
 *   anchor must in eventually view.messages in can locate (guard against defend: locate failed by without anchor handle,
 *   never usage and all amount estimate compute each other add build into duplicate count amount);tokens = anchor usage context
 *   tokens + its after message one by one chars/4 estimate compute;
 * - all amount estimate compute:`getCurrentSystemMessage` collapse when before takes effect system estimate compute once +
 *   each non- system message one by one estimate compute (pi same style, does not repeat count by update old system).
 */
export function estimateContextUsage(view: ContextView): ContextUsageEstimate {
  const head = view.head
  const headBoundary = head?.id ?? Number.NEGATIVE_INFINITY
  // most new edits non-empty item (generalize decide: any carry context override item all is invalidation).
  let latestEditBoundary = Number.NEGATIVE_INFINITY
  for (const entry of view.entries) {
    if (entry.edits !== undefined && entry.edits.length > 0 && entry.id > latestEditBoundary) {
      latestEditBoundary = entry.id
    }
  }
  const trustBoundary = Math.max(headBoundary, latestEditBoundary)

  // tail to scan: anchor = boundary after most near a valid assistant; also decide head after
  // is otherwise store in any still in projection in valid assistant(compress after unknown decide use,
  // do not subject to edit boundary affect - - by edit expires and from not store in is two back matter).
  let postHeadValidAssistant = false
  let anchor: MeasuredAssistant | undefined
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]!
    // head mark record itself and its before old item (contains compress keep prefix) all cannot message;entries is not
    // rise order (head mark record reside first, keep item id more small), only can one by one skip cannot mention before break.
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

  // anchor object from contributions, and messages same source same reference (lastIndexOf by identity
  // hit); locate failed (-1) by without anchor away all amount estimate compute, never duplicate count amount.
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

/** pi.live compaction state structure sub- collection (tracker mirror pass-through use; field by real SDK shape). */
export interface LiveCompactionShape {
  taskId: number
  trigger: string
  blocking: boolean
}

/** pi.live compactionFailure structure sub- collection. */
export interface LiveCompactionFailureShape {
  taskId: number
  trigger: string
  error: string
}

/** pi.live compress related field structure sub- collection (compactionLiveKeyOf refer grain than for use). */
export interface LiveCompactionStateShape {
  compactions?: LiveCompactionShape[]
  compactionFailure?: LiveCompactionFailureShape
}

/** pi.live compress state refer grain (only memory than for use, do not for outside publish):compactions 
 * (taskId,trigger,blocking) sequence + compactionFailure  (taskId,trigger,error). */
export function compactionLiveKeyOf(live: LiveCompactionStateShape | undefined): string {
  if (live === undefined) return ''
  return JSON.stringify([
    (live.compactions ?? []).map((c) => [c.taskId, c.trigger, c.blocking === true]),
    live.compactionFailure !== undefined
      ? [live.compactionFailure.taskId, live.compactionFailure.trigger, live.compactionFailure.error]
      : null,
  ])
}

/** pi.live compactions non-empty i.e. compress in progress (only read render streamline in...; many items task
 * take any a in-flight all is true, do not fabricate trigger detail). */
export function compactingOf(compactions: readonly LiveCompactionShape[] | undefined): boolean | undefined {
  return compactions !== undefined && compactions.length > 0 ? true : undefined
}

const COMPACTION_TRIGGER_LABEL: Record<string, string> = {
  manual: 'manually',
  threshold: 'threshold',
  overflow: 'overflow',
}

/** compress failed notify body text (trigger semantics + redaction error summary, truncate 400 character).
 * compress failed must not static default: by tracker via notification event explicit on report once. */
export function compactionFailureNoticeOf(
  failure: LiveCompactionFailureShape,
  redact: (text: string) => string,
): string {
  const trigger = COMPACTION_TRIGGER_LABEL[failure.trigger] ?? failure.trigger
  const error = redact(failure.error ?? '').trim().slice(0, 400)
  return error === '' ? `${trigger} trigger context streamline failed (without error detail)` : `${trigger} trigger context streamline failed:${error}`
}

/**
 * group install complete contextUsage(can missing field all omit, do not fabricate).
 * contextWindow by caller by model parse result to out (unknown pass undefined).
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
 * contextUsage semantics refer grain (publish dedupe): any one bear load field change only then publish conversation.upsert.
 */
export function contextUsageKeyOf(usage: ConversationContextUsage | undefined): string {
  if (usage === undefined) return ''
  return JSON.stringify([usage.tokens, usage.contextWindow ?? null, usage.compacting ?? null])
}
