/**
 * builtin:workflow 统一执行树（ExecutionTree / ExecutionNode）测试：
 * - 纯逻辑（真实 esbuild 编译产物 models.ts）：状态自底向上聚合
 *   （blocked > error > working > done > pending）、子树完成/运行计数、
 *   前线活动摘要、后代审批摘要、任意深度构树（parentConversationId 会话链 +
 *   根会话 runs 分片）、DSL run 认领挂载 / 后台 run 关联 / 外部执行 /
 *   run-only 会话不虚构 summary、parentConversationId 成环防御；
 * - 组件交互（真实编译产物 + DOM 事件）：工作台父卡下一级紧凑子项、
 *   点击 / 回车打开任意深度会话抽屉、紧凑子项不冒泡触发父卡、
 *   工作流节点卡内深层子代理同样可打开。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  WorkflowNodeState,
  WorkflowRunSummary,
} from '@helm/protocol'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import {
  importWorkflowClientModule,
  importWorkflowModels,
  mountSharedPluginNamespaces,
  setWorkflowClientStub,
} from './helpers/workflow-client.js'

const e = React.createElement

GlobalRegistrator.register()
mountSharedPluginNamespaces()
// React 19 act 环境：事件处理器在 act 外静默抑制更新断言；显式开启
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const m = await importWorkflowModels()

// ---------------------------------------------------------------------------
// 测试数据构造
// ---------------------------------------------------------------------------

function summary(
  id: number,
  status: ConversationSummary['status'],
  parent?: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
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
    ...overrides,
  }
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

// ---------------------------------------------------------------------------
// 纯逻辑：状态聚合与叶子状态推导
// ---------------------------------------------------------------------------

test('aggregateExecutionStatuses：blocked > error > working > done > pending，空集 pending', { timeout: 60_000 }, () => {
  assert.equal(m.aggregateExecutionStatuses([]), 'pending')
  assert.equal(m.aggregateExecutionStatuses(['done', 'done']), 'done')
  assert.equal(m.aggregateExecutionStatuses(['pending', 'done']), 'done')
  assert.equal(m.aggregateExecutionStatuses(['done', 'working']), 'working')
  assert.equal(m.aggregateExecutionStatuses(['working', 'error']), 'error')
  assert.equal(m.aggregateExecutionStatuses(['error', 'blocked']), 'blocked')
  assert.equal(m.aggregateExecutionStatuses(['done', 'pending', 'working', 'error', 'blocked']), 'blocked')
})

test('executionConversationStatus：与卡片徽章同源，后台 run 未终结绝不假完成', { timeout: 60_000 }, () => {
  assert.equal(m.executionConversationStatus(summary(11, 'blocked'), undefined), 'blocked')
  assert.equal(m.executionConversationStatus(summary(11, 'working'), undefined), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'done'), run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'failed' })), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'aborted' })), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'error'), undefined), 'error')
  assert.equal(m.executionConversationStatus(summary(11, 'done'), undefined), 'done')
  assert.equal(m.executionConversationStatus(summary(11, 'idle'), run({ status: 'completed' })), 'done')
  // run-only：无 summary 时按 run 状态如实呈现
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'running' })), 'working')
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'completed' })), 'done')
  assert.equal(m.executionConversationStatus(undefined, run({ status: 'failed' })), 'error')
  // DSL 节点 runNode running + 会话 done（前台 gate 期）：与卡片一致为 working
  assert.equal(m.executionConversationStatus(summary(11, 'done'), undefined, 'running'), 'working')
  assert.equal(m.executionConversationStatus(undefined, undefined, 'unknown'), 'pending')
  // 无任何数据：pending，不假完成
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
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] })
  assert.equal(tree.length, 1, '根会话仅 #11 一个直接子节点')
  const child = tree[0]!
  assert.equal(child.kind, 'conversation')
  assert.equal(child.conversationId, 11)
  assert.equal(child.status, 'done', '自身状态为真实 done')
  // 深层 blocked 自底向上冒泡：#31 blocked → #21 → #11 聚合为 blocked
  assert.equal(child.aggregated.status, 'blocked')
  assert.equal(child.aggregated.total, 4, '子树含 11/21/31/32 共 4 节点')
  assert.equal(child.aggregated.done, 2, '11 与 32 完成')
  assert.equal(child.aggregated.running, 1, '21 执行中')
  assert.equal(child.aggregated.blocked, 1, '31 等待审批')
  assert.equal(child.aggregated.error, 0)
  // 二级：#21（working 聚合 blocked）；三级：#31 blocked 排在 #32 done 前
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
  // 聚合：run(working) + n1 会话(done + 节点 running → gate 期 working，与卡片徽章一致)
  // + #21(working) + n2(done) = 4 节点
  assert.equal(wfNode.aggregated.total, 4)
  assert.equal(wfNode.aggregated.done, 1)
  assert.equal(wfNode.aggregated.running, 3)
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
  assert.equal(external.aggregated.total, 2)
})

test('buildExecutionTree：Active-First 排序 blocked > working > error > done，同级 updatedAt 降序', { timeout: 60_000 }, () => {
  const conversations = [
    summary(41, 'idle', 1, { updatedAt: 5 }),
    summary(42, 'error', 1, { updatedAt: 4 }),
    summary(43, 'working', 1, { updatedAt: 3 }),
    summary(44, 'blocked', 1, { updatedAt: 2 }),
    summary(45, 'done', 1, { updatedAt: 99 }),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] })
  assert.deepEqual(
    tree.map((n) => n.conversationId),
    [44, 43, 42, 45, 41],
  )
})

test('buildExecutionTree：parentConversationId 链成环时按祖先链防御性截断，不死循环', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 21),
    summary(21, 'done', 11),
  ]
  // DSL run 认领 #21：21 → 11 → 21 成环，11 已在祖先链上时不再展开
  const runs = [
    run({
      id: 'wf_x',
      kind: 'workflow',
      status: 'completed',
      nodes: [node({ id: 'n1', kind: 'agent', status: 'done', conversationId: 21 })],
    }),
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
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] })
  const items = m.collectExecutionFrontline(tree, 2)
  assert.deepEqual(
    items.map((item) => item.text),
    ['#21 bash: pnpm test', '#23 读取 a.ts'],
  )
  assert.equal(m.collectExecutionFrontline(tree, 1).length, 1, 'limit 生效')
  // 无 doing 的 working 节点兜底执行中文案；deepEqual 单条校验
  const noDoing = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [summary(1, 'idle'), summary(21, 'working', 11, { parentConversationId: 1 })],
    runs: [],
  })
  assert.deepEqual(
    m.collectExecutionFrontline(noDoing, 2).map((item) => item.text),
    ['#21 执行中'],
  )
})

test('collectExecutionApprovals：收集子树 blocked 会话（#id + 用户标题，不虚构 AskSpec 标题）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'working', 1),
    summary(21, 'blocked', 11, { title: '确认删除文件' }),
    summary(22, 'blocked', 11),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] })
  const items = m.collectExecutionApprovals(tree, 3)
  assert.deepEqual(
    items.map((item) => item.text),
    ['#21 确认删除文件', '#22 等待审批'],
  )
  assert.equal(items[0]!.conversationId, 21)
  assert.equal(m.collectExecutionApprovals(tree, 1).length, 1, 'limit 生效')
})

test('aggregateExecutionNodes：合并直接子节点聚合（不含自身）', { timeout: 60_000 }, () => {
  const conversations = [
    summary(1, 'idle'),
    summary(11, 'done', 1),
    summary(21, 'working', 11),
    summary(31, 'blocked', 21),
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs: [] })
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
  ]
  const tree = m.buildExecutionTree({ rootConversationId: 1, conversations, runs })
  const wf = tree[0]!
  const titled = wf.children.find((c) => c.conversationId === 11)!
  assert.equal(m.executionNodeTitle(titled), '修复登录超时')
  const labeled = wf.children.find((c) => c.conversationId === 12)!
  assert.equal(m.executionNodeTitle(labeled), '调研员')
  const action = wf.children.find((c) => c.runNode?.id === 'n3')!
  assert.equal(m.executionNodeTitle(action), '落盘报告')
  // 默认标题「子会话 N」不算自定义标题：无 label 时兜底
  const plain = m.buildExecutionTree({
    rootConversationId: 1,
    conversations: [summary(1, 'idle'), summary(13, 'done', 1)],
    runs: [],
  })
  assert.equal(m.executionNodeTitle(plain[0]!), '子会话 #13')
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
    root.render(e(PluginClientContext.Provider, { value: ctx }, element))
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
  setWorkflowClientStub({
    docValue: { runs: [] },
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
    // #11 卡头部：子树计数（后代 #21/#31 共 2 节点、0 完成）+ 后代审批徽章
    assert.match(host.textContent!, /子树 0\/2/, '应渲染子树完成计数徽章')
    const approvalBadge = host.querySelector('.subagent-live-trigger .badge-warn')
    assert.ok(approvalBadge !== null, '后代审批徽章应渲染')
    assert.match(approvalBadge.getAttribute('title')!, /#21 确认删除文件/, '审批徽章 title 应含后代审批摘要')
    // 前线活动摘要：深层 #31 working 的 doing 冒泡到父卡
    const frontline = host.querySelector('.execution-frontline')
    assert.ok(frontline !== null, '应渲染前线活动摘要行')
    assert.match(frontline.textContent!, /#31 bash: pnpm test/)
    // 下一级紧凑子项：#21 单行（blocked 变体 + 等待审批徽章 + 子树计数）
    const rows = host.querySelectorAll('.execution-child-row')
    assert.equal(rows.length, 1, '仅展示父节点下一级紧凑子项')
    const row = rows[0] as HTMLElement
    assert.ok(row.classList.contains('execution-child-blocked'))
    assert.match(row.textContent!, /#21/)
    assert.match(row.textContent!, /确认删除文件/)
    assert.match(row.textContent!, /等待审批/)
    assert.match(row.textContent!, /0\/2/, '紧凑子项应携带子树完成计数')
    assert.equal(row.getAttribute('aria-label'), '打开会话 #21 抽屉')
    // 点击紧凑子项：打开深层会话抽屉，不冒泡触发父卡
    act(() => {
      row.click()
    })
    assert.deepEqual(spy.drawerCalls, [21], '点击紧凑子项打开 #21，不触发父卡 #11')
    // 回车 / 空格同样打开深层会话
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => {
        row.dispatchEvent(event)
      })
      if (key === ' ') assert.equal(event.defaultPrevented, true, '空格不得滚动页面')
    }
    assert.deepEqual(spy.drawerCalls, [21, 21, 21])
    // 点击父卡本体仍打开直接子会话
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
  setWorkflowClientStub({
    docValue: { runs: [wf] },
    conversations: [child11, child21],
    conversation: (id) =>
      id === 11
        ? { summary: child11, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} }
        : { summary: undefined, detail: undefined, live: undefined, pendingAsks: [], loadError: undefined, reload: () => {} },
  })
  const spy = makeSpyCtx()
  const mod = await importWorkflowClientModule('index.tsx')
  const WorkflowToolView = mod['WorkflowToolView'] as (p: Record<string, unknown>) => React.ReactElement
  const { host, unmount } = await mountClient(
    spy,
    e(WorkflowToolView, {
      callId: 'wf_call', toolName: 'SubagentWorkflow', input: { script: 'x' },
      status: 'running', conversationId: 1, siblingCalls: [],
    }),
  )
  try {
    // run 头部：深层后代存在时展示子树计数（#11 working + #21 done = 1/2）
    assert.match(host.textContent!, /节点 0\/1/, 'run 自身节点计数保留')
    assert.match(host.textContent!, /子树 1\/2/, '深层后代计数以子树徽章展示')
    // 节点卡 #11 内渲染 #21 紧凑子项
    const rows = host.querySelectorAll('.execution-child-row')
    assert.equal(rows.length, 1)
    const row = rows[0] as HTMLElement
    assert.match(row.textContent!, /深层实现/)
    act(() => {
      row.click()
    })
    assert.deepEqual(spy.drawerCalls, [21], '工作流节点内深层子会话点击可打开')
    // 点击节点卡本体打开 #11
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
    docValue: { runs: [] },
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
    assert.equal(host.querySelector('.execution-children'), null)
    assert.equal(host.querySelector('.execution-frontline'), null)
    assert.ok(!/子树 \d/.test(host.textContent!), '无后代不得渲染子树徽章')
  } finally {
    unmount()
  }
})
