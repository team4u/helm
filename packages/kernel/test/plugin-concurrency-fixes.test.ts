/**
 * plugin concurrency defect fix dedicated items regression (fix/concurrency-plugins).
 *
 * override (and fix one one for should):
 * 1. disable gate TOCTOU:collectPluginInUse async window inside enter in-flight task must by
 *    second gate 409 intercept (do not and teardown concurrency split register table);plugin_in_use reject after
 *    state keep enabled+idle can continue service.
 * 2. start screen fault read write gate: screen fault phase concurrency register(enable) service do not by leak start; concurrency
 *    disable does not resurrect (stop after at start);stop() etc. screen fault after completion again stop (do not empty run).
 * 3. HookPipeline iterate isolated:run iterate during concurrency add + trigger sort do not heavy arrange correct by iterate
 *    array (do not skip, does not repeat execute).
 * 4. nodeFetch wrap failed without leaking counter (body lock exception path).
 * 5. setConfig read-together-write serial: concurrency patch do not lose update.
 * 6. register commit point after placement:provider mount complete before list do not expose capability (manifest and
 *    can execute do not tear).
 * 7. package manage rollback honest:update restore reload failed no longer lie report rolledBack;
 *    install store.save failed and rollback deregister 409 when never rm instance directory;
 *    install register failed encounter concurrency same name registered instance when keep directory.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
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
// base create
// ---------------------------------------------------------------------------

function makeHost(overrides: { deferServices?: boolean; backend?: PluginHostBackend; providers?: PluginProviderPort } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-conc-fix-'))
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: {
      ...createPluginHostBackendFixture(),
      // plugin lifecycle event collect (fixture bottom seat for emitEvent explicit unsupported)
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
// 1. disable gate TOCTOU
// ---------------------------------------------------------------------------

test('disable gate TOCTOU:inUse collect window inside enter in-flight task by second gate 409 intercept', { timeout: 60_000 }, async () => {
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
          // inUse async suspended once (fabricate collectPluginInUse  await window);
          // release after after continue invoke immediately return empty, avoid test tail part again deactivate by gate hang die
          inUse: () => {
            if (!inUsePending) return []
            return new Promise<void>((resolve) => {
              releaseInUse = () => { inUsePending = false; resolve() }
            }).then(() => [])
          },
        })
        ctx.action({
          id: 'hang',
          description: 'suspended action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: () => actionGate.promise.then(() => ({ ok: true })),
        })
      },
    }, { enabled: true })

    // first start disable(suspended in inUse collect), again in window inside put a in-flight action
    const disabling = host.disable('p:toctou')
    // let disable first push enter to inUse await: micro task arrange empty
    await new Promise<void>((resolve) => setImmediate(resolve))
    // window inside enter action:tracker counter in proposal (handler suspended do not return)
    const invoking = host.invokeAction('p:toctou', 'hang', {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(host.activeTaskCount('p:toctou') >= 1, true, 'window inside action should count in-flight task')

    // release inUse(return empty occupy): second gate must grab window inside enter action → 409
    releaseInUse()
    await assertRejectsCode(() => disabling, 'plugin_has_live_tasks', 409)
    // state not by break: still enable and idle,action normal converge
    const summary = host.get('p:toctou')
    assert.equal(summary?.enabled, true)
    actionGate.resolve()
    await invoking
    // converge after deactivate succeeded
    await host.disable('p:toctou')
    assert.equal(host.get('p:toctou')?.enabled, false)
  } finally {
    await close()
  }
})

test('disable gate plugin_in_use reject after state keep enabled+idle, after continue invoke do not subject to affect', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    await host.register({
      id: 'p:inuse',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          inUse: () => [{ kind: 'job', id: 'j1', label: 'occupy in' }],
        })
        ctx.action({
          id: 'ping',
          description: 'probe needle',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    await assertRejectsCode(() => host.disable('p:inuse'), 'plugin_in_use', 409)
    assert.equal(host.get('p:inuse')?.enabled, true)
    // gate reject is not terminal state: plugin continue available
    const out = await host.invokeAction('p:inuse', 'ping', {})
    assert.deepEqual(out, { pong: true })
    await host.disable('p:inuse', { force: true })
    assert.equal(host.get('p:inuse')?.enabled, false)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 2. start screen fault read write gate
// ---------------------------------------------------------------------------

test('screen fault phase concurrency register(enabled): service do not by leak start (read gate wait for screen fault complete)', { timeout: 60_000 }, async () => {
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
    // screen fault in progress (A  prepare suspended): concurrency register and enable B
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
    // B service must already start (old defect:activateServices see servicesStarted=false skip
    // and B do not in screen fault snapshot → forever do not start)
    assert.deepEqual(events, ['a-start', 'b-start'])
    assert.equal(host.get('p:b')?.enabled, true)
  } finally {
    await close()
  }
})

test('screen fault phase concurrency disable: does not resurrect (stop after at screen fault start execute)', { timeout: 60_000 }, async () => {
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
    // old defect:disable in screen fault prepare phase first complete (svc.started=false skip stop),
    // screen fault then start already stop plugin service → events only ['start'] and re-
    assert.deepEqual(events, ['start', 'stop'])
    assert.equal(host.get('p:revive')?.enabled, false)
  } finally {
    await close()
  }
})

test('screen fault phase stop(): wait for screen fault after completion again stop (do not empty run return)', { timeout: 60_000 }, async () => {
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
    // stop not yet return (wait for screen fault); release screen fault after stop truly stop
    prepareGate.resolve()
    await starting
    await stopping
    // old defect:stop see servicesStarted=false directly return, screen fault then pull start service
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 3. HookPipeline iterate isolated (iterate in original ground sort)
// ---------------------------------------------------------------------------

test('HookPipeline:run iterate during concurrency add+sort do not heavy arrange correct by iterate array (do not skip does not repeat)', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline('input')
  const calls: string[] = []
  const payload = {
    conversationId: 1,
    input: { id: 'i1', text: 'x', origin: 'human' as const, createdAt: 1 },
  }

  pipeline.add('p:a', async () => {
    calls.push('a')
    // iterate in concurrency register high priority hook and trigger sort path (another route runHook  entries())
    pipeline.add('p:c', () => { calls.push('c') }, 10)
    pipeline.entries()
    return { action: 'continue' as const }
  })
  pipeline.add('p:b', () => {
    calls.push('b')
    return { action: 'continue' as const }
  })

  await pipeline.run(payload)
  // old defect:entries() return array, original ground sort make this round a repeat execution / order wrong chaotic
  assert.deepEqual(calls, ['a', 'b'])

  // under one round: high priority c first execute
  await pipeline.run(payload)
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'b'])
})

// ---------------------------------------------------------------------------
// 4. nodeFetch wrap failed without leaking counter
// ---------------------------------------------------------------------------

test('nodeFetch: response body wrap failed (already lock stream) end counter do not pending leak leak', { timeout: 60_000 }, async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)) },
  })
  const raw = (async () => {
    const response = new Response(source, { status: 200 })
    // pre- lock response.body: wrap layer getReader() must throw (determinism trigger wrap failed path)
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
    // old defect: wrap exception path do not end counter → deactivate forever long 409 pending
    await host.disable('p:fetch-wrap-fail')
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 5. setConfig read-together-write serial
// ---------------------------------------------------------------------------

test('setConfig: concurrency patch serial read together write, after write does not override before write', { timeout: 60_000 }, async () => {
  const captured: Record<string, unknown> = {}
  const firstWriteGate = deferred<void>()
  let backendCalls = 0
  const backend: PluginHostBackend = {
    ...createPluginHostBackendFixture(),
    emitEvent: () => {},
    setPluginConfig: async (_id, value) => {
      backendCalls += 1
      // first time write suspended: fabricate read-together-write hand over stack window (old defect under two time concurrency read together write hand over stack)
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
    // old defect:w2 read to w1 before snapshot {}, whole value write override lose a
    assert.deepEqual(captured, { a: 1, b: 2 })
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 6. register commit point after placement (manifest and can execute do not tear)
// ---------------------------------------------------------------------------

test('register:provider mount complete before list do not expose capability (enabled and idle sync commit)', { timeout: 60_000 }, async () => {
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
          description: 'probe needle',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // mount not complete: manifest must not expose (old defect:enabled first placement → manifest has while execute 409)
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
// 7. package manage rollback honest
// ---------------------------------------------------------------------------

const PLUGIN_SRC = (id: string, version: string) => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe needle',
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

/**
 * most small package manage environment: real local copy + doctor + directory transaction;host port and store
 * inject fault (on demand override). failed inject by caller in after creation directly change write hostStub method.
 */
/** real store(config.json persist)+ can inject save failed switch. */
class FaultInjectingStore extends PluginPackageManagerStore {
  failNextSave = false
  override async save(
    record: Omit<PluginPackageRecord, 'id'> & { id?: string },
  ): Promise<PluginPackageRecord> {
    if (this.failNextSave) throw new Error('simulated disk write failed')
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
      if (!registered.has(pluginId)) throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId })
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

test('update rollback honest: restore reload failed no longer lie report already rollback old version continue available', { timeout: 60_000 }, async () => {
  let updateCalls = 0
  const env = makePkgEnv((hostStub) => {
    hostStub.updateManagedPlugin = async (pluginId: string) => {
      updateCalls += 1
      // two time reload all failed: first time switch failed + restore reload also failed (instance deregistered)
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
    assert.equal(details.rolledBack, false, 'restore reload failed must such as rolledBack:false')
    assert.match(err.message, /old directory already restore, but old instance reload failed/, 'error information must note directory already restore but instance not restore')
    assert.equal(updateCalls, 2, 'rollback path must real attempt restore reload')
    // directory indeed already restore to old version (rename chain complete)
    const manifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'honest-rollback', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '1.0.0')
  } finally {
    env.close()
  }
})

test('update rollback succeeded path: restore reload on success still such as rolledBack:true', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    const original = hostStub.updateManagedPlugin
    let calls = 0
    hostStub.updateManagedPlugin = async (pluginId: string, dir: string, options: { keepEnabled: boolean }) => {
      calls += 1
      if (calls === 1) throw new HelmError('plugin_reload_failed_simulated', 'first time reload failed', 500, { pluginId })
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

test('install record persist failed and rollback deregister failed: directory and instance keep,rolledBack:false(all chain)', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.removeManagedPlugin = async () => {
      // simulated in-flight task leads to deregister by 409 reject: instance still register run
      throw new HelmError('plugin_has_live_tasks', 'simulated in-flight task reject unload', 409, { pluginId: 'keep-dir' })
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'keep-dir', '1.0.0')
    env.store.failNextSave = true
    const err = (await assertRejectsCode(() => env.manager.install(userSrc, { enable: true }), 'plugin_package_install_failed', 500)) as HelmError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'rollback deregister failed must such as rolledBack:false')
    assert.match(err.message, /directory and instance already keep/, 'error information must note keep now state await human handle')
    const target = join(env.dataDir, 'plugins', 'keep-dir')
    assert.ok(existsSync(join(target, 'index.mjs')), 'must not rm still register instance source directory (old defect: directory by hollow out)')
    assert.ok(env.manager !== undefined)
    assert.ok(!env.store.getRecord('keep-dir'), 'install record not persisted')
  } finally {
    env.close()
  }
})

test('install register failed encounter concurrency same name registered instance: directory keep to the instance,rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    let registerAttempted = false
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      // simulated concurrency rescan already from same directory grab first register:register  409. this after listSummaries
      // report the instance (when order on and real race consistent:register attempt before manifest in no it)
      registerAttempted = true
      throw new HelmError('plugin_already_registered', `plugin registered:${manifest.id}`, 409, { pluginId: manifest.id })
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
    assert.ok(existsSync(join(target, 'index.mjs')), 'directory must keep to concurrency register instance (old defect:rm hollow out source directory)')
  } finally {
    env.close()
  }
})

test('install register failed and without same name instance: still delete directory rollback (since has semantics does not fall back)', { timeout: 60_000 }, async () => {
  const env = makePkgEnv((hostStub) => {
    hostStub.registerManagedPlugin = async (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
      throw new HelmError('plugin_register_failed_simulated', `simulated register failed:${manifest.id}`, 500)
    }
  })
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'plain-fail', '1.0.0')
    const err = (await assertRejectsCode(() => env.manager.install(userSrc), 'plugin_package_install_failed', 500)) as HelmError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'plain-fail')), 'without concurrency instance when by original semantics delete directory rollback')
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// 10. start() single fly failed leaves no residue (identity-guarded clean cache: failed after can retry)
// ---------------------------------------------------------------------------

test('start() single fly failed leaves no residue stale reject: failed clean cache after retry can succeeded', { timeout: 60_000 }, async () => {
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
              throw new Error('first time failed to start')
            }
            events.push('start')
          },
          stop: () => { events.push('stop') },
        })
      },
    }, { enabled: true })

    await assert.rejects(host.start(), /first time failed to start/)
    // failed after retry: must not receives cache stale reject (identity-guarded clean cache allows retry)
    await host.start()
    assert.deepEqual(events, ['start'])
    await host.stop()
    assert.deepEqual(events, ['start', 'stop'])
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------
// 11. split destroy phase plugin from manifest i.e. when disappear (getActiveEnabledPluginIds tight is enabled+idle)
// ---------------------------------------------------------------------------

test('split destroy phase plugin from action manifest i.e. when disappear:teardown window inside enabled still true also no longer expose', { timeout: 60_000 }, async () => {
  const { host, close } = makeHost()
  try {
    const stopGate = deferred<void>()
    await host.register({
      id: 'p:tearing-down',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          // stop suspended: fabricate teardown split destroy window (enabled still true,phase=deactivating)
          stop: () => stopGate.promise,
        })
        ctx.action({
          id: 'ping',
          description: 'probe needle',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        })
      },
    }, { enabled: true })

    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:tearing-down').length, 1)
    const disabling = host.disable('p:tearing-down', { force: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    // split destroy window:enabled not yet false(disable still in stop in), but manifest must already disappear,
    // no longer to already stop service dispatch new request
    assert.equal(host.get('p:tearing-down')?.enabled, true, 'window inside enabled still true(split destroy phase semantics)')
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:tearing-down'), [], 'split destroy phase manifest must i.e. when disappear')
    stopGate.resolve()
    await disabling
    assert.equal(host.get('p:tearing-down')?.enabled, false)
  } finally {
    await close()
  }
})
