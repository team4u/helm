import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchesConversationScope, type ConversationScopeTarget } from '@helmx/protocol'

const conv = (over: Partial<ConversationScopeTarget>): ConversationScopeTarget => ({
  id: 1,
  profileId: 'assistant',
  tags: ['alpha'],
  ...over,
})

describe('matchesConversationScope', () => {
  it('undefined scope is unrestricted (always matches)', { timeout: 60_000 }, () => {
    assert.equal(matchesConversationScope(undefined, conv({})), true)
  })

  it('empty-object scope is equivalent to unrestricted', { timeout: 60_000 }, () => {
    assert.equal(matchesConversationScope({}, conv({})), true)
  })

  it('multiple values within a field are OR-ed', { timeout: 60_000 }, () => {
    const target = conv({ id: 7, profileId: 'worker', tags: ['router', 'watchdog'] })
    assert.equal(matchesConversationScope({ conversationIds: [7, 8] }, target), true)
    assert.equal(matchesConversationScope({ conversationIds: [9] }, target), false)
    assert.equal(matchesConversationScope({ profileIds: ['worker', 'audit'] }, target), true)
    assert.equal(matchesConversationScope({ tags: ['watchdog', 'other'] }, target), true)
    assert.equal(matchesConversationScope({ tags: ['other'] }, target), false)
  })

  it('different fields are AND-ed', { timeout: 60_000 }, () => {
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

  it('absent fields are unrestricted', { timeout: 60_000 }, () => {
    const target = conv({ id: 5, profileId: 'audit', tags: [] })
    assert.equal(matchesConversationScope({ conversationIds: [5] }, target), true)
    assert.equal(matchesConversationScope({ profileIds: ['audit'] }, target), true)
    // tags absent means unrestricted, even when the conversation has no tags
    assert.equal(matchesConversationScope({ conversationIds: [5], profileIds: ['audit'] }, target), true)
  })

  it('explicit empty arrays match no conversation', { timeout: 60_000 }, () => {
    const target = conv({})
    assert.equal(matchesConversationScope({ conversationIds: [] }, target), false)
    assert.equal(matchesConversationScope({ tags: [] }, target), false)
    assert.equal(matchesConversationScope({ profileIds: [] }, target), false)
  })
})
