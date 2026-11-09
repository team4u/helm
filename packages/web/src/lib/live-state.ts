import type { AskSpec, ConversationDetail, ConversationEntry, ConversationLive, ConversationSummary, HelmEventFrame, HelmSnapshot, NodeInfo, PluginSummary, PluginUiContribution } from '@helm/protocol'

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

/** 新连接必须重新加载详情和未随快照提供的 public docs：快照只含 pluginDocs 直投部分。 */
export function applySnapshot(previous: LiveState, snapshot: HelmSnapshot): LiveState {
  if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.pendingAsks) || !Array.isArray(snapshot.plugins) || !Array.isArray(snapshot.ui)) {
    throw new Error('内核实时快照格式无效')
  }
  if (snapshot.conversationLives !== undefined && !Array.isArray(snapshot.conversationLives)) throw new Error('内核实时快照格式无效')
  if (snapshot.pluginDocs !== undefined && !Array.isArray(snapshot.pluginDocs)) throw new Error('内核实时快照格式无效')
  const conversationLives: Record<number, ConversationLive> = {}
  for (const live of snapshot.conversationLives ?? []) {
    if (!isLiveShape(live)) throw new Error('内核实时快照格式无效')
    conversationLives[live.conversationId] = live
  }
  // 快照 pluginDocs 直投：免额外拉取，键与 ensurePluginDoc 一致（`${pluginId}/${docName}`）。
  const pluginDocs: Record<string, unknown> = {}
  if (Array.isArray(snapshot.pluginDocs)) {
    for (const doc of snapshot.pluginDocs) {
      if (doc === null || typeof doc !== 'object') throw new Error('内核实时快照格式无效')
      if (typeof doc.pluginId !== 'string' || typeof doc.name !== 'string') throw new Error('内核实时快照格式无效')
      pluginDocs[`${doc.pluginId}/${doc.name}`] = doc.value
    }
  }
  return { ...emptyLiveState(), seq: snapshot.seq, conversations: sortConversations(snapshot.conversations), conversationLives, pendingAsks: snapshot.pendingAsks, plugins: snapshot.plugins, uiContributions: snapshot.ui, pluginDocs, nodes: Array.isArray(snapshot.nodes) ? sortNodes(snapshot.nodes) : [], resolvedAsksByConv: previous.resolvedAsksByConv }
}

export function entryMatchesReference(entry: ConversationEntry, reference: string): boolean {
  if (entry.id === reference || `entry:${entry.id}` === reference) return true
  if (entry.kind !== 'helm.input' || !reference.startsWith('input:') || entry.data === null || typeof entry.data !== 'object') return false
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
  return { ...state, pendingEntries: omit(state.pendingEntries, String(detail.id)), conversationDetails: { ...state.conversationDetails, [detail.id]: { ...detail, ...(summary ?? {}), entries: sorted, nextCursor: olderPage || !current ? detail.nextCursor : current.nextCursor } } }
}

/** 任何序号缺口都重连取快照，不能继续显示缺帧的“最新状态”。 */
export function applyEventFrame(state: LiveState, frame: HelmEventFrame): LiveState {
  if (!Number.isSafeInteger(frame.seq) || !frame.event || typeof frame.event.type !== 'string') throw new Error('实时事件格式无效')
  if (frame.seq <= state.seq) return state
  if (state.seq < 0 || frame.seq !== state.seq + 1) throw new Error('实时事件序号不连续，正在重新同步')
  const next = { ...state, seq: frame.seq }
  const event = frame.event
  // 自定义事件有任意字符串 type；用字段存在性进一步缩窄公共联合类型。
  switch (event.type) {
    case 'conversation.upsert':
      if ('conversation' in event) {
        const conv = event.conversation
        next.conversations = sortConversations(upsert(state.conversations, conv))
        if (state.conversationDetails[conv.id]) next.conversationDetails = { ...state.conversationDetails, [conv.id]: { ...state.conversationDetails[conv.id]!, ...conv } }
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
      if ('entry' in event) {
        const detail = state.conversationDetails[event.conversationId]
        if (detail) next.conversationDetails = { ...state.conversationDetails, [detail.id]: { ...detail, entries: upsert(detail.entries, event.entry) } }
        else next.pendingEntries = { ...state.pendingEntries, [event.conversationId]: upsert(state.pendingEntries[event.conversationId] ?? [], event.entry) }
      }
      break
    case 'conversation.live':
      if ('live' in event) next.conversationLives = { ...state.conversationLives, [event.live.conversationId]: event.live }
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
    if (this.buffer.length + this.data.join('').length > 4 * 1024 * 1024) throw new Error('实时事件超过客户端接收上限')
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
