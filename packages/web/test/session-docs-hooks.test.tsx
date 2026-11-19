/**
 * usePluginSessionDoc / usePluginSessionDocDiagnostics / usePluginSessionDocsMap
 * 真实 React 消费路径测试（createRoot + act，happy-dom 宿主，不 mock hooks）：
 * - StrictMode 双挂载-卸载-重挂载后订阅恢复（refcount 正确重建流）；
 * - 多文档订阅合并为单条 `/api/session-docs/events?sub=...` 多路复用流；
 * - store 对象引用频繁更换（模拟全局 SSE 引发 Provider 重渲染）不退订重开流；
 * - delete 帧 value=initial（reset 语义）：单值 hook 与 JSON map 消费得到一致初值；
 * - map 部分文档未到达/单 tuple 出错时返回稳定引用（不无限重渲染），错误如实暴露不静默空表；
 * - 401 时请求携带 Bearer（鉴权修复回归）。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  bindSessionDocRuntime,
  getSessionDocState,
  resetSessionDocSubscriptions,
  sessionDocTimings,
  subscribeSessionDoc,
} from '../src/lib/session-docs.js'
import { usePluginSessionDocsMap } from '../src/lib/store-context.js'
import { usePluginSessionDocValue, usePluginSessionDocState } from '@helmx/plugin-client'
import { createPluginClientHostPort } from '../src/lib/plugin-client-host.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { TestStoreProvider } from './helpers/host-store.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const originalTimings = { ...sessionDocTimings }
before(() => {
  sessionDocTimings.subscribeDebounceMs = 0
})
after(() => {
  Object.assign(sessionDocTimings, originalTimings)
})

const multiplexFrame = (
  action: 'snapshot' | 'updated' | 'deleted',
  seq: number,
  doc: Record<string, unknown>,
  target?: Partial<{ pluginId: string; name: string; conversationId: number }>,
): string => {
  const pluginId = target?.pluginId ?? String(doc['pluginId'])
  const name = target?.name ?? String(doc['name'])
  const conversationId = target?.conversationId ?? Number(doc['conversationId'])
  return `event: ${action}\ndata: ${JSON.stringify({ action, pluginId, name, conversationId, seq, doc })}\n\n`
}

type ProbeResult = { value: unknown; diagnostics: { error?: string; connected: boolean; deleted: boolean; hasValue: boolean } }

interface Harness {
  rerenderStore: (store: HelmxExternalStore) => void
  unmount: () => void
}

/** 真实 store 的 actions 即携带 session-docs 具名函数（与生产一致）。 */
const stableSessionDocStore = (overrides: Partial<HelmxStoreValue> = {}): HelmxExternalStore =>
  makeTestStore({
    ...overrides,
  })

/** 挂载双探针组件（单值 hook + 诊断 hook + map hook），Flaps 收集最新结果。 */
function mountProbes(
  initialStore: HelmxExternalStore,
  opts: { strict?: boolean; docNames?: string[] } = {},
): { reads: () => ProbeResult; mapReads: () => Record<string, unknown>; harness: Harness } {
  const reads: ProbeResult[] = []
  const mapReads: Record<string, unknown>[] = []
  function Probes(): React.ReactNode {
    reads.push({
      value: usePluginSessionDocValue('runs', { pluginId: 'builtin:workflow', conversationId: 42 }),
      diagnostics: usePluginSessionDocState('runs', { pluginId: 'builtin:workflow', conversationId: 42 }),
    })
    mapReads.push(usePluginSessionDocsMap('builtin:workflow', opts.docNames ?? ['runs', 'stats'], 42))
    return e('div', null, 'probe')
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  let currentStore = initialStore
  const renderTree = (): React.ReactElement =>
    e(TestStoreProvider, { value: currentStore }, e(Probes))
  let root: Root | undefined
  const harness: Harness = {
    rerenderStore: (store: HelmxExternalStore) => {
      currentStore = store
      act(() => { root!.render(renderTree()) })
    },
    unmount: () => {
      act(() => { root!.unmount() })
    },
  }
  act(() => {
    root = createRoot(host)
    const tree = opts.strict ? e(React.StrictMode, undefined, renderTree()) : renderTree()
    root.render(tree)
  })
  return {
    reads: () => reads[reads.length - 1]!,
    mapReads: () => mapReads[mapReads.length - 1]!,
    harness,
  }
}

test('宿主端口在快照更新后保留订阅与加载函数身份', { timeout: 60_000 }, () => {
  const store = stableSessionDocStore()
  const initial = createPluginClientHostPort(store.getSnapshot())
  const updated = createPluginClientHostPort({ ...store.getSnapshot(), conversations: [] })
  for (const key of ['subscribeSessionDoc', 'getSessionDocState', 'ensurePluginDoc', 'getPluginSessionDoc', 'loadConversationDetail', 'invokePluginAction'] as const) {
    assert.equal(updated[key], initial[key], key)
  }
})

test('StrictMode 挂载-卸载-重挂载：订阅恢复且引用稳定（不无限重渲染）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 1 } }),
          ))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  })
  const { reads, mapReads, harness } = mountProbes(makeTestStore(), { strict: true, docNames: ['runs'] })
  for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
  assert.deepEqual(reads().value, { n: 1 }, 'StrictMode 重挂载后订阅恢复')
  const renders = mapReads()
  assert.deepEqual(renders['runs'], { n: 1 }, 'map 消费同一文档值')
  harness.unmount()
  restore()
})

test('store 引用更换（全局 SSE 重渲染）不退订重开流，且多文档合并为单条请求', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let streamOpens = 0
  let capturedUrl = ''
  const restore = bindSessionDocRuntime(async (input: RequestInfo | URL) => {
    streamOpens++
    capturedUrl = String(input)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: 1 }),
          ))
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'stats', conversationId: 42, value: 2 }),
          ))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  })
  const { reads, harness } = mountProbes(stableSessionDocStore())
  for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
  assert.equal(reads().value, 1)
  assert.equal(streamOpens, 1, '同组件多个 sessionDoc hook 合并为单条多路复用流')
  const subs = new URL(capturedUrl, 'http://localhost').searchParams.getAll('sub').sort()
  assert.deepEqual(subs, ['builtin:workflow/runs/42', 'builtin:workflow/stats/42'])
  const before = streamOpens
  // 模拟全局 SSE 状态更新：Provider value 换新对象引用（具名函数保持稳定）
  harness.rerenderStore(stableSessionDocStore({ conversations: [] }))
  harness.rerenderStore(stableSessionDocStore({ sseConnected: false }))
  await act(async () => {})
  assert.equal(streamOpens, before, 'store 换引用未退订重开流')
  assert.equal(reads().value, 1, '值保持')
  harness.unmount()
  restore()
})

test('delete 帧初值契约：单值 hook 与 JSON map 一致暴露 initial', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const restore = bindSessionDocRuntime(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 5 } })))
          controller.enqueue(encoder.encode(multiplexFrame('deleted', 2, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 0 }, deleted: true })))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  })
  const { reads, mapReads, harness } = mountProbes(makeTestStore(), { docNames: ['runs'] })
  for (let i = 0; i < 30 && !reads().diagnostics.deleted; i++) await act(async () => {})
  assert.equal(reads().diagnostics.deleted, true, 'deleted 标记到达')
  assert.deepEqual(reads().value, { n: 0 }, '单值 hook 返回 delete 帧初值而非 undefined')
  assert.deepEqual(mapReads()['runs'], { n: 0 }, 'JSON map 同样得到初值（reset 语义）')
  harness.unmount()
  restore()
})

test('map 快照引用稳定：部分文档未到达或出错不无限重渲染，错误如实暴露', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let renderCount = 0
  const mapResults: Record<string, unknown>[] = []
  const restore = bindSessionDocRuntime(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          // runs 正常返回；stats 帧缺失 value 字段（单 tuple 报错），验证部分成功与引用稳定
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: 'ok' }),
          ))
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'stats', conversationId: 42 }),
          ))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  })
  function MapProbe(): React.ReactNode {
    renderCount++
    const map = usePluginSessionDocsMap('builtin:workflow', ['runs', 'stats'], 42)
    mapResults.push(map)
    return e('div', null, JSON.stringify(map))
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(TestStoreProvider, { value: makeTestStore() }, e(MapProbe)))
  })
  for (let i = 0; i < 30 && mapResults[mapResults.length - 1]!['runs'] === undefined; i++) await act(async () => {})
  assert.equal(mapResults[mapResults.length - 1]!['runs'], 'ok', 'runs 到值')
  assert.equal('stats' in mapResults[mapResults.length - 1]!, false, 'stats 出错缺失')
  assert.ok(getSessionDocState({ pluginId: 'builtin:workflow', docName: 'stats', conversationId: 42 }).error !== undefined)
  // 稳定性验证：不再主动 render，仅空转事件循环——若快照每次返回新 {} 会触发
  // useSyncExternalStore 重渲染循环（renderCount 持续增长）；正确实现应收敛。
  const baseline = renderCount
  const stableRef = mapResults[mapResults.length - 1]
  for (let i = 0; i < 10; i++) await act(async () => {})
  assert.equal(renderCount, baseline, `无外部驱动不重渲染（${baseline} -> ${renderCount}）`)
  assert.equal(mapResults[mapResults.length - 1], stableRef, '快照引用复用')
  act(() => { root!.unmount() })
  restore()
})

test('订阅请求携带 Bearer（鉴权回归）', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  let capturedAuth: string | undefined
  const restore = bindSessionDocRuntime(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(
            multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: 1 }),
          ))
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }, () => 'probe-token')
  const { reads, harness } = mountProbes(makeTestStore())
  for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
  assert.equal(reads().value, 1)
  assert.equal(capturedAuth, 'Bearer probe-token', 'hook 首次挂载即带 token（浏览器 401 退出回归）')
  harness.unmount()
  restore()
})
