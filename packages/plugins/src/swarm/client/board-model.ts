/**
 * Pure domain models, lenient boundary parsers, navigation target builders,
 * orthogonal SVG collaboration graph layout, and worktree snapshot parsers for
 * `builtin:swarm` (zero React/DOM dependencies, Fast Refresh compliant).
 */
import type { ConversationSummary, TimelineRendererProps } from '@helm/protocol'
import type { SelectOption } from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'

export const COORDINATOR_TAG = 'swarm-coordinator'
export const WORKER_TAG = 'swarm-worker'
export const ARCHIVED_WORKER_TAG = 'swarm-worker-archived'
export const BOARD_SCREEN_BASE = 'screen:builtin:swarm/board'

export type WorkerAccess = 'readwrite' | 'readonly'
export type WorkerIsolation = 'inherit' | 'worktree'
export type CollabGroupStatus = 'active' | 'closed'
export type BoardPostKind = 'brief' | 'handoff' | 'review' | 'comment' | 'blocker' | 'done' | 'stall'
export type MemberLiveState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'missing'
export type StarterPresetId = 'author-verifier' | 'squad' | 'blank'

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
  lastWakeCompletionSeq?: number
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
  coordinatorGuard: boolean
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

export interface WorktreeInspectSnapshot {
  worktreeId: string
  nodeId: string
  path: string
  branch: string
  baseCommit: string
  exists: boolean
  unavailableReason?: string
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  dirtyFiles: string[]
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  commitsAhead?: number
  diffStat?: string
  diffPreview?: string
  diffTruncated: boolean
  diffBase: string
}

// 本地宽松对象守卫：client bundle 的共享外部依赖白名单（CLIENT_SHARED_EXTERNALS）不含
// @helm/protocol，浏览器侧不能运行时导入 protocol 的 isJsonObject，故保留等价私有实现。
function isPlainObject(v: unknown): v is Record<string, unknown> {
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

export function parseBoardPost(raw: unknown): BoardPost | undefined {
  if (!isPlainObject(raw)) return undefined
  if (!isPosInt(raw.seq)) return undefined
  if (typeof raw.groupId !== 'string' || raw.groupId === '') return undefined
  if (typeof raw.from !== 'string' || raw.from === '') return undefined
  if (typeof raw.body !== 'string') return undefined
  const kind =
    typeof raw.kind === 'string' && VALID_POST_KINDS.has(raw.kind)
      ? (raw.kind as BoardPostKind)
      : 'handoff'
  const to = Array.isArray(raw.to) ? raw.to.filter((t): t is string => typeof t === 'string' && t !== '') : []
  const resolvedTargets = Array.isArray(raw.resolvedTargets)
    ? raw.resolvedTargets.filter((t): t is string => typeof t === 'string' && t !== '')
    : to
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((r): r is number => isPosInt(r)) : []
  let worktreeSnapshot: WorktreeHandoffSnapshot | undefined
  const snap = raw.worktreeSnapshot
  if (isPlainObject(snap) && typeof snap.worktreeId === 'string') {
    worktreeSnapshot = {
      worktreeId: snap.worktreeId,
      ...(typeof snap.branch === 'string' ? { branch: snap.branch } : {}),
      ...(isNonNegInt(snap.commitsAhead) ? { commitsAhead: snap.commitsAhead } : {}),
      dirtyCount: isNonNegInt(snap.dirtyCount) ? snap.dirtyCount : 0,
      changedFilesPreview: Array.isArray(snap.changedFilesPreview)
        ? snap.changedFilesPreview.filter((f): f is string => typeof f === 'string')
        : [],
    }
  }
  return {
    seq: raw.seq,
    groupId: raw.groupId,
    channel: typeof raw.channel === 'string' && raw.channel !== '' ? raw.channel : 'main',
    from: raw.from,
    to,
    resolvedTargets,
    wake: typeof raw.wake === 'boolean' ? raw.wake : kind !== 'comment',
    kind,
    refs,
    body: raw.body,
    ...(worktreeSnapshot !== undefined ? { worktreeSnapshot } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  }
}

export function parseBoardView(raw: unknown): BoardViewDoc | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.group)) return undefined
  const g = raw.group
  if (typeof g.id !== 'string' || g.id === '') return undefined
  if (typeof g.title !== 'string') return undefined
  if (!isPosInt(g.coordinatorConversationId)) return undefined
  const status: CollabGroupStatus = g.status === 'closed' ? 'closed' : 'active'

  const channels: BoardChannelInfo[] = Array.isArray(g.channels)
    ? g.channels
        .filter((c): c is Record<string, unknown> => isPlainObject(c) && typeof c.name === 'string' && c.name !== '')
        .map((c) => ({
          name: c.name as string,
          ...(typeof c.topic === 'string' ? { topic: c.topic } : {}),
          ...(c.archived === true ? { archived: true } : {}),
        }))
    : [{ name: 'main' }]
  if (channels.length === 0) channels.push({ name: 'main' })

  const retainedWorktrees: RetainedWorktreeInfo[] | undefined = Array.isArray(g.retainedWorktrees)
    ? g.retainedWorktrees
        .filter(
          (w): w is Record<string, unknown> =>
            isPlainObject(w) &&
            typeof w.memberName === 'string' &&
            typeof w.worktreeId === 'string' &&
            typeof w.branch === 'string' &&
            typeof w.path === 'string',
        )
        .map((w) => ({
          memberName: w.memberName as string,
          worktreeId: w.worktreeId as string,
          branch: w.branch as string,
          path: w.path as string,
          commitsAhead: isNonNegInt(w.commitsAhead) ? w.commitsAhead : 0,
        }))
    : undefined

  const hRaw = isPlainObject(raw.headline) ? raw.headline : {}
  const headlineTone =
    hRaw.tone === 'warn' || hRaw.tone === 'err' || hRaw.tone === 'ok' || hRaw.tone === 'info'
      ? hRaw.tone
      : status === 'closed'
        ? 'ok'
        : 'info'
  const headlineKind =
    hRaw.kind === 'stall' ||
    hRaw.kind === 'blocker' ||
    hRaw.kind === 'unmerged' ||
    hRaw.kind === 'closed' ||
    hRaw.kind === 'normal'
      ? hRaw.kind
      : status === 'closed'
        ? 'closed'
        : 'normal'
  const headline: BoardHeadline = {
    text: typeof hRaw.text === 'string' ? hRaw.text : g.title,
    tone: headlineTone,
    kind: headlineKind,
    ...(typeof hRaw.targetMember === 'string' && hRaw.targetMember !== '' ? { targetMember: hRaw.targetMember } : {}),
    ...(isPosInt(hRaw.refSeq) ? { refSeq: hRaw.refSeq } : {}),
  }

  const members: BoardMemberView[] = []
  if (Array.isArray(raw.members)) {
    for (const m of raw.members) {
      if (!isPlainObject(m)) continue
      if (typeof m.name !== 'string' || m.name === '') continue
      if (!isPosInt(m.conversationId)) continue
      const liveState: MemberLiveState =
        typeof m.liveState === 'string' && VALID_LIVE_STATES.has(m.liveState)
          ? (m.liveState as MemberLiveState)
          : 'idle'
      members.push({
        name: m.name,
        conversationId: m.conversationId,
        profileId: typeof m.profileId === 'string' && m.profileId !== '' ? m.profileId : 'assistant',
        access: m.access === 'readonly' ? 'readonly' : 'readwrite',
        isolation: m.isolation === 'worktree' ? 'worktree' : 'inherit',
        nodeId: typeof m.nodeId === 'string' && m.nodeId !== '' ? m.nodeId : 'local',
        cwd: typeof m.cwd === 'string' ? m.cwd : '',
        ...(typeof m.worktreeId === 'string' && m.worktreeId !== '' ? { worktreeId: m.worktreeId } : {}),
        channels: Array.isArray(m.channels)
          ? m.channels.filter((c): c is string => typeof c === 'string' && c !== '')
          : ['main'],
        lifecycle: m.lifecycle === 'archived' ? 'archived' : 'active',
        readCursorSeq: isNonNegInt(m.readCursorSeq) ? m.readCursorSeq : 0,
        pendingWakeupSeq: isNonNegInt(m.pendingWakeupSeq) ? m.pendingWakeupSeq : 0,
        ...(isPosInt(m.lastPostSeq) ? { lastPostSeq: m.lastPostSeq } : {}),
        ...(isPosInt(m.lastWakeTaskSeq) ? { lastWakeTaskSeq: m.lastWakeTaskSeq } : {}),
        ...(isPosInt(m.silentExitNudgeSeq) ? { silentExitNudgeSeq: m.silentExitNudgeSeq } : {}),
        ...(isNonNegInt(m.lastWakeCompletionSeq) ? { lastWakeCompletionSeq: m.lastWakeCompletionSeq } : {}),
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
        ...(typeof m.archivedAt === 'number' ? { archivedAt: m.archivedAt } : {}),
        liveState,
        ...(typeof m.model === 'string' && m.model !== '' ? { model: m.model } : {}),
      })
    }
  }

  const edges: BoardEdgeSummary[] = []
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (!isPlainObject(e)) continue
      if (typeof e.from !== 'string' || e.from === '' || typeof e.to !== 'string' || e.to === '') continue
      const lastKind =
        typeof e.lastKind === 'string' && VALID_POST_KINDS.has(e.lastKind)
          ? (e.lastKind as BoardPostKind)
          : 'handoff'
      edges.push({
        from: e.from,
        to: e.to,
        count: isPosInt(e.count) ? e.count : 1,
        lastSeq: isNonNegInt(e.lastSeq) ? e.lastSeq : 0,
        lastKind,
      })
    }
  }

  const posts: BoardPost[] = []
  if (Array.isArray(raw.posts)) {
    for (const p of raw.posts) {
      const parsed = parseBoardPost(p)
      if (parsed !== undefined) posts.push(parsed)
    }
  }
  posts.sort((a, b) => a.seq - b.seq)

  const activeWorkingMembers = Array.isArray(raw.activeWorkingMembers)
    ? raw.activeWorkingMembers.filter((n): n is string => typeof n === 'string' && n !== '')
    : members
        .filter((m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked'))
        .map((m) => m.name)

  return {
    group: {
      id: g.id,
      title: g.title,
      ...(typeof g.objective === 'string' && g.objective !== '' ? { objective: g.objective } : {}),
      coordinatorConversationId: g.coordinatorConversationId,
      coordinatorGuard: typeof g.coordinatorGuard === 'boolean' ? g.coordinatorGuard : true,
      status,
      ...(g.coordinatorDetached === true ? { coordinatorDetached: true } : {}),
      activeWorkerCount: isNonNegInt(g.activeWorkerCount)
        ? g.activeWorkerCount
        : members.filter((m) => m.lifecycle === 'active').length,
      headSeq: isNonNegInt(g.headSeq) ? g.headSeq : (posts[posts.length - 1]?.seq ?? 0),
      channels,
      ...(retainedWorktrees !== undefined ? { retainedWorktrees } : {}),
      ...(typeof g.closeSummary === 'string' && g.closeSummary !== '' ? { closeSummary: g.closeSummary } : {}),
      createdAt: typeof g.createdAt === 'number' ? g.createdAt : 0,
      updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : 0,
      ...(typeof g.closedAt === 'number' ? { closedAt: g.closedAt } : {}),
    },
    headline,
    members,
    edges,
    posts,
    activeWorkingMembers,
  }
}

export function parseBoardReadPosts(raw: unknown): BoardPost[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.posts)) return []
  const out: BoardPost[] = []
  for (const item of raw.posts) {
    const parsed = parseBoardPost(item)
    if (parsed !== undefined) out.push(parsed)
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

export function parseCreateGroupId(raw: unknown): string | undefined {
  if (!isPlainObject(raw)) return undefined
  if (typeof raw.groupId === 'string' && raw.groupId !== '') return raw.groupId
  if (isPlainObject(raw.group) && typeof raw.group.id === 'string' && raw.group.id !== '') return raw.group.id
  if (typeof raw.id === 'string' && raw.id !== '') return raw.id
  return undefined
}

export function parseBoardReportMeta(props: TimelineRendererProps): BoardReportReceiptMeta {
  const data = props.entry.data as { meta?: BoardReportReceiptMeta } | undefined
  return data?.meta ?? {}
}

export function parseBoardWakeupMeta(props: TimelineRendererProps): BoardWakeupReceiptMeta {
  const data = props.entry.data as { meta?: BoardWakeupReceiptMeta } | undefined
  return data?.meta ?? {}
}

/** Strict boundary parser for builtin:workflow inspect_worktree action result. */
export function parseWorktreeInspectSnapshot(raw: unknown): WorktreeInspectSnapshot | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.record)) return undefined
  const rec = raw.record
  if (
    typeof rec.id !== 'string' ||
    rec.id === '' ||
    typeof rec.path !== 'string' ||
    rec.path === '' ||
    typeof rec.branch !== 'string' ||
    rec.branch === '' ||
    typeof rec.nodeId !== 'string' ||
    rec.nodeId === ''
  ) {
    return undefined
  }
  if (typeof raw.exists !== 'boolean') return undefined
  if (!Array.isArray(raw.dirtyFiles) || raw.dirtyFiles.some((f) => typeof f !== 'string')) return undefined
  if (!isNonNegInt(raw.dirtyFileCount)) return undefined
  if (typeof raw.dirtyFilesTruncated !== 'boolean' || typeof raw.diffTruncated !== 'boolean') return undefined
  if (raw.diffBase !== 'baseCommit' && raw.diffBase !== 'HEAD') return undefined

  return {
    worktreeId: rec.id,
    nodeId: rec.nodeId,
    path: rec.path,
    branch: rec.branch,
    baseCommit: typeof rec.baseCommit === 'string' ? rec.baseCommit : '',
    exists: raw.exists,
    ...(typeof raw.unavailableReason === 'string' ? { unavailableReason: raw.unavailableReason } : {}),
    ...(typeof raw.currentBranch === 'string' ? { currentBranch: raw.currentBranch } : {}),
    ...(typeof raw.currentHead === 'string' ? { currentHead: raw.currentHead } : {}),
    ...(raw.branchChanged === true ? { branchChanged: true } : {}),
    dirtyFiles: raw.dirtyFiles as string[],
    dirtyFileCount: raw.dirtyFileCount,
    dirtyFilesTruncated: raw.dirtyFilesTruncated,
    ...(isNonNegInt(raw.commitsAhead) ? { commitsAhead: raw.commitsAhead } : {}),
    ...(typeof raw.diffStat === 'string' ? { diffStat: raw.diffStat } : {}),
    ...(typeof raw.diffPreview === 'string' ? { diffPreview: raw.diffPreview } : {}),
    diffTruncated: raw.diffTruncated,
    diffBase: raw.diffBase,
  }
}

// ---------------------------------------------------------------------------
// Navigation targets & conversation eligibility
// ---------------------------------------------------------------------------

export function buildBoardScreenTarget(params: {
  groupId?: string
  worker?: string
  seq?: number
  channel?: string
}): string {
  const entries: Array<[string, string]> = []
  if (params.groupId !== undefined && params.groupId.trim() !== '') {
    entries.push(['groupId', params.groupId.trim()])
  }
  if (params.channel !== undefined && params.channel.trim() !== '' && params.channel !== 'all') {
    entries.push(['channel', params.channel.trim()])
  }
  if (params.worker !== undefined && params.worker.trim() !== '') {
    entries.push(['worker', params.worker.trim()])
  }
  if (params.seq !== undefined && Number.isSafeInteger(params.seq) && params.seq > 0) {
    entries.push(['seq', String(params.seq)])
  }
  if (entries.length === 0) return BOARD_SCREEN_BASE
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${BOARD_SCREEN_BASE}?${qs}`
}

export function isNarrowViewport(width: number | undefined): boolean {
  return typeof width === 'number' && width > 0 && width <= 680
}

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
  badges: Record<string, BoardBadgeItem>,
  index: SwarmIndexDoc | undefined,
): ConversationBoardLink | undefined {
  if (conversationId === undefined) return undefined
  const workerEntry = Array.isArray(index?.workers)
    ? index.workers.find((w) => w.conversationId === conversationId && typeof w.groupId === 'string' && w.groupId !== '')
    : undefined
  const workerName = typeof workerEntry?.name === 'string' && workerEntry.name !== '' ? workerEntry.name : undefined

  const badge = badges[String(conversationId)]
  if (badge !== undefined) {
    return {
      groupId: badge.groupId,
      coordinatorConversationId: badge.coordinatorConversationId,
      ...(workerName !== undefined ? { workerName } : {}),
      count: badge.count,
      tone: badge.tone,
      ...(badge.footerText !== undefined ? { footerText: badge.footerText } : {}),
    }
  }

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

export function canStartSwarmGroup(
  conversation: ConversationSummary | undefined,
  index: SwarmIndexDoc | undefined,
  badges: Record<string, BoardBadgeItem>,
): boolean {
  if (conversation === undefined) return false
  if (conversation.parentConversationId !== undefined) return false
  if ((conversation.ownedBy ?? 'human') !== 'human') return false
  if (
    conversation.tags.includes(COORDINATOR_TAG) ||
    conversation.tags.includes(WORKER_TAG) ||
    conversation.tags.includes(ARCHIVED_WORKER_TAG)
  ) {
    return false
  }
  const badge = badges[String(conversation.id)]
  if (badge !== undefined) {
    const groups = parseGroups(index)
    const g = groups.find((item) => item.id === badge.groupId)
    if (g === undefined || g.status === 'active') return false
  }
  const activeGroup = parseGroups(index).find(
    (g) => g.coordinatorConversationId === conversation.id && g.status === 'active',
  )
  return activeGroup === undefined
}

// ---------------------------------------------------------------------------
// Stream filters, badges, model options & post helpers
// ---------------------------------------------------------------------------

export interface StreamFilter {
  channel?: string
  member?: string
  edge?: { from: string; to: string }
}

export function filterBoardPosts(posts: ReadonlyArray<BoardPost>, filter: StreamFilter): BoardPost[] {
  return posts.filter((post) => {
    if (filter.channel !== undefined && filter.channel !== 'all' && post.channel !== filter.channel) {
      return false
    }
    if (filter.edge !== undefined) {
      const { from, to } = filter.edge
      if (post.from !== from) return false
      if (!post.resolvedTargets.includes(to) && !post.to.includes(to)) return false
      return true
    }
    if (filter.member !== undefined && filter.member !== '') {
      const m = filter.member
      if (post.from === m || post.resolvedTargets.includes(m) || post.to.includes(m)) return true
      return false
    }
    return true
  })
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

export function buildPostTargetOptions(board: BoardViewDoc): SelectOption<string>[] {
  const opts: SelectOption<string>[] = [
    { value: 'all', label: 'all', meta: 'broadcast', icon: 'network' },
    { value: 'coordinator', label: '@coordinator', meta: 'hub', icon: 'shield' },
  ]
  for (const member of board.members) {
    if (member.lifecycle !== 'active') continue
    opts.push({
      value: member.name,
      label: `@${member.name}`,
      meta: member.access === 'readonly' ? 'readonly' : member.profileId,
      icon: 'bot',
    })
  }
  for (const ch of board.group.channels) {
    if (ch.archived === true || ch.name === 'main') continue
    opts.push({
      value: `#${ch.name}`,
      label: `#${ch.name}`,
      meta: ch.topic ?? 'channel',
      icon: 'layers',
    })
  }
  return opts
}

export function collectSelectableModels(
  currentModel: string | undefined,
  board: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
): string[] {
  const seen = new Set<string>()
  const add = (m: string | undefined): void => {
    if (typeof m === 'string') {
      const trimmed = m.trim()
      if (trimmed !== '') seen.add(trimmed)
    }
  }
  add(currentModel)
  for (const member of board.members) add(member.model)
  for (const conv of conversations) add(conv.model)
  return [...seen]
}

// ---------------------------------------------------------------------------
// Deterministic Orthogonal SVG Collaboration Graph Layout
// ---------------------------------------------------------------------------

export interface TopologyNodeLayout {
  id: string
  label: string
  isCoordinator: boolean
  member?: BoardMemberView
  x: number
  y: number
  width: number
  height: number
  unreadCount: number
}

export interface TopologyEdgeLayout {
  key: string
  from: string
  to: string
  count: number
  lastSeq: number
  lastKind: BoardPostKind
  path: string
  labelX: number
  labelY: number
}

export interface OrthogonalTopologyLayout {
  width: number
  height: number
  nodes: TopologyNodeLayout[]
  edges: TopologyEdgeLayout[]
}

const NODE_W = 168
const NODE_H = 54
const LEFT_PAD = 24
const RIGHT_COL_X = 296
const COL_GAP_X = 224
const TOP_PAD = 22
const ROW_GAP_Y = 74

export function computeOrthogonalTopology(
  board: BoardViewDoc,
  coordinatorLabel: string,
): OrthogonalTopologyLayout {
  const visibleMembers = board.members.filter(
    (m) => m.lifecycle === 'active' || board.edges.some((e) => e.from === m.name || e.to === m.name),
  )
  const perCol = visibleMembers.length > 4 ? 2 : 1
  const rows = Math.max(1, Math.ceil(visibleMembers.length / perCol))
  const totalHeight = Math.max(116, TOP_PAD * 2 + rows * NODE_H + Math.max(0, rows - 1) * (ROW_GAP_Y - NODE_H))
  const coordY = Math.round((totalHeight - NODE_H) / 2)

  const nodes: TopologyNodeLayout[] = [
    {
      id: 'coordinator',
      label: coordinatorLabel,
      isCoordinator: true,
      x: LEFT_PAD,
      y: coordY,
      width: NODE_W,
      height: NODE_H,
      unreadCount: 0,
    },
  ]

  visibleMembers.forEach((member, index) => {
    const col = perCol === 2 ? index % 2 : 0
    const row = perCol === 2 ? Math.floor(index / 2) : index
    const x = RIGHT_COL_X + col * COL_GAP_X
    const y = TOP_PAD + row * ROW_GAP_Y
    const unreadCount = Math.max(0, member.pendingWakeupSeq - member.readCursorSeq)
    nodes.push({
      id: member.name,
      label: `@${member.name}`,
      isCoordinator: false,
      member,
      x,
      y,
      width: NODE_W,
      height: NODE_H,
      unreadCount,
    })
  })

  const maxRight = nodes.reduce((acc, n) => Math.max(acc, n.x + n.width), LEFT_PAD + NODE_W)
  const totalWidth = Math.max(520, maxRight + LEFT_PAD + 28)

  const nodeMap = new Map<string, TopologyNodeLayout>()
  for (const n of nodes) nodeMap.set(n.id, n)

  const edges: TopologyEdgeLayout[] = []
  board.edges.forEach((edge, idx) => {
    const src = nodeMap.get(edge.from)
    const dst = nodeMap.get(edge.to)
    if (src === undefined || dst === undefined || src.id === dst.id) return

    const laneOffset = ((idx % 3) - 1) * 7
    let path: string
    let labelX: number
    let labelY: number

    if (src.x < dst.x) {
      const x1 = src.x + src.width
      const y1 = src.y + Math.round(src.height / 2) + laneOffset
      const x2 = dst.x
      const y2 = dst.y + Math.round(dst.height / 2) + laneOffset
      const midX = Math.round((x1 + x2) / 2) + laneOffset
      path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
      labelX = midX
      labelY = Math.round((y1 + y2) / 2) - 6
    } else if (src.x > dst.x) {
      const x1 = src.x
      const y1 = src.y + Math.round(src.height / 2) + 8
      const x2 = dst.x + dst.width
      const y2 = dst.y + Math.round(dst.height / 2) + 8
      const midX = Math.round((x1 + x2) / 2) - 12
      path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
      labelX = midX
      labelY = Math.round((y1 + y2) / 2) + 12
    } else {
      const x1 = src.x + src.width
      const y1 = src.y + Math.round(src.height / 2)
      const x2 = dst.x + dst.width
      const y2 = dst.y + Math.round(dst.height / 2)
      const railX = Math.max(x1, x2) + 18 + (idx % 2) * 8
      path = `M ${x1} ${y1} L ${railX} ${y1} L ${railX} ${y2} L ${x2} ${y2}`
      labelX = railX - 18
      labelY = Math.round((y1 + y2) / 2)
    }

    edges.push({
      key: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      count: edge.count,
      lastSeq: edge.lastSeq,
      lastKind: edge.lastKind,
      path,
      labelX,
      labelY,
    })
  })

  return { width: totalWidth, height: totalHeight, nodes, edges }
}
