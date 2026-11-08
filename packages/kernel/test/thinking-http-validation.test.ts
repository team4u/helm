import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConversationInit, parseConversationPatch, parseProfileBody } from '../src/http/validate.js'

test('会话 HTTP 接受合法思考档位与清除覆盖，拒绝未知值和类型', { timeout: 60_000 }, () => {
  for (const thinkingLevel of ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(parseConversationPatch({ thinkingLevel }), { thinkingLevel })
  }
  for (const thinkingLevel of [null, 1, 'highest']) assert.throws(() => parseConversationPatch({ thinkingLevel }))
})

test('模型 ID 可含斜杠，HTTP 创建/切换/Profile 保存均保留完整引用', { timeout: 60_000 }, () => {
  const model = 'gateway/group/smart'
  assert.equal(parseConversationInit({ model }).model, model)
  assert.equal(parseConversationPatch({ model }).model, model)
  assert.equal(parseProfileBody({ id: 'worker', model }, { requireId: true }).model, model)
})

test('Profile HTTP 保存思考档位；空串删除并回退全局', { timeout: 60_000 }, () => {
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: 'high' }, { requireId: true }).thinkingLevel, 'high')
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: '' }, { requireId: true }).thinkingLevel, undefined)
  for (const thinkingLevel of [null, 1, 'highest']) assert.throws(() => parseProfileBody({ id: 'worker', thinkingLevel }, { requireId: true }))
})
