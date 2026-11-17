/**
 * SubagentLiveCard / ConversationPane 分屏早退分支行为测试：
 * - 纯逻辑（真实 esbuild 产物 models.ts）：状态优先真实 summary.status、
 *   父工具 toolStatus 仅作无 summary 兜底；resultPreview 截断标识、贴底判定；
 * - SSR 实际渲染（真实插件编译产物 + 宿主共享 SDK hooks）：
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
import { readHostStyles } from './helpers/host-styles.js'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
// 类型引用（test-only）：workflow/herdr 共享契约归属 @helm/plugins（自 @helm/protocol
// 迁出，见 devDependency）；纯类型零运行时耦合，不放宽生产包边界。
import type { WorkflowRunSummary } from '@helm/plugins/contracts'
import { makeTestStore } from './helpers/store.js'
import { TestStoreProvider } from './helpers/host-store.js'
import { groupUiContributions } from '../src/lib/types.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { workflowUi } from './helpers/workflow-ui.js'
import { importWorkflowClientModule, importWorkflowModels, mountSharedPluginNamespaces } from './helpers/workflow-client.js'
const HelmStoreContext = { Provider: TestStoreProvider }
import type { HelmStoreValue } from '../src/lib/types.js'
import type { SubagentParentToolSummary, ExecutionNode, SubagentRunView } from '../../plugins/src/workflow/client/models.ts'
mountSharedPluginNamespaces({ realHooks: true })
const {
  buildSubagentStreamLines, subagentBadge, toolResultPreviewTruncated, isScrolledToBottom,
  resolveSubagentTaskTitle, resolveSubagentHeaderSnippet, buildSubagentStatSegments,
  extractSubagentResultPreview, formatShortModelName, formatSemanticToolAction,
  resolveSubagentElapsedMs, resolveRunElapsedMs, resolveNodeElapsedMs,
  resolveExecutionNodeElapsedMs, buildExecutionTree,
} = await importWorkflowModels()

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const workflowClient = await importWorkflowClientModule()
seedPluginClientModule('builtin:workflow', 'index.tsx', workflowClient)
const SubagentLiveCard = workflowClient.SubagentLiveCard as React.ComponentType<Record<string, unknown>>
const { ExternalRunSummary } = (await importWorkflowClientModule('ExternalRunSummary.tsx')) as {
  ExternalRunSummary: React.ComponentType<Record<string, unknown>>
}
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
  return makeTestStore({
    ...overrides,
    conversations: [summary(1, 'idle'), ...(overrides.conversations ?? [])],
    groupedUi: groupUiContributions(workflowUi),
    workbenchTab: 'plugin:builtin:workflow/tasks',
  })
}

function renderCard(
  store: HelmStoreValue,
  toolStatus: 'running' | 'done' | 'error' = 'done',
  extra: {
    backgroundRun?: WorkflowRunSummary
    worktree?: { path: string; branch: string }
    expanded?: boolean
    toolSummary?: SubagentParentToolSummary
    viewer?: { conversationId?: number; ownedBy?: string }
  } = {},
): string {
  // 存量流式行 / 截断 / 报错测试均针对展开态流内容：默认展开保持覆盖语义，extra 可覆盖。
  const { expanded = true, ...rest } = extra
  return renderToString(
    e(TestStoreProvider, { value: store }, e(SubagentLiveCard, { childConversationId: 11, toolStatus, expanded, ...rest })),
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
  // 父工具已 done，但子会话随后被继续提问重新 working：必须显示 Running
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'unknown'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'done'), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('error', 'done'), { status: 'error', label: 'Error', badge: 'badge-err' })
  // running 的父工具下子会话已真实 error：如实显示 Error
  assert.deepEqual(subagentBadge('error', 'running'), { status: 'error', label: 'Error', badge: 'badge-err' })
  assert.deepEqual(subagentBadge('working', 'done', undefined, undefined, 'zh-CN'), { status: 'working', label: '执行中', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'done', undefined, undefined, 'zh-CN'), { status: 'blocked', label: '等待审批', badge: 'badge-warn' })
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
  assert.deepEqual(subagentBadge('done', 'running'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'running'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  // 仅父工具自身终态且子会话 idle 才显示完成
  assert.deepEqual(subagentBadge('done', 'done'), { status: 'done', label: 'Done', badge: 'badge-ok' })
  assert.deepEqual(subagentBadge('idle', 'done'), { status: 'done', label: 'Done', badge: 'badge-ok' })
  assert.deepEqual(subagentBadge('idle', 'done', undefined, undefined, 'zh-CN'), { status: 'done', label: '已完成', badge: 'badge-ok' })
  // unknown 视同未定（不假完成也不误报错）：pending 由后续状态落定
  assert.equal(subagentBadge('idle', 'unknown').status, 'done')
})

// ---------------------------------------------------------------------------
// 纯逻辑：background: true 后台 run 状态参与判定（绝不假完成）
// ---------------------------------------------------------------------------

test('subagentBadge：真后台 run running 且子会话 idle/done/无 summary 时保持后台运行中，不假完成', { timeout: 60_000 }, () => {
  // 典型场景：background: true 工具行已返回句柄（done），模型输出完毕（子会话 idle），
  // 后台仍在跑 gate 验收命令——绝不能提前显示“Done”
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  // 后台子会话刚启动（父工具行尚 running）
  assert.deepEqual(subagentBadge(undefined, 'running', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }, undefined, 'zh-CN'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
})

test('subagentBadge：后台 run 终态如实呈现，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'failed' }), { status: 'error', label: 'Error', badge: 'badge-err' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'aborted' }), { status: 'error', label: 'Aborted', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'aborted' }, undefined, 'zh-CN'), { status: 'error', label: '已中止', badge: 'badge-warn' })
  // run completed：不再干预，回到 summary/toolStatus 原判定（idle+done = Done）
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'completed' }), { status: 'done', label: 'Done', badge: 'badge-ok' })
})

test('subagentBadge：子会话 working 时带真后台 run 标注为后台运行中；blocked 审批优先', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('working', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  // 无后台 run 关联：保持原有“Running”
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  // blocked 按真实审批优先，不被后台 run 状态覆盖
  assert.deepEqual(subagentBadge('blocked', 'running', { status: 'running' }), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
})

test('subagentBadge：前台同步 run（syncForeground 未 detach）显示执行中，不自称后台；detachedAt 置位即真后台', { timeout: 60_000 }, () => {
  const fg: SubagentRunView = { status: 'running', syncForeground: true }
  // 子会话 working：前台同步 run 只是父回合阻塞等待，徽章与「转入后台」按钮不矛盾
  assert.deepEqual(subagentBadge('working', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'unknown', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  // run running 而子会话 idle/done/无 summary（gate/结算期）：保持 working「Running」，不假完成也不自称后台
  assert.deepEqual(subagentBadge('idle', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  // blocked 审批优先语义在前台同步 run 下同样成立
  assert.deepEqual(subagentBadge('blocked', 'running', fg), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
  // detach 转后台后（detachedAt 置位）：真后台文案恢复
  const detached: SubagentRunView = { status: 'running', syncForeground: true, detachedAt: 5 }
  assert.deepEqual(subagentBadge('working', 'done', detached), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', detached), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  // 真后台 run（background 启动，无 syncForeground）文案不回归
  assert.deepEqual(subagentBadge('working', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
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
  assert.ok(html.includes('Load failed'), '应显示加载失败文案')
  assert.ok(html.includes('网络中断'), '应包含具体错误信息')
  assert.ok(html.includes('Retry'), '应提供重试按钮')
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
    e(TestStoreProvider, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('failed to load'), '分屏加载失败应显示错误')
  assert.ok(html.includes('500 内部错误'))
  assert.ok(html.includes('Retry'))
  assert.ok(html.includes('split-close-btn'), '加载失败分屏分支必须有显式关闭入口')
  assert.ok(html.includes('Close split view'))
})

test('ConversationPane 加载中分屏分支：仍有显式关闭分屏入口', { timeout: 60_000 }, () => {
  const store = makeStore({})
  const html = renderToString(
    e(TestStoreProvider, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('Loading conversation'), '应显示加载中态')
  assert.ok(html.includes('split-close-btn'), '加载中分屏分支必须有显式关闭入口')
})

test('ConversationPane 非分屏分支：早退不渲染分屏关闭按钮', { timeout: 60_000 }, () => {
  const store = makeStore({})
  const html = renderToString(
    e(TestStoreProvider, { value: store }, e(ConversationPane, { conversationId: 42 })),
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
  assert.ok(html.includes('Isolated worktree: /root/code/helm/.worktrees/wt-668'), 'title 提示完整工作树路径')
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
  // 工具行已 done、子会话 idle，但后台 run running：徽章必须显示 Running in background
  assert.ok(html.includes('Running in background'), '后台 run running 时不得假完成')
  assert.ok(!html.includes('Done'), '不得出现已完成徽章')
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
  assert.ok(html.includes('Error'), '徽章应显示异常态')
})

test('前台同步 run：查看会话即发起会话且 human 归属显示「转入后台」；automation / 后台 / 已转后台 / 非本会话不显示', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'working')],
    conversationDetails: { 11: { ...summary(11, 'working'), entries: [] } },
  })
  // 前台同步（syncForeground 未 detached）+ 查看会话 1 = 发起会话 1（缺省 human）。
  const visible = renderCard(store, 'running', {
    backgroundRun: bgRun({ status: 'running', syncForeground: true }),
    viewer: { conversationId: 1 },
  })
  assert.ok(visible.includes('Move to background'), '前台同步 running run 应显示转入后台按钮')
  // 前台同步卡徽章与「Move to background」按钮不矛盾：Running，不自称后台
  assert.ok(visible.includes('Running'), '前台同步卡徽章应显示执行中')
  assert.ok(!visible.includes('Running in background'), '前台同步卡不得显示后台运行中')

  // 查看会话归属 human：显示；归属 automation（helm/bot）：隐藏。
  assert.ok(
    renderCard(store, 'running', {
      backgroundRun: bgRun({ status: 'running', syncForeground: true }),
      viewer: { conversationId: 1, ownedBy: 'human' },
    }).includes('Move to background'),
    'human 查看方应显示转入后台按钮',
  )
  for (const ownedBy of ['helm', 'bot']) {
    assert.ok(
      !renderCard(store, 'running', {
        backgroundRun: bgRun({ status: 'running', syncForeground: true }),
        viewer: { conversationId: 1, ownedBy },
      }).includes('Move to background'),
      `automation（${ownedBy}）查看方不得显示转入后台按钮`,
    )
  }

  // 普通（非前台同步）后台 run：不显示。
  const background = renderCard(store, 'running', {
    backgroundRun: bgRun({ status: 'running' }),
    viewer: { conversationId: 1 },
  })
  assert.ok(!background.includes('Move to background'), '普通后台 run 不得显示转入后台按钮')

  // 已转后台（detachedAt）：不显示。
  const detached = renderCard(store, 'running', {
    backgroundRun: bgRun({ status: 'running', syncForeground: true, detachedAt: 5 }),
    viewer: { conversationId: 1 },
  })
  assert.ok(!detached.includes('Move to background'), '已转后台的 run 不得再显示转入后台按钮')

  // 查看会话非发起会话（viewer 2 ≠ run.conversationId=1）：不显示。
  const otherViewer = renderCard(store, 'running', {
    backgroundRun: bgRun({ status: 'running', syncForeground: true }),
    viewer: { conversationId: 2 },
  })
  assert.ok(!otherViewer.includes('Move to background'), '查看会话非发起会话时不得显示转入后台按钮')
})

test('前台同步 run gate/结算期：子会话 idle 不假完成，徽章执行中且不自称后台', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
  })
  // 工具行已 done、子会话 idle，但前台同步 run 仍在 running（gate 验收/结算期）：
  // 徽章保持 working「Running」，与同卡「Move to background」按钮一致，不假完成也不自称后台。
  const html = renderCard(store, 'done', {
    backgroundRun: bgRun({
      status: 'running',
      syncForeground: true,
      nodes: [{ id: 'g1', kind: 'agent', status: 'running', gateCommand: 'pnpm test' }],
    }),
    viewer: { conversationId: 1 },
  })
  assert.ok(html.includes('Move to background'), '前台同步 running run 应显示转入后台按钮')
  assert.ok(html.includes('Running'), 'gate/结算期徽章应显示执行中')
  assert.ok(!html.includes('Running in background'), '前台同步卡不得显示后台运行中')
  assert.ok(!html.includes('Done'), 'run 未结算不得假完成')
})

test('无 worktree 且无后台 run：不渲染空徽章与错误行', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: [] } },
  })
  const html = renderCard(store, 'done')
  assert.ok(!html.includes('subagent-worktree-badge'))
  assert.ok(!html.includes('subagent-bg-error'))
  assert.ok(!html.includes('Background run failed'))
})

test('同步外部子代理无原生子会话：完成后停止显示执行中（时间线单行与工作台摘要同致）', { timeout: 60_000 }, () => {
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
  const timelineHtml = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [conversation] }) },
    e(ConversationTimeline, { conversation, detailEntries: entries, onRequestEdit: () => {} })))
  assert.ok(timelineHtml.includes('workflow-trace-row-btn'), '时间线使用紧凑单行回执')
  assert.ok(timelineHtml.includes('Done'))
  assert.ok(!timelineHtml.includes('Running'))
  assert.ok(!timelineHtml.includes('External run in progress'))

  const extHtml = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [conversation] }) },
    e(ExternalRunSummary, {
      toolStatus: 'done',
      executionId: 'pane-9',
      nodeId: 'local',
      worktree: { path: '/tmp/wt-9', branch: 'helm/wf-9' },
    })))
  assert.ok(extHtml.includes('subagent-external-card'))
  assert.ok(extHtml.includes('External run settled (no subagent)'))
  assert.ok(extHtml.includes('Done'))
  assert.ok(!extHtml.includes('External run in progress'))
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：时间线单行与多次 resume 去重
// ---------------------------------------------------------------------------

test('resume 正在运行时：历史失败调用保留异常状态，只有最新调用渲染执行中单行', { timeout: 60_000 }, () => {
  const parent = summary(1, 'working')
  const child = { ...summary(12, 'working'), parentConversationId: 1, parentToolCallId: 'call_new' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_old', name: 'subagent', arguments: { prompt: '首次派生' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_old', toolName: 'subagent', content: [{ type: 'text', text: JSON.stringify({ ok: false, execution: { conversationId: 12 } }) }], isError: true }] },
    { id: '3', kind: 'helm.input', data: { text: '重试', origin: 'human' } },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_new', name: 'subagent', arguments: { prompt: '继续修复', resume: '12' } }] }] },
  ]
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [parent, child] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal((html.match(/workflow-trace-row-btn/g) ?? []).length, 2, '前序与最新调用均收口为单行按钮')
  assert.equal((html.match(/class="[^"]*\bsubagent-card-clickable\b/g) ?? []).length, 0, '主时间线不堆叠工作台大卡片')
  const historicalRow = html.match(/<button[^>]*trace-row workflow-trace-row-btn trace-row-error[\s\S]*?<\/button>/)?.[0]
  assert.ok(historicalRow, '历史失败调用的单行应保留 trace-row-error')
  assert.match(historicalRow, /Resumed below[\s\S]*?Error/)
  assert.equal(historicalRow.includes('spin-slow'), false, '历史失败行不能随后续 resume 转圈')
  const activeRows = html.match(/<button[^>]*class="trace-row workflow-trace-row-btn"[\s\S]*?<\/button>/g) ?? []
  assert.equal(activeRows.length, 1, '最新调用单行不应标错')
  assert.match(activeRows[0]!, /spin-slow[\s\S]*?Running/)
  assert.equal(activeRows[0]!.includes('Resumed below'), false)
})

test('expanded=false：SSR 首帧不渲染实时流，保留头部与状态徽章', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: entriesWithToolResult('exit 0') } },
  })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', expanded: false })),
  )
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('Done'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '折叠态 SSR 首帧不得渲染实时流容器')
})

test('同一子会话 #12 被首次派生 + resume 续接：时间线均收口单行，仅前序行标注已在下文续接', { timeout: 60_000 }, () => {
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
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal((html.match(/class="[^"]*\bsubagent-card-clickable\b/g) ?? []).length, 0, '时间线不渲染工作台大卡')
  const rowButtons = html.match(/<button[^>]*workflow-trace-row-btn[\s\S]*?<\/button>/g) ?? []
  assert.equal(rowButtons.length, 2, `两次调用应各占 1 行紧凑轨迹，实际 ${rowButtons.length}`)
  assert.match(rowButtons[0]!, /Subagent #12[\s\S]*?Resumed below/, '前序行应标注续接标识')
  assert.doesNotMatch(rowButtons[1]!, /Resumed below/, '最新调用行不得带续接标识')
  assert.match(rowButtons[1]!, /Subagent #12[\s\S]*?Done/, '最新调用行承载子会话编号与终态')
})

test('工作台独立子会话：紧凑卡无实时流，保留副栏且 working 排在 idle 前面', { timeout: 60_000 }, () => {
  const child31 = { ...summary(31, 'idle'), parentConversationId: 1, updatedAt: 5 }
  const child32 = { ...summary(32, 'working'), parentConversationId: 1, updatedAt: 9, doing: '正在跑测试' }
  const store = makeStore({
    conversations: [child31, child32],
  })
  const html = renderToString(
    e(TestStoreProvider, { value: store }, e(WorkbenchDrawer, { conversationId: 1 })),
  )
  assert.ok(html.includes('Current conversation tasks'), '工作台统一标题应渲染')
  assert.ok(html.includes('Subagent #<!-- -->31') || html.includes('Subagent #31'), '折叠卡片头部应显示 #31')
  assert.ok(html.includes('Subagent #<!-- -->32') || html.includes('Subagent #32'), 'working 卡片头部应显示 #32')
  // 工作台仅展示紧凑卡，不渲染内嵌实时流容器。
  const streams = html.split('subagent-live-stream').length - 1
  assert.equal(streams, 0, `默认折叠态不得渲染实时流，实际 ${streams}`)
  // 第 2 层动态副栏正常渲染（working 卡显示实时 doing）
  assert.ok(html.includes('subagent-live-subline'), '折叠态应渲染第 2 层动态副栏')
  assert.ok(html.includes('正在跑测试'), 'working 卡副栏应显示实时 doing')
  // Active-First：working #32 排在 idle #31 前面
  const pos31 = html.indexOf('Subagent #<!-- -->31') !== -1 ? html.indexOf('Subagent #<!-- -->31') : html.indexOf('Subagent #31')
  const pos32 = html.indexOf('Subagent #<!-- -->32') !== -1 ? html.indexOf('Subagent #<!-- -->32') : html.indexOf('Subagent #32')
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

test('buildSubagentStatSegments：模型 / 思考档位 / 工具步数 / token 按序收集（总耗时不在此）', { timeout: 60_000 }, () => {
  const child = { ...summary(11, 'done'), model: 'openai/glm-5', thinkingLevel: 'high', createdAt: 1_000, updatedAt: 61_000 }
  const segs = buildSubagentStatSegments({
    summary: child,
    entries: entriesWithToolResult('exit 0'),
  })
  assert.deepEqual(segs, ['glm-5', 'high', '1 tools loaded'])
  assert.deepEqual(buildSubagentStatSegments({ summary: child, entries: entriesWithToolResult('exit 0') }, 'zh-CN'), ['glm-5', 'high', '已载 1 次工具'])
  // off 思考档位不展示；token 紧凑格式；无 entries 时用 live.tools 计数
  const segs2 = buildSubagentStatSegments({
    summary: { ...summary(11, 'working'), thinkingLevel: 'off' },
    live: { conversationId: 11, text: '', tools: [
      { callId: 'a', toolName: 'bash', status: 'done' },
      { callId: 'b', toolName: 'read', status: 'running' },
    ], updatedAt: 1 },
    backgroundRun: bgRun({ nodes: [{ id: 'n1', kind: 'agent', status: 'running', tokens: 1500 }] }),
  })
  assert.deepEqual(segs2, ['2 tools loaded', '1.5k'])
  // 小于 1000 的 token 原样展示；会话创建时间不是本轮边界，不产生耗时片段
  const segs3 = buildSubagentStatSegments({
    backgroundRun: bgRun({ status: 'completed', createdAt: 1, updatedAt: 1, nodes: [{ id: 'n1', kind: 'agent', status: 'done', tokens: 500 }] }),
  })
  assert.deepEqual(segs3, ['500'])
})

test('resolveSubagentElapsedMs：在途（working/blocked）有时钟才动态计时，结算定格持久化 duration', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  // nowMs 缺省（SSR 首帧）或早于起点（时钟异常）：不显示秒表
  assert.equal(resolveSubagentElapsedMs({ status: 'working', startedAt: start }), undefined)
  assert.equal(resolveSubagentElapsedMs({ status: 'working', startedAt: start, nowMs: start - 1 }), undefined)
  // 会话创建时间不是本轮边界：resume 场景无本次起点必须省略该伪计时
  assert.equal(resolveSubagentElapsedMs({ status: 'working' }), undefined)
  // working：优先后台 run.createdAt（run 即本次调用的真实边界）
  assert.equal(
    resolveSubagentElapsedMs({ status: 'working', backgroundRun: bgRun({ status: 'running', createdAt: start }), nowMs: start + 5_000 }),
    5_000,
  )
  // 仅本次父工具记录起点时显示本次调用耗时
  assert.equal(resolveSubagentElapsedMs({ status: 'working', toolSummary: { startedAt: start }, nowMs: start + 5_000 }), 5_000)
  // blocked（等待审批）仍在途：有本次起点时秒表持续动态变化
  assert.equal(resolveSubagentElapsedMs({ status: 'blocked', startedAt: start, nowMs: start + 8_000 }), 8_000)
  assert.equal(resolveSubagentElapsedMs({ status: 'blocked' }), undefined)
  // 结算：优先持久化 duration（run 首节点 durationMs / toolSummary.durationMs）
  assert.equal(
    resolveSubagentElapsedMs({ backgroundRun: bgRun({ status: 'completed', nodes: [{ id: 'n1', kind: 'agent', status: 'done', durationMs: 800 }] }) }),
    800,
  )
  assert.equal(resolveSubagentElapsedMs({ toolSummary: { durationMs: 800 } }), 800)
  // run 无节点 duration 时以 createdAt → updatedAt 定格
  assert.equal(resolveSubagentElapsedMs({ backgroundRun: bgRun({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }) }), 60_000)
})

test('resolveRunElapsedMs：running 随时钟动态推进，其余定格 createdAt→updatedAt 真实边界', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  // running 且时钟有效：动态推进
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start }, start + 4_000), 4_000)
  // running 但无时钟（SSR 首帧）或时钟异常：定格到最近快照（确定性，不伪造）
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start + 2_000 }), 2_000)
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start }, start - 1), 0)
  // 结算：createdAt → updatedAt 定格
  assert.equal(resolveRunElapsedMs({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }, start), 60_000)
  // 非法时间差如实省略
  assert.equal(resolveRunElapsedMs({ status: 'completed', createdAt: 5_000, updatedAt: 1_000 }), undefined)
})

test('resolveNodeElapsedMs：running 用 startedAt 动态、结算用 durationMs 定格，无边界省略', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  assert.equal(resolveNodeElapsedMs({ status: 'running', startedAt: start }, start + 1_500), 1_500)
  // running 但无时钟（SSR）或无起点：省略，不显示虚构 0ms
  assert.equal(resolveNodeElapsedMs({ status: 'running', startedAt: start }), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'running' }, start), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'done', durationMs: 95_000 }, start), 95_000)
  assert.equal(resolveNodeElapsedMs({ status: 'done' }, start), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'failed', durationMs: -1 }), undefined)
})

test('resolveExecutionNodeElapsedMs：runNode 边界优先，容器行用 run，纯会话节点省略', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  // runNode：running 动态 / 结算定格
  assert.equal(
    resolveExecutionNodeElapsedMs({ runNode: { id: 'n1', kind: 'action', status: 'running', startedAt: start } }, start + 2_000),
    2_000,
  )
  assert.equal(
    resolveExecutionNodeElapsedMs({ runNode: { id: 'n2', kind: 'action', status: 'done', durationMs: 3_000 } }, start),
    3_000,
  )
  // 无 runNode 的容器行（深层 workflow / external）：run 边界
  assert.equal(
    resolveExecutionNodeElapsedMs({ run: bgRun({ status: 'running', createdAt: start, updatedAt: start }) }, start + 6_000),
    6_000,
  )
  // 纯会话节点（无 run / runNode）：无本轮可靠起点，不以会话 createdAt 伪造
  assert.equal(resolveExecutionNodeElapsedMs({}, start), undefined)
})

// ---------------------------------------------------------------------------
// 纯逻辑：formatSemanticToolAction / extractSubagentResultPreview
// ---------------------------------------------------------------------------

test('formatSemanticToolAction：常见工具语义化（bash / Read / Edit / Write / Search / Find / 兜底）', { timeout: 60_000 }, () => {
  assert.deepEqual(formatSemanticToolAction('bash', { command: 'pnpm test\n&& pnpm build' }), { tag: 'bash', text: 'pnpm test' })
  assert.deepEqual(formatSemanticToolAction('read', { file_path: '/root/code/helm/packages/web/src/App.tsx' }, '/root/code/helm'), { tag: 'Read', text: 'packages/web/src/App.tsx' })
  assert.deepEqual(formatSemanticToolAction('read', { file_path: '/root/code/helm/packages/web/src/App.tsx' }, '/root/code/helm', 'zh-CN'), { tag: '读取', text: 'packages/web/src/App.tsx' })
  assert.deepEqual(formatSemanticToolAction('edit_file', { file_path: '/tmp/x.ts' }), { tag: 'Edit', text: '/tmp/x.ts' })
  assert.deepEqual(formatSemanticToolAction('write', { file_path: '/tmp/out.md' }), { tag: 'Write', text: '/tmp/out.md' })
  assert.deepEqual(formatSemanticToolAction('grep', { pattern: 'SubagentLiveCard' }), { tag: 'Search', text: 'SubagentLiveCard' })
  assert.deepEqual(formatSemanticToolAction('find', { pattern: '*.test.ts' }), { tag: 'Find', text: '*.test.ts' })
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
  assert.deepEqual(snip, { kind: 'error', tag: 'Load failed', text: '网络中断' })
  assert.deepEqual(resolveSubagentHeaderSnippet({ badgeStatus: 'working', detailError: '网络中断\n重试无效' }, 'zh-CN'), { kind: 'error', tag: '加载失败', text: '网络中断' })
})

test('resolveSubagentHeaderSnippet：blocked 取 pendingAsk 标题，缺省退回 doing 与兜底', { timeout: 60_000 }, () => {
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', pendingAsk: { title: '确认删除文件', description: '详情' } }),
    { kind: 'blocked', tag: 'Awaiting approval', text: '确认删除文件' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', pendingAsk: { title: '', description: '描述文案' } }),
    { kind: 'blocked', tag: 'Awaiting approval', text: '描述文案' },
  )
  const doing = { ...summary(11, 'blocked'), doing: '等待删除确认' }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked', summary: doing }),
    { kind: 'blocked', tag: 'Awaiting approval', text: '等待删除确认' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'blocked' }),
    { kind: 'blocked', tag: 'Awaiting approval', text: 'Awaiting human confirmation' },
  )
})

test('resolveSubagentHeaderSnippet：error 优先后台 run 失败，其次父工具错误与子会话最后报错', { timeout: 60_000 }, () => {
  const failedRun = bgRun({ status: 'failed', error: 'gate 验收失败：退出码 1' })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: failedRun }),
    { kind: 'error', tag: 'Background run failed', text: 'gate 验收失败：退出码 1' },
  )
  const abortedRun = bgRun({ status: 'aborted', error: '用户中止' })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: abortedRun }),
    { kind: 'error', tag: 'Aborted', text: '用户中止' },
  )
  // run 失败但无 error：取首个失败节点 error / gate 输出
  const nodeErrRun = bgRun({ status: 'failed', nodes: [{ id: 'n1', kind: 'agent', status: 'failed', gate: { ok: false, output: '测试失败：期望 3 得到 2' } }] })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: nodeErrRun }),
    { kind: 'error', tag: 'Background run failed', text: '测试失败：期望 3 得到 2' },
  )
  // 前台同步 run 失败：兜底文案不自称「后台」
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true }) }),
    { kind: 'error', tag: 'Execution failed', text: 'Execution failed' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true }) }, 'zh-CN'),
    { kind: 'error', tag: '执行失败', text: '执行失败' },
  )
  // 前台同步 run 失败但有真实错误文本：文本如实，tag 仍为「Execution failed」
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true, error: 'gate 验收失败：退出码 1' }) }),
    { kind: 'error', tag: 'Execution failed', text: 'gate 验收失败：退出码 1' },
  )
  // 前台同步 run 失败节点无 error：gate 输出如实，兜底不自称「后台」
  assert.deepEqual(
    resolveSubagentHeaderSnippet({
      badgeStatus: 'error',
      backgroundRun: bgRun({ status: 'failed', syncForeground: true, nodes: [{ id: 'n1', kind: 'agent', status: 'failed' }] }),
    }),
    { kind: 'error', tag: 'Execution failed', text: 'Execution failed' },
  )
  // 已 detach（detachedAt 置位）：真后台，保持 Background run failed 文案
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true, detachedAt: 5 }) }),
    { kind: 'error', tag: 'Background run failed', text: 'Background run failed' },
  )
  // 父工具 JSON 错误信封
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { resultText: JSON.stringify({ ok: false, error: '执行超时' }) } }),
    { kind: 'error', tag: 'Failed', text: '执行超时' },
  )
  // 父工具 isError：剥离尾注后取首行
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { isError: true, resultText: '命令失败：退出码 2\n[subagent conversationId=11]' } }),
    { kind: 'error', tag: 'Failed', text: '命令失败：退出码 2' },
  )
  // 子会话 entries 中最后一条报错工具输出
  const errEntries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c9', name: 'bash', arguments: { command: 'pnpm test' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: '测试失败：期望通过' }], isError: true }] },
  ]
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', entries: errEntries }),
    { kind: 'error', tag: 'Error', text: '测试失败：期望通过' },
  )
  // 兜底
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', summary: { ...summary(11, 'error'), doing: '最后动作' } }),
    { kind: 'error', tag: 'Error', text: '最后动作' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error' }),
    { kind: 'error', tag: 'Error', text: 'Subagent execution error' },
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
    { kind: 'tool', tag: 'Parallel ×3', text: 'bash pnpm build · Read a.ts …' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: multiLive, summary: { ...summary(11, 'working'), cwd: '/root/code/helm' } }, 'zh-CN'),
    { kind: 'tool', tag: '并行 3 项', text: 'bash pnpm build · 读取 a.ts 等' },
  )
})

test('resolveSubagentHeaderSnippet：working 次优流式思考与正文（取最后非空行去前缀）', { timeout: 60_000 }, () => {
  const thinkingLive = { conversationId: 11, text: '', thinking: '第一行思路\n- 下一步跑测试\n', tools: [], updatedAt: 1 }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: thinkingLive }),
    { kind: 'thinking', tag: 'Thinking', text: '下一步跑测试' },
  )
  const textLive = { conversationId: 11, text: '正文开头\n\n## 小结', tools: [], updatedAt: 1 }
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: textLive }),
    { kind: 'text', tag: 'Output', text: '小结' },
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
    { kind: 'doing', tag: 'Gate check', text: 'pnpm test --filter @helm/web' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', summary: { ...summary(11, 'working'), doing: '正在重构模块' } }),
    { kind: 'doing', text: '正在重构模块' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working' }),
    { kind: 'doing', text: 'Starting subagent…' },
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

test('紧凑卡 SSR 首帧：未传 expanded 时只渲染头部', { timeout: 60_000 }, () => {
  const store = makeStore({ conversations: [summary(11, 'done')] })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('Done'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '默认折叠 SSR 首帧不得渲染实时流容器')
  assert.ok(html.includes('subagent-live-trigger'), '第 1 层触发按钮应渲染')
})

test('折叠态 done 卡无任何结论来源时不渲染第 2 层副栏', { timeout: 60_000 }, () => {
  const store = makeStore({ conversations: [summary(11, 'idle')] })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(!html.includes('subagent-live-subline'), '无有效文本时不得渲染副栏占位')
})

test('toolSummary 注入：折叠态头部显示任务标题、独立总耗时位与完成结论预览', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
  })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
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
  assert.ok(html.includes('1m35s'), '折叠态头部应显示定格总耗时')
  assert.ok(html.includes('subagent-live-elapsed'), '总耗时应位于独立固定展示位（subagent-live-elapsed）')
  assert.ok(html.includes('构建已恢复，测试 42 通过'), '第 2 层副栏应显示结论预览')
})

test('working 卡 SSR 首帧：无客户端时钟时省略动态总耗时，不伪造 0ms', { timeout: 60_000 }, () => {
  const store = makeStore({ conversations: [summary(11, 'working')] })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running', startedAt: Date.now() - 60_000 })),
  )
  assert.ok(html.includes('Running'), '状态徽章正常渲染')
  assert.ok(!html.includes('subagent-live-elapsed'), 'SSR 首帧无时钟不得显示动态总耗时')
})

test('ExecutionChildrenRows：真实 run/runNode 边界的行显示总耗时，运行行 SSR 首帧省略', { timeout: 60_000 }, async () => {
  const subagentModule = await importWorkflowClientModule('SubagentCard.tsx')
  const Rows = subagentModule.ExecutionChildrenRows as React.ComponentType<{ nodes: ExecutionNode[] }>
  const parent = summary(1, 'working')
  const run: WorkflowRunSummary = {
    id: 'wf_rows',
    name: '树行耗时',
    conversationId: 1,
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [
      { id: 'n_done', kind: 'action', status: 'done', durationMs: 95_000, label: '动作甲' },
      { id: 'n_run', kind: 'action', status: 'running', startedAt: 1_500, label: '动作乙' },
    ],
  }
  const tree = buildExecutionTree({ rootConversationId: 1, conversations: [parent], runs: [run] })
  const children = tree[0]?.children ?? []
  assert.equal(children.length, 2, '构树应产出两个动作叶子')
  const html = renderToString(
    e(TestStoreProvider, { value: makeStore({ conversations: [parent] }) }, e(Rows, { nodes: children })),
  )
  assert.ok(html.includes('动作甲') && html.includes('动作乙'), '两行均应渲染')
  const elapsedSlots = html.split('execution-child-elapsed').length - 1
  assert.equal(elapsedSlots, 1, `结算行渲染独立耗时位、运行行 SSR 首帧省略，实际 ${elapsedSlots}`)
  assert.ok(html.includes('1m35s'), '结算行显示持久化 duration 定格值')
})

test('ExternalRunSummary：显示 run 总耗时（结算定格 createdAt→updatedAt）', { timeout: 60_000 }, async () => {
  const subagentModule = await importWorkflowClientModule('SubagentCard.tsx')
  const ExternalRunSummary = subagentModule.ExternalRunSummary as React.ComponentType<Record<string, unknown>>
  const html = renderToString(
    e(TestStoreProvider, { value: makeStore({}) },
      e(ExternalRunSummary, {
        run: bgRun({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }),
        toolStatus: 'done',
      })),
  )
  assert.ok(html.includes('subagent-live-elapsed'), '应渲染独立总耗时位')
  assert.ok(html.includes('1m0s'), '结算 run 显示定格总耗时')
})

test('ExternalRunSummary：前台同步 run 失败兜底为执行失败，真后台与已 detach 保持后台执行失败', { timeout: 60_000 }, async () => {
  const subagentModule = await importWorkflowClientModule('SubagentCard.tsx')
  const ExternalRunSummary = subagentModule.ExternalRunSummary as React.ComponentType<Record<string, unknown>>
  const render = (run: WorkflowRunSummary): string => renderToString(
    e(TestStoreProvider, { value: makeStore({}) },
      e(ExternalRunSummary, { run, toolStatus: 'error' })),
  )
  // 前台同步 failed 且无 error 文本：兜底「Execution failed」，不自称后台
  const fg = render(bgRun({ status: 'failed', syncForeground: true }))
  assert.ok(fg.includes('Execution failed'), '前台同步失败应显示执行失败')
  assert.ok(!fg.includes('Background run failed'), '前台同步失败不得自称后台执行失败')
  // 真后台（background 启动）failed：保持「Background run failed」
  assert.ok(render(bgRun({ status: 'failed' })).includes('Background run failed'), '真后台失败保持后台执行失败')
  // 已 detach（detachedAt 置位）failed：同真后台
  assert.ok(render(bgRun({ status: 'failed', syncForeground: true, detachedAt: 5 })).includes('Background run failed'), '已 detach 的失败 run 保持后台执行失败')
  // 带真实 error 文本时前后台都以标签前缀如实拼接
  assert.ok(
    render(bgRun({ status: 'failed', syncForeground: true, error: 'gate 退出码 1' })).includes('Execution failed: gate 退出码 1'),
    '前台同步失败带 error 时显示「Execution failed: <error>」',
  )
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
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card-warn'), 'blocked 卡应有 warn 描边类')
  assert.ok(html.includes('Awaiting approval'), '徽章与副栏 tag 应显示等待审批')
  assert.ok(html.includes('确认执行 rm -rf dist'), '副栏应显示 pendingAsk 标题')
})

test('时间线替换默认 subagent trace-row 为插件单行（无双横条），前序 resume 保留续接标识', { timeout: 60_000 }, () => {
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
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal((html.match(/<div class="trace-row/g) ?? []).length, 0, 'replaceRow 接管后不得保留宿主默认 div.trace-row')
  const rowButtons = html.match(/<button[^>]*workflow-trace-row-btn[\s\S]*?<\/button>/g) ?? []
  assert.equal(rowButtons.length, 2, `两次调用各渲染 1 行插件轨迹，实际 ${rowButtons.length}`)
  assert.match(rowButtons[0]!, /Resumed below/, '前序行应标注续接标识')
  assert.doesNotMatch(rowButtons[1]!, /Resumed below/)
  assert.ok(html.includes('Subagent #12'), '最新调用行应显示子会话编号')
})

test('时间线普通 subagent 调用无父 trace-row 双横条：单行轨迹独占展示', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, title: '子会话 12' }
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '开始', origin: 'human' } },
    { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'subagent', arguments: { prompt: '调研方案' } }] }] },
    { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'subagent', content: [{ type: 'text', text: '调研完成\n[subagent conversationId=12]' }], isError: false }] },
    { id: '4', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '结论如上' }], stopReason: 'stop' }] },
  ]
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [parent, child12] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.equal((html.match(/workflow-trace-row-btn/g) ?? []).length, 1, '唯一调用只渲染 1 行插件轨迹')
  assert.equal((html.match(/<div class="trace-row/g) ?? []).length, 0, '不得与宿主默认工具行同时存在双横条')
})

test('加载失败折叠卡：error 描边 + 加载失败副栏（零请求展示错误）', { timeout: 60_000 }, () => {
  const store = makeStore({
    conversations: [summary(11, 'done')],
    loadErrors: { 'conversation:11': '网关超时' },
  })
  const html = renderToString(
    e(TestStoreProvider, { value: store },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' })),
  )
  assert.ok(html.includes('subagent-live-card-error'), '加载失败卡应有 error 描边类')
  assert.ok(html.includes('subagent-live-subline-error'), '副栏应使用 error 变体')
  assert.ok(html.includes('Load failed'), '副栏 tag 应显示加载失败')
  assert.ok(html.includes('网关超时'), '副栏应显示具体错误')
})

// ---------------------------------------------------------------------------
// SSR：无 Emoji / 特殊符号黑名单
// ---------------------------------------------------------------------------

test('工作流业务卡替换宿主默认工具行：首帧收口单行并支持按需查看原始调用详情', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'wf_call', name: 'SubagentWorkflow', arguments: { script: '原始脚本内容' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'wf_call', toolName: 'SubagentWorkflow', content: [{ type: 'text', text: '原始工作流返回结果' }] }] },
  ]
  // runs 已改为会话分片订阅（usePluginSessionDoc）：SSR 首帧无订阅数据时，
  // WorkflowToolView 保持单行可展开按钮（不回退宿主 div.trace-row），绝不虚构运行卡。
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [parent] }) },
    e(ConversationTimeline, { conversation: parent, detailEntries: entries, onRequestEdit: () => {} })))
  assert.ok(!html.includes('class="trace-row"'), '无数据也不得回退宿主默认 div.trace-row')
  assert.ok(html.includes('workflow-trace-row-btn'), '使用 WorkflowToolView 单行按钮')
  assert.ok(html.includes('aria-expanded="false"'), '无 run 时默认收起详情入口')
  assert.ok(!html.includes('Call details') && !html.includes('原始工作流返回结果'), '默认收起时不预先摊开调用详情与原始输出')
})

test('折叠子代理卡：不渲染内联流与展开箭头，整卡通过抽屉查看详情', { timeout: 60_000 }, () => {
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
    e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', expanded: false, toolSummary: { prompt: '本次原始续接指令', resultText: '本次父工具原始输出' },
    })))
  assert.ok(!html.includes('subagent-live-toggle'), '不得渲染折叠展开箭头')
  assert.ok(!html.includes('subagent-live-stream'), '不得内联渲染实时流')
  assert.ok(!html.includes('进入会话'), '不得渲染进入会话页面按钮')
  assert.ok(!html.includes('并排查看'), '卡片不得渲染并排查看按钮')
  assert.doesNotMatch(html, /subagent-split-btn|workbench-split-btn/, '卡片不得包含已移除的并排按钮类名')
  assert.ok(html.includes('Open subagent #11 drawer'), '整卡应带有打开抽屉的可访问性描述')
  assert.ok(html.includes('Click to open the subagent drawer'), '应支持点击卡片打开子会话抽屉')
})

test('宿主只按通用 tool.view 挂载，工作流状态不渗入父回合在途判定', { timeout: 60_000 }, () => {
  // 工具行渲染单元拆至 TimelineRows.tsx：两处渲染文件均不得渗入工作流私有状态。
  const src = readFileSync(new URL('../src/conversation/ConversationTimeline.tsx', import.meta.url), 'utf8')
  const rowsSrc = readFileSync(new URL('../src/conversation/TimelineRows.tsx', import.meta.url), 'utf8')
  assert.ok(!/builtin:workflow|workflowRuns|SubagentLiveCard|WorkflowRunSummary/.test(src))
  assert.ok(!/builtin:workflow|workflowRuns|SubagentLiveCard|WorkflowRunSummary/.test(rowsSrc))
  assert.match(rowsSrc, /replaceRow/)
})

test('SubagentLiveCard 整体大卡片点击契约：外层整卡可点击，第 1 层和第 2 层无割裂的内层按钮链接', { timeout: 60_000 }, () => {
  const html = renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
    e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', toolSummary: { prompt: '任务', durationMs: 1000, resultText: '产出结论' } })))
  // 外层为整体大卡片按钮
  assert.ok(html.includes('subagent-card-clickable'), '整卡应具有可点击类名')
  assert.ok(html.includes('role="button"'), '整卡应具有 button 语义')
  assert.ok(html.includes('Open subagent #11 drawer'), '整卡应带有打开抽屉的可访问性描述')
  // 第 1 层和第 2 层非 button 元素，避免分层割裂
  assert.ok(!html.includes('class="subagent-live-trigger"') || !html.includes('<button'), '第 1 层不得为独立 button')
  assert.ok(!html.includes('<button') || !html.includes('class="subagent-live-subline"'), '第 2 层不得为独立 button')
})

test('插件自有样式契约：整卡统一 hover，且宿主样式表不携带工作流业务类', { timeout: 60_000 }, () => {
  const pluginCss = readFileSync(new URL('../../plugins/src/workflow/client/styles.css', import.meta.url), 'utf-8')
  const hostCss = [readHostStyles(), readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')].join('\n')
  assert.ok(pluginCss.includes('.subagent-card-clickable:hover'), '插件样式应包含整卡 hover 高亮规则')
  assert.match(
    pluginCss,
    /\.subagent-card-clickable:hover:not\(:has\(\.execution-children:hover/,
    '移入内层多级子会话区域时，外层父卡不得同时高亮',
  )
  assert.match(
    pluginCss,
    /\.execution-child-clickable:hover\s*\{[\s\S]*?background:\s*var\(--accent-bg\)/,
    '内层子会话行 hover 应使用与外层父卡区分的强调底色',
  )
  assert.ok(!pluginCss.includes('.subagent-live-trigger:hover'), '严禁为 trigger 设置独立 hover 背景')
  assert.ok(!pluginCss.includes('.subagent-live-subline:hover'), '严禁为 subline 设置独立 hover 背景')
  // 总耗时独立固定展示位：持有唯一右推 auto margin（统计尾注不得再右推，
  // 避免双 auto margin 空洞），且不被任何窄屏规则隐藏。
  assert.match(pluginCss, /\.subagent-live-elapsed\s*\{[\s\S]*?margin-left:\s*auto/, '总耗时位应持有唯一右推 auto margin')
  assert.doesNotMatch(pluginCss, /\.subagent-live-stats\s*\{[^}]*margin-left/, '统计尾注不得再持有右推 margin（避免双 auto margin 空洞）')
  assert.doesNotMatch(pluginCss, /\.subagent-live-elapsed[^{]*\{[^}]*display:\s*none/, '总耗时位不得被窄屏规则隐藏')
  assert.doesNotMatch(hostCss, /\.(?:subagent|workflow)-/, '宿主样式表不得硬编码插件业务类')
  assert.doesNotMatch(hostCss, /\.phase-segment/, '阶段胶囊样式同属插件')
})

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u

test('SSR：双层胶囊卡全程无任何 Emoji 或特殊符号字符', { timeout: 60_000 }, () => {
  const samples = [
    // 折叠 done 卡带结论
    renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'done')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done', toolSummary: { prompt: '任务', durationMs: 1000, resultText: '结论' } }))),
    // 展开流式卡
    renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'working')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running', expanded: true }))),
    // blocked 折叠卡
    renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'blocked')] }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running' }))),
    // 加载失败折叠卡
    renderToString(e(TestStoreProvider, { value: makeStore({ conversations: [summary(11, 'done')], loadErrors: { 'conversation:11': '超时' } }) },
      e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' }))),
  ]
  for (const html of samples) {
    assert.ok(!EMOJI_RE.test(html), '渲染输出不得包含 Emoji')
    assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸') && !html.includes('⎿'), '不得使用勾叉箭头类特殊符号')
  }
})
