/**
 * @helm/kernel 运行时出口：KernelRuntime 与全部内部机制模块。
 */

export { KernelRuntime, type KernelRuntimeOptions } from './runtime.js'
export {
  isStrictSemVer,
  normalizeExplicitVersion,
  compareStrictSemVer,
  hubVersion,
  resetHubVersionCacheForTest,
} from './semver.js'
export { EventHub, type EventSubscription, type SnapshotProvider } from './events.js'
export { AskService, type AskSeqResolver, type AskSettled } from './asks.js'
export { ConversationTracker, deriveTitle, type TrackerEvents } from './conversations.js'
export { toConversationEntry, deriveConversationLive, type EntryRecordLike } from './entries.js'
export { openHelmDatabase, type HelmDatabase } from './sqlite.js'
export { HelmStore, convStatusOf, summaryOf, type ConvMeta, type AskRow, type ArtifactRow } from './store.js'
export { runShell, runGate, createBashTool, createReadTool, createWriteTool, createEditTool, createReadArtifactTool, type ShellRunResult } from './tools.js'
export { runNativeSpawn, validateJsonSchema, type NativeSpawnDeps } from './spawn.js'
export { buildModels, parseModelRef, requireModelRef, listModelCatalog, listModelProviders, type ModelCatalogEntry, type ModelGatewayOptions } from './models.js'
export { FileModelsStore, createFileModelsStore } from './models-store.js'
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
export { ConversationService, type ConversationServiceOptions, type SubmitInputOptions } from './conversation-service.js'
export { ConversationRewind, type ConversationRewindHost, type RewindNewInput } from './conversation-rewind.js'
export { ConversationAttachments, type ConversationAttachmentsHost, IMAGE_MIMES } from './conversation-attachments.js'
export { ConversationContextOps, type ConversationContextOpsHost } from './conversation-context-ops.js'
export { ConversationDetailService, type ConversationDetailHost, DETAIL_CURSOR_MAX_LENGTH } from './conversation-detail.js'
export { ConversationProfileService, type ConversationProfileHost } from './conversation-profile.js'
export { ConversationInputPipeline, type ConversationInputPipelineHost, type PreparedInputResult } from './conversation-input.js'
export { buildSpawnHost, toResolvedProfile, type SpawnHost, type SpawnHostSource } from './spawn-host.js'
export { createRunActionTool, type KernelToolHost } from './kernel-tools.js'
