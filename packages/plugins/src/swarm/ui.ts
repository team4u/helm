import type { ConversationScope, HelmPluginContext } from '@helm/protocol'

export const SWARM_UI_PLUGIN_ID = 'builtin:swarm' as const
export const SWARM_BOARD_SCREEN_ID = 'board' as const
export const SWARM_COORDINATOR_TAG = 'swarm-coordinator' as const
export const SWARM_WORKER_TAG = 'swarm-worker' as const
export const SWARM_BOARD_REPORT_RENDERER = 'swarm:board-report' as const
export const SWARM_BOARD_WAKEUP_RENDERER = 'swarm:board-wakeup' as const

const SWARM_PARTICIPANT_SCOPE: ConversationScope = {
  tags: [SWARM_COORDINATOR_TAG, SWARM_WORKER_TAG],
}

/**
 * Registration-time UI contributions for `builtin:swarm` (LocalizedText display
 * metadata only; intentionally leaves COMPOSER_DOCK_SLOT untouched so
 * WorkflowActiveTray keeps sole ownership).
 */
export function registerSwarmUi(ctx: HelmPluginContext): void {
  ctx.ui.sidebarItem({
    id: 'swarm-board',
    label: { en: 'Swarm Board', 'zh-CN': '协同流转看板' },
    icon: 'workflow',
    target: `screen:${SWARM_UI_PLUGIN_ID}/${SWARM_BOARD_SCREEN_ID}`,
    order: 15,
  })
  ctx.ui.screen({
    id: SWARM_BOARD_SCREEN_ID,
    label: { en: 'Swarm Board', 'zh-CN': '协同流转看板' },
    icon: 'workflow',
    client: { module: 'index.tsx', export: 'SwarmBoardScreen' },
  })
  ctx.ui.action({
    id: 'start-swarm-group',
    target: 'conversation:header',
    placement: 'menu',
    order: 20,
    label: { en: 'Start Swarm Collaboration', 'zh-CN': '开启协同组' },
    icon: 'workflow',
    client: { module: 'index.tsx', export: 'SwarmStartGroupAction' },
  })
  ctx.ui.action({
    id: 'open-swarm-board',
    target: 'conversation:header',
    placement: 'toolbar',
    order: 15,
    scope: SWARM_PARTICIPANT_SCOPE,
    label: { en: 'Swarm Board', 'zh-CN': '协同看板' },
    icon: 'workflow',
    client: { module: 'index.tsx', export: 'SwarmOpenBoardAction' },
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
