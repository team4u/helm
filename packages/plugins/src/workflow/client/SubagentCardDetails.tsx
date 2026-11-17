/**
 * Internal sub-views of the builtin:workflow subagent card (split from
 * SubagentCard.tsx):
 * - SubagentCardHeading: first-layer header badge area (icon + title + badges + stat suffix);
 * - SubagentCardActions: header action bar (abort / move to background / resume / clean up worktree / retry);
 * - SubagentCardSublines: second-layer dynamic sublines (current action digest + frontline activity).
 * Pure presentational components: data decisions live in the model-* pure
 * logic modules; this file only handles slot layout.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatCompactTimestamp, resolveLocalizedText, usePluginContext, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { SPIN, EXECUTION_BADGE } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildWorktreeSelector } from './model-worktree.ts'
import { canDetachForegroundRun, canResumeSubagentRun, type DetachViewerScope } from './model-run.ts'
import type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
import type { SubagentBadge, SubagentHeaderSnippet } from './model-subagent-card.ts'
import type { ExecutionApprovalItem, ExecutionFrontlineItem } from './model-execution-view.ts'
import {
  ACTION_ABORT,
  ACTION_ABORT_BG_TITLE,
  actionAbortFailed,
  ACTION_CLEANUP_WORKTREE,
  ACTION_CLEANUP_WORKTREE_ARIA,
  ACTION_CLEANUP_WORKTREE_TITLE,
  actionCleanupDone,
  actionCleanupFailed,
  ACTION_DETACH,
  ACTION_DETACH_SUBAGENT_ARIA,
  ACTION_DETACH_SUBAGENT_TITLE,
  actionDetachDone,
  actionDetachFailed,
  ACTION_RETRY,
  ACTION_RETRY_TITLE,
  ACTION_RESUME_SUBAGENT,
  ACTION_RESUME_SUBAGENT_ARIA,
  ACTION_RESUME_SUBAGENT_TITLE,
  actionResumeSubagentFailed,
  actionResumeSubagentStarted,
  approvalsBadge,
  approvalsTitle,
  BADGE_CACHED,
  cardSubagentHeading,
  executionStatusLabel,
  runCardSelfStateTitle,
  selfAggregateTitle,
  selfStatusLabel,
  subtreeBadge,
  subtreeProgressTitle,
  SUBLINE_FRONTLINE_TAG,
  worktreeBadgeTitle,
} from './copy.ts'

/** First-layer header badge area: left icon + title + badges + subtree stats + total duration suffix. */
export function SubagentCardHeading(props: {
  childConversationId: number
  profileId: string | undefined
  taskTitle: string | undefined
  worktree: { path: string; branch: string } | undefined
  cached: boolean | undefined
  detailError: string | undefined
  effectiveStatus: ExecutionNodeStatus
  selfBadge: SubagentBadge
  descendants: ExecutionAggregate
  approvals: ExecutionApprovalItem[]
  statSegments: string[]
  elapsedText: string | undefined
}): ReactNode {
  const { childConversationId, profileId, taskTitle, worktree, detailError, effectiveStatus, selfBadge, descendants, approvals, statSegments, elapsedText } = props
  const locale = usePluginLocale()
  return (
    <>
      <Icon
        name={detailError !== undefined ? 'x' : effectiveStatus === 'working' ? 'loader' : effectiveStatus === 'error' ? 'x' : 'bot'}
        size={13}
        className={effectiveStatus === 'working' && detailError === undefined ? SPIN : undefined}
      />
      <span className="subagent-live-title" title={taskTitle}>
        <span className="subagent-live-id">{cardSubagentHeading(childConversationId, locale)}</span>
        {profileId !== undefined && profileId !== '' ? (
          <span className="badge badge-neutral">{profileId}</span>
        ) : null}
        {taskTitle !== undefined ? <span className="subagent-live-title-text">{taskTitle}</span> : null}
      </span>
      {worktree !== undefined ? (
        <span className="badge badge-neutral subagent-worktree-badge" title={worktreeBadgeTitle(worktree.path, locale)}>
          <Icon name="git-branch" size={11} />
          {worktree.branch}
        </span>
      ) : null}
      {props.cached === true ? <span className="badge badge-warn">{resolveLocalizedText(BADGE_CACHED, locale)}</span> : null}
      {effectiveStatus !== selfBadge.status ? (
        <>
          <span
            className={`badge ${EXECUTION_BADGE[effectiveStatus] ?? 'badge-neutral'}`}
            title={
              [
                selfAggregateTitle(selfBadge.label, executionStatusLabel(effectiveStatus, locale), locale),
                approvals.length > 0 ? approvalsTitle(approvals.map((item) => item.text), locale) : undefined,
              ]
                .filter(Boolean)
                .join('\n')
            }
          >
            {executionStatusLabel(effectiveStatus, locale)}
          </span>
          <span className="badge badge-neutral" title={runCardSelfStateTitle(selfBadge.label, locale)}>{selfStatusLabel(selfBadge.label, locale)}</span>
        </>
      ) : (
        <span className={`badge ${selfBadge.badge}`}>{selfBadge.label}</span>
      )}
      {descendants.total > 0 ? (
        <span
          className="badge badge-neutral tabular-nums"
          title={subtreeProgressTitle(descendants.done, descendants.total, descendants.running, locale)}
        >
          {subtreeBadge(descendants.done, descendants.total, locale)}
        </span>
      ) : null}
      {descendants.blocked > 0 ? (
        <span
          className="badge badge-warn"
          title={approvalsTitle(approvals.map((item) => item.text), locale)}
        >
          {approvalsBadge(descendants.blocked, locale)}
        </span>
      ) : null}
      {statSegments.length > 0 ? (
        <span className="subagent-live-stats tabular-nums">{statSegments.join(' · ')}</span>
      ) : null}
      {elapsedText !== undefined ? (
        <span className="subagent-live-elapsed tabular-nums">{elapsedText}</span>
      ) : null}
    </>
  )
}

/** Header action bar: abort background task / foreground-sync to background / resume failed task / clean up isolated worktree / reload details (clicks never bubble into whole-card navigation). */
export function SubagentCardActions(props: {
  backgroundRun: WorkflowRunSummary | undefined
  worktree: { path: string; branch: string; id?: string } | undefined
  inspectNodeId: string | undefined
  detailError: string | undefined
  onReload: () => void
  viewer: DetachViewerScope | undefined
  hasExecutionHandle?: boolean
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { backgroundRun, worktree, inspectNodeId, detailError } = props
  const [cleaning, setCleaning] = useState(false)
  const [resuming, setResuming] = useState(false)
  const resumeInFlight = useRef(false)
  return (
    <>
      {backgroundRun?.status === 'running' ? (
        <button
          type="button"
          className="btn btn-xs btn-danger"
          title={t(ACTION_ABORT_BG_TITLE)}
          aria-label={t(ACTION_ABORT_BG_TITLE)}
          onClick={(e) => {
            e.stopPropagation()
            void ctx
              .callAction('abort', { runId: backgroundRun.id })
              .catch((err: unknown) => ctx.notify(actionAbortFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
          }}
        >
          <Icon name="square" size={11} />
          <span className="subagent-action-label">{t(ACTION_ABORT)}</span>
        </button>
      ) : null}
      {backgroundRun !== undefined && canDetachForegroundRun(backgroundRun, props.viewer) ? (
        <button
          type="button"
          className="btn btn-xs"
          title={t(ACTION_DETACH_SUBAGENT_TITLE)}
          aria-label={t(ACTION_DETACH_SUBAGENT_ARIA)}
          onClick={(e) => {
            e.stopPropagation()
            void ctx
              .callAction('detach', { runId: backgroundRun.id })
              .then(() => ctx.notify(actionDetachDone(backgroundRun.id, locale)))
              .catch((err: unknown) => ctx.notify(actionDetachFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
          }}
        >
          <Icon name="arrow-down-to-line" size={11} />
          <span className="subagent-action-label">{t(ACTION_DETACH)}</span>
        </button>
      ) : null}
      {backgroundRun !== undefined && canResumeSubagentRun(backgroundRun, props.hasExecutionHandle ?? true) ? (
        <button
          type="button"
          className="btn btn-xs"
          disabled={resuming}
          title={t(ACTION_RESUME_SUBAGENT_TITLE)}
          aria-label={t(ACTION_RESUME_SUBAGENT_ARIA)}
          onClick={(e) => {
            e.stopPropagation()
            if (resumeInFlight.current) return
            resumeInFlight.current = true
            setResuming(true)
            void ctx
              .callAction('run', {
                resumeFromRunId: backgroundRun.id,
                conversationId: backgroundRun.conversationId,
              })
              .then(() => ctx.notify(actionResumeSubagentStarted(backgroundRun.id, locale)))
              .catch((err: unknown) =>
                ctx.notify(actionResumeSubagentFailed(err instanceof Error ? err.message : String(err), locale), 'error'),
              )
              .finally(() => {
                resumeInFlight.current = false
                setResuming(false)
              })
          }}
        >
          <Icon name="rotate-cw" size={11} className={resuming ? SPIN : undefined} />
          <span className="subagent-action-label">{t(ACTION_RESUME_SUBAGENT)}</span>
        </button>
      ) : null}
      {worktree !== undefined ? (
        <button
          type="button"
          className="btn btn-xs"
          disabled={cleaning}
          title={t(ACTION_CLEANUP_WORKTREE_TITLE)}
          aria-label={t(ACTION_CLEANUP_WORKTREE_ARIA)}
          onClick={(e) => {
            e.stopPropagation()
            if (cleaning) return
            setCleaning(true)
            ctx
              .callAction('cleanup_worktree', buildWorktreeSelector(worktree, inspectNodeId))
              .then(() => ctx.notify(actionCleanupDone(worktree.branch, locale)))
              .catch((err: unknown) => ctx.notify(actionCleanupFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
          <span className="subagent-action-label">{t(ACTION_CLEANUP_WORKTREE)}</span>
        </button>
      ) : null}
      {detailError !== undefined ? (
        <button
          type="button"
          className="btn btn-xs"
          title={t(ACTION_RETRY_TITLE)}
          aria-label={t(ACTION_RETRY_TITLE)}
          onClick={(e) => {
            e.stopPropagation()
            props.onReload()
          }}
        >
          <Icon name="rotate-cw" size={11} />
          <span className="subagent-action-label">{t(ACTION_RETRY)}</span>
        </button>
      ) : null}
    </>
  )
}

/** Second-layer dynamic sublines: current action / thinking / conclusion / error + frontline digest + lossless metadata. */
export function SubagentCardSublines(props: {
  snippet: SubagentHeaderSnippet | undefined
  frontline: ExecutionFrontlineItem[]
  nodeId?: string
  cwd?: string
  createdAt?: number
  runId?: string
}): ReactNode {
  const { snippet, frontline, nodeId, cwd, createdAt, runId } = props
  const locale = usePluginLocale()
  const coord =
    nodeId !== undefined && nodeId !== '' && cwd !== undefined && cwd !== ''
      ? `${nodeId}:${cwd}`
      : cwd !== undefined && cwd !== ''
        ? cwd
        : nodeId !== undefined && nodeId !== ''
          ? nodeId
          : undefined
  const hasMeta = coord !== undefined || (createdAt !== undefined && Number.isFinite(createdAt)) || runId !== undefined
  if (snippet === undefined && frontline.length === 0 && !hasMeta) return undefined
  return (
    <>
      {snippet !== undefined ? (
        <div className={`subagent-live-subline subagent-live-subline-${snippet.kind}`} title={snippet.text}>
          <Icon name="corner-down-right" size={11} />
          {snippet.tag !== undefined ? <span className="subagent-live-subline-tag">{snippet.tag}</span> : null}
          <span className="subagent-live-subline-text">{snippet.text}</span>
        </div>
      ) : null}
      {frontline.length > 0 ? (
        <div
          className="subagent-live-subline execution-frontline"
          title={frontline.map((item) => item.text).join('\n')}
        >
          <Icon name="corner-down-right" size={11} />
          <span className="subagent-live-subline-tag">{resolveLocalizedText(SUBLINE_FRONTLINE_TAG, locale)}</span>
          <span className="subagent-live-subline-text">{frontline.map((item) => item.text).join(' · ')}</span>
        </div>
      ) : null}
      {hasMeta ? (
        <div className="subagent-live-meta-row">
          {coord !== undefined ? <span className="subagent-live-meta-item mono">{coord}</span> : null}
          {createdAt !== undefined && Number.isFinite(createdAt) ? (
            <span className="subagent-live-meta-item tabular-nums">{formatCompactTimestamp(createdAt)}</span>
          ) : null}
          {runId !== undefined ? <span className="subagent-live-meta-item mono">{runId}</span> : null}
        </div>
      ) : null}
    </>
  )
}
