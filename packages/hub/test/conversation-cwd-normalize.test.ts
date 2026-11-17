/**
 * Integration tests for conversation create/update `cwd` normalization by target node platform:
 * - Relative paths (including drive-relative paths) reject at the service layer without touching SDK/mirror;
 * - Local (`process.platform`): lexically normalized (dot segments resolved) before persistence;
 * - Remote nodes: uses only the platform reported in `NodeRegistry` — after registering a real WS
 *   node with platform `'win32'`, `/mnt/<drive>` and `/<drive>` views deterministically convert to canonical
 *   Windows paths, while unmappable POSIX paths (`/home`) reject explicitly without DB writes;
 * - `update` (`PATCH cwd`): shares the same normalization path using the post-patch target node platform;
 * - Rename-only updates preserve the existing `cwd` when `cwd` is not modified.
 *
 * Wired against real `createHelm` (real `pi-durable` SQLite + faux provider + real `/ws/node` gateway);
 * remote nodes register directly over raw WS + birpc to control reported platform without daemon noise.
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

/** Raw WS node registration helper (allows controlling reported platform; closes on teardown). */
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
            /* ignore non-JSON */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  const outcome = await rpc.register({ nodeId, token, hostname: 'fake', platform })
  assert.ok(outcome.ok, `fake node registration failed: ${JSON.stringify(outcome)}`)
  return () => {
    try {
      rpc.$close()
    } catch {
      /* already closed */
    }
    ws.close()
  }
}

test('create: relative paths (including drive-relative) reject and produce no conversation', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const before = env.app.kernel.listConversations().length
    for (const bad of ['relative/ws', './x', 'C:relative']) {
      await assert.rejects(
        env.app.kernel.createConversation({ cwd: bad }),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `relative path '${bad}' must reject at the service layer`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, 'rejected paths must not be persisted')
  } finally {
    await env.close()
  }
})

test('create: local platform lexically normalizes dot segments before persisting to mirror', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const summary = await env.app.kernel.createConversation({ cwd: '/tmp/helm/a/./b/../c' })
    assert.equal(summary.cwd, '/tmp/helm/a/c', 'cross-host canonicalization under injected POSIX Hub platform')
    assert.equal(env.app.kernel.getConversation(summary.id).cwd, '/tmp/helm/a/c')
  } finally {
    await env.close()
  }
})

test('create: remote win32 node (trusted NodeRegistry platform) deterministically converts WSL/Git Bash views', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conn: NodeConnection | undefined = env.app.kernel.envFabric.registry.get('win-build')
    assert.equal(conn?.platform, 'win32', 'registry records trusted reported platform')

    const summary = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/work/helm' })
    assert.equal(summary.cwd, 'C:\\work\\helm', 'WSL mount view converts to canonical Windows path via registered platform')
    const drive = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/e/git/repo' })
    assert.equal(drive.cwd, 'E:\\git\\repo', 'Git Bash drive view converts deterministically')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create: remote win32 node rejects unmappable POSIX cwd without persisting', { timeout: 60_000 }, async () => {
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
        `'${bad}' has no drive letter on win32 target and must fail explicitly`,
      )
    }
    assert.equal(env.app.kernel.listConversations().length, before, 'unmappable POSIX cwd must not be persisted')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('create: remote node without reported platform passes through unchanged without guessing', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('silent-node')
    closeNode = await registerFakeNode(env.hubUrl, 'silent-node', issued.token, '')
    const summary = await env.app.kernel.createConversation({ nodeId: 'silent-node', cwd: '/home/user/project' })
    assert.equal(summary.cwd, '/home/user/project', 'unknown platform keeps POSIX path unchanged')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update: patch.cwd normalizes against target node platform on the same code path', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conv = await env.app.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/first' })
    assert.equal(conv.cwd, 'C:\\first')

    const updated = await env.app.kernel.updateConversation(conv.id, { cwd: '/c/second/third/../x' })
    assert.equal(updated.cwd, 'C:\\second\\x', 'explicit cwd update persists canonicalized path for target platform')

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

test('update: changing nodeId alone normalizes existing cwd against the new target platform', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closeNode: (() => void) | undefined
  try {
    const issued = await env.app.kernel.nodes.issueNodeToken('win-build')
    closeNode = await registerFakeNode(env.hubUrl, 'win-build', issued.token, 'win32')
    const conv = await env.app.kernel.createConversation({ cwd: '/mnt/c/keep-me' })
    assert.equal(conv.cwd, '/mnt/c/keep-me')

    const updated = await env.app.kernel.updateConversation(conv.id, { nodeId: 'win-build' })
    assert.equal(updated.nodeId, 'win-build')
    assert.equal(updated.cwd, 'C:\\keep-me', 'nodeId migration must not leave an un-normalized POSIX cwd on Windows target')
  } finally {
    closeNode?.()
    await env.close()
  }
})

test('update: changing title alone preserves existing cwd', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ cwd: '/tmp/helm/keep-me' })
    const updated = await env.app.kernel.updateConversation(conv.id, { title: 'change name' })
    assert.equal(updated.cwd, '/tmp/helm/keep-me', 'existing cwd is preserved when cwd is not explicitly changed')
  } finally {
    await env.close()
  }
})
