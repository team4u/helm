/**
 * @helm/plugin-build 端口测试：
 * - createPluginBuildProvider 两轨道（compileClientModule / transformBackendTs）
 *   的最小真实行为验证（编译大链路见 plugin-client-css.test.ts 与内核集成测试）；
 * - transformBackendTs：ts / tsx 转译为 ESM、JSX automatic 运行时导入、
 *   语法错误带定位原样上抛（不吞诊断、不静默降级）；
 * - compileClientModule：经端口请求编译真实模块（缓存命中同 hash）。
 */
import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
  createPluginBuildProvider,
  safeDirName,
  safeFileName,
  transformBackendTs,
} from '../src/index.js'
import { assertModuleRefShape, clientNpmRootsOf } from '@helm/protocol'
import { HelmError } from '@helm/protocol'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'helm-plugin-build-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('transformBackendTs：ts 源转译为 ESM，保留 import/export 语义', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const x: number = 1;\nimport { join } from "node:path";\nexport { join };',
    file: join(workDir, 'a.ts'),
    kind: 'ts',
  })
  assert.match(code, /\bx\s*=\s*1/)
  assert.match(code, /node:path/)
})

test('transformBackendTs：tsx 走 JSX automatic（产物 import react/jsx-runtime，不内联 React）', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const El = () => <div>hi</div>;',
    file: join(workDir, 'b.tsx'),
    kind: 'tsx',
  })
  assert.match(code, /react\/jsx-runtime/)
  assert.match(code, /jsx/)
})

test('transformBackendTs：语法错误原样上抛且带定位（不静默吞诊断）', { timeout: 60_000 }, () => {
  const file = join(workDir, 'bad.ts')
  assert.throws(
    () =>
      transformBackendTs({
        source: 'export const = ;',
        file,
        kind: 'ts',
      }),
    (err: unknown) => {
      const errors = (err as { errors?: Array<{ location?: { line: number; column: number } }> }).errors
      assert.ok(Array.isArray(errors) && errors.length > 0, 'esbuild 诊断必须保留')
      assert.ok(errors[0]!.location, '诊断需带行列定位')
      return true
    },
  )
})

test('端口：compileClientModule 编译真实模块并命中磁盘缓存（同 hash）', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'client')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const v = 41;\n')

  const provider = createPluginBuildProvider()
  const first = await provider.compileClientModule({
    pluginId: 'test:port',
    clientRoot,
    moduleRef: 'index.tsx',
    cacheDir: workDir,
    npmRoots: [],
  })
  assert.ok(first.code.length > 0)
  assert.ok(first.contentHash.length > 0)
  assert.ok(first.exports.includes('v'))
  assert.ok(first.gzipped && first.gzipped.byteLength > 0, '产物需带 gzip 预压缩字节')

  // 同源重复请求（新 provider 实例，走磁盘清单复查路径）hash 一致
  const second = await createPluginBuildProvider().compileClientModule({
    pluginId: 'test:port',
    clientRoot,
    moduleRef: 'index.tsx',
    cacheDir: workDir,
    npmRoots: [],
  })
  assert.equal(second.contentHash, first.contentHash)
  assert.equal(second.code, first.code)
})

test('端口：compileClientModule 拒绝非法 moduleRef（与内核注册边界同一校验）', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'client2')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const v = 1;\n')
  const provider = createPluginBuildProvider()
  await assert.rejects(
    provider.compileClientModule({
      pluginId: 'test:port-shape',
      clientRoot,
      moduleRef: '../escape.tsx',
      cacheDir: workDir,
      npmRoots: [],
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
  )
})

test('契约纯函数：assertModuleRefShape 与 clientNpmRootsOf 形状（protocol 单一事实源）', { timeout: 60_000 }, () => {
  assert.throws(() => assertModuleRefShape('p', 'a/../b.tsx'), (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal((err as HelmError).code, 'invalid_client_module')
    return true
  })
  assert.doesNotThrow(() => assertModuleRefShape('p', 'a/b.tsx'))

  const roots = clientNpmRootsOf({ 'chart.js': '/pkgs/a', 'date-fns': '/pkgs/a', react: '/pkgs/b' })
  assert.deepEqual(
    roots.map((r) => [r.packageRoot, [...r.specifiers].sort()]),
    [
      ['/pkgs/a', ['chart.js', 'date-fns']],
      ['/pkgs/b', ['react']],
    ],
  )
})

test('并发调用 compilePluginClientModule 共享缓存目录安全复用且无残留临时文件', { timeout: 60_000 }, async () => {
  clearClientCompilerMemoryCache()
  const clientRoot = join(workDir, 'concurrent-client')
  const sharedCacheDir = join(workDir, 'shared-cache')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'dep.ts'), 'export const label = "concurrent-ok";\n')
  writeFileSync(join(clientRoot, 'index.tsx'), 'import { label } from "./dep.js";\nexport const value = label;\n')

  const firstWave = await Promise.all([
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-b', clientRoot, 'index.tsx', sharedCacheDir),
  ])

  for (const res of firstWave) {
    assert.ok(res.code.includes('concurrent-ok'))
    assert.ok(res.exports.includes('value'))
    assert.equal(res.contentHash, firstWave[0]!.contentHash)
  }
  assert.equal(firstWave[1]!.code, firstWave[0]!.code)
  assert.equal(firstWave[2]!.code, firstWave[0]!.code)

  const baseName = safeFileName('index.tsx')
  for (const pluginId of ['test:concurrent-a', 'test:concurrent-b']) {
    const stagingDir = join(sharedCacheDir, 'plugin-staging', safeDirName(pluginId))
    const files = readdirSync(stagingDir)
    assert.ok(!files.some((f) => f.includes('.tmp-')), `不得残留临时文件：${files.join(', ')}`)
    assert.ok(existsSync(join(stagingDir, `${baseName}.deps.json`)), `${pluginId} 应存在 deps.json`)
    const manifest = JSON.parse(readFileSync(join(stagingDir, `${baseName}.deps.json`), 'utf8')) as {
      contentHash: string
    }
    assert.equal(manifest.contentHash, firstWave[0]!.contentHash)
    assert.ok(existsSync(join(stagingDir, `${baseName}.${manifest.contentHash}.mjs`)))
  }

  // 清空内存缓存后再次并发调用，验证磁盘缓存跨实例/并发复用的安全性
  clearClientCompilerMemoryCache()
  const secondWave = await Promise.all([
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-a', clientRoot, 'index.tsx', sharedCacheDir),
    compilePluginClientModule('test:concurrent-b', clientRoot, 'index.tsx', sharedCacheDir),
  ])
  for (const res of secondWave) {
    assert.equal(res.contentHash, firstWave[0]!.contentHash)
    assert.equal(res.code, firstWave[0]!.code)
  }
  clearClientCompilerMemoryCache()
})
