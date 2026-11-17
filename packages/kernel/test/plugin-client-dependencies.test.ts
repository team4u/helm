/**
 * Contract tests for managed frontend npm dependencies (`clientDependencies`) in external plugins:
 * - Manifest parsing: merges and deduplicates `plugin.json` clientDependencies and `package.json`
 *   helm.clientDependencies; rejects invalid specifiers (relative/absolute paths, `..` segments,
 *   non-strings) with plugin_manifest_invalid;
 * - normalizeDefinition: maps manifest specifiers to npmDependencies (resolved from plugin root dir)
 *   and strips any npmDependencies declared directly in code (blocking arbitrary resolution);
 * - assertExternalDefinition display-copy name: LocalizedText rule at the import
 *   boundary (pure-function drive, no fixture files — see test comment);
 * - Inter-plugin dependencies manifest (`plugin.json` dependencies / `package.json` helm.dependencies)
 *   merges into definition; top-level npm `package.json` dependencies are never misread as plugin deps;
 * - Real compilation pipeline: declared specifiers resolve into bundle from plugin node_modules;
 *   undeclared bare imports reject explicitly; declared-but-uninstalled modules emit clear diagnostics;
 * - doctor runs the same compiler resolution path end-to-end (client check carries managed npmRoots);
 * - Managed install: installRuntimeDeps installs manifest frontend deps (`--no-save` without
 *   modifying package.json), taking declared version ranges from package.json first.
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HelmError, clientNpmRootsOf } from '@helm/protocol'
import {
  buildPluginClientBundleDir,
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
  createPluginBuildProvider,
} from '@helm/plugin-build'
import {
  assertExternalDefinition,
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
} from '../src/plugins/external-loader.js'
import { readHelmClientDependencies } from '../src/plugins/plugin-manifest.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'
import { PluginPackageManager, type PackageRunner } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import { cleanupDir, makePluginSummary, makeTempDir, useTempDir } from './helpers.js'

let workDir: string

beforeEach(async () => {
  workDir = await makeTempDir('helm-client-deps-')
})

afterEach(async () => {
  await cleanupDir(workDir)
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Scaffolds a realistic external plugin directory with frontend dependencies (unique dir name keeps parallel fixtures isolated). */
function makePluginDir(options: { name?: string; clientDeps?: string[]; installLib?: boolean } = {}): string {
  const dir = join(workDir, options.name ?? 'chart-plugin')
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeJson(join(dir, 'plugin.json'), {
    id: 'chart-plugin',
    version: '1.0.0',
    main: 'index.ts',
    clientRoot: './client',
    ...(options.clientDeps !== undefined ? { clientDependencies: options.clientDeps } : {}),
  })
  writeFileSync(
    join(dir, 'index.ts'),
    `export default {
  id: 'chart-plugin',
  version: '1.0.0',
  definePlugin(ctx) {
    ctx.ui.workbenchPanel({
      id: 'chart-panel',
      label: 'Chart Panel',
      client: { module: 'index.tsx', export: 'ChartPanel' },
    })
  },
}
`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'client', 'index.tsx'),
    `import { makeLabel } from 'fake-chart-lib'
export function ChartPanel() {
  return makeLabel('panel')
}
`,
    'utf8',
  )
  if (options.installLib !== false) installFakeLib(dir)
  return dir
}

/** Installs fake npm package `fake-chart-lib` (ESM entry) inside the plugin's node_modules. */
function installFakeLib(dir: string): void {
  const libDir = join(dir, 'node_modules', 'fake-chart-lib')
  mkdirSync(libDir, { recursive: true })
  writeJson(join(libDir, 'package.json'), {
    name: 'fake-chart-lib',
    version: '9.9.9',
    main: 'index.js',
    type: 'module',
  })
  writeFileSync(
    join(libDir, 'index.js'),
    `export function makeLabel(x) { return 'fake-chart:' + x }
`,
    'utf8',
  )
}

async function importNormalized(dir: string) {
  const entry = await resolvePluginEntry(dir)
  assert.ok(entry, 'plugin entry should resolve')
  return normalizeDefinition(await importPluginDefinition(dir, entry), dir)
}

function throwsCode(fn: () => unknown, code: string): HelmError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `expected HelmError, got ${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

// ---------------------------------------------------------------------------
// Manifest parsing and normalization
// ---------------------------------------------------------------------------

test('plugin.json and package.json helm.clientDependencies merge and deduplicate; invalid specifiers reject explicitly', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  writeJson(join(dir, 'package.json'), {
    name: 'chart-plugin-pkg',
    helm: { clientDependencies: ['fake-chart-lib', 'other-lib'] },
  })
  assert.deepEqual(readHelmClientDependencies(dir), ['fake-chart-lib', 'other-lib'])

  const bad = makePluginDir({ clientDeps: ['../escape'] })
  throwsCode(() => readHelmClientDependencies(bad), 'plugin_manifest_invalid')
  const badAbs = makePluginDir({ clientDeps: ['/abs/path'] })
  throwsCode(() => readHelmClientDependencies(badAbs), 'plugin_manifest_invalid')

  const badPkg = makePluginDir()
  writeJson(join(badPkg, 'package.json'), { name: 'x', helm: { clientDependencies: [42] } })
  throwsCode(() => readHelmClientDependencies(badPkg), 'plugin_manifest_invalid')

  const badName = makePluginDir({ clientDeps: ['foo:bar'] })
  throwsCode(() => readHelmClientDependencies(badName), 'plugin_manifest_invalid')
})

test('normalizeDefinition maps manifest specifiers to npmDependencies (plugin dir) and strips code-level declarations', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  const entry = await resolvePluginEntry(dir)
  assert.ok(entry)
  const raw = await importPluginDefinition(dir, entry)
  // Code-injected/self-declared npmDependencies pointing elsewhere must be stripped.
  const withCodeDeps = { ...raw, npmDependencies: { react: '/usr/share/evil' } }
  const normalized = normalizeDefinition(withCodeDeps, dir)
  assert.deepEqual(normalized.npmDependencies, { 'fake-chart-lib': dir })
  assert.equal(normalized.clientRoot, join(dir, 'client'))

  assert.throws(
    () => normalizeDefinition({ ...raw, dependencies: 'not-an-array' as unknown as string[] }, dir),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
})

test('inter-plugin dependencies: manifest declarations merge into definition; top-level package.json dependencies are ignored', { timeout: 60_000 }, async () => {
  const dir = makePluginDir()
  writeJson(join(dir, 'package.json'), {
    name: 'chart-plugin-pkg',
    dependencies: { 'some-runtime-lib': '^1.0.0' },
    helm: { dependencies: ['builtin:profile', 'another-plugin'] },
  })
  const normalized = await importNormalized(dir)
  // npm top-level dependencies must never enter plugin dependencies; helm.dependencies does.
  assert.deepEqual(normalized.dependencies, ['builtin:profile', 'another-plugin'])

  // plugin.json dependencies parses identically and deduplicates when merged with code declarations.
  writeJson(join(dir, 'plugin.json'), {
    id: 'chart-plugin',
    main: 'index.ts',
    clientRoot: './client',
    dependencies: ['dep-a', 'dep-b'],
  })
  const entry2 = await resolvePluginEntry(dir)
  assert.ok(entry2)
  const raw2 = await importPluginDefinition(dir, entry2)
  const merged = normalizeDefinition({ ...raw2, dependencies: ['dep-a', 'code-dep'] }, dir)
  assert.deepEqual(merged.dependencies, ['dep-a', 'code-dep', 'dep-b', 'builtin:profile', 'another-plugin'])

  // Invalid plugin ID (e.g. npm version specifiers) rejects cleanly on manifest read instead of ignoring silently.
  writeJson(join(dir, 'plugin.json'), {
    id: 'chart-plugin',
    main: 'index.ts',
    dependencies: ['dep@^1.0.0'],
  })
  await assert.rejects(
    importNormalized(dir),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_manifest_invalid',
  )
})

test('assertExternalDefinition: display-copy name follows the LocalizedText rule at the import boundary', { timeout: 60_000 }, () => {
  // Pure-function drive on purpose: real module imports in this file share the
  // process-wide ESM cache (per-test workDirs differ, but same-name fixtures would
  // collide), so shape validation is asserted directly without fixture files.
  const base = { id: 'chart-plugin', definePlugin: () => {} };

  // Optional: omitting name keeps the minimal definition valid (same right as builtin plugins)
  const unnamed = assertExternalDefinition(base, '/ws/chart-plugin')
  assert.equal('name' in unnamed, false)

  // Valid display copy passes through raw: plain string and supported-locale map
  assert.deepEqual(
    assertExternalDefinition({ ...base, name: 'Chart' }, '/ws/chart-plugin').name,
    'Chart',
  )
  assert.deepEqual(
    assertExternalDefinition({ ...base, name: { en: 'Chart', 'zh-CN': '图表' } }, '/ws/chart-plugin').name,
    { en: 'Chart', 'zh-CN': '图表' },
  )

  // Invalid display copy rejected at the import boundary with the shared rule
  for (const value of ['', '   ', 42, true, null, [], {}, { fr: 'x' }, { 'zh-cn': 'x' }, { en: 1 }, { en: '' }, { en: 'Hi', 'zh-CN': ' ' }]) {
    assert.throws(
      () => assertExternalDefinition({ ...base, name: value }, '/ws/chart-plugin'),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'invalid_plugin_definition' &&
        err.message.includes('name provide when must be display copy'),
      `expected rejection for name=${JSON.stringify(value)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Real compile pipeline
// ---------------------------------------------------------------------------

test('compile pipeline: bundles declared specifiers from plugin node_modules; rejects undeclared imports; diagnoses uninstalled', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  const normalized = await importNormalized(dir)
  const npmRoots = clientNpmRootsOf(normalized.npmDependencies)
  assert.deepEqual(npmRoots, [{ packageRoot: dir, specifiers: ['fake-chart-lib'] }])

  const cacheDir = join(workDir, 'cache')
  const compiled = await compilePluginClientModule(
    'chart-plugin',
    normalized.clientRoot!,
    'index.tsx',
    cacheDir,
    { npmRoots },
  )
  assert.ok(compiled.code.includes('fake-chart:'))
  assert.ok(compiled.exports.includes('ChartPanel'))

  // Undeclared bare dependency (roots omitted) rejects explicitly.
  await assert.rejects(
    compilePluginClientModule('chart-plugin', normalized.clientRoot!, 'index.tsx', join(workDir, 'cache2')),
    (err: unknown) =>
      err instanceof HelmError && err.code === 'client_compile_failed' && err.message.includes('reject bare dependency'),
  )

  // Declared yet uninstalled: diagnostic points clearly to resolution/install failure rather than misreporting as undeclared.
  const noLibDir = makePluginDir({ name: 'chart-plugin-missing-lib', clientDeps: ['fake-chart-lib'], installLib: false })
  const noLibNormalized = await importNormalized(noLibDir)
  await assert.rejects(
    compilePluginClientModule(
      'chart-plugin',
      noLibNormalized.clientRoot!,
      'index.tsx',
      join(workDir, 'cache3'),
      { npmRoots: clientNpmRootsOf(noLibNormalized.npmDependencies) },
    ),
    (err: unknown) =>
      err instanceof HelmError &&
      err.code === 'client_compile_failed' &&
      err.message.includes('cannot parse') &&
      err.message.includes('not installed'),
  )
})

test('disk cache reuses across memory isolation boundary and invalidates stale bundles when client deps change', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  const normalized = await importNormalized(dir)
  const roots = clientNpmRootsOf(normalized.npmDependencies)
  const cacheDir = join(workDir, 'cache-disk')
  const first = await compilePluginClientModule(
    'chart-plugin',
    normalized.clientRoot!,
    'index.tsx',
    cacheDir,
    { npmRoots: roots },
  )
  assert.ok(first.code.includes('fake-chart:'))

  clearClientCompilerMemoryCache()
  const second = await compilePluginClientModule(
    'chart-plugin',
    normalized.clientRoot!,
    'index.tsx',
    cacheDir,
    { npmRoots: roots },
  )
  assert.equal(second.contentHash, first.contentHash)

  clearClientCompilerMemoryCache()
  await assert.rejects(
    compilePluginClientModule(
      'chart-plugin',
      normalized.clientRoot!,
      'index.tsx',
      cacheDir,
    ),
    (err: unknown) =>
      err instanceof HelmError &&
      err.code === 'client_compile_failed' &&
      err.message.includes('reject bare dependency'),
    'removing clientDependencies declaration must not fall back to stale disk cache bundle',
  )
})

test('doctor uses production compiler path end-to-end: passes when ready, fails structurally on client check when missing', { timeout: 60_000 }, async () => {
  const okDir = makePluginDir({ name: 'chart-plugin-ok', clientDeps: ['fake-chart-lib'] })
  await importNormalized(okDir) // warm module cache (doctor uses isolated loader, mutually independent)
  const report = await doctorPluginDir(okDir, { buildProvider: createPluginBuildProvider() })
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
  assert.equal(report.pluginId, 'chart-plugin')

  const missingDir = makePluginDir({ name: 'chart-plugin-no-lib', clientDeps: ['fake-chart-lib'], installLib: false })
  const missingReport = await doctorPluginDir(missingDir, { buildProvider: createPluginBuildProvider() })
  assert.equal(missingReport.ok, false)
  const clientCheck = missingReport.checks.find((c) => c.id === 'client')
  assert.ok(clientCheck?.error)
  assert.ok(clientCheck.error.message.includes('cannot parse'), clientCheck.error.message)
})

// ---------------------------------------------------------------------------
// Managed install: installing declared frontend deps
// ---------------------------------------------------------------------------

interface NpmCall {
  cmd: string
  args: string[]
  cwd: string
}

function makeTestPackageManager(dataDir: string, pluginId: string, runner: PackageRunner): PluginPackageManager {
  return new PluginPackageManager({
    dataDir,
    cwd: workDir,
    store: new PluginPackageManagerStore(new ConfigService(dataDir)),
    host: {
      async registerManagedPlugin() {
        return { summary: makePluginSummary({ id: pluginId, name: 'x', enabled: false }), pluginId }
      },
      async enableManagedPlugin() {
        throw new HelmError('unused', 'this test does not enable', 500)
      },
      assertManagedPluginUpdateSafe() {},
      async updateManagedPlugin() {
        return { summary: makePluginSummary({ id: pluginId, name: 'x', enabled: false }) }
      },
      async removeManagedPlugin() {
        return { wasEnabled: false }
      },
      async purgePluginPersistentData() {},
      listSummaries: () => [],
    },
    runner,
  })
}

test('managed install installs declared frontend deps with --no-save using package.json ranges; preserves default cmd otherwise', { timeout: 60_000 }, async (t) => {
  const calls: NpmCall[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    return { code: 0, stdout: '', stderr: '' }
  }
  const dataDir = useTempDir(t, 'helm-pkg-client-deps-')
  const srcDir = join(workDir, 'src-plugin')
  mkdirSync(srcDir)
  writeJson(join(srcDir, 'plugin.json'), { id: 'managed-client-dep', main: 'index.ts' })
  writeFileSync(
    join(srcDir, 'index.ts'),
    `export default { id: 'managed-client-dep', definePlugin() {} }
`,
    'utf8',
  )
  writeJson(join(srcDir, 'package.json'), {
    name: 'managed-client-dep',
    version: '1.0.0',
    dependencies: { 'runtime-lib': '^1.0.0' },
    devDependencies: { 'client-chart': '^4.2.0' },
    helm: { clientDependencies: ['client-chart', 'client-extra/subpath'] },
  })

  const manager = makeTestPackageManager(dataDir, 'managed-client-dep', runner)
  const result = await manager.install(srcDir)
  assert.equal(result.record.pluginId, 'managed-client-dep')
  const installCall = calls.find((c) => c.args[0] === 'install')
  assert.ok(installCall, 'should invoke npm install')
  assert.ok(installCall.args.includes('--no-save'), 'frontend dependency install must not mutate package.json')
  assert.ok(installCall.args.includes('client-chart@^4.2.0'), 'version range prefers declaration from package.json')
  assert.ok(installCall.args.includes('client-extra'), 'subpath specifier installs by package name rather than subpath string')
})

test('without frontend dependency declaration, install keeps original command (--omit=dev, no --no-save/specifiers)', { timeout: 60_000 }, async (t) => {
  const calls: NpmCall[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    return { code: 0, stdout: '', stderr: '' }
  }
  const dataDir = useTempDir(t, 'helm-pkg-plain-')
  const srcDir = join(workDir, 'plain-plugin')
  mkdirSync(srcDir)
  writeJson(join(srcDir, 'plugin.json'), { id: 'plain-plugin', main: 'index.ts' })
  writeFileSync(join(srcDir, 'index.ts'), `export default { id: 'plain-plugin', definePlugin() {} }\n`, 'utf8')
  writeJson(join(srcDir, 'package.json'), { name: 'plain-plugin', dependencies: { leftmost: '^1.0.0' } })

  const manager = makeTestPackageManager(dataDir, 'plain-plugin', runner)
  await manager.install(srcDir)
  const installCall = calls.find((c) => c.args[0] === 'install')
  assert.ok(installCall)
  assert.ok(installCall.args.includes('--omit=dev'))
  assert.equal(installCall.args.includes('--no-save'), false)
  assert.equal(installCall.args.some((a) => a.startsWith('leftmost')), false)
})

test('managed install with valid prebuilt dist-client skips clientDependencies (both without and with backend dependencies)', { timeout: 60_000 }, async (t) => {
  const buildPluginWithPrebuilt = async (name: string, backendDeps?: Record<string, string>): Promise<string> => {
    const srcDir = join(workDir, name)
    mkdirSync(join(srcDir, 'client'), { recursive: true })
    writeJson(join(srcDir, 'plugin.json'), {
      id: name,
      main: 'index.ts',
      clientDependencies: ['heavy-chart', 'extra-widget/subpath'],
    })
    writeJson(join(srcDir, 'package.json'), {
      name,
      version: '1.0.0',
      ...(backendDeps ? { dependencies: backendDeps } : {}),
      devDependencies: { 'heavy-chart': '^12.0.0' },
      helm: { clientDependencies: ['heavy-chart', 'extra-widget/subpath'] },
    })
    writeFileSync(
      join(srcDir, 'index.ts'),
      `export default {
  id: '${name}',
  definePlugin(ctx) {
    ctx.ui.screen({ id: 'home', title: 'Home', client: { module: 'index.tsx', export: 'HomeScreen' } })
  },
}
`,
      'utf8',
    )
    writeFileSync(join(srcDir, 'client', 'index.tsx'), `export function HomeScreen() { return null }\n`, 'utf8')
    await buildPluginClientBundleDir({
      pluginId: name,
      clientRoot: join(srcDir, 'client'),
      outDir: join(srcDir, 'dist-client'),
    })
    return srcDir
  }

  // 1. Prebuilt + devDependencies/clientDependencies only (no backend runtime dependencies): skips npm install completely.
  {
    const calls: NpmCall[] = []
    const runner: PackageRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd })
      return { code: 0, stdout: '', stderr: '' }
    }
    const dataDir = useTempDir(t, 'helm-pkg-prebuilt-only-')
    const srcDir = await buildPluginWithPrebuilt('prebuilt-frontend-only')
    const manager = makeTestPackageManager(dataDir, 'prebuilt-frontend-only', runner)
    const result = await manager.install(srcDir)
    assert.equal(result.record.pluginId, 'prebuilt-frontend-only')
    assert.equal(calls.length, 0, 'prebuilt plugin with no backend runtime deps must not invoke npm install')
  }

  // 2. Prebuilt + backend dependencies: runs npm --omit=dev only, skipping clientDependencies (--no-save / specifiers).
  {
    const calls: NpmCall[] = []
    const runner: PackageRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd })
      return { code: 0, stdout: '', stderr: '' }
    }
    const dataDir = useTempDir(t, 'helm-pkg-prebuilt-backend-')
    const srcDir = await buildPluginWithPrebuilt('prebuilt-with-backend-deps', { 'backend-sdk': '^2.0.0' })
    const manager = makeTestPackageManager(dataDir, 'prebuilt-with-backend-deps', runner)
    const result = await manager.install(srcDir)
    assert.equal(result.record.pluginId, 'prebuilt-with-backend-deps')
    assert.equal(calls.length, 1, 'should invoke npm install once for backend runtime dependencies')
    assert.ok(calls[0]!.args.includes('--omit=dev'))
    assert.equal(calls[0]!.args.includes('--no-save'), false)
    assert.equal(calls[0]!.args.some((a) => a.includes('heavy-chart') || a.includes('extra-widget')), false)
  }
})

test('managed install rejects corrupt prebuilt dist-client explicitly without silently falling back to clientDependencies', { timeout: 60_000 }, async (t) => {
  const calls: NpmCall[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    return { code: 0, stdout: '', stderr: '' }
  }
  const dataDir = useTempDir(t, 'helm-pkg-prebuilt-corrupt-')
  const srcDir = join(workDir, 'corrupt-prebuilt-plugin')
  mkdirSync(join(srcDir, 'dist-client'), { recursive: true })
  writeJson(join(srcDir, 'plugin.json'), {
    id: 'corrupt-prebuilt-plugin',
    main: 'index.ts',
    clientDependencies: ['heavy-chart'],
  })
  writeFileSync(join(srcDir, 'index.ts'), `export default { id: 'corrupt-prebuilt-plugin', definePlugin() {} }\n`, 'utf8')
  // Intentionally leave dist-client/ without manifest.json

  const manager = makeTestPackageManager(dataDir, 'corrupt-prebuilt-plugin', runner)
  await assert.rejects(
    manager.install(srcDir),
    (err: unknown) => err instanceof HelmError && err.code === 'prebuilt_client_invalid',
  )
  assert.equal(calls.length, 0, 'corrupt prebuilt bundle must reject before invoking npm install')
})
