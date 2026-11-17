/**
 * Pure logic for the builtin:workflow client: subagent runtime association —
 * tool call ↔ subagent / background run / worktree / external run resolution
 * via structuredOutput + parentToolCallId + resume (zero regex/footer scraping,
 * zero React/DOM dependencies).
 */
import type { ConversationSummary, ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { inputString } from './model-format.ts'

/** Execution metadata of the top-level structured envelope of a subagent tool output. */
export interface SubagentExecutionInfo {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: { path: string; branch: string }
  runId?: string
  background?: boolean
  status?: string
}

function parseEnvelopeObject(source: unknown): Record<string, unknown> | undefined {
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    return source as Record<string, unknown>
  }
  if (typeof source !== 'string') return undefined
  const trimmed = source.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract subagent execution info from `structuredOutput` (preferred) or a
 * clean JSON envelope string `fallbackResult` (zero regex or footer scraping).
 */
export function parseSubagentExecutionInfo(
  source: unknown,
  fallbackResult?: unknown,
): SubagentExecutionInfo | undefined {
  const envelope = parseEnvelopeObject(source) ?? (fallbackResult !== undefined ? parseEnvelopeObject(fallbackResult) : undefined)
  if (envelope === undefined) return undefined
  if (envelope['execution'] === undefined && envelope['runId'] === undefined) return undefined
  const info: SubagentExecutionInfo = {}
  const execution = envelope['execution']
  if (execution !== null && typeof execution === 'object' && !Array.isArray(execution)) {
    const exec = execution as Record<string, unknown>
    if (typeof exec['nodeId'] === 'string' && exec['nodeId'] !== '') info.nodeId = exec['nodeId']
    if (
      typeof exec['conversationId'] === 'number' &&
      Number.isSafeInteger(exec['conversationId']) &&
      exec['conversationId'] > 0
    ) {
      info.conversationId = exec['conversationId']
    }
    if (typeof exec['executionId'] === 'string' && exec['executionId'] !== '') info.executionId = exec['executionId']
    if (typeof exec['effectiveCwd'] === 'string' && exec['effectiveCwd'] !== '') info.effectiveCwd = exec['effectiveCwd']
    const wt = exec['worktree']
    if (
      wt !== null &&
      typeof wt === 'object' &&
      !Array.isArray(wt) &&
      typeof (wt as Record<string, unknown>)['path'] === 'string' &&
      (wt as Record<string, unknown>)['path'] !== '' &&
      typeof (wt as Record<string, unknown>)['branch'] === 'string'
    ) {
      info.worktree = {
        path: (wt as Record<string, unknown>)['path'] as string,
        branch: (wt as Record<string, unknown>)['branch'] as string,
      }
    }
  }
  if (typeof envelope['runId'] === 'string' && envelope['runId'] !== '') info.runId = envelope['runId']
  if (typeof envelope['background'] === 'boolean') info.background = envelope['background']
  if (typeof envelope['status'] === 'string' && envelope['status'] !== '') info.status = envelope['status']
  return info.conversationId !== undefined ||
    info.executionId !== undefined ||
    info.worktree !== undefined ||
    info.runId !== undefined
    ? info
    : undefined
}

/**
 * Resolve the subagent conversation id linked to a subagent tool call:
 * 1) settled: `structuredOutput.execution.conversationId` (or clean JSON envelope);
 * 2) in flight: precise association by `callId` against `parentToolCallId`;
 * 3) resume: numeric `resume` ref matching a child of the same parent conversation.
 */
export function resolveSubagentConversationId(
  input: {
    callId: string | undefined
    input: unknown
    structuredOutput?: unknown
    result?: unknown
  },
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  const fromStructured = parseSubagentExecutionInfo(input.structuredOutput, input.result)?.conversationId
  if (fromStructured !== undefined) return fromStructured

  if (input.callId !== undefined && input.callId !== '') {
    for (const c of conversations) {
      if (c.parentConversationId === parentConversationId && c.parentToolCallId === input.callId) {
        return c.id
      }
    }
  }
  const resumeRefRaw =
    input.input !== null && typeof input.input === 'object' && !Array.isArray(input.input)
      ? (input.input as Record<string, unknown>)['resume']
      : undefined
  const resumeId =
    typeof resumeRefRaw === 'number' && Number.isSafeInteger(resumeRefRaw) && resumeRefRaw > 0
      ? resumeRefRaw
      : typeof resumeRefRaw === 'string' && /^\d+$/.test(resumeRefRaw)
        ? Number(resumeRefRaw)
        : undefined
  if (
    resumeId !== undefined &&
    Number.isSafeInteger(resumeId) &&
    resumeId > 0 &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

/** Execution metadata of a subagent tool call (background run / worktree / external run identity). */
export interface SubagentExecutionMeta {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  executionId?: string
  nodeId?: string
  effectiveCwd?: string
}

/** Resolve a subagent tool call's execution metadata from `parentToolCallId` + `structuredOutput`. */
export function resolveSubagentExecutionMeta(
  input: { callId: string | undefined; structuredOutput?: unknown; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  let run: WorkflowRunSummary | undefined
  if (input.callId !== undefined && input.callId !== '') {
    run = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
  }
  const info = parseSubagentExecutionInfo(input.structuredOutput, input.result)
  if (run === undefined && info?.runId !== undefined && info.runId.startsWith('wf_')) {
    run = workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === info.runId)
  }
  const worktree = run?.nodes?.find((n) => n.worktree !== undefined)?.worktree ?? info?.worktree
  return {
    ...(run !== undefined ? { run } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(info?.executionId !== undefined ? { executionId: info.executionId } : {}),
    ...(info?.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
    ...(info?.effectiveCwd !== undefined ? { effectiveCwd: info.effectiveCwd } : {}),
  }
}

/** Lightweight parent tool summary (collapsed header data source). */
export interface SubagentParentToolSummary {
  prompt?: string
  startedAt?: number
  durationMs?: number
  resultText?: string
  structuredOutput?: unknown
  isError?: boolean
}

/**
 * Whether the current callId is the latest subagent call for the same native /
 * external execution target among siblingCalls.
 */
export function isLatestSubagentCallForTarget(
  props: Pick<ToolViewProps, 'callId' | 'input' | 'result' | 'structuredOutput' | 'siblingCalls' | 'conversationId'>,
  childConversationId: number | undefined,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
  externalExecutionId?: string,
): boolean {
  if (childConversationId === undefined && externalExecutionId === undefined) return true
  const siblings = props.siblingCalls ?? []
  const selfIndex = siblings.findIndex((call) => call.callId === props.callId)
  if (selfIndex === -1) return true
  for (const call of siblings.slice(selfIndex + 1)) {
    if (call.toolName !== 'subagent') continue
    if (childConversationId !== undefined) {
      const resolved = resolveSubagentConversationId(
        {
          callId: call.callId,
          input: call.input,
          structuredOutput: call.structuredOutput,
          result: call.result,
        },
        props.conversationId,
        conversations,
      )
      if (resolved === childConversationId) return false
    } else {
      const execution = parseSubagentExecutionInfo(call.structuredOutput, call.result)
      if ((execution?.executionId ?? inputString(call.input, 'resume')) === externalExecutionId) return false
    }
  }
  return true
}

/** Build the lightweight parent tool summary from ToolViewProps. */
export function parentToolSummaryOf(props: ToolViewProps): SubagentParentToolSummary {
  return {
    ...(inputString(props.input, 'prompt') !== undefined ? { prompt: inputString(props.input, 'prompt')! } : {}),
    ...(props.startedAt !== undefined ? { startedAt: props.startedAt } : {}),
    ...(props.durationMs !== undefined ? { durationMs: props.durationMs } : {}),
    ...(typeof props.result === 'string' ? { resultText: props.result } : {}),
    ...(props.structuredOutput !== undefined ? { structuredOutput: props.structuredOutput } : {}),
    ...(props.isError === true ? { isError: true } : {}),
  }
}
