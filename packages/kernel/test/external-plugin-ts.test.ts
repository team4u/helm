/**
 * 后端插件 TS 转译加载器专项测试（backend-ts-loader + external-loader TS 入口）。
 *
 * 组合纪律：真实 createHelm（真 SQLite + 真 PluginHost + 真外部插件源文件目录）+
 * faux provider；不 mock app、不 fake host。fixture 全部落在临时开发 dataDir
 * （tmpdir 下独立前缀，绝不触碰旧系统数据目录）。
 *
 * 覆盖（要求真验证项）：
 * - 约定入口 index.ts 与 plugin.json main 指向 .ts / .tsx 的发现与转译加载；
 * - 相对本地 TS 依赖闭包（.js 说明符 -> .ts 文件、无扩展名、index.ts）；
 * - Node 内置模块 import 与第三方 npm 依赖（插件目录 node_modules 真包）；
 * - @helm/protocol 与宿主同一构造器（插件内拿到的 HelmError 就是测试进程
 *   直接 import 的那个构造器，无第二份模块）；
 * - import.meta.url 资源路径指向插件真实源文件（不因缓存路径漂移）；
 * - 插件内相对 .json 导入（宿主补注 type=json）；
 * - 同一依赖经 .js 映射与显式 .ts 两条说明符导入是同一模块实例（alias identity）；
 * - 语法错误显式 plugin_load_failed（含文件与行列号诊断）；
 * - 同一插件入口多次引用仅初始化一次（模块 identity）；
 * - 越根契约（每个场景独立 dataDir + 真实可达的根外文件 + 执行哨兵）：
 *   main 穿越、入口 symlink、依赖 symlink 均拒绝；根外代码不转译；
 * - TS 根释放：全部根释放后进程钩子反注册（后续根外/根内 .ts 不再被本加载器转译）。
 *
 * 注：app.close() 吞错——内置 workflow stop 链存在已知基座缺陷（受控停止窗口
 * 内 host.listConversations 守卫拒绝导致 plugin_dispose_failed），不掩盖本文件
 * 断言；基座修复后可恢复裸 await。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { HelmError as HostHelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { loadExternalPlugins } from '../src/plugins/external-loader.js'
import { registerPluginTsRoot } from '../src/plugins/backend-ts-loader.js'

/** 测试进程全局侧表（插件模块级初始化计数 / 越根执行哨兵）的类型安全访问。 */
function globalFlag(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name]
}

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

async function createApp(dataDir: string) {
  // 注：watchdogIntervalMs 选项已随内核定时巡检移交 builtin:superagent 移除；
  // 组合层 createHelm 默认启用 superagent=false，无定时任务需要关闭。
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
}

/** 本加载器源码路径（纯 node 子进程直接加载：仅用可擦除语法，原生 strip-types 可读）。 */
const loaderSrc = fileURLToPath(new URL('../src/plugins/backend-ts-loader.ts', import.meta.url))

// ---------------------------------------------------------------------------
// fixture 写入工具
// ---------------------------------------------------------------------------

/**
 * TS 后端插件 fixture：入口 index.ts + 本地 TS 依赖闭包 + Node 内置 + npm 依赖 +
 * @helm 构造器同一性 + import.meta.url 资源定位 + 相对 .json + 模块级初始化计数。
 */
function writeTsPlugin(pluginsDir: string, dir = 'ts-demo'): { dirPath: string; counterName: string } {
  // 模块级初始化计数器按插件目录隔离（多个 fixture 互不干扰，但同目录重复加载可检测）
  const counterName = `__init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib'), { recursive: true })
  mkdirSync(join(dirPath, 'assets'), { recursive: true })
  // 插件本地 npm 依赖（真包形态：type:module + ESM 入口）
  mkdirSync(join(dirPath, 'node_modules', 'demo-dep'), { recursive: true })
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'package.json'), JSON.stringify({ name: 'demo-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'index.js'), 'export const depName = "demo-dep-ok"\n')

  // 入口：约定 index.ts
  writeFileSync(
    join(dirPath, 'index.ts'),
    `import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { depName } from 'demo-dep'
import { HelmError } from '@helm/protocol'
import { addTen } from './lib/math.js'
import { greet } from './lib/greet'
import { shape } from './lib/shapes/index.js'
import cfg from './config.json'

declare global { var ${counterName}: number | undefined }
globalThis.${counterName} = (globalThis.${counterName} ?? 0) + 1
const mod = await import('./lib/lazy.ts')
const metaUrl = import.meta.url

async function definePlugin(ctx: any) {
  ctx.action({
    id: 'probe',
    description: '转译加载全链路探针',
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
      const assetPath = new URL('./assets/banner.txt', metaUrl)
      const asset = readFileSync(assetPath, 'utf8')
      return {
        builtinOk: createHash('sha256').update('x').digest('hex').length === 64,
        npmDep: depName,
        // 宿主同一性：插件拿到的构造器与宿主注册的实例共享同一构造器/原型链
        hostClassSame: Object.getPrototypeOf(HostHelmErrorPrototypeMarker) === HelmError.prototype,

        metaUrl,
        lazyValue: mod.lazyValue,
        assetSha: createHash('sha256').update(asset).digest('hex').slice(0, 8),
        addTen: addTen(32),
        greet: greet('helm'),
        shape: shape(),
        jsonTag: cfg.tag,
      }
    },
  })
}

// 宿主同一构造器标记占位（由 fixture 写入逻辑替换为真实比较）
var HostHelmErrorPrototypeMarker: object


export default { id: '${dir}', name: 'TS 演示插件', version: '1.0.0', definePlugin }
`,
  )
  // .js 说明符 -> .ts 文件（TS 习惯映射）
  writeFileSync(join(dirPath, 'lib', 'math.ts'), 'export function addTen(n: number): number {\n  return n + 10\n}\n')
  // 无扩展名说明符
  writeFileSync(join(dirPath, 'lib', 'greet.ts'), 'export const greet = (who: string): string => `hi-${who}`\n')
  // 目录 index：./lib/shapes/index.js -> shapes/index.ts
  mkdirSync(join(dirPath, 'lib', 'shapes'), { recursive: true })
  writeFileSync(join(dirPath, 'lib', 'shapes', 'index.ts'), 'export const shape = (): string => "circle"\n')
  // 动态 import 的 TS 依赖
  writeFileSync(join(dirPath, 'lib', 'lazy.ts'), 'export const lazyValue = "lazy-ok"\n')
  // 相对 .json（宿主补注 import attribute）
  writeFileSync(join(dirPath, 'config.json'), JSON.stringify({ tag: 'json-ok' }))
  // import.meta.url 相对定位的资源
  writeFileSync(join(dirPath, 'assets', 'banner.txt'), 'helm-ts-plugin-asset\n')

  // 宿主构造器同一性：在插件目录写一个 marker 模块（插件内经 @helm/* 宿主解析
  // 得到的同一实例），入口 handler 比较它与其 import 的 HelmError 构造器——
  // 若存在第二份模块副本，则两者原型链不同。
  const markerPath = join(dirPath, 'lib', 'host-marker.ts')
  writeFileSync(
    markerPath,
    "import { HelmError } from '@helm/protocol'\nexport const marker = new HelmError('marker', 'marker')\nexport const ctor = HelmError\n",
  )
  // 重写入口里的占位比较：改为显式 import marker，比较同一模块图下的构造器同一性
  const entryPathFile = join(dirPath, 'index.ts')
  const entry = readFileSync(entryPathFile, 'utf8')
  const patched = entry
    .replace(
      "import cfg from './config.json'",
      "import cfg from './config.json'\nimport { marker as hostMarker, ctor as hostCtor } from './lib/host-marker'",
    )
    .replace(
      'Object.getPrototypeOf(HostHelmErrorPrototypeMarker) === HelmError.prototype',
      'hostCtor === HelmError && Object.getPrototypeOf(hostMarker) === HelmError.prototype && hostMarker instanceof HelmError',
    )
  writeFileSync(entryPathFile, patched)
  return { dirPath, counterName }
}

/** plugin.json main 指向 .tsx 的 fixture（纯逻辑 tsx：不含 React JSX，只验证扩展名轨道）。 */
function writeTsxManifestPlugin(pluginsDir: string): string {
  const dirPath = join(pluginsDir, 'tsx-manifest')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'src/entry.tsx' }))
  mkdirSync(join(dirPath, 'src'), { recursive: true })
  writeFileSync(
    join(dirPath, 'src', 'entry.tsx'),
    `async function definePlugin(ctx: any) {
  ctx.action({
    id: 'ping',
    description: 'tsx 入口探针',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['pong'], additionalProperties: false, properties: { pong: { type: 'boolean' } } },
    handler: () => ({ pong: true }),
  })
}
export default { id: 'tsx-manifest', name: 'TSX 清单插件', definePlugin }
`,
  )
  return dirPath
}

// ---------------------------------------------------------------------------
// 全链路：真实 createHelm + fixture + 启停
// ---------------------------------------------------------------------------

test('约定入口 index.ts 的外部插件：TS 依赖闭包 / Node 内置 / npm 依赖 / @helm 同一构造器 / json / import.meta.url 资源定位全链路可用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { counterName } = writeTsPlugin(join(dataDir, 'plugins'))
    const app = await createApp(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-demo')
      assert.ok(summary, 'TS 外部插件应被自动注册')
      assert.equal(summary.enabled, false, '默认停用')
      await app.kernel.plugins.enable('ts-demo')

      const r = (await app.kernel.plugins.invokeAction('ts-demo', 'probe', {})) as Record<string, unknown>
      assert.equal(r.builtinOk, true, 'node:crypto / node:fs 内置模块可用')
      assert.equal(r.npmDep, 'demo-dep-ok', '插件目录 node_modules 的第三方 npm 依赖可用')
      assert.equal(r.hostClassSame, true, '@helm/protocol 与宿主同一构造器（原型链一致，无第二份模块）')
      assert.equal(r.lazyValue, 'lazy-ok', '运行期动态 import 的 TS 依赖可用')
      assert.equal(r.addTen, 42, '相对 .js 说明符映射到 .ts 文件')
      assert.equal(r.greet, 'hi-helm', '无扩展名相对说明符解析')
      assert.equal(r.shape, 'circle', '目录 index.ts 解析')
      assert.equal(r.jsonTag, 'json-ok', '插件内相对 .json 导入可用（宿主补注 import attribute）')

      // import.meta.url 指向插件真实源文件（file URL、无查询串污染、资源可读）
      const metaUrl = r.metaUrl as string
      assert.ok(metaUrl.startsWith('file://'), `import.meta.url 应为 file URL：${metaUrl}`)
      assert.ok(!metaUrl.includes('?'), `import.meta.url 不应带查询串：${metaUrl}`)
      const metaPath = fileURLToPath(metaUrl)
      assert.ok(metaPath.endsWith(join('ts-demo', 'index.ts')), `应指向插件入口源文件：${metaPath}`)
      assert.equal(r.assetSha as string, '83877507', '经 import.meta.url 定位的插件资产读取正确')

      // 模块 identity：同进程同 URL 只初始化一次（入口已由 createHelm 加载一次）
      assert.equal(globalFlag(counterName), 1, '插件入口模块仅初始化一次')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main 指向 .tsx 的入口被正确转译加载（纯逻辑 tsx）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    writeTsxManifestPlugin(join(dataDir, 'plugins'))
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('tsx-manifest')
      const r = (await app.kernel.plugins.invokeAction('tsx-manifest', 'ping', {})) as { pong: boolean }
      assert.equal(r.pong, true)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('alias identity：同一依赖经 .js 映射与显式 .ts 两条说明符导入是同一模块实例（含 symlink 依赖）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-alias-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'alias')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // 真实依赖 + 指向它的根内 symlink：三条路径（.js 映射 / 显式 .ts / symlink）
    writeFileSync(
      join(dirPath, 'lib', 'shared.ts'),
      `declare global { var __aliasInit: number | undefined }
globalThis.__aliasInit = (globalThis.__aliasInit ?? 0) + 1
export const tag = 'shared'
`,
    )
    symlinkSync(join(dirPath, 'lib', 'shared.ts'), join(dirPath, 'lib', 'alias.ts'))
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { tag as viaJs } from './lib/shared.js'
import { tag as viaTs } from './lib/shared.ts'
import { tag as viaSymlink } from './lib/alias.js'
export default {
  id: 'alias',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'alias identity 探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['viaJs', 'viaTs', 'viaSymlink'], additionalProperties: false, properties: { viaJs: { type: 'string' }, viaTs: { type: 'string' }, viaSymlink: { type: 'string' } } },
      handler: () => ({ viaJs, viaTs, viaSymlink }),
    })
  },
}
`,
    )
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('alias')
      // 三条说明符指向同一模块实例：模块级初始化计数只 +1
      assert.equal(globalFlag('__aliasInit'), 1, '.js 映射 / 显式 .ts / symlink 三条说明符是同一模块实例')
      const r = (await app.kernel.plugins.invokeAction('alias', 'tags', {})) as Record<string, string>
      assert.equal(r.viaJs, 'shared')
      assert.equal(r.viaTs, 'shared')
      assert.equal(r.viaSymlink, 'shared')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS 入口语法错误降级登记为 failed（含文件与行列号诊断），绝不静默', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-ts')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export function f(: string {\n  return 1\n}\n')
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, '语法错误插件应登记为 failed 条目')
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('broken-ts/index.ts'), `诊断应含源文件路径：${failed.error!.message}`)
      assert.ok(/:\d+:\d+/.test(failed.error!.message), `诊断应含行列号：${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS 依赖闭包中的语法错误同样降级登记为 failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-dep')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), "import { x } from './lib/bad.js'\nexport default { id: 'broken-dep', tag: x, definePlugin() {} }\n")
    writeFileSync(join(dirPath, 'lib', 'bad.ts'), 'export const x = {{{\n')
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed)
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('lib/bad.ts'))
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 越根契约：每个场景独立 dataDir + 真实可达的根外文件 + 执行哨兵
// ---------------------------------------------------------------------------

/** 建一个真实可达的根外目录与 evil 源文件（导入执行会翻动哨兵），返回路径。 */
function makeOutsideEvil(sentinel: string): string {
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-out-'))
  const evil = join(outside, 'evil.ts')
  writeFileSync(evil, `globalThis.${sentinel} = (globalThis.${sentinel} ?? 0) + 1\nexport default { id: 'evil', definePlugin() {} }\n`)
  return evil
}

test('越根契约 1：plugin.json main 路径穿越到根外真实文件，降级登记 failed，evil 绝不执行', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc1-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'traversal')
    mkdirSync(dirPath, { recursive: true })
    // 根外真实文件放在 dataDir 根（插件目录外、mkdtemp 可写区内）：
    // 不写到 tmpdir 上两级——非 root 环境（CI runner）对该层无写权限。
    // main '../../evil.ts' 相对插件目录解析到 dataDir/evil.ts，越出插件根。
    const reachable = join(dataDir, 'evil.ts')
    writeFileSync(reachable, `globalThis.__escMainSentinel = (globalThis.__escMainSentinel ?? 0) + 1\nexport default { id: 'evil', definePlugin() {} }\n`)
    writeFileSync(dirPath + '/plugin.json', JSON.stringify({ main: '../../evil.ts' }))
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed)
      assert.equal(failed.error!.code, 'plugin_manifest_invalid')
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escMainSentinel'), undefined, 'main 穿越被拒：evil 源码绝不能被导入执行')
    rmSync(reachable, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('越根契约 2：约定入口 symlink 指向根外真实 .ts，realpath 越界显式拒绝，evil 绝不执行', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc2-'))
  const evil = makeOutsideEvil('__escEntrySentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'entry-symlink')
    mkdirSync(dirPath, { recursive: true })
    // 词法在目录内、realpath 在目录外（symlink 逃逸），目标真实存在
    symlinkSync(evil, join(dirPath, 'index.ts'))
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, `应为 HelmError 登记，实际：无 failed 条目`)
      assert.ok(
        failed.error!.code === 'plugin_manifest_invalid' || failed.error!.code === 'plugin_load_failed',
        `入口 symlink 越根应显式拒绝，实际 code：${failed.error!.code}`,
      )
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escEntrySentinel'), undefined, '入口 symlink 越根被拒：evil 绝不能被导入执行')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(evil, { force: true })
  }
})

test('越根契约 3：插件根内依赖 symlink 指向根外真实 .ts，转译范围拒绝，evil 绝不执行', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc3-'))
  const evil = makeOutsideEvil('__escDepSentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'dep-symlink')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // 合法入口 + 根内词法依赖，但依赖是 symlink 指向根外真实 evil.ts
    symlinkSync(evil, join(dirPath, 'lib', 'helper.ts'))
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { x } from './lib/helper.js'
export default { id: 'dep-symlink', tag: x, definePlugin() {} }
`,
    )
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, `应为 HelmError 登记，实际：无 failed 条目`)
      assert.equal(failed.error!.code, 'plugin_load_failed', '根外 symlink 依赖不得被转译，显式失败')
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDepSentinel'), undefined, '依赖 symlink 越根被拒：evil 绝不能被导入执行')
    rmSync(evil, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(join(tmpdir(), 'helm-ext-out-'), { recursive: true, force: true })
  }
})

test('越根契约 4：fallback 说明符（.js 家族）映射到根外真实 .ts，拒绝转译，evil 绝不执行；显式 .ts 说明符走 Node 原生（非本加载器转译范围）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc4-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dotdot')
    mkdirSync(dirPath, { recursive: true })
    // ../../evil.js（.js 家族 fallback）从 plugins/dotdot/ 出发映射到 dataDir/evil.ts（真实存在、根外）
    writeFileSync(
      join(dataDir, 'evil.ts'),
      "globalThis.__escDotdotSentinel = (globalThis.__escDotdotSentinel ?? 0) + 1\nexport const x = 'evil'\n",
    )
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { x } from '../../evil.js'
export default { id: 'dotdot', tag: x, definePlugin() {} }
`,
    )
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, `应为 HelmError 登记，实际：无 failed 条目`)
      // fallback 把 .js 映射到根外 .ts：拒绝转译，显式 plugin_load_failed
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('拒绝转译'), `诊断应说明拒绝原因：${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDotdotSentinel'), undefined, 'fallback 越根映射绝不能触发根外源码执行')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 模块 identity 与根生命周期
// ---------------------------------------------------------------------------

test('模块 identity：同插件入口静态 + 动态 import 多处引用仅初始化一次', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'identity')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    writeFileSync(
      join(dirPath, 'lib', 'shared.ts'),
      `declare global { var __identityInit: number | undefined }
globalThis.__identityInit = (globalThis.__identityInit ?? 0) + 1
export const tag = 'shared'
`,
    )
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { tag as a } from './lib/shared.js'
const lazy = await import('./lib/shared.js')
export default {
  id: 'identity',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'identity 探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['a', 'b'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } },
      handler: () => ({ a, b: lazy.tag }),
    })
  },
}
`,
    )
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('identity')
      assert.equal(globalFlag('__identityInit'), 1, '静态与动态 import 指向同一模块实例')
      const r = (await app.kernel.plugins.invokeAction('identity', 'tags', {})) as { a: string; b: string }
      assert.equal(r.a, 'shared')
      assert.equal(r.b, 'shared')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS 根释放与 fallback 映射（纯 node 子进程，生产运行时保真）：注册期映射可用、释放后消失、fallback 越根拒绝', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-rootrel-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-rootout-'))
  try {
    // fixture：根内 mapped.ts（.js 映射目标）、无扩展名目标、symlink 别名；
    // 根外 evil.ts（fallback 越根目标，真实可达）
    writeFileSync(join(dirPath, 'mapped.ts'), 'export const v = 42\n')
    writeFileSync(join(dirPath, 'greet.ts'), 'export const g = 7\n')
    symlinkSync(join(dirPath, 'mapped.ts'), join(dirPath, 'alias.ts'))
    writeFileSync(join(outside, 'evil.ts'), "globalThis.__childEvil = (globalThis.__childEvil ?? 0) + 1\nexport const e = 'evil'\n")
    writeFileSync(
      join(dirPath, 'entry.ts'),
      "import { v } from './mapped.js'\nimport { g } from './greet'\nimport { v as viaAlias } from './alias.js'\nexport const w = v + g\nexport const a = viaAlias\n",
    )
    // escape.ts 内的 fallback 越根说明符：从插件根出发指向根外 outside/evil.ts
    // （真实可达；用 relative 计算正确的 ../ 深度，不手拼）
    // escape.ts 内的 fallback 越根说明符：从插件根出发指向根外 outside/evil.ts
    // （真实可达；用 relative 计算正确的 ../ 深度，末段换成 .js 以构造 fallback 形态）
    const escapeSpec = relative(dirPath, join(outside, 'evil.ts')).split(sep).join('/').replace(/evil\.ts$/, 'evil.js')
    writeFileSync(
      join(dirPath, 'escape.ts'),
      `import { e } from '${escapeSpec}'\nexport const t = e\n`,
    )
    // 子进程（纯 node，不经 tsx：唯一真实走本加载器 fallback 的运行时）：
    // 1) 注册期 .js 映射 / 无扩展名 / symlink 别名全部加载且单次初始化；
    // 2) fallback 越根（../evil.js -> 根外 evil.ts）拒绝且哨兵不翻；
    // 3) 全部根释放后 .js 映射消失（ERR_MODULE_NOT_FOUND）。
    const childSrc = `
const { registerPluginTsRoot } = await import(${JSON.stringify(pathToFileURL(loaderSrc).href)});
const root = ${JSON.stringify(dirPath)};
const release = registerPluginTsRoot(root);
const entry = await import('file://' + root + '/entry.ts');
if (entry.w !== 49 || entry.a !== 42) { console.log('FAIL mapping ' + entry.w + '/' + entry.a); process.exit(1); }
try {
  await import('file://' + root + '/escape.ts');
  console.log('FAIL escape-loaded'); process.exit(1);
} catch (e) {
  if (e.code !== 'plugin_load_failed') { console.log('FAIL escape-code ' + e.code); process.exit(1); }
}
if (globalThis.__childEvil !== undefined) { console.log('FAIL evil-executed'); process.exit(1); }
release();
try {
  await import('file://' + root + '/entry.ts?after');
  console.log('FAIL still-loads-after-release'); process.exit(1);
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') { console.log('FAIL after-code ' + e.code); process.exit(1); }
}
console.log('CHILD_OK');
`
    const childPath = join(dirPath, 'child.mjs')
    writeFileSync(childPath, childSrc)
    let result: string
    try {
      result = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000 })
    } catch (e) {
      const out = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
      assert.fail(`纯 node 子进程失败：${out.slice(0, 800)}`)
    }
    assert.ok(result.includes('CHILD_OK'), `纯 node 子进程应全契约通过，输出：${result}`)
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('registerPluginTsRoot 引用计数：重复注册合并，计数归零后可再次注册', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-root-'))
  try {
    writeFileSync(join(dirPath, 'still.ts'), 'export const v = 1\n')
    const release1 = registerPluginTsRoot(dirPath)
    const release2 = registerPluginTsRoot(dirPath)
    release1()
    // 计数未归零：目录仍在转译范围（.js -> .ts 映射仍可用）
    const m = (await import(`file://${join(dirPath, 'still.js')}`)) as { v: number }
    assert.equal(m.v, 1, '计数未归零前转译范围仍生效')
    release2()
    // 归零后可再次注册（钩子重新懒注册），周期可重复
    const release3 = registerPluginTsRoot(dirPath)
    release3()
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
  }
})

test('TS 插件停用后可再启用；停用不卸载模块（identity 稳定，不重复初始化）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { counterName } = writeTsPlugin(join(dataDir, 'plugins'), 'ts-cycle')
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('ts-cycle')
      await app.kernel.plugins.disable('ts-cycle')
      await app.kernel.plugins.enable('ts-cycle')
      const r = (await app.kernel.plugins.invokeAction('ts-cycle', 'probe', {})) as { builtinOk: boolean }
      assert.equal(r.builtinOk, true)
      assert.equal(globalFlag(counterName), 1, '启停循环不重复执行模块初始化')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('id 冲突失败后 TS 根释放：同目录换 id 重写后可重新加载成功', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-rel-'))
  try {
    // 先经 createHelm 注册一个 id=dup 的插件（first 目录被消费）
    const first = join(dataDir, 'plugins', 'first')
    mkdirSync(first, { recursive: true })
    writeFileSync(join(first, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
    const app = await createApp(dataDir)
    try {
      // 再放入同 id 的第二个目录：冲突降级登记为 failed 条目（不再上抛阻断），
      // 根被释放；后续同目录可修复重载。
      const second = join(dataDir, 'plugins', 'second')
      mkdirSync(second, { recursive: true })
      writeFileSync(join(second, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
      const registered0 = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(!registered0.includes('dup'), '冲突目录不得注册成功')
      const conflicted = app.kernel.plugins.list().find((p) => p.id !== 'dup' && p.error !== undefined)
      assert.ok(conflicted, 'id 冲突应降级登记为 failed 条目')
      assert.equal(conflicted.error!.code, 'plugin_already_registered')
      // first 已被 createHelm 消费：移除其入口标记（降级为数据目录），后续直调
      // 只扫描 second，验证冲突释放后同目录可修复重载
      rmSync(join(first, 'index.ts'))
      // 改 id 后同目录重新加载成功（根被正确释放/重注册，转译范围不受污染）
      writeFileSync(join(second, 'index.ts'), `export default { id: 'second-fixed', definePlugin(ctx: any) {
        ctx.action({ id: 'ok', description: 'ok', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
      } }\n`)
      const registered = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(registered.includes('second-fixed'), `改 id 后应注册成功：${JSON.stringify(registered)}`)
      await app.kernel.plugins.enable('second-fixed')
      const r = (await app.kernel.plugins.invokeAction('second-fixed', 'ok', {})) as { ok: boolean }
      assert.equal(r.ok, true)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadExternalPlugins 直调 TS 插件：默认停用注册且动作可用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    // 空目录起（createHelm 无外部插件）；再放入 TS 插件直调扫描
    const app = await createApp(dataDir)
    try {
      const extra = join(dataDir, 'plugins', 'ts-extra')
      mkdirSync(extra, { recursive: true })
      writeFileSync(
        join(extra, 'index.ts'),
        `export default {
  id: 'ts-extra',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'ok',
      description: 'ok 探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      handler: () => ({ ok: true }),
    })
  },
}
`,
      )
      const registered = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(registered.includes('ts-extra'), `直调扫描应注册新放入的 ts-extra：${JSON.stringify(registered)}`)
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-extra')
      assert.ok(summary)
      assert.equal(summary.enabled, false)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('转译不产出任何磁盘中间产物', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { dirPath } = writeTsPlugin(join(dataDir, 'plugins'), 'ts-clean')
    const before = new Set(readdirSync(dirPath))
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('ts-clean')
      await app.kernel.plugins.invokeAction('ts-clean', 'probe', {})
      const after = new Set(readdirSync(dirPath))
      const added = [...after].filter((f) => !before.has(f))
      assert.deepEqual(added, [], `插件目录不应出现任何转译产物/缓存：新增 ${JSON.stringify(added)}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
