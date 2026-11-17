/**
 * builtin:workflow subagent tool call timeline one-line renderer:
 * - structurally identical to the host TimelineRows.tsx 26px `.trace-row`;
 * - reads `props.structuredOutput` (and `call.structuredOutput` on siblingCalls)
 *   plus `parentToolCallId` directly (zero regex or footer scraping);
 * - calls `useConversation(childId, { includeDetail: false })` and derives
 *   title/elapsed from `childSummary`, `parentToolSummary`, and `backgroundRun`
 *   (zero N+1 `GET /api/conversations/:id` detail fetches!).
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
  useToolActivity,
} from '@helm/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import {
  cleanInlineMarkdown,
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
  parseSubagentExecutionInfo,
  resolveExternalSubagentTaskTitle,
  resolveRunElapsedMs,
  resolveSubagentConversationId,
  resolveSubagentElapsedMs,
  resolveSubagentExecutionMeta,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './models.ts'
import type { SubagentBadge } from './models.ts'
import { executionLightStatus } from './model-execution-status.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'
import {
  executionStatusLabel,
  SNIPPET_AWAITING_APPROVAL,
  TRACE_COLLAPSE_DETAILS,
  TRACE_EXPAND_DETAILS,
  TRACE_EXTERNAL_TOOL_NAME,
  TRACE_RESUMED_BELOW,
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

  const execInfo = useMemo(
    () => parseSubagentExecutionInfo(props.structuredOutput, resultText),
    [props.structuredOutput, resultText],
  )
  const execMeta = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentExecutionMeta(
            { callId: props.callId, structuredOutput: props.structuredOutput, result: props.result },
            viewerConversationId,
            runs,
          )
        : undefined,
    [props.callId, props.structuredOutput, props.result, viewerConversationId, runs],
  )
  const childId = useMemo(
    () =>
      viewerConversationId !== undefined
        ? resolveSubagentConversationId(
            {
              callId: props.callId,
              input: props.input,
              structuredOutput: props.structuredOutput,
              result: props.result,
            },
            viewerConversationId,
            conversations,
          )
        : undefined,
    [props.callId, props.input, props.structuredOutput, props.result, viewerConversationId, conversations],
  )
  const childConv = useConversation(childId, { includeDetail: false })
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
              structuredOutput: props.structuredOutput,
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
      props.structuredOutput,
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

  // 主状态灯：aborted 后台句柄保留专用 aborted 语义；其余沿用徽章标签（含后台运行中等细分文案）作为可访问名称。
  const badgeLightStatus = executionLightStatus(badge.status, backgroundRun)
  const badgeLightLabel = badgeLightStatus === 'aborted' ? executionStatusLabel('aborted', locale) : badge.label
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
      : resolveExternalSubagentTaskTitle(parentToolSummary, rawPrompt, backgroundRun)

  const fallbackStartedAt = parentToolSummary.startedAt
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

  const errorFirstLine =
    hasErrorText && resultText !== undefined
      ? cleanInlineMarkdown(resultText.split(/\r?\n/, 1)[0] ?? '')
      : isError && backgroundRun?.error !== undefined && backgroundRun.error.trim() !== ''
        ? cleanInlineMarkdown(backgroundRun.error.split(/\r?\n/, 1)[0] ?? '')
        : undefined
  const summaryParts = [execMeta?.nodeId, errorFirstLine].filter(
    (part): part is string => part !== undefined && part !== '',
  )
  const displaySummary = summaryParts.length > 0 ? summaryParts.join(' · ') : undefined

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

  const primaryName =
    childId !== undefined
      ? (taskTitle ?? traceSubagentWithId(childId, locale))
      : (taskTitle ??
          (execMeta?.executionId !== undefined
            ? resolveLocalizedText(TRACE_EXTERNAL_TOOL_NAME, locale)
            : resolveLocalizedText(TRACE_SUBAGENT_TOOL_NAME, locale)))
  const idTag =
    childId !== undefined
      ? (taskTitle !== undefined ? `#${childId}` : undefined)
      : execMeta?.executionId
  const roleBadge =
    childId === undefined && taskTitle !== undefined
      ? resolveLocalizedText(
          execMeta?.executionId !== undefined ? TRACE_EXTERNAL_TOOL_NAME : TRACE_SUBAGENT_TOOL_NAME,
          locale,
        )
      : undefined
  const profileBadge =
    childId !== undefined && childSummary?.profileId !== undefined && childSummary.profileId !== ''
      ? `@${childSummary.profileId}`
      : undefined
  const worktreeBranch = execMeta?.worktree?.branch
  const ariaTitle = [primaryName, idTag, displaySummary].filter(Boolean).join(' ')

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row workflow-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`${ariaTitle} — ${labelTarget}`}
        aria-expanded={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsOpen : undefined}
        aria-controls={!canOpenChildDrawer && !canOpenWorkbenchRun ? detailsId : undefined}
        onClick={handleActivate}
      >
        <span className="trace-row-left">
          <Icon name="bot" size={12} />
          <span className="trace-tool-name workflow-trace-name" title={primaryName}>{primaryName}</span>
          {idTag !== undefined ? (
            <span className="workflow-trace-id tabular-nums">{idTag}</span>
          ) : null}
          {roleBadge !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge">{roleBadge}</span>
          ) : null}
          {profileBadge !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge">{profileBadge}</span>
          ) : null}
          {displaySummary !== undefined ? (
            <span className={`trace-tool-summary${isError ? ' workflow-trace-error' : ''}`} title={displaySummary}>
              {displaySummary}
            </span>
          ) : null}
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
          <StatusLight status={badgeLightStatus} label={badgeLightLabel} />
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
