import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import type { TurnSettledPayload } from '@helm/protocol'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-settlement-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
  return { kernel, faux, async close() { try { await kernel.close() } finally { await rm(dataDir, { recursive: true, force: true }) } } }
}

const nextLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

test('waitForIdle 等待真实回合的异步 turn_settled，回调携带已推进的终态水位', { timeout: 60_000 }, async () => {
  const env = await fixture()
  const started = deferred()
  const release = deferred()
  let settled = false
  let settlement: TurnSettledPayload | undefined
  try {
    await env.kernel.plugins.register({
      id: 'test:async-settlement',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled(async (turn) => {
          settlement = turn
          started.resolve()
          await release.promise
          settled = true
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('完成')])
    await env.kernel.submitInput(1, '执行任务')
    await started.promise
    assert.equal(settlement!.conversation.completionSeq, env.kernel.getConversation(1).completionSeq)
    assert.equal(settlement!.conversation.stateChangeSeq, env.kernel.getConversation(1).stateChangeSeq)
    assert.equal(settlement!.conversation.status, 'done')
    let idleReturned = false
    const waiting = env.kernel.waitForIdle(1).then(() => { idleReturned = true })
    await nextLoop()
    assert.equal(idleReturned, false, '异步结算尚未完成，不应返回空闲')
    release.resolve()
    await waiting
    assert.equal(settled, true)
  } finally {
    release.resolve()
    await env.close()
  }
})

test('输入 Hook 等待期间关停，释放后拒绝写入和启动新回合', { timeout: 60_000 }, async () => {
  const env = await fixture()
  const entered = deferred()
  const release = deferred()
  let submission: Promise<unknown> | undefined
  try {
    await env.kernel.plugins.register({
      id: 'test:closing-input',
      definePlugin(ctx) {
        ctx.hook.onInput(async () => {
          entered.resolve()
          await release.promise
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('不应启动')])
    submission = env.kernel.submitInput(1, '待入队的后台汇报').catch((error: unknown) => error)
    await entered.promise
    await env.kernel.close()
    release.resolve()
    assert.equal((await submission as { code?: string }).code, 'runtime_closed')
    assert.equal(env.faux.getPendingResponseCount(), 1)
  } finally {
    release.resolve()
    await submission
    await env.close()
  }
})

test('close 等待所有并发会话的结算，不仅等待最后发起的一项', { timeout: 60_000 }, async () => {
  const env = await fixture()
  const bothStarted = deferred()
  const order: number[] = []
  const releases = new Map<number, ReturnType<typeof deferred>>()
  let closing: Promise<void> | undefined
  try {
    const second = await env.kernel.createConversation({})
    releases.set(1, deferred())
    releases.set(second.id, deferred())
    await env.kernel.plugins.register({
      id: 'test:concurrent-settlement',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled(async (turn) => {
          order.push(turn.conversation.id)
          if (order.length === 2) bothStarted.resolve()
          await releases.get(turn.conversation.id)!.promise
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('甲完成'), fauxAssistantMessage('乙完成')])
    await Promise.all([
      env.kernel.submitInput(1, '任务甲'),
      env.kernel.submitInput(second.id, '任务乙'),
    ])
    await bothStarted.promise
    let closed = false
    closing = env.kernel.close().then(() => { closed = true })
    releases.get(order[1]!)!.resolve()
    await nextLoop()
    await nextLoop()
    assert.equal(closed, false, '较早回合仍在结算，不能关闭宿主')
    releases.get(order[0]!)!.resolve()
    await closing
  } finally {
    for (const gate of releases.values()) gate.resolve()
    await closing
    await env.close()
  }
})
