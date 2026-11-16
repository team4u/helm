/**
 * service.ts -- WorkflowService: the workflow engine's single facade to the kernel/HTTP layer.
 *
 * Internal responsibilities split by module (all in the same directory): library-store (the saved-workflow
 * file library), run-store (the run record/index persistence layer) and run-summary (summary
 * derivation/redaction/progress folding), cancellation-tracker (cancellation windows and
 * subtree-boundary cancellation), host-adapter + host-action-adapter (the engine's WorkflowHost <->
 * WorkflowServiceHost adaptation), active-run (in-flight runtime state and throttling constants),
 * service-context (the runner-shared context, caps and option assembly), service-run / run-settle /
 * run-progress (the run() launch body, terminal settlement, progress event policy),
 * background-agent-runner (startBackgroundAgent), service-recovery (startup recovery and auto-resume candidates).
 *
 * This file keeps only the facade: construction and assembly, delegation to the runners, the query
 * faces (getRun/listRuns/wait/abort/close), the host adaptation seam and state-store reads/writes.
 * Persistence formats, error codes and behavior contracts are unchanged. The engine proper
 * (runtime.ts) has zero kernel dependencies; this file is the only adaptation layer importing kernel types.
 */

import {
  HelmError,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type ConversationSummary,
} from '@helm/protocol'
import type {
  SavedWorkflowDetail,
  SavedWorkflowSummary,
  WorkflowDeleteResult,
  WorkflowRunRequest,
  WorkflowRunSummary,
  WorkflowSaveRequest,
  WorkflowSaveResult,
} from '../../contracts.js'
import type {
  WorkflowHost,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from './runtime.js'
import type { ActiveRun } from './active-run.js'
import { CancellationTracker } from './cancellation-tracker.js'
import {
  abortChildConversation as abortChildViaHost,
  createEngineHost,
  invokeAgentSpawn,
  type EngineHostDeps,
  type WorkflowServiceHost,
} from './host-adapter.js'
import { WorkflowLibrary } from './library-store.js'
import {
  RunStore,
  errorMessage,
  type RunRecord,
  type WorkflowStateStore,
} from './run-store.js'
import { nodesFromProgress, redactSummaryNodes, toSummary } from './run-summary.js'
import {
  resolveCaps,
  type WorkflowCaps,
  type WorkflowServiceContext,
  type WorkflowServiceOptions,
} from './service-context.js'
import { isAutoRecoverEnvDisabled } from '../config.js'
import { StartupRecovery } from './service-recovery.js'
import { startWorkflowRun } from './service-run.js'
import { startBackgroundAgent as launchBackgroundAgent } from './background-agent-runner.js'
import { detachForegroundRun as detachRun, waitForegroundRun } from './run-detach.js'

export {
  BUILTIN_ENV_EXEC_PLUGIN,
  BUILTIN_ENV_EXEC_ACTION,
  type ValidatedEnvExecInput,
  type WorkflowServiceHost,
} from './host-adapter.js'
export type { WorkflowStateStore } from './run-store.js'
export type { WorkflowAutoResumeCandidate } from './service-recovery.js'
export type { WorkflowServiceOptions } from './service-context.js'

export class WorkflowService {
  private readonly host: WorkflowServiceHost
  private readonly state: WorkflowStateStore
  private readonly caps: WorkflowCaps
  private readonly redact: (text: string) => string
  private readonly runs: RunStore
  private readonly library: WorkflowLibrary
  private readonly cancellation: CancellationTracker
  private readonly active = new Map<string, ActiveRun>()
  /** In-process takeover reservations (against concurrent double takeovers; full semantics in service-run's resume-takeover section). */
  private readonly takeoverReservations = new Set<string>()
  private readonly ctx: WorkflowServiceContext
  private readonly recovery: StartupRecovery
  private readonly autoRecoverOption: boolean | (() => boolean) | undefined
  private readonly deferExternalReattach: boolean
  private readonly externalRuntimeReadyGate: Promise<void>
  private resolveExternalRuntimeReady: () => void = () => {}
  private closed = false

  constructor(options: WorkflowServiceOptions) {
    this.host = options.host
    this.state = options.state
    this.caps = resolveCaps(options)
    this.redact = options.redact ?? ((text: string) => text)
    this.autoRecoverOption = options.autoRecoverOnRestart
    this.deferExternalReattach = options.deferExternalReattach === true
    if (this.deferExternalReattach) {
      this.externalRuntimeReadyGate = new Promise<void>((resolve) => {
        this.resolveExternalRuntimeReady = resolve
      })
    } else {
      this.externalRuntimeReadyGate = Promise.resolve()
    }
    this.runs = new RunStore({ dataDir: options.dataDir, state: options.state })
    this.library = new WorkflowLibrary({
      dataDir: options.dataDir,
      loadRunRecord: (runId) => this.runs.load(runId),
    })
    this.cancellation = new CancellationTracker({
      active: this.active,
      parentConversationOf: (id) => this.host.getConversation(id).parentConversationId,
    })
    this.ctx = {
      host: this.host,
      state: this.state,
      runs: this.runs,
      library: this.library,
      cancellation: this.cancellation,
      active: this.active,
      takeoverReservations: this.takeoverReservations,
      redact: this.redact,
      caps: this.caps,
      isClosed: () => this.closed,
      assertNotClosed: () => this.assertNotClosed(),
      init: () => this.init(),
      writeRecord: (record) => this.writeRecord(record),
      emitEventSafe: (type, payload) => this.emitEventSafe(type, payload),
      makeEngineHost: (run, parent) => this.makeEngineHost(run, parent),
      abortChildConversation: (run, conversationId) => this.abortChildConversation(run, conversationId),
      isAutoRecoverOnRestart: () => this.isAutoRecoverOnRestart(),
      isRunSuspending: (run) =>
        run.suspended === true ||
        (this.isAutoRecoverOnRestart() && this.host.isHostClosing?.() === true && run.userAborted !== true),
      deferExternalReattach: this.deferExternalReattach,
      waitExternalRuntimeReady: () => this.externalRuntimeReadyGate,
    }
    this.recovery = new StartupRecovery(this.ctx)
  }

  /** Whether automatic recovery on restart is enabled (config option and HELM_AUTO_RECOVER=0/false escape hatch). */
  isAutoRecoverOnRestart(): boolean {
    if (this.autoRecoverOption === false) return false
    if (typeof this.autoRecoverOption === 'function' && !this.autoRecoverOption()) return false
    return !isAutoRecoverEnvDisabled()
  }

  /** Whether the host kernel is currently in its shutdown window. */
  isHostClosing(): boolean {
    return this.host.isHostClosing?.() === true
  }

  /** Release deferred external-runtime (executionId) and pre-resolve reattaches during runtime.started. */
  startDeferredReattaches(): void {
    this.resolveExternalRuntimeReady()
  }

  /** Startup recovery (phase-one barrier; implemented in service-recovery). Idempotent; auto-runs before the first run() call. */
  async prepareRecovery(): Promise<void> {
    return this.recovery.prepareRecovery()
  }

  /** Startup recovery (phase two: interrupted markers and notification-outbox re-delivery; implemented in service-recovery). */
  async init(): Promise<void> {
    return this.recovery.init()
  }

  /** Post-startup convergence (runtime.started phase: wait for leftover sub-conversations to settle to idle; idempotent). */
  async awaitPreparedChildrenSettled(): Promise<void> {
    return this.recovery.awaitPreparedChildrenSettled()
  }

  // Workflow library: list / get / save / delete (implemented in library-store)

  /** List workflow scripts with meta declarations; invalid meta attaches metadataError; file read errors fail explicitly. */
  list(): SavedWorkflowSummary[] {
    return this.library.list()
  }

  /** Read a saved workflow's full definition (read-only source + metadata + real file facts). */
  get(name: string): SavedWorkflowDetail {
    return this.library.get(name)
  }

  /** Save a workflow definition (exactly one of script / fromRunId; boundary validation and atomic writes in library-store.save). */
  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    return this.library.save(request)
  }

  /** Delete a saved workflow definition file (historical run records unaffected; explicit 404 when absent). */
  delete(name: string): WorkflowDeleteResult {
    return this.library.delete(name)
  }

  // run (implemented in service-run / run-settle / run-progress)

  /**
   * Start a workflow run: executes in the background, returns the summary immediately (no waiting).
   * context.foreground=true marks a foreground synchronous run (record.syncForeground, detachable
   * to the background).
   * @throws HelmError validation_error / not_found / workflow_action_uncertain / journal_read_failed。
   */
  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean; foreground?: boolean },
  ): Promise<WorkflowRunSummary> {
    return startWorkflowRun(this.ctx, request, context)
  }

  // startBackgroundAgent: a trusted background single-subagent (implemented in background-agent-runner)

  /**
   * Start a background single-subagent: reuses the run record / persistence / abort / wait / getRun /
   * onRunSettled / restart recovery, but bypasses the DSL engine (timing discipline in background-agent-runner).
   * options.foreground=true is the foreground synchronous mode (the synchronous subagent tool): the record
   * marks syncForeground, notifyParentOnSettle defaults to false, and the parent signal binds until detach/terminal.
   */
  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
      foreground?: boolean
    },
  ): Promise<{
    run: WorkflowRunSummary
    execution?: AgentExecutionInfo
  }> {
    return launchBackgroundAgent(this.ctx, request, options)
  }

  // Detach of foreground synchronous runs (implemented in run-detach)

  /**
   * Foreground synchronous wait (used inside the synchronous tool's execute): resolves as 'detached' (the
   * detach action moved it to the background, and the tool immediately returns a background handle) or
   * 'settled' (the run's terminal state; settleError throws with wait()'s semantics).
   * hooks.onDetached runs synchronously inside the detach critical section (the tool side unbinds the parent
   * signal listener; after detaching, the parent turn's signal no longer kills the run).
   */
  async waitForeground(
    runId: string,
    hooks?: { onDetached?: () => void },
  ): Promise<'detached' | 'settled'> {
    return waitForegroundRun(this.ctx, runId, hooks)
  }

  /**
   * Atomically move a running foreground synchronous run to the background (the detach action entry;
   * the synchronous critical section lives in run-detach): set detachedAt/notifyParentOnSettle, persist,
   * unbind the parent signal (engine binding + waiter onDetached) and wake the waiters, then await the
   * state-store flush (failures throw detach_flush_failed honestly, without rolling back the persisted record).
   * Explicitly rejected when the state/foreground markers don't qualify.
   */
  async detachForegroundRun(runId: string): Promise<WorkflowRunSummary> {
    this.assertNotClosed()
    return detachRun(this.ctx, runId)
  }

  // getRun / wait / abort

  /** Memory first, falling back to the state store (cross-restart inspect). */
  getRun(runId: string): WorkflowRunSummary {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      // Background single-subagents skip the engine progress: use record.nodes directly (maintained live).
      const collapsed =
        activeRun.progress.length > 0 ? nodesFromProgress(activeRun.progress) : activeRun.summary.nodes
      return redactSummaryNodes(this.redact, {
        ...activeRun.summary,
        ...(collapsed !== undefined ? { nodes: collapsed } : {}),
        ...(activeRun.timeline.length > 0 ? { progress: [...activeRun.timeline] } : {}),
      })
    }
    return toSummary(this.runs.load(runId))
  }

  /**
   * Summaries of all persisted runs (newest first): active runs fold nodes live;
  // terminal runs read the store; runs of unsaved scripts are listed too (history stays inspectable).
   *
   * Index corruption (missing records, ID mismatches, invalid shapes) or store throws are persistence-layer
   * service faults, not "a normal list missing a few" -- swallowing them silently would make
   * HTTP/CLI/snapshot return seemingly successful truncated data. Throw workflow_index_corrupt
   * (500) here with runId diagnostics; the 404 semantics of a single missing run stay with getRun.
   * The snapshot provider takes the same path, so faults are not re-swallowed by snapshot (a throw
   */
  listRuns(): WorkflowRunSummary[] {
    // Index reading stays uniform with all other entry points (readRunIndex): store throws/shape
    // corruption explicitly workflow_index_corrupt (with key and an identifiable runId); never coerce
    // then TypeError on entry.id or treat it as a valid list.
    const index = this.runs.readIndex()
    const out: WorkflowRunSummary[] = []
    const seen = new Set<string>()
    for (const active of this.active.values()) {
      seen.add(active.runId)
      const collapsed =
        active.progress.length > 0 ? nodesFromProgress(active.progress) : active.summary.nodes
      out.push(
        redactSummaryNodes(this.redact, {
          ...active.summary,
          ...(collapsed !== undefined ? { nodes: collapsed } : {}),
          ...(active.timeline.length > 0 ? { progress: [...active.timeline] } : {}),
        }),
      )
    }
    for (const entry of [...index].sort((a, b) => b.createdAt - a.createdAt)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      // loadRecord throws 404 for not_found (plain absence): in the list context this is a service
      // fault of the index pointing at a missing record, re-reported as workflow_index_corrupt; likewise ID mismatches.
      try {
        out.push(toSummary(this.runs.load(entry.id)))
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') {
          throw this.runs.indexCorruptError(entry.id, `record missing or ID mismatch: ${error.message}`)
        }
        if (error instanceof HelmError && error.code === 'workflow_record_corrupt') throw error
        throw this.runs.indexCorruptError(entry.id, `record corrupted: ${errorMessage(error)}`)
      }
    }
    // The newest-first contract is global: active.values() is insertion order (old first); an older active
    // run must not precede a newer terminal history item -- after merge-dedup, sort uniformly by createdAt descending.
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  /** 按 (conversationId, parentToolCallId) 精确查找既有 Run（同步工具跨重启幂等重放用）。 */
  findRunByParentToolCall(conversationId: number, parentToolCallId: string): RunRecord | undefined {
    if (parentToolCallId === '') return undefined
    for (const active of this.active.values()) {
      if (active.conversationId === conversationId && active.record.parentToolCallId === parentToolCallId) {
        return active.record
      }
    }
    const index = this.runs
      .readIndex()
      .filter((entry) => entry.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt)
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.runs.load(entry.id)
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') continue
        throw error
      }
      if (record.parentToolCallId === parentToolCallId) return record
    }
    return undefined
  }

  /** 查询完整持久 RunRecord（actions / CLI / 批量恢复读取规格与恢复元数据用）。 */
  loadRunRecord(runId: string): RunRecord {
    const active = this.active.get(runId)
    if (active !== undefined) return active.record
    return this.runs.load(runId)
  }

  /** 判断接管标记是否仍对应有效接管运行（非幽灵）。 */
  isTakeoverActive(markerRunId: string, conversationId: number): boolean {
    return !this.runs.inspectTakeoverMarker(markerRunId, conversationId, {
      reserved: this.takeoverReservations.has(markerRunId),
      active: this.active.has(markerRunId),
    }).ghost
  }

  /**
   * Return background workflows eligible for automatic resume (implemented in service-recovery).
   */
  listAutoResumeCandidates(maxAttempts = 3) {
    return this.recovery.listAutoResumeCandidates(maxAttempts)
  }

  /** Wait for a run to finish and return its result (historical runs return result directly). */
  async wait(runId: string): Promise<unknown> {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      // done never rejects; terminal-state flush failures throw as-is via settleError, never faking success.
      await activeRun.done
      if (activeRun.settleError !== undefined) throw activeRun.settleError
    }
    return this.getRun(runId).result
  }

  /**
   * Abort a run (cascading): the run itself + all descendant runs inside its sub-conversation subtree and
   * synchronous sub-conversations are cancelled together; sibling tasks of the parent conversation are
   * unaffected. New runs/spawns of that subtree are refused inside the cancellation window (preventing new
   * tasks spawned mid-cancellation); on return, every involved run has settled with no unhandled rejections.
   */
  async abort(runId: string): Promise<void> {
    const activeRun = this.active.get(runId)
    if (activeRun === undefined) {
      // Historical runs are idempotent: only nonexistent ones error.
      this.getRun(runId)
      return
    }
    const seeds = [...activeRun.childConversations]
    await this.cancellation.cancelBoundary(`run:${runId}`, seeds, (run, isWithin) => {
      if (run === activeRun) return true
      // Descendant ownership: the run's initiating conversation falls inside any sub-conversation subtree (along real conversation parent chains).
      for (const seed of seeds) {
        if (isWithin(run.conversationId, seed)) return true
      }
      return false
    })
    if (activeRun.settleError !== undefined) throw activeRun.settleError
  }

  /** Whether a conversation is inside a cascade-cancellation window (the plugin layer uses this to skip settle-report delivery to cancelled parent conversations). */
  isConversationCancelling(conversationId: number): boolean {
    return this.cancellation.isCancelling(conversationId)
  }

  /**
   * Cancel all in-flight runs of a conversation subtree (incl. self-initiated): called by the plugin layer
   * after the parent conversation is aborted (turn aborted). Idempotent: concurrent calls with the same
   * root share one cancellation; returns after every run settles.
   */
  async cancelRunsUnderConversation(conversationId: number): Promise<void> {
    if (this.host.isHostClosing?.() === true && this.isAutoRecoverOnRestart()) return
    await this.cancellation.cancelBoundary(`conv:${conversationId}`, [conversationId], (run, isWithin) =>
      isWithin(run.conversationId, conversationId),
    )
  }

  /**
   * Guarded-abort a run's sub-conversations: via the host's guarded entry (the human red line is atomically
   * re-checked by the kernel; rejection/failure diagnostics keep stderr), never falling back to plain aborts;
   * counted into pendingAborts until done (settle waits for completion -- late calls after settlement are
   * diagnostics only, likewise not blocking the terminal state).
   */
  private abortChildConversation(run: ActiveRun, conversationId: number): Promise<void> {
    return abortChildViaHost(this.host, run, conversationId)
  }

  /**
   * 宿主优雅关停挂起（仅 ctx.host.isClosing === true && autoRecoverOnRestart）：
   * 停用 Worker 与本地等待句柄，严禁调用 abortConversationGuarded，落盘
   * status='running' + suspendedCleanly=true 并 flush。
   */
  async suspend(): Promise<void> {
    this.closed = true
    const inFlight = [...this.active.values()]
    for (const run of inFlight) {
      run.suspended = true
      run.abort.abort()
    }
    await Promise.all(inFlight.map((run) => run.done))
    await this.state.flush?.()
  }

  /** 关停全部在途 run（插件停用 / close 降级用）：标记 userAborted 强制走 aborted 收尾。 */
  async close(): Promise<void> {
    this.closed = true
    const inFlight = [...this.active.values()]
    for (const run of inFlight) {
      run.userAborted = true
      run.abort.abort()
    }
    await Promise.all(inFlight.map((run) => run.done))
    await this.state.flush?.()
  }

  // host adaptation: engine WorkflowHost <-> WorkflowServiceHost (implemented in host-adapter)

  private engineHostDeps(): EngineHostDeps {
    return {
      host: this.host,
      redact: this.redact,
      isClosed: () => this.closed,
      isCancelling: (conversationId) => this.cancellation.isCancelling(conversationId),
      persistChildConversationFact: (activeRun, conversationId) =>
        this.persistChildConversationFact(activeRun, conversationId),
      loadWorkflowRef: (ref) => this.loadWorkflowRef(ref),
      waitExternalRuntimeReady: () => this.externalRuntimeReadyGate,
      isSuspending: (activeRun) => this.ctx.isRunSuspending(activeRun),
    }
  }

  private makeEngineHost(run: ActiveRun, parent: ConversationSummary): WorkflowHost {
    return createEngineHost(this.engineHostDeps(), run, parent)
  }

  /**
   * A single agent/resume call (implemented in host-adapter; the private seam is kept so engine-adapter
   * construction and direct tests share the same entry). Signature identical to the historical version.
   */
  private async invokeSpawn(
    run: ActiveRun,
    parent: ConversationSummary,
    conversationByAgent: Map<string, number>,
    request: WorkflowSpawnRequest,
    isResume: boolean,
  ): Promise<WorkflowSpawnResult> {
    return invokeAgentSpawn(this.engineHostDeps(), run, parent, conversationByAgent, request, isResume)
  }

  /** Nested workflow() reference resolution: only safe names in the saved directory or explicit local paths. */
  private loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string } {
    try {
      if (ref.name !== undefined) {
        const path = this.library.resolveSavedName(ref.name)
        return { ok: true, script: this.library.readScriptFile(path), path }
      }
      if (ref.scriptPath !== undefined) {
        const path = this.library.resolveExplicitPath(ref.scriptPath)
        return { ok: true, script: this.library.readScriptFile(path), path }
      }
      return { ok: false, message: 'workflow() reference requires name or scriptPath' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // state-store reads/writes (single store; persistence implemented in run-store)

  /**
   * Write a run record: for active runs, the in-memory Set of in-flight sub-conversations is the single
   * source of truth; every write (immediate at onResolved / throttled progress / terminal) merges
   * childConversationIds uniformly from active, preventing stale record copies from overwriting registered
   * sub-conversation facts; then the run store atomically flushes the file and updates the index (order
   * discipline in RunStore.write).
   */
  private writeRecord(record: RunRecord): void {
    const active = this.active.get(record.id)
    if (active !== undefined && active.childConversations.size > 0) {
      record.childConversationIds = [...active.childConversations]
    }
    this.runs.write(record)
  }

  private assertNotClosed(): void {
    if (this.closed) throw new HelmError('closed', 'WorkflowService is closed', 409)
  }

  /**
   * Sub-conversation facts persisted immediately (the onResolved registration point): crash recovery
   * (prepareRecovery/init guarded aborts) relies on childConversationIds in running records -- persisting
   * them only at a late terminal state would leave sub-conversations unmanaged after restart. Write failures
   * must be explicitly diagnosed (stderr): silently swallowing them would make the next recovery pretend to
   * be complete; the in-memory record already registers them, and later progress/terminal writes retry
   */
  private persistChildConversationFact(run: ActiveRun, conversationId: number): void {
    try {
      this.writeRecord(run.record)
      const flushed = this.state.flush?.()
      if (flushed !== undefined) {
        void flushed.catch((error: unknown) => {
          process.stderr.write(
            `workflow ${run.runId}: child conversation ${conversationId} persist flush failed: ${errorMessage(error)}\n`,
          )
        })
      }
    } catch (error) {
      process.stderr.write(
        `workflow ${run.runId}: child conversation ${conversationId} persist failed: ${errorMessage(error)}\n`,
      )
    }
  }

  /**
   * fire-and-forget convergence of workflow.updated events: WorkflowServiceHost's emitEvent signature is
   * void, but the real adapter (plugin layer) is async -- projection/broadcast failures can only be
   * diagnosed, never escaping as unhandledRejection to take down the process (observation-plane failures
   * never shake the run lifecycle; persistent terminal states are owned by the state store).
   */
  private emitEventSafe(type: string, payload: unknown): void {
    const diagnose = (error: unknown): void => {
      process.stderr.write(
        `workflow: emitEvent ${type} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    try {
      void Promise.resolve(this.host.emitEvent(type, payload)).catch(diagnose)
    } catch (error) {
      diagnose(error)
    }
  }
}
