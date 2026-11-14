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
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx|mts|mjs)$/.test(entry.name) ? [path] : []
  })
}

function imports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: string[] = []
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) result.push(node.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

const forbidden: Record<string, readonly string[]> = {
  '@helm/protocol': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/kernel': ['@helm/plugins', '@helm/hub', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/plugins': ['@helm/kernel', '@helm/hub', '@helm/web'],
  '@helm/plugin-build': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/plugin-client', '@helm/node'],
  '@helm/plugin-client': ['@helm/kernel', '@helm/hub', '@helm/web', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/node': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/plugin-client', '@helm/plugin-build'],
  '@helm/web': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/node', '@helm/plugin-build'],
  '@helm/cli': ['@helm/kernel', '@helm/hub', '@helm/plugins', '@helm/web', '@helm/node', '@helm/plugin-client', '@helm/plugin-build'],
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
  for (const name of ['@helm/kernel', '@helm/plugins', '@helm/hub', '@helm/plugin-client', '@helm/plugin-build']) {
    assert.ok(names.has(name), `缺少独立包 ${name}`)
  }
  const violations: string[] = []
  for (const { root, manifest } of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
    for (const name of forbidden[manifest.name] ?? []) {
      if (name in dependencies) violations.push(`${manifest.name}: 禁止依赖 ${name}`)
    }
    for (const file of sourceFiles(join(root, 'src'))) {
      for (const specifier of imports(file)) {
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
        if ((forbidden[manifest.name] ?? []).includes(target)) violations.push(`${label} 反向依赖`)
        if (target !== manifest.name && !(target in dependencies)) violations.push(`${label} 未声明生产依赖`)
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
