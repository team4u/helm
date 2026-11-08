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

import { HelmError, type ConversationEntry, type ConversationLive } from '@helm/protocol'

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
 * SDK LiveState（pi.live 文档值）-> 协议 ConversationLive。
 * - text：generation.message.content 中 text 块的累计快照（客户端替换式渲染）；
 * - tools：模型发起的工具轮（tools）与嵌套调用（nestedTools）统一映射；
 *   输入取 slot 的运行参数（模型发起调用参数在 assistant entry，slot 的
 *   arguments/output 仅嵌套调用携带），结果文本不进入 live（详情走 entry）。
 */
export function deriveConversationLive(
  conversationId: number,
  live: {
    generation?: { message?: unknown }
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
  return {
    conversationId,
    text: streamedTextOf(source.generation?.message),
    ...(thinking !== '' ? { thinking } : {}),
    tools,
    updatedAt,
  }
}
