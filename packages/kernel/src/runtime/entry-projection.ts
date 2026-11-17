/**
 * HTTP detail boundary ConversationEntry projection (pure functions, mechanism layer).
 *
 * Consumers: only detail pagination (ConversationDetailService.getConversationDetail) and
 * single-entry endpoint (getConversationEntry signature stripping). SSE `conversation.entry` events,
 * SDK rewind/context/settlement, and waitForInput results never pass through this projection—preserving
 * existing semantics of toConversationEntry.
 *
 * Policy (see @helm/protocol ConversationEntry projection docs for details):
 * - `pi.system`: model-side bookkeeping (system prompt / tool declarations), hidden on detail pages;
 * - Provider signature payloads thinkingSignature / textSignature / thoughtSignature
 *   (pi-ai TextContent / ThinkingContent / ToolCall opaque encrypted blocks): meaningless to clients and observable
 *   bloat, uniformly stripped on output—limited strictly to assistant message content blocks, leaving toolResult
 *   details/business objects and entry.data untouched; database originals stay unchanged;
 * - Oversized plain-text toolResult gets explicit truncation: preserves head and tail, setting message-level
 *   truncated/totalChars/totalLines (matching each pi.tool-result 1:1 with no multi-message ambiguity);
 *   structured channel details (subagent / SubagentWorkflow, etc.) and parseable JSON text are exempted
 *   (truncating would break downstream parsers); trailing `[Artifact] id=` markers stay intact automatically because the tail is kept.
 */

import type { ConversationEntry } from '@helm/protocol'

/** Provider signature payload keys (pi-ai content block / tool call fields). */
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  'thinkingSignature',
  'textSignature',
  'thoughtSignature',
])

/** Tool-result plain-text truncation threshold (chars, projection layer; outer defense line beyond SDK output cap).
 * bash spill previews (~4KiB head + 256B tail) and read_artifact (<=128KiB) are typical large output sources:
 * a 1536-char cap (1024 head + 512 tail + omission marker) keeps 100-entry detail pages deterministically bounded. */
export const TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS = 1536
/** Number of leading chars preserved on truncation. */
export const TOOL_RESULT_HEAD_CHARS = 1024
/** Number of trailing chars preserved on truncation (preserves `[Artifact] id=` markers at the tail). */
export const TOOL_RESULT_TAIL_CHARS = 512

/**
 * Single-entry signature stripping (shared by detail pagination and single-entry endpoint):
 * - Strips signature keys only inside role=assistant message content blocks (signature holds pi-ai provider
 *   opaque payloads for thinking/text/toolCall blocks);
 * - toolResult messages (incl. details business objects) and other roles are never touched (details hold plugin JSON
 *   which could legitimately carry same-named keys); entry.data is untouched;
 * - Copy-on-write: returns original object on zero hits (zero copy), never mutating input (shared with SSE/SDK/DB).
 */
export function stripEntrySignatures(entry: ConversationEntry): ConversationEntry {
  if (entry.model === undefined) return entry
  let changed = false
  const model = entry.model.map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
    const m = message as Record<string, unknown>
    if (m['role'] !== 'assistant') return message
    const content = m['content']
    if (!Array.isArray(content)) return message
    let contentChanged = false
    const projectedContent = content.map((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return block
      if (Object.getPrototypeOf(block) !== Object.prototype) return block
      let blockChanged = false
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(block)) {
        if (SIGNATURE_KEYS.has(key)) {
          blockChanged = true
          continue
        }
        out[key] = value
      }
      if (!blockChanged) return block
      contentChanged = true
      return out
    })
    if (!contentChanged) return message
    changed = true
    return { ...m, content: projectedContent }
  })
  if (!changed) return entry
  return { ...entry, model }
}

// ---------------------------------------------------------------------------
// Plain-text tool-result truncation
// ---------------------------------------------------------------------------

/** Check if content is plain text: a string or an array of {type:'text'} blocks (matching frontend contentTextOf concatenation). */
function isPlainTextContent(content: unknown): content is string | ReadonlyArray<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.every(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
}

/** Combine text content (concatenates block text directly, matching frontend rendering). */
function combinedTextOf(content: string | ReadonlyArray<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((block) => block.text).join('')
}

/** Exempt structured JSON payloads: subagent / SubagentWorkflow outputs are full JSON envelopes (possibly with
 * trailing `[subagent ...]` / `[Artifact] ...` footer lines) whose downstream parsing breaks if truncated.
 * Exempt if parseable directly or after stripping up to 4 trailing single-line bracketed footers. */
function isStructuredJsonText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  if (parsable(trimmed)) return true
  const lines = trimmed.split('\n')
  // Strip up to 4 trailing `[ ... ]` single-line footers and exempt if the remaining body parses as JSON.
  for (let drop = 1; drop <= Math.min(4, lines.length - 1); drop += 1) {
    const candidate = lines.slice(0, lines.length - drop).join('\n').trim()
    if (candidate === '' || (!candidate.startsWith('{') && !candidate.startsWith('['))) break
    const footerOnly = lines.slice(lines.length - drop).every((l) => /^\[[^\n]*\]\s*$/.test(l.trim()))
    if (footerOnly && parsable(candidate)) return true
  }
  return false
}

function parsable(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Text already spilled into an artifact (carries `[Artifact] id=` marker for full text):
 * full output lives in the artifact while the entry holds only a preview—double-truncating in projection would mislead
 * the UI into fetching the single-entry endpoint expecting the full output. Leave existing artifact entries untouched. */
const ARTIFACT_SPILL_MARKER_RE = /\[Artifact\]\s+id=/

/** Truncate text: keep head and tail + self-describing omission marker (states full length and single-entry endpoint). */
function truncatePlainText(text: string): { text: string; totalChars: number; totalLines: number } {
  const totalChars = text.length
  const totalLines = text === '' ? 0 : text.split('\n').length
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS)
  const tail = text.slice(totalChars - TOOL_RESULT_TAIL_CHARS)
  const omitted = totalChars - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS
  const marker =
    `\n\n...[helm truncate: omitted ${omitted} characters (${totalChars} chars / ${totalLines} lines; ` +
    'GET /api/conversations/<id>/entries/<entryId> for untruncated original text)]...\n\n'
  return { text: `${head}${marker}${tail}`, totalChars, totalLines }
}

/** Project truncation onto a single model message; returns original reference if no truncation is needed.
 * Attaches truncated/totalChars/totalLines on the message object (matching each pi.tool-result 1:1 with no top-level ambiguity). */
function projectToolResultMessage(message: unknown): unknown {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
  const m = message as Record<string, unknown>
  if (m['role'] !== 'toolResult' && m['role'] !== 'tool') return message
  const content = m['content']
  if (!isPlainTextContent(content)) return message
  const text = combinedTextOf(content)
  if (text.length <= TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS) return message
  if (isStructuredJsonText(text)) return message
  if (ARTIFACT_SPILL_MARKER_RE.test(text)) return message
  const truncated = truncatePlainText(text)
  const projectedContent =
    typeof content === 'string' ? truncated.text : [{ type: 'text', text: truncated.text }]
  return {
    ...m,
    content: projectedContent,
    truncated: true as const,
    totalChars: truncated.totalChars,
    totalLines: truncated.totalLines,
  }
}

/**
 * Detail page projection: filter pi.system + strip signatures + safe plain-text tool-result truncation.
 * Returning undefined hides the entry from detail timelines (pi.system). Does not mutate input.
 */
export function projectDetailEntry(entry: ConversationEntry): ConversationEntry | undefined {
  if (entry.kind === 'pi.system') return undefined
  const stripped = stripEntrySignatures(entry)
  if (stripped.kind !== 'pi.tool-result' || stripped.model === undefined) return stripped
  let changed = false
  const model = stripped.model.map((message) => {
    const projected = projectToolResultMessage(message)
    if (projected !== message) changed = true
    return projected
  })
  return changed ? { ...stripped, model } : stripped
}
