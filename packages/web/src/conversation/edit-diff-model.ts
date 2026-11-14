/**
 * edit 工具差异展示纯函数层（纯 .ts，零 React/DOM 依赖，单测直测）。
 *
 * 职责：
 * - 以 @helm/protocol 导出的 EDIT_TOOL_RESULT_SCHEMA 为唯一真源校验内核
 *   structuredOutput（迷你 Schema 求值器读 Schema 对象本身，不复制契约）；
 * - 运行中/失败时按 input.oldText/newText 用 diffLines 计算片段差异（无文件
 *   行号，绝不伪造历史文件上下文；失败态不判定文件是否已变）；
 * - 单删单增相邻行对用 diffWords 做词级加深标注；
 * - 所有差异计算设预算（maxEditLength / 输入长度 / 行数上限），超限显式
 *   返回 skipped 状态由 UI 提示，绝不阻塞主线程硬算 O(n*m)。
 */

import { diffLines, diffWords } from 'diff'
import { EDIT_TOOL_RESULT_SCHEMA, type EditToolResult, type ToolDiffRow } from '@helm/protocol'

// ---------------------------------------------------------------------------
// 预算常量
// ---------------------------------------------------------------------------

/** 待执行片段单侧文本上限（字符）；超过直接跳过差异计算。 */
export const PENDING_DIFF_MAX_INPUT_CHARS = 65_536
/** diffLines 编辑距离（变更行数）预算；超过返回 undefined（jsdiff maxEditLength）。 */
export const PENDING_DIFF_MAX_EDIT_LENGTH = 2_048
/** 待执行片段差异行数上限；超出部分丢弃并以 truncated 标注（统计仍覆盖全部）。 */
export const PENDING_DIFF_MAX_ROWS = 400
/** 词级差异单行长度上限（字符）；超过不做词级标注（整行淡底）。 */
export const WORD_DIFF_MAX_LINE_CHARS = 2_048
/** diffWords 编辑距离（词数）预算。 */
export const WORD_DIFF_MAX_EDIT_LENGTH = 1_024

// ---------------------------------------------------------------------------
// Schema 求值器（支持 EDIT_TOOL_RESULT_SCHEMA 用到的关键字子集）
// ---------------------------------------------------------------------------

interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean
  const?: unknown
  items?: SchemaNode
  oneOf?: SchemaNode[]
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return false
  }
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 单节点求值；通过返回 undefined，否则返回带路径的失败原因。 */
function validateAt(value: unknown, schema: SchemaNode, path: string): string | undefined {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => typeMatches(value, t))) {
      return `${path} 应为 ${types.join('|')}，实际 ${typeLabel(value)}`
    }
  }
  if ('const' in schema && value !== schema.const) {
    return `${path} 应为常量 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} 长度 ${value.length} 低于最小 ${schema.minLength}`
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${path} 长度 ${value.length} 超过最大 ${schema.maxLength}`
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path}=${value} 低于最小 ${schema.minimum}`
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${path}=${value} 超过最大 ${schema.maximum}`
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} 含 ${value.length} 项，超过最大 ${schema.maxItems}`
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const err = validateAt(value[i], schema.items, `${path}[${i}]`)
        if (err !== undefined) return err
      }
    }
  }
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((branch) => validateAt(value, branch, path) === undefined)
    if (matched.length !== 1) {
      return `${path} 不符合 oneOf 任一分支（命中 ${matched.length} 个）`
    }
    return undefined
  }
  if (typeMatches(value, 'object')) {
    const record = value as Record<string, unknown>
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!(key in record)) return `${path} 缺少必填字段 ${key}`
      }
    }
    if (schema.properties !== undefined) {
      for (const key of Object.keys(schema.properties)) {
        if (key in record) {
          const err = validateAt(record[key], schema.properties[key]!, `${path}.${key}`)
          if (err !== undefined) return err
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) return `${path} 含未声明字段 ${key}`
      }
    }
  }
  return undefined
}

export type EditToolResultCheck =
  | { ok: true; value: EditToolResult }
  | { ok: false; reason: string }

/**
 * 校验 edit 的 structuredOutput 是否为内核真实差异元数据。
 * 缺失 / 非法一律 ok:false（UI 显式诊断并保留原始输出，绝不降级伪造）。
 */
export function checkEditToolResult(structuredOutput: unknown): EditToolResultCheck {
  const err = validateAt(structuredOutput, EDIT_TOOL_RESULT_SCHEMA as SchemaNode, 'edit 结果')
  if (err !== undefined) return { ok: false, reason: err }
  return { ok: true, value: structuredOutput as EditToolResult }
}

// ---------------------------------------------------------------------------
// 词级差异标注
// ---------------------------------------------------------------------------

export interface WordSegment {
  text: string
  /** true = 本行里发生变化的词（加深底色）。 */
  changed: boolean
}

/** 单删单增行对的词级标注；不可计算（超预算/超长）返回 undefined（整行淡底）。 */
function wordSegmentsFor(oldText: string, newText: string, side: 'remove' | 'add'): WordSegment[] | undefined {
  if (oldText.length > WORD_DIFF_MAX_LINE_CHARS || newText.length > WORD_DIFF_MAX_LINE_CHARS) {
    return undefined
  }
  let changes: ReturnType<typeof diffWords> | undefined
  try {
    changes = diffWords(oldText, newText, { maxEditLength: WORD_DIFF_MAX_EDIT_LENGTH })
  } catch {
    return undefined
  }
  if (changes === undefined) return undefined
  const segments: WordSegment[] = []
  for (const change of changes) {
    if (change.value === '') continue
    const changed = side === 'remove' ? change.removed === true : change.added === true
    segments.push({ text: change.value, changed })
  }
  return segments.length > 0 ? segments : undefined
}

/** 在行数组上标注「恰好一行 remove 紧邻一行 add」的词级变化。 */
function decorateAdjacentWordPairs<
  R extends { kind: 'add' | 'remove' | 'context'; text: string },
>(rows: R[], attach: (row: R, segments: WordSegment[] | undefined, side: 'remove' | 'add') => void): void {
  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i]!
    const next = rows[i + 1]!
    if (current.kind !== 'remove' || next.kind !== 'add') continue
    const prev = i > 0 ? rows[i - 1] : undefined
    const after = rows[i + 2]
    // 单删单增：remove 前不再是 remove、add 后不再是 add（多为多行块，词级意义有限）
    if (prev?.kind === 'remove' || after?.kind === 'add') continue
    attach(current, wordSegmentsFor(current.text, next.text, 'remove'), 'remove')
    attach(next, wordSegmentsFor(current.text, next.text, 'add'), 'add')
  }
}

// ---------------------------------------------------------------------------
// 待执行的变更片段（运行中 / 失败时按入参计算，无文件行号）
// ---------------------------------------------------------------------------

export interface PendingDiffRow {
  kind: 'add' | 'remove' | 'context'
  text: string
  /** 词级加深标注（仅单删单增行对；不可计算时省略）。 */
  word?: WordSegment[]
}

export type PendingEditDiff =
  | {
      kind: 'computed'
      rows: PendingDiffRow[]
      addedLines: number
      removedLines: number
      /** 行数预算截断：rows 不完整，added/removed 统计仍覆盖全部。 */
      truncated: boolean
    }
  | { kind: 'skipped'; reason: string }

/** 提取 edit 入参（现契约：oldText/newText 各一处精确替换，无兼容旧 schema）。 */
export function editInputTexts(input: unknown): { oldText?: string; newText?: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  return {
    ...(typeof record.oldText === 'string' ? { oldText: record.oldText } : {}),
    ...(typeof record.newText === 'string' ? { newText: record.newText } : {}),
  }
}

/** 把 diff 变更块（值可能含多行、以 \n 结尾）展开为行。 */
function changeLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 行 token 归一：补齐尾部换行使「同一行」不受原文末行是否有 \n 影响；空串保持空。 */
function normalizeLineText(text: string): string {
  if (text === '' || text.endsWith('\n')) return text
  return `${text}\n`
}

/**
 * 计算「待执行的变更片段」差异：
 * - oldText/newText 缺失 → undefined（调用方只展示原始入参，不编造片段）；
 * - 输入超长或 diffLines 超编辑距离预算 → skipped（UI 明确提示，保留原始参数入口）；
 * - 行数超上限 → truncated 截断（统计字段仍覆盖全部变更行）。
 */
export function buildPendingEditDiff(input: unknown): PendingEditDiff | undefined {
  const { oldText, newText } = editInputTexts(input)
  if (oldText === undefined || newText === undefined) return undefined
  if (oldText.length > PENDING_DIFF_MAX_INPUT_CHARS || newText.length > PENDING_DIFF_MAX_INPUT_CHARS) {
    return { kind: 'skipped', reason: `oldText/newText 超过 ${PENDING_DIFF_MAX_INPUT_CHARS} 字符预算` }
  }
  let changes: ReturnType<typeof diffLines> | undefined
  try {
    changes = diffLines(normalizeLineText(oldText), normalizeLineText(newText), {
      maxEditLength: PENDING_DIFF_MAX_EDIT_LENGTH,
    })
  } catch {
    return { kind: 'skipped', reason: '差异计算异常' }
  }
  if (changes === undefined) {
    return { kind: 'skipped', reason: `变更行数超过 ${PENDING_DIFF_MAX_EDIT_LENGTH} 行预算` }
  }
  const rows: PendingDiffRow[] = []
  let addedLines = 0
  let removedLines = 0
  for (const change of changes) {
    const kind = change.added ? 'add' : change.removed ? 'remove' : 'context'
    for (const line of changeLines(change.value)) {
      rows.push({ kind, text: line })
      if (kind === 'add') addedLines++
      else if (kind === 'remove') removedLines++
    }
  }
  decorateAdjacentWordPairs(rows, (row, segments) => {
    if (segments !== undefined) row.word = segments
  })
  if (rows.length > PENDING_DIFF_MAX_ROWS) {
    return {
      kind: 'computed',
      rows: rows.slice(0, PENDING_DIFF_MAX_ROWS),
      addedLines,
      removedLines,
      truncated: true,
    }
  }
  return { kind: 'computed', rows, addedLines, removedLines, truncated: false }
}

// ---------------------------------------------------------------------------
// 已应用差异（内核 structuredOutput，行号真实）
// ---------------------------------------------------------------------------

export type AppliedDiffRowView = ToolDiffRow & { word?: WordSegment[] }

/** 装饰内核差异行的词级变化；返回新数组（不改内核数据）。 */
export function decorateAppliedDiffRows(rows: ReadonlyArray<ToolDiffRow>): AppliedDiffRowView[] {
  const view: AppliedDiffRowView[] = rows.map((row) => ({ ...row }))
  decorateAdjacentWordPairs(view, (row, segments) => {
    if (segments !== undefined) row.word = segments
  })
  return view
}
