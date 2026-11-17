/**
 * Pure logic for the builtin:workflow client: subagent runtime association —
 * tool call ↔ subagent / background run / worktree / external run resolution
 * (footer and JSON envelope parsing, precise callId / resume association,
 * siblingCalls multi-resume folding; zero React/DOM dependencies).
 */
import type { ConversationSummary, ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { inputString } from './model-format.ts'

/** Standard kernel subagentFooter metadata line `[subagent ...]` (last one wins: the footer is always last, forged body lines cannot take over). */
const SUBAGENT_FOOTER_LINE_RE = /\[subagent ([^\]]*)\]/g

/** `key=value` token inside the footer (values may contain anything but whitespace/]/, covering `worktree=PATH@BRANCH`). */
const FOOTER_TOKEN_RE = /(\w+)=([^\s\]]+)/g

/** Extract the given key from the last footer line (the footer is always last, forged body lines cannot take over). */
function subagentFooterToken(text: string, key: string): string | undefined {
  let footer: string | undefined
  for (const match of text.matchAll(SUBAGENT_FOOTER_LINE_RE)) {
    if (match[0].includes('=')) footer = match[1]
  }
  if (footer === undefined) return undefined
  let last: string | undefined
  for (const match of footer.matchAll(FOOTER_TOKEN_RE)) {
    if (match[1] === key && match[2] !== '') last = match[2]
  }
  return last
}

function subagentFooterConversationId(text: string): number | undefined {
  const raw = subagentFooterToken(text, 'conversationId')
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Execution metadata of the top-level JSON envelope of a subagent tool output. */
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

export function parseSubagentExecutionInfo(text: string | undefined): SubagentExecutionInfo | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  // Split off the trailing footer: the body is the JSON envelope (the footer
  // is not a legal JSON member).
  const body = text.replace(SUBAGENT_FOOTER_LINE_RE, '').trim()
  if (!body.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const envelope = parsed as Record<string, unknown>
  if (envelope['execution'] === undefined && envelope['runId'] === undefined) return undefined
  const info: SubagentExecutionInfo = {}
  const execution = envelope['execution']
  if (execution !== null && typeof execution === 'object' && !Array.isArray(execution)) {
    const exec = execution as Record<string, unknown>
    if (typeof exec['nodeId'] === 'string' && exec['nodeId'] !== '') info.nodeId = exec['nodeId']
    if (typeof exec['conversationId'] === 'number' && Number.isSafeInteger(exec['conversationId']) && exec['conversationId'] > 0) {
      info.conversationId = exec['conversationId']
    }
    if (typeof exec['executionId'] === 'string' && exec['executionId'] !== '') info.executionId = exec['executionId']
    if (typeof exec['effectiveCwd'] === 'string' && exec['effectiveCwd'] !== '') info.effectiveCwd = exec['effectiveCwd']
    const wt = exec['worktree']
    if (
      wt !== null && typeof wt === 'object' && !Array.isArray(wt) &&
      typeof (wt as Record<string, unknown>)['path'] === 'string' && (wt as Record<string, unknown>)['path'] !== '' &&
      typeof (wt as Record<string, unknown>)['branch'] === 'string'
    ) {
      info.worktree = { path: (wt as Record<string, unknown>)['path'] as string, branch: (wt as Record<string, unknown>)['branch'] as string }
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

function subagentJsonConversationId(text: string | undefined): number | undefined {
  return parseSubagentExecutionInfo(text)?.conversationId
}

/**
 * Resolve the subagent conversation id linked to a subagent tool call:
 * 1) settled: the top-level JSON envelope execution.conversationId first
 *    (structured read), then the kernel subagentFooter standard trailing
 *    metadata line;
 * 2) in flight: precise association by callId against the subconversation's
 *    parentToolCallId;
 * 3) resume: a numeric resume ref in the input matches that subconversation
 *    of the same parent conversation.
 */
export function resolveSubagentConversationId(
  input: {
    callId: string | undefined
    input: unknown
    result?: unknown
  },
  parentConversationId: number,
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'parentToolCallId'>>,
): number | undefined {
  const resultText = typeof input.result === 'string' ? input.result : undefined
  if (resultText !== undefined) {
    const fromJson = subagentJsonConversationId(resultText)
    if (fromJson !== undefined) return fromJson
    const fromFooter = subagentFooterConversationId(resultText)
    if (fromFooter !== undefined) return fromFooter
  }
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
  // Resume accepts both the positive-integer number and the pure-digit
  // string input forms (safe integers; negatives/decimals never match).
  const resumeId =
    typeof resumeRefRaw === 'number' && Number.isSafeInteger(resumeRefRaw) && resumeRefRaw > 0
      ? resumeRefRaw
      : typeof resumeRefRaw === 'string' && /^\d+$/.test(resumeRefRaw)
        ? Number(resumeRefRaw)
        : undefined
  if (
    resumeId !== undefined && Number.isSafeInteger(resumeId) && resumeId > 0 &&
    conversations.some((c) => c.id === resumeId && c.parentConversationId === parentConversationId)
  ) {
    return resumeId
  }
  return undefined
}

/** footer `worktree=PATH@BRANCH`: the kernel PATH@BRANCH shape; unreliable when PATH contains spaces (JSON wins). */
function worktreeFromFooterToken(token: string): { path: string; branch: string } | undefined {
  const at = token.lastIndexOf('@')
  if (at <= 0 || at === token.length - 1) return undefined
  const path = token.slice(0, at)
  const branch = token.slice(at + 1)
  return path !== '' && branch !== '' ? { path, branch } : undefined
}

/** Execution metadata of a subagent tool call (background run / worktree / external run identity). */
export interface SubagentExecutionMeta {
  run?: WorkflowRunSummary
  /** Managed worktree coordinates (kept honestly when run nodes carry the registration id/baseCommit, for precise inspection/cleanup). */
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  executionId?: string
  nodeId?: string
  effectiveCwd?: string
}

/** Resolve a subagent tool call's execution metadata (background run / worktree / external run identity). */
export function resolveSubagentExecutionMeta(
  input: { callId: string | undefined; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): SubagentExecutionMeta {
  let run: WorkflowRunSummary | undefined
  if (input.callId !== undefined && input.callId !== '') {
    run = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
  }
  const resultText = typeof input.result === 'string' ? input.result : undefined
  const info = parseSubagentExecutionInfo(resultText)
  if (run === undefined) {
    const runId = info?.runId ?? subagentFooterToken(resultText ?? '', 'runId')
    if (runId !== undefined && runId.startsWith('wf_')) {
      run = workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === runId)
    }
  }
  const fromRun = run?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const fromJson = info?.worktree
  const fromFooter = worktreeFromFooterToken(subagentFooterToken(resultText ?? '', 'worktree') ?? '')
  const worktree = fromRun ?? fromJson ?? fromFooter
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
  isError?: boolean
}

/**
 * Whether the current callId is the latest subagent call for the same native /
 * external execution target among siblingCalls: old calls superseded by a
 * later resume render a single-line summary capsule only; the latest call
 * mounts the live subconversation stream.
 */
export function isLatestSubagentCallForTarget(
  props: Pick<ToolViewProps, 'callId' | 'input' | 'result' | 'siblingCalls' | 'conversationId'>,
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
        { callId: call.callId, input: call.input, result: call.result },
        props.conversationId,
        conversations,
      )
      if (resolved === childConversationId) return false
    } else {
      const execution = parseSubagentExecutionInfo(typeof call.result === 'string' ? call.result : undefined)
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
    ...(props.isError === true ? { isError: true } : {}),
  }
}
