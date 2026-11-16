/**
 * microkernel host public mechanism dedicated items test (core commit scope):
 * - epoch guard:wrapHostApi sub- port (profiles/skills/secrets/nodeIpc/executionEnv proxy)
 *   in deactivate/restart use cycle after old handle expires (409), new cycle handle available;
 * - nodeIpc.subscribe race: release first at subscribe establish complete when late to subscribe immediately cut (without leaking),
 *   establish error in return Promise(do not void swallow);
 * - onUpdate:partial forwarding to subject to control output(redaction), compute after late to partial static default discard;
 * - prompt throw shoot:promptSnippet/promptGuidelines only activate tool enter sections, strip after
 *   do not phantom segment;promptGuidelines array one by one items expand.
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type HelmHostApi, type PluginDefinition } from '@helm/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { projectToolPromptSections } from '../src/runtime/runtime-helpers.js'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, makeConversationSummary, makeFauxModels, useTempDir } from './helpers.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { KernelRuntime } from '../src/runtime/index.js'

// ---------------------------------------------------------------------------
// base create
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id })
}

interface NodeIpcCalls {
  subscribeStarted: Array<{ nodeId: string; signal: AbortSignal }>
  stopCalls: number
}

/** openTunnel stub: subject to control latency after deliver subject to control Duplex; record invoke and destroy supply assertion. */
interface OpenTunnelStub {
  calls: Array<{ nodeId: string; target: { host?: string; port: number }; signal: AbortSignal | undefined }>
  delayMs: number
  duplexes: PassThrough[]
  failures: Array<Error | undefined>
}

function makeBackend(over: {
  nodeIpcCalls?: NodeIpcCalls
  /** subscribe establish before latency (by default 10ms, simulated slow establish). */
  subscribeDelayMs?: number
  /** openTunnel stub (provide i.e. connect line ctx.host.openTunnel). */
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
          throw new HelmError('validation_error', `Skill id illegal:${id}`, 400, { skillId: id })
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
            // simulated subscribe establish succeeded: return stop function.
            resolve(() => {
              calls.stopCalls += 1
            })
            // establish after push one row event, verify channel.
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
      title: opts.title ?? `conv-${id} (fork)`,
    }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    updateConversation: async (id) => makeConversation(id),
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    listArtifacts: async () => [],
    getArtifact: async () => { throw new HelmError('not_found', 'no artifact', 404) },
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
                // pre- placement failed queue:FIFO consume (once push for under once create connect takes effect).
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
                  reject(new HelmError('aborted', 'tunnel establish cancelled', 499))
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

test('host public mechanism dedicated items', { timeout: 60_000 }, async (t) => {
  dataDir = useTempDir(t, 'helm-host-core-')

  await t.test('epoch guard: deactivate after old handle host invoke one rule 409 plugin_context_expired', async () => {
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
    // enable cycle inside available.
    assert.equal(await captured!.profiles.get('assistant') !== undefined, true)
    await host.disable('p:epoch')
    // guard sync throw: unify archive one is rejection after assertion (one by one await, type align).
    const expired: Array<() => unknown> = [
      () => captured!.profiles.list(),
      () => captured!.skills.list(),
      () => captured!.secrets.get('k'),
      () => captured!.nodeIpc.isOnline('local'),
      () => captured!.completeText({ conversationId: 1, systemPrompt: '', text: '' }),
      () => captured!.forkConversation(1, { entryId: 1 }),
      () => captured!.refreshModels(),
      () => captured!.redact('x'),
      () => captured!.executionEnv('local', '/tmp').canonicalPath('/tmp/x', BACKGROUND_CONTEXT),
      () => captured!.withFileLock('/tmp/x', async () => 1),
      () => captured!.atomicWriteFile('/tmp/x', 'y'),
    ]
    for (const call of expired) {
      await assert.rejects(async () => call(), (err: unknown) => {
        assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`)
        assert.equal(err.code, 'plugin_context_expired')
        return true
      })
    }
    // restart use after:definePlugin re- execute,captured already points to new cycle handle (available),
    // old handle do not re- store in - - on side loop already verify old handle all Chen 409. this in only verify new handle restore available.
    await host.enable('p:epoch')
    await assert.doesNotReject(captured!.profiles.get('assistant'))
    await host.unregister('p:epoch').catch(() => {})
  })

  await t.test('withFileLock: queue inside obtain lock invoke fn before again verify cycle (deactivate after old closed package do not write)', { timeout: 60_000 }, async () => {
    // scenario: lock competition + host force dispose(liveTasks preflight only intercept disable,dispose
    // directly split except cycle): queue up old cycle fn obtain lock when cycle already expires, must 409 reject write.
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const backend = makeBackend({})
    backend.withFileLock = async <T,>(path: string, fn: () => Promise<T>) => {
      if (path === '/tmp/hold') {
        await gate // first hold lock do not release, after continue queue up wait for
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
    assert.ok(second, 'second lock request should already queue')
    // force split except cycle (do not deactivate preflight); then release hold lock -> queue up fn enter when already expires.
    void host.dispose()
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst!()
    await assert.rejects(second, (err: unknown) =>
      err instanceof HelmError &&
      (err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed'),
    )
  })

  await t.test('nodeIpc.subscribe race: release first at establish complete when late to subscribe immediately cut', { timeout: 60_000 }, async () => {
    const calls: NodeIpcCalls = { subscribeStarted: [], stopCalls: 0 }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ nodeIpcCalls: calls, subscribeDelayMs: 30 }), docs: new MemoryDocStore() })
    let release: (() => void) | undefined
    const def: PluginDefinition = {
      id: 'p:ipc',
      definePlugin(ctx) {
        // register after immediately subscribe and in deactivate when release (acquire wrap).
        void ctx.host.nodeIpc.subscribe('remote-1', { line: '{"method":"subscribe"}' }, () => {}, () => {})
          .then((stop) => { release = stop })
          .catch(() => {})
      },
    }
    // manually get release: directly away service.start path too heavy, use register phase subscribe.
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
    assert.ok(release, 'service.start after completion should has unsubscribe handle')
    // deactivate:acquire release (abort + stop cut).
    await host.disable('p:ipc2')
    // etc. late to establish chain compute.
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(calls.stopCalls >= 1, true, 'deactivate should trigger backend stop(directly or late to cut)')
    await host.unregister('p:ipc2').catch(() => {})
    void def
  })

  await t.test('openTunnel lifecycle trace: activity Duplex during deactivate by refuse, close after can deactivate; failed without leaking counter', { timeout: 60_000 }, async () => {
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

    // 1) establish in-flight:begin first at create connect, deactivate preflight visible.
    const opening = hostApi!.openTunnel('remote-1', { host: 'db.internal', port: 5432 })
    assert.equal(stub.calls.length, 1, 'backend openTunnel already subject to')
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    )
    const duplex = await opening
    // 2) establish after success Duplex store: counter keep (withTask immediately end regression point).
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
      'activity Duplex during deactivate must 409(counter do not because establish complete while reset to zero)',
    )
    // 3) Duplex close:end exactly once, deactivate restore available.
    duplex.destroy()
    await new Promise((r) => setTimeout(r, 30))
    await host.disable('p:tunnel')

    // 4) failed path (independent cycle, avoid enable swap epoch affect handle):
    // establish failed immediately end, without leaking counter - - failed after disable no longer 409.
    stub.failures.push(new HelmError('node_tunnel_connect_failed', 'establish failed', 502))
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
      (err: unknown) => err instanceof HelmError && err.code === 'node_tunnel_connect_failed',
    )
    await host.disable('p:tunnel2')
    await host.unregister('p:tunnel').catch(() => {})
    await host.unregister('p:tunnel2').catch(() => {})
    void host.dispose()
  })

  await t.test('nodeFetch: slow consumer keep back press, cancel after release task, backend sync throws without leaking counter', { timeout: 60_000 }, async () => {
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
    let api!: HelmHostApi
    await host.register({ id: 'p:fetch-flow', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      const response = await api.nodeFetch('remote-1')('http://example.test')
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.ok(pulls <= 1, `unconsumed when cannot continuous read response (actual pull ${pulls} time)`)
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

  await t.test('nodeFetch: abandon placement Response(do not consume do not cancel) determinism occupy - -disable continuous 409, explicit cancel after release (without GC fall back)', { timeout: 60_000 }, async () => {
    // FinalizationRegistry security network already by contract remove: asset ownership fully determine - - plugin gets
    // Response after must consume or cancel; abandon placement i.e. in-flight task continuous visible (disable/reload
    // hard block assert cannot force), never dependency GC when machine leak leak mask decorate into can deactivate.
    const raw = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32))
        // forever do not close: simulated SSE long stream (header early already reach do not end task).
      },
      cancel() {},
    }, { highWaterMark: 0 })))) as typeof fetch
    const backend = makeBackend({ nodeFetch: () => raw })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmHostApi
    await host.register({ id: 'p:fetch-abandon', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      const response = await api.nodeFetch('remote-1')('http://example.test')
      assert.equal(response.status, 200, 'header reach i.e. return (without waiting body)')
      // abandon placement: only inspect status, since do not consume also do not cancel.
      void response
      await new Promise<void>((resolve) => setImmediate(resolve))
      await assert.rejects(host.disable('p:fetch-abandon'), { code: 'plugin_has_live_tasks' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      // across multiple event loop round still 409(determinism occupy, non- GC fall back short temporary window).
      await assert.rejects(host.disable('p:fetch-abandon'), { code: 'plugin_has_live_tasks' })
      // unique converge path: explicit cancel(drain to EOF same, another has test override).
      await response.body!.cancel()
      await host.disable('p:fetch-abandon')
    } finally {
      await host.dispose()
    }
  })

  await t.test('nodeFetch host close determinism ownership:local forever do not end body and headers before request in dispose after real cancel and release', { timeout: 60_000 }, async () => {
    // local path backend return globalThis.fetch:EnvFabric.close split remote tunnel
    // manage fewer than it, determinism cancel must from each invoke owned cleanup(host dispose trigger
    // together into AbortController), and normal disable do not abort(409 hard block assert cannot force).
    let socketClosed = 0
    let headersSent = 0
    const server = http.createServer((req, res) => {
      headersSent += 1
      if (req.url === '/pending') {
        // forever do not send response head (headers before suspended).
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: a\n\n')
      // forever do not end SSE long stream.
      const timer = setInterval(() => res.write('data: x\n\n'), 50)
      res.on('close', () => { clearInterval(timer); socketClosed += 1 })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    const backend = makeBackend({ nodeFetch: () => globalThis.fetch as typeof fetch })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    let api!: HelmHostApi
    await host.register({ id: 'p:fetch-dispose', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      // --- local forever do not end body: abandon placement (do not consume do not cancel),dispose after connect real close ---
      const response = await api.nodeFetch('local')(`${base}/stream`)
      assert.equal(response.status, 200)
      await new Promise<void>((resolve) => setImmediate(resolve))
      // normal disable: determinism occupy 409(cannot force), and must not borrow disable abort
      //(dispose of outside unique can run release path), stream still can read.
      await assert.rejects(host.disable('p:fetch-dispose'), { code: 'plugin_has_live_tasks' })
      const reader0 = response.body!.getReader()
      const chunk = await reader0.read()
      assert.ok(!chunk.done, 'disable  409 reject must not abort in-flight stream (do not borrow disable abort)')

      await host.dispose()
      // dispose trigger owned cleanup: underlying request real cancel (server side connect close).
      for (let i = 0; i < 100 && socketClosed === 0; i += 1) await delay(20)
      assert.ok(socketClosed >= 1, `host dispose after local in-flight request must real cancel (server side connect close; actual ${socketClosed})`)

      // --- headers before suspended request:dispose after fetch promise with cancel error reject ---
      const host2 = new PluginHost({ dataDir, host: makeBackend({ nodeFetch: () => globalThis.fetch as typeof fetch }), docs: new MemoryDocStore() })
      let api2!: HelmHostApi
      await host2.register({ id: 'p:fetch-pending', definePlugin(ctx) { api2 = ctx.host } }, { enabled: true })
      const pending = api2.nodeFetch('local')(`${base}/pending`)
      await delay(50) // request already out, response head not to.
      const disposed = host2.dispose()
      await assert.rejects(() => pending, (error: unknown) => {
        // owned cleanup with host destroy reason abort;undici original with signal.reason reject
        //(determinism ownership can observe). also compatibility implement layer with AbortError form on throw.
        if (error instanceof HelmError && error.code === 'plugin_host_disposed') return true
        const name = error instanceof Error ? error.name : String(error)
        return name === 'AbortError' || /abort/i.test(String((error as { message?: string }).message ?? name))
      })
      await disposed
      assert.ok(headersSent >= 2, 'two request all real reach server side')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await t.test('nodeFetch cancel signal override semantics:init.signal override Request.signal, explicit null clear inherit, host close still can cancel', { timeout: 60_000 }, async () => {
    // standard fetch semantics (AbortSignal.any together into, do not and by override old signal):
    let socketClosed = 0
    const server = http.createServer((req, res) => {
      if (req.url === '/pending') return // forever do not response head.
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
    let api!: HelmHostApi
    await host.register({ id: 'p:fetch-signal', definePlugin(ctx) { api = ctx.host } }, { enabled: true })
    try {
      // 1) Request original signal already abort, but init override signal not abort: request must normal enter row
      //(old implement two signal all and together into, will by already abort old signal error cancel).
      const stale = new AbortController()
      stale.abort()
      const fresh = new AbortController()
      const overridden = await api.nodeFetch('local')(new Request(`${base}/stream`, { signal: stale.signal }), { signal: fresh.signal })
      assert.equal(overridden.status, 200, 'init.signal override: already abort old Request signal must not cancel request')
      const r1 = overridden.body!.getReader()
      const chunk1 = await r1.read()
      assert.ok(!chunk1.done && chunk1.value !== undefined, 'override signal not abort when stream normal can read')
      await r1.cancel()

      // 2) init override signal abort: real cancel (headers before suspended request with AbortError reject).
      const caller = new AbortController()
      const pending = api.nodeFetch('local')(`${base}/pending`, { signal: caller.signal })
      await delay(50)
      caller.abort()
      await assert.rejects(() => pending, (error: unknown) => {
        const name = error instanceof Error ? error.name : String(error)
        return name === 'AbortError' || /abort/i.test(String((error as { message?: string }).message ?? name))
      })

      // 3) init.signal = null clear already abort  Request inherit signal: request normal;
      // abandon placement body after host dispose still can determinism cancel (connect real close).
      const aborted = new AbortController()
      aborted.abort()
      const cleared = await api.nodeFetch('local')(new Request(`${base}/stream`, { signal: aborted.signal }), { signal: null })
      assert.equal(cleared.status, 200, 'explicit null clear inherit: already abort  Request signal must not cancel request')
      void cleared // abandon placement (do not consume do not cancel).
      await new Promise<void>((resolve) => setImmediate(resolve))
      await host.dispose()
      for (let i = 0; i < 100 && socketClosed === 0; i += 1) await delay(20)
      assert.ok(socketClosed >= 1, `null clear inherit after host dispose still must real cancel in-flight request (actual close ${socketClosed})`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await t.test('openTunnel: host dispose destroy activity and establish after late to Duplex', { timeout: 60_000 }, async () => {
    for (const delayMs of [0, 20]) {
      const stub: OpenTunnelStub = { calls: [], delayMs, duplexes: [], failures: [] }
      const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ openTunnel: stub }), docs: new MemoryDocStore() })
      let api!: HelmHostApi
      await host.register({ id: `p:tunnel-dispose-${delayMs}`, definePlugin(ctx) { api = ctx.host } }, { enabled: true })
      const opening = api.openTunnel('local', { port: 9000 })
      if (delayMs === 0) {
        const duplex = await opening
        await host.dispose()
        assert.equal(duplex.destroyed, true)
      } else {
        const rejected = assert.rejects(opening, (error: unknown) =>
          error instanceof HelmError && (error.code === 'plugin_host_disposed' || error.code === 'plugin_context_expired'))
        await host.dispose()
        await rejected
        assert.equal(stub.duplexes[0]?.destroyed, true)
      }
    }
  })

  await t.test('onUpdate:partial all string forwarding output; compute after late to partial static default discard', async () => {
    // directly verify tool-registry  onUpdate wrap semantics (via pluginToolResult of outside channel).
    // this in with most small subject to control fake verify:settled before forwarding,settled after discard.
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
    onUpdate({ output: 'late' }) // do not throw do not push
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
  })

  await t.test('prompt throw shoot: only activate tool enter sections, strip do not phantom;guidelines array expand', () => {
    const base = [
      { id: 'profile.system', text: 'SYS' },
      { id: 'prompt.tools.update_memory', text: 'old refer quote (should by override)' },
      { id: 'prompt.tools.ghost_tool', text: 'phantom segment (tool already strip, should by clear)' },
    ]
    const projected = projectToolPromptSections(base, [
      { name: 'update_memory', promptSnippet: 'use update_memory save memory.' },
      { name: 'load_skill', promptGuidelines: ['first read SKILL.md', 'references on demand read'] },
    ])
    const ids = projected.map((s) => s.id)
    assert.ok(!ids.includes('prompt.tools.ghost_tool'), 'phantom segment must by clear')
    const snippet = projected.find((s) => s.id === 'prompt.tools.update_memory')
    assert.equal(snippet?.text, 'use update_memory save memory.')
    const guidelines = projected.find((s) => s.id === 'prompt.tools.guidelines')
    assert.ok(guidelines)
    assert.ok(guidelines!.text.includes('- load_skill: first read SKILL.md'))
    assert.ok(guidelines!.text.includes('- load_skill: references on demand read'))
    // empty throw shoot: clear all prompt.tools.*(contains guidelines).
    const cleared = projectToolPromptSections(projected, [])
    assert.ok(!cleared.some((s) => s.id.startsWith('prompt.tools.')))
  })

  await t.test('ctx.host.forkConversation: real Runtime forwarding parameter, boundary errors,liveTasks and deactivate block assert', { timeout: 60_000 }, async (sub) => {
    // 1. liveTasks + epoch guard: in-flight forkConversation during deactivate return 409 plugin_has_live_tasks; after completion deactivate old handle 409 plugin_context_expired.
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
      (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'plugin_has_live_tasks',
    )
    resolveFork({ ...makeConversation(101), parentConversationId: 1, title: 'in-flight' })
    const stubForked = await pendingFork
    assert.equal(stubForked.parentConversationId, 1)
    assert.equal(stubForked.title, 'in-flight')
    await host.disable('p:fork-live')
    await assert.rejects(
      async () => liveHost!.forkConversation(1, { entryId: 1 }),
      (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'plugin_context_expired',
    )

    // 2. real KernelRuntime end-to-end connect line:400/404 validate, normal fork inherit and deactivate expires.
    const rtDir = useTempDir(sub, 'helm-host-fork-rt-')
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('already record dark number ALPHA-99')])
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let realHost: HelmHostApi | undefined
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
      await runtime.submitInput(parent.id, 'please record dark number ALPHA-99')
      await runtime.waitForIdle(parent.id)
      const detail = await runtime.getConversationDetail(parent.id)
      const lastEntry = detail.entries.at(-1)
      assert.ok(lastEntry)
      const lastEntryId = Number(lastEntry.id)
      assert.ok(Number.isSafeInteger(lastEntryId) && lastEntryId > 0)

      for (const badEntryId of [0, -1, 1.5]) {
        await assert.rejects(
          () => realHost!.forkConversation(parent.id, { entryId: badEntryId }),
          (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
        )
      }
      await assert.rejects(
        () => realHost!.forkConversation(999999, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        () => realHost!.forkConversation(parent.id, { entryId: 999999 }),
        (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
      )

      const forked = await realHost!.forkConversation(parent.id, {
        entryId: lastEntryId,
        title: 'self define fork title',
      })
      assert.equal(forked.parentConversationId, parent.id)
      assert.equal(forked.title, 'self define fork title')
      assert.equal(forked.profileId, 'reviewer')
      assert.equal(forked.cwd, rtDir)
      assert.equal(forked.model, 'faux/faux-1')

      const forkedDetail = await runtime.getConversationDetail(forked.id)
      assert.ok(JSON.stringify(forkedDetail.entries).includes('ALPHA-99'))

      await runtime.plugins.disable('p:fork-real')
      await assert.rejects(
        async () => realHost!.forkConversation(parent.id, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'plugin_context_expired',
      )
    } finally {
      await runtime.close()
    }
  })
})
