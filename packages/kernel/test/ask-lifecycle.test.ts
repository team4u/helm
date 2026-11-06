/**
 * AskService 生命周期契约测试：AskResult 三态、waiter 注册顺序与预分配 ID。
 *
 * 覆盖本轮契约变更与主代理真实复现的违约点：
 * - 同步销单悬挂 bug：ask.upsert 订阅者在事件回调内同步 cancelAsk(id,'superseded')
 *   后，旧实现库已 settled 但 createAsk promise 永不结束（waiter 晚于 publish
 *   注册且 settle 已清空列表）——现在必须 resolve 出 superseded；
 * - 同步 answer：事件回调内同步 answerAsk 必须交付 answers；
 * - 三态均 resolve（cancel/superseded answers 为 {}，取消不冒充批准），
 *   只有验证/IO 异常 reject；
 * - 预分配 spec.id 不被 UUID 覆盖；重复 ID（任何状态，含已结算审批）409 拒绝，
 *   不覆盖旧审批；非法 id（空串/空白/非字符串）校验拒绝；
 * - CAS 语义保持：客户端过期水位 409、无 resolver ask_state_unavailable、
 *   目标 seq 不一致（含回退）superseded；
 * - secret marker 不落明文：结果与持久层只有 [REDACTED:stash:*]，envFor 取回明文；
 * - putAsk 抛错时 waiter 被回收：不留悬挂等待者、createAsk 显式 reject。
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
  pendingChanged: number[]
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-ask-lifecycle-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function openService(
  options: {
    validateConversation?: (id: number) => boolean
    onEvent?: (type: string, payload: unknown) => void
  } = {},
): Promise<TestContext> {
  const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
  const store = new HelmStore(db)
  await store.load()
  const stash = new SecretStash()
  const events: Array<{ type: string; payload: unknown }> = []
  const pendingChanged: number[] = []
  const service = new AskService({
    store,
    stash,
    onEvent: (type, payload) => {
      events.push({ type, payload })
      options.onEvent?.(type, payload)
    },
    onConvPendingChanged: (id) => pendingChanged.push(id),
    validateConversation: options.validateConversation,
  })
  return { service, store, stash, events, pendingChanged }
}

/** 断言 promise 在 ms 内已结算（防悬挂回归：悬挂时超时失败并给出诊断）。 */
async function assertSettlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const sentinel = Symbol('pending')
  const raced = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ value: sentinel }), ms)),
  ])
  const outcome = raced as { value: unknown; error?: unknown }
  if (outcome.value === sentinel && outcome.error === undefined) {
    assert.fail(`${label}：promise 在 ${ms}ms 内未结算（悬挂回归）`)
  }
  if ('error' in outcome && outcome.error !== undefined) {
    throw outcome.error
  }
  return outcome.value as T
}

const baseSpec = {
  conversationId: 1,
  title: '审批',
  fields: [{ name: 'x', label: 'X', type: 'text' as const }],
}

// ---------------------------------------------------------------------------

describe('Ask 生命周期：同步销单/作答不悬挂', { timeout: 60_000 }, () => {
  it('主代理复现路径：ask.upsert 订阅内同步 cancelAsk(superseded) 后 promise 必须 resolve superseded', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      // 订阅者在事件回调内同步销单（真实插件经 events.subscribe 触发的路径）。
      // 销单必须走同一实例（waiters 是实例内 Map）：hook 自引用模拟插件回调。
      let hook: AskService
      hook = new AskService({
        store: ctx.store,
        stash: ctx.stash,
        onEvent: (type, payload) => {
          if (type === 'ask.upsert') {
            void hook.cancelAsk((payload as { id: string }).id, 'superseded')
          }
        },
        onConvPendingChanged: () => {},
      })
      const result = await assertSettlesWithin(
        hook.createAsk(baseSpec),
        2_000,
        '同步 superseded 销单',
      )
      assert.equal(result.status, 'superseded')
      assert.deepEqual(result.answers, {})
      assert.equal(ctx.store.getAsk(result.id)!.status, 'superseded')
    } finally {
      await ctx.store.close()
    }
  })

  it('同步 answer：ask.upsert 订阅内同步 answerAsk 交付 answers', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      let hook: AskService
      hook = new AskService({
        store: ctx.store,
        stash: ctx.stash,
        onEvent: (type, payload) => {
          if (type === 'ask.upsert') {
            void hook.answerAsk((payload as { id: string }).id, { x: '同步答案' })
          }
        },
        onConvPendingChanged: () => {},
      })
      const result = await assertSettlesWithin(hook.createAsk(baseSpec), 2_000, '同步 answer')
      assert.equal(result.status, 'answered')
      assert.deepEqual(result.answers, { x: '同步答案' })
    } finally {
      await ctx.store.close()
    }
  })

  it('异步 cancel/answer 路径不受影响（常规 await 结算）', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const p1 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id)
      const r1 = await assertSettlesWithin(p1, 2_000, '异步 cancel')
      assert.equal(r1.status, 'cancelled')
      assert.deepEqual(r1.answers, {})

      const p2 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const r2 = await assertSettlesWithin(p2, 2_000, '异步 answer')
      assert.equal(r2.status, 'answered')
      assert.deepEqual(r2.answers, { x: 'v' })
    } finally {
      await ctx.store.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask 三态终值与异常边界', { timeout: 60_000 }, () => {
  it('answered 携带 answers；cancelled/superseded answers 为 {}（不冒充批准）', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, title: '将作答' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'ok' })
      const answered = await pa
      assert.equal(answered.status, 'answered')
      assert.deepEqual(answered.answers, { x: 'ok' })
      assert.equal(typeof answered.id, 'string')

      const pc = ctx.service.createAsk({ ...baseSpec, title: '将取消' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'cancelled')
      const cancelled = await pc
      assert.equal(cancelled.status, 'cancelled')
      assert.deepEqual(cancelled.answers, {})

      const ps = ctx.service.createAsk({ ...baseSpec, title: '将销单' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'superseded')
      const superseded = await ps
      assert.equal(superseded.status, 'superseded')
      assert.deepEqual(superseded.answers, {})
    } finally {
      await ctx.store.close()
    }
  })

  it('验证异常 reject：非法 spec / 会话不存在 / 答案非法不结算 ask', { timeout: 60_000 }, async () => {
    const ctx = await openService({ validateConversation: (id) => id === 1 })
    try {
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, fields: [{ name: '', label: '空名', type: 'text' }] }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, conversationId: 424242 }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // 非法答案 reject（answerAsk 抛出），ask 保持 pending，不产生假结果。
      const pa = ctx.service.createAsk(baseSpec)
      void pa.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v', rogue: 'y' } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      assert.equal(ctx.store.getAsk(ask.id)!.status, 'pending')
      await ctx.service.cancelAsk(ask.id)
      await pa
    } finally {
      await ctx.store.close()
    }
  })

  it('putAsk 同步拒绝（镜像前置检查）：createAsk 显式 reject 且不留悬挂 waiter', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const raw = ctx.store as unknown as { putAsk: (row: unknown) => void }
      const original = raw.putAsk.bind(ctx.store)
      raw.putAsk = () => {
        throw new HelmError('store_flush_failed', '模拟持久化失败', 500)
      }
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      raw.putAsk = original
      // waiter 已回收：后续同 ID 创建与正常流程不受污染。
      assert.equal(ctx.service.listAsks('pending').length, 0)
      const ok = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const result = await assertSettlesWithin(ok, 2_000, '失败回收后重建')
      assert.equal(result.status, 'answered')
    } finally {
      await ctx.store.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask 持久化失败（SQL 尾链注入）：不返回假成功', { timeout: 60_000 }, () => {
  // putAsk 只写镜像 + 入队 SQL：真实落盘边界在尾链，只有 flushPublic 能暴露
  // 异步 SQL 失败。注入 db.run 失败验证创建/结算均不假成功。
  let reported: unknown[] = []

  function patchRun(
    store: HelmStore,
    shouldFail: (sql: string, params: unknown[]) => boolean,
  ): void {
    const internals = store as unknown as {
      db: { run: (sql: string, ...params: unknown[]) => Promise<void> }
    }
    const original = internals.db.run.bind(internals.db)
    internals.db.run = (sql: string, ...params: unknown[]) => {
      if (shouldFail(sql, params)) return Promise.reject(new Error('注入的 SQL 落盘失败'))
      return original(sql, ...params)
    }
  }

  it('创建 INSERT 落盘失败：createAsk reject，不发布 ask.upsert，后续写显式拒绝', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    reported = []
    const { setStoreErrorReporter } = await import('../src/runtime/store.js')
    setStoreErrorReporter((error) => reported.push(error))
    try {
      patchRun(ctx.store, (sql) => sql.includes('INSERT INTO helm_asks'))
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // 未发布任何可见制事件（副作用被阻断，不极假成功）。
      assert.equal(ctx.events.find((e) => e.type === 'ask.upsert'), undefined)
      // store 进入 fail 语义：后续新写显式拒绝，不再假装入队成功。
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && (err.code === 'store_flush_failed' || err.code === 'store_closed'),
      )
      // 错误已上报（不静默吞）。
      assert.ok(reported.length >= 1, '持久化错误必须上报')
    } finally {
      setStoreErrorReporter((error) => {
        console.error('[helm] store persistence error:', error)
      })
      await ctx.store.close()
    }
  })

  it('结算 UPDATE 落盘失败：不返回假 answered，createAsk 同错误 reject，无 ask.resolved', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    reported = []
    const { setStoreErrorReporter } = await import('../src/runtime/store.js')
    setStoreErrorReporter((error) => reported.push(error))
    try {
      // 创建 INSERT 的 settled_at 绑定为 null；结算写回为数值——只拦结算。
      patchRun(ctx.store, (sql, params) => sql.includes('helm_asks') && typeof params[8] === 'number')
      const askPromise = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: '真实答案' }),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // createAsk 不得返回假 answered：同一失败 reject（也不悬挂）。
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, '结算落盘失败'),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // 终态事件未发布。
      assert.equal(ctx.events.find((e) => e.type === 'ask.resolved'), undefined)
      assert.ok(reported.length >= 1, '持久化错误必须上报')
    } finally {
      setStoreErrorReporter((error) => {
        console.error('[helm] store persistence error:', error)
      })
      await ctx.store.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask 预分配 ID', { timeout: 60_000 }, () => {
  it('spec.id 保留不被 UUID 覆盖；result.id 与库内一致', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, id: 'pre-allocated-1' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(ctx.service.listAsks('pending')[0]!.id, 'pre-allocated-1')
      await ctx.service.answerAsk('pre-allocated-1', { x: 'v' })
      const result = await pa
      assert.equal(result.id, 'pre-allocated-1')
      assert.equal(result.status, 'answered')
    } finally {
      await ctx.store.close()
    }
  })

  it('重复 ID 拒绝（含已结算审批）：409 ask_id_conflict，不覆盖旧记录', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, id: 'dup-1' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk('dup-1', { x: '原答案' })
      await pa
      // 已结算（answered）的 ID 再用：拒绝，不覆盖旧审批结果。
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-1' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
      assert.equal(ctx.store.getAsk('dup-1')!.status, 'answered')
      assert.equal(JSON.parse(ctx.store.getAsk('dup-1')!.resultJson!).x, '原答案')

      // pending 状态的 ID 同样拒绝。
      const pb = ctx.service.createAsk({ ...baseSpec, id: 'dup-2' })
      void pb.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
      await ctx.service.cancelAsk('dup-2')
      await pb
      // cancelled 状态同样占用 ID。
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
    } finally {
      await ctx.store.close()
    }
  })

  it('非法 id 形状拒绝：空串 / 纯空白 / 非字符串', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      for (const bad of ['', '   ']) {
        await assert.rejects(
          () => ctx.service.createAsk({ ...baseSpec, id: bad }),
          (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
        )
      }
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 123 as never }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      assert.equal(ctx.service.listAsks().length, 0)
    } finally {
      await ctx.store.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask CAS 语义保持', { timeout: 60_000 }, () => {
  it('客户端过期水位 409；无 resolver ask_state_unavailable；seq 不一致（含回退）superseded resolve', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, expectedStateSeq: 10, title: 'CAS' })
      void pa.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v' }, 9),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_state_conflict',
      )
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_state_unavailable',
      )
      // 回退（9 < 10）与推进（11 > 10）都 superseded，且 createAsk resolve。
      let target = 9
      ctx.service.registerSeqResolver(() => target)
      const settledBackward = await ctx.service.answerAsk(ask.id, { x: 'v' })
      assert.equal(settledBackward.status, 'superseded')
      const r1 = await assertSettlesWithin(pa, 2_000, 'seq 回退 superseded')
      assert.equal(r1.status, 'superseded')
      assert.deepEqual(r1.answers, {})

      const pb = ctx.service.createAsk({ ...baseSpec, expectedStateSeq: 5, title: 'CAS 一致' })
      await new Promise((r) => setTimeout(r, 20))
      const ask2 = ctx.service.listAsks('pending')[0]!
      target = 5
      const ok = await ctx.service.answerAsk(ask2.id, { x: 'v' })
      assert.equal(ok.status, 'answered')
      const r2 = await assertSettlesWithin(pb, 2_000, 'seq 一致 answer')
      assert.equal(r2.status, 'answered')
    } finally {
      await ctx.store.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask secret marker 边界', { timeout: 60_000 }, () => {
  it('secret 答案只有 stash marker：result/persist/事件均无明文，envFor 可取回', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({
        conversationId: 1,
        title: '密钥',
        fields: [{ name: 'API_KEY', label: 'Key', type: 'text', secret: true, required: true }],
      })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { API_KEY: 'plain-secret-value' })
      const result = await pa
      assert.equal(result.status, 'answered')
      assert.ok(result.answers['API_KEY']!.startsWith('[REDACTED:stash:'), '结果只含 marker')
      // 持久层无明文。
      const row = ctx.store.getAsk(result.id)!
      assert.ok(!row.specJson.includes('plain-secret-value'))
      assert.ok(!row.resultJson!.includes('plain-secret-value'))
      assert.ok(row.resultJson!.includes('[REDACTED:stash:'))
      // 事件载荷无明文。
      for (const frame of ctx.events) {
        assert.ok(!JSON.stringify(frame).includes('plain-secret-value'), '事件不得泄漏明文')
      }
      // 会话环境可取回明文（进程内可信方）。
      assert.equal(ctx.stash.envFor(1)['API_KEY'], 'plain-secret-value')
    } finally {
      await ctx.store.close()
    }
  })

  it('空 secret 不入 stash（存储空串），secret 碰撞声明仍拒绝', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({
        conversationId: 1,
        title: '空秘密',
        fields: [{ name: 'EMPTY_TOKEN', label: 'T', type: 'text', secret: true }],
      })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { EMPTY_TOKEN: '' })
      const result = await pa
      assert.equal(result.status, 'answered')
      assert.equal(result.answers['EMPTY_TOKEN'], '')
      // 'api_key' 与 'API_KEY' 是两个不同字段名：保留声明原样可共存（不静默合并）。
      const pboth = ctx.service.createAsk({
        conversationId: 1,
        title: '双秘密共存',
        fields: [
          { name: 'api_key', label: 'a', type: 'text', secret: true },
          { name: 'API_KEY', label: 'b', type: 'text', secret: true },
        ],
      })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, {
        api_key: 'lower',
        API_KEY: 'upper',
      })
      const both = await pboth
      assert.equal(both.status, 'answered')
      assert.equal(ctx.stash.envFor(1)['api_key'], 'lower')
      assert.equal(ctx.stash.envFor(1)['API_KEY'], 'upper')
      // 重复 field.name 仍然拒绝。
      await assert.rejects(
        () =>
          ctx.service.createAsk({
            conversationId: 1,
            title: '重复名',
            fields: [
              { name: 'dup', label: '1', type: 'text' },
              { name: 'dup', label: '2', type: 'text' },
            ],
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
    } finally {
      await ctx.store.close()
    }
  })
})
