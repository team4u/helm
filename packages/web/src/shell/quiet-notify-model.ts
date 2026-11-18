/**
 * Pure-function layer for background browser notifications settled
 * independently per root-conversation tree (zero React/DOM dependencies,
 * directly unit-testable).
 *
 * Data sources share the sidebar background in-flight ring's contract; no
 * verdict is re-implemented:
 * - Conversation five-state: working means the main-turn machine work is in
 *   flight; blocked means waiting for human input/approval — that is "waiting
 *   for you", not machine activity;
 * - Background in flight: summarizeConversationBackgroundActivity's
 *   per-conversation index (workbench panel badges with tone = 'accent', e.g.
 *   builtin:workflow's running background subagents and DSL runs, plus
 *   conversation contextUsage.compacting = true); when a plugin is disabled
 *   its panel contributions and docs naturally zero out;
 * - Unknown badge docs: while a needed per-conversation badge doc has not yet
 *   had its first load, global background facts are unknowable —
 *   badgeUnknown = true blocks any root tree from settling as "completed"
 *   (blocked notifications are not gated by this unknown and keep firing
 *   promptly on their own channel).
 *
 * Independent settlement per root-conversation tree:
 * - Every active/blocked conversation merges along parentConversationId to its
 *   highest surviving ancestor rootId (single-track model; no ownedBy filter,
 *   no hardcoded role names);
 * - Root trees are isolated from each other: tree A still running does not
 *   block tree B's completion notice, nor block blocked notices inside tree B
 *   or tree A itself;
 * - Completion notices honestly distinguish outcomes: no accumulated
 *   participant in error → "Helm conversation completed" (#id title); any
 *   participant in error → "Helm conversation finished" (#id title · with
 *   failures);
 * - Waiting notices: title "Helm is waiting for you", body deduplicated by
 *   root and honestly flagging failures, clicking jumps to the tree's most
 *   recently updated blocked conversation.
 */

import type { ConversationSummary } from '@helm/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { MAX_ANCESTRY_DEPTH } from '../conversation/ancestry-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'

/** Browser notification permission: the standard three states plus host-unsupported (happy-dom / old environments without Notification). */
export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

/** Instantaneous activity snapshot of one root tree (machine-active ∪ waiting-on-human). */
export interface RootTreeActivity {
  rootId: number
  /** ids of conversations currently machine-active in this tree (working, background accent badge, or context compacting). */
  activeConversationIds: ReadonlySet<number>
  /** ids of conversations currently blocked in this tree (waiting for human input/approval). */
  blockedConversationIds: ReadonlySet<number>
}

/** Global activity snapshot: state sets organized per root tree + the global badge-doc unknown gate. */
export interface ActivitySnapshot {
  /** Activity trees indexed by root conversation id (only trees with machine-active or blocked conversations). */
  trees: ReadonlyMap<number, RootTreeActivity>
  /** Badge-doc keys without a first load yet: global background facts are unknown; no tree may be declared completed. */
  pendingBadgeDocs: ReadonlySet<string>
  /** Whether any badge doc still awaits its first load. */
  badgeUnknown: boolean
}

/**
 * Derived-conversation merge: walk up parentConversationId to the "highest
 * currently existing" conversation — when a parent summary is missing (ancestor
 * deleted/unknown) stop at the current highest surviving node; cycles and
 * absurdly deep dirty data are truncated by the same defensive cap as
 * ancestry-model, MAX_ANCESTRY_DEPTH, guaranteeing finite termination and no
 * runaway recursion. Only a surviving representative is taken — missing ids
 * are not kept (a notification body cannot provide a title or jump target
 * for a non-existent conversation).
 */
export function resolveNotificationRootId(
  byId: ReadonlyMap<number, ConversationSummary>,
  conversationId: number,
): number {
  let currentId = conversationId
  const visited = new Set<number>([conversationId])
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const current = byId.get(currentId)
    if (current?.parentConversationId === undefined) break
    const parentId = current.parentConversationId
    if (visited.has(parentId)) break
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) break
    currentId = parentId
  }
  return currentId
}

/** Watermark key for a blocked conversation: any advance of stateChangeSeq or pendingAskCount counts as new/changed pending work. */
export function getBlockedWatermark(
  conversation: Pick<ConversationSummary, 'stateChangeSeq' | 'pendingAskCount'>,
): string {
  return `${conversation.stateChangeSeq}:${conversation.pendingAskCount}`
}

export function resolveActivitySnapshot(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  /** Badge-doc keys without a first load yet (discovered by the assembler; see use-quiet-notifier). */
  pendingBadgeDocs?: ReadonlySet<string>
}): ActivitySnapshot {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const trees = new Map<
    number,
    { rootId: number; activeConversationIds: Set<number>; blockedConversationIds: Set<number> }
  >()
  const ensureTree = (rootId: number) => {
    let tree = trees.get(rootId)
    if (tree === undefined) {
      tree = { rootId, activeConversationIds: new Set<number>(), blockedConversationIds: new Set<number>() }
      trees.set(rootId, tree)
    }
    return tree
  }
  for (const conversation of input.conversations) {
    // Background in-flight (accent badge or context compacting) outranks the five states: background work still running under a blocked/idle parent is machine activity.
    const active = conversation.status === 'working' || input.background.get(conversation.id)?.active === true
    const blocked = conversation.status === 'blocked'
    if (!active && !blocked) continue
    const rootId = resolveNotificationRootId(byId, conversation.id)
    const tree = ensureTree(rootId)
    if (active) tree.activeConversationIds.add(conversation.id)
    if (blocked) tree.blockedConversationIds.add(conversation.id)
  }
  const pendingBadgeDocs = input.pendingBadgeDocs ?? new Set<string>()
  return {
    trees,
    pendingBadgeDocs,
    badgeUnknown: pendingBadgeDocs.size > 0,
  }
}

/** Completion-notice title when no participant of the root tree is in error (English bridge value; the catalog key is shell.quiet.completedTitle). */
export const COMPLETED_NOTIFICATION_TITLE = 'Helm conversation completed'

/** Finish-notice title when any participant of the root tree is in error — never claims completion (English bridge value; shell.quiet.endedTitle). */
export const ENDED_NOTIFICATION_TITLE = 'Helm conversation finished'

/** Notice title for waiting on human input/approval (blocked) (English bridge value; shell.quiet.waitingTitle). */
export const WAITING_NOTIFICATION_TITLE = 'Helm is waiting for you'

/** Maximum root entries listed in a body; anything beyond folds into "{count} pending in total". */
const MAX_LISTED_CONVERSATIONS = 3

/** Notice content and click jump target. */
export interface QuietNotificationDraft {
  title: string
  body: string
  /** Conversation the notification click jumps straight to (null when no certain target). */
  primaryConversationId: number | null
}

/** Conversation entry inside a notice body (the "#id title" format shared with the conversation list and command palette). */
const conversationLabel = (conversation: ConversationSummary): string => `#${conversation.id} ${conversation.title}`

/** Merge a conversation list to roots, deduplicated (input must be surviving conversations; order is the notice's listing priority). */
function mergeToRootIds(
  byId: ReadonlyMap<number, ConversationSummary>,
  conversations: ReadonlyArray<ConversationSummary>,
): number[] {
  const rootIds: number[] = []
  const seen = new Set<number>()
  for (const conversation of conversations) {
    const rootId = resolveNotificationRootId(byId, conversation.id)
    if (seen.has(rootId)) continue
    seen.add(rootId)
    if (byId.has(rootId)) rootIds.push(rootId)
  }
  return rootIds
}

/**
 * Compose one root tree's completion-cycle notification (null when no
 * accumulated participants):
 * - Any accumulated participant (merged child conversations included) in error
 *   → "Helm conversation finished", body `#id title · with failures`;
 * - No error participants → "Helm conversation completed", body `#id title`;
 * - Jump to rootId while the root survives; if the root was deleted but child
 *   participants survive, jump to the surviving root; if the whole tree was
 *   deleted during the cycle the notice still stands but fabricates no title —
 *   primary is null.
 */
export function composeTreeCompletionNotification(input: {
  rootId: number
  /** ids of conversations that accumulated machine activity this cycle (spawned children included). */
  accumulatedConversationIds: ReadonlySet<number>
  conversations: ReadonlyArray<ConversationSummary>
  /** Locale translator for title/body copy; English bridge when omitted (not-yet-migrated callers). */
  t?: WebMessageTranslator
}): QuietNotificationDraft | null {
  const t = input.t ?? englishWebTranslator
  if (input.accumulatedConversationIds.size === 0) return null
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const accumulated = [...input.accumulatedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
  const hasFailure = accumulated.some((conversation) => conversation.status === 'error')
  const title = hasFailure ? t('shell.quiet.endedTitle') : t('shell.quiet.completedTitle')

  const directRoot = byId.get(input.rootId)
  const survivingRootId =
    directRoot !== undefined
      ? directRoot.id
      : accumulated.length > 0
        ? resolveNotificationRootId(byId, accumulated[0]!.id)
        : undefined
  const rootConv = survivingRootId !== undefined ? byId.get(survivingRootId) : undefined

  if (rootConv === undefined) {
    return {
      title,
      body: hasFailure ? t('shell.quiet.finishedWithFailures') : t('shell.quiet.finishedBody'),
      primaryConversationId: null,
    }
  }
  const parts = [conversationLabel(rootConv)]
  if (hasFailure) parts.push(t('shell.quiet.hasFailures'))
  return {
    title,
    body: parts.join(' · '),
    primaryConversationId: rootConv.id,
  }
}

/**
 * Compose one root tree's waiting-for-human (blocked) notification:
 * - null when no blocked conversation survives;
 * - title fixed to the waiting title ("Helm is waiting for you");
 * - body deduplicated by root (multiple blocked children listed once), and
 *   honestly flagging failures when any accumulated participant is in error;
 * - primaryConversationId is the tree's most recently updated blocked
 *   conversation (straight to the ask/approval spot).
 */
export function composeTreeBlockedNotification(input: {
  rootId: number
  /** ids of conversations currently blocked in this tree. */
  blockedConversationIds: ReadonlySet<number>
  /** Optional: this tree's accumulated participant ids this cycle (for honest failure detection). */
  accumulatedConversationIds?: ReadonlySet<number>
  conversations: ReadonlyArray<ConversationSummary>
  /** Locale translator for title/body copy; English bridge when omitted (not-yet-migrated callers). */
  t?: WebMessageTranslator
}): QuietNotificationDraft | null {
  const t = input.t ?? englishWebTranslator
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as [number, ConversationSummary]),
  )
  const blocked = [...input.blockedConversationIds]
    .map((id) => byId.get(id))
    .filter((conversation): conversation is ConversationSummary => conversation !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
  if (blocked.length === 0) return null

  const hasFailure = [...(input.accumulatedConversationIds ?? [])]
    .map((id) => byId.get(id))
    .some((conversation) => conversation?.status === 'error')

  const rootIds = mergeToRootIds(byId, blocked)
  const parts = rootIds.slice(0, MAX_LISTED_CONVERSATIONS).map((id) => conversationLabel(byId.get(id)!))
  if (rootIds.length > parts.length) parts.push(t('shell.quiet.totalPending', { count: rootIds.length }))
  if (hasFailure) parts.push(t('shell.quiet.hasFailures'))
  return {
    title: t('shell.quiet.waitingTitle'),
    body: t('shell.quiet.pendingIntro', { list: parts.join(' · ') }),
    primaryConversationId: blocked[0]!.id,
  }
}

/**
 * Delivery gating at the trigger instant (re-verified live per item; no cached trust):
 * - Authenticated, preference enabled, browser notification permission granted, SSE connection healthy;
 * - The page is NOT actively foregrounded (!isPageActive(), i.e. hidden or unfocused): no noise while the user is watching.
 */
export function shouldDeliverQuietNotification(input: {
  authenticated: boolean
  preferenceEnabled: boolean
  permission: BrowserNotificationPermission
  connected: boolean
  pageActive: boolean
}): boolean {
  if (!input.authenticated || !input.preferenceEnabled || input.permission !== 'granted' || !input.connected) return false
  return !input.pageActive
}
