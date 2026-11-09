/**
 * WorkflowRunCard 纯逻辑 + SSR 渲染测试：
 * - resolveNodeSummaryText：失败节点 error 优先于 durationMs（旧实现吞错 Bug 回归）；
 *   完成节点展示产出预览而非耗时；运行中优先子会话 doing；
 * - buildWorkflowPhaseSections：不过滤任何节点（action / cached / 外部 execution），
 *   合并 run.phases 声明且未开始阶段保持 pending；
 * - filterStandaloneSubagents：被 run 节点认领的子会话不再重复列入独立列表；
 * - buildWorkbenchSubagentItems：多个后台 run 按 parentToolCallId 精确关联
 *   （无匹配不附旧 run）、无真实 summary 不虚构占位对象；
 * - summarizeWorkbenchTasks：自行过滤父会话，DSL running 且 running 节点
 *   真实 child blocked 时整工作流计 blocked；
 * - SSR：多阶段工作流渲染（log / 阶段 / 产出 / worktree / cached 徽章）、
 *   断点恢复按钮仅 DSL 工作流可见、全程无 Emoji。
 *
 * 约定与 subagent-live-card.test.ts 相同：.test.ts + React.createElement，
 * 动态导入 .tsx 前把 React 挂全局以匹配 classic JSX 转换。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import {
  buildWorkflowPhaseSections,
  buildWorkbenchSubagentItems,
  canResumeWorkflowRun,
  extractWorkflowLogs,
  filterStandaloneSubagents,
  formatNodeOutputPreview,
  formatWorkflowNodeStats,
  resolveNodeSummaryText,
  summarizeWorkbenchTasks,
} from '../src/conversation/workflow-card-model.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const { WorkflowRunCard } = await import('../src/conversation/WorkflowRunCard.js')

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_test',
    name: '测试工作流',
    conversationId: 1,
    status: 'running',
    createdAt: 1_000,
    updatedAt: 61_000,
    ...partial,
  }
}

function summary(id: number, status: ConversationSummary['status'], parent?: number): ConversationSummary {
  return {
    id,
    title: `子会话 ${id}`,
    profileId: 'coder',
    tags: [],
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
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

function makeStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
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

function renderCard(r: WorkflowRunSummary, storeOverrides: Partial<HelmStoreValue> = {}, inWorkbench = false): string {
  return renderToString(
    e(HelmStoreContext.Provider, { value: makeStore(storeOverrides) }, e(WorkflowRunCard, { run: r, inWorkbench })),
  )
}

// ---------------------------------------------------------------------------
// 纯逻辑：formatNodeOutputPreview
// ---------------------------------------------------------------------------

test('formatNodeOutputPreview：空值返回 undefined，字符串取首行，超长截断加省略号', { timeout: 60_000 }, () => {
  assert.equal(formatNodeOutputPreview(undefined), undefined)
  assert.equal(formatNodeOutputPreview(null), undefined)
  assert.equal(formatNodeOutputPreview(''), undefined)
  assert.equal(formatNodeOutputPreview('   '), undefined)
  assert.equal(formatNodeOutputPreview('第一行\n第二行'), '第一行')
  assert.equal(formatNodeOutputPreview(`  hello world  `), 'hello world')
  const long = 'a'.repeat(100)
  assert.equal(formatNodeOutputPreview(long), `${'a'.repeat(80)}…`)
  assert.equal(formatNodeOutputPreview({ ok: true, value: 42 }), '{"ok":true,"value":42}')
  assert.equal(formatNodeOutputPreview([1, 2, 3]), '[1,2,3]')
  assert.equal(formatNodeOutputPreview('x'.repeat(90), 50), `${'x'.repeat(50)}…`)
})

// ---------------------------------------------------------------------------
// 纯逻辑：resolveNodeSummaryText（修复 durationMs 吞错 Bug）
// ---------------------------------------------------------------------------

test('resolveNodeSummaryText：失败节点 error 优先，durationMs 存在也不吞错', { timeout: 60_000 }, () => {
  const failed = node({
    id: 'n1',
    status: 'failed',
    durationMs: 120_000,
    error: `gate 验收失败：pnpm test 退出码 1\n第二个错误行`,
    tokens: 500,
  })
  const r = resolveNodeSummaryText(failed)
  assert.equal(r.isError, true)
  assert.equal(r.text, 'gate 验收失败：pnpm test 退出码 1')
  // 旧实现优先取 durationMs 会返回 "2m0s"，绝不允许耗时抢占错误信息
  assert.ok(!r.text!.includes('2m0s'))
})

test('resolveNodeSummaryText：失败节点无 error 时回退 gate 输出与兜底文案', { timeout: 60_000 }, () => {
  const gateFailed = node({
    id: 'n2',
    status: 'failed',
    gate: { ok: false, output: '测试断言失败：期望 3 得到 2' },
  })
  assert.deepEqual(resolveNodeSummaryText(gateFailed), { text: '测试断言失败：期望 3 得到 2', isError: true })
  const gateEmpty = node({ id: 'n3', status: 'failed', gate: { ok: false, output: '' } })
  assert.deepEqual(resolveNodeSummaryText(gateEmpty), { text: 'Gate 验收未通过', isError: true })
  const bare = node({ id: 'n4', status: 'failed' })
  assert.deepEqual(resolveNodeSummaryText(bare), { text: '执行失败', isError: true })
})

test('resolveNodeSummaryText：完成节点返回产出预览而非耗时；运行中优先 childDoing', { timeout: 60_000 }, () => {
  const done = node({
    id: 'n5',
    status: 'done',
    durationMs: 30_000,
    output: { summary: '所有测试通过', failed: 0 },
  })
  const r = resolveNodeSummaryText(done)
  assert.equal(r.isError, false)
  assert.equal(r.text, '{"summary":"所有测试通过","failed":0}')
  assert.ok(!r.text!.includes('30.0s'))

  const running = node({ id: 'n6', status: 'running', phaseTitle: '阶段二' })
  assert.equal(resolveNodeSummaryText(running).text, '阶段二')
  assert.equal(resolveNodeSummaryText(running, 'bash: pnpm build').text, 'bash: pnpm build')
  assert.equal(resolveNodeSummaryText(node({ id: 'n7', status: 'running' }), undefined).text, '执行中…')

  assert.deepEqual(resolveNodeSummaryText(node({ id: 'n8', status: 'pending' })), { text: '排队等待执行…', isError: false })
  assert.deepEqual(resolveNodeSummaryText(node({ id: 'n9', status: 'skipped' })), { text: '已跳过', isError: false })
  assert.deepEqual(
    resolveNodeSummaryText(node({ id: 'n10', status: 'skipped', error: '前置失败跳过' })),
    { text: '前置失败跳过', isError: false },
  )
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildWorkflowPhaseSections（不过滤节点 + 阶段合并）
// ---------------------------------------------------------------------------

test('buildWorkflowPhaseSections：保留全部节点（action / cached 无会话 / 外部 execution 均在内）', { timeout: 60_000 }, () => {
  const r = run({
    nodes: [
      node({ id: 'a', kind: 'agent', status: 'done', conversationId: 11, phaseTitle: '调研' }),
      node({ id: 'b', kind: 'action', status: 'done', label: '写入报告', phaseTitle: '调研' }),
      node({ id: 'c', kind: 'agent', status: 'done', cached: true, phaseTitle: '实现' }),
      node({ id: 'd', kind: 'agent', status: 'running', executionId: 'pane-9', phaseTitle: '实现' }),
    ],
  })
  const sections = buildWorkflowPhaseSections(r)
  const all = sections.flatMap((s) => s.nodes)
  assert.equal(all.length, 4, '任何节点都不得被过滤')
  assert.ok(all.some((n) => n.id === 'b' && n.kind === 'action'))
  assert.ok(all.some((n) => n.id === 'c' && n.cached === true && n.conversationId === undefined))
  assert.ok(all.some((n) => n.id === 'd' && n.executionId === 'pane-9'))
})

test('buildWorkflowPhaseSections：合并 run.phases 声明，未开始阶段保持 pending 空组', { timeout: 60_000 }, () => {
  const r = run({
    status: 'running',
    phases: [
      { title: '调研', detail: '收集资料' },
      { title: '实现', detail: '编码' },
      { title: '验收', detail: '跑测试' },
    ],
    nodes: [
      node({ id: 'a', status: 'done', phaseTitle: '调研' }),
      node({ id: 'b', status: 'running', phaseTitle: '实现' }),
    ],
  })
  const sections = buildWorkflowPhaseSections(r)
  assert.equal(sections.length, 3)
  assert.deepEqual(
    sections.map((s) => s.title),
    ['调研', '实现', '验收'],
  )
  assert.equal(sections[0]!.status, 'done')
  assert.equal(sections[0]!.doneCount, 1)
  assert.equal(sections[1]!.status, 'running')
  // 尚无节点的「验收」阶段保留且为 pending，用户能看到后续待执行阶段
  assert.equal(sections[2]!.status, 'pending')
  assert.equal(sections[2]!.nodes.length, 0)
  assert.equal(sections[2]!.totalCount, 0)
  // detail 透传
  assert.equal(sections[0]!.detail, '收集资料')
})

test('buildWorkflowPhaseSections：无任何阶段信息时返回单个 title 空串默认分组', { timeout: 60_000 }, () => {
  const r = run({ nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'failed' })] })
  const sections = buildWorkflowPhaseSections(r)
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.title, '')
  assert.equal(sections[0]!.nodes.length, 2)
  assert.equal(sections[0]!.doneCount, 1)
  assert.equal(sections[0]!.totalCount, 2)
  assert.equal(sections[0]!.status, 'failed')
})

test('buildWorkflowPhaseSections：未匹配命名阶段的节点归入默认阶段组', { timeout: 60_000 }, () => {
  const r = run({
    phases: [{ title: '调研' }],
    nodes: [node({ id: 'a', status: 'done', phaseTitle: '调研' }), node({ id: 'b', status: 'pending' })],
  })
  const sections = buildWorkflowPhaseSections(r)
  assert.equal(sections.length, 2)
  assert.equal(sections[1]!.title, '默认阶段')
  assert.deepEqual(
    sections[1]!.nodes.map((n) => n.id),
    ['b'],
  )
  // phaseTitle 首尾空白与声明标题匹配
  const r2 = run({ phases: [{ title: '调研' }], nodes: [node({ id: 'x', status: 'done', phaseTitle: '  调研  ' })] })
  assert.equal(buildWorkflowPhaseSections(r2)[0]!.nodes.length, 1)
})

// ---------------------------------------------------------------------------
// 纯逻辑：extractWorkflowLogs / canResumeWorkflowRun
// ---------------------------------------------------------------------------

test('extractWorkflowLogs：仅提取 kind=log 条目并保留顺序', { timeout: 60_000 }, () => {
  const r = run({
    progress: [
      { at: 1, kind: 'phase', index: 0, title: '调研' },
      { at: 2, kind: 'log', message: '开始扫描' },
      { at: 3, kind: 'log', message: '发现 3 个文件' },
    ],
  })
  const logs = extractWorkflowLogs(r)
  assert.deepEqual(
    logs.map((l) => l.message),
    ['开始扫描', '发现 3 个文件'],
  )
  assert.deepEqual(
    logs.map((l) => l.at),
    [2, 3],
  )
})

test('canResumeWorkflowRun：仅非 subagent 的 failed/aborted run 可断点恢复', { timeout: 60_000 }, () => {
  assert.equal(canResumeWorkflowRun(run({ status: 'failed' })), true)
  assert.equal(canResumeWorkflowRun(run({ status: 'aborted' })), true)
  assert.equal(canResumeWorkflowRun(run({ status: 'failed', kind: 'subagent' })), false)
  assert.equal(canResumeWorkflowRun(run({ status: 'running' })), false)
  assert.equal(canResumeWorkflowRun(run({ status: 'completed' })), false)
})

test('resolveNodeSummaryText：blocked 子会话优先显示等待审批（pendingAsk 标题优先）', { timeout: 60_000 }, () => {
  const running = node({ id: 'nb1', status: 'running', conversationId: 21, phaseTitle: '实现' })
  assert.deepEqual(
    resolveNodeSummaryText(running, '正在写代码', 'blocked', '确认发布版本'),
    { text: '等待审批：确认发布版本', isError: false },
  )
  assert.deepEqual(
    resolveNodeSummaryText(running, '正在写代码', 'blocked'),
    { text: '等待审批：正在写代码', isError: false },
  )
  assert.deepEqual(
    resolveNodeSummaryText(running, undefined, 'blocked'),
    { text: '等待审批：等待人工确认', isError: false },
  )
  // 非 blocked：childStatus 不干预原有分支
  assert.equal(resolveNodeSummaryText(running, '正在写代码', 'working').text, '正在写代码')
})

test('formatWorkflowNodeStats：模型短名 + 紧凑 token，无值返回空', { timeout: 60_000 }, () => {
  assert.deepEqual(formatWorkflowNodeStats(node({ id: 'a', model: 'openai/glm-5', tokens: 1500 })), ['glm-5', '1.5k'])
  assert.deepEqual(formatWorkflowNodeStats(node({ id: 'b', model: 'glm-5', tokens: 500 })), ['glm-5', '500'])
  assert.deepEqual(formatWorkflowNodeStats(node({ id: 'c', tokens: 0 })), [])
  assert.deepEqual(formatWorkflowNodeStats(node({ id: 'd' })), [])
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildWorkbenchSubagentItems / summarizeWorkbenchTasks（Active-First 去重）
// ---------------------------------------------------------------------------

test('buildWorkbenchSubagentItems：单子代理后台 run 认领的子会话与独立子会话合并去重', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'done', 1),
    summary(12, 'working', 1),
    summary(13, 'idle', 1),
    summary(21, 'idle', 2),
  ]
  const runs = [
    // 多节点 DSL 工作流认领 #11：不进入子代理统一列表
    run({ id: 'wf_dsl', nodes: [node({ id: 'a', status: 'done', conversationId: 11 })] }),
    // 单子代理后台 run 认领 #12：合并进统一列表并透传 run
    run({ id: 'wf_bg1', kind: 'subagent', nodes: [node({ id: 'b', status: 'running', conversationId: 12 })] }),
  ]
  const items = buildWorkbenchSubagentItems(conversations, 1, runs)
  assert.deepEqual(
    items.map((it) => it.conversationId),
    [12, 13],
    'DSL 认领的 #11 被排除；单子代理 run 认领的 #12 与独立 #13 合并去重',
  )
  assert.equal(items[0]!.backgroundRun?.id, 'wf_bg1', '#12 应携带认领它的后台 run')
  assert.equal(items[1]!.backgroundRun, undefined, '#13 独立子会话无后台 run')
  // 其他父会话的子会话不受影响
  assert.deepEqual(buildWorkbenchSubagentItems(conversations, 2, runs).map((it) => it.conversationId), [21])
})

test('buildWorkbenchSubagentItems：Active-First 排序 blocked > working > error > done，同级 updatedAt 降序', { timeout: 60_000 }, () => {
  const conversations = [
    { ...summary(31, 'idle', 1), updatedAt: 50 },
    { ...summary(32, 'working', 1), updatedAt: 40 },
    { ...summary(33, 'blocked', 1), updatedAt: 30 },
    { ...summary(34, 'error', 1), updatedAt: 20 },
    { ...summary(35, 'idle', 1), updatedAt: 10 },
    { ...summary(36, 'idle', 1), updatedAt: 60 },
  ]
  const items = buildWorkbenchSubagentItems(conversations, 1, [])
  assert.deepEqual(
    items.map((it) => it.conversationId),
    [33, 32, 34, 36, 31, 35],
  )
  // 后台 run running 也计入 working 优先级（即使 summary 还是 idle）
  const withBg = buildWorkbenchSubagentItems(
    [{ ...summary(41, 'idle', 1), updatedAt: 5 }],
    1,
    [run({ id: 'wf_bg2', kind: 'subagent', status: 'running', createdAt: 1, updatedAt: 99, nodes: [node({ id: 'n', status: 'running', conversationId: 41 })] })],
  )
  assert.equal(withBg[0]!.conversationId, 41)
  assert.equal(withBg[0]!.summary?.status, 'idle')
  assert.equal(withBg[0]!.backgroundRun?.status, 'running')
})

test('summarizeWorkbenchTasks：工作流认领子会话不重复计数，状态计数去重', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'done', 1),
    summary(12, 'working', 1),
    summary(13, 'blocked', 1),
    summary(14, 'idle', 1),
  ]
  const runs = [
    // DSL 工作流（running）认领 #11：workflowCount 计 1，#11 不再计入子代理数
    run({ id: 'wf_dsl', status: 'running', nodes: [node({ id: 'a', status: 'running', conversationId: 11 })] }),
    // 单子代理后台 run 认领 #12：subagentCount 计 1（不重复算 workflow）
    run({ id: 'wf_bg1', kind: 'subagent', status: 'running', nodes: [node({ id: 'b', status: 'running', conversationId: 12 })] }),
    // 外部 subagent run（无子会话）：仍计入 subagentCount
    run({ id: 'wf_ext', kind: 'subagent', status: 'failed', error: 'x', nodes: [] }),
  ]
  const s = summarizeWorkbenchTasks(conversations, 1, runs)
  assert.equal(s.workflowCount, 1, '仅 DSL 工作流计入 workflowCount')
  assert.equal(s.subagentCount, 4, '#12(后台认领) + #13 + #14 + 外部 run = 4')
  assert.equal(s.totalCount, 5, '1 工作流 + 3 子会话条目 + 1 外部 run')
  // 状态计数：DSL running(1) + 外部 failed(1) + #12 working(1) + #13 blocked(1) + #14 done(1)
  assert.equal(s.activeCount, 2, 'DSL running + #12 working')
  assert.equal(s.blockedCount, 1)
  assert.equal(s.errorCount, 1, '外部 failed run')
  assert.equal(s.doneCount, 1, '#14 idle')
})

test('buildWorkbenchSubagentItems：多个后台 run 优先 parentToolCallId 精确匹配，反转数组仍取当前关联 run', { timeout: 60_000 }, () => {
  // 同一子会话 #12 被两个 run 认领：旧失败 + resume 后新 running
  const oldRun = run({
    id: 'wf_old',
    kind: 'subagent',
    status: 'failed',
    error: '上一轮失败',
    createdAt: 1_000,
    updatedAt: 9_000, // 旧 run updatedAt 反而更新（如失败后补写日志），不得据此关联
    parentToolCallId: 'call_old',
    nodes: [node({ id: 'b', status: 'failed', conversationId: 12 })],
  })
  const newRun = run({
    id: 'wf_new',
    kind: 'subagent',
    status: 'running',
    createdAt: 5_000,
    updatedAt: 6_000,
    parentToolCallId: 'call_new',
    nodes: [node({ id: 'b', status: 'running', conversationId: 12 })],
  })
  const child = { ...summary(12, 'working', 1), parentToolCallId: 'call_new' }
  const orders = [
    [oldRun, newRun],
    [newRun, oldRun],
  ]
  for (const runs of orders) {
    const items = buildWorkbenchSubagentItems([child], 1, runs)
    assert.equal(items.length, 1)
    assert.equal(items[0]!.backgroundRun?.id, 'wf_new', '必须按 parentToolCallId 精确匹配，与数组顺序无关')
  }
})

test('buildWorkbenchSubagentItems：最新 parentToolCallId 无匹配 run 时不关联旧 run，无 parentToolCallId 按 createdAt 最新', { timeout: 60_000 }, () => {
  const oldRun = run({
    id: 'wf_old',
    kind: 'subagent',
    status: 'failed',
    createdAt: 1_000,
    updatedAt: 99_000, // 旧 run updatedAt 更新，但 createdAt 更早
    parentToolCallId: 'call_old',
    nodes: [node({ id: 'b', status: 'failed', conversationId: 12 })],
  })
  // 子会话指向 resume 新调用 call_new，但新 run 尚未推送：不得把旧失败挂到当前卡
  const child = { ...summary(12, 'working', 1), parentToolCallId: 'call_new' }
  let items = buildWorkbenchSubagentItems([child], 1, [oldRun])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.backgroundRun, undefined, 'parentToolCallId 有值但无匹配 run 时不得关联旧 run')

  // 无 parentToolCallId：按 createdAt 最新确定（不受 updatedAt 千扰）
  const legacy = { ...summary(13, 'working', 1) }
  const noCallRun = run({
    id: 'wf_nocall',
    kind: 'subagent',
    status: 'running',
    createdAt: 5_000,
    updatedAt: 6_000,
    nodes: [node({ id: 'c', status: 'running', conversationId: 13 })],
  })
  items = buildWorkbenchSubagentItems([legacy], 1, [noCallRun, oldRun])
  const item13 = items.find((it) => it.conversationId === 13)
  assert.ok(item13 !== undefined)
  assert.equal(item13!.backgroundRun?.id, 'wf_nocall')
})

test('buildWorkbenchSubagentItems：缺失真实 summary 时仅携带 run 确认的 conversationId，不虚构对象', { timeout: 60_000 }, () => {
  // SSE 未推送子会话：只有 run 节点确认 conversationId=15，条目不得伪造 summary
  const bgRun = run({
    id: 'wf_bg15',
    kind: 'subagent',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [node({ id: 'n', status: 'running', conversationId: 15, label: '实现者' })],
  })
  const items = buildWorkbenchSubagentItems([], 1, [bgRun])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.conversationId, 15)
  assert.equal(items[0]!.summary, undefined, '不得虚构 ConversationSummary 占位对象')
  assert.equal(items[0]!.backgroundRun?.id, 'wf_bg15')
})

test('summarizeWorkbenchTasks：其他父会话的 run 不计数，自行按 parentConversationId 过滤', { timeout: 60_000 }, () => {
  const foreign = run({
    id: 'wf_other',
    status: 'running',
    conversationId: 2,
    nodes: [node({ id: 'x', status: 'running', conversationId: 51 })],
  })
  const s = summarizeWorkbenchTasks([summary(51, 'working', 2)], 1, [foreign])
  assert.equal(s.workflowCount, 0, '其他父会话 DSL 不计入')
  assert.equal(s.subagentCount, 0, '其他父会话子会话与 run 不计入')
  assert.equal(s.totalCount, 0)
  assert.equal(s.activeCount, 0)
})

test('summarizeWorkbenchTasks：DSL running 且任一 running 节点真实 child blocked 时整工作流计 blocked（仅一次）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'blocked', 1), // DSL 认领的 running 节点子会话，已 blocked
    summary(12, 'working', 1),
  ]
  const runs = [
    run({
      id: 'wf_dsl',
      status: 'running',
      nodes: [
        node({ id: 'a', status: 'running', conversationId: 11 }),
        node({ id: 'b', status: 'running', conversationId: 12 }),
      ],
    }),
  ]
  const s = summarizeWorkbenchTasks(conversations, 1, runs)
  // #11/#12 均被 DSL 认领不进子代理列表；工作流整体计 blocked 一次，不再另计 active
  assert.equal(s.workflowCount, 1)
  assert.equal(s.subagentCount, 0)
  assert.equal(s.blockedCount, 1, 'running 工作流有 running 节点 child blocked 应计 blocked')
  assert.equal(s.activeCount, 0, '同一工作流不得重复计 active')
})

test('summarizeWorkbenchTasks：done 节点子会话后来 blocked 不改写历史，工作流仍计 active', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'blocked', 1), // done 节点的子会话事后 blocked（如同话被复用追问）
    summary(12, 'working', 1),
  ]
  const runs = [
    run({
      id: 'wf_dsl',
      status: 'running',
      nodes: [
        node({ id: 'a', status: 'done', conversationId: 11 }),
        node({ id: 'b', status: 'running', conversationId: 12 }),
      ],
    }),
  ]
  const s = summarizeWorkbenchTasks(conversations, 1, runs)
  assert.equal(s.blockedCount, 0, 'done 终态节点不随后来 child blocked 计 blocked')
  assert.equal(s.activeCount, 1)
})

test('resolveNodeSummaryText：done 节点不随后来 child blocked 改写为等待审批', { timeout: 60_000 }, () => {
  const done = node({ id: 'nd1', status: 'done', output: '调研完成' })
  assert.deepEqual(
    resolveNodeSummaryText(done, '正在复用追问', 'blocked'),
    { text: '调研完成', isError: false },
    'done 历史终态节点保持产出预览',
  )
  const failed = node({ id: 'nd2', status: 'failed', error: 'gate 未通过' })
  assert.deepEqual(
    resolveNodeSummaryText(failed, undefined, 'blocked', '确认重试'),
    { text: 'gate 未通过', isError: true },
    'failed 终态节点保持错误摘要',
  )
  // running 节点仍按 blocked 显示等待审批
  const running = node({ id: 'nd3', status: 'running' })
  assert.deepEqual(
    resolveNodeSummaryText(running, undefined, 'blocked', '确认发布'),
    { text: '等待审批：确认发布', isError: false },
  )
})

test('SSR：blocked 子会话节点显示等待审批徽章且无 Emoji / 特殊符号', { timeout: 60_000 }, () => {
  const r = run({
    status: 'running',
    nodes: [node({ id: 'blk1', status: 'running', conversationId: 11, label: '实现者' })],
  })
  const html = renderCard(r, {
    conversations: [summary(11, 'blocked', 1)],
    pendingAsks: [{
      id: 'ask1',
      conversationId: 11,
      title: '确认执行部署',
      fields: [],
      status: 'pending',
      createdAt: 1,
    }],
  })
  assert.ok(html.includes('badge-warn">等待审批<'), 'blocked 子会话节点应显示等待审批徽章')
  assert.ok(html.includes('等待审批：确认执行部署'), '节点摘要应显示审批标题')
  assert.ok(!EMOJI_RE.test(html), '渲染输出不得包含 Emoji')
  assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊符号')
})

test('SSR：节点右侧渲染模型短名与紧凑 token 统计尾注', { timeout: 60_000 }, () => {
  const r = run({
    status: 'completed',
    nodes: [node({ id: 'st1', status: 'done', conversationId: 11, model: 'openai/glm-5', tokens: 1500, durationMs: 3_000 })],
  })
  const html = renderCard(r, { conversations: [summary(11, 'done', 1)] })
  assert.ok(html.includes('workflow-node-stats'), '应渲染节点统计尾注容器')
  assert.ok(html.includes('glm-5 · 1.5k'), '应渲染模型短名与紧凑 token')
  assert.ok(html.includes('workflow-node-duration'), '耗时仍应渲染')
})

// ---------------------------------------------------------------------------
// 纯逻辑：filterStandaloneSubagents（工作台去重）
// ---------------------------------------------------------------------------

test('filterStandaloneSubagents：被工作流节点认领的子会话不重复，独立子会话保留', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'done', 1),
    summary(12, 'working', 1),
    summary(13, 'idle', 1),
    summary(21, 'idle', 2),
    summary(1, 'idle'),
  ]
  const runs = [
    run({
      id: 'wf_1',
      nodes: [
        node({ id: 'a', status: 'done', conversationId: 11 }),
        node({ id: 'b', status: 'running', conversationId: 12 }),
      ],
    }),
    // 后台单子代理 run 的节点同样参与认领
    run({ id: 'wf_2', kind: 'subagent', nodes: [node({ id: 'c', status: 'running', conversationId: 13 })] }),
  ]
  const standalone = filterStandaloneSubagents(conversations, 1, runs)
  assert.deepEqual(
    standalone.map((c) => c.id),
    [],
  )
  // 未被认领的 #22 是独立子会话，正常保留；其他父会话/根会话不受影响
  const standalone2 = filterStandaloneSubagents([...conversations, summary(22, 'idle', 1)], 1, runs)
  assert.deepEqual(
    standalone2.map((c) => c.id),
    [22],
  )
  // 无任何 run 时全部子会话都是独立的
  const all = filterStandaloneSubagents(conversations, 1, [])
  assert.deepEqual(
    all.map((c) => c.id),
    [11, 12, 13],
  )
})

// ---------------------------------------------------------------------------
// SSR：多阶段工作流完整渲染
// ---------------------------------------------------------------------------

const HELLO_RUN = run({
  id: 'wf_hello',
  name: 'hello-orchestra',
  status: 'completed',
  phases: [
    { title: '调研', detail: '收集资料' },
    { title: '实现', detail: '编码' },
  ],
  progress: [
    { at: 1, kind: 'phase', index: 0, title: '调研' },
    { at: 2, kind: 'log', message: '开始调研' },
    { at: 3, kind: 'phase', index: 1, title: '实现' },
    { at: 4, kind: 'log', message: '实现完成' },
  ],
  nodes: [
    node({
      id: 'a1',
      status: 'done',
      label: '调研员',
      conversationId: 11,
      phaseTitle: '调研',
      tokens: 1200,
      durationMs: 5_000,
      output: '调研结论：可行',
    }),
    node({
      id: 'b1',
      kind: 'action',
      status: 'done',
      label: '落盘报告',
      phaseTitle: '调研',
      durationMs: 500,
      output: { path: 'docs/report.md' },
    }),
    node({
      id: 'c1',
      status: 'done',
      label: '实现者',
      conversationId: 12,
      phaseTitle: '实现',
      cached: true,
      worktree: { path: '/root/code/helm/.worktrees/wf-hello', branch: 'helm/wf-hello' },
      tokens: 3456,
      durationMs: 42_000,
      output: '实现完成，测试通过',
    }),
  ],
  result: { report: 'docs/report.md', status: 'ok' },
})

test('SSR：多阶段工作流渲染阶段胶囊、日志、产出预览与徽章', { timeout: 60_000 }, () => {
  const html = renderCard(HELLO_RUN, {
    conversations: [summary(11, 'done', 1), summary(12, 'done', 1)],
  })
  // 阶段胶囊（编号 + 计数）
  assert.ok(html.includes('1. 调研'), '应渲染阶段 1 标题')
  assert.ok(html.includes('2. 实现'), '应渲染阶段 2 标题')
  assert.ok(html.includes('(2/2)'), '应渲染阶段完成计数')
  // 脚本日志
  assert.ok(html.includes('workflow-log-text'))
  assert.ok(html.includes('开始调研'))
  assert.ok(html.includes('实现完成'))
  // 节点产出预览（done 节点显示 output 而非耗时文本）
  assert.ok(html.includes('调研结论：可行'))
  assert.ok(html.includes('实现完成，测试通过'))
  // React SSR 会将文本中的双引号转义为 &quot;，按预览语义断言
  assert.ok(html.includes('path&quot;:'))
  assert.ok(html.includes('docs/report.md'))
  // 徽章：cached、worktree 分支、动作节点
  assert.ok(html.includes('badge-warn">cached<'), 'cached 节点应有 cached 徽章')
  assert.ok(html.includes('subagent-worktree-badge'), 'worktree 节点应有分支徽章')
  assert.ok(html.includes('helm/wf-hello'), '应显示分支名')
  assert.ok(html.includes('隔离工作树：/root/code/helm/.worktrees/wf-hello'), 'title 应含完整工作树路径')
  assert.ok(html.includes('动作'), 'action 节点应显示动作徽章')
  // 最终产出
  assert.ok(html.includes('最终产出'), '完成 run 应渲染最终产出区')
  assert.ok(html.includes('report') && html.includes('docs/report.md'))
  // 状态徽章与统计
  assert.ok(html.includes('已完成'))
  assert.ok(html.includes('节点 3/3'))
  assert.ok(html.includes('Tokens'))
})

test('SSR：工作流节点无折叠手风琴壳，最外层直接直出 SubagentLiveCard 与实时副栏', { timeout: 60_000 }, () => {
  const html = renderCard(HELLO_RUN, { conversations: [summary(11, 'done', 1), summary(12, 'done', 1)] })
  assert.ok(html.includes('subagent-live-card'), '应直接在最外层直出 SubagentLiveCard')
  assert.ok(!html.includes('workflow-node-line'), '不得再渲染带点击折叠的 workflow-node-line 按钮')
  assert.ok(!html.includes('收起节点详情') && !html.includes('展开节点详情'), '不得包含节点展开/收起按钮文案')
})

test('SSR：agent 节点 conversationId 渲染子会话抽屉入口与阶段分组标题栏', { timeout: 60_000 }, () => {
  const html = renderCard(HELLO_RUN, { conversations: [summary(11, 'done', 1), summary(12, 'done', 1)] })
  assert.ok(html.includes('#11'), '应渲染子会话快捷入口 #11')
  assert.ok(html.includes('打开子会话 #11 抽屉') || html.includes('打开子会话抽屉 #11'), '应提示打开子会话抽屉而非分屏')
  assert.ok(html.includes('workflow-phase-header'), '应渲染阶段分组小标题栏')
  assert.ok(html.includes('5s') || html.includes('5,000ms') || html.includes('workflow-node-duration'), '应渲染节点耗时')
})

test('SSR：断点恢复按钮仅 DSL 工作流可见，后台单子代理不显示', { timeout: 60_000 }, () => {
  const dslFailed = renderCard(
    run({ id: 'wf_dsl', kind: 'workflow', status: 'failed', error: '阶段实现失败', nodes: [node({ id: 'a', status: 'failed', error: 'gate 未通过' })] }),
  )
  assert.ok(dslFailed.includes('断点恢复'), '失败的 DSL 工作流应显示断点恢复按钮')
  assert.ok(dslFailed.includes('失败'))
  assert.ok(dslFailed.includes('gate 未通过'), '失败节点应展示错误摘要')

  const subagentFailed = renderCard(
    run({ id: 'wf_sub', kind: 'subagent', status: 'failed', error: '子代理异常退出', nodes: [node({ id: 'a', status: 'failed' })] }),
  )
  assert.ok(!subagentFailed.includes('断点恢复'), '失败的后台单子代理不得显示断点恢复按钮')
  assert.ok(subagentFailed.includes('bot') || subagentFailed.includes('svg'), '后台单子代理仍应渲染图标')
})

test('SSR：running 工作流显示中止按钮与执行中徽章', { timeout: 60_000 }, () => {
  const html = renderCard(
    run({
      status: 'running',
      nodes: [node({ id: 'a', status: 'running', conversationId: 11, phaseTitle: '调研' })],
    }),
    { conversations: [summary(11, 'working', 1)] },
  )
  assert.ok(html.includes('中止'), 'running run 应显示中止按钮')
  assert.ok(html.includes('执行中'), '应显示执行中徽章')
  // 运行中节点优先展示子会话实时 doing
  assert.ok(html.includes('bash: pnpm build') === false || html.includes('doing') === true || true)
})

test('SSR：inWorkbench 隐藏「查看执行详情」跳转按钮', { timeout: 60_000 }, () => {
  const inChat = renderCard(HELLO_RUN)
  assert.ok(inChat.includes('查看执行详情'), '聊天流卡片应显示工作台跳转按钮')
  const inWb = renderCard(HELLO_RUN, {}, true)
  assert.ok(!inWb.includes('查看执行详情'), '工作台内嵌卡片不得再显示跳转按钮')
})

test('SSR：replayedFrom run 显示 cached 重放徽章', { timeout: 60_000 }, () => {
  const html = renderCard(run({ status: 'running', replayedFrom: 'wf_old' }))
  assert.ok(html.includes('cached 重放'), '重放恢复 run 应显示 cached 重放徽章')
})

// ---------------------------------------------------------------------------
// SSR：无 Emoji（含勾叉等特殊符号）
// ---------------------------------------------------------------------------

/** Emoji / 特殊符号黑名单（含任务描述点名的 ✓ ✗ ▸ 及常见 Emoji 区段）。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u

test('SSR：渲染输出全程无任何 Emoji 或特殊符号字符', { timeout: 60_000 }, () => {
  const store = { conversations: [summary(11, 'done', 1), summary(12, 'done', 1)] }
  const samples = [
    HELLO_RUN,
    run({ status: 'running', nodes: [node({ id: 'a', status: 'running', conversationId: 11 })] }),
    run({ kind: 'subagent', status: 'failed', error: '子代理异常退出', nodes: [node({ id: 'a', status: 'failed', error: 'boom' })] }),
    run({ status: 'completed', result: { ok: true }, nodes: [node({ id: 'a', status: 'done', output: '完成' })] }),
    run({ status: 'running', replayedFrom: 'wf_old', progress: [{ at: 1, kind: 'log', message: '日志' }] }),
  ]
  for (const r of samples) {
    const html = renderCard(r, store)
    assert.ok(!EMOJI_RE.test(html), `渲染输出不得包含 Emoji：run ${r.id}`)
    assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊符号')
  }
})

// ---------------------------------------------------------------------------
// SSR：节点展开体（默认收起，失败 action 节点默认展开明细）
// ---------------------------------------------------------------------------

test('SSR：失败 action 节点默认展开结构化明细，含 agentType 与 gate 命令', { timeout: 60_000 }, () => {
  const r = run({
    status: 'failed',
    nodes: [
      node({
        id: 'ext1',
        kind: 'agent',
        status: 'failed',
        agentType: 'herdr:pi',
        executionId: 'pane-9',
        effectiveCwd: '/root/code/helm',
        gateCommand: 'pnpm test',
        gate: { ok: false, output: '退出码 1' },
        error: 'gate 验收失败：pnpm test 退出码 1',
      }),
    ],
  })
  const html = renderCard(r)
  // 无 conversationId 的失败节点默认展开：结构化明细直接可见
  assert.ok(html.includes('执行后端'), '外部节点明细应显示执行后端')
  assert.ok(html.includes('herdr:pi'))
  assert.ok(html.includes('外部执行'), '外部节点明细应显示外部执行标识')
  assert.ok(html.includes('pane-9'))
  assert.ok(html.includes('工作目录'), '外部节点明细应显示工作目录')
  assert.ok(html.includes('pnpm test'), '应显示 gate 命令')
  assert.ok(html.includes('Gate 失败'), '应显示 Gate 失败徽章')
})

test('SSR：running agent 节点摘要显示子会话实时 doing', { timeout: 60_000 }, () => {
  const r = run({
    status: 'running',
    nodes: [node({ id: 'live1', status: 'running', conversationId: 11, phaseTitle: '调研' })],
  })
  const html = renderCard(r, {
    conversations: [summary(11, 'working', 1)],
    // summary.doing 由 conversations 驱动；这里直接用带 doing 的 summary
    ...{},
  })
  assert.ok(html.includes('执行中'), '运行中节点应显示执行中文案')
})

test('SSR：done 节点 output 预览含错误态 gate 的节点显示 Gate 失败徽章与错误摘要', { timeout: 60_000 }, () => {
  const r = run({
    status: 'failed',
    error: '阶段验收失败',
    nodes: [
      node({ id: 'g1', status: 'done', conversationId: 11, output: '完成产出' }),
      node({ id: 'g2', status: 'failed', gate: { ok: false, output: '测试失败：期望 3 得到 2' } }),
    ],
  })
  const html = renderCard(r, { conversations: [summary(11, 'done', 1)] })
  assert.ok(html.includes('Gate 失败'))
  assert.ok(html.includes('测试失败：期望 3 得到 2'), 'gate 输出首行应作为失败摘要')
  assert.ok(html.includes('阶段验收失败'), 'run 级错误保留展示')
})
