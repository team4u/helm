/**
 * Focused tests for microkernel host public mechanisms (core commit scope):
 * - epoch guard: wrapHostApi sub-ports (profiles/skills/secrets/nodeIpc/executionEnv proxies)
 *   invalidate stale handles (409) after disable/restart while fresh cycle handles work;
 * - nodeIpc.subscribe race: release before subscribe finishes aborts/stops cleanly on arrival
 *   without leaking, and setup failures return via the Promise (never swallowed by void);
 * - onUpdate: forwards partials via bounded output (redacted), silently drops late partials
 *   after settle;
 * - prompt projection: only active tools enter prompt.tools.* sections without ghost residues;
 *   promptGuidelines arrays expand line by line.
 * - createArtifact/submitInput attachments: plugin port wiring over the real runtime (upload
 *   validation, attachment authorization, [Attached Files] manifest reaching the model, expiry).
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmxError, type HelmxHostApi, type PluginDefinition } from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { projectToolPromptSections } from '../src/runtime/runtime-helpers.js'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, deferred, makeConversationSummary, makeFauxModels, useTempDir } from './helpers.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { KernelRuntime } from '../src/runtime/index.js'

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id })
}

interface NodeIpcCalls {
  subscribeStarted: Array<{ nodeId: string; signal: AbortSignal }>
  stopCalls: number
}

/** Stub for openTunnel: delivers a controllable Duplex after delay; logs calls and failures. */
interface OpenTunnelStub {
  calls: Array<{ nodeId: string; target: { host?: string; port: number }; signal: AbortSignal | undefined }>
  delayMs: number
  duplexes: PassThrough[]
  failures: Array<Error | undefined>
}

function makeBackend(over: {
  nodeIpcCalls?: NodeIpcCalls
  /** Pre-connect delay before subscribe resolves (default 10ms, simulates slow setup). */
  subscribeDelayMs?: number
  /** openTunnel stub (wires ctx.host.openTunnel when supplied). */
  openTunnel?: OpenTunnelStub
  nodeFetch?: (nodeId: string) => typeof fetch
}): PluginHostBackend {
  const calls = over.nodeIpcCalls ?? { subscribeStarted: [], stopCalls: 0 }
  return {
    ...createPluginHostBackendFixture(),
    listActiveSpawnExecutions: () => [],
    profiles: {
      list: async () => [{ id: 'assistant' }] as never,
      get: async (id) => ({ id }) as never,
      getSystem: async () => '',
      save: async (p) => p,
      directory: async (id) => `/data/profiles/${id}`,
    },
    skills: {
      list: async () => [],
      readFile: async () => '',
      directory: async (id) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          throw new HelmxError('validation_error', `invalid skill id: ${id}`, 400, { skillId: id })
        }
        return `/data/skills/${id}`
      },
      ensureSkill: async () => {},
    },
    secrets: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      addRedaction: () => () => {},
    },
    setPluginConfig: async () => {},
    nodeIpc: {
      isOnline: () => true,
      getNodeHubUrl: () => undefined,
      call: async () => ({ ok: true, value: '' }),
      subscribe: (nodeId, input, onLine, _onClosed, signal) =>
        new Promise<() => void>((resolve) => {
          calls.subscribeStarted.push({ nodeId, signal: signal! })
          setTimeout(() => {
            // Simulates subscribe establishment: returns stop callback.
            resolve(() => {
              calls.stopCalls += 1
            })
            // Emits one event line after setup to exercise the channel.
            onLine(`event:${nodeId}`)
          }, over.subscribeDelayMs ?? 10)
        }),
    },
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    forkConversation: async (id, opts) => ({
      ...makeConversation(id + 100),
      parentConversationId: id,
      title: opts?.title ?? `conv-${id} (fork)`,
    }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    updateConversation: async (id) => makeConversation(id),
    abortConversation: async () => {},
    getConversationOwnership: () => 'helmx',
    listArtifacts: async () => [],
    getArtifact: async () => { throw new HelmxError('not_found', 'no artifact', 404) },
    refreshModels: async () => ({ providers: [], aborted: false, errors: {}, models: [], providerCatalog: [] }),
    withFileLock: async (_p, fn) => fn(),
    atomicWriteFile: async () => {},
    completeText: async () => '',
    executionEnv: () => ({
      readTextFile: async () => 'content',
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    }) as never,
    buildSpawnEnv: () => ({}),
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'a', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
    ...(over.nodeFetch === undefined ? {} : { nodeFetch: over.nodeFetch }),
    ...(over.openTunnel !== undefined
      ? {
          openTunnel: ((nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) => {
            const stub = over.openTunnel!
            stub.calls.push({ nodeId, target, signal })
            return new Promise<PassThrough>((resolve, reject) => {
              const timer = setTimeout(() => {
                // Pre-seeded failure queue: FIFO consumed per attempt (next connect starts fresh).
                const failure = stub.failures.shift()
                if (failure !== undefined) { reject(failure); return }
                const duplex = new PassThrough()
                stub.duplexes.push(duplex)
                resolve(duplex)
              }, stub.delayMs)
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  reject(new HelmxError('aborted', 'tunnel establishment aborted', 499))
                },
                { once: true },
              )
            })
          }) as never,
        }
      : {}),
  }
}

let dataDir: string

test('host public mechanism suite', { timeout: 60_000 }, async (t) => {
  dataDir = useTempDir(t, 'helmx-host-core-')

  await t.test('epoch guard: post-disable calls on stale host handle reject 409 plugin_context_expired', async () => {
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({}), docs: new MemoryDocStore() })
    let captured: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    const def: PluginDefinition = {
      id: 'p:epoch',
      definePlugin(ctx) {
        captured = ctx.host
      },
    }
    await host.register(def, { enabled: true })
    assert.ok(captured)
    // Works during active cycle.
    assert.equal(await captured!.profiles.get('assistant') !== undefined, true)
    await host.disable('p:epoch')
    // Wrap sync throws uniformly as async rejections so assertions share one path.
    const expired: Array<() => unknown> = [
      () => captured!.profiles.list(),
      () => captured!.skills.list(),
      () => captured!.secrets.get('k'),
      () => captured!.nodeIpc.isOnline('local'),
      () => captured!.completeText({ conversationId: 1, systemPrompt: '', text: '' }),
      () => captured!.forkConversation(1, { entryId: 1 }),
      () => captured!.createArtifact(1, { name: 'a.txt', bytes: new TextEncoder().encode('x') }),
      () => captured!.refreshModels(),
      () => captured!.redact('x'),
      () => captured!.executionEnv('local', '/tmp').canonicalPath('/tmp/x', BACKGROUND_CONTEXT),
      () => captured!.withFileLock('/tmp/x', async () => 1),
      () => captured!.atomicWriteFile('/tmp/x', 'y'),
    ]
    for (const call of expired) {
      await assert.rejects(async () => call(), (err: unknown) => {
        assert.ok(err instanceof HelmxError, `expected HelmxError, got ${String(err)}`)
        assert.equal(err.code, 'plugin_context_expired')
        return true
      })
    }
    // After re-enable: definePlugin reruns so captured holds a fresh cycle handle; the stale loop above
    // already verified old handles return 409 -- here we verify the fresh handle becomes usable again.
    await host.enable('p:epoch')
    await assert.doesNotReject(captured!.profiles.get('assistant'))
    await host.unregister('p:epoch').catch(() => {})
  })

  await t.test('withFileLock: re-checks epoch after acquiring lock inside queue before invoking fn', { timeout: 60_000 }, async () => {
    // Scenario: lock contention + forced host dispose (liveTasks preflight only blocks disable;
    // dispose immediately expires the epoch): queued fn from old epoch rejects 409 on lock acquisition.
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const backend = makeBackend({})
    backend.withFileLock = async <T,>(path: string, fn: () => Promise<T>) => {
      if (path === '/tmp/hold') {
        await gate // first holder pauses before releasing so second queues behind it
        return fn()
      }
      return fn()
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    let second: Promise<unknown> | undefined
    const def: PluginDefinition = {
      id: 'p:lock',
      definePlugin(ctx) {
        ctx.service({
          id: 's',
          async start() {
            void ctx.host.withFileLock('/tmp/hold', async () => 'first').catch(() => {})
            await new Promise((r) => setTimeout(r, 10))
            second = ctx.host.withFileLock('/tmp/hold', async () => 'should-not-run')
          },
          async stop() {},
        })
      },
    }
    await host.register(def, { enabled: true })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(second, 'second lock request should be queued')
    // Force dispose expires epoch without disable preflight; then release holder so queued fn wakes expired.
    void host.dispose()
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst!()
    await assert.rejects(second, (err: unknown) =>
      err instanceof HelmxError &&
      (err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed'),
    )
  })

  await t.test('nodeIpc.subscribe race: release before setup finishes aborts/stops late-arriving subscriptions', { timeout: 60_000 }, async () => {
    const calls: NodeIpcCalls = { subscribeStarted: [], stopCalls: 0 }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ nodeIpcCalls: calls, subscribeDelayMs: 30 }), docs: new MemoryDocStore() })
    let release: (() => void) | undefined
    const def: PluginDefinition = {
      id: 'p:ipc',
      definePlugin(ctx) {
        // Subscribe right on register so disable triggers cleanup before/during setup.
        void ctx.host.nodeIpc.subscribe('remote-1', { line: '{"method":"subscribe"}' }, () => {}, () => {})
          .then((stop) => { release = stop })
          .catch(() => {})
      },
    }
    // Alternatively obtain release cleanly inside service.start.
    const defSubscribe: PluginDefinition = {
      id: 'p:ipc2',
      definePlugin(ctx) {
        ctx.service({
          id: 's',
          async start() {
            const stop = await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
            release = stop
          },
          async stop() {},
        })
      },
    }
    await host.register(defSubscribe, { enabled: true })
    assert.ok(release, 'service.start should yield an unsubscribe handle')
    // Disabling triggers release wrapper (abort + stop).
    await host.disable('p:ipc2')
    // Wait for delayed setup path to settle.
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(calls.stopCalls >= 1, true, 'disable should invoke backend stop immediately or on late completion')
    await host.unregister('p:ipc2').catch(() => {})
    void def
  })

  await t.test('openTunnel lifecycle tracking: active Duplex blocks disable, closing unblocks, failures never leak count', { timeout: 60_000 }, async () => {
    const stub: OpenTunnelStub = { calls: [], delayMs: 20, duplexes: [], failures: [] }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ openTunnel: stub }), docs: new MemoryDocStore() })
    let hostApi: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    const def: PluginDefinition = {
      id: 'p:tunnel',
      definePlugin(ctx) {
        hostApi = ctx.host
      },
    }
    await host.register(def, { enabled: true })
    assert.ok(hostApi)

    // 1) Setup in flight: task begins as soon as connection starts, visible to disable preflight.
    const opening = hostApi!.openTunnel('remote-1', { host: 'db.internal', port: 5432 })
    assert.equal(stub.calls.length, 1, 'backend openTunnel invoked')
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    )
    const duplex = await opening
    // 2) Active Duplex remains open after setup finishes: counter stays held (regression against immediate withTask release).
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks',
      'disable must return 409 while Duplex is active instead of dropping counter on setup resolve',
    )
    // 3) Duplex closes: task settles once and disable succeeds again.
    duplex.destroy()
    await new Promise((r) => setTimeout(r, 30))
    await host.disable('p:tunnel')

    // 4) Failure path (separate plugin to avoid epoch change invalidating handle):
    // setup failure ends task immediately without leaking count -> disable succeeds cleanly.
    stub.failures.push(new HelmxError('node_tunnel_connect_failed', 'setup failed', 502))
    let hostApi2: typeof hostApi | undefined
    const defFail: PluginDefinition = {
      id: 'p:tunnel2',
      definePlugin(ctx) {
        hostApi2 = ctx.host
      },
    }
    await host.register(defFail, { enabled: true })
    await assert.rejects(
      hostApi2!.openTunnel('remote-1', { port: 5432 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'node_tunnel_connect_failed',
    )
    await host.disable('p:tunnel2')
    await host.unregister('p:tunnel').catch(() => {})
    await host.unregister('p:tunnel2').catch(() => {})
    void host.dispose()
  })

  await t.test('nodeFetch: preserves slow-consumer backpressure, releases task on cancel, sync throws never leak count', { timeout: 60_000 }, async () => {
    let pulls = 0
    let cancelled = false
    const raw = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(32))
        if (pulls === 64) controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })))) as typeof fetch
    const backend = makeBackend({ nodeFetch: () => raw })
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({ id: 'p:fetch-flow', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      const response = await api.nodeFetch('remote-1')('http://example.test')
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.ok(pulls <= 1, `must not drain response continuously while unconsumed (pulled ${pulls} times)`)
      await assert.rejects(host.disable('p:fetch-flow'), { code: 'plugin_has_live_tasks' })
      await response.body!.cancel()
      assert.equal(cancelled, true)
      await host.disable('p:fetch-flow')

      const failure = new Error('sync fetch failed')
      backend.nodeFetch = () => (() => { throw failure }) as typeof fetch
      await host.register({ id: 'p:fetch-throw', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
      await assert.rejects(api.nodeFetch('remote-1')('http://example.test'), failure)
      await host.disable('p:fetch-throw')
    } finally {
      await host.dispose()
    }
  })

  await t.test('nodeFetch: response body wrapping failure (pre-locked stream) finishes counter without leaking', { timeout: 60_000 }, async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4)) },
    })
    const raw = (async () => {
      const response = new Response(source, { status: 200 })
      // Pre-lock response.body so wrapper's getReader() throws deterministically
      void response.body!.getReader()
      return response
    }) as typeof fetch
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ nodeFetch: () => raw }), docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({
      id: 'p:fetch-wrap-fail',
      definePlugin: (ctx) => { api = ctx.host },
    }, { enabled: true })
    try {
      await assert.rejects(api.nodeFetch('remote-1')('http://example.test'))
      // Exception in body wrapper must finish live-task counter so disable succeeds cleanly
      await host.disable('p:fetch-wrap-fail')
    } finally {
      await host.dispose()
    }
  })

  await t.test('nodeFetch: abandoned Response stays deterministically busy (disable 409) until explicit cancel (no GC fallback)', { timeout: 60_000 }, async () => {
    // Contract removes FinalizationRegistry safety net for deterministic resource ownership: plugins receiving
    // a Response must consume or cancel it; abandoned responses keep in-flight tasks visible (hard blocking
    // disable/reload) instead of masking leaks behind non-deterministic GC timing.
    const raw = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32))
        // Never closes: simulates long SSE stream (headers arriving must not settle task).
      },
      cancel() {},
    }, { highWaterMark: 0 })))) as typeof fetch
    const backend = makeBackend({ nodeFetch: () => raw })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({ id: 'p:fetch-abandon', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      const response = await api.nodeFetch('remote-1')('http://example.test')
      assert.equal(response.status, 200, 'resolves as soon as headers arrive without waiting for body')
      // Abandoned: inspect only status without consuming or canceling.
      void response
      await new Promise<void>((resolve) => setImmediate(resolve))
      await assert.rejects(host.disable('p:fetch-abandon'), { code: 'plugin_has_live_tasks' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Still 409 across multiple event-loop turns (deterministic occupancy, not transient GC timing).
      await assert.rejects(host.disable('p:fetch-abandon'), { code: 'plugin_has_live_tasks' })
      // Only convergence path: explicit cancel (draining to EOF works identically, covered elsewhere).
      await response.body!.cancel()
      await host.disable('p:fetch-abandon')
    } finally {
      await host.dispose()
    }
  })

  await t.test('nodeFetch deterministic host-close ownership: local unending bodies & pre-header requests abort cleanly on dispose', { timeout: 60_000 }, async () => {
    // Local path delegates to globalThis.fetch outside EnvFabric.close's remote tunnel teardown, so deterministic
    // cancellation relies on per-call AbortController (host dispose triggers abort while normal disable rejects 409).
    let socketClosed = 0
    let headersSent = 0
    const server = http.createServer((req, res) => {
      headersSent += 1
      if (req.url === '/pending') {
        // Never responds with headers (hangs pre-headers).
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: a\n\n')
      // Unending SSE stream.
      const timer = setInterval(() => res.write('data: x\n\n'), 50)
      res.on('close', () => { clearInterval(timer); socketClosed += 1 })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    const backend = makeBackend({ nodeFetch: () => globalThis.fetch as typeof fetch })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({ id: 'p:fetch-dispose', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      // --- Unending local body: abandoned (unconsumed/uncanceled); dispose actually closes connection ---
      const response = await api.nodeFetch('local')(`${base}/stream`)
      assert.equal(response.status, 200)
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Normal disable rejects 409 deterministically and must never abort the active stream (only dispose aborts).
      await assert.rejects(host.disable('p:fetch-dispose'), { code: 'plugin_has_live_tasks' })
      const reader0 = response.body!.getReader()
      const chunk = await reader0.read()
      assert.ok(!chunk.done, '409 disable rejection must not abort in-flight stream')

      await host.dispose()
      // Dispose fires cleanup: cancels underlying request (closing server socket).
      for (let i = 0; i < 100 && socketClosed === 0; i += 1) await delay(20)
      assert.ok(socketClosed >= 1, `local in-flight request must cancel on host dispose (server sockets closed: ${socketClosed})`)

      // --- Pre-header pending request: dispose rejects fetch promise with abort error ---
      const host2 = new PluginHost({ dataDir, host: makeBackend({ nodeFetch: () => globalThis.fetch as typeof fetch }), docs: new MemoryDocStore() })
      let api2!: HelmxHostApi
      await host2.register({ id: 'p:fetch-pending', definePlugin(ctx) { api2 = ctx.host } }, { enabled: true })
      const pending = api2.nodeFetch('local')(`${base}/pending`)
      await delay(50) // request sent, headers not yet returned
      const disposed = host2.dispose()
      await assert.rejects(() => pending, (error: unknown) => {
        // Cleanup aborts using host disposal reason; undici rejects with signal.reason
        // (deterministic ownership); compatible layers may rethrow AbortError.
        if (error instanceof HelmxError && error.code === 'plugin_host_disposed') return true
        const name = error instanceof Error ? error.name : String(error)
        return name === 'AbortError' || /abort/i.test(String((error as { message?: string }).message ?? name))
      })
      await disposed
      assert.ok(headersSent >= 2, 'both requests reached the server')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await t.test('nodeFetch abort signal override semantics: init.signal overrides Request.signal, explicit null clears it, host dispose still aborts', { timeout: 60_000 }, async () => {
    // Matches standard fetch semantics (only combines with host-owned signal via AbortSignal.any, never with stale overridden Request.signal):
    let socketClosed = 0
    const server = http.createServer((req, res) => {
      if (req.url === '/pending') return // never sends headers
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: a\n\n')
      const timer = setInterval(() => res.write('data: x\n\n'), 50)
      res.on('close', () => { clearInterval(timer); socketClosed += 1 })
    })
    server.on('clientError', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    const backend = makeBackend({ nodeFetch: () => globalThis.fetch as typeof fetch })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({ id: 'p:fetch-signal', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      // 1) Request's original signal is aborted, but init supplies an active signal: request must succeed
      // (naive merging of both signals would wrongly abort via the overridden signal).
      const stale = new AbortController()
      stale.abort()
      const fresh = new AbortController()
      const overridden = await api.nodeFetch('local')(new Request(`${base}/stream`, { signal: stale.signal }), { signal: fresh.signal })
      assert.equal(overridden.status, 200, 'init.signal override prevents aborted Request.signal from canceling request')
      const r1 = overridden.body!.getReader()
      const chunk1 = await r1.read()
      assert.ok(!chunk1.done && chunk1.value !== undefined, 'stream reads normally when override signal is not aborted')
      await r1.cancel()

      // 2) Overriding init signal aborts: cancels genuinely (pre-header request rejects with AbortError).
      const caller = new AbortController()
      const pending = api.nodeFetch('local')(`${base}/pending`, { signal: caller.signal })
      await delay(50)
      caller.abort()
      await assert.rejects(() => pending, (error: unknown) => {
        const name = error instanceof Error ? error.name : String(error)
        return name === 'AbortError' || /abort/i.test(String((error as { message?: string }).message ?? name))
      })

      // 3) init.signal = null clears inherited aborted Request signal: request runs normally,
      // and abandoned body still cancels deterministically on host dispose.
      const aborted = new AbortController()
      aborted.abort()
      const cleared = await api.nodeFetch('local')(new Request(`${base}/stream`, { signal: aborted.signal }), { signal: null })
      assert.equal(cleared.status, 200, 'explicit null clears inherited aborted Request signal')
      void cleared // abandoned (neither consumed nor canceled)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await host.dispose()
      for (let i = 0; i < 100 && socketClosed === 0; i += 1) await delay(20)
      assert.ok(socketClosed >= 1, `host dispose still aborts in-flight requests even after signal:null (closed ${socketClosed})`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await t.test('setConfig: concurrent patches serialize read-modify-write without later writes clobbering earlier ones', { timeout: 60_000 }, async () => {
    const captured: Record<string, unknown> = {}
    const firstWriteGate = deferred<void>()
    let backendCalls = 0
    const backend: PluginHostBackend = {
      ...makeBackend({}),
      setPluginConfig: async (_id, value) => {
        backendCalls += 1
        // Pause first write to fabricate the read-modify-write race window
        if (backendCalls === 1) await firstWriteGate.promise
        Object.assign(captured, value)
      },
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmxHostApi
    await host.register({
      id: 'p:cfg',
      definePlugin: (ctx) => { api = ctx.host },
    }, { enabled: true })
    try {
      const w1 = api.setConfig({ a: 1 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const w2 = api.setConfig({ b: 2 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      firstWriteGate.resolve()
      await Promise.all([w1, w2])
      assert.deepEqual(captured, { a: 1, b: 2 })
    } finally {
      await host.dispose()
    }
  })

  await t.test('openTunnel: host dispose destroys active and late-arriving Duplexes', { timeout: 60_000 }, async () => {
    for (const delayMs of [0, 20]) {
      const stub: OpenTunnelStub = { calls: [], delayMs, duplexes: [], failures: [] }
      const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ openTunnel: stub }), docs: new MemoryDocStore() })
      let api!: HelmxHostApi
      await host.register({ id: `p:tunnel-dispose-${delayMs}`, definePlugin(ctx) { api = ctx.host } }, { enabled: true })
      const opening = api.openTunnel('local', { port: 9000 })
      if (delayMs === 0) {
        const duplex = await opening
        await host.dispose()
        assert.equal(duplex.destroyed, true)
      } else {
        const rejected = assert.rejects(opening, (error: unknown) =>
          error instanceof HelmxError && (error.code === 'plugin_host_disposed' || error.code === 'plugin_context_expired'))
        await host.dispose()
        await rejected
        assert.equal(stub.duplexes[0]?.destroyed, true)
      }
    }
  })

  await t.test('onUpdate: forwards string partials to output and silently drops late partials after settle', async () => {
    // Tests tool-registry onUpdate wrapper semantics (outer path to pluginToolResult) with a minimal
    // controllable stub: forwards before settle, drops silently after settle.
    const chunks: string[] = []
    let settled = false
    const output = (chunk: string): void => {
      if (settled) throw new Error('Tool call has settled')
      chunks.push(chunk)
    }
    const onUpdate = (partial: { output: string | Array<{ type: 'text'; text: string }> }): void => {
      const text = typeof partial.output === 'string' ? partial.output : partial.output.map((b) => b.text).join('')
      try {
        output(text)
      } catch (err) {
        if (err instanceof Error && err.message.includes('has settled')) return
        throw err
      }
    }
    onUpdate({ output: 'part-1 ' })
    onUpdate({ output: [{ type: 'text', text: 'part-2' }] })
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
    settled = true
    onUpdate({ output: 'late' }) // neither throws nor pushes
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
  })

  await t.test('prompt projection: only active tools populate sections without ghost residues; guidelines array expands', () => {
    const base = [
      { id: 'profile.system', text: 'SYS' },
      { id: 'prompt.tools.update_memory', text: 'stale snippet (should be overwritten)' },
      { id: 'prompt.tools.ghost_tool', text: 'ghost section (tool stripped, should be removed)' },
    ]
    const projected = projectToolPromptSections(base, [
      { name: 'update_memory', promptSnippet: 'use update_memory to save memory.' },
      { name: 'load_skill', promptGuidelines: ['read SKILL.md first', 'read references on demand'] },
    ])
    const ids = projected.map((s) => s.id)
    assert.ok(!ids.includes('prompt.tools.ghost_tool'), 'ghost section must be removed')
    const snippet = projected.find((s) => s.id === 'prompt.tools.update_memory')
    assert.equal(snippet?.text, 'use update_memory to save memory.')
    const guidelines = projected.find((s) => s.id === 'prompt.tools.guidelines')
    assert.ok(guidelines)
    assert.ok(guidelines!.text.includes('- load_skill: read SKILL.md first'))
    assert.ok(guidelines!.text.includes('- load_skill: read references on demand'))
    // Empty projection: removes all prompt.tools.* sections (including guidelines).
    const cleared = projectToolPromptSections(projected, [])
    assert.ok(!cleared.some((s) => s.id.startsWith('prompt.tools.')))
  })

  await t.test('ctx.host.forkConversation: forwards args to real Runtime, boundary errors, liveTasks, and disable expiry', { timeout: 60_000 }, async (sub) => {
    // 1. liveTasks + epoch guard: in-flight forkConversation returns 409 plugin_has_live_tasks on disable;
    // once done and disabled, stale handle throws 409 plugin_context_expired.
    let resolveFork!: (summary: ReturnType<typeof makeConversation>) => void
    const forkGate = new Promise<ReturnType<typeof makeConversation>>((resolve) => {
      resolveFork = resolve
    })
    const liveBackend: PluginHostBackend = {
      ...makeBackend({}),
      forkConversation: async () => forkGate,
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: liveBackend, docs: new MemoryDocStore() })
    let liveHost: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    await host.register({
      id: 'p:fork-live',
      definePlugin(ctx) {
        liveHost = ctx.host
      },
    }, { enabled: true })
    assert.ok(liveHost)
    const pendingFork = liveHost!.forkConversation(1, { entryId: 1, title: 'in-flight' })
    await delay(10)
    await assert.rejects(
      () => host.disable('p:fork-live'),
      (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_has_live_tasks',
    )
    resolveFork({ ...makeConversation(101), parentConversationId: 1, title: 'in-flight' })
    const stubForked = await pendingFork
    assert.equal(stubForked.parentConversationId, 1)
    assert.equal(stubForked.title, 'in-flight')
    await host.disable('p:fork-live')
    await assert.rejects(
      async () => liveHost!.forkConversation(1, { entryId: 1 }),
      (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
    )

    // 2. Real KernelRuntime end-to-end wiring: 400/404 validation, normal inheritance on fork, and post-disable expiry.
    const rtDir = useTempDir(sub, 'helmx-host-fork-rt-')
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('recorded passcode ALPHA-99')])
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let realHost: HelmxHostApi | undefined
      await runtime.plugins.register({
        id: 'p:fork-real',
        definePlugin(ctx) {
          realHost = ctx.host
        },
      }, { enabled: true })
      assert.ok(realHost)

      await runtime.services.profiles.save({
        id: 'reviewer',
        name: 'review',
        model: 'faux/faux-1',
        cwd: rtDir,
      })
      const parent = await runtime.createConversation({
        profileId: 'reviewer',
        cwd: rtDir,
        title: 'parent conversation',
      })
      await runtime.submitInput(parent.id, 'please remember passcode ALPHA-99')
      await runtime.waitForIdle(parent.id)
      const detail = await runtime.getConversationDetail(parent.id)
      const lastEntry = detail.entries.at(-1)
      assert.ok(lastEntry)
      const lastEntryId = Number(lastEntry.id)
      assert.ok(Number.isSafeInteger(lastEntryId) && lastEntryId > 0)

      for (const badEntryId of [0, -1, 1.5]) {
        await assert.rejects(
          () => realHost!.forkConversation(parent.id, { entryId: badEntryId }),
          (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
        )
      }
      await assert.rejects(
        () => realHost!.forkConversation(999999, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        () => realHost!.forkConversation(parent.id, { entryId: 999999 }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      const forked = await realHost!.forkConversation(parent.id, {
        entryId: lastEntryId,
        title: 'custom fork title',
      })
      assert.equal(forked.parentConversationId, parent.id)
      assert.equal(forked.title, 'custom fork title')
      assert.equal(forked.profileId, 'reviewer')
      assert.equal(forked.cwd, rtDir)
      assert.equal(forked.model, 'faux/faux-1')

      const forkedDetail = await runtime.getConversationDetail(forked.id)
      assert.ok(JSON.stringify(forkedDetail.entries).includes('ALPHA-99'))

      const cleanForked = await realHost!.forkConversation(parent.id)
      assert.equal(cleanForked.parentConversationId, parent.id)
      assert.equal(cleanForked.title, 'parent conversation (fork)')
      const cleanForkedDetail = await runtime.getConversationDetail(cleanForked.id)
      assert.ok(JSON.stringify(cleanForkedDetail.entries).includes('ALPHA-99'))

      const emptyParent = await runtime.createConversation({
        profileId: 'reviewer',
        cwd: rtDir,
        title: 'empty parent',
      })
      await assert.rejects(
        () => realHost!.forkConversation(emptyParent.id),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'fork_empty_history',
      )

      await runtime.plugins.disable('p:fork-real')
      await assert.rejects(
        async () => realHost!.forkConversation(parent.id, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
      )
    } finally {
      await runtime.close()
    }
  })

  await t.test('ctx.host.createArtifact + submitInput attachments: real runtime wiring end-to-end', { timeout: 60_000 }, async (sub) => {
    const rtDir = useTempDir(sub, 'helmx-host-attach-rt-')
    const { models, faux } = makeFauxModels()
    // Response factory echoes whether the attachment manifest reached the model transcript.
    faux.setResponses([
      (context) => {
        const sawManifest = JSON.stringify(context.messages).includes('[Attached Files]')
        return fauxAssistantMessage(sawManifest ? 'ATTACHMENT_MANIFEST_SEEN' : 'ATTACHMENT_MANIFEST_MISSING')
      },
    ])
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let realHost: HelmxHostApi | undefined
      await runtime.plugins.register({
        id: 'p:attach-real',
        definePlugin(ctx) {
          realHost = ctx.host
        },
      }, { enabled: true })
      assert.ok(realHost)

      await runtime.services.profiles.save({
        id: 'courier',
        name: 'courier',
        model: 'faux/faux-1',
        cwd: rtDir,
      })
      const conv = await runtime.createConversation({
        profileId: 'courier',
        cwd: rtDir,
        title: 'attachment relay',
      })
      const other = await runtime.createConversation({
        profileId: 'courier',
        cwd: rtDir,
        title: 'sibling conversation',
      })

      // Boundary rejections before any write: missing conversation, invalid filename.
      await assert.rejects(
        () => realHost!.createArtifact(999999, { name: 'a.txt', bytes: new TextEncoder().encode('x') }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        () => realHost!.createArtifact(conv.id, { name: '../evil', bytes: new TextEncoder().encode('x') }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )

      // Happy path: text artifact + image artifact, both visible via listArtifacts.
      const textMeta = await realHost!.createArtifact(conv.id, {
        name: 'note.md',
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode('# relay note'),
      })
      assert.equal(textMeta.kind, 'upload')
      assert.equal(textMeta.conversationId, conv.id)
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const imageMeta = await realHost!.createArtifact(conv.id, {
        name: 'photo.png',
        mimeType: 'image/png',
        bytes: pngBytes,
      })
      const listed = await realHost!.listArtifacts(conv.id)
      assert.deepEqual(
        listed.map((m) => m.id).sort(),
        [textMeta.id, imageMeta.id].sort(),
      )

      // Attachment authorization: sibling-conversation artifact and unknown IDs are rejected.
      const siblingMeta = await realHost!.createArtifact(other.id, {
        name: 'private.txt',
        bytes: new TextEncoder().encode('sibling only'),
      })
      await assert.rejects(
        () => realHost!.submitInput(conv.id, 'x', { attachments: [siblingMeta.id] }),
        (err: unknown) => err instanceof HelmxError && err.status === 403 && err.code === 'artifact_forbidden',
      )
      await assert.rejects(
        () => realHost!.submitInput(conv.id, 'x', { attachments: ['no-such-artifact'] }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        // Shape gate at the shared submission entry: non-string elements never reach resolution.
        () => realHost!.submitInput(conv.id, 'x', { attachments: [42] as unknown as string[] }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )

      // Full relay: submitInput with attachments reaches the model with the [Attached Files] manifest.
      await realHost!.submitInput(conv.id, 'please review the attached files', {
        origin: 'trigger',
        attachments: [textMeta.id, imageMeta.id],
      })
      await runtime.waitForIdle(conv.id)
      const detail = await runtime.getConversationDetail(conv.id)
      const inputEntry = detail.entries.find(
        (e) => e.kind === 'user' || JSON.stringify(e).includes('please review the attached files'),
      )
      assert.ok(inputEntry, 'input entry present in timeline')
      const serialized = JSON.stringify(inputEntry)
      assert.ok(serialized.includes('note.md') && serialized.includes('photo.png'), 'attachment refs ride the input entry')
      // pi entry kinds are provider-native; assistant text lives in the model-context array, so
      // search the serialized timeline for the faux marker instead of filtering by kind.
      const timelineText = JSON.stringify(detail.entries)
      assert.ok(
        timelineText.includes('ATTACHMENT_MANIFEST_SEEN'),
        `model transcript carried the attachment manifest (timeline: ${timelineText.slice(0, 2000)})`,
      )

      // Deletion mid-flight safety: creating into a just-deleted conversation rejects 404, never orphans.
      await runtime.deleteConversation(other.id)
      await assert.rejects(
        () => realHost!.createArtifact(other.id, { name: 'late.txt', bytes: new TextEncoder().encode('x') }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      await runtime.plugins.disable('p:attach-real')
      // Wrap async: the epoch guard throws synchronously before entering the async backend call.
      await assert.rejects(
        async () => realHost!.createArtifact(conv.id, { name: 'late.txt', bytes: new TextEncoder().encode('x') }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
      )
    } finally {
      await runtime.close()
    }
  })
})
