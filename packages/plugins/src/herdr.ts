/**
 * builtin:herdr: intercepts agent_spawn to drive local/remote Herdr CLI agents.
 *
 * Responsibilities (design doc §4.2):
 * - "terminal runs the process, files deliver the result": background panes + .helm/wf-out-* handoff with in-place follow-up self-healing;
 * - blocked <-> AskDoc single-flight approval bridge (expectedStateSeq CAS optimistic lock, async authoritative
 *   agent.get queries the real seq live; never returns the snapshot taken at creation);
 * - $helm status token projection (self-excitation-proof heartbeat suppression + bounded renewal tied to service lifecycle);
 * - dual-track keepalive cleanup (workflowRunId -> workflow.settled event; single turn -> parent turn_settled);
 * - startup reconciliation reclaims helm-wf-* orphan panes (only confirmed own resources; failed keeps the diagnostic scene;
 *   panes genuinely still working/blocked are kept and reported, never faked as finished; keepalive orphans are reclaimable;
 *   exact agent.name === recorded-ownership verification; mismatched identity gives up ownership);
 * - ctx.action list/read/focus (HTTP/CLI equal footing with --json; read redacts to the last 40 lines;
 *   focus is an explicit user action; read/focus support nodeId disambiguation, ambiguity returns explicit 409).
 *
 * Connection discipline (one frozen connection config per enable cycle):
 * - On enable, config.session/socketPath is resolved into a frozen HerdrTarget; all commands, events,
 *   files and cleanup (including remote panes) go through the same target; after disable no server is touched again;
 * - No hot-swapping connections (prevents closing human panes with the same ID on another server); config changes take effect on next enable.
 *
 * Service lifecycle: service.start is the only place that connects (subscribe ack -> snapshot reconciliation),
 * mid-way failures clean up already-acquired resources themselves; stop cleans subscriptions/timers/Asks and reclaimable own panes.
 */

import { HelmError, type PluginDefinition } from '@helm/protocol'
import { type WorkflowRunSummary } from './contracts.js'
import { createHerdrTransport } from './herdr/transport.js'
import { targetNodeId, type HerdrConfig, type HerdrEvent, type HerdrPluginDependencies, type HerdrTarget, type HerdrTransport } from './herdr/contracts.js'
import { AskCoordinator, type AskEntry } from './herdr/asks.js'
import { MetadataProjector } from './herdr/metadata.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, nodeIdOf, type ManagedDoc } from './herdr/panes.js'
import { HerdrExecutor } from './herdr/executor.js'
import { registerHerdrActions } from './herdr/actions.js'
import { HerdrProbeCollector } from './herdr/probes.js'
import {
  assertOkResult,
  isOkResult,
  parseAgentResult,
  parseSessionSnapshot,
} from './herdr/rpc.js'
import { isValidSessionName, resolveSocketPath } from './herdr/transport.js'
import { normalizeStartupTimeoutMs } from './herdr/spawn-rules.js'
import { assembleHerdrDepsFromHost, nodeChannelFromHost } from './herdr/host-ports.js'
import { OverviewProjector, type OverviewDoc } from './herdr/overview.js'
import { resolvePluginClientRoot } from './asset-paths.js'

/** clientRoot resolution converges to the shared asset path (src / dist dual run forms; missing is an explicit error, never silently degraded). */
function resolveHerdrClientRoot(): string {
  return resolvePluginClientRoot('builtin:herdr', 'herdr', 'herdr_plugin_client_missing')
}

/** The 23 Herdr CLI agent.start kinds (full detect::agent_label set); candidates for ProfileRuntimeUiSpec. */
const HERDR_AGENT_SUGGESTIONS: ReadonlyArray<string> = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline',
  'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid',
  'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse',
]

export function createHerdrPlugin(
  timingOverrides?: Pick<
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
  >,
): PluginDefinition {
  return {
    id: 'builtin:herdr',
    name: 'Herdr Terminals',
    description: 'Cross-node Herdr coordination: drives remote CLI tool execution, terminal approval bridging (AskDoc CAS), and status-bar projection.',
    icon: 'terminal',
    version: '0.1.0',
    clientRoot: resolveHerdrClientRoot(),
    definePlugin(ctx) {
      // ---- Host port assembly (zero-arg factory: all dependencies come from ctx.host) ----
      // During definePlugin only the host reference is held (disable-time registration/definition collection touches no network);
      // Dependencies are assembled at service.start on enable (frozen for the cycle; hot rewiring has no effect).
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
      let overviewDoc: ReturnType<typeof ctx.doc<OverviewDoc>>
      let managedDoc: ReturnType<typeof ctx.doc<ManagedDoc>>
      let asksRelease: (() => void) | undefined
      let workflowRelease: (() => void) | undefined

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
          registryRef.current?.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
          executorRef.current?.releasePaneState(pane)
          forgetPaneCaches(nodeIdOf(pane), pane.paneId)
        },
        cancelAskQuietly: cancelQuietly,
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
            `${event.type} ${'workspaceId' in event ? event.workspaceId : event.paneId}：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
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
              registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
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
          if (error instanceof HelmError && error.status === 404) return
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
        const snapshots = new Map<string, ReturnType<typeof parseSessionSnapshot>>([
          [JSON.stringify(frozenLocalTarget), parseSessionSnapshot(await transportOf().call(frozenLocalTarget, 'session.snapshot', {}, { timeoutMs: 5_000 }))],
        ])
        for (const pane of registry.all()) {
          if (pane.outcome === 'settled') continue
          const key = JSON.stringify(pane.target)
          if (!snapshots.has(key)) snapshots.set(key, parseSessionSnapshot(await transportOf().call(pane.target, 'session.snapshot', {}, { timeoutMs: 5_000 })))
          const agent = snapshots.get(key)!.agents.find((a) => a.paneId === pane.paneId)
          if (pane.outcome === 'failed') continue // persistent failed: keep the diagnostic scene
          if (agent === undefined) {
            // Pane already gone: register settled (no resources to reclaim) + align the executor side.
            registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            executorRef.current?.releasePaneState(pane)
            forgetPaneCaches(nodeIdOf(pane), pane.paneId)
            continue
          }
          // Exact ownership verification: agent.name must equal the recorded agentName (no startsWith --
          // helm-wf-abc must not claim helm-wf-abcde). Mismatched identity gives up ownership; no wrong closes.
          if (agent.name !== pane.agentName) {
            registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            executorRef.current?.releasePaneState(pane)
            forgetPaneCaches(nodeIdOf(pane), pane.paneId)
            continue
          }
          // Genuinely still working/blocked: keep and report (never fake completion to auto-reclaim).
          if (agent.agentStatus === 'working' || agent.agentStatus === 'blocked' || agent.agentStatus === 'unknown') {
            host.notify(
              'Herdr startup reconciliation found in-flight panes',
              `pane ${pane.paneId} (${pane.agentName}) is still in ${agent.agentStatus}, kept pending ${pane.workflowRunId !== undefined ? 'workflow' : 'parent turn'} settle or manual handling`,
              'info',
            )
            continue
          }
          // Already finished (idle/done/unknown) with no in-flight spawn (process restart): orphan, reclaimable.
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

      // ---- Docs and UI ----
      managedDoc = ctx.doc<ManagedDoc>('managed', EMPTY_MANAGED_DOC)
      overviewDoc = ctx.doc<OverviewDoc>(
        'overview',
        { version: 2, updatedAt: 0, stale: true, panes: [], asks: [] },
        { public: true },
      )

      ctx.ui.sidebarItem({
        id: 'herdr',
        label: 'Herdr Terminals',
        icon: 'terminal',
        target: 'screen:builtin:herdr/overview',
        order: 40,
      })
      ctx.ui.screen({
        id: 'overview',
        label: 'Herdr Terminals Overview',
        icon: 'terminal',
        client: { module: 'index.tsx', export: 'HerdrOverviewScreen' },
      })
      ctx.ui.profileRuntime({
        id: 'herdr',
        kind: 'herdr',
        label: 'External Herdr Runtime',
        icon: 'terminal',
        description: '(optional) bind to a Herdr CLI when used as a subagent',
        agentSuggestions: [...HERDR_AGENT_SUGGESTIONS],
      })

      // ---- hooks ----
      ctx.hook.onAgentSpawn(async (request) => {
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
      }, { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await settleParentTurn(payload.conversation.id)
      })

      // diagnostics.collect listener (rerouted from the old watchdog_tick priority-100 hook):
      // The inspection initiator (builtin:superagent Watchdog service) collects native facts, then via the host's
      // internal event this plugin appends real probes for its own panes (incl. remote polling). The host awaits
      // the event; collection failures propagate to the initiator as-is, never swallowed; collection impl and stall
      // watermark details in herdr/probes.ts. human-ownership red line: never produce probes for non-own panes.
      probes.register(ctx.host)

      // ---- actions (list/read/focus/steer registration and pane disambiguation in herdr/actions.ts) ----
      registerHerdrActions(ctx, {
        registry: () => registryRef.current,
        executor: () => executorRef.current,
        transport: transportOf,
        redact: (text) => depsOf().redact(text),
        parentOfConversation: (id) => {
          try {
            return hostApi.getConversation(id).parentConversationId
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') return undefined
            throw error
          }
        },
      })

      // ---- config schema (configurable before enable; changes take effect on next enable) ----
      ctx.configSchema({
        session: { type: 'string', label: 'Herdr session name', description: 'Local herdr sessions/<name> subdirectory', default: '' },
        socketPath: { type: 'string', label: 'Socket path override', description: 'Defaults to HERDR_SOCKET_PATH or the default session path', default: '' },
        startupTimeoutMs: {
          type: 'number',
          label: 'Agent startup timeout (ms)',
          description: '3001..300000, default 30000',
          default: 30000,
        },
      })

      // ---- service: start connects (ack precedes reconciliation), stop cleans everything ----
      ctx.service({
        id: 'herdr-connection',
        liveTasks() {
          return registryRef.current ? registryRef.current.liveTaskLabels() : []
        },
        async start() {
          stopping = false
          connectionAbort = new AbortController()
          const config = ctx.getConfig() as Partial<HerdrConfig>
          // Port assembly (frozen within the cycle; a missing port capability is explicitly reported by the host port itself).
          resolveDeps()
          const deps = depsRef.current!
          // Freeze the local connection target for this enable cycle (shared by all calls afterwards; hot config no longer applies).
          frozenLocalTarget = resolveLocalTarget(config)
          const startupTimeout = normalizeStartupTimeoutMs(config.startupTimeoutMs)
          const restored = managedDoc.get()
          const registry = new PaneRegistry(
            { get: () => managedDoc.get(), set: (doc) => managedDoc.set(doc) },
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
            },
            deps.transport!,
            frozenLocalTarget,
            deps.pollIntervalMs,
          )
          executorRef.current = executor
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
        async stop() {
          await stopResources()
        },
      })

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

      /** Service resource cleanup: subscriptions/resolver/listeners + reclaimable own panes (failed keeps the scene). */
      async function stopResources(): Promise<void> {
        const errors: unknown[] = []
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
        // Cancel all pending Asks; cancellation failures are recorded as-is (not silently swallowed). On the dispose path the host
        // may have disposed first (plugin_host_disposed 409 is an expected terminal state, no longer counted as failure --
        // AskService's own process-level cleanup finishes the job; coordinator entries are all settled with fallbacks).
        for (const entry of asks.entries()) {
          if (entry.phase === 'pending' || entry.phase === 'creating') {
            try {
              await ctx.host.cancelAsk(entry.askId, 'cancelled')
            } catch (err) {
              const expected =
                err instanceof HelmError && (err.status === 404 || err.code === 'plugin_host_disposed' || err.code === 'plugin_context_expired')
              if (!expected) errors.push(err)
            }
          }
        }
        asks.settleAllAsSuperseded()
        const registry = registryRef.current
        if (registry) {
          for (const pane of registry.all()) {
            if (pane.outcome === 'failed' || pane.outcome === 'settled') continue
            // Remote reclaimable panes are cleaned too (closePane is idempotent, closes only own resources;
            // the frozen target guarantees we reach the server that created it).
            try {
              await executorRef.current?.closePane(pane, 'settled', { volatileMark: true })
            } catch (err) {
              errors.push(err)
            }
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

    },
  }
}

export type { OverviewDoc } from './herdr/overview.js'
