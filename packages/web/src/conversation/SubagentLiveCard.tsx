import { useEffect, useMemo, useState } from 'react'
import { workflowsApi } from '../lib/api.js'
import { formatDurationMs } from '../lib/format.js'
import {
  subagentBadge,
  resolveSubagentTaskTitle,
  buildSubagentStatSegments,
  resolveSubagentHeaderSnippet,
  resolveSubagentElapsedMs,
  type SubagentLiveCardProps,
} from './subagent-live-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

/**
 * 主会话时间线与工作台通用的子代理卡片（极简自适应胶囊）：
 * - 第 1 层头部展示任务标题 + 状态徽章 + 极简统计尾注；
 * - 第 2 层动态副栏单行展示当前动作 / 思考 / 结论 / 错误；
 * - 点击卡片（头部或副栏）直接打开右侧工作台抽屉；
 * - 右侧保留并排查看与任务控制（中止/重试），移除原「进入会话」按钮；
 * - 异常卡片保留状态徽章红字，容器本身不带红色边框。
 */
export function SubagentLiveCard({
  childConversationId,
  toolStatus,
  backgroundRun,
  worktree,
  toolSummary,
  startedAt,
  onNavigate,
}: SubagentLiveCardProps) {
  const store = useHelmStore()
  const [abortBusy, setAbortBusy] = useState(false)
  const summary = useMemo(
    () => store.conversations.find((c) => c.id === childConversationId),
    [store.conversations, childConversationId],
  )
  const detail = store.conversationDetails[childConversationId]
  const live = store.conversationLives[childConversationId]
  const loadDetail = store.loadConversationDetail
  const detailError = detail === undefined ? store.loadErrors[`conversation:${childConversationId}`] : undefined
  const pendingAsk = useMemo(
    () => store.pendingAsks.find((a) => a.conversationId === childConversationId),
    [store.pendingAsks, childConversationId],
  )

  const isWorking = summary?.status === 'working'
  const badge = subagentBadge(summary?.status, toolStatus, backgroundRun?.status)

  // 运行中秒表：SSR 首帧不启动时钟，仅客户端 useEffect 定时推进（确定性渲染）。
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (badge.status !== 'working') return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [badge.status])

  const taskTitle = resolveSubagentTaskTitle(summary, childConversationId, toolSummary, backgroundRun)
  const staticStats = useMemo(
    () =>
      buildSubagentStatSegments({
        ...(summary !== undefined ? { summary } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(toolSummary !== undefined ? { toolSummary } : {}),
        isWorking: badge.status === 'working',
      }),
    [summary, detail?.entries, live, backgroundRun, toolSummary, badge.status],
  )
  const elapsed =
    badge.status === 'working'
      ? resolveSubagentElapsedMs({ backgroundRun, toolSummary, startedAt, nowMs, isWorking: true })
      : undefined
  const statSegments = elapsed !== undefined ? [...staticStats, formatDurationMs(elapsed)] : staticStats
  const snippet = useMemo(
    () =>
      resolveSubagentHeaderSnippet({
        badgeStatus: badge.status,
        ...(summary !== undefined ? { summary } : {}),
        ...(live !== undefined ? { live } : {}),
        ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
        ...(pendingAsk !== undefined ? { pendingAsk } : {}),
        ...(backgroundRun !== undefined ? { backgroundRun } : {}),
        ...(toolSummary !== undefined ? { toolSummary } : {}),
        ...(detailError !== undefined ? { detailError } : {}),
      }),
    [badge.status, summary, live, detail?.entries, pendingAsk, backgroundRun, toolSummary, detailError],
  )

  // 隔离工作树：显式入参优先，其次回退后台 run 首个节点的 worktree。
  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree

  const abort = async (): Promise<void> => {
    if (backgroundRun === undefined) return
    setAbortBusy(true)
    try {
      await workflowsApi.abort(backgroundRun.id)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '中止后台子代理失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setAbortBusy(false)
    }
  }

  const openDrawer = (): void => {
    store.setWorkbenchTab('tasks')
    store.setWorkbenchOpen(true)
    onNavigate?.()
  }

  return (
    <div
      className={`subagent-live-card${
        badge.status === 'blocked'
          ? ' subagent-live-card-warn'
          : badge.status === 'error' || detailError !== undefined
            ? ' subagent-live-card-error'
            : ''
      }`}
    >
      <div className="subagent-live-header">
        <button
          type="button"
          className="subagent-live-trigger"
          aria-label={`查看子会话 #${childConversationId} 详情`}
          title={[taskTitle, summary?.profileId, wt?.branch, statSegments.join(' · '), '点击打开工作台查看任务详情'].filter(Boolean).join('\n')}
          onClick={openDrawer}
        >
          <HelmIcon
            name={
              detailError !== undefined
                ? 'alert-circle'
                : badge.status === 'working'
                  ? 'loader'
                  : badge.status === 'error'
                    ? 'alert-circle'
                    : 'bot'
            }
            size={13}
            className={badge.status === 'working' && detailError === undefined ? 'spin-slow' : undefined}
          />
          <span className="subagent-live-title" title={taskTitle}>
            <span className="subagent-live-id">子会话 #{childConversationId}</span>
            {summary?.profileId !== undefined && summary.profileId !== '' ? (
              <span className="badge badge-neutral">{summary.profileId}</span>
            ) : null}
            {taskTitle !== undefined ? <span className="subagent-live-title-text">{taskTitle}</span> : null}
          </span>
          {wt !== undefined ? (
            <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${wt.path}`}>
              <HelmIcon name="git-branch" size={11} />
              {wt.branch}
            </span>
          ) : null}
          <span className={`badge ${badge.badge}`}>{badge.label}</span>
          {statSegments.length > 0 ? (
            <span className="subagent-live-stats tabular-nums">{statSegments.join(' · ')}</span>
          ) : null}
        </button>
        <span className="subagent-live-actions">
          {backgroundRun?.status === 'running' ? (
            <button
              type="button"
              className="btn btn-xs btn-danger"
              disabled={abortBusy}
              title="中止该后台子代理任务"
              aria-label="中止该后台子代理任务"
              onClick={() => void abort()}
            >
              <HelmIcon name="square" size={11} />
              <span className="subagent-action-label">中止</span>
            </button>
          ) : null}
          {detailError !== undefined ? (
            <button
              type="button"
              className="btn btn-xs"
              title="重新加载子会话详情"
              aria-label="重新加载子会话详情"
              onClick={() => void loadDetail(childConversationId, true)}
            >
              <HelmIcon name="refresh-cw" size={11} />
              <span className="subagent-action-label">重试</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-xs subagent-split-btn workbench-split-btn"
            title="在分屏并排打开该子会话"
            aria-label={`并排查看子会话 #${childConversationId}`}
            onClick={() => {
              store.openTarget({ kind: 'conversation', conversationId: childConversationId }, { split: true })
              onNavigate?.()
            }}
          >
            <HelmIcon name="columns" size={11} />
            <span className="subagent-action-label">并排查看</span>
          </button>
        </span>
      </div>
      {snippet !== undefined ? (
        <button
          type="button"
          className={`subagent-live-subline subagent-live-subline-${snippet.kind}`}
          title={snippet.text}
          aria-label={`查看子会话 #${childConversationId} 详情：${snippet.text}`}
          onClick={openDrawer}
        >
          <HelmIcon name="corner-down-right" size={11} />
          {snippet.tag !== undefined ? <span className="subagent-live-subline-tag">{snippet.tag}</span> : null}
          <span className="subagent-live-subline-text">{snippet.text}</span>
        </button>
      ) : null}
    </div>
  )
}
