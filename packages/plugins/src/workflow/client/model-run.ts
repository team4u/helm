/**
 * Pure logic for the builtin:workflow client: SubagentWorkflow tool call ↔
 * run precise association (structuredOutput + parentToolCallId, zero regex
 * scraping), workflow run card phase grouping / log beacons / node summaries /
 * action availability and node stats (zero React/DOM dependencies).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowNodeState, WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf, formatShortModelName, inputString, inspectString, isPlaceholderRunName } from './model-format.ts'
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

function parseJsonObject(source: unknown): Record<string, unknown> | undefined {
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

function extractWorkflowRunIdFromPayload(source: unknown): string | undefined {
  const obj = parseJsonObject(source)
  if (obj === undefined) return undefined
  const summary = obj['summary']
  if (summary !== null && typeof summary === 'object' && !Array.isArray(summary)) {
    const summaryId = (summary as Record<string, unknown>)['id']
    if (typeof summaryId === 'string' && summaryId !== '') return summaryId
  }
  if (typeof obj['id'] === 'string' && obj['id'] !== '') return obj['id']
  if (typeof obj['runId'] === 'string' && obj['runId'] !== '') return obj['runId']
  return undefined
}

/** Resolve the workflow run linked to a SubagentWorkflow tool call (precise association, never guess "latest"). */
export function resolveWorkflowRunForTool(
  input: { callId: string | undefined; structuredOutput?: unknown; result?: unknown },
  parentConversationId: number,
  workflowRuns: ReadonlyArray<WorkflowRunSummary>,
): WorkflowRunSummary | undefined {
  if (input.callId !== undefined && input.callId !== '') {
    const byCallId = workflowRuns.find(
      (r) => r.conversationId === parentConversationId && r.parentToolCallId === input.callId,
    )
    if (byCallId !== undefined) return byCallId
  }
  const runId =
    extractWorkflowRunIdFromPayload(input.structuredOutput) ??
    extractWorkflowRunIdFromPayload(input.result)
  if (runId !== undefined) {
    return workflowRuns.find((r) => r.conversationId === parentConversationId && r.id === runId)
  }
  return undefined
}

/** Whether a SubagentWorkflow tool output is a background dispatch handle (not the final settlement). */
export function isBackgroundWorkflowResultHandle(
  structuredOutput: unknown,
  fallbackResult?: unknown,
): boolean {
  const record =
    parseJsonObject(structuredOutput) ??
    (fallbackResult !== undefined ? parseJsonObject(fallbackResult) : undefined)
  return record?.['background'] === true
}

/** Readable display name for a workflow run: non-placeholder name > first line of description > run.id. */
export function resolveWorkflowRunDisplayName(
  run: Pick<WorkflowRunSummary, 'id' | 'name' | 'description'>,
): string {
  const trimmedName = run.name.trim()
  if (!isPlaceholderRunName(trimmedName, run.id)) return trimmedName
  if (run.description !== undefined && run.description.trim() !== '') {
    const line = firstLineOf(run.description, 60)
    if (line !== '') return line
  }
  return run.id
}

/** Extract a readable title from the tool input when no run record is linked, avoiding blank space. */
export function resolveWorkflowToolFallbackLabel(input: unknown, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  const label = inputString(input, 'label')
  if (label !== undefined) return firstLineOf(label, 60)
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
// Workflow card pure logic
// ---------------------------------------------------------------------------

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

export interface WorkflowLogLine {
  key: string
  at: number
  message: string
}

export function extractWorkflowLogs(run: WorkflowRunSummary): WorkflowLogLine[] {
  return (run.progress ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'log' }> => p.kind === 'log')
    .map((p, idx) => ({ key: `log:${idx}:${p.at}`, at: p.at, message: p.message }))
}

const NON_RESUMABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'workflow_action_uncertain',
  'crash_recovery_limit',
  'secret_grant_expired_on_restart',
  'validation_error',
  'syntax_error',
])

function isNonResumableRun(run: Pick<WorkflowRunSummary, 'errorCode' | 'error'>): boolean {
  if (run.errorCode !== undefined && NON_RESUMABLE_ERROR_CODES.has(run.errorCode)) {
    return true
  }
  if (run.error === undefined) return false
  const normalized = run.error.toLowerCase()
  return (
    normalized.includes('workflow_action_uncertain') ||
    normalized.includes('crash_recovery_limit') ||
    normalized.includes('secret_grant_expired_on_restart') ||
    normalized.includes('validation_error') ||
    normalized.includes('workflow script has a syntax error')
  )
}

/** Checkpoint-resume availability: honors authoritative `run.resumable` on failed runs when present. */
export function canResumeWorkflowRun(run: WorkflowRunSummary): boolean {
  if (run.kind === 'subagent') return false
  if (run.resumedByRunId !== undefined) return false
  if (run.status === 'failed') {
    if (typeof run.resumable === 'boolean') return run.resumable
    return !isNonResumableRun(run)
  }
  return run.status === 'aborted' && !isNonResumableRun(run)
}

function hasRunExecutionHandle(run: WorkflowRunSummary): boolean {
  return (run.nodes ?? []).some(
    (node) =>
      (node.conversationId !== undefined && Number.isSafeInteger(node.conversationId) && node.conversationId > 0) ||
      (typeof node.executionId === 'string' && node.executionId.trim() !== ''),
  )
}

export function canResumeSubagentRun(
  run: WorkflowRunSummary | undefined,
  hasExecutionHandle: boolean,
): boolean {
  if (run === undefined || run.kind !== 'subagent') return false
  if (run.resumedByRunId !== undefined) return false
  if (run.status === 'failed' && typeof run.resumable === 'boolean') return run.resumable
  if (run.status !== 'failed' && run.status !== 'aborted') return false
  return (hasExecutionHandle || hasRunExecutionHandle(run)) && !isNonResumableRun(run)
}

/**
 * Filter failed runs under `conversationId` that can be batch-resumed:
 * prefers authoritative `run.resumable` when present on the summary.
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
    if (typeof run.resumable === 'boolean') {
      if (run.resumable) result.push(run)
      continue
    }
    if (isNonResumableRun(run)) continue
    if (run.kind === 'subagent' && !hasRunExecutionHandle(run)) continue
    result.push(run)
  }
  return result
}

export interface ResumeFailedSummaryView {
  resumedCount: number
  skippedCount: number
}

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

export interface DetachViewerScope {
  conversationId?: number
  ownedBy?: string
}

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

export function canReplayWorkflowRun(run: WorkflowRunSummary): boolean {
  return run.kind !== 'subagent' && run.status === 'completed'
}

export function formatWorkflowNodeStats(node: WorkflowNodeState): string[] {
  const segments: string[] = []
  const model = formatShortModelName(node.model)
  if (model !== undefined) segments.push(model)
  if (node.tokens !== undefined && node.tokens > 0) {
    segments.push(node.tokens >= 1000 ? `${(node.tokens / 1000).toFixed(1)}k` : `${node.tokens}`)
  }
  return segments
}

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
