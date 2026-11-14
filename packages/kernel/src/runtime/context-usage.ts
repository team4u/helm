/**
 * 会话上下文用量计算（纯函数；对齐 pi-durable 的 compaction/estimate 逻辑）。
 *
 * 事实依据（@earendil-works/pi-durable 1.5.0 `dist/harness/compaction.js` 的
 * `estimateContext(view, extra)` 实测源码）：SDK 在生成前的阈值压缩判定用
 * 「实测锚点 + 尾段估算」——从 view.entries 尾部向前找 head 标记之后最近一条
 * usage > 0 的 assistant 消息（其请求前缀在当前有效上下文内），tokens =
 * 该 usage 的上下文 tokens + 其后消息的字符估算；找不到则全量估算。
 *
 * 为什么不裸用 `estimateContextTokens(messages)`（pi-ai utils）：它只看消息
 * 数组，不知道 head 标记位置；压缩/重置后旧 usage 会被误当作有效锚点。
 * 为什么在本仓重写而不再用 SDK 函数：`estimateContext` 未从
 * `@earendil-works/pi-durable` 的公开 exports 导出（仅 dist 内部模块），走
 * 私有子路径违反包边界。本模块逐行对齐其语义，并额外拆出实测/估算两段；
 * 基础原语 `calculateContextTokens` / `estimateMessageTokens` 复用 pi-ai
 * 公开导出（SDK 同一来源），估算常数不复制。
 *
 * helm.rewind/omit 语义：SDK `Conversation.context()` 返回的 ContextView 已按
 * edits 应用 omit（被覆盖条目 contributions 为空数组）且 head 指向最新边界，
 * 因此锚点回扫天然只命中「当前有效上下文内、最近一次 rewind 覆盖区间之外」
 * 的 assistant usage；锚点失效时（如 rewind 后尚无新回答且旧 usage 均被
 * omit/越过 head）自动退化为当前有效消息的全量估算，无需额外分支。
 */

import type { ContextView } from '@earendil-works/pi-durable'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { Message } from '@earendil-works/pi-ai'
import type { ConversationContextUsage } from '@helm/protocol'

/** 估算结果：总 tokens 与实测部分（全估算时 measuredTokens 省略）。 */
export interface ContextUsageEstimate {
  tokens: number
  measuredTokens?: number
}

/**
 * 对齐 pi-durable `estimateContext(view, [])` 的上下文估算。
 *
 * - 实测锚点：view.entries 从尾向前、跳过 id <= head.id 的条目，在
 *   contributions 中找最后一条 usage 上下文 tokens > 0 的 assistant 消息；
 * - tokens = 锚点 usage 上下文 tokens + view.messages 中锚点之后的消息估算；
 * - 无锚点：view.messages 全量估算（measuredTokens 省略）。
 */
export function estimateContextUsage(view: ContextView): ContextUsageEstimate {
  let measured: { role: 'assistant'; usage: Parameters<typeof calculateContextTokens>[0] } | undefined
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY
  for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index -= 1) {
    if (view.entries[index]!.id <= after) continue
    // 与 SDK findLast 等价：取 contributions 内最后一条实测 assistant。
    for (const message of view.contributions[index]!) {
      if (isMeasuredAssistant(message)) measured = message
    }
  }
  // 锚点对象来自 contributions，与 messages 同源同引用（lastIndexOf 按身份命中）；
  // 结构子集到 Message 的断言是同一运行时对象的 widening，不引入任何伪造。
  const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured as Message) + 1
  let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage)
  for (const message of view.messages.slice(from)) {
    tokens += estimateMessageTokens(message)
  }
  return measured === undefined ? { tokens } : { tokens, measuredTokens: calculateContextTokens(measured.usage) }
}

function isMeasuredAssistant(message: unknown): message is {
  role: 'assistant'
  usage: Parameters<typeof calculateContextTokens>[0]
} {
  if (message === null || typeof message !== 'object') return false
  const m = message as { role?: unknown; usage?: unknown }
  if (m.role !== 'assistant' || m.usage === null || typeof m.usage !== 'object') return false
  // 与 SDK 同公式（totalTokens 或四费率之和）；非法形状不作为锚点（派生展示
  // 数据不因个别损坏条目中断刷新）。usage 必为对象，公式内不再解引用 null。
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

const COMPACTION_TRIGGERS = new Set(['manual', 'threshold', 'overflow'])

/**
 * 由 live 镜像透传压缩实时状态：多项压缩任务时取最新（taskId 序尾项）；
 * trigger 非法（未知 SDK 版本形状）时省略 compacting 而不是伪造。
 */
export function compactingOf(
  compactions: readonly LiveCompactionShape[] | undefined,
): ConversationContextUsage['compacting'] {
  const latest = compactions?.[compactions.length - 1]
  if (latest === undefined) return undefined
  if (!COMPACTION_TRIGGERS.has(latest.trigger)) return undefined
  return { trigger: latest.trigger as 'manual' | 'threshold' | 'overflow', blocking: latest.blocking === true }
}

/** 压缩失败摘要（脱敏 + 400 字符截断由调用方 redact 注入；此处仅截断）。 */
export function compactionErrorOf(
  failure: LiveCompactionFailureShape | undefined,
  redact: (text: string) => string,
): string | undefined {
  if (failure === undefined) return undefined
  const text = redact(failure.error ?? '').trim()
  return text === '' ? undefined : text.slice(0, 400)
}

/**
 * 组装完整 contextUsage（可缺字段全部省略，不伪造）。
 * window/thresholds 由调用方按模型解析结果给出（未知传 undefined）。
 */
export function assembleContextUsage(parts: {
  estimate: ContextUsageEstimate
  contextWindow?: number
  thresholds?: ConversationContextUsage['thresholds']
  compacting?: ConversationContextUsage['compacting']
  compactionError?: string
}): ConversationContextUsage {
  return {
    tokens: parts.estimate.tokens,
    ...(parts.estimate.measuredTokens !== undefined ? { measuredTokens: parts.estimate.measuredTokens } : {}),
    ...(parts.contextWindow !== undefined ? { contextWindow: parts.contextWindow } : {}),
    ...(parts.thresholds !== undefined ? { thresholds: parts.thresholds } : {}),
    ...(parts.compacting !== undefined ? { compacting: parts.compacting } : {}),
    ...(parts.compactionError !== undefined ? { compactionError: parts.compactionError } : {}),
  }
}

/**
 * contextUsage 语义指纹（发布去重）：任一承载字段变化才发布 conversation.upsert。
 * tokens 参与指纹（回合结束后真实变化）；compacting/blocking 变化同样发布。
 */
export function contextUsageKeyOf(usage: ConversationContextUsage | undefined): string {
  if (usage === undefined) return ''
  return JSON.stringify([
    usage.tokens,
    usage.measuredTokens ?? null,
    usage.contextWindow ?? null,
    usage.thresholds?.blockingTokens ?? null,
    usage.thresholds?.backgroundTokens ?? null,
    usage.compacting?.trigger ?? null,
    usage.compacting?.blocking ?? null,
    usage.compactionError ?? null,
  ])
}
