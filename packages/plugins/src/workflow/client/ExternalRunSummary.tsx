/**
 * Background task summary component for external runtimes (e.g. Herdr panes):
 * shown honestly when there is no native subagent, without fabricating a
 * subagent entry. Running foreground-sync runs carry a "Move to background"
 * action (detach).
 */
import type { ReactNode } from 'react'
import { StatusLight, formatDurationMs, usePluginContext, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useElapsedNowMs } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { isPlaceholderNodeLabel, isPlaceholderRunName } from './model-format.ts'
import { executionLightStatus } from './model-execution-status.ts'
import { subagentBadge, runFailureFallbackLabel } from './model-subagent-card.ts'
import { canDetachForegroundRun, resolveRunElapsedMs, type DetachViewerScope } from './model-run.ts'
import {
  ACTION_DETACH,
  ACTION_DETACH_EXTERNAL_ARIA,
  ACTION_DETACH_EXTERNAL_TITLE,
  actionDetachDone,
  actionDetachFailed,
  EXTERNAL_TITLE,
  externalBackgroundTaskLabel,
  nodeStatusLabel,
  runStatusLabel,
  externalErrorJoiner,
  externalIdleLine,
  externalNodeFailedLabel,
  externalRunningNodes,
  worktreeBadgeTitle,
} from './copy.ts'

export function ExternalRunSummary(props: {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  toolStatus: 'running' | 'done' | 'error'
  executionId?: string
  /** Viewer scope (conversation + ownership): foreground-sync run "Move to background" visibility check. */
  viewer?: DetachViewerScope
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { run, worktree, toolStatus, executionId } = props
  const nodes = run?.nodes ?? []
  const running = nodes.filter((n) => n.status === 'running').length
  const failed = nodes.find((n) => n.status === 'failed')
  // Error line of a failed/aborted run: the fallback label distinguishes
  // foreground sync (execution failed) from true background (background run
  // failed); the error text is joined honestly (without one only the label
  // remains, never duplicated twice).
  const runError = run !== undefined && (run.status === 'failed' || run.status === 'aborted')
    ? [runFailureFallbackLabel(run, locale), run.error].filter(Boolean).join(externalErrorJoiner(locale))
    : undefined
  const badge = subagentBadge(undefined, toolStatus, run, undefined, locale)
  const active = badge.status === 'working'
  const failedState = badge.status === 'error'
  // Run total duration: advances with the stopwatch while running, freezes at
  // createdAt → updatedAt when finished; omitted honestly without run data.
  const nowMs = useElapsedNowMs(active && run?.status === 'running')
  const elapsedMs = run !== undefined ? resolveRunElapsedMs(run, nowMs) : undefined
  const primaryTitle =
    run !== undefined && !isPlaceholderRunName(run.name, run.id)
      ? run.name.trim()
      : !isPlaceholderNodeLabel(nodes[0]?.label)
        ? nodes[0]!.label!.trim()
        : undefined
  return (
    <div className="subagent-live-card subagent-external-card">
      <div className="subagent-live-header">
        <Icon name="bot" size={13} />
        <span className="subagent-live-title" title={primaryTitle ?? t(EXTERNAL_TITLE)}>
          <span className="subagent-live-title-text">{primaryTitle ?? t(EXTERNAL_TITLE)}</span>
          {primaryTitle !== undefined ? <span className="badge badge-neutral">{t(EXTERNAL_TITLE)}</span> : null}
          {executionId !== undefined ? <span className="badge badge-neutral mono">{executionId}</span> : null}
        </span>
        {worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={worktreeBadgeTitle(worktree.path, locale)}>
            <Icon name="git-branch" size={11} />
            {worktree.branch}
          </span>
        ) : null}
        {(() => {
          const lightStatus = executionLightStatus(badge.status, run, failed !== undefined)
          return (
            <StatusLight
              status={lightStatus}
              label={lightStatus === 'aborted' ? runStatusLabel('aborted', locale) : badge.label}
            />
          )
        })()}
        {elapsedMs !== undefined ? (
          <span className="subagent-live-elapsed tabular-nums">{formatDurationMs(elapsedMs)}</span>
        ) : null}
        {run !== undefined && canDetachForegroundRun(run, props.viewer) ? (
          <button
            type="button"
            className="btn btn-xs"
            title={t(ACTION_DETACH_EXTERNAL_TITLE)}
            aria-label={t(ACTION_DETACH_EXTERNAL_ARIA)}
            onClick={() => {
              void ctx
                .callAction('detach', { runId: run.id })
                .then(() => ctx.notify(actionDetachDone(run.id, locale)))
                .catch((err: unknown) => ctx.notify(actionDetachFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
            }}
          >
            <Icon name="arrow-down-to-line" size={11} />
            <span className="subagent-action-label">{t(ACTION_DETACH)}</span>
          </button>
        ) : null}
      </div>
      <div className="subagent-live-stream subagent-external-body">
        {nodes.length > 0 ? (
          <div className="workflow-node-list">
            {nodes.map((n) => (
              <div key={n.id} className="workflow-node-line">
                <StatusLight status={n.status} label={nodeStatusLabel(n.status, locale)} />
                <span className="workflow-node-label">{n.label ?? n.id}</span>
                {n.executionId !== undefined ? <span className="subagent-external-exec">{n.executionId}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="subagent-stream-line subagent-stream-empty">
            {run === undefined
              ? externalIdleLine(active ? 'active' : failedState ? 'error' : 'settled', locale)
              : externalBackgroundTaskLabel(run.id, locale)}
          </div>
        )}
        {runError !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={runError}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">{runError}</span>
          </div>
        ) : null}
        {failed !== undefined && failed.error !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={failed.error}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">{externalNodeFailedLabel(failed.error, locale)}</span>
          </div>
        ) : null}
        {running > 0 ? <div className="subagent-stream-line subagent-stream-empty">{externalRunningNodes(running, locale)}</div> : null}
      </div>
    </div>
  )
}
