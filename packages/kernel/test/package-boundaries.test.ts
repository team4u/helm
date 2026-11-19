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
  devDependencies?: Record<string, string>
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
  '@helm/protocol': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build', '@helm/env-io', '@helm/hub-launcher'],
  '@helm/env-io': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build', '@helm/hub-launcher'],
  '@helm/kernel': ['@helm/plugins', '@helm/hub', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/plugins': ['@helm/kernel', '@helm/hub', '@helm/web'],
  '@helm/plugin-build': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/plugin-client', '@helm/node'],
  '@helm/plugin-client': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/node': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/web': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/cli': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/hub-launcher': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/cli', '@helm/plugin-client', '@helm/plugin-build', '@helm/payload'],
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

test('production packages maintain one-way dependencies and cross boundaries only via declared public exports', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const names = new Set(packages.map(({ manifest }) => manifest.name))
  for (const name of ['@helm/kernel', '@helm/plugins', '@helm/hub', '@helm/plugin-client', '@helm/plugin-build', '@helm/env-io', '@helm/hub-launcher']) {
    assert.ok(names.has(name), `missing standalone package ${name}`)
  }
  const violations: string[] = []
  for (const { root, manifest } of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
    if (manifest.name !== '@helm/test-kit' && '@helm/test-kit' in dependencies) {
      violations.push(`${manifest.name}: production dependencies must not include test-kit package @helm/test-kit`)
    }
    if (manifest.name === '@helm/plugins' && '@helm/plugin-client' in dependencies) {
      violations.push('@helm/plugins: browser SDK @helm/plugin-client must stay in devDependencies, not production dependencies')
    }
    for (const name of forbidden[manifest.name] ?? []) {
      if (name in dependencies) violations.push(`${manifest.name}: forbidden dependency ${name}`)
    }
    for (const file of sourceFiles(join(root, 'src'))) {
      const isPluginsBrowserClient =
        manifest.name === '@helm/plugins' &&
        /\/src\/[^/]+\/client\//.test(file.replaceAll(sep, '/'))
      for (const { specifier, typeOnly } of imports(file)) {
        const label = `${relative(packagesDir, file)}: ${specifier}`
        if (isAbsolute(specifier) || specifier.startsWith('file:')) {
          violations.push(`${label} absolute path bypasses package entry`)
          continue
        }
        if (specifier.startsWith('.')) {
          const target = relative(root, resolve(dirname(file), specifier))
          if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) violations.push(`${label} relative path crosses package boundary`)
          continue
        }
        const target = packageName(specifier)
        if (!target.startsWith('@helm/')) continue
        if (target === '@helm/test-kit' && manifest.name !== '@helm/test-kit') violations.push(`${label} production source must not import test-kit package @helm/test-kit`)
        if ((forbidden[manifest.name] ?? []).includes(target)) violations.push(`${label} reverse dependency`)
        if (manifest.name === '@helm/test-kit') {
          if (!typeOnly) violations.push(`${label} @helm/test-kit only allows import type for cross-package references`)
        } else if (isPluginsBrowserClient && target === '@helm/plugin-client') {
          if (!(target in (manifest.devDependencies ?? {}))) {
            violations.push(`${label} undeclared devDependency @helm/plugin-client`)
          }
        } else if (target !== manifest.name && !(target in dependencies)) {
          violations.push(`${label} undeclared production dependency`)
        }
        if (/\/src(?:\/|$)/.test(specifier)) violations.push(`${label} imports private source code`)
        const targetManifest = packages.find(({ manifest: candidate }) => candidate.name === target)?.manifest
        if (targetManifest && !hasPublicExport(targetManifest, specifier)) violations.push(`${label} not imported via public exports`)
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('kernel contains no builtin-plugin sources and no plugin-only dependencies', { timeout: 60_000 }, () => {
  const kernel = workspacePackages().find(({ manifest }) => manifest.name === '@helm/kernel')!
  assert.ok(!existsSync(join(kernel.root, 'src/builtin-plugins')), 'builtin plugins must belong to a separate package')
  for (const dependency of ['mermaid', 'cron-parser', 'esbuild', 'react', 'react-dom', 'lucide-react']) {
    assert.ok(!(dependency in (kernel.manifest.dependencies ?? {})), `kernel must not depend on ${dependency}`)
  }
})

test('workspace production dependency graph is acyclic', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const graph = new Map(packages.map(({ manifest }) => [manifest.name, Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })]))
  const visited = new Set<string>()
  const visit = (name: string, stack: string[]): void => {
    assert.ok(!stack.includes(name), `dependency cycle: ${[...stack, name].join(' -> ')}`)
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
  if (specifier.startsWith('node:')) return `forbidden import of Node builtin module ${specifier}`
  const bare = specifier.split('/')[0]!
  if (NODE_BUILTINS.has(bare)) return `forbidden import of Node builtin module ${specifier}`
  if (specifier.startsWith('@earendil-works/pi-')) return `forbidden import of backend SDK module ${specifier}`
  return undefined
}

test('browser sources and @helm/protocol/browser transitive closure never import node:* / pi-* / backend entries', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const browserEntry = join(packagesDir, 'protocol/src/browser.ts')
  assert.ok(existsSync(browserEntry), 'missing @helm/protocol/browser entry file')

  const protocolPluginFile = resolve(packagesDir, 'protocol/src/plugin.ts')
  const browserClosure = collectTransitiveLocalSources(browserEntry)
  if (browserClosure.has(protocolPluginFile)) {
    violations.push('protocol/src/browser.ts transitive closure must not reach protocol/src/plugin.ts')
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
        violations.push(`${relative(packagesDir, file)}: must import from @helm/protocol/browser rather than @helm/protocol`)
      }
    }
  }

  const webSrcDir = join(packagesDir, 'web/src')
  for (const file of sourceFiles(webSrcDir)) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helm/protocol') {
        violations.push(`${relative(packagesDir, file)}: must import from @helm/protocol/browser rather than @helm/protocol`)
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})

test('all workspace packages/*/src contain zero any types and zero TS suppression directives', { timeout: 60_000 }, () => {
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
            violations.push(`${relative(packagesDir, file)}:${line + 1}: forbidden use of ${match[0]}`)
          }
        }
      }

      const visit = (node: ts.Node): void => {
        checkCommentRanges(ts.getLeadingCommentRanges(text, node.getFullStart()))
        checkCommentRanges(ts.getTrailingCommentRanges(text, node.getEnd()))
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${relative(packagesDir, file)}:${line + 1}: forbidden use of explicit any type (as any / : any / <any>)`)
        }
        ts.forEachChild(node, visit)
      }

      visit(source)
      checkCommentRanges(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()))
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})
