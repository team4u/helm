/**
 * HTTP detail situation exit ConversationEntry throw shadow (pure function, mechanism layer).
 *
 * consumer: only detail situation page (ConversationDetailService.getConversationDetail) and
 * single end point (getConversationEntry signature strip).SSE conversation.entry event,
 * SDK rewind/context/settlement and waitForInput result one rule do not via this throw shadow - -
 * toConversationEntry since has semantics keep do not change.
 *
 * policy (detail see @helm/protocol ConversationEntry throw shadow convention note release):
 * - `pi.system`: model side register record (system prompt/tool declaration), detail situation page do not outside;
 * - provider signature payload thinkingSignature / textSignature / thoughtSignature
 *   (pi-ai TextContent / ThinkingContent / ToolCall do not transparent encryption chunk): for
 *   client without semantics and body accumulate can observe, exit unify strip - - only limit assistant message content
 *   chunk,toolResult details etc. business object and entry.data do not trigger touch; database original text do not change;
 * - over limit pure text toolResult explicit truncate: keep head tail, message level carry
 *   truncated/totalChars/totalLines(and each pi.tool-result precise match for, without
 *   many message ambiguity); structure channel details(subagent/SubagentWorkflow etc.) and
 *   can parse JSON text exemption (truncate will break downstream parse); tail part `[Artifact] id=`
 *   tail mark because keep tail part while day however keep.
 */

import type { ConversationEntry } from '@helm/protocol'

/** provider signature payload key (pi-ai content chunk/tool invoke field). */
const SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  'thinkingSignature',
  'textSignature',
  'thoughtSignature',
])

/** tool-result pure text truncate threshold (character, throw shadow layer;SDK itself output limit quota of outside finally guard against line).
 * bash spill preview (≈4KiB head + 256B tail) and read_artifact(≤128KiB) is typical
 * large output source: threshold take 1536 character (head 1024 + tail 512 + omit mark record),100 /page
 * detail situation page therefore has determine on boundary. */
export const TOOL_RESULT_TRUNCATE_THRESHOLD_CHARS = 1536
/** truncate after keep header character count. */
export const TOOL_RESULT_HEAD_CHARS = 1024
/** truncate after keep tail part character count ([Artifact] id= tail mark follow tail part keep). */
export const TOOL_RESULT_TAIL_CHARS = 512

/**
 * single entry through use redaction (detail situation page and single end point shared use):
 * - only for role=assistant message content content chunk strip signature key - - signature is pi-ai
 *   provider for assistant think/text/tool invoke chunk do not transparent payload;
 * - toolResult message (contains details business object) and other role one rule do not trigger touch (details
 *   is plugin structure JSON, may legal carry same name segment);entry.data same do not motion;
 * - copy-on-write: without hit return original object (zero copy), never change write input (SSE/SDK and
 *   database sharing the same record).
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
// tool-result pure text truncate
// ---------------------------------------------------------------------------

/** pure text content decide: string, or all is {type:'text'} chunk array (and frontend
 * contentTextOf concatenate opening path consistent). */
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

/** content all text (chunk text directly concatenate, and frontend render opening path consistent). */
function combinedTextOf(content: string | ReadonlyArray<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((block) => block.text).join('')
}

/** structure result text exemption:subagent / SubagentWorkflow etc. text is complete JSON
 * message seal (can carries `[subagent ...]` / `[Artifact] ...` style tail part footer row),
 * truncate will break downstream parse. decide: whole can parse JSON, or strip tail part single row way parentheses
 * footer after can parse JSON. */
function isStructuredJsonText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  if (parsable(trimmed)) return true
  const lines = trimmed.split('\n')
  // self tail row start strip shape such as [ ... ] single row footer(at most 4 row), remaining body can parse i.e. exemption.
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

/** already by artifacts spill layer truncate text (carry [Artifact] id= all text entry):
 * all text in artifact in, item only store preview - - again stack add throw shadow truncate will let frontend mistakenly with is single end point can
 * take back complete output. this layer never duplicate truncate, keep existing artifact entry. */
const ARTIFACT_SPILL_MARKER_RE = /\[Artifact\]\s+id=/

/** truncate text: keep head tail + self description omit mark record (contains all text rule mode and take original text refer quote). */
function truncatePlainText(text: string): { text: string; totalChars: number; totalLines: number } {
  const totalChars = text.length
  const totalLines = text === '' ? 0 : text.split('\n').length
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS)
  const tail = text.slice(totalChars - TOOL_RESULT_TAIL_CHARS)
  const omitted = totalChars - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS
  const marker =
    `\n\n...[helm truncate: omit ${omitted} character (all text ${totalChars} character / ${totalLines} row,` +
    'GET /api/conversations/<id>/entries/<entryId> take not truncate original text]...\n\n'
  return { text: `${head}${marker}${tail}`, totalChars, totalLines }
}

/** single model message truncate throw shadow; no need to truncate when original return (sharing reference).
 * truncate when in message object on append truncated/totalChars/totalLines(message level mark record,
 * and each pi.tool-result precise match for, without top-level ambiguity). */
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
 * detail situation page throw shadow:pi.system filter + signature strip + security pure text tool-result truncate.
 * return undefined means the do not outside (pi.system). input do not by change write.
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
