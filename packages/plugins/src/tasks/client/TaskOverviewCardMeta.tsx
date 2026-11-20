/**
 * builtin:tasks contribution to the host conversation overview card meta slot
 * (OVERVIEW_CARD_META_SLOT — read-only jump pill):
 * - looks up the task bound to the card's conversation tree (exact root match
 *   first, then any tree member; non-archived + newest wins) via the public
 *   `board` doc projection and the pure models lookup;
 * - renders one compact pill (task id + column label + optional project) that
 *   deep-links to `screen:builtin:tasks/board?task=<id>`; the click stops
 *   propagation so it never triggers the outer overview card's own action;
 * - read-only by design: approvals / rework / start / merge stay on the board
 *   screen. No matching task (or doc not loaded yet) returns null — zero
 *   visual residue.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { OverviewCardMetaSlotProps } from '@helmx/protocol'
import { HelmxIcon, usePluginDoc, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { findTaskForOverviewCard, parseTaskBoardDoc } from './models.ts'
import { taskColumnLabel, taskToolOpenBoardLabel } from './copy.ts'

export function TaskOverviewCardMeta(props: OverviewCardMetaSlotProps): ReactNode {
  const { rootConversation, memberIds } = props
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const rawBoard = usePluginDoc<unknown>('board')
  const task = useMemo(() => {
    const board = parseTaskBoardDoc(rawBoard)
    return board === undefined ? undefined : findTaskForOverviewCard(board.tasks, rootConversation.id, memberIds)
  }, [rawBoard, rootConversation.id, memberIds])

  if (task === undefined) return null

  return (
    <button
      type="button"
      className="task-overview-pill"
      data-column={task.column}
      title={taskToolOpenBoardLabel(task.id, locale)}
      onClick={(e) => {
        e.stopPropagation()
        ctx.openScreen(`screen:builtin:tasks/board?task=${encodeURIComponent(task.id)}`)
      }}
    >
      <HelmxIcon name="check-square" size={11} />
      <span className="task-overview-pill-id">{task.id}</span>
      <span className="task-overview-pill-column">{taskColumnLabel(task.column, locale)}</span>
      {task.project !== undefined && task.project !== '' ? (
        <span className="task-overview-pill-project">{task.project}</span>
      ) : null}
    </button>
  )
}
