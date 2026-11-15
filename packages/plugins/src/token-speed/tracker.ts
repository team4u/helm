/**
 * builtin:token-speed 的纯速率算法（无 IO、时间注入可测；策略全在插件）。
 *
 * 算法参考本机 pi-token-speed 扩展（时间滑动窗口 / burst-stall 跨度延伸 /
 * 工具执行暂停时钟），按内核 ConversationLive 可观察事实重写：
 *
 * - 输入是内核 live 节流帧（默认 75ms）里的 generation 累计快照
 *   （attempt + 受限 message 投影），不是逐 token 事件；pi-durable partial
 *   提交节流（默认 100ms）再叠加一层粒度限制。全部时间测量的粒度是帧粒度：
 *   decode 段跨度按「首增长帧 -> 末增长帧」计算，两端各保守少计至多约一个
 *   节流窗；TTFT 起点只能取「首次观测到 generation 的帧时间」（内核不提供
 *   请求开始锚点，不伪造），展示端必须如实标注。
 * - 段（segment）：同一 generation attempt 的连续内容增长。attempt 变化或
 *   内容快照大幅回退（message 清空 / 工具轮 handOver 重启）都视为新段——
 *   重试 / partial 重放绝不重复累计；小幅回退（provider 在 *_end 重发整块
 *   文本）不构成段重置。工具执行时间落在 generation 缺席帧（tools 阶段），
 *   段间解码计时自然拼接，绝不计入工具耗时。
 * - provider usage：generation.message.usage.output 是供应商累计口径（如
 *   Anthropic 持续上报；OpenAI 兼容网关常只在终值）。优先用其增量；无推进
 *   时退回 chars/4 估算。conversation.entry 落库的最终 usage.output 是权威
 *   值，到达即对账覆盖该段流式口径（FIFO 对应最近未对账段；entry 事件先于
 *   同提交的 live 帧到达，折叠提交下按待对账队列消费）。
 * - burst/stall 防尖峰：窗口内全部事件同一时间戳且同段（缓冲后一次冲刷）且
 *   存在同段前驱事件时，跨度向前延伸到前驱事件时间（把缓冲停滞期计入有效
 *   吞吐，对齐 pi-token-speed Sliding Window 语义）；跨段（工具轮/重试间隙）
 *   绝不延伸。跨度下限 100ms。
 * - 中途接入（插件启用 / 重启发生在流中）：首帧内容只作基线，不记窗口事件
 *   （历史内容时间不可归属，绝不制造首帧尖峰）；TTFT 同理不可测，省略。
 */
import type { ConversationLiveMessage } from '@helm/protocol'
import type { TokenSpeedSource, TokenSpeedStatus } from './contracts.js'

/** 窗口事件：一次内容增长帧（时间戳 + 增量 tokens + 所属段 id）。 */
interface WindowEvent {
  time: number
  tokens: number
  segment: number
}

/** 事件数组死前缀压缩阈值（对齐 pi-token-speed COMPACTION_THRESHOLD）。 */
const WINDOW_COMPACTION_THRESHOLD = 5000

/** 待对账 usage 队列上限：防御异常事件序列无界堆积。 */
const PENDING_USAGE_LIMIT = 64

/** 时间滑动窗口（参考 pi-token-speed SlidingWindow）。 */
export class SlidingWindow {
  private readonly events: WindowEvent[] = []
  private windowStartIndex = 0

  constructor(
    private readonly windowMs: number,
    private readonly minSpanMs: number,
  ) {}

  /** 记录一次增长帧（tokens 非正直接忽略）。 */
  record(time: number, tokens: number, segment: number): void {
    if (tokens <= 0) return
    this.events.push({ time, tokens, segment })
    if (this.windowStartIndex >= WINDOW_COMPACTION_THRESHOLD) this.compact()
  }

  /** 当前窗口速率 tokens/sec；窗口内无事件返回 0。 */
  getTps(now: number): number {
    if (this.events.length === 0) return 0
    const windowStart = now - this.windowMs
    while (
      this.windowStartIndex < this.events.length &&
      this.events[this.windowStartIndex]!.time < windowStart
    ) {
      this.windowStartIndex += 1
    }
    if (this.windowStartIndex >= this.events.length) return 0
    let windowTokens = 0
    for (let i = this.windowStartIndex; i < this.events.length; i += 1) {
      windowTokens += this.events[i]!.tokens
    }
    if (windowTokens <= 0) return 0
    const first = this.events[this.windowStartIndex]!
    const last = this.events[this.events.length - 1]!
    const sameTimestampCluster =
      first.time === last.time && first.segment === last.segment
    let spanStart = first.time
    if (sameTimestampCluster && this.windowStartIndex > 0) {
      const previous = this.events[this.windowStartIndex - 1]!
      if (previous.segment === first.segment) spanStart = previous.time
    }
    const span = Math.max(now - spanStart, this.minSpanMs)
    return (1000 * windowTokens) / span
  }

  reset(): void {
    this.events.length = 0
    this.windowStartIndex = 0
  }

  private compact(): void {
    if (this.windowStartIndex === 0) return
    this.events.splice(0, this.windowStartIndex)
    this.windowStartIndex = 0
  }
}

/**
 * 受限 message 投影 -> 累计生成字符量。
 * 计 text + thinking 块字符与 toolCall 的 name + 参数 JSON 字符（tool-call
 * 参数是模型生成 token，绝不漏计）。
 */
export function generatedCharsOf(message: ConversationLiveMessage | undefined): number {
  if (message === undefined) return 0
  let chars = 0
  for (const block of message.content) {
    if (block.type === 'text') {
      chars += block.text.length
    } else if (block.type === 'thinking') {
      chars += block.thinking.length
    } else if (block.type === 'toolCall') {
      chars += block.name.length
      if (block.arguments !== undefined) {
        try {
          chars += JSON.stringify(block.arguments).length
        } catch {
          // 非 JSON 参数形状：跳过（不伪造长度）。
        }
      }
    }
  }
  return chars
}

/** chars/4 保守估算的单次增量（>0 时至少 1 token）。 */
export function estimateTokensOf(deltaChars: number): number {
  if (deltaChars <= 0) return 0
  return Math.max(1, Math.ceil(deltaChars / 4))
}

/** 一个解码段（同一 generation attempt 的连续内容增长）。 */
interface Segment {
  id: number
  attempt: number
  /** 段内累计快照基线（字符）。 */
  chars: number
  /** 段内最后见到的供应商累计 output（0 = 未见）。 */
  providerOutput: number
  /** 段内累计 tokens（流式口径）。 */
  tokens: number
  usedEstimate: boolean
  usedProvider: boolean
  firstGrowthAt: number | undefined
  lastGrowthAt: number | undefined
}

/**
 * 单会话速率状态机：链（用户回合，跨工具轮 handOver）为累积单位，段
 * （generation attempt）为窗口 / 计时单位。全部时间由调用方注入。
 */
export class ConversationTokenSpeedTracker {
  private segmentSeq = 0
  private active: Segment | undefined
  private committedTokens = 0
  private committedDecodeMs = 0
  /** 已关闭段中尚未被最终 usage 对账的段（FIFO）。 */
  private readonly unreconciled: Segment[] = []
  /** 先于段关闭到达的最终 usage（entry 事件先于同提交 live 帧）。 */
  private readonly pendingUsages: number[] = []
  private providerSegments = 0
  private estimateSegments = 0
  private readonly window: SlidingWindow
  private readonly windowMs: number
  /** 最近一次观测到无内容 generation 的帧时间（TTFT 起点锚；仅干净观测可测）。 */
  private emptyGenerationSeenAt: number | undefined
  private firstContentAt: number | undefined
  private ttftMs: number | undefined
  /** 链内是否观测过无内容的 generation（干净起点 / 中途接入判定）。 */
  private sawEmptyGeneration = false
  private phase: 'decoding' | 'tools' = 'decoding'

  constructor(options: { windowMs: number; minSpanMs: number }) {
    this.windowMs = options.windowMs
    this.window = new SlidingWindow(options.windowMs, options.minSpanMs)
  }

  /** 新落库 assistant entry 的最终 usage.output（FIFO 对账最近未对账段）。 */
  noteAssistantUsage(usageOutput: number | undefined): void {
    if (usageOutput === undefined) return
    const queued = this.unreconciled.shift()
    if (queued !== undefined) {
      this.reconcileSegment(queued, usageOutput)
      return
    }
    if (this.pendingUsages.length < PENDING_USAGE_LIMIT) this.pendingUsages.push(usageOutput)
  }

  private reconcileSegment(segment: Segment, usageOutput: number): void {
    // 权威值覆盖段流式口径（关闭时已按估算并入 committedTokens，此处补差）。
    this.committedTokens += usageOutput - segment.tokens
    segment.tokens = usageOutput
    // 来源计数翻转：对账后该段是 provider 口径（抹去此前的估算计数）。
    if (segment.usedEstimate) {
      this.estimateSegments -= 1
      segment.usedEstimate = false
    }
    if (!segment.usedProvider) {
      this.providerSegments += 1
      segment.usedProvider = true
    }
  }

  /** 采纳一帧 conversation.live（generation 缺席 = 工具阶段 / 段间间隙）。 */
  observeFrame(now: number, frame: { generation?: { attempt: number; message?: ConversationLiveMessage }; hasTools: boolean }): void {
    const generation = frame.generation
    if (generation === undefined) {
      this.phase = 'tools'
      this.closeSegment()
      return
    }
    this.phase = 'decoding'

    const chars = generatedCharsOf(generation.message)
    if (chars === 0) {
      // 观测到无内容的 generation（含链首与重试间隙）：TTFT 起点锚记。
      this.emptyGenerationSeenAt = now
      this.sawEmptyGeneration = true
    }
    const current = this.active
    if (current === undefined || this.isSegmentReset(current, generation.attempt, chars)) {
      this.closeSegment()
      // 中途接入判定：链首帧即带内容且从未见过空 generation——历史内容时间
      // 不可归属，只建基线（不记窗口事件、不测 TTFT），绝不制造首帧尖峰。
      const baselineOnly = chars > 0 && this.firstContentAt === undefined && !this.sawEmptyGeneration
      const segment: Segment = {
        id: (this.segmentSeq += 1),
        attempt: generation.attempt,
        chars: baselineOnly ? chars : 0,
        providerOutput: 0,
        tokens: 0,
        usedEstimate: false,
        usedProvider: false,
        firstGrowthAt: undefined,
        lastGrowthAt: undefined,
      }
      this.active = segment
      if (baselineOnly) {
        const seenOutput = generation.message?.usage?.output
        if (seenOutput !== undefined) segment.providerOutput = seenOutput
        return
      }
    }

    const segment = this.active!
    const deltaChars = Math.max(0, chars - segment.chars)
    const provider = generation.message?.usage?.output
    let deltaTokens = 0
    if (provider !== undefined && provider > segment.providerOutput) {
      deltaTokens = provider - segment.providerOutput
      segment.providerOutput = provider
      segment.usedProvider = true
    } else if (deltaChars > 0) {
      deltaTokens = estimateTokensOf(deltaChars)
      segment.usedEstimate = true
    }
    segment.chars = Math.max(segment.chars, chars)
    if (deltaTokens <= 0) return

    if (this.firstContentAt === undefined) {
      this.firstContentAt = now
      // TTFT 仅在起点可靠（先观测到空 generation，之后同一观测流出现内容）时
      // 测量；中途接入（首帧即带内容、只建基线）拿不到起点，省略不伪造。
      if (this.emptyGenerationSeenAt !== undefined && this.emptyGenerationSeenAt < now) {
        this.ttftMs = now - this.emptyGenerationSeenAt
      }
    }
    if (segment.firstGrowthAt === undefined) segment.firstGrowthAt = now
    segment.lastGrowthAt = now
    segment.tokens += deltaTokens
    this.window.record(now, deltaTokens, segment.id)
  }

  private isSegmentReset(segment: Segment, attempt: number, chars: number): boolean {
    if (attempt !== segment.attempt) return true
    if (chars < segment.chars) return chars === 0 || chars * 2 < segment.chars
    return false
  }

  /** 关闭活动段：解码跨度并账；估算口径立即计入总数；待对账 usage 立即对账，
 * 否则挂未对账队列（后续 entry 到达时补差）。 */
  private closeSegment(): void {
    const segment = this.active
    if (segment === undefined) return
    this.active = undefined
    if (segment.firstGrowthAt !== undefined && segment.lastGrowthAt !== undefined) {
      this.committedDecodeMs += Math.max(0, segment.lastGrowthAt - segment.firstGrowthAt)
    }
    this.committedTokens += segment.tokens
    this.accountSource(segment)
    const pending = this.pendingUsages.shift()
    if (pending !== undefined) {
      this.reconcileSegment(segment, pending)
      return
    }
    if (segment.tokens > 0) {
      this.unreconciled.push(segment)
      if (this.unreconciled.length > PENDING_USAGE_LIMIT) this.unreconciled.shift()
    }
  }

  /** 段来源计数（关闭时按流式口径；后续对账会翻转）。 */
  private accountSource(segment: Segment): void {
    if (segment.usedProvider) this.providerSegments += 1
    if (segment.usedEstimate) this.estimateSegments += 1
  }

  /** 当前累计（live 帧口径：已关闭段 + 活动段）。 */
  private totals(): { tokens: number; decodeMs: number } {
    const active = this.active
    const activeDecode =
      active !== undefined && active.firstGrowthAt !== undefined && active.lastGrowthAt !== undefined
        ? Math.max(0, active.lastGrowthAt - active.firstGrowthAt)
        : 0
    return {
      tokens: this.committedTokens + (active?.tokens ?? 0),
      decodeMs: this.committedDecodeMs + activeDecode,
    }
  }

  private sourceOf(activeProvider = false, activeEstimate = false): TokenSpeedSource {
    const provider = this.providerSegments + (activeProvider ? 1 : 0)
    const estimate = this.estimateSegments + (activeEstimate ? 1 : 0)
    if (provider > 0 && estimate > 0) return 'mixed'
    if (provider > 0) return 'provider'
    return 'estimate'
  }

  /** 组装当前实时状态；尚无可显示测量返回 undefined。 */
  liveStatus(now: number): TokenSpeedStatus | undefined {
    const { tokens, decodeMs } = this.totals()
    if (tokens <= 0) return undefined
    const status: TokenSpeedStatus = {
      phase: this.phase,
      outputTokens: tokens,
      decodeMs,
      source: this.sourceOf(this.active?.usedProvider === true, this.active?.usedEstimate === true),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      windowMs: this.windowMs,
      updatedAt: now,
    }
    if (this.phase === 'decoding') {
      const tps = this.window.getTps(now)
      if (tps > 0) return { ...status, tps }
    }
    return status
  }

  /** 回合结算：关闭活动段并对账待处理 usage，产出终态；无可测累计返回 undefined。 */
  settle(now: number): TokenSpeedStatus | undefined {
    this.closeSegment()
    const { tokens, decodeMs } = this.totals()
    if (tokens <= 0 || decodeMs <= 0) return undefined
    const status: TokenSpeedStatus = {
      phase: 'settled',
      outputTokens: tokens,
      decodeMs,
      source: this.sourceOf(),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      windowMs: this.windowMs,
      updatedAt: now,
    }
    const tps = (tokens / decodeMs) * 1000
    return Number.isFinite(tps) && tps > 0 ? { ...status, tps } : status
  }

  /** 链结束后彻底重置（下一回合从零开始，绝不跨链累计）。 */
  resetChain(): void {
    this.active = undefined
    this.committedTokens = 0
    this.committedDecodeMs = 0
    this.unreconciled.length = 0
    this.pendingUsages.length = 0
    this.providerSegments = 0
    this.estimateSegments = 0
    this.window.reset()
    this.emptyGenerationSeenAt = undefined
    this.firstContentAt = undefined
    this.ttftMs = undefined
    this.sawEmptyGeneration = false
    this.phase = 'decoding'
    this.segmentSeq = 0
  }
}
