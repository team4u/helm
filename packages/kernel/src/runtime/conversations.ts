/**
 * ConversationTracker：pi-durable 会话的 helm 视图层。
 *
 * 核心机制：observeConversation 同步观察者（advance 内禁止 await，只做记录），
 * 在快照推进时同步维护内存镜像与排队副作用（SSE 推送在微任务中发出）。
 *
 * turn_settled 精确捕获：
 * - 输入以持久 input.id（即 SDK requestId）为唯一追踪身份：registerInput
 *   提交前登记、bindSubmission 回填 submissionId→requestId 关联索引；
 *   观察路径（helm.input entry / pi.inbox 重建）直接按 requestId 落位并幂等
 *   合并唯一记录；entry 重建仅认当前 run 区间（run.first 及之后）与当前
 *   inbox，已结算 run 的历史 helm.input 不复活；重启恢复活跃 run 时经
 *   live.run.inputs 权威清单 + submission 精确查询补齐元数据与索引；
 * - 每个 run（taskId）多 tool round 累计消费输入（新 taskId 才重置）；
 * - run 消失（完成/失败）精确结算一次（settledRuns 防双报；失败取
 *   runFailure.inputs 精确清单）；
 * - abort 由 runtime.abortConversation 显式结算（观察路径不重复报 aborted）；
 * - run 观察到 failure 后又显式 abort：仅补 aborted（不重复 failed）；
 * - run 活跃期间（启动 / doing 语义变化）推送实时摘要（emitRunSummary，
 *   语义指纹去重、不逐 token；终态仍由 emitSettled 恰一次负责）。
 */

import type {
  ConversationContextUsage,
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
import { type ContextView, type Harness, type ConversationView, type Observation, type Observer } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConvMeta, HelmStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'
import { knownContextWindowOf } from './models.js'
import {
  assembleContextUsage,
  compactionFailureNoticeOf,
  compactingOf,
  contextUsageKeyOf,
  estimateContextUsage,
  type LiveCompactionFailureShape,
  type LiveCompactionShape,
} from './context-usage.js'

/** SDK pi.live 文档的结构子集（tracker 观察形状）。 */
export interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number; first?: number }
  generation?: { attempt?: unknown; message?: unknown; retry?: unknown; deferred?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
  /** 进行中的压缩任务（taskId 序；SDK CompactionStatus 的结构子集）。 */
  compactions?: LiveCompactionShape[]
  /** 最近一次压缩失败（SDK CompactionFailure 的结构子集）。 */
  compactionFailure?: LiveCompactionFailureShape
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
  /** 压缩失败等异步异常的一次性显式上报（EventHub notification 通道）。 */
  onNotification?(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string; conversationId: number }): void
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
  /** 会话 -> requestId（= input.id）-> 输入元数据（唯一追踪身份；提交登记
   * 与 entry/inbox 观察重建按 requestId 幂等合并为唯一记录）。 */
  private readonly trackedInputs = new Map<number, Map<string, ConversationInput>>()
  /** 会话 -> submissionId -> requestId：SDK 接口关联索引（live.run.inputs /
   * runFailure.inputs / withdraw 均以 submissionId 表达，经此映射回追踪身份）。
   *
   * 写入来源：bindSubmission（submit 返回）、adoptInputsFromInbox（inbox 项
   * id 即 submissionId）、重启恢复的 submission 精确查询；结算/撤回时清理。 */
  private readonly submissionIndex = new Map<number, Map<number, string>>()
  /** 会话 -> 输入重建下界 entry id（单调不回退：新 run 取 run.first 向上推，
   * run 结束不清除——窗口内已结算的 helm.input 不再被下一快照复活）。 */
  private readonly runFirstEntries = new Map<number, number>()
  /** 本回合已消费 requestId 集（run 存续期间累计，新 taskId 重置）。 */
  private readonly consumedInputs = new Map<number, Set<string>>()
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
  /** 会话 -> 最近一次已推送摘要的语义指纹（status|doing|pendingAsk；相同不重发）。 */
  private readonly lastSummaryKey = new Map<number, string>()
  // ---- 上下文用量（同步可读缓存 + 异步刷新；见 refreshContextUsageOnce） ----
  /** 会话 -> 当前缓存值（summaryOf 同步读取；undefined = 尚未计算）。 */
  private readonly contextUsageCache = new Map<number, ConversationContextUsage>()
  /** 会话 -> 最近一次已发布指纹（相同不重发 conversation.upsert）。 */
  private readonly contextUsageKeys = new Map<number, string>()
  /** 刷新在途的会话（防止重复刷新；新触发置 dirty 待重跑）。 */
  private readonly contextUsagePending = new Set<number>()
  /** 在途期间收到新触发信号的会话（完成后重跑一次）。 */
  private readonly contextUsageDirty = new Set<number>()
  /** 会话 -> 上下文触发已扫描到的最大 entry id（与 onEntryCommitted 无关，
   * 独立推进：无 sink 时也能正确去重；仅超过旧水位线的新标记条目才触发刷新）。 */
  private readonly contextUsageEntryWatermark = new Map<number, number>()
  /** 会话 -> 刷新链 settle 等待者（ensureContextUsage 唤醒用；stopObserving 兑底 resolve）。 */
  private readonly contextUsageWaiters = new Map<number, Array<() => void>>()
  /** 会话 -> 已发过压缩失败通知的 taskId（同一失败重复快照不重复通知；
   * 不随 stopObserving 清除——同 runtime 内重观察不得再报同一失败）。 */
  private readonly notifiedCompactionFailures = new Map<number, number>()

  constructor(options: {
    harness: Harness
    store: HelmStore
    events: TrackerEvents
    /** 错误摘要对外脱敏（与运行时 SecretStash 同源）；缺省恒等（仅测试环境）。 */
    redactError?: (text: string) => string
    /** 会话归属权现读（Runtime 注入 ownership.getOwnership）；缺省视为 human。
     * 仅用于回合结算 unread 策略：背景派生子会话不制造人类未读。 */
    ownershipOf?: (id: number) => 'helm' | 'bot' | 'human'
    /** 当前 Models 集合现读（contextUsage 的窗口解析用）；缺省不解析
     * （contextWindow 省略，绝不伪造）。 */
    models?: () => Models
  }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
    this.redactError = options.redactError ?? ((text) => text)
    this.ownershipOf = options.ownershipOf
    this.modelsOf = options.models
  }

  /** 错误诊断摘要脱敏（Runtime 注入 stashService.redact；防 provider 错误回显已登记秘密）。 */
  private readonly redactError: (text: string) => string

  /** 会话归属权现读（缺省恒 human）；仅回合结算 unread 策略消费。 */
  private readonly ownershipOf: ((id: number) => 'helm' | 'bot' | 'human') | undefined

  /** 当前 Models 集合现读（缺省不解析：窗口省略）。 */
  private readonly modelsOf: (() => Models) | undefined

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
    // 重启/重挂即看到的遗留失败同样不静默（每个 runtime 生命周期恰报一次）。
    this.noteCompactionFailure(id, live)
    let watermark = this.lastEmittedEntry.get(id) ?? 0
    // 上下文触发水位线与 entry 事件水位线同一初值对齐：初始快照内的历史标记
    // （pi.compaction 等）不触发后续 adopt 的重复刷新（初始刷新见下方调度）。
    let usageWatermark = this.contextUsageEntryWatermark.get(id) ?? 0
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (Number.isFinite(numeric) && numeric > watermark) watermark = numeric
      if (Number.isFinite(numeric) && numeric > usageWatermark) usageWatermark = numeric
    }
    this.lastEmittedEntry.set(id, watermark)
    this.contextUsageEntryWatermark.set(id, usageWatermark)
    // inbox 镜像登记先于 run 判定：重启/停 run 但 inbox 仍有排队输入时，
    // queuedInputs 派生与 listLiveViews 快照不丢排队事实（不在 web 伪造队列）。
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    this.inboxViews.set(id, inboxItems)
    this.adoptInputsFromInbox(id, inboxItems)
    // 首次挂接即填充上下文用量缓存（重启/分叉/新建会话的初始读路径）；
    // idle 会话同样需要（否则仅活跃 run 会话有初始值，历史会话打开后无胶囊）。
    this.scheduleContextUsageRefresh(id)
    if (!live?.run) return
    this.runTaskIds.set(id, live.run.taskId)
    this.consumedInputs.set(id, new Set<string>())
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    if (first !== undefined) this.runFirstEntries.set(id, first)
    // 本 run 已放置输入：SDK 权威 submissionId -> entry 精确回读，登记
    // requestId 追踪记录与 submissionId->requestId 索引（markConsumed 可命中）。
    const loaded = await this.loadRunInputEntries(id, live.run.inputs as number[])
    // 停观换代：异步回读结果作废，绝不向已清理的 maps 复活条目。
    if (this.observeGenerations.get(id) !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.indexRestoredSubmissions(id, loaded.pairs)
    // queued（未放置）输入：inbox entry 载荷直读（上面已登记镜像，此处仅补输入元数据）。
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
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

  /** 把恢复输入的权威 (submissionId, requestId) 对登记进关联索引。 */
  private indexRestoredSubmissions(
    id: number,
    pairs: ReadonlyArray<{ submissionId: number; requestId: string }>,
  ): void {
    if (pairs.length === 0) return
    const index = this.submissionIndex.get(id) ?? new Map<number, string>()
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
    this.submissionIndex.set(id, index)
  }

  /** inbox queued 项重建（未放置输入的 origin/meta/attachments 补齐 + 索引登记）。 */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmInputMeta | undefined
      if (item.entry?.kind !== 'helm.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // inbox 项 id 即 SDK submissionId：登记关联索引（出队放置后 markConsumed 可命中）。
      const index = this.submissionIndex.get(id) ?? new Map<number, string>()
      index.set(item.id, data.id)
      this.submissionIndex.set(id, index)
      this.upsertTrackedInput(id, data.id, data)
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
    this.submissionIndex.delete(id)
    this.consumedInputs.delete(id)
    this.lastEmittedEntry.delete(id)
    this.lastSummaryKey.delete(id)
    this.lastAssistant.delete(id)
    this.settledInflight.delete(id)
    this.settledErrors.delete(id)
    // 上下文用量镜像一并清理：停观/删除后的迟到刷新经代数守护丢弃，不复活；
    // 刷新链等待者先行 resolve（醒来后自查缓存/元数据并退出，不永久挂起）。
    this.contextUsageCache.delete(id)
    this.contextUsageKeys.delete(id)
    this.contextUsageDirty.delete(id)
    this.contextUsageEntryWatermark.delete(id)
    const usageWaiters = this.contextUsageWaiters.get(id) ?? []
    this.contextUsageWaiters.delete(id)
    for (const resolve of usageWaiters) resolve()
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

  /** 提交前登记 input 元数据（以持久 input.id 即 requestId 为追踪身份；
   * submit 返回后 bindSubmission 登记 submissionId 关联索引）。 */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.trackedInputs.get(conversationId) ?? new Map<string, ConversationInput>()
    // 同 requestId 可能已有 entry/inbox 观察重建的记录（如 rewind 事务提交
    // 先于登记）：只补缺（内存中更完整的元数据优先），不新建重复记录。
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
    this.trackedInputs.set(conversationId, map)
  }

  /** submit 返回后登记 submissionId→requestId 关联索引（SDK run.inputs 等
   * 均以 submissionId 表达，经索引映射回追踪身份；HelmError 时 dropInput
   * 移除登记）。 */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    const index = this.submissionIndex.get(conversationId) ?? new Map<number, string>()
    index.set(submissionId, requestId)
    this.submissionIndex.set(conversationId, index)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.trackedInputs.get(conversationId)?.delete(requestId)
  }

  /** 撤回排队提交：清理关联索引项及 requestId 追踪记录（withdraw 用）。 */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const index = this.submissionIndex.get(conversationId)
    const resolved = requestId ?? index?.get(submissionId)
    index?.delete(submissionId)
    if (resolved !== undefined) this.trackedInputs.get(conversationId)?.delete(resolved)
  }

  /** 本回合（当前 run）输入清单（before_turn payload 用）：run.inputs 精确
   * 序列（steer 追加在内）+ 尚未关联 submissionId 的登记（submit 在途），
   * 按 input.id 去重唯一。 */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const run = this.liveViews.get(conversationId)?.run
    if (!run) return []
    const map = this.trackedInputs.get(conversationId)
    const index = this.submissionIndex.get(conversationId)
    if (!map) return []
    const out: ConversationInput[] = []
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    // run.inputs 是本 run 已放置 submissionId 的精确序列（含已消费项），
    // 经关联索引映射回追踪身份。
    for (const submissionId of run.inputs) {
      const requestId = index?.get(submissionId)
      if (requestId !== undefined) collect(map.get(requestId))
    }
    // 尚未关联 submissionId 的登记：submit 在途（busy 中 followUp 输入在册未放置）。
    const bound = new Set(index?.values() ?? [])
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
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

  /** 取当前 run 的全部输入（abort 结算）：已放置（run.inputs 经索引）+ 已消费集 +
   * 尚未关联 submissionId 的登记，按 input.id 去重；绝不遍历历史 run 的
   * 追踪记录（已结算输入不再复活，origin 与重复输入不被旧历史污染）。 */
  private takeCurrentRunInputs(conversationId: number): ConversationInput[] {
    const run = this.liveViews.get(conversationId)?.run
    const map = this.trackedInputs.get(conversationId)
    const index = this.submissionIndex.get(conversationId)
    const out: ConversationInput[] = []
    if (!map) return out
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    if (run !== undefined) {
      for (const submissionId of run.inputs) {
        const requestId = index?.get(submissionId)
        if (requestId !== undefined) collect(map.get(requestId))
      }
    }
    for (const requestId of this.consumedInputs.get(conversationId) ?? []) {
      collect(map.get(requestId))
    }
    const bound = new Set(index?.values() ?? [])
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
    }
    this.trackedInputs.delete(conversationId)
    this.submissionIndex.delete(conversationId)
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

    // 压缩失败不得静默：新的 compactionFailure 恰发一次 error notification。
    this.noteCompactionFailure(id, live)

    // 上下文边界变化（压缩/重置/原地覆盖重发条目落地，或压缩实时状态变化）：
    // 调度异步刷新（同步去重；observe 回调内禁止 await）。
    this.noteContextBoundary(id, view, prev, live)

    // assistant 文本：窗口尾部最新 pi.assistant entry。
    // 遇 helm.rewind / pi.reset 立即停止回扫：原地覆盖重发刚写入截断标记（新
    // 回答尚未生成）时，标记之前的旧 pi.assistant 已被覆盖，绝不能再触发
    // onAssistantText 把旧回答重新写入 FTS5（防旧回答复燃）。
    for (let i = view.entries.length - 1; i >= 0; i -= 1) {
      const entry = view.entries[i] as
        | { kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }
        | undefined
      if (entry === undefined) continue
      if (entry.kind === 'helm.rewind' || entry.kind === 'pi.reset') break
      if (entry.kind === 'pi.assistant') {
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
        this.consumedInputs.set(id, new Set<string>())
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

    // 实时视图：节流推送（终态在 emitSettled 内强制冲刷）。
    this.emitLiveThrottled(id, live)
    // run 活跃期间的实时摘要：run 启动与 doing 语义变化（首字前即有 working）。
    this.emitRunSummary(id)
  }

  /** 上下文边界扫描：仅超过旧水位线的新条目中出现 pi.compaction /
   * pi.reset / helm.rewind，或 pi.live 压缩状态（compactions/compactionFailure）
   * 指纹变化时才触发刷新。历史标记条目不重复触发（否则流式期间每次快照都
   * 重调度，写放大）；水位线单调推进。独立水位线（与 onEntryCommitted 无关）：
   * 无 entry sink 的观察者同样去重。 */
  private noteContextBoundary(
    id: number,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): void {
    const old = this.contextUsageEntryWatermark.get(id) ?? 0
    let watermark = old
    let boundary = false
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= old) continue
      if (numeric > watermark) watermark = numeric
      const kind = (raw as { kind?: unknown }).kind
      if (kind === 'pi.compaction' || kind === 'pi.reset' || kind === 'helm.rewind') boundary = true
    }
    this.contextUsageEntryWatermark.set(id, watermark)
    // prev 恒为对象镜像（liveViews 存 ?? {}）；live 原始 doc 缺失时归一为空对象，
    // 避免「无 pi.live doc 的快照」首帧因 undefined vs {} 指纹差异误触发刷新。
    if (boundary || compactionLiveKeyOf(prev) !== compactionLiveKeyOf(live ?? {})) {
      this.scheduleContextUsageRefresh(id)
    }
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

  /** live 帧内容指纹：text/thinking/tools/generation/queuedInputs（发送与去重两处共用同一公式）。
   * generation 参与指纹：纯 tool-call 参数流式期间 text/thinking 恒空，
   * 不计 generation 则参数增长完全不发帧。 */
  private liveKeyOf(snapshot: ConversationLive): string {
    return JSON.stringify([
      snapshot.text,
      snapshot.thinking ?? '',
      snapshot.tools,
      snapshot.generation ?? null,
      snapshot.queuedInputs ?? [],
    ])
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
   * meta/attachments），不新建重复记录。 */
  private adoptInputsFromEntries(id: number, entries: ReadonlyArray<unknown>): void {
    for (const raw of entries) {
      const entry = raw as { kind?: string; data?: unknown }
      // 自定义 input entry：SDK pickInputEntry 把 {kind:'helm.input', data} 写入
      // entry.data，model 只携带 UserMessage（不在 model[0].data）。
      if (entry?.kind !== 'helm.input') continue
      const meta = entry.data as HelmInputMeta | undefined
      if (!meta || typeof meta.id !== 'string' || typeof meta.text !== 'string') continue
      this.upsertTrackedInput(id, meta.id, meta)
    }
  }

  /** 单条 helm.input 元数据登记/合并（按 input.id 幂等，唯一记录；调用方已
   * 校验 meta.id/text 为字符串）。 */
  private upsertTrackedInput(id: number, requestId: string, meta: HelmInputMeta): void {
    const map = this.trackedInputs.get(id) ?? new Map<string, ConversationInput>()
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    if (existing !== undefined) {
      map.set(requestId, mergeInputMeta(existing, rebuilt))
      this.trackedInputs.set(id, map)
      return
    }
    map.set(requestId, rebuilt)
    this.trackedInputs.set(id, map)
  }

  /** 标记 submissionId 已被当前 run 消费：经关联索引映射回 requestId 后
   * 恰一次登记（onInputCommitted 恰一次）。索引缺失（bind/回填尚未发生）时
   * 静默跳过，下一次快照重扫 run.inputs 时补记。 */
  private markConsumed(conversationId: number, submissionId: number): void {
    const map = this.trackedInputs.get(conversationId)
    const requestId = this.submissionIndex.get(conversationId)?.get(submissionId)
    const input = requestId === undefined ? undefined : map?.get(requestId)
    if (!map || !input) return
    const consumedSet = this.consumedInputs.get(conversationId) ?? new Set<string>()
    if (consumedSet.has(input.id)) return
    consumedSet.add(input.id)
    this.consumedInputs.set(conversationId, consumedSet)
    this.events.onInputCommitted(conversationId, input)
  }

  /** 结算取本 run 已消费输入并清理登记：requestId 集合每项恰一条记录，
   * 追踪记录与关联索引一并清除，历史不复活。 */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const consumedSet = this.consumedInputs.get(conversationId)
    const map = this.trackedInputs.get(conversationId)
    const index = this.submissionIndex.get(conversationId)
    const out: ConversationInput[] = []
    if (consumedSet && map) {
      for (const requestId of consumedSet) {
        const input = map.get(requestId)
        if (input !== undefined) out.push(input)
      }
      // 已结算输入的追踪记录与索引项一并清除。
      if (index !== undefined) {
        for (const [submissionId, requestId] of index) {
          if (consumedSet.has(requestId)) index.delete(submissionId)
        }
      }
      for (const requestId of consumedSet) map.delete(requestId)
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
      // 先推进持久水位，再构造结算快照；插件与读取接口观察同一终态。
      // completionSeq 推进 + unread 置位（human 显式 patch 才清零）。
      // 背景派生子会话（ownedBy 非 human 且有父链，如受管 subagent / SuperAgent
      // Worker）完成不制造人类未读；人类 fork（有父链但 human 归属）与顶层
      // 直连会话保持 unread 语义。失败/中止一律不置 unread（既有契约）。
      const meta = this.store.getConv(conversationId)
      if (meta) {
        const unread = outcome === 'completed' && !this.isBackgroundDerived(conversationId, meta)
        const updated: ConvMeta = {
          ...meta,
          unread,
          completionSeq: meta.completionSeq + 1,
          stateChangeSeq: meta.stateChangeSeq + 1,
          updatedAt: Date.now(),
        }
        this.store.upsertConv(updated)
        const settledStatus = unread ? 'done' : statusNow(updated, outcome)
        // 失败终态的诊断摘要与 summaryOf 同源：emitSettled 不经 tracker 派生路径，
        // 必须在此同样携带 lastError（否则首个 conversation.upsert 事件漏掉原因）；
        // contextUsage 同样从同步缓存附加（结算帧后的异步刷新再发新值帧）。
        const settledRaw = summaryOf(
          updated,
          settledStatus,
          0,
          undefined,
          settledStatus === 'error' ? lastErrorOf(this.liveViews.get(conversationId), this.redactError) : undefined,
        )
        const cachedUsage = this.contextUsageCache.get(conversationId)
        const settledSummary = cachedUsage === undefined ? settledRaw : { ...settledRaw, contextUsage: cachedUsage }
        // 终态摘要登记语义指纹：后续空闲快照不重复推送同一终态。
        this.lastSummaryKey.set(conversationId, summaryKeyOf(settledSummary))
        this.events.onSummaryChanged(settledSummary)
        // 回合结算后上下文已定：异步刷新用量（变化才补发 upsert；不推进 seq）。
        this.scheduleContextUsageRefresh(conversationId)
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

  /** 背景派生子会话判定：有父链且归属非 human（受管 subagent / Worker 等）。
   * 归属回调缺省或读取失败（含已删除）一律按 human 处理——宁多读不漏报，
   * 绝不因归属不明而吞掉人类未读通知。 */
  private isBackgroundDerived(conversationId: number, meta: ConvMeta): boolean {
    if (meta.parentConversationId === undefined) return false
    if (this.ownershipOf === undefined) return false
    try {
      return this.ownershipOf(conversationId) !== 'human'
    } catch {
      return false
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
    // 失败诊断摘要仅随 error 状态携带（新 run 启动后 live.runFailure 被清除，自然同步消失）。
    const lastError = status === 'error' ? lastErrorOf(live, this.redactError) : undefined
    const summary = summaryOf(meta, status, pendingAsks, doing, lastError)
    const usage = this.contextUsageOf(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
  }

  /** 同步读缓存；缺失时调度一次性后台刷新（去重：在途置 dirty、已缓存不重跑）。 */
  private contextUsageOf(conversationId: number): ConversationContextUsage | undefined {
    const cached = this.contextUsageCache.get(conversationId)
    if (cached !== undefined) return cached
    this.scheduleContextUsageRefresh(conversationId)
    return undefined
  }

  /** 调度异步上下文用量刷新（fire-and-forget；observe 回调内同步调用不可 await）。 */
  scheduleContextUsageRefresh(conversationId: number): void {
    if (!this.store.getConv(conversationId)) return
    if (this.contextUsagePending.has(conversationId)) {
      this.contextUsageDirty.add(conversationId)
      return
    }
    this.contextUsagePending.add(conversationId)
    void this.refreshContextUsageOnce(conversationId)
      .catch((error: unknown) => {
        // 刷新失败如实记录：缓存保持旧值（绝不静默伪造），不阻断观察主路径。
        console.error(`[helm] 会话 ${conversationId} 上下文用量刷新失败:`, error)
      })
      .finally(() => {
        this.contextUsagePending.delete(conversationId)
        // 在途期间又有真实变化（新回合结算/压缩/rewind）：重跑一次迫齐。
        if (this.contextUsageDirty.delete(conversationId)) {
          this.scheduleContextUsageRefresh(conversationId)
        }
        // 唤醒等待方（ensureContextUsage）：自行复查缓存/在途状态决定返回或续等。
        const waiters = this.contextUsageWaiters.get(conversationId)
        if (waiters !== undefined) {
          this.contextUsageWaiters.delete(conversationId)
          for (const resolve of waiters) resolve()
        }
      })
  }

  /** models.changed 后定向迫齐上下文用量缓存。
   *
   * 目录刷新/集合重建可能让同一模型的窗口从未知变已知（或反向、数值变化、
   * 供应商不再供应）：已观察/已缓存会话的旧用量必须追上，否则 idle 会话
   * 不发新输入就永远停留在旧窗口。只调度既有刷新链（在途置 dirty 迫齐、
   * 代数守护、指纹去重），不新增异步机制、不触发 LLM 请求；usage-only
   * 更新不推进 stateChangeSeq（applyContextUsage 的既有纪律）。
   *
   * - providers 非空：只刷新生效模型属于这些供应商的会话（事件定向）；
   * - providers 空：目录整体可能已换，全部追齐；
   * - 只看已观察（observeGenerations）或已有用量缓存（contextUsageCache）
   *   的会话：不扫全量历史会话（启动期/大目录下的昂贵 N 次扫描），未观察
   *   且未缓存的会话首次波取时自然按新目录计算。
   */
  onModelsChanged(providers: readonly string[]): void {
    const wanted = providers.length > 0 ? new Set(providers) : undefined
    const targets = new Set([...this.contextUsageCache.keys(), ...this.observeGenerations.keys()])
    for (const id of targets) {
      const meta = this.store.getConv(id)
      if (!meta || meta.model === '') continue
      const slash = meta.model.indexOf('/')
      const provider = slash > 0 ? meta.model.slice(0, slash) : meta.model
      if (wanted !== undefined && !wanted.has(provider)) continue
      this.scheduleContextUsageRefresh(id)
    }
  }

  /** 确保该会话 contextUsage 缓存已填充且刷新链归寂（首个详情读等同步可见路径）。
   *
   * - 已缓存且无在途刷新：立即返回（已缓存的分页读零开销，不重复刷新）；
   * - 缺失或在途：等待刷新链 settle（多调用方合并同一次刷新；dirty 重跑链
   *   同样等待到归寂，避免「缓存已设但链未完」时读到即将被迫齐的旧值）；
   * - 每轮等待都由真实「刷新链 settle」事件推进（无轮询无 sleep）；上限
   *   8 轮仅防御病态链（持续被代数守护丢弃且不断有新触发）。
   */
  async ensureContextUsage(conversationId: number): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      if (this.contextUsageCache.has(conversationId) && !this.contextUsagePending.has(conversationId)) {
        return
      }
      if (!this.store.getConv(conversationId)) return
      if (!this.contextUsagePending.has(conversationId)) {
        this.scheduleContextUsageRefresh(conversationId)
        // 调度被拒（会话恰好被删）：不再等待，如实返回。
        if (!this.contextUsagePending.has(conversationId)) return
      }
      await new Promise<void>((resolve) => {
        const list = this.contextUsageWaiters.get(conversationId) ?? []
        list.push(resolve)
        this.contextUsageWaiters.set(conversationId, list)
      })
    }
  }

  /** 压缩失败不得静默：新的 compactionFailure（按 taskId 去重，同一失败
   * 重复快照不重复通知）发一次脱敏 error notification。SDK 只在下一次成功
   * 压缩时清除 compactionFailure，成功后新失败是全新 taskId，自然再报。 */
  private noteCompactionFailure(id: number, live: LiveStateShape | undefined): void {
    const failure = live?.compactionFailure
    if (failure === undefined) return
    if (this.notifiedCompactionFailures.get(id) === failure.taskId) return
    this.notifiedCompactionFailures.set(id, failure.taskId)
    this.events.onNotification?.({
      level: 'error',
      title: '上下文精简失败',
      body: compactionFailureNoticeOf(failure, this.redactError),
      conversationId: id,
    })
  }

  /** 单次刷新：读真实 ContextView + 模型窗口 + live 压缩状态，变化才发布。 */
  private async refreshContextUsageOnce(conversationId: number): Promise<void> {
    const meta = this.store.getConv(conversationId)
    if (!meta) return
    // 代数守护：await 前捕获；未观察（undefined）同样参与比较——刷新期间并发
    // observe（换代）/stopObserving（删除令牌）都会改变当前值，迟到结果丢弃。
    const generation = this.observeGenerations.get(conversationId)
    const conversation = await this.harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
    if (!conversation) return
    const view = await conversation.context(BACKGROUND_CONTEXT)
    if (this.observeGenerations.get(conversationId) !== generation) return
    // 会话可能在 await 期间被删除：迟到结果不得复活缓存或发事件。
    if (!this.store.getConv(conversationId)) return
    this.applyContextUsage(conversationId, meta, view)
  }

  /** 应用刷新结果：组装 -> 指纹比对 -> 缓存 + 发布（不推进 stateChangeSeq）。 */
  private applyContextUsage(conversationId: number, meta: ConvMeta, view: ContextView): void {
    const live = this.liveViews.get(conversationId)
    const slash = meta.model.indexOf('/')
    const model =
      slash > 0 && slash < meta.model.length - 1 && this.modelsOf !== undefined
        ? this.modelsOf().getModel(meta.model.slice(0, slash), meta.model.slice(slash + 1))
        : undefined
    // 窗口来源诚实性：模型不在当前 Models 集合，或窗口是静态保守缺省
    // （compat 网关 / Magpie 目录缺上游窗口，helmContextWindowKnown === false）
    // 时不携带 contextWindow——绝不把 128k 缺省冒充真实窗口。
    const contextWindow = knownContextWindowOf(model)
    const compacting = compactingOf(live?.compactions)
    const usage = assembleContextUsage({
      estimate: estimateContextUsage(view),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(compacting !== undefined ? { compacting } : {}),
    })
    const key = contextUsageKeyOf(usage)
    const previous = this.contextUsageCache.get(conversationId)
    const previousKey = this.contextUsageKeys.get(conversationId)
    // 缓存先行更新：HTTP / SSE 快照读立即看到新值（事件是否另发见下）。
    this.contextUsageCache.set(conversationId, usage)
    this.contextUsageKeys.set(conversationId, key)
    // 首次填充默认静默：值经快照 / HTTP 读自然可见，不发事件（避免启动期每
    // 会话一帧噪声，维持「终态后无重复语义帧」的既有帧纪律）。唯一例外：
    // 填充时已携带压缩进行中状态（compacting，如启动期恢复进行中压缩、首次
    // 刷新落在手动压缩窗口内）必须发布——否则没有任何后续语义帧会携带它，
    // 订阅方将永远看不到该状态。
    if (previousKey === undefined) {
      if (usage.compacting !== undefined) {
        const summary = this.summaryOf(conversationId)
        this.events.onSummaryChanged(summary)
      }
      return
    }
    if (key === previousKey) return
    // run 活跃期间：仅压缩实时状态（compacting）与上下文窗口（contextWindow）
    // 变化才发帧；token 变化是瞬态，等本回合结算帧携带（emitSettled 附加
    // 缓存值），避免 working 期间重复 doing 语义帧（帧纪律：不逐 token 发
    // 摘要）。窗口变化是目录刷新/模型切换带来的语义事实，不是逐 token 噪声，
    // 不得静默到回合结束；同样不推进 stateChangeSeq。
    if (this.liveViews.get(conversationId)?.run !== undefined) {
      const compactionChanged = (previous?.compacting ?? null) !== (usage.compacting ?? null)
      const windowChanged = (previous?.contextWindow ?? null) !== (usage.contextWindow ?? null)
      if (!compactionChanged && !windowChanged) return
    }
    // 发布摘要（携带新 usage）：不推进 stateChangeSeq——水位线专属状态机/
    // doing/Ask 的 CAS 语义，派生展示数据不得污染（否则 pending Ask 会被伪
    // superseded、guarded 提交被伪 409）。摘要语义指纹不含 usage，无需重登记。
    const summary = this.summaryOf(conversationId)
    this.events.onSummaryChanged(summary)
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

  /** 失效落入 rewind 覆盖区间的 lastAssistant 缓存（原地覆盖重发后）。
   *
   * 仅当缓存指向的 entry 落在 [from, through] 内才清除：新回答失败时
   * getLastAssistantText 不得返回已被覆盖的旧答案，而区间外（更早回合）
   * 的缓存仍然有效。*/
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    const cached = this.lastAssistant.get(conversationId)
    if (cached === undefined) return
    if (cached.entryId >= from && cached.entryId <= through) {
      this.lastAssistant.delete(conversationId)
    }
  }
}

function statusNow(meta: ConvMeta, outcome: TurnOutcome): ConversationStatus {
  if (outcome === 'failed') return 'error'
  if (outcome === 'aborted') return 'idle'
  return meta.unread ? 'done' : 'idle'
}

/** 摘要语义指纹：status/doing/pendingAskCount/lastError（其余字段不参与推送去重）。 */
function summaryKeyOf(summary: ConversationSummary): string {
  return `${summary.status}|${summary.doing ?? ''}|${summary.pendingAskCount}|${summary.lastError ?? ''}`
}

/** pi.live 压缩状态指纹（仅内存比对用，不对外发布）：compactions 的
 * (taskId,trigger,blocking) 序列 + compactionFailure 的 (taskId,trigger,error)。 */
function compactionLiveKeyOf(live: LiveStateShape | undefined): string {
  if (live === undefined) return ''
  return JSON.stringify([
    (live.compactions ?? []).map((c) => [c.taskId, c.trigger, c.blocking === true]),
    live.compactionFailure !== undefined
      ? [live.compactionFailure.taskId, live.compactionFailure.trigger, live.compactionFailure.error]
      : null,
  ])
}

/** 从 live.runFailure 构造可读诊断摘要（'reason: detail'；aborted/reset 非失败不携带）。 */
function lastErrorOf(
  live: LiveStateShape | undefined,
  redact: (text: string) => string,
): string | undefined {
  const failure = live?.runFailure
  if (!failure || failure.reason === 'aborted' || failure.reason === 'reset') return undefined
  const detail =
    typeof failure.detail === 'string' && failure.detail.trim() !== ''
      ? `: ${redact(failure.detail).slice(0, 400)}`
      : ''
  return `${failure.reason}${detail}`
}

// 输入追踪身份即持久 input.id（requestId），无需临时键分配。

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
