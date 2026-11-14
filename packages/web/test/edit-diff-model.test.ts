/**
 * edit 差异展示纯函数测试：
 * 1. checkEditToolResult：EDIT_TOOL_RESULT_SCHEMA 驱动校验（合法 / 缺字段 /
 *    非法行号 / 多余字段 / 非 const / 类型不符）；
 * 2. buildPendingEditDiff：待执行片段差异（替换/纯增/纯删）、缺失入参、
 *    超输入预算、超编辑距离预算（大输入防 O(n*m) 卡死）、行数截断；
 * 3. 词级标注：单删单增行对、多行块不加词、超长行不加词；
 * 4. decorateAppliedDiffRows：装饰不改动内核行数据、返回新数组。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPendingEditDiff,
  checkEditToolResult,
  decorateAppliedDiffRows,
  editInputTexts,
  PENDING_DIFF_MAX_INPUT_CHARS,
  PENDING_DIFF_MAX_EDIT_LENGTH,
  PENDING_DIFF_MAX_ROWS,
} from '../src/conversation/edit-diff-model.js'
import type { ToolDiffRow } from '@helm/protocol'

function validEditResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: '/abs/x.ts',
    nodeId: 'local',
    replaced: true,
    diff: {
      rows: [
        { kind: 'context', oldLine: 9, newLine: 9, text: 'const a = 1' },
        { kind: 'remove', oldLine: 10, text: 'const b = 2' },
        { kind: 'add', newLine: 10, text: 'const b = 3' },
      ],
      addedLines: 1,
      removedLines: 1,
      firstChangedLine: 10,
      truncated: false,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// checkEditToolResult
// ---------------------------------------------------------------------------

test('checkEditToolResult：合法内核元数据通过并透传值', { timeout: 60_000 }, () => {
  const check = checkEditToolResult(validEditResult())
  assert.equal(check.ok, true)
  if (!check.ok) return
  assert.equal(check.value.path, '/abs/x.ts')
  assert.equal(check.value.diff.addedLines, 1)
  assert.equal(check.value.diff.rows.length, 3)
})

test('checkEditToolResult：undefined / 非对象 / 缺 diff / replaced 非 true 均拒绝', { timeout: 60_000 }, () => {
  assert.equal(checkEditToolResult(undefined).ok, false)
  assert.equal(checkEditToolResult('edit_ok').ok, false)
  assert.equal(checkEditToolResult(null).ok, false)
  const missingDiff = checkEditToolResult({ path: '/a', nodeId: 'local', replaced: true })
  assert.equal(missingDiff.ok, false)
  if (missingDiff.ok) return
  assert.match(missingDiff.reason, /diff/)
  const notReplaced = checkEditToolResult(validEditResult({ replaced: false }))
  assert.equal(notReplaced.ok, false)
  if (notReplaced.ok) return
  assert.match(notReplaced.reason, /replaced/)
})

test('checkEditToolResult：行号 0 / 负数 / 非整数与 rows 形状非法拒绝（不伪造行号）', { timeout: 60_000 }, () => {
  const badLine = validEditResult()
  ;(badLine.diff as { rows: unknown[] }).rows = [{ kind: 'remove', oldLine: 0, text: 'x' }]
  const checkLine = checkEditToolResult(badLine)
  assert.equal(checkLine.ok, false)
  if (checkLine.ok) return
  assert.match(checkLine.reason, /rows(?:\[0\]|\/0)/)

  const badShape = validEditResult()
  ;(badShape.diff as { rows: unknown[] }).rows = [{ kind: 'context', oldLine: 3, text: '缺 newLine' }]
  assert.equal(checkEditToolResult(badShape).ok, false)

  const floatLine = validEditResult()
  ;(floatLine.diff as { rows: unknown[] }).rows = [{ kind: 'add', newLine: 2.5, text: 'x' }]
  assert.equal(checkEditToolResult(floatLine).ok, false)
})

test('checkEditToolResult：additionalProperties:false 拒绝未声明字段', { timeout: 60_000 }, () => {
  const extra = validEditResult({ extra: 'nope' })
  const check = checkEditToolResult(extra)
  assert.equal(check.ok, false)
  if (check.ok) return
  assert.match(check.reason, /additional properties/)

  const extraInDiff = validEditResult()
  ;(extraInDiff.diff as Record<string, unknown>).note = 'x'
  const checkDiff = checkEditToolResult(extraInDiff)
  assert.equal(checkDiff.ok, false)
  if (checkDiff.ok) return
  assert.match(checkDiff.reason, /additional properties/)
})

// ---------------------------------------------------------------------------
// buildPendingEditDiff
// ---------------------------------------------------------------------------

test('buildPendingEditDiff：单行替换产生 remove+add+context，行数据无文件行号', { timeout: 60_000 }, () => {
  const pending = buildPendingEditDiff({
    path: '/a.ts',
    oldText: 'const a = 1\nconst b = 2\nconst c = 3',
    newText: 'const a = 1\nconst b = 9\nconst c = 3',
  })
  assert.ok(pending !== undefined && pending.kind === 'computed')
  if (pending.kind !== 'computed') return
  assert.equal(pending.addedLines, 1)
  assert.equal(pending.removedLines, 1)
  assert.equal(pending.truncated, false)
  const kinds = pending.rows.map((r) => r.kind).join(',')
  assert.match(kinds, /remove/)
  assert.match(kinds, /add/)
  assert.match(kinds, /context/)
  // 待执行片段绝不携带文件行号
  for (const row of pending.rows) {
    assert.equal('oldLine' in row, false)
    assert.equal('newLine' in row, false)
  }
  const remove = pending.rows.find((r) => r.kind === 'remove')
  const add = pending.rows.find((r) => r.kind === 'add')
  assert.equal(remove?.text, 'const b = 2')
  assert.equal(add?.text, 'const b = 9')
  // 单删单增行对带词级标注：变化词 '2' / '9' 加深
  assert.ok(remove?.word?.some((s) => s.changed && s.text.includes('2')), 'remove 行词级标注含变化词')
  assert.ok(add?.word?.some((s) => s.changed && s.text.includes('9')), 'add 行词级标注含变化词')
  assert.equal(remove?.word?.map((segment) => segment.text).join(''), remove?.text, '删除行高亮后仍是原文')
  assert.equal(add?.word?.map((segment) => segment.text).join(''), add?.text, '新增行高亮后仍是原文')
})

test('buildPendingEditDiff：纯新增 / 纯删除计数正确', { timeout: 60_000 }, () => {
  const addOnly = buildPendingEditDiff({ oldText: 'a\n', newText: 'a\nb\nc\n' })
  assert.ok(addOnly !== undefined && addOnly.kind === 'computed')
  if (addOnly.kind === 'computed') {
    assert.equal(addOnly.addedLines, 2)
    assert.equal(addOnly.removedLines, 0)
  }
  const removeOnly = buildPendingEditDiff({ oldText: 'a\nb\nc\n', newText: 'a\n' })
  assert.ok(removeOnly !== undefined && removeOnly.kind === 'computed')
  if (removeOnly.kind === 'computed') {
    assert.equal(removeOnly.addedLines, 0)
    assert.equal(removeOnly.removedLines, 2)
  }
})

test('buildPendingEditDiff：缺失 oldText/newText 返回 undefined（不编造片段）', { timeout: 60_000 }, () => {
  assert.equal(buildPendingEditDiff(undefined), undefined)
  assert.equal(buildPendingEditDiff({ path: '/a' }), undefined)
  assert.equal(buildPendingEditDiff({ oldText: 'x' }), undefined)
  assert.equal(editInputTexts({ oldText: 1, newText: 'y' }).newText, 'y')
  assert.equal(editInputTexts({ oldText: 1, newText: 'y' }).oldText, undefined)
})

test('buildPendingEditDiff：输入超字符预算显式 skipped，不硬算', { timeout: 60_000 }, () => {
  const big = 'x'.repeat(PENDING_DIFF_MAX_INPUT_CHARS + 1)
  const pending = buildPendingEditDiff({ oldText: big, newText: 'y' })
  assert.ok(pending !== undefined && pending.kind === 'skipped')
  if (pending.kind === 'skipped') assert.match(pending.reason, /预算/)
})

test('buildPendingEditDiff：变更行数超编辑距离预算显式 skipped（大输入防卡死）', { timeout: 60_000 }, () => {
  const oldText = Array.from({ length: PENDING_DIFF_MAX_EDIT_LENGTH + 500 }, (_, i) => `old-${i}`).join('\n')
  const newText = Array.from({ length: PENDING_DIFF_MAX_EDIT_LENGTH + 500 }, (_, i) => `new-${i}`).join('\n')
  const pending = buildPendingEditDiff({ oldText, newText })
  assert.ok(pending !== undefined && pending.kind === 'skipped')
  if (pending.kind === 'skipped') assert.match(pending.reason, /预算/)
})

test('buildPendingEditDiff：行数超上限截断且统计覆盖全部变更行', { timeout: 60_000 }, () => {
  const half = PENDING_DIFF_MAX_ROWS / 2 + 50 // remove+add 行数和 > 上限，编辑距离仍在预算内
  const oldText = Array.from({ length: half }, (_, i) => `old-${i}`).join('\n')
  const newText = Array.from({ length: half }, (_, i) => `new-${i}`).join('\n')
  const pending = buildPendingEditDiff({ oldText, newText })
  assert.ok(pending !== undefined && pending.kind === 'computed')
  if (pending.kind !== 'computed') return
  assert.equal(pending.truncated, true)
  assert.equal(pending.rows.length, PENDING_DIFF_MAX_ROWS)
  assert.equal(pending.addedLines, half)
  assert.equal(pending.removedLines, half)
})

test('buildPendingEditDiff：多行替换块不做词级标注（非单删单增）', { timeout: 60_000 }, () => {
  const pending = buildPendingEditDiff({
    oldText: 'a\nb\nc\nd',
    newText: 'a\nx\ny\nd',
  })
  assert.ok(pending !== undefined && pending.kind === 'computed')
  if (pending.kind !== 'computed') return
  for (const row of pending.rows) {
    if (row.kind === 'remove' || row.kind === 'add') assert.equal(row.word, undefined)
  }
})

test('buildPendingEditDiff：超长行不做词级标注（防词级 O(n*m)）', { timeout: 60_000 }, () => {
  const long = `${'x'.repeat(2049)}-old`
  const pending = buildPendingEditDiff({ oldText: long, newText: `${'x'.repeat(2049)}-new` })
  assert.ok(pending !== undefined && pending.kind === 'computed')
  if (pending.kind !== 'computed') return
  for (const row of pending.rows) {
    if (row.kind === 'remove' || row.kind === 'add') assert.equal(row.word, undefined)
  }
})

// ---------------------------------------------------------------------------
// decorateAppliedDiffRows
// ---------------------------------------------------------------------------

test('decorateAppliedDiffRows：单删单增行对加词级标注，不改内核行数据', { timeout: 60_000 }, () => {
  const rows: ToolDiffRow[] = [
    { kind: 'context', oldLine: 1, newLine: 1, text: 'l1' },
    { kind: 'remove', oldLine: 2, text: 'value = 1' },
    { kind: 'add', newLine: 2, text: 'value = 2' },
    { kind: 'context', oldLine: 3, newLine: 3, text: 'l3' },
  ]
  const view = decorateAppliedDiffRows(rows)
  const remove = view.find((r) => r.kind === 'remove')
  const add = view.find((r) => r.kind === 'add')
  assert.ok(remove?.word?.some((s) => s.changed), 'remove 行获得词级标注')
  assert.ok(add?.word?.some((s) => s.changed), 'add 行获得词级标注')
  // 原数组不被修改（内核数据只读）
  assert.equal('word' in rows[1]!, false)
  assert.equal(view.length, rows.length)
})

test('decorateAppliedDiffRows：隔行 remove/add（非紧邻对）不加词级标注', { timeout: 60_000 }, () => {
  const rows: ToolDiffRow[] = [
    { kind: 'remove', oldLine: 2, text: 'a' },
    { kind: 'context', oldLine: 3, newLine: 2, text: 'mid' },
    { kind: 'add', newLine: 3, text: 'b' },
  ]
  const view = decorateAppliedDiffRows(rows)
  for (const row of view) assert.equal(row.word, undefined)
})
