/**
 * Client-side regressions for SSE short-disconnect resume (?afterSeq+?bootId /
 * the resumed control frame).
 *
 * Coverage:
 * - Reconnection carries both credentials; after the resumed handshake, replay
 *   frames apply one by one and only actually reaching headSeq announces live
 *   (never "fresh" mid-replay); details/artifacts caches are NOT cleared during
 *   resume (no conversation-detail GETs);
 * - Handshake mismatch (server resumed.bootId differs from local): credentials
 *   invalidated; the next connection goes full (no query params);
 * - Snapshot apply failure: credentials invalidated; the next connection goes
 *   full (never repeatedly carrying a corrupt watermark);
 * - Logout/re-auth clears resume credentials: a new identity on the same Hub
 *   must never reuse the old authorization's client watermark;
 * - plugin.changed (enabled=true hot reload) invalidates the client module
 *   cache on both the live and the resume-replay paths (no stale UI code).
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { sseClientTimings } from '../src/lib/live-state.js'
import { getCachedClientComponent, getPluginClientCacheRevision, resetPluginClientCache, seedPluginClientModule } from '../src/lib/plugin-client.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const originalSseTimings = { ...sseClientTimings }

before(() => {
  Object.assign(sseClientTimings, {
    idleTimeoutMs: 500,
    reconnectBaseMs: 15,
    reconnectCapMs: 60,
    reconnectJitterMs: 5,
  })
})

after(() => {
  Object.assign(sseClientTimings, originalSseTimings)
})

// ---------------------------------------------------------------------------
// Stubs: controlled SSE streams + fetch routing
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** Controlled stream: tests send/end imperatively; abort (or consumer cancel) closes immediately and unbinds. */
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
      /* already closed/cancelled: idempotent */
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
  /** Register the SSE stream factory for the next /api/events connection (if the connection arrives first it waits for the registration; deterministic consumption). */
  nextEvents: (factory: StreamFactory) => void
  store: () => HelmStoreValue
  waitFor: (predicate: (observed: Observed) => boolean, ms?: number) => Promise<void>
  close: () => Promise<void>
}

async function mountProvider(options?: {
  hash?: string
  onFetch?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined
}): Promise<Harness> {
  if (options?.hash !== undefined) {
    window.history.replaceState(null, '', options.hash)
  }
  const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
  const { useHelmStore } = await import('../src/lib/store-context.js')
  const observed: Observed = { authenticated: false, sseConnected: false, connectionError: null, conversations: 0 }
  const eventsUrls: string[] = []
  const fetchedUrls: string[] = []
  // If the connection request arrives before the factory is registered, it waits (the connection starts during mount; registration order is decoupled from arrival order).
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
    if (options?.onFetch !== undefined) {
      const custom = await options.onFetch(path, init)
      if (custom !== undefined) return custom
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
      if (Date.now() > deadline) throw new Error(`waitFor timeout: ${JSON.stringify(observed)} urls=${JSON.stringify(eventsUrls)}`)
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
      assert.ok(storeRef !== undefined, 'the Probe has not rendered yet')
      return storeRef
    },
    waitFor,
    close: async () => {
      const r = root
      if (r !== undefined) await act(async () => { r.unmount() })
      host.remove()
      globalThis.fetch = originalFetch
      localStorage.removeItem('helm:token')
      window.history.replaceState(null, '', '#/')
      resetPluginClientCache()
    },
  }
}

/** Register a connection factory that emits the snapshot immediately on establishment. */
function snapshotConnection(h: Harness, payload: object): { send: (text: string) => void; end: () => void } {
  let handle: ControlledStream | undefined
  h.nextEvents((_url, signal) => {
    const c = controlledStream(signal)
    handle = c
    c.send(snapshotFrame(payload))
    return c
  })
  const demand = (): ControlledStream => {
    assert.ok(handle !== undefined, 'the snapshot connection has not been established')
    return handle
  }
  return { send: (t) => demand().send(t), end: () => demand().end() }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('disconnect resume: dual-credential handshake, replay applied frame by frame, live only after reaching headSeq, no detail GETs', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    // First connection: snapshot (bootId b1, seq 3), then held.
    const first = snapshotConnection(h, { bootId: 'b1', seq: 3, conversations: [], pendingAsks: [], plugins: [], ui: [] })
    await h.waitFor((o) => o.sseConnected === true)
    assert.equal(h.eventsUrls[0], '/api/events')

    // Disconnect: the server closes the stream -> the client reconnects with backoff (carrying both credentials).
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
    assert.equal(secondUrl, '/api/events?afterSeq=3&bootId=b1', 'the reconnect must carry both afterSeq+bootId credentials')

    // resumed handshake: headSeq=8; replay 3 frames first, then pause — no live claim mid-replay.
    second.send(resumedFrame({ bootId: 'b1', seq: 3, headSeq: 8 }))
    second.send(eventFrame(4, { type: 'conversation.upsert', conversation: conv(4, '补发四') }))
    second.send(eventFrame(5, { type: 'conversation.upsert', conversation: conv(5, '补发五') }))
    second.send(eventFrame(6, { type: 'conversation.upsert', conversation: conv(6, '补发六') }))
    await h.waitFor((o) => o.conversations === 3)
    assert.equal(h.observed.sseConnected, false, 'no live claim before the replay reaches headSeq')

    // Caught up: after frames 7 and 8 apply, it turns live.
    second.send(eventFrame(7, { type: 'conversation.upsert', conversation: conv(7, '补发七') }))
    second.send(eventFrame(8, { type: 'conversation.upsert', conversation: conv(8, '补发八') }))
    await h.waitFor((o) => o.sseConnected === true)
    assert.equal(h.observed.conversations, 5)

    // Live deltas arrive as usual (seq 9).
    second.send(eventFrame(9, { type: 'conversation.upsert', conversation: conv(9, '实时九') }))
    await h.waitFor((o) => o.conversations === 6)

    // Resume must trigger no conversation-detail/artifact GETs at all (the snapshot invalidated no cache).
    assert.ok(!h.fetchedUrls.some((url) => url.includes('/api/conversations/')), `resume must not refetch details, actual GETs: ${JSON.stringify(h.fetchedUrls)}`)
    second.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})

test('handshake mismatch: the server resumed frame differs from local credentials; credentials invalidated, next connection forced full', { timeout: 60_000 }, async () => {
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
    // Faulty server: resumed carries a different bootId (and headSeq regressed) — must be judged a handshake failure.
    second.send(resumedFrame({ bootId: 'b2', seq: 2, headSeq: 1 }))
    await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
    assert.ok(third !== undefined)
    assert.equal(thirdUrl, '/api/events', 'credentials invalidated after the handshake failure: the third connection must go full with no query params')
    third.send(snapshotFrame({ bootId: 'b2', seq: 5, conversations: [conv(1, '全量')], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
  } finally {
    await h.close()
  }
})

test('snapshot apply failure: credentials invalidated, next connection forced full (never repeatedly carrying a corrupt watermark)', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    // Illegal snapshot (conversations not an array): applySnapshot must throw and the credentials must not land.
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
    assert.equal(secondUrl, '/api/events', 'no resume credentials carried after the snapshot failure')
    second.send(snapshotFrame({ bootId: 'b1', seq: 4, conversations: [conv(2, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
  } finally {
    await h.close()
  }
})

test('logout/re-auth clears resume credentials: a new identity must not reuse the old authorization watermark', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    const first = snapshotConnection(h, { bootId: 'b1', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] })
    await h.waitFor((o) => o.sseConnected === true)
    // Advance the watermark to 2 (credentials advance as frames actually apply).
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
    // Logout via the 401 path: credentials must be cleared together with logout.
    window.dispatchEvent(new Event('helm:unauthorized'))
    await h.waitFor((o) => o.authenticated === false)
    // After re-auth (new identity), the new connection must not carry the old credentials.
    await act(async () => {
      h.store().onAuthenticated('t2')
    })
    await h.waitFor((o) => o.authenticated === true)
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    assert.ok(second !== undefined)
    assert.equal(secondUrl, '/api/events', 'after switching identity it must go full with no query params (old authorization watermark cleared)')
    second.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true)
  } finally {
    await h.close()
  }
})

test('plugin.changed enabled-state hot reload invalidates the client module cache (both the live and resume-replay paths)', { timeout: 60_000 }, async () => {
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

    // Live path: an enabled=true plugin.changed (hot reload/upgrade) must also invalidate the cache.
    first.send(eventFrame(2, { type: 'plugin.changed', plugin: pluginSummary('test:p'), ui: [] }))
    await h.waitFor(() => getPluginClientCacheRevision('test:p') !== revision0)
    const revision1 = getPluginClientCacheRevision('test:p')
    assert.notEqual(revision1, revision0)

    // Resume-replay path: a hot-reload event from during the disconnect, replayed via resumed, invalidates the cache just the same.
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
// Protocol-boundary failures: credentials always invalidated, forcing a full next connection (never relying on the server to never send bad data)
// ---------------------------------------------------------------------------

/** Assert the next connection is a credential-free full sync, then restore live with a healthy snapshot. */
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
  assert.equal(url, '/api/events', 'credentials invalidated after the protocol failure: must go full with no query params')
  handle.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [conv(1, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
  await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
}

interface ProtocolFailureScenario {
  name: string
  /** Drive until the protocol error occurs (a bad first frame, or a bad frame injected after live). */
  poison: (h: Harness) => Promise<void>
}

const goodSnapshot = { bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }

const scenarios: ProtocolFailureScenario[] = [
  {
    name: 'invalid JSON delta frame',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send('event: notification\ndata: {"seq":3,"broken\n\n')
    },
  },
  {
    name: 'null-payload snapshot first frame',
    async poison(h) {
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        c.send('event: snapshot\ndata: null\n\n')
        return c
      })
      await h.waitFor(() => h.eventsUrls.length >= 2)
    },
  },
  {
    name: 'null-payload resumed control frame',
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
    name: 'delta frame missing the event field',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send(`event: notification\ndata: ${JSON.stringify({ seq: 3 })}\n\n`)
    },
  },
  {
    name: 'frame sequence gap (missing frames must not be silently skipped)',
    async poison(h) {
      const first = snapshotConnection(h, goodSnapshot)
      await h.waitFor((o) => o.sseConnected === true)
      first.send(eventFrame(4, { type: 'notification', level: 'info', title: '跳过 3' }))
    },
  },
]

for (const scenario of scenarios) {
  test(`protocol-boundary failure invalidates credentials for the next full sync: ${scenario.name}`, { timeout: 60_000 }, async () => {
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

test('瞬态 conversation.live 不消耗 seq/afterSeq，resumed.conversationLives 对账实时视图', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const h = await mountProvider()
  try {
    const first = snapshotConnection(h, {
      bootId: 'b1',
      seq: 5,
      conversations: [{ ...conv(1, '流式会话'), status: 'working' }],
      pendingAsks: [],
      plugins: [],
      ui: [],
    })
    await h.waitFor((o) => o.sseConnected === true)

    // 发送瞬态 conversation.live（无 seq）：直接更新 conversationLives，不推进 seq
    first.send(`event: conversation.live\ndata: ${JSON.stringify({ live: { conversationId: 1, text: '瞬态流式', tools: [], updatedAt: 100 } })}\n\n`)
    await h.waitFor(() => h.store().conversationLives[1]?.text === '瞬态流式')
    // 紧接着 seq=6 持久帧无缝衔接（绝不报 sequence gap）
    first.send(eventFrame(6, { type: 'conversation.upsert', conversation: { ...conv(1, '流式会话'), status: 'working', stateChangeSeq: 2 } }))
    await h.waitFor(() => h.store().conversations[0]?.stateChangeSeq === 2)

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
    assert.equal(secondUrl, '/api/events?afterSeq=6&bootId=b1', '瞬态 live 不消耗 durable seq 水位')

    // resumed 携带 conversationLives 对账断线期间更新的实时视图
    second!.send(resumedFrame({
      bootId: 'b1',
      seq: 6,
      headSeq: 6,
      conversationLives: [{ conversationId: 1, text: '断线重连后最新', tools: [], updatedAt: 200 }],
    }))
    await h.waitFor(() => h.store().sseConnected === true && h.store().conversationLives[1]?.text === '断线重连后最新')
    second!.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})

test('snapshot 重连增量对账插件缓存与 loadErrors：保留未变更插件模块和样式，仅清变更/停用插件错误', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  const KeepPanel = () => null
  const ChangePanel = () => null
  seedPluginClientModule('keep:p', 'index.tsx', { Panel: KeepPanel, __helmClientCss: '.keep{}' }, 'hash-keep')
  seedPluginClientModule('chg:p', 'index.tsx', { Panel: ChangePanel, __helmClientCss: '.old{}' }, 'hash-old')
  const keepRev0 = getPluginClientCacheRevision('keep:p')
  const chgRev0 = getPluginClientCacheRevision('chg:p')

  const h = await mountProvider({
    onFetch: (path) => {
      if (path.includes('/docs/info')) {
        return new Response(JSON.stringify({ error: { message: 'doc error' } }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      return undefined
    },
  })
  try {
    const first = snapshotConnection(h, {
      bootId: 'b1',
      seq: 1,
      conversations: [],
      pendingAsks: [],
      plugins: [
        { ...pluginSummary('keep:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-keep' } },
        { ...pluginSummary('chg:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-old' } },
      ],
      ui: [],
    })
    await h.waitFor((o) => o.sseConnected === true)
    // 触发两个插件的 doc loadErrors
    await act(async () => {
      await h.store().ensurePluginDoc('keep:p', 'info')
      await h.store().ensurePluginDoc('chg:p', 'info')
    })
    assert.ok(h.store().loadErrors['doc:keep:p/info'] !== undefined)
    assert.ok(h.store().loadErrors['doc:chg:p/info'] !== undefined)

    // 断线重连收到新 snapshot：keep:p hash 不变，chg:p hash 变更为 hash-new
    let second: ControlledStream | undefined
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      second = c
      return c
    })
    // 作废游标以触发全量 snapshot
    first.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    second!.send(snapshotFrame({
      bootId: 'b2',
      seq: 1,
      conversations: [],
      pendingAsks: [],
      plugins: [
        { ...pluginSummary('keep:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-keep' } },
        { ...pluginSummary('chg:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-new' } },
      ],
      ui: [],
    }))
    await h.waitFor((o) => o.sseConnected === true && h.store().kernelBootId === 'b2')

    assert.equal(getCachedClientComponent('keep:p', 'index.tsx', 'Panel', 'hash-keep'), KeepPanel, '未变更插件缓存必须保留')
    assert.ok(document.querySelector('style[data-helm-plugin-css="keep:p::index.tsx"]') !== null, '未变更插件样式必须保留')
    assert.equal(getPluginClientCacheRevision('keep:p'), keepRev0, '未变更插件 revision 不变')
    assert.ok(h.store().loadErrors['doc:keep:p/info'] !== undefined, '未变更插件的既有错误不得被清空')

    assert.equal(getCachedClientComponent('chg:p', 'index.tsx', 'Panel'), undefined, 'hash 变更插件缓存必须逐出')
    assert.ok(document.querySelector('style[data-helm-plugin-css="chg:p::index.tsx"]') === null, 'hash 变更插件样式必须逐出')
    assert.notEqual(getPluginClientCacheRevision('chg:p'), chgRev0, 'hash 变更插件 revision 必须递增')
    assert.equal(h.store().loadErrors['doc:chg:p/info'], undefined, 'hash 变更插件的旧 doc 错误必须被清理')
    second!.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})

test('snapshot 重连 SWR 保活：未变更可见会话跳过详情/产物 GET；变更会话后台静默刷新不清空时间线', { timeout: 60_000 }, async () => {
  localStorage.setItem('helm:token', 't1')
  let detailCalls = 0
  let artifactCalls = 0
  let failNextDetail = false
  let serverLastEntryId = 10
  let serverStateChangeSeq = 2
  const makeDetail = () => ({
    ...conv(1, 'SWR 会话'),
    stateChangeSeq: serverStateChangeSeq,
    lastEntryId: serverLastEntryId,
    entries: [
      { id: '1', kind: 'helm.input', data: { text: 'hello' } },
      ...(serverLastEntryId > 10 ? [{ id: String(serverLastEntryId), kind: 'pi.assistant' }] : []),
    ],
  })

  const h = await mountProvider({
    hash: '#/c/1',
    onFetch: (path) => {
      if (/^\/api\/conversations\/1(\?.*)?$/.test(path)) {
        detailCalls++
        if (failNextDetail) {
          return new Response(JSON.stringify({ error: { message: 'transient 500' } }), { status: 500, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify(makeDetail()), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/api/conversations/1/artifacts') {
        artifactCalls++
        return new Response(JSON.stringify([{ id: 'art-1', conversationId: 1, name: 'a.txt', mimeType: 'text/plain', size: 1, createdAt: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return undefined
    },
  })

  try {
    const first = snapshotConnection(h, {
      bootId: 'b1',
      seq: 1,
      conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 2, lastEntryId: 10 }],
      pendingAsks: [],
      plugins: [],
      ui: [],
    })
    await h.waitFor(() => h.store().sseConnected === true && h.store().conversationDetails[1]?.entries.length === 1 && (h.store().conversationArtifacts[1]?.length ?? 0) === 1)
    assert.equal(detailCalls, 1)
    assert.equal(artifactCalls, 1)

    // 场景 A：断线重连后 snapshot 中会话 1 状态未变（status!='working'，stateChangeSeq=2，lastEntryId=10）→ 跳过 GET
    let second: ControlledStream | undefined
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      second = c
      return c
    })
    first.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
    await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
    second!.send(snapshotFrame({
      bootId: 'b2',
      seq: 1,
      conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 2, lastEntryId: 10 }],
      pendingAsks: [],
      plugins: [],
      ui: [],
    }))
    await h.waitFor(() => h.store().sseConnected === true && h.store().kernelBootId === 'b2')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    assert.equal(detailCalls, 1, '未变更可见会话重连 snapshot 必须跳过重复 detail GET')
    assert.equal(artifactCalls, 1, '未变更可见会话重连 snapshot 必须跳过重复 artifacts GET')
    assert.equal(h.store().conversationDetails[1]?.entries.length, 1)
    assert.equal(h.store().conversationArtifacts[1]?.length, 1)

    // 场景 B：lastEntryId 变更且后台静默刷新遇到 500 失败 → 仍保留原有时间线，绝不置错白屏
    serverStateChangeSeq = 3
    serverLastEntryId = 11
    failNextDetail = true
    let third: ControlledStream | undefined
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      third = c
      return c
    })
    second!.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
    await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
    third!.send(snapshotFrame({
      bootId: 'b3',
      seq: 1,
      conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 3, lastEntryId: 11 }],
      pendingAsks: [],
      plugins: [],
      ui: [],
    }))
    await h.waitFor(() => h.store().sseConnected === true && h.store().kernelBootId === 'b3' && detailCalls === 2)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    assert.equal(h.store().conversationDetails[1]?.entries.length, 1, 'SWR 静默刷新失败不得清空原有时间线')
    assert.equal(h.store().loadErrors['conversation:1'], undefined, 'silent 后台刷新失败不得触发 error 遮罩')

    // 场景 C：再次 snapshot 且服务端恢复正常 → 静默补齐最新 entry
    failNextDetail = false
    let fourth: ControlledStream | undefined
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      fourth = c
      return c
    })
    third!.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
    await h.waitFor(() => h.eventsUrls.length >= 4 && fourth !== undefined)
    fourth!.send(snapshotFrame({
      bootId: 'b4',
      seq: 1,
      conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 3, lastEntryId: 11 }],
      pendingAsks: [],
      plugins: [],
      ui: [],
    }))
    await h.waitFor(() => h.store().conversationDetails[1]?.entries.length === 2)
    assert.equal(detailCalls, 3)
    assert.equal(h.store().conversationDetails[1]?.entries[1]?.id, '11')
    fourth!.end()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  } finally {
    await h.close()
  }
})
