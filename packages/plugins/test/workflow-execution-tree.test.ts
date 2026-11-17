/**
 * builtin:workflow 统一执行树（ExecutionTree / ExecutionNode）测试：
 * - 纯逻辑（真实 esbuild 编译产物 models.ts）：以 `runs`（WorkflowRunSummary）为唯一根来源，
 *   状态自底向上聚合（blocked > error > working > done > pending）、子树完成/运行计数、
 *   前线活动摘要、后代审批摘要、任意深度构树（沿 `runsByParent` 递归）、DSL run 认领挂载 /
 *   后台 subagent run 关联 / 外部执行 / run-only 会话不虚构 summary、成环防御；
 * - 回归防护：人类 fork 分支会话（ownedBy: 'human', parentConversationId=1, 无 WorkflowRun）
 *   与 SuperAgent 驻留 Worker（parentConversationId=1, 无 WorkflowRun）绝不混入
 *   buildExecutionTree、WorkflowWorkbenchPanel 与 WorkflowActiveTray；
 * - 组件交互：工作台父卡下一级紧凑子项、点击/回车/空格打开任意深度会话抽屉、紧凑子项不冒泡。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginClientContext as PluginClientContextType } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  SDK,
  act,
  createRoot,
  importWorkflowClientModule,
  importWorkflowModels,
  makeConvSummary,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client-harness.js'

const e = React.createElement
mountSharedPluginNamespaces()
const m = await importWorkflowModels()

function summary(
  id: number,
  status: ConversationSummary['status'],
  parent?: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return makeConvSummary(id, {
    status,
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
    ...overrides,
  })
}

function node(partial: Partial<WorkflowNodeState> & { id: string }): WorkflowNodeState {
  return { kind: 'agent', status: 'done', ...partial }
}

function run(partial: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 'wf_tree',
    name: '执行树工作流',
    conversationId: 1,
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...partial,
  }
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
    name: 'subagent',
    conversationId: parentConversationId,
    status,
    nodes: [
      node({
        id: `n-${childConversationId}`,
        kind: 'agent',
        status: status === 'running' ? 'running' : status === 'failed' || status === 'aborted' ? 'failed' : 'done',
        conversationId: childConversationId,
      }),
    ],
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 纯逻辑：状态聚合与叶子状态推导
// ---------------------------------------------------------------------------

test('aggregateExecutionStatuses：blocked > error > working 优先；done 仅全完成，pending 不被 done 掩盖，空集 pending', { timeout: 60_000 }, () => {
  assert.equal(m.aggregateExecutionStatuses([]), 'pending')
  assert.equal(m.aggregateExecutionStatuses(['done', 'done']), 'done')
  assert.equal(m.aggregateExecutionStatuses(['pending', 'done']), 'pending', '存在 pending 不得被判成整体完成')
  assert.equal(m.aggregateExecutionStatuses(['done', 'pending', 'done']), 'pending')
  assert.equal(m.aggregateExecutionStatuses(['done', 'working']), 'working')
  assert.equal(m.aggregateExecutionStatuses(['working', 'error']), 'error')
  assert.equal(m.aggregateExecutionStatuses(['error', 'blocked']), 'blocked')
  assert.equal(m.aggregateExecutionStatuses(['done', 'pending', 'working', 'error', 'blocked']), 'blocked')
})

test('executionConversationStatus：与卡片徽章同源，后台 run 未终结绝不假完成；AskDoc 有单即 blocked', { timeout: 60_000 }, () => {
  assert.equal(m.executionConversationStatus(summary(11, 'blocked'), undefined), 'blocked')
  assert.equal(m.executionConversationStatus(summary(11, 'working'), undefined), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'done'), run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'failed' })), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'aborted' })), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'error'), undefined), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'done'), undefined), 'done')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'completed' })), 'done')
  assert.equal(m.executionConversationStatus(summary(11, 'working', undefined, { pendingAskCount: 1 }), undefined), 'blocked')
  assert.equal(m.executionConversationStatus(summary(11, 'working', undefined, { pendingAskCount: 2 }), undefined), 'blocked')
  assert.equal(m.executionConversationStatus(summary(11, 'working', undefined, { pendingAskCount: 0 }), undefined), 'working')
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'completed' })), 'done')
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'failed' })), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'done'), undefined, 'running'), 'working')
  assert.equal(m.executionConversationStatus(undefined, undefined, 'unknown'), 'pending')
  assert.equal(m.executionConversationStatus(undefined, undefined), 'pending')
})

test('executionRunStatus / executionRunNodeStatus：run 与节点状态映射（skipped 视为完成）', { timeout: 60_000 }, () => {
  assert.equal(m.executionRunStatus({ status: 'running' }), 'working')
  assert.equal(m.executionRunStatus({ status: 'completed' }), 'done')
  assert.equal(m.executionRunStatus({ status: 'failed' }), 'error')
  assert.equal(m.executionRunStatus({ status: 'aborted' }), 'error')
  assert.equal(m.executionRunNodeStatus({ status: 'pending' }), 'pending')
  assert.equal(m.executionRunNodeStatus({ status: 'running' }), 'working')
  assert.equal(m.executionRunNodeStatus({ status: 'failed' }), 'error')
  assert.equal(m.executionRunNodeStatus({ status: 'done' }), 'done')
  assert.equal(m.executionRunNodeStatus({ status: 'skipped' }), 'done')
})

test('executionToolStatus：summary working/blocked → running，error → error，run 状态参与', { timeout: 60_000 }, () => {
  assert.equal(m.executionToolStatus(summary(11, 'working'), undefined), 'running')
  assert.equal(m.executionToolStatus(summary(11, 'blocked'), undefined), 'running')
  assert.equal(m.executionToolStatus(summary(11, 'error'), undefined), 'error')
  assert.equal(m.executionToolStatus(summary(11, 'done'), undefined), 'done')
  assert.equal(m.executionToolStatus(undefined, run({ status: 'running' })), 'running')
  assert.equal(m.executionToolStatus(undefined, run({ status: 'failed' })), 'error')
  assert.equal(m.executionToolStatus(undefined, undefined), 'done')
})

// ---------------------------------------------------------------------------
// 纯逻辑：runs 为唯一根源（回归：人类 fork 与 SuperAgent Worker 绝不泄漏）
// ---------------------------------------------------------------------------

test('buildExecutionTree 回归：人类 fork 会话与 SuperAgent 驻留 Worker（无 WorkflowRun）绝不进入执行树或活跃托盘', { timeout: 60_000 }, async () => {
  const humanFork = summary(50, 'working', 1, { ownedBy: 'human', title: '人类分叉分支', doing: '人类正在对话' })
  const superagentWorker = summary(60, 'working', 1, {
    ownedBy: 'bot',
    tags: ['worker'],
    profileId: 'coder',
    title: 'SuperAgent Worker',
    doing: 'Worker 正在执行',
  })
  const realSubagent = summary(11, 'working', 1, { ownedBy: 'helm', title: '真子代理', doing: '真实子代理任务' })

  const conversations = [summary(1, 'idle', undefined, { ownedBy: 'human' }), humanFork, superagentWorker, realSubagent]

  // runs 为空时：即便存在 parentConversationId=1 的人类 fork 与 SuperAgent worker，执行树也必须为空！
  assert.deepEqual(m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] }), [])

  // 有真实 subagent run 时：仅挂载 run 认领的 #11，fork #50 与 worker #60 仍被严格排除
  const runs = [subagentRun('wf_real_11', 1, 11, 'running')]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(
    tree.map((n) => n.conversationId),
    [11],
    '执行树只允许挂载 runs 认领的子会话，人类 fork 与 SuperAgent worker 绝不混入',
  )
  const tray = m.buildActiveTraySummary({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(
    tray.items.map((item) => item.conversationId),
    [11],
    '活跃托盘同样只认 runs，不误报人类 fork 或 SuperAgent worker',
  )

  // 工作台渲染验证：仅渲染 #11，绝不出现 fork #50 或 worker #60
  setWorkflowClientStub({
    docValue: { runs },
    conversations,
    conversation: (id) => ({
      summary: conversations.find((c) => c.id === id),
      detail: undefined,
      live: undefined,
      pendingAsks: [],
      loadError: undefined,
      reload: () => {},
    }),
  })
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(makeSpyCtx(), e(Panel, { conversation: conversations[0] }))
  try {
    assert.ok(host.textContent!.includes('真子代理'))
    assert.ok(!host.textContent!.includes('人类分叉分支'), '工作台不得泄露人类 fork 分支')
    assert.ok(!host.textContent!.includes('SuperAgent Worker'), '工作台不得泄露 SuperAgent worker')
  } finally {
    unmount()
  }
})

// ---------------------------------------------------------------------------
// 纯逻辑：buildExecutionTree 任意深度构树与聚合
// ---------------------------------------------------------------------------

test('buildExecutionTree：任意深度递归 + 状态自底向上聚合 + 子树完成/运行计数', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'working'),
    summary(11, 'done', 1, { updatedAt: 40 }),
    summary(21, 'working', 11, { updatedAt: 30, doing: 'bash: pnpm test' }),
    summary(31, 'blocked', 21, { updatedAt: 20, title: '确认删除文件' }),
    summary(32, 'done', 21, { updatedAt: 25 }),
  ]
  const runs = [
    subagentRun('wf_11', 1, 11, 'completed'),
    subagentRun('wf_21', 11, 21, 'running'),
    subagentRun('wf_31', 21, 31, 'running'),
    subagentRun('wf_32', 21, 32, 'completed'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.equal(tree.length, 1, '根会话仅 #11 一个直接子节点')
  const child = tree[0]!
  assert.equal(child.kind, 'conversation')
  assert.equal(child.conversationId, 11)
  assert.equal(child.status, 'done', '自身状态为真实 done')
  assert.equal(child.aggregated.status, 'blocked')
  assert.equal(child.aggregated.total, 4, '子树含 11/21/31/32 共 4 节点')
  assert.equal(child.aggregated.done, 2, '11 与 32 完成')
  assert.equal(child.aggregated.running, 1, '21 执行中')
  assert.equal(child.aggregated.blocked, 1, '31 等待审批')
  assert.equal(child.aggregated.error, 0)

  const grand = child.children[0]!
  assert.equal(grand.conversationId, 21)
  assert.equal(grand.status, 'working')
  assert.equal(grand.aggregated.status, 'blocked')
  assert.deepEqual(
    grand.children.map((n) => n.conversationId),
    [31, 32],
    '三级节点按 Active-First：blocked 在 done 前',
  )
  assert.equal(grand.children[0]!.children.length, 0, '叶子无子节点')
})

test('buildExecutionTree：DSL run 认领的会话挂 run 节点下，孙代递归挂在会话节点下', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1),
    summary(21, 'working', 11, { doing: '正在实现' }),
    summary(99, 'idle', 2),
  ]
  const runs = [
    run({
      id: 'wf_dsl',
      kind: 'workflow',
      status: 'running',
      parentToolCallId: 'wf_call',
      nodes: [
        node({ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, label: '实现者' }),
        node({ id: 'n2', kind: 'action', status: 'done', label: '落盘' }),
      ],
    }),
    subagentRun('wf_21', 11, 21, 'running'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.equal(tree.length, 1, '#11 被 DSL run 认领，不再作为根的直接会话子节点')
  const wfNode = tree[0]!
  assert.equal(wfNode.kind, 'workflow')
  assert.equal(wfNode.run?.id, 'wf_dsl')
  assert.equal(wfNode.children.length, 2)
  const convChild = wfNode.children.find((c) => c.kind === 'conversation')!
  assert.equal(convChild.conversationId, 11)
  assert.equal(convChild.runNode?.id, 'n1', '保留 run 内原始节点关联')
  assert.deepEqual(
    convChild.children.map((c) => c.conversationId),
    [21],
    '认领会话的孙代递归挂在会话节点下',
  )
  const actionChild = wfNode.children.find((c) => c.kind === 'workflow-node')!
  assert.equal(actionChild.runNode?.id, 'n2')
  assert.equal(actionChild.status, 'done')
  assert.equal(wfNode.aggregated.total, 3, 'workflow 容器壳不计自身，仅计 3 项真实执行')
  assert.equal(wfNode.aggregated.done, 1)
  assert.equal(wfNode.aggregated.running, 2)
  assert.equal(wfNode.aggregated.status, 'working')
})

test('buildExecutionTree：后台单子代理 run 关联直接子会话；会话缺失仅携带 run；无会话后台任务为外部执行', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(12, 'idle', 1, { parentToolCallId: 'call_new', updatedAt: 5 }),
  ]
  const runs = [
    run({
      id: 'wf_a',
      kind: 'subagent',
      status: 'running',
      parentToolCallId: 'call_new',
      nodes: [node({ id: 'n', status: 'running', conversationId: 12 })],
    }),
    run({
      id: 'wf_b',
      kind: 'subagent',
      status: 'running',
      nodes: [node({ id: 'n', status: 'running', conversationId: 77 })],
    }),
    run({
      id: 'wf_c',
      kind: 'subagent',
      status: 'failed',
      nodes: [node({ id: 'n', status: 'failed', executionId: 'pane-9' })],
    }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const conv12 = tree.find((n) => n.conversationId === 12)!
  assert.ok(conv12 !== undefined)
  assert.equal(conv12.run?.id, 'wf_a', '后台 run 按 parentToolCallId 精确关联')
  assert.equal(conv12.status, 'working', '会话 idle + run running 不假完成')
  const conv77 = tree.find((n) => n.conversationId === 77)!
  assert.ok(conv77 !== undefined, '会话列表缺失时仍以 run 认领的 conversationId 呈现')
  assert.equal(conv77.summary, undefined, '不得虚构 ConversationSummary')
  assert.equal(conv77.run?.id, 'wf_b')
  assert.equal(conv77.status, 'working')
  const external = tree.find((n) => n.kind === 'external')!
  assert.ok(external !== undefined, '无会话关联的后台 run 为外部执行节点')
  assert.equal(external.run?.id, 'wf_c')
  assert.equal(external.status, 'error')
  assert.equal(external.children.length, 1, 'run 内节点为外部执行节点的叶子')
  assert.equal(external.aggregated.total, 1, '外部 run 壳不计自身：run 内节点即唯一真实执行')
  assert.equal(external.aggregated.error, 1)
})

test('buildExecutionTree：Active-First 排序 blocked > working > error > done，同级 updatedAt 降序', { timeout: 60_000 }, () => {
  const conversations = [
    summary(41, 'idle', 1, { updatedAt: 5 }),
    summary(42, 'error', 1, { updatedAt: 4 }),
    summary(43, 'working', 1, { updatedAt: 3 }),
    summary(44, 'blocked', 1, { updatedAt: 2 }),
    summary(45, 'done', 1, { updatedAt: 99 }),
  ]
  const runs = [
    subagentRun('wf_41', 1, 41, 'completed', { updatedAt: 5 }),
    subagentRun('wf_42', 1, 42, 'failed', { updatedAt: 4 }),
    subagentRun('wf_43', 1, 43, 'running', { updatedAt: 3 }),
    subagentRun('wf_44', 1, 44, 'running', { updatedAt: 2 }),
    subagentRun('wf_45', 1, 45, 'completed', { updatedAt: 99 }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  assert.deepEqual(
    tree.map((n) => n.conversationId),
    [44, 43, 42, 45, 41],
  )
})

test('buildExecutionTree：parentConversationId / run 链成环时按祖先链防御性截断，不死循环', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 21),
    summary(21, 'done', 11),
  ]
  const runs = [
    run({
      id: 'wf_x',
      kind: 'workflow',
      status: 'completed',
      nodes: [node({ id: 'n1', kind: 'agent', status: 'done', conversationId: 21 })],
    }),
    subagentRun('wf_loop_11', 21, 11, 'completed'),
    subagentRun('wf_loop_21', 11, 21, 'completed'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const wf = tree[0]!
  const conv21 = wf.children[0]!
  assert.equal(conv21.conversationId, 21)
  assert.deepEqual(
    conv21.children.map((c) => c.conversationId),
    [11],
  )
  assert.equal(conv21.children[0]!.children.length, 0, '祖先链上的会话不再重复展开')
})

// ---------------------------------------------------------------------------
// 纯逻辑：前线活动 / 后代审批 / 标题 / 合并聚合
// ---------------------------------------------------------------------------

test('collectExecutionFrontline：深度优先收集子树 working 节点 doing 摘要（至多 limit 条）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1),
    summary(21, 'working', 11, { doing: 'bash: pnpm test' }),
    summary(22, 'done', 11),
    summary(23, 'working', 11, { doing: '读取 a.ts' }),
  ]
  const runs = [
    subagentRun('wf_11', 1, 11, 'completed'),
    subagentRun('wf_21', 11, 21, 'running'),
    subagentRun('wf_22', 11, 22, 'completed'),
    subagentRun('wf_23', 11, 23, 'running'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const items = m.collectExecutionFrontline(tree, 2)
  assert.deepEqual(
    items.map((item) => item.text),
    ['#21 bash: pnpm test', '#23 读取 a.ts'],
  )
  assert.equal(m.collectExecutionFrontline(tree, 1).length, 1, 'limit 生效')

  const noDoing = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [summary(1, 'idle'), summary(21, 'working', 1)],
    runs: [subagentRun('wf_21_solo', 1, 21, 'running')],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(noDoing, 2).map((item) => item.text),
    ['#21 running'],
  )
  assert.deepEqual(
    m.collectExecutionFrontline(noDoing, 2, 'zh-CN').map((item) => item.text),
    ['#21 执行中'],
  )
})

test('collectExecutionApprovals：收集子树 blocked 会话（#id + 用户标题，不虚构 AskSpec 标题；pendingAskCount>0 同计）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'working', 1),
    summary(21, 'blocked', 11, { title: '确认删除文件' }),
    summary(22, 'working', 11, { pendingAskCount: 1 }),
  ]
  const runs = [
    subagentRun('wf_11', 1, 11, 'running'),
    subagentRun('wf_21', 11, 21, 'running'),
    subagentRun('wf_22', 11, 22, 'running'),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const items = m.collectExecutionApprovals(tree, 3)
  assert.deepEqual(
    items.map((item) => item.text),
    ['确认删除文件 (#21) awaiting approval', '#22 awaiting approval'],
    'status=blocked 与 pendingAskCount>0（AskDoc 有单）均计为等待审批',
  )
  assert.deepEqual(
    m.collectExecutionApprovals(tree, 3, 'zh-CN').map((item) => item.text),
    ['确认删除文件 (#21) 等待审批', '#22 等待审批'],
  )
  assert.equal(items[0]!.conversationId, 21)
  assert.equal(m.collectExecutionApprovals(tree, 1).length, 1, 'limit 生效')
})

test('collectExecutionFrontline：后序最深活跃优先，父级等待兜底不抢占，自身实际工作保留', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'working', 1),
    summary(21, 'working', 11, { doing: 'bash: pnpm test' }),
    summary(22, 'working', 11, { doing: '读取 a.ts' }),
  ]
  const tree = m.buildExecutionTree({
    rootConversationId: 1,
    conversations,
    runs: [
      subagentRun('wf_11', 1, 11, 'running'),
      subagentRun('wf_21', 11, 21, 'running'),
      subagentRun('wf_22', 11, 22, 'running'),
    ],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(tree, 2).map((item) => item.text),
    ['#21 bash: pnpm test', '#22 读取 a.ts'],
  )
  const parentDoing = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [
      summary(1, 'idle'),
      summary(11, 'working', 1, { doing: '审阅产出' }),
      summary(21, 'working', 11, { doing: 'bash: pnpm test' }),
    ],
    runs: [subagentRun('wf_11', 1, 11, 'running'), subagentRun('wf_21', 11, 21, 'running')],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(parentDoing, 2).map((item) => item.text),
    ['#21 bash: pnpm test', '#11 审阅产出'],
  )
  const wfFront = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [summary(1, 'idle')],
    runs: [
      run({
        id: 'wf_front',
        kind: 'workflow',
        status: 'running',
        name: '前线工作流',
        nodes: [node({ id: 'n1', kind: 'action', status: 'running', label: '落盘动作' })],
      }),
    ],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(wfFront, 2).map((item) => item.text),
    ['落盘动作 running'],
    '唯一前线为最深节点，容器壳不重复占位',
  )
  assert.deepEqual(
    m.collectExecutionFrontline(wfFront, 2, 'zh-CN').map((item) => item.text),
    ['落盘动作 执行中'],
  )
})

test('buildExecutionTree：同一会话被多个历史/续接 DSL run 引用仅挂载一次，聚合不双计，旧 run 引用保留叶子行', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'working', 1, { doing: '正在实现' }),
  ]
  const runs = [
    run({
      id: 'wf_old',
      kind: 'workflow',
      status: 'completed',
      createdAt: 1_000,
      updatedAt: 2_000,
      nodes: [node({ id: 'n1', kind: 'agent', status: 'done', conversationId: 11, label: '旧实现者' })],
    }),
    run({
      id: 'wf_new',
      kind: 'workflow',
      status: 'running',
      createdAt: 5_000,
      updatedAt: 6_000,
      nodes: [node({ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, label: '续接实现者' })],
    }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const wfNew = tree.find((n) => n.run?.id === 'wf_new')!
  const wfOld = tree.find((n) => n.run?.id === 'wf_old')!
  assert.ok(wfNew !== undefined && wfOld !== undefined)
  assert.equal(wfNew.children[0]!.conversationId, 11, '会话子树归属仍在运行的续接 run')
  assert.equal(wfNew.children[0]!.kind, 'conversation')
  assert.equal(wfOld.children[0]!.kind, 'workflow-node', '旧 run 的引用保留普通叶子行（可显示）')
  assert.equal(wfOld.children[0]!.conversationId, undefined, '旧 run 引用行不携带会话子树')
  assert.equal(wfNew.aggregated.total, 1)
  assert.equal(wfNew.aggregated.running, 1)
  assert.equal(wfOld.aggregated.total, 1, '旧 run 壳不计自身，仅叶子行计 1')
  assert.equal(wfOld.aggregated.done, 1)
  assert.deepEqual(
    m.collectExecutionFrontline(tree, 5).map((item) => item.key),
    ['conv:11'],
  )
})

test('buildExecutionTree：消费含后代的整棵 runs 投影——深层 run 挂回原会话、重复 run id 去重', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'working', 1, { doing: '编排深层任务' }),
    summary(21, 'done', 11),
  ]
  const sub11 = subagentRun('wf_11', 1, 11, 'running')
  const sub21 = subagentRun('wf_21', 11, 21, 'completed')
  const deepExternal = run({
    id: 'wf_ext',
    kind: 'subagent',
    status: 'running',
    conversationId: 11,
    name: '外部任务',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [node({ id: 'n', status: 'running', executionId: 'pane-42' })],
  })
  const deepDsl = run({
    id: 'wf_deep',
    kind: 'workflow',
    status: 'completed',
    conversationId: 21,
    name: '深层工作流',
    createdAt: 3_000,
    updatedAt: 4_000,
    nodes: [node({ id: 'a', kind: 'action', status: 'done', label: '落盘' })],
  })
  const tree = m.buildExecutionTree({
    rootConversationId: 1,
    conversations,
    runs: [sub11, sub21, deepExternal, deepDsl, deepExternal],
  })
  const conv11 = tree[0]!
  assert.equal(conv11.conversationId, 11)
  const ext = conv11.children.find((c) => c.kind === 'external')!
  assert.ok(ext !== undefined, '深层外部执行 run 挂回其发起会话（run.conversationId=11）')
  assert.equal(ext.run!.id, 'wf_ext')
  const conv21 = conv11.children.find((c) => c.conversationId === 21)!
  const deep = conv21.children.find((c) => c.kind === 'workflow')!
  assert.ok(deep !== undefined, '深层会话 21 自己的 DSL run 挂在 21 节点下')
  assert.equal(deep.run!.id, 'wf_deep')

  const runIds: string[] = []
  const walk = (list: ReadonlyArray<{ kind: string; run?: { id: string }; children: readonly unknown[] }>): void => {
    for (const n of list) {
      if (n.kind === 'workflow' || n.kind === 'external') runIds.push(n.run!.id)
      walk(n.children as ReadonlyArray<{ kind: string; run?: { id: string }; children: readonly unknown[] }>)
    }
  }
  walk(tree)
  assert.deepEqual(runIds.sort(), ['wf_deep', 'wf_ext'], '重复 run id 不得重复挂载')
  assert.equal(conv21.aggregated.total, 2)
  assert.equal(conv21.aggregated.done, 2)
})

test('effectiveRunNodeStatus：无子树数据即自身终态；子树未结算不假完成（同源合成）', { timeout: 60_000 }, () => {
  assert.equal(m.effectiveRunNodeStatus({ status: 'completed' }, undefined), 'done')
  assert.equal(
    m.effectiveRunNodeStatus({ status: 'completed' }, { status: 'pending', total: 0, done: 0, running: 0, blocked: 0, error: 0 }),
    'done',
  )
  assert.equal(
    m.effectiveRunNodeStatus({ status: 'completed' }, { status: 'working', total: 2, done: 1, running: 1, blocked: 0, error: 0 }),
    'working',
  )
  assert.equal(
    m.effectiveRunNodeStatus({ status: 'running' }, { status: 'blocked', total: 1, done: 0, running: 0, blocked: 1, error: 0 }),
    'blocked',
  )
  assert.equal(
    m.effectiveRunNodeStatus({ status: 'failed' }, { status: 'done', total: 1, done: 1, running: 0, blocked: 0, error: 0 }),
    'error',
  )
})

test('buildExecutionTree：后代 pendingAskCount>0 冒泡为审批，父 idle 不假完成', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'idle', 1),
    summary(21, 'working', 11, { pendingAskCount: 1, doing: '等待确认删除' }),
  ]
  const tree = m.buildExecutionTree({
    rootConversationId: 1,
    conversations,
    runs: [subagentRun('wf_11', 1, 11, 'completed'), subagentRun('wf_21', 11, 21, 'running')],
  })
  const conv11 = tree[0]!
  assert.equal(conv11.status, 'done', '自身真实终态保持 done')
  assert.equal(conv11.aggregated.status, 'blocked', '后代 AskDoc 有单冒泡：父不得显示整体完成')
  assert.equal(conv11.aggregated.blocked, 1)
  const approvals = m.collectExecutionApprovals(tree, 3)
  assert.deepEqual(approvals.map((a) => a.conversationId), [21])
})

test('aggregateExecutionNodes：合并直接子节点聚合（不含自身）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1),
    summary(21, 'working', 11),
    summary(31, 'blocked', 21),
  ]
  const tree = m.buildExecutionTree({
    rootConversationId: 1,
    conversations,
    runs: [
      subagentRun('wf_11', 1, 11, 'completed'),
      subagentRun('wf_21', 11, 21, 'running'),
      subagentRun('wf_31', 21, 31, 'running'),
    ],
  })
  const merged = m.aggregateExecutionNodes(tree)
  assert.equal(merged.total, 3)
  assert.equal(merged.done, 1)
  assert.equal(merged.running, 1)
  assert.equal(merged.blocked, 1)
  assert.equal(merged.status, 'blocked', '合并状态取最严重')
  assert.deepEqual(m.aggregateExecutionNodes([]), {
    status: 'pending',
    total: 0,
    done: 0,
    running: 0,
    blocked: 0,
    error: 0,
  })
})

test('executionNodeTitle：用户标题 > run 节点 label / prompt > 会话与 run 兜底描述', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1, { title: '修复登录超时' }),
    summary(12, 'done', 1),
  ]
  const runs = [
    run({
      id: 'wf_t',
      kind: 'workflow',
      status: 'completed',
      nodes: [
        node({ id: 'n1', kind: 'agent', status: 'done', conversationId: 11, label: '被用户标题覆盖' }),
        node({ id: 'n2', kind: 'agent', status: 'done', conversationId: 12, label: '调研员' }),
        node({ id: 'n3', kind: 'action', status: 'done', label: '落盘报告' }),
      ],
    }),
    subagentRun('wf_13', 1, 13, 'completed', { nodes: [node({ id: 'n13', status: 'done', conversationId: 13 })] }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const wf = tree.find((n) => n.kind === 'workflow')!
  const titled = wf.children.find((c) => c.conversationId === 11)!
  assert.equal(m.executionNodeTitle(titled), '修复登录超时')
  const labeled = wf.children.find((c) => c.conversationId === 12)!
  assert.equal(m.executionNodeTitle(labeled), '调研员')
  const action = wf.children.find((c) => c.runNode?.id === 'n3')!
  assert.equal(m.executionNodeTitle(action), '落盘报告')
  // 默认标题「子会话 N」/「subagent N」/「子代理 N」不算自定义标题：优先 run.name / runNode.prompt，无可用名称时才兜底
  const plain = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [
      summary(1, 'idle'),
      summary(13, 'done', 1, { title: 'subagent 13' }),
      summary(14, 'done', 1, { title: '子代理 #14' }),
    ],
    runs: [
      subagentRun('wf_13', 1, 13, 'completed', { nodes: [node({ id: 'n13', kind: 'agent', status: 'done', conversationId: 13 })] }),
      subagentRun('wf_sub_named', 1, 14, 'completed', {
        name: '后台代码审查',
        nodes: [node({ id: 's1', kind: 'agent', status: 'done', conversationId: 14 })],
      }),
    ],
  })
  const node13 = plain.find((n) => n.conversationId === 13)!
  const node14 = plain.find((n) => n.conversationId === 14)!
  assert.equal(m.executionNodeTitle(node13), 'Subagent #13')
  assert.equal(m.executionNodeTitle(node13, 'zh-CN'), '子会话 #13')
  assert.equal(m.executionNodeTitle(node14), '后台代码审查')
  // 有可读节点名时，collectExecutionFrontline 携带「名称 (#id) · doing / running」
  const namedFrontline = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [
      summary(1, 'idle'),
      summary(25, 'working', 1, { title: '排查构建失败', doing: 'bash: pnpm test' }),
      summary(26, 'working', 1, { title: '同步状态' }),
    ],
    runs: [
      subagentRun('wf_25', 1, 25, 'running'),
      subagentRun('wf_26', 1, 26, 'running'),
    ],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(namedFrontline, 4).map((item) => item.text),
    ['排查构建失败 (#25) · bash: pnpm test', '同步状态 (#26) running'],
  )
  assert.deepEqual(
    m.collectExecutionFrontline(namedFrontline, 4, 'zh-CN').map((item) => item.text),
    ['排查构建失败 (#25) · bash: pnpm test', '同步状态 (#26) 执行中'],
  )
})

// ---------------------------------------------------------------------------
// 组件交互：工作台下一级紧凑子项与任意深度打开会话
// ---------------------------------------------------------------------------

interface SpyCtx extends PluginClientContextType {
  drawerCalls: number[]
}

function makeSpyCtx(): SpyCtx {
  const drawerCalls: number[] = []
  return {
    pluginId: 'builtin:workflow',
    callAction: async () => undefined,
    submitInput: async () => {},
    getPluginSessionDoc: async () => undefined,
    openScreen: () => {},
    openSplitScreen: () => {},
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
    locale: 'en' as const,
    translate: (text) => SDK.resolveLocalizedText(text, 'en'),
    drawerCalls,
  }
}

async function mountClient(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  await act(async () => {
    root = createRoot(host)
    root.render(e(SDK.PluginClientContext.Provider, { value: ctx }, element))
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root?.unmount())
      host.remove()
    },
  }
}

test('工作台父卡渲染子树徽章 / 前线摘要 / 下一级紧凑子项，点击打开任意深度会话抽屉', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { doing: '正在编排任务', updatedAt: 100 })
  const child21 = summary(21, 'blocked', 11, { title: '确认删除文件', updatedAt: 50 })
  const child31 = summary(31, 'working', 21, { doing: 'bash: pnpm test', updatedAt: 80 })
  const runs = [
    subagentRun('wf_11', 1, 11, 'running'),
    subagentRun('wf_21', 11, 21, 'running'),
    subagentRun('wf_31', 21, 31, 'running'),
  ]
  setWorkflowClientStub({
    docValue: { runs },
    conversations: [child11, child21, child31],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    assert.match(host.textContent!, /Subtree 0\/2/, '应渲染子树完成计数徽章')
    const approvalBadge = host.querySelector('.subagent-live-trigger .badge-warn')
    assert.ok(approvalBadge !== null, '后代审批徽章应渲染')
    assert.match(approvalBadge.getAttribute('title')!, /确认删除文件 \(#21\) awaiting approval/, '审批徽章 title 应含后代审批摘要')
    // 前线活动摘要：深层 #31 working 的 doing 冒泡到父卡
    const frontline = host.querySelector('.execution-frontline')
    assert.ok(frontline !== null, '应渲染前线活动摘要行')
    assert.match(frontline.textContent!, /#31 bash: pnpm test/)
    // 下一级紧凑子项：#21 单行（blocked 变体 + 等待审批徽章 + 子树计数），名称在前、#21 在后
    const rows = host.querySelectorAll('.execution-child-row')
    assert.equal(rows.length, 1, '仅展示父节点下一级紧凑子项')
    const row = rows[0] as HTMLElement
    assert.ok(row.classList.contains('execution-child-blocked'))
    assert.match(row.textContent!, /#21/)
    assert.match(row.textContent!, /确认删除文件/)
    assert.ok(row.textContent!.indexOf('确认删除文件') < row.textContent!.indexOf('#21'), '子项名称应排在 #21 之前')
    assert.match(row.textContent!, /Awaiting approval/)
    assert.match(row.textContent!, /0\/2/, '紧凑子项应携带子树完成计数')
    assert.equal(row.getAttribute('aria-label')?.endsWith('Open conversation #21 drawer'), true, '行 aria-label 含真实抽屉入口语义')
    act(() => {
      row.click()
    })
    assert.deepEqual(spy.drawerCalls, [21], '点击紧凑子项打开 #21，不触发父卡 #11')
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => {
        row.dispatchEvent(event)
      })
      if (key === ' ') assert.equal(event.defaultPrevented, true, '空格不得滚动页面')
    }
    assert.deepEqual(spy.drawerCalls, [21, 21, 21])
    const card = host.querySelector('.subagent-card-clickable') as HTMLElement
    act(() => {
      card.click()
    })
    assert.deepEqual(spy.drawerCalls, [21, 21, 21, 11])
  } finally {
    unmount()
  }
})

test('工作流节点卡内深层子代理同样渲染紧凑子项并可打开任意深度会话', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { doing: '实现中' })
  const child21 = summary(21, 'done', 11, { title: '深层实现', updatedAt: 20 })
  const wf = run({
    id: 'wf_deep',
    kind: 'workflow',
    status: 'running',
    parentToolCallId: 'wf_call',
    nodes: [node({ id: 'n1', kind: 'agent', status: 'running', conversationId: 11, label: '实现者' })],
  })
  const sub21 = subagentRun('wf_21', 11, 21, 'completed')
  setWorkflowClientStub({
    docValue: { runs: [wf, sub21] },
    conversations: [child11, child21],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(Panel, { conversation: summary(1, 'working') }),
  )
  try {
    assert.match(host.textContent!, /Nodes 0\/1/, 'run 自身节点计数保留')
    assert.match(host.textContent!, /Subtree 1\/2/, '深层后代计数以子树徽章展示')
    const rows = host.querySelectorAll('.execution-child-row')
    assert.equal(rows.length, 1)
    const row = rows[0] as HTMLElement
    assert.match(row.textContent!, /深层实现/)
    act(() => {
      row.click()
    })
    assert.deepEqual(spy.drawerCalls, [21], '工作流节点内深层子会话点击可打开')
    const card = host.querySelector('.subagent-card-clickable') as HTMLElement
    act(() => {
      card.click()
    })
    assert.deepEqual(spy.drawerCalls, [21, 11])
  } finally {
    unmount()
  }
})

test('无深层后代时紧凑子项与子树徽章不渲染（不造空占位）', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { doing: '单独执行' })
  setWorkflowClientStub({
    docValue: { runs: [subagentRun('wf_11', 1, 11, 'running')] },
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    assert.ok(host.querySelector('.execution-children') === null)
    assert.ok(host.querySelector('.execution-frontline') === null)
    assert.ok(!/Subtree \d/.test(host.textContent!), '无后代不得渲染子树徽章')
  } finally {
    unmount()
  }
})

test('主徽章同源有效状态：父 idle + 后代 blocked/working 不显示已完成，自身终态另标清楚', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'idle', 1, { updatedAt: 100 })
  const child3 = summary(3, 'working', 11, { doing: '正在编排', updatedAt: 90 })
  const child4 = summary(4, 'working', 11, { doing: '编辑 a.ts', updatedAt: 80 })
  const child5 = summary(5, 'blocked', 11, { title: '确认删除文件', updatedAt: 70 })
  const runs = [
    subagentRun('wf_11', 1, 11, 'completed'),
    subagentRun('wf_3', 11, 3, 'running'),
    subagentRun('wf_4', 11, 4, 'running'),
    subagentRun('wf_5', 11, 5, 'running'),
  ]
  setWorkflowClientStub({
    docValue: { runs },
    conversations: [child11, child3, child4, child5],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    const trigger = host.querySelector('.subagent-live-trigger')!
    assert.ok(trigger !== null)
    const badgeTexts = Array.from(trigger.querySelectorAll('.badge')).map((b) => b.textContent ?? '')
    const lightTexts = Array.from(trigger.querySelectorAll('.helm-status-light')).map((l) => l.textContent ?? '')
    const allTexts = [...badgeTexts, ...lightTexts]
    assert.ok(lightTexts.includes('Awaiting approval'), `主状态灯应为同源有效状态（Awaiting approval），实际：${allTexts.join('|')}`)
    assert.ok(badgeTexts.includes('Self: Done'), '自身终态应另标清楚')
    assert.ok(!badgeTexts.includes('Done'), '不得以孤立的「Done」徽章假完成')
    assert.ok(trigger.querySelector('.helm-status-light-blocked .status-dot-blocked') !== null, 'blocked 为实心 warn 灯')
    const warnBadge = trigger.querySelector('.badge-warn') as HTMLElement
    assert.match(warnBadge.getAttribute('title') ?? '', /确认删除文件 \(#5\) awaiting approval/, '后代审批徽章 title 应含审批摘要')
  } finally {
    unmount()
  }
})

test('自身 AskDoc 有单即等待审批（pendingAskCount>0，status 仍 working 不显示执行中）', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { pendingAskCount: 1, doing: '外部执行等待确认' })
  setWorkflowClientStub({
    docValue: { runs: [subagentRun('wf_11', 1, 11, 'running')] },
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    const trigger = host.querySelector('.subagent-live-trigger')!
    const badgeTexts = Array.from(trigger.querySelectorAll('.badge')).map((b) => b.textContent ?? '')
    const lightTexts = Array.from(trigger.querySelectorAll('.helm-status-light')).map((l) => l.textContent ?? '')
    assert.ok(lightTexts.includes('Awaiting approval'), `AskDoc 有单即等待审批，实际：${[...badgeTexts, ...lightTexts].join('|')}`)
    assert.ok(!lightTexts.includes('Running'), '有单不得仍显示执行中')
  } finally {
    unmount()
  }
})

test('紧凑子项：深层 workflow / external run 行原位展开直系子项（不伪造会话入口）', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { doing: '编排深层任务', updatedAt: 100 })
  const parent11Run = subagentRun('wf_11', 1, 11, 'running')
  const deepDsl = run({
    id: 'wf_deep',
    kind: 'workflow',
    status: 'running',
    conversationId: 11,
    name: '深层工作流',
    createdAt: 3_000,
    updatedAt: 4_000,
    nodes: [node({ id: 'a', kind: 'action', status: 'running', label: '落盘动作' })],
  })
  const deepExternal = run({
    id: 'wf_ext',
    kind: 'subagent',
    status: 'running',
    conversationId: 11,
    name: '外部任务',
    createdAt: 1_000,
    updatedAt: 2_000,
    nodes: [node({ id: 'n', status: 'running', executionId: 'pane-42', label: '终端窗格' })],
  })
  setWorkflowClientStub({
    docValue: { runs: [parent11Run, deepDsl, deepExternal] },
    conversations: [child11],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    const rows = host.querySelectorAll('.execution-child-row')
    assert.equal(rows.length, 2, '深层 run 以紧凑行呈现')
    const dslRow = Array.from(rows).find((r) => (r.textContent ?? '').includes('深层工作流')) as HTMLElement
    const extRow = Array.from(rows).find((r) => (r.textContent ?? '').includes('外部任务')) as HTMLElement
    assert.ok(dslRow !== undefined && extRow !== undefined)
    for (const row of [dslRow, extRow]) {
      assert.ok(row.querySelector('.execution-child-id') === null, '无会话 run 行不得伪造 #id 前缀')
      assert.match(row.getAttribute('aria-label') ?? '', /Expand direct children/, '应提供展开直系子项入口')
      assert.match(row.textContent ?? '', /Running/, 'run 真实状态保留')
      assert.ok(row.querySelector('.helm-status-light .status-dot-working') !== null, '主状态为统一状态灯')
    }
    assert.equal(host.querySelectorAll('.execution-child-row').length, 2, '初始仅两个 run 行')
    act(() => {
      dslRow.click()
    })
    const expandedRows = host.querySelectorAll('.execution-child-row')
    assert.equal(expandedRows.length, 3, '展开后多出直系子项行')
    assert.ok(
      Array.from(expandedRows).some((r) => (r.textContent ?? '').includes('落盘动作')),
      '展开后应显示直系子项行',
    )
    assert.match(dslRow.getAttribute('aria-label') ?? '', /Collapse direct children/, '展开后 aria 切换为收起')
    act(() => {
      dslRow.click()
    })
    assert.equal(host.querySelectorAll('.execution-child-row').length, 2, '再次点击收起直系子项')
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      extRow.dispatchEvent(event)
    })
    const extRows = host.querySelectorAll('.execution-child-row')
    assert.equal(extRows.length, 3, '回车展开外部 run 直系子项')
    assert.ok(
      Array.from(extRows).some((r) => (r.textContent ?? '').includes('终端窗格')),
      '展开后应显示外部 run 直系子项行',
    )
    assert.deepEqual(spy.drawerCalls, [])
  } finally {
    unmount()
  }
})

test('紧凑子项：无自定义标题时回退 Subagent #N 且不重复渲染 .execution-child-id', { timeout: 60_000 }, async () => {
  const child11 = summary(11, 'working', 1, { doing: '父任务', updatedAt: 100 })
  const child22 = summary(22, 'done', 11, { title: 'subagent 22', updatedAt: 50 })
  setWorkflowClientStub({
    docValue: {
      runs: [
        subagentRun('wf_11', 1, 11, 'running'),
        subagentRun('wf_22', 11, 22, 'completed'),
      ],
    },
    conversations: [child11, child22],
    conversation: () => ({ summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }),
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const Panel = mod['WorkflowWorkbenchPanel'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(spy, e(Panel, { conversation: summary(1, 'working') }))
  try {
    const row = host.querySelector('.execution-child-row') as HTMLElement
    assert.ok(row !== null)
    assert.equal(row.querySelector('.execution-child-title')?.textContent, 'Subagent #22')
    assert.ok(row.querySelector('.execution-child-id') === null, '回退标题已含 #22 时不得重复渲染 .execution-child-id')
  } finally {
    unmount()
  }
})
