import { useMemo } from 'react'
import type { WorkflowRunSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { formatDurationMs } from './timeline-model.js'

const NODE_ICON: Record<string, string> = {
  pending: 'circle',
  running: 'loader',
  done: 'check',
  failed: 'x',
  skipped: 'corner-down-right',
}

const NODE_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

/** 紧凑节点行：状态图标 + label + 实时进展 + 子会话跳转。 */
function WorkflowNodeLine({ node }: { node: NonNullable<WorkflowRunSummary['nodes']>[number] }) {
  const store = useHelmStore()
  const child = node.conversationId !== undefined
    ? store.conversations.find((c) => c.id === node.conversationId)
    : undefined
  const progress =
    node.status === 'running'
      ? (child?.doing ?? node.phaseTitle ?? '执行中…')
      : node.durationMs !== undefined
        ? formatDurationMs(node.durationMs)
        : node.error !== undefined
          ? node.error.slice(0, 80)
          : undefined
  return (
    <div className="workflow-node-line">
      <HelmIcon
        name={NODE_ICON[node.status] ?? 'circle'}
        size={11}
        className={node.status === 'running' ? 'spin-slow' : undefined}
      />
      <span className="workflow-node-label">{node.label ?? node.id}</span>
      <span className={`badge ${node.status === 'running' ? 'badge-accent' : node.status === 'failed' ? 'badge-err' : node.status === 'done' ? 'badge-ok' : 'badge-neutral'}`}>
        {NODE_LABEL[node.status] ?? node.status}
      </span>
      {progress !== undefined ? <span className="workflow-node-progress" title={progress}>{progress}</span> : null}
      {node.conversationId !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title={`在分屏打开子会话 #${node.conversationId}`}
          onClick={() => store.openTarget({ kind: 'conversation', conversationId: node.conversationId! }, { split: true })}
        >
          #{node.conversationId}
        </button>
      ) : null}
    </div>
  )
}

/** 聊天流中的工作流摘要，节点详情统一交给右侧检查器。 */
export function WorkflowRunCard({ run }: { run: WorkflowRunSummary }) {
  const store = useHelmStore()
  const nodes = run.nodes ?? []
  const running = nodes.filter((node) => node.status === 'running').length
  const done = nodes.filter((node) => node.status === 'done').length
  const tokens = nodes.reduce((sum, node) => sum + (node.tokens ?? 0), 0)
  const phases = [...new Set(nodes.flatMap((node) => node.phaseTitle ? [node.phaseTitle] : []))]
  const tone = run.status === 'failed' ? 'err' : run.status === 'running' ? 'accent' : run.status === 'aborted' ? 'warn' : 'ok'
  // 实时节点列表：存在运行中节点或已关联子会话/进度的节点时内联展示（运行期即可见）。
  const liveNodes = useMemo(
    () => nodes.filter((node) => node.status === 'running' || node.conversationId !== undefined || node.status === 'failed'),
    [nodes],
  )
  return <section className="card jr-stack" aria-label={`工作流：${run.name}`}>
    <div className="jr-stack-row">
      <HelmIcon name="workflow" /><strong>{run.name}</strong>
      <span className={`badge badge-${tone}`}>{({ running: '执行中', completed: '已完成', failed: '失败', aborted: '已中止' })[run.status]}</span>
    </div>
    <div className="phase-bar">{phases.map((phase) => <span className="phase-segment" key={phase}>{phase}</span>)}</div>
    <div className="jr-stack-row tabular-nums" style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
      <span>节点 {done}/{nodes.length}</span><span>执行中 {running}</span>
      {tokens > 0 && <span>{tokens.toLocaleString()} Tokens</span>}
      <span>{formatDurationMs(Math.max(0, run.updatedAt - run.createdAt))}</span>
      <button className="btn btn-sm" onClick={() => { store.setWorkbenchTab('tasks'); store.setWorkbenchOpen(true) }}>查看执行详情</button>
    </div>
    {liveNodes.length > 0 ? (
      <div className="workflow-node-list">
        {liveNodes.map((node) => <WorkflowNodeLine key={node.id} node={node} />)}
      </div>
    ) : null}
    {run.error && <p className="jr-callout jr-callout-err">{run.error}</p>}
  </section>
}
