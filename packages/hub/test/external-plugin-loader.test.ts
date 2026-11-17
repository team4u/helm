/**
 * 外部插件目录 `<dataDir>/plugins/<dir>/` 自动发现、容错降级与持久化恢复集成测试（共享 createHelm 实例减少重复冷启动）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadExternalPlugins } from '../../kernel/src/plugins/external-loader.js'
import { pluginDataDirName } from '../../kernel/src/plugins/plugin-dir-name.js'
import {
  cleanupDir,
  createHubTestApp,
  makeTempDir,
  useTempDir,
  type HubTestApp,
} from './helpers/hub-test-env.js'

const CONVENTION_PLUGIN_SRC = (id = 'demo-external') => `
export default {
  id: '${id}',
  name: 'demo external plugin',
  version: '1.0.0',
  async definePlugin(ctx) {
    const status = ctx.doc('status', { count: 0 }, { public: true })
    ctx.action({
      id: 'bump',
      description: 'counter add one',
      inputSchema: { type: 'object', properties: { step: { type: 'number' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
      handler: (input) => {
        status.update((cur) => ({ count: cur.count + (input?.step ?? 1) }))
        return { count: status.get().count }
      },
    })
    ctx.ui.screen({
      id: 'demo-panel',
      label: 'demo panel',
      client: { module: 'client.tsx', export: 'Panel' },
    })
  },
}
`

const CONVENTION_CLIENT_TSX = `import { useState } from 'react'
export function Panel(props: { title: string }) {
  const [n] = useState(props.title)
  return n
}
`

function writeConventionPlugin(pluginsDir: string, dir = 'demo-external'): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), CONVENTION_PLUGIN_SRC(dir))
  writeFileSync(join(dirPath, 'client.tsx'), CONVENTION_CLIENT_TSX)
  return dirPath
}

let sharedDataDir = ''
let outsideDir = ''
let sharedApp: HubTestApp

before(async () => {
  sharedDataDir = await makeTempDir('helm-ext-loader-')
  outsideDir = await makeTempDir('helm-ext-outside-')
  const pluginsDir = join(sharedDataDir, 'plugins')

  // 1. 健康外部插件（约定入口、plugin.json main、无 name 缺省回退、clientRoot: ./client）
  writeConventionPlugin(pluginsDir, 'demo-external')

  const manifestDir = join(pluginsDir, 'manifest-plugin')
  mkdirSync(join(manifestDir, 'src'), { recursive: true })
  writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ main: 'src/entry.mjs' }))
  writeFileSync(
    join(manifestDir, 'src', 'entry.mjs'),
    `export default {
  id: 'manifest-plugin',
  name: 'manifest plugin',
  async definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'back sound',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}\n`,
  )

  const noNameDir = join(pluginsDir, 'no-name')
  mkdirSync(noNameDir, { recursive: true })
  writeFileSync(
    join(noNameDir, 'index.mjs'),
    `export default {
  id: 'no-name-plugin',
  async definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'back sound',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      handler: () => ({ ok: true }),
    })
  },
}\n`,
  )

  const clientRootDir = join(pluginsDir, 'manifest-client-root')
  mkdirSync(join(clientRootDir, 'client'), { recursive: true })
  writeFileSync(
    join(clientRootDir, 'plugin.json'),
    JSON.stringify({ id: 'manifest-client-root', main: 'index.mjs', clientRoot: './client' }),
  )
  writeFileSync(
    join(clientRootDir, 'index.mjs'),
    `export default {
  id: 'manifest-client-root',
  definePlugin(ctx) {
    ctx.ui.screen({ id: 'main', label: 'main screen', client: { module: 'index.tsx', export: 'MainScreen' } })
  },
}\n`,
  )
  writeFileSync(join(clientRootDir, 'client', 'index.tsx'), 'export function MainScreen() { return null }\n')

  // 2. 纯数据目录与隐藏目录（必须静默跳过）
  const memoryDataDir = join(pluginsDir, pluginDataDirName('builtin:memory'))
  mkdirSync(memoryDataDir, { recursive: true })
  writeFileSync(join(memoryDataDir, 'notes.md'), 'memory plugin data')
  const herdrDataDir = join(pluginsDir, pluginDataDirName('builtin:herdr'))
  mkdirSync(join(herdrDataDir, 'state'), { recursive: true })
  writeFileSync(join(herdrDataDir, 'state', 'cache.json'), '{}')
  mkdirSync(join(pluginsDir, 'some-plugin-data'), { recursive: true })
  writeFileSync(join(pluginsDir, 'some-plugin-data', 'MEMORY.md'), 'data only')
  mkdirSync(join(pluginsDir, '.hidden'), { recursive: true })
  writeFileSync(join(pluginsDir, '.hidden', 'index.mjs'), 'export default {}')
  mkdirSync(join(pluginsDir, 'empty-dir'), { recursive: true })

  // 3. 13 类故障/越界外部插件目录（各自降级注册为 failed，互不阻塞）
  writeFileSync(join(outsideDir, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
  writeFileSync(join(sharedDataDir, 'outside.mjs'), 'throw new Error("outside_module_was_imported")')

  const put = (dir: string, files: Record<string, string>) => {
    const p = join(pluginsDir, dir)
    mkdirSync(p, { recursive: true })
    for (const [k, v] of Object.entries(files)) writeFileSync(join(p, k), v)
    return p
  }

  put('broken-manifest', { 'plugin.json': '{ not valid json !!', 'index.mjs': 'export default { id: "x", definePlugin() {} }' })
  put('array-manifest', { 'plugin.json': '[1, 2, 3]', 'index.mjs': 'export default { id: "x", definePlugin() {} }' })
  put('fake-builtin', { 'index.mjs': "export default { id: 'builtin:evil', name: 'smoke fill', async definePlugin() {} }\n" })
  put('colon-plugin', { 'index.mjs': "export default { id: 'vendor:plugin', name: 'colon', async definePlugin() {} }\n" })
  put('traversal', { 'plugin.json': JSON.stringify({ main: '../../outside.mjs' }) })
  put('missing-entry', { 'plugin.json': JSON.stringify({ main: 'ghost.mjs' }) })
  const symEsc = put('symlink-escape', { 'plugin.json': JSON.stringify({ main: 'entry.mjs' }) })
  symlinkSync(join(outsideDir, 'evil.mjs'), join(symEsc, 'entry.mjs'))
  put('bad-client-root', { 'index.mjs': "export default { id: 'bad-client-root', name: 'bad', clientRoot: 123, definePlugin() {} }\n" })
  const convEsc = put('convention-escape', {})
  symlinkSync(join(sharedDataDir, 'outside.mjs'), join(convEsc, 'index.mjs'))
  const symLoop = put('symlink-loop', {})
  symlinkSync(join(symLoop, 'index.mjs'), join(symLoop, 'index.mjs'))
  put('setup-alias', { 'index.mjs': "export default { id: 'setup-alias', name: 'old', setup() {} }\n" })
  put('empty-name', { 'index.mjs': "export default { id: 'empty-name', name: '', definePlugin() {} }\n" })
  put('no-setup', { 'index.mjs': 'export default { id: "no-setup", name: "without entry" }' })

  sharedApp = (await createHubTestApp({ dataDir: sharedDataDir, cwd: sharedDataDir })).app
})

after(async () => {
  await sharedApp?.close().catch(() => {})
  await cleanupDir(sharedDataDir)
  await cleanupDir(outsideDir)
})

test('自动发现与全链路启用：约定入口、plugin.json main、缺省 name、clientRoot 默认与显式 ./client 均生效，纯数据目录静默忽略', { timeout: 60_000 }, async () => {
  const list = sharedApp.kernel.plugins.list()
  const ids = list.map((p) => p.id)

  // 纯数据目录/隐藏目录静默跳过，内置插件不受扰
  assert.equal(list.filter((p) => p.id === 'builtin:memory').length, 1)
  assert.ok(!ids.includes('some-plugin-data') && !ids.includes('.hidden') && !ids.includes('empty-dir'))
  assert.ok(ids.includes('builtin:profile'))

  // 约定入口默认停用且 locked=false；启用后 action / public doc / 默认 clientRoot 编译全通
  const demo = list.find((p) => p.id === 'demo-external')!
  assert.equal(demo.enabled, false)
  assert.equal(demo.locked, false)
  await sharedApp.kernel.plugins.enable('demo-external')
  assert.equal(((await sharedApp.kernel.plugins.invokeAction('demo-external', 'bump', { step: 5 })) as { count: number }).count, 5)
  assert.deepEqual(sharedApp.kernel.plugins.getPublicDoc('demo-external', 'status').value, { count: 5 })
  const client = await sharedApp.kernel.plugins.getClientModule('demo-external', 'client.tsx')
  assert.match(client.code, /__helm_shared_react/)

  // plugin.json main 指定入口
  assert.equal(list.find((p) => p.id === 'manifest-plugin')?.enabled, false)
  await sharedApp.kernel.plugins.enable('manifest-plugin')
  assert.equal(((await sharedApp.kernel.plugins.invokeAction('manifest-plugin', 'ping', {})) as { pong: boolean }).pong, true)

  // 无 name 导出回退 id
  const noName = list.find((p) => p.id === 'no-name-plugin')!
  assert.equal(noName.name, 'no-name-plugin')
  await sharedApp.kernel.plugins.enable('no-name-plugin')
  assert.equal(((await sharedApp.kernel.plugins.invokeAction('no-name-plugin', 'ping', {})) as { ok: boolean }).ok, true)

  // plugin.json clientRoot: "./client"
  await sharedApp.kernel.plugins.enable('manifest-client-root')
  const subClient = await sharedApp.kernel.plugins.getClientModule('manifest-client-root', 'index.tsx')
  assert.ok(subClient.exports.includes('MainScreen'))
})

test('故障隔离与边界拒绝：13 类坏 manifest / 冒充 builtin: / 冒号 ID / 路径穿越 / symlink 逃逸与环 / 非法导出均降级为 failed', { timeout: 60_000 }, () => {
  const byId = new Map(sharedApp.kernel.plugins.list().map((p) => [p.id, p]))
  const expectFailed = (id: string, code: string, pattern?: RegExp) => {
    const item = byId.get(id)
    assert.ok(item, `故障目录 ${id} 应注册为 failed 占位项`)
    assert.equal(item.enabled, false)
    assert.equal(item.status, 'failed')
    assert.equal(item.error?.code, code)
    if (pattern !== undefined) assert.match(item.error!.message, pattern)
  }

  expectFailed('broken-manifest', 'plugin_manifest_invalid')
  expectFailed('array-manifest', 'plugin_manifest_invalid')
  expectFailed('fake-builtin', 'invalid_plugin_definition', /builtin:/)
  expectFailed('colon-plugin', 'invalid_plugin_definition', /smoke number/)
  assert.equal(existsSync(join(sharedDataDir, 'plugins', 'vendor:plugin')), false)
  assert.equal(existsSync(join(sharedDataDir, 'plugins', 'vendor%3Aplugin')), false)
  expectFailed('traversal', 'plugin_manifest_invalid')
  expectFailed('missing-entry', 'plugin_entry_missing')
  expectFailed('symlink-escape', 'plugin_manifest_invalid', /symlink/)
  expectFailed('bad-client-root', 'invalid_plugin_definition', /clientRoot/)
  expectFailed('convention-escape', 'plugin_manifest_invalid')
  expectFailed('symlink-loop', 'plugin_scan_failed')
  expectFailed('setup-alias', 'invalid_plugin_definition', /definePlugin/)
  expectFailed('empty-name', 'invalid_plugin_definition', /name/)
  expectFailed('no-setup', 'invalid_plugin_definition')
})

test('loadExternalPlugins 直调：返回新注册 ID 列表，缺失 plugins 目录返回空数组', { timeout: 60_000 }, async (t) => {
  const dirPath = join(sharedDataDir, 'plugins', 'direct-loader')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(
    join(dirPath, 'index.mjs'),
    `export default {
  id: 'direct-loader',
  name: 'direct tune',
  async definePlugin(ctx) {
    ctx.action({
      id: 'noop',
      description: 'empty operation',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      handler: () => ({ ok: true }),
    })
  },
}\n`,
  )
  const registered = await loadExternalPlugins(sharedDataDir, sharedApp.kernel.plugins)
  assert.ok(registered.includes('direct-loader'))
  assert.equal(sharedApp.kernel.plugins.list().find((p) => p.id === 'direct-loader')?.enabled, false)

  const emptyRoot = useTempDir(t, 'helm-ext-empty-')
  assert.deepEqual(await loadExternalPlugins(emptyRoot, sharedApp.kernel.plugins), [])
})

test('pluginEnabled 跨重启恢复：持久化 true 自动启用，持久化 false 保持停用', { timeout: 60_000 }, async (t) => {
  const dataDir = join(useTempDir(t, 'helm-ext-restart-'), 'hub')
  writeConventionPlugin(join(dataDir, 'plugins'), 'stay-on')
  writeConventionPlugin(join(dataDir, 'plugins'), 'stay-off')

  const first = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    await first.kernel.plugins.enable('stay-on')
    await first.kernel.plugins.enable('stay-off')
    await first.kernel.plugins.disable('stay-off')
    const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { pluginEnabled?: Record<string, boolean> }
    assert.equal(persisted.pluginEnabled?.['stay-on'], true)
    assert.equal(persisted.pluginEnabled?.['stay-off'], false)
  } finally {
    await first.app.close()
  }

  const second = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    assert.equal(second.kernel.plugins.list().find((p) => p.id === 'stay-on')?.enabled, true)
    assert.equal(((await second.kernel.plugins.invokeAction('stay-on', 'bump', { step: 2 })) as { count: number }).count, 2)
    assert.equal(second.kernel.plugins.list().find((p) => p.id === 'stay-off')?.enabled, false)
  } finally {
    await second.app.close()
  }
})
