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
import { PluginClientContext } from '@helm/plugin-client'
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
  workbenchCalls: string[]
  actionCalls: Array<{ actionId: string; input: unknown }>
  notifications: Array<{ message: string; tone?: 'info' | 'warning' | 'error' }>
}

function makeSpyCtx(): SpyCtx {
  const drawerCalls: number[] = []
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  const workbenchCalls: string[] = []
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const notifications: Array<{ message: string; tone?: 'info' | 'warning' | 'error' }> = []
  return {
    pluginId: 'builtin:workflow',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return undefined
    },
    submitInput: async () => {},
    getPluginSessionDoc: async () => undefined,
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
    openWorkbench: (tab) => {
      workbenchCalls.push(tab ?? '')
    },
    closeWorkbench: () => {},
    notify: (message, tone) => {
      notifications.push({ message, ...(tone !== undefined ? { tone } : {}) })
    },
    getPluginDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
    drawerCalls,
    screenCalls,
    splitCalls,
    workbenchCalls,
    actionCalls,
    notifications,
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

test('时间线单行与工作台整卡均点击触发 openConversationDrawer（不跳主屏、不开分屏）', { timeout: 60_000 }, async () => {
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
  const SubagentLiveCard = mod['SubagentLiveCard'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(SubagentToolView, {
      callId: 'call-abc', toolName: 'subagent', input: { prompt: '去修构建' },
      status: 'running', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const row = host.querySelector('button.workflow-trace-row-btn') as HTMLButtonElement | null
    assert.ok(row !== null, '时间线必须渲染单行按钮 .workflow-trace-row-btn')
    act(() => {
      row!.click()
    })
    assert.deepEqual(spy.drawerCalls, [11], '点击时间线行必须调用 openConversationDrawer(11)')
    assert.deepEqual(spy.screenCalls, [], '不得调用 openScreen 跳主屏')
    assert.deepEqual(spy.splitCalls, [], '不得调用 openSplitScreen 开分屏')

    // 工作台内的一体化整卡（SubagentLiveCard）：点击 / 回车 / 空格统一打开抽屉。
    spy.drawerCalls.length = 0
    await rerender(e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running' }))
    const card = host.querySelector('.subagent-card-clickable') as HTMLElement | null
    assert.ok(card !== null, '工作台一体化整卡必须渲染 subagent-card-clickable')
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

test('时间线单行与工作台紧凑卡均有实时内容也不内联展开（统一点击进抽屉）', { timeout: 60_000 }, async () => {
  const child = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'compact-call' }
  setWorkflowClientStub({
    docValue: { runs: [] },
    conversations: [child],
    conversation: (id) => id === 11 ? {
      summary: child,
      detail: { ...child, entries: [{ id: '1', kind: 'helm.input', data: { text: '子代理历史指令' } }] },
      live: { conversationId: 11, text: '实时回复内容', tools: [], updatedAt: 1 },
      pendingAsks: [], reload: () => {},
    } : { pendingAsks: [], reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule()
  const Tool = mod.SubagentToolView as React.ComponentType<Record<string, unknown>>
  const Panel = mod.WorkflowWorkbenchPanel as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(spy, e(Tool, {
    callId: 'compact-call', toolName: 'subagent', status: 'running', conversationId: 1,
    input: { prompt: '本次任务' }, result: '原始工具输出', artifactRef: 'art_original',
  }))
  const assertCompact = () => {
    assert.ok(host.querySelector('.subagent-live-stream') === null, '不能显示内联实时流')
    assert.ok(host.querySelector('.subagent-live-card-expanded') === null, '不能使用展开态样式')
    assert.ok(host.querySelector('details') === null, '不能提供原始调用详情的展开入口')
    assert.ok(host.querySelector('[aria-expanded]') === null, '不能有展开控件')
  }
  try {
    assertCompact()
    const traceBtn = host.querySelector('button.workflow-trace-row-btn') as HTMLElement
    assert.ok(traceBtn)
    await act(async () => { traceBtn.click() })
    assert.deepEqual(spy.drawerCalls, [11], '时间线行点击仅打开抽屉')
    assertCompact()
    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    assertCompact()
    const workbenchCard = host.querySelector('.subagent-card-clickable') as HTMLElement
    assert.ok(workbenchCard)
    await act(async () => { workbenchCard.click() })
    assert.deepEqual(spy.drawerCalls, [11, 11], '工作台整卡点击同样仅打开抽屉')
    assertCompact()
  } finally { unmount() }
})

test('历史续接行不展开详情，点击统一打开子会话抽屉', { timeout: 60_000 }, async () => {
  const child = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'new-call' }
  setWorkflowClientStub({ conversations: [child] })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule()
  const Tool = mod.SubagentToolView as React.ComponentType<Record<string, unknown>>
  const oldResult = JSON.stringify({ execution: { conversationId: 11 } })
  const { host, unmount } = await mountClient(spy, e(Tool, {
    callId: 'old-call', toolName: 'subagent', status: 'error', isError: true, conversationId: 1,
    input: { prompt: '首次任务' }, result: oldResult,
    siblingCalls: [
      { callId: 'old-call', toolName: 'subagent', status: 'error', result: oldResult },
      { callId: 'new-call', toolName: 'subagent', status: 'running', input: { resume: '11' } },
    ],
  }))
  try {
    const row = host.querySelector('button.trace-row') as HTMLButtonElement
    assert.ok(row)
    assert.equal(row.tagName, 'BUTTON', '原生 button 支持回车/空格触发')
    assert.equal(row.classList.contains('trace-row-error'), true)
    assert.match(row.textContent!, /已在下文续接/)
    assert.match(row.textContent!, /异常/)
    assert.ok(host.querySelector('details') === null)
    assert.equal(row.getAttribute('aria-expanded'), null, '直连抽屉的行不设展开态')
    await act(async () => { row.click() })
    assert.deepEqual(spy.drawerCalls, [11])
    assert.deepEqual(spy.screenCalls, [])
    assert.deepEqual(spy.splitCalls, [])
    assert.ok(host.querySelector('details') === null, '打开后不能产生内联展开详情')
    assert.ok(host.querySelector('.subagent-live-stream') === null)
  } finally { unmount() }
})

test('外部子代理在工作台渲染摘要（无原生子会话且不虚构详情），时间线亦不虚构子会话', { timeout: 60_000 }, async () => {
  const externalRun = {
    id: 'wf_ext',
    name: '外部任务',
    conversationId: 1,
    kind: 'subagent',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'external-call',
    nodes: [{ id: 'external', kind: 'agent', status: 'done', executionId: 'pane-42' }],
  }
  setWorkflowClientStub({ conversations: [], docValue: { runs: [externalRun] } })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule()
  const Tool = mod.SubagentToolView as React.ComponentType<Record<string, unknown>>
  const Panel = mod.WorkflowWorkbenchPanel as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(spy, e(Tool, {
    callId: 'external-call', toolName: 'subagent', status: 'done', conversationId: 1,
    input: { prompt: '外部任务' }, result: JSON.stringify({ execution: { executionId: 'pane-42' } }),
  }))
  try {
    const row = host.querySelector('button.workflow-trace-row-btn') as HTMLElement | null
    assert.ok(row !== null, '时间线渲染单行轨迹')
    assert.match(row.textContent ?? '', /外部代理/)
    await act(async () => { row.click() })
    assert.deepEqual(spy.drawerCalls, [], '外部任务不能虚构原生子会话')
    assert.deepEqual(spy.workbenchCalls, ['plugin:builtin:workflow/tasks'], '有关联 run 时点击打开工作台查看详情')

    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    assert.ok(host.querySelector('.subagent-external-card') !== null, '工作台渲染 ExternalRunSummary')
    assert.ok(host.querySelector('details') === null)
    assert.ok(host.querySelector('.subagent-live-card-expanded') === null)
    assert.deepEqual(spy.drawerCalls, [], '外部任务不能虚构原生子会话')
  } finally { unmount() }
})

test('工作流时间线点击定位工作台，工作台节点内嵌子代理卡直出且走统一抽屉入口（无手风琴折叠壳）', { timeout: 60_000 }, async () => {
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
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(WorkflowToolView, {
      callId: 'wf_call', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'done', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    const toolRow = host.querySelector('button.workflow-trace-row-btn') as HTMLElement | null
    assert.ok(toolRow, '工作流时间线渲染紧凑单行')
    act(() => {
      toolRow!.click()
    })
    assert.deepEqual(spy.workbenchCalls, ['plugin:builtin:workflow/tasks'], '点击时间线行打开工作台任务面板')

    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    const cards = host.querySelectorAll('.subagent-card-clickable')
    assert.ok(cards.length >= 1, '工作台节点内子代理卡必须直出（一体化整卡）')
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
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(Panel, { conversation: summary(1, 'idle') }),
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

test('前台同步运行卡「转入后台」点击调用 detach 动作（工作流卡与子代理卡），不打开抽屉', { timeout: 60_000 }, async () => {
  const fgRun = {
    id: 'wf_fg_x',
    name: '同步工作流',
    conversationId: 1,
    kind: 'workflow' as const,
    status: 'running' as const,
    syncForeground: true,
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'call-fg-x',
    nodes: [{ id: 'a', kind: 'agent' as const, status: 'running' as const }],
  }
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('WorkflowRunCard.tsx')
  const Body = mod.WorkflowRunCardBody as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(
    spy,
    e(Body, {
      run: fgRun, cardOpen: false, onToggleCard: () => {}, resultOpen: false, onToggleResult: () => {},
      viewer: { conversationId: 1 },
    }),
  )
  try {
    const detach = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('转入后台')) as HTMLElement | undefined
    assert.ok(detach, '前台同步工作流卡应渲染转入后台按钮')
    await act(async () => { detach!.click() })
    assert.deepEqual(spy.actionCalls, [{ actionId: 'detach', input: { runId: 'wf_fg_x' } }], '点击必须调用 detach 动作并携带 runId')
    assert.deepEqual(spy.drawerCalls, [], '点击转入后台不得打开抽屉')

    // 子代理卡（后台 run 为前台同步）：动作栏按钮同样调用 detach。
    const child = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'compact-fg' }
    setWorkflowClientStub({ conversations: [child] })
    const spy2 = makeSpyCtx()
    const indexMod = await importWorkflowClientModule()
    const Card = indexMod.SubagentLiveCard as React.ComponentType<Record<string, unknown>>
    const sub = await mountClient(
      spy2,
      e(Card, {
        childConversationId: 11, toolStatus: 'running',
        backgroundRun: { ...fgRun, id: 'wf_fg_sub', kind: 'subagent' },
        viewer: { conversationId: 1, ownedBy: 'human' },
      }),
    )
    try {
      const btn = [...sub.host.querySelectorAll('button')].find((b) => b.textContent?.includes('转入后台')) as HTMLElement | undefined
      assert.ok(btn, '前台同步子代理卡应渲染转入后台按钮')
      await act(async () => { btn!.click() })
      assert.deepEqual(spy2.actionCalls, [{ actionId: 'detach', input: { runId: 'wf_fg_sub' } }])
      assert.deepEqual(spy2.drawerCalls, [])
    } finally {
      sub.unmount()
    }
  } finally {
    unmount()
  }
})

test('后台子代理卡单卡「恢复」：点击派发 run 续接参数、防连点、stopPropagation，且 resumedByRunId 接管后隐藏', { timeout: 60_000 }, async () => {
  const child = { ...summary(11, 'error'), parentConversationId: 1, parentToolCallId: 'call-sub-fail' } as ConversationSummary
  const failedSubRun = {
    id: 'wf_sub_fail',
    name: '子代理任务',
    conversationId: 1,
    kind: 'subagent' as const,
    status: 'failed' as const,
    error: '上游网关超时',
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'call-sub-fail',
    nodes: [{ id: 's0', kind: 'agent' as const, status: 'failed' as const, conversationId: 11 }],
  }
  setWorkflowClientStub({
    conversations: [child],
    conversation: (id) =>
      id === 11
        ? { summary: child, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  let resolveRun: ((value: unknown) => void) | undefined
  let rejectRun: ((reason?: unknown) => void) | undefined
  const spy = makeSpyCtx()
  spy.callAction = async (actionId, input) => {
    spy.actionCalls.push({ actionId, input })
    return await new Promise((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
  }
  const mod = await importWorkflowClientModule('index.tsx')
  const Card = mod['SubagentLiveCard'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(Card, { childConversationId: 11, toolStatus: 'error', backgroundRun: failedSubRun }),
  )
  try {
    const resumeBtn = host.querySelector('button[aria-label="恢复该后台子代理任务"]') as HTMLButtonElement | null
    assert.ok(resumeBtn !== null, '失败后台子代理卡应渲染恢复按钮')
    assert.equal(resumeBtn.textContent, '恢复')

    // 同拍连点只派发一次，按钮进入 disabled 防重。
    await act(async () => {
      resumeBtn.click()
      resumeBtn.click()
    })
    assert.deepEqual(
      spy.actionCalls,
      [{ actionId: 'run', input: { resumeFromRunId: 'wf_sub_fail', conversationId: 1 } }],
      '单卡恢复必须调 run({ resumeFromRunId, conversationId }) 且同拍连点只发一次',
    )
    assert.deepEqual(spy.drawerCalls, [], '点击恢复按钮不得冒泡触发打开抽屉')
    assert.equal(resumeBtn.disabled, true, '在途恢复期间按钮应禁用')
    assert.ok(resumeBtn.querySelector('svg.spin-slow') !== null, '在途恢复期间图标应旋转')

    await act(async () => {
      resolveRun?.({ run: { id: 'wf_sub_resumed' } })
    })
    assert.equal(resumeBtn.disabled, false)
    assert.equal(spy.notifications.length, 1)
    assert.match(spy.notifications[0]!.message, /已发起恢复/)
    assert.equal(spy.notifications[0]!.tone, undefined)

    // aborted 态同样可恢复，失败响应应 notify(..., 'error')。
    await rerender(
      e(Card, {
        childConversationId: 11,
        toolStatus: 'error',
        backgroundRun: { ...failedSubRun, status: 'aborted' },
      }),
    )
    const abortedBtn = host.querySelector('button[aria-label="恢复该后台子代理任务"]') as HTMLButtonElement | null
    assert.ok(abortedBtn !== null, 'aborted 后台子代理卡同样应渲染恢复按钮')
    await act(async () => {
      abortedBtn.click()
    })
    await act(async () => {
      rejectRun?.(new Error('服务忙'))
    })
    assert.equal(spy.notifications.length, 2)
    assert.equal(spy.notifications[1]!.tone, 'error')
    assert.match(spy.notifications[1]!.message, /服务忙/)

    // resumedByRunId 已接管：隐藏恢复按钮。
    await rerender(
      e(Card, {
        childConversationId: 11,
        toolStatus: 'error',
        backgroundRun: { ...failedSubRun, resumedByRunId: 'wf_sub_resumed' },
      }),
    )
    assert.ok(
      host.querySelector('button[aria-label="恢复该后台子代理任务"]') === null,
      'resumedByRunId 已接管后必须隐藏单卡恢复按钮',
    )
  } finally {
    unmount()
  }
})

test('DSL 工作流卡 resumedByRunId 已接管时隐藏「断点恢复」按钮', { timeout: 60_000 }, async () => {
  const failedDsl = {
    id: 'wf_dsl_fail',
    name: '编排流',
    conversationId: 1,
    kind: 'workflow' as const,
    status: 'failed' as const,
    error: '节点失败',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'n1', kind: 'agent' as const, status: 'failed' as const }],
  }
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('WorkflowRunCard.tsx')
  const Body = mod['WorkflowRunCardBody'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(Body, {
      run: failedDsl,
      cardOpen: false,
      onToggleCard: () => {},
      resultOpen: false,
      onToggleResult: () => {},
      inWorkbench: true,
    }),
  )
  try {
    assert.ok(
      [...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('断点恢复')),
      '未接管的失败 DSL 工作流应渲染断点恢复按钮',
    )
    await rerender(
      e(Body, {
        run: { ...failedDsl, resumedByRunId: 'wf_dsl_next' },
        cardOpen: false,
        onToggleCard: () => {},
        resultOpen: false,
        onToggleResult: () => {},
        inWorkbench: true,
      }),
    )
    assert.ok(
      ![...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('断点恢复')),
      'resumedByRunId 已接管后必须隐藏断点恢复按钮',
    )
  } finally {
    unmount()
  }
})

test('工作台顶栏「恢复失败 (N)」显隐、防连点、resume_failed 载荷与 skipped 通知反馈', { timeout: 60_000 }, async () => {
  const child11 = { ...summary(11, 'error'), parentConversationId: 1, parentToolCallId: 'c-sub' } as ConversationSummary
  const runs = [
    {
      id: 'wf_fail_1',
      name: '工作流 1',
      conversationId: 1,
      kind: 'workflow' as const,
      status: 'failed' as const,
      error: 'gate exit 1',
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 'a', kind: 'agent' as const, status: 'failed' as const }],
    },
    {
      id: 'wf_fail_2',
      name: '子代理 2',
      conversationId: 1,
      kind: 'subagent' as const,
      status: 'failed' as const,
      error: 'timeout',
      createdAt: 3,
      updatedAt: 4,
      parentToolCallId: 'c-sub',
      nodes: [{ id: 's', kind: 'agent' as const, status: 'failed' as const, conversationId: 11 }],
    },
    {
      id: 'wf_uncertain',
      name: '不确定工作流',
      conversationId: 1,
      kind: 'workflow' as const,
      status: 'failed' as const,
      error: 'workflow_action_uncertain: action left dangling',
      createdAt: 5,
      updatedAt: 6,
      nodes: [{ id: 'a', kind: 'action' as const, status: 'failed' as const }],
    },
    {
      id: 'wf_taken',
      name: '已接管工作流',
      conversationId: 1,
      kind: 'workflow' as const,
      status: 'failed' as const,
      resumedByRunId: 'wf_new',
      createdAt: 7,
      updatedAt: 8,
      nodes: [{ id: 'a', kind: 'action' as const, status: 'failed' as const }],
    },
    {
      id: 'wf_child_conv',
      name: '后代会话失败',
      conversationId: 11,
      kind: 'workflow' as const,
      status: 'failed' as const,
      createdAt: 9,
      updatedAt: 10,
      nodes: [{ id: 'a', kind: 'action' as const, status: 'failed' as const }],
    },
  ]
  setWorkflowClientStub({
    docValue: { runs },
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  let resolveBatch: ((value: unknown) => void) | undefined
  const spy = makeSpyCtx()
  spy.callAction = async (actionId, input) => {
    spy.actionCalls.push({ actionId, input })
    return await new Promise((resolve) => {
      resolveBatch = resolve
    })
  }
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(Panel, { conversation: summary(1, 'idle') }),
  )
  try {
    const batchBtn = host.querySelector('button[aria-label="恢复失败 (2)"]') as HTMLButtonElement | null
    assert.ok(batchBtn !== null, '工作台顶栏应仅计入当前会话可恢复的 2 条失败任务')
    assert.equal(batchBtn.textContent, '恢复失败 (2)')

    // 同步双击只发出一次 resume_failed({ conversationId: 1 })。
    await act(async () => {
      batchBtn.click()
      batchBtn.click()
    })
    assert.deepEqual(
      spy.actionCalls,
      [{ actionId: 'resume_failed', input: { conversationId: 1 } }],
      '批量恢复必须调用 resume_failed({ conversationId }) 且防连点',
    )
    assert.equal(batchBtn.disabled, true, '批量恢复进行中按钮应禁用')
    assert.ok(batchBtn.querySelector('svg.spin-slow') !== null, '批量恢复进行中图标应旋转')

    await act(async () => {
      resolveBatch?.({
        resumed: [{ id: 'wf_r1' }, { id: 'wf_r2' }],
        skipped: [{ runId: 'wf_uncertain', reason: 'workflow_action_uncertain' }],
      })
    })
    assert.equal(batchBtn.disabled, false)
    assert.equal(spy.notifications.length, 1)
    assert.match(spy.notifications[0]!.message, /2/)
    assert.match(spy.notifications[0]!.message, /跳过 1/)

    // 当剩余可恢复失败任务归零后按钮隐藏；非法返回体触发 error 通知。
    setWorkflowClientStub({
      docValue: {
        runs: runs.map((r) => (r.id === 'wf_fail_1' || r.id === 'wf_fail_2' ? { ...r, resumedByRunId: 'wf_done' } : r)),
      },
      conversations: [child11],
      conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
    })
    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    assert.ok(
      ![...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('恢复失败')),
      '无可恢复失败任务时顶栏恢复失败按钮应隐藏',
    )

    // 恢复单条可恢复记录并验证非法响应形状显式报错。
    setWorkflowClientStub({
      docValue: { runs: [runs[0]!] },
      conversations: [],
      conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
    })
    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    const oneBtn = host.querySelector('button[aria-label="恢复失败 (1)"]') as HTMLButtonElement | null
    assert.ok(oneBtn !== null)
    await act(async () => {
      oneBtn.click()
    })
    await act(async () => {
      resolveBatch?.({ unexpected: true })
    })
    assert.equal(spy.notifications.length, 2)
    assert.equal(spy.notifications[1]!.tone, 'error')
  } finally {
    unmount()
  }
})
