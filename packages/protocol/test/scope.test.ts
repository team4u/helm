import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchesConversationScope, type ConversationScopeTarget } from '@helm/protocol'

const conv = (over: Partial<ConversationScopeTarget>): ConversationScopeTarget => ({
  id: 1,
  profileId: 'assistant',
  tags: ['alpha'],
  ...over,
})

describe('matchesConversationScope', () => {
  it('scope 为 undefined 时不限（一律匹配）', { timeout: 60_000 }, () => {
    assert.equal(matchesConversationScope(undefined, conv({})), true)
  })

  it('空对象 scope 等价不限', { timeout: 60_000 }, () => {
    assert.equal(matchesConversationScope({}, conv({})), true)
  })

  it('字段内多值 OR', { timeout: 60_000 }, () => {
    const target = conv({ id: 7, profileId: 'worker', tags: ['router', 'watchdog'] })
    assert.equal(matchesConversationScope({ conversationIds: [7, 8] }, target), true)
    assert.equal(matchesConversationScope({ conversationIds: [9] }, target), false)
    assert.equal(matchesConversationScope({ profileIds: ['worker', 'audit'] }, target), true)
    assert.equal(matchesConversationScope({ tags: ['watchdog', 'other'] }, target), true)
    assert.equal(matchesConversationScope({ tags: ['other'] }, target), false)
  })

  it('不同字段之间 AND', { timeout: 60_000 }, () => {
    const target = conv({ id: 3, profileId: 'worker', tags: ['router'] })
    assert.equal(
      matchesConversationScope({ conversationIds: [3], profileIds: ['worker'], tags: ['router'] }, target),
      true,
    )
    assert.equal(
      matchesConversationScope({ conversationIds: [3], profileIds: ['audit'], tags: ['router'] }, target),
      false,
    )
    assert.equal(
      matchesConversationScope({ conversationIds: [4], profileIds: ['worker'], tags: ['router'] }, target),
      false,
    )
  })

  it('字段缺省不限', { timeout: 60_000 }, () => {
    const target = conv({ id: 5, profileId: 'audit', tags: [] })
    assert.equal(matchesConversationScope({ conversationIds: [5] }, target), true)
    assert.equal(matchesConversationScope({ profileIds: ['audit'] }, target), true)
    // tags 缺省不限，即使会话无标签
    assert.equal(matchesConversationScope({ conversationIds: [5], profileIds: ['audit'] }, target), true)
  })

  it('显式空数组匹配不到任何会话', { timeout: 60_000 }, () => {
    const target = conv({})
    assert.equal(matchesConversationScope({ conversationIds: [] }, target), false)
    assert.equal(matchesConversationScope({ tags: [] }, target), false)
    assert.equal(matchesConversationScope({ profileIds: [] }, target), false)
  })
})
