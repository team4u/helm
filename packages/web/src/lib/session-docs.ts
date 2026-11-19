/**
 * 插件会话级文档（sessionDoc）单流多路复用订阅通道：
 *
 * 与全局 ctx.doc 不同，sessionDoc 绝不进全局 /api/events 广播与首帧快照；
 * 浏览器内所有活跃的 `(pluginId, docName, conversationId)` 订阅经过短防抖
 * （默认 50ms，可通过 `sessionDocTimings.subscribeDebounceMs` 注入）聚合成
 * 单条共享 SSE 连接 `GET /api/session-docs/events?sub=...&sub=...`（使用
 * `@helmx/protocol/browser` 的 `encodeSessionDocSubParam`）：
 * - ref-count：首个订阅者触发建流（初始值由首帧 `action: 'snapshot'` 下发），
 *   订阅集合不变时不重建流，活跃集合归零时立即关闭流并清缓存；
 * - 鉴权：所有出站请求统一携带 `Authorization: Bearer`（token 经 api.ts
 *   `getStoredToken` 读取）；测试经 `bindSessionDocRuntime` 注入 fetch/token；
 * - 连接代际：全局 `generation` + 流 `connEpoch`，abort / retry / 重连 /
 *   集合变更 / reset 均推进代际，旧连接迟到帧或迟到响应一律丢弃；
 * - 多路隔离与帧序：按 `(pluginId, name, conversationId)` 独立维护 `lastSeq`
 *   水位与状态；`snapshot` 重置该 tuple 的 `lastSeq` 基线，`updated` / `deleted`
 *   按 `seq` 单调递增（迟到旧帧丢弃），`deleted` 携带初始值（reset 语义）；
 * - 空闲看门狗：`readSseChunkWithDeadline(..., 30_000)` 对齐内核 15s keepalive，
 *   防止半开僵尸流；断流按有界指数退避重连，401 发 `helmx:unauthorized`，
 *   非重试 4xx 置错停止自动重试（可经 `retrySessionDoc` 显式重试）；
 * - evict（插件停用/会话删除）：向仍挂载订阅者显式报错，保留错误至退订。
 */
import {
  encodeSessionDocSubParam,
  type PublicPluginSessionDoc,
  type SessionDocMultiplexFrame,
} from '@helmx/protocol/browser'
import { getStoredToken } from './api.js'
import { readSseChunkWithDeadline, SseParser } from './live-state.js'

export interface SessionDocKey {
  pluginId: string
  docName: string
  conversationId: number
}

const keyString = (key: SessionDocKey): string => `${key.pluginId}\u0000${key.docName}\u0000${key.conversationId}`

/** 单个 (pluginId, docName, conversationId) 元组的共享订阅状态。 */
interface EntryState {
  key: SessionDocKey
  /** 挂载中的订阅者数（useSyncExternalStore 订阅 + 组件挂载）。 */
  refs: number
  /** 条目是否仍存活（teardown 后为 false，迟到写入一律丢弃）。 */
  alive: boolean
  /** 缓存值；deleted 帧按协议携带 value=initial（reset 语义），照常暴露。 */
  value?: unknown
  hasValue: boolean
  /** 已收到 deleted:true。 */
  deleted: boolean
  /** 当前连接内该 tuple 最新已应用帧的 seq；每次收到 snapshot 重置。 */
  lastSeq: number
  connected: boolean
  error?: string
  /** 非重试 4xx 标记（停止自动重试，直到显式 retrySessionDoc）。 */
  permanentError?: boolean
  /** 终态原因（插件停用/会话删除/非法订阅键）：置位后永不重连。 */
  terminated?: string
  /** getSnapshot 缓存（引用稳定，值未变时复用）。 */
  snapshot?: { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean }
}

interface ListenerEntry {
  listener: () => void
  entry: EntryState
}

/** 共享多路复用 SSE 流状态。 */
interface MultiplexStreamState {
  activeSignature: string
  streamKeys: Set<string>
  connEpoch: number
  controller?: AbortController
  retry: number
  retryTimer?: ReturnType<typeof setTimeout>
  debounceTimer?: ReturnType<typeof setTimeout>
  debounceMicrotaskPending: boolean
  haltedSignature?: string
}

const entries = new Map<string, EntryState>()
const listeners = new Set<ListenerEntry>()
/** 全局代际：登出清理时 ++，所有在途请求携带旧代际结果直接丢弃。 */
let generation = 0

const stream: MultiplexStreamState = {
  activeSignature: '',
  streamKeys: new Set(),
  connEpoch: 0,
  retry: 0,
  debounceMicrotaskPending: false,
}

/** 会话文档 SSE 时序参数（集中定义；对象引用共享，测试可临时改写后复原）。 */
export const sessionDocTimings = {
  reconnectBaseMs: 1_000,
  reconnectCapMs: 15_000,
  /** 订阅集合变更聚合防抖延迟（毫秒）；为 0 时以微任务合并同批挂载，测试无慢 sleep。 */
  subscribeDebounceMs: 50,
  /** 多路复用 SSE 空闲看门狗阈值（毫秒），对齐内核 15s keepalive。 */
  idleTimeoutMs: 30_000,
}

function notify(entry: EntryState): void {
  for (const item of [...listeners]) {
    if (item.entry === entry) item.listener()
  }
}

function newEntry(key: SessionDocKey): EntryState {
  return { key, refs: 0, alive: true, hasValue: false, deleted: false, lastSeq: -1, connected: false }
}

/** 边界校验文档形状或目标不匹配抛显式错误（诚实性纪律，不静默吞帧）。 */
function assertSessionDocShape(doc: unknown, expected: SessionDocKey): PublicPluginSessionDoc {
  if (doc === null || typeof doc !== 'object') throw new Error('Invalid conversation document frame format')
  const d = doc as Record<string, unknown>
  if (
    typeof d['pluginId'] !== 'string' ||
    typeof d['name'] !== 'string' ||
    !Number.isSafeInteger(d['conversationId']) ||
    d['conversationId'] !== expected.conversationId
  ) {
    throw new Error('Invalid conversation document frame format')
  }
  if (d['pluginId'] !== expected.pluginId || d['name'] !== expected.docName) {
    throw new Error(`Conversation document frame target mismatch: ${String(d['pluginId'])}/${String(d['name'])}`)
  }
  if (!('value' in d)) throw new Error('Conversation document frame missing the value field')
  if ('deleted' in d && d['deleted'] !== undefined && typeof d['deleted'] !== 'boolean') {
    throw new Error('Invalid conversation document frame format')
  }
  return d as unknown as PublicPluginSessionDoc
}

/** 写入文档状态；delete 帧 value=initial（reset 语义）照常落值。 */
function applyDoc(entry: EntryState, doc: PublicPluginSessionDoc): void {
  entry.error = undefined
  entry.permanentError = undefined
  entry.deleted = doc.deleted === true
  entry.value = doc.value
  entry.hasValue = true
}

async function responseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body?.error?.message) message = body.error.message
  } catch { /* Non-JSON error body keeps the status code description */ }
  return message
}

interface SubscribedEntryItem {
  id: string
  entry: EntryState
  param: string
}

function collectActiveSubscriptions(): SubscribedEntryItem[] {
  const items: SubscribedEntryItem[] = []
  for (const [id, entry] of [...entries.entries()]) {
    if (!entry.alive || entry.refs <= 0 || entry.terminated !== undefined || entry.permanentError === true) {
      continue
    }
    try {
      const param = encodeSessionDocSubParam({
        pluginId: entry.key.pluginId,
        name: entry.key.docName,
        conversationId: entry.key.conversationId,
      })
      items.push({ id, entry, param })
    } catch (err) {
      terminateEntry(entry, err instanceof Error ? err.message : String(err))
    }
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items
}

function abortMultiplexStream(): void {
  if (stream.debounceTimer !== undefined) {
    clearTimeout(stream.debounceTimer)
    stream.debounceTimer = undefined
  }
  stream.debounceMicrotaskPending = false
  if (stream.retryTimer !== undefined) {
    clearTimeout(stream.retryTimer)
    stream.retryTimer = undefined
  }
  stream.controller?.abort()
  stream.controller = undefined
  stream.connEpoch++
  stream.activeSignature = ''
  stream.streamKeys = new Set()
  stream.haltedSignature = undefined
  stream.retry = 0
}

function scheduleStreamSync(): void {
  if (stream.debounceTimer !== undefined) {
    clearTimeout(stream.debounceTimer)
    stream.debounceTimer = undefined
  }
  const gen = generation
  if (sessionDocTimings.subscribeDebounceMs <= 0) {
    if (stream.debounceMicrotaskPending) return
    stream.debounceMicrotaskPending = true
    queueMicrotask(() => {
      stream.debounceMicrotaskPending = false
      if (gen === generation) syncMultiplexStream(gen)
    })
    return
  }
  stream.debounceTimer = setTimeout(() => {
    stream.debounceTimer = undefined
    if (gen === generation) syncMultiplexStream(gen)
  }, sessionDocTimings.subscribeDebounceMs)
}

function syncMultiplexStream(gen: number): void {
  if (gen !== generation) return
  const items = collectActiveSubscriptions()
  if (items.length === 0) {
    abortMultiplexStream()
    return
  }
  const signature = items.map((item) => item.param).join('\0')
  if (
    signature === stream.activeSignature &&
    (stream.controller !== undefined || stream.retryTimer !== undefined || stream.haltedSignature === signature)
  ) {
    return
  }
  if (stream.retryTimer !== undefined) {
    clearTimeout(stream.retryTimer)
    stream.retryTimer = undefined
  }
  stream.haltedSignature = undefined
  stream.retry = 0
  stream.controller?.abort()
  stream.controller = undefined
  stream.connEpoch++
  stream.activeSignature = signature
  stream.streamKeys = new Set(items.map((item) => item.id))
  connectMultiplexStream(items, signature, gen)
}

function connectMultiplexStream(items: SubscribedEntryItem[], signature: string, gen: number): void {
  if (gen !== generation || stream.activeSignature !== signature || items.length === 0) return
  const myConn = stream.connEpoch
  const controller = new AbortController()
  stream.controller = controller

  const params = new URLSearchParams()
  for (const item of items) params.append('sub', item.param)
  const url = `/api/session-docs/events?${params.toString()}`
  const streamLabel = items.map((item) => `${item.entry.key.pluginId}/${item.entry.key.docName}#${item.entry.key.conversationId}`).join(', ')

  const isStreamActive = (): boolean =>
    gen === generation &&
    stream.connEpoch === myConn &&
    stream.activeSignature === signature &&
    !controller.signal.aborted

  const reportStreamError = (message: string): void => {
    for (const item of items) {
      if (!item.entry.alive || item.entry.refs <= 0 || item.entry.terminated !== undefined) continue
      item.entry.error = message
      notify(item.entry)
    }
  }

  const run = async (): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    // Node fetch 语义：signal abort 不一定传递到底层流 cancel，
    // 显式监听并 cancel reader；仅当仍是当前流 controller 时才置空，防止误清新连接。
    const onAbort = (): void => {
      if (stream.controller === controller) stream.controller = undefined
      void reader?.cancel().catch(() => {})
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const token = tokenProvider()
      const res = await resolvedFetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!isStreamActive()) {
        void res.body?.cancel().catch(() => {})
        return
      }
      if (res.status === 401) {
        stream.haltedSignature = signature
        for (const item of items) {
          if (!item.entry.alive || item.entry.refs <= 0 || item.entry.terminated !== undefined) continue
          if (item.entry.connected) {
            item.entry.connected = false
            notify(item.entry)
          }
        }
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('helmx:unauthorized'))
        return
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const msg = await responseErrorMessage(res)
        if (!isStreamActive()) return
        stream.haltedSignature = signature
        for (const item of items) {
          if (!item.entry.alive || item.entry.refs <= 0 || item.entry.terminated !== undefined) continue
          const label = `${item.entry.key.pluginId}/${item.entry.key.docName}#${item.entry.key.conversationId}`
          item.entry.error = `Conversation document subscription unavailable (${label}): ${msg}`
          item.entry.connected = false
          item.entry.permanentError = true
          notify(item.entry)
        }
        return
      }
      if (!res.ok || !res.body) throw new Error(await responseErrorMessage(res))

      stream.retry = 0
      for (const item of items) {
        if (!item.entry.alive || item.entry.refs <= 0 || item.entry.terminated !== undefined) continue
        const changed = item.entry.error !== undefined || !item.entry.connected
        item.entry.error = undefined
        item.entry.permanentError = undefined
        item.entry.connected = true
        if (changed) notify(item.entry)
      }

      const parser = new SseParser((message) => {
        if (!isStreamActive()) return
        let payload: unknown
        try {
          payload = JSON.parse(message.data)
        } catch {
          reportStreamError(`Conversation document subscription stream invalid (${streamLabel})`)
          return
        }
        const frame = payload as Partial<SessionDocMultiplexFrame> | null
        if (
          frame === null ||
          typeof frame !== 'object' ||
          (frame.action !== 'snapshot' && frame.action !== 'updated' && frame.action !== 'deleted') ||
          typeof frame.pluginId !== 'string' ||
          typeof frame.name !== 'string' ||
          !Number.isSafeInteger(frame.conversationId) ||
          !Number.isSafeInteger(frame.seq) ||
          (frame.seq as number) < 0 ||
          !('doc' in frame)
        ) {
          reportStreamError(`Conversation document subscription frame invalid (${streamLabel})`)
          return
        }
        const tupleKey: SessionDocKey = {
          pluginId: frame.pluginId,
          docName: frame.name,
          conversationId: frame.conversationId as number,
        }
        const tupleId = keyString(tupleKey)
        if (!stream.streamKeys.has(tupleId)) {
          reportStreamError(`Conversation document frame target mismatch: ${frame.pluginId}/${frame.name}#${frame.conversationId}`)
          return
        }
        const entry = entries.get(tupleId)
        if (entry === undefined || !entry.alive || entry.refs <= 0 || entry.terminated !== undefined) {
          return
        }
        const label = `${entry.key.pluginId}/${entry.key.docName}#${entry.key.conversationId}`
        let doc: PublicPluginSessionDoc
        try {
          doc = assertSessionDocShape(frame.doc, entry.key)
        } catch (err) {
          entry.error = `Conversation document frame invalid (${label}): ${err instanceof Error ? err.message : String(err)}`
          notify(entry)
          return
        }
        if (frame.action === 'snapshot') {
          // 重连/建流对齐：按 tuple 重置 seq 基线并无条件应用快照。
          entry.lastSeq = frame.seq as number
          applyDoc(entry, doc)
          notify(entry)
          return
        }
        // updated / deleted：按 tuple 隔离单调递增（迟到旧帧 <= lastSeq 静默丢弃）。
        if ((frame.seq as number) <= entry.lastSeq) return
        entry.lastSeq = frame.seq as number
        applyDoc(entry, frame.action === 'deleted' ? { ...doc, deleted: true } : doc)
        notify(entry)
      })

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const read = await readSseChunkWithDeadline(reader, sessionDocTimings.idleTimeoutMs, controller.signal)
        if (read.kind === 'idle') {
          throw new Error('Subscription stream idle timeout; reconnecting')
        }
        if (read.chunk.done) break
        parser.push(decoder.decode(read.chunk.value, { stream: true }))
        if (!isStreamActive()) return
      }
      throw new Error('Subscription stream closed')
    } catch (error) {
      if (controller.signal.aborted || !isStreamActive()) return
      const errMsg = error instanceof Error ? error.message : String(error)
      for (const item of items) {
        if (!item.entry.alive || item.entry.refs <= 0 || item.entry.terminated !== undefined) continue
        const label = `${item.entry.key.pluginId}/${item.entry.key.docName}#${item.entry.key.conversationId}`
        item.entry.error = `Conversation document subscription interrupted (${label}): ${errMsg}`
        item.entry.connected = false
        notify(item.entry)
      }
      if (stream.controller === controller) stream.controller = undefined
      controller.abort()
      scheduleStreamReconnect(signature, gen)
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      if (reader !== undefined) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (stream.controller === controller) stream.controller = undefined
    }
  }
  void run()
}

function scheduleStreamReconnect(signature: string, gen: number): void {
  if (gen !== generation || stream.activeSignature !== signature || stream.retryTimer !== undefined) return
  const delay = Math.min(
    sessionDocTimings.reconnectBaseMs * 2 ** Math.min(stream.retry++, 4),
    sessionDocTimings.reconnectCapMs,
  )
  stream.retryTimer = setTimeout(() => {
    stream.retryTimer = undefined
    if (gen !== generation || stream.activeSignature !== signature) return
    const items = collectActiveSubscriptions()
    if (items.length === 0) {
      abortMultiplexStream()
      return
    }
    const nextSignature = items.map((item) => item.param).join('\0')
    if (nextSignature !== signature) {
      syncMultiplexStream(gen)
      return
    }
    stream.connEpoch++
    stream.streamKeys = new Set(items.map((item) => item.id))
    connectMultiplexStream(items, signature, gen)
  }, delay)
}

/**
 * 订阅一个 (pluginId, docName, conversationId) 元组；返回退订函数。
 * 同批/短窗口内的订阅聚合到同一条 `/api/session-docs/events` 多路复用流；
 * 最后一个退订关闭流并清缓存。
 */
export function subscribeSessionDoc(key: SessionDocKey, listener: () => void): () => void {
  const id = keyString(key)
  let entry = entries.get(id)
  if (entry === undefined) {
    entry = newEntry(key)
    entries.set(id, entry)
  }
  const item: ListenerEntry = { listener, entry }
  listeners.add(item)
  const firstRef = entry.refs === 0
  entry.refs++
  if (firstRef && entry.terminated === undefined) {
    stream.haltedSignature = undefined
    try {
      encodeSessionDocSubParam({
        pluginId: key.pluginId,
        name: key.docName,
        conversationId: key.conversationId,
      })
      scheduleStreamSync()
    } catch (err) {
      terminateEntry(entry, err instanceof Error ? err.message : String(err))
    }
  }
  return () => {
    listeners.delete(item)
    // 条目可能已被 reset 全局移除：不再重复扣减 refs（防负数）或二次 teardown。
    if (entries.get(id) !== entry) return
    entry.refs--
    if (entry.refs <= 0) {
      teardownEntry(entry)
      scheduleStreamSync()
    }
  }
}

/** 卸载归零：清缓存与条目，若该条目曾属于当前共享流则使 activeSignature 失效以便重订触发建流。 */
function teardownEntry(entry: EntryState): void {
  const id = keyString(entry.key)
  entry.alive = false
  entry.refs = 0
  entry.connected = false
  entry.error = undefined
  entry.permanentError = undefined
  entry.value = undefined
  entry.hasValue = false
  entry.deleted = false
  entry.lastSeq = -1
  entry.terminated = undefined
  entry.snapshot = undefined
  entries.delete(id)
  if (stream.streamKeys.has(id)) {
    stream.activeSignature = ''
    stream.haltedSignature = undefined
  }
}

/** 终止一个条目：显式报错给仍挂载的订阅者（保留至全部退订），永不重连。 */
function terminateEntry(entry: EntryState, message: string): void {
  if (entry.refs <= 0) {
    teardownEntry(entry)
    return
  }
  entry.connected = false
  entry.terminated = message
  entry.error = message
  entry.value = undefined
  entry.hasValue = false
  entry.deleted = false
  entry.snapshot = undefined
  notify(entry)
}

/** 全局中止（登出）：立即中止共享流、清全部条目并推进代际，在途请求结果全部作废。 */
export function resetSessionDocSubscriptions(): void {
  generation++
  abortMultiplexStream()
  for (const entry of [...entries.values()]) teardownEntry(entry)
}

/** 插件停用/卸载：向仍挂载的订阅者显式报错，中止其全部订阅且不再重连。 */
export function evictSessionDocSubscriptions(pluginId: string): void {
  let changed = false
  for (const entry of [...entries.values()]) {
    if (entry.key.pluginId !== pluginId) continue
    terminateEntry(entry, `Plugin ${pluginId} disabled; conversation document subscription aborted`)
    changed = true
  }
  if (changed) {
    if (collectActiveSubscriptions().length === 0) abortMultiplexStream()
    else scheduleStreamSync()
  }
}

/** 会话删除：显式报错并中止该会话全部订阅缓存。 */
export function evictSessionDocsOfConversation(conversationId: number): void {
  let changed = false
  for (const entry of [...entries.values()]) {
    if (entry.key.conversationId === conversationId) {
      terminateEntry(entry, `Conversation ${conversationId} deleted; conversation document subscription aborted`)
      changed = true
    }
  }
  if (changed) {
    if (collectActiveSubscriptions().length === 0) abortMultiplexStream()
    else scheduleStreamSync()
  }
}

/** 读取一个元组当前状态（useSyncExternalStore 快照源；未订阅返回空态）。 */
export function getSessionDocState(
  key: SessionDocKey,
): { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean } {
  const entry = entries.get(keyString(key))
  if (entry === undefined) return EMPTY_STATE
  // useSyncExternalStore 要求快照引用稳定：值未变化时复用上次返回对象
  if (entry.snapshot !== undefined && snapshotUnchanged(entry.snapshot, entry)) return entry.snapshot
  const snapshot = {
    value: entry.value,
    hasValue: entry.hasValue,
    deleted: entry.deleted,
    error: entry.error,
    connected: entry.connected,
  }
  entry.snapshot = snapshot
  return snapshot
}

const EMPTY_STATE = { hasValue: false, deleted: false, connected: false } as const

function snapshotUnchanged(
  snapshot: { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean },
  entry: EntryState,
): boolean {
  return (
    snapshot.hasValue === entry.hasValue &&
    snapshot.deleted === entry.deleted &&
    snapshot.error === entry.error &&
    snapshot.connected === entry.connected &&
    snapshot.value === entry.value
  )
}

/** 订阅者显式重试：清除错误态并立即重建共享流（旧连接因代际推进全部作废）。 */
export function retrySessionDoc(key: SessionDocKey): void {
  const entry = entries.get(keyString(key))
  if (entry === undefined || entry.refs <= 0 || entry.terminated !== undefined) return
  entry.error = undefined
  entry.permanentError = undefined
  notify(entry)
  abortMultiplexStream()
  syncMultiplexStream(generation)
}

// ---------------------------------------------------------------------------
// fetch / token 访问隔离：token 默认直接读 api.ts getStoredToken（api.ts 不
// 依赖本模块，无循环 import）；fetch 默认走 globalThis.fetch（惰性解析）。
// 单测经 bindSessionDocRuntime 注入替身，返回恢复函数还原上一实现，
// 作用域隔离（一个测试/宿主的解绑不破坏其它使用方）。
// ---------------------------------------------------------------------------

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike | undefined
let tokenProvider: () => string | null = getStoredToken

/** 注入 fetch/token 替身（任一参数可省略表示保持不变）；返回恢复上一实现的函数。 */
export function bindSessionDocRuntime(fetch?: FetchLike, token?: () => string | null): () => void {
  const prevFetch = fetchImpl
  const prevToken = tokenProvider
  if (fetch !== undefined) fetchImpl = fetch
  if (token !== undefined) tokenProvider = token
  return () => {
    fetchImpl = prevFetch
    tokenProvider = prevToken
  }
}

const resolvedFetch: FetchLike = (input, init) => {
  const impl = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch
  if (impl === undefined) throw new Error('No fetch implementation in this environment')
  return impl(input, init)
}
