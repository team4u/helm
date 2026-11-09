/**
 * 插件会话级文档（sessionDoc）专用订阅通道（P4）。
 *
 * 与全局 ctx.doc 不同，sessionDoc 绝不进全局 /api/events 广播与首帧快照，
 * 每个 (pluginId, docName, conversationId) 元组独立开一条
 * /api/plugins/:id/docs/:name/events?conversationId=N SSE 订阅流（初始值也来自
 * 该流的首帧 snapshot，不再另发初始 GET，从根上消除 GET/SSE 双通道竞态）：
 * - ref-count：仅当存在实际挂载的订阅者时才连接；归零立即 abort 流、清缓存
 *   与重试定时器，条目彻底移除（下次挂载全新开始）；
 * - 鉴权：所有出站请求统一携带 Authorization: Bearer（token 经 api.ts
 *   getStoredToken 读取；api.ts 不依赖本模块，无循环 import）；测试经
 *   bindSessionDocRuntime 注入 fetch/token，返回恢复函数作用域隔离；
 * - 连接代际：每条目独立 connEpoch，abort/retry/重连/evict 均推进代际，
 *   旧连接的任何异步续写（迟到帧/迟到响应）必须校验条目仍存活且代际一致，
 *   不一致直接丢弃，杜绝旧连接写坏新条目；
 * - 帧序：单一连接内 update 帧按 seq 单调裁决——snapshot 首帧无条件以服务端
 *   为准，其后仅应用 seq 更大的帧（迟到旧帧丢弃）；跨连接 seq 不比较
 *   （专用 hub 文档可重建复位）；seq 必须为非负安全整数；
 * - delete 帧契约：doc.deleted=true 且 value=initial（reset 语义），如实暴露
 *   该初始值而非清空；只有不存在/未初始化/出错才是空态；
 * - 断流按有界指数退避重连；401 发 helm:unauthorized 并停止；非重试 4xx
 *   （400/403/404 等，429 除外）置终态错误不再重连；5xx/网络错误持续退避；
 * - evict（插件停用/会话删除）：先向仍挂载的订阅者显式报错（条目保留至
 *   全部退订，订阅者可读到错误）并中止流，永不重连；
 * - 错误显式暴露给订阅者（getSessionDocState().error），绝不静默降级。
 *
 * 本模块纯逻辑 + 模块级共享状态（不依赖 React），供 store hook 与
 * HelmStoreProvider 集成消费；Node 单测经 bindSessionDocRuntime 注入 fetch。
 */
import type { HelmEventFrame, PluginSessionDocSnapshot, PublicPluginSessionDoc } from '@helm/protocol'
import { getStoredToken } from './api.js'
import { SseParser } from './live-state.js'

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
  /** 连接代际：每次新建连接自增；旧连接的异步写入据此作废。 */
  connEpoch: number
  /** 当前连接内最新已应用帧的 seq；新连接由 snapshot 重置，跨连接不比较。 */
  lastSeq: number
  controller?: AbortController
  connected: boolean
  retry: number
  retryTimer?: ReturnType<typeof setTimeout>
  error?: string
  /** 终态原因（插件停用/会话删除/非重试 4xx）：置位后永不重连。 */
  terminated?: string
  /** getSnapshot 缓存（引用稳定，值未变时复用）。 */
  snapshot?: { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean }
}

interface ListenerEntry {
  listener: () => void
  entry: EntryState
}

const entries = new Map<string, EntryState>()
const listeners = new Set<ListenerEntry>()
/** 全局代际：登出清理时 ++，所有在途请求携带旧代际结果直接丢弃。 */
let generation = 0

function notify(entry: EntryState): void {
  for (const item of [...listeners]) {
    if (item.entry === entry) item.listener()
  }
}

function newEntry(key: SessionDocKey): EntryState {
  return { key, refs: 0, alive: true, hasValue: false, deleted: false, connEpoch: 0, lastSeq: -1, connected: false, retry: 0 }
}

function ensureEntry(key: SessionDocKey): EntryState {
  const id = keyString(key)
  let entry = entries.get(id)
  if (entry === undefined) {
    entry = newEntry(key)
    entries.set(id, entry)
  }
  return entry
}

/** 边界校验文档帧/快照：形状或目标不匹配抛显式错误（诚实性纪律，不静默吞帧）。 */
function assertSessionDocShape(doc: unknown, expected: SessionDocKey): PublicPluginSessionDoc {
  if (doc === null || typeof doc !== 'object') throw new Error('会话文档帧格式无效')
  const d = doc as Record<string, unknown>
  if (
    typeof d['pluginId'] !== 'string' ||
    typeof d['name'] !== 'string' ||
    !Number.isSafeInteger(d['conversationId']) ||
    d['conversationId'] !== expected.conversationId
  ) {
    throw new Error('会话文档帧格式无效')
  }
  if (d['pluginId'] !== expected.pluginId || d['name'] !== expected.docName) {
    throw new Error(`会话文档帧目标不匹配：${String(d['pluginId'])}/${String(d['name'])}`)
  }
  if (!('value' in d)) throw new Error('会话文档帧缺少 value 字段')
  if ('deleted' in d && d['deleted'] !== undefined && typeof d['deleted'] !== 'boolean') {
    throw new Error('会话文档帧格式无效')
  }
  return d as unknown as PublicPluginSessionDoc
}

/** 写入文档状态；delete 帧 value=initial（reset 语义）照常落值。 */
function applyDoc(entry: EntryState, doc: PublicPluginSessionDoc): void {
  entry.error = undefined
  entry.deleted = doc.deleted === true
  entry.value = doc.value
  entry.hasValue = true
}

async function responseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body?.error?.message) message = body.error.message
  } catch { /* 非 JSON 错误体保留状态码描述 */ }
  return message
}

/** 打开（或复用）一条元组专用 SSE 订阅流；断流按有界退避重连。 */
function connectStream(entry: EntryState, gen: number): void {
  if (!entry.alive || entry.refs <= 0 || gen !== generation || entry.terminated !== undefined) return
  const { pluginId, docName, conversationId } = entry.key
  const label = `${pluginId}/${docName}#${conversationId}`
  const myConn = ++entry.connEpoch
  const controller = new AbortController()
  entry.controller = controller
  const run = async (): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    // Node fetch 语义：signal abort 不一定传递到底层流 cancel，
    // 这里显式监听并 cancel reader；仅当仍是当前连接时才清 entry.controller，
    // 避免 retry 后旧连接的 onAbort 误清新连接的 controller。
    const onAbort = (): void => {
      if (entry.controller === controller) entry.controller = undefined
      void reader?.cancel().catch(() => {})
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    // 连接有效性：旧连接（代际不匹配）、已 teardown（不存活）、终态、登出代际
    // 推进、归零退订的任何异步续写一律丢弃。
    const isActive = (): boolean =>
      entry.alive && entry.connEpoch === myConn && gen === generation && entry.refs > 0 && entry.terminated === undefined
    try {
      const token = tokenProvider()
      const res = await resolvedFetch(
        `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(docName)}/events?conversationId=${conversationId}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
      )
      if (!isActive()) {
        // 连接已作废：迟到响应的底层流也必须显式关闭，不留悬挂资源。
        void res.body?.cancel().catch(() => {})
        return
      }
      if (res.status === 401) {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('helm:unauthorized'))
        return
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // 非重试 4xx（404 文档/插件不存在、403 未授权、400 畸形请求）：
        // 显式终态报错，绝不无穷重连隐藏故障。
        entry.error = `会话文档订阅不可用（${label}）：${await responseErrorMessage(res)}`
        entry.connected = false
        notify(entry)
        return
      }
      if (!res.ok || !res.body) throw new Error(await responseErrorMessage(res))
      entry.error = undefined
      entry.connected = true
      entry.retry = 0
      notify(entry)
      const parser = new SseParser((message) => {
        if (!isActive()) return
        let payload: unknown
        try {
          payload = JSON.parse(message.data)
        } catch {
          entry.error = `会话文档订阅流数据非法（${label}）`
          notify(entry)
          return
        }
        if (message.event === 'snapshot') {
          if (payload === null || typeof payload !== 'object' || !('doc' in payload)) {
            entry.error = `会话文档订阅首帧格式无效（${label}）`
            notify(entry)
            return
          }
          const snap = payload as PluginSessionDocSnapshot
          if (!Number.isSafeInteger(snap.seq) || snap.seq < 0) {
            entry.error = `会话文档订阅首帧 seq 非法（${label}）`
            notify(entry)
            return
          }
          let doc: PublicPluginSessionDoc
          try {
            doc = assertSessionDocShape(snap.doc, entry.key)
          } catch (err) {
            entry.error = `会话文档订阅首帧无效（${label}）：${err instanceof Error ? err.message : String(err)}`
            notify(entry)
            return
          }
          // 重连对齐：无条件以服务端 snapshot 为准，并重置本连接的 seq 基准。
          entry.lastSeq = snap.seq
          applyDoc(entry, doc)
          notify(entry)
          return
        }
        const frame = payload as HelmEventFrame
        if (
          frame === null ||
          typeof frame !== 'object' ||
          !Number.isSafeInteger(frame.seq) ||
          frame.seq < 0 ||
          !frame.event ||
          typeof frame.event.type !== 'string'
        ) {
          entry.error = `会话文档更新帧格式无效（${label}）`
          notify(entry)
          return
        }
        if (frame.event.type !== 'plugin.session_doc.updated' || !('doc' in frame.event)) {
          entry.error = `会话文档订阅流收到未预期事件 ${String(frame.event.type)}`
          notify(entry)
          return
        }
        let doc: PublicPluginSessionDoc
        try {
          doc = assertSessionDocShape(frame.event.doc, entry.key)
        } catch (err) {
          entry.error = `会话文档更新帧无效（${label}）：${err instanceof Error ? err.message : String(err)}`
          notify(entry)
          return
        }
        // 同一连接内 seq 单调：迟到旧帧（<= 当前值）直接丢弃（已有更新状态，
        // 不必报错）；seq 跨文档/tuple 不保证连续，只要求不回退。
        if (frame.seq <= entry.lastSeq) return
        entry.lastSeq = frame.seq
        applyDoc(entry, doc)
        notify(entry)
      })
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        parser.push(decoder.decode(chunk.value, { stream: true }))
        if (!isActive()) return
      }
      throw new Error('订阅流已断开')
    } catch (error) {
      if (controller.signal.aborted || !isActive()) return
      entry.error = `会话文档订阅中断（${label}）：${error instanceof Error ? error.message : String(error)}`
      entry.connected = false
      notify(entry)
      scheduleReconnect(entry, gen)
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
      if (reader !== undefined) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
  }
  void run()
}

function scheduleReconnect(entry: EntryState, gen: number): void {
  if (entry.retryTimer !== undefined || entry.terminated !== undefined) return
  // 有界指数退避：1s 起步、上限 15s。
  const delay = Math.min(1000 * 2 ** Math.min(entry.retry++, 4), 15_000)
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = undefined
    if (!entry.alive || entry.refs <= 0 || gen !== generation || entry.terminated !== undefined) return
    entry.controller = undefined
    connectStream(entry, gen)
  }, delay)
}

/**
 * 订阅一个 (pluginId, docName, conversationId) 元组；返回退订函数。
 * 首个订阅者建立 SSE 流；最后一个退订中止一切并清缓存。
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
  if (firstRef && entry.terminated === undefined) connectStream(entry, generation)
  return () => {
    listeners.delete(item)
    // 条目可能已被 reset 全局移除：不再重复扣减 refs（防负数）或二次 teardown。
    if (entries.get(id) !== entry) return
    entry.refs--
    if (entry.refs <= 0) teardownEntry(entry)
  }
}

/** 卸载归零：中止流、清缓存与重试定时器，条目彻底移除。 */
function teardownEntry(entry: EntryState): void {
  entry.alive = false
  entry.refs = 0
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
  }
  entry.controller?.abort()
  entry.controller = undefined
  entry.connected = false
  entry.error = undefined
  entry.value = undefined
  entry.hasValue = false
  entry.deleted = false
  entry.connEpoch++
  entry.lastSeq = -1
  entry.retry = 0
  entry.terminated = undefined
  entry.snapshot = undefined
  entries.delete(keyString(entry.key))
}

/** 终止一个条目：显式报错给仍挂载的订阅者（保留至全部退订），中止且永不重连。 */
function terminateEntry(entry: EntryState, message: string): void {
  if (entry.refs <= 0) {
    teardownEntry(entry)
    return
  }
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
  }
  entry.controller?.abort()
  entry.controller = undefined
  entry.connEpoch++
  entry.connected = false
  entry.terminated = message
  entry.error = message
  entry.value = undefined
  entry.hasValue = false
  entry.deleted = false
  entry.snapshot = undefined
  notify(entry)
}

/** 全局中止（登出）：清全部条目并推进代际，在途请求结果全部作废。 */
export function resetSessionDocSubscriptions(): void {
  generation++
  for (const entry of [...entries.values()]) teardownEntry(entry)
}

/** 插件停用/卸载：向仍挂载的订阅者显式报错，中止其全部订阅且不再重连。 */
export function evictSessionDocSubscriptions(pluginId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.key.pluginId !== pluginId) continue
    terminateEntry(entry, `插件 ${pluginId} 已停用，会话文档订阅已中止`)
  }
}

/** 会话删除：显式报错并中止该会话全部订阅缓存。 */
export function evictSessionDocsOfConversation(conversationId: number): void {
  for (const entry of [...entries.values()]) {
    if (entry.key.conversationId === conversationId) {
      terminateEntry(entry, `会话 ${conversationId} 已删除，会话文档订阅已中止`)
    }
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

/** 订阅者显式重试：清除错误态并重建订阅流（旧连接因代际推进全部作废）。 */
export function retrySessionDoc(key: SessionDocKey): void {
  const entry = entries.get(keyString(key))
  if (entry === undefined || entry.refs <= 0 || entry.terminated !== undefined) return
  const gen = generation
  entry.retry = 0
  entry.error = undefined
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
  }
  entry.controller?.abort()
  entry.controller = undefined
  connectStream(entry, gen)
  notify(entry)
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
  if (impl === undefined) throw new Error('当前环境无 fetch 实现')
  return impl(input, init)
}
