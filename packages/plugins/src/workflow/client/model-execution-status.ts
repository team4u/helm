/**
 * builtin:workflow 插件 client 纯逻辑：统一执行树的状态枚举与聚合——
 * 五值状态映射（会话 / run / run 节点）、自底向上聚合与卡片有效状态合成
 * （零 React/DOM 依赖）。
 */
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { subagentBadge } from './model-subagent-card.ts'
import type { SubagentCardStatus } from './model-subagent-card.ts'

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
    backgroundRun,
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
