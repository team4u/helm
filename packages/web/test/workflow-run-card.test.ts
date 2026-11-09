/**
 * builtin:workflow 插件 client 组件测试（kernel 真实 esbuild 编译产物 + SSR）：
 * - 纯逻辑（models.ts 编译产物）：resolveNodeSummaryText / buildWorkflowPhaseSections /
 *   extractWorkflowLogs / canResumeWorkflowRun / formatNodeOutputPreview /
 *   formatWorkflowNodeStats / buildWorkbenchSubagentItems；
 * - SSR（index.tsx 编译产物，共享 React 真实渲染）：
 *   工作流节点无手风琴直出、子代理一体化整卡、无并排按钮、无 Emoji。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationSummary, PluginClientContext as PluginClientContextType, WorkbenchPanelProps, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import {
  importWorkflowClientModule,
  importWorkflowModels,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client.js'

const e = React.createElement
mountSharedPluginNamespaces()
const m = await importWorkflowModels()

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

// ---------------------------------------------------------------------------
// 纯逻辑：formatNodeOutputPreview
// ---------------------------------------------------------------------------

test('formatNodeOutputPreview：空值返回 undefined，字符串取首行，超长截断加省略号', { timeout: 60_000 }, () => {
  assert.equal(m.formatNodeOutputPreview(undefined), undefined)
  assert.equal(m.formatNodeOutputPreview(null), undefined)
  assert.equal(m.formatNodeOutputPreview(''), undefined)
  assert.equal(m.formatNodeOutputPreview('   '), undefined)
  assert.equal(m.formatNodeOutputPreview('第一行\n第二行'), '第一行')
  assert.equal(m.formatNodeOutputPreview('  hello world  '), 'hello world')
  const long = 'a'.repeat(100)
  assert.equal(m.formatNodeOutputPreview(long), `${'a'.repeat(80)}…`)
  assert.equal(m.formatNodeOutputPreview({ ok: true, value: 42 }), '{"ok":true,"value":42}')
  assert.equal(m.formatNodeOutputPreview([1, 2, 3]), '[1,2,3]')
  assert.equal(m.formatNodeOutputPreview('x'.repeat(90), 50), `${'x'.repeat(50)}…`)
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
  const r = m.resolveNodeSummaryText(failed)
  assert.equal(r.isError, true)
  assert.equal(r.text, 'gate 验收失败：pnpm test 退出码 1')
  assert.ok(!r.text!.includes('2m0s'))
})

test('resolveNodeSummaryText：失败节点无 error 时回退 gate 输出与兜底文案', { timeout: 60_000 }, () => {
  const gateFailed = node({
    id: 'n2',
    status: 'failed',
    gate: { ok: false, output: '测试断言失败：期望 3 得到 2' },
  })
  assert.deepEqual(m.resolveNodeSummaryText(gateFailed), { text: '测试断言失败：期望 3 得到 2', isError: true })
  const gateEmpty = node({ id: 'n3', status: 'failed', gate: { ok: false, output: '' } })
  assert.deepEqual(m.resolveNodeSummaryText(gateEmpty), { text: 'Gate 验收未通过', isError: true })
  const bare = node({ id: 'n4', status: 'failed' })
  assert.deepEqual(m.resolveNodeSummaryText(bare), { text: '执行失败', isError: true })
})

test('resolveNodeSummaryText：完成节点返回产出预览而非耗时；运行中优先 childDoing', { timeout: 60_000 }, () => {
  const done = node({
    id: 'n5',
    status: 'done',
    durationMs: 30_000,
    output: { summary: '所有测试通过', failed: 0 },
  })
  const r = m.resolveNodeSummaryText(done)
  assert.equal(r.isError, false)
  assert.equal(r.text, '{"summary":"所有测试通过","failed":0}')
  assert.ok(!r.text!.includes('30.0s'))

  const running = node({ id: 'n6', status: 'running', phaseTitle: '阶段二' })
  assert.equal(m.resolveNodeSummaryText(running).text, '阶段二')
  assert.equal(m.resolveNodeSummaryText(running, 'bash: pnpm build').text, 'bash: pnpm build')
  assert.equal(m.resolveNodeSummaryText(node({ id: 'n7', status: 'running' }), undefined).text, '执行中…')

  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n8', status: 'pending' })), { text: '排队等待执行…', isError: false })
  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n9', status: 'skipped' })), { text: '已跳过', isError: false })
  assert.deepEqual(
    m.resolveNodeSummaryText(node({ id: 'n10', status: 'skipped', error: '前置失败跳过' })),
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
  const sections = m.buildWorkflowPhaseSections(r)
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
  const sections = m.buildWorkflowPhaseSections(r)
  assert.equal(sections.length, 3)
  assert.deepEqual(
    sections.map((s) => s.title),
    ['调研', '实现', '验收'],
  )
  assert.equal(sections[0]!.status, 'done')
  assert.equal(sections[0]!.doneCount, 1)
  assert.equal(sections[1]!.status, 'running')
  assert.equal(sections[2]!.status, 'pending')
  assert.equal(sections[2]!.nodes.length, 0)
  assert.equal(sections[2]!.totalCount, 0)
  assert.equal(sections[0]!.detail, '收集资料')
})

test('buildWorkflowPhaseSections：无任何阶段信息时返回单个 title 空串默认分组', { timeout: 60_000 }, () => {
  const r = run({ nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'failed' })] })
  const sections = m.buildWorkflowPhaseSections(r)
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
  const sections = m.buildWorkflowPhaseSections(r)
  assert.equal(sections.length, 2)
  assert.equal(sections[1]!.title, '默认阶段')
  assert.deepEqual(
    sections[1]!.nodes.map((n) => n.id),
    ['b'],
  )
  const r2 = run({ phases: [{ title: '调研' }], nodes: [node({ id: 'x', status: 'done', phaseTitle: '  调研  ' })] })
  assert.equal(m.buildWorkflowPhaseSections(r2)[0]!.nodes.length, 1)
})

// ---------------------------------------------------------------------------
// 纯逻辑：extractWorkflowLogs / canResumeWorkflowRun / formatWorkflowNodeStats
// ---------------------------------------------------------------------------

test('extractWorkflowLogs：仅提取 kind=log 条目并保留顺序', { timeout: 60_000 }, () => {
  const r = run({
    progress: [
      { at: 1, kind: 'phase', index: 0, title: '调研' },
      { at: 2, kind: 'log', message: '开始扫描' },
      { at: 3, kind: 'log', message: '发现 3 个文件' },
    ],
  })
  const logs = m.extractWorkflowLogs(r)
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
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed' })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'aborted' })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', kind: 'subagent' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'running' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed' })), false)
})

test('resolveNodeSummaryText：blocked 子会话优先显示等待审批（pendingAsk 标题优先）', { timeout: 60_000 }, () => {
  const running = node({ id: 'nb1', status: 'running', conversationId: 21, phaseTitle: '实现' })
  assert.deepEqual(
    m.resolveNodeSummaryText(running, '正在写代码', 'blocked', '确认发布版本'),
    { text: '等待审批：确认发布版本', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, '正在写代码', 'blocked'),
    { text: '等待审批：正在写代码', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, undefined, 'blocked'),
    { text: '等待审批：等待人工确认', isError: false },
  )
  assert.equal(m.resolveNodeSummaryText(running, '正在写代码', 'working').text, '正在写代码')
})

test('formatWorkflowNodeStats：模型短名 + 紧凑 token，无值返回空', { timeout: 60_000 }, () => {
  assert.deepEqual(m.formatWorkflowNodeStats(node({ id: 'a', model: 'openai/glm-5', tokens: 1500 })), ['glm-5', '1.5k'])
  assert.deepEqual(m.formatWorkflowNodeStats(node({ id: 'b', model: 'glm-5', tokens: 500 })), ['glm-5', '500'])
  assert.deepEqual(m.formatWorkflowNodeStats(node({ id: 'c', tokens: 0 })), [])
  assert.deepEqual(m.formatWorkflowNodeStats(node({ id: 'd' })), [])
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildWorkbenchSubagentItems（Active-First 去重）
// ---------------------------------------------------------------------------

test('buildWorkbenchSubagentItems：单子代理后台 run 认领的子会话与独立子会话合并去重', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'done', 1),
    summary(12, 'working', 1),
    summary(13, 'idle', 1),
    summary(21, 'idle', 2),
  ]
  const runs = [
    run({ id: 'wf_dsl', nodes: [node({ id: 'a', status: 'done', conversationId: 11 })] }),
    run({ id: 'wf_bg1', kind: 'subagent', nodes: [node({ id: 'b', status: 'running', conversationId: 12 })] }),
  ]
  const items = m.buildWorkbenchSubagentItems(conversations, 1, runs)
  assert.deepEqual(
    items.map((it) => it.conversationId),
    [12, 13],
    'DSL 认领的 #11 被排除；单子代理 run 认领的 #12 与独立 #13 合并去重',
  )
  assert.equal(items[0]!.backgroundRun?.id, 'wf_bg1', '#12 应携带认领它的后台 run')
  assert.equal(items[1]!.backgroundRun, undefined, '#13 独立子会话无后台 run')
  assert.deepEqual(m.buildWorkbenchSubagentItems(conversations, 2, runs).map((it) => it.conversationId), [21])
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
  const items = m.buildWorkbenchSubagentItems(conversations, 1, [])
  assert.deepEqual(
    items.map((it) => it.conversationId),
    [33, 32, 34, 36, 31, 35],
  )
  const withBg = m.buildWorkbenchSubagentItems(
    [{ ...summary(41, 'idle', 1), updatedAt: 5 }],
    1,
    [run({ id: 'wf_bg2', kind: 'subagent', status: 'running', createdAt: 1, updatedAt: 99, nodes: [node({ id: 'n', status: 'running', conversationId: 41 })] })],
  )
  assert.equal(withBg[0]!.conversationId, 41)
  assert.equal(withBg[0]!.summary?.status, 'idle')
  assert.equal(withBg[0]!.backgroundRun?.status, 'running')
})

test('buildWorkbenchSubagentItems：多个后台 run 优先 parentToolCallId 精确匹配，反转数组仍取当前关联 run', { timeout: 60_000 }, () => {
  const oldRun = run({
    id: 'wf_old',
    kind: 'subagent',
    status: 'failed',
    error: '上一轮失败',
    createdAt: 1_000,
    updatedAt: 9_000,
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
  for (const runs of [[oldRun, newRun], [newRun, oldRun]]) {
    const items = m.buildWorkbenchSubagentItems([child], 1, runs)
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
    updatedAt: 99_000,
    parentToolCallId: 'call_old',
    nodes: [node({ id: 'b', status: 'failed', conversationId: 12 })],
  })
  const child = { ...summary(12, 'working', 1), parentToolCallId: 'call_new' }
  let items = m.buildWorkbenchSubagentItems([child], 1, [oldRun])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.backgroundRun, undefined, 'parentToolCallId 有值但无匹配 run 时不得关联旧 run')

  const legacy = { ...summary(13, 'working', 1) }
  const noCallRun = run({
    id: 'wf_nocall',
    kind: 'subagent',
    status: 'running',
    createdAt: 5_000,
    updatedAt: 6_000,
    nodes: [node({ id: 'c', status: 'running', conversationId: 13 })],
  })
  items = m.buildWorkbenchSubagentItems([legacy], 1, [noCallRun, oldRun])
  const item13 = items.find((it) => it.conversationId === 13)
  assert.ok(item13 !== undefined)
  assert.equal(item13!.backgroundRun?.id, 'wf_nocall')
})

test('buildWorkbenchSubagentItems：缺失真实 summary 时仅携带 run 确认的 conversationId，不虚构对象', { timeout: 60_000 }, () => {
  const bgRun = run({
    id: 'wf_bg15',
    kind: 'subagent',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [node({ id: 'n', status: 'running', conversationId: 15, label: '实现者' })],
  })
  const items = m.buildWorkbenchSubagentItems([], 1, [bgRun])
  assert.equal(items.length, 1)
  assert.equal(items[0]!.conversationId, 15)
  assert.equal(items[0]!.summary, undefined, '不得虚构 ConversationSummary 占位对象')
  assert.equal(items[0]!.backgroundRun?.id, 'wf_bg15')
})

test('resolveNodeSummaryText：done 节点不随后来 child blocked 改写为等待审批', { timeout: 60_000 }, () => {
  const done = node({ id: 'nd1', status: 'done', output: '调研完成' })
  assert.deepEqual(
    m.resolveNodeSummaryText(done, '正在复用追问', 'blocked'),
    { text: '调研完成', isError: false },
    'done 历史终态节点保持产出预览',
  )
  const failed = node({ id: 'nd2', status: 'failed', error: 'gate 未通过' })
  assert.deepEqual(
    m.resolveNodeSummaryText(failed, undefined, 'blocked', '确认重试'),
    { text: 'gate 未通过', isError: true },
    'failed 终态节点保持错误摘要',
  )
  const running = node({ id: 'nd3', status: 'running' })
  assert.deepEqual(
    m.resolveNodeSummaryText(running, undefined, 'blocked', '确认发布'),
    { text: '等待审批：确认发布', isError: false },
  )
})

// ---------------------------------------------------------------------------
// SSR：编译产物组件真实渲染（共享 React + PluginClientContext 注入）
// ---------------------------------------------------------------------------

const stubCtx: PluginClientContextType = {
  pluginId: 'builtin:workflow',
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
  conversationId: 1,
  theme: 'dark',
}

/** 渲染 WorkflowToolView：docValue 提供 runs 文档。 */
async function renderWorkflowToolView(
  props: Record<string, unknown>,
  docValue: unknown = undefined,
): Promise<string> {
  setWorkflowClientStub({ docValue })
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowToolView = mod['WorkflowToolView'] as (p: Record<string, unknown>) => React.ReactElement
  return renderToString(
    e(PluginClientContext.Provider, { value: stubCtx }, e(WorkflowToolView, props)),
  )
}

const HELLO_RUN = run({
  id: 'wf_hello',
  name: 'hello-orchestra',
  status: 'completed',
  parentToolCallId: 'wf_call',
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

async function renderHelloRun(): Promise<string> {
  return renderWorkflowToolView(
    {
      callId: 'wf_call', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'done', conversationId: 1, siblingCalls: [],
    },
    { runs: [HELLO_RUN] },
  )
}

test('SSR：WorkflowToolView 无关联 run 时保留调用详情（不虚构工作流卡）', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowToolView({
    callId: 'w1', toolName: 'SubagentWorkflow', input: { script: 'x' },
    status: 'running', result: '原始工作流返回结果', conversationId: 1, siblingCalls: [],
  })
  assert.ok(html.includes('调用详情'))
  assert.ok(html.includes('原始工作流返回结果'))
})

test('SSR：工作流节点无折叠手风琴壳，最外层直接直出一体化整卡与动作扁平卡', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(html.includes('subagent-live-card'), '应直接在最外层直出子代理一体化整卡')
  assert.ok(html.includes('subagent-card-clickable'), '子代理卡必须携带整卡统一 hover 类')
  assert.ok(html.includes('workflow-action-card'), '动作节点应渲染扁平双层卡')
  assert.ok(!html.includes('展开节点详情'), '不得包含节点展开/收起按钮文案')
  assert.ok(!html.includes('收起节点详情'), '不得包含节点收起按钮文案')
})

test('SSR：多阶段工作流渲染阶段胶囊、日志、产出预览与徽章', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(/1\.<!-- -->\s*调研|1\. 调研/.test(html), '应渲染阶段 1 标题')
  assert.ok(/2\.<!-- -->\s*实现|2\. 实现/.test(html), '应渲染阶段 2 标题')
  assert.ok(html.includes('3/3'), '应渲染全局节点完成计数')
  assert.match(html, /workflow-phase-count[^>]*>\(2\/2\)/, '调研阶段应计入 agent 与 action 两个节点')
  assert.match(html, /workflow-phase-count[^>]*>\(1\/1\)/, '实现阶段应计入 cached 完成节点')
  assert.ok(html.includes('workflow-log-text'))
  assert.ok(html.includes('开始调研'))
  assert.ok(html.includes('实现完成'))
  assert.ok(html.includes('调研结论：可行'))
  assert.ok(html.includes('实现完成，测试通过'))
  assert.match(html, /badge-warn[^>]*>\s*<!--\s*-->\s*cached|badge-warn[^>]*>cached/, 'cached 节点应有 cached 徽章')
  assert.ok(html.includes('subagent-worktree-badge'), 'worktree 节点应有分支徽章')
  assert.ok(html.includes('helm/wf-hello'), '应显示分支名')
  assert.ok(html.includes('隔离工作树：/root/code/helm/.worktrees/wf-hello'), 'title 应含完整工作树路径')
  assert.ok(html.includes('动作'), 'action 节点应显示动作徽章')
  assert.ok(html.includes('最终产出'), '完成 run 应渲染最终产出区')
  assert.match(html, /workflow-result-preview[^>]*>[^<]*docs\/report\.md/, '折叠 JSON 结果预览不能只显示左花括号')
  assert.ok(html.includes('docs/report.md'))
  assert.ok(html.includes('已完成'))
  assert.ok(html.includes('节点 3/3'))
  assert.ok(html.includes('Tokens'))
})

test('SSR：一体化整卡无任何并排查看 / 分屏按钮（最新交互约定）', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(!html.includes('并排查看'), '不得渲染并排查看按钮')
  assert.ok(!html.includes('subagent-split-btn'), '不得残留分屏按钮类名')
  assert.ok(!html.includes('workbench-split-btn'), '不得残留工作台分屏按钮类名')
  assert.ok(!html.includes('在分屏并排打开'), '不得包含分屏打开文案')
})

test('SSR：断点恢复按钮仅 DSL 工作流可见，后台单子代理不显示', { timeout: 60_000 }, async () => {
  const dslFailed = await renderWorkflowToolView(
    {
      callId: 'call-dsl', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1,
      siblingCalls: [],
    },
    { runs: [run({ id: 'wf_dsl', kind: 'workflow', status: 'failed', error: '阶段实现失败', parentToolCallId: 'call-dsl', nodes: [node({ id: 'a', status: 'failed', error: 'gate 未通过' })] })] },
  )
  assert.ok(dslFailed.includes('断点恢复'), '失败的 DSL 工作流应显示断点恢复按钮')
  assert.ok(dslFailed.includes('失败'))
  assert.ok(dslFailed.includes('gate 未通过'), '失败节点应展示错误摘要')

  const subagentFailed = await renderWorkflowToolView(
    {
      callId: 'call-sub', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1,
      siblingCalls: [],
    },
    { runs: [run({ id: 'wf_sub', kind: 'subagent', status: 'failed', error: '子代理异常退出', parentToolCallId: 'call-sub', nodes: [node({ id: 'a', status: 'failed' })] })] },
  )
  assert.ok(!subagentFailed.includes('断点恢复'), '失败的后台单子代理不得显示断点恢复按钮')
})

test('SSR：running 工作流显示中止按钮与执行中徽章', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowToolView(
    {
      callId: 'call-run', toolName: 'SubagentWorkflow', status: 'running', conversationId: 1,
      siblingCalls: [],
    },
    { runs: [run({ id: 'wf_live', status: 'running', parentToolCallId: 'call-run', nodes: [node({ id: 'a', status: 'running', conversationId: 11, phaseTitle: '调研' })] })] },
  )
  assert.ok(html.includes('中止'), 'running run 应显示中止按钮')
  assert.ok(html.includes('执行中'), '应显示执行中徽章')
})

test('SSR：WorkflowWorkbenchPanel 空态显示占位文案', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({})
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const conv = summary(1, 'idle')
  const html = renderToString(
    e(PluginClientContext.Provider, { value: stubCtx }, e(WorkflowWorkbenchPanel, { conversation: conv })),
  )
  assert.ok(html.includes('暂无工作流'))
})

test('SSR：WorkflowWorkbenchPanel 列出当前会话工作流与子代理', { timeout: 60_000 }, async () => {
  const wf = run({ id: 'wf_list', name: '列表工作流', status: 'running', parentToolCallId: 'c9' })
  const child12 = { ...summary(12, 'working', 1), doing: '正在跑测试' }
  setWorkflowClientStub({
    docValue: { runs: [wf] },
    conversations: [child12],
    conversation: (id) =>
      id === 12
        ? { summary: child12, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const conv = summary(1, 'idle')
  const html = renderToString(
    e(PluginClientContext.Provider, { value: stubCtx }, e(WorkflowWorkbenchPanel, { conversation: conv })),
  )
  assert.ok(html.includes('工作流运行'), '应渲染工作流分组标题')
  assert.ok(html.includes('列表工作流'))
  assert.ok(html.includes('子代理会话'), '应渲染子代理分组标题')
  assert.ok(html.includes('正在跑测试'), '子代理卡副栏应显示实时 doing')
})

test('SSR：外部 agent 节点与 cached 无会话节点不伪造子会话或误标为动作', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowToolView(
    { callId: 'external-call', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1 },
    { runs: [run({ parentToolCallId: 'external-call', status: 'completed', nodes: [
      node({ id: 'external', kind: 'agent', status: 'done', executionId: 'pane-42', label: '外部实现者', output: '完成' }),
      node({ id: 'cached', kind: 'agent', status: 'done', cached: true, label: '复用缓存', output: '缓存结果' }),
    ] })] },
  )
  assert.ok(!html.includes('subagent-card-clickable'), '没有真实会话就不能渲染导航卡')
  assert.ok(!html.includes('子会话 #'), '不能编造子会话编号')
  assert.ok(!html.includes('workflow-action-card'), 'agent 节点不能误标为 action')
  assert.ok(html.includes('外部执行') && html.includes('pane-42'))
  assert.ok(html.includes('cached') && html.includes('缓存结果'))
})

/** Emoji / 特殊符号黑名单。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u

test('SSR：WorkflowToolView 渲染输出全程无任何 Emoji 或特殊符号字符', { timeout: 60_000 }, async () => {
  const samples: Array<[Record<string, unknown>, unknown]> = [
    [{ callId: 'w1', toolName: 'SubagentWorkflow', status: 'running', conversationId: 1, siblingCalls: [] }, undefined],
    [{ callId: 'w2', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1, siblingCalls: [] },
      { runs: [run({ status: 'completed', result: { ok: true }, nodes: [node({ id: 'a', status: 'done', output: '完成' })] })] }],
    [{ callId: 'w3', toolName: 'SubagentWorkflow', status: 'error', conversationId: 1, siblingCalls: [] },
      { runs: [run({ kind: 'subagent', status: 'failed', error: '子代理异常退出', nodes: [node({ id: 'a', status: 'failed', error: 'boom' })] })] }],
  ]
  for (const [props, doc] of samples) {
    const html = await renderWorkflowToolView(props, doc)
    assert.ok(!EMOJI_RE.test(html), `渲染输出不得包含 Emoji：${String(props.callId)}`)
    assert.ok(!html.includes('✓') && !html.includes('✗') && !html.includes('▸'), '不得使用勾叉箭头类特殊符号')
  }
})
