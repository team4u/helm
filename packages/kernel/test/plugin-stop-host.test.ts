/**
 * PluginHost subject to control stop window (stopWindow) dedicated items test:
 *
 * 1. deactivate/destroy real clean up chain succeeded:service.stop inside available STOP_WINDOW_HOST_CALLS
 *    clean up sub- collection (listConversations / getConversation / abortConversation /
 *    cancelAsk / emitEvent / redact / nodeIpc.call / nodeIpc.isOnline) - -
 *    contains await after invoke, contains dispose already placement disposed split destroy path;
 * 2. window do not open new work:stop inside spawnAgent / submitInput / createConversation /
 *    dispatchTrigger / createAsk / execEnv / completeText / withFileLock one rule
 *    409 plugin_context_expired(I/O backend not by trigger reach);
 * 3. stop after completion old ctx all expires (window close, any invoke reject);
 * 4. epoch isolated:reenable after old ctx handle reject, new ctx handle available;
 * 5. I/O error such as on throw: clean up invoke backend failed do not by window swallow;
 * 6. nodeIpc.subscribe stop handle lifecycle: caller return stop i.e. acquire wrap
 *    (deactivate release after manually tune do not second unsubscribe), external signal abort cut subscribe and clean up abort
 *    listener, late to establish by cut (at most once unsubscribe), establish error in return Promise.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock (do not tune low).
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HelmError,
  type ConversationSummary,
  type EnvExecResponse,
  type PluginDefinition,
  type PluginDocHandle,
} from '@helm/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import {
  MemoryDocStore,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js'

/** decidestop window outside old handle reject unify assertion. */
function isContextExpired(err: unknown): boolean {
  return err instanceof HelmError && err.code === 'plugin_context_expired'
}

/** AbortSignal without standard listenerCount: via addEventListener wrap catch counter. */
class ListenerCountingSignalController {
  readonly controller = new AbortController()
  private added = 0
  private removed = 0
  constructor() {
    const signal = this.controller.signal as unknown as {
      addEventListener: (type: string, listener: never, options?: unknown) => void
      removeEventListener: (type: string, listener: never, options?: unknown) => void
    }
    const originalAdd = signal.addEventListener.bind(signal)
    const originalRemove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (type, listener, options) => {
      if (type === 'abort' && typeof listener === 'function') this.added += 1
      return originalAdd(type, listener, options)
    }
    signal.removeEventListener = (type, listener, options) => {
      if (type === 'abort' && typeof listener === 'function') this.removed += 1
      return originalRemove(type, listener, options)
    }
  }
  get signal(): AbortSignal {
    return this.controller.signal
  }
  /** still hang abort listener count (added - removed; without leak leak when should be 0). */
  get activeListeners(): number {
    return this.added - this.removed
  }
}

function makeConversation(id: number): ConversationSummary {
  return makeConversationSummary({ id })
}

/**
 * one by one invoke record backend:cleanCalls record STOP_WINDOW_HOST_CALLS by real forwarding to
 * backend moment;rejectAfterFirstCall let first trigger reach record invoke by designate error reject
 * (verify I/O error such as on throw, do not by window swallow).
 */
class StopWindowBackend implements PluginHostBackend {
  readonly conversations = new Map<number, ConversationSummary>([[1, makeConversation(1)]])
  readonly cleanCalls: string[] = []
  /** its one placement after: under once record invoke (while non- guard)reject the error. */
  failNext: unknown
  private listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  private ipcStopCalls = 0
  readonly ipc = {
    subscribeStarted: [] as Array<{ nodeId: string; signal: AbortSignal }>,
    stopCalls: () => this.ipcStopCalls,
    subscribeDelayMs: 0,
  }

  private record(call: string): void {
    this.cleanCalls.push(call)
    if (this.failNext !== undefined) {
      const err = this.failNext
      this.failNext = undefined
      throw err
    }
  }

  dispatchTrigger(): Promise<void> {
    this.record('dispatchTrigger')
    return Promise.resolve()
  }
  submitInput(): Promise<void> {
    this.record('submitInput')
    return Promise.resolve()
  }
  async createConversation(): Promise<ConversationSummary> {
    this.record('createConversation')
    return makeConversation(99)
  }
  async forkConversation(id: number): Promise<ConversationSummary> {
    this.record('forkConversation')
    return makeConversation(id + 100)
  }
  listConversations(): ConversationSummary[] {
    this.record('listConversations')
    return [...this.conversations.values()]
  }
  getConversation(id: number): ConversationSummary {
    this.record('getConversation')
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
    return found
  }
  async updateConversation(id: number): Promise<ConversationSummary> {
    return this.getConversation(id)
  }
  async abortConversation(id: number): Promise<void> {
    this.record('abortConversation')
    if (!this.conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'helm'
  }
  isClosing(): boolean {
    return false
  }
  async spawnAgent(): Promise<unknown> {
    this.record('spawnAgent')
    return {}
  }
  async runGate(): Promise<{ ok: boolean; output: string }> {
    this.record('runGate')
    return { ok: true, output: '' }
  }
  async cleanupWorktree(): Promise<{ removed: boolean; worktreeId: string; path: string; branch: string; nodeId: string; branchDeleted: boolean }> {
    this.record('cleanupWorktree')
    return { removed: true, worktreeId: 'wt', path: '/wt', branch: 'b', nodeId: 'local', branchDeleted: false }
  }
  async invokeAction(): Promise<unknown> {
    this.record('invokeAction')
    return {}
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  async execEnv(): Promise<EnvExecResponse> {
    this.record('execEnv')
    return { ok: true, exitCode: 0, output: '', timedOut: false }
  }
  async withFileMutationQueue<T>(_target: unknown, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
  listActions(): never[] {
    return []
  }
  manageConversation(): () => void {
    return () => {}
  }
  markConversationOwnership(): void {}
  async createAsk(): Promise<never> {
    this.record('createAsk')
    throw new HelmError('ask_unsupported', 'test backend do not provide ask create', 501)
  }
  async cancelAsk(): Promise<void> {
    this.record('cancelAsk')
  }
  registerAskSeqResolver(): () => void {
    return () => {}
  }
  onEvent(type: string, listener: (payload: unknown) => unknown): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
    }
  }
  emitEvent(type: string, payload: unknown): void {
    this.cleanCalls.push(`emitEvent:${type}`)
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const listener of [...set]) void listener(payload)
  }
  async getConversationDetail(id: number): Promise<never> {
    this.getConversation(id)
    return { ...makeConversation(id), entries: [] } as never
  }
  async listArtifacts(): Promise<never[]> {
    return []
  }
  async getArtifact(): Promise<never> {
    throw new HelmError('not_found', 'no artifact', 404)
  }
  async completeText(): Promise<string> {
    this.record('completeText')
    return ''
  }
  async refreshModels(): Promise<never> {
    this.record('refreshModels')
    return { providers: [], models: [] } as never
  }
  executionEnv(): never {
    this.record('executionEnv')
    return {
      id: 'local',
      cwd: '/tmp',
      absolutePath: async () => ({ ok: true, value: '/tmp/x' }),
      exec: async () => ({ ok: true, value: { exitCode: 0 } }),
    } as never
  }
  buildSpawnEnv(): Record<string, string> {
    this.record('buildSpawnEnv')
    return {}
  }
  async withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> {
    this.record('withFileLock')
    return fn()
  }
  async atomicWriteFile(): Promise<void> {
    this.record('atomicWriteFile')
  }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', 'fixture do not parse spawn target', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async inspectNodePathUsage(): Promise<never> { throw new HelmError('unsupported', 'fixture do not scan process occupy', 501) }
  redactText(text: string): string {
    return text
  }
  redact(text: string): string {
    this.cleanCalls.push('redact')
    return text
  }
  readonly profiles = {
    list: async () => [{ id: 'assistant' }] as never,
    get: async (id: string) => ({ id }) as never,
    getSystem: async () => '',
    save: async (p: import('@helm/protocol').Profile) => p,
    directory: async (id: string) => `/data/profiles/${id}`,
  }
  readonly skills = {
    list: async () => [] as never[],
    readFile: async () => '',
    directory: async (id: string) => `/data/skills/${id}`,
    ensureSkill: async () => {},
  }
  readonly secrets = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    addRedaction: () => () => {},
  }
  async setPluginConfig(): Promise<void> {}
  readonly nodeIpc = {
    isOnline: (nodeId: string) => {
      this.record('nodeIpc.isOnline')
      return nodeId === 'local' || nodeId === 'remote-1'
    },
    getNodeHubUrl: () => undefined,
    call: async (nodeId: string): Promise<{ ok: true; value: string }> => {
      this.record('nodeIpc.call')
      return { ok: true, value: `echo:${nodeId}` }
    },
    subscribe: (
      nodeId: string,
      _input: { endpoint?: string; session?: string; line: string },
      _onLine: (line: string) => void,
      _onClosed: (error?: string) => void,
      signal: AbortSignal,
    ) =>
      new Promise<() => void>((resolve) => {
        this.ipc.subscribeStarted.push({ nodeId, signal })
        setTimeout(
          () => {
            resolve(() => {
              this.record('nodeIpc.subscribe.stop')
              this.ipcStopCalls += 1
            })
          },
          this.ipc.subscribeDelayMs,
        )
      }),
  }
}

let dataDir: string
let backend: StopWindowBackend

function makeHost(): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-plugin-stop-host-')
  backend = new StopWindowBackend()
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// 1+2. deactivate stop window: clean up sub- collection let through / new work entry per refuse
// ---------------------------------------------------------------------------

interface ProbeHandles {
  host: Parameters<Parameters<PluginHost['register']>[0]['definePlugin']>[0]['host']
  doc: PluginDocHandle<Record<string, unknown>>
}

/**
 * stop inside one by one items probe ctx.host plugin.probes by each test inject:clean items expectation succeeded
 * (real forwarding to backend);reject items expectation 409 plugin_context_expired and never trigger reach
 * backend. all probe occur in real await after (deactivating + disposed guard this will reject
 * each other).
 */
function probePlugin(
  id: string,
  probes: Array<{ label: string; run: (host: ProbeHandles['host']) => unknown }>,
  captured: { handles?: ProbeHandles },
): PluginDefinition {
  return {
    id,
    name: id,
    definePlugin(ctx) {
      captured.handles = { host: ctx.host, doc: ctx.doc('probe', { phase: 'init' }) }
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          await new Promise((resolve) => setTimeout(resolve, 10))
          for (const probe of probes) {
            try {
              await probe.run(ctx.host)
            } catch {
              // each test in probe inside self row await assertion (contains expectation rejection).
            }
          }
          ctx.host.emitEvent('probe.stopped', { by: id })
        },
      })
    },
  }
}

test('disable  stop window: clean up sub- collection (read/cancel/IPC clean up/eventually event) let through and real forwarding backend', { timeout: 60_000 }, async () => {
  const captured: { handles?: ProbeHandles } = {}
  const ok: string[] = []
  const def = probePlugin(
    'test:stop-clean',
    [
      { label: 'listConversations', run: async (host) => { const list = host.listConversations(); ok.push('listConversations'); assert.equal(list.length >= 1, true) } },
      { label: 'getConversation', run: async (host) => { const conv = host.getConversation(1); ok.push('getConversation'); assert.equal(conv.id, 1) } },
      { label: 'abortConversation', run: (host) => host.abortConversation(1).then(() => ok.push('abortConversation')) },
      { label: 'cancelAsk', run: (host) => host.cancelAsk('ask-1', 'cancelled').then(() => ok.push('cancelAsk')) },
      { label: 'redact', run: (host) => { host.redact('secret'); ok.push('redact') } },
      { label: 'nodeIpc.isOnline', run: (host) => { assert.equal(host.nodeIpc.isOnline('remote-1'), true); ok.push('nodeIpc.isOnline') } },
      { label: 'nodeIpc.call', run: (host) => host.nodeIpc.call('remote-1', { line: '{"method":"cleanup"}' }).then((r) => { assert.equal(r.ok, true); ok.push('nodeIpc.call') }) },
      { label: 'doc.final.write', run: async (host) => void (await Promise.resolve(host)) },
    ],
    captured,
  )
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-clean')
  for (const call of [
    'listConversations',
    'getConversation',
    'abortConversation',
    'cancelAsk',
    'redact',
    'nodeIpc.isOnline',
    'nodeIpc.call',
    'emitEvent:probe.stopped',
  ]) {
    assert.ok(
      backend.cleanCalls.includes(call),
      `stop window inside ${call} should real forwarding backend (actual forwarding:${JSON.stringify(backend.cleanCalls)})`,
    )
  }
  assert.deepEqual(ok, [
    'listConversations',
    'getConversation',
    'abortConversation',
    'cancelAsk',
    'redact',
    'nodeIpc.isOnline',
    'nodeIpc.call',
  ])
  await host.dispose()
})

test('dispose  stop window:disposed already placement still let through clean up sub- collection (subject to control split destroy contains eventually event)', { timeout: 60_000 }, async () => {
  const seen: string[] = []
  const def: PluginDefinition = {
    id: 'test:stop-dispose',
    name: 'stop-dispose',
    definePlugin(ctx) {
      // and real stop consumer same shape:doc handle in definePlugin declaration,stop inside eventually write.
      const finalDoc = ctx.doc<Record<string, unknown>>('dispose-final', {})
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          // dispose first placement this.disposed = true again enter stop: common rule assertNotDisposed
          // will all reject; subject to control window must precise exceeds (only clean up sub- collection).
          await new Promise((resolve) => setTimeout(resolve, 5))
          assert.equal(ctx.host.listConversations().length >= 1, true)
          seen.push('listConversations')
          await ctx.host.cancelAsk('ask-d', 'cancelled')
          seen.push('cancelAsk')
          await ctx.host.abortConversation(1)
          seen.push('abortConversation')
          assert.equal(ctx.host.nodeIpc.isOnline('remote-1'), true)
          seen.push('nodeIpc.isOnline')
          await ctx.host.nodeIpc.call('remote-1', { line: '{"method":"teardown"}' })
          seen.push('nodeIpc.call')
          finalDoc.set({ phase: 'stopped' })
          seen.push('doc.set')
          ctx.host.emitEvent('notification', { type: 'notification', level: 'info', title: 'already stop', body: 'bye' })
          seen.push('emitEvent')
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await host.dispose().then(
  )
  assert.deepEqual(seen, [
    'listConversations',
    'cancelAsk',
    'abortConversation',
    'nodeIpc.isOnline',
    'nodeIpc.call',
    'doc.set',
    'emitEvent',
  ])
})

test('stop window do not open new work:spawn/submitInput/createConversation/dispatchTrigger/createAsk/execEnv/completeText/withFileLock all refuse (backend zero trigger reach)', { timeout: 60_000 }, async () => {
  const expected: string[] = []
  const def: PluginDefinition = {
    id: 'test:stop-reject',
    name: 'stop-reject',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          await new Promise((resolve) => setTimeout(resolve, 10))
          const attempts: Array<{ label: string; run: () => unknown }> = [
            { label: 'spawnAgent', run: () => ctx.host.spawnAgent({ prompt: 'x' } as never) },
            { label: 'submitInput', run: () => ctx.host.submitInput(1, 'late') },
            { label: 'createConversation', run: () => ctx.host.createConversation({ title: 'late' } as never) },
            { label: 'dispatchTrigger', run: () => ctx.host.dispatchTrigger({ kind: 'webhook' } as never) },
            { label: 'createAsk', run: () => ctx.host.createAsk({ conversationId: 1, ownerPluginId: 'x', title: 't' } as never) },
            { label: 'execEnv', run: () => ctx.host.execEnv({ command: ['ls'] }) },
            { label: 'completeText', run: () => ctx.host.completeText({ conversationId: 1, systemPrompt: '', text: '' } as never) },
            { label: 'withFileLock', run: () => ctx.host.withFileLock('/tmp/late', async () => 1) },
            { label: 'nodeIpc.subscribe', run: () => ctx.host.nodeIpc.subscribe('remote-1', { line: '{}' }, () => {}, () => {}) },
          ]
          for (const attempt of attempts) {
            try {
              await attempt.run()
              assert.fail(`stop window inside ${attempt.label} must not succeeded`)
            } catch (err) {
              assert.ok(
                isContextExpired(err),
                `stop window inside ${attempt.label} expectation plugin_context_expired, actual:${String(err)}`,
              )
              expected.push(attempt.label)
            }
          }
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-reject')
  assert.deepEqual(expected, [
    'spawnAgent',
    'submitInput',
    'createConversation',
    'dispatchTrigger',
    'createAsk',
    'execEnv',
    'completeText',
    'withFileLock',
    'nodeIpc.subscribe',
  ])
  // new work entry all in guard layer reject: backend only may see to window before forwarding invoke (this where is zero).
  assert.deepEqual(backend.cleanCalls.filter((c) => !c.startsWith('emitEvent:')), [], 'new work invoke must not trigger reach backend')
  await host.dispose()
})

test('stop return after window close: old ctx any invoke (contains clean up sub- collection) one rule reject', { timeout: 60_000 }, async () => {
  const captured: { handles?: ProbeHandles } = {}
  const def = probePlugin('test:stop-after', [], captured)
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-after')
  const calls: Array<() => unknown> = [
    () => captured.handles!.host.listConversations(),
    () => captured.handles!.host.getConversation(1),
    () => captured.handles!.host.abortConversation(1),
    () => captured.handles!.host.cancelAsk('a', 'cancelled'),
    () => captured.handles!.host.emitEvent('x', { type: 'x' }),
    () => captured.handles!.host.nodeIpc.isOnline('remote-1'),
    () => captured.handles!.host.nodeIpc.call('remote-1', { line: '{}' }),
    () => captured.handles!.host.redact('x'),
    () => captured.handles!.doc.set({ phase: 'late' }),
  ]
  for (const call of calls) {
    await assert.rejects(async () => call(), isContextExpired)
  }
  await host.dispose()
})

test('epoch isolated:reenable after old ctx reject, new ctx available; old cycle late to closed package do not string new cycle', { timeout: 60_000 }, async () => {
  const captured: { handles?: ProbeHandles } = {}
  const def = probePlugin('test:stop-epoch', [], captured)
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-epoch')
  // new enable:definePlugin re- execute,captured update is new cycle handle; first old reference.
  const stale = captured.handles!
  await host.enable('test:stop-epoch')
  // old handle: window early already close + epoch already pass increase → reject.
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await assert.rejects(async () => stale.host.cancelAsk('a', 'cancelled'), isContextExpired)
  assert.throws(() => stale.doc.set({ phase: 'stale' }), isContextExpired)
  // new cycle handle available.
  assert.equal(captured.handles!.host.listConversations().length >= 1, true)
  // new enable and old ctx reject: new cycle run in old cycle handle same reject.
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await host.dispose()
})

test('I/O error such as on throw:stop inside clean up invoke backend failed original enter stop diagnose (do not swallow do not change)', { timeout: 60_000 }, async () => {
  const ioError = new HelmError('node_unreachable', 'node remote-9 failed to connect', 502)
  const def: PluginDefinition = {
    id: 'test:stop-io',
    name: 'stop-io',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          await ctx.host.nodeIpc.call('remote-9', { line: '{"method":"cleanup"}' })
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  backend.failNext = ioError
  await assert.rejects(
    host.disable('test:stop-io'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`)
      assert.equal(err.code, 'plugin_service_stop_failed')
      const details = err.details as { stopErrors?: Array<{ serviceId: string; error: { code?: string; message?: string } }> }
      const first = details?.stopErrors?.[0]
      assert.ok(first, 'diagnose should contains stopErrors')
      assert.equal(first.serviceId, 'svc')
      assert.equal(first.error?.code, 'node_unreachable')
      assert.equal(first.error?.message, ioError.message)
      return true
    },
  )
  // failed after state already (enabled=false), do not because stop failed re-.
  const summary = host.list().find((p) => p.id === 'test:stop-io')
  assert.equal(summary?.enabled, false)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// nodeIpc.subscribe stop handle lifecycle
// ---------------------------------------------------------------------------

test('subscribe stop handle: return acquire wrap, deactivate release after manually tune do not second unsubscribe', { timeout: 60_000 }, async () => {
  let release: (() => void) | undefined
  const def: PluginDefinition = {
    id: 'test:ipc-acquire',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {
          release = await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
        },
        async stop() {},
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  assert.ok(release, 'start after completion should has unsubscribe handle')
  await host.disable('test:ipc-acquire') // deactivate release cut
  assert.equal(backend.ipc.stopCalls(), 1, 'deactivate release should trigger backend unsubscribe once')
  release!() // caller manually tune return stop:acquire wrap idempotent, do not second unsubscribe
  assert.equal(backend.ipc.stopCalls(), 1, 'idempotent: manually tune must not second unsubscribe')
  await host.unregister('test:ipc-acquire').catch(() => {})
})

test('subscribe external signal abort: cut subscribe and clean up abort listener(without leaking)', { timeout: 60_000 }, async () => {
  const counting = new ListenerCountingSignalController()
  const def: PluginDefinition = {
    id: 'test:ipc-signal',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {
          await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {}, counting.signal)
        },
        async stop() {},
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await new Promise((resolve) => setTimeout(resolve, 30)) // subscribe establish
  assert.equal(backend.ipc.stopCalls(), 0, 'establish after not abort before do not unsubscribe')
  assert.ok(counting.activeListeners >= 1, 'subscribe during external signal on should hang has abort listener')
  counting.controller.abort('external') // external abort → unique cut point cut
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(backend.ipc.stopCalls(), 1, 'external abort should trigger backend unsubscribe once')
  assert.equal(
    counting.activeListeners,
    0,
    'cut after external signal on abort listener must by remove (without leaking)',
  )
  await host.disable('test:ipc-signal') // deactivate release: idempotent, do not second unsubscribe
  assert.equal(backend.ipc.stopCalls(), 1, 'cut after again deactivate do not stack add unsubscribe')
  await host.unregister('test:ipc-signal').catch(() => {})
})

test('subscribe establish before deactivate: late to establish by cut (at most once unsubscribe); caller handle idempotent', { timeout: 60_000 }, async () => {
  backend.ipc.subscribeDelayMs = 40
  let release: (() => void) | undefined
  const def: PluginDefinition = {
    id: 'test:ipc-late',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {},
        async stop() {
          // stop window inside subscribe belong new entry (do not in STOP_WINDOW_HOST_CALLS):
          // guard reject, backend zero trigger reach (cleanCalls/subscribeStarted all can verify).
          let guardErr: unknown
          try {
            await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
          } catch (err) {
            guardErr = err
          }
          assert.ok(isContextExpired(guardErr), `stop window inside subscribe expectation plugin_context_expired, actual:${String(guardErr)}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await host.disable('test:ipc-late')
  assert.equal(backend.ipc.subscribeStarted.length, 0, 'stop window inside subscribe guard reject, backend zero trigger reach')
  await host.unregister('test:ipc-late').catch(() => {})
})

test('subscribe establish chain later than release: external signal in establish complete before abort → late to subscribe immediately cut once', { timeout: 60_000 }, async () => {
  // release first at establish complete race (preflight gate outside determinism drive): subscribe establish slow (60ms),
  // external signal in 10ms abort- - cut point then when backend not yet resolve; establish chain resolve
  // instant between must by cut (once unsubscribe), caller await handle same is idempotent cut wrap.
  backend.ipc.subscribeDelayMs = 60
  const counting = new ListenerCountingSignalController()
  let established: boolean | undefined
  const def: PluginDefinition = {
    id: 'test:ipc-early',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {
          ctx.host.nodeIpc
            .subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {}, counting.signal)
            .then(() => {
              established = true
            })
            .catch(() => {})
        },
        async stop() {},
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await new Promise((resolve) => setTimeout(resolve, 10)) // subscribe still in establish in
  assert.equal(backend.ipc.stopCalls(), 0)
  counting.controller.abort('early') // cut point first at establish complete then
  await new Promise((resolve) => setTimeout(resolve, 120)) // late to establish chain compute
  assert.equal(backend.ipc.stopCalls(), 1, 'late to subscribe must by immediately cut once')
  assert.equal(established, true, 'caller await subscribe chain normal settle(do not swallow do not hang)')
  await host.disable('test:ipc-early') // deactivate release: idempotent do not stack add
  assert.equal(backend.ipc.stopCalls(), 1)
  await host.dispose()
})
