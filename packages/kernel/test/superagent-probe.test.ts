/**
 * 通用探针与 UI docs 协议回归（builtin:superagent 依赖的机制层契约）。
 *
 * 覆盖：
 * 1. 原生 watchdog tick：probe 携带 targetKind:'conversation' / conversationId /
 *    权威 stateChangeSeq；ownedBy 即时反映 markConversationOwnership；root 恒 human；
 *    getConversationOwnership 公开读取（root human / 未登记 human / 现读持久 doc /
 *    不存在与已删除显式 not_found / 删除后登记清零）。
 * 2. hooks.ts 边界校验：非法探针（负数 stalledMs、非整数 conversationId、
 *    非法枚举 targetKind、空 machine、伪造负 seq、非有限数）显式拒绝，
 *    绝不进入下游钩子。
 * 3. Herdr watchdog tick（priority 100）：targetKind:'external' + machine 归一 local、
 *    成功 agent.get 输出真实权威 seq、unreachable 不伪造 seq 且 consecutiveErrors 递增、
 *    同 machine+pane 同水位停滞递增 / 变水位重置 / 首次观测从 0 起、
 *    两台 machine 同 paneId 仍可区分、facts 含 kind/parentConversationId/pendingAskCount。
 * 4. UI docs 边界：合法 docs 透传进 listUi 快照；非数组 / 空数组 / 非字符串 /
 *    非法文档名 / 重复名 显式 invalid_ui_spec 拒绝。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  HelmError,
  type ConversationSummary,
  type WatchdogProbe,
  type WatchdogTickHookPayload,
} from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { HookPipeline } from '../src/plugins/hooks.js'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import type { HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import type { Profile } from '@helm/protocol'

// ---------------------------------------------------------------------------
// 共享测试基座
// ---------------------------------------------------------------------------

type FauxHandle = ReturnType<typeof fauxProvider>

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    watchdogIntervalMs: 0,
  })
  return Object.assign(runtime, { __faux: faux })
}

test('关闭内核后拒绝新输入，结算回调不能重新启动模型回合', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-shutdown-input-'))
  const kernel = await openRuntime(root)
  try {
    assert.equal(kernel.isClosing, false)
    await kernel.close()
    assert.equal(kernel.isClosing, true)
    await assert.rejects(
      kernel.submitInput(1, '关停期间的后台汇报', { origin: 'agent' }),
      (error: unknown) => error instanceof HelmError && error.code === 'runtime_closed',
    )
  } finally {
    try { await kernel.close() } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

// ---------------------------------------------------------------------------
// 1. 原生 tick：权威 seq / ownership 即时更改 / root human
// ---------------------------------------------------------------------------

test('native tick：probe 携带 targetKind/conversationId/权威 stateChangeSeq；ownership 即时更改；root 恒 human', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-probe-native-'))
  const kernel = await openRuntime(join(root, 'k1'))
  try {
    // 用户直连会话（未登记）：human。
    const manual = await kernel.createConversation({})
    // spawn 子会话：自动 helm 归属。
    kernel.__faux.setResponses([fauxAssistantMessage('worker 完成')])
    let childId: number | undefined
    await kernel.spawnAgent({
      parentConversationId: 1,
      prompt: '干活',
      onResolved: (info) => {
        childId = info.conversationId
      },
    })
    assert.ok(childId !== undefined)

    const tick1 = (await kernel.watchdogTick()) as WatchdogTickHookPayload
    const rootProbe = tick1.probes.find((p) => p.targetId === '1')
    const childProbe = tick1.probes.find((p) => p.targetId === String(childId))
    const manualProbe = tick1.probes.find((p) => p.targetId === String(manual.id))
    // root：恒 human + 原生目标字段齐全。
    assert.ok(rootProbe)
    assert.equal(rootProbe.targetKind, 'conversation')
    assert.equal(rootProbe.conversationId, 1)
    assert.equal(rootProbe.ownedBy, 'human')
    assert.equal(typeof rootProbe.stateChangeSeq, 'number')
    assert.ok(rootProbe.stateChangeSeq! >= 0)
    // spawn 子会话：helm。
    assert.ok(childProbe)
    assert.equal(childProbe.targetKind, 'conversation')
    assert.equal(childProbe.conversationId, childId)
    assert.equal(childProbe.ownedBy, 'helm')
    // 权威 seq 与会话摘要一致（不猜造）。
    const childSummary = kernel.getConversation(childId)
    assert.equal(childProbe.stateChangeSeq, childSummary.stateChangeSeq)
    // 用户直连：human。
    assert.ok(manualProbe)
    assert.equal(manualProbe.ownedBy, 'human')

    // 即时更改：manual 标记 bot 后下一 tick 立即生效。
    kernel.markConversationOwnership(manual.id, 'bot')
    const tick2 = (await kernel.watchdogTick()) as WatchdogTickHookPayload
    assert.equal(
      tick2.probes.find((p) => p.targetId === String(manual.id))?.ownedBy,
      'bot',
      'markConversationOwnership 即时生效',
    )
    // 同一 tick 内 stateChangeSeq 与摘要一致（权威现读，非缓存）。
    const manual2 = tick2.probes.find((p) => p.targetId === String(manual.id))!
    assert.equal(manual2.stateChangeSeq, kernel.getConversation(manual.id).stateChangeSeq)
  } finally {
    await kernel.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('getConversationOwnership：root human / 未登记 human / 现读持久登记 / 不存在与已删除显式 not_found / 删除清残留', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-probe-own-'))
  const kernel = await openRuntime(join(root, 'k1'))
  try {
    assert.equal(kernel.getConversationOwnership(1), 'human', 'root 恒 human')
    const conv = await kernel.createConversation({})
    assert.equal(kernel.getConversationOwnership(conv.id), 'human', '未登记 human')
    kernel.markConversationOwnership(conv.id, 'bot')
    assert.equal(kernel.getConversationOwnership(conv.id), 'bot', '现读持久登记')
    kernel.markConversationOwnership(conv.id, 'human')
    assert.equal(kernel.getConversationOwnership(conv.id), 'human', '改回 human 后回落默认')

    // 不存在：显式 not_found（不猜造，不把未知目标当授权对象）。
    await assert.throws(
      () => kernel.getConversationOwnership(999_999),
      (err: unknown) => err instanceof HelmError && (err as HelmError).status === 404,
    )

    // 已删除：登记必须清零，绝不能把残留登记当可执行授权。
    kernel.markConversationOwnership(conv.id, 'helm')
    await kernel.deleteConversation(conv.id)
    await assert.throws(
      () => kernel.getConversationOwnership(conv.id),
      (err: unknown) => err instanceof HelmError && (err as HelmError).status === 404,
      '已删除会话归属读取必须显式 not_found',
    )
  } finally {
    await kernel.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. hooks.ts 边界校验：非法探针不进入下游
// ---------------------------------------------------------------------------

function makeSummary(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: '',
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

function makeTickPayload(probes: WatchdogProbe[]): WatchdogTickHookPayload {
  return { timestamp: Date.now(), conversations: [makeSummary(1)], probes }
}

const validProbe: WatchdogProbe = {
  targetId: '7',
  targetKind: 'conversation',
  conversationId: 7,
  ownedBy: 'helm',
  status: 'working',
  stateChangeSeq: 3,
  stalledMs: 1_000,
  consecutiveErrors: 0,
  facts: { doing: 'x' },
}

test('非法探针在管道入口即拒绝（invalid_hook_result），不进入下游处理器', { timeout: 60_000 }, async () => {
  const invalid: WatchdogProbe[] = [
    { ...validProbe, targetKind: 'session' as never }, // 非法枚举
    { ...validProbe, conversationId: 0 }, // 非正整数
    { ...validProbe, conversationId: 2.5 }, // 非整数
    { ...validProbe, machine: '' }, // 空字符串
    { ...validProbe, stateChangeSeq: -1 }, // 负 seq
    { ...validProbe, stateChangeSeq: 1.5 }, // 非整数 seq
    { ...validProbe, stalledMs: -100 }, // 负停滞
    { ...validProbe, stalledMs: Number.POSITIVE_INFINITY }, // 非有限数
    { ...validProbe, consecutiveErrors: -1 }, // 负连续错误
    { ...validProbe, consecutiveErrors: Number.NaN }, // NaN
    { ...validProbe, facts: null as never }, // facts 非对象
  ]
  for (const probe of invalid) {
    const pipeline = new HookPipeline<'watchdog_tick'>('watchdog_tick')
    let downstreamCalled = false
    pipeline.add('p:down', () => {
      downstreamCalled = true
    })
    await assert.rejects(
      () => pipeline.run(makeTickPayload([probe])),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_hook_result',
      `探针 ${JSON.stringify(probe)} 必须被边界拒绝`,
    )
    assert.equal(downstreamCalled, false, '非法载荷绝不进入下游')
  }
})

test('合法探针（含可选字段缺省与全部新字段）通过边界并到达下游', { timeout: 60_000 }, async () => {
  // 缺省可选字段（旧形状探针）仍合法。
  const legacy: WatchdogProbe = { targetId: '1', ownedBy: 'human', status: 'idle' }
  // 全字段外部探针。
  const external: WatchdogProbe = {
    targetId: 'w:p1',
    targetKind: 'external',
    machine: 'build-01',
    ownedBy: 'helm',
    status: 'blocked',
    stateChangeSeq: 9,
    stalledMs: 0,
    facts: { kind: 'herdr', parentConversationId: 3, pendingAskCount: 1 },
  }
  const pipeline = new HookPipeline<'watchdog_tick'>('watchdog_tick')
  let received: WatchdogTickHookPayload | undefined
  pipeline.add('p:down', (payload) => {
    received = payload
  })
  const { finalPayload } = await pipeline.run(makeTickPayload([legacy, external]))
  assert.ok(received)
  assert.equal(finalPayload.probes.length, 2)
  assert.equal(finalPayload.probes[1]!.machine, 'build-01')
  assert.equal(finalPayload.probes[1]!.stateChangeSeq, 9)
})

test('transform 破坏探针字段同样拒绝（transform 后复验）', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'watchdog_tick'>('watchdog_tick')
  pipeline.add('p:bad', () => ({
    action: 'transform' as const,
    value: makeTickPayload([{ ...validProbe, stateChangeSeq: -5 }]),
  }))
  await assert.rejects(
    () => pipeline.run(makeTickPayload([validProbe])),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_hook_result',
  )
})

// ---------------------------------------------------------------------------
// 3. Herdr watchdog tick（priority 100）
// ---------------------------------------------------------------------------

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface FakePane {
  paneId: string
  tabId?: string
  agentStatus: PaneStatus
  seq: number
  name: string
  cwd: string
}

/** 受控 transport：仅实现 watchdog tick 用到的 agent.get / events.subscribe / session.snapshot。 */
class ProbeFakeTransport implements HerdrTransport {
  /** 本机分桶（machine === undefined）。 */
  panes = new Map<string, FakePane>()
  /** 远端分桶（machine 名 -> paneId -> 权威）。 */
  remotePanes = new Map<string, Map<string, FakePane>>()
  failAgentGet = false
  calls: Array<{ target: HerdrTarget; method: string }> = []
  notified: Array<{ title: string; body: string }> = []

  constructor(notified: Array<{ title: string; body: string }>) {
    this.notified = notified
  }

  private bucketOf(target: HerdrTarget): Map<string, FakePane> {
    if (target.machine === undefined) return this.panes
    let bucket = this.remotePanes.get(target.machine)
    if (bucket === undefined) {
      bucket = new Map()
      this.remotePanes.set(target.machine, bucket)
    }
    return bucket
  }

  private agentInfoOf(pane: FakePane) {
    return {
      pane_id: pane.paneId,
      tab_id: pane.tabId ?? `t-${pane.paneId}`,
      workspace_id: 'w',
      name: pane.name,
      agent_status: pane.agentStatus,
      interactive_ready: true,
      state_change_seq: pane.seq,
      cwd: pane.cwd,
    }
  }

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method })
    const bucket = this.bucketOf(target)
    if (method === 'agent.get') {
      if (this.failAgentGet) throw new HelmError('herdr_unavailable', 'socket down', 503)
      const pane = bucket.get(String(params['target']))
      if (!pane) throw new HelmError('agent_not_found', 'no pane', 404)
      return { type: 'agent_info', agent: this.agentInfoOf(pane) }
    }
    if (method === 'session.snapshot') {
      return {
        type: 'session_snapshot',
        snapshot: {
          version: 'test',
          protocol: 22,
          workspaces: [],
          tabs: [],
          panes: [...bucket.values()].map((p) => ({
            pane_id: p.paneId,
            tab_id: p.tabId ?? `t-${p.paneId}`,
            workspace_id: 'w',
            focused: false,
            agent_status: p.agentStatus,
            cwd: p.cwd,
          })),
          layouts: [],
          agents: [...bucket.values()].map((p) => this.agentInfoOf(p)),
        },
      }
    }
    return { type: 'ok' }
  }
  async readOutput(): Promise<string> {
    throw new HelmError('unsupported', 'probe test', 400)
  }
  async removeOutput(): Promise<void> {}
  async runGate() {
    return { ok: true, output: '' }
  }
  async subscribe(
    _target: HerdrTarget,
    _onEvent: (event: never) => void,
    _onError: (error: unknown) => void,
  ): Promise<() => void> {
    return () => {}
  }
}

class ProbeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  notifications: Array<{ title: string; body: string; level: string }> = []
  constructor() {
    this.conversations.set(1, makeSummary(1))
    this.conversations.set(3, makeSummary(3))
  }
  dispatchTrigger(): Promise<void> {
    return Promise.resolve()
  }
  submitInput(): Promise<void> {
    return Promise.resolve()
  }
  createConversation(): Promise<ConversationSummary> {
    return Promise.resolve(makeSummary(99))
  }
  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()]
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id))
  }
  manageConversation(): () => void {
    return () => {}
  }
  markConversationOwnership(): void {}
  async createAsk(): Promise<never> {
    throw new HelmError('unsupported', 'probe test', 400)
  }
  async cancelAsk(): Promise<void> {}
  registerAskSeqResolver(): () => void {
    return () => {}
  }
  onWorkflowSettled(): () => void {
    return () => {}
  }
  emitEvent(type: string, payload: unknown): void {
    if (type === 'notification') {
      const n = payload as { title: string; body: string; level: string }
      this.notifications.push(n)
    }
  }
}

class ProbeDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
}

interface ProbeEnv {
  host: PluginHost
  backend: ProbeBackend
  transport: ProbeFakeTransport
  close(): Promise<void>
}

async function makeProbeEnv(
  managedPanes: Array<{
    machine?: string
    paneId: string
    agentName: string
    cwd: string
    status?: PaneStatus
    seq?: number
  }>,
): Promise<ProbeEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-probe-'))
  const backend = new ProbeBackend()
  const docs = new ProbeDocStore()
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: managedPanes.map((p) => ({
      target: p.machine !== undefined ? { machine: p.machine } : {},
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
  const transport = new ProbeFakeTransport(backend.notifications)
  // 权威分桶必须在 register（对账）前就绪：对账时会现查 session.snapshot；
  // 远端记录进对应 machine 分桶（本机 machine -> undefined 分桶）。
  for (const p of managedPanes) {
    const entry: FakePane = {
      paneId: p.paneId,
      agentStatus: p.status ?? 'working',
      seq: p.seq ?? 1,
      name: p.agentName,
      cwd: p.cwd,
    }
    if (p.machine === undefined) {
      transport.panes.set(p.paneId, entry)
    } else {
      const bucket = transport.remotePanes.get(p.machine) ?? new Map()
      bucket.set(p.paneId, entry)
      transport.remotePanes.set(p.machine, bucket)
    }
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs,
  })
  await host.register(
    createHerdrPlugin({
      defaultCwd: '/tmp',
      profiles: { get: async () => undefined as Profile | undefined },
      buildSpawnEnv: () => ({}),
      redact: (t: string) => t,
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

async function runHerdrTick(env: ProbeEnv): Promise<WatchdogProbe[]> {
  const payload: WatchdogTickHookPayload = {
    timestamp: Date.now(),
    conversations: [],
    probes: [],
  }
  await env.host.runHook('watchdog_tick', payload)
  if (payload.probes.length === 0) {
    // 诊断：对账可能把 pane 判为 settled，附通知尾部，绝不静默断言失败。
    assert.fail(
      `watchdog tick 产出 0 个 probe（pane 可能被对账误判 settled）：${JSON.stringify({ panes: [...env.transport.panes.values()], notifications: env.backend.notifications })}`,
    )
  }
  return payload.probes
}

test('Herdr tick：targetKind external + machine 归一 local + 权威 seq + facts 齐全', { timeout: 60_000 }, async () => {
  const env = await makeProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    const probes = await runHerdrTick(env)
    assert.equal(probes.length, 1)
    const probe = probes[0]!
    assert.equal(probe.targetKind, 'external')
    assert.equal(probe.machine, 'local', '本机 pane machine 归一为 local')
    assert.equal(probe.targetId, 'w:p1')
    assert.equal(probe.ownedBy, 'helm')
    assert.equal(probe.status, 'working')
    assert.equal(probe.stateChangeSeq, 5, '成功 agent.get 输出真实权威 seq')
    assert.equal(probe.stalledMs, 0, '首次观测从 0 起')
    const facts = probe.facts as Record<string, unknown>
    assert.equal(facts['kind'], 'herdr')
    assert.equal(facts['parentConversationId'], 3)
    assert.equal(facts['pendingAskCount'], 0)
    assert.equal(facts['agentName'], 'helm-wf-a')
  } finally {
    await env.close()
  }
})

test('Herdr tick：同名 Agent 换至其他 tab 后不再投射自动化归属', { timeout: 60_000 }, async () => {
  const env = await makeProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    env.transport.panes.get('w:p1')!.tabId = 'human-tab'
    const payload: WatchdogTickHookPayload = { timestamp: Date.now(), conversations: [], probes: [] }
    await env.host.runHook('watchdog_tick', payload)
    assert.deepEqual(payload.probes, [])
    assert.equal(env.transport.calls.some((call) => call.method === 'tab.close'), false)
  } finally {
    await env.close()
  }
})

test('Herdr tick：两台 machine 同 paneId 仍可区分（machine + targetId 复合寻址）', { timeout: 60_000 }, async () => {
  // 同 paneId 两台 machine：受控 transport 按 target.machine 分桶提供权威
  //（本机分桶不可达、远端分桶正常），验证探针凭 machine + targetId 复合区分。
  const env = await makeProbeEnv([
    { paneId: 'w:p9', agentName: 'helm-wf-local', cwd: '/tmp/l', status: 'working', seq: 1 },
    { machine: 'build-01', paneId: 'w:p9', agentName: 'helm-wf-remote', cwd: '/tmp/r', status: 'working', seq: 2 },
  ])
  try {
    const origCall = env.transport.call.bind(env.transport)
    env.transport.call = async (target, method, params) => {
      // 本机分桶模拟 socket 分区（不可达）；远端分桶正常返回。
      if (method === 'agent.get' && target.machine === undefined) {
        throw new HelmError('herdr_unavailable', 'local down', 503)
      }
      return origCall(target, method, params)
    }
    const probes = await runHerdrTick(env)
    assert.equal(probes.length, 2, '两台 machine 同 paneId 各产生一个 probe')
    const local = probes.find((p) => p.machine === 'local' && p.targetId === 'w:p9')!
    const remote = probes.find((p) => p.machine === 'build-01' && p.targetId === 'w:p9')!
    assert.ok(local && remote, '两个 probe 均存在且可区分')
    assert.equal(local.status, 'unreachable')
    assert.equal(local.stateChangeSeq, undefined, 'unreachable 绝不伪造权威 seq')
    assert.equal(local.consecutiveErrors, 1)
    assert.equal(remote.status, 'working')
    assert.equal(remote.stateChangeSeq, 2)
    assert.equal((remote.facts as Record<string, unknown>)['agentName'], 'helm-wf-remote')
  } finally {
    await env.close()
  }
})

test('Herdr tick：同水位停滞递增、变水位重置、unreachable 保持水位累计不伪造 seq', { timeout: 60_000 }, async () => {
  const env = await makeProbeEnv([{ paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 4 }])
  try {
    // 首次观测：0。
    const first = (await runHerdrTick(env))[0]!
    assert.equal(first.stalledMs, 0)

    // 同水位第二次：停滞 > 0 且随时间递增（不是总运行时长，也非每次重置为 0）。
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = (await runHerdrTick(env))[0]!
    assert.ok(second.stalledMs! >= 25, `同水位停滞递增（实际 ${second.stalledMs}）`)
    assert.equal(second.stateChangeSeq, 4)

    // 再等更久：停滞继续递增。
    await new Promise((resolve) => setTimeout(resolve, 40))
    const third = (await runHerdrTick(env))[0]!
    assert.ok(third.stalledMs! > second.stalledMs!, '停滞随时间单调递增')

    // unreachable：保持旧水位继续累计（不重置、不归零），不伪造 seq。
    env.transport.failAgentGet = true
    const unreachable = (await runHerdrTick(env))[0]!
    assert.equal(unreachable.status, 'unreachable')
    assert.equal(unreachable.stateChangeSeq, undefined, '失败探测不输出权威 seq')
    assert.ok(unreachable.stalledMs! >= third.stalledMs!, 'unreachable 停滞继续累计（不因失败重置）')
    assert.equal(unreachable.consecutiveErrors, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const unreachable2 = (await runHerdrTick(env))[0]!
    assert.equal(unreachable2.consecutiveErrors, 2, '连续失败计数递增')
    assert.ok(unreachable2.stalledMs! > unreachable.stalledMs!)

    // 恢复且水位推进：重置为 0。
    env.transport.failAgentGet = false
    env.transport.panes.get('w:p1')!.seq = 5
    env.transport.panes.get('w:p1')!.agentStatus = 'blocked'
    const afterChange = (await runHerdrTick(env))[0]!
    assert.equal(afterChange.stateChangeSeq, 5)
    assert.equal(afterChange.status, 'blocked')
    assert.equal(afterChange.stalledMs, 0, '水位/状态变化重置停滞')
    assert.equal(afterChange.consecutiveErrors, undefined, '成功探测清零失败计数（缺省不输出）')

    // 同 seq 仅状态变化（unreachable -> unreachable 之外的真实场景：
    // 状态翻转但 seq 未推进）：同样重置（状态变化也是进展证据）。
    await new Promise((resolve) => setTimeout(resolve, 25))
    const same1 = (await runHerdrTick(env))[0]!
    assert.ok(same1.stalledMs! >= 20)
    env.transport.panes.get('w:p1')!.agentStatus = 'idle' // 状态变化，seq 不变
    const same2 = (await runHerdrTick(env))[0]!
    assert.equal(same2.stalledMs, 0, '状态变化（同 seq）同样重置停滞')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. UI docs 边界
// ---------------------------------------------------------------------------

class UiBackend extends ProbeBackend {}

async function makeUiHost(): Promise<{ host: PluginHost; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ui-docs-'))
  const host = new PluginHost({
    dataDir,
    host: new UiBackend(),
    docs: new ProbeDocStore(),
  })
  return { host, dataDir }
}

test('UI docs：合法 docs 进入 listUi 快照；声明同名 public doc 正常共存', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await makeUiHost()
  try {
    await host.register({
      id: 'test:docs-ok',
      definePlugin(ctx) {
        ctx.doc('overview', { version: 1 }, { public: true })
        ctx.ui.screen({ id: 'main', label: '主视图', docs: ['overview'] })
        ctx.ui.workbenchPanel({ id: 'plain', label: '无 docs 面板' })
      },
    })
    const ui = host.listUi()
    const screen = ui.find((u) => u.surface === 'screen')!
    assert.ok(screen)
    assert.deepEqual((screen.spec as { docs?: string[] }).docs, ['overview'])
    // 无 docs 声明不受影响。
    const panel = ui.find((u) => u.surface === 'workbench.panel')!
    assert.equal((panel.spec as { docs?: string[] }).docs, undefined)
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('UI docs：非数组 / 空数组 / 非字符串项 / 非法文档名 / 重复名 显式拒绝', { timeout: 60_000 }, async () => {
  const cases: Array<{ label: string; docs: unknown }> = [
    { label: '非数组', docs: 'overview' },
    { label: '对象冒充', docs: { 0: 'overview', length: 1 } },
    { label: '空数组', docs: [] },
    { label: '非字符串项', docs: ['overview', 42] },
    { label: '空字符串名', docs: [''] },
    { label: '非法文档名字符', docs: ['over view!'] },
    { label: '路径穿越名', docs: ['../evil'] },
    { label: '重复名', docs: ['overview', 'overview'] },
  ]
  for (const c of cases) {
    const { host, dataDir } = await makeUiHost()
    try {
      await assert.rejects(
        () =>
          host.register({
            id: 'test:docs-bad',
            definePlugin(ctx) {
              ctx.ui.screen({ id: 'main', label: '主视图', docs: c.docs as string[] })
            },
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
        `docs=${JSON.stringify(c.docs)} 必须被拒绝（${c.label}）`,
      )
      // 注册失败必须零残留。
      assert.equal(host.listUi().length, 0)
    } finally {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
})

test('UI docs：多扩展点同名校验一致（sidebarItem 带 docs 同样走边界）', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await makeUiHost()
  try {
    await assert.rejects(
      () =>
        host.register({
          id: 'test:docs-sidebar',
          definePlugin(ctx) {
            ctx.ui.sidebarItem({ id: 'nav', label: '导航', docs: [123] as unknown as string[] })
          },
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
    )
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
