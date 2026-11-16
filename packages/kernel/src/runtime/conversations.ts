/**
 * ConversationTracker：pi-durable 会话的 helm 视图层。
 *
 * 核心机制：observeConversation 同步观察者（advance 内禁止 await，只做记录），
 * 在快照推进时同步维护内存镜像与排队副作用（SSE 推送在微任务中发出）。
 *
 * 状态布局（见 conversation-mirror.ts / context-usage-refresh.ts）：
 * - 每会话运行态聚合为单个 ConversationMirror（mirrors），stopObserving 一次
 *   delete 整体回收；跨会话索引（settledRuns 去重集合）与停观后仍需保真的
 *   notifiedCompactionFailures 留在 tracker 顶层；
 * - contextUsage 缓存/刷新链独立成 ContextUsageRefresh（在途刷新可跨越停观）。
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
  ConversationEntry,
  ConversationInput,
  ConversationLive,
  ConversationStatus,
  ConversationSummary,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConvMeta, HelmStore } from './store.js'
import { summaryOf } from './store.js'
import { deriveConversationLive, toConversationEntry, type EntryRecordLike } from './entries.js'
import { compactionFailureNoticeOf } from './context-usage.js'
import { ContextUsageRefresh, type ContextUsageHost } from './context-usage-refresh.js'
import {
  type ConversationMirror,
  createConversationMirror,
  type HelmInputMeta,
  type InboxItemShape,
  inputFromMeta,
  type LiveStateShape,
  mergeInputMeta,
} from './conversation-mirror.js'

export type { LiveStateShape }

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

/** live 节流窗口（毫秒）：50-100ms 区间取 75ms，兼顾 SSE 帧率与提交压力。 */
const LIVE_THROTTLE_MS = 75

/** 单会话 settledRunOrder 保留上限（防 7×24 长跑无界增长；runId 单调，淘汰永不复现）。 */
const SETTLED_RUNS_PER_CONVERSATION = 64

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmStore
  private readonly events: TrackerEvents
  /** 会话 -> 单会话聚合镜像（观察建立或首次写入时创建；stopObserving 整体删除）。 */
  private readonly mirrors = new Map<number, ConversationMirror>()
  /** 已结算的 run（防 done+failure+abort 双报）。跨会话前缀键（`${id}:${taskId}`）
   * 全局去重，不进镜像（stopObserving 按前缀清理）。 */
  private readonly settledRuns = new Set<string>()
  /** 会话 -> 已发过压缩失败通知的 taskId（同一失败重复快照不重复通知；
   * 不随 stopObserving 清除——同 runtime 内重观察不得再报同一失败）。 */
  private readonly notifiedCompactionFailures = new Map<number, number>()
  /** contextUsage 缓存/刷新链（在途刷新可跨越停观，状态不进镜像）。 */
  private readonly usage: ContextUsageRefresh
  /** tracker 关闭守卫（close() 或宿主 isClosed 置位后拒绝迟到异步对账副作用）。 */
  private closed = false

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
    /** 宿主关闭状态回调（与 tracker.close() 双保险）。 */
    isClosed?: () => boolean
  }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
    this.redactError = options.redactError ?? ((text) => text)
    this.ownershipOf = options.ownershipOf
    this.modelsOf = options.models
    this.isClosedFn = options.isClosed
    const host: ContextUsageHost = {
      harness: this.harness,
      store: this.store,
      onSummaryChanged: (summary) => this.events.onSummaryChanged(summary),
      modelsOf: () => this.modelsOf?.(),
      generationOf: (id) => this.mirrors.get(id)?.observeGeneration,
      liveOf: (id) => this.mirrors.get(id)?.live,
      summaryOf: (id) => this.summaryOf(id),
    }
    this.usage = new ContextUsageRefresh(host)
  }

  /** 错误诊断摘要脱敏（Runtime 注入 stashService.redact；防 provider 错误回显已登记秘密）。 */
  private readonly redactError: (text: string) => string

  /** 会话归属权现读（缺省恒 human）；仅回合结算 unread 策略消费。 */
  private readonly ownershipOf: ((id: number) => 'helm' | 'bot' | 'human') | undefined

  /** 当前 Models 集合现读（缺省不解析：窗口省略）。 */
  private readonly modelsOf: (() => Models) | undefined

  /** 宿主关闭状态现读（缺省恒 false；与 tracker.closed 双保险）。 */
  private readonly isClosedFn: (() => boolean) | undefined

  private get isClosing(): boolean {
    return this.closed || (this.isClosedFn?.() ?? false)
  }

  /** 取（必要时创建）会话镜像：所有写入路径的唯一入口。 */
  private mirrorOf(id: number): ConversationMirror {
    let mirror = this.mirrors.get(id)
    if (mirror === undefined) {
      mirror = createConversationMirror()
      this.mirrors.set(id, mirror)
    }
    return mirror
  }

  /** 挂接指定会话的同步观察者；活跃 run 恢复时先补权威输入元数据再返回。 */
  async observe(id: number): Promise<void> {
    if (this.mirrors.get(id)?.detach !== undefined) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        const mirror = this.mirrors.get(id)
        if (mirror !== undefined) mirror.detach = undefined
        this.clearLiveTimer(id)
      },
    }
    const observation: Observation<ConversationView> = await this.harness.observeConversation(
      id as never,
      observer,
      BACKGROUND_CONTEXT,
    )
    const mirror = this.mirrorOf(id)
    mirror.detach = () => observation.detach()
    // 初始快照：窗口内已有条目不重发（首次 attach 只对齐水位线）。
    // 代数守护：await 后若已 stopObserving（或重观察换代），不向镜像回写。
    const generation = Symbol('conversation observation')
    mirror.observeGeneration = generation
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
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    mirror.live = live ?? {}
    // 重启/重挂即看到的遗留失败同样不静默（每个 runtime 生命周期恰报一次）。
    this.noteCompactionFailure(id, live)
    let watermark = mirror.lastEmittedEntry
    // 上下文触发水位线与 entry 事件水位线同一初值对齐：初始快照内的历史标记
    // （pi.compaction 等）不触发后续 adopt 的重复刷新（初始刷新见下方调度）。
    let usageWatermark = -1
    let seenEntryId = mirror.lastSeenEntryId
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (Number.isFinite(numeric) && numeric > watermark) watermark = numeric
      if (Number.isFinite(numeric) && numeric > usageWatermark) usageWatermark = numeric
      if (Number.isFinite(numeric) && numeric > seenEntryId) seenEntryId = numeric
    }
    mirror.lastEmittedEntry = watermark
    mirror.lastSeenEntryId = seenEntryId
    if (usageWatermark >= 0) this.usage.advanceWatermarkTo(id, usageWatermark)
    // inbox 镜像登记先于 run 判定：重启/停 run 但 inbox 仍有排队输入时，
    // queuedInputs 派生与 listLiveViews 快照不丢排队事实（不在 web 伪造队列）。
    const inbox = view.docs['pi.inbox'] as { items?: InboxItemShape[] } | undefined
    const inboxItems = inbox?.items ?? []
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)
    // 首次挂接即填充上下文用量缓存（重启/分叉/新建会话的初始读路径）；
    // idle 会话同样需要（否则仅活跃 run 会话有初始值，历史会话打开后无胶囊）。
    this.usage.schedule(id)
    if (!live?.run) return
    mirror.runTaskId = live.run.taskId
    mirror.consumedInputs = new Set<string>()
    const first = live.run.first !== undefined ? Number(live.run.first) : undefined
    if (first !== undefined) mirror.runFirstEntry = first
    // 本 run 已放置输入：SDK 权威 submissionId -> entry 精确回读，登记
    // requestId 追踪记录与 submissionId->requestId 索引（markConsumed 可命中）。
    const loaded = await this.loadRunInputEntries(id, live.run.inputs as number[])
    // 停观换代：异步回读结果作废，绝不向已清理的镜像复活条目。
    if (this.mirrors.get(id)?.observeGeneration !== generation) return
    this.adoptInputsFromEntries(id, loaded.entries)
    this.indexRestoredSubmissions(id, loaded.pairs)
    // queued（未放置）输入：inbox entry 载荷直读（上面已登记镜像，此处仅补输入元数据）。
    this.adoptInputsFromInbox(id, inboxItems)
    for (const submissionId of live.run.inputs) this.markConsumed(id, submissionId)
    // 恢复的活跃 run 已体现在快照摘要（listConversations）：登记语义指纹即可，
    // 后续 advance 仅在真实变化时推送，不补发冗余 working 帧。
    if (this.store.getConv(id)) mirror.lastSummaryKey = summaryKeyOf(this.summaryOf(id))
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
    const index = this.mirrorOf(id).submissionIndex
    for (const { submissionId, requestId } of pairs) index.set(submissionId, requestId)
  }

  /** inbox queued 项重建（未放置输入的 origin/meta/attachments 补齐 + 索引登记）。 */
  private adoptInputsFromInbox(id: number, items: ReadonlyArray<InboxItemShape>): void {
    for (const item of items) {
      if (item.mode === 'write') continue
      const data = item.entry?.data as HelmInputMeta | undefined
      if (item.entry?.kind !== 'helm.input' || !data) continue
      if (typeof data.id !== 'string' || typeof data.text !== 'string') continue
      // inbox 项 id 即 SDK submissionId：登记关联索引（出队放置后 markConsumed 可命中）。
      this.mirrorOf(id).submissionIndex.set(item.id, data.id)
      this.upsertTrackedInput(id, data.id, data)
    }
  }

  /** 关闭 tracker：停观全部会话并阻断在途异步精简对账再发副作用。 */
  close(): void {
    this.closed = true
    for (const id of [...this.mirrors.keys()]) {
      this.stopObserving(id)
    }
  }

  stopObserving(id: number): void {
    const mirror = this.mirrors.get(id)
    mirror?.detach?.()
    // 清 timer 且丢弃待发快照：删除/停观后绝不发出幽灵事件。
    this.clearLiveTimer(id)
    // 上下文用量镜像一并清理：停观/删除后的迟到刷新经代数守护丢弃，不复活；
    // 刷新链等待者先行 resolve（醒来后自查缓存/元数据并退出，不永久挂起）。
    this.usage.clearConversation(id)
    // 彻底清理该会话的全部内存镜像：在途 turn_settled 等待者先 resolve（防永久
    // 挂起）后整体删除，随后清全局 settledRuns 前缀键。否则反复建删会话的进程
    // （CLI/Web 管理面）会随时间无限累积残留条目。
    const settledWaiters = mirror?.settledWaiters ?? []
    for (const resolve of settledWaiters) resolve()
    this.mirrors.delete(id)
    for (const runKey of this.settledRuns) {
      if (runKey.startsWith(`${id}:`)) this.settledRuns.delete(runKey)
    }
  }

  /** 清理 live 节流 timer（幂等）。 */
  private clearLiveTimer(id: number): void {
    const mirror = this.mirrors.get(id)
    const timer = mirror?.liveTimer
    if (timer !== undefined && mirror !== undefined) {
      clearTimeout(timer)
      mirror.liveTimer = undefined
    }
  }

  /** 提交前登记 input 元数据（以持久 input.id 即 requestId 为追踪身份；
   * submit 返回后 bindSubmission 登记 submissionId 关联索引）。 */
  registerInput(conversationId: number, input: ConversationInput): void {
    const map = this.mirrorOf(conversationId).trackedInputs
    // 同 requestId 可能已有 entry/inbox 观察重建的记录（如 rewind 事务提交
    // 先于登记）：只补缺（内存中更完整的元数据优先），不新建重复记录。
    const existing = map.get(input.id)
    map.set(input.id, existing === undefined ? input : mergeInputMeta(existing, input))
  }

  /** submit 返回后登记 submissionId→requestId 关联索引（SDK run.inputs 等
   * 均以 submissionId 表达，经索引映射回追踪身份；HelmError 时 dropInput
   * 移除登记）。 */
  bindSubmission(conversationId: number, requestId: string, submissionId: number): void {
    this.mirrorOf(conversationId).submissionIndex.set(submissionId, requestId)
  }

  dropInput(conversationId: number, requestId: string): void {
    this.mirrors.get(conversationId)?.trackedInputs.delete(requestId)
  }

  /** 撤回排队提交：清理关联索引项及 requestId 追踪记录（withdraw 用）。 */
  dropSubmission(conversationId: number, submissionId: number, requestId?: string): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const resolved = requestId ?? mirror.submissionIndex.get(submissionId)
    mirror.submissionIndex.delete(submissionId)
    if (resolved !== undefined) mirror.trackedInputs.delete(resolved)
  }

  /** 本回合（当前 run）输入清单（before_turn payload 用）：run.inputs 精确
   * 序列（steer 追加在内）+ 尚未关联 submissionId 的登记（submit 在途），
   * 按 input.id 去重唯一。 */
  currentRunInputs(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const run = mirror?.live?.run
    if (!run || !mirror) return []
    const map = mirror.trackedInputs
    const index = mirror.submissionIndex
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
      const requestId = index.get(submissionId)
      if (requestId !== undefined) collect(map.get(requestId))
    }
    // 尚未关联 submissionId 的登记：submit 在途（busy 中 followUp 输入在册未放置）。
    const bound = new Set(index.values())
    for (const [requestId, input] of map) {
      if (!bound.has(requestId)) collect(input)
    }
    return out
  }

  /** 等待本会话全部在途 turn_settled 回调完成（waitForIdle 用，非全局 promise）。 */
  async waitTurnSettled(conversationId: number): Promise<void> {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined && mirror.settledInflight > 0) {
      await new Promise<void>((resolve) => {
        mirror.settledWaiters.push(resolve)
      })
    }
    const settledError = this.mirrors.get(conversationId)?.settledError
    if (settledError !== undefined) throw settledError
  }

  private settledInflightCount(conversationId: number): number {
    return this.mirrors.get(conversationId)?.settledInflight ?? 0
  }

  private beginSettled(conversationId: number): void {
    const mirror = this.mirrorOf(conversationId)
    if (mirror.settledInflight === 0) mirror.settledError = undefined
    mirror.settledInflight += 1
  }

  private endSettled(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined || mirror.settledInflight === 0) return
    mirror.settledInflight -= 1
    if (mirror.settledInflight > 0) return
    const waiters = mirror.settledWaiters
    mirror.settledWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** 会话是否有在途工作（close abort 结算判定：空闲不伪造 aborted 结算）。 */
  hasLiveWork(conversationId: number): boolean {
    return this.mirrors.get(conversationId)?.live?.run !== undefined
  }

  /** 会话是否有进行中的上下文精简任务（不计入 hasLiveWork，避免伪造 turn_settled）。 */
  isCompacting(conversationId: number): boolean {
    return (this.mirrors.get(conversationId)?.live?.compactions?.length ?? 0) > 0
  }

  /** SSE 快照用实时视图清单：仅活跃 run、流式 generation 或非空 queued 的会话。
   *
   * 从 live/inbox 权威镜像同步派生（不依赖上次推送缓存）：重连首帧即恢复排队
   * 胶囊与流式文本；空闲会话不复活（无内容可显示）。 */
  listLiveViews(): ConversationLive[] {
    const out: ConversationLive[] = []
    for (const [id, mirror] of this.mirrors) {
      const live = mirror.live
      const inboxItems = mirror.inbox
      const hasRun = live?.run !== undefined
      const hasStream =
        live?.generation !== undefined || (live?.tools?.length ?? 0) > 0 || (live?.nestedTools?.length ?? 0) > 0
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
    const mirror = this.mirrors.get(conversationId)
    const taskId = mirror?.runTaskId
    if (taskId !== undefined && mirror?.lastSettledRun === taskId) {
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
    const mirror = this.mirrors.get(conversationId)
    const out: ConversationInput[] = []
    if (mirror === undefined) return out
    const run = mirror.live?.run
    const seen = new Set<string>()
    const collect = (input: ConversationInput | undefined): void => {
      if (!input || seen.has(input.id)) return
      seen.add(input.id)
      out.push(input)
    }
    if (run !== undefined) {
      for (const submissionId of run.inputs) {
        const requestId = mirror.submissionIndex.get(submissionId)
        if (requestId !== undefined) collect(mirror.trackedInputs.get(requestId))
      }
    }
    for (const requestId of mirror.consumedInputs ?? []) {
      collect(mirror.trackedInputs.get(requestId))
    }
    const bound = new Set(mirror.submissionIndex.values())
    for (const [requestId, input] of mirror.trackedInputs) {
      if (!bound.has(requestId)) collect(input)
    }
    mirror.trackedInputs = new Map()
    mirror.submissionIndex = new Map()
    return out
  }

  private resetRunState(conversationId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.consumedInputs = undefined
    // runTaskId 保留：显式 abort 路径需它对照 lastSettledRun 防重入；
    // 新 run 启动时（live.run.taskId 变化）自然覆盖。
  }

  /** 登记已结算 runKey，并按会话限制保留容量（最旧淘汰，防无界增长）。
   *
   * runId（taskId）全库单调递增：被淘汰的最旧键不可能再出现，新 run 开始时
   * 的 settledRuns.delete(runKey) 只作用于最近键（必在容量内），语义不变。 */
  private noteSettledRun(conversationId: number, runKey: string): void {
    this.settledRuns.add(runKey)
    const order = this.mirrorOf(conversationId).settledRunOrder
    order.push(runKey)
    while (order.length > SETTLED_RUNS_PER_CONVERSATION) {
      const evicted = order.shift()
      if (evicted !== undefined) this.settledRuns.delete(evicted)
    }
  }

  /** 从容量序中移除指定 runKey（新 run 开始时同步清 settledRuns 用）。 */
  private dropSettledRunFromOrder(conversationId: number, runKey: string): void {
    const order = this.mirrors.get(conversationId)?.settledRunOrder
    if (order === undefined) return
    const index = order.indexOf(runKey)
    if (index >= 0) order.splice(index, 1)
  }

  private adopt(id: number, view: ConversationView): void {
    const mirror = this.mirrorOf(id)
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = mirror.live
    mirror.live = live ?? {}

    // 压缩失败不得静默：新的 compactionFailure 恰发一次 error notification。
    this.noteCompactionFailure(id, live)

    // 上下文边界变化（压缩/重置/原地覆盖重发条目落地，或压缩实时状态变化）：
    // 调度异步刷新（同步去重；observe 回调内禁止 await）。
    this.usage.noteBoundary(id, view, prev, live)

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
    const first = mirror.runFirstEntry
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
    mirror.inbox = inboxItems
    this.adoptInputsFromInbox(id, inboxItems)

    // 新落库条目：按 id 序对每条恰发一次（提交顺序保持，SDK 同 commit 折叠时
    // 窗口仍是全序，逐条推进水位线）。
    this.emitNewEntries(id, view.entries as never as ReadonlyArray<EntryRecordLike>)

    // 检测本快照是否落入新 pi.compaction 条目（独立于 onEntryCommitted sink）。
    const prevSeenEntryId = mirror.lastSeenEntryId
    let nextSeenEntryId = prevSeenEntryId
    let hasNewCompactionEntry = false
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= prevSeenEntryId) continue
      if (numeric > nextSeenEntryId) nextSeenEntryId = numeric
      if (raw.kind === 'pi.compaction') hasNewCompactionEntry = true
    }
    mirror.lastSeenEntryId = nextSeenEntryId

    // 精简任务结束且未落盘 pi.compaction、当前无活跃 run/其余精简任务：
    // 调度异步对账（adopt 内严禁 await），甄别空跳过 vs 中止/失败。
    const prevCompactions = prev?.compactions ?? []
    const nextCompactions = live?.compactions ?? []
    const nextTaskIds = new Set(nextCompactions.map((c) => c.taskId))
    const finishedCompactions = prevCompactions.filter((c) => !nextTaskIds.has(c.taskId))
    if (
      finishedCompactions.length > 0 &&
      nextCompactions.length === 0 &&
      !hasNewCompactionEntry &&
      live?.run === undefined
    ) {
      void this.reconcileFinishedCompaction(id, mirror.observeGeneration, finishedCompactions)
    }

    // 先结算已结束的 prev run（含同快照折叠：run1 结束 + run2 开始同 commit）。
    if (prev?.run && (!live?.run || live.run.taskId !== prev.run.taskId)) {
      const prevRun = prev.run
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.noteSettledRun(id, runKey)
        mirror.lastSettledRun = prevRun.taskId
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
        if (mirror.runFirstEntry === undefined || tail > mirror.runFirstEntry) mirror.runFirstEntry = tail
      }
    }

    if (live?.run) {
      const runKey = `${id}:${live.run.taskId}`
      if (mirror.runTaskId !== live.run.taskId) {
        // 新 run 开始：重置本回合消费集（同 run 多 tool round 不重置）。
        mirror.runTaskId = live.run.taskId
        mirror.consumedInputs = new Set<string>()
        this.settledRuns.delete(runKey)
        this.dropSettledRunFromOrder(id, runKey)
        const first = live.run.first !== undefined ? Number(live.run.first) : undefined
        if (first !== undefined) {
          if (mirror.runFirstEntry === undefined || first > mirror.runFirstEntry) mirror.runFirstEntry = first
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

  /** 新落库条目：按 id 序推进水位线，每条恰发一次。 */
  private emitNewEntries(id: number, entries: ReadonlyArray<EntryRecordLike>): void {
    const sink = this.events.onEntryCommitted
    if (sink === undefined) return
    const mirror = this.mirrors.get(id)
    let watermark = mirror?.lastEmittedEntry ?? 0
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
    if (advanced && mirror !== undefined) mirror.lastEmittedEntry = watermark
  }

  /** 节流推送实时视图：窗口内只保留最新快照，同内容不重复发帧。
   *
   * queuedInputs 变化（入队/出队）绕过 75ms 节流立即冲刷：用户提交
   * steer / followUp 后时间线尾部胶囊尽快可见（受观察提交时序影响）。 */
  private emitLiveThrottled(id: number, live: LiveStateShape | undefined): void {
    if (this.events.onLiveChanged === undefined) return
    const mirror = this.mirrors.get(id)
    const inboxItems = mirror?.inbox
    const queuedEmpty =
      !live?.run &&
      !live?.generation &&
      (live?.tools?.length ?? 0) === 0 &&
      (live?.nestedTools?.length ?? 0) === 0 &&
      (inboxItems?.length ?? 0) === 0
    if (queuedEmpty) {
      // 空闲视图不推送（终态冲刷由 emitSettled 负责）；但「之前发过 queued、
      // 现在权威 inbox 已空」时不能短路丢弃清理帧（否则客户端胶囊残留）。
      const prevQueued = mirror?.lastQueuedLiveKey
      if (prevQueued === undefined || prevQueued === '[]') return
      const cleanup = deriveConversationLive(id, live, Date.now(), inboxItems)
      this.sendLiveNow(id, cleanup)
      return
    }
    const snapshot = deriveConversationLive(id, live, Date.now(), inboxItems)
    const key = this.liveKeyOf(snapshot)
    // 「上次已发 queued 指纹」统一语义：未登记视为空队列 '[]'（首次空队列
    // 不因此误入立即冲刷路径）；仅 queue 变化绕过 75ms 节流。
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    const prevQueuedKey = mirror?.lastQueuedLiveKey ?? '[]'
    if (key === mirror?.lastLiveKey && queuedKey === prevQueuedKey) return
    if (queuedKey !== prevQueuedKey) {
      // 入队/出队实时性优先：清 timer 同步冲刷，不等 75ms 节流。
      this.clearLiveTimer(id)
      this.sendLiveNow(id, snapshot)
      return
    }
    const m = this.mirrorOf(id)
    m.pendingLive = snapshot
    if (m.liveTimer !== undefined) return
    const timer = setTimeout(() => {
      m.liveTimer = undefined
      this.flushPendingLive(id)
    }, LIVE_THROTTLE_MS)
    timer.unref?.()
    m.liveTimer = timer
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
    const mirror = this.mirrorOf(id)
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** 冲刷窗口内待发快照（timer 到期或 queuedInputs 变化立即冲刷）。 */
  private flushPendingLive(id: number): void {
    const mirror = this.mirrors.get(id)
    const snapshot = mirror?.pendingLive
    if (mirror === undefined || snapshot === undefined) return
    mirror.pendingLive = undefined
    mirror.lastLiveKey = this.liveKeyOf(snapshot)
    mirror.lastQueuedLiveKey = JSON.stringify(snapshot.queuedInputs ?? [])
    this.events.onLiveChanged?.(snapshot)
  }

  /** 终态强制冲刷：以当前 live 镜像为准同步发帧（清 timer，丢弃过期窗口快照）。 */
  private flushLiveFinal(conversationId: number): void {
    this.clearLiveTimer(conversationId)
    const mirror = this.mirrors.get(conversationId)
    if (mirror !== undefined) mirror.pendingLive = undefined
    if (this.events.onLiveChanged === undefined) return
    const snapshot = deriveConversationLive(
      conversationId,
      mirror?.live,
      Date.now(),
      mirror?.inbox,
    )
    const key = this.liveKeyOf(snapshot)
    const queuedKey = JSON.stringify(snapshot.queuedInputs ?? [])
    if (key === mirror?.lastLiveKey && queuedKey === (mirror?.lastQueuedLiveKey ?? '[]')) return
    const m = this.mirrorOf(conversationId)
    m.lastLiveKey = key
    m.lastQueuedLiveKey = queuedKey
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
    const map = this.mirrorOf(id).trackedInputs
    const rebuilt = inputFromMeta(meta)
    const existing = map.get(requestId)
    map.set(requestId, existing === undefined ? rebuilt : mergeInputMeta(existing, rebuilt))
  }

  /** 标记 submissionId 已被当前 run 消费：经关联索引映射回 requestId 后
   * 恰一次登记（onInputCommitted 恰一次）。索引缺失（bind/回填尚未发生）时
   * 静默跳过，下一次快照重扫 run.inputs 时补记。 */
  private markConsumed(conversationId: number, submissionId: number): void {
    const mirror = this.mirrors.get(conversationId)
    if (mirror === undefined) return
    const requestId = mirror.submissionIndex.get(submissionId)
    const input = requestId === undefined ? undefined : mirror.trackedInputs.get(requestId)
    if (!input) return
    const consumedSet = mirror.consumedInputs ?? new Set<string>()
    if (consumedSet.has(input.id)) return
    consumedSet.add(input.id)
    mirror.consumedInputs = consumedSet
    this.events.onInputCommitted(conversationId, input)
  }

  /** 结算取本 run 已消费输入并清理登记：requestId 集合每项恰一条记录，
   * 追踪记录与关联索引一并清除，历史不复活。 */
  private takeConsumed(conversationId: number): ConversationInput[] {
    const mirror = this.mirrors.get(conversationId)
    const consumedSet = mirror?.consumedInputs
    const out: ConversationInput[] = []
    if (mirror !== undefined && consumedSet !== undefined) {
      for (const requestId of consumedSet) {
        const input = mirror.trackedInputs.get(requestId)
        if (input !== undefined) out.push(input)
      }
      // 已结算输入的追踪记录与索引项一并清除。
      for (const [submissionId, requestId] of mirror.submissionIndex) {
        if (consumedSet.has(requestId)) mirror.submissionIndex.delete(submissionId)
      }
      for (const requestId of consumedSet) mirror.trackedInputs.delete(requestId)
    }
    if (mirror !== undefined) mirror.consumedInputs = undefined
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const generation = this.mirrors.get(conversationId)?.observeGeneration
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
          settledStatus === 'error' ? lastErrorOf(this.mirrors.get(conversationId)?.live, this.redactError) : undefined,
        )
        const cachedUsage = this.usage.peek(conversationId)
        const settledSummary = cachedUsage === undefined ? settledRaw : { ...settledRaw, contextUsage: cachedUsage }
        // 终态摘要登记语义指纹：后续空闲快照不重复推送同一终态。
        this.mirrorOf(conversationId).lastSummaryKey = summaryKeyOf(settledSummary)
        this.events.onSummaryChanged(settledSummary)
        // 回合结算后上下文已定：异步刷新用量（变化才补发 upsert；不推进 seq）。
        this.usage.schedule(conversationId)
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
          if (this.mirrors.get(conversationId)?.observeGeneration === generation) this.endSettled(conversationId)
        },
        (error: unknown) => {
          const mirror = this.mirrors.get(conversationId)
          if (mirror === undefined || mirror.observeGeneration !== generation) return
          mirror.settledError = error
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
    const mirror = this.mirrors.get(conversationId)
    const live = mirror?.live
    const pendingAsks =
      typeof pendingAskOverride === 'number'
        ? pendingAskOverride
        : (mirror?.pendingAskCount ?? 0)
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
    const usage = this.usage.cachedOrSchedule(conversationId)
    return usage === undefined ? summary : { ...summary, contextUsage: usage }
  }

  /** 调度异步上下文用量刷新（委托刷新链模块；对外端口保留给 service/ops 消费方）。 */
  scheduleContextUsageRefresh(conversationId: number): void {
    this.usage.schedule(conversationId)
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
   * - 只看已观察（镜像内有观察代数）或已有用量缓存的会话：不扫全量历史
   *   会话（启动期/大目录下的昂贵 N 次扫描），未观察且未缓存的会话首次
   *   波取时自然按新目录计算。
   */
  onModelsChanged(providers: readonly string[]): void {
    const wanted = providers.length > 0 ? new Set(providers) : undefined
    const targets = new Set([...this.usage.cachedConversationIds(), ...this.observedConversationIds()])
    for (const id of targets) {
      const meta = this.store.getConv(id)
      if (!meta || meta.model === '') continue
      const slash = meta.model.indexOf('/')
      const provider = slash > 0 ? meta.model.slice(0, slash) : meta.model
      if (wanted !== undefined && !wanted.has(provider)) continue
      this.usage.schedule(id)
    }
  }

  /** 已观察会话清单（镜像内存在观察代数；与迁移前 observeGenerations 键域一致）。 */
  private observedConversationIds(): number[] {
    const out: number[] = []
    for (const [id, mirror] of this.mirrors) {
      if (mirror.observeGeneration !== undefined) out.push(id)
    }
    return out
  }

  /** 确保该会话 contextUsage 缓存已填充且刷新链归寂（首个详情读等同步可见路径）。 */
  async ensureContextUsage(conversationId: number): Promise<void> {
    await this.usage.ensure(conversationId)
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

  /**
   * 无 pi.compaction 落盘的精简结束异步对账（adopt 同步快照外执行）：
   * - 逐任务查询权威终态，仅当存在干净完成（status='terminal' 且
   *   outcome.status='completed'、无摘要写入且非 compactionFailure）时视为
   *   空跳过（selectCut === undefined 或 beforeCompact decline）；
   * - aborted / failed 任务一律忽略（绝不误报「当前上下文无需精简」，也绝不在
   *   未精简上下文上擅自冲刷排队输入）；
   * - 确认干净空跳过后：若有 manual 触发发 info 通知；若 inbox 仍有 steer/followUp
   *   排队输入且当前空闲无压缩，通过 continue 自动启动下一回合。
   */
  private async reconcileFinishedCompaction(
    id: number,
    generation: symbol | undefined,
    finished: ReadonlyArray<{ taskId: number; trigger: string; blocking: boolean }>,
  ): Promise<void> {
    try {
      if (this.isClosing || !this.store.getConv(id)) return
      const initialMirror = this.mirrors.get(id)
      if (initialMirror === undefined || initialMirror.observeGeneration !== generation) return

      let hasCleanEmpty = false
      let hasManualEmpty = false
      for (const task of finished) {
        const record = await this.harness.getTask(task.taskId as never, BACKGROUND_CONTEXT)
        if (this.isClosing || !this.store.getConv(id)) return
        const currentMirror = this.mirrors.get(id)
        if (currentMirror === undefined || currentMirror.observeGeneration !== generation) return
        if (record === undefined) continue
        if (record.state.status !== 'terminal' || record.state.outcome.status !== 'completed') continue
        if (currentMirror.live?.compactionFailure?.taskId === task.taskId) continue
        const result = record.state.outcome.result as { entryId?: unknown; submissionId?: unknown } | undefined
        if (result?.entryId !== undefined || result?.submissionId !== undefined) continue
        hasCleanEmpty = true
        if (task.trigger === 'manual') hasManualEmpty = true
      }
      if (!hasCleanEmpty) return

      const mirror = this.mirrors.get(id)
      if (mirror === undefined || mirror.observeGeneration !== generation) return

      if (hasManualEmpty) {
        this.events.onNotification?.({
          level: 'info',
          title: '当前上下文无需精简',
          body: '历史消息未超过保留窗口，未生成新的摘要。',
          conversationId: id,
        })
      }

      const hasQueuedInputs = (mirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!hasQueuedInputs || mirror.live?.run !== undefined || (mirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      const conv = await this.harness.conversation(id as never, BACKGROUND_CONTEXT)
      if (this.isClosing || !this.store.getConv(id)) return
      const latestMirror = this.mirrors.get(id)
      if (latestMirror === undefined || latestMirror.observeGeneration !== generation) return
      const stillQueued = (latestMirror.inbox ?? []).some(
        (item) => item.mode === 'steer' || item.mode === 'followUp',
      )
      if (!stillQueued || latestMirror.live?.run !== undefined || (latestMirror.live?.compactions?.length ?? 0) > 0) {
        return
      }
      try {
        await conv?.submit({ type: 'continue' }, BACKGROUND_CONTEXT)
      } catch (error) {
        const name = (error as { name?: string })?.name
        const code = (error as { code?: string })?.code
        if (name === 'ConversationBusy' || code === 'not_found') return
        throw error
      }
    } catch (error) {
      if (this.isClosing) return
      console.error(`[helm] 会话 ${id} 精简结束对账失败:`, error)
    }
  }

  setPendingAskCount(conversationId: number, count: number): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.pendingAskCount
    if (prev === count) return
    mirror.pendingAskCount = count
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
    mirror.lastSummaryKey = summaryKeyOf(summary)
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
    const mirror = this.mirrors.get(id)
    if (!mirror?.live?.run) return
    const meta = this.store.getConv(id)
    if (!meta) return
    if (mirror.lastSummaryKey === summaryKeyOf(this.summaryOf(id))) return
    this.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.summaryOf(id)
    mirror.lastSummaryKey = summaryKeyOf(summary)
    this.events.onSummaryChanged(summary)
  }

  /** 观察到的最新 assistant 文本（getLastAssistantText 数据源）。 */
  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    const mirror = this.mirrorOf(conversationId)
    const prev = mirror.lastAssistant
    if (prev !== undefined && prev.entryId === entryId) return
    mirror.lastAssistant = { entryId, text }
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.mirrors.get(conversationId)?.lastAssistant?.text
  }

  /** 失效落入 rewind 覆盖区间的 lastAssistant 缓存（原地覆盖重发后）。
   *
   * 仅当缓存指向的 entry 落在 [from, through] 内才清除：新回答失败时
   * getLastAssistantText 不得返回已被覆盖的旧答案，而区间外（更早回合）
   * 的缓存仍然有效。*/
  invalidateLastAssistantWithin(conversationId: number, from: number, through: number): void {
    const mirror = this.mirrors.get(conversationId)
    const cached = mirror?.lastAssistant
    if (cached === undefined) return
    if (cached.entryId >= from && cached.entryId <= through) {
      mirror!.lastAssistant = undefined
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
