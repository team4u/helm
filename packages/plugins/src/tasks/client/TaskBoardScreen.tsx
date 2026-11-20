/**
 * builtin:tasks board screen (`screen:builtin:tasks/board`), component exports
 * only (Fast Refresh compliant).
 *
 * Data: the public `board` doc projection (usePluginDoc) + live conversation
 * summaries (useConversations); every card status is derived from real facts
 * via the pure models (no fabricated progress, no polling). Filters, the
 * mobile tab and the selected task drawer persist in ScreenProps.params
 * (sp.* / ssp.* deep-link namespaces) — the only navigation mechanism.
 *
 * Layout (Notion-board alignment):
 * - desktop: calm column tracks (subtle surface + semantic dot + tabular
 *   count), a compact command bar (the host ScreenHost already renders the
 *   pane title — no duplicated big header) and a tight filter strip;
 * - mobile (<=680px): a horizontal scrollable status pill strip plus a
 *   grouped collapsible `all` view (attention first, done collapsed by
 *   default) so the board never lands on an empty bucket; property selects
 *   collapse behind a filter toggle to keep cards above the fold;
 * - card bodies of started tasks open the live conversation drawer in place;
 *   the card corner keeps detail and split-view (desktop) affordances.
 */
import { useMemo, useState } from 'react'
import { useId } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  HelmxIcon,
  MarkdownView,
  Select,
  StatusLight,
  formatDurationMs,
  useConversationBackground,
  useConversations,
  usePluginConfig,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useSharedNowMs,
} from '@helmx/plugin-client'
import {
  bucketByColumn,
  bucketMobile,
  collectFilterOptions,
  countActivePropertyFilters,
  deriveBoardItems,
  filterTaskItems,
  parseTaskBoardDoc,
  parseTaskRecordLenient,
  parseTaskScreenParams,
  TASK_COLUMNS,
  TASK_COLUMN_TONE,
  TASK_MOBILE_GROUP_ORDER,
  TASK_MOBILE_TABS,
  TASK_MOBILE_TAB_TONE,
  type TaskColumn,
  type TaskFilterState,
  type TaskItem,
  type TaskLightStatus,
  type TaskMobileTab,
  type TaskRecord,
} from './models.ts'
import {
  TASK_ACTION_APPROVE,
  TASK_ACTION_APPROVE_TITLE,
  TASK_ACTION_CONTINUE,
  TASK_ACTION_CONTINUE_TITLE,
  TASK_ACTION_DETAIL_BTN_TITLE,
  TASK_ACTION_DETAIL_LABEL,
  TASK_ACTION_MERGE_CLOSE,
  TASK_ACTION_MERGE_CLOSE_TITLE,
  TASK_ACTION_REWORK,
  TASK_ACTION_REWORK_TITLE,
  TASK_ACTION_OPEN_CONV_BTN,
  TASK_ACTION_OPEN_CONV_BTN_TITLE,
  TASK_ACTION_CONTINUE_REWORK_TITLE,
  TASK_ACTION_SPLIT,
  TASK_ACTION_SPLIT_LABEL,
  TASK_ACTION_START,
  TASK_ACTION_START_TITLE,
  TASK_ARCHIVE_ALL,
  TASK_ARCHIVE_ALL_TITLE,
  TASK_ARCHIVE_HISTORY_SHOW,
  TASK_ARCHIVE_HISTORY_HIDE,
  TASK_ARCHIVE_HISTORY_TITLE,
  TASK_ARCHIVE_HISTORY_HIDDEN_HINT,
  TASK_ARCHIVED_BADGE,
  TASK_ARCHIVED_EMPTY,
  TASK_ARCHIVING,
  TASK_BOARD_INVALID,
  TASK_BOARD_INVALID_HINT,
  TASK_BOARD_RELOADING,
  TASK_BOARD_RETRY,
  TASK_CHAT_TASK,
  TASK_CHAT_TASK_TITLE,
  TASK_DEPS_READY,
  TASK_DEPS_UNKNOWN,
  TASK_DEPS_UNKNOWN_TITLE,
  TASK_DEP_OFF_BOARD_TITLE,
  TASK_ACTION_RESUME_KICKOFF_TITLE,
  TASK_MERGE_AWAIT_REVIEW,
  TASK_ACTION_MERGE_RETRY,
  TASK_ACTION_MERGE_RETRY_TITLE,
  TASK_MOBILE_PILLS_ARIA,
  TASK_MOBILE_GROUP_ARIA,
  TASK_PLAN_APPROVED,
  TASK_PLAN_ASK_PENDING,
  TASK_PLAN_REJECTED,
  TASK_OFF_BOARD_CLOSE,
  TASK_OFF_BOARD_INSPECT,
  TASK_OFF_BOARD_INSPECTING,
  TASK_OFF_BOARD_INSPECT_FAILED,
  TASK_CONTINUE_PROMPT,
  taskArtifactCount,
  taskCardReworkLine,
  taskFilterActiveCount,
  taskOffBoardDeps,
  taskOffBoardNotice,
  TASK_EMPTY_HINT,
  TASK_EMPTY_HINT_NO_MATCH,
  TASK_EMPTY_LOADING,
  TASK_EMPTY_NO_MATCH,
  TASK_EMPTY_NO_TASKS,
  TASK_FILTER_ALL,
  TASK_FILTER_ASSIGNEE,
  TASK_FILTER_NODE,
  TASK_FILTER_PROJECT,
  TASK_FILTER_RESET,
  TASK_FILTER_TOGGLE_LABEL,
  TASK_FILTER_TOGGLE_TITLE,
  TASK_FLAG_PLAN_FIRST,
  TASK_FLAG_MERGE_PENDING,
  TASK_NEW_TASK,
  TASK_NEW_TASK_TITLE,
  TASK_SEARCH_CLEAR,
  TASK_SEARCH_LABEL,
  TASK_SEARCH_PLACEHOLDER,
  taskBoardStats,
  taskCardLightLabel,
  taskChangedFiles,
  taskColumnLabel,
  taskLightLabel,
  taskMobileTabLabel,
  taskReworkedTimes,
  taskWaitingForDeps,
} from './copy.ts'
import { TaskCreateDialog, TaskDetailDrawer, TaskMergeConfirmDialog, TaskReworkDialog } from './TaskDialogs.tsx'

/** Light word for the shared StatusLight (tone normalization lives in the SDK). */
function lightWord(status: TaskLightStatus): string {
  if (status === 'error') return 'error'
  if (status === 'blocked') return 'blocked'
  if (status === 'running' || status === 'background') return 'working'
  if (status === 'done') return 'done'
  return 'idle'
}

function TaskCard(props: {
  item: TaskItem
  nowMs: number | undefined
  busy: string | undefined
  onOpenConversation: (item: TaskItem) => void
  onShowDetail: (taskId: string) => void
  onSplit: (item: TaskItem) => void
  onStart: (taskId: string) => void
  onApprove: (taskId: string, mergeAction: 'close_only' | 'merge_and_close') => void
  onRework: (taskId: string) => void
  onContinue: (item: TaskItem) => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { item, nowMs } = props
  const { task, live } = item
  const hasConversation = task.conversationId !== undefined

  const elapsed =
    task.column === 'in_progress' &&
    task.startedAt !== undefined &&
    task.startedAt > 0 &&
    (live.lightStatus === 'running' || live.lightStatus === 'background')
      ? formatDurationMs(Math.max(0, (nowMs ?? task.startedAt) - task.startedAt))
      : undefined

  const openMain = (): void => {
    if (hasConversation) props.onOpenConversation(item)
    else props.onShowDetail(task.id)
  }

  const submission = task.submission
  const hasMergeMaterial = submission?.branch !== undefined || submission?.worktreePath !== undefined
  const isSevere = live.lightStatus === 'error'

  const showContinue =
    task.column === 'in_progress' &&
    (live.kickoffUndelivered ||
      live.stalled ||
      (task.reworkCount > 0 && (live.lightStatus === 'idle' || live.lightStatus === 'done')))
  const showConversation = hasConversation && task.column !== 'backlog' && !showContinue
  const showStart = task.column === 'backlog' && live.isReadyToStart

  const statePills: ReactNode[] = []
  if (task.archived === true) {
    statePills.push(
      <span key="archived" className="badge badge-neutral">{t(TASK_ARCHIVED_BADGE)}</span>,
    )
  }
  if (task.column === 'backlog' && task.planFirst === true) {
    statePills.push(
      <span key="plan-first" className="badge badge-neutral">{t(TASK_FLAG_PLAN_FIRST)}</span>,
    )
  }
  if (task.column === 'in_progress' && live.planAskPending) {
    statePills.push(<span key="plan-ask" className="badge badge-warn">{t(TASK_PLAN_ASK_PENDING)}</span>)
  }
  if (task.column === 'in_progress' && live.planApproval !== undefined) {
    statePills.push(
      <span key="plan-approval" className={`badge ${live.planApproval === 'approved' ? 'badge-ok' : 'badge-warn'}`}>
        {t(live.planApproval === 'approved' ? TASK_PLAN_APPROVED : TASK_PLAN_REJECTED)}
      </span>,
    )
  }
  if (task.mergePending === true && (task.column === 'in_progress' || task.column === 'in_review')) {
    statePills.push(
      <span key="merge" className="badge badge-accent">
        {t(task.column === 'in_review' ? TASK_MERGE_AWAIT_REVIEW : TASK_FLAG_MERGE_PENDING)}
      </span>,
    )
  }
  if (task.reworkCount > 0 && task.column !== 'done') {
    statePills.push(
      <span key="reworked" className="badge badge-neutral" title={task.lastReworkFeedback}>
        {taskReworkedTimes(task.reworkCount, locale)}
      </span>,
    )
  }

  const footerActions: ReactNode[] = []
  if (showContinue) {
    footerActions.push(
      <button
        key="continue"
        type="button"
        className="btn btn-xs btn-primary"
        disabled={props.busy !== undefined}
        title={
          live.kickoffUndelivered
            ? t(TASK_ACTION_RESUME_KICKOFF_TITLE)
            : live.stalled
              ? t(TASK_ACTION_CONTINUE_TITLE)
              : t(TASK_ACTION_CONTINUE_REWORK_TITLE)
        }
        onClick={(e) => {
          e.stopPropagation()
          props.onContinue(item)
        }}
      >
        <HelmxIcon name="play" size={11} />
        <span>{t(TASK_ACTION_CONTINUE)}</span>
      </button>,
    )
  }
  if (showConversation) {
    footerActions.push(
      <button
        key="conversation"
        type="button"
        className="btn btn-xs btn-ghost"
        disabled={props.busy !== undefined}
        title={t(TASK_ACTION_OPEN_CONV_BTN_TITLE)}
        onClick={(e) => {
          e.stopPropagation()
          props.onOpenConversation(item)
        }}
      >
        <HelmxIcon name="message-square" size={11} />
        <span>{t(TASK_ACTION_OPEN_CONV_BTN)}</span>
      </button>,
    )
  }
  if (showStart) {
    footerActions.push(
      <button
        key="start"
        type="button"
        className="btn btn-xs btn-primary"
        disabled={props.busy !== undefined}
        title={t(TASK_ACTION_START_TITLE)}
        onClick={(e) => {
          e.stopPropagation()
          props.onStart(task.id)
        }}
      >
        <HelmxIcon name="play" size={11} />
        <span>{t(TASK_ACTION_START)}</span>
      </button>,
    )
  }
  if (task.column === 'in_review') {
    footerActions.push(
      <button
        key="approve"
        type="button"
        className="btn btn-xs btn-primary"
        disabled={props.busy !== undefined}
        title={t(TASK_ACTION_APPROVE_TITLE)}
        onClick={(e) => {
          e.stopPropagation()
          props.onApprove(task.id, 'close_only')
        }}
      >
        <HelmxIcon name="check" size={11} />
        <span>{t(TASK_ACTION_APPROVE)}</span>
      </button>,
    )
    if (hasMergeMaterial) {
      footerActions.push(
        <button
          key="merge"
          type="button"
          className="btn btn-xs"
          disabled={props.busy !== undefined}
          title={t(task.mergePending === true ? TASK_ACTION_MERGE_RETRY_TITLE : TASK_ACTION_MERGE_CLOSE_TITLE)}
          onClick={(e) => {
            e.stopPropagation()
            props.onApprove(task.id, 'merge_and_close')
          }}
        >
          <HelmxIcon name="git-pull-request" size={11} />
          <span>{t(task.mergePending === true ? TASK_ACTION_MERGE_RETRY : TASK_ACTION_MERGE_CLOSE)}</span>
        </button>,
      )
    }
    footerActions.push(
      <button
        key="rework"
        type="button"
        className="btn btn-xs btn-ghost"
        disabled={props.busy !== undefined}
        title={t(TASK_ACTION_REWORK_TITLE)}
        onClick={(e) => {
          e.stopPropagation()
          props.onRework(task.id)
        }}
      >
        <HelmxIcon name="rotate-ccw" size={11} />
        <span>{t(TASK_ACTION_REWORK)}</span>
      </button>,
    )
  }

  return (
    <div
      className={`task-card${live.needsAttention ? ' is-attention' : ''}${isSevere ? ' is-severe' : ''}${hasConversation ? '' : ' is-clickless'}`}
      data-task-id={task.id}
      data-column={task.column}
      data-archived={task.archived === true ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${task.id} ${task.title}`}
      onClick={openMain}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openMain()
        }
      }}
    >
      <div className="task-card-header">
        <StatusLight status={lightWord(live.lightStatus)} label={taskCardLightLabel(live.lightStatus, live.approvalPending, locale)} />
        <span className="task-card-title" title={task.title}>{task.title}</span>
        <span className="task-card-tools">
          <button
            type="button"
            className="btn btn-xs btn-icon-xs"
            title={t(TASK_ACTION_DETAIL_BTN_TITLE)}
            aria-label={t(TASK_ACTION_DETAIL_LABEL)}
            onClick={(e) => {
              e.stopPropagation()
              props.onShowDetail(task.id)
            }}
          >
            <HelmxIcon name="more" size={11} />
          </button>
          {hasConversation ? (
            <button
              type="button"
              className="btn btn-xs btn-icon-xs task-card-split"
              title={t(TASK_ACTION_SPLIT)}
              aria-label={t(TASK_ACTION_SPLIT_LABEL)}
              onClick={(e) => {
                e.stopPropagation()
                props.onSplit(item)
              }}
            >
              <HelmxIcon name="columns" size={11} />
            </button>
          ) : null}
        </span>
      </div>

      <div className="task-card-props">
        <span className="task-card-id mono">{task.id}</span>
        <span className="mono">{task.assigneeProfileId}</span>
        {task.nodeId !== undefined ? <span className="mono">@{task.nodeId}</span> : null}
        {live.projectLabel !== '' ? (
          <span className="task-card-project" title={task.cwd ?? undefined}>{live.projectLabel}</span>
        ) : null}
        {elapsed !== undefined ? <span className="task-card-elapsed mono tabular-nums">{elapsed}</span> : null}
      </div>

      {statePills.length > 0 ? <div className="task-card-flags">{statePills}</div> : null}

      {live.liveSummary !== '' ? (
        <div
          className={`task-card-live${isSevere ? ' is-error' : live.needsAttention ? ' is-attention' : ''}`}
          title={live.liveSummary}
        >
          <span className="task-card-live-text">{live.liveSummary}</span>
        </div>
      ) : null}

      {task.column === 'in_progress' &&
      task.reworkCount > 0 &&
      task.lastReworkFeedback !== undefined &&
      task.lastReworkFeedback !== '' ? (
        <div className="task-card-rework" title={taskCardReworkLine(task.lastReworkFeedback, locale)}>
          <HelmxIcon name="rotate-ccw" size={11} />
          <span className="task-card-rework-text">{taskCardReworkLine(task.lastReworkFeedback, locale)}</span>
        </div>
      ) : null}

      {task.column === 'backlog' ? (
        <div className="task-card-deps">
          {live.depsUnknown ? (
            <span className="task-card-deps-waiting" title={t(TASK_DEPS_UNKNOWN_TITLE)}>
              <HelmxIcon name="alert-circle" size={11} />
              <span>{t(TASK_DEPS_UNKNOWN)}</span>
            </span>
          ) : live.blockedBy.length > 0 ? (
            <span className="task-card-deps-waiting" title={taskWaitingForDeps(live.blockedBy, locale)}>
              <HelmxIcon name="clock" size={11} />
              <span>{taskWaitingForDeps(live.blockedBy, locale)}</span>
            </span>
          ) : (
            <span className="badge badge-ok">{t(TASK_DEPS_READY)}</span>
          )}
          {!live.depsUnknown && live.offBoardDeps.length > 0 ? (
            <span className="badge badge-neutral" title={t(TASK_DEP_OFF_BOARD_TITLE)}>
              {taskOffBoardDeps(live.offBoardDeps.length, locale)}
            </span>
          ) : null}
        </div>
      ) : null}

      {task.column === 'in_review' && submission !== undefined ? (
        <div className="task-card-submission">
          <div className="task-card-submission-summary" title={submission.summary}>{submission.summary}</div>
          <div className="task-card-submission-facts">
            {submission.verification !== undefined ? (
              <span className="task-card-fact" title={submission.verification}>
                <HelmxIcon name="shield" size={11} />
                <span>{submission.verification}</span>
              </span>
            ) : null}
            {submission.branch !== undefined ? <span className="mono">{submission.branch}</span> : null}
            {submission.changedFiles !== undefined && submission.changedFiles.length > 0 ? (
              <span>{taskChangedFiles(submission.changedFiles.length, locale)}</span>
            ) : null}
            {submission.artifactIds !== undefined && submission.artifactIds.length > 0 ? (
              <span>{taskArtifactCount(submission.artifactIds.length, locale)}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {task.column === 'done' && submission !== undefined ? (
        <div className="task-card-done-line" title={submission.summary}>{submission.summary}</div>
      ) : null}

      {footerActions.length > 0 ? (
        <div className="task-card-footer">
          <div className="task-card-footer-actions">{footerActions}</div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Explicit notice for a deep-linked task absent from the current board
 * projection (archived / done-truncated / deleted): never silently blank —
 * offers the read-only `inspect` action to load the full record on demand.
 */
function TaskOffBoardNotice(props: { taskId: string; onClose: () => void }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const [record, setRecord] = useState<TaskRecord | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    if (loading) return
    setLoading(true)
    setError(null)
    void ctx
      .callAction('inspect', { taskId: props.taskId })
      .then((raw) => {
        const container = typeof raw === 'object' && raw !== null && 'task' in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>)['task']
          : raw
        const parsed = parseTaskRecordLenient(container)
        if (parsed === undefined) {
          setError(t(TASK_OFF_BOARD_INSPECT_FAILED))
          return
        }
        setRecord(parsed)
      })
      .catch((err: unknown) => {
        setError(`${t(TASK_OFF_BOARD_INSPECT_FAILED)}: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  return (
    <div className="task-board-empty" data-off-board-task={props.taskId}>
      <HelmxIcon name="archive" size={22} />
      <div className="task-board-empty-title">{taskOffBoardNotice(props.taskId, locale)}</div>
      {record === undefined ? (
        <>
          {error !== null ? <div className="task-modal-error">{error}</div> : null}
          <div className="task-board-actions">
            <button type="button" className="btn btn-sm" disabled={loading} onClick={load}>
              <HelmxIcon name="search" size={11} />
              <span>{loading ? t(TASK_OFF_BOARD_INSPECTING) : t(TASK_OFF_BOARD_INSPECT)}</span>
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={props.onClose}>
              <span>{t(TASK_OFF_BOARD_CLOSE)}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="task-card-submission" style={{ maxWidth: 560, textAlign: 'left' }}>
            <div className="task-card-submission-title">
              <span className="badge badge-neutral mono">{record.id}</span>
              <span>{record.title}</span>
              <span className="badge badge-neutral">{taskColumnLabel(record.column, locale)}</span>
            </div>
            {record.brief !== '' ? (
              <div className="task-detail-md">
                <MarkdownView text={record.brief} />
              </div>
            ) : null}
            {record.submission !== undefined ? (
              <>
                <div className="task-detail-md">
                  <MarkdownView text={record.submission.summary} />
                </div>
                <div className="task-card-submission-facts">
                  {record.submission.branch !== undefined ? <span className="mono">{record.submission.branch}</span> : null}
                </div>
              </>
            ) : null}
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={props.onClose}>
            <span>{t(TASK_OFF_BOARD_CLOSE)}</span>
          </button>
        </>
      )}
    </div>
  )
}

interface TaskBoardScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

export function TaskBoardScreen(props: TaskBoardScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const filtersId = useId()

  const rawBoard = usePluginDoc<unknown>('board')
  const board = useMemo(() => parseTaskBoardDoc(rawBoard), [rawBoard])
  const boardInvalid = rawBoard !== undefined && board === undefined
  const boardLoaded = rawBoard !== undefined && board !== undefined
  const [reloading, setReloading] = useState(false)
  const conversations = useConversations()
  const background = useConversationBackground()
  const config = usePluginConfig<{ defaultPlannerProfile?: string }>()

  const params = parseTaskScreenParams(props.params)
  const filter = params.filter
  const activeTab = params.tab

  const [queryDraft, setQueryDraft] = useState(params.filter.query)
  const [createOpen, setCreateOpen] = useState(false)
  const [reworkTaskId, setReworkTaskId] = useState<string | undefined>(undefined)
  const [mergeConfirmId, setMergeConfirmId] = useState<string | undefined>(undefined)
  const [busyTaskId, setBusyTaskId] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [archivingDone, setArchivingDone] = useState(false)
  // Collapsed mobile `all` groups (done starts collapsed so finished work never
  // buries active cards; every group is one tap away).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set(['done']))

  const tasksById = useMemo(() => new Map((board?.tasks ?? []).map((task) => [task.id, task])), [board])
  const items = useMemo(
    () => (board === undefined ? [] : deriveBoardItems(board.tasks, conversations, undefined, locale, background)),
    [board, conversations, locale, background],
  )
  const options = useMemo(() => collectFilterOptions(items), [items])
  const filtered = useMemo(() => filterTaskItems(items, filter, locale), [items, filter, locale])
  // 归档即收离看板：默认只渲染未归档卡；已归档卡仅在「已归档」开关打开时附带展示（淡化沉底）。
  const archivedItems = useMemo(() => filtered.filter((item) => item.task.archived === true), [filtered])
  const activeItems = useMemo(() => filtered.filter((item) => item.task.archived !== true), [filtered])
  const showArchivedHistory = params.showArchived && archivedItems.length > 0
  const columns = useMemo(
    () => bucketByColumn(showArchivedHistory ? filtered : activeItems),
    [filtered, activeItems, showArchivedHistory],
  )
  const mobileBuckets = useMemo(
    () => bucketMobile(showArchivedHistory ? filtered : activeItems),
    [filtered, activeItems, showArchivedHistory],
  )
  const unarchivedDoneCount = useMemo(
    () => activeItems.filter((item) => item.task.column === 'done').length,
    [activeItems],
  )

  const selectedTaskId = params.taskId
  const selectedItem = selectedTaskId !== undefined ? items.find((i) => i.task.id === selectedTaskId) : undefined
  const reworkItem = reworkTaskId !== undefined ? tasksById.get(reworkTaskId) : undefined

  const anyRunning = useMemo(
    () => filtered.some((item) => item.live.lightStatus === 'running' || item.live.lightStatus === 'background'),
    [filtered],
  )
  const nowMs = useSharedNowMs(anyRunning)

  const setQuery = (next: string): void => {
    setQueryDraft(next)
    props.setParams({ q: next === '' ? undefined : next })
  }

  const setFilterValue = (key: keyof TaskFilterState, value: string): void => {
    props.setParams({ [key]: value === '' ? undefined : value })
  }

  const resetFilters = (): void => {
    setQueryDraft('')
    props.setParams({ q: undefined, project: undefined, assignee: undefined, node: undefined })
  }

  const runTaskAction = (taskId: string, action: () => Promise<unknown>): void => {
    if (busyTaskId !== undefined) return
    setBusyTaskId(taskId)
    setActionError(null)
    void action()
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        ctx.notify(err instanceof Error ? err.message : String(err), 'error')
      })
      .finally(() => {
        setBusyTaskId(undefined)
      })
  }

  /** Sequential batch archive of every visible unarchived done card; stops and surfaces the first failure honestly. */
  const archiveAllDone = (): void => {
    if (archivingDone || busyTaskId !== undefined) return
    const ids = columns.done.filter((item) => item.task.archived !== true).map((item) => item.task.id)
    if (ids.length === 0) return
    setArchivingDone(true)
    setActionError(null)
    void (async () => {
      for (const taskId of ids) {
        await ctx.callAction('archive', { taskId })
      }
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setActionError(message)
        ctx.notify(message, 'error')
      })
      .finally(() => {
        setArchivingDone(false)
      })
  }

  const filterSelect = (
    key: keyof TaskFilterState,
    label: string,
    values: readonly string[],
  ): ReactNode => {
    const current = filter[key]
    return (
      <div className="task-board-filter">
        <Select
          value={current === '' ? '__all' : current}
          options={[
            { value: '__all', label: `${label}: ${t(TASK_FILTER_ALL)}` },
            ...values.map((value) => ({ value, label: value })),
          ]}
          onChange={(event) => setFilterValue(key, event.target.value === '__all' ? '' : event.target.value)}
          aria-label={label}
          size="sm"
        />
      </div>
    )
  }

  const cardHandlers = {
    onOpenConversation: (item: TaskItem) => {
      const target = item.live.jumpConversationId ?? item.task.conversationId
      if (target !== undefined) ctx.openConversationDrawer(target)
    },
    onShowDetail: (taskId: string) => props.setParams({ task: taskId }),
    onSplit: (item: TaskItem) => {
      if (item.task.conversationId !== undefined) {
        ctx.openSplitScreen(`conversation:${item.task.conversationId}`)
      }
    },
    onStart: (taskId: string) => runTaskAction(taskId, () => ctx.callAction('start', { taskId })),
    onApprove: (taskId: string, mergeAction: 'close_only' | 'merge_and_close') => {
      // Merging touches the repository main branch through the executor: explicit
      // confirmation with the branch/cleanup facts first, never a one-tap dispatch.
      if (mergeAction === 'merge_and_close') {
        setMergeConfirmId(taskId)
        return
      }
      runTaskAction(taskId, () => ctx.callAction('approve', { taskId, mergeAction }))
    },
    onRework: (taskId: string) => setReworkTaskId(taskId),
    onContinue: (item: TaskItem) => {
      if (busyTaskId !== undefined) return
      setBusyTaskId(`continue:${item.task.id}`)
      setActionError(null)
      // Kickoff-undelivered tasks resume through the explicit resume_kickoff action
      // (idempotent via the original requestId); the plain continue message is only
      // for stalled / reworked tasks. Never dispatched automatically either way.
      const action =
        item.task.kickoffUndelivered === true
          ? ctx.callAction('resume_kickoff', { taskId: item.task.id })
          : item.task.conversationId !== undefined
            ? ctx.submitInput(TASK_CONTINUE_PROMPT, { conversationId: item.task.conversationId })
            : Promise.resolve()
      void action
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          setActionError(message)
          ctx.notify(message, 'error')
        })
        .finally(() => {
          setBusyTaskId(undefined)
        })
    },
  }

  const inFlightCount = columns.in_progress.length
  const renderCard = (item: TaskItem): ReactNode => (
    <TaskCard
      key={item.task.id}
      item={item}
      nowMs={nowMs}
      busy={busyTaskId}
      {...cardHandlers}
    />
  )

  const hasActiveFilter =
    filter.query !== '' || filter.project !== '' || filter.assignee !== '' || filter.node !== ''
  const activeFilterCount = countActivePropertyFilters(filter)
  const doneCount = unarchivedDoneCount
  const openCreate = (): void => setCreateOpen(true)

  const toggleArchivedHistory = (): void => {
    props.setParams({ archived: params.showArchived ? undefined : '1' })
  }

  const selectMobileTab = (tab: TaskMobileTab): void => {
    // `all` is the default grouped view: clear the param so the canonical URL
    // stays minimal; every concrete bucket persists tab=<id> for deep links.
    props.setParams({ tab: tab === 'all' ? undefined : tab })
  }

  const toggleGroup = (tab: Exclude<TaskMobileTab, 'all'>): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(tab)) next.delete(tab)
      else next.add(tab)
      return next
    })
  }

  const planButton = (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title={t(TASK_CHAT_TASK_TITLE)}
      onClick={() => ctx.openScreen(`agent:${config.defaultPlannerProfile || 'assistant'}`)}
    >
      <HelmxIcon name="message-square" size={12} />
      <span>{t(TASK_CHAT_TASK)}</span>
    </button>
  )
  const newTaskButton = (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      title={t(TASK_NEW_TASK_TITLE)}
      onClick={openCreate}
    >
      <HelmxIcon name="plus" size={12} />
      <span>{t(TASK_NEW_TASK)}</span>
    </button>
  )

  const mobilePill = (tab: TaskMobileTab): ReactNode => {
    const count = tab === 'all' ? filtered.length : mobileBuckets[tab].length
    const isActive = activeTab === tab
    return (
      <button
        key={tab}
        type="button"
        role="tab"
        aria-selected={isActive}
        className={`task-mobile-pill${isActive ? ' is-active' : ''}${count === 0 && !isActive ? ' is-muted' : ''}`}
        onClick={() => selectMobileTab(tab)}
      >
        {tab !== 'all' ? <span className="task-tone-dot" data-tone={TASK_MOBILE_TAB_TONE[tab]} /> : null}
        <span className="task-mobile-pill-label">{taskMobileTabLabel(tab, locale)}</span>
        <span className="task-mobile-pill-count tabular-nums">{count}</span>
      </button>
    )
  }

  /** One grouped section of the mobile `all` view (Notion-style collapsible status group). */
  const mobileGroup = (tab: Exclude<TaskMobileTab, 'all'>): ReactNode => {
    const groupItems = mobileBuckets[tab]
    if (groupItems.length === 0) return null
    const collapsed = collapsedGroups.has(tab)
    return (
      <div key={tab} className="task-mobile-group" data-group={tab}>
        <div className="task-mobile-group-header">
          <button
            type="button"
            className="task-mobile-group-toggle"
            aria-expanded={!collapsed}
            aria-label={`${t(TASK_MOBILE_GROUP_ARIA)}: ${taskMobileTabLabel(tab, locale)}`}
            onClick={() => toggleGroup(tab)}
          >
            <span className="task-tone-dot" data-tone={TASK_MOBILE_TAB_TONE[tab]} />
            <span className="task-mobile-group-label">{taskMobileTabLabel(tab, locale)}</span>
            <span className="task-mobile-group-count tabular-nums">{groupItems.length}</span>
            <HelmxIcon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} className="task-mobile-group-chevron" />
          </button>
          {tab === 'backlog' ? (
            <button
              type="button"
              className="btn btn-xs btn-icon-xs task-mobile-group-add"
              title={t(TASK_NEW_TASK_TITLE)}
              aria-label={t(TASK_NEW_TASK)}
              onClick={openCreate}
            >
              <HelmxIcon name="plus" size={11} />
            </button>
          ) : null}
          {tab === 'done' && unarchivedDoneCount > 0 ? (
            <button
              type="button"
              className="btn btn-xs btn-icon-xs task-mobile-group-archive"
              disabled={archivingDone}
              title={t(TASK_ARCHIVE_ALL_TITLE)}
              aria-label={t(TASK_ARCHIVE_ALL)}
              onClick={archiveAllDone}
            >
              <HelmxIcon name="archive" size={11} />
            </button>
          ) : null}
        </div>
        {collapsed ? null : (
          <div className="task-mobile-group-body">
            {groupItems.map(renderCard)}
          </div>
        )}
      </div>
    )
  }

  // 移动端列表：筛选清空（filtered.length === 0）时统一由底部带 Reset 的
  // filtered-empty 面板兜底，这里不再叠一块内嵌空态；单 tab 空块仅在
  // 「有筛选结果但该桶为空」时渲染（如 review 桶 0 卡）。
  const mobileList = activeTab === 'all' ? (
    <>{TASK_MOBILE_GROUP_ORDER.map(mobileGroup)}</>
  ) : mobileBuckets[activeTab].length > 0 ? (
    mobileBuckets[activeTab].map(renderCard)
  ) : filtered.length > 0 ? (
    <div className="task-board-empty">
      <div className="task-board-empty-title">{t(TASK_EMPTY_NO_MATCH)}</div>
      <div className="task-board-empty-hint text-subtle">{t(TASK_EMPTY_HINT_NO_MATCH)}</div>
    </div>
  ) : null

  return (
    <div className="task-board" data-view="task-board">
      {/* Compact command bar — the host ScreenHost already renders the pane title. */}
      <div className="task-board-topbar">
        <span className="task-board-subtitle text-subtle">
          {boardLoaded && board !== undefined
            ? taskBoardStats(board.tasks.length, inFlightCount, columns.in_review.length, locale)
            : t(TASK_EMPTY_LOADING)}
        </span>
        <div className="task-board-actions">
          {planButton}
          {newTaskButton}
        </div>
      </div>

      <div className="task-board-toolbar">
        <div className="primary-search-box">
          <HelmxIcon name="search" size={14} />
          <input
            type="text"
            placeholder={t(TASK_SEARCH_PLACEHOLDER)}
            value={queryDraft}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t(TASK_SEARCH_LABEL)}
          />
          {queryDraft !== '' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title={t(TASK_SEARCH_CLEAR)}
              aria-label={t(TASK_SEARCH_CLEAR)}
              onClick={() => setQuery('')}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="task-board-filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          title={t(TASK_FILTER_TOGGLE_TITLE)}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <HelmxIcon name="list-filter" size={13} />
          <span>{t(TASK_FILTER_TOGGLE_LABEL)}</span>
          {activeFilterCount > 0 ? (
            <span className="task-filter-count badge badge-accent tabular-nums" title={taskFilterActiveCount(activeFilterCount, locale)}>
              {activeFilterCount}
            </span>
          ) : null}
        </button>
        {archivedItems.length > 0 ? (
          <button
            type="button"
            className={`task-board-filter-toggle${params.showArchived ? ' is-active' : ''}`}
            aria-pressed={params.showArchived}
            title={t(TASK_ARCHIVE_HISTORY_TITLE)}
            onClick={toggleArchivedHistory}
          >
            <HelmxIcon name="archive" size={13} />
            <span>{params.showArchived ? t(TASK_ARCHIVE_HISTORY_HIDE) : t(TASK_ARCHIVE_HISTORY_SHOW)}</span>
            <span className="task-filter-count badge badge-neutral tabular-nums" title={t(TASK_ARCHIVE_HISTORY_TITLE)}>
              {archivedItems.length}
            </span>
          </button>
        ) : null}
      </div>

      {/* Property filters: always visible on desktop, collapsible tray on mobile. */}
      <div id={filtersId} className="task-board-filters" data-open={filtersOpen}>
        {filterSelect('project', t(TASK_FILTER_PROJECT), options.projects)}
        {filterSelect('assignee', t(TASK_FILTER_ASSIGNEE), options.assignees)}
        {filterSelect('node', t(TASK_FILTER_NODE), options.nodes)}
        {hasActiveFilter ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>
            <HelmxIcon name="rotate-ccw" size={11} />
            <span>{t(TASK_FILTER_RESET)}</span>
          </button>
        ) : null}
      </div>

      {actionError !== null ? <div className="task-modal-error">{actionError}</div> : null}

      {boardInvalid ? (
        <div className="task-board-empty">
          <HelmxIcon name="alert-triangle" size={26} />
          <div className="task-board-empty-title">{t(TASK_BOARD_INVALID)}</div>
          <div className="task-board-empty-hint text-subtle">{t(TASK_BOARD_INVALID_HINT)}</div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={reloading}
            onClick={() => {
              if (reloading) return
              setReloading(true)
              void ctx
                .getPluginDoc('board')
                .catch(() => {
                  /* honest empty catch: the reload failure keeps the invalid panel; nothing fabricated */
                })
                .finally(() => setReloading(false))
            }}
          >
            <HelmxIcon name="refresh-cw" size={11} />
            <span>{reloading ? t(TASK_BOARD_RELOADING) : t(TASK_BOARD_RETRY)}</span>
          </button>
        </div>
      ) : !boardLoaded ? (
        <div className="task-board-empty">
          <HelmxIcon name="loader" size={26} />
          <div className="task-board-empty-title">{t(TASK_EMPTY_LOADING)}</div>
        </div>
      ) : items.length === 0 ? (
        <div className="task-board-empty">
          <HelmxIcon name="check-square" size={26} />
          <div className="task-board-empty-title">{t(TASK_EMPTY_NO_TASKS)}</div>
          <div className="task-board-empty-hint text-subtle">{t(TASK_EMPTY_HINT)}</div>
          {archivedItems.length > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleArchivedHistory}>
              <HelmxIcon name="archive" size={11} />
              <span>{t(TASK_ARCHIVE_HISTORY_SHOW)} · {archivedItems.length}</span>
            </button>
          ) : null}
          <div className="task-board-actions" style={{ justifyContent: 'center' }}>
            {planButton}
            {newTaskButton}
          </div>
        </div>
      ) : (
        <>
          {/* Desktop four-column board (Notion-style calm column tracks) */}
          <div className="task-board-desktop">
            <div className="task-board-columns">
              {TASK_COLUMNS.map((column: TaskColumn) => (
                <div key={column} className="task-column" data-task-column={column}>
                  <div className="task-column-header">
                    <span className="task-tone-dot" data-tone={TASK_COLUMN_TONE[column]} />
                    <span className="task-column-title">{taskColumnLabel(column, locale)}</span>
                    <span className="task-column-count tabular-nums">{columns[column].length}</span>
                    {column === 'backlog' ? (
                      <button
                        type="button"
                        className="btn btn-xs btn-icon-xs task-column-add"
                        title={t(TASK_NEW_TASK_TITLE)}
                        aria-label={t(TASK_NEW_TASK)}
                        onClick={openCreate}
                      >
                        <HelmxIcon name="plus" size={11} />
                      </button>
                    ) : null}
                    {column === 'done' && doneCount > 0 ? (
                      <button
                        type="button"
                        className="btn btn-xs task-column-archive"
                        disabled={archivingDone}
                        title={t(TASK_ARCHIVE_ALL_TITLE)}
                        onClick={archiveAllDone}
                      >
                        <HelmxIcon name="archive" size={11} />
                        <span>{archivingDone ? t(TASK_ARCHIVING) : t(TASK_ARCHIVE_ALL)}</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="task-column-list">
                    {columns[column].length > 0 ? (
                      columns[column].map(renderCard)
                    ) : (
                      <div className="task-column-empty">{taskColumnLabel(column, locale)}</div>
                    )}
                    {column === 'backlog' ? (
                      <button type="button" className="task-column-new-row" onClick={openCreate}>
                        <HelmxIcon name="plus" size={12} />
                        <span>{t(TASK_NEW_TASK)}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Mobile: horizontal status pills + grouped collapsible list */}
          <div className="task-board-mobile">
            <div className="task-mobile-pills" role="tablist" aria-label={t(TASK_MOBILE_PILLS_ARIA)}>
              {TASK_MOBILE_TABS.map(mobilePill)}
            </div>
            <div className="task-board-mobile-list">{mobileList}</div>
          </div>

          {filtered.length === 0 && items.length > 0 ? (
            <div className="task-board-empty">
              <HelmxIcon name="search" size={26} />
              <div className="task-board-empty-title">{t(TASK_EMPTY_NO_MATCH)}</div>
              <div className="task-board-empty-hint text-subtle">{t(TASK_EMPTY_HINT_NO_MATCH)}</div>
              <button type="button" className="btn btn-sm" onClick={resetFilters}>
                <HelmxIcon name="rotate-ccw" size={11} />
                <span>{t(TASK_FILTER_RESET)}</span>
              </button>
            </div>
          ) : null}
        </>
      )}

      {selectedTaskId !== undefined && selectedItem === undefined && boardLoaded ? (
        <TaskOffBoardNotice taskId={selectedTaskId} onClose={() => props.setParams({ task: undefined })} />
      ) : null}

      {createOpen ? (
        <TaskCreateDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          dependencyCandidates={(board?.tasks ?? [])
            .filter((task) => task.column !== 'done')
            .map((task) => ({ id: task.id, title: task.title }))}
        />
      ) : null}

      {mergeConfirmId !== undefined ? (
        <TaskMergeConfirmDialog
          taskId={mergeConfirmId}
          title={tasksById.get(mergeConfirmId)?.title ?? mergeConfirmId}
          submission={tasksById.get(mergeConfirmId)?.submission}
          open={mergeConfirmId !== undefined}
          busy={busyTaskId !== undefined}
          onClose={() => setMergeConfirmId(undefined)}
          onConfirm={(taskId) => {
            setMergeConfirmId(undefined)
            runTaskAction(taskId, () => ctx.callAction('approve', { taskId, mergeAction: 'merge_and_close' }))
          }}
        />
      ) : null}

      {reworkTaskId !== undefined ? (
        <TaskReworkDialog
          taskId={reworkTaskId}
          title={reworkItem?.title}
          open={reworkTaskId !== undefined}
          onClose={() => setReworkTaskId(undefined)}
        />
      ) : null}

      {selectedItem !== undefined ? (
        <TaskDetailDrawer
          item={selectedItem}
          tasksById={tasksById}
          inline={props.inlineDrawer}
          onClose={() => props.setParams({ task: undefined })}
          onRework={(taskId) => setReworkTaskId(taskId)}
          onResumeKickoff={(taskId) =>
            runTaskAction(taskId, () => ctx.callAction('resume_kickoff', { taskId }))
          }
          busy={busyTaskId !== undefined}
        />
      ) : null}
    </div>
  )
}
