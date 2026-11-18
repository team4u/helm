/**
 * builtin:swarm composer activity tray (COMPOSER_DOCK_SLOT contribution):
 * renders a compact 32px single-line HUD only when the current conversation's
 * swarm group has in-flight members (working / blocked); returns null (0px)
 * otherwise. Structurally identical to the workflow active tray — the main
 * region is one real toggle <button> (aria-expanded / aria-controls), the
 * workbench action is a sibling button, and every expanded row is one real
 * detail-entry <button> opening the ConversationDrawer, with abort as a
 * trailing sibling action for the coordinator viewer (never nested).
 *
 * Data: public `index` doc resolves the conversation's group; the live
 * per-coordinator `board-view` session doc provides member states (swarm keeps
 * this high-frequency state out of global docs by design).
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helm/protocol'
import {
  HelmIcon,
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import { SWARM_WORKBENCH_PANEL_TARGET } from './models.ts'
import { buildSwarmTraySummary } from './model-tray.ts'
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

export function SwarmActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const listId = useId()

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const link = useMemo(
    () => resolveConversationBoardLink(conversationId, {}, index),
    [conversationId, index],
  )

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>(
    'board-view',
    link !== undefined ? { conversationId: link.coordinatorConversationId } : undefined,
  )
  const board = useMemo(() => {
    // hasValue=false (or deleted) means no live projection yet: render nothing
    // instead of fabricating an in-flight state.
    if (rawBoard === undefined) return undefined
    const parsed = parseBoardView(rawBoard)
    if (parsed === undefined) return undefined
    if (link !== undefined && parsed.group.id !== link.groupId) return undefined
    if (parsed.group.status !== 'active') return undefined
    return parsed
  }, [rawBoard, link])

  const summary = useMemo(
    () => (board !== undefined ? buildSwarmTraySummary(board, conversations) : undefined),
    [board, conversations],
  )

  const hasElapsed = summary !== undefined && summary.items.length > 0 && summary.groupStartedAt !== undefined
  const nowMs = useElapsedNowMs(hasElapsed)

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }

  const isCoordinatorViewer = conversationId === board?.group.coordinatorConversationId
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
          {frontlineText !== undefined ? <span className="sw-tray-frontline">{frontlineText}</span> : null}
          {hudElapsed !== undefined ? (
            <span className="sw-tray-elapsed tabular-nums">{hudElapsed}</span>
          ) : null}
          <HelmIcon name={expanded ? 'chevron-down' : 'chevron-up'} size={11} className="sw-tray-chevron" />
        </button>
        <button
          type="button"
          className="btn btn-xs sw-tray-workbench"
          onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)}
        >
          <HelmIcon name="network" size={11} />
          <span>{resolveLocalizedText(TRAY_WORKBENCH, locale)}</span>
        </button>
      </div>
      {expanded ? (
        <div id={listId} className="sw-tray-list">
          {summary.items.map((item) => {
            const openRow = (): void => {
              ctx.openConversationDrawer(item.conversationId)
            }
            const canAbort = isCoordinatorViewer && !item.isBlocked
            return (
              <div key={item.key} className="sw-tray-row">
                <button
                  type="button"
                  className="sw-tray-row-main"
                  aria-label={`@${item.name} — ${trayRowOpenLabel(item.name, locale)}`}
                  onClick={openRow}
                >
                  <StatusLight
                    status={item.isBlocked ? 'blocked' : 'running'}
                    label={memberLiveStateLabel(item.isBlocked ? 'blocked' : 'working', locale)}
                  />
                  <span className="sw-tray-row-title">@{item.name}</span>
                  <span className="sw-tray-row-id tabular-nums">{`#${item.conversationId}`}</span>
                  {item.doing !== undefined ? <span className="sw-tray-row-doing">{item.doing}</span> : null}
                </button>
                <div className="sw-tray-row-actions">
                  {canAbort ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      disabled={busyKey !== undefined}
                      onClick={() => runAbort(`abort:${item.name}`, item.name)}
                    >
                      <HelmIcon name="square" size={11} />
                      <span>{resolveLocalizedText(ACTION_ABORT, locale)}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
