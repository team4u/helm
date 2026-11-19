/**
 * 后端插件 TS 即时转译加载与越界防护专项测试（共享单实例 createHelmx + 纯 node 子进程校验）。
 */
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { HelmxError as HostHelmxError } from '@helmx/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerPluginTsRoot } from '../../kernel/src/plugins/backend-ts-loader.js'
import { loadExternalPlugins } from '../../kernel/src/plugins/external-loader.js'
import {
  cleanupDir,
  createHubTestApp,
  makeTempDir,
  useTempDir,
  type HubTestApp,
} from './helpers/hub-test-env.js'

void HostHelmxError

function globalFlag(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name]
}

const loaderSrc = fileURLToPath(new URL('../../kernel/src/plugins/backend-ts-loader.ts', import.meta.url))

function writeTsPlugin(pluginsDir: string, dir = 'ts-demo'): { dirPath: string; counterName: string } {
  const counterName = `__init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib', 'shapes'), { recursive: true })
  mkdirSync(join(dirPath, 'assets'), { recursive: true })
  mkdirSync(join(dirPath, 'node_modules', 'demo-dep'), { recursive: true })
  writeFileSync(
    join(dirPath, 'node_modules', 'demo-dep', 'package.json'),
    JSON.stringify({ name: 'demo-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'index.js'), 'export const depName = "demo-dep-ok"\n')
  writeFileSync(join(dirPath, 'lib', 'math.ts'), 'export function addTen(n: number): number {\n  return n + 10\n}\n')
  writeFileSync(join(dirPath, 'lib', 'greet.ts'), 'export const greet = (who: string): string => `hi-${who}`\n')
  writeFileSync(join(dirPath, 'lib', 'shapes', 'index.ts'), 'export const shape = (): string => "circle"\n')
  writeFileSync(join(dirPath, 'lib', 'lazy.ts'), 'export const lazyValue = "lazy-ok"\n')
  writeFileSync(join(dirPath, 'config.json'), JSON.stringify({ tag: 'json-ok' }))
  writeFileSync(join(dirPath, 'assets', 'banner.txt'), 'helmx-ts-plugin-asset\n')
  writeFileSync(
    join(dirPath, 'lib', 'host-marker.ts'),
    "import { HelmxError } from '@helmx/protocol'\nexport const marker = new HelmxError('marker', 'marker')\nexport const ctor = HelmxError\n",
  )
  writeFileSync(
    join(dirPath, 'index.ts'),
    `import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { depName } from 'demo-dep'
import { HelmxError } from '@helmx/protocol'
import { addTen } from './lib/math.js'
import { greet } from './lib/greet'
import { shape } from './lib/shapes/index.js'
import cfg from './config.json'
import { marker as hostMarker, ctor as hostCtor } from './lib/host-marker'

declare global { var ${counterName}: number | undefined }
globalThis.${counterName} = (globalThis.${counterName} ?? 0) + 1
const mod = await import('./lib/lazy.ts')
const metaUrl = import.meta.url

async function definePlugin(ctx: any) {
  ctx.action({
    id: 'probe',
    description: 'transpile load all link probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['builtinOk', 'npmDep', 'hostClassSame', 'metaUrl', 'lazyValue', 'assetSha', 'addTen', 'greet', 'shape', 'jsonTag'],
      additionalProperties: false,
      properties: {
        builtinOk: { type: 'boolean' },
        npmDep: { type: 'string' },
        hostClassSame: { type: 'boolean' },
        metaUrl: { type: 'string' },
        lazyValue: { type: 'string' },
        assetSha: { type: 'string' },
        addTen: { type: 'number' },
        greet: { type: 'string' },
        shape: { type: 'string' },
        jsonTag: { type: 'string' },
      },
    },
    handler: () => {
      const asset = readFileSync(new URL('./assets/banner.txt', metaUrl), 'utf8')
      return {
        builtinOk: createHash('sha256').update('x').digest('hex').length === 64,
        npmDep: depName,
        hostClassSame: hostCtor === HelmxError && Object.getPrototypeOf(hostMarker) === HelmxError.prototype && hostMarker instanceof HelmxError,
        metaUrl,
        lazyValue: mod.lazyValue,
        assetSha: createHash('sha256').update(asset).digest('hex').slice(0, 8),
        addTen: addTen(32),
        greet: greet('helmx'),
        shape: shape(),
        jsonTag: cfg.tag,
      }
    },
  })
}

export default { id: '${dir}', name: 'TS demo plugin', version: '1.0.0', definePlugin }
`,
  )
  return { dirPath, counterName }
}

let sharedDataDir = ''
let outsideDir = ''
let sharedApp: HubTestApp
let cleanDirBefore = new Set<string>()
let demoCounter = ''
let cycleCounter = ''
let cleanDirPath = ''

before(async () => {
  sharedDataDir = await makeTempDir('helmx-ext-ts-')
  outsideDir = await makeTempDir('helmx-ext-ts-out-')
  const pluginsDir = join(sharedDataDir, 'plugins')

  demoCounter = writeTsPlugin(pluginsDir, 'ts-demo').counterName
  cycleCounter = writeTsPlugin(pluginsDir, 'ts-cycle').counterName
  const cleanInfo = writeTsPlugin(pluginsDir, 'ts-clean')
  cleanDirPath = cleanInfo.dirPath
  cleanDirBefore = new Set(readdirSync(cleanDirPath))

  // .tsx manifest 入口
  const tsxDir = join(pluginsDir, 'tsx-manifest')
  mkdirSync(join(tsxDir, 'src'), { recursive: true })
  writeFileSync(join(tsxDir, 'plugin.json'), JSON.stringify({ main: 'src/entry.tsx' }))
  writeFileSync(
    join(tsxDir, 'src', 'entry.tsx'),
    `async function definePlugin(ctx: any) {
  ctx.action({
    id: 'ping',
    description: 'tsx entry probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['pong'], additionalProperties: false, properties: { pong: { type: 'boolean' } } },
    handler: () => ({ pong: true }),
  })
}
export default { id: 'tsx-manifest', name: 'TSX manifest plugin', definePlugin }\n`,
  )

  // alias identity（.js / .ts / 内部 symlink 三说明符同一模块实例）
  const aliasDir = join(pluginsDir, 'alias')
  mkdirSync(join(aliasDir, 'lib'), { recursive: true })
  writeFileSync(
    join(aliasDir, 'lib', 'shared.ts'),
    "declare global { var __aliasInit: number | undefined }\nglobalThis.__aliasInit = (globalThis.__aliasInit ?? 0) + 1\nexport const tag = 'shared'\n",
  )
  symlinkSync(join(aliasDir, 'lib', 'shared.ts'), join(aliasDir, 'lib', 'alias.ts'))
  writeFileSync(
    join(aliasDir, 'index.ts'),
    `import { tag as viaJs } from './lib/shared.js'
import { tag as viaTs } from './lib/shared.ts'
import { tag as viaSymlink } from './lib/alias.js'
export default {
  id: 'alias',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'alias identity',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['viaJs', 'viaTs', 'viaSymlink'], additionalProperties: false, properties: { viaJs: { type: 'string' }, viaTs: { type: 'string' }, viaSymlink: { type: 'string' } } },
      handler: () => ({ viaJs, viaTs, viaSymlink }),
    })
  },
}\n`,
  )

  // 静态 + 动态 import 单次初始化
  const idDir = join(pluginsDir, 'identity')
  mkdirSync(join(idDir, 'lib'), { recursive: true })
  writeFileSync(
    join(idDir, 'lib', 'shared.ts'),
    "declare global { var __identityInit: number | undefined }\nglobalThis.__identityInit = (globalThis.__identityInit ?? 0) + 1\nexport const tag = 'shared'\n",
  )
  writeFileSync(
    join(idDir, 'index.ts'),
    `import { tag as a } from './lib/shared.js'
const lazy = await import('./lib/shared.js')
export default {
  id: 'identity',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'identity probe',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['a', 'b'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } },
      handler: () => ({ a, b: lazy.tag }),
    })
  },
}\n`,
  )

  // ID 冲突种子插件
  const firstDup = join(pluginsDir, 'first')
  mkdirSync(firstDup, { recursive: true })
  writeFileSync(join(firstDup, 'index.ts'), "export default { id: 'dup', definePlugin() {} }\n")

  // 语法错误与 4 类越界/逃逸场景（各自独立哨兵，绝不执行外部代码）
  mkdirSync(join(pluginsDir, 'broken-ts'), { recursive: true })
  writeFileSync(join(pluginsDir, 'broken-ts', 'index.ts'), 'export function f(: string {\n  return 1\n}\n')

  mkdirSync(join(pluginsDir, 'broken-dep', 'lib'), { recursive: true })
  writeFileSync(join(pluginsDir, 'broken-dep', 'index.ts'), "import { x } from './lib/bad.js'\nexport default { id: 'broken-dep', tag: x, definePlugin() {} }\n")
  writeFileSync(join(pluginsDir, 'broken-dep', 'lib', 'bad.ts'), 'export const x = {{{\n')

  writeFileSync(join(sharedDataDir, 'evil-main.ts'), "globalThis.__escMainSentinel = 1\nexport default { id: 'evil', definePlugin() {} }\n")
  mkdirSync(join(pluginsDir, 'traversal'), { recursive: true })
  writeFileSync(join(pluginsDir, 'traversal', 'plugin.json'), JSON.stringify({ main: '../../evil-main.ts' }))

  const entryEvil = join(outsideDir, 'entry-evil.ts')
  writeFileSync(entryEvil, "globalThis.__escEntrySentinel = 1\nexport default { id: 'evil', definePlugin() {} }\n")
  mkdirSync(join(pluginsDir, 'entry-symlink'), { recursive: true })
  symlinkSync(entryEvil, join(pluginsDir, 'entry-symlink', 'index.ts'))

  const depEvil = join(outsideDir, 'dep-evil.ts')
  writeFileSync(depEvil, "globalThis.__escDepSentinel = 1\nexport const x = 'evil'\n")
  mkdirSync(join(pluginsDir, 'dep-symlink', 'lib'), { recursive: true })
  symlinkSync(depEvil, join(pluginsDir, 'dep-symlink', 'lib', 'helper.ts'))
  writeFileSync(join(pluginsDir, 'dep-symlink', 'index.ts'), "import { x } from './lib/helper.js'\nexport default { id: 'dep-symlink', tag: x, definePlugin() {} }\n")

  writeFileSync(join(sharedDataDir, 'evil-dotdot.ts'), "globalThis.__escDotdotSentinel = 1\nexport const x = 'evil'\n")
  mkdirSync(join(pluginsDir, 'dotdot'), { recursive: true })
  writeFileSync(join(pluginsDir, 'dotdot', 'index.ts'), "import { x } from '../../evil-dotdot.js'\nexport default { id: 'dotdot', tag: x, definePlugin() {} }\n")

  sharedApp = (await createHubTestApp({ dataDir: sharedDataDir, cwd: sharedDataDir })).app
}, { timeout: 60_000 })

after(async () => {
  await sharedApp?.close().catch(() => {})
  await cleanupDir(sharedDataDir)
  await cleanupDir(outsideDir)
}, { timeout: 60_000 })

test('TS/TSX 外部插件全链路：依赖闭包、内置/npm 模块、@helmx 同构类、json、import.meta.url、别名/动静态同一性与无磁盘中间产物', { timeout: 60_000 }, async () => {
  const plugins = sharedApp.kernel.plugins
  const summary = plugins.list().find((p) => p.id === 'ts-demo')!
  assert.equal(summary.enabled, false)
  await plugins.enable('ts-demo')

  const r = (await plugins.invokeAction('ts-demo', 'probe', {})) as Record<string, unknown>
  assert.equal(r.builtinOk, true)
  assert.equal(r.npmDep, 'demo-dep-ok')
  assert.equal(r.hostClassSame, true)
  assert.equal(r.lazyValue, 'lazy-ok')
  assert.equal(r.addTen, 42)
  assert.equal(r.greet, 'hi-helmx')
  assert.equal(r.shape, 'circle')
  assert.equal(r.jsonTag, 'json-ok')
  const metaUrl = r.metaUrl as string
  assert.ok(metaUrl.startsWith('file://') && !metaUrl.includes('?'))
  assert.ok(fileURLToPath(metaUrl).endsWith(join('ts-demo', 'index.ts')))
  assert.equal(r.assetSha, 'be39b0e2')
  assert.equal(globalFlag(demoCounter), 1)

  // .tsx manifest 入口
  await plugins.enable('tsx-manifest')
  assert.equal(((await plugins.invokeAction('tsx-manifest', 'ping', {})) as { pong: boolean }).pong, true)

  // alias identity（.js / .ts / symlink）与动静态同一性
  await plugins.enable('alias')
  assert.equal(globalFlag('__aliasInit'), 1)
  assert.deepEqual(await plugins.invokeAction('alias', 'tags', {}), { viaJs: 'shared', viaTs: 'shared', viaSymlink: 'shared' })

  await plugins.enable('identity')
  assert.equal(globalFlag('__identityInit'), 1)
  assert.deepEqual(await plugins.invokeAction('identity', 'tags', {}), { a: 'shared', b: 'shared' })

  // 启停循环不重复初始化模块
  await plugins.enable('ts-cycle')
  await plugins.disable('ts-cycle')
  await plugins.enable('ts-cycle')
  assert.equal(((await plugins.invokeAction('ts-cycle', 'probe', {})) as { builtinOk: boolean }).builtinOk, true)
  assert.equal(globalFlag(cycleCounter), 1)

  // 零磁盘转译中间产物
  await plugins.enable('ts-clean')
  await plugins.invokeAction('ts-clean', 'probe', {})
  const added = readdirSync(cleanDirPath).filter((f) => !cleanDirBefore.has(f))
  assert.deepEqual(added, [])
})

test('TS 语法错误定位与 4 类越界/逃逸契约：全部降级为 failed，外部 evil 源码零执行', { timeout: 60_000 }, () => {
  const byId = new Map(sharedApp.kernel.plugins.list().map((p) => [p.id, p]))

  const brokenTs = byId.get('broken-ts')!
  assert.equal(brokenTs.error?.code, 'plugin_load_failed')
  assert.ok(brokenTs.error!.message.includes('broken-ts/index.ts') && /:\d+:\d+/.test(brokenTs.error!.message))

  const brokenDep = byId.get('broken-dep')!
  assert.equal(brokenDep.error?.code, 'plugin_load_failed')
  assert.ok(brokenDep.error!.message.includes('lib/bad.ts'))

  assert.equal(byId.get('traversal')?.error?.code, 'plugin_manifest_invalid')
  assert.equal(globalFlag('__escMainSentinel'), undefined)

  const entrySym = byId.get('entry-symlink')!
  assert.ok(entrySym.error?.code === 'plugin_manifest_invalid' || entrySym.error?.code === 'plugin_load_failed')
  assert.equal(globalFlag('__escEntrySentinel'), undefined)

  assert.equal(byId.get('dep-symlink')?.error?.code, 'plugin_load_failed')
  assert.equal(globalFlag('__escDepSentinel'), undefined)

  const dotdot = byId.get('dotdot')!
  assert.equal(dotdot.error?.code, 'plugin_load_failed')
  assert.ok(dotdot.error!.message.includes('reject transpile'))
  assert.equal(globalFlag('__escDotdotSentinel'), undefined)
})

test('ID 冲突失败后释放 TS 根并支持改 ID 重载，以及 loadExternalPlugins 直调 TS 插件', { timeout: 60_000 }, async () => {
  const pluginsDir = join(sharedDataDir, 'plugins')
  const second = join(pluginsDir, 'second')
  mkdirSync(second, { recursive: true })
  writeFileSync(join(second, 'index.ts'), "export default { id: 'dup', definePlugin() {} }\n")

  const reg0 = await loadExternalPlugins(sharedDataDir, sharedApp.kernel.plugins)
  assert.ok(!reg0.includes('dup'))
  assert.equal(sharedApp.kernel.plugins.list().find((p) => p.id === 'second')?.error?.code, 'plugin_already_registered')

  rmSync(join(pluginsDir, 'first', 'index.ts'))
  writeFileSync(
    join(second, 'index.ts'),
    `export default { id: 'second-fixed', definePlugin(ctx: any) {
  ctx.action({ id: 'ok', description: 'ok', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
} }\n`,
  )
  const extra = join(pluginsDir, 'ts-extra')
  mkdirSync(extra, { recursive: true })
  writeFileSync(
    join(extra, 'index.ts'),
    `export default { id: 'ts-extra', definePlugin(ctx: any) {
  ctx.action({ id: 'ok', description: 'ok', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
} }\n`,
  )

  const reg1 = await loadExternalPlugins(sharedDataDir, sharedApp.kernel.plugins)
  assert.ok(reg1.includes('second-fixed') && reg1.includes('ts-extra'))
  assert.equal(sharedApp.kernel.plugins.list().find((p) => p.id === 'ts-extra')?.enabled, false)
  await sharedApp.kernel.plugins.enable('second-fixed')
  assert.deepEqual(await sharedApp.kernel.plugins.invokeAction('second-fixed', 'ok', {}), { ok: true })
})

test('TS 根释放、引用计数与 fallback 映射（纯 node 子进程生产保真验证）', { timeout: 60_000 }, async (t) => {
  const dirPath = useTempDir(t, 'helmx-ext-rootrel-')
  const out = useTempDir(t, 'helmx-ext-rootout-')
  writeFileSync(join(dirPath, 'mapped.ts'), 'export const v = 42\n')
  writeFileSync(join(dirPath, 'greet.ts'), 'export const g = 7\n')
  symlinkSync(join(dirPath, 'mapped.ts'), join(dirPath, 'alias.ts'))
  writeFileSync(join(out, 'evil.ts'), "globalThis.__childEvil = 1\nexport const e = 'evil'\n")
  writeFileSync(
    join(dirPath, 'entry.ts'),
    "import { v } from './mapped.js'\nimport { g } from './greet'\nimport { v as viaAlias } from './alias.js'\nexport const w = v + g\nexport const a = viaAlias\n",
  )
  const escapeSpec = relative(dirPath, join(out, 'evil.ts')).split(sep).join('/').replace(/evil\.ts$/, 'evil.js')
  writeFileSync(join(dirPath, 'escape.ts'), `import { e } from '${escapeSpec}'\nexport const t = e\n`)

  const providerUrl = import.meta.resolve('@helmx/plugin-build')
  const childSrc = `
const { registerPluginTsRoot } = await import(${JSON.stringify(pathToFileURL(loaderSrc).href)});
const { createPluginBuildProvider } = await import(${JSON.stringify(providerUrl)});
const root = ${JSON.stringify(dirPath)};
const release = registerPluginTsRoot(root, { transform: createPluginBuildProvider().transformBackendTs });
const entry = await import('file://' + root + '/entry.ts');
if (entry.w !== 49 || entry.a !== 42) process.exit(1);
try { await import('file://' + root + '/escape.ts'); process.exit(1); } catch (e) { if (e.code !== 'plugin_load_failed') process.exit(1); }
if (globalThis.__childEvil !== undefined) process.exit(1);
release();
try { await import('file://' + root + '/entry.ts?after'); process.exit(1); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') process.exit(1); }
console.log('CHILD_OK');
`
  const childPath = join(dirPath, 'child.mjs')
  writeFileSync(childPath, childSrc)
  const result = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000 })
  assert.ok(result.includes('CHILD_OK'))

  // 引用计数合并与归零重注册
  const refDir = useTempDir(t, 'helmx-ext-refcnt-')
  writeFileSync(join(refDir, 'still.ts'), 'export const v = 1\n')
  const transform = createPluginBuildProvider().transformBackendTs
  const r1 = registerPluginTsRoot(refDir, { transform })
  const r2 = registerPluginTsRoot(refDir, { transform })
  r1()
  assert.equal(((await import(`file://${join(refDir, 'still.js')}`)) as { v: number }).v, 1)
  r2()
  registerPluginTsRoot(refDir, { transform })()
})
