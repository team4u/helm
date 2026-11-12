/**
 * HelmStore 持久层测试：真实临时 SQLite + 真实 NodeSqliteDatabase adapter。
 * 错误注入仅通过包装 adapter 的 run/exec（fixture 只注入错误，不 mock 数据）。
 * 覆盖：flush 失败诚实性（不虚称成功、错误后拒绝新写、close 等待在途）、
 * Ask 终态重启一致、FTS 去重/标题更新/search 前置 flush、删除原子性与重启不复活、
 * 序号防回退、JSON 损坏显式报错。
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

/** 把一次性故障注入钩子挂到已打开的 database.db（只注入错误，不造数据）。 */
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
    // transaction 的事务句柄独立于 db：包装后句柄内的 run/exec 同样可注入。
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

/** 链接表测试用固定父工具调用 ID。 */
const parentToolId = 'call-tool-3001'

describe('HelmStore 持久层（真实 SQLite）', { timeout: 60_000 }, () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-store-suite-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('flushPublic 等待真实 drain：写入后立即可在重开的库中读到', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'drain-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(7, { title: 'drain-me' }))
    store.putPluginDoc('p', 'k', '{"v":1}')
    await store.flushPublic() // 不早返回：此刻必须已落库
    await database.close()
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(7)?.title, 'drain-me')
    assert.equal(reopened.store.getPluginDoc('p', 'k'), '{"v":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deleteGlobalPluginDocs：前缀精确删除（含冒号 id 不交叉、元数据键不误删）、重启不复活', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-doc-'))
    const { store, database } = await openStoreAt(base)
    // 模拟 createGlobalDocumentStore 的写入形态：全局文档挂在 __global 行、name 为 `${pluginId}:${doc}`
    store.putPluginDoc('__global', 'foo:records', '{"n":1}')
    store.putPluginDoc('__global', 'foo:cfg', '{"n":2}')
    store.putPluginDoc('__global', 'foo:bar:records', '{"n":3}') // 插件 foo:bar 的数据，不得被删 foo 误伤
    store.putPluginDoc('__global', 'conversation-ownership', '{}') // 内核元数据（无冒号），不属任何插件
    store.putPluginDoc('__global', 'other:records', '{"n":4}')
    await store.flushPublic()

    store.deleteGlobalPluginDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:cfg'), undefined)
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), '{"n":3}', '含冒号插件 id 的数据不得交叉误删')
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}', '无冒号的内核元数据键不受影响')
    assert.equal(store.getPluginDoc('__global', 'other:records'), '{"n":4}')

    // 再删含冒号 id：foo:bar 的数据被清，其他仍在
    store.deleteGlobalPluginDocs('foo:bar')
    await store.flushPublic()
    assert.equal(store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(store.getPluginDoc('__global', 'conversation-ownership'), '{}')
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:records'), undefined, '重启后不得复活')
    assert.equal(reopened.store.getPluginDoc('__global', 'foo:bar:records'), undefined)
    assert.equal(reopened.store.getPluginDoc('__global', 'other:records'), '{"n":4}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('deletePluginSessionDocs：按插件整体删除（其他插件/其他会话保留）、重启不复活', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'purge-session-'))
    const { store, database } = await openStoreAt(base)
    store.putPluginSessionDoc('foo', 'runs', 1, '{"a":1}')
    store.putPluginSessionDoc('foo', 'runs', 2, '{"a":2}')
    store.putPluginSessionDoc('foo', 'notes', 1, '{"b":1}')
    store.putPluginSessionDoc('foobar', 'runs', 1, '{"c":1}') // 前缀相近插件，不得误删
    await store.flushPublic()

    store.deletePluginSessionDocs('foo')
    await store.flushPublic()
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'runs', 2), undefined)
    assert.equal(store.getPluginSessionDoc('foo', 'notes', 1), undefined)
    assert.equal(store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}', '前缀相近的其他插件不得误删')
    assert.deepEqual(store.listPluginSessionDocConversations('foo', 'runs'), [])
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getPluginSessionDoc('foo', 'runs', 1), undefined, '重启后不得复活')
    assert.equal(reopened.store.getPluginSessionDoc('foobar', 'runs', 1), '{"c":1}')
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('SQL 失败：flushPublic 显式抛错（绝不虚称成功），错误后拒绝新写', { timeout: 60_000 }, async () => {
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
    // 错误后新写必须被拒绝（fail 状态，不能继续假成功）。
    assert.throws(() => store.upsertConv(conv(9)), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      assert.equal(e.code, 'store_flush_failed')
      return true
    })
    assert.throws(() => store.putPluginDoc('p', 'k', '{}'), (e: unknown) => {
      assert.ok(e instanceof HelmError)
      return true
    })
    // close 同样报告错误（runtime 据此抛 HelmError 上报）。
    const closeError = await store.close()
    assert.ok(closeError !== undefined)
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('close 等待在途 flush 彻底结束（尾链不丢在途写）', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'close-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(10))
    store.indexFts(10, 'entry:1', 't', 'body text')
    const closing = store.close() // 不 await：close 与在途写并发
    await closing
    await database.close()
    // close 返回后重开：在途写必须已落库（不能因 close 早退丢写）。
    const reopened = await openStoreAt(base)
    assert.ok(reopened.store.getConv(10))
    const hits = await reopened.store.search('body')
    assert.equal(hits.length, 1)
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('Ask 终态重启一致：结算后重启 status/spec/result 不回退为 pending', { timeout: 60_000 }, async () => {
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
    // 结算：spec 内含终态 status，UPSERT 必须把 spec 一并落库。
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
    assert.equal(row.specJson, settledSpec) // 重启后 spec 仍是终态，不是 pending
    assert.equal(row.resultJson, JSON.stringify({ name: 'v' }))
    assert.equal(row.settledAt, 200)
    const pending = reopened.store.listAsks('pending')
    assert.equal(pending.filter((a) => a.id === 'ask-1').length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('FTS：同一 entry 重复索引仅一条；标题更新刷新全部行；search 先 flush', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'fts-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(5, { title: 'old-title' }))
    // 同一 entry 反复索引（observer 重放场景）。
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:1', 'old-title', 'hello world alpha')
    store.indexFts(5, 'entry:2', 'old-title', 'beta gamma')
    let hits = await store.search('hello') // search 内部先 await flushPublic
    assert.equal(hits.length, 1, '同一 entry 只应有且仅有一条索引行')
    assert.equal(hits[0]?.entryId, 'entry:1')
    // 改标题：该会话全部索引行 title 更新（不只第一行）。
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

  it('FTS 重建原子：失败回滚保留旧索引（不假成功）', { timeout: 60_000 }, async () => {
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
    // 回滚后旧索引仍可查（派生索引未丢）。
    const hits = await store.search('original')
    assert.equal(hits.length, 1)
    await store.close()
    await database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('删除会话：重启不复活（tombstone + 行清理原子落库），asks/artifacts 不残留', {
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
    // 重启：不复活。
    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(11), undefined)
    assert.ok(reopened.store.isDeleted(11))
    assert.equal(reopened.store.listAsks().filter((a) => a.conversationId === 11).length, 0)
    assert.equal((await reopened.store.search('findme')).length, 0)
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })

  it('事件序号防回退：拒绝负数/非整数，低序号不覆盖高水位', { timeout: 60_000 }, async () => {
    const { store, database, dir: d } = await openStore()
    try {
      store.setEventSeq(10)
      store.setEventSeq(9) // 回退：内存不回退
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

  it('返回可变对象为克隆：外部突变不污染镜像与排队 SQL', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'clone-'))
    const { store, database } = await openStoreAt(base)
    store.upsertConv(conv(12, { tags: ['orig'] }))
    // 读侧克隆。
    const got = store.getConv(12)
    assert.ok(got)
    got.tags.push('mutated')
    assert.deepEqual(store.getConv(12)?.tags, ['orig'])
    // 写侧快照：入队后调用方改原对象不影响落库。
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

  it('putPluginDoc 非法 JSON 显式拒绝；load 遇损坏 JSON 显式报错', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'json-'))
    const { store, database } = await openStoreAt(base)
    assert.throws(() => store.putPluginDoc('p', 'bad', '{not-json'), HelmError)
    await store.flushPublic()
    await store.close()
    await database.close()
    // 直接写坏数据再 load：必须显式错误，绝不假空值。
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

  it('convStatusOf：blocked（pending Ask）优先于 working', { timeout: 60_000 }, () => {
    const meta = conv(1)
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 1), 'blocked')
    assert.equal(convStatusOf(meta, { run: { id: 'r' } }, 0), 'working')
    assert.equal(convStatusOf(meta, { runFailure: { id: 'f' } }, 0), 'error')
    assert.equal(convStatusOf(meta, {}, 0), 'idle')
    assert.equal(convStatusOf({ ...meta, unread: true }, {}, 0), 'done')
  })

  it('database.close 幂等：重复关闭不抛错', { timeout: 60_000 }, async () => {
    const base = await mkdtemp(join(dir, 'idem-'))
    const { database } = await openStoreAt(base)
    await database.close()
    await database.close() // 不抛
    await rm(base, { recursive: true, force: true })
  })

  it('parentToolCallId 独立链接表：现行原表（无该列）的旧库自动建新表，写入重开可读，空值清理，删除不留孤儿', {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(dir, 'link-'))
    // 先用现行 schema 的库正常打开一次，再把链接表删掉并手工去掉——模拟只有
    // 旧 helm_conversations 原表（无 parent_tool_call_id 列）的现有数据库。
    const seed = await openHelmDatabase(base)
    await seed.db.exec('DROP TABLE helm_conversation_tool_links')
    await seed.close()

    // openHelmDatabase 在不修改旧表的前提下自动创建全新链接表：现有记录不用变。
    const { store, database } = await openStoreAt(base)
    // 有值：镜像与库同时写入
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    await store.flushPublic()
    const linkRow = await database.db.get<{ parent_tool_call_id: string }>(
      'SELECT parent_tool_call_id FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(linkRow?.parent_tool_call_id, parentToolId)
    // 空值清理：置空后链接行删除，不留陈旧关联
    store.upsertConv(conv(20, { parentToolCallId: undefined }))
    await store.flushPublic()
    const gone = await database.db.get(
      'SELECT 1 AS x FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(gone, undefined, '空值应清理链接行')
    // 再写回并重开：合并读取成功
    store.upsertConv(conv(20, { parentToolCallId: parentToolId }))
    store.upsertConv(conv(21))
    await store.flushPublic()
    await store.close()
    await database.close()

    const reopened = await openStoreAt(base)
    assert.equal(reopened.store.getConv(20)?.parentToolCallId, parentToolId)
    assert.equal(reopened.store.getConv(21)?.parentToolCallId, undefined)
    // 删除会话同步删 link：不留孤儿
    reopened.store.deleteConv(20)
    await reopened.store.flushPublic()
    const orphan = await reopened.database.db.get(
      'SELECT 1 AS x FROM helm_conversation_tool_links WHERE conversation_id = 20',
    )
    assert.equal(orphan, undefined, '删除会话必须同步删除链接行')
    await reopened.store.close()
    await reopened.database.close()
    await rm(base, { recursive: true, force: true })
  })
})

// ---- 测试基座辅助 ----

async function openStoreAt(dir: string): Promise<{ store: HelmStore; database: HelmDatabase }> {
  const database = await openHelmDatabase(dir)
  const store = new HelmStore(database)
  await store.load()
  return { store, database }
}
