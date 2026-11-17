/**
 * 会话大纲（Outline）纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 职责：
 * - 从已归一化的 `TimelineItem[]` 构建会话回合级导航大纲：
 *   1. 人类回合节点（`human`）：按顺序编号（#1, #2...），提取首行摘要、全文（供搜索）、时间与来源；
 *   2. 助手回合节点（`assistant`）：智能合并——有 Markdown 标题时由标题节点代表本回合，
 *      无标题有正文时输出首行摘要节点；无正文有业务卡时由卡片代表；
 *      无正文无卡片时保留诚实状态摘要（生成中/失败/无正文）；
 *   3. Markdown 标题节点（`heading`）：从助手回复正文中提取 `# ~ ###` 标题（自动跳过代码块围栏）；
 *   4. 业务卡节点（`card`）：AssistantTurn 顶层命中插件 tool.view 的业务卡（通用
 *      toolName + 入参摘要）与 timeline.renderer 接管的 plugin-card 条目（通用
 *      helm.input 文本摘要）；step-group 内普通工具与 thinking 不进大纲；
 *   5. 上下文分割线节点（`divider`）：重置（`/reset`）或精简（`/compact`）边界；
 * - 支持关键词过滤：匹配人类/助手全文、标题与卡片可搜索文本；命中子节点时自动
 *   保留其所属的人类回合父节点以维持上下文层级；
 * - 支持滚动位置激活态计算：根据可视区顶部基准线与各锚点元素偏移量，推导当前阅读所处的激活大纲项。
 */

import type { ConversationEntry, InputOrigin } from '@helm/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import {
  parseHelmInputData,
  toolSummaryText,
  type AssistantTurn,
  type DividerItem,
  type HumanInputItem,
  type PluginCardItem,
  type TimelineItem,
  type ToolTrace,
} from './timeline-model.js'

// ---------------------------------------------------------------------------
// 大纲节点类型
// ---------------------------------------------------------------------------

export interface OutlineHumanNode {
  kind: 'human'
  /** 唯一节点 key（React key 与列表定位用）。 */
  key: string
  /** 对应 Timeline 包装元素的 `data-entry-id`。 */
  entryId: string
  /** 会话内第几轮提问（1-indexed）。 */
  turnIndex: number
  /** 单行紧凑摘要。 */
  label: string
  /** 原始完整文本（供搜索过滤与悬浮提示）。 */
  fullText: string
  origin: InputOrigin
  createdAt?: number
  queuedMode?: 'steer' | 'followUp'
  attachmentCount: number
}

/** 助手回合无正文无业务卡时的诚实状态摘要（按现有数据能力，不伪造详情）。 */
export type OutlineAssistantStatus = 'generating' | 'failed' | 'no-content'

export interface OutlineAssistantNode {
  kind: 'assistant'
  key: string
  /** 所属助手回合在 Timeline 包装元素上的 `data-entry-id`（即 `turn.entryIds[0] ?? turn.key`）。 */
  entryId: string
  /** 单行紧凑摘要（正文首行；状态节点为固定状态文案）。 */
  label: string
  /** 回合正文全文（供搜索过滤与悬浮提示）；状态节点为空串。 */
  fullText: string
  /** true = 进行中（生成中）回合。 */
  live: boolean
  /** 状态摘要标记；有正文的摘要节点省略。 */
  status?: OutlineAssistantStatus
  /** 回合时间（settledAt ?? startedAt）；未采集时省略。 */
  createdAt?: number
  /** 紧邻的上一个人类提问节点 key（搜索命中本节点时保留父提问上下文）。 */
  parentHumanKey?: string
}

export interface OutlineHeadingNode {
  kind: 'heading'
  key: string
  /** 所属助手回合在 Timeline 包装元素上的 `data-entry-id`（即 `turn.entryIds[0] ?? turn.key`）。 */
  entryId: string
  /** 所属助手回合内第几个 Markdown 标题（0-indexed，配合 DOM 查询精确定位到具体 h1~h3）。 */
  headingIndex: number
  /** 标题层级（1 | 2 | 3）。 */
  level: 1 | 2 | 3
  /** 清理行内格式后的标题文本。 */
  text: string
  /** 紧邻的上一个人类提问节点 key（搜索命中子标题时保留父提问上下文）。 */
  parentHumanKey?: string
}

export interface OutlineDividerNode {
  kind: 'divider'
  key: string
  entryId: string
  divider: 'reset' | 'compaction'
  label: string
}

/** 业务卡节点：assistant 回合顶层 tool.view 卡或 timeline.renderer 接管的 plugin-card。 */
export interface OutlineCardNode {
  kind: 'card'
  key: string
  /** 一级定位锚：Timeline 包装元素 `data-entry-id`（plugin-card 为其 entryId，tool.view 卡为所属回合锚）。 */
  entryId: string
  /** 二级定位锚：回合内 tool.view 业务卡 trace 元素的 `data-outline-card-id`（即 tool.key）；plugin-card 无此字段。 */
  cardId?: string
  /** 单行标题（通用诚实摘要：toolName + 入参摘要 / helm.input 文本首行 / 稳定契约标识兜底）。 */
  label: string
  /** 可搜索文本（标题 + 底层文本摘要）。 */
  searchText: string
  /** tool.view 业务卡的工具执行状态；plugin-card 省略。 */
  status?: 'running' | 'done' | 'error' | 'unknown'
  parentHumanKey?: string
}

export type OutlineNode =
  | OutlineHumanNode
  | OutlineAssistantNode
  | OutlineHeadingNode
  | OutlineCardNode
  | OutlineDividerNode

export interface ExtractedHeading {
  level: 1 | 2 | 3
  text: string
}

/** 从独立 Markdown 文档构建可复用的大纲标题节点。 */
export function buildMarkdownOutline(markdown: string): OutlineHeadingNode[] {
  return extractMarkdownHeadings(markdown).map((heading, headingIndex) => ({
    kind: 'heading',
    key: `outline:markdown:${headingIndex}`,
    entryId: 'markdown-preview',
    headingIndex,
    level: heading.level,
    text: heading.text,
  }))
}

/** 大纲单行摘要默认最大长度（人类提问/助手正文/业务卡标题共用）。 */
const OUTLINE_SUMMARY_MAX_CHARS = 72
/** Markdown 标题单行展示最大长度。 */
const HEADING_MAX_CHARS = 72

// ---------------------------------------------------------------------------
// 文本摘要与 Markdown 标题提取
// ---------------------------------------------------------------------------

/**
 * 清理行内轻量 Markdown 标记（粗体、斜体、行内代码、链接文本），生成干净的单行大纲标签。
 */
export function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateLabel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/**
 * 将多行正文浓缩为单行大纲标签（人类输入与助手正文共用）：
 * 取首个非空行并清理标题/引用/列表行首标记与行内格式；若文本为空但有附件，回退为附件数量提示。
 */
export function summarizeOutlineText(text: string, attachmentCount = 0, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const cleaned = stripInlineMarkdown(
      rawLine
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^[-*+]\s+/, ''),
    )
    if (cleaned !== '') {
      return truncateLabel(cleaned, OUTLINE_SUMMARY_MAX_CHARS)
    }
  }
  if (attachmentCount > 0) {
    return tt('conv.outline.attachmentLabel', { count: attachmentCount })
  }
  return tt('conv.outline.emptyMessage')
}

/**
 * 从 Markdown 文本中提取 `#` ~ `###` 标题：
 * - 严格忽略 ``` 或 ~~~ 代码块围栏内部的注释行（如 `# bash comment`）；
 * - 仅提取 H1 ~ H3（H4~H6 粒度过细，不进大纲以免噪音）。
 */
export function extractMarkdownHeadings(markdown: string): ExtractedHeading[] {
  if (typeof markdown !== 'string' || markdown === '') return []
  const headings: ExtractedHeading[] = []
  const lines = markdown.split(/\r?\n/)
  let activeFence: string | null = null

  for (const rawLine of lines) {
    const trimmedStart = rawLine.trimStart().replace(/^(?:>\s*)+/, '')
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmedStart)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!
      if (activeFence === null) {
        activeFence = marker[0]!
      } else if (trimmedStart.startsWith(activeFence.repeat(3))) {
        activeFence = null
      }
      continue
    }
    if (activeFence !== null) continue

    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(trimmedStart)
    if (match === null) continue
    const hashes = match[1]!
    const rawTitle = match[2]!
    const text = stripInlineMarkdown(rawTitle)
    if (text === '') continue
    const level = hashes.length as 1 | 2 | 3
    headings.push({
      level,
      text: truncateLabel(text, HEADING_MAX_CHARS),
    })
  }
  return headings
}

// ---------------------------------------------------------------------------
// 大纲构建
// ---------------------------------------------------------------------------

function buildHumanNode(item: HumanInputItem, turnIndex: number, tt: WebMessageTranslator): OutlineHumanNode {
  const attachmentCount = item.attachments?.length ?? 0
  return {
    kind: 'human',
    key: `outline:human:${item.key}`,
    entryId: item.entryId,
    turnIndex,
    label: summarizeOutlineText(item.text, attachmentCount, tt),
    fullText: item.text,
    origin: item.origin,
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.queuedMode !== undefined ? { queuedMode: item.queuedMode } : {}),
    attachmentCount,
  }
}

function buildDividerNode(item: DividerItem, tt: WebMessageTranslator): OutlineDividerNode {
  return {
    kind: 'divider',
    key: `outline:divider:${item.key}`,
    entryId: item.entryId,
    divider: item.divider,
    label:
      item.divider === 'reset'
        ? tt('conv.divider.reset')
        : item.pending === true
          ? tt('conv.divider.compacting')
          : tt('conv.divider.compacted'),
  }
}

// ---------------------------------------------------------------------------
// 助手回合智能合并与业务卡节点
// ---------------------------------------------------------------------------

/** 状态节点固定文案（按现有数据能力诚实标注，不伪造详情）。 */
function assistantStatusLabel(status: OutlineAssistantStatus, tt: WebMessageTranslator): string {
  switch (status) {
    case 'generating':
      return tt('conv.outline.assistantGenerating')
    case 'failed':
      return tt('conv.turnFailed.label')
    default:
      return tt('conv.outline.assistantNoContent')
  }
}

/** AssistantTurn 顶层 tool.view 业务卡节点：通用 toolName + 入参摘要（零插件/工具名特判）。 */
function buildToolCardNode(
  turn: AssistantTurn,
  tool: ToolTrace,
  anchorId: string,
  parentHumanKey: string | undefined,
): OutlineCardNode {
  const summary = toolSummaryText(tool.toolName, tool.input)
  const label =
    summary !== ''
      ? truncateLabel(`${tool.toolName}：${summary}`, OUTLINE_SUMMARY_MAX_CHARS)
      : truncateLabel(tool.toolName, OUTLINE_SUMMARY_MAX_CHARS)
  return {
    kind: 'card',
    key: `outline:card:${turn.key}:${tool.key}`,
    entryId: anchorId,
    cardId: tool.key,
    label,
    searchText: summary !== '' ? `${tool.toolName}\n${summary}` : tool.toolName,
    ...(tool.status !== 'unknown' ? { status: tool.status } : {}),
    ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
  }
}

/**
 * plugin-card 通用诚实摘要：优先 entry 的 helm.input 数据文本（与人类提问同源归一化），
 * 兜底稳定契约标识（entry kind）；绝不读取插件私有 React 渲染内容。
 */
export function summarizePluginCardEntry(entry: ConversationEntry, t?: WebMessageTranslator): { label: string; searchText: string } {
  const tt = t ?? englishWebTranslator
  if (entry.kind === 'helm.input') {
    const data = parseHelmInputData(entry.data)
    if (data !== undefined && data.text.trim() !== '') {
      return {
        label: summarizeOutlineText(data.text, data.attachments?.length ?? 0, tt),
        searchText: data.text,
      }
    }
  }
  return { label: entry.kind, searchText: entry.kind }
}

function buildPluginCardNode(item: PluginCardItem, parentHumanKey: string | undefined, tt: WebMessageTranslator): OutlineCardNode {
  const { label, searchText } = summarizePluginCardEntry(item.entry, tt)
  return {
    kind: 'card',
    key: `outline:card:${item.key}`,
    entryId: item.entryId,
    label,
    searchText,
    ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
  }
}

/**
 * 助手回合智能合并（正文代表制）：
 * - 有 Markdown 标题：由标题节点代表本回合（首个标题通常与正文首行摘要重复，不重复发 assistant 摘要节点）；
 * - 无标题有正文：assistant 摘要节点（首行摘要，可搜全文）代表正文；
 * - 无正文有业务卡：卡片代表本回合，不产生空 assistant 节点；
 * - 无正文无卡片：保留诚实状态摘要节点（生成中/失败/无正文）。
 *
 * 子节点按段落在回合内的真实顺序输出（正文摘要位于首个文本段处，卡片位于各自段处），
 * step-group 内普通工具与 thinking 不进大纲（过程细节非导航目标）。
 */
function appendAssistantNodes(
  turn: AssistantTurn,
  parentHumanKey: string | undefined,
  failed: boolean,
  out: OutlineNode[],
  tt: WebMessageTranslator,
): void {
  const anchorId = turn.entryIds[0] ?? turn.key
  const textSegments: Array<{ kind: 'text'; key: string; text: string }> = []
  let firstTextSegIndex = -1
  for (let i = 0; i < turn.segments.length; i++) {
    const seg = turn.segments[i]!
    if (seg.kind === 'text') {
      if (firstTextSegIndex === -1) firstTextSegIndex = i
      textSegments.push(seg)
    }
  }
  const fullMarkdown = textSegments.map((seg) => seg.text).join('\n\n')
  const hasText = fullMarkdown.trim() !== ''
  const headings = hasText ? extractMarkdownHeadings(fullMarkdown) : []

  let bodyEmitted = false
  let cardEmitted = false
  let headingCursor = 0
  let accumulatedText = ''
  for (const seg of turn.segments) {
    if (seg.kind === 'text') {
      if (headings.length > 0) {
        // 保持标题节点与正文/业务卡在时间线中的真实顺序。用累计正文重新解析，
        // 保留跨 segment 的代码围栏状态，同时让 headingIndex 继续对应 DOM 顺序。
        accumulatedText = accumulatedText === '' ? seg.text : `${accumulatedText}\n\n${seg.text}`
        const parsed = extractMarkdownHeadings(accumulatedText)
        for (; headingCursor < parsed.length; headingCursor++) {
          const heading = parsed[headingCursor]!
          out.push({
            kind: 'heading',
            key: `outline:heading:${turn.key}:${headingCursor}`,
            entryId: anchorId,
            headingIndex: headingCursor,
            level: heading.level,
            text: heading.text,
            ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
          })
        }
      } else if (!bodyEmitted) {
        bodyEmitted = true
        out.push({
          kind: 'assistant',
          key: `outline:assistant:${turn.key}`,
          entryId: anchorId,
          label: summarizeOutlineText(fullMarkdown, 0, tt),
          fullText: fullMarkdown,
          live: turn.live,
          ...(turn.settledAt !== undefined || turn.startedAt !== undefined
            ? { createdAt: turn.settledAt ?? turn.startedAt }
            : {}),
          ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
        })
      }
      continue
    }
    if (seg.kind === 'tool' && seg.tool.toolView !== undefined) {
      cardEmitted = true
      out.push(buildToolCardNode(turn, seg.tool, anchorId, parentHumanKey))
    }
  }
  if (!bodyEmitted && headings.length === 0 && !cardEmitted) {
    const status: OutlineAssistantStatus = turn.live ? 'generating' : failed ? 'failed' : 'no-content'
    out.push({
      kind: 'assistant',
      key: `outline:assistant:${turn.key}`,
      entryId: anchorId,
      label: assistantStatusLabel(status, tt),
      fullText: '',
      live: turn.live,
      status,
      ...(turn.settledAt !== undefined || turn.startedAt !== undefined
        ? { createdAt: turn.settledAt ?? turn.startedAt }
        : {}),
      ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
    })
  }
}

export interface BuildConversationOutlineOptions {
  /** 会话最新回合失败（ConversationSummary.status === 'error'）：最新无正文回合状态摘要为「本回合失败」。 */
  latestAssistantTurnFailed?: boolean
}

/**
 * 从归一化 `TimelineItem[]` 构建完整会话大纲节点列表。
 */
export function buildConversationOutline(
  items: ReadonlyArray<TimelineItem>,
  options: BuildConversationOutlineOptions = {},
  t?: WebMessageTranslator,
): OutlineNode[] {
  const tt = t ?? englishWebTranslator
  const nodes: OutlineNode[] = []
  let humanTurnCount = 0
  let lastHumanKey: string | undefined

  // 失败标注只作用于最新 assistant 回合（与 TurnErrorNotice 同一权威状态源）
  let lastAssistantIndex = -1
  if (options.latestAssistantTurnFailed === true) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'assistant') {
        lastAssistantIndex = i
        break
      }
    }
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    if (item.kind === 'human') {
      humanTurnCount += 1
      const node = buildHumanNode(item, humanTurnCount, tt)
      lastHumanKey = node.key
      nodes.push(node)
      continue
    }
    if (item.kind === 'assistant') {
      appendAssistantNodes(item, lastHumanKey, index === lastAssistantIndex, nodes, tt)
      continue
    }
    if (item.kind === 'plugin-card') {
      nodes.push(buildPluginCardNode(item, lastHumanKey, tt))
      continue
    }
    if (item.kind === 'divider') {
      lastHumanKey = undefined
      nodes.push(buildDividerNode(item, tt))
    }
  }
  return nodes
}

/**
 * 统计会话大纲中的人类提问轮数（用于顶栏胶囊计数展示）。
 */
export function countOutlineTurns(nodes: ReadonlyArray<OutlineNode>): number {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'human') count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// 大纲过滤与滚动激活态计算
// ---------------------------------------------------------------------------

export type OutlineFilterMode = 'dialogue' | 'questions' | 'all'

export interface FilterOutlineOptions {
  /** 搜索关键词（大小写不敏感；匹配人类/助手全文、轮次号 `#N`、Markdown 标题与卡片可搜索文本）。 */
  query?: string
  /**
   * 过滤模式（默认 `'all'`；大纲面板在启用切换栏时默认传入 `'dialogue'`）：
   * - `'dialogue'`：保留人工发起的 `human`（`origin === 'human'`）、`assistant`、`heading` 与 `divider`，
   *   过滤业务卡 `card` 及 `agent`/`trigger` 发起的输入；
   * - `'questions'`：仅保留人工发起的 `human`（`origin === 'human'`）与 `divider`；
   * - `'all'`：保留全部节点。
   */
  mode?: OutlineFilterMode
}

function matchesOutlineFilterMode(node: OutlineNode, mode: OutlineFilterMode): boolean {
  if (mode === 'all') return true
  if (mode === 'questions') {
    return (node.kind === 'human' && node.origin === 'human') || node.kind === 'divider'
  }
  if (node.kind === 'human') return node.origin === 'human'
  return node.kind === 'assistant' || node.kind === 'heading' || node.kind === 'divider'
}

/**
 * 过滤大纲节点：
 * - 先按 `mode`（`'dialogue' | 'questions' | 'all'`）过滤；
 * - 有搜索词时：
 *   1. `human` 节点匹配 `label`、`fullText` 或 `#turnIndex`；
 *   2. `assistant` 节点匹配 `label` 或 `fullText`；
 *   3. `heading` 节点匹配 `text`；`card` 节点匹配 `label` 或 `searchText`；
 *   4. 任一子节点命中时，其 `parentHumanKey` 对应的人类提问节点一并保留，确保树形归属清晰；
 *   5. `divider` 节点在搜索词匹配其 label 时保留。
 */
export function filterOutlineNodes(
  nodes: ReadonlyArray<OutlineNode>,
  options: FilterOutlineOptions = {},
): OutlineNode[] {
  const mode = options.mode ?? 'all'
  const base = mode === 'all' ? [...nodes] : nodes.filter((node) => matchesOutlineFilterMode(node, mode))
  const q = (options.query ?? '').trim().toLowerCase()
  if (q === '') return base

  const matchedKeys = new Set<string>()
  for (const node of base) {
    let matched = false
    if (node.kind === 'human') {
      const turnTag = `#${node.turnIndex}`
      matched =
        node.label.toLowerCase().includes(q) ||
        node.fullText.toLowerCase().includes(q) ||
        turnTag === q
    } else if (node.kind === 'assistant') {
      matched = node.label.toLowerCase().includes(q) || node.fullText.toLowerCase().includes(q)
    } else if (node.kind === 'heading') {
      matched = node.text.toLowerCase().includes(q)
    } else if (node.kind === 'card') {
      matched = node.label.toLowerCase().includes(q) || node.searchText.toLowerCase().includes(q)
    } else {
      matched = node.label.toLowerCase().includes(q)
    }
    if (matched) {
      matchedKeys.add(node.key)
      if (node.kind !== 'human' && node.kind !== 'divider' && node.parentHumanKey !== undefined) {
        matchedKeys.add(node.parentHumanKey)
      }
    }
  }

  return base.filter((node) => matchedKeys.has(node.key))
}

/**
 * 根据时间线滚动容器中已观测到的 `entryId` 集合（已滑过视口顶部基准线的最后一项），
 * 解析当前处于阅读焦点的激活 `entryId`。
 *
 * 输入 `anchorOffsets` 为按文档顺序排列的 `{ entryId, top }`（`top` 为相对于滚动容器可视区顶部的偏移 px）：
 * - 取最后一个 `top <= thresholdPx` 的锚点；
 * - 若所有锚点均在基准线下方（刚打开或在最顶部），取第一个锚点。
 */
export function resolveActiveOutlineEntryId(
  anchorOffsets: ReadonlyArray<{ entryId: string; top: number }>,
  thresholdPx = 96,
): string | undefined {
  if (anchorOffsets.length === 0) return undefined
  let active = anchorOffsets[0]!.entryId
  for (const item of anchorOffsets) {
    if (item.top <= thresholdPx) {
      active = item.entryId
    } else {
      break
    }
  }
  return active
}
