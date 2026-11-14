/**
 * 上下文用量纯展示模型（context-usage-model）单测：
 * - formatTokens 严格抄 pi footer 分档（<1000 原值 / <10000 一位小数 k /
 *   <1M 四舍五入 k / <10M 一位小数 M / 之后四舍五入 M）；
 * - 只读文本：窗口已知 `${percent.toFixed(1)}%/${formatTokens(window)}`；
 *   压缩后未知 `?/${formatTokens(window)}`；窗口未知只显示紧凑估算量；
 * - 色调阈值严格 >90 红 / >70 黄，其余（含窗口未知）恒默认灰；
 * - tokens=0 与空 usage 不渲染；压缩中显示「精简中…」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextUsageLabel, formatTokens } from '../src/conversation/context-usage-model.js'

test('formatTokens：pi footer 分档（<1000 原值；<10000 一位小数 k；<1M 取整 k；<10M 一位小数 M）', { timeout: 60_000 }, () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_000), '1.0k')
  assert.equal(formatTokens(1_234), '1.2k')
  assert.equal(formatTokens(9_999), '10.0k')
  assert.equal(formatTokens(10_000), '10k')
  assert.equal(formatTokens(12_400), '12k')
  assert.equal(formatTokens(123_456), '123k')
  assert.equal(formatTokens(999_999), '1000k')
  assert.equal(formatTokens(1_000_000), '1.0M')
  assert.equal(formatTokens(1_500_000), '1.5M')
  assert.equal(formatTokens(10_000_000), '10M')
  assert.equal(formatTokens(12_345_678), '12M')
})

test('窗口已知：pi 同款百分比一位小数 + 窗口分母', { timeout: 60_000 }, () => {
  // 37.5%/200k（任务示例）
  assert.equal(contextUsageLabel({ tokens: 75_000, contextWindow: 200_000 })?.text, '37.5%/200k')
  assert.equal(contextUsageLabel({ tokens: 25_000, contextWindow: 100_000 })?.text, '25.0%/100k')
  assert.equal(contextUsageLabel({ tokens: 1_200, contextWindow: 128_000 })?.text, '0.9%/128k')
})

test('色调阈值严格 >90 / >70：90 与 70 本身不越档', { timeout: 60_000 }, () => {
  assert.equal(contextUsageLabel({ tokens: 90_000, contextWindow: 100_000 })?.tone, 'warn')
  assert.equal(contextUsageLabel({ tokens: 90_001, contextWindow: 100_000 })?.tone, 'high')
  assert.equal(contextUsageLabel({ tokens: 70_000, contextWindow: 100_000 })?.tone, 'default')
  assert.equal(contextUsageLabel({ tokens: 70_001, contextWindow: 100_000 })?.tone, 'warn')
  assert.equal(contextUsageLabel({ tokens: 1_000, contextWindow: 100_000 })?.tone, 'default')
})

test('tokens=null（压缩后尚无有效 usage）：窗口已知显示 ?/窗口，未知显示 ?', { timeout: 60_000 }, () => {
  const known = contextUsageLabel({ tokens: null, contextWindow: 200_000 })
  assert.equal(known?.text, '?/200k')
  assert.equal(known?.tone, 'default', '未知占比不得着色为 warn/high')
  const unknownWindow = contextUsageLabel({ tokens: null })
  assert.equal(unknownWindow?.text, '?')
  assert.equal(unknownWindow?.tone, 'default')
})

test('窗口未知：只显示紧凑估算量，绝不显示伪百分比或伪分母', { timeout: 60_000 }, () => {
  const label = contextUsageLabel({ tokens: 12_345 })
  assert.equal(label?.text, '12k')
  assert.ok(!label!.text.includes('%'), '窗口未知不得显示伪百分比')
  assert.equal(label?.tone, 'default', '窗口未知不得着色为 warn/high')
  // 高占用但窗口未知：同样只显示估算量且不着色。
  const huge = contextUsageLabel({ tokens: 999_999 })
  assert.equal(huge?.text, '1000k')
  assert.equal(huge?.tone, 'default')
})

test('tokens=0（空会话/刚 reset）与压缩中：0 不渲染；压缩中显示精简中', { timeout: 60_000 }, () => {
  assert.equal(contextUsageLabel({ tokens: 0 }), null)
  assert.equal(contextUsageLabel({ tokens: 0, contextWindow: 128_000 }), null)
  const compacting = contextUsageLabel({ tokens: 0, contextWindow: 128_000, compacting: true })
  assert.equal(compacting?.text, '精简中…')
  assert.equal(compacting?.tone, 'default')
  // tokens=null 但压缩进行中：同样显示精简中（压缩未完成时占比未知是常态）。
  assert.equal(contextUsageLabel({ tokens: null, contextWindow: 128_000, compacting: true })?.text, '精简中…')
})
