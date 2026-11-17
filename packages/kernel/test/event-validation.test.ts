/**
 * Unit tests for event-validation pure functions: `assembleHelmEvent` (message envelope, unknown type passthrough,
 * explicit throw on invalid shape) and `pruneUndefined` (strip undefined, preserve non-plain values).
 * Runtime behavior through `EventHub.publish` is fully covered in `events.test.ts`; here we test the pure function boundaries directly.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HelmError } from '@helm/protocol'
import {
  assembleHelmEvent,
  assertSessionDocUpdateShape,
  pruneUndefined,
  validateAndRedactConversationLive,
} from '../src/runtime/event-validation.js'

const identity = (t: string) => t

describe('assembleHelmEvent', { timeout: 60_000 }, () => {
  it('unknown type passes through unchanged as CustomHelmEvent (does not pretend to be notification)', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('custom.thing', { a: 1 }, identity)
    assert.deepEqual(event, { type: 'custom.thing', payload: { a: 1 } })
  })

  it('full message envelope: preserves same-named type field in payload without nesting', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 7 }, identity)
    assert.deepEqual(event, { type: 'conversation.deleted', conversationId: 7 })
  })

  it('invalid payload explicitly throws HelmError (never silently coerces)', { timeout: 60_000 }, () => {
    assert.throws(() => assembleHelmEvent('', { a: 1 }, identity), HelmError)
    assert.throws(() => assembleHelmEvent('notification', { level: 'verbose', title: 'x' }, identity), /notification/)
    assert.throws(
      () => assembleHelmEvent('plugin.session_doc.updated', { doc: { pluginId: 'p', name: 'n', conversationId: 1, value: 1 } }, identity),
      /cannot enter the global event stream/,
    )
    assert.throws(
      () =>
        assembleHelmEvent(
          'conversation.live',
          { live: { conversationId: 1, text: 'hi', tools: [], updatedAt: 1 } },
          identity,
        ),
      /transient/,
    )
  })

  it('conversation.upsert validates optional non-negative integer lastEntryId', { timeout: 60_000 }, () => {
    const base = {
      id: 1,
      title: 't',
      profileId: 'assistant',
      tags: [],
      cwd: '/tmp',
      model: 'm',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const ok = assembleHelmEvent('conversation.upsert', { ...base, lastEntryId: 42 }, identity)
    assert.equal((ok as { conversation: { lastEntryId?: number } }).conversation.lastEntryId, 42)
    const zero = assembleHelmEvent('conversation.upsert', { ...base, lastEntryId: 0 }, identity)
    assert.equal((zero as { conversation: { lastEntryId?: number } }).conversation.lastEntryId, 0)
    for (const bad of [-1, 1.5, Number.NaN, '42', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => assembleHelmEvent('conversation.upsert', { ...base, lastEntryId: bad }, identity), HelmError)
    }
  })

  it('valid notification payload preserves optional field default semantics', { timeout: 60_000 }, () => {
    const event = assembleHelmEvent('notification', { level: 'warning', title: 't' }, identity)
    assert.deepEqual(event, { type: 'notification', level: 'warning', title: 't' })
  })
})

describe('validateAndRedactConversationLive', { timeout: 60_000 }, () => {
  it('validates ConversationLive shape, prunes undefined, and redacts secrets', { timeout: 60_000 }, () => {
    const redact = (t: string) => t.replaceAll('sk-secret', '[REDACTED]')
    const live = validateAndRedactConversationLive(
      {
        conversationId: 3,
        text: 'hello sk-secret',
        thinking: undefined,
        tools: [{ callId: 'c1', toolName: 'bash', status: 'running', input: { token: 'sk-secret' } }],
        updatedAt: 123,
      },
      redact,
    )
    assert.equal(live.conversationId, 3)
    assert.equal(live.text, 'hello [REDACTED]')
    assert.equal('thinking' in live, false)
    assert.equal((live.tools[0]?.input as { token?: string }).token, '[REDACTED]')
  })

  it('rejects malformed ConversationLive payloads explicitly', { timeout: 60_000 }, () => {
    for (const bad of [
      null,
      {},
      { live: { conversationId: 1, text: '', tools: [], updatedAt: 1 } },
      { conversationId: 0, text: '', tools: [], updatedAt: 1 },
      { conversationId: -1, text: '', tools: [], updatedAt: 1 },
      { conversationId: 1, text: 123, tools: [], updatedAt: 1 },
      { conversationId: 1, text: '', tools: 'bad', updatedAt: 1 },
      { conversationId: 1, text: '', tools: [], updatedAt: Number.NaN },
      { conversationId: 1, text: '', tools: [], thinking: 42, updatedAt: 1 },
      { conversationId: 1, text: '', tools: [], queuedInputs: 'bad', updatedAt: 1 },
    ]) {
      assert.throws(() => validateAndRedactConversationLive(bad, identity), HelmError)
    }
  })
})

describe('assertSessionDocUpdateShape', { timeout: 60_000 }, () => {
  it('valid doc returns unchanged; invalid shape explicitly throws', { timeout: 60_000 }, () => {
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
  it('recursively removes undefined optional fields; non-plain values return unchanged', { timeout: 60_000 }, () => {
    const date = new Date(0)
    const input = { a: 1, b: undefined, c: [{ d: undefined, e: 2 }], f: date, g: null }
    const out = pruneUndefined(input, new WeakSet()) as Record<string, unknown>
    assert.deepEqual(Object.keys(out).sort(), ['a', 'c', 'f', 'g'])
    assert.equal(out['f'], date)
    assert.deepEqual(out['c'], [{ e: 2 }])
  })
})
