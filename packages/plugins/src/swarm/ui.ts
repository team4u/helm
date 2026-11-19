import { COMPOSER_DOCK_SLOT, type ConversationScope, type HelmxPluginContext } from '@helmx/protocol'

export const SWARM_WORKBENCH_PANEL_ID = 'groups' as const
export const SWARM_COORDINATOR_TAG = 'swarm-coordinator' as const
export const SWARM_COORDINATOR_ARCHIVED_TAG = 'swarm-coordinator-archived' as const
export const SWARM_WORKER_TAG = 'swarm-worker' as const
export const SWARM_WORKER_ARCHIVED_TAG = 'swarm-worker-archived' as const
export const SWARM_BOARD_REPORT_RENDERER = 'swarm:board-report' as const
export const SWARM_BOARD_WAKEUP_RENDERER = 'swarm:board-wakeup' as const

const SWARM_PARTICIPANT_SCOPE: ConversationScope = {
  tags: [SWARM_COORDINATOR_TAG, SWARM_WORKER_TAG],
}

// 结单历史 tag（含历史主控与已归档 Worker）仅放行工作台编排面板查看历史编组；活动托盘与 @/# 补全仍限活跃参与者。
const SWARM_HISTORY_VIEWER_SCOPE: ConversationScope = {
  tags: [SWARM_COORDINATOR_TAG, SWARM_COORDINATOR_ARCHIVED_TAG, SWARM_WORKER_TAG, SWARM_WORKER_ARCHIVED_TAG],
}

/** Model-facing swarm tool names (single source for the toolView trace registration). */
const SWARM_TOOL_NAMES = [
  'swarm_create_group',
  'swarm_update_group',
  'swarm_dispatch_worker',
  'swarm_board_post',
  'swarm_board_read',
  'swarm_board_status',
  'swarm_abort_worker',
  'swarm_switch_worker_model',
  'swarm_inspect_worker',
  'swarm_archive_worker',
  'swarm_close_group',
] as const

/**
 * Registration-time UI contributions for `builtin:swarm` (conversation-scoped
 * orchestration surfaces; display metadata only, data flows through the public
 * `index` / `board-badges` docs and the per-coordinator `board-view` session
 * doc).
 *
 * Same mental model as builtin:workflow: the timeline owns 26px tool trace
 * rows, the composer dock owns the in-flight tray, and the right workbench
 * owns the orchestration panel. No standalone board screen or header entry
 * fights the host for the primary stage.
 */
export function registerSwarmUi(ctx: HelmxPluginContext): void {
  ctx.ui.toolView({
    id: 'swarm-tool-trace',
    toolNames: [...SWARM_TOOL_NAMES],
    replaceRow: true,
    client: { module: 'index.tsx', export: 'SwarmToolView' },
  })
  ctx.ui.slot({
    id: 'swarm-active-tray',
    target: COMPOSER_DOCK_SLOT,
    scope: SWARM_PARTICIPANT_SCOPE,
    client: { module: 'index.tsx', export: 'SwarmActiveTray' },
  })
  ctx.ui.workbenchPanel({
    id: SWARM_WORKBENCH_PANEL_ID,
    label: { en: 'Swarm Groups', 'zh-CN': 'Swarm 协同编组' },
    icon: 'network',
    order: 12,
    scope: SWARM_HISTORY_VIEWER_SCOPE,
    badge: { doc: 'board-badges', byConversationField: 'byConversation' },
    client: { module: 'index.tsx', export: 'SwarmWorkbenchPanel' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-report',
    title: { en: 'Swarm Board Report', 'zh-CN': '协同看板汇总' },
    matchMeta: { renderer: SWARM_BOARD_REPORT_RENDERER },
    client: { module: 'index.tsx', export: 'SwarmBoardReportPill' },
  })
  ctx.ui.timelineRenderer({
    id: 'swarm-board-wakeup',
    title: { en: 'Swarm Board Wakeup', 'zh-CN': '协同看板唤醒' },
    matchMeta: { renderer: SWARM_BOARD_WAKEUP_RENDERER },
    client: { module: 'index.tsx', export: 'SwarmBoardWakeupPill' },
  })
  ctx.ui.composerCompleter({
    id: 'swarm-board-members',
    label: { en: 'Swarm Members', 'zh-CN': '协同组成员' },
    trigger: '@',
    priority: 120,
    scope: SWARM_PARTICIPANT_SCOPE,
    source: { kind: 'action', actionId: 'complete_board_members' },
  })
  ctx.ui.composerCompleter({
    id: 'swarm-board-channels',
    label: { en: 'Swarm Channels', 'zh-CN': '协同组频道' },
    trigger: '#',
    priority: 120,
    scope: SWARM_PARTICIPANT_SCOPE,
    source: { kind: 'action', actionId: 'complete_board_channels' },
  })
}
