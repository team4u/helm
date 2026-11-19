import {
  HelmxError,
  isJsonObject,
  type ConversationScope,
  type ConversationSummary,
  type MaybePromise,
  type PluginDocHandle,
  type PluginSessionDocHandle,
  type TurnOutcome,
} from '@helmx/protocol'

// ---------------------------------------------------------------------------
// 常量定义
// ---------------------------------------------------------------------------

export const SWARM_PLUGIN_ID = 'builtin:swarm'
export const SWARM_SKILL_ID = 'swarm'

export const COORDINATOR_TAG = 'swarm-coordinator'
export const WORKER_TAG = 'swarm-worker'
export const ARCHIVED_WORKER_TAG = 'swarm-worker-archived'
export const WORKER_ARCHIVED_TAG = ARCHIVED_WORKER_TAG
/**
 * 结单后主控会话的历史 tag：仅供 UI（workbench 编排面板）继续访问已完成编组，
 * 不进入任何工具/动作 scope，也不触发 <active_swarm_group> 注入
 * （协作铁律按活跃组判定，与 tag 无关）。重新建组时由 ensureCoordinatorGroup 原地摘除。
 */
export const ARCHIVED_COORDINATOR_TAG = 'swarm-coordinator-archived'

export const BOARD_REPORT_RENDERER = 'swarm:board-report'
export const BOARD_WAKEUP_RENDERER = 'swarm:board-wakeup'

export const INDEX_DOC_NAME = 'index'
export const BOARD_BADGES_DOC_NAME = 'board-badges'
export const BOARD_VIEW_DOC_NAME = 'board-view'
export const ACTIVE_SWARM_GROUP_SECTION_ID = 'swarm.active_group'

/** 协作组成员保留字（禁止作为对等成员短名）。 */
export const RESERVED_MEMBER_NAMES = new Set(['coordinator', 'all', 'system'])

export const MEMBER_NAME_PATTERN = '^[a-z][a-z0-9_-]{0,31}$'
export const CHANNEL_NAME_PATTERN = '^[a-z][a-z0-9_-]{0,39}$'
export const GROUP_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'
export const PROFILE_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$'
export const NODE_ID_PATTERN = '^[^\\s/\\\\]{1,64}$'

const MEMBER_NAME_RE = new RegExp(MEMBER_NAME_PATTERN)
const CHANNEL_NAME_RE = new RegExp(CHANNEL_NAME_PATTERN)
const GROUP_ID_RE = new RegExp(GROUP_ID_PATTERN)

export const BOARD_POST_KINDS = ['brief', 'handoff', 'review', 'comment', 'blocker', 'done', 'stall'] as const
export type BoardPostKind = (typeof BOARD_POST_KINDS)[number]

/** 行动类唤醒类型（计入 lastWakeTaskSeq 用于防哑巴退场检测）。 */
export const ACTIONABLE_WAKE_KINDS: ReadonlySet<BoardPostKind> = new Set(['brief', 'handoff', 'review'])

/** 无条件上报主控的状态流转类型。 */
export const COORDINATOR_ESCALATION_KINDS: ReadonlySet<BoardPostKind> = new Set(['blocker', 'done', 'stall'])

/** 主控汇总微批合并窗口（毫秒）。 */
export const COORDINATOR_BATCH_WINDOW_MS = 50

/** 全局 index.groups 最多保留的已结单历史组摘要条数（防止 2 MiB 上限膨胀；全量历史按会话走 board_status 懒加载）。 */
export const MAX_INDEX_CLOSED_GROUPS = 50

/** 协作组主控独享作用域。 */
export const COORDINATOR_SCOPE: ConversationScope = { tags: [COORDINATOR_TAG] }

/** 协作组全员共享作用域（主控与对等 Worker 共享黑板读写与只读检视）。 */
export const PARTICIPANT_SCOPE: ConversationScope = { tags: [COORDINATOR_TAG, WORKER_TAG] }

/** 历史面板只读查看作用域（含结单历史主控与已归档成员，仅供工作台 board_read / board_status 回退读取）。 */
export const HISTORY_PARTICIPANT_SCOPE: ConversationScope = {
  tags: [COORDINATOR_TAG, ARCHIVED_COORDINATOR_TAG, WORKER_TAG, ARCHIVED_WORKER_TAG],
}

export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  maxWorkersPerGroup: 12,
  boardPreviewLimit: 80,
}

// ---------------------------------------------------------------------------
// 领域模型契约
// ---------------------------------------------------------------------------

export type WorkerAccess = 'readwrite' | 'readonly'
export type WorkerIsolation = 'inherit' | 'worktree'
export type CollabGroupStatus = 'active' | 'closed'

export interface SwarmConfig {
  maxWorkersPerGroup: number
  boardPreviewLimit: number
}

/** 全局 index 轻量反查指针：详细成员状态以组 meta.json 为唯一真源。 */
export interface SwarmWorkerPointer {
  conversationId: number
  coordinatorConversationId: number
  profileId: string
  groupId: string
  name: string
  createdAt: number
}

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

export interface SwarmIndexDoc {
  workers: SwarmWorkerPointer[]
  groups: CollabGroupSummary[]
}

export interface InflightWakeupIntent {
  requestId: string
  fromSeq: number
  toSeq: number
  baseCompletionSeq: number
  baseLastEntryId: number
}

export interface InflightNudgeIntent {
  requestId: string
  taskSeq: number
  baseCompletionSeq: number
  baseLastEntryId: number
}

export interface InflightReportIntent {
  requestId: string
  fromSeq: number
  toSeq: number
  baseCompletionSeq: number
  baseLastEntryId: number
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
  /** 该成员最近一次调用 board_post 发布的序号（用于检测哑巴退场与未回复点名）。 */
  lastPostSeq?: number
  /** 最近一次向该成员投递的行动类唤醒（brief / handoff / review）最高序号。 */
  lastWakeTaskSeq?: number
  /** 已对该成员发送过单次哑巴退场续催的任务水位（防无限循环）。 */
  silentExitNudgeSeq?: number
  /** 最近一次唤醒或哑巴续催提交成功后（submitInputGuarded 返回后）记录的 completionSeq 水位，用于重放/静默归因防误判。 */
  lastWakeCompletionSeq?: number
  lastOutboundEdge?: { seq: number; to: string[]; kind: BoardPostKind }
  /** dispatch_worker 工具调用幂等键（`${conversationId}:${callId}`），用于 replay: 'safe' 去重。 */
  dispatchKey?: string
  /** 该成员入组首帖（brief）序号，供 dispatch_worker 重放时 O(1) 还原返回值。 */
  briefPostSeq?: number
  /** 尚待提交或尚待与内核状态对账的在途唤醒意图（先于 submitInput 落盘，防强杀死锁）。 */
  inflightWakeup?: InflightWakeupIntent
  /** 尚待提交或尚待与内核状态对账的在途哑巴续催意图。 */
  inflightNudge?: InflightNudgeIntent
  createdAt: number
  archivedAt?: number
}

export interface RetainedWorktreeInfo {
  memberName: string
  worktreeId: string
  branch: string
  path: string
  commitsAhead: number
}

export interface CollabChannelSpec {
  name: string
  topic?: string
  archived?: boolean
}

export interface CollabGroupRecord {
  id: string
  title: string
  objective?: string
  coordinatorConversationId: number
  /** create_group 工具调用幂等键（`${conversationId}:${callId}`），用于 replay: 'safe' 去重。 */
  createKey?: string
  status: CollabGroupStatus
  channels: CollabChannelSpec[]
  members: GroupMemberState[]
  headSeq: number
  coordinatorNotifiedSeq: number
  coordinatorPendingSeq: number
  /** 尚待提交或尚待与内核状态对账的主控在途汇总意图。 */
  inflightReport?: InflightReportIntent
  lastStallWatermark?: string
  coordinatorDetached?: boolean
  /** keepWorktree: true 结单时固化的待主控合入分支清单。 */
  retainedWorktrees?: RetainedWorktreeInfo[]
  createdAt: number
  updatedAt: number
  closedAt?: number
  closeSummary?: string
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
  /** 是否主动拉起处于空闲态的目标会话；false 仅留档展示并随下次有效唤醒一并投递。 */
  wake: boolean
  kind: BoardPostKind
  refs: number[]
  body: string
  /** board_post 工具调用幂等键（`${conversationId}:${callId}`），用于 replay: 'safe' 去重。 */
  idempotencyKey?: string
  worktreeSnapshot?: WorktreeHandoffSnapshot
  createdAt: number
}

export interface BoardBadgeEntry {
  groupId: string
  coordinatorConversationId: number
  count: number
  tone: 'accent' | 'warn' | 'neutral'
  footerText?: string
}

export interface BoardBadgesDoc {
  byConversation: Record<string, BoardBadgeEntry>
}

export type MemberLiveState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'missing'

export interface BoardViewHeadline {
  text: string
  tone: 'info' | 'warn' | 'err' | 'ok'
  kind: 'normal' | 'stall' | 'blocker' | 'unmerged' | 'closed'
  targetMember?: string
  refSeq?: number
}

export type BoardViewMember = GroupMemberState & {
  liveState: MemberLiveState
  model?: string
}

export interface BoardViewEdge {
  from: string
  to: string
  count: number
  lastSeq: number
  lastKind: BoardPostKind
}

export interface BoardViewDoc {
  group: CollabGroupSummary & {
    objective?: string
    channels: CollabChannelSpec[]
    retainedWorktrees?: RetainedWorktreeInfo[]
    closeSummary?: string
  }
  headline: BoardViewHeadline
  members: BoardViewMember[]
  edges: BoardViewEdge[]
  posts: BoardPost[]
  activeWorkingMembers: string[]
}

export interface SwarmDocs {
  index: PluginDocHandle<SwarmIndexDoc>
  boardBadges: PluginDocHandle<BoardBadgesDoc>
  boardView: PluginSessionDocHandle<BoardViewDoc | null>
}

/** 协作组运行时存储与唤醒调度接口（由 group-store.ts 实现）。 */
export interface CollabGroupRuntime {
  loadAllFromDisk(): Promise<void>
  reconcileOrphansOnBoot(): Promise<void>
  reconcileRecoveredGroups(): Promise<void>
  stopAndClear(): Promise<void>
  liveTaskLabels(): string[]
  inUseItems(): Array<{ kind: string; id: string; label: string }>
  listGroups(): CollabGroupRecord[]
  getGroup(groupId: string): CollabGroupRecord | undefined
  findActiveGroupByCoordinator(conversationId: number): CollabGroupRecord | undefined
  findGroupByParticipant(conversationId: number):
    | { group: CollabGroupRecord; role: 'coordinator' }
    | { group: CollabGroupRecord; role: 'worker'; member: GroupMemberState }
    | undefined
  findLatestGroupForConversation(conversationId: number): CollabGroupRecord | undefined
  getPosts(groupId: string): readonly BoardPost[]
  ensurePostsLoaded(groupId: string): Promise<readonly BoardPost[]>
  buildBoardView(groupId: string): BoardViewDoc
  syncProjections(): void
  onConversationUpsert(conversationId: number): void
  onConversationDeleted(conversationId: number): Promise<void>
  createGroup(input: {
    coordinatorConversationId: number
    title: string
    objective?: string
    channels?: Array<{ name: string; topic?: string }>
    createKey?: string
  }): Promise<CollabGroupRecord>
  updateGroup(
    groupId: string,
    patch: { title?: string; objective?: string },
  ): Promise<CollabGroupRecord>
  manageChannel(
    groupId: string,
    input: { op: 'create' | 'subscribe' | 'unsubscribe' | 'archive'; channel: string; topic?: string; member?: string },
  ): Promise<CollabGroupRecord>
  addMemberWithBrief(
    groupId: string,
    member: Omit<GroupMemberState, 'readCursorSeq' | 'pendingWakeupSeq' | 'lastWakeTaskSeq'>,
    briefPrompt: string,
  ): Promise<{ group: CollabGroupRecord; member: GroupMemberState; post: BoardPost }>
  appendPost(
    groupId: string,
    draft: {
      channel: string
      from: string
      to: string[]
      resolvedTargets: string[]
      wake: boolean
      kind: BoardPostKind
      refs: number[]
      body: string
      idempotencyKey?: string
      worktreeSnapshot?: WorktreeHandoffSnapshot
      lastStallWatermarkAfterPost?: string
    },
  ): Promise<BoardPost>
  mutateGroup<T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ): Promise<T>
  onMemberTurnSettled(input: {
    groupId: string
    memberName: string
    conversationId: number
    completionSeq: number
    outcome: TurnOutcome
    error?: string
    lastReplySummary: string
  }): Promise<void>
  onCoordinatorTurnSettled(conversationId: number): Promise<void>
}

/** 模块间运行时协调契约（解耦 swarm.ts 与 actions/hooks/group-store 子模块）。 */
export interface SwarmCoordinator {
  isActive(): boolean
  isShutdown(): boolean
  getConfig(): SwarmConfig
  getDocs(): SwarmDocs
  readIndex(): SwarmIndexDoc
  writeIndex(next: SwarmIndexDoc): SwarmIndexDoc
  readConversationOrUndefined(id: number | undefined): ConversationSummary | undefined
  reportError(title: string, detail: unknown): void
  enqueueDispatch<T>(task: () => Promise<T>): Promise<T>
  track<T>(label: string, task: () => MaybePromise<T>): Promise<T>
  groups: CollabGroupRuntime
  settlingWorkers: Map<number, number>
}

// ---------------------------------------------------------------------------
// 边界守卫与纯校验函数
// ---------------------------------------------------------------------------

export function isPosIntId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

export function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

export function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function isBoardPostKind(v: unknown): v is BoardPostKind {
  return typeof v === 'string' && (BOARD_POST_KINDS as readonly string[]).includes(v)
}

/** 即时读取并严格校验配置：非法显式抛错，绝不静默取默认。 */
export function resolveSwarmConfig(raw: Record<string, unknown>): SwarmConfig {
  const err = (msg: string): HelmxError =>
    new HelmxError('swarm_config_invalid', `${SWARM_PLUGIN_ID} 配置非法：${msg}`, 500, { pluginId: SWARM_PLUGIN_ID })
  const readBoundedInt = (key: keyof SwarmConfig, min: number, max: number): number => {
    if (key in raw && raw[key] !== undefined) {
      const v = raw[key]
      if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isFinite(v) || v < min || v > max) {
        throw err(`字段 ${key} 必须是 ${min}..${max} 整数（实际：${String(v)}）`)
      }
      return v
    }
    return DEFAULT_SWARM_CONFIG[key]
  }
  return {
    maxWorkersPerGroup: readBoundedInt('maxWorkersPerGroup', 2, 32),
    boardPreviewLimit: readBoundedInt('boardPreviewLimit', 20, 200),
  }
}

export function asConversationUpsertEvent(
  payload: unknown,
): { id: number; status: string; updatedAt: number } | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.upsert') return undefined
  const conversation = payload['conversation']
  if (!isJsonObject(conversation)) return undefined
  const id = conversation['id']
  const status = conversation['status']
  const updatedAt = conversation['updatedAt']
  if (!isPosIntId(id)) return undefined
  if (typeof status !== 'string') return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined
  return { id, status, updatedAt }
}

export function asConversationDeletedEvent(payload: unknown): number | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  const conversationId = payload['conversationId']
  return isPosIntId(conversationId) ? conversationId : undefined
}

/** 成员短名强校验：小写字母开头，1..32 位小写字母/数字/连字符/下划线，且非保留字。 */
export function assertMemberName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HelmxError('validation_error', `成员名必须是字符串（收到：${String(value)}）`, 400, {})
  }
  const trimmed = value.trim()
  if (!MEMBER_NAME_RE.test(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `成员名 '${value}' 非法（需 1..32 位小写字母开头，仅含 [a-z0-9_-]）`,
      400,
      { name: value },
    )
  }
  if (RESERVED_MEMBER_NAMES.has(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `成员名 '${trimmed}' 是系统保留字（禁止使用 coordinator / all / system）`,
      400,
      { name: trimmed },
    )
  }
  return trimmed
}

/** 频道名强校验：小写字母开头，1..40 位 [a-z0-9_-]（不带前导 #）。 */
export function assertChannelName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HelmxError('validation_error', `频道名必须是字符串（收到：${String(value)}）`, 400, {})
  }
  const trimmed = value.trim()
  if (!CHANNEL_NAME_RE.test(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `频道名 '${value}' 非法（需 1..40 位小写字母开头，仅含 [a-z0-9_-]，不含前导 #）`,
      400,
      { channel: value },
    )
  }
  return trimmed
}

/** 协作组 ID 强校验（防路径穿越）。 */
export function assertGroupId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HelmxError('validation_error', `groupId 必须是字符串（收到：${String(value)}）`, 400, {})
  }
  const trimmed = value.trim()
  if (!GROUP_ID_RE.test(trimmed)) {
    throw new HelmxError('validation_error', `groupId '${value}' 非法（需 1..64 位 [A-Za-z0-9_-]）`, 400, { groupId: value })
  }
  return trimmed
}

export function assertBoardPostKind(value: unknown): BoardPostKind {
  if (!isBoardPostKind(value)) {
    throw new HelmxError(
      'validation_error',
      `kind 非法（期望 ${BOARD_POST_KINDS.join(' | ')}，收到：${String(value)}）`,
      400,
      {},
    )
  }
  return value
}

export function toGroupSummary(record: CollabGroupRecord): CollabGroupSummary {
  return {
    id: record.id,
    title: record.title,
    coordinatorConversationId: record.coordinatorConversationId,
    status: record.status,
    ...(record.coordinatorDetached !== undefined ? { coordinatorDetached: record.coordinatorDetached } : {}),
    activeWorkerCount: record.members.filter((m) => m.lifecycle === 'active').length,
    headSeq: record.headSeq,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.closedAt !== undefined ? { closedAt: record.closedAt } : {}),
  }
}

export function assertIndexDoc(value: unknown): SwarmIndexDoc {
  const corrupt = (detail: string): HelmxError =>
    new HelmxError('swarm_doc_corrupt', `插件 doc ${INDEX_DOC_NAME} ${detail}`, 500, { pluginId: SWARM_PLUGIN_ID })
  if (!isJsonObject(value) || !Array.isArray(value.workers) || !Array.isArray(value.groups)) {
    throw corrupt('结构非法（期望 { workers: [], groups: [] }）')
  }
  const seenWorkerIds = new Set<number>()
  for (const w of value.workers) {
    if (
      !isJsonObject(w) ||
      !isPosIntId(w.conversationId) ||
      !isPosIntId(w.coordinatorConversationId) ||
      typeof w.profileId !== 'string' ||
      w.profileId.trim() === '' ||
      typeof w.groupId !== 'string' ||
      w.groupId.trim() === '' ||
      typeof w.name !== 'string' ||
      w.name.trim() === '' ||
      !isFiniteTime(w.createdAt)
    ) {
      throw corrupt('workers 含非法条目')
    }
    if (seenWorkerIds.has(w.conversationId)) {
      throw corrupt(`workers 重复登记会话 #${w.conversationId}`)
    }
    seenWorkerIds.add(w.conversationId)
  }

  const seenGroupIds = new Set<string>()
  for (const g of value.groups) {
    if (
      !isJsonObject(g) ||
      typeof g.id !== 'string' ||
      g.id.trim() === '' ||
      typeof g.title !== 'string' ||
      g.title.trim() === '' ||
      !isPosIntId(g.coordinatorConversationId) ||
      (g.status !== 'active' && g.status !== 'closed') ||
      (g.coordinatorDetached !== undefined && typeof g.coordinatorDetached !== 'boolean') ||
      !isNonNegInt(g.activeWorkerCount) ||
      !isNonNegInt(g.headSeq) ||
      !isFiniteTime(g.createdAt) ||
      !isFiniteTime(g.updatedAt) ||
      (g.closedAt !== undefined && !isFiniteTime(g.closedAt))
    ) {
      throw corrupt('groups 含非法条目')
    }
    if (seenGroupIds.has(g.id)) {
      throw corrupt(`groups 重复登记协作组 '${g.id}'`)
    }
    seenGroupIds.add(g.id)
  }
  return value as unknown as SwarmIndexDoc
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function assertInflightBase(
  raw: unknown,
  label: string,
  corrupt: (detail: string) => HelmxError,
): Record<string, unknown> {
  if (!isJsonObject(raw)) throw corrupt(`${label} 必须是对象`)
  if (!isNonEmptyString(raw.requestId)) throw corrupt(`${label}.requestId 非法`)
  if (!isNonNegInt(raw.baseCompletionSeq)) throw corrupt(`${label}.baseCompletionSeq 非法`)
  if (!isNonNegInt(raw.baseLastEntryId)) throw corrupt(`${label}.baseLastEntryId 非法`)
  return raw
}

function assertInflightRangeIntent(
  raw: unknown,
  label: string,
  corrupt: (detail: string) => HelmxError,
): void {
  const obj = assertInflightBase(raw, label, corrupt)
  if (!isPosIntId(obj.fromSeq) || !isPosIntId(obj.toSeq) || obj.fromSeq > obj.toSeq) {
    throw corrupt(`${label} seq 范围非法`)
  }
}

export function assertCollabGroupRecord(value: unknown): CollabGroupRecord {
  const corrupt = (detail: string): HelmxError =>
    new HelmxError('swarm_doc_corrupt', `协作组 meta.json 损坏：${detail}`, 500, { pluginId: SWARM_PLUGIN_ID })
  if (!isJsonObject(value)) throw corrupt('顶层必须是对象')
  if (typeof value.id !== 'string' || !GROUP_ID_RE.test(value.id)) throw corrupt('id 非法')
  if (typeof value.title !== 'string' || value.title.trim() === '') throw corrupt('title 非法')
  if (value.objective !== undefined && typeof value.objective !== 'string') throw corrupt('objective 必须是字符串')
  if (!isPosIntId(value.coordinatorConversationId)) throw corrupt('coordinatorConversationId 必须是正整数')
  if (value.createKey !== undefined && !isNonEmptyString(value.createKey)) throw corrupt('createKey 非法')
  if (value.status !== 'active' && value.status !== 'closed') throw corrupt('status 非法')
  if (!Array.isArray(value.channels) || value.channels.length === 0) throw corrupt('channels 必须是非空数组')
  const seenChannels = new Set<string>()
  for (const ch of value.channels) {
    if (!isJsonObject(ch) || typeof ch.name !== 'string' || ch.name.trim() === '') throw corrupt('channel.name 非法')
    if (ch.topic !== undefined && typeof ch.topic !== 'string') throw corrupt('channel.topic 非法')
    if (ch.archived !== undefined && typeof ch.archived !== 'boolean') throw corrupt('channel.archived 非法')
    if (seenChannels.has(ch.name)) throw corrupt(`重复频道 '${ch.name}'`)
    seenChannels.add(ch.name)
  }
  if (!seenChannels.has('main')) throw corrupt("必须包含 'main' 频道")

  if (!Array.isArray(value.members)) throw corrupt('members 必须是数组')
  const seenNames = new Set<string>()
  for (const m of value.members) {
    if (
      !isJsonObject(m) ||
      typeof m.name !== 'string' ||
      m.name.trim() === '' ||
      !isPosIntId(m.conversationId) ||
      typeof m.profileId !== 'string' ||
      m.profileId.trim() === '' ||
      (m.access !== 'readwrite' && m.access !== 'readonly') ||
      (m.isolation !== 'inherit' && m.isolation !== 'worktree') ||
      typeof m.nodeId !== 'string' ||
      m.nodeId.trim() === '' ||
      typeof m.cwd !== 'string' ||
      m.cwd.trim() === '' ||
      (m.worktreeId !== undefined && (typeof m.worktreeId !== 'string' || m.worktreeId === '')) ||
      !Array.isArray(m.channels) ||
      !m.channels.every((c) => typeof c === 'string' && c !== '') ||
      (m.lifecycle !== 'active' && m.lifecycle !== 'archived') ||
      !isNonNegInt(m.readCursorSeq) ||
      !isNonNegInt(m.pendingWakeupSeq) ||
      (m.lastPostSeq !== undefined && !isPosIntId(m.lastPostSeq)) ||
      (m.lastWakeTaskSeq !== undefined && !isPosIntId(m.lastWakeTaskSeq)) ||
      (m.silentExitNudgeSeq !== undefined && !isPosIntId(m.silentExitNudgeSeq)) ||
      (m.lastWakeCompletionSeq !== undefined && !isNonNegInt(m.lastWakeCompletionSeq)) ||
      (m.dispatchKey !== undefined && !isNonEmptyString(m.dispatchKey)) ||
      (m.briefPostSeq !== undefined && !isPosIntId(m.briefPostSeq)) ||
      !isFiniteTime(m.createdAt) ||
      (m.archivedAt !== undefined && !isFiniteTime(m.archivedAt))
    ) {
      throw corrupt(`成员记录非法（${String(isJsonObject(m) ? m.name : m)}）`)
    }
    if (m.inflightWakeup !== undefined) {
      assertInflightRangeIntent(m.inflightWakeup, `成员 '${m.name}' inflightWakeup`, corrupt)
    }
    if (m.inflightNudge !== undefined) {
      const nudgeObj = assertInflightBase(m.inflightNudge, `成员 '${m.name}' inflightNudge`, corrupt)
      if (!isPosIntId(nudgeObj.taskSeq)) throw corrupt(`成员 '${m.name}' inflightNudge.taskSeq 非法`)
    }
    if (m.lastOutboundEdge !== undefined) {
      const edge = m.lastOutboundEdge
      if (
        !isJsonObject(edge) ||
        !isPosIntId(edge.seq) ||
        !Array.isArray(edge.to) ||
        !edge.to.every((t) => typeof t === 'string') ||
        !isBoardPostKind(edge.kind)
      ) {
        throw corrupt(`成员 '${m.name}' lastOutboundEdge 非法`)
      }
    }
    if (seenNames.has(m.name)) throw corrupt(`重复成员名 '${m.name}'`)
    seenNames.add(m.name)
  }

  if (!isNonNegInt(value.headSeq)) throw corrupt('headSeq 非法')
  if (!isNonNegInt(value.coordinatorNotifiedSeq)) throw corrupt('coordinatorNotifiedSeq 非法')
  if (!isNonNegInt(value.coordinatorPendingSeq)) throw corrupt('coordinatorPendingSeq 非法')
  if (value.inflightReport !== undefined) {
    assertInflightRangeIntent(value.inflightReport, 'inflightReport', corrupt)
  }
  if (value.lastStallWatermark !== undefined && typeof value.lastStallWatermark !== 'string') {
    throw corrupt('lastStallWatermark 非法')
  }
  if (value.coordinatorDetached !== undefined && typeof value.coordinatorDetached !== 'boolean') {
    throw corrupt('coordinatorDetached 非法')
  }
  if (value.retainedWorktrees !== undefined) {
    if (!Array.isArray(value.retainedWorktrees)) throw corrupt('retainedWorktrees 必须是数组')
    for (const rw of value.retainedWorktrees) {
      if (
        !isJsonObject(rw) ||
        typeof rw.memberName !== 'string' ||
        typeof rw.worktreeId !== 'string' ||
        typeof rw.branch !== 'string' ||
        typeof rw.path !== 'string' ||
        !isNonNegInt(rw.commitsAhead)
      ) {
        throw corrupt('retainedWorktrees 含非法项')
      }
    }
  }
  if (!isFiniteTime(value.createdAt) || !isFiniteTime(value.updatedAt)) throw corrupt('时间戳非法')
  if (value.closedAt !== undefined && !isFiniteTime(value.closedAt)) throw corrupt('closedAt 非法')
  if (value.closeSummary !== undefined && typeof value.closeSummary !== 'string') throw corrupt('closeSummary 非法')

  return value as unknown as CollabGroupRecord
}

export function assertBoardPost(value: unknown): BoardPost {
  const corrupt = (detail: string): HelmxError =>
    new HelmxError('swarm_doc_corrupt', `协作组 board.jsonl 记录损坏：${detail}`, 500, { pluginId: SWARM_PLUGIN_ID })
  if (!isJsonObject(value)) throw corrupt('记录必须是对象')
  if (!isPosIntId(value.seq)) throw corrupt('seq 必须是正整数')
  if (typeof value.groupId !== 'string' || value.groupId.trim() === '') throw corrupt('groupId 非法')
  if (typeof value.channel !== 'string' || value.channel.trim() === '') throw corrupt('channel 非法')
  if (typeof value.from !== 'string' || value.from.trim() === '') throw corrupt('from 非法')
  if (!Array.isArray(value.to) || !value.to.every((t) => typeof t === 'string' && t !== '')) throw corrupt('to 非法')
  if (!Array.isArray(value.resolvedTargets) || !value.resolvedTargets.every((t) => typeof t === 'string' && t !== '')) {
    throw corrupt('resolvedTargets 非法')
  }
  if (typeof value.wake !== 'boolean') throw corrupt('wake 必须是布尔值')
  if (!isBoardPostKind(value.kind)) throw corrupt('kind 非法')
  if (!Array.isArray(value.refs) || !value.refs.every((r) => isPosIntId(r))) throw corrupt('refs 必须是正整数数组')
  if (typeof value.body !== 'string') throw corrupt('body 必须是字符串')
  if (value.idempotencyKey !== undefined && !isNonEmptyString(value.idempotencyKey)) {
    throw corrupt('idempotencyKey 非法')
  }
  if (value.worktreeSnapshot !== undefined) {
    const snap = value.worktreeSnapshot
    if (
      !isJsonObject(snap) ||
      typeof snap.worktreeId !== 'string' ||
      snap.worktreeId === '' ||
      (snap.branch !== undefined && typeof snap.branch !== 'string') ||
      (snap.commitsAhead !== undefined && !isNonNegInt(snap.commitsAhead)) ||
      !isNonNegInt(snap.dirtyCount) ||
      !Array.isArray(snap.changedFilesPreview) ||
      !snap.changedFilesPreview.every((f) => typeof f === 'string')
    ) {
      throw corrupt('worktreeSnapshot 非法')
    }
  }
  if (!isFiniteTime(value.createdAt)) throw corrupt('createdAt 非法')
  return value as unknown as BoardPost
}
