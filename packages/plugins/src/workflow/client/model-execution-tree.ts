/**
 * builtin:workflow 插件 client 纯逻辑：统一执行树 ExecutionNode 构树——
 * 会话链递归 + runs 整棵投影归位、DSL 认领去重与 Active-First 排序
 * （状态映射与聚合见 model-execution-status，展示摘要见 model-execution-view；
 * 零 React/DOM 依赖）。
 */
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
import {
  aggregateExecutionStatuses,
  executionConversationStatus,
  executionRunNodeStatus,
  executionRunStatus,
} from './model-execution-status.ts'

/** 执行树节点种类：原生子会话 / 工作流 run / run 内节点 / 外部执行。 */
export type ExecutionNodeKind = 'conversation' | 'workflow' | 'workflow-node' | 'external'

/** 统一执行树节点：SubagentLiveCard / WorkflowRunCard / WorkflowNodeCard / 外部执行摘要共用同一递归形状。 */
export interface ExecutionNode {
  key: string
  kind: ExecutionNodeKind
  /** 可打开的原生子会话 ID（workflow / workflow-node / 无会话 external 不携带）。 */
  conversationId?: number
  /** 关联工作流 run（conversation 节点为认领的后台 run；workflow / external 节点为自身 run）。 */
  run?: WorkflowRunSummary
  /** run 内原始节点（workflow 节点的子节点携带）。 */
  runNode?: WorkflowNodeState
  /** 展示标题（仅由真实数据提炼）。 */
  label?: string
  /** 实时会话摘要（存在时来自会话列表，绝不虚构）。 */
  summary?: ConversationSummary
  /** 叶子自身状态；整棵子树状态见 aggregated.status。 */
  status: ExecutionNodeStatus
  /** 下一级子节点。 */
  children: ExecutionNode[]
  /** 自底向上聚合（含自身与全部后代）。 */
  aggregated: ExecutionAggregate
  /** 排序用最新更新时间（summary / run 的最大值）。 */
  updatedAt: number
}

/** 从认领同一子会话的多个后台 run 中选出当前关联者。 */
function pickBackgroundRun(
  runs: ReadonlyArray<WorkflowRunSummary>,
  parentToolCallId: string | undefined,
): WorkflowRunSummary | undefined {
  if (runs.length === 0) return undefined
  if (parentToolCallId !== undefined && parentToolCallId !== '') {
    return runs.find((r) => r.parentToolCallId === parentToolCallId)
  }
  return runs.reduce((latest, r) => (r.createdAt > latest.createdAt ? r : latest))
}

/** 合并一组节点的聚合（用于卡片头部统计直接子树，不含任何“自身”）。 */
export function aggregateExecutionNodes(nodes: ReadonlyArray<ExecutionNode>): ExecutionAggregate {
  let total = 0
  let done = 0
  let running = 0
  let blocked = 0
  let error = 0
  const statuses: ExecutionNodeStatus[] = []
  for (const node of nodes) {
    const agg = node.aggregated
    total += agg.total
    done += agg.done
    running += agg.running
    blocked += agg.blocked
    error += agg.error
    statuses.push(agg.status)
  }
  return { status: aggregateExecutionStatuses(statuses), total, done, running, blocked, error }
}

/**
 * 子节点均已聚合的前提下计算自身聚合（含自身，后序遍历）。
 *
 * - 容器（workflow / external run 壳）有子节点时不计自身任务：一次真实执行
 *   只计一次，wrapper 不算独立完成任务；无子节点的空 run 仍计 1（run 本身
 *   即一次真实执行）；
 * - 状态经 aggregateExecutionStatuses 合成自身与后代：后代 active / error /
 *   blocked 未结算时（含后台子任务 running、phase 节点 pending）绝不判成
 *   整体完成。
 */
function finalizeExecutionNode(node: Omit<ExecutionNode, 'aggregated'>): ExecutionNode {
  const selfCounts = !(node.children.length > 0 && (node.kind === 'workflow' || node.kind === 'external'))
  let done = 0
  let running = 0
  let blocked = 0
  let error = 0
  if (selfCounts) {
    if (node.status === 'done') done = 1
    else if (node.status === 'working') running = 1
    else if (node.status === 'blocked') blocked = 1
    else if (node.status === 'error') error = 1
  }
  let total = selfCounts ? 1 : 0
  const statuses: ExecutionNodeStatus[] = [node.status]
  for (const child of node.children) {
    const agg = child.aggregated
    total += agg.total
    done += agg.done
    running += agg.running
    blocked += agg.blocked
    error += agg.error
    statuses.push(agg.status)
  }
  return { ...node, aggregated: { status: aggregateExecutionStatuses(statuses), total, done, running, blocked, error } }
}

/** 工作台排序：blocked > working > error > done/pending（Active-First），同级 updatedAt 降序。 */
const EXECUTION_SORT_ORDER: Record<ExecutionNodeStatus, number> = {
  blocked: 0,
  working: 1,
  error: 2,
  done: 3,
  pending: 3,
}

function sortExecutionSiblings(nodes: ExecutionNode[]): ExecutionNode[] {
  return nodes.sort((a, b) => {
    const rank = EXECUTION_SORT_ORDER[a.aggregated.status] - EXECUTION_SORT_ORDER[b.aggregated.status]
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt
  })
}

/** 构建执行树入参。 */
export interface BuildExecutionTreeInput {
  rootConversationId: number
  /** 全量会话摘要（useConversations）；任意深度经 parentConversationId 递归。 */
  conversations: ReadonlyArray<ConversationSummary>
  /** 根会话的祖先聚合 runs 投影（usePluginSessionDoc('runs')，含全部后代，
   * 各 run 保留原始 conversationId）；深层会话无 run 数据时仅以会话链递归，不虚构。 */
  runs?: ReadonlyArray<WorkflowRunSummary>
}

/** run 内无会话节点 / 会话在祖先链上的兜底叶子。 */
function executionRunLeafNode(run: WorkflowRunSummary, node: WorkflowNodeState): Omit<ExecutionNode, 'aggregated'> {
  return {
    key: `node:${run.id}:${node.id}`,
    kind: 'workflow-node',
    run,
    runNode: node,
    label: node.label,
    status: executionRunNodeStatus(node),
    updatedAt: run.updatedAt,
    children: [],
  }
}

/** DSL 引用归属：running 的 run 优先（续接后新 run 接管仍在跑的引用），
 * 其次 createdAt 最新，最后 id 稳定排序（与分片顺序无关）。 */
function isStrongerDslConvOwner(candidate: WorkflowRunSummary, current: WorkflowRunSummary): boolean {
  const candidateRunning = candidate.status === 'running'
  const currentRunning = current.status === 'running'
  if (candidateRunning !== currentRunning) return candidateRunning
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  return candidate.id > current.id
}

/**
 * 构建统一执行树：rootConversationId 的下一级执行节点（任意深度递归）。
 *
 * - 入参 runs 为「本会话 + 全部后代」的整棵投影（各 run 保留原始
 *   conversationId，由后端聚合分片提供）；同一 run id 重复到达时去重，
 *   不缺 run 丢树也不重复挂载；
 * - 会话子节点按 parentConversationId 递归；被 DSL run 认领的会话挂到 run
 *   节点下，不重复出现；同一会话被多个历史/续接 DSL run 引用时仅挂载一次
 *   （归属者见 isStrongerDslConvOwner），其余 run 的引用保留普通叶子行可
 *   显示但不双计；
 * - 后台单子代理 run 认领的直接子会话保持会话节点并携带 run；会话列表
 *   缺失时仅携带 run，不虚构 summary；
 * - 无任何会话关联的后台 run 为外部执行节点（run 内节点为叶子）；
 * - parentConversationId 链成环时按祖先链防御性截断。
 */
export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  const convById = new Map<number, ConversationSummary>()
  for (const conversation of conversations) convById.set(conversation.id, conversation)

  // 聚合分片可能重复携带同一 run（重叠投影/增量事件）：按 id 去重。
  const uniqueRuns: WorkflowRunSummary[] = []
  const seenRunIds = new Set<string>()
  for (const run of runs) {
    if (seenRunIds.has(run.id)) continue
    seenRunIds.add(run.id)
    uniqueRuns.push(run)
  }

  const runsByParent = new Map<number, WorkflowRunSummary[]>()
  const dslClaimedByParent = new Map<number, Set<number>>()
  const subagentClaimsByParent = new Map<number, Map<number, WorkflowRunSummary[]>>()
  const dslConvOwner = new Map<number, WorkflowRunSummary>()
  for (const run of uniqueRuns) {
    const siblings = runsByParent.get(run.conversationId)
    if (siblings !== undefined) siblings.push(run)
    else runsByParent.set(run.conversationId, [run])
    if (run.kind === 'subagent') {
      let claims = subagentClaimsByParent.get(run.conversationId)
      if (claims === undefined) {
        claims = new Map()
        subagentClaimsByParent.set(run.conversationId, claims)
      }
      for (const node of run.nodes ?? []) {
        if (node.conversationId === undefined) continue
        const list = claims.get(node.conversationId)
        if (list !== undefined) list.push(run)
        else claims.set(node.conversationId, [run])
      }
    } else {
      let claimed = dslClaimedByParent.get(run.conversationId)
      if (claimed === undefined) {
        claimed = new Set()
        dslClaimedByParent.set(run.conversationId, claimed)
      }
      for (const node of run.nodes ?? []) {
        if (node.conversationId === undefined) continue
        claimed.add(node.conversationId)
        const owner = dslConvOwner.get(node.conversationId)
        if (owner === undefined || isStrongerDslConvOwner(run, owner)) {
          dslConvOwner.set(node.conversationId, run)
        }
      }
    }
  }

  const childrenOf = (conversationId: number, ancestry: ReadonlySet<number>): ExecutionNode[] => {
    const nodes: ExecutionNode[] = []
    const dslClaimed = dslClaimedByParent.get(conversationId)
    const claims = subagentClaimsByParent.get(conversationId)

    // 1) 会话直接子节点：被 DSL run 认领的会话挂到 run 节点下，不在此重复出现。
    const directIds = new Set<number>()
    for (const conversation of conversations) {
      if (conversation.parentConversationId !== conversationId) continue
      directIds.add(conversation.id)
      if (dslClaimed?.has(conversation.id) === true) continue
      if (ancestry.has(conversation.id)) continue
      const backgroundRun = claims?.get(conversation.id) !== undefined
        ? pickBackgroundRun(claims.get(conversation.id) ?? [], conversation.parentToolCallId)
        : undefined
      nodes.push(
        finalizeExecutionNode({
          key: `conv:${conversation.id}`,
          kind: 'conversation',
          conversationId: conversation.id,
          summary: conversation,
          ...(backgroundRun !== undefined ? { run: backgroundRun } : {}),
          status: executionConversationStatus(conversation, backgroundRun),
          updatedAt: Math.max(conversation.updatedAt, backgroundRun?.updatedAt ?? 0),
          children: childrenOf(conversation.id, new Set(ancestry).add(conversation.id)),
        }),
      )
    }

    // 2) 仅后台 run 可见的会话（会话列表缺失摘要）：如实携带 run，不虚构 summary。
    if (claims !== undefined) {
      for (const [claimedId, claimedRuns] of claims) {
        if (directIds.has(claimedId) || dslClaimed?.has(claimedId) === true) continue
        if (ancestry.has(claimedId)) continue
        const run = pickBackgroundRun(claimedRuns, undefined)
        nodes.push(
          finalizeExecutionNode({
            key: `conv:${claimedId}`,
            kind: 'conversation',
            conversationId: claimedId,
            ...(run !== undefined ? { run } : {}),
            status: executionConversationStatus(undefined, run),
            updatedAt: run?.updatedAt ?? 0,
            children: childrenOf(claimedId, new Set(ancestry).add(claimedId)),
          }),
        )
      }
    }

    // 3) 本会话发起的 run：DSL 工作流挂节点子树；无会话关联的后台 run 为外部执行。
    for (const run of runsByParent.get(conversationId) ?? []) {
      const runNodes = run.nodes ?? []
      if (run.kind === 'subagent') {
        if (runNodes.some((n) => n.conversationId !== undefined)) continue // 会话关联 run 已在 1/2 挂载
        nodes.push(
          finalizeExecutionNode({
            key: `run:${run.id}`,
            kind: 'external',
            run,
            label: run.name,
            status: executionRunStatus(run),
            updatedAt: run.updatedAt,
            children: runNodes.map((node) => finalizeExecutionNode(executionRunLeafNode(run, node))),
          }),
        )
        continue
      }
      // 同一 run 内重复引用同一会话时也只挂载一次（后续引用保持叶子行）。
      const mountedConvIds = new Set<number>()
      nodes.push(
        finalizeExecutionNode({
          key: `run:${run.id}`,
          kind: 'workflow',
          run,
          label: run.name,
          status: executionRunStatus(run),
          updatedAt: run.updatedAt,
          children: runNodes.map((node) => {
            const convId = node.conversationId
            if (
              convId === undefined || ancestry.has(convId) ||
              dslConvOwner.get(convId) !== run || mountedConvIds.has(convId)
            ) {
              return finalizeExecutionNode(executionRunLeafNode(run, node))
            }
            mountedConvIds.add(convId)
            const summary = convById.get(convId)
            const runNodeToolStatus: 'running' | 'done' | 'error' | 'unknown' =
              node.status === 'running'
                ? 'running'
                : node.status === 'failed'
                  ? 'error'
                  : node.status === 'done'
                    ? 'done'
                    : 'unknown'
            return finalizeExecutionNode({
              key: `conv:${convId}`,
              kind: 'conversation',
              conversationId: convId,
              summary,
              run,
              runNode: node,
              label: node.label,
              status: executionConversationStatus(summary, undefined, runNodeToolStatus),
              updatedAt: Math.max(summary?.updatedAt ?? 0, run.updatedAt),
              children: childrenOf(convId, new Set(ancestry).add(convId)),
            })
          }),
        }),
      )
    }
    return sortExecutionSiblings(nodes)
  }

  return childrenOf(rootConversationId, new Set([rootConversationId]))
}
