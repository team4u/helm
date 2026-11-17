/**
 * Right 540px Member Detail Drawer:
 * - abort_worker when liveState === 'working' | 'blocked';
 * - Radix <Select> model switcher (switch_worker_model) when idle;
 * - read-only worktree snapshot via builtin:workflow inspect_worktree +
 *   "Request Coordinator Merge" (ctx.submitInput to coordinatorConversationId);
 * - ctx.openConversationDrawer(member.conversationId);
 * - archive_worker.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Callout,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmIcon,
  KvGrid,
  Select,
  useConversations,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
  type SelectOption,
} from '@helm/plugin-client'
import {
  collectSelectableModels,
  liveStateBadgeClass,
  parseWorktreeInspectSnapshot,
  type BoardMemberView,
  type BoardViewDoc,
  type WorktreeInspectSnapshot,
} from './board-model.ts'
import {
  SW_ACTION_CLOSE,
  SW_ACTION_REFRESH,
  SW_ACTION_RETRY,
  SW_COPY_PROMPT,
  SW_DRAWER_ABORT_TURN,
  SW_DRAWER_ABORTING,
  SW_DRAWER_ARCHIVE,
  SW_DRAWER_ARCHIVING,
  SW_DRAWER_KV_ACCESS,
  SW_DRAWER_KV_CHANNELS,
  SW_DRAWER_KV_CONVERSATION,
  SW_DRAWER_KV_CURSORS,
  SW_DRAWER_KV_ENV,
  SW_DRAWER_KV_ISOLATION,
  SW_DRAWER_KV_PROFILE,
  SW_DRAWER_MODEL_APPLY,
  SW_DRAWER_MODEL_ARIA,
  SW_DRAWER_MODEL_BUSY_HINT,
  SW_DRAWER_MODEL_CUSTOM_PLACEHOLDER,
  SW_DRAWER_MODEL_DEFAULT,
  SW_DRAWER_MODEL_SECTION,
  SW_DRAWER_OPEN_CONV,
  SW_MERGE_REQUEST_SENT,
  SW_REQUEST_MERGE_BTN,
  SW_WT_CLEAN,
  SW_WT_DIFF_TRUNCATED,
  SW_WT_INSPECTING,
  SW_WT_INVALID,
  SW_WT_KV_AHEAD,
  SW_WT_KV_BASE,
  SW_WT_KV_BRANCH,
  SW_WT_KV_DIRTY,
  SW_WT_SECTION_TITLE,
  swBuildCoordinatorMergeRequest,
  swMemberDrawerAria,
} from './copy.ts'

export interface BoardMemberDrawerProps {
  board: BoardViewDoc
  member: BoardMemberView | undefined
  inline?: boolean
  onClose: () => void
  onMutated?: () => void
}

export function BoardMemberDrawer({
  board,
  member,
  inline,
  onClose,
  onMutated,
}: BoardMemberDrawerProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const conversations = useConversations()

  const [actionPending, setActionPending] = useState<'abort' | 'model' | 'archive' | 'merge' | null>(null)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [customModel, setCustomModel] = useState('')

  const [wtLoading, setWtLoading] = useState(false)
  const [wtError, setWtError] = useState<string | undefined>(undefined)
  const [wtSnapshot, setWtSnapshot] = useState<WorktreeInspectSnapshot | undefined>(undefined)
  const wtGeneration = useRef(0)

  const worktreeId = member?.worktreeId

  const loadWorktree = async (targetWorktreeId: string): Promise<void> => {
    const gen = ++wtGeneration.current
    setWtLoading(true)
    setWtError(undefined)
    try {
      const raw = await ctx.callAction(
        'inspect_worktree',
        { worktreeId: targetWorktreeId },
        { pluginId: 'builtin:workflow' },
      )
      if (wtGeneration.current !== gen) return
      const parsed = parseWorktreeInspectSnapshot(raw)
      if (parsed === undefined) {
        setWtError(t(SW_WT_INVALID))
      } else {
        setWtSnapshot(parsed)
      }
    } catch (err) {
      if (wtGeneration.current !== gen) return
      setWtError(err instanceof Error ? err.message : String(err))
    } finally {
      if (wtGeneration.current === gen) {
        setWtLoading(false)
      }
    }
  }

  useEffect(() => {
    wtGeneration.current += 1
    setActionPending(null)
    setActionError(undefined)
    setCustomModel('')
    setWtSnapshot(undefined)
    setWtError(undefined)
    setWtLoading(false)
    if (worktreeId !== undefined && worktreeId !== '') {
      void loadWorktree(worktreeId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member?.name, worktreeId])

  const modelOptions = useMemo<SelectOption<string>[]>(() => {
    const models = collectSelectableModels(member?.model, board, conversations)
    const opts: SelectOption<string>[] = [
      { value: '', label: t(SW_DRAWER_MODEL_DEFAULT), icon: 'cpu' },
      ...models.map((m) => ({ value: m, label: m, icon: 'cpu' })),
    ]
    return opts
  }, [member?.model, board, conversations, t])

  const mergeRequestText = useMemo(() => {
    if (member === undefined || member.worktreeId === undefined) return ''
    return swBuildCoordinatorMergeRequest(
      {
        groupId: board.group.id,
        memberName: member.name,
        worktreeId: member.worktreeId,
        branch: wtSnapshot?.currentBranch ?? wtSnapshot?.branch ?? member.name,
        path: wtSnapshot?.path ?? member.cwd,
        nodeId: wtSnapshot?.nodeId ?? member.nodeId,
        commitsAhead: wtSnapshot?.commitsAhead,
        dirtyFileCount: wtSnapshot?.dirtyFileCount,
      },
      locale,
    )
  }, [board.group.id, member, wtSnapshot, locale])

  if (member === undefined) return null

  const isBusy = member.liveState === 'working' || member.liveState === 'blocked'
  const canMutateMember = member.lifecycle === 'active' && board.group.status === 'active'

  const handleAbort = async (): Promise<void> => {
    if (actionPending !== null) return
    setActionPending('abort')
    setActionError(undefined)
    try {
      await ctx.callAction('abort_worker', {
        groupId: board.group.id,
        name: member.name,
        workerConversationId: member.conversationId,
      })
      onMutated?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(null)
    }
  }

  const applyModelSwitch = async (nextModel: string): Promise<void> => {
    const trimmed = nextModel.trim()
    if (actionPending !== null || trimmed === '' || trimmed === (member.model ?? '')) return
    setActionPending('model')
    setActionError(undefined)
    try {
      await ctx.callAction('switch_worker_model', {
        groupId: board.group.id,
        name: member.name,
        workerConversationId: member.conversationId,
        model: trimmed,
      })
      setCustomModel('')
      onMutated?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(null)
    }
  }

  const handleArchive = async (): Promise<void> => {
    if (actionPending !== null) return
    setActionPending('archive')
    setActionError(undefined)
    try {
      await ctx.callAction('archive_worker', {
        groupId: board.group.id,
        name: member.name,
        workerConversationId: member.conversationId,
      })
      onMutated?.()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(null)
    }
  }

  const handleRequestMerge = async (): Promise<void> => {
    if (actionPending !== null || mergeRequestText === '') return
    setActionPending('merge')
    setActionError(undefined)
    try {
      await ctx.submitInput(mergeRequestText, {
        conversationId: board.group.coordinatorConversationId,
        whenBusy: 'followUp',
      })
      ctx.notify(t(SW_MERGE_REQUEST_SENT), 'info')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionPending(null)
    }
  }

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }} inline={inline}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content sw-member-drawer"
          aria-label={swMemberDrawerAria(member.name, locale)}
        >
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <HelmIcon name={member.isolation === 'worktree' ? 'git-branch' : 'bot'} size={17} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title mono">
                    @{member.name}
                  </DialogTitle>
                  <span className={`badge ${liveStateBadgeClass(member.liveState)}`}>
                    {member.liveState}
                  </span>
                  <span className="badge badge-neutral mono">#{member.conversationId}</span>
                  {member.lifecycle === 'archived' ? (
                    <span className="badge badge-neutral">archived</span>
                  ) : null}
                </div>
                <div className="sw-muted mono">
                  {`${member.profileId} · ${member.access} · ${member.isolation}`}
                </div>
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t(SW_ACTION_CLOSE)}
                title={t(SW_ACTION_CLOSE)}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {actionError !== undefined ? <Callout tone="err">{actionError}</Callout> : null}

            <div className="sw-drawer-actions-bar">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => ctx.openConversationDrawer(member.conversationId)}
              >
                <HelmIcon name="message-square" size={12} />
                <span>{t(SW_DRAWER_OPEN_CONV)}</span>
              </button>

              {isBusy && canMutateMember ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={actionPending !== null}
                  onClick={() => void handleAbort()}
                >
                  <HelmIcon
                    name={actionPending === 'abort' ? 'loader' : 'square'}
                    size={12}
                    className={actionPending === 'abort' ? 'spin-slow' : undefined}
                  />
                  <span>{actionPending === 'abort' ? t(SW_DRAWER_ABORTING) : t(SW_DRAWER_ABORT_TURN)}</span>
                </button>
              ) : null}

              {!isBusy && canMutateMember ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={actionPending !== null}
                  onClick={() => void handleArchive()}
                >
                  <HelmIcon
                    name={actionPending === 'archive' ? 'loader' : 'archive'}
                    size={12}
                    className={actionPending === 'archive' ? 'spin-slow' : undefined}
                  />
                  <span>{actionPending === 'archive' ? t(SW_DRAWER_ARCHIVING) : t(SW_DRAWER_ARCHIVE)}</span>
                </button>
              ) : null}
            </div>

            <KvGrid
              items={[
                { key: t(SW_DRAWER_KV_CONVERSATION), value: <span className="mono">#{member.conversationId}</span> },
                { key: t(SW_DRAWER_KV_PROFILE), value: <span className="mono">{member.profileId}</span> },
                { key: t(SW_DRAWER_KV_ACCESS), value: <span className="badge badge-neutral">{member.access}</span> },
                { key: t(SW_DRAWER_KV_ISOLATION), value: <span className="badge badge-neutral">{member.isolation}</span> },
                { key: t(SW_DRAWER_KV_ENV), value: <span className="mono">{`${member.nodeId}:${member.cwd}`}</span> },
                { key: t(SW_DRAWER_KV_CHANNELS), value: <span className="mono">{member.channels.map((c) => `#${c}`).join(', ')}</span> },
                {
                  key: t(SW_DRAWER_KV_CURSORS),
                  value: (
                    <span className="mono tabular-nums">
                      {`read=#${member.readCursorSeq} · pending=#${member.pendingWakeupSeq}${member.lastPostSeq !== undefined ? ` · post=#${member.lastPostSeq}` : ''}`}
                    </span>
                  ),
                },
              ]}
            />

            {canMutateMember ? (
              <div className="sw-drawer-section">
                <div className="screen-section-title">
                  <HelmIcon name="cpu" size={13} />
                  <span>{t(SW_DRAWER_MODEL_SECTION)}</span>
                </div>
                {isBusy ? (
                  <div className="sw-muted">{t(SW_DRAWER_MODEL_BUSY_HINT)}</div>
                ) : (
                  <div className="sw-model-switch-stack">
                    <Select
                      value={member.model ?? ''}
                      options={modelOptions}
                      inline={inline}
                      disabled={actionPending !== null}
                      aria-label={t(SW_DRAWER_MODEL_ARIA)}
                      popoverClassName="helm-select-popover-wide"
                      onChange={(e) => {
                        if (e.target.value !== '') {
                          void applyModelSwitch(e.target.value)
                        }
                      }}
                    />
                    <div className="sw-model-custom-row">
                      <input
                        type="text"
                        className="sw-input mono"
                        value={customModel}
                        disabled={actionPending !== null}
                        placeholder={t(SW_DRAWER_MODEL_CUSTOM_PLACEHOLDER)}
                        onChange={(e) => setCustomModel(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-xs"
                        disabled={actionPending !== null || customModel.trim() === ''}
                        onClick={() => void applyModelSwitch(customModel)}
                      >
                        {t(SW_DRAWER_MODEL_APPLY)}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {member.worktreeId !== undefined ? (
              <div className="sw-drawer-section">
                <div className="sw-field-header">
                  <div className="screen-section-title">
                    <HelmIcon name="git-branch" size={13} />
                    <span>{t(SW_WT_SECTION_TITLE)}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    disabled={wtLoading}
                    onClick={() => void loadWorktree(member.worktreeId!)}
                  >
                    <HelmIcon name="rotate-cw" size={11} className={wtLoading ? 'spin-slow' : undefined} />
                    <span>{t(SW_ACTION_REFRESH)}</span>
                  </button>
                </div>

                {wtLoading && wtSnapshot === undefined ? (
                  <div className="loading-state" role="status">
                    <HelmIcon name="loader" size={12} className="spin-slow" />
                    <span>{t(SW_WT_INSPECTING)}</span>
                  </div>
                ) : null}

                {wtError !== undefined ? (
                  <Callout tone="err">
                    <div className="sw-callout-row">
                      <span>{wtError}</span>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => void loadWorktree(member.worktreeId!)}
                      >
                        {t(SW_ACTION_RETRY)}
                      </button>
                    </div>
                  </Callout>
                ) : null}

                {wtSnapshot !== undefined ? (
                  <div className="sw-wt-snapshot-box">
                    <KvGrid
                      items={[
                        {
                          key: t(SW_WT_KV_BRANCH),
                          value: <span className="mono">{wtSnapshot.currentBranch ?? wtSnapshot.branch}</span>,
                        },
                        {
                          key: t(SW_WT_KV_BASE),
                          value: (
                            <span className="mono">
                              {wtSnapshot.baseCommit !== '' ? wtSnapshot.baseCommit.slice(0, 12) : '-'}
                            </span>
                          ),
                        },
                        ...(wtSnapshot.commitsAhead !== undefined
                          ? [{ key: t(SW_WT_KV_AHEAD), value: <span className="tabular-nums">{wtSnapshot.commitsAhead}</span> }]
                          : []),
                        {
                          key: t(SW_WT_KV_DIRTY),
                          value: <span className="tabular-nums">{wtSnapshot.dirtyFileCount}</span>,
                        },
                      ]}
                    />

                    {wtSnapshot.dirtyFiles.length > 0 ? (
                      <pre className="code-block-pre sw-code-preview">
                        <code>{wtSnapshot.dirtyFiles.join('\n')}</code>
                      </pre>
                    ) : wtSnapshot.exists ? (
                      <div className="sw-muted">{t(SW_WT_CLEAN)}</div>
                    ) : null}

                    {wtSnapshot.diffStat !== undefined && wtSnapshot.diffStat !== '' ? (
                      <pre className="code-block-pre sw-code-preview">
                        <code>{wtSnapshot.diffStat}</code>
                      </pre>
                    ) : null}

                    {wtSnapshot.diffPreview !== undefined && wtSnapshot.diffPreview !== '' ? (
                      <div className="sw-wt-diff-wrap">
                        {wtSnapshot.diffTruncated ? (
                          <span className="badge badge-neutral">{t(SW_WT_DIFF_TRUNCATED)}</span>
                        ) : null}
                        <pre className="code-block-pre sw-code-preview selectable">
                          <code>{wtSnapshot.diffPreview}</code>
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="sw-wt-merge-actions">
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    disabled={actionPending !== null || board.group.coordinatorDetached === true}
                    onClick={() => void handleRequestMerge()}
                  >
                    <HelmIcon name="git-pull-request" size={11} />
                    <span>{t(SW_REQUEST_MERGE_BTN)}</span>
                  </button>
                  {mergeRequestText !== '' ? (
                    <CopyButton text={mergeRequestText} label={t(SW_COPY_PROMPT)} />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
