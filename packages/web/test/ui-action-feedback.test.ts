import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { normalizeSpec } from '../src/ui/spec-normalize.js'
import type { SpecRenderContext } from '../src/ui/spec-primitives.js'

;(globalThis as Record<string, unknown>).React = React
const { SpecNodeList } = await import('../src/ui/spec-primitives.js')

function render(spec: Record<string, unknown>, pending: boolean, succeeded: boolean): string {
  const normalized = normalizeSpec(spec)
  assert.ok(normalized.root)
  const ctx: SpecRenderContext = {
    scope: {}, runAction: () => {}, isPending: () => pending, isSucceeded: () => succeeded,
    renderChildren: (nodes) => React.createElement(SpecNodeList, { nodes, ctx }),
  }
  return renderToString(React.createElement(SpecNodeList, { nodes: [normalized.root], ctx }))
}

const action = { type: 'helm:send', text: '执行检查' }
const fixtures: Array<{ name: string; spec: Record<string, unknown> }> = [
  { name: 'Button', spec: { component: 'Button', label: '检查', action } },
  { name: 'ActionBar', spec: { component: 'ActionBar', actions: [{ label: '检查', action }] } },
  { name: 'Table rowAction', spec: { component: 'Table', rows: [{ name: '节点' }], rowActions: [{ label: '检查', action }] } },
  { name: 'TextInput', spec: { component: 'TextInput', label: '参数', value: '检查', action } },
]

for (const { name, spec } of fixtures) {
  test(`${name} 请求在途时禁用并显示旋转加载，优先于前次成功态`, { timeout: 60_000 }, () => {
    const html = render(spec, true, true)
    assert.match(html, /disabled=""/)
    assert.match(html, /aria-busy="true"/)
    assert.match(html, /spin-slow/)
    assert.doesNotMatch(html, /lucide-check/)
    assert.doesNotMatch(html, /已提交/)
  })

  test(`${name} 请求成功后显示确认图标且可再次操作`, { timeout: 60_000 }, () => {
    const html = render(spec, false, true)
    assert.match(html, /lucide-check/)
    assert.doesNotMatch(html, /disabled=""/)
    assert.doesNotMatch(html, /spin-slow/)
    if (name === 'TextInput') assert.match(html, /已提交/)
  })
}
