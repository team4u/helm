/**
 * Pure parsing layer for builtin:workflow background settlement reports
 * (precise takeover of helm.input via meta.renderer).
 *
 * Reads the structured `entry.data.meta.report` payload injected by
 * `background.ts` directly (zero prefix-string / newline scraping) and strictly
 * validates every field consumed for display/navigation (`runId` consistent
 * with `meta.backgroundRunId`, legal terminal status, positive-integer
 * execution conversationId, `otherRunningTasks` array). Corrupted payloads
 * return an explicit invalid view with `rawText` preserved for copy/inspect.
 */
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import type { ConversationEntry } from '@helm/protocol'
import { extractCleanPreviewLine, summarizeReadableJson } from './model-format.ts'

export type BackgroundReportKind = 'subagent_report' | 'workflow_report'

export type BackgroundReportStatus = 'completed' | 'failed' | 'aborted'

export interface BackgroundReportOtherTask {
  runId: string
  name: string
  kind: string
}

export interface BackgroundReportView {
  invalid: false
  kind: BackgroundReportKind
  runId: string
  status: BackgroundReportStatus
  createdAt?: number
  hasResult: boolean
  result: unknown
  error: string | undefined
  executionConversationId: number | undefined
  otherRunningTasks: BackgroundReportOtherTask[]
  rawText: string
}

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

  const report = m.report
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return invalidOf(entry)
  const r = report as Record<string, unknown>

  if (typeof r.runId !== 'string' || r.runId !== backgroundRunId) return invalidOf(entry)
  if (typeof r.status !== 'string' || !TERMINAL_STATUSES.has(r.status)) return invalidOf(entry)
  if (r.error !== undefined && typeof r.error !== 'string') return invalidOf(entry)

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

export function isBackgroundReportDefaultOpen(view: BackgroundReportParse): boolean {
  return view.invalid || view.status === 'failed' || view.status === 'aborted'
}

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
