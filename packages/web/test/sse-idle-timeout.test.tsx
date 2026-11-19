/**
 * SSE 空闲看门狗：卡死连接可靠检测与 401 登出闭环回归。
 *
 * 场景：登录 token 已失效但页面闲置，连接经 Vite dev 代理保留为挂起流
 * （reader.read() 永不返回、连接也不断开），旧实现会永远停在旧页面。
 * 覆盖：
 * - readSseChunkWithDeadline 单元语义：Deadline 内 chunk 到达即返回且每次到达
 *   重置下一轮 Deadline（不误杀活跃连接）；持续无字节判 idle（卡死检测）；
 * - Provider 级闭环：挂起流 -> idle timeout中止 -> 既有重连路径 -> 重连 fetch 拿
 *   401 必须登出（清 token、authenticated=false，不静默降级、不再无限重连）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readSseChunkWithDeadline, sseClientTimings } from '../src/lib/live-state.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

// ---------------------------------------------------------------------------
// 单元：readSseChunkWithDeadline（真实 ReadableStream + 真实 timer）
// ---------------------------------------------------------------------------

/** 构造一个按 pull 逐块产出的 reader：块间隔 gapMs，耗尽后 close。 */
function readerOfChunks(chunks: string[], gapMs: number): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
      controller.enqueue(encoder.encode(chunks[index]!))
      index += 1
    },
  }).getReader()
}

/** 永不产出也永不关闭的 reader（模拟 dev 代理保留的挂起流）。 */
function hangingReader(): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} }).getReader()
}

test('Deadline 内 chunk 依次到达：不误杀活跃连接，耗尽后读到 done', { timeout: 60_000 }, async () => {
  // 块间隔 20ms、Deadline 60ms：持续活跃的连接每轮都重置 Deadline，绝不判 idle。
  const reader = readerOfChunks(['a', 'b', 'c', 'd', 'e'], 20)
  const received: string[] = []
  for (let i = 0; i < 5; i++) {
    const read = await readSseChunkWithDeadline(reader, 60)
    assert.equal(read.kind, 'chunk', `第 ${i + 1} 轮不应误判 idle`)
    assert.ok(read.kind === 'chunk' && read.chunk.done !== true)
    if (read.kind === 'chunk' && read.chunk.value) received.push(new TextDecoder().decode(read.chunk.value))
  }
  assert.equal(received.join(''), 'abcde')
  const end = await readSseChunkWithDeadline(reader, 60)
  assert.ok(end.kind === 'chunk' && end.chunk.done === true, '流耗尽后正常读到 done')
})

test('持续无任何字节：在 Deadline 处判 idle，且超时后取消不留未处理 rejection', { timeout: 60_000 }, async () => {
  const reader = hangingReader()
  const start = Date.now()
  const read = await readSseChunkWithDeadline(reader, 40)
  const elapsed = Date.now() - start
  assert.equal(read.kind, 'idle')
  assert.ok(elapsed >= 35 && elapsed < 2000, `应在 Deadline 附近判 idle，实际 ${elapsed}ms`)
  // 调用方（Provider）超时后会 abort 并 cancel：这里如实走同一清理，无异常逃逸。
  await reader.cancel().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 30))
})

test('signal 取消立即 reject 并清理长空闲定时器（不挂住事件循环）', { timeout: 60_000 }, async () => {
  const reader = hangingReader()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 15)
  const start = Date.now()
  await assert.rejects(
    () => readSseChunkWithDeadline(reader, 60_000, controller.signal),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  )
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1000, `abort 应立即解除挂起，实际 ${elapsed}ms`)
  await assert.rejects(
    () => readSseChunkWithDeadline(reader, 60_000, controller.signal),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  )
  await reader.cancel().catch(() => {})
})

// ---------------------------------------------------------------------------
// Provider 级闭环：挂起流idle timeout -> 重连 -> 401 登出
// ---------------------------------------------------------------------------

interface Observed {
  authenticated: boolean
  connectionError: string | null
  sseConnected: boolean
  eventsCalls: number
}

const snapshotPayload = { bootId: 'test-boot', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] }

/** 挂起的 /api/events 流：发出 snapshot 后永不写入、永不关闭。 */
function hangingEventStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`))
    },
  })
}

test('挂起流idle timeout中止并重连，重连 401 必须登出且不再无限重连', { timeout: 60_000 }, async () => {
  assert.equal(sseClientTimings.idleTimeoutMs, 30_000, '默认 SSE 空闲超时必须收敛至 30_000ms')
  const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
  const { useHelmxStore } = await import('../src/lib/store-context.js')
  const originalTimings = { ...sseClientTimings }
  const originalFetch = globalThis.fetch
  Object.assign(sseClientTimings, {
    idleTimeoutMs: 250,
    reconnectBaseMs: 20,
    reconnectCapMs: 80,
    reconnectJitterMs: 5,
  })
  localStorage.setItem('helmx:token', 'stale-token')
  let eventsCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/events' || path.startsWith('/api/events?')) {
      eventsCalls += 1
      if (eventsCalls === 1) {
        return new Response(hangingEventStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      // token 已失效：重连必须拿到显式 401，由既有路径登出，绝不静默降级。
      return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'token 已失效' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  let observed: Observed = { authenticated: false, connectionError: null, sseConnected: false, eventsCalls: 0 }
  const history: Observed[] = []
  const Probe = (): React.ReactNode => {
    const store = useHelmxStore()
    observed = { authenticated: store.authenticated, connectionError: store.connectionError, sseConnected: store.sseConnected, eventsCalls }
    history.push(observed)
    return null
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  const waitForObs = async (predicate: (snapshot: Observed) => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!predicate(observed)) {
      if (Date.now() > deadline) throw new Error(`waitFor 超时：${JSON.stringify(observed)}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
  }
  try {
    await act(async () => {
      const r = createRoot(host)
      root = r
      r.render(React.createElement(HelmxStoreProvider, null, React.createElement(Probe)))
    })
    // 第一条连接：snapshot 到达、进入挂起态（无任何后续字节）。
    await waitForObs(() => history.some((o) => o.sseConnected === true && o.eventsCalls === 1))
    // 250ms idle timeout：判卡死、中止当前连接并显式提示（进入既有重连路径）。
    await waitForObs(() => history.some((o) => (o.connectionError ?? '').includes('idle timeout')))
    // 重连 fetch 拿 401：必须登出（authenticated=false、token 清除）。
    await waitForObs((o) => o.authenticated === false && o.eventsCalls >= 2)
    assert.equal(eventsCalls, 2, '恰好两次 /api/events：挂起流一次 + 401 一次')
    assert.equal(localStorage.getItem('helmx:token'), null, '登出必须清除存储 token')
    assert.equal(observed.sseConnected, false)
    // 401 登出后连接效应卸载：等待超过一次退避周期，不再有第三次重连。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
    assert.equal(eventsCalls, 2, '401 登出后不得继续重连')
    assert.equal(observed.authenticated, false)
  } finally {
    Object.assign(sseClientTimings, originalTimings)
    globalThis.fetch = originalFetch
    localStorage.removeItem('helmx:token')
    const r = root
    if (r !== undefined) await act(async () => { r.unmount() })
    host.remove()
  }
})

test('online 与 visibilitychange 秒醒：取消退避立即重连、陈旧流重连、健康流不误杀', { timeout: 60_000 }, async () => {
  const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
  const { useHelmxStore } = await import('../src/lib/store-context.js')
  const originalTimings = { ...sseClientTimings }
  const originalFetch = globalThis.fetch
  const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })

  Object.assign(sseClientTimings, {
    idleTimeoutMs: 30_000,
    staleWakeupMs: 80,
    reconnectBaseMs: 10_000,
    reconnectCapMs: 10_000,
    reconnectJitterMs: 0,
  })
  localStorage.setItem('helmx:token', 'tok-wake')

  let eventsCalls = 0
  const streams: Array<{ abortable: boolean }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/events' || path.startsWith('/api/events?')) {
      eventsCalls += 1
      if (eventsCalls === 1) {
        // 首次连接立即失败：进入 10s 长退避
        return new Response('unavailable', { status: 503 })
      }
      if (eventsCalls === 2) {
        // 第二次连接（online 唤醒）先断开再进入 10s 退避，测试 visibilitychange 唤醒
        return new Response('unavailable', { status: 503 })
      }
      const entry = { abortable: false }
      streams.push(entry)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(snapshotPayload)}\n\n`))
          init?.signal?.addEventListener('abort', () => {
            entry.abortable = true
            try { controller.close() } catch { /* noop */ }
          }, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  let sseConnected = false
  const Probe = (): React.ReactNode => {
    sseConnected = useHelmxStore().sseConnected
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  const waitUntil = async (pred: () => boolean, ms = 5_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`waitUntil 超时 eventsCalls=${eventsCalls} sseConnected=${sseConnected}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
    }
  }

  try {
    await act(async () => {
      root = createRoot(host)
      root.render(React.createElement(HelmxStoreProvider, null, React.createElement(Probe)))
    })
    await waitUntil(() => eventsCalls === 1)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
    assert.equal(eventsCalls, 1, '10s 退避期间不得自行重连')

    // 1. online 事件立即取消退避重连
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitUntil(() => eventsCalls === 2)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })

    // 2. visibilitychange 切回前台立即取消退避重连
    hidden = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    assert.equal(eventsCalls, 2, '切入后台不得重连')
    hidden = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitUntil(() => sseConnected === true && eventsCalls === 3)

    // 3. 刚建立的健康连接（< staleWakeupMs）：visibilitychange 不得误杀
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    assert.equal(eventsCalls, 3, '健康连接不得被误杀重建')

    // 4. 超过 staleWakeupMs（80ms）未收任何帧后切回前台：判定陈旧流立即中止重连
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitUntil(() => eventsCalls === 4 && sseConnected === true)
    assert.equal(streams[0]?.abortable, true, '陈旧连接必须被中止')
  } finally {
    Object.assign(sseClientTimings, originalTimings)
    globalThis.fetch = originalFetch
    localStorage.removeItem('helmx:token')
    if (originalHiddenDescriptor !== undefined) {
      Object.defineProperty(document, 'hidden', originalHiddenDescriptor)
    } else {
      delete (document as unknown as Record<string, unknown>).hidden
    }
    if (root !== undefined) await act(async () => { root!.unmount() })
    host.remove()
  }
})
