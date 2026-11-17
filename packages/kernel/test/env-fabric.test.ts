/**
 * Cross-platform node fabric (EnvFabric) end-to-end tests: real Hub WS gateway + real
 * @helm/node daemon (one isolated env RPC server per connection; destroyed on reconnect/replacement).
 *
 * Covers:
 * 1. NodeRegistry + attachNodeWsGateway + RemoteExecutionEnv + ScopedExecutionEnv:
 *    auth approval/rejection (4003), fail-closed without auth callback, registration timeout (4001),
 *    remote file I/O (including real envFlushFile forwarding), streaming command output,
 *    cancellation killing remote process trees, mid-command disconnect returning unknown (no retry, no local fallback),
 *    multi-conversation ScopedExecutionEnv isolation on same node (per-call env cannot spoof bound vars),
 *    revocation hard barrier (delayed auth disconnect prevents old connection from ever registering),
 *    cross-generation readers (old readerId never reads from replacement connection).
 * 2. GET /api/nodes, POST /api/nodes/issue (one-time token return),
 *    DELETE /api/nodes/:id (cuts connection + local node protection), POST /api/env/exec
 *    (local JSON & stream:true NDJSON frames + offline 409 node_offline + conversation target inheritance).
 * 3. Conversation bound to remote nodeId invokes bash/read/write/edit remotely during real model turns.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { createBirpc } from 'birpc'
import {
  attachNodeWsGateway,
  attachNodeTunnelGateway,
  createEnvFabric,
  RemoteExecutionEnv,
} from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createNodeDaemon,
  type NodeDaemon,
  type NodeIdentity,
} from '@helm/node'
import { cleanupDir, makeFauxModels, makeTempDir, sleep as delay } from './helpers.js'

const bg = BACKGROUND_CONTEXT

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Pure EnvFabric test harness (HTTP server + gateways without KernelRuntime). */
async function startFabricHub(
  authenticate?: (nodeId: string, token: string) => boolean | Promise<boolean>,
  registerTimeoutMs?: number,
) {
  const fabric = createEnvFabric({
    ...(authenticate !== undefined ? { authenticate } : {}),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    envOptions: ({ conversationId }): Record<string, string> =>
      conversationId === undefined ? {} : { HELM_CONVERSATION_ID: String(conversationId) },
  })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry, ...(registerTimeoutMs !== undefined ? { registerTimeoutMs } : {}) })
  const tunnelGateway = attachNodeTunnelGateway(server, { registry: fabric.registry })
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fabric,
    close: async () => {
      await tunnelGateway.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
    },
  }
}

/** Real node daemon (fast reconnect; silent logs). */
async function startNode(opts: {
  url: string
  nodeId: string
  token: string
  dataDir: string
  reconnectBaseMs?: number
}): Promise<NodeDaemon> {
  const identity: NodeIdentity = { nodeId: opts.nodeId, token: opts.token }
  return createNodeDaemon({
    hubUrl: opts.url,
    identity,
    dataDir: opts.dataDir,
    reconnectBaseDelayMs: opts.reconnectBaseMs ?? 100,
    reconnectMaxDelayMs: opts.reconnectBaseMs ?? 800,
    log: () => undefined,
  })
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helm-envfabric-')
})

after(async () => {
  await cleanupDir(rootDir)
})

// ---------------------------------------------------------------------------
// 1. EnvFabric core behavior
// ---------------------------------------------------------------------------

describe('EnvFabric node connectivity and remote execution', { timeout: 60_000 }, () => {
  it('auth approval and rejection: valid token registers; invalid token rejected; fail-closed without auth callback', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'auth-'))
    const TOKEN = 'node-a:secret-a1'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-a' && token === TOKEN)
    try {
      const good = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: TOKEN, dataDir: dir })
      assert.ok(await good.waitUntilRegistered(), 'valid token should register')
      assert.equal(hub.fabric.isOnline('node-a'), true)
      await good.close()

      const bad = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: 'node-a:WRONG', dataDir: dir })
      assert.equal(await bad.waitUntilRegistered(2_000), false, 'wrong token must not register')
      assert.equal(hub.fabric.registry.get('node-a'), undefined)
      await bad.close()
    } finally {
      await hub.close()
    }

    // Fail-closed: no authenticate callback provided.
    const dir2 = await mkdtemp(join(rootDir, 'noauth-'))
    const hub2 = await startFabricHub()
    try {
      const daemon = await startNode({ url: hub2.baseUrl, nodeId: 'x', token: 'x:t', dataDir: dir2 })
      assert.equal(await daemon.waitUntilRegistered(2_000), false, 'missing authenticate callback rejects all registrations')
      assert.equal(hub2.fabric.registry.get('x'), undefined)
      await daemon.close()
    } finally {
      await hub2.close()
    }
  })

  it('unregistered connection times out with 4001 and closes via gateway', { timeout: 60_000 }, async () => {
    const hub = await startFabricHub(() => true, 300)
    try {
      const ws = new WebSocket(`${hub.baseUrl.replace(/^http/, 'ws')}/ws/node`)
      const codes: number[] = []
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      ws.on('close', (code) => codes.push(code))
      await delay(900)
      assert.ok(codes.includes(4001), `unregistered socket should close with 4001 (got ${codes.join(',')})`)
    } finally {
      await hub.close()
    }
  })

  it('node tunnel: real HTTP/SSE and POST request body byte-for-byte via remote loopback', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'tunnel-node-'))
    const targetBodies: string[] = []
    const target = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        targetBodies.push(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write('data: 你好\\n\\n')
        setTimeout(() => {
          res.end('data: 世界\\n\\n')
        }, 10)
      })
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port
    const hub = await startFabricHub((nodeId, token) => nodeId === 'tunnel-node' && token === 'tunnel-node:secret')
    const daemon = await startNode({ url: hub.baseUrl, nodeId: 'tunnel-node', token: 'tunnel-node:secret', dataDir: nodeData })
    try {
      assert.equal(await daemon.waitUntilRegistered(10_000), true)
      const response = await hub.fabric.nodeFetch('tunnel-node')(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'request body:你好,世界' }),
      })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'data: 你好\\n\\ndata: 世界\\n\\n')
      assert.deepEqual(targetBodies, ['{"message":"request body:你好,世界"}'])
    } finally {
      await daemon.close()
      await hub.close()
      await new Promise<void>((resolve) => target.close(() => resolve()))
      await cleanupDir(nodeData)
    }
  })

  it('remote file I/O + real envFlushFile forwarding + streaming exec + abort propagation', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'rw-node-'))
    const workDir = await mkdtemp(join(rootDir, 'rw-work-'))
    const TOKEN = 'node-rw:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-rw' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-rw', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-rw', workDir)
      assert.ok(env instanceof RemoteExecutionEnv)

      // Write + flush (real RPC forwarding) + read back.
      const w = await env.writeFile('hello.txt', '你好 helm', bg)
      assert.ok(w.ok, JSON.stringify(w))
      const f = await env.flushFile('hello.txt', bg)
      assert.ok(f.ok, `envFlushFile should forward and succeed: ${JSON.stringify(f)}`)
      const r = await env.readTextFile('hello.txt', bg)
      assert.ok(r.ok && r.value === '你好 helm')

      // Streaming exec: onOutput emits in arrival order.
      const chunks: string[] = []
      const exec = await env.exec("printf 'a\\nb\\nc'", { onOutput: (t) => chunks.push(t) }, bg)
      assert.ok(exec.ok && exec.value.exitCode === 0)
      assert.equal(chunks.join(''), 'a\nb\nc')

      // Abort propagation: abort -> envAbortExec -> node kills remote process tree.
      const sentinel = join(workDir, 'cancel-sentinel.txt')
      const controller = new AbortController()
      const running = env.exec(`sleep 30 && touch ${sentinel}`, undefined, withAbortSignal(controller.signal, bg))
      await delay(400)
      controller.abort()
      const aborted = await running
      assert.ok(!aborted.ok && aborted.error.code === 'aborted')
      await delay(600)
      assert.ok(!existsSync(sentinel), 'aborted remote process tree must not leave sentinel file')
      // Abort must not break subsequent commands (single-command process tree semantics).
      const after = await env.exec('echo alive', undefined, bg)
      assert.ok(after.ok && after.value.exitCode === 0)
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('disconnect unknown: in-flight disconnect during exec explicitly reports unknown, never retries or falls back locally', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'disc-node-'))
    const workDir = await mkdtemp(join(rootDir, 'disc-work-'))
    const TOKEN = 'node-disc:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-disc' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-disc', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-disc', workDir)
      const localMarker = join(rootDir, 'disc-local-marker.txt')
      const longRun = env.exec('sleep 5; echo done', undefined, bg)
      await delay(400)
      await daemon.close()
      const result = await longRun
      assert.ok(!result.ok, 'command interrupted by disconnect must not succeed')
      assert.equal(result.error.code, 'unknown', `expected unknown, got ${JSON.stringify(result)}`)
      assert.match(result.error.message, /not auto-retried/)
      assert.ok(!existsSync(localMarker), 'must never fall back to local execution')
    } finally {
      await hub.close()
    }
  })

  it('ScopedExecutionEnv: per-conversation env isolation on same node; per-call env cannot override bound vars', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'scope-node-'))
    const workDir = await mkdtemp(join(rootDir, 'scope-work-'))
    const TOKEN = 'node-scope:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-scope' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-scope', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const s1 = hub.fabric.envForTarget({ conversationId: 101, nodeId: 'node-scope', cwd: workDir })
      const s2 = hub.fabric.envForTarget({ conversationId: 202, nodeId: 'node-scope', cwd: workDir })
      // Env stays isolated per conversation even when sharing a node/cwd.
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await s2.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '202')
      // Bound key cannot be spoofed by per-call env overrides.
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', { env: { HELM_CONVERSATION_ID: '999' } }, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('revocation hard rule: delayed auth resolving true after disconnect never publishes stale connection', { timeout: 60_000 }, async () => {
    const TOKEN = 'node-rev:secret'
    let authDelayMs = 150
    const hub = await startFabricHub(async (nodeId, token) => {
      if (nodeId === 'node-rev' && token === TOKEN) {
        await delay(authDelayMs)
        return true
      }
      return false
    })
    try {
      // Raw WS client registering manually for deterministic timing without daemon auto-reconnect noise.
      const ws = new WebSocket(`${hub.baseUrl.replace(/^http/, 'ws')}/ws/node?nodeId=node-rev`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      const hubRpc = createBirpc<{
        register(input: NodeRegisterInput): Promise<NodeRegisterResult>
        heartbeat(nodeId: string): Promise<boolean>
      }, HubConnectionLocal>(
        {
          onEnvExecOutput: () => undefined,
          onIpcEvent: () => undefined,
          onIpcClosed: () => undefined,
        },
        {
          post: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
          },
          on: (cb) => {
            ws.on('message', (raw) => {
              const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
              try {
                cb(JSON.parse(text) as never)
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
      const registerPromise = hubRpc.register({
        nodeId: 'node-rev',
        token: TOKEN,
        hostname: 'revoke-probe',
        platform: process.platform,
      })
      // While auth is in flight (authDelayMs=150), immediately revoke/disconnect (simulating removeNode/replacement).
      await delay(50)
      hub.fabric.registry.disconnect('node-rev')
      // Delayed auth resolves true afterwards: registration must be rejected (superseded), never marking node online.
      const outcome = await registerPromise
      assert.equal(outcome.ok, false, `delayed auth resolving true must not publish: ${JSON.stringify(outcome)}`)
      assert.match(outcome.reason ?? '', /superseded/)
      await delay(100)
      assert.equal(hub.fabric.registry.get('node-rev'), undefined, 'registry remains offline')
      assert.equal(hub.fabric.isOnline('node-rev'), false)
      // Fresh registration after revocation completes succeeds cleanly (epoch bumped without stuck in-flight auth).
      authDelayMs = 0
      const daemon2 = await startNode({
        url: hub.baseUrl,
        nodeId: 'node-rev',
        token: TOKEN,
        dataDir: await mkdtemp(join(rootDir, 'revoke-d2-')),
      })
      assert.ok(await daemon2.waitUntilRegistered(), 'new registration after revocation succeeds normally')
      await daemon2.close()
      try {
        hubRpc.$close()
      } catch {
        /* already closed */
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    } finally {
      await hub.close()
    }
  })

  it('cross-generation reader guard: old readerId after reconnect never reads from replacement connection', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'reader-node-'))
    const workDir = await mkdtemp(join(rootDir, 'reader-work-'))
    await writeFile(join(workDir, 'a.txt'), 'A1\nA2\n')
    await writeFile(join(workDir, 'b.txt'), 'B1\nB2\n')
    const TOKEN = 'node-reader:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-reader' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-reader', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-reader', workDir)

      // Generation 1: open a.txt (readerId r1).
      const opened = await env.openTextLineReader('a.txt', bg)
      assert.ok(opened.ok)
      const line1 = await opened.value.readLine(bg)
      assert.ok(line1.ok && line1.value?.text === 'A1')

      // Disconnect (generation 1 shuts down, destroying handle r1) -> generation 2 reconnects and opens b.txt
      // (new generation counter also assigns readerId r1 to b.txt).
      await daemon.close()
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-reader', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const env2 = hub.fabric.envFor('node-reader', workDir)
      const openedB = await env2.openTextLineReader('b.txt', bg)
      assert.ok(openedB.ok)

      // Reading from old reader must fail explicitly and never leak B1 across generations.
      const stale = await opened.value.readLine(bg)
      if (stale.ok) {
        assert.notEqual(stale.value?.text, 'B1', 'old generation reader must never read new generation file content')
      } else {
        assert.ok(
          ['unknown', 'invalid', 'not_found', 'aborted'].includes(stale.error.code),
          `expected explicit error, got ${JSON.stringify(stale)}`,
        )
      }
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })

  it('output sink bound to generation: late output from old connection never pollutes replacement connection', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'sink-node-'))
    const workDir = await mkdtemp(join(rootDir, 'sink-work-'))
    const TOKEN = 'node-sink:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-sink' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const received: Array<{ execId: string; text: string }> = []
      hub.fabric.registry.addOutputSink('node-sink', (event) => received.push({ execId: event.execId, text: event.text }))
      const env = hub.fabric.envFor('node-sink', workDir)
      const r1 = await env.exec('echo old-gen', undefined, bg)
      assert.ok(r1.ok)
      await delay(200)
      assert.ok(received.some((e) => e.text.includes('old-gen')), 'output routes normally while online')
      await daemon.close()
      await delay(300)
      const countAfterDisconnect = received.length
      // Replacement connection continues routing to registered sink.
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const r2 = await env.exec('echo new-gen', undefined, bg)
      assert.ok(r2.ok)
      await delay(300)
      assert.ok(received.some((e) => e.text.includes('new-gen')), 'new generation output continues routing to sink')
      void countAfterDisconnect
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. HTTP routes: /api/nodes and /api/env/exec
// ---------------------------------------------------------------------------

describe('node management and env/exec HTTP routes', { timeout: 60_000 }, () => {
  interface TestApp {
    kernel: KernelRuntime
    hub: Awaited<ReturnType<typeof startHub>>
    token: string
    close(): Promise<void>
  }

  async function openApp(dir: string): Promise<TestApp> {
    const { models } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
    })
    const hub = await startHub({
      kernel: kernel as never,
      port: 0,
    })
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'envfabric-test-pass' }),
    })
    const { token } = (await setup.json()) as { token: string }
    return {
      kernel,
      hub,
      token,
      async close() {
        await hub.close()
        await kernel.close()
      },
    }
  }

  async function call(app: TestApp, method: string, path: string, body?: unknown) {
    const res = await fetch(`${app.hub.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: any
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json, text }
  }

  it('GET /api/nodes + issue (one-time token) + remove (disconnects and protects local)', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'http-nodes-'))
    const app = await openApp(dir)
    try {
      const initial = await call(app, 'GET', '/api/nodes')
      assert.equal(initial.status, 200)
      assert.ok(Array.isArray(initial.json))
      assert.equal(initial.json[0].id, 'local')
      assert.equal(initial.json[0].kind, 'local')
      assert.equal(initial.json[0].online, true)

      const issue = await call(app, 'POST', '/api/nodes/issue', { nodeId: 'http-node' })
      assert.equal(issue.status, 201)
      assert.equal(issue.json.nodeId, 'http-node')
      assert.ok(typeof issue.json.token === 'string' && issue.json.token.startsWith('http-node:'))

      const list1 = await call(app, 'GET', '/api/nodes')
      assert.equal(list1.json.length, 2)
      assert.equal(list1.json[1].id, 'http-node')
      assert.equal(list1.json[1].online, false, 'offline before connecting')

      const daemon = await startNode({ url: app.hub.url, nodeId: 'http-node', token: issue.json.token, dataDir: dir })
      assert.ok(await daemon.waitUntilRegistered())
      const list2 = await call(app, 'GET', '/api/nodes')
      assert.equal(list2.json[1].online, true)
      assert.ok(typeof list2.json[1].hostname === 'string' && list2.json[1].hostname.length > 0, 'daemon reports hostname upon registration')

      // node.changed event sequence (SSE incremental frames): connect -> remove emits exactly one removed:true frame;
      // shaped as NodeChangedEvent ('node' in event), not Custom payload wrapper.
      const nodeEvents: Array<{ node: { id: string }; removed?: boolean; payload?: unknown }> = []
      const releaseEvents = app.kernel.events.subscribe((frame) => {
        const event = frame.event as { type: string; node?: unknown; removed?: unknown; payload?: unknown }
        if (event.type === 'node.changed') {
          assert.ok('node' in event, `node.changed must follow NodeChangedEvent shape, got ${JSON.stringify(event)}`)
          nodeEvents.push(event as { node: { id: string }; removed?: boolean })
        }
      })

      const removed = await call(app, 'DELETE', `/api/nodes/${encodeURIComponent('http-node')}`)
      assert.equal(removed.status, 200)
      assert.deepEqual(removed.json, { ok: true })
      await delay(300)
      releaseEvents()
      const removals = nodeEvents.filter((e) => e.removed === true && e.node.id === 'http-node')
      assert.equal(
        removals.length,
        1,
        `removing online node should emit exactly one removed:true event (with onNodeChanged dedupe), got ${JSON.stringify(nodeEvents)}`,
      )
      assert.equal(
        nodeEvents.filter((e) => e.node.id === 'http-node' && e.removed !== true).length,
        0,
        `no non-removed offline event should follow remove (deduped), got ${JSON.stringify(nodeEvents)}`,
      )
      for (const e of nodeEvents) {
        assert.equal(e.payload, undefined, 'NodeChangedEvent does not carry payload field')
      }
      const list3 = await call(app, 'GET', '/api/nodes')
      assert.equal(list3.json.length, 1, 'only local node remains after deletion')

      const localRemove = await call(app, 'DELETE', '/api/nodes/local')
      assert.equal(localRemove.status, 400)
      assert.equal(localRemove.json.error.code, 'cannot_remove_local_node')
      await daemon.close()
      await app.close()
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /api/env/exec: local JSON, remote streaming NDJSON frames, offline 409, conversation target inheritance', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'http-exec-'))
    const app = await openApp(dir)
    try {
      // Local JSON execution.
      const local = await call(app, 'POST', '/api/env/exec', { command: 'echo hello-env-exec' })
      assert.equal(local.status, 200)
      assert.equal(local.json.ok, true)
      assert.equal(local.json.exitCode, 0)
      assert.ok(local.json.output.includes('hello-env-exec'))

      // Offline node -> 409 node_offline.
      await call(app, 'POST', '/api/nodes/issue', { nodeId: 'offline-node' })
      const offline = await call(app, 'POST', '/api/env/exec', {
        command: 'echo x',
        nodeId: 'offline-node',
        cwd: '/tmp',
      })
      assert.equal(offline.status, 409)
      assert.equal(offline.json.error.code, 'node_offline')

      // Remote NDJSON streaming: output frames + single terminal exit frame.
      const nodeData = await mkdtemp(join(rootDir, 'http-exec-node-'))
      const workDir = await mkdtemp(join(rootDir, 'http-exec-work-'))
      const issue = await call(app, 'POST', '/api/nodes/issue', { nodeId: 'stream-node' })
      const daemon = await startNode({ url: app.hub.url, nodeId: 'stream-node', token: issue.json.token, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const res = await fetch(`${app.hub.url}/api/env/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
        body: JSON.stringify({
          command: "printf 'line1\\nline2\\n'",
          nodeId: 'stream-node',
          cwd: workDir,
          stream: true,
        }),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
      const text = await res.text()
      const frames = text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      assert.ok(frames.every((f) => ['output', 'exit', 'error'].includes(f.type)), 'frames only use output/exit/error protocol')
      const exits = frames.filter((f) => f.type === 'exit')
      assert.equal(exits.length, 1, 'exactly one exit frame')
      assert.equal(exits[0].ok, true)
      assert.equal(exits[0].exitCode, 0)
      const joined = frames.filter((f) => f.type === 'output').map((f) => f.text).join('')
      assert.ok(joined.includes('line1') && joined.includes('line2'), `stream output should include all chunks: ${joined}`)

      // Conversation target inheritance: creating a conversation bound to stream-node inherits remote target on exec.
      const conv = await call(app, 'POST', '/api/conversations', {
        nodeId: 'stream-node',
        cwd: workDir,
        title: 'remote conversation',
      })
      assert.equal(conv.json.nodeId, 'stream-node')
      await writeFile(join(workDir, 'target-only.txt'), 'TARGET\n')
      const inherited = await call(app, 'POST', '/api/env/exec', {
        command: 'cat target-only.txt',
        conversationId: conv.json.id,
      })
      assert.equal(inherited.status, 200, JSON.stringify(inherited))
      assert.equal(inherited.json.ok, true)
      assert.ok(inherited.json.output.includes('TARGET'), 'conversation target inheritance reads remote file on remote node')
      await daemon.close()
    } finally {
      await app.close()
    }
  })

  it('conversation bound to remote nodeId executes bash/write/edit/read on remote node during live model turn', { timeout: 60_000 }, async () => {
    const hubDir = await mkdtemp(join(rootDir, 'conv-hub-'))
    const nodeData = await mkdtemp(join(rootDir, 'conv-node-'))
    const workDir = await mkdtemp(join(rootDir, 'conv-work-'))
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: hubDir,
      cwd: hubDir,
      model: 'faux/faux-1',
      models: models as never,
    })
    const hub = await startHub({
      kernel: kernel as never,
      port: 0,
    })
    try {
      const setup = await fetch(`${hub.url}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'conv-remote-pass' }),
      })
      const { token } = (await setup.json()) as { token: string }
      const issueRes = await fetch(`${hub.url}/api/nodes/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ nodeId: 'work-node' }),
      })
      const issue = (await issueRes.json()) as { token: string }
      const daemon = await startNode({ url: hub.url, nodeId: 'work-node', token: issue.token, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())

      const convRes = await fetch(`${hub.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ nodeId: 'work-node', cwd: workDir, title: 'remote conversation' }),
      })
      const conv = (await convRes.json()) as { id: number; nodeId: string }
      assert.equal(conv.nodeId, 'work-node')

      // File existing only on remote workDir: if executed locally on Hub, cat fails cleanly.
      await writeFile(join(workDir, 'remote-only.txt'), 'REMOTE-ONLY\n')

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'cat remote-only.txt && echo NODE=$HELM_NODE_ID && pwd' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('write', { path: 'written.txt', content: 'written-by-write-tool' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(
          [fauxToolCall('edit', { path: 'written.txt', oldText: 'write-tool', newText: 'edit-tool-ok' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('read', { path: 'written.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('all done'),
      ])
      await kernel.submitInput(conv.id, 'run remote tools suite')
      await kernel.waitForIdle(conv.id)

      // Disk state assertion: both write and edit ran against the remote target.
      const written = await readFile(join(workDir, 'written.txt'), 'utf8')
      assert.equal(written, 'written-by-edit-tool-ok', 'write + edit took effect on remote node')
      assert.equal(await kernel.getLastAssistantText(conv.id), 'all done')
      await daemon.close()
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})
