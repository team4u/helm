/**
 * builtin:tasks tool-call timeline receipt (26px `.trace-row` style, aligned
 * with the swarm trace conventions):
 * - parses the task pointer (id / title / conversationId) leniently from the
 *   tool input plus the kernel-serialized structured result;
 * - re-derives the *current* live state from the public board doc +
 *   conversation summaries, so the receipt keeps tracking the real column and
 *   light long after the tool call finished (zero fabricated progress);
 * - click behavior: a resolvable execution conversation opens the drawer,
 *   otherwise the board screen deep-links to the task.
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
  type TaskLightStatus,
} from './models.ts'
import {
  TASK_TOOL_STATUS_DONE,
  TASK_TOOL_STATUS_ERROR,
  TASK_TOOL_STATUS_RUNNING,
  TASK_TOOL_TASK_MISSING,
  taskColumnLabel,
  taskLightLabel,
  taskToolAutoStarted,
  taskToolOpenBoardLabel,
  taskToolOpenConversationLabel,
  taskToolTitle,
  taskToolUnblocked,
} from './copy.ts'

/** Light word for the shared StatusLight (tone normalization lives in the SDK). */
function lightWord(status: TaskLightStatus): string {
  if (status === 'error') return 'error'
  if (status === 'blocked') return 'blocked'
  if (status === 'running' || status === 'background') return 'working'
  if (status === 'done') return 'done'
  return 'idle'
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

  const tasksById = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board])
  const task = facts.taskId !== undefined ? tasksById.get(facts.taskId) : undefined
  const live = useMemo(
    () => (task !== undefined ? deriveTaskLiveView(task, conversations, undefined, tasksById, locale) : undefined),
    [task, conversations, tasksById, locale],
  )

  const isRunning = props.status === 'running'
  const isError = props.status === 'error'
  useToolActivity(props.callId, isRunning)

  const conversationId = task?.conversationId ?? facts.conversationId

  const title = taskToolTitle(props.toolName, locale)
  const summaryParts: string[] = []
  if (facts.taskId !== undefined) summaryParts.push(facts.taskId)
  const displayTitle = task?.title ?? facts.title
  if (displayTitle !== undefined) summaryParts.push(displayTitle)
  if (facts.unblockedCount !== undefined && facts.unblockedCount > 0) {
    summaryParts.push(taskToolUnblocked(facts.unblockedCount, locale))
  }
  if (facts.autoStartedCount !== undefined && facts.autoStartedCount > 0) {
    summaryParts.push(taskToolAutoStarted(facts.autoStartedCount, locale))
  }
  const errorFirstLine =
    isError && typeof props.result === 'string' && props.result.trim() !== ''
      ? (props.result.split(/\r?\n/, 1)[0] ?? '').trim()
      : undefined
  const summary =
    isError && errorFirstLine !== undefined && errorFirstLine !== '' ? errorFirstLine : summaryParts.join(' · ')

  const liveLight = live !== undefined ? lightWord(live.lightStatus) : undefined
  const lightStatus = isRunning ? 'running' : isError ? 'error' : liveLight !== undefined ? liveLight : 'done'
  const lightLabel = isRunning
    ? resolveLocalizedText(TASK_TOOL_STATUS_RUNNING, locale)
    : isError
      ? resolveLocalizedText(TASK_TOOL_STATUS_ERROR, locale)
      : live !== undefined
        ? taskLightLabel(live.lightStatus, locale)
        : resolveLocalizedText(TASK_TOOL_STATUS_DONE, locale)

  const columnBadge = task !== undefined ? taskColumnLabel(task.column, locale) : undefined
  const missingNote = task === undefined && facts.taskId !== undefined && !isRunning

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
    <div className="trace-entry">
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
            <span className="badge badge-neutral task-trace-badge">{columnBadge}</span>
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
    </div>
  )
}
