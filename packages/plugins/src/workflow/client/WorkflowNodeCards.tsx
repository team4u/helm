/**
 * builtin:workflow plugin in-run node card family (consumed by
 * WorkflowRunCardBody):
 * - WorkflowNodeCard: single-node dispatch (subagent nodes as unified whole
 *   cards / action nodes as flat two-layer cards);
 * - WorkflowSubagentNodeCard: subagent node rendered directly as a unified
 *   whole card (no accordion shell);
 * - WorkflowExecutionNodeCard: nodes without a native subagent (action /
 *   external run) as flat two-layer cards;
 * - WorkflowNodeDetail: structured details of conversation-less nodes.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkflowNodeState } from '../../contracts.js'
import { formatCompactTimestamp, formatDurationMs, resolveLocalizedText, usePluginContext, usePluginLocale } from '@helm/plugin-client'
import { useElapsedNowMs } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { SubagentLiveCard } from './SubagentCard.tsx'
import { WorktreeInspectSection } from './WorktreeInspectSection.tsx'
import { buildWorktreeSelector } from './model-worktree.ts'
import { stringifyPretty } from './model-format.ts'
import {
  formatWorkflowNodeStats,
  hasNodeExtraDetail,
  resolveNodeElapsedMs,
  resolveNodeSummaryText,
} from './model-run.ts'
import {
  ACTION_CLEANUP_WORKTREE,
  actionCleanupDone,
  actionCleanupFailed,
  BADGE_CACHED,
  NODE_BADGE,
  NODE_BADGE_ACTION,
  NODE_BADGE_EXTERNAL,
  NODE_BADGE_SUBAGENT,
  nodeAttemptBadge,
  NODE_GATE_FAILED,
  NODE_GATE_PASSED,
  NODE_KV_BACKEND,
  NODE_KV_CWD,
  NODE_KV_DURATION,
  NODE_KV_EXTERNAL,
  NODE_KV_MODEL,
  NODE_KV_NODE,
  NODE_KV_STARTED_AT,
  NODE_KV_TOKENS,
  NODE_KV_WORKTREE,
  NODE_SECTION_PROMPT,
  nodeStatusLabel,
  NODE_TAG_ERROR,
  NODE_TAG_OUTPUT,
  SPIN,
  worktreeBadgeTitle,
} from './copy.ts'
import type { ExecutionNode } from './model-execution-tree.ts'

/** Workflow subagent node: rendered directly as a unified whole card (no accordion shell). */
function WorkflowSubagentNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
  const outputText = typeof node.output === 'string' ? node.output : undefined
  const locale = usePluginLocale()
  const t = resolveLocalizedText
  return (
    <div className="workflow-subagent-node-card">
      <SubagentLiveCard
        childConversationId={node.conversationId!}
        toolStatus={node.status === 'running' ? 'running' : node.status === 'failed' ? 'error' : node.status === 'done' ? 'done' : 'unknown'}
        startedAt={node.startedAt}
        worktree={node.worktree}
        cached={node.cached}
        statsOverride={{
          ...(node.model !== undefined ? { model: node.model } : {}),
          ...(node.tokens !== undefined ? { tokens: node.tokens } : {}),
        }}
        toolSummary={{
          prompt: node.label,
          durationMs: node.durationMs,
          isError: node.status === 'failed',
          resultText: outputText,
        }}
        expanded={false}
        childNodes={childNodes}
      />
      {node.gate !== undefined ? (
        <div className="workflow-node-gate-extra">
          <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>
            {t(node.gate.ok ? NODE_GATE_PASSED : NODE_GATE_FAILED, locale)}
          </span>
          {node.gateCommand !== undefined ? <code className="mono workflow-node-gate-cmd">{node.gateCommand}</code> : null}
          {node.gate.output !== '' ? (
            <pre className={`code-block-pre workflow-node-pre${node.gate.ok ? '' : ' workflow-node-pre-err'}`}>
              <code>{node.gate.output}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {node.error !== undefined ? <p className="callout callout--error">{node.error}</p> : null}
      {node.worktree !== undefined ? (
        <WorktreeInspectSection
          worktree={{
            path: node.worktree.path,
            branch: node.worktree.branch,
            ...(node.worktree.id !== undefined ? { id: node.worktree.id } : {}),
          }}
          nodeId={node.nodeId}
          baseCommit={node.worktree.baseCommit}
          taskLabel={node.label}
          parentConversationId={props.runConversationId}
        />
      ) : null}
    </div>
  )
}

/** Nodes without a native subagent: actions and external runs shown honestly, never fabricating a navigable subagent. */
function WorkflowExecutionNodeCard(props: { node: WorkflowNodeState; runConversationId: number }): ReactNode {
  const { node } = props
  const locale = usePluginLocale()
  const summaryText = resolveNodeSummaryText(node, undefined, undefined, undefined, locale)
  const nodeStats = useMemo(() => formatWorkflowNodeStats(node), [node])
  const isErr = node.status === 'failed'
  // Total duration: running advances dynamically from startedAt with the
  // stopwatch (SSR first frame has no clock, omitted honestly); settled
  // freezes at the persisted durationMs; no fabricated values without a real
  // boundary.
  const nowMs = useElapsedNowMs(node.status === 'running')
  const elapsedMs = resolveNodeElapsedMs(node, nowMs)
  return (
    <div className={`subagent-live-card ${node.kind === 'action' ? 'workflow-action-card' : 'workflow-agent-card'}${isErr ? ' subagent-live-card-error' : ''}`}>
      <div className="subagent-live-header">
        <div className="subagent-live-trigger" style={{ cursor: 'default' }}>
          <Icon
            name={node.status === 'running' ? 'loader' : node.status === 'failed' ? 'x' : node.status === 'done' ? 'check' : node.status === 'skipped' ? 'chevron-right' : 'clock'}
            size={13}
            className={node.status === 'running' ? SPIN : undefined}
          />
          <span className="badge badge-neutral">{node.kind === 'action' ? resolveLocalizedText(NODE_BADGE_ACTION, locale) : node.executionId !== undefined ? resolveLocalizedText(NODE_BADGE_EXTERNAL, locale) : resolveLocalizedText(NODE_BADGE_SUBAGENT, locale)}</span>
          <span className="subagent-live-title" title={node.label ?? node.id}>
            <span className="subagent-live-title-text">{node.label ?? node.id}</span>
          </span>
          {node.worktree !== undefined ? (
            <span className="badge badge-neutral subagent-worktree-badge" title={worktreeBadgeTitle(node.worktree.path, locale)}>
              <Icon name="git-branch" size={11} />
              {node.worktree.branch}
            </span>
          ) : null}
          {node.cached === true ? <span className="badge badge-warn">{resolveLocalizedText(BADGE_CACHED, locale)}</span> : null}
          <span className={`badge ${NODE_BADGE[node.status] ?? 'badge-neutral'}`}>
            {nodeStatusLabel(node.status, locale)}
          </span>
          {node.attempt !== undefined && node.attempt > 1 ? (
            <span className="badge badge-neutral">{nodeAttemptBadge(node.attempt, locale)}</span>
          ) : null}
          {node.gate !== undefined ? (
            <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>
              {resolveLocalizedText(node.gate.ok ? NODE_GATE_PASSED : NODE_GATE_FAILED, locale)}
            </span>
          ) : null}
          {nodeStats.length > 0 ? (
            <span className="subagent-live-stats workflow-node-stats tabular-nums">{nodeStats.join(' · ')}</span>
          ) : null}
          {elapsedMs !== undefined ? (
            <span className="subagent-live-elapsed tabular-nums">{formatDurationMs(elapsedMs)}</span>
          ) : null}
        </div>
      </div>
      {summaryText.text !== undefined ? (
        <div className={`subagent-live-subline${summaryText.isError ? ' subagent-live-subline-error' : ''}`}>
          <Icon name="corner-down-right" size={11} />
          <span className="subagent-live-subline-tag">{resolveLocalizedText(summaryText.isError ? NODE_TAG_ERROR : NODE_TAG_OUTPUT, locale)}</span>
          <span className="subagent-live-subline-text" title={summaryText.text}>{summaryText.text}</span>
        </div>
      ) : null}
      {hasNodeExtraDetail(node) ? <WorkflowNodeDetail node={node} /> : null}
      {node.worktree !== undefined ? (
        <WorktreeInspectSection
          worktree={{
            path: node.worktree.path,
            branch: node.worktree.branch,
            ...(node.worktree.id !== undefined ? { id: node.worktree.id } : {}),
          }}
          nodeId={node.nodeId}
          baseCommit={node.worktree.baseCommit}
          taskLabel={node.label}
          parentConversationId={props.runConversationId}
        />
      ) : null}
    </div>
  )
}

/** Single node card: subagent nodes render unified whole cards; action nodes render flat two-layer cards. No accordion anywhere. */
export function WorkflowNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
  if (node.conversationId !== undefined) {
    return <WorkflowSubagentNodeCard node={node} childNodes={childNodes} runConversationId={props.runConversationId} />
  }
  return <WorkflowExecutionNodeCard node={node} runConversationId={props.runConversationId} />
}

/** Structured details of nodes without a native subagent. */
function WorkflowNodeDetail({ node }: { node: WorkflowNodeState }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [cleaning, setCleaning] = useState(false)
  const rows: Array<[string, string, boolean]> = []
  if (node.startedAt !== undefined) rows.push([resolveLocalizedText(NODE_KV_STARTED_AT, locale), formatCompactTimestamp(node.startedAt), true])
  if (node.agentType !== undefined) rows.push([resolveLocalizedText(NODE_KV_BACKEND, locale), node.agentType, false])
  if (node.executionId !== undefined) rows.push([resolveLocalizedText(NODE_KV_EXTERNAL, locale), node.executionId, false])
  if (node.nodeId !== undefined) rows.push([resolveLocalizedText(NODE_KV_NODE, locale), node.nodeId, false])
  if (node.effectiveCwd !== undefined) rows.push([resolveLocalizedText(NODE_KV_CWD, locale), node.effectiveCwd, false])
  if (node.worktree !== undefined) rows.push([resolveLocalizedText(NODE_KV_WORKTREE, locale), `${node.worktree.branch} @ ${node.worktree.path}`, false])
  if (node.model !== undefined) rows.push([resolveLocalizedText(NODE_KV_MODEL, locale), node.model, false])
  if (node.durationMs !== undefined) rows.push([resolveLocalizedText(NODE_KV_DURATION, locale), formatDurationMs(node.durationMs), false])
  if (node.tokens !== undefined && node.tokens > 0) rows.push([resolveLocalizedText(NODE_KV_TOKENS, locale), node.tokens.toLocaleString(), false])
  const outputJson = useMemo(
    () => (typeof node.output === 'string' ? node.output : stringifyPretty(node.output)),
    [node.output],
  )
  return (
    <div className="workflow-node-detail">
      {rows.length > 0 ? (
        <div className="kv-grid">
          {rows.map(([k, v, tabular]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="kv-key">{k}</span>
              <span className={`kv-val ${tabular ? 'tabular-nums' : 'mono'}`}>{v}</span>
            </span>
          ))}
        </div>
      ) : null}
      {node.gateCommand !== undefined || node.gate !== undefined ? (
        <div>
          <div className="trace-section-label">Gate</div>
          {node.gateCommand !== undefined ? <pre className="code-block-pre workflow-node-pre"><code>{node.gateCommand}</code></pre> : null}
          {node.gate !== undefined ? (
            <pre className={`code-block-pre workflow-node-pre${node.gate.ok ? '' : ' workflow-node-pre-err'}`}><code>{node.gate.output}</code></pre>
          ) : null}
        </div>
      ) : null}
      {node.prompt !== undefined ? (
        <div>
          <div className="trace-section-label">{resolveLocalizedText(NODE_SECTION_PROMPT, locale)}</div>
          <pre className="code-block-pre workflow-node-pre"><code>{node.prompt}</code></pre>
        </div>
      ) : null}
      {outputJson !== undefined ? (
        <div>
          <div className="trace-section-label">{resolveLocalizedText(NODE_TAG_OUTPUT, locale)}</div>
          <pre className="code-block-pre workflow-node-pre"><code>{outputJson}</code></pre>
        </div>
      ) : null}
      {node.error !== undefined ? (
        <div>
          <div className="trace-section-label">{resolveLocalizedText(NODE_TAG_ERROR, locale)}</div>
          <pre className="code-block-pre workflow-node-pre workflow-node-pre-err"><code>{node.error}</code></pre>
        </div>
      ) : null}
      {node.worktree !== undefined ? (
        <button
          type="button"
          className="btn btn-xs"
          disabled={cleaning}
          onClick={() => {
            if (cleaning) return
            setCleaning(true)
            ctx
              .callAction('cleanup_worktree', buildWorktreeSelector(node.worktree!, node.nodeId))
              .then(() => ctx.notify(actionCleanupDone(node.worktree!.branch, locale)))
              .catch((err: unknown) =>
                ctx.notify(actionCleanupFailed(err instanceof Error ? err.message : String(err), locale), 'error'),
              )
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
          {resolveLocalizedText(ACTION_CLEANUP_WORKTREE, locale)}
        </button>
      ) : null}
    </div>
  )
}
