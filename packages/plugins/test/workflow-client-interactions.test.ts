/**
 * builtin:workflow 插件 client 交互测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * - 一体化整卡点击 / 回车触发 ctx.openConversationDrawer（不跳主屏、不开分屏）；
 * - 工作流节点内嵌子代理卡同样走统一抽屉入口；
 * - 中止 / 清理按钮 stopPropagation（点击按钮不触发整卡打开抽屉）；
 * - 前台同步「转入后台」detach、单卡恢复、工作台顶栏批量 resume_failed。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import {
  React,
  SDK,
  act,
  createRoot,
  importWorkflowClientModule,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
const { PluginClientContext, resolveLocalizedText } = SDK

mountSharedPluginNamespaces()

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
    locale: 'en' as const,
    translate: (text) => resolveLocalizedText(text, 'en'),
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
    rerender: async (next) => {
      await act(async () => { root?.render(e(PluginClientContext.Provider, { value: ctx }, next)) })
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
    const card = host.querySelector('.subagent-card-clickable') as HTMLButtonElement | null
    assert.ok(card !== null, '工作台一体化整卡必须渲染 subagent-card-clickable')
    assert.equal(card.tagName, 'BUTTON', '整卡主体是真实导航 button（动作区为同级结构，无嵌套交互）')
    assert.equal(card.querySelectorAll('button').length, 0, '导航按钮内无嵌套交互')
    act(() => {
      card!.click()
    })
    assert.deepEqual(spy.drawerCalls, [11], '点击整卡主体必须调用 openConversationDrawer(11)')
    assert.deepEqual(spy.screenCalls, [], '不得调用 openScreen 跳主屏')
    assert.deepEqual(spy.splitCalls, [], '不得调用 openSplitScreen 开分屏')
    // 真实 button 的 Enter/Space 由 UA 原生激活；此处验证可聚焦性。
    card!.focus()
    assert.ok(host.ownerDocument.activeElement === card, '整卡主体按钮可聚焦（回车/空格原生触发）')
  } finally {
    unmount()
  }
})

test('时间线单行与工作台紧凑卡均有实时内容也不内联展开（统一点击进抽屉）', { timeout: 60_000 }, async () => {
  const child = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'compact-call' }
  const compactRun = {
    id: 'wf_compact',
    name: '本次任务',
    conversationId: 1,
    kind: 'subagent' as const,
    status: 'running' as const,
    createdAt: 1,
    updatedAt: 2,
    parentToolCallId: 'compact-call',
    nodes: [{ id: 'agent', kind: 'agent' as const, status: 'running' as const, conversationId: 11 }],
  }
  setWorkflowClientStub({
    docValue: { runs: [compactRun] },
    conversations: [child],
    conversation: (id) => id === 11 ? {
      summary: child,
      detail: { ...child, entries: [{ id: '1', kind: 'helmx.input', data: { text: '子代理历史指令' } }] },
      live: { conversationId: 11, text: '实时回复内容', tools: [], updatedAt: 1 },
      pendingAsks: [], reload: () => {},
    } : { pendingAsks: [], reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule()
  const Tool = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
  const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(spy, e(Tool, {
    callId: 'compact-call', toolName: 'subagent', status: 'running', conversationId: 1,
    input: { prompt: '本次任务' }, result: '原始工具输出', artifactRef: 'art_original',
  }))
  const assertCompact = () => {
    assert.ok(host.querySelector('.subagent-live-stream') === null, '不能显示内联实时流')
    assert.ok(host.querySelector('.subagent-live-card-expanded') === null, '不能使用展开态样式')
    assert.ok(host.querySelector('details') === null, '不能提供原始调用详情的展开入口')
    assert.equal(host.querySelectorAll('[aria-expanded]').length, 0, '紧凑卡直接打开详情，不提供内联展开控件')
  }
  try {
    assertCompact()
    const traceBtn = host.querySelector('button.workflow-trace-row-btn') as HTMLElement
    assert.ok(traceBtn !== null)
    await act(async () => { traceBtn.click() })
    assert.deepEqual(spy.drawerCalls, [11], '时间线行点击仅打开抽屉')
    assertCompact()
    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    assertCompact()
    const workbenchCard = host.querySelector('.subagent-card-clickable') as HTMLElement
    assert.ok(workbenchCard !== null)
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
  const Tool = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
  const oldOutput = { execution: { conversationId: 11 } }
  const oldResult = JSON.stringify(oldOutput)
  const { host, unmount } = await mountClient(spy, e(Tool, {
    callId: 'old-call', toolName: 'subagent', status: 'error', isError: true, conversationId: 1,
    input: { prompt: '首次任务' }, result: oldResult, structuredOutput: oldOutput,
    siblingCalls: [
      { callId: 'old-call', toolName: 'subagent', status: 'error', result: oldResult, structuredOutput: oldOutput },
      { callId: 'new-call', toolName: 'subagent', status: 'running', input: { resume: '11' } },
    ],
  }))
  try {
    const row = host.querySelector('button.trace-row') as HTMLButtonElement
    assert.ok(row !== null)
    assert.equal(row.tagName, 'BUTTON', '原生 button 支持回车/空格触发')
    assert.equal(row.classList.contains('trace-row-error'), true)
    assert.match(row.textContent!, /Resumed below/)
    assert.match(row.textContent!, /Error/)
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
  const Tool = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
  const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const extOut = { execution: { executionId: 'pane-42' } }
  const { host, rerender, unmount } = await mountClient(spy, e(Tool, {
    callId: 'external-call', toolName: 'subagent', status: 'done', conversationId: 1,
    input: { prompt: '外部任务' }, result: JSON.stringify(extOut), structuredOutput: extOut,
  }))
  try {
    const row = host.querySelector('button.workflow-trace-row-btn') as HTMLElement | null
    assert.ok(row !== null, '时间线渲染单行轨迹')
    assert.match(row.textContent ?? '', /External agent/)
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
    assert.ok(toolRow !== null, '工作流时间线渲染紧凑单行')
    act(() => {
      toolRow!.click()
    })
    assert.deepEqual(spy.workbenchCalls, ['plugin:builtin:workflow/tasks'], '点击时间线行打开工作台任务面板')

    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    const cards = host.querySelectorAll('.subagent-card-clickable')
    assert.ok(cards.length >= 1, '工作台节点内子代理卡必须直出（一体化整卡）')
    assert.ok(host.innerHTML.includes('workflow-action-card'), '动作节点应渲染扁平双层卡')
    assert.ok(!host.innerHTML.includes('展开Node details'), '不得有手风琴折叠按钮')
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
    nodes: [{ id: 'n', kind: 'agent', status: 'running', conversationId: 11, worktree: { path: '/wt/x', branch: 'helmx/x' } }],
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
    const cleanup = host.querySelector('[aria-label="Clean up isolated worktree"]') as HTMLElement | null
    assert.ok(cleanup !== null)
    await act(async () => { cleanup!.click() })
    assert.deepEqual(actionCalls, [['abort', { runId: 'wf_bg' }], ['cleanup_worktree', { path: '/wt/x' }]])
    for (const button of [abortBtn!, cleanup!]) {
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
  const Card = mod['SubagentLiveCard'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Card, {
    childConversationId: 11, toolStatus: 'done', expanded: true,
    callDetails: { input: { resume: 11, prompt: '原始续接指令' }, result: '原始结果', artifactRef: 'art_full' },
  }))
  try {
    assert.match(host.textContent!, /Load failed.*网关超时/)
    const retry = host.querySelector('[aria-label="Reload subagent details"]') as HTMLElement
    const details = host.querySelector('details')!
    const sum = details.querySelector('summary')!
    await act(async () => { retry.click(); sum.click() })
    assert.equal(reloads, 1)
    const artifact = details.querySelector('button') as HTMLElement | null
    assert.ok(artifact !== null)
    await act(async () => { artifact!.click() })
    assert.deepEqual(artifacts, ['art_full'])
    assert.match(details.textContent!, /"resume": 11/)
    assert.match(details.textContent!, /原始结果/)
    for (const control of [retry, sum, artifact!]) {
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
  const Details = mod['ToolCallDetailsInline'] as React.ComponentType<Record<string, unknown>>
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
  const Body = mod['WorkflowRunCardBody'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(
    spy,
    e(Body, {
      run: fgRun, cardOpen: false, onToggleCard: () => {}, resultOpen: false, onToggleResult: () => {},
      viewer: { conversationId: 1 },
    }),
  )
  try {
    const detach = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Move to background')) as HTMLElement | undefined
    assert.ok(detach !== undefined, '前台同步工作流卡应渲染转入后台按钮')
    await act(async () => { detach!.click() })
    assert.deepEqual(spy.actionCalls, [{ actionId: 'detach', input: { runId: 'wf_fg_x' } }], '点击必须调用 detach 动作并携带 runId')
    assert.deepEqual(spy.drawerCalls, [], '点击转入后台不得打开抽屉')

    // 子代理卡（后台 run 为前台同步）：动作栏按钮同样调用 detach。
    const child = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'compact-fg' }
    setWorkflowClientStub({ conversations: [child] })
    const spy2 = makeSpyCtx()
    const indexMod = await importWorkflowClientModule()
    const Card = indexMod['SubagentLiveCard'] as React.ComponentType<Record<string, unknown>>
    const sub = await mountClient(
      spy2,
      e(Card, {
        childConversationId: 11, toolStatus: 'running',
        backgroundRun: { ...fgRun, id: 'wf_fg_sub', kind: 'subagent' },
        viewer: { conversationId: 1, ownedBy: 'human' },
      }),
    )
    try {
      const btn = [...sub.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Move to background')) as HTMLElement | undefined
      assert.ok(btn !== undefined, '前台同步子代理卡应渲染转入后台按钮')
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
    resumable: true,
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
    const resumeBtn = host.querySelector('button[aria-label="Resume this background subagent task"]') as HTMLButtonElement | null
    assert.ok(resumeBtn !== null, '失败后台子代理卡应渲染恢复按钮')
    assert.equal(resumeBtn.textContent, 'Resume')

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
    assert.match(spy.notifications[0]!.message, /Resume initiated/)
    assert.equal(spy.notifications[0]!.tone, undefined)

    // aborted 态同样可恢复，失败响应应 notify(..., 'error')。
    await rerender(
      e(Card, {
        childConversationId: 11,
        toolStatus: 'error',
        backgroundRun: { ...failedSubRun, status: 'aborted' },
      }),
    )
    const abortedBtn = host.querySelector('button[aria-label="Resume this background subagent task"]') as HTMLButtonElement | null
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
      host.querySelector('button[aria-label="Resume this background subagent task"]') === null,
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
    resumable: true,
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
      [...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Resume from checkpoint')),
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
      ![...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Resume from checkpoint')),
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
      resumable: true,
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
      resumable: true,
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
      resumable: false,
      errorCode: 'workflow_action_uncertain',
      error: 'action left dangling',
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
      resumable: false,
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
      resumable: true,
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
    const batchBtn = host.querySelector('button[aria-label="Resume failed (2)"]') as HTMLButtonElement | null
    assert.ok(batchBtn !== null, '工作台顶栏应仅计入当前会话可恢复的 2 条失败任务')
    assert.equal(batchBtn.textContent, 'Resume failed (2)')

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
    assert.match(spy.notifications[0]!.message, /skipped 1/)

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
      ![...host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Resume failed')),
      '无可恢复失败任务时顶栏恢复失败按钮应隐藏',
    )

    // 恢复单条可恢复记录并验证非法响应形状显式报错。
    setWorkflowClientStub({
      docValue: { runs: [runs[0]!] },
      conversations: [],
      conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
    })
    await rerender(e(Panel, { conversation: summary(1, 'idle') }))
    const oneBtn = host.querySelector('button[aria-label="Resume failed (1)"]') as HTMLButtonElement | null
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

test('WorkflowActiveTray：展开行主显可读任务名并次显 #id，回退标题不重复 #id', { timeout: 60_000 }, async () => {
  const namedChild = { ...summary(11, 'working'), parentConversationId: 1, title: '排查构建失败', doing: 'bash: pnpm test', updatedAt: 100 }
  const plainChild = { ...summary(12, 'working'), parentConversationId: 1, title: 'subagent 12', updatedAt: 50 }
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_tray_11',
          kind: 'subagent',
          name: '排查构建失败',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
        },
        {
          id: 'wf_tray_12',
          kind: 'subagent',
          name: 'subagent',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 50,
          nodes: [{ id: 'a12', kind: 'agent', status: 'running', conversationId: 12 }],
        },
      ],
    },
    conversations: [namedChild, plainChild],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Tray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Tray, { conversation: summary(1, 'working') }))
  try {
    const toggle = host.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement | null
    assert.ok(toggle !== null)
    assert.equal(toggle.tagName, 'BUTTON', '横栏主体是真实 button（无嵌套交互）')
    await act(async () => { toggle.click() })
    const rows = [...host.querySelectorAll('.workflow-active-tray-row')]
    assert.equal(rows.length, 2)
    const namedRow = rows.find((r) => r.textContent?.includes('排查构建失败'))
    assert.ok(namedRow !== undefined, '具名任务应主显任务名称')
    assert.equal(namedRow.querySelector('.workflow-active-tray-row-id')?.textContent, '#11', '具名任务行次显 #11')
    const plainRow = rows.find((r) => r.textContent?.includes('Subagent #12'))
    assert.ok(plainRow !== undefined, '无名任务回退 Subagent #12')
    assert.ok(plainRow.querySelector('.workflow-active-tray-row-id') === null, '回退已含 #12 时不得重复渲染 .workflow-active-tray-row-id')
  } finally {
    unmount()
  }
})

test('SubagentToolView：.trace-tool-name 主显任务名、次显 #id 与 @profile，.trace-tool-summary 不重复标题', { timeout: 60_000 }, async () => {
  const child11 = { ...summary(11, 'done'), parentConversationId: 1, parentToolCallId: 'call-named', title: '修复测试超时' }
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, parentToolCallId: 'call-fallback', title: 'subagent 12' }
  const bgRun = {
    id: 'wf_node_ctx',
    name: '修复测试超时',
    conversationId: 1,
    kind: 'subagent',
    status: 'completed',
    parentToolCallId: 'call-named',
    createdAt: 1,
    updatedAt: 2,
    nodes: [{ id: 'a1', kind: 'agent', status: 'done', conversationId: 11, nodeId: 'remote-node' }],
  }
  setWorkflowClientStub({
    docValue: { runs: [bgRun] },
    conversations: [child11, child12],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const SubagentToolView = mod['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(
    spy,
    e(SubagentToolView, {
      callId: 'call-named',
      toolName: 'subagent',
      input: { prompt: '修复测试超时' },
      status: 'done',
      result: JSON.stringify({ ok: true, execution: { conversationId: 11, nodeId: 'remote-node' } }),
      conversationId: 1,
      siblingCalls: [],
    }),
  )
  try {
    assert.equal(host.querySelector('.trace-tool-name')?.textContent, '修复测试超时', '.trace-tool-name 应主显任务名称')
    assert.equal(host.querySelector('.workflow-trace-id')?.textContent, '#11', '次级标签展示 #11')
    assert.ok(host.textContent?.includes('@coder'), '保留 @profileId 徽章')
    assert.equal(host.querySelector('.trace-tool-summary')?.textContent, 'remote-node', 'summary 只保留 nodeId 附加上下文，不得重复标题')

    await rerender(
      e(SubagentToolView, {
        callId: 'call-fallback',
        toolName: 'subagent',
        input: {},
        status: 'done',
        result: JSON.stringify({ ok: true, execution: { conversationId: 12 } }),
        conversationId: 1,
        siblingCalls: [],
      }),
    )
    assert.equal(host.querySelector('.trace-tool-name')?.textContent, 'Subagent #12', '无任何名称来源时回退 Subagent #12')
    assert.ok(host.querySelector('.workflow-trace-id') === null, '回退已含 #12 时不得重复渲染 #12')
    assert.ok(host.querySelector('.trace-tool-summary') === null, '无附加上下文时不渲染空 summary')
  } finally {
    unmount()
  }
})

test('WorkflowActiveTray 清亮化：横栏主体真实按钮切换、Workbench 为同级 sibling，主状态纯灯无可见状态文字', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_tray_bar',
          kind: 'subagent',
          name: '清理依赖',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
        },
      ],
    },
    conversations: [{ ...summary(11, 'working'), parentConversationId: 1, title: '清理依赖', updatedAt: 100 }],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Tray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Tray, { conversation: summary(1, 'working') }))
  try {
    const bar = host.querySelector('.workflow-active-tray-bar') as HTMLElement | null
    const toggle = host.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement | null
    assert.ok(bar !== null && toggle !== null)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    // 合法结构：横栏容器不是交互元素；Workbench 是同级 sibling button，不嵌套在开关内。
    assert.equal(bar.querySelectorAll('.workflow-active-tray-bar-toggle > button').length, 0, '开关按钮内无嵌套 button')
    const wbBtn = [...bar.querySelectorAll(':scope > button')].find((b) => (b.textContent ?? '').includes('Workbench')) as HTMLButtonElement | undefined
    assert.ok(wbBtn !== undefined, 'Workbench 为横栏同级 sibling button')
    // 主状态纯灯：无 spinner、无可見状态文字（计数只作为可访问名称）。
    assert.ok(toggle.querySelector('.helmx-status-light .status-dot-working') !== null, '主状态为统一状态灯')
    assert.equal(toggle.querySelectorAll('.helmx-status-light').length, 1, '主状态只渲染一盏灯')
    assert.equal(toggle.querySelector('.spin-slow') === null, true, '主状态不再用 spinner')
    assert.equal((toggle.querySelector('.helmx-status-light')?.getAttribute('aria-label') ?? '').includes('running'), true, '状态词转为可访问名称')
    assert.ok(toggle.querySelector('.helmx-status-light > .helmx-sr-only') !== null, '可访问名称经屏幕阅读器专用文本承载（无可見 label）')
    // 主体按钮点击展开；再点击收起；键盘 Enter 同样切换。
    await act(async () => { toggle.click() })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.ok(host.querySelector('.workflow-active-tray-list') !== null)
    await act(async () => { toggle.click() })
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    toggle.focus()
    assert.ok(host.ownerDocument.activeElement === toggle, '开关为可聚焦真实 button（Enter/Space 由 UA 原生激活）')
    await act(async () => { toggle.click() })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    // 点击同级 Workbench 不影响展开态。
    await act(async () => { wbBtn.click() })
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', '点击 Workbench 不触发横栏展开切换')
    assert.equal(spy.workbenchCalls.length, 1, 'Workbench 打开调用一次')
  } finally {
    unmount()
  }
})

test('WorkflowActiveTray 清亮化：展开行主体真实按钮进抽屉/工作台，无查看按钮，中止为同级 sibling', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_tray_conv',
          kind: 'subagent',
          name: '子代理任务',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
        },
        {
          id: 'wf_tray_ext',
          kind: 'external',
          name: '外部执行',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a12', kind: 'action', status: 'running', nodeId: 'remote-node' }],
        },
      ],
    },
    conversations: [{ ...summary(11, 'working'), parentConversationId: 1, title: '子代理任务', updatedAt: 100 }],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Tray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Tray, { conversation: summary(1, 'working') }))
  try {
    const bar = host.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement
    await act(async () => { bar.click() })
    const rows = [...host.querySelectorAll('.workflow-active-tray-row')] as HTMLElement[]
    assert.equal(rows.length, 2)
    // 不再有单独的「查看/Details」文字按钮。
    for (const row of rows) {
      for (const btn of [...row.querySelectorAll('button')]) {
        const text = btn.textContent ?? ''
        assert.equal(/^(View|Details|查看|详情)$/.test(text.trim()), false, `行内不得保留独立详情按钮：${text}`)
      }
    }
    // 有 conversationId 的行：行主体真实按钮点击打开抽屉。
    const convRow = rows.find((r) => r.textContent?.includes('子代理任务'))
    assert.ok(convRow !== undefined)
    const convMain = convRow.querySelector('button.workflow-active-tray-row-main') as HTMLButtonElement | null
    assert.ok(convMain !== null, '行主体是真实 button')
    await act(async () => { convMain.click() })
    assert.deepEqual(spy.drawerCalls, [11], '整行点击进 ConversationDrawer')
    // 无 conversationId 的外部行：行主体点击定位工作台 run；中止为同级 sibling button。
    const extRow = rows.find((r) => r.textContent?.includes('外部执行'))
    assert.ok(extRow !== undefined)
    const extMain = extRow.querySelector('button.workflow-active-tray-row-main') as HTMLButtonElement
    assert.equal(extMain.querySelectorAll('button').length, 0, '行主体按钮内无嵌套交互')
    spy.workbenchCalls.length = 0
    await act(async () => { extMain.click() })
    assert.equal(spy.workbenchCalls.length, 1, '整行点击打开工作台')
    // 行主体为可聚焦真实 button（Enter/Space 由 UA 原生激活）。
    extMain.focus()
    assert.ok(host.ownerDocument.activeElement === extMain, '行主体按钮可聚焦')
    // 中止为同级 sibling 真实按钮：点击不触发整行导航。
    spy.workbenchCalls.length = 0
    const abortBtn = extRow.querySelector('.workflow-active-tray-row-actions button.btn-danger') as HTMLButtonElement | null
    assert.ok(abortBtn !== null, '外部 run 行保留中止按钮（同级 sibling）')
    await act(async () => { abortBtn!.click() })
    assert.equal(spy.actionCalls.filter((c) => c.actionId === 'abort').length, 1, '中止动作派发一次')
    assert.equal(spy.workbenchCalls.length, 0, '点中止不触发整行工作台导航')
    assert.equal(spy.drawerCalls.length, 1, '点中止不触发抽屉')
  } finally {
    unmount()
  }
})

test('WorkflowActiveTray 展开行两层布局：标题/编号主行、实际执行内容独立第二行不重复，live 工具语义/思考/审批优先且 includeDetail:false', { timeout: 60_000 }, async () => {
  const hookCalls: Array<{ id: number | undefined; options?: { includeDetail?: boolean } }> = []
  let view: Record<string, unknown> = {
    summary: undefined,
    detail: undefined,
    live: undefined,
    pendingAsks: [],
    loadError: undefined,
    reload: () => {},
  }
  const child = { ...summary(11, 'working'), parentConversationId: 1, title: '重构活动托盘', doing: '旧摘要收尾' }
  const trayRuns = [
    {
      id: 'wf_tray_live',
      kind: 'subagent',
      name: '重构活动托盘',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 100,
      nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
    },
  ]
  setWorkflowClientStub({
    docValue: { runs: trayRuns },
    conversations: [child],
    conversation: (id, options) => {
      hookCalls.push({ id, options })
      return view
    },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Tray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
  const { host, rerender, unmount } = await mountClient(spy, e(Tray, { conversation: summary(1, 'working') }))
  try {
    const toggle = host.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement
    await act(async () => { toggle.click() })
    const row = host.querySelector('.workflow-active-tray-row') as HTMLElement
    const main = row.querySelector('button.workflow-active-tray-row-main') as HTMLButtonElement | null
    assert.ok(main !== null, '行主体是真实 button')
    assert.equal(main.querySelectorAll('button').length, 0, '行主体按钮内无嵌套交互')
    // 两层 DOM：主行承载标题/#id，实际执行内容独立第二行。
    const head = main.querySelector('.workflow-active-tray-row-head') as HTMLElement | null
    assert.ok(head !== null, '主行独立渲染')
    assert.equal(head.querySelector('.workflow-active-tray-row-title')?.textContent, '重构活动托盘')
    assert.equal(head.querySelector('.workflow-active-tray-row-id')?.textContent, '#11')
    const liveOf = (): HTMLElement | null => row.querySelector('.workflow-active-tray-row-live') as HTMLElement | null

    // live 运行中 bash 工具 → 语义命令进第二行，不再把任务名/编号拼进活动文案。
    view = {
      ...view,
      live: {
        conversationId: 11,
        text: '',
        tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm -r test' }, status: 'running' }],
        updatedAt: 5,
      },
    }
    await rerender(e(Tray, { conversation: summary(1, 'working') }))
    const live = liveOf()
    assert.ok(live !== null && live.textContent?.includes('pnpm -r test'), '实际 bash 命令优先展示在第二行')
    assert.equal((live?.textContent?.match(/重构活动托盘/g) ?? []).length, 0, '活动行不得再次嵌入任务名')
    assert.equal((row.textContent?.match(/重构活动托盘/g) ?? []).length, 1, '整行任务名只出现一次')

    // 思考流：无运行工具时显示 thinking 末行。
    view = {
      ...view,
      live: { conversationId: 11, text: '', thinking: '先核对测试基线再动手', tools: [], updatedAt: 6 },
    }
    await rerender(e(Tray, { conversation: summary(1, 'working') }))
    assert.ok(liveOf()?.textContent?.includes('先核对测试基线再动手'), '实时思考内容进入第二行')

    // 缺 live：降级 summary.doing 原文（不嵌名）。
    view = { ...view, live: undefined, summary: child }
    await rerender(e(Tray, { conversation: summary(1, 'working') }))
    assert.ok(liveOf()?.textContent?.includes('旧摘要收尾'), '缺 live 时降级 summary.doing')
    assert.equal((liveOf()?.textContent?.match(/子会话 11|#11/g) ?? []).length, 0, '降级文案不得拼入会话名/编号')

    // blocked + pendingAsk → 审批标题进第二行。
    setWorkflowClientStub({
      docValue: { runs: trayRuns },
      conversations: [{ ...child, status: 'blocked', pendingAskCount: 1 }],
      conversation: (id, options) => {
        hookCalls.push({ id, options })
        return view
      },
    })
    view = {
      ...view,
      pendingAsks: [{ id: 'ask1', conversationId: 11, title: '确认删除旧构建产物', fields: [], status: 'pending', createdAt: 1 }],
    }
    await rerender(e(Tray, { conversation: summary(1, 'working') }))
    assert.ok(liveOf()?.textContent?.includes('确认删除旧构建产物'), '审批标题进入第二行')

    // 所有 useConversation 调用都显式 includeDetail:false（不主动拉取会话详情）。
    assert.ok(hookCalls.length > 0, '托盘 live 行确实订阅了会话实时事实')
    for (const call of hookCalls) {
      assert.equal(call.options?.includeDetail, false, 'useConversation 必须以 includeDetail:false 订阅')
    }
  } finally {
    unmount()
  }
})

test('WorkflowActiveTray 顶栏：收起优先审批与可见任务数，展开仅留任务数不复制任务名', { timeout: 60_000 }, async () => {
  const working = { ...summary(11, 'working'), parentConversationId: 1, title: '跑测试任务', doing: 'pnpm test 执行中' }
  const blocked = { ...summary(12, 'blocked'), parentConversationId: 1, title: '等待合并确认', pendingAskCount: 1 }
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_tray_p11',
          kind: 'subagent',
          name: '跑测试任务',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
        },
        {
          id: 'wf_tray_p12',
          kind: 'subagent',
          name: '等待合并确认',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 90,
          nodes: [{ id: 'a12', kind: 'agent', status: 'running', conversationId: 12 }],
        },
      ],
    },
    conversations: [working, blocked],
    conversation: (id) =>
      id === 11
        ? {
            summary: undefined,
            detail: undefined,
            live: {
              conversationId: 11,
              text: '',
              tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm test' }, status: 'running' }],
              updatedAt: 5,
            },
            pendingAsks: [],
            loadError: undefined,
            reload: () => {},
          }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Tray = mod['WorkflowActiveTray'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Tray, { conversation: summary(1, 'working') }))
  try {
    const bar = host.querySelector('.workflow-active-tray-bar') as HTMLElement
    // 收起：审批优先于第一个 working 任务的实时内容，且多任务时任务数可见。
    assert.ok(bar.textContent?.includes('等待合并确认'), '存在阻塞时顶栏优先展示审批')
    assert.ok(bar.textContent?.includes('1 awaiting approval · 2 running'), '多任务时顶栏可见任务数（blocked 行的 run 未结算仍计运行）')
    assert.equal(bar.textContent?.includes('pnpm test'), false, '审批在场时 working 任务内容不得抢占顶栏')

    const toggle = host.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement
    await act(async () => { toggle.click() })
    // 展开：顶栏简洁显示任务数，不再复制任务名/活动文案。
    assert.ok(bar.textContent?.includes('1 awaiting approval · 2 running'), '展开后顶栏保留任务数')
    assert.equal(bar.textContent?.includes('等待合并确认'), false, '展开后顶栏不得复制任务名')
    assert.equal(bar.textContent?.includes('跑测试任务'), false, '展开后顶栏不得复制另一任务名')
    // 展开清单中两行各自完整承载标题与活动内容。
    const rows = [...host.querySelectorAll('.workflow-active-tray-row')] as HTMLElement[]
    assert.equal(rows.length, 2)
    assert.ok(rows.some((r) => r.textContent?.includes('跑测试任务') && r.textContent?.includes('pnpm test')))
    assert.ok(rows.some((r) => r.textContent?.includes('等待合并确认')))
  } finally {
    unmount()
  }
})

test('WorkflowRunCardBody 头部整块可点展开：主体真实按钮切换，动作按钮为同级 sibling 不触发切换', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_hdr_toggle',
          kind: 'workflow',
          name: '头部展开工作流',
          conversationId: 1,
          status: 'completed',
          createdAt: 1_000,
          updatedAt: 2_000,
          nodes: [{ id: 'a', kind: 'action', status: 'done', label: '落盘动作' }],
        },
      ],
    },
    conversations: [],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'idle') }))
  try {
    const main = host.querySelector('button.workflow-run-header-main') as HTMLButtonElement | null
    assert.ok(main !== null, '头部主体为真实展开开关按钮')
    assert.equal(main.querySelectorAll('button').length, 0, '开关内无嵌套交互')
    // 非首个/非运行中的 run 默认收起。
    assert.equal(main.getAttribute('aria-expanded'), 'false', '默认收起')
    const body = host.querySelector('.workflow-run-card [id][hidden]') as HTMLElement | null
    assert.ok(body !== null, '卡体区域存在且默认隐藏')
    await act(async () => { main.click() })
    assert.equal(main.getAttribute('aria-expanded'), 'true', '点击头部主体整块展开')
    assert.equal(body!.hidden, false, '展开后卡体可见')
    // 已结算 run 无中止按钮；「更多」弹层按钮为同级 sibling，点击不切换展开态。
    const siblingBtns = [...host.querySelectorAll('.workflow-run-header > button')] as HTMLButtonElement[]
    const nonMain = siblingBtns.find((b) => !b.classList.contains('workflow-run-header-main'))
    if (nonMain !== undefined) {
      await act(async () => { nonMain.click() })
      assert.equal(main.getAttribute('aria-expanded'), 'true', '点击动作按钮不触发头部展开切换')
    }
    // 键盘可达：主体按钮可聚焦（Enter/Space 由 UA 原生激活）。
    main.focus()
    assert.ok(host.ownerDocument.activeElement === main, '头部主体按钮可聚焦')
  } finally {
    unmount()
  }
})

test('执行卡结构：动作区位于导航按钮之外，点击主体打开详情', { timeout: 60_000 }, async () => {
  const child11 = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'call-nested' }
  setWorkflowClientStub({
    docValue: {
      runs: [
        {
          id: 'wf_nested',
          kind: 'subagent',
          name: '嵌套结构检查',
          conversationId: 1,
          status: 'running',
          createdAt: 1,
          updatedAt: 100,
          nodes: [{ id: 'a11', kind: 'agent', status: 'running', conversationId: 11 }],
        },
      ],
    },
    conversations: [child11],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    const navBtn = host.querySelector('button.subagent-card-clickable') as HTMLButtonElement | null
    assert.ok(navBtn !== null, '导航主体为真实按钮')
    const abortBtn = host.querySelector('.subagent-live-actions button.btn-danger') as HTMLButtonElement | null
    if (abortBtn !== null) {
      assert.ok(!navBtn!.contains(abortBtn), '动作按钮不在导航按钮内部（同级结构）')
    }
    await act(async () => { navBtn!.click() })
    assert.deepEqual(spy.drawerCalls, [11], '点击导航主体仍打开子会话抽屉')
  } finally {
    unmount()
  }
})
