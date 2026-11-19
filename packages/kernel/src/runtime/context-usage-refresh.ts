/**
 * Per-conversation synchronous contextUsage cache and async refresh chain (extracted from conversations.ts).
 *
 * Two-tier state:
 * - Synchronously readable cache (cache / keys / entryWatermark / waiters): cleaned up on stopObserving
 *   (waiters resolve first so none hang); stale async refreshes drop via observe generation guard;
 * - Refresh chain lifecycle (pending / dirty): in-flight refreshes can outlive stopObserving (pending cleans up
 *   in finally, and re-triggers simply mark dirty), so they live outside ConversationMirror (see exception list in conversation-mirror.ts).
 *
 * Frame discipline (preserving original semantics):
 * - Initial population stays silent (automatically visible on snapshot/HTTP read), except: (1) compacting=true
 *   on initial hydrate must publish (otherwise subscribers would never see it), or (2) explicit on-demand triggers;
 * - During active runs, only emit frames on compacting / contextWindow transitions (tokens settle with emitSettled);
 * - Publishes never advance stateChangeSeq (reserved exclusively for CAS watermarks; derived display metrics must not pollute it).
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ContextView, ConversationView, Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConversationContextUsage, ConversationSummary } from '@helmx/protocol'
import type { LiveStateShape } from './conversation-mirror.js'
import type { ConvMeta, HelmxStore } from './store.js'
import { knownContextWindowOf } from './models.js'
import {
  assembleContextUsage,
  compactionLiveKeyOf,
  compactingOf,
  contextUsageKeyOf,
  estimateContextUsage,
} from './context-usage.js'
import { emitDiagnostic, type KernelDiagnosticEmitter } from './diagnostics.js'
import type { EntryRecordLike } from './entries.js'

/** Minimal port from refresh chain to host (ConversationTracker). */
export interface ContextUsageHost {
  readonly harness: Harness
  readonly store: HelmxStore
  /** Emit summary change (conversation.upsert semantic frame). */
  onSummaryChanged(summary: ConversationSummary): void
  /** Read current Models catalog (returns undefined when unavailable: omits contextWindow without fabricating). */
  modelsOf(): Models | undefined
  /** Read current observe generation (discard guard for late async results). */
  generationOf(conversationId: number): symbol | undefined
  /** Read current live mirror (checks compaction state and active run). */
  liveOf(conversationId: number): LiveStateShape | undefined
  /** Read authoritative current summary (constructs published frame; reads our cache without creating loops). */
  summaryOf(conversationId: number): ConversationSummary
  /** Host shutdown guard (blocks initiating refreshes against a closed Harness after close starts). */
  isClosing?(): boolean
  /** Diagnostic channel reporter (defaults to defaultDiagnosticSink). */
  emitDiagnostic?: KernelDiagnosticEmitter
}

export class ContextUsageRefresh {
  /** conversation -> cached usage value (read synchronously by summaryOf; undefined = not yet computed). */
  private readonly cache = new Map<number, ConversationContextUsage>()
  /** conversation -> fingerprint of last published usage (prevents duplicate conversation.upsert). */
  private readonly keys = new Map<number, string>()
  /** conversation -> highest entry ID scanned for context triggers (advances monotonically even without entry sinks). */
  private readonly entryWatermark = new Map<number, number>()
  /** conversation -> waiters awaiting refresh chain quiescence (woken by ensureContextUsage or stopObserving fallback). */
  private readonly waiters = new Map<number, Array<() => void>>()
  /** Conversations with an in-flight refresh (prevents duplicate refreshes; new triggers mark dirty to rerun). */
  private readonly pending = new Set<number>()
  /** Conversations invalidated again while a refresh was in flight (runs once more upon completion). */
  private readonly dirty = new Set<number>()
  /** Conversations whose on-demand readiness (e.g. opening detail or post-turn settle) should publish initial `conversation.upsert`. */
  private readonly notifyInitial = new Set<number>()

  constructor(private readonly host: ContextUsageHost) {}

  /** Synchronously read cached usage without scheduling. */
  peek(conversationId: number): ConversationContextUsage | undefined {
    return this.cache.get(conversationId)
  }

  /** List conversation IDs currently cached (target set for onModelsChanged invalidation). */
  cachedConversationIds(): number[] {
    return [...this.cache.keys()]
  }

  /** Synchronously read cached usage, scheduling a background refresh on miss (deduplicated via pending/dirty). */
  cachedOrSchedule(conversationId: number): ConversationContextUsage | undefined {
    const cached = this.cache.get(conversationId)
    if (cached !== undefined) return cached
    this.schedule(conversationId)
    return undefined
  }

  /** Schedule an asynchronous context usage refresh (fire-and-forget; safe to invoke inside synchronous observe callbacks). */
  schedule(conversationId: number, options?: { publishWhenReady?: boolean }): void {
    if (this.host.isClosing?.()) return
    if (!this.host.store.getConv(conversationId)) return
    if (options?.publishWhenReady === true && !this.cache.has(conversationId)) {
      this.notifyInitial.add(conversationId)
    }
    if (this.pending.has(conversationId)) {
      this.dirty.add(conversationId)
      return
    }
    this.pending.add(conversationId)
    void this.refreshOnce(conversationId)
      .catch((error: unknown) => {
        if (this.host.isClosing?.()) return
        // Log refresh errors honestly without overwriting stale cache or blocking the observe path.
        const event = {
          level: 'error' as const,
          source: 'tracker.context_usage',
          message: 'context usage refresh failed',
          error,
          conversationId,
        }
        if (this.host.emitDiagnostic !== undefined) {
          this.host.emitDiagnostic(event)
        } else {
          emitDiagnostic(undefined, undefined, event)
        }
      })
      .finally(() => {
        this.pending.delete(conversationId)
        // Re-schedule if another change happened while in flight (new settlement, compaction, or rewind).
        if (this.dirty.delete(conversationId)) {
          this.schedule(conversationId)
        }
        // Wake waiters (ensureContextUsage) to re-check cache and pending state.
        const waiters = this.waiters.get(conversationId)
        if (waiters !== undefined) {
          this.waiters.delete(conversationId)
          for (const resolve of waiters) resolve()
        }
      })
  }

  /** Ensure contextUsage cache is populated and any refresh chain has settled (used on detail reads, etc.).
   *
   * - Cached with no in-flight refresh: returns immediately (zero overhead on warm reads);
   * - Missing or in-flight: waits for the refresh chain to settle (coalesces concurrent callers; also waits through
   *   dirty reruns so detail reads never observe stale pre-invalidation values);
   * - Event-driven across settlement waves (zero polling/sleeps), bounded to 8 rounds against pathological churn. */
  async ensure(conversationId: number): Promise<void> {
    if (!this.cache.has(conversationId) && this.host.store.getConv(conversationId) && !this.host.isClosing?.()) {
      this.notifyInitial.add(conversationId)
    }
    for (let round = 0; round < 8; round += 1) {
      if (this.cache.has(conversationId) && !this.pending.has(conversationId)) {
        return
      }
      if (!this.host.store.getConv(conversationId)) return
      if (!this.pending.has(conversationId)) {
        this.schedule(conversationId)
        // Scheduling refused (e.g., conversation deleted): exit immediately instead of waiting.
        if (!this.pending.has(conversationId)) return
      }
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(conversationId) ?? []
        list.push(resolve)
        this.waiters.set(conversationId, list)
      })
    }
  }

  /** Align initial watermark in adoptInitial so historical marker entries (pi.compaction, etc.)
   * in the first snapshot do not trigger duplicate refreshes on subsequent adopts. */
  advanceWatermarkTo(conversationId: number, value: number): void {
    const current = this.entryWatermark.get(conversationId) ?? 0
    if (value > current) this.entryWatermark.set(conversationId, value)
  }

  /** Scan context boundaries: trigger refresh only when a new entry beyond the watermark is pi.compaction /
   * pi.reset / helmx.rewind, or when pi.live compaction state (compactions/compactionFailure) changes.
   * Monotonic watermark prevents re-triggering on streaming snapshots (even when onEntryCommitted is inactive). */
  noteBoundary(
    id: number,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): void {
    const old = this.entryWatermark.get(id) ?? 0
    let watermark = old
    let boundary = false
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= old) continue
      if (numeric > watermark) watermark = numeric
      const kind = (raw as { kind?: unknown }).kind
      if (kind === 'pi.compaction' || kind === 'pi.reset' || kind === 'helmx.rewind') boundary = true
    }
    this.entryWatermark.set(id, watermark)
    // prev is always a mirror object ({} fallback on adopt) while raw live defaults to {}, preventing false diffs on initial empty snapshots.
    if (boundary || compactionLiveKeyOf(prev) !== compactionLiveKeyOf(live ?? {})) {
      this.schedule(id)
    }
  }

  /** On stopObserving: clear cache/fingerprint/dirty/watermark and wake waiters (so they check missing cache and exit);
   * intentionally keep pending intact so in-flight refreshes clean up in finally while late results drop via generation guard. */
  clearConversation(conversationId: number): void {
    this.cache.delete(conversationId)
    this.keys.delete(conversationId)
    this.dirty.delete(conversationId)
    this.notifyInitial.delete(conversationId)
    this.entryWatermark.delete(conversationId)
    const waiters = this.waiters.get(conversationId)
    if (waiters !== undefined) {
      this.waiters.delete(conversationId)
      for (const resolve of waiters) resolve()
    }
  }

  /** Single refresh: read real ContextView + model context window + live compaction state; publish only if changed. */
  private async refreshOnce(conversationId: number): Promise<void> {
    const meta = this.host.store.getConv(conversationId)
    if (!meta) return
    // Generation guard: captured before await (also catches unobserved = undefined); concurrent re-observe or
    // stopObserving changes it so stale completions discard cleanly.
    const generation = this.host.generationOf(conversationId)
    const conversation = await this.host.harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
    if (!conversation) return
    const view = await conversation.context(BACKGROUND_CONTEXT)
    if (this.host.generationOf(conversationId) !== generation) return
    // Conversation may have been deleted while awaiting: never resurrect cache or emit events.
    if (!this.host.store.getConv(conversationId)) return
    this.apply(conversationId, meta, view)
  }

  /** Apply refreshed result: assemble -> compare fingerprint -> cache + publish (never advances stateChangeSeq). */
  private apply(conversationId: number, meta: ConvMeta, view: ContextView): void {
    const live = this.host.liveOf(conversationId)
    const slash = meta.model.indexOf('/')
    const models = this.host.modelsOf()
    const model =
      slash > 0 && slash < meta.model.length - 1 && models !== undefined
        ? models.getModel(meta.model.slice(0, slash), meta.model.slice(slash + 1))
        : undefined
    // Honest window reporting: omit contextWindow when model isn't in Models or only carries an unverified fallback
    // (e.g. compat gateway / Magpie without upstream window, helmxContextWindowKnown === false)—never fake 128k defaults.
    const contextWindow = knownContextWindowOf(model)
    const compacting = compactingOf(live?.compactions)
    const usage = assembleContextUsage({
      estimate: estimateContextUsage(view),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(compacting !== undefined ? { compacting } : {}),
    })
    const key = contextUsageKeyOf(usage)
    const previous = this.cache.get(conversationId)
    const previousKey = this.keys.get(conversationId)
    const shouldPublishInitial = this.notifyInitial.delete(conversationId)
    // Update cache first so immediate HTTP / SSE snapshot reads observe the latest values.
    this.cache.set(conversationId, usage)
    this.keys.set(conversationId, key)
    // Initial populate on startup stays silent to avoid N-conversation frame bursts, except when compacting=true on
    // initial hydrate or when an explicit on-demand trigger (detail open / post-turn settle) requested initial notification.
    if (previousKey === undefined) {
      if (usage.compacting !== undefined || shouldPublishInitial) {
        this.host.onSummaryChanged(this.host.summaryOf(conversationId))
      }
      return
    }
    if (key === previousKey) return
    // While a run is active, publish only compacting or contextWindow changes; intermediate token updates attach at
    // turn settlement (emitSettled) instead of spamming summaries per token. Window changes reflect semantic catalog/model
    // shifts and must emit immediately without advancing stateChangeSeq.
    if (this.host.liveOf(conversationId)?.run !== undefined) {
      const compactionChanged = (previous?.compacting ?? null) !== (usage.compacting ?? null)
      const windowChanged = (previous?.contextWindow ?? null) !== (usage.contextWindow ?? null)
      if (!compactionChanged && !windowChanged) return
    }
    // Publish summary with updated usage without advancing stateChangeSeq—stateChangeSeq belongs strictly to state
    // machine / doing / Ask CAS semantics so display refreshes never trigger spurious 409/superseded conflicts.
    this.host.onSummaryChanged(this.host.summaryOf(conversationId))
  }
}
