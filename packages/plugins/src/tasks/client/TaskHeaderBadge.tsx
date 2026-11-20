/**
 * builtin:tasks conversation:header badge (ctx.ui.action, placement 'toolbar'):
 * - the single in-conversation anchor binding an execution conversation back
 *   to its board task — icon + task id + honest status word (kickoff
 *   undelivered overrides the column label), tone-coded by data-column
 *   semantics shared with the overview pill (in_review = warn, in_progress =
 *   accent, done = ok);
 * - click deep-links to `screen:builtin:tasks/board?task=<id>` (the board
 *   detail drawer owns every planner action — approve/rework stay there by
 *   the anti-self-approval invariant);
 * - data comes from the public `board` doc projection; tasks truncated out
 *   of the projection (>50 archived history) or doc-not-loaded-yet render
 *   nothing — zero visual residue, never a fabricated state.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helmx/protocol'
import { HelmxIcon, usePluginContext, usePluginDoc, usePluginLocale } from '@helmx/plugin-client'
import { findTaskForConversation, parseTaskBoardDoc } from './models.ts'
import { taskHeaderBadgeStatus, taskHeaderBadgeTitle } from './copy.ts'

export interface TaskHeaderBadgeProps {
  conversation: ConversationSummary
}

export function TaskHeaderBadge(props: TaskHeaderBadgeProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const rawBoard = usePluginDoc<unknown>('board')
  const task = useMemo(() => {
    const board = parseTaskBoardDoc(rawBoard)
    return board === undefined ? undefined : findTaskForConversation(board.tasks, props.conversation.id)
  }, [rawBoard, props.conversation.id])

  if (task === undefined) return null

  return (
    <button
      type="button"
      className="task-header-badge"
      data-column={task.column}
      data-kickoff-undelivered={task.kickoffUndelivered === true ? 'true' : undefined}
      title={taskHeaderBadgeTitle(task, locale)}
      onClick={(e) => {
        e.stopPropagation()
        ctx.openScreen(`screen:builtin:tasks/board?task=${encodeURIComponent(task.id)}`)
      }}
    >
      <HelmxIcon name={task.kickoffUndelivered === true ? 'alert-triangle' : 'check-square'} size={11} />
      <span className="task-header-badge-id">{task.id}</span>
      <span className="task-header-badge-column">{taskHeaderBadgeStatus(task, locale)}</span>
    </button>
  )
}
