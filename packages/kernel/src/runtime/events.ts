/**
 * EventHub: global persist seq event total line + SSE snapshot/incremental stream.
 *
 * semantics (by design document §1.2):
 * - seq single tune pass increase and persist (helm_seq), restart does not fall back; publish strictly by group install redaction -> encode
 *   -> persist nextSeq -> push enter memory watermark ->  ring -> broadcast sort, any one step failed all do not
 *   push enter watermark, do not half into product (never produce without ring record bare seq missing opening);
 * - each instance random generate bootId(event proxy):`?afterSeq`+`?bootId` double credentials all validate via only then
 *   allows short disconnection resume (first frame resumed + ring patch + real-time incremental, strictly without duplicate without omission);
 *   across proxy,seq out of bounds (not come) or ring missing opening one rule fall back snapshot all amount align, never exceeds missing opening
 *   false succeeded; distortion shape query parameter (non- non- negative security integer/length over limit/single credentials) explicit 400;
 * - resume ring: save publish when encode once cannot change SSE byte (subscribe and replay sharing the same,
 *   guard against subscribe tamper replay data; do not duplicate SQLite event store), frame count/byte double cap (by default 256 frame /
 *   1 MiB) over limit from head eliminate; single frame over byte pre- compute i.e. empty ring, forbidden any client across the frame resume;
 *   replay via ReadableStream.pull by consumer rhythm one by one step conflict refresh, never in start inside once stuff full
 *   queue (fast consumer also do not by byte pre- compute mistakenly kill; conflict refresh during new reach frame another row count slow consumer pre- compute);
 * - publish and subscribe same name keep (app use kernel.events.publish(type, payload));
 * - response(request): standard SSE- - first subscribe buffer, again sync sampling (snapshot or ring+headSeq),
 *   first frame `event: snapshot`(HelmSnapshot, contains bootId) or `event: resumed`
 *   (HelmResumedFrame), then one by one frame `event: <type>` + `data: {seq,event}`;
 *   Request.signal abort and ReadableStream.cancel all unsubscribe closure stream; without event when keep connect (pure real-time stream);
 * - sseStream(consume): can edit process consume entry (same snapshot first row semantics), return unsubscribe handle;
 *   consumer return false or throws i.e. isolated the subscribe and clean up, does not affect other subscribe;
 * - payload boundary validate/group install in event-validation.ts(pure function);SSE encode and byte back press
 *   original language in sse-stream.ts(and SessionDocEventHub sharing);
 * - unknown type away CustomHelmEvent {type, payload} original pass-through, does not pretend to be into notification;
 * - back press has boundary: not decide frame count/byte count over cap treated as slow client, explicit closure stream (client rely on snapshot reconnect
 *   align), never static default lose frame; snapshot provider is sync, no need to async snapshot system.
 */

import { randomUUID } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type {
  HelmEvent,
  HelmEventFrame,
  HelmSnapshot,
  MaybePromise,
  PublicPluginSessionDoc,
} from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { assembleHelmEvent, assertSessionDocUpdateShape, pruneUndefined } from './event-validation.js'
import { byteBoundedWrite, closeControllerQuietly, encodeSseChunk, KEEPALIVE_CHUNK, sseResponse } from './sse-stream.js'

/**
 * snapshot content provider: excludes bootId(by EventHub instance inject, single one fact source),
 * seq is provider side known watermark, eventually with hub when before seq take most large is allow.
 */
export type SnapshotProvider = () => Omit<HelmSnapshot, 'bootId'>

export interface EventSubscription {
  unsubscribe(): void
}

/** single time publish delivery result. */
export interface EventPublishResult {
  /** this time publish already verify+redaction event frame (SSE ring already queue, broadcast already isolated complete). */
  readonly frame: HelmEventFrame
  /** internal host listener delivery (single time; not installed delivery when undefined). publish way on demand await
   *(public emitEvent contract); do not await i.e. fire-and-forget(kernel automatically event path,
   * delivery internal one by one listener isolated error, return promise never reject). */
  readonly internal: MaybePromise<void> | undefined
}

/** SSE output frame: first frame snapshot/resumed control frame or incremental {seq, event}. */
export type SseFrame = HelmSnapshot | HelmEventFrame

/** resume ring item: publish when encode cannot change SSE byte (guard against subscribe modify replay data). */
interface RingEntry {
  seq: number
  chunk: Uint8Array
}

/** subscribe establish to snapshot conflict refresh complete between not decide frame count cap (overflow i.e. slow client, closure stream reconnect). */
const MAX_PENDING_EVENTS = 512

/** resume ring by default cap:256 frame / 1 MiB byte (over limit from head trim). */
const DEFAULT_RING_MAX_FRAMES = 256
const DEFAULT_RING_MAX_BYTES = 1024 * 1024

/** streaming phase not read byte cap (by default 1 MiB, available maxPendingBytes override, test use small value). */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

/** SSE idle heartbeat interval (by default 15s; note release row away unify byte back press path, test available keepaliveMs override). */
const DEFAULT_KEEPALIVE_MS = 15_000

export class EventHub {
  private seqValue: number
  /** event proxy identifier (instance random generate): resume double credentials of one, same proxy inside seq only then connect continue can than. */
  readonly bootId: string
  /** resume ring(seq connect continue zone segment, from head eliminate; single frame over pre- compute i.e. empty forbid across frame resume). */
  private readonly ring: RingEntry[] = []
  private ringBytes = 0
  private readonly ringMaxFrames: number
  private readonly ringMaxBytes: number
  private readonly subscribers = new Set<(frame: HelmEventFrame, chunk: Uint8Array) => void>()
  /** internal host event delivery (runtime install; each time publish exactly invoke once, single one delivery boundary). */
  private hostDispatcher: ((event: HelmEvent) => MaybePromise<void>) | undefined
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  private readonly streamClosers = new Set<() => void>()
  private readonly maxPendingBytes: number
  /** SSE idle heartbeat interval (non- correct value deactivate); note release row let middle layer/proxy keep-alive and can by client detect card die. */
  private readonly keepaliveMs: number
  /** redact(text) -> redaction text (secret plaintext -> marker; re- use redactJsonValue recursion). */
  redact: (text: string) => string = (t) => t

  set redactFn(fn: (text: string) => string) {
    this.redact = fn
  }

  constructor(options: {
    initialSeq: number
    snapshot: SnapshotProvider
    persistSeq?: (seq: number) => void
    /** streaming phase not read byte cap (slow client decide); by default 1 MiB. */
    maxPendingBytes?: number
    /** SSE idle heartbeat interval (milli second); by default 15s, non- correct value deactivate (test use small value speed up). */
    keepaliveMs?: number
    /** event proxy identifier (by default random UUID; test can inject fixed value). */
    bootId?: string
    /** resume ring frame count cap; by default 256(test can tune small verify eliminate). */
    ringMaxFrames?: number
    /** resume ring byte cap; by default 1 MiB(test can tune small verify eliminate). */
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

  /** when before leap subscribe count (diagnose and test use). */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** empty all subscribe (kernel.close when invoke, eliminate subscribe leak leak). */
  close(): void {
    for (const stop of [...this.streamClosers]) stop()
    this.subscribers.clear()
    this.hostDispatcher = undefined
  }

  /**
   * install internal host event delivery (ctx.host.onEvent listen side single one delivery boundary): each time
   * publish in SSE broadcast after exactly invoke once, parameter is already verify+redaction complete HelmEvent
   * message seal (protocol onEvent contract shape). delivery must sync return (can return promise),
   * must not throw (listener error by delivery itself isolated), otherwise will break publish since has
   * error semantics (broadcast completed after again errors belongs to false failed).
   */
  setHostDispatcher(dispatch: (event: HelmEvent) => MaybePromise<void>): void {
    this.hostDispatcher = dispatch
  }

  /**
   * publish event (strictly order: group install redaction -> encode -> persist -> push enter memory ->  ring -> broadcast
   * -> internal host delivery).buildEvent/persistSeq failed all throw and do not push enter watermark, do not
   * ring, do not broadcast - - persist errors never under bare seq(otherwise under once succeeded publish will in ring in
   * shape into missing opening, resume when false promise). frame only encode once (cannot change byte),ring replay and all
   * subscribe sharing the same.
   *
   * return this time frame and internal host listener delivery (exactly once): need to wait for async internal listener
   * publish way (public emitEvent)await internal; kernel automatically event (tracker etc.) ignore
   * return i.e. fire-and-forget, never block publish point (such as SDK advance sync observe path).
   */
  publish(type: string, payload: unknown): EventPublishResult {
    const nextSeq = this.seqValue + 1
    const event = this.buildEvent(type, payload)
    const frame: HelmEventFrame = { seq: nextSeq, event }
    // V8 cannot freeze non-empty TypedArray view; cannot change by structure guarantee:ring only store this independent
    // encode byte (do not sharing event object diagram, subscribe change object change fewer than replay data), host inside all consume
    // path (ring replay / controller.enqueue) all only read, never back write.
    const chunk = encodeSseChunk(String(event.type), frame)
    this.persistSeq(nextSeq)
    this.seqValue = nextSeq
    this.pushRing(nextSeq, chunk)
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame, chunk)
      } catch {
        // subscribe way call back throws only isolated itself (each subscribe internal self row clean up), does not affect other subscribe.
      }
    }
    return { frame, internal: this.hostDispatcher?.(event) }
  }

  /** ring append: non- connect continue append(guard against defend: any way produce bare seq missing opening) first act abandon old zone segment,
   * from this frame rebuild; frame count/byte over limit from head eliminate keep connect continue; single frame over byte pre- compute i.e. empty,
   * forbidden any client across the frame resume (rather can fall back snapshot, do not exceeds missing opening false succeeded). */
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

  /** when before snapshot (supply HTTP GET and SSE first frame re- use); via prune + recursion redaction after return,
   * and inject instance bootId(event proxy single one fact source). */
  currentSnapshot(): HelmSnapshot {
    const snap = this.snapshot()
    const redacted = redactJsonValue(pruneUndefined(snap, new WeakSet()), (t) => this.redact(t)) as HelmSnapshot
    return { ...redacted, seq: Math.max(snap.seq, this.seqValue), bootId: this.bootId }
  }

  /** subscribe incremental frame; return unsubscribe function (HTTP layer only consume response, this entry supply edit process consume and test). */
  subscribe(listener: (frame: HelmEventFrame) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * SSE stream (can edit process consume): first create buffer subscribe, again take snapshot; first frame snapshot after conflict refresh seq > snapshot.seq
   * buffer frame. consumer return false or throws, snapshot failed all first unsubscribe again end/heavy throw, never leak leak subscribe.
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
   * HTTP SSE response: immediately return Response; first frame snapshot(or resume resumed), then by seq incremental.
   * `?afterSeq`+`?bootId` double credentials validate via then first frame change resumed and by seq patch ring cache frame;
   * across proxy/not come seq/cache missing opening one rule fall back snapshot; distortion shape credentials explicit 400.
   * replay byte do not via start once queue (consumer not yet pull will collide on 1 MiB queue up pre- compute, mistakenly kill fast
   * consumer), but rather unify enter conflict refresh queue by pull by consumer rhythm one by one step conflict refresh; conflict refresh during new reach
   * real-time frame count independent slow consumer pre- compute (replay reference sharing ring byte, does not repeat counter).
   * request.signal abort and ReadableStream.cancel all unsubscribe closure stream; without event when keep connect,
   * never fall back JSON; idle during by keepaliveMs cycle write `: keepalive` note release row (only in conflict refresh
   * after completion start, conflict refresh phase data itself stream motion; heartbeat away unify write back press path,abort/cancel/close
   * follow shutdown one and clean up timer).
   */
  response(request: Request): Response {
    const query = EventHub.parseResumeQuery(request)
    if (query.error !== undefined) {
      // boundary strong validate: distortion shape resume credentials explicit 400, never static default ignore or half resume.
      return new Response(JSON.stringify({ error: { code: 'invalid_input', message: query.error } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    /** conflict refresh queue item:replay reference (sharing ring byte) or conflict refresh during new reach frame/heartbeat. */
    interface OutboundEntry {
      chunk: Uint8Array
      /** count slow consumer pre- compute byte count (replay reference is 0, does not repeat counter ring memory). */
      liveBytes: number
    }

    let outbound: OutboundEntry[] = []
    let outboundLiveBytes = 0
    /** replay/accumulate press conflict refresh in: business byte only conflict refresh queue, by pull by consumer rhythm one by one step queue. */
    let flushing = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined

    const write = (chunk: Uint8Array): boolean =>
      byteBoundedWrite(controllerRef, closed, chunk, this.maxPendingBytes)

    /** conflict refresh during reach frame/heartbeat conflict refresh queue tail (keep strictly byte order; new byte count slow consumer pre- compute). */
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
      request.signal.removeEventListener('abort', shutdown)
      unsubscribe?.()
      unsubscribe = undefined
      const controller = controllerRef
      controllerRef = undefined
      closeControllerQuietly(controller)
    }

    const startKeepalive = (): void => {
      // idle heartbeat:SSE note release row (: open head), client parse ignore, never fabricate business event,
      // do not push enter seq; away unify write back press path (do not read slow consumer heap accumulate over limit same closure stream).
      if (this.keepaliveMs <= 0 || keepaliveTimer !== undefined || closed) return
      keepaliveTimer = setInterval(() => {
        if (!write(KEEPALIVE_CHUNK)) shutdown()
      }, this.keepaliveMs)
    }

    // first subscribe again sync sampling (same microtask inside complete, buffer do not lose frame); snapshot failed sync throw to HTTP layer.
    const handle = this.openStream(
      (frame, chunk) => {
        if (closed) return false
        // conflict refresh during reach frame arrange in replay after (strictly byte order); conflict refresh completely rotate streaming direct write (byte back press take over).
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
      // resume: sampling headSeq + ring cut piece (subscribe already establish, this after publish enter conflict refresh queue/direct write, without window).
      liveSeq = this.seqValue
      handshake = encodeSseChunk('resumed', { bootId: this.bootId, seq: resume.afterSeq, headSeq: liveSeq })
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
        // without byte policy when runtime must is by default control (original inline construct the same fact).
        controllerRef = controller as ReadableStreamDefaultController<Uint8Array>
        if (closed) {
          // close occur in stream establish before (such as snapshot provider sync heavy overflow): immediately closure stream.
          closeControllerQuietly(controllerRef)
          return
        }
        if (request.signal.aborted) {
          shutdown()
          return
        }
        request.signal.addEventListener('abort', shutdown)
        // grasp manually frame directly write (subject to byte pre- compute constraint); replay byte never in this queue - - to pull
        // by consumer rhythm one by one step conflict refresh, avoid consumer not yet pull then collide full 1 MiB queue up pre- compute.
        if (!write(handshake)) {
          shutdown()
          return
        }
        outbound = replay.map((chunk) => ({ chunk, liveBytes: 0 }))
        flushing = outbound.length > 0
        // conflict refresh subscribe buffer (seq > liveSeq frame): conflict refresh in conflict refresh queue tail, otherwise direct write.
        if (!handle.goLive(liveSeq)) return
        if (!flushing) startKeepalive()
      },
      pull: () => {
        if (closed || !flushing) return
        const entry = outbound.shift()
        if (entry === undefined) return
        outboundLiveBytes -= entry.liveBytes
        const controller = controllerRef
        if (controller === undefined) return
        // pull semantics: consumer already hold has pending read, this time queue directly satisfy read, do not heap accumulate queue up pre- compute.
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

  /** parse `?afterSeq`/`?bootId` resume query: does not carry i.e. ordinary connect; carry then must into for, do not
   * duplicate and shape legal (non- negative security integer / length 1..64 non-empty string), distortion shape/duplicate explicit 400,
   * never half resume (URLSearchParams.get will swallow duplicate parameter, duplicate i.e. reject). */
  private static parseResumeQuery(request: Request): { resume?: { afterSeq: number; bootId: string }; error?: string } {
    let params: URLSearchParams
    try {
      params = new URL(request.url).searchParams
    } catch {
      return { error: 'cannot parse request URL query parameter' }
    }
    const afterSeqAll = params.getAll('afterSeq')
    const bootIdAll = params.getAll('bootId')
    if (afterSeqAll.length > 1 || bootIdAll.length > 1) {
      return { error: '?afterSeq and ?bootId must not duplicate carry' }
    }
    if (afterSeqAll.length === 0 && bootIdAll.length === 0) return {}
    if (afterSeqAll.length === 0 || bootIdAll.length === 0) {
      return { error: '?afterSeq and ?bootId must into for carry only then can resume' }
    }
    const afterSeqRaw = afterSeqAll[0]!
    const bootIdRaw = bootIdAll[0]!
    if (!/^\d{1,16}$/.test(afterSeqRaw) || !Number.isSafeInteger(Number(afterSeqRaw))) {
      return { error: 'afterSeq must be non- negative security integer' }
    }
    if (bootIdRaw.length === 0 || bootIdRaw.length > 64) {
      return { error: 'bootId must be length 1..64 non-empty string' }
    }
    return { resume: { afterSeq: Number(afterSeqRaw), bootId: bootIdRaw } }
  }

  /** resume can row: same proxy, do not exceeds not come, and need to (afterSeq, headSeq] non-empty when must by ring
   * complete connect continue override (first frame <= afterSeq+1, end frame exactly is when before head, zone segment inside one by one frame +1 connect continue;
   * ring at most 256 frame line inspect verify enough), any one do not satisfy fall back snapshot- - end frame missing will let client
   * forever append do not flat headSeq(heartbeat still to, idle watchdog does not trigger), never false resumed promise;
   * afterSeq == headSeq(already append flat header) zero patch resume, but same must same proxy. */
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
   * establish carries buffer internal subscribe: subscribe first buffer (frame and pre- encode byte one same queue, conflict refresh when zero heavy encode),
   * goLive(snapshotSeq) conflict refresh seq update buffer frame after rotate real-time.onFrame return false
   * (failed to write/overflow/consumer stop) or throws all immediately unsubscribe and call back onStop.
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
          // subscribe establish i.e. buffer phase overflow (provider sync heavy publish only then will trigger): same explicit closure stream.
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

  /** group install+validate+redaction (delegate event-validation pure function;redact inject instance redaction). */
  private buildEvent(type: string, payload: unknown): HelmEvent {
    return assembleHelmEvent(type, payload, (t) => this.redact(t))
  }
}

/** conversation document subscribe first frame:{seq, doc}; by HTTP layer via sync provider atomic read. */
export interface SessionDocSnapshot {
  seq: number
  doc: PublicPluginSessionDoc
}

interface SessionDocStreamEntry {
  target: { pluginId: string; name: string; conversationId: number }
  stop: () => void
}

/** buffer phase not decide frame (keep seq, conflict refresh when only seq > snapshot.seq frame). */
interface SessionDocQueuedFrame {
  seq: number
  chunk: Uint8Array
}

/**
 * SessionDocEventHub: conversation document dedicated use event side.
 *
 * plugin.session_doc.updated never enter global /api/events(write put large and across conversation leak leak);
 * this hub only (pluginId, name, conversationId) three meta group update dispatch to subscribe the
 * three meta group dedicated use SSE stream. frame shape and global stream consistent (HelmEventFrame {seq, event}),
 * seq only maintain this hub itself single tune counter; first frame snapshot by response sync provider
 * (such as kernel.plugins.getPublicSessionDoc) in subscribe establish after invoke, guarantee
 * first subscribe buffer, after take snapshot atomic window - - snapshot and first frame incremental between do not lose frame, does not repeat.
 *
 * lifecycle:response is each stream register (target, stop);hub.close() truly close all
 * stream (ReadableStream close + unsubscribe);closeForPlugin/closeForConversation by
 * runtime listen core event drive (plugin.changed enabled=false / conversation.deleted),
 * event drive while non- polling, without external invoke when zero overhead.
 */
export class SessionDocEventHub {
  private seqValue = 0
  private readonly subscribers = new Map<string, Set<(frame: HelmEventFrame) => void>>()
  /** each dedicated use stream close handle (close()/set to close use; the same three meta group many connect each register). */
  private readonly streams = new Set<SessionDocStreamEntry>()
  /** subscribe establish to snapshot conflict refresh complete between not decide frame count cap (overflow i.e. slow client, closure stream reconnect). */
  private readonly maxPending = MAX_PENDING_EVENTS
  /** streaming phase not read byte cap (by default 1 MiB; slow client explicit closure stream, never unbounded queue up). */
  private readonly maxPendingBytes: number
  private redactFn: (text: string) => string = (t) => t

  constructor(options: { maxPendingBytes?: number } = {}) {
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
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

  /** when before leap subscribe count (actual listener count, diagnose and test use). */
  get subscriberCount(): number {
    let total = 0
    for (const set of this.subscribers.values()) total += set.size
    return total
  }

  /** truly close all dedicated use stream and empty subscribe (kernel.close when invoke, eliminate leak leak). */
  close(): void {
    this.closeStreams(() => true)
    this.subscribers.clear()
  }

  /** close designate plugin all dedicated use stream (plugin deactivate/deregister:plugin.changed enabled=false). */
  closeForPlugin(pluginId: string): void {
    this.closeStreams((entry) => entry.target.pluginId === pluginId)
  }

  /** close designate conversation all dedicated use stream (conversation delete:conversation.deleted). */
  closeForConversation(conversationId: number): void {
    this.closeStreams((entry) => entry.target.conversationId === conversationId)
  }

  private closeStreams(match: (entry: SessionDocStreamEntry) => boolean): void {
    for (const entry of [...this.streams]) {
      if (match(entry)) entry.stop()
    }
  }

  /**
   * publish a conversation document update: only delivery subscribe the three meta group listener.
   * payload in boundary do shape validate (event-validation pure function)+ JSON redaction (and
   * EventHub.buildEvent the same discipline), illegal payload explicit throw HelmError and do not push enter seq,
   * never static default fall back.
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
        // subscribe way call back throws only isolated itself (each subscribe internal self row clean up), does not affect other subscribe.
      }
    }
  }

  /**
   * subscribe designate three meta group incremental frame; return unsubscribe function.
   * and EventHub.subscribe same name semantics:HTTP layer first subscribe buffer again sync take snapshot.
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
   * dedicated use SSE response: first frame `event: snapshot`(PluginSessionDocSnapshot {seq, doc}),
   * then `event: plugin.session_doc.updated` + HelmEventFrame incremental.
   *
   * atomic window: first establish buffer subscribe, again sync invoke options.snapshot provider read snapshot
   * (provider also complete public/conversation store in again validate, failed sync throw to HTTP layer),
   * send snapshot after only conflict refresh seq > snapshot.seq buffer frame - - do not lose frame, does not repeat.
   * provider fails or request already abort: sync unsubscribe clean up, do not create stream.
   *
   * back press and clean up: buffer phase subject to MAX_PENDING_EVENTS restrict, streaming phase with byte cap decide
   * (sse-stream sharing original language), over limit i.e. slow client, explicit closure stream unsubscribe (never unbounded queue up);
   * abort / cancel / hub set to close same closure stream. reconnect i.e. re- subscribe and reset snapshot
   * (without across connect leftover).
   */
  response(
    request: Request,
    options: {
      /** sync snapshot provider: in subscribe establish after invoke, return {seq, doc}; fails sync throw. */
      snapshot: () => SessionDocSnapshot
      target: { pluginId: string; name: string; conversationId: number }
    },
  ): Response {
    /** snapshot conflict refresh complete before not decide frame (this after change use stream inside byte back press). */
    let pending: SessionDocQueuedFrame[] = []
    let streaming = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

    const write = (chunk: Uint8Array): boolean =>
      byteBoundedWrite(controllerRef, closed, chunk, this.maxPendingBytes)

    /** shutdown register handle;provider phase (not yet register) is undefined, delete idempotent. */
    let streamEntry: SessionDocStreamEntry | undefined
    const shutdown = (): void => {
      if (closed) return
      closed = true
      request.signal.removeEventListener('abort', shutdown)
      unsubscribe?.()
      unsubscribe = undefined
      if (streamEntry !== undefined) this.streams.delete(streamEntry)
      const controller = controllerRef
      controllerRef = undefined
      closeControllerQuietly(controller)
    }

    // first subscribe buffer (and snapshot read the same sync window, do not lose frame; buffer frame keep seq supply conflict refresh filter choose).
    unsubscribe = this.subscribe(options.target, (frame) => {
      if (closed) return
      const chunk = encodeSseChunk('plugin.session_doc.updated', frame)
      if (streaming) {
        if (!write(chunk)) shutdown()
        return
      }
      if (pending.length >= this.maxPending) {
        // snapshot not yet conflict refresh completely then accumulate press over limit (provider sync heavy publish only then will trigger): explicit closure stream.
        shutdown()
        return
      }
      pending.push({ seq: frame.seq, chunk })
    })

    // again sync take snapshot (provider failed/already abort: sync unsubscribe, do not create stream, do not fabricate snapshot).
    let snap: SessionDocSnapshot
    try {
      if (request.signal.aborted) throw new HelmError('aborted', 'subscribe establish before request interrupted', 499)
      snap = options.snapshot()
    } catch (error) {
      shutdown()
      throw error
    }
    const snapshotChunk = encodeSseChunk('snapshot', snap)
    streamEntry = { target: options.target, stop: shutdown }
    if (!closed) this.streams.add(streamEntry)

    return sseResponse({
      start: (controller) => {
        // without byte policy when runtime must is by default control (original inline construct the same fact).
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
        // subscribe buffer already establish and snapshot already take set: first first frame snapshot, again conflict refresh seq update
        // buffer frame (seq <= snapshot.seq already body now snapshot in, heavy i.e. duplicate).
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
      },
      cancel: () => {
        shutdown()
      },
    })
  }
}
