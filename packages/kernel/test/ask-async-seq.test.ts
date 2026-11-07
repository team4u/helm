/**
 * AskService 异步 seq resolver 契约测试：真实 AskService + 真实 SQLite。
 *
 * 背景（herdr Ask CAS）：同步缓存 resolver 会在远端 poll 间隙把已过期 Ask 的
 * 目标 seq 报成旧水位，导致 answerAsk 用过期视图做 CAS。resolver 需要发起
 * 真实异步 IO（agent.get）拿终端当前水位，因此内核通用机制升级为
 * MaybePromise<number | undefined>，并在 await 返回后、写入任何终态副作用
 * （supersede/answer/stash）之前重读持久行，校验等待期间未被并发结算。
 *
 * 契约：
 * - resolver 可同步或异步；首个返回合法非负 safe integer 的结果即权威 seq；
 * - 非法 seq（NaN/负数/小数/超出 safe integer/非数值类型）显式失败，
 *   不截断、不默认 0、不静默跳过；resolver 抛错（含异步 reject）如实上抛，
 *   ask 保持 pending、stash 无写入；
 * - async 返回新水位 -> superseded（不是 answered），secret 不入 stash；
 * - async 返回同水位 -> answered 一次（一条 ask.resolved 事件）；
 * - resolver 挂起期间并发 cancel / 并发 answer：等待方返回后重读行，
 *   已结算 -> 409 ask_already_settled，不覆盖旧结果、不重复事件、不写 stash；
 *   行被删除 -> 404；
 * - 持久 CAS spec 等待期间改变（expectedStateSeq 推进）：按新权威条件拒绝
 *   旧客户端数据（409 ask_state_conflict），不覆写；
 * - 前一个 resolver 异步返回 undefined 后继续尝试下一个 resolver；
 * - 同步 resolver 与无 CAS ask 的原行为保持（不引入多余异步间隙——答案
 *   校验在重读行之后依然基于最新持久 spec）。
 */

import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { SecretStash } from '../src/services/index.js'

interface TestContext {
  service: AskService
  store: HelmStore
  stash: SecretStash
  events: Array<{ type: string; payload: unknown }>
  close(): Promise<void>
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-ask-async-seq-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function openService(): Promise<TestContext> {
  const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
  const store = new HelmStore(db)
  await store.load()
  const stash = new SecretStash()
  const events: Array<{ type: string; payload: unknown }> = []
  const service = new AskService({
    store,
    stash,
    onEvent: (type, payload) => events.push({ type, payload }),
    onConvPendingChanged: () => {},
  })
  return {
    service,
    store,
    stash,
    events,
    async close() {
      await store.close()
      await db.close()
    },
  }
}

/** 手写 deferred（不用 sleep 对齐并发时序）。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  isSettled(): boolean
}

function deferred<T>(): Deferred<T> {
  let settled = false
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (settled) return
      settled = true
      res(value)
    }
    reject = (error) => {
      if (settled) return
      settled = true
      rej(error)
    }
  })
  return {
    promise,
    resolve,
    reject,
    isSettled: () => settled,
  }
}

/** secret 字段 spec：用于断言 stash 无泄漏。 */
const secretSpec: { conversationId: number; title: string; expectedStateSeq: number; id?: string; fields: Array<{ name: string; label: string; type: 'text'; secret: boolean; required: boolean }> } = {
  conversationId: 1,
  title: '终端确认',
  expectedStateSeq: 10,
  fields: [{ name: 'TOKEN', label: 'Token', type: 'text', secret: true, required: true }],
}

async function createPending(service: AskService, spec: typeof secretSpec): Promise<string> {
  void service.createAsk(spec).catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  const ask = service.listAsks('pending').find((a) => a.id === spec.id)
  assert.ok(ask !== undefined, 'ask 必须已持久为 pending')
  return ask.id
}

// ---------------------------------------------------------------------------

describe('异步 seq resolver：水位判定与诚实失败', { timeout: 60_000 }, () => {
  it('async 新水位 -> superseded 而非 answered，secret 不入 stash', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'async-new-seq' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(async (askId) => {
        assert.equal(askId, 'async-new-seq')
        await gate.promise
        return 11
      })
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      gate.resolve()
      const result = await answering
      assert.equal(result.status, 'superseded')
      // superseded 绝不写答案、secret 不入 stash、事件恰一条 resolved。
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'superseded')
      assert.equal(row.resultJson, undefined)
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      const resolvedEvents = ctx.events.filter((e) => e.type === 'ask.resolved')
      assert.equal(resolvedEvents.length, 1)
      assert.deepEqual(resolvedEvents[0]!.payload, { askId: id, status: 'superseded' })
    } finally {
      await ctx.close()
    }
  })

  it('async 同水位 -> answered 恰一次（单事件、持久结果含 marker）', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'async-same-seq' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(async () => {
        await gate.promise
        return 10
      })
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      gate.resolve()
      const result = await answering
      assert.equal(result.status, 'answered')
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'answered')
      assert.ok(row.resultJson!.startsWith('{"TOKEN":"[REDACTED:stash:'))
      assert.equal(ctx.stash.envFor(1).TOKEN, 'plain-secret')
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('resolver 挂起期间并发 cancel：等待方 409 ask_already_settled，不覆盖、不写 stash', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'cancel-race' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      // 等待期间另一路径完成销单（真实场景：终端事件触发 cancel）。
      const cancelled = await ctx.service.cancelAsk(id, 'cancelled')
      assert.equal(cancelled.status, 'cancelled')
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // 旧结果不被覆盖：仍为 cancelled、无答案、stash 无 secret、事件无重复。
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'cancelled')
      assert.equal(row.resultJson, undefined)
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('两个并发 answer：先结算者胜，后到者 409（deferred 对齐，无 sleep）', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'answer-race' })
      const firstGate = deferred<void>()
      const secondGate = deferred<void>()
      let calls = 0
      ctx.service.registerSeqResolver(() => {
        calls += 1
        return (calls === 1 ? firstGate : secondGate).promise.then(() => 10)
      })
      const first = ctx.service.answerAsk(id, { TOKEN: 'first-answer' })
      const second = ctx.service.answerAsk(id, { TOKEN: 'second-answer' })
      // 第一个 answer 穿过 resolver 后放行第二个：两者都经历完整 CAS 流程。
      firstGate.resolve()
      const firstResult = await first
      assert.equal(firstResult.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      secondGate.resolve()
      await assert.rejects(
        () => second,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // 先到者结果保持：第二份答案既不覆盖持久结果也不改写 stash。
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'answered')
      assert.ok(!row.resultJson!.includes('second-answer'))
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('等待期间持久 CAS spec 改变（expectedStateSeq 推进）：按新权威条件拒绝旧数据', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'spec-race' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      // 模拟等待期间同 ask 行被重建为更高水位（预分配 ID 冲突路径之外的直接行改写）。
      const row = ctx.store.getAsk(id)!
      const spec = JSON.parse(row.specJson) as { expectedStateSeq?: number }
      ctx.store.putAsk({ ...row, expectedStateSeq: 20, specJson: JSON.stringify({ ...spec, expectedStateSeq: 20 }) })
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'ask_state_conflict' &&
          (err.details as { storedSeq?: number } | undefined)?.storedSeq === 20,
      )
      // 行未被覆写为旧水位答案：保持 pending 且 stash 无写入。
      const after = ctx.store.getAsk(id)!
      assert.equal(after.status, 'pending')
      assert.equal(after.expectedStateSeq, 20)
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('resolver 失败（同步抛错与异步 reject）：如实上抛、ask 保持 pending、无 stash 写入', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'resolver-sync-fail' })
      const releaseSync = ctx.service.registerSeqResolver(() => {
        throw new Error('resolver 同步故障')
      })
      await assert.rejects(
        () => ctx.service.answerAsk(id, { TOKEN: 'v' }),
        (err: unknown) => err instanceof Error && err.message === 'resolver 同步故障',
      )
      assert.equal(ctx.store.getAsk(id)!.status, 'pending')
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      releaseSync()

      const id2 = await createPending(ctx.service, { ...secretSpec, id: 'resolver-async-fail' })
      ctx.service.registerSeqResolver(async () => {
        throw new HelmError('ask_state_unavailable', '远端 agent.get 失败', 502)
      })
      await assert.rejects(
        () => ctx.service.answerAsk(id2, { TOKEN: 'v' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_state_unavailable',
      )
      assert.equal(ctx.store.getAsk(id2)!.status, 'pending')
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      // 两条 ask 都未产生终态事件。
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('非法 seq（NaN/负/小数/unsafe/坏类型）显式失败：不截断、不默认 0、不静默跳过', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const bads: Array<{ label: string; value: unknown }> = [
        { label: 'NaN', value: Number.NaN },
        { label: '负数', value: -1 },
        { label: '小数', value: 10.5 },
        { label: '超出 safe integer', value: Number.MAX_SAFE_INTEGER + 1 },
        { label: '字符串', value: '10' },
        { label: 'null', value: null },
      ]
      for (const bad of bads) {
        const id = `bad-seq-${bad.label}`
        await createPending(ctx.service, { ...secretSpec, id })
        ctx.service.registerSeqResolver(() => bad.value as never)
        await assert.rejects(
          () => ctx.service.answerAsk(id, { TOKEN: 'v' }),
          (err: unknown) =>
            err instanceof HelmError && err.code === 'ask_seq_resolver_invalid',
          `非法 seq ${bad.label} 必须显式失败`,
        )
        assert.equal(ctx.store.getAsk(id)!.status, 'pending', `${bad.label} 后保持 pending`)
        assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      }
      // 全部保持 pending、无终态事件。
      assert.equal(ctx.service.listAsks('pending').length, bads.length)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('前一个 resolver 异步 undefined 后继续寻找下一个 resolver', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'chain-resolvers' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(async (askId) => {
        if (askId !== 'chain-resolvers') return 99
        await gate.promise
        return undefined
      })
      let secondCalled = false
      ctx.service.registerSeqResolver(async (askId) => {
        if (askId !== 'chain-resolvers') return 99
        secondCalled = true
        return 10
      })
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      gate.resolve()
      const result = await answering
      assert.ok(secondCalled, '第一个 resolver 异步 undefined 后必须继续尝试第二个')
      assert.equal(result.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'plain-secret')
    } finally {
      await ctx.close()
    }
  })

  it('行在等待期间被删除：404；同步 resolver 行为保持原样', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'row-deleted' })
      const gate = deferred<void>()
      const releaseGate = ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'v' })
      // 直接从镜像与持久层删除行（模拟极端清理路径）。
      const raw = ctx.store as unknown as { asks: Map<string, unknown> }
      raw.asks.delete(id)
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
      releaseGate()

      // 同步 resolver：原语义不变（同水位 answered、推进 superseded）。
      const id2 = await createPending(ctx.service, { ...secretSpec, id: 'sync-resolver-kept' })
      const releaseKept = ctx.service.registerSeqResolver(() => 10)
      const ok = await ctx.service.answerAsk(id2, { TOKEN: 'sync-v' })
      assert.equal(ok.status, 'answered')
      releaseKept()
      const id3 = await createPending(ctx.service, { ...secretSpec, id: 'sync-resolver-moved' })
      ctx.service.registerSeqResolver(() => 12)
      const moved = await ctx.service.answerAsk(id3, { TOKEN: 'sync-v' })
      assert.equal(moved.status, 'superseded')
    } finally {
      await ctx.close()
    }
  })
})
