/**
 * builtin:workflow 后台结算汇报（timeline.renderer 精确接管 helm.input）：
 * - 默认收口为与宿主 `.trace-row` 同构的 26px 单行回执；失败/中止/损坏报文自动默认展开。
 * - 点击标题按钮原地展开无损汇报面板（完整呈现 runId、投递时间、完整 Markdown/JSON 结果、
 *   错误信息与其余在途任务快照），不订阅实时状态、不伪造缺失数据。
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helm/protocol'
import { CopyButton, MarkdownText, formatCompactTimestamp, usePluginContext } from '@helm/plugin-client'
import { RUN_BADGE, RUN_LABEL } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import {
  backgroundReportPreview,
  isBackgroundReportDefaultOpen,
  parseBackgroundReportEntry,
} from './model-background-report.ts'
import type { BackgroundReportView } from './model-background-report.ts'

const PREVIEW_MAX_CHARS = 120

export function BackgroundReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const view = useMemo(() => parseBackgroundReportEntry(props.entry), [props.entry])
  const [open, setOpen] = useState(() => isBackgroundReportDefaultOpen(view))
  const bodyId = useId()

  const conversationId = view.invalid ? undefined : view.executionConversationId
  const isFailure = !view.invalid && (view.status === 'failed' || view.status === 'aborted')
  const title = view.invalid ? '后台汇报' : view.kind === 'subagent_report' ? '子代理汇报' : '工作流汇报'
  const statusIcon = view.invalid || isFailure ? 'alert-circle' : view.kind === 'workflow_report' ? 'workflow' : 'bot'
  const preview = view.invalid ? '汇报数据格式异常，展开查看原始报文' : backgroundReportPreview(view, PREVIEW_MAX_CHARS)
  const rowTitle = conversationId !== undefined ? `${title} #${conversationId}` : title

  return (
    <div className="trace-entry">
      <div className={`trace-row${isFailure || view.invalid ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left workflow-trace-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? '收起' : '展开'}${rowTitle}详情`}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <Icon name={statusIcon} size={12} />
          <span className="trace-tool-name">{rowTitle}</span>
          {preview !== '' ? (
            <span className={`trace-tool-summary${isFailure || view.invalid ? ' workflow-trace-error' : ''}`} title={preview}>
              {preview}
            </span>
          ) : null}
        </button>
        <span className="trace-row-right workflow-trace-right">
          {view.invalid ? (
            <span className="badge workflow-trace-badge badge-err">汇报数据格式异常</span>
          ) : (
            <span className={`badge workflow-trace-badge ${RUN_BADGE[view.status] ?? 'badge-neutral'}`}>
              {RUN_LABEL[view.status] ?? view.status}
            </span>
          )}
          {view.createdAt !== undefined ? (
            <span className="trace-duration tabular-nums">{formatCompactTimestamp(view.createdAt)}</span>
          ) : null}
          <CopyButton text={view.rawText} className="btn btn-ghost btn-xs" />
          {conversationId !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              title={`打开子会话 #${conversationId}`}
              aria-label={`打开子会话 #${conversationId}`}
              onClick={() => ctx.openConversationDrawer(conversationId)}
            >
              <Icon name="external-link" size={11} />
            </button>
          ) : null}
        </span>
      </div>

      {/* 裸 div 承载 hidden，避免 flex 容器样式覆盖 UA [hidden] */}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="trace-expanded-body workflow-report-expanded selectable">
            {view.invalid ? (
              <>
                <div className="callout callout--error" role="alert">
                  汇报数据格式异常（以下为原始报文快照）
                </div>
                <pre className="code-block-pre selectable">
                  <code>{view.rawText}</code>
                </pre>
              </>
            ) : (
              <ExpandedBody
                view={view}
                onOpenConversation={conversationId !== undefined ? () => ctx.openConversationDrawer(conversationId) : undefined}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 展开态：完整 runId、投递时间、结果正文、错误诊断与在途任务快照。 */
function ExpandedBody({
  view,
  onOpenConversation,
}: {
  view: BackgroundReportView
  onOpenConversation?: () => void
}): ReactNode {
  const isFailure = view.status === 'failed' || view.status === 'aborted'
  return (
    <>
      <div className="workflow-report-meta-head">
        <div className="kv-grid">
          <span className="kv-key">运行 ID</span>
          <span className="kv-val mono">{view.runId}</span>
          {view.createdAt !== undefined ? (
            <>
              <span className="kv-key">投递时间</span>
              <span className="kv-val tabular-nums">{formatCompactTimestamp(view.createdAt)}</span>
            </>
          ) : null}
          <span className="kv-key">任务类型</span>
          <span className="kv-val">{view.kind === 'subagent_report' ? '后台子代理' : '工作流'}</span>
          {view.executionConversationId !== undefined ? (
            <>
              <span className="kv-key">子会话</span>
              <span className="kv-val">
                {onOpenConversation !== undefined ? (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={onOpenConversation}>
                    {`#${view.executionConversationId}`}
                  </button>
                ) : (
                  `#${view.executionConversationId}`
                )}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {view.error !== undefined && view.error !== '' ? (
        <div className={`callout ${isFailure ? 'callout--error' : 'callout--warning'}`} role={isFailure ? 'alert' : undefined}>
          {view.error}
        </div>
      ) : null}

      {view.hasResult ? (
        <div>
          <div className="trace-section-label">结果正文</div>
          {typeof view.result === 'string' ? (
            <MarkdownText text={view.result} />
          ) : (
            <pre className="code-block-pre">
              <code>{JSON.stringify(view.result, null, 2)}</code>
            </pre>
          )}
        </div>
      ) : (
        <div className="subagent-stream-empty">本次运行未携带结果数据。</div>
      )}

      {view.otherRunningTasks.length > 0 ? (
        <div>
          <div className="trace-section-label">投递时其余在途任务（快照）</div>
          <div className="execution-report-tasks">
            {view.otherRunningTasks.map((task) => (
              <span key={task.runId} className="badge badge-neutral workflow-report-task-item">
                <span>{task.name}</span>
                <span className="mono">{task.runId}</span>
                <span>{task.kind === 'subagent' ? '子代理' : '工作流'}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
