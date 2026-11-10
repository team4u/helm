/**
 * 时间线归一化纯函数层（纯 .ts，零 React/DOM 依赖，单测直测）。
 *
 * 职责：把后端 `ConversationEntry[]` + 实时 `ConversationLive` 转换为结构化渲染项：
 * - `helm.input` 去重归一化：以 helm.input（含 origin/meta/attachments）为准生成输入块，
 *   自动跳过其紧邻覆盖的重复 `pi.user`；裸 `pi.user`（无前置 helm.input）兜底展示。
 * - 插件 `timeline.renderer`（kinds + matchMeta）与 `tool.view`（toolNames）匹配判定。
 * - assistant 消息 thinking / text / toolCall 提取，`pi.tool-result` 按 callId 配对合并。
 * - 连续常规步骤「按回合收拢」：thinking 与常规工具行（含出错）
 *   收拢为 step-group；命中 tool.view 的业务卡永远豁免折叠。
 * - `pi.reset` / `pi.compaction` -> 上下文分割线（reset 可携带 handoff 交接摘要）。
 * - live 合并：实时工具（running）与流式文本并入进行中回合。
 */

import type {
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  InputOrigin,
  TimelineRendererSpec,
  ToolViewSiblingCall,
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
  /** 工具调用所在已持久化条目的时间；流式调用尚无记录时省略。 */
  startedAt?: number
  durationMs?: number
  /** 输出中检测到的产物引用（内核超长 Spill 标记 / art_ 前缀），供「打开完整产物」按钮。 */
  artifactRef?: string
  /** 工具结构化输出（声明 structuredOutputSchema 的工具结果）；未声明或未落库时省略。 */
  structuredOutput?: unknown
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
  | { kind: 'step-group'; key: string; stepCount: number; steps: FoldableStep[]; active?: boolean }
  | { kind: 'tool'; key: string; tool: ToolTrace }

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  /** 本回合涉及的全部 entry id（悬停分叉 fork 使用最后一个）。 */
  entryIds: string[]
  segments: AssistantSegment[]
  /** true = 已与 ConversationLive 合并的进行中回合。 */
  live: boolean
  /** 回合开始时间戳（毫秒）；未采集时省略。 */
  startedAt?: number
  /** 回合结算时间戳（毫秒）；未结算或未采集时省略。 */
  settledAt?: number
  /** 回合总耗时（毫秒）；未采集时省略。 */
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
  /** helm.input 的稳定身份；入队与落库时沿用同一 React key。 */
  inputId?: string
  /** 非空表示该输入仍在 pi.inbox 排队待生效（尚未落入正式 entries）。 */
  queuedMode?: 'steer' | 'followUp'
  /** true = 无前置 helm.input 的裸 pi.user 兜底展示。 */
  fallback: boolean
  /** 消息创建/发送时间戳（毫秒）；未知或缺省时省略。 */
  createdAt?: number
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

/** 「编辑并重发」目标：回填 Composer 的文本 + 可选历史 entry 锚点与附件。 */
export interface EditRequestTarget {
  text: string
  /** 历史已落库条目的正整数 ID；排队消息撤回后仅回填草稿时不传。 */
  entryId?: number
  /** 原消息携带的附件引用（回填至待发送区）。 */
  attachments?: ConversationAttachmentRef[]
}

// ---------------------------------------------------------------------------
// rewind 覆盖过滤
// ---------------------------------------------------------------------------

/**
 * 过滤被 helm.rewind 覆盖的条目。
 *
 * 后端原子提交：先落新 input，再追加 rewind marker，同一批保存。
 * rewind.data = { fromEntryId, throughEntryId(提交新 input 前的旧 tail), ... }，
 * 覆盖区间是闭区间 [fromEntryId, throughEntryId]——绝不能按 marker 自身 id 截断，
 * 否则会把同批落库、id 小于 marker 的新 input 一并隐藏。
 *
 * 区间合法性：from/through 均为 safe positive integer 且 through >= from、
 * through < marker 自身 id；非法 marker 只隐藏自身（保持隐藏控制记录），不覆盖任何条目。
 * 多条 rewind 的区间取并集；SDK 重建的 pi.system 基线不受影响（本就不渲染）。
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
 * 最近一条可编辑的人类输入（Composer 空框 ↑ 回填）：
 * - 只认 origin === 'human'：agent 汇报 / trigger 注入不是人类编辑对象，跳过继续向前找；
 * - 不跨 pi.reset / pi.compaction 边界原地编辑（后端最终权威上下文从最新边界起算）；
 * - 优先 helm.input（含附件），兜底裸 pi.user。
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
  /** 进行中回合的实时视图（会话 working 时传入；空闲不传）。 */
  live?: ConversationLive
  /** 会话是否处于 working 执行态（首 token 前与工具轮间隙保持当前回合活跃）。 */
  working?: boolean
  timelineRenderers?: ReadonlyArray<QualifiedRenderer>
  toolViews?: ReadonlyArray<QualifiedToolView>
}

/** 单行轨迹入参摘要最大长度。 */
const SUMMARY_MAX_CHARS = 60

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
 * priority 降序稳定排序：高优先级在前，同优先级（含缺省 0）保持贡献顺序
 * （先注册先命中）。返回新数组，不修改传入的贡献列表（groupedUi 引用稳定）。
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
 * timeline.renderer 匹配判定（priority 降序稳定裁决）：
 * - 先按 (spec.priority ?? 0) 降序、同优先级保持插件贡献顺序（先注册先命中）；
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
 * tool.view 匹配（priority 降序稳定裁决）：spec.toolNames 包含 toolName。
 * 按 (spec.priority ?? 0) 降序、同优先级保持贡献顺序取首个命中；
 * replaceRow 等渲染语义由消费方按命中 spec 判定，匹配层不做干预。
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
  opts: { callId?: string; input?: unknown; status?: ToolTraceStatus; isError?: boolean; resultText?: string; structuredOutput?: unknown; startedAt?: number; durationMs?: number; toolViews?: ReadonlyArray<QualifiedToolView> },
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
    ...(opts.structuredOutput !== undefined ? { structuredOutput: opts.structuredOutput } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...{ toolView: findToolView(toolName, opts.toolViews) },
  }
}

/** 折叠豁免判定：thinking 与常规工具行（含执行中、完成与出错）可收拢；只有命中插件 tool.view 的业务卡独立展示。 */
export function isFoldableStep(step: FoldableStep): boolean {
  if (step.kind === 'thinking') return true
  const tool = step.tool
  if (tool.toolView !== undefined) return false
  return true
}

function foldableOfRaw(seg: RawSegment): FoldableStep {
  if (seg.kind === 'thinking') return { kind: 'thinking', thinking: { key: seg.key, text: seg.text ?? '' } }
  return { kind: 'tool', tool: seg.tool! }
}

/**
 * 原始段 -> 渲染段：连续可折叠步骤从第一步起就放入 step-group，避免后续追加步骤时搬移节点。
 * 豁免项（tool.view）与文本块保持独立。
 * 当回合仍在运行（live=true）且该 step-group 之后尚未产出任何 text 正文段时，标记 active=true（前端默认展开）。
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
      // 同一正文从流式快照转为落库条目时仍复用节点，避免卸载代码块与交互状态。
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
      seg.active = live && (i > lastTextIndex || hasRunningTool)
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

  items.push({
    kind: 'assistant',
    key: `turn:${prevKey}`,
    entryIds: [...acc.entryIds],
    segments,
    live,
    ...(acc.startedAt !== undefined ? { startedAt: acc.startedAt } : {}),
    ...(acc.settledAt !== undefined ? { settledAt: acc.settledAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  })
}

/** 提取 assistant 消息内容块（thinking / text / toolCall）。 */
function appendAssistantEntry(acc: TurnAcc, entry: ConversationEntry, opts: BuildTimelineOptions): void {
  acc.entryIds.push(entry.id)
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

      const content = m.content
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
            tool: makeToolTrace(`tool:${callId ?? key}`, name, { callId, input, startedAt: entry.createdAt, toolViews: opts.toolViews }),
          })
        }
      }
    }
  } else if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
    acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, entry.createdAt) : entry.createdAt
    acc.settledAt = acc.settledAt !== undefined ? Math.max(acc.settledAt, entry.createdAt) : entry.createdAt
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
    const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown; structuredOutput?: unknown }
    if (m.role !== 'toolResult' && m.role !== 'tool') continue
    const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
    const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
    const resultText = contentTextOf(m.content)
    const isError = m.isError === true
    const durationMs = typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) ? m.durationMs : undefined
    const structuredOutput = m.structuredOutput
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

/** live 合并：流式思考、同 callId 更新既有工具行（仅补未决字段）、新 call 追加 running 行、流式文本追加为文本段。 */
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
 * 时间线归一化主函数。
 *
 * 输入约定：entries 为时间正序（旧 -> 新，getConversationDetail 已保证）。
 */
export function buildTimelineItems(
  entries: ReadonlyArray<ConversationEntry>,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  // 先剔除被 helm.rewind 覆盖的条目：初次加载与 SSE 增量收到 rewind 同样生效。
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
    // 插件 timeline.renderer 命中：任何 entry 都可能被接管（豁免折叠，直接渲染卡片）。
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

  // 终态也可能携带未消费的 queue-only 快照，不能据此复活助手执行态。
  const isLive = options.working ?? (options.live !== undefined)
  if (options.live !== undefined) {
    if (turn === null) turn = newTurn()
    mergeLiveIntoTurn(turn, options.live, options)
  }
  flushTurn(turn, items, isLive)

  // 正式 entry 优先于队列快照，避免交接期间同一 input 展示两次。
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
 * 从时间线 items 收集全部工具调用的轻量摘要（供 tool.view 插件组件去重/续接计算，
 * 即 ToolViewProps.siblingCalls；按时间线出现顺序排列，无 callId 的调用跳过）。
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
    ...(tool.structuredOutput !== undefined ? { structuredOutput: tool.structuredOutput } : {}),
  })
}

/** 最近一条人类输入文本（Composer 上箭头回填用）。 */
export function lastHumanTextOf(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'human' && item.text.trim() !== '') return item.text
  }
  return undefined
}

// ---------------------------------------------------------------------------
// timeline.entry.action 微插槽条目上下文
// ---------------------------------------------------------------------------

/** 人类输入条的源 entry kind：helm.input 归一化优先，兜底展示为 pi.user。 */
export function humanItemEntryKind(item: HumanInputItem): string {
  return item.fallback ? 'pi.user' : 'helm.input'
}

// ---------------------------------------------------------------------------
// assistant 回合在途判定（复制/分叉 hover 条仅在彻底完成时展示）
// ---------------------------------------------------------------------------

export interface AssistantTurnBusyOptions {
  isLatestTurn?: boolean
  /** 插件仅报告调用 ID 的活动；宿主不解释其业务状态。 */
  activeToolCallIds?: ReadonlySet<string>
}

/**
 * 判定 assistant 回合是否仍在响应或执行在途任务中：
 * 1. turn.live 为 true（进行中 / 流式输出 / 思考中）；
 * 2. 最新回合且父会话处于 working 或 blocked 状态；
 * 3. 回合内任一工具状态为 running 或 unknown；
 * 4. step-group 仍处于 active 激活态；
 * 5. 本回合工具调用仍有插件登记的后台活动。
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
