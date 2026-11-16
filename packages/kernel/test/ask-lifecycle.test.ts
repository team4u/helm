/**
 * AskService lifecycle contract test:AskResult three state,waiter register order and pre- allocate ID.
 *
 * override this round contract change and main proxy real re- now violate about point:
 * - sync deregister single pending bug:ask.upsert subscribe in event call back inside sync cancelAsk(id,'superseded')
 *   after, old implement store already settled but createAsk promise forever do not end (waiter later than publish
 *   register and settle already empty list) - - now must resolve out superseded;
 * - sync answer: event call back inside sync answerAsk must deliver answers;
 * - three state all resolve(cancel/superseded answers is {}, cancel do not smoke fill batch allow),
 *   only verify/IO exception reject;
 * - pre- allocate spec.id do not by UUID override; duplicate ID(any state, contains already compute approval)409 reject,
 *   does not override old approval; illegal id(empty string/whitespace/non- string) validate reject;
 * - CAS semantics keep: client expired watermark 409, without resolver ask_state_unavailable,
 *   target seq inconsistent (contains fall back)superseded;
 * - secret marker do not plaintext: result and durable layer only [REDACTED:stash:*],envFor take back plaintext;
 * - putAsk throws when waiter by reclaim: do not pending wait for,createAsk explicit reject.
 */

import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase, type HelmDatabase } from '../src/runtime/sqlite.js'
import { SecretStash } from '../src/services/index.js'

interface TestContext {
  service: AskService
  store: HelmStore
  stash: SecretStash
  events: Array<{ type: string; payload: unknown }>
  pendingChanged: number[]
  /** in order close store and underlying db(finally must invoke, otherwise connect leak leak). */
  close(): Promise<void>
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
    onError?: (error: unknown) => void
  } = {},
): Promise<TestContext> {
  const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
  const store = new HelmStore(
    db,
    options.onError !== undefined ? { onError: options.onError } : {},
  )
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
  return {
    service,
    store,
    stash,
    events,
    pendingChanged,
    async close() {
      await store.close()
      await db.close()
    },
  }
}

/** assertion promise in ms inside already compute (guard against pending regression: pending when timeout failed and to out diagnose). */
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
    assert.fail(`${label}:promise in ${ms}ms inside not compute (pending regression)`)
  }
  if ('error' in outcome && outcome.error !== undefined) {
    throw outcome.error
  }
  return outcome.value as T
}

const baseSpec = {
  conversationId: 1,
  title: 'approval',
  fields: [{ name: 'x', label: 'X', type: 'text' as const }],
}

// ---------------------------------------------------------------------------

describe('Ask lifecycle: sync deregister single/act answer do not pending', { timeout: 60_000 }, () => {
  it('main proxy re- now path:ask.upsert subscribe inside sync cancelAsk(superseded) after promise must resolve superseded', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      // subscribe in event call back inside sync deregister single (real plugin via events.subscribe trigger path).
      // deregister single must away the same instance (waiters is instance inside Map):hook self reference simulated plugin call back.
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
        'sync superseded deregister single',
      )
      assert.equal(result.status, 'superseded')
      assert.deepEqual(result.answers, {})
      assert.equal(ctx.store.getAsk(result.id)!.status, 'superseded')
    } finally {
      await ctx.close()
    }
  })

  it('sync answer:ask.upsert subscribe inside sync answerAsk deliver answers', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      let hook: AskService
      hook = new AskService({
        store: ctx.store,
        stash: ctx.stash,
        onEvent: (type, payload) => {
          if (type === 'ask.upsert') {
            void hook.answerAsk((payload as { id: string }).id, { x: 'sync answer proposal' })
          }
        },
        onConvPendingChanged: () => {},
      })
      const result = await assertSettlesWithin(hook.createAsk(baseSpec), 2_000, 'sync answer')
      assert.equal(result.status, 'answered')
      assert.deepEqual(result.answers, { x: 'sync answer proposal' })
    } finally {
      await ctx.close()
    }
  })

  it('async cancel/answer path do not subject to affect (common rule await compute)', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const p1 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id)
      const r1 = await assertSettlesWithin(p1, 2_000, 'async cancel')
      assert.equal(r1.status, 'cancelled')
      assert.deepEqual(r1.answers, {})

      const p2 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const r2 = await assertSettlesWithin(p2, 2_000, 'async answer')
      assert.equal(r2.status, 'answered')
      assert.deepEqual(r2.answers, { x: 'v' })
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask three state final value and exception boundary', { timeout: 60_000 }, () => {
  it('answered carry answers;cancelled/superseded answers is {}(do not smoke fill batch allow)', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, title: 'act answer' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'ok' })
      const answered = await pa
      assert.equal(answered.status, 'answered')
      assert.deepEqual(answered.answers, { x: 'ok' })
      assert.equal(typeof answered.id, 'string')

      const pc = ctx.service.createAsk({ ...baseSpec, title: 'cancel' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'cancelled')
      const cancelled = await pc
      assert.equal(cancelled.status, 'cancelled')
      assert.deepEqual(cancelled.answers, {})

      const ps = ctx.service.createAsk({ ...baseSpec, title: 'deregister single' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.cancelAsk(ctx.service.listAsks('pending')[0]!.id, 'superseded')
      const superseded = await ps
      assert.equal(superseded.status, 'superseded')
      assert.deepEqual(superseded.answers, {})
    } finally {
      await ctx.close()
    }
  })

  it('verify exception reject: illegal spec / conversation missing / answer proposal illegal do not compute ask', { timeout: 60_000 }, async () => {
    const ctx = await openService({ validateConversation: (id) => id === 1 })
    try {
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, fields: [{ name: '', label: 'empty name', type: 'text' }] }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, conversationId: 424242 }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // illegal answer proposal reject(answerAsk throw),ask keep pending, produces no false result.
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
      await ctx.close()
    }
  })

  it('putAsk sync reject (mirror pre- check):createAsk explicit reject and do not pending waiter', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const raw = ctx.store as unknown as { putAsk: (row: unknown) => void }
      const original = raw.putAsk.bind(ctx.store)
      raw.putAsk = () => {
        throw new HelmError('store_flush_failed', 'simulated persist failed', 500)
      }
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      raw.putAsk = original
      // waiter already reclaim: after continue same ID create and normal stream process do not subject to pollute.
      assert.equal(ctx.service.listAsks('pending').length, 0)
      const ok = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { x: 'v' })
      const result = await assertSettlesWithin(ok, 2_000, 'failed reclaim after rebuild')
      assert.equal(result.status, 'answered')
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask persist failed (SQL tail chain inject): do not return false succeeded', { timeout: 60_000 }, () => {
  // putAsk only write mirror + queue SQL: real boundary in tail chain, only flushPublic can expose
  // async SQL failed. inject db.run failed verify create/compute all do not false succeeded.
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
      if (shouldFail(sql, params)) return Promise.reject(new Error('inject SQL failed'))
      return original(sql, ...params)
    }
  }

  it('create INSERT failed:createAsk reject, do not publish ask.upsert, after continue write explicit reject', { timeout: 60_000 }, async () => {
    reported = []
    const ctx = await openService({
      onError: (error) => reported.push(error),
    })
    try {
      patchRun(ctx.store, (sql) => sql.includes('INSERT INTO helm_asks'))
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // not publish any visible system event (side effect by block assert, do not extreme false succeeded).
      assert.equal(ctx.events.find((e) => e.type === 'ask.upsert'), undefined)
      // store enter fail semantics: after continue new write explicit reject, no longer pretend queue succeeded.
      await assert.rejects(
        () => ctx.service.createAsk(baseSpec),
        (err: unknown) => err instanceof HelmError && (err.code === 'store_flush_failed' || err.code === 'store_closed'),
      )
      // error already on report (not silently swallow).
      assert.ok(reported.length >= 1, 'persist error must on report')
    } finally {
      await ctx.close()
    }
  })

  it('compute UPDATE failed: do not return false answered,createAsk same error reject, without ask.resolved', { timeout: 60_000 }, async () => {
    reported = []
    const ctx = await openService({
      onError: (error) => reported.push(error),
    })
    try {
      // create INSERT  settled_at bind set is null; compute write back is count value - - only intercept compute.
      patchRun(ctx.store, (sql, params) => sql.includes('helm_asks') && typeof params[8] === 'number')
      const askPromise = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'real answer proposal' }),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // createAsk must not return false answered: the same failed reject(also do not pending).
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'compute failed'),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // terminal state event not publish.
      assert.equal(ctx.events.find((e) => e.type === 'ask.resolved'), undefined)
      assert.ok(reported.length >= 1, 'persist error must on report')
    } finally {
      await ctx.close()
    }
  })

  it('terminal state sync putAsk throws:answer/cancel reject,createAsk waiter same error reject do not pending', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const askPromise = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = ctx.service.listAsks('pending')[0]!
      // sync mirror write reject (store closed/pre- check throw), occur in flush before.
      const raw = ctx.store as unknown as { putAsk: (row: unknown) => void }
      const original = raw.putAsk.bind(ctx.store)
      raw.putAsk = () => {
        throw new HelmError('store_closed', 'simulated terminal state sync failed to write', 409)
      }
      await assert.rejects(
        () => ctx.service.answerAsk(ask.id, { x: 'v' }),
        (err: unknown) => err instanceof HelmError && err.code === 'store_closed',
      )
      // createAsk waiter must not pending, must not false terminal state: the same error reject.
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'terminal state sync put failed'),
        (err: unknown) => err instanceof HelmError && err.code === 'store_closed',
      )
      raw.putAsk = original
      // cancel path same reject do not pending (pre- allocate id precise locate, avoid choose in old pending).
      const p2 = ctx.service.createAsk({ ...baseSpec, id: 'cancel-put-fail', title: 'cancel' })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(ctx.service.listAsks('pending').find((a) => a.id === 'cancel-put-fail') !== undefined, true)
      raw.putAsk = () => {
        throw new HelmError('store_closed', 'simulated terminal state sync failed to write', 409)
      }
      await assert.rejects(
        () => ctx.service.cancelAsk('cancel-put-fail'),
        (err: unknown) => err instanceof HelmError && err.code === 'store_closed',
      )
      await assert.rejects(
        () => assertSettlesWithin(p2, 2_000, 'cancel sync put failed'),
        (err: unknown) => err instanceof HelmError && err.code === 'store_closed',
      )
      raw.putAsk = original
    } finally {
      await ctx.close()
    }
  })

  it('ask.resolved publish throws:answer reject,createAsk waiter same error reject do not pending', { timeout: 60_000 }, async () => {
    // succeeded but event call back throws: also must such as failed, cannot install act already compute.
    const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
    const store = new HelmStore(db)
    await store.load()
    const stash = new SecretStash()
    const events: Array<{ type: string; payload: unknown }> = []
    const failing = new AskService({
      store,
      stash,
      onEvent: (type, payload) => {
        events.push({ type, payload })
        if (type === 'ask.resolved') throw new Error('event publish fault')
      },
      onConvPendingChanged: () => {},
    })
    try {
      const askPromise = failing.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const ask = failing.listAsks('pending')[0]!
      await assert.rejects(
        () => failing.answerAsk(ask.id, { x: 'v' }),
        (err: unknown) => err instanceof Error && String(err.message).includes('event publish fault'),
      )
      // already succeeded but event failed:waiter with the same error reject(do not pending, do not false answered).
      await assert.rejects(
        () => assertSettlesWithin(askPromise, 2_000, 'event failed to publish'),
        (err: unknown) => err instanceof Error && String(err.message).includes('event publish fault'),
      )
    } finally {
      await store.close()
      await db.close()
    }
  })

  it('cancelByConversation any one failed: such as reject, must not static default succeeded', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const p1 = ctx.service.createAsk(baseSpec)
      await new Promise((r) => setTimeout(r, 20))
      const p2 = ctx.service.createAsk({ ...baseSpec, title: 'second' })
      await new Promise((r) => setTimeout(r, 20))
      // inject compute UPDATE failed (first create INSERT settled_at=null do not intercept).
      patchRun(ctx.store, (sql, params) => sql.includes('helm_asks') && typeof params[8] === 'number')
      await assert.rejects(
        () => ctx.service.cancelByConversation(1),
        (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
      )
      // failed waiter already by settle with failure compute (do not pending, do not false terminal state).
      const outcomes = await Promise.allSettled([p1, p2])
      const rejected = outcomes.filter((o) => o.status === 'rejected').length
      assert.ok(rejected >= 1, 'at least a subject to affect ask  waiter must explicit failed')
      // cannot appear any one example level join cancel succeeded resolve into cancelledalso whole yet report succeeded.
      patchRun(ctx.store, () => false)
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask pre- allocate ID', { timeout: 60_000 }, () => {
  it('spec.id keep do not by UUID override;result.id and store inside consistent', { timeout: 60_000 }, async () => {
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
      await ctx.close()
    }
  })

  it('duplicate ID reject (contains already compute approval):409 ask_id_conflict, does not override old record', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({ ...baseSpec, id: 'dup-1' })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk('dup-1', { x: 'original answer proposal' })
      await pa
      // already compute (answered) ID again use: reject, does not override old approval result.
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-1' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
      assert.equal(ctx.store.getAsk('dup-1')!.status, 'answered')
      assert.equal(JSON.parse(ctx.store.getAsk('dup-1')!.resultJson!).x, 'original answer proposal')

      // pending state ID same reject.
      const pb = ctx.service.createAsk({ ...baseSpec, id: 'dup-2' })
      void pb.catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
      await ctx.service.cancelAsk('dup-2')
      await pb
      // cancelled state same occupy ID.
      await assert.rejects(
        () => ctx.service.createAsk({ ...baseSpec, id: 'dup-2' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_id_conflict',
      )
    } finally {
      await ctx.close()
    }
  })

  it('illegal id shape reject: empty string / pure whitespace / non- string', { timeout: 60_000 }, async () => {
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
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask CAS semantics keep', { timeout: 60_000 }, () => {
  it('client expired watermark 409; without resolver ask_state_unavailable;seq inconsistent (contains fall back)superseded resolve', { timeout: 60_000 }, async () => {
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
      // fall back (9 < 10) and push enter (11 > 10) all superseded, and createAsk resolve.
      let target = 9
      ctx.service.registerSeqResolver(() => target)
      const settledBackward = await ctx.service.answerAsk(ask.id, { x: 'v' })
      assert.equal(settledBackward.status, 'superseded')
      const r1 = await assertSettlesWithin(pa, 2_000, 'seq fall back superseded')
      assert.equal(r1.status, 'superseded')
      assert.deepEqual(r1.answers, {})

      const pb = ctx.service.createAsk({ ...baseSpec, expectedStateSeq: 5, title: 'CAS consistent' })
      await new Promise((r) => setTimeout(r, 20))
      const ask2 = ctx.service.listAsks('pending')[0]!
      target = 5
      const ok = await ctx.service.answerAsk(ask2.id, { x: 'v' })
      assert.equal(ok.status, 'answered')
      const r2 = await assertSettlesWithin(pb, 2_000, 'seq consistent answer')
      assert.equal(r2.status, 'answered')
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('Ask secret marker boundary', { timeout: 60_000 }, () => {
  it('secret answer proposal only stash marker:result/persist/event all without plaintext,envFor can take back', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({
        conversationId: 1,
        title: 'secret key',
        fields: [{ name: 'API_KEY', label: 'Key', type: 'text', secret: true, required: true }],
      })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { API_KEY: 'plain-secret-value' })
      const result = await pa
      assert.equal(result.status, 'answered')
      assert.ok(result.answers['API_KEY']!.startsWith('[REDACTED:stash:'), 'result only contains marker')
      // durable layer without plaintext.
      const row = ctx.store.getAsk(result.id)!
      assert.ok(!row.specJson.includes('plain-secret-value'))
      assert.ok(!row.resultJson!.includes('plain-secret-value'))
      assert.ok(row.resultJson!.includes('[REDACTED:stash:'))
      // event payload without plaintext.
      for (const frame of ctx.events) {
        assert.ok(!JSON.stringify(frame).includes('plain-secret-value'), 'event must not leak leak plaintext')
      }
      // conversation environment can take back plaintext (process inside can message way).
      assert.equal(ctx.stash.envFor(1)['API_KEY'], 'plain-secret-value')
    } finally {
      await ctx.close()
    }
  })

  it('empty secret do not stash(store empty string),secret collision declaration still reject', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const pa = ctx.service.createAsk({
        conversationId: 1,
        title: 'empty secret',
        fields: [{ name: 'EMPTY_TOKEN', label: 'T', type: 'text', secret: true }],
      })
      await new Promise((r) => setTimeout(r, 20))
      await ctx.service.answerAsk(ctx.service.listAsks('pending')[0]!.id, { EMPTY_TOKEN: '' })
      const result = await pa
      assert.equal(result.status, 'answered')
      assert.equal(result.answers['EMPTY_TOKEN'], '')
      // 'api_key' and 'API_KEY' is two different field name: keep declaration original can shared store (not silently merge).
      const pboth = ctx.service.createAsk({
        conversationId: 1,
        title: 'double secret shared store',
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
      // duplicate field.name still reject.
      await assert.rejects(
        () =>
          ctx.service.createAsk({
            conversationId: 1,
            title: 'duplicate name',
            fields: [
              { name: 'dup', label: '1', type: 'text' },
              { name: 'dup', label: '2', type: 'text' },
            ],
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
    } finally {
      await ctx.close()
    }
  })
})
