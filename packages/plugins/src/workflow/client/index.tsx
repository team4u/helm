/**
 * builtin:workflow 插件 client.module 唯一编译入口（薄门面）：
 * 组件按职责拆分在同目录各模块（WorkflowIcon / SubagentCard 与其子视图模块
 * SubagentCardDetails / SubagentToolView / ExecutionChildrenRows /
 * ExternalRunSummary / WorkflowRunCard / WorkflowNodeCards / WorkflowReplayForm /
 * WorkflowLibrary 族 / WorkflowWorkbenchPanel），此处仅保留宿主加载器与
 * workflow.ts 模块引用所需的公开导出与样式挂载（样式按族拆分：执行树
 * styles-execution-tree / 实时流 styles-subagent-stream 等）；
 * 内部模块直接互引具体文件，勿反向引用本门面（防循环）。
 */
import './styles.css'
import './styles-execution-tree.css'
import './styles-subagent-stream.css'
import './styles-workflow-run.css'
import './styles-worktree-inspect.css'
import './styles-active-tray.css'
import './styles-workflow-library.css'

export { SubagentLiveCard } from './SubagentCard.tsx'
export { SubagentToolView } from './SubagentToolView.tsx'
export { WorkflowActiveTray } from './WorkflowActiveTray.tsx'
export { WorkflowToolView } from './WorkflowRunCard.tsx'
export { WorkflowLibraryScreen } from './WorkflowLibrary.tsx'
export type { WorkflowLibraryScreenProps } from './WorkflowLibrary.tsx'
export { WorkflowWorkbenchPanel } from './WorkflowWorkbenchPanel.tsx'
export { BackgroundReportCard } from './BackgroundReportCard.tsx'
