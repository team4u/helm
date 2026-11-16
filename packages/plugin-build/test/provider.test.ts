/**
 * @helm/plugin-build port tests:
 * - minimal real-behavior verification of both tracks of createPluginBuildProvider
 *   (compileClientModule / transformBackendTs) (the full compilation chain is covered by
 *   plugin-client-css.test.ts and the kernel integration tests);
 * - transformBackendTs: ts / tsx transform to ESM, JSX automatic runtime imports, syntax errors re-thrown
 *   verbatim with locations (diagnostics are never swallowed, no silent degradation);
 * - compileClientModule: compiles a real module through the port (a cache hit yields the same hash).
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

test('transformBackendTs: transforms ts source to ESM, preserving import/export semantics', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const x: number = 1;\nimport { join } from "node:path";\nexport { join };',
    file: join(workDir, 'a.ts'),
    kind: 'ts',
  })
  assert.match(code, /\bx\s*=\s*1/)
  assert.match(code, /node:path/)
})

test('transformBackendTs: tsx uses JSX automatic (the output imports react/jsx-runtime, no inlined React)', { timeout: 60_000 }, () => {
  const code = transformBackendTs({
    source: 'export const El = () => <div>hi</div>;',
    file: join(workDir, 'b.tsx'),
    kind: 'tsx',
  })
  assert.match(code, /react\/jsx-runtime/)
  assert.match(code, /jsx/)
})

test('transformBackendTs: syntax errors are re-thrown verbatim with locations (diagnostics never silently swallowed)', { timeout: 60_000 }, () => {
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
      assert.ok(Array.isArray(errors) && errors.length > 0, 'esbuild diagnostics must be preserved')
      assert.ok(errors[0]!.location, 'diagnostics must carry a line/column location')
      return true
    },
  )
})

test('port: compileClientModule compiles a real module and hits the disk cache (same hash)', { timeout: 60_000 }, async () => {
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
  assert.ok(first.gzipped && first.gzipped.byteLength > 0, 'the artifact must carry gzip pre-compressed bytes')

  // a repeated request from the same source (new provider instance, exercising the disk-manifest
  // re-validation path) yields the same hash
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

test('port: compileClientModule rejects an illegal moduleRef (the same validation as the kernel registration boundary)', { timeout: 60_000 }, async () => {
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

test('contract pure functions: assertModuleRefShape and clientNpmRootsOf shapes (protocol as the single source of truth)', { timeout: 60_000 }, () => {
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

test('concurrent compilePluginClientModule calls safely share the cache directory with no leftover temp files', { timeout: 60_000 }, async () => {
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
    assert.ok(!files.some((f) => f.includes('.tmp-')), `no temp files may be left behind: ${files.join(', ')}`)
    assert.ok(existsSync(join(stagingDir, `${baseName}.deps.json`)), `${pluginId} should have a deps.json`)
    const manifest = JSON.parse(readFileSync(join(stagingDir, `${baseName}.deps.json`), 'utf8')) as {
      contentHash: string
    }
    assert.equal(manifest.contentHash, firstWave[0]!.contentHash)
    assert.ok(existsSync(join(stagingDir, `${baseName}.${manifest.contentHash}.mjs`)))
  }

  // clear the in-memory cache and call concurrently again, verifying safe disk-cache reuse across
  // instances and under concurrency
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
