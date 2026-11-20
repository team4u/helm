/**
 * SubagentLiveCard / SubagentToolView / ExternalRunSummary / ExecutionChildrenRows
 * 行为与纯模型测试（零 @helmx/web 依赖）：
 * - 纯逻辑（models.ts 编译产物）：状态优先 summary.status、工具输出截断与预览、
 *   elapsed 计算边界、语义工具标题、headerSnippet 全分支；
 * - SSR & DOM（真实插件编译产物 + 宿主共享 SDK 端口）：
 *   折叠态与时间线行传 includeDetail: false（零 loadConversationDetail N+1），
 *   展开态（expanded=true）按需触发 loadConversationDetail；
 *   loadErrors 显式报错 + 重试；worktree 分支徽章；syncForeground 按钮归属权约束；
 *   WorkBench 紧凑卡 Active-First 排序；无 Emoji / 勾叉符号。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AskSpec, ConversationEntry, ConversationSummary } from '@helmx/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import type { ExecutionNode, SubagentParentToolSummary, SubagentRunView } from '../src/workflow/client/models.ts'
import {
  React,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

mountSharedPluginNamespaces({ realHooks: true })
const {
  buildSubagentStreamLines, subagentBadge, toolResultPreviewTruncated, isScrolledToBottom,
  resolveSubagentTaskTitle, resolveSubagentHeaderSnippet, buildSubagentStatSegments,
  extractSubagentResultPreview, formatShortModelName, formatSemanticToolAction,
  resolveSubagentElapsedMs, resolveRunElapsedMs, resolveNodeElapsedMs,
  resolveExecutionNodeElapsedMs, buildExecutionTree,
} = await importWorkflowModels()

const e = React.createElement
const { act } = React
const workflowClient = await importWorkflowClientModule()
const SubagentLiveCard = workflowClient['SubagentLiveCard'] as React.ComponentType<Record<string, unknown>>
const SubagentToolView = workflowClient['SubagentToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowToolView = workflowClient['WorkflowToolView'] as React.ComponentType<Record<string, unknown>>
const WorkflowWorkbenchPanel = workflowClient['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
const { ExternalRunSummary } = (await importWorkflowClientModule('ExternalRunSummary.tsx')) as {
  ExternalRunSummary: React.ComponentType<Record<string, unknown>>
}

function summary(id: number, status: ConversationSummary['status']): ConversationSummary {
  return makeConvSummary(id, { status })
}

function entriesWithToolResult(resultText: string): ConversationEntry[] {
  return [
    { id: '1', kind: 'helmx.input', data: { text: '跑构建', origin: 'agent' } },
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

interface RenderOpts {
  conversations?: ConversationSummary[]
  conversationDetails?: Record<number, ConversationSummary & { entries: ConversationEntry[] }>
  pendingAsks?: AskSpec[]
  loadErrors?: Record<string, string>
  runsByConversation?: Record<number, WorkflowRunSummary[]>
  backgroundRun?: WorkflowRunSummary
  childNodes?: ExecutionNode[]
  worktree?: { path: string; branch: string }
  expanded?: boolean
  toolSummary?: SubagentParentToolSummary
  viewer?: { conversationId?: number; ownedBy?: string }
}

function renderCard(
  toolStatus: 'running' | 'done' | 'error' = 'done',
  opts: RenderOpts = {},
): string {
  const {
    conversations = [],
    conversationDetails,
    pendingAsks,
    loadErrors,
    runsByConversation,
    expanded = true,
    ...rest
  } = opts
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [summary(1, 'idle'), ...conversations],
    ...(conversationDetails !== undefined ? { conversationDetails } : {}),
    ...(pendingAsks !== undefined ? { pendingAsks } : {}),
    ...(loadErrors !== undefined ? { loadErrors } : {}),
    ...(runsByConversation !== undefined ? { runsByConversation } : {}),
  })
  return h.renderSsr(e(SubagentLiveCard, { childConversationId: 11, toolStatus, expanded, ...rest }))
}

function bgRun(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_bg1',
    name: 'subagent',
    conversationId: 1,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 回归不变量：includeDetail 按需懒加载（零 N+1）
// ---------------------------------------------------------------------------

test('SubagentToolView 与折叠态 SubagentLiveCard 传 includeDetail=false 零详情请求，展开态触发按需加载', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child11 = { ...summary(11, 'working'), parentConversationId: 1, parentToolCallId: 'call-lazy' }
  const h1 = createWorkflowHostHarness({ conversationId: 1, conversations: [parent, child11] })
  const toolUi = h1.mountNode(
    e(SubagentToolView, {
      callId: 'call-lazy',
      toolName: 'subagent',
      input: { prompt: '去跑测试' },
      status: 'running',
      conversationId: 1,
      siblingCalls: [],
    }),
  )
  try {
    assert.deepEqual(h1.log.loadDetailCalls, [], 'SubagentToolView 不得拉取子会话全量 detail')
  } finally {
    toolUi.unmount()
  }

  const h2 = createWorkflowHostHarness({ conversationId: 1, conversations: [parent, child11] })
  const collapsedUi = h2.mountNode(e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running' }))
  try {
    assert.deepEqual(h2.log.loadDetailCalls, [], '默认折叠态 SubagentLiveCard 不得拉取子会话全量 detail')
    collapsedUi.rerender(e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'running', expanded: true }))
    assert.deepEqual(h2.log.loadDetailCalls, [11], 'expanded=true 展开态必须按需触发一次 loadConversationDetail(11)')
  } finally {
    collapsedUi.unmount()
  }
})

// ---------------------------------------------------------------------------
// 纯逻辑：状态徽章优先真实 summary.status
// ---------------------------------------------------------------------------

test('subagentBadge：summary working/blocked/error 优先于父工具 toolStatus', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'unknown'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'done'), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('error', 'done'), { status: 'error', label: 'Error', badge: 'badge-err' })
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
  assert.deepEqual(subagentBadge('done', 'running'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'running'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done'), { status: 'done', label: 'Done', badge: 'badge-ok' })
  assert.deepEqual(subagentBadge('idle', 'done'), { status: 'done', label: 'Done', badge: 'badge-ok' })
  assert.deepEqual(subagentBadge('idle', 'done', undefined, undefined, 'zh-CN'), { status: 'done', label: '已完成', badge: 'badge-ok' })
  assert.equal(subagentBadge('idle', 'unknown').status, 'done')
})

test('subagentBadge：真后台 run running 且子会话 idle/done/无 summary 时保持后台运行中，不假完成', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'running', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }, undefined, 'zh-CN'), { status: 'working', label: '后台运行中', badge: 'badge-accent' })
})

test('subagentBadge：后台 run 终态如实呈现，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'failed' }), { status: 'error', label: 'Error', badge: 'badge-err' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'aborted' }), { status: 'error', label: 'Aborted', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'aborted' }, undefined, 'zh-CN'), { status: 'error', label: '已中止', badge: 'badge-warn' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'completed' }), { status: 'done', label: 'Done', badge: 'badge-ok' })
})

test('subagentBadge：子会话 working 时带真后台 run 标注为后台运行中；blocked 审批优先', { timeout: 60_000 }, () => {
  assert.deepEqual(subagentBadge('working', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'done'), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'running', { status: 'running' }), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
})

test('subagentBadge：前台同步 run（syncForeground 未 detach）显示执行中，不自称后台；detachedAt 置位即真后台', { timeout: 60_000 }, () => {
  const fg: SubagentRunView = { status: 'running', syncForeground: true }
  assert.deepEqual(subagentBadge('working', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'unknown', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('done', 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge(undefined, 'done', fg), { status: 'working', label: 'Running', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('blocked', 'running', fg), { status: 'blocked', label: 'Awaiting approval', badge: 'badge-warn' })
  const detached: SubagentRunView = { status: 'running', syncForeground: true, detachedAt: 5 }
  assert.deepEqual(subagentBadge('working', 'done', detached), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', detached), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('working', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
  assert.deepEqual(subagentBadge('idle', 'done', { status: 'running' }), { status: 'working', label: 'Running in background', badge: 'badge-accent' })
})

// ---------------------------------------------------------------------------
// 纯逻辑：resultPreview 截断标识与贴底判定
// ---------------------------------------------------------------------------

test('toolResultPreviewTruncated：带省略号即截断标识，不伪装全文', { timeout: 60_000 }, () => {
  assert.equal(toolResultPreviewTruncated('exit 0'), false)
  assert.equal(toolResultPreviewTruncated('.'.repeat(101)), false)
  assert.equal(toolResultPreviewTruncated('abc…'), true)
  assert.equal(toolResultPreviewTruncated('第一行内容' + 'x'.repeat(96) + '…'), true)
})

test('isScrolledToBottom：距底部 36px 内视为贴底，上滑更远则脱离跟随', { timeout: 60_000 }, () => {
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1128, clientHeight: 36 }), true)
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1127, clientHeight: 36 }), false)
  assert.equal(isScrolledToBottom({ scrollHeight: 1200, scrollTop: 1100, clientHeight: 36 }), false)
  assert.equal(isScrolledToBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 }), true)
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：加载失败显式报错 + 重试，流式解析
// ---------------------------------------------------------------------------

test('详情加载失败：显式错误提示与重试按钮，不再永远加载中', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    conversations: [summary(11, 'done')],
    loadErrors: { 'conversation:11': '网络中断' },
  })
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
  assert.ok(toolLine !== undefined && toolLine.kind === 'tool')
  assert.equal(toolLine.resultPreview, `${'a'.repeat(100)}…`)
  assert.ok(toolResultPreviewTruncated(toolLine.resultPreview))
})

test('短工具输出：buildSubagentStreamLines 完整首行预览且无截断标识', { timeout: 60_000 }, () => {
  const entries = entriesWithToolResult('exit 0')
  const lines = buildSubagentStreamLines(entries)
  const toolLine = lines.find((l) => l.kind === 'tool')
  assert.ok(toolLine !== undefined && toolLine.kind === 'tool')
  assert.equal(toolLine.resultPreview, 'exit 0')
  assert.equal(toolResultPreviewTruncated(toolLine.resultPreview), false)
})

test('thinking/text 行：buildSubagentStreamLines 正确解析思考与正文', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helmx.input', data: { text: '继续任务', origin: 'agent' } },
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
// SSR 实际渲染：worktree 分支徽章与后台 run 状态
// ---------------------------------------------------------------------------

test('worktree 存在：头部渲染分支徽章（git-branch 图标 + 分支名，无 Emoji）', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
    worktree: { path: '/root/code/helm/.worktrees/wt-668', branch: 'helmx/spawn-123' },
  })
  assert.ok(html.includes('subagent-worktree-badge'), '应渲染 worktree 徽章类')
  assert.ok(html.includes('helmx/spawn-123'), '应显示分支名')
  assert.ok(html.includes('Isolated worktree: /root/code/helm/.worktrees/wt-668'), 'title 提示完整工作树路径')
})

test('backgroundRun 节点携带 worktree：无显式入参时回退展示 run 节点徽章', { timeout: 60_000 }, () => {
  const run = bgRun({
    status: 'running',
    nodes: [{ id: 'a1', kind: 'agent', status: 'running', worktree: { path: '/wt/abc', branch: 'helmx/bg-9' } }],
  })
  const html = renderCard('done', {
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
    backgroundRun: run,
  })
  assert.ok(html.includes('subagent-worktree-badge'), '应从 run 节点回退渲染徽章')
  assert.ok(html.includes('helmx/bg-9'))
  assert.ok(html.includes('Running in background'), '后台 run running 时不得假完成')
  assert.ok(!html.includes('Done'), '不得出现已完成徽章')
})

test('backgroundRun failed：副栏渲染错误提示，不被子会话旧 idle 覆盖', { timeout: 60_000 }, () => {
  const run = bgRun({ status: 'failed', error: 'gate 验收失败：pnpm test 退出码 1' })
  const html = renderCard('done', {
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
    backgroundRun: run,
  })
  assert.ok(html.includes('gate 验收失败'), '应包含具体错误信息')
  assert.ok(html.includes('subagent-live-subline-error'), '副栏应使用 error 变体样式类')
  assert.ok(html.includes('Error'), '徽章应显示异常态')
})

test('前台同步 run：查看会话即发起会话且 human 归属显示「转入后台」；automation / 后台 / 已转后台 / 非本会话不显示', { timeout: 60_000 }, () => {
  const baseOpts: RenderOpts = {
    conversations: [summary(11, 'working')],
    conversationDetails: { 11: { ...summary(11, 'working'), entries: [] } },
  }
  const visible = renderCard('running', {
    ...baseOpts,
    backgroundRun: bgRun({ status: 'running', syncForeground: true }),
    viewer: { conversationId: 1 },
  })
  assert.ok(visible.includes('Move to background'), '前台同步 running run 应显示转入后台按钮')
  assert.ok(visible.includes('Running'), '前台同步卡徽章应显示执行中')
  assert.ok(!visible.includes('Running in background'), '前台同步卡不得显示后台运行中')

  assert.ok(
    renderCard('running', {
      ...baseOpts,
      backgroundRun: bgRun({ status: 'running', syncForeground: true }),
      viewer: { conversationId: 1, ownedBy: 'human' },
    }).includes('Move to background'),
    'human 查看方应显示转入后台按钮',
  )
  for (const ownedBy of ['helmx', 'bot']) {
    assert.ok(
      !renderCard('running', {
        ...baseOpts,
        backgroundRun: bgRun({ status: 'running', syncForeground: true }),
        viewer: { conversationId: 1, ownedBy },
      }).includes('Move to background'),
      `automation（${ownedBy}）查看方不得显示转入后台按钮`,
    )
  }

  const background = renderCard('running', {
    ...baseOpts,
    backgroundRun: bgRun({ status: 'running' }),
    viewer: { conversationId: 1 },
  })
  assert.ok(!background.includes('Move to background'), '普通后台 run 不得显示转入后台按钮')

  const detached = renderCard('running', {
    ...baseOpts,
    backgroundRun: bgRun({ status: 'running', syncForeground: true, detachedAt: 5 }),
    viewer: { conversationId: 1 },
  })
  assert.ok(!detached.includes('Move to background'), '已转后台的 run 不得再显示转入后台按钮')

  const otherViewer = renderCard('running', {
    ...baseOpts,
    backgroundRun: bgRun({ status: 'running', syncForeground: true }),
    viewer: { conversationId: 2 },
  })
  assert.ok(!otherViewer.includes('Move to background'), '查看会话非发起会话时不得显示转入后台按钮')
})

test('前台同步 run gate/结算期：子会话 idle 不假完成，徽章执行中且不自称后台', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    conversations: [summary(11, 'idle')],
    conversationDetails: { 11: { ...summary(11, 'idle'), entries: [] } },
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
  const html = renderCard('done', {
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: [] } },
  })
  assert.ok(!html.includes('subagent-worktree-badge'))
  assert.ok(!html.includes('subagent-bg-error'))
  assert.ok(!html.includes('Background run failed'))
})

test('同步外部子代理无原生子会话：完成后停止显示执行中（时间线单行与工作台摘要同致）', { timeout: 60_000 }, () => {
  const conversation = summary(1, 'idle')
  const structuredOutput = {
    ok: true,
    result: 'done',
    execution: {
      nodeId: 'local',
      executionId: 'pane-9',
      worktree: { path: '/tmp/wt-9', branch: 'helmx/wf-9' },
    },
  }
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [conversation] })
  const toolHtml = h.renderSsr(
    e(SubagentToolView, {
      callId: 'ext-1',
      toolName: 'subagent',
      input: { prompt: '执行任务', agentType: 'herdr:pi' },
      result: JSON.stringify(structuredOutput),
      structuredOutput,
      status: 'done',
      isError: false,
      conversationId: 1,
      siblingCalls: [],
    }),
  )
  assert.ok(toolHtml.includes('workflow-trace-row-btn'), '时间线使用紧凑单行回执')
  assert.ok(toolHtml.includes('Done'))
  assert.ok(!toolHtml.includes('Running'))
  assert.ok(!toolHtml.includes('External run in progress'))

  const extHtml = h.renderSsr(
    e(ExternalRunSummary, {
      toolStatus: 'done',
      executionId: 'pane-9',
      nodeId: 'local',
      worktree: { path: '/tmp/wt-9', branch: 'helmx/wf-9' },
    }),
  )
  assert.ok(extHtml.includes('subagent-external-card'))
  assert.ok(extHtml.includes('External run settled (no subagent)'))
  assert.ok(extHtml.includes('Done'))
  assert.ok(!extHtml.includes('External run in progress'))
})

// ---------------------------------------------------------------------------
// SSR 实际渲染：SubagentToolView 单行与多次 resume 去重
// ---------------------------------------------------------------------------

test('resume 正在运行时：历史失败调用保留异常状态，只有最新调用渲染执行中单行', { timeout: 60_000 }, () => {
  const parent = summary(1, 'working')
  const child = { ...summary(12, 'working'), parentConversationId: 1, parentToolCallId: 'call_new' }
  const oldOutput = { ok: false, execution: { conversationId: 12 } }
  const oldCall = {
    callId: 'call_old',
    toolName: 'subagent',
    status: 'error' as const,
    isError: true,
    input: { prompt: '首次派生' },
    result: JSON.stringify(oldOutput),
    structuredOutput: oldOutput,
  }
  const newCall = {
    callId: 'call_new',
    toolName: 'subagent',
    status: 'running' as const,
    input: { prompt: '继续修复', resume: '12' },
  }
  const siblings = [oldCall, newCall]
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [parent, child] })
  const html = h.renderSsr(
    e(
      React.Fragment,
      null,
      e(SubagentToolView, { ...oldCall, conversationId: 1, siblingCalls: siblings }),
      e(SubagentToolView, { ...newCall, conversationId: 1, siblingCalls: siblings }),
    ),
  )
  assert.equal((html.match(/workflow-trace-row-btn/g) ?? []).length, 2, '前序与最新调用均收口为单行按钮')
  assert.equal((html.match(/class="[^"]*\bsubagent-card-clickable\b/g) ?? []).length, 0, '主时间线不堆叠工作台大卡片')
  const historicalRow = html.match(/<button[^>]*trace-row workflow-trace-row-btn trace-row-error[\s\S]*?<\/button>/)?.[0]
  assert.ok(historicalRow !== undefined, '历史失败调用的单行应保留 trace-row-error')
  assert.match(historicalRow, /Resumed below[\s\S]*?Error/)
  assert.equal(historicalRow.includes('spin-slow'), false, '历史失败行不能随后续 resume 转圈')
  const activeRows = html.match(/<button[^>]*class="trace-row workflow-trace-row-btn"[\s\S]*?<\/button>/g) ?? []
  assert.equal(activeRows.length, 1, '最新调用单行不应标错')
  assert.match(activeRows[0]!, /helmx-status-light-working[\s\S]*?status-dot-working[\s\S]*?Running/)
  assert.equal(activeRows[0]!.includes('spin-slow'), false, '主状态不再用 spinner')
  assert.equal(activeRows[0]!.includes('Resumed below'), false)
})

test('expanded=false：SSR 首帧不渲染实时流，保留头部与状态徽章', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: false,
    conversations: [summary(11, 'done')],
    conversationDetails: { 11: { ...summary(11, 'done'), entries: entriesWithToolResult('exit 0') } },
  })
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('Done'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '折叠态 SSR 首帧不得渲染实时流容器')
})

test('同一子会话 #12 被首次派生 + resume 续接：SubagentToolView 收口单行，仅前序行标注已在下文续接', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child12 = { ...summary(12, 'done'), parentConversationId: 1, title: '子会话 12' }
  const out12 = { execution: { conversationId: 12 } }
  const call1 = {
    callId: 'call_1',
    toolName: 'subagent',
    status: 'done' as const,
    input: { prompt: '首次派生' },
    result: '首轮完成',
    structuredOutput: out12,
  }
  const call2 = {
    callId: 'call_2',
    toolName: 'subagent',
    status: 'done' as const,
    input: { prompt: '继续', resume: 12 },
    result: '第二轮完成',
    structuredOutput: out12,
  }
  const siblings = [call1, call2]
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [parent, child12] })
  const html = h.renderSsr(
    e(
      React.Fragment,
      null,
      e(SubagentToolView, { ...call1, conversationId: 1, siblingCalls: siblings }),
      e(SubagentToolView, { ...call2, conversationId: 1, siblingCalls: siblings }),
    ),
  )
  assert.equal((html.match(/class="[^"]*\bsubagent-card-clickable\b/g) ?? []).length, 0, '时间线不渲染工作台大卡')
  const rowButtons = html.match(/<button[^>]*workflow-trace-row-btn[\s\S]*?<\/button>/g) ?? []
  assert.equal(rowButtons.length, 2, `两次调用应各占 1 行紧凑轨迹，实际 ${rowButtons.length}`)
  assert.match(rowButtons[0]!, /首次派生[\s\S]*?#12[\s\S]*?Resumed below/, '前序行应主显任务名、次显 #12 并标注续接标识')
  assert.doesNotMatch(rowButtons[1]!, /Resumed below/, '最新调用行不得带续接标识')
  assert.match(rowButtons[1]!, /继续[\s\S]*?#12[\s\S]*?Done/, '最新调用行主显任务名、次显 #12 与终态')
})

test('工作台独立子会话（runs 驱动）：紧凑卡无实时流，保留副栏且 working 排在 idle 前面', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child31 = { ...summary(31, 'idle'), parentConversationId: 1, updatedAt: 5 }
  const child32 = { ...summary(32, 'working'), parentConversationId: 1, updatedAt: 9, doing: '正在跑测试' }
  const run31: WorkflowRunSummary = {
    id: 'wf_sub31',
    name: 'subagent',
    conversationId: 1,
    kind: 'subagent',
    status: 'completed',
    createdAt: 1,
    updatedAt: 5,
    nodes: [{ id: 'a31', kind: 'agent', status: 'done', conversationId: 31 }],
  }
  const run32: WorkflowRunSummary = {
    id: 'wf_sub32',
    name: 'subagent',
    conversationId: 1,
    kind: 'subagent',
    status: 'running',
    createdAt: 2,
    updatedAt: 9,
    nodes: [{ id: 'a32', kind: 'agent', status: 'running', conversationId: 32 }],
  }
  const h = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [parent, child31, child32],
    runsByConversation: { 1: [run31, run32] },
  })
  const ui = h.mountNode(e(WorkflowWorkbenchPanel, { conversation: parent }))
  try {
    const html = ui.container.innerHTML
    assert.ok(html.includes('Current conversation tasks'), '工作台统一标题应渲染')
    assert.ok(html.includes('Subagent #<!-- -->31') || html.includes('Subagent #31'), '折叠卡片头部应显示 #31')
    assert.ok(html.includes('Subagent #<!-- -->32') || html.includes('Subagent #32'), 'working 卡片头部应显示 #32')
    const streams = html.split('subagent-live-stream').length - 1
    assert.equal(streams, 0, `默认折叠态不得渲染实时流，实际 ${streams}`)
    assert.ok(html.includes('subagent-live-subline'), '折叠态应渲染第 2 层动态副栏')
    assert.ok(html.includes('正在跑测试'), 'working 卡副栏应显示实时 doing')
    const pos31 = html.indexOf('Subagent #<!-- -->31') !== -1 ? html.indexOf('Subagent #<!-- -->31') : html.indexOf('Subagent #31')
    const pos32 = html.indexOf('Subagent #<!-- -->32') !== -1 ? html.indexOf('Subagent #<!-- -->32') : html.indexOf('Subagent #32')
    assert.ok(pos31 !== -1 && pos32 !== -1 && pos32 < pos31, 'working #32 应按 Active-First 排在 idle #31 前面')
    assert.ok(!html.includes('subagent-split-btn') && !html.includes('workbench-split-btn'), '不得再渲染并排按钮')
  } finally {
    ui.unmount()
  }
})

// ---------------------------------------------------------------------------
// 纯逻辑：resolveSubagentTaskTitle / formatShortModelName
// ---------------------------------------------------------------------------

test('resolveSubagentTaskTitle：自定义标题 > 非占位 run.name > label > 父工具 prompt > 首节点，过滤默认占位标题并截断 60 字符', { timeout: 60_000 }, () => {
  const child = { ...summary(11, 'done'), title: '修复登录超时' }
  assert.equal(resolveSubagentTaskTitle(child, 11), '修复登录超时')
  // 内核/插件各种默认占位标题均不得短路后续真实任务名提取
  for (const placeholder of [
    'subagent 11',
    'Subagent 11',
    'SUBAGENT #11',
    '子代理 11',
    '子代理 #11',
    '子会话 11',
    '子会话 #11',
    '   ',
  ]) {
    assert.equal(
      resolveSubagentTaskTitle({ ...summary(11, 'done'), title: placeholder }, 11, { prompt: '跑全量测试' }),
      '跑全量测试',
      `占位标题 "${placeholder}" 不得短路 prompt 提取`,
    )
  }
  // 非占位 backgroundRun.name 优先于父工具 prompt；占位名（'subagent' / 'subagent:...' / run.id）被忽略
  assert.equal(
    resolveSubagentTaskTitle(summary(11, 'done'), 11, { prompt: '父工具提示词' }, bgRun({ name: '排查构建失败' })),
    '排查构建失败',
  )
  for (const placeholderRunName of ['subagent', 'subagent:herdr:pi', 'wf_bg1']) {
    assert.equal(
      resolveSubagentTaskTitle(summary(11, 'done'), 11, { prompt: '父工具提示词' }, bgRun({ name: placeholderRunName })),
      '父工具提示词',
      `占位 run.name "${placeholderRunName}" 不得短路`,
    )
  }
  // prompt 剥离结构化输出契约样板后取首行，超 60 字符截断
  const longPrompt = `${'修'.repeat(70)}尾`
  assert.equal(resolveSubagentTaskTitle(undefined, 11, { prompt: longPrompt }), `${'修'.repeat(60)}…`)
  const withContract = `安装依赖\n<structured_output_contract>{"type":"object"}</structured_output_contract>`
  assert.equal(resolveSubagentTaskTitle(undefined, 11, { prompt: withContract }), '安装依赖')
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
// 纯逻辑：buildSubagentStatSegments / elapsed
// ---------------------------------------------------------------------------

test('buildSubagentStatSegments：模型 / 思考档位 / 工具步数 / token 按序收集（总耗时不在此）', { timeout: 60_000 }, () => {
  const child = { ...summary(11, 'done'), model: 'openai/glm-5', thinkingLevel: 'high', createdAt: 1_000, updatedAt: 61_000 }
  const segs = buildSubagentStatSegments({
    summary: child,
    entries: entriesWithToolResult('exit 0'),
  })
  assert.deepEqual(segs, ['glm-5', 'high', '1 tools loaded'])
  assert.deepEqual(buildSubagentStatSegments({ summary: child, entries: entriesWithToolResult('exit 0') }, 'zh-CN'), ['glm-5', 'high', '已载 1 次工具'])
  const segs2 = buildSubagentStatSegments({
    summary: { ...summary(11, 'working'), thinkingLevel: 'off' },
    live: {
      conversationId: 11,
      text: '',
      tools: [
        { callId: 'a', toolName: 'bash', status: 'done' },
        { callId: 'b', toolName: 'read', status: 'running' },
      ],
      updatedAt: 1,
    },
    backgroundRun: bgRun({ nodes: [{ id: 'n1', kind: 'agent', status: 'running', tokens: 1500 }] }),
  })
  assert.deepEqual(segs2, ['2 tools loaded', '1.5k'])
  const segs3 = buildSubagentStatSegments({
    backgroundRun: bgRun({ status: 'completed', createdAt: 1, updatedAt: 1, nodes: [{ id: 'n1', kind: 'agent', status: 'done', tokens: 500 }] }),
  })
  assert.deepEqual(segs3, ['500'])
})

test('resolveSubagentElapsedMs：在途（working/blocked）有时钟才动态计时，结算定格持久化 duration', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  assert.equal(resolveSubagentElapsedMs({ status: 'working', startedAt: start }), undefined)
  assert.equal(resolveSubagentElapsedMs({ status: 'working', startedAt: start, nowMs: start - 1 }), undefined)
  assert.equal(resolveSubagentElapsedMs({ status: 'working' }), undefined)
  assert.equal(
    resolveSubagentElapsedMs({ status: 'working', backgroundRun: bgRun({ status: 'running', createdAt: start }), nowMs: start + 5_000 }),
    5_000,
  )
  assert.equal(resolveSubagentElapsedMs({ status: 'working', toolSummary: { startedAt: start }, nowMs: start + 5_000 }), 5_000)
  assert.equal(resolveSubagentElapsedMs({ status: 'blocked', startedAt: start, nowMs: start + 8_000 }), 8_000)
  assert.equal(resolveSubagentElapsedMs({ status: 'blocked' }), undefined)
  assert.equal(
    resolveSubagentElapsedMs({ backgroundRun: bgRun({ status: 'completed', nodes: [{ id: 'n1', kind: 'agent', status: 'done', durationMs: 800 }] }) }),
    800,
  )
  assert.equal(resolveSubagentElapsedMs({ toolSummary: { durationMs: 800 } }), 800)
  assert.equal(resolveSubagentElapsedMs({ backgroundRun: bgRun({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }) }), 60_000)
})

test('resolveRunElapsedMs：running 随时钟动态推进，其余定格 createdAt→updatedAt 真实边界', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start }, start + 4_000), 4_000)
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start + 2_000 }), 2_000)
  assert.equal(resolveRunElapsedMs({ status: 'running', createdAt: start, updatedAt: start }, start - 1), 0)
  assert.equal(resolveRunElapsedMs({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }, start), 60_000)
  assert.equal(resolveRunElapsedMs({ status: 'completed', createdAt: 5_000, updatedAt: 1_000 }), undefined)
})

test('resolveNodeElapsedMs：running 用 startedAt 动态、结算用 durationMs 定格，无边界省略', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  assert.equal(resolveNodeElapsedMs({ status: 'running', startedAt: start }, start + 1_500), 1_500)
  assert.equal(resolveNodeElapsedMs({ status: 'running', startedAt: start }), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'running' }, start), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'done', durationMs: 95_000 }, start), 95_000)
  assert.equal(resolveNodeElapsedMs({ status: 'done' }, start), undefined)
  assert.equal(resolveNodeElapsedMs({ status: 'failed', durationMs: -1 }), undefined)
})

test('resolveExecutionNodeElapsedMs：runNode 边界优先，容器行用 run，纯会话节点省略', { timeout: 60_000 }, () => {
  const start = 1_700_000_000_000
  assert.equal(
    resolveExecutionNodeElapsedMs({ runNode: { id: 'n1', kind: 'action', status: 'running', startedAt: start } }, start + 2_000),
    2_000,
  )
  assert.equal(
    resolveExecutionNodeElapsedMs({ runNode: { id: 'n2', kind: 'action', status: 'done', durationMs: 3_000 } }, start),
    3_000,
  )
  assert.equal(
    resolveExecutionNodeElapsedMs({ run: bgRun({ status: 'running', createdAt: start, updatedAt: start }) }, start + 6_000),
    6_000,
  )
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

test('extractSubagentResultPreview：structuredOutput / JSON 信封优先，不刮取尾注', { timeout: 60_000 }, () => {
  assert.equal(extractSubagentResultPreview(undefined), undefined)
  assert.equal(extractSubagentResultPreview('   '), undefined)
  assert.equal(
    extractSubagentResultPreview('ignored text', { ok: true, result: '来自结构化输出' }),
    '来自结构化输出',
  )
  assert.equal(extractSubagentResultPreview(JSON.stringify({ ok: true, result: '任务完成，共修复 3 处' })), '任务完成，共修复 3 处')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ output: '产出首行\n第二行' })), '产出首行')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ summary: '总结' })), '总结')
  assert.equal(extractSubagentResultPreview(JSON.stringify({ other: 1 })), '{"other":1}')
  assert.equal(extractSubagentResultPreview('结论：全部通过\n第二行'), '结论：全部通过')
  assert.equal(extractSubagentResultPreview('纯文本结论'), '纯文本结论')
  // 已彻底废弃 [subagent ...] 尾注语法，按普通文本处理。
  assert.equal(extractSubagentResultPreview('[subagent conversationId=11]'), '[subagent conversationId=11]')
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
  const nodeErrRun = bgRun({ status: 'failed', nodes: [{ id: 'n1', kind: 'agent', status: 'failed', gate: { ok: false, output: '测试失败：期望 3 得到 2' } }] })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: nodeErrRun }),
    { kind: 'error', tag: 'Background run failed', text: '测试失败：期望 3 得到 2' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true }) }),
    { kind: 'error', tag: 'Execution failed', text: 'Execution failed' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true }) }, 'zh-CN'),
    { kind: 'error', tag: '执行失败', text: '执行失败' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true, error: 'gate 验收失败：退出码 1' }) }),
    { kind: 'error', tag: 'Execution failed', text: 'gate 验收失败：退出码 1' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({
      badgeStatus: 'error',
      backgroundRun: bgRun({ status: 'failed', syncForeground: true, nodes: [{ id: 'n1', kind: 'agent', status: 'failed' }] }),
    }),
    { kind: 'error', tag: 'Execution failed', text: 'Execution failed' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', backgroundRun: bgRun({ status: 'failed', syncForeground: true, detachedAt: 5 }) }),
    { kind: 'error', tag: 'Background run failed', text: 'Background run failed' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { structuredOutput: { ok: false, error: '结构化超时' } } }),
    { kind: 'error', tag: 'Failed', text: '结构化超时' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { resultText: JSON.stringify({ ok: false, error: '执行超时' }) } }),
    { kind: 'error', tag: 'Failed', text: '执行超时' },
  )
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', toolSummary: { isError: true, resultText: '命令失败：退出码 2\n第二行' } }),
    { kind: 'error', tag: 'Failed', text: '命令失败：退出码 2' },
  )
  const errEntries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c9', name: 'bash', arguments: { command: 'pnpm test' } }] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [{ type: 'text', text: '测试失败：期望通过' }], isError: true }] },
  ]
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'error', entries: errEntries }),
    { kind: 'error', tag: 'Error', text: '测试失败：期望通过' },
  )
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
    nodes: [{ id: 'n1', kind: 'agent', status: 'done', gateCommand: 'pnpm test --filter @helmx/web' }],
  })
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'working', summary: summary(11, 'idle'), backgroundRun: gateRun }),
    { kind: 'doing', tag: 'Gate check', text: 'pnpm test --filter @helmx/web' },
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

test('resolveSubagentHeaderSnippet：done 取 entries 结论 > structuredOutput/resultText > 后台 run 产出 > undefined', { timeout: 60_000 }, () => {
  const entries = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '最终结论：全部通过' }], stopReason: 'stop' }] },
  ]
  assert.deepEqual(
    resolveSubagentHeaderSnippet({ badgeStatus: 'done', entries }),
    { kind: 'done', text: '最终结论：全部通过' },
  )
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
// SSR：默认折叠 + 第 2 层副栏 + 树行 / WorkflowToolView / 整卡无 Emoji
// ---------------------------------------------------------------------------

test('紧凑卡 SSR 首帧：未传 expanded 时只渲染头部', { timeout: 60_000 }, () => {
  const html = renderCard('done', { expanded: undefined, conversations: [summary(11, 'done')] })
  assert.ok(html.includes('subagent-live-card'), '卡片容器应渲染')
  assert.ok(html.includes('subagent-live-header'), '头部应渲染')
  assert.ok(html.includes('Done'), '状态徽章应渲染')
  assert.ok(!html.includes('subagent-live-stream'), '默认折叠 SSR 首帧不得渲染实时流容器')
  assert.ok(html.includes('subagent-live-trigger'), '第 1 层触发按钮应渲染')
})

test('折叠态 done 卡无任何结论来源时不渲染第 2 层副栏', { timeout: 60_000 }, () => {
  const html = renderCard('done', { expanded: undefined, conversations: [summary(11, 'idle')] })
  assert.ok(!html.includes('subagent-live-subline'), '无有效文本时不得渲染副栏占位')
})

test('toolSummary 注入：折叠态头部显示任务标题、独立总耗时位与完成结论预览', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
    conversations: [summary(11, 'done')],
    toolSummary: {
      prompt: '修复构建失败',
      durationMs: 95_000,
      resultText: JSON.stringify({ ok: true, result: '构建已恢复，测试 42 通过' }),
    },
  })
  assert.ok(html.includes('修复构建失败'), '折叠态头部应显示任务标题')
  assert.ok(html.includes('1m35s'), '折叠态头部应显示定格总耗时')
  assert.ok(html.includes('subagent-live-elapsed'), '总耗时应位于独立固定展示位（subagent-live-elapsed）')
  assert.ok(html.includes('构建已恢复，测试 42 通过'), '第 2 层副栏应显示结论预览')
})

test('working 卡 SSR 首帧：无客户端时钟时省略动态总耗时，不伪造 0ms', { timeout: 60_000 }, () => {
  const html = renderCard('running', {
    expanded: undefined,
    conversations: [summary(11, 'working')],
  })
  assert.ok(html.includes('Running'), '状态徽章正常渲染')
  assert.ok(!html.includes('subagent-live-elapsed'), 'SSR 首帧无时钟不得显示动态总耗时')
})

test('ExecutionChildrenRows：真实 run/runNode 边界的行显示总耗时，运行行 SSR 首帧省略', { timeout: 60_000 }, async () => {
  const subagentModule = await importWorkflowClientModule('SubagentCard.tsx')
  const Rows = subagentModule['ExecutionChildrenRows'] as React.ComponentType<{ nodes: ExecutionNode[] }>
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
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [parent] })
  const html = h.renderSsr(e(Rows, { nodes: children }))
  assert.ok(html.includes('动作甲') && html.includes('动作乙'), '两行均应渲染')
  const elapsedSlots = html.split('execution-child-elapsed').length - 1
  assert.equal(elapsedSlots, 1, `结算行渲染独立耗时位、运行行 SSR 首帧省略，实际 ${elapsedSlots}`)
  assert.ok(html.includes('1m35s'), '结算行显示持久化 duration 定格值')
})

test('ExternalRunSummary：显示 run 总耗时（结算定格 createdAt→updatedAt）', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1 })
  const html = h.renderSsr(
    e(ExternalRunSummary, {
      run: bgRun({ status: 'completed', createdAt: 1_000, updatedAt: 61_000 }),
      toolStatus: 'done',
    }),
  )
  assert.ok(html.includes('subagent-live-elapsed'), '应渲染独立总耗时位')
  assert.ok(html.includes('1m0s'), '结算 run 显示定格总耗时')
})

test('ExternalRunSummary：前台同步 run 失败兜底为执行失败，真后台与已 detach 保持后台执行失败', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1 })
  const render = (run: WorkflowRunSummary): string => h.renderSsr(e(ExternalRunSummary, { run, toolStatus: 'error' }))
  const fg = render(bgRun({ status: 'failed', syncForeground: true }))
  assert.ok(fg.includes('Execution failed'), '前台同步失败应显示执行失败')
  assert.ok(!fg.includes('Background run failed'), '前台同步失败不得自称后台执行失败')
  assert.ok(render(bgRun({ status: 'failed' })).includes('Background run failed'), '真后台失败保持后台执行失败')
  assert.ok(render(bgRun({ status: 'failed', syncForeground: true, detachedAt: 5 })).includes('Background run failed'), '已 detach 的失败 run 保持后台执行失败')
  assert.ok(
    render(bgRun({ status: 'failed', syncForeground: true, error: 'gate 退出码 1' })).includes('Execution failed: gate 退出码 1'),
    '前台同步失败带 error 时显示「Execution failed: <error>」',
  )
})

test('blocked 折叠卡：warn 描边 + 等待审批副栏（pendingAsk 标题）', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
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
  assert.ok(html.includes('subagent-live-card-warn'), 'blocked 卡应有 warn 描边类')
  assert.ok(html.includes('Awaiting approval'), '徽章与副栏 tag 应显示等待审批')
  assert.ok(html.includes('确认执行 rm -rf dist'), '副栏应显示 pendingAsk 标题')
})

test('加载失败折叠卡：error 描边 + 加载失败副栏（零请求展示错误）', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
    conversations: [summary(11, 'done')],
    loadErrors: { 'conversation:11': '网关超时' },
  })
  assert.ok(html.includes('subagent-live-card-error'), '加载失败卡应有 error 描边类')
  assert.ok(html.includes('subagent-live-subline-error'), '副栏应使用 error 变体')
  assert.ok(html.includes('Load failed'), '副栏 tag 应显示加载失败')
  assert.ok(html.includes('网关超时'), '副栏应显示具体错误')
})

test('WorkflowToolView 无 runs 首帧：收口单行并默认收起原始调用详情', { timeout: 60_000 }, () => {
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [summary(1, 'idle')] })
  const html = h.renderSsr(
    e(WorkflowToolView, {
      callId: 'wf_call',
      toolName: 'SubagentWorkflow',
      input: { script: '原始脚本内容' },
      result: '原始工作流返回结果',
      status: 'done',
      conversationId: 1,
      siblingCalls: [],
    }),
  )
  assert.ok(!html.includes('class="trace-row"'), '不得渲染未命名默认 div.trace-row')
  assert.ok(html.includes('workflow-trace-row-btn'), '使用 WorkflowToolView 单行按钮')
  assert.ok(html.includes('aria-expanded="false"'), '无 run 时默认收起详情入口')
  assert.ok(!html.includes('Call details') && !html.includes('原始工作流返回结果'), '默认收起时不预先摊开调用详情与原始输出')
})

test('折叠子代理卡：不渲染内联流与展开箭头，整卡通过抽屉查看详情', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: false,
    conversations: [summary(11, 'done')],
    toolSummary: { prompt: '本次原始续接指令', resultText: '本次父工具原始输出' },
  })
  assert.ok(!html.includes('subagent-live-toggle'), '不得渲染折叠展开箭头')
  assert.ok(!html.includes('subagent-live-stream'), '不得内联渲染实时流')
  assert.ok(!html.includes('进入会话'), '不得渲染进入会话页面按钮')
  assert.ok(!html.includes('并排查看'), '卡片不得渲染并排查看按钮')
  assert.doesNotMatch(html, /subagent-split-btn|workbench-split-btn/, '卡片不得包含已移除的并排按钮类名')
  assert.ok(html.includes('Open subagent #11 drawer'), '整卡应带有打开抽屉的可访问性描述')
  assert.ok(html.includes('Click to open the subagent drawer'), '应支持点击卡片打开子会话抽屉')
})

test('SubagentLiveCard 点击契约：头部主体为唯一真实导航按钮，subline 层无割裂交互', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
    conversations: [summary(11, 'done')],
    toolSummary: { prompt: '任务', durationMs: 1000, resultText: '产出结论' },
  })
  assert.ok(html.includes('subagent-card-clickable'), '整卡应具有可点击类名')
  assert.ok(html.includes('<button type="button" class="subagent-live-trigger subagent-card-clickable"'), '整卡主体是真实导航 button')
  assert.ok(html.includes('Open subagent #11 drawer'), '整卡应带有打开抽屉的可访问性描述')
  // 第 1 层（trigger）就是唯一的真实导航按钮；第 2 层（subline）不是交互元素。
  const triggerBtnMatch = html.match(/<button type="button" class="subagent-live-trigger subagent-card-clickable"[^>]*>/)
  assert.ok(triggerBtnMatch !== null, '第 1 层 trigger 为真实导航 button')
  assert.ok(!triggerBtnMatch![0].includes('subagent-live-subline'), '导航按钮不包裹 subline 层')
  assert.ok(!html.includes('<button type="button" class="subagent-live-subline'), '第 2 层不得为独立 button')
})

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u

test('SSR：双层胶囊卡全程无任何 Emoji 或特殊符号字符', { timeout: 60_000 }, () => {
  const samples = [
    renderCard('done', {
      expanded: undefined,
      conversations: [summary(11, 'done')],
      toolSummary: { prompt: '任务', durationMs: 1000, resultText: '结论' },
    }),
    renderCard('running', {
      expanded: true,
      conversations: [summary(11, 'working')],
    }),
    renderCard('running', {
      expanded: undefined,
      conversations: [summary(11, 'blocked')],
    }),
    renderCard('done', {
      expanded: undefined,
      conversations: [summary(11, 'done')],
      loadErrors: { 'conversation:11': '超时' },
    }),
  ]
  for (const html of samples) {
    assert.ok(!EMOJI_RE.test(html), '渲染输出不得包含 Emoji')
    assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸') && !html.includes('⎿'), '不得使用勾叉箭头类特殊符号')
  }
})

test('SubagentLiveCard 与 ExternalRunSummary：任务名称主位展示，#id 与外部代理降级为次级标签且回退不重复 #id', { timeout: 60_000 }, () => {
  // 有任务名时：名称在前（subagent-live-title-text），#11 在后（subagent-live-id），profileId 徽章保留
  const namedHtml = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [{ ...summary(11, 'done'), title: 'subagent 11' }],
  }).renderSsr(
    e(SubagentLiveCard, {
      childConversationId: 11,
      toolStatus: 'done',
      backgroundRun: bgRun({ name: '排查构建失败' }),
    }),
  )
  const titlePos = namedHtml.indexOf('排查构建失败')
  const idPos = namedHtml.indexOf('subagent-live-id')
  assert.ok(titlePos !== -1 && idPos !== -1 && titlePos < idPos, '任务名称必须位于 #11 之前')
  assert.match(namedHtml, /subagent-live-id[^>]*>#<!-- -->11|subagent-live-id[^>]*>#11/)
  assert.ok(namedHtml.includes('>coder<'), '保留 profileId 徽章')

  // 无任何可读名称且会话标题为内核默认 subagent 11：回退 Subagent #11，不得重复渲染 #11
  const fallbackHtml = createWorkflowHostHarness({
    conversationId: 1,
    conversations: [{ ...summary(11, 'done'), title: 'subagent 11' }],
  }).renderSsr(e(SubagentLiveCard, { childConversationId: 11, toolStatus: 'done' }))
  assert.ok(fallbackHtml.includes('Subagent #<!-- -->11') || fallbackHtml.includes('Subagent #11'))
  assert.ok(!fallbackHtml.includes('subagent-live-id'), '回退标题已含 #11 时不得重复渲染 .subagent-live-id')

  // ExternalRunSummary：非占位 run.name 主显，External agent + executionId 作次级徽章
  const extNamed = createWorkflowHostHarness({ conversationId: 1 }).renderSsr(
    e(ExternalRunSummary, {
      run: bgRun({ name: '修复外部测试', status: 'running' }),
      toolStatus: 'running',
      executionId: 'pane-9',
    }),
  )
  assert.ok(extNamed.includes('修复外部测试'))
  assert.ok(extNamed.includes('External agent'))
  assert.ok(extNamed.includes('pane-9'))
  assert.ok(extNamed.indexOf('修复外部测试') < extNamed.indexOf('External agent'))
})

// ---------------------------------------------------------------------------
// 卡片清亮化修正：纯灯主状态 / aborted 语义 / 标题可缩
// ---------------------------------------------------------------------------

test('清亮化修正：后台 run 中止时主状态灯保留 aborted 菱形（不落成普通红灯/灰点）', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
    conversations: [summary(11, 'idle')],
    backgroundRun: bgRun({ status: 'aborted' }),
  })
  assert.ok(html.includes('status-dot-aborted'), 'SubagentLiveCard 中止 run 应渲染 aborted 菱形灯')
  assert.ok(!html.includes('status-dot-error'), 'aborted 不得映射为普通错误红灯')
  assert.ok(html.includes('aria-label="Aborted"') || html.includes('Aborted'), '可访问名称保留中止语义')

  const h2 = createWorkflowHostHarness({ conversationId: 1, conversations: [summary(1, 'idle')] })
  const extHtml = h2.renderSsr(e(ExternalRunSummary, { run: bgRun({ status: 'aborted' }), toolStatus: 'done' }))
  assert.ok(extHtml.includes('status-dot-aborted'), 'ExternalRunSummary 中止 run 应渲染 aborted 菱形灯')
  assert.ok(!extHtml.includes('status-dot-error'), 'ExternalRunSummary aborted 不得映射为普通错误红灯')
})

test('清亮化修正：时间线插件行标题带可缩标记（移动端不再与状态簇相互挤压）', { timeout: 60_000 }, () => {
  const parent = summary(1, 'idle')
  const child11 = { ...summary(11, 'done'), parentConversationId: 1, parentToolCallId: 'call-shrink' }
  const h = createWorkflowHostHarness({ conversationId: 1, conversations: [parent, child11] })
  const html = h.renderSsr(e(SubagentToolView, {
    callId: 'call-shrink',
    toolName: 'subagent',
    input: { prompt: '任务' },
    status: 'done',
    conversationId: 1,
    siblingCalls: [],
  }))
  assert.ok(html.includes('trace-tool-name workflow-trace-name'), '插件行标题带 workflow-trace-name 可缩标记')
})

test('executionLightStatus 精度：后代真实失败不被 run 级中止掩盖，仅自身中止结论显示 aborted 菱形', { timeout: 60_000 }, async () => {
  const { executionLightStatus } = await importWorkflowModels()
  const abortedRun = { status: 'aborted' as const }
  // run 自身中止且无后代失败：error 结论来自自身 abort → aborted 菱形。
  assert.equal(executionLightStatus('error', abortedRun), 'aborted')
  assert.equal(executionLightStatus('error', abortedRun, false), 'aborted')
  // 后代有真实失败：即便 run 也中止，灯保持 error（真实子树失败不得被掩盖）。
  assert.equal(executionLightStatus('error', abortedRun, true), 'error')
  // 非中止来源 / 非错误结论原样透传。
  assert.equal(executionLightStatus('error', { status: 'failed' as const }, true), 'error')
  assert.equal(executionLightStatus('error', undefined, true), 'error')
  assert.equal(executionLightStatus('working', abortedRun, true), 'working')
  assert.equal(executionLightStatus('done', abortedRun), 'done')
})

test('子树进度徽标一级口径：B 卡片只数直接子任务，孙子层不并入分母', { timeout: 60_000 }, () => {
  // B(11) 直接派 C(21)，C 又派 D(31)：B 卡片徽标应为一级 "Subtree 0/1"（旧跨层口径为 0/2）。
  const makeNode = (key: string, status: string, conversationId?: number): ExecutionNode => ({
    key,
    kind: 'conversation',
    status: status as ExecutionNode['status'],
    ...(conversationId !== undefined ? { conversationId } : {}),
    children: [],
    aggregated: { status: status as ExecutionNode['status'], total: 1, done: status === 'done' ? 1 : 0, running: status === 'working' ? 1 : 0, blocked: 0, error: status === 'error' ? 1 : 0 },
    updatedAt: 100,
  })
  const childWithOwnChild: ExecutionNode = {
    ...makeNode('c21', 'working', 21),
    children: [makeNode('c31', 'working', 31)],
    aggregated: { status: 'working', total: 2, done: 0, running: 2, blocked: 0, error: 0 },
  }
  const html = renderCard('running', {
    conversations: [summary(11, 'working')],
    childNodes: [childWithOwnChild],
  })
  assert.ok(html.includes('Subtree 0/1'), `B 卡片进度徽标只数直接子（实际应含 Subtree 0/1）`)
  assert.ok(!html.includes('Subtree 0/2'), '孙子层 D 不得并入 B 卡片的进度分母')
})

test('清亮化终审：自身状态文字移出主头部——灯的可访问名称交代自身状态', { timeout: 60_000 }, () => {
  const html = renderCard('done', {
    expanded: undefined,
    conversations: [summary(11, 'idle')],
    backgroundRun: bgRun({ status: 'completed' }),
    childNodes: [{
      key: 'c1',
      kind: 'conversation',
      status: 'error',
      label: '失败子任务',
      conversationId: 21,
      children: [],
      aggregated: { status: 'error', total: 1, done: 0, running: 0, blocked: 0, error: 1 },
      updatedAt: 100,
    }],
  })
  // 主头部只保留一盏聚合灯；不再有 "Self: ..." 常驻徽章。
  assert.ok(!html.includes('class="badge badge-neutral" title="Run status'), '自身状态不再以常驻徽章摆在头部')
  assert.ok(/aria-label="Self: [^"]+; subtree aggregate:/.test(html), '灯的可访问名称交代自身状态')
})
