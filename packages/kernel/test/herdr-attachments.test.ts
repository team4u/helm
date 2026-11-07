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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type Profile } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

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
  outputFiles = new Map<string, string>()
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
  onWorkflowSettled() {
    return () => {}
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
}

interface Env {
  host: PluginHost
  transport: FakeTransport
  profiles: Map<string, Profile>
  /** 附件元数据解析记录（deps.getArtifact 调用）。 */
  artifactLookups: Array<{ id: string; conversationId: number }>
  close(): Promise<void>
}

async function makeEnv(opts: { withGetArtifact?: boolean } = {}): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-attach-'))
  const backend = new FakeBackend()
  const transport = new FakeTransport()
  const profiles = new Map<string, Profile>()
  const artifactLookups: Env['artifactLookups'] = []
  const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
  await host.register(
    createHerdrPlugin({
      defaultCwd: '/tmp/helm-herdr-default',
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (conversationId, cwd) => ({
        HELM_ENV: '1',
        HELM_HUB_URL: 'http://127.0.0.1:3202',
        HELM_TOKEN: 'SECRET-TOKEN',
        HELM_CWD: cwd,
        HELM_CONVERSATION_ID: String(conversationId),
      }),
      redact: (text) => text.replaceAll('SECRET-TOKEN', '[REDACTED]'),
      runLocalGate: async () => ({ ok: true, output: 'local gate ok' }),
      ...(opts.withGetArtifact
        ? {
            getArtifact: async (id: string, conversationId: number) => {
              artifactLookups.push({ id, conversationId })
              return {
                id,
                name: 'spec.md',
                mimeType: 'text/markdown',
                size: 42,
                absPath: `/data/artifacts/1/${id}-spec.md`,
              }
            },
          }
        : {}),
      transport,
    }),
    { enabled: true },
  )
  return {
    host,
    transport,
    profiles,
    artifactLookups,
    async close() {
      await host.dispose().catch(() => {})
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
        agentType: 'herdr:agy@remote-host',
        attachments: ['art-id-1', 'art-id-2'],
      }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'remote_hub_unreachable_for_artifacts')
        assert.equal(err.status, 400)
        assert.ok(err.message.includes("remote-host"))
        assert.ok(err.message.includes('HELM_HUB_URL'))
        const details = err.details as { machine: string; attachments: string[] }
        assert.equal(details.machine, 'remote-host')
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
      runtime: { kind: 'herdr', agent: 'agy', machine: 'far-host' },
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
        machine: 'remote-host',
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
        machine: 'remote-host',
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
      runtime: { kind: 'herdr', agent: 'agy', machine: 'remote-host' },
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
