/**
 * 会话大纲（Outline）纯函数层（零 React/DOM 依赖，单测直测）。
 *
 * 职责：
 * - 从已归一化的 `TimelineItem[]` 构建会话结构化导航大纲：
 *   1. 人类回合节点（`human`）：按顺序编号（#1, #2...），提取首行摘要、全文（供搜索）、时间与来源；
 *   2. 助手回合标题节点（`heading`）：从已完成/进行中助手回复的 Markdown 正文中提取 `# ~ ###` 标题（自动跳过代码块围栏）；
 *   3. 上下文分割线节点（`divider`）：重置（`/reset`）或精简（`/compact`）边界；
 * - 支持关键词过滤：匹配人类提问全文或助手标题文本；若命中某助手标题，自动保留其所属的人类回合父节点以维持上下文层级；
 * - 支持滚动位置激活态计算：根据可视区顶部基准线与各锚点元素偏移量，推导当前阅读所处的激活大纲项。
 */

import type { InputOrigin } from '@helm/protocol'
import type { AssistantTurn, DividerItem, HumanInputItem, TimelineItem } from './timeline-model.js'

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

export type OutlineNode = OutlineHumanNode | OutlineHeadingNode | OutlineDividerNode

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

/** 人类提问单行摘要默认最大长度。 */
const HUMAN_SUMMARY_MAX_CHARS = 72
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
 * 将人类输入多行文本浓缩为单行大纲标签：
 * 取首个非空行并清理行内标记；若文本为空但有附件，回退为附件数量提示。
 */
export function summarizeHumanOutlineText(text: string, attachmentCount = 0): string {
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const cleaned = stripInlineMarkdown(rawLine.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, ''))
    if (cleaned !== '') {
      return truncateLabel(cleaned, HUMAN_SUMMARY_MAX_CHARS)
    }
  }
  if (attachmentCount > 0) {
    return `[附件 ×${attachmentCount}]`
  }
  return '（空消息）'
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

function buildHumanNode(item: HumanInputItem, turnIndex: number): OutlineHumanNode {
  const attachmentCount = item.attachments?.length ?? 0
  return {
    kind: 'human',
    key: `outline:human:${item.key}`,
    entryId: item.entryId,
    turnIndex,
    label: summarizeHumanOutlineText(item.text, attachmentCount),
    fullText: item.text,
    origin: item.origin,
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.queuedMode !== undefined ? { queuedMode: item.queuedMode } : {}),
    attachmentCount,
  }
}

function buildDividerNode(item: DividerItem): OutlineDividerNode {
  return {
    kind: 'divider',
    key: `outline:divider:${item.key}`,
    entryId: item.entryId,
    divider: item.divider,
    label: item.divider === 'reset' ? '上下文已重置' : '上下文已精简',
  }
}

function appendAssistantHeadings(
  turn: AssistantTurn,
  parentHumanKey: string | undefined,
  out: OutlineNode[],
): void {
  const anchorId = turn.entryIds[0] ?? turn.key
  const fullMarkdown = turn.segments
    .filter((seg): seg is { kind: 'text'; key: string; text: string } => seg.kind === 'text')
    .map((seg) => seg.text)
    .join('\n\n')
  if (fullMarkdown === '') return

  const headings = extractMarkdownHeadings(fullMarkdown)
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!
    out.push({
      kind: 'heading',
      key: `outline:heading:${turn.key}:${i}`,
      entryId: anchorId,
      headingIndex: i,
      level: h.level,
      text: h.text,
      ...(parentHumanKey !== undefined ? { parentHumanKey } : {}),
    })
  }
}

/**
 * 从归一化 `TimelineItem[]` 构建完整会话大纲节点列表。
 */
export function buildConversationOutline(items: ReadonlyArray<TimelineItem>): OutlineNode[] {
  const nodes: OutlineNode[] = []
  let humanTurnCount = 0
  let lastHumanKey: string | undefined

  for (const item of items) {
    if (item.kind === 'human') {
      humanTurnCount += 1
      const node = buildHumanNode(item, humanTurnCount)
      lastHumanKey = node.key
      nodes.push(node)
      continue
    }
    if (item.kind === 'assistant') {
      appendAssistantHeadings(item, lastHumanKey, nodes)
      continue
    }
    if (item.kind === 'divider') {
      lastHumanKey = undefined
      nodes.push(buildDividerNode(item))
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

export interface FilterOutlineOptions {
  /** 搜索关键词（大小写不敏感；匹配人类消息全文、轮次号 `#N` 或助手标题）。 */
  query?: string
  /** 是否包含助手回复中的 Markdown 标题（默认 true）。 */
  includeHeadings?: boolean
}

/**
 * 过滤大纲节点：
 * - `includeHeadings === false` 时仅保留 `human` 与 `divider`；
 * - 有搜索词时：
 *   1. `human` 节点匹配 `label`、`fullText` 或 `#turnIndex`；
 *   2. `heading` 节点匹配 `text`；当某个 `heading` 命中时，其所属 `parentHumanKey` 对应的人类提问节点一并保留，确保树形归属清晰；
 *   3. `divider` 节点在搜索词匹配其 label 时保留。
 */
export function filterOutlineNodes(
  nodes: ReadonlyArray<OutlineNode>,
  options: FilterOutlineOptions = {},
): OutlineNode[] {
  const includeHeadings = options.includeHeadings ?? true
  const base = includeHeadings ? nodes : nodes.filter((n) => n.kind !== 'heading')
  const q = (options.query ?? '').trim().toLowerCase()
  if (q === '') return [...base]

  const matchedKeys = new Set<string>()
  for (const node of base) {
    if (node.kind === 'human') {
      const turnTag = `#${node.turnIndex}`
      if (
        node.label.toLowerCase().includes(q) ||
        node.fullText.toLowerCase().includes(q) ||
        turnTag === q
      ) {
        matchedKeys.add(node.key)
      }
    } else if (node.kind === 'heading') {
      if (node.text.toLowerCase().includes(q)) {
        matchedKeys.add(node.key)
        if (node.parentHumanKey !== undefined) {
          matchedKeys.add(node.parentHumanKey)
        }
      }
    } else if (node.kind === 'divider') {
      if (node.label.toLowerCase().includes(q)) {
        matchedKeys.add(node.key)
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
