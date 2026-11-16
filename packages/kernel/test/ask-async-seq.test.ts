/**
 * AskService async seq resolver contract test: real AskService + real SQLite.
 *
 * background (herdr Ask CAS): sync cache resolver will in remote poll between gap expired Ask 
 * target seq report into old watermark, leads to answerAsk use expired view do CAS.resolver need to start
 * real async IO(agent.get) take terminal when before watermark, therefore kernel through use mechanism upgrade is
 * MaybePromise<number | undefined>, and in await return after, write any terminal state side effect
 * (supersede/answer/stash) before heavy read durable row, validate wait for during not by concurrency compute.
 *
 * contract:
 * - resolver can sync or async; first return legal non- negative safe integer result i.e. right threat seq;
 * - illegal seq(NaN/negative number/decimal/exceeds safe integer/non- count value type) explicit failed,
 *   do not truncate, do not by default 0, not silently skip;resolver throws (contains async reject) such as on throw,
 *   ask keep pending,stash without write;
 * - async return new watermark -> superseded(is not answered),secret do not stash;
 * - async return same watermark -> answered once (a ask.resolved event);
 * - resolver suspended during concurrency cancel / concurrency answer: wait for way return after heavy read row,
 *   already compute -> 409 ask_already_settled, does not override old result, does not repeat event, do not write stash;
 *   row by delete -> 404;
 * - durable CAS spec wait for during change (expectedStateSeq push enter): by new right threat condition reject
 *   old client data (409 ask_state_conflict), do not override;
 * - before a resolver async return undefined after continue attempt under a resolver;
 * - sync resolver and without CAS ask original behavior keep (does not introduce redundant async between gap - - answer proposal
 *   validate in heavy read row after still based on most new durable spec).
 */

import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { SecretStash } from '../src/services/index.js'
import { errorToResponse } from '../src/http/http-utils.js'
import { cleanupDir, deferred as kitDeferred, makeTempDir } from './helpers.js'

interface TestContext {
  service: AskService
  store: HelmStore
  stash: SecretStash
  events: Array<{ type: string; payload: unknown }>
  close(): Promise<void>
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helm-ask-async-seq-')
})

after(async () => {
  await cleanupDir(rootDir)
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

/** carries isSettled observe deferred wrap (re- use helpers.deferred). */
function deferred<T>() {
  let settled = false
  const inner = kitDeferred<T>()
  return {
    promise: inner.promise,
    resolve: (value: T) => {
      if (settled) return
      settled = true
      inner.resolve(value)
    },
    reject: (error: unknown) => {
      if (settled) return
      settled = true
      inner.reject(error)
    },
    isSettled: () => settled,
  }
}

/** secret field spec: used to assertion stash without leak leak. */
const secretSpec: { conversationId: number; title: string; expectedStateSeq: number; id?: string; fields: Array<{ name: string; label: string; type: 'text'; secret: boolean; required: boolean }> } = {
  conversationId: 1,
  title: 'terminal confirm',
  expectedStateSeq: 10,
  fields: [{ name: 'TOKEN', label: 'Token', type: 'text', secret: true, required: true }],
}

async function createPending(service: AskService, spec: typeof secretSpec): Promise<string> {
  void service.createAsk(spec).catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  const ask = service.listAsks('pending').find((a) => a.id === spec.id)
  assert.ok(ask !== undefined, 'ask must already durable is pending')
  return ask.id
}

// ---------------------------------------------------------------------------

describe('async seq resolver: watermark decide and honest failed', { timeout: 60_000 }, () => {
  it('async new watermark -> superseded while non- answered,secret do not stash', { timeout: 60_000 }, async () => {
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
      // superseded never write answer proposal,secret do not stash, event exactly a resolved.
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

  it('async same watermark -> answered exactly once (single event, durable result contains marker)', { timeout: 60_000 }, async () => {
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

  it('resolver suspended during concurrency cancel: wait for way 409 ask_already_settled, does not override, do not write stash', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'cancel-race' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      // wait for during another path complete deregister single (real scenario: terminal event trigger cancel).
      const cancelled = await ctx.service.cancelAsk(id, 'cancelled')
      assert.equal(cancelled.status, 'cancelled')
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // old result do not by override: still is cancelled, without answer proposal,stash without secret, event without duplicate.
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'cancelled')
      assert.equal(row.resultJson, undefined)
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('two concurrency answer: first compute victory, after to 409(deferred align, without sleep)', { timeout: 60_000 }, async () => {
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
      // a answer through resolver after let through second: two all via history complete CAS stream process.
      firstGate.resolve()
      const firstResult = await first
      assert.equal(firstResult.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      secondGate.resolve()
      await assert.rejects(
        () => second,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // first to result keep: second answer proposal since does not override durable result also do not change write stash.
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'answered')
      assert.ok(!row.resultJson!.includes('second-answer'))
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('wait for during durable CAS spec change (expectedStateSeq push enter): by new right threat condition reject old data', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      for (const nextSeq of [20, undefined]) {
        const id = await createPending(ctx.service, { ...secretSpec, id: `spec-race-${String(nextSeq)}` })
        const gate = deferred<void>()
        const release = ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
        const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
        const row = ctx.store.getAsk(id)!
        const spec = JSON.parse(row.specJson) as { expectedStateSeq?: number }
        ctx.store.putAsk({ ...row, expectedStateSeq: nextSeq, specJson: JSON.stringify({ ...spec, expectedStateSeq: nextSeq }) })
        gate.resolve()
        await assert.rejects(
          () => answering,
          (err: unknown) =>
            err instanceof HelmError &&
            err.code === 'ask_state_conflict' &&
            (err.details as { storedSeq?: number } | undefined)?.storedSeq === nextSeq,
        )
        const after = ctx.store.getAsk(id)!
        assert.equal(after.status, 'pending')
        assert.equal(after.expectedStateSeq, nextSeq)
        assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
        assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
        release()
      }
    } finally {
      await ctx.close()
    }
  })

  it('resolver failed (sync throws and async reject): such as on throw,ask keep pending, without stash write', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'resolver-sync-fail' })
      const releaseSync = ctx.service.registerSeqResolver(() => {
        throw new Error('resolver sync fault')
      })
      await assert.rejects(
        () => ctx.service.answerAsk(id, { TOKEN: 'v' }),
        (err: unknown) => err instanceof Error && err.message === 'resolver sync fault',
      )
      assert.equal(ctx.store.getAsk(id)!.status, 'pending')
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      releaseSync()

      const id2 = await createPending(ctx.service, { ...secretSpec, id: 'resolver-async-fail' })
      ctx.service.registerSeqResolver(async () => {
        throw new HelmError('ask_state_unavailable', 'remote agent.get failed', 502)
      })
      await assert.rejects(
        () => ctx.service.answerAsk(id2, { TOKEN: 'v' }),
        (err: unknown) => err instanceof HelmError && err.code === 'ask_state_unavailable',
      )
      assert.equal(ctx.store.getAsk(id2)!.status, 'pending')
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      // two ask all not produce terminal state event.
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('illegal seq(NaN/negative/decimal/unsafe/broken type) explicit failed: do not truncate, do not by default 0, not silently skip', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const bads: Array<{ label: string; value: unknown }> = [
        { label: 'NaN', value: Number.NaN },
        { label: 'Infinity', value: Number.POSITIVE_INFINITY },
        { label: 'BigInt', value: 10n },
        { label: 'Symbol', value: Symbol('invalid-seq') },
        { label: 'negative number', value: -1 },
        { label: 'decimal', value: 10.5 },
        { label: 'exceeds safe integer', value: Number.MAX_SAFE_INTEGER + 1 },
        { label: 'string', value: '10' },
        { label: 'null', value: null },
      ]
      for (const bad of bads) {
        const id = `bad-seq-${bad.label}`
        await createPending(ctx.service, { ...secretSpec, id })
        const release = ctx.service.registerSeqResolver(() => bad.value as never)
        const error = await ctx.service.answerAsk(id, { TOKEN: 'v' }).then(
          () => assert.fail(`illegal seq ${bad.label} must explicit failed`),
          (error: unknown) => error,
        )
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'ask_seq_resolver_invalid')
        const response = errorToResponse(undefined, (text) => text, error)
        assert.equal(response.status, 500)
        assert.equal((await response.json()).error.code, 'ask_seq_resolver_invalid', 'illegal value cannot break HTTP error message seal')
        assert.equal(ctx.store.getAsk(id)!.status, 'pending', `${bad.label} after keep pending`)
        assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
        release()
      }
      // all keep pending, without terminal state event.
      assert.equal(ctx.service.listAsks('pending').length, bads.length)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('before a resolver async undefined after continue seek under a resolver', { timeout: 60_000 }, async () => {
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
      assert.ok(secondCalled, 'a resolver async undefined after must continue attempt second')
      assert.equal(result.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'plain-secret')
    } finally {
      await ctx.close()
    }
  })

  it('row in wait for during by delete:404; sync resolver behavior keep original', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'row-deleted' })
      const gate = deferred<void>()
      const releaseGate = ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'v' })
      // directly from mirror and durable layer delete row (simulated extreme clean up path).
      const raw = ctx.store as unknown as { asks: Map<string, unknown> }
      raw.asks.delete(id)
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
      releaseGate()

      // sync resolver: original semantics do not change (same watermark answered, push enter superseded).
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
