import type { HelmPluginContext } from '@helm/protocol'
import {
  RECALL_DOC_NAME,
  ROUTER_TOOL_SCOPE,
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  WATCHDOG_PROFILE_ID,
  WORKER_ARCHIVED_TAG,
  WORKER_REPORT_RENDERER,
  WORKER_TAG,
} from './contracts.js'

export function registerSuperAgentUi(ctx: HelmPluginContext): void {
  ctx.ui.sidebarItem({
    id: 'superagent-router',
    label: 'SuperAgent 中枢',
    target: `conversation:profile:${SUPERAGENT_PROFILE_ID}`,
    order: 10,
  })
  ctx.ui.sidebarItem({
    id: 'superagent-watchdog',
    label: '巡检看门狗',
    target: `conversation:profile:${WATCHDOG_PROFILE_ID}`,
    order: 11,
  })
  ctx.ui.sidebarItem({
    id: 'superagent-recall',
    label: '记忆与订阅图谱',
    icon: 'git-fork',
    target: `screen:${SUPERAGENT_PLUGIN_ID}/${RECALL_DOC_NAME}`,
    order: 12,
  })
  ctx.ui.sidebarSection({
    id: 'superagent-workers',
    label: '后台 Worker',
    icon: 'boxes',
    filterTag: WORKER_TAG,
    order: 20,
  })
  ctx.ui.sidebarSection({
    id: 'archived-workers',
    label: '已归档 Worker',
    icon: 'archive',
    filterTag: WORKER_ARCHIVED_TAG,
    collapsible: true,
    defaultCollapsed: true,
    order: 90,
  })
  ctx.ui.composerWidget({
    id: 'superagent-router-status',
    title: '中枢态势',
    scope: ROUTER_TOOL_SCOPE,
    client: { module: 'index.tsx', export: 'SuperAgentComposerWidget' },
  })
  ctx.ui.composerPill({
    id: 'superagent-router-mode',
    label: '中枢路由',
    title: '中枢路由收敛模式',
    scope: ROUTER_TOOL_SCOPE,
    client: { module: 'index.tsx', export: 'SuperAgentRouterModePill' },
  })
  ctx.ui.toolView({
    id: 'superagent-dispatch',
    title: '派工状态',
    toolNames: ['dispatch_worker'],
    client: { module: 'index.tsx', export: 'SuperAgentDispatchToolView' },
  })
  ctx.ui.timelineRenderer({
    id: 'superagent-worker-report',
    title: 'Worker 汇报卡',
    matchMeta: { renderer: WORKER_REPORT_RENDERER },
    client: { module: 'index.tsx', export: 'SuperAgentWorkerReportCard' },
  })
  ctx.ui.screen({
    id: RECALL_DOC_NAME,
    label: '记忆与订阅图谱',
    icon: 'git-fork',
    client: { module: 'index.tsx', export: 'SuperAgentRecallScreen' },
  })
  ctx.ui.settingsPanel({
    id: 'superagent-settings',
    label: 'SuperAgent 中枢',
    order: 30,
    client: { module: 'index.tsx', export: 'SuperAgentSettingsPanel' },
  })
}
