/**
 * Herdr executor submodule: in-flight steer delivery and single-handoff-file rotation.
 *
 * Split out of executor.ts (behavior line-for-line equivalent to before the split); dependencies injected via
 * SteerDispatcherPort (the executor holds the registry / transport / authoritative agent.get / phase and task registries):
 * - steerPane: in-flight steer for a managed pane (mutual exclusion per pane; single delivery, no retry);
 * - settleThroughSteers: in-flight steer draining before task settlement, authoritative recheck and latest
 *   handoff file verification (a successful steer redirects the single handoff file to a brand-new name; old results are naturally spoof-proof);
 * - state registries (in-flight steers / uncertain-delivery failures / voided old-file list) are self-managed
 *   here; the executor voids them via forget() at task settlement, closePane and releasePaneState.
 *
 * Honesty semantics: guardLevel='preflight' -- the precheck is not a commit-point atomic recheck (never
 * claim CAS); steered=true only means the single delivery succeeded.
 */

import { randomUUID } from 'node:crypto'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult, type HerdrAgentInfo } from './rpc.js'
import { buildOutputFileName } from './spawn-rules.js'
import type { SteerPaneInput } from './executor.js'

/** Managed-task lifecycle phases (consistent with the executor's internal registry; only 'task' is steerable). */
export type SteerPhase = 'startup' | 'task' | 'handoff' | 'gate'

/** The minimal dependency surface of SteerDispatcher on the executor. */
export interface SteerDispatcherPort {
  registry: PaneRegistry
  transport: NonNullable<HerdrPluginDependencies['transport']>
  redact(text: string): string
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** Authoritative agent.get (the single trusted source of seq; held by the executor). */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** Settle waiting + blocked approval bridge loop (held by the executor). */
  waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void>
  /** agent.start startup timeout (config.startupTimeoutMs; budget reuse per call site). */
  startupTimeoutMs(): number
  /** Budget for waiting for the follow-up turn to start after a steer (shortened in tests; defaults to reusing startupTimeoutMs()). */
  steerWaitBudgetMs?: number
  /** The in-flight managed task's request (steer gate rechecks the original run signal). */
  activeTaskOf(key: string): AgentSpawnRequest | undefined
  /** The in-flight task's current phase (startup/task/handoff/gate; undefined when no task). */
  phaseOf(key: string): SteerPhase | undefined
  /** Update the in-flight task's phase (the settle-verification final segment switches to handoff; steers are rejected by the phase gate afterwards). */
  setPhase(key: string, phase: SteerPhase): void
  /** Whether the pane is currently closing (closePane single-flight registry; no steers while closing). */
  isClosingPane(pane: ManagedPane): boolean
}

export class SteerDispatcher {
  /** Short timeout for steer delivery: a single delivery after precheck should be far shorter than this; on timeout report uncertainty honestly, no retry. */
  private static readonly STEER_PROMPT_TIMEOUT_MS = 5_000

  /** Server-admission rejection codes confirmed to have written nothing (all other timeouts/disconnects/bad responses are treated as uncertain delivery). */
  private static readonly STEER_ZERO_WRITE_CODES = new Set(['agent_not_ready', 'agent_blocked', 'agent_not_found'])

  /** In-flight steers (mutual exclusion per pane; drained before driveTask settles). */
  private readonly activeSteers = new Map<string, Promise<{ stateChangeSeq: number }>>()
  /**
   * Steer failure records for uncertain deliveries (timeouts/disconnects/bad responses) (paneKey -> redacted reason):
   * after draining in-flight steers, task settlement fails explicitly and keeps the scene based on these
   * (never reads old results nor fakes via self-heal); later steers must not clear unconfirmed deliveries.
   * Server-admission confirmations of zero writes (agent_not_ready/agent_blocked/agent_not_found)
   * are not recorded here.
   */
  private readonly steerFailures = new Map<string, string>()
  /** Old handoff file names voided by steers (paneKey -> list; cleaned up together only after a successful handoff). */
  private readonly steerRetiredFiles = new Map<string, string[]>()

  constructor(private readonly port: SteerDispatcherPort) {}

  hasInFlight(key: string): boolean {
    return this.activeSteers.has(key)
  }

  inFlightOf(key: string): Promise<{ stateChangeSeq: number }> | undefined {
    return this.activeSteers.get(key)
  }

  hasUncertain(key: string): boolean {
    return this.steerFailures.has(key)
  }

  uncertainOf(key: string): string | undefined {
    return this.steerFailures.get(key)
  }

  /** Void steer registries on task settle / pane close / external release (in-flight steer promises exit on their own). */
  forget(key: string): void {
    this.steerFailures.delete(key)
    this.steerRetiredFiles.delete(key)
  }

  /**
   * In-flight steer for a managed pane (mutual exclusion per pane; single delivery, no retry):
   *
   * Gates (any step failing rejects deterministically, never silently degrades):
   * 1. live execution context: the registry's current outcome=running and phase 'task'
   *    (startup/handoff/gate/keepalive/failed/settled always reject);
   * 2. strict run/parent-conversation match: workflowRunId and parentConversationId must exactly
   *    equal the managed record (only for panes managed under a workflow run);
   * 3. the original run signal is not cancelled (frozen cross-node target: no node/socket recompute, no
   *    accepting the same pane on a different node -- guaranteed by the plugin action layer's exact (nodeId, paneId) targeting);
   * 4. agent.get precheck: name/tab/pane identities match exactly, working and not
   *    launch_pending; blocked goes to the original Ask approval bridge (rejected here); a precheck that is already
   *    idle/done/unknown rejects (never proactively start a new turn);
   * 5. after the precheck crosses an await, recheck phase/registry/run signal;
   * 6. delivery: the existing agent.prompt {target: managed agentName, text}, no wait,
   *    no extra guard fields, an explicit short timeout; a single call is final, never retried. A submission that
   *    turned idle between precheck and server receipt is ruled by real admission (continuing into a new turn
   *    is allowed); server-confirmed zero-write rejections (agent_not_ready/agent_blocked/
   *    agent_not_found) leave the original handoff path untouched; timeouts/disconnects/bad responses
   *    are uncertain deliveries -- recorded as a per-pane failure; task settlement fails explicitly and keeps
   *    the scene, never falling back to the old handoff file or auto-resending.
   *
   * Honesty semantics: guardLevel='preflight' -- the precheck is not a commit-point atomic recheck (never
   * claim CAS); steered=true only means the single delivery succeeded. Every successful steer redirects
   * the single handoff file to a brand-new wf-out-* name (the old name is voided): settlement accepts only the
   * latest name's delivery; old results / late write-backs are naturally unable to spoof.
   */
  async steerPane(pane: ManagedPane, input: SteerPaneInput): Promise<{ stateChangeSeq: number }> {
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new HelmError('validation_error', 'steer guidance text cannot be blank', 400)
    }
    const key = paneStateKey(pane)
    if (this.activeSteers.has(key)) {
      throw new HelmError(
        'herdr_steer_in_flight',
        `pane ${pane.paneId} already has an in-flight steer; re-entry rejected (mutual exclusion per pane)`,
        409,
        { paneId: pane.paneId },
      )
    }
    const steer = (async (): Promise<{ stateChangeSeq: number }> => {
      // 1-2) live context + phase + strict run/parent match (the registry's current values are authoritative).
      const current = this.assertSteerable(pane, input)
      // 3) The original run signal is not cancelled.
      const origin = this.port.activeTaskOf(key)
      if (origin === undefined || origin.signal?.aborted) {
        throw new HelmError(
          'herdr_steer_task_ended',
          `pane ${pane.paneId}'s original task has ended or is being cancelled; steer rejected`,
          409,
          { paneId: pane.paneId },
        )
      }
      // 4) Precheck: authoritative agent.get verifies identity and working state (preflight, not a commit-point CAS).
      const authority = await this.port.agentGet(current.target, current.paneId, input.signal)
      if (
        authority.paneId !== current.paneId ||
        authority.tabId !== current.tabId ||
        authority.name !== current.agentName
      ) {
        throw new HelmError(
          'herdr_steer_identity_mismatch',
          `pane ${current.paneId}'s authoritative identity does not match the managed record (name=${String(authority.name)} tab=${authority.tabId}); steer rejected`,
          409,
          { paneId: current.paneId, authorityName: authority.name, authorityTabId: authority.tabId },
        )
      }
      if (authority.launchPending === true) {
        throw new HelmError(
          'herdr_steer_not_ready',
          `pane ${current.paneId} is still starting (launch_pending); steer rejected`,
          409,
          { paneId: current.paneId },
        )
      }
      if (authority.agentStatus === 'blocked') {
        throw new HelmError(
          'herdr_steer_agent_blocked',
          `pane ${current.paneId} is currently blocked (awaiting approval); steering is the original approval bridge's job: complete the approval in the AskDock first`,
          409,
          { paneId: current.paneId, stateChangeSeq: authority.stateChangeSeq },
        )
      }
      if (authority.agentStatus !== 'working') {
        throw new HelmError(
          'herdr_steer_not_working',
          `pane ${current.paneId}'s current state is ${authority.agentStatus}; only working is steerable (never start a new turn)`,
          409,
          { paneId: current.paneId, agentStatus: authority.agentStatus },
        )
      }
      // 5) Recheck after the precheck crosses an await: the task may have settled/cancelled/entered a new phase.
      this.assertSteerable(pane, input)
      const originAfter = this.port.activeTaskOf(key)
      if (originAfter === undefined || originAfter.signal?.aborted) {
        throw new HelmError(
          'herdr_steer_task_ended',
          `pane ${pane.paneId}'s original task ended or was cancelled during the steer; delivery aborted (no input sent)`,
          409,
          { paneId: pane.paneId },
        )
      }
      // 6) Single delivery: a brand-new unique handoff file name + the existing agent.prompt (no wait/no extra fields).
      const next = this.nextSteerOutputFileName(current)
      const text = this.steerPromptText(current, input, next)
      try {
        parseAgentResult(
          await this.port.transport.call(
            current.target,
            'agent.prompt',
            { target: current.agentName, text },
            { signal: input.signal, timeoutMs: SteerDispatcher.STEER_PROMPT_TIMEOUT_MS },
          ),
          'agent.prompt',
          'agent_prompted',
        )
      } catch (error) {
        const code = (error as { code?: string }).code
        if (typeof code === 'string' && SteerDispatcher.STEER_ZERO_WRITE_CODES.has(code)) {
          // Server admission confirmed zero writes: do not redirect the handoff file, do not record failure;
          // the original task continues at its own pace (the previous valid path stays unchanged).
          throw error
        }
        // Timeout/disconnect/bad response: the delivery outcome is uncertain (it may have been written). Record a per-pane failure;
        // task settlement fails explicitly and keeps the scene; never silently fall back to the old file or auto-resend.
        if (this.port.activeTaskOf(key) === origin) {
          this.steerFailures.set(key, error instanceof Error ? error.message : String(error))
        }
        throw error
      }
      if (this.port.activeTaskOf(key) !== origin || origin.signal?.aborted || this.port.isClosingPane(current)) {
        throw new HelmError('herdr_steer_task_ended', `pane ${pane.paneId}'s input was delivered, but the original task was cancelled or closed; inspect the scene, do not resend`, 409)
      }
      // Redirect the single handoff file after successful delivery; visible when settlement drains in-flight steers.
      this.port.registry.update(nodeIdOf(current), current.paneId, { outputFileName: next })
      const retired = this.steerRetiredFiles.get(key) ?? []
      if (current.outputFileName !== undefined && current.outputFileName !== '') {
        retired.push(current.outputFileName)
      }
      this.steerRetiredFiles.set(key, retired)
      return { stateChangeSeq: authority.stateChangeSeq }
    })().finally(() => this.activeSteers.delete(key))
    this.activeSteers.set(key, steer)
    return steer
  }

  /** Steer gate prelude (registry current-value recheck; returns the current value for later steps). */
  private assertSteerable(pane: ManagedPane, input: SteerPaneInput): ManagedPane {
    const current = this.port.registry.get(nodeIdOf(pane), pane.paneId)
    if (current === undefined || current.outcome !== 'running') {
      throw new HelmError(
        'herdr_steer_not_running',
        `pane ${pane.paneId} is not under managed running (outcome=${current?.outcome ?? 'unmanaged'}); steer rejected`,
        409,
        { paneId: pane.paneId, outcome: current?.outcome ?? 'unmanaged' },
      )
    }
    // Reject while closing: closePane registers activeCloses synchronously at entry, but phase/outcome
    // change only after several awaits -- non-abort closes (workflow/turn settle,
    // reconciliation reclaim) must also block steers, not just the task+running gate.
    if (this.port.isClosingPane(pane)) {
      throw new HelmError(
        'herdr_steer_task_ended',
        `pane ${pane.paneId} is closing (settle/cancel/reclaim in progress); steer rejected`,
        409,
        { paneId: pane.paneId },
      )
    }
    const phase = this.port.phaseOf(paneStateKey(pane))
    if (phase !== 'task') {
      throw new HelmError(
        'herdr_steer_phase',
        `pane ${pane.paneId} is currently in phase ${phase ?? 'no in-flight task'}; only the task execution phase (task) is steerable`,
        409,
        { paneId: pane.paneId, phase: phase ?? 'none' },
      )
    }
    if (current.workflowRunId !== input.workflowRunId || current.parentConversationId !== input.parentConversationId) {
      throw new HelmError(
        'herdr_steer_context_mismatch',
        `pane ${pane.paneId}'s managed ownership (workflow=${String(current.workflowRunId)} parent conversation=${current.parentConversationId}) does not match the steer target (workflow=${input.workflowRunId} parent conversation=${input.parentConversationId}); cross-track steer rejected`,
        409,
        {
          paneId: pane.paneId,
          managedWorkflowRunId: current.workflowRunId,
          managedParentConversationId: current.parentConversationId,
          requestedWorkflowRunId: input.workflowRunId,
          requestedParentConversationId: input.parentConversationId,
        },
      )
    }
    if (this.steerFailures.has(paneStateKey(pane))) {
      throw new HelmError(
        'herdr_steer_uncertain',
        `pane ${pane.paneId}'s previous steer delivery is uncertain; inspect the scene first -- do not keep steering to bury that result`,
        409,
        { paneId: pane.paneId },
      )
    }
    return current
  }

  /** Steer delivery text: source prefix + redacted guidance + handoff file redirect (old path voided; only the latest guidance counts). */
  private steerPromptText(pane: ManagedPane, input: SteerPaneInput, nextFileName: string): string {
    const previous = pane.outputFileName
    if (previous === undefined || previous === '') {
      throw new HelmError(
        'herdr_context_unavailable',
        `pane ${pane.paneId} has no handoff file name (abnormal task phase); steer rejected`,
        409,
        { paneId: pane.paneId },
      )
    }
    return [
      `Parent-conversation steer (background run ${input.workflowRunId}):`,
      this.port.redact(input.text),
      '',
      '--- helm handoff contract update (must follow) ---',
      `After finishing the remaining work per this steer's latest guidance, write the final result to the new file ${pane.effectiveCwd}/.helm/${nextFileName} (same content requirements as the original handoff contract; must still pass the original Schema and Gate).`,
      `The original handoff file ${previous} is voided: do not write the old file again; helm accepts only the new file's delivery, and not writing it counts as task failure.`,
    ].join('\n')
  }

  /** The brand-new unique handoff file name for this steer (same extension as the current business file; reuses the same whitelist). */
  private nextSteerOutputFileName(pane: ManagedPane): string {
    const fileName = pane.outputFileName
    if (fileName === undefined || fileName === '') {
      throw new HelmError(
        'herdr_context_unavailable',
        `pane ${pane.paneId} has no handoff file name (abnormal task phase); steer rejected`,
        409,
        { paneId: pane.paneId },
      )
    }
    const ext = fileName.endsWith('.json') ? 'json' : 'md'
    return buildOutputFileName(`s${randomUUID()}`, ext)
  }

  /** Clean up old result files voided by steers after a successful handoff (failure paths keep the scene; cleanup failure notifies explicitly without dragging down the verified result). */
  async clearRetiredOutputs(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const key = paneStateKey(pane)
    const retired = this.steerRetiredFiles.get(key)
    if (retired === undefined || retired.length === 0) return
    try {
      for (const fileName of retired) {
        await this.port.transport.removeOutput(targetOf(pane), pane.effectiveCwd, fileName, request.signal)
      }
    } catch (error) {
      this.port.notify(
        'Herdr voided-handoff-file cleanup incomplete',
        `Failed to delete the old result file voided by a steer (result already verified; does not affect this delivery): ${error instanceof Error ? this.port.redact(error.message) : String(error)}`,
        'error',
      )
    } finally {
      this.steerRetiredFiles.delete(key)
    }
  }

  /**
   * Settle waiting + in-flight steer draining + authoritative recheck + latest handoff file verification:
   * - The first idle/done may be observed by agent.wait before the steer delivery lands (a multi-step
   *   text+Enter sequence) -- do not go straight to handoff. After draining in-flight steers (waiting for
   *   the real RPC final state, not a fixed delay), recheck with authoritative agent.get: working means
   *   the steer started a new turn (back to settle waiting); blocked goes to the approval bridge; unknown fails honestly;
   * - Uncertain deliveries (timeouts/disconnects/bad responses) already recorded per pane: settlement
   *   fails explicitly with herdr_steer_uncertain and keeps the scene (never reads old results, nor fakes a
   *   latest-guidance delivery via the self-heal follow-up); later steers cannot erase that uncertain result;
   * - A successful steer redirects the single handoff file to a brand-new name (old results are naturally
   *   spoof-proof): on idle/done the new file must exist before entering handoff -- bounded
   *   agent.wait(until working/blocked) waits for the follow-up turn to start, then rechecks (idle alone
   *   does not prove the CLI consumed the queue); if the budget is exhausted with no new file, the single
   *   self-heal in readAndValidateOutput backstops on the latest file name (if still missing after the follow-up, fail explicitly and keep the scene);
   * - During file verification's awaits another steer may land (redirecting to a newer name) or leave an
   *   uncertain record: verification must restart; the final verification and the handoff phase switch happen
   *   in the same synchronous segment, after which steers are rejected by the phase gate.
   */
  async settleThroughSteers(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    initialFileName: string,
    initial: HerdrAgentInfo,
  ): Promise<void> {
    const key = paneStateKey(pane)
    const latestName = (): string | undefined => this.port.registry.get(nodeIdOf(pane), pane.paneId)?.outputFileName
    const steerSettled = (): boolean => !this.hasInFlight(key) && !this.hasUncertain(key)
    let info = initial
    for (;;) {
      await this.port.waitUntilSettled(request, pane, info)
      const inFlight = this.inFlightOf(key)
      if (inFlight !== undefined) await inFlight.catch(() => {})
      const uncertain = this.uncertainOf(key)
      if (uncertain !== undefined) {
        throw new HelmError(
          'herdr_steer_uncertain',
          `pane ${pane.paneId}'s steer delivery is uncertain (${this.port.redact(uncertain)}): refusing to pass off an old handoff result or a self-heal follow-up as a latest-guidance delivery; the task fails explicitly and keeps the scene`,
          502,
          { paneId: pane.paneId, reason: this.port.redact(uncertain) },
        )
      }
      const authority = await this.port.agentGet(pane.target, pane.paneId, request.signal)
      if (authority.agentStatus === 'working' || authority.agentStatus === 'blocked') {
        info = authority
        continue
      }
      if (authority.agentStatus === 'unknown') {
        throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} state unknown; completion cannot be confirmed`, 502)
      }
      if (!steerSettled()) continue
      const currentName = latestName()
      if (currentName !== undefined && currentName !== initialFileName) {
        // The steer redirected the single handoff file: do not enter handoff before the new file appears (anti-spoof for old results).
        let present = false
        try {
          await this.port.transport.readOutput(targetOf(pane), pane.effectiveCwd, currentName, request.signal)
          present = true
        } catch (error) {
          if (!(error instanceof HelmError && error.code === 'herdr_output_missing')) throw error
        }
        if (!steerSettled() || latestName() !== currentName) continue
        if (!present) {
          // New result not present: bounded wait for the follow-up turn to start, then recheck (working/blocked goes back to the main loop).
          const resumed = await this.waitSteerTurnOrNone(request, pane)
          if (resumed !== undefined) {
            info = resumed
            continue
          }
          // It may have just started near the timeout: recheck the authoritative state first, to avoid prematurely following up on a still-working CLI.
          info = await this.port.agentGet(pane.target, pane.paneId, request.signal)
          if (!steerSettled() || latestName() !== currentName) continue
          if (info.agentStatus === 'working' || info.agentStatus === 'blocked') continue
          if (info.agentStatus === 'unknown') {
            throw new HelmError('herdr_agent_unsettled', `pane ${pane.paneId} state unknown; completion cannot be confirmed`, 502)
          }
          // When still settled, the original single self-heal backstops on the latest file name; never read the old file.
        }
      }
      // Final verification and the handoff switch in the same synchronous segment: steers are rejected by the phase gate afterwards.
      if (!steerSettled() || latestName() !== currentName) continue
      request.signal?.throwIfAborted()
      this.port.setPhase(key, 'handoff')
      return
    }
  }

  /**
   * Bounded wait for the follow-up turn (agent.wait until working/blocked; budget reuses the startup timeout):
   * returns the new turn's authoritative info (working/blocked); returns undefined when the budget is exhausted.
   * On timeout the caller rechecks state, then takes the original single handoff self-heal on the latest business file.
   */
  private async waitSteerTurnOrNone(
    request: AgentSpawnRequest,
    pane: ManagedPane,
  ): Promise<HerdrAgentInfo | undefined> {
    const budgetMs = this.port.steerWaitBudgetMs ?? this.port.startupTimeoutMs()
    try {
      return parseAgentResult(
        await this.port.transport.call(
          pane.target,
          'agent.wait',
          { target: pane.paneId, until: ['working', 'blocked'], timeout_ms: budgetMs },
          { signal: request.signal, timeoutMs: budgetMs + 1_000 },
        ),
        'agent.wait',
        'agent_info',
      )
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'timeout' || code === 'herdr_timeout') return undefined
      throw error
    }
  }
}
