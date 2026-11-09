/**
 * 会话文档专用订阅通道（lib/session-docs.ts）状态机测试：
 * - ref-count：首个订阅者才开 events 流（初始值也来自首帧 snapshot，无独立 GET），
 *   归零 abort 并清缓存；
 * - 鉴权：所有出站请求携带 Authorization: Bearer；
 * - 快照/更新帧应用、单连接内 seq 单调（迟到旧帧丢弃）、连接代际隔离
 *   （旧连接迟到帧/旧 controller abort 不得写坏新连接）；
 * - 404/403 等非重试 4xx 显式终态报错不重连；5xx 按退避重连且重连 snapshot
 *   以服务端为准；401 发 helm:unauthorized；
 * - delete 帧 value=initial（reset 语义）照常暴露初始值；
 * - evict（插件停用/会话删除）显式报错且条目保留至全部退订；reset（登出）清一切；
 * - retry 推进连接代际重建流；
 * - bindSessionDocRuntime 返回恢复函数，作用域隔离。
 * 用受控假 fetch（真实 Response/ReadableStream）驱动，不 mock 模块内部。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bindSessionDocRuntime,
  evictSessionDocSubscriptions,
  evictSessionDocsOfConversation,
  getSessionDocState,
  resetSessionDocSubscriptions,
  retrySessionDoc,
  subscribeSessionDoc,
  type SessionDocKey,
} from '../src/lib/session-docs.js'

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
function openStream(firstFrame?: string): { response: Response; closed: () => boolean } {
  let closed = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        if (firstFrame !== undefined) controller.enqueue(encoder.encode(firstFrame))
      },
      cancel() {
        closed = true
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
  return { response, closed: () => closed }
}

const snapshotFrame = (seq: number, doc: Record<string, unknown>): string =>
  `event: snapshot\ndata: ${JSON.stringify({ seq, doc })}\n\n`
const updateFrame = (seq: number, doc: Record<string, unknown>): string =>
  `event: plugin.session_doc.updated\ndata: ${JSON.stringify({ seq, event: { type: 'plugin.session_doc.updated', seq, doc } })}\n\n`

const key: SessionDocKey = { pluginId: 'builtin:workflow', docName: 'runs', conversationId: 42 }

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(cond: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await flushMicrotasks()
}

test('ref-count：首个订阅者开流且携带 Bearer，归零中止并清缓存', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () => sseResponse([]), () => 'tok-1')
  try {
    const requests: RecordedRequest[] = []
    const stream = openStream(snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { runs: [] } }))
    restore()
    bindSessionDocRuntime(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), init })
      return stream.response
    }, () => 'tok-1')

    const off1 = subscribeSessionDoc(key, () => {})
    await until(() => getSessionDocState(key).hasValue)
    assert.equal(requests.length, 1, '首个订阅者开一条 events 流，且不再有独立初始 GET')
    assert.ok(requests[0]!.path.includes('/events'), `events 路径：${requests[0]!.path}`)
    const auth = (requests[0]!.init?.headers as Record<string, string>)?.Authorization
    assert.equal(auth, 'Bearer tok-1', '请求携带 Bearer token')

    const off2 = subscribeSessionDoc(key, () => {})
    await flushMicrotasks()
    assert.equal(requests.length, 1, '第二个订阅者不开新流')

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

    const off3 = subscribeSessionDoc(key, () => {})
    await flushMicrotasks()
    assert.equal(requests.length, 2, '重新挂载重新开流')
    off3()
  } finally {
    restore()
  }
})

test('SSE 更新帧实时更新值；delete 帧回落 initial（reset 语义）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    assert.ok(String(input).includes('/events'))
    return sseResponse([
      snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 1 } }),
      updateFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 2 } }),
      updateFrame(3, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 0 }, deleted: true }),
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

test('帧形状/seq 非法显式报错不静默吞帧', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () =>
    sseResponse([
      `event: snapshot\ndata: ${JSON.stringify({ seq: 1, doc: { pluginId: 'other:plugin', name: 'runs', conversationId: 42, value: 1 } })}\n\n`,
    ]),
  )
  const off = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('目标不匹配'), '错目标帧显式报错')
  off()
  restore()

  // snapshot 缺少 value 字段
  const restore2 = bindSessionDocRuntime(async () =>
    sseResponse([
      `event: snapshot\ndata: ${JSON.stringify({ seq: 1, doc: { pluginId: key.pluginId, name: key.docName, conversationId: 42 } })}\n\n`,
    ]),
  )
  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('缺少 value'), '缺 value 显式报错')
  off2()
  restore2()

  // snapshot seq 非法（负数）
  const restore3 = bindSessionDocRuntime(async () =>
    sseResponse([
      `event: snapshot\ndata: ${JSON.stringify({ seq: -1, doc: { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 1 } })}\n\n`,
    ]),
  )
  const off3 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).error !== undefined)
  assert.ok(getSessionDocState(key).error!.includes('seq 非法'), '负 seq 显式报错')
  off3()
  restore3()
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
  assert.ok(state.error!.includes('会话文档订阅不可用'), `显式错误：${state.error}`)
  assert.equal(getSessionDocState(key).hasValue, false)
  await new Promise((resolve) => setTimeout(resolve, 1200))
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
  await new Promise((resolve) => setTimeout(resolve, 1200))
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
    await new Promise((resolve) => setTimeout(resolve, 1200))
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
  await new Promise((resolve) => setTimeout(resolve, 1600))
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
  assert.ok(state.error !== undefined && state.error.includes('会话 42 已删除'), `会话删除显式报错：${String(state.error)}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls, 1, '会话删除后不再重连')
  off()
  await flushMicrotasks()
  assert.equal(getSessionDocState(key).hasValue, false, '全部退订后条目移除')

  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  evictSessionDocSubscriptions('builtin:workflow')
  state = getSessionDocState(key)
  assert.ok(state.error !== undefined && state.error.includes('已停用'), `插件停用显式报错：${String(state.error)}`)
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
  // 第一条流：开启但挂起；retry 触发旧 controller.abort()，其 onAbort 运行时
  // 新连接已建立（entry.controller 已指向新 controller），不得被清掉。
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
              // 不 close：保持挂着等 abort
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
  // 新连接仍在：connected 且无错误（若旧 onAbort 误清新 controller 并引发异常路径，
  // 错误会浮现）
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
  assert.ok(getSessionDocState(key).error!.includes('订阅中断'), `网络错误显式暴露：${getSessionDocState(key).error}`)
  off()
  const callsAfterOff = calls
  await new Promise((resolve) => setTimeout(resolve, 1200))
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
  inner()
  const off2 = subscribeSessionDoc(key, () => {})
  await until(() => getSessionDocState(key).hasValue)
  assert.equal(getSessionDocState(key).value, 'outer', '内层恢复后回落外层实现')
  off2()
  outer()
})
