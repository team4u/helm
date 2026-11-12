/**
 * 外部插件前端受控 npm 依赖（clientDependencies）契约测试：
 * - 清单解析：plugin.json clientDependencies 与 package.json helm.clientDependencies
 *   合并去重；非法说明符（相对/绝对路径、.. 段、非字符串）显式 plugin_manifest_invalid；
 * - normalizeDefinition：清单说明符映射为 npmDependencies（解析根 = 插件自身目录），
 *   代码内声明的 npmDependencies 一律剥离（不放开任意解析根）；
 * - 插件间依赖清单（plugin.json dependencies / package.json helm.dependencies）
 *   合并进入定义；package.json 顶层 dependencies（npm 语义）绝不误读；
 * - 真实编译链：声明的说明符可从插件目录 node_modules 解析进 bundle；
 *   未声明裸依赖显式拒绝；已声明但未安装给出可诊断错误；
 * - doctor 全链与生产同一编译口径（client 检查带受控 npm roots）；
 * - 受管安装：installRuntimeDeps 补装清单声明的前端依赖（--no-save，不落
 *   package.json），版本优先取 package.json 已声明 range。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, rmSync as rmSyncFn } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError } from '@helm/protocol'
import {
  importPluginDefinition,
  normalizeDefinition,
  readHelmClientDependencies,
  resolvePluginEntry,
} from '../src/plugins/external-loader.js'
import {
  clientNpmRootsOf,
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
} from '../src/plugins/client-compiler.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'
import { PluginPackageManager, type PackageRunner } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'helm-client-deps-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 装配一个带前端依赖的真实外部插件目录（name 控制目录名，便于多目录互不干扰）。 */
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
      label: '图表',
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

/** 在插件目录内安装假 npm 包 fake-chart-lib（ESM 入口）。 */
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
  assert.ok(entry, '入口应可解析')
  return normalizeDefinition(await importPluginDefinition(dir, entry), dir)
}

function throwsCode(fn: () => unknown, code: string): HelmError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof HelmError, `期望 HelmError，实际：${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

// ---------------------------------------------------------------------------
// 清单解析与归一化
// ---------------------------------------------------------------------------

test('plugin.json 与 package.json helm.clientDependencies 合并去重；非法说明符显式拒绝', { timeout: 60_000 }, async () => {
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

test('normalizeDefinition：清单说明符映射 npmDependencies（解析根 = 插件目录），代码内声明剥离', { timeout: 60_000 }, async () => {
  const dir = makePluginDir({ clientDeps: ['fake-chart-lib'] })
  const entry = await resolvePluginEntry(dir)
  assert.ok(entry)
  const raw = await importPluginDefinition(dir, entry)
  // 代码内恶意/自带的 npmDependencies（指向任意根）必须被剥离。
  const withCodeDeps = { ...raw, npmDependencies: { react: '/usr/share/evil' } }
  const normalized = normalizeDefinition(withCodeDeps, dir)
  assert.deepEqual(normalized.npmDependencies, { 'fake-chart-lib': dir })
  assert.equal(normalized.clientRoot, join(dir, 'client'))

  assert.throws(
    () => normalizeDefinition({ ...raw, dependencies: 'not-an-array' as unknown as string[] }, dir),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
})

test('插件间依赖：清单声明合并进入定义；package.json 顶层 dependencies 不误读', { timeout: 60_000 }, async () => {
  const dir = makePluginDir()
  writeJson(join(dir, 'package.json'), {
    name: 'chart-plugin-pkg',
    dependencies: { 'some-runtime-lib': '^1.0.0' },
    helm: { dependencies: ['builtin:profile', 'another-plugin'] },
  })
  const normalized = await importNormalized(dir)
  // npm 语义的顶层 dependencies 绝不进入插件依赖；helm.dependencies 进入。
  assert.deepEqual(normalized.dependencies, ['builtin:profile', 'another-plugin'])

  // plugin.json dependencies 同样解析，且与代码声明合并去重。
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

  // 非法插件 ID（如 npm 版本说明符）在清单读取处显式拒绝，不静默忽略。
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

// ---------------------------------------------------------------------------
// 真实编译链
// ---------------------------------------------------------------------------

test('编译链：声明说明符从插件目录 node_modules 解析进 bundle；未声明拒绝；未安装可诊断', { timeout: 60_000 }, async () => {
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

  // 未声明裸依赖（去掉 roots）显式拒绝。
  await assert.rejects(
    compilePluginClientModule('chart-plugin', normalized.clientRoot!, 'index.tsx', join(workDir, 'cache2')),
    (err: unknown) =>
      err instanceof HelmError && err.code === 'client_compile_failed' && err.message.includes('拒绝裸依赖'),
  )

  // 已声明但未安装：错误明确指向「不可解析/未安装」，不误导为未声明。
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
      err.message.includes('不可解析') &&
      err.message.includes('未安装'),
  )
})

test('磁盘缓存跨内存代际复用，且前端依赖声明变更使旧 bundle 失效', { timeout: 60_000 }, async () => {
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
      err.message.includes('拒绝裸依赖'),
    '撤销 clientDependencies 声明不得回放旧磁盘 bundle',
  )
})

test('doctor 全链与生产同一编译口径：依赖就绪 ok，缺失时 client 检查结构化失败', { timeout: 60_000 }, async () => {
  const okDir = makePluginDir({ name: 'chart-plugin-ok', clientDeps: ['fake-chart-lib'] })
  await importNormalized(okDir) // 预热模块缓存（doctor 用新代际导入，互不影响）
  const report = await doctorPluginDir(okDir)
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2))
  assert.equal(report.pluginId, 'chart-plugin')

  const missingDir = makePluginDir({ name: 'chart-plugin-no-lib', clientDeps: ['fake-chart-lib'], installLib: false })
  const missingReport = await doctorPluginDir(missingDir)
  assert.equal(missingReport.ok, false)
  const clientCheck = missingReport.checks.find((c) => c.id === 'client')
  assert.ok(clientCheck?.error)
  assert.ok(clientCheck.error.message.includes('不可解析'), clientCheck.error.message)
})

// ---------------------------------------------------------------------------
// 受管安装：前端依赖补装
// ---------------------------------------------------------------------------

interface NpmCall {
  cmd: string
  args: string[]
  cwd: string
}

test('受管安装补装清单前端依赖：--no-save、版本取已声明 range；无声明时沿用原命令', { timeout: 60_000 }, async () => {
  const calls: NpmCall[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    return { code: 0, stdout: '', stderr: '' }
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-client-deps-'))
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
      async registerManagedPlugin(dir) {
        return { summary: { id: 'managed-client-dep', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }, pluginId: 'managed-client-dep' }
      },
      async enableManagedPlugin() {
        throw new HelmError('unused', '本测试不启用', 500)
      },
      assertManagedPluginUpdateSafe() {},
      async updateManagedPlugin() {
        return { summary: { id: 'managed-client-dep', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] } }
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
  assert.ok(installCall, '应有 npm install 调用')
  assert.ok(installCall.args.includes('--no-save'), '前端依赖补装不得改写 package.json')
  assert.ok(installCall.args.includes('client-chart@^4.2.0'), '版本取 package.json 已声明 range')
  assert.ok(installCall.args.includes('client-extra'), '子路径说明符按包名补装，不把子路径当 npm 包名')
  rmSyncFn(dataDir, { recursive: true, force: true })
})

test('无前端依赖声明时安装命令保持原样（--omit=dev，无 --no-save/说明符）', { timeout: 60_000 }, async () => {
  const calls: NpmCall[] = []
  const runner: PackageRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    return { code: 0, stdout: '', stderr: '' }
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-plain-'))
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
        return { summary: { id: 'plain-plugin', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }, pluginId: 'plain-plugin' }
      },
      async enableManagedPlugin() {
        throw new HelmError('unused', '本测试不启用', 500)
      },
      assertManagedPluginUpdateSafe() {},
      async updateManagedPlugin() {
        return { summary: { id: 'plain-plugin', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] } }
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
  rmSyncFn(dataDir, { recursive: true, force: true })
})
