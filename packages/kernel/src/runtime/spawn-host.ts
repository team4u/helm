/**
 * original generate spawn host port (SpawnHost).
 *
 * from runtime.ts split out:spawnAgentObserved this before to runNativeSpawn pass 60+ row
 * inline object literal (ten a few closed package call back), broken flavor path review want seek mention refine is explicit naming interface.
 * SpawnHost = NativeSpawnDeps host side implement contract; type on directly inherit
 * NativeSpawnDeps(single one fact source), document in this one by one port note host semantics.
 */
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationAttachmentRef, ConversationPatch, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { Profile } from '../services/index.js'
import { requireModelRef } from './models.js'
import type { HelmToolDeps } from './tool-deps.js'
import type { NativeSpawnDeps, ResolvedProfile } from './spawn.js'
import type { StructuredOutputSession } from './structured-output.js'

/**
 * host inject runNativeSpawn complete dependency collection (mirror register,Profile parse, conversation config
 * update, extend install, attachment chunk construct and node availability validate).
 *
 * each port Why note release see spawn.ts  NativeSpawnDeps declaration (single one fact source);
 * this interface only is to it a can in runtime.ts and test in by name reference explicit name.
 */
export type SpawnHost = NativeSpawnDeps

/** already authorization attachment (store in + parent chain ownership validate complete;prompt piece together install use). */
export interface ResolvedAttachmentRef {
  ref: ConversationAttachmentRef
  absPath: string
}

/** construct SpawnHost host capability side (KernelRuntime implement inject). */
export interface SpawnHostSource {
  readonly toolDeps: HelmToolDeps
  readonly harness: Harness
  readonly tracker: {
    getLastAssistantText(conversationId: number): string | undefined
  }
  readonly defaultModel: string | undefined
  readonly defaultThinkingLevel: string | undefined
  /** when before Models set (think Profile capability converge use; default do not converge). */
  readonly models?: () => Models
  /** model disable preflight (ModelRegistry.assertModelEnabled; create sub-conversation before reject disable model). */
  assertModelEnabled?(provider: string, modelId: string): void
  readonly agentSessions: Map<string, number>
  /** this Harness sharing structure output result slot (host hold has; concurrency spawn isolated rely conversationId key). */
  readonly structuredOutputSessions: Map<number, StructuredOutputSession>
  readonly resolvedAttachments: ResolvedAttachmentRef[] | undefined
  isNodeOnline(nodeId: string): boolean
  /** [Attached Files] manifest chunk (without body text prefix;spawn task prompt use). */
  buildAttachmentBlock(resolved: ResolvedAttachmentRef[]): string
  /** read real Profile(missing return undefined; corrupt by host explicit errors). */
  readProfileForSpawn(profileId: string): Promise<Profile | undefined>
  /** conversation mirror read (missing return undefined). */
  getConvMeta(childId: number): { modelOverride?: string; parentConversationId?: number } | undefined
  /** tracker right threat summary (missing return undefined). */
  getConversationSummary(childId: number): ConversationSummary | undefined
  /** re- use host updateConversation(SDK configure + mirror + inherit chain). */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /** per-child SDK extend install (same name heavy install is original ground replace). */
  installExtension(extension: NativeSpawnDeps['installChildExtension'] extends (e: infer E) => void ? E : never): void
  /**
   * sub-conversation register (mirror upsert + helm ownership + observe + create i.e. broadcast).
   * parentToolCallId by buildSpawnHost from eventually request pass-through (explicit parameter, avoid
   * closed package in implicit catch transform after request).
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
    /** converge after explicit think Profile override (request.effort not provide when undefined). */
    thinkingLevelOverride: string | undefined,
  ): Promise<void>
  /** resume resume when update sub-conversation parentToolCallId(mirror + broadcast). */
  bindChildToolCall(childId: number, parentToolCallId: string): void
  /**
   * guard style abort sub-conversation (signal bridge/startup phase cancel hard rule entry): implement now read ownership fact
   * and via kernel abortConversationGuarded atomic re-check (human-owned one rule reject).
   * default do not connect line when spawn fall back SDK conversation.abort(original cancel capability).
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /**
   * optional:fork derive when parse parent conversation clean fork anchor item ID(host in hook chain before can pre- lock,
   * never because concurrency push enter or after continue worktree allocate before window drift; missing seat when fall back resolveCleanForkAnchor).
   */
  resolveForkAnchor?(parentId: number): Promise<number>
}

export interface SpawnHostOptions {
  readonly source: SpawnHostSource
  /** agent_spawn transform after eventually request. */
  readonly finalRequest: AgentSpawnRequest
}

/** Profile -> ResolvedProfile field trim (only keep spawn closure center key). */
export function toResolvedProfile(profile: Profile): ResolvedProfile {
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
    ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}),
    ...(profile.runtime !== undefined ? { runtime: profile.runtime } : {}),
  }
}

/** by host capability side construct runNativeSpawn dependency collection (original 60+ row inline literal explicit alternative). */
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
    ...(source.models !== undefined
      ? { modelsForClamp: source.models }
      : {}),
    agentSessions: source.agentSessions,
    structuredOutputSessions: source.structuredOutputSessions,
    assertNodeAvailable: (nodeId) => {
      if (!source.isNodeOnline(nodeId)) {
        throw new HelmError('node_offline', `target node ${nodeId} offline, cannot start subagent`, 409, { nodeId })
      }
    },
    resolveAttachmentsForPrompt:
      source.resolvedAttachments !== undefined
        ? async () => source.buildAttachmentBlock(source.resolvedAttachments!)
        : undefined,
    registerChildConversation: (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, thinkingLevelOverride) =>
      source.registerChildConversation(
        childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId,
        finalRequest.parentToolCallId, thinkingLevelOverride,
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
    // resume config baseline port: mirror read and real update (SDK configure + persist +
    // model inherit chain, re- use host updateConversation, do not rebuild identity field).
    getConversation: (childId) => source.getConversationSummary(childId),
    updateConversation: (childId, patch) => source.updateConversation(childId, patch),
    installChildExtension: (extension) => source.installExtension(extension),
  }
}
