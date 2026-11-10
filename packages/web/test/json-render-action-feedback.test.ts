import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as HelmPluginClient from '../src/lib/plugin-client-sdk.js'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { normalizeSpec, type NormalizedSpecNode } from '../../kernel/src/builtin-plugins/json-render/client/spec-normalize.js'
import type { EvalScope } from '../../kernel/src/builtin-plugins/json-render/client/evaluator.js'
import type { ReactNode } from 'react'

/** spec-primitives 的渲染上下文形状（client 目录不入 typecheck，此处本地最小声明）。 */
interface SpecRenderContext {
  scope: EvalScope
  conversationId?: number
  pluginId?: string
  renderChildren(children: NormalizedSpecNode[]): ReactNode
  runAction(rawAction: unknown, scope: EvalScope, pendingKey: string): void
  isPending(pendingKey: string): boolean
  isSucceeded?(pendingKey: string): boolean
}

;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).__helm_shared_react = React
;(globalThis as Record<string, unknown>).__helm_shared_react_jsx_runtime = await import('react/jsx-runtime')
;(globalThis as Record<string, unknown>).__helm_shared_plugin_client = HelmPluginClient
;(globalThis as Record<string, unknown>).__helm_shared_lucide_react = await import('lucide-react')

const here = dirname(fileURLToPath(import.meta.url))
const CACHE = mkdtempSync(join(tmpdir(), 'helm-jr-feedback-'))
const { code } = await compilePluginClientModule(
  'builtin:json-render',
  resolve(here, '../../kernel/src/builtin-plugins/json-render/client'),
  'spec-primitives.tsx',
  CACHE,
)
const f = join(CACHE, 'spec-primitives.mjs')
writeFileSync(f, code, 'utf8')
const { SpecNodeList } = await import(f)
rmSync(CACHE, { recursive: true, force: true })

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
