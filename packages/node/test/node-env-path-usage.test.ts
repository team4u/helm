/**
 * 节点侧 envPathUsage RPC 与受管环境变量剥除测试（真实 NodeEnvRpcServer）。
 *
 * 覆盖：
 * - 真实 /proc：本测试进程自身 spawn 的子进程以目标目录为 cwd → 快照命中
 *   （pid/source/cwd 路径）；子进程退出后重扫干净（root 宿主 complete=true）；
 * - 本测试进程持有目标树内文件的打开 fd → fd 命中；
 * - fixture procRoot（symlink 伪造 cwd/fd）→ 命中与边界（/a 不匹配 /ab）；
 * - 平台注入非 Linux → 显式 not_supported（不伪造跨平台结果）；
 * - 入参严格校验：未知字段 / 相对路径 / NUL / 非对象 → invalid；
 * - 受管环境变量剥除：daemon 宿主 env 的 HELM_TOKEN / HELM_EXECUTION_SCOPE
 *   绝不经继承进入子命令（envExec 与 LocalExecutionEnv.exec 直连两口径）；
 *   调用方显式注入的合法值按次生效。
 *
 * 诚实性：EACCES 分支无法在 root 宿主真实复现，由 protocol 注入 io 单测覆盖
 * （packages/protocol/test/path-usage.test.ts）；此处只测真实可证行为。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeEnvRpcServer, type NodeEnvRpcServer } from '../src/index.js'
import { LocalExecutionEnv } from '../src/daemon/local-env.js'

let rootDir: string
let server: NodeEnvRpcServer

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-node-pathusage-'))
  server = createNodeEnvRpcServer({ defaultCwd: rootDir })
})

after(async () => {
  await server.dispose().catch(() => undefined)
  rmSync(rootDir, { recursive: true, force: true })
})

/** 以 target 为 cwd 启动长驻子进程（真实占用；绝不用扫描目标作为 helper 的启动方式以外用途）。 */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  assert.ok(child.pid !== undefined, '子进程应有 pid')
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

describe('envPathUsage：真实 /proc', { timeout: 60_000 }, () => {
  it('子进程 cwd 占用：命中 pid 与路径；退出后重扫干净（完整性不假设 root）', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'wt-a')
    mkdirSync(target, { recursive: true })
    if (process.platform !== 'linux') {
      // 非 Linux：显式 not_supported（不伪造结果、不静默跳过）。
      const unsupported = await server.envPathUsage!({ path: target })
      assert.equal(unsupported.ok, false)
      if (unsupported.ok) return
      assert.equal(unsupported.error.code, 'not_supported')
      return
    }
    const holder = holdProcess(target)
    try {
      const r = await server.envPathUsage!({ path: target })
      assert.equal(r.ok, true, `扫描应成功：${r.ok ? '' : r.error.message}`)
      if (!r.ok) return
      const hit = r.value.processes.find((p) => p.pid === holder.pid)
      assert.ok(hit, `应命中子进程 ${holder.pid}：${JSON.stringify(r.value.processes)}`)
      assert.equal(hit!.source, 'cwd')
      assert.equal(hit!.path, target)
      assert.equal(typeof hit!.name, 'string', '应含进程名（comm）')
      // 完整性不假设 root：非完整环境必须携带 fail-closed 诊断。
      assert.equal(typeof r.value.complete, 'boolean')
      if (r.value.complete !== true) {
        assert.ok(r.value.diagnostics.length > 0, 'complete=false 必须携带不完整诊断')
      }
    } finally {
      await holder.stop()
    }
    // 进程退出后：该 pid 不再命中（快照如实反映当前事实）。
    const after = await server.envPathUsage!({ path: target })
    assert.equal(after.ok, true)
    if (!after.ok) return
    assert.equal(after.value.processes.some((p) => p.pid === holder.pid), false, '退出进程不得残留命中')
  })

  it('本进程打开 fd 占用：目标树内文件的打开描述符命中（source=fd）', { timeout: 60_000 }, async () => {
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
      assert.ok(hit, `应命中本进程 fd：${JSON.stringify(r.value.processes.filter((p) => p.pid === process.pid))}`)
      assert.equal(hit!.path, held)
    } finally {
      closeSync(fd)
    }
  })
})

describe('envPathUsage：fixture procRoot 与边界', { timeout: 60_000 }, () => {
  it('伪造 /proc 树（symlink cwd/fd）：命中与路径分量边界（/a 不匹配 /ab）', { timeout: 60_000 }, async () => {
    const target = join(rootDir, 'real-wt')
    mkdirSync(target, { recursive: true })
    const fakeProc = join(rootDir, 'fake-proc')
    mkdirSync(join(fakeProc, '42', 'fd'), { recursive: true })
    symlinkSync(join(target, 'sub'), join(fakeProc, '42', 'cwd'))
    symlinkSync(join(target, 'file.txt'), join(fakeProc, '42', 'fd', '3'))
    writeFileSync(join(target, 'file.txt'), 'x')
    mkdirSync(join(target, 'sub'))
    // 边界：/real-wt 的邻居 /real-wtb 不得命中。
    mkdirSync(join(rootDir, 'real-wtb'), { recursive: true })
    const fixtureServer = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { procRoot: fakeProc } })
    try {
      const r = await fixtureServer.envPathUsage!({ path: target })
      assert.equal(r.ok, true)
      if (!r.ok) return
      // 同 PID（42）cwd+fd 去重：一进程一计数，首个引用 cwd 优先。
      assert.equal(r.value.matchedTotal, 1, '同 PID cwd+fd 去重后单计数')
      assert.equal(r.value.processes.length, 1)
      assert.equal(r.value.processes[0]!.pid, 42)
      assert.equal(r.value.processes[0]!.source, 'cwd')
      assert.equal(r.value.complete, true, 'fixture 内无权限拒绝 → 完整')

      const neighbor = await fixtureServer.envPathUsage!({ path: join(rootDir, 'real-wtb') })
      assert.equal(neighbor.ok, true)
      if (!neighbor.ok) return
      assert.equal(neighbor.value.matchedTotal, 0, '前缀相似但分量边界不同的路径不得误命中')
    } finally {
      await fixtureServer.dispose().catch(() => undefined)
    }
  })

  it('平台注入 darwin/win32：显式 not_supported（不伪造跨平台结果）', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32']) {
      const s = createNodeEnvRpcServer({ defaultCwd: rootDir, pathUsage: { platform: () => platform } })
      try {
        const r = await s.envPathUsage!({ path: '/wt' })
        assert.equal(r.ok, false, `${platform} 应显式拒绝`)
        if (r.ok) continue
        assert.equal(r.error.code, 'not_supported')
        assert.ok(r.error.message.includes(platform))
      } finally {
        await s.dispose().catch(() => undefined)
      }
    }
  })

  it('入参严格校验：未知字段 / 非对象 / 相对路径 / NUL → invalid', { timeout: 60_000 }, async () => {
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
      assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(input)}`)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid', `${JSON.stringify(input)} → invalid（实得 ${r.error.code}）`)
    }
  })
})

describe('受管环境变量剥除（HELM_TOKEN / HELM_EXECUTION_SCOPE）', { timeout: 60_000 }, () => {
  /** 用 node 自身探测子进程 env（不依赖 sh，跨平台同构）。 */
  const probeEnvCommand = (): string[] => [
    process.execPath,
    '-e',
    "console.log(JSON.stringify({t: process.env.HELM_TOKEN ?? '', s: process.env.HELM_EXECUTION_SCOPE ?? ''}))",
  ]

  it('envExec：daemon 宿主 env 的受管值不进入子命令；调用方显式注入按次生效', { timeout: 60_000 }, async () => {
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
      assert.equal(parsed.t, '', `HELM_TOKEN 不得继承（实得 ${parsed.t}）`)
      assert.equal(parsed.s, '', `HELM_EXECUTION_SCOPE 不得继承（实得 ${parsed.s}）`)

      // 调用方显式注入（Hub 按次合成）：按次生效。
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
        assert.equal(parsed2.s, 'worktree:node-x:/wt', '显式注入值必须按次生效')
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

  it('LocalExecutionEnv.exec 直连（inheritEnv 默认开启）：继承基底同样剥除受管值', { timeout: 60_000 }, async () => {
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
      assert.equal(parsed.t, '', `HELM_TOKEN 不得继承（实得 ${parsed.t}）`)
      assert.equal(parsed.s, '', `HELM_EXECUTION_SCOPE 不得继承（实得 ${parsed.s}）`)
    } finally {
      if (prevToken === undefined) delete process.env.HELM_TOKEN
      else process.env.HELM_TOKEN = prevToken
      if (prevScope === undefined) delete process.env.HELM_EXECUTION_SCOPE
      else process.env.HELM_EXECUTION_SCOPE = prevScope
    }
  })
})
