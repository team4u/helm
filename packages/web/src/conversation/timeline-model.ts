/**
 * 时间线归一化纯函数层（纯 .ts，零 React/DOM 依赖，单测直测）。
 *
 * 职责：把后端 `ConversationEntry[]` + 实时 `ConversationLive` 转换为结构化渲染项：
 * - `helm.input` 去重归一化：以 helm.input（含 origin/meta/attachments）为准生成输入块，
 *   自动跳过其紧邻覆盖的重复 `pi.user`；裸 `pi.user`（无前置 helm.input）兜底展示。
 * - 插件 `timeline.renderer`（kinds + matchMeta）与 `tool.view`（toolNames）匹配判定。
 * - assistant 消息 thinking / text / toolCall 提取，`pi.tool-result` 按 callId 配对合并。
 * - 连续常规步骤「按回合收拢」：thinking 与成功且未命中插件 tool.view 的普通工具行
 *   收拢为 step-group；`isError`、tool.view 业务卡、subagent/SubagentWorkflow 永远豁免折叠。
 * - `pi.reset` / `pi.compaction` -> 上下文分割线（reset 可携带 handoff 交接摘要）。
 * - live 合并：实时工具（running）与流式文本并入进行中回合。
 */

import type {
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  InputOrigin,
  TimelineRendererSpec,
  ToolViewSpec,
  WhenBusy,
} from '@helm/protocol'

// ---------------------------------------------------------------------------
// 渲染项类型
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

export interface ToolTrace {
  key: string
  toolName: string
  callId?: string
  input?: unknown
  status: ToolTraceStatus
  isError: boolean
  resultText?: string
  durationMs?: number
  /** 输出中检测到的产物引用（内核超长 Spill 标记 / art_ 前缀），供「打开完整产物」按钮。 */
  artifactRef?: string
  /** 命中插件 tool.view（如 dispatch_worker）：豁免折叠，直接渲染业务卡片。 */
  toolView?: QualifiedToolView
}

export interface ThinkingTrace {
  key: string
  text: string
}

export type FoldableStep =
  | { kind: 'thinking'; thinking: ThinkingTrace }
  | { kind: 'tool'; tool: ToolTrace }

export type AssistantSegment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'step-group'; key: string; stepCount: number; steps: FoldableStep[] }
  | { kind: 'tool'; key: string; tool: ToolTrace }

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  /** 本回合涉及的全部 entry id（悬停分叉 fork 使用最后一个）。 */
  entryIds: string[]
  segments: AssistantSegment[]
  /** true = 已与 ConversationLive 合并的进行中回合。 */
  live: boolean
}

export interface HumanInputItem {
  kind: 'human'
  key: string
  entryId: string
  text: string
  origin: InputOrigin
  meta?: Record<string, unknown>
  attachments?: ConversationAttachmentRef[]
  /** true = 无前置 helm.input 的裸 pi.user 兜底展示。 */
  fallback: boolean
}

export interface DividerItem {
  kind: 'divider'
  key: string
  entryId: string
  divider: 'reset' | 'compaction'
  /** pi.reset 携带的交接摘要（可展开查看）。 */
  handoff?: string
  /** pi.compaction 的精简摘要（仅模型层保留，UI 默认不展开）。 */
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

export interface BuildTimelineOptions {
  /** 进行中回合的实时视图（会话 working 时传入；空闲不传）。 */
  live?: ConversationLive
  timelineRenderers?: ReadonlyArray<QualifiedRenderer>
  toolViews?: ReadonlyArray<QualifiedToolView>
}

/** 豁免折叠的业务工具名（后台子代理派生，需直接露出）。 */
const BUSINESS_TOOL_NAMES = new Set(['subagent', 'SubagentWorkflow'])

/** 单行轨迹入参摘要最大长度。 */
const SUMMARY_MAX_CHARS = 60

// ---------------------------------------------------------------------------
// 通用纯工具
// ---------------------------------------------------------------------------

/** 错误转可读文本（通知/内联错误共用）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 字节数人性化（1024 进制）。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '-'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/** 毫秒时长摘要（工具耗时 / 工作流节点耗时）。 */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

// ---------------------------------------------------------------------------
// 输入提取与去重
// ---------------------------------------------------------------------------

/** 校验并解析 helm.input entry.data；形状非法返回 undefined（绝不伪造）。 */
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
    ...(typeof d.id === 'string' ? { id: d.id } : {}),
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

/** 提取 entry.model 中全部 user 消息文本（content 为 string 或 text 块数组）。 */
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

/** content（string | Array<{type:'text',text}> | Array<{type:'text',text|thinking,...}>）-> 纯文本。 */
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
// 插件扩展点匹配
// ---------------------------------------------------------------------------

/**
 * timeline.renderer 匹配判定：
 * - kinds 缺省接管全部；提供时须包含 entry.kind；
 * - matchMeta.renderer 须等于 entry.data.meta.renderer 或 entry.data.renderer（与 kinds 取 AND）。
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
  for (const r of renderers) {
    const kinds = r.spec.kinds
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.includes(entry.kind))) continue
    const want = r.spec.matchMeta?.renderer
    if (want !== undefined && metaRenderer !== want && ownRenderer !== want) continue
    return r
  }
  return undefined
}

/** tool.view 匹配：spec.toolNames 包含 toolName。 */
export function findToolView(
  toolName: string,
  toolViews: ReadonlyArray<QualifiedToolView> | undefined,
): QualifiedToolView | undefined {
  if (!toolViews) return undefined
  for (const tv of toolViews) {
    if (Array.isArray(tv.spec.toolNames) && tv.spec.toolNames.includes(toolName)) return tv
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 工具轨迹摘要与产物引用检测
// ---------------------------------------------------------------------------

function summarizeValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/** 单行轨迹核心入参摘要：优先命令/文件路径/提示词，取首行并截断 60 字符。 */
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

/** 内核超长 Spill 标记（`[Artifact] id=<uuid>`）或 art_ 前缀产物引用。 */
const SPILL_ID_RE = /\[Artifact\]\s+id=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/
const ART_REF_RE = /\bart_[A-Za-z0-9_-]{1,127}\b/

/** 检测工具输出文本中的产物引用；无则 undefined。 */
export function detectArtifactRef(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  return SPILL_ID_RE.exec(text)?.[1] ?? ART_REF_RE.exec(text)?.[0]
}

// ---------------------------------------------------------------------------
// 回合构建
// ---------------------------------------------------------------------------

interface RawSegment {
  kind: 'text' | 'thinking' | 'tool'
  key: string
  text?: string
  tool?: ToolTrace
}

interface TurnAcc {
  entryIds: string[]
  segments: RawSegment[]
}

function newTurn(): TurnAcc {
  return { entryIds: [], segments: [] }
}

function makeToolTrace(
  key: string,
  toolName: string,
  opts: { callId?: string; input?: unknown; status?: ToolTraceStatus; isError?: boolean; resultText?: string; durationMs?: number; toolViews?: ReadonlyArray<QualifiedToolView> },
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
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...{ toolView: findToolView(toolName, opts.toolViews) },
  }
}

/** 折叠豁免判定：thinking 与「成功且非业务卡」的普通工具行可收拢。 */
export function isFoldableStep(step: FoldableStep): boolean {
  if (step.kind === 'thinking') return true
  const tool = step.tool
  if (tool.isError) return false
  if (tool.toolView !== undefined) return false
  if (BUSINESS_TOOL_NAMES.has(tool.toolName)) return false
  return true
}

function foldableOfRaw(seg: RawSegment): FoldableStep {
  if (seg.kind === 'thinking') return { kind: 'thinking', thinking: { key: seg.key, text: seg.text ?? '' } }
  return { kind: 'tool', tool: seg.tool! }
}

/**
 * 原始段 -> 渲染段：连续可折叠步骤（>= 2）收拢为 step-group（摘要「思考与执行过程 (N 步)」），
 * 豁免项（isError / tool.view / subagent）与文本块保持独立。
 */
export function foldTurnSegments(raw: ReadonlyArray<RawSegment>): AssistantSegment[] {
  const out: AssistantSegment[] = []
  let buffer: FoldableStep[] = []
  const flushBuffer = (): void => {
    if (buffer.length >= 2) {
      const first = buffer[0]!
      const firstKey = first.kind === 'thinking' ? first.thinking.key : first.tool.key
      out.push({
        kind: 'step-group',
        key: `group:${out.length}:${buffer.length}:${firstKey}`,
        stepCount: buffer.length,
        steps: buffer,
      })
    } else if (buffer.length === 1) {
      const step = buffer[0]!
      if (step.kind === 'thinking') {
        out.push({
          kind: 'step-group',
          key: `group:${out.length}:1:${step.thinking.key}`,
          stepCount: 1,
          steps: [step],
        })
      } else {
        out.push({ kind: 'tool', key: step.tool.key, tool: step.tool })
      }
    }
    buffer = []
  }
  for (const seg of raw) {
    if (seg.kind === 'text') {
      if ((seg.text ?? '') === '') continue
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined && last.kind === 'text') {
        last.text += seg.text ?? ''
        continue
      }
      out.push({ kind: 'text', key: seg.key, text: seg.text ?? '' })
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
  return out
}

function flushTurn(acc: TurnAcc | null, items: TimelineItem[], live: boolean): void {
  if (acc === null) return
  const segments = foldTurnSegments(acc.segments)
  if (segments.length === 0 && acc.entryIds.length === 0) return
  if (segments.length === 0) return
  const lastEntryId = acc.entryIds.length > 0 ? acc.entryIds[acc.entryIds.length - 1]! : ''
  items.push({
    kind: 'assistant',
    key: `turn:${lastEntryId || acc.segments[0]?.key || 'empty'}`,
    entryIds: [...acc.entryIds],
    segments,
    live,
  })
}

/** 提取 assistant 消息内容块（thinking / text / toolCall）。 */
function appendAssistantEntry(acc: TurnAcc, entry: ConversationEntry, opts: BuildTimelineOptions): void {
  acc.entryIds.push(entry.id)
  const model = entry.model
  if (!Array.isArray(model)) return
  for (let mi = 0; mi < model.length; mi++) {
    const msg = model[mi]
    if (msg === null || typeof msg !== 'object') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi]
      if (block === null || typeof block !== 'object') continue
      const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; input?: unknown }
      const key = `${entry.id}:${mi}:${bi}`
      if (b.type === 'thinking') {
        if (typeof b.thinking === 'string' && b.thinking.trim() !== '') {
          acc.segments.push({ kind: 'thinking', key: `think:${key}`, text: b.thinking })
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
        acc.segments.push({
          kind: 'tool',
          key: `tool:${callId ?? key}`,
          tool: makeToolTrace(`tool:${callId ?? key}`, name, { callId, input, toolViews: opts.toolViews }),
        })
      }
    }
  }
}

/** pi.tool-result 按 toolCallId 配对；找不到对应 call 则生成独立工具行。 */
function appendToolResultEntry(acc: TurnAcc, entry: ConversationEntry, opts: BuildTimelineOptions): void {
  acc.entryIds.push(entry.id)
  const model = entry.model
  if (!Array.isArray(model)) return
  for (let mi = 0; mi < model.length; mi++) {
    const msg = model[mi]
    if (msg === null || typeof msg !== 'object') continue
    const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown }
    if (m.role !== 'toolResult' && m.role !== 'tool') continue
    const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
    const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
    const resultText = contentTextOf(m.content)
    const isError = m.isError === true
    const durationMs = typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) ? m.durationMs : undefined
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
        if (durationMs !== undefined) seg.tool.durationMs = durationMs
        seg.tool.artifactRef = detectArtifactRef(seg.tool.resultText)
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

/** live 合并：同 callId 更新既有工具行（仅补未决字段），新 call 追加 running 行；流式文本追加为文本段。 */
function mergeLiveIntoTurn(acc: TurnAcc, live: ConversationLive, opts: BuildTimelineOptions): void {
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
      existing.status = lt.status
      if (lt.status === 'error') existing.isError = true
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
    acc.segments.push({ kind: 'text', key: `text:live:${live.updatedAt}`, text: live.text })
  }
}

/**
 * 时间线归一化主函数。
 *
 * 输入约定：entries 为时间正序（旧 -> 新，getConversationDetail 已保证）。
 */
export function buildTimelineItems(
  entries: ReadonlyArray<ConversationEntry>,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  const items: TimelineItem[] = []
  let turn: TurnAcc | null = null
  let lastHumanInputText: string | undefined

  const pushHuman = (entry: ConversationEntry, data: HelmInputData, fallback: boolean): void => {
    flushTurn(turn, items, false)
    turn = null
    items.push({
      kind: 'human',
      key: `human:${entry.id}`,
      entryId: entry.id,
      text: data.text,
      origin: data.origin,
      ...(data.meta !== undefined ? { meta: data.meta } : {}),
      ...(data.attachments !== undefined && data.attachments.length > 0 ? { attachments: data.attachments } : {}),
      fallback,
    })
  }

  for (const entry of entries) {
    // 插件 timeline.renderer 命中：任何 entry 都可能被接管（豁免折叠，直接渲染卡片）。
    const renderer = matchTimelineRenderer(entry, options.timelineRenderers)
    if (renderer !== undefined) {
      if (entry.kind === 'helm.input') {
        const data = parseHelmInputData(entry.data)
        if (data !== undefined) lastHumanInputText = data.text
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
        pushHuman(entry, data, false)
        break
      }
      case 'pi.user': {
        const text = extractUserMessageText(entry)
        if (text === '') break
        // helm.input 已覆盖同文本输入：跳过紧随的重复 pi.user。
        if (lastHumanInputText !== undefined && lastHumanInputText === text) break
        lastHumanInputText = text
        pushHuman(entry, { text, origin: 'human' }, true)
        break
      }
      case 'pi.assistant': {
        if (turn === null) turn = newTurn()
        appendAssistantEntry(turn, entry, options)
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
        // 位置提示与工具声明变更：模型侧簿记，不面向用户渲染。
        break
      }
      default: {
        // 未命中插件 renderer 的自定义 entry（helm.* 簿记等）：无渲染契约，跳过。
        break
      }
    }
  }

  if (options.live !== undefined) {
    if (turn === null) turn = newTurn()
    mergeLiveIntoTurn(turn, options.live, options)
    flushTurn(turn, items, true)
  } else {
    flushTurn(turn, items, false)
  }
  return items
}

/** 最近一条人类输入文本（Composer 上箭头回填用）。 */
export function lastHumanTextOf(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'human' && item.text.trim() !== '') return item.text
  }
  return undefined
}
