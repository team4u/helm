/**
 * Pure parsing layer for builtin:workflow background settlement reports
 * (precise takeover of helm.input via meta.renderer).
 *
 * Existing body contract: a single-line lead + '\n' + report JSON (produced
 * by deliverBackgroundReport). This module splits at the first newline and
 * strictly validates the fields actually read for display/navigation (runId
 * consistent with meta, a legal terminal status, positive-integer execution
 * conversation ids, ...); result is a business value — null/false/0/'' are all
 * legal, detection is by key presence only, never dropped via truthiness.
 * Corrupted data returns an invalid view (an explicit "malformed" marker plus
 * the raw text preserved for expanding/copying) — success is never faked.
 */

import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import type { ConversationEntry } from '@helm/protocol'
import { extractCleanPreviewLine, isPlaceholderRunName, summarizeReadableJson } from './model-format.ts'

/** Report kind (meta.kind; decides the card title). */
export type BackgroundReportKind = 'subagent_report' | 'workflow_report'

/** Terminal statuses (deliverBackgroundReport only delivers after a run reaches a terminal state; running is not a report). */
export type BackgroundReportStatus = 'completed' | 'failed' | 'aborted'

/** Snapshot of other in-flight runs at delivery time (display only, drives no logic). */
export interface BackgroundReportOtherTask {
  runId: string
  name: string
  kind: string
}

/** Valid report view: an immutable snapshot of the entry itself; does not subscribe to runsDoc. */
export interface BackgroundReportView {
  invalid: false
  kind: BackgroundReportKind
  runId: string
  /** Task display name from report payload (never invented when absent or placeholder). */
  name?: string
  status: BackgroundReportStatus
  /** Delivery timestamp (epoch ms, from entry.createdAt or data.createdAt). */
  createdAt?: number
  /** Whether the report carries a result key (the value may be any JSON value, including null/false/0/''). */
  hasResult: boolean
  result: unknown
  /** Raw error digest on failure/abort (may be an empty string). */
  error: string | undefined
  /** execution.conversationId (navigation entry only for positive integers; undefined without execution or when invalid). */
  executionConversationId: number | undefined
  otherRunningTasks: BackgroundReportOtherTask[]
  /** Full raw body text (for copying; not duplicated into meta). */
  rawText: string
}

/** Corrupted report view: still expandable with the raw text copyable. */
export interface BackgroundReportInvalidView {
  invalid: true
  createdAt?: number
  rawText: string
}

export type BackgroundReportParse = BackgroundReportView | BackgroundReportInvalidView

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted'])

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function extractEntryCreatedAt(entry: ConversationEntry, data: Record<string, unknown> | undefined): number | undefined {
  if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
    return entry.createdAt
  }
  if (data !== undefined) {
    const raw = data['createdAt']
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  }
  return undefined
}

/**
 * Parse a report entry. Validation failures (shape/JSON/runId
 * mismatch/illegal terminal status, ...) return invalid; callers must never
 * render invalid as success.
 */
export function parseBackgroundReportEntry(entry: ConversationEntry): BackgroundReportParse {
  const data = entry.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return invalidOf(entry)
  const d = data as Record<string, unknown>
  const createdAt = extractEntryCreatedAt(entry, d)
  if (typeof d.text !== 'string') return invalidOf(entry)
  const meta = d.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return invalidOf(entry)
  const m = meta as Record<string, unknown>
  const kind: BackgroundReportKind | undefined =
    m.kind === 'subagent_report' || m.kind === 'workflow_report' ? m.kind : undefined
  const backgroundRunId = typeof m.backgroundRunId === 'string' ? m.backgroundRunId : undefined
  if (kind === undefined || backgroundRunId === undefined || backgroundRunId === '') return invalidOf(entry)

  // Body contract: first line is the lead + newline + JSON. No newline means
  // the contract is violated.
  const newlineIndex = d.text.indexOf('\n')
  if (newlineIndex < 0) return invalidOf(entry)
  let report: unknown
  try {
    report = JSON.parse(d.text.slice(newlineIndex + 1))
  } catch {
    return invalidOf(entry)
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return invalidOf(entry)
  const r = report as Record<string, unknown>

  if (typeof r.runId !== 'string' || r.runId !== backgroundRunId) return invalidOf(entry)
  if (typeof r.status !== 'string' || !TERMINAL_STATUSES.has(r.status)) return invalidOf(entry)
  if (r.name !== undefined && typeof r.name !== 'string') return invalidOf(entry)
  if (r.error !== undefined && typeof r.error !== 'string') return invalidOf(entry)
  const rawName = typeof r.name === 'string' ? r.name.trim() : ''
  const name = rawName !== '' && !isPlaceholderRunName(rawName, r.runId) ? rawName : undefined

  // execution: only the navigation-relevant conversationId is consumed
  // (positive integer); other fields stay preserved in the raw text.
  let executionConversationId: number | undefined
  if (r.execution !== undefined) {
    if (r.execution === null || typeof r.execution !== 'object' || Array.isArray(r.execution)) {
      return invalidOf(entry)
    }
    const conversationId = (r.execution as Record<string, unknown>).conversationId
    if (conversationId !== undefined) {
      if (!isSafePositiveInt(conversationId)) return invalidOf(entry)
      executionConversationId = conversationId
    }
  }

  // otherRunningTasks: snapshot at delivery time; display fields strictly
  // validated per item.
  const otherRunningTasks: BackgroundReportOtherTask[] = []
  if (r.otherRunningTasks !== undefined) {
    if (!Array.isArray(r.otherRunningTasks)) return invalidOf(entry)
    for (const task of r.otherRunningTasks) {
      if (task === null || typeof task !== 'object' || Array.isArray(task)) return invalidOf(entry)
      const t = task as Record<string, unknown>
      if (typeof t.runId !== 'string' || typeof t.name !== 'string' || typeof t.kind !== 'string') {
        return invalidOf(entry)
      }
      otherRunningTasks.push({ runId: t.runId, name: t.name, kind: t.kind })
    }
  }

  return {
    invalid: false,
    kind,
    runId: r.runId,
    ...(name !== undefined ? { name } : {}),
    status: r.status as BackgroundReportStatus,
    ...(createdAt !== undefined ? { createdAt } : {}),
    hasResult: Object.hasOwn(r, 'result'),
    result: r.result,
    error: typeof r.error === 'string' ? r.error : undefined,
    executionConversationId,
    otherRunningTasks,
    rawText: d.text,
  }
}

function invalidOf(entry: ConversationEntry): BackgroundReportInvalidView {
  const data = entry.data
  const record = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined
  const text = record !== undefined && typeof record['text'] === 'string'
    ? (record['text'] as string)
    : ''
  const createdAt = extractEntryCreatedAt(entry, record)
  return {
    invalid: true,
    ...(createdAt !== undefined ? { createdAt } : {}),
    rawText: text,
  }
}

/** Failed, aborted or malformed reports default to expanded so anomalies are visible at a glance. */
export function isBackgroundReportDefaultOpen(view: BackgroundReportParse): boolean {
  return view.invalid || view.status === 'failed' || view.status === 'aborted'
}

/** Collapsed one-line preview: cleans Markdown and pure heading lines; extracts readable key/value summaries from JSON; errors win on failure. */
export function backgroundReportPreview(
  view: BackgroundReportView,
  maxChars: number,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  if ((view.status === 'failed' || view.status === 'aborted') && view.error !== undefined && view.error.trim() !== '') {
    return extractCleanPreviewLine(view.error, maxChars)
  }
  if (!view.hasResult) return ''
  if (typeof view.result === 'string') {
    return extractCleanPreviewLine(view.result, maxChars)
  }
  return summarizeReadableJson(view.result, maxChars, locale)
}
