/**
 * Sole compiled entry (thin facade) of the builtin:workflow plugin's
 * client.module: components are split by responsibility into sibling modules
 * (WorkflowIcon / SubagentCard with its sub-views SubagentCardDetails /
 * SubagentToolView / ExecutionChildrenRows / ExternalRunSummary /
 * WorkflowRunCard / WorkflowNodeCards / WorkflowReplayForm / the
 * WorkflowLibrary family / WorkflowWorkbenchPanel); only the public exports
 * needed by the host loader and the workflow.ts module reference remain here,
 * plus style mounting (styles split by family: execution tree
 * styles-execution-tree / live stream styles-subagent-stream, ...). Internal
 * modules import each other's concrete files directly — never import back
 * from this facade (avoids cycles). Display copy lives in copy.ts and
 * resolves against the active host locale.
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
