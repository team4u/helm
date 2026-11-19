import type { AskSpec, ConversationDetail, ConversationEntry, ConversationLive, ConversationSummary, HelmxEventFrame, HelmxResumedFrame, HelmxSnapshot, HelmxTransientLiveFrame, NodeInfo, PluginSummary, PluginUiContribution } from '@helmx/protocol/browser'

export interface LiveState {
  seq: number
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  pendingEntries: Record<number, ConversationEntry[]>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  resolvedAsksByConv: Record<number, Array<{ ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }>>
  plugins: PluginSummary[]
  uiContributions: PluginUiContribution[]
  pluginDocs: Record<string, unknown>
  nodes: NodeInfo[]
}

export function emptyLiveState(): LiveState {
  return { seq: -1, conversations: [], conversationDetails: {}, pendingEntries: {}, conversationLives: {}, pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [], pluginDocs: {}, nodes: [] }
}

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => Number(b.id === 1) - Number(a.id === 1) || b.updatedAt - a.updatedAt)
}

/** 节点列表排序：local 恒在首项，其余按 id 稳定排列。 */
export function sortNodes(list: NodeInfo[]): NodeInfo[] {
  return [...list].sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function upsert<T extends { id: string | number }>(list: T[], item: T): T[] {
  return [...list.filter((value) => value.id !== item.id), item]
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

/** ConversationLive 边界形状校验（与内核 conversation.live 事件同一判定）。 */
function isLiveShape(value: unknown): value is ConversationLive {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['conversationId'] === 'number' && Number.isInteger(v['conversationId']) &&
    typeof v['text'] === 'string' &&
    Array.isArray(v['tools']) &&
    typeof v['updatedAt'] === 'number' && Number.isFinite(v['updatedAt'])
  )
}

/** 保留 queue-only live：清流式正文/工具/思考，仅保留权威 queuedInputs（等真实出队帧清理）。 */
function queueOnlyLive(live: ConversationLive): ConversationLive {
  return { conversationId: live.conversationId, text: '', tools: [], ...(live.queuedInputs !== undefined ? { queuedInputs: live.queuedInputs } : {}), updatedAt: live.updatedAt }
}

/**
 * 应用全量快照并做 SWR 保活：保留仍存在于 snapshot.conversations 中的
 * previous.conversationDetails（合并最新摘要字段），仅清理已删除会话的详情缓存。
 */
export function applySnapshot(previous: LiveState, snapshot: HelmxSnapshot): LiveState {
  if (typeof snapshot.bootId !== 'string' || snapshot.bootId === '' || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.pendingAsks) || !Array.isArray(snapshot.plugins) || !Array.isArray(snapshot.ui)) {
    throw new Error('Invalid kernel live snapshot format')
  }
  if (snapshot.conversationLives !== undefined && !Array.isArray(snapshot.conversationLives)) throw new Error('Invalid kernel live snapshot format')
  if (snapshot.pluginDocs !== undefined && !Array.isArray(snapshot.pluginDocs)) throw new Error('Invalid kernel live snapshot format')
  const conversationLives: Record<number, ConversationLive> = {}
  for (const live of snapshot.conversationLives ?? []) {
    if (!isLiveShape(live)) throw new Error('Invalid kernel live snapshot format')
    conversationLives[live.conversationId] = live
  }
  const conversationDetails: Record<number, ConversationDetail> = {}
  for (const conv of snapshot.conversations) {
    const prevDetail = previous.conversationDetails[conv.id]
    if (prevDetail !== undefined) {
      conversationDetails[conv.id] = {
        ...prevDetail,
        ...conv,
        // 保留 prevDetail 已实际同步的条目水位，避免后台静默刷新失败后误以为详情已追平。
        stateChangeSeq: prevDetail.stateChangeSeq,
        lastEntryId: prevDetail.lastEntryId,
        ...(conv.contextUsage === undefined && prevDetail.contextUsage !== undefined
          ? { contextUsage: prevDetail.contextUsage }
          : {}),
      }
    }
  }
  // 快照 pluginDocs 直投：免额外拉取，键与 ensurePluginDoc 一致（`${pluginId}/${docName}`）。
  const pluginDocs: Record<string, unknown> = {}
  if (Array.isArray(snapshot.pluginDocs)) {
    for (const doc of snapshot.pluginDocs) {
      if (doc === null || typeof doc !== 'object') throw new Error('Invalid kernel live snapshot format')
      if (typeof doc.pluginId !== 'string' || typeof doc.name !== 'string') throw new Error('Invalid kernel live snapshot format')
      pluginDocs[`${doc.pluginId}/${doc.name}`] = doc.value
    }
  }
  return { ...emptyLiveState(), seq: snapshot.seq, conversations: sortConversations(snapshot.conversations), conversationDetails, conversationLives, pendingAsks: snapshot.pendingAsks, plugins: snapshot.plugins, uiContributions: snapshot.ui, pluginDocs, nodes: Array.isArray(snapshot.nodes) ? sortNodes(snapshot.nodes) : [], resolvedAsksByConv: previous.resolvedAsksByConv }
}

export function entryMatchesReference(entry: ConversationEntry, reference: string): boolean {
  if (entry.id === reference || `entry:${entry.id}` === reference) return true
  if (entry.kind !== 'helmx.input' || !reference.startsWith('input:') || entry.data === null || typeof entry.data !== 'object') return false
  return 'id' in entry.data && entry.data.id === reference.slice('input:'.length)
}

/** SSE 已先订阅，HTTP 详情返回时保留其间收到的 entry 与更新过的摘要。 */
export function mergeConversationDetail(state: LiveState, detail: ConversationDetail, olderPage = false): LiveState {
  const current = state.conversationDetails[detail.id]
  const entries = new Map<string, ConversationEntry>()
  for (const entry of [...detail.entries, ...(current?.entries ?? []), ...(state.pendingEntries[detail.id] ?? [])]) entries.set(entry.id, entry)
  const sorted = [...entries.values()].sort((a, b) => {
    const left = Number(a.id), right = Number(b.id)
    return Number.isSafeInteger(left) && Number.isSafeInteger(right) ? left - right : (a.createdAt ?? 0) - (b.createdAt ?? 0)
  })
  const summary = state.conversations.find((c) => c.id === detail.id)
  // 上下文用量：内核首次填充缓存静默（不发 SSE 帧），列表摘要可能长期缺该
  // 字段；HTTP 详情首读带回时补进列表（ConversationPane 向 Composer 传
  // summary ?? detail，不回填则胶囊永不渲染）。摘要已有则保留 SSE 权威值，
  // 更早生成的 HTTP 详情不得回退已订阅状态（后续 upsert 会自愈追齐）。
  const usage = summary?.contextUsage ?? detail.contextUsage
  const conversations = summary !== undefined && usage !== undefined && summary.contextUsage === undefined
    ? sortConversations(upsert(state.conversations, { ...summary, contextUsage: usage }))
    : state.conversations
  return {
    ...state,
    conversations,
    pendingEntries: omit(state.pendingEntries, String(detail.id)),
    conversationDetails: {
      ...state.conversationDetails,
      [detail.id]: {
        ...detail,
        ...(summary ?? {}),
        stateChangeSeq: olderPage && current ? current.stateChangeSeq : detail.stateChangeSeq,
        lastEntryId: olderPage && current ? current.lastEntryId : detail.lastEntryId,
        ...(usage !== undefined ? { contextUsage: usage } : {}),
        entries: sorted,
        nextCursor: olderPage || !current ? detail.nextCursor : current.nextCursor,
      },
    },
  }
}

/** 条目 upsert：同 id 原位替换（时间线依赖时间正序，回填全文不得把条目挪到队尾），
 * 新 id 追加队尾（与既有 conversation.entry 事件追加语义一致）。 */
function upsertEntryStable(entries: ConversationEntry[], entry: ConversationEntry): ConversationEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index < 0) return [...entries, entry]
  if (entries[index] === entry) return entries
  const next = [...entries]
  next[index] = entry
  return next
}

/**
 * 单条目写入（SSE conversation.entry 事件与截断全文回填共用语义）：
 * 详情已加载则原位并入其 entries；否则落入 pendingEntries 等详情首载合并。
 * 不触碰 nextCursor，分页游标语义不变。
 */
export function applyConversationEntry(state: LiveState, conversationId: number, entry: ConversationEntry): LiveState {
  const detail = state.conversationDetails[conversationId]
  if (detail) {
    const entries = upsertEntryStable(detail.entries, entry)
    if (entries === detail.entries) return state
    return {
      ...state,
      conversationDetails: {
        ...state.conversationDetails,
        [conversationId]: { ...detail, entries },
      },
    }
  }
  const existingPending = state.pendingEntries[conversationId]
  if (existingPending !== undefined) {
    const pending = upsertEntryStable(existingPending, entry)
    if (pending === existingPending) return state
    return { ...state, pendingEntries: { ...state.pendingEntries, [conversationId]: pending } }
  }
  return { ...state, pendingEntries: { ...state.pendingEntries, [conversationId]: [entry] } }
}

/**
 * 应用非顺序瞬态 `conversation.live` 帧：不检查也不推进 `seq`，
 * 仅更新对应会话的实时视图。
 */
export function applyTransientLiveFrame(state: LiveState, frame: HelmxTransientLiveFrame): LiveState {
  if (frame === null || typeof frame !== 'object' || !isLiveShape((frame as { live?: unknown }).live)) {
    throw new Error('Invalid transient conversation.live frame format')
  }
  return {
    ...state,
    conversationLives: { ...state.conversationLives, [frame.live.conversationId]: frame.live },
  }
}

/**
 * 应用 `resumed` 控制帧携带的活跃会话实时视图集合，对账断线期间未进入
 * 持久回放环形缓冲区的瞬态 `conversation.live` 状态。
 */
export function applyResumedFrame(state: LiveState, frame: HelmxResumedFrame): LiveState {
  if (frame === null || typeof frame !== 'object') {
    throw new Error('Invalid kernel live resumed format')
  }
  if (frame.conversationLives === undefined) return state
  if (!Array.isArray(frame.conversationLives)) {
    throw new Error('Invalid kernel live resumed format')
  }
  const conversationLives: Record<number, ConversationLive> = {}
  for (const live of frame.conversationLives) {
    if (!isLiveShape(live)) throw new Error('Invalid kernel live resumed format')
    conversationLives[live.conversationId] = live
  }
  if (frame.conversationLives.length === 0 && Object.keys(state.conversationLives).length === 0) {
    return state
  }
  return { ...state, conversationLives }
}

/** 任何序号缺口都重连取快照，不能继续显示缺帧的“最新状态”。 */
export function applyEventFrame(state: LiveState, frame: HelmxEventFrame): LiveState {
  if (!Number.isSafeInteger(frame.seq) || !frame.event || typeof frame.event.type !== 'string') throw new Error('Invalid live event format')
  if (frame.seq <= state.seq) return state
  if (state.seq < 0 || frame.seq !== state.seq + 1) throw new Error('Live event sequence gap; re-syncing')
  const next = { ...state, seq: frame.seq }
  const event = frame.event
  // 自定义事件有任意字符串 type；用字段存在性进一步缩窄公共联合类型。
  switch (event.type) {
    case 'conversation.upsert':
      if ('conversation' in event) {
        const conv = event.conversation
        next.conversations = sortConversations(upsert(state.conversations, conv))
        if (state.conversationDetails[conv.id]) {
          const existingDetail = state.conversationDetails[conv.id]!
          next.conversationDetails = {
            ...state.conversationDetails,
            [conv.id]: {
              ...existingDetail,
              ...conv,
              stateChangeSeq: existingDetail.stateChangeSeq,
              lastEntryId: existingDetail.lastEntryId,
            },
          }
        }
        if (conv.status !== 'working' && conv.status !== 'blocked') {
          // 终态交接边界：若权威 live 快照仍带 queuedInputs（失败后 afterFailedRun
          // 保留排队等场景），保留 queue-only live 等真实出队帧清理，不在 web
          // 伪造队列；队列为空则原样删除，不让 done 显示旧回复 working。
          const existing = state.conversationLives[conv.id]
          next.conversationLives = existing !== undefined && (existing.queuedInputs?.length ?? 0) > 0
            ? { ...state.conversationLives, [conv.id]: queueOnlyLive(existing) }
            : omit(state.conversationLives, String(conv.id))
        }
      }
      break
    case 'conversation.deleted':
      if ('conversationId' in event) {
        next.conversations = state.conversations.filter((c) => c.id !== event.conversationId)
        next.conversationDetails = omit(state.conversationDetails, String(event.conversationId))
        next.pendingEntries = omit(state.pendingEntries, String(event.conversationId))
        next.conversationLives = omit(state.conversationLives, String(event.conversationId))
        next.pendingAsks = state.pendingAsks.filter((ask) => ask.conversationId !== event.conversationId)
      }
      break
    case 'conversation.entry':
      if ('entry' in event) return applyConversationEntry(next, event.conversationId, event.entry)
      break
    case 'ask.upsert':
      if ('ask' in event) next.pendingAsks = event.ask.status === 'pending' ? upsert(state.pendingAsks, event.ask) : state.pendingAsks.filter((ask) => ask.id !== event.ask.id)
      break
    case 'ask.resolved':
      if ('askId' in event) {
        const ask = state.pendingAsks.find((item) => item.id === event.askId)
        next.pendingAsks = state.pendingAsks.filter((item) => item.id !== event.askId)
        if (ask) next.resolvedAsksByConv = { ...state.resolvedAsksByConv, [ask.conversationId]: [...(state.resolvedAsksByConv[ask.conversationId] ?? []), { ask, status: event.status }] }
      }
      break
    case 'plugin.changed':
      if ('plugin' in event) {
        next.plugins = upsert(state.plugins, event.plugin)
        next.uiContributions = [...state.uiContributions.filter((item) => item.pluginId !== event.plugin.id), ...event.ui]
        next.pluginDocs = Object.fromEntries(Object.entries(state.pluginDocs).filter(([key]) => !key.startsWith(`${event.plugin.id}/`)))
      }
      break
    case 'plugin.doc.updated':
      if ('doc' in event && state.plugins.some((p) => p.id === event.doc.pluginId && p.enabled)) next.pluginDocs = { ...state.pluginDocs, [`${event.doc.pluginId}/${event.doc.name}`]: event.doc.value }
      break
    case 'node.changed':
      if ('node' in event) {
        next.nodes =
          event.removed === true
            ? state.nodes.filter((item) => item.id !== event.node.id)
            : sortNodes(upsert(state.nodes, event.node))
      }
      break
  }
  return next
}

export interface SseMessage { event: string; data: string }

/** ReadableStream 的 chunk 不对应 SSE 帧边界；支持 CRLF、分段、多 data 行与注释。 */
export class SseParser {
  private buffer = ''
  private eventName = 'message'
  private data: string[] = []
  constructor(private readonly onMessage: (message: SseMessage) => void) {}
  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length + this.data.join('').length > 4 * 1024 * 1024) throw new Error('Live events exceeded the client receive limit')
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') {
        if (this.data.length) this.onMessage({ event: this.eventName, data: this.data.join('\n') })
        this.eventName = 'message'
        this.data = []
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const name = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (name === 'event') this.eventName = value
        else if (name === 'data') this.data.push(value)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE 空闲看门狗：卡死连接可靠检测（如 Vite dev 代理保留的挂起流）
// ---------------------------------------------------------------------------

/** SSE 客户端时序参数（集中定义；对象引用共享，测试可临时改写后复原）。 */
export const sseClientTimings = {
  /**
   * 连接建立后持续未收到任何字节（含服务端 `: keepalive` 心跳注释行）即判定
   * 连接卡死，中止当前连接并走既有重连路径；对齐内核 15s keepalive。
   */
  idleTimeoutMs: 30_000,
  /** `online`/`visibilitychange` 唤醒时判定活跃连接疑似半开陈旧的静默阈值（毫秒）。 */
  staleWakeupMs: 20_000,
  /** 重连指数退避基础间隔（毫秒）。 */
  reconnectBaseMs: 1_000,
  /** 重连指数退避上限（毫秒）。 */
  reconnectCapMs: 10_000,
  /** 重连随机抖动上限（毫秒）。 */
  reconnectJitterMs: 250,
}

/** 带空闲 Deadline 的单次读取结果：正常 chunk 或超时（连接卡死）。 */
export type SseIdleRead =
  | { kind: 'chunk'; chunk: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'idle' }

/**
 * 读取一个 SSE chunk 并附带空闲 Deadline：chunk 在超时内到达即返回（每次到达
 * 自然重置下一轮 Deadline，不会误杀活跃连接）；超时返回 { kind: 'idle' }，
 * 由调用方 abort 当前连接解开挂起的 reader.read() 并走统一重连路径。
 * 可选 signal 在已取消或等待期间收到 abort 时立即 reject 并清理定时器与监听，
 * 避免长超时定时器挂住事件循环。
 * 读取 promise 已被 race 接管：超时/取消取胜后迟到/拒绝的读取不会成为未处理 rejection。
 */
export async function readSseChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<SseIdleRead> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const idle = new Promise<SseIdleRead>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'idle' })
      }, idleTimeoutMs)
    })
    const racers: Array<Promise<SseIdleRead>> = [idle]
    if (signal !== undefined) {
      racers.push(
        new Promise<SseIdleRead>((_resolve, reject) => {
          onAbort = () => {
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      )
    }
    racers.unshift(reader.read().then((chunk): SseIdleRead => ({ kind: 'chunk', chunk })))
    return await Promise.race(racers)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
