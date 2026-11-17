/**
 * external plugin frontend subject to control npm dependency (clientDependencies) contract test:
 * - manifest parse:plugin.json clientDependencies and package.json helm.clientDependencies
 *   merge dedupe; illegal note symbol (each other for/absolute path,.. segment, non- string) explicit plugin_manifest_invalid;
 * - normalizeDefinition: manifest note symbol mapping is npmDependencies(parse = plugin itself directory),
 *   code inside declaration npmDependencies one rule strip (do not put open any parse);
 * - assertExternalDefinition display-copy name: LocalizedText rule at the import
 *   boundary (pure-function drive, no fixture files — see test comment);
 * - plugin between dependency manifest (plugin.json dependencies / package.json helm.dependencies)
 *   merge enter define;package.json top-level dependencies(npm semantics) never mistakenly read;
 * - real compile chain: declaration note symbol can from plugin directory node_modules parse enter bundle;
 *   not declaration bare dependency explicit reject; already declaration but not installed to out can diagnose error;
 * - doctor all chain and produce the same compile opening path (client check carries subject to control npm roots);
 * - managed install:installRuntimeDeps patch install manifest declaration frontend dependency (--no-save, do not
 *   package.json), version takes precedence take package.json already declaration range.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HelmError, clientNpmRootsOf } from '@helm/protocol'
import { clearClientCompilerMemoryCache, compilePluginClientModule, createPluginBuildProvider } from '@helm/plugin-build'
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

/** install match a carries frontend dependency real external plugin directory (name control directory name, convenient at many directory mutual do not interference). */
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
      label: 'diagram table',
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

/** in plugin directory inside install false npm package fake-chart-lib(ESM entry). */
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
  assert.ok(entry, 'entry should can parse')
  return normalizeDefinition(await importPluginDefinition(dir, entry), dir)
}

function throwsCode(fn: () => unknown, code: string): HelmError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `expectation HelmError, actual:${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

// ---------------------------------------------------------------------------
// manifest parse and archive one
// ---------------------------------------------------------------------------

test('plugin.json and package.json helm.clientDependencies merge dedupe; illegal note symbol explicit reject', { timeout: 60_000 }, async () => {
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

test('normalizeDefinition: manifest note symbol mapping npmDependencies(parse = plugin directory), code inside declaration strip', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  const entry = await resolvePluginEntry(dir)
  assert.ok(entry)
  const raw = await importPluginDefinition(dir, entry)
  // code inside malicious/self carries npmDependencies(points to any) must by strip.
  const withCodeDeps = { ...raw, npmDependencies: { react: '/usr/share/evil' } }
  const normalized = normalizeDefinition(withCodeDeps, dir)
  assert.deepEqual(normalized.npmDependencies, { 'fake-chart-lib': dir })
  assert.equal(normalized.clientRoot, join(dir, 'client'))

  assert.throws(
    () => normalizeDefinition({ ...raw, dependencies: 'not-an-array' as unknown as string[] }, dir),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
})

test('plugin between dependency: manifest declaration merge enter define;package.json top-level dependencies do not mistakenly read', { timeout: 60_000 }, async () => {
  const dir = makePluginDir()
  writeJson(join(dir, 'package.json'), {
    name: 'chart-plugin-pkg',
    dependencies: { 'some-runtime-lib': '^1.0.0' },
    helm: { dependencies: ['builtin:profile', 'another-plugin'] },
  })
  const normalized = await importNormalized(dir)
  // npm semantics top-level dependencies never enter plugin dependency;helm.dependencies enter.
  assert.deepEqual(normalized.dependencies, ['builtin:profile', 'another-plugin'])

  // plugin.json dependencies same parse, and and code declaration merge dedupe.
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

  // illegal plugin ID(such as npm version note symbol) in manifest read where explicit reject, not silently ignore.
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

  // optional: omitting name keeps the minimal definition valid (same right as builtin plugins)
  const unnamed = assertExternalDefinition(base, '/ws/chart-plugin')
  assert.equal('name' in unnamed, false)

  // valid display copy passes through raw: plain string and supported-locale map
  assert.deepEqual(
    assertExternalDefinition({ ...base, name: 'Chart' }, '/ws/chart-plugin').name,
    'Chart',
  )
  assert.deepEqual(
    assertExternalDefinition({ ...base, name: { en: 'Chart', 'zh-CN': '图表' } }, '/ws/chart-plugin').name,
    { en: 'Chart', 'zh-CN': '图表' },
  )

  // invalid display copy rejected at the import boundary with the shared rule
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
// real compile chain
// ---------------------------------------------------------------------------

test('compile chain: declaration note symbol from plugin directory node_modules parse enter bundle; not declaration reject; not installed can diagnose', { timeout: 60_000 }, async () => {
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

  // not declaration bare dependency (remove roots) explicit reject.
  await assert.rejects(
    compilePluginClientModule('chart-plugin', normalized.clientRoot!, 'index.tsx', join(workDir, 'cache2')),
    (err: unknown) =>
      err instanceof HelmError && err.code === 'client_compile_failed' && err.message.includes('reject bare dependency'),
  )

  // already declaration but not installed: error explicit points to cannot parse/not installed, do not mistakenly lead is not declaration.
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

test('disk cache across memory proxy boundary re- use, and frontend dependency declaration change make old bundle expires', { timeout: 60_000 }, async () => {
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
    'undo clientDependencies declaration must not back put old disk bundle',
  )
})

test('doctor all chain and produce the same compile opening path: dependency ready ok, missing when client check structure failed', { timeout: 60_000 }, async () => {
  const okDir = makePluginDir({ name: 'chart-plugin-ok', clientDeps: ['fake-chart-lib'] })
  await importNormalized(okDir) // warm up module cache (doctor use new proxy boundary import, mutual does not affect)
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
// managed install: frontend dependency patch install
// ---------------------------------------------------------------------------

interface NpmCall {
  cmd: string
  args: string[]
  cwd: string
}

test('managed install patch install manifest frontend dependency:--no-save, version take already declaration range; without declaration when along use original command', { timeout: 60_000 }, async (t) => {
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

  const manager = new PluginPackageManager({
    dataDir,
    cwd: workDir,
    store: new PluginPackageManagerStore(new ConfigService(dataDir)),
    host: {
      async registerManagedPlugin() {
        return { summary: makePluginSummary({ id: 'managed-client-dep', name: 'x', enabled: false }), pluginId: 'managed-client-dep' }
      },
      async enableManagedPlugin() {
        throw new HelmError('unused', 'this test does not enable', 500)
      },
      assertManagedPluginUpdateSafe() {},
      async updateManagedPlugin() {
        return { summary: makePluginSummary({ id: 'managed-client-dep', name: 'x', enabled: false }) }
      },
      async removeManagedPlugin() {
        return { wasEnabled: false }
      },
      async purgePluginPersistentData() {},
      listSummaries: () => [],
    },
    runner,
  })
  const result = await manager.install(srcDir)
  assert.equal(result.record.pluginId, 'managed-client-dep')
  const installCall = calls.find((c) => c.args[0] === 'install')
  assert.ok(installCall, 'should has npm install invoke')
  assert.ok(installCall.args.includes('--no-save'), 'frontend dependency patch install must not change write package.json')
  assert.ok(installCall.args.includes('client-chart@^4.2.0'), 'version take package.json already declaration range')
  assert.ok(installCall.args.includes('client-extra'), 'sub- path note symbol by package name patch install, does not sub- path when npm package name')
})

test('without frontend dependency declaration when install command keep original (--omit=dev, without --no-save/note symbol)', { timeout: 60_000 }, async (t) => {
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

  const manager = new PluginPackageManager({
    dataDir,
    cwd: workDir,
    store: new PluginPackageManagerStore(new ConfigService(dataDir)),
    host: {
      async registerManagedPlugin() {
        return { summary: makePluginSummary({ id: 'plain-plugin', name: 'x', enabled: false }), pluginId: 'plain-plugin' }
      },
      async enableManagedPlugin() {
        throw new HelmError('unused', 'this test does not enable', 500)
      },
      assertManagedPluginUpdateSafe() {},
      async updateManagedPlugin() {
        return { summary: makePluginSummary({ id: 'plain-plugin', name: 'x', enabled: false }) }
      },
      async removeManagedPlugin() {
        return { wasEnabled: false }
      },
      async purgePluginPersistentData() {},
      listSummaries: () => [],
    },
    runner,
  })
  await manager.install(srcDir)
  const installCall = calls.find((c) => c.args[0] === 'install')
  assert.ok(installCall)
  assert.ok(installCall.args.includes('--omit=dev'))
  assert.equal(installCall.args.includes('--no-save'), false)
  assert.equal(installCall.args.some((a) => a.startsWith('leftmost')), false)
})
