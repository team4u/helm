/**
 * builtin:herdr's diagnostics.collect probe collection (split out of herdr.ts).
 *
 * The inspection initiator (builtin:superagent Watchdog service) collects native facts, then via the host's
 * internal event this plugin appends real probes for its own panes (incl. remote polling). The event is
 * awaited in the host; collection failures propagate to the initiator as-is, never silently swallowed.
 * human-ownership red line: no probes for non-own panes; the overview refetch is a read-only collection.
 */

import {
  DIAGNOSTICS_COLLECT_EVENT,
  appendProbes,
  parseCollection,
} from '../diagnostics.js'
import type { AskCoordinator, AskEntry } from './asks.js'
import type { HerdrTarget, HerdrTransport } from './contracts.js'
import type { HerdrExecutor } from './executor.js'
import type { OverviewProjector } from './overview.js'
import { nodeIdOf, scopeKey, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult } from './rpc.js'

/** The probe collector's minimal dependency surface on the plugin main (herdr.ts). */
export interface HerdrProbeDeps {
  asks: AskCoordinator
  /** The registry's current value (undefined after disable: collection returns immediately, touching no server). */
  registry(): PaneRegistry | undefined
  overview(): OverviewProjector | undefined
  executor(): HerdrExecutor | undefined
  transport(): HerdrTransport
  /** The frozen local connection target for this enable cycle. */
  localTarget(): HerdrTarget
  /** The connection abort signal for this enable cycle. */
  signal(): AbortSignal
  /** Settle alignment on authoritative ownership mismatch / pane disappearance (registry settled + executor release + cache reclaim). */
  settleUnmanaged(pane: ManagedPane): void
  /** Ask cancellation (404 silent; other failures notify honestly). */
  cancelAskQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void>
}

/**
 * Probe collector: event listener + single-pane probe construction (stall watermark maintenance and facts semantics).
 *
 * Observation watermarks (per enable cycle; keyed by scopeKey(nodeId, paneId)):
 * stalledMs semantics = the time since "the last moment a (status, seq) change was observed" --
 * first observation starts at 0, and any watermark or status change resets it; a failed probe (unreachable)
 * does not move the watermark (a failed read is not evidence of progress; stall keeps accumulating). Note this
 * semantics reflects only state transitions, not work activity (an active task with no state flips for a long
 */
export class HerdrProbeCollector {
  private readonly observations = new Map<string, { status: string; seq: number | undefined; since: number }>()
  /** Consecutive probe failure count (cleared on a successful agent.get; a diagnostic fact only, triggering no automatic action). */
  private readonly failures = new Map<string, number>()

  constructor(private readonly deps: HerdrProbeDeps) {}

  /** When a pane is settled out of the registry, reclaim its observation watermark/failure count in sync (prevent long-lived leaks). */
  forget(nodeId: string | undefined, paneId: string): void {
    const scope = scopeKey(nodeId, paneId)
    this.observations.delete(scope)
    this.failures.delete(scope)
  }

  /** Disable clears: watermarks and failure counts are invalidated with the enable cycle (new cycle restarts from first observation). */
  reset(): void {
    this.observations.clear()
    this.failures.clear()
  }

  /** Register the diagnostics.collect listener (same as before the split: registered once at definePlugin; disable relies on the registry-undefined guard). */
  register(host: { onEvent(type: string, listener: (payload: unknown) => Promise<void> | void): () => void }): void {
    host.onEvent(DIAGNOSTICS_COLLECT_EVENT, async (raw) => {
      await this.collect(raw)
    })
  }

  /** One collection round: entry boundary validation -> overview refetch -> concurrent probes -> append (failures propagate to the initiator honestly). */
  private async collect(raw: unknown): Promise<void> {
    // Event entry boundary validation: an invalid payload throws to the publisher (await semantics); no guessing, no swallowing.
    const collection = parseCollection(raw)
    const registry = this.deps.registry()
    if (!registry) return
    const overview = this.deps.overview()
    if (overview !== undefined) {
      // cwd/seen etc. have no event changes (official actions.rs:1780 only changes cwd, emits no event);
      // rely on this tick's snapshot refetch to align; single-flight merge, no new standalone timer.
      await overview.refresh(registry, this.deps.asks, this.deps.localTarget())
    }
    const now = Date.now()
    const activePanes = registry.all().filter((pane) => pane.outcome !== 'settled')
    // Concurrent probes: single-pane agent.get with a 5s short timeout and Promise.all concurrency,
    // preventing a single slow/hung node from serially stalling the collection budget.
    const probes = await Promise.all(
      activePanes.map(async (pane): Promise<ReturnType<HerdrProbeCollector['buildProbe']> | undefined> => {
        const scope = scopeKey(nodeIdOf(pane), pane.paneId)
        let status = 'unknown'
        let authoritySeq: number | undefined
        try {
          const info = parseAgentResult(
            await this.deps.transport().call(
              pane.target,
              'agent.get',
              { target: pane.paneId },
              { signal: this.deps.signal(), timeoutMs: 5_000 },
            ),
            'agent.get',
            'agent_info',
          )
          if (info.name !== pane.agentName || info.tabId !== pane.tabId) {
            this.deps.settleUnmanaged(pane)
            return undefined
          }
          for (const superseded of this.deps.asks.observeAuthority({
            paneId: pane.paneId,
            nodeId: nodeIdOf(pane),
            seq: info.stateChangeSeq,
            status: info.agentStatus,
          })) {
            await this.deps.cancelAskQuietly(superseded, 'superseded')
          }
          status = info.agentStatus
          authoritySeq = info.stateChangeSeq
          this.failures.delete(scope)
        } catch {
          status = 'unreachable'
          // Authority unreachable: never fabricate a seq; the watermark is unchanged (stall keeps accumulating),
          // and the consecutive failure count increments honestly.
          this.failures.set(scope, (this.failures.get(scope) ?? 0) + 1)
        }
        return this.buildProbe(pane, status, authoritySeq, now)
      }),
    )
    appendProbes(collection, probes.filter((probe) => probe !== undefined))
  }

  /** Single-pane probe construction (stall watermark maintenance and facts semantics; the collection event body). */
  private buildProbe(
    pane: ManagedPane,
    status: string,
    authoritySeq: number | undefined,
    now: number,
  ) {
    const scope = scopeKey(nodeIdOf(pane), pane.paneId)
    // Stall watermark: first observation starts at 0; any change of (status, seq) resets;
    // unreachable keeps the old watermark accumulating (a failed read is not evidence of progress; neither
    // faking stall with total runtime nor resetting to rerun on probe failure).
    const prev = this.observations.get(scope)
    let stalledMs = 0
    if (status === 'unreachable') {
      // Read failure: keep accumulating from the old observation point (with no old observation, start from now; never fabricate progress).
      if (prev !== undefined) {
        stalledMs = now - prev.since
      } else {
        this.observations.set(scope, { status, seq: undefined, since: now })
      }
    } else if (prev === undefined || prev.status !== status || prev.seq !== authoritySeq) {
      this.observations.set(scope, { status, seq: authoritySeq, since: now })
    } else {
      stalledMs = now - prev.since
    }
    const pendingAskCount = this.deps.asks
      .entries()
      .filter(
        (e) =>
          e.paneId === pane.paneId &&
          e.nodeId === nodeIdOf(pane) &&
          (e.phase === 'pending' || e.phase === 'creating'),
      ).length
    return {
      targetId: pane.paneId,
      targetKind: 'external' as const,
      nodeId: nodeIdOf(pane) ?? 'local',
      ownedBy: 'helm' as const,
      status,
      ...(authoritySeq !== undefined ? { stateChangeSeq: authoritySeq } : {}),
      stalledMs,
      ...(status === 'unreachable' ? { consecutiveErrors: this.failures.get(scope) ?? 1 } : {}),
      facts: {
        kind: 'herdr',
        agentName: pane.agentName,
        outcome: pane.outcome,
        effectiveCwd: pane.effectiveCwd,
        parentConversationId: pane.parentConversationId,
        pendingAskCount,
        // Honest semantics: stalledMs is based on the observation moment of state/watermark changes, not work activity.
        stalledBasis: 'since-last-state-change',
      },
    }
  }
}
