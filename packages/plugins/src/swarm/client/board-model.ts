/**
 * Pure domain models and lenient boundary parsers for `builtin:swarm` client
 * surfaces (zero React/DOM dependencies, Fast Refresh compliant).
 *
 * Data sources (all existing backend facts; this module adds no new state):
 * - public doc `index`: group summaries + worker pointers;
 * - public doc `board-badges`: per-conversation badge entries;
 * - session doc `board-view` (keyed by coordinatorConversationId): live board
 *   projection with headline, member live states, edges and recent posts;
 * - `board_status` / `board_read` action payloads for the explicit fallback.
 */
import type { TimelineRendererProps } from '@helm/protocol'
import type { SwarmIndexDoc } from './models.ts'

export type WorkerAccess = 'readwrite' | 'readonly'
export type WorkerIsolation = 'inherit' | 'worktree'
export type CollabGroupStatus = 'active' | 'closed'
export type BoardPostKind = 'brief' | 'handoff' | 'review' | 'comment' | 'blocker' | 'done' | 'stall'
export type MemberLiveState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'missing'

export interface CollabGroupSummary {
  id: string
  title: string
  coordinatorConversationId: number
  status: CollabGroupStatus
  coordinatorDetached?: boolean
  activeWorkerCount: number
  headSeq: number
  createdAt: number
  updatedAt: number
  closedAt?: number
}

export interface RetainedWorktreeInfo {
  memberName: string
  worktreeId: string
  branch: string
  path: string
  commitsAhead: number
}

export interface BoardChannelInfo {
  name: string
  topic?: string
  archived?: boolean
}

export interface GroupMemberState {
  name: string
  conversationId: number
  profileId: string
  access: WorkerAccess
  isolation: WorkerIsolation
  nodeId: string
  cwd: string
  worktreeId?: string
  channels: string[]
  lifecycle: 'active' | 'archived'
  readCursorSeq: number
  pendingWakeupSeq: number
  lastPostSeq?: number
  lastWakeTaskSeq?: number
  silentExitNudgeSeq?: number
  lastOutboundEdge?: { seq: number; to: string[]; kind: BoardPostKind }
  createdAt: number
  archivedAt?: number
}

export interface BoardMemberView extends GroupMemberState {
  liveState: MemberLiveState
  model?: string
}

export interface WorktreeHandoffSnapshot {
  worktreeId: string
  branch?: string
  commitsAhead?: number
  dirtyCount: number
  changedFilesPreview: string[]
}

export interface BoardPost {
  seq: number
  groupId: string
  channel: string
  from: string
  to: string[]
  resolvedTargets: string[]
  wake: boolean
  kind: BoardPostKind
  refs: number[]
  body: string
  worktreeSnapshot?: WorktreeHandoffSnapshot
  createdAt: number
}

export interface BoardEdgeSummary {
  from: string
  to: string
  count: number
  lastSeq: number
  lastKind: BoardPostKind
}

export interface BoardHeadline {
  text: string
  tone: 'info' | 'warn' | 'err' | 'ok'
  kind: 'normal' | 'stall' | 'blocker' | 'unmerged' | 'closed'
  targetMember?: string
  refSeq?: number
}

export interface BoardGroupView extends CollabGroupSummary {
  objective?: string
  channels: BoardChannelInfo[]
  retainedWorktrees?: RetainedWorktreeInfo[]
  closeSummary?: string
}

export interface BoardViewDoc {
  group: BoardGroupView
  headline: BoardHeadline
  members: BoardMemberView[]
  edges: BoardEdgeSummary[]
  posts: BoardPost[]
  activeWorkingMembers: string[]
}

export interface BoardBadgeItem {
  groupId: string
  coordinatorConversationId: number
  count: number
  tone: 'accent' | 'warn' | 'neutral'
  footerText?: string
}

export interface BoardBadgesDoc {
  byConversation?: Record<string, BoardBadgeItem>
}

export interface BoardReportReceiptMeta {
  renderer?: string
  groupId?: string
  fromSeq?: number
  toSeq?: number
  postCount?: number
  headline?: string
}

export interface BoardWakeupReceiptMeta {
  renderer?: string
  groupId?: string
  workerName?: string
  fromSeq?: number
  toSeq?: number
  postCount?: number
}

// 本地宽松对象守卫：client bundle 的共享外部依赖白名单（CLIENT_SHARED_EXTERNALS）不含
// @helm/protocol，浏览器侧不能运行时导入 protocol 的 isJsonObject，故保留等价私有实现。
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

// ---------------------------------------------------------------------------
// Lenient boundary parsers
// ---------------------------------------------------------------------------

export function parseGroups(doc: SwarmIndexDoc | undefined): CollabGroupSummary[] {
  if (!Array.isArray(doc?.groups)) return []
  const valid: CollabGroupSummary[] = []
  for (const raw of doc.groups) {
    if (!isPlainObject(raw)) continue
    if (typeof raw.id !== 'string' || raw.id === '') continue
    if (typeof raw.title !== 'string') continue
    if (!isPosInt(raw.coordinatorConversationId)) continue
    const status = raw.status === 'closed' ? 'closed' : raw.status === 'active' ? 'active' : undefined
    if (status === undefined) continue
    valid.push({
      id: raw.id,
      title: raw.title,
      coordinatorConversationId: raw.coordinatorConversationId,
      status,
      ...(raw.coordinatorDetached === true ? { coordinatorDetached: true } : {}),
      activeWorkerCount: isNonNegInt(raw.activeWorkerCount) ? raw.activeWorkerCount : 0,
      headSeq: isNonNegInt(raw.headSeq) ? raw.headSeq : 0,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      ...(typeof raw.closedAt === 'number' ? { closedAt: raw.closedAt } : {}),
    })
  }
  valid.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
  return valid
}

export function parseBoardBadges(doc: unknown): Record<string, BoardBadgeItem> {
  if (!isPlainObject(doc) || !isPlainObject(doc.byConversation)) return {}
  const out: Record<string, BoardBadgeItem> = {}
  for (const [convKey, raw] of Object.entries(doc.byConversation)) {
    if (!isPlainObject(raw)) continue
    if (typeof raw.groupId !== 'string' || raw.groupId === '') continue
    if (!isPosInt(raw.coordinatorConversationId)) continue
    const tone = raw.tone === 'warn' || raw.tone === 'accent' || raw.tone === 'neutral' ? raw.tone : 'neutral'
    out[convKey] = {
      groupId: raw.groupId,
      coordinatorConversationId: raw.coordinatorConversationId,
      count: isNonNegInt(raw.count) ? raw.count : 0,
      tone,
      ...(typeof raw.footerText === 'string' && raw.footerText !== '' ? { footerText: raw.footerText } : {}),
    }
  }
  return out
}

const VALID_POST_KINDS: ReadonlySet<string> = new Set([
  'brief',
  'handoff',
  'review',
  'comment',
  'blocker',
  'done',
  'stall',
])

const VALID_LIVE_STATES: ReadonlySet<string> = new Set([
  'idle',
  'working',
  'blocked',
  'done',
  'error',
  'missing',
])

const VALID_HEADLINE_TONES: ReadonlySet<string> = new Set(['info', 'ok', 'warn', 'err'])
const VALID_HEADLINE_KINDS: ReadonlySet<string> = new Set(['normal', 'stall', 'blocker', 'unmerged', 'closed'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isNonEmptyString)
}

function parseWorktreeSnapshot(snap: unknown): WorktreeHandoffSnapshot | undefined | 'invalid' {
  if (snap === undefined) return undefined
  if (!isPlainObject(snap) || !isNonEmptyString(snap.worktreeId)) return 'invalid'
  if (snap.branch !== undefined && typeof snap.branch !== 'string') return 'invalid'
  if (snap.commitsAhead !== undefined && !isNonNegInt(snap.commitsAhead)) return 'invalid'
  if (!isNonNegInt(snap.dirtyCount)) return 'invalid'
  if (!Array.isArray(snap.changedFilesPreview) || !snap.changedFilesPreview.every((f) => typeof f === 'string')) {
    return 'invalid'
  }
  return {
    worktreeId: snap.worktreeId,
    ...(snap.branch !== undefined ? { branch: snap.branch } : {}),
    ...(snap.commitsAhead !== undefined ? { commitsAhead: snap.commitsAhead } : {}),
    dirtyCount: snap.dirtyCount,
    changedFilesPreview: snap.changedFilesPreview,
  }
}

export function parseBoardPost(raw: unknown): BoardPost | undefined {
  if (!isPlainObject(raw)) return undefined
  if (!isPosInt(raw.seq)) return undefined
  if (!isNonEmptyString(raw.groupId)) return undefined
  if (!isNonEmptyString(raw.channel)) return undefined
  if (!isNonEmptyString(raw.from)) return undefined
  if (!isNonEmptyStringArray(raw.to)) return undefined
  if (!isNonEmptyStringArray(raw.resolvedTargets)) return undefined
  if (typeof raw.wake !== 'boolean') return undefined
  if (typeof raw.kind !== 'string' || !VALID_POST_KINDS.has(raw.kind)) return undefined
  if (!Array.isArray(raw.refs) || !raw.refs.every(isPosInt)) return undefined
  if (typeof raw.body !== 'string') return undefined
  if (!isFiniteNumber(raw.createdAt)) return undefined

  const worktreeSnapshot = parseWorktreeSnapshot(raw.worktreeSnapshot)
  if (worktreeSnapshot === 'invalid') return undefined

  return {
    seq: raw.seq,
    groupId: raw.groupId,
    channel: raw.channel,
    from: raw.from,
    to: raw.to,
    resolvedTargets: raw.resolvedTargets,
    wake: raw.wake,
    kind: raw.kind as BoardPostKind,
    refs: raw.refs,
    body: raw.body,
    ...(worktreeSnapshot !== undefined ? { worktreeSnapshot } : {}),
    createdAt: raw.createdAt,
  }
}

function parseGroupChannelsStrict(rawChannels: unknown): BoardChannelInfo[] | undefined {
  if (!Array.isArray(rawChannels) || rawChannels.length === 0) return undefined
  const out: BoardChannelInfo[] = []
  for (const c of rawChannels) {
    if (!isPlainObject(c) || !isNonEmptyString(c.name)) return undefined
    if (c.topic !== undefined && typeof c.topic !== 'string') return undefined
    if (c.archived !== undefined && typeof c.archived !== 'boolean') return undefined
    out.push({
      name: c.name,
      ...(c.topic !== undefined ? { topic: c.topic } : {}),
      ...(c.archived === true ? { archived: true } : {}),
    })
  }
  return out
}

function parseRetainedWorktreesStrict(rawList: unknown): RetainedWorktreeInfo[] | undefined | 'invalid' {
  if (rawList === undefined) return undefined
  if (!Array.isArray(rawList)) return 'invalid'
  const out: RetainedWorktreeInfo[] = []
  for (const w of rawList) {
    if (
      !isPlainObject(w) ||
      !isNonEmptyString(w.memberName) ||
      !isNonEmptyString(w.worktreeId) ||
      !isNonEmptyString(w.branch) ||
      !isNonEmptyString(w.path) ||
      !isNonNegInt(w.commitsAhead)
    ) {
      return 'invalid'
    }
    out.push({
      memberName: w.memberName,
      worktreeId: w.worktreeId,
      branch: w.branch,
      path: w.path,
      commitsAhead: w.commitsAhead,
    })
  }
  return out
}

function parseMemberOutboundEdge(rawEdge: unknown): GroupMemberState['lastOutboundEdge'] | undefined | 'invalid' {
  if (rawEdge === undefined) return undefined
  if (
    !isPlainObject(rawEdge) ||
    !isPosInt(rawEdge.seq) ||
    !isNonEmptyStringArray(rawEdge.to) ||
    typeof rawEdge.kind !== 'string' ||
    !VALID_POST_KINDS.has(rawEdge.kind)
  ) {
    return 'invalid'
  }
  return {
    seq: rawEdge.seq,
    to: rawEdge.to,
    kind: rawEdge.kind as BoardPostKind,
  }
}

function parseMemberViewStrict(m: unknown): BoardMemberView | undefined {
  if (!isPlainObject(m)) return undefined
  if (!isNonEmptyString(m.name) || !isPosInt(m.conversationId) || !isNonEmptyString(m.profileId)) return undefined
  if (m.access !== 'readwrite' && m.access !== 'readonly') return undefined
  if (m.isolation !== 'worktree' && m.isolation !== 'inherit') return undefined
  if (!isNonEmptyString(m.nodeId) || typeof m.cwd !== 'string') return undefined
  if (m.worktreeId !== undefined && typeof m.worktreeId !== 'string') return undefined
  if (!isNonEmptyStringArray(m.channels)) return undefined
  if (m.lifecycle !== 'active' && m.lifecycle !== 'archived') return undefined
  if (typeof m.liveState !== 'string' || !VALID_LIVE_STATES.has(m.liveState)) return undefined
  if (!isNonNegInt(m.readCursorSeq) || !isNonNegInt(m.pendingWakeupSeq)) return undefined
  if (m.lastPostSeq !== undefined && !isPosInt(m.lastPostSeq)) return undefined
  if (m.lastWakeTaskSeq !== undefined && !isPosInt(m.lastWakeTaskSeq)) return undefined
  if (m.silentExitNudgeSeq !== undefined && !isPosInt(m.silentExitNudgeSeq)) return undefined
  if (!isFiniteNumber(m.createdAt)) return undefined
  if (m.archivedAt !== undefined && !isFiniteNumber(m.archivedAt)) return undefined
  if (m.model !== undefined && typeof m.model !== 'string') return undefined
  const lastOutboundEdge = parseMemberOutboundEdge(m.lastOutboundEdge)
  if (lastOutboundEdge === 'invalid') return undefined

  return {
    name: m.name,
    conversationId: m.conversationId,
    profileId: m.profileId,
    access: m.access,
    isolation: m.isolation,
    nodeId: m.nodeId,
    cwd: m.cwd,
    ...(isNonEmptyString(m.worktreeId) ? { worktreeId: m.worktreeId } : {}),
    channels: m.channels,
    lifecycle: m.lifecycle,
    readCursorSeq: m.readCursorSeq,
    pendingWakeupSeq: m.pendingWakeupSeq,
    ...(m.lastPostSeq !== undefined ? { lastPostSeq: m.lastPostSeq } : {}),
    ...(m.lastWakeTaskSeq !== undefined ? { lastWakeTaskSeq: m.lastWakeTaskSeq } : {}),
    ...(m.silentExitNudgeSeq !== undefined ? { silentExitNudgeSeq: m.silentExitNudgeSeq } : {}),
    ...(lastOutboundEdge !== undefined ? { lastOutboundEdge } : {}),
    createdAt: m.createdAt,
    ...(m.archivedAt !== undefined ? { archivedAt: m.archivedAt } : {}),
    liveState: m.liveState as MemberLiveState,
    ...(isNonEmptyString(m.model) ? { model: m.model } : {}),
  }
}

export function parseBoardView(raw: unknown): BoardViewDoc | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.group) || !isPlainObject(raw.headline)) return undefined
  const g = raw.group
  if (!isNonEmptyString(g.id) || typeof g.title !== 'string') return undefined
  if (!isPosInt(g.coordinatorConversationId)) return undefined
  if (g.status !== 'active' && g.status !== 'closed') return undefined
  if (!isNonNegInt(g.activeWorkerCount) || !isNonNegInt(g.headSeq)) return undefined
  if (!isFiniteNumber(g.createdAt) || !isFiniteNumber(g.updatedAt)) return undefined
  if (g.objective !== undefined && typeof g.objective !== 'string') return undefined
  if (g.coordinatorDetached !== undefined && typeof g.coordinatorDetached !== 'boolean') return undefined
  if (g.closeSummary !== undefined && typeof g.closeSummary !== 'string') return undefined
  if (g.closedAt !== undefined && !isFiniteNumber(g.closedAt)) return undefined

  const channels = parseGroupChannelsStrict(g.channels)
  if (channels === undefined) return undefined
  const retainedWorktrees = parseRetainedWorktreesStrict(g.retainedWorktrees)
  if (retainedWorktrees === 'invalid') return undefined

  const hRaw = raw.headline
  if (
    typeof hRaw.text !== 'string' ||
    typeof hRaw.tone !== 'string' ||
    !VALID_HEADLINE_TONES.has(hRaw.tone) ||
    typeof hRaw.kind !== 'string' ||
    !VALID_HEADLINE_KINDS.has(hRaw.kind)
  ) {
    return undefined
  }
  if (hRaw.targetMember !== undefined && typeof hRaw.targetMember !== 'string') return undefined
  if (hRaw.refSeq !== undefined && !isPosInt(hRaw.refSeq)) return undefined
  const headline: BoardHeadline = {
    text: hRaw.text,
    tone: hRaw.tone as BoardHeadline['tone'],
    kind: hRaw.kind as BoardHeadline['kind'],
    ...(isNonEmptyString(hRaw.targetMember) ? { targetMember: hRaw.targetMember } : {}),
    ...(hRaw.refSeq !== undefined ? { refSeq: hRaw.refSeq } : {}),
  }

  if (!Array.isArray(raw.members)) return undefined
  const members: BoardMemberView[] = []
  for (const m of raw.members) {
    const parsed = parseMemberViewStrict(m)
    if (parsed === undefined) return undefined
    members.push(parsed)
  }

  if (!Array.isArray(raw.edges)) return undefined
  const edges: BoardEdgeSummary[] = []
  for (const e of raw.edges) {
    if (
      !isPlainObject(e) ||
      !isNonEmptyString(e.from) ||
      !isNonEmptyString(e.to) ||
      !isPosInt(e.count) ||
      !isNonNegInt(e.lastSeq) ||
      typeof e.lastKind !== 'string' ||
      !VALID_POST_KINDS.has(e.lastKind)
    ) {
      return undefined
    }
    edges.push({
      from: e.from,
      to: e.to,
      count: e.count,
      lastSeq: e.lastSeq,
      lastKind: e.lastKind as BoardPostKind,
    })
  }

  if (!Array.isArray(raw.posts)) return undefined
  const posts: BoardPost[] = []
  for (const p of raw.posts) {
    const parsed = parseBoardPost(p)
    if (parsed === undefined) return undefined
    posts.push(parsed)
  }
  posts.sort((a, b) => a.seq - b.seq)

  if (!isNonEmptyStringArray(raw.activeWorkingMembers)) return undefined

  return {
    group: {
      id: g.id,
      title: g.title,
      ...(isNonEmptyString(g.objective) ? { objective: g.objective } : {}),
      coordinatorConversationId: g.coordinatorConversationId,
      status: g.status,
      ...(g.coordinatorDetached === true ? { coordinatorDetached: true } : {}),
      activeWorkerCount: g.activeWorkerCount,
      headSeq: g.headSeq,
      channels,
      ...(retainedWorktrees !== undefined ? { retainedWorktrees } : {}),
      ...(isNonEmptyString(g.closeSummary) ? { closeSummary: g.closeSummary } : {}),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      ...(g.closedAt !== undefined ? { closedAt: g.closedAt } : {}),
    },
    headline,
    members,
    edges,
    posts,
    activeWorkingMembers: raw.activeWorkingMembers,
  }
}

export function parseBoardReadPosts(raw: unknown): BoardPost[] | undefined {
  if (!isPlainObject(raw) || !Array.isArray(raw.posts)) return undefined
  const out: BoardPost[] = []
  for (const item of raw.posts) {
    const parsed = parseBoardPost(item)
    if (parsed === undefined) return undefined
    out.push(parsed)
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}

export function mergeBoardViewWithRead(view: BoardViewDoc, readPosts: ReadonlyArray<BoardPost>): BoardViewDoc {
  if (readPosts.length === 0) return view
  const bySeq = new Map<number, BoardPost>()
  for (const p of view.posts) bySeq.set(p.seq, p)
  for (const p of readPosts) bySeq.set(p.seq, p)
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return { ...view, posts: merged }
}

export function parseBoardReportMeta(props: TimelineRendererProps): BoardReportReceiptMeta {
  const data = props.entry.data as { meta?: BoardReportReceiptMeta } | undefined
  return data?.meta ?? {}
}

export function parseBoardWakeupMeta(props: TimelineRendererProps): BoardWakeupReceiptMeta {
  const data = props.entry.data as { meta?: BoardWakeupReceiptMeta } | undefined
  return data?.meta ?? {}
}

// ---------------------------------------------------------------------------
// Conversation → group resolution (public index + badges only)
// ---------------------------------------------------------------------------

export interface ConversationBoardLink {
  groupId: string
  coordinatorConversationId: number
  workerName?: string
  count: number
  tone: 'accent' | 'warn' | 'neutral'
  footerText?: string
}

export function resolveConversationBoardLink(
  conversationId: number | undefined,
  index: SwarmIndexDoc | undefined,
): ConversationBoardLink | undefined {
  if (conversationId === undefined) return undefined
  const workerEntry = Array.isArray(index?.workers)
    ? index.workers.find((w) => w.conversationId === conversationId && typeof w.groupId === 'string' && w.groupId !== '')
    : undefined
  const workerName = typeof workerEntry?.name === 'string' && workerEntry.name !== '' ? workerEntry.name : undefined

  const groups = parseGroups(index)
  if (workerEntry?.groupId !== undefined) {
    const g = groups.find((item) => item.id === workerEntry.groupId)
    const coordId =
      g?.coordinatorConversationId ??
      (isPosInt(workerEntry.coordinatorConversationId)
        ? workerEntry.coordinatorConversationId
        : workerEntry.parentConversationId ?? conversationId)
    return {
      groupId: workerEntry.groupId,
      coordinatorConversationId: coordId,
      ...(workerName !== undefined ? { workerName } : {}),
      count: g?.activeWorkerCount ?? 0,
      tone: 'neutral',
    }
  }

  const coordGroup = groups.find((g) => g.coordinatorConversationId === conversationId)
  if (coordGroup !== undefined) {
    return {
      groupId: coordGroup.id,
      coordinatorConversationId: coordGroup.coordinatorConversationId,
      count: coordGroup.activeWorkerCount,
      tone: coordGroup.status === 'active' ? 'accent' : 'neutral',
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Member / post derivations for the tray & workbench panel
// ---------------------------------------------------------------------------

/** Member live states that keep the composer tray mounted (in-flight only). */
export function isMemberInFlight(member: BoardMemberView): boolean {
  return member.lifecycle === 'active' && (member.liveState === 'working' || member.liveState === 'blocked')
}

/**
 * Display order for member rows: active before archived, in-flight (blocked
 * first) before the rest, then done, then alphabetical by name.
 */
export function sortBoardMembersForDisplay<T extends BoardMemberView>(members: readonly T[]): T[] {
  const rank = (m: T): number => {
    if (m.lifecycle !== 'active') return 4
    if (m.liveState === 'blocked') return 0
    if (m.liveState === 'working') return 1
    if (m.liveState === 'error') return 2
    return 3
  }
  return [...members].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * Whether an active member has settled after delivering its assigned task
 * (blackboard delivery state is orthogonal to kernel `liveState: 'idle'`).
 */
export function isMemberDelivered(member: BoardMemberView): boolean {
  if (member.lifecycle !== 'active') return false
  if (member.pendingWakeupSeq > member.readCursorSeq) return false
  if ((member.lastPostSeq ?? 0) < (member.lastWakeTaskSeq ?? 0)) return false
  if (member.liveState === 'done') return true
  if (member.liveState !== 'idle') return false
  return member.lastOutboundEdge?.kind === 'done' || member.lastOutboundEdge?.kind === 'handoff'
}

/** Delivered vs total progress over active members. */
export function boardProgressOf(members: ReadonlyArray<BoardMemberView>): { done: number; total: number } {
  const active = members.filter((m) => m.lifecycle === 'active')
  return {
    done: active.filter(isMemberDelivered).length,
    total: active.length,
  }
}

export interface MemberActivity {
  post: BoardPost
  direction: 'authored' | 'received'
}

/**
 * One honest sentence of latest progress per member: their newest authored
 * post, else the newest post addressed to them (their latest assignment).
 */
export function resolveMemberActivity(
  posts: ReadonlyArray<BoardPost>,
  memberName: string,
): MemberActivity | undefined {
  let authored: BoardPost | undefined
  let received: BoardPost | undefined
  for (const post of posts) {
    if (post.from === memberName) {
      if (authored === undefined || post.seq > authored.seq) authored = post
    }
    if (post.resolvedTargets.includes(memberName) || post.to.includes(memberName)) {
      if (received === undefined || post.seq > received.seq) received = post
    }
  }
  if (authored !== undefined) return { post: authored, direction: 'authored' }
  if (received !== undefined) return { post: received, direction: 'received' }
  return undefined
}

/** Newest worktree snapshot attached to a member's handoff/done posts (branch state facts). */
export function resolveMemberWorktree(
  posts: ReadonlyArray<BoardPost>,
  member: Pick<BoardMemberView, 'name'>,
): WorktreeHandoffSnapshot | undefined {
  let best: WorktreeHandoffSnapshot | undefined
  let bestSeq = -1
  for (const post of posts) {
    if (post.from !== member.name) continue
    if (post.worktreeSnapshot === undefined) continue
    if (post.seq > bestSeq) {
      bestSeq = post.seq
      best = post.worktreeSnapshot
    }
  }
  return best
}

export function extractPostRefs(post: BoardPost): number[] {
  const seen = new Set<number>()
  for (const r of post.refs) {
    if (Number.isSafeInteger(r) && r > 0 && r !== post.seq) seen.add(r)
  }
  const matches = post.body.matchAll(/(?:^|\s|\(|\[)#(\d+)\b/g)
  for (const match of matches) {
    const num = Number(match[1])
    if (Number.isSafeInteger(num) && num > 0 && num !== post.seq) seen.add(num)
  }
  return [...seen].sort((a, b) => a - b)
}

export function shouldCollapsePostBody(body: string): boolean {
  if (body.length > 360) return true
  let lines = 1
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n' && ++lines > 8) return true
  }
  return false
}

export function previewPostBody(body: string): string {
  const lines = body.split('\n')
  const slicedLines = lines.slice(0, 6).join('\n')
  const capped = slicedLines.length > 320 ? slicedLines.slice(0, 320) : slicedLines
  return `${capped}…`
}

/** First non-empty line of a post body, whitespace-collapsed and capped for single-row digests. */
export function postDigestLine(body: string, maxChars = 120): string {
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.replaceAll(/\s+/g, ' ').trim())
      .find((line) => line !== '') ?? ''
  if (firstLine.length <= maxChars) return firstLine
  return `${firstLine.slice(0, maxChars - 1)}…`
}

export function liveStateBadgeClass(state: MemberLiveState): string {
  if (state === 'working') return 'badge-accent'
  if (state === 'blocked' || state === 'missing') return 'badge-warn'
  if (state === 'error') return 'badge-err'
  if (state === 'done') return 'badge-ok'
  return 'badge-neutral'
}

export function postKindBadgeClass(kind: BoardPostKind): string {
  if (kind === 'done') return 'badge-ok'
  if (kind === 'blocker') return 'badge-err'
  if (kind === 'stall' || kind === 'review') return 'badge-warn'
  if (kind === 'brief' || kind === 'handoff') return 'badge-accent'
  return 'badge-neutral'
}
