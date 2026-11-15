/**
 * builtin:workflow 插件 client.module 唯一编译入口（薄门面）：
 * 组件按职责拆分在同目录各模块（WorkflowIcon / SubagentCard / ExecutionChildrenRows /
 * ExternalRunSummary / WorkflowRunCard / WorkflowNodeCards / WorkflowReplayForm /
 * WorkflowLibrary 族 / WorkflowWorkbenchPanel），此处仅保留宿主加载器与
 * workflow.ts 模块引用所需的公开导出与样式挂载；
 * 内部模块直接互引具体文件，勿反向引用本门面（防循环）。
 */
import './styles.css'
import './styles-workflow-run.css'
import './styles-worktree-inspect.css'
import './styles-workflow-library.css'

export { SubagentLiveCard, SubagentToolView } from './SubagentCard.tsx'
export { WorkflowToolView } from './WorkflowRunCard.tsx'
export { WorkflowLibraryScreen } from './WorkflowLibrary.tsx'
export type { WorkflowLibraryScreenProps } from './WorkflowLibrary.tsx'
export { WorkflowWorkbenchPanel } from './WorkflowWorkbenchPanel.tsx'
export { BackgroundReportCard } from './BackgroundReportCard.tsx'
