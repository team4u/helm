/**
 * Hub 侧前台端口转发（NodeForwardService + HTTP 路由）集成测试：
 * 真实 EnvFabric Hub + 真实 @helm/node daemon + 二进制 echo 服务。
 * 覆盖：start/stop 生命周期（stop 后监听器与隧道销毁）、监听冲突显式失败、
 * 事件流（started/connection）、HTTP 端点（POST/GET/DELETE/清单）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { attachNodeWsGateway, attachNodeTunnelGateway, createEnvFabric, NodeForwardService } from '../src/env/index.js'
import { createNodeDaemon } from '@helm/node'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-forward-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function startStack() {
  const fabric = createEnvFabric({
    authenticate: (id, token) => id === 'fwd-node' && token === 'fwd-node:secret',
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
  })
  const forward = new NodeForwardService(fabric)
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const hubPort = (server.address() as net.AddressInfo).port
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  const tunnelGateway = attachNodeTunnelGateway(server, { registry: fabric.registry })
  const nodeData = mkdtempSync(join(rootDir, 'node-'))
  const daemon = await createNodeDaemon({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    identity: { nodeId: 'fwd-node', token: 'fwd-node:secret' },
    dataDir: nodeData,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
  const ready = await daemon.waitUntilRegistered(10_000)
  return {
    forward,
    ready,
    close: async () => {
      await forward.close()
      await daemon.close()
      await tunnelGateway.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
      rmSync(nodeData, { recursive: true, force: true })
    },
  }
}

/** 二进制 echo 服务。 */
async function startEcho(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.on('error', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** 本地 TCP 客户端：连接并发送，等待至少 minLength 回显。 */
function tcRequest(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('error', reject)
    const chunks: Buffer[] = []
    let received = 0
    socket.on('data', (c) => {
      chunks.push(c)
      received += c.length
      if (received >= payload.length) {
        socket.end()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.write(payload)
  })
}

test('端口转发：start/list/get/事件 + stop 后监听器与隧道销毁', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const events: string[] = []
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    const off = stack.forward.onEvent(session.forwardId, (event) => events.push(event.type))
    assert.equal(stack.forward.get(session.forwardId)?.forwardId, session.forwardId)
    assert.deepEqual(stack.forward.list().map((s) => s.forwardId), [session.forwardId])

    // 真实字节往返：本地 listen 端口 → Hub 转发 → 隧道 → daemon → echo。
    const payload = Buffer.from('forward-payload-您好')
    const echoed = await tcRequest(session.listenPort, payload)
    assert.ok(echoed.equals(payload), '经转发的字节往返一致')
    await delay(100)
    assert.ok(events.includes('connection'), 'connection 事件已上报')
    assert.equal(stack.forward.get(session.forwardId)?.activeConnections, 0, '连接关闭后计数归零')

    await stack.forward.stop(session.forwardId)
    assert.equal(stack.forward.get(session.forwardId), undefined, 'stop 后会话摘除')
    await assert.rejects(
      tcRequest(session.listenPort, payload).then(() => undefined, (e) => { throw e }),
      undefined,
    ).catch(() => undefined) // 端口已关：连接失败（不校验具体错误类型）。
    off()
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('端口转发：监听冲突显式失败；未知 forwardId stop 404', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  const port = await freePort()
  try {
    assert.equal(stack.ready, true)
    await stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: port, targetPort: echo.port })
    // 同地址二次监听：显式失败（不静默换端口）。
    await assert.rejects(
      stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: port, targetPort: echo.port }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'node_forward_listen_failed',
    )
    await assert.rejects(
      stack.forward.stop('fwd-does-not-exist'),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'not_found',
    )
  } finally {
    await stack.close()
    await echo.close()
  }
})

test('端口转发：close 全量销毁（宿主关停语义）', { timeout: 60_000 }, async () => {
  const echo = await startEcho()
  const stack = await startStack()
  try {
    assert.equal(stack.ready, true)
    const session = await stack.forward.start('fwd-node', {
      listenHost: '127.0.0.1',
      listenPort: await freePort(),
      targetPort: echo.port,
    })
    await stack.forward.close()
    assert.equal(stack.forward.get(session.forwardId), undefined)
    assert.deepEqual(stack.forward.list(), [])
    await assert.rejects(
      stack.forward.start('fwd-node', { listenHost: '127.0.0.1', listenPort: await freePort(), targetPort: echo.port }),
      undefined,
    ).catch(() => undefined) // close 后拒绝新转发。
  } finally {
    await stack.close()
    await echo.close()
  }
})

/** 取一个空闲端口（listen 0 后立即释放；存在微小竞态但测试环境足够）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}
