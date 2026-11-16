/**
 * external plugin generate state DX closed ring test:generation loader(proxy boundary load)+ doctor(static self inspect)
 * + reload(subject to control hot reload)+ rescan(incremental heavy scan).
 *
 * combine discipline: real createHelm(true SQLite + true PluginHost + true external plugin source file directory)+
 * faux provider; do not mock app, do not fake host.fixture all in temporary development dataDir.
 *
 * override (want seek true verify items):
 * - proxy boundary load:?helmgen entry re- initialize module (module level counter pass increase); each other for dependency closed package
 *   pass broadcast proxy boundary mark record (local dependency same re- initialize);@helm/* bare note symbol across proxy sharing the same instance;
 * - doctor: health plugin ok=true and attach real register summary; corrupt manifest / language method error /
 *   register boundary violate about / dangling client export respectively in for should check items;
 * - reload: preflight failed old instance keep available (action still can tune); health code reload succeeded and enable state
 *   keep; built-in plugin 403; in-flight task 409;
 * - rescan: new directory register and by default deactivate; registered plugin do not by hit disturb (action per common).
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HelmError as HostHelmError } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { doctorPluginDir } from '../../kernel/src/plugins/plugin-doctor.js'
import { createHubTestApp } from './helpers/hub-test-env.js'

async function createApp(dataDir: string) {
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

// ---------------------------------------------------------------------------
// fixture write
// ---------------------------------------------------------------------------

/**
 * most small health TS plugin:index.ts + a idempotent probe needle action + module level initialize counter.
 * counterName used to assertion same proxy only initialize once / new proxy re- initialize.
 */
function writeMinimalPlugin(
  pluginsDir: string,
  dir: string,
  opts: { probeValue?: string } = {},
): { dirPath: string; counterName: string } {
  const counterName = `__dx_init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib'), { recursive: true })
  const probeValue = opts.probeValue ?? 'v1'
  writeFileSync(
    join(dirPath, 'index.ts'),
    `import { sharedDep } from './lib/shared.js'

declare global { var ${counterName}: number | undefined }
globalThis.${counterName} = (globalThis.${counterName} ?? 0) + 1

function definePlugin(ctx: any) {
  ctx.action({
    id: 'probe',
    description: 'probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['value', 'shared'],
      additionalProperties: false,
      properties: { value: { type: 'string' }, shared: { type: 'string' } },
    },
    idempotent: true,
    handler: () => ({ value: ${JSON.stringify(probeValue)}, shared: sharedDep() }),
  })
}

export default { id: '${dir}', name: 'DX plugin ${dir}', version: '0.1.0', definePlugin }
`,
  )
  // local TS dependency (.js note symbol mapping)+ itself module level counter (verify proxy boundary pass broadcast to dependency closed package)
  writeFileSync(
    join(dirPath, 'lib', 'shared.ts'),
    `import { HelmError } from '@helm/protocol'
declare global { var ${counterName}_lib: number | undefined }
globalThis.${counterName}_lib = (globalThis.${counterName}_lib ?? 0) + 1
export const sharedDep = (): string => 'shared:' + (HelmError ? 'helm-ok' : 'helm-missing')
`,
  )
  return { dirPath, counterName }
}

/** carries frontend component declaration plugin (doctor client check consume). */
function writeClientPlugin(
  pluginsDir: string,
  dir: string,
  opts: { exportName?: string } = {},
): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'client'), { recursive: true })
  const exportName = opts.exportName ?? 'SamplePanel'
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.ui.workbenchPanel({
    id: 'panel',
    label: 'panel',
    client: { module: 'client.tsx', export: ${JSON.stringify(exportName)} },
  })
}
export default { id: '${dir}', definePlugin }
`,
  )
  // fix correct:clientRoot is PluginDefinition field (module export), in import after by
  // normalizeDefinition parse is absolute path - - via heavy write tail row inject each other for clientRoot.
  const entryFile = join(dirPath, 'index.ts')
  writeFileSync(
    entryFile,
    readFileSync(entryFile, 'utf8').replace(
      `export default { id: '${dir}', definePlugin }`,
      `export default { id: '${dir}', definePlugin, clientRoot: './client' }`,
    ),
  )
  writeFileSync(
    join(dirPath, 'client', 'client.tsx'),
    `import React from 'react'
import { usePluginDoc } from '@helm/plugin-client'

export function ${exportName}(): React.JSX.Element {
  const state = usePluginDoc<{ n: number }>('state')
  return React.createElement('div', null, 'n=', state?.n ?? 0)
}
`,
  )
  return dirPath
}

// ---------------------------------------------------------------------------
// proxy boundary load (generation loader)
// note: proxy boundary pass broadcast assertion in pure node child process run (--experimental-strip-types).
// development phase tsx load will heavy write URL and cache module parse (tsx-commonjs-virtual-query),
// its behavior does not mean produce semantics; external plugin load same style verify way see external-plugin-ts.test.ts.
// ---------------------------------------------------------------------------

test('proxy boundary load:?helmgen entry re- initialize module diagram, each other for dependency closed package pass broadcast (pure node child process)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-gen-'))
  const loaderSrc = fileURLToPath(new URL('../../kernel/src/plugins/backend-ts-loader.ts', import.meta.url))
  try {
    const { dirPath, counterName } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-gen')
    const childSrc = `
const { registerPluginTsRoot, nextPluginGeneration } = await import(${JSON.stringify(loaderSrc)})
const { createPluginBuildProvider } = await import(${JSON.stringify(import.meta.resolve('@helm/plugin-build'))})
const entry = ${JSON.stringify(join(dirPath, 'index.ts'))}
const release = registerPluginTsRoot(${JSON.stringify(dirPath)}, { transform: createPluginBuildProvider().transformBackendTs })
const plain = (await import('file://' + entry)).default
if (plain.id !== 'dx-gen') { console.log('FAIL id'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 1) { console.log('FAIL plain-init'); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 1) { console.log('FAIL plain-lib-init'); process.exit(1) }
const again = (await import('file://' + entry)).default
if (again !== plain) { console.log('FAIL same-url-identity'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 1) { console.log('FAIL cache-reinit'); process.exit(1) }
const g1 = nextPluginGeneration(${JSON.stringify(dirPath)})
const gen1 = (await import('file://' + entry + '?helmgen=' + g1)).default
if (gen1 === plain) { console.log('FAIL gen-new-instance'); process.exit(1) }
if (globalThis[${JSON.stringify(counterName)}] !== 2) { console.log('FAIL gen1-init:' + globalThis[${JSON.stringify(counterName)}]); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 2) { console.log('FAIL gen1-lib-init:' + globalThis[${JSON.stringify(`${counterName}_lib`)}]); process.exit(1) }
const g2 = nextPluginGeneration(${JSON.stringify(dirPath)})
if (g2 <= g1) { console.log('FAIL gen-monotonic'); process.exit(1) }
await import('file://' + entry + '?helmgen=' + g2)
if (globalThis[${JSON.stringify(counterName)}] !== 3) { console.log('FAIL gen2-init:' + globalThis[${JSON.stringify(counterName)}]); process.exit(1) }
if (globalThis[${JSON.stringify(`${counterName}_lib`)}] !== 3) { console.log('FAIL gen2-lib-init:' + globalThis[${JSON.stringify(`${counterName}_lib`)}]); process.exit(1) }
release()
console.log('CHILD_OK')
`
    const childPath = join(dirPath, 'gen-child.mjs')
    writeFileSync(childPath, childSrc)
    let out = ''
    try {
      out = execFileSync(process.execPath, ['--experimental-strip-types', childPath], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const errOut = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
      assert.fail(`pure node child process failed:${out}${errOut.slice(0, 800)}`)
    }
    assert.ok(out.includes('CHILD_OK'), `child process should all contract via, output:${out}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor: health plugin ok=true and attach real register summary', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-healthy')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, true, `health plugin should via:${JSON.stringify(report.checks)}`)
    assert.equal(report.pluginId, 'dx-healthy')
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest', 'backend', 'register', 'client'],
    )
    assert.ok(report.summary, 'attach real register summary')
    assert.equal(report.summary!.id, 'dx-healthy')
    assert.equal(report.summary!.enabled, false, 'doctor register by default deactivate (no side effects)')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: corrupt manifest in manifest check items', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-bad-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ not valid json')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const manifest = report.checks.find((c) => c.id === 'manifest')
    assert.ok(manifest?.error, 'manifest check failed')
    assert.equal(manifest!.error!.code, 'plugin_manifest_invalid')
    // after continue dependency check do not execute (avoid mistakenly lead connect ring failed)
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest'],
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor:TS language method error in backend check items (contains file locate)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-syntax')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-syntax", definePlugin( {}\n')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const backend = report.checks.find((c) => c.id === 'backend')
    assert.ok(backend?.error)
    assert.equal(backend!.error!.code, 'plugin_load_failed')
    assert.ok(backend!.error!.message.includes('index.ts'), 'diagnose contains file locate')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: register boundary violate about (duplicate action id) in register check items', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-dup-action')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.ts'),
      `function definePlugin(ctx: any) {
  const spec = {
    id: 'dup',
    description: 'x',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    handler: () => ({ ok: true }),
  }
  ctx.action(spec)
  ctx.action(spec)
}
export default { id: 'dx-dup-action', definePlugin }
`,
    )
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const register = report.checks.find((c) => c.id === 'register')
    assert.ok(register?.error)
    assert.equal(register!.error!.code, 'duplicate_action')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: dangling client export in client check items (real compile artifact export validate)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    // declaration export name in module in missing (write into other name)
    const dirPath = writeClientPlugin(join(dataDir, 'plugins'), 'dx-dangling', {
      exportName: 'NotThePanelYouWant',
    })
    // declaration reference correct name (and actual export inconsistent -> dangling)
    const entry = readFileSync(join(dirPath, 'index.ts'), 'utf8')
    writeFileSync(
      join(dirPath, 'index.ts'),
      entry.replace('NotThePanelYouWant', 'SamplePanel'),
    )
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const client = report.checks.find((c) => c.id === 'client')
    assert.ok(client?.error, `client check should failed:${JSON.stringify(report.checks)}`)
    assert.equal(client!.error!.code, 'invalid_client_export')
    assert.ok(client!.error!.message.includes('SamplePanel'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: health frontend component via client check', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = writeClientPlugin(join(dataDir, 'plugins'), 'dx-client-ok')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, true, JSON.stringify(report.checks))
    const client = report.checks.find((c) => c.id === 'client')
    assert.ok(client && client.error === undefined)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// rescan(incremental heavy scan)
// ---------------------------------------------------------------------------

test('rescan: new directory register and by default deactivate; registered plugin do not subject to hit disturb', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-rescan-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-first')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-first')
    const before = (await app.kernel.plugins.invokeAction('dx-first', 'probe', {})) as {
      value: string
    }
    assert.equal(before.value, 'v1')

    // put new plugin directory after rescan: only register new plugin, by default deactivate
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-second')
    const result = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(result.registered, ['dx-second'])
    const second = result.plugins.find((p) => p.id === 'dx-second')
    assert.ok(second)
    assert.equal(second.enabled, false, 'rescan register new plugin by default deactivate')

    // registered plugin do not subject to hit disturb (still is enable state, action per common)
    const after = (await app.kernel.plugins.invokeAction('dx-first', 'probe', {})) as {
      value: string
    }
    assert.equal(after.value, 'v1')
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-first')?.enabled, true)

    // again rescan: without new plugin
    const again = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(again.registered, [])
    assert.ok(again.skipped >= 2, `registered and data directory count skipped:${again.skipped}`)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// reload(subject to control hot reload)
// ---------------------------------------------------------------------------

test('reload: health code reload succeeded and enable state keep; new code takes effect', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath, counterName } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-live')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-live')
    const v1 = (await app.kernel.plugins.invokeAction('dx-live', 'probe', {})) as {
      value: string
    }
    assert.equal(v1.value, 'v1')
    const initsAfterFirstEnable = (globalThis as Record<string, unknown>)[counterName] as number

    // modify code (action return value change)
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )

    const result = await app.kernel.plugins.reloadExternalPlugin('dx-live')
    assert.equal(result.pluginId, 'dx-live')
    assert.equal(result.wasEnabled, true)
    assert.ok(result.generation >= 2)
    assert.equal(result.summary.enabled, true, 'reload after keep enable')

    const v2 = (await app.kernel.plugins.invokeAction('dx-live', 'probe', {})) as {
      value: string
    }
    assert.equal(v2.value, 'v2', 'reload after new code takes effect')
    const initsAfterReload = (globalThis as Record<string, unknown>)[counterName] as number
    assert.ok(
      initsAfterReload > initsAfterFirstEnable,
      'reload use new proxy boundary module diagram (module re- initialize)',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: broken code preflight failed, old instance keep available (action per common, state do not change)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-keep')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-keep')

    // write broken code (language method error)
    writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-keep", definePlugin(( {}\n')

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-keep'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError)
        assert.equal(err.code, 'plugin_reload_preflight_failed')
        assert.equal(err.status, 422)
        const details = err.details as { report?: { ok?: boolean } }
        assert.equal(details?.report?.ok, false, 'error attach complete doctor report')
        return true
      },
    )

    // old instance keep available: still is enable state, action per common return old value
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-keep')?.enabled, true)
    const probe = (await app.kernel.plugins.invokeAction('dx-keep', 'probe', {})) as {
      value: string
    }
    assert.equal(probe.value, 'v1', 'old instance code continue service')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: built-in plugin 403 reject', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('builtin:profile'),
      (err: unknown) =>
        err instanceof HostHelmError && err.code === 'plugin_locked' && err.status === 403,
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: not registered plugin 404', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-never-exists'),
      (err: unknown) => err instanceof HostHelmError && err.code === 'unknown_plugin',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: in-flight task 409 reject (in-flight tool execute during)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-busy')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-busy')

    // construct in-flight task:withTask package wrap during trigger reload
    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    const task = app.kernel.plugins.withTask('dx-busy', 'dx-test-busy', async () => gate)
    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-busy'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError)
        assert.equal(err.code, 'plugin_has_live_tasks')
        assert.equal(err.status, 409)
        return true
      },
    )
    await task
    // in-flight task after end reload can succeeded
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-busy')
    assert.equal(result.pluginId, 'dx-busy')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: deactivate state plugin reload after keep deactivate', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-off')
    app = await createApp(dataDir)
    // by default deactivate (do not enable)
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-off')?.enabled, false)
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-off')
    assert.equal(result.wasEnabled, false)
    assert.equal(result.summary.enabled, false, 'reload after keep deactivate')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor by id / reload switch failed rollback
// ---------------------------------------------------------------------------

test('doctor by id: registered plugin by id parse source directory; not registered id 404', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-docid-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-docid')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-docid')

    const report = await app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid' })
    assert.equal(report.ok, true, JSON.stringify(report.checks))
    assert.equal(report.requestedId, 'dx-docid')
    assert.ok(report.dir.endsWith('dx-docid'), `by id parse to source directory:${report.dir}`)
    assert.equal(report.pluginId, 'dx-docid')

    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-not-registered' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_source_missing',
    )
    // id and dir mutual exclusion
    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid', dir: '/abs' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'validation_error',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: new code switch on failure rollback to old instance (old define continue available)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-rollback-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    // plugin A(await reload) and plugin B(occupy slash trigger term dxdupe)
    const dirA = join(dataDir, 'plugins', 'dx-a')
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-a')
    writeSlashPlugin(join(dataDir, 'plugins'), 'dx-b', 'dxdupe')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-a')
    await app.kernel.plugins.enable('dx-b')

    // old instance available
    const v1 = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(v1.value, 'v1')

    // new code:doctor can (sandbox inside without B), but enable register and B  slash conflict -> switch failed.
    // keep original handler behavior, append conflict command declaration.
    const original = readFileSync(join(dirA, 'index.ts'), 'utf8')
    // heavy naming original definePlugin is baseDefine, again declaration carries conflict slash new definePlugin.
    const injected = original
      .replace('function definePlugin(ctx: any) {', 'function baseDefine(ctx: any) {')
      .replace(
        `export default { id: 'dx-a', name: 'DX plugin dx-a', version: '0.1.0', definePlugin }`,
        `function definePlugin(ctx: any) {
  baseDefine(ctx)
  ctx.ui.command({ id: 'dupe-cmd', label: 'conflict command', slash: 'dxdupe', actionId: 'probe' })
}
export default { id: 'dx-a', name: 'DX plugin dx-a', version: '0.1.0', definePlugin }`,
      )
    assert.notEqual(injected, original, 'inject should take effect (template match on failure explicit expose)')
    writeFileSync(join(dirA, 'index.ts'), injected)

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-a'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError, `should throw HelmError:${String(err)}`)
        assert.equal(err.code, 'plugin_reload_failed')
        const details = err.details as { rolledBack?: boolean }
        assert.equal(details?.rolledBack, true, 'switch failed after should rollback to old instance')
        return true
      },
    )

    // rollback after: plugin still in manifest and enable, old code continue service
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-a')?.enabled, true, 'rollback after keep enable')
    const probe = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(probe.value, 'v1', 'rollback after old instance code continue service')

    // restore without conflict code after reload succeeded
    writeFileSync(join(dirA, 'index.ts'), original)
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-a')
    assert.equal(result.summary.enabled, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/** carries commandPalette slash declaration plugin (used to across plugin uniqueness conflict). */
function writeSlashPlugin(pluginsDir: string, dir: string, slash: string): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.ts'),
    `function definePlugin(ctx: any) {
  ctx.action({
    id: 'noop',
    description: 'empty action',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    idempotent: true,
    handler: () => ({ ok: true }),
  })
  ctx.ui.command({
    id: 'cmd',
    label: 'command',
    slash: ${JSON.stringify(slash)},
    actionId: 'noop',
  })
}
export default { id: '${dir}', definePlugin }
`,
  )
  return dirPath
}
