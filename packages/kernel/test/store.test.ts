/**
 * HelmxStore durability tests: real temporary SQLite + real `NodeSqliteDatabase` adapter.
 * Fault injection via wrapping adapter `run`/`exec` only (fixture injects errors without mocking data).
 * Covers: honest flush failures (never faking success, rejecting new writes after errors, close awaiting in-flight),
 * Ask terminal state restart consistency, FTS dedup / title propagation / search pre-flush, atomic delete without
 * resurrection on restart, sequence monotonicity, JSON corruption errors.
 */

import { HelmxError } from '@helmx/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openHelmxDatabase, type HelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore, convStatusOf, type ConvMeta } from '../src/runtime/store.js'

async function openStore(): Promise<{ store: HelmxStore; database: HelmxDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'helmx-store-test-'))
  return { dir, ...await openStoreAt(dir) }
}

/** Single-shot fault injection hook attached to an already-open `database.db` (error injection only, no synthetic data). */
function attachFaults(database: HelmxDatabase): { failNext(substr: string, error?: Error): void } {
  const realDb = database.db as unknown as Record<string, unknown> & { __faultHook?: FaultHook }
  if (!realDb.__faultHook) {
    realDb.__faultHook = { substr: '', armed: false, error: new Error('injected SQL failure') }
    for (const prop of ['run', 'exec'] as const) {
      const orig = realDb[prop] as (sql: string, ...params: unknown[]) => Promise<unknown>
      realDb[prop] = (sql: string, ...params: unknown[]) => {
        const h = realDb.__faultHook as FaultHook
        if (h.armed && sql.includes(h.substr)) {
          h.armed = false
          return Promise.reject(h.error)
        }
        return orig.call(realDb, sql, ...params)
      }
    }
    // `transaction` allocates handles independently on `db`: wrap `run`/`exec` inside transaction handles too.
    const origTx = database.db.transaction.bind(database.db)
    realDb['transaction'] = <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      origTx((tx: unknown) => {
        const wrappedTx = new Proxy(tx as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, target)
            if (prop === 'run' || prop === 'exec') {
              return (sql: string, ...params: unknown[]) => {
                const h = realDb.__faultHook as FaultHook
                if (h.armed && sql.includes(h.substr)) {
                  h.armed = false
                  return Promise.reject(h.error)
                }
                return (value as (sql: string, ...params: unknown[]) => Promise<unknown>).apply(
                  target,
                  [sql, ...params],
                )
              }
            }
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return cb(wrappedTx)
      })
  }
  return {
    failNext(substr: string, error?: Error) {
      const h = realDb.__faultHook as FaultHook
      h.substr = substr
      h.armed = true
      if (error) h.error = error
    },
  }
}

interface FaultHook {
  substr: string
  armed: boolean
  error: Error
}

function conv(id: number, overrides: Partial<ConvMeta> = {}): ConvMeta {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: ['a'],
    parentConversationId: undefined,
    nodeId: 'local',
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** Fixed parent tool call ID used for link table tests. */
const parentToolId = 'call-tool-3001'

describe('HelmxStore durability layer (real SQLite)', { timeout: 60_000 }, () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helmx-store-suite-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flushPublic awaits real drain: writes are immediately readable in a reopened store', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'drain-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(7, { title: 'drain-me' }))
    store.putPluginDoc('p', 'k', '{"v":1}')
    await store.flushPublic() // Must not return early: persisted on disk right now
    await database.close()
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(7)?.title, 'drain-me')
    assert.equal(reopened.store.getPluginDoc('p', 'k'), '{"v":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deleteGlobalPluginDocs: exact prefix purge (colon-bearing IDs and kernel keys untouched, no restart resurrection)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-doc-'))
    const { store, database } = await openStoreAt(base)
    // Simulate createGlobalDocumentStore layout: global docs stored under __global with name = `${pluginId}:${doc}`
    store.putPluginDoc('__global', 'foo:records', '{"n":1}')
    store.putPluginDoc('__global', 'foo:cfg', '{"n":2}')
    store.putPluginDoc('__global', 'foo:bar:records', '{"n":3}') // Plugin foo:bar's data must not be harmed by deleting foo
    store.putPluginDoc('__global', 'conversation-ownership', '{}') // Kernel metadata (no colon); belongs to no plugin
    store.putPluginDoc('__global', 'other:records', '{"n":4}')
    await store.flushPublic()

    store.deleteGlobalPluginDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:cfg'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), '{"n":3}', 'colon-bearing plugin ID data must not be cross-deleted')
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}', 'colonless kernel metadata must stay untouched')
    assert.equal(store.getPluginDoc('__global', 'other:records'), '{"n":4}')

    // Deleting colon-bearing ID foo:bar cleans its data while leaving others intact
    store.deleteGlobalPluginDocs('foo:bar')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}')
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:records'), undefined, 'must not reappear after restart')
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(reopened.store.getPluginDoc('__global', 'other:records'), '{"n":4}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deletePluginSessionDocs: deletes all session docs for plugin (others preserved, no resurrection)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-session-'))
    const { store, database } = await openStoreAt(base)
    store.putPluginSessionDoc('foo', 'runs', 1, '{"a":1}')
    store.putPluginSessionDoc('foo', 'runs', 2, '{"a":2}')
    store.putPluginDoc('__global', 'unused', '{}') // keep clean
    store.putPluginSessionDoc('foo', 'notes', 1, '{"b":1}')
    store.putPluginSessionDoc('foobar', 'runs', 1, '{"c":1}') // Prefix-adjacent plugin must not be deleted
    await store.flushPublic()

    store.deletePluginSessionDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 2), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'notes', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}', 'prefix-adjacent plugin must not be deleted')
    assert.deepEqual(store.listPluginSessionDocConversations('foo', 'runs'), [])
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginSessionDoc('foo', 'runs', 1), undefined, 'must not reappear after restart')
    assert.equal(reopened.store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('SQL failure: flushPublic throws explicitly (never fakes success) and subsequent writes reject', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fail-'))
    const { store, database } = await openStoreAt(base)
    const fixture = attachFaults(database)
    fixture.failNext('INSERT INTO helmx_conversations')
    store.upsertConv(conv(8))
    await assert.rejects(() => store.flushPublic(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    // New writes after failure must be rejected (failed state cannot keep faking success).
    assert.throws(() => store.upsertConv(conv(9)), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    assert.throws(() => store.putPluginDoc('p', 'k', '{}'), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      return true
    })
    // close() also surfaces the error (used by runtime to throw HelmxError).
    const closeError = await store.close()
    assert.ok(closeError !== undefined)
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('close awaits in-flight flush completion (tail chain drops no writes)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'close-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(10))
    store.indexFts(10, 'entry:1', 't', 'body text')
    const closing = store.close() // Do not await first: close runs concurrently with in-flight write
    await closing
    await database.close()
    // Reopening after close returns must observe the flushed writes (close didn't exit early).
    const reopened = await openStoreAt(base)
    assert.ok(reopened.store.getConv(10))
    const hits = await reopened.store.search('body')
    assert.equal(hits.length, 1)
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('Ask terminal state restart consistency: settled status/spec/result never revert to pending', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'ask-'))
    const { store, database } = await openStoreAt(base)
    store.putAsk({
      id: 'ask-1',
      conversationId: 3,
      specJson: JSON.stringify({ id: 'ask-1', title: 't', status: 'pending', fields: [] }),
      status: 'pending',
      createdAt: 100,
    })
    await store.flushPublic()
    // Settlement: spec contains terminal status; UPSERT must persist spec back to DB too.
    const settledSpec = JSON.stringify({ id: 'ask-1', title: 't', status: 'answered', fields: [] })
    store.putAsk({
      id: 'ask-1',
      conversationId: 3,
      specJson: settledSpec,
      status: 'answered',
      resultJson: JSON.stringify({ name: 'v' }),
      createdAt: 100,
      settledAt: 200,
    })
    await store.flushPublic()
    await store.close()
    await database.close()
    const reopened = await openStoreAt(base)
    const row = reopened.store.getAsk('ask-1')
    assert.ok(row)
    assert.equal(row.status, 'answered')
    assert.equal(row.specJson, settledSpec) // Spec remains in terminal state after restart, not pending
    assert.equal(row.resultJson, JSON.stringify({ name: 'v' }))
    assert.equal(row.settledAt, 200)
    const pending = reopened.store.listAsks('pending')
    assert.equal(pending.filter((a) => a.id === 'ask-1').length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS: repeated entry indexing dedups to one row; title updates refresh all rows; search pre-flushes', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(5, { title: 'old-title' }))
    // Re-index same entry repeatedly (observer replay scenario).
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:2', 'old-title', 'beta gamma')
    let hits = await store.search('hello') // search internally awaits flushPublic first
    assert.equal(hits.length, 1, 'same entry must have at most one index row')
    assert.equal(hits[0]?.entryId, 'entry:1')
    // Title change updates all FTS rows for that conversation (not just one).
    store.upsertConv(conv(5, { title: 'new-title', updatedAt: 2000 }))
    await store.flushPublic()
    const titleRows = await database.db.all<{ title: string; entry_id: string }>(
      'SELECT title, entry_id FROM helmx_conversation_fts WHERE conversation_id = 5',
    )
    assert.equal(titleRows.length, 2)
    for (const r of titleRows) assert.equal(r.title, 'new-title')
    hits = await store.search('beta')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.entryId, 'entry:2')
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS atomic rebuild: failure rolls back preserving previous index (never fakes success)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'rebuild-'))
    const { store, database } = await openStoreAt(base)
    store.indexFts(6, 'entry:1', 't', 'original content')
    await store.flushPublic()
    const fixture = attachFaults(database)
    fixture.failNext('DELETE FROM helmx_conversation_fts')
    await assert.rejects(
      () =>
        store.rebuildFts(async () => {
          /* replay */
        }),
      /injected/,
    )
    // Rollback preserves previous index (derived index is never dropped on rebuild failure).
    const hits = await store.search('original')
    assert.equal(hits.length, 1)
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('delete conversation: does not resurrect on restart (atomic tombstone + row cleanup), no leftover asks/artifacts', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'del-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(11, { title: 'to-delete' }))
    store.putAsk({
      id: 'ask-del',
      conversationId: 11,
      specJson: JSON.stringify({ id: 'ask-del', status: 'pending', fields: [] }),
      status: 'pending',
      createdAt: 50,
    })
    store.putArtifact({
      id: 'art-del',
      conversationId: 11,
      kind: 'upload',
      name: 'n',
      path: '/tmp/x',
      mimeType: 'text/plain',
      size: 1,
      createdAt: 50,
    })
    store.indexFts(11, 'entry:1', 'to-delete', 'findme deleted conv')
    await store.flushPublic()
    store.deleteConv(11)
    await store.flushPublic()
    assert.equal(store.getConv(11), undefined)
    assert.equal(store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal(store.listArtifacts(11).length, 0)
    assert.ok(store.isDeleted(11))
    await store.close()
    await database.close()
    // Restart: does not resurrect.
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(11), undefined)
    assert.ok(reopened.store.isDeleted(11))
    assert.equal(reopened.store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal((await reopened.store.search('findme')).length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('event sequence monotonicity: rejects negative/non-integer values and never regresses high watermark', { timeout: 60_000 }, async () => {
    const { store, database, dir: d } = await openStore()
    try {
      store.setEventSeq(10)
      store.setEventSeq(9) // Regression: in-memory watermark stays at 10
      assert.equal(store.eventSeqNow, 10)
      assert.throws(() => store.setEventSeq(-1), HelmxError)
      assert.throws(() => store.setEventSeq(1.5), HelmxError)
      await store.flushPublic()
      const row = await database.db.get<{ value: number }>(
        "SELECT value FROM helmx_seq WHERE key = 'events'",
      )
      assert.equal(row?.value, 10)
      await store.close()
      await database.close()
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('returned objects are cloned: external mutations do not corrupt mirror or queued SQL', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'clone-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(12, { tags: ['orig'] }))
    // Clone on read.
    const got = store.getConv(12)
    assert.ok(got)
    got.tags.push('mutated')
    assert.deepEqual(store.getConv(12)?.tags, ['orig'])
    // Snapshot on write: mutating caller object after enqueuing does not alter SQL persistence.
    const mutated = conv(13, { tags: ['before'] })
    store.upsertConv(mutated)
    mutated.tags.push('after-mutation')
    await store.flushPublic()
    const row = await database.db.get<{ tags: string }>(
      'SELECT tags FROM helmx_conversations WHERE id = 13',
    )
    assert.deepEqual(JSON.parse(row!.tags), ['before'])
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('putPluginDoc rejects invalid JSON explicitly; load fails explicitly on corrupted JSON', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'json-'))
    const { store, database } = await openStoreAt(base)
    assert.throws(() => store.putPluginDoc('p', 'bad', '{not-json'), HelmxError)
    await store.flushPublic()
    await store.close()
    await database.close()
    // Inject corrupt data directly and reload: must fail explicitly without silent null/empty fallback.
    const db2 = await openHelmxDatabase(base)
    await db2.db.run("INSERT INTO helmx_plugin_docs (plugin_id, name, value, updated_at) VALUES ('x', 'y', '{broken', 0)")
    await db2.close()
    const db3 = await openHelmxDatabase(base)
    const store3 = new HelmxStore(db3)
    await assert.rejects(() => store3.load(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await db3.close()
    await rm(base, { recursive: true, force: true })
  })

  it('convStatusOf: blocked (pending Ask) takes precedence over working', { timeout: 60_000 }, () => {
    const meta = conv(1)
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 1), 'blocked')
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 0), 'working')
    assert.equal(convStatusOf(meta, { runFailure: { id: 'f' } }, 0), 'error')
    assert.equal(convStatusOf(meta, {}, 0), 'idle')
    assert.equal(convStatusOf({ ...meta, unread: true }, {}, 0), 'done')
  })

  it('database.close is idempotent: repeated close never throws', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'idem-'))
    const { database } = await openStoreAt(base)
    await database.close()
    await database.close() // must not throw
    await rm(base, { recursive: true, force: true })
  })

  it('parentToolCallId link table: auto-created on legacy schema, read/write/clear/delete leave no orphans', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'link-'))
    // Simulate a legacy database holding only `helmx_conversations` (no `parent_tool_call_id`) by dropping the link table.
    const seed = await openHelmxDatabase(base)
    await seed.db.exec('DROP TABLE helmx_conversation_tool_links')
    await seed.close()

    // `openHelmxDatabase` creates the new link table automatically without altering existing rows.
    const { store, database } = await openStoreAt(base)
    // When set: persisted to both mirror and DB
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    await store.flushPublic()
    const linkRow = await database.db.get<{ parent_tool_call_id: string }>(
      'SELECT parent_tool_call_id FROM helmx_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(linkRow?.parent_tool_call_id, parentToolId)
    // Cleared value removes the link row without leaving stale correlations
    store.upsertConv(conv(20, { parentToolCallId: undefined }))
    await store.flushPublic()
    const gone = await database.db.get(
      'SELECT 1 AS x FROM helmx_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(gone, undefined, 'cleared value must remove the link row')
    // Re-writing and reopening merges link cleanly
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    store.upsertConv(conv(21))
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(20)?.parentToolCallId, parentToolId)
    assert.equal(reopened.store.getConv(21)?.parentToolCallId, undefined)
    // Deleting conversation deletes link row synchronously (no orphans)
    reopened.store.deleteConv(20)
    await reopened.store.flushPublic()
    const orphan = await reopened.database.db.get(
      'SELECT 1 AS x FROM helmx_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(orphan, undefined, 'deleting conversation must delete its link row')
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('helmx_artifacts persists and restores kinds; invalid kinds fail at write and load boundaries', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'art-kind-'))
    const { store, database } = await openStoreAt(base)
    store.putArtifact({
      id: 'art-up',
      conversationId: 1,
      kind: 'upload',
      name: 'u.txt',
      path: 'artifacts/1/u.txt',
      mimeType: 'text/plain',
      size: 1,
      createdAt: 10,
    })
    store.putArtifact({
      id: 'art-reg',
      conversationId: 1,
      kind: 'registered',
      name: 'r.txt',
      path: 'artifacts/1/r.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: 20,
    })
    store.putArtifact({
      id: 'art-sp',
      conversationId: 1,
      kind: 'spill',
      name: 's.txt',
      path: 'artifacts/1/s.txt',
      mimeType: 'text/plain',
      size: 3,
      createdAt: 30,
    })
    assert.throws(
      () => store.putArtifact({
        id: 'art-bad',
        conversationId: 1,
        kind: 'bogus' as never,
        name: 'b.txt',
        path: 'artifacts/1/b.txt',
        mimeType: 'text/plain',
        size: 1,
        createdAt: 40,
      }),
      HelmxError,
    )
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.deepEqual(
      reopened.store.listArtifacts(1).map((a) => [a.id, a.kind]),
      [
        ['art-up', 'upload'],
        ['art-reg', 'registered'],
        ['art-sp', 'spill'],
      ],
    )
    await reopened.store.close()
    await reopened.database.close()

    // Corrupt kind in store: load() must fail explicitly with store_data_corrupted
    const dbCorrupt = await openHelmxDatabase(base)
    await dbCorrupt.db.run(
      "INSERT INTO helmx_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at) VALUES ('art-corrupt', 1, 'bad_kind', 'x', 'artifacts/1/x', 'text/plain', 1, 50)",
    )
    await dbCorrupt.close()
    const dbReopen = await openHelmxDatabase(base)
    const storeCorrupt = new HelmxStore(dbReopen)
    await assert.rejects(() => storeCorrupt.load(), (e: unknown) => {
      assert.ok(e instanceof HelmxError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await dbReopen.close()
    await rm(base, { recursive: true, force: true })
  })
})

// ---- test fixture helpers ----

async function openStoreAt(dir: string): Promise<{ store: HelmxStore; database: HelmxDatabase }> {
  const database = await openHelmxDatabase(dir)
  const store = new HelmxStore(database)
  await store.load()
  return { store, database }
}
