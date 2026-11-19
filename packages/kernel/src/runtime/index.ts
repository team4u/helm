/**
 * `@helm/kernel` runtime entry point: `KernelRuntime` and internal mechanism modules.
 */

export { KernelRuntime, type KernelRuntimeOptions } from './runtime.js'
export {
  startActivityHeartbeat,
  hubActivityFilePath,
  type ActivityHeartbeat,
  type ActivityHeartbeatOptions,
} from './activity-heartbeat.js'
export { readWorkspaceFile, type ConversationFileContent } from './workspace-files.js'
export {
  isStrictSemVer,
  normalizeExplicitVersion,
  compareStrictSemVer,
  hubVersion,
} from './semver.js'
export { EventHub, type SnapshotProvider } from './events.js'
export { AskService } from './asks.js'
export { ConversationTracker, deriveTitle, type TrackerEvents } from './conversations.js'
export { toConversationEntry, deriveConversationLive, type EntryRecordLike } from './entries.js'
export { openHelmDatabase, type HelmDatabase } from './sqlite.js'
export {
  createDiagnosticEmitter,
  defaultDiagnosticSink,
  emitDiagnostic,
  formatDiagnosticError,
  type KernelDiagnosticEmitter,
  type KernelDiagnosticEvent,
  type KernelDiagnosticInput,
  type KernelDiagnosticSink,
} from './diagnostics.js'
export { HelmStore, convStatusOf, summaryOf, type ConvMeta } from './store.js'
export { runShell, runGate, createBashTool, createReadTool, createWriteTool, createEditTool, createReadArtifactTool, createRegisterArtifactTool, type ShellRunResult } from './tools.js'
export { runNativeSpawn, type NativeSpawnDeps } from './spawn.js'
export { validateJsonSchema } from './structured-output.js'
export { buildModels, parseModelRef, requireModelRef, listModelCatalog, listModelProviders, type ModelCatalogEntry } from './models.js'
export { createFileModelsStore } from './models-store.js'
export type { HelmToolDeps } from './tool-deps.js'
export { NodeManager } from './node-manager.js'
export {
  shQuote,
  buildPosixHostShim,
  buildWindowsPosixShim,
  buildWindowsCmdWrapper,
  type CliShimPlan,
} from './cli-shim.js'
export { ModelRegistry } from './model-registry.js'
export { HookBridge, prepareToolResultWith } from './hook-bridge.js'
export { ConversationService, type SubmitInputOptions } from './conversation-service.js'
export { ConversationRewind } from './conversation-rewind.js'
export { ConversationAttachments } from './conversation-attachments.js'
export { ConversationContextOps } from './conversation-context-ops.js'
export { ConversationDetailService } from './conversation-detail.js'
export { ConversationProfileService } from './conversation-profile.js'
export { ConversationInputPipeline } from './conversation-input.js'
export { buildSpawnHost } from './spawn-host.js'
export { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
