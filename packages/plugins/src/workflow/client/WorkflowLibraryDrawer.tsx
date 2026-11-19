/**
 * Workflow library detail drawer component: read-only metadata/source +
 * run (pick a target conversation) + delete; no editing capabilities.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Select,
  formatBytes,
  formatTime,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import { Icon } from './WorkflowIcon.tsx'
import {
  buildWorkflowEditRequest,
  buildWorkflowRunTargetOptions,
  parseWorkflowArgsInput,
  parseWorkflowDetail,
} from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'
import {
  LIB_ARGS_PLACEHOLDER,
  libArgsAria,
  LIB_CANCEL,
  SPIN,
  LIB_CLOSE,
  LIB_COPY_EDIT_REQUEST,
  LIB_COPY_SOURCE,
  LIB_DELETE,
  LIB_DELETE_CONFIRM,
  LIB_DELETE_TITLE,
  libDeleted,
  libDeleteConfirm,
  libDetailInvalid,
  libDrawerAria,
  LIB_EDIT_HINT,
  LIB_EDIT_HINT_2,
  LIB_EDIT_SECTION,
  LIB_KV_DESCRIPTION,
  LIB_KV_PHASES,
  LIB_KV_WHEN_TO_USE,
  libDefinitionFileTitle,
  libMetadataError,
  LIB_METADATA_BADGE,
  LIB_NO_TOP_LEVEL_CONVERSATIONS,
  LIB_PHASES_UNDECLARED,
  libPickConversationFirst,
  LIB_REFRESH,
  libRunButtonTitle,
  LIB_RUN,
  libRunFailed,
  LIB_RUN_SECTION,
  libRunStarted,
  LIB_RUN_SELECT_ARIA,
  LIB_RUN_SELECT_PLACEHOLDER,
  LIB_RETRY,
  LIB_DELETING,
  libSourceLoadFailed,
  LIB_SOURCE_LOADING,
  LIB_SOURCE_RELOAD_TITLE,
  LIB_SOURCE_SECTION,
} from './copy.ts'

export function WorkflowLibraryDrawer(props: {
  item: SavedWorkflowView
  inline?: boolean
  onClose: () => void
  onDeleted: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { item, onClose } = props
  const [detail, setDetail] = useState<{ script: string; description?: string; whenToUse?: string; phases?: SavedWorkflowView['phases'] } | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [detailLoading, setDetailLoading] = useState(true)
  const [argsDraft, setArgsDraft] = useState('')
  const [argsError, setArgsError] = useState<string | undefined>(undefined)
  const [conversationId, setConversationId] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const conversations = useConversations()

  const loadDetail = async (): Promise<void> => {
    const current = ++generation.current
    setDetailLoading(true)
    setDetailError(undefined)
    try {
      const raw = await ctx.callAction('get', { name: item.name })
      if (generation.current !== current) return
      const parsed = parseWorkflowDetail(raw)
      if (parsed === undefined) {
        setDetailError(libDetailInvalid(locale))
      } else {
        setDetail({ script: parsed.script, description: parsed.description, whenToUse: parsed.whenToUse, phases: parsed.phases })
      }
    } catch (err) {
      if (generation.current !== current) return
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setDetailLoading(false)
    }
  }

  useEffect(() => {
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(true)
    setArgsDraft('')
    setArgsError(undefined)
    setConversationId('')
    setConfirmDelete(false)
    setDeleteError(undefined)
    void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.name])

  // Target conversation options: top-level conversations first (subagent
  // conversations never appear in the picker).
  const conversationOptions = useMemo(() => buildWorkflowRunTargetOptions(conversations), [conversations])

  const run = (): void => {
    if (running) return
    if (conversationId === '') {
      setArgsError(libPickConversationFirst(locale))
      return
    }
    const parsed = parseWorkflowArgsInput(argsDraft, locale)
    if (!parsed.ok) {
      setArgsError(parsed.error)
      return
    }
    setArgsError(undefined)
    setRunning(true)
    ctx
      .callAction('run', {
        name: item.name,
        conversationId: Number(conversationId),
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
      })
      .then(() => ctx.notify(libRunStarted(item.name, conversationId, locale)))
      .catch((err: unknown) => ctx.notify(libRunFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
      .finally(() => setRunning(false))
  }

  const remove = (): void => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(undefined)
    ctx
      .callAction('delete', { name: item.name })
      .then(() => {
        ctx.notify(libDeleted(item.name, locale))
        setConfirmDelete(false)
        props.onDeleted()
      })
      .catch((err: unknown) => setDeleteError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDeleting(false))
  }

  const editRequestText = useMemo(
    () => buildWorkflowEditRequest(item.name, { description: detail?.description }, locale),
    [item.name, detail?.description, locale],
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={props.inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content workflow-lib-drawer"
          role="dialog"
          aria-label={libDrawerAria(item.name, locale)}
        >
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <Icon name="terminal" size={18} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">{item.name}</DialogTitle>
                  <span className="badge badge-neutral tabular-nums" title={libDefinitionFileTitle(item.path ?? '', locale)}>
                    {formatBytes(item.size)}
                  </span>
                  <span className="badge badge-neutral tabular-nums">{formatTime(item.updatedAt)}</span>
                  {item.metadataError !== undefined ? <span className="badge badge-warn">{resolveLocalizedText(LIB_METADATA_BADGE, locale)}</span> : null}
                </div>
                <div className="primary-drawer-id mono">{item.path ?? item.name}</div>
              </div>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={resolveLocalizedText(LIB_CLOSE, locale)} title={resolveLocalizedText(LIB_CLOSE, locale)}>
                <Icon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {item.metadataError !== undefined ? (
              <div className="callout callout--warning">{libMetadataError(item.metadataError, locale)}</div>
            ) : null}

            <div className="form-grid">
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{resolveLocalizedText(LIB_KV_DESCRIPTION, locale)}</span></span>
                <span className="form-grid-value" title={detail?.description ?? item.description ?? ''}>
                  {detail?.description ?? item.description ?? '—'}
                </span>
              </div>
              {(detail?.whenToUse ?? item.whenToUse) !== undefined ? (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>{resolveLocalizedText(LIB_KV_WHEN_TO_USE, locale)}</span></span>
                  <span className="form-grid-value" title={(detail?.whenToUse ?? item.whenToUse) ?? ''}>
                    {detail?.whenToUse ?? item.whenToUse}
                  </span>
                </div>
              ) : null}
              <div className="form-grid-row">
                <span className="form-grid-label"><span>{resolveLocalizedText(LIB_KV_PHASES, locale)}</span></span>
                <span className="form-grid-value">
                  {(detail?.phases ?? item.phases) !== undefined
                    ? (detail?.phases ?? item.phases)!.map((p) => p.title).join(' → ')
                    : resolveLocalizedText(LIB_PHASES_UNDECLARED, locale)}
                </span>
              </div>
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">
                {resolveLocalizedText(LIB_SOURCE_SECTION, locale)}
                <button type="button" className="btn btn-ghost btn-xs" disabled={detailLoading} onClick={() => void loadDetail()} title={resolveLocalizedText(LIB_SOURCE_RELOAD_TITLE, locale)}>
                  <Icon name="rotate-cw" size={11} className={detailLoading ? SPIN : undefined} />
                  {resolveLocalizedText(LIB_REFRESH, locale)}
                </button>
              </div>
              {detailLoading && detail === undefined ? <div className="workflow-phase-empty">{resolveLocalizedText(LIB_SOURCE_LOADING, locale)}</div> : null}
              {detailError !== undefined ? (
                <div className="callout callout--error">
                  <div>{libSourceLoadFailed(detailError, locale)}</div>
                  <button type="button" className="btn btn-xs" onClick={() => void loadDetail()}>{resolveLocalizedText(LIB_RETRY, locale)}</button>
                </div>
              ) : null}
              {detail !== undefined ? (
                <>
                  <pre className="code-block-pre workflow-lib-source selectable"><code>{detail.script}</code></pre>
                  <CopyButton text={detail.script} label={resolveLocalizedText(LIB_COPY_SOURCE, locale)} />
                </>
              ) : null}
              <div className="workflow-lib-hint">
                {resolveLocalizedText(LIB_EDIT_HINT, locale)}
              </div>
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">{resolveLocalizedText(LIB_RUN_SECTION, locale)}</div>
              <div className="workflow-lib-run-row">
                <div className="workflow-lib-run-select">
                  <Select
                    value={conversationId}
                    options={conversationOptions}
                    onChange={(e) => setConversationId(e.target.value)}
                    placeholder={resolveLocalizedText(LIB_RUN_SELECT_PLACEHOLDER, locale)}
                    aria-label={resolveLocalizedText(LIB_RUN_SELECT_ARIA, locale)}
                  />
                </div>
                <input
                  className="workflow-library-args"
                  type="text"
                  placeholder={resolveLocalizedText(LIB_ARGS_PLACEHOLDER, locale)}
                  value={argsDraft}
                  onChange={(e) => {
                    setArgsDraft(e.target.value)
                    setArgsError(undefined)
                  }}
                  aria-label={libArgsAria(item.name, locale)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={running || conversationOptions.length === 0}
                  title={conversationOptions.length === 0 ? resolveLocalizedText(LIB_NO_TOP_LEVEL_CONVERSATIONS, locale) : libRunButtonTitle(item.name, locale)}
                  onClick={run}
                >
                  <Icon name={running ? 'loader' : 'play'} size={11} className={running ? SPIN : undefined} />
                  {resolveLocalizedText(LIB_RUN, locale)}
                </button>
              </div>
              {argsError !== undefined ? <div className="callout callout--error">{argsError}</div> : null}
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">{resolveLocalizedText(LIB_EDIT_SECTION, locale)}</div>
              <div className="workflow-lib-hint">
                {resolveLocalizedText(LIB_EDIT_HINT_2, locale)}
              </div>
              <pre className="code-block-pre workflow-lib-edit-request selectable"><code>{editRequestText}</code></pre>
              <CopyButton text={editRequestText} label={resolveLocalizedText(LIB_COPY_EDIT_REQUEST, locale)} />
            </div>
          </div>

          {deleteError !== undefined ? (
            <div className="callout callout--error workflow-lib-delete-error">{deleteError}</div>
          ) : null}

          <div className="primary-drawer-footer">
            {confirmDelete ? (
              <div className="workflow-lib-delete-confirm">
                <span className="text-subtle">{libDeleteConfirm(item.name, locale)}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  {resolveLocalizedText(LIB_CANCEL, locale)}
                </button>
                <button type="button" className="btn btn-sm btn-danger" disabled={deleting} onClick={remove}>
                  <Icon name="x" size={12} />
                  {deleting ? resolveLocalizedText(LIB_DELETING, locale) : resolveLocalizedText(LIB_DELETE_CONFIRM, locale)}
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                  {resolveLocalizedText(LIB_CLOSE, locale)}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-danger"
                  title={resolveLocalizedText(LIB_DELETE_TITLE, locale)}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Icon name="x" size={12} />
                  {resolveLocalizedText(LIB_DELETE, locale)}
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
