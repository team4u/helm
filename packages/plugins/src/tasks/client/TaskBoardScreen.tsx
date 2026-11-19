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
 * Layout: desktop four-column board (needsAttention pinned to the top, stable
 * createdAt ordering so streaming never jumps cards) + a mobile <=680px
 * clear-down flow with four count capsules (attention / review / running /
 * backlog, done switchable). Card bodies of started tasks open the live
 * conversation drawer (720px) in place; the card corner keeps detail and
 * split-view affordances.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  HelmxIcon,
  SegmentedControl,
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
  deriveBoardItems,
  filterTaskItems,
  parseTaskBoardDoc,
  parseTaskRecordLenient,
  parseTaskScreenParams,
  TASK_COLUMNS,
  TASK_MOBILE_TABS,
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
  TASK_ACTION_DETAIL,
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
  TASK_BOARD_INVALID,
  TASK_BOARD_INVALID_HINT,
  TASK_BOARD_RELOADING,
  TASK_BOARD_RETRY,
  TASK_BOARD_TITLE,
  TASK_CHAT_TASK,
  TASK_CHAT_TASK_TITLE,
  TASK_DEPS_READY,
  TASK_DEP_OFF_BOARD,
  TASK_DEP_OFF_BOARD_TITLE,
  TASK_MERGE_PENDING_DISABLED_TITLE,
  TASK_OFF_BOARD_CLOSE,
  TASK_OFF_BOARD_INSPECT,
  TASK_OFF_BOARD_INSPECTING,
  TASK_OFF_BOARD_INSPECT_FAILED,
  TASK_CONTINUE_PROMPT,
  TASK_CONTINUE_SENDING,
  taskCardReworkLine,
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
  TASK_FLAG_ISOLATED_BRANCH,
  TASK_FLAG_MERGE_PENDING,
  TASK_FLAG_PLAN_FIRST,
  TASK_MOBILE_TABS_ARIA,
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
  compact?: boolean
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

  return (
    <div
      className={`task-card${live.needsAttention ? ' is-attention' : ''}${hasConversation ? '' : ' is-clickless'}`}
      data-task-id={task.id}
      data-column={task.column}
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
        <div className="task-card-main">
          <div className="task-card-title-row">
            <span className="task-card-title" title={task.title}>{task.title}</span>
            <span className="task-card-id">{task.id}</span>
          </div>
          <div className="task-card-meta">
            <span className="mono">{task.assigneeProfileId}</span>
            {task.nodeId !== undefined ? <span className="mono">@{task.nodeId}</span> : null}
            {live.projectLabel !== '' ? <span title={task.cwd ?? undefined}>{live.projectLabel}</span> : null}
          </div>
        </div>
        <div className="task-card-tools">
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
              className="btn btn-xs btn-icon-xs"
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
        </div>
      </div>

      {live.liveSummary !== '' ? (
        <div className={`task-card-live${live.lightStatus === 'error' ? ' is-error' : live.needsAttention ? ' is-attention' : ''}`}>
          <span className="task-card-live-text" title={live.liveSummary}>{live.liveSummary}</span>
          {elapsed !== undefined ? <span className="task-card-elapsed tabular-nums">{elapsed}</span> : null}
        </div>
      ) : elapsed !== undefined ? (
        <div className="task-card-live">
          <span className="task-card-elapsed tabular-nums">{elapsed}</span>
        </div>
      ) : null}

      {task.column === 'backlog' ? (
        <div className="task-card-deps">
          {live.blockedBy.length > 0 ? (
            <span className="task-card-deps-waiting" title={taskWaitingForDeps(live.blockedBy, locale)}>
              <HelmxIcon name="clock" size={11} />
              <span>{taskWaitingForDeps(live.blockedBy, locale)}</span>
            </span>
          ) : (
            <span className="badge badge-ok">{t(TASK_DEPS_READY)}</span>
          )}
          {live.offBoardDeps.length > 0 ? (
            <span className="badge badge-neutral" title={t(TASK_DEP_OFF_BOARD_TITLE)}>
              {taskOffBoardDeps(live.offBoardDeps.length, locale)}
            </span>
          ) : null}
          {task.planFirst === true ? <span className="badge badge-neutral">{t(TASK_FLAG_PLAN_FIRST)}</span> : null}
        </div>
      ) : null}

      {task.mergePending === true && (task.column === 'in_progress' || task.column === 'in_review') ? (
        <div className="task-card-flags">
          <span className="badge badge-accent">{t(TASK_FLAG_MERGE_PENDING)}</span>
        </div>
      ) : null}

      {task.column === 'in_progress' && live.activeChildCount > 0 ? (
        <div className="task-card-flags">
          <span className="badge badge-neutral">{taskLightLabel('background', locale)}</span>
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

      {submission !== undefined && (task.column === 'in_review' || task.column === 'done') ? (
        <div className="task-card-submission">
          <div className="task-card-submission-title">
            <HelmxIcon name="check-circle" size={11} />
            <span>{submission.summary}</span>
          </div>
          {submission.verification !== undefined ? (
            <div className="task-card-submission-facts" title={submission.verification}>
              <HelmxIcon name="shield" size={11} />
              <span>{submission.verification}</span>
            </div>
          ) : null}
          <div className="task-card-submission-facts">
            {submission.branch !== undefined ? <span className="mono">{submission.branch}</span> : null}
            {submission.changedFiles !== undefined && submission.changedFiles.length > 0
              ? <span>{taskChangedFiles(submission.changedFiles.length, locale)}</span>
              : null}
          </div>
        </div>
      ) : null}

      {task.reworkCount > 0 && task.column !== 'done' ? (
        <div className="task-card-flags">
          <span className="badge badge-neutral" title={task.lastReworkFeedback}>{taskReworkedTimes(task.reworkCount, locale)}</span>
        </div>
      ) : null}

      <div className="task-card-footer">
        <div className="task-card-footer-actions">
          {task.column === 'in_progress' &&
          (live.stalled || (task.reworkCount > 0 && (live.lightStatus === 'idle' || live.lightStatus === 'done'))) ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={props.busy !== undefined}
              title={live.stalled ? t(TASK_ACTION_CONTINUE_TITLE) : t(TASK_ACTION_CONTINUE_REWORK_TITLE)}
              onClick={(e) => {
                e.stopPropagation()
                props.onContinue(item)
              }}
            >
              <HelmxIcon name="play" size={11} />
              <span>{t(TASK_ACTION_CONTINUE)}</span>
            </button>
          ) : null}
          {hasConversation && task.column !== 'backlog' ? (
            <button
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
            </button>
          ) : null}
          {task.column === 'backlog' && live.isReadyToStart ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={props.busy !== undefined}
              title={t(TASK_ACTION_START_TITLE)}
              onClick={(e) => {
                e.stopPropagation()
                props.onStart(task.id)
              }}
            >
              <HelmxIcon name="play" size={11} />
              <span>{t(TASK_ACTION_START)}</span>
            </button>
          ) : null}
          {task.column === 'in_review' ? (
            <>
              <button
                type="button"
                className="btn btn-xs"
                disabled={props.busy !== undefined || task.mergePending === true}
                title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_APPROVE_TITLE)}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onApprove(task.id, 'close_only')
                }}
              >
                <HelmxIcon name="check" size={11} />
                <span>{t(TASK_ACTION_APPROVE)}</span>
              </button>
              {hasMergeMaterial ? (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  disabled={props.busy !== undefined || task.mergePending === true}
                  title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_MERGE_CLOSE_TITLE)}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onApprove(task.id, 'merge_and_close')
                  }}
                >
                  <HelmxIcon name="git-pull-request" size={11} />
                  <span>{t(TASK_ACTION_MERGE_CLOSE)}</span>
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={props.busy !== undefined || task.mergePending === true}
                title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_REWORK_TITLE)}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onRework(task.id)
                }}
              >
                <HelmxIcon name="rotate-ccw" size={11} />
                <span>{t(TASK_ACTION_REWORK)}</span>
              </button>
            </>
          ) : null}
          {task.autoMerge !== true && task.column !== 'done' && task.column !== 'backlog' ? (
            <span className="badge badge-neutral">{t(TASK_FLAG_ISOLATED_BRANCH)}</span>
          ) : null}
        </div>
      </div>
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
            {record.brief !== '' ? <div className="task-card-submission-summary">{record.brief}</div> : null}
            {record.submission !== undefined ? (
              <div className="task-card-submission-facts">
                <span>{record.submission.summary}</span>
                {record.submission.branch !== undefined ? <span className="mono">{record.submission.branch}</span> : null}
              </div>
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

  const [queryDraft, setQueryDraft] = useState(params.filter.query)
  const [createOpen, setCreateOpen] = useState(false)
  const [reworkTaskId, setReworkTaskId] = useState<string | undefined>(undefined)
  const [mergeConfirmId, setMergeConfirmId] = useState<string | undefined>(undefined)
  const [busyTaskId, setBusyTaskId] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | null>(null)

  const tasksById = useMemo(() => new Map((board?.tasks ?? []).map((task) => [task.id, task])), [board])
  const items = useMemo(
    () => (board === undefined ? [] : deriveBoardItems(board.tasks, conversations, undefined, locale, background)),
    [board, conversations, locale, background],
  )
  const options = useMemo(() => collectFilterOptions(items), [items])
  const filtered = useMemo(() => filterTaskItems(items, filter, locale), [items, filter, locale])
  const columns = useMemo(() => bucketByColumn(filtered), [filtered])
  const mobileBuckets = useMemo(() => bucketMobile(filtered), [filtered])

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
      const conversationId = item.task.conversationId
      if (conversationId === undefined) return
      if (busyTaskId !== undefined) return
      setBusyTaskId(`continue:${item.task.id}`)
      setActionError(null)
      void ctx
        .submitInput(TASK_CONTINUE_PROMPT, { conversationId })
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

  return (
    <div className="task-board" data-view="task-board">
      <div className="task-board-topbar">
        <div className="task-board-title-wrap">
          <div className="task-board-title">
            <HelmxIcon name="check-square" size={16} />
            <span>{t(TASK_BOARD_TITLE)}</span>
          </div>
          <span className="task-board-subtitle text-subtle">
            {boardLoaded && board !== undefined
              ? taskBoardStats(board.tasks.length, inFlightCount, columns.in_review.length, locale)
              : t(TASK_EMPTY_LOADING)}
          </span>
        </div>
        <div className="task-board-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title={t(TASK_CHAT_TASK_TITLE)}
            onClick={() => ctx.openScreen(`agent:${config.defaultPlannerProfile || 'assistant'}`)}
          >
            <HelmxIcon name="message-square" size={12} />
            <span>{t(TASK_CHAT_TASK)}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title={t(TASK_NEW_TASK_TITLE)}
            onClick={() => setCreateOpen(true)}
          >
            <HelmxIcon name="plus" size={12} />
            <span>{t(TASK_NEW_TASK)}</span>
          </button>
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
        <div className="task-board-filters">
          {filterSelect('project', t(TASK_FILTER_PROJECT), options.projects)}
          {filterSelect('assignee', t(TASK_FILTER_ASSIGNEE), options.assignees)}
          {filterSelect('node', t(TASK_FILTER_NODE), options.nodes)}
          {hasActiveFilter ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setQueryDraft('')
                props.setParams({ q: undefined, project: undefined, assignee: undefined, node: undefined })
              }}
            >
              <HelmxIcon name="rotate-ccw" size={11} />
              <span>{t(TASK_FILTER_RESET)}</span>
            </button>
          ) : null}
        </div>
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
          <div className="task-board-actions" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title={t(TASK_CHAT_TASK_TITLE)}
              onClick={() => ctx.openScreen(`agent:${config.defaultPlannerProfile || 'assistant'}`)}
            >
              <HelmxIcon name="message-square" size={12} />
              <span>{t(TASK_CHAT_TASK)}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title={t(TASK_NEW_TASK_TITLE)}
              onClick={() => setCreateOpen(true)}
            >
              <HelmxIcon name="plus" size={12} />
              <span>{t(TASK_NEW_TASK)}</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Desktop four-column board */}
          <div className="task-board-desktop">
            <div className="task-board-columns">
              {TASK_COLUMNS.map((column: TaskColumn) => (
                <div key={column} className="task-column" data-task-column={column}>
                  <div className="task-column-header">
                    <span className="task-column-title">{taskColumnLabel(column, locale)}</span>
                    <span className="badge badge-neutral tabular-nums">{columns[column].length}</span>
                  </div>
                  <div className="task-column-list">
                    {columns[column].length > 0 ? (
                      columns[column].map(renderCard)
                    ) : (
                      <div className="task-column-empty">{taskColumnLabel(column, locale)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Mobile clear-down flow: four capsules + single column */}
          <div className="task-board-mobile">
            <div className="task-board-mobile-tabs">
              <SegmentedControl
                value={params.tab}
                onValueChange={(tab: TaskMobileTab) => props.setParams({ tab })}
                aria-label={t(TASK_MOBILE_TABS_ARIA)}
                className="task-mobile-tabs"
                items={TASK_MOBILE_TABS.map((tab) => ({
                  value: tab,
                  label: taskMobileTabLabel(tab, locale),
                  badge: <span className="badge badge-neutral tabular-nums">{mobileBuckets[tab].length}</span>,
                }))}
              />
            </div>
            <div className="task-board-mobile-list">
              {mobileBuckets[params.tab].length > 0 ? (
                mobileBuckets[params.tab].map(renderCard)
              ) : (
                <div className="task-board-empty">
                  <div className="task-board-empty-title">{t(TASK_EMPTY_NO_MATCH)}</div>
                  <div className="task-board-empty-hint text-subtle">{t(TASK_EMPTY_HINT_NO_MATCH)}</div>
                </div>
              )}
            </div>
          </div>

          {filtered.length === 0 && items.length > 0 ? (
            <div className="task-board-empty">
              <HelmxIcon name="search" size={26} />
              <div className="task-board-empty-title">{t(TASK_EMPTY_NO_MATCH)}</div>
              <div className="task-board-empty-hint text-subtle">{t(TASK_EMPTY_HINT_NO_MATCH)}</div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQueryDraft('')
                  props.setParams({ q: undefined, project: undefined, assignee: undefined, node: undefined })
                }}
              >
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
          dependencyOptions={(board?.tasks ?? []).filter((task) => task.column !== 'done').map((task) => task.id)}
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
        />
      ) : null}
    </div>
  )
}
