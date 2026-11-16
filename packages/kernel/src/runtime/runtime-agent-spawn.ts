/**
 * RuntimeAgentSpawn: subagent derive, verify Gate and execute fact maintain (from KernelRuntime split out).
 *
 * responsibility:
 * - spawnAgent run pipeline (schema pre- compile validate -> resume exclusive check -> around hook -> gate validate -> schema verify);
 * - original generate subagent execute environment install match and sub-conversation initial state broadcast (0ms align parentConversationId/parentToolCallId);
 * - runGate verify command in target node execute (remote conversation remote run);
 * - buildSpawnEnv managed child process environment construct;
 * - resolveSpawnTarget through use spawn target parse (spawn-target.ts the same right threat chain);
 * - maintain activeSpawnExecutions leap execute state and agentSessions alias mapping.
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
import { resolveSpawnTargetChain, resolveSpawnTargetNodeId } from './spawn-target.js'
import {
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  sanitizeAgentNamespacedMeta,
} from '@helm/protocol'
import { isSpawnConversationInTurn, runNativeSpawn } from './spawn.js'
import { validateJsonSchema, type StructuredOutputSession } from './structured-output.js'
import type { HelmStore } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { buildManagedEnv, runGate } from './tools.js'
import { isValidEnvName, type SecretStash } from '../services/index.js'

/**
 * secretNames boundary validate (spawn request and buildSpawnEnv shared use): string array, each items
 * non-empty and is legal environment variable name, without duplicate;undefined(not grant) legal. illegal shape explicit reject.
 */
export function validateSecretNames(secretNames: string[] | undefined): string[] {
  if (secretNames === undefined) return []
  if (!Array.isArray(secretNames)) {
    throw new HelmError('validation_error', `secretNames must be a string array (receives ${typeof secretNames})`, 400)
  }
  const seen = new Set<string>()
  for (const name of secretNames) {
    if (typeof name !== 'string' || name === '' || !isValidEnvName(name)) {
      throw new HelmError(
        'validation_error',
        `secretNames contains illegal secret name '${String(name)}'(must non-empty legal environment variable name)`,
        400,
        { name },
      )
    }
    if (seen.has(name)) {
      throw new HelmError('validation_error', `secretNames duplicate:${name}`, 400, { name })
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
  /** when before in-flight spawnAgent execute fact:token -> AgentExecutionInfo. */
  readonly activeSpawnExecutions = new Map<string, AgentExecutionInfo>()

  /** original generate spawn session mapping:sessionId -> childConversationId. */
  readonly agentSessions = new Map<string, number>()
  /** this Harness sharing structure output result slot (conversationId -> session): concurrency spawn
   * same name extend by registry original ground replace after, old extend closed package still via this sharing map by conversationId
   * motion state hit itself result slot (and original module level WeakMap<Harness, Map> same semantics, change is explicit inject). */
  readonly structuredOutputSessions = new Map<number, StructuredOutputSession>()

  constructor(private readonly deps: RuntimeAgentSpawnDeps) {}

  /**
   * managed child process spawn environment variable construct:
   * never carry host process.env(remote environment by target machine self,PATH/HOME etc. must not outside leak).
   * default does not carry any parent conversation stash secret (external pane most small authorization); only explicit secretNames
   * one by one name inject: name must in parent conversation stash inside now store (contains not expired/not compute), missing explicit 404,
   * never static default fall back is empty inject.
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
        `buildSpawnEnv need to positive integer conversationId(receives ${String(conversationId)})`,
        400,
        { conversationId },
      )
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new HelmError('validation_error', `buildSpawnEnv need to non-empty cwd(receives ${String(cwd)})`, 400, {
        cwd,
      })
    }
    const names = validateSecretNames(options?.secretNames)
    // single time choose read after based on actual return key judge missing (sync boundary, same time only sampling clock once):
    // first has after envFor two segment read will in TTL boundary across boundary - -has ,envFor omit, return
    // false succeeded empty inject.
    const stashEnv = this.deps.stashService.envFor(conversationId, names)
    const missing = names.filter((name) => !Object.hasOwn(stashEnv, name))
    if (missing.length > 0) {
      throw new HelmError(
        'secret_not_found',
        `conversation ${conversationId}  stash inside missing (or already stop inject) secret:${missing.join(', ')}; please confirm secret name and lifecycle (TTL/turn effect domain)`,
        404,
        { conversationId, missing },
      )
    }
    const resolvedNodeId = nodeId ?? this.deps.store.getConv(conversationId)?.nodeId ?? 'local'
    return buildManagedEnv(this.deps.toolDeps, cwd, conversationId, resolvedNodeId, { stashEnv })
  }

  /**
   * subagent derive:agent_spawn around pipeline (continuation)-> by default original generate subagent.
   * kernel zero Git/worktree semantics: isolated etc. execute environment want seek by plugin layer via next(finalReq)
   * honor; kernel only keep through use guarantee (meta envelope validate / schema validate / gate back report
   * for account / result verify; naming empty between business value by all way plugin validate).
   */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    if (request.schema !== undefined) assertSchemaCompilable(request.schema)
    validateSecretNames(request.secretNames)
    // envelope boundary (sync segment, first at hook chain and everything await):meta must be JSON-safe
    // naming empty between object; business value do not in kernel validate (all way plugin boundary negative duty).
    sanitizeAgentNamespacedMeta(request.meta, {
      agentId: request.agentId ?? 'subagent',
      field: 'spawn request meta',
    })
    const preResolvedForkAnchor = await this.preflightForkRequest(request)
    const token = randomUUID()
    if (request.resume !== undefined) {
      const resumeId = /^\d+$/.test(request.resume) ? Number(request.resume) : this.agentSessions.get(request.resume)
      const child = resumeId !== undefined ? this.deps.store.getConv(resumeId) : undefined
      if (resumeId !== undefined && child !== undefined && child.parentConversationId === request.parentConversationId) {
        // early mutual exclusion reject (hook chain before): sharing in-flight register table (and runNativeSpawn same source;
        // override direct tune entry and sub-conversation already create but onResolved not back pass empty window)+ this mapping
        // pre- placement coordinates (override hook chain window inside host side concurrency resume). right threat occupy in original generate execute
        // row sync claim; this mapping only is execute fact mirror and early check side.
        if (
          isSpawnConversationInTurn(this.deps.harness, resumeId) ||
          [...this.activeSpawnExecutions.values()].some((info) => info.conversationId === resumeId)
        ) {
          throw new HelmError('subagent_in_use', `sub-conversation ${resumeId} still has in-flight execute, cannot concurrency resume`, 409)
        }
        this.activeSpawnExecutions.set(token, { conversationId: resumeId, nodeId: child.nodeId ?? 'local', effectiveCwd: child.cwd })
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
    try {
      const result = await this.spawnAgentObserved(observed, preResolvedForkAnchor)
      if (request.schema !== undefined) {
        // across plugin boundary final validate: original generate row internal self breath/tool validate do not because take over (handled) or
        // hook change write while store in, eventually artifact must in this re- once Schema(cannot delete).
        const validation = validateJsonSchema(result, request.schema)
        if (!validation.ok) {
          throw new HelmError('schema_validation_failed', `subagent eventually result not satisfy Schema:${validation.errors.join('; ')}`, 502)
        }
      }
      if (request.gate !== undefined && execution?.executionId !== undefined && gate === undefined) {
        throw agentGateResultMissingError({ agentId: request.agentId ?? 'subagent', executionId: execution.executionId, command: request.gate })
      }
      if (gate !== undefined && !gate.ok) {
        throw new HelmError('gate_failed', `subagent verify command failed:${gate.output}`, 502)
      }
      return result
    } finally {
      this.activeSpawnExecutions.delete(token)
    }
  }

  /** fork request pre- validate and anchor lock (entry preflight and hook transform final inspect shared use). */
  private async preflightForkRequest(request: AgentSpawnRequest): Promise<number | undefined> {
    assertSpawnForkFields(request)
    if (request.fork !== true) return undefined
    if ((request.agentType ?? '').includes(':')) {
      throw new HelmError(
        'unsupported_runtime',
        `fork only support original generate Profile sub-conversation, unsupported external runtime '${request.agentType}'`,
        400,
        { agentType: request.agentType },
      )
    }
    const parentMeta = this.deps.store.getConv(request.parentConversationId)
    if (parentMeta === undefined) {
      throw new HelmError(
        'not_found',
        `parent conversation ${request.parentConversationId} missing, cannot execute fork derive`,
        404,
        { parentConversationId: request.parentConversationId },
      )
    }
    const { profileId: effectiveProfileId } = resolveForkMode(request.agentType, true, parentMeta.profileId)
    const profile = await this.deps.conversations.readProfile(effectiveProfileId)
    if (profile === undefined) {
      throw new HelmError(
        'not_found',
        `agentType '${effectiveProfileId}' is not registered Profile(profiles/${effectiveProfileId} missing)`,
        404,
        { agentType: effectiveProfileId },
      )
    }
    if (profile.runtime !== undefined) {
      throw new HelmError(
        'unsupported_runtime',
        `Profile '${effectiveProfileId}' declaration external runtime runtime.kind='${profile.runtime.kind}'(agent '${profile.runtime.agent}'),fork only support original generate Profile sub-conversation`,
        400,
        { agentType: effectiveProfileId, runtimeKind: profile.runtime.kind },
      )
    }
    return resolveCleanForkAnchor(this.deps.harness, request.parentConversationId)
  }

  async spawnAgentObserved(request: AgentSpawnRequest, preResolvedForkAnchor?: number): Promise<unknown> {
    // attachment gate in enter hook chain before:agent_spawn hook and original generate execute row all subject to unify authorization
    // protect (artifact store in + parent conversation chain ownership); plugin next change write after again validate once.
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.deps.conversations.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    // around(continuation) pipeline: plugin can package wrap complete lifecycle (in next before allocate asset,
    // next after converge);handled still can fully take over; without plugin when directly by default original generate execute.
    return this.deps.hookBridge.runHookAround('agent_spawn', request, async (finalRequest) => {
      // envelope boundary (around eventually request): hook chain transform/continuation change write
      // after meta and fork key parameter in enter original generate execute before unify re- verify, guard against hook
      // translate open fork / replace target or bypass pre- validate.
      sanitizeAgentNamespacedMeta(finalRequest.meta, {
        agentId: finalRequest.agentId ?? request.agentId ?? 'subagent',
        field: 'spawn request meta',
      })
      assertSpawnForkFields(finalRequest)
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

      // original generate execute row honest boundary: original generate sub-conversation tool environment by sub-conversation itself stash compute, cannot
      // bear connect parent conversation secret grant - - non-empty secretNames reach this where (without external runtime hook take over)
      // explicit reject, never static default ignore pretend subagent already acquire secret; empty array etc. same not grant.
      if (finalRequest.secretNames !== undefined && finalRequest.secretNames.length > 0) {
        throw new HelmError(
          'unsupported_secret_grant',
          `original generate execute row unsupported secretNames secret grant (${finalRequest.secretNames.join(', ')}): original generate sub-conversation do not inherit parent conversation stash; secret inject only external runtime (such as builtin:herdr pane) support, use... instead external runtime agentType or remove grant`,
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
            registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, parentToolCallId, thinkingLevelOverride) => {
              const profile = await this.deps.conversations.readProfile(profileId)
              const parentMeta = this.deps.store.getConv(parentId)
              const { forkSameProfile } = resolveForkMode(profileId, finalRequest.fork, parentMeta?.profileId)
              const inheritedModelOverride = resolveInheritedModelOverride(
                finalRequest.model,
                forkSameProfile,
                parentMeta?.modelOverride,
              )
              const now = Date.now()
              this.deps.store.upsertConv({
                id: childId,
                title: `subagent ${childId}`,
                profileId,
                tags,
                parentConversationId: parentId,
                ...(parentToolCallId !== undefined && parentToolCallId !== '' ? { parentToolCallId } : {}),
                nodeId: nodeId ?? resolveSpawnTargetNodeId(profile?.nodeId, parentMeta?.nodeId, forkSameProfile),
                cwd: childCwd,
                model: modelMirror,
                thinkingLevel: thinkingLevel ?? '',
                // converge after explicit override (original generate execute row already by target model capability clamp, or same role fork inherit);
                // not explicit designate when keep inherit chain semantics (do not store override).
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
            // signal bridge guard abort: now read ownership and right threat watermark act guard fact, via kernel
            // abortConversationGuarded atomic re-check (human-owned one rule reject - - watchdog
            // hard rule; fact expired/target disappear same determinism reject, never fall back ordinary abort).
            abortChildConversationGuarded: async (childId) => {
              const summary = this.deps.conversations.summaryWithOwnership(childId)
              const ownedBy = summary.ownedBy ?? 'human'
              if (ownedBy === 'human') {
                throw new HelmError(
                  'ownership_conflict',
                  `sub-conversation ${childId} when before ownership human, reject automatically abort (watchdog hard rule)`,
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
   * gate gate (independent spawn and Workflow adapter shared use, only execute once).
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
   * through use spawn target parse (ctx.host.resolveSpawnTarget backend; and original generate execute row
   * the same right threat chain, see runtime/spawn-target.ts).
   */
  async resolveSpawnTarget(input: {
    parentConversationId: number
    profileId?: string
    requestCwd?: string
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }> {
    const parent = this.deps.store.getConv(input.parentConversationId)
    if (parent === undefined) {
      throw new HelmError('not_found', `parent conversation ${input.parentConversationId} missing, cannot parse spawn target`, 404, {
        parentConversationId: input.parentConversationId,
      })
    }
    const { profileId, forkSameProfile } = resolveForkMode(input.profileId, input.fork, parent.profileId)
    const profile = await this.deps.conversations.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('not_found', `agentType '${profileId}' is not registered Profile(profiles/${profileId} missing)`, 404)
    }
    // source cwd by target node platform unify consolidate (same role fork is request > parent > profile > Hub default,
    // the rest is request > profile > parent > Hub default):worktree source directory parse gets
    // is specification after path;win32 target on cannot mapping POSIX cwd explicit reject; remote
    // platform without can message information when pass-through.parentCwd is parent conversation mirror fact, original return.
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

  /** when before process inside still in execute spawn execute fact (ctx.host.listActiveSpawnExecutions backend). */
  listActiveSpawnExecutions(): AgentExecutionInfo[] {
    return [...this.activeSpawnExecutions.values()].map((info) => ({ ...info }))
  }

  /**
   * target node process occupy snapshot (ctx.host.inspectNodePathUsage backend):
   * via EnvFabric in target node real scan (local process inside / remote RPC), failed
   * (offline/unsupported/permission/scan do not complete) by fabric explicit throw HelmError, this layer never
   * swallow wrong, never fall back local machine; snapshot semantics (non- mutual exclusion,complete=false must fail-closed)
   * see protocol/plugin.ts port note release.
   */
  async inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<import('@helm/protocol').NodePathUsage> {
    if (typeof input.nodeId !== 'string' || input.nodeId === '') {
      throw new HelmError('validation_error', `inspectNodePathUsage need to non-empty nodeId(receives ${String(input.nodeId)})`, 400)
    }
    if (typeof input.path !== 'string' || input.path === '' || input.path.includes('\u0000')) {
      throw new HelmError('validation_error', 'inspectNodePathUsage need to non-empty and excludes NUL  path', 400)
    }
    return this.deps.envFabric.inspectPathUsage(input.nodeId, input.path, input.signal)
  }
}
