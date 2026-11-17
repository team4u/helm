/**
 * Herdr executor submodule: resume authoritative confirmation and routing recovery.
 *
 * Split out of executor.ts (behavior line-for-line equivalent to before the split); dependencies injected
 * via ResumePort (the executor holds the registry / authoritative agent.get / attachment gate / env baseline and the task main loop).
 *
 * Timeout safety boundary (TimeoutError aborts, distinct from plain AbortError cancellation):
 * - There is no safe stop/CAS means to stop the underlying CLI -- on timeout we only save diagnostics and keep the pane (mark failed,
 *   no window close, no keystrokes), never dressing a kept pane up as unconditionally resumable;
 * - a later resume passes assertResumeAgentConfirmed for authoritative confirmation before any prompt is sent:
 *   only idle/done may resume; working/blocked/unknown/unconfirmable are explicitly rejected
 *   (no new pane, no keystroke abort); a startup-phase timeout (agent.start completion uncertain) likewise
 *   confirms safely first, never blindly re-sends agent.start.
 */

import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import { parseWorkflowSpawnMeta } from '../contracts.js'
import { targetNodeId, type HerdrPluginDependencies, type HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane, type PaneRegistry } from './panes.js'
import type { HerdrAgentInfo } from './rpc.js'
import {
  assertNoUnsupportedOverrides,
  buildOutputFileName,
  HashShort,
  resolveSpawnRouting,
  type SpawnRouting,
} from './spawn-rules.js'

/** The minimal dependency surface of ResumeCoordinator on the executor. */
interface ResumePort {
  registry: PaneRegistry
  /** Profile runtime table (for resolveSpawnRouting's dual entries). */
  profiles: HerdrPluginDependencies['profiles']
  redact(text: string): string
  /** Authoritative agent.get (the single trusted source of seq; held by the executor). */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** Attachment honesty gate (before any resume side effect; explicit rejection when remote has no reachable HELM_HUB_URL). */
  assertAttachmentsReachable(request: AgentSpawnRequest, target: HerdrTarget, routing: SpawnRouting): void
  /** Orchestration-layer execution info (controls.steer delegation reference and worktree lease registration). */
  executionInfoOf(pane: ManagedPane): AgentExecutionInfo
  /** Pane env baseline registry (rebuilt per current routing when missing at resume; no stash secrets). */
  hasPaneEnv(key: string): boolean
  setPaneEnv(key: string, env: Record<string, string>): void
  /** Pane env baseline rebuild (buildSpawnEnv managed HELM_* + Profile merge; no stash secrets). */
  buildPaneBaselineEnv(parentConversationId: number, cwd: string, routing: SpawnRouting, target: HerdrTarget): Record<string, string>
  /** Resolve attachment metadata before spawn (display fields). */
  preloadAttachmentMeta(request: AgentSpawnRequest): Promise<void>
  /** Task main loop (deliver-approve-handoff; held by the executor). */
  runManagedTask(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown>
}

export class ResumeCoordinator {
  constructor(private readonly port: ResumePort) {}

  /**
   * Real resume dual entries (identify via our own records first, independent of request.agentType):
   * - standalone subagent: resume = onResolved.executionId (paneId), usually no
   *   request.agentId;
   * - workflow resumeAgent: resume = the agentId recorded for this run, no agentType.
   * Validation: only the same workflow (undefined tracks must agree too) and the same parent conversation; busy/
   * settled/unknown/ambiguous are rejected; explicit kind/nodeId/cwd mismatches are explicitly rejected (never silently ignored);
   * before any prompt is sent, assertResumeAgentConfirmed authoritatively confirms the underlying Agent
   * (only idle/done may resume; a timeout-kept pane's working/blocked and startup-undetermined
   *   states are always explicitly rejected -- no new pane, no keystroke abort).
   * Returning undefined means the ref is not recorded by this plugin (hand back to the kernel's native resume).
   */
  async resumeInto(request: AgentSpawnRequest, candidates: ManagedPane[]): Promise<unknown> {
    const resumeRef = request.resume!
    if (candidates.length > 1) {
      throw new HelmError(
        'resume_ambiguous',
        `resume ref '${resumeRef}' matched ${candidates.length} panes (paneId collision across machines); disambiguate with a stable agentId`,
        409,
        { resumeRef, panes: candidates.map((p) => `${nodeIdOf(p) ?? 'local'}:${p.paneId}`) },
      )
    }
    const pane = candidates[0]!
    if (pane.parentConversationId !== request.parentConversationId) {
      throw new HelmError(
        'cross_parent_resume_rejected',
        `resume ref '${resumeRef}' belongs to parent conversation ${pane.parentConversationId}; the current parent conversation ${request.parentConversationId} is not allowed to resume it`,
        409,
        { resumeRef, ownerParent: pane.parentConversationId, requesterParent: request.parentConversationId },
      )
    }
    // Workflow track consistency: both sides must be the same workflow (or both undefined).
    const paneWf = pane.workflowRunId
    const reqWf = parseWorkflowSpawnMeta(request.meta).runId
    if (paneWf !== reqWf) {
      throw new HelmError(
        'resume_workflow_mismatch',
        `resume ref '${resumeRef}' belongs to workflow ${String(paneWf)}; the calling track is ${String(reqWf)}; cross-track resume rejected`,
        409,
        { resumeRef, paneWorkflowRunId: paneWf, requestWorkflowRunId: reqWf },
      )
    }
    if (pane.outcome === 'running') {
      throw new HelmError(
        'pane_busy',
        `pane ${pane.paneId} is occupied by another execution (outcome=running); concurrent resume rejected`,
        409,
        { paneId: pane.paneId },
      )
    }
    if (pane.outcome === 'settled') {
      throw new HelmError(
        'pane_settled',
        `pane ${pane.paneId} is already settled and closed (outcome=settled); no PTY to resume`,
        409,
        { paneId: pane.paneId },
      )
    }
    // Routing: without agentType, keep the registered routing; an explicit one with a mismatched kind is explicitly rejected.
    assertNoUnsupportedOverrides(request.model, request.effort)
    const resumeRouting = await this.resolveResumeRouting(request, pane)
    // resume attachment gate: same semantics as new spawns (remote panes without a reachable HELM_HUB_URL are rejected).
    this.port.assertAttachmentsReachable(request, targetOf(pane), resumeRouting)
    if (request.cwd !== undefined && request.cwd !== pane.effectiveCwd) {
      throw new HelmError(
        'resume_cwd_conflict',
        `resume explicit cwd '${request.cwd}' does not match the pane's actual working directory '${pane.effectiveCwd}'; a resume must keep the original worktree cwd`,
        409,
        { resumeRef, requestCwd: request.cwd, effectiveCwd: pane.effectiveCwd },
      )
    }
    // Authoritative resume gate: before any prompt is sent, agent.get confirms the underlying Agent is safe to resume
    // (a TimeoutError-kept pane's underlying CLI may still be working/blocked; a startup-phase timeout leaves
    // agent.start completion undetermined -- both confirm safely first, never deliver blindly).
    await this.assertResumeAgentConfirmed(request, pane)

    const unique = `${Date.now()}-resume-${HashShort.of(request.prompt.slice(0, 160))}-${request.parentConversationId}-${Math.random().toString(36).slice(2, 6)}`
    const safeId = `r${HashShort.of(unique)}`
    const ext = request.schema !== undefined ? 'json' : 'md'
    if (this.port.registry.get(nodeIdOf(pane), pane.paneId)?.outcome === 'running') {
      throw new HelmError('pane_busy', `pane ${pane.paneId} is already occupied by another resume`, 409)
    }
    const spawnRunId = parseWorkflowSpawnMeta(request.meta).runId
    const updated = this.port.registry.update(nodeIdOf(pane), pane.paneId, {
      outcome: 'running',
      outputFileName: buildOutputFileName(safeId, ext),
      agentId: request.agentId ?? pane.agentId,
      ...(spawnRunId !== undefined ? { workflowRunId: spawnRunId } : {}),
    })!
    await this.port.registry.flushDisk()
    request.onResolved?.(this.port.executionInfoOf(updated))
    // A missing request.cwd means keeping the pane's actual cwd (no window reopen, no env tab rebuild).
    // Resume does not re-run agent.start (the pane already has an agent); go straight into the deliver-approve-handoff loop.
    // Missing env (after a failure pane cleanup): rebuild the baseline from current routing and the pane's actual cwd (no secrets;
    // the resume's Gate re-authorizes per the resume request's own secretNames, not the ones granted at pane creation).
    if (!this.port.hasPaneEnv(paneStateKey(updated))) {
      this.port.setPaneEnv(
        paneStateKey(updated),
        this.port.buildPaneBaselineEnv(request.parentConversationId, updated.effectiveCwd, resumeRouting, targetOf(updated)),
      )
    }
    await this.port.preloadAttachmentMeta(request)
    return this.port.runManagedTask(request, updated)
  }

  /**
   * resume authoritative readiness gate (runs before any prompt is sent; safety boundary):
   * - A TimeoutError-kept pane's underlying CLI may still be working/blocked -- there is no
   *   safe stop/CAS means, so a kept pane must not be dressed up as unconditionally resumable;
   * - A startup-phase timeout (agent.start completion uncertain) also goes through this gate to explicitly reject
   *   or safely confirm: pass only when both identity and state are authoritatively confirmed; never blindly re-send agent.start;
   * - Pass condition: identity (pane/tab/name) exactly matches the managed registration and the state is idle/done;
   *   working/blocked/unknown/launch_pending, failure to confirm authoritatively (agent.get fails)
   *   or identity mismatch are all explicitly rejected -- no new Agent, no keystroke abort on anyone's behalf;
   *   let a human confirm in the Herdr terminal before resuming.
   */
  private async assertResumeAgentConfirmed(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const resumeRef = request.resume!
    let authority: HerdrAgentInfo
    try {
      authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    } catch (error) {
      if (request.signal?.aborted) throw error
      throw new HelmError(
        'resume_agent_unconfirmed',
        `pane ${pane.paneId}: cannot authoritatively confirm the underlying Agent state (${error instanceof Error ? this.port.redact(error.message) : String(error)}); typically after a startup-phase timeout leaves agent.start completion uncertain, or the pane no longer has a managed Agent. Refusing blind resume: no new Agent, no agent.start re-send, no keystrokes on your behalf; confirm this pane manually in the Herdr terminal before resuming`,
        409,
        { resumeRef, paneId: pane.paneId, cause: (error as { code?: string }).code ?? 'agent_get_failed' },
      )
    }
    if (authority.paneId !== pane.paneId || authority.tabId !== pane.tabId || authority.name !== pane.agentName) {
      throw new HelmError(
        'herdr_ownership_lost',
        `pane ${pane.paneId}'s authoritative identity does not match the managed registration (name=${String(authority.name)} tab=${authority.tabId}); cannot confirm the managed Agent is still in this pane (it may never have started or was replaced); resume rejected`,
        409,
        { resumeRef, paneId: pane.paneId, authorityName: authority.name, authorityTabId: authority.tabId },
      )
    }
    if (authority.launchPending === true) {
      throw new HelmError(
        'resume_agent_busy',
        `pane ${pane.paneId} is still starting (launch_pending); the underlying CLI state is undetermined; resume rejected`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
    if (authority.agentStatus === 'working') {
      throw new HelmError(
        'resume_agent_busy',
        `pane ${pane.paneId}'s underlying CLI is still executing (working; typical for timeout-kept panes); resume rejected: no new pane, no keystroke abort; wait for it to finish (idle/done) in the Herdr terminal before resuming`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
    if (authority.agentStatus === 'blocked') {
      throw new HelmError(
        'resume_agent_blocked',
        `pane ${pane.paneId}'s underlying CLI is blocked awaiting approval keystrokes; a resume never sends keys on a human's behalf; resolve the block directly in the Herdr terminal before resuming`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus, stateChangeSeq: authority.stateChangeSeq },
      )
    }
    if (authority.agentStatus !== 'idle' && authority.agentStatus !== 'done') {
      throw new HelmError(
        'resume_agent_unconfirmed',
        `pane ${pane.paneId}'s authoritative state is ${authority.agentStatus}; a safe resume cannot be confirmed (only idle/done may resume)`,
        409,
        { resumeRef, paneId: pane.paneId, agentStatus: authority.agentStatus },
      )
    }
  }

  /**
   * resume routing resolution: an explicit agentType validates kind consistency; the default keeps pane.routing.
   * Node semantics: resume keeps the old pane's registered node (the default and explicit values merely validate, no recompute --
   * an explicit nodeId different from the old node is rejected with resume_node_conflict, never silently
   * delivering the continuation to another machine; nor re-resolving against the current parent conversation's node).
   */
  private async resolveResumeRouting(request: AgentSpawnRequest, pane: ManagedPane): Promise<SpawnRouting> {
    if (request.agentType === undefined || request.agentType === '') {
      const routing = pane.routing
      return {
        kind: routing.kind,
        ...(pane.routing.profileId !== undefined ? { profileId: pane.routing.profileId } : {}),
        args: [],
        profileEnv: {},
        nodeId: nodeIdOf(pane) ?? 'local',
      }
    }
    const routing = await resolveSpawnRouting(request.agentType, this.port.profiles)
    if (routing === undefined) {
      throw new HelmError(
        'resume_agent_type_rejected',
        `resume explicit agentType '${request.agentType}' is not a Herdr runtime; mismatched with the existing herdr pane`,
        409,
        { resume: request.resume, agentType: request.agentType },
      )
    }
    if (routing.kind !== pane.routing.kind || routing.profileId !== pane.routing.profileId) {
      throw new HelmError(
        'resume_kind_conflict',
        `resume explicit agentType kind '${routing.kind}' does not match the pane's agent kind '${pane.routing.kind}'; silent re-typing rejected`,
        409,
        { resume: request.resume, requestKind: routing.kind, paneKind: pane.routing.kind },
      )
    }
    const requestNodeId = routing.nodeId !== undefined ? targetNodeId({ nodeId: routing.nodeId }) ?? 'local' : undefined
    const paneNodeId = nodeIdOf(pane) ?? 'local'
    if (requestNodeId !== undefined && requestNodeId !== paneNodeId) {
      throw new HelmError(
        'resume_node_conflict',
        `resume explicit node '${requestNodeId}' does not match the pane's target node '${paneNodeId}'; cross-node resume rejected`,
        409,
        { resume: request.resume, requestNodeId, paneNodeId },
      )
    }
    // Keep the pane's frozen target (the explicit node is only consistency-checked; no hot connection swap).
    return { ...routing, nodeId: paneNodeId }
  }
}
