/**
 * 跨节点进程占用快照 RPC 集成测试（真实 Hub WS 网关 + 真实 @helm/node daemon）。
 *
 * 覆盖：
 * - 真实 daemon（node-b）注册后，fabric.inspectPathUsage 经 envPathUsage RPC
 *   在节点侧真实扫描：本机子进程以目标目录为 cwd → 命中 pid（RPC 往返真实
 *   走 /ws/node birpc 通道）；子进程退出后重扫干净；
 * - 伪造「旧版 daemon 无 envPathUsage 方法」（原始 WS + createBirpc 注册、
 *   不暴露该方法）→ fabric 显式 path_usage_not_supported（501，绝不回退
 *   本机扫描、绝不假称 0 占用）；
 * - 未注册节点 → node_offline（409）。
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import type { NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { attachNodeWsGateway, createEnvFabric } from '../src/env/index.js'
import { createNodeDaemon, type NodeDaemon, type NodeIdentity } from '@helm/node'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-pathusage-rpc-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 最小 fabric Hub（HTTP + WS 网关；不经 KernelRuntime）。 */
async function startHub() {
  const fabric = createEnvFabric({
    authenticate: (nodeId, token) => nodeId === 'node-b' && token === 'node-b:secret-b',
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
  })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fabric,
    close: async () => {
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
    },
  }
}

async function startDaemon(url: string, dataDir: string): Promise<NodeDaemon> {
  const identity: NodeIdentity = { nodeId: 'node-b', token: 'node-b:secret-b' }
  return createNodeDaemon({
    hubUrl: url,
    identity,
    dataDir,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 800,
    log: () => undefined,
  })
}

/** 以 target 为 cwd 的长驻子进程（占用方；与 daemon 同机可见于 /proc）。 */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  const pid = child.pid!
  return {
    pid,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      }),
  }
}

test('真实 daemon：envPathUsage 经 WS RPC 在节点侧真实扫描', { timeout: 60_000 }, async () => {
  const hub = await startHub()
  const dataDir = join(rootDir, 'node-data')
  mkdirSync(dataDir, { recursive: true })
  const target = join(rootDir, 'wt')
  mkdirSync(target, { recursive: true })
  try {
    const daemon = await startDaemon(hub.baseUrl, dataDir)
    assert.ok(await daemon.waitUntilRegistered(), 'daemon 应注册成功')
    try {
      const holder = holdProcess(target)
      try {
        const usage = await hub.fabric.inspectPathUsage('node-b', target)
        assert.equal(usage.path, target, '快照应回显目标路径')
        const hit = usage.processes.find((p) => p.pid === holder.pid)
        assert.ok(hit, `应经真实 RPC 命中占用进程 ${holder.pid}：${JSON.stringify(usage.processes)}`)
        assert.equal(hit!.source, 'cwd')
        assert.equal(hit!.path, target)
        assert.equal(usage.complete, true, 'root 宿主节点侧扫描完整')
        assert.ok(!('cmdline' in hit!), '快照不得携带 cmdline')
      } finally {
        await holder.stop()
      }
      const after = await hub.fabric.inspectPathUsage('node-b', target)
      assert.equal(after.processes.some((p) => p.pid === holder.pid), false, '退出进程不残留')
    } finally {
      await daemon.close()
    }
  } finally {
    await hub.close()
  }
})

describe('旧版 daemon / 离线节点（显式失败，不回退本机）', { timeout: 60_000 }, () => {
  it('伪造无 envPathUsage 的旧版 daemon：path_usage_not_supported（501）', async () => {
    // 放行伪造节点鉴权。
    const fabric = createEnvFabric({
      authenticate: (nodeId, token) => nodeId === 'node-old' && token === 'node-old:secret',
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node?nodeId=node-old`)
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    // 旧版 daemon：NodeSideFunctions 面缺 envPathUsage（optional 方法）。
    const rpc = createBirpc<
      {
        register(input: NodeRegisterInput): Promise<NodeRegisterResult>
        heartbeat(nodeId: string): Promise<boolean>
      },
      HubConnectionLocal
    >(
      { onEnvExecOutput: () => undefined },
      {
        post: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
        },
        on: (cb) => {
          ws.on('message', (raw) => {
            try {
              cb(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as never)
            } catch {
              /* 非 JSON 忽略 */
            }
          })
        },
        serialize: (d) => d,
        deserialize: (d) => d as never,
        timeout: 10_000,
      },
    )
    try {
      const outcome = await rpc.register({
        nodeId: 'node-old',
        token: 'node-old:secret',
        hostname: 'old-daemon',
        platform: process.platform,
      })
      assert.equal(outcome.ok, true, `伪造旧版节点应注册成功：${JSON.stringify(outcome)}`)
      await assert.rejects(
        () => fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'path_usage_not_supported', '旧版 daemon 无 envPathUsage：显式不支持，绝不回退本机')
          assert.equal(err.status, 501)
          return true
        },
      )
    } finally {
      rpc.$close()
      ws.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
    }
  })

  it('未注册节点：node_offline（409）', { timeout: 60_000 }, async () => {
    const fabric = createEnvFabric({})
    try {
      await assert.rejects(
        () => fabric.inspectPathUsage('node-gone', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'node_offline')
          return true
        },
      )
    } finally {
      await fabric.dispose()
    }
  })
})
