/**
 * 会话文档专用单流多路复用订阅通道（lib/session-docs.ts）状态机测试：
 * - 单流多路复用：同批/防抖窗口内的多元组订阅合并为单条 `/api/session-docs/events?sub=...` 流
 *   （经 encodeSessionDocSubParam 编码），集合不变时不重建流，归零后关闭流并清缓存；
 * - 短防抖聚合（50ms 默认 / 测试注入 `subscribeDebounceMs`）；
 * - 鉴权：所有出站请求携带 Authorization: Bearer；
 * - 按 (pluginId, name, conversationId) 隔离分发 `SessionDocMultiplexFrame`：
 *   `snapshot` 重置该 tuple 基线，`updated` / `deleted` 按 seq 单调更新（迟到旧帧丢弃），
 *   单 tuple 帧格式错误仅影响该 tuple 不波及其他健康订阅；
 * - 30s 空闲看门狗（`readSseChunkWithDeadline`）对半开僵尸流检测与重连；
 * - 404/403 等非重试 4xx 显式报错不重连；5xx 按退避重连且重连 snapshot 对齐；401 发 helm:unauthorized；
 * - delete 帧 value=initial（reset 语义）照常暴露初始值；
 * - evict（插件停用/会话删除）显式报错且条目保留至退订；reset（登出）立即中止共享流并清一切；
 * - retry 推进连接代际（旧连接迟到帧/旧 abort 不得写坏新连接）；
 * - bindSessionDocRuntime 返回恢复函数，作用域隔离。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { encodeSessionDocSubParam, type SessionDocMultiplexFrame } from '@helm/protocol'
import {
  bindSessionDocRuntime,
  evictSessionDocSubscriptions,
  evictSessionDocsOfConversation,
  getSessionDocState,
  resetSessionDocSubscriptions,
  retrySessionDoc,
  sessionDocTimings,
  subscribeSessionDoc,
  type SessionDocKey,
} from '../src/lib/session-docs.js'

const originalSessionDocTimings = { ...sessionDocTimings }

before(() => {
  Object.assign(sessionDocTimings, {
    reconnectBaseMs: 25,
    reconnectCapMs: 120,
    subscribeDebounceMs: 0,
    idleTimeoutMs: 30_000,
  })
})

after(() => {
  Object.assign(sessionDocTimings, originalSessionDocTimings)
})

interface RecordedRequest {
  path: string
  init: RequestInit | undefined
}

function sseResponse(frames: string[], onOpen?: () => void): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      onOpen?.()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 永不结束的 events 流（观察 abort 行为用）。 */
function openStream(firstFrame?: string): { response: Response; closed: () => boolean; push: (frame: string) => void } {
  let closed = false
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller
        if (firstFrame !== undefined) controller.enqueue(encoder.encode(firstFrame))
      },
      cancel() {
        closed = true
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
  return {
    response,
    closed: () => closed,
    push: (frame: string) => {
      if (!closed) ctrl?.enqueue(encoder.encode(frame))
    },
  }
}

const multiplexFrame = (
  action: SessionDocMultiplexFrame['action'],
  seq: number,
  doc: Record<string, unknown>,
  target?: Partial<{ pluginId: string; name: string; conversationId: number }>,
): string => {
  const pluginId = target?.pluginId ?? String(doc['pluginId'])
  const name = target?.name ?? String(doc['name'])
  const conversationId = target?.conversationId ?? Number(doc['conversationId'])
  return `event: ${action}\ndata: ${JSON.stringify({ action, pluginId, name, conversationId, seq, doc })}\n\n`
}

const snapshotFrame = (seq: number, doc: Record<string, unknown>): string => multiplexFrame('snapshot', seq, doc)
const updateFrame = (seq: number, doc: Record<string, unknown>): string =>
  multiplexFrame(doc['deleted'] === true ? 'deleted' : 'updated', seq, doc)

const key: SessionDocKey = { pluginId: 'builtin:workflow', docName: 'runs', conversationId: 42 }
const statsKey: SessionDocKey = { pluginId: 'builtin:workflow', docName: 'stats', conversationId: 42 }
const otherConvKey: SessionDocKey = { pluginId: 'builtin:token-speed', docName: 'speed', conversationId: 7 }

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(cond: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await flushMicrotasks()
}

test('ref-count：首个订阅者开多路复用流且携带 Bearer，归零中止并清缓存', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const requests: RecordedRequest[] = []
  const stream = openStream(snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { runs: [] } }))
  const restore = bindSessionDocRuntime(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init })
    return stream.response
  }, () => 'tok-1')
  try {
    const off1 = subscribeSessionDoc(key, () => {})
    await until(() => getSessionDocState(key).hasValue)
    assert.equal(requests.length, 1, '首个订阅者开一条 /api/session-docs/events 流')
    const url = new URL(requests[0]!.path, 'http://localhost')
    assert.equal(url.pathname, '/api/session-docs/events')
    assert.deepEqual(url.searchParams.getAll('sub'), [
      encodeSessionDocSubParam({ pluginId: key.pluginId, name: key.docName, conversationId: 42 }),
    ])
    const auth = (requests[0]!.init?.headers as Record<string, string>)?.Authorization
    assert.equal(auth, 'Bearer tok-1', '请求携带 Bearer token')

    const off2 = subscribeSessionDoc(key, () => {})
    await flushMicrotasks()
    assert.equal(requests.length, 1, '订阅集合不变时不开新流/不重建流')

    const state = getSessionDocState(key)
    assert.equal(state.hasValue, true)
    assert.deepEqual(state.value, { runs: [] })

    off1()
    await flushMicrotasks()
    assert.equal(getSessionDocState(key).hasValue, true, '仍有订阅者时保留缓存')
    off2()
    await flushMicrotasks()
    assert.ok(stream.closed(), '归零后中止流')
    assert.equal(getSessionDocState(key).hasValue, false, '归零后清缓存')

    const stream2 = openStream(snapshotFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { runs: [1] } }))
    restore()
    const restore2 = bindSessionDocRuntime(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), init })
      return stream2.response
    }, () => 'tok-1')
    try {
      const off3 = subscribeSessionDoc(key, () => {})
      await until(() => getSessionDocState(key).hasValue)
      assert.equal(requests.length, 2, '重新挂载重新开流')
      off3()
    } finally {
      restore2()
    }
  } finally {
    restore()
    resetSessionDocSubscriptions()
  }
})

test('多元组聚合防抖与单流多路复用：同窗口多订阅合并为单条请求且按 tuple 隔离 seq/错误', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  assert.equal(originalSessionDocTimings.subscribeDebounceMs, 50, '生产默认聚合防抖应约为 50ms')
  assert.equal(originalSessionDocTimings.idleTimeoutMs, 30_000, '默认空闲超时应为 30_000ms')
  sessionDocTimings.subscribeDebounceMs = 20

  const requests: string[] = []
  let activeStream: ReturnType<typeof openStream> | undefined
  const restore = bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    activeStream = openStream(
      [
        snapshotFrame(10, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'runs-10' }),
        snapshotFrame(5, { pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42, value: 'stats-5' }),
        snapshotFrame(1, { pluginId: otherConvKey.pluginId, name: otherConvKey.docName, conversationId: 7, value: 'speed-1' }),
      ].join(''),
    )
    return activeStream.response
  })

  try {
    const offA = subscribeSessionDoc(key, () => {})
    const offB = subscribeSessionDoc(statsKey, () => {})
    const offC = subscribeSessionDoc(otherConvKey, () => {})
    // 防抖窗口内尚未发起请求
    assert.equal(requests.length, 0, '防抖窗口内暂缓建流以聚合订阅集合')

    await until(() => getSessionDocState(key).hasValue && getSessionDocState(statsKey).hasValue && getSessionDocState(otherConvKey).hasValue)
    assert.equal(requests.length, 1, '多个并发订阅聚合为单条多路复用请求')

    const parsed = new URL(requests[0]!, 'http://localhost')
    assert.equal(parsed.pathname, '/api/session-docs/events')
    assert.deepEqual(
      parsed.searchParams.getAll('sub').sort(),
      [
        encodeSessionDocSubParam({ pluginId: key.pluginId, name: key.docName, conversationId: 42 }),
        encodeSessionDocSubParam({ pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42 }),
        encodeSessionDocSubParam({ pluginId: otherConvKey.pluginId, name: otherConvKey.docName, conversationId: 7 }),
      ].sort(),
    )

    // 隔离验证：key 收到 seq=20，stats 收到 seq=6（互不干扰），key 迟到旧帧 seq=15 丢弃
    activeStream!.push(updateFrame(20, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'runs-20' }))
    activeStream!.push(updateFrame(6, { pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42, value: 'stats-6' }))
    activeStream!.push(updateFrame(15, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'runs-old' }))
    await until(() => getSessionDocState(statsKey).value === 'stats-6')
    assert.equal(getSessionDocState(key).value, 'runs-20', 'key 不应被迟到旧帧覆盖，也不被 stats seq=6 干扰')
    assert.equal(getSessionDocState(statsKey).value, 'stats-6')

    // snapshot 重置单个 tuple 基线：stats 收到 seq=2 snapshot 重置其水位后，seq=3 可用，但 key 的基线不变
    activeStream!.push(snapshotFrame(2, { pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42, value: 'stats-reset' }))
    activeStream!.push(updateFrame(3, { pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42, value: 'stats-3' }))
    activeStream!.push(updateFrame(18, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'runs-18-stale' }))
    await until(() => getSessionDocState(statsKey).value === 'stats-3')
    assert.equal(getSessionDocState(key).value, 'runs-20', '其他 tuple snapshot 重置不得破坏 key 的 seq 基线')

    // 同一集合再添重复订阅者（经防抖后集合未变）：绝不重建流
    const offA2 = subscribeSessionDoc(key, () => {})
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(requests.length, 1, '集合未变化不重建共享流')

    offA()
    offA2()
    offB()
    offC()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(activeStream!.closed(), '所有订阅退订后关闭流')
  } finally {
    sessionDocTimings.subscribeDebounceMs = 0
    restore()
    resetSessionDocSubscriptions()
  }
})

test('SSE 更新帧实时更新值；delete 帧回落 initial（reset 语义）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    assert.ok(String(input).startsWith('/api/session-docs/events?sub='))
    return sseResponse([
      snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 1 } }),
      updateFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 2 } }),
      multiplexFrame('deleted', 3, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 0 }, deleted: true }),
    ])
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).deleted)
  assert.deepEqual(getSessionDocState(key).value, { n: 0 }, 'delete 帧 value=initial 照常暴露')
  assert.equal(getSessionDocState(key).deleted, true, 'deleted 标记')
  off()
  restore()
})

test('单连接内 seq 单调：迟到旧帧丢弃，不要求连续', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () =>
    sseResponse([
      snapshotFrame(10, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'v10' }),
      updateFrame(20, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'v20' }),
      // 迟到旧帧（seq 回退）：丢弃，不覆盖 v20
      updateFrame(15, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'v15-old' }),
      // seq 不连续（跨 tuple 计数）：仍接受
      updateFrame(33, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'v33' }),
    ]),
  )
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).value === 'v33')
  assert.equal(getSessionDocState(key).value, 'v33')
  assert.equal(getSessionDocState(key).error, undefined, '迟到旧帧静默丢弃不报错')
  off()
  restore()
})

test('帧形状/seq 非法显式报错不静默吞帧（单 tuple 错误不波及同流其他 tuple）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () =>
    sseResponse([
      multiplexFrame(
        'snapshot',
        1,
        { pluginId: 'other:plugin', name: 'runs', conversationId: 42, value: 1 },
        { pluginId: key.pluginId, name: key.docName, conversationId: 42 },
      ),
      snapshotFrame(1, { pluginId: statsKey.pluginId, name: statsKey.docName, conversationId: 42, value: 'healthy' }),
    ]),
  )
  const off = subscribeSessionDoc(key, () => {})
  const offStats = subscribeSessionDoc(statsKey, () => {})
  await until(() => getSessionDocState(key).error !== undefined && getSessionDocState(statsKey).hasValue)
  assert.ok(getSessionDocState(key).error!.includes('target mismatch'), '错目标帧显式报错')
  assert.equal(getSessionDocState(statsKey).value, 'healthy', '同流其他 tuple 保持正常')
  off()
  offStats()
  restore()

  // snapshot 缺少 value 字段
  const restore2 = bindSessionDocRuntime(async () =>
    sseResponse([
      multiplexFrame('snapshot', 1, { pluginId: key.pluginId, name: key.docName, conversationId: 42 }),
    ]),
  )
  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('missing the value field'), '缺 value 显式报错')
  off2()
  restore2()

  // snapshot seq 非法（负数）
  const restore3 = bindSessionDocRuntime(async () =>
    sseResponse([
      multiplexFrame('snapshot', -1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 1 }),
    ]),
  )
  const off3 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('frame invalid'), '负 seq 显式报错')
  off3()
  restore3()
})

test('空闲看门狗（30s 对齐）：半开挂起流超时中断并指数退避重连对齐', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  sessionDocTimings.idleTimeoutMs = 45
  let attempt = 0
  const hanging = openStream(snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'stale' }))
  const restore = bindSessionDocRuntime(async () => {
    attempt++
    if (attempt === 1) return hanging.response
    return sseResponse([
      snapshotFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'recovered' }),
    ])
  })
  try {
    const off = subscribeSessionDoc(key, () => {})
    await until(() => getSessionDocState(key).value === 'stale')
    await new Promise((resolve) => setTimeout(resolve, 120))
    await until(() => getSessionDocState(key).value === 'recovered')
    assert.ok(attempt >= 2, `挂起流 idle timeout 后必须触发重连（attempt=${attempt}）`)
    assert.ok(hanging.closed(), '旧挂起流必须被取消释放')
    off()
  } finally {
    sessionDocTimings.idleTimeoutMs = 30_000
    restore()
    resetSessionDocSubscriptions()
  }
})

test('404 显式终态报错且不无穷重连', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let eventsCalls = 0
  const restore = bindSessionDocRuntime(async () => {
    eventsCalls++
    return new Response(JSON.stringify({ error: { code: 'plugin_doc_not_found', message: '文档不存在' } }), { status: 404 })
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  const state = getSessionDocState(key)
  assert.ok(state.error!.includes('Conversation document subscription unavailable'), `显式错误：${state.error}`)
  assert.equal(getSessionDocState(key).hasValue, false)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(eventsCalls, 1, '404 后不再重连')
  off()
  restore()
})

test('403 同样终态报错不重连；401 发 helm:unauthorized 且不再重连', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let calls = 0
  const restore = bindSessionDocRuntime(async () => {
    calls++
    return new Response(JSON.stringify({ error: { code: 'forbidden', message: '无权访问' } }), { status: 403 })
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('无权访问'))
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(calls, 1, '403 后不再重连')
  off()
  restore()

  // 401：浏览器环境派发 helm:unauthorized（Node 无 window 直接短路）
  calls = 0
  let unauthorized = 0
  const events: string[] = []
  ;(globalThis as Record<string, unknown>).window = {
    dispatchEvent: (e: Event) => {
      events.push(e.type)
      return true
    },
  }
  const restore2 = bindSessionDocRuntime(async () => {
    calls++
    return new Response(null, { status: 401 })
  })
  try {
    const off2 = subscribeSessionDoc(key, () => {})
    await until(() => events.length > 0)
    unauthorized = events.filter((t) => t === 'helm:unauthorized').length
    assert.equal(unauthorized, 1, '401 派发 helm:unauthorized 一次')
    assert.equal(getSessionDocState(key).error, undefined, '401 不置订阅错误（由宿主统一登出处理）')
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(calls, 1, '401 后不再重连')
    off2()
  } finally {
    delete (globalThis as Record<string, unknown>).window
    restore2()
  }
})

test('5xx 有界退避重连且重连 snapshot 以服务端为准', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let attempt = 0
  const restore = bindSessionDocRuntime(async () => {
    attempt++
    if (attempt === 1) return new Response(null, { status: 500 })
    return sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { authoritative: true } })])
  })
  const off = subscribeSessionDoc(key, () => {})
  await new Promise((resolve) => setTimeout(resolve, 140))
  await until(() => getSessionDocState(key).hasValue)
  assert.deepEqual(getSessionDocState(key).value, { authoritative: true }, '重连 snapshot 服务端对齐')
  assert.equal(attempt, 2, '恰好重连一次')
  off()
  restore()
})

test('evict（插件停用/会话删除）显式报错，条目保留至退订且不再重连', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let calls = 0
  const restore = bindSessionDocRuntime(async () => {
    calls++
    return sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 1 })])
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  assert.equal(getSessionDocState(key).hasValue, true)

  evictSessionDocsOfConversation(42)
  let state = getSessionDocState(key)
  assert.ok(state.error !== undefined && state.error.includes('Conversation 42 deleted'), `会话删除显式报错：${String(state.error)}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls, 1, '会话删除后不再重连')
  off()
  await flushMicrotasks()
  assert.equal(getSessionDocState(key).hasValue, false, '全部退订后条目移除')

  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  evictSessionDocSubscriptions('builtin:workflow')
  state = getSessionDocState(key)
  assert.ok(state.error !== undefined && state.error.includes('disabled'), `插件停用显式报错：${String(state.error)}`)
  off2()
  await flushMicrotasks()
  assert.equal(getSessionDocState(key).hasValue, false, '退订后清缓存')

  const off3 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  resetSessionDocSubscriptions()
  assert.equal(getSessionDocState(key).hasValue, false, '登出 reset 清缓存')
  off3()
  restore()
})

test('retry 推进连接代际：旧连接迟到帧不得写进新连接', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let resolveOld: ((value: Response) => void) | undefined
  let oldStreamCancelled = false
  const restore = bindSessionDocRuntime(() => {
    // 旧连接：挂起不响应；retry 后的新连接立即返回权威 snapshot
    if (resolveOld === undefined) {
      return new Promise<Response>((resolve) => { resolveOld = resolve })
    }
    return Promise.resolve(
      sseResponse([snapshotFrame(7, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'fresh' })]),
    )
  })
  const off = subscribeSessionDoc(key, () => {})
  await flushMicrotasks()
  retrySessionDoc(key)
  await until(() => getSessionDocState(key).value === 'fresh')
  // 旧连接此时才响应，且携带一个旧值 snapshot：必须被连接代际作废
  resolveOld!(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(snapshotFrame(3, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'stale-old' })))
        },
        cancel() {
          oldStreamCancelled = true
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  )
  await flushMicrotasks()
  for (let i = 0; i < 10; i++) await flushMicrotasks()
  assert.equal(getSessionDocState(key).value, 'fresh', '旧连接迟到帧被丢弃')
  assert.ok(oldStreamCancelled, '旧连接底层流被取消')
  off()
  restore()
})

test('retry 后旧连接 abort 不误清新连接 controller', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let attempt = 0
  const restore = bindSessionDocRuntime(() => {
    attempt++
    if (attempt === 1) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(encoder.encode(snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'old' })))
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
    }
    return Promise.resolve(sseResponse([snapshotFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'new' })]))
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).value === 'old')
  retrySessionDoc(key)
  await until(() => getSessionDocState(key).value === 'new')
  await flushMicrotasks()
  assert.equal(getSessionDocState(key).connected, true, '新连接保持连接')
  assert.equal(getSessionDocState(key).error, undefined)
  assert.equal(attempt, 2)
  off()
  restore()
})

test('错误不无限重试：退避有上限且退订后停止', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let calls = 0
  const restore = bindSessionDocRuntime(async () => {
    calls++
    throw new TypeError('fetch failed')
  })
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('subscription interrupted'), `网络错误显式暴露：${getSessionDocState(key).error}`)
  off()
  const callsAfterOff = calls
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(calls, callsAfterOff, '归零退订后不再重试')
  restore()
})

test('bindSessionDocRuntime 恢复函数作用域隔离', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const outer = bindSessionDocRuntime(async () => sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'outer' })]))
  const inner = bindSessionDocRuntime(async () => sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'inner' })]))
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  assert.equal(getSessionDocState(key).value, 'inner', '内层注入生效')
  off()
  await flushMicrotasks()
  inner()
  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  assert.equal(getSessionDocState(key).value, 'outer', '内层恢复后回落外层实现')
  off2()
  outer()
})
