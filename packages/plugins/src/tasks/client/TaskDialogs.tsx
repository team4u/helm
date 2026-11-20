/**
 * builtin:tasks dialogs and the task detail drawer (component exports only,
 * Fast Refresh compliant).
 *
 * - TaskCreateDialog: lightweight centered modal with a 3-second core form
 *   (title / brief / start immediately); secondary fields (project / assignee /
 *   node / cwd / dependsOn MultiSelect / plan first / auto merge) collapse
 *   behind a "More options" disclosure with value chips when set. Submit goes
 *   through ctx.callAction('create') and backend errors render verbatim.
 * - TaskReworkDialog: centered modal collecting the rework feedback and
 *   calling ctx.callAction('rework').
 * - TaskMergeConfirmDialog: explicit consent before merge_and_close (the
 *   branch / worktree / changed-file facts, never a one-tap dispatch).
 * - TaskDetailDrawer: right-side 540px drawer (host .primary-drawer-* shell):
 *   MarkdownView brief / submission summary / verification / rework feedback,
 *   dependency chain, submission facts with clickable
 *   artifact chips (ctx.openArtifact) and an expandable changed-file list,
 *   inline edit (title / brief / project + the same "More options" set as the
 *   create dialog: assignee / node / cwd / dependsOn MultiSelect / plan first /
 *   auto merge; once started the executor / node / cwd inputs lock disabled
 *   with the backend 409 reason while staying visible), start / approve /
 *   rework / archive / delete with a two-step delete confirm.
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
  MarkdownView,
  MultiSelect,
  StatusLight,
  Switch,
  formatTime,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import type { TaskSubmission } from './models.ts'
import type { TaskItem, TaskRecord } from './models.ts'
import { taskLightWord } from './models.ts'
import {
  TASK_ACTION_APPROVE,
  TASK_ACTION_APPROVE_TITLE,
  TASK_ACTION_ARCHIVE,
  TASK_ACTION_ARCHIVE_TITLE,
  TASK_ARCHIVED_BADGE,
  TASK_ARCHIVED_BADGE_TITLE,
  TASK_ACTION_CANCEL,
  TASK_ACTION_CLOSE,
  TASK_ACTION_CONTINUE,
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
  TASK_CHANGED_FILES_COLLAPSE,
  TASK_CHANGED_FILES_EXPAND,
  TASK_CHANGED_FILES_LABEL,
  TASK_CREATING,
  TASK_CREATE_DIALOG_TITLE,
  TASK_CREATE_SUBMIT,
  TASK_DELETE_CONFIRM,
  TASK_DELETING,
  TASK_DEP_DONE,
  TASK_DEP_OFF_BOARD,
  TASK_DEP_OFF_BOARD_TITLE,
  TASK_DEP_PENDING,
  TASK_DEPS_CANDIDATES_EMPTY,
  TASK_DEPS_NONE,
  TASK_DEPS_SECTION,
  TASK_DEPS_UNKNOWN,
  TASK_DEPS_UNKNOWN_TITLE,
  TASK_KICKOFF_UNDELIVERED,
  TASK_KICKOFF_UNDELIVERED_TITLE,
  TASK_ACTION_RESUME_KICKOFF_TITLE,
  TASK_KV_MERGE_MODE,
  TASK_KV_PLAN_APPROVAL,
  TASK_PLAN_APPROVED,
  TASK_PLAN_ASK_PENDING,
  TASK_PLAN_REJECTED,
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
  TASK_FIELD_NODE,
  TASK_FIELD_NODE_PLACEHOLDER,
  TASK_FIELD_PLAN_FIRST,
  TASK_FIELD_PLAN_FIRST_DESC,
  TASK_FIELD_PROJECT,
  TASK_FIELD_PROJECT_PLACEHOLDER,
  TASK_FIELD_TITLE,
  TASK_FIELD_TITLE_PLACEHOLDER,
  TASK_FLAG_AUTO_MERGE_SHORT,
  TASK_FLAG_ISOLATED_BRANCH,
  TASK_FLAG_PLAN_FIRST,
  TASK_KV_ASSIGNEE,
  TASK_KV_COMPLETED,
  TASK_KV_CONVERSATION,
  TASK_KV_CREATED,
  TASK_KV_CWD,
  TASK_KV_ID,
  TASK_KV_MODEL,
  TASK_KV_NODE,
  TASK_KV_THINKING_LEVEL,
  TASK_KV_PLAN_FIRST,
  TASK_KV_ORIGIN,
  TASK_KV_STARTED,
  TASK_KV_SUBMITTED_AT,
  TASK_MORE_OPTIONS,
  TASK_EDIT_STARTED_LOCK_TITLE,
  TASK_REWORK_FEEDBACK_LABEL,
  TASK_REWORK_FEEDBACK_PLACEHOLDER,
  TASK_REWORK_SENDING,
  TASK_REWORK_SUBMIT,
  TASK_SAVING,
  TASK_SECTION_BRIEF,
  TASK_SECTION_LAST_REWORK,
  TASK_SUBMISSION_VERIFICATION,
  TASK_SECTION_SUBMISSION,
  TASK_SUBMISSION_ARTIFACTS,
  TASK_SUBMIT_REQUIRED,
  TASK_TITLE_TOO_LONG,
  TASK_MERGE_CONFIRM_BODY,
  TASK_MERGE_CONFIRM_CANCEL,
  TASK_MERGE_CONFIRM_FILES,
  TASK_MERGE_CONFIRM_SUBMIT,
  TASK_MERGE_CONFIRM_TITLE,
  TASK_MERGE_CONFIRM_TO_BRANCH,
  TASK_MERGE_CONFIRM_UNKNOWN_BRANCH,
  TASK_MERGE_CONFIRM_WORKTREE,
  taskArtifactOpenTitle,
  taskChangedFiles,
  taskColumnLabel,
  taskConversationJumpTitle,
  taskCreateDialogAria,
  taskDetailDialogLabel,
  taskLightLabel,
  taskMergeConfirmAria,
  taskOriginJumpTitle,
  taskReworkDialogAria,
  taskReworkDialogTitle,
} from './copy.ts'

/** Random UUID for the per-intent create key (browser crypto, Node test runtime fallback). */
function randomCreateKeySuffix(): string {
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
  /** Candidate dependencies (existing unfinished tasks) for the MultiSelect. */
  dependencyCandidates?: ReadonlyArray<{ id: string; title: string }>
}

export function TaskCreateDialog(props: TaskCreateDialogProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [project, setProject] = useState('')
  const [assignee, setAssignee] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [cwd, setcwd] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [planFirst, setPlanFirst] = useState(false)
  const [autoMerge, setAutoMerge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  // One stable idempotency key per creation intent: generated when the dialog
  // opens and REUSED across submit retries of the same intent (the backend
  // returns the already-created task for a repeated key — double-submit safe);
  // a fresh dialog session gets a fresh key.
  const [createKey, setCreateKey] = useState('')

  useEffect(() => {
    if (!props.open) {
      setTitle('')
      setBrief('')
      setAutoStart(true)
      setAdvancedOpen(false)
      setProject('')
      setAssignee('')
      setNodeId('')
      setcwd('')
      setDependsOn([])
      setPlanFirst(false)
      setAutoMerge(false)
      setSubmitting(false)
      setError(null)
      setTouched(false)
      setCreateKey('')
      return
    }
    if (createKey === '') setCreateKey(`tcreate-${randomCreateKeySuffix()}`)
  }, [props.open, createKey])

  const titleError = touched && title.trim() === '' ? t(TASK_SUBMIT_REQUIRED)
    : title.length > 120 ? t(TASK_TITLE_TOO_LONG)
    : undefined
  const briefError = touched && brief.trim() === '' ? t(TASK_SUBMIT_REQUIRED) : undefined

  const candidates = props.dependencyCandidates ?? []
  const dependencyOptions = useMemo(
    () => candidates.map((candidate) => ({ value: candidate.id, label: `${candidate.id} · ${candidate.title}` })),
    [candidates],
  )

  // Collapsed-disclosure summary chips: only non-default values, never noise.
  const advancedChips: ReactNode[] = []
  if (project.trim() !== '') advancedChips.push(<span key="project" className="badge badge-neutral">{project.trim()}</span>)
  if (assignee.trim() !== '') advancedChips.push(<span key="assignee" className="badge badge-neutral mono">{assignee.trim()}</span>)
  if (nodeId.trim() !== '') advancedChips.push(<span key="node" className="badge badge-neutral mono">@{nodeId.trim()}</span>)
  if (cwd.trim() !== '') advancedChips.push(<span key="cwd" className="badge badge-neutral mono" title={cwd.trim()}>{cwd.trim()}</span>)
  if (dependsOn.length > 0) {
    advancedChips.push(
      <span key="deps" className="badge badge-neutral mono">{dependsOn.join(', ')}</span>,
    )
  }
  if (planFirst) advancedChips.push(<span key="plan" className="badge badge-neutral">{t(TASK_FLAG_PLAN_FIRST)}</span>)
  if (autoMerge) advancedChips.push(<span key="merge" className="badge badge-neutral">{t(TASK_FLAG_AUTO_MERGE_SHORT)}</span>)

  const submit = (): void => {
    if (submitting) return
    setTouched(true)
    if (title.trim() === '' || brief.trim() === '' || title.length > 120) return
    setSubmitting(true)
    setError(null)
    void ctx
      .callAction('create', {
        ...(createKey !== '' ? { idempotencyKey: createKey } : {}),
        title: title.trim(),
        brief,
        ...(project.trim() !== '' ? { project: project.trim() } : {}),
        ...(assignee.trim() !== '' ? { assigneeProfileId: assignee.trim() } : {}),
        ...(nodeId.trim() !== '' ? { nodeId: nodeId.trim() } : {}),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
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

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !submitting) props.onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal task-modal"
            aria-label={taskCreateDialogAria(locale)}
          >
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
            <div className="task-form-switches task-form-switches-primary">
              <div className="task-form-switch-row">
                <Switch checked={autoStart} onChange={setAutoStart} aria-label={t(TASK_FIELD_AUTO_START)} />
                <span className="task-form-switch-text">
                  <span className="task-form-switch-label">{t(TASK_FIELD_AUTO_START)}</span>
                  <span className="task-form-switch-desc">{t(TASK_FIELD_AUTO_START_DESC)}</span>
                </span>
              </div>
            </div>

            <button
              type="button"
              className="task-form-disclosure"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <HelmxIcon name="chevron-down" size={12} className={`task-form-disclosure-chevron${advancedOpen ? ' is-open' : ''}`} />
              <span className="task-form-disclosure-label">{t(TASK_MORE_OPTIONS)}</span>
              {!advancedOpen && advancedChips.length > 0 ? (
                <span className="task-form-disclosure-chips">{advancedChips}</span>
              ) : null}
            </button>

            {advancedOpen ? (
              <div className="task-form-advanced">
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
                <div className="task-form-field">
                  <span className="task-form-label">{t(TASK_FIELD_DEPENDS_ON)}</span>
                  {dependencyOptions.length > 0 ? (
                    <MultiSelect
                      value={dependsOn}
                      options={dependencyOptions}
                      onValuesChange={(values) => setDependsOn(values)}
                      aria-label={t(TASK_FIELD_DEPENDS_ON)}
                      size="sm"
                      searchable
                    />
                  ) : (
                    <div className="task-form-hint">{t(TASK_DEPS_CANDIDATES_EMPTY)}</div>
                  )}
                </div>
                <div className="task-form-switches">
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
              </div>
            ) : null}

            {error !== null ? <div className="task-modal-error">{error}</div> : null}
          </div>
          <div className="task-modal-footer">
            <button type="button" className="btn btn-sm btn-ghost" disabled={submitting} onClick={props.onClose}>
              <span>{t(TASK_ACTION_CANCEL)}</span>
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={submitting} onClick={submit}>
              <HelmxIcon name="plus" size={12} />
              <span>{submitting ? t(TASK_CREATING) : t(TASK_CREATE_SUBMIT)}</span>
            </button>
          </div>
          </DialogContent>
        </DialogOverlay>
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
        <DialogOverlay>
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
            <button type="button" className="btn btn-sm btn-primary" disabled={submitting} onClick={submit}>
              <HelmxIcon name="send" size={12} />
              <span>{submitting ? t(TASK_REWORK_SENDING) : t(TASK_REWORK_SUBMIT)}</span>
            </button>
          </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Merge & close confirmation
// ---------------------------------------------------------------------------

export interface TaskMergeConfirmDialogProps {
  taskId: string
  title: string
  submission: TaskSubmission | undefined
  open: boolean
  onClose: () => void
  onConfirm: (taskId: string) => void
  busy: boolean
}

/**
 * Explicit confirmation before `approve { mergeAction: 'merge_and_close' }`:
 * the action touches the repository main branch through the executor, so the
 * dialog shows the exact branch, the worktree that will be cleaned up and the
 * changed-file count before dispatching. No auto-merge without this consent.
 */
export function TaskMergeConfirmDialog(props: TaskMergeConfirmDialogProps): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const submission = props.submission
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !props.busy) props.onClose() }}>
      <DialogPortal>
        <DialogOverlay>
          <DialogContent className="modal task-modal" aria-label={taskMergeConfirmAria(props.taskId, locale)}>
          <div className="modal-header">
            <div className="task-modal-title-row">
              <HelmxIcon name="git-pull-request" size={15} />
              <DialogTitle className="modal-title">{t(TASK_MERGE_CONFIRM_TITLE)}</DialogTitle>
              <span className="badge badge-neutral mono">{props.taskId}</span>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t(TASK_ACTION_CLOSE)} title={t(TASK_ACTION_CLOSE)}>
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>
          <div className="modal-body task-modal-body">
            <DialogDescription className="text-secondary" style={{ fontSize: '13px', lineHeight: 1.5 }}>
              {props.title}
            </DialogDescription>
            <div className="callout callout-warn">{t(TASK_MERGE_CONFIRM_BODY)}</div>
            <div className="form-grid">
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{t(TASK_MERGE_CONFIRM_TO_BRANCH)}</span></span>
                <span className="form-grid-value mono">
                  {submission?.branch ?? t(TASK_MERGE_CONFIRM_UNKNOWN_BRANCH)}
                </span>
              </div>
              {submission?.worktreePath !== undefined ? (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(TASK_MERGE_CONFIRM_WORKTREE)}</span></span>
                  <span className="form-grid-value mono" title={submission.worktreePath}>{submission.worktreePath}</span>
                </div>
              ) : null}
              {submission?.changedFiles !== undefined && submission.changedFiles.length > 0 ? (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{t(TASK_MERGE_CONFIRM_FILES)}</span></span>
                  <span className="form-grid-value">{taskChangedFiles(submission.changedFiles.length, locale)}</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="task-modal-footer">
            <button type="button" className="btn btn-sm btn-ghost" disabled={props.busy} onClick={props.onClose}>
              <span>{t(TASK_MERGE_CONFIRM_CANCEL)}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={props.busy}
              onClick={() => props.onConfirm(props.taskId)}
            >
              <HelmxIcon name="git-pull-request" size={12} />
              <span>{t(TASK_MERGE_CONFIRM_SUBMIT)}</span>
            </button>
          </div>
          </DialogContent>
        </DialogOverlay>
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
  /** Open the merge-and-close confirmation for this task (owned by the screen — never a one-tap dispatch). */
  onMerge: (taskId: string) => void
  /** Explicit resume of a kickoff-undelivered task (resume_kickoff action; user-driven only). */
  onResumeKickoff: (taskId: string) => void
  busy: boolean
}

function kvRow(label: string, value: ReactNode): ReactNode {
  return (
    <div className="form-grid-row">
      <span className="form-grid-label"><span>{label}</span></span>
      <span className="form-grid-value">{value}</span>
    </div>
  )
}

/** Compact monospace changed-file list: first 5 + expand toggle when longer. */
function ChangedFilesList(props: { files: readonly string[] }): ReactNode {
  const t = usePluginTranslator()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? props.files : props.files.slice(0, 5)
  return (
    <div className="task-detail-files">
      <div className="task-detail-files-title">
        <HelmxIcon name="file-text" size={11} />
        <span>{t(TASK_CHANGED_FILES_LABEL)}</span>
        <span className="tabular-nums text-subtle">{props.files.length}</span>
      </div>
      <ul className="task-detail-file-list">
        {visible.map((file) => (
          <li key={file} className="mono" title={file}>{file}</li>
        ))}
      </ul>
      {props.files.length > 5 ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs task-detail-files-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? t(TASK_CHANGED_FILES_COLLAPSE) : t(TASK_CHANGED_FILES_EXPAND)}</span>
          <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
        </button>
      ) : null}
    </div>
  )
}

/** Clickable artifact chips (ctx.openArtifact) so reviewers inspect deliverables in place. */
function ArtifactChips(props: { artifactIds: readonly string[] }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  return (
    <div className="task-detail-artifacts">
      <div className="task-detail-files-title">
        <HelmxIcon name="paperclip" size={11} />
        <span>{t(TASK_SUBMISSION_ARTIFACTS)}</span>
        <span className="tabular-nums text-subtle">{props.artifactIds.length}</span>
      </div>
      <div className="task-detail-artifact-chips">
        {props.artifactIds.map((artifactId) => (
          <button
            key={artifactId}
            type="button"
            className="btn btn-ghost btn-xs mono task-detail-artifact-chip"
            title={taskArtifactOpenTitle(artifactId, locale)}
            onClick={() => ctx.openArtifact(artifactId)}
          >
            <HelmxIcon name="paperclip" size={11} />
            <span>{artifactId}</span>
          </button>
        ))}
      </div>
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
  const [editAdvancedOpen, setEditAdvancedOpen] = useState(false)
  const [editAssignee, setEditAssignee] = useState(task.assigneeProfileId)
  const [editNodeId, setEditNodeId] = useState(task.nodeId ?? '')
  const [editCwd, setEditCwd] = useState(task.cwd ?? '')
  const [editDependsOn, setEditDependsOn] = useState<string[]>(task.dependsOn)
  const [editPlanFirst, setEditPlanFirst] = useState(task.planFirst === true)
  const [editAutoMerge, setEditAutoMerge] = useState(task.autoMerge === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setEditing(false)
    setEditTitle(task.title)
    setEditBrief(task.brief)
    setEditProject(task.project ?? '')
    setEditAdvancedOpen(false)
    setEditAssignee(task.assigneeProfileId)
    setEditNodeId(task.nodeId ?? '')
    setEditCwd(task.cwd ?? '')
    setEditDependsOn(task.dependsOn)
    setEditPlanFirst(task.planFirst === true)
    setEditAutoMerge(task.autoMerge === true)
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

  // 进入编辑时从**当前**任务事实重新同步表单（抽屉打开期间 board 投影可能已更新——
  // 只在开抽屉时初始化一次会让编辑态携带陈旧快照覆盖他人改动）。
  const beginEdit = (): void => {
    setEditTitle(task.title)
    setEditBrief(task.brief)
    setEditProject(task.project ?? '')
    setEditAdvancedOpen(false)
    setEditAssignee(task.assigneeProfileId)
    setEditNodeId(task.nodeId ?? '')
    setEditCwd(task.cwd ?? '')
    setEditDependsOn(task.dependsOn)
    setEditPlanFirst(task.planFirst === true)
    setEditAutoMerge(task.autoMerge === true)
    setEditing(true)
  }

  const submission = task.submission
  const depRows = useMemo(() => {
    const authoritative = Array.isArray(task.blockedBy) ? (task.blockedBy ?? []) : undefined
    return task.dependsOn.map((depId) => {
      if (authoritative === undefined) return { depId, state: 'unknown' as const }
      if (authoritative.includes(depId)) return { depId, state: 'pending' as const }
      return { depId, state: props.tasksById.has(depId) ? ('done' as const) : ('done-off-board' as const) }
    })
  }, [task.dependsOn, task.blockedBy, props.tasksById])

  // 启动判定与后端 update 锁同源：已启动（非 backlog 或已绑定会话）时执行角色 / 节点 /
  // 工作目录三字段锁定（409 task_already_started），编辑表单以禁用态如实呈现。
  const started = task.column !== 'backlog' || task.conversationId !== undefined

  // 依赖候选：板上其余任务（含已完成——既有依赖可能指向它们，缺项会让 MultiSelect
  // 静默丢值）；自身永远排除。
  const dependencyOptions = useMemo(() => {
    const ids = new Set<string>([task.id])
    for (const depId of editDependsOn) ids.add(depId)
    const options: Array<{ value: string; label: string }> = []
    for (const depId of ids) {
      if (depId === task.id) continue
      const record = props.tasksById.get(depId)
      options.push({ value: depId, label: record !== undefined ? `${depId} · ${record.title}` : depId })
    }
    for (const other of props.tasksById.values()) {
      if (other.id === task.id || ids.has(other.id)) continue
      options.push({ value: other.id, label: `${other.id} · ${other.title}` })
    }
    return options
  }, [props.tasksById, task.id, editDependsOn])

  const saveEdit = (): void => {
    if (busy) return
    if (editTitle.trim() === '') {
      setError(`${t(TASK_ACTION_FAILED)}: ${t(TASK_SUBMIT_REQUIRED)}`)
      return
    }
    if (!started && editAssignee.trim() === '') {
      setError(`${t(TASK_ACTION_FAILED)}: ${t(TASK_FIELD_ASSIGNEE)} ${t(TASK_SUBMIT_REQUIRED)}`)
      return
    }
    const nextProject = editProject.trim()
    const nextNodeId = editNodeId.trim()
    const nextCwd = editCwd.trim()
    const nextAssignee = editAssignee.trim()
    runAction(() =>
      ctx.callAction('update', {
        taskId: task.id,
        title: editTitle.trim(),
        brief: editBrief,
        // 清空即显式置 null（后端删除回默认链）；未变化的字段不发送。
        ...(nextProject !== (task.project ?? '') ? { project: nextProject === '' ? null : nextProject } : {}),
        ...(!started && nextAssignee !== task.assigneeProfileId ? { assigneeProfileId: nextAssignee } : {}),
        ...(nextNodeId !== (task.nodeId ?? '') ? { nodeId: nextNodeId === '' ? null : nextNodeId } : {}),
        ...(nextCwd !== (task.cwd ?? '') ? { cwd: nextCwd === '' ? null : nextCwd } : {}),
        dependsOn: editDependsOn,
        planFirst: editPlanFirst,
        autoMerge: editAutoMerge,
      }).then(() => setEditing(false)),
    )
  }

  // 折叠态摘要 chips（与新建对话框同词汇）：只显示非默认值，已启动任务的锁定
  // 字段当前值也在此可见（只读事实不因锁定而隐藏）。
  const editAdvancedChips: ReactNode[] = []
  if (editAssignee.trim() !== '') editAdvancedChips.push(<span key="assignee" className="badge badge-neutral mono">{editAssignee.trim()}</span>)
  if (editNodeId.trim() !== '') editAdvancedChips.push(<span key="node" className="badge badge-neutral mono">@{editNodeId.trim()}</span>)
  if (editCwd.trim() !== '') editAdvancedChips.push(<span key="cwd" className="badge badge-neutral mono" title={editCwd.trim()}>{editCwd.trim()}</span>)
  if (editDependsOn.length > 0) {
    editAdvancedChips.push(
      <span key="deps" className="badge badge-neutral mono">{editDependsOn.join(', ')}</span>,
    )
  }
  if (editPlanFirst) editAdvancedChips.push(<span key="plan" className="badge badge-neutral">{t(TASK_FLAG_PLAN_FIRST)}</span>)
  if (editAutoMerge) editAdvancedChips.push(<span key="merge" className="badge badge-neutral">{t(TASK_FLAG_AUTO_MERGE_SHORT)}</span>)

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
                  <StatusLight status={taskLightWord(live.lightStatus)} label={taskLightLabel(live.lightStatus, locale)} />
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
            {task.kickoffUndelivered === true ? (
              <div className="callout callout-warn" title={t(TASK_KICKOFF_UNDELIVERED_TITLE)}>
                {t(TASK_KICKOFF_UNDELIVERED)}
              </div>
            ) : null}
            {live.liveSummary !== '' ? (
              <div className={`task-card-live${live.lightStatus === 'error' ? ' is-error' : live.needsAttention ? ' is-attention' : ''}`}>
                <StatusLight status={taskLightWord(live.lightStatus)} label={taskLightLabel(live.lightStatus, locale)} />
                <span className="task-card-live-text" title={live.liveSummary}>{live.liveSummary}</span>
              </div>
            ) : null}

            <div className="form-grid">
              {kvRow(t(TASK_KV_ID), <span className="mono">{task.id}</span>)}
              {kvRow(t(TASK_KV_ASSIGNEE), <span className="mono">{task.assigneeProfileId}</span>)}
              {task.nodeId !== undefined ? kvRow(t(TASK_KV_NODE), <span className="mono">{task.nodeId}</span>) : null}
              {task.cwd !== undefined ? kvRow(t(TASK_KV_CWD), <span className="mono" title={task.cwd}>{task.cwd}</span>) : null}
              {task.model !== undefined ? kvRow(t(TASK_KV_MODEL), <span className="mono">{task.model}</span>) : null}
              {task.thinkingLevel !== undefined && task.thinkingLevel !== '' ? kvRow(t(TASK_KV_THINKING_LEVEL), <span className="mono">{task.thinkingLevel}</span>) : null}
              {task.planFirst === true ? kvRow(t(TASK_KV_PLAN_FIRST), <span className="badge badge-neutral">{t(TASK_FLAG_PLAN_FIRST)}</span>) : null}
              {kvRow(
                t(TASK_KV_MERGE_MODE),
                task.autoMerge === true ? (
                  <span className="badge badge-ok">{t(TASK_FIELD_AUTO_MERGE)}</span>
                ) : (
                  <span className="badge badge-neutral">{t(TASK_FLAG_ISOLATED_BRANCH)}</span>
                ),
              )}
              {task.pendingPlanAskId !== undefined && task.planApproval === undefined
                ? kvRow(t(TASK_KV_PLAN_APPROVAL), <span className="badge badge-warn">{t(TASK_PLAN_ASK_PENDING)}</span>)
                : null}
              {task.planApproval !== undefined
                ? kvRow(
                    t(TASK_KV_PLAN_APPROVAL),
                    <span>
                      <span className={`badge ${task.planApproval.decision === 'approved' ? 'badge-ok' : 'badge-warn'}`}>
                        {t(task.planApproval.decision === 'approved' ? TASK_PLAN_APPROVED : TASK_PLAN_REJECTED)}
                      </span>
                      {task.planApproval.decidedAt > 0 ? (
                        <span className="tabular-nums" style={{ marginLeft: 6 }}>
                          {formatTime(task.planApproval.decidedAt)}
                        </span>
                      ) : null}
                    </span>,
                  )
                : null}
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
                  <button
                    type="button"
                    className="task-form-disclosure"
                    aria-expanded={editAdvancedOpen}
                    onClick={() => setEditAdvancedOpen((open) => !open)}
                  >
                    <HelmxIcon name="chevron-down" size={12} className={`task-form-disclosure-chevron${editAdvancedOpen ? ' is-open' : ''}`} />
                    <span className="task-form-disclosure-label">{t(TASK_MORE_OPTIONS)}</span>
                    {!editAdvancedOpen && editAdvancedChips.length > 0 ? (
                      <span className="task-form-disclosure-chips">{editAdvancedChips}</span>
                    ) : null}
                  </button>
                  {editAdvancedOpen ? (
                    <div className="task-form-advanced">
                      <div className="task-form-grid-2">
                        {modalFormField(t(TASK_FIELD_ASSIGNEE), (
                          <input
                            type="text"
                            value={editAssignee}
                            placeholder={t(TASK_FIELD_ASSIGNEE_PLACEHOLDER)}
                            aria-label={t(TASK_FIELD_ASSIGNEE)}
                            disabled={started}
                            title={started ? t(TASK_EDIT_STARTED_LOCK_TITLE) : undefined}
                            onChange={(e) => setEditAssignee(e.target.value)}
                          />
                        ))}
                        {modalFormField(t(TASK_FIELD_NODE), (
                          <input
                            type="text"
                            value={editNodeId}
                            placeholder={t(TASK_FIELD_NODE_PLACEHOLDER)}
                            aria-label={t(TASK_FIELD_NODE)}
                            disabled={started}
                            title={started ? t(TASK_EDIT_STARTED_LOCK_TITLE) : undefined}
                            onChange={(e) => setEditNodeId(e.target.value)}
                          />
                        ))}
                      </div>
                      {modalFormField(t(TASK_FIELD_CWD), (
                        <input
                          type="text"
                          value={editCwd}
                          placeholder={t(TASK_FIELD_CWD_PLACEHOLDER)}
                          aria-label={t(TASK_FIELD_CWD)}
                          disabled={started}
                          title={started ? t(TASK_EDIT_STARTED_LOCK_TITLE) : undefined}
                          onChange={(e) => setEditCwd(e.target.value)}
                        />
                      ))}
                      <div className="task-form-field">
                        <span className="task-form-label">{t(TASK_FIELD_DEPENDS_ON)}</span>
                        {dependencyOptions.length > 0 ? (
                          <MultiSelect
                            value={editDependsOn}
                            options={dependencyOptions}
                            onValuesChange={(values) => setEditDependsOn(values)}
                            aria-label={t(TASK_FIELD_DEPENDS_ON)}
                            size="sm"
                            searchable
                          />
                        ) : (
                          <div className="task-form-hint">{t(TASK_DEPS_CANDIDATES_EMPTY)}</div>
                        )}
                      </div>
                      <div className="task-form-switches">
                        <div className="task-form-switch-row">
                          <Switch checked={editPlanFirst} onChange={setEditPlanFirst} aria-label={t(TASK_FIELD_PLAN_FIRST)} />
                          <span className="task-form-switch-text">
                            <span className="task-form-switch-label">{t(TASK_FIELD_PLAN_FIRST)}</span>
                            <span className="task-form-switch-desc">{t(TASK_FIELD_PLAN_FIRST_DESC)}</span>
                          </span>
                        </div>
                        <div className="task-form-switch-row">
                          <Switch checked={editAutoMerge} onChange={setEditAutoMerge} aria-label={t(TASK_FIELD_AUTO_MERGE)} />
                          <span className="task-form-switch-text">
                            <span className="task-form-switch-label">{t(TASK_FIELD_AUTO_MERGE)}</span>
                            <span className="task-form-switch-desc">{t(TASK_FIELD_AUTO_MERGE_DESC)}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="task-detail-brief">
                  <MarkdownView text={task.brief} />
                </div>
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
                      {row.state === 'unknown' ? (
                        <span className="badge badge-warn" title={t(TASK_DEPS_UNKNOWN_TITLE)}>
                          {t(TASK_DEPS_UNKNOWN)}
                        </span>
                      ) : row.state === 'done-off-board' ? (
                        <span className="badge badge-ok" title={t(TASK_DEP_OFF_BOARD_TITLE)}>
                          {t(TASK_DEP_DONE)} · {t(TASK_DEP_OFF_BOARD)}
                        </span>
                      ) : row.state === 'done' ? (
                        <span className="badge badge-ok">{t(TASK_DEP_DONE)}</span>
                      ) : (
                        <span className="badge badge-warn">{t(TASK_DEP_PENDING)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {submission !== undefined && task.column !== 'in_progress' ? (
              <div className="task-detail-section">
                <h4 className="task-detail-section-title">
                  <HelmxIcon name="git-branch" size={13} />
                  <span>{t(TASK_SECTION_SUBMISSION)}</span>
                </h4>
                <div className="task-card-submission task-detail-submission">
                  <div className="task-detail-md">
                    <MarkdownView text={submission.summary} />
                  </div>
                  {submission.verification !== undefined ? (
                    <div className="task-detail-verification">
                      <div className="task-detail-verification-label">
                        <HelmxIcon name="shield" size={11} />
                        <span>{t(TASK_SUBMISSION_VERIFICATION)}</span>
                      </div>
                      <div className="task-detail-md">
                        <MarkdownView text={submission.verification} />
                      </div>
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
                  {submission.changedFiles !== undefined && submission.changedFiles.length > 0 ? (
                    <ChangedFilesList files={submission.changedFiles} />
                  ) : null}
                  {submission.artifactIds !== undefined && submission.artifactIds.length > 0 ? (
                    <ArtifactChips artifactIds={submission.artifactIds} />
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
                <div className="task-detail-brief">
                  <MarkdownView text={task.lastReworkFeedback} />
                </div>
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
                {task.kickoffUndelivered === true ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || props.busy}
                    title={t(TASK_ACTION_RESUME_KICKOFF_TITLE)}
                    onClick={() => props.onResumeKickoff(task.id)}
                  >
                    <HelmxIcon name="play" size={12} />
                    <span>{t(TASK_ACTION_CONTINUE)}</span>
                  </button>
                ) : null}
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
                        className="btn btn-sm btn-primary"
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
                          disabled={busy}
                          title={t(TASK_ACTION_REWORK_TITLE)}
                          onClick={() => props.onRework(task.id)}
                        >
                          <HelmxIcon name="rotate-ccw" size={12} />
                          <span>{t(TASK_ACTION_REWORK)}</span>
                        </button>
                        {hasMergeMaterial ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            title={t(TASK_ACTION_MERGE_CLOSE_TITLE)}
                            onClick={() => props.onMerge(task.id)}
                          >
                            <HelmxIcon name="git-pull-request" size={12} />
                            <span>{t(TASK_ACTION_MERGE_CLOSE)}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          title={t(TASK_ACTION_APPROVE_TITLE)}
                          onClick={() => runAction(() => ctx.callAction('approve', { taskId: task.id, mergeAction: 'close_only' }))}
                        >
                          <HelmxIcon name="check" size={12} />
                          <span>{t(TASK_ACTION_APPROVE)}</span>
                        </button>
                      </>
                    ) : null}
                    {task.column === 'done' ? (
                      task.archived === true ? (
                        <span className="badge badge-neutral" title={t(TASK_ARCHIVED_BADGE_TITLE)}>
                          <HelmxIcon name="archive" size={12} />
                          <span>{t(TASK_ARCHIVED_BADGE)}</span>
                        </span>
                      ) : (
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
                      )
                    ) : null}
                    {task.column !== 'in_progress' ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        title={t(TASK_ACTION_EDIT)}
                        onClick={beginEdit}
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
