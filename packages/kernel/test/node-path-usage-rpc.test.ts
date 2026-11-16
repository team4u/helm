/**
 * across node process occupy snapshot RPC integration test (real Hub WS gateway + real @helm/node daemon).
 *
 * override:
 * - real daemon(node-b) register after,fabric.inspectPathUsage via envPathUsage RPC
 *   in node side real scan: local machine child process with target directory is cwd → hit pid(real /ws/node
 *   birpc to return); child process exit after heavy scan clean; tail follow slash reference by archive one path back visible related;
 * - fabricate old edition daemon without envPathUsage method (original WS + createBirpc register,
 *   do not expose the method)→ fabric explicit path_usage_not_supported(501, never fall back
 *   local machine scan, never false call 0 occupy);
 * - not registered node → node_offline(409); reference illegal → validation_error(first at RPC);
 * - snapshot boundary strictly validate (real RPC channel return fabricate payload): wrong path back visible, contradiction
 *   truncated, non- strictly boolean ok, duplicate PID, illegal error message seal all explicit
 *   node_path_usage_failed reject (do not rely TypeError fall back); legal ok:false original
 *   type pass-through.
 *
 * platform contract: real /proc link only Linux; non- Linux platform this file do not whole failed also not silently
 * skip- - explicit assertion path_usage_not_supported(when before across platform behavior restrict such as contract).
 * non- root environment under permission refuse read (across uid or non-dumpable, such as systemd --user):
 * count unobservable(structure blind spot, does not affect complete); occupy hit (same uid
 * child process) assertion do not subject to affect, complete only assertion boolean and fail-closed diagnose.
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

/** non- Linux platform assertion scan explicit unsupported (do not fabricate, not silently skip). */
function assertNotSupportedOnNonLinux(err: unknown): boolean {
  assert.ok(err instanceof HelmError, `should throw HelmError(got ${String(err)})`)
  assert.equal(err.code, 'path_usage_not_supported', 'non- Linux platform must explicit not_supported')
  assert.equal(err.status, 501)
  return true
}

/** most small fabric Hub(HTTP + WS gateway; do not via KernelRuntime). */
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

/** with target is cwd long resident child process (occupy way; and daemon same machine visible at /proc). */
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

test('real daemon:envPathUsage via WS RPC in node side real scan', { timeout: 60_000 }, async () => {
  const hub = await startHub()
  const dataDir = join(rootDir, 'node-data')
  mkdirSync(dataDir, { recursive: true })
  const target = join(rootDir, 'wt')
  mkdirSync(target, { recursive: true })
  try {
    const daemon = await startDaemon(hub.baseUrl, dataDir)
    assert.ok(await daemon.waitUntilRegistered(), 'daemon should register succeeded')
    try {
      if (process.platform !== 'linux') {
        // non- Linux: node side scan explicit unsupported - - such as assertion, do not whole failed.
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-b', target),
          (err: unknown) => assertNotSupportedOnNonLinux(err),
        )
        return
      }
      const holder = holdProcess(target)
      try {
        const usage = await hub.fabric.inspectPathUsage('node-b', target)
        assert.equal(usage.path, target, 'snapshot should back visible target path')
        const hit = usage.processes.find((p) => p.pid === holder.pid)
        assert.ok(hit, `should via real RPC hit occupy process ${holder.pid}:${JSON.stringify(usage.processes)}`)
        assert.equal(hit!.source, 'cwd')
        assert.equal(hit!.path, target)
        assert.ok(!('cmdline' in hit!), 'snapshot must not carry cmdline')
        // complete do not assume root: non- complete environment must carry fail-closed diagnose.
        assert.equal(typeof usage.complete, 'boolean')
        if (usage.complete !== true) {
          assert.ok(usage.diagnostics.length > 0, 'complete=false must carry do not complete diagnose')
        }
        // tail follow slash: reference archive one after still and snapshot back visible related (same directory).
        const normalizedEcho = await hub.fabric.inspectPathUsage('node-b', `${target}/`)
        assert.equal(normalizedEcho.path, target.replace(/\/+$/, '') || target)
      } finally {
        await holder.stop()
      }
      const after = await hub.fabric.inspectPathUsage('node-b', target)
      assert.equal(after.processes.some((p) => p.pid === holder.pid), false, 'exit process leaves no residue')
    } finally {
      await daemon.close()
    }
  } finally {
    await hub.close()
  }
})

/** fabricate node (original WS + createBirpc):envPathUsage as local function side inject (undefined = old edition missing the method). */
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
          /* non- JSON ignore */
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

/** carry fabricate envPathUsage independent Hub + node (each case creates new, mutual do not pollute). */
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
  assert.equal(outcome.ok, true, `fabricate node should register succeeded:${JSON.stringify(outcome)}`)
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

/** assertion node_path_usage_failed(illegal snapshot/message seal), return error supply enter one step validate. */
async function expectSnapshotRejected(
  fabric: ReturnType<typeof createEnvFabric>,
  path = '/wt',
): Promise<HelmError> {
  let caught: unknown
  await assert.rejects(
    () => fabric.inspectPathUsage('node-old', path),
    (err: unknown) => {
      caught = err
      assert.ok(err instanceof HelmError, `should explicit HelmError(got ${String(err)})`)
      assert.equal((err as HelmError).code, 'node_path_usage_failed', 'illegal snapshot/message seal must explicit reject, do not rely TypeError')
      return true
    },
  )
  return caught as HelmError
}

describe('old edition daemon / offline node / reference validate (explicit failed, does not fall back local machine)', { timeout: 60_000 }, () => {
  it('fabricate without envPathUsage old edition daemon:path_usage_not_supported(501)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      await assert.rejects(
        () => hub.fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'path_usage_not_supported', 'old edition daemon without envPathUsage: explicit unsupported, never fall back local machine')
          assert.equal(err.status, 501)
          return true
        },
      )
    } finally {
      await hub.close()
    }
  })

  it('not registered node:node_offline(409)', { timeout: 60_000 }, async () => {
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

  it('remote reference illegal:validation_error(first at RPC,local/remote same rule)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      for (const bad of ['relative/x', '/a\u0000b', '/a/../b']) {
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-old', bad),
          (err: unknown) => {
            assert.ok(err instanceof HelmError)
            assert.equal(err.code, 'validation_error', `illegal path first at RPC reject (${bad})`)
            return true
          },
        )
      }
    } finally {
      await hub.close()
    }
  })
})

describe('node snapshot/message seal strictly validate (real RPC channel return fabricate payload)', { timeout: 60_000 }, () => {
  it('snapshot path and request do not symbol: reject (other directory empty snapshot cannot use act this directory clean up based on)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async () => ({
      ok: true,
      value: { path: '/other/dir', processes: [], matchedTotal: 0, processesTruncated: false, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric, '/wt')
      assert.ok(err.message.includes('path'), `diagnose should refer path do not symbol (got ${err.message})`)
    } finally {
      await hub.close()
    }
  })

  it('contradiction counter:truncated=true while matchedTotal=0: reject', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: true, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric)
      assert.ok(
        err.message.includes('processesTruncated') || err.message.includes('matchedTotal'),
        `diagnose should refer contradiction (got ${err.message})`,
      )
    } finally {
      await hub.close()
    }
  })

  it('unobservable illegal (negative number / non- integer): reject adopt message', { timeout: 60_000 }, async () => {
    for (const bad of [-1, 1.5, '3']) {
      const hub = await startHubWithFakeNode(async (input) => ({
        ok: true,
        value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: false, complete: true, unobservable: bad, diagnostics: [] },
      }))
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('unobservable'), `diagnose should refer unobservable illegal (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('unobservable default: by 0 adopt message (old node any reject all report complete=false, default 0 semantics security); legal value pass-through', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: false, complete: true, diagnostics: [] },
    }))
    try {
      const usage = await hub.fabric.inspectPathUsage('node-old', '/wt')
      assert.equal(usage.unobservable, 0, 'default field by 0 adopt message')
      assert.equal(usage.complete, true)
    } finally {
      await hub.close()
    }

    const hub2 = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: {
        path: input.path,
        processes: [],
        matchedTotal: 0,
        processesTruncated: false,
        complete: true,
        unobservable: 7,
        diagnostics: ['pid 1 (uid 0): across user without right read cwd(EACCES), cannot observability (not count complete decide)'],
      },
    }))
    try {
      const usage = await hub2.fabric.inspectPathUsage('node-old', '/wt')
      assert.equal(usage.unobservable, 7, 'legal blind spot counter pass-through')
      assert.equal(usage.complete, true)
      assert.ok(usage.diagnostics.some((d) => d.includes('cannot observability')))
    } finally {
      await hub2.close()
    }
  })

  it('non- strictly boolean ok(ok:1 / missing ok): reject is protocol violate reverse, produces no TypeError', { timeout: 60_000 }, async () => {
    for (const payload of [
      { ok: 1, value: null },
      { value: null },
      [1, 2],
    ]) {
      const hub = await startHubWithFakeNode(async () => payload)
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('ok') || err.message.includes('message seal'), `diagnose should refer message seal illegal (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('duplicate PID manifest: reject (same process many reference should dedupe)', { timeout: 60_000 }, async () => {
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
      assert.ok(err.message.includes('duplicate'), `diagnose should refer duplicate PID(got ${err.message})`)
    } finally {
      await hub.close()
    }
  })

  it('failed branch missing legal code/message error message seal: reject is protocol violate reverse', { timeout: 60_000 }, async () => {
    for (const badError of [undefined, { code: 'x' }, { message: 'm' }, 'text']) {
      const hub = await startHubWithFakeNode(async () => ({ ok: false, error: badError }))
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('message seal') || err.message.includes('code'), `diagnose should refer error message seal illegal (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('legal ok:false: type pass-through (node_path_usage_failed carry node original code)', { timeout: 60_000 }, async () => {
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
          assert.equal(details?.code, 'permission_denied', 'node original error code keep')
          return true
        },
      )
    } finally {
      await hub.close()
    }
  })
})
