/**
 * event-validation pure function single test:assembleHelmEvent(message seal split package/unknown type pass-through/illegal
 * shape explicit throws) and pruneUndefined(undefined remove, non- plain value original).
 * behavior via EventHub.publish  events.test.ts all amount lock, this where direct test pure function boundary.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError } from '@helm/protocol'
import { assembleHelmEvent, assertSessionDocUpdateShape, pruneUndefined } from '../src/runtime/event-validation.js'

const identity = (t: string) => t

describe('assembleHelmEvent', { timeout: 60_000 }, () => {
  it('unknown type original pass-through is CustomHelmEvent(does not pretend to be notification)', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('custom.thing', { a: 1 }, identity)
    assert.deepEqual(event, { type: 'custom.thing', payload: { a: 1 } })
  })

  it('complete message seal split package:payload self carries same name type field when do not second embed set', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 7 }, identity)
    assert.deepEqual(event, { type: 'conversation.deleted', conversationId: 7 })
  })

  it('illegal payload explicit throw HelmError(not silently fix correct)', { timeout: 60_000 }, () => {
    assert.throws(() => assembleHelmEvent('', { a: 1 }, identity), HelmError)
    assert.throws(() => assembleHelmEvent('notification', { level: 'verbose', title: 'x' }, identity), /notification/)
    assert.throws(
      () => assembleHelmEvent('plugin.session_doc.updated', { doc: { pluginId: 'p', name: 'n', conversationId: 1, value: 1 } }, identity),
      /disallows enter global event stream/,
    )
  })

  it('notification legal payload keep optional field default semantics', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('notification', { level: 'warning', title: 't' }, identity)
    assert.deepEqual(event, { type: 'notification', level: 'warning', title: 't' })
  })
})

describe('assertSessionDocUpdateShape', { timeout: 60_000 }, () => {
  it('legal doc original return; illegal shape explicit throws', { timeout: 60_000 }, () => {
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
  it('recursion remove undefined optional field; non- plain value original return', { timeout: 60_000 }, () => {
    const date = new Date(0)
    const input = { a: 1, b: undefined, c: [{ d: undefined, e: 2 }], f: date, g: null }
    const out = pruneUndefined(input, new WeakSet()) as Record<string, unknown>
    assert.deepEqual(Object.keys(out).sort(), ['a', 'c', 'f', 'g'])
    assert.equal(out['f'], date)
    assert.deepEqual(out['c'], [{ e: 2 }])
  })
})
