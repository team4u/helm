/**
 * Browser asset contracts that can be verified without mounting the app.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WEB_PUBLIC = join(WEB_ROOT, 'public')

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
  assert.match(swSource, /skipWaiting/)
  assert.match(swSource, /clients\.claim/)
  assert.match(swSource, /notificationclick/)
  assert.match(swSource, /helmx:notification-click/)
  assert.match(swSource, /openWindow/)
  assert.doesNotMatch(swSource, /\bfetch\b/, 'public/sw.js 严禁监听或触碰 fetch')
  assert.doesNotMatch(swSource, /\bcaches\b/, 'public/sw.js 严禁触碰 caches')
  assert.doesNotMatch(swSource, /CacheStorage/, 'public/sw.js 严禁触碰 CacheStorage')
})

