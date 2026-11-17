/**
 * builtin:workflow plugin subagent live card: SubagentLiveCard (conversation
 * node card). Calls `useConversation(childConversationId, { includeDetail: props.expanded === true })`
 * so `GET /api/conversations/:id` is only fired when expanded to view the live stream.
 */
import { useMemo } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useConversation, usePluginContext, usePluginLocale, formatDurationMs, resolveLocalizedText } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { ExecutionCard } from './ExecutionCard.tsx'
import { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
import { Icon } from './WorkflowIcon.tsx'
import {
  SubagentCardActions,
  SubagentCardHeading,
  SubagentCardSublines,
} from './SubagentCardDetails.tsx'
import { useElapsedNowMs, useStreamFollow } from './hooks.ts'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { aggregateExecutionNodes } from './model-execution-tree.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { aggregateExecutionStatuses } from './model-execution-status.ts'
import type { ExecutionNodeStatus } from './model-execution-status.ts'
import { collectExecutionApprovals, collectExecutionFrontline } from './model-execution-view.ts'
import { buildSubagentStatSegments, buildSubagentStreamLines, type SubagentStreamLine } from './model-subagent-stream.ts'
import { toolResultPreviewTruncated } from './model-format.ts'
import {
  resolveSubagentElapsedMs,
  resolveSubagentHeaderSnippet,
  latestTurnStartedAt,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './model-subagent-card.ts'
import type { DetachViewerScope } from './model-run.ts'
import type { SubagentBadge } from './model-subagent-card.ts'
import {
  cardOpenChildLabel,
  cardOpenChildTooltip,
  SNIPPET_AWAITING_APPROVAL,
  SPIN,
  STREAM_PROMPT_TAG,
  STREAM_REPLY_TAG,
  STREAM_THINKING_TAG,
  STREAM_TRUNCATED,
  streamPreviewSeparator,
} from './copy.ts'

export { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
export { ExternalRunSummary } from './ExternalRunSummary.tsx'

function SubagentStream(props: {
  lines: SubagentStreamLine[]
  followRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
}): ReactNode {
  const { lines, followRef, onScroll } = props
  const locale = usePluginLocale()
  return (
    <div className="subagent-live-stream" ref={followRef} onScroll={onScroll}>
      {lines.slice(-30).map((line) =>
        line.kind === 'prompt' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-prompt">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_PROMPT_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'thinking' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-thinking">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_THINKING_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'tool' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-tool">
            <Icon name={line.status === 'running' ? 'loader' : line.isError ? 'x' : 'check'} size={11} className={line.status === 'running' ? SPIN : undefined} />
            <span className="subagent-stream-body">
              {line.toolName} {line.summary}{line.resultPreview !== undefined ? `${streamPreviewSeparator(locale)}${line.resultPreview}` : ''}
              {toolResultPreviewTruncated(line.resultPreview) ? <span className="subagent-stream-truncated">{resolveLocalizedText(STREAM_TRUNCATED, locale)}</span> : null}
            </span>
          </div>
        ) : (
          <div key={line.key} className="subagent-stream-line">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_REPLY_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ),
      )}
    </div>
  )
}

export function SubagentLiveCard(props: {
  childConversationId: number
  toolStatus: 'running' | 'done' | 'error' | 'unknown'
  backgroundRun?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  worktreeInspect?: { parentConversationId: number; nodeId?: string }
  toolSummary?: {
    prompt?: string
    startedAt?: number
    durationMs?: number
    resultText?: string
    structuredOutput?: unknown
    isError?: boolean
  }
  startedAt?: number
  cached?: boolean
  statsOverride?: { model?: string; tokens?: number }
  expanded?: boolean
  callDetails?: Pick<ToolViewProps, 'input' | 'result' | 'artifactRef'>
  childNodes?: ExecutionNode[]
  viewer?: DetachViewerScope
}) {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { childConversationId, toolStatus, backgroundRun, worktree, toolSummary, startedAt, statsOverride } = props
  const conv = useConversation(childConversationId, { includeDetail: props.expanded === true })
  const summary = conv.summary
  const detail = conv.detail
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const detailError = conv.loadError

  const selfBadge: SubagentBadge =
    pendingAsk !== undefined || (summary?.pendingAskCount ?? 0) > 0
      ? { status: 'blocked', label: resolveLocalizedText(SNIPPET_AWAITING_APPROVAL, locale), badge: 'badge-warn' }
      : subagentBadge(summary?.status, toolStatus, backgroundRun, undefined, locale)
  const taskTitle = resolveSubagentTaskTitle(summary, childConversationId, toolSummary, backgroundRun, detail?.entries)
  const statSegments = useMemo(
    () =>
      buildSubagentStatSegments(
        {
          ...(summary !== undefined ? { summary } : {}),
          ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
          ...(live !== undefined ? { live } : {}),
          ...(backgroundRun !== undefined ? { backgroundRun } : {}),
          ...(statsOverride?.model !== undefined ? { modelOverride: statsOverride.model } : {}),
          ...(statsOverride?.tokens !== undefined ? { tokensOverride: statsOverride.tokens } : {}),
        },
        locale,
      ),
    [summary, detail?.entries, live, backgroundRun, statsOverride?.model, statsOverride?.tokens, locale],
  )
  const snippet = useMemo(
    () =>
      resolveSubagentHeaderSnippet(
        {
          badgeStatus: selfBadge.status,
          ...(summary !== undefined ? { summary } : {}),
          ...(live !== undefined ? { live } : {}),
          ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
          ...(pendingAsk !== undefined ? { pendingAsk } : {}),
          ...(backgroundRun !== undefined ? { backgroundRun } : {}),
          ...(toolSummary !== undefined ? { toolSummary } : {}),
          ...(detailError !== undefined ? { detailError } : {}),
        },
        locale,
      ),
    [selfBadge.status, summary, live, detail?.entries, pendingAsk, backgroundRun, toolSummary, detailError, locale],
  )

  const childNodes = props.childNodes ?? []
  const descendants = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const frontline = useMemo(() => collectExecutionFrontline(childNodes, 2, locale), [childNodes, locale])
  const approvals = useMemo(() => collectExecutionApprovals(childNodes, 3, locale), [childNodes, locale])
  const effectiveStatus: ExecutionNodeStatus =
    descendants.total > 0 ? aggregateExecutionStatuses([selfBadge.status, descendants.status]) : selfBadge.status

  const elapsedActive =
    selfBadge.status === 'working' || selfBadge.status === 'blocked' ||
    descendants.running > 0 || descendants.blocked > 0
  const nowMs = useElapsedNowMs(elapsedActive)
  const fallbackStartedAt = startedAt ?? latestTurnStartedAt(detail?.entries)
  const elapsedMs = resolveSubagentElapsedMs({
    ...(backgroundRun !== undefined ? { backgroundRun } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(fallbackStartedAt !== undefined ? { startedAt: fallbackStartedAt } : {}),
    nowMs,
    status: elapsedActive ? 'working' : effectiveStatus,
  })
  const elapsedText = elapsedMs !== undefined ? formatDurationMs(elapsedMs) : undefined

  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  const inspectNodeId =
    props.worktreeInspect?.nodeId ?? (summary?.nodeId !== undefined && summary.nodeId !== '' ? summary.nodeId : undefined)
  const streamLines = useMemo(
    () => (props.expanded === true && detail?.entries !== undefined ? buildSubagentStreamLines(detail.entries, live, selfBadge.status === 'working') : []),
    [props.expanded, detail?.entries, live, selfBadge.status],
  )

  const stream = useStreamFollow(streamLines)

  const variantClass = [
    effectiveStatus === 'blocked' ? 'subagent-live-card-warn' : undefined,
    effectiveStatus === 'error' || detailError !== undefined ? 'subagent-live-card-error' : undefined,
    props.expanded === true ? 'subagent-live-card-expanded' : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  const openChild = (): void => {
    ctx.openConversationDrawer(childConversationId)
  }

  return (
    <ExecutionCard
      variantClass={variantClass}
      activate={{
        label: cardOpenChildLabel(childConversationId, locale),
        tooltip: [taskTitle, summary?.profileId, wt?.branch, [...statSegments, elapsedText].filter(Boolean).join(' · '), cardOpenChildTooltip(locale)].filter(Boolean).join('\n'),
        open: openChild,
      }}
      heading={
        <SubagentCardHeading
          childConversationId={childConversationId}
          profileId={summary?.profileId}
          taskTitle={taskTitle}
          worktree={wt}
          cached={props.cached}
          detailError={detailError}
          effectiveStatus={effectiveStatus}
          selfBadge={selfBadge}
          abortedRun={backgroundRun?.status === 'aborted'}
          descendants={descendants}
          approvals={approvals}
          statSegments={statSegments}
          elapsedText={elapsedText}
        />
      }
      actions={
        <SubagentCardActions
          backgroundRun={backgroundRun}
          hasExecutionHandle={Number.isSafeInteger(childConversationId) && childConversationId > 0}
          worktree={wt}
          inspectNodeId={inspectNodeId}
          detailError={detailError}
          onReload={() => conv.reload()}
          viewer={props.viewer}
        />
      }
      snippet={
        <SubagentCardSublines
          snippet={snippet}
          frontline={frontline}
          nodeId={summary?.nodeId}
          cwd={summary?.cwd}
          createdAt={backgroundRun?.createdAt ?? summary?.createdAt}
          runId={backgroundRun?.id}
        />
      }
    >
      {childNodes.length > 0 ? <ExecutionChildrenRows nodes={childNodes} /> : null}
      {props.expanded === true && streamLines.length > 0 ? (
        <SubagentStream lines={streamLines} followRef={stream.ref} onScroll={stream.onScroll} />
      ) : null}
      {props.expanded === true &&
      (props.callDetails !== undefined
        ? props.callDetails.input !== undefined || props.callDetails.result !== undefined || props.callDetails.artifactRef !== undefined
        : toolSummary?.prompt !== undefined || toolSummary?.resultText !== undefined) ? (
        <ToolCallDetailsInline
          input={props.callDetails !== undefined ? props.callDetails.input : toolSummary?.prompt}
          result={props.callDetails !== undefined ? props.callDetails.result : toolSummary?.resultText}
          artifactRef={props.callDetails?.artifactRef}
        />
      ) : null}
      {props.worktreeInspect !== undefined && wt !== undefined ? (
        <div className="subagent-inspect-slot" onClick={(e) => e.stopPropagation()}>
          <WorktreeInspectSection
            worktree={{
              path: wt.path,
              branch: wt.branch,
              ...(wt.id !== undefined && wt.id !== '' ? { id: wt.id } : {}),
            }}
            nodeId={inspectNodeId}
            baseCommit={wt.baseCommit}
            taskLabel={taskTitle}
            parentConversationId={props.worktreeInspect.parentConversationId}
          />
        </div>
      ) : null}
    </ExecutionCard>
  )
}
