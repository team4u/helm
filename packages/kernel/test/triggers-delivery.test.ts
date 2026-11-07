import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationSummary } from '@helm/protocol'
import { createDeliveryDispatch } from '../src/builtin-plugins/triggers/delivery.js'

test('Profile 查询期间进入关闭状态时，不再向会话投递触发输入', { timeout: 60_000 }, async () => {
  let resolveProfile!: (value: { id: string }) => void
  const profile = new Promise<{ id: string }>((resolve) => { resolveProfile = resolve })
  let closing = false
  let delivered = false
  const conversation = { id: 7, profileId: 'finance' } as ConversationSummary
  const dispatch = createDeliveryDispatch({
    host: {
      listConversations: () => [conversation],
      getConversation: () => conversation,
      createConversation: async () => { throw new Error('应复用已有会话') },
      dispatchTrigger: async () => { delivered = true },
    },
    profiles: { get: () => profile },
    isClosing: () => closing,
  })
  const pending = dispatch({ id: 'event', source: 'webhook:finance', text: '查询财务', createdAt: Date.now() }, 'finance')
  closing = true
  resolveProfile({ id: 'finance' })
  await assert.rejects(pending, { code: 'runtime_closing', status: 409 })
  assert.equal(delivered, false)
})
