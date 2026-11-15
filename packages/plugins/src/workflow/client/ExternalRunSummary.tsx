/**
 * 外部运行时（如 Herdr 窗格）的后台任务摘要组件（无原生子会话时如实展示，
 * 不虚构子会话入口）。运行中的前台同步 run 附带「转入后台」动作（detach）。
 */
import type { ReactNode } from 'react'
import { formatDurationMs, usePluginContext } from '@helm/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { useElapsedNowMs } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { subagentBadge } from './model-subagent-card.ts'
import { canDetachForegroundRun, resolveRunElapsedMs, type DetachViewerScope } from './model-run.ts'

export function ExternalRunSummary(props: {
  run?: WorkflowRunSummary
  worktree?: { path: string; branch: string }
  toolStatus: 'running' | 'done' | 'error'
  executionId?: string
  /** 查看方作用域（会话 + 归属）：前台同步 run 的「转入后台」可见性判定。 */
  viewer?: DetachViewerScope
}): ReactNode {
  const ctx = usePluginContext()
  const { run, worktree, toolStatus, executionId } = props
  const nodes = run?.nodes ?? []
  const running = nodes.filter((n) => n.status === 'running').length
  const failed = nodes.find((n) => n.status === 'failed')
  const runError = run?.status === 'failed' || run?.status === 'aborted' ? (run.error ?? '后台执行失败') : undefined
  const badge = subagentBadge(undefined, toolStatus, run?.status)
  const active = badge.status === 'working'
  const failedState = badge.status === 'error'
  // run 总耗时：运行中随秒表动态推进，结束定格在 createdAt → updatedAt；
  // 无 run 数据时如实省略。
  const nowMs = useElapsedNowMs(active && run?.status === 'running')
  const elapsedMs = run !== undefined ? resolveRunElapsedMs(run, nowMs) : undefined
  return (
    <div className="subagent-live-card subagent-external-card">
      <div className="subagent-live-header">
        <Icon name={failedState ? 'x' : active ? 'loader' : 'bot'} size={13} className={active ? SPIN : undefined} />
        <span className="subagent-live-title">外部执行</span>
        {executionId !== undefined ? <span className="badge badge-neutral">{executionId}</span> : null}
        {worktree !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${worktree.path}`}>
            <Icon name="git-branch" size={11} />
            {worktree.branch}
          </span>
        ) : null}
        <span className={`badge ${badge.badge}`}>{badge.label}</span>
        {elapsedMs !== undefined ? (
          <span className="subagent-live-elapsed tabular-nums">{formatDurationMs(elapsedMs)}</span>
        ) : null}
        {run !== undefined && canDetachForegroundRun(run, props.viewer) ? (
          <button
            type="button"
            className="btn btn-xs"
            title="把该前台同步外部执行转入后台：阻塞中的调用立即返回后台句柄，完成后自动 followUp 汇报"
            aria-label="把该前台同步外部执行转入后台"
            onClick={() => {
              void ctx
                .callAction('detach', { runId: run.id })
                .then(() => ctx.notify(`已转入后台（运行 ${run.id}）：当前调用将收到后台句柄，完成后自动汇报`))
                .catch((err: unknown) => ctx.notify(`转入后台失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
            }}
          >
            <Icon name="arrow-down-to-line" size={11} />
            <span className="subagent-action-label">转入后台</span>
          </button>
        ) : null}
      </div>
      <div className="subagent-live-stream subagent-external-body">
        {nodes.length > 0 ? (
          <div className="workflow-node-list">
            {nodes.map((n) => (
              <div key={n.id} className="workflow-node-line">
                <Icon name={n.status === 'running' ? 'loader' : n.status === 'failed' ? 'x' : n.status === 'done' ? 'check' : 'circle'} size={11} className={n.status === 'running' ? SPIN : undefined} />
                <span className="workflow-node-label">{n.label ?? n.id}</span>
                {n.executionId !== undefined ? <span className="subagent-external-exec">{n.executionId}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="subagent-stream-line subagent-stream-empty">
            {run === undefined ? `外部执行${active ? '进行中' : failedState ? '异常' : '已结束'}（无子会话）` : `后台任务 ${run.id}`}
          </div>
        )}
        {runError !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={runError}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">后台执行失败：{runError}</span>
          </div>
        ) : null}
        {failed !== undefined && failed.error !== undefined ? (
          <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={failed.error}>
            <Icon name="x" size={11} />
            <span className="subagent-stream-body">节点失败：{failed.error}</span>
          </div>
        ) : null}
        {running > 0 ? <div className="subagent-stream-line subagent-stream-empty">{running} 个节点执行中</div> : null}
      </div>
    </div>
  )
}
