/**
 * builtin:herdr runtime bootstrap (loaded dynamically on enable / service prepare+start).
 *
 * Kept separate from herdr.ts so disabled registrations never parse/eval transport,
 * executor, asks, metadata, overview, probes, rpc, or spawn-rules modules.
 */

import {
  HelmError,
  type AgentSpawnRequest,
  type HelmPluginContext,
  type HookResult,
  type PluginDocHandle,
  type TurnSettledPayload,
} from '@helm/protocol'
import { type WorkflowRunSummary } from '../contracts.js'
import { AskCoordinator, type AskEntry } from './asks.js'
import {
  targetNodeId,
  type HerdrConfig,
  type HerdrEvent,
  type HerdrPluginDependencies,
  type HerdrTarget,
  type HerdrTransport,
} from './contracts.js'
import { isPaneLostError } from './executor-reattach.js'
import { HerdrExecutor } from './executor.js'
import { assembleHerdrDepsFromHost, nodeChannelFromHost } from './host-ports.js'
import { MetadataProjector } from './metadata.js'
import { OverviewProjector, type OverviewDoc } from './overview.js'
import { PaneRegistry, nodeIdOf, type ManagedDoc } from './panes.js'
import { HerdrProbeCollector } from './probes.js'
import { parseAgentResult, parseSessionSnapshot } from './rpc.js'
import { normalizeStartupTimeoutMs } from './spawn-rules.js'
import { createHerdrTransport, isValidSessionName, resolveSocketPath } from './transport.js'

type HerdrTimingOverrides = Pick<
  HerdrPluginDependencies,
  | 'pollIntervalMs'
  | 'blockedBackoffBaseMs'
  | 'blockedBackoffCapMs'
  | 'askPollTransientBackoffBaseMs'
  | 'askPollTransientBackoffCapMs'
  | 'abortCancelBackoffCapMs'
  | 'mdStableRecheckMs'
  | 'subscriptionRetryBaseMs'
  | 'subscriptionRetryCapMs'
  | 'steerWaitBudgetMs'
>

export interface HerdrRuntimeController {
  prepareLocalRuntime(): void
  start(): Promise<void>
  stop(fromStop?: boolean): Promise<void>
  liveTasks(): string[]
  onAgentSpawn(request: AgentSpawnRequest): Promise<HookResult<AgentSpawnRequest>>
  onTurnSettled(payload: TurnSettledPayload): Promise<void>
  collectDiagnostics(raw: unknown): Promise<void>
  getRegistry(): PaneRegistry | undefined
  getExecutor(): HerdrExecutor | undefined
  getTransport(): HerdrTransport
}

interface CreateHerdrRuntimeOptions {
  ctx: HelmPluginContext
  managedDoc: PluginDocHandle<ManagedDoc>
  overviewDoc: PluginDocHandle<OverviewDoc>
  timingOverrides?: HerdrTimingOverrides
}

export function createHerdrRuntime(options: CreateHerdrRuntimeOptions): HerdrRuntimeController {
  const { ctx, managedDoc, overviewDoc, timingOverrides } = options
  const hostApi = ctx.host

  // ---- State (rebuilt on every enable cycle) ----
  /** Cycle-internal dependencies and production transport (assembled at start; early callbacks that precede start trigger assembly). */
  const depsRef: { current?: HerdrPluginDependencies } = {}
  const transportRef: { current?: HerdrTransport } = {}
  function resolveDeps(): HerdrPluginDependencies {
    const nodeChannel = nodeChannelFromHost(hostApi)
    transportRef.current ??= createHerdrTransport({ redact: (text) => hostApi.redact(text), nodeChannel })
    depsRef.current = {
      ...assembleHerdrDepsFromHost(hostApi, { transport: transportRef.current }),
      ...timingOverrides,
    }
    return depsRef.current
  }
  const depsOf = (): HerdrPluginDependencies => depsRef.current ?? resolveDeps()
  const transportOf = (): HerdrTransport => {
    if (transportRef.current === undefined) depsOf()
    return transportRef.current!
  }
  const asks = new AskCoordinator(() => refreshOverview())
  const registryRef: { current?: PaneRegistry } = {}
  const projectorRef: { current?: MetadataProjector } = {}
  const executorRef: { current?: HerdrExecutor } = {}
  const unsubscribeRef: { current?: () => void } = {}
  const overviewRef: { current?: OverviewProjector } = {}
  /** In-flight event-callback tasks: stop must wait for them, preventing post-disable doc writes and callbacks from polluting the next cycle. */
  const eventTasks = new Set<Promise<void>>()
  let connectionAbort = new AbortController()
  let subscriptionTail: Promise<void> = Promise.resolve()
  let subscribedPaneKey: string | undefined
  /** Local connection target frozen for this enable cycle (shared by all local calls/events/cleanup). */
  let frozenLocalTarget: HerdrTarget = {}
  let asksRelease: (() => void) | undefined
  let workflowRelease: (() => void) | undefined
  let runtimeStartedRelease: (() => void) | undefined

  /** Cache of the pane seq from the last processed socket event (event dedup; agent.get is authoritative). */
  const eventSeqCache = new Map<string, number>()
  /** Probe collector (observation watermarks / failure counters self-managed; reset on disable, forget on settle). */
  const probes = new HerdrProbeCollector({
    asks,
    registry: () => registryRef.current,
    overview: () => overviewRef.current,
    executor: () => executorRef.current,
    transport: transportOf,
    localTarget: () => frozenLocalTarget,
    signal: () => connectionAbort.signal,
    settleUnmanaged: (pane) => {
      registryRef.current?.update(nodeIdOf(pane), pane.paneId, {
        outcome: 'settled',
        settledAt: Date.now(),
        outputFileName: undefined,
      })
      executorRef.current?.releasePaneState(pane)
      forgetPaneCaches(nodeIdOf(pane), pane.paneId)
    },
    cancelAskQuietly: cancelQuietly,
  })
  let collectDiagnosticsListener: ((payload: unknown) => Promise<void> | void) | undefined
  probes.register({
    onEvent(_type, listener) {
      collectDiagnosticsListener = listener
      return () => {
        collectDiagnosticsListener = undefined
      }
    },
  })

  /** While disabling: the doc handle is already invalid, overview refreshes are skipped silently (KISS: no write, no error). */
  let stopping = false

  const host = {
    parentCwdOf(id: number): string | undefined {
      // getConversation errors propagate as-is (nonexistent means explicit failure, never swallowed).
      return ctx.host.getConversation(id).cwd
    },
    parentNodeIdOf(id: number): string | undefined {
      // Node bound to the parent conversation (Conversation.nodeId; undefined = local). Errors propagate as above.
      return ctx.host.getConversation(id).nodeId
    },
    askConversationId(id: number): number {
      return id
    },
    notify(title: string, body: string, level: 'info' | 'error'): void {
      ctx.host.emitEvent('notification', { type: 'notification', level, title: depsOf().redact(title), body: depsOf().redact(body) })
    },
    createAsk(spec: Parameters<typeof ctx.host.createAsk>[0]) {
      return ctx.host.createAsk(spec)
    },
    cancelAsk(askId: string, reason: 'cancelled' | 'superseded') {
      return ctx.host.cancelAsk(askId, reason)
    },
  }

  function projector(): MetadataProjector {
    if (projectorRef.current === undefined) {
      projectorRef.current = new MetadataProjector(
        (target, method, params) => {
          const pane = registryRef.current?.get(targetNodeId(target), String(params['pane_id']))
          return transportOf().call(pane?.target ?? frozenLocalTarget, method, params, { timeoutMs: 5_000 })
        },
        (paneId, error) => {
          host.notify(
            'Herdr status projection failed',
            `pane ${paneId} report_metadata failed: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
            'error',
          )
        },
      )
    }
    return projectorRef.current
  }

  function refreshOverview(): void {
    if (stopping) return
    const overview = overviewRef.current
    const registry = registryRef.current
    if (overview && registry) overview.republish(registry, asks)
  }

  function trackPaneEvent(event: HerdrEvent): void {
    if (stopping) return
    const task = onPaneEvent(event).catch((error) => {
      if (stopping) return
      host.notify(
        'Herdr event handling failed',
        `${event.type} ${'workspaceId' in event ? event.workspaceId : event.paneId}: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
        'error',
      )
    })
    eventTasks.add(task)
    void task.then(() => eventTasks.delete(task), () => eventTasks.delete(task))
  }

  /**
   * Subscription loss self-healing reconnect: singleton timer + exponential backoff (capped at 60s), reset after a successful rebuild;
   * Cleaned up by stopResources. Dedup relies on synchronizeSubscription's own queued serialization
   * (repeated schedules keep only the latest expiry), so no concurrent reconnect storms stack up.
   */
  let subscriptionRetryTimer: NodeJS.Timeout | undefined
  let subscriptionRetryAttempt = 0

  function scheduleSubscriptionRetry(): void {
    if (stopping || connectionAbort.signal.aborted) return
    if (subscriptionRetryTimer !== undefined) return
    const attempt = subscriptionRetryAttempt++
    const deps = depsOf()
    const baseMs = deps.subscriptionRetryBaseMs ?? 1_000
    const capMs = deps.subscriptionRetryCapMs ?? 60_000
    const delayMs = Math.min(baseMs * 2 ** Math.min(attempt, 6), capMs)
    subscriptionRetryTimer = setTimeout(() => {
      subscriptionRetryTimer = undefined
      if (stopping || connectionAbort.signal.aborted) return
      void synchronizeSubscription(lastSubscribedPaneIds(), connectionAbort.signal)
        .then((rebuilt) => { if (rebuilt) subscriptionRetryAttempt = 0 })
        .catch(() => {
          // Rebuild failed: keep retrying after backoff (next onError or this round's fallback).
          scheduleSubscriptionRetry()
        })
    }, delayMs)
    subscriptionRetryTimer.unref?.()
  }

  function clearSubscriptionRetry(): void {
    if (subscriptionRetryTimer !== undefined) {
      clearTimeout(subscriptionRetryTimer)
      subscriptionRetryTimer = undefined
    }
    subscriptionRetryAttempt = 0
  }

  /** Pane set the current subscription should cover: authoritative source is the registry's in-managed unsettled panes (for rebuilds). */
  function lastSubscribedPaneIds(): string[] {
    const registry = registryRef.current
    if (!registry) return []
    return registry
      .all()
      .filter((pane) => pane.outcome !== 'settled' && nodeIdOf(pane) === undefined)
      .map((pane) => pane.paneId)
  }

  function synchronizeSubscription(paneIds: string[], signal: AbortSignal): Promise<boolean> {
    const ids = [...new Set(paneIds)].sort()
    const key = JSON.stringify(ids)
    const task = subscriptionTail.then(async () => {
      if (stopping || signal.aborted || connectionAbort.signal.aborted) return false
      if (subscribedPaneKey === key && unsubscribeRef.current) return false
      let retired = false
      let failure: { error: unknown } | undefined
      let rawRelease: (() => void) | undefined
      const release = () => {
        retired = true
        rawRelease?.()
        rawRelease = undefined
      }
      rawRelease = await transportOf().subscribe(
        frozenLocalTarget,
        trackPaneEvent,
        (error) => {
          if (stopping || retired) return
          failure = { error }
          if (unsubscribeRef.current === release) subscribedPaneKey = undefined
          overviewRef.current?.markSubscriptionFailed(error)
          host.notify('Herdr event subscription lost', error instanceof Error ? error.message : String(error), 'error')
          // Loss self-healing: schedule backoff reconnect even when watchdogEnabled=false (deduped singleton).
          scheduleSubscriptionRetry()
        },
        { paneIds: ids, signal: connectionAbort.signal },
      )
      if (stopping || signal.aborted || connectionAbort.signal.aborted) {
        release()
        return false
      }
      if (failure) {
        release()
        throw failure.error
      }
      // Confirm the new stream's ACK first, then release the old stream, to avoid missing status events while switching per-pane filters.
      const previous = unsubscribeRef.current
      unsubscribeRef.current = release
      subscribedPaneKey = key
      previous?.()
      overviewRef.current?.markSubscriptionReady()
      subscriptionRetryAttempt = 0
      return true
    })
    // Keep the queue going; the original task's error is diagnosed by the startup path or the overview refresh path.
    subscriptionTail = task.then(() => {}, () => {})
    // Startup/rebuild failure (subscribe throws, not the onError path) also schedules backoff reconnect.
    task.catch(() => scheduleSubscriptionRetry())
    return task
  }

  // ---- socket event path: full overview refetch; Ask coordination limited to this plugin's own panes ----
  async function onPaneEvent(event: HerdrEvent): Promise<void> {
    if (stopping) return
    const overview = overviewRef.current
    const registry = registryRef.current
    let refresh: Promise<void> | undefined
    if (overview && registry) {
      if (event.type === 'pane.closed' || event.type === 'pane.exited') overview.evictPane(event.paneId)
      refresh = overview.refresh(registry, asks, frozenLocalTarget)
    }
    try {
      if (event.type === 'pane.created' || event.type === 'pane.focused' || event.type === 'pane.moved' ||
          event.type === 'tab.closed' || event.type === 'workspace.closed') return
      if (!registry) return
      const pane = registry.get(undefined, event.paneId)
      if (pane === undefined || JSON.stringify(pane.target) !== JSON.stringify(frozenLocalTarget)) return
      if (event.type === 'pane.closed' || event.type === 'pane.exited') {
        for (const removed of asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
          await cancelQuietly(removed, 'superseded')
        }
        if (stopping) return
        projector().forget(pane.paneId, nodeIdOf(pane))
        // External settle path synchronously releases the executor-side secret env / not-started markers: afterwards
        // closePane early-exits idempotently due to settled; without aligning here, every in-flight pane closed
        // would retain a copy of HELM_TOKEN until the disable rebuild.
        executorRef.current?.releasePaneState(pane)
        if (pane.outcome !== 'failed' && pane.outcome !== 'settled') {
          registry.update(nodeIdOf(pane), pane.paneId, {
            outcome: 'settled',
            settledAt: Date.now(),
            outputFileName: undefined,
          })
        }
        forgetPaneCaches(nodeIdOf(pane), pane.paneId)
        refreshOverview()
        return
      }
      const info = parseAgentResult(
        await transportOf().call(frozenLocalTarget, 'agent.get', { target: pane.paneId }, {
          signal: connectionAbort.signal,
          timeoutMs: 5_000,
        }),
        'agent.get',
        'agent_info',
      )
      if (stopping || info.name !== pane.agentName || info.tabId !== pane.tabId) return
      for (const superseded of asks.observeAuthority({
        paneId: pane.paneId,
        nodeId: nodeIdOf(pane),
        seq: info.stateChangeSeq,
        status: info.agentStatus,
      })) {
        await cancelQuietly(superseded, 'superseded')
      }
      if (stopping) return
      const cacheKey = `local:${pane.paneId}`
      if ((eventSeqCache.get(cacheKey) ?? 0) >= info.stateChangeSeq) return
      eventSeqCache.set(cacheKey, info.stateChangeSeq)
      // Pre-register the blocked tombstone only while the execution loop is in flight (for its beginBlocked to reuse and dedupe):
      // registering after the loop passed that seq or after spawn ended creates a ghost
      // creating entry never consumed (overview pendingAsk false positive); never register for non-running panes.
      if (info.agentStatus === 'blocked' && pane.outcome === 'running') {
        asks.beginBlocked(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
      }
    } finally {
      await refresh
    }
  }

  async function cancelQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void> {
    try {
      await ctx.host.cancelAsk(entry.askId, reason)
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
      host.notify(
        'Herdr approval cancellation failed',
        `ask ${entry.askId} cancel failed: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
        'error',
      )
    }
  }

  // ---- Startup reconciliation: subscribe ack -> snapshot scan ----
  /** When a pane is settled out of the registry, synchronously reclaim its probe/event caches (prevent long-lived leaks). */
  function forgetPaneCaches(nodeId: string | undefined, paneId: string): void {
    eventSeqCache.delete(`${nodeId ?? 'local'}:${paneId}`)
    probes.forget(nodeId, paneId)
  }

  async function reconcile(): Promise<void> {
    const registry = registryRef.current!
    const workflowPluginActive = ctx.host
      .listPlugins()
      .some((plugin) => plugin.id === 'builtin:workflow' && plugin.enabled)
    const snapshots = new Map<string, ReturnType<typeof parseSessionSnapshot>>([
      [JSON.stringify(frozenLocalTarget), parseSessionSnapshot(await transportOf().call(frozenLocalTarget, 'session.snapshot', {}, { timeoutMs: 5_000 }))],
    ])
    for (const pane of registry.all()) {
      if (pane.outcome === 'settled' || pane.outcome === 'failed') continue
      if (executorRef.current?.isActiveTask(pane)) continue
      const key = JSON.stringify(pane.target)
      if (!snapshots.has(key)) snapshots.set(key, parseSessionSnapshot(await transportOf().call(pane.target, 'session.snapshot', {}, { timeoutMs: 5_000 })))
      const agent = snapshots.get(key)!.agents.find((a) => a.paneId === pane.paneId)
      if (agent === undefined) {
        if (pane.outcome === 'running' && pane.outputFileName !== undefined) {
          // Keep running pane record across restart so reattach can inspect .helm/<outputFileName> or report herdr_pane_lost honestly.
          continue
        }
        // Pane already gone: register settled (no resources to reclaim) + align the executor side.
        registry.update(nodeIdOf(pane), pane.paneId, {
          outcome: 'settled',
          settledAt: Date.now(),
          outputFileName: undefined,
        })
        executorRef.current?.releasePaneState(pane)
        forgetPaneCaches(nodeIdOf(pane), pane.paneId)
        continue
      }
      // Exact ownership verification: agent.name must equal the recorded agentName (no startsWith --
      // helm-wf-abc must not claim helm-wf-abcde). Mismatched identity gives up ownership; no wrong closes.
      if (agent.name !== pane.agentName) {
        registry.update(nodeIdOf(pane), pane.paneId, {
          outcome: 'settled',
          settledAt: Date.now(),
          outputFileName: undefined,
        })
        executorRef.current?.releasePaneState(pane)
        forgetPaneCaches(nodeIdOf(pane), pane.paneId)
        continue
      }
      // Genuinely still working/blocked/unknown: keep and report (never fake completion to auto-reclaim).
      if (agent.agentStatus === 'working' || agent.agentStatus === 'blocked' || agent.agentStatus === 'unknown') {
        host.notify(
          'Herdr startup reconciliation found in-flight panes',
          `pane ${pane.paneId} (${pane.agentName}) is still in ${agent.agentStatus}, kept pending ${pane.workflowRunId !== undefined ? 'workflow' : 'parent turn'} settle or manual handling`,
          'info',
        )
        continue
      }
      // Keep running panes carrying persisted outputFileName so reattach can collect the handoff file or run single self-heal.
      if (pane.outcome === 'running' && pane.outputFileName !== undefined) {
        continue
      }
      // Keep keepalive panes belonging to an active workflow until workflow.settled (or post-startup orphan cleanup).
      if (pane.outcome === 'keepalive' && pane.workflowRunId !== undefined && workflowPluginActive) {
        continue
      }
      // Already finished (idle/done) with no in-flight reattach/workflow ownership: orphan, reclaimable.
      if (pane.outcome === 'running' || pane.outcome === 'keepalive') {
        await executorRef.current!.closePane(pane, 'settled').catch((error) => {
          host.notify(
            'Herdr orphan reclaim failed',
            `pane ${pane.paneId} reconciliation reclaim failed: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
            'error',
          )
        })
      }
    }
  }

  /**
   * Post-startup orphan reconciliation (on runtime.started):
   * reclaim idle/vanished panes whose owning workflow already settled or does not exist.
   */
  async function reconcileWorkflowOrphansAfterStartup(): Promise<void> {
    if (stopping || connectionAbort.signal.aborted) return
    const registry = registryRef.current
    const executor = executorRef.current
    if (!registry || !executor) return
    const workflowPluginActive = ctx.host
      .listPlugins()
      .some((plugin) => plugin.id === 'builtin:workflow' && plugin.enabled)
    if (!workflowPluginActive) return
    for (const pane of registry.all()) {
      if (stopping || connectionAbort.signal.aborted) return
      if (pane.workflowRunId === undefined) continue
      if (pane.outcome === 'settled' || pane.outcome === 'failed') continue
      if (executor.isActiveTask(pane)) continue
      let runStatus: string | undefined
      try {
        const summary = (await ctx.host.invokeAction('builtin:workflow', 'inspect', {
          runId: pane.workflowRunId,
        })) as { status?: string } | undefined
        runStatus = summary?.status
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') {
          runStatus = 'not_found'
        } else {
          continue
        }
      }
      if (runStatus === 'running') continue
      if (pane.outcome === 'keepalive') {
        await executor.closePane(pane, 'workflow-settled').catch((error) => {
          host.notify(
            'Herdr workflow orphan cleanup failed',
            `pane ${pane.paneId} (workflow ${pane.workflowRunId}) cleanup failed: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
            'error',
          )
        })
        continue
      }
      try {
        const info = parseAgentResult(
          await transportOf().call(pane.target, 'agent.get', { target: pane.paneId }, {
            signal: connectionAbort.signal,
            timeoutMs: 5_000,
          }),
          'agent.get',
          'agent_info',
        )
        if (info.name !== pane.agentName || info.tabId !== pane.tabId) {
          registry.update(nodeIdOf(pane), pane.paneId, {
            outcome: 'settled',
            settledAt: Date.now(),
            outputFileName: undefined,
          })
          executor.releasePaneState(pane)
          forgetPaneCaches(nodeIdOf(pane), pane.paneId)
          continue
        }
        if (info.agentStatus === 'idle' || info.agentStatus === 'done') {
          await executor.closePane(pane, 'workflow-settled').catch((error) => {
            host.notify(
              'Herdr workflow orphan cleanup failed',
              `pane ${pane.paneId} (workflow ${pane.workflowRunId}) cleanup failed: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
              'error',
            )
          })
        }
      } catch (error) {
        if (isPaneLostError(error)) {
          registry.update(nodeIdOf(pane), pane.paneId, {
            outcome: 'settled',
            settledAt: Date.now(),
            outputFileName: undefined,
          })
          executor.releasePaneState(pane)
          forgetPaneCaches(nodeIdOf(pane), pane.paneId)
        }
      }
    }
    registry.prune()
  }

  // ---- Dual-track cleanup ----
  // Per-item isolation: one closePane throwing (already honestly notified inside) must not abort the rest of the batch
  // of keepalive pane cleanup (events are one-shot; missing one strands it forever); executorRef may be
  // undefined within the stopResources nulling window - skip instead of TypeError.
  async function settleWorkflow(run: WorkflowRunSummary): Promise<void> {
    const registry = registryRef.current
    const executor = executorRef.current
    if (!registry || !executor) return
    for (const pane of registry.findByWorkflow(run.id)) {
      if (pane.outcome === 'failed') continue
      try {
        await executor.closePane(pane, 'workflow-settled')
      } catch (error) {
        host.notify('Herdr workflow cleanup interrupted item', `pane ${pane.paneId} (workflow ${run.id}) cleanup failed, skipped: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`, 'error')
      }
    }
    registry.prune()
  }

  async function settleParentTurn(conversationId: number): Promise<void> {
    const registry = registryRef.current
    const executor = executorRef.current
    if (!registry || !executor) return
    for (const pane of registry.findByParent(conversationId)) {
      if (pane.workflowRunId !== undefined) continue // workflow track
      if (pane.outcome === 'failed') continue
      if (pane.outcome === 'running') continue // still in flight in the same turn (concurrent spawn)
      try {
        await executor.closePane(pane, 'turn-settled')
      } catch (error) {
        host.notify('Herdr turn cleanup interrupted item', `pane ${pane.paneId} (parent conversation ${conversationId}) cleanup failed, skipped: ${error instanceof Error ? depsOf().redact(error.message) : String(error)}`, 'error')
      }
    }
    registry.prune()
  }

  /** Resolve and freeze the local socket path on enable; explicit path takes precedence over inherited env and session. */
  function resolveLocalTarget(config: Partial<HerdrConfig>): HerdrTarget {
    const session = typeof config.session === 'string' && config.session !== '' ? config.session : undefined
    const socketPath = typeof config.socketPath === 'string' && config.socketPath !== '' ? config.socketPath : undefined
    if (session !== undefined && !isValidSessionName(session)) {
      throw new HelmError('validation_error', `Herdr session name '${session}' is invalid (must start alphanumeric, may contain - _, <= 64 chars)`, 400, {
        session,
      })
    }
    // Explicit socket first; inherited env and session paths are frozen at enable time.
    return { socketPath: resolveSocketPath({ ...(session !== undefined ? { session } : {}), ...(socketPath !== undefined ? { socketPath } : {}) }) }
  }

  /** Prepare phase (in-memory + persisted doc validation, no network): ensures executor is ready before workflow.start reattach. */
  function prepareLocalRuntime(): void {
    stopping = false
    connectionAbort = new AbortController()
    const config = ctx.getConfig() as Partial<HerdrConfig>
    try {
      resolveDeps()
      const deps = depsRef.current!
      frozenLocalTarget = resolveLocalTarget(config)
      const startupTimeout = normalizeStartupTimeoutMs(config.startupTimeoutMs)
      const restored = managedDoc.get()
      const registry = new PaneRegistry(
        {
          get: () => managedDoc.get(),
          set: (doc) => managedDoc.set(doc),
          flush: () => managedDoc.flush(),
        },
        restored,
      )
      registryRef.current = registry
      const executor = new HerdrExecutor(
        deps,
        registry,
        asks,
        projector(),
        {
          parentCwdOf: host.parentCwdOf,
          parentNodeIdOf: host.parentNodeIdOf,
          askConversationId: host.askConversationId,
          notify: host.notify,
          startupTimeoutMs: () => startupTimeout,
          createAsk: host.createAsk,
          cancelAsk: host.cancelAsk,
          isClosing: () => hostApi.isClosing,
          connectionSignal: connectionAbort.signal,
        },
        deps.transport!,
        frozenLocalTarget,
        deps.pollIntervalMs,
      )
      executorRef.current = executor
    } catch (error) {
      registryRef.current = undefined
      executorRef.current = undefined
      projectorRef.current = undefined
      depsRef.current = undefined
      throw error
    }
  }

  /**
   * Service resource cleanup: subscriptions/resolver/listeners + pane teardown branched by host shutdown:
   * - isClosing === true (graceful Hub shutdown): keep running panes (and workflow-owned keepalive panes) alive in Herdr daemon;
   * - isClosing === false (plugin disable / test dispose): close all non-failed/settled own panes.
   */
  async function stopResources(fromStop = false): Promise<void> {
    const errors: unknown[] = []
    const closingHost = hostApi.isClosing
    stopping = true
    connectionAbort.abort()
    clearSubscriptionRetry()
    projector().stop()
    try {
      unsubscribeRef.current?.()
    } catch (err) {
      errors.push(err)
    }
    unsubscribeRef.current = undefined
    subscribedPaneKey = undefined
    try {
      await overviewRef.current?.close()
    } catch (err) {
      errors.push(err)
    }
    await subscriptionTail
    if (eventTasks.size > 0) {
      const outcomes = await Promise.allSettled([...eventTasks])
      for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason)
      eventTasks.clear()
    }
    try {
      asksRelease?.()
    } catch (err) {
      errors.push(err)
    }
    asksRelease = undefined
    try {
      workflowRelease?.()
    } catch (err) {
      errors.push(err)
    }
    workflowRelease = undefined
    try {
      runtimeStartedRelease?.()
    } catch (err) {
      errors.push(err)
    }
    runtimeStartedRelease = undefined
    // Cancel all pending Asks; cancellation failures are recorded as-is (not silently swallowed). On the dispose path the host
    // may have disposed first (plugin_host_disposed 409 is an expected terminal state, no longer counted as failure --
    // AskService's own process-level cleanup finishes the job; coordinator entries are all settled with fallbacks).
    for (const entry of asks.entries()) {
      if (entry.phase === 'pending' || entry.phase === 'creating') {
        try {
          await ctx.host.cancelAsk(entry.askId, 'cancelled')
        } catch (err) {
          const expected =
            err instanceof HelmError &&
            (err.status === 404 ||
              err.code === 'ask_already_settled' ||
              err.code === 'plugin_host_disposed' ||
              err.code === 'plugin_context_expired')
          if (!expected) errors.push(err)
        }
      }
    }
    asks.settleAllAsSuperseded()
    const registry = registryRef.current
    if (registry) {
      for (const pane of registry.all()) {
        if (pane.outcome === 'failed' || pane.outcome === 'settled') continue
        if (closingHost) {
          if (pane.outcome === 'running') continue
          if (pane.outcome === 'keepalive' && pane.workflowRunId !== undefined) continue
        }
        // Remote reclaimable panes are cleaned too (closePane is idempotent, closes only own resources;
        // the frozen target guarantees we reach the server that created it).
        try {
          await executorRef.current?.closePane(pane, 'settled', { volatileMark: true })
        } catch (err) {
          errors.push(err)
        }
      }
    }
    if (closingHost && fromStop) {
      try {
        await managedDoc.flush()
      } catch (err) {
        const expected =
          err instanceof HelmError &&
          (err.code === 'plugin_host_disposed' || err.code === 'plugin_context_expired')
        if (!expected) errors.push(err)
      }
    }
    registryRef.current = undefined
    executorRef.current = undefined
    projectorRef.current = undefined
    overviewRef.current = undefined
    eventSeqCache.clear()
    // Probe observation watermarks / failure counts are invalidated with the enable cycle (new cycle restarts from first observation).
    probes.reset()
    if (errors.length > 0) {
      const detail = errors.map((e) => (e instanceof Error ? depsOf().redact(e.message) : String(e))).join('; ')
      throw new HelmError('plugin_service_stop_failed', `herdr service cleanup failed: ${detail}`, 500, { errors: detail })
    }
  }

  return {
    prepareLocalRuntime,
    async start(): Promise<void> {
      if (registryRef.current === undefined || executorRef.current === undefined) {
        prepareLocalRuntime()
      }
      const deps = depsRef.current!
      const registry = registryRef.current!
      overviewRef.current = new OverviewProjector(
        { redact: deps.redact, notify: host.notify },
        (doc) => { if (!stopping) overviewDoc.set(doc) },
        async (target, signal) => {
          const snapshot = () => transportOf().call(target, 'session.snapshot', {}, {
            signal,
            timeoutMs: 5_000,
          }).then(parseSessionSnapshot)
          let current = await snapshot()
          // Re-read after the new filtered stream's ACK, covering state changes between the first snapshot and per-pane subscription setup.
          while (await synchronizeSubscription(current.panes.map((pane) => pane.paneId), signal)) {
            current = await snapshot()
          }
          return current
        },
        () => !stopping && overviewRef.current !== undefined,
      )
      // Ask CAS seq resolver: async authoritative agent.get queries the target pane's current real seq
      // (before any createAsk; ownership via the askId triple check).
      asksRelease = ctx.host.registerAskSeqResolver((askId) =>
        asks.seqResolver(askId, async (nodeId, paneId) => {
          const pane = registry.get(nodeId, paneId)
          if (pane === undefined) return undefined
          try {
            const info = parseAgentResult(
              await transportOf().call(pane.target, 'agent.get', { target: paneId }, { timeoutMs: 5_000 }),
              'agent.get',
              'agent_info',
            )
            if (info.name !== pane.agentName) return undefined
            return info.stateChangeSeq
          } catch {
            // Authority unreachable: undefined (AskService refuses with ask_state_unavailable,
            // never treats bad data as the CAS authority).
            return undefined
          }
        }),
      )
      workflowRelease = ctx.host.onEvent('workflow.settled', (raw) => settleWorkflow(raw as WorkflowRunSummary))
      runtimeStartedRelease = ctx.host.onEvent('runtime.started', () => reconcileWorkflowOrphansAfterStartup())

      try {
        // subscribe ack first; any step failing releases the resolver, listeners and acquired resources.
        await synchronizeSubscription([], connectionAbort.signal)
        await reconcile()
        // Reclaim settled records after reconciliation (doc handle valid; the disable path forbids flush, so no reclaim after this point).
        registry.prune()
        projector().start()
        const registry0 = registryRef.current
        if (registry0 !== undefined) await overviewRef.current?.refresh(registry0, asks, frozenLocalTarget)
      } catch (error) {
        await stopResources()
        throw error
      }
    },
    async stop(fromStop = false): Promise<void> {
      await stopResources(fromStop)
    },
    liveTasks(): string[] {
      return registryRef.current ? registryRef.current.liveTaskLabels() : []
    },
    async onAgentSpawn(request: AgentSpawnRequest): Promise<HookResult<AgentSpawnRequest>> {
      const executor = executorRef.current
      if (executor === undefined) return { action: 'continue' }
      try {
        const outcome = await executor.handle(request)
        if (outcome.action === 'continue') return { action: 'continue' }
        const registry = registryRef.current
        if (!stopping && registry) await overviewRef.current?.refresh(registry, asks, frozenLocalTarget)
        return { action: 'handled', result: outcome.result }
      } finally {
        refreshOverview()
      }
    },
    async onTurnSettled(payload: TurnSettledPayload): Promise<void> {
      await settleParentTurn(payload.conversation.id)
    },
    async collectDiagnostics(raw: unknown): Promise<void> {
      await collectDiagnosticsListener?.(raw)
    },
    getRegistry: () => registryRef.current,
    getExecutor: () => executorRef.current,
    getTransport: transportOf,
  }
}

export type HerdrRuntimeModule = {
  createHerdrRuntime: typeof createHerdrRuntime
}
