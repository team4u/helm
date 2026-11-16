/**
 * node side envPathUsage RPC and managed environment variable strip except test (real NodeEnvRpcServer).
 *
 * override:
 * - real /proc: this test process itself spawn child process with target directory is cwd → snapshot hit
 *   (pid/source/cwd path); child process exit after heavy scan clean (root host complete=true);
 * - this test process hold has target tree inside file open fd → fd hit;
 * - fixture procRoot(symlink fabricate cwd/fd)→ hit and boundary (/a does not match /ab);
 * - platform inject non- Linux → explicit not_supported(do not fabricate across platform result);
 * - reference strictly validate: unknown field / relative path / NUL / non- object → invalid;
 * - managed environment variable strip except:daemon host env  HELM_TOKEN / HELM_EXECUTION_SCOPE
 *   never via inherit enter sub- command (envExec and LocalExecutionEnv.exec direct connect two opening path);
 *   caller explicit inject legal value by time takes effect.
 *
 * honest:EACCES branch cannot in root host real re- now, by env-io inject io single test override
 * (packages/env-io/test/path-usage.test.ts); this where only test real can verify behavior.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupDir, makeTempDir } from '@helm/test-kit/node'
import { createNodeEnvRpcServer, type NodeEnvRpcServer } from '../src/index.js'
import { LocalExecutionEnv } from '../src/daemon/local-env.js'

let rootDir: string
let server: NodeEnvRpcServer

before(async () => {
  rootDir = await makeTempDir('helm-node-pathusage-')
  server = createNodeEnvRpcServer({ defaultCwd: rootDir })
})

after(async () => {
  await server.dispose().catch(() => undefined)
  await cleanupDir(rootDir)
})

/** with target is cwd start long resident child process (real occupy; never use scan target as helper start way with outside purpose). */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  assert.ok(child.pid !== undefined, 'child process should has pid')
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
  it('child process cwd occupy: hit pid and path; exit after heavy scan clean (complete do not assume root)', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'wt-a')
    mkdirSync(target, { recursive: true })
    if (process.platform !== 'linux') {
      // non- Linux: explicit not_supported(do not fabricate result, not silently skip).
      const unsupported = await server.envPathUsage!({ path: target })
      assert.equal(unsupported.ok, false)
      if (unsupported.ok) return
      assert.equal(unsupported.error.code, 'not_supported')
      return
    }
    const holder = holdProcess(target)
    try {
      const r = await server.envPathUsage!({ path: target })
      assert.equal(r.ok, true, `scan should succeeded:${r.ok ? '' : r.error.message}`)
      if (!r.ok) return
      const hit = r.value.processes.find((p) => p.pid === holder.pid)
      assert.ok(hit, `should hit child process ${holder.pid}:${JSON.stringify(r.value.processes)}`)
      assert.equal(hit!.source, 'cwd')
      assert.equal(hit!.path, target)
      assert.equal(typeof hit!.name, 'string', 'should contains process name (comm)')
      // complete do not assume root: non- complete environment must carry fail-closed diagnose; permission refuse read
      // (across uid or non-dumpable, such as systemd --user) count unobservable and does not affect complete.
      assert.equal(typeof r.value.complete, 'boolean')
      assert.equal(typeof r.value.unobservable, 'number', 'snapshot must carry blind spot counter')
      assert.ok(r.value.unobservable >= 0, 'blind spot counter must be non- negative integer')
      if (r.value.complete !== true) {
        assert.ok(r.value.diagnostics.length > 0, 'complete=false must carry do not complete diagnose')
      }
    } finally {
      await holder.stop()
    }
    // process exit after: the pid no longer hit (snapshot such as reverse reflect when before fact).
    const after = await server.envPathUsage!({ path: target })
    assert.equal(after.ok, true)
    if (!after.ok) return
    assert.equal(after.value.processes.some((p) => p.pid === holder.pid), false, 'exit process must not leftover hit')
  })

  it('this process open fd occupy: target tree inside file open description symbol hit (source=fd)', { timeout: 60_000 }, async () => {
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
      assert.ok(hit, `should hit this process fd:${JSON.stringify(r.value.processes.filter((p) => p.pid === process.pid))}`)
      assert.equal(hit!.path, held)
    } finally {
      closeSync(fd)
    }
  })
})

describe('envPathUsage:fixture procRoot and boundary', { timeout: 60_000 }, () => {
  it('fabricate /proc tree (symlink cwd/fd): hit and path amount boundary (/a does not match /ab)', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'real-wt')
    mkdirSync(target, { recursive: true })
    const fakeProc = join(rootDir, 'fake-proc')
    mkdirSync(join(fakeProc, '42', 'fd'), { recursive: true })
    symlinkSync(join(target, 'sub'), join(fakeProc, '42', 'cwd'))
    symlinkSync(join(target, 'file.txt'), join(fakeProc, '42', 'fd', '3'))
    writeFileSync(join(target, 'file.txt'), 'x')
    mkdirSync(join(target, 'sub'))
    // boundary:/real-wt neighbor reside /real-wtb must not hit.
    mkdirSync(join(rootDir, 'real-wtb'), { recursive: true })
    const fixtureServer = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { procRoot: fakeProc } })
    try {
      const r = await fixtureServer.envPathUsage!({ path: target })
      assert.equal(r.ok, true)
      if (!r.ok) return
      // same PID(42)cwd+fd dedupe: one process one counter, first reference cwd takes precedence.
      assert.equal(r.value.matchedTotal, 1, 'same PID cwd+fd dedupe after single counter')
      assert.equal(r.value.processes.length, 1)
      assert.equal(r.value.processes[0]!.pid, 42)
      assert.equal(r.value.processes[0]!.source, 'cwd')
      assert.equal(r.value.complete, true, 'fixture inside without permission reject → complete')

      const neighbor = await fixtureServer.envPathUsage!({ path: join(rootDir, 'real-wtb') })
      assert.equal(neighbor.ok, true)
      if (!neighbor.ok) return
      assert.equal(neighbor.value.matchedTotal, 0, 'prefix each other similar but amount boundary different path must not mistakenly hit')
    } finally {
      await fixtureServer.dispose().catch(() => undefined)
    }
  })

  it('platform inject darwin/win32: explicit not_supported(do not fabricate across platform result)', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32']) {
      const s = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { platform: () => platform } })
      try {
        const r = await s.envPathUsage!({ path: '/wt' })
        assert.equal(r.ok, false, `${platform} should explicit reject`)
        if (r.ok) continue
        assert.equal(r.error.code, 'not_supported')
        assert.ok(r.error.message.includes(platform))
      } finally {
        await s.dispose().catch(() => undefined)
      }
    }
  })

  it('reference strictly validate: unknown field / non- object / relative path / NUL → invalid', { timeout: 60_000 }, async () => {
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
      assert.equal(r.error.code, 'invalid', `${JSON.stringify(input)} → invalid(got ${r.error.code})`)
    }
  })
})

describe('managed environment variable strip except (HELM_TOKEN / HELM_EXECUTION_SCOPE)', { timeout: 60_000 }, () => {
  /** use node itself probe child process env(independent of sh, across platform same construct). */
  const probeEnvCommand = (): string[] => [
    process.execPath,
    '-e',
    "console.log(JSON.stringify({t: process.env.HELM_TOKEN ?? '', s: process.env.HELM_EXECUTION_SCOPE ?? ''}))",
  ]

  it('envExec:daemon host env managed value does not enter sub- command; caller explicit inject by time takes effect', { timeout: 60_000 }, async () => {
    const prevToken = process.env.HELM_TOKEN
    const prevScope = process.env.HELM_EXECUTION_SCOPE
    process.env.HELM_TOKEN = 'daemon-own-secret'
    process.env.HELM_EXECUTION_SCOPE = 'stale-daemon-scope'
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
      assert.equal(parsed.t, '', `HELM_TOKEN must not inherit (got ${parsed.t})`)
      assert.equal(parsed.s, '', `HELM_EXECUTION_SCOPE must not inherit (got ${parsed.s})`)

      // caller explicit inject (Hub by time together into): by time takes effect.
      const chunks2: string[] = []
      const echoServer2 = createNodeEnvRpcServer({
        defaultCwd: rootDir,
        onExecOutput: (e) => chunks2.push(e.text),
      })
      try {
        const r2 = await echoServer2.envExec({
          execId: 'strip-2',
          command: probeEnvCommand(),
          env: { HELM_EXECUTION_SCOPE: 'worktree:node-x:/wt' },
        })
        assert.equal(r2.ok, true)
        const parsed2 = JSON.parse(chunks2.join('').trim()) as { s?: string }
        assert.equal(parsed2.s, 'worktree:node-x:/wt', 'explicit inject value must by time takes effect')
      } finally {
        await echoServer2.dispose().catch(() => undefined)
      }
    } finally {
      await echoServer.dispose().catch(() => undefined)
      if (prevToken === undefined) delete process.env.HELM_TOKEN
      else process.env.HELM_TOKEN = prevToken
      if (prevScope === undefined) delete process.env.HELM_EXECUTION_SCOPE
      else process.env.HELM_EXECUTION_SCOPE = prevScope
    }
  })

  it('LocalExecutionEnv.exec direct connect (inheritEnv by default open start): inherit base bottom same strip except managed value', { timeout: 60_000 }, async () => {
    const prevToken = process.env.HELM_TOKEN
    const prevScope = process.env.HELM_EXECUTION_SCOPE
    process.env.HELM_TOKEN = 'daemon-own-secret'
    process.env.HELM_EXECUTION_SCOPE = 'stale-daemon-scope'
    const env = new LocalExecutionEnv({ cwd: rootDir })
    let out = ''
    try {
      const r = await env.exec(
        probeEnvCommand(),
        { onOutput: (text) => { out += text } },
        undefined as never,
      )
      assert.equal(r.ok, true, r.ok ? '' : r.error.message)
      const parsed = JSON.parse(out.trim()) as { t?: string; s?: string }
      assert.equal(parsed.t, '', `HELM_TOKEN must not inherit (got ${parsed.t})`)
      assert.equal(parsed.s, '', `HELM_EXECUTION_SCOPE must not inherit (got ${parsed.s})`)
    } finally {
      if (prevToken === undefined) delete process.env.HELM_TOKEN
      else process.env.HELM_TOKEN = prevToken
      if (prevScope === undefined) delete process.env.HELM_EXECUTION_SCOPE
      else process.env.HELM_EXECUTION_SCOPE = prevScope
    }
  })
})
