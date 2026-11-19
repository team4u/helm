/**
 * Pure domain models and lenient boundary parsers for the `builtin:tasks`
 * client surfaces (zero React/DOM dependencies, Fast Refresh compliant).
 *
 * Type shapes mirror the Slice 2/3 shared contract 1:1 (packages/plugins
 * backend owns the authoritative contracts.ts; the client re-declares the
 * wire shape so the browser bundle never imports server modules — the
 * plugin-client packaging rule).
 *
 * Live-state derivation never fabricates progress: every fact (working /
 * blocked / error / pending ask / stalled / missing conversation) comes from
 * the real `useConversations()` summaries or the task record itself.
 */
import { DEFAULT_HELMX_LOCALE, type ConversationBackgroundSnapshot, type HelmxLocale } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol'
import {
  taskLiveConversationMissing,
  taskLiveErrorLine,
  taskLiveIdleWaiting,
  taskLiveSubSessionConfirm,
  taskLiveSubSessions,
  taskLiveTurnSettled,
  taskLiveWaitingApproval,
} from './copy.ts'

// ---------------------------------------------------------------------------
// Shared contract types (100% aligned with the board doc projection)
// ---------------------------------------------------------------------------

export type TaskColumn = 'backlog' | 'in_progress' | 'in_review' | 'done'

export const TASK_COLUMNS: readonly TaskColumn[] = ['backlog', 'in_progress', 'in_review', 'done']

export interface TaskSubmission {
  summary: string
  verification?: string
  branch?: string
  worktreePath?: string
  changedFiles?: string[]
  artifactIds?: string[]
  submittedAt: number
}

export interface TaskSilenceState {
  nudgedAt?: number
  stalledAt?: number
  lastError?: string
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
  planFirst?: boolean
  autoMerge?: boolean
  dependsOn: string[]
  autoStartOnUnblock?: boolean
  originConversationId?: number
  conversationId?: number
  conversationMissing?: boolean
  submission?: TaskSubmission
  reworkCount: number
  lastReworkFeedback?: string
  mergePending?: boolean
  silenceState?: TaskSilenceState
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
  const items = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return items.length > 0 ? items : []
}

function parseSubmission(value: unknown): TaskSubmission | undefined {
  if (!isRecord(value)) return undefined
  const summary = parseString(value['summary'])
  if (summary === undefined) return undefined
  const changedFiles = Array.isArray(value['changedFiles'])
    ? value['changedFiles'].filter((f): f is string => typeof f === 'string' && f !== '')
    : undefined
  const artifactIds = Array.isArray(value['artifactIds'])
    ? value['artifactIds'].filter((f): f is string => typeof f === 'string' && f !== '')
    : undefined
  return pruneUndefined({
    summary,
    verification: parseString(value['verification']),
    branch: parseString(value['branch']),
    worktreePath: parseString(value['worktreePath']),
    changedFiles,
    artifactIds,
    submittedAt: parseNumber(value['submittedAt']) ?? 0,
  })
}

function parseSilenceState(value: unknown): TaskSilenceState | undefined {
  if (!isRecord(value)) return undefined
  const parsed = pruneUndefined({
    nudgedAt: parseNumber(value['nudgedAt']),
    stalledAt: parseNumber(value['stalledAt']),
    lastError: parseString(value['lastError']),
  })
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseTaskColumn(value: unknown): TaskColumn | undefined {
  return typeof value === 'string' && (TASK_COLUMNS as readonly string[]).includes(value) ? (value as TaskColumn) : undefined
}

/** Drop undefined-valued keys so optional fields stay truly absent (prevents `"x" in obj` surprises). */
function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}

/** Lenient single-record parser (inspect-action payloads, off-board deep links). */
export function parseTaskRecordLenient(value: unknown): TaskRecord | undefined {
  return parseTaskRecord(value)
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
    planFirst: parseBoolean(value['planFirst']),
    autoMerge: parseBoolean(value['autoMerge']),
    dependsOn: parseStringArray(value['dependsOn']) ?? [],
    autoStartOnUnblock: parseBoolean(value['autoStartOnUnblock']),
    originConversationId: parseNumber(value['originConversationId']),
    conversationId: parseNumber(value['conversationId']),
    conversationMissing: parseBoolean(value['conversationMissing']),
    submission: parseSubmission(value['submission']),
    reworkCount: parseNumber(value['reworkCount']) ?? 0,
    lastReworkFeedback: parseString(value['lastReworkFeedback']),
    mergePending: parseBoolean(value['mergePending']),
    silenceState: parseSilenceState(value['silenceState']),
    archived: parseBoolean(value['archived']),
    createdAt: parseNumber(value['createdAt']) ?? 0,
    updatedAt: parseNumber(value['updatedAt']) ?? 0,
    startedAt: parseNumber(value['startedAt']),
    completedAt: parseNumber(value['completedAt']),
  }) as TaskRecord
}

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
// Conversation subtree walk (cycle-defended, depth-capped)
// ---------------------------------------------------------------------------

/** Max traversal depth along parent -> child edges (defensive cap against corrupt parent links). */
const SUBTREE_MAX_DEPTH = 32

interface ConversationSubtree {
  main: ConversationSummary | undefined
  descendants: ConversationSummary[]
}

/** Collect the task's execution conversation plus every descendant (BFS, visited set, depth cap 32). */
function collectConversationSubtree(
  rootId: number | undefined,
  conversations: readonly ConversationSummary[],
): ConversationSubtree {
  if (rootId === undefined) return { main: undefined, descendants: [] }
  const byId = new Map<number, ConversationSummary>()
  const childrenOf = new Map<number, number[]>()
  for (const conv of conversations) {
    byId.set(conv.id, conv)
    const parent = conv.parentConversationId
    if (parent !== undefined) {
      const bucket = childrenOf.get(parent)
      if (bucket === undefined) childrenOf.set(parent, [conv.id])
      else bucket.push(conv.id)
    }
  }
  const main = byId.get(rootId)
  const descendants: ConversationSummary[] = []
  const visited = new Set<number>([rootId])
  let frontier: number[] = [rootId]
  for (let depth = 0; depth < SUBTREE_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: number[] = []
    for (const id of frontier) {
      for (const childId of childrenOf.get(id) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        const child = byId.get(childId)
        if (child !== undefined) descendants.push(child)
        next.push(childId)
      }
    }
    frontier = next
  }
  return { main, descendants }
}

// ---------------------------------------------------------------------------
// Live view derivation (honest, zero fabricated progress)
// ---------------------------------------------------------------------------

/** Light vocabulary for a task card: subtree error > blocked/pending ask > main working > descendants-or-background active > main done > idle. */
export type TaskLightStatus = 'error' | 'blocked' | 'running' | 'background' | 'done' | 'idle'

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
  /** in_progress tasks with blocked / error / stalled-not-submitted / missing conversation. */
  needsAttention: boolean
  /** Real live facts only: lastError / doing / active descendant or background summary / turn-settled-not-submitted / missing. */
  liveSummary: string
  /** Descendant conversations currently working or blocked. */
  activeChildCount: number
  /**
   * Direct-jump target: the failure site when the subtree errored, else the newest
   * conversation waiting on a human Ask, else the newest blocked conversation,
   * else the main execution conversation.
   */
  jumpConversationId: number | undefined
  /** task.project wins; otherwise the cwd basename (empty when neither is known). */
  projectLabel: string
  /** dependsOn ids known (on the board) and not done yet. */
  blockedBy: string[]
  /** dependsOn ids absent from the current board projection (done-truncated, archived, or deleted); never fabricated as blocking. */
  offBoardDeps: string[]
  /** backlog with every known dependency done (off-board deps do not block — the backend start action is the authoritative gate). */
  isReadyToStart: boolean
  /** A subtree conversation waits on a human Ask (approval question), distinct from errors and sub-session confirmation. */
  approvalPending: boolean
  /** A background run is in flight for a subtree conversation (generic workbench badge facts, plugin-ID free). */
  backgroundActive: boolean
  /** The turn settled without a submission AND nothing is provably in flight (honest, user-actionable state). */
  stalled: boolean
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
 * Derive the honest live view of one task from real conversation summaries:
 * - subtree statuses (main + descendants) drive the light, never percentages;
 * - a missing execution conversation is flagged, not fabricated;
 * - blockedBy reads the full task table (done deps unlock; unknown ids stay blocked).
 */
export function deriveTaskLiveView(
  task: TaskRecord,
  conversations: readonly ConversationSummary[],
  pendingAsks?: Readonly<Record<number, number>>,
  tasksById?: ReadonlyMap<string, TaskRecord>,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  background?: TaskBackgroundFacts,
): TaskLiveView {
  const { main, descendants } = collectConversationSubtree(task.conversationId, conversations)
  const conversationMissing = task.conversationId !== undefined && main === undefined

  const subtree = main !== undefined ? [main, ...descendants] : descendants
  const errorConvs = subtree.filter((conv) => conv.status === 'error')
  const blockedConvs = subtree.filter(
    (conv) => conv.status === 'blocked' || pendingAskCountOf(conv, pendingAsks) > 0,
  )
  const approvalPending =
    subtree.some((conv) => conv.status === 'blocked' && pendingAskCountOf(conv, pendingAsks) > 0) ||
    (main?.status === 'blocked' && pendingAskCountOf(main, pendingAsks) > 0)
  const activeChildren = descendants.filter((conv) => conv.status === 'working' || conv.status === 'blocked')
  const stalled = task.silenceState?.stalledAt

  // Background in-flight facts from the shared SDK snapshot (host-standard workbench
  // badge aggregation). `unknown === true` (docs still loading / host without
  // aggregation) means facts are UNKNOWABLE: no inference either way — we never
  // fabricate "in flight" nor claim "no background work".
  const backgroundSummaries: string[] = []
  let backgroundActive = false
  if (background !== undefined && background.unknown !== true) {
    for (const conv of subtree) {
      const fact = background.byConversation.get(conv.id)
      if (fact?.active === true) {
        backgroundActive = true
        const summary = fact.summary.trim()
        if (summary !== '' && !backgroundSummaries.includes(summary)) {
          backgroundSummaries.push(summary)
        }
      }
    }
  }

  let lightStatus: TaskLightStatus
  if (errorConvs.length > 0) lightStatus = 'error'
  else if (blockedConvs.length > 0) lightStatus = 'blocked'
  else if (main?.status === 'working') lightStatus = 'running'
  else if (activeChildren.length > 0 || backgroundActive) lightStatus = 'background'
  else if (main?.status === 'done') lightStatus = 'done'
  else lightStatus = 'idle'

  // Jump target priority: failure site > newest human-Ask conversation > newest blocked > main conversation.
  const byNewest = (a: ConversationSummary, b: ConversationSummary) => b.createdAt - a.createdAt || b.id - a.id
  let jumpConversationId = task.conversationId
  if (errorConvs.length > 0) {
    jumpConversationId = [...errorConvs].sort(byNewest)[0]?.id ?? task.conversationId
  } else {
    const askConvs = blockedConvs.filter((conv) => pendingAskCountOf(conv, pendingAsks) > 0)
    const candidates = askConvs.length > 0 ? askConvs : blockedConvs
    if (candidates.length > 0) {
      jumpConversationId = [...candidates].sort(byNewest)[0]?.id ?? task.conversationId
    }
  }

  // Known-not-done dependencies block; off-board ids (done-truncated / archived / deleted)
  // are surfaced separately and never fabricated as blocking — the backend start
  // action re-validates authoritatively.
  const blockedBy =
    tasksById === undefined
      ? []
      : task.dependsOn.filter((depId) => {
          const dep = tasksById.get(depId)
          return dep !== undefined && dep.column !== 'done'
        })
  const offBoardDeps = tasksById === undefined ? [] : task.dependsOn.filter((depId) => !tasksById.has(depId))

  // Stalled stays honest only when nothing else is provably in flight (a background run
  // continuing the work must not be misreported as "settled, not submitted").
  const effectiveStalled = backgroundActive ? undefined : stalled

  const needsAttention =
    task.column === 'in_progress' &&
    (lightStatus === 'blocked' ||
      lightStatus === 'error' ||
      effectiveStalled !== undefined ||
      conversationMissing ||
      task.conversationMissing === true)

  return {
    lightStatus,
    conversationMissing: conversationMissing || task.conversationMissing === true,
    needsAttention,
    liveSummary: buildLiveSummary(
      {
        task,
        lightStatus,
        errorConv: errorConvs[0],
        blockedConvs,
        approvalPending,
        main,
        activeChildren,
        stalled: effectiveStalled,
        conversationMissing,
        pendingAsks,
        backgroundSummaries,
      },
      locale,
    ),
    activeChildCount: activeChildren.length,
    jumpConversationId,
    projectLabel: task.project !== undefined && task.project !== '' ? task.project : cwdBasename(task.cwd),
    blockedBy,
    offBoardDeps,
    isReadyToStart: task.column === 'backlog' && blockedBy.length === 0,
    approvalPending,
    backgroundActive,
    stalled: effectiveStalled !== undefined,
  }
}

interface LiveSummaryInputs {
  task: TaskRecord
  lightStatus: TaskLightStatus
  errorConv: ConversationSummary | undefined
  blockedConvs: ConversationSummary[]
  approvalPending: boolean
  main: ConversationSummary | undefined
  activeChildren: ConversationSummary[]
  stalled: number | undefined
  conversationMissing: boolean
  pendingAsks: Readonly<Record<number, number>> | undefined
  backgroundSummaries: readonly string[]
}

/** Build the one-line live summary from real facts (error first, then blocked [approval vs sub-session], running, background, stalled, missing). */
function buildLiveSummary(inputs: LiveSummaryInputs, locale: HelmxLocale): string {
  const { task, lightStatus, errorConv, blockedConvs, approvalPending, main, activeChildren, stalled, conversationMissing, pendingAsks, backgroundSummaries } = inputs
  if (conversationMissing) return taskLiveConversationMissing(locale)
  if (lightStatus === 'error') {
    const line = errorConv?.lastError ?? task.silenceState?.lastError
    if (line !== undefined && line !== '') return taskLiveErrorLine(line, locale)
  }
  if (lightStatus === 'blocked') {
    const askConv = blockedConvs.find((conv) => pendingAskCountOf(conv, pendingAsks) > 0)
    const doing = (askConv ?? blockedConvs[0])?.doing
    // Waiting for approval (a human Ask) and waiting on a sub-session confirmation are
    // distinct facts; both differ from errors.
    return approvalPending ? taskLiveWaitingApproval(doing, locale) : taskLiveSubSessionConfirm(doing, locale)
  }
  if (lightStatus === 'running') {
    const doing = main?.doing
    if (doing !== undefined && doing !== '') return doing
  }
  if (lightStatus === 'background') {
    const parts: string[] = []
    if (activeChildren.length > 0) parts.push(taskLiveSubSessions(activeChildren.length, locale))
    parts.push(...backgroundSummaries)
    if (parts.length > 0) return parts.join(' · ')
  }
  if (stalled !== undefined) return taskLiveTurnSettled(locale)
  if (task.column === 'in_progress' && main?.status === 'idle' && backgroundSummaries.length === 0) {
    return taskLiveIdleWaiting(locale)
  }
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
  if (a.task.createdAt !== b.task.createdAt) return b.task.createdAt - a.task.createdAt
  return b.task.id.localeCompare(a.task.id)
}

/** Derive the live view of every board task (single pass, shared tasksById index). */
export function deriveBoardItems(
  tasks: readonly TaskRecord[],
  conversations: readonly ConversationSummary[],
  pendingAsks?: Readonly<Record<number, number>>,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  background?: TaskBackgroundFacts,
): TaskItem[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  return tasks.map((task) => ({
    task,
    live: deriveTaskLiveView(task, conversations, pendingAsks, tasksById, locale, background),
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

export type TaskMobileTab = 'attention' | 'in_review' | 'in_progress' | 'backlog' | 'done'

export const TASK_MOBILE_TABS: readonly TaskMobileTab[] = ['attention', 'in_review', 'in_progress', 'backlog', 'done']

export type TaskMobileBuckets = Record<TaskMobileTab, TaskItem[]>

/**
 * Mobile four-pillar clear-down flow (+ optional done view):
 * - attention: every task needing the owner (blocked / error / stalled / missing conversation);
 * - the rest follow their workflow column.
 */
export function bucketMobile(items: readonly TaskItem[]): TaskMobileBuckets {
  const buckets: TaskMobileBuckets = { attention: [], in_review: [], in_progress: [], backlog: [], done: [] }
  for (const item of items) {
    if (item.live.needsAttention) buckets.attention.push(item)
    else buckets[item.task.column].push(item)
  }
  for (const key of TASK_MOBILE_TABS) buckets[key].sort(compareTaskItems)
  return buckets
}

// ---------------------------------------------------------------------------
// Filters and ScreenProps.params codec (q / project / assignee / node / tab / task)
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
    tab: typeof tab === 'string' && (TASK_MOBILE_TABS as readonly string[]).includes(tab) ? (tab as TaskMobileTab) : 'attention',
    taskId: params['task'] !== undefined && params['task'] !== '' ? params['task'] : undefined,
  }
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
  /** approve results: tasks automatically unblocked / started downstream. */
  unblockedCount: number | undefined
  autoStartedCount: number | undefined
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
  const unblocked = parseStringArray(resultRecord?.['unblockedTaskIds'])
  const autoStarted = parseStringArray(resultRecord?.['autoStartedTaskIds'])
  return {
    taskId: pickString(taskRecord?.['id'], resultRecord?.['taskId'], inputRecord?.['taskId'], inputRecord?.['id']),
    title: pickString(taskRecord?.['title'], inputRecord?.['title']),
    conversationId: pickNumber(resultRecord?.['conversationId'], taskRecord?.['conversationId'], inputRecord?.['conversationId']),
    unblockedCount: unblocked !== undefined ? unblocked.length : parseNumber(resultRecord?.['unblockedCount']),
    autoStartedCount: autoStarted !== undefined ? autoStarted.length : parseNumber(resultRecord?.['autoStartedCount']),
  }
}
