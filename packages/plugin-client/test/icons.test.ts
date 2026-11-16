/**
 * @helm/plugin-client HelmIcon 图标注册与 Fast Refresh 契约测试：
 * - 验证新增图标 'laptop' / 'server' / 'circle-slash' / 'file' 真实渲染对应 lucide SVG；
 * - 验证未知名称及原型链键（如 'toString'）安全回退为 Circle；
 * - 验证 HelmIconName 类型导出与 icons.tsx Fast Refresh 规范（仅导出组件与类型）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { HelmIcon, type HelmIconName } from '../src/index.js'
import * as IconsModule from '../src/icons.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

test('HelmIcon：支持 laptop / server / circle-slash / file 与共享补充矢量图标（SSR）', { timeout: 60_000 }, () => {
  const cases: ReadonlyArray<[HelmIconName, RegExp]> = [
    ['laptop', /lucide-laptop/],
    ['server', /lucide-server/],
    ['circle-slash', /lucide-circle-slash/],
    ['file', /lucide-file(?!-)/],
    ['arrow-down', /lucide-arrow-down(?!-)/],
    ['arrow-down-to-line', /lucide-arrow-down-to-line/],
    ['git-pull-request', /lucide-git-pull-request/],
    ['list-filter', /lucide-list-filter/],
    ['more-horizontal', /lucide-ellipsis/],
  ]
  for (const [name, pattern] of cases) {
    const html = renderToString(e(HelmIcon, { name, size: 16 }))
    assert.match(html, /<svg\b/, `${name} 应渲染 SVG 元素`)
    assert.match(html, pattern, `${name} 应渲染对应 lucide 图标而非回退圆圈`)
    assert.doesNotMatch(html, /\blucide-circle(?:\s|")/, `${name} 不得退化为空心圆 Circle`)
  }

  // 大小写与空白规范化同样命中注册表
  const trimmed = renderToString(e(HelmIcon, { name: '  Laptop  ' }))
  assert.match(trimmed, /lucide-laptop/)
})

test('HelmIcon：未知图标与原型链属性安全回退 Circle', { timeout: 60_000 }, () => {
  for (const bad of [undefined, '', 'does-not-exist', 'toString', 'constructor']) {
    const html = renderToString(e(HelmIcon, { name: bad }))
    assert.match(html, /<svg\b/)
    assert.match(html, /lucide-circle(?:\s|")/, `${String(bad)} 应安全回退 Circle`)
  }
})

test('icons.tsx 遵守 Fast Refresh 规范（运行时只导出 HelmIcon 组件）', { timeout: 60_000 }, () => {
  assert.deepEqual(Object.keys(IconsModule), ['HelmIcon'])
  assert.equal(typeof IconsModule.HelmIcon, 'function')
  const source = readFileSync(new URL('../src/icons.tsx', import.meta.url), 'utf8')
  const nonTypeExports = source.match(/^export\s+(?!interface\b|type\b)(.+)$/gm) ?? []
  assert.equal(nonTypeExports.length, 1)
  assert.match(nonTypeExports[0]!, /^export function HelmIcon\b/)
})
