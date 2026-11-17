import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@helm/test-kit'
import { useTempDir } from '@helm/test-kit/node'
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js'

test('node does not inherit case-variant Helm_Token from host environment', { timeout: 60_000 }, async () => {
  const previous = process.env.Helm_Token
  process.env.Helm_Token = 'mixed-case-host-credential'
  let output = ''
  const rpc = createNodeEnvRpcServer({ defaultCwd: process.cwd(), onExecOutput: (event) => { output += event.text } })
  try {
    const result = await rpc.envExec({ execId: 'mixed-token', command: [process.execPath, '-e', 'process.stdout.write(process.env.Helm_Token ?? "absent")'] })
    assert.equal(result.ok, true)
    assert.equal(output, 'absent')
  } finally {
    if (previous === undefined) delete process.env.Helm_Token
    else process.env.Helm_Token = previous
    await rpc.dispose()
  }
})

test('opening a binary reader concurrently with dispose leaks no handles', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-reader-race-')
  await writeFile(join(dir, 'file.txt'), 'content')
  for (let index = 0; index < 20; index++) {
    const server = createNodeEnvRpcServer({ defaultCwd: dir })
    const pending = server.envOpenBinaryReader({ path: 'file.txt' })
    const firstClose = server.dispose()
    assert.equal(server.dispose(), firstClose, 'dispose should return the same draining promise')
    await firstClose
    await pending
    assert.equal(server.getOpenReaderCount(), 0)
    const late = await server.envOpenBinaryReader({ path: 'file.txt' })
    assert.equal(late.ok, false)
    if (!late.ok) assert.equal(late.error.code, 'aborted')
  }
})

test('confirmed IPC subscription sends exactly one closed notification on disconnect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ipc-close-')
  const endpoint = join(dir, 'close.sock')
  let peer: net.Socket | undefined
  const ipc = net.createServer((socket) => {
    peer = socket
    socket.on('error', () => undefined)
    socket.once('data', () => socket.write('{"result":{"type":"subscription_started"}}\n'))
  })
  const notices: unknown[] = []
  const notification = deferred()
  const rpc = createNodeEnvRpcServer({ defaultCwd: dir, onIpcClosed: (event) => { notices.push(event); notification.resolve() } })
  try {
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(endpoint, resolve) })
    assert.equal((await rpc.ipcSubscribe!({ endpoint, subscribeId: 's1', line: '{}' })).ok, true)
    peer!.end()
    await notification.promise
    assert.deepEqual(notices, [{ subscribeId: 's1' }])
    assert.equal(rpc.getActiveIpcSubscriptionCount(), 0)
  } finally {
    await rpc.dispose()
    peer?.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
  }
})

test('uncorrelated IPC calls and pre-ACK subscriptions still clean up owned connections', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ipc-race-')
  const endpoint = join(dir, 'pending.sock')
  const sockets = new Set<net.Socket>()
  const bothConnected = deferred()
  const ipc = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    if (sockets.size === 2) bothConnected.resolve()
  })
  const rpc = createNodeEnvRpcServer({ defaultCwd: dir })
  try {
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(endpoint, resolve) })
    const call = rpc.ipcCall!({ endpoint, line: '{}' })
    const subscription = rpc.ipcSubscribe!({ endpoint, subscribeId: 'pending-ack', line: '{}' })
    await bothConnected.promise
    await rpc.dispose()
    assert.equal((await call).ok, false)
    assert.equal((await subscription).ok, false)
    assert.equal(rpc.getActiveIpcSubscriptionCount(), 0)
    assert.equal(rpc.getActiveIpcCallCount(), 0)
  } finally {
    await rpc.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
  }
})
