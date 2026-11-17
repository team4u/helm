/**
 * Herdr execution line: two-step pane creation -> agent.start -> readiness wait -> prompt --wait ->
 * blocked approval bridge -> file handoff (with one self-heal) -> gate -> dual-track keepalive cleanup.
 *
 * Honesty discipline (no silent degradation):
 * - Missing file / bad JSON / schema violation: after exactly one self-heal attempt, raise herdr_output_contract_violation
 *   (with the agent.read recent_unwrapped 40-line redacted snapshot); never pass off dirty terminal text as the result;
 * - transport IO/SSH/permission errors throw diagnostics as-is (herdr_output_missing 404 is the only self-healable
 *   boundary code); never re-dispatch the task treating other errors as a missing file;
 * - Real startup sequence (measured against the server): agent.start returns agent_status=unknown +
 *   launch_pending=true + seq=0; must agent.wait(until idle/blocked) for authoritative
 *   readiness before prompting; never treat unknown as terminal failure, never prompt early.
 *
 * Concurrency discipline (dual abort paths):
 * - driveTask's request.signal triggers abortCleanup (cancel the Ask + close own PTY),
 *   which can race with closePane from workflow settle / turn settle: closePane is
 *   single-flight per pane (activeCloses promise reuse), settled is idempotent (a second cleanup just returns),
 *   and the registry is never flipped back to running while a close is in flight;
 * - success/failure paths must removeEventListener to release the abort listener;
 * - all long-running RPCs carry request.signal.
 *
 * Timeout safety boundary (TimeoutError aborts, distinct from plain AbortError cancellation):
 * - There is no safe stop/CAS means to stop the underlying CLI -- on timeout we only save diagnostics and keep the pane (mark failed,
 *   no window close, no keystrokes), never dressing a kept pane up as unconditionally resumable;
 * - a later resume passes assertResumeAgentConfirmed for authoritative confirmation before any prompt is sent:
 *   only idle/done may resume; working/blocked/unknown/unconfirmable are explicitly rejected
 *   (no new pane, no keystroke abort); a startup-phase timeout (agent.start completion uncertain) likewise
 *   confirms safely first, never blindly re-sends agent.start;
 * - plain AbortError cancellation still closes the own pane as today (the authorized path is unchanged).
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, targetPlatformOf, type AgentExecutionInfo, type AgentSpawnRequest, type TargetPlatform } from '@helm/protocol'
import { parseWorkflowSpawnMeta, workflowExecutionMeta } from '../contracts.js'
import type { CreateAskResultLike, CreateAskSpecLike, HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { targetNodeId } from './contracts.js'
import { AskCoordinator, backoffForDuplicateBlocked, type AskEntry } from './asks.js'
import { ApprovalBridge } from './approval-bridge.js'
import { MetadataProjector } from './metadata.js'
import { PaneRegistry, nodeIdOf, paneCloseKey, paneStateKey, targetOf, type ManagedPane, type PaneRouting } from './panes.js'
import { SteerDispatcher } from './executor-steer.js'
import { PaneHandoff } from './executor-handoff.js'
import { ResumeCoordinator } from './executor-resume.js'
import { ReattachCoordinator } from './executor-reattach.js'
import {
  assertOkResult,
  parseAgentResult,
  parseTabCreated,
  parseWorktreeCreated,
  type HerdrAgentInfo,
} from './rpc.js'
import {
  assertNoUnsupportedOverrides,
  buildAgentName,
  buildOutputFileName,
  buildSpawnPaneEnv,
  HashShort,
  MANAGED_ENV_KEYS,
  redactPromptText,
  redactSchemaText,
  resolveCwd,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'
import { HERDR_STEER_CONTROLS } from './contracts.js'

/**
 * Managed keys pinned authoritatively by the baseline in the pane env (MANAGED_ENV_KEYS + call-home/node identity):
 * After applyPaneSecrets overlays grants, baseline values are re-asserted; grant names must not hijack them.
 */
const PANE_MANAGED_LOCK_KEYS: readonly string[] = [...MANAGED_ENV_KEYS, 'HELM_HUB_URL', 'HELM_NODE_ID']

/** Uppercased managed-key set: case variants of granted values (stash keys hit by secretNames) must not hijack either. */
const PANE_MANAGED_LOCK_UPPER: ReadonlySet<string> = new Set(
  PANE_MANAGED_LOCK_KEYS.map((key) => key.toUpperCase()),
)

/**
 * Merge granted env with the baseline managed lockdown (pure function, the single implementation behind applyPaneSecrets):
 * - granted values overlay the baseline (same-name overwrites);
 * - managed keys (including case-variant aliases like helm_execution_scope / Helm_Cwd) are stripped
 *   then the baseline canonical value is re-asserted -- Windows env names are case-insensitive, aliases could
 *   hijack call-home/identity/scope variables when read by the child process (isomorphic to the kernel's buildManagedEnv fixed override).
 */
export function mergeGrantedEnvWithManagedLocks(
  baseline: Record<string, string>,
  granted: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...baseline, ...granted }
  for (const key of Object.keys(env)) {
    if (PANE_MANAGED_LOCK_UPPER.has(key.toUpperCase()) && !PANE_MANAGED_LOCK_KEYS.includes(key)) {
      delete env[key]
    }
  }
  for (const key of PANE_MANAGED_LOCK_KEYS) {
    if (key in baseline) env[key] = baseline[key]!
  }
  return env
}

export interface ExecutorHost {
  /** Parent-conversation cwd resolution (host getConversation bridge; errors propagate as-is). */
  parentCwdOf(parentConversationId: number): string | undefined
  /**
   * Node bound to the parent conversation (host getConversation(id).nodeId; undefined = local).
   * Child spawns without an explicit/Profile node inherit it (otherwise they would always land locally; tasks of a remote parent
   * conversation would be mis-dispatched to the Hub's local machine).
   */
  parentNodeIdOf(parentConversationId: number): string | undefined
  /** AskDoc target conversation (defaults to the parent conversation). */
  askConversationId(parentConversationId: number): number
  /** Non-secret notifications. */
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** agent.start startup timeout (config.startupTimeoutMs; 3001..300000). */
  startupTimeoutMs(): number
  /** Host createAsk (pre-allocated id; ask.id looks like herdr:<nodeId>:<pane>:<seq>). */
  createAsk(spec: CreateAskSpecLike): Promise<CreateAskResultLike>
  /** Host cancelAsk (404 = already settled, callers clear the entry on it; other errors propagate as-is). */
  cancelAsk(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
  /** 宿主是否处于整体关停中（isClosing=true 时保活断连，绝不关窗/改标 failed）。可选，缺省 false。 */
  isClosing?(): boolean
  /** 本启用周期连接取消信号（服务 stop 时中止，唤醒在途任务等待）。可选。 */
  connectionSignal?: AbortSignal
}

interface WindowPane {
  paneId: string
  tabId: string
  /** Worktree mode only (dedicated workspace); plain tab mode by default (close only the tab). */
  workspaceId?: string
  effectiveCwd: string
  worktree?: { path: string; branch?: string }
}

/** handle() return: handled means takeover (result is the handoff artifact); continue lets the kernel default through. */
export type HandleOutcome = { action: 'handled'; result: unknown } | { action: 'continue' }

/**
 * Managed-task lifecycle phases (explicitly tracked): only 'task' (first prompt delivered, awaiting settlement)
 * allows steer; startup (pane creation/agent readiness wait), handoff (handoff file read & self-heal),
 * gate (acceptance) and task end (keepalive/failed/settled, no entry) always reject.
 */
type PaneTaskPhase = 'startup' | 'task' | 'handoff' | 'gate'

/** steerPane input (aligned with the plugins package ExternalSteerRequest; signal is the calling context's cancellation). */
export interface SteerPaneInput {
  workflowRunId: string
  parentConversationId: number
  text: string
  signal?: AbortSignal
}

export class HerdrExecutor {
  /** pane scopeKey -> in-flight closePane promise (single flight across the dual abort paths). */
  private readonly activeCloses = new Map<string, Promise<void>>()

  /**
   * pane scopeKey -> pane env baseline (managed HELM_* + Profile merge, **contains no stash
   * secrets**). Memory only; Gate/resume start from the baseline every time and re-authorize values
   * from the current stash per request secretNames -- secret plaintext is never cached for reuse by later child
   * processes (stale values are not injected after TTL/turn end).
   */
  private readonly paneEnvs = new Map<string, Record<string, string>>()
  private readonly blockedTasks = new Map<string, Promise<boolean>>()
  private readonly unstartedPanes = new Set<string>()
  /** Lifecycle phase and original spawn request of in-flight managed tasks (for steer gating and tail-read recheck). */
  private readonly panePhases = new Map<string, PaneTaskPhase>()
  private readonly activeTasks = new Map<string, AgentSpawnRequest>()
  /** Frozen local connection target (injected at enable). */
  private readonly localTarget: HerdrTarget

  /** Approval bridge (blocked Ask creation and terminal-state consumption; dependencies injected via ports, see approval-bridge.ts). */
  private readonly approvalBridge: ApprovalBridge
  /** steer delivery and handoff-file rotation (in-flight/uncertain/voided registries self-managed, see executor-steer.ts). */
  private readonly steerDispatcher: SteerDispatcher
  /** Handoff file validation, in-place follow-up self-heal and Gate (see executor-handoff.ts). */
  private readonly paneHandoff: PaneHandoff
  /** resume authoritative confirmation and routing recovery (see executor-resume.ts). */
  private readonly resumeCoordinator: ResumeCoordinator
  /** 跨重启原位重挂与交接对账（见 executor-reattach.ts）。 */
  private readonly reattachCoordinator: ReattachCoordinator

  constructor(
    private readonly deps: HerdrPluginDependencies,
    private readonly registry: PaneRegistry,
    private readonly asks: AskCoordinator,
    private readonly projector: MetadataProjector,
    private readonly host: ExecutorHost,
    private readonly transport: NonNullable<HerdrPluginDependencies['transport']>,
    localTarget: HerdrTarget,
    /** Poll interval (shortened in tests; production default 100ms). Used by waitInteractiveReady and AskDoc liveness recheck. */
    private readonly pollIntervalMs = 100,
  ) {
    this.localTarget = localTarget
    this.approvalBridge = new ApprovalBridge({
      asks,
      transport: this.transport,
      host: { notify: host.notify, createAsk: host.createAsk },
      redact: deps.redact,
      analyzeBlockedSnapshot: deps.analyzeBlockedSnapshot,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      readDiagnostic: (pane) => this.paneHandoff.readDiagnostic(pane),
      cancelAskQuietly: (askId, reason) => this.cancelAskQuietly(askId, reason),
      pollIntervalMs: this.pollIntervalMs,
      askPollTransientBackoffBaseMs: deps.askPollTransientBackoffBaseMs,
      askPollTransientBackoffCapMs: deps.askPollTransientBackoffCapMs,
      abortCancelBackoffCapMs: deps.abortCancelBackoffCapMs,
    })
    this.steerDispatcher = new SteerDispatcher({
      registry: this.registry,
      transport: this.transport,
      redact: deps.redact,
      notify: host.notify,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      waitUntilSettled: (request, pane, initial) => this.waitUntilSettled(request, pane, initial),
      startupTimeoutMs: () => host.startupTimeoutMs(),
      steerWaitBudgetMs: deps.steerWaitBudgetMs,
      activeTaskOf: (key) => this.activeTasks.get(key),
      phaseOf: (key) => this.panePhases.get(key),
      setPhase: (key, phase) => {
        this.panePhases.set(key, phase)
      },
      isClosingPane: (pane) => this.activeCloses.has(this.closeKey(pane)),
    })
    this.paneHandoff = new PaneHandoff({
      transport: this.transport,
      redact: deps.redact,
      notify: host.notify,
      askConversationId: host.askConversationId,
      paneEnvOf: (key) => this.paneEnvs.get(key),
      applyPaneSecrets: (baseline, parentConversationId, cwd, target, secretNames) =>
        this.applyPaneSecrets(baseline, parentConversationId, cwd, target, secretNames),
      promptAndWait: (target, pane, text, signal) => this.promptAndWait(target, pane, text, signal),
      waitUntilSettled: (request, pane, initial) => this.waitUntilSettled(request, pane, initial),
      project: (pane, token) => this.project(pane, token),
      markFailed: (pane, note) => this.markFailed(pane, note),
      runLocalGate: deps.runLocalGate,
      mdStableRecheckMs: deps.mdStableRecheckMs,
    })
    this.resumeCoordinator = new ResumeCoordinator({
      registry: this.registry,
      profiles: deps.profiles,
      redact: deps.redact,
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      assertAttachmentsReachable: (request, target, routing) => this.assertAttachmentsReachable(request, target, routing),
      executionInfoOf: (pane) => this.executionInfoOf(pane),
      hasPaneEnv: (key) => this.paneEnvs.has(key),
      setPaneEnv: (key, env) => {
        this.paneEnvs.set(key, env)
      },
      buildPaneBaselineEnv: (parentConversationId, cwd, routing, target) =>
        this.buildPaneBaselineEnv(parentConversationId, cwd, routing, target),
      preloadAttachmentMeta: (request) => this.preloadAttachmentMeta(request),
      runManagedTask: (request, pane) => this.runManagedTask(request, pane),
    })
    this.reattachCoordinator = new ReattachCoordinator({
      registry: this.registry,
      profiles: deps.profiles,
      transport: this.transport,
      redact: deps.redact,
      startupTimeoutMs: () => host.startupTimeoutMs(),
      agentGet: (target, paneId, signal) => this.agentGet(target, paneId, signal),
      waitInteractiveReady: (target, paneId, initial, signal) =>
        this.waitInteractiveReady(target, paneId, initial, signal),
      assertAttachmentsReachable: (request, target, routing) =>
        this.assertAttachmentsReachable(request, target, routing),
      executionInfoOf: (pane) => this.executionInfoOf(pane),
      hasPaneEnv: (key) => this.paneEnvs.has(key),
      setPaneEnv: (key, env) => {
        this.paneEnvs.set(key, env)
      },
      buildPaneBaselineEnv: (parentConversationId, cwd, routing, target) =>
        this.buildPaneBaselineEnv(parentConversationId, cwd, routing, target),
      preloadAttachmentMeta: (request) => this.preloadAttachmentMeta(request),
      hasActiveTask: (key) => this.activeTasks.has(key),
      setPhase: (key, phase) => {
        this.panePhases.set(key, phase)
      },
      project: (pane, token) => this.project(pane, token),
      tryReadValidOutput: (request, pane) => this.paneHandoff.tryReadValidOutput(request, pane),
      removeValidatedOutput: (pane, signal) => this.paneHandoff.removeValidatedOutput(pane, signal),
      readAndValidateOutput: (request, pane) => this.paneHandoff.readAndValidateOutput(request, pane),
      settleThroughSteers: (request, pane, initialFileName, initial) =>
        this.steerDispatcher.settleThroughSteers(request, pane, initialFileName, initial),
      clearRetiredOutputs: (request, pane) => this.steerDispatcher.clearRetiredOutputs(request, pane),
      runGateFor: (request, pane) => this.paneHandoff.runGateFor(request, pane),
      driveTask: (request, pane) => this.driveTask(request, pane),
      finishHandoffAndGate: (request, pane, preloadedOutput) =>
        this.finishHandoffAndGate(request, pane, preloadedOutput),
      runTaskLifecycle: (request, pane, body) => this.runTaskLifecycle(request, pane, body),
    })
  }

  /** 目标窗格当前是否存在正在执行或重挂中的任务（供启动对账规避误关）。 */
  isActiveTask(pane: ManagedPane): boolean {
    return this.activeTasks.has(this.paneKey(pane))
  }

  /**
   * agent_spawn interception main flow.
   * - resume: identified first via our own records (agentId/paneId dual keys), independent of request.agentType
   *   (a real standalone resume has no agentId, a workflow resume has no agentType);
   * - new spawn: resolveSpawnRouting resolves both entries, non-Herdr targets pass through;
   * - node selection: explicit herdr:kind@node (incl. @local) > Profile.runtime.nodeId >
   *   Profile.nodeId > parent conversation's bound node > local. An explicit 'local' overrides a remote parent node
   *   without collapsing it away; when explicit/Profile differs from the parent node, the higher priority wins (a legal switch).
   * - attachments: when the remote machine has no reachable HELM_HUB_URL, explicitly reject before creating any pane
   *   (remote_hub_unreachable_for_artifacts, zero remote side effects);
   * - gateTimeoutMs: explicitly rejected only once the request is identified as a Herdr-handled path (herdr-runtime new spawn / registered
   *   resume); native passthrough is unaffected.
   */
  async handle(request: AgentSpawnRequest): Promise<HandleOutcome> {
    if (request.reattach !== undefined) {
      return this.handleReattach(request)
    }
    if (request.resume !== undefined) {
      const candidates = this.registry.findByResumeRef(request.resume)
      if (candidates.length === 0) {
        // Not recorded by this plugin: a native resume (conversationId) is handed back to the kernel -- native
        // passthrough is unaffected by Herdr's gateTimeoutMs / fork restrictions; an explicit herdr
        // runtime resume never silently creates a fresh continuation pane.
        const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
        if (routing === undefined) return { action: 'continue' }
        this.assertNoFork(request)
        this.assertNoGateTimeout(request)
        throw new HelmError(
          'not_found',
          `resume ref '${request.resume}' does not exist (not a herdr agentId/paneId registered by this plugin)`,
          404,
          { resumeRef: request.resume },
        )
      }
      // Continuation of a registered Herdr pane: identify as a managed resume first, then reject fork/gateTimeoutMs.
      this.assertNoFork(request)
      this.assertNoGateTimeout(request)
      const outcome = await this.resumeInto(request, candidates)
      return { action: 'handled', result: outcome }
    }
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
    if (routing === undefined) return { action: 'continue' }
    this.assertNoFork(request)
    this.assertNoGateTimeout(request)
    assertNoUnsupportedOverrides(request.model, request.effort)
    if (request.signal?.aborted) {
      throw new HelmError('aborted', 'herdr spawn request was cancelled before creation', 409)
    }
    const target = this.resolveSpawnTarget(request, routing)
    this.assertAttachmentsReachable(request, target, routing)
    const result = await this.spawnNew(request, routing, target)
    return { action: 'handled', result }
  }

  private async handleReattach(request: AgentSpawnRequest): Promise<HandleOutcome> {
    const routing = await resolveSpawnRouting(request.agentType, this.deps.profiles)
    const reattach = request.reattach
    const isPlainObj = typeof reattach === 'object' && reattach !== null && !Array.isArray(reattach)
    const executionId = isPlainObj ? reattach.executionId : undefined

    if (routing === undefined) {
      if (request.agentType !== undefined && request.agentType !== '') {
        return { action: 'continue' }
      }
      if (!isPlainObj || executionId === undefined) {
        return { action: 'continue' }
      }
      const candidates = this.registry.all().filter((p) => p.paneId === executionId)
      if (candidates.length === 0) {
        return { action: 'continue' }
      }
      this.assertReattachRequestValid(request, false)
      let pane: ManagedPane | undefined
      if (candidates.length === 1) {
        pane = candidates[0]
      } else {
        const parentNodeId = targetNodeId({ nodeId: this.parentNodeIdOrThrow(request.parentConversationId) })
        pane = this.registry.get(parentNodeId, executionId)
      }
      if (pane === undefined) {
        throw new HelmError(
          'herdr_reattach_missing',
          `重挂目标 executionId '${executionId}' 存在多节点同名窗格，无法根据父会话唯一确定`,
          409,
          { executionId },
        )
      }
      return { action: 'handled', result: await this.reattachCoordinator.reattachInto(request, pane, undefined) }
    }

    // 目标明确归属 Herdr（herdr:<kind> 或 Profile.runtime.kind === 'herdr'）。
    this.assertReattachRequestValid(request, true)
    const target = this.resolveSpawnTarget(request, routing)
    const pane = this.registry.get(targetNodeId(target), executionId as string)
    if (pane === undefined) {
      throw new HelmError(
        'herdr_reattach_missing',
        `无法重挂窗格 ${String(executionId)}@${targetNodeId(target) ?? 'local'}：受管窗格记录不存在`,
        404,
        { executionId, nodeId: targetNodeId(target) ?? 'local' },
      )
    }
    return { action: 'handled', result: await this.reattachCoordinator.reattachInto(request, pane, routing) }
  }

  private assertReattachRequestValid(request: AgentSpawnRequest, requireExecutionId: boolean): void {
    const reattach = request.reattach
    if (typeof reattach !== 'object' || reattach === null || Array.isArray(reattach)) {
      throw new HelmError('validation_error', 'reattach 必须是对象', 400)
    }
    if (request.resume !== undefined) {
      throw new HelmError('validation_error', 'reattach 与 resume 互斥：不能同时重挂并续接', 400, {
        resume: request.resume,
      })
    }
    if (request.fork !== undefined && request.fork !== false) {
      if (typeof request.fork !== 'boolean') {
        throw new HelmError('validation_error', `fork 必须为 boolean（收到 ${typeof request.fork}）`, 400, {
          fork: request.fork,
        })
      }
      throw new HelmError('validation_error', 'reattach 与 fork 互斥：不能同时重挂并分叉派生', 400)
    }
    if (reattach.conversationId !== undefined) {
      throw new HelmError('validation_error', 'Herdr 外部运行时重挂不支持 conversationId', 400, {
        conversationId: reattach.conversationId,
      })
    }
    if (reattach.executionId === undefined) {
      if (requireExecutionId) {
        throw new HelmError('herdr_reattach_missing', 'Herdr 重挂请求缺少 executionId', 400)
      }
    } else if (typeof reattach.executionId !== 'string' || reattach.executionId.trim() === '') {
      throw new HelmError('validation_error', 'reattach.executionId 必须是非空字符串', 400)
    }
    this.assertNoGateTimeout(request)
    assertNoUnsupportedOverrides(request.model, request.effort)
  }

  /**
   * Explicit fork rejection for Herdr runtimes (called only after the request is identified as a Herdr-handled path;
   * native passthrough never passes here and is unaffected). An external terminal CLI pane cannot inherit the parent
   * conversation's context for a fork; ignoring fork would create a blank pane, violating the honesty red line.
   */
  private assertNoFork(request: AgentSpawnRequest): void {
    if (request.fork === undefined || request.fork === false) return
    if (typeof request.fork !== 'boolean') {
      throw new HelmError('validation_error', `fork must be a boolean (got ${typeof request.fork})`, 400, {
        fork: request.fork,
      })
    }
    throw new HelmError(
      'unsupported_runtime',
      'fork is not supported for Herdr external runtimes (context-fork derivation only supports native Profile sub-conversations); remove fork or use a native Profile instead',
      400,
      { ...(request.agentType !== undefined ? { agentType: request.agentType } : {}) },
    )
  }

  /**
   * Explicit gateTimeoutMs rejection for Herdr runtimes (called only after the request is identified as a Herdr-handled path:
   * herdr-runtime new spawn / registered resume; native passthrough never passes here,
   * unaffected). Contract fact: the local dependency runLocalGate's options expose no gate timeout
   * parameter, and the remote transport.runGate has no timeout channel -- accepting the option would silently drop external
   * timeout semantics, so we reject honestly and offer alternatives (see the Gate chapter of
   * docs/workflows/worktree-and-gate.md).
   */
  private assertNoGateTimeout(request: AgentSpawnRequest): void {
    if (request.gateTimeoutMs === undefined) return
    throw new HelmError(
      'unsupported_runtime',
      'gateTimeoutMs is not supported for Herdr runtimes (neither the local dependency contract runLocalGate nor the remote transport.runGate exposes a gate timeout parameter, so timeout semantics cannot be honored honestly); implement the timeout inside the gate command yourself (e.g. wrap the command with timeout) or remove the option',
      400,
      { gateTimeoutMs: request.gateTimeoutMs },
    )
  }

  /**
   * Node selection: explicit/Profile designation (routing.nodeId, incl. 'local') wins; otherwise inherit
   * the parent conversation's bound node (parentNodeIdOf; undefined = local).
   * The target HerdrTarget's socketPath/session inherits the frozen local connection config only when the target is
   * local (remote targets carry only nodeId; the endpoint is resolved by the target node itself).
   */
  private resolveSpawnTarget(request: AgentSpawnRequest, routing: SpawnRouting): HerdrTarget {
    const parentNodeId = this.parentNodeIdOrThrow(request.parentConversationId)
    const nodeId = routing.nodeId !== undefined ? targetNodeId({ nodeId: routing.nodeId }) : targetNodeId({ nodeId: parentNodeId })
    if (nodeId === undefined) return this.localTargetOf()
    return { nodeId }
  }

  /**
   * Attachment honesty gate (before any pane-creation side effect):
   * For a remote node with no reachable HELM_HUB_URL from either Profile config or the node channel, the remote pane
   * cannot fetch artifacts (the local artifacts directory is not on the remote filesystem); reject explicitly instead of silently truncating.
   */
  private assertAttachmentsReachable(
    request: AgentSpawnRequest,
    target: HerdrTarget,
    routing: SpawnRouting,
  ): void {
    if (request.attachments === undefined || request.attachments.length === 0) return
    const nodeId = targetNodeId(target)
    if (nodeId === undefined) return // Local pane: read local artifacts directly.
    const base = this.deps.buildSpawnEnv(request.parentConversationId, '/tmp/helm-attachment-gate', nodeId)
    const { hubUrlOverridden } = buildSpawnPaneEnv(base, routing.profileEnv, {
      remote: true,
      nodeHubUrl: this.deps.nodeChannel?.getNodeHubUrl?.(nodeId),
    })
    if (hubUrlOverridden) return // Remote already has a reachable HELM_HUB_URL (Profile or node channel): fetch via CLI.
    throw new HelmError(
      'remote_hub_unreachable_for_artifacts',
      `remote node '${nodeId}' has no reachable HELM_HUB_URL configured, cannot deliver attachments (${request.attachments.join(', ')}); configure a remotely reachable http(s) address in Profile runtime.env.HELM_HUB_URL, or have the node report its hubUrl by joining via helm-node`,
      400,
      { nodeId, attachments: request.attachments },
    )
  }

  // ------------------------------------------------------------------
  // Pane creation and startup
  // ------------------------------------------------------------------

  private async spawnNew(request: AgentSpawnRequest, routing: SpawnRouting, target: HerdrTarget, existing?: ManagedPane): Promise<unknown> {
    if (existing === undefined) {
      // New pane: cwd resolution chain request.cwd > profile.workspace > parent cwd;
      // reject explicitly when the chain ends without a real cwd (never guess the process cwd, and never let a remote pane default into the Hub directory).
      // After resolution, normalize against the target node's platform (local = process.platform; remote trusts only
      // NodeRegistry registration reports; without trusted info, pass through unchanged).
      const parentCwd = this.parentCwdOrThrow(request.parentConversationId)
      const cwd = resolveCwd(request.cwd, routing, parentCwd, this.platformOfTarget(target))
      if (cwd === '') {
        throw new HelmError(
          'validation_error',
          `cannot resolve the herdr pane working directory (none of request.cwd / profile.workspace / parent conversation ${request.parentConversationId} cwd provides an absolute path); specify cwd explicitly in the spawn request or bind a real working directory to the parent conversation/Profile`,
          400,
          { parentConversationId: request.parentConversationId },
        )
      }
      existing = await this.createManagedPane(request, routing, target, cwd)
    }
    const pane = existing
    this.registry.update(nodeIdOf(pane), pane.paneId, {
      routing: { kind: routing.kind, ...(routing.profileId !== undefined ? { profileId: routing.profileId } : {}) },
    })
    await this.preloadAttachmentMeta(request)
    return this.runManagedTask(request, pane, routing)
  }

  /** Parent conversation cwd: host getConversation errors propagate as-is (nonexistent means a defective spawn input). */
  private parentCwdOrThrow(parentConversationId: number): string {
    const cwd = this.host.parentCwdOf(parentConversationId)
    if (cwd === undefined) {
      throw new HelmError(
        'not_found',
        `parent conversation ${parentConversationId} does not exist or has no cwd; cannot resolve the herdr pane working directory`,
        404,
        { parentConversationId },
      )
    }
    return cwd
  }

  /**
   * Parent conversation's bound node: getConversation errors propagate as-is (same source as parentCwdOf).
   */
  private parentNodeIdOrThrow(parentConversationId: number): string | undefined {
    // The host may reuse the same getConversation call; error semantics are guaranteed honest by the implementation.
    return this.host.parentNodeIdOf(parentConversationId)
  }

  /**
   * Target node platform resolution (for cwd normalization): local target = process.platform; remote
   * trusts only registration facts reported by the node channel (NodeRegistry platform), no report = undefined
   * (no guessing: pass through unchanged).
   */
  private platformOfTarget(target: HerdrTarget): TargetPlatform | undefined {
    const nodeId = targetNodeId(target)
    if (nodeId === undefined) return targetPlatformOf(process.platform)
    const raw = this.deps.nodeChannel?.nodePlatform?.(nodeId)
    return raw !== undefined && raw !== '' ? targetPlatformOf(raw) : undefined
  }

  /** Create the pane and register it (incl. the worktree two-step + reclaiming created resources on mid-way failure). */
  private async createManagedPane(
    request: AgentSpawnRequest,
    routing: SpawnRouting,
    target: HerdrTarget,
    cwd: string,
  ): Promise<ManagedPane> {
    const unique = `${Date.now()}-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const agentName = buildAgentName(HashShort.of(unique))
    const safeId = `${HashShort.of(unique)}${HashShort.of(request.prompt).slice(0, 4)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    const outputFileName = buildOutputFileName(safeId, ext)
    const env = this.buildPaneEnv(request.parentConversationId, cwd, routing, target, request.secretNames)
    const window = await this.createWindow(target, routing, request, cwd, env, agentName)
    // Orchestration-namespace business values are validated at the boundary (the kernel envelope only guarantees JSON-safe).
    const spawnRunId = parseWorkflowSpawnMeta(request.meta).runId
    const managed: ManagedPane = {
      target: window.target,
      paneId: window.paneId,
      tabId: window.tabId,
      ...(window.workspaceId !== undefined ? { workspaceId: window.workspaceId } : {}),
      ...(window.worktree !== undefined ? { worktree: window.worktree } : {}),
      effectiveCwd: window.effectiveCwd,
      agentName,
      routing: { kind: routing.kind, ...(routing.profileId !== undefined ? { profileId: routing.profileId } : {}) },
      parentConversationId: request.parentConversationId,
      ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
      ...(spawnRunId !== undefined ? { workflowRunId: spawnRunId } : {}),
      outcome: 'running',
      outputFileName,
      createdAt: Date.now(),
    }
    this.registry.add(managed)
    await this.registry.flushDisk()
    const key = this.paneKey(managed)
    this.paneEnvs.set(key, this.buildPaneBaselineEnv(request.parentConversationId, window.effectiveCwd, routing, window.target))
    this.unstartedPanes.add(key)
    return managed
  }

  /** Pane creation: plain tab.create({cwd,env,focus:false,label}); worktree mode injects env in two steps. */
  private async createWindow(
    target: HerdrTarget,
    routing: SpawnRouting,
    request: AgentSpawnRequest,
    cwd: string,
    env: Record<string, string>,
    label: string,
  ): Promise<WindowPane & { target: HerdrTarget }> {
    if (request.isolation !== 'worktree') {
      const created = parseTabCreated(
        await this.transport.call(target, 'tab.create', { cwd, env, focus: false, label }, { signal: request.signal }),
      )
      return {
        target,
        paneId: created.rootPane.paneId,
        tabId: created.tab.tabId,
        // Plain mode: the shared workspace is never closed as a whole; close only our own tab.
        workspaceId: undefined,
        effectiveCwd: cwd,
      }
    }
    const branch = `helm/wf-${HashShort.of(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)}`
    const created = parseWorktreeCreated(
      await this.transport.call(
        target,
        'worktree.create',
        { cwd, branch, focus: false, trust_repository: true },
        { signal: request.signal },
      ),
    )
    const effectiveCwd = created.worktree.path
    if (Object.keys(env).length === 0) {
      return {
        target,
        paneId: created.rootPane.paneId,
        tabId: created.tabId,
        workspaceId: created.workspaceId,
        effectiveCwd,
        worktree: created.worktree,
      }
    }
    // worktree.create takes no env: create a tab with env under that workspace afterwards (env rebuilt for the actual
    // worktree cwd), close the initial empty tab; if any step fails, reclaim the created workspace.
    const worktreeEnv = this.buildPaneEnv(request.parentConversationId, effectiveCwd, routing, target, request.secretNames)
    try {
      const tabbed = parseTabCreated(
        await this.transport.call(
          target,
          'tab.create',
          { workspace_id: created.workspaceId, cwd: effectiveCwd, env: worktreeEnv, focus: false, label },
          { signal: request.signal },
        ),
      )
      await assertOkResult(
        await this.transport.call(target, 'tab.close', { tab_id: created.tabId }, { signal: request.signal }),
        'tab.close',
      )
      return {
        target,
        paneId: tabbed.rootPane.paneId,
        tabId: tabbed.tab.tabId,
        workspaceId: created.workspaceId,
        effectiveCwd,
        worktree: created.worktree,
      }
    } catch (error) {
      // Mid-way failure of the two steps: best-effort close of the just-created workspace (reclaim own resources); if the reclaim fails
      // report explicitly (with diagnostics), neither masking the original error nor leaving an orphan pane unreported.
      try {
        await this.transport.call(target, 'workspace.close', { workspace_id: created.workspaceId }, { timeoutMs: 5_000 })
      } catch (cleanupError) {
        this.host.notify(
          'Herdr pane-creation failure reclaim incomplete',
          `reclaiming workspace ${created.workspaceId} after worktree pane-creation failure also failed: ${
            cleanupError instanceof Error ? this.deps.redact(cleanupError.message) : String(cleanupError)
          } (original error: ${error instanceof Error ? this.deps.redact(error.message) : String(error)})`,
          'error',
        )
      }
      throw error
    }
  }

  /**
   * agent.start + readiness wait (real startup sequence):
   * - A successful start may still return unknown/launch_pending (seq=0): wait for authoritative readiness with
   *   the startupTimeout budget via agent.wait(until idle/blocked) (cancellable via signal);
   * - The new PTY's shell may not be ready yet; only for the server-confirmed not-started
   *   agent_pane_busy do we wait-and-retry within the startup budget; never retry an uncertain delivery;
   * - agent_not_ready with authoritative blocked: bridge to the existing agent, do not start a second one.
   */
  private async startAgentAndWaitReady(
    target: HerdrTarget,
    paneId: string,
    routing: SpawnRouting,
    signal?: AbortSignal,
  ): Promise<HerdrAgentInfo> {
    const params: Record<string, unknown> = {
      name: this.registry.get(nodeIdOf({ target }), paneId)?.agentName ?? buildAgentName(HashShort.of(paneId)),
      kind: routing.kind,
      pane_id: paneId,
      timeout_ms: this.host.startupTimeoutMs(),
    }
    if (routing.args.length > 0) params['args'] = routing.args
    const shellDeadline = Date.now() + this.host.startupTimeoutMs()
    let started: HerdrAgentInfo
    for (;;) {
      signal?.throwIfAborted()
      try {
        started = parseAgentResult(
          await this.transport.call(target, 'agent.start', params, { signal }),
          'agent.start',
          'agent_started',
        )
        break
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'agent_pane_busy') {
          const remaining = shellDeadline - Date.now()
          if (remaining <= 0) {
            throw new HelmError('herdr_startup_timeout', `pane ${paneId} : shell not ready within the startup deadline (agent_pane_busy)`, 504)
          }
          await delay(Math.min(this.pollIntervalMs, remaining), undefined, { signal })
          continue
        }
        if (code !== 'agent_not_ready') throw error
        const probe = await this.agentGet(target, paneId, signal)
        if (probe.agentStatus !== 'blocked') throw error
        this.host.notify(
          'Herdr pane already has a waiting Agent',
          `pane ${paneId} returned agent_not_ready with authoritative status blocked; bridging to the existing agent to continue the approval flow, not starting a second agent`,
          'info',
        )
        return probe
      }
    }
    if (started.agentStatus === 'blocked') return started
    if (started.interactiveReady && (started.agentStatus === 'idle' || started.agentStatus === 'done')) return started
    // unknown (a real launch_pending phase) or done (finished extremely fast): wait for authoritative readiness.
    const ready = await this.transport.call(
      target,
      'agent.wait',
      { target: paneId, until: ['idle', 'blocked', 'done', 'working'], timeout_ms: this.host.startupTimeoutMs() },
      { signal },
    )
    return this.waitInteractiveReady(target, paneId, parseAgentResult(ready, 'agent.wait', 'agent_info'), signal)
  }

  private async waitInteractiveReady(target: HerdrTarget, paneId: string, initial: HerdrAgentInfo, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    const deadline = Date.now() + this.host.startupTimeoutMs()
    let info = initial
    while (info.agentStatus !== 'blocked' && !(info.interactiveReady && (info.agentStatus === 'idle' || info.agentStatus === 'done'))) {
      if (Date.now() >= deadline) throw new HelmError('herdr_startup_timeout', `pane ${paneId} did not reach interactive_ready within the startup deadline`, 504)
      await delay(this.pollIntervalMs, undefined, { signal })
      info = await this.agentGet(target, paneId, signal)
    }
    return info
  }

  /** Authoritative agent.get (the single trusted source of seq). */
  private async agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    return parseAgentResult(
      await this.transport.call(target, 'agent.get', { target: paneId }, { signal, timeoutMs: 5_000 }),
      'agent.get',
      'agent_info',
    )
  }

  /**
   * Pane env baseline: buildSpawnEnv (managed HELM_*, the exact target node, **zero stash secrets**)
   * + buildSpawnPaneEnv (Profile merge, remote call-home semantics). Shared by pane creation, Gate and resume;
   * managed HELM_* is authoritative from the kernel (Profile cannot override); remote strips local call-home variables
   * (unless the Profile sets an explicitly valid reachable HELM_HUB_URL or the node channel provides hubUrl).
   * buildSpawnEnv's third argument always gets the exact nodeId ('local' or the remote ID) -- never let the kernel
   * inherit from the parent conversation (a parent bound to a remote node would mis-configure local panes onto the remote).
   */
  private buildPaneBaselineEnv(
    parentConversationId: number,
    cwd: string,
    routing: SpawnRouting,
    target: HerdrTarget,
  ): Record<string, string> {
    const nodeId = targetNodeId(target) ?? 'local'
    const base = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd, nodeId)
    const { env, stripped } = buildSpawnPaneEnv(base, routing.profileEnv, {
      remote: nodeId !== 'local',
      ...(nodeId !== 'local' ? { nodeHubUrl: this.deps.nodeChannel?.getNodeHubUrl?.(nodeId) } : {}),
    })
    if (stripped.length > 0) {
      this.host.notify(
        'Remote pane stripped local call-home variables',
        `node ${nodeId}  has no reachable HELM_HUB_URL; stripped: ${stripped.join(', ')}`,
        'info',
      )
    }
    return env
  }

  /**
   * Full pane env at creation time: baseline + secrets granted for this request's secretNames (fetched fresh
   * from the current stash; missing names error explicitly at the kernel boundary, never silently degrade to empty injection). The
   * created external CLI process env cannot be revoked (an honest boundary); later Gates do not reuse this moment's secret values,
   * each re-authorizes from the baseline.
   */
  private buildPaneEnv(
    parentConversationId: number,
    cwd: string,
    routing: SpawnRouting,
    target: HerdrTarget,
    secretNames?: string[],
  ): Record<string, string> {
    const baseline = this.buildPaneBaselineEnv(parentConversationId, cwd, routing, target)
    if (secretNames === undefined || secretNames.length === 0) return baseline
    return this.applyPaneSecrets(baseline, parentConversationId, cwd, target, secretNames)
  }

  /**
   * Overlay freshly re-authorized values from the current stash onto the baseline: fetched right before each actual use (pane creation/Gate/resume),
   * through no cache; missing/expired/settled names get an explicit 404 at the kernel boundary. The managed HELM_* baseline is
   * authoritative: granted names must not hijack call-home/identity variables (isomorphic to the kernel's buildManagedEnv fixed override).
   */
  private applyPaneSecrets(
    baseline: Record<string, string>,
    parentConversationId: number,
    cwd: string,
    target: HerdrTarget,
    secretNames: string[],
  ): Record<string, string> {
    if (secretNames.length === 0) return { ...baseline }
    const nodeId = targetNodeId(target) ?? 'local'
    const granted = this.deps.buildSpawnEnv(this.host.askConversationId(parentConversationId), cwd, nodeId, {
      secretNames,
    })
    const selected = Object.fromEntries(
      secretNames.filter((name) => Object.hasOwn(granted, name)).map((name) => [name, granted[name]!]),
    )
    return mergeGrantedEnvWithManagedLocks(baseline, selected)
  }

  private executionInfoOf(pane: ManagedPane): AgentExecutionInfo {
    return {
      nodeId: nodeIdOf(pane) ?? 'local',
      executionId: pane.paneId,
      effectiveCwd: pane.effectiveCwd,
      // Business extensions ride in the orchestration-namespace meta (the kernel envelope does not interpret them): the control reference lets
      // the orchestration layer (builtin:workflow.steer) dynamically delegate to this plugin's steer action (zero hardcoding;
      // carries no callbacks or policy); worktree is for the isolation layer's lease registration.
      meta: workflowExecutionMeta({
        controls: { steer: { pluginId: HERDR_STEER_CONTROLS.pluginId, actionId: HERDR_STEER_CONTROLS.actionId } },
        ...(pane.worktree !== undefined
          ? { worktree: { path: pane.worktree.path, branch: pane.worktree.branch ?? '' } }
          : {}),
      }),
    }
  }

  /** Frozen local target (determined at enable). */
  private localTargetOf(): HerdrTarget {
    return this.localTarget
  }

  // ------------------------------------------------------------------
  // Task delivery, approval bridge and file handoff
  // ------------------------------------------------------------------

  private taskPrompt(request: AgentSpawnRequest, pane: ManagedPane): string {
    const fileName = pane.outputFileName!
    const prompt = redactPromptText(request.prompt, this.deps.redact)
    const attachmentBlock = this.buildAttachmentBlock(request, pane)
    const handoff =
      request.schema !== undefined
        ? [
            '',
            '--- helm handoff contract (must follow) ---',
            `When the task completes, write the final structured result to the file ${pane.effectiveCwd}/.helm/${fileName},`,
            'The content must be a single JSON value satisfying the JSON Schema below (no text wrapping it outside a Markdown code block).',
            `JSON Schema: ${redactSchemaText(request.schema, this.deps.redact)}`,
            'Writing the file is the only way to deliver your result; not writing it counts as task failure.',
          ].join('\n')
        : [
            '',
            '--- helm handoff contract (must follow) ---',
            `When the task completes, write the final result (full Markdown) to the file ${pane.effectiveCwd}/.helm/${fileName}.`,
            'Writing the file is the only way to deliver your result; not writing it counts as task failure.',
          ].join('\n')
    return `${prompt}${attachmentBlock}\n${handoff}`
  }

  /**
   * Attachment guidance block (between the task body and the handoff contract):
   * - local pane: local absolute path + the helm artifacts get fetch command;
   * - remote pane: only id/name and the fetch command (fetched via CLI against the remotely reachable HELM_HUB_URL).
   * When deps.getArtifact is not injected, fall back to bare IDs (unit-test environments; no fabricated metadata).
   */
  private buildAttachmentBlock(request: AgentSpawnRequest, pane: ManagedPane): string {
    if (request.attachments === undefined || request.attachments.length === 0) return ''
    const isRemote = nodeIdOf(pane) !== undefined
    const lines: string[] = []
    for (const id of request.attachments) {
      const meta = this.attachmentMetaCache.get(id)
      if (isRemote || meta === undefined) {
        const nameSuffix = meta !== undefined ? ` name=${meta.name} mime=${meta.mimeType} size=${meta.size} bytes` : ''
        lines.push(`- id=${id}${nameSuffix}; fetch: helm artifacts get ${id} --output ./<name>`)
      } else {
        lines.push(
          `- ${meta.name} (id=${id}, mime=${meta.mimeType}, size=${meta.size} bytes, path=${meta.absPath}); fetch: helm artifacts get ${id} --output ./${meta.name}`,
        )
      }
    }
    return `\n\n[Attached Files]\n${lines.join('\n')}`
  }

  /** Attachment metadata cache (resolved once at spawn via deps.getArtifact). Capacity cap prevents long-lived
   *  leaks: over-capacity evicts the oldest entries (re-resolved on the next hit; no fabricated data). */
  private static readonly MAX_ATTACHMENT_META_ENTRIES = 128
  private readonly attachmentMetaCache = new Map<
    string,
    { id: string; name: string; mimeType: string; size: number; absPath: string }
  >()

  /** Resolve attachment metadata before spawn (existence & authorization already validated by the kernel spawnAgent; only display fields are fetched here). */
  private async preloadAttachmentMeta(request: AgentSpawnRequest): Promise<void> {
    if (request.attachments === undefined || this.deps.getArtifact === undefined) return
    for (const id of request.attachments) {
      const meta = await this.deps.getArtifact(id, request.parentConversationId)
      this.attachmentMetaCache.set(id, meta)
    }
    // Over capacity, evict oldest (Map iteration order = insertion order): the cache only optimizes display fields and can be rebuilt at any time.
    while (this.attachmentMetaCache.size > HerdrExecutor.MAX_ATTACHMENT_META_ENTRIES) {
      const oldest = this.attachmentMetaCache.keys().next().value
      if (oldest === undefined) break
      this.attachmentMetaCache.delete(oldest)
    }
  }

  /** Clear this spawn's attachment cache entries after the request settles (a long-lived process must not accumulate historical spawn metadata). */
  private releaseAttachmentMeta(request: AgentSpawnRequest): void {
    if (request.attachments === undefined) return
    for (const id of request.attachments) this.attachmentMetaCache.delete(id)
  }

  /** Task startup, first round and self-heal all live inside the same cancellation & error finalization boundary. */
  private async runManagedTask(request: AgentSpawnRequest, pane: ManagedPane, start?: SpawnRouting): Promise<unknown> {
    return this.runTaskLifecycle(request, pane, async (effectiveRequest) => {
      effectiveRequest.signal?.throwIfAborted()
      effectiveRequest.onResolved?.(this.executionInfoOf(pane))
      if (start !== undefined) {
        let info = await this.startAgentAndWaitReady(pane.target, pane.paneId, start, effectiveRequest.signal)
        this.unstartedPanes.delete(this.paneKey(pane))
        for (;;) {
          await this.waitUntilSettled(effectiveRequest, pane, info)
          info = await this.waitInteractiveReady(
            pane.target,
            pane.paneId,
            await this.agentGet(pane.target, pane.paneId, effectiveRequest.signal),
            effectiveRequest.signal,
          )
          if (info.agentStatus !== 'blocked') break
        }
      }
      return this.driveTask(effectiveRequest, pane)
    })
  }

  /** 任务、重挂与自愈共用的生命周期外壳（abort / timeout / connectionAbort / markFailed / 清理）。 */
  private async runTaskLifecycle(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    body: (effectiveRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    const taskKey = this.paneKey(pane)
    if (this.activeTasks.has(taskKey)) {
      throw new HelmError('pane_busy', `pane ${pane.paneId} 正在被另一个执行占用`, 409, { paneId: pane.paneId })
    }
    const connectionSignal = this.host.connectionSignal
    const effectiveSignal =
      request.signal !== undefined && connectionSignal !== undefined
        ? AbortSignal.any([request.signal, connectionSignal])
        : (request.signal ?? connectionSignal)
    const effectiveRequest: AgentSpawnRequest =
      effectiveSignal === request.signal ? request : { ...request, signal: effectiveSignal }
    this.activeTasks.set(taskKey, effectiveRequest)
    this.panePhases.set(taskKey, 'startup')
    let cleanup: Promise<void> | undefined
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => {
      if (this.host.isClosing?.() === true) {
        rejectAbort(new HelmError('aborted', `pane ${pane.paneId} 因宿主关闭断连保活`, 499))
        return
      }
      if (connectionSignal?.aborted && !request.signal?.aborted) {
        rejectAbort(new HelmError('aborted', `pane ${pane.paneId} 服务连接已断开`, 499))
        return
      }
      if (isTimeoutSignal(request.signal)) {
        rejectAbort(new HelmError('agent_timeout', `pane ${pane.paneId} execution timed out; pane and diagnostics kept (the underlying CLI state will be authoritatively confirmed before resume)`, 408))
        return
      }
      cleanup ??= this.closePane(pane, 'cancelled')
      void cleanup.catch(() => {})
      rejectAbort(new HelmError('aborted', `pane ${pane.paneId} execution cancelled`, 499))
    }
    effectiveSignal?.addEventListener('abort', onAbort, { once: true })
    if (effectiveSignal?.aborted) onAbort()
    try {
      return await Promise.race([aborted, body(effectiveRequest)])
    } catch (error) {
      if (this.host.isClosing?.() === true) {
        // 宿主优雅关停：保活断连，绝不关窗、绝不改写 outcome='failed'/'settled'。
        throw error instanceof HelmError
          ? error
          : new HelmError('aborted', `pane ${pane.paneId} 因宿主关闭断连保活`, 499)
      }
      if (connectionSignal?.aborted && !request.signal?.aborted) {
        throw error instanceof HelmError
          ? error
          : new HelmError('aborted', `pane ${pane.paneId} 服务连接已断开`, 499)
      }
      if (isTimeoutSignal(request.signal)) {
        await this.markFailed(pane, error instanceof Error ? error.message : 'execution timed out')
        const snapshot = await this.paneHandoff.readDiagnostic(pane)
        throw new HelmError(
          'agent_timeout',
          `pane ${pane.paneId} execution timed out; pane kept (the underlying CLI may still be running; authoritatively confirmed before resume, only idle/done may continue, never sending abort keystrokes on your behalf)\nLast 40 terminal lines (redacted):\n${snapshot}`,
          408,
          { paneId: pane.paneId, snapshot },
        )
      }
      if (request.signal?.aborted || (error as { code?: string }).code === 'aborted') {
        cleanup ??= this.closePane(pane, 'cancelled')
        try { await cleanup }
        catch (cleanupError) {
          const note = this.deps.redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
          await this.markFailed(pane, note)
          throw new HelmError('herdr_abort_cleanup_failed', `task cancelled, but closing our own pane failed: ${note}`, 502)
        }
        throw new HelmError('aborted', `pane ${pane.paneId} execution cancelled`, 499)
      }
      await this.markFailed(pane, error instanceof Error ? error.message : String(error))
      if (error instanceof HelmError && error.code === 'herdr_ownership_lost') {
        // 归属已变（可能为人类接管）：不调 agent.read 窥视终端。
        throw error
      }
      const snapshot = await this.paneHandoff.readDiagnostic(pane)
      const failure = error as { code?: unknown; status?: unknown }
      throw new HelmError(
        typeof failure?.code === 'string' ? failure.code : 'herdr_execution_failed',
        `${this.deps.redact(error instanceof Error ? error.message : String(error))}\nLast 40 terminal lines (redacted):\n${snapshot}`,
        error instanceof HelmError ? error.status : 502,
        { paneId: pane.paneId, snapshot },
      )
    } finally {
      effectiveSignal?.removeEventListener('abort', onAbort)
      // This request settles (success/failure/cancellation): task phase / in-flight registries / steer-failure records and
      // the attachment metadata cache are reclaimed together; later steers are rejected as "no steerable task".
      this.activeTasks.delete(taskKey)
      this.panePhases.delete(taskKey)
      this.steerDispatcher.forget(taskKey)
      this.releaseAttachmentMeta(request)
    }
  }

  private async driveTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const key = this.paneKey(pane)
    this.panePhases.set(key, 'task')
    await this.project(pane, `run:${pane.agentName}`)
    const info = await this.promptAndWait(pane.target, pane, this.taskPrompt(request, pane), request.signal)
    await this.steerDispatcher.settleThroughSteers(request, pane, pane.outputFileName!, info)
    // Settlement trusts the registry's current value: a steer may have redirected the single handoff file to a new name
    //(never reuse the initial snapshot and misread the old path).
    const latest = this.registry.get(nodeIdOf(pane), pane.paneId)
    if (latest?.outputFileName === undefined) {
      throw new HelmError('herdr_context_unavailable', `pane ${pane.paneId} : handoff context is no longer valid`, 409)
    }
    return this.finishHandoffAndGate(request, latest)
  }

  /** 交接读取（或复用已预读输出）+ 删交接文件 + Gate + 清理作废旧文件 + 置 keepalive。 */
  private async finishHandoffAndGate(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    preloadedOutput?: unknown,
  ): Promise<unknown> {
    const key = this.paneKey(pane)
    this.panePhases.set(key, 'handoff')
    let output: unknown
    if (preloadedOutput !== undefined) {
      await this.paneHandoff.removeValidatedOutput(pane, request.signal)
      output = preloadedOutput
    } else {
      output = await this.paneHandoff.readAndValidateOutput(request, pane)
    }
    if (request.gate !== undefined) {
      this.panePhases.set(key, 'gate')
      await this.paneHandoff.runGateFor(request, pane)
    }
    request.signal?.throwIfAborted()
    // After a successful handoff, clean up old result files voided by steers (failure paths keep the scene).
    await this.steerDispatcher.clearRetiredOutputs(request, pane)
    this.registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'keepalive', outputFileName: undefined })
    await this.registry.flushDisk()
    return output
  }

  /** A settled blocked watermark first gets a short backoff debounce; if after keystrokes consecutive backoffs still sit on the same blocked seq, reopen the approval for a human re-choice. */
  private static readonly MAX_SETTLED_BLOCKED_BACKOFFS = 2

  /** A settled blocked watermark only backs off; new watermarks go through the same approval bridge. */
  private async waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void> {
    let info = initial
    let attempts = 0
    while (info.agentStatus !== 'idle' && info.agentStatus !== 'done') {
      request.signal?.throwIfAborted()
      if (info.agentStatus === 'blocked') {
        const entry = this.asks.get(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
        if (entry?.phase === 'settled') {
          if (attempts >= HerdrExecutor.MAX_SETTLED_BLOCKED_BACKOFFS) {
            // Loop escape hatch: send_keys was sent but the terminal still sits on the same seq blocked (keystrokes
            // not accepted), or the entry settled with keysSent=false (superseded/cancelled) and
            // the terminal is stuck on the same seq -- both need seq progress to unwind; if there is still no progress after capped backoff,
            // reopen the approval so a human can re-choose against the snapshot; never back off forever into livelock.
            this.asks.reopenUnresolved(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
            attempts = 0
            if (!await this.bridgeBlocked(request, pane, info)) {
              throw new HelmError('aborted', `human cancelled the approval for pane ${pane.paneId}`, 409)
            }
          } else {
            await backoffForDuplicateBlocked(signalOf(request), ++attempts, this.deps.blockedBackoffBaseMs, this.deps.blockedBackoffCapMs)
          }
        } else {
          if (!await this.bridgeBlocked(request, pane, info)) {
            throw new HelmError('aborted', `human cancelled the approval for pane ${pane.paneId}`, 409)
          }
          attempts = 0
        }
      } else if (info.agentStatus === 'unknown') {
        throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId}  state unknown; completion cannot be confirmed`, 502)
      }
      info = parseAgentResult(await this.transport.call(
        pane.target, 'agent.wait', { target: pane.paneId, until: ['idle', 'done', 'blocked'] }, { signal: request.signal },
      ), 'agent.wait', 'agent_info')
    }
  }

  private paneKey(pane: ManagedPane): string {
    return paneStateKey(pane)
  }

  /** closePane single-flight key (fully isomorphic to the one inside closePane: steer gating reuses the same coordinate). */
  private closeKey(pane: ManagedPane): string {
    return paneCloseKey(pane)
  }

  /** prompt --wait (shared with the self-heal follow-up): blocked may also return immediately (the approval bridge takes over). */
  private async promptAndWait(target: HerdrTarget, pane: ManagedPane, text: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    return parseAgentResult(
      await this.transport.call(
        target,
        'agent.prompt',
        { target: pane.paneId, text, wait: { until: ['done', 'idle', 'blocked'] } },
        { signal },
      ),
      'agent.prompt',
      'agent_prompted',
    )
  }

  /**
   * blocked bridging: authoritative agent.get for seq -> coordinator single flight -> createAsk (pre-allocated id)
   * -> re-check seq after the answer -> CAS send_keys with expected_state_seq. Returns false when the human cancels.
   */
  private async bridgeBlocked(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    observed: HerdrAgentInfo,
  ): Promise<boolean> {
    const target = targetOf(pane)
    const authority = await this.agentGet(target, pane.paneId, request.signal)
    for (const superseded of this.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.cancelAskQuietly(superseded.askId, 'superseded')
    }
    if (authority.agentStatus !== 'blocked') return true // The terminal already handled it (stale snapshot).

    const begin = this.asks.beginBlocked(nodeIdOf(pane), pane.paneId, authority.stateChangeSeq)
    const entry: AskEntry =
      'owner' in begin
        ? begin.owner
        : this.asks.get(nodeIdOf(pane), pane.paneId, authority.stateChangeSeq)!
    if (entry === undefined) return true
    if (entry.phase === 'settled') return true
    const existing = this.blockedTasks.get(entry.askId)
    if (existing !== undefined) return existing
    const task = Promise.resolve().then(async () => {
      await this.project(pane, `ask:${entry.askId}`)
      const { outcome, plan } = await this.approvalBridge.createAsk(request, pane, entry, this.host.askConversationId(request.parentConversationId))
      return this.approvalBridge.consumeAskOutcome(request, pane, entry, outcome, plan)
    }).catch(async (error: unknown) => {
      // When the task chain fails while the entry is still pending (the host AskDoc is stored but unsettled), it must first be explicitly
      // cancelled before clearing -- failCreate only clears the coordinator, otherwise the host keeps a forever-pending
      // orphan approval card.
      if (entry.phase === 'pending' && this.asks.get(nodeIdOf(pane), pane.paneId, entry.seq) === entry) {
        await this.cancelAskQuietly(entry.askId, 'cancelled')
      }
      this.asks.failCreate(entry)
      throw error
    }).finally(() => this.blockedTasks.delete(entry.askId))
    this.blockedTasks.set(entry.askId, task)
    return task
  }

  // ------------------------------------------------------------------
  // In-flight steer: only the task phase + agent.get precheck + the existing agent.prompt
  // (delivery, gating, settle draining and voided-file cleanup in executor-steer.ts)
  // ------------------------------------------------------------------

  /** In-flight steer for a managed pane (public entry; gating and single-delivery semantics in SteerDispatcher.steerPane). */
  async steerPane(pane: ManagedPane, input: SteerPaneInput): Promise<{ stateChangeSeq: number }> {
    return this.steerDispatcher.steerPane(pane, input)
  }

  // ------------------------------------------------------------------
  // resume (authoritative confirmation and routing recovery implemented in executor-resume.ts)
  // ------------------------------------------------------------------

  private async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
    return this.resumeCoordinator.resumeInto(request, candidates)
  }

  // ------------------------------------------------------------------
  // Cleanup and state
  // ------------------------------------------------------------------

  /**
   * Close an own pane (single flight + settled idempotence):
   * - already closing: reuse the same close promise (concurrency-safe across the abort and settle paths);
   * - the outcome verdict trusts the registry's current value (the caller's snapshot may be stale: while waiting, the task may have
   *   already been markFailed -- failure panes keep the scene and must never be closed by batch cleanup nor
   *   have their failureNote overwritten); settled / failed both return directly;
   * - close only own resources: plain tab.close; worktree workspace.close (close_group prevents chained groups);
   * - failure panes keep the scene; cleanup failures notify and rethrow honestly (no empty catch).
   */
  async closePane(
    pane: ManagedPane,
    reason: 'settled' | 'cancelled' | 'workflow-settled' | 'turn-settled',
    options: { volatileMark?: boolean } = {},
  ): Promise<void> {
    // The single-flight key and the steer gate (assertSteerable.activeCloses check) share the same coordinate.
    const key = this.closeKey(pane)
    const existing = this.activeCloses.get(key)
    if (existing !== undefined) return existing
    const current = this.registry.get(nodeIdOf(pane), pane.paneId)
    const outcome = current?.outcome ?? pane.outcome
    if (outcome === 'failed' || outcome === 'settled') return
    const closing = (async () => {
      const target = targetOf(pane)
      try {
        let owned = false
        try {
          const authority = await this.agentGet(target, pane.paneId)
          owned = authority.name === pane.agentName && authority.tabId === pane.tabId
          if (authority.name === undefined && this.unstartedPanes.has(this.paneKey(pane))) owned = true
        } catch (error) {
          if ((error as { code?: string }).code !== 'agent_not_found') throw error
          owned = this.unstartedPanes.has(this.paneKey(pane))
        }
        for (const entry of this.asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
          await this.cancelAskQuietly(entry.askId, 'superseded')
        }
        if (owned) {
          // Herdr reclaims an empty workspace when its last tab closes. Close only tabs created by this plugin,
          // avoiding panes later added by humans or associated workspaces.
          await assertOkResult(await this.transport.call(target, 'tab.close', { tab_id: pane.tabId }, { timeoutMs: 5_000 }), 'tab.close')
        } else {
          this.host.notify('Herdr pane ownership changed', `pane ${pane.paneId} no longer belongs to ${pane.agentName}; giving up cleanup`, 'info')
        }
      } catch (error) {
        this.host.notify(
          'Herdr pane cleanup failed',
          `pane ${pane.paneId} (${reason}) close failed: ${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
          'error',
        )
        throw error
      }
      if (options.volatileMark === true) {
        // Service stop path: the persistent doc handle died with the disable; memory-only marking (reconciliation rebuilds next cycle).
        this.registry.markSettledVolatile(nodeIdOf(pane), pane.paneId)
      } else {
        this.registry.update(nodeIdOf(pane), pane.paneId, {
          outcome: 'settled',
          settledAt: Date.now(),
          outputFileName: undefined,
        })
      }
      this.projector.forget(pane.paneId, nodeIdOf(pane))
      this.paneEnvs.delete(this.paneKey(pane))
      this.unstartedPanes.delete(this.paneKey(pane))
      this.panePhases.delete(this.paneKey(pane))
      this.activeTasks.delete(this.paneKey(pane))
      this.steerDispatcher.forget(this.paneKey(pane))
      for (const removed of this.asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
        if (removed.phase === 'pending' || removed.phase === 'creating') {
          await this.cancelAskQuietly(removed.askId, 'superseded')
        }
      }
    })().finally(() => this.activeCloses.delete(key))
    this.activeCloses.set(key, closing)
    return closing
  }

  /**
   * Executor-side resource alignment for external settle paths (pane.closed event / startup reconciliation / probe ownership mismatch):
   * once the registry is settled, closePane early-exits idempotently, so the env baseline paneEnvs
   * (incl. managed HELM_TOKEN, no stash secrets) and the not-started markers must be released here explicitly, keeping the lifecycle
   * aligned with the registry outcome instead of lingering one by one until the disable rebuild. In-flight steer
   * phase/task registrations are voided in sync (their tail-read recheck will deterministically reject).
   */
  releasePaneState(pane: ManagedPane): void {
    const key = this.paneKey(pane)
    this.paneEnvs.delete(key)
    this.unstartedPanes.delete(key)
    this.panePhases.delete(key)
    this.activeTasks.delete(key)
    this.steerDispatcher.forget(key)
  }

  private async cancelAskQuietly(askId: string, reason: 'cancelled' | 'superseded'): Promise<void> {
    try {
      await this.host.cancelAsk(askId, reason)
    } catch (error) {
      if (
        error instanceof HelmError &&
        (error.status === 404 ||
          error.code === 'ask_already_settled' ||
          error.code === 'plugin_host_disposed' ||
          error.code === 'plugin_context_expired')
      ) {
        return
      }
      this.host.notify(
        'Herdr approval cancellation failed',
        `ask ${askId} cancel failed: ${error instanceof Error ? this.deps.redact(error.message) : String(error)}`,
        'error',
      )
    }
  }

  private async markFailed(pane: ManagedPane, note: string): Promise<void> {
    // Failure panes keep the terminal scene for manual investigation, but the call-home secret env is no longer needed (no further gate).
    this.paneEnvs.delete(this.paneKey(pane))
    this.registry.update(nodeIdOf(pane), pane.paneId, {
      outcome: 'failed',
      failureNote: this.deps.redact(note).slice(0, 500),
      settledAt: Date.now(),
      outputFileName: undefined,
    })
    this.projector.forget(pane.paneId, nodeIdOf(pane))
    for (const removed of this.asks.paneClosed(pane.paneId, nodeIdOf(pane)) ?? []) {
      if (removed.phase === 'pending' || removed.phase === 'creating') {
        await this.cancelAskQuietly(removed.askId, 'superseded')
      }
    }
  }

  private async project(pane: ManagedPane, token: string): Promise<void> {
    await this.projector.project(nodeIdOf(pane), pane.paneId, token)
  }
}

function isTimeoutSignal(signal: AbortSignal | undefined): boolean {
  const reason = signal?.reason
  return reason instanceof Error && reason.name === 'TimeoutError'
}

function signalOf(request: AgentSpawnRequest): AbortSignal {
  return request.signal ?? new AbortController().signal
}

export type { PaneRouting }
