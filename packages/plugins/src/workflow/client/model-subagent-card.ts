/**
 * Pure logic for the builtin:workflow client: subagent card status badges,
 * task titles, total duration and the second-layer dynamic subline (formerly
 * subagent-live-model.ts; zero React/DOM dependencies).
 */
import { DEFAULT_HELM_LOCALE, resolveLocalizedText, type HelmLocale } from '@helm/plugin-client'
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
} from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { extractCleanPreviewLine, firstLineOf } from './model-format.ts'
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

/** Subagent card status. */
export type SubagentCardStatus = 'working' | 'blocked' | 'error' | 'done' | 'pending'

export interface SubagentBadge {
  status: SubagentCardStatus
  label: string
  badge: string
}

/** Minimal linked-run view needed for badge / failure copy decisions. */
export type SubagentRunView = Pick<WorkflowRunSummary, 'status' | 'syncForeground' | 'detachedAt'>

/**
 * True background run: background-started or already detached (detaching to
 * the background makes it a background run); a foreground-sync run
 * (syncForeground and not detached) is just the parent turn's tool call
 * blocking — same semantics as the card's "Move to background" button, so its
 * copy must never claim to be background.
 */
function isTrueBackgroundRun(run: SubagentRunView): boolean {
  return !(run.syncForeground === true && run.detachedAt === undefined)
}

/**
 * Failure fallback copy for a linked run: foreground-sync (not detached) says
 * plain execution failed, true background (background-started or detached)
 * keeps the explicit background wording.
 */
export function runFailureFallbackLabel(run: SubagentRunView, locale: HelmLocale = DEFAULT_HELM_LOCALE): string {
  return runFailureFallbackCopy(isTrueBackgroundRun(run), locale)
}

/**
 * Card badge status: the real summary.status wins; the parent tool toolStatus
 * is only a fallback when there is no summary. The linked run status must
 * take part — while the run is still running, never show "Done" early. Only a
 * true background run (background-started or detached) may say "background";
 * a foreground-sync run is always plain running (the gate/settlement window
 * where the run is running but the subagent is idle/done also stays working —
 * never fake completion).
 */
export function subagentBadge(
  summaryStatus: string | undefined,
  toolStatus: 'running' | 'done' | 'error' | 'unknown',
  run?: SubagentRunView,
  options?: { isBackgroundHandle?: boolean; handleStatus?: string },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
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
 * user title. Kernel-generated defaults (`子代理 #N` / `子会话 #N`) are
 * backend output conventions and deliberately stay unmatched here.
 */
export function compactCardTitle(title: string | undefined, childConversationId: number): string | undefined {
  if (title === undefined) return undefined
  const trimmed = title.trim()
  if (trimmed === '') return undefined
  if (trimmed === `子代理 ${childConversationId}` || trimmed === `子会话 ${childConversationId}`) return undefined
  return trimmed
}

/** Structured-output contract boilerplate injected by spawn. */
const STRUCTURED_OUTPUT_CONTRACT_RE = /<structured_output_contract>[\s\S]*?<\/structured_output_contract>/g

function stripStructuredOutputContract(text: string): string {
  return text.replace(STRUCTURED_OUTPUT_CONTRACT_RE, '')
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

/** Trailing `[subagent ...]` footer line (kernel footer metadata). */
const SUBAGENT_FOOTER_TAIL_RE = /\n*\[subagent [^\]]*\]\s*$/

function stripSubagentFooter(text: string): string {
  return text.replace(SUBAGENT_FOOTER_TAIL_RE, '')
}

function inputEntryText(entry: ConversationEntry): string | undefined {
  if (entry.kind !== 'helm.input') return undefined
  if (entry.data === null || typeof entry.data !== 'object' || Array.isArray(entry.data)) return undefined
  const text = (entry.data as Record<string, unknown>)['text']
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

/** Extract the started-at timestamp of the latest helm.input turn (recorded values only, never fabricated). */
export function latestTurnStartedAt(entries: ReadonlyArray<ConversationEntry> | undefined): number | undefined {
  if (entries === undefined) return undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.kind !== 'helm.input') continue
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

/** Card heading task title: user title > parent tool prompt > first background run node label / prompt > first helm.input. */
export function resolveSubagentTaskTitle(
  summary: ConversationSummary | undefined,
  childConversationId: number,
  toolSummary?: SubagentParentToolSummary,
  backgroundRun?: WorkflowRunSummary,
  entries?: ReadonlyArray<ConversationEntry>,
): string | undefined {
  const custom = compactCardTitle(summary?.title, childConversationId)
  if (custom !== undefined) return custom
  const prompt = toolSummary?.prompt
  if (prompt !== undefined && prompt.trim() !== '') {
    const cleaned = extractCleanPreviewLine(stripStructuredOutputContract(prompt), 60)
    if (cleaned !== '') return cleaned
  }
  const firstNode = backgroundRun?.nodes?.[0]
  const label = firstNode?.label
  if (label !== undefined && label.trim() !== '' && label.trim() !== 'subagent') {
    const cleaned = extractCleanPreviewLine(label, 60)
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
  /** Effective self status: working / blocked count as in-flight dynamic timing, the rest freeze. */
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
  // For a background dispatch handle the toolSummary.durationMs is just the
  // dispatch confirmation (~34ms) — never present it as the task total.
  if (parseSubagentExecutionInfo(input.toolSummary?.resultText)?.runId !== undefined) {
    return undefined
  }
  const elapsed = input.toolSummary?.durationMs
  return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

/** Second-layer dynamic subline. */
export interface SubagentHeaderSnippet {
  kind: 'tool' | 'thinking' | 'text' | 'doing' | 'blocked' | 'done' | 'error'
  tag?: string
  text: string
}

/** Extract the completion conclusion preview from the parent tool resultText. */
export function extractSubagentResultPreview(resultText: string | undefined): string | undefined {
  if (resultText === undefined) return undefined
  const trimmed = resultText.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        for (const key of ['result', 'output', 'summary']) {
          const v = record[key]
          if (typeof v === 'string' && v.trim() !== '') {
            const cleaned = extractCleanPreviewLine(v, 100)
            if (cleaned !== '') return cleaned
          }
          if (v !== undefined && v !== null && typeof v === 'object') return firstLineOf(JSON.stringify(v), 100)
        }
        return firstLineOf(JSON.stringify(parsed), 100)
      }
    } catch {
      // Not JSON: fall back to plain text handling.
    }
  }
  const stripped = stripSubagentFooter(trimmed)
  if (stripped.trim() === '') return undefined
  const cleaned = extractCleanPreviewLine(stripped, 100)
  return cleaned !== '' ? cleaned : undefined
}

/** Extract the error text from the parent tool resultText. */
function errorTextFromToolSummary(toolSummary: SubagentParentToolSummary | undefined): string | undefined {
  if (toolSummary === undefined) return undefined
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
    const stripped = stripSubagentFooter(raw)
    if (stripped.trim() !== '') return firstLineOf(stripped, 100)
  }
  return undefined
}

/** Error text for a failed linked run (foreground sync and true background have different fallback copy). */
function backgroundRunError(backgroundRun: WorkflowRunSummary, locale: HelmLocale): string | undefined {
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

/** One-line preview produced by a background run. */
function backgroundRunResultPreview(backgroundRun: WorkflowRunSummary | undefined): string | undefined {
  if (backgroundRun === undefined) return undefined
  const nodeOutput = backgroundRun.nodes?.[0]?.output
  const preview = extractSubagentResultPreview(
    typeof nodeOutput === 'string' ? nodeOutput : nodeOutput !== undefined ? JSON.stringify(nodeOutput) : backgroundRun.result !== undefined ? (typeof backgroundRun.result === 'string' ? backgroundRun.result : JSON.stringify(backgroundRun.result)) : undefined,
  )
  return preview
}

/** Last erroring tool output or message text among entries. */
function lastErrorLine(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helm.input')
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

/** Last assistant text among entries (structured-output contract boilerplate and Markdown prefixes stripped). */
function lastAssistantText(entries: ReadonlyArray<ConversationEntry> | undefined): string | undefined {
  if (entries === undefined) return undefined
  const latestInputIndex = entries.findLastIndex((entry) => entry.kind === 'helm.input')
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

/** Second-layer dynamic subline derivation (branched by badgeStatus; undefined when no valid text). */
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
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
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
      // A foreground-sync run failure must not claim "background"; true
      // background keeps the original copy.
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
    const fromTool = input.backgroundRun === undefined ? extractSubagentResultPreview(input.toolSummary?.resultText) : undefined
    if (fromTool !== undefined) return { kind: 'done', text: fromTool }
    return undefined
  }
  return undefined
}
