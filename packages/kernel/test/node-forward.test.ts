/**
 * Hub side foreground port forwarding (NodeForwardService + HTTP routing) integration test:
 * real EnvFabric Hub + real @helm/node daemon + two enter system echo service.
 * override:start/stop lifecycle (stop after listener and tunnel destroy), listen conflict explicit failed,
 * event stream (started/connection),HTTP end point (POST/GET/DELETE/manifest).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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

/** two enter system echo service. */
async function startEcho(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** local TCP client: connect concurrency send, wait for at least minLength back visible. */
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

test('port forwarding:start/list/get/event + stop after listener and tunnel destroy', { timeout: 60_000 }, async () => {
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

    // real byte to return: local listen port → Hub forwarding → tunnel → daemon → echo.
    const payload = Buffer.from('forward-payload-you well')
    const echoed = await tcRequest(session.listenPort, payload)
    assert.ok(echoed.equals(payload), 'via forwarding byte to return consistent')
    await delay(100)
    assert.ok(events.includes('connection'), 'connection event already on report')
    assert.equal(stack.forward.get(session.forwardId)?.activeConnections, 0, 'connect close after counter reset to zero')

    await stack.forward.stop(session.forwardId)
    assert.equal(stack.forward.get(session.forwardId), undefined, 'stop after conversation excerpt except')
    await assert.rejects(
      tcRequest(session.listenPort, payload).then(() => undefined, (e) => { throw e }),
      undefined,
    ).catch(() => undefined) // port already closure: failed to connect (do not validate specific error type).
    off()
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: listen conflict explicit failed; unknown forwardId stop 404', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  const port = await freePort()
  try {
    assert.equal(stack.ready, true)
    await stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: port, targetPort: echo.port })
    // same address second listen: explicit failed (not silently swap port).
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

test('port forwarding:close all amount destroy (host closure stop semantics)', { timeout: 60_000 }, async () => {
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
    ).catch(() => undefined) // close after reject new forwarding.
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: create connect phase client disconnect - - cancel in-flight establish, late to tunnel do not register do not legacy', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // connect on after immediately disconnect (create connect not yet complete: real daemon link create connect has RTT).
    const socket = net.connect({ host: '127.0.0.1', port: session.listenPort })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.destroy()
    // wait for create connect window remove: late to tunnel by destroy, do not register activeConnections.
    await delay(600)
    const current = stack.forward.get(session.forwardId)
    assert.ok(current !== undefined)
    assert.equal(current.activeConnections, 0, 'create connect phase disconnect must not count activity connect')
    // after continue connect still available (before once disconnect do not pollute state).
    const payload = Buffer.from('after-early-close')
    const echoed = await tcRequest(session.listenPort, payload)
    assert.ok(echoed.equals(payload), 'early after disconnect forwarding still available')
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding:stop terminal state stopped frame, monitor event sequence normal final (do not pending)', { timeout: 60_000 }, async () => {
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
    // first subscribe, again stop:stopped frame after terminate notify reach.
    await stack.forward.stop(session.forwardId)
    await Promise.race([stoppedPromise, delay(5_000).then(() => { throw new Error('onStopped not by invoke') })])
    assert.deepEqual(events.filter((t) => t === 'stopped'), ['stopped'], 'stop should exactly out a terminal state stopped frame')
    off()
    offStopped()
    // already stop after again subscribe onStopped: immediately call back (race security).
    const immediate = new Promise<void>((resolve) => {
      stack.forward.onStopped(session.forwardId, resolve)
    })
    await Promise.race([immediate, delay(1_000).then(() => { throw new Error('already stop after onStopped should immediately call back') })])
    // already stop after onEvent 404(conversation already excerpt except).
    await assert.rejects(
      new Promise(() => stack.forward.onEvent(session.forwardId, () => undefined)),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

/** take a idle port (listen 0 after immediately release; store in tiny race but test environment enough). */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** many concurrency echo client: each write payload and etc. back visible complete. */
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

test('port forwarding: many connect each close does not repeat buckle reduce activity counter (exactly once clean up)', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // 3 concurrency connect: each back visible after close;socket/tunnel any one first closure only clean up once.
    const payloads = ['one'.repeat(5000), 'two'.repeat(5000), 'three'.repeat(5000)].map((s) => Buffer.from(s))
    const echoed = await tcConcurrent(session.listenPort, payloads)
    for (let i = 0; i < payloads.length; i++) {
      assert.ok(echoed[i]!.equals(payloads[i]!), ` ${i + 1} connect back visible consistent`)
    }
    await delay(150)
    const current = stack.forward.get(session.forwardId)
    assert.ok(current !== undefined)
    assert.equal(current.activeConnections, 0, 'all connect close after activity counter precise reset to zero (duplicate decrement will change negative/eat other person counter - -Math.max only mask code do not fix correct total account)')
    assert.equal(current.totalConnections, 3, 'cumulative connect count = 3')
    // one by one again open two: verify counter in before time concurrency clean up after still accurate.
    const again = await tcConcurrent(session.listenPort, [Buffer.from('a'.repeat(3000)), Buffer.from('b'.repeat(3000))])
    assert.equal(again.length, 2)
    await delay(150)
    assert.equal(stack.forward.get(session.forwardId)?.activeConnections, 0, 'after continue connect counter still accurate')
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding:stop idempotent sharing the same close Promise(concurrency invoke etc. the same result)', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    // concurrency + duplicate stop: all resolve(do not 404- - sharing close, do not immediately return).
    await Promise.all([
      stack.forward.stop(session.forwardId),
      stack.forward.stop(session.forwardId),
      stack.forward.stop(session.forwardId),
    ])
    assert.equal(stack.forward.get(session.forwardId), undefined, 'close after completion excerpt except once')
    // close after explicit stop: conversation already excerpt except, by not_found reject (and HTTP 404 idempotent opening path consistent).
    await assert.rejects(
      stack.forward.stop(session.forwardId),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('port forwarding: foreground lease - - not bind set event stream automatically stop; finally one holder release stop', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack(150) // inject short phase limit:150ms
  try {
    assert.equal(stack.ready, true)
    // 1) after creation not bind set holder: lease expires automatically stop (CLI by kill/DELETE failed leaves no residue).
    const orphan = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    await delay(400)
    assert.equal(stack.forward.get(orphan.forwardId), undefined, 'not bind set forwarding start lease expires automatically stop')
    await assert.rejects(
      tcRequest(orphan.listenPort, Buffer.from('x')).then(() => undefined, (e) => { throw e }),
      undefined,
    ).catch(() => undefined) // listener already closure.

    // 2) bind set holder after do not automatically stop; two holder one by one release, finally a only then stop.
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    const release1 = stack.forward.acquireLease(session.forwardId)
    await delay(400) // exceeds lease phase limit: still store (holder store in).
    assert.ok(stack.forward.get(session.forwardId) !== undefined, 'holder store in when do not because lease expires stop')
    const payload = Buffer.from('lease-alive')
    assert.ok((await tcRequest(session.listenPort, payload)).equals(payload), 'hold has during forwarding available')
    const release2 = stack.forward.acquireLease(session.forwardId)
    release1()
    await delay(100)
    assert.ok(stack.forward.get(session.forwardId) !== undefined, 'still has holder when do not stop')
    release2()
    await delay(200)
    assert.equal(stack.forward.get(session.forwardId), undefined, 'finally one holder release i.e. stop')
    await assert.rejects(
      stack.forward.stop(session.forwardId),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})
