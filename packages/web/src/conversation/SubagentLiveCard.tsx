import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolTraceStatus } from './timeline-model.js'
import { buildSubagentStreamLines, formatDurationMs } from './timeline-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export interface SubagentLiveCardProps {
  childConversationId: number
  toolStatus: ToolTraceStatus
}

/** 工具行状态图标名。 */
function streamToolIcon(status: ToolTraceStatus, isError: boolean): string {
  if (status === 'running') return 'loader'
  if (isError) return 'x'
  if (status === 'done') return 'check'
  return 'circle'
}

function statusBadge(toolStatus: ToolTraceStatus, summaryStatus?: string): { label: string; badge: string } {
  if (summaryStatus === 'blocked') return { label: '等待审批', badge: 'badge-warn' }
  if (toolStatus === 'running') return { label: '执行中', badge: 'badge-accent' }
  if (toolStatus === 'error') return { label: '异常', badge: 'badge-err' }
  if (toolStatus === 'done') return { label: '已完成', badge: 'badge-ok' }
  return { label: '进行中', badge: 'badge-neutral' }
}

/**
 * 主会话时间线内嵌的子代理实时卡片：自动加载子会话详情、实时同步
 * conversation.live 流式内容并自动贴底滚动。
 */
export function SubagentLiveCard({ childConversationId, toolStatus }: SubagentLiveCardProps) {
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

  // 自动加载详情：一旦加载完成，live-state 会把后续 conversation.entry 实时并入。
  useEffect(() => {
    if (detail === undefined) void loadDetail(childConversationId)
  }, [childConversationId, detail === undefined, loadDetail, summary?.completionSeq])

  const isWorking = summary?.status === 'working'
  const lines = useMemo(
    () => buildSubagentStreamLines(detail?.entries ?? [], live, isWorking),
    [detail?.entries, live, isWorking],
  )

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : undefined
  const lastLineFingerprint =
    lastLine === undefined ? '' : `${lastLine.kind}:${lastLine.key}:${'text' in lastLine ? lastLine.text.length : 0}`
  useEffect(() => {
    const el = streamRef.current
    if (el === null || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines.length, lastLineFingerprint, live?.updatedAt, live?.text.length, live?.thinking?.length])

  const badge = statusBadge(toolStatus, summary?.status)
  const emptyHint = isWorking
    ? (summary?.doing ?? '正在启动子代理…')
    : detail === undefined
      ? '正在加载子会话…'
      : '暂无输出'

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
          name={isWorking ? 'loader' : toolStatus === 'error' ? 'alert-circle' : 'bot'}
          size={13}
          className={isWorking ? 'spin-slow' : undefined}
        />
        <span className="subagent-live-title">
          子会话 #{childConversationId}
          {summary?.profileId !== undefined && summary.profileId !== '' ? (
            <span className="badge badge-neutral">{summary.profileId}</span>
          ) : null}
        </span>
        <span className={`badge ${badge.badge}`}>{badge.label}</span>
        {isWorking && summary?.doing !== undefined && summary.doing !== '' ? (
          <span className="subagent-live-doing" title={summary.doing}>
            {summary.doing}
          </span>
        ) : null}
        <span className="subagent-live-actions">
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
            className="btn btn-sm"
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
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 36
          }}
        >
          {lines.length === 0 ? (
            <div className="subagent-stream-line subagent-stream-empty">
              <HelmIcon name={isWorking ? 'loader' : 'circle'} size={11} className={isWorking ? 'spin-slow' : undefined} />
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
        </div>
      ) : null}
    </div>
  )
}
