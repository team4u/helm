/**
 * Tool expanded-body pure data layer (plain .ts, zero React/DOM deps, unit-testable directly).
 *
 * Responsibilities:
 * - write / read / bash display-data extraction (input and structuredOutput fields are only
 *   type-narrowed; missing stays undefined — never fabricate fields or fake file state);
 * - line slicing (head/tail for source previews and output-tail folding — both operate on
 *   locally complete text, recoverable by expanding, unrelated to server truncation);
 * - key-value normalization of generic tool inputs (multiline strings/nested values as blocks, raw-data entry as fallback);
 * - minimal stats for the 26px single-row summary (edit +N −N / write line counts; running state reports facts, never success);
 * - folded step-group stats (StepGroupSummary: thinking/tool/failure/running counts and the two
 *   separately labeled cumulative durations — eligible model-response time and tool execution time).
 */

import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { FoldableStep, ToolResultTruncation, ToolTrace } from './timeline-model.js'
import { languageFromFilename } from './code-language.js'
import { buildPendingEditDiff, checkEditToolResult } from './edit-diff-model.js'

// ---------------------------------------------------------------------------
// Generic tools
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

export function inputPathOf(input: unknown): string | undefined {
  return stringField(asRecord(input), 'path')
}

/** Pretty-print JSON; fall back to String() on cyclic references etc. — never throw mid-render. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function countLines(text: string): number {
  return splitForLines(text).length
}

/** Line splitting: a single trailing newline does not count as a real line (matches editor line numbers). */
function splitForLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface LineSlice {
  /** Displayed text (the original head or tail slice). */
  visible: string
  /** Total lines of the full text. */
  totalLines: number
  /** Folded line count (head: remainder after the kept prefix; tail: folded leading lines). */
  hiddenLines: number
}

/** Head slice: keep the first maxLines lines; hiddenLines = total - kept. */
export function headLines(text: string, maxLines: number): LineSlice {
  const lines = splitForLines(text)
  const keep = Math.min(lines.length, maxLines)
  return {
    visible: lines.slice(0, keep).join('\n'),
    totalLines: lines.length,
    hiddenLines: lines.length - keep,
  }
}

/** Tail slice: keep the last maxLines lines; hiddenLines = folded leading lines. */
export function tailLines(text: string, maxLines: number): LineSlice {
  const lines = splitForLines(text)
  const keep = Math.min(lines.length, maxLines)
  return {
    visible: lines.slice(lines.length - keep).join('\n'),
    totalLines: lines.length,
    hiddenLines: lines.length - keep,
  }
}

/** Key-value normalization: short single-line values inline; multiline/long strings and nested values marked as blocks (raw JSON fallback). */
export interface KvEntry {
  key: string
  value: string
  /** true = block display (monospace block), false = single-line inline. */
  block: boolean
}

const KV_INLINE_MAX_CHARS = 160

export function inputKvEntries(input: unknown): KvEntry[] {
  const record = asRecord(input)
  if (record === undefined) {
    if (typeof input === 'string') return [{ key: 'input', value: input, block: input.includes('\n') || input.length > KV_INLINE_MAX_CHARS }]
    return []
  }
  const entries: KvEntry[] = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      entries.push({
        key,
        value,
        block: value.includes('\n') || value.length > KV_INLINE_MAX_CHARS,
      })
    } else {
      const json = prettyJson(value)
      entries.push({ key, value: json, block: json.includes('\n') || json.length > KV_INLINE_MAX_CHARS })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Server truncation preview copy (pure function: never present preview line counts as the full total; never fabricate unknown totals)
// ---------------------------------------------------------------------------

/**
 * Server-truncation preview note (pure function): never present preview line
 * counts as the full total; never fabricate totals the server did not report.
 */
export function truncationPreviewNote(truncation: ToolResultTruncation, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  const total =
    truncation.totalLines !== undefined
      ? tt('conv.trunc.linesTotal', { count: truncation.totalLines })
      : truncation.totalChars !== undefined
        ? tt('conv.trunc.charsTotal', { count: truncation.totalChars })
        : ''
  return total === '' ? tt('conv.trunc.previewOnly') : tt('conv.trunc.previewOnlyWithTotal', { total })
}

// ---------------------------------------------------------------------------
// write / read / bash display data
// ---------------------------------------------------------------------------

export interface WriteBodyData {
  path: string | undefined
  content: string | undefined
  language: string
  lineCount: number | undefined
  /** Bytes reported by a successful result (structuredOutput.bytesWritten, type-narrowed only). */
  bytesWritten: number | undefined
}

export function writeBodyData(tool: ToolTrace): WriteBodyData {
  const input = asRecord(tool.input)
  const path = stringField(input, 'path')
  const content = stringField(input, 'content')
  const structured = asRecord(tool.structuredOutput)
  const bytes = structured?.bytesWritten
  return {
    path,
    content,
    language: languageFromFilename(path),
    lineCount: content !== undefined ? countLines(content) : undefined,
    bytesWritten:
      tool.status === 'done' && !tool.isError && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
        ? bytes
        : undefined,
  }
}

export interface ReadBodyData {
  /** Content to display: structuredOutput.content first, falling back to resultText. */
  content: string | undefined
  language: string
  /** Output contains a kernel over-length Spill marker: preview-grade text, no source syntax highlighting. */
  isSpill: boolean
  /** true = content comes from the raw output text (resultText), subject to server preview truncation;
   * false = structuredOutput.content (details channel, transferred in full, unaffected by result-text truncation). */
  fromResultText: boolean
}

export function readBodyData(tool: ToolTrace): ReadBodyData {
  const structured = asRecord(tool.structuredOutput)
  const input = asRecord(tool.input)
  const path = stringField(structured, 'path') ?? stringField(input, 'path')
  const structuredContent = stringField(structured, 'content')
  const content = structuredContent ?? tool.resultText
  return {
    content,
    language: languageFromFilename(path),
    isSpill: tool.artifactRef !== undefined,
    fromResultText: structuredContent === undefined && tool.resultText !== undefined,
  }
}

export interface BashBodyData {
  command: string | undefined
  output: string | undefined
  /** structuredOutput.exitCode: a number is the real value; null means no exit code (e.g. spawn failure). */
  exitCode: number | null | undefined
  timedOut: boolean
}

export function bashBodyData(tool: ToolTrace): BashBodyData {
  const input = asRecord(tool.input)
  const structured = asRecord(tool.structuredOutput)
  const exit = structured?.exitCode
  return {
    command: stringField(input, 'command'),
    output: tool.resultText,
    exitCode: typeof exit === 'number' && Number.isSafeInteger(exit) ? exit : exit === null ? null : undefined,
    timedOut: structured?.timedOut === true,
  }
}

// ---------------------------------------------------------------------------
// Minimal 26px single-row stats (facts only: diff line counts / content line counts; running state never claims success)
// ---------------------------------------------------------------------------

export interface ToolRowStats {
  addCount?: number
  removeCount?: number
  /** Plain-text stat (e.g. "12 lines" for write). */
  text?: string
  /** Hover explanation: where the numbers come from (applied diff / pending hunks). */
  title: string
}

export function toolRowStats(tool: ToolTrace, t?: WebMessageTranslator): ToolRowStats | undefined {
  const tt = t ?? englishWebTranslator
  // Rows taken over by a plugin tool.view are drawn by the plugin; the host adds no stats.
  if (tool.toolView !== undefined) return undefined
  if (tool.toolName === 'edit') {
    if (tool.status === 'done' && !tool.isError) {
      const check = checkEditToolResult(tool.structuredOutput)
      if (check.ok) {
        return {
          addCount: check.value.diff.addedLines,
          removeCount: check.value.diff.removedLines,
          title: tt('conv.stats.appliedDiff'),
        }
      }
      return undefined
    }
    if (tool.status === 'running') {
      const pending = buildPendingEditDiff(tool.input)
      if (pending?.kind === 'computed') {
        return {
          addCount: pending.addedLines,
          removeCount: pending.removedLines,
          title: tt('conv.stats.pendingHunks'),
        }
      }
    }
    return undefined
  }
  if (tool.toolName === 'write') {
    const content = stringField(asRecord(tool.input), 'content')
    if (content === undefined) return undefined
    return { text: tt('conv.stats.linesCount', { count: countLines(content) }), title: tt('conv.stats.writtenLines') }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Folded step-group summary (pure aggregate stats for StepGroup / MultiStepGroup)
// ---------------------------------------------------------------------------

export interface StepGroupSummary {
  stepCount: number
  thinkingCount: number
  toolCount: number
  errorCount: number
  runningCount: number
  /**
   * Cumulative model-response time (ms) of the eligible responses folded into this group
   * (thinking + toolCall, no non-empty visible text; one contribution per assistant message via
   * structural first-thinking-block attachment). Omitted when nothing attributable is known —
   * never fabricated. This is a cumulative total, not wall-clock elapsed time.
   */
  modelDurationMs?: number
  /**
   * Cumulative tool execution time (ms) within this group: concurrently running tools each count
   * their own execution, so the sum can exceed wall-clock elapsed time — the UI must label it as
   * cumulative. Omitted when no valid positive duration is known.
   */
  toolDurationMs?: number
}

/**
 * Aggregate thinking/tool counts, failure/running counts, and the two separately labeled
 * cumulative durations within a folded step group:
 * - `modelDurationMs` sums eligible model-response durations attached to thinking blocks
 *   (structural once-per-message allocation in timeline-model; invalid values are dropped here too);
 * - `toolDurationMs` sums valid positive tool execution durations (a labeled cumulative total —
 *   the backend's ToolResultMessage.timestamp is settlement time, not execution end, so true
 *   wall-clock intervals cannot be derived and are never faked).
 * Zeros, negatives, non-finite and missing durations are excluded from both sums.
 */
export function summarizeStepGroup(steps: ReadonlyArray<FoldableStep>): StepGroupSummary {
  let thinkingCount = 0
  let toolCount = 0
  let errorCount = 0
  let runningCount = 0
  let modelDurationSum = 0
  let toolDurationSum = 0

  for (const step of steps) {
    if (step.kind === 'thinking') {
      thinkingCount += 1
      const m = step.thinking.responseDurationMs
      if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
        modelDurationSum += m
      }
      continue
    }
    toolCount += 1
    if (step.tool.isError || step.tool.status === 'error') {
      errorCount += 1
    }
    if (step.tool.status === 'running') {
      runningCount += 1
    }
    const d = step.tool.durationMs
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
      toolDurationSum += d
    }
  }

  return {
    stepCount: steps.length,
    thinkingCount,
    toolCount,
    errorCount,
    runningCount,
    ...(modelDurationSum > 0 ? { modelDurationMs: modelDurationSum } : {}),
    ...(toolDurationSum > 0 ? { toolDurationMs: toolDurationSum } : {}),
  }
}
