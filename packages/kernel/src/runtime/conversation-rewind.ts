/**
 * 会话历史重写、回退重发（rewind）与断点恢复引擎。
 *
 * 职责：
 * - 原地覆盖重发目标校验与防并发互斥；
 * - 原地覆盖重发原子事务（commit 内部校验空闲、扫描尾部、计算 omit、提交新输入、写入 helm.rewind 截断标记）；
 * - 事务后精准 FTS 索引清理、lastAssistant 缓存失效与 tracker 登记；
 * - 全量 rewind 覆盖区间扫描汇总（提供给详情投影与 FTS 重建）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { InboxDoc, LiveDoc, type Harness } from '@earendil-works/pi-durable'
import type { ConversationAttachmentRef, ConversationInput } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConversationTracker } from './conversations.js'
import {
  assertEditableHumanInput,
  rewindIntervalOf,
  type RewindInterval,
} from './runtime-helpers.js'
import type { HelmStore } from './store.js'

export interface ConversationRewindHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly cancelPendingAsksForRewrite: (id: number) => Promise<void>
  readonly abortConversation: (id: number) => Promise<void>
}

export interface RewindNewInput {
  finalInput: ConversationInput
  effectiveText: string
  resolvedAttachments?: Array<{ ref: ConversationAttachmentRef; absPath: string }>
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}

export class ConversationRewind {
  private readonly historyEditsInFlight = new Set<number>()

  constructor(private readonly host: ConversationRewindHost) {}

  async withHistoryEdit<T>(id: number, operation: () => Promise<T>): Promise<T> {
    if (this.historyEditsInFlight.has(id)) {
      throw new HelmError('conversation_busy', `会话 ${id} 正在更新历史消息，请稍后重试`, 409)
    }
    this.historyEditsInFlight.add(id)
    try {
      return await operation()
    } finally {
      this.historyEditsInFlight.delete(id)
    }
  }

  /** 原地覆盖目标的提交前边界校验（存在 / 活跃上下文内 / 未被覆盖 / 人类输入）。 */
  async validateReplaceTarget(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    raw: number | undefined,
  ): Promise<number | undefined> {
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new HelmError(
        'validation_error',
        `replaceFromEntryId 需为安全正整数（收到 ${String(raw)}）`,
        400,
        { conversationId: id, replaceFromEntryId: raw },
      )
    }
    // 条目存在性精确校验（min=max=entryId 取 1 条；不存在 404）。
    const page = await conversation.entries(
      { minEntryId: raw as never, maxEntryId: raw as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || Number((page.items[0] as { id: number }).id) !== raw) {
      throw new HelmError('not_found', `条目 ${raw} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: raw,
      })
    }
    // 编辑目标限定人类输入：agent/trigger 注入、assistant/控制条目不可编辑。
    assertEditableHumanInput(page.items[0] as { kind: string; data?: unknown }, id, raw)
    const preCtx = await conversation.context(BACKGROUND_CONTEXT)
    if (!preCtx.entries.some((e) => Number(e.id) === raw)) {
      throw new HelmError(
        'entry_before_context_head',
        `条目 ${raw} 位于最近一次重置或压缩之前，无法原地覆盖，请使用分叉（fork）`,
        409,
        { conversationId: id, entryId: raw },
      )
    }
    const rewound = preCtx.entries.some((e) => {
      const interval = rewindIntervalOf(e as unknown as { id: number | string; kind: string; data?: unknown })
      return interval !== undefined && raw >= interval.from && raw <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `条目 ${raw} 已被此前的重发覆盖`, 409, {
        conversationId: id,
        entryId: raw,
      })
    }
    return raw
  }

  /** 陈旧编辑守卫：钩子挂起期间目标可能被并发改写（离开上下文 / 已被覆盖）。 */
  async assertTargetStillCurrent(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    targetId: number,
  ): Promise<void> {
    const current = await conversation.context(BACKGROUND_CONTEXT)
    if (!current.entries.some((entry) => Number(entry.id) === targetId)) {
      throw new HelmError('entry_before_context_head', '编辑目标已离开当前上下文，请重新选择消息', 409)
    }
    if (current.entries.some((entry) => {
      const cut = rewindIntervalOf(entry as unknown as { id: number | string; kind: string; data?: unknown })
      return cut !== undefined && targetId >= cut.from && targetId <= cut.through
    })) {
      throw new HelmError('entry_already_rewound', `条目 ${targetId} 已被此前的重发覆盖`, 409)
    }
  }

  /** 扫描会话全量 raw entries，汇总全部 rewind 覆盖区间（详情投影用）。 */
  async collectRewindIntervals(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ): Promise<RewindInterval[]> {
    const intervals: RewindInterval[] = []
    let cursor: unknown = undefined
    for (;;) {
      const page = await conversation.entries({ order: 'ascending' }, 100, cursor as never, BACKGROUND_CONTEXT)
      for (const raw of page.items as never as Array<{ id: number | string; kind: string; data?: unknown }>) {
        if (raw.kind !== 'helm.rewind') continue
        const interval = rewindIntervalOf(raw)
        if (interval !== undefined) intervals.push(interval)
      }
      if (page.next === undefined) break
      cursor = page.next
    }
    return intervals
  }

  /**
   * 原地覆盖重发的原子提交（submitInput replaceFromEntryId 路径）：
   * 1. 异步准备：abort 在途回合（SDK abort 同时撤回其他 queued inputs，
   *    为本次明确语义）并等待 idle，挂起 Ask 逐个销单 superseded（错误如实
   *    上抛，绝不吞错伪成功）；
   * 2. 单个 SDK commit 内完成全部核验与写入（见 rewriteTransaction）；
   * 3. 事务后清理：精确删除被覆盖条目的 FTS 键并等待落盘（错误传播）、
   *    失效落入覆盖区间的 lastAssistant 缓存、推进 stateChangeSeq。
   *
   * 区间契约：helm.rewind.data 声明闭区间 [fromEntryId, throughEntryId]，
   * throughEntryId 为本事务前尾部（PRE_TRANSACTION_TAIL_ID）；新输入条目
   * ID 必然更大，绝不会被自家区间误删。既有 rewind 标记与 baseline
   * pi.system 保留（不 omit）；model messages 被省略由 SDK 原生 edits 负责。
   */
  async rewriteConversationFrom(
    id: number,
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    replaceFromEntryId: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: string }> {
    // 异步准备阶段（事务外）：用户已授权历史编辑中止当前回合。
    if (this.host.tracker.hasLiveWork(id)) {
      await this.host.abortConversation(id)
      await conversation.waitForIdle(BACKGROUND_CONTEXT)
      await this.host.tracker.waitTurnSettled(id)
    }
    // 挂起 Ask 销单为 superseded：被覆盖回合的审批卡不再有效；
    // 取消失败如实上抛（诚实纪律：绝不 .catch 吞错）。
    await this.host.cancelPendingAsksForRewrite(id)

    const createdAt = Date.now()
    // coveredRange 从事务内返回：事务外精确清理 FTS 旧键并失效落入区间的
    // lastAssistant 缓存（绝不触碰新输入/新回答的键）。
    const { submissionId, covered, ftsKeys } = await conversation.commit(
      (tx) => this.rewriteTransaction(conversation, tx, id, replaceFromEntryId, createdAt, newInput),
      BACKGROUND_CONTEXT,
    )
    this.registerRewoundInput(id, newInput.finalInput, submissionId)
    this.cleanupRewindSideEffects(id, covered, ftsKeys)
    return { submissionId: String(submissionId) }
  }

  /**
   * rewind 事务主体（commit 回调内；禁止 conversation.context()/harness 读等
   * 会死锁的接口）。阶段化拆分：核实空闲 -> 采集尾部 -> 计算 omit 清单 ->
   * 提交新输入 -> 追加 rewind 标记。
   */
  private async rewriteTransaction(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
    createdAt: number,
    newInput: RewindNewInput,
  ): Promise<{ submissionId: string; covered: { from: number; through: number }; ftsKeys: string[] }> {
    // —— 事务内重新核实（全部 tx reads，先于任何 table write）——
    const { tailId, headLowerBound } = await this.assertRewriteIdle(tx, id, replaceFromEntryId)
    const tailEntries = await this.scanTailEntries(tx, id, replaceFromEntryId)
    const target = tailEntries.find((e) => Number(e.id) === replaceFromEntryId)
    if (target === undefined) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    assertEditableHumanInput(target, id, replaceFromEntryId)
    // 既有 rewind 区间重核（异步准备期间可能有并发写入）。
    const rewound = tailEntries.some((e) => {
      const interval = rewindIntervalOf(e)
      return interval !== undefined && replaceFromEntryId >= interval.from && replaceFromEntryId <= interval.through
    })
    if (rewound) {
      throw new HelmError('entry_already_rewound', `条目 ${replaceFromEntryId} 已被此前的重发覆盖`, 409, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const baselineSystemNumericId = await this.findBaselineSystemId(tx, id, headLowerBound)
    const { omittedEntryIds, omittedInputIds, ftsKeys } = this.collectRewindOmissions(tailEntries, baselineSystemNumericId)
    // 提交新输入（whenBusy 'reject'：任何并发进入在此显式失败，绝不排队）。
    // submit(tx, draft) 必须先于本事务首个 table write。
    const submissionId = await this.submitRewoundInput(conversation, tx, newInput)
    // rewind 截断标记：闭区间 [replaceFromEntryId, tailId]，新输入条目 ID
    // 已由上方 submit 分配（必然 > tailId），不会被自家 edits 误删。
    const edits = omittedEntryIds.map((target2) => ({ target: target2 as never, action: 'omit' as const }))
    await tx.appendEntry(id as never, {
      kind: 'helm.rewind',
      data: {
        fromEntryId: replaceFromEntryId,
        throughEntryId: tailId,
        omittedEntryIds,
        omittedInputIds,
        createdAt,
      } as unknown as JsonValue,
      ...(edits.length > 0 ? { edits } : {}),
    })
    return {
      submissionId,
      covered: { from: replaceFromEntryId, through: tailId },
      ftsKeys,
    }
  }

  /** 事务内空闲核实：活跃 run / 压缩 / 排队 / 目标越界（含上下文头）。 */
  private async assertRewriteIdle(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
  ): Promise<{ tailId: number; headLowerBound: number }> {
    const live = await tx.doc(LiveDoc, id as never)
    if (live.run !== undefined) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在活跃回合，拒绝原地覆盖重发（不排队）`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    if ((live.compactions?.length ?? 0) > 0) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在进行中的压缩任务，拒绝原地覆盖重发`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const inbox = await tx.doc(InboxDoc, id as never)
    if (inbox.items.length > 0) {
      throw new HelmError(
        'conversation_busy',
        `会话 ${id} 存在 ${inbox.items.length} 项排队提交，拒绝原地覆盖重发（不排队）`,
        409,
        { conversationId: id, replaceFromEntryId },
      )
    }
    const headMarker = await tx.latestHeadMarker(id as never)
    const latestIdRaw = await tx.latestEntryId(id as never)
    if (latestIdRaw === undefined) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const tailId = Number(latestIdRaw)
    if (replaceFromEntryId > tailId) {
      throw new HelmError('not_found', `条目 ${replaceFromEntryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: replaceFromEntryId,
      })
    }
    const headLowerBound = headMarker !== undefined ? Number(headMarker.head) : 0
    if (replaceFromEntryId < headLowerBound) {
      throw new HelmError(
        'entry_before_context_head',
        `条目 ${replaceFromEntryId} 位于最近一次重置或压缩之前，无法原地覆盖，请使用分叉（fork）`,
        409,
        { conversationId: id, entryId: replaceFromEntryId },
      )
    }
    return { tailId, headLowerBound }
  }

  /** 采集目标及之后的 raw entries（fork 可见范围；分页 scan，无深嵌套）。 */
  private async scanTailEntries(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    replaceFromEntryId: number,
  ): Promise<Array<{ id: number | string; kind: string; data?: unknown }>> {
    const tailEntries: Array<{ id: number | string; kind: string; data?: unknown }> = []
    let scanCursor: unknown = undefined
    for (;;) {
      const page = await tx.scanEntries(
        {
          conversationId: id as never,
          minEntryId: replaceFromEntryId as never,
          order: 'ascending',
        },
        200,
        scanCursor as never,
      )
      for (const raw of page.items as never as Array<{ id: number | string; kind: string; data?: unknown }>) {
        tailEntries.push(raw)
      }
      if (page.next === undefined) break
      scanCursor = page.next
    }
    return tailEntries
  }

  /** baseline pi.system 定位：head 标记之后首条（保持 messages[0] 系统提示词）。 */
  private async findBaselineSystemId(
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    id: number,
    headMarkerId: number,
  ): Promise<number | undefined> {
    let baselineSystemNumericId: number | undefined
    let baselineCursor: unknown = undefined
    for (;;) {
      const page = await tx.scanEntries(
        { conversationId: id as never, minEntryId: (headMarkerId + 1) as never, order: 'ascending' },
        200,
        baselineCursor as never,
      )
      const baseline = page.items.find((entry) => entry.kind === 'pi.system')
      if (baseline !== undefined) {
        baselineSystemNumericId = Number(baseline.id)
        break
      }
      if (page.next === undefined) break
      baselineCursor = page.next
    }
    return baselineSystemNumericId
  }

  /** omit 清单与精确 FTS 键采集（覆盖区间；baseline system 与 rewind 标记保留）。 */
  private collectRewindOmissions(
    tailEntries: ReadonlyArray<{ id: number | string; kind: string; data?: unknown }>,
    baselineSystemNumericId: number | undefined,
  ): { omittedEntryIds: number[]; omittedInputIds: string[]; ftsKeys: string[] } {
    const omittedEntryIds: number[] = []
    const omittedInputIds: string[] = []
    const ftsKeys: string[] = []
    for (const e of tailEntries) {
      const numericId = Number(e.id)
      // 覆盖区间内全部旧条目的精确 FTS 键（含被保留的 baseline system 与
      // rewind 标记本身——它们本就无索引文本，删不删都不影响，但统一采集
      // 避免 tailEntries 与清理清单两套逻辑）。
      ftsKeys.push(`entry:${String(e.id)}`)
      if (e.kind === 'helm.input') {
        const inputId = (e.data as { id?: unknown } | undefined)?.id
        if (typeof inputId === 'string' && inputId !== '') {
          ftsKeys.push(`input:${inputId}`)
          omittedInputIds.push(inputId)
        }
      }
      // 编辑目标本身必须 omit（闭区间含 from 边界）；既有 rewind 标记与
      // baseline pi.system 保留。
      if (e.kind === 'helm.rewind') continue
      if (numericId === baselineSystemNumericId) continue
      omittedEntryIds.push(numericId)
    }
    return { omittedEntryIds, omittedInputIds, ftsKeys }
  }

  /** rewind 新输入提交（whenBusy 'reject'；helm.input entry 全量脱敏后落库）。 */
  private async submitRewoundInput(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    tx: Parameters<Parameters<NonNullable<Awaited<ReturnType<Harness['conversation']>>>['commit']>[0]>[0],
    newInput: RewindNewInput,
  ): Promise<string> {
    const inputDraft = {
      type: 'input' as const,
      content: newInput.content,
      whenBusy: 'reject' as const,
      entry: {
        kind: 'helm.input',
        data: {
          id: newInput.finalInput.id,
          text: newInput.effectiveText,
          origin: newInput.finalInput.origin,
          createdAt: newInput.finalInput.createdAt,
          whenBusy: 'reject',
          ...(newInput.finalInput.meta !== undefined ? { meta: newInput.finalInput.meta } : {}),
          ...(newInput.resolvedAttachments !== undefined
            ? { attachments: newInput.resolvedAttachments.map((r) => r.ref) }
            : {}),
        } as unknown as JsonValue,
      },
      requestId: newInput.finalInput.id,
    }
    return conversation.submit(tx, inputDraft) as unknown as Promise<string>
  }

  /** 事务后 tracker 登记（bindSubmission 合并 commit 观察路径的先行登记）。 */
  private registerRewoundInput(id: number, finalInput: ConversationInput, submissionId: unknown): void {
    // 事务已落库：登记 tracker（commit 观察路径可能已按 req: 键先行登记，
    // bindSubmission 会合并为唯一记录，失败则 drop 撤销，绝不留下孤儿登记）。
    const key = this.host.tracker.registerInput(id, finalInput)
    try {
      this.host.tracker.bindSubmission(id, key, Number(submissionId))
    } catch (error) {
      this.host.tracker.dropInput(id, key)
      throw error
    }
  }

  /** 事务外清理：FTS 精确旧键删除 + lastAssistant 缓存失效 + stateChangeSeq 推进。 */
  private cleanupRewindSideEffects(id: number, covered: { from: number; through: number }, ftsKeys: string[]): void {
    // 事务外清理：只删事务内核实的精确旧 FTS 键（entry:<id> / input:<requestId>），
    // 观察者新输入/新回答入索引不受影响（遇 helm.rewind 停止回扫，旧回答不复燃）；
    // 落盘错误由尾链统一冲刷传播（flushPublic / search 读路径如实抛出）。
    // 失效落入覆盖区间的 lastAssistant 缓存：新回答失败时
    // getLastAssistantText 不得返回已被覆盖的旧答案。
    this.host.store.removeFtsEntries(id, ftsKeys)
    this.host.tracker.invalidateLastAssistantWithin(id, covered.from, covered.through)
    const meta = this.host.store.getConv(id)
    if (meta) {
      this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    }
  }
}
