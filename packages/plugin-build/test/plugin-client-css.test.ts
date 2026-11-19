/**
 * Plugin CSS compiler tests (v3: esbuild native CSS bundling + the reserved named export __helmxClientCss).
 *
 * Coverage (really executes the compiled artifact, not just string includes):
 * - two CSS dependencies merge in dependency order and the artifact is executable and readable via import;
 * - local @import joins the dependency hash (a change triggers recompilation);
 * - @import / url() inside CSS comments are no longer falsely killed by regex;
 * - data: / https: / protocol-relative asset URLs are preserved verbatim;
 * - local relative / root-relative / fragment asset URLs are explicitly rejected with a data: suggestion;
 * - CSS symlink escape and @import out-of-root are rejected;
 * - no reserved export is wrongly produced when there is no CSS;
 * - a plugin occupying the reserved export name itself fails loudly;
 * - cache version invalidation (an old v3 manifest is not reused, forcing recompilation).
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFile, writeFile as writeFileCb } from 'node:fs'
import { promisify } from 'node:util'
import { compilePluginClientModule } from '../src/index.js'
import { HelmxError, PLUGIN_CLIENT_CSS_EXPORT } from '@helmx/protocol'

const writeFileP = promisify(writeFileCb)
const readFileP = promisify(readFile)

let dataDir: string

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-css-'))
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** Writes a minimal plugin source: index.tsx imports the given CSS and local component dependencies in order. */
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

/** Really executes the compiled artifact (data: URL dynamic import) and returns the module namespace. */
async function evalModule(code: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  return (await import(url)) as Record<string, unknown>
}

test('two CSS dependencies merge in order: the first import\'s rules appear first, and the artifact is executable and readable', { timeout: 60_000 }, async () => {
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
  assert.equal(typeof css, 'string', 'must export the merged CSS string')
  const text = css as string
  assert.match(text, /first-rule/)
  assert.match(text, /second-rule/)
  const firstIdx = text.indexOf('.first-rule')
  const secondIdx = text.indexOf('.second-rule')
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx, 'dependency order must be preserved (first before second)')
  assert.equal(typeof mod.Widget, 'function', 'component exports are unaffected by CSS')
})

test('local @import joins the dependency hash: the hash changes after an imported style changes (recompile)', { timeout: 60_000 }, async () => {
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
  assert.notEqual(before.contentHash, after.contentHash, 'local @import dependencies must join the hash')
  const modAfter = await evalModule(after.code)
  assert.match(modAfter[PLUGIN_CLIENT_CSS_EXPORT] as string, /green/)
})

test('@import / url() inside CSS comments are no longer falsely killed by regex', { timeout: 60_000 }, async () => {
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
  assert.match(css, /\.commented/, 'comments are not syntactic references; the style body must be preserved')
})

test('data: / https: / protocol-relative asset URLs are preserved verbatim', { timeout: 60_000 }, async () => {
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

test('local relative / root-relative / fragment asset URLs are explicitly rejected with a data: suggestion', { timeout: 60_000 }, async () => {
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
        err instanceof HelmxError &&
        err.code === 'client_compile_failed' &&
        /asset reference/.test(err.message) &&
        /rejected/.test(err.message) &&
        /data:/.test(err.message),
      `asset form ${label} must be explicitly rejected`,
    )
  }
})

test('nested @import in inline CSS also passes through the asset boundary and cannot bypass the remote-reference rejection', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'inline-import-src')
  const nested = `data:text/css,${encodeURIComponent('@import "https://example.com/remote.css"; .nested { color: red }')}`
  await writePluginSource(root, { 'styles.css': `@import "${nested}";\n.local { color: blue }` }, ["'./styles.css'"])
  await assert.rejects(
    () => compilePluginClientModule('test:css-inline-import', root, 'index.tsx', dataDir),
    (error: unknown) => error instanceof HelmxError && error.code === 'client_compile_failed' && /remote @import/.test(error.message),
  )
})

test('CSS symlink escape rejected: an in-root symlink pointing at an out-of-root stylesheet', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-css-outside-'))
  try {
    await writeFile(join(outsideDir, 'evil.css'), '.evil { color: red }')
    const root = join(dataDir, 'symlink-src')
    await writePluginSource(root, {}, [])
    await symlink(join(outsideDir, 'evil.css'), join(root, 'linked.css'))
    await writeFile(join(root, 'index.tsx'), "import './linked.css'\nexport function Widget() { return 'w' }\n")
    await assert.rejects(
      () => compilePluginClientModule('test:css-symlink', root, 'index.tsx', dataDir),
      (err: unknown) =>
        err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
    )
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('CSS @import out-of-root rejected: ../ referencing a stylesheet outside the root', { timeout: 60_000 }, async () => {
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
      err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )
})

test('no reserved export is wrongly produced when there is no CSS', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'no-css-src')
  await writePluginSource(root, { 'dep.ts': 'export const v = 1' }, ["'./dep'"])
  const result = await compilePluginClientModule('test:css-none', root, 'index.tsx', dataDir)
  const mod = await evalModule(result.code)
  assert.equal(mod[PLUGIN_CLIENT_CSS_EXPORT], undefined, 'the reserved name must not be exported without CSS (the loader treats it as empty)')
  assert.equal(typeof mod.Widget, 'function')
})

test('reserved export conflict: a plugin occupying __helmxClientCss itself fails loudly', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'conflict-src')
  await writePluginSource(root, { 'styles.css': '.c { color: red }' }, ["'./styles.css'"])
  await writeFile(
    join(root, 'index.tsx'),
    "import './styles.css'\nexport const __helmxClientCss = 'mine'\nexport function Widget() { return 'w' }\n",
  )
  await assert.rejects(
    () => compilePluginClientModule('test:css-conflict', root, 'index.tsx', dataDir),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'client_compile_failed' &&
      /reserved compiler export name/.test(err.message) &&
      err.message.includes(PLUGIN_CLIENT_CSS_EXPORT),
  )
})

test('reserved-export validation uses module metadata: neither no-CSS nor a trailing license comment allows occupying it', { timeout: 60_000 }, async () => {
  for (const withCss of [false, true]) {
    const root = join(dataDir, `metadata-conflict-${withCss}`)
    await writePluginSource(root, { 'styles.css': '.reserved { color: red }' }, [])
    await writeFile(join(root, 'index.tsx'), [
      ...(withCss ? ["import './styles.css'"] : []),
      "const value = 'not-managed-css'",
      `export { value as ${PLUGIN_CLIENT_CSS_EXPORT} }`,
      '/*! 保留的尾部许可证注释 */',
    ].join('\n'))
    await assert.rejects(
      () => compilePluginClientModule(`test:css-reserved-${withCss}`, root, 'index.tsx', dataDir),
      (error: unknown) => error instanceof HelmxError && error.code === 'client_compile_failed' && error.message.includes(PLUGIN_CLIENT_CSS_EXPORT),
      `withCss=${withCss} must both reject the reserved export name at the compile boundary`,
    )
  }
})

test('an unexported same-named local variable does not collide: const __helmxClientCss inside the entry still compiles and evaluates while referenced by the component', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'shadow-src')
  await writePluginSource(root, { 'styles.css': '.shadow { color: red }' }, ["'./styles.css'"])
  await writeFile(
    join(root, 'index.tsx'),
    [
      "import './styles.css'",
      // an unexported local same-named variable survives in the bundle (metafile exports can't detect it):
      // the compiler-attached CSS binding must avoid it and never form a duplicate declaration
      "const __helmxClientCss = 'plugin-local-value'",
      "export function Widget() { return typeof __helmxClientCss + ':' + __helmxClientCss }",
      "export const __helmxCssText = 'also-local'",
      "export function ShadowWidget() { return __helmxCssText }",
    ].join('\n'),
  )
  const result = await compilePluginClientModule('test:css-shadow', root, 'index.tsx', dataDir)
  // the artifact must stay executable (a name collision would be an immediate SyntaxError)
  const mod = await evalModule(result.code)
  assert.equal(typeof mod.Widget, 'function')
  assert.equal((mod.Widget as () => string)(), 'string:plugin-local-value', 'local variable semantics are unaffected')
  assert.equal((mod.__helmxCssText as unknown), 'also-local')
  assert.equal((mod.ShadowWidget as () => string)(), 'also-local')
  // the reserved export returns the compiler-merged styles, not the local variable
  const css = mod[PLUGIN_CLIENT_CSS_EXPORT] as string
  assert.match(css, /\.shadow/)
  assert.ok(!css.includes('plugin-local-value'))
})

test('cache version invalidation: an old v5 manifest is not reused, forcing recompilation', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'cache-version-src')
  await writePluginSource(root, { 'styles.css': '.v3 { color: red }' }, ["'./styles.css'"])
  const fresh = await compilePluginClientModule('test:css-cache-version', root, 'index.tsx', dataDir)

  // Tamper the on-disk dependency manifest into the old v5 format (simulating a historical cache): it
  // must be recognized as invalid and recompiled. The staging directory name carries a safeDirName hash
  // suffix, so scan directly to locate deps.json and the artifact.
  const { createHash } = await import('node:crypto')
  const safe = 'test_css-cache-version'.replace(/[^A-Za-z0-9_-]/g, '_')
  const suffix = createHash('sha1').update('test:css-cache-version').digest('hex').slice(0, 6)
  const stagingDir = join(dataDir, 'plugin-staging', `${safe}-${suffix}`)
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(stagingDir)
  const depsFile = files.find((f) => f.endsWith('.deps.json'))
  assert.ok(depsFile, 'the dependency manifest must already be on disk')
  const realListPath = join(stagingDir, depsFile as string)
  const list = JSON.parse(await readFileP(realListPath, 'utf8')) as { version: number; contentHash: string }
  assert.equal(list.version, 8, 'the new cache manifest version is v8 (controlled npm dependency declarations join the cache credentials)')
  await writeFileP(realListPath, `${JSON.stringify({ ...list, version: 5 })}\n`)

  // then poison the artifact into an "old-format pill": reusing the v5 manifest would return the pill
  // verbatim; the version check must force a recompile
  const codeFile = files.find((f) => f.endsWith('.mjs'))
  assert.ok(codeFile)
  await writeFileP(join(stagingDir, codeFile as string), 'export const POISON = 1\n')

  const after = await compilePluginClientModule('test:css-cache-version', root, 'index.tsx', dataDir)
  assert.equal(after.contentHash, fresh.contentHash)
  assert.equal(after.code, fresh.code, 'an old-version manifest must be invalidated; never reuse the old poisoned artifact')
  const mod = await evalModule(after.code)
  assert.match(mod[PLUGIN_CLIENT_CSS_EXPORT] as string, /\.v3/)
})
