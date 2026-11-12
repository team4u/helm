/**
 * 插件卸载关联清理（purgePluginPersistentData）端到端：
 * 真实 HelmStore（临时 SQLite）+ 真实 PluginHost，注入生产级 doc/sessionDoc
 * 端口（createGlobalDocumentStore / createPluginSessionDocStore），验证：
 * - 卸载清理真正落库删除该插件全部文档（全局 doc + 全部会话文档），重启不复活；
 * - purge 自身等待 DELETE 真实落盘后才 resolve（无外部补刷）；
 * - 真实 PluginPackageManager.remove：purge 落盘成功后才删目录/删记录；
 * - purge DELETE 落盘失败：remove 显式拒绝，目录与安装记录保留可重试；
 * - 含冒号插件 id（如 `demo:sub`）不被 `demo` 的清理交叉误删；
 * - 其他插件数据与内核元数据键（无冒号）不受影响；
 * - 停用（disable）不清数据，重新启用读回原值（与卸载语义的分界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type ConversationSummary } from '@helm/protocol'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { PluginPackageManager } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import {
  createGlobalDocumentStore,
  createPluginSessionDocStore,
} from '../src/runtime/runtime-host-backend.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

interface StoreHandle {
  store: HelmStore
  /**
   * 一次性 SQL 故障注入：首条包含 substr 的 db.run 拒绝（只注入错误，不 mock
   * 数据）；非命中语句原样放行，命中后恢复原始实现。
   */
  failNextRun(substr: string): void
  close(): Promise<void>
}

async function openStore(dir: string): Promise<StoreHandle> {
  const database = await openHelmDatabase(dir)
  const store = new HelmStore(database)
  await store.load()
  return {
    store,
    failNextRun(substr: string) {
      const db = database.db as unknown as {
        run: (sql: string, ...params: unknown[]) => Promise<unknown>
      }
      const orig = db.run.bind(db)
      let armed = true
      db.run = (sql, ...params) => {
        if (armed && sql.includes(substr)) {
          armed = false
          return Promise.reject(new Error('injected SQL failure'))
        }
        return orig(sql, ...params)
      }
    },
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

    // 卸载清理（与 package-manager.remove 的调用点一致）：purge 自身等待
    // DELETE 真实落盘后才 resolve——此处不补刷 flushPublic，重开库即验证。
    await host.asPackageManagerHost().purgePluginPersistentData('demo')

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

/** 构造受管安装最终态：受管目录 + 安装记录（与 install 事务产物等价）。 */
async function seedManagedInstall(
  base: string,
  pluginId: string,
): Promise<{ managed: string; pkgStore: PluginPackageManagerStore }> {
  const managed = join(base, 'plugins', pluginId)
  mkdirSync(managed, { recursive: true })
  writeFileSync(join(managed, 'plugin.json'), JSON.stringify({ id: pluginId, version: '0.1.0', main: 'index.mjs' }))
  writeFileSync(join(managed, 'index.mjs'), `export default { id: '${pluginId}', version: '0.1.0', definePlugin() {} }\n`)
  const pkgStore = new PluginPackageManagerStore(new ConfigService(base))
  await pkgStore.load()
  await pkgStore.save({
    pluginId,
    source: { kind: 'local', raw: managed, path: managed },
    installPath: managed,
    version: '0.1.0',
    installedAt: Date.now(),
    updatedAt: Date.now(),
  })
  return { managed, pkgStore }
}

test('PluginPackageManager.remove：purge 落盘成功后才删目录与安装记录（重开库不复活）', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'helm-purge-rm-'))
  try {
    const handle = await openStore(base)
    const host = makeHost(handle, join(base, 'plugins'))
    const { managed, pkgStore } = await seedManagedInstall(base, 'demo')
    const manager = new PluginPackageManager({
      dataDir: base,
      cwd: base,
      store: pkgStore,
      host: host.asPackageManagerHost(),
    })
    await host.register({
      id: 'demo',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }).set({ n: 1 })
        ctx.sessionDoc<{ ids: string[] }>('runs', { ids: [] }).set(1, { ids: ['r1'] })
      },
    })
    await handle.store.flushPublic()

    const removed = await manager.remove('demo')
    assert.equal(removed.pluginId, 'demo')
    assert.ok(!existsSync(managed), 'remove 返回前受管目录必须已删除')
    assert.equal(pkgStore.getRecord('demo'), undefined, 'remove 返回前安装记录必须已删除')

    // remove resolve 即代表 purge 的 DELETE 已真实落盘：不补任何 flush，
    // 直接重开库验证（若 purge 未等待落盘，此处会复活）。
    await handle.close()
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'remove resolve 后删除必须已落盘')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'remove resolve 后删除必须已落盘')
    await reopened.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('purge DELETE 落盘失败：remove 显式拒绝，目录与安装记录保留，故障恢复后可重试', { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'helm-purge-fail-'))
  try {
    const handle = await openStore(base)
    const host = makeHost(handle, join(base, 'plugins'))
    const { managed, pkgStore } = await seedManagedInstall(base, 'demo')
    const manager = new PluginPackageManager({
      dataDir: base,
      cwd: base,
      store: pkgStore,
      host: host.asPackageManagerHost(),
    })
    await host.register({
      id: 'demo',
      definePlugin: (ctx) => {
        ctx.doc('records', { n: 0 }).set({ n: 1 })
        ctx.sessionDoc<{ ids: string[] }>('runs', { ids: [] }).set(1, { ids: ['r1'] })
      },
    })
    await handle.store.flushPublic()

    // 注入全局 doc DELETE 落盘失败：remove 必须显式拒绝，不得继续删目录/记录
    handle.failNextRun('DELETE FROM helm_plugin_docs')
    await assert.rejects(
      manager.remove('demo'),
      (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
    )
    assert.ok(existsSync(managed), 'purge 落盘失败时受管目录必须保留')
    assert.ok(pkgStore.getRecord('demo'), 'purge 落盘失败时安装记录必须保留（可重试）')
    await handle.close()

    // 故障恢复后重开（等价进程重启）：失败的 DELETE 未清除已落盘数据
    const reopened = await openStore(base)
    assert.notEqual(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, '失败的 DELETE 不得虚删已落盘数据')
    // 全新宿主链重试 remove：实例已注销由 removeManagedPlugin 幂等容忍，完整成功
    const retryHost = makeHost(reopened, join(base, 'plugins'))
    const retryPkgStore = new PluginPackageManagerStore(new ConfigService(base))
    await retryPkgStore.load()
    assert.ok(retryPkgStore.getRecord('demo'), '重开的安装记录应完整恢复')
    const retryManager = new PluginPackageManager({
      dataDir: base,
      cwd: base,
      store: retryPkgStore,
      host: retryHost.asPackageManagerHost(),
    })
    const removed = await retryManager.remove('demo')
    assert.equal(removed.pluginId, 'demo')
    assert.equal(removed.wasEnabled, false, '首次失败已注销实例，重试 wasEnabled 如实为 false')
    assert.ok(!existsSync(managed), '重试成功后受管目录删除')
    assert.equal(retryPkgStore.getRecord('demo'), undefined, '重试成功后安装记录删除')
    await reopened.close()

    const verified = await openStore(base)
    assert.equal(verified.store.getPluginDoc('__global', 'demo:records'), undefined, '重试成功的删除真实落盘')
    assert.equal(verified.store.getPluginSessionDoc('demo', 'runs', 1), undefined, '重试成功的删除真实落盘')
    await verified.close()
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
