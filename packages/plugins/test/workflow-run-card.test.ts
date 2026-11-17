/**
 * builtin:workflow 插件 client 组件与运行卡片测试（kernel 真实 esbuild 编译产物）：
 * - 纯逻辑（models.ts 编译产物）：resolveNodeSummaryText / buildWorkflowPhaseSections /
 *   extractWorkflowLogs / canResumeWorkflowRun（含 run.resumable 与 errorCode）/
 *   listResumableFailedRuns / formatNodeOutputPreview / formatWorkflowNodeStats /
 *   buildExecutionTree（runs 唯一根源）；
 * - SSR（index.tsx 编译产物）：工作流节点直出、子代理一体化整卡、无并排按钮、无 Emoji；
 * - DOM 交互（真实 SDK hooks）：瘦身 run（hasResult: true, result: undefined, resultPreview）
 *   折叠仅显示 resultPreview（零 inspect 请求），点击「Expand full result」按需调 inspect
 *   加载完整结果并缓存，失败显式报错不伪造。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginClientContext as PluginClientContextType, WorkbenchPanelProps } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  SDK,
  act,
  createWorkflowHostHarness,
  importWorkflowClientModule,
  importWorkflowModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
  renderToString,
  setWorkflowClientStub,
} from './helpers/workflow-client-harness.js'

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
  return makeConvSummary(id, {
    status,
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
  })
}

function subagentRun(
  id: string,
  parentConversationId: number,
  childConversationId: number,
  status: WorkflowRunSummary['status'] = 'completed',
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return run({
    id,
    kind: 'subagent',
    name: `subagent-${childConversationId}`,
    conversationId: parentConversationId,
    status,
    nodes: [
      node({
        id: `n-${childConversationId}`,
        status: status === 'running' ? 'running' : status === 'failed' || status === 'aborted' ? 'failed' : 'done',
        conversationId: childConversationId,
      }),
    ],
    ...overrides,
  })
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
// 纯逻辑：resolveNodeSummaryText
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
  assert.deepEqual(m.resolveNodeSummaryText(gateEmpty), { text: 'Gate check failed', isError: true })
  assert.deepEqual(m.resolveNodeSummaryText(gateEmpty, undefined, undefined, undefined, 'zh-CN'), { text: 'Gate 验收未通过', isError: true })
  const bare = node({ id: 'n4', status: 'failed' })
  assert.deepEqual(m.resolveNodeSummaryText(bare), { text: 'Execution failed', isError: true })
  assert.deepEqual(m.resolveNodeSummaryText(bare, undefined, undefined, undefined, 'zh-CN'), { text: '执行失败', isError: true })
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
  assert.equal(m.resolveNodeSummaryText(node({ id: 'n7', status: 'running' }), undefined).text, 'Running…')
  assert.equal(m.resolveNodeSummaryText(node({ id: 'n7', status: 'running' }), undefined, undefined, undefined, 'zh-CN').text, '执行中…')

  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n8', status: 'pending' })), { text: 'Queued…', isError: false })
  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n8', status: 'pending' }), undefined, undefined, undefined, 'zh-CN'), { text: '排队等待执行…', isError: false })
  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n9', status: 'skipped' })), { text: 'Skipped', isError: false })
  assert.deepEqual(m.resolveNodeSummaryText(node({ id: 'n9', status: 'skipped' }), undefined, undefined, undefined, 'zh-CN'), { text: '已跳过', isError: false })
  assert.deepEqual(
    m.resolveNodeSummaryText(node({ id: 'n10', status: 'skipped', error: '前置失败跳过' })),
    { text: '前置失败跳过', isError: false },
  )
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildWorkflowPhaseSections
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
  assert.equal(sections[1]!.title, 'Default phase')
  assert.equal(m.buildWorkflowPhaseSections(r, 'zh-CN')[1]!.title, '默认阶段')
  assert.deepEqual(
    sections[1]!.nodes.map((n) => n.id),
    ['b'],
  )
  const r2 = run({ phases: [{ title: '调研' }], nodes: [node({ id: 'x', status: 'done', phaseTitle: '  调研  ' })] })
  assert.equal(m.buildWorkflowPhaseSections(r2)[0]!.nodes.length, 1)
})

// ---------------------------------------------------------------------------
// 纯逻辑：extractWorkflowLogs / canResumeWorkflowRun / listResumableFailedRuns
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

test('canResumeWorkflowRun：优先消费 run.resumable 与结构化 errorCode，未接管 failed/aborted 可恢复', { timeout: 60_000 }, () => {
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed' })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'aborted' })), true)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: false })), false, '权威 run.resumable=false 优先')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumable: true, error: 'validation_error' })), true, '权威 run.resumable=true 优先')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', errorCode: 'validation_error', error: '坏参数' })), false, '结构化 errorCode 阻断恢复')
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', errorCode: 'syntax_error', error: '语法错' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', resumedByRunId: 'wf_next' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'aborted', resumedByRunId: 'wf_next' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'failed', kind: 'subagent' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'running' })), false)
  assert.equal(m.canResumeWorkflowRun(run({ status: 'completed' })), false)
})

test('canResumeSubagentRun：仅未接管、failed/aborted 且具备执行句柄的 subagent 可恢复（尊重 run.resumable）', { timeout: 60_000 }, () => {
  assert.equal(m.canResumeSubagentRun(undefined, true), false)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'workflow', status: 'failed' }), true), false)
  assert.equal(m.canResumeSubagentRun(run({ status: 'failed' }), true), false)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'running' }), true), false)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'completed' }), true), false)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed', resumable: false }), true), false)
  assert.equal(
    m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed', resumedByRunId: 'wf_next' }), true),
    false,
  )
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed' }), true), true)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'aborted' }), true), true)
  assert.equal(m.canResumeSubagentRun(run({ kind: 'subagent', status: 'failed' }), false), false)
  assert.equal(
    m.canResumeSubagentRun(
      run({ kind: 'subagent', status: 'failed', nodes: [node({ id: 's0', status: 'failed', conversationId: 11 })] }),
      false,
    ),
    true,
  )
  assert.equal(
    m.canResumeSubagentRun(
      run({ kind: 'subagent', status: 'aborted', nodes: [node({ id: 's0', status: 'skipped', executionId: 'pane-1' })] }),
      false,
    ),
    true,
  )
})

test('listResumableFailedRuns：按会话、状态、接管、run.resumable 与结构化错误码过滤', { timeout: 60_000 }, () => {
  const candidates = [
    run({ id: 'wf_ok', conversationId: 1, kind: 'workflow', status: 'failed', error: 'gate failed' }),
    run({ id: 'wf_flag_true', conversationId: 1, kind: 'workflow', status: 'failed', resumable: true, error: 'ignored' }),
    run({
      id: 'wf_plain_valid',
      conversationId: 1,
      kind: 'workflow',
      status: 'failed',
      error: 'model call failed during validation phase',
    }),
    run({
      id: 'wf_sub_conv',
      conversationId: 1,
      kind: 'subagent',
      status: 'failed',
      nodes: [node({ id: 's1', status: 'failed', conversationId: 11 })],
    }),
    run({
      id: 'wf_sub_ext',
      conversationId: 1,
      kind: 'subagent',
      status: 'failed',
      nodes: [node({ id: 's2', status: 'failed', executionId: 'pane-2' })],
    }),
    run({ id: 'wf_flag_false', conversationId: 1, kind: 'workflow', status: 'failed', resumable: false }),
    run({ id: 'wf_errcode', conversationId: 1, kind: 'workflow', status: 'failed', errorCode: 'crash_recovery_limit' }),
    run({ id: 'wf_other_conv', conversationId: 2, kind: 'workflow', status: 'failed' }),
    run({ id: 'wf_aborted', conversationId: 1, kind: 'workflow', status: 'aborted' }),
    run({ id: 'wf_running', conversationId: 1, kind: 'workflow', status: 'running' }),
    run({ id: 'wf_taken', conversationId: 1, kind: 'workflow', status: 'failed', resumedByRunId: 'wf_new' }),
    run({ id: 'wf_uncertain', conversationId: 1, kind: 'workflow', status: 'failed', error: 'workflow_action_uncertain: x' }),
    run({ id: 'wf_limit', conversationId: 1, kind: 'subagent', status: 'failed', error: '[crash_recovery_limit] exceeded', nodes: [node({ id: 's3', status: 'failed', conversationId: 12 })] }),
    run({ id: 'wf_secret', conversationId: 1, kind: 'subagent', status: 'failed', error: 'secret_grant_expired_on_restart', nodes: [node({ id: 's4', status: 'failed', executionId: 'pane-4' })] }),
    run({ id: 'wf_val_err', conversationId: 1, kind: 'workflow', status: 'failed', error: 'HelmError [validation_error] bad arg' }),
    run({ id: 'wf_syntax', conversationId: 1, kind: 'workflow', status: 'failed', error: 'Workflow script has a syntax error: Unexpected token' }),
    run({ id: 'wf_sub_nohandle', conversationId: 1, kind: 'subagent', status: 'failed', nodes: [node({ id: 's5', status: 'failed' })] }),
  ]
  const list = m.listResumableFailedRuns([...candidates, candidates[0]!], 1)
  assert.deepEqual(
    list.map((item) => item.id),
    ['wf_ok', 'wf_flag_true', 'wf_plain_valid', 'wf_sub_conv', 'wf_sub_ext'],
  )
})

test('parseResumeFailedResult：严格校验返回结构，非法形状返回 undefined', { timeout: 60_000 }, () => {
  assert.deepEqual(
    m.parseResumeFailedResult({
      resumed: [{ id: 'wf_1' }, { id: 'wf_2' }],
      skipped: [{ runId: 'wf_3', reason: 'workflow_action_uncertain' }],
    }),
    { resumedCount: 2, skippedCount: 1 },
  )
  assert.deepEqual(m.parseResumeFailedResult({ resumed: [], skipped: [] }), { resumedCount: 0, skippedCount: 0 })
  assert.equal(m.parseResumeFailedResult(undefined), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [] }), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [{ name: 'missing-id' }], skipped: [] }), undefined)
  assert.equal(m.parseResumeFailedResult({ resumed: [], skipped: [{ runId: 'wf_x' }] }), undefined)
})

test('resolveNodeSummaryText：blocked 子会话优先显示等待审批（pendingAsk 标题优先）', { timeout: 60_000 }, () => {
  const running = node({ id: 'nb1', status: 'running', conversationId: 21, phaseTitle: '实现' })
  assert.deepEqual(
    m.resolveNodeSummaryText(running, '正在写代码', 'blocked', '确认发布版本'),
    { text: 'Awaiting approval: 确认发布版本', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, '正在写代码', 'blocked', '确认发布版本', 'zh-CN'),
    { text: '等待审批：确认发布版本', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, '正在写代码', 'blocked'),
    { text: 'Awaiting approval: 正在写代码', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, undefined, 'blocked'),
    { text: 'Awaiting approval: Awaiting human confirmation', isError: false },
  )
  assert.deepEqual(
    m.resolveNodeSummaryText(running, undefined, 'blocked', undefined, 'zh-CN'),
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
// 纯逻辑：buildExecutionTree 工作台关联（runs 唯一根源）
// ---------------------------------------------------------------------------

test('buildExecutionTree：单子代理 run 认领的子会话各自独立挂载，DSL 认领的会话挂 run 下', { timeout: 60_000 }, () => {
  const conversations = [
    summary(11, 'done', 1),
    summary(12, 'working', 1),
    summary(13, 'idle', 1),
    summary(21, 'idle', 2),
  ]
  const runs = [
    run({ id: 'wf_dsl', nodes: [node({ id: 'a', status: 'done', conversationId: 11 })] }),
    run({ id: 'wf_bg1', kind: 'subagent', nodes: [node({ id: 'b', status: 'running', conversationId: 12 })] }),
    subagentRun('wf_bg2', 1, 13, 'completed'),
    subagentRun('wf_other_root', 2, 21, 'completed'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const convNodes = tree.filter((n) => n.kind === 'conversation')
  assert.deepEqual(
    convNodes.map((n) => n.conversationId),
    [12, 13],
    'DSL 认领的 #11 挂 run 节点下；单子代理 run 认领的 #12 与 #13 挂根下',
  )
  assert.equal(convNodes[0]!.run?.id, 'wf_bg1')
  assert.equal(convNodes[1]!.run?.id, 'wf_bg2')
  const wfNode = tree.find((n) => n.kind === 'workflow')!
  assert.equal(wfNode.children[0]!.conversationId, 11)
  assert.deepEqual(
    m.buildExecutionTree({ rootConversationId: 2, conversations, runs }).map((n) => n.conversationId),
    [21],
  )
})

test('buildExecutionTree：Active-First 排序 blocked > working > error > done，同级 updatedAt 降序', { timeout: 60_000 }, () => {
  const conversations = [
    { ...summary(31, 'idle', 1), updatedAt: 50 },
    { ...summary(32, 'working', 1), updatedAt: 40 },
    { ...summary(33, 'blocked', 1), updatedAt: 30 },
    { ...summary(34, 'error', 1), updatedAt: 20 },
    { ...summary(35, 'idle', 1), updatedAt: 10 },
    { ...summary(36, 'idle', 1), updatedAt: 60 },
  ]
  const runs = [
    subagentRun('wf_31', 1, 31, 'completed', { updatedAt: 50 }),
    subagentRun('wf_32', 1, 32, 'running', { updatedAt: 40 }),
    subagentRun('wf_33', 1, 33, 'running', { updatedAt: 30 }),
    subagentRun('wf_34', 1, 34, 'failed', { updatedAt: 20 }),
    subagentRun('wf_35', 1, 35, 'completed', { updatedAt: 10 }),
    subagentRun('wf_36', 1, 36, 'completed', { updatedAt: 60 }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(
    tree.map((n) => n.conversationId),
    [33, 32, 34, 36, 31, 35],
  )
  const withBg = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [{ ...summary(41, 'idle', 1), updatedAt: 5 }],
    runs: [run({ id: 'wf_bg2', kind: 'subagent', status: 'running', createdAt: 1, updatedAt: 99, nodes: [node({ id: 'n', status: 'running', conversationId: 41 })] })],
  })
  assert.equal(withBg[0]!.conversationId, 41)
  assert.equal(withBg[0]!.summary?.status, 'idle')
  assert.equal(withBg[0]!.run?.status, 'running')
  assert.equal(withBg[0]!.status, 'working')
})

test('buildExecutionTree：多个后台 run 优先 parentToolCallId 精确匹配，反转数组仍取当前关联 run', { timeout: 60_000 }, () => {
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
    const convNodes = m.buildExecutionTree({ rootConversationId: 1, conversations: [child], runs }).filter((n) => n.kind === 'conversation')
    assert.equal(convNodes.length, 1)
    assert.equal(convNodes[0]!.run?.id, 'wf_new', '必须按 parentToolCallId 精确匹配，与数组顺序无关')
  }
})

test('buildExecutionTree：缺失真实 summary 时仅携带 run 确认的 conversationId，不虚构对象', { timeout: 60_000 }, () => {
  const bgRun = run({
    id: 'wf_bg15',
    kind: 'subagent',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [node({ id: 'n', status: 'running', conversationId: 15, label: '实现者' })],
  })
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations: [], runs: [bgRun] })
  assert.equal(tree.length, 1)
  assert.equal(tree[0]!.conversationId, 15)
  assert.equal(tree[0]!.summary, undefined, '不得虚构 ConversationSummary 占位对象')
  assert.equal(tree[0]!.run?.id, 'wf_bg15')
  assert.equal(tree[0]!.status, 'working', 'run running 不假完成')
})

test('resolveNodeSummaryText：done 节点不随后来 child blocked 改写为等待审批', { timeout: 60_000 }, () => {
  const done = node({ id: 'nd1', status: 'done', output: '调研完成' })
  assert.deepEqual(
    m.resolveNodeSummaryText(done, '正在复用追问', 'blocked'),
    { text: '调研完成', isError: false },
  )
  const failed = node({ id: 'nd2', status: 'failed', error: 'gate 未通过' })
  assert.deepEqual(
    m.resolveNodeSummaryText(failed, undefined, 'blocked', '确认重试'),
    { text: 'gate 未通过', isError: true },
  )
  const running = node({ id: 'nd3', status: 'running' })
  assert.deepEqual(
    m.resolveNodeSummaryText(running, undefined, 'blocked', '确认发布'),
    { text: 'Awaiting approval: 确认发布', isError: false },
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
  submitInput: async () => {},
  getPluginSessionDoc: async () => undefined,
  getPluginDoc: async () => undefined,
  conversationId: 1,
  theme: 'dark',
  locale: 'en' as const,
  translate: (text) => SDK.resolveLocalizedText(text, 'en'),
}

async function renderWorkflowToolView(
  props: Record<string, unknown>,
  docValue: unknown = undefined,
  conversations: unknown[] | undefined = undefined,
): Promise<string> {
  setWorkflowClientStub(conversations !== undefined ? { docValue, conversations } : { docValue })
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowToolView = mod['WorkflowToolView'] as (p: Record<string, unknown>) => React.ReactElement
  return renderToString(
    e(SDK.PluginClientContext.Provider, { value: stubCtx }, e(WorkflowToolView, props)),
  )
}

async function renderWorkflowWorkbench(
  docValue: unknown = undefined,
  conversations: unknown[] | undefined = undefined,
  viewerConversation: ConversationSummary = summary(1, 'idle'),
): Promise<string> {
  setWorkflowClientStub(conversations !== undefined ? { docValue, conversations } : { docValue })
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  return renderToString(
    e(SDK.PluginClientContext.Provider, { value: stubCtx }, e(WorkflowWorkbenchPanel, { conversation: viewerConversation })),
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
  return renderWorkflowWorkbench({ runs: [HELLO_RUN] })
}

test('buildWorkflowPhaseSections：pending 节点不被 done 掩盖——终结 run 有未执行节点保持 pending', { timeout: 60_000 }, () => {
  const completed = run({
    status: 'completed',
    nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'pending' })],
  })
  assert.equal(m.buildWorkflowPhaseSections(completed)[0]!.status, 'pending')
  const running = run({
    status: 'running',
    nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'pending' })],
  })
  assert.equal(m.buildWorkflowPhaseSections(running)[0]!.status, 'running')
  const aborted = run({
    status: 'aborted',
    nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'pending' })],
  })
  assert.equal(m.buildWorkflowPhaseSections(aborted)[0]!.status, 'pending')
  const skipped = run({
    status: 'completed',
    nodes: [node({ id: 'a', status: 'done' }), node({ id: 'b', status: 'skipped' })],
  })
  assert.equal(m.buildWorkflowPhaseSections(skipped)[0]!.status, 'done')
})

test('SSR：run 主徽章同源有效状态——run 已完成但子任务仍在执行不假完成，自身终态另标清楚', { timeout: 60_000 }, async () => {
  const conv11 = { ...summary(11, 'working', 1), doing: '后台补测试', updatedAt: 50 }
  const conv21 = { ...summary(21, 'working', 11), doing: '补齐回归', updatedAt: 40 }
  const doc = {
    runs: [
      run({
        id: 'wf_straggler',
        kind: 'workflow',
        status: 'completed',
        parentToolCallId: 'call-x',
        createdAt: 1_000,
        updatedAt: 60_000,
        nodes: [node({ id: 'a', kind: 'agent', status: 'done', conversationId: 11, label: '实现者' })],
      }),
      subagentRun('wf_21', 11, 21, 'running'),
    ],
  }
  const toolHtml = await renderWorkflowToolView(
    { callId: 'call-x', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1, siblingCalls: [] },
    doc,
    [conv11, conv21],
  )
  assert.match(toolHtml, /badge-accent[^>]*>Running/, '时间线单行主徽章同源不得假完成')
  assert.ok(!toolHtml.includes('>Completed<'), '时间线单行不得假完成')

  const html = await renderWorkflowWorkbench(doc, [conv11, conv21])
  assert.ok(html.includes('Self: Completed'), '工作台卡自身终态应另标清楚')
  assert.ok(!/>Completed</.test(html), '不得以孤立的「Completed」作为主徽章假完成')
  assert.match(html, /badge-accent[^>]*>Running/, '主徽章应为同源有效状态（子任务仍在执行）')
  assert.ok(html.includes('Subtree 0/2'), '子树计数如实展示未完成（深层后台子任务计入）')
})

test('SSR：run 全部子孙结算时主徽章保留自身终态文案（已完成 / 失败）', { timeout: 60_000 }, async () => {
  const done = await renderWorkflowWorkbench({
    runs: [
      run({
        id: 'wf_ok',
        kind: 'workflow',
        status: 'completed',
        parentToolCallId: 'c1',
        nodes: [node({ id: 'a', kind: 'action', status: 'done', label: '动作' })],
      }),
    ],
  })
  assert.ok(done.includes('>Completed<'))
  assert.ok(!done.includes('Self:'))

  const failed = await renderWorkflowWorkbench({
    runs: [
      run({
        id: 'wf_bad',
        kind: 'workflow',
        status: 'failed',
        parentToolCallId: 'c2',
        nodes: [node({ id: 'a', status: 'failed', error: 'gate 未通过' })],
      }),
    ],
  })
  assert.ok(failed.includes('>Failed<'))
})

test('SSR：WorkflowToolView 无关联 run 时收口单行并保留折叠详情开关（不虚构工作流卡）', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowToolView({
    callId: 'w1',
    toolName: 'SubagentWorkflow',
    input: { script: 'x' },
    status: 'running',
    result: '原始工作流返回结果',
    conversationId: 1,
    siblingCalls: [],
  })
  assert.ok(html.includes('workflow-trace-row-btn'))
  assert.ok(html.includes('aria-expanded="false"'))
  assert.ok(!html.includes('workflow-run-card'))
  assert.ok(!html.includes('原始工作流返回结果'))
})

test('SSR：工作流节点无折叠手风琴壳，最外层直接直出一体化整卡与动作扁平卡', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(html.includes('subagent-live-card'))
  assert.ok(html.includes('subagent-card-clickable'))
  assert.ok(html.includes('workflow-action-card'))
  assert.ok(!html.includes('展开Node details'))
  assert.ok(!html.includes('收起Node details'))
})

test('SSR：多阶段工作流渲染阶段胶囊、日志、产出预览与徽章', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(/1\.<!-- -->\s*调研|1\. 调研/.test(html))
  assert.ok(/2\.<!-- -->\s*实现|2\. 实现/.test(html))
  assert.ok(html.includes('3/3'))
  assert.match(html, /phase-segment-done[\s\S]*?1\.[\s\S]*?调研[\s\S]*?\(2\/2\)/)
  assert.match(html, /phase-segment-done[\s\S]*?2\.[\s\S]*?实现[\s\S]*?\(1\/1\)/)
  assert.ok(html.includes('workflow-log-text'))
  assert.ok(html.includes('开始调研'))
  assert.ok(html.includes('实现完成'))
  assert.ok(html.includes('调研结论：可行'))
  assert.ok(html.includes('实现完成，测试通过'))
  assert.match(html, /badge-warn[^>]*>\s*<!--\s*-->\s*Cached|badge-warn[^>]*>Cached/)
  assert.ok(html.includes('subagent-worktree-badge'))
  assert.ok(html.includes('helm/wf-hello'))
  assert.ok(html.includes('Isolated worktree: /root/code/helm/.worktrees/wf-hello'))
  assert.ok(html.includes('Action'))
  assert.ok(html.includes('Final output'))
  assert.match(html, /workflow-result-preview[^>]*>[^<]*docs\/report\.md/)
  assert.ok(html.includes('docs/report.md'))
  assert.ok(html.includes('Completed'))
  assert.ok(html.includes('Nodes 3/3'))
  assert.ok(html.includes('Tokens'))
})

test('SSR：一体化整卡无任何并排查看 / 分屏按钮（最新交互约定）', { timeout: 60_000 }, async () => {
  const html = await renderHelloRun()
  assert.ok(!html.includes('并排查看'))
  assert.ok(!html.includes('subagent-split-btn'))
  assert.ok(!html.includes('workbench-split-btn'))
  assert.ok(!html.includes('在分屏并排打开'))
})

test('SSR：断点恢复按钮仅 DSL 工作流可见，后台单子代理不显示', { timeout: 60_000 }, async () => {
  const dslFailed = await renderWorkflowWorkbench({
    runs: [run({ id: 'wf_dsl', kind: 'workflow', status: 'failed', error: '阶段实现失败', parentToolCallId: 'call-dsl', nodes: [node({ id: 'a', status: 'failed', error: 'gate 未通过' })] })],
  })
  assert.ok(dslFailed.includes('Resume from checkpoint'))
  assert.ok(dslFailed.includes('Failed'))
  assert.ok(dslFailed.includes('gate 未通过'))

  const subagentFailed = await renderWorkflowWorkbench({
    runs: [run({ id: 'wf_sub', kind: 'subagent', status: 'failed', error: '子代理异常退出', parentToolCallId: 'call-sub', nodes: [node({ id: 'a', status: 'failed' })] })],
  })
  assert.ok(!subagentFailed.includes('Resume from checkpoint'))
})

test('SSR：running 工作流显示中止按钮与执行中徽章', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowWorkbench({
    runs: [run({ id: 'wf_live', status: 'running', parentToolCallId: 'call-run', nodes: [node({ id: 'a', status: 'running', conversationId: 11, phaseTitle: '调研' })] })],
  })
  assert.ok(html.includes('Abort'))
  assert.ok(html.includes('Running'))
  assert.ok(!html.includes('Move to background'))
})

test('canDetachForegroundRun：仅运行中前台同步 + 发起会话 + human（或缺省）查看方可见', { timeout: 60_000 }, () => {
  const fg = run({ id: 'wf_fg', status: 'running', syncForeground: true, conversationId: 1 })
  assert.equal(m.canDetachForegroundRun(fg, { conversationId: 1, ownedBy: 'human' }), true)
  assert.equal(m.canDetachForegroundRun(fg, { conversationId: 1 }), true)
  assert.equal(m.canDetachForegroundRun(fg, { conversationId: 1, ownedBy: 'helm' }), false)
  assert.equal(m.canDetachForegroundRun(fg, { conversationId: 1, ownedBy: 'bot' }), false)
  assert.equal(m.canDetachForegroundRun(fg, { conversationId: 2 }), false)
  assert.equal(m.canDetachForegroundRun(fg, undefined), false)
  assert.equal(m.canDetachForegroundRun(run({ id: 'wf_d', status: 'running', syncForeground: true, detachedAt: 1, conversationId: 1 }), { conversationId: 1 }), false)
  assert.equal(m.canDetachForegroundRun(run({ id: 'wf_t', status: 'completed', syncForeground: true, conversationId: 1 }), { conversationId: 1 }), false)
  assert.equal(m.canDetachForegroundRun(run({ id: 'wf_b', status: 'running', conversationId: 1 }), { conversationId: 1 }), false)
})

test('SSR：前台同步 run 仅在查看会话即发起会话且 human 归属时显示「转入后台」', { timeout: 60_000 }, async () => {
  const visible = await renderWorkflowWorkbench(
    { runs: [run({ id: 'wf_fg', status: 'running', syncForeground: true, parentToolCallId: 'call-fg', nodes: [node({ id: 'a', status: 'running' })] })] },
    [],
    summary(1, 'working'),
  )
  assert.ok(visible.includes('Move to background'))

  const humanViewer = await renderWorkflowWorkbench(
    { runs: [run({ id: 'wf_fg_h', status: 'running', syncForeground: true, parentToolCallId: 'call-fg-h', nodes: [node({ id: 'a', status: 'running' })] })] },
    [{ ...summary(1, 'working'), ownedBy: 'human' }],
    { ...summary(1, 'working'), ownedBy: 'human' },
  )
  assert.ok(humanViewer.includes('Move to background'))

  for (const ownedBy of ['helm', 'bot'] as const) {
    const automationViewer = await renderWorkflowWorkbench(
      { runs: [run({ id: 'wf_fg_a', status: 'running', syncForeground: true, parentToolCallId: 'call-fg-a', nodes: [node({ id: 'a', status: 'running' })] })] },
      [{ ...summary(1, 'working'), ownedBy }],
      { ...summary(1, 'working'), ownedBy },
    )
    assert.ok(!automationViewer.includes('Move to background'))
  }

  const detached = await renderWorkflowWorkbench(
    { runs: [run({ id: 'wf_fg2', status: 'running', syncForeground: true, detachedAt: 123, parentToolCallId: 'call-fg2', nodes: [node({ id: 'a', status: 'running' })] })] },
    [],
    summary(1, 'working'),
  )
  assert.ok(!detached.includes('Move to background'))

  const otherConv = await renderWorkflowWorkbench(
    { runs: [run({ id: 'wf_fg3', conversationId: 2, status: 'running', syncForeground: true, parentToolCallId: 'call-fg3', nodes: [node({ id: 'a', status: 'running' })] })] },
    [summary(1, 'working'), summary(2, 'working', 1)],
    summary(1, 'working'),
  )
  assert.ok(!otherConv.includes('Move to background'))

  const settled = await renderWorkflowWorkbench(
    { runs: [run({ id: 'wf_fg4', status: 'completed', syncForeground: true, parentToolCallId: 'call-fg4', nodes: [node({ id: 'a', status: 'done' })] })] },
    [],
    summary(1, 'working'),
  )
  assert.ok(!settled.includes('Move to background'))
})

test('SSR：WorkflowWorkbenchPanel 空态显示占位文案', { timeout: 60_000 }, async () => {
  setWorkflowClientStub({})
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const html = renderToString(
    e(SDK.PluginClientContext.Provider, { value: stubCtx }, e(WorkflowWorkbenchPanel, { conversation: summary(1, 'idle') })),
  )
  assert.ok(html.includes('No workflow or subagent runs in this conversation yet.'))
})

test('SSR：WorkflowWorkbenchPanel 列出当前会话工作流与子代理', { timeout: 60_000 }, async () => {
  const wf = run({ id: 'wf_list', name: '列表工作流', status: 'running', parentToolCallId: 'c9' })
  const child12 = { ...summary(12, 'working', 1), doing: '正在跑测试' }
  const sub12 = subagentRun('wf_12', 1, 12, 'running')
  setWorkflowClientStub({
    docValue: { runs: [wf, sub12] },
    conversations: [child12],
    conversation: (id) =>
      id === 12
        ? { summary: child12, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowWorkbenchPanel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
  const html = renderToString(
    e(SDK.PluginClientContext.Provider, { value: stubCtx }, e(WorkflowWorkbenchPanel, { conversation: summary(1, 'idle') })),
  )
  assert.ok(html.includes('Current conversation tasks'))
  assert.ok(html.includes('Workflow library'))
  assert.ok(html.includes('列表工作流'))
  assert.ok(html.includes('正在跑测试'))
})

test('SSR：外部 agent 节点与 cached 无会话节点不伪造子会话或误标为动作', { timeout: 60_000 }, async () => {
  const html = await renderWorkflowWorkbench({
    runs: [
      run({
        parentToolCallId: 'external-call',
        status: 'completed',
        nodes: [
          node({ id: 'external', kind: 'agent', status: 'done', executionId: 'pane-42', label: '外部实现者', output: '完成' }),
          node({ id: 'cached', kind: 'agent', status: 'done', cached: true, label: '复用缓存', output: '缓存结果' }),
        ],
      }),
    ],
  })
  assert.ok(!html.includes('subagent-card-clickable'))
  assert.ok(!html.includes('Subagent #'))
  assert.ok(!html.includes('workflow-action-card'))
  assert.ok(html.includes('External run') && html.includes('pane-42'))
  assert.ok(html.includes('Cached') && html.includes('缓存结果'))
})

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

test('SSR：resumedByRunId 已接管隐藏恢复入口；工作台批量恢复按钮显隐与零 Emoji', { timeout: 60_000 }, async () => {
  const conv11 = summary(11, 'error', 1)
  const takenDsl = run({
    id: 'wf_dsl_taken',
    kind: 'workflow',
    status: 'failed',
    resumedByRunId: 'wf_dsl_new',
    parentToolCallId: 'c1',
    nodes: [node({ id: 'a', status: 'failed' })],
  })
  const takenHtml = await renderWorkflowWorkbench({ runs: [takenDsl] })
  assert.ok(!takenHtml.includes('Resume from checkpoint'))
  assert.ok(!takenHtml.includes('Resume failed'))

  const resumableSub = run({
    id: 'wf_sub_fail',
    kind: 'subagent',
    status: 'failed',
    parentToolCallId: 'c2',
    nodes: [node({ id: 's', status: 'failed', conversationId: 11 })],
  })
  const subHtml = await renderWorkflowWorkbench({ runs: [resumableSub] }, [conv11])
  assert.ok(subHtml.includes('Resume failed (1)'))
  assert.ok(subHtml.includes('Resume this background subagent task'))
  assert.ok(!EMOJI_RE.test(subHtml))
})

// ---------------------------------------------------------------------------
// 回归：瘦身 runs 投影（hasResult + resultPreview，无 result）按需 inspect 完整结果
// ---------------------------------------------------------------------------

test('WorkflowRunCard / WorkflowWorkbenchPanel：瘦身 run 展示 resultPreview，展开才调 inspect 拉取完整结果并缓存', { timeout: 60_000 }, async () => {
  mountSharedPluginNamespaces({ realHooks: true })
  try {
    const slimRun = run({
      id: 'wf_slim',
      name: '瘦身工作流',
      kind: 'workflow',
      status: 'completed',
      createdAt: 1_000,
      updatedAt: 2_000,
      hasResult: true,
      resultPreview: '首行瘦身预览结论…',
      nodes: [node({ id: 'a', kind: 'action', status: 'done', label: '打包' })],
    })
    let resolveInspect: ((v: unknown) => void) | undefined
    const h = createWorkflowHostHarness({
      conversationId: 1,
      runsByConversation: { 1: [slimRun] },
      onAction: async (_pluginId, actionId) => {
        if (actionId === 'inspect') {
          return await new Promise((resolve) => {
            resolveInspect = resolve
          })
        }
        return {}
      },
    })
    const mod = await importWorkflowClientModule('index.tsx')
    const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
    const mounted = h.mountNode(e(Panel, { conversation: summary(1, 'idle') }))
    try {
      // 1) 折叠态展示 resultPreview 与「Expand full result」按钮，且零 inspect 请求。
      assert.ok(mounted.container.textContent?.includes('首行瘦身预览结论…'), '应渲染 resultPreview')
      assert.equal(h.log.actions.filter((a) => a.actionId === 'inspect').length, 0, '折叠态绝不预拉 inspect')
      const expandBtn = [...mounted.container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Expand full result'),
      ) as HTMLButtonElement | undefined
      assert.ok(expandBtn, 'hasResult: true 时应提供展开完整结果按钮')

      // 2) 点击展开：触发 inspect({ runId: 'wf_slim' })，等待期展示 loading。
      act(() => {
        expandBtn.click()
      })
      assert.deepEqual(
        h.log.actions.filter((a) => a.actionId === 'inspect'),
        [{ pluginId: 'builtin:workflow', actionId: 'inspect', input: { runId: 'wf_slim' } }],
      )
      assert.ok(mounted.container.textContent?.includes('Loading full result…'), '加载中应显示 loading 态')

      // 3) inspect 返回完整结果后展示完整 JSON。
      await act(async () => {
        resolveInspect?.({
          run: { ...slimRun, result: { summary: '完整最终结论', count: 42 } },
        })
      })
      assert.ok(mounted.container.textContent?.includes('完整最终结论'), '展开后展示完整 result')
      assert.ok(mounted.container.textContent?.includes('42'))

      // 4) 收起再重新展开：命中缓存，不重复调 inspect。
      const collapseBtn = [...mounted.container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Collapse full result'),
      ) as HTMLButtonElement
      act(() => {
        collapseBtn.click()
      })
      assert.ok(mounted.container.textContent?.includes('首行瘦身预览结论…'))
      const expandAgainBtn = [...mounted.container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Expand full result'),
      ) as HTMLButtonElement
      act(() => {
        expandAgainBtn.click()
      })
      assert.equal(
        h.log.actions.filter((a) => a.actionId === 'inspect').length,
        1,
        '同一 (runId, updatedAt) 再次展开应命中缓存，不重复发 inspect 请求',
      )
      assert.ok(mounted.container.textContent?.includes('完整最终结论'))
    } finally {
      mounted.unmount()
    }
  } finally {
    mountSharedPluginNamespaces({ realHooks: false })
  }
})

test('WorkflowRunResultBox：inspect 失败时显式展示错误信息（绝不伪造结果）', { timeout: 60_000 }, async () => {
  mountSharedPluginNamespaces({ realHooks: true })
  try {
    const slimRun = run({
      id: 'wf_inspect_err',
      kind: 'workflow',
      status: 'completed',
      hasResult: true,
      resultPreview: '预览内容',
      nodes: [],
    })
    const h = createWorkflowHostHarness({
      conversationId: 1,
      runsByConversation: { 1: [slimRun] },
      onAction: async (_p, actionId) => {
        if (actionId === 'inspect') throw new Error('disk read failed')
        return {}
      },
    })
    const mod = await importWorkflowClientModule('index.tsx')
    const Panel = mod['WorkflowWorkbenchPanel'] as (p: WorkbenchPanelProps) => React.ReactElement
    const mounted = h.mountNode(e(Panel, { conversation: summary(1, 'idle') }))
    try {
      const expandBtn = [...mounted.container.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Expand full result'),
      ) as HTMLButtonElement
      await act(async () => {
        expandBtn.click()
      })
      await act(async () => {})
      assert.ok(mounted.container.textContent?.includes('Failed to load full result: disk read failed'))
    } finally {
      mounted.unmount()
    }
  } finally {
    mountSharedPluginNamespaces({ realHooks: false })
  }
})

test('resolveWorkflowRunDisplayName 与 SSR：run.name 为占位/runId 时优先取 description 首行，kv-grid 保留 run.id', { timeout: 60_000 }, async () => {
  assert.equal(m.resolveWorkflowRunDisplayName(run({ id: 'wf_1', name: '发布流水线', description: '详细说明' })), '发布流水线')
  assert.equal(
    m.resolveWorkflowRunDisplayName(run({ id: 'wf_2', name: 'wf_2', description: '每日构建与回归检查\n第二行' })),
    '每日构建与回归检查',
  )
  assert.equal(
    m.resolveWorkflowRunDisplayName(run({ id: 'wf_3', name: 'subagent:herdr:pi', description: '修复 lint 错误' })),
    '修复 lint 错误',
  )
  assert.equal(m.resolveWorkflowRunDisplayName(run({ id: 'wf_4', name: 'wf_4' })), 'wf_4')

  const unnamedRun = run({
    id: 'wf_fallback_desc',
    name: 'wf_fallback_desc',
    description: '端到端冒烟验收\n第二行详情',
    status: 'completed',
    parentToolCallId: 'call_fallback',
    nodes: [node({ id: 'a', kind: 'action', status: 'done', label: '步骤一' })],
  })
  const toolHtml = await renderWorkflowToolView(
    { callId: 'call_fallback', toolName: 'SubagentWorkflow', status: 'done', conversationId: 1, siblingCalls: [] },
    { runs: [unnamedRun] },
  )
  assert.ok(toolHtml.includes('端到端冒烟验收'), 'WorkflowToolView 应主显 description 首行')
  assert.ok(!toolHtml.includes('wf_fallback_desc'), 'WorkflowToolView 不应回退暴露 runId 充当标题')

  const wbHtml = await renderWorkflowWorkbench({ runs: [unnamedRun] })
  assert.match(wbHtml, /<strong>端到端冒烟验收<\/strong>/, 'WorkflowRunCardBody 头部应主显 description 首行')
  assert.ok(wbHtml.includes('wf_fallback_desc'), '展开卡片 kv-grid 元数据保留 run.id')
})
