/**
 * Node-side `envPathUsage` RPC and managed environment variable stripping tests
 * against a real `NodeEnvRpcServer`.
 *
 * Covers:
 * - Real `/proc`: child process spawned by this test holding target dir as `cwd`
 *   matches (`pid`/`source`/`cwd` path), and disappears after exit;
 * - Open `fd` held by this test process pointing into the target tree matches (`fd`);
 * - Fixture `procRoot` (symlinked `cwd`/`fd`): matches and enforces segment boundaries
 *   (`/a` does not match `/ab`);
 * - Non-Linux platform injection returns explicit `not_supported` (no fabricated results);
 * - Strict input validation: unknown fields / relative paths / NUL / non-objects -> `invalid`;
 * - Managed env var stripping: `HELMX_TOKEN` / `HELMX_EXECUTION_SCOPE` from daemon host env
 *   never leak into child commands via either `envExec` or direct `LocalExecutionEnv.exec`,
 *   while caller-supplied values take effect per call.
 *
 * Note: `EACCES` cannot be faithfully reproduced under a root host and is covered via
 * injected I/O unit tests in `packages/env-io/test/path-usage.test.ts`.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDir, makeTempDir } from '@helmx/test-kit/node'
import { createNodeEnvRpcServer, type NodeEnvRpcServer } from '../src/index.js'
import { LocalExecutionEnv } from '../src/daemon/local-env.js'

let rootDir: string
let server: NodeEnvRpcServer

before(async () => {
  rootDir = await makeTempDir('helmx-node-pathusage-')
  server = createNodeEnvRpcServer({ defaultCwd: rootDir })
})

after(async () => {
  await server.dispose().catch(() => undefined)
  await cleanupDir(rootDir)
})

/** Spawn a long-lived child with `target` as cwd (only for real occupancy testing). */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  assert.ok(child.pid !== undefined, 'child process should have a pid')
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

describe('envPathUsage: real /proc', { timeout: 60_000 }, () => {
  it('child process cwd match: hits pid/path and clears after exit (without assuming root completeness)', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'wt-a')
    mkdirSync(target, { recursive: true })
    if (process.platform !== 'linux') {
      // Non-Linux: explicitly return not_supported (never fabricate or silently skip).
      const unsupported = await server.envPathUsage!({ path: target })
      assert.equal(unsupported.ok, false)
      if (unsupported.ok) return
      assert.equal(unsupported.error.code, 'not_supported')
      return
    }
    const holder = holdProcess(target)
    try {
      const r = await server.envPathUsage!({ path: target })
      assert.equal(r.ok, true, `scan should succeed: ${r.ok ? '' : r.error.message}`)
      if (!r.ok) return
      const hit = r.value.processes.find((p) => p.pid === holder.pid)
      assert.ok(hit, `should match child process ${holder.pid}: ${JSON.stringify(r.value.processes)}`)
      assert.equal(hit!.source, 'cwd')
      assert.equal(hit!.path, target)
      assert.equal(typeof hit!.name, 'string', 'should include process name (comm)')
      // Do not assume root: incomplete scans must include fail-closed diagnostics; permission denials
      // (cross-uid or non-dumpable processes like systemd --user) count toward unobservable.
      assert.equal(typeof r.value.complete, 'boolean')
      assert.equal(typeof r.value.unobservable, 'number', 'snapshot must include unobservable count')
      assert.ok(r.value.unobservable >= 0, 'unobservable count must be a non-negative integer')
      if (r.value.complete !== true) {
        assert.ok(r.value.diagnostics.length > 0, 'complete=false must include incomplete diagnostics')
      }
    } finally {
      await holder.stop()
    }
    // After process exit: that pid must no longer match.
    const after = await server.envPathUsage!({ path: target })
    assert.equal(after.ok, true)
    if (!after.ok) return
    assert.equal(after.value.processes.some((p) => p.pid === holder.pid), false, 'exited process must not linger in results')
  })

  it('open fd held by current process matches target tree files (source=fd)', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'wt-b')
    mkdirSync(target, { recursive: true })
    if (process.platform !== 'linux') {
      const unsupported = await server.envPathUsage!({ path: target })
      assert.equal(unsupported.ok, false)
      if (unsupported.ok) return
      assert.equal(unsupported.error.code, 'not_supported')
      return
    }
    const held = join(target, 'held.log')
    writeFileSync(held, 'x')
    const fd = openSync(held, 'r')
    try {
      const r = await server.envPathUsage!({ path: target })
      assert.equal(r.ok, true)
      if (!r.ok) return
      const hit = r.value.processes.find((p) => p.pid === process.pid && p.source === 'fd')
      assert.ok(hit, `should hit current process fd: ${JSON.stringify(r.value.processes.filter((p) => p.pid === process.pid))}`)
      assert.equal(hit!.path, held)
    } finally {
      closeSync(fd)
    }
  })
})

describe('envPathUsage: fixture procRoot and boundaries', { timeout: 60_000 }, () => {
  it('synthetic /proc tree (symlink cwd/fd): hits target and enforces path segment boundaries (/a != /ab)', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'real-wt')
    mkdirSync(target, { recursive: true })
    const fakeProc = join(rootDir, 'fake-proc')
    mkdirSync(join(fakeProc, '42', 'fd'), { recursive: true })
    symlinkSync(join(target, 'sub'), join(fakeProc, '42', 'cwd'))
    symlinkSync(join(target, 'file.txt'), join(fakeProc, '42', 'fd', '3'))
    writeFileSync(join(target, 'file.txt'), 'x')
    mkdirSync(join(target, 'sub'))
    // Boundary: sibling /real-wtb next to /real-wt must not match.
    mkdirSync(join(rootDir, 'real-wtb'), { recursive: true })
    const fixtureServer = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { procRoot: fakeProc } })
    try {
      const r = await fixtureServer.envPathUsage!({ path: target })
      assert.equal(r.ok, true)
      if (!r.ok) return
      // Deduplicate cwd+fd for the same PID (42): count once per PID, prioritizing cwd.
      assert.equal(r.value.matchedTotal, 1, 'same PID with cwd+fd deduplicates to 1')
      assert.equal(r.value.processes.length, 1)
      assert.equal(r.value.processes[0]!.pid, 42)
      assert.equal(r.value.processes[0]!.source, 'cwd')
      assert.equal(r.value.complete, true, 'no permission denials in fixture -> complete')

      const neighbor = await fixtureServer.envPathUsage!({ path: join(rootDir, 'real-wtb') })
      assert.equal(neighbor.ok, true)
      if (!neighbor.ok) return
      assert.equal(neighbor.value.matchedTotal, 0, 'similar-prefix paths with distinct segments must not false-match')
    } finally {
      await fixtureServer.dispose().catch(() => undefined)
    }
  })

  it('platform override darwin/win32 explicitly returns not_supported', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32']) {
      const s = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { platform: () => platform } })
      try {
        const r = await s.envPathUsage!({ path: '/wt' })
        assert.equal(r.ok, false, `${platform} should reject explicitly`)
        if (r.ok) continue
        assert.equal(r.error.code, 'not_supported')
        assert.ok(r.error.message.includes(platform))
      } finally {
        await s.dispose().catch(() => undefined)
      }
    }
  })

  it('strict input validation: unknown fields / non-object / relative path / NUL -> invalid', { timeout: 60_000 }, async () => {
    const cases: unknown[] = [
      null,
      'x',
      { path: '/wt', extra: 1 },
      { path: 'relative/x' },
      { path: '/a\u0000b' },
      { path: '' },
    ]
    for (const input of cases) {
      const r = await server.envPathUsage!(input as never)
      assert.equal(r.ok, false, `should reject ${JSON.stringify(input)}`)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid', `${JSON.stringify(input)} -> invalid (got ${r.error.code})`)
    }
  })
})

describe('managed env var stripping (HELMX_TOKEN / HELMX_EXECUTION_SCOPE)', { timeout: 60_000 }, () => {
  /** Probe child process env using Node itself (shell-independent, cross-platform). */
  const probeEnvCommand = (): string[] => [
    process.execPath,
    '-e',
    "console.log(JSON.stringify({t: process.env.HELMX_TOKEN ?? '', s: process.env.HELMX_EXECUTION_SCOPE ?? ''}))",
  ]

  it('envExec strips daemon host managed env vars while applying explicit caller injections', { timeout: 60_000 }, async () => {
    const prevToken = process.env.HELMX_TOKEN
    const prevScope = process.env.HELMX_EXECUTION_SCOPE
    process.env.HELMX_TOKEN = 'daemon-own-secret'
    process.env.HELMX_EXECUTION_SCOPE = 'stale-daemon-scope'
    const chunks: string[] = []
    const echoServer = createNodeEnvRpcServer({
      defaultCwd: rootDir,
      onExecOutput: (e) => chunks.push(e.text),
    })
    try {
      const r = await echoServer.envExec({
        execId: 'strip-1',
        command: probeEnvCommand(),
      })
      assert.equal(r.ok, true, r.ok ? '' : r.error.message)
      const parsed = JSON.parse(chunks.join('').trim()) as { t?: string; s?: string }
      assert.equal(parsed.t, '', `HELMX_TOKEN must not be inherited (got ${parsed.t})`)
      assert.equal(parsed.s, '', `HELMX_EXECUTION_SCOPE must not be inherited (got ${parsed.s})`)

      // Caller-supplied explicit overrides (synthesized per call by Hub) apply per call.
      const chunks2: string[] = []
      const echoServer2 = createNodeEnvRpcServer({
        defaultCwd: rootDir,
        onExecOutput: (e) => chunks2.push(e.text),
      })
      try {
        const r2 = await echoServer2.envExec({
          execId: 'strip-2',
          command: probeEnvCommand(),
          env: { HELMX_EXECUTION_SCOPE: 'worktree:node-x:/wt' },
        })
        assert.equal(r2.ok, true)
        const parsed2 = JSON.parse(chunks2.join('').trim()) as { s?: string }
        assert.equal(parsed2.s, 'worktree:node-x:/wt', 'explicit injected value must take effect per call')
      } finally {
        await echoServer2.dispose().catch(() => undefined)
      }
    } finally {
      await echoServer.dispose().catch(() => undefined)
      if (prevToken === undefined) delete process.env.HELMX_TOKEN
      else process.env.HELMX_TOKEN = prevToken
      if (prevScope === undefined) delete process.env.HELMX_EXECUTION_SCOPE
      else process.env.HELMX_EXECUTION_SCOPE = prevScope
    }
  })

  it('direct LocalExecutionEnv.exec (inheritEnv enabled by default) also strips managed vars from baseline', { timeout: 60_000 }, async () => {
    const prevToken = process.env.HELMX_TOKEN
    const prevScope = process.env.HELMX_EXECUTION_SCOPE
    process.env.HELMX_TOKEN = 'daemon-own-secret'
    process.env.HELMX_EXECUTION_SCOPE = 'stale-daemon-scope'
    const env = new LocalExecutionEnv({ cwd: rootDir })
    let out = ''
    try {
      const r = await env.exec(
        probeEnvCommand(),
        { onOutput: (text) => { out += text } },
      )
      assert.equal(r.ok, true, r.ok ? '' : r.error.message)
      const parsed = JSON.parse(out.trim()) as { t?: string; s?: string }
      assert.equal(parsed.t, '', `HELMX_TOKEN must not be inherited (got ${parsed.t})`)
      assert.equal(parsed.s, '', `HELMX_EXECUTION_SCOPE must not be inherited (got ${parsed.s})`)
    } finally {
      if (prevToken === undefined) delete process.env.HELMX_TOKEN
      else process.env.HELMX_TOKEN = prevToken
      if (prevScope === undefined) delete process.env.HELMX_EXECUTION_SCOPE
      else process.env.HELMX_EXECUTION_SCOPE = prevScope
    }
  })
})
