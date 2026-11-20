/**
 * Pure domain models and lenient boundary parsers for the `builtin:tasks`
 * client surfaces (zero React/DOM dependencies, Fast Refresh compliant).
 *
 * Type shapes mirror the backend contracts 1:1 (packages/plugins backend owns
 * the authoritative contracts.ts; the client re-declares the wire shape so the
 * browser bundle never imports server modules — the plugin-client packaging
 * rule).
 *
 * Live-state derivation never fabricates progress: every fact (working /
 * blocked / error / pending ask / idle-not-submitted / missing conversation)
 * comes from the real `useConversations()` summary of the **main execution
 * conversation** plus the shared SDK background snapshot — no client-side
 * subtree traversal.
 */
import { DEFAULT_HELMX_LOCALE, type ConversationBackgroundSnapshot, type HelmxLocale } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol'
import {
  taskLiveConversationMissing,
  taskLiveErrorLine,
  taskLiveIdleNotSubmitted,
  taskLiveWaitingApproval,
} from './copy.ts'

// ---------------------------------------------------------------------------
// Shared contract types (100% aligned with the board doc projection)
// ---------------------------------------------------------------------------

export type TaskColumn = 'backlog' | 'in_progress' | 'in_review' | 'done'

export const TASK_COLUMNS: readonly TaskColumn[] = ['backlog', 'in_progress', 'in_review', 'done']

/** Semantic tone of every column header dot (data-tone vocabulary shared with the mobile pills). */
export const TASK_COLUMN_TONE: Readonly<Record<TaskColumn, 'neutral' | 'accent' | 'warn' | 'ok'>> = {
  backlog: 'neutral',
  in_progress: 'accent',
  in_review: 'warn',
  done: 'ok',
}

export interface TaskSubmission {
  summary: string
  verification?: string
  branch?: string
  worktreePath?: string
  changedFiles?: string[]
  artifactIds?: string[]
  submittedAt: number
}

export interface TaskRecord {
  id: string
  title: string
  brief: string
  column: TaskColumn
  project?: string
  assigneeProfileId: string
  nodeId?: string
  cwd?: string
  model?: string
  thinkingLevel?: string
  originConversationId?: number
  conversationId?: number
  conversationMissing?: boolean
  submission?: TaskSubmission
  reworkCount: number
  lastReworkFeedback?: string
  archived?: boolean
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
}

export interface TaskBoardDoc {
  tasks: TaskRecord[]
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Lenient boundary parsers (an invalid or unloaded doc must never crash the UI)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function parseSubmission(value: unknown): TaskSubmission | undefined {
  if (!isRecord(value)) return undefined
  const summary = parseString(value['summary'])
  if (summary === undefined) return undefined
  return {
    summary,
    verification: parseString(value['verification']),
    branch: parseString(value['branch']),
    worktreePath: parseString(value['worktreePath']),
    changedFiles: parseStringArray(value['changedFiles']),
    artifactIds: parseStringArray(value['artifactIds']),
    submittedAt: parseNumber(value['submittedAt']) ?? 0,
  }
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}

function parseTaskColumn(value: unknown): TaskColumn | undefined {
  return typeof value === 'string' && (TASK_COLUMNS as readonly string[]).includes(value) ? (value as TaskColumn) : undefined
}

function parseTaskRecord(value: unknown): TaskRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = parseString(value['id'])
  const title = parseString(value['title'])
  const brief = typeof value['brief'] === 'string' ? value['brief'] : ''
  const column = parseTaskColumn(value['column'])
  if (id === undefined || title === undefined || column === undefined) return undefined
  return pruneUndefined({
    id,
    title,
    brief,
    column,
    project: parseString(value['project']),
    assigneeProfileId: parseString(value['assigneeProfileId']) ?? 'assistant',
    nodeId: parseString(value['nodeId']),
    cwd: parseString(value['cwd']),
    model: parseString(value['model']),
    thinkingLevel: parseString(value['thinkingLevel']),
    originConversationId: parseNumber(value['originConversationId']),
    conversationId: parseNumber(value['conversationId']),
    conversationMissing: parseBoolean(value['conversationMissing']),
    submission: parseSubmission(value['submission']),
    reworkCount: parseNumber(value['reworkCount']) ?? 0,
    lastReworkFeedback: parseString(value['lastReworkFeedback']),
    archived: parseBoolean(value['archived']),
    createdAt: parseNumber(value['createdAt']) ?? 0,
    updatedAt: parseNumber(value['updatedAt']) ?? 0,
    startedAt: parseNumber(value['startedAt']),
    completedAt: parseNumber(value['completedAt']),
  }) as TaskRecord
}

/** Lenient single-record parser (off-board deep links load the full record via inspect). */
export const parseTaskRecordLenient = parseTaskRecord

/** Lenient board doc parser: structurally invalid payloads return undefined (the caller must show an explicit invalid state, never a fake empty board). */
export function parseTaskBoardDoc(raw: unknown): TaskBoardDoc | undefined {
  if (!isRecord(raw) || !Array.isArray(raw['tasks'])) return undefined
  const tasks: TaskRecord[] = []
  for (const item of raw['tasks']) {
    const parsed = parseTaskRecord(item)
    if (parsed !== undefined) tasks.push(parsed)
  }
  return { tasks, updatedAt: parseNumber(raw['updatedAt']) ?? 0 }
}

// ---------------------------------------------------------------------------
// Overview card meta lookup (OVERVIEW_CARD_META_SLOT contribution)
// ---------------------------------------------------------------------------

/** Rank within the same match bucket: non-archived wins, then newer updatedAt, then id (deterministic). */
function preferOverviewTask(candidate: TaskRecord, current: TaskRecord | undefined): boolean {
  if (current === undefined) return true
  const candidateArchived = candidate.archived === true
  const currentArchived = current.archived === true
  if (candidateArchived !== currentArchived) return !candidateArchived
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  return candidate.id > current.id
}

/**
 * Pure lookup for the read-only overview card pill: find the task bound to a
 * conversation tree. Priority: exact root-conversation match first, then any
 * tree member (sub-sessions); within a bucket non-archived records win over
 * archived history, newest updatedAt over older. No match returns undefined
 * (the pill renders nothing — zero visual residue).
 */
export function findTaskForOverviewCard(
  tasks: readonly TaskRecord[],
  rootConversationId: number | undefined,
  memberIds: ReadonlyArray<number> | undefined,
): TaskRecord | undefined {
  const memberSet = memberIds === undefined ? undefined : new Set(memberIds)
  const rootHit = rootConversationId === undefined ? undefined : findTaskForConversation(tasks, rootConversationId)
  let memberHit: TaskRecord | undefined
  for (const task of tasks) {
    const conversationId = task.conversationId
    if (conversationId === undefined) continue
    if (conversationId !== rootConversationId && memberSet !== undefined && memberSet.has(conversationId)) {
      if (preferOverviewTask(task, memberHit)) memberHit = task
    }
  }
  return rootHit ?? memberHit
}

/**
 * Pure lookup for the conversation header task badge (ctx.ui.action
 * conversation:header contribution): find the task whose execution
 * conversation is exactly this one. Same ranking as the overview pill
 * (non-archived wins, then newer updatedAt, then id). No match — including
 * done-history tasks truncated out of the board projection (>50 archived) —
 * returns undefined (the badge renders nothing, zero visual residue).
 */
export function findTaskForConversation(
  tasks: readonly TaskRecord[],
  conversationId: number,
): TaskRecord | undefined {
  let hit: TaskRecord | undefined
  for (const task of tasks) {
    if (task.conversationId !== conversationId) continue
    if (preferOverviewTask(task, hit)) hit = task
  }
  return hit
}

// ---------------------------------------------------------------------------
// Live view derivation (honest, zero fabricated progress — main conversation + background snapshot only)
// ---------------------------------------------------------------------------

/** Light vocabulary for a task card: error > blocked > main working > background active > main done > idle. */
export type TaskLightStatus = 'error' | 'blocked' | 'running' | 'background' | 'done' | 'idle'

/**
 * Shared StatusLight word mapping (tone normalization lives in the SDK):
 * 'background' MUST map to 'working' — the SDK alias table has no 'background'
 * entry, so passing it raw degrades to the neutral pending ring (cards and
 * receipts light up while the drawer goes gray). All client surfaces use this.
 */
export function taskLightWord(status: TaskLightStatus): string {
  if (status === 'error') return 'error'
  if (status === 'blocked') return 'blocked'
  if (status === 'running' || status === 'background') return 'working'
  if (status === 'done') return 'done'
  return 'idle'
}

/**
 * Background in-flight facts parameter: the shared SDK
 * `useConversationBackground()` snapshot shape (single source of truth in
 * @helmx/plugin-client — host-standard workbench badge aggregation with an
 * honest unknown gate).
 */
export type TaskBackgroundFacts = ConversationBackgroundSnapshot

export interface TaskLiveView {
  lightStatus: TaskLightStatus
  /** The bound execution conversation no longer exists (deleted by a human); honest flag, never auto-resolved. */
  conversationMissing: boolean
  /** in_progress tasks with blocked / error / missing conversation. */
  needsAttention: boolean
  /** Real live facts only: lastError / doing / background summary / idle-not-submitted / missing. */
  liveSummary: string
  /** The main execution conversation waits on a human Ask (approval / question). */
  approvalPending: boolean
  /** A background run is in flight for the main conversation (generic workbench badge facts, plugin-ID free). */
  backgroundActive: boolean
  /** Pure derivation: in_progress, main conversation idle, no background in flight — settled without a submission. */
  idleNotSubmitted: boolean
  /** task.project wins; otherwise the cwd basename (empty when neither is known). */
  projectLabel: string
  /** backlog cards are always startable (pure ledger, no dependency scheduling). */
  isReadyToStart: boolean
}

/** Extract the last path segment of an absolute working directory (POSIX or Windows separators); empty when absent. */
export function cwdBasename(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') return ''
  const normalized = cwd.replace(/[\\/]+$/, '')
  const lastSegment = normalized.split(/[\\/]/).pop() ?? ''
  return lastSegment.trim()
}

/** Resolve the pending-ask count for a conversation (explicit override wins, else the summary's own field). */
function pendingAskCountOf(conv: ConversationSummary, pendingAsks: Readonly<Record<number, number>> | undefined): number {
  const override = pendingAsks?.[conv.id]
  if (typeof override === 'number' && Number.isFinite(override)) return override
  return conv.pendingAskCount
}

/**
 * Derive the honest live view of one task from the **main** execution
 * conversation summary plus the shared SDK background snapshot:
 * - the main conversation status drives the light, never percentages;
 * - a missing execution conversation is flagged, not fabricated;
 * - "idle, not submitted" is a pure derivation: column in_progress + main idle
 *   + no background in flight (zero server-side stall bookkeeping).
 */
export function deriveTaskLiveView(
  task: TaskRecord,
  conversations: readonly ConversationSummary[],
  pendingAsks?: Readonly<Record<number, number>>,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  background?: TaskBackgroundFacts,
): TaskLiveView {
  const main = task.conversationId !== undefined
    ? conversations.find((conv) => conv.id === task.conversationId)
    : undefined
  const conversationMissing = task.conversationId !== undefined && main === undefined
  const approvalPending = main !== undefined && main.status === 'blocked' && pendingAskCountOf(main, pendingAsks) > 0

  // Background in-flight facts from the shared SDK snapshot (host-standard workbench
  // badge aggregation). `unknown === true` (docs still loading / host without
  // aggregation) means facts are UNKNOWABLE: no inference either way — we never
  // fabricate "in flight" nor claim "no background work".
  const backgroundSummaries: string[] = []
  let backgroundActive = false
  if (background !== undefined && background.unknown !== true && task.conversationId !== undefined) {
    const fact = background.byConversation.get(task.conversationId)
    if (fact?.active === true) {
      backgroundActive = true
      const summary = fact.summary.trim()
      if (summary !== '') backgroundSummaries.push(summary)
    }
  }

  let lightStatus: TaskLightStatus
  if (main?.status === 'error' || conversationMissing) lightStatus = 'error'
  else if (main?.status === 'blocked') lightStatus = 'blocked'
  else if (main?.status === 'working') lightStatus = 'running'
  else if (backgroundActive) lightStatus = 'background'
  else if (main?.status === 'done') lightStatus = 'done'
  else lightStatus = 'idle'

  const idleNotSubmitted =
    task.column === 'in_progress' && !conversationMissing && main?.status === 'idle' && !backgroundActive

  const needsAttention =
    task.column === 'in_progress' &&
    (lightStatus === 'blocked' || lightStatus === 'error' || conversationMissing || task.conversationMissing === true)

  return {
    lightStatus,
    conversationMissing: conversationMissing || task.conversationMissing === true,
    needsAttention,
    liveSummary: buildLiveSummary({ task, lightStatus, main, approvalPending, backgroundSummaries, idleNotSubmitted, conversationMissing, pendingAsks }, locale),
    approvalPending,
    backgroundActive,
    idleNotSubmitted,
    projectLabel: task.project !== undefined && task.project !== '' ? task.project : cwdBasename(task.cwd),
    isReadyToStart: task.column === 'backlog',
  }
}

interface LiveSummaryInputs {
  task: TaskRecord
  lightStatus: TaskLightStatus
  main: ConversationSummary | undefined
  approvalPending: boolean
  backgroundSummaries: readonly string[]
  idleNotSubmitted: boolean
  conversationMissing: boolean
  pendingAsks: Readonly<Record<number, number>> | undefined
}

/** Build the one-line live summary from real facts (error first, then blocked [approval], running, background, idle-not-submitted, missing). */
function buildLiveSummary(inputs: LiveSummaryInputs, locale: HelmxLocale): string {
  const { task, lightStatus, main, approvalPending, backgroundSummaries, idleNotSubmitted, conversationMissing } = inputs
  if (conversationMissing) return taskLiveConversationMissing(locale)
  if (lightStatus === 'error') {
    const line = main?.lastError
    if (line !== undefined && line !== '') return taskLiveErrorLine(line, locale)
  }
  if (lightStatus === 'blocked') {
    return taskLiveWaitingApproval(main?.doing, locale, approvalPending)
  }
  if (lightStatus === 'running') {
    const doing = main?.doing
    if (doing !== undefined && doing !== '') return doing
  }
  if (lightStatus === 'background' && backgroundSummaries.length > 0) {
    return backgroundSummaries.join(' · ')
  }
  if (idleNotSubmitted) return taskLiveIdleNotSubmitted(locale)
  return ''
}

// ---------------------------------------------------------------------------
// Board projection: per-task live views + column / mobile bucketing
// ---------------------------------------------------------------------------

export interface TaskItem {
  task: TaskRecord
  live: TaskLiveView
}

/** Stable comparator: needsAttention on top, then createdAt descending (never updatedAt — streaming must not jump cards). */
function compareTaskItems(a: TaskItem, b: TaskItem): number {
  if (a.live.needsAttention !== b.live.needsAttention) return a.live.needsAttention ? -1 : 1
  if ((a.task.archived === true) !== (b.task.archived === true)) return a.task.archived === true ? 1 : -1
  if (a.task.createdAt !== b.task.createdAt) return b.task.createdAt - a.task.createdAt
  return b.task.id.localeCompare(a.task.id)
}

/** Derive the live view of every board task (single pass, shared conversations index). */
export function deriveBoardItems(
  tasks: readonly TaskRecord[],
  conversations: readonly ConversationSummary[],
  pendingAsks?: Readonly<Record<number, number>>,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  background?: TaskBackgroundFacts,
): TaskItem[] {
  return tasks.map((task) => ({
    task,
    live: deriveTaskLiveView(task, conversations, pendingAsks, locale, background),
  }))
}

export type TaskColumnBuckets = Record<TaskColumn, TaskItem[]>

/** Desktop four-column bucketing with the stable needsAttention-first ordering. */
export function bucketByColumn(items: readonly TaskItem[]): TaskColumnBuckets {
  const buckets: TaskColumnBuckets = { backlog: [], in_progress: [], in_review: [], done: [] }
  for (const item of items) buckets[item.task.column].push(item)
  for (const key of TASK_COLUMNS) buckets[key].sort(compareTaskItems)
  return buckets
}

/**
 * Mobile tab vocabulary: `all` is the Notion-style grouped collapsible list
 * (attention -> in_review -> in_progress -> backlog -> done, done collapsed by
 * default); the other tabs filter down to one bucket and persist `tab=<id>`
 * in the URL for deep linking.
 */
export type TaskMobileTab = 'all' | 'attention' | 'in_review' | 'in_progress' | 'backlog' | 'done'

export const TASK_MOBILE_TABS: readonly TaskMobileTab[] = ['all', 'attention', 'in_review', 'in_progress', 'backlog', 'done']

/** Group order inside the mobile `all` view (highest owner priority first). */
export const TASK_MOBILE_GROUP_ORDER: readonly Exclude<TaskMobileTab, 'all'>[] = [
  'attention',
  'in_review',
  'in_progress',
  'backlog',
  'done',
]

/** Semantic tone of every mobile pill dot (`all` carries no dot by design). */
export const TASK_MOBILE_TAB_TONE: Readonly<Record<Exclude<TaskMobileTab, 'all'>, 'err' | 'warn' | 'accent' | 'neutral' | 'ok'>> = {
  attention: 'err',
  in_review: 'warn',
  in_progress: 'accent',
  backlog: 'neutral',
  done: 'ok',
}

export type TaskMobileBuckets = Record<Exclude<TaskMobileTab, 'all'>, TaskItem[]>

/**
 * Mobile five-bucket clear-down flow (+ optional grouped done view):
 * - attention: every task needing the owner (blocked / error / missing conversation);
 * - the rest follow their workflow column.
 */
export function bucketMobile(items: readonly TaskItem[]): TaskMobileBuckets {
  const buckets: TaskMobileBuckets = { attention: [], in_review: [], in_progress: [], backlog: [], done: [] }
  for (const item of items) {
    if (item.live.needsAttention) buckets.attention.push(item)
    else buckets[item.task.column].push(item)
  }
  for (const key of TASK_MOBILE_GROUP_ORDER) buckets[key].sort(compareTaskItems)
  return buckets
}

/**
 * Resolve the effective mobile tab: an explicit URL tab always wins (deep-link
 * fidelity); an unset param defaults to the grouped `all` view so the board
 * never lands on an empty bucket while other columns hold work.
 */
export function resolveDefaultMobileTab(explicit: TaskMobileTab | undefined): TaskMobileTab {
  return explicit ?? 'all'
}

// ---------------------------------------------------------------------------
// Filters and ScreenProps.params codec (q / project / assignee / node / tab / task / archived)
// ---------------------------------------------------------------------------

export interface TaskFilterState {
  query: string
  project: string
  assignee: string
  node: string
}

export interface TaskScreenParams {
  filter: TaskFilterState
  tab: TaskMobileTab
  taskId: string | undefined
  /** 归档历史开关：true 时已完成/待办列附带展示已归档卡（淡化 + 已归档徽标）。 */
  showArchived: boolean
}

/** Parse the URL params (deep-link restore is the single source of truth for filters). */
export function parseTaskScreenParams(params: Readonly<Record<string, string>>): TaskScreenParams {
  const tab = params['tab']
  return {
    filter: {
      query: params['q'] ?? '',
      project: params['project'] ?? '',
      assignee: params['assignee'] ?? '',
      node: params['node'] ?? '',
    },
    tab:
      typeof tab === 'string' && (TASK_MOBILE_TABS as readonly string[]).includes(tab)
        ? (tab as TaskMobileTab)
        : resolveDefaultMobileTab(undefined),
    taskId: params['task'] !== undefined && params['task'] !== '' ? params['task'] : undefined,
    showArchived: params['archived'] === '1',
  }
}

/** Count active property filters (project / assignee / node) for the mobile filter toggle badge. */
export function countActivePropertyFilters(filter: TaskFilterState): number {
  let count = 0
  if (filter.project !== '') count += 1
  if (filter.assignee !== '') count += 1
  if (filter.node !== '') count += 1
  return count
}

/** Keyword filter across real task facts (title / id / project / assignee / cwd). */
export function filterTaskItems(items: readonly TaskItem[], filter: TaskFilterState, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): TaskItem[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter(({ task, live }) => {
    if (filter.project !== '' && live.projectLabel !== filter.project && task.project !== filter.project) return false
    if (filter.assignee !== '' && task.assigneeProfileId !== filter.assignee) return false
    if (filter.node !== '' && (task.nodeId ?? '') !== filter.node) return false
    if (query === '') return true
    const haystack = [task.title, task.id, live.projectLabel, task.assigneeProfileId, task.cwd ?? '']
      .map((part) => part.toLowerCase())
      .join(' ')
    return haystack.includes(query)
  })
}

export interface TaskFilterOptions {
  projects: string[]
  assignees: string[]
  nodes: string[]
}

/** Aggregate filter options from the visible tasks (unique + sorted, honest — only real values). */
export function collectFilterOptions(items: readonly TaskItem[]): TaskFilterOptions {
  const projects = new Set<string>()
  const assignees = new Set<string>()
  const nodes = new Set<string>()
  for (const { task, live } of items) {
    if (live.projectLabel !== '') projects.add(live.projectLabel)
    if (task.assigneeProfileId !== '') assignees.add(task.assigneeProfileId)
    if (task.nodeId !== undefined && task.nodeId !== '') nodes.add(task.nodeId)
  }
  const sorted = (set: Set<string>): string[] => [...set].sort((a, b) => a.localeCompare(b))
  return { projects: sorted(projects), assignees: sorted(assignees), nodes: sorted(nodes) }
}

// ---------------------------------------------------------------------------
// Tool view fact extraction (lenient parse of tool input + structured result)
// ---------------------------------------------------------------------------

/** Task tool verb family (create / start / submit / approve / rework). */
export type TaskToolVerb = 'create' | 'start' | 'submit' | 'approve' | 'rework'

/**
 * Lenient verb extraction covering both the contract short names (`task_create`)
 * and hashed exposeAsTool derivations (`tasks_create_ab12cd34`): matching stays
 * name-structure based, never plugin-ID based.
 */
export function parseTaskToolVerb(toolName: string): TaskToolVerb | undefined {
  const match = /(?:^|_)tasks?_(create|start|submit|approve|rework)(?:_|$)/.exec(toolName)
  return (match?.[1] as TaskToolVerb | undefined) ?? undefined
}

export interface TaskToolFacts {
  taskId: string | undefined
  title: string | undefined
  conversationId: number | undefined
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Lenient extraction of the task pointer from any task_* tool payload (input or structured result). */
export function parseTaskToolFacts(input: unknown, structured: unknown): TaskToolFacts {
  const inputRecord = readRecord(input)
  const resultRecord = readRecord(structured)
  const taskRecord = readRecord(resultRecord?.['task']) ?? readRecord(inputRecord?.['task'])
  const pickString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      const parsed = parseString(value)
      if (parsed !== undefined) return parsed
    }
    return undefined
  }
  const pickNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const parsed = parseNumber(value)
      if (parsed !== undefined) return parsed
    }
    return undefined
  }
  return {
    taskId: pickString(taskRecord?.['id'], resultRecord?.['taskId'], inputRecord?.['taskId'], inputRecord?.['id']),
    title: pickString(taskRecord?.['title'], inputRecord?.['title']),
    conversationId: pickNumber(resultRecord?.['conversationId'], taskRecord?.['conversationId'], inputRecord?.['conversationId']),
  }
}
