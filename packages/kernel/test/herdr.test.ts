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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
import { PluginHost, type PluginConfigStore, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'
import { SEND_KEYS_CAS_CAPABILITY } from '../src/builtin-plugins/herdr/rpc.js'
import type { DiagnosticsCollection } from '../src/builtin-plugins/diagnostics.js'
import { LocalNodeChannel } from '../src/builtin-plugins/herdr/local-node-channel.js'
import type { HelmHostNodeIpcPort } from '@helm/protocol'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { FsOutputFiles, ipcLineCall, serveTransport } from './helpers/herdr-unit-fixture.js'

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
  outputFiles = new FsOutputFiles()
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
  /** 自定义终端快照（agent.read 返回；缺省 tail of <pane> 行）。 */
  snapshotText: string | undefined
  /** ping capabilities 通告：缺省模拟支持 send_keys CAS 的服务端；测试可改写模拟旧服务端（真实 0.9.5 无 CAS 字段）。 */
  pongCapabilities: Record<string, unknown> | null = {
    live_handoff: false,
    detached_server_daemon: false,
    endpoint_protocol_generation: 1,
    [SEND_KEYS_CAS_CAPABILITY]: true,
  }

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
        const paneCwd = (params['cwd'] as string) ?? '/tmp'
        // 生产 readLocalOutput 经真实 fs canonicalPath：pane cwd 必须真实存在。
        mkdirSync(join(paneCwd, '.helm'), { recursive: true })
        this.panes.set(paneId, {
          paneId,
          tabId,
          workspaceId,
          agentStatus: 'idle',
          seq: 1,
          cwd: paneCwd,
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
        mkdirSync(join(path, '.helm'), { recursive: true })
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
        const text = this.snapshotText !== undefined ? this.snapshotText : `tail of ${pane.paneId}: SECRET-VALUE line`
        return { type: 'pane_read', read: { pane_id: pane.paneId, text } }
      }
      case 'ping':
        return {
          type: 'pong',
          version: 'test-server',
          protocol: 22,
          ...(this.pongCapabilities !== null ? { capabilities: { ...this.pongCapabilities } } : {}),
        }
      case 'agent.send_keys': {
        // CAS 契约（未来服务端行为）：expected_state_seq 必须匹配当前权威 seq，
        // 不匹配以 stale_state 拒绝且键不写入。写键不代表检测到状态变化；
        // consumeKeys 才推进权威水位。
        const pane = this.paneOf(params['target'])
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
    thinkingLevel: '',
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
  /** buildSpawnEnv 调用记录（nodeId 透传断言）。 */
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId?: string }> = []
  /** 宿主 gate 调用记录（runLocalGate 注入点）。 */
  gateLog: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = []
  /** 受控 Profile 表（ProfileService 语义最小面）。 */
  profileStore = new Map<string, Profile>()
  /** 可编程 completeText（AI 快照解析注入点）。 */
  completeTextImpl: ((input: { conversationId: number; systemPrompt: string; text: string }) => Promise<string>) | undefined
  /** 按类型分发的插件事件监听（与 runtime.emitHostEvent 同构）。 */
  typedListeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()
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
  profiles = {
    list: async () => [...this.profileStore.values()],
    get: async (id: string) => this.profileStore.get(id),
    getSystem: async (id: string) => {
      throw new HelmError('not_found', `Profile ${id} 无 SYSTEM.md`, 404)
    },
    save: async () => { throw new HelmError('unsupported', 'fixture 只读', 501) },
    directory: async (id: string) => `/tmp/herdr-fixture-profiles/${id}`,
  }
  skills = {
    list: async () => [],
    readFile: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
    directory: async (id: string) => `/tmp/herdr-fixture-skills/${id}`,
    ensureSkill: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
  }
  secrets = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    addRedaction: () => () => {},
  }
  setPluginConfig(): Promise<void> { return Promise.resolve() }
  nodeIpc: HelmHostNodeIpcPort = {
    isOnline: () => true,
    call: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC', 501) },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC', 501) },
  }
  redact = (text: string) => text.replaceAll('SECRET-TOKEN', '[REDACTED]').replaceAll('SECRET-VALUE', '[REDACTED]')
  buildSpawnEnv = (conversationId: number, cwd: string, nodeId: string) => {
    this.spawnEnvLog.push({ conversationId, cwd, ...(nodeId !== undefined ? { nodeId } : {}) })
    return { HELM_ENV: '1', HELM_HUB_URL: 'http://127.0.0.1:3202', HELM_TOKEN: 'SECRET-TOKEN', HELM_CWD: cwd }
  }
  async getConversationDetail(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无详情', 501) }
  async listArtifacts(): Promise<never[]> { return [] }
  async getArtifact(): Promise<never> { throw new HelmError('not_found', '无产物', 404) }
  async completeText(input: { conversationId: number; systemPrompt: string; text: string }): Promise<string> {
    if (this.completeTextImpl !== undefined) return this.completeTextImpl(input)
    throw new HelmError('unsupported', '本 fixture 无模型', 501)
  }
  executionEnv = (_nodeId: string, cwd: string) => {
    mkdirSync(cwd, { recursive: true })
    return new NodeExecutionEnv({ cwd })
  }
  withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() }
  async atomicWriteFile(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无原子写', 501) }
  async refreshModels(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) }
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
  async runGate(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ ok: boolean; output: string }> {
    this.gateLog.push({ command, cwd: options?.cwd, env: options?.env })
    return { ok: true, output: 'local gate ok' }
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
  redactText(text: string): string {
    return text
  }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] {
    return []
  }
  async probeNodeFs(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不探测节点 fs', 501) }
  listActions(): [] {
    return []
  }
  onEvent(type: string, listener: (payload: unknown) => void | Promise<void>): () => void {
    // 按事件类型分发注册（与 runtime.emitHostEvent 同构）：不同插件事件监听
    // 互不串扰（workflow.settled / diagnostics.collect 各自投递）。
    const set = this.typedListeners.get(type) ?? new Set()
    set.add(listener)
    this.typedListeners.set(type, set)
    // workflowListeners 仅为测试手动投递 workflow.settled 保留（类型隔离）。
    if (type === 'workflow.settled') {
      this.workflowListeners.add(listener as (run: WorkflowRunSummary) => void | Promise<void>)
    }
    return () => {
      set.delete(listener)
      this.workflowListeners.delete(listener as (run: WorkflowRunSummary) => void | Promise<void>)
    }
  }
  async emitEvent(type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload })
    if (type === 'notification') {
      const n = payload as { title: string; body: string; level: string }
      this.notifications.push(n)
    }
    for (const listener of [...(this.typedListeners.get(type) ?? [])]) {
      await listener(payload)
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
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }
  async flush(): Promise<void> {}
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

class MemoryConfigStore implements PluginConfigStore {
  constructor(private readonly initial: Record<string, unknown> = {}) {}
  get(pluginId: string): Record<string, unknown> { return this.initial }
  set(): void {}
}

async function makeEnv(options: {
  enabled?: boolean
  docs?: MemoryDocStore
  dataDir?: string
  transport?: FakeTransport
  backend?: FakeBackend
  /** AI 快照解析注入：completeText 可编程实现（零参插件经 host.completeText
   * 装配分析器；返回模型原始文本，由 parseAiSnapshotAnalysisText 解析）。 */
  analyzeBlockedSnapshot?: (input: { snapshot: string; conversationId: number }) => Promise<string>
} = {}): Promise<Env> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'helm-herdr-test-'))
  const backend = options.backend ?? new FakeBackend()
  // 每个测试的父 cwd 位于独立 dataDir 下，避免并行测试互相删除/覆盖同名交接文件。
  const parentCwd = join(dataDir, 'parent')
  mkdirSync(parentCwd, { recursive: true })
  const parentConversation = backend.conversations.get(1)
  if (parentConversation !== undefined) parentConversation.cwd = parentCwd
  const docs = options.docs ?? new MemoryDocStore()
  const transport = options.transport ?? new FakeTransport()
  if (options.analyzeBlockedSnapshot !== undefined) {
    const analyze = options.analyzeBlockedSnapshot
    backend.completeTextImpl = async (input) => analyze({ snapshot: input.text, conversationId: input.conversationId })
  }
  const spawnEnvLog = backend.spawnEnvLog
  const gateLog = backend.gateLog
  const resolvedInfos: Array<Record<string, unknown>> = []
  const gateResults: Array<{ ok: boolean; output: string }> = []

  // 受控协议服务器：零参插件的生产 transport 经插件配置 socketPath 直连
  // （本机 target 冻结为 { socketPath }；不经 nodeIpc——LocalNodeChannel 无事件流）。
  const socketPath = join(dataDir, 'herdr.sock')
  let routedNodeId: string | undefined
  const served = await serveTransport(transport, socketPath, () => (routedNodeId !== undefined && routedNodeId !== 'local' ? { nodeId: routedNodeId } : {}))
  backend.nodeIpc = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    call: async (nodeId, input, signal) => {
      routedNodeId = nodeId
      return ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
    },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC 订阅', 501) },
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs,
    config: new MemoryConfigStore({ socketPath }),
  })
  await host.register(createHerdrPlugin(), { enabled: options.enabled ?? true })

  return {
    host,
    backend,
    transport,
    dataDir,
    profiles: backend.profileStore,
    spawnEnvLog,
    gateLog,
    resolvedInfos,
    gateResults,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
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
    const outputPrompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!
    const outputFileName = fileNameOf(outputPrompt.params['text'] as string)
    assert.ok(outputFileName !== '', 'prompt 必须包含交接文件名')
    assert.equal(existsSync(`${[...env.transport.panes.values()][0]!.cwd}/.helm/${outputFileName}`), false, '交接文件读取后清理')
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

test('交接路径非普通文件时不自愈，如实抛诊断', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'done'
    env.transport.onPrompt = (pane, text) => {
      // 零参生产 transport 真实读取文件；目录作为输出路径稳定模拟非缺失 I/O 违约。
      mkdirSync(join(pane.cwd, '.helm', fileNameOf(text)), { recursive: true })
    }
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_not_file')
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
    assert.equal(tabCreate.params['cwd'], env.backend.conversations.get(1)!.cwd, '缺省用父会话 cwd')
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
  // 退避不用全局快参：本用例验证「同 seq 不重发不重建」窗口，重开需 2 次退避（400+800ms）后才触发。
  // 生产退避缺省（500ms/4000ms）：本用例只验证同 seq 不重发不重建（100ms 观察窗内必然成立）。
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
    assert.equal(env.gateLog[0]!.cwd, env.backend.conversations.get(1)!.cwd, 'gate 在实际 cwd 执行')
    assert.equal(env.gateLog[0]!.env?.['HELM_ENV'], '1')
    assert.equal(env.gateLog[0]!.env?.['HELM_CWD'], env.backend.conversations.get(1)!.cwd)
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
    // 远端 gate 不走本机 runLocalGate：生产 transport.runGate 经 nodeChannel
    // .envFor（= backend.executionEnv 真实 NodeExecutionEnv）在实际 cwd 执行
    // exit 0 成功；FakeTransport.runGate 不再是承载点。
    assert.equal(env.gateLog.length, 0)
    assert.equal(env.transport.calls.filter((c) => c.method === 'runGate').length, 0)
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
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-halfway-'))
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore(), config: new MemoryConfigStore({ socketPath }) })
  try {
    await assert.rejects(
      host.register(createHerdrPlugin()),
      (e: unknown) => ['plugin_registration_failed', 'plugin_service_start_failed', 'herdr_socket'].includes((e as HelmError).code),
    )
    // 订阅已清理（listener 集空）。wire stop() 只 destroy 客户端 socket；
    // fixture server 侧的 close 释放是异步到达，等其收敛。
    await waitFor(() => transport.eventListeners.length === 0)
    assert.equal(transport.eventListeners.length, 0, '半途失败清理订阅')
  } finally {
    await host.dispose().catch(() => {})
    await served.close()
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

  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({ dataDir, host: backend, docs, config: new MemoryConfigStore({ socketPath }) })
  try {
    // doc pane target 显式指向测试 served socket：target:{} 会 resolve 到宿主
    // 真实 ~/.config/herdr/herdr.sock（对账拿到外部 pane 集合，孤儿回收误判）。
    const doc = docs.store.get('builtin:herdr:managed') as { panes: Array<{ target: Record<string, unknown> }> }
    for (const pane of doc.panes) pane.target = { socketPath }
    await host.register(createHerdrPlugin())
    assert.equal(transport.tabs.get('ws-default:t1')!.closed, true, '孤儿（running+done）回收')
    assert.equal(transport.tabs.get('ws-default:t2')!.closed, false, 'failed 保留现场（即使实际 idle）')
    assert.equal(transport.tabs.get('ws-default:t3')!.closed, false, '同 ID 换 human agent 不误关')
    assert.equal(transport.tabs.get('ws-default:t4')!.closed, true, '已结束 keepalive 孤儿同样回收')
  } finally {
    await host.dispose().catch(() => {})
    await served.close()
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

// ---------------------------------------------------------------------------
// 快照菜单提取与审批闭环复核
// ---------------------------------------------------------------------------

/** Agy 信任目录弹窗快照（游标列表选择式对话框）。 */
const AGY_TRUST_SNAPSHOT = [
  '/root/.herdr/worktrees/helm/helm-wf-cocmre',
  '',
  'Do you trust the contents of this project?',
  '',
  'Antigravity CLI requires permission to read, edit, and',
  'execute files here.',
  '',
  '> Yes, I trust this folder',
  '  No, exit',
  '',
  '  ↑/↓ Navigate · enter Confirm',
  '',
].join('\n')

test('单测A: 快照游标菜单提取与按键映射——allow-enter/menu-1/custom 均正确发键', { timeout: 60_000 }, async () => {
  // 阶段 1：纯函数验证（不启动插件）。
  const { extractMenuItemsFromSnapshot, buildHerdrAskPromptPlan, parseCustomKeys } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  const items = extractMenuItemsFromSnapshot(AGY_TRUST_SNAPSHOT)
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((i) => ({ label: i.label, keys: i.keys, selected: i.selected })),
    [
      { label: 'Yes, I trust this folder', keys: ['enter'], selected: true },
      { label: 'No, exit', keys: ['down', 'enter'], selected: false },
    ],
  )
  const plan = buildHerdrAskPromptPlan(AGY_TRUST_SNAPSHOT)
  assert.deepEqual(plan.decisionKeys.get('allow-enter'), ['enter'])
  assert.deepEqual(plan.decisionKeys.get('menu-1'), ['down', 'enter'])
  assert.deepEqual(parseCustomKeys('down, enter'), ['down', 'enter'])
  assert.deepEqual(parseCustomKeys(''), [])

  // 阶段 2：AskDoc options 与 description 代码块围栏。
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = AGY_TRUST_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter')
    assert.ok(options[0]!.label.includes('Yes, I trust this folder'))
    assert.equal(options[1]!.value, 'menu-1')
    assert.ok(options[1]!.label.includes('No, exit'))
    assert.ok(options[1]!.label.includes('down + enter'))
    assert.ok((ask['description'] as string).includes('```'), 'description 含代码块围栏')

    // 回答 allow-enter -> 发送 ['enter']。
    const askId = ask['id'] as string
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['enter'])

    // 终端消化后收尾。
    const pane = [...env.transport.panes.values()][0]!
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'trusted')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'trusted')
  } finally {
    await env.close()
  }
})

test('单测A-续: menu-1 与 custom 多键序列经完整审批桥发送', { timeout: 60_000 }, async () => {
  for (const answer of [{ decision: 'menu-1' }, { decision: 'custom', key: 'down, enter' }] as Record<string, string>[]) {
    const env = await makeEnv()
    try {
      env.transport.promptStatus = 'blocked'
      env.transport.snapshotText = AGY_TRUST_SNAPSHOT
      const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
      await waitFor(() => env.backend.createdAsks.length === 1)
      const askId = env.backend.createdAsks[0]!['id'] as string
      env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: answer })
      await waitFor(() => env.transport.sendKeysLog.length === 1)
      assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['down', 'enter'])
      const pane = [...env.transport.panes.values()][0]!
      const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'picked')
      env.transport.consumeKeys(pane.paneId, 'done')
      assert.equal(await resultPromise, 'picked')
    } finally {
      await env.close()
    }
  }
})

test('单测B: 按键未生效时闭环复核——自动重开 AskDoc 且带未生效提示，二次选择后成功', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })

    // 第 1 次 AskDoc：人类回答 allow-y，发出 ['y']。
    await waitFor(() => env.backend.createdAsks.length === 1)
    const pane = [...env.transport.panes.values()][0]!
    const firstId = env.backend.createdAsks[0]!['id'] as string
    assert.ok(/:10$|:\d+$/.test(firstId), '首个 id 形如 herdr:local:<pane>:<seq>')
    env.backend.answerAsk(firstId, { id: firstId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['y'])

    // 终端不响应 y：保持 blocked 且 seq 不变（consumeKeys 不调用）。
    // 经退避后协调器自动重开第 2 次 AskDoc（id 带 :r1 后缀）。
    await waitFor(() => env.backend.createdAsks.length === 2, 15_000, 50)
    const second = env.backend.createdAsks[1]!
    const secondId = second['id'] as string
    assert.equal(secondId, `${firstId}:r1`, '重开 AskDoc id 为 <key>:r1')
    assert.ok((second['description'] as string).includes('上次发送的按键 [y] 未解除阻塞'), '重开描述含未生效提示')

    // 第 2 次回答 allow-enter -> 发送 ['enter'] -> 终端推进 done -> spawn 成功。
    env.backend.answerAsk(secondId, { id: secondId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 2)
    assert.deepEqual(env.transport.sendKeysLog[1]!.keys, ['enter'])
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'recovered')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'recovered')
    assert.equal(env.backend.createdAsks.length, 2, '整个闭环恰好两次 AskDoc')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 混合快慢路径：AI 快照解析辅助层
// ---------------------------------------------------------------------------

/** 非标快捷键提示快照（正则无法识别为标准菜单）。 */
const NONSTANDARD_HINT_SNAPSHOT = [
  'Tool bash requires confirmation',
  'Press (o)nce, (a)lways allow, or (d)eny',
].join('\n')

test('单测C: 按键白名单与 AI JSON 清洗纯函数验证', { timeout: 60_000 }, async () => {
  const { isValidHerdrLogicalKey, parseAiSnapshotAnalysisText } = await import('../src/builtin-plugins/herdr/prompt-options.js')

  // 白名单：合法按键。
  for (const key of ['enter', 'down', 'shift+tab', 'ctrl+c', 'f1', 'a', '1']) {
    assert.equal(isValidHerdrLogicalKey(key), true, `合法按键 ${key}`)
  }
  // 白名单：非法按键（多字母单词 / 空串 / 带空格 / 分隔符 '+'）。加号用 plus。
  for (const key of ['', 'yes', 'allow', 'enter key', '+']) {
    assert.equal(isValidHerdrLogicalKey(key), false, `非法按键 "${key}"`)
  }
  assert.equal(isValidHerdrLogicalKey('plus'), true, 'plus 命名键合法')

  // JSON 提取：```json 围栏 + 脏选项剔除。
  const fenced = '```json\n{"summary":"等待 bash 执行确认","options":[{"label":"仅本次允许","keys":["o"]},{"label":"总是允许","keys":["yes"]},{"label":"移到下一项后确认","keys":["right","enter"]}]}\n```'
  const parsed = parseAiSnapshotAnalysisText(fenced)!
  assert.ok(parsed !== undefined, '围栏 JSON 可解析')
  assert.equal(parsed.summary, '等待 bash 执行确认')
  assert.deepEqual(
    parsed.options.map((o) => o.keys),
    [['o'], ['right', 'enter']],
    '含非法按键 ["yes"] 的脏选项被剔除，合法选项保留',
  )

  // JSON 提取：无围栏裸 JSON（截取首 { 到末 }）。
  const bare = parseAiSnapshotAnalysisText('好的，解析结果如下 {"summary":"等待确认","options":[{"label":"允许","keys":["a"]}]} 以上。')
  assert.ok(bare !== undefined)
  assert.deepEqual(bare.options, [{ label: '允许', keys: ['a'] }])

  // 解析失败：非 JSON 文本 / 非法 JSON / 全部选项被剔除且无摘要。
  assert.equal(parseAiSnapshotAnalysisText('模型拒绝回答'), undefined)
  assert.equal(parseAiSnapshotAnalysisText('{"broken": '), undefined)
  assert.equal(parseAiSnapshotAnalysisText('{"options":[{"label":"x","keys":["yes"]}]}'), undefined)
})

test('单测D-1: 正则命中标准菜单时不调 AI（0ms 快路径优先）', { timeout: 60_000 }, async () => {
  let aiCalls = 0
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => {
      aiCalls += 1
      return '{"summary":"不应被调用","options":[{"label":"幻觉选项","keys":["z"]}]}'
    },
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = AGY_TRUST_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    await delay(200)
    assert.equal(aiCalls, 0, '正则命中时不调 AI（省 Token）')
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter', '仍是快路径菜单选项')
    assert.ok(!options.some((o) => o.value.startsWith('ai-')), '无 AI 选项注入')
    // 收尾。
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'fast-path')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'fast-path')
    assert.equal(aiCalls, 0, '全程零 AI 调用')
  } finally {
    await env.close()
  }
})

test('单测D-2: 非标快照时调 AI 生成选项并正确发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () =>
      JSON.stringify({
        summary: '终端等待 bash 工具执行确认',
        options: [
          { label: '仅本次允许 (once)', keys: ['o'] },
          { label: '总是允许 (always)', keys: ['a'] },
          { label: '拒绝 (deny)', keys: ['d'] },
        ],
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    assert.ok(description.includes('阻塞摘要：终端等待 bash 工具执行确认'), 'description 含阻塞摘要')
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter', '首项补允许 enter')
    const ai0 = options.find((o) => o.value === 'ai-0')!
    const ai1 = options.find((o) => o.value === 'ai-1')!
    const ai2 = options.find((o) => o.value === 'ai-2')!
    assert.ok(ai0 && ai0.label.includes('仅本次允许') && ai0.label.includes('发送 o'), 'ai-0 标注按键')
    assert.ok(ai1 && ai1.label.includes('总是允许'))
    assert.ok(ai2 && ai2.label.includes('拒绝'))
    // 人类选择 ai-1（总是允许）-> 发送 ['a']。
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'ai-1' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['a'], 'ai-1 准确发送 [a]')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'ai-allowed')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'ai-allowed')
  } finally {
    await env.close()
  }
})

test('单测D-3: AI 抛错或返回 undefined 时无感回退通用选项', { timeout: 60_000 }, async () => {
  for (const behavior of ['throw', 'undefined'] as const) {
    const env = await makeEnv({
      analyzeBlockedSnapshot: async () => {
        if (behavior === 'throw') throw new Error('model timeout')
        return '模型拒绝回答'
      },
    })
    try {
      env.transport.promptStatus = 'blocked'
      env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
      const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
      await waitFor(() => env.backend.createdAsks.length === 1)
      const ask = env.backend.createdAsks[0]!
      const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
      const values = options.map((o) => o.value)
      assert.deepEqual(
        values,
        ['allow-enter', 'allow-y', 'deny-n', 'send-esc', 'custom'],
        `${behavior} 时平稳回退默认选项`,
      )
      assert.ok(!(ask['description'] as string).includes('阻塞摘要'), '无 AI 摘要')
      // 收尾：回答 deny-n -> 发送 ['n']。
      const askId = ask['id'] as string
      const pane = [...env.transport.panes.values()][0]!
      env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'deny-n' } })
      await waitFor(() => env.transport.sendKeysLog.length === 1)
      assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['n'])
      const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'fallback')
      env.transport.consumeKeys(pane.paneId, 'done')
      assert.equal(await resultPromise, 'fallback')
    } finally {
      await env.close()
    }
  }
})

// ---------------------------------------------------------------------------
// 快路径防误判 fixture：正文步骤列表 / 缩进建议正文不得识别成菜单
// ---------------------------------------------------------------------------

test('单测E-1: 正文步骤列表不是菜单——步骤编号 + y/n 提问不进快路径（走 AI）', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  const snapshot = ['之前步骤：', '  1. 安装依赖', '  2. 编译构建', '现在请确认是否继续？(y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(snapshot), [], '正文步骤列表不得识别为菜单')
})

test('单测E-2: 游标建议行 + 不同缩进正文不是菜单', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  const snapshot = ['> 我建议采用方案 A', '    补充说明'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(snapshot), [], '缩进层级不齐的正文不得当作菜单兄弟项')
})

test('单测E-3: 标准菜单 fixture 仍命中快路径且不调 AI（AGY / Codex 编号菜单）', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  // AGY 游标菜单（无编号）。
  const agy = extractMenuItemsFromSnapshot(AGY_TRUST_SNAPSHOT)
  assert.equal(agy.length, 2)
  assert.equal(agy[0]!.selected, true)
  // Codex 编号菜单（游标 + 导航提示）。
  const codexSnapshot = [
    '╭─ bash ─╮',
    '  > 1. Yes',
    '    2. Yes, and auto-accept',
    '    3. No',
    '╰────────╯',
    '  ↑/↓ Navigate · enter Confirm',
  ].join('\n')
  const codex = extractMenuItemsFromSnapshot(codexSnapshot)
  assert.equal(codex.length, 3, '编号菜单带游标 + 提示命中快路径')
  assert.equal(codex[0]!.selected, true)

  // 端到端：标准菜单 fixture 下 analyzeBlockedSnapshot 不被调用。
  let aiCalls = 0
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => {
      aiCalls += 1
      return '不应被调用'
    },
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = codexSnapshot
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.ok(options[0]!.value === 'allow-enter' && options.some((o) => o.value === 'menu-1'), '编号菜单快路径选项')
    assert.equal(aiCalls, 0, '标准菜单不调 AI')
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'codex-fast')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'codex-fast')
  } finally {
    await env.close()
  }
})

test('单测E-4: 疑似不截断——超 8 项连续编号 / 编号不连续 / 历史编号后跟新正文均返回空', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  // 超 8 项：更像正文步骤列表，不截成假菜单。
  const tooMany = ['Select an option:', ...Array.from({ length: 10 }, (_, i) => `  ${i + 1}. option ${i + 1}`)].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(tooMany), [], '超 8 项连续编号不截断')
  // 编号不从 1 开始连续：非真实菜单。
  const notFromOne = ['Select an option:', '  2. second', '  3. third'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(notFromOne), [], '编号不连续拒绝')
  // 历史编号块后跟新正文：不选历史菜单。
  const stale = ['  1. old choice', '  2. another old', '', 'some new body text line', 'now blocked? (y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(stale), [], '跨正文历史编号拒绝')
  // 无游标且无确认/选择提问：正文步骤（交 AI），不默认首项高亮。
  const noPrompt = ['  1. alpha', '  2. beta'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(noPrompt), [], '无游标无确认提问交 AI')
  // 无游标但带确认提问：同样不默认首项（无可靠选中信息一律交 AI）。
  const numberedPrompt = ['Select an option:', '  1. Deploy to production', '  2. Deploy to staging'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(numberedPrompt), [], '无游标编号列表不默认首项高亮')
  // 多游标编号块：解析噪声，拒绝。
  const multiCursor = ['  > 1. Yes', '  > 2. No', '', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(multiCursor), [], '多游标编号块拒绝')
})

test('单测E-4b: 菜单块后跟新正文拒绝；Press enter to continue 与装饰框线为合法提示', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/builtin-plugins/herdr/prompt-options.js')
  // 旧 Agy 游标菜单后跟新正文 y/n 提问：整体拒绝，不选历史菜单。
  const agyThenBody = ['> Yes, I trust this folder', '  No, exit', '', '  ↑/↓ Navigate · enter Confirm', '', '现在请确认？(y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(agyThenBody), [], '菜单块后新正文拒绝')
  // Codex 'Press enter to continue' 是合法交互证据。
  const codexHint = ['> Yes', '  No', '', 'Press enter to continue'].join('\n')
  assert.equal(extractMenuItemsFromSnapshot(codexHint).length, 2, 'Press enter to continue 命中快路径')
  // Codex 装饰框线（╭─ ─╮/╰─╯）是菜单装饰，不是正文。
  const codexFramed = ['╭─ bash ─╮', '  > 1. Yes', '    2. Yes, and auto-accept', '    3. No', '╰────────╯', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.equal(extractMenuItemsFromSnapshot(codexFramed).length, 3, '框线包围的编号菜单命中快路径')
  // 超 8 项游标列表：不截断成前 8 项。
  const tooManyCursor = ['> first', ...Array.from({ length: 10 }, (_, i) => `  option ${i + 2}`), '', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(tooManyCursor), [], '超 8 项游标列表不截断')
})

test('单测E-5: AI labels 与 summary 在最终 AskSpec 边界统一脱敏', { timeout: 60_000 }, async () => {
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () =>
      JSON.stringify({
        summary: '等待确认 SECRET-TOKEN 泄漏测试',
        options: [{ label: '允许 SECRET-TOKEN', keys: ['o'] }],
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.ok(!description.includes('SECRET-TOKEN'), 'summary 脱敏后进入 description')
    for (const opt of options) {
      assert.ok(!opt.label.includes('SECRET-TOKEN'), `label 脱敏：${opt.label}`)
    }
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'redacted')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'redacted')
  } finally {
    await env.close()
  }
})

test('单测E-6: AI 解析失败通知与 description 尾部快照', { timeout: 60_000 }, async () => {
  const longTail = `${'x'.repeat(2000)}\nTAIL-MARKER`
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => '模型拒绝回答（非 JSON 文本触发回退诊断）',
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = longTail
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    // 诊断写入 description（人类可见的回退说明）。
    assert.ok(description.includes('已回退通用按键选项'), 'description 含回退诊断')
    // 快照展示尾部：人类能看到 AI 所据的当前菜单。
    assert.ok(description.includes('TAIL-MARKER'), 'description 快照取尾部')
    assert.ok(!description.slice(0, description.indexOf('```')).includes('xxxx'), '不展示快照头部')
    // 通知通道也如实说明（不静默）。
    await waitFor(() => env.backend.notifications.some((n) => n.title.includes('AI 解析未完成')), 5_000)
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'deny-n' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'notified')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'notified')
  } finally {
    await env.close()
  }
})

test('单测E-7: AI 等待期间 seq 推进不挂旧 AskDoc（synthetic superseded）', { timeout: 60_000 }, async () => {
  let releaseAi: (() => void) | undefined
  const env = await makeEnv({
    analyzeBlockedSnapshot: () =>
      new Promise((resolve) => {
        releaseAi = () => resolve('已无意义')
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    // AI 挂起期间终端自行推进（seq +1 -> done）：不创建 Ask。
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.read'), 5_000)
    const pane = [...env.transport.panes.values()][0]!
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'self-resolved')
    env.transport.consumeKeys(pane.paneId, 'done')
    releaseAi?.()
    // seq 已推进：旧 Ask 不落地，spawn 正常收尾。
    assert.equal(await resultPromise, 'self-resolved')
    const herdrAsks = env.backend.createdAsks.filter((a) => (a['id'] as string).startsWith('herdr:'))
    assert.equal(herdrAsks.length, 0, 'AI 等待期间 seq 推进后不再挂旧 AskDoc')
  } finally {
    releaseAi?.()
    await env.close()
  }
})

test('单测E-8: 无 AI 选项（端口未注入）时自动补 allow-enter 并发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv() // 不注入 analyzeBlockedSnapshot。
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    const values = options.map((o) => o.value)
    assert.deepEqual(values, ['allow-enter', 'allow-y', 'deny-n', 'send-esc', 'custom'])
    assert.ok(options[0]!.label.startsWith('发送 enter'), '首项语义只描述发送键，不含授权承诺')
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['enter'], '人类选择 allow-enter 后自动发送 enter')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'auto-enter')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'auto-enter')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 探针短超时、并发采集与断线退避自愈
// ---------------------------------------------------------------------------

interface ProbeFakePane {
  paneId: string
  agentStatus: string
  seq: number
  name?: string
  cwd: string
}

class ProbeTransport implements HerdrTransport {
  panes = new Map<string, ProbeFakePane>()
  agentGetDelayMs = 0
  private subscriptionErrorTriggers: Array<(error: Error) => void> = []

  private agentInfoOf(pane: ProbeFakePane) {
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
    void options
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

interface HerdrProbeEnv {
  host: PluginHost
  backend: FakeBackend
  transport: ProbeTransport
  ipcCalls: Array<{ method: string; timeoutMs?: number }>
  close(): Promise<void>
}

const HERDR_REMOTE_NODE = 'n1'

async function makeHerdrProbeEnv(
  panes: Array<{ paneId: string; agentName: string; cwd: string; status?: string; seq?: number }>,
): Promise<HerdrProbeEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-probe-'))
  const backend = new FakeBackend()
  const docs = new MemoryDocStore()
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: panes.map((p) => ({
      target: { nodeId: HERDR_REMOTE_NODE },
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
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(
    transport,
    socketPath,
    () => ({ nodeId: HERDR_REMOTE_NODE }),
  )
  const ipcCalls: Array<{ method: string; timeoutMs?: number }> = []
  backend.nodeIpc = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    call: async (_nodeId, input, signal) => {
      const method = (JSON.parse(input.line) as { method: string }).method
      ipcCalls.push({ method, timeoutMs: input.timeoutMs })
      return ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
    },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 不承载 IPC 订阅', 501) },
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs,
    config: new MemoryConfigStore({ socketPath }),
  })
  try {
    await host.register(createHerdrPlugin(), { enabled: true })
  } catch (error) {
    await host.dispose().catch(() => {})
    await served.close()
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
  return {
    host,
    backend,
    transport,
    ipcCalls,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function runHerdrTick(env: HerdrProbeEnv): Promise<DiagnosticsCollection> {
  const payload: DiagnosticsCollection = { timestamp: Date.now(), conversations: [], probes: [] }
  await env.backend.emitEvent('diagnostics.collect', payload)
  return payload
}

test('herdr tick：agent.get / session.snapshot 全部带 5s 短超时', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    await runHerdrTick(env)
    const relevant = env.ipcCalls.filter((c) => c.method === 'agent.get' || c.method === 'session.snapshot')
    assert.ok(relevant.length > 0, '应有 agent.get / session.snapshot 经 nodeIpc 通道到达受控服务器')
    for (const call of relevant) {
      assert.equal(call.timeoutMs, 5_000, `${call.method} 应带 timeoutMs=5000（实际 ${String(call.timeoutMs)}）`)
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
  const env = await makeHerdrProbeEnv(panes)
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

test('herdr 订阅断线：onError 后自动退避重连（watchdogEnabled 无关）', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const before = env.transport.subscribeCount
    env.transport.failLatestSubscription(new Error('socket reset by peer'))
    const deadline = Date.now() + 2_000
    while (!env.backend.notifications.some((n) => n.title === 'Herdr 事件订阅断开')) {
      if (Date.now() > deadline) break
      await delay(50)
    }
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
  const env = await makeHerdrProbeEnv([])
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

test('herdr tick：归属变化窗格结算移除后不再产出 probe', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const first = await runHerdrTick(env)
    assert.equal(first.probes.length, 1)
    env.transport.panes.get('w:p1')!.name = 'human-agent'
    const second = await runHerdrTick(env)
    assert.equal(second.probes.length, 0, '归属变化窗格应结算移除，不再产出 probe')
    env.transport.panes.get('w:p1')!.name = 'helm-wf-a'
    const third = await runHerdrTick(env)
    assert.equal(third.probes.length, 0)
  } finally {
    await env.close()
  }
})
