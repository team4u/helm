/**
 * plugin dependency contract and lifecycle test:
 * - dependency declaration boundary (shape/dedupe/self dependency) and summary through out (PluginSummary.dependencies);
 * - enable / register i.e. enable dependency satisfy validate (missing plugin_dependency_missing,
 *   not enabled plugin_dependency_not_enabled; only register not enabled dependency do not satisfy);
 * - dependency graph ring route explicit reject (plugin_dependency_cycle), not silently do not deadlock;
 * - global service start screen fault by dependency topology order prepare/start,stop by inverse topology order;
 *   same layer keep register order;
 * - dependency protect: non- force deactivate/deregister by plugin_in_use intercept (occupy items
 *   kind=plugin_dependency, contains pass dependency);force deactivate after dependency explicit mark record
 *   (status=failed + plugin.changed), do not static default error state;
 * - register/enable concurrency queue without deadlock (all promise converge).
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, assertRejectsCode, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

let dataDir: string
let docs: MemoryDocStore
let events: Array<{ type: string; payload: unknown }>

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    emitEvent: (type, payload) => {
      events.push({ type, payload })
    },
  }
}

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeBackend(),
    docs,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

function def(id: string, dependencies?: string[], define?: PluginDefinition['definePlugin']): PluginDefinition {
  return {
    id,
    ...(dependencies !== undefined && dependencies.length > 0 ? { dependencies } : {}),
    definePlugin: define ?? (() => {}),
  }
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-plugin-deps-')
  docs = new MemoryDocStore()
  events = []
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// declaration boundary and summary
// ---------------------------------------------------------------------------

test('dependency declaration: illegal shape reject; duplicate items dedupe; summary through out dependencies', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('bad', ['ok-id', 'bad@^1.0'])), 'invalid_plugin_definition', 400)
  await assertRejectsCode(() => host.register(def('bad2', ['x', 42 as unknown as string])), 'invalid_plugin_definition', 400)
  await assertRejectsCode(() => host.register(def('bad3', 'nope' as unknown as string[])), 'invalid_plugin_definition', 400)

  await host.register(def('dep-base'))
  await host.register(def('user', ['dep-base', 'dep-base']))
  const summary = host.get('user')
  assert.ok(summary)
  assert.deepEqual(summary.dependencies, ['dep-base'])

  const plain = host.get('dep-base')
  assert.ok(plain)
  assert.equal(plain.dependencies, undefined, 'without dependency declaration when summary does not carry empty array field')
})

test('self dependency and two plugin ring route: register boundary explicit plugin_dependency_cycle', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('self', ['self'])), 'plugin_dependency_cycle', 409)

  // first register b(dependency a,a not registered - - deactivate state register allows, enable when only then validate satisfy); again register a(dependency b) into ring.
  await host.register(def('b', ['a']), { enabled: false })
  const err = (await assertRejectsCode(() => host.register(def('a', ['b'])), 'plugin_dependency_cycle', 409)) as HelmError
  assert.deepEqual((err.details as { cycle: string[] }).cycle, ['a', 'b', 'a'])
  assert.equal(host.list().some((s) => s.id === 'a'), false, 'into ring plugin does not enter register table')
})

// ---------------------------------------------------------------------------
// enable satisfy
// ---------------------------------------------------------------------------

test('enable dependency validate: missing / only register not enabled / enable after succeeded', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('user', ['missing-dep']), { enabled: false })
  await host.register(def('user2', ['disabled-dep']), { enabled: false })
  await host.register(def('user3', ['enabled-dep']), { enabled: false })

  const missingErr = (await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)) as HelmError
  assert.equal((missingErr.details as { dependency: string }).dependency, 'missing-dep')

  await host.register(def('disabled-dep'), { enabled: false })
  const notEnabledErr = (await assertRejectsCode(() => host.enable('user2'), 'plugin_dependency_not_enabled', 409)) as HelmError
  assert.equal((notEnabledErr.details as { dependency: string }).dependency, 'disabled-dep')
  assert.equal(host.get('user2')?.enabled, false, 'enable failed keep deactivate')

  await host.register(def('enabled-dep'), { enabled: true })
  await host.enable('user3')
  assert.equal(host.get('user3')?.enabled, true)
  assert.equal(host.get('user3')?.status, 'active')
})

test('register i.e. enable same validate dependency; dependency enable after can restore', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('eager', ['not-there']), { enabled: true }), 'plugin_dependency_missing', 409)
  assert.equal(host.list().some((s) => s.id === 'eager'), false)

  const host2 = makeHost()
  await host2.register(def('late-dep'), { enabled: true })
  await host2.register(def('eager', ['late-dep']), { enabled: true })
  assert.equal(host2.get('eager')?.enabled, true)
  await host2.dispose()
})

// ---------------------------------------------------------------------------
// topology order start / stop
// ---------------------------------------------------------------------------

test('global screen fault by dependency topology order prepare/start,stop inverse topology order; same layer keep register order', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const svc = (label: string) => ({
    id: `svc-${label}`,
    async prepare() {
      order.push(`prepare:${label}`)
    },
    async start() {
      order.push(`start:${label}`)
    },
    async stop() {
      order.push(`stop:${label}`)
    },
  })
  const host = makeHost({ deferServices: true })
  // register order:first, mid, last(last -> mid -> first dependency chain)
  await host.register({
    id: 'first',
    definePlugin: (ctx) => {
      ctx.service(svc('first'))
    },
  })
  await host.register({
    id: 'mid',
    dependencies: ['first'],
    definePlugin: (ctx) => {
      ctx.service(svc('mid'))
    },
  })
  await host.register({
    id: 'independent-a',
    definePlugin: (ctx) => {
      ctx.service(svc('ia'))
    },
  })
  await host.register({
    id: 'independent-b',
    definePlugin: (ctx) => {
      ctx.service(svc('ib'))
    },
  })
  await host.register({
    id: 'last',
    dependencies: ['mid'],
    definePlugin: (ctx) => {
      ctx.service(svc('last'))
    },
  })
  await host.start()

  const prepareIdx = (label: string) => order.indexOf(`prepare:${label}`)
  const startIdx = (label: string) => order.indexOf(`start:${label}`)
  // screen fault semantics keep: all prepare first at all start.
  assert.ok(order.slice(0, 5).every((e) => e.startsWith('prepare:')))
  // dependency topology: by dependency first prepare / start.
  assert.ok(prepareIdx('first') < prepareIdx('mid') && prepareIdx('mid') < prepareIdx('last'))
  assert.ok(startIdx('first') < startIdx('mid') && startIdx('mid') < startIdx('last'))
  // same layer (without dependency closure system) keep register order.
  assert.ok(prepareIdx('ia') < prepareIdx('ib'))

  await host.stop()
  const stops = order.filter((e) => e.startsWith('stop:')).map((e) => e.slice(5))
  // topology order [first, ia, ib, mid, last] inverse order: dependency first stop.
  assert.deepEqual(stops, ['last', 'mid', 'ib', 'ia', 'first'])
  await host.dispose()
})

test('hot enable: dependency already runtime directly enable (service i.e. when prepare+start)', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const host = makeHost()
  await host.register({
    id: 'base',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('base-start') }, async stop() {} })
    },
  })
  await host.register({
    id: 'top',
    dependencies: ['base'],
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('top-start') }, async stop() {} })
    },
  })
  await host.enable('top')
  assert.deepEqual(order, ['base-start', 'top-start'])
  await host.dispose()
})

// ---------------------------------------------------------------------------
// dependency protect
// ---------------------------------------------------------------------------

test('non- force deactivate by dependency plugin:plugin_in_use intercept (contains pass dependency)', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('mid', ['base']), { enabled: true })
  await host.register(def('top', ['mid']), { enabled: true })

  const err = (await assertRejectsCode(() => host.disable('base'), 'plugin_in_use', 409)) as HelmError
  const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
  assert.deepEqual(
    usages.map((u) => u.id).sort(),
    ['mid', 'top'],
    'directly and pass dependency all enter occupy manifest',
  )
  assert.ok(usages.every((u) => u.kind === 'plugin_dependency'))
  assert.equal(host.get('base')?.enabled, true)
  await host.dispose()
})

test('force deactivate: succeeded and dependency explicit mark record (status=failed + plugin.changed), do not static default error state', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  events.length = 0
  await host.disable('base', { force: true })

  assert.equal(host.get('base')?.enabled, false)
  const user = host.get('user')
  assert.ok(user)
  assert.equal(user.enabled, true, 'force only effect at target plugin, do not automatically deactivate dependency')
  assert.equal(user.status, 'failed', 'dependency do not satisfy explicit visible')
  assert.equal(user.error?.code, 'plugin_dependency_not_enabled')
  assert.ok(
    events.some(
      (e) =>
        e.type === 'plugin.changed' &&
        (e.payload as { plugin?: { id: string } }).plugin?.id === 'user',
    ),
    'dependency state change by broadcast',
  )

  // restore path: deactivate dependency -> enable base -> re- enable user succeeded and error clear.
  await host.disable('user')
  await host.enable('base')
  await host.enable('user')
  const recovered = host.get('user')
  assert.ok(recovered)
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.error, undefined)

  // force deactivate after legacy fault state dependency same protect deregister: must first deactivate dependency.
  await host.disable('base', { force: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)
  await host.disable('user')
  await host.unregister('base')
  await host.dispose()
})

test('deregister by dependency plugin: dependency in enable state when reject; deactivate dependency after let through', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)

  await host.disable('user')
  await host.unregister('base')
  assert.equal(host.get('base'), undefined)
  // base remove after user dependency missing:enable explicit failed.
  await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// concurrency without deadlock
// ---------------------------------------------------------------------------

test('concurrency register/enable/deactivate mixed operation all converge (without deadlock)', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const ops: Array<Promise<unknown>> = []
  for (let i = 0; i < 6; i++) {
    ops.push(host.register(def(`p${i}`, [`p${(i + 1) % 6}`]), { enabled: false }))
  }
  // 6 plugin first tail each other connect into ring: one by one reject, never pending.
  const results = await Promise.allSettled(ops)
  const rejected = results.filter((r) => r.status === 'rejected').length
  assert.ok(rejected >= 1, 'ring route register by explicit reject')
  assert.equal(results.length, 6)

  const host2 = makeHost()
  await host2.register(def('a0'), { enabled: false })
  await host2.register(def('b0', ['a0']), { enabled: false })
  await host2.register(def('c0', ['b0']), { enabled: false })
  // concurrency enable chain + and deactivate hand over wrong: allows part failed (dependency not ready / in-use), but must all return.
  const settled = await Promise.allSettled([
    host2.enable('a0'),
    host2.enable('b0'),
    host2.enable('c0'),
    host2.disable('a0'),
  ])
  assert.equal(settled.length, 4)
  await host.dispose()
  await host2.dispose()
})
