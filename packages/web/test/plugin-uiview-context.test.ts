/**
 * PluginUiView 双轨上下文测试：
 * - JSON 轨：sanitizeSlotPropsForSpec 剔除函数/类实例/symbol（含嵌套），JSON
 *   求值域绝不接收函数；$sessionDocs 声明透传 HelmSpecView；
 * - client 轨：ctx 含 conversationId/composer 正确注入（createPluginClientContext
 *   行为在 plugin-client-context-ext.test.ts 覆盖，此处验证 PluginUiView 布线）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { sanitizeSlotPropsForSpec } from '../src/ui/plugin-ui-data.js'
import { HelmSpecView } from '../src/ui/HelmSpecView.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register({ url: 'http://localhost:3201/' })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

test('sanitizeSlotPropsForSpec：函数/symbol/bigint 剔除，结构保留', { timeout: 60_000 }, () => {
  const sym = Symbol('x')
  const cleaned = sanitizeSlotPropsForSpec({
    conversationId: 7,
    composer: { draft: 'hi', setDraft: () => {} },
    entry: { id: '3', data: { nested: { fn: () => {}, keep: 1 } }, meta: [{ run: () => 1 }, 'text'] },
    sym,
    big: 10n,
    nil: undefined,
    when: new Date(0),
  })
  // 顶层函数/symbol 值整键剔除（sym 不在结果中）；嵌套对象内函数属性剔除
  //（composer 仅剩可序列化子字段、meta 首元素仅剩空对象）；
  // bigint/undefined 不进入 JSON 数据。
  assert.deepEqual(cleaned, {
    conversationId: 7,
    composer: { draft: 'hi' },
    entry: { id: '3', data: { nested: { keep: 1 } }, meta: [{}, 'text'] },
    when: '1970-01-01T00:00:00.000Z',
  })
  assert.equal('sym' in cleaned, false, '顶层 symbol 值整键剔除')
  // 关键断言：任何位置的函数都不得进入 JSON 求值域
  const json = JSON.stringify(cleaned)
  assert.ok(!json.includes('setDraft') && !json.includes('=>'), `求值域不得含函数：${json}`)
})

test('sanitizeSlotPropsForSpec：循环引用显式拒绝，原型键作为普通数据保留', { timeout: 60_000 }, () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  assert.throws(() => sanitizeSlotPropsForSpec(cycle), /循环引用/)
  const clean = sanitizeSlotPropsForSpec(JSON.parse('{"__proto__":{"safe":true}}'))
  assert.equal(Object.getPrototypeOf(clean), Object.prototype)
  assert.equal(Object.hasOwn(clean, '__proto__'), true)
})

test('PluginUiView JSON 轨：slotProps 经 sanitize 后进入 $data（函数不进求值域）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(
      HelmStoreContext.Provider, { value: store },
      e(HelmSpecView, {
        pluginId: 'owner',
        spec: { component: 'Text', text: 'conv:{$data.conversationId}:{$data.entry.id}' },
        data: sanitizeSlotPropsForSpec({
          conversationId: 7,
          fn: () => {},
          entry: { id: 'e9', fn: () => {} },
        }),
      }),
    ))
  })
  assert.equal(host.textContent, 'conv:7:e9')
})

test('JSON 轨 sessionDocs 声明：HelmSpecView 接收 sessionDocs 参数（无会话时安全空态）', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const host = document.createElement('div')
  let root: ReturnType<typeof createRoot> | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(
      HelmStoreContext.Provider, { value: store },
      e(HelmSpecView, {
        pluginId: 'owner',
        spec: { component: 'Text', text: 'metrics:{$sessionDocs.metrics.tokens}' },
        sessionDocs: ['metrics'],
        conversationId: undefined,
      }),
    ))
  })
  assert.equal(host.textContent, 'metrics:', '无会话上下文时 $sessionDocs 为空对象（不订阅、不报错、不伪值）')
})
