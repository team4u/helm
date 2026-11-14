/**
 * agent.send_keys 协议级 CAS 契约回归（helm 侧闭环；等待 Herdr 服务端配套）。
 *
 * 背景（服务端源码只读核实，/root/code/herdr，herdr 0.9.5 / protocol 22）：
 * - AgentSendKeysParams 仅 {target, keys}，无 CAS 字段；serde 无
 *   deny_unknown_fields——盲发 expected_state_seq 会被旧服务端静默忽略并照常写键；
 * - ping -> pong(version, protocol, capabilities) 是官方能力通告通道。
 *
 * helm 侧契约（见 rpc.ts 注释）：pong.capabilities.send_keys_expected_state_seq
 * 通告能力；请求携带 wire 字段 expected_state_seq；服务端 seq 不符时回
 * stale_state 且键不发送。
 *
 * 覆盖：
 * - 纯契约：buildSendKeysParams 边界校验与 wire 字段名；parsePong 严格边界
 *  （通告/缺省/坏形状显式违约）；isStaleStateError 判定；
 * - 全链路（真实 PluginHost + 真实 UDS 行协议 fixture）：
 *   a) 服务端通告能力时，审批回答后的 send_keys 请求携带
 *      expected_state_seq === Ask 条目 seq，且 ping 探测恰好一次（按 target 冻结）；
 *   b) 服务端 stale_state 拒绝（模拟人类竞态按键推进 seq）：不重试同一批
 *      keys、不记发送成功、Ask 状态安全收敛（主循环按权威状态继续）；
 *   c) 服务端未通告能力（真实 0.9.5 pong 形状）：显式 herdr_cas_unsupported
 *      失败，绝不盲发无 CAS 键；
 *   d) pong 坏形状：显式 herdr_protocol_violation，绝不把坏数据当能力判断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  buildSendKeysParams,
  isStaleStateError,
  parsePong,
  SEND_KEYS_CAS_CAPABILITY,
} from '../src/builtin-plugins/herdr/rpc.js'

// ---------------------------------------------------------------------------
// 纯契约：buildSendKeysParams / parsePong / isStaleStateError
// ---------------------------------------------------------------------------

test('契约: buildSendKeysParams 产出 wire 字段 expected_state_seq 并拒绝非法入参', { timeout: 60_000 }, () => {
  const params = buildSendKeysParams({ target: 'ws:p1', keys: ['y'], expectedStateSeq: 41 })
  assert.deepEqual(params, { target: 'ws:p1', keys: ['y'], expected_state_seq: 41 })
  assert.throws(() => buildSendKeysParams({ target: '', keys: ['y'], expectedStateSeq: 1 }), HelmError)
  assert.throws(() => buildSendKeysParams({ target: 'p', keys: [], expectedStateSeq: 1 }), HelmError)
  assert.throws(() => buildSendKeysParams({ target: 'p', keys: [''], expectedStateSeq: 1 }), HelmError)
  assert.throws(() => buildSendKeysParams({ target: 'p', keys: ['y'], expectedStateSeq: -1 }), HelmError)
  assert.throws(() => buildSendKeysParams({ target: 'p', keys: ['y'], expectedStateSeq: 1.5 }), HelmError)
  assert.throws(() => buildSendKeysParams({ target: 'p', keys: ['y'], expectedStateSeq: Number.MAX_SAFE_INTEGER + 1 }), HelmError)
})

test('契约: parsePong 严格边界——通告 true 才支持，缺省如实不支持，坏形状显式违约', { timeout: 60_000 }, () => {
  const supported = parsePong({
    type: 'pong',
    version: '0.9.6-dev',
    protocol: 22,
    capabilities: { live_handoff: false, [SEND_KEYS_CAS_CAPABILITY]: true },
  })
  assert.equal(supported.sendKeysCas, true)
  assert.equal(supported.version, '0.9.6-dev')
  assert.equal(supported.protocol, 22)

  // 缺省路径（真实 0.9.5 pong 无 CAS 字段）：不支持，不抛错。
  const realOldServer = parsePong({
    type: 'pong',
    version: '0.9.5',
    protocol: 22,
    capabilities: { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1 },
  })
  assert.equal(realOldServer.sendKeysCas, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22 }).sendKeysCas, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: null }).sendKeysCas, false)
  assert.equal(
    parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: false } }).sendKeysCas,
    false,
  )

  // 坏形状：显式 herdr_protocol_violation，绝不静默当不支持。
  const violations: Array<unknown> = [
    { type: 'ok' },
    { type: 'pong', protocol: 22 },
    { type: 'pong', version: '', protocol: 22 },
    { type: 'pong', version: 'v' },
    { type: 'pong', version: 'v', protocol: '22' },
    { type: 'pong', version: 'v', protocol: -1 },
    { type: 'pong', version: 'v', protocol: 22, capabilities: 'none' },
    { type: 'pong', version: 'v', protocol: 22, capabilities: [] },
    { type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: 'yes' } },
  ]
  for (const bad of violations) {
    assert.throws(() => parsePong(bad), (error: unknown) => (error as HelmError).code === 'herdr_protocol_violation')
  }
})

test('契约: isStaleStateError 只认 stale_state 错误码', { timeout: 60_000 }, () => {
  assert.equal(isStaleStateError(new HelmError('stale_state', 'seq mismatch', 409)), true)
  assert.equal(isStaleStateError({ code: 'stale_state' }), true)
  assert.equal(isStaleStateError(new HelmError('herdr_timeout', 'no response', 504)), false)
  assert.equal(isStaleStateError(new Error('plain')), false)
  assert.equal(isStaleStateError(undefined), false)
})

// ---------------------------------------------------------------------------
// 受控 FakeTransport（最小面：审批桥 CAS 全链路所需方法）
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
}

function agentInfoOf(pane: PaneState) {
  return {
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

class CasFakeTransport implements HerdrTransport {
  panes = new Map<string, PaneState>()
  tabs = new Map<string, { closed: boolean }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  sendKeysLog: Array<{ paneId: string; keys: string[] }> = []
  outputFiles = new FsOutputFiles()
  eventListeners: Array<(e: HerdrEvent) => void> = []
  promptStatus: PaneStatus | Array<PaneStatus> = 'idle'
  onPrompt: ((pane: PaneState, text: string) => void) | undefined
  /** ping capabilities 通告：缺省模拟支持 CAS 的服务端；可改写模拟旧服务端。 */
  pongCapabilities: Record<string, unknown> | null = {
    live_handoff: false,
    detached_server_daemon: false,
    endpoint_protocol_generation: 1,
    [SEND_KEYS_CAS_CAPABILITY]: true,
  }
  /** 覆盖 pong 原始响应（坏形状边界测试）；设置后忽略 pongCapabilities。 */
  pongResultOverride: unknown
  /** send_keys 到达时先模拟人类竞态按键（seq+1 且转 working）再校验 CAS：稳定触发 stale_state。 */
  raceKeysOnSend = false

  private paneOf(ref: unknown): PaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
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
          version: 'cas-test-server',
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
        this.panes.set(paneId, { paneId, tabId, workspaceId, agentStatus: 'idle', seq: 1, cwd: paneCwd })
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
        return { type: 'ok' }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.agentStatus = 'idle'
        pane.seq += 1
        return { type: 'agent_started', agent: agentInfoOf(pane), argv: [] }
      }
      case 'agent.get': {
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        const until = ((params['until'] as string[]) ?? []).map((s) => s as PaneStatus)
        for (let i = 0; i < 2_000; i += 1) {
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          await delay(10)
        }
        throw new HelmError('timeout', 'timed out waiting for agent status', 408)
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        const script = this.promptStatus
        pane.agentStatus = Array.isArray(script) ? (script.shift() ?? 'idle') : script
        pane.seq += 1
        if (this.onPrompt) this.onPrompt(pane, text)
        this.emit({ type: 'pane.updated', paneId: pane.paneId })
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.read': {
        const pane = this.paneOf(params['target'])
        return { type: 'pane_read', read: { pane_id: pane.paneId, text: `tail of ${pane.paneId}` } }
      }
      case 'agent.send_keys': {
        // 未来服务端 CAS 行为：先应用竞态推进（可选），再校验
        // expected_state_seq；不符即 stale_state 且键不写入。
        const pane = this.paneOf(params['target'])
        if (this.raceKeysOnSend) {
          pane.seq += 1
          pane.agentStatus = 'working'
        }
        const expected = params['expected_state_seq']
        if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
          throw new HelmError('invalid_params', 'agent.send_keys 必须携带非负整数 expected_state_seq（CAS 契约）', 400)
        }
        if (expected !== pane.seq) {
          throw new HelmError('stale_state', `expected_state_seq=${expected} 与当前 state_change_seq=${pane.seq} 不符，按键未发送`, 409)
        }
        this.sendKeysLog.push({ paneId: pane.paneId, keys: params['keys'] as string[] })
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
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
    return content
  }

  async removeOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.outputFiles.delete(`${cwd}/.helm/${fileName}`)
  }

  async runGate(): Promise<{ ok: boolean; output: string }> {
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
// 测试环境（completeBackend 桩 + 真实 PluginHost + 真实 UDS 行协议）
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

function makeConversation(id: number, cwd: string): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
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

interface Env {
  host: PluginHost
  transport: CasFakeTransport
  dataDir: string
  createdAsks: Array<Record<string, unknown>>
  cancelledAsks: Array<{ id: string; reason?: string }>
  notifications: Array<{ title: string; body: string; level: string }>
  answerAsk(id: string, result: AskResult): void
  close(): Promise<void>
}

async function makeEnv(options: { transport?: CasFakeTransport } = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-cas-'))
  const parentCwd = join(dataDir, 'parent')
  mkdirSync(parentCwd, { recursive: true })
  const transport = options.transport ?? new CasFakeTransport()
  const createdAsks: Array<Record<string, unknown>> = []
  const cancelledAsks: Array<{ id: string; reason?: string }> = []
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const pendingAskResolvers = new Map<string, (r: AskResult) => void>()
  const conversation = makeConversation(1, parentCwd)
  const backend = completeBackend({
    conversations: new Map<number, ConversationSummary>([[1, conversation]]),
    getConversation: (id: number) => {
      const found = id === 1 ? conversation : undefined
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return found
    },
    listConversations: () => [conversation],
    nodeIpc: {
      isOnline: () => true,
      call: async () => { throw new HelmError('unsupported', '本 CAS fixture 无节点 IPC', 501) },
      subscribe: async () => { throw new HelmError('unsupported', '本 CAS fixture 无节点 IPC 订阅', 501) },
    },
    buildSpawnEnv: (_conversationId: number, cwd: string) => ({ HELM_TOKEN: 'SECRET-TOKEN', HELM_CWD: cwd }),
    runGate: async () => ({ ok: true, output: 'gate ok' }),
    createAsk: async (spec: { id?: string }) => {
      const id = spec.id ?? `ask-${createdAsks.length + 1}`
      createdAsks.push({ ...spec, id })
      return new Promise<AskResult>((resolve) => pendingAskResolvers.set(id, resolve))
    },
    cancelAsk: async (id: string, reason?: 'cancelled' | 'superseded') => {
      cancelledAsks.push({ id, reason })
      pendingAskResolvers.get(id)?.({ id, status: reason === 'cancelled' ? 'cancelled' : 'superseded', answers: {} })
      pendingAskResolvers.delete(id)
    },
    emitEvent: (type: string, payload: unknown) => {
      if (type === 'notification') {
        const n = payload as { title: string; body: string; level: string }
        notifications.push(n)
      }
    },
  }) as PluginHostBackend & {
    conversations: Map<number, ConversationSummary>
  }
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore(), config: new MemoryConfigStore({ socketPath }) })
  await host.register(createHerdrPlugin(), { enabled: true })
  return {
    host,
    transport,
    dataDir,
    createdAsks,
    cancelledAsks,
    notifications,
    answerAsk(id, result) {
      pendingAskResolvers.get(id)?.(result)
      pendingAskResolvers.delete(id)
    },
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 直接调用 spawn hook（父会话 1；返回 handled result）。 */
async function spawnDirect(env: Env, request: Record<string, unknown> = {}): Promise<unknown> {
  const outcome = await env.host.runHook('agent_spawn', {
    parentConversationId: 1,
    prompt: 'do the thing',
    ...request,
  } as never)
  if (outcome.action === 'handled') return outcome.result
  throw new HelmError('herdr_cas_unsupported', 'spawn 未被 herdr 插件接管（fixture 缺陷）', 500)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await delay(intervalMs)
  }
}

function fileNameOf(text: string): string {
  return text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
}

/** 提交 prompt 并落盘交接文件（任务终态前写入）。 */
function prepareOutput(env: Env): void {
  env.transport.promptStatus = 'blocked'
  env.transport.onPrompt = (pane, text) => {
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, 'approved')
  }
}

// ---------------------------------------------------------------------------
// 全链路：能力通告 -> CAS 请求；stale_state；未通告；pong 坏形状
// ---------------------------------------------------------------------------

test('审批桥 CAS: 能力通告时 send_keys 携带 expected_state_seq=条目 seq，ping 探测恰好一次', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    prepareOutput(env)
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.createdAsks.length === 1)
    const askId = String(env.createdAsks[0]!['id'])
    const entrySeq = Number(askId.slice(askId.lastIndexOf(':') + 1))
    assert.ok(Number.isSafeInteger(entrySeq) && entrySeq > 0, `askId 应携带 seq：${askId}`)
    env.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    // ping 能力探测恰好一次（同 target 冻结），且先于 send_keys。
    const pingCalls = env.transport.calls.filter((c) => c.method === 'ping')
    assert.equal(pingCalls.length, 1, 'ping 探测按 target 冻结，恰好一次')
    const sendCall = env.transport.calls.find((c) => c.method === 'agent.send_keys')!
    assert.ok(sendCall !== undefined, '必须发出 send_keys')
    assert.ok(env.transport.calls.indexOf(pingCalls[0]!) < env.transport.calls.indexOf(sendCall), 'ping 先于 send_keys')
    assert.equal(sendCall.params['expected_state_seq'], entrySeq, 'wire 字段 expected_state_seq === Ask 条目 seq')
    assert.deepEqual(sendCall.params['keys'], ['y'])
    assert.equal(sendCall.params['target'], env.transport.sendKeysLog[0]!.paneId)
    // 正常 ack：终端消化 -> done -> 交接成功。
    const pane = [...env.transport.panes.values()][0]!
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
    assert.ok(env.notifications.some((n) => n.title === 'Herdr 审批已发送'))
  } finally {
    await env.close()
  }
})

test('审批桥 CAS: stale_state 拒绝时不重试、不记发送成功、Ask 安全收敛', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    prepareOutput(env)
    env.transport.raceKeysOnSend = true // 人类竞态按键：send_keys 到达时 seq 已推进
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.createdAsks.length === 1)
    const askId = String(env.createdAsks[0]!['id'])
    env.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.calls.filter((c) => c.method === 'agent.send_keys').length === 1)
    // 恰好一次尝试；键从未写入终端（stale = 未发送按键）。
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 1, 'stale 后绝不重试同一批 keys')
    assert.deepEqual(env.transport.sendKeysLog, [], 'stale 拒绝意味着键未发送')
    await waitFor(() => env.notifications.some((n) => n.title === 'Herdr 审批已过时'))
    assert.ok(!env.notifications.some((n) => n.title === 'Herdr 审批已发送'), '不得记发送成功')
    // Ask 状态安全收敛：竞态推进后（working 新 seq）不重建 Ask；重复事件不触发重发。
    const pane = [...env.transport.panes.values()][0]!
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(150)
    assert.equal(env.createdAsks.length, 1, '终端已推进（working）不重建 Ask')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 1, '重复事件不重发键')
    // 主循环按权威状态收敛：done + 交接文件 -> 任务成功（未被 stale 击穿）。
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
  } finally {
    await env.close()
  }
})

test('审批桥 CAS: 服务端未通告能力时显式 herdr_cas_unsupported，绝不盲发', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    prepareOutput(env)
    // 真实 0.9.5 pong 形状：无 CAS 能力字段。
    env.transport.pongCapabilities = {
      live_handoff: false,
      detached_server_daemon: false,
      endpoint_protocol_generation: 1,
    }
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.createdAsks.length === 1)
    const askId = String(env.createdAsks[0]!['id'])
    env.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'herdr_cas_unsupported')
      assert.ok(error.message.includes(SEND_KEYS_CAS_CAPABILITY), '错误信息含能力字段名')
      assert.ok(error.message.includes('cas-test-server'), '错误信息含服务端版本诊断')
      return true
    })
    // 能力门禁在 send_keys 之前拦截：零盲发。
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 0, '绝不发出无 CAS 的 send_keys')
    assert.deepEqual(env.transport.sendKeysLog, [])
    assert.ok(!env.notifications.some((n) => n.title === 'Herdr 审批已发送'))
    // 失败窗格保留现场（outcome=failed）。
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed')
  } finally {
    await env.close()
  }
})

test('审批桥 CAS: pong 坏形状显式 herdr_protocol_violation，不把坏数据当能力判断', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    prepareOutput(env)
    env.transport.pongResultOverride = { type: 'ok' }
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.createdAsks.length === 1)
    const askId = String(env.createdAsks[0]!['id'])
    env.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'herdr_protocol_violation')
      return true
    })
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 0)
  } finally {
    await env.close()
  }
})
