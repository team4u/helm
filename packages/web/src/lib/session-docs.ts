/**
 * 插件会话级文档（sessionDoc）专用订阅通道（P4）。
 *
 * 与全局 ctx.doc 不同，sessionDoc 绝不进全局 /api/events 广播与首帧快照，
 * 每个 (pluginId, docName, conversationId) 元组独立开一条
 * GET /api/plugins/:id/docs/:name/events?conversationId=N SSE 订阅流：
 * - ref-count：仅当存在实际挂载的订阅者时才连接；归零立即 abort 流、清缓存
 *   与重试定时器，条目彻底移除（下次挂载全新开始）；
 * - in-flight GET（初始 HTTP 拉取）与 SSE 更新互相防旧值覆盖：每元组维护
 *   单调递增 revision，迟到响应直接丢弃；
 * - 断流按指数退避自动重连；404（文档/插件已不存在）显式报错且不再重连，
 *   绝不无穷重连隐藏 404；重连 snapshot 无条件以服务端为准对齐；
 * - 错误显式暴露给订阅者（getSessionDocState().error），绝不静默降级。
 *
 * 本模块纯逻辑 + 模块级共享状态（不依赖 React），供 store hook 与
 * HelmStoreProvider 集成消费；Node 单测经 bindSessionDocRuntime 注入 fetch。
 */
import type { HelmEventFrame, PluginSessionDocSnapshot, PublicPluginSessionDoc } from '@helm/protocol'
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
  /** 缓存值；deleted 帧按协议携带 value=initial，订阅者据此回落 undefined。 */
  value?: unknown
  hasValue: boolean
  /** 已收到 deleted:true。 */
  deleted: boolean
  /** 单调修订号：SSE 帧与 HTTP 响应按此裁决，旧值不得覆盖新值。 */
  revision: number
  /** in-flight 初始 GET 的修订号；SSE 先到达时作废该 GET。 */
  inflightRevision?: number
  controller?: AbortController
  connected: boolean
  retry: number
  retryTimer?: ReturnType<typeof setTimeout>
  error?: string
  /** getSnapshot 缓存（引用稳定，值未变时复用）。 */
  snapshot?: { value?: unknown; hasValue: boolean; deleted: boolean; error?: string; connected: boolean }
}

interface ListenerEntry {
  listener: () => void
  entry: EntryState
}

const entries = new Map<string, EntryState>()
const listeners = new Set<ListenerEntry>()
/** 全局代际：登出/停用清理时 ++，所有在途请求携带旧代际结果直接丢弃。 */
let generation = 0

function notify(entry: EntryState): void {
  for (const item of [...listeners]) {
    if (item.entry === entry) item.listener()
  }
}

function ensureEntry(key: SessionDocKey): EntryState {
  const id = keyString(key)
  let entry = entries.get(id)
  if (entry === undefined) {
    entry = { key, refs: 0, hasValue: false, deleted: false, revision: 0, connected: false, retry: 0 }
    entries.set(id, entry)
  }
  return entry
}

function abortController(entry: EntryState): AbortController {
  if (entry.controller === undefined) entry.controller = new AbortController()
  return entry.controller
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
  if ('deleted' in d && d['deleted'] !== undefined && typeof d['deleted'] !== 'boolean') {
    throw new Error('会话文档帧格式无效')
  }
  return d as unknown as PublicPluginSessionDoc
}

/** 按单调 revision 写入；迟到（revision 回退）写入返回 false 直接丢弃。 */
function applyDoc(entry: EntryState, doc: PublicPluginSessionDoc, revision: number): boolean {
  if (revision < entry.revision) return false
  entry.revision = revision
  entry.error = undefined
  entry.deleted = doc.deleted === true
  entry.value = doc.value
  entry.hasValue = true
  return true
}

async function fetchInitial(entry: EntryState, epoch: number): Promise<void> {
  const { pluginId, docName, conversationId } = entry.key
  const revision = ++entry.revision
  entry.inflightRevision = revision
  const signal = abortController(entry).signal
  const label = `${pluginId}/${docName}#${conversationId}`
  try {
    const res = await resolvedFetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(docName)}?conversationId=${conversationId}`,
      { signal },
    )
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('helm:unauthorized'))
      return
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        if (body?.error?.message) message = body.error.message
      } catch { /* 非 JSON 错误体保留状态码描述 */ }
      throw new Error(message)
    }
    const doc = assertSessionDocShape(await res.json(), entry.key)
    if (epoch !== generation || entry.refs <= 0) return
    // SSE 帧可能先于 GET 返回：GET 只在仍持有最新修订号时写入
    if (entry.inflightRevision !== revision || entry.revision !== revision) return
    entry.value = doc.value
    entry.hasValue = true
    entry.deleted = false
    entry.error = undefined
    notify(entry)
  } catch (error) {
    if (epoch !== generation || entry.refs <= 0 || signal.aborted) return
    entry.error = `会话文档读取失败（${label}）：${error instanceof Error ? error.message : String(error)}`
    notify(entry)
  } finally {
    if (entry.inflightRevision === revision) entry.inflightRevision = undefined
  }
}

/** 打开（或复用）一条元组专用 SSE 订阅流；断流按退避重连。 */
function connectStream(entry: EntryState, epoch: number): void {
  if (entry.refs <= 0 || epoch !== generation) return
  const { pluginId, docName, conversationId } = entry.key
  const label = `${pluginId}/${docName}#${conversationId}`
  const controller = abortController(entry)
  const run = async (): Promise<void> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    // Node fetch 语义：signal abort 不一定传递到底层流 cancel，
    // 这里显式监听并 cancel reader，保证卸载归零时流被真正关闭。
    const onAbort = (): void => {
      entry.controller = undefined
      void reader?.cancel().catch(() => {})
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const token = tokenProvider()
      const res = await resolvedFetch(
        `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(docName)}/events?conversationId=${conversationId}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
      )
      if (res.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('helm:unauthorized'))
        return
      }
      if (!res.ok || !res.body) {
        let message = `HTTP ${res.status}`
        try {
          const body = (await res.json()) as { error?: { message?: string } }
          if (body?.error?.message) message = body.error.message
        } catch { /* 非 JSON 错误体 */ }
        // 404 = 文档/插件已不存在：显式报错并停止，不无穷重连隐藏 404。
        if (res.status === 404) {
          if (epoch === generation && entry.refs > 0) {
            entry.error = `会话文档不存在（${label}）：${message}`
            entry.connected = false
            notify(entry)
          }
          return
        }
        throw new Error(message)
      }
      if (epoch !== generation || entry.refs <= 0) return
      entry.error = undefined
      entry.connected = true
      entry.retry = 0
      notify(entry)
      const parser = new SseParser((message) => {
        if (epoch !== generation || entry.refs <= 0) return
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
          let doc: PublicPluginSessionDoc
          try {
            doc = assertSessionDocShape((payload as PluginSessionDocSnapshot).doc, entry.key)
          } catch (err) {
            entry.error = `会话文档订阅首帧无效（${label}）：${err instanceof Error ? err.message : String(err)}`
            notify(entry)
            return
          }
          // 重连对齐：无条件以服务端 snapshot 为准（含 GET/SSE 竞态与 seq 回退场景）
          applyDoc(entry, doc, entry.revision + 1)
          entry.inflightRevision = undefined
          notify(entry)
          return
        }
        const frame = payload as HelmEventFrame
        if (
          frame === null ||
          typeof frame !== 'object' ||
          !Number.isSafeInteger(frame.seq) ||
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
        if (applyDoc(entry, doc, entry.revision + 1)) notify(entry)
      })
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        parser.push(decoder.decode(chunk.value, { stream: true }))
        if (epoch !== generation || entry.refs <= 0) return
      }
      throw new Error('订阅流已断开')
    } catch (error) {
      if (controller.signal.aborted || epoch !== generation || entry.refs <= 0) return
      entry.error = `会话文档订阅中断（${label}）：${error instanceof Error ? error.message : String(error)}`
      entry.connected = false
      notify(entry)
      scheduleReconnect(entry, epoch)
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

function scheduleReconnect(entry: EntryState, epoch: number): void {
  if (entry.retryTimer !== undefined) return
  const delay = Math.min(1000 * 2 ** Math.min(entry.retry++, 4), 15_000)
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = undefined
    if (entry.refs <= 0 || epoch !== generation) return
    entry.controller = undefined
    connectStream(entry, epoch)
  }, delay)
}

/**
 * 订阅一个 (pluginId, docName, conversationId) 元组；返回退订函数。
 * 首个订阅者建立连接（初始 GET + SSE 流）；最后一个退订中止一切并清缓存。
 */
export function subscribeSessionDoc(key: SessionDocKey, listener: () => void): () => void {
  const entry = ensureEntry(key)
  const item: ListenerEntry = { listener, entry }
  listeners.add(item)
  const firstRef = entry.refs === 0
  entry.refs++
  const epoch = generation
  if (firstRef) {
    void fetchInitial(entry, epoch)
    connectStream(entry, epoch)
  }
  return () => {
    listeners.delete(item)
    entry.refs--
    if (entry.refs <= 0) teardownEntry(entry)
  }
}

/** 卸载归零：中止流、清缓存与重试定时器，条目彻底移除。 */
function teardownEntry(entry: EntryState): void {
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
  entry.revision = 0
  entry.inflightRevision = undefined
  entry.retry = 0
  entry.snapshot = undefined
  entries.delete(keyString(entry.key))
}

/** 全局中止（登出）：清全部条目并推进代际，在途请求结果全部作废。 */
export function resetSessionDocSubscriptions(): void {
  generation++
  for (const entry of [...entries.values()]) teardownEntry(entry)
}

/** 插件停用/卸载：先向仍挂载的订阅者显式报错，再中止其全部订阅。 */
export function evictSessionDocSubscriptions(pluginId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.key.pluginId !== pluginId) continue
    if (entry.refs > 0) {
      entry.error = `插件 ${pluginId} 已停用，会话文档订阅已中止`
      notify(entry)
    }
    teardownEntry(entry)
  }
}

/** 会话删除：中止并清除该会话全部订阅缓存。 */
export function evictSessionDocsOfConversation(conversationId: number): void {
  for (const entry of [...entries.values()]) {
    if (entry.key.conversationId === conversationId) teardownEntry(entry)
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

/** 订阅者显式重试：清除错误态并重建初始 GET + 订阅流。 */
export function retrySessionDoc(key: SessionDocKey): void {
  const entry = entries.get(keyString(key))
  if (entry === undefined || entry.refs <= 0) return
  const epoch = generation
  entry.retry = 0
  entry.error = undefined
  if (entry.retryTimer !== undefined) {
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
  }
  entry.controller?.abort()
  entry.controller = undefined
  void fetchInitial(entry, epoch)
  connectStream(entry, epoch)
  notify(entry)
}

// ---------------------------------------------------------------------------
// fetch / token 访问隔离：api.ts 反向依赖本模块（getPublicSessionDoc 复用校验），
// 本模块需要的 fetch 与 token 读取经此注入，避免循环 import。默认直接走
// globalThis.fetch 与空 token（宿主启动时由 bindSessionDocRuntime 注入真实实现）。
// ---------------------------------------------------------------------------

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike | undefined
let tokenProvider: () => string | null = () => null

/** 宿主（HelmStoreProvider）启动时注入真实 fetch 与 token 读取。 */
export function bindSessionDocRuntime(fetch?: FetchLike, token?: () => string | null): void {
  if (fetch !== undefined) fetchImpl = fetch
  if (token !== undefined) tokenProvider = token
}

const resolvedFetch: FetchLike = (input, init) => {
  const impl = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch
  if (impl === undefined) throw new Error('当前环境无 fetch 实现')
  return impl(input, init)
}
