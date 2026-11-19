/**
 * Integration tests for cross-node process usage snapshot RPC (real Hub WS gateway + real @helmx/node daemon).
 *
 * Coverage:
 * - Once real daemon (node-b) registers, fabric.inspectPathUsage performs a real node-side scan via
 *   envPathUsage RPC: a local child process whose cwd is the target directory hits its pid (returned
 *   over real /ws/node birpc); re-scanning after exit is clean; trailing-slash argument normalizes
 *   to match echoed path;
 * - Forged legacy daemon without envPathUsage (raw WS + createBirpc register omitting the method) ->
 *   fabric throws explicit path_usage_not_supported (501, never falls back to local scan, never falsely
 *   reports 0 busy processes);
 * - Unregistered node -> node_offline (409); invalid argument -> validation_error (pre-RPC);
 * - Strict snapshot boundary validation (malformed payloads returned over real RPC): mismatched echoed
 *   path, contradictory truncated flag, non-strict-boolean ok, duplicate PID, invalid error envelope all
 *   reject explicitly with node_path_usage_failed (no fallback TypeError); valid ok:false passes error
 *   code through;
 * - Platform contract: real /proc exists only on Linux; on non-Linux platforms this file neither fails
 *   wholesale nor skips silently -- it explicitly asserts path_usage_not_supported.
 *   In non-root environments where EACCES occurs (cross-uid or non-dumpable e.g. systemd --user):
 *   unobservable count increases (structural blind spot, does not make complete=false); usage hits
 *   (same-uid child process) remain unaffected; complete asserts boolean and fail-closed diagnostics.
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
import type { NodeRegisterInput, NodeRegisterResult } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { attachNodeWsGateway, createEnvFabric } from '../src/env/index.js'
import { createNodeDaemon, type NodeDaemon, type NodeIdentity } from '@helmx/node'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-pathusage-rpc-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** Asserts explicit not-supported rejection on non-Linux platforms (never fakes success or silently skips). */
function assertNotSupportedOnNonLinux(err: unknown): boolean {
  assert.ok(err instanceof HelmxError, `expected HelmxError (got ${String(err)})`)
  assert.equal(err.code, 'path_usage_not_supported', 'non-Linux platforms must reject explicitly with not_supported')
  assert.equal(err.status, 501)
  return true
}

/** Minimal fabric Hub (HTTP + WS gateway without KernelRuntime). */
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

/** Spawns a long-lived child with cwd=target (holds directory busy; visible via /proc on same host). */
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

test('real daemon: envPathUsage scans on the node side via WS RPC', { timeout: 60_000 }, async () => {
  const hub = await startHub()
  const dataDir = join(rootDir, 'node-data')
  mkdirSync(dataDir, { recursive: true })
  const target = join(rootDir, 'wt')
  mkdirSync(target, { recursive: true })
  try {
    const daemon = await startDaemon(hub.baseUrl, dataDir)
    assert.ok(await daemon.waitUntilRegistered(), 'daemon should register successfully')
    try {
      if (process.platform !== 'linux') {
        // Non-Linux: node-side scan reports unsupported explicitly rather than failing the whole suite.
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-b', target),
          (err: unknown) => assertNotSupportedOnNonLinux(err),
        )
        return
      }
      const holder = holdProcess(target)
      try {
        const usage = await hub.fabric.inspectPathUsage('node-b', target)
        assert.equal(usage.path, target, 'snapshot should echo the target path')
        const hit = usage.processes.find((p) => p.pid === holder.pid)
        assert.ok(hit, `should detect busy process ${holder.pid} via real RPC: ${JSON.stringify(usage.processes)}`)
        assert.equal(hit!.source, 'cwd')
        assert.equal(hit!.path, target)
        assert.ok(!('cmdline' in hit!), 'snapshot must not include cmdline')
        // Completeness does not assume root: incomplete scans must include fail-closed diagnostics.
        assert.equal(typeof usage.complete, 'boolean')
        if (usage.complete !== true) {
          assert.ok(usage.diagnostics.length > 0, 'complete=false must carry incompleteness diagnostics')
        }
        // Trailing slash: after normalizing argument, snapshot still echoes matching path (same dir).
        const normalizedEcho = await hub.fabric.inspectPathUsage('node-b', `${target}/`)
        assert.equal(normalizedEcho.path, target.replace(/\/+$/, '') || target)
      } finally {
        await holder.stop()
      }
      const after = await hub.fabric.inspectPathUsage('node-b', target)
      assert.equal(after.processes.some((p) => p.pid === holder.pid), false, 'exited process leaves no stale entry')
    } finally {
      await daemon.close()
    }
  } finally {
    await hub.close()
  }
})

/** Fake node (raw WS + createBirpc): injects custom envPathUsage handler (undefined simulates legacy daemon). */
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
          /* ignore non-JSON */
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

/** Isolated Hub + node with injected envPathUsage (fresh per case to avoid cross-test interference). */
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
  assert.equal(outcome.ok, true, `fake node registration should succeed: ${JSON.stringify(outcome)}`)
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

/** Asserts node_path_usage_failed (invalid snapshot/envelope) and returns the error for extra checks. */
async function expectSnapshotRejected(
  fabric: ReturnType<typeof createEnvFabric>,
  path = '/wt',
): Promise<HelmxError> {
  let caught: unknown
  await assert.rejects(
    () => fabric.inspectPathUsage('node-old', path),
    (err: unknown) => {
      caught = err
      assert.ok(err instanceof HelmxError, `expected explicit HelmxError (got ${String(err)})`)
      assert.equal((err as HelmxError).code, 'node_path_usage_failed', 'invalid snapshot/envelope must fail explicitly without TypeError')
      return true
    },
  )
  return caught as HelmxError
}

describe('legacy daemon / offline node / argument validation (fails explicitly without local fallback)', { timeout: 60_000 }, () => {
  it('legacy daemon lacking envPathUsage returns path_usage_not_supported (501)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      await assert.rejects(
        () => hub.fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'path_usage_not_supported', 'legacy daemon without envPathUsage must fail explicitly and never fall back locally')
          assert.equal(err.status, 501)
          return true
        },
      )
    } finally {
      await hub.close()
    }
  })

  it('unregistered node throws node_offline (409)', { timeout: 60_000 }, async () => {
    const fabric = createEnvFabric({})
    try {
      await assert.rejects(
        () => fabric.inspectPathUsage('node-gone', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'node_offline')
          return true
        },
      )
    } finally {
      await fabric.dispose()
    }
  })

  it('invalid remote path throws validation_error pre-RPC (same rules for local and remote)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(undefined)
    try {
      for (const bad of ['relative/x', '/a\u0000b', '/a/../b']) {
        await assert.rejects(
          () => hub.fabric.inspectPathUsage('node-old', bad),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'validation_error', `invalid path must reject pre-RPC (${bad})`)
            return true
          },
        )
      }
    } finally {
      await hub.close()
    }
  })
})

describe('strict validation of node snapshots/envelopes (malformed payloads over real RPC)', { timeout: 60_000 }, () => {
  it('snapshot path mismatch rejects (empty snapshot for another directory cannot authorize cleanup)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async () => ({
      ok: true,
      value: { path: '/other/dir', processes: [], matchedTotal: 0, processesTruncated: false, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric, '/wt')
      assert.ok(err.message.includes('path'), `diagnostic should mention path mismatch (got ${err.message})`)
    } finally {
      await hub.close()
    }
  })

  it('contradictory counts (truncated=true with matchedTotal=0) rejects', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: true, complete: true, diagnostics: [] },
    }))
    try {
      const err = await expectSnapshotRejected(hub.fabric)
      assert.ok(
        err.message.includes('processesTruncated') || err.message.includes('matchedTotal'),
        `diagnostic should mention contradictory fields (got ${err.message})`,
      )
    } finally {
      await hub.close()
    }
  })

  it('invalid unobservable value (negative / non-integer) rejects schema validation', { timeout: 60_000 }, async () => {
    for (const bad of [-1, 1.5, '3']) {
      const hub = await startHubWithFakeNode(async (input) => ({
        ok: true,
        value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: false, complete: true, unobservable: bad, diagnostics: [] },
      }))
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('unobservable'), `diagnostic should mention invalid unobservable (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('omitted unobservable defaults to 0 (legacy nodes rejecting all reads already set complete=false); valid counts pass through', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async (input) => ({
      ok: true,
      value: { path: input.path, processes: [], matchedTotal: 0, processesTruncated: false, complete: true, diagnostics: [] },
    }))
    try {
      const usage = await hub.fabric.inspectPathUsage('node-old', '/wt')
      assert.equal(usage.unobservable, 0, 'missing field defaults to 0')
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
        diagnostics: ['pid 1 (uid 0): cross-user read cwd denied (EACCES), unobservable (excluded from completeness check)'],
      },
    }))
    try {
      const usage = await hub2.fabric.inspectPathUsage('node-old', '/wt')
      assert.equal(usage.unobservable, 7, 'valid blind-spot counter passes through')
      assert.equal(usage.complete, true)
      assert.ok(usage.diagnostics.some((d) => d.includes('unobservable')))
    } finally {
      await hub2.close()
    }
  })

  it('non-strict-boolean ok (ok:1 / missing ok) rejects as protocol violation without TypeError', { timeout: 60_000 }, async () => {
    for (const payload of [
      { ok: 1, value: null },
      { value: null },
      [1, 2],
    ]) {
      const hub = await startHubWithFakeNode(async () => payload)
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('ok') || err.message.includes('envelope'), `diagnostic should mention invalid envelope (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('duplicate PID entries reject (multiple references from same process must be deduplicated)', { timeout: 60_000 }, async () => {
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
      assert.ok(err.message.includes('duplicate'), `diagnostic should mention duplicate PID (got ${err.message})`)
    } finally {
      await hub.close()
    }
  })

  it('failed branch missing valid code/message error envelope rejects as protocol violation', { timeout: 60_000 }, async () => {
    for (const badError of [undefined, { code: 'x' }, { message: 'm' }, 'text']) {
      const hub = await startHubWithFakeNode(async () => ({ ok: false, error: badError }))
      try {
        const err = await expectSnapshotRejected(hub.fabric)
        assert.ok(err.message.includes('envelope') || err.message.includes('code'), `diagnostic should mention invalid error envelope (got ${err.message})`)
      } finally {
        await hub.close()
      }
    }
  })

  it('valid ok:false preserves error classification (node_path_usage_failed retains node code)', { timeout: 60_000 }, async () => {
    const hub = await startHubWithFakeNode(async () => ({
      ok: false,
      error: { code: 'permission_denied', message: 'no access to /proc/1/fd' },
    }))
    try {
      await assert.rejects(
        () => hub.fabric.inspectPathUsage('node-old', '/wt'),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'node_path_usage_failed')
          const details = (err as HelmxError).details as { code?: string }
          assert.equal(details?.code, 'permission_denied', 'raw node error code is preserved')
          return true
        },
      )
    } finally {
      await hub.close()
    }
  })
})
