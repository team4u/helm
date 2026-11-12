/**
 * 节点透传隧道（Hub/协议侧）单测：
 * - registry.openTunnel：节点离线 409 / 未实现 nodeTunnelOpen 501 / pending
 *   tunnelId 一次性消费（重复 accept 拒绝）/ signal abort 清理 pending /
 *   目标 host 透传（含 host 校验）；
 * - 节点断连（evict）时 pending 隧道被拒绝（409 node_offline），不悬挂；
 * - acceptTunnel 身份不匹配（nodeId/token/未知 tunnelId）拒绝；
 * - fabric.nodeFetch 端口：非 http(s) 拒绝、任意 host 放行到建连阶段；
 *   local 直通 globalThis.fetch；fabric.openTunnel local 直连；
 * - attachNodeTunnelGateway：首帧非 JSON / 非 hello 回 error 帧后关闭；
 *   合法 hello 但 tunnelId 未知时直接拒绝（registry 拒绝路径）。
 * 真实 daemon 的端到端字节透传见 env-fabric.test.ts（任意 TCP 测试）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import type { WebSocket as WsSocket } from 'ws'
import { HelmError } from '@helm/protocol'
import { NodeRegistry } from '../src/env/registry.js'
import { attachNodeTunnelGateway } from '../src/env/ws-tunnel-gateway.js'
import { createEnvFabric, type EnvFabric } from '../src/env/fabric.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

type TunnelOpenFn = (input: { tunnelId: string; host?: string; port: number }) =>
  Promise<{ ok: true; value: null } | { ok: false; error: { code: string; message: string } }>

/** 注册假节点（鉴权恒过 / token 形如 `<nodeId>:secret`），可带 nodeTunnelOpen。 */
async function registerFakeNode(registry: NodeRegistry, nodeId: string, nodeTunnelOpen?: TunnelOpenFn): Promise<FakeSocket> {
  const socket = new FakeSocket()
  const rpc: Record<string, unknown> = {
    $close() {},
    ...(nodeTunnelOpen !== undefined ? { nodeTunnelOpen } : {}),
  }
  const outcome = await registry.register(
    socket as unknown as WsSocket,
    { nodeId, token: `${nodeId}:secret`, hostname: 'h', platform: 'linux' },
    () => rpc as never,
  )
  assert.equal(outcome.accepted, true)
  return socket
}

const tunnelOk: TunnelOpenFn = () => Promise.resolve({ ok: true, value: null })

test('openTunnel：离线节点 409、未实现 nodeTunnelOpen 501', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    await assert.rejects(
      registry.openTunnel('ghost', { port: 8080 }),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline' && error.status === 409,
    )
    const socket = await registerFakeNode(registry, 'node-a')
    await assert.rejects(
      registry.openTunnel('node-a', { port: 8080 }),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_not_supported' && error.status === 501,
    )
    socket.close()
  } finally {
    await registry.close()
  }
})

test('openTunnel + acceptTunnel：一次性消费与身份校验', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: (id, token) => token === `${id}:secret` })
  try {
    let tunnelId = ''
    let openedHost: string | undefined
    const socket = await registerFakeNode(registry, 'node-b', async (input) => {
      tunnelId = input.tunnelId
      openedHost = input.host
      return { ok: true, value: null }
    })
    const pending = registry.openTunnel('node-b', { port: 9000, host: 'db.internal' })
    await delay(20)
    assert.equal(tunnelId.length > 0, true)
    assert.equal(openedHost, 'db.internal', '目标 host 原样透传到节点（节点负责解析）')
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    // token 错误 → 拒绝，pending 保留。
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:wrong', tunnelId), false)
    // nodeId 不匹配 → 拒绝。
    assert.equal(await registry.acceptTunnel('other', 'other:secret', tunnelId), false)
    // 正确消费 → acceptTunnel true + grantTunnel 交棒 Duplex，登记转 active。
    assert.equal(await registry.acceptTunnel('node-b', 'node-b:secret', tunnelId), true)
    const granted = new PassThrough()
    registry.grantTunnel(tunnelId, granted)
    const duplex = await pending
    assert.equal(duplex, granted)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 1 })
    // 同一 tunnelId 二次消费 → 拒绝。
    assert.equal(await registry.acceptTunnel("node-b", "node-b:secret", tunnelId), false)
    // duplex 关闭后登记摘除。
    duplex.destroy()
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('节点断连清理 pending 隧道（409 拒绝，不悬挂）', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-c', tunnelOk)
    const pending = registry.openTunnel('node-c', { port: 9100 })
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    socket.close() // 触发 evict：pending 必须被拒绝。
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline' && error.status === 409,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
  } finally {
    await registry.close()
  }
})

test('openTunnel：signal abort 清理 pending（499 aborted）', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(registry, 'node-d', tunnelOk)
    const controller = new AbortController()
    const pending = registry.openTunnel('node-d', { port: 9200 }, controller.signal)
    await delay(20)
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 1, active: 0 })
    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof HelmError && error.code === 'aborted' && error.status === 499,
    )
    assert.deepEqual(registry.debugTunnelCounts(), { pending: 0, active: 0 })
    socket.close()
  } finally {
    await registry.close()
  }
})

test('nodeFetch 端口：非 http(s) 拒绝、任意 host 放行；openTunnel 目标校验；local 直通', { timeout: 60_000 }, async () => {
  let fabric: EnvFabric | undefined
  try {
    fabric = createEnvFabric({ authenticate: () => true })
    const fetchRemote = fabric.nodeFetch('node-e')
    await assert.rejects(
      fetchRemote('ftp://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
    )
    // 任意 host（非 loopback）放行到建连阶段：节点离线时 409（不再拒绝非 loopback）。
    await assert.rejects(
      fetchRemote('http://example.com:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('http://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    // 默认端口（80/443）放行到建连阶段（适配层按协议补默认端口，不再要求显式）。
    await assert.rejects(
      fetchRemote('http://127.0.0.1/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    await assert.rejects(
      fetchRemote('https://example.com/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    // openTunnel 目标校验：非法 port / 非法 host 显式 400 validation_error。
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 0 }),
      (error: unknown) => error instanceof HelmError && error.code === 'validation_error' && error.status === 400,
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { port: 70000 }),
      (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'bad host\n', port: 80 }),
      (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: '', port: 80 }),
      (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
    )
    await assert.rejects(
      fabric.openTunnel('node-e', { host: 'a'.repeat(256), port: 80 }),
      (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
    )
    // local openTunnel：进程内直连（echo 服务真实回显）。
    const echo = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as net.AddressInfo).port
    try {
      const duplex = await fabric.openTunnel('local', { host: '127.0.0.1', port: echoPort })
      const echoed = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        duplex.on('data', (c: Buffer) => chunks.push(c))
        duplex.once('error', reject)
        duplex.write('ping-local')
        const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString()), 5_000)
        duplex.on('data', () => {
          const text = Buffer.concat(chunks).toString()
          if (text.includes('ping-local')) { clearTimeout(timer); resolve(text) }
        })
      })
      assert.ok(echoed.includes('ping-local'), 'local openTunnel 字节往返')
      duplex.destroy()
      // local openTunnel：端口拒绝显式失败（不静默伪造）。
      await assert.rejects(
        fabric.openTunnel('local', { port: 1 }),
        (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
      )
      // local openTunnel：abort 显式 499。
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        fabric.openTunnel('local', { port: echoPort }, controller.signal),
        (error: unknown) => error instanceof HelmError && error.code === 'aborted',
      )
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
    assert.equal(fabric.nodeFetch('local'), globalThis.fetch)
  } finally {
    await fabric?.dispose()
  }
})

test('tunnel 网关：首帧非 JSON / 非 hello 回 error 帧；未知 tunnelId 直接拒绝', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const gateway = attachNodeTunnelGateway(server, { registry })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const url = `ws://127.0.0.1:${address.port}/ws/node-tunnel`

    // 非 JSON 与非 hello：error 帧 + 关闭。
    for (const frame of ['not-json', JSON.stringify({ type: 'other' })]) {
      const ws = new WebSocket(url)
      const frames: string[] = []
      await new Promise<void>((resolve) => {
        ws.on('open', () => { ws.send(frame) })
        ws.on('message', (raw) => { frames.push(raw.toString()) })
        ws.on('close', () => resolve())
      })
      const parsed = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
      assert.equal(parsed.type, 'error')
      assert.equal(parsed.code, 'invalid')
    }

    // 合法 hello 但 tunnelId 未知：认证/匹配失败 → 直接 error 帧 + 关闭
    //（ok 帧绝不早于认证；此路径不进入数据期）。
    const ws = new WebSocket(url)
    const frames: string[] = []
    await new Promise<void>((resolve) => {
      ws.on('open', () => { ws.send(JSON.stringify({ tunnelId: 'missing', nodeId: 'node-x', token: 'node-x:secret' })) })
      ws.on('message', (raw) => { frames.push(raw.toString()) })
      ws.on('close', () => resolve())
    })
    assert.equal(frames.length, 1)
    const rejected = JSON.parse(frames[0] ?? '{}') as { type?: string; code?: string }
    assert.equal(rejected.type, 'error')
    assert.equal(rejected.code, 'permission_denied')
  } finally {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await registry.close()
  }
})
