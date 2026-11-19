/**
 * Pure logic for the builtin:workflow client: unified execution tree
 * ExecutionNode building — rooted exclusively in `runs` (`WorkflowRunSummary`),
 * looking up `convById.get(node.conversationId)` from `conversations` for live
 * status/title/summary and recursing into child runs `runsByParent.get(convId)`.
 *
 * Unclaimed `conversations` (such as human `POST /api/conversations/:id/fork`
 * branches and `builtin:superagent` resident workers that have no `WorkflowRun`)
 * never enter the execution tree, workbench panel, or active tray.
 */
import type { ConversationSummary } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
import {
  aggregateExecutionStatuses,
  executionConversationStatus,
  executionRunNodeStatus,
  executionRunStatus,
} from './model-execution-status.ts'

export type ExecutionNodeKind = 'conversation' | 'workflow' | 'workflow-node' | 'external'

export interface ExecutionNode {
  key: string
  kind: ExecutionNodeKind
  conversationId?: number
  run?: WorkflowRunSummary
  runNode?: WorkflowNodeState
  label?: string
  summary?: ConversationSummary
  status: ExecutionNodeStatus
  children: ExecutionNode[]
  aggregated: ExecutionAggregate
  updatedAt: number
}

function isStrongerRunOwner(
  candidate: WorkflowRunSummary,
  current: WorkflowRunSummary,
  preferredParentToolCallId?: string,
): boolean {
  const candidateRunning = candidate.status === 'running'
  const currentRunning = current.status === 'running'
  if (candidateRunning !== currentRunning) return candidateRunning
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  if (preferredParentToolCallId !== undefined && preferredParentToolCallId !== '') {
    const candidateMatches = candidate.parentToolCallId === preferredParentToolCallId
    const currentMatches = current.parentToolCallId === preferredParentToolCallId
    if (candidateMatches !== currentMatches) return candidateMatches
  }
  return candidate.id > current.id
}

function pickSubagentRun(
  runs: ReadonlyArray<WorkflowRunSummary>,
  parentToolCallId: string | undefined,
): WorkflowRunSummary | undefined {
  if (runs.length === 0) return undefined
  let best = runs[0]!
  for (let i = 1; i < runs.length; i++) {
    const candidate = runs[i]!
    if (isStrongerRunOwner(candidate, best, parentToolCallId)) best = candidate
  }
  return best
}

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

export interface BuildExecutionTreeInput {
  rootConversationId: number
  conversations: ReadonlyArray<ConversationSummary>
  runs?: ReadonlyArray<WorkflowRunSummary>
}

export function buildLeafNodesForRun(run: WorkflowRunSummary): ExecutionNode[] {
  return (run.nodes ?? []).map((node) =>
    finalizeExecutionNode({
      key: `node:${run.id}:${node.id}`,
      kind: 'workflow-node',
      run,
      runNode: node,
      label: node.label,
      status: executionRunNodeStatus(node),
      updatedAt: run.updatedAt,
      children: [],
    }),
  )
}

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

/**
 * Build the unified execution tree for `rootConversationId`, rooted exclusively
 * in `runs` (`WorkflowRunSummary`):
 * - every `subagent` (foreground or background) and `SubagentWorkflow` has a
 *   `WorkflowRunSummary` in `runs` (ancestor-aggregated shard);
 * - conversations without a claiming `WorkflowRunSummary` (human forks,
 *   SuperAgent resident workers, etc.) are never mounted;
 * - descendant runs initiated by claimed child conversations recurse via
 *   `runsByParent.get(convId)` with cycle protection along `ancestry`.
 */
export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  if (runs.length === 0) return []

  const convById = new Map<number, ConversationSummary>()
  const convByParentAndCallId = new Map<string, ConversationSummary>()
  for (const conversation of conversations) {
    convById.set(conversation.id, conversation)
    if (
      conversation.parentConversationId !== undefined &&
      conversation.parentToolCallId !== undefined &&
      conversation.parentToolCallId !== ''
    ) {
      convByParentAndCallId.set(`${conversation.parentConversationId}\0${conversation.parentToolCallId}`, conversation)
    }
  }

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
  const subagentClaimedRunIds = new Set<string>()
  const dslConvOwner = new Map<number, WorkflowRunSummary>()

  for (const run of uniqueRuns) {
    const siblings = runsByParent.get(run.conversationId)
    if (siblings !== undefined) siblings.push(run)
    else runsByParent.set(run.conversationId, [run])

    if (run.kind === 'subagent') {
      const runNodes = run.nodes ?? []
      const claimedIds: number[] = []
      for (const node of runNodes) {
        if (node.conversationId !== undefined) claimedIds.push(node.conversationId)
      }
      if (
        claimedIds.length === 0 &&
        runNodes.every((n) => n.executionId === undefined) &&
        run.parentToolCallId !== undefined &&
        run.parentToolCallId !== ''
      ) {
        const byCall = convByParentAndCallId.get(`${run.conversationId}\0${run.parentToolCallId}`)
        if (byCall !== undefined) claimedIds.push(byCall.id)
      }
      if (claimedIds.length > 0) {
        subagentClaimedRunIds.add(run.id)
        let claims = subagentClaimsByParent.get(run.conversationId)
        if (claims === undefined) {
          claims = new Map()
          subagentClaimsByParent.set(run.conversationId, claims)
        }
        for (const convId of claimedIds) {
          const list = claims.get(convId)
          if (list !== undefined) list.push(run)
          else claims.set(convId, [run])
        }
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
        if (owner === undefined || isStrongerRunOwner(run, owner)) {
          dslConvOwner.set(node.conversationId, run)
        }
      }
    }
  }

  const childrenOf = (conversationId: number, ancestry: ReadonlySet<number>): ExecutionNode[] => {
    const nodes: ExecutionNode[] = []
    const dslClaimed = dslClaimedByParent.get(conversationId)
    const claims = subagentClaimsByParent.get(conversationId)

    // 1) Subagent conversations claimed by `kind: 'subagent'` runs of this conversation
    // (conversations also claimed by a DSL run mount under that DSL run instead).
    if (claims !== undefined) {
      for (const [claimedId, claimedRuns] of claims) {
        if (dslClaimed?.has(claimedId) === true || ancestry.has(claimedId)) continue
        const summary = convById.get(claimedId)
        const subagentRun = pickSubagentRun(claimedRuns, summary?.parentToolCallId)
        const firstNode = subagentRun?.nodes?.find((n) => n.conversationId === claimedId) ?? subagentRun?.nodes?.[0]
        nodes.push(
          finalizeExecutionNode({
            key: `conv:${claimedId}`,
            kind: 'conversation',
            conversationId: claimedId,
            ...(summary !== undefined ? { summary } : {}),
            ...(subagentRun !== undefined ? { run: subagentRun } : {}),
            ...(firstNode?.label !== undefined ? { label: firstNode.label } : {}),
            status: executionConversationStatus(summary, subagentRun),
            updatedAt: Math.max(summary?.updatedAt ?? 0, subagentRun?.updatedAt ?? 0),
            children: childrenOf(claimedId, new Set(ancestry).add(claimedId)),
          }),
        )
      }
    }

    // 2) Runs started by this conversation: external subagent runs (without a
    // native conversation) and DSL workflow runs (with in-run nodes + claimed child conversations).
    for (const run of runsByParent.get(conversationId) ?? []) {
      const runNodes = run.nodes ?? []
      if (run.kind === 'subagent') {
        if (subagentClaimedRunIds.has(run.id)) continue
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
              convId === undefined ||
              ancestry.has(convId) ||
              dslConvOwner.get(convId) !== run ||
              mountedConvIds.has(convId)
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
              ...(summary !== undefined ? { summary } : {}),
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
