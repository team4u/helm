/**
 * @helm/plugin-client 标准共享 hooks 测试（真实 React SSR 渲染 + HelmStoreContext）：
 * - useConversations：返回宿主 store.conversations 同一引用（SSE 实时同步数据源）；
 * - useConversation：详情缺失且无失败时自动加载（loadConversationDetail 被真实调用）、
 *   已加载 / 加载失败 / undefined 三态不发请求；pendingAsks 按会话过滤；
 *   reload 强制 force 拉取；live / summary / loadError 如实透传。
 * 全部走真实 React hooks 执行路径（renderToString），不 mock hook 本身，
 * 仅以最小 store 注入数据（store 本身是测试替身，行为断言真实）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { AskSpec, ConversationSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import {
  createPluginClientContext,
  PluginClientContext,
  useConversation,
  useConversations,
} from '../src/lib/plugin-client-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

// 真实 DOM 宿主（happy-dom GlobalRegistrator）：react-dom/client createRoot 需要
// 真实元素与事件监听表面，Node 无 document；用完整 DOM 实现而非手写桩，
// 保证 effects / 事件 / 卸载路径都是 react-dom 真实执行。
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function summary(id: number, status: ConversationSummary['status']): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: '',
    thinkingLevel: '',
    status,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

const ask = (id: string, conversationId: number): AskSpec => ({
  id,
  conversationId,
  title: `审批 ${id}`,
  fields: [],
  status: 'pending',
  createdAt: 1,
})

interface LoadCall {
  id: number
  force: boolean
}

function makeStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    authReady: true,
    authConfigured: true,
    authenticated: true,
    authError: null,
    connectionError: null,
    loadErrors: {},
    sseConnected: true,
    theme: 'dark',
    themePreference: 'system',
    conversations: [],
    conversationDetails: {},
    conversationLives: {},
    conversationArtifacts: {},
    pendingAsks: [],
    resolvedAsksByConv: {},
    plugins: [],
    uiContributions: [],
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    nodes: [],
    profiles: [],
    models: [],
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'artifacts',
    activeModal: null,
    highlightedEntry: null,
    notices: [],
    setTheme: noop,
    setThemePreference: noop,
    toggleTheme: noop,
    checkAuth: asyncNoop,
    onAuthenticated: asyncNoop,
    logout: noop,
    refreshAssets: asyncNoop,
    refreshNodes: async () => undefined,
    loadConversationDetail: asyncNoop,
    loadEarlierEntries: asyncNoop,
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop,
    openTarget: noop,
    closeSplit: noop,
    setWorkbenchOpen: noop,
    setWorkbenchTab: noop,
    setActiveModal: noop,
    dismissNotice: noop,
    pushNotice: noop,
    invokePluginAction: asyncNoop,
    ...overrides,
  }
}

const stubCtx = {
  pluginId: 'test:plugin',
  callAction: async () => undefined,
  openScreen: () => {},
  openConversationDrawer: () => {},
  openSplitScreen: () => {},
  openArtifact: () => {},
  openWorkbench: () => {},
  closeWorkbench: () => {},
  notify: () => {},
  getPluginDoc: async () => undefined,
  submitInput: async () => {},
  getPluginSessionDoc: async () => undefined,
  theme: 'dark' as const,
}

/** 在 PluginClientContext.Provider 内渲染消费 hooks 的探针组件，回传渲染结果 JSON。 */
function renderProbe<T>(store: HelmStoreValue, use: () => T): { html: string; result: T | undefined } {
  let captured: T | undefined
  function Probe(): React.ReactNode {
    captured = use()
    return e('div', { 'data-probe': '1' }, String(JSON.stringify(captured)?.slice(0, 120) ?? ''))
  }
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(PluginClientContext.Provider, { value: stubCtx }, e(Probe))),
  )
  return { html, result: captured }
}

/** 在 Provider 内真实挂载（createRoot + act，effects 真实执行）并捕获 hooks 结果。 */
function mountProbe<T>(store: HelmStoreValue, use: () => T): { result: () => T | undefined; unmount: () => void } {
  let captured: T | undefined
  function Probe(): React.ReactNode {
    captured = use()
    return e('div', { 'data-probe': '1' }, String(JSON.stringify(captured)?.slice(0, 120) ?? ''))
  }
  const host = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HelmStoreContext.Provider, { value: store }, e(PluginClientContext.Provider, { value: stubCtx }, e(Probe))))
  })
  return {
    result: () => captured,
    unmount: () => {
      act(() => root?.unmount())
    },
  }
}
test('useConversations：返回宿主 store.conversations（同一引用，实时数据源）', { timeout: 60_000 }, () => {
  const convs = [summary(1, 'idle'), summary(2, 'working')]
  const store = makeStore({ conversations: convs })
  const { result } = renderProbe(store, useConversations)
  assert.equal(result, convs, '必须返回 store.conversations 的同一引用（非拷贝）')
  assert.equal(result!.length, 2)
})

test('useConversation：详情缺失且无失败时自动加载一次（客户端 effects 真实执行）', { timeout: 60_000 }, () => {
  const calls: LoadCall[] = []
  const store = makeStore({
    conversations: [summary(11, 'working')],
    loadConversationDetail: async (id, force) => {
      calls.push({ id, force: force === true })
      return undefined
    },
  })
  const probe = mountProbe(store, () => useConversation(11))
  assert.deepEqual(calls, [{ id: 11, force: false }], '详情缺失时自动调用 loadConversationDetail（非 force）')
  const r = probe.result()
  assert.equal(r!.summary?.id, 11)
  assert.equal(r!.detail, undefined)
  assert.equal(r!.loadError, undefined)
  probe.unmount()
})

test('useConversation：详情已加载或加载失败时不重复发请求', { timeout: 60_000 }, () => {
  const calls: LoadCall[] = []
  const detail = { ...summary(11, 'idle'), entries: [], nextCursor: undefined }
  const loaded = makeStore({
    conversationDetails: { 11: detail },
    loadConversationDetail: async (id, force) => {
      calls.push({ id, force: force === true })
      return undefined
    },
  })
  const p1 = mountProbe(loaded, () => useConversation(11))
  const r1 = p1.result()
  assert.equal(calls.length, 0, '详情已存在时不得发请求')
  assert.equal(r1!.detail, detail)
  p1.unmount()

  const failed = makeStore({
    loadErrors: { 'conversation:12': '网络中断' },
    loadConversationDetail: async (id, force) => {
      calls.push({ id, force: force === true })
      return undefined
    },
  })
  const p2 = mountProbe(failed, () => useConversation(12))
  const r2 = p2.result()
  assert.deepEqual(calls, [], '已有失败记录时不得自动重试（reload 显式触发）')
  assert.equal(r2!.loadError, '网络中断')
  p2.unmount()
})

test('useConversation：pendingAsks 按会话过滤，live/summary 如实透传', { timeout: 60_000 }, () => {
  const conv = { ...summary(21, 'blocked') }
  const live = { conversationId: 21, text: '流式中', tools: [], updatedAt: 9 }
  const store = makeStore({
    conversations: [conv],
    conversationLives: { 21: live },
    pendingAsks: [ask('a1', 21), ask('a2', 31)],
    conversationDetails: { 21: { ...conv, entries: [] } },
  })
  const r = renderProbe(store, () => useConversation(21)).result
  assert.deepEqual(r!.pendingAsks.map((a) => a.id), ['a1'], '仅保留本会话审批')
  assert.equal(r!.live, live)
  assert.equal(r!.summary?.status, 'blocked')
})

test('useConversation：conversationId 为 undefined 时返回空视图且不发请求', { timeout: 60_000 }, () => {
  const calls: LoadCall[] = []
  const store = makeStore({
    loadConversationDetail: async (id, force) => {
      calls.push({ id, force: force === true })
      return undefined
    },
  })
  const probe = mountProbe(store, () => useConversation(undefined))
  const r = probe.result()
  assert.deepEqual(calls, [], '无会话上下文不得发任何请求')
  assert.equal(r!.summary, undefined)
  assert.equal(r!.detail, undefined)
  assert.deepEqual(r!.pendingAsks, [])
  r!.reload()
  probe.unmount()
})

test('useConversation：reload 调用 loadConversationDetail(id, true) 强制刷新', { timeout: 60_000 }, () => {
  const calls: LoadCall[] = []
  const store = makeStore({
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
    loadConversationDetail: async (id, force) => {
      calls.push({ id, force: force === true })
      return undefined
    },
  })
  const probe = mountProbe(store, () => useConversation(11))
  const r = probe.result()
  assert.deepEqual(calls, [], '已加载不自动请求')
  act(() => {
    r!.reload()
  })
  assert.deepEqual(calls, [{ id: 11, force: true }], 'reload 必须以 force=true 重新拉取')
  probe.unmount()
})

// ---------------------------------------------------------------------------
// openConversationDrawer：统一子会话抽屉入口（不改变工作台开关状态）
// ---------------------------------------------------------------------------

test('createPluginClientContext.openConversationDrawer：打开 conversation-drawer 模态且不触碰工作台开关', { timeout: 60_000 }, () => {
  const modals: unknown[] = []
  const workbenchCalls: boolean[] = []
  const store = makeStore({
    workbenchOpen: true,
    setActiveModal: (modal) => {
      modals.push(modal)
    },
    setWorkbenchOpen: (open) => {
      workbenchCalls.push(open)
    },
  })
  const ctx = createPluginClientContext(store, 'test:plugin', 1)
  ctx.openConversationDrawer(42)
  assert.deepEqual(modals, [{ kind: 'conversation-drawer', conversationId: 42 }], '必须设置 conversation-drawer 模态')
  assert.deepEqual(workbenchCalls, [], '不得调用 setWorkbenchOpen（工作台保持原状）')
})

test('createPluginClientContext.openConversationDrawer：工作台关闭时同样只开抽屉，不强制打开工作台', { timeout: 60_000 }, () => {
  const modals: unknown[] = []
  const workbenchCalls: boolean[] = []
  const store = makeStore({
    workbenchOpen: false,
    setActiveModal: (modal) => {
      modals.push(modal)
    },
    setWorkbenchOpen: (open) => {
      workbenchCalls.push(open)
    },
  })
  const ctx = createPluginClientContext(store, 'test:plugin', undefined)
  ctx.openConversationDrawer(7)
  assert.deepEqual(modals, [{ kind: 'conversation-drawer', conversationId: 7 }])
  assert.deepEqual(workbenchCalls, [], '抽屉入口不得强制展开工作台')
})
