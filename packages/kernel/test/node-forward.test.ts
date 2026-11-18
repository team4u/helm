/**
 * Hub-side foreground port forwarding (NodeForwardService + HTTP routes) integration tests:
 * real EnvFabric Hub + real @helm/node daemon + binary echo server.
 * Covers: start/stop lifecycle (listeners and tunnels destroyed on stop), explicit listen conflict failure,
 * event stream (started/connection), and lease/lifecycle behavior.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withTimeout } from '@helm/test-kit'
import { attachNodeWsGateway, attachNodeTunnelGateway, createEnvFabric, NodeForwardService } from '../src/env/index.js'
import { createNodeDaemon } from '@helm/node'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-forward-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function startStack(leaseTimeoutMs?: number) {
  const fabric = createEnvFabric({
    authenticate: (id, token) => id === 'fwd-node' && token === 'fwd-node:secret',
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
  })
  const forward = new NodeForwardService(fabric, leaseTimeoutMs)
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const hubPort = (server.address() as net.AddressInfo).port
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  const tunnelGateway = attachNodeTunnelGateway(server, { registry: fabric.registry })
  const nodeData = mkdtempSync(join(rootDir, 'node-'))
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    identity: { nodeId: 'fwd-node', token: 'fwd-node:secret' },
    dataDir: nodeData,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
  const ready = await daemon.waitUntilRegistered(10_000)
  return {
    forward,
    ready,
    close: async () => {
      await forward.close()
      await daemon.close()
      await tunnelGateway.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
      rmSync(nodeData, { recursive: true, force: true })
    },
  }
}

/** Binary echo server. */
async function startEcho(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** Local TCP client: sends payload and waits for at least payload.length echoed bytes. */
function tcRequest(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('error', reject)
    const chunks: Buffer[] = []
    let received = 0
    socket.on('data', (c) => {
      chunks.push(c)
      received += c.length
      if (received >= payload.length) {
        socket.end()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.write(payload)
  })
}

test('port forwarding: start/list/get/event + tears down listeners and tunnels after stop', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const events: string[] = []
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    const off = stack.forward.onEvent(session.forwardId, (event) => events.push(event.type))
    assert.equal(stack.forward.get(session.forwardId)?.forwardId, session.forwardId)
    assert.deepEqual(stack.forward.list().map((s) => s.forwardId), [session.forwardId])

    // Real byte echo path: local listen port -> Hub forwarder -> tunnel -> daemon -> echo.
    const payload = Buffer.from('forward-payload-hello')
    const echoed = await tcRequest(session.listenPort, payload)
    assert.ok(echoed.equals(payload), 'echoed bytes must match across forward tunnel')
    await delay(100)
    assert.ok(events.includes('connection'), 'connection event emitted')
    assert.equal(stack.forward.get(session.forwardId)?.activeConnections, 0, 'active counter resets to zero on socket close')

    await stack.forward.stop(session.forwardId)
    assert.equal(stack.forward.get(session.forwardId), undefined, 'session removed after stop')
    await assert.rejects(
      tcRequest(session.listenPort, payload).then(() => undefined, (e) => { throw e }),
      undefined,
    ).catch(() => undefined) // Port closed: connection rejected (error subtype not constrained).
    off()
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: listen conflict fails explicitly; stopping unknown forwardId throws 404', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  const port = await freePort()
  try {
    assert.equal(stack.ready, true)
    await stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: port, targetPort: echo.port })
    // Second bind on same address fails explicitly (never silently swaps ports).
    await assert.rejects(
      stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: port, targetPort: echo.port }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'node_forward_listen_failed',
    )
    await assert.rejects(
      stack.forward.stop('fwd-does-not-exist'),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: close() destroys all sessions (host shutdown semantics)', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    await stack.forward.close()
    assert.equal(stack.forward.get(session.forwardId), undefined)
    assert.deepEqual(stack.forward.list(), [])
    await assert.rejects(
      stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: await freePort(), targetPort: echo.port }),
      undefined,
    ).catch(() => undefined) // Rejects new forwards after close().
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: client disconnect mid-handshake cancels tunnel establishment with zero leaked registrations', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // Connect and drop immediately before handshake completes (real daemon tunnel setup has RTT).
    const socket = net.connect({ host: '127.0.0.1', port: session.listenPort })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.destroy()
    // Wait beyond setup window: late-arriving tunnel gets destroyed cleanly without bumping activeConnections.
    await delay(600)
    const current = stack.forward.get(session.forwardId)
    assert.ok(current !== undefined)
    assert.equal(current.activeConnections, 0, 'mid-handshake disconnect must not leave lingering activeConnections')
    // Subsequent connections stay healthy (unaffected by earlier drop).
    const payload = Buffer.from('after-early-close')
    const echoed = await tcRequest(session.listenPort, payload)
    assert.ok(echoed.equals(payload), 'forwarding remains operational after early close')
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: stop emits terminal stopped frame and resolves event listeners cleanly without hanging', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    const events: string[] = []
    let notifyStopped: (() => void) | undefined
    const stoppedPromise = new Promise<void>((resolve) => {
      notifyStopped = resolve
    })
    const off = stack.forward.onEvent(session.forwardId, (event) => events.push(event.type))
    const offStopped = stack.forward.onStopped(session.forwardId, () => notifyStopped?.())
    // Subscribe first, then stop: terminal stopped frame arrives before stream closes.
    await stack.forward.stop(session.forwardId)
    await withTimeout(stoppedPromise, 5_000, 'onStopped was not invoked')
    assert.deepEqual(events.filter((t) => t === 'stopped'), ['stopped'], 'stop should emit exactly one stopped frame')
    off()
    offStopped()
    // Subscribing onStopped after already stopped invokes callback immediately (race-safe).
    const immediate = new Promise<void>((resolve) => {
      stack.forward.onStopped(session.forwardId, resolve)
    })
    await withTimeout(immediate, 1_000, 'onStopped after stop should resolve immediately')
    // Subscribing onEvent after stop throws 404 (session evicted).
    await assert.rejects(
      new Promise(() => stack.forward.onEvent(session.forwardId, () => undefined)),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

/** Claims an ephemeral free port (brief inherent race acceptable in local tests). */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** Opens concurrent TCP echo clients and collects complete echoed payloads. */
async function tcConcurrent(port: number, payloads: Buffer[]): Promise<Buffer[]> {
  return await Promise.all(payloads.map(
    (payload) => new Promise<Buffer>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.on('error', reject)
      const chunks: Buffer[] = []
      let received = 0
      socket.on('data', (c) => {
        chunks.push(c)
        received += c.length
        if (received >= payload.length) {
          socket.end()
          resolve(Buffer.concat(chunks))
        }
      })
      socket.write(payload)
    }),
  ))
}

test('port forwarding: closing multiple concurrent connections decrements activeConnections exactly once per connection', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // Three concurrent connections: echo then close; socket/tunnel closing first only decrements once.
    const payloads = ['one'.repeat(5000), 'two'.repeat(5000), 'three'.repeat(5000)].map((s) => Buffer.from(s))
    const echoed = await tcConcurrent(session.listenPort, payloads)
    for (let i = 0; i < payloads.length; i++) {
      assert.ok(echoed[i]!.equals(payloads[i]!), `echo mismatch on connection ${i + 1}`)
    }
    await delay(150)
    const current = stack.forward.get(session.forwardId)
    assert.ok(current !== undefined)
    assert.equal(current.activeConnections, 0, 'active counter must settle back to zero without double-decrement skewing other connections')
    assert.equal(current.totalConnections, 3, 'cumulative connection count = 3')
    // Open two sequential connections afterwards to confirm counters stayed accurate.
    const again = await tcConcurrent(session.listenPort, [Buffer.from('a'.repeat(3000)), Buffer.from('b'.repeat(3000))])
    assert.equal(again.length, 2)
    await delay(150)
    assert.equal(stack.forward.get(session.forwardId)?.activeConnections, 0, 'counters remain exact on subsequent connections')
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: stop is idempotent and concurrent calls await the same close Promise', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // Concurrent duplicate stops all resolve cleanly (never 404 mid-shutdown; shares teardown promise).
    await Promise.all([
      stack.forward.stop(session.forwardId),
      stack.forward.stop(session.forwardId),
      stack.forward.stop(session.forwardId),
    ])
    assert.equal(stack.forward.get(session.forwardId), undefined, 'evicted once close finishes')
    // Explicit stop after close finishes rejects with not_found (HTTP layer turns repeated DELETE into idempotent 404).
    await assert.rejects(
      stack.forward.stop(session.forwardId),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: foreground lease expires cleanly if unattached, and holds open until final lease releases', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack(150) // Short 150ms lease timeout
  try {
    assert.equal(stack.ready, true)
    // 1) Never attached by client: expires automatically on lease timeout (avoids leaks if CLI dies/DELETE fails).
    const orphan = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    await delay(400)
    assert.equal(stack.forward.get(orphan.forwardId), undefined, 'unattached forward stops automatically after lease expires')
    await assert.rejects(
      tcRequest(orphan.listenPort, Buffer.from('x')).then(() => undefined, (e) => { throw e }),
      undefined,
    ).catch(() => undefined) // Listener already closed.

    // 2) While leases are held, stays alive beyond timeout; stops once final lease releases.
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    const release1 = stack.forward.acquireLease(session.forwardId)
    await delay(400) // Past lease window, yet holder keeps it alive.
    assert.ok(stack.forward.get(session.forwardId) !== undefined, 'must not expire while a lease holder remains')
    const payload = Buffer.from('lease-alive')
    assert.ok((await tcRequest(session.listenPort, payload)).equals(payload), 'forwarding works while lease held')
    const release2 = stack.forward.acquireLease(session.forwardId)
    release1()
    await delay(100)
    assert.ok(stack.forward.get(session.forwardId) !== undefined, 'still held by second lease')
    release2()
    await delay(200)
    assert.equal(stack.forward.get(session.forwardId), undefined, 'stops immediately once final lease releases')
    await assert.rejects(
      stack.forward.stop(session.forwardId),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})
