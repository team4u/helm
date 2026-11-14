/**
 * ConversationContextUsage 契约（类型级）：
 * - ConversationSummary.contextUsage 可选，不破坏既有公共形状；
 * - tokens / thresholds.blockingTokens 必填，其余可选（未知不伪造）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationContextUsage, ConversationSummary } from '@helm/protocol'

describe('ConversationSummary.contextUsage 契约', () => {
  it('最小用量（仅 tokens）合法：未知窗口/阈值/压缩态全部省略', { timeout: 60_000 }, () => {
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

  it('全量形状合法：实测拆分 + 阈值（blockingTokens 必填）+ 压缩态 + 失败摘要', { timeout: 60_000 }, () => {
    const usage: ConversationContextUsage = {
      tokens: 91_000,
      measuredTokens: 90_000,
      contextWindow: 128_000,
      thresholds: { blockingTokens: 111_616, backgroundTokens: 78_848 },
      compacting: { trigger: 'threshold', blocking: true },
      compactionError: 'provider_error',
    }
    assert.equal(usage.thresholds.blockingTokens, 111_616)
    assert.equal(usage.compacting?.trigger, 'threshold')
  })
})
