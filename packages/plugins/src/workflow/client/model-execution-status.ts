/**
 * Pure logic for the builtin:workflow client: status enums and aggregation
 * for the unified execution tree — five-value status mapping (conversation /
 * run / run node), bottom-up aggregation and effective card status synthesis
 * (zero React/DOM dependencies).
 */
import type { ConversationSummary } from '@helmx/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { subagentBadge } from './model-subagent-card.ts'
import type { SubagentCardStatus } from './model-subagent-card.ts'

/** Unified execution node status (same five-value enum as the subagent card status). */
export type ExecutionNodeStatus = SubagentCardStatus

/**
 * Bottom-up status aggregation: blocked > error > working win; "done" only
 * when every status is done — while pending exists (e.g. unexecuted phase
 * nodes) it must not be masked into overall completion (no naive
 * lightest-value completion); an empty set returns pending.
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
 * Subtree aggregate counts (self plus all descendants).
 *
 * total / done / running / blocked / error only count real execution tasks:
 * workflow / external container shells do not count themselves when they have
 * children (one real execution is counted once, a wrapper is not an
 * independently completed task; an empty run without children still counts
 * 1); when the same conversation is referenced by multiple historical/resumed
 * runs, single mounting is guaranteed by the tree builder — no double
 * counting either.
 */
export interface ExecutionAggregate {
  status: ExecutionNodeStatus
  /** Total real execution tasks in the subtree (container shells not double counted). */
  total: number
  done: number
  running: number
  blocked: number
  error: number
}

/**
 * Conversation node status: same source as the card badge (subagentBadge is
 * authoritative) so tree aggregation and card display stay consistent;
 * pending without any data, never fake completion.
 *
 * Approval facts additionally resolve via pendingAskCount > 0 (same source as
 * AskDock): the AskDoc of a Herdr external execution belongs to the native
 * parent conversation, where the conversation status may still be working —
 * any open ask means blocked, so an approval ticket never stays invisible in
 * the card/tree.
 */
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

/** Workflow run status mapping. */
export function executionRunStatus(run: Pick<WorkflowRunSummary, 'status'>): ExecutionNodeStatus {
  if (run.status === 'running') return 'working'
  if (run.status === 'failed' || run.status === 'aborted') return 'error'
  return 'done'
}

/**
 * Honest status-light word for an aggregated execution status: the five-value
 * aggregation collapses aborted runs into `error`, but the status light keeps
 * the dedicated `aborted` tone (hollow warn diamond) — aborted must never pose
 * as a plain failure or a neutral gray.
 *
 * Precision rule: the aborted diamond is shown ONLY when the error verdict
 * stems from the run's own abort. When the subtree has real failures of its
 * own (`descendantError`), those errors keep the plain `error` light even if
 * the backing run was also aborted — a real child failure must never be masked
 * by the run-level abort. Non-error verdicts pass through untouched.
 */
export function executionLightStatus(
  status: ExecutionNodeStatus,
  run: Pick<WorkflowRunSummary, 'status'> | undefined,
  descendantError?: boolean,
): string {
  if (status === 'error' && run?.status === 'aborted' && descendantError !== true) {
    return 'aborted'
  }
  return status
}

/** In-run node status mapping (skipped counts as settled-done). */
export function executionRunNodeStatus(node: Pick<WorkflowNodeState, 'status'>): ExecutionNodeStatus {
  if (node.status === 'running') return 'working'
  if (node.status === 'failed') return 'error'
  if (node.status === 'pending') return 'pending'
  return 'done'
}

/**
 * Run card effective status: synthesized from the same source as the
 * execution tree — the run's own terminal status + subtree aggregate (its
 * own terminal status when there is no subtree data). While background /
 * deep subtasks are unsettled (working / blocked / error / pending) the main
 * badge never fakes completion.
 */
export function effectiveRunNodeStatus(
  run: Pick<WorkflowRunSummary, 'status'>,
  subtree: ExecutionAggregate | undefined,
): ExecutionNodeStatus {
  if (subtree === undefined || subtree.total === 0) return executionRunStatus(run)
  return aggregateExecutionStatuses([executionRunStatus(run), subtree.status])
}

/** Parent tool status derivation for compact cards (shared by Active-First ordering and card badges). */
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
