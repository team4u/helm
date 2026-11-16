/**
 * ctx.host.plugins host plugin governance port dedicated items test:
 * - port forwarding: real PluginHost + real PluginPackageManager(local source real copy,
 *   doctor all chain real execute) via plugin internal invoke doctor/install/update/enable/disable/remove;
 * - self refer lifecycle reject: plugin A in itself run task in invoke update/remove/disable(A)
 *   immediately 409 plugin_self_lifecycle_forbidden(sync throw, does not enter backend queue self wait for);
 * - error boundary: unknown plugin 404 / illegal doctor path 400 / backend not connect line port 501;
 * - cycle guard: deactivate after old ctx.host.plugins handle one rule expires (409);
 * - redaction boundary:doctor/install result carry build diagnose via host redactText out station.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { HelmError, type HelmHostApi, type PluginDefinition, type PluginSummary } from '@helm/protocol'
import {
  PluginHost,
  PluginPackageManager,
  PluginPackageManagerStore,
} from '../src/plugins/index.js'
import { ConfigService } from '../src/services/config.js'
import { hostBackendStub } from './helpers/host-backend-stub.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// base create
// ---------------------------------------------------------------------------

/** most small legal external plugin source (convention entry form; and plugin-package-manager.test same construct). */
const PLUGIN_SRC = (id: string, version = '1.0.0') => `export default {
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

/** real PluginHost + real PluginPackageManager(local source; without network dependency). */
async function makeEnv(): Promise<Env> {
  const dataDir = await makeTempDir('helm-host-plugins-')
  const srcParent = await makeTempDir('helm-host-plugins-src-')
  // backend plugins port connect line: and runtime createPluginHostBackend the same delegate side
  //(directly forwarding PluginHost since has public method, re- use the same lifecycle queue and task trace).
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
  if (!summary) throw new HelmError('plugin_enable_failed', `plugin ${pluginId} operation after not in host manifest in discover (internal state inconsistent)`, 500, { pluginId })
  return summary
}

/** register a catch ctx.host inside create probe needle plugin (enabled, real lifecycle). */
async function registerProbe(
  host: PluginHost,
  id = 'p:probe',
): Promise<HelmHostApi> {
  let captured: HelmHostApi | undefined
  const def: PluginDefinition = {
    id,
    definePlugin(ctx) {
      captured = ctx.host
    },
  }
  await host.register(def, { enabled: true })
  assert.ok(captured, 'ctx.host should in definePlugin during catch')
  return captured!
}

/** expectation designate code/status  HelmError(sync throw also compatibility). */
async function expectHelmError(p: () => unknown, code: string, status: number): Promise<HelmError> {
  try {
    await p()
  } catch (err) {
    assert.ok(err instanceof HelmError, `expectation HelmError(${code}), actual:${String(err)}`)
    assert.equal(err.code, code, `expectation code=${code}, actual=${err.code}`)
    assert.equal(err.status, status, `expectation status=${status}, actual=${err.status}`)
    return err
  }
  throw new Error(`expectation throw HelmError(${code}), actual normal return`)
}

// ---------------------------------------------------------------------------
// port forwarding all chain (real doctor / install / update / enable / disable / remove)
// ---------------------------------------------------------------------------

test('host.plugins port forwarding:doctor/install/update/enable/disable/remove all chain (real host)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    const src = writeLocalPlugin(env.srcParent, 'port-demo', '1.0.0')

    // doctor(dir pattern, real four phase self inspect; without Screen declaration when screens is empty array)
    const report = await api.plugins.doctor({ dir: src })
    assert.equal(report.ok, true)
    assert.equal(report.pluginId, 'port-demo')
    assert.deepEqual(report.screens, [], 'without ui.screen declaration when screens is empty array')

    // install(by default disabled)
    const installed = await api.plugins.install(src)
    assert.equal(installed.record.pluginId, 'port-demo')
    assert.equal(installed.summary.enabled, false)

    // enable -> list / listUi same source snapshot
    const enabledSummary = await api.plugins.enable('port-demo')
    assert.equal(enabledSummary.enabled, true)
    assert.equal(enabledSummary.id, 'port-demo')
    const listed = api.plugins.list()
    assert.ok(listed.some((s) => s.id === 'port-demo' && s.enabled))
    assert.deepEqual(api.listPlugins().map((s) => s.id), listed.map((s) => s.id), 'list and listPlugins same source')

    // update(local source edit after heavy sync: version push enter, keep enable)
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'port-demo', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('port-demo', '2.0.0'))
    const updated = await api.plugins.update('port-demo')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.summary.version, '2.0.0')
    assert.equal(updated.summary.enabled, true, 'update keep enable state')
    assert.equal(updated.previousVersion, '1.0.0')

    // remove(managed directory and record clean up; user source completely well)
    const removed = await api.plugins.remove('port-demo')
    assert.equal(removed.pluginId, 'port-demo')
    assert.equal(removed.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'port-demo')), 'managed directory should delete')
    assert.ok(existsSync(join(src, 'index.mjs')), 'user source directory completely well')
    assert.ok(!api.plugins.list().some((s) => s.id === 'port-demo'), 'manifest in should already remove')
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('host.plugins.disable deactivate other plugin (via port) and disable(force) semantics', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:operator')
    const src = writeLocalPlugin(env.srcParent, 'port-target')
    await api.plugins.install(src)
    await api.plugins.enable('port-target')

    const disabled = await api.plugins.disable('port-target')
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.id, 'port-target')

    // again enable once and directly via port deactivate (without inUse occupy, no need to force)
    await api.plugins.enable('port-target')
    const again = await api.plugins.disable('port-target', { force: true })
    assert.equal(again.enabled, false)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

/** carries real ctx.ui.screen declaration plugin source (doctor real register + real client compile). */
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
    label: 'detail situation',
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
// doctor screens catch (real register phase ctx.ui.screen declaration collect)
// ---------------------------------------------------------------------------

test('doctor report catch real ui.screen declaration:register via when screens carry all view id', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    const src = writeScreenPlugin(env.srcParent, 'screen-demo')
    const report = await api.plugins.doctor({ dir: src })
    assert.equal(report.ok, true, `doctor should via:${JSON.stringify(report.checks)}`)
    assert.equal(report.pluginId, 'screen-demo')
    assert.deepEqual(report.screens, ['main', 'detail'], 'screens should carry real ui.screen declaration all view id(by declaration order)')
    // id pattern same carry (registered plugin away findSourceDirByPluginId parse source directory)
    await api.plugins.install(src)
    const byId = await api.plugins.doctor({ id: 'screen-demo' })
    assert.equal(byId.ok, true)
    assert.deepEqual(byId.screens, ['main', 'detail'])
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('doctor failed (register not via) when do not out part screens: without ui.screen pure backend plugin screens is empty array', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)
    // pure backend plugin:register via but without ui.screen declaration -> screens: [](fact empty, non- missing)
    const plain = writeLocalPlugin(env.srcParent, 'plain-demo')
    const okReport = await api.plugins.doctor({ dir: plain })
    assert.equal(okReport.ok, true)
    assert.deepEqual(okReport.screens, [])

    // manifest failed (without entry):register not reach -> screens default (do not virtual construct)
    const emptyDir = join(env.srcParent, 'empty-dir')
    mkdirSync(emptyDir, { recursive: true })
    const bad = await api.plugins.doctor({ dir: emptyDir })
    assert.equal(bad.ok, false)
    assert.equal(bad.screens, undefined, 'register not via when must not carry part screens')
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// self refer lifecycle reject
// ---------------------------------------------------------------------------

test('self refer lifecycle reject: plugin for itself update/remove/disable immediately 409,enable/doctor do not subject to limit', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host, 'p:self')
    // for itself enable is idempotent without harm operation (enabled when directly return manifest), do not in self refer forbidden side.
    const selfEnabled = await api.plugins.enable('p:self')
    assert.equal(selfEnabled.id, 'p:self')

    await expectHelmError(() => api.plugins.update('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.remove('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.disable('p:self'), 'plugin_self_lifecycle_forbidden', 409)
    await expectHelmError(() => api.plugins.disable('p:self', { force: true }), 'plugin_self_lifecycle_forbidden', 409)

    // reject after plugin still in manual and available (not enter backend queue, no side effects)
    const summary = env.host.get('p:self')
    assert.ok(summary)
    assert.equal(summary.enabled, true)
    await api.plugins.list()
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('self refer reject in action execute in also into establish:handler inside invoke self disable will not deadlock', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    let api: HelmHostApi | undefined
    const def: PluginDefinition = {
      id: 'p:selfaction',
      definePlugin(ctx) {
        api = ctx.host
        ctx.action({
          id: 'self_disable',
          description: 'self refer deactivate probe needle',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          handler: async () => {
            await expectHelmError(() => ctx.host.plugins.disable('p:selfaction'), 'plugin_self_lifecycle_forbidden', 409)
            return { ok: true }
          },
        })
      },
    }
    await env.host.register(def, { enabled: true })
    const result = await env.host.invokeAction('p:selfaction', 'self_disable', {})
    assert.deepEqual(result, { ok: true })
    // action converge after plugin still enable (in-flight task counter reset to zero)
    const labels = (env.host as unknown as { tracker: { activeLabels(id: string): string[] } }).tracker.activeLabels('p:selfaction')
    assert.equal(labels.length, 0)
    assert.ok(api)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// error boundary
// ---------------------------------------------------------------------------

test('error boundary: unknown plugin/illegal path/mutual exclusion target', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const api = await registerProbe(env.host)

    // unknown plugin:enable/update/remove all 404(backend PluginHost real semantics)
    await expectHelmError(() => api.plugins.enable('never-registered'), 'unknown_plugin', 404)
    await expectHelmError(() => api.plugins.update('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmError(() => api.plugins.remove('never-registered'), 'unknown_plugin_package', 404)
    await expectHelmError(() => api.plugins.doctor({ id: 'never-registered' }), 'plugin_source_missing', 404)

    // doctor illegal path: relative path and .. through exceeds segment reject (and HTTP parseDoctorTarget same constraint)
    await expectHelmError(() => api.plugins.doctor({ dir: 'relative/path' }), 'validation_error', 400)
    await expectHelmError(() => api.plugins.doctor({ dir: '/abs/../escape' }), 'validation_error', 400)
    // id and dir mutual exclusion / empty target
    await expectHelmError(() => api.plugins.doctor({ id: 'x', dir: '/abs' }), 'validation_error', 400)
    await expectHelmError(() => api.plugins.doctor({}), 'validation_error', 400)

    // illegal source grammar(local missing path -> 404 fact error)
    await expectHelmError(() => api.plugins.install('/nonexistent/plugin/dir'), 'plugin_package_install_failed', 404)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('backend not connect line plugins port: modify operation explicit 501, read side per common available', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helm-host-plugins-noport-')
  // explicit do not connect line plugins port (undefined): and light amount test host same form.
  const backend = hostBackendStub()
  backend.plugins = undefined
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
  try {
    const api = await registerProbe(host)
    // read side (same source host manifest) available
    assert.ok(Array.isArray(api.plugins.list()))
    assert.ok(Array.isArray(api.plugins.listUi()))
    // write side explicit 501(not silently fall back)
    await expectHelmError(() => api.plugins.doctor({ dir: '/tmp' }), 'not_supported', 501)
    await expectHelmError(() => api.plugins.install('/tmp'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.update('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.remove('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.enable('x'), 'not_supported', 501)
    await expectHelmError(() => api.plugins.disable('x'), 'not_supported', 501)
    // self refer guard first at 501: i.e. convenient not connect line, self refer target still by 409 reject (sync guard against defend do not change)
    await expectHelmError(() => api.plugins.disable('p:probe'), 'plugin_self_lifecycle_forbidden', 409)
  } finally {
    await host.dispose()
    await cleanupDir(dataDir)
  }
})

// ---------------------------------------------------------------------------
// cycle guard and redaction
// ---------------------------------------------------------------------------

test('cycle guard: deactivate after old handle plugins all method one rule 409 plugin_context_expired', { timeout: 60_000 }, async () => {
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
      await expectHelmError(call, 'plugin_context_expired', 409)
    }
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

test('redaction boundary:doctor failed diagnose in secret via host redactText out station', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helm-host-plugins-redact-')
  const srcParent = await makeTempDir('helm-host-plugins-redact-src-')
  // construct carries secret host:redact plaintext secret replace is mark record (simulated SecretStash).
  const SECRET = 'sk-helm-super-secret-token'
  const stub = hostBackendStub()
  stub.redact = (text: string) => text.split(SECRET).join('[REDACTED]')
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: stub,
    docs: new MemoryDocStore(),
    redactText: (text) => text.split(SECRET).join('[REDACTED]'),
  })
  // doctor no need to package manage: directly connect line doctor side (and runtime the same delegate).
  stub.plugins = {
    doctorPlugin: (target) => host.doctorExternalPlugin(target),
    installPlugin: () => Promise.reject(new HelmError('unsupported', 'this test only connect line doctor', 501)),
    updatePlugin: () => Promise.reject(new HelmError('unsupported', 'this test only connect line doctor', 501)),
    removePlugin: () => Promise.reject(new HelmError('unsupported', 'this test only connect line doctor', 501)),
    enablePlugin: () => Promise.reject(new HelmError('unsupported', 'this test only connect line doctor', 501)),
    disablePlugin: () => Promise.reject(new HelmError('unsupported', 'this test only connect line doctor', 501)),
  }
  try {
    const api = await registerProbe(host)
    // break loss plugin: entry TS inside embed secret (failed to compile diagnose carry source code row -> must redaction out station).
    const broken = join(srcParent, 'redact-broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({ id: 'redact-broken', version: '1.0.0', main: 'index.mjs' }))
    writeFileSync(join(broken, 'index.mjs'), `const TOKEN = '${SECRET}';\nexport default { id: 'redact-broken', definePlugin() { void TOKEN; throw new Error('boom ' + TOKEN) } }\n`)

    const report = await api.plugins.doctor({ dir: broken })
    assert.equal(report.ok, false, 'break loss plugin should ok:false')
    const text = JSON.stringify(report)
    assert.ok(!text.includes(SECRET), 'diagnose output must not contains secret plaintext')
    assert.ok(text.includes('[REDACTED]'), 'secret should by replace is redaction mark record')
  } finally {
    await host.dispose()
    await cleanupDir(dataDir)
    await cleanupDir(srcParent)
  }
})

// ---------------------------------------------------------------------------
// port in-flight task trace (deactivate preflight visible)
// ---------------------------------------------------------------------------

test('in-flight task trace:port invoke count caller plugin tracker(disable caller by 409 protect)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // operator install target and in itself action in deactivate target:operator  tracker
    // in action during hold has host.plugins.disable task; this where verify another plugin attempt deactivate
    // operator when by in-flight task 409 reject (task tag host.plugins.disable visible).
    const src = writeLocalPlugin(env.srcParent, 'track-target')
    let operatorApi: HelmHostApi | undefined
    let gate: (() => void) | undefined
    const gatePromise = new Promise<void>((resolve) => { gate = resolve })
    const operatorDef: PluginDefinition = {
      id: 'p:operator',
      definePlugin(ctx) {
        operatorApi = ctx.host
        ctx.action({
          id: 'hold_disable',
          description: 'long deactivate probe needle',
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
    // in-flight during: deactivate operator by 409 reject (host.plugins.disable task in-flight)
    await expectHelmError(() => env.host.disable('p:operator'), 'plugin_has_live_tasks', 409)
    gate!()
    await actionPromise
    // action converge after can normal deactivate
    await env.host.disable('p:operator')
    assert.equal(env.host.get('p:operator')?.enabled, false)
  } finally {
    await env.host.dispose()
    await env.close()
  }
})

/** compile time auxiliary:PluginSummary shape along use since has model (without duplicate define). */
type _AssertSummaryShape = PluginSummary extends { id: string; enabled: boolean; locked: boolean } ? true : never
const _assertSummaryShape: _AssertSummaryShape = true
void _assertSummaryShape
