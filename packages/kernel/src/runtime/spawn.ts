/**
 * Native subagent: default `agent_spawn` runner (zero Git/worktree semantics in kernel).
 *
 * - Creates a native child conversation in `pi-durable` and reports `convId` via `onCreated`;
 * - Resume: validates ref strictly (numeric `convId` or existing `agentId` mapping), never silently creating
 *   a new conversation; preserves original conversation's `profileId`/`cwd`/`model` by default (neither recomputes
 *   nor silently reverts to the default Profile); explicit `agentType`/`cwd`/`model` changes apply through the
 *   same `updateConversation` path (real SDK configure + snapshot persistence + model inheritance without rebuilding
 *   identity fields), explicit `effort` updates via `updateConversation`, and `onResolved`/Gate use the updated actual `cwd`;
 * - Schema: full AJV validation (reuses `plugins/schema`, rejects `$async`), self-heals via in-turn
 *   `register_structured_output` tool (injected as per-child extension, see `structured-output.ts`) where invalid tool
 *   params retry within the same turn, falls back to one text re-ask if the tool wasn't used, and throws
 *   `schema_validation_failed` on continued failure (never swallows errors or fabricates data);
 * - Profile: reads the authoritative Profile via `resolveProfile` (`model`/`runtime`); throws explicitly on invalid
 *   profile and fails with `unsupported_runtime` when an external runtime (e.g. `herdr`) wasn't claimed by a plugin;
 * - Gate: runs real shell check (`runGate` in child conversation's actual `cwd`); failure aborts the spawn;
 * - Isolation & execution environment: kernel interprets zero business branches; non-empty `isolation` reaching
 *   native execution means no plugin claimed it via `agent_spawn` continuation (e.g. `builtin:workflow` disabled
 *   with worktree isolation) and fails explicitly with `unsupported_runtime` instead of silently ignoring.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Extension } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationPatch, ConversationSummary } from '@helm/protocol'
import { HelmError, sanitizeAgentNamespacedMeta } from '@helm/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import { parseModelRef, type ModelRefParts } from './models.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import { resolveSpawnTargetChain } from './spawn-target.js'
import {
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelAndThinking,
} from './spawn-fork.js'
import {
  assertSpawnRequestModes,
  readSubmissionAssistantText,
  recoverAcceptedStructuredOutput,
} from './spawn-reattach.js'
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

/** Default spawn profile: `assistant` (built-in general profile; never introduces new role enums). */
const DEFAULT_SPAWN_PROFILE = 'assistant'

/** Valid `thinkingLevel` enum values (`pi-ai` `ModelThinkingLevel`; `effort` maps directly here, rejecting arbitrary strings). */
export const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Maximum character length for normalized child conversation titles on fresh spawn. */
export const MAX_SPAWN_TITLE_LENGTH = 120

/**
 * Boundary validation for optional `AgentSpawnRequest.title`:
 * rejects non-string values and any ASCII control characters (`0x00..0x1F`, `0x7F`).
 */
export function assertSpawnRequestTitle(title: unknown): void {
  if (title === undefined) return
  if (typeof title !== 'string') {
    throw new HelmError(
      'validation_error',
      `title must be a string (received ${title === null ? 'null' : typeof title})`,
      400,
    )
  }
  for (let i = 0; i < title.length; i += 1) {
    const code = title.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new HelmError('validation_error', 'title must not contain control characters', 400)
    }
  }
}

/**
 * Normalize a spawn `title` for fresh child conversation creation:
 * trims whitespace, redacts secrets (when a redactor is provided), caps at 120 characters,
 * and falls back to `'subagent <childId>'` when omitted or blank after trim.
 */
export function normalizeSpawnTitle(
  rawTitle: string | undefined,
  childId: number,
  redact?: (text: string) => string,
): string {
  if (rawTitle === undefined) return `subagent ${childId}`
  const trimmed = rawTitle.trim()
  if (trimmed === '') return `subagent ${childId}`
  const redacted = (redact ? redact(trimmed) : trimmed).trim()
  if (redacted === '') return `subagent ${childId}`
  return redacted.slice(0, MAX_SPAWN_TITLE_LENGTH)
}

export interface ResolvedProfile {
  model?: string
  thinkingLevel?: string
  cwd?: string
  /** Profile's default bound compute node (defaults to `'local'`). */
  nodeId?: string
  /** External runtime declaration (e.g. `herdr`): unsupported by native execution; fails explicitly. */
  runtime?: { kind: string; agent: string; args?: string[] }
}

/**
 * Dependency ports for native spawn (host-injected; assembled in `runtime.ts`).
 * `resolveProfile` returning `undefined` means missing profile (throws explicitly instead of defaulting).
 */
export interface NativeSpawnDeps extends HelmToolDeps {
  harness: Harness
  /** `conversationId ->` latest assistant text (maintained by tracker). */
  getLastAssistantText(conversationId: number): string | undefined
  /** Global default model `'provider/model'` (throws `HelmError` when unconfigured). */
  resolveModel(): { provider: string; modelId: string }
  /**
   * Current `Models` catalog (used to clamp `thinkingLevel` capabilities; host injects `ModelRegistry.models`).
   * Unset skips clamping (unknown capabilities never break contracts).
   */
  modelsForClamp?(): Models | undefined
  /**
   * Disabled-model preflight (inject `ModelRegistry.assertModelEnabled`): must run right after resolving
   * `resolvedModel` and before creating the child conversation (`409 model_disabled`), ensuring native
   * spawns never bypass disabled-model constraints.
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** Global default reasoning effort; uses SDK off if unset. */
  resolveThinkingLevel?(): string | undefined
  /**
   * Per-model thinking default lookup (`config.json.modelThinkingLevels`): ranks between explicit effort
   * (or same-model parent override on forks) and the Profile level, mirroring the conversation chain.
   */
  modelThinkingLevelOf?(model: ModelRefParts): string | undefined
  /** `agentId -> child convId` (resume mapping, stable within process). */
  agentSessions: Map<string, number>
  /**
   * Structured-output result slots shared across this `Harness` (`conversationId -> session`): fully assembled hosts
   * (`RuntimeAgentSpawn` / `buildSpawnHost`) hold and inject this instead of a module-level `WeakMap<Harness, Map>`;
   * concurrent spawns are isolated by `conversationId` key (so even after same-named extensions are replaced in-place
   * on the registry, older extension closures still hit their own slot dynamically).
   * Minimal `runNativeSpawn` setups (without `schema`) may omit it; requests with `schema` missing this fail loudly
   * rather than silently losing structured outputs.
   */
  structuredOutputSessions?: Map<number, StructuredOutputSession>
  /**
   * Record parent-child relationship and validate profile: invalid `profileId` must throw `HelmError('not_found')`.
   * `childCwd` is the effective cwd used by the child conversation (also used by Gate).
   * `modelMirror` is the resolved model snapshot (`'provider/model'` or `''` if unset).
   * `tags` are child conversation tags (decided by host; native spawn assigns no business role tags).
   * `thinkingLevel` is the effective SDK effort (already clamped to target model capability) to avoid re-reading
   * ambiguous inheritance sources; `thinkingLevelOverride` is the clamped explicit override (`undefined` if
   * `request.effort` was omitted, preserving inheritance chain semantics).
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
    title?: string,
  ): Promise<void>
  /**
   * Update child's `parentToolCallId` on resume to correlate with this parent tool call
   * (optional; host updates snapshot and broadcasts `conversation.upsert`). No-op if untracked.
   */
  bindChildToolCall?(childId: number, parentToolCallId: string): void
  /**
   * Guarded abort for child conversation turns (mandatory entry for auto-cancellations; zero business role special cases):
   * signal bridge and startup cancellations abort through this — host reads current ownership and re-verifies
   * atomically via `abortConversationGuarded` (always rejects human-owned — watchdog hard rule; stale facts
   * reject deterministically). Falls back to SDK `conversation.abort` when unwired (partial tests/standalone).
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /** Read raw Profile by `profileId` (`model`/`thinkingLevel`/`cwd`/`runtime`); `undefined` if missing. */
  resolveProfile(profileId: string): Promise<ResolvedProfile | undefined>
  /** Conversation's explicit model override (`modelOverride`); `undefined` if none. */
  getModelOverride(childId: number): string | undefined
  /**
   * Verify child ownership: confirm `childId`'s `parentConversationId` matches request on resume.
   * Returns recorded parent ID, or `undefined` if conversation does not exist.
   */
  getParentOfConversation(childId: number): number | undefined
  /**
   * Read Helm conversation snapshot (`profileId` / `cwd` / `model` etc. true configuration).
   * Sole source of truth for inherited config on resume; used on creation to fall back to parent cwd
   * (`request > Profile > parent > Hub` chain). Returns `undefined` if missing.
   */
  getConversation(childId: number): ConversationSummary | undefined
  /**
   * Update child configuration (real SDK configure + snapshot persistence + model inheritance recomputation,
   * reusing host `updateConversation` without rebuilding snapshots or overwriting `createdAt`/`title`/`tags`).
   * Explicit `agentType`/`cwd`/`model`/`effort` overrides on resume route through here.
   */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /**
   * Install per-child extension into SDK registry (StructuredOutput tool requires actual registration
   * before conversations can invoke it by name; re-installing under the same name replaces in place).
   */
  installChildExtension(extension: Extension): void
  /**
   * Construct `[Attached Files]` block (host already validated existence & authorization in `spawnAgent`).
   * Injects only when attachments are present.
   */
  resolveAttachmentsForPrompt?(): Promise<string>
  /** Node availability preflight (rejects offline). Creation target chain lives in `spawn-target.ts`. */
  assertNodeAvailable?: (nodeId: string) => void
  /** Optional: resolve clean fork anchor entry ID in parent conversation (defaults to `resolveCleanForkAnchor`). */
  resolveForkAnchor?(parentId: number): Promise<number>
}

export interface SpawnOutcome {
  kind: 'text'
  text: string
  kind2?: never
}

/**
 * In-flight child conversation spawn mutex (in-process, isolated per `Harness`): sole authoritative lock registry.
 *
 * Shared by two entries so neither misses the other's locks:
 * - `runNativeSpawn` (native runner, including direct test calls and `next` continuations wrapped by around-hooks);
 * - `RuntimeAgentSpawn.spawnAgent` resume preflight (host pipeline entry rejecting before hook chains).
 *
 * Acquisition timing (zero-gap invariant):
 * - Resume: claimed synchronously at entry (before the first `await`);
 * - Create: claimed in the same synchronous slice right after `createConversation` returns and `agentSessions` registers,
 *   closing the gap where the child conversation exists before `onResolved` returns (when its status is not yet
 *   `working` and `activeSpawnExecutions` does not yet hold it).
 *
 * Guarantees in-process exclusivity only (cross-process/cross-restart is governed by durable state and guard ports);
 * external runtimes (e.g. `herdr` panes) enforce resume exclusivity in their own managed registries.
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

/** Claim exclusive turn ownership of a child conversation (synchronous, zero await); throws `409 subagent_in_use` if busy. */
export function claimSpawnConversation(harness: Harness, childId: number): void {
  const set = inTurnSet(harness)
  if (set.has(childId)) {
    throw new HelmError('subagent_in_use', `Child conversation ${childId} already has an execution in flight; concurrent resume is not allowed`, 409, { conversationId: childId })
  }
  set.add(childId)
}

/** Release claim (`finally` path; idempotent). */
export function releaseSpawnConversation(harness: Harness, childId: number): void {
  inTurnSet(harness).delete(childId)
}

/** Read-only probe (used for early rejection at host pipeline entry; does not claim). */
export function isSpawnConversationInTurn(harness: Harness, childId: number): boolean {
  return conversationInTurn.get(harness)?.has(childId) ?? false
}

export async function runNativeSpawn(deps: NativeSpawnDeps, request: AgentSpawnRequest): Promise<unknown> {
  // Envelope boundary (synchronous): `meta` must be a JSON-safe namespaced object (re-checked after
  // hook transforms; plugin-specific contents are validated by their respective plugin boundaries).
  sanitizeAgentNamespacedMeta(request.meta, { agentId: request.agentId ?? 'subagent', field: 'spawn request meta' })
  assertSpawnRequestShape(request)
  const resumeChildId =
    request.resume === undefined ? undefined : resolveResumeRef(deps, request.resume, request.parentConversationId)
  const reattachChildId =
    request.reattach?.conversationId === undefined
      ? undefined
      : resolveReattachRef(deps, request.reattach.conversationId, request.parentConversationId)
  if (reattachChildId !== undefined && request.requestId === undefined) {
    throw new HelmError(
      'validation_error',
      'reattach.conversationId requires requestId for idempotent cross-restart reattachment',
      400,
      { conversationId: reattachChildId },
    )
  }
  if (resumeChildId !== undefined) {
    // Status preflight complements `claim` as a second guard (covers historical in-flight runs outside this table).
    const status = deps.getConversation(resumeChildId)?.status
    if (status === 'working' || status === 'blocked') {
      throw new HelmError('subagent_in_use', `Child conversation ${resumeChildId} already has an execution in flight; concurrent resume is not allowed`, 409, {
        conversationId: resumeChildId,
      })
    }
  }
  const claimedChildId = resumeChildId ?? reattachChildId
  if (claimedChildId !== undefined) {
    claimSpawnConversation(deps.harness, claimedChildId)
  }
  const execution: NativeSpawnExecution = {}
  try {
    return await runNativeSpawnTurn(deps, request, execution, reattachChildId)
  } finally {
    if (claimedChildId !== undefined) releaseSpawnConversation(deps.harness, claimedChildId)
    if (execution.childId !== undefined) releaseSpawnConversation(deps.harness, execution.childId)
  }
}

/** Channel passing back newly spawned child ID (claimed synchronously upon creation, released uniformly by outer `finally`). */
interface NativeSpawnExecution {
  childId?: number
}

/** Resume resolution result: `childId` (guaranteed present on resume) + original conversation snapshot. */
interface SpawnResumeContext {
  childId: number | undefined
  isResume: boolean
  existing: ConversationSummary | undefined
}

/** Spawn target resolution result: target node + effective cwd for child conversation (shared by gate and `onResolved`). */
interface SpawnTarget {
  nodeId: string
  childCwd: string
}

async function runNativeSpawnTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
  reattachChildId: number | undefined,
): Promise<unknown> {
  if (reattachChildId !== undefined) {
    return await runNativeReattachTurn(deps, request, reattachChildId)
  }

  // ---- Resume resolution: strict numeric convId or mapped agentId; never guesses ('12abc' rejected). ----
  // Resume config baseline: original conversation snapshot (`profileId`/`cwd`/`model`) is sole source of truth.
  // Preserved by default; explicit `agentType`/`cwd`/`model` changes apply via `updateConversation`
  // (real SDK configure + snapshot persistence without rebuilding identity fields).
  const resume = resolveSpawnResume(deps, request)
  const parentSummary = deps.getConversation(request.parentConversationId)
  if (request.fork === true && parentSummary === undefined) {
    throw new HelmError('not_found', `Parent conversation ${request.parentConversationId} not found; cannot fork`, 404, {
      parentConversationId: request.parentConversationId,
    })
  }

  // Profile resolution: resume preserves existing conversation's Profile (never silently reverts to assistant);
  // fork inherits parent conversation's Profile by default; normal creation uses `agentType || DEFAULT_SPAWN_PROFILE`.
  const forkResolution = resume.isResume
    ? { profileId: request.agentType ?? resume.existing!.profileId, forkSameProfile: false }
    : resolveForkMode(request.agentType, request.fork, parentSummary?.profileId, DEFAULT_SPAWN_PROFILE)
  const { profileId, forkSameProfile } = forkResolution
  const profile = await resolveProfileForSpawn(deps, profileId)

  let summary: ConversationSummary | undefined = resume.existing
  if (resume.isResume) {
    summary = await applyResumeConfiguration(deps, request, resume.childId!, resume.existing!, profileId)
  }

  // Creation path targets share the single authoritative chain with `ctx.host.resolveSpawnTarget` (`spawn-target.ts`);
  // resume strictly preserves original snapshot (`nodeId`/`cwd`), with explicit `cwd` overrides consolidated above.
  const target = resolveSpawnTargetForRequest(
    deps,
    request,
    resume.isResume,
    profile,
    summary,
    parentSummary,
    forkSameProfile,
  )
  // Gate shares child's actual cwd (post-update cwd on resume, independent of caller cwd).
  const gateCwd = target.childCwd

  const structured = prepareStructuredSession(request)
  if (structured !== undefined && deps.structuredOutputSessions === undefined) {
    // Fail loudly on miswiring so structured outputs are never silently dropped.
    throw new HelmError(
      'invalid_state',
      'Request specifies schema but host did not inject structuredOutputSessions (wiring defect): nowhere to register structured output slot',
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
    throw new HelmError('not_found', `Child conversation not found: ${childId}`, 404)
  }

  // Attach structured-output extension on resume if original conversation didn't carry it.
  if (resume.isResume && structured) {
    const extension = buildStructuredOutputExtension(deps.structuredOutputSessions!)
    deps.installChildExtension(extension)
    await conversation.configure({ extensions: { add: [extension] } }, bg)
  }

  // Extensions are keyed by name in Registry; result slots must isolate by conversationId to avoid concurrent overwrites.
  return await runChildTurn(deps, request, conversation, childId as number, structured, gateCwd)
}

/**
 * Reattach in-place to an existing child conversation: never creates or reconfigures,
 * registers `structuredOutputSessions` before harness resume, and awaits the durable `SubmissionHandle`.
 */
async function runNativeReattachTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
): Promise<unknown> {
  const existing = deps.getConversation(childId)
  const parent = deps.getParentOfConversation(childId)
  if (existing === undefined || parent === undefined || parent !== request.parentConversationId) {
    throw new HelmError(
      'not_found',
      `Reattach target child conversation ${childId} does not exist or does not belong to parent conversation ${request.parentConversationId}`,
      404,
      { conversationId: childId, parentConversationId: request.parentConversationId },
    )
  }
  const target: SpawnTarget = {
    nodeId: existing.nodeId ?? 'local',
    childCwd: existing.cwd !== '' ? existing.cwd : (request.reattach?.effectiveCwd ?? deps.defaultCwd),
  }
  deps.assertNodeAvailable?.(target.nodeId)
  const structured = prepareStructuredSession(request)
  if (structured !== undefined && deps.structuredOutputSessions === undefined) {
    throw new HelmError(
      'invalid_state',
      'Request specifies schema but host did not inject structuredOutputSessions (wiring defect): nowhere to register structured output slot',
      500,
    )
  }
  if (request.agentId) deps.agentSessions.set(request.agentId, childId)
  notifyResumeResolved(deps, request, childId, target)

  let structuredExtension: Extension | undefined
  if (structured !== undefined) {
    deps.structuredOutputSessions!.set(childId, structured)
    structuredExtension = buildStructuredOutputExtension(deps.structuredOutputSessions!)
    deps.installChildExtension(structuredExtension)
  }

  const conversation = await deps.harness.conversation(childId as never, bg)
  if (!conversation) {
    if (structured !== undefined && deps.structuredOutputSessions?.get(childId) === structured) {
      deps.structuredOutputSessions.delete(childId)
    }
    throw new HelmError('not_found', `Child conversation not found: ${childId}`, 404, { conversationId: childId })
  }
  if (structured !== undefined && structuredExtension !== undefined) {
    const agent = await conversation.agent(bg)
    if (!agent.extensions.some((ext) => ext.name === STRUCTURED_OUTPUT_EXTENSION_NAME)) {
      await conversation.configure({ extensions: { add: [structuredExtension] } }, bg)
    }
  }
  return await runChildTurn(deps, request, conversation, childId, structured, target.childCwd)
}

/** Strict synchronous validation of request shape (fails explicitly, never coerces silently). */
function assertSpawnRequestShape(request: AgentSpawnRequest): void {
  assertSpawnRequestModes(request)
  assertSpawnRequestTitle(request.title)
  if (request.isolation !== undefined && request.isolation !== null && request.isolation !== '') {
    // Kernel has zero business branches: non-empty isolation reaching native execution means no plugin claimed it
    // via `agent_spawn` continuation (e.g., `builtin:workflow` disabled when worktree isolation was requested).
    throw new HelmError(
      'unsupported_runtime',
      `isolation='${request.isolation}' is not supported here: native subagent execution does not implement isolated execution environments (handled by the corresponding plugin via the agent_spawn hook, which is currently unregistered or disabled)`,
      400,
    )
  }
  if (request.signal?.aborted) {
    throw new HelmError('aborted', 'Spawn request aborted before child creation (signal already aborted)', 409)
  }
  const agentType = request.agentType ?? ''
  // Common namespace prefix rule: any '<namespace>:<kind>' external runtime (e.g. 'herdr:agy', 'docker:devbox')
  // must be claimed by an `agent_spawn` hook; without hardcoding plugin names, kernel always throws `unsupported_runtime`.
  if (agentType.includes(':')) {
    throw new HelmError(
      'unsupported_runtime',
      `agentType '${agentType}' is a namespaced external runtime identifier that must be claimed via the agent_spawn hook (no matching runtime is currently registered)`,
      400,
    )
  }
  if (request.reattach !== undefined && request.reattach.conversationId === undefined) {
    throw new HelmError(
      'unsupported_runtime',
      `Native subagent runner cannot reattach solely by executionId='${request.reattach.executionId ?? ''}' (requires the corresponding external runtime plugin to handle it)`,
      400,
    )
  }
  if (request.effort !== undefined && !THINKING_LEVELS.has(request.effort)) {
    throw new HelmError(
      'validation_error',
      `Invalid effort '${request.effort}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }
  if (request.gateTimeoutMs !== undefined) assertGateTimeoutMs(request.gateTimeoutMs)
}

/** Strict resume resolution: missing ref, mismatched parent, or missing snapshot fail explicitly rather than creating a new conversation. */
function resolveSpawnResume(deps: NativeSpawnDeps, request: AgentSpawnRequest): SpawnResumeContext {
  const resumeRef = request.resume
  if (resumeRef === undefined) return { childId: undefined, isResume: false, existing: undefined }
  const childId = resolveResumeRef(deps, resumeRef, request.parentConversationId)
  if (childId === undefined) {
    throw new HelmError(
      'not_found',
      `Resume target '${resumeRef}' was not found or does not belong to parent conversation ${request.parentConversationId}: ` +
        `neither an existing agentId mapping nor a valid child conversation ID; refusing to create a new conversation instead`,
      404,
    )
  }
  const existing = deps.getConversation(childId)
  if (existing === undefined) {
    throw new HelmError(
      'not_found',
      `Resumed conversation ${childId} has no snapshot record (inconsistent host state); refusing blind resume`,
      404,
      { conversationId: childId },
    )
  }
  return { childId, isResume: true, existing }
}

/** Profile resolution: 404 when missing; 400 when declaring an external runtime unclaimed by a plugin (never falls back silently to native). */
async function resolveProfileForSpawn(deps: NativeSpawnDeps, profileId: string): Promise<ResolvedProfile> {
  const profile = await deps.resolveProfile(profileId)
  if (profile === undefined) {
    throw new HelmError(
      'not_found',
      `agentType '${profileId}' is not a registered Profile (profiles/${profileId} not found)`,
      404,
    )
  }
  if (profile.runtime) {
    // Profile explicitly declares an external runtime (such as herdr) without an active plugin handler -> refuse fallback.
    throw new HelmError(
      'unsupported_runtime',
      `Profile '${profileId}' declares runtime.kind='${profile.runtime.kind}' (agent '${profile.runtime.agent}'), ` +
        `which requires its plugin to handle it; unsupported by the native subagent runner`,
      400,
    )
  }
  return profile
}

/** Apply resume configuration updates: sync explicit `agentType`/`cwd`/`model`/`effort` changes via `updateConversation`,
 * then run disabled-model preflight on the effective model (`409 model_disabled`). */
async function applyResumeConfiguration(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  existing: ConversationSummary,
  profileId: string,
): Promise<ConversationSummary> {
  let summary: ConversationSummary | undefined = existing
  const patch: ConversationPatch = {}
  // Only treat explicit `agentType` differing from original Profile as a change (avoids spurious no-op writes).
  if (request.agentType !== undefined && request.agentType !== existing.profileId) {
    patch.profileId = profileId
  }
  // Only rewrite `cwd` when explicitly given; default strictly preserves original conversation cwd (never resets to Profile/Hub).
  if (request.cwd !== undefined && request.cwd !== existing.cwd) patch.cwd = request.cwd
  // Only rewrite `model` when explicitly changed (`'provider/model'` override, or `''` to clear via `updateConversation`).
  if (request.model !== undefined && request.model !== deps.getModelOverride(childId)) {
    patch.model = request.model
  }
  if (request.effort !== undefined) patch.thinkingLevel = request.effort
  if (Object.keys(patch).length > 0) {
    summary = await deps.updateConversation(childId, patch)
  }
  // Resume disabled-model preflight: after configuration and before submitting input, check the effective model.
  // Explicit model changes are checked inside `updateConversation`; this catches inherited/bound models disabled later
  // without bypassing disable rules. Empty model preserves unconfigured semantics (fails at submit with no_model).
  if (summary!.model !== '') {
    const modelRef = parseModelRef(summary!.model)
    deps.assertModelEnabled?.(modelRef.provider, modelRef.modelId)
  }
  return summary!
}

/** Target resolution: resume preserves snapshot verbatim; creation follows `request > profile > parent` chain
 * (normalized per target node platform before SDK `createConversation` / mirror registration / gate / `onResolved`:
 * unmappable POSIX cwds on win32 fail explicitly; unknown remote platforms pass through verbatim). */
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

/** Initialize structured-output session slot (plain-text spawn when schema is omitted). */
function prepareStructuredSession(request: AgentSpawnRequest): StructuredOutputSession | undefined {
  if (!request.schema) return undefined
  assertSchemaNotAsync(request.schema)
  return { schema: request.schema, accepted: undefined }
}

/** Create new child conversation: model resolution -> disabled preflight -> extension install -> create/fork ->
 * claim gap window -> snapshot registration -> `onResolved` metadata callback. */
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
    modelThinkingLevelOf: deps.modelThinkingLevelOf,
    modelsForClamp: deps.modelsForClamp?.(),
  })
  // Reject disabled models before creating the conversation (`409 model_disabled`), covering all resolution paths.
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
    // Extensions must pass extension objects (SDK retains names, resolving snapshots after installation);
    // when forking without schema, strip inherited `helm-structured-output` from parent conversation.
    ...(extensionsChange !== undefined ? { extensions: extensionsChange } : {}),
  }
  let conv
  if (request.fork === true) {
    const parentConv = await deps.harness.conversation(request.parentConversationId as never, bg)
    if (!parentConv) {
      throw new HelmError('not_found', `Parent conversation not found: ${request.parentConversationId}`, 404, {
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
  // Close concurrency gap (see `conversationInTurn` docs): between creation and `onResolved`, the snapshot
  // status is not yet `working`, so claim synchronously alongside `agentSessions` registration.
  claimSpawnConversation(deps.harness, childId)
  execution.childId = childId
  // Native spawns assign no business role tags (tags belong to host policies; kernel never hardcodes roles).
  const resolvedTitle = normalizeSpawnTitle(request.title, childId, deps.redact)
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
    resolvedTitle,
  )
  // Emit resolved metadata once creation and snapshot registration are complete.
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
  return childId
}

/** On resume: `updateConversation` already synced model/cwd/effort to SDK and snapshot;
 * sync `parentToolCallId` immediately so live call correlation points to this child, and report updated `cwd` via `onResolved`. */
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

/** Submit and monitor child conversation turn.
 *
 * ---- Signal bridge: abort child guardedly when parent aborts; remove listener in `finally`. ----
 * Routes through the host's guarded entry (atomically re-checking ownership+watermark; refuses human-owned)
 * instead of raw `conversation.abort` — unconditionally killing a child conversation resumed by a human would
 * violate the watchdog hard rule. When refused by the guard, the protected child keeps running independently while
 * the parent immediately terminates with `aborted` rather than forcing cancellation.
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
  /** Settle parent immediately if guard refuses abort (absorbs race errors and suppresses late child outcomes). */
  let releaseParentOnGuardRefusal: ((error: HelmError) => void) | undefined
  const onAbort = () => {
    abortError = new HelmError('aborted', 'Subagent execution was cancelled (request.signal aborted)', 499, {
      conversationId: childId,
    })
    void abortChildTurn().then(
      () => {
        // Child aborted cleanly: `driveTurn` settles and falls back to `abortError`.
      },
      (guardError: unknown) => {
        const message = guardError instanceof Error ? guardError.message : String(guardError)
        abortError = new HelmError(
          'aborted',
          `Subagent execution was cancelled; child conversation ${String(childId)} is guard-protected and was not aborted (${message})`,
          499,
          { conversationId: childId },
        )
        process.stderr.write(`[helm] child conversation ${String(childId)} abort refused/failed: ${message}\n`)
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
          `[helm] child conversation ${String(childId)} startup abort refused/failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
      throw new HelmError('aborted', 'Subagent execution cancelled during startup', 499, { conversationId: childId })
    }
    const turn = driveTurn(deps, request, conversation, childId, structured, gateCwd)
    // Suppress unhandled rejections if `guardRefusal` settles the race first.
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

/** Submit a turn, await completion, and inspect terminal status (structured branch checks settled output before text). */
async function driveTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  // Attachments were already authorized by host; append manifest block after prompt body, before output contract.
  const attachmentBlock =
    request.attachments !== undefined && request.attachments.length > 0 && deps.resolveAttachmentsForPrompt
      ? `\n\n${await deps.resolveAttachmentsForPrompt()}\n`
      : ''
  const basePrompt = `${request.prompt}${attachmentBlock}`
  const promptText = structured
    ? `${basePrompt}

<structured_output_contract>
After finishing your answer, call the register_structured_output tool to submit your final structured result (the output parameter must satisfy the JSON Schema below).
Schema: ${JSON.stringify(structured.schema)}
</structured_output_contract>`
    : basePrompt

  // Busy mode: steer (unified default); reattach uses followUp as safety net behind requestId dedup.
  const submission = await conversation.submit(
    {
      type: 'input',
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
      content: promptText,
      whenBusy: request.reattach !== undefined ? 'followUp' : 'steer',
    },
    bg,
  )
  const settled = await submission.wait(bg)
  assertNotUnanswered(settled, childId)

  const resolveTurnText = async (
    turnSettled: typeof settled,
  ): Promise<string | undefined> => {
    if (
      typeof conversation.entries === 'function' &&
      turnSettled.type === 'input' &&
      turnSettled.status === 'done' &&
      turnSettled.answer !== undefined
    ) {
      return await readSubmissionAssistantText(conversation, turnSettled)
    }
    return deps.getLastAssistantText(childId)
  }

  if (structured) {
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    if (settled.type === 'input' && settled.entry !== undefined) {
      const recovered = await recoverAcceptedStructuredOutput(
        conversation,
        structured.schema,
        settled.entry,
        settled.answer,
      )
      if (recovered.found) {
        structured.accepted = recovered.value
        await settleGate(deps, request, gateCwd, childId)
        return structured.accepted
      }
    }
    // Tool not called: send one text self-heal follow-up (model may have printed raw JSON directly).
    const text = (await resolveTurnText(settled)) ?? ''
    const parsed = parseSchemaCandidate(text, structured.schema)
    if (parsed.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return parsed.value
    }
    const healRequestId = request.requestId !== undefined ? `${request.requestId}:schema-heal` : undefined
    const heal = await conversation.submit(
      {
        type: 'input',
        ...(healRequestId !== undefined ? { requestId: healRequestId } : {}),
        content:
          `Your previous response did not submit the result via the register_structured_output tool. Please call ` +
          `register_structured_output immediately with an output parameter containing valid JSON matching the Schema below.` +
          `
Schema: ${JSON.stringify(structured.schema)}`,
        whenBusy: 'steer',
      },
      bg,
    )
    const healSettled = await heal.wait(bg)
    assertNotUnanswered(healSettled, childId)
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    if (healSettled.type === 'input' && healSettled.entry !== undefined) {
      const recoveredHeal = await recoverAcceptedStructuredOutput(
        conversation,
        structured.schema,
        healSettled.entry,
        healSettled.answer,
      )
      if (recoveredHeal.found) {
        structured.accepted = recoveredHeal.value
        await settleGate(deps, request, gateCwd, childId)
        return structured.accepted
      }
    }
    const lastText = (await resolveTurnText(healSettled)) ?? ''
    const retry = parseSchemaCandidate(lastText, structured.schema)
    if (retry.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return retry.value
    }
    throw new HelmError(
      'schema_validation_failed',
      `Subagent (conversation ${childId}) failed Schema validation twice; final output starts with: ${(retry.raw || lastText).slice(0, 200)}`,
      502,
      { conversationId: childId, lastText: lastText.slice(0, 1000) },
    )
  }

  await settleGate(deps, request, gateCwd, childId)
  const text = await resolveTurnText(settled)
  if (text === undefined || text === '') {
    throw new HelmError('subagent_failed', `Subagent (conversation ${childId}) completed without text output`, 502, {
      conversationId: childId,
    })
  }
  return text
}

/** Fail explicitly on incomplete turns (failed/aborted, etc.) instead of returning stale assistant text. */
function assertNotUnanswered(settled: { status: string; reason?: string }, childId: number): void {
  if (settled.status !== 'unanswered') return
  throw new HelmError(
    'subagent_failed',
    `Subagent (conversation ${childId}) turn did not complete: ${settled.reason}`,
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
  // Run verification command in the child's actual working directory (independent of caller cwd);
  // output flows directly into diagnostics rather than injecting conversation-level stash env.
  // Passing `conversationId` resolves the child's bound node so remote spawns verify on their target node;
  // `gateTimeoutMs` defaults to 120_000 in `runGate`, killing the whole process group on timeout.
  const gate = await runGate(deps, request.gate, {
    cwd,
    conversationId: childId,
    signal: request.signal,
    ...(request.gateTimeoutMs !== undefined ? { timeoutMs: request.gateTimeoutMs } : {}),
  })
  // Report complete gate outcome (`exitCode`/`timedOut`) back once for host failure/retry decisions (prevents double execution).
  request.onGateResult?.({
    ok: gate.ok,
    output: gate.output,
    exitCode: gate.exitCode,
    timedOut: gate.timedOut,
  })
  if (!gate.ok) {
    const label = gate.timedOut ? 'timed out and was forcibly terminated' : `exitCode=${gate.exitCode}`
    throw new HelmError(
      'gate_failed',
      `Verification command failed (${label}): ${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      {
        exitCode: gate.exitCode,
        timedOut: gate.timedOut,
        output: gate.output.slice(-4000),
      },
    )
  }
}

/** Validate `gateTimeoutMs`: must be integer in `(0, MAX_TIMEOUT_MS]` (matching `bash`/`runGate` limits). */
function assertGateTimeoutMs(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new HelmError(
      'validation_error',
      `gateTimeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}], received ${value}`,
      400,
      { gateTimeoutMs: value },
    )
  }
}

/**
 * Strict resume ref resolution: accepts only decimal integer `convId` (after resolving `agentId` mappings).
 * Conversation must exist with matching parent; returns `undefined` on any mismatch so callers fail explicitly
 * rather than coercing `parseInt('12abc')` or silently creating a fresh conversation.
 */
function resolveResumeRef(deps: NativeSpawnDeps, ref: string, parentId: number): number | undefined {
  const mapped = deps.agentSessions.get(ref)
  const candidate = mapped ?? (/^\d+$/.test(ref) ? Number(ref) : undefined)
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate <= 0) return undefined
  const parent = deps.getParentOfConversation(candidate)
  if (parent === undefined || parent !== parentId) return undefined
  return candidate
}

/**
 * Strict `reattach.conversationId` validation: must be a positive safe integer belonging to an existing
 * conversation under `parentId`; otherwise rejects with 404/400 rather than spawning a fake replacement.
 */
function resolveReattachRef(deps: NativeSpawnDeps, convId: number, parentId: number): number {
  if (!Number.isSafeInteger(convId) || convId <= 0) {
    throw new HelmError(
      'validation_error',
      `reattach.conversationId must be a positive safe integer (received ${String(convId)})`,
      400,
      { conversationId: convId },
    )
  }
  const parent = deps.getParentOfConversation(convId)
  const existing = deps.getConversation(convId)
  if (existing === undefined || parent === undefined || parent !== parentId) {
    throw new HelmError(
      'not_found',
      `Reattach target child conversation ${convId} does not exist or does not belong to parent conversation ${parentId}; refusing to create a new conversation instead`,
      404,
      { conversationId: convId, parentConversationId: parentId },
    )
  }
  return convId
}
