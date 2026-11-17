/**
 * builtin:herdr 节点路由链、冻结连接、跨节点消歧与受管环境变量权威回归：
 * - 父会话绑定远端节点时，无显式/Profile 节点的子 spawn 继承父节点，显式 @local 覆盖远端父节点；
 * - 优先级链：显式 @node > Profile.runtime.nodeId > Profile 顶层 nodeId > 父节点；
 * - Profile.cwd 回退（runtime.workspace 优先）、Windows 盘符/UNC 绝对路径放行、相对路径与空 nodeId 拒绝；
 * - 冻结连接配置（显式 socketPath 优先于 session 且全部调用一致）；
 * - 跨节点同 paneId 显式 409 pane_ambiguous，nodeId=local/remote-node 精确路由，未知节点 404；
 * - 受管 HELM_* 环境变量权威、远端非法 HELM_HUB_URL 拒绝、worktree 第二步 tab/Gate env 与 resume Profile env 保持。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type Profile } from '@helm/protocol'
import {
  StandardFakeHerdrTransport,
  openHerdrUnitEnv,
  scriptHerdrSuccess,
  spawnHerdrDirect,
} from './helpers/herdr-unit-fixture.js'
import { MemoryDocStore, waitFor as baseWaitFor } from './helpers/plugin-test-env.js'

const waitFor = (predicate: () => boolean, timeoutMs = 5_000, intervalMs = 10): Promise<void> =>
  baseWaitFor(predicate, { timeoutMs, intervalMs, message: 'waitFor 超时' })

test('节点继承与覆盖：父远端继承、显式 @local 覆盖、runtime.nodeId > Profile.nodeId > 父节点', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv({ conversationOverrides: { nodeId: 'build-farm' } })
  try {
    scriptHerdrSuccess(env, 'inherited')
    assert.equal(await spawnHerdrDirect(env, { agentType: 'herdr:agy' }), 'inherited')
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'build-farm' })
    assert.equal(env.spawnEnvLog.at(-1)!.nodeId, 'build-farm')

    scriptHerdrSuccess(env, 'local-override')
    assert.equal(await spawnHerdrDirect(env, { agentType: 'herdr:agy@local' }), 'local-override')
    const localCreate = env.transport.calls.findLast((c) => c.method === 'tab.create')!
    assert.equal(localCreate.target.nodeId, undefined)
    assert.equal(env.spawnEnvLog.at(-1)!.nodeId, 'local')
    const localEnv = localCreate.params['env'] as Record<string, string>
    assert.equal(localEnv['HELM_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(localEnv['HELM_TOKEN'], 'SECRET-TOKEN')

    env.profiles.set('top-node', { id: 'top-node', nodeId: 'profile-top', runtime: { kind: 'herdr', agent: 'agy' } })
    scriptHerdrSuccess(env, 'a')
    await spawnHerdrDirect(env, { agentType: 'top-node' })
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'profile-top' })

    env.profiles.set('rt-node', { id: 'rt-node', nodeId: 'profile-top', runtime: { kind: 'herdr', agent: 'agy', nodeId: 'runtime-node' } })
    scriptHerdrSuccess(env, 'b')
    await spawnHerdrDirect(env, { agentType: 'rt-node' })
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'runtime-node' })

    scriptHerdrSuccess(env, 'c')
    await spawnHerdrDirect(env, { agentType: 'herdr:agy@explicit-node' })
    assert.deepEqual(env.transport.calls.findLast((c) => c.method === 'tab.create')!.target, { nodeId: 'explicit-node' })
  } finally {
    await env.close()
  }
})

test('cwd 回退链与路径/节点校验：request.cwd > runtime.workspace > Profile.cwd、Windows 盘符/UNC 放行、相对形态拒绝', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv({ conversationOverrides: { nodeId: 'remote-a' } })
  const profileHome = mkdtempSync(join(tmpdir(), 'helm-ws-profile-'))
  const runtimeWs = mkdtempSync(join(tmpdir(), 'helm-ws-runtime-'))
  const requestCwd = mkdtempSync(join(tmpdir(), 'helm-ws-request-'))
  try {
    env.profiles.set('ws-cwd', { id: 'ws-cwd', cwd: profileHome, runtime: { kind: 'herdr', agent: 'agy' } })
    scriptHerdrSuccess(env, 'a')
    await spawnHerdrDirect(env, { agentType: 'ws-cwd' })
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], profileHome)

    env.profiles.set('ws-rt', { id: 'ws-rt', cwd: profileHome, runtime: { kind: 'herdr', agent: 'agy', workspace: runtimeWs } })
    scriptHerdrSuccess(env, 'b')
    await spawnHerdrDirect(env, { agentType: 'ws-rt' })
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], runtimeWs)

    scriptHerdrSuccess(env, 'c')
    await spawnHerdrDirect(env, { agentType: 'ws-rt', cwd: requestCwd })
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], requestCwd)

    // Windows 盘符与 UNC 绝对路径放行到 tab.create（本 Linux 宿主无 C:\ 文件系统，交接阶段诚实失败）。
    const beforeCreates = env.transport.calls.filter((c) => c.method === 'tab.create').length
    const drive = spawnHerdrDirect(env, { agentType: 'herdr:agy', cwd: 'C:\\build\\helm' }).catch((e: unknown) => e)
    await waitFor(() => env.transport.calls.filter((c) => c.method === 'tab.create').length >= beforeCreates + 1)
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], 'C:\\build\\helm')
    await drive

    const unc = spawnHerdrDirect(env, { agentType: 'herdr:agy', cwd: '\\\\srv\\share\\work' }).catch((e: unknown) => e)
    await waitFor(() => env.transport.calls.filter((c) => c.method === 'tab.create').length >= beforeCreates + 2)
    assert.equal(env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['cwd'], '\\\\srv\\share\\work')
    await unc

    for (const badReq of [
      { agentType: 'herdr:agy', cwd: 'C:relative' },
      { agentType: 'herdr:agy@' },
    ]) {
      await assert.rejects(spawnHerdrDirect(env, badReq), (e: unknown) => (e as HelmError).code === 'validation_error')
    }
    env.profiles.set('bad-ws', { id: 'bad-ws', runtime: { kind: 'herdr', agent: 'agy', workspace: 'relative/ws' } })
    env.profiles.set('bad-cwd', { id: 'bad-cwd', cwd: 'C:relative', runtime: { kind: 'herdr', agent: 'agy' } })
    env.profiles.set('bad-node', { id: 'bad-node', runtime: { kind: 'herdr', agent: 'agy', nodeId: '' } })
    for (const profileId of ['bad-ws', 'bad-cwd', 'bad-node']) {
      await assert.rejects(spawnHerdrDirect(env, { agentType: profileId }), (e: unknown) => (e as HelmError).code === 'validation_error')
    }
    await assert.rejects(spawnHerdrDirect(env, { agentType: 'herdr:agy', parentConversationId: 999 }), (e: unknown) => (e as HelmError).status === 404)
  } finally {
    await env.close()
    for (const dir of [profileHome, runtimeWs, requestCwd]) rmSync(dir, { recursive: true, force: true })
  }
})

test('冻结连接：session 与显式 socketPath 同时配置时显式 socketPath 生效且全部调用一致', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-frozen-'))
  const explicitSock = join(dataDir, 'explicit.sock')
  const env = await openHerdrUnitEnv({
    dataDir,
    socketPath: explicitSock,
    localTarget: { socketPath: explicitSock },
    config: { session: 'alpha', socketPath: explicitSock },
  })
  try {
    scriptHerdrSuccess(env, 'frozen-ok')
    assert.equal(await spawnHerdrDirect(env, { agentType: 'herdr:agy' }), 'frozen-ok')
    for (const call of env.transport.calls) {
      assert.deepEqual(call.target, { socketPath: explicitSock }, `${call.method} 复用冻结路径`)
    }
  } finally {
    await env.close()
  }
})

test('跨节点相同 paneId 显式 409 pane_ambiguous；带 nodeId=local/remote-node 精确路由；未知节点 404', { timeout: 60_000 }, async () => {
  const docs = new MemoryDocStore()
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-cross-node-'))
  const socketPath = join(dataDir, 'herdr.sock')
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: [undefined, 'remote-node'].map((nodeId) => ({
      target: nodeId === undefined ? { socketPath } : { nodeId },
      routing: { kind: 'pi' },
      paneId: 'w1:p1',
      tabId: 'w1:t1',
      effectiveCwd: '/tmp',
      agentName: 'helm-wf-owned',
      parentConversationId: 1,
      outcome: 'failed',
      createdAt: 1,
    })),
  })
  const transport = new StandardFakeHerdrTransport()
  transport.panes.set('w1:p1', { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'idle', seq: 1, cwd: '/tmp', name: 'helm-wf-owned' })
  transport.tabs.set('w1:t1', { closed: false })
  const env = await openHerdrUnitEnv({ docs, transport, dataDir, socketPath, localTarget: { socketPath } })
  try {
    await assert.rejects(env.host.invokeAction('builtin:herdr', 'read', { paneId: 'w1:p1' }), { code: 'pane_ambiguous' })
    for (const nodeId of ['remote-node', 'local']) {
      const result = (await env.host.invokeAction('builtin:herdr', 'read', { paneId: 'w1:p1', nodeId })) as { nodeId: string; text: string }
      assert.equal(result.nodeId, nodeId)
      assert.ok(result.text.includes('[REDACTED]'))
      const readCall = transport.calls.findLast((call) => call.method === 'agent.read')!
      if (nodeId === 'remote-node') {
        assert.deepEqual(readCall.target, { nodeId: 'remote-node' })
      } else {
        assert.deepEqual(readCall.target, { socketPath })
      }
    }
    await assert.rejects(
      env.host.invokeAction('builtin:herdr', 'read', { paneId: 'w1:p1', nodeId: 'no-such-node' }),
      (e: unknown) => (e as HelmError).status === 404,
    )
  } finally {
    await env.close()
  }
})

test('受管 HELM_* 权威、远端非法 HELM_HUB_URL 拒绝、worktree 第二步 tab/Gate env 与 resume Profile env 保持', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv()
  try {
    // 1) 本机 Profile 不能覆盖受管 HELM_CWD / HELM_TOKEN / HELM_HUB_URL。
    env.profiles.set('hijack', {
      id: 'hijack',
      runtime: { kind: 'herdr', agent: 'agy', env: { HELM_CWD: '/evil', HELM_TOKEN: 'EVIL', CUSTOM: 'ok', HELM_HUB_URL: 'http://10.0.0.9:3202' } },
    })
    scriptHerdrSuccess(env, 'env-ok')
    await spawnHerdrDirect(env, { agentType: 'hijack', gate: 'check' })
    const hijackTabEnv = env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(hijackTabEnv['HELM_CWD'], env.parentCwd)
    assert.equal(hijackTabEnv['HELM_TOKEN'], 'SECRET-TOKEN')
    assert.equal(hijackTabEnv['HELM_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(hijackTabEnv['CUSTOM'], 'ok')
    assert.deepEqual(env.gateLog[0]?.env, hijackTabEnv)

    // resume 不丢 Profile env。
    const hijackPaneId = [...env.transport.panes.keys()].at(-1)!
    await spawnHerdrDirect(env, { resume: hijackPaneId, gate: 'check again' })
    assert.deepEqual(env.gateLog[1]?.env, hijackTabEnv)

    // 2) 远端 Profile 非法 HELM_HUB_URL 拒绝；合法可达 URL 保留回连。
    env.profiles.set('badurl', {
      id: 'badurl',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELM_HUB_URL: 'ftp://x' } },
    })
    await assert.rejects(spawnHerdrDirect(env, { agentType: 'badurl' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    env.profiles.set('goodurl', {
      id: 'goodurl',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELM_HUB_URL: 'http://10.0.0.5:3202' } },
    } as Profile)
    scriptHerdrSuccess(env, 'far-ok')
    await spawnHerdrDirect(env, { agentType: 'goodurl' })
    const farEnv = env.transport.calls.findLast((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(farEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202')
    assert.equal(farEnv['HELM_TOKEN'], 'SECRET-TOKEN')

    // 3) worktree 第二步 tab env 与 Gate 用 effectiveCwd 重建。
    scriptHerdrSuccess(env, 'wt-env-ok')
    await spawnHerdrDirect(env, { agentType: 'herdr:agy', isolation: 'worktree', gate: 'exit 0' })
    const envTab = env.transport.calls.findLast((c) => c.method === 'tab.create' && c.params['workspace_id'] !== undefined)!
    const wtPane = [...env.transport.panes.values()].at(-1)!
    const wtPath = wtPane.cwd
    assert.ok(wtPath.includes('/.worktrees/wt'))
    const wtEnv = envTab.params['env'] as Record<string, string>
    assert.equal(wtEnv['HELM_CWD'], wtPath)
    assert.equal(envTab.params['cwd'], wtPath)
    assert.equal(env.gateLog.at(-1)!.cwd, wtPath)
    assert.equal(env.gateLog.at(-1)!.env?.['HELM_CWD'], wtPath)
  } finally {
    await env.close()
  }
})
