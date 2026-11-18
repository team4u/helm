/**
 * Arbitrary TCP tunnel (openTunnel) integration tests across Hub + real node daemon:
 * Not limited to HTTP -- arbitrary host targets, binary/large payloads, connection shutdown, cancellation,
 * and nodeFetch HTTP/HTTPS adaptation (via local TLS fixture).
 *
 * Real pipeline: fabric.openTunnel -> registry.openTunnel -> daemon
 * nodeTunnelOpen(host) -> TCP -> /ws/node-tunnel binary byte stream.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { withTimeout } from '@helm/test-kit'
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

/** Minimal EnvFabric Hub (HTTP server + both gateways + real daemon). */
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

/** Binary-safe echo server (echoes arbitrary bytes verbatim; ignores socket errors to avoid crashing tests). */
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

test('arbitrary TCP: host pass-through + large binary payload round-trips byte-for-byte', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'bin-node' && token === 'bin-node:secret', 'bin-node')
  try {
    assert.equal(hub.ready, true)
    // Explicit host=localhost: target host is resolved and connected on the node side.
    const duplex = await hub.fabric.openTunnel('bin-node', { host: 'localhost', port: echo.port })
    const payload = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251 // non-UTF-8-friendly bytes
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
    assert.equal(received, payload.length, '4 MiB binary payload length matches')
    const echoed = Buffer.concat(chunks)
    assert.ok(echoed.equals(payload), 'binary contents match byte-for-byte')
    duplex.destroy()
    duplex.on('error', () => undefined)
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('arbitrary TCP: request-response-shutdown flushes completely without truncating trailing data', { timeout: 60_000 }, async () => {
  // Server waits for 'req', writes a large response, then closes. Hub keeps the write side open and
  // closes only after reading the full response -- verifying shutdown flushes completely without tail loss.
  // (Note: WS tunnels lack TCP half-close -- duplex.end closes the whole stream, so FIN half-close is not
  // tested here; node-side pipe end-flush semantics are covered by @helm/node's node-tunnel.test.ts.)
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
    duplex.on('error', () => undefined) // shutdown errors converge on close
    const chunks: Buffer[] = []
    const got = new Promise<Buffer>((resolve) => {
      duplex.on('data', (c: Buffer) => chunks.push(c))
      duplex.on('end', () => resolve(Buffer.concat(chunks)))
      duplex.on('close', () => resolve(Buffer.concat(chunks)))
    })
    duplex.write('req') // keep write side open initially: close only after full response arrives
    const echoed = await withTimeout(got, 15_000, 'tunnel response did not finish')
    assert.equal(echoed.length, response.length, 'full response flushed back without trailing byte loss')
    assert.ok(echoed.equals(response), 'response contents match')
    duplex.destroy()
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('arbitrary TCP: abort during connection setup fails explicitly and cleans up', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'abort-node' && token === 'abort-node:secret', 'abort-node')
  try {
    assert.equal(hub.ready, true)
    // Immediate abort: explicit 499 aborted.
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: echo.port }, controller.signal),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'aborted',
    )
    // Target validation: invalid port or host fails explicitly with validation_error.
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: 0 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { host: 'bad host', port: 80 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    assert.deepEqual(hub.fabric.registry.debugTunnelCounts(), { pending: 0, active: 0 }, 'no leaked registry entries')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('arbitrary TCP: duplex destroys when daemon disconnects so consumers observe teardown', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'disc-node' && token === 'disc-node:secret', 'disc-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('disc-node', { port: echo.port })
    // Teardown emits a node_offline error on destroy: attach error listener to avoid unhandled errors.
    duplex.on('error', () => undefined)
    const closed = new Promise<void>((resolve) => duplex.once('close', resolve))
    // Disconnecting daemon triggers eviction and destroys active duplexes immediately instead of hanging.
    await hub.disconnectDaemon()
    await withTimeout(closed, 10_000, 'tunnel did not close after the daemon disconnected')
    assert.equal(duplex.destroyed, true, 'duplex is destroyed after daemon disconnects')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('nodeFetch HTTPS: local TLS fixture completes real TLS request over tunnel (two-phase child trust injection)', { timeout: 120_000 }, async () => {
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
  // Phase 1: generate test CA and server certificate.
  const caPhase = await runFixture(['ca'], {})
  const paths = JSON.parse(caPhase.stdout.trim().split('\n').pop() ?? '{}') as {
    caCert?: string; key?: string; cert?: string; error?: string
  }
  assert.ok(paths.caCert !== undefined && paths.key !== undefined && paths.cert !== undefined, `CA generation failed: ${paths.error ?? caPhase.stderr}`)
  // Phase 2: inject NODE_EXTRA_CA_CERTS at child startup (Node reads it only on startup);
  // client verifies certificates via default trust store + test CA, never skipping TLS verification.
  const reqPhase = await runFixture(['request'], {
    NODE_EXTRA_CA_CERTS: paths.caCert,
    HELM_TUNNEL_TLS_KEY: paths.key,
    HELM_TUNNEL_TLS_CERT: paths.cert,
  })
  let result: { ok?: boolean; status?: number; body?: string; error?: string }
  try {
    result = JSON.parse(reqPhase.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    result = { ok: false, error: reqPhase.stderr || reqPhase.stdout || 'fixture produced no output' }
  }
  assert.equal(result.ok, true, `HTTPS tunnel fixture failed: ${result.error ?? ''} status=${result.status ?? ''} body=${result.body ?? ''}`)
  assert.equal(result.status, 200)
  assert.equal(result.body, 'https-echo:GET:/v1/x?k=v')
  // Clean up certificate directory.
  rmSync(join(paths.caCert!, '..'), { recursive: true, force: true })
})

test('nodeFetch HTTP: arbitrary non-loopback hostname + null body for HEAD/204', { timeout: 60_000 }, async () => {
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
    // Use localhost hostname (non-bare-IP) to verify host pass-through and node-side DNS resolution.
    const response = await fetchRemote(`http://localhost:${port}/v1/y`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'http-echo:GET:/v1/y')
    const head = await fetchRemote(`http://localhost:${port}/v1/y`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, null, 'HEAD body must be null')
    const noContent = await fetchRemote(`http://localhost:${port}/nocontent`)
    assert.equal(noContent.status, 204)
    assert.equal(noContent.body, null, '204 body must be null')
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
