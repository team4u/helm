/**
 * 插件 CSS 编译器测试（v3：esbuild 原生 CSS bundling + 保留具名导出 __helmClientCss）。
 *
 * 覆盖（真实执行编译产物，不只字符串 includes）：
 * - 两份 CSS 依赖顺序合并且经 import 产物可执行读取；
 * - 本地 @import 合并进依赖 hash（变更触发重编译）；
 * - CSS 注释中的 @import / url() 不再被正则误杀；
 * - data: / https:// / 协议相对资源 URL 原样保留；
 * - 本地相对 / 根相对 / 片段资源 URL 显式拒绝并给出 data: 建议；
 * - CSS 符号链接逃逸与 @import 越根拒绝；
 * - 无 CSS 时不误产出保留导出；
 * - 插件自身占用保留导出名明确报错；
 * - 缓存版本失效（旧 v2 清单不复用，强制重编译）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFile, writeFile as writeFileCb } from 'node:fs'
import { promisify } from 'node:util'
import { compilePluginClientModule } from '../src/plugins/client-compiler.js'
import { HelmError, PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol'

const writeFileP = promisify(writeFileCb)
const readFileP = promisify(readFile)

let dataDir: string

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-plugin-css-'))
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** 写入最小插件源：index.tsx 依次 import 指定 CSS 与本地组件依赖。 */
async function writePluginSource(
  root: string,
  files: Record<string, string>,
  entryImports: string[],
): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }
  const importLines = entryImports.map((spec) => `import '${spec.slice(1, -1)}'`).join('\n')
  await writeFile(join(root, 'index.tsx'), `${importLines}\nexport function Widget() { return 'w' }\n`)
}

/** 真实执行编译产物（data: URL 动态 import），返回模块命名空间。 */
async function evalModule(code: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  return (await import(url)) as Record<string, unknown>
}

test('两份 CSS 依赖顺序合并：第一个 import 的规则先出现，且产物可执行读取', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'order-src')
  await writePluginSource(
    root,
    {
      'first.css': '.first-rule { color: red }',
      'dep.ts': "import '../order-src/second.css'\nexport const marker = 'dep'",
      'second.css': '.second-rule { color: blue }',
    },
    ["'./first.css'", "'./dep'"],
  )
  const result = await compilePluginClientModule('test:css-order', root, 'index.tsx', dataDir)
  const mod = await evalModule(result.code)
  const css = mod[PLUGIN_CLIENT_CSS_EXPORT]
  assert.equal(typeof css, 'string', '必须导出合并后的 CSS 字符串')
  const text = css as string
  assert.match(text, /first-rule/)
  assert.match(text, /second-rule/)
  const firstIdx = text.indexOf('.first-rule')
  const secondIdx = text.indexOf('.second-rule')
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx, '依赖顺序必须保留（first 先于 second）')
  assert.equal(typeof mod.Widget, 'function', '组件导出不受 CSS 影响')
})

test('本地 @import 合并进依赖 hash：被引样式变更后 hash 变化（重新编译）', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'import-hash-src')
  await writePluginSource(
    root,
    {
      'base.css': '.base { color: red }',
      'main.css': '@import "./base.css";\n.main { color: blue }',
    },
    ["'./main.css'"],
  )
  const before = await compilePluginClientModule('test:css-import-hash', root, 'index.tsx', dataDir)
  const modBefore = await evalModule(before.code)
  assert.match(modBefore[PLUGIN_CLIENT_CSS_EXPORT] as string, /\.base/)

  await writeFile(join(root, 'base.css'), '.base { color: green }')
  const after = await compilePluginClientModule('test:css-import-hash', root, 'index.tsx', dataDir)
  assert.notEqual(before.contentHash, after.contentHash, '本地 @import 依赖必须进 hash')
  const modAfter = await evalModule(after.code)
  assert.match(modAfter[PLUGIN_CLIENT_CSS_EXPORT] as string, /green/)
})

test('CSS 注释中的 @import / url() 不再被正则误杀', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'comment-src')
  await writePluginSource(
    root,
    {
      'styles.css': [
        '/* 旧实现用正则扫 @import 与 url(./local.png) 会误杀本注释 */',
        '/* @import "./other.css"; */',
        '.commented { color: red }',
      ].join('\n'),
    },
    ["'./styles.css'"],
  )
  const result = await compilePluginClientModule('test:css-comment', root, 'index.tsx', dataDir)
  const mod = await evalModule(result.code)
  const css = mod[PLUGIN_CLIENT_CSS_EXPORT] as string
  assert.match(css, /\.commented/, '注释不构成语法引用，样式本体必须保留')
})

test('data: / https: / 协议相对资源 URL 原样保留', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'asset-url-src')
  await writePluginSource(
    root,
    {
      'styles.css': [
        '.a { background: url(data:image/svg+xml;base64,AAA) }',
        '.b { background: url(https://example.com/i.png) }',
        '.c { background: url(//cdn.example.com/i.png) }',
      ].join('\n'),
    },
    ["'./styles.css'"],
  )
  const result = await compilePluginClientModule('test:css-asset-url', root, 'index.tsx', dataDir)
  const mod = await evalModule(result.code)
  const css = mod[PLUGIN_CLIENT_CSS_EXPORT] as string
  assert.match(css, /url\(data:image\/svg\+xml;base64,AAA\)/)
  assert.match(css, /url\(https:\/\/example\.com\/i\.png\)/)
  assert.match(css, /url\(\/\/cdn\.example\.com\/i\.png\)/)
})

test('本地相对 / 根相对 / 片段资源 URL 显式拒绝并建议 data:', { timeout: 60_000 }, async () => {
  for (const [label, decl] of [
    ['relative', '.x { background: url(./icon.png) }'],
    ['root-relative', '.x { background: url(/assets/icon.png) }'],
    ['fragment', '.x { fill: url(#grad) }'],
  ] as const) {
    const root = join(dataDir, `asset-bad-${label}-src`)
    await writePluginSource(root, { 'styles.css': decl }, ["'./styles.css'"])
    await assert.rejects(
      () => compilePluginClientModule(`test:css-bad-${label}`, root, 'index.tsx', dataDir),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'client_compile_failed' &&
        /url-token|被拒绝/.test(err.message) &&
        /data:/.test(err.message),
      `资源形态 ${label} 必须显式拒绝`,
    )
  }
})

test('CSS 符号链接逃逸拒绝：根内 symlink 指向根外样式', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helm-plugin-css-outside-'))
  try {
    await writeFile(join(outsideDir, 'evil.css'), '.evil { color: red }')
    const root = join(dataDir, 'symlink-src')
    await writePluginSource(root, {}, [])
    await symlink(join(outsideDir, 'evil.css'), join(root, 'linked.css'))
    await writeFile(join(root, 'index.tsx'), "import './linked.css'\nexport function Widget() { return 'w' }\n")
    await assert.rejects(
      () => compilePluginClientModule('test:css-symlink', root, 'index.tsx', dataDir),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'client_compile_failed' && /越出 clientRoot/.test(err.message),
    )
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('CSS @import 越根拒绝：../ 引用根外样式', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'import-escape-src', 'inner')
  await mkdir(root, { recursive: true })
  await writeFile(join(dataDir, 'import-escape-src', 'outside.css'), '.outside { color: red }')
  await writePluginSource(
    root,
    { 'main.css': '@import "../outside.css";\n.main { color: blue }' },
    ["'./main.css'"],
  )
  await assert.rejects(
    () => compilePluginClientModule('test:css-import-escape', root, 'index.tsx', dataDir),
    (err: unknown) =>
      err instanceof HelmError && err.code === 'client_compile_failed' && /越出 clientRoot/.test(err.message),
  )
})

test('无 CSS 时不误产出保留导出', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'no-css-src')
  await writePluginSource(root, { 'dep.ts': 'export const v = 1' }, ["'./dep'"])
  const result = await compilePluginClientModule('test:css-none', root, 'index.tsx', dataDir)
  const mod = await evalModule(result.code)
  assert.equal(mod[PLUGIN_CLIENT_CSS_EXPORT], undefined, '无 CSS 时不得导出保留名（加载器按空处理）')
  assert.equal(typeof mod.Widget, 'function')
})

test('保留导出冲突：插件自身占用 __helmClientCss 明确报错', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'conflict-src')
  await writePluginSource(root, { 'styles.css': '.c { color: red }' }, ["'./styles.css'"])
  await writeFile(
    join(root, 'index.tsx'),
    "import './styles.css'\nexport const __helmClientCss = 'mine'\nexport function Widget() { return 'w' }\n",
  )
  await assert.rejects(
    () => compilePluginClientModule('test:css-conflict', root, 'index.tsx', dataDir),
    (err: unknown) =>
      err instanceof HelmError &&
      err.code === 'client_compile_failed' &&
      /保留导出名|冲突/.test(err.message) &&
      err.message.includes(PLUGIN_CLIENT_CSS_EXPORT),
  )
})

test('未导出的同名局部变量不撞名：entry 内 const __helmClientCss 被组件引用仍可编译求值', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'shadow-src')
  await writePluginSource(root, { 'styles.css': '.shadow { color: red }' }, ["'./styles.css'"])
  await writeFile(
    join(root, 'index.tsx'),
    [
      "import './styles.css'",
      // 未导出的局部同名变量会留存于 bundle（metafile exports 检测不到）：
      // 编译器附贴的 CSS 绑定必须避让它，绝不形成重复声明
      "const __helmClientCss = 'plugin-local-value'",
      "export function Widget() { return typeof __helmClientCss + ':' + __helmClientCss }",
      "export const __helmCssText = 'also-local'",
      "export function ShadowWidget() { return __helmCssText }",
    ].join('\n'),
  )
  const result = await compilePluginClientModule('test:css-shadow', root, 'index.tsx', dataDir)
  // 产物必须可执行（撞名会直接 SyntaxError）
  const mod = await evalModule(result.code)
  assert.equal(typeof mod.Widget, 'function')
  assert.equal((mod.Widget as () => string)(), 'string:plugin-local-value', '局部变量语义不受影响')
  assert.equal((mod.__helmCssText as unknown), 'also-local')
  assert.equal((mod.ShadowWidget as () => string)(), 'also-local')
  // 保留导出返回编译器合并的样式而非局部变量
  const css = mod[PLUGIN_CLIENT_CSS_EXPORT] as string
  assert.match(css, /\.shadow/)
  assert.ok(!css.includes('plugin-local-value'))
})

test('缓存版本失效：旧 v2 清单（CSS-as-JS 时代）不复用，强制重编译', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'cache-version-src')
  await writePluginSource(root, { 'styles.css': '.v3 { color: red }' }, ["'./styles.css'"])
  const fresh = await compilePluginClientModule('test:css-cache-version', root, 'index.tsx', dataDir)

  // 篡改磁盘上的依赖清单为 v2 旧格式（模拟历史缓存）：必须被识别为失效并重编译。
  // staging 目录名含 safeDirName 哈希后缀，直接扫描定位 deps.json 与产物。
  const { createHash } = await import('node:crypto')
  const safe = 'test_css-cache-version'.replace(/[^A-Za-z0-9_-]/g, '_')
  const suffix = createHash('sha1').update('test:css-cache-version').digest('hex').slice(0, 6)
  const stagingDir = join(dataDir, 'plugin-staging', `${safe}-${suffix}`)
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(stagingDir)
  const depsFile = files.find((f) => f.endsWith('.deps.json'))
  assert.ok(depsFile, '依赖清单必须已落盘')
  const realListPath = join(stagingDir, depsFile as string)
  const list = JSON.parse(await readFileP(realListPath, 'utf8')) as { version: number; contentHash: string }
  assert.equal(list.version, 3, '新缓存清单版本为 v3')
  await writeFileP(realListPath, `${JSON.stringify({ ...list, version: 2 })}\n`)

  // 再把产物改成“旧格式毒丸”：若 v2 清单被复用会原样返回毒丸；v3 校验必须重编译
  const codeFile = files.find((f) => f.endsWith('.mjs'))
  assert.ok(codeFile)
  await writeFileP(join(stagingDir, codeFile as string), 'export const POISON = 1\n')

  const after = await compilePluginClientModule('test:css-cache-version', root, 'index.tsx', dataDir)
  assert.equal(after.contentHash, fresh.contentHash)
  assert.equal(after.code, fresh.code, 'v2 清单必须失效，绝不复用旧毒丸产物')
  const mod = await evalModule(after.code)
  assert.match(mod[PLUGIN_CLIENT_CSS_EXPORT] as string, /\.v3/)
})
