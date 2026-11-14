/**
 * 跨节点进程占用快照 RPC 集成测试（真实 Hub WS 网关 + 真实 @helm/node daemon）。
 *
 * 覆盖：
 * - 真实 daemon（node-b）注册后，fabric.inspectPathUsage 经 envPathUsage RPC
 *   在节点侧真实扫描：本机子进程以目标目录为 cwd → 命中 pid（真实 /ws/node
 *   birpc 往返）；子进程退出后重扫干净；尾随斜杠入参按归一化路径回显关联；
 * - 伪造「旧版 daemon 无 envPathUsage 方法」（原始 WS + createBirpc 注册、
 *   不暴露该方法）→ fabric 显式 path_usage_not_supported（501，绝不回退
 *   本机扫描、绝不假称 0 占用）；
 * - 未注册节点 → node_offline（409）；入参非法 → validation_error（先于 RPC）；
 * - 快照边界严格校验（真实 RPC 通道返回伪造载荷）：错 path 回显、矛盾
 *   truncated、非严格布尔 ok、重复 PID、非法错误信封均显式
 *   node_path_usage_failed 拒绝（不靠 TypeError 兜底）；合法 ok:false 原样
 *   分型透传。
 *
 * 平台契约：真实 /proc 链路仅 Linux；非 Linux 平台本文件不整体失败也不静默
 * skip——显式断言 path_usage_not_supported（当前跨平台行为限制的如实契约）。
 * root 假设不成立的环境（其他 uid 进程不可见）下 complete 可为 false：占用
 * 命中（同 uid 子进程）断言不受影响，完整性只断言布尔与 fail-closed 诊断。
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

/** 非 Linux 平台断言扫描显式不支持（不伪造、不静默跳过）。 */
function assertNotSupportedOnNonLinux(err: unknown): boolean {
  assert.ok(err instanceof HelmError, `应抛 HelmError（实得 ${String(err)}）`)
  assert.equal(err.code, 'path_usage_not_supported', '非 Linux 平台必须显式 not_supported')
  assert.equal(err.status, 501)
  return true
}

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
      if (process.platform !== 'linux') {
        // 非 Linux：节点侧扫描显式不支持——如实断言，不整体失败。
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-b', target),
          (err: unknown) => assertNotSupportedOnNonLinux(err),
        )
        return
      }
      const holder = holdProcess(target)
      try {
        const usage = await hub.fabric.inspectPathUsage('node-b', target)
        assert.equal(usage.path, target, '快照应回显目标路径')
        const hit = usage.processes.find((p) => p.pid === holder.pid)
        assert.ok(hit, `应经真实 RPC 命中占用进程 ${holder.pid}：${JSON.stringify(usage.processes)}`)
        assert.equal(hit!.source, 'cwd')
        assert.equal(hit!.path, target)
        assert.ok(!('cmdline' in hit!), '快照不得携带 cmdline')
        // 完整性不假设 root：非完整环境必须携带 fail-closed 诊断。
        assert.equal(typeof usage.complete, 'boolean')
        if (usage.complete !== true) {
          assert.ok(usage.diagnostics.length > 0, 'complete=false 必须携带不完整诊断')
        }
        // 尾随斜杠：入参归一化后仍与快照回显关联（同目录）。
        const normalizedEcho = await hub.fabric.inspectPathUsage('node-b', `${target}/`)
        assert.equal(normalizedEcho.path, target.replace(/\/+$/, '') || target)
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

/** 伪造节点（原始 WS + createBirpc）：envPathUsage 作为本地函数面注入（undefined = 旧版缺失该方法）。 */
async function startFakeNode(
  fabric: ReturnType<typeof createEnvFabric>,
  server: http.Server,
  envPathUsage: ((input: { path: string }) => Promise<unknown>) | undefined,
) {
  const address = server.address() as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/node?nodeId=node-old`)
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  const local: Record<string, unknown> = {
    onEnvExecOutput: () => undefined,
    onIpcEvent: () => undefined,
    onIpcClosed: () => undefined,
    ...(envPathUsage !== undefined ? { envPathUsage } : {}),
  }
  const rpc = createBirpc<
    {
      register(input: NodeRegisterInput): Promise<NodeRegisterResult>
      heartbeat(nodeId: string): Promise<boolean>
      envPathUsage?(input: { path: string }): Promise<unknown>
    },
    HubConnectionLocal
  >(local as never, {
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
  })
  return {
    rpc,
    register: () =>
      rpc.register({
        nodeId: 'node-old',
        token: 'node-old:secret',
        hostname: 'fake-node',
        platform: process.platform,
      }),
    close: () => {
      rpc.$close()
      ws.close()
    },
  }
}

/** 携带伪造 envPathUsage 的独立 Hub + 节点（每用例新建，互不污染）。 */
async function startHubWithFakeNode(envPathUsage: ((input: { path: string }) => Promise<unknown>) | undefined) {
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
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  const node = await startFakeNode(fabric, server, envPathUsage)
  const outcome = await node.register()
  assert.equal(outcome.ok, true, `伪造节点应注册成功：${JSON.stringify(outcome)}`)
  return {
    fabric,
    close: async () => {
      node.close()
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
    },
  }
}

/** 断言 node_path_usage_failed（非法快照/信封），返回错误供进一步校验。 */
async function expectSnapshotRejected(
  fabric: ReturnType<typeof createEnvFabric>,
  path = '/wt',
): Promise<HelmError> {
  let caught: unknown
  await assert.rejects(
    () => fabric.inspectPathUsage('node-old', path),
    (err: unknown) => {
      caught = err
      assert.ok(err instanceof HelmError, `应显式 HelmError（实得 ${String(err)}）`)
      assert.equal((err as HelmError).code, 'node_path_usage_failed', '非法快照/信封必须显式拒绝，不靠 TypeError')
      return true
    },
  )
  return caught as HelmError
}

describe('旧版 daemon / 离线节点 / 入参校验（显式失败，不回退本机）', { timeout: 60_000 }, () => {
  it('伪造无 envPathUsage 的旧版 daemon：path_usage_not_supported（501）', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      await assert.rejects(
        () => hub.fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'path_usage_not_supported', '旧版 daemon 无 envPathUsage：显式不支持，绝不回退本机')
          assert.equal(err.status, 501)
          return true
        },
      )
    } finally {
      await hub.close()
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

  it('远端入参非法：validation_error（先于 RPC，local/remote 同规则）', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      for (const bad of ['relative/x', '/a\u0000b', '/a/../b']) {
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-old', bad),
          (err: unknown) => {
            assert.ok(err instanceof HelmError)
            assert.equal(err.code, 'validation_error', `非法路径先于 RPC 拒绝（${bad}）`)
            return true
          },
        )
      }
    } finally {
      await hub.close()
    }
  })
})

describe('节点快照/信封严格校验（真实 RPC 通道返回伪造载荷）', { timeout: 60_000 }, () => {
  it('快照 path 与请求不符：拒绝（其它目录的空快照不能用作本目录清理依据）', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async () => ({
      ok: true,
      value: { path: '/other/dir', processes: [], matchedTotal: 0, processesTruncated: false, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric, '/wt')
      assert.ok(err.message.includes('path'), `诊断应指明 path 不符（实得 ${err.message}）`)
    } finally {
      await hub.close()
    }
  })

  it('矛盾计数：truncated=true 而 matchedTotal=0：拒绝', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: true, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric)
      assert.ok(
        err.message.includes('processesTruncated') || err.message.includes('matchedTotal'),
        `诊断应指明矛盾（实得 ${err.message}）`,
      )
    } finally {
      await hub.close()
    }
  })

  it('非严格布尔 ok（ok:1 / 缺 ok）：拒绝为协议违反，不产生 TypeError', { timeout: 60_000 }, async () => {
    for (const payload of [
      { ok: 1, value: null },
      { value: null },
      [1, 2],
    ]) {
      const hub = await startHubWithFakeNode(async () => payload)
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('ok') || err.message.includes('信封'), `诊断应指明信封非法（实得 ${err.message}）`)
      } finally {
        await hub.close()
      }
    }
  })

  it('重复 PID 清单：拒绝（同进程多引用应去重）', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: {
        path: input.path,
        processes: [
          { pid: 42, source: 'cwd', path: input.path },
          { pid: 42, source: 'fd', path: `${input.path}/f` },
        ],
        matchedTotal: 2,
        processesTruncated: false,
        complete: true,
        diagnostics: [],
      },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric)
      assert.ok(err.message.includes('重复'), `诊断应指明重复 PID（实得 ${err.message}）`)
    } finally {
      await hub.close()
    }
  })

  it('失败分支缺合法 code/message 的错误信封：拒绝为协议违反', { timeout: 60_000 }, async () => {
    for (const badError of [undefined, { code: 'x' }, { message: 'm' }, 'text']) {
      const hub = await startHubWithFakeNode(async () => ({ ok: false, error: badError }))
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('信封') || err.message.includes('code'), `诊断应指明错误信封非法（实得 ${err.message}）`)
      } finally {
        await hub.close()
      }
    }
  })

  it('合法 ok:false：分型透传（node_path_usage_failed 携带节点原始 code）', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async () => ({
      ok: false,
      error: { code: 'permission_denied', message: 'no access to /proc/1/fd' },
    }))
    try {
      await assert.rejects(
        () => hub.fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'node_path_usage_failed')
          const details = (err as HelmError).details as { code?: string }
          assert.equal(details?.code, 'permission_denied', '节点原始错误码保留')
          return true
        },
      )
    } finally {
      await hub.close()
    }
  })
})
