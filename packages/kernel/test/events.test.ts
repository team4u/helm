/**
 * EventHub real HTTP integration test: true Response.body reader + AbortController.
 *
 * override:SSE first frame snapshot / incremental frame protocol,abort and reader.cancel unsubscribe,close() clean field,
 * slow consumer byte back press closure stream, snapshot race without lose frame, snapshot redaction,publish ordinal when order,
 * plugin.changed message seal/direct pass double shape,CustomHelmEvent pass-through, illegal payload explicit failed,
 * conversation.upsert / ask.upsert / notification one by one field strictly validate (not silently fall back).
 * in-memory fixture(without real model, without real store;persistSeq use callback catch).
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ConversationSummary, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { EventHub, type SseFrame, type SnapshotProvider } from '../src/runtime/events.js'
import { makeConversationSummary, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

interface Fixture {
  hub: EventHub
  snapshotValue: ReturnType<SnapshotProvider>
  persistedSeqs: number[]
}
function summary(id: number, title: string, doing?: string): ConversationSummary {
  return makeConversationSummary({
    id,
    title,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(doing !== undefined ? { doing } : {}),
  })
}

function makeFixture(opts?: { maxPendingBytes?: number; initialSeq?: number; keepaliveMs?: number }): Fixture {
  const persistedSeqs: number[] = []
  const initialSeq = opts?.initialSeq ?? 0
  const fixture: Fixture = {
    snapshotValue: { seq: initialSeq, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] },
    persistedSeqs,
    hub: undefined as unknown as Fixture['hub'],
  }
  fixture.hub = new EventHub({
    initialSeq,
    snapshot: () => fixture.snapshotValue,
    persistSeq: (seq) => persistedSeqs.push(seq),
    ...(opts?.maxPendingBytes !== undefined ? { maxPendingBytes: opts.maxPendingBytes } : {}),
    ...(opts?.keepaliveMs !== undefined ? { keepaliveMs: opts.keepaliveMs } : {}),
  })
  return fixture
}

/** parse one segment SSE text is {event, data} list. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '') continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) data += line.slice('data: '.length)
    }
    frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
  }
  return frames
}

/** read to stream end, return complete text; optional each frame call back. */
async function readAll(
  response: Response,
  onChunk?: (text: string) => void,
): Promise<string> {
  assert.ok(response.body !== null, 'SSE response must has body stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let all = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    all += text
    onChunk?.(text)
  }
  return all
}

/** single time read attach carries Deadline: heartbeat not by when reach i.e. explicit failed (do not let test hang to set piece timeout). */
async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 2000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`read timeout (${ms}ms): heartbeat not reach`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// response(): real HTTP semantics
// ---------------------------------------------------------------------------

describe('EventHub.response SSE protocol', { timeout: 60_000 }, () => {
  it('first frame event:snapshot carry HelmSnapshot, incremental frame event:<type> carry {seq,event}', { timeout: 60_000 }, async () => {
    const { hub, snapshotValue } = makeFixture()
    snapshotValue.conversations = [summary(1, 'person assist')]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.equal(response.headers.get('cache-control'), 'no-cache')

    const frames: Array<{ event: string; data: unknown }> = []
    const reading = readAll(response, (text) => {
      for (const f of parseSse(text)) frames.push(f)
    })
    await waitFor(() => frames.length >= 1)
    hub.publish('notification', { level: 'info', title: '你好' })
    await waitFor(() => frames.some((f) => f.event === 'notification'))
    controller.abort()
    await reading

    const first = frames[0]
    assert.ok(first && first.event === 'snapshot', 'first frame must be snapshot')
    const snap = first.data as HelmSnapshot
    assert.equal(snap.seq, 0)
    assert.equal(snap.conversations.length, 1)
    assert.equal(snap.conversations[0]?.title, 'person assist')
    assert.deepEqual(snap.pendingAsks, [])
    assert.deepEqual(snap.plugins, [])

    const second = frames[1]
    assert.ok(second && second.event === 'notification')
    assert.deepEqual(second.data, {
      seq: 1,
      event: { type: 'notification', level: 'info', title: '你好' },
    })
  })

  it('Request.signal abort unsubscribe and closure stream; reconnect rely on new snapshot align', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.equal(hub.subscriberCount, 1)
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort after immediately unsubscribe')
    const text = await readAll(response, () => {})
    assert.match(text, /event: snapshot/, 'closure stream before already write first frame still can read')
    // abort after publish no longer enter the stream (reader already done).
    hub.publish('notification', { level: 'info', title: 'after' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('ReadableStream.cancel same unsubscribe (client actively disconnect)', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.ok(first.done !== true)
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel after immediately unsubscribe')
    hub.publish('notification', { level: 'info', title: 'cancel after' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('close() empty all subscribe (kernel closure deactivate)', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const c1 = new AbortController()
    const c2 = new AbortController()
    hub.response(new Request('http://x', { signal: c1.signal }))
    hub.response(new Request('http://x', { signal: c2.signal }))
    hub.subscribe(() => {})
    assert.equal(hub.subscriberCount, 3)
    hub.close()
    assert.equal(hub.subscriberCount, 0)
    c1.abort()
    c2.abort()
  })

  it('without event when keep stream (does not fall back JSON/204), incremental in any moment reach i.e. reach', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    let resolveFrame: () => void = () => {}
    const frameCame = new Promise<void>((r) => {
      resolveFrame = r
    })
    const reading = readAll(response, (text) => {
      if (text.includes('conversation.upsert')) resolveFrame()
    })
    // any moment publish (simulated idle after sudden).
    setTimeout(() => hub.publish('conversation.upsert', summary(2, 'sudden conversation')), 30)
    await frameCame
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// back press: slow consumer
// ---------------------------------------------------------------------------

describe('EventHub slow consumer back press', { timeout: 60_000 }, () => {
  it('streaming phase not read byte over limit: explicit closure stream (do not lose frame not silently resume)', { timeout: 60_000 }, async () => {
    // 1 KiB cap: single frame about 100+ byte, slow read 2 frame inside must trigger.
    const { hub } = makeFixture({ maxPendingBytes: 1024 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // only read one chunk (snapshot), then do not read - - fabricate accumulate press.
    const first = await reader.read()
    assert.ok(first.value)
    text += decoder.decode(first.value, { stream: true })
    assert.match(text, /event: snapshot/)

    for (let i = 0; i < 64; i++) {
      hub.publish('notification', { level: 'info', title: `n${i}`, body: 'x'.repeat(64) })
      if (hub.subscriberCount === 0) break
    }
    assert.equal(hub.subscriberCount, 0, 'byte accumulate press over limit after subscribe by explicit remove')
    // stream already by server side close; queue inside already queue frame still can read, eventually obtain to done(no longer delivery new frame).
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    hub.publish('notification', { level: 'info', title: 'closure stream after must not reach' })
    const after = await reader.read()
    assert.ok(after.done, 'closure stream after no longer delivery new frame')
    controller.abort()
  })

  it('normal consumer one by one chunk continuous read do not subject to back press affect', { timeout: 60_000 }, async () => {
    // 16 KiB pre- compute far greater than single frame, but sync burst will instant between heap accumulate (read is async),
    // reason one by one chunk hand over replace publish/wait for verify normal consumer water far do not by mistakenly closure.
    const { hub } = makeFixture({ maxPendingBytes: 16 * 1024 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const chunks: string[] = []
    const reading = readAll(response, (t) => chunks.push(t))
    await waitFor(() => chunks.length >= 1)
    for (let i = 0; i < 50 && hub.subscriberCount > 0; i++) {
      hub.publish('notification', { level: 'info', title: `event${i}` })
      await waitFor(() => chunks.join('').includes(`event${i}`))
    }
    assert.equal(hub.subscriberCount, 1, 'one by one chunk read consumer keep subscribe')
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// snapshot race: subscribe first at snapshot, without lose frame
// ---------------------------------------------------------------------------

describe('EventHub snapshot race', { timeout: 60_000 }, () => {
  it('snapshot take set after, conflict refresh before publish event (seq more large) must reach and does not repeat', { timeout: 60_000 }, async () => {
    // initialSeq and snapshot.seq align is 5; publish after seq=6 event must appear in stream in.
    const { hub, snapshotValue } = makeFixture({ initialSeq: 5 })
    snapshotValue.conversations = [summary(1, 'race baseline')]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const frames: Array<{ event: string; data: unknown }> = []
    const reading = readAll(response, (text) => {
      for (const f of parseSse(text)) frames.push(f)
    })
    await waitFor(() => frames.length >= 1 && frames[0]?.event === 'snapshot')
    // snapshot.seq=5; publish seq=6 event, must appear in stream in.
    hub.publish('notification', { level: 'warning', title: 'race event' })
    await waitFor(() => frames.some((f) => f.event === 'notification'))
    controller.abort()
    await reading

    const snap = frames[0]?.data as HelmSnapshot
    assert.equal(snap.seq, 5)
    const eventFrames = frames.filter((f) => f.event !== 'snapshot') as Array<{
      event: string
      data: HelmEventFrame
    }>
    assert.equal(eventFrames.length, 1)
    assert.equal(eventFrames[0]?.data.seq, 6)
    assert.equal((eventFrames[0]?.data.event as { title?: string }).title, 'race event')
  })

  it('snapshot provider sync heavy publish: subscribe buffer phase overflow by explicit closure stream', { timeout: 60_000 }, async () => {
    // provider first time by invoke sync publish 600 event (>512 buffer cap).
    let reentrant = false
    const persisted: number[] = []
    const snapValue: HelmSnapshot = { bootId: 'test-boot', seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }
    const hub = new EventHub({
      initialSeq: 0,
      snapshot: () => {
        if (!reentrant) {
          reentrant = true
          for (let i = 0; i < 600; i++) hub.publish('notification', { level: 'info', title: `r${i}` })
        }
        return snapValue
      },
      persistSeq: (s) => persisted.push(s),
    })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    // read to stream end: overflow occur in snapshot return before, stream may zero frame i.e. closure (client reconnect take new snapshot).
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.ok(!text.includes('r599'), 'must not truncate resume (lose frame after disguise complete stream)')
    assert.equal(hub.subscriberCount, 0, 'buffer overflow after subscribe by explicit remove')
    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// redaction: snapshot and event
// ---------------------------------------------------------------------------

describe('EventHub redaction', { timeout: 60_000 }, () => {
  it('first frame snapshot recursion redaction:secret plaintext (contains field name) never appear', { timeout: 60_000 }, async () => {
    const { hub, snapshotValue } = makeFixture()
    hub.redactFn = (t) => t.replaceAll('sk-secret', '[REDACTED]')
    snapshotValue.conversations = [
      { ...summary(1, 'secret key conversation'), doing: 'upload sk-secret-token' },
    ]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    // not abort first read: server side not closure stream when readAll will suspended, reason use carries timeout finite read verify first frame.
    assert.ok(response.body)
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value ?? new Uint8Array())
    controller.abort()
    await reader.cancel().catch(() => {})
    assert.ok(!text.includes('sk-secret'), 'snapshot plaintext secret must redaction')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('publish event first string recursion redaction: carries quotes/newline payload do not leak', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    hub.redactFn = (t) => t.replaceAll('leak-me', '[REDACTED]')
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const frames: Array<{ event: string; data: unknown }> = []
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    const reading = readAll(response, (text) => {
      for (const f of parseSse(text)) frames.push(f)
      if (frames.length >= 2) resolveDone()
    })
    await waitFor(() => frames.length >= 1)
    hub.publish('custom.progress', {
      note: 'value with "quotes" and leak-me',
      multi: 'line1\nleak-me\nline3',
      nested: { deep: { key_leak_me: 'x' } },
    })
    await done
    controller.abort()
    await reading
    const frame = frames[1]?.data as { event: { type: string; payload: Record<string, unknown> } }
    assert.equal(frame.event.type, 'custom.progress')
    assert.ok(!JSON.stringify(frame).includes('leak-me'), 'event payload must not leak plaintext')
  })

  it('snapshot contains illegal JSON value (Date):currentSnapshot explicit throw HelmError not silently convert', { timeout: 60_000 }, () => {
    const { hub, snapshotValue } = makeFixture()
    snapshotValue.conversations = [
      { ...summary(1, 'x'), createdAt: new Date(0) as unknown as number },
    ]
    assert.throws(() => hub.currentSnapshot(), /invalid_json_value|非 JSON/)
  })
})

// ---------------------------------------------------------------------------
// publish ordinal when order and event shape
// ---------------------------------------------------------------------------

describe('EventHub.publish event shape', { timeout: 60_000 }, () => {
  it('group install failed do not push enter seq(mirror seq consistent), after success seq connect continue persist', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'a' })
    assert.equal(hub.seq, 1)
    assert.deepEqual(persistedSeqs, [1])
    assert.throws(() => hub.publish('conversation.deleted', { conversationId: 'NaN!' }))
    assert.equal(hub.seq, 1, 'failed do not push enter ordinal')
    assert.deepEqual(persistedSeqs, [1], 'failed do not persist ordinal')
    hub.publish('conversation.deleted', { conversationId: 7 })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('payload contains loop reference:publish explicit throws, not silently fall back', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const cyclic: Record<string, unknown> = { self: null }
    cyclic['self'] = cyclic
    assert.throws(() => hub.publish('custom.x', cyclic), /invalid_json_value|循环/)
    assert.equal(hub.seq, 0)
  })

  it('plugin.changed accept complete message seal {type,plugin,ui} and directly {plugin,ui} double shape; bare summary missing ui explicit reject', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const plugin = {
      id: 'builtin:herdr',
      name: 'Herdr',
      locked: true,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
    }
    const ui = [
      { pluginId: 'builtin:herdr', surface: 'sidebar.item', spec: { id: 's1', label: 'Herdr' } },
    ]
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    // complete message seal shape (PluginHost emitEvent now state:{type, plugin, ui}).
    hub.publish('plugin.changed', { type: 'plugin.changed', plugin, ui })
    // directly {plugin, ui} shape.
    hub.publish('plugin.changed', { plugin, ui })
    off()
    const e1 = frames[0]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    const e2 = frames[1]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    assert.equal(e1.type, 'plugin.changed')
    assert.equal(e1.plugin.id, 'builtin:herdr')
    assert.deepEqual(e1.ui, ui, 'message seal shape ui complete carry')
    assert.ok(!('type' in (e1.plugin as Record<string, unknown>)), 'message seal split package:plugin inside must not leftover type embed set')
    assert.equal(e2.type, 'plugin.changed')
    assert.equal(e2.plugin.id, 'builtin:herdr')
    assert.deepEqual(e2.ui, ui, 'direct pass shape ui complete carry')
    // old bare summary(missing ui) no longer accept: new contract without compatibility cushion piece.
    assert.throws(() => hub.publish('plugin.changed', plugin), /plugin\.changed|invalid_event/)
    // deactivate/unload:ui is empty array (client based on this clear the plugin contribution).
    hub.publish('plugin.changed', { plugin, ui: [] })
    const off2 = hub.subscribe(() => {})
    off2()
  })

  it('core other type same accept message seal/direct pass double shape', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const conv = summary(3, 'double shape')
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    hub.publish('conversation.upsert', conv)
    hub.publish('conversation.upsert', { type: 'conversation.upsert', conversation: conv })
    hub.publish('conversation.deleted', { conversationId: 9 })
    hub.publish('conversation.deleted', { type: 'conversation.deleted', conversationId: 10 })
    off()
    const events = frames.map((f) => f.event)
    const up1 = events[0] as { conversation: { id: number } }
    const up2 = events[1] as { conversation: { id: number } }
    assert.equal(up1.conversation.id, 3)
    assert.equal(up2.conversation.id, 3)
    const del1 = events[2] as { conversationId: number }
    const del2 = events[3] as { conversationId: number }
    assert.equal(del1.conversationId, 9)
    assert.equal(del2.conversationId, 10)
  })

  it('conversation.upsert illegal shape explicit reject and do not push enter seq(missing field/wrong type/optional field type do not symbol)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // non- object.
    assert.throws(() => hub.publish('conversation.upsert', 'not-a-summary'), /conversation\.upsert|invalid_event/)
    // missing core field (without title/status/updatedAt etc.).
    assert.throws(() => hub.publish('conversation.upsert', { id: 1, profileId: 'assistant' }), /conversation\.upsert/)
    // core field type wrong (status non- five state,id non- integer,tags mix non- string).
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), status: 'busy' as never }),
      /conversation\.upsert/,
    )
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), id: 1.5 }),
      /conversation\.upsert/,
    )
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), tags: ['a', 2 as never] }),
      /conversation\.upsert/,
    )
    // optional field store in but type wrong (can missing cannot wrong).
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), ownedBy: 'alien' as never }),
      /conversation\.upsert/,
    )
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), parentConversationId: '7' as never }),
      /conversation\.upsert/,
    )
    assert.throws(
      () => hub.publish('conversation.upsert', { ...summary(1, 'x'), doing: 42 as never }),
      /conversation\.upsert/,
    )
    // legal summary (contains optional field) do not subject to affect.
    hub.publish('conversation.upsert', {
      ...summary(4, 'ok'),
      ownedBy: 'bot',
      parentConversationId: 1,
      doing: 'bash: pnpm test',
    })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('ask.upsert illegal shape explicit reject and do not push enter seq(missing field/wrong state/field shape illegal)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    const baseAsk = {
      id: 'ask-1',
      conversationId: 3,
      title: 'deploy approval',
      fields: [{ name: 'approve', label: 'is otherwise batch allow', type: 'confirm' }],
      status: 'pending',
      createdAt: 1_000,
    }
    // non- object.
    assert.throws(() => hub.publish('ask.upsert', 'oops'), /ask\.upsert|invalid_event/)
    // missing core field.
    assert.throws(() => hub.publish('ask.upsert', { id: 'ask-1' }), /ask\.upsert/)
    // status non- four state.
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, status: 'expired' as never }), /ask\.upsert/)
    // id empty string / conversationId non- integer / fields empty array.
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, id: '' }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, conversationId: 3.5 }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, fields: [] }), /ask\.upsert/)
    // field shape illegal (type non- three choose one,select missing options).
    assert.throws(
      () => hub.publish('ask.upsert', { ...baseAsk, fields: [{ name: 'x', label: 'X', type: 'radio' as never }] }),
      /ask\.upsert/,
    )
    assert.throws(
      () => hub.publish('ask.upsert', {
        ...baseAsk,
        fields: [{ name: 'env', label: 'environment', type: 'select' as never }],
      }),
      /ask\.upsert/,
    )
    // optional field type wrong (expectedStateSeq non- integer).
    assert.throws(
      () => hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: '3' as never }),
      /ask\.upsert/,
    )
    assert.equal(hub.seq, 1, 'invalid input do not push enter seq')
    assert.deepEqual(persistedSeqs, [1])
    // legal AskSpec(contains optional field) do not subject to affect;answered terminal state same can publish.
    hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: 7, ownerPluginId: 'builtin:herdr' })
    hub.publish('ask.upsert', { ...baseAsk, id: 'ask-2', status: 'answered' as never })
    assert.equal(hub.seq, 3)
  })

  it('ask.upsert sync validate secret lifecycle, illegal metadata does not enter resume cache', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    const ask = { id: 'lifetime-ask', conversationId: 1, title: 'secret', status: 'pending', createdAt: 1 }
    for (const secretLifetime of [{ ttlMs: 0 }, { scope: 'unknown' }, { ttl: 100 }, new Date()]) {
      assert.throws(() => hub.publish('ask.upsert', {
        ...ask,
        fields: [{ name: 'TOKEN', label: 'Token', type: 'text', secret: true, secretLifetime }],
      }), /secretLifetime|非 JSON/)
    }
    assert.throws(() => hub.publish('ask.upsert', {
      ...ask,
      fields: [{ name: 'plain', label: 'Plain', type: 'text', secretLifetime: { scope: 'turn' } }],
    }), /secretLifetime/)
    assert.equal(hub.seq, 0)
    assert.deepEqual(persistedSeqs, [])
    let seen: unknown
    const unsubscribe = hub.subscribe((frame) => { seen = frame.event })
    const fields = [{ name: 'TOKEN', label: 'Token', type: 'text', secret: true, secretLifetime: { ttlMs: 100, scope: 'turn' } }]
    hub.publish('ask.upsert', { ...ask, fields })
    assert.deepEqual(seen, { type: 'ask.upsert', ask: { ...ask, fields } })
    unsubscribe()
    hub.close()
  })

  it('notification illegal payload explicit reject and do not push enter seq(not silently fix correct level/title)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // illegal level: no longer static default fold back 'info'.
    assert.throws(() => hub.publish('notification', { level: 'fatal', title: 'x' }), /notification|invalid_event/)
    assert.throws(() => hub.publish('notification', { title: 'missing level' }), /notification/)
    // illegal title: no longer static default replace is 'notification'.
    assert.throws(() => hub.publish('notification', { level: 'info' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: '' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: 42 as never }), /notification/)
    // body store in but non- string.
    assert.throws(() => hub.publish('notification', { level: 'info', title: 'x', body: 1 as never }), /notification/)
    // conversationId store in but non- integer.
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: 1.5 }),
      /notification/,
    )
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: '3' as never }),
      /notification/,
    )
    assert.equal(hub.seq, 1, 'invalid input do not push enter seq')
    assert.deepEqual(persistedSeqs, [1], 'invalid input do not persist ordinal')
    // legal payload (optional field omit/carry) do not subject to affect.
    hub.publish('notification', { level: 'warning', title: 'only title' })
    hub.publish('notification', { level: 'error', title: 'all field', body: 'detail situation', conversationId: 9 })
    assert.equal(hub.seq, 3)
    assert.deepEqual(persistedSeqs, [1, 2, 3])
  })

  it('node.changed accept message seal/direct pass double shape, keep complete NodeInfo field;removed pass-through', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    const node = {
      id: 'gpu-box',
      kind: 'byom',
      online: true,
      hostname: 'gpu',
      platform: 'linux',
      connectedAt: 1_000,
      lastSeenAt: 2_000,
      hubUrl: 'http://127.0.0.1:3202',
      health: {
        collectedAt: 1_999,
        uptimeSec: 42,
        loadAvg: [0.1, 0.2, 0.3] as [number, number, number],
        memFreeBytes: 1,
        memTotalBytes: 2,
        diskFreeBytes: 3,
        diskTotalBytes: 4,
      },
    }
    // complete message seal shape (KernelRuntime now state:{type, node}).
    hub.publish('node.changed', { type: 'node.changed', node })
    // directly {node} shape (without message seal type).
    hub.publish('node.changed', { node: { ...node, online: false, lastSeenAt: 3_000 } })
    // removed: true(removeNode unify publish).
    hub.publish('node.changed', { type: 'node.changed', node: { id: 'gpu-box', kind: 'byom', online: false }, removed: true })
    off()
    assert.equal(frames.length, 3)
    const e1 = frames[0]?.event
    assert.ok(e1 && 'node' in e1)
    assert.equal(e1.type, 'node.changed')
    assert.equal(e1.node.id, 'gpu-box')
    assert.equal(e1.node.kind, 'byom')
    assert.equal(e1.node.online, true)
    assert.equal(e1.node.hostname, 'gpu')
    assert.equal(e1.node.health?.diskTotalBytes, 4, 'complete real NodeInfo field keep (contains health)')
    assert.equal('removed' in e1, false, 'without removed field when does not carry')
    const e2 = frames[1]?.event
    assert.ok(e2 && 'node' in e2)
    assert.equal(e2.node.online, false)
    assert.equal(e2.node.lastSeenAt, 3_000)
    const e3 = frames[2]?.event
    assert.ok(e3 && 'node' in e3)
    assert.equal(e3.node.id, 'gpu-box')
    assert.equal(e3.removed, true, 'removed: true pass-through (Web based on this from list remove)')
    // event shape satisfy Web applyEventFrame  'node' in event decide (no longer fall Custom payload embed set).
    assert.ok(!('payload' in e1), 'must not fall CustomHelmEvent payload embed set')
  })

  it('node.changed invalid input explicit reject and do not push enter seq', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // missing node.
    assert.throws(() => hub.publish('node.changed', { type: 'node.changed' }), /node\.changed|invalid_event/)
    // node missing id / id non- string / empty string.
    assert.throws(() => hub.publish('node.changed', { node: { kind: 'byom', online: true } }), /node\.changed/)
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 42 as unknown as string, kind: 'byom', online: true } }),
      /node\.changed/,
    )
    assert.throws(() => hub.publish('node.changed', { node: { id: '', kind: 'byom', online: true } }), /node\.changed/)
    // illegal kind.
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'ssh' as never, online: true } }),
      /node\.changed/,
    )
    // online non- boolean.
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: 'yes' as never } }),
      /node\.changed/,
    )
    // removed non- boolean(if store in).
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: false }, removed: 'true' as never }),
      /removed/,
    )
    // node non- object.
    assert.throws(() => hub.publish('node.changed', 'gpu-box'), /node\.changed/)
    // all failed do not push enter seq, do not persist.
    assert.equal(hub.seq, 1, 'invalid input do not push enter seq')
    assert.deepEqual(persistedSeqs, [1], 'invalid input do not persist ordinal')
    // legal publish restore normal.
    hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: true } })
    assert.equal(hub.seq, 2)
  })

  it('unknown type pass-through CustomHelmEvent {type,payload}, does not pretend to be into notification', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    hub.publish('workflow.progress', { step: 3, detail: { done: true } })
    hub.publish('herdr.pane.update', 'pane-2 additional information')
    hub.publish('notification', { level: 'error', title: 't' })
    off()
    assert.equal(frames.length, 3)
    const e1 = frames[0]?.event as { type: string; payload: unknown }
    assert.equal(e1.type, 'workflow.progress')
    assert.deepEqual(e1.payload, { step: 3, detail: { done: true } })
    const e2 = frames[1]?.event as { type: string; payload: unknown }
    assert.equal(e2.type, 'herdr.pane.update')
    assert.equal(e2.payload, 'pane-2 additional information')
    // six core type keep strong contract: does not enter Custom branch.
    const core = frames[2]?.event as { type: string; title?: string; payload?: unknown }
    assert.equal(core.type, 'notification')
    assert.equal(core.title, 't')
    assert.equal(core.payload, undefined, 'notification does not carry payload field')
  })

  it('subscribe call back throws only isolated the subscribe, does not affect other subscribe', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const good: HelmEventFrame[] = []
    const bad = (): void => {
      throw new Error('consumer boom')
    }
    hub.subscribe(bad)
    hub.subscribe((f) => good.push(f))
    assert.doesNotThrow(() => hub.publish('notification', { level: 'info', title: 'isolated' }))
    assert.equal(good.length, 1)
    assert.equal((good[0]?.event as { title?: string }).title, 'isolated')
  })
})

// ---------------------------------------------------------------------------
// sseStream: can edit process consume (contains unsubscribe)
// ---------------------------------------------------------------------------

describe('EventHub.sseStream can edit process consume', { timeout: 60_000 }, () => {
  it('return unsubscribe handle; consume return false i.e. unsubscribe; unsubscribe after publish no longer delivery', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: SseFrame[] = []
    const sub = hub.sseStream((frame) => {
      frames.push(frame)
      return frames.length < 2 // second frame after return false
    })
    assert.equal(hub.subscriberCount, 1)
    hub.publish('notification', { level: 'info', title: 'one' })
    hub.publish('notification', { level: 'info', title: 'two' })
    assert.equal(hub.subscriberCount, 0, 'return false after automatically unsubscribe')
    hub.publish('notification', { level: 'info', title: 'three' })
    assert.equal(frames.length, 2)
    sub.unsubscribe() // idempotent
    assert.equal(hub.subscriberCount, 0)
  })

  it('consumer throws: unsubscribe clean up and exception do not escape to publish', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const other: HelmEventFrame[] = []
    hub.subscribe((f) => other.push(f))
    hub.sseStream(() => {
      throw new Error('boom')
    })
    hub.publish('notification', { level: 'info', title: 'after' })
    assert.equal(hub.subscriberCount, 1, 'throws subscribe by clean up, only remain normal subscribe')
    assert.equal(other.length, 1)
  })

  it('sseStream inside snapshot after conflict refresh buffer frame (without lose frame,seq strictly greater than snapshot)', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ initialSeq: 2 })
    const frames: SseFrame[] = []
    // subscribe call back in publish (snapshot just take set, conflict refresh before via classic race).
    const sub = hub.sseStream((frame) => {
      frames.push(frame)
      if (frames.length === 1) {
        queueMicrotask(() => hub.publish('notification', { level: 'info', title: 'race incremental' }))
      }
      return true
    })
    await new Promise((r) => setTimeout(r, 50))
    sub.unsubscribe()
    const snap = frames[0] as HelmSnapshot
    assert.equal(snap.seq, 2)
    const events = frames.slice(1) as HelmEventFrame[]
    assert.ok(events.length >= 1)
    assert.ok(events.every((f) => f.seq > snap.seq))
  })
})

// ---------------------------------------------------------------------------
// idle heartbeat (keepalive): proxy/middle layer keep-alive + client card die detect based on
// ---------------------------------------------------------------------------

describe('EventHub SSE idle heartbeat', { timeout: 60_000 }, () => {
  it('idle connect cycle receives : keepalive note release row: does not carry event/data, do not fabricate business event, do not push enter seq', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    assert.match(decoder.decode(first.value ?? new Uint8Array()), /event: snapshot/)

    // under a chunk should is heartbeat note release row (: open head, without event:/data:, parse do not out any frame).
    const beat = await readWithDeadline(reader)
    const beatText = decoder.decode(beat.value ?? new Uint8Array())
    assert.ok(beatText.startsWith(':'), `heartbeat should is SSE note release row, actual: ${beatText}`)
    assert.ok(!beatText.includes('event:') && !beatText.includes('data:'), 'heartbeat must not fabricate business event')
    // real client SseParser skip : open head note release row (live-state.test.ts already lock):
    // heartbeat text parse do not out any carry data frame.
    assert.ok(parseSse(beatText).every((frame) => frame.data === null), 'heartbeat must not carry data frame')
    assert.equal(hub.seq, 0, 'heartbeat do not push enter event ordinal')

    // heartbeat do not interference business event: publish after event frame per common reach.
    hub.publish('notification', { level: 'info', title: 'heartbeat between event' })
    const eventChunk = await readWithDeadline(reader)
    assert.match(decoder.decode(eventChunk.value ?? new Uint8Array()), /event: notification/)
    controller.abort()
    await reader.cancel().catch(() => {})
  })

  it('abort after heartbeat timer follow shutdown clean up: unsubscribe closure stream, without after continue byte (process do not because leak leak timer suspended)', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort after immediately unsubscribe')

    // server side already closure stream: exhausted already queue byte after read to done.
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    // wait for multiple heartbeat cycle: leak leak interval will keep event loop store make set piece cannot exit
    // (this set piece can normal end i.e. question connect verify timer already clean up), and will not again write any byte.
    await new Promise((r) => setTimeout(r, 100))
    const after = await reader.read()
    assert.ok(after.done, 'closure stream after no longer has heartbeat byte')
  })

  it('ReadableStream.cancel same clean up heartbeat timer(client actively disconnect)', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel after immediately unsubscribe')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(hub.subscriberCount, 0)
    controller.abort()
  })

  it('heartbeat subject to byte back press has boundary constraint: do not read slow consumer heap accumulate over limit by explicit closure stream', { timeout: 60_000 }, async () => {
    // pre- compute 320B: first frame snapshot(contains bootId, about 150B) can via; single heartbeat about 14B,
    // heap accumulate 20 remaining time i.e. over limit (keepaliveMs=5 under about hundred remaining milli second inside trigger).
    const { hub } = makeFixture({ keepaliveMs: 5, maxPendingBytes: 320 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value ?? new Uint8Array()), /event: snapshot/)
    // no longer read: heartbeat byte continuous heap accumulate, over limit i.e. slow client explicit closure stream (never full warehouse unbounded queue up).
    await waitFor(() => hub.subscriberCount === 0)
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    controller.abort()
  })

  it('keepaliveMs non- correct value deactivate heartbeat: idle stream no longer write any byte', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 0 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    // wait for start a by default heartbeat cycle still without any write (read continuous pending, use short Deadline reverse verify).
    await new Promise((r) => setTimeout(r, 60))
    const pending = reader.read()
    const won = await Promise.race([pending.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 80))])
    assert.equal(won, false, 'deactivate heartbeat after idle stream must not again has byte reach')
    controller.abort()
    await reader.cancel().catch(() => {})
  })
})
