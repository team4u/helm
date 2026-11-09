/**
 * @helm/kernel 运行时出口：KernelRuntime 与全部内部机制模块。
 */

export { KernelRuntime, type KernelRuntimeOptions, type WorkflowRunnerFn } from './runtime.js'
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
export { ModelRegistry } from './model-registry.js'
export { HookBridge, prepareToolResultWith } from './hook-bridge.js'
export { ConversationService } from './conversation-service.js'
export { buildSpawnHost, toResolvedProfile, type SpawnHost, type SpawnHostSource } from './spawn-host.js'
export { createSubagentTool, createWorkflowTool, createRunActionTool, type KernelToolHost } from './kernel-tools.js'
