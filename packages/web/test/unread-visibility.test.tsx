/**
 * HelmStoreProvider integration tests for foreground-visibility-gated
 * automatic unread clearing (controlled SSE + fetch stubs, happy-dom):
 * - Foreground visible and focused (!document.hidden && document.hasFocus()):
 *   - a snapshot or conversation.upsert with unread=true on a currently
 *     visible (main/split) conversation sends exactly 1 PATCH { unread: false };
 * - Page hidden (document.hidden=true) or unfocused (document.hasFocus()=false):
 *   - receiving unread=true on a currently visible conversation sends no PATCH
 *     (unread kept);
 *   - switching to that conversation still sends no PATCH;
 * - Switching back to the foreground firing visibilitychange + window.focus in
 *   a burst:
 *   - single-flight sends exactly 1 PATCH { unread: false }; no repeats before
 *     the SSE unread=false arrives;
 *   - after the SSE unread=false (or stateChangeSeq advancing while still
 *     unread=true) the next clearing is allowed;
 * - Conversations not currently visible are never mis-marked read by returning
 *   to the foreground;
 * - A failed PATCH clears the in-flight record to allow a retry, pushNotice
 *   reports "Failed to mark as read", and loadErrors['conversation:id'] stays
 *   unpolluted;
 * - logout / snapshot reset the in-flight and watermark state.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary } from '@helm/protocol'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { sseClientTimings } from '../src/lib/live-state.js'
import type { HelmStoreValue } from '../src/lib/types.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const originalSseTimings = { ...sseClientTimings }

before(() => {
  Object.assign(sseClientTimings, {
    idleTimeoutMs: 30_000,
    reconnectBaseMs: 15,
    reconnectCapMs: 60,
    reconnectJitterMs: 5,
  })
})

after(() => {
  Object.assign(sseClientTimings, originalSseTimings)
})

const encoder = new TextEncoder()

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
      /* idempotent close */
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

const makeConv = (partial: Partial<ConversationSummary> & { id: number }): ConversationSummary => ({
  title: `会话 ${partial.id}`,
  profileId: 'assistant',
  tags: [],
  cwd: '/tmp',
  model: 'm',
  thinkingLevel: '',
  status: partial.unread ? 'done' : 'idle',
  stateChangeSeq: 1,
  completionSeq: 0,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: 1,
  updatedAt: 1,
  ...partial,
})

const snapshotFrame = (payload: object): string => `event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`
const eventFrame = (seq: number, event: object): string =>
  `event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify({ seq, event })}\n\n`

interface PatchCall {
  id: number
  body: Record<string, unknown>
}

interface ControlledStream {
  stream: ReadableStream<Uint8Array>
  send: (text: string) => void
  end: () => void
}

interface DeferredPatch {
  id: number
  body: Record<string, unknown>
  resolve: (updated?: Partial<ConversationSummary>) => void
  reject: (err: Error) => void
}

interface MountOptions {
  hash?: string
  manualPatch?: boolean
  patchStatus?: number
  onGet?: (path: string, signal?: AbortSignal | null) => Promise<Response | undefined> | Response | undefined
}

interface Harness {
  patchCalls: PatchCall[]
  pendingPatches: DeferredPatch[]
  nextEvents: (factory: (url: string, signal: AbortSignal | null) => ControlledStream) => void
  store: () => HelmStoreValue
  waitFor: (predicate: (store: HelmStoreValue) => boolean, ms?: number) => Promise<void>
  flush: (ms?: number) => Promise<void>
  setPatchBehavior: (opts: { manualPatch?: boolean; patchStatus?: number }) => void
  close: () => Promise<void>
}

async function mountProvider(options: MountOptions = {}): Promise<Harness> {
  if (options.hash !== undefined) {
    window.history.replaceState(null, '', options.hash)
  }
  const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
  const { useHelmStore } = await import('../src/lib/store-context.js')

  const patchCalls: PatchCall[] = []
  const pendingPatches: DeferredPatch[] = []
  let manualPatch = options.manualPatch ?? false
  let patchStatus = options.patchStatus ?? 200

  const factories: Array<(url: string, signal: AbortSignal | null) => ControlledStream> = []
  const waiting: Array<{ url: string; signal: AbortSignal | null; resolve: (r: ControlledStream) => void }> = []
  const takeStream = (url: string, signal: AbortSignal | null): Promise<ControlledStream> => {
    const factory = factories.shift()
    if (factory !== undefined) return Promise.resolve(factory(url, signal))
    return new Promise((resolve) => {
      waiting.push({ url, signal, resolve })
    })
  }
  const nextEvents = (factory: (url: string, signal: AbortSignal | null) => ControlledStream): void => {
    const pending = waiting.shift()
    if (pending !== undefined) {
      pending.resolve(factory(pending.url, pending.signal))
      return
    }
    factories.push(factory)
  }

  let storeRef: HelmStoreValue | undefined
  const Probe = (): React.ReactNode => {
    storeRef = useHelmStore()
    return null
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/api/models') {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/api/events' || path.startsWith('/api/events?')) {
      const { stream } = await takeStream(path, init?.signal ?? null)
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const patchMatch = /^\/api\/conversations\/(\d+)$/.exec(path)
    if (patchMatch && method === 'PATCH') {
      const id = Number(patchMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      patchCalls.push({ id, body })
      if (manualPatch) {
        return await new Promise<Response>((resolveResponse, rejectResponse) => {
          pendingPatches.push({
            id,
            body,
            resolve: (updated) => {
              const summary = storeRef?.conversations.find((c) => c.id === id) ?? makeConv({ id })
              resolveResponse(
                new Response(
                  JSON.stringify({
                    ...summary,
                    unread: false,
                    status: 'idle',
                    stateChangeSeq: summary.stateChangeSeq + 1,
                    ...updated,
                  }),
                  { status: 200, headers: { 'content-type': 'application/json' } },
                ),
              )
            },
            reject: (err) => rejectResponse(err),
          })
        })
      }
      if (patchStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: 'patch rejected' } }), {
          status: patchStatus,
          headers: { 'content-type': 'application/json' },
        })
      }
      const summary = storeRef?.conversations.find((c) => c.id === id) ?? makeConv({ id })
      return new Response(
        JSON.stringify({
          ...summary,
          unread: false,
          status: 'idle',
          stateChangeSeq: summary.stateChangeSeq + 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'GET' && options.onGet !== undefined) {
      const handled = await options.onGet(path, init?.signal ?? null)
      if (handled !== undefined) return handled
    }
    const detailMatch = /^\/api\/conversations\/(\d+)(\?.*)?$/.exec(path)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      return new Response(
        JSON.stringify({ ...makeConv({ id }), entries: [], nextCursor: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  await act(async () => {
    const r = createRoot(host)
    root = r
    r.render(React.createElement(HelmStoreProvider, null, React.createElement(Probe)))
  })

  const waitFor = async (predicate: (store: HelmStoreValue) => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (storeRef === undefined || !predicate(storeRef)) {
      if (Date.now() > deadline) {
        throw new Error(
          `waitFor timeout sseConnected=${String(storeRef?.sseConnected)} patchCalls=${JSON.stringify(patchCalls)} pending=${pendingPatches.length}`,
        )
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
      })
    }
  }

  const flush = async (ms = 40): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
  }

  return {
    patchCalls,
    pendingPatches,
    nextEvents,
    store: () => {
      assert.ok(storeRef !== undefined, 'the Probe has not rendered yet')
      return storeRef
    },
    waitFor,
    flush,
    setPatchBehavior: (opts) => {
      if (opts.manualPatch !== undefined) manualPatch = opts.manualPatch
      if (opts.patchStatus !== undefined) patchStatus = opts.patchStatus
    },
    close: async () => {
      const r = root
      if (r !== undefined) await act(async () => { r.unmount() })
      host.remove()
      globalThis.fetch = originalFetch
      localStorage.removeItem('helm:token')
      window.history.replaceState(null, '', '#/')
    },
  }
}

function setVisibilityAndFocus(initial: { hidden: boolean; focused: boolean }): {
  set: (next: Partial<{ hidden: boolean; focused: boolean }>) => void
  restore: () => void
} {
  let state = { ...initial }
  const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = document.hasFocus
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden })
  document.hasFocus = () => state.focused
  return {
    set: (next) => {
      state = { ...state, ...next }
    },
    restore: () => {
      if (originalHiddenDescriptor !== undefined) {
        Object.defineProperty(document, 'hidden', originalHiddenDescriptor)
      } else {
        delete (document as unknown as Record<string, unknown>).hidden
      }
      Object.defineProperty(document, 'hasFocus', { configurable: true, writable: true, value: originalHasFocus })
    },
  }
}

test('a currently visible conversation receiving unread=true while foreground-focused auto-sends 1 PATCH { unread: false } (snapshot and upsert both covered)', { timeout: 60_000 }, async () => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  const h = await mountProvider({ hash: '#/c/1' })
  let sendSse!: (text: string) => void
  h.nextEvents((_url, signal) => {
    const c = controlledStream(signal)
    sendSse = c.send
    c.send(
      snapshotFrame({
        bootId: 'boot-1',
        seq: 1,
        conversations: [makeConv({ id: 1, unread: true, stateChangeSeq: 2 })],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }),
    )
    return c
  })
  try {
    await h.waitFor((s) => s.sseConnected && h.patchCalls.length === 1)
    assert.deepEqual(h.patchCalls, [{ id: 1, body: { unread: false } }])

    // Simulate the kernel pushing unread=false after handling the PATCH, then a new completed turn flipping unread=true again
    sendSse(eventFrame(2, { type: 'conversation.upsert', conversation: makeConv({ id: 1, unread: false, stateChangeSeq: 3 }) }))
    sendSse(eventFrame(3, { type: 'conversation.upsert', conversation: makeConv({ id: 1, unread: true, stateChangeSeq: 4 }) }))
    await h.waitFor(() => h.patchCalls.length === 2)
    assert.deepEqual(h.patchCalls[1], { id: 1, body: { unread: false } })
  } finally {
    await h.close()
    page.restore()
  }
})

test('page hidden (hidden=true) or unfocused (hasFocus=false): receiving unread=true on the current conversation sends no PATCH (unread kept)', { timeout: 60_000 }, async () => {
  const page = setVisibilityAndFocus({ hidden: true, focused: true })
  const h = await mountProvider({ hash: '#/c/1' })
  let sendSse!: (text: string) => void
  h.nextEvents((_url, signal) => {
    const c = controlledStream(signal)
    sendSse = c.send
    c.send(
      snapshotFrame({
        bootId: 'boot-1',
        seq: 1,
        conversations: [
          makeConv({ id: 1, unread: true, stateChangeSeq: 2 }),
          makeConv({ id: 2, unread: true, stateChangeSeq: 2 }),
        ],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }),
    )
    return c
  })
  try {
    await h.waitFor((s) => s.sseConnected && s.conversations.length === 2)
    await h.flush()
    assert.equal(h.patchCalls.length, 0, 'with document.hidden=true the snapshot must not clear unread')

    // Switch to visible-but-unfocused (hasFocus=false): receiving an upsert and switching the split target likewise must not clear unread
    page.set({ hidden: false, focused: false })
    await act(async () => {
      sendSse(eventFrame(2, { type: 'conversation.upsert', conversation: makeConv({ id: 1, unread: true, stateChangeSeq: 3 }) }))
      h.store().openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 0, 'with document.hasFocus()=false unread must not be cleared')
    assert.equal(h.store().conversations.find((c) => c.id === 1)?.unread, true)
    assert.equal(h.store().conversations.find((c) => c.id === 2)?.unread, true)
  } finally {
    await h.close()
    page.restore()
  }
})

test('returning to the foreground fires visibilitychange + focus in a burst yet single-flights 1 PATCH; no repeats before unread=false; invisible conversations never mis-cleared', { timeout: 60_000 }, async () => {
  const page = setVisibilityAndFocus({ hidden: true, focused: false })
  const h = await mountProvider({ hash: '#/c/1', manualPatch: true })
  let sendSse!: (text: string) => void
  h.nextEvents((_url, signal) => {
    const c = controlledStream(signal)
    sendSse = c.send
    c.send(
      snapshotFrame({
        bootId: 'boot-1',
        seq: 1,
        conversations: [
          makeConv({ id: 1, unread: true, stateChangeSeq: 5 }),
          makeConv({ id: 2, unread: true, stateChangeSeq: 5 }),
          makeConv({ id: 9, unread: true, stateChangeSeq: 5 }), // not currently visible
        ],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }),
    )
    return c
  })
  try {
    await h.waitFor((s) => s.sseConnected && s.conversations.length === 3)
    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 2 }, { split: true })
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 0)

    // Return to the foreground: visibilitychange and window.focus fire in quick succession
    page.set({ hidden: false, focused: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await h.waitFor(() => h.patchCalls.length === 2)
    assert.deepEqual(
      h.patchCalls.map((c) => c.id).sort((a, b) => a - b),
      [1, 2],
      'exactly 1 PATCH each for main #1 and split #2; the invisible #9 is never mis-cleared',
    )

    // Focusing again while the request is in flight: single-flight intercepts, no duplicate send
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 2)

    // The PATCH returned success but the SSE conversation.upsert(unread=false) has not arrived: the watermark dedup intercepts
    await act(async () => {
      for (const p of h.pendingPatches.splice(0)) p.resolve()
    })
    await h.flush()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 2, 'no repeated PATCH for the same stateChangeSeq before unread=false arrives')

    // Without a prior unread=false: at/earlier than the PATCH ack watermark (stateChangeSeq=6) still intercepts;
    // an update past the PATCH ack watermark (stateChangeSeq=7 and still unread=true) allows the next clearing
    await act(async () => {
      sendSse(eventFrame(2, { type: 'conversation.upsert', conversation: makeConv({ id: 1, unread: true, stateChangeSeq: 6 }) }))
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 2, 'no repeated PATCH when not exceeding the PATCH ack watermark stateChangeSeq=6')

    await act(async () => {
      sendSse(eventFrame(3, { type: 'conversation.upsert', conversation: makeConv({ id: 1, unread: true, stateChangeSeq: 7 }) }))
    })
    await h.waitFor(() => h.patchCalls.length === 3)
    assert.deepEqual(h.patchCalls[2], { id: 1, body: { unread: false } })
    await act(async () => {
      for (const p of h.pendingPatches.splice(0)) p.resolve()
    })
  } finally {
    await h.close()
    page.restore()
  }
})

test('a failed PATCH clears the in-flight record and pushNotice reports "Failed to mark as read", polluting no loadErrors, and allows a retry', { timeout: 60_000 }, async () => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  const h = await mountProvider({ hash: '#/c/1', patchStatus: 500 })
  h.nextEvents((_url, signal) => {
    const c = controlledStream(signal)
    c.send(
      snapshotFrame({
        bootId: 'boot-1',
        seq: 1,
        conversations: [makeConv({ id: 1, unread: true, stateChangeSeq: 2 })],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }),
    )
    return c
  })
  try {
    await h.waitFor((s) => s.notices.some((n) => n.title === 'Failed to mark as read'))
    assert.equal(h.patchCalls.length, 1)
    assert.equal(h.store().loadErrors['conversation:1'], undefined, 'loadErrors["conversation:1"] must stay unpolluted')

    // After the server recovers, refocusing: the failure wrote no cleared watermark and the in-flight record is gone, so the retry may succeed
    h.setPatchBehavior({ patchStatus: 200 })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await h.waitFor(() => h.patchCalls.length === 2)
  } finally {
    await h.close()
    page.restore()
  }
})

test('logout and snapshot reconnect clear the unread in-flight/watermark state; toggling focus after logout sends no more PATCHes', { timeout: 60_000 }, async () => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  const h = await mountProvider({ hash: '#/c/1', manualPatch: true })
  let stream1!: ControlledStream
  h.nextEvents((_url, signal) => {
    stream1 = controlledStream(signal)
    stream1.send(
      snapshotFrame({
        bootId: 'boot-1',
        seq: 1,
        conversations: [makeConv({ id: 1, unread: true, stateChangeSeq: 5 })],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }),
    )
    return stream1
  })
  try {
    await h.waitFor(() => h.pendingPatches.length === 1)
    // A new snapshot arrives after disconnect-reconnect: the old in-flight voids, the watermark resets, and a still-unread=true snapshot may trigger PATCHes again
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      c.send(
        snapshotFrame({
          bootId: 'boot-2',
          seq: 1,
          conversations: [makeConv({ id: 1, unread: true, stateChangeSeq: 5 })],
          pendingAsks: [],
          plugins: [],
          ui: [],
        }),
      )
      return c
    })
    await act(async () => {
      stream1.end()
    })
    await h.waitFor(() => h.patchCalls.length === 2)
    // Settle all pending requests first
    await act(async () => {
      for (const p of h.pendingPatches.splice(0)) p.resolve()
    })

    // After logout: listeners unbound and state cleared; toggling focus triggers no PATCH
    await act(async () => {
      h.store().logout()
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await h.flush()
    assert.equal(h.patchCalls.length, 2)
  } finally {
    await h.close()
    page.restore()
  }
})

test('切会话时中止过时 detail/artifacts 请求，静默吞掉 AbortError 且不回写旧响应', { timeout: 60_000 }, async (t) => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  t.after(() => page.restore())

  let detail1Signal: AbortSignal | null | undefined
  let artifacts1Signal: AbortSignal | null | undefined
  let releaseArtifacts1Late!: () => void
  const artifacts1Gate = new Promise<void>((resolve) => { releaseArtifacts1Late = resolve })

  const h = await mountProvider({
    hash: '#/c/1',
    onGet: async (path, signal) => {
      if (path.startsWith('/api/conversations/1?') || path === '/api/conversations/1') {
        detail1Signal = signal
        return await new Promise<Response>((_, reject) => {
          const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (path === '/api/conversations/1/artifacts') {
        artifacts1Signal = signal
        await artifacts1Gate
        return new Response(
          JSON.stringify([{ id: 901, title: 'stale-artifact' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (path === '/api/conversations/2/artifacts') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return undefined
    },
  })

  try {
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      c.send(
        snapshotFrame({
          bootId: 'boot-1',
          seq: 1,
          conversations: [
            makeConv({ id: 1, status: 'idle', stateChangeSeq: 1, lastEntryId: 1 }),
            makeConv({ id: 2, status: 'idle', stateChangeSeq: 1, lastEntryId: 2 }),
          ],
          pendingAsks: [],
          plugins: [],
          ui: [],
        }),
      )
      return c
    })

    // 等待 /api/conversations/1 请求发出
    const deadline = Date.now() + 10_000
    while ((detail1Signal === undefined || artifacts1Signal === undefined) && Date.now() < deadline) {
      await h.flush(15)
    }
    assert.ok(detail1Signal !== undefined && detail1Signal !== null, 'c/1 detail 请求应携带 AbortSignal')
    assert.ok(artifacts1Signal !== undefined && artifacts1Signal !== null, 'c/1 artifacts 请求应携带 AbortSignal')
    assert.equal(detail1Signal.aborted, false)
    assert.equal(artifacts1Signal.aborted, false)

    // 切到会话 2：必须立即中止会话 1 的过时详情与产物请求
    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 2 })
    })
    await h.waitFor((s) => s.conversationDetails[2] !== undefined)
    assert.equal(detail1Signal.aborted, true, '切会话后 c/1 detail AbortSignal 必须被中止')
    assert.equal(artifacts1Signal.aborted, true, '切会话后 c/1 artifacts AbortSignal 必须被中止')

    // 即使旧 artifacts 响应延迟到达，也不得回写污染 c/1 产物缓存
    await act(async () => {
      releaseArtifacts1Late()
    })
    await h.flush(40)

    assert.equal(h.store().conversationDetails[1], undefined, '被中止的 c/1 detail 不得写入缓存')
    assert.equal(h.store().conversationArtifacts[1], undefined, '过时 c/1 artifacts 响应不得回写状态')
    assert.equal(h.store().loadErrors['conversation:1'], undefined, 'AbortError 不得写入 loadErrors')
    assert.equal(h.store().notices.length, 0, 'AbortError 必须静默吞掉，不得弹出错误 notice')
  } finally {
    releaseArtifacts1Late()
    await h.close()
  }
})

test('窄屏默认拉取 limit=40 并支持向上分页，桌面保持 limit=150', { timeout: 60_000 }, async (t) => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  const originalInnerWidth = window.innerWidth
  t.after(() => {
    Object.assign(window, { innerWidth: originalInnerWidth })
    page.restore()
  })

  const requestedUrls: string[] = []
  Object.assign(window, { innerWidth: 375 })

  const h = await mountProvider({
    hash: '#/c/1',
    onGet: (path) => {
      if (path.startsWith('/api/conversations/1')) {
        requestedUrls.push(path)
        if (path === '/api/conversations/1/artifacts') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''
        const params = new URLSearchParams(query)
        if (params.get('cursor') === 'older-1') {
          return new Response(
            JSON.stringify({
              ...makeConv({ id: 1, stateChangeSeq: 1, lastEntryId: 2 }),
              entries: [{ id: 1, conversationId: 1, kind: 'message', role: 'user', content: 'earlier', createdAt: 1 }],
              nextCursor: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            ...makeConv({ id: 1, stateChangeSeq: 1, lastEntryId: 2 }),
            entries: [{ id: 2, conversationId: 1, kind: 'message', role: 'assistant', content: 'latest', createdAt: 2 }],
            nextCursor: 'older-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (path.startsWith('/api/conversations/2') && path !== '/api/conversations/2/artifacts') {
        requestedUrls.push(path)
      }
      return undefined
    },
  })

  try {
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      c.send(
        snapshotFrame({
          bootId: 'boot-1',
          seq: 1,
          conversations: [
            makeConv({ id: 1, stateChangeSeq: 1, lastEntryId: 2 }),
            makeConv({ id: 2, stateChangeSeq: 1, lastEntryId: 3 }),
          ],
          pendingAsks: [],
          plugins: [],
          ui: [],
        }),
      )
      return c
    })

    await h.waitFor((s) => s.sseConnected && s.conversationDetails[1] !== undefined)
    const mobileUrl = requestedUrls.find((u) => u.startsWith('/api/conversations/1?'))
    assert.ok(mobileUrl !== undefined, '应发起 c/1 详情请求')
    const mobileParams = new URLSearchParams(mobileUrl.slice(mobileUrl.indexOf('?') + 1))
    assert.equal(mobileParams.get('limit'), '40', '窄屏（<=680px）默认 limit 必须为 40')

    // 向上分页加载更早条目
    await act(async () => {
      await h.store().loadEarlierEntries(1)
    })
    const olderUrl = requestedUrls.find((u) => u.includes('cursor=older-1'))
    assert.ok(olderUrl !== undefined, 'loadEarlierEntries 应携带 cursor=older-1 请求')
    assert.deepEqual(
      h.store().conversationDetails[1]?.entries.map((e) => e.id),
      [1, 2],
      '向上分页应将更早条目合并在现有条目之前',
    )
    assert.equal(h.store().conversationDetails[1]?.nextCursor, null)

    // 切回桌面宽度后打开会话 2，验证默认 limit 恢复为 150
    Object.assign(window, { innerWidth: 1024 })
    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 2 })
    })
    await h.waitFor((s) => s.conversationDetails[2] !== undefined)
    const desktopUrl = requestedUrls.find((u) => u.startsWith('/api/conversations/2?'))
    assert.ok(desktopUrl !== undefined, '应发起 c/2 详情请求')
    const desktopParams = new URLSearchParams(desktopUrl.slice(desktopUrl.indexOf('?') + 1))
    assert.equal(desktopParams.get('limit'), '150', '桌面视口默认 limit 必须保持 150')
  } finally {
    await h.close()
  }
})

test('切回已缓存会话且 (stateChangeSeq, lastEntryId) 未变时跳过重复 listArtifacts，推进后恢复刷新', { timeout: 60_000 }, async (t) => {
  const page = setVisibilityAndFocus({ hidden: false, focused: true })
  t.after(() => page.restore())

  let artifacts1Calls = 0
  let currentSeq1 = 2
  let currentLastEntry1 = 5

  const h = await mountProvider({
    hash: '#/c/1',
    onGet: (path) => {
      if (path === '/api/conversations/1/artifacts') {
        artifacts1Calls += 1
        return new Response(
          JSON.stringify([{ id: artifacts1Calls, title: `art-${artifacts1Calls}` }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (path.startsWith('/api/conversations/1?') || path === '/api/conversations/1') {
        return new Response(
          JSON.stringify({
            ...makeConv({ id: 1, status: 'idle', stateChangeSeq: currentSeq1, lastEntryId: currentLastEntry1 }),
            entries: [],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (path === '/api/conversations/2/artifacts') {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.startsWith('/api/conversations/2?') || path === '/api/conversations/2') {
        return new Response(
          JSON.stringify({
            ...makeConv({ id: 2, status: 'idle', stateChangeSeq: 1, lastEntryId: 1 }),
            entries: [],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return undefined
    },
  })

  try {
    let stream1!: ControlledStream
    h.nextEvents((_url, signal) => {
      stream1 = controlledStream(signal)
      stream1.send(
        snapshotFrame({
          bootId: 'boot-1',
          seq: 1,
          conversations: [
            makeConv({ id: 1, status: 'idle', stateChangeSeq: 2, lastEntryId: 5 }),
            makeConv({ id: 2, status: 'idle', stateChangeSeq: 1, lastEntryId: 1 }),
          ],
          pendingAsks: [],
          plugins: [],
          ui: [],
        }),
      )
      return stream1
    })

    await h.waitFor(
      (s) => s.sseConnected && s.conversationDetails[1] !== undefined && s.conversationArtifacts[1] !== undefined,
    )

    // 切到会话 2 后立刻切回会话 1：水位未变且非 working，应跳过重复 listArtifacts(1)
    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 2 })
    })
    await h.waitFor((s) => s.conversationDetails[2] !== undefined)

    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 1 })
    })
    await h.waitFor((s) => s.primaryTarget.kind === 'conversation' && s.primaryTarget.conversationId === 1)
    await h.flush(60)
    assert.equal(artifacts1Calls, 1, '已缓存产物且 (stateChangeSeq, lastEntryId) 未变时应跳过重复 listArtifacts')

    // 离开期间通过 SSE 推进会话 1 水位后再次切回，必须重新拉取 artifacts
    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 2 })
    })
    await h.waitFor((s) => s.primaryTarget.kind === 'conversation' && s.primaryTarget.conversationId === 2)

    currentSeq1 = 3
    currentLastEntry1 = 6
    await act(async () => {
      stream1.send(
        eventFrame(2, {
          type: 'conversation.upsert',
          conversation: makeConv({ id: 1, status: 'idle', stateChangeSeq: 3, lastEntryId: 6 }),
        }),
      )
    })
    await h.waitFor((s) => s.conversations.find((c) => c.id === 1)?.stateChangeSeq === 3)

    await act(async () => {
      h.store().openTarget({ kind: 'conversation', conversationId: 1 })
    })
    await h.waitFor(() => artifacts1Calls === 2)
    assert.equal(artifacts1Calls, 2, '水位推进后再次切回会话应重新拉取 artifacts')
  } finally {
    await h.close()
  }
})
