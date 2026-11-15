/**
 * ConversationContextUsage / ConversationLive 契约（类型级）：
 * - ConversationSummary.contextUsage 可选，不破坏既有公共形状；
 * - tokens 必填（number | null：null = 压缩后上下文未知），contextWindow /
 *   compacting 可选（未知/不可测量不伪造）；
 * - 速率类指标不随用量携带（response 等已删除：策略归可选插件
 *   builtin:token-speed，编译期负例锁定，防止死字段回潮）；
 * - ConversationLive.generation 为通用流式事实（attempt + 受限 message 投影），
 *   内核零速率计算；tokenSpeed 等策略字段不存在于协议（编译期负例锁定）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationContextUsage, ConversationLive, ConversationSummary } from '@helm/protocol'

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
    const full: ConversationContextUsage = {
      tokens: 91_000,
      contextWindow: 128_000,
      compacting: true,
    }
    assert.equal(full.compacting, true)
    assert.equal(full.contextWindow, 128_000)
  })

  it('死字段编译期拒绝（measuredTokens / thresholds / compactionError / 裸 tps / response 速率）', { timeout: 60_000 }, () => {
    // @ts-expect-error measuredTokens 已随旧 Popover 展示一起删除
    const withMeasured: ConversationContextUsage = { tokens: 1, measuredTokens: 1 }
    // @ts-expect-error thresholds 已删除（阈值展示不再随用量携带）
    const withThresholds: ConversationContextUsage = { tokens: 1, thresholds: { blockingTokens: 1 } }
    // @ts-expect-error compactionError 已删除（失败改走 notification 事件）
    const withError: ConversationContextUsage = { tokens: 1, compactionError: 'boom' }
    // @ts-expect-error 裸 tps 不存在：速率策略归可选插件，不随内核用量携带
    const withBareTps: ConversationContextUsage = { tokens: 1, tps: 52.4 }
    // @ts-expect-error response 速率三元组已删除（同上；插件经 COMPOSER_STATUS_SLOT 展示）
    const withResponse: ConversationContextUsage = { tokens: 1, response: { responseTps: 52.4 } }
    assert.ok(withMeasured || withThresholds || withError || withBareTps || withResponse)
  })
})

describe('ConversationLive.generation 通用流式事实契约', () => {
  const base: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 0,
  }

  it('最小 generation（仅 attempt，message 尚无内容时省略）合法', { timeout: 60_000 }, () => {
    const live: ConversationLive = { ...base, generation: { attempt: 1 } }
    assert.equal(live.generation?.attempt, 1)
    assert.equal(live.generation?.message, undefined)
  })

  it('全量 message 投影：text/thinking/toolCall 块 + 供应商累计 usage', { timeout: 60_000 }, () => {
    const live: ConversationLive = {
      ...base,
      generation: {
        attempt: 2,
        message: {
          content: [
            { type: 'thinking', thinking: '推理' },
            { type: 'text', text: '回答' },
            { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          ],
          usage: { output: 128 },
        },
      },
    }
    assert.equal(live.generation!.message!.content.length, 3)
    assert.equal(live.generation!.message!.usage!.output, 128)
  })

  it('策略字段不存在于协议（tokenSpeed / decode 等；编译期负例锁定内核零速率计算）', { timeout: 60_000 }, () => {
    // @ts-expect-error tokenSpeed 不存在：速率是插件策略，内核只透传事实
    const withTokenSpeed: ConversationLive = { ...base, tokenSpeed: { phase: 'decoding', outputTokens: 1, decodeMs: 1, source: 'estimate', updatedAt: 0 } }
    // @ts-expect-error response 不存在：终态速率同样归插件
    const withResponse: ConversationContextUsage = { tokens: 1, response: { decodeTps: 52.4 } }
    assert.ok(withTokenSpeed || withResponse)
  })
})
