import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createHerdrTransport } from '../src/builtin-plugins/herdr/transport.js'
import { MutableNodeChannel, nodeFixture, pollUntil } from './herdr-node-fixture.js'

/**
 * 节点通道 Gate 生产回归（真实 LocalNodeChannel + 真实 UDS；取代假 ssh + python3）：
 * - Gate abort 后：底层命令进程组必须死亡（NodeExecutionEnv killProcessTree SIGKILL）；
 * - 无限输出在 1MiB 限额处立即取消并显式失败（流式判定，非先聚合后检查）；
 * - 长通道 call 取消后立即结算。
 */

/** 哨兵：Gate 子进程启动一个独立进程组的 sleep；写 pid 文件供断言存活性。 */
function sentinelScript(root: string): string {
  return `mkdir -p '${root}/.helm'; (sleep 300) & echo \$! > '${root}/.helm/sentinel.pid'; wait`
}

test('远端节点 Gate abort 后哨兵进程组被清理（真实节点通道）', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-gate-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await nodeFixture(t)
  const channel = new MutableNodeChannel()
  channel.nodes.set('gate-node', { online: true, channel: fixture.channel })
  const transport = createHerdrTransport({ nodeChannel: channel })
  const controller = new AbortController()
  const pending = transport.runGate({ nodeId: 'gate-node' }, sentinelScript(root), root, controller.signal, {
    GATE_ROOT: root,
  })
  const sentinelPidFile = join(root, '.helm', 'sentinel.pid')
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
    '哨兵进程退出（abort 后整组清理）',
  )
})

test('远端节点 Gate 无限输出在限额处流式失败，不先聚合', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-gate-overflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await nodeFixture(t)
  const channel = new MutableNodeChannel()
  channel.nodes.set('gate-node', { online: true, channel: fixture.channel })
  const transport = createHerdrTransport({ nodeChannel: channel })
  // yes 持续输出远超 1MiB；流式 onOutput 必须在上限处取消命令并显式失败。
  const result = await transport.runGate({ nodeId: 'gate-node' }, 'yes 0123456789', root)
  assert.equal(result.ok, false)
  assert.ok(result.output.includes('exceeded'), `超限信息应包含 exceeded：${JSON.stringify(result.output.slice(0, 120))}`)
  assert.ok(result.output.length < 200, '超限时不得返回截断后的巨量输出')
})

test('远端节点 Gate 关闭输出后仍须等待命令正常退出', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helm-gate-quiet-'))
  await mkdir(root, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await nodeFixture(t)
  const channel = new MutableNodeChannel()
  channel.nodes.set('gate-node', { online: true, channel: fixture.channel })
  const transport = createHerdrTransport({ nodeChannel: channel })
  const result = await transport.runGate(
    { nodeId: 'gate-node' },
    'exec >/dev/null 2>&1; sleep 0.05; printf done > finished',
    root,
  )
  assert.deepEqual(result, { ok: true, output: '' })
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(join(root, 'finished'), 'utf8'), 'done')
})
