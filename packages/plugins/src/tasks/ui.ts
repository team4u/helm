/**
 * builtin:tasks UI 注册（仅显示元数据；数据流走公开投影 doc `board`）：
 * - Rail 一级入口 task-board（order 5，先于 App Center 15 与工作流库 16）直达看板；
 * - sidebarSection 收口任务执行会话（task 标签 + keptAliveTag task-archived：
 *   结单/归档后换标签仍留在「任务执行」分组沉底，不回流智能体站位，
 *   侧栏不另设第二归档抽屉）；
 * - toolView 接管 5 个 task_* 工具的时间线回执卡（Slice 3 实现 TaskToolView）；
 * - slot 向宿主会话总览卡片元数据区（OVERVIEW_CARD_META_SLOT）贡献只读跳转胶囊
 *   （scope 限定任务执行会话：tags 字段内 OR 匹配，普通对话不挂载零开销）；
 * - action 向会话头部（conversation:header toolbar）贡献任务锚点徽标 TaskHeaderBadge
 *   （scope 同上；点击深链看板任务详情，规划者动作仍归看板抽屉）。
 */
import { OVERVIEW_CARD_META_SLOT, type HelmxPluginContext } from '@helmx/protocol'
import { TASK_ACTIVE_TAG, TASK_ARCHIVED_TAG, TASK_BOARD_SIDEBAR_BADGE } from './contracts.js'

/** Model-facing task tool names (single source for the toolView trace registration). */
const TASK_TOOL_NAMES = [
  'task_create',
  'task_start',
  'task_submit',
  'task_approve',
  'task_rework',
] as const

export function registerTasksUi(ctx: HelmxPluginContext): void {
  ctx.ui.sidebarItem({
    id: 'task-board',
    label: { en: 'Task Board', 'zh-CN': '任务看板' },
    icon: 'check-square',
    target: 'screen:builtin:tasks/board',
    order: 5,
    quickEntry: true,
    // 通用徽标声明（宿主零插件 ID 特判）：订阅本插件公开 doc `board`，
    // 由 attentionCount / badgeTone / hasRunning / badgeSummary 派生
    // Rail、MobileQuickNav 与侧栏视图行的计数徽标 / 安静圆点 / tooltip。
    badge: TASK_BOARD_SIDEBAR_BADGE,
  })

  ctx.ui.screen({
    id: 'board',
    label: { en: 'Task Board', 'zh-CN': '任务看板' },
    icon: 'check-square',
    client: { module: 'index.tsx', export: 'TaskBoardScreen' },
  })

  ctx.ui.sidebarSection({
    id: 'task-conversations',
    label: { en: 'Task Runs', 'zh-CN': '任务执行' },
    icon: 'check-square',
    filterTag: 'task',
    keptAliveTag: 'task-archived',
    collapsible: true,
    defaultCollapsed: true,
    order: 40,
  })

  ctx.ui.toolView({
    id: 'task-tool-card',
    toolNames: [...TASK_TOOL_NAMES],
    replaceRow: true,
    client: { module: 'index.tsx', export: 'TaskToolView' },
  })

  // 会话总览卡片只读胶囊：scope.tags 字段内 OR 匹配——仅任务执行会话（含已归档）
  // 的总览卡挂载 TaskOverviewCardMeta，普通对话零渲染开销、零 doc 订阅。
  ctx.ui.slot({
    id: 'overview-card-meta',
    target: OVERVIEW_CARD_META_SLOT,
    scope: { tags: [TASK_ACTIVE_TAG, TASK_ARCHIVED_TAG] },
    client: { module: 'index.tsx', export: 'TaskOverviewCardMeta' },
  })

  // 会话头部任务锚点徽标（conversation:header 唯一的任务回链）：scope 同样
  // OR 匹配 task / task-archived 标签——结单换标签后徽标仍在（淡化）。点击深链
  // 看板任务详情抽屉；验收/返工等规划者动作留在看板（防自审自批不变量），
  // 徽标本身是只读导航锚，零动作权限面。
  ctx.ui.action({
    id: 'task-anchor',
    target: 'conversation:header',
    placement: 'toolbar',
    label: { en: 'Task', 'zh-CN': '任务' },
    icon: 'check-square',
    scope: { tags: [TASK_ACTIVE_TAG, TASK_ARCHIVED_TAG] },
    client: { module: 'index.tsx', export: 'TaskHeaderBadge' },
  })
}
