/**
 * builtin:swarm composer activity tray (COMPOSER_DOCK_SLOT contribution):
 * renders a compact 32px single-line HUD only in the group's *coordinator*
 * conversation while its swarm group has in-flight members (working /
 * blocked); returns null (0px) otherwise — a worker conversation never docks
 * the group HUD (the slot's semantics are "this conversation's own in-flight
 * dispatches", matching the workflow active tray; worker viewers get group
 * context from the on-demand workbench panel). Structurally identical to the
 * workflow active tray — the main region is one real toggle <button>
 * (aria-expanded / aria-controls), the workbench action is a sibling button,
 * and every expanded row is one real detail-entry <button> opening the
 * ConversationDrawer, with abort as a trailing sibling action on both working
 * and blocked members (the backend abortWorker supports both; never nested).
 *
 * Data: the outer shell only reads the public `index` doc to resolve the
 * conversation's group and gate on coordinator identity; the inner tray (which
 * subscribes the live per-coordinator `board-view` session doc — swarm keeps
 * this high-frequency state out of global docs by design) is not mounted at
 * all for non-coordinators, so a worker mount costs zero session-doc SSE.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import {
  HelmxIcon,
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import { SWARM_WORKBENCH_PANEL_TARGET } from './models.ts'
import { buildSwarmTraySummary, resolveSwarmTrayLiveSnippet, type SwarmTrayItem } from './model-tray.ts'
import { parseBoardView, resolveConversationBoardLink, type BoardViewDoc } from './board-model.ts'
import { useElapsedNowMs } from './hooks.ts'
import {
  ACTION_ABORT,
  TRAY_COLLAPSE,
  TRAY_EXPAND,
  TRAY_REGION_ARIA,
  TRAY_WORKBENCH,
  memberLiveStateLabel,
  trayAbortFailed,
  trayCount,
  trayFrontline,
  trayProgress,
  trayRowOpenLabel,
  trayToggleLabel,
} from './copy.ts'

function SwarmTrayLiveLine(props: {
  conversationId: number | undefined
  isBlocked: boolean
  fallback?: string
  emptyFallback?: string
  inline?: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const conv = useConversation(props.conversationId, { includeDetail: false })
  const snippet =
    props.conversationId === undefined
      ? undefined
      : resolveSwarmTrayLiveSnippet(
          {
            isBlocked: props.isBlocked,
            ...(conv.summary !== undefined ? { summary: conv.summary } : {}),
            ...(conv.live !== undefined ? { live: conv.live } : {}),
            ...(conv.pendingAsks[0] !== undefined ? { pendingAsk: conv.pendingAsks[0] } : {}),
            ...(conv.loadError !== undefined ? { detailError: conv.loadError } : {}),
            ...(props.fallback !== undefined ? { fallbackDoing: props.fallback } : {}),
          },
          locale,
        )
  const text = snippet ?? props.emptyFallback
  if (text === undefined || text.trim() === '') return null
  return (
    <span className={props.inline === true ? 'sw-tray-frontline' : 'sw-tray-row-live'} title={text}>
      {text}
    </span>
  )
}

function SwarmTrayRow(props: {
  item: SwarmTrayItem
  busy: boolean
  onAbort: (key: string, memberName: string) => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { item } = props
  return (
    <div className="sw-tray-row">
      <button
        type="button"
        className="sw-tray-row-main"
        aria-label={`@${item.name} — ${trayRowOpenLabel(item.name, locale)}`}
        onClick={() => ctx.openConversationDrawer(item.conversationId)}
      >
        <StatusLight
          status={item.isBlocked ? 'blocked' : 'running'}
          label={memberLiveStateLabel(item.isBlocked ? 'blocked' : 'working', locale)}
        />
        <span className="sw-tray-row-title">@{item.name}</span>
        <span className="sw-tray-row-id tabular-nums">{`#${item.conversationId}`}</span>
        <SwarmTrayLiveLine
          conversationId={item.conversationId}
          isBlocked={item.isBlocked}
          fallback={item.doing}
        />
      </button>
      <div className="sw-tray-row-actions">
        <button
          type="button"
          className="btn btn-xs btn-danger"
          disabled={props.busy}
          onClick={() => props.onAbort(`abort:${item.name}`, item.name)}
        >
          <HelmxIcon name="square" size={11} />
          <span>{resolveLocalizedText(ACTION_ABORT, locale)}</span>
        </button>
      </div>
    </div>
  )
}

/** Coordinator-side in-flight tray; mounted only for the group's coordinator conversation. */
function SwarmCoordinatorTray(props: { conversationId: number; groupId: string }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { conversationId, groupId } = props
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const listId = useId()

  // The shell has already proved this conversation IS the coordinator, so the
  // board-view subscription key below is the conversation's own id.
  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>('board-view', { conversationId })
  const board = useMemo(() => {
    // hasValue=false (or deleted) means no live projection yet: render nothing
    // instead of fabricating an in-flight state.
    if (rawBoard === undefined) return undefined
    const parsed = parseBoardView(rawBoard)
    if (parsed === undefined) return undefined
    if (parsed.group.id !== groupId) return undefined
    if (parsed.group.coordinatorConversationId !== conversationId) return undefined
    if (parsed.group.status !== 'active') return undefined
    return parsed
  }, [rawBoard, conversationId, groupId])

  const summary = useMemo(
    () => (board !== undefined ? buildSwarmTraySummary(board, conversations) : undefined),
    [board, conversations],
  )

  const hasElapsed = summary !== undefined && summary.items.length > 0 && summary.groupStartedAt !== undefined
  const nowMs = useElapsedNowMs(hasElapsed)

  if (summary === undefined || summary.items.length === 0 || board === undefined) {
    return null
  }

  const hasBlocked = summary.blockedCount > 0
  const countText = trayCount(summary.blockedCount, summary.workingCount, locale)
  const runAbort = (key: string, memberName: string): void => {
    if (busyKey !== undefined || board === undefined) return
    setBusyKey(key)
    void ctx
      .callAction('abort_worker', { groupId: board.group.id, name: memberName }, { conversationId })
      .then(() => {
        /* board-view session doc reflects the abort; no fabricated local state */
      })
      .catch((err: unknown) => {
        ctx.notify(trayAbortFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => {
        setBusyKey(undefined)
      })
  }

  const frontlineText = summary.frontline !== undefined ? trayFrontline(summary.frontline, locale) : undefined
  const headlineItem = summary.items[0]
  const hudElapsed =
    nowMs !== undefined && summary.groupStartedAt !== undefined && nowMs >= summary.groupStartedAt
      ? formatDurationMs(nowMs - summary.groupStartedAt)
      : undefined

  return (
    <div
      className={`sw-tray${hasBlocked ? ' sw-tray-warn' : ''}`}
      role="region"
      aria-label={resolveLocalizedText(TRAY_REGION_ARIA, locale)}
    >
      <div className="sw-tray-bar">
        <button
          type="button"
          className="sw-tray-bar-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={trayToggleLabel(expanded, countText, locale)}
          title={resolveLocalizedText(expanded ? TRAY_COLLAPSE : TRAY_EXPAND, locale)}
          onClick={() => setExpanded((v) => !v)}
        >
          <StatusLight status={hasBlocked ? 'blocked' : 'running'} label={countText} />
          <span className="badge badge-neutral sw-tray-badge tabular-nums">
            {trayProgress(summary.doneCount, summary.activeCount, locale)}
          </span>
          {summary.items.length > 1 || expanded ? (
            <span className="sw-tray-count">{countText}</span>
          ) : null}
          {expanded ? null : headlineItem !== undefined ? (
            <SwarmTrayLiveLine
              conversationId={headlineItem.conversationId}
              isBlocked={headlineItem.isBlocked}
              fallback={headlineItem.doing}
              emptyFallback={frontlineText}
              inline
            />
          ) : frontlineText !== undefined ? (
            <span className="sw-tray-frontline">{frontlineText}</span>
          ) : null}
          <span className="sw-tray-spacer" />
          {hudElapsed !== undefined ? (
            <span className="sw-tray-elapsed tabular-nums">{hudElapsed}</span>
          ) : null}
          <HelmxIcon name={expanded ? 'chevron-down' : 'chevron-up'} size={11} className="sw-tray-chevron" />
        </button>
        <button
          type="button"
          className="btn btn-xs sw-tray-workbench"
          onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)}
        >
          <HelmxIcon name="network" size={11} />
          <span>{resolveLocalizedText(TRAY_WORKBENCH, locale)}</span>
        </button>
      </div>
      {expanded ? (
        <div id={listId} className="sw-tray-list">
          {summary.items.map((item) => (
            <SwarmTrayRow
              key={item.key}
              item={item}
              busy={busyKey !== undefined}
              onAbort={runAbort}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function SwarmActiveTray(props?: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const link = useMemo(
    () => resolveConversationBoardLink(conversationId, index),
    [conversationId, index],
  )

  // Coordinator-only mounting, enforced in the component itself as a defensive
  // guard independent of the slot scope: a worker conversation (or any
  // non-coordinator mount) renders nothing and never mounts the board-view
  // subscribing inner tray.
  if (conversationId === undefined) return null
  if (link === undefined || link.coordinatorConversationId !== conversationId) return null
  return <SwarmCoordinatorTray key={conversationId} conversationId={conversationId} groupId={link.groupId} />
}
