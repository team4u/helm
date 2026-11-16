/**
 * Web 与浏览器 SDK 全仓架构不变量检查（纯静态扫描，不加载 happy-dom）：
 * 1. 零 Emoji 铁律（packages/web/src、packages/plugin-client/src、index.html）；
 * 2. Radix / 受控原语纪律（零原生 <select>、零原生 type="checkbox"、零 window.confirm）；
 * 3. Fast Refresh 纪律（所有 .tsx 仅导出 PascalCase React 组件或 TS 类型）；
 * 4. 唯一 Hash 导航（仅 HelmStoreProvider.tsx 可直接操作 history.pushState / replaceState）；
 * 5. 内核宿主壳零硬编码插件 ID / 工作流私有状态；
 * 6. index.html 移动端 viewport 与自适应明暗双模式 SVG Favicon。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_CLIENT_SRC = fileURLToPath(new URL('../../plugin-client/src', import.meta.url))
const WEB_SRC = join(WEB_ROOT, 'src')

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

function collectFiles(dir: string, exts = ['.ts', '.tsx', '.js']): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts))
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

const webSrcFiles = collectFiles(WEB_SRC)
const sdkSrcFiles = collectFiles(PLUGIN_CLIENT_SRC)
const allClientFiles = [...webSrcFiles, ...sdkSrcFiles]

test('零 Emoji 铁律：packages/web/src、packages/plugin-client/src 与 index.html 绝对 0 Emoji', { timeout: 60_000 }, () => {
  assert.ok(webSrcFiles.length > 20 && sdkSrcFiles.length > 5)
  const violations: string[] = []
  for (const file of allClientFiles) {
    const content = readFileSync(file, 'utf8')
    if (EMOJI_RE.test(content)) violations.push(file)
  }
  const indexHtml = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8')
  if (EMOJI_RE.test(indexHtml)) violations.push(join(WEB_ROOT, 'index.html'))
  assert.deepEqual(violations, [], `Web 客户端源码严禁包含 Emoji：${violations.join(', ')}`)
})

test('Radix / 受控原语纪律：全仓零原生 <select>、零原生 checkbox、零 window.confirm', { timeout: 60_000 }, () => {
  const selectViolations: string[] = []
  const checkboxViolations: string[] = []
  const confirmViolations: string[] = []
  for (const file of allClientFiles) {
    const content = readFileSync(file, 'utf8')
    if (/<select[\s>]/.test(content)) selectViolations.push(file)
    if (/type=['"]checkbox['"]/i.test(content)) checkboxViolations.push(file)
    if (content.includes('window.confirm')) confirmViolations.push(file)
  }
  assert.deepEqual(selectViolations, [], `禁止原生 <select>：${selectViolations.join(', ')}`)
  assert.deepEqual(checkboxViolations, [], `禁止原生 <input type="checkbox">：${checkboxViolations.join(', ')}`)
  assert.deepEqual(confirmViolations, [], `禁止原生 window.confirm：${confirmViolations.join(', ')}`)
})

test('Fast Refresh 纪律：所有 .tsx 模块仅导出 PascalCase 组件与 TS 类型', { timeout: 60_000 }, () => {
  const tsxFiles = allClientFiles.filter((f) => f.endsWith('.tsx'))
  assert.ok(tsxFiles.length > 15)
  const violations: string[] = []
  for (const file of tsxFiles) {
    const content = readFileSync(file, 'utf8')
    const nonPascal = [...content.matchAll(/^export\s+(?!interface\b|type\b)(?:const|let|var|function|class)\s+([a-z][A-Za-z0-9_]*)/gm)].map(
      (m) => m[1],
    )
    const reexports = [...content.matchAll(/^export\s+\{[^}]+\}/gm)].map((m) => m[0])
    if (nonPascal.length > 0 || reexports.length > 0) {
      violations.push(`${file}: ${[...nonPascal, ...reexports].join(', ')}`)
    }
  }
  assert.deepEqual(violations, [], `违反 Fast Refresh 导出规范：\n${violations.join('\n')}`)
})

test('唯一 Hash 导航：仅 HelmStoreProvider.tsx 允许直接调用 history.pushState / replaceState', { timeout: 60_000 }, () => {
  const allowed = join(WEB_SRC, 'lib', 'HelmStoreProvider.tsx')
  const violations: string[] = []
  for (const file of allClientFiles) {
    if (file === allowed) continue
    const content = readFileSync(file, 'utf8')
    if (/history\.(push|replace)State/.test(content)) {
      violations.push(file)
    }
  }
  assert.deepEqual(violations, [], `禁止组件绕过唯一导航直接操作 history：${violations.join(', ')}`)
})

test('宿主壳零插件 ID 特判与工作流私有状态渗入', { timeout: 60_000 }, () => {
  for (const rel of [
    'screens/ScreenHost.tsx',
    'conversation/ConversationTimeline.tsx',
    'conversation/TimelineRows.tsx',
    'conversation/WorkbenchDrawer.tsx',
  ]) {
    const content = readFileSync(join(WEB_SRC, rel), 'utf8')
    assert.doesNotMatch(content, /builtin:[a-z-]+/, `${rel} 不得硬编码特定插件 ID`)
    assert.doesNotMatch(content, /workflowRuns|SubagentLiveCard|WorkflowRunSummary/, `${rel} 不得渗入工作流私有状态`)
  }
})

test('index.html 与 favicon.svg：移动端 viewport 安全区与明暗自适应图标契约', { timeout: 60_000 }, () => {
  const indexHtml = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8')
  const faviconSvg = readFileSync(join(WEB_ROOT, 'public/favicon.svg'), 'utf8')
  assert.match(indexHtml, /<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']\s*\/?>/i)
  assert.match(indexHtml, /maximum-scale=1\.0/)
  assert.match(indexHtml, /user-scalable=no/)
  assert.match(indexHtml, /<link\s+rel=["']icon["']\s+type=["']image\/svg\+xml["']\s+href=["']\/favicon\.svg["']\s*\/?>/i)
  assert.match(indexHtml, /<meta\s+name=["']theme-color["'][^>]*prefers-color-scheme:\s*light/i)
  assert.match(indexHtml, /<meta\s+name=["']theme-color["'][^>]*prefers-color-scheme:\s*dark/i)
  assert.match(faviconSvg, /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/)
})
