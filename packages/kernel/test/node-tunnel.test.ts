/**
 * 节点透传隧道（Hub/协议侧）单测：
 * - registry.openTunnel：节点离线 409 / 未实现 nodeTunnelOpen 501 / pending
 *   tunnelId 一次性消费（重复 accept 拒绝）/ signal abort 清理 pending；
 * - 节点断连（evict）时 pending 隧道被拒绝（409 node_offline），不悬挂；
 * - acceptTunnel 身份不匹配（nodeId/token/未知 tunnelId）拒绝；
 * - fabric.nodeFetch 端口 URL 校验：非 http、非 loopback、无显式端口显式
 *   拒绝（HelmError node_tunnel_connect_failed）；local 直通 globalThis.fetch；
 * - attachNodeTunnelGateway：首帧非 JSON / 非 hello 回 error 帧后关闭；
 *   合法 hello 但 tunnelId 未知时先 ok 帧再关闭（registry 拒绝路径）。
 * 本分支不要求真实 @helm/node daemon 侧隧道实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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

type TunnelOpenFn = (input: { tunnelId: string; port: number }) =>
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
      registry.openTunnel('ghost', 8080),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline' && error.status === 409,
    )
    const socket = await registerFakeNode(registry, 'node-a')
    await assert.rejects(
      registry.openTunnel('node-a', 8080),
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
    const socket = await registerFakeNode(registry, 'node-b', async (input) => {
      tunnelId = input.tunnelId
      return { ok: true, value: null }
    })
    const pending = registry.openTunnel('node-b', 9000)
    await delay(20)
    assert.equal(tunnelId.length > 0, true)
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
    const pending = registry.openTunnel('node-c', 9100)
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
    const pending = registry.openTunnel('node-d', 9200, controller.signal)
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

test('nodeFetch 端口 URL 校验：远端仅 http + loopback + 显式端口；local 直通', { timeout: 60_000 }, async () => {
  let fabric: EnvFabric | undefined
  try {
    fabric = createEnvFabric({ authenticate: () => true })
    const fetchRemote = fabric.nodeFetch('node-e')
    await assert.rejects(
      fetchRemote('https://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
    )
    await assert.rejects(
      fetchRemote('http://example.com:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
    )
    await assert.rejects(
      fetchRemote('http://127.0.0.1:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    // URL 归一：无显式端口（含 :80 被归一）显式拒绝。
    await assert.rejects(
      fetchRemote('http://127.0.0.1/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
    )
    // 显式 :80 放行到建连阶段（此处节点离线报 409）。
    await assert.rejects(
      fetchRemote('http://127.0.0.1:80/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    // IPv6 loopback 首版显式拒绝（daemon 固定 IPv4，不静默重解释目标）。
    await assert.rejects(
      fetchRemote('http://[::1]:8080/x'),
      (error: unknown) => error instanceof HelmError && error.code === 'node_tunnel_connect_failed',
    )
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
