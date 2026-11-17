/**
 * Regression suite for plugin concurrency fixes (fix/concurrency-plugins).
 *
 * Covers each fix 1-to-1:
 * 1. Disable gate TOCTOU: in-flight tasks entering during collectPluginInUse async gap are caught by
 *    a second gate returning 409 (never concurrently tearing down registry); plugin_in_use leaves
 *    state enabled+idle and ready to keep serving;
 * 2. Startup barrier RW gate: concurrent register(enable) during barrier starts its service cleanly;
 *    concurrent disable never resurrects (stop runs after barrier start); stop() waits for barrier;
 * 3. HookPipeline iteration isolation: concurrent add + sort during run() never re-sorts active
 *    iteration array (no skipped or repeated hooks);
 * 4. nodeFetch wrapper failure never leaks live-task count (locked body exception path);
 * 5. setConfig read-modify-write serialization: concurrent patches never drop updates;
 * 6. Register commit point happens after provider mount: capabilities never appear in listings
 *    before mounting finishes (manifest and executability stay in sync);
 * 7. Honest package manager rollback: failed restore reload during update never falsely reports
 *    rolledBack; failed store.save + 409 deregister on install never deletes instance directory;
 *    install registration collision with concurrent instance preserves directory.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type HelmHostApi, type PluginDefinition, type PluginPackageRecord } from '@helm/protocol'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { HookPipeline } from '../src/plugins/hooks.js'
import { PluginPackageManager, type PackageManagerHost } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import type { PluginConfigStore, PluginHostBackend, PluginProviderPort } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import type { Provider } from '@earendil-works/pi-ai'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, assertRejectsCode, deferred } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

function makeHost(overrides: { deferServices?: boolean; backend?: PluginHostBackend; providers?: PluginProviderPort } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-conc-fix-'))
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: {
      ...createPluginHostBackendFixture(),
      // Lifecycle event stub (fixture base leaves emitEvent unsupported)
      emitEvent: () => {},
      ...(overrides.backend ? overrides.backend : {}),
    },
    docs: new MemoryDocStore(),
    ...(overrides.deferServices === true ? { deferServices: true } : {}),
    ...(overrides.providers !== undefined ? { providers: overrides.providers } : {}),
  })
  return {
    host,
    dataDir,
    async close() {
      try {
        await host.dispose()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Disable gate TOCTOU
// ---------------------------------------------------------------------------

test('disable gate TOCTOU: task entering during inUse collection window is caught 409 by second gate', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    let releaseInUse!: () => void
    let inUsePending = true
    const actionGate = deferred<void>()
    await host.register({
      id: 'p:toctou',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          // Pause inUse once (fabricates await window in collectPluginInUse); return empty afterward so
          // final test teardown disable does not block forever.
          inUse: () => {
            if (!inUsePending) return []
            return new Promise<void>((resolve) => {
              releaseInUse = () => { inUsePending = false; resolve() }
            }).then(() => [])
          },
        })
        ctx.action({
          id: 'hang',
          description: 'hanging action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: () => actionGate.promise.then(() => ({ ok: true })),
        })
      },
    }, { enabled: true })

    // Start disable first (pauses inside inUse), then start an in-flight action inside that window
    const disabling = host.disable('p:toctou')
    // Let disable advance to the inUse await via microtasks
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Start action inside window: tracker records count immediately (handler blocks pending)
    const invoking = host.invokeAction('p:toctou', 'hang', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(host.activeTaskCount('p:toctou') >= 1, true, 'action started in window must count as live task')

    // Release inUse returning empty: second gate must catch the action entered during window -> 409
    releaseInUse()
    await assertRejectsCode(() => disabling, 'plugin_has_live_tasks', 409)
    // State remains uncorrupted: still enabled and idle, action settles normally
    const summary = host.get('p:toctou')
    assert.equal(summary?.enabled, true)
    actionGate.resolve()
    await invoking
    // Succeeds once action settles
    await host.disable('p:toctou')
    assert.equal(host.get('p:toctou')?.enabled, false)
  } finally {
    await close()
  }
})

test('disable gate plugin_in_use rejection leaves state enabled+idle so subsequent calls work', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    await host.register({
      id: 'p:inuse',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          inUse: () => [{ kind: 'job', id: 'j1', label: 'busy' }],
        })
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    await assertRejectsCode(() => host.disable('p:inuse'), 'plugin_in_use', 409)
    assert.equal(host.get('p:inuse')?.enabled, true)
    // Gate rejection is not terminal: plugin keeps serving
    const out = await host.invokeAction('p:inuse', 'ping', {})
    assert.deepEqual(out, { pong: true })
    await host.disable('p:inuse', { force: true })
    assert.equal(host.get('p:inuse')?.enabled, false)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 2. Startup barrier RW gate
// ---------------------------------------------------------------------------

test('concurrent register(enabled) during barrier starts its service without being skipped (gate waits for barrier)', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:a',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-a',
          prepare: () => prepareGate.promise,
          start: () => { events.push('a-start') },
          stop: () => { events.push('a-stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Barrier in flight (A's prepare paused): concurrently register and enable B
    const registeringB = host.register({
      id: 'p:b',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc-b',
          start: () => { events.push('b-start') },
          stop: () => { events.push('b-stop') },
        })
      },
    }, { enabled: true })

    prepareGate.resolve()
    await starting
    await registeringB
    // B's service must start (old bug: activateServices saw servicesStarted=false and skipped, while B wasn't in barrier snapshot)
    assert.deepEqual(events, ['a-start', 'b-start'])
    assert.equal(host.get('p:b')?.enabled, true)
  } finally {
    await close()
  }
})

test('concurrent disable during barrier never resurrects service (stop runs after barrier start)', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:revive',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { events.push('start') },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const disabling = host.disable('p:revive')
    prepareGate.resolve()
    await starting
    await disabling
    // Old bug: disable completed first during prepare (svc.started=false skipped stop), then barrier started the disabled plugin -> ['start'] only
    assert.deepEqual(events, ['start', 'stop'])
    assert.equal(host.get('p:revive')?.enabled, false)
  } finally {
    await close()
  }
})

test('stop() during barrier waits for barrier completion before stopping instead of returning early', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    const prepareGate = deferred<void>()
    await host.register({
      id: 'p:stopwait',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          prepare: () => prepareGate.promise,
          start: () => { events.push('start') },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    const starting = host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const stopping = host.stop()
    // stop waits for barrier before actually stopping
    prepareGate.resolve()
    await starting
    await stopping
    // Old bug: stop saw servicesStarted=false and returned immediately while barrier kept starting services
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 3. HookPipeline iteration isolation (no in-place re-sort during iteration)
// ---------------------------------------------------------------------------

test('HookPipeline: concurrent add+sort during run() never re-orders active iteration array (no skip/duplicate)', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline('input')
  const calls: string[] = []
  const payload = {
    conversationId: 1,
    input: { id: 'i1', text: 'x', origin: 'human' as const, createdAt: 1 },
  }

  pipeline.add('p:a', async () => {
    calls.push('a')
    // Register a higher-priority hook mid-iteration and trigger sort path (simulates another runHook calling entries())
    pipeline.add('p:c', () => { calls.push('c') }, 10)
    pipeline.entries()
    return { action: 'continue' as const }
  })
  pipeline.add('p:b', () => {
    calls.push('b')
    return { action: 'continue' as const }
  })

  await pipeline.run(payload)
  // Old bug: entries() returned shared array; sorting in place duplicated/scrambled current round
  assert.deepEqual(calls, ['a', 'b'])

  // Next round: high-priority hook c runs first
  await pipeline.run(payload)
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'b'])
})

// ---------------------------------------------------------------------------
// 4. nodeFetch wrapper failure never leaks live-task count
// ---------------------------------------------------------------------------

test('nodeFetch: response body wrapping failure (pre-locked stream) finishes counter without leaking', { timeout: 60_000 }, async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)) },
  })
  const raw = (async () => {
    const response = new Response(source, { status: 200 })
    // Pre-lock response.body so wrapper's getReader() throws deterministically
    void response.body!.getReader()
    return response
  }) as typeof fetch
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    nodeFetch: () => raw,
  }
  const { host, close } = makeHost({ backend })
  let api!: HelmHostApi
  await host.register({
    id: 'p:fetch-wrap-fail',
    definePlugin: (ctx) => { api = ctx.host },
  }, { enabled: true })
  try {
    await assert.rejects(api.nodeFetch('remote-1')('http://example.test'))
    // Old bug: exception skipped decrement -> disable stuck returning 409 forever
    await host.disable('p:fetch-wrap-fail')
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 5. setConfig read-modify-write serialization
// ---------------------------------------------------------------------------

test('setConfig: concurrent patches serialize read-modify-write without later writes clobbering earlier ones', { timeout: 60_000 }, async () => {
  const captured: Record<string, unknown> = {}
  const firstWriteGate = deferred<void>()
  let backendCalls = 0
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    setPluginConfig: async (_id, value) => {
      backendCalls += 1
      // Pause first write to fabricate the read-modify-write race window
      if (backendCalls === 1) await firstWriteGate.promise
      Object.assign(captured, value)
    },
  }
  const { host, close } = makeHost({ backend })
  let api!: HelmHostApi
  await host.register({
    id: 'p:cfg',
    definePlugin: (ctx) => { api = ctx.host },
  }, { enabled: true })
  try {
    const w1 = api.setConfig({ a: 1 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const w2 = api.setConfig({ b: 2 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    firstWriteGate.resolve()
    await Promise.all([w1, w2])
    // Old bug: w2 read snapshot {} before w1 settled and dropped key `a` on writeback
    assert.deepEqual(captured, { a: 1, b: 2 })
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 6. Register commit happens after provider mount (listing stays in sync with executability)
// ---------------------------------------------------------------------------

test('register: capabilities stay hidden from listings until provider mount finishes (enabled+idle atomic commit)', { timeout: 60_000 }, async () => {
  const mountGate = deferred<void>()
  const port: PluginProviderPort = {
    register: async () => {
      await mountGate.promise
      return async () => {}
    },
  }
  const { host, close } = makeHost({ providers: port })
  try {
    const registering = host.register({
      id: 'p:late-mount',
      definePlugin: (ctx) => {
        ctx.provider({
          id: 'late-provider',
          name: 'Late Provider',
          auth: { apiKey: { name: 'k', resolve: async () => undefined } },
          getModels: () => [],
          stream: () => { throw new Error('do not execute') },
          streamSimple: () => { throw new Error('do not execute') },
        } as unknown as Provider)
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Before mount finishes: capabilities must not be exposed yet (old bug: enabled early -> listed while execution failed 409)
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:late-mount'), [])
    assert.equal(host.get('p:late-mount')?.enabled, false)
    mountGate.resolve()
    await registering
    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:late-mount').length, 1)
    const out = await host.invokeAction('p:late-mount', 'ping', {})
    assert.deepEqual(out, { pong: true })
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 7. Honest package manager rollback
// ---------------------------------------------------------------------------

const PLUGIN_SRC = (id: string, version: string) => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe action',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

function writeLocalPlugin(parent: string, id: string, version: string): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

interface MiniPkgEnv {
  dataDir: string
  cwd: string
  manager: PluginPackageManager
  close(): void
}

/** Minimal package manager store backed by real config.json with toggleable save failure injection. */
class FaultInjectingStore extends PluginPackageManagerStore {
  failNextSave = false
  override async save(
    record: Omit<PluginPackageRecord, 'id'> & { id?: string },
  ): Promise<PluginPackageRecord> {
    if (this.failNextSave) throw new Error('simulated disk write failure')
    return super.save(record)
  }
}

function makePkgEnv(
  setup: (host: PackageManagerHost & { registered: Map<string, boolean> }) => void,
): MiniPkgEnv & { store: FaultInjectingStore } {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-conc-'))
  const cwd = mkdtempSync(join(tmpdir(), 'helm-pkg-cwd-'))
  const store = new FaultInjectingStore(new ConfigService(dataDir))
  const registered = new Map<string, boolean>()
  const summaries = new Map<string, { id: string; enabled: boolean }>()
  const hostStub = {
    registered,
    async registerManagedPlugin(dir: string) {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      registered.set(manifest.id, false)
      summaries.set(manifest.id, { id: manifest.id, enabled: false })
      return { summary: summaryOf(summaries, manifest.id), pluginId: manifest.id }
    },
    async enableManagedPlugin(pluginId: string) {
      registered.set(pluginId, true)
      summaries.set(pluginId, { id: pluginId, enabled: true })
      return { summary: summaryOf(summaries, pluginId) }
    },
    assertManagedPluginUpdateSafe() {},
    async updateManagedPlugin(pluginId: string) {
      if (!registered.has(pluginId)) throw new HelmError('unknown_plugin', `unregistered plugin: ${pluginId}`, 404, { pluginId })
      return { summary: summaryOf(summaries, pluginId) }
    },
    async removeManagedPlugin(pluginId: string) {
      if (!registered.has(pluginId)) return { wasEnabled: false }
      const wasEnabled = registered.get(pluginId) === true
      registered.delete(pluginId)
      summaries.delete(pluginId)
      return { wasEnabled }
    },
    listSummaries: () => [...summaries.keys()].map((id) => summaryOf(summaries, id)),
  }
  const host = hostStub as unknown as PackageManagerHost & { registered: Map<string, boolean> }
  setup(host)
  const manager = new PluginPackageManager({ dataDir, cwd, store, host })
  return {
    dataDir,
    cwd,
    store,
    manager,
    close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function summaryOf(summaries: Map<string, { id: string; enabled: boolean }>, id: string) {
  const s = summaries.get(id) ?? { id, enabled: false }
  return {
    id: s.id,
    name: s.id,
    locked: false,
    enabled: s.enabled,
    hooks: [] as never[],
    actions: s.enabled ? ['ping'] : [],
    tools: [] as string[],
  }
}

test('honest update rollback: failed restore reload no longer falsely reports old version active', { timeout: 60_000 }, async () => {
  let updateCalls = 0
  const env = makePkgEnv((hostStub) => {
    hostStub.updateManagedPlugin = async (pluginId: string) => {
      updateCalls += 1
      // Both reloads fail: new version switch fails + restore reload fails (instance left unregistered)
      throw new HelmError('plugin_reload_failed_simulated', `simulated reload failed #${updateCalls}`, 500, { pluginId })
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'honest-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'honest-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('honest-rollback', '2.0.0'))

    const err = (await assertRejectsCode(() => env.manager.update('honest-rollback'), 'plugin_package_update_failed', 500)) as HelmError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed restore reload must report rolledBack:false')
    assert.match(err.message, /old directory already restore, but old instance reload failed/, 'error message must clarify directory restored while instance did not')
    assert.equal(updateCalls, 2, 'rollback path must genuinely attempt restore reload')
    // Directory on disk was actually restored to the prior version
    const manifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'honest-rollback', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '1.0.0')
  } finally {
    env.close()
  }
})

test('successful update rollback path: restore reload success still reports rolledBack:true', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    const original = hostStub.updateManagedPlugin
    let calls = 0
    hostStub.updateManagedPlugin = async (pluginId: string, dir: string, options: { keepEnabled: boolean }) => {
      calls += 1
      if (calls === 1) throw new HelmError('plugin_reload_failed_simulated', 'first reload failed', 500, { pluginId })
      return original(pluginId, dir, options)
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'ok-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'ok-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('ok-rollback', '2.0.0'))
    const err = (await assertRejectsCode(() => env.manager.update('ok-rollback'), 'plugin_package_update_failed', 500)) as HelmError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.match(err.message, /already rollback to update before directory and instance/)
  } finally {
    env.close()
  }
})

test('install record save fails and rollback deregister fails: keeps directory and instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.removeManagedPlugin = async () => {
      // Simulate live task blocking unregister with 409: instance stays registered and running
      throw new HelmError('plugin_has_live_tasks', 'simulated live task blocks removal', 409, { pluginId: 'keep-dir' })
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'keep-dir', '1.0.0')
    env.store.failNextSave = true
    const err = (await assertRejectsCode(() => env.manager.install(userSrc, { enable: true }), 'plugin_package_install_failed', 500)) as HelmError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed rollback deregister must report rolledBack:false')
    assert.match(err.message, /directory and instance already keep/, 'error message must warn that state remains preserved for manual handling')
    const target = join(env.dataDir, 'plugins', 'keep-dir')
    assert.ok(existsSync(join(target, 'index.mjs')), 'must not rm directory backing a live registered instance (old bug wiped directory)')
    assert.ok(env.manager !== undefined)
    assert.ok(!env.store.getRecord('keep-dir'), 'install record not persisted')
  } finally {
    env.close()
  }
})

test('install register fails due to concurrent same-name instance: preserves directory for that instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    let registerAttempted = false
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      // Simulate concurrent rescan winning registration from the same directory (409), after which listSummaries sees it
      registerAttempted = true
      throw new HelmError('plugin_already_registered', `plugin already registered: ${manifest.id}`, 409, { pluginId: manifest.id })
    }
    const original = hostStub.listSummaries.bind(hostStub)
    hostStub.listSummaries = () => {
      const base = original()
      return registerAttempted && !base.some((s) => s.id === 'raced-plugin')
        ? [...base, summaryOf(new Map([['raced-plugin', { id: 'raced-plugin', enabled: true }]]), 'raced-plugin')]
        : base
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'raced-plugin', '1.0.0')
    const err = (await assertRejectsCode(() => env.manager.install(userSrc), 'plugin_package_install_failed', 500)) as HelmError
    const details = err.details as { rolledBack?: boolean }
    assert.equal(details.rolledBack, false)
    assert.match(err.message, /same name plugin registered/)
    const target = join(env.dataDir, 'plugins', 'raced-plugin')
    assert.ok(existsSync(join(target, 'index.mjs')), 'directory must remain intact for concurrently registered instance (old bug wiped source dir)')
  } finally {
    env.close()
  }
})

test('install register fails without same-name instance: still deletes directory on rollback (existing behavior preserved)', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      throw new HelmError('plugin_register_failed_simulated', `simulated register failure: ${manifest.id}`, 500)
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'plain-fail', '1.0.0')
    const err = (await assertRejectsCode(() => env.manager.install(userSrc), 'plugin_package_install_failed', 500)) as HelmError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'plain-fail')), 'deletes directory on rollback when no concurrent instance exists')
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// 10. start() single-flight failure leaves no stale cached rejection (retries cleanly)
// ---------------------------------------------------------------------------

test('start() single-flight failure clears cached rejection so retries succeed', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost({ deferServices: true })
  try {
    const events: string[] = []
    let failNextStart = true
    await host.register({
      id: 'p:barrier-retry',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start: () => {
            if (failNextStart) {
              failNextStart = false
              throw new Error('first startup failed')
            }
            events.push('start')
          },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    await assert.rejects(host.start(), /first startup failed/)
    // Retry after failure must not return cached stale rejection (identity-guarded cleanup permits retry)
    await host.start()
    assert.deepEqual(events, ['start'])
    await host.stop()
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 11. Teardown phase hides plugin from active listings immediately (enabled+idle only)
// ---------------------------------------------------------------------------

test('teardown phase hides plugin from action listings immediately even while enabled remains true', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    const stopGate = deferred<void>()
    await host.register({
      id: 'p:tearing-down',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          // Pause stop to hold open the teardown window (enabled still true, phase=deactivating)
          stop: () => stopGate.promise,
        })
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:tearing-down').length, 1)
    const disabling = host.disable('p:tearing-down', { force: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Inside teardown window: enabled stays true while stop finishes, yet listings clear immediately so stopping services receive no new calls
    assert.equal(host.get('p:tearing-down')?.enabled, true, 'enabled stays true during teardown window')
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:tearing-down'), [], 'listings clear immediately on teardown entry')
    stopGate.resolve()
    await disabling
    assert.equal(host.get('p:tearing-down')?.enabled, false)
  } finally {
    await close()
  }
})
