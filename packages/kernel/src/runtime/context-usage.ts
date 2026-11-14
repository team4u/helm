/**
 * 会话上下文用量计算（纯函数；对齐 pi agent 1.5.2 的真实源码语义）。
 *
 * 事实依据（@earendil-works/pi-coding-agent 1.5.2 `dist/core/agent-session.js`
 * 的 `getContextUsage` 与 `dist/core/compaction/compaction.js` 的
 * `estimateProjectedContextTokens` 实测源码）：
 * - 有效 assistant usage（`getAssistantUsage`）：stopReason 不是 aborted/error
 *   且 `calculateContextTokens(usage) > 0`；aborted / error / 全零 usage 无有效数据；
 * - 最近一次压缩（pi.compaction）之后尚无有效 assistant usage 时上下文
 *   tokens 未知（`tokens: null`）——压缩摘要替换了旧前缀，摘要字符估算不
 *   冒充真实上下文，直到下一次 LLM 响应上报 usage；
 * - 最后一次 usage 若位于最近一次 context invalidation（compaction / context
 *   edit）之前不可信：helm 的 pi-durable ContextView 已按 head 标记与 edits
 *   （helm.rewind 的 omit/replace）裁剪 entries/contributions，锚点回扫天然
 *   只命中「当前有效上下文内」的 assistant usage，锚点失效时自动退化为
 *   当前有效 messages 全量估算。
 *
 * 为什么在本仓重写而不用 SDK 函数：pi-durable 的 `estimateContext` 未从公开
 * exports 导出（仅 dist 内部模块），走私有子路径违反包边界；基础原语
 * `calculateContextTokens` / `estimateMessageTokens` 复用 pi-ai 公开导出
 * （SDK 同一来源），估算常数不复制。
 */

import type { ContextView } from '@earendil-works/pi-durable'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { Message } from '@earendil-works/pi-ai'
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

/**
 * 对齐 pi `getContextUsage` 的上下文估算。
 *
 * - 实测锚点：view.entries 从尾向前、跳过 id <= head.id 的条目（head 标记
 *   本身与压缩保留的旧前缀条目都不含可信 usage），在 contributions 中找
 *   最后一条有效 assistant（stopReason 非 aborted/error 且 usage > 0）；
 * - tokens = 锚点 usage 上下文 tokens + view.messages 中锚点之后的消息估算；
 * - 锚点有效但消息数组中找不到锚点（防御）：退化为全量估算；
 * - 最近一次 head 是 pi.compaction 且无锚点：tokens = null（压缩摘要字符
 *   估算不冒充已知上下文；pi.reset 是全新上下文，全量估算为 0 是真实值）；
 * - 无锚点（无 head 或 head 为 pi.reset）：view.messages 全量估算。
 */
export function estimateContextUsage(view: ContextView): ContextUsageEstimate {
  const head = view.head
  let measured: MeasuredAssistant | undefined
  const after = head?.id ?? Number.NEGATIVE_INFINITY
  for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index -= 1) {
    if (view.entries[index]!.id <= after) continue
    // 与 SDK findLast 等价：取 contributions 内最后一条有效实测 assistant。
    for (const message of view.contributions[index]!) {
      if (isValidMeasuredAssistant(message)) measured = message
    }
  }
  if (measured === undefined && head?.kind === 'pi.compaction') return { tokens: null }
  // 锚点对象来自 contributions，与 messages 同源同引用（lastIndexOf 按身份命中）；
  // 结构子集到 Message 的断言是同一运行时对象的 widening，不引入任何伪造。
  const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured as Message) + 1
  let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage)
  for (const message of view.messages.slice(from)) {
    tokens += estimateMessageTokens(message)
  }
  return { tokens }
}

/** pi `getAssistantUsage` 同款判定：role 为 assistant、stopReason 非
 * aborted/error、usage 形状可算且上下文 tokens > 0（pi-durable 的
 * contributions 已剔除 aborted/error/deferred 消息，此处按同一规则防御
 * 非常规来源，派生展示数据不因个别损坏条目中断刷新）。 */
function isValidMeasuredAssistant(message: unknown): message is MeasuredAssistant {
  if (message === null || typeof message !== 'object') return false
  const m = message as { role?: unknown; usage?: unknown; stopReason?: unknown }
  if (m.role !== 'assistant' || m.usage === null || typeof m.usage !== 'object') return false
  if (m.stopReason === 'aborted' || m.stopReason === 'error') return false
  return calculateContextTokens(m.usage as Parameters<typeof calculateContextTokens>[0]) > 0
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
 * tokens 参与指纹（回合结束后真实变化）；compacting 变化同样发布。
 */
export function contextUsageKeyOf(usage: ConversationContextUsage | undefined): string {
  if (usage === undefined) return ''
  return JSON.stringify([usage.tokens, usage.contextWindow ?? null, usage.compacting ?? null])
}
