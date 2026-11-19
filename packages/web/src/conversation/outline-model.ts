/**
 * Conversation outline pure-function layer (zero React/DOM deps, unit-testable directly).
 *
 * Responsibilities:
 * - Build a turn-level navigation outline from normalized `TimelineItem[]`:
 *   1. Human turn nodes (`human`): numbered in order (#1, #2...), carrying a first-line summary, full text (for search), time, and origin;
 *   2. Assistant turn nodes (`assistant`): smart merge — when Markdown headings exist they represent the turn;
 *      otherwise a first-line summary node when body text exists, or the business card when only cards exist;
 *      with no text and no card an honest status summary remains (generating/failed/no content);
 *   3. Markdown heading nodes (`heading`): `# ~ ###` headings extracted from assistant body text (code fences skipped);
 *   4. Business card nodes (`card`): AssistantTurn top-level cards matched by plugin tool.view (generic
 *      toolName + input summary) plus timeline.renderer plugin-card entries (generic
 *      helmx.input text summary); ordinary tools and thinking inside step-groups never enter the outline;
 *   5. Context divider nodes (`divider`): reset (`/reset`) or compaction (`/compact`) boundaries;
 * - Keyword filtering: matches human/assistant full text, headings, and card searchable text; a hit on a child
 *   automatically keeps its parent human turn so the hierarchy stays contextual;
 * - Scroll-position activation: derives the currently-read outline item from the viewport-top baseline and anchor offsets.
 */

import type { ConversationEntry, InputOrigin } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import {
  parseHelmxInputData,
  toolSummaryText,
  type AssistantTurn,
  type DividerItem,
  type HumanInputItem,
  type PluginCardItem,
  type TimelineItem,
  type ToolTrace,
} from './timeline-model.js'

// ---------------------------------------------------------------------------
// Outline node types
// ---------------------------------------------------------------------------

export interface OutlineHumanNode {
  kind: 'human'
  /** Unique node key (React key and list location). */
  key: string
  /** `data-entry-id` of the corresponding Timeline wrapper element. */
  entryId: string
  /** Question turn number within the conversation (1-indexed). */
  turnIndex: number
  /** Compact one-line summary. */
  label: string
  /** Original full text (for search filtering and hover tooltips). */
  fullText: string
  origin: InputOrigin
  createdAt?: number
  queuedMode?: 'steer' | 'followUp'
  attachmentCount: number
}

/** Honest status summary when an assistant turn has neither body text nor business cards (no fabricated details). */
export type OutlineAssistantStatus = 'generating' | 'failed' | 'no-content'

export interface OutlineAssistantNode {
  kind: 'assistant'
  key: string
  /** `data-entry-id` of the owning assistant turn's Timeline wrapper (i.e. `turn.entryIds[0] ?? turn.key`). */
  entryId: string
  /** Compact one-line summary (body first line; fixed status copy for status nodes). */
  label: string
  /** Turn body full text (for search and tooltips); empty string for status nodes. */
  fullText: string
  /** true = in-flight (generating) turn. */
  live: boolean
  /** Status summary marker; omitted on summary nodes that have body text. */
  status?: OutlineAssistantStatus
  /** Turn time (settledAt ?? startedAt); omitted when not captured. */
  createdAt?: number
  /** Key of the nearest preceding human question node (kept as parent context when this node matches a search). */
  parentHumanKey?: string
}

export interface OutlineHeadingNode {
  kind: 'heading'
  key: string
  /** `data-entry-id` of the owning assistant turn's Timeline wrapper (i.e. `turn.entryIds[0] ?? turn.key`). */
  entryId: string
  /** Index of this Markdown heading within its assistant turn (0-indexed; combined with DOM queries it pinpoints the exact h1~h3). */
  headingIndex: number
  /** Heading level (1 | 2 | 3). */
  level: 1 | 2 | 3
  /** Heading text with inline formatting stripped. */
  text: string
  /** Key of the nearest preceding human question node (kept as parent context when a child heading matches). */
  parentHumanKey?: string
}

export interface OutlineDividerNode {
  kind: 'divider'
  key: string
  entryId: string
  divider: 'reset' | 'compaction'
  label: string
}

/** Business card node: an assistant turn's top-level tool.view card or a timeline.renderer plugin-card. */
export interface OutlineCardNode {
  kind: 'card'
  key: string
  /** Primary locate anchor: Timeline wrapper `data-entry-id` (the entryId for plugin-cards, the owning turn's anchor for tool.view cards). */
  entryId: string
  /** Secondary locate anchor: the tool.view card trace element's `data-outline-card-id` (i.e. tool.key); absent for plugin-cards. */
  cardId?: string
  /** One-line title (generic honest summary: toolName + input summary / helmx.input first line / stable contract identifier fallback). */
  label: string
  /** Searchable text (title + underlying text summary). */
  searchText: string
  /** Tool execution status of a tool.view card; omitted for plugin-cards. */
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

/** Build reusable outline heading nodes from a standalone Markdown document. */
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

/** Default max length of a one-line outline summary (shared by human questions, assistant bodies, card titles). */
const OUTLINE_SUMMARY_MAX_CHARS = 72
/** Max display length of a Markdown heading on one line. */
const HEADING_MAX_CHARS = 72

// ---------------------------------------------------------------------------
// Text summaries and Markdown heading extraction
// ---------------------------------------------------------------------------

/**
 * Strip lightweight inline Markdown (bold, italic, inline code, link text) to produce a clean one-line outline label.
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
 * Condense a multi-line body into a one-line outline label (shared by human inputs and assistant bodies):
 * take the first non-empty line, strip heading/quote/list prefixes and inline formatting; fall back to an attachment-count hint when the text is empty but attachments exist.
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
 * Extract `#` ~ `###` headings from Markdown text:
 * - strictly ignore comment lines inside ``` or ~~~ code fences (e.g. `# bash comment`);
 * - extract H1~H3 only (H4~H6 are too fine-grained and would add noise).
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
// Outline construction
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
// Assistant turn smart merge and business card nodes
// ---------------------------------------------------------------------------

/** Fixed copy for status nodes (honest labels from available data, no fabricated details). */
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

/** AssistantTurn top-level tool.view card node: generic toolName + input summary (zero plugin/tool-name special-casing). */
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
 * Generic honest plugin-card summary: prefer the entry's helmx.input data text (normalized from the same
 * source as human questions), fall back to the stable contract identifier (entry kind); never read plugin-private React content.
 */
export function summarizePluginCardEntry(entry: ConversationEntry, t?: WebMessageTranslator): { label: string; searchText: string } {
  const tt = t ?? englishWebTranslator
  if (entry.kind === 'helmx.input') {
    const data = parseHelmxInputData(entry.data)
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
 * Assistant turn smart merge (body-representation rules):
 * - Markdown headings present: heading nodes represent the turn (the first heading usually duplicates the body first line, so no extra assistant summary node);
 * - no headings but body text: an assistant summary node (first line, full text searchable) represents the body;
 * - no body but business cards: the cards represent the turn, no empty assistant node;
 * - neither body nor cards: keep an honest status summary node (generating/failed/no content).
 *
 * Children are emitted in the turn's real segment order (the body summary sits at the first text segment, cards at their own segments);
 * ordinary tools and thinking inside step-groups never enter the outline (process detail is not a navigation target).
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
        // Keep heading nodes in true timeline order with body/cards. Re-parse the accumulated
        // body so fence state carries across segments while headingIndex keeps matching DOM order.
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
  /** Latest turn failed (ConversationSummary.status === 'error'): the latest bodyless turn's status summary reads "This turn failed". */
  latestAssistantTurnFailed?: boolean
}

/**
 * Build the full conversation outline node list from normalized `TimelineItem[]`.
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

  // The failure marker applies only to the latest assistant turn (same authoritative source as TurnErrorNotice)
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
 * Count human question turns in the conversation outline (for the top-bar pill count).
 */
export function countOutlineTurns(nodes: ReadonlyArray<OutlineNode>): number {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'human') count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Outline filtering and scroll activation
// ---------------------------------------------------------------------------

export type OutlineFilterMode = 'dialogue' | 'questions' | 'all'

export interface FilterOutlineOptions {
  /** Search keyword (case-insensitive; matches human/assistant full text, turn numbers `#N`, Markdown headings, and card searchable text). */
  query?: string
  /**
   * Filter mode (default `'all'`; the outline panel passes `'dialogue'` by default when the toggle bar is on):
   * - `'dialogue'`: keep human-initiated `human` (`origin === 'human'`), `assistant`, `heading`, and `divider`,
   *   filtering out `card` nodes and `agent`/`trigger`-initiated inputs;
   * - `'questions'`: keep only human-initiated `human` (`origin === 'human'`) and `divider`;
   * - `'all'`: keep everything.
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
 * Filter outline nodes:
 * - first by `mode` (`'dialogue' | 'questions' | 'all'`);
 * - then, when a search term exists:
 *   1. `human` nodes match `label`, `fullText`, or `#turnIndex`;
 *   2. `assistant` nodes match `label` or `fullText`;
 *   3. `heading` nodes match `text`; `card` nodes match `label` or `searchText`;
 *   4. when any child matches, the human question node for its `parentHumanKey` is kept too so the tree ownership stays clear;
 *   5. `divider` nodes survive when the search term matches their label.
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
 * Resolve the active `entryId` at the reading focus from the observed `entryId` set in the timeline
 * scroll container (the last item whose top has passed the viewport-top baseline).
 *
 * `anchorOffsets` is a document-ordered array of `{ entryId, top }` (`top` is the offset in px from the scroll container's visible top):
 * - take the last anchor with `top <= thresholdPx`;
 * - if every anchor is below the baseline (just opened or at the very top), take the first anchor.
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
