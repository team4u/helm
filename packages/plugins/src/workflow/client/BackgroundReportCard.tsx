/**
 * builtin:workflow background settlement reports (timeline.renderer precisely
 * taking over helm.input):
 * - collapsed by default into a 26px single-line receipt sharing the host's
 *   `.trace-row` structure; failed/aborted/corrupted payloads default to
 *   expanded;
 * - clicking the title button expands the lossless report panel in place
 *   (full runId, delivered-at, complete Markdown/JSON result, error info and
 *   the snapshot of other in-flight tasks); no live state subscription, no
 *   fabricated missing data.
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helm/protocol'
import { CopyButton, MarkdownText, StatusLight, formatCompactTimestamp, usePluginContext, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'
import {
  REPORT_INVALID_BADGE,
  REPORT_INVALID_CALLOUT,
  REPORT_INVALID_PREVIEW,
  REPORT_INVALID_TITLE,
  REPORT_KV_DELIVERED_AT,
  REPORT_KV_RUN_ID,
  REPORT_KV_SUBAGENT,
  REPORT_KV_TASK_NAME,
  REPORT_KV_TASK_TYPE,
  REPORT_KIND_SUBAGENT,
  REPORT_KIND_WORKFLOW,
  REPORT_NO_RESULT,
  REPORT_OTHER_TASKS_SECTION,
  REPORT_RESULT_SECTION,
  REPORT_SUBAGENT_TITLE,
  REPORT_WORKFLOW_TITLE,
  reportOpenChildTitle,
  reportToggleLabel,
  runStatusLabel,
} from './copy.ts'
import { Icon } from './WorkflowIcon.tsx'
import { isPlaceholderRunName } from './model-format.ts'
import {
  backgroundReportPreview,
  isBackgroundReportDefaultOpen,
  parseBackgroundReportEntry,
} from './model-background-report.ts'
import type { BackgroundReportView } from './model-background-report.ts'

const PREVIEW_MAX_CHARS = 120

export function BackgroundReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const view = useMemo(() => parseBackgroundReportEntry(props.entry), [props.entry])
  const [open, setOpen] = useState(() => isBackgroundReportDefaultOpen(view))
  const bodyId = useId()

  const conversationId = view.invalid ? undefined : view.executionConversationId
  const reportName = !view.invalid ? view.name : undefined
  const isFailure = !view.invalid && (view.status === 'failed' || view.status === 'aborted')
  const title = view.invalid
    ? t(REPORT_INVALID_TITLE)
    : view.kind === 'subagent_report'
      ? t(REPORT_SUBAGENT_TITLE)
      : t(REPORT_WORKFLOW_TITLE)
  const preview = view.invalid ? t(REPORT_INVALID_PREVIEW) : backgroundReportPreview(view, PREVIEW_MAX_CHARS, locale)
  const rowTitle =
    reportName !== undefined
      ? `${title} · ${reportName}`
      : conversationId !== undefined
        ? `${title} #${conversationId}`
        : title

  return (
    <div className="trace-entry">
      <div className={`trace-row${isFailure || view.invalid ? ' trace-row-error' : ''}`}>
        <button
          type="button"
          className="trace-row-left workflow-trace-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={reportToggleLabel(rowTitle, open, locale)}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <Icon name={!view.invalid && view.kind === 'workflow_report' ? 'workflow' : 'bot'} size={12} />
          <span className="trace-tool-name" title={rowTitle}>{rowTitle}</span>
          {reportName !== undefined && conversationId !== undefined ? (
            <span className="workflow-trace-id tabular-nums">{`#${conversationId}`}</span>
          ) : null}
          {preview !== '' ? (
            <span className={`trace-tool-summary${isFailure || view.invalid ? ' workflow-trace-error' : ''}`} title={preview}>
              {preview}
            </span>
          ) : null}
        </button>
        <span className="trace-row-right workflow-trace-right">
          {view.invalid ? (
            <StatusLight status="failed" label={t(REPORT_INVALID_BADGE)} />
          ) : (
            <StatusLight status={view.status} label={runStatusLabel(view.status, locale)} />
          )}
          {view.createdAt !== undefined ? (
            <span className="trace-duration tabular-nums">{formatCompactTimestamp(view.createdAt)}</span>
          ) : null}
          <CopyButton text={view.rawText} className="btn btn-ghost btn-xs" />
          {conversationId !== undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              title={reportOpenChildTitle(conversationId, locale)}
              aria-label={reportOpenChildTitle(conversationId, locale)}
              onClick={() => ctx.openConversationDrawer(conversationId)}
            >
              <Icon name="external-link" size={11} />
            </button>
          ) : null}
        </span>
      </div>

      {/* A bare div carries `hidden` so flex container styles cannot override the UA [hidden] rule. */}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="trace-expanded-body workflow-report-expanded selectable">
            {view.invalid ? (
              <>
                <div className="callout callout--error" role="alert">
                  {t(REPORT_INVALID_CALLOUT)}
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

/** Expanded state: full runId, delivered-at, result body, error diagnostics and the in-flight tasks snapshot. */
function ExpandedBody({
  view,
  onOpenConversation,
}: {
  view: BackgroundReportView
  onOpenConversation?: () => void
}): ReactNode {
  const t = usePluginTranslator()
  const isFailure = view.status === 'failed' || view.status === 'aborted'
  return (
    <>
      <div className="workflow-report-meta-head">
        <div className="kv-grid">
          {view.name !== undefined ? (
            <>
              <span className="kv-key">{t(REPORT_KV_TASK_NAME)}</span>
              <span className="kv-val">{view.name}</span>
            </>
          ) : null}
          <span className="kv-key">{t(REPORT_KV_RUN_ID)}</span>
          <span className="kv-val mono">{view.runId}</span>
          {view.createdAt !== undefined ? (
            <>
              <span className="kv-key">{t(REPORT_KV_DELIVERED_AT)}</span>
              <span className="kv-val tabular-nums">{formatCompactTimestamp(view.createdAt)}</span>
            </>
          ) : null}
          <span className="kv-key">{t(REPORT_KV_TASK_TYPE)}</span>
          <span className="kv-val">{view.kind === 'subagent_report' ? t(REPORT_KIND_SUBAGENT) : t(REPORT_KIND_WORKFLOW)}</span>
          {view.executionConversationId !== undefined ? (
            <>
              <span className="kv-key">{t(REPORT_KV_SUBAGENT)}</span>
              <span className="kv-val">
                {onOpenConversation !== undefined ? (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={onOpenConversation}>
                    {view.name !== undefined
                      ? `${view.name} (#${view.executionConversationId})`
                      : `#${view.executionConversationId}`}
                  </button>
                ) : (
                  view.name !== undefined
                    ? `${view.name} (#${view.executionConversationId})`
                    : `#${view.executionConversationId}`
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
          <div className="trace-section-label">{t(REPORT_RESULT_SECTION)}</div>
          {typeof view.result === 'string' ? (
            <MarkdownText text={view.result} />
          ) : (
            <pre className="code-block-pre">
              <code>{JSON.stringify(view.result, null, 2)}</code>
            </pre>
          )}
        </div>
      ) : (
        <div className="subagent-stream-empty">{t(REPORT_NO_RESULT)}</div>
      )}

      {view.otherRunningTasks.length > 0 ? (
        <div>
          <div className="trace-section-label">{t(REPORT_OTHER_TASKS_SECTION)}</div>
          <div className="execution-report-tasks">
            {view.otherRunningTasks.map((task) => (
              <span key={task.runId} className="badge badge-neutral workflow-report-task-item">
                {!isPlaceholderRunName(task.name, task.runId) ? <span>{task.name}</span> : null}
                <span className="mono">{task.runId}</span>
                <span>{task.kind === 'subagent' ? t(REPORT_KIND_SUBAGENT) : t(REPORT_KIND_WORKFLOW)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
