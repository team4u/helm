import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPendingEditDiff, checkEditToolResult, decorateAppliedDiffRows } from '../src/conversation/edit-diff-model.js'

test('词级高亮逐字保留各侧源码，包含缩进、空白与中文', { timeout: 60_000 }, () => {
  const pairs = [
    ['  const value = 1', '  const value = 42'],
    ['\treturn oldName  ', '\treturn newName '],
    ['a + b', 'a  +  b'],
    ['中文 说明', '中文 改动说明'],
    ['prefix suffix', 'prefix inserted suffix'],
  ]
  for (const [before, after] of pairs) {
    const rows = decorateAppliedDiffRows([
      { kind: 'remove', oldLine: 1, text: before! },
      { kind: 'add', newLine: 1, text: after! },
    ])
    assert.equal(rows[0]!.word?.map((part) => part.text).join('') ?? rows[0]!.text, before)
    assert.equal(rows[1]!.word?.map((part) => part.text).join('') ?? rows[1]!.text, after)
  }
})

test('片段对比保留末尾换行变更，不把真实修改归为上下文', { timeout: 60_000 }, () => {
  for (const [oldText, newText] of [['a', 'a\n'], ['a\n', 'a']]) {
    const result = buildPendingEditDiff({ oldText, newText })
    assert.ok(result?.kind === 'computed')
    assert.equal(result.addedLines, 1)
    assert.equal(result.removedLines, 1)
  }
})

test('共享 Schema 校验后仍拒绝超过总文本预算的差异', { timeout: 60_000 }, () => {
  const result = checkEditToolResult({
    path: '/a.ts', nodeId: 'local', replaced: true,
    diff: {
      rows: Array.from({ length: 10 }, (_, i) => ({ kind: 'add', newLine: i + 1, text: 'x'.repeat(4096) })),
      addedLines: 10, removedLines: 0, firstChangedLine: 1, truncated: false,
    },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /预算/)
})
