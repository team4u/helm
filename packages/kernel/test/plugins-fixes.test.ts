/**
 * 插件返修回归第 2/3/4 批（P1）：
 *
 * - herdr：探针 agent.get/session.snapshot 短超时、多 pane 并发采集、
 *   订阅断线退避自愈重连、窗格结算后探针缓存回收；
 * - superagent：dispatch_worker 提交失败完整回滚（index/subscriptions/
 *   worker-archived 标签，不残留僵尸、不锁死 threadKey）、recall_context
 *   只读无写副作用、已归档 Worker 侧栏分组声明；
 * - assistant：MEMORY.md 大小防线（update_memory 超限 400 双路径 + 注入
 *   截断显式说明）、文件误删容错（回合不 500 + 一次性告警）。
 *
 * 组合纪律：受控 PluginHost backend（真实 PluginHost + 真实插件代码路径），
 *不起完整内核——失败注入需要确定性边界；assistant 用真实 ProfileService
 * 临时目录验证纯文件边界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  HelmError,
  type ConversationSummary,
  type WatchdogTickHookPayload,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import { createSuperAgentPlugin } from '../src/builtin-plugins/superagent.js'
import { MAX_MEMORY_CHARS } from '../src/builtin-plugins/assistant.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import type { SuperAgentDependencies } from '../src/builtin-plugins/superagent/contracts.js'
import { ProfileService, SkillService } from '../src/services/index.js'

// ---------------------------------------------------------------------------
// 共享基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
}

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

interface ControlledBackend extends PluginHostBackend {
  conversations: Map<number, ConversationSummary>
  notifications: Array<{ title: string; body: string; level: string }>
  submits: Array<{ conversationId: number; origin?: string }>
  /** submitInput 拒绝规则（返回非 undefined 即按其 reject）。 */
  submitRejector: ((conversationId: number) => Error | undefined) | undefined
}

function makeControlledBackend(): ControlledBackend {
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1, { tags: ['root'] }))
  conversations.set(3, makeConversation(3))
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const submits: Array<{ conversationId: number; origin?: string }> = []
  const backend: ControlledBackend = {
    conversations,
    notifications,
    submits,
    submitRejector: undefined,
    async dispatchTrigger() {},
    async submitInput(conversationId, _text, opts) {
      submits.push({ conversationId, origin: opts?.origin })
      const rejection = this.submitRejector?.(conversationId)
      if (rejection !== undefined) throw rejection
    },
    async createConversation(init) {
      const id = Math.max(...conversations.keys()) + 1
      const summary = makeConversation(id, {
        title: init.title ?? 'new',
        profileId: init.profileId ?? 'assistant',
        ...(init.tags !== undefined ? { tags: init.tags } : {}),
        ...(init.parentConversationId !== undefined ? { parentConversationId: init.parentConversationId } : {}),
      })
      conversations.set(id, summary)
      return summary
    },
    listConversations() { return [...conversations.values()] },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() { return () => {} },
    markConversationOwnership() {},
    async createAsk() { throw new HelmError('unsupported', 'test', 400) },
    async cancelAsk() {},
    registerAskSeqResolver() { return () => {} },
    onWorkflowSettled() { return () => {} },
    emitEvent(type, payload) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    },
  }
  return backend
}

// ---------------------------------------------------------------------------
// herdr：受控 transport（可编程延迟与断线注入）
// ---------------------------------------------------------------------------

interface FakePane {
  paneId: string
  agentStatus: string
  seq: number
  name?: string
  cwd: string
}

class ProbeTransport implements HerdrTransport {
  panes = new Map<string, FakePane>()
  calls: Array<{ method: string; timeoutMs?: number }> = []
  agentGetDelayMs = 0
  private subscriptionErrorTriggers: Array<(error: Error) => void> = []

  private agentInfoOf(pane: FakePane) {
    return {
      pane_id: pane.paneId,
      tab_id: `t-${pane.paneId}`,
      workspace_id: 'w',
      name: pane.name,
      agent_status: pane.agentStatus,
      interactive_ready: true,
      state_change_seq: pane.seq,
      cwd: pane.cwd,
    }
  }

  async call(
    _target: HerdrTarget,
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    this.calls.push({ method, timeoutMs: options?.timeoutMs })
    if (method === 'agent.get') {
      if (this.agentGetDelayMs > 0) await delay(this.agentGetDelayMs)
      const pane = this.panes.get(String(params['target']))
      if (!pane) throw new HelmError('agent_not_found', 'no pane', 404)
      return { type: 'agent_info', agent: this.agentInfoOf(pane) }
    }
    if (method === 'session.snapshot') {
      return {
        type: 'session_snapshot',
        snapshot: {
          version: 'test', protocol: 22, workspaces: [], tabs: [],
          panes: [...this.panes.values()].map((p) => ({
            pane_id: p.paneId, tab_id: `t-${p.paneId}`, workspace_id: 'w',
            focused: false, agent_status: p.agentStatus, cwd: p.cwd,
          })),
          layouts: [],
          agents: [...this.panes.values()].map((p) => this.agentInfoOf(p)),
        },
      }
    }
    return { type: 'ok' }
  }
  async readOutput(): Promise<string> { throw new HelmError('unsupported', 'test', 400) }
  async removeOutput(): Promise<void> {}
  async runGate() { return { ok: true, output: '' } }
  async subscribe(
    _target: HerdrTarget,
    _onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    this.subscriptionErrorTriggers.push((error) => onError(error))
    return () => {}
  }
  failLatestSubscription(error: Error): void {
    this.subscriptionErrorTriggers.at(-1)?.(error)
  }
  get subscribeCount(): number {
    return this.subscriptionErrorTriggers.length
  }
}

interface HerdrEnv {
  host: PluginHost
  backend: ControlledBackend
  transport: ProbeTransport
  close(): Promise<void>
}

async function makeHerdrEnv(
  panes: Array<{ paneId: string; agentName: string; cwd: string; status?: string; seq?: number }>,
): Promise<HerdrEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-fix2-'))
  const backend = makeControlledBackend()
  const docs = new MemoryDocStore()
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: panes.map((p) => ({
      target: {},
      paneId: p.paneId,
      tabId: `t-${p.paneId}`,
      effectiveCwd: p.cwd,
      agentName: p.agentName,
      routing: { kind: 'agy' },
      parentConversationId: 3,
      outcome: 'keepalive',
      createdAt: 1,
    })),
  })
  const transport = new ProbeTransport()
  for (const p of panes) {
    transport.panes.set(p.paneId, {
      paneId: p.paneId,
      agentStatus: p.status ?? 'working',
      seq: p.seq ?? 1,
      name: p.agentName,
      cwd: p.cwd,
    })
  }
  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register(
    createHerdrPlugin({
      defaultCwd: '/tmp',
      profiles: { get: async () => undefined },
      buildSpawnEnv: () => ({}),
      redact: (t) => t,
      runLocalGate: async () => ({ ok: true, output: '' }),
      transport,
    }),
    { enabled: true },
  )
  return {
    host,
    backend,
    transport,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function runHerdrTick(env: HerdrEnv): Promise<WatchdogTickHookPayload> {
  const payload: WatchdogTickHookPayload = { timestamp: Date.now(), conversations: [], probes: [] }
  await env.host.runHook('watchdog_tick', payload)
  return payload
}

// ---------------------------------------------------------------------------
// 2a. 探针短超时 + 并发
// ---------------------------------------------------------------------------

test('herdr tick：agent.get / session.snapshot 全部带 5s 短超时', { timeout: 60_000 }, async () => {
  const env = await makeHerdrEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    await runHerdrTick(env)
    for (const call of env.transport.calls.filter((c) => c.method === 'agent.get')) {
      assert.equal(call.timeoutMs, 5_000, `agent.get 应带 timeoutMs=5000（实际 ${String(call.timeoutMs)}）`)
    }
    for (const call of env.transport.calls.filter((c) => c.method === 'session.snapshot')) {
      assert.equal(call.timeoutMs, 5_000, `session.snapshot 应带 timeoutMs=5000（实际 ${String(call.timeoutMs)}）`)
    }
  } finally {
    await env.close()
  }
})

test('herdr tick：5 个 300ms 探针并发采集（串行 1.5s 应压到 1s 内）', { timeout: 60_000 }, async () => {
  const panes = Array.from({ length: 5 }, (_, i) => ({
    paneId: `w:p${i + 1}`,
    agentName: `helm-wf-${i + 1}`,
    cwd: `/tmp/${i + 1}`,
    status: 'working',
    seq: 1,
  }))
  const env = await makeHerdrEnv(panes)
  try {
    env.transport.agentGetDelayMs = 300
    const start = Date.now()
    const payload = await runHerdrTick(env)
    const elapsed = Date.now() - start
    assert.equal(payload.probes.length, 5)
    assert.ok(elapsed < 1_000, `并发采集应在 1s 内完成（实际 ${elapsed}ms，疑似串行）`)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2b. 订阅断线退避自愈
// ---------------------------------------------------------------------------

test('herdr 订阅断线：onError 后自动退避重连（watchdogEnabled 无关）', { timeout: 60_000 }, async () => {
  const env = await makeHerdrEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const before = env.transport.subscribeCount
    env.transport.failLatestSubscription(new Error('socket reset by peer'))
    assert.ok(
      env.backend.notifications.some((n) => n.title === 'Herdr 事件订阅断开'),
      '断线应发出通知',
    )
    await delay(1_800) // 首次退避 ~1s + 余量
    assert.ok(
      env.transport.subscribeCount > before,
      `断线后应自动重建订阅（before=${before} after=${env.transport.subscribeCount}）`,
    )
  } finally {
    await env.close()
  }
})

test('herdr 订阅重连后的流再次断线仍继续退避重试', { timeout: 60_000 }, async () => {
  const env = await makeHerdrEnv([])
  try {
    const before = env.transport.subscribeCount
    env.transport.failLatestSubscription(new Error('down 1'))
    await delay(1_800)
    env.transport.failLatestSubscription(new Error('down 2'))
    await delay(2_500)
    assert.ok(
      env.transport.subscribeCount >= before + 2,
      `多次断线应持续重连（before=${before} after=${env.transport.subscribeCount}）`,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2c. 窗格结算后的探针回收
// ---------------------------------------------------------------------------

test('herdr tick：归属变化窗格结算移除后不再产出 probe', { timeout: 60_000 }, async () => {
  const env = await makeHerdrEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const first = await runHerdrTick(env)
    assert.equal(first.probes.length, 1)
    // 窗格归属变化（agent 更名）：tick 应结算该窗格（含缓存回收），下轮 0 probe。
    env.transport.panes.get('w:p1')!.name = 'human-agent'
    const second = await runHerdrTick(env)
    assert.equal(second.probes.length, 0, '归属变化窗格应结算移除，不再产出 probe')
    // 恢复原名也不复活（registry 已标记 settled）。
    env.transport.panes.get('w:p1')!.name = 'helm-wf-a'
    const third = await runHerdrTick(env)
    assert.equal(third.probes.length, 0)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3a. dispatch_worker 提交失败回滚
// ---------------------------------------------------------------------------

interface SuperAgentEnv {
  host: PluginHost
  backend: ControlledBackend
  docs: MemoryDocStore
  close(): Promise<void>
}

async function makeSuperAgentEnv(): Promise<SuperAgentEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-fix-'))
  const backend = makeControlledBackend()
  const docs = new MemoryDocStore()
  const host = new PluginHost({ dataDir, host: backend, docs })
  // 真实 ProfileService/SkillService（临时目录）：自举资产走真实文件路径。
  const profiles = new ProfileService(dataDir)
  const skills = new SkillService(dataDir)
  await profiles.ensureDefault()
  const deps: SuperAgentDependencies = {
    dataDir,
    profiles,
    skills,
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    listArtifacts: async () => [],
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
  }
  await host.register(createSuperAgentPlugin(deps), { enabled: true })
  return {
    host,
    backend,
    docs,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function readDoc<T>(env: SuperAgentEnv, name: string): T {
  return env.docs.store.get(`builtin:superagent:${name}`) as T
}

test('superagent：dispatch_worker 提交失败完整回滚（无僵尸 Worker、threadKey 不锁死）', { timeout: 60_000 }, async () => {
  const env = await makeSuperAgentEnv()
  try {
    const index = readDoc<{ routerConversationId?: number }>(env, 'index')
    assert.ok(index.routerConversationId !== undefined, '启用应自举常驻会话')

    // 注入 submitInput 拒绝：所有新建 worker 的首回合提交都失败。
    env.backend.submitRejector = (conversationId) => {
      const summary = env.backend.conversations.get(conversationId)
      if (summary?.tags.includes('worker')) {
        return new HelmError('conversation_not_accepting', '测试注入：提交被拒绝', 409)
      }
      return undefined
    }

    await assert.rejects(
      () => env.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '会失败的任务', threadKey: 'locked-key' }, undefined),
      (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_accepting',
    )

    // 回滚断言 1：index 无残留 worker 条目。
    const indexAfter = readDoc<{ workers: Array<{ conversationId: number }> }>(env, 'index')
    assert.equal(indexAfter.workers.length, 0, '提交失败后 index 不得残留 worker 条目')

    // 回滚断言 2：threadKey 绑定已移除——同 key 再派工不被 conflict 锁死。
    env.backend.submitRejector = undefined
    const retry = (await env.host.invokeAction(
      'builtin:superagent',
      'dispatch_worker',
      { prompt: '重试任务', threadKey: 'locked-key' },
      undefined,
    )) as { workerConversationId: number }
    assert.ok(Number.isInteger(retry.workerConversationId), '同 threadKey 重试应成功（未被失败派工锁死）')

    // 回滚断言 3：失败空会话打上 worker-archived 标签（不删除但退出活跃集）。
    let archivedFound = false
    for (const summary of env.backend.conversations.values()) {
      if (summary.tags.includes('worker-archived')) archivedFound = true
    }
    assert.ok(archivedFound, '提交失败的空会话应打上 worker-archived 标签')

    // 回滚断言 4：subscriptions 只含成功那次绑定。
    const subs = readDoc<{ subscriptions: Array<{ threadKey: string; workerConversationId: number }> }>(env, 'subscriptions')
    assert.equal(subs.subscriptions.length, 1)
    assert.equal(subs.subscriptions[0]!.threadKey, 'locked-key')
    assert.equal(subs.subscriptions[0]!.workerConversationId, retry.workerConversationId)
  } finally {
    await env.close()
  }
})

test('superagent：dispatch_worker 提交失败也发错误通知（不静默）', { timeout: 60_000 }, async () => {
  const env = await makeSuperAgentEnv()
  try {
    env.backend.submitRejector = (conversationId) => {
      const summary = env.backend.conversations.get(conversationId)
      if (summary?.tags.includes('worker')) {
        return new HelmError('conversation_not_accepting', '测试注入：提交被拒绝', 409)
      }
      return undefined
    }
    await assert.rejects(() =>
      env.host.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '会失败的任务' }, undefined))
    assert.ok(
      env.backend.notifications.some((n) => n.title.includes('提交失败')),
      '提交失败应显式通知',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3b/3c. recall_context 只读 + 已归档分组
// ---------------------------------------------------------------------------

test('superagent：recall_context 只读（不写 routing doc）；已归档 Worker 侧栏分组声明', { timeout: 60_000 }, async () => {
  const env = await makeSuperAgentEnv()
  try {
    const routingBefore = JSON.stringify(env.docs.store.get('builtin:superagent:routing'))
    await env.host.invokeAction('builtin:superagent', 'recall_context', { query: '', limit: 5 }, undefined)
    const routingAfter = JSON.stringify(env.docs.store.get('builtin:superagent:routing'))
    assert.equal(routingAfter, routingBefore, 'recall_context 不得产生 doc 写副作用')

    const sections = env.host
      .listUi()
      .filter((u) => u.pluginId === 'builtin:superagent' && u.surface === 'sidebar.section')
      .map((u) => u.spec as { id: string; filterTag?: string; collapsible?: boolean; defaultCollapsed?: boolean; order?: number })
    assert.equal(sections.length, 2, '应声明两个 sidebar.section（活跃 + 已归档）')
    const archived = sections.find((s) => s.id === 'archived-workers')
    assert.ok(archived !== undefined, '应声明 archived-workers 分组')
    assert.equal(archived.filterTag, 'worker-archived')
    assert.equal(archived.collapsible, true)
    assert.equal(archived.defaultCollapsed, true)
    assert.equal(archived.order, 90)
    // 无 Emoji（UI 规范）
    assert.doesNotMatch(JSON.stringify(sections), /\p{Extended_Pictographic}/u)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. assistant MEMORY.md 防线（真实 ProfileService 文件边界）
// ---------------------------------------------------------------------------

interface AssistantEnv {
  profiles: ProfileService
  dataDir: string
  close(): Promise<void>
}

async function makeAssistantEnv(): Promise<AssistantEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-assistant-fix-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  return {
    profiles,
    dataDir,
    async close() {
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('assistant：MEMORY.md 上限常量导出为 64000', { timeout: 60_000 }, () => {
  assert.equal(MAX_MEMORY_CHARS, 64_000)
})

test('assistant：update_memory 超限显式拒绝（append 累计与 replace 直写双路径）', { timeout: 60_000 }, async () => {
  const env = await makeAssistantEnv()
  try {
    const pluginHostBackend = makeControlledBackend()
    const docs = new MemoryDocStore()
    const host = new PluginHost({
      dataDir: env.dataDir,
      host: pluginHostBackend,
      docs,
    })
    const { createAssistantPlugin } = await import('../src/builtin-plugins/assistant.js')
    await host.register(createAssistantPlugin({ profiles: env.profiles, skills: new SkillService(env.dataDir) }), { enabled: true })
    const runUpdate = (input: { text: string; mode: string }) =>
      host.executeTool('update_memory', input, { conversationId: 1 })

    // 1) append 超限：先写接近上限，再追加使总和超限。
    await env.profiles.updateMemory('assistant', 'x'.repeat(MAX_MEMORY_CHARS - 10), 'replace')
    await assert.rejects(
      () => runUpdate({ text: 'y'.repeat(20), mode: 'append' }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'memory_limit_exceeded')
        assert.equal(err.status, 400)
        assert.ok(/replace/.test(err.message), '错误信息应提示用 replace 整理')
        return true
      },
    )
    // 拒绝后文件保持旧值（不写半截）。
    const afterReject = await env.profiles.getMemory('assistant')
    assert.equal(afterReject.length, MAX_MEMORY_CHARS - 10)

    // 2) replace 直写超限：单次 text 即超。
    await assert.rejects(
      () => runUpdate({ text: 'z'.repeat(MAX_MEMORY_CHARS + 1), mode: 'replace' }),
      (err: unknown) => err instanceof HelmError && err.code === 'memory_limit_exceeded',
    )

    // 3) 合法 replace（恰在上限内）成功。
    await runUpdate({ text: 'a'.repeat(MAX_MEMORY_CHARS), mode: 'replace' })
    assert.equal((await env.profiles.getMemory('assistant')).length, MAX_MEMORY_CHARS)
  } finally {
    await env.close()
  }
})

test('assistant：MEMORY.md 被误删时回合按空处理并告警一次（不 500）', { timeout: 60_000 }, async () => {
  const env = await makeAssistantEnv()
  try {
    const backend = makeControlledBackend()
    const docs = new MemoryDocStore()
    const host = new PluginHost({ dataDir: env.dataDir, host: backend, docs })
    const { createAssistantPlugin } = await import('../src/builtin-plugins/assistant.js')
    await host.register(createAssistantPlugin({ profiles: env.profiles, skills: new SkillService(env.dataDir) }), { enabled: true })

    // 外部误删 MEMORY.md（绕过服务层）。
    const memoryPath = join(env.dataDir, 'profiles', 'assistant', 'MEMORY.md')
    assert.ok(existsSync(memoryPath), '前置：默认 MEMORY.md 存在')
    unlinkSync(memoryPath)

    // before_turn：应视为空内容并告警一次，回合 transform 正常返回。
    const turn = {
      conversation: makeConversation(1),
      sections: [{ id: 'base', text: 'base' }],
      tools: [],
      inputs: [],
      messages: [],
    }
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform' || result.action === 'continue', `回合不崩溃（实际 ${result.action}）`)
    const memorySections = (result.action === 'transform' ? result.value.sections : turn.sections).filter(
      (s: { id: string }) => s.id === 'assistant.memory',
    )
    assert.equal(memorySections.length, 0, 'MEMORY.md 缺失按空处理（无 memory section）')
    assert.ok(
      backend.notifications.some((n) => n.title.includes('缺失') || n.title.includes('误删')),
      '应发出文件缺失告警',
    )
  } finally {
    await env.close()
  }
})

test('assistant：存量 MEMORY.md 超限注入时截断并附显式说明', { timeout: 60_000 }, async () => {
  const env = await makeAssistantEnv()
  try {
    // 外部手改绕过 update_memory 防线（模拟历史遗留超限文件）。
    const memoryDir = join(env.dataDir, 'profiles', 'assistant')
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'M'.repeat(MAX_MEMORY_CHARS + 5_000))

    const backend = makeControlledBackend()
    const docs = new MemoryDocStore()
    const host = new PluginHost({ dataDir: env.dataDir, host: backend, docs })
    const { createAssistantPlugin } = await import('../src/builtin-plugins/assistant.js')
    await host.register(createAssistantPlugin({ profiles: env.profiles, skills: new SkillService(env.dataDir) }), { enabled: true })

    const turn = {
      conversation: makeConversation(1),
      sections: [{ id: 'base', text: 'base' }],
      tools: [],
      inputs: [],
      messages: [],
    }
    const result = await host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    const sections = (result as { value: { sections: Array<{ id: string; text: string }> } }).value.sections
    const memory = sections.find((s) => s.id === 'assistant.memory')
    assert.ok(memory !== undefined, '超限仍应注入 memory section')
    assert.ok(memory.text.includes('超过'), '截断应附显式说明')
    assert.ok(memory.text.length <= MAX_MEMORY_CHARS + 500, '注入内容应截断到上限附近（含说明）')
  } finally {
    await env.close()
  }
})
