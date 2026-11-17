/**
 * builtin:workflow 子代理卡内部子视图（自 SubagentCard.tsx 拆出）：
 * - SubagentCardHeading：第 1 层头部徽章区（图标 + 标题 + 徽章 + 统计尾注）；
 * - SubagentCardActions：头部动作栏（中止 / 转入后台 / 恢复 / 清理工作树 / 重试）；
 * - SubagentCardSublines：第 2 层动态副栏（当前动作摘要 + 前线活动）。
 * 纯展示组件：数据判定在 model-* 纯逻辑模块，本文件只做插槽排版。
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatCompactTimestamp, usePluginContext } from '@helm/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { SPIN, EXECUTION_BADGE, EXECUTION_LABEL } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildWorktreeSelector } from './model-worktree.ts'
import { canDetachForegroundRun, canResumeSubagentRun, type DetachViewerScope } from './model-run.ts'
import type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
import type { SubagentBadge, SubagentHeaderSnippet } from './model-subagent-card.ts'
import type { ExecutionApprovalItem, ExecutionFrontlineItem } from './model-execution-view.ts'

/** 第 1 层头部徽章区：左图标 + 标题 + 徽章 + 子树统计 + 总耗时尾注。 */
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
  return (
    <>
      <Icon
        name={detailError !== undefined ? 'x' : effectiveStatus === 'working' ? 'loader' : effectiveStatus === 'error' ? 'x' : 'bot'}
        size={13}
        className={effectiveStatus === 'working' && detailError === undefined ? SPIN : undefined}
      />
      <span className="subagent-live-title" title={taskTitle}>
        <span className="subagent-live-id">子会话 #{childConversationId}</span>
        {profileId !== undefined && profileId !== '' ? (
          <span className="badge badge-neutral">{profileId}</span>
        ) : null}
        {taskTitle !== undefined ? <span className="subagent-live-title-text">{taskTitle}</span> : null}
      </span>
      {worktree !== undefined ? (
        <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${worktree.path}`}>
          <Icon name="git-branch" size={11} />
          {worktree.branch}
        </span>
      ) : null}
      {props.cached === true ? <span className="badge badge-warn">cached</span> : null}
      {effectiveStatus !== selfBadge.status ? (
        <>
          <span
            className={`badge ${EXECUTION_BADGE[effectiveStatus] ?? 'badge-neutral'}`}
            title={
              [
                `自身${selfBadge.label}，子树聚合：${EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}`,
                approvals.length > 0 ? `后代等待审批：${approvals.map((item) => item.text).join('；')}` : undefined,
              ]
                .filter(Boolean)
                .join('\n')
            }
          >
            {EXECUTION_LABEL[effectiveStatus] ?? effectiveStatus}
          </span>
          <span className="badge badge-neutral" title={`自身状态：${selfBadge.label}`}>{`自身${selfBadge.label}`}</span>
        </>
      ) : (
        <span className={`badge ${selfBadge.badge}`}>{selfBadge.label}</span>
      )}
      {descendants.total > 0 ? (
        <span
          className="badge badge-neutral tabular-nums"
          title={`子树执行进度：${descendants.done}/${descendants.total} 完成、${descendants.running} 执行中`}
        >
          {`子树 ${descendants.done}/${descendants.total}`}
        </span>
      ) : null}
      {descendants.blocked > 0 ? (
        <span
          className="badge badge-warn"
          title={`后代等待审批：${approvals.map((item) => item.text).join('；')}`}
        >
          {`审批 ${descendants.blocked}`}
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

/** 头部动作栏：中止后台任务 / 前台同步转后台 / 恢复失败任务 / 清理隔离工作树 / 重载详情（点击不冒泡整卡导航）。 */
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
          title="中止该后台子代理任务"
          aria-label="中止该后台子代理任务"
          onClick={(e) => {
            e.stopPropagation()
            void ctx
              .callAction('abort', { runId: backgroundRun.id })
              .catch((err: unknown) => ctx.notify(`中止后台子代理失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
          }}
        >
          <Icon name="square" size={11} />
          <span className="subagent-action-label">中止</span>
        </button>
      ) : null}
      {backgroundRun !== undefined && canDetachForegroundRun(backgroundRun, props.viewer) ? (
        <button
          type="button"
          className="btn btn-xs"
          title={ctx.translate({ en: 'Move this subagent to the background; the current call returns a handle and the result arrives as an interjection.', 'zh-CN': '将子代理转入后台，当前调用立即返回句柄，完成后自动插话汇报' })}
          aria-label="把该前台同步子代理转入后台"
          onClick={(e) => {
            e.stopPropagation()
            void ctx
              .callAction('detach', { runId: backgroundRun.id })
              .then(() => ctx.notify(`已转入后台（运行 ${backgroundRun.id}）：当前调用将收到后台句柄，完成后自动汇报`))
              .catch((err: unknown) => ctx.notify(`转入后台失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
          }}
        >
          <Icon name="arrow-down-to-line" size={11} />
          <span className="subagent-action-label">转入后台</span>
        </button>
      ) : null}
      {backgroundRun !== undefined && canResumeSubagentRun(backgroundRun, props.hasExecutionHandle ?? true) ? (
        <button
          type="button"
          className="btn btn-xs"
          disabled={resuming}
          title="恢复该失败或中止的后台子代理任务"
          aria-label="恢复该后台子代理任务"
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
              .then(() => ctx.notify(`已发起恢复（源运行 ${backgroundRun.id}）`))
              .catch((err: unknown) => ctx.notify(`恢复后台子代理失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
              .finally(() => {
                resumeInFlight.current = false
                setResuming(false)
              })
          }}
        >
          <Icon name="rotate-cw" size={11} className={resuming ? SPIN : undefined} />
          <span className="subagent-action-label">恢复</span>
        </button>
      ) : null}
      {worktree !== undefined ? (
        <button
          type="button"
          className="btn btn-xs"
          disabled={cleaning}
          title="清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）"
          aria-label="清理隔离工作树"
          onClick={(e) => {
            e.stopPropagation()
            if (cleaning) return
            setCleaning(true)
            ctx
              .callAction('cleanup_worktree', buildWorktreeSelector(worktree, inspectNodeId))
              .then(() => ctx.notify(`已清理隔离工作树 ${worktree.branch}`))
              .catch((err: unknown) => ctx.notify(`清理工作树失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
              .finally(() => setCleaning(false))
          }}
        >
          <Icon name="rotate-cw" size={11} className={cleaning ? SPIN : undefined} />
          <span className="subagent-action-label">清理工作树</span>
        </button>
      ) : null}
      {detailError !== undefined ? (
        <button
          type="button"
          className="btn btn-xs"
          title="重新加载子会话详情"
          aria-label="重新加载子会话详情"
          onClick={(e) => {
            e.stopPropagation()
            props.onReload()
          }}
        >
          <Icon name="rotate-cw" size={11} />
          <span className="subagent-action-label">重试</span>
        </button>
      ) : null}
    </>
  )
}

/** 第 2 层动态副栏：当前动作 / 思考 / 结论 / 错误 + 前线活动摘要 + 无损元数据。 */
export function SubagentCardSublines(props: {
  snippet: SubagentHeaderSnippet | undefined
  frontline: ExecutionFrontlineItem[]
  nodeId?: string
  cwd?: string
  createdAt?: number
  runId?: string
}): ReactNode {
  const { snippet, frontline, nodeId, cwd, createdAt, runId } = props
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
          <span className="subagent-live-subline-tag">前线</span>
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
