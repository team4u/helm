/**
 * 会话上下文用量计算（纯函数；对齐 pi agent 1.5.2 的真实源码语义）。
 *
 * 事实依据（@earendil-works/pi-coding-agent 1.5.2 实测源码）：
 * - `dist/core/agent-session.js` 的 `getContextUsage`：有效 assistant usage
 *   （stopReason 非 aborted/error 且上下文 tokens > 0）位于最近一次压缩之后
 *   才可信；压缩后尚无仍在 projection 中的有效 assistant 时 tokens 未知
 *   （null）；
 * - `dist/core/compaction/compaction.js` 的 `estimateProjectedContextTokens`：
 *   最后一次 usage 若位于最近一次 context invalidation（compaction /
 *   context_edit）之前一律失效，退化为全量估算——先用 pi-ai 公开的
 *   `getCurrentSystemMessage(messages)` 折叠当前生效 system（content 追加、
 *   sections 按名 patch、tools 重放），估算它一次，再逐条估算非 system
 *   消息（不重复计被更新的旧 system）；
 * - 同文件 `estimateTokens`：chars/4 保守估算（图片按 4800 字符、system 把
 *   content + sections + toolsAdded 合并计总字符后 Math.ceil(/4)）。
 *
 * 为什么本地提取而不复用现成导出：pi CLI 的 `estimateTokens` 未从任何公开
 * 包导出（仅 CLI dist 内部模块），走私有子路径或引入整个 CLI 包都违反包
 * 边界；pi-ai 公开的 `estimateMessageTokens` 是 CHARS_PER_TOKEN=3.5 的另一
 * 套算法（system 计法也不同），不冒充同源。此处按 Pi 源码逐行提取为小纯
 * 函数并注明出处；`calculateContextTokens` 与 `getCurrentSystemMessage`
 * 仍复用 pi-ai 公开导出（与 Pi 同一来源公式）。
 *
 * helm 语义映射（pi branch 条目 -> pi-durable ContextView）：
 * - compaction / context edit 均为 context invalidation：前者是 head 标记
 *   （pi.compaction / pi.reset），后者是携带 `edits` 的条目（如 helm.rewind
 *   的 omit/replace）；锚点只有晚于「head 边界与最新 edits 非空条目 id 的
 *   较大者」才可信（泛化判定 entry.edits，不硬编码 helm.rewind 策略）；
 * - contributions 已按 edits 应用（omit 条目贡献为空数组），post-compaction
 *   有效 assistant 判定天然只看仍在 projection 中的消息。
 */

import type { ContextView } from '@earendil-works/pi-durable'
import { getCurrentSystemMessage, type Message } from '@earendil-works/pi-ai'
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { ConversationContextUsage } from '@helm/protocol'

/** 有效 assistant usage 的消息形状（pi getAssistantUsage 判定的结构子集）。 */
type MeasuredAssistant = {
  role: 'assistant'
  usage: Parameters<typeof calculateContextTokens>[0]
}

/** 估算结果；tokens 为 null 表示真实上下文未知（压缩后尚无有效 usage）。 */
export interface ContextUsageEstimate {
  tokens: number | null
}

/** pi agent compaction.js `ESTIMATED_IMAGE_CHARS`：图片按 4800 字符计。 */
const ESTIMATED_IMAGE_CHARS = 4800

/** pi agent compaction.js `estimateTextAndImageContentChars` 同款：
 * 字符串按长度；块数组累计 text 块字符与图片固定字符（空文本块跳过）。 */
function textAndImageContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue
    const block = raw as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      chars += block.text.length
    } else if (block.type === 'image') {
      chars += ESTIMATED_IMAGE_CHARS
    }
  }
  return chars
}

/**
 * 消息 tokens 保守估算（chars/4），逐行对齐 pi agent compaction.js 的
 * `estimateTokens`；覆盖 helm 上下文支持的四种 Message 角色
 * （system / user / assistant / toolResult），未知角色计 0：
 * - system：content + sections 值 + toolsAdded 的 JSON 序列化合并总字符；
 * - user / toolResult：text 与图片内容字符（图片按 4800）；
 * - assistant：text / thinking 块字符 + toolCall 的 name 与参数 JSON 字符。
 */
export function estimateTokens(message: Message): number {
  let chars = 0
  switch (message.role) {
    case 'system': {
      chars = textAndImageContentChars(message.content)
      if (message.sections !== undefined) {
        for (const section of Object.values(message.sections)) {
          if (section) chars += section.length
        }
      }
      if (message.toolsAdded !== undefined) chars += JSON.stringify(message.toolsAdded).length
      return Math.ceil(chars / 4)
    }
    case 'user': {
      return Math.ceil(textAndImageContentChars(message.content) / 4)
    }
    case 'assistant': {
      for (const block of message.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'thinking') {
          chars += block.thinking.length
        } else if (block.type === 'toolCall') {
          chars += block.name.length + JSON.stringify(block.arguments).length
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'toolResult': {
      return Math.ceil(textAndImageContentChars(message.content) / 4)
    }
  }
  return 0
}

/** pi agent compaction.js `getAssistantUsage` 同款判定：role 为 assistant、
 * stopReason 非 aborted/error、usage 形状可算且上下文 tokens > 0（pi-durable
 * 的 contributions 已剔除 aborted/error/deferred 消息，此处按同一规则防御
 * 非常规来源，派生展示数据不因个别损坏条目中断刷新）。 */
function isValidMeasuredAssistant(message: unknown): message is MeasuredAssistant {
  if (message === null || typeof message !== 'object') return false
  const m = message as { role?: unknown; usage?: unknown; stopReason?: unknown }
  if (m.role !== 'assistant' || m.usage === null || typeof m.usage !== 'object') return false
  if (m.stopReason === 'aborted' || m.stopReason === 'error') return false
  return calculateContextTokens(m.usage as Parameters<typeof calculateContextTokens>[0]) > 0
}

/**
 * 对齐 pi agent `getContextUsage` 的上下文估算。
 *
 * - 失效边界：head 标记（compaction/reset）与最新携带非空 `edits` 的条目
 *   取较大者；锚点扫描跳过边界及更早的条目（压缩保留前缀与被 rewind 覆盖
 *   区间内的旧 usage 均不可信，pi 语义：最新 invalidation 之前的 usage 一律失效）；
 * - 压缩后未知：head 为 pi.compaction 且 head 之后没有任何仍在 projection
 *   中的有效 assistant（含被后续 edit omit 的情况）时 tokens=null——摘要
 *   字符估算不冒充真实上下文，直到下一次 LLM 响应上报 usage；pi.reset 是
 *   全新上下文，全量估算（0）即真实值，不为 null；
 * - 实测锚点：边界之后最近一条有效 assistant（contributions 内最后一条）；
 *   锚点必须在最终 view.messages 中可定位（防御：定位失败按无锚点处理，
 *   绝不把 usage 与全量估算相加造成重复计量）；tokens = 锚点 usage 上下文
 *   tokens + 其后消息逐条 chars/4 估算；
 * - 全量估算：`getCurrentSystemMessage` 折叠当前生效 system 估算一次 +
 *   每条非 system 消息逐条估算（pi 同款，不重复计被更新的旧 system）。
 */
export function estimateContextUsage(view: ContextView): ContextUsageEstimate {
  const head = view.head
  const headBoundary = head?.id ?? Number.NEGATIVE_INFINITY
  // 最新 edits 非空条目（泛化判定：任何携带上下文覆盖的条目都是 invalidation）。
  let latestEditBoundary = Number.NEGATIVE_INFINITY
  for (const entry of view.entries) {
    if (entry.edits !== undefined && entry.edits.length > 0 && entry.id > latestEditBoundary) {
      latestEditBoundary = entry.id
    }
  }
  const trustBoundary = Math.max(headBoundary, latestEditBoundary)

  // 尾向扫描：锚点 = 边界之后最近一条有效 assistant；同时判定 head 之后
  // 是否存在任何仍在 projection 中的有效 assistant（压缩后未知判定用，
  // 不受 edit 边界影响——被 edit 失效与从未存在是两回事）。
  let postHeadValidAssistant = false
  let anchor: MeasuredAssistant | undefined
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index]!
    // head 标记本身及其之前的旧条目（含压缩保留前缀）都不可信；entries 并非
    // 升序（head 标记居首、保留条目 id 更小），只能逐条跳过不能提前 break。
    if (entry.id <= headBoundary) continue
    let entryAnchor: MeasuredAssistant | undefined
    for (const message of view.contributions[index]!) {
      if (isValidMeasuredAssistant(message)) {
        postHeadValidAssistant = true
        entryAnchor = message
      }
    }
    if (anchor === undefined && entryAnchor !== undefined && entry.id > trustBoundary) {
      anchor = entryAnchor
    }
  }

  if (head?.kind === 'pi.compaction' && !postHeadValidAssistant) return { tokens: null }

  // 锚点对象来自 contributions，与 messages 同源同引用（lastIndexOf 按身份
  // 命中）；定位失败（-1）按无锚点走全量估算，绝不重复计量。
  const anchorIndex = anchor === undefined ? -1 : view.messages.lastIndexOf(anchor as Message)
  if (anchor !== undefined && anchorIndex >= 0) {
    let tokens = calculateContextTokens(anchor.usage)
    for (const message of view.messages.slice(anchorIndex + 1)) {
      tokens += estimateTokens(message)
    }
    return { tokens }
  }
  const currentSystem = getCurrentSystemMessage(view.messages)
  let tokens = currentSystem === undefined ? 0 : estimateTokens(currentSystem)
  for (const message of view.messages) {
    if (message.role !== 'system') tokens += estimateTokens(message)
  }
  return { tokens }
}

/** pi.live compaction 状态的结构子集（tracker 镜像透传用；字段按真实 SDK 形状）。 */
export interface LiveCompactionShape {
  taskId: number
  trigger: string
  blocking: boolean
}

/** pi.live compactionFailure 的结构子集。 */
export interface LiveCompactionFailureShape {
  taskId: number
  trigger: string
  error: string
}

/** pi.live compactions 非空即压缩进行中（只读展示「精简中…」；多项任务
 * 取任何一项在途都为真，不伪造 trigger 细节）。 */
export function compactingOf(compactions: readonly LiveCompactionShape[] | undefined): boolean | undefined {
  return compactions !== undefined && compactions.length > 0 ? true : undefined
}

const COMPACTION_TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  threshold: '阈值',
  overflow: '溢出',
}

/** 压缩失败通知正文（trigger 语义 + 脱敏错误摘要，截断 400 字符）。
 * 压缩失败不得静默：由 tracker 经 notification 事件显式上报一次。 */
export function compactionFailureNoticeOf(
  failure: LiveCompactionFailureShape,
  redact: (text: string) => string,
): string {
  const trigger = COMPACTION_TRIGGER_LABEL[failure.trigger] ?? failure.trigger
  const error = redact(failure.error ?? '').trim().slice(0, 400)
  return error === '' ? `${trigger}触发的上下文精简失败（无错误详情）` : `${trigger}触发的上下文精简失败：${error}`
}

/**
 * 组装完整 contextUsage（可缺字段全部省略，不伪造）。
 * contextWindow 由调用方按模型解析结果给出（未知传 undefined）。
 */
export function assembleContextUsage(parts: {
  estimate: ContextUsageEstimate
  contextWindow?: number
  compacting?: boolean
}): ConversationContextUsage {
  return {
    tokens: parts.estimate.tokens,
    ...(parts.contextWindow !== undefined ? { contextWindow: parts.contextWindow } : {}),
    ...(parts.compacting !== undefined ? { compacting: parts.compacting } : {}),
  }
}

/**
 * contextUsage 语义指纹（发布去重）：任一承载字段变化才发布 conversation.upsert。
 */
export function contextUsageKeyOf(usage: ConversationContextUsage | undefined): string {
  if (usage === undefined) return ''
  return JSON.stringify([usage.tokens, usage.contextWindow ?? null, usage.compacting ?? null])
}
