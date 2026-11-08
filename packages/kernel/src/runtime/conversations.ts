/**
 * ConversationTracker：pi-durable 会话的 helm 视图层。
 *
 * 核心机制：observeConversation 同步观察者（advance 内禁止 await，只做记录），
 * 在快照推进时同步维护内存镜像与排队副作用（SSE 推送在微任务中发出）。
 *
 * turn_settled 精确捕获：
 * - 输入登记 registerInput（负临时键）-> bindSubmission 回填 submissionId；
 *   观察路径（entry / pi.inbox 重建）以 `req:<requestId>` 键落位并按
 *   input.id 幂等合并为唯一记录；entry 重建仅认当前 run 区间（run.first
 *   及之后）与当前 inbox，已结算 run 的历史 helm.input 不复活；重启恢复
 *   活跃 run 时经 live.run.inputs 权威清单 + submission 精确查询补齐元数据；
 * - 每个 run（taskId）多 tool round 累计消费输入（新 taskId 才重置）；
 * - run 消失（完成/失败）精确结算一次（settledRuns 防双报；失败取
 *   runFailure.inputs 精确清单）；
 * - abort 由 runtime.abortConversation 显式结算（观察路径不重复报 aborted）；
 * - run 观察到 failure 后又显式 abort：仅补 aborted（不重复 failed）；
 * - run 活跃期间（启动 / doing 语义变化）推送实时摘要（emitRunSummary，
 *   语义指纹去重、不逐 token；终态仍由 emitSettled 恰一次负责）。
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
  run?: { taskId: number; inputs: number[]; turns?: number; first?: number }
  generation?: { message?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
}

export interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): Promise<void> | void
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

/** helm.input entry / inbox item 的元数据载荷形状。 */
interface HelmInputMeta {
  id?: string
  text?: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: unknown
}

/** pi.inbox 文档的结构子集（queued 提交：submissionId -> entry 载荷）。 */
interface InboxItemShape {
  id: number
  mode: 'steer' | 'followUp' | 'write'
  entry?: { kind?: string; data?: unknown }
}

interface TrackedInput {
  input: ConversationInput
  submissionId: number | string
}

/** live 节流窗口（毫秒）：50-100ms 区间取 75ms，兼顾 SSE 帧率与提交压力。 */
const LIVE_THROTTLE_MS = 75

/** 单会话 settledRuns 保留上限（防 7×24 长跑无界增长；runId 单调，淘汰永不复现）。 */
const SETTLED_RUNS_PER_CONVERSATION = 64

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmStore
  private readonly events: TrackerEvents
  /** SDK 观察者返回的 detach 集合。 */
  private readonly detach = new Map<number, () => void>()
  /** 会话 -> 当前 live 镜像（最近一次 advance 值）。 */
  private readonly liveViews = new Map<number, LiveStateShape>()
  /** 会话 -> 当前 pi.inbox 排队项镜像（queuedInputs 派生与实时推送用）。 */
  private readonly inboxViews = new Map<number, ReadonlyArray<InboxItemShape>>()
  /** submissionId -> TrackedInput（submit 登记 + entry 观察重建双通道）。
   *
   * 键域（无碰撞区分）：
   * - number（正）：SDK 真实 submissionId（bindSubmission 回填）；
   * - number（负）：submit 前的临时登记键（bindSubmission/dropInput 迁移或删除）；
   * - string `req:<requestId>`：helm.input entry / inbox 观察重建（观察路径拿
   *   不到 submissionId，直接以 requestId 字符串落位，bindSubmission 时合并）。 */
  private readonly trackedInputs = new Map<number, Map<number | string, TrackedInput>>()
  /** 会话 -> 输入重建下界 entry id（单调不回退：新 run 取 run.first 向上推，
   * run 结束不清除——窗口内已结算的 helm.input 不再被下一快照复活）。 */
  private readonly runFirstEntries = new Map<number, number>()
  /** 本回合已消费 submissionId 集（run 存续期间累计，新 taskId 重置）。 */
  private readonly consumedInputs = new Map<number, Set<number | string>>()
  /** 当前 run 的 taskId（多 tool round 不变；变化才重置消费集）。 */
  private readonly runTaskIds = new Map<number, number>()
  /** 已结算的 run（防 done+failure+abort 双报）。 */
  private readonly settledRuns = new Set<string>()
  /** 会话 -> 已结算 runKey 插入序（容量淘汰用，与 settledRuns 同步维护）。 */
  private readonly settledRunOrder = new Map<number, string[]>()
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
  /** 会话 -> 上次已发 queuedInputs 指纹（入队/出队 0ms 冲刷判定）。 */
  private readonly lastQueuedLiveKeys = new Map<number, string>()
  /** 会话 -> 最近一次真实活动时间（仅活动内容变更时刷新，非每次快照刷新）。 */
  private readonly lastActivityAt = new Map<number, number>()
  /** 会话 -> 最近一次活动内容指纹（重复快照不刷新时间）。 */
  private readonly lastActivityKey = new Map<number, string>()
  /** 会话 -> 连续失败回合数（completed 归零）。 */
  private readonly consecutiveErrors = new Map<number, number>()
  /** 会话 -> 最近一次已推送摘要的语义指纹（status|doing|pendingAsk；相同不重发）。 */
  private readonly lastSummaryKey = new Map<number, string>()

  constructor(options: { harness: Harness; store: HelmStore; events: TrackerEvents }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
  }

  /** 每次观察独立令牌；停观即删除，迟到异步结果不得复活状态。 */
  private readonly observeGenerations = new Map<number, symbol>()

  /** 挂接指定会话的同步观察者；活跃 run 恢复时先补权威输入元数据再返回。 */
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
    // 代数守护：await 后若已 stopObserving（或重观察换代），不向 maps 回写。
    const generation = Symbol('conversation observation')
    this.observeGenerations.set(id, generation)
    await this.adoptInitial(id, observation.value, generation)
  }

  /** 首次 attach：只登记水位线与内部镜像，不发 entry/live 事件。
   *
   * 活跃 run 恢复（重启/重挂观察者）时，本 run 的 helm.input entry 可能已滑出
   * 观察窗口（长 run 多条目），同步重建会丢输入元数据。此处按 SDK 权威映射补齐：
   * live.run.inputs 是本 run 已放置 submissionId 的精确序列，逐个经
   * harness.submission() 取其 entry id，再精确查询（minEntryId=maxEntryId）
   * helm.input entry 补 origin/meta/attachments；queued 项经 pi.inbox 补。
   * 绝不以扩大观察窗口或概率排序代替权威映射。 */
  private async adoptInitial(
    id: number,
    view: ConversationView,
    generation: symbol,
  ): Promise<void> {
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    this.liveViews.set(id, live ?? {})
    let watermark = this.lastEmittedEntry.get(id) ?? 0
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (Number.isFinite(numeric) && numeric > watermark) watermark = numeric
    }
    this.lastEmittedEntry.set(id, watermark)
    // inbox 镜像登记先于 run 判定：重启/停 run 但 inbox 仍有排队输入时，
    // queuedInputs 派生与 listLiveViews 快照不丢排队事实（不在 web 伪造队列）。
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    this.inboxViews.set(id, inboxItems)
    this.adoptInputsFromInbox(id, inboxItems)
    if (!live?.run) return
    this.runTaskIds.set(id, live.run.taskId)
    this.consumedInputs.set(id, new Set<number | string>())
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    if (first !== undefined) this.runFirstEntries.set(id, first)
    // 本 run 已放置输入：SDK 权威 submissionId -> entry 精确回读，并直接以
    // submissionId 数字键落位（与正常 register/bind 同键域，markConsumed 可命中）。
    const loaded = await this.loadRunInputEntries(id, live.run.inputs as number[])
    // 停观换代：异步回读结果作废，绝不向已清理的 maps 复活条目。
    if (this.observeGenerations.get(id) !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.bindRestoredInputs(id, loaded.pairs)
    // queued（未放置）输入：inbox entry 载荷直读（上面已登记镜像，此处仅补输入元数据）。
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
    this.noteActivity(id, live)
    // 恢复的活跃 run 已体现在快照摘要（listConversations）：登记语义指纹即可，
    // 后续 advance 仅在真实变化时推送，不补发冗余 working 帧。
    if (this.store.getConv(id)) this.lastSummaryKey.set(id, summaryKeyOf(this.summaryOf(id)))
  }

  /** 回读结果：helm.input entry 列表 + (submissionId, requestId) 权威对。 */
  private async loadRunInputEntries(
    id: number,
    submissionIds: number[],
  ): Promise<{ entries: Array<Record<string, unknown>>; pairs: Array<{ submissionId: number; requestId: string }> }> {
    if (submissionIds.length === 0) return { entries: [], pairs: [] }
    const conversation = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) return { entries: [], pairs: [] }
    const out: Array<Record<string, unknown>> = []
    const pairs: Array<{ submissionId: number; requestId: string }> = []
    for (const submissionId of submissionIds) {
      const submission = await this.harness.submission(submissionId as never, BACKGROUND_CONTEXT)
      if (!submission) continue
      const record = (await submission.status(BACKGROUND_CONTEXT)) as {
        entry?: number
        requestId?: string
      }
      const entryId = record.entry
      if (entryId === undefined) continue
      const page = await conversation.entries(
        { minEntryId: entryId as never, maxEntryId: entryId as never, order: 'ascending' },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      )
      const raw = page.items[0] as Record<string, unknown> | undefined
      if (raw !== undefined) out.push(raw)
      if (record.requestId !== undefined) pairs.push({ submissionId, requestId: record.requestId })
    }
    return { entries: out, pairs }
  }

  /** 把恢复输入的 req: 键归一为真实 submissionId 键（markConsumed 可命中）。 */
  private bindRestoredInputs(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const map = this.trackedInputs.get(id)
    if (!map) return
    for (const { submissionId, requestId } of pairs) {
      const reqKey = `req:${requestId}`
      const tracked = map.get(reqKey)
      if (tracked === undefined) continue
      map.delete(reqKey)
      map.set(submissionId, tracked)
    }
  }

  /** inbox queued 项重建（未放置输入的 origin/meta/attachments 补齐）。 */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmInputMeta | undefined
      if (item.entry?.kind !== 'helm.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      this.upsertTrackedInput(id, data, `req:${data.id}`)
    }
  }

  stopObserving(id: number): void {
    this.detach.get(id)?.()
    this.detach.delete(id)
    this.liveViews.delete(id)
    this.inboxViews.delete(id)
    // 清 timer 且丢弃待发快照：删除/停观后绝不发出幽灵事件。
    this.clearLiveTimer(id)
    this.pendingLive.delete(id)
    this.lastLiveKey.delete(id)
    this.lastQueuedLiveKeys.delete(id)
    // 彻底清理该会话的全部内存镜像：settledRuns 前缀键、run 状态、
    // 输入登记/消费集、水位线与活动指纹、结算等待者（先 resolve 防永久挂起）。
    // 否则反复建删会话的进程（CLI/Web 管理面）会随时间无限累积残留条目。
    for (const runKey of this.settledRuns) {
      if (runKey.startsWith(`${id}:`)) this.settledRuns.delete(runKey)
    }
    this.settledRunOrder.delete(id)
    this.lastSettledRun.delete(id)
    this.runTaskIds.delete(id)
    this.runFirstEntries.delete(id)
    // 删除令牌同时废止异步结果，避免保留已删会话的代数墓碑。
    this.observeGenerations.delete(id)
    this.trackedInputs.delete(id)
    this.consumedInputs.delete(id)
    this.lastEmittedEntry.delete(id)
    this.lastActivityAt.delete(id)
    this.lastActivityKey.delete(id)
    this.consecutiveErrors.delete(id)
    this.lastSummaryKey.delete(id)
    this.lastAssistant.delete(id)
    this.settledInflight.delete(id)
    this.settledErrors.delete(id)
    const waiters = this.settledWaiters.get(id) ?? []
    this.settledWaiters.delete(id)
    for (const resolve of waiters) resolve()
    this.pendingAskCounts.delete(id)
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
    const map = this.trackedInputs.get(conversationId) ?? new Map<number | string, TrackedInput>()
    const key = nextInputKey()
    map.set(key, { input, submissionId: key })
    this.trackedInputs.set(conversationId, map)
    return key
  }

  /** submit 返回后绑定真实 submissionId（HelmError 时 dropInput 移除登记）。 */
  bindSubmission(conversationId: number, key: number, submissionId: number): void {
    const map = this.trackedInputs.get(conversationId)
    const tracked = map?.get(key)
    if (!map || !tracked) return
    map.delete(key)
    // requestId 按 conversation 去重：同 requestId 已有 entry 观察重建的 req: 记录
    // 时合并为唯一记录（以 submissionId 数字键落位，不再保留 req: 键）。否则新建。
    const reqKey = `req:${tracked.input.id}`
    const existing = map.get(reqKey)
    if (existing !== undefined) {
      map.delete(reqKey)
      map.set(submissionId, existing)
      return
    }
    map.set(submissionId, tracked)
  }

  dropInput(conversationId: number, key: number): void {
    this.trackedInputs.get(conversationId)?.delete(key)
  }

  /** 本回合（当前 run）输入清单（before_turn payload 用）：run.inputs 精确
   * 序列（steer 追加在内）+ 尚未放置的 queued 登记，按 input.id 去重唯一。 */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const run = this.liveViews.get(conversationId)?.run
    if (!run) return []
    const map = this.trackedInputs.get(conversationId)
    if (!map) return []
    const out: ConversationInput[] = []
    const seen = new Set<string>()
    const collect = (tracked: TrackedInput | undefined): void => {
      if (!tracked || seen.has(tracked.input.id)) return
      seen.add(tracked.input.id)
      out.push(tracked.input)
    }
    // run.inputs 是本 run 已放置 submissionId 的精确序列（含已消费项）。
    for (const submissionId of run.inputs) {
      collect(map.get(submissionId))
    }
    // queued（未放置）登记：负临时键项（busy 中 followUp 输入在册未放置）。
    for (const [key, tracked] of map) {
      if (typeof key === 'number' && key < 0) collect(tracked)
    }
    return out
  }

  /** 等待本会话全部在途 turn_settled 回调完成（waitForIdle 用，非全局 promise）。 */
  async waitTurnSettled(conversationId: number): Promise<void> {
    if (this.settledInflightCount(conversationId) > 0) {
      await new Promise<void>((resolve) => {
        const list = this.settledWaiters.get(conversationId) ?? []
        list.push(resolve)
        this.settledWaiters.set(conversationId, list)
      })
    }
    if (this.settledErrors.has(conversationId)) throw this.settledErrors.get(conversationId)
  }

  private settledInflight = new Map<number, number>()
  private settledErrors = new Map<number, unknown>()

  private settledInflightCount(conversationId: number): number {
    return this.settledInflight.get(conversationId) ?? 0
  }

  private beginSettled(conversationId: number): void {
    if (this.settledInflightCount(conversationId) === 0) this.settledErrors.delete(conversationId)
    this.settledInflight.set(conversationId, this.settledInflightCount(conversationId) + 1)
  }

  private endSettled(conversationId: number): void {
    if (!this.settledInflight.has(conversationId)) return
    const next = this.settledInflightCount(conversationId) - 1
    if (next > 0) this.settledInflight.set(conversationId, next)
    else this.settledInflight.delete(conversationId)
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

  /** SSE 快照用实时视图清单：仅活跃 run、流式 generation 或非空 queued 的会话。
   *
   * 从 liveViews/inboxViews 权威镜像同步派生（不依赖上次推送缓存）：
   * 重连首帧即恢复排队胶囊与流式文本；空闲会话不复活（无内容可显示）。 */
  listLiveViews(): ConversationLive[] {
    const out: ConversationLive[] = []
    for (const [id, live] of this.liveViews) {
      const inboxItems = this.inboxViews.get(id)
      const hasRun = live.run !== undefined
      const hasStream =
        live.generation !== undefined || (live.tools?.length ?? 0) > 0 || (live.nestedTools?.length ?? 0) > 0
      if (!hasRun && !hasStream && (inboxItems?.length ?? 0) === 0) continue
      const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
      // 空闲会话仅在派生出非空 queued 时保留（queue-only）；不复活 idle 空 live。
      if (!hasRun && !hasStream && (snapshot.queuedInputs?.length ?? 0) === 0) continue
      out.push(snapshot)
    }
    return out
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
      this.noteSettledRun(conversationId, `${conversationId}:${taskId}`)
    }
    const all = this.takeCurrentRunInputs(conversationId)
    this.resetRunState(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
  }

  /** 取当前 run 的全部输入（abort 结算）：已放置（run.inputs）+ 已消费集 +
   * 尚未放置的 queued 登记（负临时键），按 input.id 去重；绝不遍历历史 run
   * 的 req: 键（已结算输入不再复活，origin 与重复输入不被旧历史污染）。 */
  private takeCurrentRunInputs(conversationId: number): ConversationInput[] {
    const run = this.liveViews.get(conversationId)?.run
    const map = this.trackedInputs.get(conversationId)
    const out: ConversationInput[] = []
    if (!map) return out
    const seen = new Set<string>()
    const collect = (tracked: TrackedInput | undefined): void => {
      if (!tracked || seen.has(tracked.input.id)) return
      seen.add(tracked.input.id)
      out.push(tracked.input)
    }
    if (run !== undefined) {
      for (const submissionId of run.inputs) collect(map.get(submissionId))
    }
    for (const submissionId of this.consumedInputs.get(conversationId) ?? []) {
      collect(map.get(submissionId))
    }
    for (const [key, tracked] of map) {
      if (typeof key === 'number' && key < 0) collect(tracked)
    }
    this.trackedInputs.delete(conversationId)
    return out
  }

  private resetRunState(conversationId: number): void {
    this.consumedInputs.delete(conversationId)
    // runTaskIds 保留：显式 abort 路径需它对照 lastSettledRun 防重入；
    // 新 run 启动时（live.run.taskId 变化）自然覆盖。
  }

  /** 登记已结算 runKey，并按会话限制保留容量（最旧淘汰，防无界增长）。
   *
   * runId（taskId）全库单调递增：被淘汰的最旧键不可能再出现，新 run 开始时
   * 的 settledRuns.delete(runKey) 只作用于最近键（必在容量内），语义不变。 */
  private noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.settledRunOrder.get(conversationId) ?? []
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
    this.settledRunOrder.set(conversationId, order)
  }

  /** 从容量序中移除指定 runKey（新 run 开始时同步清 settledRuns 用）。 */
  private dropSettledRunFromOrder(conversationId: number, runKey: string): void {
    const order = this.settledRunOrder.get(conversationId)
    if (order === undefined) return
    const index = order.indexOf(runKey)
    if (index >= 0) order.splice(index, 1)
    if (order.length === 0) this.settledRunOrder.delete(conversationId)
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

    // helm.input entry 观察：仅认当前 run 区间（run.first 及之后）的新条目，
    // 历史 helm.input 不复活（已结算 run 的输入不再进入 trackedInputs）。
    const first = this.runFirstEntries.get(id)
    const candidates: Array<Record<string, unknown>> = []
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (first !== undefined && (!Number.isFinite(numeric) || numeric < first)) continue
      candidates.push(raw as unknown as Record<string, unknown>)
    }
    this.adoptInputsFromEntries(id, candidates)
    // inbox queued 项同样重建（busy 中 followUp/steer 输入未放置但需在册）。
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    this.inboxViews.set(id, inboxItems)
    this.adoptInputsFromInbox(id, inboxItems)

    // 新落库条目：按 id 序对每条恰发一次（提交顺序保持，SDK 同 commit 折叠时
    // 窗口仍是全序，逐条推进水位线）。
    this.emitNewEntries(id, view.entries as never as ReadonlyArray<EntryRecordLike>)

    // 先结算已结束的 prev run（含同快照折叠：run1 结束 + run2 开始同 commit）。
    if (prev?.run && (!live?.run || live.run.taskId !== prev.run.taskId)) {
      const prevRun = prev.run
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.noteSettledRun(id, runKey)
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
      // 输入重建下界单调推进到本快照尾部：已结算 run 的全部条目（含其
      // helm.input）成为历史，后续快照窗口再扫到也不复活。
      const tail = view.entries.length
        ? Number((view.entries[view.entries.length - 1] as EntryRecordLike).id)
        : undefined
      if (tail !== undefined && Number.isFinite(tail)) {
        const floor = this.runFirstEntries.get(id)
        if (floor === undefined || tail > floor) this.runFirstEntries.set(id, tail)
      }
    }

    if (live?.run) {
      const runKey = `${id}:${live.run.taskId}`
      if (this.runTaskIds.get(id) !== live.run.taskId) {
        // 新 run 开始：重置本回合消费集（同 run 多 tool round 不重置）。
        this.runTaskIds.set(id, live.run.taskId)
        this.consumedInputs.set(id, new Set<number | string>())
        this.settledRuns.delete(runKey)
        this.dropSettledRunFromOrder(id, runKey)
        const first = live.run.first !== undefined ? Number(live.run.first) : undefined
        if (first !== undefined) {
          const floor = this.runFirstEntries.get(id)
          if (floor === undefined || first > floor) this.runFirstEntries.set(id, first)
        }
      }
      for (const submissionId of live.run.inputs) {
        this.markConsumed(id, submissionId)
      }
      // 完成期（answered，inputs 清空）不动 consumedInputs——保留已消费记录。
    }

    // 实时视图：真实活动变更记录 + 节流推送（终态在 emitSettled 内强制冲刷）。
    this.noteActivity(id, live)
    this.emitLiveThrottled(id, live)
    // run 活跃期间的实时摘要：run 启动与 doing 语义变化（首字前即有 working）。
    this.emitRunSummary(id)
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

  /** 节流推送实时视图：窗口内只保留最新快照，同内容不重复发帧。
   *
   * queuedInputs 变化（入队/出队）绕过 75ms 节流立即冲刷：用户提交
   * steer / followUp 后时间线尾部胶囊尽快可见（受观察提交时序影响）。 */
  private emitLiveThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.events.onLiveChanged === undefined) return
    const inboxItems = this.inboxViews.get(id)
    const queuedEmpty =
      !live?.run &&
      !live?.generation &&
      (live?.tools?.length ?? 0) === 0 &&
      (live?.nestedTools?.length ?? 0) === 0 &&
      (inboxItems?.length ?? 0) === 0
    if (queuedEmpty) {
      // 空闲视图不推送（终态冲刷由 emitSettled 负责）；但「之前发过 queued、
      // 现在权威 inbox 已空」时不能短路丢弃清理帧（否则客户端胶囊残留）。
      if (this.lastQueuedLiveKeys.get(id) === undefined || this.lastQueuedLiveKeys.get(id) === '[]') return
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendLiveNow(id, cleanup)
      return
    }
    const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
    const key = this.liveKeyOf(snapshot)
    // 「上次已发 queued 指纹」统一语义：未登记视为空队列 '[]'（首次空队列
    // 不因此误入立即冲刷路径）；仅 queue 变化绕过 75ms 节流。
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    const prevQueuedKey = this.lastQueuedLiveKeys.get(id) ?? '[]'
    if (key === this.lastLiveKey.get(id) && queuedKey === prevQueuedKey) return
    if (queuedKey !== prevQueuedKey) {
      // 入队/出队实时性优先：清 timer 同步冲刷，不等 75ms 节流。
      this.clearLiveTimer(id)
      this.sendLiveNow(id, snapshot)
      return
    }
    this.pendingLive.set(id, snapshot)
    if (this.liveTimers.has(id)) return
    const timer = setTimeout(() => {
      this.liveTimers.delete(id)
      this.flushPendingLive(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    this.liveTimers.set(id, timer)
  }

  /** live 帧内容指纹：text/thinking/tools/queuedInputs（发送与去重两处共用同一公式）。 */
  private liveKeyOf(snapshot: ConversationLive): string {
    return JSON.stringify([snapshot.text, snapshot.thinking ?? '', snapshot.tools, snapshot.queuedInputs ?? []])
  }

  /** 同步发送一帧 live（终态冲刷 / queued 清理共用）：登记两处指纹。 */
  private sendLiveNow(id: number, snapshot: ConversationLive): void {
    this.clearLiveTimer(id)
    this.pendingLive.delete(id)
    this.lastLiveKey.set(id, this.liveKeyOf(snapshot))
    this.lastQueuedLiveKeys.set(id, JSON.stringify(snapshot.queuedInputs ?? []))
    this.events.onLiveChanged?.(snapshot)
  }

  /** 冲刷窗口内待发快照（timer 到期或 queuedInputs 变化立即冲刷）。 */
  private flushPendingLive(id: number): void {
    const snapshot = this.pendingLive.get(id)
    if (snapshot === undefined) return
    this.pendingLive.delete(id)
    this.lastLiveKey.set(id, this.liveKeyOf(snapshot))
    this.lastQueuedLiveKeys.set(id, JSON.stringify(snapshot.queuedInputs ?? []))
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
      this.inboxViews.get(conversationId),
    )
    const key = this.liveKeyOf(snapshot)
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    if (key === this.lastLiveKey.get(conversationId) && queuedKey === (this.lastQueuedLiveKeys.get(conversationId) ?? '[]')) return
    this.lastLiveKey.set(conversationId, key)
    this.lastQueuedLiveKeys.set(conversationId, queuedKey)
    this.events.onLiveChanged(snapshot)
  }

  /** 从 helm.input entry 数据登记输入（按 input.id 即 requestId 幂等合并唯一记录）。
   *
   * 正常路径 register/bind 已有权威记录：entry 观察仅回填元数据缺口（origin/
   * meta/attachments），不新建重复记录。观察者拿不到 submissionId 时以
   * `req:<requestId>` 字符串键落位（bindSubmission 后续合并为唯一记录）。 */
  private adoptInputsFromEntries(id: number, entries: ReadonlyArray<unknown>): void {
    for (const raw of entries) {
      const entry = raw as { kind?: string; data?: unknown }
      // 自定义 input entry：SDK pickInputEntry 把 {kind:'helm.input', data} 写入
      // entry.data，model 只携带 UserMessage（不在 model[0].data）。
      if (entry?.kind !== 'helm.input') continue
      const meta = entry.data as HelmInputMeta | undefined
      if (!meta || typeof meta.id !== 'string' || typeof meta.text !== 'string') continue
      this.upsertTrackedInput(id, meta, `req:${meta.id}`)
    }
  }

  /** 单条 helm.input 元数据登记/合并（按 input.id 幂等，唯一记录）。 */
  private upsertTrackedInput(id: number, meta: HelmInputMeta, reqKey: string): void {
    const map = this.trackedInputs.get(id) ?? new Map<number | string, TrackedInput>()
    const rebuilt = inputFromMeta(meta)
    // 同 requestId 可能已有三种在册形式：req: 键、submissionId 数字键、负临时键。
    // 均只补缺（内存中更完整的元数据优先），不新建重复记录。
    let target: TrackedInput | undefined = map.get(reqKey)
    if (target === undefined) {
      for (const tracked of map.values()) {
        if (tracked.input.id === meta.id) {
          target = tracked
          break
        }
      }
    }
    if (target !== undefined) {
      target.input = mergeInputMeta(target.input, rebuilt)
      this.trackedInputs.set(id, map)
      return
    }
    map.set(reqKey, { input: rebuilt, submissionId: reqKey })
    this.trackedInputs.set(id, map)
  }

  private markConsumed(conversationId: number, submissionId: number | string): void {
    const map = this.trackedInputs.get(conversationId)
    const tracked = map?.get(submissionId)
    if (!map || !tracked) return
    const consumedSet = this.consumedInputs.get(conversationId) ?? new Set<number | string>()
    if (consumedSet.has(submissionId)) return
    consumedSet.add(submissionId)
    this.consumedInputs.set(conversationId, consumedSet)
    this.events.onInputCommitted(conversationId, tracked.input)
  }

  /** 结算取本 run 已消费输入并清理登记：按 input.id 去重唯一，全部键位
   * （submissionId / req: 重建键）一并清除，历史不复活。 */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const consumedSet = this.consumedInputs.get(conversationId)
    const map = this.trackedInputs.get(conversationId)
    const out: ConversationInput[] = []
    if (consumedSet && map) {
      const seen = new Set<string>()
      for (const submissionId of consumedSet) {
        const tracked = map.get(submissionId)
        if (!tracked || seen.has(tracked.input.id)) continue
        seen.add(tracked.input.id)
        out.push(tracked.input)
      }
      // 已结算输入的全部键位一并清除（含同 input.id 的 req: 重建键）。
      for (const input of out) {
        for (const [key, value] of map) {
          if (value.input.id === input.id) map.delete(key)
        }
      }
    }
    this.consumedInputs.delete(conversationId)
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const generation = this.observeGenerations.get(conversationId)
    this.beginSettled(conversationId)
    let completion: Promise<void> | void
    try {
      // 实时视图终态冲刷：先于 turn_settled 发出（空 tools/文本表示流结束）。
      this.flushLiveFinal(conversationId)
      // 连续失败计数：failed 递增，completed 归零，aborted 保持（非模型失败）。
      if (outcome === 'failed') {
        this.consecutiveErrors.set(conversationId, (this.consecutiveErrors.get(conversationId) ?? 0) + 1)
      } else if (outcome === 'completed') {
        this.consecutiveErrors.set(conversationId, 0)
      }
      // 先推进持久水位，再构造结算快照；插件与读取接口观察同一终态。
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
        const settledSummary = summaryOf(updated, unread ? 'done' : statusNow(updated, outcome), 0)
        // 终态摘要登记语义指纹：后续空闲快照不重复推送同一终态。
        this.lastSummaryKey.set(conversationId, summaryKeyOf(settledSummary))
        this.events.onSummaryChanged(settledSummary)
      }
      const payload: TurnSettledPayload = {
        conversation: this.summaryOf(conversationId, outcome),
        inputs,
        outcome,
        error,
        settledAt: Date.now(),
      }
      completion = this.events.onTurnSettled(payload, inputs)
    } catch (error) {
      this.endSettled(conversationId)
      throw error
    }
    if (completion === undefined) {
      this.endSettled(conversationId)
    } else {
      void completion.then(
        () => {
          if (this.observeGenerations.get(conversationId) === generation) this.endSettled(conversationId)
        },
        (error: unknown) => {
          if (this.observeGenerations.get(conversationId) !== generation) return
          this.settledErrors.set(conversationId, error)
          this.endSettled(conversationId)
        },
      )
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
    const summary = this.summaryOf(conversationId, count)
    this.lastSummaryKey.set(conversationId, summaryKeyOf(summary))
    this.events.onSummaryChanged(summary)
  }

  /** run 活跃期间的实时摘要推送：run 启动与 doing 语义变化时各恰一次。
   *
   * - 仅当本快照存在活跃 run 才推送（只可能出现 working/blocked 二态）；
   *   终态一律由 emitSettled 负责：adopt 不重复结算、不复活已结算回合；
   * - 以（status, doing, pendingAskCount）语义指纹去重：纯流式 token 推进
   *   （doing 不变）不推送，不逐 token 发摘要；
   * - stateChangeSeq 随真实状态变化单调推进（协议契约），与 setPendingAskCount
   *   同一机制；live 节流窗口（75ms）不受影响。
   */
  private emitRunSummary(id: number): void {
    if (!this.liveViews.get(id)?.run) return
    const meta = this.store.getConv(id)
    if (!meta) return
    if (this.lastSummaryKey.get(id) === summaryKeyOf(this.summaryOf(id))) return
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.summaryOf(id)
    this.lastSummaryKey.set(id, summaryKeyOf(summary))
    this.events.onSummaryChanged(summary)
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

/** 摘要语义指纹：status/doing/pendingAskCount（其余字段不参与推送去重）。 */
function summaryKeyOf(summary: ConversationSummary): string {
  return `${summary.status}|${summary.doing ?? ''}|${summary.pendingAskCount}`
}

// 输入登记的临时 key 使用负数，避免与 submissionId 冲突。
let inputKeySeq = -1
function nextInputKey(): number {
  inputKeySeq -= 1
  return inputKeySeq
}

/** 从 helm.input entry / inbox 载荷重建 ConversationInput（缺省字段不伪造）。 */
function inputFromMeta(meta: HelmInputMeta): ConversationInput {
  return {
    id: meta.id!,
    text: meta.text!,
    origin: meta.origin ?? 'human',
    ...(typeof meta.whenBusy === 'string' ? { whenBusy: meta.whenBusy } : {}),
    createdAt: meta.createdAt ?? Date.now(),
    // meta 从 entry.data 重建贯通回 turn_settled payload（边界已校验
    // 为普通对象；非对象形状不伪造，直接丢弃该字段）。
    ...(isPlainRecord(meta.meta) ? { meta: meta.meta } : {}),
    ...(Array.isArray(meta.attachments)
      ? { attachments: meta.attachments as ConversationInput['attachments'] }
      : {}),
  }
}

/** 合并两份同 input.id 的元数据：重建值优先，内存中更完整的字段不丢失。 */
function mergeInputMeta(existing: ConversationInput, rebuilt: ConversationInput): ConversationInput {
  return {
    ...rebuilt,
    ...(existing.meta !== undefined && rebuilt.meta === undefined ? { meta: existing.meta } : {}),
    ...(existing.attachments !== undefined && rebuilt.attachments === undefined
      ? { attachments: existing.attachments }
      : {}),
    ...(existing.whenBusy !== undefined && rebuilt.whenBusy === undefined
      ? { whenBusy: existing.whenBusy }
      : {}),
  }
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

/** 流式 generation.message 的可见文本+思考长度（活动指纹用；非对象形状返回 -1 区分）。 */
function streamedLengthOf(generation: LiveStateShape['generation']): number {
  if (generation === null || typeof generation !== 'object') return -1
  const message = (generation as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return -1
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return -1
  let length = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      length += b.text.length
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      length += b.thinking.length
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
