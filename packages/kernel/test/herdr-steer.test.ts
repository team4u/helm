/**
 * builtin:herdr steer 动作与 HerdrExecutor.steerPane 测试（helm 侧闭环）。
 *
 * 背景与诚实声明：当前历史 Herdr 服务端（/root/code/herdr，herdr 0.9.5 /
 * protocol 22，只读核实）的 AgentPromptParams 仅 {target, text, wait}，无
 * guard 字段，也未在 ping capabilities 通告 agent_prompt_guard_v1——本文件
 * 的 SteerFakeTransport「实现」的是 helm 拟议契约（见 rpc.ts 契约块）：
 * 守卫在任何 PTY 字节写入前原子核验完整身份四元组 + 水位 + working，且
 * 覆盖完整「文本 + 回车」投递期（fixture 以单步原子写模拟）；核验不符
 * stale_state / agent_not_ready / agent_blocked 且零写入。fixture 行为
 * **不代表实际 Herdr 服务端能力**；对未通告能力的真实服务端，helm 侧
 * fail-closed（herdr_steer_guard_unsupported）。
 *
 * 覆盖：
 * - 纯契约：buildAgentPromptGuardParams 边界校验；parsePong 的
 *   agent_prompt_guard_v1 严格布尔解析；
 * - 全链路（真实 PluginHost + 真实 UDS 行协议 fixture）：
 *   a) happy path：task 阶段 + working 时投递 guard prompt（无 wait、短超时、
 *      terminal_id 为权威值），原任务 prompt --wait 不被替换；steered 仅投递成功；
 *   b) 服务端未通告能力：herdr_steer_guard_unsupported（附版本诊断），零
 *      guard prompt 盲发；能力字段坏形状：herdr_protocol_violation；
 *   c) seq 竞态（人类在预检与投递间按键）：stale_state 零写入、不重试；
 *   d) 非 working（idle/blocked）拒绝且不新建回合；身份漂移拒绝；
 *   e) 阶段门禁：startup / handoff / keepalive 拒绝；run/父会话强匹配；
 *      重入互斥；原任务取消后拒绝；
 *   f) driveTask 结算排空：在途 steer 期间首个 idle 不进交接，权威复查
 *      working 回到等待，removeOutput 恰一次且晚于 steer；
 *   g) 投递后连接中断（不确定结果）：真实错误上抛、不重发、任务不受扰；
 *   h) 直调授权：非祖先 caller 拒绝（HTTP 自报 conversationId 非认证）。
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
import {
  AGENT_PROMPT_GUARD_CAPABILITY,
  buildAgentPromptGuardParams,
  parsePong,
  SEND_KEYS_CAS_CAPABILITY,
} from '../src/builtin-plugins/herdr/rpc.js'

// ---------------------------------------------------------------------------
// 纯契约：buildAgentPromptGuardParams / parsePong.promptGuard
// ---------------------------------------------------------------------------

test('契约: buildAgentPromptGuardParams 产出 wire 字段（无 wait）并拒绝非法入参', { timeout: 60_000 }, () => {
  const params = buildAgentPromptGuardParams({
    target: 'helm-wf-abc',
    text: '改用方案B',
    guard: { terminalId: 'term-1', paneId: 'ws:p1', tabId: 'ws:t1', agentName: 'helm-wf-abc', stateChangeSeq: 7, agentStatus: 'working' },
  })
  assert.deepEqual(params, {
    target: 'helm-wf-abc',
    text: '改用方案B',
    guard: {
      terminal_id: 'term-1',
      pane_id: 'ws:p1',
      tab_id: 'ws:t1',
      agent_name: 'helm-wf-abc',
      state_change_seq: 7,
      agent_status: 'working',
    },
  })
  assert.equal('wait' in params, false, 'steer 投递绝不携带 wait')
  const bad: Array<() => unknown> = [
    () => buildAgentPromptGuardParams({ target: '', text: 't', guard: { terminalId: 'a', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: 1, agentStatus: 'working' } }),
    () => buildAgentPromptGuardParams({ target: 'x', text: '', guard: { terminalId: 'a', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: 1, agentStatus: 'working' } }),
    () => buildAgentPromptGuardParams({ target: 'x', text: 't', guard: { terminalId: ' ', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: 1, agentStatus: 'working' } }),
    () => buildAgentPromptGuardParams({ target: 'x', text: 't', guard: { terminalId: 'a', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: -1, agentStatus: 'working' } }),
    () => buildAgentPromptGuardParams({ target: 'x', text: 't', guard: { terminalId: 'a', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: 1.5, agentStatus: 'working' } }),
    () => buildAgentPromptGuardParams({ target: 'x', text: 't', guard: { terminalId: 'a', paneId: 'p', tabId: 't', agentName: 'n', stateChangeSeq: 1, agentStatus: 'idle' as 'working' } }),
  ]
  for (const fn of bad) assert.throws(fn, HelmError)
})

test('契约: parsePong 严格解析 agent_prompt_guard_v1（true 才支持；缺省/坏形状如实）', { timeout: 60_000 }, () => {
  assert.equal(
    parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [AGENT_PROMPT_GUARD_CAPABILITY]: true } }).promptGuard,
    true,
  )
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22 }).promptGuard, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: null }).promptGuard, false)
  assert.equal(
    parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [AGENT_PROMPT_GUARD_CAPABILITY]: false } }).promptGuard,
    false,
  )
  // 真实 0.9.5 pong 形状：无该能力字段。
  assert.equal(
    parsePong({
      type: 'pong', version: '0.9.5', protocol: 22,
      capabilities: { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1 },
    }).promptGuard,
    false,
  )
  assert.throws(
    () => parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [AGENT_PROMPT_GUARD_CAPABILITY]: 'yes' } }),
    (error: unknown) => (error as HelmError).code === 'herdr_protocol_violation',
  )
})

// ---------------------------------------------------------------------------
// 受控 FakeTransport（拟议契约实现；非实际 Herdr 能力）
// ---------------------------------------------------------------------------

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface PaneState {
  paneId: string
  tabId: string
  workspaceId: string
  terminalId: string
  agentStatus: PaneStatus
  seq: number
  name?: string
  cwd: string
}

function agentInfoOf(pane: PaneState) {
  return {
    terminal_id: pane.terminalId,
    pane_id: pane.paneId,
    tab_id: pane.tabId,
    workspace_id: pane.workspaceId,
    agent_status: pane.agentStatus,
    interactive_ready: pane.agentStatus !== 'unknown',
    state_change_seq: pane.seq,
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
  promptStatus: PaneStatus | Array<PaneStatus> = 'idle'
  onPrompt: ((pane: PaneState, text: string) => void) | undefined
  /** guard prompt 接受后终端进入的状态（模拟 CLI 消费指导开启新回合）。 */
  steerConsumeStatus: PaneStatus = 'working'
  /** guard prompt 处理延时（模拟在途 steer，驱动 driveTask 排空路径）。 */
  steerPromptDelayMs = 0
  /** guard prompt 到达前模拟人类竞态按键（seq 推进）：稳定触发 stale_state。 */
  raceSeqOnSteer = false
  /** guard prompt 到达前把终端状态翻到该值（seq 不变）：触发服务端 agent_not_ready/agent_blocked。 */
  raceStatusOnSteer: PaneStatus | undefined
  /** guard 写入完成后抛连接错误（模拟不确定投递；断言不重发）。 */
  failAfterSteerWrite = false
  /** agent.get 挂起直到该 Promise 解决（模拟 closePane 权威查询挂起）。 */
  holdAgentGetUntil: Promise<void> | undefined
  /** 已接受的 steer 投递（文本 + 目标）。 */
  steerDelivered: Array<{ paneId: string; text: string }> = []
  /** ping capabilities 通告：缺省模拟实现拟议契约的服务端。 */
  pongCapabilities: Record<string, unknown> | null = {
    live_handoff: false,
    [SEND_KEYS_CAS_CAPABILITY]: true,
    [AGENT_PROMPT_GUARD_CAPABILITY]: true,
  }
  /** 覆盖 pong 原始响应（坏形状边界测试）。 */
  pongResultOverride: unknown
  /** agent.start 后停在 unknown（模拟 startup 阶段挂起）。 */
  holdStartup = false
  runGateCalls = 0
  removeOutputCalls: string[] = []

  private paneOf(ref: unknown): PaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    let pane = this.panes.get(id)
    // target 语义（真实协议）：paneId 或受管 agentName。
    if (pane === undefined) pane = [...this.panes.values()].find((p) => p.name === id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method, params })
    switch (method) {
      case 'ping':
        if (this.pongResultOverride !== undefined) return this.pongResultOverride
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
          terminalId: `term-${n}`,
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
        pane.seq += 1
        return {
          type: 'agent_started',
          agent: agentInfoOf(pane),
          ...(this.holdStartup ? { argv: [] } : { argv: [] }),
        }
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
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        const guard = params['guard'] as Record<string, unknown> | undefined
        if (guard !== undefined) {
          // —— 拟议 agent_prompt_guard_v1 契约实现（fixture；非实际 Herdr 能力）——
          // 首字节前原子核验完整身份 + 水位 + working；不符零写入。
          if (this.raceSeqOnSteer) pane.seq += 1
          if (this.raceStatusOnSteer !== undefined) pane.agentStatus = this.raceStatusOnSteer
          if (
            guard['terminal_id'] !== pane.terminalId ||
            guard['pane_id'] !== pane.paneId ||
            guard['tab_id'] !== pane.tabId ||
            guard['agent_name'] !== pane.name
          ) {
            throw new HelmError('stale_state', 'guard 身份不符，输入未写入', 409)
          }
          if (guard['agent_status'] !== 'working') {
            throw new HelmError('invalid_params', 'guard.agent_status 必须为 working', 400)
          }
          if (guard['state_change_seq'] !== pane.seq) {
            throw new HelmError('stale_state', `guard 水位不符（期望 ${String(guard['state_change_seq'])}，当前 ${pane.seq}），输入未写入`, 409)
          }
          if (pane.agentStatus !== 'working') {
            throw new HelmError(
              pane.agentStatus === 'blocked' ? 'agent_blocked' : 'agent_not_ready',
              `agent ${pane.agentStatus}，输入未写入`,
              409,
            )
          }
          if (this.steerPromptDelayMs > 0) await delay(this.steerPromptDelayMs)
          this.paneOf(params['target']) // 关闭期间的在途投递不得写入已销毁的终端。
          // 原子提交：完整「文本 + 回车」一次性写入（契约要求守卫覆盖完整投递期）。
          pane.seq += 1
          pane.agentStatus = this.steerConsumeStatus
          this.steerDelivered.push({ paneId: pane.paneId, text })
          this.orderLog.push('steer-prompt')
          this.emit({ type: 'pane.updated', paneId: pane.paneId })
          if (this.failAfterSteerWrite) {
            throw new HelmError('herdr_timeout', 'guard 写入后连接中断（模拟不确定投递）', 504)
          }
          return { type: 'agent_prompted', agent: agentInfoOf(pane) }
        }
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
  // Ask fake：createAsk 挂起等真实 cancelAsk（或 close 兑底）结算，杜绝永不
  // settle 的 Promise 把任务链悬挂到进程尾。
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

async function taskPromptDelivered(env: Env): Promise<void> {
  await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined))
}

/** 从投递文本提取 receipt 与确认文件名（与生产提示词契约同源的正则）。 */
function receiptOf(deliveredText: string): string {
  const receipt = deliveredText.match(/确认 receipt：([A-Za-z0-9_-]+)/)?.[1]
  assert.ok(receipt !== undefined, `投递文本应含 receipt：${deliveredText}`)
  return receipt
}

function confirmFileOf(deliveredText: string): string {
  const file = deliveredText.match(/\.helm\/(wf-out-[A-Za-z0-9_.-]+-s\.json)/)?.[1]
  assert.ok(file !== undefined, `投递文本应含确认文件名：${deliveredText}`)
  return file
}

/** 把指定 receipt 写入确认文件（模拟 CLI 履约：按最新指导交付后写确认）。 */
function writeConfirm(env: Env, pane: PaneState, deliveredText: string, receiptOverride?: string): void {
  const receipt = receiptOverride ?? receiptOf(deliveredText)
  env.transport.outputFiles.set(`${pane.cwd}/.helm/${confirmFileOf(deliveredText)}`, JSON.stringify({ receipt }))
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

function fileNameOf(text: string): string {
  return text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
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

test('steer: task 阶段 working 时投递 guard prompt（无 wait），原任务 prompt --wait 不被替换', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))) as Record<string, unknown>
    assert.equal(out['steered'], true)
    assert.equal(out['nodeId'], 'local')
    assert.equal(out['executionId'], pane().paneId)
    assert.equal(out['ownership'], 'helm')
    assert.equal(out['guardLevel'], 'cas')
    const preSeq = out['stateChangeSeq'] as number
    // 投递请求形状：guard 完整、无 wait、target 为受管 agentName。
    const steerCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined)!
    assert.ok(steerCall !== undefined)
    assert.equal('wait' in steerCall.params, false, 'steer 投递绝不携带 wait')
    assert.equal(steerCall.params['target'], pane().name)
    assert.deepEqual(steerCall.params['guard'], {
      terminal_id: pane().terminalId,
      pane_id: pane().paneId,
      tab_id: pane().tabId,
      agent_name: pane().name,
      state_change_seq: preSeq,
      agent_status: 'working',
    })
    // 原任务 prompt --wait 语义未被替换。
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    assert.deepEqual(taskCall.params['wait'], { until: ['done', 'idle', 'blocked'] })
    // 投递文本：来源前缀 + 指导 + 交接契约提醒 + 插话确认契约。
    assert.equal(env.transport.steerDelivered.length, 1)
    const delivered = env.transport.steerDelivered[0]!.text
    assert.ok(delivered.includes('wf_run0000000009'))
    assert.ok(delivered.includes('改用方案B'))
    assert.ok(delivered.includes('.helm/wf-out-'), '保留原文件交接契约提醒')
    // 任务收尾不受 steer 影响：按指导写交接文件 + 确认 receipt -> done -> 结果返回。
    const file = fileNameOf(taskCall.params['text'] as string)
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${file}`, 'done-result')
    writeConfirm(env, pane(), delivered)
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'done-result')
    assert.equal(existsSync(join(pane().cwd, '.helm', confirmFileOf(delivered))), false, '成功交接后确认文件被清理')
  } finally {
    await env.close()
  }
})

test('steer: 服务端未通告守卫能力 fail-closed（herdr_steer_guard_unsupported，零盲发）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 真实 0.9.5 pong：无 agent_prompt_guard_v1 字段。
    env.transport.pongCapabilities = { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1 }
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_guard_unsupported', 409)
    assert.ok(err.message.includes(AGENT_PROMPT_GUARD_CAPABILITY), '错误信息含能力字段名')
    assert.ok(err.message.includes('steer-test-server'), '错误信息含服务端版本诊断')
    assert.equal((err.details as Record<string, unknown>)['serverVersion'], 'steer-test-server')
    assert.equal(
      env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length,
      0,
      '绝不向未通告能力的服务端发送 guard 字段',
    )
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: 能力字段坏形状显式 herdr_protocol_violation，不把坏数据当能力判断', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.pongResultOverride = {
      type: 'pong', version: 'steer-test-server', protocol: 22,
      capabilities: { [AGENT_PROMPT_GUARD_CAPABILITY]: 'yes' },
    }
    await rejectsSteer(env, steerInput(pane()), 'herdr_protocol_violation')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 0)
  } finally {
    await env.close()
  }
})

test('steer: seq 竞态（人类预检后按键）stale_state 零写入、不重试，receipt 撤销后无确认可正常结算', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.raceSeqOnSteer = true
    await rejectsSteer(env, steerInput(pane()), 'stale_state')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 1, '绝不重试同一批输入')
    assert.deepEqual(env.transport.steerDelivered, [], 'stale 拒绝意味着零字节写入')
    // 零写入拒绝撤销 receipt：任务后续结算不需要插话确认（与未插话任务同语义）。
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`, 'ok')
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'ok', 'receipt 撤销后无确认文件也应正常交接')
  } finally {
    await env.close()
  }
})

test('steer: 非 working（idle）在服务端守卫拒绝（agent_not_ready）且零写入', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 预检后、投递前终端转入 idle（服务端守卫核验 working 失败；水位不变）。
    env.transport.raceStatusOnSteer = 'idle'
    await rejectsSteer(env, steerInput(pane()), 'agent_not_ready')
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: blocked 预检拒绝（审批桥负责），不投递不新建回合', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.advancePane(pane().paneId, 'blocked')
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_agent_blocked', 409)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 0)
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: 权威身份漂移（name 变化）拒绝且零投递', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const before = pane().name
    pane().name = 'human-took-over'
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_identity_mismatch', 409)
    pane().name = before
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: run/父会话强匹配——跨轨道插话拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    await rejectsSteer(env, steerInput(pane(), { workflowRunId: 'wf_other' }), 'herdr_steer_context_mismatch', 409)
    await rejectsSteer(env, steerInput(pane(), { parentConversationId: 2 }), 'herdr_steer_context_mismatch', 409)
    assert.deepEqual(env.transport.steerDelivered, [])
  } finally {
    await env.close()
  }
})

test('steer: 直调授权——非祖先 caller 拒绝（自报 conversationId 非认证）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    // 会话 2 与父会话 1 无祖先关系。
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_out_of_scope', 403, { conversationId: 2 })
    // 发起会话自身放行。
    const out = (await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()), { conversationId: 1 })) as Record<string, unknown>
    assert.equal(out['steered'], true)
  } finally {
    await env.close()
  }
})

test('steer: 按 pane 互斥——在途 steer 期间重入拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    env.transport.steerPromptDelayMs = 250
    const first = env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane())) as Promise<Record<string, unknown>>
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined))
    await rejectsSteer(env, steerInput(pane(), { text: '第二条' }), 'herdr_steer_in_flight', 409)
    assert.equal((await first)['steered'], true)
    assert.deepEqual(env.transport.steerDelivered.map((d) => d.text.includes('改用方案B')), [true], '仅第一条投递')
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
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, 'ok')
    }
    const { promise, pane } = await spawnRun(env)
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.start'))
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_phase', 409)
    assert.equal((err.details as Record<string, unknown>)['phase'], 'startup')
    // 解除挂起让任务正常收尾（不悬挂测试进程）。
    env.transport.holdStartup = false
    pane().agentStatus = 'idle'
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
    await waitFor(() => env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined).length >= 2)
    const err = await rejectsSteer(env, steerInput(pane()), 'herdr_steer_phase', 409)
    assert.equal((err.details as Record<string, unknown>)['phase'], 'handoff')
    // 自愈追问返回 idle 后补写文件完成任务。
    const healCall = env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)[1]!
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${fileNameOf(healCall.params['text'] as string)}`, 'healed')
    env.transport.advancePane(pane().paneId, 'idle')
    assert.equal(await promise, 'healed')
    // keepalive（已结算保活）：无在途任务，按非运行拒绝。
    await rejectsSteer(env, steerInput(pane()), 'herdr_steer_not_running', 409)
  } finally {
    await env.close()
  }
})

test('steer: 在途 steer 排空——首个 idle 不进交接，权威复查 working 回到等待，结果晚于 steer 且交接文件恰删一次', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    const filePath = `${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`
    // 交接文件首版已存在（若 driveTask 提前进交接会读到 v1 并提前结算）。
    env.transport.outputFiles.set(filePath, 'v1')
    // 在途 steer（慢 RPC）：期间任务首个 idle 到达。
    env.transport.steerPromptDelayMs = 300
    const steerPromise = env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined))
    env.transport.advancePane(pane().paneId, 'idle')
    await steerPromise
    // steer 消费使终端转 working；driveTask 权威复查后回到等待。
    await waitFor(() => pane().agentStatus === 'working')
    const steerIdx = env.transport.calls.findIndex((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined)
    assert.ok(
      env.transport.calls.some((c, i) => i > steerIdx && c.method === 'agent.get'),
      'steer 后必须权威复查 agent.get（不直接进交接）',
    )
    assert.equal(env.transport.orderLog.includes('steer-prompt'), true)
    // 覆写交接文件（模拟按指导重写结果）+ 写入匹配 receipt 后任务终态。
    env.transport.outputFiles.set(filePath, 'v2-guided')
    writeConfirm(env, pane(), env.transport.steerDelivered[0]!.text)
    env.transport.advancePane(pane().paneId, 'done')
    // 若 driveTask 在 steer 前误结算，此处会读到 v1；必须读到 v2。
    assert.equal(await promise, 'v2-guided')
    assert.equal(existsSync(filePath), false, '交接文件在成功交接后被删除（真实 fs 验证）')
  } finally {
    await env.close()
  }
})

test('steer: 投递后连接中断（不确定结果）真实错误上抛、不重发；保守保留 receipt 未确认不交付旧结果', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    const resultFile = `${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`
    env.transport.failAfterSteerWrite = true
    await rejectsSteer(env, steerInput(pane()), 'herdr_timeout')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 1, '不确定结果绝不重发')
    assert.equal(env.transport.steerDelivered.length, 1, '服务端已写入（不确定投递），客户端如实报错')
    // 原任务链不受扰地继续，但 receipt 保守保留：无确认不得把旧结果冒充交付。
    env.transport.failAfterSteerWrite = false
    env.transport.outputFiles.set(resultFile, 'final-without-confirm')
    env.transport.advancePane(pane().paneId, 'done')
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof HelmError)
    assert.equal(caught.code, 'herdr_steer_unconfirmed', '未确认插话不得以旧结果结算')
    assert.equal(existsSync(resultFile), true, '失败保留现场：旧结果文件不被删除')
    // 确认文件同样保留（未写入过），后续不再自动补发 prompt。
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 1)
  } finally {
    await env.close()
  }
})

test('steer: 窗格不受管 / nodeId 不一致 / 未连接均显式拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await waitFor(() => pane().agentStatus === 'working')
    await rejectsSteer(env, steerInput(pane(), { executionId: 'ws:unknown' }), 'not_found', 404)
    // 同 pane 不同 node：registry 精确 (nodeId, paneId) 定位，node-a 上不存在。
    await rejectsSteer(env, steerInput(pane(), { nodeId: 'node-a' }), 'not_found', 404)
    // 非法 nodeId。
    await rejectsSteer(env, steerInput(pane(), { nodeId: 'bad node!' }), 'validation_error', 400)
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

// ---------------------------------------------------------------------------
// 插话确认（receipt sidecar）：排队延迟、缺失/过期 receipt、成功核销
// ---------------------------------------------------------------------------

test('steer 确认: 旧结果 v1 已落盘且投递后仍 idle（CLI 队列未起步）——主链不读旧结果，确认 v2 后才结算', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    const resultFile = `${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`
    env.transport.outputFiles.set(resultFile, 'v1')
    await waitFor(() => pane().agentStatus === 'working')
    // CLI 队列尚未起步：投递后终端仍 idle（v1 已存在；若主链直接结算会读到 v1）。
    env.transport.steerConsumeStatus = 'idle'
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    assert.equal(env.transport.steerDelivered.length, 1)
    await waitFor(() => pane().agentStatus === 'idle')
    // 主链此刻处于有界等待（idle 无确认）：不得读/删 v1、不得跑 Gate。
    await waitFor(() => env.transport.calls.some((c) =>
      c.method === 'agent.wait' &&
      Array.isArray(c.params['until']) &&
      JSON.stringify(c.params['until']) === JSON.stringify(['working', 'blocked']) &&
      typeof c.params['timeout_ms'] === 'number',
    ))
    assert.equal(existsSync(resultFile), true, '确认前不得删除旧结果文件')
    // CLI 队列起步：按指导重写结果 + 写入匹配 receipt -> done。
    pane().agentStatus = 'working'
    pane().seq += 1
    env.transport.emit({ type: 'pane.updated', paneId: pane().paneId })
    env.transport.outputFiles.set(resultFile, 'v2-guided')
    writeConfirm(env, pane(), env.transport.steerDelivered[0]!.text)
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'v2-guided', '必须以确认后的 v2 结算，不得以 v1 成功')
    assert.equal(existsSync(resultFile), false, '成功交接后结果文件被清理')
  } finally {
    await env.close()
  }
})

test('steer 确认: 预算耗尽仍无确认——herdr_steer_unconfirmed 失败，旧结果保留、不自动补发', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ startupTimeoutMs: 3001 })
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    const resultFile = `${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`
    env.transport.outputFiles.set(resultFile, 'v1')
    await waitFor(() => pane().agentStatus === 'working')
    // 投递成功但 CLI 始终不消费、不确认（消费后仍 idle 且无确认文件）。
    env.transport.steerConsumeStatus = 'idle'
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    env.transport.advancePane(pane().paneId, 'idle')
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof HelmError)
    assert.equal(caught.code, 'herdr_steer_unconfirmed')
    assert.ok(caught.message.includes('receipt='), '诊断含 receipt')
    assert.equal(existsSync(resultFile), true, '失败保留现场：旧结果不被删除')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 1, '不自动补发 prompt')
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed', '窗格保留现场（failed）')
  } finally {
    await env.close()
  }
})

test('steer 确认: 确认文件内容与最新 receipt 不符——同样 herdr_steer_unconfirmed（v1/v2 不得冒充）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ startupTimeoutMs: 3001 })
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    const taskCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['guard'] === undefined)!
    const resultFile = `${pane().cwd}/.helm/${fileNameOf(taskCall.params['text'] as string)}`
    env.transport.outputFiles.set(resultFile, 'v1')
    await waitFor(() => pane().agentStatus === 'working')
    // 二次插话使最新 receipt 更新；CLI 只确认了旧 receipt（不匹配最新）。
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane(), { text: '第一次指导' }))
    await waitFor(() => env.transport.steerDelivered.length === 1)
    env.transport.advancePane(pane().paneId, 'working')
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane(), { text: '第二次指导' }))
    await waitFor(() => env.transport.steerDelivered.length === 2)
    env.transport.outputFiles.set(resultFile, 'v2-only-old-receipt')
    writeConfirm(env, pane(), env.transport.steerDelivered[0]!.text) // 旧 receipt
    env.transport.advancePane(pane().paneId, 'done')
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof HelmError)
    assert.equal(caught.code, 'herdr_steer_unconfirmed', '旧 receipt 不得核销最新插话')
    assert.equal(existsSync(resultFile), true)
  } finally {
    await env.close()
  }
})

test('steer 确认: 非法 JSON 或多余字段显式拒绝，保留结果现场', { timeout: 60_000 }, async () => {
  for (const raw of ['broken-json', 'null', '{"receipt":3}', '{"receipt":"old","extra":true}']) {
    const env = await makeEnv()
    try {
      env.transport.promptStatus = 'working'
      const { promise, pane } = await spawnRun(env)
      await taskPromptDelivered(env)
      await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
      const delivered = env.transport.steerDelivered[0]!.text
      const file = `${pane().cwd}/.helm/${confirmFileOf(delivered)}`
      env.transport.outputFiles.set(file, raw)
      env.transport.advancePane(pane().paneId, 'done')
      await assert.rejects(promise, (error: unknown) => (error as HelmError).code === 'herdr_steer_confirmation_invalid')
      assert.equal(existsSync(file), true)
    } finally {
      await env.close()
    }
  }
})

test('steer 确认: 后续插话被零写入拒绝时，仍核销前一次 receipt', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env)
    await taskPromptDelivered(env)
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    const delivered = env.transport.steerDelivered[0]!.text
    env.transport.raceSeqOnSteer = true
    await rejectsSteer(env, steerInput(pane(), { text: '不应投递的第二条' }), 'stale_state')
    const task = env.transport.calls.find((call) => call.method === 'agent.prompt' && call.params['guard'] === undefined)!
    env.transport.outputFiles.set(`${pane().cwd}/.helm/${fileNameOf(task.params['text'] as string)}`, 'first-guidance-result')
    writeConfirm(env, pane(), delivered)
    env.transport.advancePane(pane().paneId, 'done')
    assert.equal(await promise, 'first-guidance-result')
    assert.equal(env.transport.steerDelivered.length, 1)
  } finally {
    await env.close()
  }
})

test('steer 确认: JSON 业务 Schema 与确认文件分开验收', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    const { promise, pane } = await spawnRun(env, {
      schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    })
    await taskPromptDelivered(env)
    await env.host.invokeAction('builtin:herdr', 'steer', steerInput(pane()))
    const task = env.transport.calls.find((call) => call.method === 'agent.prompt' && call.params['guard'] === undefined)!
    const resultFile = `${pane().cwd}/.helm/${fileNameOf(task.params['text'] as string)}`
    env.transport.outputFiles.set(resultFile, JSON.stringify({ value: 42 }))
    writeConfirm(env, pane(), env.transport.steerDelivered[0]!.text)
    env.transport.advancePane(pane().paneId, 'done')
    assert.deepEqual(await promise, { value: 42 })
    assert.equal(existsSync(resultFile), false)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 取消/关闭与 steer 的交错
// ---------------------------------------------------------------------------

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
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined))
    abort()
    // 原任务以 aborted 真实终局（等待而非 sleep）。
    await assert.rejects(promise, (error: unknown) => (error as HelmError).code === 'aborted')
    // 在途单次请求如实终局：窗格已关闭，服务端以 agent_not_found 拒绝（零写入）。
    await assert.rejects(steerPromise, (error: unknown) => (error as { code?: string }).code === 'agent_not_found')
    assert.equal(env.transport.steerDelivered.length, 0, '取消后零写入')
    // 取消后不得发送新 prompt / resurrect（窗格已从 fixture 删除：坐标用快照）。
    await rejectsSteer(env, steerInput(paneState), 'herdr_steer_not_running', 409)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt' && c.params['guard'] !== undefined).length, 1, '仅原始单次尝试')
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

test('steer: 原 task 挂在 Gate 期间拒绝插话；Gate 恰好一次不被替代', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'working'
    env.transport.onPrompt = (pane, text) => {
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, 'gated-result')
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
