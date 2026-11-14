import { diffLines, diffWordsWithSpace } from 'diff'
import {
  EDIT_TOOL_RESULT_SCHEMA,
  TOOL_DIFF_MAX_TEXT_CHARS,
  validateOrThrow,
  type EditToolResult,
  type ToolDiffRow,
} from '@helm/protocol'

export const PENDING_DIFF_MAX_INPUT_CHARS = 65_536
export const PENDING_DIFF_MAX_EDIT_LENGTH = 2_048
export const PENDING_DIFF_MAX_ROWS = 400
export const WORD_DIFF_MAX_LINE_CHARS = 2_048
export const WORD_DIFF_MAX_EDIT_LENGTH = 1_024

export type EditToolResultCheck =
  | { ok: true; value: EditToolResult }
  | { ok: false; reason: string }

/** 与内核复用同一校验器，避免展示层悄悄接受不同的 Schema 语义。 */
export function checkEditToolResult(structuredOutput: unknown): EditToolResultCheck {
  try {
    validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, structuredOutput, 'edit 差异结果无效')
    const value = structuredOutput as EditToolResult
    if (value.diff.rows.reduce((sum, row) => sum + row.text.length, 0) > TOOL_DIFF_MAX_TEXT_CHARS) {
      return { ok: false, reason: '差异文本超过展示预算' }
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export interface WordSegment {
  text: string
  changed: boolean
}

function wordSegmentsFor(oldText: string, newText: string, side: 'remove' | 'add'): WordSegment[] | undefined {
  if (oldText.length > WORD_DIFF_MAX_LINE_CHARS || newText.length > WORD_DIFF_MAX_LINE_CHARS) return undefined
  let indent = 0
  while (indent < oldText.length && oldText[indent] === newText[indent] && /\s/.test(oldText[indent]!)) indent++
  try {
    const changes = diffWordsWithSpace(oldText.slice(indent), newText.slice(indent), {
      maxEditLength: WORD_DIFF_MAX_EDIT_LENGTH,
      timeout: 30,
    })
    if (changes === undefined) return undefined
    const segments: WordSegment[] = indent > 0 ? [{ text: oldText.slice(0, indent), changed: false }] : []
    for (const change of changes) {
      // 只保留本侧文本；把另一侧插入/删除混进来会令高亮后的源码失真。
      if ((side === 'remove' && change.added) || (side === 'add' && change.removed)) continue
      if (change.value !== '') segments.push({ text: change.value, changed: side === 'remove' ? change.removed === true : change.added === true })
    }
    const original = side === 'remove' ? oldText : newText
    return segments.length > 0 && segments.map((segment) => segment.text).join('') === original ? segments : undefined
  } catch {
    return undefined
  }
}

function decorateAdjacentWordPairs<R extends { kind: 'add' | 'remove' | 'context'; text: string }>(
  rows: R[],
  attach: (row: R, segments: WordSegment[] | undefined) => void,
): void {
  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i]!
    const next = rows[i + 1]!
    if (current.kind !== 'remove' || next.kind !== 'add') continue
    if (rows[i - 1]?.kind === 'remove' || rows[i + 2]?.kind === 'add') continue
    attach(current, wordSegmentsFor(current.text, next.text, 'remove'))
    attach(next, wordSegmentsFor(current.text, next.text, 'add'))
  }
}

export interface PendingDiffRow {
  kind: 'add' | 'remove' | 'context'
  text: string
  word?: WordSegment[]
}

export type PendingEditDiff =
  | { kind: 'computed'; rows: PendingDiffRow[]; addedLines: number; removedLines: number; truncated: boolean }
  | { kind: 'skipped'; reason: string }

export function editInputTexts(input: unknown): { oldText?: string; newText?: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  return {
    ...(typeof record.oldText === 'string' ? { oldText: record.oldText } : {}),
    ...(typeof record.newText === 'string' ? { newText: record.newText } : {}),
  }
}

function changeLines(value: string): string[] {
  if (value === '') return []
  const lines = value.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]!.endsWith('\r')) lines[i] = lines[i]!.slice(0, -1)
  }
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 入参只能构成片段对比；真实文件行号来自成功结果。 */
export function buildPendingEditDiff(input: unknown): PendingEditDiff | undefined {
  const { oldText, newText } = editInputTexts(input)
  if (oldText === undefined || newText === undefined) return undefined
  if (oldText.length > PENDING_DIFF_MAX_INPUT_CHARS || newText.length > PENDING_DIFF_MAX_INPUT_CHARS) {
    return { kind: 'skipped', reason: `oldText/newText 超过 ${PENDING_DIFF_MAX_INPUT_CHARS} 字符预算` }
  }
  try {
    const changes = diffLines(oldText, newText, { maxEditLength: PENDING_DIFF_MAX_EDIT_LENGTH, timeout: 100 })
    if (changes === undefined) return { kind: 'skipped', reason: '差异计算超出时间或编辑距离预算' }
    const rows: PendingDiffRow[] = []
    let addedLines = 0
    let removedLines = 0
    let totalRows = 0
    for (const change of changes) {
      const kind = change.added ? 'add' : change.removed ? 'remove' : 'context'
      for (const text of changeLines(change.value)) {
        totalRows++
        if (rows.length < PENDING_DIFF_MAX_ROWS) rows.push({ kind, text })
        if (kind === 'add') addedLines++
        else if (kind === 'remove') removedLines++
      }
    }
    decorateAdjacentWordPairs(rows, (row, segments) => {
      if (segments !== undefined) row.word = segments
    })
    return { kind: 'computed', rows, addedLines, removedLines, truncated: totalRows > rows.length }
  } catch {
    return { kind: 'skipped', reason: '差异计算异常' }
  }
}

export type AppliedDiffRowView = ToolDiffRow & { word?: WordSegment[] }

export function decorateAppliedDiffRows(rows: ReadonlyArray<ToolDiffRow>): AppliedDiffRowView[] {
  const view: AppliedDiffRowView[] = rows.map((row) => ({ ...row }))
  decorateAdjacentWordPairs(view, (row, segments) => {
    if (segments !== undefined) row.word = segments
  })
  return view
}
