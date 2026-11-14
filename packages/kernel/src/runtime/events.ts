/**
 * EventHub：全局持久化 seq 的事件总线 + SSE 快照/增量流。
 *
 * 语义（按设计文档 §1.2）：
 * - seq 单调递增且持久化（helm_seq），重启不回退；发布严格按「组装脱敏 -> 编码
 *   -> 持久化 nextSeq -> 推进内存水位 -> 入 ring -> 广播」排序，任一步失败都不
 *   推进水位、不留半成品（绝不产生无 ring 记录的裸 seq 缺口）；
 * - 每个实例随机生成 bootId（事件代）：`?afterSeq`+`?bootId` 双凭据均校验通过才
 *   允许短断线续传（首帧 resumed + ring 补发 + 实时增量，严格无重复无遗漏）；
 *   跨代、seq 越界（未来）或 ring 缺口一律回退 snapshot 全量对齐，绝不越缺口
 *   假成功；畸形查询参数（非非负安全整数/长度超限/单凭据）显式 400；
 * - 续传 ring：保存发布时编码一次的不可变 SSE 字节（订阅者与重放共享同一份，
 *   防订阅者篡改重放数据；不复制 SQLite 事件库），帧数/字节双上限（默认 256 帧 /
 *   1 MiB）超限从头淘汰；单帧超字节预算即清空 ring，禁止任何客户端跨该帧续传；
 *   重放经 ReadableStream.pull 按消费者节奏逐步冲刷，绝不在 start 内一次性塞满
 *   队列（快消费者也不被字节预算误杀；冲刷期间新到达帧另行计入慢消费者预算）；
 * - publish 与 subscribe 同名保留（app 使用 kernel.events.publish(type, payload)）；
 * - response(request)：标准 SSE——先订阅缓冲，再同步采样（快照或 ring+headSeq），
 *   首帧 `event: snapshot`（HelmSnapshot，含 bootId）或 `event: resumed`
 *   （HelmResumedFrame），随后逐帧 `event: <type>` + `data: {seq,event}`；
 *   Request.signal abort 与 ReadableStream.cancel 均退订关流；无事件时保持连接（纯实时流）；
 * - sseStream(consume)：可编程消费入口（同 snapshot 先行语义），返回退订句柄；
 *   消费者 return false 或抛错即隔离该订阅并清理，不影响其他订阅者；
 * - publish 侧统一 JSON 校验 + 脱敏（字符串与字段名都过 redact），payload 非法直接抛
 *   HelmError，绝不静默降级；core 类型入参同时接受调用方直接 payload 与完整事件信封
 *   （如 PluginHost emitEvent('plugin.changed', {type, plugin})），信封只拆包不二次嵌套；
 *   conversation.entry / conversation.live / plugin.doc.updated 同样接受双形状并校验字段；
 *   conversation.upsert / ask.upsert / notification 同样逐字段校验，非法即抛，
 *   不静默修正（如 notification 的非法 level 不再折回 'info'）；
 * - 未知 type 走 CustomHelmEvent {type, payload} 原样透传，不伪装成 notification；
 * - 背压有界：未决帧数/字节数超上限视为慢客户端，显式关流（客户端凭 snapshot 重连
 *   对齐），绝不静默丢帧；快照 provider 是同步的，无需异步快照系统。
 */

import { randomUUID } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type {
  AskSpec,
  SecretLifetime,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CustomHelmEvent,
  HelmEvent,
  HelmEventFrame,
  HelmSnapshot,
  NodeInfo,
  PublicPluginDoc,
  PublicPluginSessionDoc,
} from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { validateSecretLifetime } from '../services/secret-stash.js'

/**
 * 快照内容 provider：不含 bootId（由 EventHub 实例注入，单一事实来源），
 * seq 为 provider 侧已知水位，最终以 hub 当前 seq 取最大为准。
 */
export type SnapshotProvider = () => Omit<HelmSnapshot, 'bootId'>

export interface EventSubscription {
  unsubscribe(): void
}

/** SSE 输出帧：首帧 snapshot/resumed 控制帧或增量 {seq, event}。 */
export type SseFrame = HelmSnapshot | HelmEventFrame

/** SSE chunk 编码器（发布一次，ring、重放与全部订阅者复用同一份字节）。 */
const SSE_ENCODER = new TextEncoder()

function encodeSseChunk(name: string, data: unknown): Uint8Array {
  return SSE_ENCODER.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** 空闲心跳注释行（预编码共享；SSE 解析器忽略，不伪造业务事件）。 */
const KEEPALIVE_CHUNK = SSE_ENCODER.encode(': keepalive\n\n')

/** 续传 ring 条目：发布时编码的不可变 SSE 字节（防订阅者修改重放数据）。 */
interface RingEntry {
  seq: number
  chunk: Uint8Array
}

/** 订阅建立到快照冲刷完成之间的未决帧数上限（溢出即慢客户端，关流重连）。 */
const MAX_PENDING_EVENTS = 512

/** 续传 ring 默认上限：256 帧 / 1 MiB 字节（超限从头剪裁）。 */
const DEFAULT_RING_MAX_FRAMES = 256
const DEFAULT_RING_MAX_BYTES = 1024 * 1024

const CONVERSATION_STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'error'])
const ASK_STATUSES = new Set(['pending', 'answered', 'cancelled', 'superseded'])
const ASK_FIELD_TYPES = new Set(['text', 'select', 'confirm'])

/**
 * conversation.upsert 载荷校验：事件消费方（web live-state / cli / 协议类型）
 * 实际读取的 ConversationSummary 核心字段；可选字段存在即校验，类型不符同样抛错
 *（可缺不可错）。
 */
function assertConversationSummaryShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'conversation.upsert 需要 ConversationSummary 形状的 conversation', 500)
  }
  const conv = value as Record<string, unknown>
  if (
    !Number.isInteger(conv['id']) ||
    typeof conv['title'] !== 'string' ||
    typeof conv['profileId'] !== 'string' ||
    !Array.isArray(conv['tags']) ||
    !conv['tags'].every((tag) => typeof tag === 'string') ||
    typeof conv['cwd'] !== 'string' ||
    typeof conv['model'] !== 'string' ||
    typeof conv['thinkingLevel'] !== 'string' ||
    !CONVERSATION_STATUSES.has(conv['status'] as string) ||
    !Number.isInteger(conv['stateChangeSeq']) ||
    !Number.isInteger(conv['completionSeq']) ||
    typeof conv['unread'] !== 'boolean' ||
    typeof conv['pinned'] !== 'boolean' ||
    !Number.isInteger(conv['pendingAskCount']) ||
    !Number.isFinite(conv['createdAt']) ||
    !Number.isFinite(conv['updatedAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert 需要 ConversationSummary 形状的 conversation（id/title/profileId/tags/cwd/model/thinkingLevel/status/stateChangeSeq/completionSeq/unread/pinned/pendingAskCount/createdAt/updatedAt）',
      500,
    )
  }
  if (
    (conv['parentConversationId'] !== undefined && !Number.isInteger(conv['parentConversationId'])) ||
    (conv['parentToolCallId'] !== undefined && typeof conv['parentToolCallId'] !== 'string') ||
    (conv['ownedBy'] !== undefined &&
      conv['ownedBy'] !== 'human' &&
      conv['ownedBy'] !== 'helm' &&
      conv['ownedBy'] !== 'bot') ||
    (conv['nodeId'] !== undefined && typeof conv['nodeId'] !== 'string') ||
    (conv['thinkingLevelOverride'] !== undefined && typeof conv['thinkingLevelOverride'] !== 'string') ||
    (conv['doing'] !== undefined && typeof conv['doing'] !== 'string') ||
    (conv['lastError'] !== undefined && typeof conv['lastError'] !== 'string')
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert 的可选字段（parentConversationId/parentToolCallId/ownedBy/nodeId/thinkingLevelOverride/doing/lastError）存在时类型必须合法',
      500,
    )
  }
}

/** ask.upsert 载荷校验：AskSpec 核心字段形状（业务级规则由 createAsk 的 validateAskSpec 把守）。 */
function assertAskSpecShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'ask.upsert 需要 AskSpec 形状的 ask', 500)
  }
  const ask = value as Record<string, unknown>
  if (
    typeof ask['id'] !== 'string' ||
    ask['id'] === '' ||
    !Number.isInteger(ask['conversationId']) ||
    typeof ask['title'] !== 'string' ||
    ask['title'] === '' ||
    !Array.isArray(ask['fields']) ||
    ask['fields'].length === 0 ||
    !ASK_STATUSES.has(ask['status'] as string) ||
    !Number.isFinite(ask['createdAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'ask.upsert 需要 AskSpec 形状的 ask（id/conversationId/title/fields/status/createdAt）',
      500,
    )
  }
  for (const field of ask['fields']) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof (field as Record<string, unknown>)['name'] !== 'string' ||
      typeof (field as Record<string, unknown>)['label'] !== 'string' ||
      !ASK_FIELD_TYPES.has((field as Record<string, unknown>)['type'] as string)
    ) {
      throw new HelmError('invalid_event', 'ask.upsert 的 field 需要 { name: string; label: string; type: text|select|confirm } 形状', 500)
    }
    const f = field as Record<string, unknown>
    if (f['secretLifetime'] !== undefined) {
      if (f['secret'] !== true) throw new HelmError('invalid_event', 'ask.upsert 的 secretLifetime 仅允许用于 secret 字段', 500)
      try {
        validateSecretLifetime(f['secretLifetime'] as SecretLifetime, 'ask.upsert field.secretLifetime')
      } catch (error) {
        throw new HelmError('invalid_event', error instanceof Error ? error.message : 'ask.upsert field.secretLifetime 格式无效', 500)
      }
    }
    if (f['type'] === 'select' && (!Array.isArray(f['options']) || f['options'].length === 0)) {
      throw new HelmError('invalid_event', 'ask.upsert 的 select 字段需要非空 options（与 createAsk 校验一致）', 500)
    }
    if (
      (f['options'] !== undefined &&
        (!Array.isArray(f['options']) ||
          !f['options'].every(
            (o) => o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>)['label'] === 'string' && typeof (o as Record<string, unknown>)['value'] === 'string',
          ))) ||
      (f['secret'] !== undefined && typeof f['secret'] !== 'boolean') ||
      (f['required'] !== undefined && typeof f['required'] !== 'boolean')
    ) {
      throw new HelmError('invalid_event', 'ask.upsert 的 field 可选字段（options/secret/required）存在时类型必须合法', 500)
    }
  }
  if (
    (ask['ownerPluginId'] !== undefined && typeof ask['ownerPluginId'] !== 'string') ||
    (ask['description'] !== undefined && typeof ask['description'] !== 'string') ||
    (ask['expectedStateSeq'] !== undefined && !Number.isInteger(ask['expectedStateSeq']))
  ) {
    throw new HelmError('invalid_event', 'ask.upsert 的可选字段（ownerPluginId/description/expectedStateSeq）存在时类型必须合法', 500)
  }
}
/** 流式阶段未读字节上限（默认 1 MiB，可用 maxPendingBytes 覆盖，测试用小值）。 */
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024

/** SSE 空闲心跳间隔（默认 15s；注释行走统一字节背压路径，测试可用 keepaliveMs 覆盖）。 */
const DEFAULT_KEEPALIVE_MS = 15_000

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
  /** 事件代标识（实例随机生成）：续传双凭据之一，同代内 seq 才连续可比。 */
  readonly bootId: string
  /** 续传 ring（seq 连续区段，从头淘汰；单帧超预算即清空禁跨帧续传）。 */
  private readonly ring: RingEntry[] = []
  private ringBytes = 0
  private readonly ringMaxFrames: number
  private readonly ringMaxBytes: number
  private readonly subscribers = new Set<(frame: HelmEventFrame, chunk: Uint8Array) => void>()
  private readonly snapshot: SnapshotProvider
  private readonly persistSeq: (seq: number) => void
  private readonly streamClosers = new Set<() => void>()
  private readonly maxPendingBytes: number
  /** SSE 空闲心跳间隔（非正值停用）；注释行让中间层/代理保活并可被客户端检测卡死。 */
  private readonly keepaliveMs: number
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
    /** SSE 空闲心跳间隔（毫秒）；默认 15s，非正值停用（测试用小值加速）。 */
    keepaliveMs?: number
    /** 事件代标识（默认随机 UUID；测试可注入固定值）。 */
    bootId?: string
    /** 续传 ring 帧数上限；默认 256（测试可调小验证淘汰）。 */
    ringMaxFrames?: number
    /** 续传 ring 字节上限；默认 1 MiB（测试可调小验证淘汰）。 */
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
   * 发布事件（严格顺序：组装脱敏 -> 编码 -> 持久化 -> 推进内存 -> 入 ring -> 广播）。
   * buildEvent/persistSeq 失败均抛出且不推进水位、不入 ring、不广播——持久化
   * 报错绝不留下裸 seq（否则下一次成功发布会在 ring 里形成缺口，续传时假承诺）。
   * 帧只编码一次（不可变字节），ring 重放与全部订阅者共享同一份。
   */
  publish(type: string, payload: unknown): void {
    const nextSeq = this.seqValue + 1
    const event = this.buildEvent(type, payload)
    const frame: HelmEventFrame = { seq: nextSeq, event }
    // V8 无法 freeze 非空 TypedArray 视图；不可变性由结构保证：ring 只存这份独立
    // 编码字节（不共享事件对象图，订阅者改对象改不到重放数据），宿主内全部消费
    // 路径（ring 重放 / controller.enqueue）均只读，绝不回写。
    const chunk = encodeSseChunk(String(event.type), frame)
    this.persistSeq(nextSeq)
    this.seqValue = nextSeq
    this.pushRing(nextSeq, chunk)
    for (const deliver of [...this.subscribers]) {
      try {
        deliver(frame, chunk)
      } catch {
        // 订阅方回调抛错只隔离自身（各订阅内部自行清理），不影响其他订阅者。
      }
    }
  }

  /** ring 追加：非连续 append（防御：任何途径产生的裸 seq 缺口）先作废旧区段，
   * 从本帧重建；帧数/字节超限从头淘汰保持连续；单帧超字节预算即清空，
   * 禁止任何客户端跨该帧续传（宁可回退 snapshot，不越缺口假成功）。 */
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

  /** 当前快照（供 HTTP GET 与 SSE 首帧复用）；经 prune + 递归脱敏后返回，
   * 并注入实例 bootId（事件代单一事实来源）。 */
  currentSnapshot(): HelmSnapshot {
    const snap = this.snapshot()
    const redacted = redactJsonValue(pruneUndefined(snap, new WeakSet()), (t) => this.redact(t)) as HelmSnapshot
    return { ...redacted, seq: Math.max(snap.seq, this.seqValue), bootId: this.bootId }
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
   * HTTP SSE 响应：立即返回 Response；首帧 snapshot（或续传 resumed），随后按 seq 增量。
   * `?afterSeq`+`?bootId` 双凭据校验通过则首帧改发 resumed 并按 seq 补发 ring 缓存帧；
   * 跨代/未来 seq/缓存缺口一律回退 snapshot；畸形凭据显式 400。
   * 重放字节不经 start 一次性入队（消费者尚未 pull 会撞上 1 MiB 排队预算，误杀快
   * 消费者），而是统一进入冲刷队列由 pull 按消费者节奏逐步冲刷；冲刷期间新到达的
   * 实时帧计入独立慢消费者预算（replay 引用共享 ring 字节，不重复计数）。
   * request.signal abort 与 ReadableStream.cancel 都退订关流；无事件时保持连接，
   * 绝不回退 JSON；空闲期间按 keepaliveMs 周期写入 `: keepalive` 注释行（仅在冲刷
   * 完成后启动，冲刷期数据本身流动；心跳走统一 write 背压路径，abort/cancel/close
   * 随 shutdown 一并清理 timer）。
   */
  response(request: Request): Response {
    const query = EventHub.parseResumeQuery(request)
    if (query.error !== undefined) {
      // 边界强校验：畸形续传凭据显式 400，绝不静默忽略或半续传。
      return new Response(JSON.stringify({ error: { code: 'invalid_input', message: query.error } }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    /** 冲刷队列条目：replay 引用（共享 ring 字节）或冲刷期间新到达帧/心跳。 */
    interface OutboundEntry {
      chunk: Uint8Array
      /** 计入慢消费者预算的字节数（replay 引用为 0，不重复计数 ring 内存）。 */
      liveBytes: number
    }

    let outbound: OutboundEntry[] = []
    let outboundLiveBytes = 0
    /** 重放/积压冲刷中：业务字节只入冲刷队列，由 pull 按消费者节奏逐步入队。 */
    let flushing = false
    let closed = false
    let unsubscribe: (() => void) | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined

    const write = (chunk: Uint8Array): boolean => {
      const controller = controllerRef
      if (controller === undefined || closed) return false
      // 字节级有界背压：desiredSize = -排队字节数（hwm=0）；超限即慢客户端。
      const queuedBytes = controller.desiredSize === null ? 0 : -controller.desiredSize
      if (queuedBytes + chunk.byteLength > this.maxPendingBytes) return false
      try {
        controller.enqueue(chunk)
        return true
      } catch {
        return false
      }
    }

    /** 冲刷期间到达的帧/心跳入冲刷队列尾（保持严格字节序；新字节计入慢消费者预算）。 */
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
      try {
        controller?.close()
      } catch {
        // 已关：幂等。
      }
    }

    const startKeepalive = (): void => {
      // 空闲心跳：SSE 注释行（: 开头），客户端解析器忽略，绝不伪造业务事件、
      // 不推进 seq；走统一 write 背压路径（不读的慢消费者堆积超限同样关流）。
      if (this.keepaliveMs <= 0 || keepaliveTimer !== undefined || closed) return
      keepaliveTimer = setInterval(() => {
        if (!write(KEEPALIVE_CHUNK)) shutdown()
      }, this.keepaliveMs)
    }

    // 先订阅再同步采样（同 microtask 内完成，缓冲不丢帧）；快照失败同步抛给 HTTP 层。
    const handle = this.openStream(
      (frame, chunk) => {
        if (closed) return false
        // 冲刷期间到达的帧排在重放之后（严格字节序）；冲刷完转流式直写（字节背压接管）。
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
      // 续传：采样 headSeq + ring 切片（订阅已建立，此后发布进冲刷队列/直写，无窗口）。
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
          // 握手帧直接写入（受字节预算约束）；重放字节绝不在此入队——留给 pull
          // 按消费者节奏逐步冲刷，避免消费者尚未 pull 就撞满 1 MiB 排队预算。
          if (!write(handshake)) {
            shutdown()
            return
          }
          outbound = replay.map((chunk) => ({ chunk, liveBytes: 0 }))
          flushing = outbound.length > 0
          // 冲刷订阅缓冲（seq > liveSeq 的帧）：冲刷中入冲刷队列尾，否则直写。
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
          // pull 语义：消费者已持有 pending read，本次入队直接满足读取，不堆积排队预算。
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
      },
      // hwm=0：desiredSize 恒为 -排队字节数，供 write 做慢客户端判定；pull 仅在
      // 队列空且存在 pending read 时触发，冲刷阶段每次至多入队一帧。
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

  /** 解析 `?afterSeq`/`?bootId` 续传查询：不携带即普通连接；携带则必须成对、不
   * 重复且形状合法（非负安全整数 / 长度 1..64 的非空字符串），畸形/重复显式 400，
   * 绝不半续传（URLSearchParams.get 会吞重复参数，重复即拒绝）。 */
  private static parseResumeQuery(request: Request): { resume?: { afterSeq: number; bootId: string }; error?: string } {
    let params: URLSearchParams
    try {
      params = new URL(request.url).searchParams
    } catch {
      return { error: '无法解析请求 URL 查询参数' }
    }
    const afterSeqAll = params.getAll('afterSeq')
    const bootIdAll = params.getAll('bootId')
    if (afterSeqAll.length > 1 || bootIdAll.length > 1) {
      return { error: '?afterSeq 与 ?bootId 不得重复携带' }
    }
    if (afterSeqAll.length === 0 && bootIdAll.length === 0) return {}
    if (afterSeqAll.length === 0 || bootIdAll.length === 0) {
      return { error: '?afterSeq 与 ?bootId 必须成对携带才能续传' }
    }
    const afterSeqRaw = afterSeqAll[0]!
    const bootIdRaw = bootIdAll[0]!
    if (!/^\d{1,16}$/.test(afterSeqRaw) || !Number.isSafeInteger(Number(afterSeqRaw))) {
      return { error: 'afterSeq 必须是非负安全整数' }
    }
    if (bootIdRaw.length === 0 || bootIdRaw.length > 64) {
      return { error: 'bootId 必须是长度 1..64 的非空字符串' }
    }
    return { resume: { afterSeq: Number(afterSeqRaw), bootId: bootIdRaw } }
  }

  /** 续传可行性：同代、不越未来，且需要的 (afterSeq, headSeq] 非空时必须被 ring
   * 完整连续覆盖（首帧 <= afterSeq+1、末帧恰为当前 head、区段内逐帧 +1 连续；
   * ring 最多 256 帧线性检验足够），任一不满足回退 snapshot——末帧缺失会让客户端
   * 永远追不平 headSeq（心跳仍到、空闲看门狗不触发），绝不发假 resumed 承诺；
   * afterSeq == headSeq（已追平头部）零补发续传，但同样必须同代。 */
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
   * 建立带缓冲的内部订阅：订阅先入缓冲（帧与预编码字节一同入队，冲刷时零重编码），
   * goLive(snapshotSeq) 冲刷 seq 更新的缓冲帧后转实时。onFrame 返回 false
   * （写入失败/溢出/消费者停止）或抛错都立即退订并回调 onStop。
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
          // 订阅建立即缓冲阶段溢出（provider 同步重入发布才会触发）：同样明确关流。
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

  /**
   * 把 (type, payload) 组装为协议 HelmEvent；先 prune 可选 undefined，再整体递归
   * JSON 脱敏（字符串值与字段名都过 redact）。core 类型接受直接 payload 或完整
   * 事件信封；未知 type 走 CustomHelmEvent {type, payload} 原样透传（不伪报成
   * notification）；任何非法 JSON 值（循环、Date、Map 等）或 core 类型字段形状不符
   * 均抛 HelmError 不静默降级、不静默修正。
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
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const conversation = source?.['conversation'] ?? source
        assertConversationSummaryShape(conversation)
        return { type, conversation: conversation as ConversationSummary }
      }
      case 'conversation.deleted': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const conversationId = Number(source?.['conversationId'])
        if (!Number.isInteger(conversationId)) {
          throw new HelmError('invalid_event', 'conversation.deleted 需要 number conversationId', 500)
        }
        return { type, conversationId }
      }
      case 'conversation.entry': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const conversationId = Number(source?.['conversationId'])
        const entry = source?.['entry']
        if (!Number.isInteger(conversationId)) {
          throw new HelmError('invalid_event', 'conversation.entry 需要 number conversationId', 500)
        }
        if (
          entry === null ||
          typeof entry !== 'object' ||
          typeof (entry as { id?: unknown }).id !== 'string' ||
          typeof (entry as { kind?: unknown }).kind !== 'string'
        ) {
          throw new HelmError(
            'invalid_event',
            'conversation.entry 需要 { id: string; kind: string; ... } 形状的 entry',
            500,
          )
        }
        return { type, conversationId, entry: entry as ConversationEntry }
      }
      case 'conversation.live': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const live = source?.['live']
        if (
          live === null ||
          typeof live !== 'object' ||
          !Number.isInteger((live as { conversationId?: unknown }).conversationId) ||
          typeof (live as { text?: unknown }).text !== 'string' ||
          !Array.isArray((live as { tools?: unknown }).tools) ||
          !Number.isFinite((live as { updatedAt?: unknown }).updatedAt)
        ) {
          throw new HelmError(
            'invalid_event',
            'conversation.live 需要 { conversationId, text, tools, updatedAt } 形状的 live',
            500,
          )
        }
        return { type, live: live as ConversationLive }
      }
      case 'ask.upsert': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const ask = source?.['ask'] ?? source
        assertAskSpecShape(ask)
        return { type, ask: ask as AskSpec }
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
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const plugin = source?.['plugin']
        const ui = source?.['ui']
        if (
          plugin === null ||
          typeof plugin !== 'object' ||
          typeof (plugin as { id?: unknown }).id !== 'string' ||
          !Array.isArray(ui)
        ) {
          throw new HelmError(
            'invalid_event',
            'plugin.changed 需要 { plugin: PluginSummary; ui: PluginUiContribution[] }（停用/卸载时 ui 为空数组）',
            500,
          )
        }
        return { type, plugin: plugin as HelmSnapshot['plugins'][number], ui: ui as HelmSnapshot['ui'] }
      }
      case 'plugin.doc.updated': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const doc = source?.['doc']
        if (
          doc === null ||
          typeof doc !== 'object' ||
          typeof (doc as { pluginId?: unknown }).pluginId !== 'string' ||
          typeof (doc as { name?: unknown }).name !== 'string' ||
          !('value' in (doc as Record<string, unknown>))
        ) {
          throw new HelmError(
            'invalid_event',
            'plugin.doc.updated 需要 { pluginId: string; name: string; value } 形状的 doc',
            500,
          )
        }
        return { type, doc: doc as PublicPluginDoc }
      }
      case 'plugin.session_doc.updated': {
        // 全局流防御性拒绝：会话文档事件只允许专用流（SessionDocEventHub），
        // 误投全局广播属于契约违约，显式报错而不是降级透传（防写放大回归）。
        throw new HelmError(
          'invalid_event',
          'plugin.session_doc.updated 不允许进入全局事件流（仅专用会话文档 SSE）',
          500,
        )
      }
      case 'node.changed': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const node = source?.['node']
        const removed = source?.['removed']
        if (
          node === null ||
          typeof node !== 'object' ||
          typeof (node as { id?: unknown }).id !== 'string' ||
          (node as { id?: unknown }).id === '' ||
          ((node as { kind?: unknown }).kind !== 'local' && (node as { kind?: unknown }).kind !== 'byom') ||
          typeof (node as { online?: unknown }).online !== 'boolean'
        ) {
          throw new HelmError(
            'invalid_event',
            "node.changed 需要 { node: { id: string; kind: 'local' | 'byom'; online: boolean; ... } } 形状（removed 可选）",
            500,
          )
        }
        if (removed !== undefined && typeof removed !== 'boolean') {
          throw new HelmError('invalid_event', 'node.changed 的 removed 若有必须为 boolean', 500)
        }
        return {
          type,
          node: node as NodeInfo,
          ...(typeof removed === 'boolean' ? { removed } : {}),
        }
      }
      case 'notification': {
        const source = (envelope ?? record) as Record<string, unknown> | undefined
        const level = source?.['level']
        const title = source?.['title']
        const body = source?.['body']
        const conversationId = source?.['conversationId']
        if (level !== 'info' && level !== 'warning' && level !== 'error') {
          throw new HelmError('invalid_event', "notification 需要 level 为 'info' | 'warning' | 'error'", 500)
        }
        if (typeof title !== 'string' || title === '') {
          throw new HelmError('invalid_event', 'notification 需要 title 为非空字符串', 500)
        }
        if (body !== undefined && typeof body !== 'string') {
          throw new HelmError('invalid_event', 'notification 的 body 若有必须为 string', 500)
        }
        if (conversationId !== undefined && (typeof conversationId !== 'number' || !Number.isInteger(conversationId))) {
          throw new HelmError('invalid_event', 'notification 的 conversationId 若有必须为整数', 500)
        }
        return {
          type,
          level,
          title,
          ...(body !== undefined ? { body } : {}),
          ...(conversationId !== undefined ? { conversationId } : {}),
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

/** 会话文档订阅首帧：{seq, doc}；由 HTTP 层经同步 provider 原子读取。 */
export interface SessionDocSnapshot {
  seq: number
  doc: PublicPluginSessionDoc
}

interface SessionDocStreamEntry {
  target: { pluginId: string; name: string; conversationId: number }
  stop: () => void
}

/** 缓冲阶段的未决帧（保留 seq，冲刷时只发 seq > snapshot.seq 的帧）。 */
interface SessionDocQueuedFrame {
  seq: number
  chunk: string
}

/**
 * SessionDocEventHub：会话文档专用事件面。
 *
 * plugin.session_doc.updated 绝不进入全局 /api/events（写放大与跨会话泄漏）；
 * 本枢纽只把 (pluginId, name, conversationId) 三元组的更新分发给订阅了该
 * 三元组的专用 SSE 流。帧形状与全局流一致（HelmEventFrame {seq, event}），
 * seq 只维护本枢纽自己的单调计数；首帧 snapshot 由 response 的同步 provider
 * （如 kernel.plugins.getPublicSessionDoc）在订阅建立之后调用，保证
 * 「先订阅缓冲、后取快照」的原子窗口——快照与首帧增量之间不丢帧、不重复。
 *
 * 生命周期：response 为每条流登记 (target, stop)；hub.close() 真正关闭全部
 * 流（ReadableStream close + 退订）；closeForPlugin/closeForConversation 由
 * runtime 监听 core 事件驱动（plugin.changed enabled=false / conversation.deleted），
 * 事件驱动而非轮询，无外部调用时零开销。
 */
export class SessionDocEventHub {
  private seqValue = 0
  private readonly subscribers = new Map<string, Set<(frame: HelmEventFrame) => void>>()
  /** 每条专用流的关闭句柄（close()/定向关闭用；同一三元组多连接各自登记）。 */
  private readonly streams = new Set<SessionDocStreamEntry>()
  /** 订阅建立到快照冲刷完成之间的未决帧数上限（溢出即慢客户端，关流重连）。 */
  private readonly maxPending = MAX_PENDING_EVENTS
  /** 流式阶段未读字节上限（默认 1 MiB；慢客户端显式关流，绝不无限排队）。 */
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

  /** 当前活跃订阅数（实际监听器个数，诊断与测试用）。 */
  get subscriberCount(): number {
    let total = 0
    for (const set of this.subscribers.values()) total += set.size
    return total
  }

  /** 真正关闭全部专用流并清空订阅（kernel.close 时调用，杜绝泄漏）。 */
  close(): void {
    this.closeStreams(() => true)
    this.subscribers.clear()
  }

  /** 关闭指定插件的全部专用流（插件停用/注销：plugin.changed enabled=false）。 */
  closeForPlugin(pluginId: string): void {
    this.closeStreams((entry) => entry.target.pluginId === pluginId)
  }

  /** 关闭指定会话的全部专用流（会话删除：conversation.deleted）。 */
  closeForConversation(conversationId: number): void {
    this.closeStreams((entry) => entry.target.conversationId === conversationId)
  }

  private closeStreams(match: (entry: SessionDocStreamEntry) => boolean): void {
    for (const entry of [...this.streams]) {
      if (match(entry)) entry.stop()
    }
  }

  /**
   * 发布一条会话文档更新：只投递订阅了该三元组的监听器。
   * 载荷在边界做形状校验 + JSON 脱敏（与 EventHub.buildEvent 同一纪律），
   * 非法载荷显式抛 HelmError 且不推进 seq，绝不静默降级。
   */
  dispatch(payload: unknown): void {
    // 先做形状门禁（doc 为 null/非对象时不得进入任何字段读取），
    // 再校验三元组字段，最后脱敏组装。
    const source = (payload ?? undefined) as { type?: unknown; doc?: unknown } | undefined
    const doc = source?.['doc']
    if (doc === null || typeof doc !== 'object') {
      throw new HelmError(
        'invalid_event',
        'plugin.session_doc.updated 需要 { pluginId: string; name: string; conversationId: number; value } 形状的 doc',
        500,
      )
    }
    const record = doc as Record<string, unknown>
    const pluginId = record['pluginId']
    const name = record['name']
    const conversationId = record['conversationId']
    if (
      typeof pluginId !== 'string' ||
      pluginId === '' ||
      typeof name !== 'string' ||
      name === '' ||
      typeof conversationId !== 'number' ||
      !Number.isSafeInteger(conversationId) ||
      conversationId <= 0 ||
      !('value' in record)
    ) {
      throw new HelmError(
        'invalid_event',
        'plugin.session_doc.updated 需要 { pluginId: string; name: string; conversationId: number; value } 形状的 doc',
        500,
      )
    }
    if (record['deleted'] !== undefined && record['deleted'] !== true) {
      throw new HelmError('invalid_event', 'plugin.session_doc.updated 的 deleted 若有必须为 true', 500)
    }
    const clean = redactJsonValue(doc as PublicPluginSessionDoc, (t) => this.redactFn(t)) as PublicPluginSessionDoc
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
        // 订阅方回调抛错只隔离自身（各订阅内部自行清理），不影响其他订阅者。
      }
    }
  }

  /**
   * 订阅指定三元组的增量帧；返回退订函数。
   * 与 EventHub.subscribe 同名语义：HTTP 层先订阅缓冲再同步取快照。
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
   * 专用 SSE 响应：首帧 `event: snapshot`（PluginSessionDocSnapshot {seq, doc}），
   * 随后 `event: plugin.session_doc.updated` + HelmEventFrame 增量。
   *
   * 原子窗口：先建立缓冲订阅，再同步调用 options.snapshot provider 读取快照
   * （provider 同时完成 public/会话存在性再校验，失败同步抛给 HTTP 层），
   * 发送快照后只冲刷 seq > snapshot.seq 的缓冲帧——不丢帧、不重复。
   * provider 出错或 request 已 abort：同步退订清理，不建流。
   *
   * 背压与清理：缓冲阶段受 MAX_PENDING_EVENTS 限制，流式阶段以
   * controller.desiredSize（hwm=0，恒为 -排队字节数）做字节上限判定，
   * 超限即慢客户端，显式关流退订（绝不无限排队）；abort / cancel /
   * hub 定向关闭同样关流。重连即重新订阅并重置 snapshot（无跨连接残留）。
   */
  response(
    request: Request,
    options: {
      /** 同步快照 provider：在订阅建立后调用，返回 {seq, doc}；出错同步抛。 */
      snapshot: () => SessionDocSnapshot
      target: { pluginId: string; name: string; conversationId: number }
    },
  ): Response {
    const encoder = new TextEncoder()
    /** 快照冲刷完成前的未决帧（此后改用流内字节背压）。 */
    let pending: SessionDocQueuedFrame[] = []
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

    /** shutdown 注册句柄；provider 阶段（尚未登记）为 undefined，删除幂等。 */
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
      try {
        controller?.close()
      } catch {
        // 已关：幂等。
      }
    }

    // 先订阅缓冲（与快照读取同一同步窗口，不丢帧；缓冲帧保留 seq 供冲刷筛选）。
    unsubscribe = this.subscribe(options.target, (frame) => {
      if (closed) return
      const chunk = encodeFrame('plugin.session_doc.updated', frame)
      if (streaming) {
        if (!write(chunk)) shutdown()
        return
      }
      if (pending.length >= this.maxPending) {
        // 快照尚未冲刷完就积压超限（provider 同步重入发布才会触发）：明确关流。
        shutdown()
        return
      }
      pending.push({ seq: frame.seq, chunk })
    })

    // 再同步取快照（provider 失败/已 abort：同步退订，不建流、不伪造快照）。
    let snap: SessionDocSnapshot
    try {
      if (request.signal.aborted) throw new HelmError('aborted', '订阅建立前请求已中断', 499)
      snap = options.snapshot()
    } catch (error) {
      shutdown()
      throw error
    }
    const snapshotChunk = encodeFrame('snapshot', snap)
    streamEntry = { target: options.target, stop: shutdown }
    if (!closed) this.streams.add(streamEntry)

    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          controllerRef = controller
          if (closed) {
            controller.close()
            return
          }
          if (request.signal.aborted) {
            shutdown()
            return
          }
          request.signal.addEventListener('abort', shutdown)
          // 订阅缓冲已建立且快照已取定：先发首帧 snapshot，再冲刷 seq 更新的
          // 缓冲帧（seq <= snapshot.seq 的已体现在快照里，重发即重复）。
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

}
