/**
 * builtin:workflow 底部在途活动托盘（WorkflowActiveTray）纯推导模型（零 React/DOM 依赖）。
 *
 * 与工作台复用同一套 buildExecutionTree 执行树事实：
 * - 仅提取当前会话或其后代仍在运行或等待审批（working / blocked / running）的节点；
 * - 全部收敛后 items 为空（UI 归零 0px）；
 * - 前线动作摘要复用 collectExecutionFrontline / collectExecutionApprovals。
 */
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import type { ExecutionNodeStatus } from './model-execution-status.ts'
import { buildExecutionTree, type ExecutionNode } from './model-execution-tree.ts'
import {
  collectExecutionApprovals,
  collectExecutionFrontline,
  executionNodeTitle,
  type ExecutionApprovalItem,
  type ExecutionFrontlineItem,
} from './model-execution-view.ts'
import { canDetachForegroundRun, type DetachViewerScope } from './model-run.ts'

export interface ActiveTrayItem {
  key: string
  kind: 'workflow' | 'conversation' | 'external'
  title: string
  status: ExecutionNodeStatus
  isWorking: boolean
  isBlocked: boolean
  conversationId?: number
  runId?: string
  progress?: { done: number; total: number }
  doing?: string
  startedAt?: number
  canAbort: boolean
  canDetach: boolean
}

export interface ActiveTraySummary {
  items: ActiveTrayItem[]
  activeCount: number
  runningCount: number
  blockedCount: number
  frontline: ExecutionFrontlineItem[]
  approvals: ExecutionApprovalItem[]
  earliestStartedAt?: number
}

function isExecutionNodeActive(node: ExecutionNode): boolean {
  return (
    node.status === 'working' ||
    node.status === 'blocked' ||
    node.aggregated.running > 0 ||
    node.aggregated.blocked > 0 ||
    node.run?.status === 'running'
  )
}

function nodeStartedAt(node: ExecutionNode): number | undefined {
  const candidates = [node.run?.createdAt, node.runNode?.startedAt]
  for (const ts of candidates) {
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts
  }
  return undefined
}

function nodeProgressOf(node: ExecutionNode): { done: number; total: number } | undefined {
  if (node.kind === 'workflow' && node.run !== undefined) {
    const runNodes = node.run.nodes ?? []
    if (runNodes.length > 0) {
      return {
        done: runNodes.filter((n) => n.status === 'done').length,
        total: runNodes.length,
      }
    }
  }
  if (node.aggregated.total > 1) {
    return { done: node.aggregated.done, total: node.aggregated.total }
  }
  return undefined
}

export function buildActiveTraySummary(input: {
  rootConversationId: number
  conversations: ReadonlyArray<ConversationSummary>
  runs: ReadonlyArray<WorkflowRunSummary>
  viewer?: DetachViewerScope
}): ActiveTraySummary {
  const tree = buildExecutionTree({
    rootConversationId: input.rootConversationId,
    conversations: input.conversations,
    runs: input.runs,
  })
  const activeNodes = tree.filter(isExecutionNodeActive)
  if (activeNodes.length === 0) {
    return {
      items: [],
      activeCount: 0,
      runningCount: 0,
      blockedCount: 0,
      frontline: [],
      approvals: [],
    }
  }

  let runningCount = 0
  let blockedCount = 0
  let earliestStartedAt: number | undefined

  const items: ActiveTrayItem[] = activeNodes.map((node) => {
    const isBlocked =
      node.status === 'blocked' || node.aggregated.status === 'blocked' || node.aggregated.blocked > 0
    const isWorking =
      node.status === 'working' || node.aggregated.running > 0 || node.run?.status === 'running'
    if (isBlocked) blockedCount += 1
    if (isWorking) runningCount += 1

    const startedAt = nodeStartedAt(node)
    if (startedAt !== undefined && (earliestStartedAt === undefined || startedAt < earliestStartedAt)) {
      earliestStartedAt = startedAt
    }

    const frontlineItem = collectExecutionFrontline([node], 1)[0]
    const approvalItem = isBlocked ? collectExecutionApprovals([node], 1)[0] : undefined
    const doing =
      approvalItem?.text ??
      frontlineItem?.text ??
      (node.summary?.doing !== undefined && node.summary.doing.trim() !== ''
        ? node.summary.doing.trim()
        : undefined)
    const progress = nodeProgressOf(node)

    return {
      key: node.key,
      kind: node.kind === 'workflow' ? 'workflow' : node.kind === 'conversation' ? 'conversation' : 'external',
      title: executionNodeTitle(node),
      status: isBlocked ? 'blocked' : node.aggregated.status === 'error' && isWorking ? 'working' : node.aggregated.status,
      isWorking,
      isBlocked,
      ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
      ...(node.run !== undefined ? { runId: node.run.id } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(doing !== undefined ? { doing } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      canAbort: node.run?.status === 'running',
      canDetach: node.run !== undefined && canDetachForegroundRun(node.run, input.viewer),
    }
  })

  return {
    items,
    activeCount: items.length,
    runningCount,
    blockedCount,
    frontline: collectExecutionFrontline(activeNodes, 2),
    approvals: collectExecutionApprovals(activeNodes, 2),
    ...(earliestStartedAt !== undefined ? { earliestStartedAt } : {}),
  }
}
