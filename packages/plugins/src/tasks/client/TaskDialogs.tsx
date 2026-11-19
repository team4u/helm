/**
 * builtin:tasks dialogs and the task detail drawer (component exports only,
 * Fast Refresh compliant).
 *
 * - TaskCreateDialog: lightweight centered modal capturing title / brief /
 *   project / assignee / node / cwd / dependsOn plus the autoStart /
 *   planFirst / autoMerge switches; submit goes through ctx.callAction('create')
 *   and backend errors render verbatim (never swallowed).
 * - TaskReworkDialog: centered modal collecting the rework feedback and
 *   calling ctx.callAction('rework').
 * - TaskDetailDrawer: right-side 540px drawer (host .primary-drawer-* shell)
 *   for backlog / done / conversation-less tasks: full brief, dependency
 *   chain, submission facts, inline edit (title / brief / project), start /
 *   approve / rework / archive / delete with a two-step delete confirm.
 *
 * Data flows through the @helmx/plugin-client shared hooks and the plugin
 * context; display copy resolves from copy.ts against the host locale.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  StatusLight,
  Switch,
  formatTime,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import type { TaskItem, TaskRecord } from './models.ts'
import {
  TASK_ACTION_APPROVE,
  TASK_ACTION_APPROVE_TITLE,
  TASK_ACTION_ARCHIVE,
  TASK_ACTION_ARCHIVE_TITLE,
  TASK_ACTION_CANCEL,
  TASK_ACTION_CLOSE,
  TASK_ACTION_DELETE,
  TASK_ACTION_DELETE_TITLE,
  TASK_ACTION_EDIT,
  TASK_ACTION_FAILED,
  TASK_ACTION_MERGE_CLOSE,
  TASK_ACTION_MERGE_CLOSE_TITLE,
  TASK_ACTION_REWORK,
  TASK_ACTION_REWORK_TITLE,
  TASK_ACTION_SAVE,
  TASK_ACTION_START,
  TASK_ACTION_START_TITLE,
  TASK_CREATING,
  TASK_CREATE_DIALOG_TITLE,
  TASK_CREATE_SUBMIT,
  TASK_DELETE_CONFIRM,
  TASK_DELETING,
  TASK_DEP_DONE,
  TASK_DEP_OFF_BOARD,
  TASK_DEP_OFF_BOARD_TITLE,
  TASK_DEP_PENDING,
  TASK_DEPS_NONE,
  TASK_DEPS_SECTION,
  TASK_MERGE_PENDING_DISABLED_TITLE,
  TASK_FIELD_ASSIGNEE,
  TASK_FIELD_ASSIGNEE_PLACEHOLDER,
  TASK_FIELD_AUTO_MERGE,
  TASK_FIELD_AUTO_MERGE_DESC,
  TASK_FIELD_AUTO_START,
  TASK_FIELD_AUTO_START_DESC,
  TASK_FIELD_BRIEF,
  TASK_FIELD_BRIEF_PLACEHOLDER,
  TASK_FIELD_CWD,
  TASK_FIELD_CWD_PLACEHOLDER,
  TASK_FIELD_DEPENDS_ON,
  TASK_FIELD_DEPENDS_ON_PLACEHOLDER,
  TASK_FIELD_NODE,
  TASK_FIELD_NODE_PLACEHOLDER,
  TASK_FIELD_PLAN_FIRST,
  TASK_FIELD_PLAN_FIRST_DESC,
  TASK_FIELD_PROJECT,
  TASK_FIELD_PROJECT_PLACEHOLDER,
  TASK_FIELD_TITLE,
  TASK_FIELD_TITLE_PLACEHOLDER,
  TASK_KV_ASSIGNEE,
  TASK_KV_COMPLETED,
  TASK_KV_CONVERSATION,
  TASK_KV_CREATED,
  TASK_KV_CWD,
  TASK_KV_ID,
  TASK_KV_MODEL,
  TASK_KV_NODE,
  TASK_KV_ORIGIN,
  TASK_KV_STARTED,
  TASK_KV_SUBMITTED_AT,
  TASK_REWORK_FEEDBACK_LABEL,
  TASK_REWORK_FEEDBACK_PLACEHOLDER,
  TASK_REWORK_SENDING,
  TASK_REWORK_SUBMIT,
  TASK_SAVING,
  TASK_SECTION_BRIEF,
  TASK_SECTION_LAST_REWORK,
  TASK_SECTION_SUBMISSION,
  TASK_SUBMIT_REQUIRED,
  TASK_TITLE_TOO_LONG,
  taskChangedFiles,
  taskColumnLabel,
  taskConversationJumpTitle,
  taskCreateDialogAria,
  taskDetailDialogLabel,
  taskLightLabel,
  taskOriginJumpTitle,
  taskReworkDialogAria,
  taskReworkDialogTitle,
} from './copy.ts'

/** Parse a comma-separated task-id list into clean unique ids. */
function parseDependsOnInput(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(/[,，]/)) {
    const id = part.trim()
    if (id !== '') seen.add(id)
  }
  return [...seen]
}

function modalFormField(
  label: string,
  children: ReactNode,
  error?: string,
): ReactNode {
  return (
    <div className="task-form-field">
      <span className="task-form-label">{label}</span>
      {children}
      {error !== undefined && error !== '' ? <span className="task-form-field-error">{error}</span> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

export interface TaskCreateDialogProps {
  open: boolean
  onClose: () => void
  /** Candidate dependency ids (existing tasks), used only as an input hint. */
  dependencyOptions?: readonly string[]
}

export function TaskCreateDialog(props: TaskCreateDialogProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [project, setProject] = useState('')
  const [assignee, setAssignee] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [cwd, setcwd] = useState('')
  const [dependsOn, setDependsOn] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [planFirst, setPlanFirst] = useState(false)
  const [autoMerge, setAutoMerge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!props.open) {
      setTitle('')
      setBrief('')
      setProject('')
      setAssignee('')
      setNodeId('')
      setcwd('')
      setDependsOn('')
      setAutoStart(true)
      setPlanFirst(false)
      setAutoMerge(false)
      setSubmitting(false)
      setError(null)
      setTouched(false)
    }
  }, [props.open])

  const titleError = touched && title.trim() === '' ? t(TASK_SUBMIT_REQUIRED)
    : title.length > 120 ? t(TASK_TITLE_TOO_LONG)
    : undefined
  const briefError = touched && brief.trim() === '' ? t(TASK_SUBMIT_REQUIRED) : undefined

  const submit = (): void => {
    if (submitting) return
    setTouched(true)
    if (title.trim() === '' || brief.trim() === '' || title.length > 120) return
    setSubmitting(true)
    setError(null)
    const deps = parseDependsOnInput(dependsOn)
    void ctx
      .callAction('create', {
        title: title.trim(),
        brief,
        ...(project.trim() !== '' ? { project: project.trim() } : {}),
        ...(assignee.trim() !== '' ? { assigneeProfileId: assignee.trim() } : {}),
        ...(nodeId.trim() !== '' ? { nodeId: nodeId.trim() } : {}),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
        ...(deps.length > 0 ? { dependsOn: deps } : {}),
        planFirst,
        autoMerge,
        autoStart,
      })
      .then(() => {
        props.onClose()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  const depsHint =
    props.dependencyOptions !== undefined && props.dependencyOptions.length > 0
      ? props.dependencyOptions.slice(0, 12).join(', ')
      : undefined

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !submitting) props.onClose() }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="modal task-modal" aria-label={taskCreateDialogAria(locale)}>
          <div className="modal-header">
            <div className="task-modal-title-row">
              <HelmxIcon name="check-square" size={15} />
              <DialogTitle className="modal-title">{t(TASK_CREATE_DIALOG_TITLE)}</DialogTitle>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t(TASK_ACTION_CLOSE)} title={t(TASK_ACTION_CLOSE)}>
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>
          <div className="modal-body task-modal-body">
            {modalFormField(
              t(TASK_FIELD_TITLE),
              <input
                type="text"
                value={title}
                maxLength={120}
                placeholder={t(TASK_FIELD_TITLE_PLACEHOLDER)}
                aria-label={t(TASK_FIELD_TITLE)}
                onChange={(e) => setTitle(e.target.value)}
              />,
              titleError,
            )}
            {modalFormField(
              t(TASK_FIELD_BRIEF),
              <textarea
                value={brief}
                rows={5}
                placeholder={t(TASK_FIELD_BRIEF_PLACEHOLDER)}
                aria-label={t(TASK_FIELD_BRIEF)}
                onChange={(e) => setBrief(e.target.value)}
              />,
              briefError,
            )}
            <div className="task-form-grid-2">
              {modalFormField(
                t(TASK_FIELD_PROJECT),
                <input
                  type="text"
                  value={project}
                  placeholder={t(TASK_FIELD_PROJECT_PLACEHOLDER)}
                  aria-label={t(TASK_FIELD_PROJECT)}
                  onChange={(e) => setProject(e.target.value)}
                />,
              )}
              {modalFormField(
                t(TASK_FIELD_ASSIGNEE),
                <input
                  type="text"
                  value={assignee}
                  placeholder={t(TASK_FIELD_ASSIGNEE_PLACEHOLDER)}
                  aria-label={t(TASK_FIELD_ASSIGNEE)}
                  onChange={(e) => setAssignee(e.target.value)}
                />,
              )}
            </div>
            <div className="task-form-grid-2">
              {modalFormField(
                t(TASK_FIELD_NODE),
                <input
                  type="text"
                  value={nodeId}
                  placeholder={t(TASK_FIELD_NODE_PLACEHOLDER)}
                  aria-label={t(TASK_FIELD_NODE)}
                  onChange={(e) => setNodeId(e.target.value)}
                />,
              )}
              {modalFormField(
                t(TASK_FIELD_CWD),
                <input
                  type="text"
                  value={cwd}
                  placeholder={t(TASK_FIELD_CWD_PLACEHOLDER)}
                  aria-label={t(TASK_FIELD_CWD)}
                  onChange={(e) => setcwd(e.target.value)}
                />,
              )}
            </div>
            {modalFormField(
              t(TASK_FIELD_DEPENDS_ON),
              <input
                type="text"
                value={dependsOn}
                placeholder={depsHint !== undefined ? `${t(TASK_FIELD_DEPENDS_ON_PLACEHOLDER)} (${depsHint})` : t(TASK_FIELD_DEPENDS_ON_PLACEHOLDER)}
                aria-label={t(TASK_FIELD_DEPENDS_ON)}
                onChange={(e) => setDependsOn(e.target.value)}
              />,
            )}
            <div className="task-form-switches">
              <div className="task-form-switch-row">
                <Switch checked={autoStart} onChange={setAutoStart} aria-label={t(TASK_FIELD_AUTO_START)} />
                <span className="task-form-switch-text">
                  <span className="task-form-switch-label">{t(TASK_FIELD_AUTO_START)}</span>
                  <span className="task-form-switch-desc">{t(TASK_FIELD_AUTO_START_DESC)}</span>
                </span>
              </div>
              <div className="task-form-switch-row">
                <Switch checked={planFirst} onChange={setPlanFirst} aria-label={t(TASK_FIELD_PLAN_FIRST)} />
                <span className="task-form-switch-text">
                  <span className="task-form-switch-label">{t(TASK_FIELD_PLAN_FIRST)}</span>
                  <span className="task-form-switch-desc">{t(TASK_FIELD_PLAN_FIRST_DESC)}</span>
                </span>
              </div>
              <div className="task-form-switch-row">
                <Switch checked={autoMerge} onChange={setAutoMerge} aria-label={t(TASK_FIELD_AUTO_MERGE)} />
                <span className="task-form-switch-text">
                  <span className="task-form-switch-label">{t(TASK_FIELD_AUTO_MERGE)}</span>
                  <span className="task-form-switch-desc">{t(TASK_FIELD_AUTO_MERGE_DESC)}</span>
                </span>
              </div>
            </div>
            {error !== null ? <div className="task-modal-error">{error}</div> : null}
          </div>
          <div className="task-modal-footer">
            <button type="button" className="btn btn-sm btn-ghost" disabled={submitting} onClick={props.onClose}>
              <span>{t(TASK_ACTION_CANCEL)}</span>
            </button>
            <button type="button" className="btn btn-sm" disabled={submitting} onClick={submit}>
              <HelmxIcon name="plus" size={12} />
              <span>{submitting ? t(TASK_CREATING) : t(TASK_CREATE_SUBMIT)}</span>
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rework dialog
// ---------------------------------------------------------------------------

export interface TaskReworkDialogProps {
  taskId: string
  title: string | undefined
  open: boolean
  onClose: () => void
}

export function TaskReworkDialog(props: TaskReworkDialogProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!props.open) {
      setFeedback('')
      setSubmitting(false)
      setError(null)
      setTouched(false)
    }
  }, [props.open])

  const feedbackError = touched && feedback.trim() === '' ? t(TASK_SUBMIT_REQUIRED) : undefined

  const submit = (): void => {
    if (submitting) return
    setTouched(true)
    if (feedback.trim() === '') return
    setSubmitting(true)
    setError(null)
    void ctx
      .callAction('rework', { taskId: props.taskId, feedback })
      .then(() => {
        props.onClose()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !submitting) props.onClose() }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="modal task-modal" aria-label={taskReworkDialogAria(props.taskId, locale)}>
          <div className="modal-header">
            <div className="task-modal-title-row">
              <HelmxIcon name="rotate-ccw" size={15} />
              <DialogTitle className="modal-title">{taskReworkDialogTitle(props.taskId, locale)}</DialogTitle>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t(TASK_ACTION_CLOSE)} title={t(TASK_ACTION_CLOSE)}>
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>
          <div className="modal-body task-modal-body">
            {props.title !== undefined ? (
              <DialogDescription className="task-board-subtitle text-secondary">{props.title}</DialogDescription>
            ) : null}
            {modalFormField(
              t(TASK_REWORK_FEEDBACK_LABEL),
              <textarea
                value={feedback}
                rows={4}
                placeholder={t(TASK_REWORK_FEEDBACK_PLACEHOLDER)}
                aria-label={t(TASK_REWORK_FEEDBACK_LABEL)}
                onChange={(e) => setFeedback(e.target.value)}
              />,
              feedbackError,
            )}
            {error !== null ? <div className="task-modal-error">{error}</div> : null}
          </div>
          <div className="task-modal-footer">
            <button type="button" className="btn btn-sm btn-ghost" disabled={submitting} onClick={props.onClose}>
              <span>{t(TASK_ACTION_CANCEL)}</span>
            </button>
            <button type="button" className="btn btn-sm" disabled={submitting} onClick={submit}>
              <HelmxIcon name="send" size={12} />
              <span>{submitting ? t(TASK_REWORK_SENDING) : t(TASK_REWORK_SUBMIT)}</span>
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

export interface TaskDetailDrawerProps {
  item: TaskItem
  tasksById: ReadonlyMap<string, TaskRecord>
  inline?: boolean
  onClose: () => void
  /** Open the rework dialog for this task (owned by the screen). */
  onRework: (taskId: string) => void
}

function kvRow(label: string, value: ReactNode): ReactNode {
  return (
    <div className="form-grid-row">
      <span className="form-grid-label"><span>{label}</span></span>
      <span className="form-grid-value">{value}</span>
    </div>
  )
}

export function TaskDetailDrawer(props: TaskDetailDrawerProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { task, live } = props.item

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(task.title)
  const [editBrief, setEditBrief] = useState(task.brief)
  const [editProject, setEditProject] = useState(task.project ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setEditing(false)
    setEditTitle(task.title)
    setEditBrief(task.brief)
    setEditProject(task.project ?? '')
    setBusy(false)
    setError(null)
    setConfirmDelete(false)
  }, [task.id])

  const runAction = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void action()
      .catch((err: unknown) => {
        setError(`${t(TASK_ACTION_FAILED)}: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const submission = task.submission
  const depRows = useMemo(
    () =>
      task.dependsOn.map((depId) => {
        const dep = props.tasksById.get(depId)
        return {
          depId,
          state: dep === undefined ? ('off-board' as const) : dep.column === 'done' ? ('done' as const) : ('pending' as const),
        }
      }),
    [task.dependsOn, props.tasksById],
  )

  const saveEdit = (): void => {
    if (busy) return
    if (editTitle.trim() === '') {
      setError(`${t(TASK_ACTION_FAILED)}: ${t(TASK_SUBMIT_REQUIRED)}`)
      return
    }
    runAction(() =>
      ctx.callAction('update', {
        taskId: task.id,
        title: editTitle.trim(),
        brief: editBrief,
        ...(editProject.trim() !== '' ? { project: editProject.trim() } : {}),
      }).then(() => setEditing(false)),
    )
  }

  const hasMergeMaterial = submission?.branch !== undefined || submission?.worktreePath !== undefined

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) props.onClose() }}>
      <DialogPortal inline={props.inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content task-detail-drawer"
          role="dialog"
          aria-label={taskDetailDialogLabel(task.title, locale)}
        >
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <HelmxIcon name="check-square" size={18} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">{task.title}</DialogTitle>
                  <span className="badge badge-neutral mono">{task.id}</span>
                  <StatusLight status={live.lightStatus} label={taskLightLabel(live.lightStatus, locale)} />
                </div>
                <div className="primary-drawer-id mono">{taskColumnLabel(task.column, locale)}</div>
              </div>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t(TASK_ACTION_CLOSE)} title={t(TASK_ACTION_CLOSE)}>
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {live.liveSummary !== '' ? (
              <div className={`task-card-live${live.lightStatus === 'error' ? ' is-error' : live.needsAttention ? ' is-attention' : ''}`}>
                <StatusLight status={live.lightStatus} label={taskLightLabel(live.lightStatus, locale)} />
                <span className="task-card-live-text" title={live.liveSummary}>{live.liveSummary}</span>
              </div>
            ) : null}

            <div className="form-grid">
              {kvRow(t(TASK_KV_ID), <span className="mono">{task.id}</span>)}
              {kvRow(t(TASK_KV_ASSIGNEE), <span className="mono">{task.assigneeProfileId}</span>)}
              {task.nodeId !== undefined ? kvRow(t(TASK_KV_NODE), <span className="mono">{task.nodeId}</span>) : null}
              {task.cwd !== undefined ? kvRow(t(TASK_KV_CWD), <span className="mono" title={task.cwd}>{task.cwd}</span>) : null}
              {task.model !== undefined ? kvRow(t(TASK_KV_MODEL), <span className="mono">{task.model}</span>) : null}
              {task.createdAt > 0 ? kvRow(t(TASK_KV_CREATED), <span className="tabular-nums">{formatTime(task.createdAt)}</span>) : null}
              {task.startedAt !== undefined && task.startedAt > 0
                ? kvRow(t(TASK_KV_STARTED), <span className="tabular-nums">{formatTime(task.startedAt)}</span>)
                : null}
              {task.completedAt !== undefined && task.completedAt > 0
                ? kvRow(t(TASK_KV_COMPLETED), <span className="tabular-nums">{formatTime(task.completedAt)}</span>)
                : null}
              {task.conversationId !== undefined
                ? kvRow(
                    t(TASK_KV_CONVERSATION),
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs mono"
                      title={taskConversationJumpTitle(task.conversationId, locale)}
                      onClick={() => ctx.openConversationDrawer(live.jumpConversationId ?? task.conversationId ?? 0)}
                    >
                      <HelmxIcon name="message-square" size={11} />
                      <span>#{live.jumpConversationId ?? task.conversationId}</span>
                    </button>,
                  )
                : null}
              {task.originConversationId !== undefined
                ? kvRow(
                    t(TASK_KV_ORIGIN),
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs mono"
                      title={taskOriginJumpTitle(task.originConversationId, locale)}
                      onClick={() => ctx.openScreen(`conversation:${task.originConversationId}`)}
                    >
                      <HelmxIcon name="corner-down-right" size={11} />
                      <span>#{task.originConversationId}</span>
                    </button>,
                  )
                : null}
            </div>

            <div className="task-detail-section">
              <h4 className="task-detail-section-title">
                <HelmxIcon name="file-text" size={13} />
                <span>{t(TASK_SECTION_BRIEF)}</span>
              </h4>
              {editing ? (
                <div className="task-detail-section">
                  {modalFormField(t(TASK_FIELD_TITLE), (
                    <input type="text" value={editTitle} maxLength={120} aria-label={t(TASK_FIELD_TITLE)} onChange={(e) => setEditTitle(e.target.value)} />
                  ))}
                  {modalFormField(t(TASK_FIELD_BRIEF), (
                    <textarea value={editBrief} rows={8} aria-label={t(TASK_FIELD_BRIEF)} onChange={(e) => setEditBrief(e.target.value)} />
                  ))}
                  {modalFormField(t(TASK_FIELD_PROJECT), (
                    <input type="text" value={editProject} aria-label={t(TASK_FIELD_PROJECT)} onChange={(e) => setEditProject(e.target.value)} />
                  ))}
                </div>
              ) : (
                <div className="task-detail-brief">{task.brief}</div>
              )}
            </div>

            <div className="task-detail-section">
              <h4 className="task-detail-section-title">
                <HelmxIcon name="list-tree" size={13} />
                <span>{t(TASK_DEPS_SECTION)}</span>
              </h4>
              {depRows.length === 0 ? (
                <span className="text-subtle">{t(TASK_DEPS_NONE)}</span>
              ) : (
                <div className="task-detail-deps">
                  {depRows.map((row) => (
                    <div key={row.depId} className="task-detail-dep-row">
                      <span className="mono">{row.depId}</span>
                      {row.state === 'done' ? (
                        <span className="badge badge-ok">{t(TASK_DEP_DONE)}</span>
                      ) : row.state === 'off-board' ? (
                        <span className="badge badge-neutral" title={t(TASK_DEP_OFF_BOARD_TITLE)}>
                          {t(TASK_DEP_OFF_BOARD)}
                        </span>
                      ) : (
                        <span className="badge badge-warn">{t(TASK_DEP_PENDING)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {submission !== undefined ? (
              <div className="task-detail-section">
                <h4 className="task-detail-section-title">
                  <HelmxIcon name="git-branch" size={13} />
                  <span>{t(TASK_SECTION_SUBMISSION)}</span>
                </h4>
                <div className="task-card-submission">
                  <div className="task-card-submission-summary">{submission.summary}</div>
                  {submission.verification !== undefined ? (
                    <div className="task-card-submission-facts">
                      <HelmxIcon name="shield" size={11} />
                      <span title={submission.verification}>{submission.verification}</span>
                    </div>
                  ) : null}
                  <div className="task-card-submission-facts">
                    {submission.branch !== undefined ? <span className="mono">{submission.branch}</span> : null}
                    {submission.changedFiles !== undefined && submission.changedFiles.length > 0
                      ? <span>{taskChangedFiles(submission.changedFiles.length, locale)}</span>
                      : null}
                    {submission.submittedAt > 0
                      ? <span className="tabular-nums">{t(TASK_KV_SUBMITTED_AT)} {formatTime(submission.submittedAt)}</span>
                      : null}
                  </div>
                  {submission.worktreePath !== undefined ? (
                    <div className="task-card-submission-facts">
                      <HelmxIcon name="folder" size={11} />
                      <span className="mono" title={submission.worktreePath}>{submission.worktreePath}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {task.lastReworkFeedback !== undefined ? (
              <div className="task-detail-section">
                <h4 className="task-detail-section-title">
                  <HelmxIcon name="rotate-ccw" size={13} />
                  <span>{t(TASK_SECTION_LAST_REWORK)}</span>
                </h4>
                <div className="task-detail-brief">{task.lastReworkFeedback}</div>
              </div>
            ) : null}
          </div>

          {error !== null ? (
            <div className="text-danger" style={{ padding: '0 20px 8px', fontSize: '12px' }}>{error}</div>
          ) : null}

          <div className="primary-drawer-footer">
            {confirmDelete ? (
              <div className="task-detail-delete-confirm">
                <span className="text-subtle">{t(TASK_DELETE_CONFIRM)}</span>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  <span>{t(TASK_ACTION_CANCEL)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => runAction(() => ctx.callAction('delete', { taskId: task.id }).then(props.onClose))}
                >
                  <HelmxIcon name="trash-2" size={12} />
                  <span>{busy ? t(TASK_DELETING) : t(TASK_ACTION_DELETE)}</span>
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={props.onClose}>
                  <span>{t(TASK_ACTION_CLOSE)}</span>
                </button>
                {editing ? (
                  <>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
                      <span>{t(TASK_ACTION_CANCEL)}</span>
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={saveEdit}>
                      <HelmxIcon name="check" size={12} />
                      <span>{busy ? t(TASK_SAVING) : t(TASK_ACTION_SAVE)}</span>
                    </button>
                  </>
                ) : (
                  <>
                    {task.column === 'backlog' && live.isReadyToStart ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        title={t(TASK_ACTION_START_TITLE)}
                        onClick={() => runAction(() => ctx.callAction('start', { taskId: task.id }))}
                      >
                        <HelmxIcon name="play" size={12} />
                        <span>{t(TASK_ACTION_START)}</span>
                      </button>
                    ) : null}
                    {task.column === 'in_review' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy || task.mergePending === true}
                          title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_REWORK_TITLE)}
                          onClick={() => props.onRework(task.id)}
                        >
                          <HelmxIcon name="rotate-ccw" size={12} />
                          <span>{t(TASK_ACTION_REWORK)}</span>
                        </button>
                        {hasMergeMaterial ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={busy || task.mergePending === true}
                            title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_MERGE_CLOSE_TITLE)}
                            onClick={() => runAction(() => ctx.callAction('approve', { taskId: task.id, mergeAction: 'merge_and_close' }))}
                          >
                            <HelmxIcon name="git-pull-request" size={12} />
                            <span>{t(TASK_ACTION_MERGE_CLOSE)}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy || task.mergePending === true}
                          title={task.mergePending === true ? t(TASK_MERGE_PENDING_DISABLED_TITLE) : t(TASK_ACTION_APPROVE_TITLE)}
                          onClick={() => runAction(() => ctx.callAction('approve', { taskId: task.id, mergeAction: 'close_only' }))}
                        >
                          <HelmxIcon name="check" size={12} />
                          <span>{t(TASK_ACTION_APPROVE)}</span>
                        </button>
                      </>
                    ) : null}
                    {task.column === 'done' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        title={t(TASK_ACTION_ARCHIVE_TITLE)}
                        onClick={() => runAction(() => ctx.callAction('archive', { taskId: task.id }))}
                      >
                        <HelmxIcon name="archive" size={12} />
                        <span>{t(TASK_ACTION_ARCHIVE)}</span>
                      </button>
                    ) : null}
                    {task.column !== 'in_progress' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        title={t(TASK_ACTION_EDIT)}
                        onClick={() => setEditing(true)}
                      >
                        <HelmxIcon name="edit-3" size={12} />
                        <span>{t(TASK_ACTION_EDIT)}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-danger"
                      disabled={busy}
                      title={t(TASK_ACTION_DELETE_TITLE)}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <HelmxIcon name="trash-2" size={12} />
                      <span>{t(TASK_ACTION_DELETE)}</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
