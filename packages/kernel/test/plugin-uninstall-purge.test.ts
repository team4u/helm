/**
 * 插件卸载关联清理（purgePluginPersistentData）端到端：
 * 真实 HelmStore（临时 SQLite）+ 真实 PluginHost，注入生产级 doc/sessionDoc
 * 端口（createGlobalDocumentStore / createPluginSessionDocStore），验证：
 * - 卸载清理真正落库删除该插件全部文档（全局 doc + 全部会话文档），重启不复活；
 * - 含冒号插件 id（如 `demo:sub`）不被 `demo` 的清理交叉误删；
 * - 其他插件数据与内核元数据键（无冒号）不受影响；
 * - 停用（disable）不清数据，重新启用读回原值（与卸载语义的分界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type ConversationSummary } from '@helm/protocol'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import {
  createGlobalDocumentStore,
  createPluginSessionDocStore,
} from '../src/runtime/runtime-host-backend.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

interface StoreHandle {
  store: HelmStore
  close(): Promise<void>
}

async function openStore(dir: string): Promise<StoreHandle> {
  const database = await openHelmDatabase(dir)
  const store = new HelmStore(database)
  await store.load()
  return {
    store,
    close: () => database.close(),
  }
}

function makeHost(handle: StoreHandle, dataDir: string): PluginHost {
  const backend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    getConversation: (id: number): ConversationSummary => {
      if (id !== 1) {
        throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      }
      return {
        id,
        title: 'conv-1',
        profileId: 'default',
        tags: [],
        cwd: '/tmp',
        model: 'test/model',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }
    },
  }
  return new PluginHost({
    dataDir,
    host: backend,
    docs: createGlobalDocumentStore(handle.store),
    sessionDocs: createPluginSessionDocStore(handle.store),
  })
}

test('purgePluginPersistentData：SQLite 中该插件全局 doc 与会话文档整体清除、不交叉误删、重启不复活', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'helm-purge-e2e-'))
  try {
    const handle = await openStore(base)
    const host = makeHost(handle, join(base, 'plugins'))

    await host.register({
      id: 'demo',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }).set({ n: 1 })
        ctx.sessionDoc<{ ids: string[] }>('runs', { ids: [] }).set(1, { ids: ['r1'] })
      },
    })
    await host.register({
      id: 'demo:sub',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }).set({ n: 9 })
      },
    })
    await host.register({
      id: 'other',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }).set({ n: 2 })
      },
    })
    await handle.store.flushPublic()

    // 内核元数据（无冒号键）与生产存储同宿主共存，清理不得波及
    handle.store.putPluginDoc('__global', 'conversation-ownership', '{"1":"human"}')

    // 卸载清理（与 package-manager.remove 的调用点一致）
    host.asPackageManagerHost().purgePluginPersistentData('demo')
    await handle.store.flushPublic()

    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), undefined, '目标插件全局 doc 应被删除')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), undefined, '目标插件会话文档应被删除')
    assert.equal(
      handle.store.getPluginDoc('__global', 'demo:sub:records'),
      '{"n":9}',
      '含冒号插件 id（demo:sub）的数据不得被 demo 的清理交叉误删',
    )
    assert.equal(handle.store.getPluginDoc('__global', 'other:records'), '{"n":2}', '其他插件数据不受影响')
    assert.equal(
      handle.store.getPluginDoc('__global', 'conversation-ownership'),
      '{"1":"human"}',
      '内核元数据键（无冒号）不受影响',
    )
    await handle.close()

    // 重开库：删除真实落盘，不复活
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, '重启后不得复活')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, '重启后不得复活')
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:sub:records'), '{"n":9}')
    await reopened.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('停用不清数据：disable 后 doc/sessionDoc 持久保留，重新启用读回原值', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'helm-purge-disable-'))
  try {
    const handle = await openStore(base)
    const host = makeHost(handle, join(base, 'plugins'))

    await host.register({
      id: 'demo',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }, { public: true }).set({ n: 1 })
        ctx.sessionDoc<{ ids: string[] }>('runs', { ids: [] }).set(1, { ids: ['r1'] })
      },
    })
    await handle.store.flushPublic()

    await host.disable('demo')
    await handle.store.flushPublic()
    // 停用只清注册表句柄，不动持久数据
    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), '{"n":1}', '停用不得删除持久数据')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), '{"ids":["r1"]}', '停用不得删除持久数据')

    // 重新启用：注册表重建，读回旧值
    await host.enable('demo')
    const doc = host.getPublicDoc('demo', 'records')
    assert.deepEqual(doc.value, { n: 1 })
    await handle.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
