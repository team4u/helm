/**
 * builtin:workflow 插件 client 交互测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * - 一体化整卡点击 / 回车触发 ctx.openConversationDrawer（不跳主屏、不开分屏）；
 * - 工作流节点内嵌子代理卡同样走统一抽屉入口；
 * - 中止 / 清理按钮 stopPropagation（点击按钮不触发整卡打开抽屉）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSummary, PluginClientContext as PluginClientContextType } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import {
  importWorkflowClientModule,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
// React 19 act 环境：事件处理器在 act 外静默抑制更新断言；显式开启
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function summary(id: number, status: ConversationSummary['status']): ConversationSummary {
  return {
    id,
    title: `子会话 ${id}`,
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

interface SpyCtx extends PluginClientContextType {
  drawerCalls: number[]
  screenCalls: string[]
  splitCalls: string[]
}

function makeSpyCtx(): SpyCtx {
  const drawerCalls: number[] = []
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  return {
    pluginId: 'builtin:workflow',
    callAction: async () => undefined,
    openScreen: (t) => {
      screenCalls.push(t)
    },
    openSplitScreen: (t) => {
      splitCalls.push(t)
    },
    openConversationDrawer: (id) => {
      drawerCalls.push(id)
    },
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
    drawerCalls,
    screenCalls,
    splitCalls,
  }
}

/** 真实客户端挂载编译产物组件并返回根容器与清理函数。 */
async function mountClient(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; rerender: (element: React.ReactElement) => Promise<void>; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  await act(async () => {
    root = createRoot(host)
    root.render(e(PluginClientContext.Provider, { value: ctx }, element))
  })
  await act(async () => {})
  return {
    host,
    rerender: async (element) => {
      await act(async () => { root?.render(e(PluginClientContext.Provider, { value: ctx }, element)) })
    },
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

test('一体化整卡点击 / 回车触发 openConversationDrawer（不跳主屏、不开分屏）', { timeout: 60_000 }, async () => {
  const child11 = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'call-abc', doing: '正在跑测试' } as ConversationSummary
  setWorkflowClientStub({
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const SubagentToolView = mod['SubagentToolView'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(SubagentToolView, {
      callId: 'call-abc', toolName: 'subagent', input: { prompt: '去修构建' },
      status: 'running', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const card = host.querySelector('.subagent-card-clickable') as HTMLElement | null
    assert.ok(card !== null, '一体化整卡必须渲染 subagent-card-clickable')
    act(() => {
      card!.click()
    })
    assert.deepEqual(spy.drawerCalls, [11], '点击整卡必须调用 openConversationDrawer(11)')
    assert.deepEqual(spy.screenCalls, [], '不得调用 openScreen 跳主屏')
    assert.deepEqual(spy.splitCalls, [], '不得调用 openSplitScreen 开分屏')
    spy.drawerCalls.length = 0
    act(() => {
      card!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(spy.drawerCalls, [11], '回车必须同样触发抽屉入口')
    spy.drawerCalls.length = 0
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    act(() => { card!.dispatchEvent(space) })
    assert.deepEqual(spy.drawerCalls, [11], '空格必须同样触发抽屉入口')
    assert.equal(space.defaultPrevented, true, '空格打开卡片时不得滚动页面')
  } finally {
    unmount()
  }
})

test('工作流节点内嵌子代理卡同样走统一抽屉入口（无手风琴折叠壳）', { timeout: 60_000 }, async () => {
  const child12 = { ...summary(12, 'done'), parentConversationId: 1 } as ConversationSummary
  const wf = {
    id: 'wf_nodes', name: '节点工作流', conversationId: 1, status: 'completed',
    createdAt: 1, updatedAt: 2, parentToolCallId: 'wf_call',
    nodes: [
      { id: 'n1', kind: 'agent', status: 'done', conversationId: 12, label: '实现者' },
      { id: 'n2', kind: 'action', status: 'done', label: '落盘报告', output: 'ok' },
    ],
  }
  setWorkflowClientStub({
    docValue: { runs: [wf] },
    conversations: [child12],
    conversation: (id) =>
      id === 12
        ? { summary: child12, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowToolView = mod['WorkflowToolView'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(WorkflowToolView, {
      callId: 'wf_call', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const cards = host.querySelectorAll('.subagent-card-clickable')
    assert.ok(cards.length >= 1, '工作流节点内子代理卡必须直出（一体化整卡）')
    assert.ok(host.innerHTML.includes('workflow-action-card'), '动作节点应渲染扁平双层卡')
    assert.ok(!host.innerHTML.includes('展开节点详情'), '不得有手风琴折叠按钮')
    act(() => {
      ;(cards[0] as HTMLElement).click()
    })
    assert.deepEqual(spy.drawerCalls, [12], '节点内子代理卡点击必须走统一抽屉入口')
  } finally {
    unmount()
  }
})

test('中止 / 清理按钮 stopPropagation：点击按钮不触发整卡打开抽屉', { timeout: 60_000 }, async () => {
  const child11 = { ...summary(11, 'idle'), parentConversationId: 1, parentToolCallId: 'call-bg' } as ConversationSummary
  const bgRun = {
    id: 'wf_bg', name: '后台任务', conversationId: 1, kind: 'subagent',
    status: 'running', createdAt: 1, updatedAt: 2, parentToolCallId: 'call-bg',
    nodes: [{ id: 'n', kind: 'agent', status: 'running', conversationId: 11, worktree: { path: '/wt/x', branch: 'helm/x' } }],
  }
  setWorkflowClientStub({
    docValue: { runs: [bgRun] },
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const actionCalls: Array<[string, unknown]> = []
  const spy = makeSpyCtx()
  spy.callAction = async (actionId, input) => {
    actionCalls.push([actionId, input])
    return undefined
  }
  const mod = await importWorkflowClientModule('index.tsx')
  const SubagentToolView = mod['SubagentToolView'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(SubagentToolView, {
      callId: 'call-bg', toolName: 'subagent', input: { prompt: '后台任务' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const abortBtn = host.querySelector('.subagent-live-actions .btn-danger') as HTMLElement | null
    assert.ok(abortBtn !== null, '后台 run running 时应渲染中止按钮')
    act(() => {
      abortBtn!.click()
    })
    assert.deepEqual(actionCalls.map(([id]) => id), ['abort'], '按钮必须触发 abort 动作')
    const cleanup = host.querySelector('[aria-label="清理隔离工作树"]') as HTMLElement
    assert.ok(cleanup)
    await act(async () => { cleanup.click() })
    assert.deepEqual(actionCalls, [['abort', { runId: 'wf_bg' }], ['cleanup_worktree', { path: '/wt/x' }]])
    for (const button of [abortBtn!, cleanup]) {
      for (const key of ['Enter', ' ']) {
        act(() => { button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
      }
    }
    assert.deepEqual(spy.drawerCalls, [], '动作按钮点击与键盘不得冒泡触发整卡抽屉入口')
  } finally {
    unmount()
  }
})

test('详情加载失败可重试；内嵌详情、重试与产物操作的点击/键盘不打开抽屉', { timeout: 60_000 }, async () => {
  let reloads = 0
  const child = summary(11, 'done')
  setWorkflowClientStub({
    conversation: () => ({ summary: child, pendingAsks: [], loadError: '网关超时', reload: () => { reloads++ } }),
  })
  const spy = makeSpyCtx()
  const artifacts: string[] = []
  spy.openArtifact = (id) => { artifacts.push(id) }
  const mod = await importWorkflowClientModule()
  const Card = mod.SubagentLiveCard as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Card, {
    childConversationId: 11, toolStatus: 'done', expanded: true,
    callDetails: { input: { resume: 11, prompt: '原始续接指令' }, result: '原始结果', artifactRef: 'art_full' },
  }))
  try {
    assert.match(host.textContent!, /加载失败.*网关超时/)
    const retry = host.querySelector('[aria-label="重新加载子会话详情"]') as HTMLElement
    const details = host.querySelector('details')!
    const summary = details.querySelector('summary')!
    await act(async () => { retry.click(); summary.click() })
    assert.equal(reloads, 1)
    const artifact = details.querySelector('button') as HTMLElement
    assert.ok(artifact)
    await act(async () => { artifact.click() })
    assert.deepEqual(artifacts, ['art_full'])
    assert.match(details.textContent!, /"resume": 11/)
    assert.match(details.textContent!, /原始结果/)
    for (const control of [retry, summary, artifact]) {
      for (const key of ['Enter', ' ']) {
        act(() => { control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
      }
    }
    assert.deepEqual(spy.drawerCalls, [], '重试与内嵌详情不得打开抽屉')

    assert.ok(details.classList.contains('tool-call-details'))
  } finally {
    unmount()
  }
})

test('工具输出从未返回到对象再到文本时保留 hook 顺序，调用详情始终可用', { timeout: 60_000 }, async () => {
  setWorkflowClientStub()
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('ToolCallDetailsInline.tsx')
  const Details = mod.ToolCallDetailsInline as React.ComponentType<Record<string, unknown>>
  const artifacts: string[] = []
  spy.openArtifact = (id) => { artifacts.push(id) }
  const { host, rerender, unmount } = await mountClient(spy, e(Details, { input: { prompt: '任务' } }))
  try {
    await rerender(e(Details, { result: { ok: true }, artifactRef: 'art_full' }))
    assert.match(host.textContent!, /"ok": true/)
    await act(async () => { (host.querySelector('button') as HTMLElement).click() })
    assert.deepEqual(artifacts, ['art_full'])
    await rerender(e(Details, { result: '完成' }))
    assert.match(host.textContent!, /完成/)
  } finally {
    unmount()
  }
})
