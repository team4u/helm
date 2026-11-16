/**
 * original generate subagent: by default agent_spawn execute row (kernel zero Git/worktree semantics).
 *
 * - in pi-durable create original generate sub-conversation,onCreated call back on report convId;
 * - resume: strictly validate ref(pure number convId or since has agentId mapping), never static default creates new false resume;
 *   default strictly along use atomic conversation mirror profileId/cwd/model(do not heavy compute, do not stealthily stealthily back by default
 *   Profile); explicit agentType/cwd/model change via the same updateConversation path should use
 *   (real SDK configure + mirror persist + model inherit chain, do not rebuild identity field),
 *   effort explicit when via updateConversation sync override and SDK config;onResolved/Gate use
 *   config set after actual cwd(and SDK consistent);
 * - schema:AJV all amount validate (re- use plugins/schema,$async explicit reject), turn inside
 *   register_structured_output tool self-heal (per-child extend inject, see
 *   structured-output.ts), tool reject error parameter same turn retry, eventually not away tool can again text
 *   append question once, still failed explicit schema_validation_failed(do not swallow wrong, do not false data);
 * - profile: via resolveProfile port read real Profile(model/runtime), invalid
 *   profile explicit errors;herdr runtime not by plugin take over when unsupported_runtime;
 * - gate: real shell execute (runGate,cwd use sub-conversation actual cwd), failed i.e. spawn failed;
 * - isolation etc. execute environment want seek: kernel do not explain (zero business branch). carries non-empty isolation 
 *   request reach original generate execute row when, note no plugin via agent_spawn continuation honor (such as
 *   builtin:workflow deactivate when worktree isolated), explicit unsupported_runtime,
 *   never static default ignore.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Extension } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationPatch, ConversationSummary } from '@helm/protocol'
import { HelmError, sanitizeAgentNamespacedMeta } from '@helm/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import { parseModelRef } from './models.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import { resolveSpawnTargetChain } from './spawn-target.js'
import {
  assertSpawnForkFields,
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelAndThinking,
} from './spawn-fork.js'
import type { HelmToolDeps } from './tool-deps.js'
import { runGate, MAX_TIMEOUT_MS } from './tools.js'
import {
  STRUCTURED_OUTPUT_EXTENSION_NAME,
  assertSchemaNotAsync,
  buildStructuredOutputExtension,
  parseSchemaCandidate,
  type StructuredOutputSession,
} from './structured-output.js'

const bg = BACKGROUND_CONTEXT

/** by default spawn profile:assistant(real store in common resident profile; do not new build role enumeration). */
const DEFAULT_SPAWN_PROFILE = 'assistant'

/** thinkingLevel legal enumeration (pi-ai ModelThinkingLevel;effort mapping to this, reject any string). */
export const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface ResolvedProfile {
  model?: string
  thinkingLevel?: string
  cwd?: string
  /** Profile by default bind set compute node (default 'local'). */
  nodeId?: string
  /** external runtime declaration (such as herdr): original generate execute row unsupported, explicit errors. */
  runtime?: { kind: string; agent: string; args?: string[] }
}

/**
 * original generate spawn dependency port (host inject;runtime.ts combine specific implement).
 * resolveProfile return undefined means profile missing (explicit errors, not silently when default).
 */
export interface NativeSpawnDeps extends HelmToolDeps {
  harness: Harness
  /** conversationId -> most near assistant text (by tracker maintain). */
  getLastAssistantText(conversationId: number): string | undefined
  /** global by default model 'provider/model'(not config when throw HelmError). */
  resolveModel(): { provider: string; modelId: string }
  /**
   * when before Models set (think Profile capability converge use; host inject ModelRegistry.models).
   * default do not converge (capability unknown do not break contract).
   */
  modelsForClamp?(): Models | undefined
  /**
   * model disable preflight (ModelRegistry.assertModelEnabled inject): parse out eventually
   * resolvedModel after, real create sub-conversation before must invoke (409 model_disabled),
   * never let original generate spawn bypass disable constraint.
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** global by default think Profile; not config then use SDK off. */
  resolveThinkingLevel?(): string | undefined
  /** agentId -> child convId(resume mapping, process inside stable). */
  agentSessions: Map<string, number>
  /**
   * this Harness sharing structure output result slot (conversationId -> session): complete install match
   * host (RuntimeAgentSpawn / buildSpawnHost) hold has and inject, alternative original module level global
   * WeakMap<Harness, Map>; concurrency spawn isolated rely conversationId key (same name extend by
   * registry original ground replace after, old extend closed package still via this sharing map motion state hit itself result slot).
   * direct tune runNativeSpawn most small install match (without schema scenario) can default; request carry schema
   * while not inject when explicit errors (install match defect not silently lose result).
   */
  structuredOutputSessions?: Map<number, StructuredOutputSession>
  /**
   * record sub-conversation and parent conversation closure system and validate profile legal; invalid profileId must throw
   * HelmError('not_found').childCwd is sub-conversation use actual cwd(gate also use it).
   * modelMirror is this sub-conversation eventually takes effect model ('provider/model', write mirror; empty string = not config).
   * tags is sub-conversation tag (host decide; original generate spawn do not hit business role tag).
   * thinkingLevel is actual SDK use Profile (already by target model capability converge), guard against register when
   * re- read inherit source produce ambiguity.thinkingLevelOverride is converge after explicit override
   *(request.effort not provide when undefined, mirror inherit chain semantics).
   */
  registerChildConversation(
    childId: number,
    parentId: number,
    profileId: string,
    childCwd: string,
    modelMirror: string,
    tags: string[],
    thinkingLevel?: string,
    nodeId?: string,
    thinkingLevelOverride?: string,
  ): Promise<void>
  /**
   * resume resume when sub-conversation parentToolCallId update is this time parent conversation tool invoke ID
   * (optional; host sync mirror and broadcast conversation.upsert). default do not append trace.
   */
  bindChildToolCall?(childId: number, parentToolCallId: string): void
  /**
   * guard style abort sub-conversation turn (automatically cancel through use entry; zero business role special judge):signal
   * bridge and startup phase cancel via this abort sub-conversation - - host implement now read ownership fact and away kernel
   * abortConversationGuarded atomic re-check (human-owned one rule reject, watchdog hard rule;
   * fact expired same determinism reject). not connect line (without kernel runtime install match/part test) when fall back
   * SDK conversation.abort, keep original cancel capability.
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /** by profileId read real Profile(model/thinkingLevel/cwd/runtime); missing return undefined. */
  resolveProfile(profileId: string): Promise<ResolvedProfile | undefined>
  /** conversation explicit model override (modelOverride); without override return undefined. */
  getModelOverride(childId: number): string | undefined
  /**
   * validate sub-conversation ownership:resume when confirm childId  parentConversationId and request consistent.
   * return the conversation record parent ID; conversation missing return undefined.
   */
  getParentOfConversation(childId: number): number | undefined
  /**
   * read Helm conversation mirror (profileId / cwd / model etc. real config).
   * resume along use atomic conversation config unique fact source; creates new path use it take parent conversation cwd
   * fall back (request>Profile>parent>Hub chain). missing return undefined.
   */
  getConversation(childId: number): ConversationSummary | undefined
  /**
   * update sub-conversation config (real SDK configure + mirror persist + model inherit chain heavy compute,
   * re- use host updateConversation: do not rebuild mirror, does not override createdAt/title/tags).
   * resume explicit agentType/cwd/model/effort change via this path should use.
   */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /**
   *  per-child extend install enter SDK registry(spawn construct StructuredOutput tool
   * must real register after only then can by conversation by name choose in; same name heavy install is original ground replace).
   */
  installChildExtension(extension: Extension): void
  /**
   * attachment manifest chunk construct port (host already in spawnAgent complete store in and authorization validate).
   * return [Attached Files] text chunk; without attachment spawn when do not inject.
   */
  resolveAttachmentsForPrompt?(): Promise<string>
  /** node availability preflight (offline reject). creates new path target chain unify by spawn-target.ts provide. */
  assertNodeAvailable?: (nodeId: string) => void
  /** optional:fork derive when parse parent conversation clean fork anchor item ID(default away resolveCleanForkAnchor). */
  resolveForkAnchor?(parentId: number): Promise<number>
}

export interface SpawnOutcome {
  kind: 'text'
  text: string
  kind2?: never
}

/**
 * sub-conversation in-flight derive mutual exclusion (process inside, by Harness isolated): unique right threat lock register table.
 *
 * two entry shared use this register table, avoid each is lock when mutual invisible:
 * - runNativeSpawn(original generate execute row, contains test direct tune and around-hook package wrap after next continue);
 * - RuntimeAgentSpawn.spawnAgent  resume preflight (host pipeline entry, hook chain before early reject).
 *
 * occupy when machine (empty window hard rule):
 * - resume: entry sync segment (a await before) i.e. claim;
 * - creates new:createConversation return after and agentSessions register the same sync segment i.e. claim,
 *  override sub-conversation already exists but onResolved not yet back pass empty window (the window inside conversation state still non-
 *  working, host activeSpawnExecutions still without coordinates, only this where visible).
 *
 * only promise this process inside mutual exclusion (across process/across restarts by durable state and guard port negative duty); external runtime
 * (such as herdr pane) resume mutual exclusion by its itself managed register table negative duty, do not via this table.
 */
const conversationInTurn = new WeakMap<Harness, Set<number>>()

function inTurnSet(harness: Harness): Set<number> {
  let set = conversationInTurn.get(harness)
  if (set === undefined) {
    set = new Set<number>()
    conversationInTurn.set(harness, set)
  }
  return set
}

/** declaration occupy sub-conversation (sync, without await): already by occupy when throw 409 subagent_in_use. */
export function claimSpawnConversation(harness: Harness, childId: number): void {
  const set = inTurnSet(harness)
  if (set.has(childId)) {
    throw new HelmError('subagent_in_use', `sub-conversation ${childId} still in execute, cannot concurrency resume`, 409, { conversationId: childId })
  }
  set.add(childId)
}

/** release occupy (finally path; idempotent). */
export function releaseSpawnConversation(harness: Harness, childId: number): void {
  inTurnSet(harness).delete(childId)
}

/** only read probe inquire (host pipeline entry early reject use; does not occupy). */
export function isSpawnConversationInTurn(harness: Harness, childId: number): boolean {
  return conversationInTurn.get(harness)?.has(childId) ?? false
}

export async function runNativeSpawn(deps: NativeSpawnDeps, request: AgentSpawnRequest): Promise<unknown> {
  // envelope boundary (sync segment):meta must be JSON-safe naming empty between object (hook chain
  // transform after eventually request in this re- inspect; business value by naming empty between all way plugin validate).
  sanitizeAgentNamespacedMeta(request.meta, { agentId: request.agentId ?? 'subagent', field: 'spawn request meta' })
  assertSpawnRequestShape(request)
  const childId = request.resume === undefined ? undefined : resolveResumeRef(deps, request.resume, request.parentConversationId)
  if (childId !== undefined) {
    // state preflight is and claim mutual patch second path guard against line (override not via this table history in-flight state).
    const status = deps.getConversation(childId)?.status
    if (status === 'working' || status === 'blocked') {
      throw new HelmError('subagent_in_use', `sub-conversation ${childId} still in execute, cannot concurrency resume`, 409, { conversationId: childId })
    }
    claimSpawnConversation(deps.harness, childId)
  }
  const execution: NativeSpawnExecution = {}
  try {
    return await runNativeSpawnTurn(deps, request, execution)
  } finally {
    if (childId !== undefined) releaseSpawnConversation(deps.harness, childId)
    if (execution.childId !== undefined) releaseSpawnConversation(deps.harness, execution.childId)
  }
}

/** creates new derive sub-conversation ID back pass channel (after creation sync claim, outside layer finally unify release). */
interface NativeSpawnExecution {
  childId?: number
}

/** resume parse result:childId(resume when must has)+ atomic conversation mirror. */
interface SpawnResumeContext {
  childId: number | undefined
  isResume: boolean
  existing: ConversationSummary | undefined
}

/** spawn target parse result: target node + sub-conversation actual cwd(gate and onResolved same source). */
interface SpawnTarget {
  nodeId: string
  childCwd: string
}

async function runNativeSpawnTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
): Promise<unknown> {
  // ---- resume parse: pure number convId or agentId mapping; never guess resume ('12abc' reject).----
  // resume config baseline: atomic conversation mirror (profileId/cwd/model) is unique fact source.
  // default along use; explicit agentType/cwd/model change via the same updateConversation path should use
  // (real SDK configure + mirror persist, do not rebuild identity field).
  const resume = resolveSpawnResume(deps, request)
  const parentSummary = deps.getConversation(request.parentConversationId)
  if (request.fork === true && parentSummary === undefined) {
    throw new HelmError('not_found', `parent conversation ${request.parentConversationId} missing, cannot execute fork derive`, 404, {
      parentConversationId: request.parentConversationId,
    })
  }

  // profile parse:resume default use atomic conversation Profile(do not stealthily stealthily back by default assistant);
  // fork default inherit parent conversation Profile; ordinary creates new path along use agentType || by default.
  const forkResolution = resume.isResume
    ? { profileId: request.agentType ?? resume.existing!.profileId, forkSameProfile: false }
    : resolveForkMode(request.agentType, request.fork, parentSummary?.profileId, DEFAULT_SPAWN_PROFILE)
  const { profileId, forkSameProfile } = forkResolution
  const profile = await resolveProfileForSpawn(deps, profileId)

  let summary: ConversationSummary | undefined = resume.existing
  if (resume.isResume) {
    summary = await applyResumeConfiguration(deps, request, resume.childId!, resume.existing!, profileId)
  }

  // creates new path target: and ctx.host.resolveSpawnTarget the same right threat chain (spawn-target.ts),
  // never each maintain;resume strictly along use atomic conversation mirror (nodeId/cwd do not heavy compute), explicit cwd
  // change already in on way updateConversation consolidate.
  const target = resolveSpawnTargetForRequest(
    deps,
    request,
    resume.isResume,
    profile,
    summary,
    parentSummary,
    forkSameProfile,
  )
  // gate and sub-conversation same cwd(resume use update after actual cwd, independent of main cwd).
  const gateCwd = target.childCwd

  const structured = prepareStructuredSession(request)
  if (structured !== undefined && deps.structuredOutputSessions === undefined) {
    // install match defect explicit errors: result slot without where register, never static default lose structure result.
    throw new HelmError(
      'invalid_state',
      'request carry schema but host not inject structuredOutputSessions(install match defect): structure output result slot without where register',
      500,
    )
  }
  let childId = resume.childId
  if (!resume.isResume) {
    childId = await createChildConversation(
      deps,
      request,
      execution,
      profile,
      profileId,
      structured,
      target,
      parentSummary,
      forkSameProfile,
    )
  } else {
    notifyResumeResolved(deps, request, childId!, target)
  }

  const conversation = await deps.harness.conversation(childId as never, bg)
  if (!conversation) {
    throw new HelmError('not_found', `sub-conversation missing:${childId}`, 404)
  }

  // resume resume when patch hang structure output extend (original conversation create when may no; same must real register).
  if (resume.isResume && structured) {
    const extension = buildStructuredOutputExtension(deps.structuredOutputSessions!)
    deps.installChildExtension(extension)
    await conversation.configure({ extensions: { add: [extension] } }, bg)
  }

  // same name extend by Registry by name parse; result slot must by conversation isolated, cannot by concurrency derive closed package override.
  return await runChildTurn(deps, request, conversation, childId as number, structured, gateCwd)
}

/** request shape hard validate (sync segment; all explicit reject, never static default change by default). */
function assertSpawnRequestShape(request: AgentSpawnRequest): void {
  assertSpawnForkFields(request)
  if (request.isolation !== undefined && request.isolation !== null && request.isolation !== '') {
    // kernel zero business branch: non-empty isolation reach original generate execute row = no plugin via agent_spawn
    // continuation honor (such as builtin:workflow deactivate when worktree isolated).
    throw new HelmError(
      'unsupported_runtime',
      `isolation='${request.isolation}' temporary unsupported: original generate subagent execute row do not implement execute environment isolated (the capability by for should plugin via agent_spawn hook take over; when before not registered or not enabled)`,
      400,
    )
  }
  if (request.signal?.aborted) {
    throw new HelmError('aborted', 'spawn request in before creation cancelled (signal already abort)', 409)
  }
  const agentType = request.agentType ?? ''
  // through use naming empty between prefix decide: any '<namespace>:<kind>' form external runtime
  //(such as herdr:agy,docker:devbox) all must via agent_spawn hook take over; without plugin take over when
  // kernel zero plugin enumeration hard encode, do not point name any plugin, one rule explicit unsupported_runtime.
  if (agentType.includes(':')) {
    throw new HelmError(
      'unsupported_runtime',
      `agentType '${agentType}' is external runtime identifier (namespace:kind form), need to for should plugin via agent_spawn hook take over (when before not registered the runtime)`,
      400,
    )
  }
  if (request.effort !== undefined && !THINKING_LEVELS.has(request.effort)) {
    throw new HelmError(
      'validation_error',
      `effort '${request.effort}' illegal; legal value:${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }
  if (request.gateTimeoutMs !== undefined) assertGateTimeoutMs(request.gateTimeoutMs)
}

/** resume strictly parse:ref missing/parent ownership do not symbol/mirror missing all explicit reject, never static default creates new resume. */
function resolveSpawnResume(deps: NativeSpawnDeps, request: AgentSpawnRequest): SpawnResumeContext {
  const resumeRef = request.resume
  if (resumeRef === undefined) return { childId: undefined, isResume: false, existing: undefined }
  const childId = resolveResumeRef(deps, resumeRef, request.parentConversationId)
  if (childId === undefined) {
    throw new HelmError(
      'not_found',
      `resume ref '${resumeRef}' missing or do not belongs to parent conversation ${request.parentConversationId}:` +
        `since non- since has agentId conversation mapping, also non- valid sub-conversation ID; never static default creates new resume conversation`,
      404,
    )
  }
  const existing = deps.getConversation(childId)
  if (existing === undefined) {
    throw new HelmError(
      'not_found',
      `resume conversation ${childId} without mirror record (host state inconsistent); reject blind item resume`,
      404,
      { conversationId: childId },
    )
  }
  return { childId, isResume: true, existing }
}

/** profile parse: missing explicit 404; declaration external runtime while without plugin take over explicit 400(do not default default fall back original generate). */
async function resolveProfileForSpawn(deps: NativeSpawnDeps, profileId: string): Promise<ResolvedProfile> {
  const profile = await deps.resolveProfile(profileId)
  if (profile === undefined) {
    throw new HelmError(
      'not_found',
      `agentType '${profileId}' is not registered Profile(profiles/${profileId} missing)`,
      404,
    )
  }
  if (profile.runtime) {
    // Profile explicit declaration external runtime (such as herdr) while not has its plugin take over -> do not default default fall back original generate.
    throw new HelmError(
      'unsupported_runtime',
      `Profile '${profileId}' declaration runtime.kind='${profile.runtime.kind}'(agent '${profile.runtime.agent}'),` +
        `need to for should plugin take over; original generate subagent execute row unsupported the runtime`,
      400,
    )
  }
  return profile
}

/** resume config should use: explicit agentType/cwd/model/effort change via updateConversation sync
 * SDK and mirror; config set after for takes effect model do disable preflight (409 model_disabled). */
async function applyResumeConfiguration(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  existing: ConversationSummary,
  profileId: string,
): Promise<ConversationSummary> {
  let summary: ConversationSummary | undefined = existing
  const patch: ConversationPatch = {}
  // explicit agentType and atomic conversation Profile different only then is change (identical then produces no without intent meaning write).
  if (request.agentType !== undefined && request.agentType !== existing.profileId) {
    patch.profileId = profileId
  }
  // explicit cwd only then change write; default strictly along use atomic conversation cwd(never heavy compute to Profile/Hub directory).
  if (request.cwd !== undefined && request.cwd !== existing.cwd) patch.cwd = request.cwd
  // explicit model only then change write ('provider/model' override; clean override by '' explicit express, away the same
  // updateConversation semantics: heavy compute inherit chain + real SDK configure + mirror persist).
  if (request.model !== undefined && request.model !== deps.getModelOverride(childId)) {
    patch.model = request.model
  }
  if (request.effort !== undefined) patch.thinkingLevel = request.effort
  if (Object.keys(patch).length > 0) {
    summary = await deps.updateConversation(childId, patch)
  }
  // resume disable preflight: config set after, commit input before for takes effect model consolidate. explicit model change
  // already in updateConversation inside check; this in override the rest path - - sub-conversation bind set/inherit
  // model after come by user disable when reject resume(409 model_disabled), never bypass disable policy.
  // empty model along use since has not config semantics (submit phase no_model), do not in this fabricate error.
  if (summary!.model !== '') {
    const modelRef = parseModelRef(summary!.model)
    deps.assertModelEnabled?.(modelRef.provider, modelRef.modelId)
  }
  return summary!
}

/** target parse:resume strictly along use mirror; creates new away request > profile > parent conversation right threat chain
 * (enter SDK createConversation / mirror register / gate / onResolved before by target node
 * platform unify consolidate:win32 target on cannot mapping POSIX cwd explicit reject, never written to the database;
 * remote platform without can message information when pass-through, do not change write). */
function resolveSpawnTargetForRequest(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  isResume: boolean,
  profile: ResolvedProfile,
  summary: ConversationSummary | undefined,
  parentSummary: ConversationSummary | undefined,
  forkSameProfile: boolean,
): SpawnTarget {
  let nodeId: string
  let childCwd: string
  if (isResume) {
    nodeId = summary!.nodeId ?? 'local'
    childCwd = summary!.cwd
  } else {
    const chain = resolveSpawnTargetChain({
      profileNodeId: profile.nodeId,
      parentNodeId: parentSummary?.nodeId,
      requestCwd: request.cwd,
      profileCwd: profile.cwd,
      parentCwd: parentSummary?.cwd,
      defaultCwd: deps.defaultCwd,
      forkSameProfile,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(deps.envFabric),
          entry: 'agent_spawn',
        }),
    })
    nodeId = chain.nodeId
    childCwd = chain.sourceCwd
  }
  deps.assertNodeAvailable?.(nodeId)
  return { nodeId, childCwd }
}

/** structure output task slot initialize (without schema i.e. pure text spawn). */
function prepareStructuredSession(request: AgentSpawnRequest): StructuredOutputSession | undefined {
  if (!request.schema) return undefined
  assertSchemaNotAsync(request.schema)
  return { schema: request.schema, accepted: undefined }
}

/** creates new sub-conversation: model parse chain -> disable preflight -> extend install -> create/fork -> empty window claim ->
 * mirror register -> onResolved back pass actual metadata. */
async function createChildConversation(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
  profile: ResolvedProfile,
  profileId: string,
  structured: StructuredOutputSession | undefined,
  target: SpawnTarget,
  parentSummary: ConversationSummary | undefined,
  forkSameProfile: boolean,
): Promise<number> {
  const { resolvedModel, createModelRef, thinkingLevel, thinkingLevelOverride } = resolveInheritedModelAndThinking({
    request,
    forkSameProfile,
    profile,
    parentSummary,
    defaultModel: deps.resolveModel,
    defaultThinkingLevel: deps.resolveThinkingLevel,
    modelsForClamp: deps.modelsForClamp?.(),
  })
  // disable model in before creation explicit reject (409 model_disabled): all parse path
  // unify in this consolidate, never static default to disable model.
  deps.assertModelEnabled?.(resolvedModel.provider, resolvedModel.modelId)
  const extension = structured ? buildStructuredOutputExtension(deps.structuredOutputSessions!) : undefined
  const extensionsChange = extension
    ? { add: [extension] }
    : request.fork === true
      ? { remove: [{ name: STRUCTURED_OUTPUT_EXTENSION_NAME } as Extension] }
      : undefined
  const agentChange: AgentChange = {
    model: { provider: resolvedModel.provider, modelId: resolvedModel.modelId },
    cwd: target.childCwd,
    ...(thinkingLevel
      ? { thinkingLevel: thinkingLevel as ModelThinkingLevel }
      : request.fork === true
        ? { thinkingLevel: null }
        : {}),
    // extensions must pass extend object:SDK store name (names()) but snapshot parse occur in install after;
    // fork and without schema when explicit strip except helm-structured-output, guard against mistakenly inherit parent conversation extend.
    ...(extensionsChange !== undefined ? { extensions: extensionsChange } : {}),
  }
  let conv
  if (request.fork === true) {
    const parentConv = await deps.harness.conversation(request.parentConversationId as never, bg)
    if (!parentConv) {
      throw new HelmError('not_found', `parent conversation missing:${request.parentConversationId}`, 404, {
        parentConversationId: request.parentConversationId,
      })
    }
    const anchorEntryId = await (deps.resolveForkAnchor
      ? deps.resolveForkAnchor(request.parentConversationId)
      : resolveCleanForkAnchor(deps.harness, request.parentConversationId))
    if (extension) deps.installChildExtension(extension)
    conv = await parentConv.fork(
      anchorEntryId as never,
      { ownership: { kind: 'ownerless' }, agent: agentChange },
      bg,
    )
  } else {
    if (extension) deps.installChildExtension(extension)
    conv = await deps.harness.createConversation(
      { ownership: { kind: 'ownerless' }, agent: agentChange },
      bg,
    )
  }
  const childId = conv.id as number
  if (request.agentId) deps.agentSessions.set(request.agentId, childId)
  // empty window closed together (see conversationInTurn note release): sub-conversation already exists but onResolved not yet
  // back pass, mirror state still non- working window inside, only this sync occupy visible - - and agentSessions
  // register the same sync segment claim, any concurrency resume(host pipeline or direct tune) immediately by refuse.
  claimSpawnConversation(deps.harness, childId)
  execution.childId = childId
  // original generate spawn do not hit business role tag (tags by host policy decide, kernel zero role hard encode).
  await deps.registerChildConversation(
    childId,
    request.parentConversationId,
    profileId,
    target.childCwd,
    createModelRef,
    [],
    thinkingLevel,
    target.nodeId,
    thinkingLevelOverride,
  )
  // onResolved in config all set (create + mirror register) after back pass actual metadata.
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
  return childId
}

/** resume resume: explicit model/cwd/effort change already by updateConversation sync SDK and mirror.
 * parentToolCallId sync update (this time tool invoke run phase related immediately points to the sub-conversation);
 * onResolved back pass update after actual cwd(and SDK consistent). */
function notifyResumeResolved(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  target: SpawnTarget,
): void {
  if (request.parentToolCallId !== undefined && request.parentToolCallId !== '') {
    deps.bindChildToolCall?.(childId, request.parentToolCallId)
  }
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
}

/** commit and guard sub-conversation turn.
 *
 * ---- signal bridge: run in abort -> guard abort sub-conversation;listener in finally excerpt except.----
 * via host guard entry (kernel serial domain inside atomic re-check ownership+watermark;human-owned reject),
 * no longer directly conversation.abort- - automatically cancel without condition kill sub-conversation will exceeds watchdog hard rule
 *(ownership already translate rotate is human resume sub-conversation subject to protect). guard reject when: sub-conversation
 * subject to protect continue independent run, parent side wait for immediately with aborted final (this spawn no longer hold has
 * parent task), never strong kill subject to protect sub-conversation.
 */
async function runChildTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  const outputSessions = deps.structuredOutputSessions
  if (structured !== undefined) outputSessions?.set(childId, structured)

  const abortChildTurn = (): Promise<void> => {
    const guarded = deps.abortChildConversationGuarded
    if (guarded !== undefined) return guarded(childId)
    return Promise.resolve(conversation.abort(bg)).then(() => undefined)
  }
  let abortError: HelmError | undefined
  /** guard reject when parent side release (race failed already absorb, late to result do not outside overflow). */
  let releaseParentOnGuardRefusal: ((error: HelmError) => void) | undefined
  const onAbort = () => {
    abortError = new HelmError('aborted', 'subagent execute by cancel (request.signal abort)', 499, {
      conversationId: childId,
    })
    void abortChildTurn().then(
      () => {
        // sub-conversation already abort: its turn compute after driveTurn self however return (abortError fall back).
      },
      (guardError: unknown) => {
        const message = guardError instanceof Error ? guardError.message : String(guardError)
        abortError = new HelmError(
          'aborted',
          `subagent execute cancelled; sub-conversation ${String(childId)} subject to guard protect not abort (${message})`,
          499,
          { conversationId: childId },
        )
        process.stderr.write(`[helm] sub-conversation ${String(childId)} cancel by refuse/failed: ${message}\n`)
        releaseParentOnGuardRefusal?.(abortError)
      },
    )
  }
  if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true })
  const guardRefusal = new Promise<never>((_, reject) => {
    releaseParentOnGuardRefusal = reject
  })
  try {
    if (request.signal?.aborted) {
      await abortChildTurn().catch((error: unknown) => {
        process.stderr.write(
          `[helm] sub-conversation ${String(childId)} startup phase cancel by refuse/failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
      throw new HelmError('aborted', 'subagent startup phase between cancelled', 499, { conversationId: childId })
    }
    const turn = driveTurn(deps, request, conversation, childId, structured, gateCwd)
    // guard reject first row after, late to sub- turn result/exception no longer outside overflow (race already by reject final).
    void turn.catch(() => {})
    return await Promise.race([turn, guardRefusal])
  } catch (error) {
    if (abortError !== undefined && error !== abortError) throw abortError
    throw error
  } finally {
    if (request.signal) request.signal.removeEventListener('abort', onAbort)
    if (outputSessions !== undefined && outputSessions.get(childId) === structured) outputSessions.delete(childId)
  }
}

/** a turn commit, wait for and terminal state check (schema branch first check settled again take text). */
async function driveTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  // attachment: host already validate authorization; piece together in task body text after, handover contract before.
  const attachmentBlock =
    request.attachments !== undefined && request.attachments.length > 0 && deps.resolveAttachmentsForPrompt
      ? `\n\n${await deps.resolveAttachmentsForPrompt()}\n`
      : ''
  const basePrompt = `${request.prompt}${attachmentBlock}`
  const promptText = structured
    ? `${basePrompt}

<structured_output_contract>
complete answer after, invoke register_structured_output tool commit eventually structure result (output parameter must satisfy to set JSON Schema).
Schema: ${JSON.stringify(structured.schema)}
</structured_output_contract>`
    : basePrompt

  const submission = await conversation.submit(
    { type: 'input', content: promptText, whenBusy: 'followUp' },
    bg,
  )
  const settled = await submission.wait(bg)
  assertNotUnanswered(settled, childId)

  if (structured) {
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    // not away tool: once text self-heal append question (model may directly output JSON text).
    const text = deps.getLastAssistantText(childId) ?? ''
    const parsed = parseSchemaCandidate(text, structured.schema)
    if (parsed.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return parsed.value
    }
    const heal = await conversation.submit(
      {
        type: 'input',
        content:
          `you on a answer not via register_structured_output tool commit result. please immediately invoke ` +
          `register_structured_output tool,output parameter is satisfy Schema legal JSON.` +
          `
Schema: ${JSON.stringify(structured.schema)}`,
        whenBusy: 'followUp',
      },
      bg,
    )
    const healSettled = await heal.wait(bg)
    assertNotUnanswered(healSettled, childId)
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    const lastText = deps.getLastAssistantText(childId) ?? ''
    const retry = parseSchemaCandidate(lastText, structured.schema)
    if (retry.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return retry.value
    }
    throw new HelmError(
      'schema_validation_failed',
      `subagent (conversation ${childId}) two time output all not via Schema validate; finally output open head:${(retry.raw || lastText).slice(0, 200)}`,
      502,
      { conversationId: childId, lastText: lastText.slice(0, 1000) },
    )
  }

  await settleGate(deps, request, gateCwd, childId)
  const text = deps.getLastAssistantText(childId)
  if (text === undefined || text === '') {
    throw new HelmError('subagent_failed', `subagent (conversation ${childId}) complete but without text output`, 502, {
      conversationId: childId,
    })
  }
  return text
}

/** not complete turn (failed/abort etc.) explicit errors; never return old assistant text smoke fill result. */
function assertNotUnanswered(settled: { status: string; reason?: string }, childId: number): void {
  if (settled.status !== 'unanswered') return
  throw new HelmError(
    'subagent_failed',
    `subagent (conversation ${childId}) turn not complete:${settled.reason}`,
    502,
    { conversationId: childId, reason: settled.reason },
  )
}

async function settleGate(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  cwd: string,
  childId: number,
): Promise<void> {
  if (!request.gate) return
  // cwd use sub-conversation actual work directory, independent of request default main cwd;gate is verify command,
  // output directly enter error diagnose (do not hang conversation, avoid mistakenly inject conversation level stash environment).
  // conversationId make runGate parse sub-conversation bind set node (remote gate in remote execute);
  // gateTimeoutMs default 120_000(runGate inside), timeout kill the whole process group and such as back pass.
  const gate = await runGate(deps, request.gate, {
    cwd,
    conversationId: childId,
    signal: request.signal,
    ...(request.gateTimeoutMs !== undefined ? { timeoutMs: request.gateTimeoutMs } : {}),
  })
  // execute environment inside exactly once execute after back pass complete result (exitCode/timedOut supply host engine
  // decide failed and retry policy; host engine based on this exempt second execute).
  request.onGateResult?.({
    ok: gate.ok,
    output: gate.output,
    exitCode: gate.exitCode,
    timedOut: gate.timedOut,
  })
  if (!gate.ok) {
    const label = gate.timedOut ? 'execute timeout, already by force terminate' : `exitCode=${gate.exitCode}`
    throw new HelmError(
      'gate_failed',
      `verify command failed (${label}):${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      {
        exitCode: gate.exitCode,
        timedOut: gate.timedOut,
        output: gate.output.slice(-4000),
      },
    )
  }
}

/** gateTimeoutMs boundary: positive integer and ≤ MAX_TIMEOUT_MS(and bash/runGate timeout same boundary); illegal explicit reject (not silently change by default). */
function assertGateTimeoutMs(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new HelmError(
      'validation_error',
      `gateTimeoutMs must be (0, ${MAX_TIMEOUT_MS}] integer, receives ${value}`,
      400,
      { gateTimeoutMs: value },
    )
  }
}

/**
 * resume ref strictly parse: only accept pure ten enter system integer convId(agentId mapping first translate into convId again away the same validate).
 * conversation must real store in and parent ownership correct; any failed return undefined(caller explicit errors,
 * never Number.parseInt('12abc') wide contain resume to error conversation, never static default creates new false resume).
 */
function resolveResumeRef(deps: NativeSpawnDeps, ref: string, parentId: number): number | undefined {
  const mapped = deps.agentSessions.get(ref)
  const candidate = mapped ?? (/^\d+$/.test(ref) ? Number(ref) : undefined)
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate <= 0) return undefined
  const parent = deps.getParentOfConversation(candidate)
  if (parent === undefined || parent !== parentId) return undefined
  return candidate
}
