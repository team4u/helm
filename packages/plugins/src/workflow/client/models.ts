/**
 * builtin:workflow 插件 client 纯逻辑层公共门面（零 React/DOM 依赖）。
 *
 * 按域拆分为 model-format / model-subagent-link / model-subagent-stream /
 * model-subagent-card / model-run / model-worktree / model-library /
 * model-execution-status / model-execution-view / model-execution-tree，此处按
 * 原公开 API 显式再导出（内部导出如 inputString / inspectString 不经本门面
 * 暴露）；组件与 hooks 互引时直接引用具体 model-*.ts，勿反向引用本门面
 * （防循环）。
 */

// 共享格式化工具（model-format.ts）
export {
  toolResultPreviewTruncated,
  isScrolledToBottom,
  firstLineOf,
  formatShortModelName,
  stringifyPretty,
} from './model-format.ts'

// subagent 运行期关联（model-subagent-link.ts）
export {
  resolveSubagentConversationId,
  resolveSubagentExecutionMeta,
  isLatestSubagentCallForTarget,
  parentToolSummaryOf,
} from './model-subagent-link.ts'
export type { SubagentExecutionInfo, SubagentExecutionMeta, SubagentParentToolSummary } from './model-subagent-link.ts'

// 工具行语义摘要与子会话实时流（model-subagent-stream.ts）
export {
  toolSummaryText,
  formatSemanticToolAction,
  buildSubagentStreamLines,
  buildSubagentStatSegments,
} from './model-subagent-stream.ts'
export type { SubagentStreamLine } from './model-subagent-stream.ts'

// 卡片状态徽章与头部摘要（model-subagent-card.ts）
export {
  subagentBadge,
  compactCardTitle,
  resolveSubagentTaskTitle,
  resolveSubagentElapsedMs,
  extractSubagentResultPreview,
  resolveSubagentHeaderSnippet,
} from './model-subagent-card.ts'
export type { SubagentCardStatus, SubagentBadge, SubagentHeaderSnippet } from './model-subagent-card.ts'

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
  resolveRunElapsedMs,
  resolveNodeElapsedMs,
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

// 统一执行树（model-execution-status / model-execution-view / model-execution-tree.ts）
export {
  aggregateExecutionStatuses,
  executionConversationStatus,
  executionRunStatus,
  executionRunNodeStatus,
  effectiveRunNodeStatus,
  executionToolStatus,
} from './model-execution-status.ts'
export {
  executionNodeTitle,
  resolveExecutionNodeElapsedMs,
  collectExecutionFrontline,
  collectExecutionApprovals,
} from './model-execution-view.ts'
export { buildExecutionTree, aggregateExecutionNodes } from './model-execution-tree.ts'
export type { ExecutionAggregate, ExecutionNodeStatus } from './model-execution-status.ts'
export type { ExecutionFrontlineItem, ExecutionApprovalItem } from './model-execution-view.ts'
export type { ExecutionNodeKind, ExecutionNode, BuildExecutionTreeInput } from './model-execution-tree.ts'
