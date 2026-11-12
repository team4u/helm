/**
 * 模块三测试：Herdr 跨机附件诚实门禁与 [Attached Files] 注入。
 * 真实 PluginHost + 受控 FakeTransport（herdr.test.ts 同款模式）：
 * - 远端机器未配置可达 HELM_HUB_URL 且携带附件：
 *   remote_hub_unreachable_for_artifacts，且零建窗副作用（无 tab.create）；
 * - 远端 Profile 显式配置可达 HELM_HUB_URL：门禁通过，taskPrompt 注入
 *   [Attached Files]（含拉取指引 helm artifacts get）；
 * - 本机窗格携带附件：直接通过，注入本机 path 与拉取命令；
 * - deps.getArtifact 提供完整元数据；未注入时退化用裸 ID（不伪造）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type Profile } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { FsOutputFiles, ipcLineCall, serveTransport } from './helpers/herdr-unit-fixture.js'
import type { HerdrEvent, HerdrNodeChannel, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

// ---------------------------------------------------------------------------
// 受控 HerdrTransport（与 herdr.test.ts 同款裁剪版）
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

class FakeTransport implements HerdrTransport {
  panes = new Map<string, PaneState>()
  tabs = new Map<string, { closed: boolean }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  outputFiles = new FsOutputFiles()
  promptStatus: PaneStatus | Array<PaneStatus> = 'idle'
  onPrompt: ((pane: PaneState, text: string) => void) | undefined

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method, params })
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
      case 'tab.close': {
        const tabId = params['tab_id'] as string
        const tab = this.tabs.get(tabId)
        if (tab) tab.closed = true
        return { type: 'ok' }
      }
      case 'agent.start': {
        const pane = this.panes.get(String(params['pane_id']))!
        pane.name = params['name'] as string
        pane.agentStatus = 'idle'
        pane.seq += 1
        return { type: 'agent_started', agent: agentInfoOf(pane), argv: [] }
      }
      case 'agent.get': {
        const pane = this.panes.get(String(params['target']))!
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.panes.get(String(params['target']))!
        const until = ((params['until'] as string[]) ?? []).map((s) => s as PaneStatus)
        for (let i = 0; i < 600; i += 1) {
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          await delay(10)
        }
        throw new HelmError('timeout', 'timed out', 408)
      }
      case 'agent.prompt': {
        const pane = this.panes.get(String(params['target']))!
        const text = params['text'] as string
        pane.agentStatus = Array.isArray(this.promptStatus)
          ? (this.promptStatus.shift() ?? 'idle')
          : this.promptStatus
        pane.seq += 1
        if (this.onPrompt) this.onPrompt(pane, text)
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.read': {
        const pane = this.panes.get(String(params['target']))!
        return { type: 'pane_read', read: { pane_id: pane.paneId, text: `tail of ${pane.paneId}` } }
      }
      case 'session.snapshot': {
        return {
          type: 'session_snapshot',
          snapshot: {
            version: 'test',
            protocol: 22,
            workspaces: [],
            tabs: [],
            panes: [],
            layouts: [],
            agents: [...this.panes.values()].filter((p) => p.name !== undefined).map((p) => agentInfoOf(p)),
          },
        }
      }
      case 'agent.send_keys': {
        return { type: 'ok' }
      }
      case 'agent.focus': {
        const pane = this.panes.get(String(params['target']))!
        return { type: 'agent_info', agent: { ...agentInfoOf(pane), focused: true } }
      }
      default:
        throw new HelmError('method_not_supported', `fake transport 不支持 ${method}`, 400)
    }
  }
  async readOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    void target
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) {
      throw new HelmError('herdr_output_missing', `missing ${fileName}`, 404)
    }
    return content
  }
  async removeOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    void target
    void cwd
    void fileName
  }
  async runGate(target: HerdrTarget, command: string): Promise<{ ok: boolean; output: string }> {
    void target
    void command
    return { ok: true, output: 'gate ok' }
  }
  async subscribe(
    target: HerdrTarget,
    onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    void target
    void onEvent
    void onError
    return () => {}
  }
}

// ---------------------------------------------------------------------------
// 基座
// ---------------------------------------------------------------------------

class FakeBackend implements PluginHostBackend {
  events: Array<{ type: string; payload: unknown }> = []
  conversations = new Map<number, { cwd: string }>([[1, { cwd: '/tmp/helm-parent' }]])
  /** 受控 Profile 表（attachments 显式 nodeId 测试）。 */
  profileStore = new Map<string, Profile>()
  /** buildSpawnEnv 调用记录（serve target 折叠远端 nodeId）。 */
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId?: string }> = []
  profiles = {
    list: async () => [...this.profileStore.values()],
    get: async (id: string) => this.profileStore.get(id),
    getSystem: async (id: string) => {
      throw new HelmError('not_found', `Profile ${id} 无 SYSTEM.md`, 404)
    },
    save: async () => { throw new HelmError('unsupported', 'fixture 只读', 501) },
    directory: async (id: string) => `/tmp/herdr-attach-fixture-profiles/${id}`,
  }
  skills = {
    list: async () => [],
    readFile: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
    directory: async (id: string) => `/tmp/herdr-attach-fixture-skills/${id}`,
    ensureSkill: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
  }
  secrets = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    addRedaction: () => () => {},
  }
  setPluginConfig(): Promise<void> { return Promise.resolve() }
  nodeIpc: import('@helm/protocol').HelmHostNodeIpcPort = {
    isOnline: (nodeId: string) => nodeId === 'local',
    getNodeHubUrl: () => undefined,
    call: async () => ({ ok: false, error: { code: 'unknown', message: 'fixture 不承载 IPC' } }),
    subscribe: async () => { throw new HelmError('unsupported', 'fixture 不承载 IPC 订阅', 501) },
  }
  redact = (text: string) => text.replaceAll('SECRET-TOKEN', '[REDACTED]')
  buildSpawnEnv = (conversationId: number, cwd: string, nodeId: string) => {
    this.spawnEnvLog.push({ conversationId, cwd, nodeId })
    return {
      HELM_ENV: '1',
      HELM_HUB_URL: 'http://127.0.0.1:3202',
      HELM_TOKEN: 'SECRET-TOKEN',
      HELM_CWD: cwd,
      HELM_CONVERSATION_ID: String(conversationId),
    }
  }
  async getConversationDetail(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无详情', 501) }
  async listArtifacts(): Promise<never[]> { return [] }
  getArtifactImpl: ((id: string, conversationId: number) => Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }>) | undefined
  async getArtifact(id: string, conversationId: number): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    if (this.getArtifactImpl !== undefined) return this.getArtifactImpl(id, conversationId)
    return undefined as never
  }
  async completeText(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型', 501) }
  executionEnv = (_nodeId: string, cwd: string) => {
    mkdirSync(cwd, { recursive: true })
    return new NodeExecutionEnv({ cwd })
  }
  withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() }
  async atomicWriteFile(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无原子写', 501) }
  async refreshModels(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async probeNodeFs(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不探测节点 fs', 501) }
  redactText(text: string): string { return text }
  async dispatchTrigger() {}
  async submitInput() {}
  async createConversation(): Promise<import('@helm/protocol').ConversationSummary> {
    throw new HelmError('not_implemented', '测试基座不创建会话', 500)
  }
  listConversations() {
    return []
  }
  getConversation(id: number) {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return {
      id,
      title: 'x',
      profileId: 'assistant',
      tags: [],
      cwd: found.cwd,
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle' as const,
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }
  }
  async updateConversation(id: number) {
    return this.getConversation(id)
  }
  manageConversation() {
    return () => {}
  }
  markConversationOwnership() {}
  async createAsk() {
    return { id: 'ask-1', status: 'answered' as const, answers: {} }
  }
  async cancelAsk() {}
  registerAskSeqResolver() {
    return () => {}
  }
  onEvent(): () => void {
    return () => {}
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
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload })
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
  transport: FakeTransport
  profiles: Map<string, Profile>
  /** 附件元数据解析记录（deps.getArtifact 调用）。 */
  artifactLookups: Array<{ id: string; conversationId: number }>
  close(): Promise<void>
}

class MemoryConfigStore {
  constructor(private readonly initial: Record<string, unknown> = {}) {}
  get(): Record<string, unknown> { return this.initial }
  set(): void {}
}

async function makeEnv(opts: { withGetArtifact?: boolean; hubUrls?: Record<string, string> } = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-attach-'))
  const backend = new FakeBackend()
  const transport = new FakeTransport()
  const profiles = backend.profileStore
  const artifactLookups: Env['artifactLookups'] = []
  if (opts.withGetArtifact) {
    backend.getArtifactImpl = async (id, conversationId) => {
      artifactLookups.push({ id, conversationId })
      return {
        id,
        name: 'spec.md',
        mimeType: 'text/markdown',
        size: 42,
        absPath: `/data/artifacts/1/${id}-spec.md`,
      }
    }
  }
  // 受控协议服务器：远端 nodeId 目标经 backend.nodeIpc 路由到同一 fixture
  // （hubUrl 事实由 nodeIpc.getNodeHubUrl 提供；本机 target 走配置 socketPath）。
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath, () => {
    const last = backend.spawnEnvLog.at(-1)?.nodeId
    if (last !== undefined && last !== 'local') return { nodeId: last }
    return {}
  })
  const hubUrls = opts.hubUrls ?? {}
  backend.nodeIpc = {
    isOnline: (nodeId: string) => nodeId === 'local' || nodeId in hubUrls || nodeId === 'remote-node',
    getNodeHubUrl: (nodeId: string) => hubUrls[nodeId],
    // 远端行协议与本地同一受控 transport：经 nodeIpc（serve 侧把 target
    // 折叠为对应 nodeId）一问一答。
    call: async (nodeId: string, input: { endpoint?: string; session?: string; line: string; timeoutMs?: number }, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
    },
    subscribe: async () => { throw new HelmError('unsupported', 'attachments fixture 不订阅远端事件', 501) },
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    config: new MemoryConfigStore({ socketPath }),
  })
  await host.register(createHerdrPlugin(), { enabled: true })
  return {
    host,
    transport,
    profiles,
    artifactLookups,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
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

function fileNameOf(text: string): string {
  return text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
}

function scriptSuccess(env: Env, content: string): void {
  env.transport.promptStatus = 'done'
  env.transport.onPrompt = (pane, text) => {
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, content)
  }
}

// ---------------------------------------------------------------------------
// 门禁：远端无可达 HELM_HUB_URL
// ---------------------------------------------------------------------------

test('远端未配置可达 HELM_HUB_URL：附件显式报 remote_hub_unreachable_for_artifacts 且零建窗', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'herdr:agy@remote-node',
        attachments: ['art-id-1', 'art-id-2'],
      }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'remote_hub_unreachable_for_artifacts')
        assert.equal(err.status, 400)
        assert.ok(err.message.includes("remote-node"), `错误信息应含节点名：${err.message}`)
        assert.ok(err.message.includes('HELM_HUB_URL'))
        const details = err.details as { nodeId: string; attachments: string[] }
        assert.equal(details.nodeId, 'remote-node')
        assert.deepEqual(details.attachments, ['art-id-1', 'art-id-2'])
        return true
      },
    )
    // 零建窗副作用：绝不调用 tab.create / worktree.create / agent.start。
    for (const method of ['tab.create', 'worktree.create', 'agent.start', 'agent.prompt']) {
      assert.equal(
        env.transport.calls.filter((c) => c.method === method).length,
        0,
        `${method} 不得被调用（无远端副作用）`,
      )
    }
  } finally {
    await env.close()
  }
})

test('远端 Profile 路径同样受门禁保护（machine 来自 Profile.runtime）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('far-broken', {
      id: 'far-broken',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'far-node' },
    })
    await assert.rejects(
      spawnDirect(env, { agentType: 'far-broken', attachments: ['a1'] }),
      (err: unknown) => err instanceof HelmError && err.code === 'remote_hub_unreachable_for_artifacts',
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, 0)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 门禁通过：远端配置可达 HELM_HUB_URL / 本机窗格
// ---------------------------------------------------------------------------

test('远端配置可达 HELM_HUB_URL：门禁通过，注入附件拉取指引（远端形态）', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ withGetArtifact: true })
  try {
    env.profiles.set('far', {
      id: 'far',
      runtime: {
        kind: 'herdr',
        agent: 'agy',
        nodeId: 'remote-node',
        env: { HELM_HUB_URL: 'http://10.0.0.5:3202' },
      },
    })
    scriptSuccess(env, 'remote-ok')
    const result = await spawnDirect(env, {
      agentType: 'far',
      attachments: ['art-id-1'],
    })
    assert.equal(result, 'remote-ok')
    // 附件元数据已解析（deps.getArtifact 带父会话授权上下文）。
    assert.deepEqual(env.artifactLookups, [{ id: 'art-id-1', conversationId: 1 }])
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(prompt.includes('[Attached Files]'), '提示词注入附件清单')
    assert.ok(prompt.includes('id=art-id-1'))
    assert.ok(prompt.includes('helm artifacts get art-id-1'), '远端形态给拉取命令')
    assert.ok(prompt.includes('--- helm 交接契约'), '交接契约仍在（附件块插在正文与契约之间）')
    assert.ok(prompt.indexOf('[Attached Files]') < prompt.indexOf('--- helm 交接契约'), '顺序：正文→附件→契约')
  } finally {
    await env.close()
  }
})

test('本机窗格携带附件：直接通过，注入本机 path 与拉取命令', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ withGetArtifact: true })
  try {
    scriptSuccess(env, 'local-ok')
    const result = await spawnDirect(env, {
      agentType: 'herdr:agy',
      attachments: ['art-local-9'],
    })
    assert.equal(result, 'local-ok')
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(prompt.includes('[Attached Files]'))
    assert.ok(prompt.includes('spec.md'), '含产物名（getArtifact 元数据）')
    assert.ok(prompt.includes('path=/data/artifacts/1/'), '本机形态含绝对路径')
    assert.ok(prompt.includes('helm artifacts get art-local-9 --output ./spec.md'))
  } finally {
    await env.close()
  }
})

test('getArtifact 未注入：退化用裸 ID（不伪造元数据），门禁与注入仍工作', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'bare-ok')
    const result = await spawnDirect(env, {
      agentType: 'herdr:agy',
      attachments: ['bare-id-7'],
    })
    assert.equal(result, 'bare-ok')
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(prompt.includes('[Attached Files]'))
    assert.ok(prompt.includes('id=bare-id-7'))
    assert.ok(!prompt.includes('spec.md'), '未注入 getArtifact 时不伪造名称')
  } finally {
    await env.close()
  }
})

test('无附件 spawn 行为不变：提示词无 [Attached Files] 块', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'plain-ok')
    const result = await spawnDirect(env, { agentType: 'herdr:agy' })
    assert.equal(result, 'plain-ok')
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(!prompt.includes('[Attached Files]'))
  } finally {
    await env.close()
  }
})

test('resume 远端窗格携带附件且无可达 HELM_HUB_URL：同样拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 先以可达 URL Profile 建一个远端窗格（不带附件）。
    env.profiles.set('far', {
      id: 'far',
      runtime: {
        kind: 'herdr',
        agent: 'agy',
        nodeId: 'remote-node',
        env: { HELM_HUB_URL: 'http://10.0.0.5:3202' },
      },
    })
    scriptSuccess(env, 'first-ok')
    await spawnDirect(env, { agentType: 'far' })
    const paneId = env.transport.panes.keys().next().value as string
    assert.ok(paneId !== undefined, '远端窗格已创建')
    // 同一 Profile 撤销可达 HELM_HUB_URL（路由 kind/profileId 不变，仅 env 变化）。
    env.profiles.set('far', {
      id: 'far',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node' },
    })
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'far',
        resume: paneId,
        attachments: ['resume-art'],
      }),
      (err: unknown) => err instanceof HelmError && err.code === 'remote_hub_unreachable_for_artifacts',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 节点通道 hubUrl 自动注入（getNodeHubUrl 提供可达地址时放行附件并注入回连）
// ---------------------------------------------------------------------------

/** 只提供 getNodeHubUrl 的最小通道（协议细节由 transport 层测试覆盖）。 */
test('节点通道 hubUrl 可达：附件门禁通过并自动注入 HELM_HUB_URL 回连', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ withGetArtifact: true, hubUrls: { 'build-01': 'http://10.0.0.7:3202' } })
  try {
    scriptSuccess(env, 'hub-ok')
    const result = await spawnDirect(env, {
      agentType: 'herdr:agy@build-01',
      attachments: ['art-x'],
    })
    assert.equal(result, 'hub-ok')
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(envSent['HELM_HUB_URL'], 'http://10.0.0.7:3202', '节点通道 hubUrl 注入为回连地址')
    assert.equal(envSent['HELM_TOKEN'], 'SECRET-TOKEN', 'token 随可达回连保留')
  } finally {
    await env.close()
  }
})

test('节点自身注册的 loopback hubUrl 原样保留，支持同机 BYOM 或节点端隧道', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ withGetArtifact: true, hubUrls: { 'build-02': 'http://127.0.0.1:3202' } })
  try {
    scriptSuccess(env, 'node-loopback-ok')
    assert.equal(await spawnDirect(env, { agentType: 'herdr:agy@build-02', attachments: ['art-x'] }), 'node-loopback-ok')
    const envSent = env.transport.calls.find((call) => call.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(envSent.HELM_HUB_URL, 'http://127.0.0.1:3202')
    assert.equal(envSent.HELM_TOKEN, 'SECRET-TOKEN')
  } finally { await env.close() }
})

test('节点通道提供非法 URL 时不放行附件', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ hubUrls: { 'build-02': 'file:///not-a-hub' } })
  try {
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy@build-02', attachments: ['a1'] }),
      (err: unknown) => (err as HelmError).code === 'remote_hub_unreachable_for_artifacts',
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, 0, '零建窗副作用')
  } finally { await env.close() }
})

test('Profile 显式 hubUrl 优先于节点通道 hubUrl', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ hubUrls: { 'build-03': 'http://10.0.0.7:3202' } })
  try {
    env.profiles.set('explicit-url', {
      id: 'explicit-url',
      runtime: {
        kind: 'herdr',
        agent: 'agy',
        nodeId: 'build-03',
        env: { HELM_HUB_URL: 'http://10.9.9.9:3202' },
      },
    })
    scriptSuccess(env, 'explicit-ok')
    await spawnDirect(env, { agentType: 'explicit-url' })
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(envSent['HELM_HUB_URL'], 'http://10.9.9.9:3202', 'Profile 显式 URL 覆盖通道 hubUrl')
  } finally {
    await env.close()
  }
})
