/**
 * Web 与浏览器 SDK 全仓架构不变量检查（纯静态扫描，不加载 happy-dom）：
 * 1. 零 Emoji 铁律（packages/web/src、packages/plugin-client/src、index.html）；
 * 2. Radix / 受控原语纪律（零原生 <select>、零原生 type="checkbox"、零 window.confirm）；
 * 3. Fast Refresh 纪律（所有 .tsx 仅导出 PascalCase React 组件或 TS 类型）；
 * 4. 唯一 Hash 导航（仅 HelmxStoreProvider.tsx 可直接操作 history.pushState / replaceState）；
 * 5. 内核宿主壳零硬编码插件 ID / 工作流私有状态；
 * 6. index.html 移动端 viewport 与自适应明暗双模式 SVG Favicon。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readHostStyles } from './helpers/host-styles.js'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_CLIENT_SRC = fileURLToPath(new URL('../../plugin-client/src', import.meta.url))
const WEB_SRC = join(WEB_ROOT, 'src')
const WEB_PUBLIC = join(WEB_ROOT, 'public')

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
  for (const rel of ['public/manifest.webmanifest', 'public/sw.js', 'scripts/generate-icons.mjs']) {
    const abs = join(WEB_ROOT, rel)
    if (EMOJI_RE.test(readFileSync(abs, 'utf8'))) violations.push(abs)
  }
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

test('唯一 Hash 导航：仅 HelmxStoreProvider.tsx 允许直接调用 history.pushState / replaceState', { timeout: 60_000 }, () => {
  const allowed = join(WEB_SRC, 'lib', 'HelmxStoreProvider.tsx')
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
  const rowsSrc = readFileSync(join(WEB_SRC, 'conversation/TimelineRows.tsx'), 'utf8')
  assert.match(rowsSrc, /replaceRow/)
  const hostCss = [readHostStyles(), readFileSync(join(WEB_SRC, 'responsive.css'), 'utf8')].join('\n')
  assert.doesNotMatch(hostCss, /\.(?:subagent|workflow)-/, '宿主样式表不得硬编码插件业务类')
  assert.doesNotMatch(hostCss, /\.phase-segment/, '阶段胶囊样式归属插件，不得混入宿主 CSS')
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

function readPngDimensions(filePath: string): { width: number; height: number } {
  const bytes = readFileSync(filePath)
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(bytes.length >= 24, `${filePath} 不是有效 PNG（长度不足 24 字节）`)
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIG), `${filePath} 缺少 PNG 文件头签名`)
  const chunkType = bytes.subarray(12, 16).toString('ascii')
  assert.equal(chunkType, 'IHDR', `${filePath} 首块必须为 IHDR`)
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

test('PWA 清单与 HTML 元数据：manifest、apple-touch-icon 及移动宿主声明契约', { timeout: 60_000 }, () => {
  const indexHtml = readFileSync(join(WEB_ROOT, 'index.html'), 'utf8')
  assert.match(indexHtml, /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']\s*\/?>/i)
  assert.match(indexHtml, /<link\s+rel=["']apple-touch-icon["'][^>]*href=["']\/apple-touch-icon\.png["'][^>]*\/?>/i)
  assert.match(indexHtml, /<meta\s+name=["']mobile-web-app-capable["']\s+content=["']yes["']\s*\/?>/i)
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']\s*\/?>/i)
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["'][^"']+["']\s*\/?>/i)
  assert.match(indexHtml, /<meta\s+name=["']apple-mobile-web-app-title["']\s+content=["']Helmx["']\s*\/?>/i)

  const manifestRaw = readFileSync(join(WEB_PUBLIC, 'manifest.webmanifest'), 'utf8')
  assert.equal(EMOJI_RE.test(manifestRaw), false, 'manifest.webmanifest 严禁包含 Emoji')
  const manifest = JSON.parse(manifestRaw) as {
    id: string
    name: string
    short_name: string
    description: string
    start_url: string
    scope: string
    display: string
    orientation: string
    background_color: string
    theme_color: string
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>
  }
  assert.equal(manifest.id, '/')
  assert.equal(manifest.name, 'Helmx')
  assert.equal(manifest.short_name, 'Helmx')
  assert.equal(manifest.description, 'Helmx 主控台')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.orientation, 'any')
  assert.equal(manifest.background_color, '#f4f4f6')
  assert.equal(manifest.theme_color, '#1a1a1e')
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length === 3)

  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/'), `icon.src 必须为站内绝对路径: ${icon.src}`)
    assert.equal(icon.type, 'image/png')
    const absPath = join(WEB_PUBLIC, icon.src.slice(1))
    assert.ok(existsSync(absPath), `缺少 manifest 引用的图标文件: ${absPath}`)
    const match = /^(\d+)x(\d+)$/.exec(icon.sizes)
    assert.ok(match !== null, `无效 sizes: ${icon.sizes}`)
    const dims = readPngDimensions(absPath)
    assert.equal(dims.width, Number(match[1]), `${icon.src} PNG IHDR 宽度不匹配`)
    assert.equal(dims.height, Number(match[2]), `${icon.src} PNG IHDR 高度不匹配`)
  }

  assert.deepEqual(
    manifest.icons.map((i) => ({ src: i.src, sizes: i.sizes, purpose: i.purpose })),
    [
      { src: '/icon-192.png', sizes: '192x192', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
    ],
  )

  // 非 manifest 但被 index.html 与通知边界引用的 PNG 资产校验
  assert.deepEqual(readPngDimensions(join(WEB_PUBLIC, 'apple-touch-icon.png')), { width: 180, height: 180 })
  assert.deepEqual(readPngDimensions(join(WEB_PUBLIC, 'notification-badge-96.png')), { width: 96, height: 96 })
})

test('public/sw.js 零缓存不变量：包含 notificationclick，绝无 fetch 监听与 caches/CacheStorage', { timeout: 60_000 }, () => {
  const swPath = join(WEB_PUBLIC, 'sw.js')
  assert.ok(existsSync(swPath), '缺少 packages/web/public/sw.js')
  const swSource = readFileSync(swPath, 'utf8')
  assert.equal(EMOJI_RE.test(swSource), false, 'public/sw.js 严禁包含 Emoji')
  assert.match(swSource, /skipWaiting/)
  assert.match(swSource, /clients\.claim/)
  assert.match(swSource, /notificationclick/)
  assert.match(swSource, /helmx:notification-click/)
  assert.match(swSource, /openWindow/)
  assert.doesNotMatch(swSource, /\bfetch\b/, 'public/sw.js 严禁监听或触碰 fetch')
  assert.doesNotMatch(swSource, /\bcaches\b/, 'public/sw.js 严禁触碰 caches')
  assert.doesNotMatch(swSource, /CacheStorage/, 'public/sw.js 严禁触碰 CacheStorage')
})

