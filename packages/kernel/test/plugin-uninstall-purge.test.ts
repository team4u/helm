/**
 * End-to-end tests for plugin uninstall cleanup (purgePluginPersistentData):
 * Real HelmxStore (temporary SQLite) + real PluginHost with injected production-level
 * doc/sessionDoc stores (createGlobalDocumentStore / createPluginSessionDocStore), verifying:
 * - uninstall purge deletes all persisted docs for that plugin from SQLite (global docs + all
 *   conversation session docs), and restarts never resurrect them;
 * - purge awaits SQL DELETE completion before resolving (no external flush patch needed);
 * - real PluginPackageManager.remove deletes directory/record only after purge succeeds;
 * - failed purge DELETE rejects remove explicitly, preserving directory and record for retry;
 * - colon-namespaced plugin IDs (such as `demo:sub`) are not collaterally deleted by `demo` purge;
 * - other plugins' data and kernel metadata keys (without colons) remain untouched;
 * - disable does not delete data; re-enabling reads back original values (clean semantic boundary).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { PluginPackageManager } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore } from '../src/runtime/store.js'
import {
  createGlobalDocumentStore,
  createPluginSessionDocStore,
} from '../src/runtime/runtime-host-backend.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js'

interface StoreHandle {
  store: HelmxStore
  /**
   * One-shot SQL fault injection: rejects the first db.run matching substr (injects failure only,
   * never mocks data); passes unmatched statements through and restores original impl after hitting.
   */
  failNextRun(substr: string): void
  close(): Promise<void>
}

async function openStore(dir: string): Promise<StoreHandle> {
  const database = await openHelmxDatabase(dir)
  const store = new HelmxStore(database)
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
        throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
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

test('purgePluginPersistentData: clears all global and session docs from SQLite without collateral deletion or restart resurrection', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helmx-purge-e2e-')
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

    // Kernel metadata (colon-less key) shares the same host store and must remain untouched by purge.
    handle.store.putPluginDoc('__global', 'conversation-ownership', '{"1":"human"}')

    // Uninstall purge (matching package-manager.remove call site): awaits SQL DELETE before resolving --
    // no flushPublic workaround; reopening store verifies persistence immediately.
    await host.asPackageManagerHost().purgePluginPersistentData('demo')

    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), undefined, 'target plugin global doc should be deleted')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'target plugin session doc should be deleted')
    assert.equal(
      handle.store.getPluginDoc('__global', 'demo:sub:records'),
      '{"n":9}',
      'colon-namespaced plugin (demo:sub) data must not be collaterally deleted by demo purge',
    )
    assert.equal(handle.store.getPluginDoc('__global', 'other:records'), '{"n":2}', 'other plugins remain untouched')
    assert.equal(
      handle.store.getPluginDoc('__global', 'conversation-ownership'),
      '{"1":"human"}',
      'kernel metadata key (without colon) remains untouched',
    )
    await handle.close()

    // Reopen store: deletion persisted, no resurrection.
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'must not resurrect after restart')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'must not resurrect after restart')
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:sub:records'), '{"n":9}')
    await reopened.close()
  } finally {
    await cleanupDir(base)
  }
})

/** Seeds final state of a managed install: managed directory + install record (matching completed install tx). */
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

test('PluginPackageManager.remove: removes directory and install record only after purge succeeds (no resurrection on reopen)', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helmx-purge-rm-')
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
    assert.ok(!existsSync(managed), 'managed directory must be deleted before remove returns')
    assert.equal(pkgStore.getRecord('demo'), undefined, 'install record must be deleted before remove returns')

    // Resolution of remove guarantees purge DELETE already hit SQLite: reopening verifies directly without flushing.
    await handle.close()
    const reopened = await openStore(base)
    assert.equal(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'global doc must already be deleted when remove resolves')
    assert.equal(reopened.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'session doc must already be deleted when remove resolves')
    await reopened.close()
  } finally {
    await cleanupDir(base)
  }
})

test('purge DELETE failure: remove rejects explicitly keeping directory/record intact and retries cleanly after recovery', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helmx-purge-fail-')
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

    // Inject global doc DELETE failure: remove must reject without continuing to delete directory/record.
    handle.failNextRun('DELETE FROM helmx_plugin_docs')
    await assert.rejects(
      manager.remove('demo'),
      (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
    )
    assert.ok(existsSync(managed), 'managed directory must remain intact on purge failure')
    assert.ok(pkgStore.getRecord('demo'), 'install record must remain intact on purge failure (for retry)')
    await handle.close()

    // Reopen after fault recovery (equivalent to process restart): failed DELETE did not soft-delete live data.
    const reopened = await openStore(base)
    assert.notEqual(reopened.store.getPluginDoc('__global', 'demo:records'), undefined, 'failed DELETE must not clear live data')
    // Retry remove in a fresh host chain: removeManagedPlugin idempotently tolerates already-unregistered instance.
    const retryHost = makeHost(reopened, join(base, 'plugins'))
    const retryPkgStore = new PluginPackageManagerStore(new ConfigService(base))
    await retryPkgStore.load()
    assert.ok(retryPkgStore.getRecord('demo'), 'install record survives cleanly on reopen')
    const retryManager = new PluginPackageManager({
      dataDir: base,
      cwd: base,
      store: retryPkgStore,
      host: retryHost.asPackageManagerHost(),
    })
    const removed = await retryManager.remove('demo')
    assert.equal(removed.pluginId, 'demo')
    assert.equal(removed.wasEnabled, false, 'instance was already unregistered during first failed attempt, so retry wasEnabled is false')
    assert.ok(!existsSync(managed), 'managed directory deleted after successful retry')
    assert.equal(retryPkgStore.getRecord('demo'), undefined, 'install record deleted after successful retry')
    await reopened.close()

    const verified = await openStore(base)
    assert.equal(verified.store.getPluginDoc('__global', 'demo:records'), undefined, 'retry persisted deletion in SQLite')
    assert.equal(verified.store.getPluginSessionDoc('demo', 'runs', 1), undefined, 'retry persisted deletion in SQLite')
    await verified.close()
  } finally {
    await cleanupDir(base)
  }
})

test('disable leaves durable data intact: doc/sessionDoc survive disable and read back after re-enable', { timeout: 60_000 }, async () => {
  const base = await makeTempDir('helmx-purge-disable-')
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
    // Disable clears only the registry handle without touching durable data.
    assert.equal(handle.store.getPluginDoc('__global', 'demo:records'), '{"n":1}', 'disable must not delete durable data')
    assert.equal(handle.store.getPluginSessionDoc('demo', 'runs', 1), '{"ids":["r1"]}', 'disable must not delete durable data')

    // Re-enable: registry rebuilds and reads back previous values.
    await host.enable('demo')
    const doc = host.getPublicDoc('demo', 'records')
    assert.deepEqual(doc.value, { n: 1 })
    await handle.close()
  } finally {
    await cleanupDir(base)
  }
})
