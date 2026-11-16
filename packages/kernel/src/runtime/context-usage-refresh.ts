/**
 * conversation level contextUsage sync cache and async refresh chain (self conversations.ts split out).
 *
 * state two layer:
 * - sync can read cache (cache/keys/entryWatermark/waiters): follow stopObserving clean up
 *   (waiters first resolve again clean, guard against forever long suspended); late to refresh via observe proxy count guard discard;
 * - refresh chain lifecycle (pending/dirty): in-flight refresh can across exceeds stop observe (stopObserving do not clean
 *   pending- -finally fall back clean up, new trigger per common dirty append), therefore does not enter
 *   ConversationMirror(see conversation-mirror.ts exception manifest).
 *
 * frame discipline (migration before semantics original keep):
 * - first time fill static default (snapshot/HTTP read self however visible), unique exception: fill i.e. carry compacting
 *   must publish (otherwise subscribe way forever see fewer than the state);
 * - run leap during only compacting / contextWindow change frame (token instant state etc. compute frame);
 * - publish do not push enter stateChangeSeq(CAS watermark line dedicated belong, derive render data must not pollute).
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ContextView, ConversationView, Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConversationContextUsage, ConversationSummary } from '@helm/protocol'
import type { LiveStateShape } from './conversation-mirror.js'
import type { ConvMeta, HelmStore } from './store.js'
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

/** refresh chain for host (ConversationTracker) most small port. */
export interface ContextUsageHost {
  readonly harness: Harness
  readonly store: HelmStore
  /** summary push (conversation.upsert semantics frame). */
  onSummaryChanged(summary: ConversationSummary): void
  /** when before Models set now read (default do not parse:contextWindow omit, never fabricate). */
  modelsOf(): Models | undefined
  /** observe proxy count now read (late to refresh result discard decide). */
  generationOf(conversationId: number): symbol | undefined
  /** live mirror now read (compress state and run leap decide). */
  liveOf(conversationId: number): LiveStateShape | undefined
  /** right threat summary now read (publish frame construct; internal back read this module cache, do not shape into scheduling ring). */
  summaryOf(conversationId: number): ConversationSummary
  /** host closure stop guard (harness.close first row close after block assert for already close Harness without say refresh). */
  isClosing?(): boolean
  /** diagnose channel on report (default away defaultDiagnosticSink). */
  emitDiagnostic?: KernelDiagnosticEmitter
}

export class ContextUsageRefresh {
  /** conversation -> when before cache value (summaryOf sync read;undefined = not yet compute). */
  private readonly cache = new Map<number, ConversationContextUsage>()
  /** conversation -> most near once already publish refer grain (identical do not heavy conversation.upsert). */
  private readonly keys = new Map<number, string>()
  /** conversation -> context trigger already scan to most large entry id(independent push enter: without sink when also can dedupe). */
  private readonly entryWatermark = new Map<number, number>()
  /** conversation -> refresh chain settle wait for (ensureContextUsage wake use; stop observe fall back resolve). */
  private readonly waiters = new Map<number, Array<() => void>>()
  /** refresh in-flight conversation (guard against duplicate refresh; new trigger placement dirty await heavy run). */
  private readonly pending = new Set<number>()
  /** in-flight during receives new trigger signal conversation (after completion heavy run once). */
  private readonly dirty = new Set<number>()

  constructor(private readonly host: ContextUsageHost) {}

  /** sync read cache (do not scheduling). */
  peek(conversationId: number): ConversationContextUsage | undefined {
    return this.cache.get(conversationId)
  }

  /** already cache conversation manifest (onModelsChanged set to force complete target of one). */
  cachedConversationIds(): number[] {
    return [...this.cache.keys()]
  }

  /** sync read cache; missing when scheduling once background refresh (dedupe: in-flight placement dirty, already cache do not heavy run). */
  cachedOrSchedule(conversationId: number): ConversationContextUsage | undefined {
    const cached = this.cache.get(conversationId)
    if (cached !== undefined) return cached
    this.schedule(conversationId)
    return undefined
  }

  /** scheduling async context use amount refresh (fire-and-forget;observe call back inside sync invoke cannot await). */
  schedule(conversationId: number): void {
    if (this.host.isClosing?.()) return
    if (!this.host.store.getConv(conversationId)) return
    if (this.pending.has(conversationId)) {
      this.dirty.add(conversationId)
      return
    }
    this.pending.add(conversationId)
    void this.refreshOnce(conversationId)
      .catch((error: unknown) => {
        if (this.host.isClosing?.()) return
        // refresh failed such as record: cache keep old value (never static default fabricate), do not block assert observe main path.
        const event = {
          level: 'error' as const,
          source: 'tracker.context_usage',
          message: 'context use amount refresh failed',
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
        // in-flight during again has real change (new turn compute/compress/rewind): heavy run once force complete.
        if (this.dirty.delete(conversationId)) {
          this.schedule(conversationId)
        }
        // wake wait for way (ensureContextUsage): self row re- inspect cache/in-flight state decide return or continue etc..
        const waiters = this.waiters.get(conversationId)
        if (waiters !== undefined) {
          this.waiters.delete(conversationId)
          for (const resolve of waiters) resolve()
        }
      })
  }

  /** ensure the conversation contextUsage cache already fill and refresh chain archive silent (first detail situation read etc. sync visible path).
   *
   * - already cache and without in-flight refresh: immediately return (already cache page read zero overhead, does not repeat refresh);
   * - missing or in-flight: wait for refresh chain settle(many caller merge the same time refresh;dirty heavy run chain
   *   same wait for to archive silent, avoid cache already set but chain not completely when read to i.e. by force complete old value);
   * - each round wait for all by real refresh chain settleevent push enter (without polling without sleep); cap
   *   8 round only guard against defend illness state chain (continuous by proxy count guard discard and do not assert has new trigger).
   */
  async ensure(conversationId: number): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      if (this.cache.has(conversationId) && !this.pending.has(conversationId)) {
        return
      }
      if (!this.host.store.getConv(conversationId)) return
      if (!this.pending.has(conversationId)) {
        this.schedule(conversationId)
        // scheduling by refuse (conversation exactly by delete): no longer wait for, such as return.
        if (!this.pending.has(conversationId)) return
      }
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(conversationId) ?? []
        list.push(resolve)
        this.waiters.set(conversationId, list)
      })
    }
  }

  /** adoptInitial watermark line align: initial snapshot inside history mark record item (pi.compaction etc.)
   * does not trigger after continue adopt duplicate refresh (and lastEmittedEntry the same initial value source). */
  advanceWatermarkTo(conversationId: number, value: number): void {
    const current = this.entryWatermark.get(conversationId) ?? 0
    if (value > current) this.entryWatermark.set(conversationId, value)
  }

  /** context boundary scan: only exceeds old watermark line new item in appear pi.compaction /
   * pi.reset / helm.rewind, or pi.live compress state (compactions/compactionFailure)
   * refer grain change when only then trigger refresh. history mark record item does not repeat trigger (otherwise streaming during each time snapshot all
   * heavy scheduling, write put large); watermark line single tune push enter. independent watermark line (and onEntryCommitted without closure):
   * without entry sink observer same dedupe. */
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
      if (kind === 'pi.compaction' || kind === 'pi.reset' || kind === 'helm.rewind') boundary = true
    }
    this.entryWatermark.set(id, watermark)
    // prev constant is object mirror (live archive one is ?? {});live original doc missing when archive one is empty object,
    // avoid without pi.live doc snapshot first frame because undefined vs {} refer grain difference mistakenly trigger refresh.
    if (boundary || compactionLiveKeyOf(prev) !== compactionLiveKeyOf(live ?? {})) {
      this.schedule(id)
    }
  }

  /** stopObserving: clean cache/refer grain/dirty mark/watermark line and wake wait for (wake come after self inspect cache/
   * metadata and exit);pending moment intent keep (in-flight refresh finally fall back clean up, across exceeds stop observe
   * late to result via proxy count guard discard, does not resurrect). */
  clearConversation(conversationId: number): void {
    this.cache.delete(conversationId)
    this.keys.delete(conversationId)
    this.dirty.delete(conversationId)
    this.entryWatermark.delete(conversationId)
    const waiters = this.waiters.get(conversationId)
    if (waiters !== undefined) {
      this.waiters.delete(conversationId)
      for (const resolve of waiters) resolve()
    }
  }

  /** single time refresh: read real ContextView + model window + live compress state, change only then publish. */
  private async refreshOnce(conversationId: number): Promise<void> {
    const meta = this.host.store.getConv(conversationId)
    if (!meta) return
    // proxy count guard:await before catch; not observe (undefined) same reference and compare - - refresh during concurrency
    // observe(swap proxy)/stopObserving(delete token) all will change when before value, late to result discard.
    const generation = this.host.generationOf(conversationId)
    const conversation = await this.host.harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
    if (!conversation) return
    const view = await conversation.context(BACKGROUND_CONTEXT)
    if (this.host.generationOf(conversationId) !== generation) return
    // conversation may in await during by delete: late to result must not re- cache or event.
    if (!this.host.store.getConv(conversationId)) return
    this.apply(conversationId, meta, view)
  }

  /** should use refresh result: group install -> refer grain than for -> cache + publish (do not push enter stateChangeSeq). */
  private apply(conversationId: number, meta: ConvMeta, view: ContextView): void {
    const live = this.host.liveOf(conversationId)
    const slash = meta.model.indexOf('/')
    const models = this.host.modelsOf()
    const model =
      slash > 0 && slash < meta.model.length - 1 && models !== undefined
        ? models.getModel(meta.model.slice(0, slash), meta.model.slice(slash + 1))
        : undefined
    // window source honest: model do not in when before Models set, or window is static keep guard default
    // (compat gateway / Magpie directory missing upstream window,helmContextWindowKnown === false)
    // when does not carry contextWindow- - never 128k default smoke fill real window.
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
    // cache first row update:HTTP / SSE snapshot read immediately see to new value (event is otherwise another see under).
    this.cache.set(conversationId, usage)
    this.keys.set(conversationId, key)
    // first time fill by default static default: value via snapshot / HTTP read self however visible, do not event (avoid startup phase each
    // conversation one frame noise, dimension hold terminal state after without duplicate semantics frame since has frame discipline). unique exception:
    // fill when already carry compress in progress state (compacting, such as startup phase restore in progress compress, first time
    // refresh in manually compress window inside) must publish - - otherwise no any after continue semantics frame will carry it,
    // subscribe way forever see fewer than the state.
    if (previousKey === undefined) {
      if (usage.compacting !== undefined) {
        this.host.onSummaryChanged(this.host.summaryOf(conversationId))
      }
      return
    }
    if (key === previousKey) return
    // run leap during: only compress real-time state (compacting) and context window (contextWindow)
    // change only then frame;token change is instant state, etc. this turn compute frame carry (emitSettled additional
    // cache value), avoid working during duplicate doing semantics frame (frame discipline: do not one by one token 
    // summary). window change is directory refresh/model switch carries come semantics fact, is not one by one token noise,
    // must not static default to turn end; same do not push enter stateChangeSeq.
    if (this.host.liveOf(conversationId)?.run !== undefined) {
      const compactionChanged = (previous?.compacting ?? null) !== (usage.compacting ?? null)
      const windowChanged = (previous?.contextWindow ?? null) !== (usage.contextWindow ?? null)
      if (!compactionChanged && !windowChanged) return
    }
    // publish summary (carry new usage): do not push enter stateChangeSeq- - watermark line dedicated belong state machine/
    // doing/Ask  CAS semantics, derive render data must not pollute (otherwise pending Ask will by fake
    // superseded,guarded commit by fake 409). summary semantics refer grain excludes usage, no need to heavy register.
    this.host.onSummaryChanged(this.host.summaryOf(conversationId))
  }
}
