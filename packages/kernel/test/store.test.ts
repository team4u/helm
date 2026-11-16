/**
 * HelmStore durable layer test: real temporary SQLite + real NodeSqliteDatabase adapter.
 * error inject only via wrap adapter  run/exec(fixture only inject error, do not mock data).
 * override:flush failed honest (do not virtual call succeeded, error after reject new write,close wait for in-flight),
 * Ask terminal state restart consistent,FTS dedupe/title update/search pre- flush, delete atomicity and restart does not resurrect,
 * ordinal guard against fall back,JSON corrupt explicit errors.
 */

import { HelmError } from '@helm/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openHelmDatabase, type HelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, convStatusOf, type ConvMeta } from '../src/runtime/store.js'

async function openStore(): Promise<{ store: HelmStore; database: HelmDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'helm-store-test-'))
  return { dir, ...await openStoreAt(dir) }
}

/** once fault inject hook hang to already open database.db(only inject error, do not build data). */
function attachFaults(database: HelmDatabase): { failNext(substr: string, error?: Error): void } {
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
    // transaction transaction handle independent at db: wrap after handle inside run/exec same can inject.
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

/** link table test use fixed parent tool invoke ID. */
const parentToolId = 'call-tool-3001'

describe('HelmStore durable layer (real SQLite)', { timeout: 60_000 }, () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-store-suite-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flushPublic wait for real drain: after write immediately can in heavy open store in read to', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'drain-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(7, { title: 'drain-me' }))
    store.putPluginDoc('p', 'k', '{"v":1}')
    await store.flushPublic() // do not early return: right now must already written to the database
    await database.close()
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(7)?.title, 'drain-me')
    assert.equal(reopened.store.getPluginDoc('p', 'k'), '{"v":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deleteGlobalPluginDocs: prefix precise delete (contains smoke number id do not cross, metadata key do not mistakenly delete), restart does not resurrect', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-doc-'))
    const { store, database } = await openStoreAt(base)
    // simulated createGlobalDocumentStore write form: global document hang in __global row,name is `${pluginId}:${doc}`
    store.putPluginDoc('__global', 'foo:records', '{"n":1}')
    store.putPluginDoc('__global', 'foo:cfg', '{"n":2}')
    store.putPluginDoc('__global', 'foo:bar:records', '{"n":3}') // plugin foo:bar data, must not by delete foo mistakenly damage
    store.putPluginDoc('__global', 'conversation-ownership', '{}') // kernel metadata (without smoke number), do not belong any plugin
    store.putPluginDoc('__global', 'other:records', '{"n":4}')
    await store.flushPublic()

    store.deleteGlobalPluginDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:cfg'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), '{"n":3}', 'contains smoke number plugin id data must not cross mistakenly delete')
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}', 'without smoke number kernel metadata key do not subject to affect')
    assert.equal(store.getPluginDoc('__global', 'other:records'), '{"n":4}')

    // again delete contains smoke number id:foo:bar data by clean, other still in
    store.deleteGlobalPluginDocs('foo:bar')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}')
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:records'), undefined, 'after restart must not re-')
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(reopened.store.getPluginDoc('__global', 'other:records'), '{"n":4}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deletePluginSessionDocs: by plugin whole delete (other plugin/other conversation keep), restart does not resurrect', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-session-'))
    const { store, database } = await openStoreAt(base)
    store.putPluginSessionDoc('foo', 'runs', 1, '{"a":1}')
    store.putPluginSessionDoc('foo', 'runs', 2, '{"a":2}')
    store.putPluginSessionDoc('foo', 'notes', 1, '{"b":1}')
    store.putPluginSessionDoc('foobar', 'runs', 1, '{"c":1}') // prefix each other near plugin, must not mistakenly delete
    await store.flushPublic()

    store.deletePluginSessionDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 2), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'notes', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}', 'prefix each other near other plugin must not mistakenly delete')
    assert.deepEqual(store.listPluginSessionDocConversations('foo', 'runs'), [])
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginSessionDoc('foo', 'runs', 1), undefined, 'after restart must not re-')
    assert.equal(reopened.store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('SQL failed:flushPublic explicit throws (never virtual call succeeded), error after reject new write', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fail-'))
    const { store, database } = await openStoreAt(base)
    const fixture = attachFaults(database)
    fixture.failNext('INSERT INTO helm_conversations')
    store.upsertConv(conv(8))
    await assert.rejects(() => store.flushPublic(), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    // error after new write must by reject (fail state, cannot continue false succeeded).
    assert.throws(() => store.upsertConv(conv(9)), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    assert.throws(() => store.putPluginDoc('p', 'k', '{}'), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      return true
    })
    // close same report error (runtime based on this throw HelmError on report).
    const closeError = await store.close()
    assert.ok(closeError !== undefined)
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('close wait for in-flight flush completely end (tail chain do not lose in-flight write)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'close-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(10))
    store.indexFts(10, 'entry:1', 't', 'body text')
    const closing = store.close() // do not await:close and in-flight write concurrency
    await closing
    await database.close()
    // close return after heavy open: in-flight write must already written to the database (cannot because close early retreat lose write).
    const reopened = await openStoreAt(base)
    assert.ok(reopened.store.getConv(10))
    const hits = await reopened.store.search('body')
    assert.equal(hits.length, 1)
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('Ask terminal state restart consistent: compute after restart status/spec/result does not fall back is pending', { timeout: 60_000 }, async () => {
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
    // compute:spec inside contains terminal state status,UPSERT must spec one and written to the database.
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
    assert.equal(row.specJson, settledSpec) // after restart spec still is terminal state, is not pending
    assert.equal(row.resultJson, JSON.stringify({ name: 'v' }))
    assert.equal(row.settledAt, 200)
    const pending = reopened.store.listAsks('pending')
    assert.equal(pending.filter((a) => a.id === 'ask-1').length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS: the same entry duplicate index only a; title update refresh all row;search first flush', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(5, { title: 'old-title' }))
    // the same entry reverse re- index (observer replay scenario).
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:2', 'old-title', 'beta gamma')
    let hits = await store.search('hello') // search internal first await flushPublic
    assert.equal(hits.length, 1, 'the same entry only should has and only has a index row')
    assert.equal(hits[0]?.entryId, 'entry:1')
    // change title: the conversation all index row title update (do not only one row).
    store.upsertConv(conv(5, { title: 'new-title', updatedAt: 2000 }))
    await store.flushPublic()
    const titleRows = await database.db.all<{ title: string; entry_id: string }>(
      'SELECT title, entry_id FROM helm_conversation_fts WHERE conversation_id = 5',
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

  it('FTS rebuild atomic: failed rollback keep old index (do not false succeeded)', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'rebuild-'))
    const { store, database } = await openStoreAt(base)
    store.indexFts(6, 'entry:1', 't', 'original content')
    await store.flushPublic()
    const fixture = attachFaults(database)
    fixture.failNext('DELETE FROM helm_conversation_fts')
    await assert.rejects(
      () =>
        store.rebuildFts(async () => {
          /* replay */
        }),
      /injected/,
    )
    // rollback after old index still can inspect (derive index not lose).
    const hits = await store.search('original')
    assert.equal(hits.length, 1)
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('delete conversation: restart does not resurrect (tombstone + row clean up atomic written to the database),asks/artifacts leaves no residue', {
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
    // restart: does not resurrect.
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(11), undefined)
    assert.ok(reopened.store.isDeleted(11))
    assert.equal(reopened.store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal((await reopened.store.search('findme')).length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('event ordinal guard against fall back: reject negative number/non- integer, low ordinal does not override high watermark', { timeout: 60_000 }, async () => {
    const { store, database, dir: d } = await openStore()
    try {
      store.setEventSeq(10)
      store.setEventSeq(9) // fall back: memory does not fall back
      assert.equal(store.eventSeqNow, 10)
      assert.throws(() => store.setEventSeq(-1), HelmError)
      assert.throws(() => store.setEventSeq(1.5), HelmError)
      await store.flushPublic()
      const row = await database.db.get<{ value: number }>(
        "SELECT value FROM helm_seq WHERE key = 'events'",
      )
      assert.equal(row?.value, 10)
      await store.close()
      await database.close()
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('return can change object is clone: external sudden change do not pollute mirror and queue up SQL', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'clone-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(12, { tags: ['orig'] }))
    // read side clone.
    const got = store.getConv(12)
    assert.ok(got)
    got.tags.push('mutated')
    assert.deepEqual(store.getConv(12)?.tags, ['orig'])
    // write side snapshot: queue after caller change original object does not affect written to the database.
    const mutated = conv(13, { tags: ['before'] })
    store.upsertConv(mutated)
    mutated.tags.push('after-mutation')
    await store.flushPublic()
    const row = await database.db.get<{ tags: string }>(
      'SELECT tags FROM helm_conversations WHERE id = 13',
    )
    assert.deepEqual(JSON.parse(row!.tags), ['before'])
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('putPluginDoc illegal JSON explicit reject;load encounter corrupt JSON explicit errors', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'json-'))
    const { store, database } = await openStoreAt(base)
    assert.throws(() => store.putPluginDoc('p', 'bad', '{not-json'), HelmError)
    await store.flushPublic()
    await store.close()
    await database.close()
    // directly write broken data again load: must explicit error, never false null value.
    const db2 = await openHelmDatabase(base)
    await db2.db.run("INSERT INTO helm_plugin_docs (plugin_id, name, value, updated_at) VALUES ('x', 'y', '{broken', 0)")
    await db2.close()
    const db3 = await openHelmDatabase(base)
    const store3 = new HelmStore(db3)
    await assert.rejects(() => store3.load(), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await db3.close()
    await rm(base, { recursive: true, force: true })
  })

  it('convStatusOf:blocked(pending Ask) takes precedence at working', { timeout: 60_000 }, () => {
    const meta = conv(1)
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 1), 'blocked')
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 0), 'working')
    assert.equal(convStatusOf(meta, { runFailure: { id: 'f' } }, 0), 'error')
    assert.equal(convStatusOf(meta, {}, 0), 'idle')
    assert.equal(convStatusOf({ ...meta, unread: true }, {}, 0), 'done')
  })

  it('database.close idempotent: duplicate close do not throws', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'idem-'))
    const { database } = await openStoreAt(base)
    await database.close()
    await database.close() // do not throw
    await rm(base, { recursive: true, force: true })
  })

  it('parentToolCallId independent link table: now row original table (without the column) old store automatically create new table, write heavy open can read, null value clean up, delete do not orphan child', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'link-'))
    // first use now row schema store normal open once, again link table delete and manually work remove - - simulated only
    // old helm_conversations original table (without parent_tool_call_id column) existing database.
    const seed = await openHelmDatabase(base)
    await seed.db.exec('DROP TABLE helm_conversation_tool_links')
    await seed.close()

    // openHelmDatabase in do not modify old table before mention under automatically create all new link table: existing record do not use change.
    const { store, database } = await openStoreAt(base)
    // has value: mirror and store also write
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    await store.flushPublic()
    const linkRow = await database.db.get<{ parent_tool_call_id: string }>(
      'SELECT parent_tool_call_id FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(linkRow?.parent_tool_call_id, parentToolId)
    // null value clean up: placement empty after link row delete, do not stale related
    store.upsertConv(conv(20, { parentToolCallId: undefined }))
    await store.flushPublic()
    const gone = await database.db.get(
      'SELECT 1 AS x FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(gone, undefined, 'null value should clean up link row')
    // again write back and heavy open: merge read succeeded
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    store.upsertConv(conv(21))
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(20)?.parentToolCallId, parentToolId)
    assert.equal(reopened.store.getConv(21)?.parentToolCallId, undefined)
    // delete conversation sync delete link: do not orphan child
    reopened.store.deleteConv(20)
    await reopened.store.flushPublic()
    const orphan = await reopened.database.db.get(
      'SELECT 1 AS x FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(orphan, undefined, 'delete conversation must sync delete link row')
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('helm_artifacts read write and restart restore kind; illegal kind in write/load boundary explicit reject', { timeout: 60_000 }, async () => {
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
      HelmError,
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

    // store inside corrupt kind:load() must explicit errors store_data_corrupted
    const dbCorrupt = await openHelmDatabase(base)
    await dbCorrupt.db.run(
      "INSERT INTO helm_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at) VALUES ('art-corrupt', 1, 'bad_kind', 'x', 'artifacts/1/x', 'text/plain', 1, 50)",
    )
    await dbCorrupt.close()
    const dbReopen = await openHelmDatabase(base)
    const storeCorrupt = new HelmStore(dbReopen)
    await assert.rejects(() => storeCorrupt.load(), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      assert.equal(e.code, 'store_data_corrupted')
      return true
    })
    await dbReopen.close()
    await rm(base, { recursive: true, force: true })
  })
})

// ---- test base seat auxiliary ----

async function openStoreAt(dir: string): Promise<{ store: HelmStore; database: HelmDatabase }> {
  const database = await openHelmDatabase(dir)
  const store = new HelmStore(database)
  await store.load()
  return { store, database }
}
