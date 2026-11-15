/**
 * event-validation 纯函数单测：assembleHelmEvent（信封拆包/未知类型透传/非法
 * 形状显式抛错）与 pruneUndefined（undefined 剔除、非 plain 值原样）。
 * 行为经 EventHub.publish 的 events.test.ts 全量锁定，此处直测纯函数边界。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError } from '@helm/protocol'
import { assembleHelmEvent, assertSessionDocUpdateShape, pruneUndefined } from '../src/runtime/event-validation.js'

const identity = (t: string) => t

describe('assembleHelmEvent', { timeout: 60_000 }, () => {
  it('未知 type 原样透传为 CustomHelmEvent（不伪装 notification）', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('custom.thing', { a: 1 }, identity)
    assert.deepEqual(event, { type: 'custom.thing', payload: { a: 1 } })
  })

  it('完整信封拆包：payload 自带同名 type 字段时不二次嵌套', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 7 }, identity)
    assert.deepEqual(event, { type: 'conversation.deleted', conversationId: 7 })
  })

  it('非法载荷显式抛 HelmError（不静默修正）', { timeout: 60_000 }, () => {
    assert.throws(() => assembleHelmEvent('', { a: 1 }, identity), HelmError)
    assert.throws(() => assembleHelmEvent('notification', { level: 'verbose', title: 'x' }, identity), /notification/)
    assert.throws(
      () => assembleHelmEvent('plugin.session_doc.updated', { doc: { pluginId: 'p', name: 'n', conversationId: 1, value: 1 } }, identity),
      /不允许进入全局事件流/,
    )
  })

  it('notification 合法载荷保留可选字段缺省语义', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('notification', { level: 'warning', title: 't' }, identity)
    assert.deepEqual(event, { type: 'notification', level: 'warning', title: 't' })
  })
})

describe('assertSessionDocUpdateShape', { timeout: 60_000 }, () => {
  it('合法 doc 原样返回；非法形状显式抛错', { timeout: 60_000 }, () => {
    const doc = { pluginId: 'p', name: 'n', conversationId: 3, value: { x: 1 } }
    assert.equal(assertSessionDocUpdateShape({ doc }), doc)
    assert.throws(() => assertSessionDocUpdateShape({}), HelmError)
    assert.throws(() => assertSessionDocUpdateShape({ doc: { pluginId: '', name: 'n', conversationId: 3, value: 1 } }), HelmError)
    assert.throws(
      () => assertSessionDocUpdateShape({ doc: { pluginId: 'p', name: 'n', conversationId: 3, value: 1, deleted: false } }),
      /deleted/,
    )
  })
})

describe('pruneUndefined', { timeout: 60_000 }, () => {
  it('递归剔除 undefined 可选字段；非 plain 值原样返回', { timeout: 60_000 }, () => {
    const date = new Date(0)
    const input = { a: 1, b: undefined, c: [{ d: undefined, e: 2 }], f: date, g: null }
    const out = pruneUndefined(input, new WeakSet()) as Record<string, unknown>
    assert.deepEqual(Object.keys(out).sort(), ['a', 'c', 'f', 'g'])
    assert.equal(out['f'], date)
    assert.deepEqual(out['c'], [{ e: 2 }])
  })
})
