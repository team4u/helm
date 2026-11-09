/**
 * SubagentLiveCard / ConversationPane 分屏早退分支行为测试：
 * - 纯逻辑（subagent-live-model）：状态优先真实 summary.status、
 *   父工具 toolStatus 仅作无 summary 兜底；resultPreview 截断标识、贴底判定；
 * - SSR 实际渲染（react-dom/server + HelmStoreContext 注入）：
 *   详情加载失败显式报错 + 重试按钮（不再永远“加载中”）；
 *   失败/加载中状态下“关闭分屏/进入会话”入口不消失；
 *   工具行渲染 resultPreview 且长输出带“已截断”预览标识（不伪装全文）；
 *   thinking/text 行不套两行 clamp 类（完整换行由外层限高滚动保证）。
 *
 * 约定与 profile-herdr-visibility.test.ts 相同：.test.ts + React.createElement，
 * 动态导入 .tsx 前把 React 挂全局以匹配 classic JSX 转换。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary, WorkflowRunSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { buildSubagentStreamLines } from '../src/conversation/subagent-model.js'
import {
  subagentBadge,
  toolResultPreviewTruncated,
  isScrolledToBottom,
  resolveSubagentTaskTitle,
  resolveSubagentHeaderSnippet,
  buildSubagentStatSegments,
  extractSubagentResultPreview,
  formatShortModelName,
  formatSemanticToolAction,
  type SubagentParentToolSummary,
} from '../src/conversation/subagent-live-model.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { SubagentLiveCard } = await import('../src/conversation/SubagentLiveCard.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { WorkbenchDrawer } = await import('../src/conversation/WorkbenchDrawer.js')

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

function entriesWithToolResult(resultText: string): ConversationEntry[] {
  return [
    { id: '1', kind: 'helm.input', data: { text: '跑构建', origin: 'agent' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pnpm test' } }] }],
    },
    {
      id: '3',
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: resultText }],
          durationMs: 800,
        },
      ],
    },
  ]
}

interface StoreOverrides extends Partial<HelmStoreValue> {
  conversations?: ConversationSummary[]
  conversationDetails?: HelmStoreValue['conversationDetails']
  loadErrors?: Record<string, string>
}

function makeStore(overrides: StoreOverrides = {}): HelmStoreValue {
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
    groupedUi: {
      sidebarItems: [],
      sidebarSections: [],
      screens: [],
      timelineRenderers: [],
      toolViews: [],
      composerPills: [],
      composerWidgets: [],
      workbenchPanels: [],
      commands: [],
      settingsPanels: [],
    },
    pluginDocs: {},
    workflowRuns: [],
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
    workbenchTab: 'tasks',
    activeModal: null,
    highlightedEntry: null,
    notices: [],
    setTheme: () => {},
    setThemePreference: () => {},
    toggleTheme: () => {},
    checkAuth: async () => {},
    onAuthenticated: async () => {},
    logout: () => {},
    refreshAssets: async () => {},
    refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined,
    loadEarlierEntries: async () => {},
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: async () => undefined,
    openTarget: () => {},
    closeSplit: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    setActiveModal: () => {},
    dismissNotice: () => {},
    pushNotice: () => {},
    invokePluginAction: async () => undefined,
    ...overrides,
  }
}

function renderCard(
  store: HelmStoreValue,
  toolStatus: 'running' | 'done' | 'error' = 'done',
  extra: {
    backgroundRun?: WorkflowRunSummary
    worktree?: { path: string; branch: string }
    defaultExpanded?: boolean
    toolSummary?: SubagentParentToolSummary
  } = {},
): string {
  // 存量流式行 / 截断 / 报错测试均针对展开态流内容：默认展开保持覆盖语义，extra 可覆盖。
  const { defaultExpanded = true, ...rest } = extra
  return renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(SubagentLiveCard, { childConversationId: 11, toolStatus, defaultExpanded, ...rest })),
  )
}

function bgRun(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_bg1',
    name: 'subagent 后台',
    conversationId: 1,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑：状态徽章优先真实 summary.status
// ---------------------------------------------------------------------------

test('subagentBadge：summary working/blocked/error 优先于父工具 toolStatus', { timeout: 60_000 }, () => {
  // 父工具已 done，但子会话随后被继续提问重新 working：必须显示执行中
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'unknown'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'done'), { status: 'blocked', label: '等待审批', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('error', 'done'), { status: 'error', label: '异常', badge: 'badge-err' })
  // running 的父工具下子会话已真实 error：如实显示异常
  assert.deepEqual(subagentBadge('error', 'running'), { status: 'error', label: '异常', badge: 'badge-err' })
})

test('subagentBadge：无 summary 时退回父工具 toolStatus', { timeout: 60_000 }, () => {
  assert.equal(subagentBadge(undefined, 'running').status, 'working')
  assert.equal(subagentBadge(undefined, 'error').status, 'error')
  assert.equal(subagentBadge(undefined, 'done').status, 'done')
  assert.equal(subagentBadge(undefined, 'unknown').status, 'pending')
})

test('subagentBadge：summary done/idle 且父工具 error 仍如实标异常；父工具 running（前台 gate 期）不假完成', { timeout: 60_000 }, () => {
  assert.equal(subagentBadge('done', 'error').status, 'error')
  assert.equal(subagentBadge('idle', 'error').status, 'error')
  // 前台同源边界：子会话 idle/done 但父工具行仍 running（gate 验收 /
  // 结构化输出修复期）不能假完成，与后台 gate 状态同一契约。
  assert.deepEqual(subagentBadge('done', 'running'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'running'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  // 仅父工具自身终态且子会话 idle 才显示完成
  assert.deepEqual(subagentBadge('done', 'done'), { status: 'done', label: '已完成', badge: 'badge-ok' })
  assert.deepEqual(subagentBadge('idle', 'done'), { status: 'done', label: '已完成', badge: 'badge-ok' })
  // unknown 视同未定（不假完成也不误报错）：pending 由后续状态落定
  assert.equal(subagentBadge('idle', 'unknown').status, 'done')
})

// ---------------------------------------------------------------------------
// 纯逻辑：background: true 后台 run 状态参与判定（绝不假完成）
// ---------------------------------------------------------------------------

test('subagentBadge：后台 run running 且子会话 idle/done/无 summary 时保持后台运行中，不假完成', { timeout: 60_000 }, () => {
  // 典型场景：background: true 工具行已返回句柄（done），模型输出完毕（子会话 idle），
  // 后台仍在跑 gate 验收命令——绝不能提前显示“已完成”
  assert.deepEqual(subagentBadge('idle', 'done', 'running'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done', 'running'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'done', 'running'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
  // 后台子会话刚启动（父工具行尚 running）
  assert.deepEqual(subagentBadge(undefined, 'running', 'running'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
})

test('subagentBadge：后台 run 终态如实呈现，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('idle', 'done', 'failed'), { status: 'error', label: '异常', badge: 'badge-err' })
  assert.deepEqual(subagentBadge('idle', 'done', 'aborted'), { status: 'error', label: '已中止', badge: 'badge-warn' })
  // run completed：不再干预，回到 summary/toolStatus 原判定（idle+done = 已完成）
  assert.deepEqual(subagentBadge('idle', 'done', 'completed'), { status: 'done', label: '已完成', badge: 'badge-ok' })
})

test('subagentBadge：子会话 working 时带后台 run 标注为后台执行中；blocked 审批优先', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('working', 'done', 'running'), { status: 'working', label: '后台执行中', badge: 'badge-accent' })
  // 无后台 run 关联：保持原有“执行中”
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  // blocked 按真实审批优先，不被后台 run 状态覆盖
  assert.deepEqual(subagentBadge('blocked', 'running', 'running'), { status: 'blocked', label: '等待审批', badge: 'badge-warn' })
})

// ---------------------------------------------------------------------------
// 纯逻辑：resultPreview 截断标识与贴底判定
// ---------------------------------------------------------------------------

test('toolResultPreviewTruncated：带省略号即截断标识，不伪装全文', { timeout: 60_000 }, () => {
  assert.equal(toolResultPreviewTruncated('exit 0'), false)
  assert.equal(toolResultPreviewTruncated('.'.repeat(101)), false) // 101 个英文句点不触发中文省略号
  assert.equal(toolResultPreviewTruncated('abc…'), true)
  assert.equal(toolResultPreviewTruncated('第一行内容' + 'x'.repeat(96) + '…'), true)
})

test('isScrolledToBottom：距底部 36px 内视为贴底，上滑更远则脱离跟随', { timeout: 60_000 }, () => {
  // scrollHeight 1200 / clientHeight 36：最底 scrollTop=1164，容差内最远 1128
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1128, clientHeight: 36 }), true)
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1127, clientHeight: 36 }), false)
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1100, clientHeight: 36 }), false)
  assert.equal(isScrolledToBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 }), true)
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：加载失败显式报错 + 重试，入口不消失
// ---------------------------------------------------------------------------

test('详情加载失败：显式错误提示与重试按钮，不再永远加载中', { timeout: 60_000 }, () => {
  const loadCalls: Array<[number, boolean | undefined]> = []
  const store = makeStore({
    conversations: [summary(11, 'done')],
    loadErrors: { 'conversation:11': '网络中断' },
    loadConversationDetail: async (id, force) => {
      loadCalls.push([id, force])
      return undefined
    },
  })
  const html = renderCard(store)
  assert.ok(html.includes('加载失败'), '应显示加载失败文案')
  assert.ok(html.includes('网络中断'), '应包含具体错误信息')
  assert.ok(html.includes('重试'), '应提供重试按钮')
  assert.ok(!html.includes('正在加载子会话'), '失败态不得显示加载中')
})

test('长工具输出：buildSubagentStreamLines 仅预览并标识已截断，不伪装全文', { timeout: 60_000 }, () => {
  const longFirstLine = 'a'.repeat(120)
  const entries = entriesWithToolResult(`${longFirstLine}\nsecond line`)
  const lines = buildSubagentStreamLines(entries)
  const toolLine = lines.find((l) => l.kind === 'tool')
  assert.ok(toolLine && toolLine.kind === 'tool')
  assert.equal(toolLine.resultPreview, `${'a'.repeat(100)}…`)
  assert.ok(toolResultPreviewTruncated(toolLine.resultPreview))
})

test('短工具输出：buildSubagentStreamLines 完整首行预览且无截断标识', { timeout: 60_000 }, () => {
  const entries = entriesWithToolResult('exit 0')
  const lines = buildSubagentStreamLines(entries)
  const toolLine = lines.find((l) => l.kind === 'tool')
  assert.ok(toolLine && toolLine.kind === 'tool')
  assert.equal(toolLine.resultPreview, 'exit 0')
  assert.equal(toolResultPreviewTruncated(toolLine.resultPreview), false)
})

test('thinking/text 行：buildSubagentStreamLines 正确解析思考与正文', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '继续任务', origin: 'agent' } },
    {
      id: '2',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '思考内容' }] }],
    },
  ]
  const live = { conversationId: 11, text: '流式回复正文', thinking: undefined, tools: [], updatedAt: 1 }
  const lines = buildSubagentStreamLines(entries, live, true)
  const kinds = lines.map((l) => l.kind)
  assert.ok(kinds.includes('prompt'))
  assert.ok(kinds.includes('thinking'))
  assert.ok(kinds.includes('text'))
})

// ---------------------------------------------------------------------------
// ConversationPane 早退分支的分屏关闭入口（手机不被困住）
// ---------------------------------------------------------------------------

test('ConversationPane 加载失败分屏分支：错误 + 重试 + 关闭分屏入口共存', { timeout: 60_000 }, () => {
  const store = makeStore({
    loadErrors: { 'conversation:42': '500 内部错误' },
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('加载失败'), '分屏加载失败应显示错误')
  assert.ok(html.includes('500 内部错误'))
  assert.ok(html.includes('重试'))
  assert.ok(html.includes('split-close-btn'), '加载失败分屏分支必须有显式关闭入口')
  assert.ok(html.includes('关闭分屏'))
})

test('ConversationPane 加载中分屏分支：仍有显式关闭分屏入口', { timeout: 60_000 }, () => {
  const store = makeStore({})
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('正在加载会话'), '应显示加载中态')
  assert.ok(html.includes('split-close-btn'), '加载中分屏分支必须有显式关闭入口')
})

test('ConversationPane 非分屏分支：早退不渲染分屏关闭按钮', { timeout: 60_000 }, () => {
  const store = makeStore({})
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(ConversationPane, { conversationId: 42 })),
  )
  assert.ok(!html.includes('split-close-btn'))
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：worktree 分支徽章与后台 run 状态
// ---------------------------------------------------------------------------

test('worktree 存在：头部渲染分支徽章（git-branch 图标 + 分支名，无 Emoji）', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
  })
  const html = renderCard(store, 'done', { worktree: { path: '/root/code/helm/.worktrees/wt-668', branch: 'helm/spawn-123' } })
  assert.ok(html.includes('subagent-worktree-badge'), '应渲染 worktree 徽章类')
  assert.ok(html.includes('helm/spawn-123'), '应显示分支名')
  assert.ok(html.includes('隔离工作树：/root/code/helm/.worktrees/wt-668'), 'title 提示完整工作树路径')
})

test('backgroundRun 节点携带 worktree：无显式入参时回退展示 run 节点徽章', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
  })
  const run = bgRun({
    status: 'running',
    nodes: [{ id: 'a1', kind: 'agent', status: 'running', worktree: { path: '/wt/abc', branch: 'helm/bg-9' } }],
  })
  const html = renderCard(store, 'done', { backgroundRun: run })
  assert.ok(html.includes('subagent-worktree-badge'), '应从 run 节点回退渲染徽章')
  assert.ok(html.includes('helm/bg-9'))
  // 工具行已 done、子会话 idle，但后台 run running：徽章必须显示后台运行中
  assert.ok(html.includes('后台运行中'), '后台 run running 时不得假完成')
  assert.ok(!html.includes('已完成'), '不得出现已完成徽章')
})

test('backgroundRun failed：副栏渲染错误提示，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
  })
  const run = bgRun({ status: 'failed', error: 'gate 验收失败：pnpm test 退出码 1' })
  const html = renderCard(store, 'done', { backgroundRun: run })
  assert.ok(html.includes('gate 验收失败'), '应包含具体错误信息')
  assert.ok(html.includes('subagent-live-subline-error'), '副栏应使用 error 变体样式类')
  assert.ok(html.includes('异常'), '徽章应显示异常态')
})

test('无 worktree 且无后台 run：不渲染空徽章与错误行', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: [] } },
  })
  const html = renderCard(store, 'done')
  assert.ok(!html.includes('subagent-worktree-badge'))
  assert.ok(!html.includes('subagent-bg-error'))
  assert.ok(!html.includes('后台执行失败'))
})

test('同步外部子代理无原生子会话：完成后卡片停止显示执行中', { timeout: 60_000 }, () => {
  const conversation = summary(1, 'idle')
  const result = JSON.stringify({ ok: true, result: 'done', execution: {
    nodeId: 'local', executionId: 'pane-9',
    worktree: { path: '/tmp/wt-9', branch: 'helm/wf-9' },
  } })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '执行外部任务', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'ext-1', name: 'subagent', arguments: { prompt: '执行任务', agentType: 'herdr:pi' } }] }] },
    { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'ext-1', toolName: 'subagent', content: [{ type: 'text', text: result }], isError: false }] },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '任务完成' }], stopReason: 'stop' }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [conversation] }) },
    e(ConversationTimeline, { conversation, detailEntries: entries, onRequestEdit: () => {} })))
  assert.ok(html.includes('subagent-external-card'))
  assert.ok(html.includes('外部执行已结束'))
  assert.ok(html.includes('已完成'))
  assert.ok(!html.includes('外部运行时执行中'))
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：defaultExpanded 折叠态与多次 resume 去重
// ---------------------------------------------------------------------------

test('resume 正在运行时：历史失败调用保留失败状态，只有最新调用挂载执行中的实时卡', { timeout: 60_000 }, () => {
  const parent = summary(1, 'working')
  const child = { ...summary(12, 'working'), parentConversationId: 1, parentToolCallId: 'call_new' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_old', name: 'subagent', arguments: { prompt: '首次派生' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_old', toolName: 'subagent', content: [{ type: 'text', text: JSON.stringify({ ok: false, execution: { conversationId: 12 } }) }], isError: true }] },
    { id: '3', kind: 'helm.input', data: { text: '重试', origin: 'human' } },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_new', name: 'subagent', arguments: { prompt: '继续修复', resume: '12' } }] }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [parent, child] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal(html.split('subagent-live-card').length - 1, 1)
  const historicalRow = html.match(/<div class="trace-row trace-row-error"[\s\S]*?<\/div>/)?.[0]
  assert.ok(historicalRow, '历史失败调用的工具行应保留')
  assert.match(historicalRow, /已在下文续接[\s\S]*?trace-row-right">失败<\/span>/)
  assert.equal(historicalRow.includes('spin-slow'), false, '历史失败行不能随后续 resume 转圈')
  assert.match(html, /subagent-live-card[\s\S]*?执行中/)
})

test('defaultExpanded=false：SSR 首帧折叠，不渲染实时流，仅头部与状态徽章', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: entriesWithToolResult('exit 0') } },
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', defaultExpanded: false })),
  )
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('已完成'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '折叠态 SSR 首帧不得渲染实时流容器')
})

test('同一子会话 #12 被首次派生 + resume 续接：时间线仅 1 张实时卡，前序行标注已在下文续接', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, title: '子会话 12' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '开始', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'subagent', arguments: { prompt: '首次派生' } }] }] },
    { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'subagent', content: [{ type: 'text', text: '首轮完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '4', kind: 'helm.input', data: { text: '继续', origin: 'human' } },
    { id: '5', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_2', name: 'subagent', arguments: { prompt: '继续', resume: 12 } }] }] },
    { id: '6', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_2', toolName: 'subagent', content: [{ type: 'text', text: '第二轮完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '7', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '全部完成' }], stopReason: 'stop' }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  const cardCount = html.split('subagent-live-card').length - 1
  assert.equal(cardCount, 1, `同一子会话多次 resume 仅渲染 1 张实时卡，实际 ${cardCount}`)
  // React SSR 在插值两侧插入 <!-- --> 注释节点，用正则匹配「#12 · 已在下文续接」
  assert.match(html, /#<!-- -->12<!-- -->\s*·\s*已在下文续接/, '前序被续接的调用行应显示轻量续接标识')
  assert.match(html, /子会话 #<!-- -->12/, '唯一实时卡应挂在最新调用处并显示子会话编号')
})

test('工作台独立子会话：默认全部折叠零请求，第 2 层副栏渲染，working 排在 idle 前面', { timeout: 60_000 }, () => {
  const child31 = { ...summary(31, 'idle'), parentConversationId: 1, updatedAt: 5 }
  const child32 = { ...summary(32, 'working'), parentConversationId: 1, updatedAt: 9, doing: '正在跑测试' }
  const store = makeStore({
    conversations: [child31, child32],
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(WorkbenchDrawer, { conversationId: 1 })),
  )
  assert.ok(html.includes('子代理会话'), '分组标题应渲染')
  assert.ok(html.includes('子会话 #<!-- -->31') || html.includes('子会话 #31'), '折叠卡片头部应显示 #31')
  assert.ok(html.includes('子会话 #<!-- -->32') || html.includes('子会话 #32'), 'working 卡片头部应显示 #32')
  // 默认全部折叠：零详情请求、零实时流容器
  const streams = html.split('subagent-live-stream').length - 1
  assert.equal(streams, 0, `默认折叠态不得渲染实时流，实际 ${streams}`)
  // 第 2 层动态副栏正常渲染（working 卡显示实时 doing）
  assert.ok(html.includes('subagent-live-subline'), '折叠态应渲染第 2 层动态副栏')
  assert.ok(html.includes('正在跑测试'), 'working 卡副栏应显示实时 doing')
  // Active-First：working #32 排在 idle #31 前面
  const pos31 = html.indexOf('子会话 #<!-- -->31') !== -1 ? html.indexOf('子会话 #<!-- -->31') : html.indexOf('子会话 #31')
  const pos32 = html.indexOf('子会话 #<!-- -->32') !== -1 ? html.indexOf('子会话 #<!-- -->32') : html.indexOf('子会话 #32')
  assert.ok(pos31 !== -1 && pos32 !== -1 && pos32 < pos31, 'working #32 应按 Active-First 排在 idle #31 前面')
  // 彻底移除并排按钮，统一由抽屉模态承载
  assert.ok(!html.includes('subagent-split-btn') && !html.includes('workbench-split-btn'), '不得再渲染并排按钮')
})

// ---------------------------------------------------------------------------
// 纯逻辑：resolveSubagentTaskTitle / formatShortModelName
// ---------------------------------------------------------------------------

test('resolveSubagentTaskTitle：自定义标题 > 父工具 prompt > 后台 run 首节点，均截断 60 字符', { timeout: 60_000 }, () => {
  const child = { ...summary(11, 'done'), title: '修复登录超时' }
  assert.equal(resolveSubagentTaskTitle(child, 11), '修复登录超时')
  // 默认生成的「子会话 N」不算自定义标题
  assert.equal(resolveSubagentTaskTitle(summary(11, 'done'), 11, { prompt: '跑全量测试' }), '跑全量测试')
  // prompt 剥离结构化输出契约样板后取首行，超 60 字符截断
  const longPrompt = `${'修'.repeat(70)}尾`
  assert.equal(resolveSubagentTaskTitle(undefined, 11, { prompt: longPrompt }), `${'修'.repeat(60)}…`)
  const withContract = `安装依赖\n<structured_output_contract>{"type":"object"}</structured_output_contract>`
  assert.equal(resolveSubagentTaskTitle(undefined, 11, { prompt: withContract }), '安装依赖')
  // 后台 run 首节点 label 优先于 prompt 缺省；忽略默认名 subagent
  const run = bgRun({ nodes: [{ id: 'n1', kind: 'agent', status: 'done', label: '调研员' }] })
  assert.equal(resolveSubagentTaskTitle(undefined, 11, undefined, run), '调研员')
  const defaultLabelRun = bgRun({ nodes: [{ id: 'n1', kind: 'agent', status: 'done', label: 'subagent', prompt: '从节点 prompt 提炼' }] })
  assert.equal(resolveSubagentTaskTitle(undefined, 11, undefined, defaultLabelRun), '从节点 prompt 提炼')
  assert.equal(resolveSubagentTaskTitle(undefined, 11), undefined)
})

test('formatShortModelName：剥离 provider 前缀，空串返回 undefined', { timeout: 60_000 }, () => {
  assert.equal(formatShortModelName('openai/glm-5'), 'glm-5')
  assert.equal(formatShortModelName('glm-5'), 'glm-5')
  assert.equal(formatShortModelName(''), undefined)
  assert.equal(formatShortModelName(undefined), undefined)
  assert.equal(formatShortModelName('  '), undefined)
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildSubagentStatSegments
// ---------------------------------------------------------------------------

test('buildSubagentStatSegments：模型 / 思考档位 / 工具步数 / token / 耗时按序收集，无值跳过', { timeout: 60_000 }, () => {
  const child = { ...summary(11, 'done'), model: 'openai/glm-5', thinkingLevel: 'high', createdAt: 1_000, updatedAt: 61_000 }
  const segs = buildSubagentStatSegments({
    summary: child,
    entries: entriesWithToolResult('exit 0'),
    toolSummary: { durationMs: 120_000 },
  })
  assert.deepEqual(segs, ['glm-5', 'high', '已载 1 次工具', '2m0s'])
  // off 思考档位不展示；token 紧凑格式；无 entries 时用 live.tools 计数
  const segs2 = buildSubagentStatSegments({
    summary: { ...summary(11, 'working'), thinkingLevel: 'off' },
    live: { conversationId: 11, text: '', tools: [
      { callId: 'a', toolName: 'bash', status: 'done' },
      { callId: 'b', toolName: 'read', status: 'running' },
    ], updatedAt: 1 },
    backgroundRun: bgRun({ nodes: [{ id: 'n1', kind: 'agent', status: 'running', tokens: 1500 }] }),
    isWorking: true,
  })
  assert.deepEqual(segs2, ['已载 2 次工具', '1.5k'])
  // 小于 1000 的 token 原样展示；无时间差信息的 run 不产生耗时片段
  const segs3 = buildSubagentStatSegments({
    backgroundRun: bgRun({ status: 'completed', createdAt: 1, updatedAt: 1, nodes: [{ id: 'n1', kind: 'agent', status: 'done', tokens: 500 }] }),
  })
  assert.deepEqual(segs3, ['500', '0ms'])
})

test('buildSubagentStatSegments：working 秒表仅客户端时钟有效才显示（SSR 确定性）', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  const child = { ...summary(11, 'working'), createdAt: start, updatedAt: start }
  // nowMs 缺省（SSR 首帧）：不显示秒表
  assert.deepEqual(buildSubagentStatSegments({ summary: child, isWorking: true }), [])
  // nowMs 早于起点（时钟异常）：同样不显示
  assert.deepEqual(buildSubagentStatSegments({ summary: child, nowMs: start - 1, isWorking: true }), [])
  // 会话创建时间不是本轮边界：resume 场景必须省略该伪计时。
  assert.deepEqual(buildSubagentStatSegments({ summary: child, nowMs: start + 5_000, isWorking: true }), [])
  // 仅本次父工具记录起点存在时显示本次调用耗时。
  assert.deepEqual(buildSubagentStatSegments({ summary: child, toolSummary: { startedAt: start }, nowMs: start + 5_000, isWorking: true }), ['5.0s'])
  // 非 working：优先 toolSummary.durationMs，其次 run / summary 的时间差
  assert.deepEqual(
    buildSubagentStatSegments({ summary: { ...summary(11, 'done'), createdAt: 0, updatedAt: 0 }, toolSummary: { durationMs: 800 } }),
    ['800ms'],
  )
  assert.deepEqual(
    buildSubagentStatSegments({ backgroundRun: bgRun({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }) }),
    ['1m0s'],
  )
})

// ---------------------------------------------------------------------------
// 纯逻辑：formatSemanticToolAction / extractSubagentResultPreview
// ---------------------------------------------------------------------------

test('formatSemanticToolAction：常见工具语义化（bash / 读取 / 编辑 / 写入 / 搜索 / 查找 / 兜底）', { timeout: 60_000 }, () => {
  assert.deepEqual(formatSemanticToolAction('bash', { command: 'pnpm test\n&& pnpm build' }), { tag: 'bash', text: 'pnpm test' })
  assert.deepEqual(formatSemanticToolAction('read', { file_path: '/root/code/helm/packages/web/src/App.tsx' }, '/root/code/helm'), { tag: '读取', text: 'packages/web/src/App.tsx' })
  assert.deepEqual(formatSemanticToolAction('edit_file', { file_path: '/tmp/x.ts' }), { tag: '编辑', text: '/tmp/x.ts' })
  assert.deepEqual(formatSemanticToolAction('write', { file_path: '/tmp/out.md' }), { tag: '写入', text: '/tmp/out.md' })
  assert.deepEqual(formatSemanticToolAction('grep', { pattern: 'SubagentLiveCard' }), { tag: '搜索', text: 'SubagentLiveCard' })
  assert.deepEqual(formatSemanticToolAction('find', { pattern: '*.test.ts' }), { tag: '查找', text: '*.test.ts' })
  assert.deepEqual(formatSemanticToolAction('custom_tool', { url: 'https://example.com' }), { tag: 'custom_tool', text: 'https://example.com' })
  assert.deepEqual(formatSemanticToolAction('no_input_tool', undefined), { tag: 'no_input_tool', text: 'no_input_tool' })
})

test('extractSubagentResultPreview：JSON 信封 result/output/summary 字段优先，普通文本剥离尾注', { timeout: 60_000 }, () => {
  assert.equal(extractSubagentResultPreview(undefined), undefined)
  assert.equal(extractSubagentResultPreview('   '), undefined)
  assert.equal(extractSubagentResultPreview(JSON.stringify({ ok: true, result: '任务完成，共修复 3 处' })), '任务完成，共修复 3 处')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ output: '产出首行\n第二行' })), '产出首行')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ summary: '总结' })), '总结')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ other: 1 })), '{"other":1}')
  assert.equal(extractSubagentResultPreview('结论：全部通过\n[subagent conversationId=11]'), '结论：全部通过')
  assert.equal(extractSubagentResultPreview('纯文本结论'), '纯文本结论')
  assert.equal(extractSubagentResultPreview('[subagent conversationId=11]'), undefined)
})

// ---------------------------------------------------------------------------
// 纯逻辑：resolveSubagentHeaderSnippet 全分支
// ---------------------------------------------------------------------------

test('resolveSubagentHeaderSnippet：加载失败优先于一切状态', { timeout: 60_000 }, () => {
  const snip = resolveSubagentHeaderSnippet({ badgeStatus: 'working', detailError: '网络中断\n重试无效' })
  assert.deepEqual(snip, { kind: 'error', tag: '加载失败', text: '网络中断' })
})

test('resolveSubagentHeaderSnippet：blocked 取 pendingAsk 标题，缺省退回 doing 与兜底', { timeout: 60_000 }, () => {
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', pendingAsk: { title: '确认删除文件', description: '详情' } }),
    { kind: 'blocked', tag: '等待审批', text: '确认删除文件' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', pendingAsk: { title: '', description: '描述文案' } }),
    { kind: 'blocked', tag: '等待审批', text: '描述文案' },
  )
  const doing = { ...summary(11, 'blocked'), doing: '等待删除确认' }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', summary: doing }),
    { kind: 'blocked', tag: '等待审批', text: '等待删除确认' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked' }),
    { kind: 'blocked', tag: '等待审批', text: '等待人工确认' },
  )
})

test('resolveSubagentHeaderSnippet：error 优先后台 run 失败，其次父工具错误与子会话最后报错', { timeout: 60_000 }, () => {
  const failedRun = bgRun({ status: 'failed', error: 'gate 验收失败：退出码 1' })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: failedRun }),
    { kind: 'error', tag: '后台执行失败', text: 'gate 验收失败：退出码 1' },
  )
  const abortedRun = bgRun({ status: 'aborted', error: '用户中止' })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: abortedRun }),
    { kind: 'error', tag: '已中止', text: '用户中止' },
  )
  // run 失败但无 error：取首个失败节点 error / gate 输出
  const nodeErrRun = bgRun({ status: 'failed', nodes: [{ id: 'n1', kind: 'agent', status: 'failed', gate: { ok: false, output: '测试失败：期望 3 得到 2' } }] })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: nodeErrRun }),
    { kind: 'error', tag: '后台执行失败', text: '测试失败：期望 3 得到 2' },
  )
  // 父工具 JSON 错误信封
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { resultText: JSON.stringify({ ok: false, error: '执行超时' }) } }),
    { kind: 'error', tag: '失败', text: '执行超时' },
  )
  // 父工具 isError：剥离尾注后取首行
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { isError: true, resultText: '命令失败：退出码 2\n[subagent conversationId=11]' } }),
    { kind: 'error', tag: '失败', text: '命令失败：退出码 2' },
  )
  // 子会话 entries 中最后一条报错工具输出
  const errEntries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c9', name: 'bash', arguments: { command: 'pnpm test' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: '测试失败：期望通过' }], isError: true }] },
  ]
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', entries: errEntries }),
    { kind: 'error', tag: '异常', text: '测试失败：期望通过' },
  )
  // 兜底
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', summary: { ...summary(11, 'error'), doing: '最后动作' } }),
    { kind: 'error', tag: '异常', text: '最后动作' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error' }),
    { kind: 'error', tag: '异常', text: '子代理执行异常' },
  )
})

test('resolveSubagentHeaderSnippet：working 优先活跃工具（单工具语义化 / 多工具聚合）', { timeout: 60_000 }, () => {
  const live = {
    conversationId: 11,
    text: '',
    tools: [{ callId: 't1', toolName: 'bash', input: { command: 'pnpm build' }, status: 'running' as const }],
    updatedAt: 1,
  }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live }),
    { kind: 'tool', tag: 'bash', text: 'pnpm build' },
  )
  const multiLive = {
    conversationId: 11,
    text: '',
    tools: [
      { callId: 't1', toolName: 'bash', input: { command: 'pnpm build' }, status: 'running' as const },
      { callId: 't2', toolName: 'read', input: { file_path: '/root/code/helm/a.ts' }, status: 'running' as const },
      { callId: 't3', toolName: 'grep', input: { pattern: 'xx' }, status: 'running' as const },
    ],
    updatedAt: 1,
  }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: multiLive, summary: { ...summary(11, 'working'), cwd: '/root/code/helm' } }),
    { kind: 'tool', tag: '并行 3 项', text: 'bash pnpm build · 读取 a.ts 等' },
  )
})

test('resolveSubagentHeaderSnippet：working 次优流式思考与正文（取最后非空行去前缀）', { timeout: 60_000 }, () => {
  const thinkingLive = { conversationId: 11, text: '', thinking: '第一行思路\n- 下一步跑测试\n', tools: [], updatedAt: 1 }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: thinkingLive }),
    { kind: 'thinking', tag: '思考', text: '下一步跑测试' },
  )
  const textLive = { conversationId: 11, text: '正文开头\n\n## 小结', tools: [], updatedAt: 1 }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: textLive }),
    { kind: 'text', tag: '输出', text: '小结' },
  )
})

test('resolveSubagentHeaderSnippet：working 后台 Gate 验收期与兜底启动文案', { timeout: 60_000 }, () => {
  const gateRun = bgRun({
    status: 'running',
    createdAt: 1_700_000_000_000,
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', gateCommand: 'pnpm test --filter @helm/web' }],
  })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', summary: summary(11, 'idle'), backgroundRun: gateRun }),
    { kind: 'doing', tag: 'Gate 验收', text: 'pnpm test --filter @helm/web' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', summary: { ...summary(11, 'working'), doing: '正在重构模块' } }),
    { kind: 'doing', text: '正在重构模块' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working' }),
    { kind: 'doing', text: '正在启动子代理…' },
  )
})

test('resolveSubagentHeaderSnippet：done 取 entries 结论 > toolSummary.resultText > 后台 run 产出 > undefined', { timeout: 60_000 }, () => {
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '最终结论：全部通过' }], stopReason: 'stop' }] },
  ]
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'done', entries }),
    { kind: 'done', text: '最终结论：全部通过' },
  )
  // entries 未加载（折叠态零请求）：从 toolSummary.resultText 提取
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'done', toolSummary: { resultText: JSON.stringify({ ok: true, result: '修复完成' }) } }),
    { kind: 'done', text: '修复完成' },
  )
  const doneRun = bgRun({ status: 'completed', nodes: [{ id: 'n1', kind: 'agent', status: 'done', output: '产出结论文本' }] })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'done', backgroundRun: doneRun }),
    { kind: 'done', text: '产出结论文本' },
  )
  assert.equal(resolveSubagentHeaderSnippet({ badgeStatus: 'done' }), undefined)
})

// ---------------------------------------------------------------------------
// SSR：默认折叠 + 第 2 层副栏 + 时间线去冗余
// ---------------------------------------------------------------------------

test('默认折叠 SSR 首帧：未传 defaultExpanded 时只渲染头部', { timeout: 60_000 }, () => {
  const store = makeStore({ conversations: [summary(11, 'done')] })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('已完成'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '默认折叠 SSR 首帧不得渲染实时流容器')
  assert.ok(html.includes('subagent-live-trigger'), '第 1 层触发按钮应渲染')
})

test('折叠态 done 卡无任何结论来源时不渲染第 2 层副栏', { timeout: 60_000 }, () => {
  const store = makeStore({ conversations: [summary(11, 'idle')] })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(!html.includes('subagent-live-subline'), '无有效文本时不得渲染副栏占位')
})

test('toolSummary 注入：折叠态头部显示任务标题、耗时统计与完成结论预览', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, {
        childConversationId: 11,
        toolStatus: 'done',
        toolSummary: {
          prompt: '修复构建失败',
          durationMs: 95_000,
          resultText: JSON.stringify({ ok: true, result: '构建已恢复，测试 42 通过' }),
        },
      })),
  )
  assert.ok(html.includes('修复构建失败'), '折叠态头部应显示任务标题')
  assert.ok(html.includes('1m35s'), '折叠态头部应显示耗时统计')
  assert.ok(html.includes('subagent-live-stats'), '统计尾注容器应渲染')
  assert.ok(html.includes('构建已恢复，测试 42 通过'), '第 2 层副栏应显示结论预览')
})

test('blocked 折叠卡：warn 描边 + 等待审批副栏（pendingAsk 标题）', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'blocked')],
    pendingAsks: [{
      id: 'ask1',
      conversationId: 11,
      title: '确认执行 rm -rf dist',
      fields: [],
      status: 'pending',
      createdAt: 1,
    }],
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card-warn'), 'blocked 卡应有 warn 描边类')
  assert.ok(html.includes('等待审批'), '徽章与副栏 tag 应显示等待审批')
  assert.ok(html.includes('确认执行 rm -rf dist'), '副栏应显示 pendingAsk 标题')
})

test('时间线挂载实时卡后不再重复渲染 subagent trace-row；被 resume 续接的前序调用仍保留', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, title: '子会话 12' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '开始', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'subagent', arguments: { prompt: '首次派生' } }] }] },
    { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'subagent', content: [{ type: 'text', text: '首轮完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '4', kind: 'helm.input', data: { text: '继续', origin: 'human' } },
    { id: '5', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_2', name: 'subagent', arguments: { prompt: '继续', resume: 12 } }] }] },
    { id: '6', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_2', toolName: 'subagent', content: [{ type: 'text', text: '第二轮完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '7', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '全部完成' }], stopReason: 'stop' }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  const cardCount = html.split('subagent-live-card').length - 1
  assert.equal(cardCount, 1, `仅最新调用挂载 1 张实时卡，实际 ${cardCount}`)
  // 最新调用（挂卡处）不再渲染底部 trace-row；被续接的前序调用仍保留 trace-row
  const toolRows = html.match(/<div class="trace-row[\s\S]*?<\/div>/g) ?? []
  const subagentRows = toolRows.filter((r) => r.includes('subagent'))
  assert.equal(subagentRows.length, 1, `仅被续接的前序调用保留 trace-row，实际 ${subagentRows.length}`)
  assert.match(subagentRows[0]!, /已在下文续接/, '保留的前序行应标注续接标识')
  // 前序行不含已完成徽章状态（前序是历史调用，实时卡承载最新状态）
  assert.ok(html.includes('子会话 #<!-- -->12'), '实时卡应显示子会话编号')
})

test('时间线普通 subagent 调用无父 trace-row 双横条：胶囊卡独占展示', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, title: '子会话 12' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '开始', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'subagent', arguments: { prompt: '调研方案' } }] }] },
    { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'subagent', content: [{ type: 'text', text: '调研完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '结论如上' }], stopReason: 'stop' }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal(html.split('subagent-live-card').length - 1, 1, '唯一调用挂载 1 张实时卡')
  const subagentRows = (html.match(/<div class="trace-row[\s\S]*?<\/div>/g) ?? []).filter((r) => r.includes('subagent'))
  assert.equal(subagentRows.length, 0, `挂卡后不得再渲染 subagent trace-row，实际 ${subagentRows.length}`)
})

test('加载失败折叠卡：error 描边 + 加载失败副栏（零请求展示错误）', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    loadErrors: { 'conversation:11': '网关超时' },
  })
  const html = renderToString(
    e(HelmStoreContext.Provider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card-error'), '加载失败卡应有 error 描边类')
  assert.ok(html.includes('subagent-live-subline-error'), '副栏应使用 error 变体')
  assert.ok(html.includes('加载失败'), '副栏 tag 应显示加载失败')
  assert.ok(html.includes('网关超时'), '副栏应显示具体错误')
})

// ---------------------------------------------------------------------------
// SSR：无 Emoji / 特殊符号黑名单
// ---------------------------------------------------------------------------

test('工作流业务卡隐藏重复工具行，但保留本次调用入参和原始结果入口', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const workflow = bgRun({ id: 'wf_native', name: '原生编排', kind: 'workflow', status: 'completed', parentToolCallId: 'wf_call' })
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'wf_call', name: 'SubagentWorkflow', arguments: { script: '原始脚本内容' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'wf_call', toolName: 'SubagentWorkflow', content: [{ type: 'text', text: '原始工作流返回结果' }] }] },
  ]
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [parent], workflowRuns: [workflow] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.ok(html.includes('workflow-run-card'))
  assert.ok(!html.includes('class="trace-row"'))
  assert.ok(html.includes('调用详情'))
  assert.ok(html.includes('原始脚本内容'))
  assert.ok(html.includes('原始工作流返回结果'))
})

test('子代理卡为极简胶囊卡：不渲染内联展开箭头与调用详情，由工作台与分屏承载', { timeout: 60_000 }, () => {
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
    e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', defaultExpanded: true,
      toolCall: { key: 'tool:a', toolName: 'subagent', callId: 'a', status: 'done', isError: false, input: { resume: 11, prompt: '本次原始续接指令' }, resultText: '本次父工具原始输出' },
    })))
  assert.ok(!html.includes('subagent-live-toggle'), '不得渲染折叠展开箭头')
  assert.ok(!html.includes('subagent-live-stream'), '不得内联渲染实时流')
  assert.ok(!html.includes('进入会话'), '不得渲染进入会话页面按钮')
  assert.ok(!html.includes('并排查看'), '卡片不得渲染并排查看按钮')
  assert.ok(html.includes('点击打开子会话抽屉'), '应支持点击卡片打开子会话抽屉')
})

test('SubagentLiveCard 契约：openDrawer 不触发 onNavigate 收起工作台，避免打断排查上下文', { timeout: 60_000 }, () => {
  const filePath = new URL('../src/conversation/SubagentLiveCard.tsx', import.meta.url)
  const src = readFileSync(filePath, 'utf-8')
  const start = src.indexOf('const openDrawer =')
  const end = src.indexOf('return (', start)
  const openDrawerBlock = src.slice(start, end)
  assert.ok(start > 0 && end > start, '应截取到 openDrawer 定义块')
  assert.ok(!openDrawerBlock.includes('onNavigate'), 'openDrawer 不得调用 onNavigate 导致工作台在排查时被强行关闭')
})

test('SubagentLiveCard 整体大卡片点击契约：外层整卡可点击，第 1 层和第 2 层无割裂的内层按钮链接', { timeout: 60_000 }, () => {
  const html = renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
    e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', toolSummary: { prompt: '任务', durationMs: 1000, resultText: '产出结论' } })))
  // 外层为整体大卡片按钮
  assert.ok(html.includes('subagent-card-clickable'), '整卡应具有可点击类名')
  assert.ok(html.includes('role="button"'), '整卡应具有 button 语义')
  assert.ok(html.includes('打开子会话 #11 抽屉'), '整卡应带有打开抽屉的可访问性描述')
  // 第 1 层和第 2 层非 button 元素，避免分层割裂
  assert.ok(!html.includes('class="subagent-live-trigger"') || !html.includes('<button'), '第 1 层不得为独立 button')
  assert.ok(!html.includes('<button') || !html.includes('class="subagent-live-subline"'), '第 2 层不得为独立 button')
})

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u

test('SSR：双层胶囊卡全程无任何 Emoji 或特殊符号字符', { timeout: 60_000 }, () => {
  const samples = [
    // 折叠 done 卡带结论
    renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', toolSummary: { prompt: '任务', durationMs: 1000, resultText: '结论' } }))),
    // 展开流式卡
    renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'working')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running', defaultExpanded: true }))),
    // blocked 折叠卡
    renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'blocked')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running' }))),
    // 加载失败折叠卡
    renderToString(e(HelmStoreContext.Provider, { value: makeStore({ conversations: [summary(11, 'done')], loadErrors: { 'conversation:11': '超时' } }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' }))),
  ]
  for (const html of samples) {
    assert.ok(!EMOJI_RE.test(html), '渲染输出不得包含 Emoji')
    assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸') && !html.includes('⎿'), '不得使用勾叉箭头类特殊符号')
  }
})
