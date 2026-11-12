/**
 * 任意 TCP 隧道（openTunnel）Hub+真实 node daemon 集成测试：
 * 不止 HTTP——任意 host 目标、二进制/大 payload、半关闭、取消、
 * nodeFetch 的 HTTP/HTTPS 适配（本地 TLS fixture）。
 *
 * 真实链路：fabric.openTunnel → registry.openTunnel → daemon
 * nodeTunnelOpen(host) → TCP → /ws/node-tunnel 字节管道。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
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

/** 纯 EnvFabric Hub（HTTP server + 双网关 + 真实 daemon）。 */
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

/** 二进制安全 echo 服务（任意字节原样回显；socket 错误吞掉防测试崩溃）。 */
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

test('任意 TCP：host 透传 + 二进制大 payload 双向字节完整往返', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'bin-node' && token === 'bin-node:secret', 'bin-node')
  try {
    assert.equal(hub.ready, true)
    // 显式 host=localhost：目标 host 由节点解析与连接。
    const duplex = await hub.fabric.openTunnel('bin-node', { host: 'localhost', port: echo.port })
    const payload = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251 // 非 UTF-8 友好字节
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
    assert.equal(received, payload.length, '4MiB 二进制 payload 长度一致')
    const echoed = Buffer.concat(chunks)
    assert.ok(echoed.equals(payload), '二进制内容逐字节一致')
    duplex.destroy()
    duplex.on('error', () => undefined)
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('任意 TCP：请求-响应-连接关闭链路完整 flush（不掐断尾部数据）', { timeout: 60_000 }, async () => {
  // 服务：收到 'req' 后写大响应再 end。Hub 侧不预关隧道（写侧保持），
  // 读到完整响应后主动关闭——验证连接关闭链路 flush 完整、尾部不丢。
  // （注：WS 隧道无 TCP 半关闭——duplex.end 会整条关闭，故不测 FIN 半关；
  // 节点侧 pipe 链的 end-flush 语义由 node 包 node-tunnel.test.ts 覆盖。）
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
    duplex.on('error', () => undefined) // 关闭链路错误由 close 收敛
    const chunks: Buffer[] = []
    const got = new Promise<Buffer>((resolve) => {
      duplex.on('data', (c: Buffer) => chunks.push(c))
      duplex.on('end', () => resolve(Buffer.concat(chunks)))
      duplex.on('close', () => resolve(Buffer.concat(chunks)))
    })
    duplex.write('req') // 写侧保持开启：响应完整回传后再关
    const echoed = await Promise.race([got, delay(15_000).then(() => Buffer.alloc(0))])
    assert.equal(echoed.length, response.length, '完整响应 flush 回达（尾部不丢）')
    assert.ok(echoed.equals(response), '响应内容一致')
    duplex.destroy()
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('任意 TCP：取消（abort）在建连期显式失败并清理', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'abort-node' && token === 'abort-node:secret', 'abort-node')
  try {
    assert.equal(hub.ready, true)
    // 立即 abort：显式 499 aborted。
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: echo.port }, controller.signal),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'aborted',
    )
    // 目标校验：非法端口显式 validation_error。
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { port: 0 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    await assert.rejects(
      hub.fabric.openTunnel('abort-node', { host: 'bad host', port: 80 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'validation_error',
    )
    assert.deepEqual(hub.fabric.registry.debugTunnelCounts(), { pending: 0, active: 0 }, '无残留登记')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('任意 TCP：daemon 断开后 duplex 销毁（消费方感知断开）', { timeout: 60_000 }, async () => {
  const echo = await startBinaryEchoServer()
  const hub = await startHub((id, token) => id === 'disc-node' && token === 'disc-node:secret', 'disc-node')
  try {
    assert.equal(hub.ready, true)
    const duplex = await hub.fabric.openTunnel('disc-node', { port: echo.port })
    // 断开销毁以错误驱动（node_offline）：监听 error 防 unhandled。
    duplex.on('error', () => undefined)
    const closed = new Promise<void>((resolve) => duplex.once('close', resolve))
    // 断开 daemon → evict → active duplex destroy（消费方感知断开，不悬挂）。
    await hub.disconnectDaemon()
    await Promise.race([closed, delay(10_000)])
    assert.equal(duplex.destroyed, true, 'daemon 断开后 duplex 已销毁')
  } finally {
    await hub.close()
    await echo.close()
  }
})

test('nodeFetch HTTPS：本地 TLS fixture 上经隧道完成真实 TLS 请求（两阶段子进程注入信任链）', { timeout: 120_000 }, async () => {
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
  // 阶段 1：生成测试 CA 与服务证书。
  const caPhase = await runFixture(['ca'], {})
  const paths = JSON.parse(caPhase.stdout.trim().split('\n').pop() ?? '{}') as {
    caCert?: string; key?: string; cert?: string; error?: string
  }
  assert.ok(paths.caCert !== undefined && paths.key !== undefined && paths.cert !== undefined, `CA 生成失败：${paths.error ?? caPhase.stderr}`)
  // 阶段 2：NODE_EXTRA_CA_CERTS 随进程启动注入（Node 仅启动时读取），
  // 客户端证书校验走默认信任链 + 测试 CA，绝不伪造跳过校验。
  const reqPhase = await runFixture(['request'], {
    NODE_EXTRA_CA_CERTS: paths.caCert,
    HELM_TUNNEL_TLS_KEY: paths.key,
    HELM_TUNNEL_TLS_CERT: paths.cert,
  })
  let result: { ok?: boolean; status?: number; body?: string; error?: string }
  try {
    result = JSON.parse(reqPhase.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    result = { ok: false, error: reqPhase.stderr || reqPhase.stdout || 'fixture 无输出' }
  }
  assert.equal(result.ok, true, `HTTPS 隧道 fixture 失败：${result.error ?? ''} status=${result.status ?? ''} body=${result.body ?? ''}`)
  assert.equal(result.status, 200)
  assert.equal(result.body, 'https-echo:GET:/v1/x?k=v')
  // 清理证书目录。
  rmSync(join(paths.caCert!, '..'), { recursive: true, force: true })
})

test('nodeFetch HTTP：任意 host（非 loopback hostname 形式）+ HEAD/204 body null', { timeout: 60_000 }, async () => {
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
    // hostname 用 localhost（非裸 IP）：验证 host 透传与域名解析在节点侧完成。
    const response = await fetchRemote(`http://localhost:${port}/v1/y`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'http-echo:GET:/v1/y')
    const head = await fetchRemote(`http://localhost:${port}/v1/y`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, null, 'HEAD body 为 null')
    const noContent = await fetchRemote(`http://localhost:${port}/nocontent`)
    assert.equal(noContent.status, 204)
    assert.equal(noContent.body, null, '204 body 为 null')
  } finally {
    await hub.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
