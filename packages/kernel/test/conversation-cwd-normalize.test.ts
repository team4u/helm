/**
 * 会话 create/update cwd 按目标节点平台统一收口（integration）：
 * - 相对路径（含盘符相对）在服务层拒绝：不落 SDK、不落镜像；
 * - local（process.platform）：词法归一（点段消解）后持久化；
 * - 远端节点：只用 NodeRegistry 注册上报的可信平台——真实 WS 注册
 *   platform 'win32' 节点后，/mnt/<盘符>、/<盘符> 视图确定性转换为规范
 *   Windows 路径；不可映射 POSIX 根（/home）显式拒绝且不落库；
 * - update（PATCH cwd）：同一收口（按本 patch 生效后的目标节点平台）；
 * - resume 语义：不显式改 cwd 时不改写既有 cwd。
 *
 * 真实 createHelm 组合（真 pi-durable SQLite + faux provider + 真实
 * /ws/node 网关）；远端节点用原始 WS + birpc 手动 register（可控 platform
 * 上报，无 daemon 干扰），绝不 mock 注册表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createBirpc } from 'birpc'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type NodeRegisterInput, type NodeRegisterResult } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import type { NodeConnection, HubConnectionLocal } from '../src/env/index.js'

interface Env {
  dataDir: string
  app: Awaited<ReturnType<typeof createHelm>>
  hubUrl: string
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-conv-cwd-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const hub = await startHub({ kernel: app.kernel, port: 0 })
  return {
    dataDir,
    app,
    hubUrl: hub.url,
    async close() {
      await hub.close().catch(() => {})
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 原始 WS 节点注册（可控 platform 上报；一连接一注册，测试结束关闭）。 */
async function registerFakeNode(
  hubUrl: string,
  nodeId: string,
  token: string,
  platform: string,
): Promise<() => void> {
  const ws = new WebSocket(`${hubUrl.replace(/^http/, 'ws')}/ws/node?nodeId=${nodeId}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const rpc = createBirpc<
    { register(input: NodeRegisterInput): Promise<NodeRegisterResult> },
    HubConnectionLocal
  >(
    { onEnvExecOutput: () => undefined, onIpcEvent: () => undefined, onIpcClosed: () => undefined },
    {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
      },
      on: (cb) => {
        ws.on('message', (raw) => {
          try {
            cb(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as never)
          } catch {
            /* 非 JSON 忽略 */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  const outcome = await rpc.register({ nodeId, token, hostname: 'fake', platform })
  assert.ok(outcome.ok, `fake node 注册失败：${JSON.stringify(outcome)}`)
  return () => {
    try {
      rpc.$close()
    } catch {
      /* 已关 */
    }
    ws.close()
  }
}

test('create：相对路径（含盘符相对）拒绝且不产生任何会话', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const before = env.app.kernel.listConversations().length
    for (const bad of ['relative/ws', './x', 'C:relative']) {
      await assert.rejects(
        env.app.kernel.createConversation({ cwd: bad }),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `相对形态 '${bad}' 必须在服务层拒绝`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, '拒绝路径不落库')
  } finally {
    await env.close()
  }
})

test('create：local 平台词法归一（点段消解）后持久化到镜像', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const summary = await env.app.kernel.createConversation({ cwd: '/tmp/helm/a/./b/../c' })
    if (process.platform === 'win32') {
      // Windows 宿主：/tmp 是不可映射 POSIX 根，显式拒绝（本用例只在 POSIX 宿主断言归一）。
      assert.fail('本用例预期 POSIX 宿主（CI linux）')
    }
    assert.equal(summary.cwd, '/tmp/helm/a/c')
    assert.equal(env.app.kernel.getConversation(summary.id).cwd, '/tmp/helm/a/c')
  } finally {
    await env.close()
  }
})

test('create：远端 win32 节点（NodeRegistry 可信平台）——WSL/GitBash 视图确定性转换', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conn: NodeConnection | undefined = env.app.kernel.envFabric.registry.get('win-build')
    assert.equal(conn?.platform, 'win32', '注册表携带可信平台上报')

    const summary = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/work/helm' })
    assert.equal(summary.cwd, 'C:\\work\\helm', 'WSL 挂载视图按注册平台转换为规范 Windows 路径')
    const drive = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/e/git/repo' })
    assert.equal(drive.cwd, 'E:\\git\\repo', 'Git Bash 盘符根视图确定性转换')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create：远端 win32 节点上的坏 POSIX cwd 显式拒绝且不落库', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const before = env.app.kernel.listConversations().length
    for (const bad of ['/home/user', '/tmp/build']) {
      await assert.rejects(
        env.app.kernel.createConversation({ nodeId: 'win-build', cwd: bad }),
        (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
        `'${bad}' 在 win32 目标上无盘符对应，必须显式失败`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, '坏 POSIX cwd 不落库')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create：远端节点未上报平台（未知）——透传不改写（绝不猜平台）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('silent-node')
    closeNode = await registerFakeNode(env.hubUrl, 'silent-node', issued.token, '')
    const summary = await env.app.kernel.createConversation({ nodeId: 'silent-node', cwd: '/home/user/project' })
    assert.equal(summary.cwd, '/home/user/project', '平台未知：POSIX 路径原样保持')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update：patch.cwd 按目标节点平台收口（同一链）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conv = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/first' })
    assert.equal(conv.cwd, 'C:\\first')

    const updated = await env.app.kernel.updateConversation(conv.id, { cwd: '/c/second/third/../x' })
    assert.equal(updated.cwd, 'C:\\second\\x', '显式 cwd 变更按目标平台规范化后持久化')

    await assert.rejects(
      env.app.kernel.updateConversation(conv.id, { cwd: '/home/nope' }),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    await assert.rejects(
      env.app.kernel.updateConversation(conv.id, { cwd: 'relative' }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update：仅改 nodeId 不改写既有 cwd（resume/迁移语义保持）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ cwd: '/tmp/helm/keep-me' })
    const updated = await env.app.kernel.updateConversation(conv.id, { title: '改名' })
    assert.equal(updated.cwd, '/tmp/helm/keep-me', '不显式改 cwd 时既有 cwd 原样保持')
  } finally {
    await env.close()
  }
})
