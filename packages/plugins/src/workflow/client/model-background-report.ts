/**
 * builtin:workflow 后台结算汇报（helm.input + meta.renderer 精确接管）纯解析层。
 *
 * 既有正文契约：单行引导语 + '\n' + report JSON（deliverBackgroundReport 生成）。
 * 本模块按首个换行分离并严格校验实际读取展示/导航的字段（runId 与 meta 一致、
 * 合法终态、execution 正整数会话 ID 等）；result 是业务值——null/false/0/空串
 * 均合法，只按键存在性判别，绝不用 truthy 丢弃。数据损坏时返回 invalid 视图
 * （显式“格式异常”+ 保留原文供展开复制），不伪造成功。
 */

import type { ConversationEntry } from '@helm/protocol'
import { extractCleanPreviewLine, summarizeReadableJson } from './model-format.ts'

/** 汇报种类（meta.kind；决定卡片标题）。 */
export type BackgroundReportKind = 'subagent_report' | 'workflow_report'

/** 终态（deliverBackgroundReport 仅在 run 终态后投递；running 不属汇报）。 */
export type BackgroundReportStatus = 'completed' | 'failed' | 'aborted'

/** 投递时其余在途运行快照（仅展示，不驱动任何逻辑）。 */
export interface BackgroundReportOtherTask {
  runId: string
  name: string
  kind: string
}

/** 有效汇报视图：entry 自身不变快照，不订阅 runsDoc。 */
export interface BackgroundReportView {
  invalid: false
  kind: BackgroundReportKind
  runId: string
  status: BackgroundReportStatus
  /** 投递时间戳（epoch ms，来自 entry.createdAt 或 data.createdAt）。 */
  createdAt?: number
  /** report 是否携带 result 键（值可为任何 JSON 值，含 null/false/0/''）。 */
  hasResult: boolean
  result: unknown
  /** 失败/中止时的错误摘要原文（可能为空串）。 */
  error: string | undefined
  /** execution.conversationId（正整数才给导航入口；无 execution 或非法时 undefined）。 */
  executionConversationId: number | undefined
  otherRunningTasks: BackgroundReportOtherTask[]
  /** 完整正文原文（复制用，不重复进 meta）。 */
  rawText: string
}

/** 损坏汇报视图：仍允许展开查看与复制原文。 */
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
 * 解析汇报 entry。校验失败（形状/JSON/runId 不一致/非法终态等）返回 invalid，
 * 调用方不得把 invalid 当成功渲染。
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

  // 正文契约：首行引导语 + 换行 + JSON。无换行即不符合契约。
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
  if (r.error !== undefined && typeof r.error !== 'string') return invalidOf(entry)

  // execution：仅消费导航所需 conversationId（正整数）；其余字段原样保留在原文。
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

  // otherRunningTasks：投递时快照，逐项严格校验展示字段。
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

/** 失败、中止或格式异常汇报默认自动展开，确保异常一眼可见。 */
export function isBackgroundReportDefaultOpen(view: BackgroundReportParse): boolean {
  return view.invalid || view.status === 'failed' || view.status === 'aborted'
}

/** 折叠态单行预览：清洗 Markdown 与纯标题行；JSON 提取可读键值摘要；失败优先错误。 */
export function backgroundReportPreview(view: BackgroundReportView, maxChars: number): string {
  if ((view.status === 'failed' || view.status === 'aborted') && view.error !== undefined && view.error.trim() !== '') {
    return extractCleanPreviewLine(view.error, maxChars)
  }
  if (!view.hasResult) return ''
  if (typeof view.result === 'string') {
    return extractCleanPreviewLine(view.result, maxChars)
  }
  return summarizeReadableJson(view.result, maxChars)
}
