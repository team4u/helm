/**
 * EventHub：全局持久化 seq 的事件总线 + SSE 快照/增量流。
 *
 * 语义（按设计文档 §1.2）：
 * - seq 单调递增且持久化（helm_seq），重启不回退；只在事件成功组装脱敏后推进序号；
 * - publish 与 subscribe 同名保留（app 使用 kernel.events.publish(type, payload)）；
 * - response(request)：标准 SSE——先订阅缓冲，再同步取快照，首帧
 *   `event: snapshot`（HelmSnapshot），随后逐帧 `event: <type>` + `data: {seq,event}`；
 *   Request.signal abort 与 ReadableStream.cancel 均退订关流；无事件时保持连接（纯实时流）；
 * - sseStream(consume)：可编程消费入口（同 snapshot 先行语义），返回退订句柄；
 *   消费者 return false 或抛错即隔离该订阅并清理，不影响其他订阅者；
 * - publish 侧统一 JSON 校验 + 脱敏（字符串与字段名都过 redact），payload 非法直接抛
 *   HelmError，绝不静默降级；core 类型入参同时接受调用方直接 payload 与完整事件信封
 *   （如 PluginHost emitEvent('plugin.changed', {type, plugin})），信封只拆包不二次嵌套；
 * - 未知 type 走 CustomHelmEvent {type, payload} 原样透传，不伪装成 notification；
 * - 背压有界：未决帧数/字节数超上限视为慢客户端，显式关流（客户端凭 snapshot 重连
 *   对齐），绝不静默丢帧；快照 provider 是同步的，无需异步快照系统。
 */

import { HelmError } from '@helm/protocol'
import type { AskSpec, ConversationSummary, CustomHelmEvent, HelmEvent, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

export type SnapshotProvider = () => HelmSnapshot

export interface EventSubscription {
  unsubscribe(): void
}

/** SSE 输出帧：首帧 snapshot 或增量 {seq, event}。 */
export type SseFrame = HelmSnapshot | HelmEventFrame

interface QueuedFrame {
  seq: number
  event: HelmEvent
}

/** 订阅建立到快照冲刷完成之间的未决帧数上限（溢出即慢客户端，关流重连）。 */
const MAX_PENDING_EVENTS = 512
/** 流式阶段未读字节上限（默认 1 MiB，可用 maxPendingBytes 覆盖，测试用小值）。 */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

/**
 * 递归剔除值为 undefined 的可选字段。
 * 仅对 plain object / array 递归；其余值（含 Date/Map 等非法 JSON 值）原样返回，
 * 由 redactJsonValue 在 JSON 边界统一拒绝，不做静默转换。
 * 已在访问路径上的对象原样返回（真循环留给 redactJsonValue 显式抛错，不在这里无限递归）。
 */
function pruneUndefined(value: unknown, visiting: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      return value.map((v) => pruneUndefined(v, visiting))
    } finally {
      visiting.delete(value)
    }
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[k] = pruneUndefined(v, visiting)
      }
      return out
    } finally {
      visiting.delete(value)
    }
  }
  return value
}

export class EventHub {
  private seqValue: number
  private readonly subscribers = new Set<(frame: HelmEventFrame) => void>()
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  private readonly streamClosers = new Set<() => void>()
  private readonly maxPendingBytes: number
  /** redact(text) -> 脱敏文本（secret 明文 -> marker；复用 redactJsonValue 递归）。 */
  redact: (text: string) => string = (t) => t

  set redactFn(fn: (text: string) => string) {
    this.redact = fn
  }

  constructor(options: {
    initialSeq: number
    snapshot: SnapshotProvider
    persistSeq?: (seq: number) => void
    /** 流式阶段未读字节上限（慢客户端判定）；默认 1 MiB。 */
    maxPendingBytes?: number
  }) {
    this.seqValue = options.initialSeq
    this.snapshot = options.snapshot
    this.persistSeq = options.persistSeq ?? (() => {})
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  }

  get seq(): number {
    return this.seqValue
  }

  /** 当前活跃订阅数（诊断与测试用）。 */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** 清空全部订阅（kernel.close 时调用，杜绝订阅泄漏）。 */
  close(): void {
    for (const stop of [...this.streamClosers]) stop()
    this.subscribers.clear()
  }

  /**
   * 发布事件。
   * 先组装并脱敏事件（失败抛 HelmError 且不推进 seq），成功才推进序号并投递。
   */
  publish(type: string, payload: unknown): void {
    const event = this.buildEvent(type, payload)
    this.seqValue += 1
    this.persistSeq(this.seqValue)
    const frame: HelmEventFrame = { seq: this.seqValue, event }
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame)
      } catch {
        // 订阅方回调抛错只隔离自身（各订阅内部自行清理），不影响其他订阅者。
      }
    }
  }

  /** 当前快照（供 HTTP GET 与 SSE 首帧复用）；经 prune + 递归脱敏后返回。 */
  currentSnapshot(): HelmSnapshot {
    const snap = this.snapshot()
    const redacted = redactJsonValue(pruneUndefined(snap, new WeakSet()), (t) => this.redact(t)) as HelmSnapshot
    return { ...redacted, seq: Math.max(snap.seq, this.seqValue) }
  }

  /** 订阅增量帧；返回退订函数（HTTP 层只消费 response，此入口供编程消费与测试）。 */
  subscribe(listener: (frame: HelmEventFrame) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * SSE 流（可编程消费）：先建缓冲订阅，再取快照；首帧 snapshot 后冲刷 seq > snapshot.seq
   * 的缓冲帧。消费者 return false 或抛错、快照失败都先退订再结束/重抛，绝不泄漏订阅。
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
   * HTTP SSE 响应：立即返回 Response；首帧 snapshot，随后按 seq 增量。
   * request.signal abort 与 ReadableStream.cancel 都退订并关流；未决帧数/字节数
   * 超上限的慢客户端被明确关流（重连凭 snapshot 对齐）；无事件时保持连接，绝不回退 JSON。
   */
  response(request: Request): Response {
    const encoder = new TextEncoder()
    /** 快照冲刷完成前的未决帧（此后改用流内字节背压）。 */
    let pending: string[] = []
    let streaming = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

    const encodeFrame = (name: string, data: unknown): string =>
      `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

    const write = (chunk: string): boolean => {
      const controller = controllerRef
      if (controller === undefined || closed) return false
      const bytes = encoder.encode(chunk)
      // 字节级有界背压：desiredSize = -排队字节数（hwm=0）；超限即慢客户端。
      const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
      if (queuedBytes + bytes.byteLength > this.maxPendingBytes) return false
      try {
        controller.enqueue(bytes)
        return true
      } catch {
        return false
      }
    }

    const shutdown = (): void => {
      if (closed) return
      closed = true
      request.signal.removeEventListener('abort', shutdown)
      unsubscribe?.()
      unsubscribe = undefined
      const controller = controllerRef
      controllerRef = undefined
      try {
        controller?.close()
      } catch {
        // 已关：幂等。
      }
    }

    // 先订阅再取快照（同 microtask 内完成，缓冲不丢帧）；快照失败同步抛给 HTTP 层。
    const handle = this.openStream(
      (frame) => {
        if (closed) return false
        const chunk = encodeFrame(String(frame.event.type), { seq: frame.seq, event: frame.event })
        if (streaming) return write(chunk)
        if (pending.length >= MAX_PENDING_EVENTS) {
          // 快照尚未冲刷完就积压超限：明确关流，不静默丢帧。
          return false
        }
        pending.push(chunk)
        return true
      },
      shutdown,
    )
    unsubscribe = handle.unsubscribe
    let snap: HelmSnapshot
    try {
      snap = this.currentSnapshot()
    } catch (error) {
      shutdown()
      throw error
    }
    const snapshotChunk = encodeFrame('snapshot', snap)

    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          controllerRef = controller
          if (closed) {
            // 关闭发生在流建立之前（如快照 provider 同步重入溢出）：立即关流。
            try {
              controller.close()
            } catch {
              // 已关：幂等。
            }
            return
          }
          if (request.signal.aborted) {
            shutdown()
            return
          }
          request.signal.addEventListener('abort', shutdown)
          if (!write(snapshotChunk)) {
            shutdown()
            return
          }
          if (!handle.goLive(snap.seq)) return
          // goLive 已把缓冲冲刷进 pending；此后转流式直写（字节背压接管）。
          streaming = true
          for (const chunk of pending) {
            if (!write(chunk)) {
              shutdown()
              return
            }
          }
          pending = []
        },
        cancel: () => {
          shutdown()
        },
      },
      // hwm=0：desiredSize 恒为 -排队字节数，供 write 做慢客户端判定。
      { highWaterMark: 0, size: (c) => c.byteLength } satisfies QueuingStrategy<Uint8Array>,
    )
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  /**
   * 建立带缓冲的内部订阅：订阅先入缓冲，goLive(snapshotSeq) 冲刷 seq 更新的缓冲帧后
   * 转实时。onFrame 返回 false（写入失败/溢出/消费者停止）或抛错都立即退订并回调 onStop。
   */
  private openStream(
    onFrame: (frame: HelmEventFrame) => boolean,
    onStop?: () => void,
  ): { unsubscribe(): void; goLive(snapshotSeq: number): boolean } {
    let buffer: QueuedFrame[] = []
    let live = false
    let done = false
    const stop = (): void => {
      if (done) return
      done = true
      this.subscribers.delete(push)
      this.streamClosers.delete(stop)
      onStop?.()
    }
    const deliver = (frame: HelmEventFrame): void => {
      let ok = false
      try {
        ok = onFrame(frame)
      } catch {
        ok = false
      }
      if (!ok) stop()
    }
    const push = (frame: HelmEventFrame): void => {
      if (done) return
      if (!live) {
        if (buffer.length >= MAX_PENDING_EVENTS) {
          // 订阅建立即缓冲阶段溢出（provider 同步重入发布才会触发）：同样明确关流。
          stop()
          return
        }
        buffer.push(frame)
        return
      }
      deliver(frame)
    }
    this.subscribers.add(push)
    this.streamClosers.add(stop)
    return {
      unsubscribe: stop,
      goLive(snapshotSeq: number): boolean {
        if (done) return false
        live = true
        for (const frame of buffer) {
          if (frame.seq <= snapshotSeq) continue
          deliver(frame)
          if (done) return false
        }
        buffer = []
        return true
      },
    }
  }

  /**
   * 把 (type, payload) 组装为协议 HelmEvent；先 prune 可选 undefined，再整体递归
   * JSON 脱敏（字符串值与字段名都过 redact）。core 类型接受直接 payload 或完整
   * 事件信封；未知 type 走 CustomHelmEvent {type, payload} 原样透传（不伪报成
   * notification）；任何非法 JSON 值（循环、Date、Map 等）抛 HelmError 不静默降级。
   */
  private buildEvent(type: string, payload: unknown): HelmEvent {
    if (typeof type !== 'string' || type.length === 0) {
      throw new HelmError('invalid_event', '事件 type 必须是非空字符串', 500)
    }
    const clean = pruneUndefined(payload, new WeakSet())
    const redacted = redactJsonValue(clean, (t) => this.redact(t))
    const record =
      redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : undefined

    // 完整事件信封（payload 自带同名的 type 字段）：拆包取各类型专属字段，不二次嵌套。
    const envelope = record !== undefined && record['type'] === type ? record : undefined

    switch (type) {
      case 'conversation.upsert': {
        const conversation = (envelope?.['conversation'] ?? record) as ConversationSummary
        return { type, conversation }
      }
      case 'conversation.deleted': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const conversationId = Number(source?.['conversationId'])
        if (!Number.isInteger(conversationId)) {
          throw new HelmError('invalid_event', 'conversation.deleted 需要 number conversationId', 500)
        }
        return { type, conversationId }
      }
      case 'ask.upsert': {
        const ask = (envelope?.['ask'] ?? record) as AskSpec
        return { type, ask }
      }
      case 'ask.resolved': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const askId = source?.['askId']
        const status = source?.['status']
        if (typeof askId !== 'string' || (status !== 'answered' && status !== 'cancelled' && status !== 'superseded')) {
          throw new HelmError('invalid_event', 'ask.resolved 需要 string askId 与合法 status', 500)
        }
        return { type, askId, status }
      }
      case 'plugin.changed': {
        const plugin = (envelope?.['plugin'] ?? record) as HelmSnapshot['plugins'][number]
        return { type, plugin }
      }
      case 'notification': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const level =
          source?.['level'] === 'warning' || source?.['level'] === 'error' ? source['level'] : 'info'
        const title = source?.['title']
        const body = source?.['body']
        const conversationId = source?.['conversationId']
        return {
          type,
          level,
          title: typeof title === 'string' ? title : 'notification',
          ...(typeof body === 'string' ? { body } : {}),
          ...(typeof conversationId === 'number' && Number.isInteger(conversationId)
            ? { conversationId }
            : {}),
        }
      }
      default: {
        // CustomHelmEvent：未知 type 原样透传，不伪报成 notification。
        const custom: CustomHelmEvent = { type: String(type), payload: redacted }
        return custom
      }
    }
  }
}
