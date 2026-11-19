/**
 * Dedicated contract tests for the `ctx.host.plugins` plugin governance port:
 * - Port delegation: real PluginHost + real PluginPackageManager (local source copy, real 4-phase
 *   doctor execution) invoking doctor/install/update/enable/disable/remove from inside a plugin;
 * - Self-lifecycle rejection: plugin A invoking update/remove/disable(A) inside its own task throws
 *   409 plugin_self_lifecycle_forbidden synchronously without entering the backend queue and deadlocking;
 * - Error boundaries: unknown plugin 404 / invalid doctor path 400 / unconfigured backend port 501;
 * - Epoch guard: stale `ctx.host.plugins` handles expire (409) after disable;
 * - Redaction boundary: build diagnostics returned by doctor/install pass through host redactText.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { HelmxError, type HelmxHostApi, type PluginDefinition, type PluginSummary } from '@helmx/protocol'
import {
  PluginHost,
  PluginPackageManager,
  PluginPackageManagerStore,
} from '../src/plugins/index.js'
import { ConfigService } from '../src/services/config.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

/** Minimal valid external plugin source (matches plugin-package-manager.test conventions). */
const PLUGIN_SRC = (id: string, version = '1.0.0') => `export default {
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

function writeLocalPlugin(parent: string, id: string, version = '1.0.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

interface Env {
  host: PluginHost
  dataDir: string
  srcParent: string
  close(): Promise<void>
}

/** Real PluginHost + real PluginPackageManager backed by local dirs (zero network dependencies). */
async function makeEnv(): Promise<Env> {
  const dataDir = await makeTempDir('helmx-host-plugins-')
  const srcParent = await makeTempDir('helmx-host-plugins-src-')
  // Wire plugins port identically to runtime's createPluginHostBackend (direct delegation to PluginHost
  // public methods, reusing the same lifecycle queue and task tracking).
  const backend = hostBackendStub()
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
  backend.plugins = {
    doctorPlugin: (target) => host.doctorExternalPlugin(target),
    installPlugin: (source, options) => host.installPluginPackage(source, options),
    updatePlugin: (pluginId) => host.updatePluginPackage(pluginId),
    removePlugin: (pluginId) => host.removePluginPackage(pluginId),
    enablePlugin: async (pluginId) => {
      await host.enable(pluginId)
      return requireSummary(host, pluginId)
    },
    disablePlugin: async (pluginId, options) => {
      await host.disable(pluginId, options)
      return requireSummary(host, pluginId)
    },
  }
  const store = new PluginPackageManagerStore(new ConfigService(dataDir))
  await store.load()
  host.attachPackageManager(
    new PluginPackageManager({ dataDir, cwd: dataDir, store, host: host.asPackageManagerHost(), buildProvider: createPluginBuildProvider() }),
    store,
  )
  return {
    host,
    dataDir,
    srcParent,
    async close() {
      await cleanupDir(dataDir)
      await cleanupDir(srcParent)
    },
  }
}

function requireSummary(host: PluginHost, pluginId: string): PluginSummary {
  const summary = host.list().find((s) => s.id === pluginId)
  if (!summary) throw new HelmxError('plugin_enable_failed', `plugin ${pluginId} missing from host list after operation (inconsistent internal state)`, 500, { pluginId })
  return summary
}

/** Registers a probe plugin to capture ctx.host (enabled, real lifecycle). */
async function registerProbe(
  host: PluginHost,
  id = 'p:probe',
): Promise<HelmxHostApi> {
  let captured: HelmxHostApi | undefined
  const def: PluginDefinition = {
    id,
    definePlugin(ctx) {
      captured = ctx.host
    },
  }
  await host.register(def, { enabled: true })
  assert.ok(captured, 'ctx.host should be captured during definePlugin')
  return captured!
}

/** Asserts that invoking p throws/rejects with a HelmxError matching code and status. */
async function expectHelmxError(p: () => unknown, code: string, status: number): Promise<HelmxError> {
  try {
    await p()
  } catch (err) {
    assert.ok(err instanceof HelmxError, `expected HelmxError(${code}), got ${String(err)}`)
    assert.equal(err.code, code, `expected code=${code}, got ${err.code}`)
    assert.equal(err.status, status, `expected status=${status}, got ${err.status}`)
    return err
  }
  throw new Error(`expected HelmxError(${code}) to be thrown, returned normally`)
}

// ---------------------------------------------------------------------------
// Port delegation end-to-end (real doctor / install / update / enable / disable / remove)
// ---------------------------------------------------------------------------

test('host.plugins port delegation: doctor/install/update/enable/disable/remove end-to-end (real host)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    const src = writeLocalPlugin(env.srcParent, 'port-demo', '1.0.0')

    // doctor (dir mode, real 4-phase check; screens is [] without ui.screen declarations)
    const report = await api.plugins.doctor({ dir: src })
    assert.equal(report.ok, true)
    assert.equal(report.pluginId, 'port-demo')
    assert.deepEqual(report.screens, [], 'screens must be an empty array when no ui.screen is declared')

    // install (disabled by default)
    const installed = await api.plugins.install(src)
    assert.equal(installed.record.pluginId, 'port-demo')
    assert.equal(installed.summary.enabled, false)

    // enable -> list / listUi share snapshot source
    const enabledSummary = await api.plugins.enable('port-demo')
    assert.equal(enabledSummary.enabled, true)
    assert.equal(enabledSummary.id, 'port-demo')
    const listed = api.plugins.list()
    assert.ok(listed.some((s) => s.id === 'port-demo' && s.enabled))
    assert.deepEqual(api.listPlugins().map((s) => s.id), listed.map((s) => s.id), 'list and listPlugins share source')

    // update (resyncs after local source edit: bumps version while staying enabled)
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'port-demo', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('port-demo', '2.0.0'))
    const updated = await api.plugins.update('port-demo')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.summary.version, '2.0.0')
    assert.equal(updated.summary.enabled, true, 'update preserves enabled state')
    assert.equal(updated.previousVersion, '1.0.0')

    // remove (cleans managed dir and record; leaves user source intact)
    const removed = await api.plugins.remove('port-demo')
    assert.equal(removed.pluginId, 'port-demo')
    assert.equal(removed.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'port-demo')), 'managed directory should be deleted')
    assert.ok(existsSync(join(src, 'index.mjs')), 'user source directory stays intact')
    assert.ok(!api.plugins.list().some((s) => s.id === 'port-demo'), 'removed plugin leaves host list')
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('host.plugins.disable disables another plugin via port and respects force option', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:operator')
    const src = writeLocalPlugin(env.srcParent, 'port-target')
    await api.plugins.install(src)
    await api.plugins.enable('port-target')

    const disabled = await api.plugins.disable('port-target')
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.id, 'port-target')

    // Re-enable and disable again directly via port (no inUse blockers, force unnecessary yet valid)
    await api.plugins.enable('port-target')
    const again = await api.plugins.disable('port-target', { force: true })
    assert.equal(again.enabled, false)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

/** Plugin source declaring real ui.screen entries (exercises real doctor register + client compilation). */
function writeScreenPlugin(parent: string, id: string): string {
  const dir = join(parent, id)
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(
    join(dir, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.ui.screen({
    id: 'main',
    label: 'main view',
    client: { module: 'client.tsx', export: 'MainScreen' },
  })
  ctx.ui.screen({
    id: 'detail',
    label: 'detail view',
    client: { module: 'client.tsx', export: 'MainScreen' },
  })
}
export default { id: '${id}', version: '1.0.0', definePlugin, clientRoot: './client' }
`,
  )
  writeFileSync(
    join(dir, 'client', 'client.tsx'),
    `import React from 'react'

export function MainScreen(): React.JSX.Element {
  return React.createElement('div', null, 'app')
}
`,
  )
  return dir
}

// ---------------------------------------------------------------------------
// Doctor screens collection (real ui.screen capture during register phase)
// ---------------------------------------------------------------------------

test('doctor report captures real ui.screen declarations: screens lists all view IDs when register passes', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    const src = writeScreenPlugin(env.srcParent, 'screen-demo')
    const report = await api.plugins.doctor({ dir: src })
    assert.equal(report.ok, true, `doctor should succeed: ${JSON.stringify(report.checks)}`)
    assert.equal(report.pluginId, 'screen-demo')
    assert.deepEqual(report.screens, ['main', 'detail'], 'screens must list declared ui.screen view IDs in declaration order')
    // Also works by id (installed plugins resolve source dir via findSourceDirByPluginId)
    await api.plugins.install(src)
    const byId = await api.plugins.doctor({ id: 'screen-demo' })
    assert.equal(byId.ok, true)
    assert.deepEqual(byId.screens, ['main', 'detail'])
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('doctor failure (register failed) omits screens field; pure backend plugin reports empty array', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    // Pure backend plugin: register succeeds without ui.screen -> screens: [] (explicit empty array, not undefined)
    const plain = writeLocalPlugin(env.srcParent, 'plain-demo')
    const okReport = await api.plugins.doctor({ dir: plain })
    assert.equal(okReport.ok, true)
    assert.deepEqual(okReport.screens, [])

    // Manifest failure (missing entry): register never reached -> screens undefined (not synthesized)
    const emptyDir = join(env.srcParent, 'empty-dir')
    mkdirSync(emptyDir, { recursive: true })
    const bad = await api.plugins.doctor({ dir: emptyDir })
    assert.equal(bad.ok, false)
    assert.equal(bad.screens, undefined, 'screens must stay undefined when register fails')
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Self-lifecycle rejection
// ---------------------------------------------------------------------------

test('self-lifecycle rejection: update/remove/disable on self fail immediately 409; enable/doctor unrestricted', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:self')
    // Self-enable is a harmless idempotent no-op (returns summary when already enabled), excluded from restriction.
    const selfEnabled = await api.plugins.enable('p:self')
    assert.equal(selfEnabled.id, 'p:self')

    await expectHelmxError(() => api.plugins.update('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmxError(() => api.plugins.remove('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmxError(() => api.plugins.disable('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmxError(() => api.plugins.disable('p:self', { force: true }), 'plugin_self_lifecycle_forbidden', 409)

    // After rejection, plugin remains enabled and healthy (never enters backend queue, zero side effects)
    const summary = env.host.get('p:self')
    assert.ok(summary)
    assert.equal(summary.enabled, true)
    await api.plugins.list()
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('self-lifecycle rejection also applies inside action execution: calling self-disable from handler never deadlocks', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    let api: HelmxHostApi | undefined
    const def: PluginDefinition = {
      id: 'p:selfaction',
      definePlugin(ctx) {
        api = ctx.host
        ctx.action({
          id: 'self_disable',
          description: 'self-disable probe',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: async () => {
            await expectHelmxError(() => ctx.host.plugins.disable('p:selfaction'), 'plugin_self_lifecycle_forbidden', 409)
            return { ok: true }
          },
        })
      },
    }
    await env.host.register(def, { enabled: true })
    const result = await env.host.invokeAction('p:selfaction', 'self_disable', {})
    assert.deepEqual(result, { ok: true })
    // After action settles, plugin stays enabled with zero lingering live tasks
    const labels = (env.host as unknown as { tracker: { activeLabels(id: string): string[] } }).tracker.activeLabels('p:selfaction')
    assert.equal(labels.length, 0)
    assert.ok(api)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Error boundaries
// ---------------------------------------------------------------------------

test('error boundaries: unknown plugin, invalid path, and mutually exclusive targets', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)

    // Unknown plugin: enable/update/remove all return 404 (real PluginHost backend semantics)
    await expectHelmxError(() => api.plugins.enable('never-registered'), 'unknown_plugin', 404)
    await expectHelmxError(() => api.plugins.update('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmxError(() => api.plugins.remove('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmxError(() => api.plugins.doctor({ id: 'never-registered' }), 'plugin_source_missing', 404)

    // Invalid doctor path: relative paths and traversal `..` reject (matches HTTP parseDoctorTarget)
    await expectHelmxError(() => api.plugins.doctor({ dir: 'relative/path' }), 'validation_error', 400)
    await expectHelmxError(() => api.plugins.doctor({ dir: '/abs/../escape' }), 'validation_error', 400)
    // Mutual exclusion between id and dir / empty target
    await expectHelmxError(() => api.plugins.doctor({ id: 'x', dir: '/abs' }), 'validation_error', 400)
    await expectHelmxError(() => api.plugins.doctor({}), 'validation_error', 400)

    // Invalid source syntax (missing local dir -> 404 real error)
    await expectHelmxError(() => api.plugins.install('/nonexistent/plugin/dir'), 'plugin_package_install_failed', 404)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('unwired backend plugins port: write operations fail 501 while reads continue working', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-host-plugins-noport-')
  // Explicitly leave plugins port undefined (matching lightweight test hosts).
  const backend = hostBackendStub()
  backend.plugins = undefined
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
  try {
    const api = await registerProbe(host)
    // Read side (shared host registry) stays available
    assert.ok(Array.isArray(api.plugins.list()))
    assert.ok(Array.isArray(api.plugins.listUi()))
    // Write side fails explicitly 501 (never degrades silently)
    await expectHelmxError(() => api.plugins.doctor({ dir: '/tmp' }), 'not_supported', 501)
    await expectHelmxError(() => api.plugins.install('/tmp'), 'not_supported', 501)
    await expectHelmxError(() => api.plugins.update('x'), 'not_supported', 501)
    await expectHelmxError(() => api.plugins.remove('x'), 'not_supported', 501)
    await expectHelmxError(() => api.plugins.enable('x'), 'not_supported', 501)
    await expectHelmxError(() => api.plugins.disable('x'), 'not_supported', 501)
    // Self-check runs prior to 501: even with unwired port, self-target still throws 409 (sync guard unchanged)
    await expectHelmxError(() => api.plugins.disable('p:probe'), 'plugin_self_lifecycle_forbidden', 409)
  } finally {
    await host.dispose()
    await cleanupDir(dataDir)
  }
})

// ---------------------------------------------------------------------------
// Epoch guard and redaction
// ---------------------------------------------------------------------------

test('epoch guard: all methods on stale plugins handle throw 409 plugin_context_expired after disable', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:expired')
    await env.host.disable('p:expired')
    const expired: Array<() => unknown> = [
      () => api.plugins.list(),
      () => api.plugins.listUi(),
      () => api.plugins.doctor({ dir: '/tmp' }),
      () => api.plugins.install('/tmp'),
      () => api.plugins.update('x'),
      () => api.plugins.remove('x'),
      () => api.plugins.enable('x'),
      () => api.plugins.disable('x'),
    ]
    for (const call of expired) {
      await expectHelmxError(call, 'plugin_context_expired', 409)
    }
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('redaction boundary: secrets in failed doctor diagnostics pass through host redactText outbound', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-host-plugins-redact-')
  const srcParent = await makeTempDir('helmx-host-plugins-redact-src-')
  // Construct host with secret redaction replacing plaintext with [REDACTED] (simulating SecretStash).
  const SECRET = 'sk-helmx-super-secret-token'
  const stub = hostBackendStub()
  stub.redact = (text: string) => text.split(SECRET).join('[REDACTED]')
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: stub,
    docs: new MemoryDocStore(),
    redactText: (text) => text.split(SECRET).join('[REDACTED]'),
  })
  // Wire only doctor port (no package manager needed; runtime delegates identically).
  stub.plugins = {
    doctorPlugin: (target) => host.doctorExternalPlugin(target),
    installPlugin: () => Promise.reject(new HelmxError('unsupported', 'this test only wires doctor', 501)),
    updatePlugin: () => Promise.reject(new HelmxError('unsupported', 'this test only wires doctor', 501)),
    removePlugin: () => Promise.reject(new HelmxError('unsupported', 'this test only wires doctor', 501)),
    enablePlugin: () => Promise.reject(new HelmxError('unsupported', 'this test only wires doctor', 501)),
    disablePlugin: () => Promise.reject(new HelmxError('unsupported', 'this test only wires doctor', 501)),
  }
  try {
    const api = await registerProbe(host)
    // Broken plugin whose TS/JS source embeds a secret (compile/load failure diagnostics may include code lines -> redacted outbound).
    const broken = join(srcParent, 'redact-broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({ id: 'redact-broken', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(broken, 'index.mjs'), `const TOKEN = '${SECRET}';\nexport default { id: 'redact-broken', definePlugin() { void TOKEN; throw new Error('boom ' + TOKEN) } }\n`)

    const report = await api.plugins.doctor({ dir: broken })
    assert.equal(report.ok, false, 'broken plugin should report ok:false')
    const text = JSON.stringify(report)
    assert.ok(!text.includes(SECRET), 'diagnostic output must not expose plaintext secret')
    assert.ok(text.includes('[REDACTED]'), 'secret should be replaced with redaction placeholder')
  } finally {
    await host.dispose()
    await cleanupDir(dataDir)
    await cleanupDir(srcParent)
  }
})

// ---------------------------------------------------------------------------
// Live-task tracking on port calls (visible to disable preflight)
// ---------------------------------------------------------------------------

test('live-task tracking: port calls count against caller plugin tracker (409 protects caller from disable)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Operator installs target and holds an in-flight host.plugins.disable('track-target') call inside its action;
    // disabling operator mid-flight must fail 409 plugin_has_live_tasks.
    const src = writeLocalPlugin(env.srcParent, 'track-target')
    let operatorApi: HelmxHostApi | undefined
    let gate: (() => void) | undefined
    const gatePromise = new Promise<void>((resolve) => { gate = resolve })
    const operatorDef: PluginDefinition = {
      id: 'p:operator',
      definePlugin(ctx) {
        operatorApi = ctx.host
        ctx.action({
          id: 'hold_disable',
          description: 'long disable probe',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: async () => {
            const pending = ctx.host.plugins.disable('track-target').catch(() => undefined)
            void pending
            await gatePromise
            return { ok: true }
          },
        })
      },
    }
    await env.host.register(operatorDef, { enabled: true })
    await operatorApi!.plugins.install(src)
    await operatorApi!.plugins.enable('track-target')

    const actionPromise = env.host.invokeAction('p:operator', 'hold_disable', {})
    await new Promise((r) => setTimeout(r, 30))
    // Mid-flight: disabling operator fails 409 (host.plugins.disable task active)
    await expectHelmxError(() => env.host.disable('p:operator'), 'plugin_has_live_tasks', 409)
    gate!()
    await actionPromise
    // Once settled, disabling operator succeeds normally
    await env.host.disable('p:operator')
    assert.equal(env.host.get('p:operator')?.enabled, false)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

/** Compile-time check: PluginSummary matches existing shape without duplicate definitions. */
type _AssertSummaryShape = PluginSummary extends { id: string; enabled: boolean; locked: boolean } ? true : never
const _assertSummaryShape: _AssertSummaryShape = true
void _assertSummaryShape
