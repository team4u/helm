import type { PluginUiContribution } from '@helm/protocol'

/** 与 builtin:workflow 声明一致；宿主仅消费标准贡献，不导入后端插件模块。 */
export const workflowUi: PluginUiContribution[] = [
  { pluginId: 'builtin:workflow', surface: 'timeline.renderer', spec: {
    id: 'background-report', kinds: ['helm.input'], matchMeta: { renderer: 'workflow:background-report' },
    client: { module: 'index.tsx', export: 'BackgroundReportCard' },
  } },
  { pluginId: 'builtin:workflow', surface: 'tool.view', spec: {
    id: 'subagent-card', toolNames: ['subagent'], replaceRow: true, docs: ['runs'],
    client: { module: 'index.tsx', export: 'SubagentToolView' },
  } },
  { pluginId: 'builtin:workflow', surface: 'tool.view', spec: {
    id: 'workflow-card', toolNames: ['SubagentWorkflow'], replaceRow: true, docs: ['runs'],
    client: { module: 'index.tsx', export: 'WorkflowToolView' },
  } },
  { pluginId: 'builtin:workflow', surface: 'workbench.panel', spec: {
    id: 'tasks', label: '工作流与子代理', icon: 'git-branch', order: 10, docs: ['runs'],
    badge: { doc: 'runs', byConversationField: 'byConversation' },
    client: { module: 'index.tsx', export: 'WorkflowWorkbenchPanel' },
  } },
]
