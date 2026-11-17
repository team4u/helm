/**
 * Pure logic for the builtin:workflow client: shared formatting and lenient
 * field extraction helpers (zero React/DOM dependencies). Shared by every
 * model-*.ts domain module; inputString / inspectString are internal exports
 * between domain modules and are not exposed through the models.ts facade.
 */
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import { summarizeJsonMoreSuffix } from './copy.ts'

// ---------------------------------------------------------------------------
// Formatting helpers (duration summaries reuse the host lib/format.ts
// implementation shared via @helm/plugin-client)
// ---------------------------------------------------------------------------

export function toolResultPreviewTruncated(preview: string | undefined): boolean {
  return preview?.endsWith('…') === true
}

export function isScrolledToBottom(element: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 36
}

/** First line, truncated with an ellipsis when it exceeds maxChars after trim. */
export function firstLineOf(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

/** Structured-output contract boilerplate injected by spawn. */
const STRUCTURED_OUTPUT_CONTRACT_RE = /<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g

export function stripStructuredOutputContract(text: string): string {
  return text.replace(STRUCTURED_OUTPUT_CONTRACT_RE, '')
}

/** Kernel-generated default subagent conversation titles that carry no task meaning. */
export function isPlaceholderSubagentTitle(title: string, childConversationId: number): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return true
  const lower = trimmed.toLowerCase()
  return (
    lower === `subagent ${childConversationId}` ||
    lower === `subagent #${childConversationId}` ||
    trimmed === `子代理 ${childConversationId}` ||
    trimmed === `子代理 #${childConversationId}` ||
    trimmed === `子会话 ${childConversationId}` ||
    trimmed === `子会话 #${childConversationId}`
  )
}

/** Non-descriptive placeholder run names (`'subagent'`, `'subagent:...'`, or identical to runId). */
export function isPlaceholderRunName(name: string | undefined, runId?: string): boolean {
  if (name === undefined) return true
  const trimmed = name.trim()
  if (trimmed === '') return true
  if (runId !== undefined && trimmed === runId) return true
  const lower = trimmed.toLowerCase()
  return lower === 'subagent' || lower.startsWith('subagent:')
}

/** Non-descriptive node label (`'subagent'` / `'subagent:...'` / blank). */
export function isPlaceholderNodeLabel(label: string | undefined): boolean {
  if (label === undefined) return true
  const trimmed = label.trim()
  if (trimmed === '') return true
  const lower = trimmed.toLowerCase()
  return lower === 'subagent' || lower.startsWith('subagent:')
}

const PURE_HEADING_LABEL_RE = /^(?:汇报|结果|总结|摘要|结论|输出|report|result|results|summary|output)\s*[:：]?$/i
const CODE_FENCE_OR_HR_RE = /^(?:```.*|~~~.*|[-*_]{3,})$/

/** Strip inline Markdown syntax (heading prefix, quote, list item, bold/italic/code/link). */
export function cleanInlineMarkdown(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
    .trim()
}

function isPureHeadingOrDecoratorLine(rawLine: string): boolean {
  const trimmed = rawLine.trim()
  if (trimmed === '') return true
  if (CODE_FENCE_OR_HR_RE.test(trimmed)) return true
  const stripped = trimmed.replace(/^#{1,6}\s*/, '').trim()
  return stripped === '' || PURE_HEADING_LABEL_RE.test(stripped)
}

/**
 * Single-line summary cleaner: skip empty lines and pure heading/decorator
 * prefix lines (e.g. `## 汇报:` / `# 结果`), extract the first line with real
 * content, strip inline Markdown and truncate; if the text only contains
 * heading lines, fall back to the first cleaned line.
 */
export function extractCleanPreviewLine(text: string, maxChars: number): string {
  const lines = text.split('\n')
  let firstNonEmptyCleaned: string | undefined
  for (const raw of lines) {
    const cleaned = cleanInlineMarkdown(raw)
    if (cleaned === '') continue
    if (firstNonEmptyCleaned === undefined) firstNonEmptyCleaned = cleaned
    if (isPureHeadingOrDecoratorLine(raw)) continue
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned
  }
  const fallback = firstNonEmptyCleaned ?? ''
  return fallback.length > maxChars ? `${fallback.slice(0, maxChars)}…` : fallback
}

function formatReadableScalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return cleanInlineMarkdown(value.replace(/\s+/g, ' '))
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Extract a readable key/value summary from a JSON object/array (avoid
 * truncating a bare `{` character). High-value fields such as
 * summary/result/output/message come first; the rest join in key order.
 */
export function summarizeReadableJson(
  value: unknown,
  maxChars: number,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  if (value === null || typeof value !== 'object') {
    const scalar = formatReadableScalar(value)
    return scalar.length > maxChars ? `${scalar.slice(0, maxChars)}…` : scalar
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.slice(0, 3).map((item) => formatReadableScalar(item)).filter((s) => s !== '')
    const suffix = value.length > 3 ? summarizeJsonMoreSuffix(value.length, locale) : ''
    const joined = `${items.join(', ')}${suffix}`
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
  }
  const record = value as Record<string, unknown>
  const priorityKeys = ['summary', 'result', 'output', 'message', 'status', 'error']
  const entries: Array<[string, unknown]> = []
  const seen = new Set<string>()
  for (const k of priorityKeys) {
    if (Object.hasOwn(record, k) && record[k] !== undefined) {
      entries.push([k, record[k]])
      seen.add(k)
    }
  }
  for (const [k, v] of Object.entries(record)) {
    if (seen.has(k) || v === undefined) continue
    entries.push([k, v])
  }
  if (entries.length === 0) return '{}'
  const parts = entries.slice(0, 4).map(([k, v]) => `${k}: ${formatReadableScalar(v)}`)
  const joined = parts.join(' · ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}

/** Extract a string input field (non-empty strings only). */
export function inputString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function inspectString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Short model name: strip the provider/ prefix; empty strings return undefined. */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

/** Read-only serialization of structured values (indented JSON; falls back to String, never fabricates). */
export function stringifyPretty(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
