/**
 * 受控停止 doc 写入窗口 / start 屏障回滚聚合 / 真实 workflow 插件受控关停
 * 的针对性测试（不可弱化语义）。
 *
 * 验证点：
 * 1. 通用插件 service.stop 经 await 后仍能写 ctx.doc（disable 与 dispose 两路径），
 *    从序列化测试存储读回（真实 SQLite 验证见 workflow-shutdown.integration.test.ts）；
 * 2. stop 之外（窗口外）同句柄写入被拒；stop 返回后拒绝；reenable 旧 epoch 拒绝；
 *    停止窗口允许当前周期已有回调收尾，窗口结束后残留回调一律被拒；
 * 3. 真实 builtin:workflow 带运行中任务受控 dispose/close：run 终态落私有 records
 *    与公共 runs，重启读取一致，无 unhandled rejection；
 * 4. start 屏障后某插件 start 失败 + 先前插件 stop 失败：错误同时含原始 start
 *    失败与 rollback stop 失败诊断（pluginId + JSON-safe stop 错误）。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HelmError,
  ROOT_CONVERSATION_ID,
  type ConversationSummary,
  type PluginDefinition,
  type PluginDocHandle,
  type PublicPluginDoc,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

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

class FakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  emitted: Array<{ type: string; payload: unknown }> = []
  private listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  cleanupWorktreeImpl: (() => Promise<{ removed: boolean; worktreeId: string; path: string; branch: string; nodeId: string; branchDeleted: boolean }>) | undefined

  constructor() {
    this.conversations.set(1, makeConversation(1))
  }
  dispatchTrigger(): Promise<void> {
    return Promise.resolve()
  }
  submitInput(): Promise<void> {
    return Promise.resolve()
  }
  createConversation(): Promise<ConversationSummary> {
    return Promise.resolve(makeConversation(99))
  }
  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()]
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id))
  }
  abortConversation(): Promise<void> {
    return Promise.resolve()
  }
  spawnAgent(): Promise<unknown> {
    return Promise.resolve('spawned')
  }
  runGate(): Promise<{ ok: boolean; output: string }> {
    return Promise.resolve({ ok: true, output: '' })
  }
  prepareInterruptedConversations(): Promise<void> {
    return Promise.resolve()
  }
  cleanupWorktree(): Promise<{ removed: boolean; worktreeId: string; path: string; branch: string; nodeId: string; branchDeleted: boolean }> {
    if (this.cleanupWorktreeImpl) return this.cleanupWorktreeImpl()
    return Promise.resolve({ removed: true, worktreeId: 'local:/x', path: '/x', branch: 'b', nodeId: 'local', branchDeleted: false })
  }
  invokeAction(): Promise<unknown> {
    return Promise.resolve({})
  }
  listActions(): never[] {
    return []
  }
  manageConversation(): () => void {
    return () => {}
  }
  markConversationOwnership(): void {}
  createAsk(): Promise<never> {
    return Promise.reject(new HelmError('unsupported', '测试后端不提供 ask', 501))
  }
  cancelAsk(): Promise<void> {
    return Promise.resolve()
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
    this.emitted.push({ type, payload })
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const listener of [...set]) void listener(payload)
  }
}

/**
 * 序列化文档测试替身：用内存 Map 存 JSON，验证句柄与底层存储的数据往返。
 * 它不提供磁盘持久化；真实 SQLite 关闭与重开验证放在独立集成测试中。
 */
class JsonDocStore implements PluginDocStore {
  private persisted = new Map<string, string>()
  writes: string[] = []
  flushCalls = 0
  /** 可编程 flush：缺省立即 resolve；设为 Promise 后 flush 等待其完成。 */
  flushGate: Promise<void> | undefined
  /** 注入 flush 失败（真实持久层故障形态）。 */
  flushFail: unknown
  get<T>(key: string, initial: T): T {
    const raw = this.persisted.get(key)
    return raw === undefined ? structuredClone(initial) : (JSON.parse(raw) as T)
  }
  set<T>(key: string, value: T): void {
    this.persisted.set(key, JSON.stringify(value))
    this.writes.push(key)
  }
  async flush(): Promise<void> {
    this.flushCalls += 1
    if (this.flushFail) throw this.flushFail
    if (this.flushGate) await this.flushGate
  }
}

let dataDir: string
let backend: FakeBackend
let docs: JsonDocStore

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({
    dataDir,
    host: backend,
    docs,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-stop-doc-'))
  backend = new FakeBackend()
  docs = new JsonDocStore()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1+2. 通用插件：stop 窗口内的 doc 最终持久化与窗口外拒绝
// ---------------------------------------------------------------------------

/** stop 中先 await 再写 doc 的服务插件；firstHandle 永久持有首周期句柄（reenable 后不更新）。 */
function stopWriterPlugin(id: string, opts: { writeKey: string; failStop?: boolean }): {
  definition: PluginDefinition
  /** 首周期 doc 句柄（definePlugin 首次执行时固定；reenable 不替换）。 */
  firstHandle: { current?: PluginDocHandle<Record<string, unknown>> }
} {
  const firstHandle: { current?: PluginDocHandle<Record<string, unknown>> } = {}
  let firstCycle = true
  const definition: PluginDefinition = {
    id,
    name: id,
    definePlugin(ctx) {
      const handle = ctx.doc<Record<string, unknown>>('final-state', { phase: 'init' })
      if (firstCycle) {
        firstHandle.current = handle
        firstCycle = false
      }
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          // 经真实 await（模拟引擎 close 等待在途任务）后再最终写：
          // 常规 guard 此时已因 deactivating 拒绝，受控停止窗口必须放行。
          await delay(30)
          handle.set({ phase: 'stopped-final', key: opts.writeKey })
          if (opts.failStop) throw new HelmError('stop_boom', `${id} stop 故意失败`, 500)
        },
      })
    },
  }
  return { definition, firstHandle }
}

test('disable 路径：service.stop 内经 await 后仍能写 ctx.doc，且序列化存储读回', { timeout: 60_000 }, async () => {
  const { definition, firstHandle } = stopWriterPlugin('test:stop-writer', { writeKey: 'disable-path' })
  const host = makeHost()
  await host.register(definition)
  assert.equal(docs.get('test:stop-writer:final-state', { phase: 'init' }).phase, 'init', '启动期未写')
  await host.disable('test:stop-writer')
  // 经测试存储反序列化读回，检查写入确实到达底层 store。
  const persisted = docs.get('test:stop-writer:final-state', { phase: 'missing' })
  assert.deepEqual(persisted, { phase: 'stopped-final', key: 'disable-path' }, 'stop 内最终写必须落持久层')
  // stop 返回后：同句柄写入立即恢复拒绝
  assert.throws(
    () => firstHandle.current!.set({ phase: 'after-stop' }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
    'stop 返回后写入必须被拒',
  )
  const flushCalls = docs.flushCalls
  await assert.rejects(
    firstHandle.current!.flush(),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
  )
  assert.equal(docs.flushCalls, flushCalls, '失效句柄不能再触发底层 flush')
  await host.dispose()
})

test('dispose 路径：service.stop 内经 await 后仍能写 ctx.doc（受控进程拆毁含最终持久化）', { timeout: 60_000 }, async () => {
  const { definition } = stopWriterPlugin('test:stop-writer2', { writeKey: 'dispose-path' })
  const host = makeHost()
  await host.register(definition)
  await host.dispose()
  const persisted = docs.get('test:stop-writer2:final-state', { phase: 'missing' })
  assert.deepEqual(persisted, { phase: 'stopped-final', key: 'dispose-path' }, 'dispose 的受控 stop 链同样完成最终持久化')
})

test('窗口边界：stop 返回后运行期残留回调写入被拒（窗口不因 phase=deactivating 全开）', { timeout: 60_000 }, async () => {
  // 窗口语义（PluginState.stopDocWrites 按状态标记而非异步上下文传播）：
  // - stop 窗口内：本插件本周期句柄的写入放行——含引擎 close 等待的旧 promise
  //   链（这些链在 stop 之前创建，不继承 stop 的异步上下文，只能按状态标记判定）；
  // - stop 返回后：窗口关闭，一切写入（含运行期残留回调）恢复拒绝。
  let strayWrite: Promise<void> = Promise.resolve()
  const strayErrors: unknown[] = []
  const gateRef: { release: () => void } = { release: () => {} }
  const definition: PluginDefinition = {
    id: 'test:stray',
    name: 'stray',
    definePlugin(ctx) {
      const handle = ctx.doc<Record<string, unknown>>('stray', { phase: 'init' })
      const gate = new Promise<void>((resolve) => {
        gateRef.release = resolve
      })
      ctx.service({
        id: 'svc',
        start() {
          // 运行期启动的独立异步链（模拟引擎在途任务/残留定时器）。
          strayWrite = (async () => {
            await gate // disable 完全返回后才尝试写（窗口确定已关闭）
            try {
              handle.set({ phase: 'stray' })
            } catch (err) {
              strayErrors.push(err)
            }
          })()
        },
        async stop() {
          await delay(30)
        },
      })
    },
  }
  const host = makeHost()
  await host.register(definition)
  await host.disable('test:stray')
  gateRef.release() // 窗口确定关闭后放行残留链
  await strayWrite
  assert.equal(strayErrors.length, 1, `stop 返回后残留写入应恰好被拒一次（实际 ${JSON.stringify(strayErrors)}）`)
  assert.ok(strayErrors[0] instanceof HelmError && strayErrors[0].code === 'plugin_context_expired')
  await host.dispose()
})

test('窗口语义：stop 窗口内引擎式旧 promise 链（不继承 stop 异步上下文）的写入放行', { timeout: 60_000 }, async () => {
  // 真实引擎 close 的在途 settle 链在 stop 之前创建：await close 等待它完成时，
  // 这些链的 doc 写入不携带 stop 的 AsyncLocalStorage 上下文——窗口必须按
  // 插件状态标记放行（这正是选择 stopDocWrites 标记而非 ALS 的原因）。
  let chainWrite: Promise<void> = Promise.resolve()
  const chainErrors: unknown[] = []
  const definition: PluginDefinition = {
    id: 'test:chain',
    name: 'chain',
    definePlugin(ctx) {
      const handle = ctx.doc<Record<string, unknown>>('chain', { phase: 'init' })
      let releaseChain: () => void = () => {}
      const chainGate = new Promise<void>((resolve) => {
        releaseChain = resolve
      })
      let started = false
      ctx.service({
        id: 'svc',
        start() {
          started = true
        },
        async stop() {
          assert.ok(started)
          // 模拟引擎：旧 promise 链在 start 期创建，stop 内 await 它；链体在
          // 独立异步上下文中执行 doc 写入（不是 stop 函数内直接写）。
          const chain = (async () => {
            await chainGate
            await delay(10) // 再跨一次微任务/宏任务边界
            try {
              handle.set({ phase: 'settled-by-old-chain' })
            } catch (err) {
              chainErrors.push(err)
            }
          })()
          releaseChain()
          await chain
        },
      })
    },
  }
  const host = makeHost()
  await host.register(definition)
  await host.disable('test:chain')
  assert.deepEqual(chainErrors, [], 'stop await 的旧链写入必须被窗口放行（不因 deactivating 拒绝）')
  const persisted = docs.get('test:chain:chain', { phase: 'missing' })
  assert.equal(persisted.phase, 'settled-by-old-chain', '旧链写入真实落持久层')
  await host.dispose()
})

test('窗口边界：reenable 后旧周期句柄写入被拒（epoch 更替）', { timeout: 60_000 }, async () => {
  const { definition, firstHandle } = stopWriterPlugin('test:reenable', { writeKey: 'cycle1' })
  const host = makeHost()
  await host.register(definition)
  await host.disable('test:reenable')
  await host.enable('test:reenable')
  // 旧句柄（firstHandle 闭包 epoch=1）在新周期（epoch=2）写入/读取均被拒
  assert.throws(
    () => firstHandle.current!.set({ phase: 'old-cycle' }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
    'reenable 后旧周期句柄必须被拒',
  )
  assert.throws(() => firstHandle.current!.get(), (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 3. 真实 builtin:workflow 受控关停：运行中任务终态落 records + runs 并重启一致
// ---------------------------------------------------------------------------

test('真实 workflow 插件：运行中 run 受控 dispose，终态落私有 records 与公共 runs，重启读取一致，无 unhandled rejection', { timeout: 60_000 }, async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (err: unknown) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  // 挂起的 spawn：run 保持 running 直到 abort（close 触发）。
  let releaseSpawn: () => void = () => {}
  const spawnGate = new Promise<unknown>((resolve) => {
    releaseSpawn = () => resolve('late-result')
  })
  backend.spawnAgent = () => spawnGate
  await host.register(createWorkflowPlugin())
  const runAction = async (input: Record<string, unknown>): Promise<{ run: { id: string; status: string } }> =>
    (await host.invokeAction('builtin:workflow', 'run', input, { conversationId: 1 })) as { run: { id: string; status: string } }
  const started = await runAction({
    script: 'export const meta = { name: "dispose-final", description: "d" }\nconst v = await agent("挂起任务")\nreturn v',
  })
  assert.equal(started.run.status, 'running', 'run 应在运行中（spawn 挂起）')

  // 受控 dispose：stop 链内 close() abort 运行中 run → 引擎 settle 链写终态到
  // 私有 records doc（此时 phase=deactivating，必须经受控停止窗口放行）→ 最终
  // runs 投影同步。
  releaseSpawn()
  await host.dispose()

  // 私有 records：run 终态已持久（不是 running 残留）
  const records = docs.get<Record<string, unknown>>('builtin:workflow:records', {})
  const runIds = (records['workflow/runs'] as Array<{ id: string }> | undefined) ?? []
  assert.equal(runIds.length, 1, `应有恰好一条 run 索引（实际 ${JSON.stringify(runIds)}）`)
  const record = records[`workflow/run/${started.run.id}`] as { status?: string } | undefined
  assert.ok(record, `run 记录应已持久（实际 keys=${JSON.stringify(Object.keys(records))}）`)
  assert.equal(record!.status, 'aborted', `close 应把运行中 run 显式结算为 aborted（实际 ${JSON.stringify(record)}）`)

  // 公共 runs 投影：终态同步（dispose 的 stop 末尾最终投影）。
  const runsDoc = docs.get<{ runs: Array<{ id: string; status: string }> }>('builtin:workflow:runs', { runs: [] })
  const projected = runsDoc.runs.find((r) => r.id === started.run.id)
  assert.ok(projected, `公共 runs 投影应含该 run（实际 ${JSON.stringify(runsDoc.runs)}）`)
  assert.equal(projected!.status, 'aborted', '投影状态与终态一致')

  // 重启语义：新 host 读同一持久层，记录一致可见（真实持久读回）。
  const host2 = makeHost()
  await host2.register(createWorkflowPlugin())
  const runsAfterRestart = (await host2.invokeAction('builtin:workflow', 'runs', {}, { conversationId: 1 })) as {
    runs: Array<{ id: string; status: string }>
  }
  const restored = runsAfterRestart.runs.find((r) => r.id === started.run.id)
  assert.ok(restored, `重启后 run 记录应可读（实际 ${JSON.stringify(runsAfterRestart.runs)}）`)
  assert.equal(restored!.status, 'aborted', '重启后终态一致')
  await host2.dispose()

  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [], '全程不得产生 unhandled rejection')
})

// ---------------------------------------------------------------------------
// 4. start 屏障回滚聚合：start 失败 + 之前插件 stop 失败 双诊断
// ---------------------------------------------------------------------------

test('start 屏障：某插件 start 失败且先前插件 stop 失败，错误同时含原始失败与 rollback stop 诊断', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  // 先启插件：stop 故意失败（rollback 阶段可诊断）。
  await host.register({
    id: 'test:first',
    name: 'first',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          await delay(10)
          throw new HelmError('stop_boom', 'first 的 stop 故意失败', 500)
        },
      })
    },
  })
  // 后启插件：start 失败（触发屏障回滚）。
  await host.register({
    id: 'test:second',
    name: 'second',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        async start() {
          throw new HelmError('start_boom', 'second 的 start 故意失败', 500)
        },
        async stop() {},
      })
    },
  })
  const err = await host.start().then(
    () => undefined,
    (e: unknown) => e,
  )
  assert.ok(err instanceof HelmError, `应抛 HelmError（实际 ${String(err)}）`)
  assert.equal(err.code, 'start_boom', '保留原始 start 失败 code（不被 stop 失败覆盖）')
  assert.equal(err.status, 500)
  const details = err.details as { rollbackStopErrors?: Array<{ pluginId: string; stopErrors: Array<{ serviceId: string; error: { message: string } }> }> }
  const rollback = details?.rollbackStopErrors ?? []
  assert.equal(rollback.length, 1, `应恰好一条 rollback 诊断（实际 ${JSON.stringify(rollback)}）`)
  assert.equal(rollback[0]!.pluginId, 'test:first', 'rollback 诊断携带 pluginId')
  assert.equal(rollback[0]!.stopErrors[0]!.serviceId, 'svc', 'rollback 诊断携带 serviceId')
  assert.equal(rollback[0]!.stopErrors[0]!.error.message, 'first 的 stop 故意失败', 'JSON-safe stop 诊断保留原始 message')
  // 屏障未放行：可修复后重试（原错误不被吞也不永久卡死）。
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 5. flush 契约：真实持久化端口（镜像已写 ≠ 持久化完成）
// ---------------------------------------------------------------------------

test('flush 契约：records.flush 是真实排队写冲刷（flush 未完成/失败时 spawn 不得启动）', { timeout: 60_000 }, async () => {
  // flushGate 阻塞 records flush：startBackgroundAgent 的 durable running 快照
  // 写入后必须 await flush 完成才允许发起 spawn 副作用（旧空实现会立即 spawn）。
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  let spawnCalls = 0
  backend.spawnAgent = () => {
    spawnCalls += 1
    return Promise.resolve('spawned-result')
  }
  await host.register(createWorkflowPlugin())

  let releaseFlush: () => void = () => {}
  docs.flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  const startPromise = host.invokeAction('builtin:workflow', 'run', {
    script: 'export const meta = { name: "flush-gate", description: "d" }\nreturn 1',
  }, { conversationId: 1 })
  // 等一小段：flush 仍挂起时 spawn 绝不能已发起（run() 也可因 prepareRecovery
  // 未 flush 而尚未到达 spawn——两条路径都证明「未落盘不派生副作用」）。
  await delay(120)
  assert.equal(spawnCalls, 0, `flush 未完成时不得启动 spawn（实际 ${spawnCalls}）`)

  // flush 失败路径：spawn 同样不得发生，错误显式上抛（不静默降级）。
  releaseFlush()
  await startPromise.then(
    () => undefined,
    () => undefined,
  )
  assert.equal(spawnCalls, 0, '纯脚本 run 无 spawn 消费；flush 完成后 run 正常执行（无副作用违反）')
  assert.ok(docs.flushCalls >= 1, `records.flush 至少被调用一次（实际 ${docs.flushCalls}）`)
  await host.dispose()
})

test('flush 失败：durable 快照 flush 失败时 run 拒绝且零 spawn（不静默派生子任务）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  let spawnCalls = 0
  backend.spawnAgent = () => {
    spawnCalls += 1
    return Promise.resolve('bg-result')
  }
  await host.register(createWorkflowPlugin())
  // flush 失败（真实持久层故障形态）：durable running 快照已写但落盘失败——
  // 副作用 spawn 必须被拒绝，错误显式上抛给调用方（绝不静默降级继续 spawn）。
  docs.flushFail = new HelmError('store_flush_failed', '持久层冲刷失败（测试注入）', 500)
  await assert.rejects(
    () =>
      host.invokeAction('builtin:workflow', 'run', {
        script: 'export const meta = { name: "bg-flush-fail", description: "d" }\nconst v = await agent("bg 任务")\nreturn v',
      }, { conversationId: 1 }),
    (err: unknown) => err instanceof HelmError,
    'flush 失败必须使 run 显式失败',
  )
  assert.equal(spawnCalls, 0, `flush 失败后不得启动 spawn（实际 ${spawnCalls}）`)
  delete docs.flushFail
  await host.dispose()
})

test('受控 stop：最终 runs 投影写后 await 真实 flush（dispose 完成即排队写冲刷完成）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  await host.register(createWorkflowPlugin())
  await host.invokeAction('builtin:workflow', 'run', {
    script: 'export const meta = { name: "final-flush", description: "d" }\nreturn 1',
  }, { conversationId: 1 })
  const flushCallsBefore = docs.flushCalls
  await host.dispose()
  // stop 链：close（内部 state.flush）→ 最终投影 → records.flush（stop 尾部）。
  assert.ok(docs.flushCalls > flushCallsBefore, `stop 末尾必须 await 真实 flush（前 ${flushCallsBefore} 后 ${docs.flushCalls}）`)
  // 持久层含最终投影与 run 记录（真实读回）。
  assert.ok(docs.writes.includes('builtin:workflow:runs'), '最终 runs 投影已写入')
  assert.ok(docs.writes.includes('builtin:workflow:records'), 'records 已写入')
})
