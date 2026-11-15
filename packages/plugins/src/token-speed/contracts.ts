/**
 * builtin:token-speed 公开契约：插件 ID、会话文档形状与事件载荷边界守卫。
 *
 * 设计纪律：
 * - 速率计算全部是本插件的策略（内核只透传 ConversationLive.generation
 *   通用流式事实）；本文件不 import 内核实现；
 * - 高频会话级状态只进 sessionDoc（专用 SSE 按需订阅），绝不进全局 ctx.doc
 *   或 conversation summary（写放大红线）；
 * - 事件载荷在边界做形状守卫（非法丢弃并诊断），绝不粗 as 信任。
 */
import type { ConversationLive } from '@helm/protocol'

export const TOKEN_SPEED_PLUGIN_ID = 'builtin:token-speed'

/** 每会话速率状态文档名（public sessionDoc；订阅流键 (pluginId, name, convId)）。 */
export const TOKEN_SPEED_DOC = 'speed'

/** 默认时间滑动窗口（毫秒）；与 pi-token-speed 参考实现一致。 */
export const DEFAULT_SLIDING_WINDOW_MS = 1000

/** 配置允许的窗口范围（毫秒）；越界值在读取处钳制，不静默拒绝用户配置。 */
export const MIN_SLIDING_WINDOW_MS = 100
export const MAX_SLIDING_WINDOW_MS = 30_000

/** sessionDoc 写入节流间隔（毫秒）：live 帧最短 75ms 一帧，文档写入再降一个
 * 数量级（首测 / 阶段变化 / 终态不受节流，立即写）。 */
export const DOC_WRITE_INTERVAL_MS = 250

/** token 口径：provider = 供应商 usage 增量；estimate = chars/4 估算；
 * mixed = 同一测量内两种口径都有。 */
export type TokenSpeedSource = 'provider' | 'estimate' | 'mixed'

/** 每会话速率状态（sessionDoc `speed` 的值；null = 尚无可显示测量）。 */
export interface TokenSpeedStatus {
  /** 当前阶段：decoding = 模型生成中；tools = 工具执行中（解码时钟暂停）；
   * settled = 回合已结算（终态对账值，保留到下一回合开始）。 */
  phase: 'decoding' | 'tools' | 'settled'
  /** 当前速率 tokens/sec：decoding = 时间滑动窗口速率；settled = 对账解码
   * 速率（outputTokens / decodeMs）。无可靠测量（首字前 / 窗口滑空 / 工具
   * 暂停 / 终态无可测累计）时省略——绝不以 0.0 冒充真实速率。 */
  tps?: number
  /** 累计输出 tokens（口径见 source；终态已尽量用最终 usage.output 对账）。 */
  outputTokens: number
  /** 累计解码净耗时（毫秒）：各解码段（首增长观测 -> 末增长观测）之和；
   * 不含 TTFT 与工具执行时间。观测粒度受 live 节流（75ms）与 pi-durable
   * partial 提交节流（默认 100ms）限制，为保守近似。 */
  decodeMs: number
  source: TokenSpeedSource
  /** 本回合首字延迟（毫秒）。起点是插件首次观测到空 generation 的帧时间
   * （内核不提供请求开始锚点，不伪造；受双重节流限制，略偏大）。 */
  ttftMs?: number
  /** 生效的时间滑动窗口（毫秒）；速率口径说明用。 */
  windowMs: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 事件载荷边界守卫
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * conversation.live 事件守卫（速率策略消费的最小子集）：HelmEvent 信封 +
 * live.{conversationId 正整数, generation 可选受限形状, updatedAt 有限非负}。
 * 非法返回 undefined（调用方丢弃），绝不粗 as 信任。
 */
export function asConversationLiveFrame(payload: unknown):
  | {
      conversationId: number
      generation?: NonNullable<ConversationLive['generation']>
      hasTools: boolean
      updatedAt: number
    }
  | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.live') return undefined
  const live = payload['live']
  if (!isPlainObject(live)) return undefined
  const conversationId = live['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const updatedAt = live['updatedAt']
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) return undefined
  const tools = live['tools']
  const hasTools = Array.isArray(tools) && tools.length > 0
  const generation = live['generation']
  if (generation === undefined) return { conversationId, hasTools, updatedAt }
  if (!isPlainObject(generation)) return undefined
  const attempt = generation['attempt']
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) return undefined
  const message = generation['message']
  if (message === undefined) return { conversationId, generation: { attempt }, hasTools, updatedAt }
  if (!isPlainObject(message) || !Array.isArray(message['content'])) return undefined
  const usage = message['usage']
  if (usage !== undefined && (!isPlainObject(usage) || typeof usage['output'] !== 'number')) return undefined
  return {
    conversationId,
    generation: { attempt, ...(message !== undefined ? { message: message as never } : {}) },
    hasTools,
    updatedAt,
  }
}

/**
 * conversation.entry 事件守卫（终值对账消费）：pi.assistant entry 的
 * model[0].usage.output（正有限数；载荷异常返回 undefined 不对账）。
 */
export function asAssistantUsageOutput(payload: unknown): { conversationId: number; usageOutput: number | undefined } | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = payload['entry']
  if (!isPlainObject(entry) || entry['kind'] !== 'pi.assistant') return undefined
  const model = entry['model']
  if (!Array.isArray(model) || !isPlainObject(model[0])) return undefined
  const usage = (model[0] as { usage?: unknown }).usage
  let usageOutput: number | undefined
  if (isPlainObject(usage)) {
    const output = usage['output']
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) usageOutput = output
  }
  return { conversationId, usageOutput }
}

/** conversation.deleted 事件守卫：返回会话 id。 */
export function asConversationDeletedId(payload: unknown): number | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  const conversationId = payload['conversationId']
  return typeof conversationId === 'number' && Number.isInteger(conversationId) && conversationId > 0
    ? conversationId
    : undefined
}
