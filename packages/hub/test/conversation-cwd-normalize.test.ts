/**
 * conversation create/update cwd by target node platform unify consolidate (integration):
 * - relative path (contains symbol each other for) in service layer reject: do not SDK, do not mirror;
 * - local(process.platform): term method archive one (point segment consume solve) after persist;
 * - remote node: only use NodeRegistry register on report can message platform - - real WS register
 *   platform 'win32' node after,/mnt/<symbol>,/<symbol> view determinism convert is specification
 *   Windows path; cannot mapping POSIX (/home) explicit reject and do not written to the database;
 * - update(PATCH cwd): the same consolidate (by this patch takes effect after target node platform);
 * - resume semantics: do not explicit change cwd when do not change write since has cwd.
 *
 * real createHelm combine (true pi-durable SQLite + faux provider + real
 * /ws/node gateway); remote node use original WS + birpc manually register(can control platform
 * on report, without daemon interference), never mock register table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createBirpc } from 'birpc'
import { HelmError, type NodeRegisterInput, type NodeRegisterResult } from '@helm/protocol'
import { startHub } from '../../kernel/src/http/index.js'
import type { NodeConnection, HubConnectionLocal } from '../../kernel/src/env/index.js'
import { openHubTestEnv, type HubTestApp } from './helpers/hub-test-env.js'

interface Env {
  dataDir: string
  app: HubTestApp
  hubUrl: string
  close(): Promise<void>
}

async function makeEnv(options: { hubPlatform?: string } = { hubPlatform: 'linux' }): Promise<Env> {
  const base = await openHubTestEnv({
    prefix: 'helm-conv-cwd-',
    swallowCloseError: true,
    hubPlatform: () => options.hubPlatform,
  })
  const hub = await startHub({ kernel: base.kernel, port: 0 })
  return {
    dataDir: base.dataDir,
    app: base.app,
    hubUrl: hub.url,
    async close() {
      await hub.close().catch(() => {})
      await base.close()
    },
  }
}

/** original WS node register (can control platform on report; one connect one register, test end close). */
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
            /* non- JSON ignore */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  const outcome = await rpc.register({ nodeId, token, hostname: 'fake', platform })
  assert.ok(outcome.ok, `fake node register failed:${JSON.stringify(outcome)}`)
  return () => {
    try {
      rpc.$close()
    } catch {
      /* already closure */
    }
    ws.close()
  }
}

test('create: relative path (contains symbol each other for) reject and produces no conversation', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const before = env.app.kernel.listConversations().length
    for (const bad of ['relative/ws', './x', 'C:relative']) {
      await assert.rejects(
        env.app.kernel.createConversation({ cwd: bad }),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `each other for form '${bad}' must in service layer reject`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, 'reject path do not written to the database')
  } finally {
    await env.close()
  }
})

test('create:local platform term method archive one (point segment consume solve) after persist to mirror', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const summary = await env.app.kernel.createConversation({ cwd: '/tmp/helm/a/./b/../c' })
    assert.equal(summary.cwd, '/tmp/helm/a/c', 'inject POSIX Hub platform after cwd across host archive one')
    assert.equal(env.app.kernel.getConversation(summary.id).cwd, '/tmp/helm/a/c')
  } finally {
    await env.close()
  }
})

test('create: remote win32 node (NodeRegistry can message platform) - -WSL/GitBash view determinism convert', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conn: NodeConnection | undefined = env.app.kernel.envFabric.registry.get('win-build')
    assert.equal(conn?.platform, 'win32', 'register table carry can message platform on report')

    const summary = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/work/helm' })
    assert.equal(summary.cwd, 'C:\\work\\helm', 'WSL mount view by register platform convert is specification Windows path')
    const drive = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/e/git/repo' })
    assert.equal(drive.cwd, 'E:\\git\\repo', 'Git Bash symbol view determinism convert')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create: remote win32 node on broken POSIX cwd explicit reject and do not written to the database', { timeout: 60_000 }, async () => {
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
        `'${bad}' in win32 target on without symbol for should, must explicit failed`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, 'broken POSIX cwd do not written to the database')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create: remote node not on report platform (unknown) - - pass-through do not change write (never guess platform)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('silent-node')
    closeNode = await registerFakeNode(env.hubUrl, 'silent-node', issued.token, '')
    const summary = await env.app.kernel.createConversation({ nodeId: 'silent-node', cwd: '/home/user/project' })
    assert.equal(summary.cwd, '/home/user/project', 'platform unknown:POSIX path original keep')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update:patch.cwd by target node platform consolidate (the same chain)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conv = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/first' })
    assert.equal(conv.cwd, 'C:\\first')

    const updated = await env.app.kernel.updateConversation(conv.id, { cwd: '/c/second/third/../x' })
    assert.equal(updated.cwd, 'C:\\second\\x', 'explicit cwd change by target platform specification after persist')

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

test('update: only change nodeId when by new target platform consolidate since has cwd', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conv = await env.app.kernel.createConversation({ cwd: '/mnt/c/keep-me' })
    assert.equal(conv.cwd, '/mnt/c/keep-me')

    const updated = await env.app.kernel.updateConversation(conv.id, { nodeId: 'win-build' })
    assert.equal(updated.nodeId, 'win-build')
    assert.equal(updated.cwd, 'C:\\keep-me', 'nodeId migration must not under target Windows unavailable POSIX cwd')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update: only change title when keep since has cwd', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ cwd: '/tmp/helm/keep-me' })
    const updated = await env.app.kernel.updateConversation(conv.id, { title: 'change name' })
    assert.equal(updated.cwd, '/tmp/helm/keep-me', 'do not explicit change cwd when since has cwd original keep')
  } finally {
    await env.close()
  }
})
