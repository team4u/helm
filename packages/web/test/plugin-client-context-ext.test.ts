/**
 * PluginClientContext 扩展契约测试（P1/P4）：
 * - usePluginDoc(docName, pluginId?) 跨插件订阅；
 * - usePluginSessionDoc：ctx 插件/会话继承、显式覆写、无会话返回 undefined 不开流；
 * - createPluginClientContext：callAction 第三参跨插件寻址、submitInput 无会话
 *   显式 reject 与真实 conversationsApi 载荷（origin: agent）、getPluginDoc
 *   第二参、getPluginSessionDoc 路径与参数、composer 仅显式提供时存在。
 * 真实 React DOM 渲染路径（createRoot + act），store 为行为真实的最小替身。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ComposerController } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { getSessionDocState, resetSessionDocSubscriptions, subscribeSessionDoc, type SessionDocKey } from '../src/lib/session-docs.js'
import {
  createPluginClientContext,
  PluginClientContext,
  usePluginDoc,
  usePluginSessionDoc,
} from '../src/lib/plugin-client-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { pluginsApi } from '../src/lib/api.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** 在双 Provider 内挂载探针并回传 hooks 结果。 */
function mountProbe<T>(store: HelmStoreValue, ctxValue: ReturnType<typeof createPluginClientContext>, use: () => T): { result: () => T | undefined; unmount: () => void } {
  let captured: T | undefined
  function Probe(): React.ReactNode {
    captured = use()
    return e('div', null, String(JSON.stringify(captured)?.slice(0, 80) ?? ''))
  }
  const host = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreContext.Provider, { value: store }, e(PluginClientContext.Provider, { value: ctxValue }, e(Probe))))
  })
  return {
    result: () => captured,
    unmount: () => { act(() => root?.unmount()) },
  }
}

test('usePluginDoc：省略 pluginId 用 ctx 插件，显式 pluginId 跨插件订阅', { timeout: 60_000 }, () => {
  const ensured: Array<[string, string]> = []
  const store = makeTestStore({
    ensurePluginDoc: async (pluginId, docName) => { ensured.push([pluginId, docName]); return undefined },
    pluginDocs: { 'test:plugin/status': { ok: 1 }, 'other:plugin/status': { ok: 2 } },
  })
  const ctx = createPluginClientContext(store, 'test:plugin', 1)
  const p1 = mountProbe(store, ctx, () => usePluginDoc('status'))
  assert.deepEqual(p1.result(), { ok: 1 }, '省略 pluginId 读当前插件文档')
  const p2 = mountProbe(store, ctx, () => usePluginDoc('status', 'other:plugin'))
  assert.deepEqual(p2.result(), { ok: 2 }, '显式 pluginId 跨插件读取')
  const p3 = mountProbe(store, ctx, () => usePluginDoc('missing'))
  assert.equal(p3.result(), undefined)
  assert.deepEqual(ensured, [['test:plugin', 'missing']], '缺失文档自动 ensure 一次')
  p1.unmount(); p2.unmount(); p3.unmount()
})

test('usePluginSessionDoc：继承 ctx 插件与会话；显式覆写；无会话不开流', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const opened: SessionDocKey[] = []
  const store = makeTestStore({
    subscribeSessionDoc: (key, listener) => {
      opened.push(key)
      return subscribeSessionDoc(key, listener)
    },
  })
  const ctx = createPluginClientContext(store, 'test:plugin', 7)
  // 显式覆写 conversationId（无 SSE 环境：订阅会尝试连接，值保持 undefined，不 mock）
  const p1 = mountProbe(store, ctx, () => usePluginSessionDoc('runs', { conversationId: 9 }))
  assert.equal(p1.result(), undefined, '未收到首帧前 undefined')
  assert.deepEqual(opened, [{ pluginId: 'test:plugin', docName: 'runs', conversationId: 9 }], '显式会话覆写生效')
  p1.unmount()

  // 无会话上下文：不开流
  const ctxNoConv = createPluginClientContext(store, 'test:plugin', undefined)
  const p2 = mountProbe(store, ctxNoConv, () => usePluginSessionDoc('runs'))
  assert.equal(p2.result(), undefined)
  assert.equal(opened.length, 1, '无会话不开订阅流')
  p2.unmount()
})

test('callAction 第三参：跨插件寻址与显式会话', { timeout: 60_000 }, async () => {
  const calls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  const store = makeTestStore({
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      calls.push({ pluginId, actionId, input, conversationId })
      return { pong: true }
    },
  })
  const ctx = createPluginClientContext(store, 'test:plugin', 5)
  const r1 = await ctx.callAction('ping', { a: 1 })
  assert.deepEqual(r1, { pong: true })
  assert.deepEqual(calls[0], { pluginId: 'test:plugin', actionId: 'ping', input: { a: 1 }, conversationId: 5 }, '默认本插件 + 继承会话')
  await ctx.callAction('ping', {}, { pluginId: 'other:plugin', conversationId: 12 })
  assert.deepEqual(calls[1], { pluginId: 'other:plugin', actionId: 'ping', input: {}, conversationId: 12 }, '显式跨插件 + 会话覆写')
  // 非法会话 ID 显式抛错（同步校验 reject）
  await assert.rejects(async () => ctx.callAction('ping', {}, { conversationId: -3 }), /正整数/)
})

test('submitInput：真实 conversationsApi（origin agent）；无会话显式 reject', { timeout: 60_000 }, async (t) => {
  const captured: Array<{ path: string; body: unknown }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ path: String(input), body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ submissionId: 's1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const store = makeTestStore()
  const ctx = createPluginClientContext(store, 'test:plugin', 42)
  await ctx.submitInput('hello', { whenBusy: 'followUp' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.path, '/api/conversations/42/input')
  assert.deepEqual(captured[0]!.body, { text: 'hello', origin: 'agent', whenBusy: 'followUp' }, '真实 API 载荷：agent 来源 + whenBusy')

  // 显式会话覆写
  await ctx.submitInput('hi', { conversationId: 7 })
  assert.equal(captured[1]!.path, '/api/conversations/7/input')

  // 无会话上下文且未显式指定：显式 reject（不静默降级）
  const ctxNone = createPluginClientContext(store, 'test:plugin', undefined)
  await assert.rejects(() => ctxNone.submitInput('x'), /无目标会话/)
})

test('getPluginDoc/getPluginSessionDoc：第二参与会话路径（真实 pluginsApi fetch）', { timeout: 60_000 }, async (t) => {
  const paths: Array<{ path: string; qs: string | undefined }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = String(input)
    const qAt = raw.indexOf('?')
    paths.push({ path: qAt < 0 ? raw : raw.slice(0, qAt), qs: qAt < 0 ? undefined : raw.slice(qAt + 1) })
    return new Response(JSON.stringify({ pluginId: 'p', name: 'd', conversationId: 9, value: { v: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  // ensurePluginDoc / getPluginSessionDoc 绑真实 pluginsApi（fetch 拦截观察请求）
  const realStore = makeTestStore({
    ensurePluginDoc: async (pluginId, name) => (await pluginsApi.getPublicDoc(pluginId, name)).value,
    getPluginSessionDoc: async (pluginId, name, conversationId) => (await pluginsApi.getPublicSessionDoc(pluginId, name, conversationId)).value,
  })
  const ctx = createPluginClientContext(realStore, 'test:plugin', 9)
  const v = await ctx.getPluginDoc('status', 'other:plugin')
  assert.equal(paths[0]!.path, '/api/plugins/other%3Aplugin/docs/status')
  assert.deepEqual(v, { v: 1 }, '返回文档 value')

  const sv = await ctx.getPluginSessionDoc('runs')
  assert.equal(paths[1]!.path, '/api/plugins/test%3Aplugin/docs/runs')
  assert.equal(paths[1]!.qs, 'conversationId=9', '会话文档走同一路径 + conversationId 查询参数')
  assert.deepEqual(sv, { v: 1 })

  const ctxNone = createPluginClientContext(realStore, 'test:plugin', undefined)
  await assert.rejects(() => ctxNone.getPluginSessionDoc('runs'), /无目标会话/)
})

test('composer：仅显式提供时存在于 ctx；透传同一实例', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const controller: ComposerController = {
    draft: '',
    attachments: [],
    sending: false,
    setDraft: () => {},
    insertText: () => {},
    submit: async () => {},
  }
  const withComposer = createPluginClientContext(store, 'test:plugin', 1, controller)
  assert.equal(withComposer.composer, controller, '显式提供时透传同一实例')
  const without = createPluginClientContext(store, 'test:plugin', 1)
  assert.equal(without.composer, undefined, '未提供时省略键（非 undefined 赋值）')
})
