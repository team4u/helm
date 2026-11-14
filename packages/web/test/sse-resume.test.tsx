/**
 * SSE 短断线续传（?afterSeq+?bootId / resumed 控制帧）客户端回归。
 *
 * 覆盖：
 * - 断线重连携带双凭据，resumed 握手后补发帧逐帧应用，只有实际追平 headSeq
 *   才宣称 live（重放中不显示「新鲜」）；续传期间不清详情/产物缓存（无会话
 *   详情类 GET）；
 * - 握手不匹配（服务端 resumed.bootId 与本地不符）：作废凭据，下次连接强制
 *   全量（无查询参数）；
 * - 快照应用失败：作废凭据，下次连接强制全量（绝不反复携带损坏水位）；
 * - 登出/重新鉴权清空续传凭据：同 Hub 换身份不得沿用旧授权的客户端水位；
 * - plugin.changed（enabled=true 热重载）在实时与续传重放两条路径都使 client
 *   模块缓存失效（不残留旧 UI 代码）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { getPluginClientCacheRevision } from '../src/lib/plugin-client.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

// ---------------------------------------------------------------------------
// 桩：受控 SSE 流 + fetch 路由
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** 受控流：测试命令式 send/end；abort（或消费端 cancel）时立即关流解绑。 */
function controlledStream(signal?: AbortSignal | null): {
  stream: ReadableStream<Uint8Array>
  send: (text: string) => void
  end: () => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    signal?.removeEventListener('abort', finish)
    try {
      controller?.close()
    } catch {
      /* 已关/已取消：幂等 */
    }
  }
  signal?.addEventListener('abort', finish, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      if (signal?.aborted) finish()
    },
    cancel() {
      finish()
    },
  })
  return {
    stream,
    send: (text: string) => {
      if (!ended) controller?.enqueue(encoder.encode(text))
    },
    end: finish,
  }
}

const conv = (id: number, title: string) => ({
  id,
  title,
  profileId: 'assistant',
  tags: [],
  cwd: '/tmp',
  model: 'm',
  thinkingLevel: '',
  status: 'idle',
  stateChangeSeq: 1,
  completionSeq: 0,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: 1,
  updatedAt: 1,
})

const snapshotFrame = (payload: object): string => `event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`
const resumedFrame = (payload: object): string => `event: resumed\ndata: ${JSON.stringify(payload)}\n\n`
const eventFrame = (seq: number, event: object): string =>
  `event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify({ seq, event })}\n\n`

const pluginSummary = (id: string) => ({
  id,
  name: id,
  locked: false,
  enabled: true,
  hooks: [],
  actions: [],
  tools: [],
})

interface ControlledStream {
  stream: ReadableStream<Uint8Array>
  send: (text: string) => void
  end: () => void
}

type StreamFactory = (url: string, signal: AbortSignal | null) => ControlledStream

interface Observed {
  authenticated: boolean
  sseConnected: boolean
  connectionError: string | null
  conversations: number
}

interface Harness {
  observed: Observed
  eventsUrls: string[]
  fetchedUrls: string[]
  /** 登记下一条 /api/events 连接的 SSE 流工厂（连接先到则挂起等待注册，确定性消费）。 */
  nextEvents: (factory: StreamFactory) => void
  store: () => HelmStoreValue
  waitFor: (predicate: (observed: Observed) => boolean, ms?: number) => Promise<void>
  close: () => Promise<void>
}

async function mountProvider(): Promise<Harness> {
  const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
  const { useHelmStore } = await import('../src/lib/store-context.js')
  const observed: Observed = { authenticated: false, sseConnected: false, connectionError: null, conversations: 0 }
  const eventsUrls: string[] = []
  const fetchedUrls: string[] = []
  // 连接请求先到而工厂未注册时挂起（mount 期间连接即发起，注册顺序与到达顺序解耦）。
  const factories: StreamFactory[] = []
  const waiting: Array<{ url: string; signal: AbortSignal | null; resolve: (r: ControlledStream) => void }> = []
  const takeStream = (url: string, signal: AbortSignal | null): Promise<ControlledStream> => {
    const factory = factories.shift()
    if (factory !== undefined) return Promise.resolve(factory(url, signal))
    return new Promise((resolve) => {
      waiting.push({ url, signal, resolve })
    })
  }
  const nextEvents = (factory: StreamFactory): void => {
    const pending = waiting.shift()
    if (pending !== undefined) {
      pending.resolve(factory(pending.url, pending.signal))
      return
    }
    factories.push(factory)
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    fetchedUrls.push(path)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/events' || path.startsWith('/api/events?')) {
      eventsUrls.push(path)
      const { stream } = await takeStream(path, init?.signal ?? null)
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  let storeRef: HelmStoreValue | undefined
  const Probe = (): React.ReactNode => {
    const store = useHelmStore()
    storeRef = store
    observed.authenticated = store.authenticated
    observed.sseConnected = store.sseConnected
    observed.connectionError = store.connectionError
    observed.conversations = store.conversations.length
    return null
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  await act(async () => {
    const r = createRoot(host)
    root = r
    r.render(React.createElement(HelmStoreProvider, null, React.createElement(Probe)))
  })
  const waitFor = async (predicate: (observed: Observed) => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!predicate(observed)) {
      if (Date.now() > deadline) throw new Error(`waitFor 超时：${JSON.stringify(observed)} urls=${JSON.stringify(eventsUrls)}`)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
  }
  return {
    observed,
    eventsUrls,
    fetchedUrls,
    nextEvents,
    store: () => {
      assert.ok(storeRef !== undefined, 'Probe 尚未渲染')
      return storeRef
    },
    waitFor,
    close: async () => {
      const r = root
      if (r !== undefined) await act(async () => { r.unmount() })
      host.remove()
      globalThis.fetch = originalFetch
      localStorage.removeItem('helm:token')
    },
  }
}

/** 注册一条「建立即发 snapshot」的连接工厂。 */
function snapshotConnection(h: Harness, payload: object): { send: (text: string) => void; end: () => void } {
  let handle: ControlledStream | undefined
  h.nextEvents(() => {
    const c = controlledStream()
    handle = c
    c.send(snapshotFrame(payload))
    return c
  })
  const demand = (): ControlledStream => {
    assert.ok(handle !== undefined, 'snapshot 连接尚未建立')
    return handle
  }
  return { send: (t) => demand().send(t), end: () => demand().end() }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('断线续传：双凭据握手、补发逐帧应用、追平 headSeq 才 live、无详情 GET', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    // 第一条连接：snapshot（bootId b1，seq 3）后保持。
    const first = snapshotConnection(h, { bootId: 'b1', seq: 3, conversations: [], pendingAsks: [], plugins: [], ui: [] })
    await h.waitFor((o) => o.sseConnected === true)
    assert.equal(h.eventsUrls[0], '/api/events')

    // 断线：服务端关流 → 客户端退避重连（携带双凭据）。
    let secondUrl = ''
    let second: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      secondUrl = url
      const c = controlledStream(signal)
      second = c
      return c
    })
    first.end()
    await h.waitFor((o) => o.sseConnected === false)
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events?afterSeq=3&bootId=b1', '重连必须携带 afterSeq+bootId 双凭据')

    // resumed 握手：headSeq=8；先补发 3 帧再暂停——重放中不得宣称 live。
    second.send(resumedFrame({ bootId: 'b1', seq: 3, headSeq: 8 }))
    second.send(eventFrame(4, { type: 'conversation.upsert', conversation: conv(4, '补发四') }))
    second.send(eventFrame(5, { type: 'conversation.upsert', conversation: conv(5, '补发五') }))
    second.send(eventFrame(6, { type: 'conversation.upsert', conversation: conv(6, '补发六') }))
    await h.waitFor((o) => o.conversations === 3)
    assert.equal(h.observed.sseConnected, false, '重放未追平 headSeq 之前不得宣称 live')

    // 追平：帧 7、8 应用后转 live。
    second.send(eventFrame(7, { type: 'conversation.upsert', conversation: conv(7, '补发七') }))
    second.send(eventFrame(8, { type: 'conversation.upsert', conversation: conv(8, '补发八') }))
    await h.waitFor((o) => o.sseConnected === true)
    assert.equal(h.observed.conversations, 5)

    // live 增量照常到达（seq 9）。
    second.send(eventFrame(9, { type: 'conversation.upsert', conversation: conv(9, '实时九') }))
    await h.waitFor((o) => o.conversations === 6)

    // 续传全程不得触发任何会话详情/产物类 GET（快照未失效任何缓存）。
    assert.ok(!h.fetchedUrls.some((url) => url.includes('/api/conversations/')), `续传不得重拉详情，实际 GET：${JSON.stringify(h.fetchedUrls)}`)
    second.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})

test('握手不匹配：服务端 resumed 与本地凭据不符，作废凭据下次强制全量', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    const first = snapshotConnection(h, { bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] })
    await h.waitFor((o) => o.sseConnected === true)

    let secondUrl = ''
    let second: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      secondUrl = url
      const c = controlledStream(signal)
      second = c
      return c
    })
    let thirdUrl = ''
    let third: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      thirdUrl = url
      const c = controlledStream(signal)
      third = c
      return c
    })
    first.end()
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
    // 异常服务端：resumed 携带另一 bootId（且 headSeq 倒退）——必须判握手失败。
    second.send(resumedFrame({ bootId: 'b2', seq: 2, headSeq: 1 }))
    await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
    assert.ok(third !== undefined)
    assert.equal(thirdUrl, '/api/events', '握手失败后凭据已作废：第三次连接必须无查询参数全量')
    third.send(snapshotFrame({ bootId: 'b2', seq: 5, conversations: [conv(1, '全量')], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
  } finally {
    await h.close()
  }
})

test('快照应用失败：作废凭据，下次连接强制全量（不反复携带损坏水位）', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    // 非法快照（conversations 非数组）：applySnapshot 必须抛错，凭据不落地。
    const first = snapshotConnection(h, { bootId: 'b1', seq: 4, conversations: 'corrupted', pendingAsks: [], plugins: [], ui: [] })
    let secondUrl = ''
    let second: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      secondUrl = url
      const c = controlledStream(signal)
      second = c
      return c
    })
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events', '快照失败后不得携带任何续传凭据')
    second.send(snapshotFrame({ bootId: 'b1', seq: 4, conversations: [conv(2, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
  } finally {
    await h.close()
  }
})

test('登出/重新鉴权清空续传凭据：换身份后不得沿用旧授权水位', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    const first = snapshotConnection(h, { bootId: 'b1', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] })
    await h.waitFor((o) => o.sseConnected === true)
    // 推进水位到 2（凭据随帧实际应用推进）。
    first.send(eventFrame(2, { type: 'notification', level: 'info', title: '推进' }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    let secondUrl = ''
    let second: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      secondUrl = url
      const c = controlledStream(signal)
      second = c
      return c
    })
    // 401 路径登出：凭据必须随 logout 一并清空。
    window.dispatchEvent(new Event('helm:unauthorized'))
    await h.waitFor((o) => o.authenticated === false)
    // 重新鉴权（换身份）后新连接不得带旧凭据。
    await act(async () => {
      h.store().onAuthenticated('t2')
    })
    await h.waitFor((o) => o.authenticated === true)
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events', '换身份后必须无查询参数全量（旧授权水位已清空）')
    second.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true)
  } finally {
    await h.close()
  }
})

test('plugin.changed 启用态热重载使 client 模块缓存失效（live 与续传重放双路径）', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    const first = snapshotConnection(h, {
      bootId: 'b1',
      seq: 1,
      conversations: [],
      pendingAsks: [],
      plugins: [pluginSummary('test:p')],
      ui: [],
    })
    await h.waitFor((o) => o.sseConnected === true)
    const revision0 = getPluginClientCacheRevision('test:p')

    // live 路径：enabled=true 的 plugin.changed（热重载/升级）也必须失效缓存。
    first.send(eventFrame(2, { type: 'plugin.changed', plugin: pluginSummary('test:p'), ui: [] }))
    await h.waitFor(() => getPluginClientCacheRevision('test:p') !== revision0)
    const revision1 = getPluginClientCacheRevision('test:p')
    assert.notEqual(revision1, revision0)

    // 续传重放路径：断线期间的热重载事件经 resumed 补发后同样失效缓存。
    let secondUrl = ''
    let second: ControlledStream | undefined
    h.nextEvents((url, signal) => {
      secondUrl = url
      const c = controlledStream(signal)
      second = c
      return c
    })
    first.end()
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
    second.send(resumedFrame({ bootId: 'b1', seq: 2, headSeq: 3 }))
    second.send(eventFrame(3, { type: 'plugin.changed', plugin: pluginSummary('test:p'), ui: [] }))
    await h.waitFor(() => getPluginClientCacheRevision('test:p') !== revision1)
    await h.waitFor((o) => o.sseConnected === true, 3000)
    second.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})

// ---------------------------------------------------------------------------
// 协议边界异常：一律作废凭据强制下次全量（不依赖服务端永不发坏数据）
// ---------------------------------------------------------------------------

/** 断言下一次连接为无凭据全量，并以健康快照恢复 live。 */
async function expectFullResyncAndRecover(h: Harness): Promise<void> {
  let url = ''
  let handle: ControlledStream | undefined
  h.nextEvents((u, signal) => {
    url = u
    const c = controlledStream(signal)
    handle = c
    return c
  })
  await h.waitFor(() => handle !== undefined)
  assert.ok(handle !== undefined)
  assert.equal(url, '/api/events', '协议失败后凭据已作废：必须无查询参数全量')
  handle.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [conv(1, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
  await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
}

interface ProtocolFailureScenario {
  name: string
  /** 驱动至协议错误发生（首帧即坏或 live 后注入坏帧）。 */
  poison: (h: Harness) => Promise<void>
}

const goodSnapshot = { bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }

const scenarios: ProtocolFailureScenario[] = [
  {
    name: '无效 JSON 增量帧',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send('event: notification\ndata: {"seq":3,"broken\n\n')
    },
  },
  {
    name: 'null 载荷 snapshot 首帧',
    async poison(h) {
      h.nextEvents(() => {
        const c = controlledStream()
        c.send('event: snapshot\ndata: null\n\n')
        return c
      })
      await h.waitFor(() => h.eventsUrls.length >= 2)
    },
  },
  {
    name: 'null 载荷 resumed 控制帧',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
      second.send('event: resumed\ndata: null\n\n')
    },
  },
  {
    name: '缺 event 字段的增量帧',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send(`event: notification\ndata: ${JSON.stringify({ seq: 3 })}\n\n`)
    },
  },
  {
    name: '帧序跳号（缺帧不得静默越过）',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send(eventFrame(4, { type: 'notification', level: 'info', title: '跳过 3' }))
    },
  },
]

for (const scenario of scenarios) {
  test(`协议边界异常作废凭据下次全量：${scenario.name}`, { timeout: 60_000 }, async () => {
    localStorage.setItem('helm:token', 't1')
    const h = await mountProvider()
    try {
      await scenario.poison(h)
      await h.waitFor((o) => o.sseConnected === false)
      await expectFullResyncAndRecover(h)
    } finally {
      await h.close()
    }
  })
}
