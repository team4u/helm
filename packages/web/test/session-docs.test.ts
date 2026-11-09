/**
 * 会话文档专用订阅通道（lib/session-docs.ts）状态机测试：
 * - ref-count：首个订阅者才连接（GET + events 流），归零 abort 并清缓存；
 * - 快照/更新帧应用、in-flight GET 与 SSE 竞态防旧值覆盖；
 * - 404 不无穷重连、非 404 按退避重连、重连 snapshot 服务端对齐；
 * - deleted 帧 value=initial（订阅者回落 undefined）；
 * - evict（插件停用/会话删除）与 reset（登出）中止一切。
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

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const snapshotFrame = (seq: number, doc: Record<string, unknown>): string =>
  `event: snapshot\ndata: ${JSON.stringify({ seq, doc })}\n\n`
const updateFrame = (seq: number, doc: Record<string, unknown>): string =>
  `event: plugin.session_doc.updated\ndata: ${JSON.stringify({ seq, event: { type: 'plugin.session_doc.updated', seq, doc } })}\n\n`

const key: SessionDocKey = { pluginId: 'builtin:workflow', docName: 'runs', conversationId: 42 }

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('ref-count：首个订阅者开流，归零中止并清缓存', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const requests: RecordedRequest[] = []
  let streamClosed = false
  bindSessionDocRuntime(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), init })
    const path = String(input)
    if (path.includes('/events')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { runs: [] } })))
            // 不 close：保持流开着，观察 abort
          },
          cancel() {
            streamClosed = true
          },
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { runs: [] } }), { status: 200 })
  })

  const off1 = subscribeSessionDoc(key, () => {})
  await flushMicrotasks()
  assert.equal(requests.filter((r) => r.path.includes('/events')).length, 1, '首个订阅者开一条 events 流')
  // 第二个订阅者复用同一条流
  const off2 = subscribeSessionDoc(key, () => {})
  await flushMicrotasks()
  assert.equal(requests.filter((r) => r.path.includes('/events')).length, 1, '第二个订阅者不开新流')

  const state = getSessionDocState(key)
  assert.equal(state.hasValue, true)
  assert.deepEqual(state.value, { runs: [] })

  off1()
  await flushMicrotasks()
  assert.equal(getSessionDocState(key).hasValue, true, '仍有订阅者时保留缓存')
  off2()
  await flushMicrotasks()
  assert.equal(streamClosed, true, '归零后中止流')
  assert.equal(getSessionDocState(key).hasValue, false, '归零后清缓存')
  // 再次订阅重新开流
  const off3 = subscribeSessionDoc(key, () => {})
  await flushMicrotasks()
  assert.equal(requests.filter((r) => r.path.includes('/events')).length, 2, '重新挂载重新开流')
  off3()
})

test('SSE 更新帧实时更新值；deleted 帧回落', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let off: (() => void) | undefined
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      return sseResponse([
        snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 1 } }),
        updateFrame(2, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 2 } }),
        updateFrame(3, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 3 }, deleted: true }),
      ])
    }
    return new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 0 } }), { status: 200 })
  })
  off = subscribeSessionDoc(key, () => {})
  // 等流读完
  for (let i = 0; i < 20 && getSessionDocState(key).hasValue === false; i++) await flushMicrotasks()
  assert.deepEqual(getSessionDocState(key).value, { n: 3 })
  assert.equal(getSessionDocState(key).deleted, true, 'deleted 帧标记删除')
  off!()
})

test('in-flight GET 迟到不得覆盖 SSE 新值', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let resolveGet: ((value: Response) => void) | undefined
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      // SSE 立即给新值 n=9
      return sseResponse([snapshotFrame(5, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 9 } })])
    }
    // GET 挂起，随后返回旧值 n=1
    return new Promise<Response>((resolve) => { resolveGet = resolve })
  })
  const off = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 20 && getSessionDocState(key).hasValue === false; i++) await flushMicrotasks()
  assert.deepEqual(getSessionDocState(key).value, { n: 9 }, 'SSE 先到达')
  resolveGet!(new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { n: 1 } }), { status: 200 }))
  for (let i = 0; i < 10; i++) await flushMicrotasks()
  assert.deepEqual(getSessionDocState(key).value, { n: 9 }, '迟到的 GET 旧值被丢弃')
  off()
})

test('404 显式报错且不无穷重连', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let eventsCalls = 0
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.includes('/events')) {
      eventsCalls++
      return new Response(JSON.stringify({ error: { code: 'plugin_doc_not_found', message: '文档不存在' } }), { status: 404 })
    }
    return new Response(JSON.stringify({ error: { code: 'plugin_doc_not_found', message: '文档不存在' } }), { status: 404 })
  })
  const off = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 10; i++) await flushMicrotasks()
  const state = getSessionDocState(key)
  assert.ok(state.error !== undefined && state.error.includes('会话文档不存在'), `显式错误：${String(state.error)}`)
  assert.equal(getSessionDocState(key).hasValue, false)
  // 等待超过一个退避周期，确认没有重连
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(eventsCalls, 1, '404 后不再重连')
  off()
})

test('重连 snapshot 以服务端为准对齐（本地新值被服务端旧值覆盖是预期）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let generation = 0
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      generation++
      if (generation === 1) {
        // 首连后立即断开（不 snapshot，走重连）
        return new Response(null, { status: 500 })
      }
      return sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { authoritative: true } })])
    }
    return new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: { stale: true } }), { status: 200 })
  })
  const off = subscribeSessionDoc(key, () => {})
  // 首连 500 -> GET 值可能先落地；等退避重连（1s）后 snapshot 覆盖
  for (let i = 0; i < 80 && getSessionDocState(key).value === undefined; i++) await flushMicrotasks()
  await new Promise((resolve) => setTimeout(resolve, 1600))
  for (let i = 0; i < 20; i++) await flushMicrotasks()
  assert.deepEqual(getSessionDocState(key).value, { authoritative: true }, '重连 snapshot 服务端对齐')
  off()
})

test('evict（插件停用）报错并中止；evict（会话删除）与 reset 清缓存', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      return sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 1 })])
    }
    return new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 1 }), { status: 200 })
  })
  const off = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 20 && getSessionDocState(key).hasValue === false; i++) await flushMicrotasks()
  assert.equal(getSessionDocState(key).hasValue, true)

  evictSessionDocsOfConversation(42)
  assert.equal(getSessionDocState(key).hasValue, false, '会话删除清缓存')

  const off2 = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 20 && getSessionDocState(key).hasValue === false; i++) await flushMicrotasks()
  evictSessionDocSubscriptions('builtin:workflow')
  assert.equal(getSessionDocState(key).hasValue, false, '插件停用清缓存')
  off(); off2()

  const off3 = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 20 && getSessionDocState(key).hasValue === false; i++) await flushMicrotasks()
  resetSessionDocSubscriptions()
  assert.equal(getSessionDocState(key).hasValue, false, '登出 reset 清缓存')
  off3()
})

test('帧目标不匹配/形状非法显式报错不静默吞帧', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      return sseResponse([
        `event: snapshot\ndata: ${JSON.stringify({ seq: 1, doc: { pluginId: 'other:plugin', name: 'runs', conversationId: 42, value: 1 } })}\n\n`,
      ])
    }
    // GET 挂起：隔离初始值干扰，只观察错误路径
    return new Promise<Response>(() => {})
  })
  const off = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 20; i++) await flushMicrotasks()
  const state = getSessionDocState(key)
  assert.ok(state.error !== undefined && state.error.includes('目标不匹配'), '错目标帧显式报错')
  off()
})

test('retrySessionDoc 清错误重连', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let eventsCalls = 0
  bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    if (String(input).includes('/events')) {
      eventsCalls++
      if (eventsCalls === 1) return new Response(null, { status: 500 })
      return sseResponse([snapshotFrame(1, { pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'ok' })])
    }
    return new Response(JSON.stringify({ pluginId: key.pluginId, name: key.docName, conversationId: 42, value: 'ok' }), { status: 200 })
  })
  const off = subscribeSessionDoc(key, () => {})
  for (let i = 0; i < 10; i++) await flushMicrotasks()
  retrySessionDoc(key)
  for (let i = 0; i < 20 && getSessionDocState(key).value === undefined; i++) await flushMicrotasks()
  assert.equal(getSessionDocState(key).value, 'ok', '显式重试重建连接')
  off()
})
