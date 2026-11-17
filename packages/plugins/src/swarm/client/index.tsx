/**
 * builtin:swarm plugin client.tsx entry (component & type exports only, Fast
 * Refresh compliant):
 * - SwarmBoardScreen: adaptive collaboration board & 540px member drawer;
 * - SwarmOpenBoardAction: conversation:header ('toolbar') bidirectional board
 *   button with live badge count & tone;
 * - SwarmBoardReportPill / SwarmBoardWakeupPill: compact 1-line board batch
 *   receipt pills.
 */
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps, TimelineRendererProps } from '@helm/protocol'
import { BoardScreen } from './BoardScreen.tsx'
import {
  SwarmBoardReportPill as BoardReportPillImpl,
  SwarmBoardWakeupPill as BoardWakeupPillImpl,
  SwarmOpenBoardAction as OpenBoardActionImpl,
  type SwarmOpenBoardActionProps,
} from './HeaderBoardAction.tsx'

export type { SwarmOpenBoardActionProps }

export function SwarmBoardScreen(props: ScreenProps): ReactNode {
  return <BoardScreen {...props} />
}

export function SwarmOpenBoardAction(props: SwarmOpenBoardActionProps): ReactNode {
  return <OpenBoardActionImpl {...props} />
}

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  return <BoardReportPillImpl {...props} />
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  return <BoardWakeupPillImpl {...props} />
}
