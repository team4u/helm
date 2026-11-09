import { useEffect, useMemo, useRef, useState } from 'react'
import { workflowsApi } from '../lib/api.js'
import type { ToolTraceStatus } from './timeline-model.js'
import { buildSubagentStreamLines, formatDurationMs } from './timeline-model.js'
import {
  subagentBadge,
  toolResultPreviewTruncated,
  isScrolledToBottom,
  resolveSubagentTaskTitle,
  buildSubagentStatSegments,
  resolveSubagentHeaderSnippet,
  resolveSubagentElapsedMs,
  type SubagentLiveCardProps,
} from './subagent-live-model.js'
import { ToolCallDetails } from './ToolCallDetails.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

/** 工具行状态图标名。 */
function streamToolIcon(status: ToolTraceStatus, isError: boolean): string {
  if (status === 'running') return 'loader'
  if (isError) return 'x'
  if (status === 'done') return 'check'
  return 'circle'
}

/**
 * 主会话时间线内嵌的子代理实时卡片（双层自适应胶囊）：
 * 第 1 层头部按钮承载折叠交互 + 任务标题 + 状态徽章 + 极简统计尾注；
 * 第 2 层动态副栏在折叠态单行展示当前动作 / 思考 / 结论 / 错误（默认折叠零请求）。
 * 展开态保持完整实时流（详情懒加载 + conversation.live 流式合并 + 自动贴底）。
 * 详情加载失败显式报错并可重试，绝不静默停在“加载中”。
 */
export function SubagentLiveCard({ childConversationId, toolStatus, backgroundRun, worktree, defaultExpanded, toolSummary, toolCall, startedAt, onNavigate }: SubagentLiveCardProps) {
  const store = useHelmStore()
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)
  const [abortBusy, setAbortBusy] = useState(false)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
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

  // 仅在卡片展开时自动加载子会话详情，避免工作台挂载多张折叠卡片时触发 N+1 请求风暴。
  useEffect(() => {
    if (expanded && detail === undefined && detailError === undefined) void loadDetail(childConversationId)
  }, [expanded, childConversationId, detail === undefined, detailError, loadDetail])

  const isWorking = summary?.status === 'working'
  const badge = subagentBadge(summary?.status, toolStatus, backgroundRun?.status)
  const lines = useMemo(
    () => expanded ? buildSubagentStreamLines(detail?.entries ?? [], live, isWorking) : [],
    [expanded, detail?.entries, live, isWorking],
  )

  // 运行中秒表：SSR 首帧不启动时钟，仅客户端 useEffect 定时推进（确定性渲染）。
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (badge.status !== 'working') return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
    // 仅声明时钟启停（badge.status 变化时重挂/卸载），避免每秒重建定时器。
  }, [badge.status])

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : undefined
  const lastLineFingerprint =
    lastLine === undefined ? '' : `${lastLine.kind}:${lastLine.key}:${'text' in lastLine ? lastLine.text.length : 0}`
  // 重新展开时若此前贴底则恢复贴底；收起期间内容增长不改变跟随意愿。
  useEffect(() => {
    if (!expanded) return
    const el = streamRef.current
    if (el === null) return
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [expanded, lines.length, lastLineFingerprint, live?.updatedAt, live?.text.length, live?.thinking?.length])

  const taskTitle = resolveSubagentTaskTitle(summary, childConversationId, toolSummary, backgroundRun)
  const staticStats = useMemo(() => buildSubagentStatSegments({
    ...(summary !== undefined ? { summary } : {}),
    ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
    ...(live !== undefined ? { live } : {}),
    ...(backgroundRun !== undefined ? { backgroundRun } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    isWorking: badge.status === 'working',
  }), [summary, detail?.entries, live, backgroundRun, toolSummary, badge.status])
  const elapsed = badge.status === 'working'
    ? resolveSubagentElapsedMs({ backgroundRun, toolSummary, startedAt, nowMs, isWorking: true })
    : undefined
  const statSegments = elapsed !== undefined ? [...staticStats, formatDurationMs(elapsed)] : staticStats
  const snippet = useMemo(() => resolveSubagentHeaderSnippet({
    badgeStatus: badge.status,
    ...(summary !== undefined ? { summary } : {}),
    ...(live !== undefined ? { live } : {}),
    ...(detail?.entries !== undefined ? { entries: detail.entries } : {}),
    ...(pendingAsk !== undefined ? { pendingAsk } : {}),
    ...(backgroundRun !== undefined ? { backgroundRun } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(detailError !== undefined ? { detailError } : {}),
  }), [badge.status, summary, live, detail?.entries, pendingAsk, backgroundRun, toolSummary, detailError])
  const emptyHint = detailError !== undefined
    ? `子会话详情加载失败：${detailError}`
    : isWorking
      ? (summary?.doing ?? '正在启动子代理…')
      : detail === undefined
        ? '正在加载子会话…'
        : '暂无输出'

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

  return (
    <div
      className={`subagent-live-card${expanded ? ' subagent-live-card-expanded' : ''}${
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
          aria-expanded={expanded}
          aria-label={expanded ? '收起子会话实时内容' : '展开子会话实时内容'}
          title={[taskTitle, summary?.profileId, wt?.branch, statSegments.join(' · '), expanded ? '收起子会话实时内容' : '展开子会话实时内容'].filter(Boolean).join('\n')}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="subagent-live-toggle">
            <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
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
            className="btn btn-xs"
            title="进入该子会话继续对话"
            aria-label={`进入子会话 #${childConversationId}`}
            onClick={() => {
              store.openTarget({ kind: 'conversation', conversationId: childConversationId })
              onNavigate?.()
            }}
          >
            <HelmIcon name="message-square" size={11} />
            <span className="subagent-action-label">进入会话</span>
          </button>
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
      {!expanded && snippet !== undefined ? (
        <button
          type="button"
          className={`subagent-live-subline subagent-live-subline-${snippet.kind}`}
          title={snippet.text}
          aria-expanded={false}
          aria-label={`展开子会话实时内容：${snippet.text}`}
          onClick={() => setExpanded(true)}
        >
          <HelmIcon name="corner-down-right" size={11} />
          {snippet.tag !== undefined ? <span className="subagent-live-subline-tag">{snippet.tag}</span> : null}
          <span className="subagent-live-subline-text">{snippet.text}</span>
        </button>
      ) : null}
      {expanded ? (
        <div className="subagent-live-metadata">
          {summary?.profileId ? <span>{summary.profileId}</span> : null}
          {wt ? <span title={`隔离工作树：${wt.path}`}>{wt.branch}</span> : null}
          {statSegments.length > 0 ? <span>{statSegments.join(' · ')}</span> : null}
        </div>
      ) : null}
      {expanded ? (
        <div
          ref={streamRef}
          className="subagent-live-stream"
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottomRef.current = isScrolledToBottom(el)
          }}
        >
          {lines.length === 0 ? (
            <div className={`subagent-stream-line subagent-stream-empty${detailError !== undefined ? ' subagent-stream-error' : ''}`}>
              <HelmIcon
                name={detailError !== undefined ? 'alert-circle' : isWorking ? 'loader' : 'circle'}
                size={11}
                className={detailError === undefined && isWorking ? 'spin-slow' : undefined}
              />
              {emptyHint}
            </div>
          ) : (
            lines.map((line) => {
              if (line.kind === 'prompt') {
                return (
                  <div key={line.key} className="subagent-stream-line subagent-stream-prompt" title={line.text}>
                    <span className="subagent-stream-tag">指令</span>
                    <span className="subagent-stream-body">{line.text}</span>
                  </div>
                )
              }
              if (line.kind === 'thinking') {
                return (
                  <div key={line.key} className="subagent-stream-line subagent-stream-thinking" title={line.text}>
                    <span className="subagent-stream-tag">思考</span>
                    <span className="subagent-stream-body">{line.text}</span>
                  </div>
                )
              }
              if (line.kind === 'tool') {
                return (
                  <div key={line.key} className="subagent-stream-line subagent-stream-tool">
                    <HelmIcon
                      name={streamToolIcon(line.status, line.isError)}
                      size={11}
                      className={line.status === 'running' ? 'spin-slow' : undefined}
                    />
                    <span className="subagent-stream-tool-name">{line.toolName}</span>
                    <span className="subagent-stream-tool-summary">{line.summary}</span>
                    <span className="subagent-stream-tool-preview">
                      {line.resultPreview !== undefined ? (
                        <>
                          <span className="subagent-stream-preview-text">{line.resultPreview}</span>
                          {toolResultPreviewTruncated(line.resultPreview) ? (
                            <span className="subagent-stream-preview-more" title="仅为首行预览，完整结果请进入会话查看">
                              …已截断
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </span>
                    <span className="subagent-stream-meta">
                      {line.status === 'running'
                        ? '运行中'
                        : line.durationMs !== undefined
                          ? formatDurationMs(line.durationMs)
                          : line.isError
                            ? '失败'
                            : '完成'}
                    </span>
                  </div>
                )
              }
              return (
                <div key={line.key} className="subagent-stream-line subagent-stream-text">
                  <span className="subagent-stream-body">{line.text}</span>
                </div>
              )
            })
          )}
          {backgroundRun?.status === 'failed' && backgroundRun.error ? (
            <div className="subagent-stream-line subagent-stream-error subagent-bg-error" title={backgroundRun.error}>
              <HelmIcon name="alert-circle" size={11} />
              <span className="subagent-stream-body">后台执行失败：{backgroundRun.error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded && toolCall !== undefined ? <ToolCallDetails tool={toolCall} /> : null}
    </div>
  )
}
