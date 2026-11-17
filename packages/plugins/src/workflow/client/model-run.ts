/**
 * Pure logic for the builtin:workflow client: SubagentWorkflow tool call ↔
 * run precise association, workflow run card phase grouping / log beacons /
 * node summaries / action availability and node stats (formerly
 * workflow-card-model.ts; zero React/DOM dependencies).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf, formatShortModelName, inputString, inspectString } from './model-format.ts'
import {
  DEFAULT_PHASE_TITLE,
  NODE_QUEUED,
  NODE_RUNNING_FALLBACK,
  NODE_SKIPPED,
  nodeAwaitingApproval,
  NODE_EXECUTION_FAILED,
  NODE_GATE_FAILED_FALLBACK,
  traceResumeFallbackLabel,
} from './copy.ts'

/** Precisely extract the run id field from tool output JSON (`"id":"wf_xxx"`; no substring/prefix matching). */
const WORKFLOW_RUN_ID_IN_RESULT_RE = /"id"\s*:\s*"([^"]+)"/

/** Resolve the workflow run linked to a SubagentWorkflow tool call (precise association, never guess "latest"). */
export function resolveWorkflowRunForTool(
  input: { callId: string | undefined; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkflowRunSummary | undefined {
  if (input.callId !== undefined && input.callId !== '') {
    const byCallId = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
    if (byCallId !== undefined) return byCallId
  }
  if (typeof input.result === 'string') {
    const runId = WORKFLOW_RUN_ID_IN_RESULT_RE.exec(input.result)?.[1]
    if (runId !== undefined) {
      const matched = workflowRuns.find(
        (r) => r.conversationId === parentConversationId && r.id === runId,
      )
      if (matched !== undefined) return matched
    }
  }
  return undefined
}

/** Whether a SubagentWorkflow tool result text is a background dispatch handle (not the final settlement). */
export function isBackgroundWorkflowResultHandle(result: unknown): boolean {
  if (typeof result !== 'string') return false
  const trimmed = result.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    return record['background'] === true
  } catch {
    return false
  }
}

/** Extract a readable title from the tool input when no run record is linked, avoiding blank space. */
export function resolveWorkflowToolFallbackLabel(input: unknown, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const name = inputString(input, 'name')
  if (name !== undefined) return firstLineOf(name, 60)
  const scriptPath = inputString(input, 'scriptPath')
  if (scriptPath !== undefined) return firstLineOf(scriptPath, 60)
  const resumeFromRunId = inputString(input, 'resumeFromRunId')
  if (resumeFromRunId !== undefined) return traceResumeFallbackLabel(resumeFromRunId, locale)
  const script = inputString(input, 'script')
  if (script !== undefined) {
    const metaName = /name\s*:\s*["']([^"']+)["']/.exec(script)?.[1]
    if (metaName !== undefined && metaName !== '') return metaName
    return firstLineOf(script, 60)
  }
  return 'SubagentWorkflow'
}

// ---------------------------------------------------------------------------
// Workflow card pure logic (formerly workflow-card-model.ts)
// ---------------------------------------------------------------------------

/** Whether the collapsed node row has extra detail worth expanding. */
export function hasNodeExtraDetail(node: WorkflowNodeState): boolean {
  return node.agentType !== undefined || node.executionId !== undefined || node.nodeId !== undefined ||
    node.effectiveCwd !== undefined || node.gateCommand !== undefined || node.prompt !== undefined
}

export interface NodeSummaryText {
  text?: string
  isError: boolean
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return '…'
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/** Compact one-line preview of a node's output. */
export function formatNodeOutputPreview(output: unknown, maxChars = 80): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') {
    const trimmed = output.trim()
    if (trimmed === '') return undefined
    return truncateWithEllipsis(firstLine(trimmed), maxChars)
  }
  let serialized: string
  try {
    serialized = JSON.stringify(output) ?? String(output)
  } catch {
    serialized = String(output)
  }
  if (serialized === '') return undefined
  return truncateWithEllipsis(serialized, maxChars)
}

/** Collapsed node row main summary (duration renders separately on the right). */
export function resolveNodeSummaryText(
  node: WorkflowNodeState,
  childDoing?: string,
  childStatus?: ConversationSummary['status'],
  pendingAskTitle?: string,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): NodeSummaryText {
  if (node.status === 'running' && childStatus === 'blocked') {
    return { text: nodeAwaitingApproval(pendingAskTitle ?? childDoing, locale), isError: false }
  }
  if (node.status === 'running') {
    const doing = childDoing?.trim()
    return {
      text: doing !== undefined && doing !== '' ? doing : (node.phaseTitle ?? resolveLocalizedText(NODE_RUNNING_FALLBACK, locale)),
      isError: false,
    }
  }
  if (node.status === 'failed') {
    if (node.error !== undefined && node.error.trim() !== '') {
      return { text: truncateWithEllipsis(firstLine(node.error.trim()), 100), isError: true }
    }
    if (node.gate?.ok === false) {
      const gateOutput = node.gate.output.trim()
      const text = gateOutput !== '' ? truncateWithEllipsis(firstLine(gateOutput), 100) : resolveLocalizedText(NODE_GATE_FAILED_FALLBACK, locale)
      return { text, isError: true }
    }
    return { text: resolveLocalizedText(NODE_EXECUTION_FAILED, locale), isError: true }
  }
  if (node.status === 'skipped') {
    return { text: node.error ?? resolveLocalizedText(NODE_SKIPPED, locale), isError: false }
  }
  if (node.status === 'done') {
    return { text: formatNodeOutputPreview(node.output), isError: false }
  }
  return { text: resolveLocalizedText(NODE_QUEUED, locale), isError: false }
}

/** Phase-grouped node view model. */
export interface WorkflowPhaseSection {
  key: string
  index: number
  title: string
  detail?: string
  status: 'pending' | 'running' | 'done' | 'failed'
  nodes: WorkflowNodeState[]
  doneCount: number
  totalCount: number
}

/**
 * Phase group status: running wins visibility, then failed; only full
 * settlement (done / skipped everywhere) counts as done — while pending
 * (unexecuted) nodes exist the run is still in progress, and a terminated run
 * must not fake completion either (pending must not be masked by done).
 */
function sectionStatus(
  nodes: WorkflowNodeState[],
  runStatus: WorkflowRunSummary['status'],
): WorkflowPhaseSection['status'] {
  if (nodes.some((n) => n.status === 'running')) return 'running'
  if (nodes.length === 0 || nodes.every((n) => n.status === 'pending')) return 'pending'
  if (nodes.some((n) => n.status === 'failed')) return 'failed'
  if (nodes.every((n) => n.status === 'done' || n.status === 'skipped')) return 'done'
  return runStatus === 'running' ? 'running' : 'pending'
}

/** Build the phase-grouped node view (no node is filtered out). */
export function buildWorkflowPhaseSections(run: WorkflowRunSummary, locale: HelmLocale = DEFAULT_HELM_LOCALE): WorkflowPhaseSection[] {
  const nodes = run.nodes ?? []
  const allNodes = [...nodes]
  const defaultSectionTitle = resolveLocalizedText(DEFAULT_PHASE_TITLE, locale)

  const declared: Array<{ title: string; detail?: string }> = []
  const seen = new Set<string>()
  const declare = (title: string, detail?: string): void => {
    const key = title.trim()
    if (key === '' || seen.has(key)) return
    seen.add(key)
    declared.push({ title: key, detail })
  }
  for (const phase of run.phases ?? []) declare(phase.title, phase.detail)
  for (const p of run.progress ?? []) {
    if (p.kind === 'phase') declare(p.title)
  }
  for (const node of allNodes) {
    if (node.phaseTitle !== undefined) declare(node.phaseTitle)
  }

  if (declared.length === 0) {
    const doneCount = allNodes.filter((n) => n.status === 'done').length
    return [
      {
        key: 'default',
        index: 0,
        title: '',
        nodes: allNodes,
        status: sectionStatus(allNodes, run.status),
        doneCount,
        totalCount: allNodes.length,
      },
    ]
  }

  const buckets = new Map<string, WorkflowNodeState[]>()
  const defaultNodes: WorkflowNodeState[] = []
  for (const node of allNodes) {
    const key = node.phaseTitle?.trim()
    if (key !== undefined && key !== '' && seen.has(key)) {
      const bucket = buckets.get(key)
      if (bucket !== undefined) bucket.push(node)
      else buckets.set(key, [node])
    } else {
      defaultNodes.push(node)
    }
  }

  const sections: WorkflowPhaseSection[] = declared.map((phase, idx) => {
    const group = buckets.get(phase.title) ?? []
    const doneCount = group.filter((n) => n.status === 'done').length
    return {
      key: `phase:${idx}:${phase.title}`,
      index: idx,
      title: phase.title,
      ...(phase.detail !== undefined ? { detail: phase.detail } : {}),
      status: sectionStatus(group, run.status),
      nodes: group,
      doneCount,
      totalCount: group.length,
    }
  })
  if (defaultNodes.length > 0) {
    const doneCount = defaultNodes.filter((n) => n.status === 'done').length
    sections.push({
      key: `phase:${declared.length}:${defaultSectionTitle}`,
      index: declared.length,
      title: defaultSectionTitle,
      status: sectionStatus(defaultNodes, run.status),
      nodes: defaultNodes,
      doneCount,
      totalCount: defaultNodes.length,
    })
  }
  return sections
}

/** Script log() beacon line. */
export interface WorkflowLogLine {
  key: string
  at: number
  message: string
}

/** Extract script log() beacons. */
export function extractWorkflowLogs(run: WorkflowRunSummary): WorkflowLogLine[] {
  return (run.progress ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'log' }> => p.kind === 'log')
    .map((p, idx) => ({ key: `log:${idx}:${p.at}`, at: p.at, message: p.message }))
}

/** Checkpoint-resume availability: only failed or aborted DSL-orchestrated workflows not yet superseded by a resume run. */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  return (
    run.kind !== 'subagent' &&
    (run.status === 'failed' || run.status === 'aborted') &&
    run.resumedByRunId === undefined
  )
}

function hasRunExecutionHandle(run: WorkflowRunSummary): boolean {
  return (run.nodes ?? []).some(
    (node) =>
      (node.conversationId !== undefined && Number.isSafeInteger(node.conversationId) && node.conversationId > 0) ||
      (typeof node.executionId === 'string' && node.executionId.trim() !== ''),
  )
}

/** 后台子代理单卡恢复可用判定：subagent 失败或中止、未被接管且具备可续接执行句柄。 */
export function canResumeSubagentRun(
  run: WorkflowRunSummary | undefined,
  hasExecutionHandle: boolean,
): boolean {
  if (run === undefined) return false
  if (run.kind !== 'subagent') return false
  if (run.status !== 'failed' && run.status !== 'aborted') return false
  if (run.resumedByRunId !== undefined) return false
  return hasExecutionHandle || hasRunExecutionHandle(run)
}

function isNonResumableRunError(error: string | undefined): boolean {
  if (error === undefined) return false
  const normalized = error.toLowerCase()
  return (
    normalized.includes('workflow_action_uncertain') ||
    normalized.includes('[crash_recovery_limit]') ||
    normalized.includes('crash_recovery_limit') ||
    normalized.includes('secret_grant_expired_on_restart') ||
    normalized.includes('[validation_error]') ||
    normalized.includes('validation_error') ||
    normalized.includes('workflow script has a syntax error')
  )
}

/**
 * 筛选当前会话下可自动批量恢复的失败记录（排除已被接管、不可自动恢复错误
 * 及无续接句柄的后台单子代理）。
 */
export function listResumableFailedRuns(
  runs: ReadonlyArray<WorkflowRunSummary>,
  conversationId: number,
): WorkflowRunSummary[] {
  const seenIds = new Set<string>()
  const result: WorkflowRunSummary[] = []
  for (const run of runs) {
    if (seenIds.has(run.id)) continue
    seenIds.add(run.id)
    if (run.conversationId !== conversationId) continue
    if (run.status !== 'failed') continue
    if (run.resumedByRunId !== undefined) continue
    if (isNonResumableRunError(run.error)) continue
    if (run.kind === 'subagent' && !hasRunExecutionHandle(run)) continue
    result.push(run)
  }
  return result
}

export interface ResumeFailedSummaryView {
  resumedCount: number
  skippedCount: number
}

/** 严格解析 resume_failed 动作结果（非法形状返回 undefined，绝不猜计数）。 */
export function parseResumeFailedResult(raw: unknown): ResumeFailedSummaryView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const resumed = record['resumed']
  const skipped = record['skipped']
  if (!Array.isArray(resumed) || !Array.isArray(skipped)) return undefined
  for (const item of resumed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    if (inspectString(item as Record<string, unknown>, 'id') === undefined) return undefined
  }
  for (const item of skipped) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const entry = item as Record<string, unknown>
    if (inspectString(entry, 'runId') === undefined || typeof entry['reason'] !== 'string') return undefined
  }
  return { resumedCount: resumed.length, skippedCount: skipped.length }
}

/**
 * "Move to background" viewer scope: the current viewing conversation (the
 * timeline is the initiating conversation; the workbench is the panel
 * conversation) plus its ownership. ownedBy defaults to human (the kernel
 * default); foreground-sync runs of bot/helm (automation) conversations hide
 * the button — the server refuses automation ownership anyway (prevents early
 * settlement), so the frontend hides it honestly instead of showing a doomed
 * entry point.
 */
export interface DetachViewerScope {
  conversationId?: number
  ownedBy?: string
}

/**
 * Foreground-sync run "move to background" availability: only running
 * foreground-sync runs (syncForeground marked and not yet detached) with an
 * explicit runId, where the current viewing conversation is the initiating
 * conversation and is human-owned (or defaults to human); hidden across
 * conversations / elsewhere in the workbench — the server still rechecks
 * authorization.
 */
export function canDetachForegroundRun(run: WorkflowRunSummary, viewer: DetachViewerScope | undefined): boolean {
  return (
    run.status === 'running' &&
    run.syncForeground === true &&
    run.detachedAt === undefined &&
    viewer?.conversationId === run.conversationId &&
    viewer.ownedBy !== 'bot' &&
    viewer.ownedBy !== 'helm'
  )
}

/**
 * Completed-run replay availability: non-subagent completed DSL runs
 * (including inline scripts). resumeFromRunId is also valid for completed
 * runs: the engine reuses the original script source (saved definitions
 * re-read the latest file; inline keeps its source) and the original args
 * (explicit args override), and the new run keeps the original conversation.
 * The journal cache only reuses prefix nodes whose call payloads are exactly
 * identical; real re-execution starts at the first mismatch — no promise that
 * changed args hit the cache, and nodes with external side effects re-run
 * honestly.
 */
export function canReplayWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && run.status === 'completed'
}

// ---------------------------------------------------------------------------
// Workbench node stats helpers
// ---------------------------------------------------------------------------

/** Node stat suffix: short model name + compact token count. */
export function formatWorkflowNodeStats(node: WorkflowNodeState): string[] {
  const segments: string[] = []
  const model = formatShortModelName(node.model)
  if (model !== undefined) segments.push(model)
  if (node.tokens !== undefined && node.tokens > 0) {
    segments.push(node.tokens >= 1000 ? `${(node.tokens / 1000).toFixed(1)}k` : `${node.tokens}`)
  }
  return segments
}

// ---------------------------------------------------------------------------
// Total duration resolution (real recorded boundaries only, never fabricate 0ms / made-up values)
// ---------------------------------------------------------------------------

/**
 * Run total duration: while running with a valid client clock (nowMs >=
 * createdAt) it advances with nowMs; otherwise (including SSR first frame
 * without a clock) it freezes at updatedAt - createdAt, the latest snapshot —
 * both are real boundaries; invalid differences return undefined (callers
 * omit honestly).
 */
export function resolveRunElapsedMs(
  run: Pick<WorkflowRunSummary, 'status' | 'createdAt' | 'updatedAt'>,
  nowMs?: number,
): number | undefined {
  if (
    run.status === 'running' &&
    nowMs !== undefined && Number.isFinite(nowMs) &&
    Number.isFinite(run.createdAt) && nowMs >= run.createdAt
  ) {
    return nowMs - run.createdAt
  }
  const settled = run.updatedAt - run.createdAt
  return Number.isFinite(settled) && settled >= 0 ? settled : undefined
}

/**
 * In-run node duration: running advances dynamically with startedAt + nowMs
 * (omitted honestly without a clock or a start point, keeping SSR
 * deterministic); settled freezes at the persisted durationMs; with no real
 * boundary (neither startedAt nor durationMs) it is omitted — a made-up 0ms
 * is never shown.
 */
export function resolveNodeElapsedMs(
  node: Pick<WorkflowNodeState, 'status' | 'startedAt' | 'durationMs'>,
  nowMs?: number,
): number | undefined {
  if (node.status === 'running') {
    return node.startedAt !== undefined && Number.isFinite(node.startedAt) &&
      nowMs !== undefined && Number.isFinite(nowMs) && nowMs >= node.startedAt
      ? nowMs - node.startedAt
      : undefined
  }
  return node.durationMs !== undefined && Number.isFinite(node.durationMs) && node.durationMs >= 0
    ? node.durationMs
    : undefined
}
