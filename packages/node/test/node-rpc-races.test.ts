import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js'

test('节点不会继承宿主的大小写变体 Helm_Token', { timeout: 60_000 }, async () => {
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

test('Reader 打开与 dispose 并发时不遗留新句柄', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-reader-race-'))
  try {
    await writeFile(join(dir, 'file.txt'), 'content')
    for (let index = 0; index < 20; index++) {
      const server = createNodeEnvRpcServer({ defaultCwd: dir })
      const pending = server.envOpenBinaryReader({ path: 'file.txt' })
      const firstClose = server.dispose()
      assert.equal(server.dispose(), firstClose, '关闭操作应返回同一排空承诺')
      await firstClose
      await pending
      assert.equal(server.getOpenReaderCount(), 0)
      const late = await server.envOpenBinaryReader({ path: 'file.txt' })
      assert.equal(late.ok, false)
      if (!late.ok) assert.equal(late.error.code, 'aborted')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('已确认的 IPC 订阅断开时恰好发送一次关闭通知', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-ipc-close-'))
  const endpoint = join(dir, 'close.sock')
  let peer: net.Socket | undefined
  const ipc = net.createServer((socket) => {
    peer = socket
    socket.on('error', () => undefined)
    socket.once('data', () => socket.write('{"result":{"type":"subscription_started"}}\n'))
  })
  const notices: unknown[] = []
  let closed: (() => void) | undefined
  const notification = new Promise<void>((resolve) => { closed = resolve })
  const rpc = createNodeEnvRpcServer({ defaultCwd: dir, onIpcClosed: (event) => { notices.push(event); closed?.() } })
  try {
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(endpoint, resolve) })
    assert.equal((await rpc.ipcSubscribe!({ endpoint, subscribeId: 's1', line: '{}' })).ok, true)
    peer!.end()
    await notification
    assert.deepEqual(notices, [{ subscribeId: 's1' }])
    assert.equal(rpc.getActiveIpcSubscriptionCount(), 0)
  } finally {
    await rpc.dispose()
    peer?.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('未带 callId 的 IPC 与 ACK 前订阅也归属连接代清理', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-ipc-race-'))
  const endpoint = join(dir, 'pending.sock')
  const sockets = new Set<net.Socket>()
  let connected: (() => void) | undefined
  const bothConnected = new Promise<void>((resolve) => { connected = resolve })
  const ipc = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    if (sockets.size === 2) connected?.()
  })
  const rpc = createNodeEnvRpcServer({ defaultCwd: dir })
  try {
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(endpoint, resolve) })
    const call = rpc.ipcCall!({ endpoint, line: '{}' })
    const subscription = rpc.ipcSubscribe!({ endpoint, subscribeId: 'pending-ack', line: '{}' })
    await bothConnected
    await rpc.dispose()
    assert.equal((await call).ok, false)
    assert.equal((await subscription).ok, false)
    assert.equal(rpc.getActiveIpcSubscriptionCount(), 0)
    assert.equal(rpc.getActiveIpcCallCount(), 0)
  } finally {
    await rpc.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
