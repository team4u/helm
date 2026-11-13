/**
 * EventHub 真实 HTTP 集成测试：真 Response.body reader + AbortController。
 *
 * 覆盖：SSE 首帧 snapshot / 增量帧协议、abort 与 reader.cancel 退订、close() 清场、
 * 慢消费者字节背压关流、快照竞态无丢帧、快照脱敏、publish 序号时序、
 * plugin.changed 信封/直传双形状、CustomHelmEvent 透传、非法 payload 显式失败、
 * conversation.upsert / ask.upsert / notification 逐字段严格校验（不静默降级）。
 * 纯内存 fixture（无真实模型、无真实 store；persistSeq 用 callback 捕获）。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { ConversationSummary, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { EventHub, type SseFrame } from '../src/runtime/events.js'

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

interface Fixture {
  hub: EventHub
  snapshotValue: HelmSnapshot
  persistedSeqs: number[]
}
function summary(id: number, title: string, doing?: string): ConversationSummary {
  return {
    id,
    title,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...(doing !== undefined ? { doing } : {}),
  }
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

/** 解析一段 SSE 文本为 {event, data} 列表。 */
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

/** 读到流结束，返回完整文本；可选每帧回调。 */
async function readAll(
  response: Response,
  onChunk?: (text: string) => void,
): Promise<string> {
  assert.ok(response.body !== null, 'SSE 响应必须有 body 流')
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

/** 等待条件成立（轮询 microtask+短 timer，防挂死）。 */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 单次读取附带 Deadline：心跳未按时到达即显式失败（不让测试挂到套件超时）。 */
async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 2000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`读取超时（${ms}ms）：心跳未到达`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// response()：真实 HTTP 语义
// ---------------------------------------------------------------------------

describe('EventHub.response SSE 协议', { timeout: 60_000 }, () => {
  it('首帧 event:snapshot 携带 HelmSnapshot，增量帧 event:<type> 携带 {seq,event}', { timeout: 60_000 }, async () => {
    const { hub, snapshotValue } = makeFixture()
    snapshotValue.conversations = [summary(1, '个人助理')]
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
    assert.ok(first && first.event === 'snapshot', '首帧必须是 snapshot')
    const snap = first.data as HelmSnapshot
    assert.equal(snap.seq, 0)
    assert.equal(snap.conversations.length, 1)
    assert.equal(snap.conversations[0]?.title, '个人助理')
    assert.deepEqual(snap.pendingAsks, [])
    assert.deepEqual(snap.plugins, [])

    const second = frames[1]
    assert.ok(second && second.event === 'notification')
    assert.deepEqual(second.data, {
      seq: 1,
      event: { type: 'notification', level: 'info', title: '你好' },
    })
  })

  it('Request.signal abort 退订并关流；重连凭新 snapshot 对齐', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.equal(hub.subscriberCount, 1)
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort 后立即退订')
    const text = await readAll(response, () => {})
    assert.match(text, /event: snapshot/, '关流前已写入的首帧仍可读')
    // abort 后发布不再进入该流（reader 已 done）。
    hub.publish('notification', { level: 'info', title: '后发' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('ReadableStream.cancel 同样退订（客户端主动断开）', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture()
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.ok(first.done !== true)
    assert.equal(hub.subscriberCount, 1)
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel 后立即退订')
    hub.publish('notification', { level: 'info', title: '取消后' })
    assert.equal(hub.subscriberCount, 0)
  })

  it('close() 清空全部订阅（kernel 关停用）', { timeout: 60_000 }, async () => {
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

  it('无事件时保持流（不回退 JSON/204），增量在任意时刻到达即达', { timeout: 60_000 }, async () => {
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
    // 任意时刻发布（模拟空闲后突发）。
    setTimeout(() => hub.publish('conversation.upsert', summary(2, '突发会话')), 30)
    await frameCame
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// 背压：慢消费者
// ---------------------------------------------------------------------------

describe('EventHub 慢消费者背压', { timeout: 60_000 }, () => {
  it('流式阶段未读字节超限：明确关流（不丢帧不静默续传）', { timeout: 60_000 }, async () => {
    // 1 KiB 上限：单帧约 100+ 字节，慢读 2 帧内必触发。
    const { hub } = makeFixture({ maxPendingBytes: 1024 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // 只读第一块（snapshot），随后不读——制造积压。
    const first = await reader.read()
    assert.ok(first.value)
    text += decoder.decode(first.value, { stream: true })
    assert.match(text, /event: snapshot/)

    for (let i = 0; i < 64; i++) {
      hub.publish('notification', { level: 'info', title: `n${i}`, body: 'x'.repeat(64) })
      if (hub.subscriberCount === 0) break
    }
    assert.equal(hub.subscriberCount, 0, '字节积压超限后订阅被明确移除')
    // 流已被服务端关闭；队列内已入队帧仍可读，最终得到 done（不再投递新帧）。
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    hub.publish('notification', { level: 'info', title: '关流后不应到达' })
    const after = await reader.read()
    assert.ok(after.done, '关流后不再投递新帧')
    controller.abort()
  })

  it('正常消费者逐块持续读取不受背压影响', { timeout: 60_000 }, async () => {
    // 16 KiB 预算远大于单帧，但同步 burst 会瞬间堆积（读取是异步的），
    // 故逐块交替发布/等待验证正常消费者水远不被误关。
    const { hub } = makeFixture({ maxPendingBytes: 16 * 1024 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const chunks: string[] = []
    const reading = readAll(response, (t) => chunks.push(t))
    await waitFor(() => chunks.length >= 1)
    for (let i = 0; i < 50 && hub.subscriberCount > 0; i++) {
      hub.publish('notification', { level: 'info', title: `事件${i}` })
      await waitFor(() => chunks.join('').includes(`事件${i}`))
    }
    assert.equal(hub.subscriberCount, 1, '逐块读取的消费者保持订阅')
    controller.abort()
    await reading
  })
})

// ---------------------------------------------------------------------------
// 快照竞态：订阅先于快照，无丢帧
// ---------------------------------------------------------------------------

describe('EventHub 快照竞态', { timeout: 60_000 }, () => {
  it('快照取定后、冲刷前发布的事件（seq 更大）必达且不重复', { timeout: 60_000 }, async () => {
    // initialSeq 与 snapshot.seq 对齐为 5；发布后的 seq=6 事件必须出现在流中。
    const { hub, snapshotValue } = makeFixture({ initialSeq: 5 })
    snapshotValue.conversations = [summary(1, '竞态基线')]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    const frames: Array<{ event: string; data: unknown }> = []
    const reading = readAll(response, (text) => {
      for (const f of parseSse(text)) frames.push(f)
    })
    await waitFor(() => frames.length >= 1 && frames[0]?.event === 'snapshot')
    // snapshot.seq=5；发布 seq=6 事件，必须出现在流中。
    hub.publish('notification', { level: 'warning', title: '竞态事件' })
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
    assert.equal((eventFrames[0]?.data.event as { title?: string }).title, '竞态事件')
  })

  it('snapshot provider 同步重入发布：订阅缓冲阶段溢出被明确关流', { timeout: 60_000 }, async () => {
    // provider 首次被调用同步发布 600 个事件（>512 缓冲上限）。
    let reentrant = false
    const persisted: number[] = []
    const snapValue: HelmSnapshot = { seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }
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
    // 读到流结束：溢出发生在快照返回前，流可能零帧即关（客户端重连取新快照）。
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.ok(!text.includes('r599'), '不得截断续传（丢帧后伪装完整流）')
    assert.equal(hub.subscriberCount, 0, '缓冲溢出后订阅被明确移除')
    controller.abort()
  })
})

// ---------------------------------------------------------------------------
// 脱敏：快照与事件
// ---------------------------------------------------------------------------

describe('EventHub 脱敏', { timeout: 60_000 }, () => {
  it('首帧 snapshot 递归脱敏：secret 明文（含字段名）绝不出现', { timeout: 60_000 }, async () => {
    const { hub, snapshotValue } = makeFixture()
    hub.redactFn = (t) => t.replaceAll('sk-secret', '[REDACTED]')
    snapshotValue.conversations = [
      { ...summary(1, '密钥会话'), doing: 'upload sk-secret-token' },
    ]
    const controller = new AbortController()
    const response = hub.response(new Request('http://x', { signal: controller.signal }))
    // 未 abort 先读：服务端未关流时 readAll 会挂起，故用带超时的有限读验证首帧。
    assert.ok(response.body)
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value ?? new Uint8Array())
    controller.abort()
    await reader.cancel().catch(() => {})
    assert.ok(!text.includes('sk-secret'), '快照明文 secret 必须脱敏')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('publish 事件先字符串递归脱敏：带引号/换行的 payload 不漏', { timeout: 60_000 }, async () => {
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
    assert.ok(!JSON.stringify(frame).includes('leak-me'), '事件 payload 不得漏明文')
  })

  it('快照含非法 JSON 值（Date）：currentSnapshot 显式抛 HelmError 不静默转换', { timeout: 60_000 }, () => {
    const { hub, snapshotValue } = makeFixture()
    snapshotValue.conversations = [
      { ...summary(1, 'x'), createdAt: new Date(0) as unknown as number },
    ]
    assert.throws(() => hub.currentSnapshot(), /invalid_json_value|非 JSON/)
  })
})

// ---------------------------------------------------------------------------
// publish 序号时序与事件形状
// ---------------------------------------------------------------------------

describe('EventHub.publish 事件形状', { timeout: 60_000 }, () => {
  it('组装失败不推进 seq（mirror seq 一致），成功后 seq 连续持久化', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'a' })
    assert.equal(hub.seq, 1)
    assert.deepEqual(persistedSeqs, [1])
    assert.throws(() => hub.publish('conversation.deleted', { conversationId: 'NaN!' }))
    assert.equal(hub.seq, 1, '失败不推进序号')
    assert.deepEqual(persistedSeqs, [1], '失败不持久化序号')
    hub.publish('conversation.deleted', { conversationId: 7 })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('payload 含循环引用：publish 显式抛错，不静默降级', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const cyclic: Record<string, unknown> = { self: null }
    cyclic['self'] = cyclic
    assert.throws(() => hub.publish('custom.x', cyclic), /invalid_json_value|循环/)
    assert.equal(hub.seq, 0)
  })

  it('plugin.changed 接受完整信封 {type,plugin,ui} 与直接 {plugin,ui} 双形状；裸 summary 缺 ui 显式拒绝', { timeout: 60_000 }, () => {
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
    // 完整信封形状（PluginHost emitEvent 现状：{type, plugin, ui}）。
    hub.publish('plugin.changed', { type: 'plugin.changed', plugin, ui })
    // 直接 {plugin, ui} 形状。
    hub.publish('plugin.changed', { plugin, ui })
    off()
    const e1 = frames[0]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    const e2 = frames[1]?.event as { type: string; plugin: { id: string }; ui: unknown[] }
    assert.equal(e1.type, 'plugin.changed')
    assert.equal(e1.plugin.id, 'builtin:herdr')
    assert.deepEqual(e1.ui, ui, '信封形状 ui 完整携带')
    assert.ok(!('type' in (e1.plugin as Record<string, unknown>)), '信封拆包：plugin 内不得残留 type 嵌套')
    assert.equal(e2.type, 'plugin.changed')
    assert.equal(e2.plugin.id, 'builtin:herdr')
    assert.deepEqual(e2.ui, ui, '直传形状 ui 完整携带')
    // 旧裸 summary（缺 ui）不再接受：新契约无兼容垫片。
    assert.throws(() => hub.publish('plugin.changed', plugin), /plugin\.changed|invalid_event/)
    // 停用/卸载：ui 为空数组（客户端据此清除该插件贡献）。
    hub.publish('plugin.changed', { plugin, ui: [] })
    const off2 = hub.subscribe(() => {})
    off2()
  })

  it('core 其他类型同样接受信封/直传双形状', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const conv = summary(3, '双形状')
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

  it('conversation.upsert 非法形状显式拒绝且不推进 seq（缺字段/错类型/可选字段类型不符）', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // 非对象。
    assert.throws(() => hub.publish('conversation.upsert', 'not-a-summary'), /conversation\.upsert|invalid_event/)
    // 缺核心字段（无 title/status/updatedAt 等）。
    assert.throws(() => hub.publish('conversation.upsert', { id: 1, profileId: 'assistant' }), /conversation\.upsert/)
    // 核心字段类型错（status 非五态、id 非整数、tags 混入非 string）。
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
    // 可选字段存在但类型错（可缺不可错）。
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
    // 合法摘要（含可选字段）不受影响。
    hub.publish('conversation.upsert', {
      ...summary(4, 'ok'),
      ownedBy: 'bot',
      parentConversationId: 1,
      doing: 'bash: pnpm test',
    })
    assert.equal(hub.seq, 2)
    assert.deepEqual(persistedSeqs, [1, 2])
  })

  it('ask.upsert 非法形状显式拒绝且不推进 seq（缺字段/错状态/field 形状非法）', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    const baseAsk = {
      id: 'ask-1',
      conversationId: 3,
      title: '部署审批',
      fields: [{ name: 'approve', label: '是否批准', type: 'confirm' }],
      status: 'pending',
      createdAt: 1_000,
    }
    // 非对象。
    assert.throws(() => hub.publish('ask.upsert', 'oops'), /ask\.upsert|invalid_event/)
    // 缺核心字段。
    assert.throws(() => hub.publish('ask.upsert', { id: 'ask-1' }), /ask\.upsert/)
    // status 非四态。
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, status: 'expired' as never }), /ask\.upsert/)
    // id 空串 / conversationId 非整数 / fields 空数组。
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, id: '' }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, conversationId: 3.5 }), /ask\.upsert/)
    assert.throws(() => hub.publish('ask.upsert', { ...baseAsk, fields: [] }), /ask\.upsert/)
    // field 形状非法（type 非三选一、select 缺 options）。
    assert.throws(
      () => hub.publish('ask.upsert', { ...baseAsk, fields: [{ name: 'x', label: 'X', type: 'radio' as never }] }),
      /ask\.upsert/,
    )
    assert.throws(
      () => hub.publish('ask.upsert', {
        ...baseAsk,
        fields: [{ name: 'env', label: '环境', type: 'select' as never }],
      }),
      /ask\.upsert/,
    )
    // 可选字段类型错（expectedStateSeq 非整数）。
    assert.throws(
      () => hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: '3' as never }),
      /ask\.upsert/,
    )
    assert.equal(hub.seq, 1, '非法输入不推进 seq')
    assert.deepEqual(persistedSeqs, [1])
    // 合法 AskSpec（含可选字段）不受影响；answered 终态同样可发布。
    hub.publish('ask.upsert', { ...baseAsk, expectedStateSeq: 7, ownerPluginId: 'builtin:herdr' })
    hub.publish('ask.upsert', { ...baseAsk, id: 'ask-2', status: 'answered' as never })
    assert.equal(hub.seq, 3)
  })

  it('notification 非法载荷显式拒绝且不推进 seq（不静默修正 level/title）', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // 非法 level：不再静默折回 'info'。
    assert.throws(() => hub.publish('notification', { level: 'fatal', title: 'x' }), /notification|invalid_event/)
    assert.throws(() => hub.publish('notification', { title: '缺 level' }), /notification/)
    // 非法 title：不再静默替换为 'notification'。
    assert.throws(() => hub.publish('notification', { level: 'info' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: '' }), /notification/)
    assert.throws(() => hub.publish('notification', { level: 'info', title: 42 as never }), /notification/)
    // body 存在但非 string。
    assert.throws(() => hub.publish('notification', { level: 'info', title: 'x', body: 1 as never }), /notification/)
    // conversationId 存在但非整数。
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: 1.5 }),
      /notification/,
    )
    assert.throws(
      () => hub.publish('notification', { level: 'info', title: 'x', conversationId: '3' as never }),
      /notification/,
    )
    assert.equal(hub.seq, 1, '非法输入不推进 seq')
    assert.deepEqual(persistedSeqs, [1], '非法输入不持久化序号')
    // 合法载荷（可选字段省略/携带）不受影响。
    hub.publish('notification', { level: 'warning', title: '仅标题' })
    hub.publish('notification', { level: 'error', title: '全字段', body: '详情', conversationId: 9 })
    assert.equal(hub.seq, 3)
    assert.deepEqual(persistedSeqs, [1, 2, 3])
  })

  it('node.changed 接受信封/直传双形状，保留完整 NodeInfo 字段；removed 透传', { timeout: 60_000 }, () => {
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
    // 完整信封形状（KernelRuntime 现状：{type, node}）。
    hub.publish('node.changed', { type: 'node.changed', node })
    // 直接 {node} 形状（无信封 type）。
    hub.publish('node.changed', { node: { ...node, online: false, lastSeenAt: 3_000 } })
    // removed: true（removeNode 统一发布）。
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
    assert.equal(e1.node.health?.diskTotalBytes, 4, '完整真实 NodeInfo 字段保留（含 health）')
    assert.equal('removed' in e1, false, '无 removed 字段时不携带')
    const e2 = frames[1]?.event
    assert.ok(e2 && 'node' in e2)
    assert.equal(e2.node.online, false)
    assert.equal(e2.node.lastSeenAt, 3_000)
    const e3 = frames[2]?.event
    assert.ok(e3 && 'node' in e3)
    assert.equal(e3.node.id, 'gpu-box')
    assert.equal(e3.removed, true, 'removed: true 透传（Web 据此从列表移除）')
    // 事件形状满足 Web applyEventFrame 的 'node' in event 判定（不再坠入 Custom payload 嵌套）。
    assert.ok(!('payload' in e1), '不得坠入 CustomHelmEvent payload 嵌套')
  })

  it('node.changed 非法输入显式拒绝且不推进 seq', { timeout: 60_000 }, () => {
    const { hub, persistedSeqs } = makeFixture()
    hub.publish('notification', { level: 'info', title: 'baseline' })
    assert.equal(hub.seq, 1)
    // 缺 node。
    assert.throws(() => hub.publish('node.changed', { type: 'node.changed' }), /node\.changed|invalid_event/)
    // node 缺 id / id 非字符串 / 空串。
    assert.throws(() => hub.publish('node.changed', { node: { kind: 'byom', online: true } }), /node\.changed/)
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 42 as unknown as string, kind: 'byom', online: true } }),
      /node\.changed/,
    )
    assert.throws(() => hub.publish('node.changed', { node: { id: '', kind: 'byom', online: true } }), /node\.changed/)
    // 非法 kind。
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'ssh' as never, online: true } }),
      /node\.changed/,
    )
    // online 非 boolean。
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: 'yes' as never } }),
      /node\.changed/,
    )
    // removed 非 boolean（若存在）。
    assert.throws(
      () => hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: false }, removed: 'true' as never }),
      /removed/,
    )
    // node 非对象。
    assert.throws(() => hub.publish('node.changed', 'gpu-box'), /node\.changed/)
    // 全部失败不推进 seq、不持久化。
    assert.equal(hub.seq, 1, '非法输入不推进 seq')
    assert.deepEqual(persistedSeqs, [1], '非法输入不持久化序号')
    // 合法发布恢复正常。
    hub.publish('node.changed', { node: { id: 'x', kind: 'byom', online: true } })
    assert.equal(hub.seq, 2)
  })

  it('未知 type 透传 CustomHelmEvent {type,payload}，不伪装成 notification', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: HelmEventFrame[] = []
    const off = hub.subscribe((f) => frames.push(f))
    hub.publish('workflow.progress', { step: 3, detail: { done: true } })
    hub.publish('herdr.pane.update', 'pane-2 附加信息')
    hub.publish('notification', { level: 'error', title: 't' })
    off()
    assert.equal(frames.length, 3)
    const e1 = frames[0]?.event as { type: string; payload: unknown }
    assert.equal(e1.type, 'workflow.progress')
    assert.deepEqual(e1.payload, { step: 3, detail: { done: true } })
    const e2 = frames[1]?.event as { type: string; payload: unknown }
    assert.equal(e2.type, 'herdr.pane.update')
    assert.equal(e2.payload, 'pane-2 附加信息')
    // 六个 core 类型保持强契约：不进入 Custom 分支。
    const core = frames[2]?.event as { type: string; title?: string; payload?: unknown }
    assert.equal(core.type, 'notification')
    assert.equal(core.title, 't')
    assert.equal(core.payload, undefined, 'notification 不携带 payload 字段')
  })

  it('订阅回调抛错只隔离该订阅，不影响其他订阅者', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const good: HelmEventFrame[] = []
    const bad = (): void => {
      throw new Error('consumer boom')
    }
    hub.subscribe(bad)
    hub.subscribe((f) => good.push(f))
    assert.doesNotThrow(() => hub.publish('notification', { level: 'info', title: '隔离' }))
    assert.equal(good.length, 1)
    assert.equal((good[0]?.event as { title?: string }).title, '隔离')
  })
})

// ---------------------------------------------------------------------------
// sseStream：可编程消费（含退订）
// ---------------------------------------------------------------------------

describe('EventHub.sseStream 可编程消费', { timeout: 60_000 }, () => {
  it('返回退订句柄；消费 return false 即退订；退订后 publish 不再投递', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const frames: SseFrame[] = []
    const sub = hub.sseStream((frame) => {
      frames.push(frame)
      return frames.length < 2 // 第二帧后返回 false
    })
    assert.equal(hub.subscriberCount, 1)
    hub.publish('notification', { level: 'info', title: '一' })
    hub.publish('notification', { level: 'info', title: '二' })
    assert.equal(hub.subscriberCount, 0, 'return false 后自动退订')
    hub.publish('notification', { level: 'info', title: '三' })
    assert.equal(frames.length, 2)
    sub.unsubscribe() // 幂等
    assert.equal(hub.subscriberCount, 0)
  })

  it('消费者抛错：退订清理且异常不逃逸到 publish', { timeout: 60_000 }, () => {
    const { hub } = makeFixture()
    const other: HelmEventFrame[] = []
    hub.subscribe((f) => other.push(f))
    hub.sseStream(() => {
      throw new Error('boom')
    })
    hub.publish('notification', { level: 'info', title: 'after' })
    assert.equal(hub.subscriberCount, 1, '抛错订阅被清理，仅剩正常订阅')
    assert.equal(other.length, 1)
  })

  it('sseStream 内快照后冲刷缓冲帧（无丢帧、seq 严格大于快照）', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ initialSeq: 2 })
    const frames: SseFrame[] = []
    // 订阅回调中发布（快照刚取定、冲刷前的经典竞态）。
    const sub = hub.sseStream((frame) => {
      frames.push(frame)
      if (frames.length === 1) {
        queueMicrotask(() => hub.publish('notification', { level: 'info', title: '竞态增量' }))
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
// 空闲心跳（keepalive）：代理/中间层保活 + 客户端卡死检测依据
// ---------------------------------------------------------------------------

describe('EventHub SSE 空闲心跳', { timeout: 60_000 }, () => {
  it('空闲连接周期收到 : keepalive 注释行：不携带 event/data、不伪造业务事件、不推进 seq', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    assert.match(decoder.decode(first.value ?? new Uint8Array()), /event: snapshot/)

    // 下一个 chunk 应是心跳注释行（: 开头，无 event:/data:，解析不出任何帧）。
    const beat = await readWithDeadline(reader)
    const beatText = decoder.decode(beat.value ?? new Uint8Array())
    assert.ok(beatText.startsWith(':'), `心跳应是 SSE 注释行，实际: ${beatText}`)
    assert.ok(!beatText.includes('event:') && !beatText.includes('data:'), '心跳不得伪造业务事件')
    // 真实客户端 SseParser 跳过 : 开头注释行（live-state.test.ts 已锁定）：
    // 心跳文本解析不出任何携带 data 的帧。
    assert.ok(parseSse(beatText).every((frame) => frame.data === null), '心跳不得携带数据帧')
    assert.equal(hub.seq, 0, '心跳不推进事件序号')

    // 心跳不干扰业务事件：发布后事件帧照常到达。
    hub.publish('notification', { level: 'info', title: '心跳间事件' })
    const eventChunk = await readWithDeadline(reader)
    assert.match(decoder.decode(eventChunk.value ?? new Uint8Array()), /event: notification/)
    controller.abort()
    await reader.cancel().catch(() => {})
  })

  it('abort 后心跳 timer 随 shutdown 清理：退订关流，无后续字节（进程不因泄漏 timer 挂起）', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    controller.abort()
    assert.equal(hub.subscriberCount, 0, 'abort 后立即退订')

    // 服务端已关流：耗尽已入队字节后读到 done。
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    // 等待多个心跳周期：泄漏的 interval 会保持事件循环存活使套件无法退出
    // （本套件能正常结束即问接验证 timer 已清理），且不会再写入任何字节。
    await new Promise((r) => setTimeout(r, 100))
    const after = await reader.read()
    assert.ok(after.done, '关流后不再有心跳字节')
  })

  it('ReadableStream.cancel 同样清理心跳 timer（客户端主动断开）', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 20 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    await reader.cancel()
    assert.equal(hub.subscriberCount, 0, 'cancel 后立即退订')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(hub.subscriberCount, 0)
    controller.abort()
  })

  it('心跳受字节背压有界约束：不读的慢消费者堆积超限被明确关流', { timeout: 60_000 }, async () => {
    // 128B 上限：单条心跳约 14B，10 次内必触发。
    const { hub } = makeFixture({ keepaliveMs: 5, maxPendingBytes: 128 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value ?? new Uint8Array()), /event: snapshot/)
    // 不再读：心跳字节持续堆积，超限即慢客户端明确关流（绝不满仓无限排队）。
    await waitFor(() => hub.subscriberCount === 0)
    let done = false
    while (!done) {
      const next = await reader.read()
      done = next.done === true
    }
    controller.abort()
  })

  it('keepaliveMs 非正值停用心跳：空闲流不再写入任何字节', { timeout: 60_000 }, async () => {
    const { hub } = makeFixture({ keepaliveMs: 0 })
    const controller = new AbortController()
    const response = hub.response(new Request('http://x/api/events', { signal: controller.signal }))
    assert.ok(response.body)
    const reader = response.body.getReader()
    await reader.read() // snapshot
    // 等待起过一个默认心跳周期仍无任何写入（read 持续 pending，用短 Deadline 反证）。
    await new Promise((r) => setTimeout(r, 60))
    const pending = reader.read()
    const won = await Promise.race([pending.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 80))])
    assert.equal(won, false, '停用心跳后空闲流不应再有字节到达')
    controller.abort()
    await reader.cancel().catch(() => {})
  })
})
