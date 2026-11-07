import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createHerdrTransport } from '../src/builtin-plugins/herdr/transport.js'

/**
 * 生产远端通道取消与输出限额回归：
 * - 用真实 python3 -u - 执行生产 stdin 脚本（ssh 入口由 fixture 替换，业务脚本未替换）
 * - Gate abort 后：Node 侧 TERM->KILL 宽限终止 ssh 组；远端哨兵进程组必须死亡
 * - 无限输出在 1MiB 限额处立即失败（流式判定，非先聚合后检查）
 * fixture 只清理自己创建的哨兵进程组。
 */

async function pythonChannel(t: TestContext, root: string) {
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec /usr/bin/python3 -u -\n', { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath ?? ''}`
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
}

/** 哨兵：Gate 子进程启动一个独立进程组的 sleep；写 pid 文件供断言存活性。 */
function sentinelScript(root: string): string {
  return `mkdir -p '${root}/.helm'; (sleep 300) & echo \$! > '${root}/.helm/sentinel.pid'; wait`
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`${label} 未在 ${timeoutMs}ms 内满足`)
}

test('远端 Gate abort 后哨兵进程组被清理（生产 stdin 脚本）', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-gate-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await pythonChannel(t, root)
  const transport = createHerdrTransport()
  const controller = new AbortController()
  const pending = transport.runGate({ machine: 'fixture-host' }, sentinelScript(root), root, controller.signal, {
    GATE_ROOT: root,
  })
  const sentinelPidFile = join(root, '.helm', 'sentinel.pid')
  // 等哨兵 pid 文件出现（Gate 已真正 spawn）
  await pollUntil(
    async () => {
      try {
        await import('node:fs/promises').then((fs) => fs.readFile(sentinelPidFile, 'utf8'))
        return true
      } catch {
        return false
      }
    },
    20_000,
    '哨兵 pid 文件出现',
  )
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof Error)
  // 哨兵进程组必须死亡：kill(pid,0) 报 ESRCH 即退出。
  const fs = await import('node:fs/promises')
  const pid = Number.parseInt((await fs.readFile(sentinelPidFile, 'utf8')).trim(), 10)
  await pollUntil(
    async () => {
      try {
        process.kill(pid, 0)
        return false
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH'
      }
    },
    30_000,
    '哨兵进程退出（TERM 宽限后 KILL）',
  )
})

test('远端 Gate 无限输出在限额处流式失败，不先聚合（生产 stdin 脚本）', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-gate-overflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await pythonChannel(t, root)
  const transport = createHerdrTransport()
  // yes 持续输出远超 1MiB；有界 select 循环必须在上限处杀组并显式失败。
  const result = await transport.runGate({ machine: 'fixture-host' }, 'yes 0123456789', root)
  assert.equal(result.ok, false)
  assert.ok(result.output.includes('exceeded'), `超限信息应包含 exceeded：${JSON.stringify(result.output.slice(0, 120))}`)
  assert.ok(result.output.length < 200, '超限时不得返回截断后的巨量输出')
})

test('远端长 wait RPC 在通道死亡后退出（生产 stdin 脚本 + 真实 UDS）', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wait-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await pythonChannel(t, root)
  const socketPath = join(root, 'herdr.sock')
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('data', () => {
      /* 收到请求后永久静默：模拟无响应的 agent.wait */
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })

  const transport = createHerdrTransport()
  const controller = new AbortController()
  const pending = transport.call({ machine: 'fixture-host', socketPath }, 'agent.wait', { target: 'p1' }, { signal: controller.signal, timeoutMs: undefined })
  const observed = pending.then(() => undefined, (error: unknown) => error)
  await new Promise((resolve) => setTimeout(resolve, 600)) // 让请求真正发出
  controller.abort()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 3_000)
  })
  const error = await Promise.race([observed, deadline])
  clearTimeout(timer)
  assert.ok(error, '通道死亡后长 wait 必须在限期内结算')
  assert.equal((error as { code?: string }).code, 'herdr_aborted')
})
