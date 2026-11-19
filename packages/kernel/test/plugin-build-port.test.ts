/**
 * Kernel contract tests for the plugin build port (PluginBuildProvider):
 * Kernel does not depend on esbuild / @helmx/plugin-build at runtime; all build capabilities are
 * explicitly injected via PluginHostOptions.buildProvider. This suite locks down the honest failure
 * boundary when omitted (never silently dropping UI or falling back to a built-in compiler) and
 * verifies the full pipeline once injected.
 *
 * Coverage:
 * - UiRegistry: registering client-referenced UI declarations without provider rejects
 *   (501 unsupported_client_build); succeeds once injected;
 * - PluginHost.getClientModule: serving fails with the same error code when provider is absent;
 * - backend-ts-loader: loading external TS sources without transform rejects
 *   (501 unsupported_backend_ts_build); loads cleanly once real provider is injected;
 * - doctor: client plugins fail client/register checks cleanly without provider and pass once
 *   injected; JS-only plugins pass even without provider (needing no build capability);
 * - KernelRuntime: registering client-referenced plugins without buildProvider rejects explicitly
 *   (production injects a default via hub composition root; kernel supplies no built-in default).
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { UiRegistry } from '../src/plugins/ui-registry.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await makeTempDir('helmx-build-port-')
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

function makeHost(buildProvider?: ReturnType<typeof createPluginBuildProvider>): PluginHost {
  return new PluginHost({
    dataDir,
    host: { ...createPluginHostBackendFixture(), emitEvent: () => {} },
    docs: new MemoryDocStore(),
    ...(buildProvider !== undefined ? { buildProvider } : {}),
  })
}

test('UiRegistry: client-referenced declaration without provider rejects with unsupported_client_build', { timeout: 60_000 }, () => {
  const ui = new UiRegistry()
  const clientRoot = join(dataDir, 'client')
  mkdirSync(clientRoot, { recursive: true })
  assert.throws(
    () =>
      ui.registerUi(
        'p:no-provider',
        'markdown.codeBlock',
        { id: 'cb', languages: ['x'], client: { module: 'index.tsx', export: 'X' } },
        'markdownCodeBlock',
        clientRoot,
      ),
    (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_client_build' && err.status === 501,
  )
  // Succeeds once provider is injected (never silently drops frontend UI).
  const withProvider = new UiRegistry(createPluginBuildProvider())
  withProvider.registerUi(
    'p:with-provider',
    'markdown.codeBlock',
    { id: 'cb', languages: ['x'], client: { module: 'index.tsx', export: 'X' } },
    'markdownCodeBlock',
    clientRoot,
  )
})

test('PluginHost.getClientModule: serving without provider fails with identical code', { timeout: 60_000 }, async () => {
  const clientRoot = join(dataDir, 'client2')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const X = 1\n')
  const host = makeHost()
  const def: PluginDefinition = { id: 'p:serve-no-provider', clientRoot, definePlugin: () => {} }
  await host.register(def)
  await assert.rejects(
    host.getClientModule('p:serve-no-provider', 'index.tsx'),
    (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_client_build',
  )
  await host.dispose()
})

test('backend-ts-loader: TS load without transform rejects with unsupported_backend_ts_build; succeeds after injection', { timeout: 60_000 }, async (t) => {
  const dirPath = join(dataDir, 'ts-plugin')
  mkdirSync(dirPath, { recursive: true })
  const tsFile = join(dirPath, 'mod.ts')
  writeFileSync(tsFile, 'export const v: number = 7\n')

  // The tsx test runner already installs a TS loader hook, so we spawn a clean Node child process
  // (matching external-plugin-ts / plugin-dx-loop pattern).
  const { execFileSync } = await import('node:child_process')
  const loaderUrl = pathToFileURL(fileURLToPath(new URL('../src/plugins/backend-ts-loader.ts', import.meta.url))).href
  const providerUrl = import.meta.resolve('@helmx/plugin-build')
  const childSrc = `
const { registerPluginTsRoot } = await import(${JSON.stringify(loaderUrl)})
const { createPluginBuildProvider } = await import(${JSON.stringify(providerUrl)})
const root = ${JSON.stringify(dirPath)}
const entry = 'file://' + ${JSON.stringify(tsFile)}
const noTransform = registerPluginTsRoot(root)
try {
  await import(entry + '?no-transform')
  console.log('FAIL loaded-without-transform'); process.exit(1)
} catch (e) {
  if (e.code !== 'unsupported_backend_ts_build') { console.log('FAIL code ' + e.code); process.exit(1) }
}
noTransform()
const withTransform = registerPluginTsRoot(root, { transform: createPluginBuildProvider().transformBackendTs })
const mod = await import(entry + '?with-transform')
if (mod.v !== 7) { console.log('FAIL value ' + mod.v); process.exit(1) }
withTransform()
console.log('CHILD_OK')
`
  const childPath = join(dirPath, 'child.mjs')
  writeFileSync(childPath, childSrc)
  t.after(() => {
    try {
      unlinkSync(childPath)
    } catch {
      /* cleaned up with dataDir */
    }
  })
  let out = ''
  try {
    out = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const errOut = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
    assert.fail(`pure Node child process failed: ${out}${errOut.slice(0, 800)}`)
  }
  assert.ok(out.includes('CHILD_OK'), `child process should pass all contracts, output: ${out}`)
})

test('doctor: client plugin check fails as expected without provider; passes once injected', { timeout: 60_000 }, async () => {
  const dirPath = join(dataDir, 'plugins', 'port-client')
  mkdirSync(join(dirPath, 'client'), { recursive: true })
  writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ id: 'port-client', clientRoot: './client' }))
  writeFileSync(
    join(dirPath, 'index.mjs'),
    [
      "import { readFileSync } from 'node:fs'",
      'function definePlugin(ctx) {',
      "  ctx.ui.screen({ id: 's1', title: 'S', client: { module: 'index.tsx', export: 'X' } })",
      '}',
      "export default { id: 'port-client', name: 'Port Client', definePlugin }",
    ].join('\n'),
  )
  writeFileSync(join(dirPath, 'client', 'index.tsx'), 'export const X = 1\n')

  const noProvider = await doctorPluginDir(dirPath)
  assert.equal(noProvider.ok, false, 'doctor without provider must not report ok for client plugins')
  const failed = noProvider.checks.find((c) => c.error?.code === 'unsupported_client_build')
  assert.ok(failed, `expected unsupported_client_build check failure: ${JSON.stringify(noProvider.checks)}`)

  const withProvider = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
  assert.equal(withProvider.ok, true, `should pass once provider is injected: ${JSON.stringify(withProvider.checks)}`)
})

test('doctor: JS-only plugins pass even without provider (no gratuitous coupling)', { timeout: 60_000 }, async () => {
  const dirPath = join(dataDir, 'plugins', 'port-js')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.mjs'),
    'function definePlugin(ctx) { ctx.action({ id: "a", description: "A", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) }) }\nexport default { id: "port-js", name: "Port JS", definePlugin }',
  )
  const report = await doctorPluginDir(dirPath)
  assert.equal(report.ok, true, `plugins without client modules need no build port: ${JSON.stringify(report.checks)}`)
})

test('KernelRuntime: registering client-referenced plugin without buildProvider rejects explicitly (hub provides default in production)', { timeout: 60_000 }, async () => {
  const { KernelRuntime } = await import('../src/runtime/index.js')
  const { fauxProvider } = await import('@earendil-works/pi-ai/providers/faux')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const models = createModels()
  models.setProvider(fauxProvider({ tokensPerSecond: 1 }).provider)
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, autoResume: false })
  try {
    const clientRoot = join(dataDir, 'client-src')
    mkdirSync(clientRoot, { recursive: true })
    writeFileSync(join(clientRoot, 'index.tsx'), 'export const X = 1\n')
    await assert.rejects(
      kernel.plugins.register({
        id: 'p:runtime-no-provider',
        clientRoot,
        definePlugin: (ctx) => {
          ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'X' } })
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError, `expected HelmxError: ${String(err)}`)
        assert.equal(err.code, 'unsupported_client_build')
        return true
      },
    )
  } finally {
    await kernel.close()
  }
})
