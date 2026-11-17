/**
 * builtin:workflow subagent tool call timeline one-line renderer:
 * - structurally identical to the host TimelineRows.tsx 26px `.trace-row`; no
 *   big cards stacked in the main timeline;
 * - resume dedup via `isLatestSubagentCallForTarget`: only the latest call
 *   reacts to in-flight state and `useToolActivity`; historical calls
 *   superseded by a later `resume` keep their own terminal state and are
 *   marked "Resumed below";
 * - AskDoc pending-approval facts take priority over `working`, so a
 *   subagent blocked on authorization is never mislabeled running;
 * - the ~34ms dispatch confirmation of an in-flight background subagent
 *   handle is never presented as the subagent's total duration.
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  formatDurationMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
  useToolActivity,
} from '@helm/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import {
  cleanInlineMarkdown,
  isLatestSubagentCallForTarget,
  latestTurnStartedAt,
  parentToolSummaryOf,
  parseSubagentExecutionInfo,
  resolveRunElapsedMs,
  resolveSubagentConversationId,
  resolveSubagentElapsedMs,
  resolveSubagentExecutionMeta,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './models.ts'
import type { SubagentBadge } from './models.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'
import {
  SNIPPET_AWAITING_APPROVAL,
  TRACE_COLLAPSE_DETAILS,
  TRACE_EXPAND_DETAILS,
  TRACE_EXTERNAL_TOOL_NAME,
  TRACE_RESUMED_BELOW,
  TRACE_SUBAGENT_CALL,
  TRACE_SUBAGENT_TOOL_NAME,
  traceSubagentWithId,
  traceOpenChildLabel,
  traceOpenWorkbenchRunLabel,
} from './copy.ts'

export function SubagentToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversations = useConversations()
  const viewerConversationId = props.conversationId ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    viewerConversationId !== undefined ? { conversationId: viewerConversationId } : undefined,
  )
  const parentToolSummary = useMemo(() => parentToolSummaryOf(props), [props])
  const resultText = typeof props.result === 'string' ? props.result : undefined
  const runs = runsDoc?.runs ?? []

  const execInfo = useMemo(() => parseSubagentExecutionInfo(resultText), [resultText])
  const execMeta = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentExecutionMeta({ callId: props.callId, result: props.result }, viewerConversationId, runs)
        : undefined,
    [props.callId, props.result, viewerConversationId, runs],
  )
  const childId = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentConversationId(
            { callId: props.callId, input: props.input, result: props.result },
            viewerConversationId,
            conversations,
          )
        : undefined,
    [props.callId, props.input, props.result, viewerConversationId, conversations],
  )
  const childConv = useConversation(childId)
  const childSummary = useMemo(
    () => (childId !== undefined ? (conversations.find((c) => c.id === childId) ?? childConv.summary) : undefined),
    [childId, conversations, childConv.summary],
  )

  const backgroundRun = useMemo(() => {
    if (execMeta?.run !== undefined) return execMeta.run
    if (execInfo?.runId !== undefined) return runs.find((r) => r.id === execInfo.runId)
    return undefined
  }, [execMeta?.run, execInfo?.runId, runs])

  const isLatest = useMemo(
    () =>
      viewerConversationId === undefined
        ? true
        : isLatestSubagentCallForTarget(
            {
              callId: props.callId,
              input: props.input,
              result: props.result,
              siblingCalls: props.siblingCalls,
              conversationId: viewerConversationId,
            },
            childId,
            conversations,
            execMeta?.executionId ?? execInfo?.executionId,
          ),
    [
      props.callId,
      props.input,
      props.result,
      props.siblingCalls,
      viewerConversationId,
      childId,
      conversations,
      execMeta?.executionId,
      execInfo?.executionId,
    ],
  )

  const isBgHandle = execInfo?.background === true && execInfo.runId !== undefined
  const handleStatus = execInfo?.status
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const hasPendingAsk =
    isLatest && (childConv.pendingAsks.length > 0 || (childSummary?.pendingAskCount ?? 0) > 0)

  const badge: SubagentBadge = hasPendingAsk
    ? { status: 'blocked', label: resolveLocalizedText(SNIPPET_AWAITING_APPROVAL, locale), badge: 'badge-warn' }
    : isLatest
      ? subagentBadge(childSummary?.status, props.status, backgroundRun, {
          isBackgroundHandle: isBgHandle,
          handleStatus,
        }, locale)
      : subagentBadge(undefined, props.status, undefined, undefined, locale)

  const isWorking =
    isLatest &&
    !hasPendingAsk &&
    (props.status === 'running' ||
      childSummary?.status === 'working' ||
      backgroundRun?.status === 'running' ||
      (isBgHandle && backgroundRun === undefined && handleStatus === 'running'))

  const isActiveForActivity =
    isLatest &&
    (isWorking ||
      hasPendingAsk ||
      childSummary?.status === 'blocked' ||
      (isBgHandle && backgroundRun === undefined && handleStatus === 'blocked'))

  useToolActivity(props.callId, isActiveForActivity)
  const nowMs = useElapsedNowMs(isWorking || hasPendingAsk)

  const rawPrompt =
    parentToolSummary.prompt ??
    (typeof props.input === 'object' &&
    props.input !== null &&
    !Array.isArray(props.input) &&
    typeof (props.input as Record<string, unknown>)['task'] === 'string'
      ? ((props.input as Record<string, unknown>)['task'] as string)
      : undefined)

  const taskTitle =
    childId !== undefined
      ? resolveSubagentTaskTitle(childSummary, childId, parentToolSummary, backgroundRun, childConv.detail?.entries)
      : cleanInlineMarkdown(rawPrompt ?? backgroundRun?.name ?? execMeta?.executionId ?? resolveLocalizedText(TRACE_SUBAGENT_CALL, locale))

  const fallbackStartedAt = parentToolSummary.startedAt ?? latestTurnStartedAt(childConv.detail?.entries)
  const elapsedMs = useMemo(() => {
    if (!isLatest) {
      return isBgHandle ? undefined : props.durationMs
    }
    if (childId !== undefined) {
      return resolveSubagentElapsedMs({
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        toolSummary: parentToolSummary,
        ...(fallbackStartedAt !== undefined ? { startedAt: fallbackStartedAt } : {}),
        nowMs,
        status: badge.status,
      })
    }
    if (backgroundRun !== undefined) {
      return resolveRunElapsedMs(backgroundRun, nowMs)
    }
    if (isBgHandle) return undefined
    if (props.status === 'running' && props.startedAt !== undefined && nowMs !== undefined) {
      return Math.max(0, nowMs - props.startedAt)
    }
    return props.durationMs
  }, [
    isLatest,
    childId,
    backgroundRun,
    parentToolSummary,
    fallbackStartedAt,
    nowMs,
    badge.status,
    isBgHandle,
    props.status,
    props.startedAt,
    props.durationMs,
  ])

  const isError =
    badge.status === 'error' ||
    props.status === 'error' ||
    (isLatest && (backgroundRun?.status === 'failed' || backgroundRun?.status === 'aborted' || childSummary?.status === 'error'))

  const targetWorkbenchRunId = backgroundRun?.id ?? execInfo?.runId
  const canOpenChildDrawer = childId !== undefined
  const canOpenWorkbenchRun = !canOpenChildDrawer && targetWorkbenchRunId !== undefined
  const hasErrorText = props.status === 'error' && resultText !== undefined && resultText.trim() !== ''

  const baseTitle = taskTitle ?? resolveLocalizedText(TRACE_SUBAGENT_CALL, locale)
  const displaySummary =
    hasErrorText && resultText !== undefined
      ? `${baseTitle} · ${cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')}`
      : execMeta?.nodeId !== undefined
        ? `${execMeta.nodeId} · ${baseTitle}`
        : baseTitle

  const handleActivate = (): void => {
    if (canOpenChildDrawer && childId !== undefined) {
      ctx.openConversationDrawer(childId)
      return
    }
    if (canOpenWorkbenchRun && targetWorkbenchRunId !== undefined) {
      requestWorkbenchRunFocus(viewerConversationId, targetWorkbenchRunId)
      ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
      return
    }
    setDetailsOpen((prev) => !prev)
  }

  const labelTarget = canOpenChildDrawer && childId !== undefined
    ? traceOpenChildLabel(childId, locale)
    : canOpenWorkbenchRun && targetWorkbenchRunId !== undefined
      ? traceOpenWorkbenchRunLabel(targetWorkbenchRunId, locale)
      : resolveLocalizedText(detailsOpen ? TRACE_COLLAPSE_DETAILS : TRACE_EXPAND_DETAILS, locale)

  const toolName = childId !== undefined
    ? traceSubagentWithId(childId, locale)
    : execMeta?.executionId !== undefined
      ? resolveLocalizedText(TRACE_EXTERNAL_TOOL_NAME, locale)
      : resolveLocalizedText(TRACE_SUBAGENT_TOOL_NAME, locale)
  const profileBadge =
    childId !== undefined && childSummary?.profileId !== undefined && childSummary.profileId !== ''
      ? `@${childSummary.profileId}`
      : undefined
  const worktreeBranch = execMeta?.worktree?.branch

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`${toolName} ${displaySummary} — ${labelTarget}`}
        aria-expanded={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsOpen : undefined}
        aria-controls={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsId : undefined}
        onClick={handleActivate}
      >
        <span className="trace-row-left">
          <Icon
            name={isError ? 'alert-circle' : hasPendingAsk ? 'clock' : isWorking ? 'loader' : 'bot'}
            size={12}
            className={isWorking ? SPIN : undefined}
          />
          <span className="trace-tool-name">{toolName}</span>
          {profileBadge !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge">{profileBadge}</span>
          ) : null}
          <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={displaySummary}>
            {displaySummary}
          </span>
        </span>
        <span className="trace-row-right workflow-trace-right">
          {!isLatest ? (
            <span className="badge badge-neutral workflow-trace-badge">{resolveLocalizedText(TRACE_RESUMED_BELOW, locale)}</span>
          ) : null}
          {worktreeBranch !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge" title={execMeta?.worktree?.path}>
              <Icon name="git-branch" size={10} />
              {worktreeBranch}
            </span>
          ) : null}
          <span className={`badge workflow-trace-badge ${badge.badge}`}>{badge.label}</span>
          {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
          <Icon
            name={canOpenChildDrawer ? 'external-link' : canOpenWorkbenchRun ? 'chevron-right' : detailsOpen ? 'chevron-down' : 'chevron-right'}
            size={11}
          />
        </span>
      </button>
      {!canOpenChildDrawer && !canOpenWorkbenchRun ? (
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <ToolCallDetailsInline input={props.input} result={props.result} artifactRef={props.artifactRef} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
