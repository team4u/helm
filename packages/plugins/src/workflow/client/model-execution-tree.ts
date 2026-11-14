/**
 * builtin:workflow 插件 client 纯逻辑：统一执行树 ExecutionTree / ExecutionNode
 * （任意深度递归视图模型、状态聚合、前线活动与后代审批摘要；零 React/DOM 依赖）。
 */
import type { ConversationSummary, WorkflowNodeState, WorkflowRunSummary } from '@helm/protocol'
import { compactCardTitle, subagentBadge } from './model-subagent.ts'
import type { SubagentCardStatus } from './model-subagent.ts'
import { firstLineOf } from './model-format.ts'

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

// ---------------------------------------------------------------------------
// 统一执行树 ExecutionTree / ExecutionNode（任意深度递归视图模型）
// ---------------------------------------------------------------------------

/** 统一执行节点状态（与子会话卡片状态同一五值枚举）。 */
export type ExecutionNodeStatus = SubagentCardStatus

/**
 * 状态自底向上聚合：blocked > error > working 优先；「已完成」仅当全部状态
 * 均 done——存在 pending（如未执行的 phase 节点）时不得被 done 掩盖成整体
 * 完成（不以简单最轻值判全完成）；空集返回 pending。
 */
export function aggregateExecutionStatuses(statuses: ReadonlyArray<ExecutionNodeStatus>): ExecutionNodeStatus {
  if (statuses.length === 0) return 'pending'
  let hasBlocked = false
  let hasError = false
  let hasWorking = false
  let hasPending = false
  for (const status of statuses) {
    if (status === 'blocked') hasBlocked = true
    else if (status === 'error') hasError = true
    else if (status === 'working') hasWorking = true
    else if (status === 'pending') hasPending = true
  }
  if (hasBlocked) return 'blocked'
  if (hasError) return 'error'
  if (hasWorking) return 'working'
  if (hasPending) return 'pending'
  return 'done'
}

/**
 * 子树聚合统计（含自身与全部后代）。
 *
 * total / done / running / blocked / error 只计真实执行任务：workflow /
 * external 容器壳在有子节点时不计自身（一次真实执行只计一次，wrapper 不算
 * 独立完成任务；无子节点的空 run 仍计 1）；同一会话被多个历史/续接 run
 * 引用时由构树层保证单一挂载，同样不双计。
 */
export interface ExecutionAggregate {
  status: ExecutionNodeStatus
  /** 子树真实执行任务总数（容器壳不双计）。 */
  total: number
  done: number
  running: number
  blocked: number
  error: number
}

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

/** 会话节点状态：与卡片徽章同源（subagentBadge 权威），保证树聚合与卡片展示一致；无任何数据时 pending，不假完成。
 *
 * 审批事实额外以 pendingAskCount > 0 判定（与 AskDock 同源）：Herdr 外部执行
 * 的 AskDoc 归属原生父会话，此时会话 status 可能仍在 working——有单即 blocked，
 * 避免审批台有单而卡片/树不冒泡。 */
export function executionConversationStatus(
  summary: ConversationSummary | undefined,
  backgroundRun: WorkflowRunSummary | undefined,
  toolStatus?: 'running' | 'done' | 'error' | 'unknown',
): ExecutionNodeStatus {
  if (summary === undefined && backgroundRun === undefined && toolStatus === undefined) return 'pending'
  if ((summary?.pendingAskCount ?? 0) > 0) return 'blocked'
  return subagentBadge(
    summary?.status,
    toolStatus ?? executionToolStatus(summary, backgroundRun),
    backgroundRun?.status,
  ).status
}

/** 工作流 run 状态映射。 */
export function executionRunStatus(run: Pick<WorkflowRunSummary, 'status'>): ExecutionNodeStatus {
  if (run.status === 'running') return 'working'
  if (run.status === 'failed' || run.status === 'aborted') return 'error'
  return 'done'
}

/** run 内节点状态映射（skipped 视为已结算完成）。 */
export function executionRunNodeStatus(node: Pick<WorkflowNodeState, 'status'>): ExecutionNodeStatus {
  if (node.status === 'running') return 'working'
  if (node.status === 'failed') return 'error'
  if (node.status === 'pending') return 'pending'
  return 'done'
}

/**
 * run 卡有效状态：与执行树同源合成——自身 run 终态 + 子树聚合（无子树数据
 * 时即自身终态）。后台 / 深层子任务未结算（working / blocked / error /
 * pending）时主徽章不假完成。
 */
export function effectiveRunNodeStatus(
  run: Pick<WorkflowRunSummary, 'status'>,
  subtree: ExecutionAggregate | undefined,
): ExecutionNodeStatus {
  if (subtree === undefined || subtree.total === 0) return executionRunStatus(run)
  return aggregateExecutionStatuses([executionRunStatus(run), subtree.status])
}

/** 紧凑卡父工具状态推导（Active-First 排序与卡片徽章共用）。 */
export function executionToolStatus(
  summary: ConversationSummary | undefined,
  run: WorkflowRunSummary | undefined,
): 'running' | 'done' | 'error' {
  if (summary?.status === 'working' || summary?.status === 'blocked') return 'running'
  if (summary?.status === 'error') return 'error'
  if (summary !== undefined) return 'done'
  const runStatus = run?.status
  if (runStatus === 'running') return 'running'
  if (runStatus === 'failed' || runStatus === 'aborted') return 'error'
  return 'done'
}

/** 节点展示标题：用户标题 > run 节点 label / prompt > 会话与 run 兜底描述（不虚构）。 */
export function executionNodeTitle(node: ExecutionNode): string {
  const label = node.label ?? node.runNode?.label
  if (node.kind === 'conversation') {
    const custom = compactCardTitle(node.summary?.title, node.conversationId ?? 0)
    if (custom !== undefined) return custom
    if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') return firstLineOf(label, 60)
    const prompt = node.runNode?.prompt
    if (prompt !== undefined && prompt.trim() !== '') return firstLineOf(prompt, 60)
    return `子会话 #${node.conversationId}`
  }
  if (label !== undefined && label.trim() !== '') return firstLineOf(label, 60)
  return node.run?.name ?? '外部执行'
}

/** 前线活动条目：子树内正在执行节点的单行摘要。 */
export interface ExecutionFrontlineItem {
  key: string
  conversationId?: number
  text: string
}

function executionFrontlineText(node: ExecutionNode, hasDeeper: boolean): string | undefined {
  if (node.status !== 'working') return undefined
  if (node.kind === 'conversation') {
    const doing = node.summary?.doing?.trim()
    if (doing !== undefined && doing !== '') return `#${node.conversationId} ${doing}`
    // 无自身 doing 且子树已有更深前线：不再以兑底文案重复占位（父级等待状态不抢占）
    return hasDeeper ? undefined : `#${node.conversationId} 执行中`
  }
  // 容器（workflow / external run）的自身执行即其子节点：子树已有更深前线时跳过
  return hasDeeper ? undefined : `${node.runNode?.label ?? node.label ?? node.run?.name ?? node.key} 执行中`
}

/**
 * 前线活动摘要：后序深度优先（最深活跃前线优先），至多 limit 条；同一节点
 * key 只收集一次（多历史引用不重复）。自身实际工作（doing）保留在更深前线之后。
 */
export function collectExecutionFrontline(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 2,
): ExecutionFrontlineItem[] {
  const items: ExecutionFrontlineItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      const before = items.length
      visit(node.children)
      if (items.length >= limit) return
      if (seen.has(node.key)) continue
      const text = executionFrontlineText(node, items.length > before)
      if (text !== undefined) {
        seen.add(node.key)
        items.push({
          key: node.key,
          text,
          ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
        })
      }
    }
  }
  visit(nodes)
  return items
}

/** 后代审批条目（pendingAsk 标题不在会话列表数据中，仅以会话标识如实呈现）。 */
export interface ExecutionApprovalItem {
  key: string
  conversationId?: number
  text: string
}

/**
 * 后代审批摘要：子树内 blocked 会话节点（pendingAskCount>0 或 status=blocked，
 * 均在构树叶状态中归一为 blocked），至多 limit 条；同一节点 key 不重复。
 */
export function collectExecutionApprovals(
  nodes: ReadonlyArray<ExecutionNode>,
  limit = 3,
): ExecutionApprovalItem[] {
  const items: ExecutionApprovalItem[] = []
  const seen = new Set<string>()
  const visit = (list: ReadonlyArray<ExecutionNode>): void => {
    for (const node of list) {
      if (items.length >= limit) return
      if (
        node.status === 'blocked' && node.kind === 'conversation' && node.conversationId !== undefined &&
        !seen.has(node.key)
      ) {
        seen.add(node.key)
        const title = compactCardTitle(node.summary?.title, node.conversationId)
        items.push({
          key: node.key,
          conversationId: node.conversationId,
          text: title !== undefined ? `#${node.conversationId} ${title}` : `#${node.conversationId} 等待审批`,
        })
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return items
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
