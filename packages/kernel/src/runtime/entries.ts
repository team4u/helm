/**
 * 时间线条目与会话实时视图的纯函数表示层。
 *
 * 职责（机制，无策略）：
 * - toConversationEntry：SDK EntryRecord -> 协议 ConversationEntry 统一表示
 *   （id 转 string、kind/data/model 原样保留、边界 JSON 可用校验拒绝非 JSON 值）；
 *   HTTP 详情与 conversation.entry 实时事件共用同一函数，保证两端形状一致。
 * - deriveConversationLive：SDK LiveState（pi.live 文档）-> 协议 ConversationLive
 *   （流式助手文本的累计快照 + 工具卡状态）。
 *
 * 注意：model 消息必须保留（assistant 文本在 model 中，不在 data），
 * 否则 pi.assistant 文本在 HTTP 详情与实时事件中丢失。
 */

import {
  HelmError,
  type ConversationEntry,
  type ConversationLive,
  type ConversationLiveGeneration,
  type ConversationLiveMessage,
  type QueuedConversationInput,
} from '@helm/protocol'

/** SDK EntryRecord 的结构子集（避免依赖 SDK 具体类型，测试可构造 faux 形状）。 */
export interface EntryRecordLike {
  readonly id: number | string
  readonly kind: string
  readonly model?: readonly unknown[]
  readonly data?: unknown
  readonly byTaskId?: number
}

/** 递归拒绝非 JSON 值（循环、Date、Map、undefined 字段等），绝不静默转换。 */
function assertJsonUsable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HelmError('invalid_json_value', `entry.${path} 含非有限数字，无法作为 JSON 事件发布`, 500)
    }
    return
  }
  if (typeof value !== 'object') {
    throw new HelmError('invalid_json_value', `entry.${path} 含非 JSON 值（${typeof value}）`, 500)
  }
  const obj = value as object
  if (seen.has(obj)) {
    throw new HelmError('invalid_json_value', `entry.${path} 含循环引用`, 500)
  }
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => assertJsonUsable(item, `${path}[${i}]`, seen))
      return
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) {
      throw new HelmError('invalid_json_value', `entry.${path} 含非 JSON 对象（${proto.constructor?.name ?? 'unknown'}）`, 500)
    }
    for (const [key, item] of Object.entries(obj)) {
      if (item === undefined) {
        throw new HelmError('invalid_json_value', `entry.${path}.${key} 含 undefined 值`, 500)
      }
      assertJsonUsable(item, `${path}.${key}`, seen)
    }
  } finally {
    seen.delete(obj)
  }
}

/**
 * SDK EntryRecord -> 协议 ConversationEntry。
 * - id 统一转 string（协议契约）；
 * - kind/data/model 原样保留（model 是模型上下文消息数组，assistant 文本在其中）；
 * - 边界 JSON 可用校验：非 JSON 值显式抛 HelmError，不静默降级、不伪造截断。
 */
export function toConversationEntry(record: EntryRecordLike): ConversationEntry {
  if (typeof record.id !== 'number' && typeof record.id !== 'string') {
    throw new HelmError('invalid_json_value', `entry.id 必须是 number|string，实得 ${typeof record.id}`, 500)
  }
  if (typeof record.kind !== 'string') {
    throw new HelmError('invalid_json_value', `entry.kind 必须是 string，实得 ${typeof record.kind}`, 500)
  }
  const entry: ConversationEntry = {
    id: String(record.id),
    kind: record.kind,
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(record.model !== undefined ? { model: [...record.model] } : {}),
  }
  // 边界校验：kind 之外的载荷必须整体可 JSON 序列化（HTTP/SSE 共用出口）。
  assertJsonUsable(entry, 'payload', new WeakSet())
  return entry
}

/** 工具卡状态映射：SDK tool slot -> 协议三态。 */
type LiveToolState = ConversationLive['tools'][number]

function slotStatusOf(status: unknown): LiveToolState['status'] {
  return status === 'done' ? 'done' : 'running'
}

/** 流式 assistant 消息 -> 累计可见文本（text 块按序拼接；快照语义，客户端整体替换）。 */
function streamedTextOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text += (block as { text: string }).text
    }
  }
  return text
}

/** 流式 assistant 消息 -> 累计思考文本（thinking 块按序拼接；快照语义）。 */
function streamedThinkingOf(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let thinking = ''
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'thinking' &&
      typeof (block as { thinking?: unknown }).thinking === 'string'
    ) {
      thinking += (block as { thinking: string }).thinking
    }
  }
  return thinking
}

function toolInputOf(slot: { arguments?: unknown } | { input?: unknown }): unknown {
  if ('arguments' in slot) return slot.arguments
  return (slot as { input?: unknown }).input
}

/**
 * SDK generation（pi.live generation 字段）-> 协议受限投影（通用事实，零策略）。
 * - attempt 非正整数时整体省略（形状并非法，不伪造序号）；
 * - message 仅保留 content 受限块（text/thinking/toolCall name+arguments）与
 *   供应商累计 usage.output（正有限数）；无有效内容块时 message 省略；
 * - 不透传其他字段（时间戳/模型元数据不外泄，速率策略不依赖它们）。
 */
export function liveGenerationOf(
  generation: { attempt?: unknown; message?: unknown } | undefined,
): ConversationLiveGeneration | undefined {
  if (generation === null || typeof generation !== 'object') return undefined
  const attempt = (generation as { attempt?: unknown }).attempt
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) return undefined
  const message = liveMessageOf((generation as { message?: unknown }).message)
  return { attempt, ...(message !== undefined ? { message } : {}) }
}

/** partial assistant message -> 受限 JSON-safe 投影；无有效内容块返回 undefined。 */
function liveMessageOf(message: unknown): ConversationLiveMessage | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const blocks: ConversationLiveMessage['content'] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      blocks.push({ type: 'thinking', thinking: b.thinking })
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      blocks.push({ type: 'toolCall', name: b.name, ...('arguments' in b ? { arguments: b.arguments } : {}) })
    }
  }
  if (blocks.length === 0) return undefined
  const output = (message as { usage?: { output?: unknown } }).usage?.output
  const usage =
    typeof output === 'number' && Number.isFinite(output) && output > 0
      ? { output }
      : undefined
  return { content: blocks, ...(usage !== undefined ? { usage } : {}) }
}

/** pi.inbox queued 项的结构子集（tracker 传入；形状非法项直接跳过，不伪造）。 */
export interface InboxItemLike {
  readonly id: number | string
  readonly mode?: string
  readonly entry?: { kind?: string; data?: unknown }
}

/** inbox queued 项 -> QueuedConversationInput；非 helm.input / 非法载荷返回 undefined。 */
function queuedInputOf(item: InboxItemLike, fallbackCreatedAt: number): QueuedConversationInput | undefined {
  if (item.mode !== 'steer' && item.mode !== 'followUp') return undefined
  if (item.entry?.kind !== 'helm.input') return undefined
  const data = item.entry.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (typeof d['id'] !== 'string' || typeof d['text'] !== 'string') return undefined
  const origin = d['origin'] === 'agent' || d['origin'] === 'trigger' ? d['origin'] : 'human'
  const createdAt =
    typeof d['createdAt'] === 'number' && Number.isFinite(d['createdAt']) ? d['createdAt'] : fallbackCreatedAt
  const attachments = Array.isArray(d['attachments']) && d['attachments'].length > 0 ? d['attachments'] : undefined
  return {
    id: d['id'],
    submissionId: String(item.id),
    text: d['text'],
    mode: item.mode,
    origin,
    createdAt,
    ...(attachments !== undefined ? { attachments: attachments as QueuedConversationInput['attachments'] } : {}),
  }
}

/** 排队输入排序：steer 全部排在 followUp 之前（同 mode 保持原序）。 */
function sortQueuedInputs(items: QueuedConversationInput[]): void {
  const rank = (mode: QueuedConversationInput['mode']): number => (mode === 'steer' ? 0 : 1)
  items.sort((a, b) => rank(a.mode) - rank(b.mode))
}

/**
 * SDK LiveState（pi.live 文档值）-> 协议 ConversationLive。
 * - text：generation.message.content 中 text 块的累计快照（客户端替换式渲染）；
 * - tools：模型发起的工具轮（tools）与嵌套调用（nestedTools）统一映射；
 *   输入取 slot 的运行参数（模型发起调用参数在 assistant entry，slot 的
 *   arguments/output 仅嵌套调用携带），结果文本不进入 live（详情走 entry）；
 * - generation：通用流式事实（attempt + 受限 message 投影），供速率类
 *   插件策略消费；内核零速率计算；
 * - queuedInputs：从 pi.inbox 排队项派生的待生效输入清单（steer 优先），
 *   无排队项时省略。
 */
export function deriveConversationLive(
  conversationId: number,
  live: {
    generation?: { attempt?: unknown; message?: unknown }
    tools?: ReadonlyArray<{
      callId: string
      name: string
      status?: string
      arguments?: unknown
      input?: unknown
    }>
    nestedTools?: ReadonlyArray<{
      callId: string
      name: string
      status?: string
      arguments?: unknown
      input?: unknown
    }>
  } | undefined,
  updatedAt: number,
  inboxItems?: ReadonlyArray<InboxItemLike>,
): ConversationLive {
  const source = live ?? {}
  const tools: LiveToolState[] = []
  const collect = (slots: ReadonlyArray<{ callId: string; name: string; status?: string; arguments?: unknown; input?: unknown }> | undefined): void => {
    for (const slot of slots ?? []) {
      if (typeof slot?.callId !== 'string' || typeof slot?.name !== 'string') continue
      const input = toolInputOf(slot)
      tools.push({
        callId: slot.callId,
        toolName: slot.name,
        ...(input !== undefined ? { input } : {}),
        status: slotStatusOf(slot.status),
      })
    }
  }
  collect(source.tools)
  collect(source.nestedTools)
  const thinking = streamedThinkingOf(source.generation?.message)
  const generation = liveGenerationOf(source.generation)
  const queuedInputs: QueuedConversationInput[] = []
  for (const item of inboxItems ?? []) {
    const queued = queuedInputOf(item, updatedAt)
    if (queued !== undefined) queuedInputs.push(queued)
  }
  sortQueuedInputs(queuedInputs)
  return {
    conversationId,
    text: streamedTextOf(source.generation?.message),
    ...(thinking !== '' ? { thinking } : {}),
    tools,
    ...(generation !== undefined ? { generation } : {}),
    ...(queuedInputs.length > 0 ? { queuedInputs } : {}),
    updatedAt,
  }
}
