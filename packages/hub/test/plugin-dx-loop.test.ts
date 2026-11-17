/**
 * End-to-end tests for external plugin DX loop: generation loader + doctor (static self-check)
 * + reload (controlled hot reload) + rescan (incremental directory rescan).
 *
 * Composition discipline: real `createHelm` (real SQLite + real `PluginHost` + real external plugin source dirs) +
 * faux provider; no mocked app or host. Everything runs against temporary `dataDir` fixtures.
 *
 * Covers:
 * - Generation loading: `?helmgen` entry re-initializes the module graph (module-level counters increment);
 *   relative dependencies propagate the generation tag (local deps re-initialize too); `@helm/*` bare
 *   specifiers stay shared across generations with the host;
 * - Doctor: healthy plugin returns `ok=true` with real registration summary; corrupt manifest / syntax error /
 *   registration violation / dangling client export each surface in their corresponding check;
 * - Reload: preflight failure preserves old instance (actions remain callable); healthy reload succeeds while
 *   keeping enabled state; built-in plugins reject 403; live tasks reject 409;
 * - Rescan: new directories register disabled by default; already-registered plugins remain undisturbed.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }`.
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
// Fixture writers
// ---------------------------------------------------------------------------

/**
 * Minimal healthy TS plugin: `index.ts` + idempotent `probe` action + module-level init counter.
 * `counterName` verifies same-generation caching vs. new-generation re-initialization.
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
  // Local TS dependency (`.js` specifier mapping) + own module-level counter (verifies generation tag propagation).
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

/** Plugin declaring a frontend component (used by doctor client check tests). */
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
  // `clientRoot` is a `PluginDefinition` field on the module export, resolved by `normalizeDefinition` after import;
  // inject relative `clientRoot` directly into the export line.
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
// Generation loader
// Note: generation propagation assertions run in a pure Node child process (`--experimental-strip-types`).
// Under dev `tsx`, loader hooks rewrite URLs and cache virtual queries (`tsx-commonjs-virtual-query`),
// which does not reflect production ESM semantics; see `external-plugin-ts.test.ts` for similar patterns.
// ---------------------------------------------------------------------------

test('generation loader: ?helmgen re-initializes module graph and propagates across relative deps (pure Node child process)', { timeout: 60_000 }, async () => {
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
      assert.fail(`pure Node child process failed: ${out}${errOut.slice(0, 800)}`)
    }
    assert.ok(out.includes('CHILD_OK'), `child process should pass all assertions, output: ${out}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor: healthy plugin returns ok=true with real registration summary', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-healthy')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, true, `healthy plugin should pass: ${JSON.stringify(report.checks)}`)
    assert.equal(report.pluginId, 'dx-healthy')
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest', 'backend', 'register', 'client'],
    )
    assert.ok(report.summary, 'should attach real registration summary')
    assert.equal(report.summary!.id, 'dx-healthy')
    assert.equal(report.summary!.enabled, false, 'doctor registers disabled by default (no side effects)')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: corrupt manifest fails at manifest check', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dx-bad-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ not valid json')
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const manifest = report.checks.find((c) => c.id === 'manifest')
    assert.ok(manifest?.error, 'manifest check should fail')
    assert.equal(manifest!.error!.code, 'plugin_manifest_invalid')
    // Downstream dependent checks are skipped to avoid cascading noise.
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest'],
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: TS syntax error fails at backend check with file location', { timeout: 60_000 }, async () => {
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
    assert.ok(backend!.error!.message.includes('index.ts'), 'diagnostic should include file location')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: registration violation (duplicate action id) fails at register check', { timeout: 60_000 }, async () => {
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

test('doctor: dangling client export fails at client check (real compiled bundle validation)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-doc-'))
  try {
    // Export name in client module differs from what `definePlugin` references.
    const dirPath = writeClientPlugin(join(dataDir, 'plugins'), 'dx-dangling', {
      exportName: 'NotThePanelYouWant',
    })
    // Point `definePlugin` at `SamplePanel` (absent from actual exports -> dangling).
    const entry = readFileSync(join(dirPath, 'index.ts'), 'utf8')
    writeFileSync(
      join(dirPath, 'index.ts'),
      entry.replace('NotThePanelYouWant', 'SamplePanel'),
    )
    const report = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
    assert.equal(report.ok, false)
    const client = report.checks.find((c) => c.id === 'client')
    assert.ok(client?.error, `client check should fail: ${JSON.stringify(report.checks)}`)
    assert.equal(client!.error!.code, 'invalid_client_export')
    assert.ok(client!.error!.message.includes('SamplePanel'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('doctor: healthy frontend component passes client check', { timeout: 60_000 }, async () => {
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
// rescan (incremental directory rescan)
// ---------------------------------------------------------------------------

test('rescan: registers new directory disabled by default without disturbing existing plugins', { timeout: 60_000 }, async () => {
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

    // Add new plugin dir and rescan: registers only the new plugin, disabled by default.
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-second')
    const result = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(result.registered, ['dx-second'])
    const second = result.plugins.find((p) => p.id === 'dx-second')
    assert.ok(second)
    assert.equal(second.enabled, false, 'rescanned plugin defaults to disabled')

    // Already-registered plugin stays enabled and unaffected.
    const after = (await app.kernel.plugins.invokeAction('dx-first', 'probe', {})) as {
      value: string
    }
    assert.equal(after.value, 'v1')
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-first')?.enabled, true)

    // Subsequent rescan finds no new plugins.
    const again = await app.kernel.plugins.rescanExternalPlugins()
    assert.deepEqual(again.registered, [])
    assert.ok(again.skipped >= 2, `registered and data dirs counted as skipped: ${again.skipped}`)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// reload (controlled hot reload)
// ---------------------------------------------------------------------------

test('reload: healthy code reloads, preserves enabled state, and activates updated logic', { timeout: 60_000 }, async () => {
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

    // Modify plugin code (change action return value).
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )

    const result = await app.kernel.plugins.reloadExternalPlugin('dx-live')
    assert.equal(result.pluginId, 'dx-live')
    assert.equal(result.wasEnabled, true)
    assert.ok(result.generation >= 2)
    assert.equal(result.summary.enabled, true, 'remains enabled after reload')

    const v2 = (await app.kernel.plugins.invokeAction('dx-live', 'probe', {})) as {
      value: string
    }
    assert.equal(v2.value, 'v2', 'updated code takes effect after reload')
    const initsAfterReload = (globalThis as Record<string, unknown>)[counterName] as number
    assert.ok(
      initsAfterReload > initsAfterFirstEnable,
      'reload initializes a fresh module generation',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: broken code fails preflight while keeping old instance live and state unchanged', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-keep')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-keep')

    // Write invalid syntax.
    writeFileSync(join(dirPath, 'index.ts'), 'export default { id: "dx-keep", definePlugin(( {}\n')

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-keep'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError)
        assert.equal(err.code, 'plugin_reload_preflight_failed')
        assert.equal(err.status, 422)
        const details = err.details as { report?: { ok?: boolean } }
        assert.equal(details?.report?.ok, false, 'error includes full doctor report')
        return true
      },
    )

    // Old instance remains enabled and serves requests.
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-keep')?.enabled, true)
    const probe = (await app.kernel.plugins.invokeAction('dx-keep', 'probe', {})) as {
      value: string
    }
    assert.equal(probe.value, 'v1', 'old instance continues serving')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: rejects built-in plugins with 403', { timeout: 60_000 }, async () => {
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

test('reload: rejects unregistered plugin with 404', { timeout: 60_000 }, async () => {
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

test('reload: rejects with 409 when live tasks are in flight', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-busy')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-busy')

    // Trigger reload while a `withTask`-wrapped task is in flight.
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
    // Reload succeeds once the in-flight task finishes.
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-busy')
    assert.equal(result.pluginId, 'dx-busy')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: disabled plugin remains disabled after reload', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const { dirPath } = writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-off')
    app = await createApp(dataDir)
    // Disabled by default.
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-off')?.enabled, false)
    writeFileSync(
      join(dirPath, 'index.ts'),
      readFileSync(join(dirPath, 'index.ts'), 'utf8').replace('v1', 'v2'),
    )
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-off')
    assert.equal(result.wasEnabled, false)
    assert.equal(result.summary.enabled, false, 'remains disabled after reload')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// doctor by id / rollback on reload switch failure
// ---------------------------------------------------------------------------

test('doctor by id: resolves source directory for registered plugin; 404 for unknown id', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-docid-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-docid')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-docid')

    const report = await app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid' })
    assert.equal(report.ok, true, JSON.stringify(report.checks))
    assert.equal(report.requestedId, 'dx-docid')
    assert.ok(report.dir.endsWith('dx-docid'), `should resolve source dir by id: ${report.dir}`)
    assert.equal(report.pluginId, 'dx-docid')

    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-not-registered' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'plugin_source_missing',
    )
    // `id` and `dir` are mutually exclusive.
    await assert.rejects(
      app.kernel.plugins.doctorExternalPlugin({ id: 'dx-docid', dir: '/abs' }),
      (err: unknown) => err instanceof HostHelmError && err.code === 'validation_error',
    )
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('reload: rolls back to previous instance when new code fails on switchover', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-rollback-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    // Plugin A (target for reload) and plugin B (occupies slash trigger `dxdupe`).
    const dirA = join(dataDir, 'plugins', 'dx-a')
    writeMinimalPlugin(join(dataDir, 'plugins'), 'dx-a')
    writeSlashPlugin(join(dataDir, 'plugins'), 'dx-b', 'dxdupe')
    app = await createApp(dataDir)
    await app.kernel.plugins.enable('dx-a')
    await app.kernel.plugins.enable('dx-b')

    // Old instance works.
    const v1 = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(v1.value, 'v1')

    // New code passes doctor (no B in sandbox), but fails enable due to slash collision with B.
    const original = readFileSync(join(dirA, 'index.ts'), 'utf8')
    // Rename original `definePlugin` to `baseDefine` and wrap with conflicting slash command.
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
    assert.notEqual(injected, original, 'injection should modify source (fail loudly if template mismatches)')
    writeFileSync(join(dirA, 'index.ts'), injected)

    await assert.rejects(
      app.kernel.plugins.reloadExternalPlugin('dx-a'),
      (err: unknown) => {
        assert.ok(err instanceof HostHelmError, `should throw HelmError: ${String(err)}`)
        assert.equal(err.code, 'plugin_reload_failed')
        const details = err.details as { rolledBack?: boolean }
        assert.equal(details?.rolledBack, true, 'should roll back to previous instance on switchover failure')
        return true
      },
    )

    // After rollback: plugin stays listed & enabled, old instance continues serving.
    assert.equal(app.kernel.plugins.list().find((p) => p.id === 'dx-a')?.enabled, true, 'stays enabled after rollback')
    const probe = (await app.kernel.plugins.invokeAction('dx-a', 'probe', {})) as { value: string }
    assert.equal(probe.value, 'v1', 'old instance continues serving after rollback')

    // Restoring non-conflicting code lets reload succeed.
    writeFileSync(join(dirA, 'index.ts'), original)
    const result = await app.kernel.plugins.reloadExternalPlugin('dx-a')
    assert.equal(result.summary.enabled, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/** Plugin declaring a `commandPalette` slash command (for cross-plugin uniqueness collision tests). */
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
