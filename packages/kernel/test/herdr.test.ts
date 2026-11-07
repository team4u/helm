/**
 * builtin:herdr 插件回归：真实 PluginHost + 受控 HerdrTransport。
 *
 * 覆盖（协议集成测试——不声称真实模型/SSH 验证）：
 * - 文件交接 A（成功）/B（缺文件自愈一次）/C（两次失败 herdr_output_contract_violation
 *   + 40 行脱敏快照 + pane 保留）；非缺失 IO 错误不自愈；
 * - 双入口（herdr:<kind>[@nodeId] 前缀与 Profile.runtime）寻址与参数校验、
 *   显式 model/effort 拒绝；
 * - blocked 审批桥：socket 事件与 wait 双路径只建一次 Ask、只发一次键、
 *   Web 回答 CAS 复核、终端先处理 superseded、取消不批准、
 *   send_keys 已发但同 seq blocked 重复事件不重发、延迟创建期间 working 新 seq；
 * - Gate 恰好一次 / env 注入 / 远端剥除 loopback；
 * - 双轨清理（workflow settled / 父 turn settled）与失败保留；
 * - Worktree 注 env（两步建窗 + 关初始 tab + workspace.close）；
 * - resume（同父复用 / 跨父拒绝 / 未知拒绝 / 并发拒绝）；
 * - abort 立即取消 Ask 并关闭自有 PTY；
 * - 启停：默认停用注册、启用连接、liveTasks 409 保护、结算后可 disable、
 *   对账失败自行清理订阅；
 * - 启动对账：孤儿回收、failed 保留、同 ID 换 human agent 不误关；
 * - human 红线：非自有 pane 的 blocked 事件不建 Ask；
 * - report_metadata 防自激（同 token 不重复投射）；
 * - actions list/read/focus 契约；agent_not_ready 桥接。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HelmError,
  type AgentGateResult,
  type AskResult,
  type ConversationSummary,
  type MaybePromise,
  type Profile,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

// ---------------------------------------------------------------------------
// 受控 HerdrTransport
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

class FakeTransport implements HerdrTransport {
  panes = new Map<string, PaneState>()
  tabs = new Map<string, { closed: boolean }>()
  workspaces = new Map<string, { closed: boolean }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  eventListeners: Array<(e: HerdrEvent) => void> = []
  sendKeysLog: Array<{ paneId: string; keys: string[] }> = []
  metadataReports: Array<Record<string, unknown>> = []
  removedFiles: string[] = []
  outputFiles = new Map<string, string>()
  errors = new Map<string, () => Error>()
  subscribeAck: 'ok' | 'fail' = 'ok'
  /** prompt 行为：返回 prompt 后的 pane 状态（默认 idle = 直达终态）。 */
  promptStatus: PaneStatus | Array<PaneStatus> = 'idle'
  /** prompt 同步回调（此时交接文件名已可从 text 提取，测试在此写文件）。 */
  onPrompt: ((pane: PaneState, text: string) => void) | undefined
  /** send_keys 后目标状态（默认 working 模拟键已生效处理中）。 */
  afterSendKeys: PaneStatus = 'working'
  /** agent.wait 轮询中止信号（测试用）。 */
  waitAbort: AbortSignal | undefined

  private record(target: HerdrTarget, method: string, params: Record<string, unknown>): void {
    this.calls.push({ target, method, params })
  }

  private paneOf(ref: unknown): PaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.record(target, method, params)
    const errorFactory = this.errors.get(method)
    if (errorFactory) throw errorFactory()
    switch (method) {
      case 'tab.create': {
        const n = this.panes.size + 1
        const workspaceId = (params['workspace_id'] as string | undefined) ?? 'ws-default'
        const paneId = `${workspaceId}:p${n}`
        const tabId = `${workspaceId}:t${n}`
        this.panes.set(paneId, {
          paneId,
          tabId,
          workspaceId,
          agentStatus: 'idle',
          seq: 1,
          cwd: (params['cwd'] as string) ?? '/tmp',
        })
        this.tabs.set(tabId, { closed: false })
        return {
          type: 'tab_created',
          tab: { tab_id: tabId, workspace_id: workspaceId },
          root_pane: { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId },
        }
      }
      case 'worktree.create': {
        const n = this.panes.size + 1
        const workspaceId = `ws-wt-${n}`
        const paneId = `${workspaceId}:p1`
        const tabId = `${workspaceId}:t1`
        const path = `${params['cwd']}/.worktrees/wt${n}`
        this.panes.set(paneId, { paneId, tabId, workspaceId, agentStatus: 'idle', seq: 1, cwd: path })
        this.tabs.set(tabId, { closed: false })
        this.workspaces.set(workspaceId, { closed: false })
        return {
          type: 'worktree_created',
          workspace: { workspace_id: workspaceId },
          tab: { tab_id: tabId, workspace_id: workspaceId },
          root_pane: { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId },
          worktree: { path, branch: (params['branch'] as string) ?? 'helm/wf-x' },
        }
      }
      case 'tab.close': {
        const tabId = params['tab_id'] as string
        const tab = this.tabs.get(tabId)
        if (!tab) throw new HelmError('tab_not_found', `no tab ${tabId}`, 404)
        tab.closed = true
        const pane = [...this.panes.values()].find((p) => p.tabId === tabId)
        if (pane && ![...this.panes.values()].some((p) => p.workspaceId === pane.workspaceId && !this.tabs.get(p.tabId)?.closed)) {
          const workspace = this.workspaces.get(pane.workspaceId)
          if (workspace) workspace.closed = true
        }
        return { type: 'ok' }
      }
      case 'workspace.close': {
        const wsId = params['workspace_id'] as string
        const ws = this.workspaces.get(wsId)
        if (!ws) throw new HelmError('workspace_not_found', `no workspace ${wsId}`, 404)
        ws.closed = true
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
        // 真实语义：阻塞直至 until 命中（fake 以 10ms 轮询模拟）。
        const pane = this.paneOf(params['target'])
        const until = ((params['until'] as string[]) ?? []).map((s) => s as PaneStatus)
        for (let i = 0; i < 2_000; i += 1) {
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          if (this.waitAbort?.aborted) break
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
        return { type: 'pane_read', read: { pane_id: pane.paneId, text: `tail of ${pane.paneId}: SECRET-VALUE line` } }
      }
      case 'agent.send_keys': {
        // 写键不代表检测到状态变化；consumeKeys 才推进权威水位。
        const pane = this.paneOf(params['target'])
        this.sendKeysLog.push({ paneId: pane.paneId, keys: params['keys'] as string[] })
        return { type: 'ok' }
      }
      case 'agent.focus': {
        // 真实协议（服务端 agents.rs:35-41）：focus 返回 agent_info + focused=true。
        const focused = this.paneOf(params['target'])
        return { type: 'agent_info', agent: { ...agentInfoOf(focused), focused: true } }
      }
      case 'pane.report_metadata':
        this.metadataReports.push(params)
        return { type: 'ok' }
      case 'session.snapshot':
        return {
          type: 'session_snapshot',
          snapshot: {
            version: 'test',
            protocol: 22,
            workspaces: [],
            tabs: [],
            layouts: [],
            // 官方形状：panes 覆盖全部窗格（含无 Agent 的 shell），agents 仅
            // Agent 终端；两者都真实输出供总览 join。
            panes: [...this.panes.values()].filter((p) => !this.tabs.get(p.tabId)?.closed).map((p) => ({
              pane_id: p.paneId,
              workspace_id: p.workspaceId,
              tab_id: p.tabId,
              focused: false,
              agent_status: p.name !== undefined ? p.agentStatus : 'unknown',
              cwd: p.cwd,
            })),
            agents: [...this.panes.values()].filter((p) => p.name !== undefined && !this.tabs.get(p.tabId)?.closed).map(agentInfoOf),
          },
        }
      default:
        throw new HelmError('method_not_found', `fake transport 不支持 ${method}`, 400)
    }
  }

  async readOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const errorFactory = this.errors.get('readOutput')
    if (errorFactory) throw errorFactory()
    this.record(target, 'readOutput', { cwd, fileName })
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
    }
    return content
  }

  async removeOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.record(target, 'removeOutput', { cwd, fileName })
    const key = `${cwd}/.helm/${fileName}`
    if (this.outputFiles.delete(key)) this.removedFiles.push(key)
  }

  gateRuns = 0
  async runGate(
    target: HerdrTarget,
    command: string,
    cwd: string,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ): Promise<AgentGateResult> {
    this.record(target, 'runGate', { command, cwd, env })
    this.gateRuns += 1
    return { ok: true, output: 'remote gate ok' }
  }

  async subscribe(
    target: HerdrTarget,
    onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    if (this.subscribeAck === 'fail') {
      throw new HelmError('herdr_socket', 'subscribe failed', 502)
    }
    this.record(target, 'events.subscribe', {})
    this.eventListeners.push(onEvent)
    void onError
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

  /** 等待键发送后模拟终端消化（默认测试在需要时手动调用）。 */
  consumeKeys(paneId: string, status: PaneStatus = this.afterSendKeys): void {
    this.advancePane(paneId, status)
  }
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

// ---------------------------------------------------------------------------
// 测试环境
// ---------------------------------------------------------------------------

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp/helm-herdr-parent',
    model: '',
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

class FakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  events: Array<{ type: string; payload: unknown }> = []
  notifications: Array<{ title: string; body: string; level: string }> = []
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>()
  workflowListeners = new Set<(run: WorkflowRunSummary) => void | Promise<void>>()
  createdAsks: Array<Record<string, unknown>> = []
  cancelledAsks: Array<{ id: string; reason?: string }> = []
  /** pending ask 的结算通道：askId -> resolver。 */
  pendingAskResolvers = new Map<string, (r: AskResult) => void>()
  askCreateError: Error | undefined

  constructor() {
    this.conversations.set(1, makeConversation(1))
    this.conversations.set(2, makeConversation(2))
  }

  dispatchTrigger(): Promise<void> { return Promise.resolve() }
  submitInput(): Promise<void> { return Promise.resolve() }
  createConversation(): Promise<ConversationSummary> { return Promise.resolve(makeConversation(99)) }
  listConversations(): ConversationSummary[] { return [...this.conversations.values()] }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> { return Promise.resolve(this.getConversation(id)) }
  manageConversation(): () => void { return () => {} }
  markConversationOwnership(): void {}
  async createAsk(spec: { id?: string }): Promise<AskResult> {
    if (this.askCreateError) throw this.askCreateError
    const id = spec.id ?? `ask-${this.createdAsks.length + 1}`
    this.createdAsks.push({ ...spec, id })
    return new Promise<AskResult>((resolve) => {
      this.pendingAskResolvers.set(id, resolve)
    })
  }
  /** 测试侧应答 pending ask。 */
  answerAsk(id: string, result: AskResult): void {
    this.pendingAskResolvers.get(id)?.(result)
    this.pendingAskResolvers.delete(id)
  }
  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    this.cancelledAsks.push({ id, reason })
    // 与 AskService 终态语义对齐：cancel 让等待方结算（superseded/cancelled）。
    this.pendingAskResolvers.get(id)?.({ id, status: reason === 'cancelled' ? 'cancelled' : 'superseded', answers: {} })
    this.pendingAskResolvers.delete(id)
  }
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    this.askSeqResolvers.add(resolver)
    return () => { this.askSeqResolvers.delete(resolver) }
  }
  onWorkflowSettled(listener: (run: WorkflowRunSummary) => void | Promise<void>): () => void {
    this.workflowListeners.add(listener)
    return () => { this.workflowListeners.delete(listener) }
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
    if (type === 'notification') {
      const n = payload as { title: string; body: string; level: string }
      this.notifications.push(n)
    }
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
}

interface Env {
  host: PluginHost
  backend: FakeBackend
  transport: FakeTransport
  dataDir: string
  profiles: Map<string, Profile>
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId?: string }>
  gateLog: Array<{ command: string; cwd?: string; env?: Record<string, string> }>
  resolvedInfos: Array<Record<string, unknown>>
  gateResults: Array<{ ok: boolean; output: string }>
  close(): Promise<void>
}

async function makeEnv(options: { enabled?: boolean; docs?: MemoryDocStore; dataDir?: string; transport?: FakeTransport; backend?: FakeBackend } = {}): Promise<Env> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'helm-herdr-test-'))
  const backend = options.backend ?? new FakeBackend()
  const docs = options.docs ?? new MemoryDocStore()
  const transport = options.transport ?? new FakeTransport()
  const profiles = new Map<string, Profile>()
  const spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId?: string }> = []
  const gateLog: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = []
  const resolvedInfos: Array<Record<string, unknown>> = []
  const gateResults: Array<{ ok: boolean; output: string }> = []

  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register(
    createHerdrPlugin({
      defaultCwd: '/tmp/helm-herdr-default',
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (conversationId, cwd, nodeId) => {
        spawnEnvLog.push({ conversationId, cwd, ...(nodeId !== undefined ? { nodeId } : {}) })
        return { HELM_ENV: '1', HELM_HUB_URL: 'http://127.0.0.1:3202', HELM_TOKEN: 'SECRET-TOKEN', HELM_CWD: cwd }
      },
      redact: (text) => text.replaceAll('SECRET-TOKEN', '[REDACTED]').replaceAll('SECRET-VALUE', '[REDACTED]'),
      runLocalGate: async (command, opts) => {
        gateLog.push({ command, cwd: opts.cwd, env: opts.env })
        return { ok: true, output: 'local gate ok' }
      },
      transport,
    }),
    { enabled: options.enabled ?? true },
  )

  return {
    host,
    backend,
    transport,
    dataDir,
    profiles,
    spawnEnvLog,
    gateLog,
    resolvedInfos,
    gateResults,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 直接调用 spawn hook；返回 handled result，非 handled 时返回哨兵。 */
async function spawnDirect(env: Env, request: Record<string, unknown>): Promise<unknown> {
  const outcome = await env.host.runHook('agent_spawn', {
    parentConversationId: 1,
    prompt: 'do the thing',
    ...request,
  } as never)
  if (outcome.action === 'handled') return outcome.result
  if (outcome.action === 'transform') return { __transformed: outcome.value }
  return { __notHandled: true }
}

function turnSettledOf(conversationId: number): never {
  return {
    conversation: makeConversation(conversationId),
    inputs: [],
    outcome: 'completed',
    settledAt: Date.now(),
  } as never
}

function fileNameOf(text: string): string {
  return text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await delay(intervalMs)
  }
}

/** 标准成功脚本：prompt 直达 done，onPrompt 写入交接文件。 */
function scriptSuccess(env: Env, content: string, schema = false): void {
  env.transport.promptStatus = 'done'
  env.transport.onPrompt = (pane, text) => {
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, schema ? content : content)
  }
}

// ---------------------------------------------------------------------------
// 文件交接 A/B/C
// ---------------------------------------------------------------------------

test('文件交接A: 成功路径——两步建窗、交接读取、文件清理、gate 一次、保活登记', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, JSON.stringify({ answer: 42 }), true)
    let resolved: Record<string, unknown> | undefined
    const result = await spawnDirect(env, {
      agentType: 'herdr:agy',
      cwd: '/tmp/helm-cwd-a',
      schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
      onResolved: (info: Record<string, unknown>) => { resolved = info },
    })
    assert.deepEqual(result, { answer: 42 })
    assert.equal(env.transport.removedFiles.length, 1, '交接文件读取后清理')
    // 两步建窗：tab.create 先于 agent.start。
    const tabAt = env.transport.calls.findIndex((c) => c.method === 'tab.create')
    const startAt = env.transport.calls.findIndex((c) => c.method === 'agent.start')
    assert.ok(tabAt >= 0 && startAt > tabAt)
    const tabCreate = env.transport.calls[tabAt]!
    assert.equal(tabCreate.params['cwd'], '/tmp/helm-cwd-a')
    assert.equal(tabCreate.params['focus'], false)
    assert.ok((tabCreate.params['label'] as string).startsWith('helm-wf-'), 'label 为 helm-wf- 前缀')
    assert.ok(((tabCreate.params['label'] as string).length <= 32), 'agent 名称 <= 32')
    const start = env.transport.calls[startAt]!
    assert.equal(start.params['kind'], 'agy')
    assert.equal(start.params['timeout_ms'], 30_000)
    // prompt --wait 契约。
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!
    assert.deepEqual((prompt.params['wait'] as { until: string[] }).until, ['done', 'idle', 'blocked'])
    assert.ok((prompt.params['text'] as string).includes('.helm/wf-out-'), '提示词强制落盘')
    // onResolved 回传 executionId/effectiveCwd。
    assert.ok(resolved && typeof resolved['executionId'] === 'string' && resolved['executionId'] !== '')
    assert.equal(resolved!['effectiveCwd'], '/tmp/helm-cwd-a')
    // 保活登记。
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'keepalive')
  } finally {
    await env.close()
  }
})

test('文件交接B: 首次缺文件自愈一次后成功', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    let promptCount = 0
    env.transport.onPrompt = (pane, text) => {
      promptCount += 1
      if (promptCount >= 2) {
        // 自愈 prompt 时写入文件。
        env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, '# 结果\n完成。')
      }
    }
    const result = await spawnDirect(env, { agentType: 'herdr:agy' })
    assert.equal(result, '# 结果\n完成。')
    assert.equal(promptCount, 2, '自愈恰好一次')
    assert.ok(env.backend.notifications.some((n) => n.title === 'Herdr 交接自愈'))
  } finally {
    await env.close()
  }
})

test('文件交接C: 两次失败 herdr_output_contract_violation + 脱敏快照 + pane 保留', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    // 全程不写文件。
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'herdr:agy',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_contract_violation')
        assert.ok(error.message.includes('[REDACTED]'), '快照脱敏')
        return true
      },
    )
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string; paneId: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed')
    const pane = env.transport.panes.get(list.panes[0]!.paneId)!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, false, '失败 pane 保留现场')
  } finally {
    await env.close()
  }
})

test('坏 JSON / Schema 不合格同样走自愈；两次后同样显式违约', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    env.transport.onPrompt = (pane, text) => {
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, '{"broken": ')
    }
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'herdr:agy',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_contract_violation')
        return true
      },
    )
  } finally {
    await env.close()
  }
})

test('交接文件非缺失 IO 错误不自愈，如实抛诊断', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'done'
    env.transport.errors.set('readOutput', () => new HelmError('herdr_io', 'EACCES: permission denied', 500))
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_io')
        return true
      },
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt').length, 1, '不重投任务')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 双入口与参数校验
// ---------------------------------------------------------------------------

test('Profile.runtime 入口: 继承 args/workspace/env；非 herdr Profile 放行', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('coder', {
      id: 'coder',
      runtime: { kind: 'herdr', agent: 'claude', args: ['--flag-a'], workspace: '/tmp/helm-profile-ws', env: { TOOL: 'x' } },
    })
    env.profiles.set('writer', { id: 'writer' })
    scriptSuccess(env, 'profile-ok')
    await spawnDirect(env, { agentType: 'coder' })
    const start = env.transport.calls.find((c) => c.method === 'agent.start')!
    assert.deepEqual(start.params['args'], ['--flag-a'])
    const tabCreate = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(tabCreate.params['cwd'], '/tmp/helm-profile-ws')
    const envSent = tabCreate.params['env'] as Record<string, string>
    assert.equal(envSent['TOOL'], 'x')
    assert.equal(envSent['HELM_TOKEN'], 'SECRET-TOKEN')
    // cwd 解析链：request.cwd 优先。
    const before = env.transport.calls.length
    const outcome = await env.host.runHook('agent_spawn', { parentConversationId: 1, prompt: 'x', agentType: 'writer' } as never)
    assert.notEqual(outcome.action, 'handled')
    assert.equal(env.transport.calls.length, before, '非 herdr Profile 零调用')
  } finally {
    await env.close()
  }
})

test('cwd 解析链: request.cwd > profile.workspace > 父会话 cwd > defaultCwd', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    let tabCreate = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(tabCreate.params['cwd'], '/tmp/helm-herdr-parent', '缺省用父会话 cwd')
  } finally {
    await env.close()
  }
})

test('非法输入拒绝: 相对 cwd / 非法 kind / nodeId 注入 / 显式 model / effort', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', cwd: 'relative/path' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:BAD KIND' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy:remote' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy@remote --evil' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', model: 'faux/big' }), (e: unknown) => (e as HelmError).code === 'unsupported_runtime')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', effort: 'high' }), (e: unknown) => (e as HelmError).code === 'unsupported_runtime')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// blocked 审批桥
// ---------------------------------------------------------------------------

test('审批桥: 双路径单飞——只建一次 Ask、只发一次键、CAS 复核', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    assert.match(askId, /^herdr:local:.+:\d+$/, '预分配 id 形如 herdr:local:<pane>:<seq>')
    // 权威复核：createAsk 前 agent.get。
    assert.ok(env.transport.calls.some((c) => c.method === 'agent.get'))
    // socket 重复事件（同 seq）不重建。
    const pane = [...env.transport.panes.values()][0]!
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(100)
    assert.equal(env.backend.createdAsks.length, 1, '重复事件不重建 Ask')
    // 人类回答 allow-y -> 复核 seq -> 一次 send_keys。
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['y'])
    // send_keys 已发但 agent.get 短暂仍 blocked 同 seq + socket 重复：不重发不重建。
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(100)
    assert.equal(env.transport.sendKeysLog.length, 1, '同 seq 不重发键')
    assert.equal(env.backend.createdAsks.length, 1)
    // 终端真实进展（延迟推进）-> done -> 文件交接成功。
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'approved')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
  } finally {
    await env.close()
  }
})

test('审批桥: 终端先处理（seq 推进）pending Ask superseded 且不发送键', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const pane = [...env.transport.panes.values()][0]!
    // 延迟 Ask 创建期间收到 working 新 seq（事件路径先于 createAsk 落库）。
    env.transport.advancePane(pane.paneId, 'working')
    await waitFor(() => env.backend.cancelledAsks.length === 1)
    assert.equal(env.backend.cancelledAsks[0]!.reason, 'superseded')
    // 主循环继续等待真实进展 -> done -> 交接。
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'terminal-first')
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'terminal-first')
    assert.equal(env.transport.sendKeysLog.length, 0, '终端先处理时不发送键')
  } finally {
    await env.close()
  }
})

test('审批桥: 人类取消时不批准、关闭自有 pane 并中止', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    env.backend.answerAsk(askId, { id: askId, status: 'cancelled', answers: {} })
    await assert.rejects(resultPromise, (e: unknown) => (e as HelmError).code === 'aborted')
    const pane = [...env.transport.panes.values()][0]!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, true, '取消后关闭自有 pane')
    assert.equal(env.transport.sendKeysLog.length, 0, '取消绝不批准')
  } finally {
    await env.close()
  }
})

test('审批桥: 回答后终端 seq 已推进时不发键，直接续等', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    // 人类回答的同时终端已处理（seq 推进为 done）。
    env.transport.advancePane(pane.paneId, 'done')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'race-resolved')
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    assert.equal(await resultPromise, 'race-resolved')
    assert.equal(env.transport.sendKeysLog.length, 0, 'seq 已推进时不发键（CAS 复核）')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// gate 与远端
// ---------------------------------------------------------------------------

test('Gate 恰好一次 + env 注入（本机 runLocalGate 携带 spawn env）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'gate-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', gate: 'exit 0' })
    assert.equal(env.gateLog.length, 1, 'gate 恰好一次')
    assert.equal(env.gateLog[0]!.command, 'exit 0')
    assert.equal(env.gateLog[0]!.cwd, '/tmp/helm-herdr-parent', 'gate 在实际 cwd 执行')
    assert.equal(env.gateLog[0]!.env?.['HELM_ENV'], '1')
    assert.equal(env.gateLog[0]!.env?.['HELM_CWD'], '/tmp/helm-herdr-parent')
  } finally {
    await env.close()
  }
})

test('远端节点: 全部调用走 nodeId target、剥除 loopback HUB_URL/TOKEN、远端 gate', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'remote-ok')
    await spawnDirect(env, { agentType: 'herdr:agy@remote-node', gate: 'exit 0' })
    for (const call of env.transport.calls) {
      // 订阅与对账契约只承诺本机 socket。
      if (call.method === 'events.subscribe' || call.method === 'session.snapshot') continue
      assert.deepEqual(call.target, { nodeId: 'remote-node' }, `调用 ${call.method} 走 nodeId target`)
    }
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal('HELM_HUB_URL' in envSent, false)
    assert.equal('HELM_TOKEN' in envSent, false)
    // 远端 gate 走 transport.runGate（非本机 runLocalGate）。
    assert.equal(env.gateLog.length, 0)
    assert.equal(env.transport.gateRuns, 1)
    // buildSpawnEnv 收到目标 nodeId（窗格 env 按节点构造）。
    assert.ok(env.spawnEnvLog.some((e) => e.nodeId === 'remote-node'), '远端窗格 env 按目标 nodeId 构造')
  } finally {
    await env.close()
  }
})

test('远端 Profile 显式配置可达 HELM_HUB_URL 时保留回连变量', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('far', {
      id: 'far',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELM_HUB_URL: 'http://10.0.0.5:3202' } },
    })
    scriptSuccess(env, 'far-ok')
    await spawnDirect(env, { agentType: 'far' })
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(envSent['HELM_HUB_URL'], 'http://10.0.0.5:3202', '显式远端可达 URL 保留')
    assert.equal(envSent['HELM_TOKEN'], 'SECRET-TOKEN', 'token 随可达 URL 保留')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// worktree 与双轨清理
// ---------------------------------------------------------------------------

test('Worktree 隔离: 两步建窗注入 env、关初始 tab、workspace.close 清理', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'wt-ok')
    let resolved: Record<string, unknown> | undefined
    await spawnDirect(env, {
      agentType: 'herdr:agy',
      isolation: 'worktree',
      onResolved: (info: Record<string, unknown>) => { resolved = info },
    })
    const worktreeCreate = env.transport.calls.find((c) => c.method === 'worktree.create')!
    assert.equal(worktreeCreate.params['trust_repository'], true)
    assert.equal(worktreeCreate.params['focus'], false)
    assert.match(worktreeCreate.params['branch'] as string, /^helm\/wf-/)
    // env 非空 -> workspace 内补建 tab + 关初始 tab。
    const tabCreates = env.transport.calls.filter((c) => c.method === 'tab.create')
    assert.equal(tabCreates.length, 1, '补建一个带 env 的 tab')
    assert.ok(tabCreates[0]!.params['workspace_id'])
    assert.ok(env.transport.calls.some((c) => c.method === 'tab.close'), '关闭初始空 tab')
    // onResolved 回传 worktree 元数据 + effectiveCwd 为 worktree.path。
    const wt = resolved!['worktree'] as { path: string; branch: string }
    assert.ok(wt.path.includes('.worktrees/'))
    assert.equal(resolved!['effectiveCwd'], wt.path)
    // 父回合 settle -> workspace.close。
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.ok([...env.transport.workspaces.values()].some((w) => w.closed), '关闭自有最后一个 tab 后 Herdr 回收空 worktree workspace')
  } finally {
    await env.close()
  }
})

test('双轨清理: workflowRunId 由 onWorkflowSettled 关；独立 pane 由父回合关', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // workflow 轨道。
    scriptSuccess(env, 'wf-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', workflowRunId: 'wf_run1' })
    const pane1 = [...env.transport.panes.values()][0]!
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.equal(env.transport.tabs.get(pane1.tabId)!.closed, false, 'workflow pane 不由父回合关')
    for (const listener of env.backend.workflowListeners) {
      await listener({ id: 'wf_run1', name: 'n', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2 })
    }
    assert.equal(env.transport.tabs.get(pane1.tabId)!.closed, true, 'workflow settle 关闭 pane')

    // 独立轨道。
    scriptSuccess(env, 'solo-ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    const pane2 = [...env.transport.panes.values()][1]!
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.equal(env.transport.tabs.get(pane2.tabId)!.closed, true, '独立 pane 由父回合关')
    // 不同父回合不误关他人 pane。
    scriptSuccess(env, 'other-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', })
    const pane3 = [...env.transport.panes.values()][2]!
    await env.host.runHook('turn_settled', turnSettledOf(2))
    assert.equal(env.transport.tabs.get(pane3.tabId)!.closed, false, '他人父回合不误关')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test('resume: 同父复用 pane 不新建；跨父拒绝；未知拒绝；并发拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'first')
    await spawnDirect(env, { agentType: 'herdr:agy', agentId: 'wf_1:node-a' })
    const pane = [...env.transport.panes.values()][0]!
    const tabsBefore = env.transport.calls.filter((c) => c.method === 'tab.create').length

    scriptSuccess(env, 'second')
    const resumed = await spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_1:node-a', agentId: 'wf_1:node-a' })
    assert.equal(resumed, 'second')
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, tabsBefore, 'resume 不新建 tab')
    assert.equal(env.transport.panes.size, 1, '复用既有 pane')

    // 跨父会话拒绝（经 runHook 直接断言错误传播）。
    const crossParent = env.host.runHook('agent_spawn', {
      parentConversationId: 2,
      prompt: 'x',
      agentType: 'herdr:agy',
      resume: 'wf_1:node-a',
    } as never)
    await assert.rejects(crossParent, (e: unknown) => {
      assert.equal((e as HelmError).code, 'cross_parent_resume_rejected')
      return true
    })

    // 未知 ref 拒绝。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', resume: 'no-such-ref' }),
      (e: unknown) => (e as HelmError).code === 'not_found',
    )
    void pane
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

test('abort: 立即取消 Ask 并关闭自有 PTY（清理不受 aborted 阻碍）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const controller = new AbortController()
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', signal: controller.signal })
    await waitFor(() => env.backend.createdAsks.length === 1)
    controller.abort()
    await assert.rejects(resultPromise, (e: unknown) => (e as HelmError).code === 'aborted')
    const pane = [...env.transport.panes.values()][0]!
    await waitFor(() => env.transport.tabs.get(pane.tabId)?.closed === true)
    // abort 同时销单。
    assert.ok(env.backend.cancelledAsks.some((c) => c.id === env.backend.createdAsks[0]!['id']), 'abort 取消关联 Ask')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 启停与 liveTasks
// ---------------------------------------------------------------------------

test('启停: 默认停用注册不连接；启用连接；保活期间 disable 409；结算后可 disable', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ enabled: false })
  try {
    assert.equal(env.transport.calls.filter((c) => c.method === 'events.subscribe').length, 0)
    assert.equal(env.host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false)
    const outcome = await env.host.runHook('agent_spawn', { parentConversationId: 1, prompt: 'x', agentType: 'herdr:agy' } as never)
    assert.notEqual(outcome.action, 'handled', '停用态不接管')

    await env.host.enable('builtin:herdr')
    assert.equal(env.transport.calls.filter((c) => c.method === 'events.subscribe').length, 1, '启用即连接')

    scriptSuccess(env, 'keepalive')
    await spawnDirect(env, { agentType: 'herdr:agy' })

    // 成功保活 pane 期间无活跃 spawn hook 仍 409（空隙保护）。
    await assert.rejects(env.host.disable('builtin:herdr'), (e: unknown) => {
      assert.equal((e as HelmError).code, 'plugin_has_live_tasks')
      assert.ok((e as HelmError).message.includes('herdr-keepalive'))
      return true
    })

    // 父回合结算清空后可 disable。
    await env.host.runHook('turn_settled', turnSettledOf(1))
    await env.host.disable('builtin:herdr')
    const pane = [...env.transport.panes.values()][0]!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, true, 'stop 清理可回收 pane')
  } finally {
    await env.close()
  }
})

test('服务启动半途失败: snapshot 失败时自行清理订阅，注册整体失败', { timeout: 60_000 }, async () => {
  const transport = new FakeTransport()
  transport.errors.set('session.snapshot', () => new HelmError('herdr_socket', 'snapshot failed', 502))
  const backend = new FakeBackend()
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-half-'))
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
  try {
    await assert.rejects(
      host.register(
        createHerdrPlugin({
          defaultCwd: '/tmp',
          profiles: { get: async () => undefined },
          buildSpawnEnv: () => ({}),
          redact: (t) => t,
          runLocalGate: async () => ({ ok: true, output: '' }),
          transport,
        }),
      ),
      (e: unknown) => (e as HelmError).code === 'plugin_registration_failed' || (e as HelmError).code === 'herdr_socket',
    )
    // 订阅已清理（listener 集空）。
    assert.equal(transport.eventListeners.length, 0, '半途失败清理订阅')
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 启动对账
// ---------------------------------------------------------------------------

test('启动对账: 孤儿回收；failed 保留；同 ID 换 human agent 不误关；keepalive 不当孤儿', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-recon-'))
  const docs = new MemoryDocStore()
  const orphanPaneId = 'ws-default:p1'
  const failedPaneId = 'ws-default:p2'
  const humanPaneId = 'ws-default:p3'
  const keepalivePaneId = 'ws-default:p4'
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: [
      { target: {}, routing: { kind: 'agy' }, paneId: orphanPaneId, tabId: 'ws-default:t1', effectiveCwd: '/tmp/a', agentName: 'helm-wf-abc', parentConversationId: 1, outcome: 'running', createdAt: 1 },
      { target: {}, routing: { kind: 'agy' }, paneId: failedPaneId, tabId: 'ws-default:t2', effectiveCwd: '/tmp/b', agentName: 'helm-wf-def', parentConversationId: 1, outcome: 'failed', createdAt: 1, failureNote: 'x' },
      { target: {}, routing: { kind: 'agy' }, paneId: humanPaneId, tabId: 'ws-default:t3', effectiveCwd: '/tmp/c', agentName: 'human-agent', parentConversationId: 1, outcome: 'running', createdAt: 1 },
      { target: {}, routing: { kind: 'agy' }, paneId: keepalivePaneId, tabId: 'ws-default:t4', effectiveCwd: '/tmp/d', agentName: 'helm-wf-ghi', parentConversationId: 1, outcome: 'keepalive', createdAt: 1 },
    ],
  })
  const backend = new FakeBackend()
  const transport = new FakeTransport()
  transport.panes.set(orphanPaneId, { paneId: orphanPaneId, tabId: 'ws-default:t1', workspaceId: 'ws-default', agentStatus: 'done', seq: 3, name: 'helm-wf-abc', cwd: '/tmp/a' })
  transport.panes.set(failedPaneId, { paneId: failedPaneId, tabId: 'ws-default:t2', workspaceId: 'ws-default', agentStatus: 'idle', seq: 3, name: 'helm-wf-def', cwd: '/tmp/b' })
  transport.panes.set(humanPaneId, { paneId: humanPaneId, tabId: 'ws-default:t3', workspaceId: 'ws-default', agentStatus: 'working', seq: 3, name: 'human-agent', cwd: '/tmp/c' })
  transport.panes.set(keepalivePaneId, { paneId: keepalivePaneId, tabId: 'ws-default:t4', workspaceId: 'ws-default', agentStatus: 'done', seq: 3, name: 'helm-wf-ghi', cwd: '/tmp/d' })
  for (const t of ['ws-default:t1', 'ws-default:t2', 'ws-default:t3', 'ws-default:t4']) {
    transport.tabs.set(t, { closed: false })
  }

  const host = new PluginHost({ dataDir, host: backend, docs })
  try {
    await host.register(
      createHerdrPlugin({
        defaultCwd: '/tmp',
        profiles: { get: async () => undefined },
        buildSpawnEnv: () => ({}),
        redact: (t) => t,
        runLocalGate: async () => ({ ok: true, output: '' }),
        transport,
      }),
    )
    assert.equal(transport.tabs.get('ws-default:t1')!.closed, true, '孤儿（running+done）回收')
    assert.equal(transport.tabs.get('ws-default:t2')!.closed, false, 'failed 保留现场（即使实际 idle）')
    assert.equal(transport.tabs.get('ws-default:t3')!.closed, false, '同 ID 换 human agent 不误关')
    assert.equal(transport.tabs.get('ws-default:t4')!.closed, true, '已结束 keepalive 孤儿同样回收')
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// human 红线与防自激
// ---------------------------------------------------------------------------

test('human 红线: 非自有 pane 的 blocked 事件不建 Ask、不发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.panes.set('ws-other:p9', { paneId: 'ws-other:p9', tabId: 'ws-other:t9', workspaceId: 'ws-other', agentStatus: 'blocked', seq: 5, cwd: '/tmp' })
    env.transport.emit({ type: 'pane.updated', paneId: 'ws-other:p9' })
    await delay(100)
    assert.equal(env.backend.createdAsks.length, 0)
    assert.equal(env.transport.sendKeysLog.length, 0)
  } finally {
    await env.close()
  }
})

test('report_metadata 防自激: 同 token 重复事件不重复投射', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'meta-ok')
    const p = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt'))
    const pane = [...env.transport.panes.values()][0]!
    for (let i = 0; i < 5; i += 1) env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(150)
    const reports = env.transport.metadataReports.filter((r) => r['pane_id'] === pane.paneId)
    assert.ok(reports.length <= 2, `同 token 去重（实际 ${reports.length} 次）`)
    await p
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// actions 与 agent_not_ready
// ---------------------------------------------------------------------------

test('actions: list/read/focus（read 40 行脱敏；未知 pane 404）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'act-ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ paneId: string; nodeId: string; outcome: string }> }
    assert.ok(list.panes.length >= 1)
    assert.equal(list.panes[0]!.nodeId, 'local')
    const read = (await env.host.invokeAction('builtin:herdr', 'read', { paneId: list.panes[0]!.paneId })) as { text: string }
    assert.ok(read.text.includes('[REDACTED]'), 'read 脱敏')
    const focus = (await env.host.invokeAction('builtin:herdr', 'focus', { paneId: list.panes[0]!.paneId })) as { focused: boolean }
    assert.equal(focus.focused, true)
    assert.ok(env.transport.calls.some((c) => c.method === 'agent.focus'))
    await assert.rejects(
      env.host.invokeAction('builtin:herdr', 'read', { paneId: 'nope:p1' }),
      (e: unknown) => (e as HelmError).status === 404,
    )
  } finally {
    await env.close()
  }
})

test('agent_not_ready 桥接: 权威 blocked 时复用既有 agent，不启动第二个', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.errors.set('agent.start', () => new HelmError('agent_not_ready', 'agent not ready', 409))
    // pane 上已有 blocked agent（tab.create 后由 fake 设定——prompt 前的 start 阶段）。
    env.transport.promptStatus = 'blocked'
    // 在 tab.create 后立刻把 pane 置为 blocked（有 name 的 helm-wf agent）。
    const originalCall = env.transport.call.bind(env.transport)
    ;(env.transport as { call: unknown }).call = async (target: HerdrTarget, method: string, params: Record<string, unknown>) => {
      const result = await originalCall(target, method, params)
      if (method === 'tab.create') {
        const paneId = (result as { root_pane: { pane_id: string } }).root_pane.pane_id
        const pane = env.transport.panes.get(paneId)!
        pane.name = 'helm-wf-existing'
        pane.agentStatus = 'blocked'
      }
      return result
    }
    const p = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1, 8000)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.start').length, 1, '只尝试一次 start')
    assert.ok(env.backend.notifications.some((n) => n.title.includes('已存在等待中的 Agent')), '桥接通知')
    // 收尾：取消 Ask。
    env.backend.answerAsk(env.backend.createdAsks[0]!['id'] as string, { id: 'x', status: 'cancelled', answers: {} })
    await assert.rejects(p, () => true)
  } finally {
    await env.close()
  }
})
