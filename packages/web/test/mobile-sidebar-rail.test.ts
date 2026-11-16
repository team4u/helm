/**
 * 移动端 Rail 拇指区布局契约（纯 CSS 结构守护）：
 * - responsive.css ≤860px 抽屉断点内，空间切换按钮（.activity-rail-spaces）
 *   沉底进入拇指区，主题按钮（.activity-rail-footer）维持沉底并以分隔线分组区隔；
 * - shell.css 桌面布局不受影响：footer 仍由 margin-top: auto 沉底、spaces 不沉底。
 * 移动端侧栏滑动手势已移除，本文件不守护任何手势行为。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('responsive.css 移动端 Rail：空间切换沉底拇指区，主题沉底分组区隔', { timeout: 60_000 }, () => {
  const start = responsiveCss.indexOf('@media (max-width: 860px)')
  assert.ok(start >= 0, 'responsive.css 必须保留 860px 抽屉断点')
  const next = responsiveCss.indexOf('@media', start + 1)
  const drawerBlock = responsiveCss.slice(start, next === -1 ? undefined : next)
  assert.match(
    drawerBlock,
    /\.activity-rail-spaces\s*\{[^}]*margin-top:\s*auto/,
    '移动端空间切换按钮沉底（margin-top: auto）进入拇指区',
  )
  assert.match(
    drawerBlock,
    /\.activity-rail-footer\s*\{[^}]*margin-top:\s*0[^}]*border-top:\s*1px solid var\(--border\)/,
    '主题按钮维持沉底并以分隔线与空间按钮分组区隔',
  )
  // 桌面布局不受影响：分片样式里 footer 仍由 margin-top: auto 沉底、spaces 不沉底
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8')
  assert.match(shellCss, /\.activity-rail-footer\s*\{[^}]*margin-top:\s*auto/, '桌面端主题按钮沉底规则保持')
  assert.doesNotMatch(shellCss, /\.activity-rail-spaces\s*\{[^}]*margin-top:\s*auto/, '桌面端空间按钮不沉底')
})
