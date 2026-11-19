/**
 * 架构边界守护：@helmx/plugins 源码只能依赖「包内相对导入 + 公开包
 * （@helmx/protocol / @helmx/plugin-client / SDK / 前端受控依赖 / node 内置）」，
 * 不得越出本包 src 目录，也不得经包名或相对路径导入 @helmx/kernel /
 * @helmx/hub（插件不依赖内核实现，产品组合归组合根）。
 *
 * 防呆（防测试自身空洞）：扫描到的文件数与导入数做下限断言——目录
 * 改名后本测试必须显式失败，而不是静默变成零扫描。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginsSrc = join(pkgRoot, 'src')

/** 禁止经包名触达的宿主/兄弟包（插件不依赖 kernel 实现与 hub 组合）。 */
const FORBIDDEN_PACKAGES = ['@helmx/kernel', '@helmx/hub'] as const

/** 递归收集 plugins/src 下全部源码文件（.ts/.tsx）。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full)
    }
  }
  return out
}

/** 提取文件中全部静态/动态 import 说明符（含 export ... from 与副作用导入）。 */
function importSpecifiersOf(source: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1]!)
    }
  }
  return specs
}

interface Violation {
  file: string
  spec: string
  reason: string
}

describe('@helmx/plugins 架构边界守护', () => {
  it('扫描根与磁盘实际一致（目录改名后本测试须显式失败）', { timeout: 60_000 }, () => {
    assert.ok(existsSync(pluginsSrc), `plugins src 目录不存在：${pluginsSrc}`)
  })

  it('plugins 源码导入零越界（不越出包 src、不导入 kernel/hub）', { timeout: 60_000 }, () => {
    const files = collectSourceFiles(pluginsSrc)
    // 防呆：扫描必须有实质产出（防路径错误导致零扫描静默通过）。
    assert.ok(files.length >= 20, `plugins 源码文件数异常（${files.length} < 20），扫描可能指向了错误目录`)
    for (const known of ['workflow.ts', 'superagent.ts', 'profile.ts', join('workflow', 'worktree.ts')]) {
      assert.ok(files.some((f) => f === join(pluginsSrc, known)), `未扫描到已知源码文件 ${known}（扫描器异常）`)
    }

    const violations: Violation[] = []
    let relativeImportCount = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const spec of importSpecifiersOf(source)) {
        // 规则一：不得经包名导入内核实现或产品组合根（通用能力应下沉 @helmx/protocol）。
        const forbidden = FORBIDDEN_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`))
        if (forbidden !== undefined) {
          violations.push({ file, spec, reason: `插件包禁止依赖 ${forbidden}（内核机制经 PluginDefinition 契约注入，组合归 @helmx/hub）` })
          continue
        }
        if (!spec.startsWith('.')) continue
        relativeImportCount += 1
        const resolved = resolve(dirname(file), spec)
        const rel = relative(pluginsSrc, resolved)
        // 越出包 src：relative 结果回退到 '..'（或跨盘等绝对形态）。
        const escapes = rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        if (escapes) {
          // 规则二：相对导入不得越出 @helmx/plugins 包 src 目录（../../kernel 等一律拒绝）。
          violations.push({
            file,
            spec,
            reason: '相对导入越出 @helmx/plugins src（跨边界依赖只允许 @helmx/protocol 等公开包）',
          })
        }
      }
    }
    // 防呆：必须实际解析到相对导入（正则失效会导致扫描空洞）。
    assert.ok(relativeImportCount >= 10, `相对导入解析数异常（${relativeImportCount} < 10），import 提取正则可能失效`)
    if (violations.length > 0) {
      const detail = violations.map((v) => `${relative(pluginsSrc, v.file)}: ${v.spec}\n  -> ${v.reason}`).join('\n')
      assert.fail(`@helmx/plugins 存在 ${violations.length} 处越界导入：\n${detail}`)
    }
  })

  it('superagent/watchdog.ts 对包内 diagnostics 的导入合法（边界内相对导入不误报）', { timeout: 60_000 }, () => {
    const file = join(pluginsSrc, 'superagent', 'watchdog.ts')
    const source = readFileSync(file, 'utf8')
    assert.ok(
      importSpecifiersOf(source).includes('../diagnostics.js'),
      'watchdog.ts 应包含 ../diagnostics.js 导入（若已重构请同步本守护样例）',
    )
    const resolved = resolve(dirname(file), '../diagnostics.js')
    const rel = relative(pluginsSrc, resolved)
    assert.ok(!rel.startsWith('..'), `diagnostics.js 应位于 @helmx/plugins src 内（实际解析到 ${resolved}）`)
  })
})
