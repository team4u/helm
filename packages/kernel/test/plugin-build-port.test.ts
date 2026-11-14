/**
 * 插件构建端口（PluginBuildProvider）内核契约测试：
 * 内核不携带 esbuild / @helm/plugin-build 运行时依赖，全部构建能力经
 * PluginHostOptions.buildProvider 显式注入。本文件锁定「未注入时显式拒绝」
 * 的诚实性边界（绝不静默丢 UI、绝不回退内置编译器）与「注入后全链可用」。
 *
 * 覆盖：
 * - UiRegistry：无 provider 时带 client 引用的 UI 声明注册拒绝
 *   （501 unsupported_client_build），注入后同一声明通过；
 * - PluginHost.getClientModule：无 provider 时服务路径同 code 兜底；
 * - backend-ts-loader：无 transform 时外部 TS 源加载拒绝
 *   （501 unsupported_backend_ts_build），注入真实 provider 后可加载；
 * - doctor：client 插件在无 provider 时 client/register 检查如实失败，
 *   注入后 ok；JS-only 插件无 provider 也可通过（不需要构建能力）；
 * - KernelRuntime：无 buildProvider 时注册 client 引用插件在运行时路径显式拒绝
 *  （产品由 hub 组合根默认注入，内核不提供默认实现）。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { PluginHost } from '../src/plugins/plugin-host.js'
import { UiRegistry } from '../src/plugins/ui-registry.js'
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import type { PluginDocStore } from '../src/plugins/doc-registry.js'

class MemoryDocStore implements PluginDocStore {
  private values = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.values.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-build-port-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function makeHost(buildProvider?: ReturnType<typeof createPluginBuildProvider>): PluginHost {
  return new PluginHost({
    dataDir,
    host: { ...createPluginHostBackendFixture(), emitEvent: () => {} },
    docs: new MemoryDocStore(),
    ...(buildProvider !== undefined ? { buildProvider } : {}),
  })
}

test('UiRegistry：无 provider 时 client 引用声明注册拒绝 unsupported_client_build', { timeout: 60_000 }, () => {
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
  // 注入 provider 后同一声明通过（不静默丢 UI 的正向面）
  const withProvider = new UiRegistry(createPluginBuildProvider())
  withProvider.registerUi(
    'p:with-provider',
    'markdown.codeBlock',
    { id: 'cb', languages: ['x'], client: { module: 'index.tsx', export: 'X' } },
    'markdownCodeBlock',
    clientRoot,
  )
})

test('PluginHost.getClientModule：无 provider 时服务路径同 code 兜底', { timeout: 60_000 }, async () => {
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

test('backend-ts-loader：无 transform 时 TS 加载拒绝 unsupported_backend_ts_build；注入后可加载', { timeout: 60_000 }, async (t) => {
  const dirPath = join(dataDir, 'ts-plugin')
  mkdirSync(dirPath, { recursive: true })
  const tsFile = join(dirPath, 'mod.ts')
  writeFileSync(tsFile, 'export const v: number = 7\n')

  // tsx 测试进程自带 TS 钩子，不能真实行使本加载器；用纯 node 子进程验证
  // （与 external-plugin-ts / plugin-dx-loop 同一模式）。
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
      rmSync(childPath, { force: true })
    } catch {
      /* 已随 dataDir 清理 */
    }
  })
  let out = ''
  try {
    out = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const errOut = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
    assert.fail(`纯 node 子进程失败：${out}${errOut.slice(0, 800)}`)
  }
  assert.ok(out.includes('CHILD_OK'), `子进程应全契约通过，输出：${out}`)
})

test('doctor：client 插件无 provider 时检查如实失败；注入后 ok', { timeout: 60_000 }, async () => {
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
  assert.equal(noProvider.ok, false, '无 provider 的 doctor 不得对 client 插件报 ok')
  const failed = noProvider.checks.find((c) => c.error?.code === 'unsupported_client_build')
  assert.ok(failed, `应有 unsupported_client_build 检查失败：${JSON.stringify(noProvider.checks)}`)

  const withProvider = await doctorPluginDir(dirPath, { buildProvider: createPluginBuildProvider() })
  assert.equal(withProvider.ok, true, `注入 provider 后应通过：${JSON.stringify(withProvider.checks)}`)
})

test('doctor：JS-only 插件无 provider 也可通过（不无差别牵连）', { timeout: 60_000 }, async () => {
  const dirPath = join(dataDir, 'plugins', 'port-js')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.mjs'),
    'function definePlugin(ctx) { ctx.action({ id: "a", description: "A", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) }) }\nexport default { id: "port-js", name: "Port JS", definePlugin }',
  )
  const report = await doctorPluginDir(dirPath)
  assert.equal(report.ok, true, `无 client 引用的插件不需要构建端口：${JSON.stringify(report.checks)}`)
})

test('KernelRuntime：无 buildProvider 时注册 client 引用插件在运行时路径显式拒绝（产品由 hub 默认注入）', { timeout: 60_000 }, async () => {
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
        assert.ok(err instanceof HelmError, `应为 HelmError：${String(err)}`)
        assert.equal(err.code, 'unsupported_client_build')
        return true
      },
    )
  } finally {
    await kernel.close()
  }
})
