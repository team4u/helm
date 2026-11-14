/**
 * builtin:herdr steer 动作与 HerdrExecutor.steerPane 测试（helm 侧闭环）。
 *
 * fixture 语义（真实协议，herdr 0.9.5 / protocol 22）：SteerFakeTransport 按
 * 官方 agent.prompt(target, text, wait?) 形状模拟——首轮/自愈 prompt 携带
 * wait（target 为 paneId），插话不携带 wait（target 为受管 agentName），绝不
 * 依赖任何拟议 guard 字段识别插话。服务端 admission 在写入前拒绝 blocked /
 * launch_pending / 无 known_agent（agent_blocked / agent_not_ready /
 * agent_not_found，零写入）；预检 working 后刚转 idle 的提交被接续为新回合。
 *
 * 覆盖：
 * - 纯契约：parsePong 真实形状（无拟议能力字段；未知能力忽略；CAS 严格布尔）；
 * - 全链路（真实 PluginHost + 真实 UDS 行协议 fixture）：
 *   a) happy path：task 阶段 working 时单次投递现有 agent.prompt（无 wait、
 *      无附加字段、target 为受管 agentName）；真实形状 pong（无新能力）即可
 *      用，guardLevel='preflight'（预检水位，不伪称 CAS）；
 *   b) 预检拒绝：身份漂移 / blocked / idle（已结束不新建回合）/ launch_pending；
 *   c) 预检后竞态：刚转 idle 服务端接续新回合；转 blocked / CLI 退出服务端
 *      admission 确定零写入拒绝，原任务按原路径不受扰；
 *   d) 不确定投递（超时/断线）：单次不重发、按 pane 记失败；原任务结算显式
 *      herdr_steer_uncertain 失败保留现场（不读旧结果、不自愈冒充、不补发）；
 *      后续成功插话以最新指导覆盖失败记录；
 *   e) 唯一交接文件名：旧结果/迟到写回不能冒充新结果；连续插话只接受最新
 *      业务文件（预算耗尽经一次自愈按最新文件名兜底）；JSON Schema 不变；
 *   f) 阶段门禁：startup / handoff / gate / keepalive / 取消 / 关闭中拒绝；
 *      run/父会话强匹配；重入互斥；直调祖先链授权。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AskResult, type ConversationSummary } from '@helm/protocol'
import { PluginHost, type PluginConfigStore, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import { completeBackend } from './helpers/host-backend-stub.js'
import { FsOutputFiles, serveTransport } from './helpers/herdr-unit-fixture.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import { parsePong, SEND_KEYS_CAS_CAPABILITY } from '../src/builtin-plugins/herdr/rpc.js'

// ---------------------------------------------------------------------------
// 纯契约：parsePong 真实形状
// ---------------------------------------------------------------------------

test('契约: parsePong 真实形状解析（未知能力字段忽略；sendKeysCas 严格布尔）', { timeout: 60_000 }, () => {
  // 真实 0.9.5 pong 形状：无任何拟议插话守卫能力字段。
  const info = parsePong({
    type: 'pong',
    version: '0.9.5',
    protocol: 22,
    capabilities: { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1 },
  })
  assert.equal(info.version, '0.9.5')
  assert.equal(info.protocol, 22)
  assert.equal(info.sendKeysCas, false, '未通告 CAS 如实视为不支持')
  assert.deepEqual(
    parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: true } }).sendKeysCas,
    true,
  )
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22 }).sendKeysCas, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: null }).sendKeysCas, false)
  assert.throws(
    () => parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: 'yes' } }),
    (error: unknown) => (error as HelmError).code === 'herdr_protocol_violation',
  )
})

// ---------------------------------------------------------------------------
// 受控 FakeTransport（真实 protocol 22 语义）
// ---------------------------------------------------------------------------

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface PaneState {
  paneId: string
  tabId: string
  workspaceId: string
  agentStatus: PaneStatus
  seq: number
  name?: string
  cwd: string
  /** agent 启动序列：launch_pending 阶段 admission 拒绝输入。 */
  launchPending?: boolean
}

function agentInfoOf(pane: PaneState) {
  return {
    pane_id: pane.paneId,
    tab_id: pane.tabId,
    workspace_id: pane.workspaceId,
    agent_status: pane.agentStatus,
    interactive_ready: pane.agentStatus !== 'unknown',
    state_change_seq: pane.seq,
    launch_pending: pane.launchPending === true,
    cwd: pane.cwd,
    ...(pane.name !== undefined ? { name: pane.name } : {}),
  }
}

class SteerFakeTransport implements HerdrTransport {
  panes = new Map<string, PaneState>()
  tabs = new Map<string, { closed: boolean }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  outputFiles = new FsOutputFiles()
  eventListeners: Array<(e: HerdrEvent) => void> = []
  /** 顺序日志（跨方法排序断言：steer 投递 vs 交接文件删除）。 */
  orderLog: string[] = []
  /** 任务分支（携带 wait 的 agent.prompt）投递后的状态脚本。 */
  promptStatus: PaneStatus | Array<PaneStatus> = 'idle'
  onPrompt: ((pane: PaneState, text: string) => void) | undefined
  /** 插话 admission 接受后终端进入的状态（working=CLI 立即消费；idle=排队未起步）。 */
  steerConsumeStatus: PaneStatus = 'working'
  /** 插话请求处理延时（模拟在途 steer，驱动 driveTask 排空路径）。 */
  steerPromptDelayMs = 0
  /** 插话 admission 前把终端状态翻到该值并推进 seq（模拟预检后竞态）。 */
  raceStatusOnSteer: PaneStatus | undefined
  /** 插话 admission 前清除 pane 的 agent 名（模拟预检后 CLI 退出、无 known_agent）。 */
  exitCliOnSteer = false
  /** 插话写入完成后抛连接错误（模拟不确定投递；断言不重发）。 */
  failAfterSteerWrite = false
  /** agent.get 挂起直到该 Promise 解决（模拟 closePane 权威查询挂起）。 */
  holdAgentGetUntil: Promise<void> | undefined
  /** 已接受的插话投递（文本 + 目标）。 */
  steerDelivered: Array<{ paneId: string; text: string }> = []
  /** pong capabilities：真实 0.9.5 形状 + send_keys CAS（审批桥需要）。 */
  pongCapabilities: Record<string, unknown> | null = {
    live_handoff: false,
    detached_server_daemon: false,
    endpoint_protocol_generation: 1,
    [SEND_KEYS_CAS_CAPABILITY]: true,
  }
  /** agent.start 后停在 unknown（模拟 startup 阶段挂起）。 */
  holdStartup = false
  runGateCalls = 0
  removeOutputCalls: string[] = []

  private paneOf(ref: unknown): PaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    let pane = this.panes.get(id)
    // target 语义（真实协议）：paneId 或受管 agentName（CLI 退出后 name 失效）。
    if (pane === undefined) pane = [...this.panes.values()].find((p) => p.name === id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method, params })
    switch (method) {
      case 'ping':
        return {
          type: 'pong',
          version: 'steer-test-server',
          protocol: 22,
          ...(this.pongCapabilities !== null ? { capabilities: { ...this.pongCapabilities } } : {}),
        }
      case 'tab.create': {
        const n = this.panes.size + 1
        const workspaceId = 'ws-default'
        const paneId = `${workspaceId}:p${n}`
        const tabId = `${workspaceId}:t${n}`
        const paneCwd = (params['cwd'] as string) ?? '/tmp'
        // 生产 readLocalOutput 经真实 fs canonicalPath：pane cwd 必须真实存在。
        mkdirSync(join(paneCwd, '.helm'), { recursive: true })
        this.panes.set(paneId, {
          paneId, tabId, workspaceId,
          agentStatus: 'idle', seq: 1, cwd: paneCwd,
        })
        this.tabs.set(tabId, { closed: false })
        return {
          type: 'tab_created',
          tab: { tab_id: tabId, workspace_id: workspaceId },
          root_pane: { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId },
        }
      }
      case 'tab.close': {
        const tabId = params['tab_id'] as string
        const tab = this.tabs.get(tabId)
        if (!tab) throw new HelmError('tab_not_found', `no tab ${tabId}`, 404)
        tab.closed = true
        // 真实服务器关 tab 后窗格消失：后续针对该窗格的 RPC 一律 agent_not_found，
        // 在途 agent.wait 轮询也据此退出（不残留长定时器）。
        for (const [id, pane] of this.panes) {
          if (pane.tabId === tabId) this.panes.delete(id)
        }
        return { type: 'ok' }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.agentStatus = this.holdStartup ? 'unknown' : 'idle'
        pane.launchPending = this.holdStartup
        pane.seq += 1
        return { type: 'agent_started', agent: agentInfoOf(pane), argv: [] }
      }
      case 'agent.get': {
        if (this.holdAgentGetUntil !== undefined) await this.holdAgentGetUntil
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        const until = ((params['until'] as string[]) ?? []).map((s) => s as PaneStatus)
        const deadline = typeof params['timeout_ms'] === 'number' ? Date.now() + (params['timeout_ms'] as number) : undefined
        for (let i = 0; i < 4_000; i += 1) {
          if (!this.panes.has(pane.paneId)) {
            throw new HelmError('agent_not_found', `pane ${pane.paneId} 已关闭`, 404)
          }
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          if (deadline !== undefined && Date.now() >= deadline) {
            throw new HelmError('timeout', 'agent.wait 预算耗尽（无状态变化）', 408)
          }
          await delay(10)
        }
        throw new HelmError('timeout', 'timed out waiting for agent status', 408)
      }
      case 'agent.prompt': {
        // 分支判别（真实协议形状）：任务/自愈 prompt 携带 wait；插话不携带
        // wait 且以受管 agentName 寻址——绝不依赖任何拟议 guard 字段。
        if (params['wait'] === undefined) {
          const pane = this.paneOf(params['target'])
          const text = params['text'] as string
          // 预检后竞态：admission 前终端状态变化（seq 同步推进）/ CLI 退出。
          if (this.raceStatusOnSteer !== undefined) {
            pane.agentStatus = this.raceStatusOnSteer
            pane.seq += 1
          }
          if (this.exitCliOnSteer) pane.name = undefined
          // 真实 admission：launch_pending / blocked / 无 known_agent 零写入拒绝。
          if (pane.launchPending === true) {
            throw new HelmError('agent_not_ready', 'agent 仍在启动（launch_pending），输入未写入', 409)
          }
          if (pane.agentStatus === 'blocked') {
            throw new HelmError('agent_blocked', 'agent blocked（等待审批），输入未写入', 409)
          }
          this.paneOf(params['target']) // 无 known_agent（CLI 退出）零写入拒绝。

          if (this.steerPromptDelayMs > 0) await delay(this.steerPromptDelayMs)
          this.paneOf(params['target']) // 关闭期间的在途投递不得写入已销毁的终端。
          // 写入：CLI 消费插话开启新回合（或排队尚未起步，由 steerConsumeStatus 模拟）。
          pane.seq += 1
          pane.agentStatus = this.steerConsumeStatus
          this.steerDelivered.push({ paneId: pane.paneId, text })
          this.orderLog.push('steer-prompt')
          this.emit({ type: 'pane.updated', paneId: pane.paneId })
          if (this.failAfterSteerWrite) {
            throw new HelmError('herdr_timeout', '插话写入后连接中断（模拟不确定投递）', 504)
          }
          return { type: 'agent_prompted', agent: agentInfoOf(pane) }
        }
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        const script = this.promptStatus
        pane.agentStatus = Array.isArray(script) ? (script.shift() ?? 'idle') : script
        pane.seq += 1
        if (this.onPrompt) this.onPrompt(pane, text)
        this.orderLog.push('task-prompt')
        this.emit({ type: 'pane.updated', paneId: pane.paneId })
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.read': {
        const pane = this.paneOf(params['target'])
        return { type: 'pane_read', read: { pane_id: pane.paneId, text: `tail of ${pane.paneId}` } }
      }
      case 'agent.send_keys': {
        const pane = this.paneOf(params['target'])
        const expected = params['expected_state_seq']
        if (typeof expected !== 'number' || expected !== pane.seq) {
          throw new HelmError('stale_state', `expected_state_seq=${String(expected)} 与当前 ${pane.seq} 不符，按键未发送`, 409)
        }
        // 按键被消费：审批解除，CLI 继续工作。
        pane.seq += 1
        pane.agentStatus = 'working'
        this.emit({ type: 'pane.updated', paneId: pane.paneId })
        return { type: 'ok' }
      }
      case 'pane.report_metadata':
        return { type: 'ok' }
      case 'session.snapshot':
        return { type: 'session_snapshot', snapshot: { version: 'test', protocol: 22, workspaces: [], tabs: [], panes: [], agents: [] } }
      default:
        throw new HelmError('method_not_found', `fake transport 不支持 ${method}`, 400)
    }
  }

  async readOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    this.orderLog.push('read-output')
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
    return content
  }

  async removeOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.orderLog.push('remove-output')
    this.removeOutputCalls.push(fileName)
    this.outputFiles.delete(`${cwd}/.helm/${fileName}`)
  }

  async runGate(): Promise<{ ok: boolean; output: string }> {
    this.runGateCalls += 1
    this.orderLog.push('gate')
    return { ok: true, output: 'gate ok' }
  }

  async subscribe(
    _target: HerdrTarget,
    onEvent: (e: HerdrEvent) => void,
    _onError: (error: unknown) => void,
  ): Promise<() => void> {
    this.eventListeners.push(onEvent)
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent)
    }
  }

  emit(event: HerdrEvent): void {
    for (const listener of [...this.eventListeners]) listener(event)
  }

  advancePane(paneId: string, status: PaneStatus): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.agentStatus = status
    pane.seq += 1
    this.emit({ type: 'pane.updated', paneId })
  }
}

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

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

class MemoryConfigStore implements PluginConfigStore {
  constructor(private readonly initial: Record<string, unknown> = {}) {}
  get(): Record<string, unknown> { return this.initial }
  set(): void {}
}

function makeConversation(id: number, parent: number | undefined, cwd: string): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
    cwd,
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

interface TrackedRun {
  abort: AbortController
  /** spawn 钩子链终局（runManagedTask 全部 finally 退出后才 settle）。 */
  outcome: Promise<unknown>
}

interface Env {
  host: PluginHost
  transport: SteerFakeTransport
  dataDir: string
  parentCwd: string
  notifications: Array<{ title: string; body: string; level: string }>
  /** Gate 执行次数与首次进入/放行控制（gate 阶段测试用）。 */
  readonly gateCalls: number[]
  gateEntered: Promise<void>
  releaseGate(): void
  /** Env 管理的在途 run（close 时确定性取消并等待真实退出）。 */
  readonly runs: TrackedRun[]
  /** 宿主 pending Ask 观察/应答（blocked admission 竞态测试驱动审批桥）。 */
  askIds(): string[]
  answerAsk(id: string, answers: Record<string, string>): void
  settleWorkflow(): Promise<void>
  close(): Promise<void>
}

async function makeEnv(options: { transport?: SteerFakeTransport; startupTimeoutMs?: number } = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-steer-'))
  const parentCwd = join(dataDir, 'parent')
  mkdirSync(parentCwd, { recursive: true })
  const transport = options.transport ?? new SteerFakeTransport()
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const conversation1 = makeConversation(1, undefined, parentCwd)
  const conversation2 = makeConversation(2, undefined, parentCwd)
  const conversations = new Map<number, ConversationSummary>([[1, conversation1], [2, conversation2]])
  // Ask fake：createAsk 挂起等真实 cancelAsk/应答（或 close 兑底）结算，杜绝
  // 永不 settle 的 Promise 把任务链悬挂到进程尾。
  const pendingAsks = new Map<string, (result: AskResult) => void>()
  let askSeq = 0
  // Gate fake：首次进入可观察、可显式放行（其余测试无 gate 不受影响）。
  const gateCalls: number[] = []
  let releaseGateFn!: () => void
  const gateGate = new Promise<void>((resolve) => { releaseGateFn = resolve })
  let gateEnteredRes!: () => void
  const gateEntered = new Promise<void>((resolve) => { gateEnteredRes = resolve })
  const runs: TrackedRun[] = []
  let closing = false
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  const emitEvent = async (type: string, payload: unknown): Promise<void> => {
    if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    for (const listener of listeners.get(type) ?? []) await listener(payload)
  }
  const backend = completeBackend({
    conversations,
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    listConversations: () => [...conversations.values()],
    nodeIpc: {
      isOnline: () => true,
      call: async () => { throw new HelmError('unsupported', '本 steer fixture 无节点 IPC', 501) },
      subscribe: async () => { throw new HelmError('unsupported', '本 steer fixture 无节点 IPC 订阅', 501) },
    },
    buildSpawnEnv: (_conversationId: number, cwd: string) => ({ HELM_TOKEN: 'SECRET-TOKEN', HELM_CWD: cwd }),
    runGate: async () => {
      gateCalls.push(1)
      gateEnteredRes()
      await gateGate
      return { ok: true, output: 'gate ok' }
    },
    createAsk: async (spec: { id?: string }) => {
      const id = spec.id ?? `ask-${(askSeq += 1)}`
      if (closing) return { id, status: 'cancelled' as const, answers: {} }
      return new Promise<AskResult>((resolve) => pendingAsks.set(id, resolve))
    },
    cancelAsk: async (id: string, reason?: 'cancelled' | 'superseded') => {
      pendingAsks.get(id)?.({ id, status: reason === 'superseded' ? 'superseded' : 'cancelled', answers: {} })
      pendingAsks.delete(id)
    },
    emitEvent,
    onEvent: (type: string, listener: (payload: unknown) => unknown) => {
      let handlers = listeners.get(type)
      if (handlers === undefined) listeners.set(type, (handlers = new Set()))
      handlers.add(listener)
      return () => { handlers.delete(listener) }
    },
  }) as PluginHostBackend & { conversations: Map<number, ConversationSummary> }
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    config: new MemoryConfigStore({
      socketPath,
      startupTimeoutMs: options.startupTimeoutMs ?? 3001,
    }),
  })
  await host.register(createHerdrPlugin(), { enabled: true })
  return {
    host,
    transport,
    dataDir,
    parentCwd,
    notifications,
    gateCalls,
    gateEntered,
    releaseGate: () => releaseGateFn(),
    runs,
    askIds: () => [...pendingAsks.keys()],
    answerAsk: (id: string, answers: Record<string, string>) => {
      pendingAsks.get(id)?.({ id, status: 'answered', answers })
      pendingAsks.delete(id)
    },
    settleWorkflow: () => emitEvent('workflow.settled', { id: 'wf_run0000000009', conversationId: 1, status: 'completed' }),
    async close() {
      closing = true
      releaseGateFn()
      // 1) 确定性取消全部在途 run（触发 abortCleanup：Ask 销单 + 关自有窗格，
      //    同步删除 fixture 窗格使在途 agent.wait 轮询立即退出）。
      for (const run of runs) run.abort.abort()
      // 2) 兑底结算残留 pending Ask（如 blocked 场景未被 executor 主动销的单）。
      for (const [id, resolve] of pendingAsks) resolve({ id, status: 'cancelled', answers: {} })
      pendingAsks.clear()
      // 测试主体断言任务结果；清理只负责等待所有任务的 finally 退出。
      await Promise.allSettled(runs.map((run) => run.outcome))
      // 4) 宿主与连接拆除（此时无在途任务，dispose 干净）。
      await host.dispose()
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 经 agent_spawn 钩子发起 workflow 管理的后台任务（parentConversationId=1）。 */
async function spawnRun(
  env: Env,
  request: Record<string, unknown> = {},
): Promise<{ promise: Promise<unknown>; pane: () => PaneState; abort(): void }> {
  const { signal: callerSignal, ...rest } = request as { signal?: AbortSignal } & Record<string, unknown>
  // Env 管理的可取消 signal：close 时统一取消；caller 显式 signal 则组合。
  const abort = new AbortController()
  const signal = callerSignal === undefined ? abort.signal : AbortSignal.any([abort.signal, callerSignal])
  const outcome = env.host.runHook('agent_spawn', {
    parentConversationId: 1,
    prompt: 'do the thing',
    agentType: 'herdr:agy',
    workflowRunId: 'wf_run0000000009',
    ...rest,
    signal,
  } as never).then((hookOutcome) => {
    if (hookOutcome.action === 'handled') return hookOutcome.result
    throw new HelmError('herdr_spawn_unhandled', 'spawn 未被 herdr 插件接管（fixture 缺陷）', 500)
  })
  // 兄弟 catch：close 统一等待前（如断言失败提前进 finally）不得成为 unhandled
  // rejection；close 仍直接 await 同一 Promise 做真实终局判定。
  void outcome.catch(() => {})
  env.runs.push({ abort, outcome })
  let paneState: PaneState | undefined
  const pane = () => {
    paneState ??= [...env.transport.panes.values()][0]
    assert.ok(paneState !== undefined, '窗格应已创建')
    return paneState
  }
  return { promise: outcome, pane, abort: () => abort.abort() }
}

/** 任务 prompt（首轮）投递后等待 pane 进入指定状态。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await delay(intervalMs)
  }
}

/** 携带 wait 的任务/自愈 prompt（真实协议形状：target 为 paneId）。 */
function taskPromptCalls(env: Env): Array<{ method: string; params: Record<string, unknown> }> {
  return env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['wait'] !== undefined)
}

/** 不携带 wait 的插话投递（真实协议形状：target 为受管 agentName）。 */
function steerPromptCalls(env: Env): Array<{ method: string; params: Record<string, unknown> }> {
  return env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['wait'] === undefined)
}

async function taskPromptDelivered(env: Env): Promise<void> {
  await waitFor(() => taskPromptCalls(env).length >= 1)
}

/** 任务/自愈 prompt 文本引用的交接文件名。 */
function taskFileNameOf(text: string): string {
  const name = text.match(/写入[\s\S]*?\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
  assert.ok(name !== undefined, `任务文本应含交接文件名：${text.slice(-400)}`)
  return name
}

/** 插话文本要求写入的新交接文件名。 */
function steerNewFileNameOf(text: string): string {
  const name = text.match(/写入新文件 [^\n]*?\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
  assert.ok(name !== undefined, `插话文本应含新交接文件名：${text.slice(-400)}`)
  return name
}

/** 插话文本声明作废的旧交接文件名。 */
function steerOldFileNameOf(text: string): string {
  const name = text.match(/原交接文件 (wf-out-[A-Za-z0-9_.-]+\.(?:json|md)) 已作废/)?.[1]
  assert.ok(name !== undefined, `插话文本应含作废旧文件声明：${text.slice(-400)}`)
  return name
}

function steerFileOf(env: Env, index: number): string {
  const delivered = env.transport.steerDelivered[index]
  assert.ok(delivered !== undefined, `应已有第 ${index + 1} 次插话投递`)
  return steerNewFileNameOf(delivered.text)
}

/** 标准 steer 调用入参（与 workflow 委托契约一致）。 */
function steerInput(pane: PaneState, over: Record<string, unknown> = {}) {
  return {
    executionId: pane.paneId,
    nodeId: 'local',
    workflowRunId: 'wf_run0000000009',
    parentConversationId: 1,
    text: '改用方案B，并保持文件交接',
    ...over,
  }
}

async function rejectsSteer(env: Env, input: Record<string, unknown>, code: string, status?: number, context?: { conversationId?: number }): Promise<{ code: string; message: string; status?: number; details?: unknown }> {
  let caught: unknown
  try {
    await env.host.invokeAction('builtin:herdr', 'steer', input, context)
  } catch (error) {
    caught = error
  }
  const actual = caught as { code?: string; message?: string; status?: number; details?: unknown } | null
  assert.ok(caught instanceof Error || caught instanceof HelmError, `应抛错误（实际 ${String(caught)}）`)
  assert.equal(actual?.code, code, `错误码应为 ${code}（实际 ${actual?.code}: ${actual?.message}）`)
  if (status !== undefined && caught instanceof HelmError) assert.equal(caught.status, status)
  return { code: actual?.code ?? '', message: actual?.message ?? '', ...(caught instanceof HelmError ? { status: caught.status, details: caught.details } : {}) }
}

// ---------------------------------------------------------------------------
// 全链路
// ---------------------------------------------------------------------------

test('steer: task 阶段 working 时单次投递现有 agent.prompt（无 wait/无附加字段、agentName 寻址），guardLevel=preflight；真实形状 pong 即可用', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const preSeq = pane().seq
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))) as Record<string, unknown>
    assert.equal(out['steered'], true)
    assert.equal(out['nodeId'], 'local')
    assert.equal(out['executionId'], pane().paneId)
    assert.equal(out['ownership'], 'helm')
    assert.equal(out['guardLevel'], 'preflight', '预检语义如实回报，不伪称 CAS')
    assert.equal(out['stateChangeSeq'], preSeq, 'stateChangeSeq 为预检观测水位')
    // 投递请求形状（真实协议）：仅 target（受管 agentName）+ text。
    assert.equal(steerPromptCalls(env).length, 1)
    const steerCall = steerPromptCalls(env)[0]!
    assert.deepEqual(Object.keys(steerCall.params).sort(), ['target', 'text'], '不携带 wait/guard 或任何拟议扩展字段')
    assert.equal(steerCall.params['target'], pane().name)
    // 原任务 prompt --wait 语义未被替换。
    assert.deepEqual(taskPromptCalls(env)[0]!.params['wait'], { until: ['done', 'idle', 'blocked'] })
    // 投递文本：来源前缀 + 指导 + 新交接文件（旧路径作废）。
    assert.equal(env.transport.steerDelivered.length, 1)
    const delivered = env.transport.steerDelivered[0]!.text
    assert.ok(delivered.includes('wf_run0000000009'))
    assert.ok(delivered.includes('改用方案B'))
    const newFile = steerNewFileNameOf(delivered)
    const oldFile = steerOldFileNameOf(delivered)
    const originalFile = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    assert.equal(oldFile, originalFile, '作废声明指向原交接文件')
    assert.notEqual(newFile, originalFile, '新文件名必须全新唯一')
    // 任务收尾：按最新指导写新文件 -> done -> 结果返回；新旧文件成功后清理。
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'done-guided')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'done-guided')
    assert.equal(existsSync(join(pane().cwd, '.helm', newFile)), false, '新交接文件成功后被清理')
    assert.equal(existsSync(join(pane().cwd, '.helm', originalFile)), false, '作废旧文件成功后被清理')
  } finally {
    await env.close()
  }
})

test('steer: 预检身份漂移（name 变化）拒绝且零投递，原任务不受扰', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const before = pane().name
    pane().name = 'human-took-over'
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_identity_mismatch', 409)
    pane().name = before
    assert.deepEqual(env.transport.steerDelivered, [])
    assert.equal(steerPromptCalls(env).length, 0)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: 预检 blocked 拒绝（交原审批桥），不投递不新建回合', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.advancePane(pane().paneId, 'blocked')
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_agent_blocked', 409)
    assert.equal(typeof (err.details as Record<string, unknown> | undefined)?.['stateChangeSeq'], 'number')
    assert.equal(steerPromptCalls(env).length, 0)
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: 预检已 idle 拒绝（不新建回合），原任务按原文件正常交接', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    // 首轮完成：结果已按原路径落盘，终端 idle。
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'first-turn-ok')
    env.transport.advancePane(pane().paneId, 'idle')
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_not_working', 409)
    assert.equal(steerPromptCalls(env).length, 0)
    assert.deepEqual(env.transport.steerDelivered, [])
    assert.equal(await promise, 'first-turn-ok', '拒绝不产生替代交付，原任务按原文件结算')
  } finally {
    await env.close()
  }
})

test('steer: 预检 launch_pending 拒绝，原任务不受扰', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    pane().launchPending = true
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_not_ready', 409)
    pane().launchPending = false
    assert.equal(steerPromptCalls(env).length, 0)
    assert.deepEqual(env.transport.steerDelivered, [])
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: 预检后刚转 idle——服务端 admission 接受并接续新回合', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 预检 working 后、服务端接收前终端刚转 idle：真实服务端接续新回合。
    env.transport.raceStatusOnSteer = 'idle'
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))) as Record<string, unknown>
    assert.equal(out['steered'], true)
    assert.equal(out['guardLevel'], 'preflight')
    await waitFor(() => pane().agentStatus === 'working')
    const newFile = steerFileOf(env, 0)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'continued-turn')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'continued-turn')
  } finally {
    await env.close()
  }
})

test('steer: 预检后变 blocked——服务端 admission 确定零写入拒绝（agent_blocked），原任务经审批桥按原路径继续', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.raceStatusOnSteer = 'blocked'
    await rejectsSteer(env, steerInput(pane()), 'agent_blocked')
    assert.equal(steerPromptCalls(env).length, 1, '单次尝试即终局')
    assert.deepEqual(env.transport.steerDelivered, [], 'admission 拒绝意味着零字节写入')
    // 终端确实 blocked：任务进入审批桥；应答后 CLI 继续并按原路径交付。
    await waitFor(() => env.askIds().length >= 1)
    env.answerAsk(env.askIds()[0]!, { decision: 'allow-enter' })
    await waitFor(() => pane().agentStatus === 'working')
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'after-approval')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'after-approval', '零写入拒绝不得扰动原任务或重定向交接路径')
  } finally {
    await env.close()
  }
})

test('steer: 预检后 CLI 退出（无 known_agent）——服务端 agent_not_found 确定零写入，原任务不受扰', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 预检通过后、服务端接收前 CLI 退出：agentName 寻址失败，零写入。
    env.transport.exitCliOnSteer = true
    await rejectsSteer(env, steerInput(pane()), 'agent_not_found')
    assert.equal(steerPromptCalls(env).length, 1, '单次尝试即终局')
    assert.deepEqual(env.transport.steerDelivered, [])
    env.transport.exitCliOnSteer = false
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: 投递后连接中断（不确定投递）单次不重发；原任务显式 herdr_steer_uncertain 失败，不读旧结果、不自愈冒充、不补发', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    const resultFile = `${pane().cwd}/.helm/${original}`
    env.transport.failAfterSteerWrite = true
    await rejectsSteer(env, steerInput(pane()), 'herdr_timeout')
    assert.equal(steerPromptCalls(env).length, 1, '不确定结果绝不重发')
    assert.equal(env.transport.steerDelivered.length, 1, '服务端已写入（不确定投递），客户端如实报错')
    // 原任务结算必须显式失败：绝不读旧结果，也不经自愈追问冒充成功。
    env.transport.failAfterSteerWrite = false
    env.transport.outputFiles.set(resultFile, 'stale-result')
    env.transport.advancePane(pane().paneId, 'done')
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof HelmError)
    assert.equal(caught.code, 'herdr_steer_uncertain', '不确定投递使原任务显式失败')
    assert.ok(caught.message.includes('不确定'), '诊断含不确定原因')
    assert.equal(existsSync(resultFile), true, '失败保留现场：旧结果文件不被删除')
    assert.equal(taskPromptCalls(env).length, 1, '不自动补发 prompt / 自愈冒充')
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed', '窗格保留现场（failed）')
  } finally {
    await env.close()
  }
})

test('steer: 不确定投递被后续成功插话覆盖——按最新唯一文件结算，作废文件清理', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.failAfterSteerWrite = true
    await rejectsSteer(env, steerInput(pane(), { text: '第一条（结果不确定）' }), 'herdr_timeout')
    env.transport.failAfterSteerWrite = false
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane(), { text: '第二条（最新指导）' }))) as Record<string, unknown>
    assert.equal(out['steered'], true)
    assert.equal(env.transport.steerDelivered.length, 2)
    const latestFile = steerFileOf(env, 1)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'superseded-result')
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${latestFile}`, 'latest-guidance')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'latest-guidance', '最新成功插话覆盖不确定记录，按最新文件结算')
    assert.equal(existsSync(join(pane().cwd, '.helm', latestFile)), false)
    assert.equal(existsSync(join(pane().cwd, '.helm', original)), false, '作废旧文件成功后被清理')
  } finally {
    await env.close()
  }
})

test('steer: 旧结果迟到写回不能冒充——结算只认最新唯一文件', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    const originalPath = `${pane().cwd}/.helm/${original}`
    env.transport.outputFiles.set(originalPath, 'v1')
    await waitFor(() => pane().agentStatus === 'working')
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    // 插话后旧路径又被迟到写回（旧回合的残写）。
    env.transport.outputFiles.set(originalPath, 'v1-late-writeback')
    const newFile = steerFileOf(env, 0)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'v2-guided')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'v2-guided', '必须以最新唯一文件结算，旧路径残写不得冒充')
    assert.equal(existsSync(originalPath), false, '作废旧文件成功后被清理')
    assert.equal(existsSync(join(pane().cwd, '.helm', newFile)), false)
  } finally {
    await env.close()
  }
})

test('steer: 连续插话只接受最新业务文件（旧插话文件迟到无效；预算耗尽经一次自愈按最新文件兜底）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ startupTimeoutMs: 3001 })
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane(), { text: '第一次指导' }))
    await waitFor(() => env.transport.steerDelivered.length === 1)
    await waitFor(() => pane().agentStatus === 'working')
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane(), { text: '第二次指导' }))
    await waitFor(() => env.transport.steerDelivered.length === 2)
    const firstFile = steerFileOf(env, 0)
    const latestFile = steerFileOf(env, 1)
    assert.notEqual(firstFile, latestFile)
    // CLI 只执行了第一次指导的写盘（旧插话文件迟到写回），最新文件缺失。
    env.transport.promptStatus = 'idle'
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${firstFile}`, 'first-guidance-only')
    env.transport.advancePane(pane().paneId, 'done')
    // 结算进入有界等待（新文件未出现）：等后续回合起步，预算耗尽不自诊成功。
    await waitFor(() => env.transport.calls.some((c) =>
      c.method === 'agent.wait' &&
      Array.isArray(c.params['until']) &&
      JSON.stringify(c.params['until']) === JSON.stringify(['working', 'blocked']) &&
      typeof c.params['timeout_ms'] === 'number',
    ), 15_000)
    // 预算耗尽后落到一次自愈：追问按最新文件名索取。
    env.transport.onPrompt = (p, text) => {
      const name = text.match(/\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
      if (name !== undefined) env.transport.outputFiles.set(`${p.cwd}/.helm/${name}`, 'healed-latest')
    }
    assert.equal(await promise, 'healed-latest', '自愈只按最新文件名兜底，旧插话文件不得冒充')
    const healText = taskPromptCalls(env)[1]!.params['text'] as string
    assert.ok(healText.includes(latestFile), '自愈追问必须指向最新业务文件')
    assert.equal(existsSync(join(pane().cwd, '.helm', firstFile)), false, '旧插话文件成功后被清理')
    assert.equal(taskPromptCalls(env).length, 2, '自愈恰好一次')
  } finally {
    await env.close()
  }
})

test('steer: 投递后仍 idle 且新文件未出现——有界等待后续回合起步，确认前不读不删旧结果', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    const originalPath = `${pane().cwd}/.helm/${original}`
    env.transport.outputFiles.set(originalPath, 'v1')
    await waitFor(() => pane().agentStatus === 'working')
    // 投递成功但 CLI 队列尚未起步：终端恰在此时转 idle（新回合未开始）。
    env.transport.steerConsumeStatus = 'idle'
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    assert.equal(env.transport.steerDelivered.length, 1)
    await waitFor(() => pane().agentStatus === 'idle')
    // 结算处于有界等待（idle 不可证明 CLI 已消费）：不得读/删 v1、不得跑 Gate。
    await waitFor(() => env.transport.calls.some((c) =>
      c.method === 'agent.wait' &&
      Array.isArray(c.params['until']) &&
      JSON.stringify(c.params['until']) === JSON.stringify(['working', 'blocked']) &&
      typeof c.params['timeout_ms'] === 'number',
    ))
    assert.equal(existsSync(originalPath), true, '新结果确认前不得删除旧结果文件')
    // CLI 队列起步：按最新指导写新文件 -> done。
    pane().agentStatus = 'working'
    pane().seq += 1
    env.transport.emit({ type: 'pane.updated', paneId: pane().paneId })
    const newFile = steerFileOf(env, 0)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'v2-guided')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'v2-guided', '必须以新回合结果结算，不得以 v1 成功')
    assert.equal(existsSync(originalPath), false, '成功交接后旧文件被清理')
  } finally {
    await env.close()
  }
})

test('steer: JSON 业务 Schema 不变（新文件同扩展 .json，Schema 校验照常）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env, {
      schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    })
    await taskPromptDelivered(env)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, JSON.stringify({ value: 1 }))
    await waitFor(() => pane().agentStatus === 'working')
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    const newFile = steerFileOf(env, 0)
    assert.ok(newFile.endsWith('.json'), '新文件保持同扩展（schema 任务为 json）')
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, JSON.stringify({ value: 42 }))
    env.transport.advancePane(pane().paneId, 'done')
    assert.deepEqual(await promise, { value: 42 }, '有效 JSON 业务 Schema 交付不变')
    assert.equal(existsSync(join(pane().cwd, '.helm', original)), false)
  } finally {
    await env.close()
  }
})

test('steer: run/父会话强匹配——跨轨道插话拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    await rejectsSteer(env, steerInput(pane(), { workflowRunId: 'wf_other' }), 'herdr_steer_context_mismatch', 409)
    await rejectsSteer(env, steerInput(pane(), { parentConversationId: 2 }), 'herdr_steer_context_mismatch', 409)
    assert.deepEqual(env.transport.steerDelivered, [])
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: 直调授权——非祖先 caller 拒绝（自报 conversationId 非认证）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 会话 2 与父会话 1 无祖先关系。
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_out_of_scope', 403, { conversationId: 2 })
    // 发起会话自身放行。
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()), { conversationId: 1 })) as Record<string, unknown>
    assert.equal(out['steered'], true)
    assert.equal(out['guardLevel'], 'preflight')
    const newFile = steerFileOf(env, 0)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: 按 pane 互斥——在途 steer 期间重入拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.steerPromptDelayMs = 250
    const first = env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane())) as Promise<Record<string, unknown>>
    await waitFor(() => steerPromptCalls(env).length >= 1)
    await rejectsSteer(env, steerInput(pane(), { text: '第二条' }), 'herdr_steer_in_flight', 409)
    assert.equal((await first)['steered'], true)
    assert.deepEqual(env.transport.steerDelivered.map((d) => d.text.includes('改用方案B')), [true], '仅第一条投递')
    const newFile = steerFileOf(env, 0)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${newFile}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: startup 阶段（agent 未就绪）拒绝插话', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.holdStartup = true
    // 任务 prompt 一到就落盘交接文件（防读文件时序悬挂任务）。
    env.transport.onPrompt = (pane, text) => {
      const name = text.match(/\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
      if (name !== undefined) env.transport.outputFiles.set(`${pane.cwd}/.helm/${name}`, 'ok')
    }
    const { promise, pane } = await spawnRun(env)
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.start'))
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_phase', 409)
    assert.equal((err.details as Record<string, unknown>)['phase'], 'startup')
    // 解除挂起让任务正常收尾（不悬挂测试进程）。
    env.transport.holdStartup = false
    pane().agentStatus = 'idle'
    pane().launchPending = false
    pane().seq += 1
    env.transport.emit({ type: 'pane.updated', paneId: pane().paneId })
    env.transport.promptStatus = 'idle'
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: handoff 阶段（交接自愈等待中）拒绝插话；settled 后按非运行拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    // 任务完成但交接文件缺失 -> 自愈追问（handoff 阶段挂起）。
    env.transport.advancePane(pane().paneId, 'done')
    await waitFor(() => taskPromptCalls(env).length >= 2)
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_phase', 409)
    assert.equal((err.details as Record<string, unknown>)['phase'], 'handoff')
    // 自愈追问返回 idle 后补写文件完成任务。
    const healName = taskFileNameOf(taskPromptCalls(env)[1]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${healName}`, 'healed')
    env.transport.advancePane(pane().paneId, 'idle')
    assert.equal(await promise, 'healed')
    // keepalive（已结算保活）：无在途任务，按非运行拒绝。
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_not_running', 409)
  } finally {
    await env.close()
  }
})

test('steer: 原 task 挂在 Gate 期间拒绝插话；Gate 恰好一次不被替代', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    env.transport.onPrompt = (pane, text) => {
      const name = text.match(/\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
      if (name !== undefined) env.transport.outputFiles.set(`${pane.cwd}/.helm/${name}`, 'gated-result')
    }
    const { promise, pane } = await spawnRun(env, { gate: 'true' })
    await taskPromptDelivered(env)
    // 任务终态 + 交接文件就绪 -> handoff 完成 -> Gate 挂起（等测试放行）。
    env.transport.advancePane(pane().paneId, 'done')
    await env.gateEntered
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_phase', 409)
    assert.equal((err.details as Record<string, unknown> | undefined)?.['phase'], 'gate')
    env.releaseGate()
    assert.equal(await promise, 'gated-result')
    assert.equal(env.gateCalls.length, 1, 'Gate 恰好执行一次（steer 拒绝不产生替代交付）')
  } finally {
    await env.close()
  }
})

test('steer: run 取消交错——取消后不发送新 prompt，在途单次请求如实终局且不重发', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane, abort } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 在途 steer（慢 RPC）期间取消原 run：abortCleanup 关闭自有窗格。
    env.transport.steerPromptDelayMs = 300
    const paneState = pane()
    const steerPromise = env.host.invokeAction('builtin:herdr', 'steer', steerInput(paneState)) as Promise<unknown>
    void steerPromise.catch(() => {})
    await waitFor(() => steerPromptCalls(env).length >= 1)
    abort()
    // 原任务以 aborted 真实终局（等待而非 sleep）。
    await assert.rejects(promise, (error: unknown) => (error as HelmError).code === 'aborted')
    // 在途单次请求如实终局：窗格已关闭，服务端以 agent_not_found 拒绝（零写入）。
    await assert.rejects(steerPromise, (error: unknown) => (error as { code?: string }).code === 'agent_not_found')
    assert.equal(env.transport.steerDelivered.length, 0, '取消后零写入')
    // 取消后不得发送新 prompt / resurrect（窗格已从 fixture 删除：坐标用快照）。
    await rejectsSteer(env, steerInput(paneState), 'herdr_steer_not_running', 409)
    assert.equal(steerPromptCalls(env).length, 1, '仅原始单次尝试')
  } finally {
    await env.close()
  }
})

test('steer: 非取消关闭的权威查询挂起中立即拒绝插话（不能依赖 abort signal）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let releaseGet = () => {}
  let closing: Promise<void> | undefined
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const requestCount = env.transport.calls.length
    env.transport.holdAgentGetUntil = new Promise<void>((resolve) => { releaseGet = resolve })
    closing = env.settleWorkflow()
    await waitFor(() => env.transport.calls.slice(requestCount).some((call) => call.method === 'agent.get'))
    assert.equal(env.runs[0]!.abort.signal.aborted, false)
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_task_ended', 409)
    assert.equal(env.transport.steerDelivered.length, 0)
    releaseGet()
    await closing
    await assert.rejects(promise)
  } finally {
    releaseGet()
    await closing
    await env.close()
  }
})

test('steer: 窗格不受管 / nodeId 不一致 / 未连接均显式拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    await rejectsSteer(env, steerInput(pane(), { executionId: 'ws:unknown' }), 'not_found', 404)
    // 同 pane 不同 node：registry 精确 (nodeId, paneId) 定位，node-a 上不存在。
    await rejectsSteer(env, steerInput(pane(), { nodeId: 'node-a' }), 'not_found', 404)
    // 非法 nodeId。
    await rejectsSteer(env, steerInput(pane(), { nodeId: 'bad node!' }), 'validation_error', 400)
    const original = taskFileNameOf(taskPromptCalls(env)[0]!.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${original}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok')
  } finally {
    await env.close()
  }
})

test('steer: manifest 冒烟——herdr steer 动作注册（自动 CLI 映射，不 exposeAsTool）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const manifest = env.host.listActions().find((m) => m.pluginId === 'builtin:herdr' && m.id === 'steer')
    assert.ok(manifest !== undefined, 'herdr steer 动作应注册')
    assert.notEqual(manifest.exposeAsTool, true, '模型统一走 workflow.steer，herdr steer 不直投工具')
    assert.deepEqual(manifest.cli?.command, ['herdr', 'steer'])
  } finally {
    await env.close()
  }
})
