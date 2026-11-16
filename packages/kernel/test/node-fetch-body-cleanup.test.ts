/**
 * node-fetch tunnel abandon placement fall back test (env/node-fetch.ts tunnelFetch  Response
 * body lifecycle):
 * - transfer interrupt (response head already to, connect by destroy) and body without person read:res close/error
 *   fall back must determinism destroy tunnel (do not etc. GC, do not etc. forever do not occur pull/cancel);
 * - complete response + server close connect (Connection: close happy path) and body without person
 *   read: connect close i.e. destroy tunnel;
 * - upstream connect forever do not disconnect (keep-alive ignore Connection: close) and body by abandon placement:
 *   FinalizationRegistry in GC when destroy (best-effort, see implement note release);
 * - normal consume / explicit cancel semantics do not change; interrupt after late to read obtain to explicit error.
 *
 * all away local direct connect tunnel (connectLocalTunnel), no need to remote daemon.
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

/** force all amount GC(child process not open --expose-gc when standard workaround). */
function forceGc(): void {
  v8.setFlagsFromString('--expose_gc')
  vm.runInNewContext('gc')()
}

/** record most near a tunnel openTunnel(tunnelFetch tunnel is exactly the duplex). */
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

/** polling wait for tunnel by destroy (determinism path pre- compute 2s; failed return false). */
async function waitDestroyed(tunnel: Duplex | undefined, budgetMs = 2_000): Promise<boolean> {
  for (let i = 0; i < budgetMs / 25 && tunnel !== undefined; i += 1) {
    if (tunnel.destroyed) return true
    await delay(25)
  }
  return tunnel?.destroyed ?? false
}

describe('tunnelFetch abandon placement body fall back', { timeout: 60_000 }, () => {
  test('transfer interrupt + body without person read:res close fall back determinism destroy tunnel', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      // response head send reach after destroy connect (simulated transfer interrupt).
      setTimeout(() => res.destroy(), 50)
    })
    server.on('clientError', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/x`))
      assert.equal(response.status, 200)
      // only inspect status, do not read do not cancel- - tunnel must in interrupt after immediately destroy.
      assert.ok(await waitDestroyed(tunnels.last()), 'transfer interrupt after tunnel must determinism destroy')
      // interrupt after late to read obtain to explicit error (not silently fabricate complete body).
      await assert.rejects(response.text())
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('complete response + server closure connect + body without person read: connect close i.e. destroy tunnel', { timeout: 60_000 }, async () => {
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
      assert.ok(await waitDestroyed(tunnels.last()), 'server close after tunnel must destroy')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('upstream connect forever do not disconnect + body by GC:FinalizationRegistry destroy tunnel', { timeout: 60_000 }, async () => {
    // raw TCP manually write HTTP response:Connection: keep-alive and forever do not closure socket.
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
        assert.equal(tunnels.last()?.destroyed, false, 'connect not on shutdown tunnel still store (SSE etc. scenario must not mistakenly kill)')
        // response out effect domain i.e. abandon placement (only inspect status).
      }
      let destroyed = false
      for (let i = 0; i < 20 && !destroyed; i += 1) {
        await delay(50)
        forceGc()
        destroyed = tunnels.last()?.destroyed ?? false
      }
      assert.ok(destroyed, 'abandon placement body by GC after tunnel must destroy (FinalizationRegistry fall back)')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('normal consume and explicit cancel semantics do not change', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('full-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      // complete consume:body normal send reach, read exhaust after tunnel destroy.
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/a`))
        assert.equal(await response.text(), 'full-body')
        assert.ok(await waitDestroyed(tunnels.last()), 'read exhaust after tunnel destroy')
      }
      // explicit cancel: immediately destroy (since has semantics).
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/b`))
        await response.body?.cancel()
        assert.ok(await waitDestroyed(tunnels.last()), 'cancel after tunnel destroy')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
