/**
 * Herdr overview projection (design §4.2 "the overview shows all local Herdr panes live").
 *
 * Data model: authoritative source = the local session.snapshot's panes[] (all panes, incl. human
 * shells); AgentInfo joins by paneId only to add the real five states and state_change_seq (no seq is
 * ever fabricated without an Agent). The registry is only an ownership overlay: a local record + the exact
 * same frozen target + pane.tabId / AgentInfo.name / Agent join all matching counts as helmx-managed;
 * everything else is human (same-ID remote records, pane rebuilds, agent restarts claim nothing), and human
 * rows carry no outcome / pendingAsk or any management info.
 *
 * Lifecycle discipline (all honesty requirements):
 * - single-flight merge: concurrent refreshes merge into the same in-flight loop via dirty, and the returned promise waits
 *   for all supplementary rounds to finish (no fire-and-forget restarts);
 * - close: mark closed + abort in-flight fetches and wait for them to finish; zero writes, zero notifications afterwards;
 * - collection failure: redact + notify + stale, keeping the last successful data and updatedAt (only a
 *   successful collection advances the timestamp); repeated identical errors are deduped in notifications;
 * - subscription health is separate from collection failure: a successful fetch does not clear streamError; only a real subscription
 *   ACK (markSubscriptionReady) recovers;
 * - evict watermark: after a pane closes, "an old snapshot started before the event" must not resurrect the
 *   row; only a snapshot round started after the eviction may rebuild it;
 * - secrets: all external strings (cwd/foregroundCwd/label/title/agent/agentName)
 *   land in the doc after redaction (the doc goes straight into state.sqlite; transport-side redaction is not enough).
 */

import type { HerdrTarget } from './contracts.js'
import type { ManagedPane, PaneRegistry } from './panes.js'
import type { AskCoordinator } from './asks.js'
import type { HerdrAgentInfo, HerdrAgentStatus, HerdrPaneSnapshotInfo, SessionSnapshotData } from './rpc.js'

/** One overview row: all local panes are the base table; management fields are carried only by helmx-managed rows. */
export interface OverviewPaneRow {
  nodeId: string
  paneId: string
  tabId: string
  workspaceId: string
  ownedBy: 'helmx' | 'human'
  /** Real five states: AgentInfo join or PaneInfo.agent_status (officially unknown for shells). */
  agentStatus: HerdrAgentStatus
  /** Exists only for Agent terminals; omitted without an Agent, never fabricated. */
  stateChangeSeq?: number
  cwd?: string
  /** The agent's real foreground directory (redaction clears secrets only, keeping directory semantics). */
  foregroundCwd?: string
  label?: string
  title?: string
  agent?: string
  /** AgentInfo.name (shown after redaction; ownership checks use the raw value, in memory only). */
  agentName?: string
  focused?: boolean
  /** Managed rows only: the Helmx task lifecycle (not the Herdr pane state). */
  outcome?: string
  /** Managed rows only: a pending approval exists. */
  pendingAsk?: boolean
}

export interface OverviewDoc {
  version: 2
  /** Last successful collection time (kept during collection/subscription failures). */
  updatedAt: number
  /** True on collection or subscription failure: panes hold the last successful data. */
  stale: boolean
  /** Failure diagnostics (after redaction); omitted when healthy. */
  error?: string
  panes: OverviewPaneRow[]
  asks: Array<{ paneId: string; nodeId: string; seq: number; phase: string }>
}

interface OverviewDependencies {
  redact: (text: string) => string
  notify(title: string, body: string, level: 'info' | 'error'): void
}

/** Provided by the host: read snapshot (abortable via AbortSignal); boundary validation is the host's job. */
type SnapshotFetcher = (target: HerdrTarget, signal: AbortSignal) => Promise<SessionSnapshotData>

const PENDING_ASK_PHASES = new Set(['pending', 'creating'])

interface SnapshotCache {
  panes: HerdrPaneSnapshotInfo[]
  agentsByPane: Map<string, HerdrAgentInfo>
}

export class OverviewProjector {
  private closed = false
  private readonly abort = new AbortController()
  private dirty = false
  private inFlight: Promise<void> | undefined
  /** Snapshot round (advanced before each fetch starts); the evict watermark compares against it. */
  private round = 0
  private readonly evictWatermark = new Map<string, number>()
  private cache: SnapshotCache | undefined
  /** Latest registry/asks/target: subscription health marking and lightweight re-projection both recompute from them. */
  private registry: PaneRegistry | undefined
  private asks: AskCoordinator | undefined
  private target: HerdrTarget | undefined
  private updatedAt = 0
  private fetchError: string | undefined
  private streamError: string | undefined
  private lastDoc: OverviewDoc | undefined

  constructor(
    private readonly deps: OverviewDependencies,
    private readonly write: (doc: OverviewDoc) => void,
    private readonly fetchSnapshot: SnapshotFetcher,
    private readonly isUsable: () => boolean,
  ) {}

  /** Startup/event refetch: single-flight merge; the returned promise waits for all supplementary rounds. */
  refresh(registry: PaneRegistry, asks: AskCoordinator, target: HerdrTarget): Promise<void> {
    this.registry = registry
    this.asks = asks
    this.target = target
    if (this.closed || !this.isUsable()) return Promise.resolve()
    this.dirty = true
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.drain()
    return this.inFlight
  }

  /** Disable: mark closed + abort in-flight fetches, wait for all in-flight work to finish; zero writes, zero notifications afterwards. */
  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    const inflight = this.inFlight
    if (inflight !== undefined) await inflight
  }

  /** Lightweight re-projection (Ask phase etc.): recompute the doc from cache only, no RPC, no fabricated collection time. */
  republish(registry: PaneRegistry, asks: AskCoordinator): void {
    this.registry = registry
    this.asks = asks
    this.publish()
  }

  /**
   * Pane closed/exited: remove the cached row immediately and mark dirty; the watermark is recorded on the current round,
   * so "an old snapshot started before the event" cannot publish that pane again -- only a snapshot round
   * started after the eviction (round > watermark) may rebuild the row.
   */
  evictPane(paneId: string): void {
    this.evictWatermark.set(paneId, this.round)
    this.dirty = true
    const cache = this.cache
    if (cache !== undefined) {
      const agentsByPane = new Map(cache.agentsByPane)
      agentsByPane.delete(paneId)
      this.cache = { panes: cache.panes.filter((p) => p.paneId !== paneId), agentsByPane }
    }
    // Reflect the disappearance immediately (the overview no longer shows the closed pane before the next refetch).
    this.publish()
  }

  /** Event stream failure: record streamError and publish stale/error (a successful fetch does not clear it). */
  markSubscriptionFailed(error: unknown): void {
    this.streamError = this.deps.redact(messageOf(error))
    this.publish()
  }

  /** Real subscription ACK: the only place streamError is cleared. */
  markSubscriptionReady(): void {
    this.streamError = undefined
    this.publish()
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.closed && this.isUsable()) {
        this.dirty = false
        const round = ++this.round
        let snapshot: SessionSnapshotData
        try {
          snapshot = await this.fetchSnapshot(this.target!, this.abort.signal)
        } catch (error) {
          // A close-triggered abort is not a collection failure: finish silently, no notification, no write.
          if (this.closed || this.abort.signal.aborted) return
          const previous = this.fetchError
          this.fetchError = this.deps.redact(messageOf(error))
          if (this.fetchError !== previous && this.isUsable()) {
            this.deps.notify('Herdr overview refresh failed', `session.snapshot read failed; the overview keeps the last successful data: ${this.fetchError}`, 'error')
          }
          this.publish()
          continue
        }
        if (this.closed) return
        this.fetchError = undefined
        this.updatedAt = Date.now()
        this.cache = {
          panes: snapshot.panes.filter((p) => this.allowsPane(p.paneId, round)),
          agentsByPane: new Map(snapshot.agents.map((a) => [a.paneId, a])),
        }
        // Watermarks passed by this round are invalidated (pane rebuilt or confirmed gone), preventing unbounded Map growth.
        for (const [paneId, watermark] of [...this.evictWatermark]) {
          if (round > watermark) this.evictWatermark.delete(paneId)
        }
        // Successful collection publishes forcibly: updatedAt must advance honestly (dedup must not swallow successful refresh times).
        this.publish(true)
      }
    } finally {
      this.inFlight = undefined
    }
  }

  /** Evict watermark check: only a snapshot round started after the eviction may rebuild the pane row. */
  private allowsPane(paneId: string, round: number): boolean {
    const watermark = this.evictWatermark.get(paneId)
    return watermark === undefined || round > watermark
  }

  /** Cache + registry overlay + Ask phase -> doc (force only lets a successful collection advance updatedAt). */
  private publish(force = false): void {
    if (this.closed || !this.isUsable()) return
    const error = this.fetchError ?? this.streamError
    const pendingAsks = new Set(
      (this.asks?.entries() ?? [])
        .filter((e) => PENDING_ASK_PHASES.has(e.phase))
        .map((e) => `${e.nodeId ?? 'local'}:${e.paneId}`),
    )
    const cache = this.cache
    const panes: OverviewPaneRow[] = []
    if (cache !== undefined) {
      for (const pane of cache.panes) {
        panes.push(this.buildRow(pane, cache.agentsByPane.get(pane.paneId), pendingAsks))
      }
    }
    const next: OverviewDoc = {
      version: 2,
      updatedAt: this.updatedAt,
      stale: cache === undefined || error !== undefined,
      ...(error !== undefined ? { error } : {}),
      panes,
      asks: this.asks?.describe() ?? [],
    }
    if (!force && sameDoc(next, this.lastDoc)) return
    this.lastDoc = next
    this.write(next)
  }

  private buildRow(
    pane: HerdrPaneSnapshotInfo,
    agent: HerdrAgentInfo | undefined,
    pendingAsks: Set<string>,
  ): OverviewPaneRow {
    const redact = this.deps.redact
    const record = this.owns(pane, agent)
    const foregroundCwd = agent?.foregroundCwd ?? pane.foregroundCwd
    const row: OverviewPaneRow = {
      nodeId: 'local',
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
      ownedBy: record !== undefined ? 'helmx' : 'human',
      agentStatus: agent?.agentStatus ?? pane.agentStatus,
      ...(agent !== undefined ? { stateChangeSeq: agent.stateChangeSeq } : {}),
      ...(pane.cwd !== undefined ? { cwd: redact(pane.cwd) } : {}),
      ...(foregroundCwd !== undefined ? { foregroundCwd: redact(foregroundCwd) } : {}),
      ...(pane.label !== undefined ? { label: redact(pane.label) } : {}),
      ...(pane.title !== undefined ? { title: redact(pane.title) } : {}),
      ...(pane.agent !== undefined ? { agent: redact(pane.agent) } : {}),
      ...(agent?.name !== undefined ? { agentName: redact(agent.name) } : {}),
      ...(pane.focused !== undefined ? { focused: pane.focused } : {}),
    }
    if (record !== undefined) {
      row.outcome = record.outcome
      if (pendingAsks.has(`local:${pane.paneId}`)) row.pendingAsk = true
    }
    return row
  }

  /**
   * Managed ownership: a registry local record (scoped get; same-ID remote records can never match) +
   * the exact same frozen target + pane.tabId matching + AgentInfo.name exactly equal to the recorded
   * agentName + the Agent join's tab/workspace matching the pane; any mismatch means human.
   */
  private owns(pane: HerdrPaneSnapshotInfo, agent: HerdrAgentInfo | undefined): ManagedPane | undefined {
    if (agent?.name === undefined || this.target === undefined) return undefined
    const record = this.registry?.get(undefined, pane.paneId)
    if (record === undefined) return undefined
    if (JSON.stringify(record.target) !== JSON.stringify(this.target)) return undefined
    if (pane.tabId !== record.tabId) return undefined
    if (agent.name !== record.agentName) return undefined
    if (agent.tabId !== pane.tabId || agent.workspaceId !== pane.workspaceId) return undefined
    return record
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** updatedAt is not compared (publish only on payload changes, preventing jitter and SSE noise). */
function sameDoc(a: OverviewDoc, b: OverviewDoc | undefined): boolean {
  if (b === undefined) return false
  return (
    a.stale === b.stale &&
    a.error === b.error &&
    a.panes.length === b.panes.length &&
    a.panes.every((p, i) => JSON.stringify(p) === JSON.stringify(b.panes[i])) &&
    a.asks.length === b.asks.length &&
    a.asks.every((q, i) => JSON.stringify(q) === JSON.stringify(b.asks[i]))
  )
}
