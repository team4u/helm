import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeEditDiff } from '../src/runtime/tool-edit-diff.js'

test('稀疏变更只保留各变更周围的上下文，行数预算不吞掉后续变更', { timeout: 60_000 }, () => {
  const original = Array.from({ length: 400 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
  const updated = original.replace('line-20\n', 'changed-20\n').replace('line-380\n', 'changed-380\n')
  const diff = computeEditDiff(original, updated, 0, original.length, (text) => text)
  assert.equal(diff.truncated, false)
  assert.equal(diff.addedLines, 2)
  assert.equal(diff.removedLines, 2)
  assert.equal(diff.firstChangedLine, 20)
  assert.equal(diff.rows.length, 16)
  assert.ok(diff.rows.some((row) => row.kind === 'add' && row.newLine === 20 && row.text === 'changed-20'))
  assert.ok(diff.rows.some((row) => row.kind === 'add' && row.newLine === 380 && row.text === 'changed-380'))
  const contexts = diff.rows.filter((row) => row.kind === 'context')
  assert.deepEqual(contexts.map((row) => row.oldLine), [17, 18, 19, 21, 22, 23, 377, 378, 379, 381, 382, 383])
})
