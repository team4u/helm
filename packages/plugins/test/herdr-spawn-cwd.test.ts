/**
 * builtin:herdr cwd 收口与启动配置边界测试：
 * - resolveCwd（spawn-rules 纯函数）：链（request > workspace > parent）解析后
 *   按目标平台统一收口——platform undefined 透传不改写、win32 确定性转换、
 *   坏 POSIX 根显式拒绝、链尾空串语义保持；
 * - startupTimeoutMs 非法值显式 validation_error，parentCwd 父会话缺失 404 不吞错误；
 * - nodeChannelFromHost：宿主 nodeIpc 可选 nodePlatform 能力检测；
 * - HerdrExecutor 端到端（真实执行器 + 受控 transport）：目标节点上报 win32 时
 *   WSL 视图 cwd 在建窗前规范化，坏 POSIX cwd 在建窗副作用前拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type Profile } from '@helm/protocol'
import { normalizeStartupTimeoutMs, resolveCwd, type SpawnRouting } from '../src/herdr/spawn-rules.js'
import { nodeChannelFromHost } from '../src/herdr/host-ports.js'
import { LocalNodeChannel } from '../src/herdr/local-node-channel.js'
import { HerdrExecutor, type ExecutorHost } from '../src/herdr/executor.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedDoc } from '../src/herdr/panes.js'
import { AskCoordinator } from '../src/herdr/asks.js'
import { MetadataProjector } from '../src/herdr/metadata.js'
import type { HerdrNodeChannel, HerdrTarget } from '../src/herdr/contracts.js'
import {
  BaseFakeHerdrTransport,
  agentInfoOf,
  herdrFileNameOf,
  openHerdrUnitEnv,
  spawnHerdrDirect,
} from './helpers/herdr-unit-fixture.js'

// ---------------------------------------------------------------------------
// resolveCwd / normalizeStartupTimeoutMs（纯函数与插件注册边界）
// ---------------------------------------------------------------------------

test('resolveCwd：platform 未知（undefined）——链语义与透传保持', { timeout: 60_000 }, () => {
  const routing: SpawnRouting = { kind: 'agy', nodeId: 'win-build', args: [], profileEnv: {} }
  assert.equal(resolveCwd('/mnt/c/work', routing, undefined, undefined), '/mnt/c/work')
  assert.equal(resolveCwd(undefined, routing, '/home/parent', undefined), '/home/parent')
  assert.equal(resolveCwd(undefined, undefined, undefined, undefined), '', '链尾空串语义保持')
  assert.throws(
    () => resolveCwd('relative/ws', routing, undefined, undefined),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
})

test('resolveCwd：win32 平台——request/workspace/parent 三级确定性转换与坏 POSIX 根拒绝', { timeout: 60_000 }, () => {
  const routing: SpawnRouting = { kind: 'agy', args: [], workspace: '/d/profile-ws', profileEnv: {} }
  assert.equal(resolveCwd('/mnt/c/work/helm', routing, undefined, 'win32'), 'C:\\work\\helm')
  assert.equal(resolveCwd(undefined, routing, undefined, 'win32'), 'D:\\profile-ws', 'workspace 回退按目标平台收口')
  assert.equal(resolveCwd(undefined, undefined, '/e/parent-dir', 'win32'), 'E:\\parent-dir')
  assert.equal(resolveCwd('//server/share/ws', undefined, undefined, 'win32'), '\\\\server\\share\\ws')
  for (const bad of ['/home/user', '/tmp/herdr']) {
    assert.throws(
      () => resolveCwd(bad, undefined, undefined, 'win32'),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
      `'${bad}' 无盘符对应必须显式失败`,
    )
  }
})

test('resolveCwd：posix 平台——词法归一且绝不反向转换 /mnt/<盘符>', { timeout: 60_000 }, () => {
  assert.equal(resolveCwd('/mnt/c/work/./x', undefined, undefined, 'posix'), '/mnt/c/work/x')
})

test('startupTimeoutMs 非法值显式 validation_error；父会话不存在时 parentCwd 显式 404', { timeout: 60_000 }, async () => {
  for (const bad of [0, 3000, 300001, 1.5, NaN]) {
    assert.throws(
      () => normalizeStartupTimeoutMs(bad),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
  await assert.rejects(
    openHerdrUnitEnv({ config: { startupTimeoutMs: 0 } }),
    (e: unknown) => (e as HelmError).code === 'validation_error',
  )
  const env = await openHerdrUnitEnv()
  try {
    await assert.rejects(
      spawnHerdrDirect(env, { agentType: 'herdr:agy', cwd: undefined, parentConversationId: 999 }),
      (e: unknown) => (e as HelmError).status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 平台事实接线（host-ports 能力检测 / LocalNodeChannel）
// ---------------------------------------------------------------------------

test('nodeChannelFromHost 与 LocalNodeChannel：能力存在透传、缺席省略、远端不猜', { timeout: 60_000 }, () => {
  const calls: string[] = []
  const withPlatform = nodeChannelFromHost({
    nodeIpc: {
      isOnline: () => true,
      call: (() => { throw new Error('unreachable') }) as never,
      subscribe: (() => { throw new Error('unreachable') }) as never,
      nodePlatform: (nodeId: string) => {
        calls.push(nodeId)
        return nodeId === 'win-build' ? 'win32' : undefined
      },
    },
    executionEnv: (() => { throw new Error('unreachable') }) as never,
  } as never)
  assert.equal(withPlatform.nodePlatform?.('win-build'), 'win32')
  assert.deepEqual(calls, ['win-build'])

  const without = nodeChannelFromHost({
    nodeIpc: {
      isOnline: () => true,
      call: (() => { throw new Error('unreachable') }) as never,
      subscribe: (() => { throw new Error('unreachable') }) as never,
    },
    executionEnv: (() => { throw new Error('unreachable') }) as never,
  } as never)
  assert.equal(without.nodePlatform, undefined)

  const channel: HerdrNodeChannel = new LocalNodeChannel()
  assert.equal(channel.nodePlatform?.('local'), process.platform)
  assert.equal(channel.nodePlatform?.('remote-a'), undefined)
})

// ---------------------------------------------------------------------------
// HerdrExecutor 端到端（真实执行器 + 内存交接 transport，避免在 Linux 创建 C:\）
// ---------------------------------------------------------------------------

class MemoryCwdTransport extends BaseFakeHerdrTransport {
  outputs = new Map<string, string>()

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.record(target, method, params)
    switch (method) {
      case 'tab.create':
        return this.createTabPane(params, false)
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.agentStatus = 'unknown'
        pane.launchPending = true
        pane.seq = 0
        return { type: 'agent_started', argv: [], agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        if (pane.agentStatus === 'unknown' && pane.launchPending) {
          await delay(5)
          pane.agentStatus = 'idle'
          pane.launchPending = false
          pane.seq += 1
        }
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        pane.agentStatus = 'done'
        pane.seq += 1
        this.outputs.set(`${pane.cwd}\0${herdrFileNameOf(params['text'] as string)}`, 'herdr-done')
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.get':
        return { type: 'agent_info', agent: agentInfoOf(this.paneOf(params['target'])) }
      case 'agent.read':
        return { type: 'pane_read', read: { pane_id: this.paneOf(params['target']).paneId, text: 'tail' } }
      case 'tab.close':
        return { type: 'ok' }
      default:
        throw new HelmError('method_not_found', `fake: ${method}`, 400)
    }
  }

  override async readOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const content = this.outputs.get(`${cwd}\0${fileName}`)
    if (content === undefined) {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
    }
    return content
  }

  override async removeOutput(_target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.outputs.delete(`${cwd}\0${fileName}`)
  }
}

async function openExecutor(platforms: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-cwd-'))
  const transport = new MemoryCwdTransport()
  const nodeChannel: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => 'http://127.0.0.1:3202',
    nodePlatform: (nodeId) => platforms[nodeId],
    ipcCall: () => { throw new HelmError('unsupported', '本测试不经 IPC', 501) },
    envFor: () => { throw new HelmError('unsupported', '本测试不用 envFor', 501) },
  }
  const profiles = new Map<string, Profile>()
  let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [...EMPTY_MANAGED_DOC.panes] }
  const registry = new PaneRegistry({ get: () => doc, set: (next) => { doc = next } }, doc)
  const asks = new AskCoordinator(() => undefined)
  const projector = new MetadataProjector(async () => ({}), () => undefined)
  const host: ExecutorHost = {
    parentCwdOf: () => '/home/parent-project',
    parentNodeIdOf: () => 'win-build',
    askConversationId: (id) => id,
    notify: () => undefined,
    startupTimeoutMs: () => 5_000,
    createAsk: (() => { throw new HelmError('unsupported', 'happy path 无 Ask', 501) }) as never,
    cancelAsk: (() => { throw new HelmError('unsupported', 'happy path 无 Ask', 501) }) as never,
  }
  const executor = new HerdrExecutor(
    {
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (_conversationId, cwd) => ({ HELM_CWD: cwd, HELM_ENV: '1' }),
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
    dataDir,
    async close() {
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('executor：win32 节点 WSL 视图 cwd 建窗前规范化、坏 POSIX 根零副作用拒绝、未知平台透传', { timeout: 60_000 }, async () => {
  const winEnv = await openExecutor({ 'win-build': 'win32' })
  try {
    await assert.rejects(
      winEnv.executor.handle({
        parentConversationId: 1,
        prompt: '构建它',
        agentType: 'herdr:agy@win-build',
        cwd: '/home/build',
      } as never),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    assert.equal(winEnv.transport.calls.length, 0, '拒绝发生在建窗副作用之前')

    const outcome = (await winEnv.executor.handle({
      parentConversationId: 1,
      prompt: '构建它',
      agentType: 'herdr:agy@win-build',
      cwd: '/mnt/c/work/helm',
    } as never)) as { action: string; result: unknown }
    assert.equal(outcome.action, 'handled')
    assert.equal(outcome.result, 'herdr-done')
    const create = winEnv.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], 'C:\\work\\helm', '建窗收到规范化 Windows 路径')
    assert.deepEqual(create.target, { nodeId: 'win-build' })
  } finally {
    await winEnv.close()
  }

  const unknownEnv = await openExecutor({})
  try {
    const posixView = join(unknownEnv.dataDir, 'posix-view')
    await unknownEnv.executor.handle({
      parentConversationId: 1,
      prompt: '构建它',
      agentType: 'herdr:agy@win-build',
      cwd: posixView,
    } as never)
    const create = unknownEnv.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(create.params['cwd'], posixView, '平台未知：POSIX 视图原样到达建窗')
  } finally {
    await unknownEnv.close()
  }
})
