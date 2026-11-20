/**
 * Pure derivation model for the builtin:workflow bottom in-flight activity
 * tray (WorkflowActiveTray) (zero React/DOM dependencies).
 *
 * Reuses the same buildExecutionTree facts as the workbench:
 * - only nodes of the current conversation or its descendants that are still
 *   running or awaiting approval (working / blocked / running) are extracted;
 * - once everything settles items is empty (UI collapses to 0px);
 * - frontline action digests reuse collectExecutionFrontline /
 *   collectExecutionApprovals.
 */
import { DEFAULT_HELMX_LOCALE, type HelmxLocale } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol'
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
  /**
   * Live-facts target of the row activity line: the row's own conversation
   * when it is itself working/blocked, else (container rows) the deepest
   * active descendant conversation whose live snippet is reused. Navigation
   * targets stay conversationId / runId — the activity target never changes
   * what a row click opens.
   */
  activityConversationId?: number
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
  // 一级口径：进度分母只数直接子节点，不含节点自身与孙子层——每个会话
  // 只对自己直接派生的任务计数，嵌套层的进度归嵌套层自己的托盘/卡片；
  // 单个直接子任务不显示进度徽标（完成度对单项无意义）。
  if (node.children.length > 1) {
    return {
      done: node.children.filter((c) => c.status === 'done' || c.status === 'error').length,
      total: node.children.length,
    }
  }
  return undefined
}

/** Deepest-first active descendant conversation (live-facts target for container rows). */
function firstActiveDescendantConversationId(node: ExecutionNode): number | undefined {
  for (const child of node.children) {
    const deeper = firstActiveDescendantConversationId(child)
    if (deeper !== undefined) return deeper
    if (isExecutionNodeActive(child) && child.conversationId !== undefined) return child.conversationId
  }
  return undefined
}

export function buildActiveTraySummary(
  input: {
    rootConversationId: number
    conversations: ReadonlyArray<ConversationSummary>
    runs: ReadonlyArray<WorkflowRunSummary>
    viewer?: DetachViewerScope
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): ActiveTraySummary {
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

    const frontlineItem = collectExecutionFrontline([node], 1, locale)[0]
    const approvalItem = isBlocked ? collectExecutionApprovals([node], 1, locale)[0] : undefined
    // A childless working conversation's frontline digest embeds this row's
    // own title/#id again; only descendant-sourced items (a genuinely
    // different identity) may serve as the row activity fallback — dedupe by
    // node key, never by string surgery.
    const descendantFrontline =
      frontlineItem !== undefined && frontlineItem.key !== node.key ? frontlineItem : undefined

    let doing: string | undefined
    let activityConversationId: number | undefined
    if (node.kind === 'conversation') {
      // Native rows: the model fallback is the conversation's own raw doing;
      // live facts (tool semantics / output / thinking / approval title) come
      // from the host snapshot via useConversation in the row component.
      // A row whose self already settled while descendants keep running must
      // surface the descendants' activity — never its own stale doing.
      const selfActive = node.status === 'working' || node.status === 'blocked'
      if (approvalItem !== undefined) {
        doing = approvalItem.text
        activityConversationId = approvalItem.conversationId
      } else if (selfActive) {
        const ownDoing = node.summary?.doing?.trim()
        doing = ownDoing !== undefined && ownDoing !== '' ? ownDoing : descendantFrontline?.text
        activityConversationId = node.conversationId
      } else {
        doing = descendantFrontline?.text
        activityConversationId =
          descendantFrontline?.conversationId ?? firstActiveDescendantConversationId(node)
      }
    } else {
      // Container rows (workflow / external runs) keep the real descendant
      // progress and approval digests, reusing the deepest active descendant
      // conversation for live facts without changing the navigation target.
      const ownDoing = node.summary?.doing?.trim()
      doing =
        approvalItem?.text ??
        frontlineItem?.text ??
        (ownDoing !== undefined && ownDoing !== '' ? ownDoing : undefined)
      activityConversationId =
        approvalItem?.conversationId ??
        descendantFrontline?.conversationId ??
        firstActiveDescendantConversationId(node)
    }
    const progress = nodeProgressOf(node)

    return {
      key: node.key,
      kind: node.kind === 'workflow' ? 'workflow' : node.kind === 'conversation' ? 'conversation' : 'external',
      title: executionNodeTitle(node, locale),
      status: isBlocked ? 'blocked' : node.aggregated.status === 'error' && isWorking ? 'working' : node.aggregated.status,
      isWorking,
      isBlocked,
      ...(node.conversationId !== undefined ? { conversationId: node.conversationId } : {}),
      ...(activityConversationId !== undefined ? { activityConversationId } : {}),
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
    frontline: collectExecutionFrontline(activeNodes, 2, locale),
    approvals: collectExecutionApprovals(activeNodes, 2, locale),
    ...(earliestStartedAt !== undefined ? { earliestStartedAt } : {}),
  }
}
