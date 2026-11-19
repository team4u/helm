/**
 * builtin:tasks client entry (component exports only, Fast Refresh
 * compliant). The compiled bundle mounts these through the host ScreenHost /
 * toolView registry:
 * - TaskBoardScreen — `screen:builtin:tasks/board` full-screen board;
 * - TaskToolView — live task receipts for the task_* tool calls in the chat
 *   timeline (replaceRow).
 */
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps, ToolViewProps } from '@helmx/protocol'
import { TaskBoardScreen as TaskBoardScreenImpl } from './TaskBoardScreen.tsx'
import { TaskToolView as TaskToolViewImpl } from './TaskToolView.tsx'

export function TaskBoardScreen(props: ScreenProps & { inlineDrawer?: boolean }): ReactNode {
  return <TaskBoardScreenImpl {...props} />
}

export function TaskToolView(props: ToolViewProps): ReactNode {
  return <TaskToolViewImpl {...props} />
}
