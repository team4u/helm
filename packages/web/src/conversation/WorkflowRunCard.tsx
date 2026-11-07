import type { WorkflowRunSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { formatDurationMs } from './timeline-model.js'

/** 聊天流中的工作流摘要，节点详情统一交给右侧检查器。 */
export function WorkflowRunCard({ run }: { run: WorkflowRunSummary }) {
  const store = useHelmStore()
  const nodes = run.nodes ?? []
  const running = nodes.filter((node) => node.status === 'running').length
  const done = nodes.filter((node) => node.status === 'done').length
  const tokens = nodes.reduce((sum, node) => sum + (node.tokens ?? 0), 0)
  const phases = [...new Set(nodes.flatMap((node) => node.phaseTitle ? [node.phaseTitle] : []))]
  const tone = run.status === 'failed' ? 'err' : run.status === 'running' ? 'accent' : run.status === 'aborted' ? 'warn' : 'ok'
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
    {run.error && <p className="jr-callout jr-callout-err">{run.error}</p>}
  </section>
}
