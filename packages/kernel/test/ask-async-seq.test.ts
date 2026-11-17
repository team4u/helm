/**
 * AskService async seq resolver contract tests: real AskService + real SQLite.
 *
 * Background (herdr Ask CAS): a synchronous cache resolver returns a stale target seq between remote
 * polls, causing answerAsk to run CAS against an outdated view. The resolver needs to issue real
 * async IO (agent.get) to fetch the current terminal seq, so the kernel generic mechanism accepts
 * MaybePromise<number | undefined>; after awaiting it and before writing any terminal side effects
 * (supersede/answer/stash), it re-reads the persisted row to verify it wasn't settled concurrently.
 *
 * Contract:
 * - Resolver may be sync or async; first non-undefined valid non-negative safe integer wins as authoritative seq;
 * - Invalid seq (NaN / negative / float / unsafe integer / non-number) fails explicitly without truncating,
 *   defaulting to 0, or silently skipping; thrown errors (including async rejections) propagate cleanly
 *   with ask kept pending and zero stash writes;
 * - Async returning newer seq -> superseded (not answered), secret not stashed;
 * - Async returning matching seq -> answered once (single ask.resolved event);
 * - Concurrent cancel / answer while resolver awaits: re-reads row on return; already settled ->
 *   409 ask_already_settled without overwriting old result, duplicating events, or writing stash;
 *   deleted row -> 404;
 * - Persisted CAS spec mutated mid-await (expectedStateSeq bumped): rejects stale client payload
 *   under new authoritative rule (409 ask_state_conflict) without overwriting;
 * - Continues to next resolver when a prior resolver asynchronously resolves to undefined;
 * - Sync resolvers and non-CAS asks keep exact original behavior (no extra async gap; answer validation
 *   still checks against latest persisted spec after re-read).
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

/** Deferred wrapper with isSettled observer (reuses helpers.deferred). */
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

/** Secret field spec used to assert stash isolation without plaintext leakage. */
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
  assert.ok(ask !== undefined, 'ask must be persisted as pending')
  return ask.id
}

// ---------------------------------------------------------------------------

describe('async seq resolver: watermark evaluation and honest failure', { timeout: 60_000 }, () => {
  it('async newer watermark -> superseded rather than answered, secret not stashed', { timeout: 60_000 }, async () => {
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
      // Superseded never persists answers, never stashes secret, emits exactly one ask.resolved.
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

  it('async matching watermark -> answered once (single event, persisted result holds marker)', { timeout: 60_000 }, async () => {
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

  it('concurrent cancel while resolver suspends: returns 409 ask_already_settled without overwriting or stashing', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'cancel-race' })
      const gate = deferred<void>()
      ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'plain-secret' })
      // Another path settles while waiting (real scenario: terminal event triggers cancel).
      const cancelled = await ctx.service.cancelAsk(id, 'cancelled')
      assert.equal(cancelled.status, 'cancelled')
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // Old outcome preserved: stays cancelled, no answers, no stashed secret, no duplicate events.
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'cancelled')
      assert.equal(row.resultJson, undefined)
      assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('two concurrent answers: first to settle wins, second returns 409 (deferred alignment, zero sleeps)', { timeout: 60_000 }, async () => {
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
      // Release first answer through resolver, then release second: both run full CAS flow.
      firstGate.resolve()
      const firstResult = await first
      assert.equal(firstResult.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      secondGate.resolve()
      await assert.rejects(
        () => second,
        (err: unknown) => err instanceof HelmError && err.code === 'ask_already_settled',
      )
      // Winner outcome stays intact: loser neither overwrote persisted result nor corrupted stash.
      assert.equal(ctx.stash.envFor(1).TOKEN, 'first-answer')
      const row = ctx.store.getAsk(id)!
      assert.equal(row.status, 'answered')
      assert.ok(!row.resultJson!.includes('second-answer'))
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 1)
    } finally {
      await ctx.close()
    }
  })

  it('persisted CAS spec mutated mid-await (expectedStateSeq bumped): rejects stale payload under new authoritative rule', { timeout: 60_000 }, async () => {
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

  it('resolver failures (sync throw and async reject): propagate as thrown, keep ask pending, zero stash writes', { timeout: 60_000 }, async () => {
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
      // Neither ask produced a terminal event.
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('invalid seq (NaN/negative/decimal/unsafe/bad type) fails explicitly without truncating, defaulting to 0, or skipping', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const bads: Array<{ label: string; value: unknown }> = [
        { label: 'NaN', value: Number.NaN },
        { label: 'Infinity', value: Number.POSITIVE_INFINITY },
        { label: 'BigInt', value: 10n },
        { label: 'Symbol', value: Symbol('invalid-seq') },
        { label: 'negative', value: -1 },
        { label: 'decimal', value: 10.5 },
        { label: 'exceeds safe int', value: Number.MAX_SAFE_INTEGER + 1 },
        { label: 'string', value: '10' },
        { label: 'null', value: null },
      ]
      for (const bad of bads) {
        const id = `bad-seq-${bad.label}`
        await createPending(ctx.service, { ...secretSpec, id })
        const release = ctx.service.registerSeqResolver(() => bad.value as never)
        const error = await ctx.service.answerAsk(id, { TOKEN: 'v' }).then(
          () => assert.fail(`invalid seq ${bad.label} must fail explicitly`),
          (error: unknown) => error,
        )
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'ask_seq_resolver_invalid')
        const response = errorToResponse(undefined, (text) => text, error)
        assert.equal(response.status, 500)
        assert.equal((await response.json()).error.code, 'ask_seq_resolver_invalid', 'invalid values must not break HTTP error envelope')
        assert.equal(ctx.store.getAsk(id)!.status, 'pending', `stays pending after ${bad.label}`)
        assert.equal(ctx.stash.envFor(1).TOKEN, undefined)
        release()
      }
      // All remain pending with no terminal events.
      assert.equal(ctx.service.listAsks('pending').length, bads.length)
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('continues to next resolver when prior resolver asynchronously returns undefined', { timeout: 60_000 }, async () => {
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
      assert.ok(secondCalled, 'must continue trying second resolver after first asynchronously returns undefined')
      assert.equal(result.status, 'answered')
      assert.equal(ctx.stash.envFor(1).TOKEN, 'plain-secret')
    } finally {
      await ctx.close()
    }
  })

  it('row deleted while awaiting: 404; sync resolver preserves original behavior', { timeout: 60_000 }, async () => {
    const ctx = await openService()
    try {
      const id = await createPending(ctx.service, { ...secretSpec, id: 'row-deleted' })
      const gate = deferred<void>()
      const releaseGate = ctx.service.registerSeqResolver(() => gate.promise.then(() => 10))
      const answering = ctx.service.answerAsk(id, { TOKEN: 'v' })
      // Delete row directly from mirror/store (simulates extreme cleanup race).
      const raw = ctx.store as unknown as { asks: Map<string, unknown> }
      raw.asks.delete(id)
      gate.resolve()
      await assert.rejects(
        () => answering,
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      assert.equal(ctx.events.filter((e) => e.type === 'ask.resolved').length, 0)
      releaseGate()

      // Sync resolver: exact original semantics preserved (matching seq answers, advanced seq supersedes).
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
