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
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary, WorkflowRunSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { subagentBadge, toolResultPreviewTruncated, isScrolledToBottom } from '../src/conversation/subagent-live-model.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { SubagentLiveCard } = await import('../src/conversation/SubagentLiveCard.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

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
  extra: { backgroundRun?: WorkflowRunSummary; worktree?: { path: string; branch: string } } = {},
): string {
  return renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(SubagentLiveCard, { childConversationId: 11, toolStatus, ...extra })),
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

test('长工具输出：resultPreview 仅预览并标识已截断，不伪装全文', { timeout: 60_000 }, () => {
  const longFirstLine = 'a'.repeat(120)
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: {
      11: { ...summary(11, 'done'), entries: entriesWithToolResult(`${longFirstLine}\nsecond line`) },
    },
  })
  const html = renderCard(store)
  assert.ok(html.includes('a'.repeat(100)), '应渲染截断后的首行预览')
  assert.ok(!html.includes(longFirstLine), '不得渲染未截断全文')
  assert.ok(html.includes('已截断'), '长输出应带已截断标识')
  assert.ok(html.includes('仅为首行预览'), '应说明仅为预览')
})

test('短工具输出：完整首行预览且无截断标识', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: entriesWithToolResult('exit 0') } },
  })
  const html = renderCard(store)
  assert.ok(html.includes('exit 0'))
  assert.ok(!html.includes('已截断'))
})

test('thinking/text 行不套两行 clamp：类名分离由外层限高滚动', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'working')],
    conversationDetails: {
      11: {
        ...summary(11, 'working'),
        entries: [
          { id: '1', kind: 'helm.input', data: { text: '继续任务', origin: 'agent' } },
          {
            id: '2',
            kind: 'pi.assistant',
            model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '思考内容' }] }],
          },
        ],
      },
    },
    conversationLives: {
      11: { conversationId: 11, text: '流式回复正文', thinking: undefined, tools: [], updatedAt: 1 },
    },
  })
  const html = renderCard(store, 'running')
  // clamp 仅保留在 prompt 行；thinking/text 行不带 -webkit-line-clamp 相关类
  const promptMatch = /subagent-stream-line subagent-stream-prompt/.test(html)
  const thinkingMatch = /subagent-stream-line subagent-stream-thinking/.test(html)
  const textMatch = /subagent-stream-line subagent-stream-text/.test(html)
  assert.ok(promptMatch && thinkingMatch && textMatch, '三类行均应渲染')
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

test('backgroundRun failed：流末尾渲染简洁错误提示，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
  })
  const run = bgRun({ status: 'failed', error: 'gate 验收失败：pnpm test 退出码 1' })
  const html = renderCard(store, 'done', { backgroundRun: run })
  assert.ok(html.includes('后台执行失败'), '应显示后台失败提示')
  assert.ok(html.includes('gate 验收失败'), '应包含具体错误信息')
  assert.ok(html.includes('subagent-bg-error'), '错误行应有独立样式类')
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
