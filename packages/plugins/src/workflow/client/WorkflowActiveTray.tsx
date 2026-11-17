/**
 * builtin:workflow bottom in-flight activity tray (COMPOSER_DOCK_SLOT
 * extension point): renders a compact 32px single-line HUD only when the
 * current conversation or its descendants have in-flight tasks (running /
 * blocked / background subagents), with an expandable concurrent list and
 * one-click access to the workbench / drawer / abort / detach; returns null
 * once everything settles (0px, never occupying space).
 *
 * Interaction contract (card de-clutter pass):
 * - the whole top bar toggles expand/collapse (role=button, Enter/Space);
 *   no separate expand button; the Workbench button isolates its clicks and
 *   keys so it never double-fires with the bar toggle;
 * - every expanded row is wholly clickable (Enter/Space included) as the real
 *   detail entry: conversationId opens the ConversationDrawer, else runId
 *   focuses the run in the workbench; no per-row "View/Details" button;
 * - abort / detach remain real action buttons with stopPropagation;
 * - the main status is a single StatusLight (blocked wins over running);
 *   no spinner, no duplicated status text.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { ComposerScopeProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginLocale,
} from '@helm/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildActiveTraySummary } from './model-active-tray.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'
import {
  ACTION_ABORT,
  ACTION_DETACH,
  actionDetachDone,
  execConversationTitle,
  TRAY_COLLAPSE,
  TRAY_EXPAND,
  TRAY_REGION_ARIA,
  TRAY_WORKBENCH,
  trayActionFailed,
  trayCount,
  trayRowOpenConversationLabel,
  trayRowOpenRunLabel,
  trayToggleLabel,
} from './copy.ts'

/** Keyboard activation guard shared by the bar and rows (Enter/Space only, never steals other controls). */
function activateOnKey(e: KeyboardEvent<HTMLElement>, activate: () => void): void {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate()
  }
}

export function WorkflowActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const listId = useId()

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const ownedBy =
    props.conversation?.ownedBy ??
    conversations.find((c) => c.id === conversationId)?.ownedBy

  const summary = useMemo(
    () =>
      conversationId === undefined
        ? undefined
        : buildActiveTraySummary(
            {
              rootConversationId: conversationId,
              conversations,
              runs: runsDoc?.runs ?? [],
              viewer: { conversationId, ownedBy },
            },
            locale,
          ),
    [conversationId, conversations, runsDoc, ownedBy, locale],
  )

  const hasTimer = summary !== undefined && summary.items.length > 0 && summary.earliestStartedAt !== undefined
  const nowMs = useElapsedNowMs(hasTimer)

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }

  const runAction = (key: string, actionId: string, runId: string, successMessage?: string): void => {
    if (busyKey !== undefined) return
    setBusyKey(key)
    void ctx
      .callAction(actionId, { runId })
      .then(() => {
        if (successMessage !== undefined) ctx.notify(successMessage)
      })
      .catch((err: unknown) => {
        ctx.notify(
          trayActionFailed(actionId === 'abort' ? 'abort' : 'detach', err instanceof Error ? err.message : String(err), locale),
          'error',
        )
      })
      .finally(() => {
        setBusyKey(undefined)
      })
  }

  const countText = trayCount(summary.blockedCount, summary.runningCount, summary.activeCount, locale)
  const hasBlocked = summary.blockedCount > 0

  const singleProgress =
    summary.items.length === 1 ? summary.items[0]!.progress : undefined

  const frontlineText =
    summary.approvals.length > 0
      ? summary.approvals.map((a) => a.text).join(' · ')
      : summary.frontline.length > 0
        ? summary.frontline.map((f) => f.text).join(' · ')
        : summary.items.map((i) => i.title).slice(0, 2).join(' · ')

  const hudElapsed =
    nowMs !== undefined && summary.earliestStartedAt !== undefined && nowMs >= summary.earliestStartedAt
      ? formatDurationMs(nowMs - summary.earliestStartedAt)
      : undefined

  return (
    <div
      className={`workflow-active-tray${hasBlocked ? ' workflow-active-tray-warn' : ''}`}
      role="region"
      aria-label={resolveLocalizedText(TRAY_REGION_ARIA, locale)}
    >
      <div
        className="workflow-active-tray-bar workflow-active-tray-bar-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={trayToggleLabel(expanded, countText, locale)}
        title={resolveLocalizedText(expanded ? TRAY_COLLAPSE : TRAY_EXPAND, locale)}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => activateOnKey(e, () => setExpanded((v) => !v))}
      >
        <div className="workflow-active-tray-left">
          <StatusLight status={hasBlocked ? 'blocked' : 'running'} label={countText} />
          {singleProgress !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge tabular-nums">
              {`${singleProgress.done}/${singleProgress.total}`}
            </span>
          ) : null}
          {frontlineText !== '' ? (
            <span className="workflow-active-tray-frontline">{frontlineText}</span>
          ) : null}
        </div>
        <div
          className="workflow-active-tray-right"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {hudElapsed !== undefined ? (
            <span className="workflow-active-tray-elapsed tabular-nums">{hudElapsed}</span>
          ) : null}
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => {
              const singleRunId = summary.items.length === 1 ? summary.items[0]?.runId : undefined
              if (singleRunId !== undefined) requestWorkbenchRunFocus(conversationId, singleRunId)
              ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
            }}
          >
            <Icon name="git-branch" size={11} />
            <span>{resolveLocalizedText(TRAY_WORKBENCH, locale)}</span>
          </button>
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={11}
            className="workflow-active-tray-chevron"
          />
        </div>
      </div>
      {expanded ? (
        <div id={listId} className="workflow-active-tray-list">
          {summary.items.map((item) => {
            const itemElapsed =
              nowMs !== undefined && item.startedAt !== undefined && nowMs >= item.startedAt
                ? formatDurationMs(nowMs - item.startedAt)
                : undefined
            const isFallbackConvTitle =
              item.conversationId !== undefined && item.title === execConversationTitle(item.conversationId, locale)
            // Whole-row detail entry: conversation rows open the drawer, other
            // rows focus the run in the workbench. Real actions (detach /
            // abort) isolate clicks and keys inside the trailing group.
            const openRow = (): void => {
              if (item.conversationId !== undefined) {
                ctx.openConversationDrawer(item.conversationId)
                return
              }
              if (item.runId !== undefined) {
                requestWorkbenchRunFocus(conversationId, item.runId)
                ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
              }
            }
            const rowActivatable = item.conversationId !== undefined || item.runId !== undefined
            const rowLabel =
              item.conversationId !== undefined
                ? trayRowOpenConversationLabel(item.conversationId, locale)
                : item.runId !== undefined
                  ? trayRowOpenRunLabel(item.runId, locale)
                  : item.title
            return (
              <div
                key={item.key}
                {...(rowActivatable
                  ? {
                      role: 'button' as const,
                      tabIndex: 0,
                      'aria-label': `${item.title} — ${rowLabel}`,
                    }
                  : {})}
                className={`workflow-active-tray-row${rowActivatable ? ' workflow-active-tray-row-clickable' : ''}`}
                onClick={rowActivatable ? openRow : undefined}
                onKeyDown={rowActivatable ? (e) => activateOnKey(e, openRow) : undefined}
              >
                <div className="workflow-active-tray-row-main">
                  <StatusLight status={item.isBlocked ? 'blocked' : 'running'} />
                  <span className="workflow-active-tray-row-title">{item.title}</span>
                  {item.conversationId !== undefined && !isFallbackConvTitle ? (
                    <span className="workflow-active-tray-row-id tabular-nums">{`#${item.conversationId}`}</span>
                  ) : null}
                  {item.progress !== undefined ? (
                    <span className="badge badge-neutral workflow-trace-badge tabular-nums">
                      {`${item.progress.done}/${item.progress.total}`}
                    </span>
                  ) : null}
                  {item.doing !== undefined ? (
                    <span className="workflow-active-tray-row-doing">{item.doing}</span>
                  ) : null}
                </div>
                <div
                  className="workflow-active-tray-row-actions"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {itemElapsed !== undefined ? (
                    <span className="workflow-active-tray-elapsed tabular-nums">{itemElapsed}</span>
                  ) : null}
                  {item.canDetach && item.runId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busyKey !== undefined}
                      onClick={() =>
                        runAction(
                          `detach:${item.runId}`,
                          'detach',
                          item.runId!,
                          actionDetachDone(item.runId!, locale),
                        )
                      }
                    >
                      <Icon name="arrow-down-to-line" size={11} />
                      <span>{resolveLocalizedText(ACTION_DETACH, locale)}</span>
                    </button>
                  ) : null}
                  {item.canAbort && item.runId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      disabled={busyKey !== undefined}
                      onClick={() => runAction(`abort:${item.runId}`, 'abort', item.runId!)}
                    >
                      <Icon name="square" size={11} />
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
