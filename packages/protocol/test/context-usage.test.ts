/**
 * ConversationContextUsage 契约（类型级）：
 * - ConversationSummary.contextUsage 可选，不破坏既有公共形状；
 * - tokens 必填（number | null：null = 压缩后上下文未知），contextWindow /
 *   compacting 可选（未知不伪造）；
 * - 契约已收敛：measuredTokens / thresholds / compactionError 不复存在
 *  （编译期负例锁定，防止死字段回潮）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationContextUsage, ConversationSummary } from '@helm/protocol'

describe('ConversationSummary.contextUsage 契约', () => {
  it('最小用量（仅 tokens）合法：未知窗口/压缩态省略', { timeout: 60_000 }, () => {
    const usage: ConversationContextUsage = { tokens: 12_345 }
    const summary: ConversationSummary = {
      id: 1,
      title: '会话',
      profileId: 'assistant',
      tags: [],
      cwd: '/tmp',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contextUsage: usage,
    }
    assert.equal(summary.contextUsage, usage)
  })

  it('tokens 可为 null（压缩后尚无有效 usage）；全量形状 = tokens + 窗口 + 压缩中', { timeout: 60_000 }, () => {
    const unknown: ConversationContextUsage = { tokens: null, contextWindow: 128_000 }
    assert.equal(unknown.tokens, null)
    const full: ConversationContextUsage = { tokens: 91_000, contextWindow: 128_000, compacting: true }
    assert.equal(full.compacting, true)
  })

  it('死字段编译期拒绝（measuredTokens / thresholds / compactionError）', { timeout: 60_000 }, () => {
    // @ts-expect-error measuredTokens 已随旧 Popover 展示一起删除
    const withMeasured: ConversationContextUsage = { tokens: 1, measuredTokens: 1 }
    // @ts-expect-error thresholds 已删除（阈值展示不再随用量携带）
    const withThresholds: ConversationContextUsage = { tokens: 1, thresholds: { blockingTokens: 1 } }
    // @ts-expect-error compactionError 已删除（失败改走 notification 事件）
    const withError: ConversationContextUsage = { tokens: 1, compactionError: 'boom' }
    assert.ok(withMeasured || withThresholds || withError)
  })
})
