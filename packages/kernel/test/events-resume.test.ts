/**
 * EventHub 短断线续传（?afterSeq+?bootId / ring / resumed 控制帧）测试。
 *
 * 覆盖：
 * - 同代零事件续传（afterSeq == headSeq，含非零 initialSeq）与 5 帧补齐的严格
 *   无重复无遗漏（含 response() 建立后、读取前发布的重入窗口帧）；
 * - 跨实例同 seq 强制 snapshot（bootId 不同绝不续传，即使新实例 ring 已覆盖）；
 * - ring 帧数/字节淘汰与单帧超字节预算（清空后无法跨该帧续传、其后可续传）；
 * - 未来 seq 回退 snapshot；畸形凭据（负数/小数/非数字/超长/单凭据）显式 400；
 * - 重放经 pull 逐步冲刷（重放总量远超 maxPendingBytes 也不误杀快消费者）、
 *   冲刷期间慢消费者（不读取 + live 帧堆积）按预算明确关流；
 * - abort / cancel 后无订阅泄漏；snapshot 注入实例 bootId。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { HelmEventFrame, HelmResumedFrame, HelmSnapshot } from '@helm/protocol'
import { EventHub } from '../src/runtime/events.js'

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
  /** 覆盖 persistSeq（注入抛错学场景）；缺省记录入 fixture.persisted。 */
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

/** 解析一段 SSE 文本为 {event, data} 列表（忽略注释行）。 */
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

/** 建立连接并持续读取累积帧；abort 后流终结、join 收尾。 */
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

/** 等待条件成立（轮询 microtask+短 timer，防挂死）。 */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
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
// 同代续传：零事件与多帧补齐
// ---------------------------------------------------------------------------

describe('EventHub 续传：同代补发', { timeout: 60_000 }, () => {
  it('零事件续传：afterSeq == headSeq 首帧 resumed，零补发后实时帧照常到达', { timeout: 60_000 }, async () => {
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
      '零补发续传首帧必须是 resumed {bootId,seq,headSeq}',
    )
    hub.publish('notification', { level: 'info', title: '零补发后实时' })
    await waitFor(() => resumed.frames.some((f) => f.event === 'notification'))
    assert.deepEqual((resumed.frames[1]?.data as HelmEventFrame).event, { type: 'notification', level: 'info', title: '零补发后实时' })
    assert.equal(hub.subscriberCount, 1)
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('非零 initialSeq 的零事件续传：持久水位直接从 resumed 起步', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', initialSeq: 7 })
    const resumed = connect(hub, eventsUrl(7, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 7, headSeq: 7 })
    await resumed.abort()
  })

  it('5 帧补齐严格无重复无遗漏；建连后未读取前发布的帧（重入窗口）接在重放之后', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 5)
    assert.equal(hub.seq, 5)
    // 建立续传响应后立即发布 2 帧：订阅缓冲必须先于重放建立（无窗口丢帧）。
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    publishNotes(hub, 2, { startTitle: 6 })
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 7)
    await resumed.abort()

    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 5 })
    const notes = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq)
    assert.deepEqual(notes, [1, 2, 3, 4, 5, 6, 7], '重放 1..5 后无缝衔接缓冲 6..7，严格连续')
    const titles = resumed.frames
      .filter((f) => f.event === 'notification')
      .map((f) => ((f.data as HelmEventFrame).event as { title?: string }).title)
    assert.deepEqual(titles, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
  })
})

// ---------------------------------------------------------------------------
// 跨代与缓存缺口：强制 snapshot
// ---------------------------------------------------------------------------

describe('EventHub 续传：跨代与缺口回退 snapshot', { timeout: 60_000 }, () => {
  it('跨实例同 seq：bootId 不同强制 snapshot，即使新实例 ring 已覆盖缺口', { timeout: 60_000 }, async () => {
    const { hub: hub1 } = makeHub({ bootId: 'b1' })
    publishNotes(hub1, 5)
    // 模拟服务端重启：持久 seq=5，但实例代换新（ring 已有 6、7）。
    const { hub: hub2 } = makeHub({ bootId: 'b2', initialSeq: 5 })
    publishNotes(hub2, 2, { startTitle: 6 })

    const resumed = connect(hub2, eventsUrl(5, 'b1'))
    await waitFor(() => resumed.frames.length >= 1)
    await resumed.abort()
    assert.equal(resumed.frames[0]?.event, 'snapshot', '跨代绝不续传：首帧必须是 snapshot')
    const snap = resumed.frames[0]?.data as HelmSnapshot
    assert.equal(snap.bootId, 'b2', '快照携带新代 bootId，客户端据此改用新凭据')
    assert.equal(snap.seq, 7)
  })

  it('帧淘汰后越过缺口的 afterSeq 回退 snapshot；ring 覆盖内的可续传', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxFrames: 3 })
    publishNotes(hub, 5) // ring 只剩 [3,4,5]
    // afterSeq=1 需要 2..5，2 已被淘汰 → snapshot。
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', '缓存缺口绝不越缺续传')

    // afterSeq=2 恰好被 ring 覆盖（需 3..5）→ resumed。
    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 3)
    await covered.abort()
    assert.deepEqual(covered.frames[0]?.data, { bootId: 'b1', seq: 2, headSeq: 5 })
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [3, 4, 5],
    )
  })

  it('字节淘汰：ring 字节超限从头剪裁，越过剪裁线回退 snapshot', { timeout: 60_000 }, async () => {
    // 单帧约 1KB，ringMaxBytes=1500：至多保留 1 帧。
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 3, { bodyLength: 950 }) // ring 只剩 [3]
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', '需要 2..3 但 2 已被字节预算剪裁')

    const covered = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => covered.frames.filter((f) => f.event === 'notification').length >= 1)
    await covered.abort()
    assert.deepEqual(
      covered.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [3],
    )
  })

  it('单帧超字节预算：清空 ring，无法跨该帧续传；其后帧可续传', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', ringMaxBytes: 1500 })
    publishNotes(hub, 2) // 小帧（约 120B）
    hub.publish('notification', { level: 'info', title: 'big', body: 'x'.repeat(2000) }) // seq 3：超预算 → ring 清空
    publishNotes(hub, 2, { startTitle: 4 }) // ring [4,5]
    assert.equal(hub.seq, 5)

    // afterSeq=2 需要 3..5：大帧已不可重放 → snapshot（绝不越缺口假成功）。
    const missed = connect(hub, eventsUrl(2, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot', '单帧超预算后不得跨该帧续传')

    // afterSeq=3 只需 4..5：仍可正常续传（清空不毒化后续区段）。
    const after = connect(hub, eventsUrl(3, 'b1'))
    await waitFor(() => after.frames.filter((f) => f.event === 'notification').length >= 2)
    await after.abort()
    assert.deepEqual(
      after.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [4, 5],
    )
  })

  it('未来 seq（afterSeq > headSeq）回退 snapshot，不误当零补发', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    const future = connect(hub, eventsUrl(4, 'b1'))
    await waitFor(() => future.frames.length >= 1)
    await future.abort()
    assert.equal(future.frames[0]?.event, 'snapshot')
  })
})

// ---------------------------------------------------------------------------
// 畸形凭据：显式 400
// ---------------------------------------------------------------------------

describe('EventHub 续传：畸形凭据显式 400', { timeout: 60_000 }, () => {
  const badCases: Array<{ url: string; label: string }> = [
    { url: 'http://x/api/events?afterSeq=-1&bootId=b1', label: '负数' },
    { url: 'http://x/api/events?afterSeq=1.5&bootId=b1', label: '小数' },
    { url: 'http://x/api/events?afterSeq=abc&bootId=b1', label: '非数字' },
    { url: 'http://x/api/events?afterSeq=1e3&bootId=b1', label: '科学计数' },
    { url: 'http://x/api/events?afterSeq=0x1&bootId=b1', label: '十六进制' },
    { url: 'http://x/api/events?afterSeq=&bootId=b1', label: '空 afterSeq' },
    { url: 'http://x/api/events?afterSeq=99999999999999999&bootId=b1', label: '17 位超长数字' },
    { url: 'http://x/api/events?afterSeq=9999999999999999&bootId=b1', label: '超出安全整数' },
    { url: 'http://x/api/events?afterSeq=1&bootId=', label: '空 bootId' },
    { url: `http://x/api/events?afterSeq=1&bootId=${'b'.repeat(65)}`, label: 'bootId 超 64 字符' },
    { url: 'http://x/api/events?afterSeq=1&bootId=b1&bootId=b2', label: '重复 bootId' },
    { url: 'http://x/api/events?afterSeq=1&afterSeq=2&bootId=b1', label: '重复 afterSeq' },
    { url: 'http://x/api/events?afterSeq=1', label: '仅 afterSeq（缺凭据对）' },
    { url: 'http://x/api/events?bootId=b1', label: '仅 bootId（缺凭据对）' },
  ]
  for (const { url, label } of badCases) {
    it(`${label} -> 400 invalid_input`, { timeout: 60_000 }, async () => {
      const { hub } = makeHub({ bootId: 'b1' })
      const response = hub.response(new Request(url))
      assert.equal(response.status, 400, `${label} 必须显式 400`)
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      assert.equal(body.error?.code, 'invalid_input')
      assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0)
      assert.equal(hub.subscriberCount, 0, '400 路径不建立订阅')
    })
  }

  it('未知但形状合法的 bootId 不算畸形：回退 snapshot（跨代语义）', { timeout: 60_000 }, async () => {
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
// 冲刷与背压：pull 逐步冲刷 / 慢消费者
// ---------------------------------------------------------------------------

describe('EventHub 续传：冲刷与背压', { timeout: 60_000 }, () => {
  it('重放总量远超 maxPendingBytes：pull 逐步冲刷，快消费者不被误杀', { timeout: 60_000 }, async () => {
    // 重放约 44KB，流式预算仅 4KB：start 一次性入队必撞预算；pull 冲刷应完整送达。
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 40, { bodyLength: 1000 })
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 40, 10_000)
    assert.equal(hub.subscriberCount, 1, '快消费者重放期间保持订阅')
    const seqs = resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq)
    assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1), '重放按 seq 严格连续完整')
    await resumed.abort()
    assert.equal(hub.subscriberCount, 0)
  })

  it('冲刷期间不读取且 live 帧堆积超预算：明确关流退订（无订阅泄漏）', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1', maxPendingBytes: 4096, ringMaxBytes: 256 * 1024, keepaliveMs: 0 })
    publishNotes(hub, 20, { bodyLength: 1000 }) // 重放约 22KB 驻留冲刷队列
    const controller = new AbortController()
    const response = hub.response(new Request(eventsUrl(0, 'b1'), { signal: controller.signal }))
    // 完全不读：冲刷队列无人 pull；持续发布 live 帧，冲刷期新字节超 4KiB 预算即关流。
    publishNotes(hub, 30, { bodyLength: 900, startTitle: 21 })
    await waitFor(() => hub.subscriberCount === 0, 5000)
    // 关流后可读尽已入队字节（仅握手帧）并得到 done；再发布不再投递。
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.match(text, /event: resumed/)
    assert.ok(!text.includes('n21'), '关流后 live 帧不得再进入该流')
    controller.abort()
  })

  it('ReadableStream.cancel 同样退订（resumed 连接无订阅泄漏）', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2)
    const response = hub.response(new Request(eventsUrl(0, 'b1')))
    const reader = response.body!.getReader()
    await reader.read()
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel 后立即退订')
  })
})

// ---------------------------------------------------------------------------
// 发布持久化顺序与 ring 区段完整性（防御不变量）
// ---------------------------------------------------------------------------

/** 白盒取 ring（仅测试防御性不变量用：正常途径已无法产生缺口）。 */
function ringOf(hub: EventHub): Array<{ seq: number; chunk: Uint8Array }> {
  return (hub as unknown as { ring: Array<{ seq: number; chunk: Uint8Array }> }).ring
}

describe('EventHub 发布持久化顺序与 ring 区段完整性', { timeout: 60_000 }, () => {
  it('persistSeq 抛错：不推进水位、不广播、不产生坏 ring；下次成功 seq 连续可续传', { timeout: 60_000 }, async () => {
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

    // 第一次发布：持久化抛错 → publish 同步抛出，但水位/ring/广播都不得有半成品。
    assert.throws(() => hub.publish('notification', { level: 'info', title: '失败帧' }), /disk full/)
    assert.equal(hub.seq, 0, '持久化失败不推进内存水位（不留裸 seq）')
    assert.equal(frames.length, 0, '失败发布不得广播')

    // 后续成功发布：seq 从 1 连续推进（失败不占用 seq，ring 无缺口）。
    hub.publish('notification', { level: 'info', title: 'ok1' })
    hub.publish('notification', { level: 'info', title: 'ok2' })
    assert.equal(hub.seq, 2)
    assert.deepEqual(successes, [1, 2], '成功发布的持久化序号连续，失败帧不占用')
    assert.deepEqual(frames.map((f) => f.seq), [1, 2])

    // 续传 from 0：完整重放 1..2（严格连续，无裸 seq 缺口）。
    const resumed = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => resumed.frames.filter((f) => f.event === 'notification').length >= 2)
    await resumed.abort()
    assert.deepEqual(resumed.frames[0]?.data, { bootId: 'b1', seq: 0, headSeq: 2 })
    assert.deepEqual(
      resumed.frames.filter((f) => f.event === 'notification').map((f) => (f.data as HelmEventFrame).seq),
      [1, 2],
      '失败发布不留缺口：重放严格连续',
    )
  })

  it('ring 中段被挖缺口（模拟区段损坏）：必须回退 snapshot，不得发假 resumed 承诺', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 4)
    ringOf(hub).splice(1, 1) // 挖掉中间一帧：ring [1,3,4] 不再连续
    const conn = connect(hub, eventsUrl(1, 'b1')) // 需要 2..4：2 缺失
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', 'canResume 线性连续性校验必须拦截中段缺口')
  })

  it('ring 末帧缺失：必须回退 snapshot（客户端不会永远追不平 headSeq）', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 3)
    ringOf(hub).pop() // 模拟末帧丢失：headSeq=3 但 ring 只到 2
    const conn = connect(hub, eventsUrl(0, 'b1'))
    await waitFor(() => conn.frames.length >= 1)
    await conn.abort()
    assert.equal(conn.frames[0]?.event, 'snapshot', '末帧 != headSeq 时绝不续传（防重放追不平死等）')
  })

  it('非连续 append 防御：旧区段作废后从新帧重建，不跨缺口续传', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    publishNotes(hub, 2) // ring [1,2]
    ringOf(hub).pop() // 模拟丢尾：ring [1]，裸 seq 2 不在 ring
    publishNotes(hub, 1, { startTitle: 3 }) // append seq 3：last=1 非连续 → 清空重建 ring [3]
    assert.equal(hub.seq, 3)

    // afterSeq=1 需要 2..3：2 不在 ring → snapshot（不越缺口假成功）。
    const missed = connect(hub, eventsUrl(1, 'b1'))
    await waitFor(() => missed.frames.length >= 1)
    await missed.abort()
    assert.equal(missed.frames[0]?.event, 'snapshot')

    // afterSeq=2 只需 3：重建后的区段覆盖 → 正常续传。
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
// bootId 语义
// ---------------------------------------------------------------------------

describe('EventHub bootId', { timeout: 60_000 }, () => {
  it('实例随机生成：不同实例不同代；快照与 resumed 均携带', { timeout: 60_000 }, () => {
    const a = makeHub()
    const b = makeHub()
    assert.match(a.hub.bootId, /^[0-9a-f-]{36}$/, '默认 bootId 为 UUID')
    assert.notEqual(a.hub.bootId, b.hub.bootId, '不同实例不同代')
    assert.equal(a.hub.currentSnapshot().bootId, a.hub.bootId)
  })

  it('未携带凭据的普通连接不受影响：首帧 snapshot（含 bootId）', { timeout: 60_000 }, async () => {
    const { hub } = makeHub({ bootId: 'b1' })
    const plain = connect(hub, 'http://x/api/events')
    await waitFor(() => plain.frames.length >= 1)
    await plain.abort()
    assert.equal(plain.frames[0]?.event, 'snapshot')
    assert.equal((plain.frames[0]?.data as HelmSnapshot).bootId, 'b1')
  })
})
