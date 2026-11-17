import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { once } from 'node:events'
import { createEnvFabric } from '../src/env/fabric.js'
import { tunnelFetch } from '../src/env/node-fetch.js'

test('local tunnel: dispose closes active and in-flight connections and rejects new tunnels once closed', { timeout: 60_000 }, async (t) => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const fabric = createEnvFabric({})
  const duplex = await fabric.openTunnel('local', { port })
  const closed = once(duplex, 'close')
  await fabric.dispose()
  await closed
  assert.equal(duplex.destroyed, true)
  await assert.rejects(fabric.openTunnel('local', { port }), { code: 'node_offline' })

  const openingFabric = createEnvFabric({})
  const opening = openingFabric.openTunnel('local', { port })
  const rejected = assert.rejects(opening, { code: 'aborted' })
  await openingFabric.dispose()
  await rejected
})

test('TLS handshake cancellation destroys underlying tunnel and returns aborted immediately', { timeout: 60_000 }, async (t) => {
  const sockets = new Set<net.Socket>()
  // Accept TCP without returning a TLS ServerHello so the handshake stays in-flight.
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    socket.resume()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  const fabric = createEnvFabric({})
  t.after(async () => {
    await fabric.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const controller = new AbortController()
  const response = tunnelFetch(async (target, signal) => {
    const duplex = await fabric.openTunnel('local', target, signal)
    duplex.once('data', () => undefined)
    // Abort request during the TLS handshake after acquiring the TCP stream.
    setImmediate(() => controller.abort())
    return duplex
  }, 'local', new Request(`https://127.0.0.1:${port}/`, { signal: controller.signal }))
  await assert.rejects(response, { code: 'aborted' })
})
