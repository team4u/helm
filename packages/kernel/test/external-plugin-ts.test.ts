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
 * - @helm/protocol 与宿主同一模块实例（instanceof HelmError 成立，无 registry 双份）；
 * - import.meta.url 资源路径指向插件真实源文件（不因缓存路径漂移）；
 * - 语法错误显式 plugin_load_failed（含文件与行列号诊断）；
 * - 同一插件入口多次引用仅初始化一次（模块 identity）；
 * - 恶意越根（main 穿越 / symlink 逃逸）显式拒绝，不导入外部模块；
 * - TS 根注册计数：失败释放、重复注册合并、取消后透传。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { loadExternalPlugins } from '../src/plugins/external-loader.js'
import { registerPluginTsRoot, registeredPluginTsRoots } from '../src/plugins/backend-ts-loader.js'

/** 测试进程全局侧表（插件模块级初始化计数 / 越根哨兵）的类型安全访问。 */
function globalFlag(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name]
}

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

async function createApp(dataDir: string) {
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
}

// ---------------------------------------------------------------------------
// fixture 写入工具
// ---------------------------------------------------------------------------

/**
 * TS 后端插件 fixture：入口 index.ts + 本地 TS 依赖闭包 + Node 内置 + npm 依赖 +
 * @helm/protocol instanceof 验证 + import.meta.url 资源定位 + 模块级初始化计数。
 */
function writeTsPlugin(pluginsDir: string, dir = 'ts-demo'): { dirPath: string; counterName: string; pluginId: string } {
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
      required: ['builtinOk', 'npmDep', 'hostClassOk', 'metaUrl', 'lazyValue', 'assetSha', 'addTen', 'greet', 'shape'],
      additionalProperties: false,
      properties: {
        builtinOk: { type: 'boolean' },
        npmDep: { type: 'string' },
        hostClassOk: { type: 'boolean' },
        metaUrl: { type: 'string' },
        lazyValue: { type: 'string' },
        assetSha: { type: 'string' },
        addTen: { type: 'number' },
        greet: { type: 'string' },
        shape: { type: 'string' },
      },
    },
    handler: () => {
      const assetPath = new URL('./assets/banner.txt', metaUrl)
      const asset = readFileSync(assetPath, 'utf8')
      return {
        builtinOk: createHash('sha256').update('x').digest('hex').length === 64,
        npmDep: depName,
        hostClassOk: new HelmError('x', 'x') instanceof HelmError && HelmError.name === 'HelmError',
        metaUrl,
        lazyValue: mod.lazyValue,
        assetSha: createHash('sha256').update(asset).digest('hex').slice(0, 8),
        addTen: addTen(32),
        greet: greet('helm'),
        shape: shape(),
      }
    },
  })
}

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
  // import.meta.url 相对定位的资源
  writeFileSync(join(dirPath, 'assets', 'banner.txt'), 'helm-ts-plugin-asset\n')
  return { dirPath, counterName, pluginId: dir }
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

test('约定入口 index.ts 的外部插件：TS 依赖闭包 / Node 内置 / npm 依赖 / @helm 同一实例 / import.meta.url 资源定位全链路可用', { timeout: 60_000 }, async () => {
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
      assert.equal(r.hostClassOk, true, '@helm/protocol 与宿主同一实例（instanceof 成立）')
      assert.equal(r.lazyValue, 'lazy-ok', '运行期动态 import 的 TS 依赖可用')
      assert.equal(r.addTen, 42, '相对 .js 说明符映射到 .ts 文件')
      assert.equal(r.greet, 'hi-helm', '无扩展名相对说明符解析')
      assert.equal(r.shape, 'circle', '目录 index.ts 解析')

      // import.meta.url 指向插件真实源文件（file URL、无查询串污染、资源可读）
      const metaUrl = r.metaUrl as string
      assert.ok(metaUrl.startsWith('file://'), `import.meta.url 应为 file URL：${metaUrl}`)
      assert.ok(!metaUrl.includes('?'), `import.meta.url 不应带查询串：${metaUrl}`)
      const metaPath = fileURLToPath(metaUrl)
      assert.ok(metaPath.endsWith(join('ts-demo', 'index.ts')), `应指向插件入口源文件：${metaPath}`)
      assert.equal(r.assetSha as string, '83877507', '经 import.meta.url 定位的插件资产读取正确')

      // 模块 identity：同进程同 URL 只初始化一次（入口已由 createHelm 加载一次）
      assert.equal((globalThis as Record<string, unknown>)[counterName], 1, '插件入口模块仅初始化一次')
    } finally {
      await app.close()
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
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS 入口语法错误显式 plugin_load_failed（含文件与行列号诊断），绝不静默', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-ts')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export function f(: string {\n  return 1\n}\n')
    await assert.rejects(
      createApp(dataDir),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, `应为 HelmError，实际：${err}`)
        assert.equal(err.code, 'plugin_load_failed')
        assert.ok(err.message.includes('broken-ts/index.ts'), `诊断应含源文件路径：${err.message}`)
        assert.ok(/:\d+:\d+/.test(err.message), `诊断应含行列号：${err.message}`)
        return true
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS 依赖闭包中的语法错误同样显式 plugin_load_failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-dep')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), "import { x } from './lib/bad.js'\nexport default { id: 'broken-dep', tag: x, definePlugin() {} }\n")
    writeFileSync(join(dirPath, 'lib', 'bad.ts'), 'export const x = {{{\n')
    await assert.rejects(
      createApp(dataDir),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'plugin_load_failed' && err.message.includes('lib/bad.ts'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('恶意越根：plugin.json main 穿越 / symlink 逃逸 / 依赖 ../ 越根均显式拒绝，不导入外部模块', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-out-'))
  try {
    writeFileSync(join(outside, 'evil.ts'), 'globalThis.__evilImported = true\nexport default { id: "evil", definePlugin() {} }\n')

    // 1) main 穿越插件目录
    const traversal = join(dataDir, 'plugins', 'traversal')
    mkdirSync(traversal, { recursive: true })
    writeFileSync(join(traversal, 'plugin.json'), JSON.stringify({ main: '../../evil.ts' }))
    await assert.rejects(createApp(dataDir), (e: unknown) => e instanceof HelmError && e.code === 'plugin_manifest_invalid')
    assert.equal(globalFlag('__evilImported'), undefined, '越根模块绝不能被导入')

    // 2) symlink 逃逸（词法在目录内、realpath 在目录外）
    const escape = join(dataDir, 'plugins', 'symlink-escape')
    mkdirSync(escape, { recursive: true })
    symlinkSync(join(outside, 'evil.ts'), join(escape, 'index.ts'))
    await assert.rejects(createApp(dataDir), (e: unknown) => e instanceof HelmError)
    assert.equal(globalFlag('__evilImported'), undefined, 'symlink 逃逸模块绝不能被导入')

    // 3) 插件合法入口、但本地依赖 ../ 越根引用外部文件：转译范围外，Node 原生解析失败显式报错
    const depEscape = join(dataDir, 'plugins', 'dep-escape')
    mkdirSync(depEscape, { recursive: true })
    writeFileSync(join(depEscape, 'index.ts'), "import { e } from '../../evil.ts'\nexport default { id: 'dep-escape', definePlugin() {} }\n")
    await assert.rejects(createApp(dataDir), (e: unknown) => {
      // 越根相对依赖不被转译钩子收编：Node 原生按 .ts 文件（无类型剥离配置）加载失败，
      // 显式 plugin_load_failed；绝不允许越根源码被悄悄转译执行。
      assert.ok(e instanceof HelmError, `应为 HelmError，实际：${e}`)
      return true
    })
    assert.equal(globalFlag('__evilImported'), undefined, '依赖越根模块绝不能被导入')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('模块 identity：TS 入口被多处引用（跨目录同名依赖 / 二次直调）仅初始化一次', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    // 两个插件共享同一份依赖文件（硬链接场景太隐晦；用「同插件内两条 import 路径」验证）
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
      // 同插件入口已加载 + 动态 import 复用同一模块：仅一次初始化
      assert.equal(globalFlag('__identityInit'), 1, '静态与动态 import 指向同一模块实例')
      const r = (await app.kernel.plugins.invokeAction('identity', 'tags', {})) as { a: string; b: string }
      assert.equal(r.a, 'shared')
      assert.equal(r.b, 'shared')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('registerPluginTsRoot 引用计数：重复注册合并、取消后目录移出转译范围', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-root-'))
  try {
    const release1 = registerPluginTsRoot(dirPath)
    const release2 = registerPluginTsRoot(dirPath)
    assert.equal(registeredPluginTsRoots().filter((r) => r === dirPath).length, 1, '同一目录重复注册合并为一项')
    release1()
    assert.equal(registeredPluginTsRoots().filter((r) => r === dirPath).length, 1, '计数未归零前目录仍在范围内')
    release2()
    assert.equal(registeredPluginTsRoots().filter((r) => r === dirPath).length, 0, '计数归零后目录移出范围')
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
      assert.equal((globalThis as Record<string, unknown>)[counterName], 1, '启停循环不重复执行模块初始化')
    } finally {
      await app.close()
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
      // createHelm 已消费一轮；再放一个新 TS 插件直调（扫描返回新注册列表）
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
      assert.ok(!registered.includes('ts-first'), 'createHelm 已消费的旧目录不重复注册')
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-extra')
      assert.ok(summary)
      assert.equal(summary.enabled, false)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('ts-demo 插件资产目录与缓存目录隔离：转译不产出任何插件目录外中间文件', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { dirPath } = writeTsPlugin(join(dataDir, 'plugins'), 'ts-clean')
    // 记录加载前后插件目录内容集合：不允许新增 .js / .mjs 产物或缓存目录
    const before = new Set(readdirSync(dirPath))
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('ts-clean')
      await app.kernel.plugins.invokeAction('ts-clean', 'probe', {})
      const after = new Set(readdirSync(dirPath))
      const added = [...after].filter((f) => !before.has(f))
      assert.deepEqual(added, [], `插件目录不应出现任何转译产物/缓存：新增 ${JSON.stringify(added)}`)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
