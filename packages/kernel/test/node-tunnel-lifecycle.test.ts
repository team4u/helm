import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { once } from 'node:events'
import { createEnvFabric } from '../src/env/fabric.js'
import { tunnelFetch } from '../src/env/node-fetch.js'

test('local 隧道：dispose 关闭活动及在途连接，关停后拒绝新隧道', { timeout: 60_000 }, async (t) => {
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

test('TLS 握手取消：销毁底层隧道并立即返回 aborted', { timeout: 60_000 }, async (t) => {
  const sockets = new Set<net.Socket>()
  // 接受 TCP 但不回复 TLS ClientHello，令握手保持在途。
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
    // 调用方拿到 TCP 后，在 TLS 握手期间取消请求。
    setImmediate(() => controller.abort())
    return duplex
  }, 'local', new Request(`https://127.0.0.1:${port}/`, { signal: controller.signal }))
  await assert.rejects(response, { code: 'aborted' })
})
