/**
 * 上下文用量纯展示模型（context-usage-model）单测：
 * - 窗口未知时只显示估算量，绝不显示伪百分比；
 * - 色调：压缩中 > 超阻塞 > 超后台 > 正常；
 * - 浮层行：实测/估算拆分、阈值、压缩失败 danger 行。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextPercent, contextTone, contextUsageView, formatTokens } from '../src/conversation/context-usage-model.js'

test('formatTokens：<1k 原值；k/M 一位小数（>=100k 取整）', { timeout: 60_000 }, () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_234), '1.2k')
  assert.equal(formatTokens(99_999), '100.0k')
  assert.equal(formatTokens(123_456), '123k')
  assert.equal(formatTokens(1_500_000), '1.5M')
  assert.equal(formatTokens(Number.NaN), '--')
})

test('contextPercent：窗口未知/非法不显示百分比（undefined，不伪造）', { timeout: 60_000 }, () => {
  assert.equal(contextPercent({ tokens: 1_000 }), undefined)
  assert.equal(contextPercent({ tokens: 1_000, contextWindow: 0 }), undefined)
  assert.equal(contextPercent({ tokens: 50_000, contextWindow: 100_000 }), 50)
  assert.equal(contextPercent({ tokens: 101_000, contextWindow: 100_000 }), 101)
})

test('contextTone：压缩中优先；超阻塞 high；超后台 warn；其余 ok', { timeout: 60_000 }, () => {
  const thresholds = { blockingTokens: 90_000, backgroundTokens: 60_000 }
  assert.equal(contextTone({ tokens: 10_000, thresholds }), 'ok')
  assert.equal(contextTone({ tokens: 61_000, thresholds }), 'warn')
  assert.equal(contextTone({ tokens: 91_000, thresholds }), 'high')
  assert.equal(
    contextTone({ tokens: 10_000, thresholds, compacting: { trigger: 'manual', blocking: false } }),
    'compacting',
  )
  // 无阈值（窗口未知）：中性 ok，不伪报警告。
  assert.equal(contextTone({ tokens: 999_999 }), 'ok')
})

test('contextUsageView：窗口已知显示百分比；未知只显示估算量', { timeout: 60_000 }, () => {
  const withWindow = contextUsageView({
    tokens: 25_000,
    contextWindow: 100_000,
    measuredTokens: 20_000,
    thresholds: { blockingTokens: 90_000, backgroundTokens: 60_000 },
  })
  assert.equal(withWindow.pillLabel, '25%')
  assert.equal(withWindow.tone, 'ok')
  const rows = Object.fromEntries(withWindow.rows.map((r) => [r.key, r.value]))
  assert.match(rows['上下文估算']!, /25\.0k tokens/)
  assert.match(rows['计量方式']!, /实测 20\.0k · 估算 5\.0k/)
  assert.match(rows['上下文窗口']!, /100k tokens/)
  assert.match(rows['阻塞压缩阈值']!, /90\.0k tokens/)
  assert.match(rows['后台压缩阈值']!, /60\.0k tokens/)

  const noWindow = contextUsageView({ tokens: 12_345 })
  assert.equal(noWindow.pillLabel, '12.3k')
  assert.ok(!noWindow.pillLabel.includes('%'), '窗口未知不得显示伪百分比')
  const rows2 = Object.fromEntries(noWindow.rows.map((r) => [r.key, r.value]))
  assert.match(rows2['上下文窗口']!, /未知/)
  assert.match(rows2['计量方式']!, /全部估算/)
  assert.equal(rows2['阻塞压缩阈值'], undefined, '无窗口时无阈值行')
})

test('contextUsageView：压缩中与失败行（danger）如实呈现', { timeout: 60_000 }, () => {
  const view = contextUsageView({
    tokens: 91_000,
    contextWindow: 100_000,
    thresholds: { blockingTokens: 90_000 },
    compacting: { trigger: 'threshold', blocking: true },
    compactionError: 'provider_error: 上游 429',
  })
  assert.equal(view.tone, 'compacting')
  const compactingRow = view.rows.find((r) => r.key === '压缩进行中')
  assert.equal(compactingRow?.value, '阈值触发 · 阻塞生成')
  const errorRow = view.rows.find((r) => r.key === '最近压缩失败')
  assert.equal(errorRow?.danger, true)
  assert.equal(errorRow?.value, 'provider_error: 上游 429')
  // backgroundTokens 省略（后台压缩禁用）时不出后台阈值行。
  assert.equal(view.rows.find((r) => r.key === '后台压缩阈值'), undefined)
})
