/**
 * helm:send 目标解析与非法回退测试（spec-action；自 packages/web/test/queued-pill 迁入）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSendTarget, resolveSpecAction } from '../src/builtin-plugins/json-render/client/spec-action.js'

// ---------------------------------------------------------------------------
// 3. resolveSpecAction：默认当前会话与 whenBusy
// ---------------------------------------------------------------------------

test('parseSendTarget: 仅缺省与显式 current 使用默认会话；空串/空白显式拒绝', { timeout: 60_000 }, () => {
  // 字段缺省（undefined）或显式 current 才回退默认会话；null 是显式提供的非法值。
  assert.equal(parseSendTarget(undefined, 12), 12)
  assert.equal(parseSendTarget('current', 12), 12)
  assert.equal(parseSendTarget('conversation:current', 12), 12)
  assert.equal(parseSendTarget(' conversation:current ', 12), 12)
  assert.equal(parseSendTarget(7, undefined), 7)
  assert.equal(parseSendTarget('conversation:42', undefined), 42)
  assert.equal(parseSendTarget('42', undefined), 42)
  // 空串/空白串（模板求值失败产物）绝不路由到默认会话：发错会话风险。
  assert.equal(parseSendTarget('', 12), null)
  assert.equal(parseSendTarget('   ', 12), null)
  // 无默认会话时省略 target / current 显式拒绝。
  assert.equal(parseSendTarget(undefined, undefined), null)
  assert.equal(parseSendTarget('current', undefined), null)
  assert.equal(parseSendTarget(0, 12), null)
  assert.equal(parseSendTarget(1.5, 12), null)
  assert.equal(parseSendTarget('conversation:abc', 12), null)
  // 非安全整数拒绝。
  assert.equal(parseSendTarget(2 ** 53, 12), null)
  assert.equal(parseSendTarget(Number.MAX_SAFE_INTEGER, undefined), Number.MAX_SAFE_INTEGER)
})

test('resolveSpecAction: helm:send 省略 target 默认当前会话；whenBusy 透传', { timeout: 60_000 }, () => {
  const omitted = resolveSpecAction({ type: 'helm:send', text: '巡检一下' }, {}, 33)
  assert.equal(omitted.kind, 'send')
  if (omitted.kind === 'send') {
    assert.equal(omitted.conversationId, 33)
    assert.equal(omitted.text, '巡检一下')
    assert.equal(omitted.whenBusy, undefined)
  }
  const current = resolveSpecAction({ type: 'helm:send', target: 'current', text: '再来一轮' }, {}, 33)
  assert.equal(current.kind, 'send')
  if (current.kind === 'send') assert.equal(current.conversationId, 33)
  const busy = resolveSpecAction(
    { type: 'helm:send', target: 'current', text: '插话', whenBusy: 'steer' },
    {},
    33,
  )
  assert.equal(busy.kind, 'send')
  if (busy.kind === 'send') assert.equal(busy.whenBusy, 'steer')
  // 显式 target 仍优先生效；非法 whenBusy 显式 invalid（拼写错误不静默丢弃）。
  const explicit = resolveSpecAction(
    { type: 'helm:send', target: 'conversation:9', text: 'x', whenBusy: 'later' },
    {},
    33,
  )
  assert.equal(explicit.kind, 'invalid')
  if (explicit.kind === 'invalid') assert.match(explicit.message, /whenBusy 无效/)
  const legalExplicit = resolveSpecAction({ type: 'helm:send', target: 'conversation:9', text: 'x' }, {}, 33)
  assert.equal(legalExplicit.kind, 'send')
  if (legalExplicit.kind === 'send') assert.equal(legalExplicit.whenBusy, undefined)
  // 模板求值产生空串 target（如 'conversation:{$row.missing}' 求值后路径缺失）：
  // 显式 invalid，绝不静默路由到默认会话（发错会话风险）。
  const blankTarget = resolveSpecAction(
    { type: 'helm:send', target: 'conversation:{$row.missing}', text: 'x' },
    {},
    33,
  )
  assert.equal(blankTarget.kind, 'invalid')
  if (blankTarget.kind === 'invalid') assert.match(blankTarget.message, /target 求值后无效/)
  // 整串模板表达式路径缺失（求值出 undefined）：声明里明确提供了 target，
  // 不得当作省略回退默认会话（浏览器实测 bug：会发错会话）。
  const undefinedTarget = resolveSpecAction(
    { type: 'helm:send', target: '{$row.missing}', text: 'x' },
    {},
    33,
  )
  assert.equal(undefinedTarget.kind, 'invalid')
  if (undefinedTarget.kind === 'invalid') assert.match(undefinedTarget.message, /求值后无效/)
  // 无默认会话且 target 省略：显式 invalid（不猜测 #1）。
  const invalid = resolveSpecAction({ type: 'helm:send', text: 'x' }, {})
  assert.equal(invalid.kind, 'invalid')
  if (invalid.kind === 'invalid') assert.match(invalid.message, /无默认会话/)
})

test('helm:send 显式提供 target 求值失败时绝不回退默认会话（浏览器实测回归）', { timeout: 60_000 }, () => {
  // 场景：卡片声明写了 target: '{$data.missing}'，$data 中无该路径，
  // evaluateSpecValue 整串表达式求值出 undefined。旧实现把它当字段省略
  // 回退 defaultConversationId，导致「不可发送」的消息发到了当前 #7。
  const bug = resolveSpecAction(
    { type: 'helm:send', target: '{$data.missing}', text: '不可发送' },
    {},
    7,
  )
  assert.equal(bug.kind, 'invalid')
  if (bug.kind === 'invalid') {
    assert.match(bug.message, /target 求值后无效/)
    assert.match(bug.message, /undefined/)
  }
  // 同类变体：显式 target 为 null / 空串 / 空白串 / 非法字符串，一律 invalid。
  assert.equal(resolveSpecAction({ type: 'helm:send', target: null, text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: '', text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: '   ', text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: 'conversation:', text: 'x' }, {}, 7).kind, 'invalid')
  // 对比：字段真正省略与显式 current 仍回退默认会话。
  assert.equal(resolveSpecAction({ type: 'helm:send', text: 'x' }, {}, 7).kind, 'send')
  const cur = resolveSpecAction({ type: 'helm:send', target: 'current', text: 'x' }, {}, 7)
  assert.equal(cur.kind, 'send')
  if (cur.kind === 'send') assert.equal(cur.conversationId, 7)
  // 求值成功的模板（路径存在，值为正整数）仍正常定向。
  const ok = resolveSpecAction(
    { type: 'helm:send', target: '{$data.targetId}', text: 'x' },
    { $data: { targetId: 9 } },
    7,
  )
  assert.equal(ok.kind, 'send')
  if (ok.kind === 'send') assert.equal(ok.conversationId, 9)
})
