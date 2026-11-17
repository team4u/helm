/**
 * EventHub: event bus with globally persisted seq + SSE snapshot/incremental streams.
 *
 * Semantics (per design doc §1.2):
 * - seq increases monotonically and is persisted (helm_seq), never regressing across restarts; publish strictly orders
 *   assemble+redact -> encode -> persist nextSeq -> advance in-memory watermark -> append to ring -> broadcast;
 *   if any step fails, the watermark never advances and no partial state remains (never creates a bare seq gap without a ring entry);
 * - Each instance generates a random bootId (event epoch): both `?afterSeq` and `?bootId` credentials must validate before
 *   allowing short-disconnect resumption (initial `resumed` frame + ring replay + live delta, strictly zero duplicates/drops);
 *   cross-epoch, out-of-range (future) seq, or ring gaps always fall back to full snapshot sync rather than skipping gaps
 *   under false success; malformed query parameters (non-non-negative safe integer / length out of range / single credential) fail with 400;
 * - Resume ring: stores immutable SSE bytes encoded once at publish time (shared by live subscribers and replay so subscribers cannot
 *   tamper with replay data and without duplicating the SQLite event table); bounded by both frame count and bytes
 *   (default 1024 frames / 4 MiB, evicting oldest from head); a single frame exceeding the byte budget clears the ring so no client can
 *   resume across it; replay flushes incrementally via ReadableStream.pull at consumer pace instead of stuffing the queue inside start
 *   (fast consumers are never killed by the pending-byte limit; new frames arriving during flush count separately toward slow-consumer budget);
 * - Keeps publish and subscribe names (apps call kernel.events.publish(type, payload));
 * - response(request): standard SSE—subscribe+buffer first, then take synchronous snapshot (or ring+headSeq), emit initial
 *   `event: snapshot` (HelmSnapshot with bootId) or `event: resumed` (HelmResumedFrame), then frame-by-frame `event: <type>` + `data: {seq,event}`;
 *   both Request.signal abort and ReadableStream.cancel unsubscribe and close the stream; stays open as a pure live stream when idle;
 * - sseStream(consume): programmatic consumer API (same snapshot-first semantics), returning an unsubscribe handle;
 *   if consumer returns false or throws, that subscription is isolated and cleaned up without affecting others;
 * - Payload boundary validation/assembly lives in event-validation.ts (pure functions); SSE encoding and byte backpressure
 *   primitives live in sse-stream.ts (shared with SessionDocEventHub);
 * - Unknown types pass through verbatim as CustomHelmEvent {type, payload} without masquerading as notifications;
 * - Bounded backpressure: exceeding pending frame/byte caps flags a slow client and closes the stream explicitly (client reconnects
 *   with snapshot to resync), never dropping frames silently; snapshot providers are synchronous, needing no async snapshot system.
 */

import { randomUUID } from 'node:crypto'
import { encodeSessionDocSubParam, HelmError } from '@helm/protocol'
import type {
  ConversationLive,
  ConversationSummary,
  HelmEvent,
  HelmEventFrame,
  HelmResumedFrame,
  HelmSnapshot,
  HelmTransientLiveFrame,
  MaybePromise,
  PublicPluginSessionDoc,
  SessionDocMultiplexAction,
  SessionDocMultiplexFrame,
  SessionDocSubscription,
} from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import {
  assembleHelmEvent,
  assertSessionDocUpdateShape,
  pruneUndefined,
  validateAndRedactConversationLive,
} from './event-validation.js'
import { byteBoundedWrite, closeControllerQuietly, encodeSseChunk, KEEPALIVE_CHUNK, sseResponse } from './sse-stream.js'

/**
 * Snapshot provider: omits bootId (injected by the EventHub instance as single source of truth);
 * seq is the provider-side known watermark, resolved via max against the hub's current seq.
 */
export type SnapshotProvider = () => Omit<HelmSnapshot, 'bootId'>

interface EventSubscription {
  unsubscribe(): void
}

/** Result of a single publish delivery. */
interface EventPublishResult {
  /** Validated and redacted event frame for this publish (already in SSE ring and broadcast). */
  readonly frame: HelmEventFrame
  /** Internal host listener delivery promise/result (once; undefined if not installed). Callers can await
   * when needed (public emitEvent contract) or fire-and-forget on kernel auto-events (trackers, etc.,
   * where errors per listener are isolated internally and the returned promise never rejects). */
  readonly internal: MaybePromise<void> | undefined
}

/** SSE output frame: initial snapshot/resumed control frame or incremental {seq, event}. */
export type SseFrame = HelmSnapshot | HelmEventFrame

/** Resume ring entry: immutable SSE bytes encoded at publish time (prevents subscriber mutation of replay data). */
interface RingEntry {
  seq: number
  chunk: Uint8Array
}

/** Event dispatched internally to plugin host listeners (`HelmEvent` plus transient `conversation.live`). */
export type HostDispatchedEvent =
  | HelmEvent
  | { type: 'conversation.live'; live: ConversationLive }

/** Internal host event dispatcher installed by `KernelRuntime`. */
type HostEventDispatcher = (event: HostDispatchedEvent) => MaybePromise<void>

/** Max pending frames buffered between subscription setup and snapshot flush (overflow flags slow client and closes stream to reconnect). */
const MAX_PENDING_EVENTS = 512

/** Default resume ring capacity: 1024 frames / 4 MiB bytes (evicts oldest entries from head when exceeded). */
const DEFAULT_RING_MAX_FRAMES = 1024
const DEFAULT_RING_MAX_BYTES = 4 * 1024 * 1024

/** Max unread bytes during streaming phase (default 1 MiB, overridable via maxPendingBytes, e.g. small values in tests). */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

/** SSE idle heartbeat interval (default 15s; comment lines go through unified byte backpressure; overridable via keepaliveMs in tests). */
const DEFAULT_KEEPALIVE_MS = 15_000

export class EventHub {
  private seqValue: number
  /** Event epoch identifier (generated randomly per instance): one of the two resume credentials; seq is contiguous only within the same epoch. */
  readonly bootId: string
  /** Resume ring (contiguous seq range evicted from head; cleared if a single frame exceeds budget so nobody resumes across it). */
  private readonly ring: RingEntry[] = []
  private ringBytes = 0
  private readonly ringMaxFrames: number
  private readonly ringMaxBytes: number
  private readonly subscribers = new Set<(frame: HelmEventFrame, chunk: Uint8Array) => void>()
  /** Connected `/api/events` SSE stream transient live senders (excluded from durable `subscribers` / `seq` / `ring`). */
  private readonly transientStreamSenders = new Set<(chunk: Uint8Array) => void>()
  /** Programmatic transient `conversation.live` listeners (never consume durable `seq`). */
  private readonly transientListeners = new Set<(frame: HelmTransientLiveFrame) => void>()
  /** Latest active live views per conversation (reconciled into `HelmResumedFrame.conversationLives`). */
  private readonly latestLives = new Map<number, ConversationLive>()
  /** Internal host event dispatcher (installed by runtime; invoked once per publish as the single dispatch boundary). */
  private hostDispatcher: HostEventDispatcher | undefined
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  private readonly streamClosers = new Set<() => void>()
  private readonly maxPendingBytes: number
  /** SSE idle heartbeat interval (disabled if <= 0); comment lines keep proxies/intermediaries alive and let clients detect stalls. */
  private readonly keepaliveMs: number
  /** redact(text) -> redacted text (secret plaintext -> marker; reused recursively by redactJsonValue). */
  redact: (text: string) => string = (t) => t

  set redactFn(fn: (text: string) => string) {
    this.redact = fn
  }

  constructor(options: {
    initialSeq: number
    snapshot: SnapshotProvider
    persistSeq?: (seq: number) => void
    /** Unread byte cap during streaming (slow client threshold); defaults to 1 MiB. */
    maxPendingBytes?: number
    /** SSE idle heartbeat interval (ms); defaults to 15s, <= 0 disables (use small values to speed up tests). */
    keepaliveMs?: number
    /** Event epoch ID (random UUID by default; injectable in tests). */
    bootId?: string
    /** Resume ring frame capacity; defaults to 1024 (tunable in tests to verify eviction). */
    ringMaxFrames?: number
    /** Resume ring byte capacity; defaults to 4 MiB (tunable in tests to verify eviction). */
    ringMaxBytes?: number
  }) {
    this.seqValue = options.initialSeq
    this.bootId = options.bootId ?? randomUUID()
    this.snapshot = options.snapshot
    this.persistSeq = options.persistSeq ?? (() => {})
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
    this.ringMaxFrames = options.ringMaxFrames ?? DEFAULT_RING_MAX_FRAMES
    this.ringMaxBytes = options.ringMaxBytes ?? DEFAULT_RING_MAX_BYTES
  }

  get seq(): number {
    return this.seqValue
  }

  /** Number of currently active subscribers (for diagnostics and tests). */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** Clear all subscriptions (called on kernel.close to eliminate subscriber leaks). */
  close(): void {
    for (const stop of [...this.streamClosers]) stop()
    this.subscribers.clear()
    this.transientStreamSenders.clear()
    this.transientListeners.clear()
    this.latestLives.clear()
    this.hostDispatcher = undefined
  }

  /**
   * Install the internal host event dispatcher (single dispatch boundary for ctx.host.onEvent listeners):
   * invoked exactly once after SSE broadcast per publish with the validated+redacted HelmEvent envelope
   * (matching protocol onEvent contract). Must return synchronously (may return a promise) and never throw
   * (listener errors are isolated internally), avoiding false errors after broadcast has already succeeded.
   */
  setHostDispatcher(dispatch: HostEventDispatcher): void {
    this.hostDispatcher = dispatch
  }

  /**
   * Publish an event (strict ordering: assemble+redact -> encode -> persist -> advance memory -> ring -> broadcast
   * -> internal host dispatch). Failures in buildEvent/persistSeq throw without advancing the watermark, appending to
   * the ring, or broadcasting—persistence errors never leave a bare seq gap (otherwise the next successful publish would
   * create a gap in the ring and break resume). Each frame is encoded once (immutable bytes), shared by ring replay and all subscribers.
   *
   * Returns the emitted frame and internal host listener dispatch (exactly once): callers needing to await async internal listeners
   * (public emitEvent) await `internal`; kernel auto-events (trackers, etc.) ignore the return value (fire-and-forget) so synchronous
   * observation paths (e.g., SDK callbacks) are never blocked.
   */
  publish(type: string, payload: unknown): EventPublishResult {
    const nextSeq = this.seqValue + 1
    const event = this.buildEvent(type, payload)
    const frame: HelmEventFrame = { seq: nextSeq, event }
    // V8 cannot freeze non-empty TypedArray views; immutability is guaranteed structurally: the ring only retains these isolated
    // encoded bytes (never sharing mutable event object graphs with subscribers), and all internal consumers (ring replay /
    // controller.enqueue) treat them as read-only.
    const chunk = encodeSseChunk(String(event.type), frame)
    this.persistSeq(nextSeq)
    this.seqValue = nextSeq
    this.pushRing(nextSeq, chunk)
    this.reconcileLatestLivesOnDurableEvent(event)
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame, chunk)
      } catch {
        // Isolate errors from individual subscriber callbacks (cleanup is handled per-subscriber) without impacting others.
      }
    }
    return { frame, internal: this.hostDispatcher?.(event) }
  }

  /**
   * Publish a transient `conversation.live` frame without touching `seqValue`, `persistSeq`,
   * or the durable replay ring buffer. Validates and redacts the live view, updates
   * `latestLives` for `resumed` reconciliation, broadcasts `event: conversation.live`
   * directly to connected `/api/events` SSE clients, and dispatches `{ type: 'conversation.live', live }`
   * synchronously to the internal host dispatcher (`ctx.host.onEvent`).
   */
  publishTransientLive(live: ConversationLive): MaybePromise<void> | undefined {
    const validated = validateAndRedactConversationLive(live, (t) => this.redact(t))
    if (isActiveLiveView(validated)) {
      this.latestLives.set(validated.conversationId, validated)
    } else {
      this.latestLives.delete(validated.conversationId)
    }
    const frame: HelmTransientLiveFrame = { live: validated }
    const chunk = encodeSseChunk('conversation.live', frame)
    for (const send of [...this.transientStreamSenders]) {
      try {
        send(chunk)
      } catch {
        // isolate broken stream sender (stream cleanup already ran on shutdown)
      }
    }
    for (const listen of [...this.transientListeners]) {
      try {
        listen(frame)
      } catch {
        // isolate broken programmatic listener
      }
    }
    return this.hostDispatcher?.({ type: 'conversation.live', live: validated })
  }

  /** Subscribe to transient `conversation.live` frames (test / in-process consumption). */
  subscribeTransientLive(listener: (frame: HelmTransientLiveFrame) => void): () => void {
    this.transientListeners.add(listener)
    return () => {
      this.transientListeners.delete(listener)
    }
  }

  private reconcileLatestLivesOnDurableEvent(event: HelmEvent): void {
    if (event.type === 'conversation.upsert' && 'conversation' in event) {
      const conv = event.conversation as ConversationSummary
      if (conv.status !== 'working' && conv.status !== 'blocked') {
        const existing = this.latestLives.get(conv.id)
        if (existing !== undefined) {
          if ((existing.queuedInputs?.length ?? 0) > 0) {
            this.latestLives.set(conv.id, {
              conversationId: existing.conversationId,
              text: '',
              tools: [],
              queuedInputs: existing.queuedInputs,
              updatedAt: existing.updatedAt,
            })
          } else {
            this.latestLives.delete(conv.id)
          }
        }
      }
    } else if (event.type === 'conversation.deleted' && 'conversationId' in event) {
      this.latestLives.delete((event as { conversationId: number }).conversationId)
    }
  }

  /** Append to ring: if non-contiguous (defensive guard against any bare seq gap), drop stale segments and rebuild
   * from this frame; evict oldest entries from head when exceeding frame/byte limits; clear the ring if a single frame exceeds
   * the byte budget so no client can resume across it (better to fall back to snapshot than silently skip gaps). */
  private pushRing(seq: number, chunk: Uint8Array): void {
    const last = this.ring[this.ring.length - 1]
    if (last !== undefined && last.seq + 1 !== seq) {
      this.ring.length = 0
      this.ringBytes = 0
    }
    const bytes = chunk.byteLength
    if (bytes > this.ringMaxBytes) {
      this.ring.length = 0
      this.ringBytes = 0
      return
    }
    this.ring.push({ seq, chunk })
    this.ringBytes += bytes
    while (this.ring.length > this.ringMaxFrames || this.ringBytes > this.ringMaxBytes) {
      const evicted = this.ring.shift()
      if (evicted === undefined) break
      this.ringBytes -= evicted.chunk.byteLength
    }
  }

  /** Return the current snapshot (reused by HTTP GET and SSE initial frame) after pruning undefineds and applying
   * recursive redaction, injecting this instance's bootId as the single source of truth for the event epoch. */
  currentSnapshot(): HelmSnapshot {
    const snap = this.snapshot()
    const redacted = redactJsonValue(pruneUndefined(snap, new WeakSet()), (t) => this.redact(t)) as HelmSnapshot
    return { ...redacted, seq: Math.max(snap.seq, this.seqValue), bootId: this.bootId }
  }

  /** Subscribe to incremental frames; returns an unsubscribe function (HTTP layer consumes response(); this entrypoint serves programmatic callers and tests). */
  subscribe(listener: (frame: HelmEventFrame) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * Programmatic SSE stream: registers a buffered subscription first, then captures a snapshot; after emitting the snapshot,
   * flushes buffered frames with seq > snapshot.seq. Unsubscribes cleanly before finishing/rethrowing if the consumer returns
   * false/throws or if snapshot fails, preventing subscriber leaks.
   */
  sseStream(consume: (frame: SseFrame) => boolean | void): EventSubscription {
    const handle = this.openStream((frame) => consume(frame) !== false)
    let snap: HelmSnapshot
    try {
      snap = this.currentSnapshot()
    } catch (error) {
      handle.unsubscribe()
      throw error
    }
    try {
      if (consume(snap) === false) {
        handle.unsubscribe()
        return { unsubscribe: handle.unsubscribe }
      }
    } catch {
      handle.unsubscribe()
      return { unsubscribe: handle.unsubscribe }
    }
    handle.goLive(snap.seq)
    return { unsubscribe: handle.unsubscribe }
  }

  /**
   * HTTP SSE response: returns Response immediately; initial frame is `snapshot` (or `resumed`), followed by incremental seq frames.
   * When `?afterSeq` and `?bootId` both validate, emits `resumed` first and replays ring-cached frames by seq;
   * cross-epoch, future seq, or cache gaps fall back to snapshot; malformed credentials return 400 explicitly.
   * Replay bytes are NOT stuffed into start all at once (which would hit the 1 MiB pending cap before pull drains and falsely kill
   * fast consumers); instead they enter the flush queue drained step-by-step via pull at consumer pace, while live frames arriving
   * mid-flush count against the slow-consumer budget separately (replay entries reference shared ring bytes with 0 double-counting).
   * Closes and unsubscribes on request.signal abort or ReadableStream.cancel; stays open when idle without falling back to JSON;
   * writes `: keepalive` comment lines every keepaliveMs during idle periods (started after flush finishes; heartbeats flow through
   * unified byte backpressure and stop on abort/cancel/close).
   */
  response(request: Request): Response {
    const query = EventHub.parseResumeQuery(request)
    if (query.error !== undefined) {
      // Strict boundary check: malformed resume credentials fail with 400 rather than being silently ignored or partially applied.
      return new Response(JSON.stringify({ error: { code: 'invalid_input', message: query.error } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    /** Flush queue item: either a replay reference (shared ring bytes) or a live frame/heartbeat arriving mid-flush. */
    interface OutboundEntry {
      chunk: Uint8Array
      /** Bytes counted against slow-consumer budget (0 for replay references to avoid double-counting ring memory). */
      liveBytes: number
    }

    let outbound: OutboundEntry[] = []
    let outboundLiveBytes = 0
    /** True while flushing replay/backlog: business bytes go solely through the flush queue drained step-by-step by pull. */
    let flushing = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined

    const write = (chunk: Uint8Array): boolean =>
      byteBoundedWrite(controllerRef, closed, chunk, this.maxPendingBytes)

    /** Enqueue a frame/heartbeat arriving during flush onto the tail (preserves strict byte ordering and charges slow-consumer budget). */
    const pushOutbound = (chunk: Uint8Array): boolean => {
      if (outboundLiveBytes + chunk.byteLength > this.maxPendingBytes) return false
      outboundLiveBytes += chunk.byteLength
      outbound.push({ chunk, liveBytes: chunk.byteLength })
      return true
    }

    const shutdown = (): void => {
      if (closed) return
      closed = true
      if (keepaliveTimer !== undefined) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = undefined
      }
      this.transientStreamSenders.delete(sendTransientChunk)
      request.signal.removeEventListener('abort', shutdown)
      unsubscribe?.()
      unsubscribe = undefined
      const controller = controllerRef
      controllerRef = undefined
      closeControllerQuietly(controller)
    }

    const sendTransientChunk = (chunk: Uint8Array): void => {
      if (closed) return
      const ok = flushing ? pushOutbound(chunk) : write(chunk)
      if (!ok) shutdown()
    }

    const startKeepalive = (): void => {
      // Idle heartbeat: SSE comment line (leading `:`), ignored by parsers, never fabricates business events or advances seq;
      // goes through unified write backpressure so slow/stalled readers that don't drain are closed cleanly.
      if (keepaliveTimer !== undefined || closed) return
      keepaliveTimer = startKeepaliveInterval(this.keepaliveMs, write, shutdown)
    }

    // Subscribe first, then sample synchronously (within the same microtask, buffering prevents missed frames); snapshot errors throw synchronously to HTTP.
    const handle = this.openStream(
      (frame, chunk) => {
        if (closed) return false
        // Frames arriving mid-flush queue after replay (strict byte order); once flushed, switch to direct write with byte backpressure.
        if (flushing) return pushOutbound(chunk)
        return write(chunk)
      },
      shutdown,
    )
    unsubscribe = handle.unsubscribe

    const resume = query.resume
    let liveSeq: number
    let handshake: Uint8Array
    let replay: Uint8Array[] = []
    if (resume !== undefined && this.canResume(resume)) {
      // Resume: sample headSeq + ring slice (subscription is already live so subsequent publishes enter flush queue or direct write without a gap).
      liveSeq = this.seqValue
      const resumedFrame: HelmResumedFrame = {
        bootId: this.bootId,
        seq: resume.afterSeq,
        headSeq: liveSeq,
        conversationLives: [...this.latestLives.values()],
      }
      handshake = encodeSseChunk('resumed', resumedFrame)
      replay = this.ring.filter((entry) => entry.seq > resume.afterSeq).map((entry) => entry.chunk)
    } else {
      let snap: HelmSnapshot
      try {
        snap = this.currentSnapshot()
      } catch (error) {
        shutdown()
        throw error
      }
      liveSeq = snap.seq
      handshake = encodeSseChunk('snapshot', snap)
    }

    return sseResponse({
      start: (controller) => {
        // Without a byte Strategy at construction, controller is always the default controller (preserves original behavior).
        controllerRef = controller as ReadableStreamDefaultController<Uint8Array>
        if (closed) {
          // Closed before stream initialized (e.g., synchronous overflow in snapshot provider): close immediately.
          closeControllerQuietly(controllerRef)
          return
        }
        if (request.signal.aborted) {
          shutdown()
          return
        }
        request.signal.addEventListener('abort', shutdown)
        // Write handshake frame immediately (subject to byte budget); replay bytes are held out for pull-driven flushing
        // at consumer pace so consumers that haven't called pull yet don't hit the 1 MiB pending cap prematurely.
        if (!write(handshake)) {
          shutdown()
          return
        }
        outbound = replay.map((chunk) => ({ chunk, liveBytes: 0 }))
        flushing = outbound.length > 0
        // Flush buffered frames from subscription setup (seq > liveSeq): tail-queued during flush, or written directly.
        if (!handle.goLive(liveSeq)) return
        if (!closed) this.transientStreamSenders.add(sendTransientChunk)
        if (!flushing) startKeepalive()
      },
      pull: () => {
        if (closed || !flushing) return
        const entry = outbound.shift()
        if (entry === undefined) return
        outboundLiveBytes -= entry.liveBytes
        const controller = controllerRef
        if (controller === undefined) return
        // pull semantics: consumer already has a pending read, so enqueue satisfies it immediately without building unread backlog.
        try {
          controller.enqueue(entry.chunk)
        } catch {
          shutdown()
          return
        }
        if (outbound.length === 0) {
          flushing = false
          startKeepalive()
        }
      },
      cancel: () => {
        shutdown()
      },
    })
  }

  /** Parse `?afterSeq`/`?bootId` resume parameters: omitted means normal connection; when present, both must be paired,
   * unique, and well-formed (non-negative safe integer / 1..64 non-empty string). Malformed or duplicated params fail with 400
   * rather than partially resuming (URLSearchParams.get would silently ignore duplicate params, so reject explicitly via getAll). */
  private static parseResumeQuery(request: Request): { resume?: { afterSeq: number; bootId: string }; error?: string } {
    let params: URLSearchParams
    try {
      params = new URL(request.url).searchParams
    } catch {
      return { error: 'cannot parse request URL query parameters' }
    }
    const afterSeqAll = params.getAll('afterSeq')
    const bootIdAll = params.getAll('bootId')
    if (afterSeqAll.length > 1 || bootIdAll.length > 1) {
      return { error: '?afterSeq and ?bootId must not be specified multiple times' }
    }
    if (afterSeqAll.length === 0 && bootIdAll.length === 0) return {}
    if (afterSeqAll.length === 0 || bootIdAll.length === 0) {
      return { error: '?afterSeq and ?bootId must be provided together to resume' }
    }
    const afterSeqRaw = afterSeqAll[0]!
    const bootIdRaw = bootIdAll[0]!
    if (!/^\d{1,16}$/.test(afterSeqRaw) || !Number.isSafeInteger(Number(afterSeqRaw))) {
      return { error: 'afterSeq must be a non-negative safe integer' }
    }
    if (bootIdRaw.length === 0 || bootIdRaw.length > 64) {
      return { error: 'bootId must be a non-empty string of length 1..64' }
    }
    return { resume: { afterSeq: Number(afterSeqRaw), bootId: bootIdRaw } }
  }

  /** Eligibility for resumption: same epoch, not beyond headSeq, and when (afterSeq, headSeq] is non-empty, the ring must cover
   * the interval contiguously (first frame <= afterSeq+1, last frame === headSeq, consecutive +1 steps; linear scan is cheap over
   * <=1024 frames). Otherwise fall back to snapshot—a missing tail frame would leave the client stuck behind headSeq indefinitely
   * while keepalives keep the idle watchdog happy, so never issue a false `resumed`. Equal afterSeq == headSeq resumes with zero
   * replay frames, still requiring matching bootId. */
  private canResume(resume: { afterSeq: number; bootId: string }): boolean {
    if (resume.bootId !== this.bootId) return false
    const headSeq = this.seqValue
    if (resume.afterSeq > headSeq) return false
    if (resume.afterSeq >= headSeq) return true
    if (this.ring.length === 0) return false
    if (this.ring[0]!.seq > resume.afterSeq + 1) return false
    if (this.ring[this.ring.length - 1]!.seq !== headSeq) return false
    for (let i = 1; i < this.ring.length; i++) {
      if (this.ring[i]!.seq !== this.ring[i - 1]!.seq + 1) return false
    }
    return true
  }

  /**
   * Open an internal buffered subscription: buffers frames first (pairing frames with pre-encoded bytes to avoid re-encoding
   * on flush), then goLive(snapshotSeq) flushes newer buffered frames and switches to live delivery. If onFrame returns false
   * (write failure / overflow / consumer stop) or throws, unsubscribes immediately and invokes onStop.
   */
  private openStream(
    onFrame: (frame: HelmEventFrame, chunk: Uint8Array) => boolean,
    onStop?: () => void,
  ): { unsubscribe(): void; goLive(snapshotSeq: number): boolean } {
    let buffer: Array<{ seq: number; frame: HelmEventFrame; chunk: Uint8Array }> = []
    let live = false
    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      this.subscribers.delete(push)
      this.streamClosers.delete(stop)
      onStop?.()
    }
    const deliver = (frame: HelmEventFrame, chunk: Uint8Array): void => {
      let ok = false
      try {
        ok = onFrame(frame, chunk)
      } catch {
        ok = false
      }
      if (!ok) stop()
    }
    const push = (frame: HelmEventFrame, chunk: Uint8Array): void => {
      if (done) return
      if (!live) {
        if (buffer.length >= MAX_PENDING_EVENTS) {
          // Overflow while buffering during subscription setup (only possible if snapshot provider bursts synchronously): close explicitly.
          stop()
          return
        }
        buffer.push({ seq: frame.seq, frame, chunk })
        return
      }
      deliver(frame, chunk)
    }
    this.subscribers.add(push)
    this.streamClosers.add(stop)
    return {
      unsubscribe: stop,
      goLive(snapshotSeq: number): boolean {
        if (done) return false
        live = true
        for (const item of buffer) {
          if (item.seq <= snapshotSeq) continue
          deliver(item.frame, item.chunk)
          if (done) return false
        }
        buffer = []
        return true
      },
    }
  }

  /** Assemble + validate + redact (delegates to pure helpers in event-validation.ts with instance redactor). */
  private buildEvent(type: string, payload: unknown): HelmEvent {
    return assembleHelmEvent(type, payload, (t) => this.redact(t))
  }
}

/** Initial frame for a session-doc subscription: {seq, doc}; read atomically via synchronous HTTP provider. */
interface SessionDocSnapshot {
  seq: number
  doc: PublicPluginSessionDoc
}

interface SessionDocStreamEntry {
  targets: ReadonlyArray<{ pluginId: string; name: string; conversationId: number }>
  stop: () => void
}

/** Pending frame buffered during snapshot collection (retains seq so flush emits only frames with seq > snapshot.seq). */
interface SessionDocQueuedFrame {
  seq: number
  chunk: Uint8Array
}

interface SessionDocMultiplexQueuedFrame {
  key: string
  seq: number
  chunk: Uint8Array
}

function isActiveLiveView(live: ConversationLive): boolean {
  return (
    live.text !== '' ||
    (live.thinking !== undefined && live.thinking !== '') ||
    live.tools.length > 0 ||
    live.generation !== undefined ||
    (live.queuedInputs?.length ?? 0) > 0
  )
}

function startKeepaliveInterval(
  keepaliveMs: number,
  write: (chunk: Uint8Array) => boolean,
  shutdown: () => void,
): ReturnType<typeof setInterval> | undefined {
  if (keepaliveMs <= 0) return undefined
  return setInterval(() => {
    if (!write(KEEPALIVE_CHUNK)) shutdown()
  }, keepaliveMs)
}

/**
 * SessionDocEventHub: dedicated event stream for conversation documents.
 *
 * plugin.session_doc.updated never enters global /api/events (prevents write amplification and cross-conversation leaks);
 * this hub dispatches updates for a (pluginId, name, conversationId) tuple exclusively to streams subscribed to that tuple.
 * Frame shape matches the global stream (HelmEventFrame {seq, event}), while seq uses its own monotonic counter;
 * the initial snapshot frame is fetched via response's synchronous provider (e.g., kernel.plugins.getPublicSessionDoc) right after
 * subscribing, guaranteeing an atomic window without dropped or duplicated frames between snapshot and first delta.
 *
 * Lifecycle: response registers each stream as (targets, stop); hub.close() shuts down all streams (closing ReadableStream
 * and unsubscribing); closeForPlugin / closeForConversation are driven by runtime listeners on core events
 * (plugin.changed enabled=false / conversation.deleted), purely event-driven with zero polling overhead.
 */
export class SessionDocEventHub {
  private seqValue = 0
  private readonly subscribers = new Map<string, Set<(frame: HelmEventFrame) => void>>()
  /** Close handles for each dedicated stream (used by close()/set-close; multiple connections to the same tuple register independently). */
  private readonly streams = new Set<SessionDocStreamEntry>()
  /** Max pending frames buffered between subscription setup and snapshot flush (overflow closes stream to reconnect). */
  private readonly maxPending = MAX_PENDING_EVENTS
  /** Unread byte cap during streaming (default 1 MiB; slow clients are closed explicitly rather than queued unboundedly). */
  private readonly maxPendingBytes: number
  /** SSE idle heartbeat interval (ms); defaults to 15s, <= 0 disables (for deterministic tests). */
  private readonly keepaliveMs: number
  private redactFn: (text: string) => string = (t) => t

  constructor(options: { maxPendingBytes?: number; keepaliveMs?: number } = {}) {
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS
  }

  set redact(fn: (text: string) => string) {
    this.redactFn = fn
  }

  get seq(): number {
    return this.seqValue
  }

  private static keyOf(doc: { pluginId: string; name: string; conversationId: number }): string {
    return `${doc.pluginId}\0${doc.name}\0${doc.conversationId}`
  }

  /** Number of currently active subscribers (actual listener count, for diagnostics and tests). */
  get subscriberCount(): number {
    let total = 0
    for (const set of this.subscribers.values()) total += set.size
    return total
  }

  /** Truly close all dedicated streams and clear subscribers (called on kernel.close to eliminate leaks). */
  close(): void {
    this.closeStreams(() => true)
    this.subscribers.clear()
  }

  /** Close all dedicated streams for a plugin (plugin disable/uninstall: plugin.changed enabled=false). */
  closeForPlugin(pluginId: string): void {
    this.closeStreams((entry) => entry.targets.some((t) => t.pluginId === pluginId))
  }

  /** Close all dedicated streams for a conversation (conversation deleted: conversation.deleted). */
  closeForConversation(conversationId: number): void {
    this.closeStreams((entry) => entry.targets.some((t) => t.conversationId === conversationId))
  }

  private closeStreams(match: (entry: SessionDocStreamEntry) => boolean): void {
    for (const entry of [...this.streams]) {
      if (match(entry)) entry.stop()
    }
  }

  /**
   * Publish a session document update: dispatches only to listeners subscribed to that tuple.
   * Validates shape (pure helper in event-validation.ts) + applies JSON redaction at boundary (same discipline as
   * EventHub.buildEvent); invalid payloads throw HelmError explicitly without advancing seq or falling back silently.
   */
  dispatch(payload: unknown): void {
    const clean = redactJsonValue(assertSessionDocUpdateShape(payload), (t) => this.redactFn(t)) as PublicPluginSessionDoc
    this.seqValue += 1
    const frame: HelmEventFrame = {
      seq: this.seqValue,
      event: { type: 'plugin.session_doc.updated', doc: clean },
    }
    const key = SessionDocEventHub.keyOf(clean)
    for (const deliver of [...(this.subscribers.get(key) ?? [])]) {
      try {
        deliver(frame)
      } catch {
        // Isolate subscriber callback throws without affecting other subscribers.
      }
    }
  }

  /**
   * Subscribe to incremental frames for a specific tuple; returns an unsubscribe function.
   * Matches EventHub.subscribe semantics: HTTP layer subscribes+buffers first, then captures a synchronous snapshot.
   */
  subscribe(
    doc: { pluginId: string; name: string; conversationId: number },
    listener: (frame: HelmEventFrame) => void,
  ): () => void {
    const key = SessionDocEventHub.keyOf(doc)
    let set = this.subscribers.get(key)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(listener)
    return () => {
      const cur = this.subscribers.get(key)
      if (cur === undefined) return
      cur.delete(listener)
      if (cur.size === 0) this.subscribers.delete(key)
    }
  }

  /**
   * Dedicated SSE response: initial `event: snapshot` (PluginSessionDocSnapshot {seq, doc}),
   * followed by incremental `event: plugin.session_doc.updated` + HelmEventFrame.
   *
   * Atomic window: registers buffered subscription first, then invokes synchronous options.snapshot provider
   * (provider also checks plugin/conversation existence; failures throw synchronously to HTTP), emits snapshot,
   * and flushes only buffered frames with seq > snapshot.seq—zero dropped or duplicated frames.
   * If provider fails or request is already aborted, unsubscribes synchronously without creating a stream.
   *
   * Backpressure & cleanup: buffered phase is bounded by MAX_PENDING_EVENTS, streaming phase by byte cap
   * (shared sse-stream primitive); overflowing closes the stream explicitly and unsubscribes (no unbounded queuing);
   * abort / cancel / hub close also shut down the stream cleanly. Reconnecting re-subscribes and resets snapshot (no cross-connection state).
   */
  response(
    request: Request,
    options: {
      /** Synchronous snapshot provider invoked after subscribing; returns {seq, doc} or throws synchronously. */
      snapshot: () => SessionDocSnapshot
      target: { pluginId: string; name: string; conversationId: number }
    },
  ): Response {
    /** Buffered frames arriving before snapshot flush completes (switches to byte backpressure afterward). */
    let pending: SessionDocQueuedFrame[] = []
    let streaming = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined

    const write = (chunk: Uint8Array): boolean =>
      byteBoundedWrite(controllerRef, closed, chunk, this.maxPendingBytes)

    /** Stream handle registered on shutdown; undefined during provider phase (delete is idempotent). */
    let streamEntry: SessionDocStreamEntry | undefined
    const shutdown = (): void => {
      if (closed) return
      closed = true
      if (keepaliveTimer !== undefined) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = undefined
      }
      request.signal.removeEventListener('abort', shutdown)
      unsubscribe?.()
      unsubscribe = undefined
      if (streamEntry !== undefined) this.streams.delete(streamEntry)
      const controller = controllerRef
      controllerRef = undefined
      closeControllerQuietly(controller)
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer !== undefined || closed) return
      keepaliveTimer = startKeepaliveInterval(this.keepaliveMs, write, shutdown)
    }

    // Subscribe+buffer first (same sync window as snapshot read so no frames are lost; buffered frames keep seq for deduplication).
    unsubscribe = this.subscribe(options.target, (frame) => {
      if (closed) return
      const chunk = encodeSseChunk('plugin.session_doc.updated', frame)
      if (streaming) {
        if (!write(chunk)) shutdown()
        return
      }
      if (pending.length >= this.maxPending) {
        // Backlog exceeded before snapshot flushed (only possible on synchronous burst in provider): close stream explicitly.
        shutdown()
        return
      }
      pending.push({ seq: frame.seq, chunk })
    })

    // Synchronous snapshot fetch (if provider fails or request aborted: unsubscribe synchronously without creating a stream or faking a snapshot).
    let snap: SessionDocSnapshot
    try {
      if (request.signal.aborted) throw new HelmError('aborted', 'request aborted before subscription was established', 499)
      snap = options.snapshot()
    } catch (error) {
      shutdown()
      throw error
    }
    const snapshotChunk = encodeSseChunk('snapshot', snap)
    streamEntry = { targets: [options.target], stop: shutdown }
    if (!closed) this.streams.add(streamEntry)

    return sseResponse({
      start: (controller) => {
        // Without a byte queuing strategy at construction, controller is always the default controller (preserves original behavior).
        controllerRef = controller as ReadableStreamDefaultController<Uint8Array>
        if (closed) {
          closeControllerQuietly(controllerRef)
          return
        }
        if (request.signal.aborted) {
          shutdown()
          return
        }
        request.signal.addEventListener('abort', shutdown)
        // Buffered subscription and snapshot are ready: emit snapshot first, then flush newer buffered frames
        // (frames with seq <= snapshot.seq are already reflected in the snapshot and skipped to avoid duplicates).
        if (!write(snapshotChunk)) {
          shutdown()
          return
        }
        streaming = true
        for (const frame of pending) {
          if (frame.seq <= snap.seq) continue
          if (!write(frame.chunk)) {
            shutdown()
            return
          }
        }
        pending = []
        startKeepalive()
      },
      cancel: () => {
        shutdown()
      },
    })
  }

  /**
   * Multiplexed SessionDoc SSE response: subscribes to a validated non-empty list
   * of `(pluginId, name, conversationId)` tuples over one SSE connection.
   *
   * - Subscribes to all targets first so concurrent dispatches during snapshot
   *   collection are buffered and deduplicated per tuple via `seq <= snapshot.seq`.
   * - Validates every tuple via `options.snapshot(sub)` before opening the stream
   *   (failing fast with `shutdown()` + rethrow when any target is disabled/unregistered/missing).
   * - Emits initial `SessionDocMultiplexFrame` (`action: 'snapshot'`) per target,
   *   followed by `'updated'` or `'deleted'` frames only for subscribed tuples,
   *   plus periodic `: keepalive` heartbeats (`keepaliveMs`, default 15s).
   */
  multiplexResponse(
    subs: readonly SessionDocSubscription[],
    request: Request,
    options: {
      snapshot: (sub: SessionDocSubscription) => SessionDocSnapshot
    },
  ): Response {
    if (!Array.isArray(subs) || subs.length === 0) {
      throw new HelmError('validation_error', 'session doc multiplex subscription requires at least one target', 400)
    }
    const seen = new Set<string>()
    const targets: SessionDocSubscription[] = []
    for (const sub of subs) {
      const canonical = encodeSessionDocSubParam(sub)
      if (seen.has(canonical)) {
        throw new HelmError('validation_error', `duplicate session doc subscription: ${canonical}`, 400)
      }
      seen.add(canonical)
      targets.push({ pluginId: sub.pluginId, name: sub.name, conversationId: sub.conversationId })
    }

    let pending: SessionDocMultiplexQueuedFrame[] = []
    let streaming = false
    let closed = false
    const unsubscribes: Array<() => void> = []
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined
    let streamEntry: SessionDocStreamEntry | undefined

    const write = (chunk: Uint8Array): boolean =>
      byteBoundedWrite(controllerRef, closed, chunk, this.maxPendingBytes)

    const shutdown = (): void => {
      if (closed) return
      closed = true
      if (keepaliveTimer !== undefined) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = undefined
      }
      request.signal.removeEventListener('abort', shutdown)
      while (unsubscribes.length > 0) {
        const unsub = unsubscribes.pop()
        unsub?.()
      }
      if (streamEntry !== undefined) this.streams.delete(streamEntry)
      const controller = controllerRef
      controllerRef = undefined
      closeControllerQuietly(controller)
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer !== undefined || closed) return
      keepaliveTimer = startKeepaliveInterval(this.keepaliveMs, write, shutdown)
    }

    for (const target of targets) {
      const key = SessionDocEventHub.keyOf(target)
      const unsub = this.subscribe(target, (frame) => {
        if (closed) return
        const doc = (frame.event as { doc: PublicPluginSessionDoc }).doc
        const action: SessionDocMultiplexAction = doc.deleted === true ? 'deleted' : 'updated'
        const multiplexFrame: SessionDocMultiplexFrame = {
          action,
          pluginId: target.pluginId,
          name: target.name,
          conversationId: target.conversationId,
          seq: frame.seq,
          doc,
        }
        const chunk = encodeSseChunk('session_doc', multiplexFrame)
        if (streaming) {
          if (!write(chunk)) shutdown()
          return
        }
        if (pending.length >= this.maxPending) {
          shutdown()
          return
        }
        pending.push({ key, seq: frame.seq, chunk })
      })
      unsubscribes.push(unsub)
    }

    const snapshotSeqs = new Map<string, number>()
    const snapshotChunks: Uint8Array[] = []
    try {
      if (request.signal.aborted) {
        throw new HelmError('aborted', 'request aborted before subscription was established', 499)
      }
      for (const target of targets) {
        const key = SessionDocEventHub.keyOf(target)
        const snap = options.snapshot(target)
        snapshotSeqs.set(key, snap.seq)
        const multiplexFrame: SessionDocMultiplexFrame = {
          action: 'snapshot',
          pluginId: target.pluginId,
          name: target.name,
          conversationId: target.conversationId,
          seq: snap.seq,
          doc: snap.doc,
        }
        snapshotChunks.push(encodeSseChunk('session_doc', multiplexFrame))
      }
    } catch (error) {
      shutdown()
      throw error
    }

    streamEntry = { targets, stop: shutdown }
    if (!closed) this.streams.add(streamEntry)

    return sseResponse({
      start: (controller) => {
        controllerRef = controller as ReadableStreamDefaultController<Uint8Array>
        if (closed) {
          closeControllerQuietly(controllerRef)
          return
        }
        if (request.signal.aborted) {
          shutdown()
          return
        }
        request.signal.addEventListener('abort', shutdown)
        for (const chunk of snapshotChunks) {
          if (!write(chunk)) {
            shutdown()
            return
          }
        }
        streaming = true
        for (const item of pending) {
          const snapSeq = snapshotSeqs.get(item.key) ?? -1
          if (item.seq <= snapSeq) continue
          if (!write(item.chunk)) {
            shutdown()
            return
          }
        }
        pending = []
        startKeepalive()
      },
      cancel: () => {
        shutdown()
      },
    })
  }
}
