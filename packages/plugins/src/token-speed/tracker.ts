/**
 * builtin:token-speed 的纯速率算法（无 IO、时间注入可测；策略全在插件）。
 *
 * 算法参考本机 pi-token-speed 扩展（时间滑动窗口 / burst-stall 跨度延伸 /
 * 工具执行暂停时钟），按内核 ConversationLive 可观察事实重写：
 *
 * - 输入是内核 live 节流帧（默认 75ms）里的 generation 累计快照
 *   （taskId + attempt + 受限 message 投影），不是逐 token 事件；pi-durable
 *   partial 提交节流（默认 100ms）再叠加一层粒度限制。全部时间测量的粒度是
 *   帧粒度：decode 段跨度按「首增长帧 -> 末增长帧」计算，两端各保守少计至多
 *   约一个节流窗；TTFT 起点只能取「首次观测到 generation 的帧时间」（内核
 *   不提供请求开始锚点，不伪造），展示端必须如实标注。
 *
 * 显式请求身份（彻底取代内容回退启发式与 FIFO 对账猜测）：
 * - 一次模型请求 = 一个 (taskId, attempt)：taskId 是 SDK generation 任务
 *   （每工具轮 handOver 换新任务），attempt 只标记同任务内重试递增。工具
 *   轮边界即使 generation 缺席帧被 75ms 节流合并丢失，taskId 变化仍能精确
 *   分段——工具/请求间隙绝不计入任何段的解码跨度。
 * - 段（segment）= 一次模型请求的流式观测。conversation.entry 携带同源
 *   taskId（byTaskId 投影）：完成事实按 taskId 精确关联到段，entry 先于
 *   同提交 live 帧、迟到于段关闭帧均正确；无 taskId 的 entry（scheduler
 *   上下文等）身份不明，不关联不猜测。
 * - 完成事实按 stopReason 分流：aborted / error 是失败尝试——该段计数与解码
 *   时间全部丢弃（其 usage 不误配到成功重试，废弃估算不进回合总量）；
 *   成功请求的最终 usage.output 是权威值，到达即覆盖该段流式口径。
 *   无 usage 的成功完成也消费关闭对应段（保持流式估算口径）。
 * - 速率配对诚实性（不伪造分母）：中途接入（首帧即带历史内容、无空
 *   generation 基线）的段只测得 suffix 时间，而被整条 usage 对账后计数是
 *   全量——两者不可配对，该段只进 token 总量、绝不进终态速率的分子分母；
 *   单增长帧段（跨度 0）同样不进速率对。无可配对测量就不产终态速率。
 * - burst/stall 防尖峰：窗口内全部事件同一时间戳且同段（缓冲后一次冲刷）且
 *   存在同段前驱事件时，跨度向前延伸到前驱事件时间（把缓冲停滞期计入有效
 *   吞吐）；跨段（工具轮/重试间隙）绝不延伸。跨度下限 100ms。
 * - provider usage：generation.message.usage.output 是供应商累计口径（如
 *   Anthropic 持续上报；OpenAI 兼容网关常只在终值）。优先用其增量；无推进
 *   时退回 chars/4 估算。
 */
import type { ConversationLiveMessage } from '@helmx/protocol'
import { contentCharsOfBlocks, type TokenSpeedSource, type TokenSpeedStatus } from './contracts.js'

/** 窗口事件：一次内容增长帧（时间戳 + 增量 tokens + 所属段 id）。 */
interface WindowEvent {
  time: number
  tokens: number
  segment: number
}

/** 事件数组死前缀压缩阈值（对齐 pi-token-speed COMPACTION_THRESHOLD）。 */
const WINDOW_COMPACTION_THRESHOLD = 5000

/** 已完成段超过此数即折叠为累计值；不丢失长回合的 token 与时间。 */
const MAX_SEGMENTS = 64

/** 已消费 entry id 上限（防重去重有界）。 */
const MAX_SEEN_ENTRIES = 256

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
  return contentCharsOfBlocks(message.content)
}

/** chars/4 保守估算的单次增量（>0 时至少 1 token）。 */
export function estimateTokensOf(deltaChars: number): number {
  if (deltaChars <= 0) return 0
  return Math.max(1, Math.ceil(deltaChars / 4))
}

/** 一次模型请求的流式观测段。 */
interface Segment {
  /** 窗口聚类用的链内序号。 */
  id: number
  taskId: number
  attempt: number
  /** open = 观测中；closed = 边界帧已关、等完成事实；done = 成功完成已对账；
   * discarded = 失败尝试（计数与时间全部剔除）。 */
  state: 'open' | 'closed' | 'done' | 'discarded'
  /** 段内累计快照基线（字符）。 */
  chars: number
  /** 段内最后见到的供应商累计 output（0 = 未见）。 */
  providerOutput: number
  /** 段内累计 tokens（流式口径；成功对账后为权威值）。 */
  tokens: number
  usedEstimate: boolean
  usedProvider: boolean
  firstGrowthAt: number | undefined
  lastGrowthAt: number | undefined
  /** 本段首次观测到空 generation 的帧时间（段级 TTFT 起点锚）。 */
  emptySeenAt: number | undefined
  /** 中途接入基线段：历史内容时间不可归属（只测得 suffix）。 */
  baselineOnly: boolean
  /** 被整条 usage 对账后的基线段：计数与时间不可配对，不进速率对。 */
  rateExcluded: boolean
}

/** observeFrame 的 generation 输入形状（contracts 守卫产物）。 */
interface GenerationFrame {
  taskId: number
  attempt: number
  message?: ConversationLiveMessage
}

/** 完成事实（conversation.entry 的结构化投影；taskId 缺省 = 身份不明）。 */
export interface CompletionFact {
  taskId: number | undefined
  entryId: string | undefined
  /** 供应商最终 usage.output（正有限数；无上报缺省）。 */
  usageOutput: number | undefined
  stopReason: string | undefined
  /** model[0].content 的累计字符量（用于补算尾帧新增内容；缺省不补算）。 */
  contentChars?: number | undefined
}

/**
 * Single-conversation speed state machine: the chain (a user turn, across tool rounds) is the accumulation
 * unit; the segment (one model request, uniquely identified by (taskId, attempt)) is the window/timing unit. All time is injected by the caller.
 */
export class ConversationTokenSpeedTracker {
  private segmentSeq = 0
  private readonly segments: Segment[] = []
  private active: Segment | undefined
  /** taskId -> latest unconsumed segment (open / closed); completion facts associate exactly by this. */
  private readonly byTask = new Map<number, Segment>()
  /** Entry ids of consumed completion facts (duplicate entries not counted twice). */
  private readonly seenEntryIds = new Set<string>()
  /** Consumed task/attempt watermarks, rejecting late snapshots after completion; SDK task IDs increase monotonically. */
  private readonly completedAttempts = new Map<number, number>()
  private highestTaskId = 0
  /** Accumulated facts of folded successful segments; long turns lose no counts to record caps. */
  private readonly retired = { tokens: 0, decodeMs: 0, rateTokens: 0, rateDecodeMs: 0, provider: false, estimate: false }
  private readonly window: SlidingWindow
  private readonly windowMs: number
  private readonly minSpanMs: number
  /** This turn's most recent valid live speed; kept displayed during tool execution / inter-round TTFT waits / short pauses. */
  private lastLiveTps: number | undefined
  private firstContentAt: number | undefined
  private ttftMs: number | undefined
  /** Whether an empty generation was observed within the chain (clean-start / mid-way-join detection). */
  private sawEmptyGeneration = false
  private phase: 'decoding' | 'tools' = 'decoding'

  constructor(options: { windowMs: number; minSpanMs: number }) {
    this.windowMs = options.windowMs
    this.minSpanMs = options.minSpanMs
    this.window = new SlidingWindow(options.windowMs, options.minSpanMs)
  }

  /** Completion facts of a newly persisted pi.assistant entry: associate the segment exactly by taskId and backfill the trailing delta. */
  noteCompletion(fact: CompletionFact, now?: number): void {
    if (fact.taskId === undefined) return // unclear identity: neither associate nor guess
    if (fact.entryId !== undefined) {
      if (this.seenEntryIds.has(fact.entryId)) return
      this.seenEntryIds.add(fact.entryId)
      if (this.seenEntryIds.size > MAX_SEEN_ENTRIES) this.seenEntryIds.clear()
    }
    const segment = this.byTask.get(fact.taskId)
    if (segment === undefined) return // never observed this request's stream (mid-way enable/late): cannot associate
    this.byTask.delete(fact.taskId)
    this.completedAttempts.set(fact.taskId, segment.attempt)
    if (this.completedAttempts.size > MAX_SEEN_ENTRIES) {
      this.completedAttempts.delete(this.completedAttempts.keys().next().value!)
    }
    const failed = fact.stopReason === 'error' || fact.stopReason === 'aborted'
    if (failed) {
      // Failed attempt: the segment's counts and decoding time are discarded; usage is never mis-attributed to the successful retry.
      segment.state = 'discarded'
      if (this.active === segment) {
        this.active = undefined
        this.window.reset()
      }
      const countedTokens = this.countedSegments().reduce((acc, item) => acc + item.tokens, this.retired.tokens)
      if (countedTokens <= 0) this.lastLiveTps = undefined
      return
    }
    segment.state = 'done'
    if (this.active === segment) this.active = undefined

    const prevChars = segment.chars
    const deltaChars =
      typeof fact.contentChars === 'number' && Number.isFinite(fact.contentChars) && fact.contentChars >= 0
        ? Math.max(0, fact.contentChars - prevChars)
        : 0
    const hasContentOrUsage =
      deltaChars > 0 || (typeof fact.usageOutput === 'number' && Number.isFinite(fact.usageOutput) && fact.usageOutput > 0)
    if (hasContentOrUsage && this.firstContentAt === undefined && !segment.baselineOnly) {
      if (
        now !== undefined &&
        !this.countedSegments().some((item) => item !== segment) &&
        segment.emptySeenAt !== undefined &&
        segment.emptySeenAt < now
      ) {
        this.ttftMs = now - segment.emptySeenAt
      }
      this.firstContentAt = now ?? -1
    }

    let estDelta = 0
    if (deltaChars > 0) {
      estDelta = estimateTokensOf(fact.contentChars!) - estimateTokensOf(prevChars)
      const tailTokens =
        typeof fact.usageOutput === 'number' && fact.usageOutput > 0 && !segment.baselineOnly
          ? Math.max(0, fact.usageOutput - segment.tokens)
          : estDelta
      segment.chars = Math.max(segment.chars, fact.contentChars!)
      if (now !== undefined) {
        if (segment.firstGrowthAt !== undefined && now > segment.firstGrowthAt) {
          segment.lastGrowthAt = now
          if (tailTokens > 0) {
            this.window.record(now, tailTokens, segment.id)
            const tps = this.window.getTps(now)
            if (tps > 0) this.lastLiveTps = tps
          }
        } else if (
          segment.firstGrowthAt === undefined &&
          !segment.baselineOnly &&
          segment.emptySeenAt !== undefined &&
          now >= segment.emptySeenAt
        ) {
          // Ultra-short <100ms with zero intermediate partial frames: do not change decodeMs / settle()
          // semantics (no TTFT mixing); only estimate a conservative speed from the whole-segment span
          const effectiveTokens =
            typeof fact.usageOutput === 'number' && fact.usageOutput > 0 ? fact.usageOutput : estDelta
          if (effectiveTokens > 0) {
            const span = Math.max(now - segment.emptySeenAt, this.minSpanMs)
            this.lastLiveTps = (effectiveTokens * 1000) / span
          }
        }
      }
    }

    if (typeof fact.usageOutput === 'number' && fact.usageOutput >= 0) {
      if (segment.baselineOnly) segment.rateExcluded = true
      segment.tokens = fact.usageOutput
      segment.usedProvider = true
      segment.usedEstimate = false
    } else if (deltaChars > 0) {
      segment.tokens += estDelta
      segment.usedEstimate ||= estDelta > 0
    }
  }

  /** Adopt one conversation.live frame (generation absent = tool phase / inter-segment gap). */
  observeFrame(now: number, frame: { generation?: GenerationFrame; hasTools?: boolean }): void {
    const generation = frame.generation
    if (generation === undefined) {
      this.phase = 'tools'
      this.closeActive()
      return
    }
    // Tool-round taskIds increase monotonically; attempts within a task increase too. Late snapshots of
    // completed/old tasks from timers must not reopen measurement segments, let alone pollute the current request's window.
    if (generation.taskId < this.highestTaskId) return
    if (generation.attempt <= (this.completedAttempts.get(generation.taskId) ?? 0)) return
    const heldRequest = this.byTask.get(generation.taskId)
    if (heldRequest !== undefined && generation.attempt < heldRequest.attempt) return
    this.highestTaskId = Math.max(this.highestTaskId, generation.taskId)
    this.phase = 'decoding'

    const chars = generatedCharsOf(generation.message)
    const current = this.active
    const identityChanged =
      current !== undefined &&
      (current.taskId !== generation.taskId || current.attempt !== generation.attempt)
    if (identityChanged) {
      this.closeActive()
    }
    if (this.active === undefined) {
      const held = this.byTask.get(generation.taskId)
      if (held !== undefined && held.attempt === generation.attempt && held.state === 'closed') {
        // The same request identity returns after a boundary frame (e.g. a compaction wait gap): reopen and continue measuring.
        held.state = 'open'
        this.active = held
      } else {
        // Mid-way-join detection: the chain's first frame already carries content and no empty generation was
        // ever seen -- historical content time is unattributable; only establish a baseline (no window events, no TTFT), never fabricate a first-frame spike.
        const baselineOnly = chars > 0 && this.firstContentAt === undefined && !this.sawEmptyGeneration
        const segment: Segment = {
          id: (this.segmentSeq += 1),
          taskId: generation.taskId,
          attempt: generation.attempt,
          state: 'open',
          chars: baselineOnly ? chars : 0,
          providerOutput: 0,
          tokens: 0,
          usedEstimate: false,
          usedProvider: false,
          firstGrowthAt: undefined,
          lastGrowthAt: undefined,
          emptySeenAt: undefined,
          baselineOnly,
          rateExcluded: false,
        }
        if (baselineOnly) {
          const seenOutput = generation.message?.usage?.output
          if (seenOutput !== undefined) segment.providerOutput = seenOutput
        }
        // The live window describes only this request; the previous request and tool gaps never enter the window denominator.
        this.window.reset()
        this.pushSegment(segment)
        this.active = segment
      }
    }

    const segment = this.active!
    if (chars === 0) {
      // First observation of an empty generation within the segment: the anchor for this segment's TTFT / ultra-short-request start.
      segment.emptySeenAt ??= now
      this.sawEmptyGeneration = true
    }
    const deltaChars = Math.max(0, chars - segment.chars)
    const provider = generation.message?.usage?.output
    let deltaTokens = 0
    if (provider !== undefined && provider > segment.providerOutput) {
      deltaTokens = provider - segment.providerOutput
      segment.providerOutput = provider
      segment.usedProvider = true
    } else if (deltaChars > 0) {
      // Floor the cumulative character count before differencing, avoiding per-tiny-frame ceil inflation.
      deltaTokens = estimateTokensOf(chars) - estimateTokensOf(segment.chars)
      segment.usedEstimate ||= deltaTokens > 0
    }
    segment.chars = Math.max(segment.chars, chars)
    if (deltaChars <= 0 && deltaTokens <= 0) return

    if (this.firstContentAt === undefined) {
      this.firstContentAt = now
      // TTFT is measured only when the start is reliable (this turn's first non-voided segment first observes
      // an empty generation, then content appears in the same observation stream); omitted -- never fabricated -- for mid-way joins or rounds already started.
      if (
        !this.countedSegments().some((item) => item !== segment) &&
        segment.emptySeenAt !== undefined &&
        segment.emptySeenAt < now
      ) {
        this.ttftMs = now - segment.emptySeenAt
      }
    }
    if (segment.firstGrowthAt === undefined) segment.firstGrowthAt = now
    segment.lastGrowthAt = now
    segment.tokens += deltaTokens
    if (deltaTokens > 0) {
      this.window.record(now, deltaTokens, segment.id)
      const tps = this.window.getTps(now)
      if (tps > 0) this.lastLiveTps = tps
    }
  }

  /** Close the active segment (boundary frame / completion fact): wait for the completion fact to reconcile exactly. */
  private closeActive(): void {
    const segment = this.active
    if (segment === undefined) return
    this.active = undefined
    if (segment.state === 'open') segment.state = 'closed'
  }

  /** Fold only completed segments, keeping cumulative amounts; segments still awaiting completion facts must not be silently dropped. */
  private pushSegment(segment: Segment): void {
    this.segments.push(segment)
    this.byTask.set(segment.taskId, segment)
    if (this.segments.length <= MAX_SEGMENTS) return
    const index = this.segments.findIndex((item) => item.state === 'done' || item.state === 'discarded')
    if (index < 0) return
    const [retired] = this.segments.splice(index, 1)
    if (retired === undefined || retired.state === 'discarded') return
    const span = this.spanOf(retired)
    this.retired.tokens += retired.tokens
    this.retired.decodeMs += span
    this.retired.provider ||= retired.usedProvider
    this.retired.estimate ||= retired.usedEstimate
    if (!retired.rateExcluded && span > 0) {
      this.retired.rateTokens += retired.tokens
      this.retired.rateDecodeMs += span
    }
  }

  /** Segment decoding span (ms); 0 with no growth observations. */
  private spanOf(segment: Segment): number {
    if (segment.firstGrowthAt === undefined || segment.lastGrowthAt === undefined) return 0
    return Math.max(0, segment.lastGrowthAt - segment.firstGrowthAt)
  }

  /** Segments counted into totals (failed attempts all excluded). */
  private countedSegments(): Segment[] {
    return this.segments.filter((segment) => segment.state !== 'discarded')
  }

  /** Speed-pairable segments: counts and time share a source (non-reconciled baseline segments and spans > 0). */
  private rateableSegments(): Segment[] {
    return this.countedSegments().filter((segment) => !segment.rateExcluded && this.spanOf(segment) > 0)
  }

  private sourceOf(): TokenSpeedSource {
    let provider = this.retired.provider ? 1 : 0
    let estimate = this.retired.estimate ? 1 : 0
    for (const segment of this.countedSegments()) {
      if (segment.usedProvider) provider += 1
      if (segment.usedEstimate) estimate += 1
    }
    if (provider > 0 && estimate > 0) return 'mixed'
    if (provider > 0) return 'provider'
    return 'estimate'
  }

  /** Assemble the current live state; returns undefined when no measurement is displayable yet. */
  liveStatus(now: number): TokenSpeedStatus | undefined {
    const counted = this.countedSegments()
    const tokens = counted.reduce((acc, segment) => acc + segment.tokens, this.retired.tokens)
    if (tokens <= 0) return undefined
    const decodeMs = counted.reduce((acc, segment) => acc + this.spanOf(segment), this.retired.decodeMs)
    const status: TokenSpeedStatus = {
      phase: this.phase,
      outputTokens: tokens,
      decodeMs,
      source: this.sourceOf(),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      windowMs: this.windowMs,
      updatedAt: now,
    }
    if (this.phase === 'decoding' && this.active?.firstGrowthAt !== undefined) {
      const tps = this.window.getTps(now)
      if (tps > 0) {
        this.lastLiveTps = tps
        return { ...status, tps }
      }
    }
    if (this.lastLiveTps !== undefined && this.lastLiveTps > 0) {
      return { ...status, tps: this.lastLiveTps }
    }
    return status
  }

  /** Turn settlement: close the active segment and produce the terminal state; speed is computed only from
 * pairable segments (no fabricated denominator); returns undefined with nothing measurable. */
  settle(now: number): TokenSpeedStatus | undefined {
    this.closeActive()
    const counted = this.countedSegments()
    const tokens = counted.reduce((acc, segment) => acc + segment.tokens, this.retired.tokens)
    if (tokens <= 0) return undefined
    const decodeMs = counted.reduce((acc, segment) => acc + this.spanOf(segment), this.retired.decodeMs)
    const status: TokenSpeedStatus = {
      phase: 'settled',
      outputTokens: tokens,
      decodeMs,
      source: this.sourceOf(),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      windowMs: this.windowMs,
      updatedAt: now,
    }
    // Terminal speed = tokens / decodeMs of pairable segments (counts and time share a source);
    // whole-entry-reconciled baseline segments and single-frame segments (span 0) enter neither numerator nor denominator -- no speed without pairable measurements.
    const rateable = this.rateableSegments()
    const rateTokens = rateable.reduce((acc, segment) => acc + segment.tokens, this.retired.rateTokens)
    const rateDecodeMs = rateable.reduce((acc, segment) => acc + this.spanOf(segment), this.retired.rateDecodeMs)
    if (rateTokens > 0 && rateDecodeMs > 0) {
      const tps = (rateTokens / rateDecodeMs) * 1000
      if (Number.isFinite(tps) && tps > 0) return { ...status, tps }
    }
    return status
  }

  /** Full reset after the chain ends (the next turn starts from zero; never accumulate across chains). */
  resetChain(): void {
    this.segments.length = 0
    this.active = undefined
    this.byTask.clear()
    this.seenEntryIds.clear()
    this.completedAttempts.clear()
    this.highestTaskId = 0
    Object.assign(this.retired, { tokens: 0, decodeMs: 0, rateTokens: 0, rateDecodeMs: 0, provider: false, estimate: false })
    this.window.reset()
    this.lastLiveTps = undefined
    this.firstContentAt = undefined
    this.ttftMs = undefined
    this.sawEmptyGeneration = false
    this.phase = 'decoding'
    this.segmentSeq = 0
  }
}
