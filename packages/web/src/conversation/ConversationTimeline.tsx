import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AskSpec,
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ProfileStarterPrompt,
} from '@helm/protocol/browser'
import { artifactsApi } from '../lib/api.js'
import { HelmIcon, CopyButton } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { AssistantTurnView, AssistantModelBoundary } from './AssistantTurn.js'
import {
  buildActiveEntryIndex,
  buildAssistantModelBoundaries,
  buildTimelineItems,
  collectSiblingCalls,
  findLatestProcessTurnKey,
  lastEditableHumanInput,
  queuedAgentTextCollapse,
  resolveAssistantAnchorEntry,
  type DividerItem,
  type EditRequestTarget,
  type HumanInputItem,
  type PluginCardItem,
  type ProcessShortcutCommand,
  type TimelineItem,
} from './timeline-model.js'
import { useTimelineEntryActions } from './timeline-actions.js'
import { resolveActiveOutlineEntryId } from './outline-model.js'
import { calibrateAnchorAfterSmoothScroll, calibrateInitialStickToBottom, type AnchorAlignment } from './timeline-scroll-calibration.js'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor, type TimelineScrollAnchor } from './timeline-scroll-anchor.js'
import {
  OUTLINE_ACTIVE_LINE_PX,
  resolveActiveAnchorIndex,
  resolveCharsPerLine,
  resolveContainmentClass,
  supportsTimelineContainment,
  timelineAnchorId,
  type ContainmentExclusions,
} from './timeline-containment-model.js'
import { matchTimelineEntryActions, timelineEntryActionContextOf } from './action-model.js'
import { LazyMount } from '../ui/LazyMount.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import { Tooltip } from '../ui/Tooltip.js'
import { formatBytes, formatDurationMs, formatFullTimestamp, formatMessageTime } from '../lib/format.js'

export interface OutlineScrollRequest {
  entryId: string
  headingIndex?: number
  /** In-turn business-card secondary anchor: matches the `data-outline-card-id` (i.e. tool.key) of an AssistantTurn top-level tool.view card. */
  cardId?: string
  tick: number
}

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  /** Precomputed normalized timeline list from the parent (avoids double computation in ConversationPane and Timeline). */
  timelineItems?: ReadonlyArray<TimelineItem>
  /** Send request in flight while the server is not yet working/blocked (light waiting row, mutually exclusive with the working row). */
  sendingPending?: boolean
  /** Scroll-locate request triggered by outline click/Enter (tick increments each time so the same entry can be re-targeted). */
  outlineScrollRequest?: OutlineScrollRequest | null
  /** Notifies the parent of the current viewport-top focus entryId while scrolling (feeds outline highlight). */
  onActiveEntryChange?: (entryId: string | undefined) => void
  /** Request to prefill and focus the Composer (edit and resend; may carry a history entryId and attachments). */
  onRequestEdit: (target: EditRequestTarget) => void
  /** Starter click on an empty conversation: prefill the draft only, not a history edit. */
  onRequestStarter?: (text: string) => void
  /** Starter list of the conversation's profile (empty/undefined renders no buttons). */
  starters?: ProfileStarterPrompt[]
}

// ---------------------------------------------------------------------------
// Attachment rendering (image thumbnails + non-image chips)
// ---------------------------------------------------------------------------

function AttachmentImage({ att, conversationId }: { att: ConversationAttachmentRef; conversationId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const store = useHelmStore()
  const { t } = useWebLocale()

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void artifactsApi
      .fetchBlob(att.id)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      active = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id])

  if (failed !== null) {
    return (
      <span className="attachment-chip" title={t('conv.attachment.imageFailed', { reason: failed ?? '' })}>
        <HelmIcon name="alert-triangle" size={11} />
        {att.name}
      </span>
    )
  }
  if (url === null) {
    return (
      <span className="attachment-chip">
        <HelmIcon name="loader" size={11} />
        {att.name}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="attachment-image-thumb"
      title={t('conv.attachment.clickToEnlarge', { name: att.name })}
      onClick={() =>
        store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
      }
    >
      <img src={url} alt={att.name} loading="lazy" />
    </button>
  )
}

function AttachmentChips({
  attachments,
  conversationId,
}: {
  attachments: ConversationAttachmentRef[]
  conversationId: number
}) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  return (
    <span className="msg-attachments-wrap">
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') ? (
          <LazyMount
            key={att.id}
            inline
            fallback={
              <span className="attachment-chip">
                <HelmIcon name="file-text" size={11} />
                {att.name}
              </span>
            }
          >
            <AttachmentImage att={att} conversationId={conversationId} />
          </LazyMount>
        ) : (
          <button
            key={att.id}
            type="button"
            className="attachment-chip"
            title={t('conv.attachment.previewName', { name: att.name })}
            onClick={() =>
              store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
            }
          >
            <HelmIcon name="file-text" size={11} />
            <span>{att.name}</span>
            <span className="mono tabular-nums">{formatBytes(att.size)}</span>
          </button>
        ),
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Human message pill
// ---------------------------------------------------------------------------

/** Non-human input origin badge (agent report / trigger injection); unknown origins show the raw identifier. */
function originLabel(origin: string, t: WebMessageTranslator): string {
  if (origin === 'agent') return t('conv.origin.agentReport')
  if (origin === 'trigger') return t('conv.origin.trigger')
  return origin
}

const QUEUED_MODE_ICON: Record<'steer' | 'followUp', string> = {
  steer: 'corner-down-right',
  followUp: 'clock',
}

function queuedModeText(mode: 'steer' | 'followUp', t: WebMessageTranslator): string {
  return mode === 'steer' ? t('conv.queued.steer') : t('conv.queued.followUp')
}

function HumanMessage({
  item,
  conversation,
  anchorEntry,
  onRequestEdit,
  onForkFromHere,
  onWithdrawQueuedEdit,
}: {
  item: HumanInputItem
  conversation: ConversationSummary
  /** Real persisted entry for item.entryId; undefined while queued (no persistent anchor). */
  anchorEntry?: ConversationEntry
  onRequestEdit: (target: EditRequestTarget) => void
  /** Fork a new conversation from this message (action service instantiated once by ConversationTimeline). */
  onForkFromHere: (entryId: string) => Promise<void>
  /** Withdraw the queued input and switch to editing (withdrawn -> prefill the text; persisted -> edit in place). */
  onWithdrawQueuedEdit: (subId: string, target: EditRequestTarget) => Promise<void>
}) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const [forking, setForking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  // Plugin micro-slot timeline.entry.action: filtered by conversation scope + the real entry's kind/role;
  // not rendered while queued (no persistent anchor) or when the id is outside the loaded detail set (paged window) — never fabricate a placeholder entry.
  const entryActions =
    anchorEntry !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.uiActions,
          conversation,
          timelineEntryActionContextOf(anchorEntry),
        )
      : []

  const humanTime = formatMessageTime(item.createdAt)
  const humanFullTime = formatFullTimestamp(item.createdAt)
  const hasHumanTime = item.createdAt !== undefined && humanTime !== ''

  // Queued non-human long text (e.g. raw background report): generic expand/collapse, no business payload parsing.
  const [longOpen, setLongOpen] = useState(false)
  const queuedCollapse =
    item.queuedMode !== undefined && item.origin !== 'human'
      ? queuedAgentTextCollapse(item.text)
      : undefined
  const collapseBodyId = useId()

  const editRequest = async (): Promise<void> => {
    // Only human inputs are editable in place: agent reports / trigger injections are not (pencil hidden, double defense)
    if (item.origin !== 'human') return
    const attachments =
      item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}
    if (item.queuedMode === undefined) {
      // Persisted history message: edit in place; entryId must be a valid positive integer —
      // an invalid anchor never silently degrades into a new message (an "edit" must not be mis-sent as an append).
      const numericId = Number(item.entryId)
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: t('conv.human.cannotEditTitle'),
          body: t('conv.human.cannotEditBody', { entryId: item.entryId }),
          conversationId: conversation.id,
        })
        return
      }
      onRequestEdit({ text: item.text, entryId: numericId, ...attachments })
      return
    }
    // Queued message: withdraw first (seamlessly continue into a history edit if it just entered execution)
    const subId = item.entryId.startsWith('queued:') ? item.entryId.slice('queued:'.length) : item.entryId
    setWithdrawing(true)
    try {
      await onWithdrawQueuedEdit(subId, { text: item.text, ...attachments })
    } finally {
      setWithdrawing(false)
    }
  }

  const forkFromHere = async (): Promise<void> => {
    setForking(true)
    try {
      await onForkFromHere(item.entryId)
    } finally {
      setForking(false)
    }
  }

  return (
    <div className={`msg-human-row${item.origin !== 'human' ? ' msg-human-row-external' : ''}`} tabIndex={0}>
      {item.queuedMode !== undefined ? (
        <span className="msg-origin-tag" role="status">
          <HelmIcon name={QUEUED_MODE_ICON[item.queuedMode]} size={11} />
          {queuedModeText(item.queuedMode, t)}
        </span>
      ) : item.origin !== 'human' ? (
        <span className="msg-origin-tag">
          <HelmIcon name={item.origin === 'trigger' ? 'webhook' : 'bot'} size={11} />
          {originLabel(item.origin, t)}
        </span>
      ) : null}
      <div className={`msg-human-pill selectable${item.queuedMode !== undefined ? ' msg-human-pill-queued' : ''}${queuedCollapse?.collapsed === true ? ' msg-human-pill-collapsible' : ''}`}>
        <span
          id={collapseBodyId}
          className={queuedCollapse?.collapsed === true && !longOpen ? 'msg-human-collapsed-text' : undefined}
        >
          {queuedCollapse?.collapsed === true && !longOpen ? queuedCollapse.preview : item.text}
        </span>
        {queuedCollapse?.collapsed === true ? (
          <button
            type="button"
            className="msg-human-collapse-btn"
            aria-expanded={longOpen}
            aria-controls={collapseBodyId}
            onClick={() => setLongOpen((current) => !current)}
          >
            <HelmIcon name={longOpen ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{longOpen ? t('common.collapse') : t('conv.human.expandFullText', { count: item.text.length })}</span>
          </button>
        ) : null}
      </div>
      {item.attachments !== undefined && item.attachments.length > 0 ? (
        <AttachmentChips attachments={item.attachments} conversationId={conversation.id} />
      ) : null}
      <div className="msg-human-footer">
        <span className="msg-hover-bar">
          {anchorEntry !== undefined
            ? entryActions.map((action) => (
                <PluginMicroAction
                  key={`entry:${action.pluginId}/${action.spec.id}`}
                  action={action}
                  variant="hover"
                  conversationId={conversation.id}
                  entryId={anchorEntry.id}
                  slotProps={{ conversationId: conversation.id, entry: anchorEntry }}
                />
              ))
            : null}
          <CopyButton text={item.text} />
          {item.origin === 'human' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={item.queuedMode !== undefined ? t('conv.human.withdrawQueueAndEdit') : t('conv.human.editAndResend')}
              aria-label={item.queuedMode !== undefined ? t('conv.human.withdrawQueueAndEdit') : t('conv.human.editAndResend')}
              disabled={withdrawing}
              onClick={() => void editRequest()}
            >
              <HelmIcon name={withdrawing ? 'loader' : 'edit'} size={12} className={withdrawing ? 'spin-slow' : undefined} />
            </button>
          ) : null}
          {item.queuedMode === undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={t('conv.human.forkFromMessage')}
              disabled={forking}
              onClick={() => void forkFromHere()}
            >
              <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
            </button>
          ) : null}
        </span>
        {hasHumanTime ? (
          <Tooltip content={t('conv.human.sentAt', { time: humanFullTime })}>
            <span className="msg-time-meta" title={t('conv.human.sentAt', { time: humanFullTime })}>{humanTime}</span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool rows / thinking groups / assistant turns live in TimelineRows.tsx and AssistantTurn.tsx
// (row-level render units split out of ConversationTimeline).
// ---------------------------------------------------------------------------

/** Escape a CSS attribute selector value (double quotes and backslashes); used by outline secondary-anchor queries. */
function escapeAttrSelectorValue(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

// ---------------------------------------------------------------------------
// Dividers / plugin cards / resolved asks
// ---------------------------------------------------------------------------

function ContextDivider({ item }: { item: DividerItem }) {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  // Expandable text: the reset handoff summary or the compaction summary (same expand interaction).
  const expandable = item.divider === 'reset' ? item.handoff : item.summary
  const expandLabel = item.divider === 'reset' ? t('conv.divider.handoffSummary') : t('conv.divider.compactionSummary')
  return (
    <div className="context-divider-wrap">
      <div className="context-divider">
        <span className="context-divider-label">
          {item.pending === true ? (
            <>
              <HelmIcon name="loader" size={11} className="spin-slow" />
              {t('conv.divider.compacting')}
            </>
          ) : (
            <>
              <HelmIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
              {item.divider === 'reset' ? t('conv.divider.reset') : t('conv.divider.compacted')}
            </>
          )}
        </span>
      </div>
      {expandable !== undefined ? (
        <button
          type="button"
          className="trace-group-summary context-divider-expand-btn"
          onClick={() => setOpen((v) => !v)}
        >
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? t('conv.divider.collapse', { label: expandLabel }) : t('conv.divider.expand', { label: expandLabel })}
        </button>
      ) : null}
      {open && expandable !== undefined ? (
        <div className="trace-expanded-body selectable trace-expanded-body-flush">
          <div className="trace-section-label">{expandLabel}</div>
          <pre className="code-block-pre code-block-pre-flush">
            <code>{expandable}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function PluginCard({ item, conversationId }: { item: PluginCardItem; conversationId: number }) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const conversation = store.conversations.find((c) => c.id === conversationId)
  // timeline.renderer custom entries also consume timeline.entry.action: matched by the real entry kind;
  // custom kinds have no user/assistant role, so actions declaring roles never match.
  const entryActions =
    conversation !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.uiActions,
          conversation,
          timelineEntryActionContextOf(item.entry),
        )
      : []
  return (
    <div className="plugin-card">
      <PluginUiView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec}
        conversationId={conversationId}
        label={t('conv.timeline.cardsLabel')}
        slotProps={{ entry: item.entry, conversationId }}
      />
      {entryActions.length > 0 ? (
        <span className="plugin-card-hover-bar">
          {entryActions.map((action) => (
            <PluginMicroAction
              key={`entry:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="hover"
              conversationId={conversationId}
              entryId={item.entry.id}
              slotProps={{ conversationId, entry: item.entry }}
            />
          ))}
        </span>
      ) : null}
    </div>
  )
}

/** Resolved-ask row status badge; unknown statuses show the raw server identifier. */
function resolvedAskLabel(status: string, t: WebMessageTranslator): string {
  if (status === 'answered') return t('conv.ask.approved')
  if (status === 'cancelled') return t('conv.ask.cancelled')
  if (status === 'superseded') return t('conv.ask.superseded')
  return status
}

function ResolvedAskRow({ ask, status }: { ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }) {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-entry">
      <div className="trace-row" role="button" tabIndex={0} onClick={() => setOpen((v) => !v)}>
        <span className="trace-row-left">
          <HelmIcon name="check-circle" size={12} />
          <span className="trace-tool-name">{t('conv.ask.rowTitle')}</span>
          <span className="trace-tool-summary">{ask.title}</span>
        </span>
        <span className="trace-row-right">{resolvedAskLabel(status, t)}</span>
      </div>
      {open ? (
        <div className="trace-expanded-body selectable">
          {ask.description !== undefined ? <span>{ask.description}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Highlight location
// ---------------------------------------------------------------------------

function useEntryHighlight(
  conversationId: number,
  localHighlightedEntryId: string | null,
): (entryId: string) => string {
  const store = useHelmStore()
  return (entryId: string): string => {
    const h = store.highlightedEntry
    const matchedStore = h !== null && h.conversationId === conversationId && h.entryId === entryId
    const matchedLocal = localHighlightedEntryId === entryId
    return matchedStore || matchedLocal ? ' entry-highlighted' : ''
  }
}

function useHighlightScroll(
  conversationId: number,
  armCalibration: (target: HTMLElement, alignment: AnchorAlignment) => void,
): (node: HTMLDivElement | null) => void {
  const store = useHelmStore()
  const h = store.highlightedEntry
  // A stable ref avoids re-locating on ordinary rerenders; when StrictMode remounts the ref the
  // calibration must re-arm because the first mount's task was already cancelled by effect cleanup.
  return useCallback((node: HTMLDivElement | null): void => {
    if (node === null || h?.conversationId !== conversationId) return
    if (node.dataset.entryId !== h.entryId) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    armCalibration(node, 'center')
  }, [conversationId, h?.conversationId, h?.entryId, armCalibration])
}

// ---------------------------------------------------------------------------
// Turn failure diagnostics (inline display of the uncleared current failure; disappears when the next turn starts)
// ---------------------------------------------------------------------------

/** Inline diagnostics block for a failed turn: content comes from ConversationSummary.lastError (the same
 * authoritative state source); no new persisted timeline item — when lastError is empty show a clear generic message, never fabricated details. */
function TurnErrorNotice({
  conversation,
  detailEntries,
  onRequestEdit,
}: {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  onRequestEdit: (target: EditRequestTarget) => void
}) {
  // Latest editable human input: reuse the same safe resolution as Composer ↑ (validates entryId,
  // never crosses a reset boundary, reuses existing attachments); without a reliable anchor there is
  // no quick action — never risk editing the wrong old message.
  const { t } = useWebLocale()
  const editTarget = useMemo(() => lastEditableHumanInput(detailEntries), [detailEntries])
  return (
    <div className="callout callout--error" role="alert" aria-label={t('conv.turnFailed.label')}>
      <HelmIcon name="alert-triangle" size={12} />
      <span className="callout-text">
        {t('conv.turnFailed.prefix')}{conversation.lastError?.trim() || t('conv.turnFailed.fallback')}
        {editTarget !== undefined ? (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={t('conv.turnFailed.editLatest')}
              aria-label={t('conv.turnFailed.editLatest')}
              onClick={() => onRequestEdit(editTarget)}
            >
              <HelmIcon name="edit" size={12} />
              {t('conv.human.editAndResend')}
            </button>
          </>
        ) : null}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main timeline
// ---------------------------------------------------------------------------

/** Show the "back to bottom" floating button after scrolling up past this threshold (px). */
const SCROLL_TO_BOTTOM_THRESHOLD_PX = 240

export function ConversationTimeline({
  conversation,
  detailEntries,
  live,
  timelineItems,
  sendingPending = false,
  outlineScrollRequest,
  onActiveEntryChange,
  onRequestEdit,
  onRequestStarter,
  starters,
}: ConversationTimelineProps) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  // Row action service (fork / withdraw-queued-then-edit) instantiated once; row components consume it via props.
  const entryActions = useTimelineEntryActions(conversation, onRequestEdit)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [localHighlightEntryId, setLocalHighlightEntryId] = useState<string | null>(null)
  const [processToggle, setProcessToggle] = useState<{ turnKey: string; command: ProcessShortcutCommand } | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasUnreadScrollUpdates, setHasUnreadScrollUpdates] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const processToggleSeqRef = useRef(0)
  const latestProcessTurnKeyRef = useRef<string | undefined>(undefined)
  const stickToBottomRef = useRef(true)
  const programmaticBottomScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const prevFingerprintRef = useRef<{ conversationId: number; value: string } | null>(null)
  const lastHumanRef = useRef<{ conversationId: number; key: string | undefined } | null>(null)
  const lastOutlineTickRef = useRef<number | null>(null)
  const lastActiveEntryRef = useRef<string | undefined>(undefined)
  const outlineHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeCalibrationRef = useRef<{
    conversationId: number
    kind: 'anchor' | 'initial-bottom'
    cancel: () => void
  } | null>(null)
  const prevConvIdRef = useRef(conversation.id)
  const prevDetailEntriesRef = useRef(detailEntries)
  const swrAnchorRef = useRef<{ entries: ReadonlyArray<ConversationEntry>; anchor: TimelineScrollAnchor } | null>(null)
  const [charsPerLine, setCharsPerLine] = useState<number>(() =>
    resolveCharsPerLine(typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : undefined),
  )
  // One-shot initial bottom-stick eligibility: consumed = already superseded by user input, natural
  // settling, or an explicit locate; it never restarts within the conversation. Conversation switch or
  // StrictMode replay cleanups only cancel (active=false) without consuming, so remounts can restart and replays cannot exhaust the one-shot.
  const initialBottomRef = useRef<{ active: boolean; consumed: boolean }>({ active: false, consumed: false })

  const syncScrollBottomVisibility = useCallback((el: HTMLElement): void => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom <= SCROLL_TO_BOTTOM_THRESHOLD_PX) {
      programmaticBottomScrollRef.current = false
    }
    if (distanceFromBottom <= 32) {
      setHasUnreadScrollUpdates(false)
    }
    const visible =
      !initialBottomRef.current.active &&
      !programmaticBottomScrollRef.current &&
      distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD_PX
    setShowScrollBottom((prev) => (prev === visible ? prev : visible))
  }, [])

  const stopFollowingBottom = useCallback((): void => {
    stickToBottomRef.current = false
    programmaticBottomScrollRef.current = false
    initialBottomRef.current.consumed = true
    if (activeCalibrationRef.current?.kind === 'initial-bottom') activeCalibrationRef.current.cancel()
  }, [])

  const scrollToBottomAndFollow = useCallback((): void => {
    activeCalibrationRef.current?.cancel()
    activeCalibrationRef.current = null
    initialBottomRef.current.active = false
    initialBottomRef.current.consumed = true
    stickToBottomRef.current = true
    programmaticBottomScrollRef.current = true
    setShowScrollBottom(false)
    setHasUnreadScrollUpdates(false)
    const el = scrollRef.current
    if (el === null) return
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_TO_BOTTOM_THRESHOLD_PX) {
      programmaticBottomScrollRef.current = false
    }
    lastScrollTopRef.current = el.scrollTop
  }, [])

  // Start the final anchor calibration and take over in-flight tasks (new locate/search highlight are mutually exclusive; the old one cancels immediately).
  // Row refs may mount before the parent scrollRef during commit (children first); locate the
  // scroll container by walking up from the target itself instead of relying on ref mount order.
  const armScrollCalibration = useCallback(
    (target: HTMLElement, alignment: AnchorAlignment): void => {
      const scroller = target.closest<HTMLElement>('.timeline-scroll')
      if (scroller === null) return
      stopFollowingBottom()
      activeCalibrationRef.current?.cancel()
      activeCalibrationRef.current = {
        conversationId: conversation.id,
        kind: 'anchor',
        cancel: calibrateAnchorAfterSmoothScroll({ scroller, target, alignment }),
      }
    },
    [conversation.id, stopFollowingBottom],
  )

  const highlightScrollRef = useHighlightScroll(conversation.id, armScrollCalibration)
  const highlightClass = useEntryHighlight(conversation.id, localHighlightEntryId)

  // Conversation switch/unmount: invalidate only the in-flight calibrations owned by the old
  // conversation (ref callbacks run before this effect on mount/switch, so the new conversation's
  // fresh calibration must survive this cleanup/setup) plus the highlight clear timers (the same
  // component instance reuses the scroll container); switching conversations resets bottom-stick state.
  // The initial bottom-stick window likewise only cancels without consuming: it can restart
  // after StrictMode's cleanup-to-setup replay.
  useEffect(() => {
    stickToBottomRef.current = true
    programmaticBottomScrollRef.current = false
    lastScrollTopRef.current = 0
    prevFingerprintRef.current = null
    // Reset the outline tick consumption log: after a conversation switch or StrictMode remount, a
    // still-effective locate request must re-run (otherwise the reset initial bottom-stick would steal the destination).
    lastOutlineTickRef.current = null
    initialBottomRef.current.active = false
    initialBottomRef.current.consumed = false
    setProcessToggle(null)
    setShowScrollBottom(false)
    setHasUnreadScrollUpdates(false)
    const ownedConversationId = conversation.id
    return () => {
      const active = activeCalibrationRef.current
      if (active !== null && active.conversationId === ownedConversationId) {
        active.cancel()
        activeCalibrationRef.current = null
      }
      if (outlineHighlightTimerRef.current !== null) {
        clearTimeout(outlineHighlightTimerRef.current)
        outlineHighlightTimerRef.current = null
      }
    }
  }, [conversation.id])

  // Start the one-shot initial bottom-stick calibration (see timeline-scroll-calibration.ts). Only when:
  // unconsumed, not in flight, and still bottom-stuck (the search/outline locate effect releases the
  // stick first — explicit locate wins) and the scroll container is ready; never revived by rerenders once the window is over.
  const beginInitialBottomCalibration = useCallback((): void => {
    const state = initialBottomRef.current
    if (state.consumed || state.active) return
    if (!stickToBottomRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    activeCalibrationRef.current?.cancel()
    state.active = true
    const cancel = calibrateInitialStickToBottom({
      scroller,
      onEnd: (reason) => {
        state.active = false
        if (reason !== 'cancelled') state.consumed = true
        if (reason === 'user-input') stickToBottomRef.current = false
        const active = activeCalibrationRef.current
        if (active !== null && active.cancel === cancel) activeCalibrationRef.current = null
      },
    })
    activeCalibrationRef.current = { conversationId: conversation.id, kind: 'initial-bottom', cancel }
  }, [conversation.id])

  const isWorking = conversation.status === 'working'
  const isCompacting = conversation.contextUsage?.compacting === true
  const items = useMemo(
    () =>
      timelineItems ??
      buildTimelineItems(detailEntries, {
        ...(live !== undefined ? { live } : {}),
        working: isWorking,
        compacting: isCompacting,
        timelineRenderers: store.groupedUi.timelineRenderers,
        toolViews: store.groupedUi.toolViews,
      }),
    [timelineItems, detailEntries, live, isWorking, isCompacting, store.groupedUi.timelineRenderers, store.groupedUi.toolViews],
  )

  // timeline.entry.action anchor index: from the detailEntries prop (already rewind-filtered,
  // same view as the renderer) locate real ConversationEntry objects.
  const activeEntriesById = useMemo(() => buildActiveEntryIndex(detailEntries), [detailEntries])

  const hasLiveTurn = items.some((item) => item.kind === 'assistant' && item.live)
  const resolvedAsks = store.resolvedAsksByConv[conversation.id] ?? []

  // Lightweight summaries of all tool calls: collected once, passed through to every tool.view
  // plugin component (siblingCalls let them compute same-target dedupe / resume continuation themselves).
  const siblingCalls = useMemo(() => collectSiblingCalls(items), [items])

  // Effective-model boundary index (one pure scan): each assistant turn with a model switch gets
  // its new model identity indexed by key; the renderer only looks the table up.
  const modelBoundaries = useMemo(() => buildAssistantModelBoundaries(items), [items])

  const lastAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'assistant') return items[i]!.key
    }
    return undefined
  }, [items])

  const latestProcessTurnKey = useMemo(() => findLatestProcessTurnKey(items), [items])
  latestProcessTurnKeyRef.current = latestProcessTurnKey

  // Ctrl+O global shortcut dispatch: toggles the fold state of the latest assistant turn with process
  // steps per pane (primary/split); direction comes from the live DOM aria-expanded so it never fights manual clicks.
  useEffect(() => {
    const onShortcut = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as unknown
      if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return
      const { action, panel } = detail as { action?: unknown; panel?: unknown }
      if (action !== 'toggle-process-groups' || (panel !== 'primary' && panel !== 'split')) return
      const root = rootRef.current
      if (root === null) return
      if (root.closest('.conversation-drawer') !== null) return
      const myPanel = root.closest('[data-helm-panel]')?.getAttribute('data-helm-panel') ?? 'primary'
      if (panel !== myPanel) return
      const targetTurnKey = latestProcessTurnKeyRef.current
      if (targetTurnKey === undefined) return
      const turnEl = innerRef.current?.querySelector<HTMLElement>('[data-latest-process-turn="true"]')
      const rootToggles = turnEl?.querySelectorAll<HTMLElement>('[data-process-toggle="root"]')
      const anyOpen =
        rootToggles !== undefined &&
        Array.from(rootToggles).some((el) => el.getAttribute('aria-expanded') === 'true')
      const nextSeq = ++processToggleSeqRef.current
      setProcessToggle({
        turnKey: targetTurnKey,
        command: { open: !anyOpen, seq: nextSeq },
      })
    }
    window.addEventListener('helm:shortcut', onShortcut)
    return () => window.removeEventListener('helm:shortcut', onShortcut)
  }, [])

  // Historical row render containment (content-visibility): enabled only when the browser supports
  // it; live streaming turns, queued inputs, the latest assistant turn, and highlight/outline
  // locate targets are released inside resolveContainmentClass so measurements and scrolling use the real layout.
  const containmentEnabled = useMemo(() => supportsTimelineContainment(), [])

  // Anchors that must be released: search highlight (store), outline flash highlight (local), and the current locate request target.
  const releasedEntryIds = useMemo(() => {
    const ids = new Set<string>()
    const h = store.highlightedEntry
    if (h !== null && h.conversationId === conversation.id && h.entryId !== '') ids.add(h.entryId)
    if (localHighlightEntryId !== null && localHighlightEntryId !== '') ids.add(localHighlightEntryId)
    const requested = outlineScrollRequest?.entryId
    if (requested !== undefined && requested !== '') ids.add(requested)
    return ids
  }, [store.highlightedEntry, conversation.id, localHighlightEntryId, outlineScrollRequest])

  const cvExclusions = useMemo<ContainmentExclusions>(
    () => ({ releasedEntryIds, latestAssistantKey: lastAssistantKey, charsPerLine }),
    [releasedEntryIds, lastAssistantKey, charsPerLine],
  )

  // Anchor-set signature: rebuild the reading-anchor observer only when the row set (anchor id
  // sequence) changes; streaming growth (new items reference, same anchors) does not rebind.
  const anchorSignature = useMemo(() => items.map((item) => timelineAnchorId(item)).join('\n'), [items])
  // The observer reads only the latest committed callback; parent re-closures never rebind it.
  const notifyActiveEntryChange = useStableCallback((entryId: string | undefined): void => {
    onActiveEntryChange?.(entryId)
  })
  const anchorTrackingEnabled = onActiveEntryChange !== undefined

  // Bottom-stick: an active upward scroll detaches immediately (no dead-zone trap; upward intent is
  // honored no matter how close to the bottom); re-stick only on an active downward scroll reaching the near-bottom zone or an actual bottom hit.
  // During the initial bottom-stick window, a falling scroll top may just be the estimated-to-real
  // layout shift (browsers also fire scroll when clamping an out-of-range scrollTop after shrink);
  // user intent is not judged from it — during the window, user takeover is cancelled and the stick released synchronously by the calibrator's physical-input listeners.
  // Standing directional input release: upward wheel (deltaY<0) and upward arrow keys release the
  // stick synchronously inside the listeners instead of waiting for scroll (scroll fires async; the
  // ResizeObserver bottom-follow write from streaming growth may arrive before scroll, so a scroll-only check would drag the user's scrolled-up position back down).
  // Only clearly upward input is handled; clicks/touches/downward input never block working bottom-follow.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = (): void => {
      const top = el.scrollTop
      if (initialBottomRef.current.active) {
        lastScrollTopRef.current = top
        setShowScrollBottom(false)
        return
      }
      const distanceFromBottom = el.scrollHeight - top - el.clientHeight
      if (top < lastScrollTopRef.current) {
        // Composer collapse or content shrink clamps scrollTop to the new bottom; keep the existing
        // follow intent — neither misjudge it as a user scroll-up nor restore a stick the user released.
        if (distanceFromBottom > 1) {
          stickToBottomRef.current = false
          programmaticBottomScrollRef.current = false
        }
      } else if (distanceFromBottom <= 32 && (top > lastScrollTopRef.current || distanceFromBottom <= 8)) {
        stickToBottomRef.current = true
      }
      lastScrollTopRef.current = top
      syncScrollBottomVisibility(el)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) stopFollowingBottom()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stopFollowingBottom()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [stopFollowingBottom, syncScrollBottomVisibility])

  // Viewport reading-anchor tracking (feeds the outline highlight): the IntersectionObserver
  // watches a band narrowed to "container top + OUTLINE_ACTIVE_LINE_PX baseline"; a row intersects
  // iff its top has passed the baseline, so the last intersecting index aligns with
  // resolveActiveOutlineEntryId (see timeline-containment-model) without forcing layout on
  // offscreen rows via rect measurement; rebind when the anchor set or container height changes; without IO fall back to rAF-throttled full-list measurement.
  useEffect(() => {
    if (!anchorTrackingEnabled) return
    const scroller = scrollRef.current
    const inner = innerRef.current
    if (scroller === null || inner === null) return

    const anchors = Array.from(inner.querySelectorAll<HTMLElement>('[data-entry-id]')).filter(
      (el) => (el.dataset.entryId ?? '') !== '',
    )
    const entryIds = anchors.map((el) => el.dataset.entryId!)
    const publish = (nextActive: string | undefined): void => {
      if (nextActive === lastActiveEntryRef.current) return
      lastActiveEntryRef.current = nextActive
      notifyActiveEntryChange(nextActive)
    }

    if (typeof IntersectionObserver === 'undefined') {
      // Fallback path: rAF-throttled, at most one measurement per frame (not per scroll event).
      let frame = 0
      const measure = (): void => {
        frame = 0
        const containerTop = scroller.getBoundingClientRect().top
        const offsets: Array<{ entryId: string; top: number }> = []
        for (const node of anchors) {
          offsets.push({ entryId: node.dataset.entryId!, top: node.getBoundingClientRect().top - containerTop })
        }
        publish(resolveActiveOutlineEntryId(offsets, OUTLINE_ACTIVE_LINE_PX))
      }
      const schedule = (): void => {
        if (frame === 0) frame = requestAnimationFrame(measure)
      }
      schedule()
      scroller.addEventListener('scroll', schedule, { passive: true })
      return () => {
        scroller.removeEventListener('scroll', schedule)
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }

    const intersecting = new Set<number>()
    const indexByEl = new Map<HTMLElement, number>()
    anchors.forEach((el, index) => indexByEl.set(el, index))
    const onEntries = (entries: IntersectionObserverEntry[]): void => {
      for (const entry of entries) {
        const idx = indexByEl.get(entry.target as HTMLElement)
        if (idx === undefined) continue
        if (entry.isIntersecting) intersecting.add(idx)
        else intersecting.delete(idx)
      }
      const next = resolveActiveAnchorIndex(intersecting, entryIds.length)
      publish(next === -1 ? undefined : entryIds[next])
    }
    let io: IntersectionObserver | null = null
    const buildObserver = (): void => {
      io?.disconnect()
      intersecting.clear()
      // The baseline moves with container height (split/zoom): ResizeObserver triggers rebinding.
      const bottomInset = Math.max(0, scroller.clientHeight - OUTLINE_ACTIVE_LINE_PX)
      io = new IntersectionObserver(onEntries, { root: scroller, rootMargin: `0px 0px -${bottomInset}px 0px` })
      for (const el of anchors) io.observe(el)
    }
    buildObserver()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => buildObserver())
      ro.observe(scroller)
    }
    return () => {
      io?.disconnect()
      ro?.disconnect()
    }
  }, [anchorTrackingEnabled, anchorSignature, notifyActiveEntryChange])

  // Outline click locate: the target row is already render-released in the same render
  // (releasedEntryIds contains the requested entryId); this effect measures and locates with the
  // real layout after DOM commit; headings use DOM order (containment keeps the full DOM,
  // matching outline extraction). The tick is consumed only when the target actually exists and is
  // handled: if the target is not loaded yet (paging window not reached) it is neither consumed nor marked, and retries when the anchor set changes — never silently dropped.
  useEffect(() => {
    if (!outlineScrollRequest || outlineScrollRequest.tick === lastOutlineTickRef.current) return
    const container = innerRef.current
    if (container === null) return

    let targetWrapper: HTMLElement | null = null
    for (const el of container.querySelectorAll<HTMLElement>('[data-entry-id]')) {
      if (el.dataset.entryId === outlineScrollRequest.entryId) {
        targetWrapper = el
        break
      }
    }
    if (targetWrapper === null) return
    lastOutlineTickRef.current = outlineScrollRequest.tick
    stickToBottomRef.current = false

    let scrollEl: HTMLElement = targetWrapper
    if (outlineScrollRequest.cardId !== undefined) {
      const cardEl = targetWrapper.querySelector<HTMLElement>(
        `[data-outline-card-id="${escapeAttrSelectorValue(outlineScrollRequest.cardId)}"]`,
      )
      if (cardEl !== null) {
        scrollEl = cardEl
      }
    } else if (outlineScrollRequest.headingIndex !== undefined) {
      const headings = targetWrapper.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2, .msg-ai-body h3')
      const matchedHeading = headings[outlineScrollRequest.headingIndex]
      if (matchedHeading !== undefined) {
        scrollEl = matchedHeading
      }
    }
    // Outline locate: align the target to the top of the scroll area (not centered) so reading continues downward from that message.
    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    armScrollCalibration(scrollEl, 'start')
    setLocalHighlightEntryId(outlineScrollRequest.entryId)
    if (anchorTrackingEnabled) {
      lastActiveEntryRef.current = outlineScrollRequest.entryId
      notifyActiveEntryChange(outlineScrollRequest.entryId)
    }
    if (outlineHighlightTimerRef.current !== null) clearTimeout(outlineHighlightTimerRef.current)
    outlineHighlightTimerRef.current = setTimeout(() => {
      outlineHighlightTimerRef.current = null
      setLocalHighlightEntryId((current) => (current === outlineScrollRequest.entryId ? null : current))
    }, 2400)
  }, [outlineScrollRequest, anchorTrackingEnabled, notifyActiveEntryChange, anchorSignature, armScrollCalibration])

  // Watch the inner container height (streaming thinking growth, command appends, group auto expand/collapse).
  // Follow to the bottom only while the conversation is actively generating (isWorking / hasLiveTurn)
  // and currently bottom-stuck; settled conversations browsing history are never yanked to the bottom by containment estimate corrections, fold toggles, or async resource loads.
  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (inner === null || scroller === null) return
    const syncContainerWidth = (): void => {
      const width = scroller.clientWidth
      if (width > 0) {
        const next = resolveCharsPerLine(width)
        setCharsPerLine((prev) => (prev === next ? prev : next))
      }
    }
    syncContainerWidth()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      syncContainerWidth()
      const el = scrollRef.current
      if (el === null) return
      if (stickToBottomRef.current && (isWorking || hasLiveTurn)) {
        el.scrollTop = el.scrollHeight
        lastScrollTopRef.current = el.scrollTop
      }
      syncScrollBottomVisibility(el)
    })
    ro.observe(inner)
    // Composer height or mobile keyboards change only the viewport, not necessarily the inner size.
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [isWorking, hasLiveTurn, syncScrollBottomVisibility])

  useEffect(() => {
    if (store.highlightedEntry?.conversationId === conversation.id) stopFollowingBottom()
  }, [store.highlightedEntry, conversation.id, stopFollowingBottom])

  const lastHumanKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (item.kind === 'human' && item.origin === 'human') return item.key
    }
    return undefined
  }, [items])

  const lastTurnSummary = useMemo(() => {
    const last = items[items.length - 1]
    if (last?.kind !== 'assistant') return ''
    return last.segments
      .map((s) => (s.kind === 'step-group' ? `g:${s.stepCount}:${s.active ? 1 : 0}` : s.kind === 'tool' ? `t:${s.tool.key}:${s.tool.status}` : `x:${s.text.length}`))
      .join(',')
  }, [items])

  const contentFingerprint = `${items.length}:${detailEntries.length}:${conversation.status}:${conversation.contextUsage?.compacting === true ? 1 : 0}:${lastTurnSummary}:${live?.updatedAt ?? 0}:${live?.thinking?.length ?? 0}:${live?.text.length ?? 0}:${live?.queuedInputs?.map((q) => `${q.id}:${q.mode}`).join(',') ?? ''}:${resolvedAsks.length}`
  // History ready (conversationDetails exists, including legitimately empty conversations): a blank
  // loading mount does not start the initial bottom-stick window, so the hard deadline is not burned while blank.
  const detailsReady = store.conversationDetails[conversation.id] !== undefined

  // SWR 静默替换保护：已上滑阅读历史（!stickToBottomRef）且非手动翻页加载时，
  // 若同一会话的 detailEntries 引用变化，于 DOM commit 前捕获当前可见行锚点，
  // commit 后在 useLayoutEffect 同步恢复滚动锚点，防止重连/后台刷新引起位置跳动。
  if (
    prevConvIdRef.current === conversation.id &&
    prevDetailEntriesRef.current !== detailEntries &&
    detailsReady &&
    !loadingOlder &&
    !stickToBottomRef.current &&
    scrollRef.current !== null &&
    typeof document !== 'undefined' &&
    typeof document.elementFromPoint === 'function'
  ) {
    const anchor = captureTimelineScrollAnchor(scrollRef.current)
    swrAnchorRef.current = anchor !== undefined ? { entries: detailEntries, anchor } : null
  } else if (prevConvIdRef.current !== conversation.id || stickToBottomRef.current) {
    swrAnchorRef.current = null
  }

  useLayoutEffect(() => {
    prevConvIdRef.current = conversation.id
    prevDetailEntriesRef.current = detailEntries
    const pending = swrAnchorRef.current
    if (pending === null || pending.entries !== detailEntries) return
    swrAnchorRef.current = null
    if (stickToBottomRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    const { anchor } = pending
    const anchorEntryId = anchor.element.dataset.entryId
    const resolvedAnchor =
      anchor.element.isConnected && scroller.contains(anchor.element)
        ? anchor
        : anchorEntryId !== undefined
          ? (() => {
              const matched = Array.from(scroller.querySelectorAll<HTMLElement>('[data-entry-id]'))
                .find((el) => el.dataset.entryId === anchorEntryId)
              return matched !== undefined ? { element: matched, top: anchor.top } : undefined
            })()
          : undefined
    restoreTimelineScrollAnchor(scroller, resolvedAnchor)
    lastScrollTopRef.current = scroller.scrollTop
    syncScrollBottomVisibility(scroller)
  }, [conversation.id, detailEntries, syncScrollBottomVisibility])

  useEffect(() => {
    if (detailsReady) {
      const previousFingerprint = prevFingerprintRef.current
      if (
        previousFingerprint !== null &&
        previousFingerprint.conversationId === conversation.id &&
        previousFingerprint.value !== contentFingerprint &&
        !stickToBottomRef.current
      ) {
        setHasUnreadScrollUpdates(true)
      }
      prevFingerprintRef.current = { conversationId: conversation.id, value: contentFingerprint }
      const previous = lastHumanRef.current
      // Initial history only records anchors; a ready empty conversation's first send later is still new input and must stick.
      if (previous?.conversationId === conversation.id && lastHumanKey !== undefined && lastHumanKey !== previous.key) {
        stickToBottomRef.current = true
        programmaticBottomScrollRef.current = false
        setHasUnreadScrollUpdates(false)
      }
      lastHumanRef.current = { conversationId: conversation.id, key: lastHumanKey }
    }
    const el = scrollRef.current
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
    if (el !== null) syncScrollBottomVisibility(el)
    // Start the one-shot initial bottom-stick calibration once history is ready (the window guards
    // itself: no-op when consumed/in-flight/stick-released); late-ready data restarts it via the detailsReady dependency.
    if (detailsReady) beginInitialBottomCalibration()
  }, [contentFingerprint, detailEntries, lastHumanKey, detailsReady, conversation.id, beginInitialBottomCalibration, syncScrollBottomVisibility])

  const loading = !detailsReady

  const loadEarlierEntries = (): void => {
    stopFollowingBottom()
    const scroller = scrollRef.current
    if (scroller === null) return
    const anchor = captureTimelineScrollAnchor(scroller)
    setLoadingOlder(true)
    void store.loadEarlierEntries(conversation.id).finally(() => {
      setLoadingOlder(false)
      requestAnimationFrame(() => restoreTimelineScrollAnchor(scroller, anchor))
    })
  }

  // Starters appear only in a "truly empty" conversation: history fully loaded with no earlier
  // page, no in-flight send/run, no queued input, no pending ask. Any miss suppresses them — no false positives.
  const conversationDetail = store.conversationDetails[conversation.id]
  const hasOlderCursor = Boolean(conversationDetail?.nextCursor)
  const historyError = store.loadErrors[`history:${conversation.id}`]
  const showEmptyState =
    !loading && !sendingPending && !isWorking && items.length === 0 && resolvedAsks.length === 0
  const startersVisible =
    starters !== undefined &&
    starters.length > 0 &&
    onRequestStarter !== undefined &&
    !loading &&
    conversationDetail?.nextCursor === undefined &&
    !isWorking &&
    conversation.status !== 'blocked' &&
    !sendingPending &&
    (live?.queuedInputs?.length ?? 0) === 0 &&
    items.length === 0 &&
    resolvedAsks.length === 0
  const hasLeadingCenterSlot =
    hasOlderCursor || Boolean(historyError) || loading || showEmptyState || startersVisible

  return (
    <div ref={rootRef} className="timeline-container">
      <div ref={scrollRef} className="timeline-scroll">
      {hasLeadingCenterSlot ? (
        <div className="timeline-center-slot">
          {hasOlderCursor ? (
            <button type="button" className="btn btn-ghost btn-sm timeline-load-older-btn" disabled={loadingOlder} onClick={loadEarlierEntries}>
              {loadingOlder ? t('conv.timeline.loadingHistory') : t('conv.timeline.loadEarlier')}
            </button>
          ) : null}
          {historyError ? <p className="callout callout--error" role="alert">{historyError}</p> : null}
          {loading ? (
            <div className="timeline-loading-state">
              <HelmIcon name="loader" size={14} className="spin-slow" />
              {t('conv.timeline.loadingConversation')}
            </div>
          ) : null}
          {showEmptyState ? (
            <div className="timeline-empty-state">
              <HelmIcon name="message-square" size={22} />
              <span>{t('conv.timeline.empty')}</span>
            </div>
          ) : null}
          {startersVisible ? (
            <div className="timeline-starters">
              {starters.map((starter, index) => (
                <button
                  key={`starter-${index}-${starter.label}`}
                  type="button"
                  className="timeline-starter-btn"
                  title={starter.prompt}
                  onClick={() => onRequestStarter?.(starter.prompt)}
                >
                  <HelmIcon name="corner-down-right" size={11} />
                  <span className="timeline-starter-label">{starter.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={innerRef} className="timeline-inner">
        {items.map((item) => {
          // Containment class: only finished historical rows get it (live/queued/latest assistant
          // rows/released targets resolve to an empty string and render normally).
          const cvClass = resolveContainmentClass(item, cvExclusions, containmentEnabled)
          if (item.kind === 'human') {
            return (
              <div
                key={item.key}
                className={`timeline-human-wrap ${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <HumanMessage
                  item={item}
                  conversation={conversation}
                  anchorEntry={activeEntriesById.get(item.entryId)}
                  onRequestEdit={onRequestEdit}
                  onForkFromHere={entryActions.forkFromHere}
                  onWithdrawQueuedEdit={entryActions.withdrawQueuedForEdit}
                />
              </div>
            )
          }
          if (item.kind === 'divider') {
            return (
              <div
                key={item.key}
                className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <ContextDivider item={item} />
              </div>
            )
          }
          if (item.kind === 'plugin-card') {
            return (
              <div
                key={item.key}
                className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <PluginCard item={item} conversationId={conversation.id} />
              </div>
            )
          }
          const anchorId = timelineAnchorId(item)
          const modelBoundary = modelBoundaries.get(item.key)
          return (
            <div
              key={item.key}
              className={`${highlightClass(anchorId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
              ref={highlightScrollRef}
              data-entry-id={anchorId}
              data-latest-process-turn={item.key === latestProcessTurnKey ? 'true' : undefined}
            >
              {modelBoundary !== undefined ? <AssistantModelBoundary model={modelBoundary} /> : null}
              <AssistantTurnView
                turn={item}
                conversation={conversation}
                siblingCalls={siblingCalls}
                anchorEntry={resolveAssistantAnchorEntry(item.entryIds, activeEntriesById)}
                isLatestTurn={item.key === lastAssistantKey}
                processShortcut={processToggle?.turnKey === item.key ? processToggle.command : undefined}
                onForkFromHere={entryActions.forkFromHere}
              />
            </div>
          )
        })}
        {(isWorking && !hasLiveTurn) || (sendingPending && !isWorking) ? (
          <div className="msg-ai-block" role="status" aria-live="polite">
            <span className="msg-origin-tag msg-live-waiting" aria-label={t('conv.timeline.generating')}>
              <HelmIcon name="loader" size={12.5} className="spin-slow" />
              <span className="msg-live-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="msg-live-label">{t('conv.timeline.generating')}</span>
            </span>
          </div>
        ) : null}
        {resolvedAsks.map(({ ask, status }) => (
          <ResolvedAskRow key={`ask:${ask.id}`} ask={ask} status={status} />
        ))}
        {conversation.status === 'error' ? (
          <TurnErrorNotice conversation={conversation} detailEntries={detailEntries} onRequestEdit={onRequestEdit} />
        ) : null}
      </div>
      <div ref={bottomRef} className="timeline-scroll-anchor" />
      </div>
      {showScrollBottom ? (
        <button
          type="button"
          className={`timeline-scroll-bottom-btn${hasUnreadScrollUpdates ? ' has-unread' : ''}`}
          aria-label={t('conv.timeline.backToBottom')}
          title={t('conv.timeline.backToBottom')}
          onClick={scrollToBottomAndFollow}
        >
          <HelmIcon name="arrow-down" size={16} />
          {isWorking || hasLiveTurn || sendingPending || hasUnreadScrollUpdates ? (
            <span className="timeline-scroll-bottom-dot" aria-hidden="true" />
          ) : null}
        </button>
      ) : null}
    </div>
  )
}
