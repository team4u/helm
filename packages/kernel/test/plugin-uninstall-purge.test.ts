/**
 * plugin unload related clean up (purgePluginPersistentData) end-to-end:
 * real HelmStore(temporary SQLite)+ real PluginHost, inject produce level doc/sessionDoc
 * port (createGlobalDocumentStore / createPluginSessionDocStore), verify:
 * - unload clean up truly written to the database delete the plugin all document (global doc + all conversation document), restart does not resurrect;
 * - purge itself wait for DELETE real after only then resolve(without external patch refresh);
 * - real PluginPackageManager.remove:purge after success only then delete directory/delete record;
 * - purge DELETE failed:remove explicit reject, directory and install record keep can retry;
 * - contains smoke number plugin id(such as `demo:sub`) do not by `demo` clean up cross mistakenly delete;
 * - other plugin data and kernel metadata key (without smoke number) do not subject to affect;
 * - deactivate (disable) do not clean data, re- enable read back original value (and unload semantics boundary).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
import { createPluginBuildProvider } from '@helm/plugin-build'
import { cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js'

interface StoreHandle {
  store: HelmStore
  /**
   * once SQL fault inject: first contains substr  db.run reject (only inject error, do not mock
   * data); non- hit statement original let through, hit after restore original implement.
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
        throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      }
      return makeConversationSummary({ id, title: 'conv-1', profileId: 'default' })
    },
  }
  return new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: createGlobalDocumentStore(handle.store),
    sessionDocs: createPluginSessionDocStore(handle.store),
  })
}

test('purgePluginPersistentData:SQLite in the plugin global doc and conversation document whole clear, do not cross mistakenly delete, restart does not resurrect', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helm-purge-e2e-')
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

    // kernel metadata (without smoke number key) and produce store same host shared store, clean up must not wave and
    handle.store.putPluginDoc('__global', 'conversation-ownership', '{"1":"human"}')

    // unload clean up (and package-manager.remove invoke point consistent):purge itself wait for
    // DELETE real after only then resolve- - this where do not patch refresh flushPublic, heavy open store i.e. verify.
    await host.asPackageManagerHost().purgePluginPersistentData('demo')

    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), undefined, 'target plugin global doc should by delete')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'target plugin conversation document should by delete')
    assert.equal(
      handle.store.getPluginDoc('__global', 'demo:sub:records'),
      '{"n":9}',
      'contains smoke number plugin id(demo:sub) data must not by demo clean up cross mistakenly delete',
    )
    assert.equal(handle.store.getPluginDoc('__global', 'other:records'), '{"n":2}', 'other plugin data do not subject to affect')
    assert.equal(
      handle.store.getPluginDoc('__global', 'conversation-ownership'),
      '{"1":"human"}',
      'kernel metadata key (without smoke number) do not subject to affect',
    )
    await handle.close()

    // heavy open store: delete real, does not resurrect
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'after restart must not re-')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'after restart must not re-')
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:sub:records'), '{"n":9}')
    await reopened.close()
  } finally {
    await cleanupDir(base)
  }
})

/** construct managed install eventually state: managed directory + install record (and install transaction artifact etc. price). */
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

test('PluginPackageManager.remove:purge after success only then delete directory and install record (heavy open store does not resurrect)', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helm-purge-rm-')
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
    assert.ok(!existsSync(managed), 'remove return before managed directory must deleted')
    assert.equal(pkgStore.getRecord('demo'), undefined, 'remove return before install record must deleted')

    // remove resolve i.e. proxy table purge  DELETE already real: do not patch any flush,
    // directly heavy open store verify (if purge not wait for, this where will re-).
    await handle.close()
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'remove resolve after delete must already')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'remove resolve after delete must already')
    await reopened.close()
  } finally {
    await cleanupDir(base)
  }
})

test('purge DELETE failed:remove explicit reject, directory and install record keep, fault restore after can retry', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helm-purge-fail-')
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

    // inject global doc DELETE failed:remove must explicit reject, must not continue delete directory/record
    handle.failNextRun('DELETE FROM helm_plugin_docs')
    await assert.rejects(
      manager.remove('demo'),
      (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed',
    )
    assert.ok(existsSync(managed), 'purge on failure managed directory must keep')
    assert.ok(pkgStore.getRecord('demo'), 'purge on failure install record must keep (can retry)')
    await handle.close()

    // fault restore after heavy open (etc. price process restart): failed DELETE not clear already data
    const reopened = await openStore(base)
    assert.notEqual(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'failed DELETE must not virtual delete already data')
    // all new host chain retry remove: instance deregistered by removeManagedPlugin idempotent contain tolerate, complete succeeded
    const retryHost = makeHost(reopened, join(base, 'plugins'))
    const retryPkgStore = new PluginPackageManagerStore(new ConfigService(base))
    await retryPkgStore.load()
    assert.ok(retryPkgStore.getRecord('demo'), 'heavy open install record should complete restore')
    const retryManager = new PluginPackageManager({
      dataDir: base,
      cwd: base,
      store: retryPkgStore,
      host: retryHost.asPackageManagerHost(),
    })
    const removed = await retryManager.remove('demo')
    assert.equal(removed.pluginId, 'demo')
    assert.equal(removed.wasEnabled, false, 'first time failed deregistered instance, retry wasEnabled such as is false')
    assert.ok(!existsSync(managed), 'retry after success managed directory delete')
    assert.equal(retryPkgStore.getRecord('demo'), undefined, 'retry after success install record delete')
    await reopened.close()

    const verified = await openStore(base)
    assert.equal(verified.store.getPluginDoc('__global', 'demo:records'), undefined, 'retry succeeded delete real')
    assert.equal(verified.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'retry succeeded delete real')
    await verified.close()
  } finally {
    await cleanupDir(base)
  }
})

test('deactivate do not clean data:disable after doc/sessionDoc durable keep, re- enable read back original value', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helm-purge-disable-')
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
    // deactivate only clean register table handle, do not motion durable data
    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), '{"n":1}', 'deactivate must not delete durable data')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), '{"ids":["r1"]}', 'deactivate must not delete durable data')

    // re- enable: register table rebuild, read back old value
    await host.enable('demo')
    const doc = host.getPublicDoc('demo', 'records')
    assert.deepEqual(doc.value, { n: 1 })
    await handle.close()
  } finally {
    await cleanupDir(base)
  }
})
