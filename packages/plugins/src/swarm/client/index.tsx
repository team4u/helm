/**
 * builtin:swarm plugin client.tsx entry (component & type exports only, Fast
 * Refresh compliant):
 * - SwarmToolView: 26px natural-language tool trace rows for all swarm_*
 *   tools (member rows open the conversation drawer, orchestration rows open
 *   the workbench panel, unknown targets expand raw details);
 * - SwarmActiveTray: composer dock in-flight HUD (working/blocked members of
 *   the current conversation's active group; null when idle);
 * - SwarmWorkbenchPanel: conversation-scoped orchestration card in the right
 *   workbench drawer;
 * - SwarmBoardReportPill / SwarmBoardWakeupPill: compact 1-line receipt pills
 *   for the durable board report / wakeup inputs.
 */
import './styles.css'
import type { ReactNode } from 'react'
import type { ComposerScopeProps, TimelineRendererProps, ToolViewProps, WorkbenchPanelProps } from '@helm/protocol'
import { SwarmToolView as SwarmToolViewImpl } from './SwarmToolView.tsx'
import { SwarmActiveTray as SwarmActiveTrayImpl } from './SwarmActiveTray.tsx'
import { SwarmWorkbenchPanel as SwarmWorkbenchPanelImpl } from './SwarmWorkbenchPanel.tsx'
import {
  SwarmBoardReportPill as BoardReportPillImpl,
  SwarmBoardWakeupPill as BoardWakeupPillImpl,
} from './BoardReceipts.tsx'

export function SwarmToolView(props: ToolViewProps): ReactNode {
  return <SwarmToolViewImpl {...props} />
}

export function SwarmActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  return <SwarmActiveTrayImpl {...props} />
}

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  return <SwarmWorkbenchPanelImpl {...props} />
}

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  return <BoardReportPillImpl {...props} />
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  return <BoardWakeupPillImpl {...props} />
}
