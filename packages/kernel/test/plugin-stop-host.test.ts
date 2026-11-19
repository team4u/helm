/**
 * Dedicated tests for PluginHost's controlled stop window (`stopWindow`):
 *
 * 1. Cleanup calls succeed during disable/dispose: within `service.stop`, the `STOP_WINDOW_HOST_CALLS`
 *    cleanup subset (`listConversations` / `getConversation` / `abortConversation` /
 *    `cancelAsk` / `emitEvent` / `redact` / `nodeIpc.call` / `nodeIpc.isOnline`) passes through,
 *    including calls after `await` and during `dispose()` after `disposed` is already flagged;
 * 2. New work is blocked inside the window: `spawnAgent` / `submitInput` / `createConversation` /
 *    `dispatchTrigger` / `createAsk` / `execEnv` / `completeText` / `withFileLock` all reject with
 *    `409 plugin_context_expired` (never reaching the I/O backend);
 * 3. After `stop()` returns, the window closes and all calls on the old `ctx` reject;
 * 4. Epoch isolation: after re-enabling, old `ctx` handles reject while new `ctx` handles work;
 * 5. Backend I/O errors thrown during cleanup propagate directly without being swallowed by the window;
 * 6. `nodeIpc.subscribe` stop-handle lifecycle: stop wrapper returned to caller is idempotent
 *    after deactivation, external `AbortSignal` unsubscribes and removes the abort listener,
 *    late-established subscriptions abort at most once, and establish errors settle on the Promise.
 *
 * runner: tsx --test; every test requires explicit timeout: 60_000 to guard against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HelmxError,
  type ConversationSummary,
  type EnvExecResponse,
  type PluginDefinition,
  type PluginDocHandle,
} from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  MemoryDocStore,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js'

/** Shared assertion predicate for expired/outside-window plugin handle rejections. */
function isContextExpired(err: unknown): boolean {
  return err instanceof HelmxError && err.code === 'plugin_context_expired'
}

/** Captures abort listener counts via `addEventListener` / `removeEventListener` wrappers. */
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
  /** Number of dangling abort listeners (`added - removed`; should be `0` when leak-free). */
  get activeListeners(): number {
    return this.added - this.removed
  }
}

function makeConversation(id: number): ConversationSummary {
  return makeConversationSummary({ id })
}

/**
 * Call-recording backend: logs calls reaching the real backend (`cleanCalls`) when forwarded
 * during `STOP_WINDOW_HOST_CALLS`; `failNext` forces the next recorded call to throw the given
 * error (verifying cleanup I/O errors are not swallowed by the stop window).
 */
class StopWindowBackend implements PluginHostBackend {
  readonly conversations = new Map<number, ConversationSummary>([[1, makeConversation(1)]])
  readonly cleanCalls: string[] = []
  /** When set, the next recorded backend call (after the guard passes) throws this error. */
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
    if (found === undefined) throw new HelmxError('not_found', `conversation missing: ${id}`, 404)
    return found
  }
  async updateConversation(id: number): Promise<ConversationSummary> {
    return this.getConversation(id)
  }
  async abortConversation(id: number): Promise<void> {
    this.record('abortConversation')
    if (!this.conversations.has(id)) throw new HelmxError('not_found', `conversation missing: ${id}`, 404)
  }
  getConversationOwnership(): 'helmx' | 'bot' | 'human' {
    return 'helmx'
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
    throw new HelmxError('ask_unsupported', 'test backend does not provide ask creation', 501)
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
  async createArtifact(): Promise<never> {
    throw new HelmxError('unsupported', 'fixture does not create artifacts', 501)
  }
  async getArtifact(): Promise<never> {
    throw new HelmxError('not_found', 'no artifact', 404)
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
  async resolveSpawnTarget(): Promise<never> { throw new HelmxError('unsupported', 'fixture does not resolve spawn targets', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async inspectNodePathUsage(): Promise<never> { throw new HelmxError('unsupported', 'fixture does not inspect process occupancy', 501) }
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
    save: async (p: import('@helmx/protocol').Profile) => p,
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
  dataDir = await makeTempDir('helmx-plugin-stop-host-')
  backend = new StopWindowBackend()
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// 1+2. Disable stop window: cleanup subset passes through / new work rejected
// ---------------------------------------------------------------------------

interface ProbeHandles {
  host: Parameters<Parameters<PluginHost['register']>[0]['definePlugin']>[0]['host']
  doc: PluginDocHandle<Record<string, unknown>>
}

/**
 * Runs test-injected `ctx.host` probes inside `service.stop`: allowed cleanup calls should
 * reach the backend, while disallowed calls should reject with `409 plugin_context_expired`
 * without reaching the backend. All probes run after a real `await` so `deactivating`/`disposed`
 * guards would reject otherwise.
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
              // Each test asserts inside its own probe (including expected rejections).
            }
          }
          ctx.host.emitEvent('probe.stopped', { by: id })
        },
      })
    },
  }
}

test('disable stop window allows cleanup subset (reads / cancels / IPC cleanup / final events) to forward to backend', { timeout: 60_000 }, async () => {
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
      `${call} inside stop window must forward to backend (actual: ${JSON.stringify(backend.cleanCalls)})`,
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

test('dispose stop window permits cleanup subset (including final doc writes and events) even after disposed is set', { timeout: 60_000 }, async () => {
  const seen: string[] = []
  const def: PluginDefinition = {
    id: 'test:stop-dispose',
    name: 'stop-dispose',
    definePlugin(ctx) {
      // Matches real stop usage: doc handle created in definePlugin, written at the end of stop.
      const finalDoc = ctx.doc<Record<string, unknown>>('dispose-final', {})
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          // dispose() sets this.disposed = true before calling stop: ordinary assertNotDisposed
          // guards would reject, so the controlled stop window selectively opens for the cleanup subset.
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
          ctx.host.emitEvent('notification', { type: 'notification', level: 'info', title: 'stopped', body: 'bye' })
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

test('stop window blocks new work (spawn/submitInput/createConversation/dispatchTrigger/createAsk/execEnv/completeText/withFileLock/reset+compact guarded) with zero backend calls', { timeout: 60_000 }, async () => {
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
            { label: 'resetConversationGuarded', run: () => ctx.host.resetConversationGuarded(1) },
            { label: 'compactConversationGuarded', run: () => ctx.host.compactConversationGuarded(1) },
            { label: 'completeText', run: () => ctx.host.completeText({ conversationId: 1, systemPrompt: '', text: '' } as never) },
            { label: 'withFileLock', run: () => ctx.host.withFileLock('/tmp/late', async () => 1) },
            { label: 'nodeIpc.subscribe', run: () => ctx.host.nodeIpc.subscribe('remote-1', { line: '{}' }, () => {}, () => {}) },
          ]
          for (const attempt of attempts) {
            try {
              await attempt.run()
              assert.fail(`${attempt.label} inside stop window must not succeed`)
            } catch (err) {
              assert.ok(
                isContextExpired(err),
                `${attempt.label} inside stop window expected plugin_context_expired, got: ${String(err)}`,
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
    'resetConversationGuarded',
    'compactConversationGuarded',
    'completeText',
    'withFileLock',
    'nodeIpc.subscribe',
  ])
  // New work entries all reject at the guard layer: backend sees zero calls here.
  assert.deepEqual(backend.cleanCalls.filter((c) => !c.startsWith('emitEvent:')), [], 'new work calls must never reach backend')
  await host.dispose()
})

test('stop window closes after stop returns: any old ctx call (including cleanup subset) rejects uniformly', { timeout: 60_000 }, async () => {
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

test('epoch isolation: after re-enable old ctx rejects, new ctx works, and old close never interferes with new cycle', { timeout: 60_000 }, async () => {
  const captured: { handles?: ProbeHandles } = {}
  const def = probePlugin('test:stop-epoch', [], captured)
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-epoch')
  // Re-enable re-runs definePlugin and updates captured.handles; keep a reference to the old handle first.
  const stale = captured.handles!
  await host.enable('test:stop-epoch')
  // Old handle: stop window closed and epoch bumped -> rejects.
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await assert.rejects(async () => stale.host.cancelAsk('a', 'cancelled'), isContextExpired)
  assert.throws(() => stale.doc.set({ phase: 'stale' }), isContextExpired)
  // New cycle handle succeeds.
  assert.equal(captured.handles!.host.listConversations().length >= 1, true)
  // Old handle continues rejecting even while new cycle runs.
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await host.dispose()
})

test('cleanup I/O failures thrown inside stop preserve original error in stop diagnostics without swallowing', { timeout: 60_000 }, async () => {
  const ioError = new HelmxError('node_unreachable', 'node remote-9 failed to connect', 502)
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
      assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`)
      assert.equal(err.code, 'plugin_service_stop_failed')
      const details = err.details as { stopErrors?: Array<{ serviceId: string; error: { code?: string; message?: string } }> }
      const first = details?.stopErrors?.[0]
      assert.ok(first, 'diagnostics must include stopErrors')
      assert.equal(first.serviceId, 'svc')
      assert.equal(first.error?.code, 'node_unreachable')
      assert.equal(first.error?.message, ioError.message)
      return true
    },
  )
  // State is disabled even after stop failure (does not stay enabled because stop threw).
  const summary = host.list().find((p) => p.id === 'test:stop-io')
  assert.equal(summary?.enabled, false)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// nodeIpc.subscribe stop-handle lifecycle
// ---------------------------------------------------------------------------

test('subscribe stop handle is tracked and idempotent when manually called after disable', { timeout: 60_000 }, async () => {
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
  assert.ok(release, 'unsubscribe handle must be present after start')
  await host.disable('test:ipc-acquire') // disable triggers abort
  assert.equal(backend.ipc.stopCalls(), 1, 'disable must trigger backend unsubscribe once')
  release!() // caller manually calls returned stop: wrapper must be idempotent without double-unsubscribing
  assert.equal(backend.ipc.stopCalls(), 1, 'idempotent: manual call must not double-unsubscribe')
  await host.unregister('test:ipc-acquire').catch(() => {})
})

test('subscribe external signal abort unsubscribes once and removes abort listener without leaking', { timeout: 60_000 }, async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 30)) // allow subscribe to establish
  assert.equal(backend.ipc.stopCalls(), 0, 'must not unsubscribe after establish before abort')
  assert.ok(counting.activeListeners >= 1, 'abort listener must remain attached on external signal while subscribed')
  counting.controller.abort('external') // external abort -> single abort point cancels
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(backend.ipc.stopCalls(), 1, 'external abort must trigger backend unsubscribe once')
  assert.equal(
    counting.activeListeners,
    0,
    'abort listener on external signal must be removed after cancel (no leaks)',
  )
  await host.disable('test:ipc-signal') // disable cleanup is idempotent without double-unsubscribing
  assert.equal(backend.ipc.stopCalls(), 1, 'subsequent disable after cancel must not unsubscribe again')
  await host.unregister('test:ipc-signal').catch(() => {})
})

test('subscribe during stop window is rejected by guard and never reaches backend', { timeout: 60_000 }, async () => {
  backend.ipc.subscribeDelayMs = 40
  let release: (() => void) | undefined
  const def: PluginDefinition = {
    id: 'test:ipc-late',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {},
        async stop() {
          // subscribe inside stop window counts as new work (not in STOP_WINDOW_HOST_CALLS):
          // guard rejects it and backend never sees it (verified via subscribeStarted).
          let guardErr: unknown
          try {
            await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
          } catch (err) {
            guardErr = err
          }
          assert.ok(isContextExpired(guardErr), `subscribe inside stop window expected plugin_context_expired, got: ${String(guardErr)}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await host.disable('test:ipc-late')
  assert.equal(backend.ipc.subscribeStarted.length, 0, 'subscribe inside stop window must be rejected before reaching backend')
  await host.unregister('test:ipc-late').catch(() => {})
})

test('late subscribe establishment after external signal aborts immediately cuts once and resolves caller', { timeout: 60_000 }, async () => {
  // Release before establishment race (driven deterministically without preflight gate): subscribe establish is slow (60ms),
  // external signal aborts at 10ms before backend resolves; the instant establish resolves it must be cut once,
  // and the caller Promise receives an idempotent no-op stop wrapper.
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
  await new Promise((resolve) => setTimeout(resolve, 10)) // subscribe is still establishing
  assert.equal(backend.ipc.stopCalls(), 0)
  counting.controller.abort('early') // aborted before establishment finishes
  await new Promise((resolve) => setTimeout(resolve, 120)) // late establishment settles
  assert.equal(backend.ipc.stopCalls(), 1, 'late-established subscription must be cut once immediately')
  assert.equal(established, true, 'caller await on subscribe must still settle normally (never swallowed or hung)')
  await host.disable('test:ipc-early') // disable cleanup stays idempotent
  assert.equal(backend.ipc.stopCalls(), 1)
  await host.dispose()
})
