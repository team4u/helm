/**
 * any TCP tunnel (openTunnel)Hub+real node daemon integration test:
 * do not stop HTTP- - any host target, two enter system/large payload, half close, cancel,
 * nodeFetch  HTTP/HTTPS adapt (local TLS fixture).
 *
 * real link:fabric.openTunnel → registry.openTunnel → daemon
 * nodeTunnelOpen(host) → TCP → /ws/node-tunnel byte pipeline.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  attachNodeWsGateway,
  attachNodeTunnelGateway,
  createEnvFabric,
  type EnvFabric,
} from '../src/env/index.js'
import { createNodeDaemon } from '@helm/node'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-tunnel-bin-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

const execFileAsync = promisify(execFile)

/** pure EnvFabric Hub(HTTP server + double gateway + real daemon). */
async function startHub(authenticate: (nodeId: string, token: string) => boolean, nodeId: string) {
  const fabric = createEnvFabric({ authenticate, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  const tunnelGateway = attachNodeTunnelGateway(server, { registry: fabric.registry })
  const nodeData = mkdtempSync(join(rootDir, `node-${nodeId}-`))
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${address.port}`,
    identity: { nodeId, token: `${nodeId}:secret` },
    dataDir: nodeData,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
  const ready = await daemon.waitUntilRegistered(10_000)
  return {
    fabric,
    ready,
    disconnectDaemon: () => daemon.close(),
    close: async () => {
      await daemon.close()
      await tunnelGateway.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
      rmSync(nodeData, { recursive: true, force: true })
    },
  }
}

/** two enter system security echo service (any byte original back visible;socket error swallow guard against test crash). */
async function startBinaryEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('any TCP:host pass-through + two enter system large payload double to byte complete to return', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'bin-node' && token === 'bin-node:secret', 'bin-node')
  try {
    assert.equal(hub.ready, true)
    // explicit host=localhost: target host by node parse and connect.
    const duplex = await hub.fabric.openTunnel('bin-node', { host: 'localhost', port: echo.port })
    const payload = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251 // non- UTF-8 friend well byte
    const chunks: Buffer[] = []
    let received = 0
    duplex.on('data', (c: Buffer) => {
      chunks.push(c)
      received += c.length
    })
    duplex.write(payload)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15_000)
      duplex.on('data', () => {
        if (received >= payload.length) { clearTimeout(timer); resolve() }
      })
      duplex.once('error', reject)
    })
    assert.equal(received, payload.length, '4MiB two enter system payload length consistent')
    const echoed = Buffer.concat(chunks)
    assert.ok(echoed.equals(payload), 'two enter system content one by one byte consistent')
    duplex.destroy()
    duplex.on('error', () => undefined)
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('any TCP: request-response-connect close link complete flush(do not pinch assert tail part data)', { timeout: 60_000 }, async () => {
  // service: receives 'req' after write large response again end.Hub side do not pre- closure tunnel (write side keep),
  // read to complete response after actively close - - verify connect close link flush complete, tail part do not lose.
  // (note:WS tunnel without TCP half close - -duplex.end will whole close, reason do not test FIN half closure;
  // node side pipe chain end-flush semantics by node package node-tunnel.test.ts override.)
  const response = Buffer.alloc(2 * 1024 * 1024, 0x52)
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('req')) socket.end(response)
    })
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  const hub = await startHub((id, token) => id === 'halfclose-node' && token === 'halfclose-node:secret', 'halfclose-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('halfclose-node', { port })
    duplex.on('error', () => undefined) // close link error by close converge
    const chunks: Buffer[] = []
    const got = new Promise<Buffer>((resolve) => {
      duplex.on('data', (c: Buffer) => chunks.push(c))
      duplex.on('end', () => resolve(Buffer.concat(chunks)))
      duplex.on('close', () => resolve(Buffer.concat(chunks)))
    })
    duplex.write('req') // write side keep open start: response complete back pass after again closure
    const echoed = await Promise.race([got, delay(15_000).then(() => Buffer.alloc(0))])
    assert.equal(echoed.length, response.length, 'complete response flush back reach (tail part do not lose)')
    assert.ok(echoed.equals(response), 'response content consistent')
    duplex.destroy()
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('any TCP: cancel (abort) in create connect phase explicit failed and clean up', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'abort-node' && token === 'abort-node:secret', 'abort-node')
  try {
    assert.equal(hub.ready, true)
    // immediately abort: explicit 499 aborted.
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: echo.port }, controller.signal),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'aborted',
    )
    // target validate: illegal port explicit validation_error.
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: 0 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { host: 'bad host', port: 80 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    assert.deepEqual(hub.fabric.registry.debugTunnelCounts(), { pending: 0, active: 0 }, 'no residue register')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('any TCP:daemon after disconnect duplex destroy (consumer aware disconnect)', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'disc-node' && token === 'disc-node:secret', 'disc-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('disc-node', { port: echo.port })
    // disconnect destroy with error drive (node_offline): listen error guard against unhandled.
    duplex.on('error', () => undefined)
    const closed = new Promise<void>((resolve) => duplex.once('close', resolve))
    // disconnect daemon → evict → active duplex destroy(consumer aware disconnect, do not pending).
    await hub.disconnectDaemon()
    await Promise.race([closed, delay(10_000)])
    assert.equal(duplex.destroyed, true, 'daemon after disconnect duplex already destroy')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('nodeFetch HTTPS: local TLS fixture on via tunnel complete real TLS request (two phase child process inject trust chain)', { timeout: 120_000 }, async () => {
  const fixture = new URL('./fixtures/tunnel-https-fixture.mts', import.meta.url).pathname
  const runFixture = (args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject)
      child.on('close', () => resolve({ stdout, stderr }))
    })
  // phase 1: generate test CA and service certificate.
  const caPhase = await runFixture(['ca'], {})
  const paths = JSON.parse(caPhase.stdout.trim().split('\n').pop() ?? '{}') as {
    caCert?: string; key?: string; cert?: string; error?: string
  }
  assert.ok(paths.caCert !== undefined && paths.key !== undefined && paths.cert !== undefined, `CA generate failed:${paths.error ?? caPhase.stderr}`)
  // phase 2:NODE_EXTRA_CA_CERTS follow process start inject (Node only at startup read),
  // client certificate validate away by default trust chain + test CA, never fabricate skip validate.
  const reqPhase = await runFixture(['request'], {
    NODE_EXTRA_CA_CERTS: paths.caCert,
    HELM_TUNNEL_TLS_KEY: paths.key,
    HELM_TUNNEL_TLS_CERT: paths.cert,
  })
  let result: { ok?: boolean; status?: number; body?: string; error?: string }
  try {
    result = JSON.parse(reqPhase.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    result = { ok: false, error: reqPhase.stderr || reqPhase.stdout || 'fixture without output' }
  }
  assert.equal(result.ok, true, `HTTPS tunnel fixture failed:${result.error ?? ''} status=${result.status ?? ''} body=${result.body ?? ''}`)
  assert.equal(result.status, 200)
  assert.equal(result.body, 'https-echo:GET:/v1/x?k=v')
  // clean up certificate directory.
  rmSync(join(paths.caCert!, '..'), { recursive: true, force: true })
})

test('nodeFetch HTTP: any host(non- loopback hostname form)+ HEAD/204 body null', { timeout: 60_000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
    if (req.url === '/nocontent') { res.writeHead(204); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`http-echo:${req.method}:${req.url}`)
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const port = (server.address() as net.AddressInfo).port
  const hub = await startHub((id, token) => id === 'host-node' && token === 'host-node:secret', 'host-node')
  try {
    assert.equal(hub.ready, true)
    const fetchRemote = hub.fabric.nodeFetch('host-node')
    // hostname use localhost(non- bare IP): verify host pass-through and domain parse in node side complete.
    const response = await fetchRemote(`http://localhost:${port}/v1/y`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'http-echo:GET:/v1/y')
    const head = await fetchRemote(`http://localhost:${port}/v1/y`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, null, 'HEAD body is null')
    const noContent = await fetchRemote(`http://localhost:${port}/nocontent`)
    assert.equal(noContent.status, 204)
    assert.equal(noContent.body, null, '204 body is null')
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
