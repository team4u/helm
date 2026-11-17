/**
 * Pure logic for the builtin:workflow client: unified execution tree
 * ExecutionNode building — conversation chain recursion + whole-run
 * projection placement, DSL claim dedup and Active-First ordering (status
 * mapping and aggregation live in model-execution-status, presentation
 * summaries in model-execution-view; zero React/DOM dependencies).
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

/** Execution tree node kind: native subagent / workflow run / in-run node / external run. */
export type ExecutionNodeKind = 'conversation' | 'workflow' | 'workflow-node' | 'external'

/** Unified execution tree node: SubagentLiveCard / WorkflowRunCard / WorkflowNodeCard / external run summary share the same recursive shape. */
export interface ExecutionNode {
  key: string
  kind: ExecutionNodeKind
  /** Openable native subagent id (workflow / workflow-node / conversation-less external do not carry one). */
  conversationId?: number
  /** Linked workflow run (for conversation nodes: the claimed background run; for workflow / external nodes: their own run). */
  run?: WorkflowRunSummary
  /** Raw in-run node (carried by children of workflow nodes). */
  runNode?: WorkflowNodeState
  /** Display title (distilled from real data only). */
  label?: string
  /** Live conversation summary (from the conversation list when present, never invented). */
  summary?: ConversationSummary
  /** Leaf's own status; the whole subtree status lives in aggregated.status. */
  status: ExecutionNodeStatus
  /** Next-level children. */
  children: ExecutionNode[]
  /** Bottom-up aggregate (self plus all descendants). */
  aggregated: ExecutionAggregate
  /** Latest update time for ordering (max of summary / run). */
  updatedAt: number
}

/** Pick the currently linked run among multiple background runs claiming the same subagent. */
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

/** Merge the aggregates of a set of nodes (used by card headers aggregating direct subtrees, excluding any "self"). */
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
 * Compute a node's own aggregate once all children are aggregated
 * (post-order; includes self).
 *
 * - Containers (workflow / external run shells) do not count themselves as
 *   tasks when they have children: one real execution is counted once, a
 *   wrapper is not an independently completed task; an empty run without
 *   children still counts 1 (the run itself is one real execution);
 * - The status synthesizes self and descendants via
 *   aggregateExecutionStatuses: while descendants are active / error /
 *   blocked / unsettled (including running background subtasks and pending
 *   phase nodes) the whole is never marked complete.
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

/** Workbench ordering: blocked > working > error > done/pending (Active-First); same rank by updatedAt descending. */
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

/** Input for building the execution tree. */
export interface BuildExecutionTreeInput {
  rootConversationId: number
  /** Full conversation summaries (useConversations); recursion at any depth via parentConversationId. */
  conversations: ReadonlyArray<ConversationSummary>
  /** Ancestor-aggregated runs projection for the root conversation
   * (usePluginSessionDoc('runs'), including all descendants; each run keeps
   * its original conversationId); deep conversations without run data only
   * recurse via the conversation chain — never invented. */
  runs?: ReadonlyArray<WorkflowRunSummary>
}

/** Fallback leaf for in-run nodes without a conversation / whose conversation is on the ancestor chain. */
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

/** DSL reference ownership: a running run wins (after a resume the new run
 * takes over still-running references), then the latest createdAt, then a
 * stable id ordering (independent of shard order). */
function isStrongerDslConvOwner(candidate: WorkflowRunSummary, current: WorkflowRunSummary): boolean {
  const candidateRunning = candidate.status === 'running'
  const currentRunning = current.status === 'running'
  if (candidateRunning !== currentRunning) return candidateRunning
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  return candidate.id > current.id
}

/**
 * Build the unified execution tree: the next-level execution nodes of
 * rootConversationId (recursive at any depth).
 *
 * - The runs input is the whole projection of "this conversation + all
 *   descendants" (each run keeps its original conversationId, provided by the
 *   backend aggregate shard); a run id arriving twice is deduped — no run is
 *   lost from the tree and none is mounted twice;
 * - Conversation children recurse via parentConversationId; conversations
 *   claimed by a DSL run mount under the run node and do not reappear; when
 *   the same conversation is referenced by multiple historical/resumed DSL
 *   runs it mounts only once (ownership per isStrongerDslConvOwner);
 *   references from other runs stay as plain leaf rows — visible but not
 *   double counted;
 * - Direct subagent conversations claimed by a background single-subagent run
 *   stay conversation nodes carrying the run; when the conversation list is
 *   missing them only the run is carried, no summary invented;
 * - Background runs without any conversation association become external
 *   execution nodes (in-run nodes as leaves);
 * - A parentConversationId cycle is defensively cut along the ancestor chain.
 */
export function buildExecutionTree(input: BuildExecutionTreeInput): ExecutionNode[] {
  const { rootConversationId, conversations, runs = [] } = input
  const convById = new Map<number, ConversationSummary>()
  for (const conversation of conversations) convById.set(conversation.id, conversation)

  // Aggregate shards may carry the same run twice (overlapping projections /
  // incremental events): dedupe by id.
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

    // 1) Direct conversation children: conversations claimed by a DSL run
    // mount under the run node instead of reappearing here.
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

    // 2) Conversations visible only via background runs (conversation list
    // missing their summaries): carry the run honestly, never invent a summary.
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

    // 3) Runs started by this conversation: DSL workflows mount their node
    // subtree; background runs without conversation association are external runs.
    for (const run of runsByParent.get(conversationId) ?? []) {
      const runNodes = run.nodes ?? []
      if (run.kind === 'subagent') {
        if (runNodes.some((n) => n.conversationId !== undefined)) continue // conversation-linked runs already mounted in 1/2
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
      // A run referencing the same conversation twice also mounts it once
      // (later references stay as leaf rows).
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
