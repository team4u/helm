import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolTraceStatus } from './timeline-model.js'
import { buildSubagentStreamLines, formatDurationMs } from './timeline-model.js'
import { subagentBadge, toolResultPreviewTruncated, isScrolledToBottom, type SubagentLiveCardProps } from './subagent-live-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

/** 工具行状态图标名。 */
function streamToolIcon(status: ToolTraceStatus, isError: boolean): string {
  if (status === 'running') return 'loader'
  if (isError) return 'x'
  if (status === 'done') return 'check'
  return 'circle'
}

/** 是否应贴底：手动上滑超过阈值后暂停跟随，回到底部自动恢复（共享语义见 subagent-live-model）。 */

/**
 * 主会话时间线内嵌的子代理实时卡片：自动加载子会话详情、实时同步
 * conversation.live 流式内容并自动贴底滚动。
 *
 * 状态优先跟随子会话真实 summary.status（卡片实时反映该子会话最新
 * 进展，父工具 toolStatus 只是缺 summary 时的 fallback）；background: true
 * 派生的后台 run 状态参与判定——run 仍在 running 时绝不假完成。
 * 详情加载失败显式报错并可重试，绝不静默停在“加载中”。
 */
export function SubagentLiveCard({ childConversationId, toolStatus, backgroundRun, worktree }: SubagentLiveCardProps) {
  const store = useHelmStore()
  const [expanded, setExpanded] = useState(true)
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

  // 自动加载详情：一旦加载完成，live-state 会把后续 conversation.entry 实时并入。
  useEffect(() => {
    if (detail === undefined && detailError === undefined) void loadDetail(childConversationId)
  }, [childConversationId, detail === undefined, detailError, loadDetail])

  const isWorking = summary?.status === 'working'
  const lines = useMemo(
    () => buildSubagentStreamLines(detail?.entries ?? [], live, isWorking),
    [detail?.entries, live, isWorking],
  )

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

  const badge = subagentBadge(summary?.status, toolStatus, backgroundRun?.status)
  const emptyHint = detailError !== undefined
    ? `子会话详情加载失败：${detailError}`
    : isWorking
      ? (summary?.doing ?? '正在启动子代理…')
      : detail === undefined
        ? '正在加载子会话…'
        : '暂无输出'

  // 隔离工作树：显式入参优先，其次回退后台 run 首个节点的 worktree。
  const wt = worktree ?? backgroundRun?.nodes?.find((n) => n.worktree !== undefined)?.worktree

  return (
    <div className="subagent-live-card">
      <div className="subagent-live-header">
        <button
          type="button"
          className="btn btn-ghost btn-sm subagent-live-toggle"
          aria-label={expanded ? '收起子会话实时内容' : '展开子会话实时内容'}
          title={expanded ? '收起子会话实时内容' : '展开子会话实时内容'}
          onClick={() => setExpanded((v) => !v)}
        >
          <HelmIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
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
        <span className="subagent-live-title">
          子会话 #{childConversationId}
          {summary?.profileId !== undefined && summary.profileId !== '' ? (
            <span className="badge badge-neutral">{summary.profileId}</span>
          ) : null}
        </span>
        {wt !== undefined ? (
          <span className="badge badge-neutral subagent-worktree-badge" title={`隔离工作树：${wt.path}`}>
            <HelmIcon name="git-branch" size={11} />
            {wt.branch}
          </span>
        ) : null}
        <span className={`badge ${badge.badge}`}>{badge.label}</span>
        {isWorking && summary?.doing !== undefined && summary.doing !== '' ? (
          <span className="subagent-live-doing" title={summary.doing}>
            {summary.doing}
          </span>
        ) : null}
        <span className="subagent-live-actions">
          {detailError !== undefined ? (
            <button
              type="button"
              className="btn btn-sm"
              title="重新加载子会话详情"
              onClick={() => void loadDetail(childConversationId, true)}
            >
              <HelmIcon name="refresh-cw" size={11} />
              重试
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            title="进入该子会话继续对话"
            onClick={() => store.openTarget({ kind: 'conversation', conversationId: childConversationId })}
          >
            <HelmIcon name="message-square" size={11} />
            进入会话
          </button>
          <button
            type="button"
            className="btn btn-sm subagent-split-btn"
            title="在分屏并排打开该子会话"
            onClick={() =>
              store.openTarget({ kind: 'conversation', conversationId: childConversationId }, { split: true })
            }
          >
            <HelmIcon name="columns" size={11} />
            并排查看
          </button>
        </span>
      </div>
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
    </div>
  )
}
