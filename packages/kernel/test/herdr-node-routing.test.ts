/**
 * builtin:herdr 节点路由链回归（主代理审查点 5 的针对性验证）：
 * - 父会话绑定远端节点时，无显式/Profile 节点的子 spawn 继承父节点（不总落本机）；
 * - 显式 herdr:kind@local 覆盖远端父节点（不折叠丢失）；
 * - 优先级链：显式 @node > Profile.runtime.nodeId > Profile 顶层 nodeId > 父节点；
 * - Profile.cwd 作为 runtime.workspace 之后的回退（resolveCwd 链）；
 * - spawn cwd 接受 Windows 盘符/UNC 绝对路径（纯规则，不依赖 Hub 平台）；
 * - 空串 nodeId 显式拒绝（不默默当本机）；
 * - ExecutorHost.parentNodeIdOf 由生产 herdr.ts 经 getConversation(id).nodeId 提供。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// 受控环境（与 herdr-plugin-fixes 同构；父会话 nodeId 可配置）
// ---------------------------------------------------------------------------

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

class FakeTransport implements HerdrTransport {
  panes = new Map<string, { paneId: string; tabId: string; name?: string; status: PaneStatus; seq: number; cwd: string }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  outputFiles = new Map<string, string>()
  promptStatus: PaneStatus = 'done'
  onPrompt: ((paneId: string, text: string) => void) | undefined

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method, params })
    switch (method) {
      case 'events.subscribe':
        return () => {}
      case 'session.snapshot':
        return { type: 'session_snapshot', snapshot: { agents: [], panes: [], tabs: [], workspaces: [] } }
      case 'tab.create': {
        const n = this.panes.size + 1
        const paneId = `ws:p${n}`
        const tabId = `ws:t${n}`
        this.panes.set(paneId, { paneId, tabId, status: 'idle', seq: 1, cwd: (params['cwd'] as string) ?? '/tmp' })
        return { type: 'tab_created', tab: { tab_id: tabId, workspace_id: 'ws' }, root_pane: { pane_id: paneId, workspace_id: 'ws', tab_id: tabId } }
      }
      case 'agent.start': {
        const pane = this.panes.get(String(params['pane_id']))!
        pane.name = params['name'] as string
        pane.status = 'idle'
        pane.seq += 1
        return { type: 'agent_started', argv: [], agent: this.agentInfoOf(pane) }
      }
      case 'agent.get': {
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: this.agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: this.agentInfoOf(pane) }
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        pane.status = this.promptStatus
        pane.seq += 1
        this.onPrompt?.(pane.paneId, text)
        return { type: 'agent_prompted', agent: this.agentInfoOf(pane) }
      }
      case 'agent.read': {
        const pane = this.paneOf(params['target'])
        return { type: 'pane_read', read: { pane_id: pane.paneId, text: 'ok' } }
      }
      case 'tab.close':
        return { type: 'ok' }
      default:
        throw new HelmError('method_not_found', `fake: ${method}`, 400)
    }
  }

  private paneOf(ref: unknown) {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  private agentInfoOf(pane: { paneId: string; tabId: string; name?: string; status: PaneStatus; seq: number; cwd: string }) {
    return {
      pane_id: pane.paneId,
      tab_id: pane.tabId,
      workspace_id: 'ws',
      agent_status: pane.status,
      interactive_ready: pane.status !== 'unknown',
      state_change_seq: pane.seq,
      cwd: pane.cwd,
      ...(pane.name !== undefined ? { name: pane.name } : {}),
    }
  }

  async readOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) throw new HelmError('herdr_output_missing', `missing: ${fileName}`, 404)
    return content
  }

  async removeOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.outputFiles.delete(`${cwd}/.helm/${fileName}`)
  }

  async runGate(): Promise<AgentGateResult> {
    return { ok: true, output: 'gate ok' }
  }

  async subscribe(_target: HerdrTarget, _onEvent: (event: HerdrEvent) => void, _onError: (error: unknown) => void): Promise<() => void> {
    return () => {}
  }
}

class FakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  notifications: Array<{ title: string; body: string; level: string }> = []
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>()
  workflowListeners = new Set<(run: WorkflowRunSummary) => void | Promise<void>>()
  createdAsks: Array<Record<string, unknown>> = []
  cancelledAsks: Array<{ id: string; reason?: string }> = []
  pendingAskResolvers = new Map<string, (r: AskResult) => void>()

  constructor() {
    this.conversations.set(1, this.makeConversation(1))
  }

  makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `conv-${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/tmp/helm-node-chain-parent',
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

  dispatchTrigger(): Promise<void> { return Promise.resolve() }
  submitInput(): Promise<void> { return Promise.resolve() }
  createConversation(): Promise<ConversationSummary> { return Promise.resolve(this.makeConversation(99)) }
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
    const id = spec.id ?? `ask-${this.createdAsks.length + 1}`
    this.createdAsks.push({ ...spec, id })
    return new Promise<AskResult>((resolve) => {
      this.pendingAskResolvers.set(id, resolve)
    })
  }
  answerAsk(id: string, result: AskResult): void {
    this.pendingAskResolvers.get(id)?.(result)
    this.pendingAskResolvers.delete(id)
  }
  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    this.cancelledAsks.push({ id, reason })
    this.pendingAskResolvers.get(id)?.({ id, status: reason === 'cancelled' ? 'cancelled' : 'superseded', answers: {} })
    this.pendingAskResolvers.delete(id)
  }
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    this.askSeqResolvers.add(resolver)
    return () => { this.askSeqResolvers.delete(resolver) }
  }
  async abortConversation(): Promise<void> {}
  async spawnAgent(): Promise<unknown> {
    return {}
  }
  async runGate(): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: '' }
  }
  async prepareInterruptedConversations(): Promise<void> {}
  async cleanupWorktree(): Promise<import('@helm/protocol').WorktreeCleanupResult> {
    return { removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }
  }
  async invokeAction(): Promise<unknown> {
    return {}
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  async execEnv(): Promise<import('@helm/protocol').EnvExecResponse> {
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  }
  listActions(): [] {
    return []
  }
  onEvent(_type: string, listener: (payload: unknown) => void | Promise<void>): () => void {
    this.workflowListeners.add(listener as (run: WorkflowRunSummary) => void | Promise<void>)
    return () => { this.workflowListeners.delete(listener as (run: WorkflowRunSummary) => void | Promise<void>) }
  }
  emitEvent(type: string, payload: unknown): void {
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

  async flush(): Promise<void> {}
}

interface Env {
  host: PluginHost
  backend: FakeBackend
  transport: FakeTransport
  profiles: Map<string, Profile>
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId: string }>
  close(): Promise<void>
}

async function makeEnv(over: Partial<ConversationSummary> = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-nodechain-'))
  const backend = new FakeBackend()
  Object.assign(backend.conversations.get(1)!, over)
  const transport = new FakeTransport()
  const profiles = new Map<string, Profile>()
  const spawnEnvLog: Env['spawnEnvLog'] = []
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
  await host.register(
    createHerdrPlugin({
      defaultCwd: '/tmp/helm-herdr-default',
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (conversationId, cwd, nodeId) => {
        spawnEnvLog.push({ conversationId, cwd, nodeId })
        return { HELM_ENV: '1', HELM_HUB_URL: 'http://127.0.0.1:3202', HELM_TOKEN: 'T', HELM_CWD: cwd }
      },
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
    profiles,
    spawnEnvLog,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function scriptSuccess(env: Env, content: string): void {
  env.transport.onPrompt = (paneId, text) => {
    const pane = env.transport.panes.get(paneId)!
    const fileName = text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, content)
  }
}

async function spawnDirect(env: Env, request: Record<string, unknown>): Promise<unknown> {
  const outcome = await env.host.runHook('agent_spawn', {
    parentConversationId: 1,
    prompt: 'do the thing',
    ...request,
  } as never)
  if (outcome.action === 'handled') return outcome.result
  return { __notHandled: true }
}

// ---------------------------------------------------------------------------
// 优先级链与继承
// ---------------------------------------------------------------------------

test('父会话绑定远端节点：无显式节点的子 spawn 继承父节点，绝不总落本机', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ nodeId: 'build-farm' })
  try {
    scriptSuccess(env, 'inherited')
    const result = await spawnDirect(env, { agentType: 'herdr:agy' })
    assert.equal(result, 'inherited')
    const create = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.deepEqual(create.target, { nodeId: 'build-farm' }, '建窗走父会话绑定节点')
    // buildSpawnEnv 收到确切 nodeId（build-farm），不是折叠后的 undefined。
    assert.equal(env.spawnEnvLog.at(-1)!.nodeId, 'build-farm')
  } finally {
    await env.close()
  }
})

test('显式 @local 覆盖远端父节点（local 不折叠丢失，buildSpawnEnv 传确切 local）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ nodeId: 'build-farm' })
  try {
    scriptSuccess(env, 'local-override')
    const result = await spawnDirect(env, { agentType: 'herdr:agy@local' })
    assert.equal(result, 'local-override')
    const create = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.target.nodeId, undefined, 'local 目标即本机（无 nodeId 字段）')
    assert.equal(env.spawnEnvLog.at(-1)!.nodeId, 'local', 'buildSpawnEnv 第三参显式 local，不让内核按父会话继承')
    const envSent = create.params['env'] as Record<string, string>
    assert.equal(envSent['HELM_HUB_URL'], 'http://127.0.0.1:3202', '本机窗格保留本机回连变量')
    assert.equal(envSent['HELM_TOKEN'], 'T')
  } finally {
    await env.close()
  }
})

test('优先级链：Profile.runtime.nodeId > Profile 顶层 nodeId > 父节点', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ nodeId: 'parent-node' })
  try {
    // Profile 顶层 nodeId（无 runtime.nodeId 时生效）。
    env.profiles.set('top-node', { id: 'top-node', nodeId: 'profile-top', runtime: { kind: 'herdr', agent: 'agy' } })
    scriptSuccess(env, 'a')
    await spawnDirect(env, { agentType: 'top-node' })
    assert.deepEqual(env.transport.calls.find((c) => c.method === 'tab.create')!.target, { nodeId: 'profile-top' })

    // runtime.nodeId 覆盖 Profile 顶层 nodeId。
    env.profiles.set('rt-node', { id: 'rt-node', nodeId: 'profile-top', runtime: { kind: 'herdr', agent: 'agy', nodeId: 'runtime-node' } })
    scriptSuccess(env, 'b')
    await spawnDirect(env, { agentType: 'rt-node' })
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'runtime-node' })

    // 显式 @node 覆盖 Profile（runtime）nodeId：显式前缀形式 herdr:kind@node。
    scriptSuccess(env, 'c')
    await spawnDirect(env, { agentType: 'herdr:agy@explicit-node' })
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'explicit-node' })

    // 显式 @local 覆盖远端父节点与 Profile runtime.nodeId（合法切换，不折叠丢失）。
    scriptSuccess(env, 'd')
    await spawnDirect(env, { agentType: 'herdr:agy@local' })
    const localCreate = env.transport.calls.findLast((c) => c.method === 'tab.create')!
    assert.equal(localCreate.target.nodeId, undefined)
    assert.equal(env.spawnEnvLog.at(-1)!.nodeId, 'local')
  } finally {
    await env.close()
  }
})

test('Profile.cwd 作为工作目录回退（runtime.workspace 优先）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ nodeId: 'remote-a' })
  try {
    // 无 workspace：Profile.cwd 生效。
    env.profiles.set('ws-cwd', { id: 'ws-cwd', cwd: '/srv/profile-home', runtime: { kind: 'herdr', agent: 'agy' } })
    scriptSuccess(env, 'a')
    await spawnDirect(env, { agentType: 'ws-cwd' })
    let create = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], '/srv/profile-home', 'Profile.cwd 作为窗格工作目录')

    // runtime.workspace 覆盖 Profile.cwd。
    env.profiles.set('ws-rt', { id: 'ws-rt', cwd: '/srv/profile-home', runtime: { kind: 'herdr', agent: 'agy', workspace: '/srv/runtime-ws' } })
    scriptSuccess(env, 'b')
    await spawnDirect(env, { agentType: 'ws-rt' })
    create = env.transport.calls.findLast((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], '/srv/runtime-ws', 'runtime.workspace 优先于 Profile.cwd')

    // request.cwd 最高。
    scriptSuccess(env, 'c')
    await spawnDirect(env, { agentType: 'ws-rt', cwd: '/srv/request-cwd' })
    create = env.transport.calls.findLast((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], '/srv/request-cwd')
  } finally {
    await env.close()
  }
})

test('spawn cwd 接受 Windows 盘符与 UNC 绝对路径（纯规则，不依赖 Hub 平台）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ nodeId: 'win-build' })
  try {
    scriptSuccess(env, 'win-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', cwd: 'C:\\build\\helm' })
    assert.equal(env.transport.calls.find((c) => c.method === 'tab.create')!.params['cwd'], 'C:\\build\\helm', '盘符绝对路径放行')

    scriptSuccess(env, 'unc-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', cwd: '\\\\srv\\share\\work' })
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], '\\\\srv\\share\\work', 'UNC 绝对路径放行')

    // C:relative（盘符后无分隔）是相对形态：拒绝。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', cwd: 'C:relative' }),
      (e: unknown) => (e as HelmError).code === 'validation_error',
    )
  } finally {
    await env.close()
  }
})

test('Profile workspace/cwd 非绝对路径显式拒绝（含 Windows 相对形态）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('bad-ws', { id: 'bad-ws', runtime: { kind: 'herdr', agent: 'agy', workspace: 'relative/ws' } })
    await assert.rejects(
      spawnDirect(env, { agentType: 'bad-ws' }),
      (e: unknown) => (e as HelmError).code === 'validation_error',
    )
    env.profiles.set('bad-cwd', { id: 'bad-cwd', cwd: 'C:relative', runtime: { kind: 'herdr', agent: 'agy' } })
    await assert.rejects(
      spawnDirect(env, { agentType: 'bad-cwd' }),
      (e: unknown) => (e as HelmError).code === 'validation_error',
    )
    env.profiles.set('bad-node', { id: 'bad-node', runtime: { kind: 'herdr', agent: 'agy', nodeId: '' } })
    await assert.rejects(
      spawnDirect(env, { agentType: 'bad-node' }),
      (e: unknown) => (e as HelmError).code === 'validation_error',
    )
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy@' }),
      (e: unknown) => (e as HelmError).code === 'validation_error',
    )
  } finally {
    await env.close()
  }
})

test('父会话不存在时（parentNodeIdOf 同源）spawn 显式失败', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', parentConversationId: 999 }),
      (e: unknown) => (e as HelmError).status === 404,
    )
  } finally {
    await env.close()
  }
})
