/**
 * ConversationTracker：pi-durable 会话的 helm 视图层。
 *
 * 核心机制：observeConversation 同步观察者（advance 内禁止 await，只做记录），
 * 在快照推进时同步维护内存镜像与排队副作用（SSE 推送在微任务中发出）。
 *
 * turn_settled 精确捕获：
 * - 输入登记走 submit 前的临时 key -> bindSubmission 回填 submissionId；消费
 *   映射不依赖临时内存——从 view.entries 的 helm.input entry（含 submission
 *   元数据）与 pi.live.run.inputs 重建（重启/竞态均不丢）；
 * - 每个 run（taskId）多 tool round 累计消费输入（新 taskId 才重置）；
 * - run 消失（完成/失败）精确结算一次（settledRuns 防双报；失败取
 *   runFailure.inputs 精确清单）；
 * - abort 由 runtime.abortConversation 显式结算（观察路径不重复报 aborted）；
 * - run 观察到 failure 后又显式 abort：仅补 aborted（不重复 failed）。
 */

import type {
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationStatus,
  ConversationSummary,
  InputOrigin,
  TurnOutcome,
  TurnSettledPayload,
  WhenBusy,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { ConvMeta, HelmStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'

/** SDK pi.live 文档的结构子集（tracker 观察形状）。 */
export interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number }
  generation?: { message?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
}

export interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
  /** 新时间线条目落库（仅新条目，每 id 恰一次；初始 observe 历史不重发）。 */
  onEntryCommitted?(conversationId: number, entry: ConversationEntry): void
  /** 会话实时增量（流式文本累计快照 + 工具卡；节流推送，终态冲刷最终状态）。 */
  onLiveChanged?(live: ConversationLive): void
}

interface TrackedInput {
  input: ConversationInput
  submissionId: number
  /** 已进入某 run 的消费清单（FTS/上报用）。 */
  consumed: boolean
}

/** live 节流窗口（毫秒）：50-100ms 区间取 75ms，兼顾 SSE 帧率与提交压力。 */
const LIVE_THROTTLE_MS = 75

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmStore
  private readonly events: TrackerEvents
  /** SDK 观察者返回的 detach 集合。 */
  private readonly detach = new Map<number, () => void>()
  /** 会话 -> 当前 live 镜像（最近一次 advance 值）。 */
  private readonly liveViews = new Map<number, LiveStateShape>()
  /** submissionId -> TrackedInput（submit 登记 + entry 观察重建双通道）。 */
  private readonly trackedInputs = new Map<number, Map<number, TrackedInput>>()
  /** 本回合已消费 submissionId 集（run 存续期间累计，新 taskId 重置）。 */
  private readonly consumedInputs = new Map<number, Set<number>>()
  /** 当前 run 的 taskId（多 tool round 不变；变化才重置消费集）。 */
  private readonly runTaskIds = new Map<number, number>()
  /** 已结算的 run（防 done+failure+abort 双报）。 */
  private readonly settledRuns = new Set<string>()
  /** 会话 -> 最近一个已结算 run 的 taskId（显式 abort 防重入）。 */
  private readonly lastSettledRun = new Map<number, number>()
  /** 会话 -> 在途 turn_settled 回调链（waitForIdle 等待本会话而非全局）。 */
  private readonly settledWaiters = new Map<number, Array<() => void>>()
  /** 会话 -> 已发过 conversation.entry 的最大 entry id（观察窗口内单调）。 */
  private readonly lastEmittedEntry = new Map<number, number>()
  /** 会话 -> 待发 live 快照（节流窗口内的最新值；终态时强制冲刷）。 */
  private readonly pendingLive = new Map<number, ConversationLive>()
  /** 会话 -> 节流冲刷 timer（stopObserving/close 必须清理，防删除后幽灵事件）。 */
  private readonly liveTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** 会话 -> 上次 live 内容指纹（相同快照不重复发帧）。 */
  private readonly lastLiveKey = new Map<number, string>()
  /** 会话 -> 最近一次真实活动时间（仅活动内容变更时刷新，非每次快照刷新）。 */
  private readonly lastActivityAt = new Map<number, number>()
  /** 会话 -> 最近一次活动内容指纹（重复快照不刷新时间）。 */
  private readonly lastActivityKey = new Map<number, string>()
  /** 会话 -> 连续失败回合数（completed 归零）。 */
  private readonly consecutiveErrors = new Map<number, number>()

  constructor(options: { harness: Harness; store: HelmStore; events: TrackerEvents }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
  }

  /** 挂接指定会话的同步观察者。 */
  async observe(id: number): Promise<void> {
    if (this.detach.has(id)) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        this.detach.delete(id)
        this.clearLiveTimer(id)
      },
    }
    const observation: Observation<ConversationView> = await this.harness.observeConversation(
      id as never,
      observer,
      BACKGROUND_CONTEXT,
    )
    this.detach.set(id, () => observation.detach())
    // 初始快照：窗口内已有条目不重发（首次 attach 只对齐水位线）。
    this.adoptInitial(id, observation.value)
  }

  /** 首次 attach：只登记水位线与内部镜像，不发 entry/live 事件。 */
  private adoptInitial(id: number, view: ConversationView): void {
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    this.liveViews.set(id, live ?? {})
    let watermark = this.lastEmittedEntry.get(id) ?? 0
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (Number.isFinite(numeric) && numeric > watermark) watermark = numeric
    }
    this.lastEmittedEntry.set(id, watermark)
    this.rebuildFromEntries(id, view.entries as never)
    if (live?.run) {
      this.runTaskIds.set(id, live.run.taskId)
      this.consumedInputs.set(id, new Set())
      for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
      this.noteActivity(id, live)
    }
  }

  stopObserving(id: number): void {
    this.detach.get(id)?.()
    this.detach.delete(id)
    this.liveViews.delete(id)
    // 清 timer 且丢弃待发快照：删除/停观后绝不发出幽灵事件。
    this.clearLiveTimer(id)
    this.pendingLive.delete(id)
    this.lastLiveKey.delete(id)
  }

  /** 清理 live 节流 timer（幂等）。 */
  private clearLiveTimer(id: number): void {
    const timer = this.liveTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.liveTimers.delete(id)
    }
  }

  /** 提交前登记 input 元数据（submit 返回后 bindSubmission 回填真实 submissionId）。 */
  registerInput(conversationId: number, input: ConversationInput): number {
    const map = this.trackedInputs.get(conversationId) ?? new Map()
    const key = nextInputKey()
    map.set(key, { input, submissionId: key, consumed: false })
    this.trackedInputs.set(conversationId, map)
    return key
  }

  /** submit 返回后绑定真实 submissionId（HelmError 时移除登记）。 */
  bindSubmission(conversationId: number, key: number, submissionId: number): void {
    const map = this.trackedInputs.get(conversationId)
    const tracked = map?.get(key)
    if (!map || !tracked) return
    map.delete(key)
    map.set(submissionId, tracked)
  }

  dropInput(conversationId: number, key: number): void {
    this.trackedInputs.get(conversationId)?.delete(key)
  }

  /** 本回合（当前 run）已消费输入清单（before_turn payload 用）。 */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const run = this.liveViews.get(conversationId)?.run
    if (!run) return []
    const consumed = this.consumedInputs.get(conversationId) ?? new Set<number>()
    const out: ConversationInput[] = []
    const map = this.trackedInputs.get(conversationId)
    for (const submissionId of run.inputs) {
      const tracked = map?.get(submissionId)
      if (tracked && !consumed.has(submissionId)) out.push(tracked.input)
    }
    for (const submissionId of consumed) {
      const tracked = map?.get(submissionId)
      if (tracked) out.push(tracked.input)
    }
    return out
  }

  /** 等待本会话全部在途 turn_settled 回调完成（waitForIdle 用，非全局 promise）。 */
  async waitTurnSettled(conversationId: number): Promise<void> {
    const inFlight = this.settledInflightCount(conversationId)
    if (inFlight === 0) return
    await new Promise<void>((resolve) => {
      const list = this.settledWaiters.get(conversationId) ?? []
      list.push(resolve)
      this.settledWaiters.set(conversationId, list)
    })
  }

  private settledInflight = new Map<number, number>()

  private settledInflightCount(conversationId: number): number {
    return this.settledInflight.get(conversationId) ?? 0
  }

  private beginSettled(conversationId: number): void {
    this.settledInflight.set(conversationId, this.settledInflightCount(conversationId) + 1)
  }

  private endSettled(conversationId: number): void {
    const next = this.settledInflightCount(conversationId) - 1
    this.settledInflight.set(conversationId, Math.max(0, next))
    if (next <= 0) {
      const waiters = this.settledWaiters.get(conversationId) ?? []
      this.settledWaiters.delete(conversationId)
      for (const resolve of waiters) resolve()
    }
  }

  /** 会话是否有在途工作（close abort 结算判定：空闲不伪造 aborted 结算）。 */
  hasLiveWork(conversationId: number): boolean {
    return this.liveViews.get(conversationId)?.run !== undefined
  }

  /** abort 结算（runtime.abortConversation 调用；与观察路径防双报）。 */
  settleAborted(conversationId: number): void {
    const taskId = this.runTaskIds.get(conversationId)
    if (taskId !== undefined && this.lastSettledRun.get(conversationId) === taskId) {
      // 观察路径已结算该 run（aborted/failed/completed）：不重复。
      this.resetRunState(conversationId)
      return
    }
    if (taskId !== undefined) {
      this.settledRuns.add(`${conversationId}:${taskId}`)
    }
    const all = this.takeAllInputs(conversationId)
    this.resetRunState(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
  }

  private takeAllInputs(conversationId: number): ConversationInput[] {
    const map = this.trackedInputs.get(conversationId)
    const out: ConversationInput[] = []
    if (map) {
      for (const tracked of map.values()) out.push(tracked.input)
    }
    this.trackedInputs.delete(conversationId)
    return out
  }

  private resetRunState(conversationId: number): void {
    this.consumedInputs.delete(conversationId)
    // runTaskIds 保留：显式 abort 路径需它对照 lastSettledRun 防重入；
    // 新 run 启动时（live.run.taskId 变化）自然覆盖。
  }

  private adopt(id: number, view: ConversationView): void {
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = this.liveViews.get(id)
    this.liveViews.set(id, live ?? {})

    // assistant 文本：窗口尾部最新 pi.assistant entry。
    for (let i = view.entries.length - 1; i >= 0; i -= 1) {
      const entry = view.entries[i] as
        | { kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }
        | undefined
      if (entry !== undefined && entry.kind === 'pi.assistant') {
        const text = assistantTextOf(entry)
        if (text !== '') {
          this.events.onAssistantText(id, entry.id, text)
          break
        }
      }
    }

    // helm.input entry 观察：从 entry 数据重建 trackedInputs（不依赖临时内存）。
    this.rebuildFromEntries(id, view.entries as never)

    // 新落库条目：按 id 序对每条恰发一次（提交顺序保持，SDK 同 commit 折叠时
    // 窗口仍是全序，逐条推进水位线）。
    this.emitNewEntries(id, view.entries as never as ReadonlyArray<EntryRecordLike>)

    // 先结算已结束的 prev run（含同快照折叠：run1 结束 + run2 开始同 commit）。
    if (prev?.run && (!live?.run || live.run.taskId !== prev.run.taskId)) {
      const prevRun = prev.run
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.settledRuns.add(runKey)
        this.lastSettledRun.set(id, prevRun.taskId)
        const failure = live?.runFailure
        if (failure && failure.taskId === prevRun.taskId) {
          for (const submissionId of failure.inputs) this.markConsumed(id, submissionId)
          const consumed = this.takeConsumed(id)
          if (failure.reason === 'aborted') {
            // abort 终态（观察路径）：一次 aborted 结算，不再走 failed。
            this.emitSettled(id, 'aborted', consumed, undefined)
          } else {
            this.emitSettled(
              id,
              'failed',
              consumed,
              `${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`,
            )
          }
        } else {
          const consumed = this.takeConsumed(id)
          this.emitSettled(id, 'completed', consumed, undefined)
        }
      }
      this.resetRunState(id)
    }

    if (live?.run) {
      const runKey = `${id}:${live.run.taskId}`
      if (this.runTaskIds.get(id) !== live.run.taskId) {
        // 新 run 开始：重置本回合消费集（同 run 多 tool round 不重置）。
        this.runTaskIds.set(id, live.run.taskId)
        this.consumedInputs.set(id, new Set())
        this.settledRuns.delete(runKey)
      }
      for (const submissionId of live.run.inputs) {
        this.markConsumed(id, submissionId)
      }
      // 完成期（answered，inputs 清空）不动 consumedInputs——保留已消费记录。
    }

    // 实时视图：真实活动变更记录 + 节流推送（终态在 emitSettled 内强制冲刷）。
    this.noteActivity(id, live)
    this.emitLiveThrottled(id, live)
  }

  /** 新落库条目：按 id 序推进水位线，每条恰发一次。 */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.events.onEntryCommitted
    if (sink === undefined) return
    let watermark = this.lastEmittedEntry.get(id) ?? 0
    let advanced = false
    for (const raw of entries) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= watermark) continue
      // 转换失败（非 JSON 载荷）显式抛出：SDK 会以 listener_error 结束观察，
      // 绝不静默丢弃或伪造降级（诚实性纪律）。
      sink(id, toConversationEntry(raw))
      watermark = numeric
      advanced = true
    }
    if (advanced) this.lastEmittedEntry.set(id, watermark)
  }

  /** 真实活动变更才刷新 lastActivityAt（重复快照不刷新，防 stall 误判）。 */
  private noteActivity(id: number, live: LiveStateShape | undefined): void {
    if (!live?.run) return
    const tools = live.tools ?? []
    const nested = live.nestedTools ?? []
    const fingerprint = [
      live.run.taskId,
      live.run.turns ?? 0,
      live.run.inputs.length,
      ...tools.map((t) => `${t.callId}:${t.status}`),
      ...nested.map((t) => `${t.callId}:${t.status}`),
      streamedLengthOf(live.generation),
    ].join('|')
    if (this.lastActivityKey.get(id) === fingerprint) return
    this.lastActivityKey.set(id, fingerprint)
    this.lastActivityAt.set(id, Date.now())
  }

  /** 节流推送实时视图：窗口内只保留最新快照，同内容不重复发帧。 */
  private emitLiveThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.events.onLiveChanged === undefined) return
    if (!live?.run && !live?.generation && (live?.tools?.length ?? 0) === 0 && (live?.nestedTools?.length ?? 0) === 0) {
      // 空闲视图不推送（终态冲刷由 emitSettled 负责）。
      return
    }
    const snapshot = deriveConversationLive(id, live, Date.now())
    const key = JSON.stringify([snapshot.text, snapshot.tools])
    if (key === this.lastLiveKey.get(id)) return
    this.pendingLive.set(id, snapshot)
    if (this.liveTimers.has(id)) return
    const timer = setTimeout(() => {
      this.liveTimers.delete(id)
      this.flushPendingLive(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    this.liveTimers.set(id, timer)
  }

  /** 冲刷窗口内待发快照（timer 到期）。 */
  private flushPendingLive(id: number): void {
    const snapshot = this.pendingLive.get(id)
    if (snapshot === undefined) return
    this.pendingLive.delete(id)
    this.lastLiveKey.set(id, JSON.stringify([snapshot.text, snapshot.tools]))
    this.events.onLiveChanged?.(snapshot)
  }

  /** 终态强制冲刷：以当前 live 镜像为准同步发帧（清 timer，丢弃过期窗口快照）。 */
  private flushLiveFinal(conversationId: number): void {
    this.clearLiveTimer(conversationId)
    this.pendingLive.delete(conversationId)
    if (this.events.onLiveChanged === undefined) return
    const snapshot = deriveConversationLive(
      conversationId,
      this.liveViews.get(conversationId),
      Date.now(),
    )
    const key = JSON.stringify([snapshot.text, snapshot.tools])
    if (key === this.lastLiveKey.get(conversationId)) return
    this.lastLiveKey.set(conversationId, key)
    this.events.onLiveChanged(snapshot)
  }

  /** 从 view.entries 的 helm.input 数据重建输入映射（含负 key 临时项合并）。 */
  private rebuildFromEntries(id: number, entries: ReadonlyArray<unknown>): void {
    const map = this.trackedInputs.get(id) ?? new Map()
    let changed = false
    for (const raw of entries) {
      const entry = raw as {
        kind?: string
        data?: unknown
      }
      // 自定义 input entry：SDK pickInputEntry 把 {kind:'helm.input', data} 写入
      // entry.data，model 只携带 UserMessage（不在 model[0].data）。
      if (entry?.kind !== 'helm.input') continue
      const meta = entry.data as
        | {
            id?: string
            text?: string
            origin?: InputOrigin
            whenBusy?: WhenBusy
            createdAt?: number
            meta?: Record<string, unknown>
          }
        | undefined
      if (!meta || typeof meta.id !== 'string' || typeof meta.text !== 'string') continue
      const submissionKey = submissionKeyOfEntry(meta.id)
      if (submissionKey === undefined) continue
      if (!map.has(submissionKey)) {
        map.set(submissionKey, {
          input: {
            id: meta.id,
            text: meta.text,
            origin: meta.origin ?? 'human',
            ...(meta.whenBusy !== undefined ? { whenBusy: meta.whenBusy } : {}),
            createdAt: meta.createdAt ?? Date.now(),
            // meta 从 entry.data 重建贯通回 turn_settled payload（边界已校验
            // 为普通对象；非对象形状不伪造，直接丢弃该字段）。
            ...(isPlainRecord(meta.meta) ? { meta: meta.meta } : {}),
          },
          submissionId: submissionKey,
          consumed: false,
        })
        changed = true
      }
    }
    if (changed) this.trackedInputs.set(id, map)
  }

  private markConsumed(conversationId: number, submissionId: number): void {
    const map = this.trackedInputs.get(conversationId)
    const tracked = map?.get(submissionId)
    if (!map || !tracked) return
    const consumedSet = this.consumedInputs.get(conversationId) ?? new Set<number>()
    if (consumedSet.has(submissionId)) return
    consumedSet.add(submissionId)
    this.consumedInputs.set(conversationId, consumedSet)
    this.events.onInputCommitted(conversationId, tracked.input)
  }

  private takeConsumed(conversationId: number): ConversationInput[] {
    const consumedSet = this.consumedInputs.get(conversationId)
    const map = this.trackedInputs.get(conversationId)
    const out: ConversationInput[] = []
    if (consumedSet && map) {
      for (const submissionId of consumedSet) {
        const tracked = map.get(submissionId)
        if (tracked) out.push(tracked.input)
      }
    }
    this.consumedInputs.delete(conversationId)
    // 已结算的输入从 tracked 清除（下一 run 重新观察）。
    if (map && consumedSet) {
      for (const submissionId of consumedSet) map.delete(submissionId)
    }
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    this.beginSettled(conversationId)
    try {
      // 实时视图终态冲刷：先于 turn_settled 发出（空 tools/文本表示流结束）。
      this.flushLiveFinal(conversationId)
      // 连续失败计数：failed 递增，completed 归零，aborted 保持（非模型失败）。
      if (outcome === 'failed') {
        this.consecutiveErrors.set(conversationId, (this.consecutiveErrors.get(conversationId) ?? 0) + 1)
      } else if (outcome === 'completed') {
        this.consecutiveErrors.set(conversationId, 0)
      }
      const summary = this.summaryOf(conversationId, outcome)
      const payload: TurnSettledPayload = {
        conversation: summary,
        inputs,
        outcome,
        error,
        settledAt: Date.now(),
      }
      // completionSeq 推进 + unread 置位（human 显式 patch 才清零）。
      const meta = this.store.getConv(conversationId)
      if (meta) {
        const unread = outcome === 'completed'
        const updated: ConvMeta = {
          ...meta,
          unread,
          completionSeq: meta.completionSeq + 1,
          stateChangeSeq: meta.stateChangeSeq + 1,
          updatedAt: Date.now(),
        }
        this.store.upsertConv(updated)
        this.events.onSummaryChanged(
          summaryOf(updated, unread ? 'done' : statusNow(updated, outcome), 0),
        )
      }
      this.events.onTurnSettled(payload, inputs)
    } finally {
      this.endSettled(conversationId)
    }
  }

  /** 由 store meta + live 镜像派生五态（blocked 优先于 working 派生冲突时）。 */  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.store.getConv(conversationId)
    if (!meta) throw new HelmError('not_found', `会话不存在：${conversationId}`, 404)
    const live = this.liveViews.get(conversationId)
    const pendingAsks =
      typeof pendingAskOverride === 'number'
        ? pendingAskOverride
        : (this.pendingAskCounts.get(conversationId) ?? 0)
    let status: ConversationStatus
    if (pendingAskOverride === 'aborted') {
      status = 'idle'
    } else if (pendingAsks > 0) {
      // 待答审批覆盖运行态，直接暴露当前的人类决策点。
      status = 'blocked'
    } else if (live?.run) {
      status = 'working'
    } else if (live?.runFailure && live.runFailure.reason !== 'aborted') {
      status = 'error'
    } else {
      status = meta.unread ? 'done' : 'idle'
    }
    const doing = live?.run
      ? live.tools && live.tools.length > 0
        ? `${live.tools[live.tools.length - 1]?.name}: ${live.tools[live.tools.length - 1]?.status ?? 'running'}`
        : 'thinking…'
      : undefined
    return summaryOf(meta, status, pendingAsks, doing)
  }

  private readonly pendingAskCounts = new Map<number, number>()

  setPendingAskCount(conversationId: number, count: number): void {
    const prev = this.pendingAskCounts.get(conversationId) ?? 0
    if (prev === count) return
    this.pendingAskCounts.set(conversationId, count)
    // seq 持久递增：pendingAsk 变化是状态变化（CAS 水位线依赖）。
    const meta = this.store.getConv(conversationId)
    if (meta) {
      const updated: ConvMeta = {
        ...meta,
        stateChangeSeq: meta.stateChangeSeq + 1,
        updatedAt: Date.now(),
      }
      this.store.upsertConv(updated)
    }
    this.events.onSummaryChanged(this.summaryOf(conversationId, count))
  }

  /** 观察到的最新 assistant 文本（getLastAssistantText 数据源）。 */
  private readonly lastAssistant = new Map<number, { entryId: number; text: string }>()
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const prev = this.lastAssistant.get(conversationId)
    if (prev !== undefined && prev.entryId === entryId) return
    this.lastAssistant.set(conversationId, { entryId, text })
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.lastAssistant.get(conversationId)?.text
  }

  /**
   * 看门狗探针事实：仅基于真实活动变更（noteActivity）与回合结算计数，
   * 不依赖每次快照刷新；无在途 run 时不报 stalled（空闲非停滞）。
   */
  getProbeFacts(conversationId: number): { stalledMs?: number; consecutiveErrors: number } {
    const consecutiveErrors = this.consecutiveErrors.get(conversationId) ?? 0
    if (!this.liveViews.get(conversationId)?.run) {
      return { consecutiveErrors }
    }
    const lastActivityAt = this.lastActivityAt.get(conversationId)
    if (lastActivityAt === undefined) return { consecutiveErrors }
    return { stalledMs: Date.now() - lastActivityAt, consecutiveErrors }
  }
}

function statusNow(meta: ConvMeta, outcome: TurnOutcome): ConversationStatus {
  if (outcome === 'failed') return 'error'
  if (outcome === 'aborted') return 'idle'
  return meta.unread ? 'done' : 'idle'
}

// 输入登记的临时 key 使用负数，避免与 submissionId 冲突。
let inputKeySeq = -1
function nextInputKey(): number {
  inputKeySeq -= 1
  return inputKeySeq
}

/**
 * helm.input entry data.id 即 submit 的 requestId；观察路径无法直接拿到
 * submissionId，这里以 requestId 哈希落位：同一输入在 map 中的 key 稳定，
 * bindSubmission 用真实 submissionId 再迁移。重启后凭 entry 重建同理。
 */
function submissionKeyOfEntry(requestId: string): number | undefined {
  let hash = 0
  for (let i = 0; i < requestId.length; i += 1) {
    hash = (hash * 31 + requestId.charCodeAt(i)) | 0
  }
  // 避免与负数临时 key 冲突：非负整数域。
  const key = Math.abs(hash)
  return key === 0 ? 1 : key
}

/** 提取 assistant entry 的文本块内容。 */
function assistantTextOf(entry: {
  model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }>
}): string {
  const blocks = entry.model?.[0]?.content
  if (!blocks) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** 流式 generation.message 的可见文本长度（活动指纹用；非对象形状返回 -1 区分）。 */
function streamedLengthOf(generation: LiveStateShape['generation']): number {
  if (generation === null || typeof generation !== 'object') return -1
  const message = (generation as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return -1
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return -1
  let length = 0
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      length += (block as { text: string }).text.length
    }
  }
  return length
}

/** 普通对象判定（null 与非对象不算；类实例不算）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export { deriveTitle }

/** 首输入标题：剥离代码块与换行，取前 36 个有效字符。 */
function deriveTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 36) || '新会话'
}
