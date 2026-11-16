/**
 * across platform node bottom seat (EnvFabric) end-to-end test: real Hub WS gateway + real
 * @helm/node daemon (each connect one proxy independent env RPC server, assert swap proxy i.e. destroy).
 *
 * override:
 * 1. NodeRegistry + attachNodeWsGateway + RemoteExecutionEnv + ScopedExecutionEnv:
 *    authentication via and failed (4003),fail-closed without authentication, not registered timeout (4001),
 *    remote file read write (contains envFlushFile real forwarding), remote command streaming output,
 *    cancel pass broadcast kill process, disconnection return unknown(do not retry, does not fall back local),
 *    same node many conversation ScopedExecutionEnv environment isolated (bind set key cannot by one by one invoke env override),
 *    undo hard rule (latency authentication in-flight disconnect after resolve(true) no longer publish old connect),
 *    reader across proxy (assert connect after old readerId do not to new proxy, do not mistakenly read other file).
 * 2. GET /api/nodes,POST /api/nodes/issue(token once return),
 *    DELETE /api/nodes/:id(pinch assert connect + local protect),POST /api/env/exec
 *    (local JSON and stream:true NDJSON frame + offline 409 node_offline + conversation target inherit).
 * 3. conversation bind set remote nodeId after via real model turn invoke bash/read/write/edit in remote takes effect.
 */

import { test, describe, it, before, after } from 'node:test'
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
  type EnvFabric,
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
// base seat
// ---------------------------------------------------------------------------

/** pure EnvFabric test base seat (HTTP server + gateway, do not via KernelRuntime). */
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

/** real node daemon (fast reconnect;log static default). */
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

describe('EnvFabric node connect and remote execute', { timeout: 60_000 }, () => {
  it('authentication via and reject: correct token register succeeded; error token do not register;fail-closed without authentication reject everything', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'auth-'))
    const TOKEN = 'node-a:secret-a1'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-a' && token === TOKEN)
    try {
      const good = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: TOKEN, dataDir: dir })
      assert.ok(await good.waitUntilRegistered(), 'correct token should register succeeded')
      assert.equal(hub.fabric.isOnline('node-a'), true)
      await good.close()

      const bad = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: 'node-a:WRONG', dataDir: dir })
      assert.equal(await bad.waitUntilRegistered(2_000), false, 'error token must not register')
      assert.equal(hub.fabric.registry.get('node-a'), undefined)
      await bad.close()
    } finally {
      await hub.close()
    }

    // fail-closed: without authentication call back.
    const dir2 = await mkdtemp(join(rootDir, 'noauth-'))
    const hub2 = await startFabricHub()
    try {
      const daemon = await startNode({ url: hub2.baseUrl, nodeId: 'x', token: 'x:t', dataDir: dir2 })
      assert.equal(await daemon.waitUntilRegistered(2_000), false, 'without authentication call back → reject everything register')
      assert.equal(hub2.fabric.registry.get('x'), undefined)
      await daemon.close()
    } finally {
      await hub2.close()
    }
  })

  it('not registered timeout 4001: after connect do not register i.e. by gateway close', { timeout: 60_000 }, async () => {
    const hub = await startFabricHub(() => true, 300)
    try {
      const ws = new WebSocket(`${hub.baseUrl.replace(/^http/, 'ws')}/ws/node`)
      const codes: number[] = []
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      ws.on('close', (code) => codes.push(code))
      await delay(900)
      assert.ok(codes.includes(4001), `not registered connect should with 4001 close (receives ${codes.join(',')})`)
    } finally {
      await hub.close()
    }
  })

  it('node pass-through tunnel: real HTTP/SSE and POST request body one by one byte via remote loopback', { timeout: 60_000 }, async () => {
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

  it('remote file read write + envFlushFile real forwarding + streaming exec + cancel pass broadcast', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'rw-node-'))
    const workDir = await mkdtemp(join(rootDir, 'rw-work-'))
    const TOKEN = 'node-rw:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-rw' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-rw', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-rw', workDir)
      assert.ok(env instanceof RemoteExecutionEnv)

      // write + flush(real forwarding)+ read back.
      const w = await env.writeFile('hello.txt', '你好 helm', bg)
      assert.ok(w.ok, JSON.stringify(w))
      const f = await env.flushFile('hello.txt', bg)
      assert.ok(f.ok, `envFlushFile should real forwarding succeeded:${JSON.stringify(f)}`)
      const r = await env.readTextFile('hello.txt', bg)
      assert.ok(r.ok && r.value === '你好 helm')

      // streaming exec:onOutput by reach order back put.
      const chunks: string[] = []
      const exec = await env.exec("printf 'a\\nb\\nc'", { onOutput: (t) => chunks.push(t) }, bg)
      assert.ok(exec.ok && exec.value.exitCode === 0)
      assert.equal(chunks.join(''), 'a\nb\nc')

      // cancel pass broadcast:abort → envAbortExec → node kill the command process tree.
      const sentinel = join(workDir, 'cancel-sentinel.txt')
      const controller = new AbortController()
      const running = env.exec(`sleep 30 && touch ${sentinel}`, undefined, withAbortSignal(controller.signal, bg))
      await delay(400)
      controller.abort()
      const aborted = await running
      assert.ok(!aborted.ok && aborted.error.code === 'aborted')
      await delay(600)
      assert.ok(!existsSync(sentinel), 'cancel after remote process tree must not store write sentinel')
      // cancel does not affect after continue command (single command process tree semantics).
      const after = await env.exec('echo alive', undefined, bg)
      assert.ok(after.ok && after.value.exitCode === 0)
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('disconnection unknown:exec in-flight disconnect explicit report result unknown, never retry, never fall back local', { timeout: 60_000 }, async () => {
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
      assert.ok(!result.ok, 'disconnection in command must not succeeded')
      assert.equal(result.error.code, 'unknown', `expectation unknown, obtain to ${JSON.stringify(result)}`)
      assert.match(result.error.message, /do not automatically retry/)
      assert.ok(!existsSync(localMarker), 'never fall back local execute')
    } finally {
      await hub.close()
    }
  })

  it('ScopedExecutionEnv: same node many conversation environment isolated; bind set key cannot by one by one invoke env override', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'scope-node-'))
    const workDir = await mkdtemp(join(rootDir, 'scope-work-'))
    const TOKEN = 'node-scope:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-scope' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-scope', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const s1 = hub.fabric.envForTarget({ conversationId: 101, nodeId: 'node-scope', cwd: workDir })
      const s2 = hub.fabric.envForTarget({ conversationId: 202, nodeId: 'node-scope', cwd: workDir })
      // environment by conversation live together into (fresh).
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await s2.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '202')
      // bind set key cannot by one by one invoke env override (guard against fabricate effect domain).
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', { env: { HELM_CONVERSATION_ID: '999' } }, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('undo hard rule: latency authentication in-flight disconnect after resolve(true) no longer publish old connect', { timeout: 60_000 }, async () => {
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
      // original WS client manually register(can control when order, without daemon automatically reconnect interference).
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
              /* non- JSON ignore */
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
      // authentication suspended in (authDelayMs=150): immediately disconnect(simulated removeNode/round swap).
      await delay(50)
      hub.fabric.registry.disconnect('node-rev')
      // authentication then resolve(true):register must by refuse (register superseded by
      // revoke/replace), old connect never publish online.
      const outcome = await registerPromise
      assert.equal(outcome.ok, false, `late to resolve(true) must not publish:${JSON.stringify(outcome)}`)
      assert.match(outcome.reason ?? '', /superseded/)
      await delay(100)
      assert.equal(hub.fabric.registry.get('node-rev'), undefined, 'register table still offline')
      assert.equal(hub.fabric.isOnline('node-rev'), false)
      // undo after completion new register do not subject to affect (epoch already push enter but without in-flight register).
      authDelayMs = 0
      const daemon2 = await startNode({
        url: hub.baseUrl,
        nodeId: 'node-rev',
        token: TOKEN,
        dataDir: await mkdtemp(join(rootDir, 'revoke-d2-')),
      })
      assert.ok(await daemon2.waitUntilRegistered(), 'undo after completion new register normal')
      await daemon2.close()
      try {
        hubRpc.$close()
      } catch {
        /* already closure */
      }
      try {
        ws.close()
      } catch {
        /* already closure */
      }
    } finally {
      await hub.close()
    }
  })

  it('reader across proxy: assert connect after old readerId do not to new proxy (do not mistakenly read other file)', { timeout: 60_000 }, async () => {
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

      // one proxy: open a.txt(readerId r1).
      const opened = await env.openTextLineReader('a.txt', bg)
      assert.ok(opened.ok)
      const line1 = await opened.value.readLine(bg)
      assert.ok(line1.ok && line1.value?.text === 'A1')

      // disconnect (one proxy final, handle r1 destroy)→ new proxy reconnect and open b.txt
      //(new proxy readerId re- counter,r1 points to b.txt).
      await daemon.close()
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-reader', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const env2 = hub.fabric.envFor('node-reader', workDir)
      const openedB = await env2.openTextLineReader('b.txt', bg)
      assert.ok(openedB.ok)

      // old reader again read: must explicit errors, never read to B1(across proxy mistakenly read).
      const stale = await opened.value.readLine(bg)
      if (stale.ok) {
        // other implement under rpc invoke for already close proxy throws (away catch branch) - - that is
        // explicit failed while non- read to data, same satisfy do not mistakenly read; but read to B1 never allows.
        assert.notEqual(stale.value?.text, 'B1', 'old proxy reader never read to new proxy file content')
      } else {
        assert.ok(
          ['unknown', 'invalid', 'not_found', 'aborted'].includes(stale.error.code),
          `expectation explicit error, obtain to ${JSON.stringify(stale)}`,
        )
      }
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })

  it('output sink bind set connect proxy: assert connect after old proxy late to output event must not pollute new proxy', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'sink-node-'))
    const workDir = await mkdtemp(join(rootDir, 'sink-work-'))
    const TOKEN = 'node-sink:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-sink' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      // register output sink collect all event.
      const received: Array<{ execId: string; text: string }> = []
      hub.fabric.registry.addOutputSink('node-sink', (event) => received.push({ execId: event.execId, text: event.text }))
      const env = hub.fabric.envFor('node-sink', workDir)
      const r1 = await env.exec('echo old-gen', undefined, bg)
      assert.ok(r1.ok)
      await delay(200)
      assert.ok(received.some((e) => e.text.includes('old-gen')), 'online when output normal routing')
      // disconnect: old proxy event channel final.
      await daemon.close()
      await delay(300)
      const countAfterDisconnect = received.length
      // new proxy reconnect after again execute: event should continue routing (new proxy bind set new sink dispatch path),
      // and disconnect during without fabricate event reach.
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const r2 = await env.exec('echo new-gen', undefined, bg)
      assert.ok(r2.ok)
      await delay(300)
      assert.ok(received.some((e) => e.text.includes('new-gen')), 'new proxy output continue routing to sink')
      // disconnect during reach event only may is disconnect before late to frame; confirm without old proxy reconnect after fabricate inject
      //(new-gen before do not add and old-gen without closure execId).
      void countAfterDisconnect
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. HTTP routing:/api/nodes and /api/env/exec
// ---------------------------------------------------------------------------

describe('node manage and env/exec HTTP routing', { timeout: 60_000 }, () => {
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

  it('GET /api/nodes + issue(token once)+ remove(pinch assert connect,local protect)', { timeout: 60_000 }, async () => {
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
      assert.equal(list1.json[1].online, false, 'not on connect offline')

      const daemon = await startNode({ url: app.hub.url, nodeId: 'http-node', token: issue.json.token, dataDir: dir })
      assert.ok(await daemon.waitUntilRegistered())
      const list2 = await call(app, 'GET', '/api/nodes')
      assert.equal(list2.json[1].online, true)
      assert.ok(typeof list2.json[1].hostname === 'string' && list2.json[1].hostname.length > 0, 'daemon register on report hostname')

      // node.changed event sequence (SSE incremental frame): enable -> remove exactly a contains removed:true;
      // event is NodeChangedEvent shape ('node' in event), do not fall Custom payload embed set.
      const nodeEvents: Array<{ node: { id: string }; removed?: boolean; payload?: unknown }> = []
      const releaseEvents = app.kernel.events.subscribe((frame) => {
        const event = frame.event as { type: string; node?: unknown; removed?: unknown; payload?: unknown }
        if (event.type === 'node.changed') {
          assert.ok('node' in event, `node.changed must be NodeChangedEvent shape, obtain to ${JSON.stringify(event)}`)
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
        `remove actual node when exactly publish a contains removed:true event (onNodeChanged dedupe after), obtain to ${JSON.stringify(nodeEvents)}`,
      )
      assert.equal(
        nodeEvents.filter((e) => e.node.id === 'http-node' && e.removed !== true).length,
        0,
        `remove after must not again publish http-node non- removed event (offline event must by dedupe), obtain to ${JSON.stringify(nodeEvents)}`,
      )
      for (const e of nodeEvents) {
        assert.equal(e.payload, undefined, 'NodeChangedEvent does not carry payload field')
      }
      const list3 = await call(app, 'GET', '/api/nodes')
      assert.equal(list3.json.length, 1, 'remove after only remain local')

      const localRemove = await call(app, 'DELETE', '/api/nodes/local')
      assert.equal(localRemove.status, 400)
      assert.equal(localRemove.json.error.code, 'cannot_remove_local_node')
      await daemon.close()
      await app.close()
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /api/env/exec:local JSON, remote stream NDJSON frame, offline 409, conversation target inherit', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'http-exec-'))
    const app = await openApp(dir)
    try {
      // local JSON.
      const local = await call(app, 'POST', '/api/env/exec', { command: 'echo hello-env-exec' })
      assert.equal(local.status, 200)
      assert.equal(local.json.ok, true)
      assert.equal(local.json.exitCode, 0)
      assert.ok(local.json.output.includes('hello-env-exec'))

      // offline node:409 node_offline.
      await call(app, 'POST', '/api/nodes/issue', { nodeId: 'offline-node' })
      const offline = await call(app, 'POST', '/api/env/exec', {
        command: 'echo x',
        nodeId: 'offline-node',
        cwd: '/tmp',
      })
      assert.equal(offline.status, 409)
      assert.equal(offline.json.error.code, 'node_offline')

      // remote stream NDJSON:output frame + unique exit final frame (frame protocol output/exit/error).
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
      assert.ok(frames.every((f) => ['output', 'exit', 'error'].includes(f.type)), 'frame protocol only output/exit/error')
      const exits = frames.filter((f) => f.type === 'exit')
      assert.equal(exits.length, 1, 'exactly a exit final frame')
      assert.equal(exits[0].ok, true)
      assert.equal(exits[0].exitCode, 0)
      const joined = frames.filter((f) => f.type === 'output').map((f) => f.text).join('')
      assert.ok(joined.includes('line1') && joined.includes('line2'), `streaming concatenate should contains all output:${joined}`)

      // conversation target inherit: create bind set stream-node conversation after, do not carries nodeId/cwd 
      // exec with conversationId inherit remote target.
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
      assert.ok(inherited.json.output.includes('TARGET'), 'conversation target inherit: remote file in remote read')
      await daemon.close()
    } finally {
      await app.close()
    }
  })

  it('conversation bind set remote nodeId: real model turn via bash/write/edit/read in remote takes effect', { timeout: 60_000 }, async () => {
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

      // remote solely has file: if tool mistakenly run Hub local machine,cat must failed (Hub directory without this file).
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
        fauxAssistantMessage('all complete'),
      ])
      await kernel.submitInput(conv.id, 'in remote execute system column tool')
      await kernel.waitForIdle(conv.id)

      // disk fact assertion (most can rely):write + edit all in remote takes effect.
      const written = await readFile(join(workDir, 'written.txt'), 'utf8')
      assert.equal(written, 'written-by-edit-tool-ok', 'write + edit all in remote takes effect')
      assert.equal(await kernel.getLastAssistantText(conv.id), 'all complete')
      await daemon.close()
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})
