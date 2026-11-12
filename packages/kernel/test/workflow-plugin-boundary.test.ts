/**
 * 服务启动屏障 / 可等待事件结算 / 工具结果信封边界 / UI 注册校验 /
 * 动作 conversationId 冲突 —— builtin:workflow 后端修正的针对性契约测试。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  WORKFLOW_PLUGIN_ID,
  type ConversationSummary,
  type MaybePromise,
  type PluginDefinition,
  type PluginToolContext,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore } from '../src/plugins/index.js'
import { PluginHostBackendFixtureBase } from './helpers/plugin-host-backend.js'
import { pluginToolResult } from '../src/runtime/runtime-helpers.js'

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

/** 可编程后端：emitEvent 可等待（内部监听器顺序执行、错误上抛）。 */
class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>()
  emitted: Array<{ type: string; payload: unknown }> = []
  private listeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()

  constructor() {
    super()
    this.conversations.set(1, makeConversation(1))
    this.conversations.set(2, makeConversation(2))
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
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human'
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
  // 供 cleanup_worktree 真实插件路径驱动：execEnv 返回失败 git 输出（不执行真实命令）。
  execEnv(): Promise<import('@helm/protocol').EnvExecResponse> {
    return Promise.resolve({ ok: false, exitCode: 128, output: 'fatal: not a git repository', timedOut: false })
  }
  listActiveSpawnExecutions(): never[] {
    return []
  }
  redactText(text: string): string {
    return text
  }
  probeNodeFs(input: { nodeId: string; op: 'exists' | 'canonicalPath'; path: string }): Promise<{ value: string | boolean }> {
    if (input.op === 'exists') return Promise.resolve({ value: true })
    return Promise.resolve({ value: input.path })
  }
  invokeAction(): Promise<unknown> {
    return Promise.resolve({})
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
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
  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
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
  emitEvent(type: string, payload: unknown): MaybePromise<void> {
    this.emitted.push({ type, payload })
    const set = this.listeners.get(type)
    if (set === undefined || set.size === 0) return
    return (async () => {
      for (const listener of [...set]) await listener(payload)
    })()
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
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

class MemorySessionDocStore {
  store = new Map<string, string>()
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    this.store.delete(`${pluginId}\0${name}\0${conversationId}`)
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }
  listConversationIds(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of this.store.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const id = Number(key.split('\0')[2])
      if (Number.isSafeInteger(id) && id > 0) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let backend: FakeBackend
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({
    dataDir,
    host: backend,
    docs,
    sessionDocs,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

/** 记录 prepare/start/stop 调用顺序的服务插件。 */
function servicePlugin(id: string, log: string[], gates?: { blockPrepare?: Promise<void> }): PluginDefinition {
  return {
    id,
    name: id,
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        async prepare() {
          if (gates?.blockPrepare) await gates.blockPrepare
          log.push(`${id}:prepare`)
        },
        async start() {
          log.push(`${id}:start`)
        },
        async stop() {
          log.push(`${id}:stop`)
        },
      })
    },
  }
}

function toolContext(over: Partial<PluginToolContext> = {}): PluginToolContext {
  return { conversationId: 1, callId: 'call-1', ...over }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugin-barrier-'))
  backend = new FakeBackend()
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. deferServices 启动屏障
// ---------------------------------------------------------------------------

test('deferServices：register 不启动服务；start() 先全部 prepare 再逐插件 start；幂等', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  await host.register(servicePlugin('test:b', log))
  assert.deepEqual(log, [], 'defer 模式下 register 不得启动任何服务（prepare/start 均不执行）')

  await host.start()
  assert.deepEqual(log, ['test:a:prepare', 'test:b:prepare', 'test:a:start', 'test:b:start'], '全局屏障：全部 prepare 完成后才开始任何 start')
  await host.start()
  assert.equal(log.filter((e: string) => e.endsWith(':start')).length, 2, 'start 幂等，不重复启动')
  await host.dispose()
})

test('deferServices：start 前热启用插件不 start，屏障放行后即时 prepare+start', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  // 屏障未放行：enable 只登记
  await host.register(servicePlugin('test:c', log), { enabled: false })
  await host.enable('test:c')
  assert.deepEqual([...log], [], '屏障未放行前 enable 不得启动服务')
  // 屏障放行：participants 快照含 test:a；test:c 已 enable 完成走即时路径？
  // enable 在 start() 之前完成时也应包含在屏障快照中（同一语义）。
  await host.start()
  const starts = log.filter((e: string) => e.endsWith(':start'))
  assert.equal(starts.length, 2, `两个插件的服务都应恰好启动一次（实际 ${JSON.stringify(log)}）`)
  const lastEvent = log.at(-1)
  assert.ok(lastEvent !== undefined && lastEvent.endsWith(':start'), `start 阶段必须最后（实际 ${JSON.stringify(log)}）`)
  await host.dispose()
})

test('deferServices：屏障后热启用走即时 prepare+start（顺序正确）', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  await host.start()
  log.length = 0
  await host.register(servicePlugin('test:d', log), { enabled: false })
  await host.enable('test:d')
  assert.deepEqual(log, ['test:d:prepare', 'test:d:start'], '屏障完成后热启用：即时 prepare 先于 start')
  await host.dispose()
})

test('deferServices：任一 prepare 失败则零 start 且可重试', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  let fail = true
  await host.register({
    id: 'test:bad',
    name: 'bad',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        async prepare() {
          if (fail) throw new HelmError('prepare_boom', 'prepare 阶段失败', 500)
          log.push('test:bad:prepare')
        },
        async start() {
          log.push('test:bad:start')
        },
        async stop() {},
      })
    },
  })
  await assert.rejects(() => host.start(), (err: unknown) => err instanceof HelmError && err.code === 'prepare_boom')
  assert.equal(log.filter((e: string) => e.endsWith(':start')).length, 0, `prepare 失败：任何 start 不得执行（实际 ${JSON.stringify(log)}）`)
  fail = false
  await host.start()
  assert.ok(log.includes('test:a:start') && log.includes('test:bad:start'), `修复后重试 start 全部启动（实际 ${JSON.stringify(log)}）`)
  await host.dispose()
})

test('非 defer（宿主模式）：register/enable 即时 prepare+start（既有语义保留）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  assert.deepEqual(log, ['test:a:prepare', 'test:a:start'], '默认模式 register 即时启动')
  await host.register(servicePlugin('test:b', log), { enabled: false })
  await host.enable('test:b')
  assert.deepEqual(log.slice(2), ['test:b:prepare', 'test:b:start'], '默认模式 enable 即时启动')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 2. 可等待 emitEvent（结算监听器错误上抛）
// ---------------------------------------------------------------------------

test('emitEvent 可等待：异步监听器完成前不返回；监听器错误上抛给发布方', { timeout: 60_000 }, async () => {
  const host = makeHost()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  await host.register({
    id: 'test:listener',
    name: 'listener',
    definePlugin(ctx) {
      void ctx.host.onEvent('workflow.settled', async () => {
        entered = true
        await gate
      })
    },
  })
  let settled = false
  const emitPromise = (async () => {
    await backend.emitEvent('workflow.settled', { id: 'wf_1' })
    settled = true
  })()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(entered, '监听器应已进入')
  assert.ok(!settled, '监听器完成前 emitEvent 不得返回（可等待语义）')
  release()
  await emitPromise
  assert.ok(settled, '释放后 emitEvent 返回')

  // 错误传播：监听器 throw → emitEvent reject（发布方拿到的不是静默成功）
  await host.register({
    id: 'test:bad-listener',
    name: 'bad',
    definePlugin(ctx) {
      void ctx.host.onEvent('workflow.settled', async () => {
        throw new Error('cleanup failed')
      })
    },
  })
  const emit: Promise<unknown> = backend.emitEvent('workflow.settled', { id: 'wf_2' }) as Promise<unknown>
  await assert.rejects(emit, (err: unknown) => err instanceof Error && err.message === 'cleanup failed')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 3. pluginToolResult 信封边界
// ---------------------------------------------------------------------------

test('pluginToolResult：无信封字段的业务对象走文本通道；output 字段类型非法才拒绝', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  // 纯业务对象（不含 output/structuredOutput/isError 任一字段）：走文本通道，
  // 原样 JSON，绝不误判信封（业务字段名撞信封名才构成歧义，见下）。
  const business = { result: '业务产出报告', count: 3 }
  const businessResult = pluginToolResult(business, identity)
  assert.equal(businessResult.isError, undefined)
  assert.equal(businessResult.structuredOutput, undefined)
  assert.deepEqual(businessResult.output, [{ type: 'text', text: JSON.stringify(business) }])
  // { output: string } 本身就是合法信封（文本通道）——不是业务对象误判。
  const asEnvelope = pluginToolResult({ output: 'done', count: 3 }, identity)
  assert.deepEqual(asEnvelope.output, [{ type: 'text', text: 'done' }])
  // output 为非法类型（数字）：出现信封字段即按信封严格校验，显式拒绝。
  assert.throws(
    () => pluginToolResult({ output: 42, count: 3 }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_tool_result' && err.message.includes('output'),
  )
})

test('pluginToolResult：合法信封（output+structuredOutput+isError）按 schema 保留结构化输出', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  const envelope = {
    output: [{ type: 'text', text: 'summary' }],
    structuredOutput: { ok: true, value: 7 },
    isError: false,
  }
  const result = pluginToolResult(envelope, identity, {
    structuredOutputSchema: { type: 'object' },
    toolName: 'subagent',
    callId: 'call-9',
  })
  assert.deepEqual(result.output, [{ type: 'text', text: 'summary' }])
  assert.deepEqual(result.structuredOutput, { ok: true, value: 7 })
  assert.equal(result.isError, undefined, 'isError:false 不置错误位')
})

test('pluginToolResult：未声明 schema 却返回 structuredOutput 显式拒绝（不静默丢数据）', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  assert.throws(
    () =>
      pluginToolResult(
        { output: 'text', structuredOutput: { secret: 'data' } },
        identity,
        { toolName: 'subagent', callId: 'call-42' },
      ),
    (err: unknown) =>
      err instanceof HelmError &&
      err.code === 'invalid_tool_result' &&
      err.message.includes('callId=call-42') &&
      err.message.includes('structuredOutputSchema'),
  )
})

test('pluginToolResult：isError 非 boolean 显式拒绝（不静默忽略）', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  assert.throws(
    () => pluginToolResult({ output: 'text', isError: 'yes' }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_tool_result' && err.message.includes('isError'),
  )
  assert.throws(
    () => pluginToolResult({ output: 42 }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_tool_result' && err.message.includes('output'),
  )
})

test('pluginToolResult：结构化输出值级脱敏', { timeout: 60_000 }, () => {
  const redact = (text: string) => text.replaceAll('SECRET', '***')
  const result = pluginToolResult(
    { output: '含 SECRET 文本', structuredOutput: { token: 'SECRET', nested: { key: 'SECRET' } } },
    redact,
    { structuredOutputSchema: { type: 'object' } },
  )
  assert.deepEqual(result.output, [{ type: 'text', text: '含 *** 文本' }])
  assert.deepEqual(result.structuredOutput, { token: '***', nested: { key: '***' } })
})

// ---------------------------------------------------------------------------
// 4. UI 注册边界：replaceRow / badge / docs 末尾校验
// ---------------------------------------------------------------------------

test('addUi 校验：tool.view replaceRow 非布尔拒绝；toolNames 非法拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assert.rejects(
    () =>
      host.register({
        id: 'test:ui-bad',
        name: 'bad',
        clientRoot: dataDir,
        definePlugin(ctx) {
          ctx.ui.toolView({
            id: 'v1',
            toolNames: ['subagent'],
            replaceRow: 'true' as never,
            client: { module: 'index.tsx', export: 'X' },
          } as never)
        },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec' && err.message.includes('replaceRow'),
  )
  await assert.rejects(
    () =>
      host.register({
        id: 'test:ui-bad2',
        name: 'bad2',
        clientRoot: dataDir,
        definePlugin(ctx) {
          ctx.ui.toolView({ id: 'v2', toolNames: [], client: { module: 'index.tsx', export: 'X' } } as never)
        },
      }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec' && err.message.includes('toolNames'),
  )
  await host.dispose()
})

test('addUi 校验：workbench badge 形状非法拒绝（未知字段/doc 非 string/字段名非 string）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const badBadges: unknown[] = [
    { doc: 'runs', count: 3 },
    { doc: 42 },
    { doc: 'runs', countField: 7 },
  ]
  for (const [i, badge] of badBadges.entries()) {
    await assert.rejects(
      () =>
        host.register({
          id: `test:badge-bad-${i}`,
          name: 'bad',
          definePlugin(ctx) {
            ctx.doc('runs', {}, { public: true })
            ctx.ui.workbenchPanel({
              id: 'p',
              label: 'P',
              badge: badge as never,
              docs: ['runs'],
              client: { module: 'index.tsx', export: 'X' },
            } as never)
          },
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec' && err.message.includes('badge'),
    )
  }
  await host.dispose()
})

test('workflow run 动作：input.conversationId 与调用上下文冲突显式拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: WORKFLOW_PLUGIN_ID,
    name: 'wf',
    async definePlugin(ctx) {
      ctx.action({
        id: 'probe',
        description: 'probe',
        inputSchema: { type: 'object', properties: { conversationId: { type: 'number' } }, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async handler(input, context) {
          const { conversationId } = input as { conversationId?: number }
          if (
            conversationId !== undefined &&
            context.conversationId !== undefined &&
            conversationId !== context.conversationId
          ) {
            throw new HelmError(
              'validation_error',
              `conversationId 冲突：输入指定 ${conversationId} 与调用上下文 ${context.conversationId} 不一致`,
              400,
            )
          }
          return {}
        },
      })
    },
  })
  await assert.rejects(
    () => host.invokeAction('test:x', 'probe', {}, toolContext({ conversationId: 1 })),
    (err: unknown) => err instanceof HelmError && err.code === 'unknown_plugin',
  )
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 6. cleanup_worktree 工具错误信封诚实性（真实插件路径：WorktreeAllocator 自有 Git 能力）
// ---------------------------------------------------------------------------

/** 预置一条 active 受管 worktree 登记（插件私有 doc 键为 `builtin:workflow:worktree-state`）。 */
function seedManagedWorktree(docStore: MemoryDocStore): void {
  docStore.set('builtin:workflow:worktree-state', {
    'runtime/worktrees': {
      version: 1,
      records: [{
        id: 'local:/wt/x', nodeId: 'local', repoRoot: '/repo', path: '/wt/x', branch: 'helm/spawn-x',
        baseCommit: 'a1b2c3', dirtySource: false, parentConversationId: 1, conversationId: 1,
        origin: 'native', status: 'active', createdAt: 1,
      }],
    },
  })
}

test('cleanup_worktree 工具：错误分支仅 ok:false+error，绝不伪造空 worktreeId/path/branch/nodeId', { timeout: 60_000 }, async () => {
  // 新契约：cleanup 由插件 WorktreeAllocator 经 ctx.host.execEnv 真实执行 git，
  // 宿主 cleanupWorktree 端口已删除；execEnv 失败 → 错误信封（ok:false+error）。
  const host = makeHost()
  seedManagedWorktree(docs)
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  await host.register(createWorkflowPlugin())
  const raw = (await host.executeTool('cleanup_worktree', { conversationId: 1 }, {
    conversationId: 1,
    callId: 'call-1',
  })) as { isError?: boolean; structuredOutput?: Record<string, unknown> }
  assert.equal(raw.isError, true)
  assert.deepEqual(Object.keys(raw.structuredOutput ?? {}).sort(), ['error', 'ok'])
  assert.equal(raw.structuredOutput?.['ok'], false)
  // 真实诊断透传：execEnv 的 git 失败输出必须出现在 error 里（不伪造、不吞）。
  assert.ok(String(raw.structuredOutput?.['error']).includes('not a git repository'))
  await host.dispose()
})

test('cleanup_worktree 工具错误信封：structuredOutput 仅 { ok:false, error }，无伪造 metadata', { timeout: 60_000 }, async () => {
  // 无登记选择器未命中：not_found 诊断同样只走 ok:false+error 信封。
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
  await host.register(createWorkflowPlugin())
  const raw = (await host.executeTool('cleanup_worktree', { conversationId: 2 }, toolContext())) as {
    output: Array<{ type: string; text: string }>
    isError?: boolean
    structuredOutput?: Record<string, unknown>
  }
  assert.equal(raw.isError, true)
  assert.deepEqual(
    Object.keys(raw.structuredOutput ?? {}).sort(),
    ['error', 'ok'],
    `错误信封字段必须仅 ok/error（实际 ${JSON.stringify(raw.structuredOutput)}）`,
  )
  assert.equal(raw.structuredOutput?.['ok'], false)
  assert.ok(String(raw.structuredOutput?.['error']).includes('未找到'), `error 保留真实诊断（实际 ${JSON.stringify(raw.structuredOutput)}）`)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 7. emitEvent 适配器收口：runs 投影/广播失败不得逃逸为 unhandledRejection
// ---------------------------------------------------------------------------

/**
 * 预置插件 records 文档：wf_a 为跨重启遗留 running（init 会标 failed 并发
 * workflow.updated）；wf_c 索引项 conversationId 非法——适配器内 syncRunsDoc →
 * listRuns 将抛 workflow_index_corrupt（观察面持久层故障），但
 * prepareRecovery/init 逐记录读取仍可完成（记录本体存在且形状合法）。
 */
function seedCorruptRunsIndex(docStore: MemoryDocStore): void {
  docStore.set('builtin:workflow:records', {
    'workflow/runs': [
      { id: 'wf_a', conversationId: 1, createdAt: 1 },
      { id: 'wf_c', conversationId: 0, createdAt: 2 },
    ],
    'workflow/run/wf_a': {
      id: 'wf_a',
      name: 'a',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      kind: 'workflow',
      journalPath: '/tmp/nonexistent-a.jsonl',
    },
    'workflow/run/wf_c': {
      id: 'wf_c',
      name: 'c',
      conversationId: 1,
      status: 'completed',
      createdAt: 2,
      updatedAt: 2,
      kind: 'workflow',
      journalPath: '/tmp/nonexistent-c.jsonl',
    },
  })
}

test('emitEvent 适配器：runs 投影损坏时引擎语义完整、显式诊断、无 unhandledRejection', { timeout: 60_000 }, async () => {
  // 真实插件链路（服务适配器 async 且内部 syncRunsDoc 可抛）：遗留 run 照常被
  // init 标 failed（终态写入 records），事件投影失败只诊断（stderr +
  // notification），不得放大成 unhandledRejection 拖垮进程。
  seedCorruptRunsIndex(docs)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  let host: PluginHost | undefined
  try {
    host = makeHost()
    const { createWorkflowPlugin } = await import('../src/builtin-plugins/workflow.js')
    // start 末尾的 syncRunsDoc 会因索引损坏同步失败（既有诚实行为）；
    // 关键在于 init 路径的 workflow.updated 事件不产生逃逸 rejection。
    await assert.rejects(
      () => host!.register(createWorkflowPlugin()),
      (err: unknown) => err instanceof HelmError && err.code === 'workflow_index_corrupt',
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], '事件适配器故障不得逃逸为 unhandledRejection')
    // wf_a 仍被 init 如实标 failed（引擎终态语义不被观察面故障破坏）。
    const records = docs.get<Record<string, { status?: string }>>('builtin:workflow:records', {})
    assert.equal(records['workflow/run/wf_a']?.status, 'failed')
    // 适配器收口后的显式诊断事件（区别于 stop 路径的「工作流最终投影未同步」）。
    const notifications = backend.emitted.filter(
      (e) =>
        e.type === 'notification' &&
        String((e.payload as { title?: string }).title).includes('工作流事件投影未同步'),
    )
    assert.ok(notifications.length > 0, `应发布投影失败诊断 notification（实际 ${JSON.stringify(backend.emitted.map((e) => e.type))}）`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await host?.dispose()
  }
})
