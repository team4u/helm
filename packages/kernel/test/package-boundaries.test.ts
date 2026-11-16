import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface PackageManifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: string | Record<string, unknown>
}

function workspacePackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => {
      const root = join(packagesDir, entry.name)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
      return { root, manifest }
    })
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'plugin-staging') return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx|mts|mjs)$/.test(entry.name) ? [path] : []
  })
}

function imports(file: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: Array<{ specifier: string; typeOnly: boolean }> = []
  const add = (node: ts.Node | undefined, typeOnly = false) => {
    if (node && ts.isStringLiteralLike(node)) result.push({ specifier: node.text, typeOnly })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly))
    if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, Boolean(node.isTypeOnly))
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0], false)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

const forbidden: Record<string, readonly string[]> = {
  '@helm/protocol': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build', '@helm/env-io'],
  '@helm/env-io': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/kernel': ['@helm/plugins', '@helm/hub', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/plugins': ['@helm/kernel', '@helm/hub', '@helm/web'],
  '@helm/plugin-build': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/plugin-client', '@helm/node'],
  '@helm/plugin-client': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/node': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/web': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/cli': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/test-kit': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build', '@helm/cli', '@helm/env-io'],
}

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

function hasPublicExport(manifest: PackageManifest, specifier: string): boolean {
  const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`
  const exports = manifest.exports
  if (exports === undefined || typeof exports === 'string') return subpath === '.'
  const keys = Object.keys(exports)
  if (keys.length === 0) return false
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.'
  return Object.entries(exports).some(([key, value]) => {
    if (value === null) return false
    const star = key.indexOf('*')
    return star === -1 ? key === subpath : subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1))
  })
}

test('生产包保持单向依赖，源码只通过已声明的公开包入口跨边界', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const names = new Set(packages.map(({ manifest }) => manifest.name))
  for (const name of ['@helm/kernel', '@helm/plugins', '@helm/hub', '@helm/plugin-client', '@helm/plugin-build', '@helm/env-io']) {
    assert.ok(names.has(name), `缺少独立包 ${name}`)
  }
  const violations: string[] = []
  for (const { root, manifest } of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
    if (manifest.name !== '@helm/test-kit' && '@helm/test-kit' in dependencies) {
      violations.push(`${manifest.name}: 生产依赖禁止包含测试工具包 @helm/test-kit`)
    }
    for (const name of forbidden[manifest.name] ?? []) {
      if (name in dependencies) violations.push(`${manifest.name}: 禁止依赖 ${name}`)
    }
    for (const file of sourceFiles(join(root, 'src'))) {
      for (const { specifier, typeOnly } of imports(file)) {
        const label = `${relative(packagesDir, file)}: ${specifier}`
        if (isAbsolute(specifier) || specifier.startsWith('file:')) {
          violations.push(`${label} 绝对路径绕过包入口`)
          continue
        }
        if (specifier.startsWith('.')) {
          const target = relative(root, resolve(dirname(file), specifier))
          if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) violations.push(`${label} 相对路径跨包`)
          continue
        }
        const target = packageName(specifier)
        if (!target.startsWith('@helm/')) continue
        if (target === '@helm/test-kit' && manifest.name !== '@helm/test-kit') violations.push(`${label} 生产源码禁止依赖测试工具包 @helm/test-kit`)
        if ((forbidden[manifest.name] ?? []).includes(target)) violations.push(`${label} 反向依赖`)
        if (manifest.name === '@helm/test-kit') {
          if (!typeOnly) violations.push(`${label} @helm/test-kit 仅允许 import type 跨包引用`)
        } else if (target !== manifest.name && !(target in dependencies)) {
          violations.push(`${label} 未声明生产依赖`)
        }
        if (/\/src(?:\/|$)/.test(specifier)) violations.push(`${label} 导入私有源码`)
        const targetManifest = packages.find(({ manifest: candidate }) => candidate.name === target)?.manifest
        if (targetManifest && !hasPublicExport(targetManifest, specifier)) violations.push(`${label} 未通过公开 exports 导入`)
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('内核不携带内置插件源码与插件专属构建依赖', { timeout: 60_000 }, () => {
  const kernel = workspacePackages().find(({ manifest }) => manifest.name === '@helm/kernel')!
  assert.ok(!existsSync(join(kernel.root, 'src/builtin-plugins')), '内置插件应属于独立包')
  for (const dependency of ['mermaid', 'cron-parser', 'esbuild', 'react', 'react-dom', 'lucide-react']) {
    assert.ok(!(dependency in (kernel.manifest.dependencies ?? {})), `内核不应依赖 ${dependency}`)
  }
})

test('workspace 生产依赖图无环', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const graph = new Map(packages.map(({ manifest }) => [manifest.name, Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })]))
  const visited = new Set<string>()
  const visit = (name: string, stack: string[]): void => {
    assert.ok(!stack.includes(name), `依赖成环：${[...stack, name].join(' -> ')}`)
    if (visited.has(name)) return
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...stack, name])
    }
    visited.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
})

function resolveRelativeSource(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [
    base,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function collectTransitiveLocalSources(entryFile: string): Set<string> {
  const visited = new Set<string>()
  const queue = [resolve(entryFile)]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (visited.has(current) || !existsSync(current)) continue
    visited.add(current)
    for (const { specifier } of imports(current)) {
      if (!specifier.startsWith('.')) continue
      const target = resolveRelativeSource(current, specifier)
      if (target && !visited.has(target)) queue.push(target)
    }
  }
  return visited
}

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

function isForbiddenBrowserRuntimeImport(specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return `禁止导入 Node 内置模块 ${specifier}`
  const bare = specifier.split('/')[0]!
  if (NODE_BUILTINS.has(bare)) return `禁止导入 Node 内置模块 ${specifier}`
  if (specifier.startsWith('@earendil-works/pi-')) return `禁止导入后端 SDK 模块 ${specifier}`
  return undefined
}

test('浏览器侧源码与 @helm/protocol/browser 传递闭包禁止导入 node:* / pi-* 或回流根入口', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const browserEntry = join(packagesDir, 'protocol/src/browser.ts')
  assert.ok(existsSync(browserEntry), '缺少 @helm/protocol/browser 入口文件')

  const protocolPluginFile = resolve(packagesDir, 'protocol/src/plugin.ts')
  const browserClosure = collectTransitiveLocalSources(browserEntry)
  if (browserClosure.has(protocolPluginFile)) {
    violations.push('protocol/src/browser.ts 传递闭包不得触达 protocol/src/plugin.ts')
  }
  for (const file of browserClosure) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
    }
  }

  for (const file of sourceFiles(join(packagesDir, 'plugin-client/src'))) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helm/protocol') {
        violations.push(`${relative(packagesDir, file)}: 必须从 @helm/protocol/browser 导入，禁止导入 @helm/protocol 根入口`)
      }
    }
  }

  const webSrcDir = join(packagesDir, 'web/src')
  for (const file of sourceFiles(webSrcDir)) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helm/protocol') {
        violations.push(`${relative(packagesDir, file)}: 必须从 @helm/protocol/browser 导入，禁止导入 @helm/protocol 根入口`)
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})

test('全仓 packages/*/src 零 any 与零 TS 类型抑制指令', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const suppressionPattern = /@(?:ts-ignore|ts-expect-error|ts-nocheck)\b/

  for (const { root } of workspacePackages()) {
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const seenComments = new Set<string>()

      const checkCommentRanges = (ranges: readonly ts.CommentRange[] | undefined) => {
        if (!ranges) return
        for (const range of ranges) {
          const key = `${range.pos}:${range.end}`
          if (seenComments.has(key)) continue
          seenComments.add(key)
          const snippet = text.slice(range.pos, range.end)
          const match = suppressionPattern.exec(snippet)
          if (match) {
            const { line } = source.getLineAndCharacterOfPosition(range.pos)
            violations.push(`${relative(packagesDir, file)}:${line + 1}: 禁止使用 ${match[0]}`)
          }
        }
      }

      const visit = (node: ts.Node): void => {
        checkCommentRanges(ts.getLeadingCommentRanges(text, node.getFullStart()))
        checkCommentRanges(ts.getTrailingCommentRanges(text, node.getEnd()))
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${relative(packagesDir, file)}:${line + 1}: 禁止使用 any 类型（as any / : any / <any>）`)
        }
        ts.forEachChild(node, visit)
      }

      visit(source)
      checkCommentRanges(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()))
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})
