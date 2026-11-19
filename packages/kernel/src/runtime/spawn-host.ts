/**
 * Host interface for native spawns (`SpawnHost`).
 *
 * Extracted from `runtime.ts`: `spawnAgentObserved` previously passed a 60+ line inline object literal
 * (a dozen closure callbacks) to `runNativeSpawn`, which became hard to maintain and was refined into
 * a named interface. `SpawnHost` is the host-side implementation contract of `NativeSpawnDeps`, aliasing
 * `NativeSpawnDeps` directly (single source of truth) while documenting host semantics per port here.
 */
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationAttachmentRef, ConversationPatch, ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { Profile } from '../services/index.js'
import { requireModelRef, type ModelRefParts } from './models.js'
import type { HelmxToolDeps } from './tool-deps.js'
import type { NativeSpawnDeps, ResolvedProfile } from './spawn.js'
import type { StructuredOutputSession } from './structured-output.js'

/**
 * Complete dependency bundle injected by the host into `runNativeSpawn` (snapshot registration, Profile resolution,
 * conversation config updates, extension installation, attachment block construction, and node availability checks).
 *
 * See `NativeSpawnDeps` in `spawn.ts` for per-port rationale (single source of truth);
 * this alias exists purely so `runtime.ts` and tests can reference it by an explicit name.
 */
type SpawnHost = NativeSpawnDeps

/** Authorized attachments (validated for existence and parent-chain ownership; used for prompt assembly). */
interface ResolvedAttachmentRef {
  ref: ConversationAttachmentRef
  absPath: string
}

/** Host capability provider used to construct `SpawnHost` (implemented and injected by `KernelRuntime`). */
interface SpawnHostSource {
  readonly toolDeps: HelmxToolDeps
  readonly harness: Harness
  readonly tracker: {
    getLastAssistantText(conversationId: number): string | undefined
  }
  readonly defaultModel: string | undefined
  readonly defaultThinkingLevel: string | undefined
  /** Per-model thinking default lookup (`config.json.modelThinkingLevels`); ranks above the Profile level. */
  readonly modelThinkingLevelOf?: (model: ModelRefParts) => string | undefined
  /** Current `Models` catalog (used to clamp Profile reasoning effort; no clamping if omitted). */
  readonly models?: () => Models
  /** Disabled-model preflight (`ModelRegistry.assertModelEnabled`; rejects disabled models before creating a child conversation). */
  assertModelEnabled?(provider: string, modelId: string): void
  readonly agentSessions: Map<string, number>
  /** Structured-output result slots shared across the Harness (host-owned; concurrent spawns are isolated by `conversationId` key). */
  readonly structuredOutputSessions: Map<number, StructuredOutputSession>
  readonly resolvedAttachments: ResolvedAttachmentRef[] | undefined
  isNodeOnline(nodeId: string): boolean
  /** `[Attached Files]` manifest block (without body prefix; used in spawn task prompt). */
  buildAttachmentBlock(resolved: ResolvedAttachmentRef[]): string
  /** Read raw Profile (returns `undefined` if missing; throws explicitly if corrupted). */
  readProfileForSpawn(profileId: string): Promise<Profile | undefined>
  /** Read conversation snapshot (returns `undefined` if missing). */
  getConvMeta(childId: number): { modelOverride?: string; parentConversationId?: number } | undefined
  /** Authoritative tracker summary (returns `undefined` if missing). */
  getConversationSummary(childId: number): ConversationSummary | undefined
  /** Reuse host `updateConversation` (SDK configuration + snapshot + inheritance chain). */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /** Install a per-child SDK extension (re-installing under the same name replaces in place). */
  installExtension(extension: NativeSpawnDeps['installChildExtension'] extends (e: infer E) => void ? E : never): void
  /**
   * Child conversation registration (snapshot upsert + helmx ownership + observe + broadcast creation).
   * `parentToolCallId` is passed through from the final request by `buildSpawnHost` (explicit parameter
   * to avoid implicitly capturing the post-transform request inside a closure).
   */
  registerChildConversation(
    childId: number,
    parentId: number,
    profileId: string,
    childCwd: string,
    modelMirror: string,
    tags: string[],
    thinkingLevel: string | undefined,
    nodeId: string | undefined,
    parentToolCallId: string | undefined,
    /** Clamped explicit reasoning effort override (`undefined` if `request.effort` was not provided). */
    thinkingLevelOverride: string | undefined,
    /** Optional initial display title for the newly created child conversation. */
    title: string | undefined,
  ): Promise<void>
  /** Update child conversation's `parentToolCallId` on resume (snapshot + broadcast). */
  bindChildToolCall(childId: number, parentToolCallId: string): void
  /**
   * Guarded child conversation abort (sole mandatory entry for signal bridge / startup cancellation):
   * reads current ownership fact and re-verifies atomically via kernel `abortConversationGuarded` (always rejects human-owned).
   * Falls back to SDK `conversation.abort` (raw cancel capability) when unwired.
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /**
   * Optional: resolve a clean fork anchor entry ID in the parent conversation when deriving a fork
   * (pre-locked by host before the hook chain to prevent drift from concurrent pushes or worktree allocation;
   * falls back to `resolveCleanForkAnchor` if unset).
   */
  resolveForkAnchor?(parentId: number): Promise<number>
}

interface SpawnHostOptions {
  readonly source: SpawnHostSource
  /** Final request after `agent_spawn` transforms. */
  readonly finalRequest: AgentSpawnRequest
}

/** Trim `Profile` down to the core fields needed by the spawn closure (`ResolvedProfile`). */
function toResolvedProfile(profile: Profile): ResolvedProfile {
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
    ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}),
    ...(profile.runtime !== undefined ? { runtime: profile.runtime } : {}),
  }
}

/** Construct the dependency bundle for `runNativeSpawn` from the host capability provider (replaces the former 60+ line inline literal). */
export function buildSpawnHost(options: SpawnHostOptions): SpawnHost {
  const { source, finalRequest } = options
  return {
    ...source.toolDeps,
    harness: source.harness,
    getLastAssistantText: (id) => source.tracker.getLastAssistantText(id),
    resolveModel: () => requireModelRef(source.defaultModel),
    ...(source.assertModelEnabled !== undefined
      ? { assertModelEnabled: (provider: string, modelId: string) => source.assertModelEnabled!(provider, modelId) }
      : {}),
    resolveThinkingLevel: () => source.defaultThinkingLevel,
    ...(source.modelThinkingLevelOf !== undefined
      ? { modelThinkingLevelOf: (model: ModelRefParts) => source.modelThinkingLevelOf!(model) }
      : {}),
    ...(source.models !== undefined
      ? { modelsForClamp: source.models }
      : {}),
    agentSessions: source.agentSessions,
    structuredOutputSessions: source.structuredOutputSessions,
    assertNodeAvailable: (nodeId) => {
      if (!source.isNodeOnline(nodeId)) {
        throw new HelmxError('node_offline', `Target node '${nodeId}' is offline; cannot start subagent`, 409, { nodeId })
      }
    },
    resolveAttachmentsForPrompt:
      source.resolvedAttachments !== undefined
        ? async () => source.buildAttachmentBlock(source.resolvedAttachments!)
        : undefined,
    registerChildConversation: (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, thinkingLevelOverride, title) =>
      source.registerChildConversation(
        childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId,
        finalRequest.parentToolCallId, thinkingLevelOverride, title ?? finalRequest.title,
      ),
    bindChildToolCall: (childId, parentToolCallId) => source.bindChildToolCall(childId, parentToolCallId),
    ...(source.abortChildConversationGuarded !== undefined
      ? { abortChildConversationGuarded: (childId: number) => source.abortChildConversationGuarded!(childId) }
      : {}),
    ...(source.resolveForkAnchor !== undefined
      ? { resolveForkAnchor: (parentId: number) => source.resolveForkAnchor!(parentId) }
      : {}),
    resolveProfile: async (profileId) => {
      const profile = await source.readProfileForSpawn(profileId)
      if (!profile) return undefined
      return toResolvedProfile(profile)
    },
    getModelOverride: (childId) => source.getConvMeta(childId)?.modelOverride,
    getParentOfConversation: (childId) => source.getConvMeta(childId)?.parentConversationId,
    // Baseline port for resume config: snapshot read + real update (SDK configuration + persistence +
    // model inheritance chain, reusing host updateConversation rather than rebuilding identity fields).
    getConversation: (childId) => source.getConversationSummary(childId),
    updateConversation: (childId, patch) => source.updateConversation(childId, patch),
    installChildExtension: (extension) => source.installExtension(extension),
  }
}
