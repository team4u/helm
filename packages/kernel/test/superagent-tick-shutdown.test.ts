import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { KernelRuntime } from '../src/runtime/index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('关闭等待已进入管道的巡检，插件释放前完成 Doc 写入', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-tick-close-'))
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
  const entered = deferred()
  const release = deferred()
  let tick: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  let wrote = false
  try {
    await kernel.plugins.register({
      id: 'test:tick-close',
      definePlugin(ctx) {
        const doc = ctx.doc('result', { finished: false })
        ctx.hook.onWatchdogTick(async () => {
          entered.resolve()
          await release.promise
          doc.set({ finished: true })
          wrote = true
        })
      },
    })
    tick = kernel.watchdogTick()
    await entered.promise
    let closed = false
    closing = kernel.close().then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false)
    release.resolve()
    await tick
    await closing
    assert.equal(wrote, true)
    await assert.rejects(kernel.watchdogTick(), (error: unknown) => (error as { code?: string }).code === 'runtime_closed')
  } finally {
    release.resolve()
    await Promise.allSettled([tick, closing])
    try { await kernel.close() } finally { await rm(dataDir, { recursive: true, force: true }) }
  }
})
