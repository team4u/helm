/**
 * EventHub short-disconnect resume (?afterSeq+?bootId / ring buffer / resumed control frame) tests.
 *
 * Covers:
 * - Zero-event same-process resume (afterSeq == headSeq, including non-zero initialSeq) and gapless 5-frame catch-up
 *   (including frames published after response() creation before stream reads drain);
 * - Cross-instance equal seq forces snapshot (different bootId never resumes even if new ring happens to match);
 * - Ring eviction by count/bytes and oversized single-frame budget (clearing ring prevents skipping missed frames while letting later frames resume);
 * - Future seq falls back to snapshot; malformed query params return explicit 400;
 * - Step-by-step pull-based replay backpressure (replays exceeding maxPendingBytes still succeed for active readers, while unread stalled streams close cleanly);
 * - Abort/cancel cleans up subscriptions with zero leaks; snapshot injects current bootId.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  HelmxError,
  type ConversationSummary,
  type HelmxEventFrame,
  type HelmxResumedFrame,
  type HelmxSnapshot,
} from '@helmx/protocol'
import { EventHub, type HostDispatchedEvent } from '../src/runtime/events.js'
import { waitFor } from './helpers.js'

interface HubFixture {
  hub: EventHub
  persisted: number[]
}

function makeHub(opts?: {
  bootId?: string
  initialSeq?: number
  maxPendingBytes?: number
  ringMaxFrames?: number
  ringMaxBytes?: number
  keepaliveMs?: number
  /** Override persistSeq (e.g., inject throw); defaults to appending to fixture.persisted. */
  persistSeq?: (seq: number) => void
}): HubFixture {
  const persisted: number[] = []
  const hub = new EventHub({
    initialSeq: opts?.initialSeq ?? 0,
    bootId: opts?.bootId,
    snapshot: () => ({ seq: opts?.initialSeq ?? 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }),
    persistSeq: opts?.persistSeq ?? ((seq) => persisted.push(seq)),
    ...(opts?.maxPendingBytes !== undefined ? { maxPendingBytes: opts.maxPendingBytes } : {}),
    ...(opts?.ringMaxFrames !== undefined ? { ringMaxFrames: opts.ringMaxFrames } : {}),
    ...(opts?.ringMaxBytes !== undefined ? { ringMaxBytes: opts.ringMaxBytes } : {}),
    ...(opts?.keepaliveMs !== undefined ? { keepaliveMs: opts.keepaliveMs } : {}),
  })
  return { hub, persisted }
}

function eventsUrl(afterSeq: number, bootId: string): string {
  return `http://x/api/events?afterSeq=${afterSeq}&bootId=${encodeURIComponent(bootId)}`
}

/** Parse SSE payload chunks into { event, data } frames (skipping comment keepalive lines). */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = []
  for (const block of text.split('\n\n')) {
    if (block.trim() === '' || block.trimStart().startsWith(':')) continue
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

/** Open SSE stream and accumulate parsed frames; await reading termination on abort(). */
function connect(hub: EventHub, url: string): {
  response: Response
  frames: Array<{ event: string; data: unknown }>
  abort: () => Promise<void>
} {
  const controller = new AbortController()
  const response = hub.response(new Request(url, { signal: controller.signal }))
  const frames: Array<{ event: string; data: unknown }> = []
  const reading = (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let all = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      all += decoder.decode(value, { stream: true })
      frames.length = 0
      for (const frame of parseSse(all)) frames.push(frame)
    }
  })()
  return {
    response,
    frames,
    abort: async () => {
      controller.abort()
      await reading.catch(() => {})
    },
  }
}

function publishNotes(hub: EventHub, count: number, opts?: { bodyLength?: number; startTitle?: number }): void {
  const start = opts?.startTitle ?? 1
  for (let i = 0; i < count; i++) {
    hub.publish('notification', {
      level: 'info',
      title: `n${start + i}`,
      ...(opts?.bodyLength !== undefined ? { body: 'x'.repeat(opts.bodyLength) } : {}),
    })
  }
}

// ---------------------------------------------------------------------------
// Same-process resume: zero-event catch-up and multi-frame replay
// ---------------------------------------------------------------------------

describe('EventHub resume: same-process catch-up', { timeout: 60_000 }, () => {
  it('zero-event resume: afterSeq == headSeq starts with resumed frame, followed by normal live frames', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const first = connect(hub, 'http://x/api/events')
    await waitFor(() => first.frames.length >= 1)
    const snap = first.frames[0]?.data as HelmxSnapshot
    assert.equal(snap.bootId, 'b1')
    assert.equal(snap.seq, 0)
    await first.abort()

    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    assert.deepEqual(
      resumed.frames[0],
      {
        event: 'resumed',
        data: { bootId: 'b1', seq: 0, headSeq: 0, conversationLives: [] } satisfies HelmxResumedFrame,
      },
      'zero-catch-up resume must start with resumed {bootId, seq, headSeq, conversationLives}',
    )
    hub.publish('notification', { level: 'info', title: 'live after zero catch-up' })
    await waitFor(() => resumed.frames.some((f) => f.event === 'notification'))
    assert.deepEqual((resumed.frames[1]?.data as HelmxEventFrame).event, { type: 'notification', level: 'info', title: 'live after zero catch-up' })
    assert.equal(hub.subscriberCount, 1)
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('non-zero initialSeq zero-event resume advances directly from resumed watermark', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', initialSeq: 7 })
    const resumed = connect(hub, eventsUrl(7, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 7, headSeq: 7, conversationLives: [] })
    await resumed.abort()
  })

  it('catches up 5 buffered frames without gaps or duplicates, including overlapping live publishes', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 5)
    assert.equal(hub.seq, 5)
    // Publish 2 live frames right after opening stream response: subscriber queue bridges smoothly past replay.
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    publishNotes(hub, 2, { startTitle: 6 })
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 7)
    await resumed.abort()

    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 5, conversationLives: [] })
    const notes = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq)
    assert.deepEqual(notes, [1, 2, 3, 4, 5, 6, 7], 'buffered 6..7 seamlessly join replayed 1..5 in exact sequence')
    const titles = resumed.frames
      .filter((f) => f.event === 'notification')
      .map((f) => ((f.data as HelmxEventFrame).event as { title?: string }).title)
    assert.deepEqual(titles, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
  })
})

// ---------------------------------------------------------------------------
// Cross-process and missed-gap fallback to snapshot
// ---------------------------------------------------------------------------

describe('EventHub resume: cross-process and gap snapshot fallback', { timeout: 60_000 }, () => {
  it('cross-instance equal seq forces snapshot when bootId differs even if new ring covers range', { timeout: 60_000 }, async () => {
    const { hub: hub1 } = makeHub({ bootId: 'b1' })
    publishNotes(hub1, 5)
    // Simulated restart: persisted seq=5, fresh process bootId='b2' (ring contains 6,7).
    const { hub: hub2 } = makeHub({ bootId: 'b2', initialSeq: 5 })
    publishNotes(hub2, 2, { startTitle: 6 })

    const resumed = connect(hub2, eventsUrl(5, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    await resumed.abort()
    assert.equal(resumed.frames[0]?.event, 'snapshot', 'different process must never resume incrementally: emit snapshot')
    const snap = resumed.frames[0]?.data as HelmxSnapshot
    assert.equal(snap.bootId, 'b2', 'snapshot conveys new bootId for client credential update')
    assert.equal(snap.seq, 7)
  })

  it('evicted frames falling outside ring force snapshot; ranges inside ring resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxFrames: 3 })
    publishNotes(hub, 5) // ring retains only [3,4,5]
    // afterSeq=1 needs 2..5, 2 was evicted -> snapshot.
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'cache miss must never resume past evicted gap')

    // afterSeq=2 is covered by ring (needs 3..5) -> resumed.
    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 3)
    await covered.abort()
    assert.deepEqual(covered.frames[0]?.data, { bootId: 'b1', seq: 2, headSeq: 5, conversationLives: [] })
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
      [3, 4, 5],
    )
  })

  it('byte eviction trims oldest frames from head; gaps fall back to snapshot', { timeout: 60_000 }, async () => {
    // ~1KB per frame, ringMaxBytes=1500: fits at most 1 frame.
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 3, { bodyLength: 950 }) // ring retains only [3]
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'needs 2..3 while 2 was evicted by byte budget')

    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 1)
    await covered.abort()
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
      [3],
    )
  })

  it('single frame exceeding byte budget clears ring (no skip-resume), while subsequent frames resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 2) // small frames (~120B each)
    hub.publish('notification', { level: 'info', title: 'big', body: 'x'.repeat(2000) }) // seq 3 exceeds cap -> clears ring
    publishNotes(hub, 2, { startTitle: 4 }) // ring [4,5]
    assert.equal(hub.seq, 5)

    // afterSeq=2 needs 3..5: unbuffered large frame 3 prevents catch-up -> snapshot (never falsely skips 3).
    const missed = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'oversized frame must not be skipped on resume')

    // afterSeq=3 only needs 4..5: resumes cleanly (clearing ring earlier does not poison later range).
    const after = connect(hub, eventsUrl(3, 'b1'))
    await waitFor(() => after.frames.filter((f) => f.event === 'notification').length >= 2)
    await after.abort()
    assert.deepEqual(
      after.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
      [4, 5],
    )
  })

  it('future seq (afterSeq > headSeq) falls back to snapshot instead of assuming zero catch-up', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    const future = connect(hub, eventsUrl(4, 'b1'))
    await waitFor(() => future.frames.length >= 1)
    await future.abort()
    assert.equal(future.frames[0]?.event, 'snapshot')
  })
})

// ---------------------------------------------------------------------------
// Malformed resume credentials -> explicit 400
// ---------------------------------------------------------------------------

describe('EventHub resume: malformed credentials return explicit 400', { timeout: 60_000 }, () => {
  const badCases: Array<{ url: string; label: string }> = [
    { url: 'http://x/api/events?afterSeq=-1&bootId=b1', label: 'negative integer' },
    { url: 'http://x/api/events?afterSeq=1.5&bootId=b1', label: 'decimal' },
    { url: 'http://x/api/events?afterSeq=abc&bootId=b1', label: 'non-numeric' },
    { url: 'http://x/api/events?afterSeq=1e3&bootId=b1', label: 'scientific notation' },
    { url: 'http://x/api/events?afterSeq=0x1&bootId=b1', label: 'hexadecimal' },
    { url: 'http://x/api/events?afterSeq=&bootId=b1', label: 'empty afterSeq' },
    { url: 'http://x/api/events?afterSeq=99999999999999999&bootId=b1', label: '17-digit overflow' },
    { url: 'http://x/api/events?afterSeq=9999999999999999&bootId=b1', label: 'exceeds MAX_SAFE_INTEGER' },
    { url: 'http://x/api/events?afterSeq=1&bootId=', label: 'empty bootId' },
    { url: `http://x/api/events?afterSeq=1&bootId=${'b'.repeat(65)}`, label: 'bootId > 64 chars' },
    { url: 'http://x/api/events?afterSeq=1&bootId=b1&bootId=b2', label: 'duplicate bootId' },
    { url: 'http://x/api/events?afterSeq=1&afterSeq=2&bootId=b1', label: 'duplicate afterSeq' },
    { url: 'http://x/api/events?afterSeq=1', label: 'missing bootId' },
    { url: 'http://x/api/events?bootId=b1', label: 'missing afterSeq' },
  ]
  for (const { url, label } of badCases) {
    it(`${label} -> 400 invalid_input`, { timeout: 60_000 }, async () => {
      const { hub } = makeHub({ bootId: 'b1' })
      const response = hub.response(new Request(url))
      assert.equal(response.status, 400, `${label} must return explicit 400`)
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      assert.equal(body.error?.code, 'invalid_input')
      assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0)
      assert.equal(hub.subscriberCount, 0, '400 path must not register subscriber')
    })
  }

  it('unknown but well-formed bootId falls back to snapshot (cross-instance semantics)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const t = connect(hub, eventsUrl(0, 'other-boot'))
    assert.equal(t.response.status, 200)
    assert.match(t.response.headers.get('content-type') ?? '', /^text\/event-stream/)
    await waitFor(() => t.frames.length >= 1)
    await t.abort()
    assert.equal(t.frames[0]?.event, 'snapshot')
  })
})

// ---------------------------------------------------------------------------
// Backpressure & pull-paced replay
// ---------------------------------------------------------------------------

describe('EventHub resume: pull pacing and backpressure', { timeout: 60_000 }, () => {
  it('total replay exceeding maxPendingBytes delivers reliably to fast consumers via pull pacing', { timeout: 60_000 }, async () => {
    // ~44KB replay with 4KB buffer limit: bulk-enqueuing up front would trip limit; pull pacing delivers everything.
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 40, { bodyLength: 1000 })
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 40, 10_000)
    assert.equal(hub.subscriberCount, 1, 'fast consumer stays subscribed throughout large replay')
    const seqs = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq)
    assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1), 'replayed sequences stay strictly contiguous')
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('unreading consumer with live frames overflowing budget during catch-up closes stream cleanly without leaks', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 20, { bodyLength: 1000 }) // ~22KB replay awaiting pull
    const controller = new AbortController()
    const response = hub.response(new Request(eventsUrl(0, 'b1'), { signal: controller.signal }))
    // Unread stream: replay stalls while live publishes exceed 4KiB limit -> closes stream.
    publishNotes(hub, 30, { bodyLength: 900, startTitle: 21 })
    await waitFor(() => hub.subscriberCount === 0, 5000)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.match(text, /event: resumed/)
    assert.ok(!text.includes('n21'), 'live frames must not enter closed stream')
    controller.abort()
  })

  it('ReadableStream.cancel unsubscribes resumed streams with zero leaks', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2)
    const response = hub.response(new Request(eventsUrl(0, 'b1')))
    const reader = response.body!.getReader()
    await reader.read()
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel unsubscribes immediately')
  })
})

// ---------------------------------------------------------------------------
// Persistence order & ring contiguity defense-in-depth invariants
// ---------------------------------------------------------------------------

/** White-box ring accessor (testing defensive contiguity checks; normal publish path never creates gaps). */
function ringOf(hub: EventHub): Array<{ seq: number; chunk: Uint8Array }> {
  return (hub as unknown as { ring: Array<{ seq: number; chunk: Uint8Array }> }).ring
}

describe('EventHub publish persistence ordering and ring contiguity', { timeout: 60_000 }, () => {
  it('persistSeq failure leaves seq, subscribers, and ring untouched; next publish resumes cleanly without gaps', { timeout: 60_000 }, async () => {
    const successes: number[] = []
    let failNext = true
    const { hub } = makeHub({
      bootId: 'b1',
      persistSeq: (seq) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        successes.push(seq)
      },
    })
    const frames: HelmxEventFrame[] = []
    hub.subscribe((frame) => frames.push(frame))

    // Failed persist throws synchronously without polluting watermark, ring, or broadcasts.
    assert.throws(() => hub.publish('notification', { level: 'info', title: 'failed frame' }), /disk full/)
    assert.equal(hub.seq, 0, 'failed persist must not advance memory seq')
    assert.equal(frames.length, 0, 'failed publish must not broadcast')

    // Subsequent publishes continue from seq 1 without leaving holes.
    hub.publish('notification', { level: 'info', title: 'ok1' })
    hub.publish('notification', { level: 'info', title: 'ok2' })
    assert.equal(hub.seq, 2)
    assert.deepEqual(successes, [1, 2], 'successful publish seqs remain contiguous')
    assert.deepEqual(frames.map((f) => f.seq), [1, 2])

    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 2)
    await resumed.abort()
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 2, conversationLives: [] })
    assert.deepEqual(
      resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
      [1, 2],
      'replay remains strictly contiguous after failed publish',
    )
  })

  it('middle hole in ring falls back to snapshot rather than falsely promising resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 4)
    ringOf(hub).splice(1, 1) // simulate middle corruption: [1,3,4]
    const conn = connect(hub, eventsUrl(1, 'b1')) // needs 2..4, 2 missing
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', 'canResume contiguity check must reject ring gaps')
  })

  it('missing tail frame in ring falls back to snapshot so client does not stall below headSeq', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    ringOf(hub).pop() // simulate dropped tail: headSeq=3 while ring ends at 2
    const conn = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', 'ring tail != headSeq must never resume')
  })

  it('non-contiguous append resets ring cleanly rather than spanning a gap', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2) // ring [1,2]
    ringOf(hub).pop() // simulate lost tail -> [1]
    publishNotes(hub, 1, { startTitle: 3 }) // append seq 3: last=1 != 2 -> resets ring to [3]
    assert.equal(hub.seq, 3)

    // afterSeq=1 needs 2..3 -> snapshot.
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot')

    // afterSeq=2 needs only 3 -> resumes normally from rebuilt ring.
    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 1)
    await covered.abort()
    assert.deepEqual(covered.frames[0]?.data, { bootId: 'b1', seq: 2, headSeq: 3, conversationLives: [] })
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
      [3],
    )
  })
})

// ---------------------------------------------------------------------------
// bootId semantics
// ---------------------------------------------------------------------------

describe('EventHub bootId', { timeout: 60_000 }, () => {
  it('generates distinct random UUID bootIds per instance and exposes them on snapshots', { timeout: 60_000 }, () => {
    const a = makeHub()
    const b = makeHub()
    assert.match(a.hub.bootId, /^[0-9a-f-]{36}$/, 'default bootId must be UUID')
    assert.notEqual(a.hub.bootId, b.hub.bootId, 'distinct instances must have distinct bootIds')
    assert.equal(a.hub.currentSnapshot().bootId, a.hub.bootId)
  })

  it('fresh connections without resume params start normally with snapshot carrying bootId', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const plain = connect(hub, 'http://x/api/events')
    await waitFor(() => plain.frames.length >= 1)
    await plain.abort()
    assert.equal(plain.frames[0]?.event, 'snapshot')
    assert.equal((plain.frames[0]?.data as HelmxSnapshot).bootId, 'b1')
  })
})

// ---------------------------------------------------------------------------
// Transient conversation.live isolation + resumed.conversationLives + ring defaults
// ---------------------------------------------------------------------------

function sampleSummary(id: number, status: ConversationSummary['status']): ConversationSummary {
  return {
    id,
    title: `c${id}`,
    profileId: 'default',
    tags: [],
    nodeId: 'local',
    cwd: '/tmp/ws',
    model: 'anthropic/claude-sonnet-4',
    thinkingLevel: 'medium',
    status,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    stateChangeSeq: 1,
    completionSeq: 0,
    lastEntryId: 0,
    createdAt: 1000,
    updatedAt: 2000,
  }
}

describe('EventHub transient conversation.live separation and ring defaults', { timeout: 60_000 }, () => {
  it('EventHub.publish refuses conversation.live while publishTransientLive bypasses seq, persistSeq, and ring eviction', { timeout: 60_000 }, async () => {
    const { hub, persisted } = makeHub({ bootId: 'b1', ringMaxFrames: 3 })
    try {
      assert.throws(
        () =>
          hub.publish('conversation.live' as never, {
            live: { conversationId: 1, text: 'x', tools: [] },
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_event',
      )
      assert.equal(hub.seq, 0)
      assert.deepEqual(persisted, [])

      // Publish 2 durable notes (seq 1, 2), flood 1500 transient live frames, then 1 durable note (seq 3).
      publishNotes(hub, 2)
      for (let i = 0; i < 1500; i++) {
        hub.publishTransientLive({
          conversationId: 1,
          text: `delta-${i}`,
          tools: [],
          updatedAt: 1000 + i,
        })
      }
      assert.equal(hub.seq, 2, '1500 transient live broadcasts must never advance seq')
      assert.deepEqual(persisted, [1, 2], '1500 transient live broadcasts must never touch persistSeq')
      publishNotes(hub, 1, { startTitle: 3 })
      assert.equal(hub.seq, 3)
      assert.deepEqual(persisted, [1, 2, 3])

      // Replay from afterSeq=0 still hits ring [1,2,3] — transient frames never evict durable ring slots.
      const resumed = connect(hub, eventsUrl(0, 'b1'))
      try {
        await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 3)
        assert.equal(resumed.frames[0]?.event, 'resumed')
        const frameData = resumed.frames[0]?.data as HelmxResumedFrame
        assert.equal(frameData.seq, 0)
        assert.equal(frameData.headSeq, 3)
        assert.equal(frameData.conversationLives?.length, 1)
        assert.equal(frameData.conversationLives?.[0]?.text, 'delta-1499')
        assert.deepEqual(
          resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmxEventFrame).seq),
          [1, 2, 3],
        )
      } finally {
        await resumed.abort()
      }
    } finally {
      hub.close()
    }
  })

  it('publishTransientLive broadcasts redacted HelmxTransientLiveFrame on /api/events and dispatches to hostDispatcher', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    hub.redactFn = (text) => text.replaceAll('sk-secret-xyz', '[REDACTED]')
    const dispatched: HostDispatchedEvent[] = []
    hub.setHostDispatcher((evt) => {
      dispatched.push(evt)
    })

    const conn = connect(hub, 'http://x/api/events')
    try {
      await waitFor(() => conn.frames.length >= 1)
      hub.publishTransientLive({
        conversationId: 42,
        text: 'token=sk-secret-xyz',
        thinking: 'think sk-secret-xyz',
        tools: [],
        updatedAt: 1000,
      })
      await waitFor(() => conn.frames.some((f) => f.event === 'conversation.live'))
      const liveFrame = conn.frames.find((f) => f.event === 'conversation.live')
      assert.deepEqual(liveFrame?.data, {
        live: {
          conversationId: 42,
          text: 'token=[REDACTED]',
          thinking: 'think [REDACTED]',
          tools: [],
          updatedAt: 1000,
        },
      })
      assert.equal(hub.seq, 0, 'transient SSE frame must not increment durable seq')
      assert.equal(dispatched.length, 1)
      assert.deepEqual(dispatched[0], {
        type: 'conversation.live',
        live: {
          conversationId: 42,
          text: 'token=[REDACTED]',
          thinking: 'think [REDACTED]',
          tools: [],
          updatedAt: 1000,
        },
      })
    } finally {
      await conn.abort()
      hub.close()
    }
  })

  it('resumed.conversationLives reconciles active lives across upsert terminal state, queuedInputs, inactive live, and deletion', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    try {
      hub.publishTransientLive({ conversationId: 1, text: 'working-1', tools: [], updatedAt: 1001 })
      hub.publishTransientLive({
        conversationId: 2,
        text: 'working-2',
        tools: [],
        queuedInputs: [{ id: 'q1', submissionId: 'sub-101', text: 'next', mode: 'followUp', origin: 'human', createdAt: 10 }],
        updatedAt: 1002,
      })
      hub.publishTransientLive({ conversationId: 3, text: 'working-3', tools: [], updatedAt: 1003 })
      hub.publishTransientLive({ conversationId: 4, text: 'working-4', tools: [], updatedAt: 1004 })

      hub.publish('conversation.upsert', { conversation: sampleSummary(1, 'idle') })
      hub.publish('conversation.upsert', { conversation: sampleSummary(2, 'done') })
      hub.publish('conversation.deleted', { conversationId: 3 })
      hub.publishTransientLive({ conversationId: 4, text: '', tools: [], updatedAt: 1005 })

      const resumed = connect(hub, eventsUrl(0, 'b1'))
      try {
        await waitFor(() => resumed.frames.some((f) => f.event === 'resumed'))
        const frame = resumed.frames[0]?.data as HelmxResumedFrame
        assert.deepEqual(frame.conversationLives, [
          {
            conversationId: 2,
            text: '',
            tools: [],
            queuedInputs: [{ id: 'q1', submissionId: 'sub-101', text: 'next', mode: 'followUp', origin: 'human', createdAt: 10 }],
            updatedAt: 1002,
          },
        ])
      } finally {
        await resumed.abort()
      }
    } finally {
      hub.close()
    }
  })

  it('default ring retains >256 durable frames (300 frames resume via resumed without snapshot fallback)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    try {
      publishNotes(hub, 300)
      assert.equal(hub.seq, 300)
      const resumed = connect(hub, eventsUrl(0, 'b1'))
      try {
        await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 300)
        assert.equal(resumed.frames[0]?.event, 'resumed', 'default 1024-frame ring covers 300 frames without falling back to snapshot')
        const head = resumed.frames[0]?.data as HelmxResumedFrame
        assert.equal(head.seq, 0)
        assert.equal(head.headSeq, 300)
      } finally {
        await resumed.abort()
      }
    } finally {
      hub.close()
    }
  })
})
