/**
 * EventHub short disconnection resume (?afterSeq+?bootId / ring / resumed control frame) test.
 *
 * override:
 * - same proxy zero event resume (afterSeq == headSeq, contains non-zero initialSeq) and 5 frame patch complete strictly
 *   without duplicate without omission (contains response() establish after, read before publish heavy window frame);
 * - across instance same seq force snapshot(bootId different never resume, even if new instance ring already override);
 * - ring frame count/byte eliminate and single frame over byte pre- compute (empty after cannot across the frame resume, its after can resume);
 * - not come seq fall back snapshot; distortion shape credentials (negative number/decimal/non- number/over long/single credentials) explicit 400;
 * - replay via pull one by one step conflict refresh (replay total amount far over maxPendingBytes also do not mistakenly kill fast consumer),
 *   conflict refresh during slow consumer (do not read + live frame heap accumulate) by pre- compute explicit closure stream;
 * - abort / cancel after without subscribe leak leak;snapshot inject instance bootId.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { HelmEventFrame, HelmResumedFrame, HelmSnapshot } from '@helm/protocol'
import { EventHub } from '../src/runtime/events.js'
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
  /** override persistSeq(inject throws learn scenario); default record fixture.persisted. */
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

/** parse one segment SSE text is {event, data} list (ignore note release row). */
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

/** establish connect and continuous read accumulated frame;abort after stream final,join wrap-up. */
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
// same proxy resume: zero event and many frame patch complete
// ---------------------------------------------------------------------------

describe('EventHub resume: same proxy patch', { timeout: 60_000 }, () => {
  it('zero event resume:afterSeq == headSeq first frame resumed, zero patch after real-time frame per common reach', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const first = connect(hub, 'http://x/api/events')
    await waitFor(() => first.frames.length >= 1)
    const snap = first.frames[0]?.data as HelmSnapshot
    assert.equal(snap.bootId, 'b1')
    assert.equal(snap.seq, 0)
    await first.abort()

    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    assert.deepEqual(
      resumed.frames[0],
      { event: 'resumed', data: { bootId: 'b1', seq: 0, headSeq: 0 } satisfies HelmResumedFrame },
      'zero patch resume first frame must be resumed {bootId,seq,headSeq}',
    )
    hub.publish('notification', { level: 'info', title: 'zero patch after real-time' })
    await waitFor(() => resumed.frames.some((f) => f.event === 'notification'))
    assert.deepEqual((resumed.frames[1]?.data as HelmEventFrame).event, { type: 'notification', level: 'info', title: 'zero patch after real-time' })
    assert.equal(hub.subscriberCount, 1)
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('non-zero initialSeq zero event resume: durable watermark directly from resumed start step', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', initialSeq: 7 })
    const resumed = connect(hub, eventsUrl(7, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 7, headSeq: 7 })
    await resumed.abort()
  })

  it('5 frame patch complete strictly without duplicate without omission; create connect after not read before publish frame (heavy window) connect in replay after', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 5)
    assert.equal(hub.seq, 5)
    // establish resume response after immediately publish 2 frame: subscribe buffer must first at replay establish (without window lose frame).
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    publishNotes(hub, 2, { startTitle: 6 })
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 7)
    await resumed.abort()

    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 5 })
    const notes = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq)
    assert.deepEqual(notes, [1, 2, 3, 4, 5, 6, 7], 'replay 1..5 after without seam join buffer 6..7, strictly connect continue')
    const titles = resumed.frames
      .filter((f) => f.event === 'notification')
      .map((f) => ((f.data as HelmEventFrame).event as { title?: string }).title)
    assert.deepEqual(titles, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
  })
})

// ---------------------------------------------------------------------------
// across proxy and cache missing opening: force snapshot
// ---------------------------------------------------------------------------

describe('EventHub resume: across proxy and missing opening fall back snapshot', { timeout: 60_000 }, () => {
  it('across instance same seq:bootId different force snapshot, even if new instance ring already override missing opening', { timeout: 60_000 }, async () => {
    const { hub: hub1 } = makeHub({ bootId: 'b1' })
    publishNotes(hub1, 5)
    // simulated server side restart: durable seq=5, but instance proxy swap new (ring already has 6,7).
    const { hub: hub2 } = makeHub({ bootId: 'b2', initialSeq: 5 })
    publishNotes(hub2, 2, { startTitle: 6 })

    const resumed = connect(hub2, eventsUrl(5, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    await resumed.abort()
    assert.equal(resumed.frames[0]?.event, 'snapshot', 'across proxy never resume: first frame must be snapshot')
    const snap = resumed.frames[0]?.data as HelmSnapshot
    assert.equal(snap.bootId, 'b2', 'snapshot carry new proxy bootId, client based on this change use new credentials')
    assert.equal(snap.seq, 7)
  })

  it('frame eliminate after exceeds missing opening afterSeq fall back snapshot;ring override inside can resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxFrames: 3 })
    publishNotes(hub, 5) // ring only remain [3,4,5]
    // afterSeq=1 need to 2..5,2 already by eliminate → snapshot.
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'cache missing opening never exceeds missing resume')

    // afterSeq=2 exactly by ring override (must 3..5)→ resumed.
    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 3)
    await covered.abort()
    assert.deepEqual(covered.frames[0]?.data, { bootId: 'b1', seq: 2, headSeq: 5 })
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [3, 4, 5],
    )
  })

  it('byte eliminate:ring byte over limit from head trim, exceeds trim line fall back snapshot', { timeout: 60_000 }, async () => {
    // single frame about 1KB,ringMaxBytes=1500: at most keep 1 frame.
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 3, { bodyLength: 950 }) // ring only remain [3]
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'need to 2..3 but 2 already by byte pre- compute trim')

    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 1)
    await covered.abort()
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [3],
    )
  })

  it('single frame over byte pre- compute: empty ring, cannot across the frame resume; its after frame can resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 2) // small frame (about 120B)
    hub.publish('notification', { level: 'info', title: 'big', body: 'x'.repeat(2000) }) // seq 3: over pre- compute → ring empty
    publishNotes(hub, 2, { startTitle: 4 }) // ring [4,5]
    assert.equal(hub.seq, 5)

    // afterSeq=2 need to 3..5: large frame already cannot replay → snapshot(never exceeds missing opening false succeeded).
    const missed = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', 'single frame over pre- compute after must not across the frame resume')

    // afterSeq=3 only needs to 4..5: still can normal resume (empty do not toxic after continue zone segment).
    const after = connect(hub, eventsUrl(3, 'b1'))
    await waitFor(() => after.frames.filter((f) => f.event === 'notification').length >= 2)
    await after.abort()
    assert.deepEqual(
      after.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [4, 5],
    )
  })

  it('not come seq(afterSeq > headSeq) fall back snapshot, do not mistakenly when zero patch', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    const future = connect(hub, eventsUrl(4, 'b1'))
    await waitFor(() => future.frames.length >= 1)
    await future.abort()
    assert.equal(future.frames[0]?.event, 'snapshot')
  })
})

// ---------------------------------------------------------------------------
// distortion shape credentials: explicit 400
// ---------------------------------------------------------------------------

describe('EventHub resume: distortion shape credentials explicit 400', { timeout: 60_000 }, () => {
  const badCases: Array<{ url: string; label: string }> = [
    { url: 'http://x/api/events?afterSeq=-1&bootId=b1', label: 'negative number' },
    { url: 'http://x/api/events?afterSeq=1.5&bootId=b1', label: 'decimal' },
    { url: 'http://x/api/events?afterSeq=abc&bootId=b1', label: 'non- number' },
    { url: 'http://x/api/events?afterSeq=1e3&bootId=b1', label: 'subject learn counter' },
    { url: 'http://x/api/events?afterSeq=0x1&bootId=b1', label: 'ten six enter system' },
    { url: 'http://x/api/events?afterSeq=&bootId=b1', label: 'empty afterSeq' },
    { url: 'http://x/api/events?afterSeq=99999999999999999&bootId=b1', label: '17 over long number' },
    { url: 'http://x/api/events?afterSeq=9999999999999999&bootId=b1', label: 'exceeds security integer' },
    { url: 'http://x/api/events?afterSeq=1&bootId=', label: 'empty bootId' },
    { url: `http://x/api/events?afterSeq=1&bootId=${'b'.repeat(65)}`, label: 'bootId over 64 character' },
    { url: 'http://x/api/events?afterSeq=1&bootId=b1&bootId=b2', label: 'duplicate bootId' },
    { url: 'http://x/api/events?afterSeq=1&afterSeq=2&bootId=b1', label: 'duplicate afterSeq' },
    { url: 'http://x/api/events?afterSeq=1', label: 'only afterSeq(missing credentials for)' },
    { url: 'http://x/api/events?bootId=b1', label: 'only bootId(missing credentials for)' },
  ]
  for (const { url, label } of badCases) {
    it(`${label} -> 400 invalid_input`, { timeout: 60_000 }, async () => {
      const { hub } = makeHub({ bootId: 'b1' })
      const response = hub.response(new Request(url))
      assert.equal(response.status, 400, `${label} must explicit 400`)
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      assert.equal(body.error?.code, 'invalid_input')
      assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0)
      assert.equal(hub.subscriberCount, 0, '400 path do not establish subscribe')
    })
  }

  it('unknown but shape legal bootId do not compute distortion shape: fall back snapshot(across proxy semantics)', { timeout: 60_000 }, async () => {
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
// conflict refresh and back press:pull one by one step conflict refresh / slow consumer
// ---------------------------------------------------------------------------

describe('EventHub resume: conflict refresh and back press', { timeout: 60_000 }, () => {
  it('replay total amount far over maxPendingBytes:pull one by one step conflict refresh, fast consumer do not by mistakenly kill', { timeout: 60_000 }, async () => {
    // replay about 44KB, streaming pre- compute only 4KB:start once queue must collide pre- compute;pull conflict refresh should complete send reach.
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 40, { bodyLength: 1000 })
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 40, 10_000)
    assert.equal(hub.subscriberCount, 1, 'fast consumer replay during keep subscribe')
    const seqs = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq)
    assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1), 'replay by seq strictly connect continue complete')
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('conflict refresh during do not read and live frame heap accumulate over pre- compute: explicit closure stream unsubscribe (without subscribe leak leak)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 20, { bodyLength: 1000 }) // replay about 22KB resident conflict refresh queue
    const controller = new AbortController()
    const response = hub.response(new Request(eventsUrl(0, 'b1'), { signal: controller.signal }))
    // fully do not read: conflict refresh queue without person pull; continuous publish live frame, conflict refresh phase new byte over 4KiB pre- compute i.e. closure stream.
    publishNotes(hub, 30, { bodyLength: 900, startTitle: 21 })
    await waitFor(() => hub.subscriberCount === 0, 5000)
    // closure stream after can read exhaust already queue byte (only grasp manually frame) and obtain to done; again publish no longer delivery.
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.match(text, /event: resumed/)
    assert.ok(!text.includes('n21'), 'closure stream after live frame must not again enter the stream')
    controller.abort()
  })

  it('ReadableStream.cancel same unsubscribe (resumed connect without subscribe leak leak)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2)
    const response = hub.response(new Request(eventsUrl(0, 'b1')))
    const reader = response.body!.getReader()
    await reader.read()
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel after immediately unsubscribe')
  })
})

// ---------------------------------------------------------------------------
// publish persist order and ring zone segment complete (guard against defend invariant)
// ---------------------------------------------------------------------------

/** blank box take ring(only test guard against defend invariant use: normal way already cannot produce missing opening). */
function ringOf(hub: EventHub): Array<{ seq: number; chunk: Uint8Array }> {
  return (hub as unknown as { ring: Array<{ seq: number; chunk: Uint8Array }> }).ring
}

describe('EventHub publish persist order and ring zone segment complete', { timeout: 60_000 }, () => {
  it('persistSeq throws: do not push enter watermark, do not broadcast, produces no broken ring; under time succeeded seq connect continue can resume', { timeout: 60_000 }, async () => {
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
    const frames: HelmEventFrame[] = []
    hub.subscribe((frame) => frames.push(frame))

    // first time publish: persist throws → publish sync throw, but watermark/ring/broadcast all must not has half into product.
    assert.throws(() => hub.publish('notification', { level: 'info', title: 'failed frame' }), /disk full/)
    assert.equal(hub.seq, 0, 'persist failed do not push enter memory watermark (do not bare seq)')
    assert.equal(frames.length, 0, 'failed publish must not broadcast')

    // after continue succeeded publish:seq from 1 connect continue push enter (failed does not occupy seq,ring without missing opening).
    hub.publish('notification', { level: 'info', title: 'ok1' })
    hub.publish('notification', { level: 'info', title: 'ok2' })
    assert.equal(hub.seq, 2)
    assert.deepEqual(successes, [1, 2], 'succeeded publish persist ordinal connect continue, failed frame does not occupy')
    assert.deepEqual(frames.map((f) => f.seq), [1, 2])

    // resume from 0: complete replay 1..2(strictly connect continue, without bare seq missing opening).
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 2)
    await resumed.abort()
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 2 })
    assert.deepEqual(
      resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [1, 2],
      'failed publish do not missing opening: replay strictly connect continue',
    )
  })

  it('ring in segment by dig missing opening (simulated zone segment corrupt): must fall back snapshot, must not false resumed promise', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 4)
    ringOf(hub).splice(1, 1) // dig middle one frame:ring [1,3,4] no longer connect continue
    const conn = connect(hub, eventsUrl(1, 'b1')) // need to 2..4:2 missing
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', 'canResume line connect continue validate must intercept in segment missing opening')
  })

  it('ring end frame missing: must fall back snapshot(client will not forever append do not flat headSeq)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    ringOf(hub).pop() // simulated end frame lose:headSeq=3 but ring only to 2
    const conn = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', 'end frame != headSeq when never resume (guard against replay append do not flat die etc.)')
  })

  it('non- connect continue append guard against defend: old zone segment act abandon after from new frame rebuild, do not across missing opening resume', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2) // ring [1,2]
    ringOf(hub).pop() // simulated lose tail:ring [1], bare seq 2 do not in ring
    publishNotes(hub, 1, { startTitle: 3 }) // append seq 3:last=1 non- connect continue → empty rebuild ring [3]
    assert.equal(hub.seq, 3)

    // afterSeq=1 need to 2..3:2 do not in ring → snapshot(do not exceeds missing opening false succeeded).
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot')

    // afterSeq=2 only needs to 3: rebuild after zone segment override → normal resume.
    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 1)
    await covered.abort()
    assert.deepEqual(covered.frames[0]?.data, { bootId: 'b1', seq: 2, headSeq: 3 })
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [3],
    )
  })
})

// ---------------------------------------------------------------------------
// bootId semantics
// ---------------------------------------------------------------------------

describe('EventHub bootId', { timeout: 60_000 }, () => {
  it('instance random generate: different instance different proxy; snapshot and resumed all carry', { timeout: 60_000 }, () => {
    const a = makeHub()
    const b = makeHub()
    assert.match(a.hub.bootId, /^[0-9a-f-]{36}$/, 'by default bootId is UUID')
    assert.notEqual(a.hub.bootId, b.hub.bootId, 'different instance different proxy')
    assert.equal(a.hub.currentSnapshot().bootId, a.hub.bootId)
  })

  it('not carry credentials ordinary connect do not subject to affect: first frame snapshot(contains bootId)', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const plain = connect(hub, 'http://x/api/events')
    await waitFor(() => plain.frames.length >= 1)
    await plain.abort()
    assert.equal(plain.frames[0]?.event, 'snapshot')
    assert.equal((plain.frames[0]?.data as HelmSnapshot).bootId, 'b1')
  })
})
