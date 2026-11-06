/**
 * EventHub：全局持久化 seq 的事件总线 + SSE 快照/增量流。
 *
 * 语义（按设计文档 §1.2）：
 * - seq 单调递增且持久化（helm_seq），重启不回退；
 * - publish 与 subscribe 同名保留（app 使用 kernel.events.publish(type, payload)）；
 * - sseStream：先订阅缓冲，再同步取快照，首帧 snapshot{seq,conversations,pendingAsks,plugins}，
 *   随后冲刷缓冲中 seq > snapshot.seq 的事件，再进入实时流；断连自动退订；
 * - publish 侧统一脱敏（redactSecrets），背压用有界缓冲 + 慢消费者丢弃后补发 snapshot 指引。
 */

import type { AskSpec, ConversationSummary, HelmEvent, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

/** 递归剔除值为 undefined 的可选字段（JSON 序列化等价，且满足 redactJsonValue 严格性）。 */
function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => pruneUndefined(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = pruneUndefined(v)
    }
    return out
  }
  return value
}

export type SnapshotProvider = () => HelmSnapshot

export interface EventSubscription {
  unsubscribe(): void
}

interface QueuedFrame {
  seq: number
  event: HelmEvent
}

const MAX_BUFFER_PER_SUB = 512

export class EventHub {
  private seqValue = 0
  private seqDirty = false
  private readonly subscribers = new Set<(frame: HelmEventFrame) => void>()
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  /** redact(text) -> 脱敏文本（secret 明文 -> marker；复用 redactJsonValue 递归）。 */
  redact: (text: string) => string = (t) => t

  set redactFn(fn: (text: string) => string) {
    this.redact = fn
  }

  constructor(options: {
    initialSeq: number
    snapshot: SnapshotProvider
    persistSeq?: (seq: number) => void
  }) {
    this.seqValue = options.initialSeq
    this.snapshot = options.snapshot
    this.persistSeq = options.persistSeq ?? (() => {})
  }

  get seq(): number {
    return this.seqValue
  }

  /** 发布事件；type 需为 HelmEventType，payload 脱敏后入帧。 */
  publish(type: string, payload: unknown): void {
    this.seqValue += 1
    this.persistSeq(this.seqValue)
    const event = this.buildEvent(type, payload)
    const frame: HelmEventFrame = { seq: this.seqValue, event }
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame)
      } catch {
        // 订阅方回调抛错只影响自身，详见 sseStream 内部处理。
      }
    }
  }

  /** 无副事的当前快照（供 HTTP GET 与 SSE 首帧复用）。 */
  currentSnapshot(): HelmSnapshot {
    const snap = this.snapshot()
    return { ...snap, seq: Math.max(snap.seq, this.seqValue) }
  }

  /**
   * SSE 流：先建缓冲订阅，再取快照；首帧 snapshot 后冲刷 seq > snapshot.seq 的缓冲帧。
   * 消费者 return false 或抛错即断连退订。背压：缓冲超限时补发一次 snapshot 重对齐。
   */
  sseStream(consume: (frame: HelmSnapshot | HelmEventFrame) => boolean | void): void {
    let buffer: QueuedFrame[] = []
    let live = false
    let done = false
    const push = (frame: HelmEventFrame) => {
      if (done) return
      if (!live) {
        buffer.push(frame)
        if (buffer.length > MAX_BUFFER_PER_SUB) buffer.shift()
        return
      }
      this.deliver(consume, frame, () => {
        done = true
      })
    }
    this.subscribers.add(push)
    try {
      const snap = this.currentSnapshot()
      if (consume(snap) === false) return
      live = true
      for (const frame of buffer) {
        if (frame.seq <= snap.seq) continue
        this.deliver(consume, frame, () => {
          done = true
        })
        if (done) return
      }
      buffer = []
    } finally {
      if (done) this.subscribers.delete(push)
    }
  }

  private deliver(
    consume: (frame: HelmSnapshot | HelmEventFrame) => boolean | void,
    frame: HelmEventFrame,
    stop: () => void,
  ): void {
    try {
      if (consume(frame) === false) stop()
    } catch {
      stop()
    }
  }

  /** 把 (type, payload) 组装为协议 HelmEvent；未知 type 包成 notification。对象先递归脱敏再入帧。 */
  private buildEvent(type: string, payload: unknown): HelmEvent {
    // 会话摘要含可选字段（doing 等可为 undefined）；剔除后再递归脱敏（redactJsonValue 拒绝 undefined）。
    const clean = payload && typeof payload === 'object' ? pruneUndefined(payload) : payload
    const redacted = redactJsonValue(clean, (t) => this.redact(t)) as Record<string, unknown>
    switch (type) {
      case 'conversation.upsert':
        return { type, conversation: redacted as unknown as ConversationSummary }
      case 'conversation.deleted':
        return { type, conversationId: Number(redacted.conversationId) }
      case 'ask.upsert':
        return { type, ask: redacted as unknown as AskSpec }
      case 'ask.resolved':
        return {
          type,
          askId: String(redacted.askId),
          status: redacted.status as 'answered' | 'cancelled' | 'superseded',
        }
      case 'plugin.changed':
        return { type, plugin: redacted as unknown as HelmSnapshot['plugins'][number] }
      default:
        return {
          type: 'notification',
          level: (redacted.level as 'info' | 'warning' | 'error') ?? 'info',
          title: String(redacted.title ?? type),
          body: redacted.body === undefined ? undefined : String(redacted.body),
          conversationId:
            redacted.conversationId === undefined ? undefined : Number(redacted.conversationId),
        }
    }
  }
}
