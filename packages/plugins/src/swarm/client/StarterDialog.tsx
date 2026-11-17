/**
 * Starter preset dialog & conversation:header ('menu' placement) entry for
 * creating a Swarm collaboration group on a top-level human conversation.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import {
  Callout,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmIcon,
  Switch,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  buildBoardScreenTarget,
  canStartSwarmGroup,
  isNarrowViewport,
  parseBoardBadges,
  parseCreateGroupId,
  type BoardBadgesDoc,
  type StarterPresetId,
} from './board-model.ts'
import {
  SW_ACTION_CANCEL,
  SW_ACTION_CLOSE,
  SW_COPY_PROMPT,
  SW_CREATE_OPEN_BOARD,
  SW_CREATING_GROUP,
  SW_GROUP_OBJECTIVE_LABEL,
  SW_GROUP_OBJECTIVE_PLACEHOLDER,
  SW_GROUP_TITLE_LABEL,
  SW_GROUP_TITLE_PLACEHOLDER,
  SW_GROUP_TITLE_REQUIRED,
  SW_GUARD_HINT,
  SW_GUARD_LABEL,
  SW_PRESET_AUTHOR_VERIFIER,
  SW_PRESET_AUTHOR_VERIFIER_DESC,
  SW_PRESET_BLANK,
  SW_PRESET_BLANK_DESC,
  SW_PRESET_LABEL,
  SW_PRESET_SQUAD,
  SW_PRESET_SQUAD_DESC,
  SW_START_GROUP_BUTTON,
  SW_START_GROUP_DESC,
  SW_STARTER_PROMPT_LABEL,
  swPresetDefaultDraft,
  swPresetDefaultTitle,
} from './copy.ts'

export interface SwarmGroupStarterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetConversation: ConversationSummary | undefined
  inline?: boolean
  onCreated?: (groupId: string | undefined) => void
}

export function SwarmGroupStarterDialog({
  open,
  onOpenChange,
  targetConversation,
  inline,
  onCreated,
}: SwarmGroupStarterDialogProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()

  const [preset, setPreset] = useState<StarterPresetId>('author-verifier')
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [coordinatorGuard, setCoordinatorGuard] = useState(true)
  const [starterDraft, setStarterDraft] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [draftTouched, setDraftTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    const initialPreset: StarterPresetId = 'author-verifier'
    setPreset(initialPreset)
    setTitle(swPresetDefaultTitle(initialPreset, targetConversation?.title ?? '', locale))
    setObjective('')
    setCoordinatorGuard(true)
    setStarterDraft(swPresetDefaultDraft(initialPreset, locale))
    setTitleTouched(false)
    setDraftTouched(false)
    setError(undefined)
  }, [open, targetConversation?.id, targetConversation?.title, locale])

  const selectPreset = (next: StarterPresetId): void => {
    setPreset(next)
    if (!titleTouched) {
      setTitle(swPresetDefaultTitle(next, targetConversation?.title ?? '', locale))
    }
    if (!draftTouched) {
      setStarterDraft(swPresetDefaultDraft(next, locale))
    }
  }

  const handleSubmit = async (): Promise<void> => {
    if (pending) return
    const trimmedTitle = title.trim()
    if (trimmedTitle === '') {
      setError(t(SW_GROUP_TITLE_REQUIRED))
      return
    }
    const conversationId = targetConversation?.id ?? ctx.conversationId
    setPending(true)
    setError(undefined)
    try {
      const payload: Record<string, unknown> = {
        title: trimmedTitle,
        coordinatorGuard,
        ...(objective.trim() !== '' ? { objective: objective.trim() } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
      }
      const res = await ctx.callAction(
        'create_group',
        payload,
        conversationId !== undefined ? { conversationId } : undefined,
      )
      const groupId = parseCreateGroupId(res)
      const draft = starterDraft.trim()
      if (draft !== '' && ctx.composer !== undefined && ctx.composer.draft.trim() === '') {
        ctx.composer.setDraft(draft)
      }
      const target = buildBoardScreenTarget({ groupId })
      const width = typeof window !== 'undefined' ? window.innerWidth : undefined
      if (isNarrowViewport(width)) {
        ctx.openScreen(target)
      } else {
        ctx.openSplitScreen(target)
      }
      onOpenChange(false)
      onCreated?.(groupId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const presets: ReadonlyArray<{ id: StarterPresetId; icon: string; title: string; desc: string }> = useMemo(
    () => [
      {
        id: 'author-verifier',
        icon: 'git-pull-request',
        title: t(SW_PRESET_AUTHOR_VERIFIER),
        desc: t(SW_PRESET_AUTHOR_VERIFIER_DESC),
      },
      {
        id: 'squad',
        icon: 'boxes',
        title: t(SW_PRESET_SQUAD),
        desc: t(SW_PRESET_SQUAD_DESC),
      },
      {
        id: 'blank',
        icon: 'layout-grid',
        title: t(SW_PRESET_BLANK),
        desc: t(SW_PRESET_BLANK_DESC),
      },
    ],
    [t],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange} inline={inline}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop" />
        <DialogContent
          className="modal sw-starter-modal"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sw-starter-header">
            <div className="sw-starter-heading">
              <DialogTitle className="modal-title">{t(SW_START_GROUP_BUTTON)}</DialogTitle>
              <DialogDescription className="sw-muted">
                {t(SW_START_GROUP_DESC)}
              </DialogDescription>
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

          <div className="sw-starter-body">
            {error !== undefined ? <Callout tone="err">{error}</Callout> : null}

            <div className="sw-field">
              <span className="form-grid-label">{t(SW_PRESET_LABEL)}</span>
              <div className="sw-preset-grid" role="radiogroup" aria-label={t(SW_PRESET_LABEL)}>
                {presets.map((item) => {
                  const selected = preset === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-preset={item.id}
                      className={`sw-preset-card${selected ? ' is-selected' : ''}`}
                      disabled={pending}
                      onClick={() => selectPreset(item.id)}
                    >
                      <div className="sw-preset-card-top">
                        <HelmIcon name={item.icon} size={13} />
                        <span className="sw-preset-card-title">{item.title}</span>
                      </div>
                      <span className="sw-preset-card-desc">{item.desc}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="sw-field">
              <label className="form-grid-label" htmlFor="sw-group-title-input">
                {t(SW_GROUP_TITLE_LABEL)}
              </label>
              <input
                id="sw-group-title-input"
                type="text"
                className="sw-input"
                value={title}
                disabled={pending}
                placeholder={t(SW_GROUP_TITLE_PLACEHOLDER)}
                onChange={(e) => {
                  setTitleTouched(true)
                  setTitle(e.target.value)
                }}
              />
            </div>

            <div className="sw-field">
              <label className="form-grid-label" htmlFor="sw-group-objective-input">
                {t(SW_GROUP_OBJECTIVE_LABEL)}
              </label>
              <input
                id="sw-group-objective-input"
                type="text"
                className="sw-input"
                value={objective}
                disabled={pending}
                placeholder={t(SW_GROUP_OBJECTIVE_PLACEHOLDER)}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>

            <div className="sw-guard-row">
              <div className="sw-guard-text">
                <Switch
                  checked={coordinatorGuard}
                  onChange={setCoordinatorGuard}
                  disabled={pending}
                  label={t(SW_GUARD_LABEL)}
                />
                <span className="sw-muted">{t(SW_GUARD_HINT)}</span>
              </div>
            </div>

            <div className="sw-field">
              <div className="sw-field-header">
                <label className="form-grid-label" htmlFor="sw-starter-draft-input">
                  {t(SW_STARTER_PROMPT_LABEL)}
                </label>
                {starterDraft.trim() !== '' ? (
                  <CopyButton text={starterDraft} label={t(SW_COPY_PROMPT)} />
                ) : null}
              </div>
              <textarea
                id="sw-starter-draft-input"
                className="sw-textarea sw-textarea-compact"
                rows={3}
                value={starterDraft}
                disabled={pending}
                onChange={(e) => {
                  setDraftTouched(true)
                  setStarterDraft(e.target.value)
                }}
              />
            </div>
          </div>

          <div className="sw-starter-footer">
            <DialogClose asChild>
              <button type="button" className="btn btn-sm btn-ghost" disabled={pending}>
                {t(SW_ACTION_CANCEL)}
              </button>
            </DialogClose>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={pending}
              onClick={() => void handleSubmit()}
            >
              <HelmIcon name={pending ? 'loader' : 'workflow'} size={12} className={pending ? 'spin-slow' : undefined} />
              <span>{pending ? t(SW_CREATING_GROUP) : t(SW_CREATE_OPEN_BOARD)}</span>
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

export interface SwarmStartGroupActionProps {
  conversation?: ConversationSummary
}

/**
 * conversation:header ('menu' placement) action rendered for top-level human
 * conversations without 'swarm-coordinator' / 'swarm-worker' tags.
 */
export function SwarmStartGroupAction(props: SwarmStartGroupActionProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const rawBadges = usePluginDoc<BoardBadgesDoc>('board-badges')
  const badges = useMemo(() => parseBoardBadges(rawBadges), [rawBadges])
  const [open, setOpen] = useState(false)

  const conversation = useMemo(
    () => props.conversation ?? conversations.find((c) => c.id === ctx.conversationId),
    [props.conversation, conversations, ctx.conversationId],
  )

  if (!canStartSwarmGroup(conversation, index, badges)) {
    return null
  }

  return (
    <>
      <button
        type="button"
        className="popover-item"
        title={t(SW_START_GROUP_BUTTON)}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <span className="pane-more-item-label">
          <HelmIcon name="workflow" size={13} />
          <span>{t(SW_START_GROUP_BUTTON)}</span>
        </span>
      </button>
      <SwarmGroupStarterDialog
        open={open}
        onOpenChange={setOpen}
        targetConversation={conversation}
      />
    </>
  )
}
