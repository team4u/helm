/**
 * RuntimeAgentSpawn: subagent spawning, verification Gate, and active execution facts (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - `spawnAgent` pipeline (schema precompile check -> resume mutex guard -> around hook -> gate check -> schema verify);
 * - Native subagent environment setup and initial child conversation broadcast (0ms alignment of `parentConversationId`/`parentToolCallId`);
 * - `runGate` command execution on target nodes (remote runs for remote conversations);
 * - `buildSpawnEnv` managed child process environment construction;
 * - `resolveSpawnTarget` unified spawn target resolution (shared authoritative chain in `spawn-target.ts`);
 * - Maintaining `activeSpawnExecutions` live execution state and `agentSessions` alias mappings.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  ConversationPatch,
  ConversationSummary,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConversationOwnership } from './runtime-ownership.js'
import type { Harness, Registry } from '@earendil-works/pi-durable'
import type { EnvFabric } from '../env/index.js'
import { assertSchemaCompilable } from '../plugins/schema.js'
import type { ConversationService } from './conversation-service.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import type { HookBridge } from './hook-bridge.js'
import type { ModelRegistry } from './model-registry.js'
import { buildSpawnHost } from './spawn-host.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import {
  assertSpawnForkFields,
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelOverride,
} from './spawn-fork.js'
import { assertSpawnRequestModes } from './spawn-reattach.js'
import { resolveSpawnTargetChain, resolveSpawnTargetNodeId } from './spawn-target.js'
import {
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  sanitizeAgentNamespacedMeta,
} from '@helm/protocol'
import { assertSpawnRequestTitle, isSpawnConversationInTurn, normalizeSpawnTitle, runNativeSpawn } from './spawn.js'
import { validateJsonSchema, type StructuredOutputSession } from './structured-output.js'
import type { HelmStore } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { buildManagedEnv, runGate } from './tools.js'
import { isValidEnvName, type SecretStash } from '../services/index.js'

/**
 * Boundary validation for `secretNames` (shared by spawn requests and `buildSpawnEnv`): string array where
 * every item is a non-empty valid env var name with no duplicates; `undefined` (no grants) is allowed.
 * Invalid shapes fail explicitly.
 */
export function validateSecretNames(secretNames: string[] | undefined): string[] {
  if (secretNames === undefined) return []
  if (!Array.isArray(secretNames)) {
    throw new HelmError('validation_error', `secretNames must be a string array (received ${typeof secretNames})`, 400)
  }
  const seen = new Set<string>()
  for (const name of secretNames) {
    if (typeof name !== 'string' || name === '' || !isValidEnvName(name)) {
      throw new HelmError(
        'validation_error',
        `secretNames contains invalid secret name '${String(name)}' (must be a non-empty valid environment variable name)`,
        400,
        { name },
      )
    }
    if (seen.has(name)) {
      throw new HelmError('validation_error', `Duplicate entry in secretNames: ${name}`, 400, { name })
    }
    seen.add(name)
  }
  return [...secretNames]
}

export interface RuntimeAgentSpawnDeps {
  readonly store: HelmStore
  readonly toolDeps: HelmToolDeps
  readonly harness: Harness
  readonly registry: Registry
  readonly tracker: ConversationTracker
  readonly conversations: ConversationService
  readonly events: EventHub
  readonly envFabric: EnvFabric
  readonly modelsRegistry: ModelRegistry
  readonly hookBridge: HookBridge
  readonly stashService: SecretStash
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  markConversationOwnership(id: number, owner: ConversationOwnership): void
}

export class RuntimeAgentSpawn {
  /** Currently active `spawnAgent` executions in flight: token -> `AgentExecutionInfo`. */
  readonly activeSpawnExecutions = new Map<string, AgentExecutionInfo>()

  /** Native spawn session alias map: `sessionId` -> `childConversationId`. */
  readonly agentSessions = new Map<string, number>()
  /** Shared structured-output result slots across this Harness (`conversationId -> session`):
   * when concurrent spawns replace same-named extensions in place on the registry, older extension closures still
   * dynamically locate their own result slot by `conversationId` in this shared map (identical semantics to a
   * module-level `WeakMap<Harness, Map>`, now injected explicitly). */
  readonly structuredOutputSessions = new Map<number, StructuredOutputSession>()

  constructor(private readonly deps: RuntimeAgentSpawnDeps) {}

  /**
   * Construct managed child process environment variables:
   * never inherits host `process.env` (target machine owns its environment; host `PATH`/`HOME` etc. must not leak).
   * Carries zero parent stash secrets by default (least privilege for external panes); injects secrets only by explicit
   * `secretNames`: each requested name must currently exist in the parent conversation's stash (unexpired/unrevoked),
   * failing explicitly with 404 if missing rather than silently falling back to empty injection.
   */
  buildSpawnEnv(
    conversationId: number,
    cwd: string,
    nodeId?: string,
    options?: { secretNames?: string[] },
  ): Record<string, string> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'validation_error',
        `buildSpawnEnv requires a positive integer conversationId (received ${String(conversationId)})`,
        400,
        { conversationId },
      )
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new HelmError('validation_error', `buildSpawnEnv requires a non-empty cwd (received ${String(cwd)})`, 400, {
        cwd,
      })
    }
    const names = validateSecretNames(options?.secretNames)
    // Sample once and inspect actually returned keys (atomic check at one clock instant):
    // doing has() then envFor() in two steps could cross a TTL expiry boundary and silently drop a secret.
    const stashEnv = this.deps.stashService.envFor(conversationId, names)
    const missing = names.filter((name) => !Object.hasOwn(stashEnv, name))
    if (missing.length > 0) {
      throw new HelmError(
        'secret_not_found',
        `Secrets missing (or grant disabled) in conversation ${conversationId} stash: ${missing.join(', ')}; check secret names and lifecycle (TTL/turn scope)`,
        404,
        { conversationId, missing },
      )
    }
    const resolvedNodeId = nodeId ?? this.deps.store.getConv(conversationId)?.nodeId ?? 'local'
    return buildManagedEnv(this.deps.toolDeps, cwd, conversationId, resolvedNodeId, { stashEnv })
  }

  /**
   * Subagent spawning: `agent_spawn` around pipeline (continuation) -> default native subagent.
   * Kernel has zero Git/worktree semantics: isolation and execution environment policies are handled by plugins
   * via `next(finalReq)`; kernel enforces common guarantees only (meta envelope / schema / gate reporting /
   * result verification; namespaced business fields inside `meta` are validated by each plugin).
   */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    if (request.schema !== undefined) assertSchemaCompilable(request.schema)
    validateSecretNames(request.secretNames)
    // Envelope boundary (synchronous, before hook chains and awaits): `meta` must be a JSON-safe
    // namespaced object; kernel does not validate business contents (each plugin boundary handles its own).
    sanitizeAgentNamespacedMeta(request.meta, {
      agentId: request.agentId ?? 'subagent',
      field: 'spawn request meta',
    })
    assertSpawnRequestModes(request)
    assertSpawnRequestTitle(request.title)
    const preResolvedForkAnchor = await this.preflightForkRequest(request)
    const token = randomUUID()
    try {
      if (request.resume !== undefined) {
        const resumeId = /^\d+$/.test(request.resume) ? Number(request.resume) : this.agentSessions.get(request.resume)
        const child = resumeId !== undefined ? this.deps.store.getConv(resumeId) : undefined
        if (resumeId !== undefined && child !== undefined && child.parentConversationId === request.parentConversationId) {
          // Early mutual-exclusion guard before the hook chain.
          if (
            isSpawnConversationInTurn(this.deps.harness, resumeId) ||
            [...this.activeSpawnExecutions.values()].some((info) => info.conversationId === resumeId)
          ) {
            throw new HelmError('subagent_in_use', `Child conversation ${resumeId} already has an execution in flight; concurrent resume is not allowed`, 409)
          }
          this.activeSpawnExecutions.set(token, { conversationId: resumeId, nodeId: child.nodeId ?? 'local', effectiveCwd: child.cwd })
        }
      } else if (request.reattach !== undefined) {
        const reattachConvId = request.reattach.conversationId
        const reattachExecId = request.reattach.executionId
        if (reattachConvId !== undefined) {
          const child = this.deps.store.getConv(reattachConvId)
          if (child === undefined || child.parentConversationId !== request.parentConversationId) {
            throw new HelmError(
              'not_found',
              `Reattach target child conversation ${reattachConvId} does not exist or does not belong to parent conversation ${request.parentConversationId}; refusing to create a new conversation instead`,
              404,
              { conversationId: reattachConvId, parentConversationId: request.parentConversationId },
            )
          }
          if (
            isSpawnConversationInTurn(this.deps.harness, reattachConvId) ||
            [...this.activeSpawnExecutions.values()].some(
              (info) =>
                info.conversationId === reattachConvId ||
                (reattachExecId !== undefined && info.executionId === reattachExecId),
            )
          ) {
            throw new HelmError('subagent_in_use', `Child conversation ${reattachConvId} still has an active reattach or execution in flight; concurrent reattach is not allowed`, 409, {
              conversationId: reattachConvId,
            })
          }
          this.activeSpawnExecutions.set(token, {
            conversationId: reattachConvId,
            nodeId: child.nodeId ?? 'local',
            effectiveCwd: request.reattach.effectiveCwd ?? child.cwd,
            ...(reattachExecId !== undefined ? { executionId: reattachExecId } : {}),
          })
        } else if (reattachExecId !== undefined) {
          if ([...this.activeSpawnExecutions.values()].some((info) => info.executionId === reattachExecId)) {
            throw new HelmError('subagent_in_use', `External execution ${reattachExecId} still has an active reattach or execution in flight; concurrent reattach is not allowed`, 409, {
              executionId: reattachExecId,
            })
          }
          this.activeSpawnExecutions.set(token, {
            executionId: reattachExecId,
            ...(request.reattach.effectiveCwd !== undefined ? { effectiveCwd: request.reattach.effectiveCwd } : {}),
          })
        }
      }
      const originalResolved = request.onResolved
      let execution: AgentExecutionInfo | undefined
      let gate: ReturnType<typeof sanitizeAgentGateResult> | undefined
      const observed: AgentSpawnRequest = {
        ...request,
        onResolved: (raw) => {
          const info = sanitizeAgentExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
          info.nodeId ??= info.conversationId !== undefined ? this.deps.store.getConv(info.conversationId)?.nodeId : undefined
          execution = info
          this.activeSpawnExecutions.set(token, info)
          originalResolved?.(info)
        },
        onGateResult: (raw) => {
          gate = sanitizeAgentGateResult(raw, { agentId: request.agentId ?? 'subagent' })
          request.onGateResult?.(gate)
        },
      }
      const result = await this.spawnAgentObserved(observed, preResolvedForkAnchor)
      if (request.schema !== undefined) {
        // Final cross-plugin boundary validation: native execution's internal validation can be bypassed when a
        // plugin takes over (`handled`) or rewrites output via hooks, so final outputs are always re-checked here.
        const validation = validateJsonSchema(result, request.schema)
        if (!validation.ok) {
          throw new HelmError('schema_validation_failed', `Subagent final output does not match schema: ${validation.errors.join('; ')}`, 502)
        }
      }
      if (request.gate !== undefined && execution?.executionId !== undefined && gate === undefined) {
        throw agentGateResultMissingError({ agentId: request.agentId ?? 'subagent', executionId: execution.executionId, command: request.gate })
      }
      if (gate !== undefined && !gate.ok) {
        throw new HelmError('gate_failed', `Subagent verification command failed: ${gate.output}`, 502)
      }
      return result
    } finally {
      this.activeSpawnExecutions.delete(token)
    }
  }

  /** Fork request pre-validation and anchor locking (shared by entry preflight and final post-hook check). */
  private async preflightForkRequest(request: AgentSpawnRequest): Promise<number | undefined> {
    assertSpawnForkFields(request)
    if (request.fork !== true) return undefined
    if ((request.agentType ?? '').includes(':')) {
      throw new HelmError(
        'unsupported_runtime',
        `fork is only supported for native Profile sub-conversations; unsupported external runtime '${request.agentType}'`,
        400,
        { agentType: request.agentType },
      )
    }
    const parentMeta = this.deps.store.getConv(request.parentConversationId)
    if (parentMeta === undefined) {
      throw new HelmError(
        'not_found',
        `Parent conversation ${request.parentConversationId} not found; cannot fork`,
        404,
        { parentConversationId: request.parentConversationId },
      )
    }
    const { profileId: effectiveProfileId } = resolveForkMode(request.agentType, true, parentMeta.profileId)
    const profile = await this.deps.conversations.readProfile(effectiveProfileId)
    if (profile === undefined) {
      throw new HelmError(
        'not_found',
        `agentType '${effectiveProfileId}' is not a registered Profile (profiles/${effectiveProfileId} not found)`,
        404,
        { agentType: effectiveProfileId },
      )
    }
    if (profile.runtime !== undefined) {
      throw new HelmError(
        'unsupported_runtime',
        `Profile '${effectiveProfileId}' declares external runtime kind='${profile.runtime.kind}' (agent '${profile.runtime.agent}'); fork is only supported for native Profile sub-conversations`,
        400,
        { agentType: effectiveProfileId, runtimeKind: profile.runtime.kind },
      )
    }
    return resolveCleanForkAnchor(this.deps.harness, request.parentConversationId)
  }

  async spawnAgentObserved(request: AgentSpawnRequest, preResolvedForkAnchor?: number): Promise<unknown> {
    // Attachment gate before entering the hook chain: both `agent_spawn` hooks and native execution are governed
    // by the same authorization guard (artifact existence + parent conversation chain ownership); re-checked if hooks rewrite.
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.deps.conversations.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    // Around (continuation) pipeline: plugins wrap the full lifecycle (allocating resources before `next()`,
    // converging after `next()`), or take over with `handled`; falls back to native execution when unhandled.
    return this.deps.hookBridge.runHookAround('agent_spawn', request, async (finalRequest) => {
      // Envelope boundary (final around request): re-verify `meta` and fork parameters after hook transforms/continuations
      // before entering native execution so hooks cannot flip `fork` on, swap targets, or bypass preflight checks.
      sanitizeAgentNamespacedMeta(finalRequest.meta, {
        agentId: finalRequest.agentId ?? request.agentId ?? 'subagent',
        field: 'spawn request meta',
      })
      assertSpawnRequestModes(finalRequest)
      assertSpawnRequestTitle(finalRequest.title)
      const forkChanged =
        request.fork !== true ||
        finalRequest.agentType !== request.agentType ||
        finalRequest.parentConversationId !== request.parentConversationId ||
        finalRequest.resume !== undefined
      let resolvedAnchor =
        !forkChanged && preResolvedForkAnchor !== undefined
          ? preResolvedForkAnchor
          : undefined
      if (finalRequest.fork === true && (forkChanged || preResolvedForkAnchor === undefined)) {
        resolvedAnchor = await this.preflightForkRequest(finalRequest)
      }
      if (
        finalRequest.attachments !== undefined &&
        finalRequest.attachments.length > 0 &&
        finalRequest !== request
      ) {
        await this.deps.conversations.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
      }
      const resolvedAttachments =
        finalRequest.attachments !== undefined && finalRequest.attachments.length > 0
          ? await this.deps.conversations.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
          : undefined

      // Honesty boundary for native execution: native child conversations isolate their tool env to their own stash
      // and do not inherit parent secret grants — reject non-empty `secretNames` here when not handled by an external
      // runtime hook rather than silently pretending secrets were granted; empty arrays impose no grant and pass through.
      if (finalRequest.secretNames !== undefined && finalRequest.secretNames.length > 0) {
        throw new HelmError(
          'unsupported_secret_grant',
          `Native execution does not support secretNames grants (${finalRequest.secretNames.join(', ')}): native child conversations do not inherit the parent conversation's stash; secret injection is only supported by external runtimes (e.g., builtin:herdr panes) — switch agentType or remove the grant`,
          400,
          { secretNames: [...finalRequest.secretNames] },
        )
      }

      return runNativeSpawn(
        buildSpawnHost({
          finalRequest,
          source: {
            toolDeps: this.deps.toolDeps,
            harness: this.deps.harness,
            tracker: { getLastAssistantText: (id) => this.deps.tracker.getLastAssistantText(id) },
            defaultModel: this.deps.modelsRegistry.defaultModel,
            defaultThinkingLevel: this.deps.modelsRegistry.defaultThinkingLevel,
            modelThinkingLevelOf: (ref) => this.deps.modelsRegistry.modelThinkingLevelOf(ref),
            models: () => this.deps.modelsRegistry.models,
            assertModelEnabled: (provider, modelId) => this.deps.modelsRegistry.assertModelEnabled(provider, modelId),
            agentSessions: this.agentSessions,
            structuredOutputSessions: this.structuredOutputSessions,
            resolvedAttachments,
            isNodeOnline: (nodeId) => this.deps.envFabric.isOnline(nodeId),
            buildAttachmentBlock: (resolved) => this.deps.conversations.buildAttachmentBlock(resolved),
            readProfileForSpawn: (profileId) => this.deps.conversations.readProfile(profileId),
            getConvMeta: (childId) => this.deps.store.getConv(childId),
            getConversationSummary: (childId) => {
              const meta = this.deps.store.getConv(childId)
              return meta ? this.deps.tracker.summaryOf(childId) : undefined
            },
            updateConversation: (childId, patch) => this.deps.updateConversation(childId, patch),
            installExtension: (extension) => {
              this.deps.registry.install(extension as never)
            },
            registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, parentToolCallId, thinkingLevelOverride, title) => {
              const profile = await this.deps.conversations.readProfile(profileId)
              const parentMeta = this.deps.store.getConv(parentId)
              const { forkSameProfile } = resolveForkMode(profileId, finalRequest.fork, parentMeta?.profileId)
              const inheritedModelOverride = resolveInheritedModelOverride(
                finalRequest.model,
                forkSameProfile,
                parentMeta?.modelOverride,
              )
              const now = Date.now()
              const normalizedTitle = normalizeSpawnTitle(
                title ?? finalRequest.title,
                childId,
                (text) => this.deps.stashService.redact(text),
              )
              this.deps.store.upsertConv({
                id: childId,
                title: normalizedTitle,
                profileId,
                tags,
                parentConversationId: parentId,
                ...(parentToolCallId !== undefined && parentToolCallId !== '' ? { parentToolCallId } : {}),
                nodeId: nodeId ?? resolveSpawnTargetNodeId(profile?.nodeId, parentMeta?.nodeId, forkSameProfile),
                cwd: childCwd,
                model: modelMirror,
                thinkingLevel: thinkingLevel ?? '',
                // Clamped explicit override (native execution clamps against target model capability, or inherited on same-profile fork);
                // when unspecified, preserves inheritance chain semantics without persisting an override.
                ...(thinkingLevelOverride !== undefined ? { thinkingLevelOverride } : {}),
                ...(inheritedModelOverride !== undefined && inheritedModelOverride !== ''
                  ? { modelOverride: inheritedModelOverride }
                  : {}),
                unread: false,
                pinned: false,
                stateChangeSeq: 1,
                completionSeq: 0,
                createdAt: now,
                updatedAt: now,
              })
              this.deps.markConversationOwnership(childId, 'helm')
              await this.deps.store.flushPublic()
              await this.deps.tracker.observe(childId)
              if (this.deps.store.getConv(childId) !== undefined && !this.deps.store.isDeleted(childId)) {
                this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
              }
            },
            resolveForkAnchor: (parentId: number) =>
              resolvedAnchor !== undefined && parentId === finalRequest.parentConversationId
                ? Promise.resolve(resolvedAnchor)
                : resolveCleanForkAnchor(this.deps.harness, parentId),
            bindChildToolCall: (childId, parentToolCallId) => {
              const meta = this.deps.store.getConv(childId)
              if (meta === undefined || meta.parentToolCallId === parentToolCallId) return
              this.deps.store.upsertConv({ ...meta, parentToolCallId, updatedAt: Date.now() })
              if (!this.deps.store.isDeleted(childId)) {
                this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
              }
            },
            // Guarded abort for signal bridge: reads current ownership and authoritative sequence watermark, then re-verifies
            // atomically via kernel abortConversationGuarded (always rejects human-owned — watchdog hard rule; stale facts
            // or disappeared targets reject deterministically, never falling back to unguarded abort).
            abortChildConversationGuarded: async (childId) => {
              const summary = this.deps.conversations.summaryWithOwnership(childId)
              const ownedBy = summary.ownedBy ?? 'human'
              if (ownedBy === 'human') {
                throw new HelmError(
                  'ownership_conflict',
                  `Child conversation ${childId} is currently human-owned; refusing automatic abort (watchdog hard rule)`,
                  409,
                  { conversationId: childId, currentOwnership: ownedBy },
                )
              }
              await this.deps.conversations.abortConversationGuarded(childId, {
                expectedOwnership: ownedBy,
                expectedStateSeq: summary.stateChangeSeq,
              })
            },
          },
        }),
        finalRequest,
      )
    })
  }

  /**
   * Verification Gate (shared by standalone spawns and Workflow adapters; runs once).
   */
  runGate(
    command: string,
    options: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
      gateTimeoutMs?: number
    } = {},
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> {
    let nodeId = options.nodeId
    if (nodeId === undefined && options.conversationId !== undefined) {
      nodeId = this.deps.store.getConv(options.conversationId)?.nodeId
    }
    return runGate(this.deps.toolDeps, command, { ...options, ...(nodeId !== undefined ? { nodeId } : {}) })
  }

  /**
   * Unified spawn target resolution (backend for `ctx.host.resolveSpawnTarget`; shares the same authoritative
   * fallback chain as native execution — see `runtime/spawn-target.ts`).
   */
  async resolveSpawnTarget(input: {
    parentConversationId: number
    profileId?: string
    requestCwd?: string
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }> {
    const parent = this.deps.store.getConv(input.parentConversationId)
    if (parent === undefined) {
      throw new HelmError('not_found', `Parent conversation ${input.parentConversationId} not found; cannot resolve spawn target`, 404, {
        parentConversationId: input.parentConversationId,
      })
    }
    const { profileId, forkSameProfile } = resolveForkMode(input.profileId, input.fork, parent.profileId)
    const profile = await this.deps.conversations.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('not_found', `agentType '${profileId}' is not a registered Profile (profiles/${profileId} not found)`, 404)
    }
    // Consolidate source cwd by target node platform (same-profile fork uses request > parent > profile > Hub default;
    // otherwise request > profile > parent > Hub default): worktree source dirs receive the normalized path;
    // unmappable POSIX cwds on win32 targets fail explicitly; unknown remote platforms pass through verbatim.
    // `parentCwd` preserves the parent conversation snapshot verbatim.
    const { nodeId, sourceCwd } = resolveSpawnTargetChain({
      profileNodeId: profile.nodeId,
      parentNodeId: parent.nodeId,
      requestCwd: input.requestCwd,
      profileCwd: profile.cwd,
      parentCwd: parent.cwd,
      defaultCwd: this.deps.toolDeps.defaultCwd,
      forkSameProfile,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(this.deps.envFabric),
          entry: 'resolve_spawn_target',
        }),
    })
    return { nodeId, sourceCwd, parentCwd: parent.cwd }
  }

  /** Snapshot of spawns currently executing in-process (backend for `ctx.host.listActiveSpawnExecutions`). */
  listActiveSpawnExecutions(): AgentExecutionInfo[] {
    return [...this.activeSpawnExecutions.values()].map((info) => ({ ...info }))
  }

  /**
   * Target node process-occupancy snapshot (backend for `ctx.host.inspectNodePathUsage`):
   * scans live processes on the target node via `EnvFabric` (in-process locally / RPC remotely). Failures
   * (offline, unsupported, permission, incomplete scan) propagate `HelmError` from fabric — this layer never
   * swallows errors or falls back to local. See `protocol/plugin.ts` for snapshot semantics (non-locking;
   * `complete=false` must fail closed).
   */
  async inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<import('@helm/protocol').NodePathUsage> {
    if (typeof input.nodeId !== 'string' || input.nodeId === '') {
      throw new HelmError('validation_error', `inspectNodePathUsage requires a non-empty nodeId (received ${String(input.nodeId)})`, 400)
    }
    if (typeof input.path !== 'string' || input.path === '' || input.path.includes('\u0000')) {
      throw new HelmError('validation_error', 'inspectNodePathUsage requires a non-empty path without NUL bytes', 400)
    }
    return this.deps.envFabric.inspectPathUsage(input.nodeId, input.path, input.signal)
  }
}
