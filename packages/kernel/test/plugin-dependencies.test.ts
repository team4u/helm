/**
 * Plugin dependency contract and lifecycle tests:
 * - dependency declaration boundary (shape/dedupe/self-dependency) and summary projection (PluginSummary.dependencies);
 * - dependency satisfaction check on enable / eager-enabled register (missing -> plugin_dependency_missing,
 *   disabled -> plugin_dependency_not_enabled; registered-but-disabled dependency never satisfies);
 * - explicit cycle rejection in dependency graph (plugin_dependency_cycle) instead of hanging;
 * - global service startup barrier runs prepare/start in topological dependency order and stop in reverse
 *   topological order, preserving registration order within each layer;
 * - dependency protection: non-forced disable/unregister is blocked by plugin_in_use (including transitive
 *   dependents); forced disable explicitly flags dependents (status=failed + plugin.changed) rather than
 *   silently leaving corrupted state;
 * - concurrent register/enable operations serialize without deadlocks (all promises settle).
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, assertRejectsCode, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// Test fixture setup
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
  dataDir = await makeTempDir('helmx-plugin-deps-')
  docs = new MemoryDocStore()
  events = []
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// Declaration boundary and summary projection
// ---------------------------------------------------------------------------

test('dependency declaration: rejects invalid shapes, deduplicates entries, and exposes dependencies in summary', { timeout: 60_000 }, async () => {
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
  assert.equal(plain.dependencies, undefined, 'summary omits empty array when no dependencies are declared')
})

test('self-dependency and two-plugin cycle reject explicitly at registration with plugin_dependency_cycle', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('self', ['self'])), 'plugin_dependency_cycle', 409)

  // Register b first (depends on unregistered a -- allowed while disabled; checked on enable), then register a -> b creating cycle.
  await host.register(def('b', ['a']), { enabled: false })
  const err = (await assertRejectsCode(() => host.register(def('a', ['b'])), 'plugin_dependency_cycle', 409)) as HelmxError
  assert.deepEqual((err.details as { cycle: string[] }).cycle, ['a', 'b', 'a'])
  assert.equal(host.list().some((s) => s.id === 'a'), false, 'cyclic plugin never enters registry')
})

// ---------------------------------------------------------------------------
// Enable dependency checks
// ---------------------------------------------------------------------------

test('enable dependency validation: missing / registered-only disabled / succeeds once dependency enabled', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('user', ['missing-dep']), { enabled: false })
  await host.register(def('user2', ['disabled-dep']), { enabled: false })
  await host.register(def('user3', ['enabled-dep']), { enabled: false })

  const missingErr = (await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)) as HelmxError
  assert.equal((missingErr.details as { dependency: string }).dependency, 'missing-dep')

  await host.register(def('disabled-dep'), { enabled: false })
  const notEnabledErr = (await assertRejectsCode(() => host.enable('user2'), 'plugin_dependency_not_enabled', 409)) as HelmxError
  assert.equal((notEnabledErr.details as { dependency: string }).dependency, 'disabled-dep')
  assert.equal(host.get('user2')?.enabled, false, 'failed enable leaves plugin disabled')

  await host.register(def('enabled-dep'), { enabled: true })
  await host.enable('user3')
  assert.equal(host.get('user3')?.enabled, true)
  assert.equal(host.get('user3')?.status, 'active')
})

test('eager-enabled register also validates dependencies; recovers once dependency is registered', { timeout: 60_000 }, async () => {
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
// Topological startup / shutdown
// ---------------------------------------------------------------------------

test('global startup barrier prepares/starts in dependency order and stops in reverse order, keeping registration order within layers', { timeout: 60_000 }, async () => {
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
  // Registration order: first, mid, last (last -> mid -> first dependency chain)
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
  // Barrier semantics preserved: all prepare() calls precede all start() calls.
  assert.ok(order.slice(0, 5).every((e) => e.startsWith('prepare:')))
  // Dependency topology: dependencies prepare/start before dependents.
  assert.ok(prepareIdx('first') < prepareIdx('mid') && prepareIdx('mid') < prepareIdx('last'))
  assert.ok(startIdx('first') < startIdx('mid') && startIdx('mid') < startIdx('last'))
  // Within the same layer (no dependency relation), preserve registration order.
  assert.ok(prepareIdx('ia') < prepareIdx('ib'))

  await host.stop()
  const stops = order.filter((e) => e.startsWith('stop:')).map((e) => e.slice(5))
  // Reverse of topological order [first, ia, ib, mid, last]: dependents stop first.
  assert.deepEqual(stops, ['last', 'mid', 'ib', 'ia', 'first'])
  await host.dispose()
})

test('hot enable: enabling directly while dependencies are already active runs prepare+start immediately', { timeout: 60_000 }, async () => {
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
// Dependency protection
// ---------------------------------------------------------------------------

test('non-forced disable while depended upon is blocked by plugin_in_use (including transitive dependents)', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('mid', ['base']), { enabled: true })
  await host.register(def('top', ['mid']), { enabled: true })

  const err = (await assertRejectsCode(() => host.disable('base'), 'plugin_in_use', 409)) as HelmxError
  const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
  assert.deepEqual(
    usages.map((u) => u.id).sort(),
    ['mid', 'top'],
    'both direct and transitive dependents appear in usages list',
  )
  assert.ok(usages.every((u) => u.kind === 'plugin_dependency'))
  assert.equal(host.get('base')?.enabled, true)
  await host.dispose()
})

test('forced disable succeeds and explicitly marks dependents (status=failed + plugin.changed) without silent errors', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  events.length = 0
  await host.disable('base', { force: true })

  assert.equal(host.get('base')?.enabled, false)
  const user = host.get('user')
  assert.ok(user)
  assert.equal(user.enabled, true, 'force applies only to target plugin rather than auto-disabling dependents')
  assert.equal(user.status, 'failed', 'unsatisfied dependency becomes explicitly visible')
  assert.equal(user.error?.code, 'plugin_dependency_not_enabled')
  assert.ok(
    events.some(
      (e) =>
        e.type === 'plugin.changed' &&
        (e.payload as { plugin?: { id: string } }).plugin?.id === 'user',
    ),
    'dependent state transition is broadcast',
  )

  // Recovery path: disable dependent -> enable base -> re-enable dependent succeeds and clears error.
  await host.disable('user')
  await host.enable('base')
  await host.enable('user')
  const recovered = host.get('user')
  assert.ok(recovered)
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.error, undefined)

  // Dependents left in failed state after forced disable still block unregistering base until disabled.
  await host.disable('base', { force: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)
  await host.disable('user')
  await host.unregister('base')
  await host.dispose()
})

test('unregister while depended upon rejects when dependent is enabled; succeeds once dependent is disabled', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)

  await host.disable('user')
  await host.unregister('base')
  assert.equal(host.get('base'), undefined)
  // After base is removed, enabling user fails explicitly due to missing dependency.
  await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// Concurrency without deadlock
// ---------------------------------------------------------------------------

test('concurrent mixed register/enable/disable operations settle cleanly without deadlocks', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const ops: Array<Promise<unknown>> = []
  for (let i = 0; i < 6; i++) {
    ops.push(host.register(def(`p${i}`, [`p${(i + 1) % 6}`]), { enabled: false }))
  }
  // 6 plugins connected head-to-tail in a cycle: whichever completes the cycle rejects rather than hanging.
  const results = await Promise.allSettled(ops)
  const rejected = results.filter((r) => r.status === 'rejected').length
  assert.ok(rejected >= 1, 'cyclic registration must reject explicitly')
  assert.equal(results.length, 6)

  const host2 = makeHost()
  await host2.register(def('a0'), { enabled: false })
  await host2.register(def('b0', ['a0']), { enabled: false })
  await host2.register(def('c0', ['b0']), { enabled: false })
  // Concurrent enable chain racing with disable: partial failures allowed (unready dependency / in-use), all must settle.
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
