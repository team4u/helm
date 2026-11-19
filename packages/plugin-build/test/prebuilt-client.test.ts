/**
 * Tests for `buildPluginClientBundleDir` and prebuilt chunk lookup via `installNodeChunkBridge`:
 * - Explicit `modules` vs auto-scanning `clientRoot` (ignoring `.d.ts` / `node_modules` / dotfiles);
 * - CSS bundling (`__helmxClientCss`), shared host shims (`__helmx_shared_*`), `.gz` pre-compression;
 * - Code splitting (`import()`) + controlled `npmRoots` + Node runtime execution via `installNodeChunkBridge`;
 * - Failing compilation leaves no half-written `outDir` behind.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  HelmxError,
  PLUGIN_CLIENT_CSS_EXPORT,
  PREBUILT_CLIENT_MANIFEST_FILE,
  PREBUILT_CLIENT_MANIFEST_VERSION,
  assertPrebuiltClientManifest,
  prebuiltChunkFileName,
} from '@helmx/protocol'
import { buildPluginClientBundleDir, installNodeChunkBridge } from '../src/index.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'helmx-prebuilt-client-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('buildPluginClientBundleDir: auto-scans non-declaration modules, writes manifest.json + .mjs + .gz, and bundles CSS', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'src-client')
  const outDir = join(workDir, 'dist-client')
  mkdirSync(join(clientRoot, 'panels'), { recursive: true })
  writeFileSync(join(clientRoot, 'css.d.ts'), 'declare module "*.css" {}\n')
  writeFileSync(join(clientRoot, 'styles.css'), '.prebuilt-card { color: red }\n')
  writeFileSync(
    join(clientRoot, 'index.tsx'),
    [
      "import { useState } from 'react'",
      "import './styles.css'",
      'export function MainPanel() { return useState("ok")[0] }',
    ].join('\n'),
  )
  writeFileSync(
    join(clientRoot, 'panels', 'Extra.tsx'),
    'export function ExtraPanel() { return "extra" }\n',
  )

  const result = await buildPluginClientBundleDir({
    pluginId: 'test:prebuilt-scan',
    clientRoot,
    outDir,
  })

  assert.equal(result.manifest.version, PREBUILT_CLIENT_MANIFEST_VERSION)
  assert.deepEqual(Object.keys(result.manifest.modules).sort(), ['index.tsx', 'panels/Extra.tsx'])
  assert.ok(existsSync(join(outDir, PREBUILT_CLIENT_MANIFEST_FILE)))

  const parsed = assertPrebuiltClientManifest(
    JSON.parse(readFileSync(join(outDir, PREBUILT_CLIENT_MANIFEST_FILE), 'utf8')),
    outDir,
  )
  const indexEntry = parsed.modules['index.tsx']!
  assert.ok(indexEntry.exports.includes('MainPanel'))
  assert.ok(indexEntry.exports.includes(PLUGIN_CLIENT_CSS_EXPORT))
  const jsText = readFileSync(join(outDir, indexEntry.entryFile), 'utf8')
  const gzBytes = readFileSync(join(outDir, `${indexEntry.entryFile}.gz`))
  assert.equal(gunzipSync(gzBytes).toString('utf8'), jsText)
  assert.match(jsText, /__helmx_shared_react/)
  assert.match(jsText, /prebuilt-card/)
})

test('buildPluginClientBundleDir: supports explicit modules, controlled npmRoots, async chunks + gzip, and Node bridge execution', { timeout: 60_000 }, async () => {
  const pluginDir = join(workDir, 'chart-plugin')
  const clientRoot = join(pluginDir, 'client')
  const outDir = join(pluginDir, 'dist-client')
  const depDir = join(pluginDir, 'node_modules', 'tiny-chart')
  mkdirSync(clientRoot, { recursive: true })
  mkdirSync(depDir, { recursive: true })
  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-chart', main: 'index.js', type: 'module' }))
  writeFileSync(join(depDir, 'index.js'), 'export function drawChart(label) { return "chart:" + label }\n')

  writeFileSync(join(clientRoot, 'ignored.ts'), 'export const ignored = true\n')
  writeFileSync(
    join(clientRoot, 'index.tsx'),
    [
      'export async function renderAsync() {',
      '  const mod = await import("tiny-chart")',
      '  return mod.drawChart("prebuilt")',
      '}',
    ].join('\n'),
  )

  const result = await buildPluginClientBundleDir({
    pluginId: 'test:prebuilt-chunks',
    clientRoot,
    outDir,
    modules: ['index.tsx'],
    npmRoots: [{ packageRoot: pluginDir, specifiers: ['tiny-chart'] }],
  })

  assert.deepEqual(Object.keys(result.manifest.modules), ['index.tsx'])
  const entry = result.manifest.modules['index.tsx']!
  assert.ok(Array.isArray(entry.chunks) && entry.chunks.length > 0, 'split bundle must emit chunk entries')
  for (const chunkName of entry.chunks!) {
    const chunkRel = prebuiltChunkFileName(entry.entryFile, chunkName)
    const chunkJs = readFileSync(join(outDir, chunkRel), 'utf8')
    const chunkGz = readFileSync(join(outDir, `${chunkRel}.gz`))
    assert.equal(gunzipSync(chunkGz).toString('utf8'), chunkJs)
  }

  const g = globalThis as Record<string, unknown>
  const prevBridge = g.__helmx_import_chunk
  const prevLookup = g.__helmx_node_chunk_lookup
  try {
    installNodeChunkBridge([outDir])
    const entryJs = readFileSync(join(outDir, entry.entryFile), 'utf8')
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(entryJs, 'utf8').toString('base64')}`)) as {
      renderAsync: () => Promise<string>
    }
    assert.equal(await mod.renderAsync(), 'chart:prebuilt')
  } finally {
    g.__helmx_import_chunk = prevBridge
    g.__helmx_node_chunk_lookup = prevLookup
  }
})

test('buildPluginClientBundleDir: rejects empty modules, missing clientRoot, and syntax errors without writing partial outDir', { timeout: 60_000 }, async () => {
  const clientRoot = join(workDir, 'bad-client')
  const outDir = join(workDir, 'bad-out')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const Broken = (((\n')

  await assert.rejects(
    buildPluginClientBundleDir({ pluginId: 'test:empty', clientRoot, outDir, modules: [] }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    buildPluginClientBundleDir({ pluginId: 'test:missing', clientRoot: join(workDir, 'nope'), outDir }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_root_invalid',
  )
  await assert.rejects(
    buildPluginClientBundleDir({ pluginId: 'test:syntax', clientRoot, outDir }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed',
  )
  assert.equal(existsSync(outDir), false, 'failed prebuild must not leave partial outDir on disk')
})
