/**
 * Abandoned tunnelFetch Response body reclamation tests (env/node-fetch.ts tunnelFetch Response
 * body lifecycle):
 * - Transport interruption (after response headers arrive, connection is destroyed) with unconsumed body:
 *   res close/error fallback deterministically destroys the tunnel (without waiting for GC or pull/cancel);
 * - Complete response + server connection close (Connection: close happy path) with unconsumed body:
 *   connection close immediately destroys the tunnel;
 * - Upstream never closes connection (keep-alive ignoring Connection: close) and body is abandoned:
 *   FinalizationRegistry destroys the tunnel on GC (best-effort; see implementation notes);
 * - Normal consumption / explicit cancel semantics remain unchanged; reading after interruption yields an
 *   explicit error.
 *
 * Uses local direct tunnels (connectLocalTunnel) without needing a remote daemon.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { tunnelFetch, connectLocalTunnel } from '../src/env/node-fetch.js'

/** Triggers a full GC cycle (standard workaround when the child process lacks --expose-gc). */
function forceGc(): void {
  v8.setFlagsFromString('--expose_gc')
  vm.runInNewContext('gc')()
}

/** Records the most recently opened tunnel (the duplex handed to tunnelFetch). */
function recordingOpenTunnel(): { open: (t: { host?: string; port: number }, signal?: AbortSignal) => Promise<Duplex>; last(): Duplex | undefined } {
  let lastTunnel: Duplex | undefined
  return {
    open: async (target, signal) => {
      lastTunnel = await connectLocalTunnel(target.host ?? '127.0.0.1', target.port, signal)
      return lastTunnel
    },
    last: () => lastTunnel,
  }
}

/** Polls until the tunnel is destroyed (2s budget for deterministic paths; returns false on timeout). */
async function waitDestroyed(tunnel: Duplex | undefined, budgetMs = 2_000): Promise<boolean> {
  for (let i = 0; i < budgetMs / 25 && tunnel !== undefined; i += 1) {
    if (tunnel.destroyed) return true
    await delay(25)
  }
  return tunnel?.destroyed ?? false
}

describe('tunnelFetch abandoned body reclamation', { timeout: 60_000 }, () => {
  test('transport interruption + unconsumed body: res close deterministically destroys tunnel', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      // Destroy connection after response headers arrive (simulating transport interruption).
      setTimeout(() => res.destroy(), 50)
    })
    server.on('clientError', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/x`))
      assert.equal(response.status, 200)
      // Inspect only status without reading or canceling -- tunnel must destroy immediately after abort.
      assert.ok(await waitDestroyed(tunnels.last()), 'tunnel must deterministically destroy after transport interruption')
      // Late read after interruption must fail explicitly (never silently synthesize a complete body).
      await assert.rejects(response.text())
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('complete response + server closes connection + unconsumed body: connection close destroys tunnel', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/y`))
      assert.equal(response.status, 200)
      assert.ok(await waitDestroyed(tunnels.last()), 'tunnel must destroy after server closes connection')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('upstream never disconnects + GCed body: FinalizationRegistry destroys tunnel', { timeout: 60_000 }, async () => {
    // Raw TCP write of HTTP response with Connection: keep-alive, keeping socket open indefinitely.
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined)
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      {
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/health`))
        assert.equal(response.status, 200)
        assert.equal(tunnels.last()?.destroyed, false, 'tunnel must stay open while connection is open (e.g. for SSE streams)')
        // Abandon response out of scope (only status inspected).
      }
      let destroyed = false
      for (let i = 0; i < 20 && !destroyed; i += 1) {
        await delay(50)
        forceGc()
        destroyed = tunnels.last()?.destroyed ?? false
      }
      assert.ok(destroyed, 'tunnel must destroy via FinalizationRegistry once abandoned body is GCed')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('normal consumption and explicit cancellation semantics remain unchanged', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('full-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      // Full consumption: body completes normally and tunnel destroys once drained.
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/a`))
        assert.equal(await response.text(), 'full-body')
        assert.ok(await waitDestroyed(tunnels.last()), 'tunnel destroys after body is fully read')
      }
      // Explicit cancellation: immediately destroys (existing semantics).
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/b`))
        await response.body?.cancel()
        assert.ok(await waitDestroyed(tunnels.last()), 'tunnel destroys after explicit cancel')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
