/**
 * 通用探针与 UI docs 协议回归（builtin:superagent 依赖的机制层契约）。
 *
 * 覆盖：
 * 1. 原生 watchdog tick：probe 携带 targetKind:'conversation' / conversationId /
 *    权威 stateChangeSeq；ownedBy 即时反映 markConversationOwnership；root 恒 human；
 *    getConversationOwnership 公开读取（root human / 未登记 human / 现读持久 doc /
 *    不存在与已删除显式 not_found / 删除后登记清零）。
 * 2. hooks.ts 边界校验：非法探针（负数 stalledMs、非整数 conversationId、
 *    非法枚举 targetKind、空 nodeId、伪造负 seq、非有限数）显式拒绝，
 *    绝不进入下游钩子。
 * 3. Herdr watchdog tick（priority 100）：targetKind:'external' + nodeId 归一 local、
 *    成功 agent.get 输出真实权威 seq、unreachable 不伪造 seq 且 consecutiveErrors 递增、
 *    同 nodeId+pane 同水位停滞递增 / 变水位重置 / 首次观测从 0 起、
 *    两个节点同 paneId 仍可区分、facts 含 kind/parentConversationId/pendingAskCount。
 * 4. UI docs 边界：合法 docs 透传进 listUi 快照；非数组 / 空数组 / 非字符串 /
 *    非法文档名 / 重复名 显式 invalid_ui_spec 拒绝。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  HelmError,
  type ConversationSummary,
} from '@helm/protocol'
import {
  appendProbes,
  collectionViolation,
  type DiagnosticsCollection,
  type WatchdogProbe,
} from '../src/builtin-plugins/diagnostics.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import { ipcLineCall, serveTransport } from './helpers/herdr-unit-fixture.js'
import type { HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import type { HelmHostNodeIpcPort, RpcResult } from '@helm/protocol'

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

test('原生事实端口：getConversationOwnership/getConversationActivity 现读真实事实（探针构造同源）', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-probe-native-'))
  const kernel = await openRuntime(join(root, 'k1'))
  try {
    // 用户直连会话（未登记）：human；spawn 子会话：自动 helm 归属。
    const manual = await kernel.createConversation({})
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

    // 归属权事实由 getConversationOwnership 现读（superagent 探针构造同源端口）。
    assert.equal(kernel.getConversationOwnership(1), 'human', 'root 恒 human')
    assert.equal(kernel.getConversationOwnership(manual.id), 'human', '用户直连默认 human')
    assert.equal(kernel.getConversationOwnership(childId), 'helm', 'spawn 子会话自动 helm')
    // 活动事实端口：空闲会话无停滞、有连续错误计数（结构真实）。
    const activity = kernel.getConversationActivity(childId)
    assert.equal(activity.consecutiveErrors, 0)
    assert.ok(activity.stalledMs === undefined, '空闲会话不报停滞（idle 非停滞）')

    // 即时更改：manual 标记 bot 后端口现读立即生效。
    kernel.markConversationOwnership(manual.id, 'bot')
    assert.equal(kernel.getConversationOwnership(manual.id), 'bot', 'markConversationOwnership 即时生效')
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

function makeTickPayload(probes: WatchdogProbe[]): DiagnosticsCollection {
  return { timestamp: Date.now(), conversations: [{ id: 1, profileId: 'assistant' }], probes }
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

test('非法探针在采集边界即拒绝（invalid_diagnostics_probe），不进入追加', { timeout: 60_000 }, async () => {
  const invalid: WatchdogProbe[] = [
    { ...validProbe, targetKind: 'session' as never }, // 非法枚举
    { ...validProbe, conversationId: 0 }, // 非正整数
    { ...validProbe, conversationId: 2.5 }, // 非整数
    { ...validProbe, nodeId: '' }, // 空字符串
    { ...validProbe, stateChangeSeq: -1 }, // 负 seq
    { ...validProbe, stateChangeSeq: 1.5 }, // 非整数 seq
    { ...validProbe, stalledMs: -100 }, // 负停滞
    { ...validProbe, stalledMs: Number.POSITIVE_INFINITY }, // 非有限数
    { ...validProbe, consecutiveErrors: -1 }, // 负连续错误
    { ...validProbe, consecutiveErrors: Number.NaN }, // NaN
    { ...validProbe, facts: null as never }, // facts 非对象
  ]
  for (const probe of invalid) {
    const collection: DiagnosticsCollection = makeTickPayload([validProbe])
    let appended = false
    assert.throws(
      () => {
        appendProbes(collection, [probe])
        appended = true
      },
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_diagnostics_probe',
      `探针 ${JSON.stringify(probe)} 必须被采集边界拒绝`,
    )
    assert.equal(appended, false, '非法探针绝不进入 collection')
    assert.equal(collection.probes.length, 1, '原集合不受污染')
  }
})

test('合法探针（含可选字段缺省与全部新字段）通过采集边界', { timeout: 60_000 }, async () => {
  // 缺省可选字段（最小形状探针）合法。
  const legacy: WatchdogProbe = { targetId: '1', ownedBy: 'human', status: 'idle' }
  // 全字段外部探针。
  const external: WatchdogProbe = {
    targetId: 'w:p1',
    targetKind: 'external',
    nodeId: 'build-01',
    ownedBy: 'helm',
    status: 'blocked',
    stateChangeSeq: 9,
    stalledMs: 0,
    facts: { kind: 'herdr', parentConversationId: 3, pendingAskCount: 1 },
  }
  const collection = makeTickPayload([legacy])
  appendProbes(collection, [external])
  assert.equal(collection.probes.length, 2)
  assert.equal(collection.probes[1]!.nodeId, 'build-01')
  assert.equal(collection.probes[1]!.stateChangeSeq, 9)
})

test('collection 整体形状校验：timestamp/conversations/probes 非法显式拒绝', { timeout: 60_000 }, async () => {
  const base = makeTickPayload([])
  assert.ok(collectionViolation({ ...base, timestamp: -1 }) !== null)
  assert.ok(collectionViolation({ ...base, conversations: [{ id: 0, profileId: 'x' }] as never }) !== null)
  assert.ok(collectionViolation({ ...base, conversations: 'x' as never }) !== null)
  assert.ok(collectionViolation({ ...base, probes: 'x' as never }) !== null)
  assert.ok(collectionViolation(null) !== null)
  assert.equal(collectionViolation(base), null, '合法 collection 通过')
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
  /** 本机分桶（nodeId === undefined）。 */
  panes = new Map<string, FakePane>()
  /** 远端分桶（nodeId 名 -> paneId -> 权威）。 */
  remotePanes = new Map<string, Map<string, FakePane>>()
  failAgentGet = false
  calls: Array<{ target: HerdrTarget; method: string }> = []
  notified: Array<{ title: string; body: string }> = []

  constructor(notified: Array<{ title: string; body: string }>) {
    this.notified = notified
  }

  private bucketOf(target: HerdrTarget): Map<string, FakePane> {
    if (target.nodeId === undefined) return this.panes
    let bucket = this.remotePanes.get(target.nodeId)
    if (bucket === undefined) {
      bucket = new Map()
      this.remotePanes.set(target.nodeId, bucket)
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
  /** 内部事件监听注册表（模拟 runtime.emitHostEvent broadcast:false 分发）。 */
  private listeners = new Map<string, Array<(payload: unknown) => Promise<void>>>()
  profiles = {
    list: async () => [],
    get: async () => undefined,
    getSystem: async () => { throw new HelmError('not_found', '无 SYSTEM.md', 404) },
    save: async () => { throw new HelmError('unsupported', 'fixture 只读', 501) },
    directory: async (id: string) => `/tmp/probe-fixture-profiles/${id}`,
  }
  skills = {
    list: async () => [],
    readFile: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
    directory: async (id: string) => `/tmp/probe-fixture-skills/${id}`,
    ensureSkill: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
  }
  secrets = {
    get: async () => undefined,
    set: async () => { throw new HelmError('unsupported', 'fixture 只读 secrets', 501) },
    delete: async () => { throw new HelmError('unsupported', 'fixture 只读 secrets', 501) },
    addRedaction: () => () => {},
  }
  setPluginConfig(): Promise<void> { return Promise.resolve() }
  nodeIpc: HelmHostNodeIpcPort | undefined = undefined
  redact(text: string): string { return text }
  redactText(text: string): string { return text }
  buildSpawnEnv(): Record<string, string> { return {} }
  async getConversationDetail(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无详情', 501) }
  async listArtifacts(): Promise<never[]> { return [] }
  async getArtifact(): Promise<never> { throw new HelmError('not_found', '无产物', 404) }
  async completeText(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型', 501) }
  executionEnv(): never { throw new HelmError('unsupported', '本 fixture 无执行环境', 501) }
  withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() }
  async atomicWriteFile(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无原子写', 501) }
  async refreshModels(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async probeNodeFs(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不探测节点 fs', 501) }
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
  onEvent(type: string, listener: (payload: unknown) => unknown): () => void {
    const list = this.listeners.get(type) ?? []
    list.push(listener as (payload: unknown) => Promise<void>)
    this.listeners.set(type, list)
    return () => {
      const cur = this.listeners.get(type) ?? []
      const idx = cur.indexOf(listener as (payload: unknown) => Promise<void>)
      if (idx >= 0) cur.splice(idx, 1)
    }
  }
  async abortConversation(): Promise<void> {}
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human'
  }
  isClosing(): boolean {
    return false
  }
  async spawnAgent(): Promise<unknown> {
    return {}
  }
  async runGate(): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: '' }
  }
  async prepareInterruptedConversations(): Promise<void> {}
  async invokeAction(): Promise<unknown> {
    return {}
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  async execEnv(): Promise<import('@helm/protocol').EnvExecResponse> {
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  listActions(): [] {
    return []
  }
  async emitEvent(type: string, payload: unknown): Promise<void> {
    if (type === 'notification') {
      const n = payload as { title: string; body: string; level: string }
      this.notifications.push(n)
    }
    if (type === 'diagnostics.collect') {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        await listener(payload)
      }
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
  async flush(): Promise<void> {}
}

interface ProbeEnv {
  host: PluginHost
  backend: ProbeBackend
  transport: ProbeFakeTransport
  close(): Promise<void>
}

async function makeProbeEnv(
  managedPanes: Array<{
    nodeId?: string
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
      // 本机 managed 记录必须显式携带 socketPath：插件把 config.socketPath 冻结为
      // 本机连接目标，但逐窗格调用按各自 target 路由——缺 socketPath 时
      // resolveSocketPath 回退继承环境（HERDR_SOCKET_PATH），读到开发机真实
      // herdr 会话，对账必然把受控 pane 误判 settled（0 probe 的根因）。
      target: p.nodeId !== undefined ? { nodeId: p.nodeId } : { socketPath: join(dataDir, 'herdr.sock') },
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
  // 远端记录进对应 nodeId 分桶（本机 nodeId -> undefined 分桶）。
  for (const p of managedPanes) {
    const entry: FakePane = {
      paneId: p.paneId,
      agentStatus: p.status ?? 'working',
      seq: p.seq ?? 1,
      name: p.agentName,
      cwd: p.cwd,
    }
    if (p.nodeId === undefined) {
      transport.panes.set(p.paneId, entry)
    } else {
      const bucket = transport.remotePanes.get(p.nodeId) ?? new Map()
      bucket.set(p.paneId, entry)
      transport.remotePanes.set(p.nodeId, bucket)
    }
  }
  // 受控协议服务器：零参插件的生产 transport 经插件配置 socketPath 直连。
  const socketPath = join(dataDir, 'herdr.sock')
  // 帧路由：远端单行 IPC 请求期间指向目标 nodeId，其余时间归位本机 socket
  //（serveTransport 经 targetOf 感知，把帧分发进对应分桶，与真实 EnvFabric 同构）。
  let routedNodeId: string | undefined
  const served = await serveTransport(transport, socketPath, () =>
    routedNodeId !== undefined && routedNodeId !== 'local' ? { nodeId: routedNodeId } : {},
  )
  backend.nodeIpc = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    call: async (nodeId, input, signal): Promise<RpcResult<string>> => {
      routedNodeId = nodeId
      try {
        return await ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
      } finally {
        routedNodeId = undefined
      }
    },
    subscribe: async () => {
      throw new HelmError('unsupported', '本 fixture 不承载远端 IPC 订阅', 501)
    },
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs,
    config: new (class {
      get(): Record<string, unknown> { return { socketPath } }
      set(): void {}
    })(),
  })
  await host.register(createHerdrPlugin(), { enabled: true })
  return {
    host,
    backend,
    transport,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function runHerdrTick(env: ProbeEnv): Promise<WatchdogProbe[]> {
  const payload: DiagnosticsCollection = {
    timestamp: Date.now(),
    conversations: [],
    probes: [],
  }
  // 真实链路：superagent 侧同款采集事件分发（herdr 监听器追加探针）。
  await env.backend.emitEvent('diagnostics.collect', payload)
  if (payload.probes.length === 0) {
    // 诊断：对账可能把 pane 判为 settled，附通知尾部，绝不静默断言失败。
    assert.fail(
      `watchdog tick 产出 0 个 probe（pane 可能被对账误判 settled）：${JSON.stringify({ panes: [...env.transport.panes.values()], notifications: env.backend.notifications })}`,
    )
  }
  return payload.probes
}

test('Herdr tick：targetKind external + nodeId 归一 local + 权威 seq + facts 齐全', { timeout: 60_000 }, async () => {
  const env = await makeProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    const probes = await runHerdrTick(env)
    assert.equal(probes.length, 1)
    const probe = probes[0]!
    assert.equal(probe.targetKind, 'external')
    assert.equal(probe.nodeId, 'local', '本机 pane nodeId 归一为 local')
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
    const payload: DiagnosticsCollection = { timestamp: Date.now(), conversations: [], probes: [] }
    await env.backend.emitEvent('diagnostics.collect', payload)
    assert.deepEqual(payload.probes, [])
    assert.equal(env.transport.calls.some((call) => call.method === 'tab.close'), false)
  } finally {
    await env.close()
  }
})

test('Herdr tick：两个节点同 paneId 仍可区分（nodeId + targetId 复合寻址）', { timeout: 60_000 }, async () => {
  // 同 paneId 两个节点：受控 transport 按 target.nodeId 分桶提供权威
  //（本机分桶不可达、远端分桶正常），验证探针凭 nodeId + targetId 复合区分。
  const env = await makeProbeEnv([
    { paneId: 'w:p9', agentName: 'helm-wf-local', cwd: '/tmp/l', status: 'working', seq: 1 },
    { nodeId: 'build-01', paneId: 'w:p9', agentName: 'helm-wf-remote', cwd: '/tmp/r', status: 'working', seq: 2 },
  ])
  try {
    const origCall = env.transport.call.bind(env.transport)
    env.transport.call = async (target, method, params) => {
      // 本机分桶模拟 socket 分区（不可达）；远端分桶正常返回。
      if (method === 'agent.get' && target.nodeId === undefined) {
        throw new HelmError('herdr_unavailable', 'local down', 503)
      }
      return origCall(target, method, params)
    }
    const probes = await runHerdrTick(env)
    assert.equal(probes.length, 2, '两个节点同 paneId 各产生一个 probe')
    const local = probes.find((p) => p.nodeId === 'local' && p.targetId === 'w:p9')!
    const remote = probes.find((p) => p.nodeId === 'build-01' && p.targetId === 'w:p9')!
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
  // 真实 clientRoot 夹具：声明 client 组件引用的插件必须提供 clientRoot
  //（注册边界强制），module 需为真实存在的相对 .ts/.tsx 源文件。
  const clientRoot = join(dataDir, 'fixture-client')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(
    join(clientRoot, 'main-screen.tsx'),
    `export function MainScreen(): string { return 'ok' }\n`,
  )
  const host = new PluginHost({
    dataDir,
    host: new UiBackend(),
    docs: new ProbeDocStore(),
  })
  return { host, dataDir }
}

test('UI docs：screen spec 如实进入 listUi 快照；声明同名 public doc 正常共存（docs 订阅已迁 client 轨）', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await makeUiHost()
  try {
    await host.register({
      id: 'test:docs-ok',
      clientRoot: join(dataDir, 'fixture-client'),
      definePlugin(ctx) {
        // docs 订阅由插件 client 代码经 plugin-client-sdk 完成；screen 只带
        // client 引用，不再有声明式 docs 字段（json-render 类整体迁出内核）。
        ctx.doc('overview', { version: 1 }, { public: true })
        ctx.ui.screen({ id: 'main', label: '主视图', client: { module: 'main-screen.tsx', export: 'MainScreen' } })
        ctx.ui.workbenchPanel({ id: 'plain', label: '普通面板' })
      },
    })
    const ui = host.listUi()
    const screen = ui.find((u) => u.surface === 'screen')!
    assert.ok(screen)
    assert.deepEqual((screen.spec as { client?: unknown }).client, { module: 'main-screen.tsx', export: 'MainScreen' })
    assert.equal((screen.spec as { docs?: string[] }).docs, undefined, 'docs 字段已删除')
    // 无 client 面板不受影响。
    const panel = ui.find((u) => u.surface === 'workbench.panel')!
    assert.deepEqual(panel.spec, { id: 'plain', label: '普通面板' })
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
