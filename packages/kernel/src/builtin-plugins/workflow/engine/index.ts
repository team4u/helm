/**
 * SubagentWorkflow 引擎出口。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植（runtime/worker-source/meta/
 * journal/json-schema/progress），helm 适配：action() 原语 + 统一前缀重放账本
 * （started/终态 fsync 与 uncertain 恢复语义）+ WorkflowService 宿主服务。
 */

export {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowServiceOptions,
  type WorkflowStateStore,
} from './service.js'
export {
  runWorkflow,
  normalizeWorkflowArgs,
  validateScript,
  precheckScriptSyntax,
  assertBoundarySafe,
  workflowConcurrency,
  WorkflowRuntimeError,
  MAX_SCRIPT_LENGTH,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  type RunWorkflowOptions,
  type WorkflowRunResult,
  type WorkflowHost,
  type ResumeAgentOptions,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
  type WorkflowGateResult,
  type WorkflowControl,
  type WorkflowScriptRef,
  type WorkflowScriptSource,
} from './runtime.js'
export { extractMeta, hasMetaDeclaration, WorkflowMetaError, type WorkflowMeta } from './meta.js'
export {
  readJournal,
  JournalWriter,
  JournalWriteError,
  agentJournalKey,
  actionJournalKey,
  type JournalReadResult,
  type AgentJournalKeyInput,
} from './journal.js'
export { compileJsonSchema, type CompiledSchema, type SchemaCompilation } from './json-schema.js'
export {
  collapse,
  stats,
  displayState,
  buildPhaseGroups,
  formatDuration,
  type WorkflowEntry,
  type WorkflowAgentEntry,
  type WorkflowActionEntry,
  type WorkflowEntryState,
  type WorkflowDisplayState,
  type CollapsedProgress,
  type PhaseGroup,
  type WorkflowStats,
} from './progress.js'
export { WORKER_SOURCE } from './worker-source.js'
