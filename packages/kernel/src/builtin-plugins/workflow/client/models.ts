/**
 * builtin:workflow 插件 client 纯逻辑层公共门面（零 React/DOM 依赖）。
 *
 * 按域拆分为 model-format / model-subagent / model-run / model-worktree /
 * model-library / model-execution-tree，此处按原公开 API 显式再导出（内部
 * 导出如 inputString / inspectString 不经本门面暴露）；组件与 hooks 互引时
 * 直接引用具体 model-*.ts，勿反向引用本门面（防循环）。
 */

// 共享格式化工具（model-format.ts）
export { toolResultPreviewTruncated, isScrolledToBottom, firstLineOf } from './model-format.ts'

// subagent 运行期关联 / 徽章与头部摘要 / 实时流 / siblingCalls（model-subagent.ts）
export {
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  subagentBadge,
  compactCardTitle,
  resolveSubagentTaskTitle,
  formatShortModelName,
  resolveSubagentElapsedMs,
  toolSummaryText,
  formatSemanticToolAction,
  extractSubagentResultPreview,
  resolveSubagentHeaderSnippet,
  buildSubagentStreamLines,
  buildSubagentStatSegments,
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
} from './model-subagent.ts'
export type {
  SubagentCardStatus,
  SubagentStreamLine,
  SubagentExecutionInfo,
  SubagentExecutionMeta,
  SubagentBadge,
  SubagentParentToolSummary,
  SubagentHeaderSnippet,
} from './model-subagent.ts'

// 工作流运行卡纯逻辑（model-run.ts）
export {
  resolveWorkflowRunForTool,
  hasNodeExtraDetail,
  formatNodeOutputPreview,
  resolveNodeSummaryText,
  buildWorkflowPhaseSections,
  extractWorkflowLogs,
  canResumeWorkflowRun,
  canReplayWorkflowRun,
  formatWorkflowNodeStats,
} from './model-run.ts'
export type { NodeSummaryText, WorkflowPhaseSection, WorkflowLogLine } from './model-run.ts'

// 受管工作树只读检视（model-worktree.ts）
export { parseWorktreeInspectResult, buildWorktreeSelector, buildWorktreeReviewRequest } from './model-worktree.ts'
export type { WorktreeInspectView } from './model-worktree.ts'

// 工作流库严格解析与 args 解析（model-library.ts）
export {
  parseSavedWorkflowList,
  parseWorkflowDetail,
  parseWorkflowSaveResult,
  canSaveRunAsWorkflow,
  buildWorkflowEditRequest,
  parseWorkflowArgsInput,
} from './model-library.ts'
export type { SavedWorkflowView, SavedWorkflowDetailView } from './model-library.ts'

// 统一执行树（model-execution-tree.ts）
export {
  aggregateExecutionStatuses,
  executionConversationStatus,
  executionRunStatus,
  executionRunNodeStatus,
  effectiveRunNodeStatus,
  executionToolStatus,
  executionNodeTitle,
  collectExecutionFrontline,
  collectExecutionApprovals,
  aggregateExecutionNodes,
  buildExecutionTree,
} from './model-execution-tree.ts'
export type {
  ExecutionNodeStatus,
  ExecutionNodeKind,
  ExecutionNode,
  ExecutionAggregate,
  ExecutionFrontlineItem,
  ExecutionApprovalItem,
  BuildExecutionTreeInput,
} from './model-execution-tree.ts'
