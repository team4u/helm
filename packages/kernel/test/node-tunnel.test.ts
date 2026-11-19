/**
 * Unit tests for node pass-through tunnels (Hub/protocol side):
 * - registry.openTunnel: offline node 409 / unimplemented nodeTunnelOpen 501 / single-use pending
 *   tunnelId (duplicate accept rejected) / signal abort cleans up pending / target host pass-through
 *   (including host validation);
 * - Pending tunnels are rejected (409 node_offline) immediately on node disconnect/eviction rather than hanging;
 * - acceptTunnel rejects mismatched identity (nodeId / token / unknown tunnelId);
 * - fabric.nodeFetch port: rejects non-http(s) URLs, forwards arbitrary hosts to connection setup;
 *   local node delegates directly to globalThis.fetch; fabric.openTunnel connects directly for local;
 * - attachNodeTunnelGateway: non-JSON / non-hello first frame returns error frame and closes;
 *   valid hello with unknown tunnelId rejects immediately (registry reject path).
 * Real daemon end-to-end byte pass-through is covered in env-fabric.test.ts / node-tunnel-binary.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import type { WebSocket as WsSocket } from 'ws'
import { HelmxError } from '@helmx/protocol'
import { NodeRegistry } from '../src/env/registry.js'
import { attachNodeTunnelGateway } from '../src/env/ws-tunnel-gateway.js'
import { createEnvFabric, type EnvFabric } from '../src/env/fabric.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

type TunnelOpenFn = (input: { tunnelId: string; host?: string; port: number }) =>
  Promise<{ ok: true; value: null } | { ok: false; error: { code: string; message: string } }>

/** Registers a fake node (constant auth with `<nodeId>:secret`), optionally providing nodeTunnelOpen. */
async function registerFakeNode(registry: NodeRegistry, nodeId: string, nodeTunnelOpen?: TunnelOpenFn): Promise<FakeSocket> {
  const socket = new FakeSocket()
  const rpc: Record<string, unknown> = {
    $close() {},
    ...(nodeTunnelOpen !== undefined ? { nodeTunnelOpen } : {}),
  }
  const outcome = await registry.register(
    socket as unknown as WsSocket,
    { nodeId, token: `${nodeId}:secret`, hostname: 'h', platform: 'linux' },
    () => rpc as never,
  )
  assert.equal(outcome.accepted, true)
  return socket
}

const tunnelOk: TunnelOpenFn = () => Promise.resolve({ ok: true, value: null })

test('openTunnel: offline node 409, unimplemented nodeTunnelOpen 501', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    await assert.rejects(
      registry.openTunnel('ghost', { port: 8080 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
    )
    const socket = await registerFakeNode(registry, 'node-a')
    await assert.rejects(
      registry.openTunnel('node-a', { port: 8080 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_not_supported' && error.status === 501,
    )
    socket.close()
  } finally {
    await registry.close()
  }
})

test('openTunnel + acceptTunnel: single-use consumption and identity validation', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: (id, token) => token === `${id}:secret` })
  try {
    let tunnelId = ''
    let openedHost: string | undefined
    const socket = await registerFakeNode(registry, 'node-b', async (input) => {
      tunnelId = input.tunnelId
      openedHost = input.host
      return { ok: true, value: null }
    })
    const pending = registry.openTunnel('node-b', { port: 9000, host: 'db.internal' })
    await delay(20)
    assert.equal(tunnelId.length > 0, true)
    assert.equal(openedHost, 'db.internal', 'target host passes through verbatim to node (node resolves it)')
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    // Wrong token -> rejected, pending preserved.
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:wrong', tunnelId), false)
    // Mismatched nodeId -> rejected.
    assert.equal(await registry.acceptTunnel('other', 'other:secret', tunnelId), false)
    // Valid consumption -> acceptTunnel true + grantTunnel delivers Duplex, registry moves to active.
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:secret', tunnelId), true)
    const granted = new PassThrough()
    registry.grantTunnel(tunnelId, granted)
    const duplex = await pending
    assert.equal(duplex, granted)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 1 })
    // Second consumption of same tunnelId -> rejected.
    assert.equal(await registry.acceptTunnel("node-b", "node-b:secret", tunnelId), false)
    // Registry entry is removed once duplex closes.
    duplex.destroy()
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('node disconnect cleans up pending tunnels (rejects 409 without hanging)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-c', tunnelOk)
    const pending = registry.openTunnel('node-c', { port: 9100 })
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    socket.close() // triggers eviction: pending must be rejected.
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline' && error.status === 409,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
  } finally {
    await registry.close()
  }
})

test('openTunnel: signal abort cleans up pending tunnel (499 aborted)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-d', tunnelOk)
    const controller = new AbortController()
    const pending = registry.openTunnel('node-d', { port: 9200 }, controller.signal)
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmxError && error.code === 'aborted' && error.status === 499,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('openTunnel: draining rejection maps to node_draining(503), distinct from aborted(499)/timeout(504)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    // Node RPC explicitly returning node_draining (rejecting new work during upgrade drain) maps stably
    // to HelmxError node_draining 503, never collapsed into aborted or connect_failed.
    const socket = await registerFakeNode(registry, 'node-drain', async () => ({
      ok: false,
      error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new tunnels' },
    }))
    await assert.rejects(
      registry.openTunnel('node-drain', { port: 9300 }),
      (error: unknown) =>
        error instanceof HelmxError &&
        error.code === 'node_draining' &&
        error.status === 503 &&
        /draining/.test(error.message),
    )
    socket.close()

    // Contrast: node-side aborted (genuine cancellation) still maps to 499 aborted, unaffected by draining logic.
    const socket2 = await registerFakeNode(registry, 'node-abort', async () => ({
      ok: false,
      error: { code: 'aborted', message: 'tunnel aborted' },
    }))
    await assert.rejects(
      registry.openTunnel('node-abort', { port: 9301 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'aborted' && error.status === 499,
    )
    socket2.close()

    // Contrast: timeout still maps to 504 node_tunnel_timeout.
    const socket3 = await registerFakeNode(registry, 'node-slow', async () => ({
      ok: false,
      error: { code: 'timeout', message: 'tunnel open timed out' },
    }))
    await assert.rejects(
      registry.openTunnel('node-slow', { port: 9302 }),
      (error: unknown) =>
        error instanceof HelmxError && error.code === 'node_tunnel_timeout' && error.status === 504,
    )
    socket3.close()
  } finally {
    await registry.close()
  }
})

test('nodeFetch port: rejects non-http(s), forwards arbitrary hosts; validates openTunnel target; local passes through', { timeout: 60_000 }, async () => {
  let fabric: EnvFabric | undefined
  try {
    fabric = createEnvFabric({ authenticate: () => true })
    const fetchRemote = fabric.nodeFetch('node-e')
    await assert.rejects(
      fetchRemote('ftp://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_connect_failed',
    )
    // Arbitrary (non-loopback) hosts proceed to connection setup: offline node yields 409 (no longer rejects non-loopback).
    await assert.rejects(
      fetchRemote('http://example.com:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('http://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    // Default ports (80/443) proceed to connection setup (adapter supplies default port by scheme).
    await assert.rejects(
      fetchRemote('http://127.0.0.1/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('https://example.com/x'),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    // openTunnel target validation: invalid port or host fails explicitly with 400 validation_error.
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 0 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error' && error.status === 400,
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 70000 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'bad host\n', port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: '', port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'a'.repeat(256), port: 80 }),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
    )
    // Local openTunnel: connects directly in-process (echo server round-trips data).
    const echo = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as net.AddressInfo).port
    try {
      const duplex = await fabric.openTunnel('local', { host: '127.0.0.1', port: echoPort })
      const echoed = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        duplex.on('data', (c: Buffer) => chunks.push(c))
        duplex.once('error', reject)
        duplex.write('ping-local')
        const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString()), 5_000)
        duplex.on('data', () => {
          const text = Buffer.concat(chunks).toString()
          if (text.includes('ping-local')) { clearTimeout(timer); resolve(text) }
        })
      })
      assert.ok(echoed.includes('ping-local'), 'local openTunnel round-trips bytes')
      duplex.destroy()
      // Local openTunnel: closed port fails explicitly (never silently fakes success).
      await assert.rejects(
        fabric.openTunnel('local', { port: 1 }),
        (error: unknown) => error instanceof HelmxError && error.code === 'node_tunnel_connect_failed',
      )
      // Local openTunnel: abort yields explicit 499.
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        fabric.openTunnel('local', { port: echoPort }, controller.signal),
        (error: unknown) => error instanceof HelmxError && error.code === 'aborted',
      )
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
    assert.equal(fabric.nodeFetch('local'), globalThis.fetch)
  } finally {
    await fabric?.dispose()
  }
})

test('tunnel gateway: non-JSON / non-hello first frame returns error frame; unknown tunnelId rejects immediately', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const gateway = attachNodeTunnelGateway(server, { registry })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const url = `ws://127.0.0.1:${address.port}/ws/node-tunnel`

    // Non-JSON and non-hello: error frame + close.
    for (const frame of ['not-json', JSON.stringify({ type: 'other' })]) {
      const ws = new WebSocket(url)
      const frames: string[] = []
      await new Promise<void>((resolve) => {
        ws.on('open', () => { ws.send(frame) })
        ws.on('message', (raw) => { frames.push(raw.toString()) })
        ws.on('close', () => resolve())
      })
      const parsed = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
      assert.equal(parsed.type, 'error')
      assert.equal(parsed.code, 'invalid')
    }

    // Valid hello with unknown tunnelId: auth/match failure -> immediate error frame + close
    // (ok frame must never precede verification; never enters data phase).
    const ws = new WebSocket(url)
    const frames: string[] = []
    await new Promise<void>((resolve) => {
      ws.on('open', () => { ws.send(JSON.stringify({ tunnelId: 'missing', nodeId: 'node-x', token: 'node-x:secret' })) })
      ws.on('message', (raw) => { frames.push(raw.toString()) })
      ws.on('close', () => resolve())
    })
    assert.equal(frames.length, 1)
    const rejected = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
    assert.equal(rejected.type, 'error')
    assert.equal(rejected.code, 'permission_denied')
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await registry.close()
  }
})

test('tunnel gateway: silent connection without hello closes after first-frame timeout (code 4001, no accumulation)', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const gateway = attachNodeTunnelGateway(server, { registry, helloTimeoutMs: 150 })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const url = `ws://127.0.0.1:${address.port}/ws/node-tunnel`

    // Connects and sends nothing: must close after first-frame timeout (matching /ws/node 4001 semantics).
    const ws = new WebSocket(url)
    let closeCode = -1
    const closedAt = new Promise<void>((resolve) => {
      ws.on('close', (code: number) => { closeCode = code; resolve() })
    })
    const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()))
    await opened
    const startedAt = Date.now()
    await closedAt
    const elapsed = Date.now() - startedAt
    assert.equal(closeCode, 4001, `silent connection should be closed by timeout (close code ${closeCode})`)
    assert.ok(elapsed >= 140 && elapsed < 5_000, `timeout should fire near threshold (actual ${elapsed}ms)`)
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await registry.close()
  }
})
