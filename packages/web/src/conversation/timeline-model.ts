/**
 * Timeline normalization pure-function layer (plain .ts, zero React/DOM deps, unit-testable directly).
 *
 * Responsibility: convert backend `ConversationEntry[]` + live `ConversationLive` into structured render items:
 * - `helm.input` dedup normalization: input blocks come from helm.input (origin/meta/attachments),
 *   automatically skipping the duplicate `pi.user` they cover; bare `pi.user` (no preceding helm.input) is the fallback.
 * - Plugin `timeline.renderer` (kinds + matchMeta) and `tool.view` (toolNames) match resolution.
 * - assistant message thinking / text / toolCall extraction; `pi.tool-result` pairing by callId.
 * - Consecutive ordinary steps collapse into per-turn step groups: thinking and ordinary tool
 *   rows (including failures) fold into a step-group; tool.view business cards are always exempt.
 * - `pi.reset` / `pi.compaction` -> context dividers (reset may carry a handoff summary).
 * - live merge: real-time tools (running) and streaming text fold into the in-flight turn.
 */

import type {
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  InputOrigin,
  TimelineRendererSpec,
  ToolResultTruncation,
  ToolViewSiblingCall,
  ToolViewSpec,
  WhenBusy,
} from '@helm/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

// ---------------------------------------------------------------------------
// Render item types
// ---------------------------------------------------------------------------

export interface QualifiedRenderer {
  pluginId: string
  spec: TimelineRendererSpec
}

export interface QualifiedToolView {
  pluginId: string
  spec: ToolViewSpec
}

export interface HelmInputData {
  id?: string
  text: string
  origin: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: ConversationAttachmentRef[]
}

export type ToolTraceStatus = 'running' | 'done' | 'error' | 'unknown'

/** Server-side timeline preview truncation markers reuse the cross-package contract in protocol. */
export type { ToolResultTruncation } from '@helm/protocol/browser'

export interface ToolTrace {
  key: string
  toolName: string
  callId?: string
  input?: unknown
  status: ToolTraceStatus
  isError: boolean
  resultText?: string
  /** Server preview truncation marker; omitted when not truncated or for live results. */
  resultTruncation?: ToolResultTruncation
  /** entry id of the pi.tool-result carrying this result (precise key for on-demand full-text fetch when truncated). */
  resultEntryId?: string
  /** Time of the persisted entry holding the tool call; omitted while a streaming call has no record yet. */
  startedAt?: number
  durationMs?: number
  /** Artifact reference detected in the output (kernel Spill marker / art_ prefix), feeding the "open full artifact" button. */
  artifactRef?: string
  /** Persisted view of the tool structured output (toolResult message details channel; present on success for tools declaring structuredOutputSchema); omitted otherwise. */
  structuredOutput?: unknown
  /** Matched a plugin tool.view (e.g. dispatch_worker): exempt from folding, renders a business card. */
  toolView?: QualifiedToolView
}

/** toolResult message extension-level truncation metadata: `truncated` must be explicitly true
 * (missing or false = full text); totalChars/totalLines only narrow to finite non-negative
 * numbers, invalid values dropped — never fabricate the unknown. Non-object shapes return undefined. */
export function readResultTruncation(message: unknown): ToolResultTruncation | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const m = message as Record<string, unknown>
  if (m['truncated'] !== true) return undefined
  const totalChars = m['totalChars']
  const totalLines = m['totalLines']
  return {
    truncated: true,
    ...(typeof totalChars === 'number' && Number.isFinite(totalChars) && totalChars >= 0 ? { totalChars } : {}),
    ...(typeof totalLines === 'number' && Number.isFinite(totalLines) && totalLines >= 0 ? { totalLines } : {}),
  }
}

export interface ThinkingTrace {
  key: string
  text: string
  active?: boolean
  /** Eligible model-response duration (ms) of the assistant message that produced this thinking
   * block (thinking + toolCall content, no non-empty visible text, finite positive durationMs).
   * Attached structurally to exactly one thinking block per message (turn-scope allocation covers
   * cross-group / standalone-card splits without any local dedup Set); aggregated only into the
   * step-group model-time total — never rendered on the thinking row itself. */
  responseDurationMs?: number
}

export type FoldableStep =
  | { kind: 'thinking'; thinking: ThinkingTrace }
  | { kind: 'tool'; tool: ToolTrace }

export type AssistantSegment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'step-group'; key: string; stepCount: number; steps: FoldableStep[]; active?: boolean }
  | { kind: 'tool'; key: string; tool: ToolTrace }

/** Effective generation model identity carried by pi.assistant entry model[0] (AssistantMessage).
 * provider+model is the identity (splitting and boundaries compare only these two); thinkingLevel
 * is display metadata kept only when consistent across all assistant entries of the turn. */
export interface AssistantModelIdentity {
  provider: string
  model: string
  /** Requested thinking level (off/minimal/low/medium/high/xhigh/max); omitted for legacy or inconsistent data. */
  thinkingLevel?: string
}

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  /** All entry ids involved in this turn (hover fork uses the last one). */
  entryIds: string[]
  segments: AssistantSegment[]
  /** true = in-flight turn merged with ConversationLive. */
  live: boolean
  /** Effective generation model of this turn (derived from the first pi.assistant entry model[0]);
   * omitted when incomplete, invalid, or an untrusted entry pollutes the turn — unknown content is
   * never attributed to a known model, and current config like conversation.model is never faked
   * as history. thinkingLevel is kept only when consistent across the turn). */
  model?: AssistantModelIdentity
  /** Turn start timestamp (ms); omitted when not captured. */
  startedAt?: number
  /** Turn settled timestamp (ms); omitted while unsettled or not captured. */
  settledAt?: number
  /** Total turn duration (ms); omitted when not captured. */
  durationMs?: number
}

export interface HumanInputItem {
  kind: 'human'
  key: string
  entryId: string
  text: string
  origin: InputOrigin
  meta?: Record<string, unknown>
  attachments?: ConversationAttachmentRef[]
  /** Stable identity of the helm.input; queued and persisted states share one React key. */
  inputId?: string
  /** Non-null when the input is still queued in pi.inbox (not yet a formal entry). */
  queuedMode?: 'steer' | 'followUp'
  /** true = bare pi.user without a preceding helm.input, shown as fallback. */
  fallback: boolean
  /** Message creation/send timestamp (ms); omitted when unknown. */
  createdAt?: number
}

export interface DividerItem {
  kind: 'divider'
  key: string
  entryId: string
  divider: 'reset' | 'compaction'
  /** true = context compaction in progress (pi.compaction not persisted yet). */
  pending?: boolean
  /** Handoff summary carried by pi.reset (expandable). */
  handoff?: string
  /** Compaction summary of pi.compaction (kept in the model layer; UI keeps it collapsed by default). */
  summary?: string
}

export interface PluginCardItem {
  kind: 'plugin-card'
  key: string
  entryId: string
  entry: ConversationEntry
  renderer: QualifiedRenderer
}

export type TimelineItem = HumanInputItem | DividerItem | PluginCardItem | AssistantTurn

/** "Edit and resend" target: text to prefill the Composer + optional history entry anchor and attachments. */
export interface EditRequestTarget {
  text: string
  /** Positive integer id of the persisted history entry; omitted when a withdrawn queued message only prefills a draft. */
  entryId?: number
  /** Attachment refs carried by the original message (prefilled into the compose area). */
  attachments?: ConversationAttachmentRef[]
}

// ---------------------------------------------------------------------------
// rewind overlay filtering
// ---------------------------------------------------------------------------

/**
 * Filter out entries covered by helm.rewind.
 *
 * The backend commits atomically: the new input lands first, then the rewind marker, in one batch.
 * rewind.data = { fromEntryId, throughEntryId(old tail before the new input), ... }
 * covering the closed range [fromEntryId, throughEntryId] — never truncate at the marker's own id,
 * or the new input persisted in the same batch with a smaller id would be hidden too.
 *
 * Range validity: from/through are both safe positive integers with through >= from and
 * through < the marker's own id; an invalid marker hides only itself (keep the control record hidden) and covers nothing.
 * Multiple rewind ranges union; the SDK-rebuilt pi.system baseline is unaffected (never rendered anyway).
 */
export function filterRewoundEntries(entries: ReadonlyArray<ConversationEntry>): ConversationEntry[] {
  const rewindEntryIds = new Set<string>()
  const ranges: Array<[number, number]> = []
  for (const entry of entries) {
    if (entry.kind !== 'helm.rewind') continue
    rewindEntryIds.add(entry.id)
    const data = isStringRecord(entry.data) ? entry.data : undefined
    const markerId = Number(entry.id)
    const fromEntryId = Number(data?.fromEntryId)
    const throughEntryId = Number(data?.throughEntryId)
    if (
      isSafePositiveInt(fromEntryId) &&
      isSafePositiveInt(throughEntryId) &&
      throughEntryId >= fromEntryId &&
      isSafePositiveInt(markerId) &&
      markerId > throughEntryId
    ) {
      ranges.push([fromEntryId, throughEntryId])
    }
  }
  if (rewindEntryIds.size === 0) return [...entries]
  return entries.filter((entry) => {
    if (rewindEntryIds.has(entry.id)) return false
    if (ranges.length === 0) return true
    const id = Number(entry.id)
    if (!Number.isFinite(id)) return true
    return !ranges.some(([from, through]) => id >= from && id <= through)
  })
}

function isSafePositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Latest editable human input (Composer empty-box ↑ prefill):
 * - only origin === 'human' counts: agent reports / trigger injections are not human-editable, keep searching backwards;
 * - never edit in place across a pi.reset / pi.compaction boundary (the backend's authoritative context starts at the latest boundary);
 * - prefer helm.input (with attachments), fall back to bare pi.user.
 */
export function lastEditableHumanInput(entries: ReadonlyArray<ConversationEntry>): EditRequestTarget | undefined {
  const active = filterRewoundEntries(entries)
  for (let i = active.length - 1; i >= 0; i--) {
    const entry = active[i]!
    if (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction') return undefined
    if (entry.kind === 'helm.input') {
      const data = parseHelmInputData(entry.data)
      const entryId = Number(entry.id)
      if (
        data !== undefined &&
        data.origin === 'human' &&
        data.text.trim() !== '' &&
        isSafePositiveInt(entryId)
      ) {
        return {
          text: data.text,
          entryId,
          ...(data.attachments !== undefined && data.attachments.length > 0 ? { attachments: data.attachments } : {}),
        }
      }
      continue
    }
    if (entry.kind === 'pi.user') {
      const text = extractUserMessageText(entry)
      const entryId = Number(entry.id)
      if (text.trim() !== '' && isSafePositiveInt(entryId)) {
        return { text, entryId }
      }
    }
  }
  return undefined
}

export interface BuildTimelineOptions {
  /** Live view of the in-flight turn (passed while the conversation is working; omitted when idle). */
  live?: ConversationLive
  /** Whether the conversation is in the working state (keeps the current turn active before the first token and between tool rounds). */
  working?: boolean
  /** Whether a context compaction is running (inserts a pending divider after the turn, before queued inputs). */
  compacting?: boolean
  timelineRenderers?: ReadonlyArray<QualifiedRenderer>
  toolViews?: ReadonlyArray<QualifiedToolView>
}

/** Max length of the single-row trace input summary. */
const SUMMARY_MAX_CHARS = 60

// ---------------------------------------------------------------------------
// Input extraction and dedup
// ---------------------------------------------------------------------------

/** Validate and parse helm.input entry.data; return undefined on invalid shapes (never fabricate). */
export function parseHelmInputData(data: unknown): HelmInputData | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (typeof d.text !== 'string') return undefined
  const origin: InputOrigin = d.origin === 'agent' || d.origin === 'trigger' ? d.origin : 'human'
  const attachments: ConversationAttachmentRef[] = Array.isArray(d.attachments)
    ? d.attachments.filter(
        (a): a is ConversationAttachmentRef =>
          a !== null && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string',
      )
    : []
  return {
    ...(typeof d.id === 'string' && d.id !== '' ? { id: d.id } : {}),
    text: d.text,
    origin,
    ...(d.whenBusy === 'steer' || d.whenBusy === 'followUp' || d.whenBusy === 'reject'
      ? { whenBusy: d.whenBusy }
      : {}),
    ...(typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? { createdAt: d.createdAt } : {}),
    ...(isStringRecord(d.meta) ? { meta: d.meta } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Extract all user message texts from entry.model (content is a string or an array of text blocks). */
export function extractUserMessageText(entry: ConversationEntry): string {
  const model = entry.model
  if (!Array.isArray(model)) return ''
  let text = ''
  for (const msg of model) {
    if (msg === null || typeof msg !== 'object') continue
    if ((msg as { role?: unknown }).role !== 'user') continue
    text += contentTextOf((msg as { content?: unknown }).content)
  }
  return text
}

/** content (string | Array<{type:'text',text}> | Array<{type:'text',text|thinking,...}>) -> plain text. */
function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

// ---------------------------------------------------------------------------
// Plugin extension-point matching
// ---------------------------------------------------------------------------

/**
 * Stable sort by priority descending: higher first, equal priorities (including default 0) keep
 * contribution order (first registered wins). Returns a new array; the input list is untouched (groupedUi stays referentially stable).
 */
export function sortByPriorityDescStable<T extends { spec: { priority?: number } }>(
  items: ReadonlyArray<T>,
): T[] {
  return items
    .map((item, index) => ({ item, index, priority: item.spec.priority ?? 0 }))
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.index - b.index))
    .map((entry) => entry.item)
}

/**
 * timeline.renderer match resolution (stable priority-descending arbitration):
 * - sort by (spec.priority ?? 0) descending, equal priorities keep contribution order (first registered wins);
 * - kinds omitted = take over everything; when provided it must include entry.kind;
 * - matchMeta.renderer must equal entry.data.meta.renderer or entry.data.renderer (AND with kinds).
 */
export function matchTimelineRenderer(
  entry: ConversationEntry,
  renderers: ReadonlyArray<QualifiedRenderer> | undefined,
): QualifiedRenderer | undefined {
  if (!renderers || renderers.length === 0) return undefined
  const data = isStringRecord(entry.data) ? entry.data : undefined
  const meta = data && isStringRecord(data.meta) ? data.meta : undefined
  const metaRenderer = typeof meta?.renderer === 'string' ? meta.renderer : undefined
  const ownRenderer = typeof data?.renderer === 'string' ? data.renderer : undefined
  for (const r of sortByPriorityDescStable(renderers)) {
    const kinds = r.spec.kinds
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.includes(entry.kind))) continue
    const want = r.spec.matchMeta?.renderer
    if (want !== undefined && metaRenderer !== want && ownRenderer !== want) continue
    return r
  }
  return undefined
}

/**
 * tool.view match (stable priority-descending arbitration): spec.toolNames contains the toolName.
 * Take the first hit by (spec.priority ?? 0) descending with contribution order for ties;
 * rendering semantics like replaceRow are decided by consumers from the matched spec; the matcher stays out of it.
 */
export function findToolView(
  toolName: string,
  toolViews: ReadonlyArray<QualifiedToolView> | undefined,
): QualifiedToolView | undefined {
  if (!toolViews) return undefined
  for (const tv of sortByPriorityDescStable(toolViews)) {
    if (Array.isArray(tv.spec.toolNames) && tv.spec.toolNames.includes(toolName)) return tv
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tool trace summaries and artifact-reference detection
// ---------------------------------------------------------------------------

function summarizeValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** Core input summary for a trace row: prefer command/file path/prompt, first line, truncated to 60 chars. */
export function toolSummaryText(toolName: string, input: unknown): string {
  void toolName
  let raw = ''
  if (typeof input === 'string') {
    raw = input
  } else if (isStringRecord(input)) {
    const preferred = ['command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill_id']
    for (const key of preferred) {
      const v = input[key]
      if (typeof v === 'string' && v !== '') {
        raw = v
        break
      }
    }
    if (raw === '') {
      raw = Object.entries(input)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${summarizeValue(v)}`)
        .join(' ')
    }
  }
  const firstLine = raw.split('\n')[0]?.trim() ?? ''
  return firstLine.length > SUMMARY_MAX_CHARS ? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}…` : firstLine
}

/** Kernel over-length Spill marker (`[Artifact] id=<uuid>`) or art_-prefixed artifact reference. */
const SPILL_ID_RE = /\[Artifact\]\s+id=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/
const ART_REF_RE = /\bart_[A-Za-z0-9_-]{1,127}\b/

/** Detect an artifact reference in tool output text; undefined when none. */
export function detectArtifactRef(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  return SPILL_ID_RE.exec(text)?.[1] ?? ART_REF_RE.exec(text)?.[0]
}

// ---------------------------------------------------------------------------
// Effective generation model identity (derived from pi.assistant model[0]; never reads current conversation config)
// ---------------------------------------------------------------------------

/**
 * Parse the effective generation model identity carried by a pi.assistant entry's model[0] (AssistantMessage).
 * Incomplete or invalid shapes (not pi.assistant / model not a non-empty array / first message not
 * assistant / provider|model missing or blank) return undefined — never fabricate, never fall back to conversation.model.
 */
export function parseAssistantModelIdentity(entry: ConversationEntry): AssistantModelIdentity | undefined {
  if (entry.kind !== 'pi.assistant') return undefined
  const model = entry.model
  if (!Array.isArray(model) || model.length === 0) return undefined
  const msg = model[0]
  if (msg === null || typeof msg !== 'object') return undefined
  const m = msg as { role?: unknown; provider?: unknown; model?: unknown; thinkingLevel?: unknown }
  if (m.role !== 'assistant') return undefined
  if (typeof m.provider !== 'string' || m.provider.trim() === '') return undefined
  if (typeof m.model !== 'string' || m.model.trim() === '') return undefined
  const thinkingLevel =
    typeof m.thinkingLevel === 'string' && m.thinkingLevel.trim() !== '' ? m.thinkingLevel : undefined
  return {
    provider: m.provider,
    model: m.model,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}

/** Model identity equality: compare provider + model only; thinkingLevel is excluded (a level change
 * is not a model switch: no turn split, no boundary rendered). */
export function sameAssistantModelIdentity(a: AssistantModelIdentity, b: AssistantModelIdentity): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Short label: the model segment (same treatment as the Composer model button, last '/' segment). */
export function assistantModelShortLabel(identity: AssistantModelIdentity): string {
  return identity.model.split('/').pop() ?? identity.model
}

/** Full label: 'provider/model' (+ thinking level), same format as conversation.model. */
export function assistantModelFullLabel(identity: AssistantModelIdentity, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  const base = `${identity.provider}/${identity.model}`
  return identity.thinkingLevel !== undefined
    ? tt('conv.model.thinkingSuffix', { base, level: identity.thinkingLevel })
    : base
}

/**
 * Scan the whole timeline and produce a boundary identity for each assistant turn where the effective
 * generation model switched, indexed by turn key (the renderer draws the boundary before that turn).
 *
 * Look-back rule: look back from the current turn to the most recent assistant turn; human inputs
 * and plugin cards in between do not block (normal dialogue almost always has human input between turns);
 * stop at a reset / compaction divider (model history before a context boundary is irrelevant); the first
 * assistant turn gets no boundary. A boundary exists only when both turns have trusted provider+model
 * identities that differ — a missing/invalid side produces none (never compare unknown to known, never fake).
 * The boundary anchors to the turn position after the new model's entries land, not the moment Composer switched config.
 */
export function buildAssistantModelBoundaries(
  items: ReadonlyArray<TimelineItem>,
): Map<string, AssistantModelIdentity> {
  const boundaries = new Map<string, AssistantModelIdentity>()
  let prevAssistant: AssistantTurn | undefined
  for (const item of items) {
    // Context divider (reset / compaction): never look back across a boundary.
    if (item.kind === 'divider') {
      prevAssistant = undefined
      continue
    }
    if (item.kind !== 'assistant') continue
    if (
      prevAssistant !== undefined &&
      prevAssistant.model !== undefined &&
      item.model !== undefined &&
      !sameAssistantModelIdentity(prevAssistant.model, item.model)
    ) {
      boundaries.set(item.key, item.model)
    }
    prevAssistant = item
  }
  return boundaries
}

// ---------------------------------------------------------------------------
// Turn construction
// ---------------------------------------------------------------------------

interface RawSegment {
  kind: 'text' | 'thinking' | 'tool'
  key: string
  text?: string
  tool?: ToolTrace
  /** Eligible model-response duration attached to (only) the first thinking segment of its message. */
  responseDurationMs?: number
}

interface TurnAcc {
  entryIds: string[]
  segments: RawSegment[]
  /** Display identity core of the turn (provider+model); cleared when an untrusted entry pollutes the turn
   * (unknown content is never attributed to a known model, and current conversation config is never a fallback). */
  model?: { provider: string; model: string }
  /** Split comparison baseline: identity core of the first trusted entry in the turn; decoupled from
   * the display label so a later provably different model can still start a new turn after pollution. */
  modelReference?: { provider: string; model: string }
  /** Thinking level locked by the first trusted entry (display only). */
  modelThinkingLevel?: string
  /** Dropped when thinking levels are inconsistent within the turn. */
  modelThinkingMixed?: boolean
  /** A pi.assistant has been seen (once identity is locked, split only on a provably different identity). */
  modelLocked?: boolean
  startedAt?: number
  settledAt?: number
  durationMs?: number
}

function newTurn(): TurnAcc {
  return { entryIds: [], segments: [] }
}

function makeToolTrace(
  key: string,
  toolName: string,
  opts: { callId?: string; input?: unknown; status?: ToolTraceStatus; isError?: boolean; resultText?: string; resultTruncation?: ToolResultTruncation; resultEntryId?: string; structuredOutput?: unknown; startedAt?: number; durationMs?: number; toolViews?: ReadonlyArray<QualifiedToolView> },
): ToolTrace {
  const status = opts.status ?? 'unknown'
  return {
    key,
    toolName,
    ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    status,
    isError: opts.isError ?? status === 'error',
    ...(opts.resultText !== undefined ? { resultText: opts.resultText } : {}),
    ...(opts.resultTruncation !== undefined ? { resultTruncation: opts.resultTruncation } : {}),
    ...(opts.resultEntryId !== undefined ? { resultEntryId: opts.resultEntryId } : {}),
    ...(opts.structuredOutput !== undefined ? { structuredOutput: opts.structuredOutput } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...{ toolView: findToolView(toolName, opts.toolViews) },
  }
}

/** Fold exemption: thinking and ordinary tool rows (running, done, failed) fold; only tool.view business cards stay standalone. */
export function isFoldableStep(step: FoldableStep): boolean {
  if (step.kind === 'thinking') return true
  const tool = step.tool
  if (tool.toolView !== undefined) return false
  return true
}

function foldableOfRaw(seg: RawSegment): FoldableStep {
  if (seg.kind === 'thinking') {
    return {
      kind: 'thinking',
      thinking: {
        key: seg.key,
        text: seg.text ?? '',
        ...(seg.responseDurationMs !== undefined ? { responseDurationMs: seg.responseDurationMs } : {}),
      },
    }
  }
  return { kind: 'tool', tool: seg.tool! }
}

/**
 * Raw segments -> render segments: consecutive foldable steps enter a step-group from the first step, avoiding node moves when steps append.
 * Exempt items (tool.view) and text blocks stay standalone.
 * While the turn is still running (live=true) and no text segment follows the step-group yet, mark active=true (frontend expands by default).
 */
export function foldTurnSegments(raw: ReadonlyArray<RawSegment>, live = false): AssistantSegment[] {
  const out: AssistantSegment[] = []
  let buffer: FoldableStep[] = []
  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      out.push({
        kind: 'step-group',
        key: `group:${out.length}`,
        stepCount: buffer.length,
        steps: buffer,
      })
    }
    buffer = []
  }
  for (const seg of raw) {
    if (seg.kind === 'text') {
      if ((seg.text ?? '') === '') continue
      flushBuffer()
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined && last.kind === 'text') {
        last.text += seg.text ?? ''
        continue
      }
      // Reuse the node when the same text moves from a streaming snapshot to a persisted entry, avoiding code-block remounts and lost state.
      out.push({ kind: 'text', key: `text:${out.length}`, text: seg.text ?? '' })
      continue
    }
    const step = foldableOfRaw(seg)
    if (isFoldableStep(step)) {
      buffer.push(step)
    } else {
      flushBuffer()
      if (step.kind === 'tool') out.push({ kind: 'tool', key: step.tool.key, tool: step.tool })
      else buffer.push(step)
    }
  }
  flushBuffer()
  let lastTextIndex = -1
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.kind === 'text') lastTextIndex = i
  }
  for (let i = 0; i < out.length; i++) {
    const seg = out[i]!
    if (seg.kind === 'step-group') {
      const hasRunningTool = seg.steps.some((s) => s.kind === 'tool' && s.tool.status === 'running')
      const groupActive = live && (i > lastTextIndex || hasRunningTool)
      seg.active = groupActive

      for (let sIdx = 0; sIdx < seg.steps.length; sIdx++) {
        const step = seg.steps[sIdx]!
        if (step.kind === 'thinking') {
          const hasSubsequentTool = seg.steps.slice(sIdx + 1).some((s) => s.kind === 'tool')
          step.thinking.active = groupActive && !hasSubsequentTool && !hasRunningTool && i > lastTextIndex
        }
      }
    }
  }
  return out
}

function flushTurn(acc: TurnAcc | null, items: TimelineItem[], live: boolean): void {
  if (acc === null) return
  if (live) {
    for (const seg of acc.segments) {
      if (seg.kind === 'tool' && seg.tool !== undefined && seg.tool.status === 'unknown') {
        seg.tool.status = 'running'
      }
    }
  }
  const segments = foldTurnSegments(acc.segments, live)
  if (segments.length === 0 && acc.entryIds.length === 0) return
  if (segments.length === 0) return
  const prevKey = items.length > 0 ? items[items.length - 1]!.key : 'root'
  const durationMs =
    acc.durationMs !== undefined
      ? acc.durationMs
      : acc.startedAt !== undefined && acc.settledAt !== undefined && acc.settledAt > acc.startedAt
        ? acc.settledAt - acc.startedAt
        : undefined

  // Effective model: the first trusted entry locks provider+model and the level; later entries
  // with inconsistent levels (or untrusted identities) drop the single-level display; provider+model stays.
  const turnModel: AssistantModelIdentity | undefined =
    acc.model !== undefined
      ? {
          provider: acc.model.provider,
          model: acc.model.model,
          ...(acc.modelThinkingMixed !== true && acc.modelThinkingLevel !== undefined
            ? { thinkingLevel: acc.modelThinkingLevel }
            : {}),
        }
      : undefined
  items.push({
    kind: 'assistant',
    key: `turn:${prevKey}`,
    entryIds: [...acc.entryIds],
    segments,
    live,
    ...(turnModel !== undefined ? { model: turnModel } : {}),
    ...(acc.startedAt !== undefined ? { startedAt: acc.startedAt } : {}),
    ...(acc.settledAt !== undefined ? { settledAt: acc.settledAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  })
}

/**
 * Eligibility scan of one assistant message's content for process-duration attribution:
 * a non-empty thinking block AND a toolCall block, with no non-empty visible text block —
 * such a response spent its measured duration thinking and issuing tool calls, so the duration
 * is attributable process time; any visible reply text disqualifies it (the duration then covers
 * reply generation and must not be labeled as thinking/execution time). Malformed shapes fail closed.
 */
function isEligibleProcessContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  let hasThinking = false
  let hasToolCall = false
  let hasVisibleText = false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown }
    if (b.type === 'thinking') {
      if (typeof b.thinking === 'string' && b.thinking.trim() !== '') hasThinking = true
    } else if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text !== '') hasVisibleText = true
    } else if (b.type === 'toolCall' || b.type === 'tool_use') {
      hasToolCall = true
    }
  }
  return hasThinking && hasToolCall && !hasVisibleText
}

/** Extract assistant message content blocks (thinking / text / toolCall); the first assistant locks
 * the turn's model identity; later entries maintain level-consistency and unknown-pollution flags. */
function appendAssistantEntry(
  acc: TurnAcc,
  entry: ConversationEntry,
  opts: BuildTimelineOptions,
  modelIdentity: AssistantModelIdentity | undefined,
): void {
  acc.entryIds.push(entry.id)
  if (acc.modelLocked !== true) {
    if (modelIdentity !== undefined) {
      const core = { provider: modelIdentity.provider, model: modelIdentity.model }
      acc.model = core
      acc.modelReference = core
      acc.modelThinkingLevel = modelIdentity.thinkingLevel
    }
    acc.modelLocked = true
  } else if (modelIdentity === undefined) {
    // An untrusted entry after a known identity: no split, no comparison, no boundary, but the turn
    // is no longer attributed to any known model (never disguise unknown content as A's output); the
    // modelReference baseline survives so a later provably different model entry can still start a new turn.
    acc.model = undefined
  } else if (
    acc.modelReference !== undefined &&
    modelIdentity.thinkingLevel !== acc.modelThinkingLevel
  ) {
    // Trusted identity but inconsistent level: never fabricate a single thinkingLevel.
    acc.modelThinkingMixed = true
  }
  const model = entry.model
  if (Array.isArray(model)) {
    for (let mi = 0; mi < model.length; mi++) {
      const msg = model[mi]
      if (msg === null || typeof msg !== 'object') continue
      const m = msg as {
        role?: unknown
        timestamp?: unknown
        durationMs?: unknown
        content?: unknown
      }

      const msgTimestamp =
        typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > 0
          ? m.timestamp
          : typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0
            ? entry.createdAt
            : undefined

      const msgDurationMs =
        typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0
          ? m.durationMs
          : undefined

      if (msgTimestamp !== undefined) {
        acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, msgTimestamp) : msgTimestamp
        const settled = msgTimestamp + (msgDurationMs ?? 0)
        acc.settledAt = acc.settledAt !== undefined ? Math.max(acc.settledAt, settled) : settled
      }
      if (msgDurationMs !== undefined) {
        acc.durationMs = (acc.durationMs ?? 0) + msgDurationMs
      }

      // Eligible process duration: this response carried thinking + toolCall and no non-empty
      // visible text, so its whole duration is process time (thinking and issuing calls), never
      // reply generation. Attached structurally to the message's first thinking segment exactly
      // once; responses with visible text stay out of process stats entirely (their duration
      // remains in the turn footer only). Zero/absent durations carry nothing to attribute.
      const eligibleResponseMs =
        msgDurationMs !== undefined && msgDurationMs > 0 && isEligibleProcessContent(m.content)
          ? msgDurationMs
          : undefined
      let responseDurationAttached = eligibleResponseMs === undefined

      const content = m.content
      if (!Array.isArray(content)) continue
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi]
        if (block === null || typeof block !== 'object') continue
        const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; input?: unknown }
        const key = `${entry.id}:${mi}:${bi}`
        if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim() !== '') {
            acc.segments.push({
              kind: 'thinking',
              key: `think:${key}`,
              text: b.thinking,
              ...(responseDurationAttached === false && eligibleResponseMs !== undefined
                ? { responseDurationMs: eligibleResponseMs }
                : {}),
            })
            if (eligibleResponseMs !== undefined) responseDurationAttached = true
          }
          continue
        }
        if (b.type === 'text') {
          if (typeof b.text === 'string' && b.text !== '') {
            acc.segments.push({ kind: 'text', key: `text:${key}`, text: b.text })
          }
          continue
        }
        if (b.type === 'toolCall' || b.type === 'tool_use') {
          const callId = typeof b.id === 'string' ? b.id : typeof b.callId === 'string' ? b.callId : undefined
          const name = typeof b.name === 'string' ? b.name : '(unknown tool)'
          const input = 'arguments' in b ? b.arguments : b.input
          // 运行中耗时的起点锚：本条响应的结束时刻（请求起点 + durationMs）即工具回合派发调用的
          // 时刻——客户端可达的最诚实逐调用起点（刷新 / 断线重连后依然成立，不依赖推送到达时间）。
          // durationMs 缺失（遗留 / deferred 响应）时不锚定，避免从请求起点起算虚高。
          const callStartedAt =
            msgTimestamp !== undefined && msgDurationMs !== undefined ? msgTimestamp + msgDurationMs : entry.createdAt
          acc.segments.push({
            kind: 'tool',
            key: `tool:${callId ?? key}`,
            tool: makeToolTrace(`tool:${callId ?? key}`, name, { callId, input, startedAt: callStartedAt, toolViews: opts.toolViews }),
          })
        }
      }
    }
  } else if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
    acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, entry.createdAt) : entry.createdAt
    acc.settledAt = acc.settledAt !== undefined ? Math.max(acc.settledAt, entry.createdAt) : entry.createdAt
  }
}

/** Pair pi.tool-result by toolCallId; an unmatched result becomes a standalone tool row. */
function appendToolResultEntry(acc: TurnAcc, entry: ConversationEntry, opts: BuildTimelineOptions): void {
  acc.entryIds.push(entry.id)
  const model = entry.model
  if (!Array.isArray(model)) return
  for (let mi = 0; mi < model.length; mi++) {
    const msg = model[mi]
    if (msg === null || typeof msg !== 'object') continue
    const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown; details?: unknown }
    if (m.role !== 'toolResult' && m.role !== 'tool') continue
    const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
    const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
    const resultText = contentTextOf(m.content)
    const isError = m.isError === true
    // External value boundary: only finite non-negative durations are accepted (negative/NaN/Infinity dropped, never displayed).
    const durationMs =
      typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0
        ? m.durationMs
        : undefined
    // Server truncation markers ride on the toolResult message (truncated/totalChars/totalLines).
    const truncation = readResultTruncation(m)
    // The persisted channel for structured outputs is the toolResult message details (pi-durable
    // never writes structuredOutput into conversation entries; it only feeds nested callers); non-object values are ignored.
    const details = m.details
    const structuredOutput =
      details !== null && typeof details === 'object' && !Array.isArray(details) ? details : undefined
    if (callId !== undefined) {
      let paired = false
      for (let i = acc.segments.length - 1; i >= 0; i--) {
        const seg = acc.segments[i]!
        if (seg.kind !== 'tool' || seg.tool === undefined) continue
        if (seg.tool.callId !== callId) continue
        if (seg.tool.resultText !== undefined || seg.tool.status === 'running') continue
        seg.tool.status = isError ? 'error' : 'done'
        seg.tool.isError = isError
        if (resultText !== '') seg.tool.resultText = resultText
        if (structuredOutput !== undefined) seg.tool.structuredOutput = structuredOutput
        if (durationMs !== undefined) seg.tool.durationMs = durationMs
        seg.tool.artifactRef = detectArtifactRef(seg.tool.resultText)
        if (truncation !== undefined) {
          seg.tool.resultTruncation = truncation
          seg.tool.resultEntryId = entry.id
        }
        paired = true
        break
      }
      if (paired) continue
    }
    const key = `tool:${callId ?? `${entry.id}:${mi}`}`
    acc.segments.push({
      kind: 'tool',
      key,
      tool: makeToolTrace(key, toolName, {
        callId,
        status: isError ? 'error' : 'done',
        isError,
        ...(resultText !== '' ? { resultText } : {}),
        ...(truncation !== undefined ? { resultTruncation: truncation, resultEntryId: entry.id } : {}),
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        toolViews: opts.toolViews,
      }),
    })
    const last = acc.segments[acc.segments.length - 1]!
    if (last.kind === 'tool' && last.tool !== undefined) {
      last.tool.artifactRef = detectArtifactRef(last.tool.resultText)
    }
  }
}

/** Live merge: streaming thinking; same callId updates the existing tool row (only pending fields); new calls append a running row; streaming text appends as a text segment. */
function mergeLiveIntoTurn(acc: TurnAcc, live: ConversationLive, opts: BuildTimelineOptions): void {
  if (typeof live.thinking === 'string' && live.thinking.trim() !== '') {
    const persistedThinking = acc.segments.findLast((segment) => segment.kind === 'thinking')?.text
    if (!persistedThinking?.startsWith(live.thinking)) {
      acc.segments.push({ kind: 'thinking', key: 'think:live', text: live.thinking })
    }
  }
  for (const lt of live.tools) {
    if (typeof lt?.callId !== 'string' || typeof lt.toolName !== 'string') continue
    let existing: ToolTrace | undefined
    for (const seg of acc.segments) {
      if (seg.kind === 'tool' && seg.tool !== undefined && seg.tool.callId === lt.callId) {
        existing = seg.tool
        break
      }
    }
    if (existing !== undefined) {
      if (existing.status !== 'done' && existing.status !== 'error') {
        existing.status = lt.status
      }
      if (lt.status === 'error') {
        existing.status = 'error'
        existing.isError = true
      }
      if (existing.input === undefined && lt.input !== undefined) existing.input = lt.input
      if (existing.resultText === undefined && lt.result !== undefined) {
        const text = typeof lt.result === 'string' ? lt.result : contentTextOf(lt.result)
        if (text !== '') existing.resultText = text
      }
      continue
    }
    const key = `tool:${lt.callId}`
    acc.segments.push({
      kind: 'tool',
      key,
      tool: makeToolTrace(key, lt.toolName, {
        callId: lt.callId,
        ...(lt.input !== undefined ? { input: lt.input } : {}),
        status: lt.status,
        toolViews: opts.toolViews,
      }),
    })
  }
  if (typeof live.text === 'string' && live.text.trim() !== '') {
    const persistedText = acc.segments.findLast((segment) => segment.kind === 'text')?.text
    if (persistedText?.startsWith(live.text)) return
    acc.segments.push({ kind: 'text', key: 'text:live', text: live.text })
  }
}

/**
 * Main timeline normalization function.
 *
 * Input contract: entries are in chronological order (old -> new, guaranteed by getConversationDetail).
 */
export function buildTimelineItems(
  entries: ReadonlyArray<ConversationEntry>,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  // Drop entries covered by helm.rewind first: applies to both initial loads and SSE-increment rewinds.
  const activeEntries = filterRewoundEntries(entries)
  const items: TimelineItem[] = []
  const seenInputIds = new Set<string>()
  let turn: TurnAcc | null = null
  let lastHumanInputText: string | undefined

  const pushHuman = (entry: ConversationEntry, data: HelmInputData, fallback: boolean): void => {
    flushTurn(turn, items, false)
    turn = null
    const createdAt =
      typeof data.createdAt === 'number' && Number.isFinite(data.createdAt) && data.createdAt > 0
        ? data.createdAt
        : typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0
          ? entry.createdAt
          : undefined
    items.push({
      kind: 'human',
      key: data.id !== undefined ? `human:id:${data.id}` : `human:${entry.id}`,
      entryId: entry.id,
      ...(data.id !== undefined ? { inputId: data.id } : {}),
      text: data.text,
      origin: data.origin,
      ...(data.meta !== undefined ? { meta: data.meta } : {}),
      ...(data.attachments !== undefined && data.attachments.length > 0 ? { attachments: data.attachments } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      fallback,
    })
  }

  for (const entry of activeEntries) {
    // Plugin timeline.renderer hit: any entry can be taken over (fold-exempt, renders a card directly).
    const renderer = matchTimelineRenderer(entry, options.timelineRenderers)
    if (renderer !== undefined) {
      if (entry.kind === 'helm.input') {
        const data = parseHelmInputData(entry.data)
        if (data !== undefined) {
          lastHumanInputText = data.text
          if (data.id !== undefined) seenInputIds.add(data.id)
        }
      }
      flushTurn(turn, items, false)
      turn = null
      items.push({ kind: 'plugin-card', key: `card:${entry.id}`, entryId: entry.id, entry, renderer })
      continue
    }

    switch (entry.kind) {
      case 'helm.input': {
        const data = parseHelmInputData(entry.data)
        if (data === undefined) break
        lastHumanInputText = data.text
        if (data.id !== undefined) seenInputIds.add(data.id)
        pushHuman(entry, data, false)
        break
      }
      case 'pi.user': {
        const text = extractUserMessageText(entry)
        if (text === '') break
        // The helm.input already covers the same text input: skip the duplicate pi.user right after it.
        if (lastHumanInputText !== undefined && lastHumanInputText === text) break
        lastHumanInputText = text
        pushHuman(entry, { text, origin: 'human' }, true)
        break
      }
      case 'pi.assistant': {
        // Effective-model boundary: when provably different from the turn's comparison baseline
        // (first trusted identity, surviving display pollution) — provider+model differing (including
        // A→B within one tool turn) — split before the new model's entry; an incomplete/invalid side
        // never splits or fakes, nor falls back to current conversation config; thinkingLevel is excluded.
        const modelIdentity = parseAssistantModelIdentity(entry)
        if (
          turn !== null &&
          turn.modelLocked === true &&
          turn.modelReference !== undefined &&
          modelIdentity !== undefined &&
          !sameAssistantModelIdentity(modelIdentity, turn.modelReference)
        ) {
          flushTurn(turn, items, false)
          turn = newTurn()
        }
        if (turn === null) turn = newTurn()
        appendAssistantEntry(turn, entry, options, modelIdentity)
        break
      }
      case 'pi.tool-result': {
        if (turn === null) turn = newTurn()
        appendToolResultEntry(turn, entry, options)
        break
      }
      case 'pi.reset': {
        const dataText = isStringRecord(entry.data) && typeof entry.data.handoff === 'string' ? entry.data.handoff : undefined
        const handoff = dataText !== undefined && dataText !== '' ? dataText : extractUserMessageText(entry)
        flushTurn(turn, items, false)
        turn = null
        lastHumanInputText = undefined
        items.push({
          kind: 'divider',
          key: `divider:${entry.id}`,
          entryId: entry.id,
          divider: 'reset',
          ...(handoff !== '' ? { handoff } : {}),
        })
        break
      }
      case 'pi.compaction': {
        const summary = extractUserMessageText(entry)
        flushTurn(turn, items, false)
        turn = null
        lastHumanInputText = undefined
        items.push({
          kind: 'divider',
          key: `divider:${entry.id}`,
          entryId: entry.id,
          divider: 'compaction',
          ...(summary !== '' ? { summary } : {}),
        })
        break
      }
      case 'pi.system': {
        // Position hints and tool-declaration changes: model-side bookkeeping, never user-rendered.
        break
      }
      default: {
        // Custom entries that hit no plugin renderer (helm.* bookkeeping etc.): no render contract, skip.
        break
      }
    }
  }

  // A settled state may still carry unconsumed queue-only snapshots; never revive assistant activity from them.
  const isLive = options.working ?? (options.live !== undefined)
  if (options.live !== undefined) {
    if (turn === null) turn = newTurn()
    mergeLiveIntoTurn(turn, options.live, options)
  }
  flushTurn(turn, items, isLive)

  if (options.compacting === true) {
    items.push({
      kind: 'divider',
      key: 'divider:compacting',
      entryId: 'compacting:live',
      divider: 'compaction',
      pending: true,
    })
  }

  // Formal entries win over queue snapshots so the same input is not shown twice during handover.
  for (const q of options.live?.queuedInputs ?? []) {
    if (typeof q?.id !== 'string' || q.id === '' || typeof q.text !== 'string') continue
    if (q.mode !== 'steer' && q.mode !== 'followUp') continue
    if (seenInputIds.has(q.id)) continue
    seenInputIds.add(q.id)
    items.push({
      kind: 'human',
      key: `human:id:${q.id}`,
      entryId: `queued:${q.submissionId}`,
      inputId: q.id,
      text: q.text,
      origin: q.origin === 'agent' || q.origin === 'trigger' ? q.origin : 'human',
      ...(Array.isArray(q.attachments) && q.attachments.length > 0 ? { attachments: q.attachments } : {}),
      ...(typeof q.createdAt === 'number' && Number.isFinite(q.createdAt) && q.createdAt > 0
        ? { createdAt: q.createdAt }
        : {}),
      fallback: false,
      queuedMode: q.mode,
    })
  }
  return items
}

/**
 * Collect lightweight summaries of all tool calls from timeline items (for tool.view plugin components
 * to dedupe/continue, i.e. ToolViewProps.siblingCalls; in timeline order; calls without callId are skipped).
 */
export function collectSiblingCalls(items: ReadonlyArray<TimelineItem>): ToolViewSiblingCall[] {
  const calls: ToolViewSiblingCall[] = []
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'tool') {
        pushSiblingCall(calls, seg.tool)
      } else if (seg.kind === 'step-group') {
        for (const step of seg.steps) {
          if (step.kind === 'tool') pushSiblingCall(calls, step.tool)
        }
      }
    }
  }
  return calls
}

function pushSiblingCall(calls: ToolViewSiblingCall[], tool: ToolTrace): void {
  if (tool.callId === undefined) return
  calls.push({
    callId: tool.callId,
    toolName: tool.toolName,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
    ...(tool.resultText !== undefined ? { result: tool.resultText } : {}),
    ...(tool.resultTruncation !== undefined ? { resultTruncation: tool.resultTruncation } : {}),
    ...(tool.structuredOutput !== undefined ? { structuredOutput: tool.structuredOutput } : {}),
  })
}

/** Latest human input text (for the Composer up-arrow prefill). */
export function lastHumanTextOf(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'human' && item.text.trim() !== '') return item.text
  }
  return undefined
}

// ---------------------------------------------------------------------------
// timeline.entry.action micro-slot entry context
// ---------------------------------------------------------------------------

/** Source entry kind of a human input row: helm.input normalization first, pi.user fallback display. */
export function humanItemEntryKind(item: HumanInputItem): string {
  return item.fallback ? 'pi.user' : 'helm.input'
}

// ---------------------------------------------------------------------------
// Folding of queued non-human long text (generic mechanism, no plugin payload parsing)
// ---------------------------------------------------------------------------

/** Long-text threshold for queued non-human inputs: fold only beyond 600 chars or 8 lines. */
const QUEUED_AGENT_COLLAPSE_CHARS = 600
const QUEUED_AGENT_COLLAPSE_LINES = 8
const QUEUED_AGENT_PREVIEW_CHARS = 240

export interface QueuedAgentTextCollapse {
  /** Whether to fold (short text stays unfolded, display unchanged). */
  collapsed: boolean
  /** Collapsed preview (keeps line structure, truncated with an ellipsis; unused when expanded). */
  preview: string
}

/**
 * Fold decision for long queued (steer/followUp) non-human text (e.g. raw background report text).
 * Generic display policy: no business payload parsing, length/line-count only; full text remains viewable when expanded.
 */
export function queuedAgentTextCollapse(text: string): QueuedAgentTextCollapse {
  const lines = text.split('\n')
  if (text.length <= QUEUED_AGENT_COLLAPSE_CHARS && lines.length <= QUEUED_AGENT_COLLAPSE_LINES) {
    return { collapsed: false, preview: text }
  }
  const preview = lines.slice(0, 6).join('\n').slice(0, QUEUED_AGENT_PREVIEW_CHARS)
  return {
    collapsed: true,
    preview: preview.length < text.length ? `${preview}…` : preview,
  }
}

// ---------------------------------------------------------------------------
// Assistant turn in-flight detection (copy/fork hover bar shows only when fully settled)
// ---------------------------------------------------------------------------

export interface AssistantTurnBusyOptions {
  isLatestTurn?: boolean
  /** Activities where the plugin reports only call ids; the host does not interpret their business state. */
  activeToolCallIds?: ReadonlySet<string>
}

/**
 * Decide whether an assistant turn is still responding or running in-flight tasks:
 * 1. turn.live is true (in flight / streaming / thinking);
 * 2. it is the latest turn and the parent conversation is working or blocked;
 * 3. any tool in the turn is running or unknown;
 * 4. a step-group is still active;
 * 5. any tool call of the turn still has plugin-registered background activity.
 */
export function isAssistantTurnBusy(
  turn: AssistantTurn,
  conversation: { id: number; status?: string },
  options?: AssistantTurnBusyOptions,
): boolean {
  if (turn.live) return true
  if (
    options?.isLatestTurn &&
    (conversation.status === 'working' || conversation.status === 'blocked')
  ) {
    return true
  }

  const isToolRunning = (tool: ToolTrace): boolean =>
    tool.status === 'running' || tool.status === 'unknown' ||
    (tool.callId !== undefined && options?.activeToolCallIds?.has(tool.callId) === true)

  for (const seg of turn.segments) {
    if (seg.kind === 'tool') {
      if (isToolRunning(seg.tool)) return true
    } else if (seg.kind === 'step-group') {
      if (seg.active) return true
      for (const step of seg.steps) {
        if (step.kind === 'tool' && isToolRunning(step.tool)) return true
      }
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// View pure functions (moved from the ConversationTimeline component, unit-testable directly)
// ---------------------------------------------------------------------------

/** Tool row status icon name: loader while running / x on failure / check when done / circle otherwise. */
export function toolStatusIcon(tool: ToolTrace): string {
  if (tool.status === 'running') return 'loader'
  if (tool.isError) return 'x'
  if (tool.status === 'done') return 'check'
  return 'circle'
}

/** Build the full standard tool.view props (including siblingCalls for plugin dedupe/continuation). */
export function buildToolViewProps(
  tool: ToolTrace,
  conversationId: number,
  siblingCalls: ReadonlyArray<ToolViewSiblingCall>,
): Record<string, unknown> {
  return {
    callId: tool.callId ?? '',
    toolName: tool.toolName,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
    ...(tool.resultText !== undefined ? { result: tool.resultText } : {}),
    ...(tool.resultTruncation !== undefined ? { resultTruncation: tool.resultTruncation } : {}),
    ...(tool.structuredOutput !== undefined ? { structuredOutput: tool.structuredOutput } : {}),
    isError: tool.isError,
    ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.artifactRef !== undefined ? { artifactRef: tool.artifactRef } : {}),
    conversationId,
    siblingCalls,
  }
}

/** timeline.entry.action anchor index: real entries not covered by rewind, indexed by id. */
export function buildActiveEntryIndex(entries: ReadonlyArray<ConversationEntry>): Map<string, ConversationEntry> {
  const index = new Map<string, ConversationEntry>()
  for (const entry of filterRewoundEntries(entries)) index.set(entry.id, entry)
  return index
}

function hasAssistantText(entry: ConversationEntry): boolean {
  if (!Array.isArray(entry.model)) return false
  for (const msg of entry.model) {
    if ((msg as { role?: unknown } | null)?.role !== 'assistant') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        (block as { type?: unknown } | null)?.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        (block as { text: string }).text !== ''
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Assistant turn action anchor: prefer the last pi.assistant entry carrying an assistant text block
 * (same carrier as the hover-bar copy); otherwise the last pi.assistant (even toolCall-only);
 * undefined when the turn only has tool entries so far (live start) —
 * never fabricate one from pi.tool-result.
 */
export function resolveAssistantAnchorEntry(
  entryIds: ReadonlyArray<string>,
  entriesById: ReadonlyMap<string, ConversationEntry>,
): ConversationEntry | undefined {
  let lastAssistant: ConversationEntry | undefined
  let lastTextEntry: ConversationEntry | undefined
  for (const id of entryIds) {
    const entry = entriesById.get(id)
    if (entry === undefined || entry.kind !== 'pi.assistant') continue
    lastAssistant = entry
    if (hasAssistantText(entry)) lastTextEntry = entry
  }
  return lastTextEntry ?? lastAssistant
}

/** Ctrl+O process-step fold toggle command (precisely synced to the latest assistant turn with process steps). */
export interface ProcessShortcutCommand {
  open: boolean
  seq: number
}

/** Find the key of the latest assistant turn containing foldable process steps (step-group); undefined when none. */
export function findLatestProcessTurnKey(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'assistant' && item.segments.some((seg) => seg.kind === 'step-group')) {
      return item.key
    }
  }
  return undefined
}
