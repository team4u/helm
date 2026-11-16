/**
 * builtin:workflow 插件工作流 run 内节点卡族（WorkflowRunCardBody 消费）：
 * - WorkflowNodeCard：单节点分发（子代理节点一体化整卡 / 动作节点扁平双层卡）；
 * - WorkflowSubagentNodeCard：子代理节点直接以一体化整卡直出（无手风琴折叠壳）；
 * - WorkflowExecutionNodeCard：无原生子会话节点（动作 / 外部执行）扁平双层卡；
 * - WorkflowNodeDetail：无会话节点的结构化明细。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkflowNodeState } from '../../contracts.js'
import { formatCompactTimestamp, formatDurationMs, usePluginContext } from '@helm/plugin-client'
import { useElapsedNowMs } from './hooks.ts'
import { SPIN, NODE_LABEL, NODE_BADGE } from './presentation.ts'
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
import type { ExecutionNode } from './model-execution-tree.ts'

/** 工作流子代理节点：直接以一体化整卡直出（无手风琴折叠壳）。 */
function WorkflowSubagentNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
  const outputText = typeof node.output === 'string' ? node.output : undefined
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
            {node.gate.ok ? 'Gate 通过' : 'Gate 失败'}
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

/** 无原生子会话节点：动作与外部执行如实展示，均不伪造可导航的子会话。 */
function WorkflowExecutionNodeCard(props: { node: WorkflowNodeState; runConversationId: number }): ReactNode {
  const { node } = props
  const summaryText = resolveNodeSummaryText(node)
  const nodeStats = useMemo(() => formatWorkflowNodeStats(node), [node])
  const isErr = node.status === 'failed'
  // 总耗时：running 随秒表从 startedAt 动态推进（SSR 首帧无时钟如实省略），
  // 结算定格持久化 durationMs；无真实边界不显示虚构值。
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
          <span className="badge badge-neutral">{node.kind === 'action' ? '动作' : node.executionId !== undefined ? '外部执行' : '子代理节点'}</span>
          <span className="subagent-live-title" title={node.label ?? node.id}>
            <span className="subagent-live-title-text">{node.label ?? node.id}</span>
          </span>
          {node.worktree !== undefined ? (
            <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${node.worktree.path}`}>
              <Icon name="git-branch" size={11} />
              {node.worktree.branch}
            </span>
          ) : null}
          {node.cached === true ? <span className="badge badge-warn">cached</span> : null}
          <span className={`badge ${NODE_BADGE[node.status] ?? 'badge-neutral'}`}>
            {NODE_LABEL[node.status] ?? node.status}
          </span>
          {node.attempt !== undefined && node.attempt > 1 ? (
            <span className="badge badge-neutral">{`第 ${node.attempt} 次`}</span>
          ) : null}
          {node.gate !== undefined ? (
            <span className={`badge ${node.gate.ok ? 'badge-ok' : 'badge-err'}`}>
              {node.gate.ok ? 'Gate 通过' : 'Gate 失败'}
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
          <span className="subagent-live-subline-tag">{summaryText.isError ? '错误' : '产出'}</span>
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

/** 单节点卡片：子代理节点直出一体化整卡；动作节点直出扁平双层卡。全程无手风琴折叠。 */
export function WorkflowNodeCard(props: { node: WorkflowNodeState; runConversationId: number; childNodes?: ExecutionNode[] }): ReactNode {
  const { node, childNodes } = props
  if (node.conversationId !== undefined) {
    return <WorkflowSubagentNodeCard node={node} childNodes={childNodes} runConversationId={props.runConversationId} />
  }
  return <WorkflowExecutionNodeCard node={node} runConversationId={props.runConversationId} />
}

/** 无原生子会话节点的结构化明细。 */
function WorkflowNodeDetail({ node }: { node: WorkflowNodeState }): ReactNode {
  const ctx = usePluginContext()
  const [cleaning, setCleaning] = useState(false)
  const rows: Array<[string, string]> = []
  if (node.agentType !== undefined) rows.push(['执行后端', node.agentType])
  if (node.executionId !== undefined) rows.push(['外部执行', node.executionId])
  if (node.nodeId !== undefined) rows.push(['执行节点', node.nodeId])
  if (node.effectiveCwd !== undefined) rows.push(['工作目录', node.effectiveCwd])
  if (node.worktree !== undefined) rows.push(['工作树', `${node.worktree.branch} @ ${node.worktree.path}`])
  if (node.model !== undefined) rows.push(['模型', node.model])
  if (node.durationMs !== undefined) rows.push(['耗时', formatDurationMs(node.durationMs)])
  if (node.tokens !== undefined && node.tokens > 0) rows.push(['Token', node.tokens.toLocaleString()])
  const outputJson = useMemo(
    () => (typeof node.output === 'string' ? node.output : stringifyPretty(node.output)),
    [node.output],
  )
  return (
    <div className="workflow-node-detail">
      {rows.length > 0 ? (
        <div className="kv-grid">
        {node.startedAt !== undefined ? (
          <>
            <span className="kv-key">开始时间</span>
            <span className="kv-val tabular-nums">{formatCompactTimestamp(node.startedAt)}</span>
          </>
        ) : null}
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="kv-key">{k}</span>
              <span className="kv-val mono">{v}</span>
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
          <div className="trace-section-label">Prompt</div>
          <pre className="code-block-pre workflow-node-pre"><code>{node.prompt}</code></pre>
        </div>
      ) : null}
      {outputJson !== undefined ? (
        <div>
          <div className="trace-section-label">Output</div>
          <pre className="code-block-pre workflow-node-pre"><code>{outputJson}</code></pre>
        </div>
      ) : null}
      {node.error !== undefined ? (
        <div>
          <div className="trace-section-label">Error</div>
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
              .then(() => ctx.notify(`已清理工作树 ${node.worktree!.branch}`))
              .catch((err: unknown) =>
                ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'),
              )
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
          清理工作树
        </button>
      ) : null}
    </div>
  )
}
