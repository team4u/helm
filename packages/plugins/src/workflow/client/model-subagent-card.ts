/**
 * Pure logic for the builtin:workflow client: subagent card status badges,
 * task titles, total duration and the second-layer dynamic subline (zero
 * React/DOM dependencies).
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/plugin-client'
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
} from '@helmx/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  extractCleanPreviewLine,
  firstLineOf,
  isPlaceholderNodeLabel,
  isPlaceholderRunName,
  isPlaceholderSubagentTitle,
  stripStructuredOutputContract,
} from './model-format.ts'
import { parseSubagentExecutionInfo, type SubagentParentToolSummary } from './model-subagent-link.ts'
import { buildSubagentStreamLines, formatSemanticToolAction } from './model-subagent-stream.ts'
import {
  runFailureFallbackLabel as runFailureFallbackCopy,
  SNIPPET_AWAITING_APPROVAL,
  SNIPPET_AWAITING_HUMAN,
  SNIPPET_ERROR,
  SNIPPET_FAILED,
  SNIPPET_GATE_CHECK,
  SNIPPET_LOAD_FAILED,
  SNIPPET_OUTPUT,
  SNIPPET_PARALLEL_MORE,
  SNIPPET_STARTING,
  SNIPPET_SUBAGENT_ERROR,
  SNIPPET_THINKING,
  snippetParallelTools,
  subagentBadgeLabel,
  type SubagentBadgeLabelKey,
} from './copy.ts'

export type SubagentCardStatus = 'working' | 'blocked' | 'error' | 'done' | 'pending'

export interface SubagentBadge {
  status: SubagentCardStatus
  label: string
  badge: string
}

export type SubagentRunView = Pick<WorkflowRunSummary, 'status' | 'syncForeground' | 'detachedAt'>

function isTrueBackgroundRun(run: SubagentRunView): boolean {
  return !(run.syncForeground === true && run.detachedAt === undefined)
}

export function runFailureFallbackLabel(run: SubagentRunView, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return runFailureFallbackCopy(isTrueBackgroundRun(run), locale)
}

export function subagentBadge(
  summaryStatus: string | undefined,
  toolStatus: 'running' | 'done' | 'error' | 'unknown',
  run?: SubagentRunView,
  options?: { isBackgroundHandle?: boolean; handleStatus?: string },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): SubagentBadge {
  const trueBackground = run !== undefined && isTrueBackgroundRun(run)
  const label = (key: SubagentBadgeLabelKey): string => subagentBadgeLabel(key, locale)
  if (summaryStatus === 'blocked') return { status: 'blocked', label: label('blocked'), badge: 'badge-warn' }
  if (summaryStatus === 'working') {
    return {
      status: 'working',
      label: trueBackground ? label('workingBackground') : label('working'),
      badge: 'badge-accent',
    }
  }
  if (
    run?.status === 'running' &&
    (summaryStatus === 'idle' || summaryStatus === 'done' || summaryStatus === undefined)
  ) {
    return { status: 'working', label: trueBackground ? label('workingBackground') : label('working'), badge: 'badge-accent' }
  }
  if (run?.status === 'failed') return { status: 'error', label: label('error'), badge: 'badge-err' }
  if (run?.status === 'aborted') return { status: 'error', label: label('aborted'), badge: 'badge-warn' }
  if (summaryStatus === 'error') return { status: 'error', label: label('error'), badge: 'badge-err' }
  if (summaryStatus === 'done' || summaryStatus === 'idle') {
    if (toolStatus === 'running') return { status: 'working', label: label('working'), badge: 'badge-accent' }
    if (toolStatus === 'error') return { status: 'error', label: label('error'), badge: 'badge-err' }
    return { status: 'done', label: label('done'), badge: 'badge-ok' }
  }
  if (summaryStatus === undefined && run === undefined && options?.isBackgroundHandle === true && toolStatus === 'done') {
    return options.handleStatus === 'running'
      ? { status: 'working', label: label('workingBackground'), badge: 'badge-accent' }
      : { status: 'pending', label: label('pending'), badge: 'badge-neutral' }
  }
  if (toolStatus === 'running') return { status: 'working', label: label('working'), badge: 'badge-accent' }
  if (toolStatus === 'error') return { status: 'error', label: label('error'), badge: 'badge-err' }
  if (toolStatus === 'done') return { status: 'done', label: label('done'), badge: 'badge-ok' }
  return { status: 'pending', label: label('pending'), badge: 'badge-neutral' }
}

/**
 * Compact card heading title: only returns when summary.title is a meaningful
 * user title. Kernel-generated defaults (`subagent N`, `Subagent #N`,
 * `子代理 N`, `子代理 #N`, `子会话 N`, `子会话 #N`) are filtered so they
 * never short-circuit downstream fallbacks.
 */
export function compactCardTitle(title: string | undefined, childConversationId: number): string | undefined {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (isPlaceholderSubagentTitle(trimmed, childConversationId)) return undefined
  return trimmed
}

/** Last non-empty line of a text (dropping # / - leading prefixes). */
function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    return line.replace(/^[#-]+\s+/, '')
  }
  return undefined
}

function inputEntryText(entry: ConversationEntry): string | undefined {
  if (entry.kind !== 'helmx.input') return undefined
  if (entry.data === null || typeof entry.data !== 'object' || Array.isArray(entry.data)) return undefined
  const text = (entry.data as Record<string, unknown>)['text']
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

export function latestTurnStartedAt(entries: ReadonlyArray<ConversationEntry> | undefined): number | undefined {
  if (entries === undefined) return undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.kind !== 'helmx.input') continue
    if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
      return entry.createdAt
    }
    if (entry.data !== null && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
      const ts = (entry.data as Record<string, unknown>)['createdAt']
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts
    }
    break
  }
  return undefined
}

/** Card heading task title: user title > non-placeholder backgroundRun.name > tool label / prompt > first background run node label / prompt > first helmx.input. */
export function resolveSubagentTaskTitle(
  summary: ConversationSummary | undefined,
  childConversationId: number,
  toolSummary?: SubagentParentToolSummary,
  backgroundRun?: WorkflowRunSummary,
  entries?: ReadonlyArray<ConversationEntry>,
): string | undefined {
  const custom = compactCardTitle(summary?.title, childConversationId)
  if (custom !== undefined) return custom
  if (backgroundRun !== undefined && !isPlaceholderRunName(backgroundRun.name, backgroundRun.id)) {
    const cleaned = extractCleanPreviewLine(backgroundRun.name, 60)
    if (cleaned !== '') return cleaned
  }
  const toolLabel = toolSummary?.label
  if (!isPlaceholderNodeLabel(toolLabel)) {
    const cleaned = extractCleanPreviewLine(toolLabel!, 60)
    if (cleaned !== '') return cleaned
  }
  const prompt = toolSummary?.prompt
  if (prompt !== undefined && prompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(prompt), 60)
    if (cleaned !== '') return cleaned
  }
  const firstNode = backgroundRun?.nodes?.[0]
  const label = firstNode?.label
  if (!isPlaceholderNodeLabel(label)) {
    const cleaned = extractCleanPreviewLine(label!, 60)
    if (cleaned !== '') return cleaned
  }
  const nodePrompt = firstNode?.prompt
  if (nodePrompt !== undefined && nodePrompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(nodePrompt), 60)
    if (cleaned !== '') return cleaned
  }
  if (entries !== undefined) {
    for (const entry of entries) {
      const text = inputEntryText(entry)
      if (text !== undefined) {
        const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(text), 60)
        if (cleaned !== '') return cleaned
      }
    }
  }
  return undefined
}

/** Task title for external / pre-spawn subagent trace rows without a native child conversationId. */
export function resolveExternalSubagentTaskTitle(
  toolSummary?: SubagentParentToolSummary,
  rawPrompt?: string,
  backgroundRun?: WorkflowRunSummary,
): string | undefined {
  if (backgroundRun !== undefined && !isPlaceholderRunName(backgroundRun.name, backgroundRun.id)) {
    const cleaned = extractCleanPreviewLine(backgroundRun.name, 60)
    if (cleaned !== '') return cleaned
  }
  if (!isPlaceholderNodeLabel(toolSummary?.label)) {
    const cleaned = extractCleanPreviewLine(toolSummary!.label!, 60)
    if (cleaned !== '') return cleaned
  }
  const prompt = rawPrompt ?? toolSummary?.prompt
  if (prompt !== undefined && prompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(prompt), 60)
    if (cleaned !== '') return cleaned
  }
  return undefined
}

/**
 * Card total duration: only from real recorded boundaries — this parent tool
 * call's startedAt/durationMs, or the background run's createdAt / first-node
 * durationMs. While working / blocked (in flight, including awaiting
 * approval) the clock advances with nowMs; otherwise (including descendants
 * still running after the card itself settled) it freezes at the persisted
 * duration — the conversation createdAt never fabricates a resume's total.
 * When toolSummary.resultText is only a background dispatch handle (runId
 * present) and the background run has no settled duration yet, never fall
 * back to the ~34ms dispatch durationMs (omit honestly).
 */
export function resolveSubagentElapsedMs(input: {
  backgroundRun?: WorkflowRunSummary
  toolSummary?: SubagentParentToolSummary
  startedAt?: number
  nowMs?: number
  status?: SubagentCardStatus
}): number | undefined {
  if (input.status === 'working' || input.status === 'blocked') {
    const start = input.backgroundRun?.status === 'running'
      ? input.backgroundRun.createdAt
      : input.startedAt ?? input.toolSummary?.startedAt
    return start !== undefined && Number.isFinite(start) && input.nowMs !== undefined && input.nowMs >= start
      ? input.nowMs - start
      : undefined
  }
  if (input.backgroundRun !== undefined) {
    const nodeDuration = input.backgroundRun.nodes?.[0]?.durationMs
    if (input.backgroundRun.status === 'running') {
      return nodeDuration !== undefined && Number.isFinite(nodeDuration) && nodeDuration >= 0 ? nodeDuration : undefined
    }
    const elapsed = nodeDuration ?? input.backgroundRun.updatedAt - input.backgroundRun.createdAt
    return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
  }
  if (parseSubagentExecutionInfo(input.toolSummary?.structuredOutput, input.toolSummary?.resultText)?.runId !== undefined) {
    return undefined
  }
  const elapsed = input.toolSummary?.durationMs
  return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

export interface SubagentHeaderSnippet {
  kind: 'tool' | 'thinking' | 'text' | 'doing' | 'blocked' | 'done' | 'error'
  tag?: string
  text: string
}

function previewFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ['result', 'output', 'summary']) {
    const v = record[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const cleaned = extractCleanPreviewLine(v, 100)
      if (cleaned !== '') return cleaned
    }
    if (v !== undefined && v !== null && typeof v === 'object') return firstLineOf(JSON.stringify(v), 100)
  }
  return firstLineOf(JSON.stringify(record), 100)
}

/** Extract the completion conclusion preview from structuredOutput or resultText. */
export function extractSubagentResultPreview(
  resultText: string | undefined,
  structuredOutput?: unknown,
): string | undefined {
  if (structuredOutput !== undefined && structuredOutput !== null && typeof structuredOutput === 'object' && !Array.isArray(structuredOutput)) {
    return previewFromRecord(structuredOutput as Record<string, unknown>)
  }
  if (resultText === undefined) return undefined
  const trimmed = resultText.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return previewFromRecord(parsed as Record<string, unknown>)
      }
    } catch {
      // Not JSON: fall back to plain text handling.
    }
  }
  const cleaned = extractCleanPreviewLine(trimmed, 100)
  return cleaned !== '' ? cleaned : undefined
}

function errorTextFromToolSummary(toolSummary: SubagentParentToolSummary | undefined): string | undefined {
  if (toolSummary === undefined) return undefined
  const structured = toolSummary.structuredOutput
  if (structured !== undefined && structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const record = structured as Record<string, unknown>
    const errField = record['error'] ?? (record['ok'] === false ? record['result'] : undefined)
    if (typeof errField === 'string' && errField.trim() !== '') {
      return firstLineOf(errField, 100)
    }
  }
  const raw = toolSummary.resultText?.trim()
  if (raw !== undefined && raw !== '' && raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (record['ok'] === false && typeof record['error'] === 'string' && record['error'].trim() !== '') {
          return firstLineOf(record['error'], 100)
        }
      }
    } catch {
      // Not JSON: treat as plain text.
    }
  }
  if (toolSummary.isError === true && raw !== undefined && raw !== '') {
    return firstLineOf(raw, 100)
  }
  return undefined
}

function backgroundRunError(backgroundRun: WorkflowRunSummary, locale: HelmxLocale): string | undefined {
  const fallback = runFailureFallbackLabel(backgroundRun, locale)
  if (backgroundRun.error !== undefined && backgroundRun.error.trim() !== '') {
    return firstLineOf(backgroundRun.error, 100)
  }
  const failed = backgroundRun.nodes?.find((n) => n.status === 'failed')
  if (failed === undefined) return fallback
  if (failed.error !== undefined && failed.error.trim() !== '') return firstLineOf(failed.error, 100)
  if (failed.gate?.ok === false && failed.gate.output.trim() !== '') return firstLineOf(failed.gate.output, 100)
  return fallback
}

function backgroundRunResultPreview(backgroundRun: WorkflowRunSummary | undefined): string | undefined {
  if (backgroundRun === undefined) return undefined
  const nodeOutput = backgroundRun.nodes?.[0]?.output
  if (nodeOutput !== undefined) {
    return extractSubagentResultPreview(typeof nodeOutput === 'string' ? nodeOutput : JSON.stringify(nodeOutput))
  }
  if (backgroundRun.result !== undefined) {
    return extractSubagentResultPreview(
      typeof backgroundRun.result === 'string' ? backgroundRun.result : JSON.stringify(backgroundRun.result),
    )
  }
  if (backgroundRun.resultPreview !== undefined) {
    return extractSubagentResultPreview(backgroundRun.resultPreview)
  }
  return undefined
}

function lastErrorLine(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helmx.input')
  const lines = buildSubagentStreamLines(latestInputIndex >= 0 ? entries.slice(latestInputIndex) : entries)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.kind === 'tool' && line.isError) {
      const text = line.resultPreview ?? line.summary
      return firstLineOf(text, 100)
    }
    if (line.kind === 'text' && /^(失败|错误|异常|error)/i.test(line.text.trim())) {
      return firstLineOf(line.text, 100)
    }
  }
  return undefined
}

function lastAssistantText(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helmx.input')
  const lines = buildSubagentStreamLines(latestInputIndex >= 0 ? entries.slice(latestInputIndex) : entries)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.kind !== 'text') continue
    const stripped = stripStructuredOutputContract(line.text).trim()
    if (stripped !== '') {
      const cleaned = extractCleanPreviewLine(stripped, 100)
      if (cleaned !== '') return cleaned
    }
  }
  return undefined
}

export function resolveSubagentHeaderSnippet(
  input: {
    badgeStatus: SubagentCardStatus
    summary?: ConversationSummary
    live?: ConversationLive
    entries?: ReadonlyArray<ConversationEntry>
    pendingAsk?: Pick<AskSpec, 'title' | 'description'>
    backgroundRun?: WorkflowRunSummary
    toolSummary?: SubagentParentToolSummary
    detailError?: string
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): SubagentHeaderSnippet | undefined {
  if (input.detailError !== undefined) {
    return { kind: 'error', tag: resolveLocalizedText(SNIPPET_LOAD_FAILED, locale), text: firstLineOf(input.detailError, 100) }
  }
  if (input.badgeStatus === 'blocked') {
    const fallback = resolveLocalizedText(SNIPPET_AWAITING_HUMAN, locale)
    const text = input.pendingAsk?.title || input.pendingAsk?.description || input.summary?.doing || fallback
    return { kind: 'blocked', tag: resolveLocalizedText(SNIPPET_AWAITING_APPROVAL, locale), text: firstLineOf(text, 100) }
  }
  if (input.badgeStatus === 'error') {
    if (input.backgroundRun?.status === 'failed' || input.backgroundRun?.status === 'aborted') {
      const failText = input.backgroundRun.status === 'aborted'
        ? subagentBadgeLabel('aborted', locale)
        : runFailureFallbackLabel(input.backgroundRun, locale)
      return {
        kind: 'error',
        tag: failText,
        text: backgroundRunError(input.backgroundRun, locale) ?? failText,
      }
    }
    const toolErr = errorTextFromToolSummary(input.toolSummary)
    if (toolErr !== undefined) return { kind: 'error', tag: resolveLocalizedText(SNIPPET_FAILED, locale), text: toolErr }
    const entryErr = lastErrorLine(input.entries)
    if (entryErr !== undefined) return { kind: 'error', tag: resolveLocalizedText(SNIPPET_ERROR, locale), text: entryErr }
    return {
      kind: 'error',
      tag: resolveLocalizedText(SNIPPET_ERROR, locale),
      text: firstLineOf(input.summary?.doing || resolveLocalizedText(SNIPPET_SUBAGENT_ERROR, locale), 100),
    }
  }
  if (input.badgeStatus === 'working') {
    const runningTools = (input.live?.tools ?? []).filter((t) => t.status === 'running')
    if (runningTools.length === 1) {
      const item = formatSemanticToolAction(runningTools[0]!.toolName, runningTools[0]!.input, input.summary?.cwd, locale)
      return { kind: 'tool', tag: item.tag, text: item.text }
    }
    if (runningTools.length > 1) {
      const items = runningTools.slice(0, 2).map((t) => formatSemanticToolAction(t.toolName, t.input, input.summary?.cwd, locale))
      const more = resolveLocalizedText(SNIPPET_PARALLEL_MORE, locale)
      const text = items.map((it) => `${it.tag} ${it.text}`).join(' · ') + (runningTools.length > 2 ? more : '')
      return { kind: 'tool', tag: snippetParallelTools(runningTools.length, locale), text }
    }
    const textLine = input.live?.text !== undefined ? lastMeaningfulLine(input.live.text) : undefined
    if (textLine !== undefined) return { kind: 'text', tag: resolveLocalizedText(SNIPPET_OUTPUT, locale), text: firstLineOf(textLine, 100) }
    const thinkingLine = input.live?.thinking !== undefined ? lastMeaningfulLine(input.live.thinking) : undefined
    if (thinkingLine !== undefined) return { kind: 'thinking', tag: resolveLocalizedText(SNIPPET_THINKING, locale), text: firstLineOf(thinkingLine, 100) }
    if (
      input.backgroundRun?.status === 'running' &&
      (input.summary?.status === 'idle' || input.summary?.status === 'done') &&
      input.backgroundRun.nodes?.some((n) => n.gateCommand !== undefined && n.gateCommand !== '')
    ) {
      const gateCommand = input.backgroundRun.nodes.find((n) => n.gateCommand !== undefined && n.gateCommand !== '')?.gateCommand
      if (gateCommand !== undefined) {
        return { kind: 'doing', tag: resolveLocalizedText(SNIPPET_GATE_CHECK, locale), text: firstLineOf(gateCommand, 100) }
      }
    }
    return {
      kind: 'doing',
      text: firstLineOf(input.summary?.doing || resolveLocalizedText(SNIPPET_STARTING, locale), 100),
    }
  }
  if (input.badgeStatus === 'done') {
    const fromRun = backgroundRunResultPreview(input.backgroundRun)
    if (fromRun !== undefined) return { kind: 'done', text: fromRun }
    const fromEntries = lastAssistantText(input.entries)
    if (fromEntries !== undefined) return { kind: 'done', text: fromEntries }
    const fromTool =
      input.backgroundRun === undefined
        ? extractSubagentResultPreview(input.toolSummary?.resultText, input.toolSummary?.structuredOutput)
        : undefined
    if (fromTool !== undefined) return { kind: 'done', text: fromTool }
    return undefined
  }
  return undefined
}
