/**
 * EventHub real HTTP integration tests using actual Response.body readers + AbortController.
 *
 * Covers: SSE initial snapshot / incremental frame protocol, abort & reader.cancel unsubscription, close() cleanup,
 * slow-consumer byte backpressure stream closing, race-free snapshot/subscribe ordering, snapshot redaction,
 * monotonic sequence assignment, dual envelope/unwrapped event shapes, CustomHelmEvent passthrough,
 * strict rejection of invalid payloads, and field-level validation of conversation.upsert / ask.upsert / notification
 * using in-memory fixtures (no fake models/stores; persistSeq captured via callback).
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ConversationSummary, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { EventHub, type SseFrame, type SnapshotProvider } from '../src/runtime/events.js'
import { makeConversationSummary, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixture
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

/** Parse SSE text chunks into { event, data } frames. */
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

/** Drain response stream until EOF; invokes optional callback per chunk. */
async function readAll(
  response: Response,
  onChunk?: (text: string) => void,
): Promise<string> {
  assert.ok(response.body !== null, 'SSE response must have a body stream')
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

/** Bounded single read with deadline so missed heartbeats fail promptly instead of stalling tests. */
async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 2000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`read timed out (${ms}ms): heartbeat did not arrive`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// response(): real HTTP SSE semantics
// ---------------------------------------------------------------------------

describe('EventHub.response SSE protocol', { timeout: 60_000 }, () => {
  it('emits event:snapshot carrying HelmSnapshot first, then incremental event:<type> carrying {seq, event}', { timeout: 60_000 }, async () => {
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

  it('Request.signal abort unsubscribes and closes stream; reconnect aligns via new snapshot', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.equal(hub.subscriberCount, 1)
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort must unsubscribe immediately')
    const text = await readAll(response, () => {})
    assert.match(text, /event: snapshot/, 'initial frame written before close remains readable')
    // Events published after abort must not reach closed stream.
    hub.publish('notification', { level: 'info', title: 'after' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('ReadableStream.cancel unsubscribes identically on client disconnect', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.ok(first.done !== true)
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel must unsubscribe immediately')
    hub.publish('notification', { level: 'info', title: 'after cancel' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('close() clears all active subscribers on kernel shutdown', { timeout: 60_000 }, async () => {
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

  it('keeps stream open when idle without falling back to JSON/204, delivering late incremental events', { timeout: 60_000 }, async () => {
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
    // Simulate delayed event arrival after idle connection.
    setTimeout(() => hub.publish('conversation.upsert', summary(2, 'delayed conversation')), 30)
    await frameCame
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// Backpressure: slow consumer
// ---------------------------------------------------------------------------

describe('EventHub slow-consumer backpressure', { timeout: 60_000 }, () => {
  it('exceeding buffered bytes during streaming explicitly closes stream rather than dropping frames silently', { timeout: 60_000 }, async () => {
    // 1 KiB cap: single frame ~100+ bytes, triggers within a few unread frames.
    const { hub } = makeFixture({ maxPendingBytes: 1024 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // Read only the initial snapshot chunk, then stall reads to build backpressure.
    const first = await reader.read()
    assert.ok(first.value)
    text += decoder.decode(first.value, { stream: true })
    assert.match(text, /event: snapshot/)

    for (let i = 0; i < 64; i++) {
      hub.publish('notification', { level: 'info', title: `n${i}`, body: 'x'.repeat(64) })
      if (hub.subscriberCount === 0) break
    }
    assert.equal(hub.subscriberCount, 0, 'subscriber should be evicted once pending bytes exceed limit')
    // Stream closed server-side; buffered chunks drain to EOF and no subsequent events arrive.
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    hub.publish('notification', { level: 'info', title: 'must not arrive after stream close' })
    const after = await reader.read()
    assert.ok(after.done, 'closed stream must not deliver further frames')
    controller.abort()
  })

  it('normal consumer reading chunk by chunk never trips backpressure', { timeout: 60_000 }, async () => {
    // 16 KiB budget easily covers individual frames, though synchronous bursts queue before async reads;
    // interleaving publish/wait verifies normal consumers stay subscribed.
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
    assert.equal(hub.subscriberCount, 1, 'consumer reading chunk by chunk stays subscribed')
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// Snapshot race: subscribe before taking snapshot so no frames are lost
// ---------------------------------------------------------------------------

describe('EventHub snapshot race', { timeout: 60_000 }, () => {
  it('events published right after taking snapshot (higher seq) arrive without loss or duplication', { timeout: 60_000 }, async () => {
    // initialSeq matches snapshot.seq=5; subsequent seq=6 event must arrive in stream.
    const { hub, snapshotValue } = makeFixture({ initialSeq: 5 })
    snapshotValue.conversations = [summary(1, 'race baseline')]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const frames: Array<{ event: string; data: unknown }> = []
    const reading = readAll(response, (text) => {
      for (const f of parseSse(text)) frames.push(f)
    })
    await waitFor(() => frames.length >= 1 && frames[0]?.event === 'snapshot')
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

  it('re-entrant publishing during snapshot() overflowing buffer closes stream explicitly', { timeout: 60_000 }, async () => {
    // Provider publishes 600 events synchronously during first call (>512 buffer cap).
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
    // Read to EOF: overflow before snapshot return closes stream cleanly (client fetches fresh snapshot).
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.ok(!text.includes('r599'), 'must never silently truncate buffer and masquerade as complete stream')
    assert.equal(hub.subscriberCount, 0, 'subscriber evicted after buffer overflow')
    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// Redaction: snapshots and events
// ---------------------------------------------------------------------------

describe('EventHub redaction', { timeout: 60_000 }, () => {
  it('recursively redacts initial snapshot fields: secret plaintext never appears', { timeout: 60_000 }, async () => {
    const { hub, snapshotValue } = makeFixture()
    hub.redactFn = (t) => t.replaceAll('sk-secret', '[REDACTED]')
    snapshotValue.conversations = [
      { ...summary(1, 'secret conversation'), doing: 'uploading sk-secret-token' },
    ]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    // Read single initial snapshot chunk instead of readAll (unclosed SSE stream keeps readAll pending).
    assert.ok(response.body)
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value ?? new Uint8Array())
    controller.abort()
    await reader.cancel().catch(() => {})
    assert.ok(!text.includes('sk-secret'), 'plaintext secret in snapshot must be redacted')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('recursively redacts published event string payloads before JSON serialization (safe with quotes/newlines)', { timeout: 60_000 }, async () => {
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
    assert.ok(!JSON.stringify(frame).includes('leak-me'), 'event payload must not leak plaintext secrets')
  })

  it('snapshot containing non-JSON value (Date) throws HelmError explicitly in currentSnapshot', { timeout: 60_000 }, () => {
    const { hub, snapshotValue } = makeFixture()
    snapshotValue.conversations = [
      { ...summary(1, 'x'), createdAt: new Date(0) as unknown as number },
    ]
    assert.throws(() => hub.currentSnapshot(), /non-JSON objects/)
  })
})

// ---------------------------------------------------------------------------
// Monotonic sequence assignment and event shapes
// ---------------------------------------------------------------------------

describe('EventHub.publish event shapes', { timeout: 60_000 }, () => {
  it('failed validation does not advance seq (no seq gaps); subsequent valid events stay contiguous', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'a' })
    assert.equal(hub.seq, 1)
    assert.deepEqual(persistedSeqs, [1])
    assert.throws(() => hub.publish('conversation.deleted', { conversationId: 'NaN!' }))
    assert.equal(hub.seq, 1, 'failure must not advance memory seq')
    assert.deepEqual(persistedSeqs, [1], 'failure must not persist seq')
    hub.publish('conversation.deleted', { conversationId: 7 })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('cyclic references in payload throw explicitly without silent fallback', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const cyclic: Record<string, unknown> = { self: null }
    cyclic['self'] = cyclic
    assert.throws(() => hub.publish('custom.x', cyclic), /free of cycles/)
    assert.equal(hub.seq, 0)
  })

  it('plugin.changed accepts both enveloped {type,plugin,ui} and unwrapped {plugin,ui}; rejects bare summary missing ui', { timeout: 60_000 }, () => {
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
    // Enveloped form (matching PluginHost emitEvent: {type, plugin, ui}).
    hub.publish('plugin.changed', { type: 'plugin.changed', plugin, ui })
    // Direct unwrapped {plugin, ui} form.
    hub.publish('plugin.changed', { plugin, ui })
    off()
    const e1 = frames[0]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    const e2 = frames[1]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    assert.equal(e1.type, 'plugin.changed')
    assert.equal(e1.plugin.id, 'builtin:herdr')
    assert.deepEqual(e1.ui, ui, 'enveloped form preserves ui list')
    assert.ok(!('type' in (e1.plugin as Record<string, unknown>)), 'envelope must not nest extra type under plugin')
    assert.equal(e2.type, 'plugin.changed')
    assert.equal(e2.plugin.id, 'builtin:herdr')
    assert.deepEqual(e2.ui, ui, 'direct form preserves ui list')
    // Legacy bare summary missing ui is rejected (no compatibility shims).
    assert.throws(() => hub.publish('plugin.changed', plugin), /plugin\.changed|invalid_event/)
    // Unload/disable emits empty ui list (client clears contributions for that plugin).
    hub.publish('plugin.changed', { plugin, ui: [] })
    const off2 = hub.subscribe(() => {})
    off2()
  })

  it('other core event types accept both enveloped and unwrapped shapes', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const conv = summary(3, 'dual shape')
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

  it('conversation.upsert rejects invalid shapes without advancing seq (missing fields / wrong types / wrong optional field types)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    assert.throws(() => hub.publish('conversation.upsert', 'not-a-summary'), /conversation\.upsert|invalid_event/)
    assert.throws(() => hub.publish('conversation.upsert', { id: 1, profileId: 'assistant' }), /conversation\.upsert/)
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
    // Valid summary with optional fields passes unaffected.
    hub.publish('conversation.upsert', {
      ...summary(4, 'ok'),
      ownedBy: 'bot',
      parentConversationId: 1,
      doing: 'bash: pnpm test',
    })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('ask.upsert rejects invalid shapes without advancing seq (missing fields / invalid status / invalid field shapes)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    const baseAsk = {
      id: 'ask-1',
      conversationId: 3,
      title: 'deploy approval',
      fields: [{ name: 'approve', label: 'allow deployment', type: 'confirm' }],
      status: 'pending',
      createdAt: 1_000,
    }
    assert.throws(() => hub.publish('ask.upsert', 'oops'), /ask\.upsert|invalid_event/)
    assert.throws(() => hub.publish('ask.upsert', { id: 'ask-1' }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, status: 'expired' as never }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, id: '' }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, conversationId: 3.5 }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, fields: [] }), /ask\.upsert/)
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
    assert.throws(
      () => hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: '3' as never }),
      /ask\.upsert/,
    )
    assert.equal(hub.seq, 1, 'invalid input must not advance seq')
    assert.deepEqual(persistedSeqs, [1])
    hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: 7, ownerPluginId: 'builtin:herdr' })
    hub.publish('ask.upsert', { ...baseAsk, id: 'ask-2', status: 'answered' as never })
    assert.equal(hub.seq, 3)
  })

  it('ask.upsert validates secretLifetime consistently; invalid metadata never enters resume ring', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    const ask = { id: 'lifetime-ask', conversationId: 1, title: 'secret', status: 'pending', createdAt: 1 }
    for (const secretLifetime of [{ ttlMs: 0 }, { scope: 'unknown' }, { ttl: 100 }, new Date()]) {
      assert.throws(() => hub.publish('ask.upsert', {
        ...ask,
        fields: [{ name: 'TOKEN', label: 'Token', type: 'text', secret: true, secretLifetime }],
      }), /secretLifetime|non-JSON objects/)
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

  it('notification rejects invalid payloads without advancing seq (never coerces level/title)', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    assert.throws(() => hub.publish('notification', { level: 'fatal', title: 'x' }), /notification|invalid_event/)
    assert.throws(() => hub.publish('notification', { title: 'missing level' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: '' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: 42 as never }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: 'x', body: 1 as never }), /notification/)
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: 1.5 }),
      /notification/,
    )
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: '3' as never }),
      /notification/,
    )
    assert.equal(hub.seq, 1, 'invalid input must not advance seq')
    assert.deepEqual(persistedSeqs, [1], 'invalid input must not persist seq')
    hub.publish('notification', { level: 'warning', title: 'only title' })
    hub.publish('notification', { level: 'error', title: 'full fields', body: 'details', conversationId: 9 })
    assert.equal(hub.seq, 3)
    assert.deepEqual(persistedSeqs, [1, 2, 3])
  })

  it('node.changed accepts enveloped and unwrapped shapes, preserving complete NodeInfo including health and removed', { timeout: 60_000 }, () => {
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
    // Enveloped form (KernelRuntime form: {type, node}).
    hub.publish('node.changed', { type: 'node.changed', node })
    // Direct {node} form without envelope type.
    hub.publish('node.changed', { node: { ...node, online: false, lastSeenAt: 3_000 } })
    // removed: true (published by removeNode).
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
    assert.equal(e1.node.health?.diskTotalBytes, 4, 'full NodeInfo including health is preserved')
    assert.equal('removed' in e1, false, 'omits removed when unset')
    const e2 = frames[1]?.event
    assert.ok(e2 && 'node' in e2)
    assert.equal(e2.node.online, false)
    assert.equal(e2.node.lastSeenAt, 3_000)
    const e3 = frames[2]?.event
    assert.ok(e3 && 'node' in e3)
    assert.equal(e3.node.id, 'gpu-box')
    assert.equal(e3.removed, true, 'removed: true passes through for Web list removal')
    assert.ok(!('payload' in e1), 'must not fall into CustomHelmEvent payload wrapper')
  })

  it('node.changed rejects invalid inputs without advancing seq', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    assert.throws(() => hub.publish('node.changed', { type: 'node.changed' }), /node\.changed|invalid_event/)
    assert.throws(() => hub.publish('node.changed', { node: { kind: 'byom', online: true } }), /node\.changed/)
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 42 as unknown as string, kind: 'byom', online: true } }),
      /node\.changed/,
    )
    assert.throws(() => hub.publish('node.changed', { node: { id: '', kind: 'byom', online: true } }), /node\.changed/)
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'ssh' as never, online: true } }),
      /node\.changed/,
    )
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: 'yes' as never } }),
      /node\.changed/,
    )
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: false }, removed: 'true' as never }),
      /removed/,
    )
    assert.throws(() => hub.publish('node.changed', 'gpu-box'), /node\.changed/)
    assert.equal(hub.seq, 1, 'invalid input must not advance seq')
    assert.deepEqual(persistedSeqs, [1], 'invalid input must not persist seq')
    hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: true } })
    assert.equal(hub.seq, 2)
  })

  it('unknown event types pass through as CustomHelmEvent {type, payload} without posing as notifications', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    hub.publish('workflow.progress', { step: 3, detail: { done: true } })
    hub.publish('herdr.pane.update', 'pane-2 info')
    hub.publish('notification', { level: 'error', title: 't' })
    off()
    assert.equal(frames.length, 3)
    const e1 = frames[0]?.event as { type: string; payload: unknown }
    assert.equal(e1.type, 'workflow.progress')
    assert.deepEqual(e1.payload, { step: 3, detail: { done: true } })
    const e2 = frames[1]?.event as { type: string; payload: unknown }
    assert.equal(e2.type, 'herdr.pane.update')
    assert.equal(e2.payload, 'pane-2 info')
    const core = frames[2]?.event as { type: string; title?: string; payload?: unknown }
    assert.equal(core.type, 'notification')
    assert.equal(core.title, 't')
    assert.equal(core.payload, undefined, 'notification does not carry payload field')
  })

  it('subscriber callback exception isolates failing subscriber without affecting peers', { timeout: 60_000 }, () => {
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
// sseStream: programmatic consumer (including unsubscribe)
// ---------------------------------------------------------------------------

describe('EventHub.sseStream programmatic consumer', { timeout: 60_000 }, () => {
  it('returns unsubscribe handle; returning false unsubscribes and halts delivery', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: SseFrame[] = []
    const sub = hub.sseStream((frame) => {
      frames.push(frame)
      return frames.length < 2 // return false after second frame
    })
    assert.equal(hub.subscriberCount, 1)
    hub.publish('notification', { level: 'info', title: 'one' })
    hub.publish('notification', { level: 'info', title: 'two' })
    assert.equal(hub.subscriberCount, 0, 'returning false auto-unsubscribes')
    hub.publish('notification', { level: 'info', title: 'three' })
    assert.equal(frames.length, 2)
    sub.unsubscribe() // idempotent
    assert.equal(hub.subscriberCount, 0)
  })

  it('consumer exception cleans up subscription without escaping publish()', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const other: HelmEventFrame[] = []
    hub.subscribe((f) => other.push(f))
    hub.sseStream(() => {
      throw new Error('boom')
    })
    hub.publish('notification', { level: 'info', title: 'after' })
    assert.equal(hub.subscriberCount, 1, 'throwing subscriber evicted, leaving healthy subscriber')
    assert.equal(other.length, 1)
  })

  it('sseStream buffers frames published during snapshot callback without drops and seq > snapshot.seq', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ initialSeq: 2 })
    const frames: SseFrame[] = []
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
// Idle heartbeat (keepalive)
// ---------------------------------------------------------------------------

describe('EventHub SSE idle heartbeat', { timeout: 60_000 }, () => {
  it('emits periodic : keepalive comment lines without event/data, business events, or advancing seq', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    assert.match(decoder.decode(first.value ?? new Uint8Array()), /event: snapshot/)

    // Next chunk is a heartbeat comment line (`:` prefix, no event:/data:, parses with null data).
    const beat = await readWithDeadline(reader)
    const beatText = decoder.decode(beat.value ?? new Uint8Array())
    assert.ok(beatText.startsWith(':'), `heartbeat must be an SSE comment line, got: ${beatText}`)
    assert.ok(!beatText.includes('event:') && !beatText.includes('data:'), 'heartbeat must not fabricate business events')
    assert.ok(parseSse(beatText).every((frame) => frame.data === null), 'heartbeat must emit zero data frames')
    assert.equal(hub.seq, 0, 'heartbeat must not advance event sequence')

    // Heartbeat does not disrupt real events.
    hub.publish('notification', { level: 'info', title: 'post-heartbeat event' })
    const eventChunk = await readWithDeadline(reader)
    assert.match(decoder.decode(eventChunk.value ?? new Uint8Array()), /event: notification/)
    controller.abort()
    await reader.cancel().catch(() => {})
  })

  it('clears heartbeat timer on abort: unsubscribes, closes stream, stops writing, avoids dangling timers', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort unsubscribes immediately')

    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    await new Promise((r) => setTimeout(r, 100))
    const after = await reader.read()
    assert.ok(after.done, 'no heartbeat bytes arrive after stream closes')
  })

  it('ReadableStream.cancel cleans up heartbeat timer on client disconnect', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel unsubscribes immediately')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(hub.subscriberCount, 0)
    controller.abort()
  })

  it('heartbeat accumulation obeys byte backpressure cap and closes slow unread consumers', { timeout: 60_000 }, async () => {
    // 320B budget allows initial ~150B snapshot; ~14B heartbeats trip limit within ~20 ticks.
    const { hub } = makeFixture({ keepaliveMs: 5, maxPendingBytes: 320 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value ?? new Uint8Array()), /event: snapshot/)
    await waitFor(() => hub.subscriberCount === 0)
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    controller.abort()
  })

  it('non-positive keepaliveMs disables heartbeats: idle stream emits zero extra bytes', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 0 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    await new Promise((r) => setTimeout(r, 60))
    const pending = reader.read()
    const won = await Promise.race([pending.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 80))])
    assert.equal(won, false, 'idle stream with keepalive disabled must emit zero bytes')
    controller.abort()
    await reader.cancel().catch(() => {})
  })
})
