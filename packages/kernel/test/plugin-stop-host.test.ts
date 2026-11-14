/**
 * PluginHost 受控停止窗口（stopWindow）专项测试：
 *
 * 1. 停用/销毁的真实清理链成功：service.stop 内可用 STOP_WINDOW_HOST_CALLS
 *    清理子集（listConversations / getConversation / abortConversation /
 *    cancelAsk / emitEvent / redact / nodeIpc.call / nodeIpc.isOnline）——
 *    含 await 之后调用、含 dispose 已置 disposed 的拆毁路径；
 * 2. 窗口不开新工作：stop 内 spawnAgent / submitInput / createConversation /
 *    dispatchTrigger / createAsk / execEnv / completeText / withFileLock 一律
 *    409 plugin_context_expired（I/O 后端未被触达）；
 * 3. stop 完成后旧 ctx 全部失效（窗口关闭，任何调用拒绝）；
 * 4. epoch 隔离：reenable 后旧 ctx 句柄拒绝、新 ctx 句柄可用；
 * 5. I/O 错误如实上抛：清理调用的后端失败不被窗口吞掉；
 * 6. nodeIpc.subscribe stop 句柄生命周期：调用方返回的 stop 即 acquire 封装
 *    （停用释放后手调不二次退订）、外部 signal abort 收割订阅且清理 abort
 *    listener、晚到建立被收割（至多一次退订）、建立错误留在返回 Promise。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁（勿调低）。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type EnvExecResponse,
  type PluginDefinition,
  type PluginDocHandle,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'

/** 判定「stop 窗口外旧句柄拒绝」的统一断言。 */
function isContextExpired(err: unknown): boolean {
  return err instanceof HelmError && err.code === 'plugin_context_expired'
}

/** AbortSignal 无标准 listenerCount：经 addEventListener 包装捕获计数。 */
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
  /** 仍挂着的 abort listener 数（added - removed；无泄漏时应为 0）。 */
  get activeListeners(): number {
    return this.added - this.removed
  }
}

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * 逐调用记录的后端：cleanCalls 记录 STOP_WINDOW_HOST_CALLS 被真实转发到
 * 后端的时刻；rejectAfterFirstCall 让首个触达的记录调用按指定错误 reject
 * （验证 I/O 错误如实上抛，不被窗口吞）。
 */
class StopWindowBackend implements PluginHostBackend {
  readonly conversations = new Map<number, ConversationSummary>([[1, makeConversation(1)]])
  readonly cleanCalls: string[] = []
  /** 其一置位后：下一次记录调用（而非守卫）reject 该错误。 */
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
  listConversations(): ConversationSummary[] {
    this.record('listConversations')
    return [...this.conversations.values()]
  }
  getConversation(id: number): ConversationSummary {
    this.record('getConversation')
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  async updateConversation(id: number): Promise<ConversationSummary> {
    return this.getConversation(id)
  }
  async abortConversation(id: number): Promise<void> {
    this.record('abortConversation')
    if (!this.conversations.has(id)) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
  }
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
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
  async prepareInterruptedConversations(): Promise<void> {}
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
    throw new HelmError('ask_unsupported', '测试后端不提供 ask 创建', 501)
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
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', 'fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async probeNodeFs(): Promise<never> { throw new HelmError('unsupported', 'fixture 不探测节点 fs', 501) }
  async inspectNodePathUsage(): Promise<never> { throw new HelmError('unsupported', 'fixture 不扫描进程占用', 501) }
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

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (structuredClone(this.store.get(key)) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let backend: StopWindowBackend

function makeHost(): PluginHost {
  return new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugin-stop-host-'))
  backend = new StopWindowBackend()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1+2. 停用 stop 窗口：清理子集放行 / 新工作入口照拒
// ---------------------------------------------------------------------------

interface ProbeHandles {
  host: Parameters<Parameters<PluginHost['register']>[0]['definePlugin']>[0]['host']
  doc: PluginDocHandle<Record<string, unknown>>
}

/**
 * stop 内逐项探测 ctx.host 的插件。probes 由各测试注入：clean 项期望成功
 * （真实转发到后端）；reject 项期望 409 plugin_context_expired 且绝不触达
 * 后端。全部探测发生在真实 await 之后（deactivating + disposed 守卫本会拒绝
 * 的相位）。
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
              // 各测试在 probe 内自行 await 断言（含期望的 rejection）。
            }
          }
          ctx.host.emitEvent('probe.stopped', { by: id })
        },
      })
    },
  }
}

test('disable 的 stop 窗口：清理子集（读/取消/IPC 清理/最终事件）放行并真实转发后端', { timeout: 60_000 }, async () => {
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
      `stop 窗口内 ${call} 应真实转发后端（实际转发：${JSON.stringify(backend.cleanCalls)}）`,
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

test('dispose 的 stop 窗口：disposed 已置位仍放行清理子集（受控拆毁含最终事件）', { timeout: 60_000 }, async () => {
  const seen: string[] = []
  const def: PluginDefinition = {
    id: 'test:stop-dispose',
    name: 'stop-dispose',
    definePlugin(ctx) {
      // 与真实 stop 消费者同形：doc 句柄在 definePlugin 声明，stop 内最终写入。
      const finalDoc = ctx.doc<Record<string, unknown>>('dispose-final', {})
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          // dispose 先置 this.disposed = true 再进 stop：常规 assertNotDisposed
          // 会全部拒绝；受控窗口必须精确越过（仅清理子集）。
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
          ctx.host.emitEvent('notification', { type: 'notification', level: 'info', title: '已停止', body: 'bye' })
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

test('stop 窗口不开新工作：spawn/submitInput/createConversation/dispatchTrigger/createAsk/execEnv/completeText/withFileLock 全拒（后端零触达）', { timeout: 60_000 }, async () => {
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
              assert.fail(`stop 窗口内 ${attempt.label} 不应成功`)
            } catch (err) {
              assert.ok(
                isContextExpired(err),
                `stop 窗口内 ${attempt.label} 期望 plugin_context_expired，实际：${String(err)}`,
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
  // 新工作入口全在守卫层拒绝：后端只可能见到窗口前转发的调用（此处为零）。
  assert.deepEqual(backend.cleanCalls.filter((c) => !c.startsWith('emitEvent:')), [], '新工作调用不得触达后端')
  await host.dispose()
})

test('stop 返回后窗口关闭：旧 ctx 任何调用（含清理子集）一律拒绝', { timeout: 60_000 }, async () => {
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

test('epoch 隔离：reenable 后旧 ctx 拒绝、新 ctx 可用；旧周期晚到闭包不串新周期', { timeout: 60_000 }, async () => {
  const captured: { handles?: ProbeHandles } = {}
  const def = probePlugin('test:stop-epoch', [], captured)
  const host = makeHost()
  await host.register(def)
  await host.disable('test:stop-epoch')
  // 新 enable：definePlugin 重新执行，captured 更新为新周期句柄；先留旧引用。
  const stale = captured.handles!
  await host.enable('test:stop-epoch')
  // 旧句柄：窗口早已关闭 + epoch 已递增 → 拒绝。
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await assert.rejects(async () => stale.host.cancelAsk('a', 'cancelled'), isContextExpired)
  assert.throws(() => stale.doc.set({ phase: 'stale' }), isContextExpired)
  // 新周期句柄可用。
  assert.equal(captured.handles!.host.listConversations().length >= 1, true)
  // 「新 enable 与旧 ctx 拒绝」：新周期运行中旧周期句柄同样拒绝。
  await assert.rejects(async () => stale.host.listConversations(), isContextExpired)
  await host.dispose()
})

test('I/O 错误如实上抛：stop 内清理调用的后端失败原样进 stop 诊断（不吞不改）', { timeout: 60_000 }, async () => {
  const ioError = new HelmError('node_unreachable', '节点 remote-9 连接失败', 502)
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
      assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`)
      assert.equal(err.code, 'plugin_service_stop_failed')
      const details = err.details as { stopErrors?: Array<{ serviceId: string; error: { code?: string; message?: string } }> }
      const first = details?.stopErrors?.[0]
      assert.ok(first, '诊断应含 stopErrors')
      assert.equal(first.serviceId, 'svc')
      assert.equal(first.error?.code, 'node_unreachable')
      assert.equal(first.error?.message, ioError.message)
      return true
    },
  )
  // 失败后状态已落位（enabled=false），不因 stop 失败复活。
  const summary = host.list().find((p) => p.id === 'test:stop-io')
  assert.equal(summary?.enabled, false)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// nodeIpc.subscribe stop 句柄生命周期
// ---------------------------------------------------------------------------

test('subscribe stop 句柄：返回 acquire 封装，停用释放后手调不二次退订', { timeout: 60_000 }, async () => {
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
  assert.ok(release, 'start 完成后应有退订句柄')
  await host.disable('test:ipc-acquire') // 停用释放收割
  assert.equal(backend.ipc.stopCalls(), 1, '停用释放应触发后端退订一次')
  release!() // 调用方手调返回的 stop：acquire 封装幂等，不二次退订
  assert.equal(backend.ipc.stopCalls(), 1, '幂等：手调不得二次退订')
  await host.unregister('test:ipc-acquire').catch(() => {})
})

test('subscribe 外部 signal abort：收割订阅且清理 abort listener（不泄漏）', { timeout: 60_000 }, async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 30)) // 订阅建立
  assert.equal(backend.ipc.stopCalls(), 0, '建立后未 abort 前不退订')
  assert.ok(counting.activeListeners >= 1, '订阅期间外部 signal 上应挂有 abort listener')
  counting.controller.abort('external') // 外部 abort → 唯一收割点收割
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(backend.ipc.stopCalls(), 1, '外部 abort 应触发后端退订一次')
  assert.equal(
    counting.activeListeners,
    0,
    '收割后外部 signal 上的 abort listener 必须被移除（不泄漏）',
  )
  await host.disable('test:ipc-signal') // 停用释放：幂等，不二次退订
  assert.equal(backend.ipc.stopCalls(), 1, '收割后再停用不叠加退订')
  await host.unregister('test:ipc-signal').catch(() => {})
})

test('subscribe 建立前停用：晚到建立被收割（至多一次退订）；调用方句柄幂等', { timeout: 60_000 }, async () => {
  backend.ipc.subscribeDelayMs = 40
  let release: (() => void) | undefined
  const def: PluginDefinition = {
    id: 'test:ipc-late',
    definePlugin(ctx) {
      ctx.service({
        id: 's',
        async start() {},
        async stop() {
          // stop 窗口内 subscribe 属新入口（不在 STOP_WINDOW_HOST_CALLS）：
          // 守卫拒绝、后端零触达（cleanCalls/subscribeStarted 均可证）。
          let guardErr: unknown
          try {
            await ctx.host.nodeIpc.subscribe('remote-1', { line: '{"m":1}' }, () => {}, () => {})
          } catch (err) {
            guardErr = err
          }
          assert.ok(isContextExpired(guardErr), `stop 窗口内 subscribe 期望 plugin_context_expired，实际：${String(guardErr)}`)
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
      })
    },
  }
  const host = makeHost()
  await host.register(def)
  await host.disable('test:ipc-late')
  assert.equal(backend.ipc.subscribeStarted.length, 0, 'stop 窗口内 subscribe 守卫拒绝，后端零触达')
  await host.unregister('test:ipc-late').catch(() => {})
})

test('subscribe 建立链晚于释放：外部 signal 在建立完成前 abort → 晚到订阅立即收割一次', { timeout: 60_000 }, async () => {
  // 释放先于建立完成的竞态（预检闸门外的确定性驱动）：订阅建立慢（60ms），
  // 外部 signal 在 10ms abort——收割点就位时后端尚未 resolve；建立链 resolve
  // 瞬间必须被收割（一次退订），调用方 await 的句柄同样是幂等收割封装。
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
  await new Promise((resolve) => setTimeout(resolve, 10)) // 订阅仍在建立中
  assert.equal(backend.ipc.stopCalls(), 0)
  counting.controller.abort('early') // 收割点先于建立完成就位
  await new Promise((resolve) => setTimeout(resolve, 120)) // 晚到建立链结算
  assert.equal(backend.ipc.stopCalls(), 1, '晚到订阅必须被立即收割一次')
  assert.equal(established, true, '调用方 await 的订阅链正常 settle（不吞不挂）')
  await host.disable('test:ipc-early') // 停用释放：幂等不叠加
  assert.equal(backend.ipc.stopCalls(), 1)
  await host.dispose()
})
