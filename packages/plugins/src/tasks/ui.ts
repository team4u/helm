/**
 * builtin:tasks UI 注册（仅显示元数据；数据流走公开投影 doc `board`）：
 * - Rail 一级入口 task-board（order 5，先于 App Center 15 与工作流库 16）直达看板；
 * - sidebarSection 收口任务执行会话（task / task-archived 标签，默认折叠，
 *   不淹没常规智能体列表）；
 * - toolView 接管 5 个 task_* 工具的时间线回执卡（Slice 3 实现 TaskToolView）。
 */
import type { HelmxPluginContext } from '@helmx/protocol'

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
    collapsible: true,
    defaultCollapsed: true,
    order: 40,
  })

  ctx.ui.sidebarSection({
    id: 'task-archived-conversations',
    label: { en: 'Completed Tasks', 'zh-CN': '已完成任务' },
    icon: 'archive',
    filterTag: 'task-archived',
    collapsible: true,
    defaultCollapsed: true,
    order: 95,
  })

  ctx.ui.toolView({
    id: 'task-tool-card',
    toolNames: [...TASK_TOOL_NAMES],
    replaceRow: true,
    client: { module: 'index.tsx', export: 'TaskToolView' },
  })
}
