import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import { matchesUiScope } from '../src/lib/types.js'

const conversation: ConversationSummary = {
  id: 1, title: 'Scope fixture', profileId: 'assistant', tags: ['work'],
  cwd: '/tmp', model: 'example/group/nested-model', status: 'idle',
  stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
  pendingAskCount: 0, createdAt: 1, updatedAt: 1,
}

test('UI 按模型供应商声明作用域，切换会话后隐藏且保留多维 AND 语义', { timeout: 60_000 }, () => {
  const scope = { modelProviders: ['example'], profileIds: ['assistant'], tags: ['work'] }
  assert.equal(matchesUiScope(conversation, scope), true)
  assert.equal(matchesUiScope({ ...conversation, model: 'another/model' }, scope), false)
  assert.equal(matchesUiScope({ ...conversation, profileId: 'another' }, scope), false)
  assert.equal(matchesUiScope({ ...conversation, model: '' }, scope), false)
  assert.equal(matchesUiScope(conversation, { modelProviders: [] }), false)
  assert.equal(matchesUiScope(undefined, scope), false)
  assert.equal(matchesUiScope(undefined, undefined), true)
})
