/**
 * 架构边界守护：builtin-plugins 只能依赖「目录内相对导入 + 公开包
 * （@helm/protocol / SDK / node 内置）」，不得越出 builtin-plugins 目录、
 * 也不得经相对路径或 @helm/kernel 包名导入 kernel 私有目录
 * （runtime / plugins / env / http / services 等）。
 *
 * 防呆（防测试自身空洞）：扫描到的文件数与导入数做下限断言，并核对
 * kernel 私有目录清单与磁盘实际一致——目录改名后本测试必须显式失败，
 * 而不是静默变成零扫描。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const kernelSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const builtinRoot = join(kernelSrc, 'builtin-plugins')

/** kernel 私有目录（内核机制层）：builtin-plugins 禁止经任何拼写导入。 */
const PRIVATE_DIRS = ['runtime', 'plugins', 'env', 'http', 'services'] as const

/** 递归收集 builtin-plugins 下全部源码文件（.ts/.tsx）。 */
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

describe('builtin-plugins 架构边界守护', () => {
  it('kernel 私有目录清单与磁盘实际一致（目录改名后本测试须显式失败）', { timeout: 60_000 }, () => {
    for (const dir of PRIVATE_DIRS) {
      assert.ok(existsSync(join(kernelSrc, dir)), `kernel 私有目录 ${dir} 不存在（清单过期或目录已改名，请同步本测试）`)
    }
    assert.ok(existsSync(builtinRoot), `builtin-plugins 目录不存在：${builtinRoot}`)
  })

  it('builtin-plugins 源码导入零越界（不越出目录、不导入 kernel 私有目录）', { timeout: 60_000 }, () => {
    const files = collectSourceFiles(builtinRoot)
    // 防呆：扫描必须有实质产出（防路径错误导致零扫描静默通过）。
    assert.ok(files.length >= 20, `builtin-plugins 源码文件数异常（${files.length} < 20），扫描可能指向了错误目录`)
    for (const known of ['workflow.ts', 'superagent.ts', 'profile.ts', join('workflow', 'worktree.ts')]) {
      assert.ok(files.some((f) => f === join(builtinRoot, known)), `未扫描到已知源码文件 ${known}（扫描器异常）`)
    }

    const violations: Violation[] = []
    let relativeImportCount = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const spec of importSpecifiersOf(source)) {
        // 规则一：不得经包名绕道导入宿主包自身（kernel 私有代码不可经 @helm/kernel 触达）。
        if (spec === '@helm/kernel' || spec.startsWith('@helm/kernel/')) {
          violations.push({ file, spec, reason: 'builtin-plugins 属于 @helm/kernel 包内部，禁止经包名导入自身（应使用 @helm/protocol 公开契约）' })
          continue
        }
        if (!spec.startsWith('.')) continue
        relativeImportCount += 1
        const resolved = resolve(dirname(file), spec)
        const rel = relative(builtinRoot, resolved)
        // 越出目录：relative 结果回退到 '..'（或跨盘等绝对形态）。
        const escapes = rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        if (escapes) {
          // 规则二：相对导入不得越出 builtin-plugins 目录（../runtime、../../env 等一律拒绝）。
          const privateHit = PRIVATE_DIRS.find((d) => rel === `..${sep}${d}` || rel.startsWith(`..${sep}${d}${sep}`))
          violations.push({
            file,
            spec,
            reason: privateHit !== undefined
              ? `相对导入越出 builtin-plugins 且指向 kernel 私有目录 ${privateHit}/（通用能力应下沉 @helm/protocol）`
              : '相对导入越出 builtin-plugins 目录（跨边界依赖只允许 @helm/protocol 等公开包）',
          })
        }
      }
    }
    // 防呆：必须实际解析到相对导入（正则失效会导致扫描空洞）。
    assert.ok(relativeImportCount >= 10, `相对导入解析数异常（${relativeImportCount} < 10），import 提取正则可能失效`)
    if (violations.length > 0) {
      const detail = violations.map((v) => `${relative(builtinRoot, v.file)}: ${v.spec}\n  -> ${v.reason}`).join('\n')
      assert.fail(`builtin-plugins 存在 ${violations.length} 处越界导入：\n${detail}`)
    }
  })

  it('superagent/watchdog.ts 对 builtin-plugins 内部 diagnostics 的导入合法（边界内相对导入不误报）', { timeout: 60_000 }, () => {
    const file = join(builtinRoot, 'superagent', 'watchdog.ts')
    const source = readFileSync(file, 'utf8')
    assert.ok(
      importSpecifiersOf(source).includes('../diagnostics.js'),
      'watchdog.ts 应包含 ../diagnostics.js 导入（若已重构请同步本守护样例）',
    )
    const resolved = resolve(dirname(file), '../diagnostics.js')
    const rel = relative(builtinRoot, resolved)
    assert.ok(!rel.startsWith('..'), `diagnostics.js 应位于 builtin-plugins 内（实际解析到 ${resolved}）`)
  })
})
