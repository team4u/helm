/**
 * builtin:herdr cwd 收口测试：
 * - resolveCwd（spawn-rules 纯函数）：链（request > workspace > parent）解析后
 *   按目标平台统一收口——platform undefined 透传不改写（远端无可信信息不猜）、
 *   win32 确定性转换（WSL / 盘符根 / UNC 视图）、坏 POSIX 根显式拒绝、
 *   链尾空串语义保持；
 * - nodeChannelFromHost：宿主 nodeIpc 可选 nodePlatform 能力检测（存在透传 /
 *   缺席省略，不伪造）；LocalNodeChannel 本机平台 = process.platform；
 * - HerdrExecutor 端到端（真实执行器 + 受控 transport）：目标节点经通道上报
 *   win32 时，request.cwd 的 WSL 视图在建窗（tab.create）前被规范化为
 *   C:\…；坏 POSIX cwd 在任何建窗副作用之前显式拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AgentGateResult, type AskResult, type MaybePromise, type Profile } from '@helm/protocol'
import { resolveCwd, type SpawnRouting } from '../src/builtin-plugins/herdr/spawn-rules.js'
import { nodeChannelFromHost } from '../src/builtin-plugins/herdr/host-ports.js'
import { LocalNodeChannel } from '../src/builtin-plugins/herdr/local-node-channel.js'
import { HerdrExecutor, type ExecutorHost } from '../src/builtin-plugins/herdr/executor.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedDoc } from '../src/builtin-plugins/herdr/panes.js'
import { AskCoordinator } from '../src/builtin-plugins/herdr/asks.js'
import { MetadataProjector } from '../src/builtin-plugins/herdr/metadata.js'
import type { HerdrEvent, HerdrNodeChannel, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

// ---------------------------------------------------------------------------
// resolveCwd（纯函数）
// ---------------------------------------------------------------------------

test('resolveCwd：platform 未知（undefined）——链语义与透传保持（向后兼容）', () => {
  const routing: SpawnRouting = { kind: 'agy', nodeId: 'win-build', args: [], profileEnv: {} }
  assert.equal(resolveCwd('/mnt/c/work', routing, undefined, undefined), '/mnt/c/work')
  assert.equal(resolveCwd(undefined, routing, '/home/parent', undefined), '/home/parent')
  assert.equal(resolveCwd(undefined, undefined, undefined, undefined), '', '链尾空串语义保持')
  assert.throws(
    () => resolveCwd('relative/ws', routing, undefined, undefined),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
})

test('resolveCwd：win32 平台——request/workspace/parent 三级均确定性转换', () => {
  const routing: SpawnRouting = { kind: 'agy', args: [], workspace: '/d/profile-ws', profileEnv: {} }
  assert.equal(resolveCwd('/mnt/c/work/helm', routing, undefined, 'win32'), 'C:\\work\\helm')
  assert.equal(resolveCwd(undefined, routing, undefined, 'win32'), 'D:\\profile-ws', 'workspace 回退按目标平台收口')
  assert.equal(resolveCwd(undefined, undefined, '/e/parent-dir', 'win32'), 'E:\\parent-dir')
  // UNC 拼写视图同样收敛。
  assert.equal(resolveCwd('//server/share/ws', undefined, undefined, 'win32'), '\\\\server\\share\\ws')
})

test('resolveCwd：win32 平台——坏 POSIX 根显式拒绝（不建窗、不落任何记录）', () => {
  for (const bad of ['/home/user', '/tmp/herdr']) {
    assert.throws(
      () => resolveCwd(bad, undefined, undefined, 'win32'),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
      `'${bad}' 无盘符对应必须显式失败`,
    )
  }
})

test('resolveCwd：posix 平台——词法归一且绝不反向转换 /mnt/<盘符>', () => {
  assert.equal(resolveCwd('/mnt/c/work/./x', undefined, undefined, 'posix'), '/mnt/c/work/x')
})

// ---------------------------------------------------------------------------
// 平台事实接线（host-ports 能力检测 / LocalNodeChannel）
// ---------------------------------------------------------------------------

test('nodeChannelFromHost：宿主 nodePlatform 能力存在则透传，缺席则省略（不伪造）', () => {
  const calls: string[] = []
  const withPlatform = nodeChannelFromHost({
    nodeIpc: {
      isOnline: () => true,
      call: (() => {
        throw new Error(' unreachable ')
      }) as never,
      subscribe: (() => {
        throw new Error(' unreachable ')
      }) as never,
      nodePlatform: (nodeId: string) => {
        calls.push(nodeId)
        return nodeId === 'win-build' ? 'win32' : undefined
      },
    },
    executionEnv: (() => {
      throw new Error(' unreachable ')
    }) as never,
  } as never)
  assert.equal(withPlatform.nodePlatform?.('win-build'), 'win32')
  assert.deepEqual(calls, ['win-build'])

  const without = nodeChannelFromHost({
    nodeIpc: {
      isOnline: () => true,
      call: (() => {
        throw new Error(' unreachable ')
      }) as never,
      subscribe: (() => {
        throw new Error(' unreachable ')
      }) as never,
    },
    executionEnv: (() => {
      throw new Error(' unreachable ')
    }) as never,
  } as never)
  assert.equal(without.nodePlatform, undefined, '宿主无该能力时省略（远端平台未知，不猜）')
})

test('LocalNodeChannel：本机节点平台 = process.platform；远端不承载', () => {
  const channel: HerdrNodeChannel = new LocalNodeChannel()
  assert.equal(channel.nodePlatform?.('local'), process.platform)
  assert.equal(channel.nodePlatform?.('remote-a'), undefined)
})

// ---------------------------------------------------------------------------
// HerdrExecutor 端到端（真实执行器 + 受控 transport）
// ---------------------------------------------------------------------------

type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

interface FakePane {
  paneId: string
  tabId: string
  status: PaneStatus
  seq: number
  cwd: string
  launchPending: boolean
  name?: string
}

/** 受控 transport：记录全部协议调用；prompt 即完成（写交接文件）。 */
class FakeTransport implements HerdrTransport {
  panes = new Map<string, FakePane>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []

  private paneOf(ref: unknown): FakePane {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  private infoOf(pane: FakePane) {
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

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ target, method, params })
    switch (method) {
      case 'tab.create': {
        const n = this.panes.size + 1
        const paneId = `ws:p${n}`
        this.panes.set(paneId, {
          paneId,
          tabId: `ws:t${n}`,
          status: 'idle',
          seq: 1,
          cwd: (params['cwd'] as string) ?? '/tmp',
          launchPending: false,
        })
        return {
          type: 'tab_created',
          tab: { tab_id: `ws:t${n}`, workspace_id: 'ws' },
          root_pane: { pane_id: paneId, workspace_id: 'ws', tab_id: `ws:t${n}` },
        }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.status = 'unknown'
        pane.launchPending = true
        pane.seq = 0
        return { type: 'agent_started', argv: [], agent: this.infoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        if (pane.status === 'unknown' && pane.launchPending) {
          await delay(5)
          pane.status = 'idle'
          pane.launchPending = false
          pane.seq += 1
        }
        return { type: 'agent_info', agent: this.infoOf(pane) }
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        pane.status = 'done'
        pane.seq += 1
        // prompt 即完成：写交接文件（与生产链路同路径 <cwd>/.helm/wf-out-*.md）。
        const fileName = (params['text'] as string).match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
        const dir = join(pane.cwd, '.helm')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, fileName), 'herdr-done')
        return { type: 'agent_prompted', agent: this.infoOf(pane) }
      }
      case 'agent.get':
        return { type: 'agent_info', agent: this.infoOf(this.paneOf(params['target'])) }
      case 'agent.read':
        return { type: 'pane_read', read: { pane_id: this.paneOf(params['target']).paneId, text: 'tail' } }
      case 'tab.close':
        return { type: 'ok' }
      default:
        throw new HelmError('method_not_found', `fake: ${method}`, 400)
    }
  }

  async readOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const path = join(cwd, '.helm', fileName)
    return await import('node:fs').then((fs) => fs.readFileSync(path, 'utf8'))
  }

  async removeOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    await import('node:fs').then((fs) => fs.rmSync(join(cwd, '.helm', fileName)))
  }

  async runGate(): Promise<AgentGateResult> {
    return { ok: true, output: 'gate ok' }
  }

  async subscribe(_target: HerdrTarget, _onEvent: (event: HerdrEvent) => void, _onError: (error: unknown) => void): Promise<() => void> {
    return () => {}
  }
}

interface ExecutorEnv {
  executor: HerdrExecutor
  transport: FakeTransport
  close(): Promise<void>
}

/** 真实 HerdrExecutor 装配（受控 transport + 平台上报通道；零私有缝）。 */
async function openExecutor(platforms: Record<string, string>): Promise<ExecutorEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-cwd-'))
  const transport = new FakeTransport()
  const nodeChannel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => 'http://127.0.0.1:3202',
    nodePlatform: (nodeId) => platforms[nodeId],
    ipcCall: () => {
      throw new HelmError('unsupported', '本测试不经 IPC', 501)
    },
    envFor: () => {
      throw new HelmError('unsupported', '本测试不用 envFor', 501)
    },
  }
  const profiles = new Map<string, Profile>()
  let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [...EMPTY_MANAGED_DOC.panes] }
  const registry = new PaneRegistry(
    { get: () => doc, set: (next) => { doc = next } },
    doc,
  )
  const asks = new AskCoordinator(() => undefined)
  const projector = new MetadataProjector(async () => ({}), () => undefined)
  const host: ExecutorHost = {
    parentCwdOf: () => '/home/parent-project',
    parentNodeIdOf: () => 'win-build',
    askConversationId: (id) => id,
    notify: () => undefined,
    startupTimeoutMs: () => 5_000,
    createAsk: (() => {
      throw new HelmError('unsupported', 'happy path 无 Ask', 501)
    }) as never,
    cancelAsk: (() => {
      throw new HelmError('unsupported', 'happy path 无 Ask', 501)
    }) as never,
  }
  const executor = new HerdrExecutor(
    {
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (_conversationId, cwd, nodeId) => ({ HELM_CWD: cwd, HELM_ENV: '1' }),
      redact: (t) => t,
      runLocalGate: async () => ({ ok: true, output: 'gate ok' }),
      nodeChannel,
      transport,
    },
    registry,
    asks,
    projector,
    host,
    transport,
    {},
    10,
  )
  return {
    executor,
    transport,
    async close() {
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('executor：远端 win-build 节点（通道上报 win32）——WSL 视图 cwd 建窗前规范化', { timeout: 60_000 }, async () => {
  const env = await openExecutor({ 'win-build': 'win32' })
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 1,
      prompt: '构建它',
      agentType: 'herdr:agy@win-build',
      cwd: '/mnt/c/work/helm',
    } as never)) as { action: string; result: unknown }
    assert.equal(outcome.action, 'handled')
    assert.equal(outcome.result, 'herdr-done', '交接文件读自规范化路径下的 .helm（pane.cwd 同为规范路径）')
    const create = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], 'C:\\work\\helm', '建窗收到规范化 Windows 路径')
    assert.deepEqual(create.target, { nodeId: 'win-build' })
  } finally {
    await env.close()
  }
})

test('executor：远端 win32 节点上的坏 POSIX cwd 在任何建窗副作用前拒绝', { timeout: 60_000 }, async () => {
  const env = await openExecutor({ 'win-build': 'win32' })
  try {
    await assert.rejects(
      env.executor.handle({
        parentConversationId: 1,
        prompt: '构建它',
        agentType: 'herdr:agy@win-build',
        cwd: '/home/build',
      } as never),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    assert.equal(env.transport.calls.length, 0, '拒绝发生在建窗副作用之前')
  } finally {
    await env.close()
  }
})

test('executor：节点平台未知（通道未上报）——cwd 透传不改写（既有行为保持）', { timeout: 60_000 }, async () => {
  const env = await openExecutor({})
  try {
    await env.executor.handle({
      parentConversationId: 1,
      prompt: '构建它',
      agentType: 'herdr:agy@win-build',
      cwd: '/home/build/posix-view',
    } as never)
    const create = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], '/home/build/posix-view', '平台未知：POSIX 视图原样到达建窗')
  } finally {
    await env.close()
  }
})
