import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EDIT_TOOL_RESULT_SCHEMA,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_ROW_CHARS,
  validateOrThrow,
  type EditToolResult,
} from '../src/index.js'

function result(): EditToolResult {
  return {
    path: '/workspace/example.ts',
    nodeId: 'remote-a',
    replaced: true,
    diff: {
      rows: [
        { kind: 'context', oldLine: 7, newLine: 7, text: 'function run() {' },
        { kind: 'remove', oldLine: 8, text: '  return 1' },
        { kind: 'add', newLine: 8, text: '  return 2' },
      ],
      addedLines: 1,
      removedLines: 1,
      firstChangedLine: 8,
      truncated: false,
    },
  }
}

function validate(value: unknown): void {
  validateOrThrow(EDIT_TOOL_RESULT_SCHEMA, value, 'edit 差异结果无效')
}

test('edit 展示契约接受真实行号、截断差异与无操作结果', { timeout: 60_000 }, () => {
  validate(result())
  const truncated = result()
  truncated.diff.rows = []
  truncated.diff.truncated = true
  validate(truncated)
  const unchanged = result()
  unchanged.diff.rows = []
  unchanged.diff.addedLines = 0
  unchanged.diff.removedLines = 0
  validate(unchanged)
})

test('edit 展示边界拒绝缺失字段、错误行形状与不可表示的行号', { timeout: 60_000 }, () => {
  const invalid: unknown[] = [
    { path: '/workspace/example.ts', nodeId: 'local', replaced: true },
    { ...result(), replaced: false },
    { ...result(), nodeId: '' },
    ...[
      { kind: 'context', oldLine: 1, text: 'missing newLine' },
      { kind: 'remove', oldLine: 1, newLine: 1, text: 'unexpected newLine' },
      { kind: 'add', newLine: 0, text: 'zero line' },
      { kind: 'add', newLine: 1.5, text: 'fractional line' },
      { kind: 'add', newLine: Number.MAX_SAFE_INTEGER + 1, text: 'unsafe line' },
      { kind: 'unknown', oldLine: 1, text: 'unknown row' },
    ].map((row) => ({ ...result(), diff: { ...result().diff, rows: [row] } })),
    { ...result(), diff: { ...result().diff, addedLines: -1 } },
  ]
  for (const value of invalid) assert.throws(() => validate(value), /edit 差异结果无效/)
})

test('edit 展示边界拒绝超量行与超长行文本', { timeout: 60_000 }, () => {
  const row = { kind: 'add', newLine: 1, text: 'line' }
  assert.throws(
    () => validate({ ...result(), diff: { ...result().diff, rows: Array.from({ length: TOOL_DIFF_MAX_ROWS + 1 }, () => row) } }),
    /edit 差异结果无效/,
  )
  assert.throws(
    () => validate({ ...result(), diff: { ...result().diff, rows: [{ ...row, text: 'x'.repeat(TOOL_DIFF_MAX_ROW_CHARS + 1) }] } }),
    /edit 差异结果无效/,
  )
})
