/**
 * 双插件联调：builtin:workflow（真实 WorkflowService）+ builtin:herdr（真实
 * 执行器）经同一 PluginHost 串起后台 Herdr 子代理的 steer 全链路。
 *
 * 链路：subagent(background:true, agentType:'herdr:agy') → WorkflowService
 * durable run → agent_spawn 钩子 → HerdrExecutor 建窗（onResolved 回传
 * controls.steer）→ workflow.steer 按节点 controls 动态委托 herdr.steer →
 * 预检 + 现有 agent.prompt 投递（guardLevel='preflight'）→ 原文件交接 /
 * Gate / 父会话结算通知照常（插话以全新唯一交接文件重定向，旧路径作废）。
 *
 * fixture 语义（真实协议，herdr 0.9.5 / protocol 22）：pong 为真实形状（无
 * 拟议守卫能力字段）；agent.prompt(target, text, wait?) 按官方形状模拟——
 * 任务 prompt 携带 wait（target 为 paneId），插话不携带 wait（target 为受管
 * agentName），绝不依赖拟议 guard 字段识别插话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HelmError,
  WORKFLOW_PLUGIN_ID,
  type AgentSpawnRequest,
  type ConversationSummary,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { PluginHost, type PluginConfigStore, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'
import { completeBackend } from './helpers/host-backend-stub.js'
import { FsOutputFiles, serveTransport } from './helpers/herdr-unit-fixture.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import { SEND_KEYS_CAS_CAPABILITY } from '../src/builtin-plugins/herdr/rpc.js'

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface PaneState {
  paneId: string
  tabId: string
  workspaceId: string
  agentStatus: PaneStatus
  seq: number
  name?: string
  cwd: string
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

/** 真实 protocol 22 形状的受控服务端（agent.prompt admission 语义如实模拟）。 */
class ProtocolServerTransport implements HerdrTransport {
  panes = new Map<string, PaneState>()
  tabs = new Map<string, { closed: boolean }>()
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  outputFiles = new FsOutputFiles()
  steerDelivered: Array<{ paneId: string; text: string }> = []
  promptStatus: PaneStatus = 'working'
  eventListeners: Array<(e: HerdrEvent) => void> = []

  private paneOf(ref: unknown): PaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    let pane = this.panes.get(id) ?? [...this.panes.values()].find((p) => p.name === id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  async call(_target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    switch (method) {
      case 'ping':
        // 真实 0.9.5 pong 形状：无任何拟议插话守卫能力字段。
        return {
          type: 'pong', version: '0.9.5', protocol: 22,
          capabilities: { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1, [SEND_KEYS_CAS_CAPABILITY]: true },
        }
      case 'tab.create': {
        const n = this.panes.size + 1
        const workspaceId = 'ws-default'
        const paneId = `${workspaceId}:p${n}`
        const tabId = `${workspaceId}:t${n}`
        const paneCwd = (params['cwd'] as string) ?? '/tmp'
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
        const tab = this.tabs.get(params['tab_id'] as string)
        if (!tab) throw new HelmError('tab_not_found', 'no tab', 404)
        tab.closed = true
        for (const [id, pane] of this.panes) if (pane.tabId === params['tab_id']) this.panes.delete(id)
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
        for (let i = 0; i < 4_000; i += 1) {
          if (!this.panes.has(pane.paneId)) throw new HelmError('agent_not_found', 'pane closed', 404)
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          await delay(10)
        }
        throw new HelmError('timeout', 'timed out', 408)
      }
      case 'agent.prompt': {
        // 分支判别（真实协议形状）：任务 prompt 携带 wait；插话不携带 wait 且
        // 以受管 agentName 寻址——绝不依赖任何拟议 guard 字段。
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        if (params['wait'] === undefined) {
          // 真实 admission：launch_pending / blocked 零写入拒绝；预检 working
          // 后刚转 idle 的提交接续新回合。
          if (pane.launchPending === true) throw new HelmError('agent_not_ready', 'launch_pending，输入未写入', 409)
          if (pane.agentStatus === 'blocked') throw new HelmError('agent_blocked', 'blocked，输入未写入', 409)
          pane.seq += 1
          pane.agentStatus = 'working'
          this.steerDelivered.push({ paneId: pane.paneId, text })
          this.emit({ type: 'pane.updated', paneId: pane.paneId })
          return { type: 'agent_prompted', agent: agentInfoOf(pane) }
        }
        pane.agentStatus = this.promptStatus
        pane.seq += 1
        // 任务 prompt 一到即落盘交接文件（模拟 CLI 按原契约交付首版结果）。
        const fileName = text.match(/wf-out-[A-Za-z0-9_.-]+\.(?:json|md)/)?.[0]
        if (fileName !== undefined) this.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'task-done')
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
          throw new HelmError('stale_state', 'CAS 水位不符，按键未发送', 409)
        }
        return { type: 'ok' }
      }
      case 'pane.report_metadata':
        return { type: 'ok' }
      case 'session.snapshot':
        return { type: 'session_snapshot', snapshot: { version: 'test', protocol: 22, workspaces: [], tabs: [], panes: [], agents: [] } }
      default:
        throw new HelmError('method_not_found', `protocol fixture 不支持 ${method}`, 400)
    }
  }

  async readOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) throw new HelmError('herdr_output_missing', `交接文件不存在: ${fileName}`, 404)
    return content
  }

  async removeOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.outputFiles.delete(`${cwd}/.helm/${fileName}`)
  }

  async runGate(): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: 'gate ok' }
  }

  async subscribe(
    _t: HerdrTarget,
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

  /**
   * 终端进入 idle/done 时模拟 CLI 完成交接：有插话则按最新指导把最终结果
   * 写入插话指定的全新唯一文件（旧路径残写的首版仍在，但已作废）。
   */
  advancePane(paneId: string, status: PaneStatus): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.agentStatus = status
    pane.seq += 1
    if (status === 'idle' || status === 'done') {
      const delivered = this.steerDelivered.filter((entry) => entry.paneId === paneId).at(-1)?.text
      if (delivered !== undefined) {
        const file = delivered.match(/写入新文件 [^\n]*?\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
        assert.ok(file !== undefined, '插话文本应含新交接文件名')
        this.outputFiles.set(`${pane.cwd}/.helm/${file}`, 'steered-done')
      }
    }
    this.emit({ type: 'pane.updated', paneId })
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
    for (const key of [...this.store.keys()]) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const id = Number(key.split('\0')[2])
      if (Number.isSafeInteger(id) && id > 0) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  async flush(): Promise<void> {}
}

class MemoryConfigStore implements PluginConfigStore {
  constructor(private readonly initial: Record<string, unknown> = {}) {}
  get(): Record<string, unknown> { return this.initial }
  set(): void {}
}

interface Env {
  host: PluginHost
  transport: ProtocolServerTransport
  dataDir: string
  parentNotifications: Array<{ conversationId: number; text: string; meta: Record<string, unknown> }>
  gateCalls: number[]
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-steer-wf-'))
  const parentCwd = join(dataDir, 'parent')
  mkdirSync(parentCwd, { recursive: true })
  const transport = new ProtocolServerTransport()
  const conversation1: ConversationSummary = {
    id: 1,
    title: 'conv-1',
    profileId: 'assistant',
    tags: [],
    cwd: parentCwd,
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
  const conversations = new Map<number, ConversationSummary>([[1, conversation1]])
  const parentNotifications: Array<{ conversationId: number; text: string; meta: Record<string, unknown> }> = []
  const gateCalls: number[] = []
  const hostRef: { current?: PluginHost } = {}
  const backend = completeBackend({
    conversations,
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    listConversations: () => [...conversations.values()],
    // 模拟内核 agent_spawn 管道：钩子链（herdr 拦截）→ 原生兜底（fixture 不可用）。
    spawnAgent: (request: AgentSpawnRequest) =>
      hostRef.current!.runHookAround('agent_spawn', request, async () => {
        throw new HelmError('spawn_native_unavailable', 'fixture：本环境仅 herdr 路由', 500)
      }),
    submitInput: (conversationId: number, text: string, opts?: { meta?: Record<string, unknown> }) => {
      parentNotifications.push({ conversationId, text, meta: opts?.meta ?? {} })
      return Promise.resolve()
    },
    runGate: async () => {
      gateCalls.push(1)
      return { ok: true, output: 'gate ok' }
    },
    nodeIpc: {
      isOnline: () => true,
      call: async () => { throw new HelmError('unsupported', 'fixture 无节点 IPC', 501) },
      subscribe: async () => { throw new HelmError('unsupported', 'fixture 无节点 IPC 订阅', 501) },
    },
    buildSpawnEnv: (_conversationId: number, cwd: string) => ({ HELM_TOKEN: 'SECRET-TOKEN', HELM_CWD: cwd }),
    createAsk: async () => new Promise(() => {}),
    cancelAsk: async () => {},
    emitEvent: () => {},
  }) as PluginHostBackend & { conversations: Map<number, ConversationSummary> }
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    sessionDocs: new MemorySessionDocStore(),
    config: new MemoryConfigStore({ socketPath }),
  })
  hostRef.current = host
  await host.register(createHerdrPlugin(), { enabled: true })
  await host.register(createWorkflowPlugin())
  return {
    host,
    transport,
    dataDir,
    parentNotifications,
    gateCalls,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await delay(intervalMs)
  }
}

test('双插件联调: 真实形状服务端上 herdr 后台 run 经 workflow.steer 委托投递（guardLevel=preflight），最新文件交接/Gate 恰一次、父通知正常', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 1) 发起后台 herdr 子代理 run（真实 WorkflowService durable 记录）。
    const started = (await env.host.executeTool(
      'subagent',
      { prompt: '慢任务', background: true, agentType: 'herdr:agy', gate: 'true' },
      { conversationId: 1, callId: 'call-1' },
    )) as { structuredOutput: { runId: string; execution?: Record<string, unknown> } }
    const runId = started.structuredOutput.runId
    assert.ok(typeof runId === 'string' && runId !== '')
    // 2) 任务 prompt 已投递且终端 working。
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['wait'] !== undefined))
    const pane = [...env.transport.panes.values()][0]!
    await waitFor(() => pane.agentStatus === 'working')
    const taskFileName = (() => {
      const text = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['wait'] !== undefined)!.params['text'] as string
      const name = text.match(/写入[^\n]*?\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
      assert.ok(name !== undefined)
      return name
    })()
    // 3) run 节点已回传 controls.steer + 外部执行坐标。
    const before = (await env.host.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId }, { conversationId: 1 })) as { run: WorkflowRunSummary }
    const node = (before.run.nodes ?? [])[0]
    assert.ok(node !== undefined)
    assert.equal(node.executionId, pane.paneId)
    assert.equal(node.nodeId, 'local')
    assert.deepEqual(node.controls?.steer, { pluginId: 'builtin:herdr', actionId: 'steer' })
    // 4) 经 workflow.steer 插话：按节点 controls 动态委托（外部分支）。
    const out = (await env.host.invokeAction(
      WORKFLOW_PLUGIN_ID,
      'steer',
      { runId, text: '改用方案B' },
      { conversationId: 1 },
    )) as Record<string, unknown>
    assert.deepEqual(
      { ...out, runId: undefined },
      {
        steered: true,
        runId: undefined,
        targetKind: 'external',
        executionId: pane.paneId,
        nodeId: 'local',
        ownership: 'helm',
        stateChangeSeq: out['stateChangeSeq'],
        guardLevel: 'preflight',
      },
    )
    assert.equal(typeof out['stateChangeSeq'], 'number', '预检观测水位如实透传')
    assert.equal(env.transport.steerDelivered.length, 1, 'steer 恰好投递一次')
    assert.ok(env.transport.steerDelivered[0]!.text.includes('改用方案B'))
    const steerCall = env.transport.calls.find((c) => c.method === 'agent.prompt' && c.params['wait'] === undefined)!
    assert.ok(steerCall !== undefined)
    assert.deepEqual(Object.keys(steerCall.params).sort(), ['target', 'text'], '现有 agent.prompt 形状（无 wait/无附加字段）')
    assert.equal(steerCall.params['target'], pane.name, '以受管 agentName 寻址')
    const steerText = env.transport.steerDelivered[0]!.text
    const newFile = steerText.match(/写入新文件 [^\n]*?\.helm\/(wf-out-[A-Za-z0-9_.-]+\.(?:json|md))/)?.[1]
    assert.ok(newFile !== undefined, '投递文本指向全新唯一交接文件')
    assert.notEqual(newFile, taskFileName)
    assert.ok(steerText.includes(`原交接文件 ${taskFileName} 已作废`), '投递文本明确旧路径作废')
    // 5) 任务终态：CLI 按最新指导写新文件 -> 原 run 交接 / Gate 恰一次 / 父通知正常。
    env.transport.advancePane(pane.paneId, 'done')
    await waitFor(async () => {
      const { run } = (await env.host.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId }, { conversationId: 1 })) as { run: WorkflowRunSummary }
      return run.status === 'completed'
    })
    const final = (await env.host.invokeAction(WORKFLOW_PLUGIN_ID, 'inspect', { runId }, { conversationId: 1 })) as { run: WorkflowRunSummary }
    assert.equal(final.run.status, 'completed')
    assert.equal(final.run.result, 'steered-done', '最新唯一交接文件内容成为 run 结果')
    assert.equal(env.gateCalls.length, 1, 'Gate 恰好执行一次')
    assert.equal(
      env.parentNotifications.filter((n) => n.meta['backgroundRunId'] === runId).length,
      1,
      '父会话结算通知恰好一次',
    )
    // 新旧交接文件成功后均已清理（真实 fs）。
    assert.equal(existsSync(join(pane.cwd, '.helm', newFile)), false, '最新交接文件被删除')
    assert.equal(existsSync(join(pane.cwd, '.helm', taskFileName)), false, '作废旧文件被清理')
  } finally {
    await env.close()
  }
})

test('双插件联调: 跨树会话经 workflow.steer 对外部执行同样拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const started = (await env.host.executeTool(
      'subagent',
      { prompt: '慢任务', background: true, agentType: 'herdr:agy' },
      { conversationId: 1, callId: 'call-1' },
    )) as { structuredOutput: { runId: string } }
    const runId = started.structuredOutput.runId
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt' && c.params['wait'] !== undefined))
    let caught: unknown
    try {
      // 会话 2 不存在（非祖先）：拒绝。
      await env.host.invokeAction(WORKFLOW_PLUGIN_ID, 'steer', { runId, text: 'x' }, { conversationId: 2 })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof HelmError)
    assert.equal(caught.code, 'steer_out_of_scope')
    assert.equal(env.transport.steerDelivered.length, 0)
  } finally {
    await env.close()
  }
})
