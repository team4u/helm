/**
 * builtin:tasks client entry (component exports only, Fast Refresh
 * compliant). The compiled bundle mounts these through the host ScreenHost /
 * toolView / plugin-slot registry:
 * - TaskBoardScreen — `screen:builtin:tasks/board` full-screen board;
 * - TaskToolView — live task receipts for the task_* tool calls in the chat
 *   timeline (replaceRow);
 * - TaskOverviewCardMeta — read-only jump pill contributed to the host
 *   conversation overview card meta slot (OVERVIEW_CARD_META_SLOT);
 * - TaskHeaderBadge — conversation:header task anchor badge (toolbar).
 */
import './styles.css'
import type { ReactNode } from 'react'
import type { ConversationSummary, OverviewCardMetaSlotProps, ScreenProps, ToolViewProps } from '@helmx/protocol'
import { TaskBoardScreen as TaskBoardScreenImpl } from './TaskBoardScreen.tsx'
import { TaskToolView as TaskToolViewImpl } from './TaskToolView.tsx'
import { TaskOverviewCardMeta as TaskOverviewCardMetaImpl } from './TaskOverviewCardMeta.tsx'
import { TaskHeaderBadge as TaskHeaderBadgeImpl } from './TaskHeaderBadge.tsx'

export function TaskBoardScreen(props: ScreenProps & { inlineDrawer?: boolean }): ReactNode {
  return <TaskBoardScreenImpl {...props} />
}

export function TaskToolView(props: ToolViewProps): ReactNode {
  return <TaskToolViewImpl {...props} />
}

export function TaskOverviewCardMeta(props: OverviewCardMetaSlotProps): ReactNode {
  return <TaskOverviewCardMetaImpl {...props} />
}

export function TaskHeaderBadge(props: { conversation: ConversationSummary }): ReactNode {
  return <TaskHeaderBadgeImpl {...props} />
}
