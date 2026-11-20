/**
 * builtin:tasks tool-call timeline receipt (26px `.trace-row` style, aligned
 * with the swarm trace conventions):
 * - parses the task pointer (id / title / conversationId) leniently from the
 *   tool input plus the kernel-serialized structured result;
 * - re-derives the *current* live state from the public board doc +
 *   conversation summaries, so the receipt keeps tracking the real column and
 *   light long after the tool call finished (zero fabricated progress);
 * - the column badge is tone-coded by the real state (in_review = warn,
 *   done = ok, in_progress = accent / warn / err by severity, backlog =
 *   neutral) so awaiting-review work is instantly visible in the planning chat;
 * - in_review receipts carry a compact "Review" pill (outside the row button)
 *   that deep-links to `screen:builtin:tasks/board?task=<id>`; the main row
 *   click keeps opening the execution conversation drawer.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helmx/protocol'
import {
  HelmxIcon,
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  useToolActivity,
} from '@helmx/plugin-client'
import {
  deriveTaskLiveView,
  parseTaskBoardDoc,
  parseTaskToolFacts,
  parseTaskToolVerb,
  taskLightWord,
  type TaskRecord,
} from './models.ts'
import {
  TASK_TOOL_REVIEW,
  TASK_TOOL_REVIEW_TITLE,
  TASK_TOOL_STATUS_DONE,
  TASK_TOOL_STATUS_ERROR,
  TASK_TOOL_STATUS_RUNNING,
  TASK_TOOL_TASK_MISSING,
  taskColumnLabel,
  taskLightLabel,
  taskToolOpenBoardLabel,
  taskToolOpenConversationLabel,
  taskToolTitle,
} from './copy.ts'

/** Column badge tone from the real live state (drives the badge-* class). */
function columnBadgeTone(task: TaskRecord | undefined, lightStatus: ReturnType<typeof taskLightWord> | undefined): string {
  if (task === undefined) return 'badge-neutral'
  if (task.column === 'in_review') return 'badge-warn'
  if (task.column === 'done') return 'badge-ok'
  if (task.column === 'in_progress') {
    if (lightStatus === 'error') return 'badge-err'
    if (lightStatus === 'blocked') return 'badge-warn'
    return 'badge-accent'
  }
  return 'badge-neutral'
}

export function TaskToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const rawBoard = usePluginDoc<unknown>('board')
  const board = useMemo(() => parseTaskBoardDoc(rawBoard), [rawBoard])
  const conversations = useConversations()

  const facts = useMemo(
    () => parseTaskToolFacts(props.input, props.structuredOutput ?? props.result),
    [props.input, props.structuredOutput, props.result],
  )

  const tasksById = useMemo(() => new Map((board?.tasks ?? []).map((task) => [task.id, task])), [board])
  const task = facts.taskId !== undefined ? tasksById.get(facts.taskId) : undefined
  const live = useMemo(
    () => (task !== undefined ? deriveTaskLiveView(task, conversations, undefined, locale) : undefined),
    [task, conversations, locale],
  )

  const isRunning = props.status === 'running'
  const isError = props.status === 'error'
  useToolActivity(props.callId, isRunning)

  const conversationId = task?.conversationId ?? facts.conversationId

  const title = taskToolTitle(parseTaskToolVerb(props.toolName), locale)
  const summaryParts: string[] = []
  if (facts.taskId !== undefined) summaryParts.push(facts.taskId)
  const displayTitle = task?.title ?? facts.title
  if (displayTitle !== undefined) summaryParts.push(displayTitle)
  const errorFirstLine =
    isError && typeof props.result === 'string' && props.result.trim() !== ''
      ? (props.result.split(/\r?\n/, 1)[0] ?? '').trim()
      : undefined
  const summary =
    isError && errorFirstLine !== undefined && errorFirstLine !== '' ? errorFirstLine : summaryParts.join(' · ')

  const liveLight = live !== undefined ? taskLightWord(live.lightStatus) : undefined
  const lightStatus = isRunning ? 'running' : isError ? 'error' : liveLight !== undefined ? liveLight : 'done'
  const lightLabel = isRunning
    ? resolveLocalizedText(TASK_TOOL_STATUS_RUNNING, locale)
    : isError
      ? resolveLocalizedText(TASK_TOOL_STATUS_ERROR, locale)
      : live !== undefined
        ? taskLightLabel(live.lightStatus, locale)
        : resolveLocalizedText(TASK_TOOL_STATUS_DONE, locale)

  const columnBadge = task !== undefined ? taskColumnLabel(task.column, locale) : undefined
  const columnBadgeClass = isError
    ? 'badge-err'
    : columnBadgeTone(task, live?.lightStatus)
  const missingNote = task === undefined && facts.taskId !== undefined && !isRunning
  const showReviewPill = task?.column === 'in_review' && facts.taskId !== undefined

  const handleActivate = (): void => {
    if (conversationId !== undefined) {
      ctx.openConversationDrawer(conversationId)
      return
    }
    if (facts.taskId !== undefined) {
      ctx.openScreen(`screen:builtin:tasks/board?task=${encodeURIComponent(facts.taskId)}`)
    }
  }

  const clickLabel =
    conversationId !== undefined && facts.taskId !== undefined
      ? taskToolOpenConversationLabel(facts.taskId, locale)
      : facts.taskId !== undefined
        ? taskToolOpenBoardLabel(facts.taskId, locale)
        : undefined

  return (
    <div className="trace-entry task-trace-entry">
      <button
        type="button"
        className={`trace-row task-trace-row${isError ? ' trace-row-error' : ''}`}
        aria-label={`${title} — ${summary}${clickLabel !== undefined ? ` — ${clickLabel}` : ''}`}
        onClick={handleActivate}
      >
        <span className="trace-row-left">
          <HelmxIcon name="check-square" size={12} />
          <span className="trace-tool-name" title={title}>{title}</span>
          {summary !== '' ? (
            <span className={`trace-tool-summary task-trace-summary${isError ? ' task-trace-error' : ''}`} title={summary}>
              {summary}
            </span>
          ) : null}
          {missingNote ? (
            <span className="trace-tool-summary task-trace-summary text-subtle" title={resolveLocalizedText(TASK_TOOL_TASK_MISSING, locale)}>
              {resolveLocalizedText(TASK_TOOL_TASK_MISSING, locale)}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right">
          {columnBadge !== undefined ? (
            <span className={`badge ${columnBadgeClass} task-trace-badge`}>{columnBadge}</span>
          ) : null}
          <StatusLight status={lightStatus} label={lightLabel} />
          {!isRunning && props.durationMs !== undefined ? (
            <span className="trace-duration tabular-nums">{formatDurationMs(props.durationMs)}</span>
          ) : null}
          <HelmxIcon
            name={conversationId !== undefined ? 'external-link' : 'chevron-right'}
            size={11}
          />
        </span>
      </button>
      {showReviewPill ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost task-trace-review"
          title={resolveLocalizedText(TASK_TOOL_REVIEW_TITLE, locale)}
          onClick={() => {
            if (facts.taskId !== undefined) {
              ctx.openScreen(`screen:builtin:tasks/board?task=${encodeURIComponent(facts.taskId)}`)
            }
          }}
        >
          <HelmxIcon name="check-square" size={11} />
          <span>{resolveLocalizedText(TASK_TOOL_REVIEW, locale)}</span>
        </button>
      ) : null}
    </div>
  )
}
