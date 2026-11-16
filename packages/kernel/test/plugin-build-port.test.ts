/**
 * plugin build port (PluginBuildProvider) kernel contract test:
 * kernel does not carry esbuild / @helm/plugin-build runtime dependency, all build capability via
 * PluginHostOptions.buildProvider explicit inject. this file lock not inject when explicit reject
 * honest boundary (never static default lose UI, never fall back inside placement compiler) and inject after all chain available.
 *
 * override:
 * - UiRegistry: without provider when carries client reference UI declaration register reject
 *   (501 unsupported_client_build), inject after the same declaration via;
 * - PluginHost.getClientModule: without provider when service path same code fall back;
 * - backend-ts-loader: without transform when external TS source load reject
 *   (501 unsupported_backend_ts_build), inject real provider after can load;
 * - doctor:client plugin in without provider when client/register check such as failed,
 *   inject after ok;JS-only plugin without provider also can via (does not need build capability);
 * - KernelRuntime: without buildProvider when register client reference plugin in runtime path explicit reject
 *  (produce product by hub composition root by default inject, kernel do not provide by default implement).
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { UiRegistry } from '../src/plugins/ui-registry.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await makeTempDir('helm-build-port-')
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

test('UiRegistry: without provider when client reference declaration register reject unsupported_client_build', { timeout: 60_000 }, () => {
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
    (err: unknown) => err instanceof HelmError && err.code === 'unsupported_client_build' && err.status === 501,
  )
  // inject provider after the same declaration via (not silently lose UI forward side)
  const withProvider = new UiRegistry(createPluginBuildProvider())
  withProvider.registerUi(
    'p:with-provider',
    'markdown.codeBlock',
    { id: 'cb', languages: ['x'], client: { module: 'index.tsx', export: 'X' } },
    'markdownCodeBlock',
    clientRoot,
  )
})

test('PluginHost.getClientModule: without provider when service path same code fall back', { timeout: 60_000 }, async () => {
  const clientRoot = join(dataDir, 'client2')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export const X = 1\n')
  const host = makeHost()
  const def: PluginDefinition = { id: 'p:serve-no-provider', clientRoot, definePlugin: () => {} }
  await host.register(def)
  await assert.rejects(
    host.getClientModule('p:serve-no-provider', 'index.tsx'),
    (err: unknown) => err instanceof HelmError && err.code === 'unsupported_client_build',
  )
  await host.dispose()
})

test('backend-ts-loader: without transform when TS load reject unsupported_backend_ts_build; inject after can load', { timeout: 60_000 }, async (t) => {
  const dirPath = join(dataDir, 'ts-plugin')
  mkdirSync(dirPath, { recursive: true })
  const tsFile = join(dirPath, 'mod.ts')
  writeFileSync(tsFile, 'export const v: number = 7\n')

  // tsx test process self carries TS hook, cannot real row make this load; use pure node child process verify
  // (and external-plugin-ts / plugin-dx-loop the same pattern).
  const { execFileSync } = await import('node:child_process')
  const loaderUrl = pathToFileURL(fileURLToPath(new URL('../src/plugins/backend-ts-loader.ts', import.meta.url))).href
  const providerUrl = import.meta.resolve('@helm/plugin-build')
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
      /* already follow dataDir clean up */
    }
  })
  let out = ''
  try {
    out = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const errOut = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
    assert.fail(`pure node child process failed:${out}${errOut.slice(0, 800)}`)
  }
  assert.ok(out.includes('CHILD_OK'), `child process should all contract via, output:${out}`)
})

test('doctor:client plugin without provider when check such as failed; inject after ok', { timeout: 60_000 }, async () => {
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
  assert.equal(noProvider.ok, false, 'without provider  doctor must not for client plugin report ok')
  const failed = noProvider.checks.find((c) => c.error?.code === 'unsupported_client_build')
  assert.ok(failed, `should has unsupported_client_build check failed:${JSON.stringify(noProvider.checks)}`)

  const withProvider = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
  assert.equal(withProvider.ok, true, `inject provider after should via:${JSON.stringify(withProvider.checks)}`)
})

test('doctor:JS-only plugin without provider also can via (do not without difference other pull connect)', { timeout: 60_000 }, async () => {
  const dirPath = join(dataDir, 'plugins', 'port-js')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.mjs'),
    'function definePlugin(ctx) { ctx.action({ id: "a", description: "A", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) }) }\nexport default { id: "port-js", name: "Port JS", definePlugin }',
  )
  const report = await doctorPluginDir(dirPath)
  assert.equal(report.ok, true, `without client reference plugin does not need build port:${JSON.stringify(report.checks)}`)
})

test('KernelRuntime: without buildProvider when register client reference plugin in runtime path explicit reject (produce product by hub by default inject)', { timeout: 60_000 }, async () => {
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
        assert.ok(err instanceof HelmError, `should be HelmError:${String(err)}`)
        assert.equal(err.code, 'unsupported_client_build')
        return true
      },
    )
  } finally {
    await kernel.close()
  }
})
