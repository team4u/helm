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
import type { ConversationLiveMessage } from '@helm/protocol'

export const TOKEN_SPEED_PLUGIN_ID = 'builtin:token-speed'

/** 每会话速率状态文档名（public sessionDoc；订阅流键 (pluginId, name, convId)）。 */
export const TOKEN_SPEED_DOC = 'speed'

/** 默认时间滑动窗口（毫秒）；与 pi-token-speed 参考实现一致。 */
export const DEFAULT_SLIDING_WINDOW_MS = 1000

/** 配置允许的窗口范围（毫秒）；越界值在读取处钳制，不静默拒绝用户配置。 */
export const MIN_SLIDING_WINDOW_MS = 100
export const MAX_SLIDING_WINDOW_MS = 30_000

/** sessionDoc 写入节流间隔（毫秒）：live 帧最短 75ms、partial 节流 100ms，
 * 120ms 兼顾实时跟手与写入降频（首测 / 阶段变化 / 终态立即写，同阶段尾帧延迟补写）。 */
export const DOC_WRITE_INTERVAL_MS = 120

/** token 口径：provider = 供应商 usage 增量；estimate = chars/4 估算；
 * mixed = 同一测量内两种口径都有。 */
export type TokenSpeedSource = 'provider' | 'estimate' | 'mixed'

/** 上下文失效边界 marker（与内核 context-usage 同一口径）：这些条目落库即
 * 表示旧上下文对模型已不可见，其上的速率事实对新上下文不可归属。 */
export const CONTEXT_INVALIDATION_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'pi.reset',
  'pi.compaction',
  'helm.rewind',
])

/** conversation.entry 事件守卫抽取出的信封事实（先于按 kind 分流校验）。 */
export interface ConversationEntryEnvelope {
  conversationId: number
  kind: string
}

/** 每会话速率状态（sessionDoc `speed` 的值；null = 尚无可显示测量）。 */
export interface TokenSpeedStatus {
  /** 当前阶段：decoding = 模型生成中；tools = 工具执行中（解码时钟暂停，
   * 保留本回合最近有效速率展示）；settled = 回合已结算（终态对账值，保留
   * 到下一回合开始）。 */
  phase: 'decoding' | 'tools' | 'settled'
  /** 当前速率 tokens/sec：decoding = 时间滑动窗口速率（停顿或轮间首字等待期
   * 保持本回合最近有效值）；tools = 暂停解码计时并保持最近有效值；settled =
   * 对账解码速率（仅汇总计数与时长可配对的响应）。仅在本回合尚无可靠首测或
   * settled 无可配对测量时省略——绝不以 0.0 冒充真实速率。 */
  tps?: number
  /** 累计输出 tokens（口径见 source；终态已尽量用最终 usage.output 对账）。 */
  outputTokens: number
  /** 累计解码净耗时（毫秒）：各解码段（首增长观测 -> 末增长观测）之和；
   * 不含 TTFT 与工具执行时间。观测粒度受 live 节流（75ms）与 pi-durable
   * partial 提交节流（默认 100ms）限制，为保守近似。 */
  decodeMs: number
  source: TokenSpeedSource
  /** 本回合首字延迟（毫秒）。起点是插件首次观测到空 generation 的帧时间
   * （内核不提供请求开始锚点，不伪造；受双重节流影响，可能偏大或偏小）。 */
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
 * 统计模型消息 content 块的累计生成字符量：
 * text + thinking + toolCall(name + arguments JSON)。
 * 流式投影（tracker.ts）与落库 pi.assistant 尾帧补算共用同一公式。
 */
export function contentCharsOfBlocks(content: readonly unknown[]): number {
  let chars = 0
  for (const block of content) {
    if (!isPlainObject(block)) continue
    const type = block['type']
    if (type === 'text' && typeof block['text'] === 'string') {
      chars += block['text'].length
    } else if (type === 'thinking' && typeof block['thinking'] === 'string') {
      chars += block['thinking'].length
    } else if (type === 'toolCall' && typeof block['name'] === 'string') {
      chars += block['name'].length
      if ('arguments' in block && block['arguments'] !== undefined) {
        try {
          const serialized = JSON.stringify(block['arguments'])
          if (typeof serialized === 'string') chars += serialized.length
        } catch {
          // 非 JSON 参数形状：跳过（不伪造长度）。
        }
      }
    }
  }
  return chars
}

/** conversation.live 事件守卫的输出帧（速率策略消费的最小子集）。
 * generation 身份是必需事实：taskId / attempt 均为正整数（taskId 语义来自
 * SDK live.run.taskId，与 pi.assistant entry 的 taskId 同源，是流式快照与
 * 最终落库结果精确关联的连接键）——身份缺失或非法的帧整体拒绝，绝不降级
 * 消费。 */
export interface TokenSpeedLiveFrame {
  conversationId: number
  generation?: { taskId: number; attempt: number; message?: ConversationLiveMessage }
  hasTools: boolean
  updatedAt: number
}

/**
 * conversation.live 事件守卫（速率策略消费的最小子集）：HelmEvent 信封 +
 * live.{conversationId 正整数, generation 可选受限形状（taskId+attempt 正整
 * 数为必需身份）, updatedAt 有限非负}。非法返回 undefined（调用方丢弃），
 * 绝不粗 as 信任。
 */
export function asConversationLiveFrame(payload: unknown): TokenSpeedLiveFrame | undefined {
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
  const taskId = generation['taskId']
  if (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0) return undefined
  const attempt = generation['attempt']
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt <= 0) return undefined
  const message = generation['message']
  if (message === undefined) return { conversationId, generation: { taskId, attempt }, hasTools, updatedAt }
  if (!isPlainObject(message) || !Array.isArray(message['content'])) return undefined
  const usage = message['usage']
  if (usage !== undefined && (!isPlainObject(usage) || typeof usage['output'] !== 'number')) return undefined
  return {
    conversationId,
    generation: { taskId, attempt, message: message as unknown as ConversationLiveMessage },
    hasTools,
    updatedAt,
  }
}

/**
 * conversation.entry 事件信封守卫（先于按 kind 分流）：HelmEvent 信封 +
 * conversationId 正整数 + entry.{kind 非空字符串}。非法返回 undefined。
 */
export function asConversationEntryEnvelope(payload: unknown): ConversationEntryEnvelope | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = payload['entry']
  if (!isPlainObject(entry) || typeof entry['kind'] !== 'string' || entry['kind'] === '') return undefined
  return { conversationId, kind: entry['kind'] }
}

/** pi.assistant entry 的通用完成事实（不过滤成败：失败 / 中止请求同样需要
 * 告知策略层「该请求已终结」；策略据此按身份决定对账还是作废）。
 * - taskId：entry.taskId（内核 byTaskId 投影的正整数；scheduler 上下文等
 *   无归属时缺省——身份不明的事实不关联不猜测）；
 * - usageOutput：正有限数（未上报 / 零值省略，绝不以 0 对账）；
 * - stopReason：必需（aborted / error 为失败尝试，计数与时间作废）；
 * - contentChars：model[0].content 为数组时的累计字符量（用于补算取消尾
 *   partial 定时器后的真实尾部增量；缺省时省略）。 */
export interface AssistantCompletionFacts {
  conversationId: number
  taskId: number | undefined
  entryId: string | undefined
  usageOutput: number | undefined
  stopReason: string
  contentChars?: number
}

/**
 * conversation.entry 事件守卫（pi.assistant 完成事实抽取）：model[0] 必须是
 * role = assistant 且携带 stopReason 的消息；usage.output 为正有限数时携带，
 * content 为数组时携带 contentChars。不按 stopReason 过滤成败（失败请求的
 * 终结事实同样返回），成功与否的处置归策略层；载荷形状非法返回 undefined。
 */
export function asAssistantCompletion(payload: unknown): AssistantCompletionFacts | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = payload['entry']
  if (!isPlainObject(entry) || entry['kind'] !== 'pi.assistant') return undefined
  const rawTaskId = entry['taskId']
  const taskId =
    typeof rawTaskId === 'number' && Number.isInteger(rawTaskId) && rawTaskId > 0 ? rawTaskId : undefined
  const rawEntryId = entry['id']
  const entryId = typeof rawEntryId === 'string' ? rawEntryId : undefined
  const model = entry['model']
  if (!Array.isArray(model) || !isPlainObject(model[0])) return undefined
  const first = model[0] as Record<string, unknown>
  if (first['role'] !== 'assistant') return undefined
  const stopReason = first['stopReason']
  if (typeof stopReason !== 'string' || stopReason === '') return undefined
  const usage = first['usage']
  let usageOutput: number | undefined
  if (isPlainObject(usage)) {
    const output = usage['output']
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) usageOutput = output
  }
  const content = first['content']
  const contentChars = Array.isArray(content) ? contentCharsOfBlocks(content) : undefined
  return {
    conversationId,
    taskId,
    entryId,
    usageOutput,
    stopReason,
    ...(contentChars !== undefined ? { contentChars } : {}),
  }
}

/** conversation.deleted 事件守卫：返回会话 id。 */
export function asConversationDeletedId(payload: unknown): number | undefined {
  if (!isPlainObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  const conversationId = payload['conversationId']
  return typeof conversationId === 'number' && Number.isInteger(conversationId) && conversationId > 0
    ? conversationId
    : undefined
}
