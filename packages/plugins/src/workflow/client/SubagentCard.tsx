/**
 * builtin:workflow plugin subagent live card: SubagentLiveCard (conversation
 * node card). In-card sub-views (header badge area / action bar / subline)
 * live in SubagentCardDetails.tsx; the tool.view entry component
 * SubagentToolView lives in SubagentToolView.tsx; execution tree compact
 * child rows and the external run summary live in their own sibling modules
 * (ExecutionChildrenRows / ExternalRunSummary), re-exported here in the
 * original client module shape (existing consumers import via
 * SubagentCard.tsx).
 * Data is read reactively via @helm/plugin-client shared hooks; actions go
 * through ctx.callAction to POST /api/actions/builtin:workflow/<actionId>,
 * with no host-private dependencies.
 */
import { useMemo } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useConversation, usePluginContext, usePluginLocale, formatDurationMs, resolveLocalizedText } from '@helm/plugin-client'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { ExecutionCard } from './ExecutionCard.tsx'
import { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
import { SubagentStream } from './SubagentStream.tsx'
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
import { buildSubagentStatSegments, buildSubagentStreamLines } from './model-subagent-stream.ts'
import {
  resolveSubagentElapsedMs,
  resolveSubagentHeaderSnippet,
  latestTurnStartedAt,
  resolveSubagentTaskTitle,
  subagentBadge,
} from './model-subagent-card.ts'
import type { DetachViewerScope } from './model-run.ts'
import type { SubagentBadge } from './model-subagent-card.ts'
import { cardOpenChildLabel, cardOpenChildTooltip, SNIPPET_AWAITING_APPROVAL } from './copy.ts'

// Re-exports preserving the legacy module shape (sibling components; see the file header).
export { ExecutionChildrenRows } from './ExecutionChildrenRows.tsx'
export { ExternalRunSummary } from './ExternalRunSummary.tsx'

// ---------------------------------------------------------------------------
// Subagent two-layer capsule card (original SubagentLiveCard semantics;
// unified as the conversation-node card of ExecutionNode)
// ---------------------------------------------------------------------------

export function SubagentLiveCard(props: {
  childConversationId: number
  toolStatus: 'running' | 'done' | 'error' | 'unknown'
  backgroundRun?: WorkflowRunSummary
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  /**
   * Worktree read-only inspection entry (standalone subagent card: one-shot /
   * background / workbench subagent): when provided and a worktree coordinate
   * exists, the inspection section renders; workflow node cards render their
   * own inspection outside, so they do not pass it to avoid duplication.
   * nodeId disambiguates the path when no registration id exists (defaults to
   * the subagent's bound node).
   */
  worktreeInspect?: { parentConversationId: number; nodeId?: string }
  toolSummary?: { prompt?: string; startedAt?: number; durationMs?: number; resultText?: string; isError?: boolean }
  startedAt?: number
  /** Whether this is a cached/history replayed task. */
  cached?: boolean
  /** Authoritative model / token stats of the workflow node; overrides the same-named summary fields to avoid duplication. */
  statsOverride?: { model?: string; tokens?: number }
  /** Expanded state shows the live stream and the bottom call details. */
  expanded?: boolean
  callDetails?: Pick<ToolViewProps, 'input' | 'result' | 'artifactRef'>
  /** Next-level child nodes of the unified execution tree (injected by the workbench / workflow node cards; no deep subtree rendered by default). */
  childNodes?: ExecutionNode[]
  /** Viewer scope (conversation + ownership): foreground-sync run "Move to background" visibility check. */
  viewer?: DetachViewerScope
}) {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { childConversationId, toolStatus, backgroundRun, worktree, toolSummary, startedAt, statsOverride } = props
  const conv = useConversation(childConversationId)
  const summary = conv.summary
  const detail = conv.detail
  const live = conv.live
  const pendingAsk = conv.pendingAsks[0]
  const detailError = conv.loadError

  // Own badge: approval facts win — an AskDoc existing (pendingAsks or
  // pendingAskCount > 0) means awaiting approval, same source as AskDock;
  // when the AskDoc of a Herdr external execution belongs to the native
  // parent conversation, the conversation status may still be working — an
  // open ask must never keep showing running.
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

  // Unified execution tree: descendant subtree aggregation / frontline
  // activity / descendant approvals (distilled from real data only).
  const childNodes = props.childNodes ?? []
  const descendants = useMemo(() => aggregateExecutionNodes(childNodes), [childNodes])
  const frontline = useMemo(() => collectExecutionFrontline(childNodes, 2, locale), [childNodes, locale])
  const approvals = useMemo(() => collectExecutionApprovals(childNodes, 3, locale), [childNodes, locale])
  // Main badge effective status: same source as the execution tree (self +
  // descendant aggregate); while background / deep subtasks are unsettled
  // (blocked / working / error / pending) never show done — the own terminal
  // status is labeled separately.
  const effectiveStatus: ExecutionNodeStatus =
    descendants.total > 0 ? aggregateExecutionStatuses([selfBadge.status, descendants.status]) : selfBadge.status

  // While any self/descendant is still executing or awaiting approval, the
  // total duration keeps growing. The aggregate badge may show error because
  // another descendant failed, so timing must not depend on effectiveStatus
  // alone.
  const elapsedActive =
    selfBadge.status === 'working' || selfBadge.status === 'blocked' ||
    descendants.running > 0 || descendants.blocked > 0
  // SSR first frame starts no clock, keeping rendering deterministic.
  const nowMs = useElapsedNowMs(elapsedActive)
  // Total duration has its own display slot: resolved only from real
  // boundaries (this call / background run; running advances dynamically with
  // the stopwatch, settled freezes at the persisted duration; omitted
  // honestly without a current-turn boundary — the conversation createdAt
  // never fabricates the duration of one resume).
  const fallbackStartedAt = startedAt ?? latestTurnStartedAt(detail?.entries)
  const elapsedMs = resolveSubagentElapsedMs({
    ...(backgroundRun !== undefined ? { backgroundRun } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(fallbackStartedAt !== undefined ? { startedAt: fallbackStartedAt } : {}),
    nowMs,
    status: elapsedActive ? 'working' : effectiveStatus,
  })
  const elapsedText = elapsedMs !== undefined ? formatDurationMs(elapsedMs) : undefined

  // Isolated worktree: the explicit prop wins, then the first worktree of the
  // background run's nodes.
  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree
  // Disambiguation coordinate shared by inspect/cleanup: caller-explicit
  // nodeId > the subagent's bound node.
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
