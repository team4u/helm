/**
 * Pure-function layer for sidebar "conversation background in-flight" state
 * (zero React/DOM dependencies, directly unit-testable).
 *
 * Data sources:
 * 1. The generic workbench.panel badge contract — panels among the enabled
 *    plugins' groupedUi.workbenchPanels that declare badge.byConversationField;
 *    their public docs provide a per-conversation index of
 *    { count, tone?, footerText? } (resolved by resolveWorkbenchPanelBadge).
 * 2. The conversation context-compaction state —
 *    conversation.contextUsage?.compacting === true (an async kernel compaction
 *    in flight; needs no extra plugin doc and merges straight into the same
 *    in-flight index and the "Compacting context" summary).
 * This layer knows no plugin IDs and adds no protocol fields; the pure
 * functions only derive. On-demand badge-doc loading is done by the Sidebar
 * effect via store.ensurePluginDoc (the pure functions have zero side effects).
 *
 * In-flight verdict (minimal and strict, relying only on contract-native
 * fields, never parsing arbitrary plugin copy):
 * - Only per-conversation indexes (byConversationField) participate: global
 *   countField/toneField badges cannot be attributed to a specific
 *   conversation — lighting up any row would mislead;
 * - An entry with tone === 'accent' is in flight: builtin:workflow's
 *   `run-badges` sets accent when running > 0 (footerText like "2 Running").
 *   tone = 'neutral' (historical counts) and tone = 'warn' (e.g. background
 *   failure summaries) never light the in-flight ring — counts and failures
 *   are already visible as workbench badges; not in flight means do not
 *   pretend to be;
 * - count never participates in the verdict (it includes all history, not
 *   just in-flight work);
 * - footerText and "Compacting context" enter the tooltip summary verbatim
 *   (deduplicated, joined with " · "); string meanings are never parsed.
 */

import type { ConversationSummary, WorkbenchPanelSpec } from '@helm/protocol/browser'
import type { QualifiedUiSpec } from '../lib/types.js'
import { matchesUiScope } from '../lib/types.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { resolveWorkbenchPanelBadge } from '../conversation/workbench-model.js'
import { AGENT_SUB_LIST_PREVIEW, conversationStatusDotClass, conversationStatusTooltip } from './sidebar-model.js'

/** Separator for summary fragments (matching the workbench footer join style). */
const SUMMARY_SEPARATOR = ' · '

// COMPACTING_SUMMARY was a constant; the copy now lives in the message catalog ('shell.background.compacting')

/** One conversation's background in-flight summary (aggregated from hit panels' per-conversation badges and the compaction state). */
export interface ConversationBackgroundActivity {
  /** A background task is in flight (a hit panel's per-conversation badge tone = 'accent', or contextUsage.compacting = true). */
  active: boolean
  /** Run summary copy: hit badges' footerText and the compaction copy, deduplicated and joined (may be empty). */
  summary: string
}

/** Per-conversation background in-flight index (key: conversationId; sidebar rows look up by id). */
export type ConversationBackgroundIndex = ReadonlyMap<number, ConversationBackgroundActivity>

/** Merge a non-empty, not-yet-seen summary fragment into the conversation's background entry. */
function appendBackgroundSummary(
  result: Map<number, ConversationBackgroundActivity>,
  conversationId: number,
  fragment: string,
): void {
  const text = fragment.trim()
  const prev = result.get(conversationId)
  const parts = prev === undefined || prev.summary === '' ? [] : prev.summary.split(SUMMARY_SEPARATOR)
  if (text !== '' && !parts.includes(text)) parts.push(text)
  result.set(conversationId, { active: true, summary: parts.join(SUMMARY_SEPARATOR) })
}

/**
 * Summarize per-conversation background in-flight activity:
 * - Consume enabled panels declaring badge.byConversationField (the
 *   conversation must match panel.spec.scope), marking tone = 'accent' entries
 *   in flight and merging their footerText;
 * - Check each conversation's contextUsage?.compacting === true, marking it in
 *   flight and merging the "Compacting context" copy;
 * - When a plugin is disabled its UI contributions and docs vanish from the
 *   store, so panel sources naturally zero out.
 */
export function summarizeConversationBackgroundActivity(input: {
  panels: ReadonlyArray<QualifiedUiSpec<WorkbenchPanelSpec>>
  conversations: ReadonlyArray<ConversationSummary>
  pluginDocs: Record<string, unknown>
  /** Locale translator for the compaction summary; English bridge when omitted (not-yet-migrated callers). */
  t?: WebMessageTranslator
}): Map<number, ConversationBackgroundActivity> {
  const t = input.t ?? englishWebTranslator
  const result = new Map<number, ConversationBackgroundActivity>()
  const perConversationPanels = input.panels.filter(
    (panel) => panel.spec.badge?.byConversationField !== undefined,
  )
  for (const panel of perConversationPanels) {
    const badge = panel.spec.badge
    if (badge === undefined) continue
    const docValue = input.pluginDocs[`${panel.pluginId}/${badge.doc}`]
    for (const conversation of input.conversations) {
      if (!matchesUiScope(conversation, panel.spec.scope)) continue
      const resolved = resolveWorkbenchPanelBadge(badge, docValue, conversation.id)
      if (resolved.tone !== 'accent') continue
      appendBackgroundSummary(result, conversation.id, resolved.footerText ?? '')
    }
  }
  for (const conversation of input.conversations) {
    if (conversation.contextUsage?.compacting === true) {
      appendBackgroundSummary(result, conversation.id, t('shell.background.compacting'))
    }
  }
  return result
}

/** Badge-doc references the sidebar must load on demand (deduplicated; the Sidebar effect calls ensurePluginDoc). */
export interface BackgroundBadgeDocRef {
  pluginId: string
  doc: string
}

/**
 * Collect the badge docs the sidebar should load on demand: only panels that
 * declare byConversationField AND whose scope matches at least one conversation
 * (global-badge docs drive no per-conversation in-flight state, so skip them).
 */
export function collectBackgroundBadgeDocs(
  panels: ReadonlyArray<QualifiedUiSpec<WorkbenchPanelSpec>>,
  conversations: ReadonlyArray<ConversationSummary>,
): BackgroundBadgeDocRef[] {
  const seen = new Set<string>()
  const refs: BackgroundBadgeDocRef[] = []
  for (const panel of panels) {
    const badge = panel.spec.badge
    if (badge?.byConversationField === undefined) continue
    if (!conversations.some((conversation) => matchesUiScope(conversation, panel.spec.scope))) continue
    const key = `${panel.pluginId}/${badge.doc}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ pluginId: panel.pluginId, doc: badge.doc })
  }
  return refs
}

/**
 * Collapsed-standing aggregate indicator for an agent row:
 * - representative: the conversation with the highest base-status priority
 *   under the agent (error > blocked > working > done > idle; ties keep the
 *   list head — the pinned/latest-first order; an all-idle list keeps its
 *   head, compatible with the previous "watch primaryConversation" behavior) —
 *   this surfaces non-primary conversations' unread done dots and background
 *   in-flight state;
 * - backgroundActive / backgroundSummary: the aggregate background in-flight
 *   state of any conversation under the agent (footerText deduplicated and
 *   joined). Light rendering is adjudicated by resolveStatusLight's single
 *   light: when the representative is working/blocked/error the status light
 *   is exclusive (the standing's background ring is hidden); when it is
 *   idle/done it yields to the single hollow background ring; the expanded
 *   state is presented by each child row, never duplicated on the standing row.
 */
export interface StandingStatusIndicator {
  representative: ConversationSummary
  backgroundActive: boolean
  backgroundSummary: string
}

/** Base-status aggregate priority: error > blocked > working > done > idle (idle does not compete). */
const STANDING_STATUS_RANK: Record<string, number> = {
  error: 4,
  blocked: 3,
  working: 2,
  done: 1,
}

export function resolveStandingStatusIndicator(
  conversations: ReadonlyArray<ConversationSummary>,
  background: ConversationBackgroundIndex,
): StandingStatusIndicator | null {
  if (conversations.length === 0) return null
  const first = conversations[0]
  if (first === undefined) return null
  let representative = first
  let top = STANDING_STATUS_RANK[representative.status] ?? 0
  for (let i = 1; i < conversations.length; i++) {
    const candidate = conversations[i]
    if (candidate === undefined) continue
    const rank = STANDING_STATUS_RANK[candidate.status] ?? 0
    if (rank > top) {
      representative = candidate
      top = rank
    }
  }
  let backgroundActive = false
  const parts: string[] = []
  for (const conversation of conversations) {
    const activity = background.get(conversation.id)
    if (activity?.active !== true) continue
    backgroundActive = true
    if (activity.summary !== '' && !parts.includes(activity.summary)) parts.push(activity.summary)
  }
  return { representative, backgroundActive, backgroundSummary: parts.join(SUMMARY_SEPARATOR) }
}

/**
 * Conversation in-flight verdict (for collapsed-preview retention): the main
 * turn is working/blocked, or background work is in flight (badge tone =
 * accent or contextUsage.compacting = true). Reuses this model's background
 * index instead of re-implementing the background-activity verdict.
 */
export function isConversationInFlight(
  conv: Pick<ConversationSummary, 'id' | 'status'>,
  background: ConversationBackgroundIndex,
): boolean {
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    background.get(conv.id)?.active === true
  )
}

/** Collapsed-preview slice result for an agent sub-list. */
export interface AgentSubListPreview {
  /** Conversations to render in the collapsed state (original order kept, no re-sorting). */
  visible: ConversationSummary[]
  /** Number of conversations hidden by collapsing (drives the "show more" button). */
  hiddenCount: number
}

/**
 * Collapsed-preview slice for an agent sub-list: by default only the first
 * AGENT_SUB_LIST_PREVIEW rows render, but three row classes never disappear
 * behind the fold — currently active conversations (the union of activeId and
 * activeIds, including split-view doubles), working/blocked conversations, and
 * background in-flight conversations (in-flight work must be visible; burying
 * it behind "show more" would mislead users into thinking things are idle).
 * showAll renders everything. Pure function, shared by components and tests.
 */
export function resolveAgentSubListPreview(input: {
  conversations: ReadonlyArray<ConversationSummary>
  showAll: boolean
  /** Currently active conversation id (single-screen or focused-panel target; null when none). */
  activeId: number | null
  /** Set of multi-active conversation ids in split view (all main+split conversations are protected from fold-hiding). */
  activeIds?: ReadonlySet<number>
  background: ConversationBackgroundIndex
}): AgentSubListPreview {
  const { conversations, showAll, activeId, activeIds, background } = input
  const activeSet = new Set<number>(activeIds)
  if (activeId !== null) activeSet.add(activeId)
  const list = [...conversations]
  if (
    showAll ||
    list.length <= AGENT_SUB_LIST_PREVIEW ||
    list.some((conv, index) => index >= AGENT_SUB_LIST_PREVIEW && activeSet.has(conv.id))
  ) {
    return { visible: list, hiddenCount: 0 }
  }
  const visible = list.filter(
    (conv, index) =>
      index < AGENT_SUB_LIST_PREVIEW ||
      activeSet.has(conv.id) ||
      isConversationInFlight(conv, background),
  )
  return { visible, hiddenCount: list.length - visible.length }
}

/** Full class name of the background in-flight hollow ring (shares the status-dot base class). */
const BACKGROUND_DOT_CLASS = 'status-dot status-dot-background'

/** Single-light rendering verdict: base status dot OR background hollow ring, never a second light. */
export interface StatusLight {
  /** Full class name of the single light slot (status-dot prefix included); null = no light (idle with no background work). */
  dotClass: string | null
  /** Whether this light is the background hollow ring (only then does the tooltip append the background summary). */
  background: boolean
}

/**
 * Single-light priority (each sidebar conversation/agent standing row keeps
 * exactly one light slot):
 * 1. working / blocked / error: the main status light is exclusive; the
 *    background hollow ring never renders;
 * 2. idle / done with background work in flight on the row: render only the
 *    background hollow ring (idle's no-light and done's green dot yield — the
 *    parent conversation is idle/finished while the background keeps running);
 * 3. No background work: keep the existing five-state display (done green dot,
 *    idle no light, the rest their own status dots).
 */
export function resolveStatusLight(
  status: ConversationSummary['status'],
  backgroundActive: boolean,
): StatusLight {
  const base = conversationStatusDotClass(status)
  if (status === 'working' || status === 'blocked' || status === 'error') {
    return { dotClass: base, background: false }
  }
  if (backgroundActive) return { dotClass: BACKGROUND_DOT_CLASS, background: true }
  return { dotClass: base, background: false }
}

/**
 * Single-light hover tooltip: the main status light (working/blocked/error)
 * states only the main-turn diagnosis (doing/lastError) without appending the
 * background summary, so it does not distract from the active main turn; only
 * when the light is the background hollow ring (idle/done yielded) does the
 * base status copy get the background run summary appended, making explicit
 * that the parent conversation is idle/finished while background work keeps
 * running. With nothing in flight the copy matches the existing text exactly.
 */
export function backgroundAwareStatusTooltip(input: {
  status: ConversationSummary['status']
  doing?: string
  lastError?: string
  backgroundActive: boolean
  backgroundSummary?: string
  /** Locale translator for the suffix copy; English bridge when omitted (not-yet-migrated callers). */
  t?: WebMessageTranslator
}): string {
  const t = input.t ?? englishWebTranslator
  const base = conversationStatusTooltip(input.status, input.doing, input.lastError)
  const light = resolveStatusLight(input.status, input.backgroundActive)
  if (!light.background) return base
  const summary = input.backgroundSummary?.trim() ?? ''
  return summary === ''
    ? t('shell.background.tooltipRunning', { base })
    : t('shell.background.tooltipWithSummary', { base, summary })
}
