/**
 * 会话详情分页、游标编解码与 FTS 索引维护。
 *
 * 职责：
 * - 详情分页读取，按 helm.rewind 闭区间过滤被覆盖旧条目，保留元数据条目；
 * - 分页游标 base64url 校验与编解码；
 * - FTS 索引全量重建（过滤 rewind 覆盖条目）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { ConversationDetail, ConversationEntry, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import { toConversationEntry } from './entries.js'
import { projectDetailEntry, stripEntrySignatures } from './entry-projection.js'
import {
  coveredByRewind,
  entryModelText,
  rewindIntervalOf,
  type RewindInterval,
} from './runtime-helpers.js'
import type { HelmStore } from './store.js'

/** cursor 最大编码长度（base64url 后；超长拒绝防滥用）。 */
export const DETAIL_CURSOR_MAX_LENGTH = 2048

export interface ConversationDetailHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly stash: SecretStash
  readonly getConversation: (id: number) => ConversationSummary
  readonly collectRewindIntervals: (
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
  ) => Promise<RewindInterval[]>
  /** contextUsage 刷新链归寂等待（tracker.ensureContextUsage；并行腿之一）。 */
  readonly ensureContextUsage: (id: number) => Promise<void>
}

export class ConversationDetailService {
  constructor(private readonly host: ConversationDetailHost) {}

  /**
   * 会话详情（摘要 + 分页时间线）：
   * - 服务端统一过滤被 helm.rewind 覆盖的旧条目（闭区间 [fromEntryId,
   *   throughEntryId]），但保留 helm.rewind 元数据条目本身（前端 SSE 与
   *   分页过滤共用同一区间公式）；
   * - 每次详情读时扫描汇总全部 rewind 区间（简单实现，不加新持久表/缓存），
   *   再从 SDK raw cursor 分页读取，过滤覆盖条目直到满足 limit 或无更多；
   * - cursor 是 base64url(JSON{conversationId,cursor:SDK next})：绑定会话、
   *   长度/JSON 合法性校验、limit 钳制 1..500；不静默截断；
   * - entry 保留 model 消息与 data，出界前经事件同源脱敏（发布路径统一）。
   */
  async getConversationDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    // 并行化：contextUsage 刷新（重启后首开等冷路径）与时间线分页互不依赖。
    // Promise.all 保证任一腿失败即整体拒绝（绝不返回半真详情、无未处理拒绝）；
    // 两腿完成后必须重取权威摘要合并——assembleDetail 在并行窗内抢先读取的
    // 摘要可能缺刚刷出的 contextUsage（缓存命中/刷新失败路径与串行同构：
    // 失败时 usage 诚实地保持缺省，不伪造）。
    const [, detail] = await Promise.all([
      this.host.ensureContextUsage(id),
      this.assembleDetail(id, options),
    ])
    return { ...detail, ...this.host.getConversation(id) }
  }

  /** 详情主体（分页 + 投影 + 摘要初值；摘要随后由并行合并覆盖为权威值）。 */
  private async assembleDetail(
    id: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> {
    const summary = this.host.getConversation(id)
    const limit = options?.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HelmError('validation_error', `limit 必须是 1..500 的整数（收到 ${limit}）`, 400, {
        limit,
      })
    }
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)

    let sdkCursor: unknown = undefined
    if (options?.cursor !== undefined) {
      sdkCursor = this.decodeDetailCursor(id, options.cursor)
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    const { collected, nextCursor } = await this.pageVisibleEntries(conversation, id, limit, sdkCursor, rewindCuts)

    // HTTP 详情出口投影：pi.system 过滤 + 签名剥离 + 安全纯文本 tool-result
    // 截断（见 entry-projection.ts）。SSE/waitForInput 不经此投影。
    const entries: ConversationEntry[] = []
    for (const raw of collected.reverse()) {
      const projected = projectDetailEntry(toConversationEntry(raw as { id: number; kind: string }))
      if (projected !== undefined) entries.push(projected)
    }
    return {
      ...summary,
      entries,
      ...(nextCursor !== undefined ? { nextCursor: this.encodeDetailCursor(id, nextCursor as Readonly<Record<string, unknown>>) } : {}),
    }
  }

  /**
   * 单条时间线条目（GET /api/conversations/:id/entries/:entryId）：
   * - 精确读取（min=max=entryId 取 1 条，不经分页猜测）；conversationId 与
   *   entryId 均强校验（路由 parseIdParam + 服务层安全整数复核）；
   * - rewind 可见性与详情分页一致：被 helm.rewind 覆盖的旧条目与 pi.system
   *   模型侧簿记一律 404（helm.rewind 标记本身保留可见，与分页行为同构）；
   * - 未截断但已脱敏：仅剥离签名载荷，不截断。数据库原文不变。
   */
  async getConversationEntry(id: number, entryId: number): Promise<ConversationEntry> {
    if (!Number.isSafeInteger(entryId) || entryId <= 0) {
      throw new HelmError('validation_error', `entryId 需为安全正整数（收到 ${String(entryId)}）`, 400, {
        conversationId: id,
        entryId,
      })
    }
    this.host.getConversation(id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    const page = await conversation.entries(
      { minEntryId: entryId as never, maxEntryId: entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    const raw = page.items[0] as { id: number | string; kind: string } | undefined
    if (raw === undefined || Number(raw.id) !== entryId) {
      throw new HelmError('not_found', `条目 ${entryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId,
      })
    }
    // 可见性与详情分页完全一致：rewind 覆盖旧条目与 pi.system 模型侧簿记
    // 均不可见（分页隐藏的内部条目不因显式 id 请求重新暴露）。
    if (raw.kind === 'pi.system') {
      throw new HelmError('not_found', `条目 ${entryId} 是模型侧簿记（pi.system），不可见`, 404, {
        conversationId: id,
        entryId,
      })
    }
    const rewindCuts = await this.host.collectRewindIntervals(conversation)
    if (raw.kind !== 'helm.rewind' && coveredByRewind(entryId, rewindCuts)) {
      throw new HelmError('not_found', `条目 ${entryId} 已被原地覆盖重发隐藏`, 404, {
        conversationId: id,
        entryId,
      })
    }
    return stripEntrySignatures(toConversationEntry(raw as never))
  }

  /** SDK descending 分页读取 + rewind/pi.system 过滤（详情主体循环；每页精确取 remaining）。
   * pi.system 与 rewind 覆盖条目同属「不可见」：在循环内跳过并继续取更旧
   * 条目，保证 limit 语义 = 可见条数（收满后才过滤会让某页不足 limit 且
   * cursor 已越过被过滤条目，用户分页看不到等量旧内容）。 */
  async pageVisibleEntries(
    conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>>,
    id: number,
    limit: number,
    initialCursor: unknown,
    rewindCuts: RewindInterval[],
  ): Promise<{
    collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }>
    nextCursor: unknown
  }> {
    const collected: Array<{ id: number; kind: string; model?: readonly unknown[]; data?: unknown }> = []
    let sdkCursor = initialCursor
    let nextCursor: unknown = undefined
    for (;;) {
      const remaining = limit - collected.length
      const page = await conversation.entries(
        { order: 'descending' },
        remaining,
        sdkCursor as never,
        BACKGROUND_CONTEXT,
      )
      for (const raw of page.items as never as Array<{
        id: number
        kind: string
        model?: readonly unknown[]
        data?: unknown
      }>) {
        // rewind 标记自身保留（SSE 一致性与前端区间去重需要），其余落入
        // 覆盖区间的旧条目全部隐藏；pi.system 是模型侧簿记，详情不可见。
        const numericId = Number(raw.id)
        if (raw.kind === 'pi.system') continue
        if (raw.kind !== 'helm.rewind' && coveredByRewind(numericId, rewindCuts)) continue
        collected.push(raw)
      }
      if (page.next === undefined) {
        nextCursor = undefined
        break
      }
      if (collected.length >= limit) {
        nextCursor = page.next
        break
      }
      sdkCursor = page.next
    }
    void id
    return { collected, nextCursor }
  }

  /** 编码分页 cursor：base64url(JSON{conversationId,cursor})。 */
  encodeDetailCursor(conversationId: number, sdkCursor: Readonly<Record<string, unknown>>): string {
    const json = JSON.stringify({ conversationId, cursor: sdkCursor })
    return Buffer.from(json, 'utf8').toString('base64url')
  }

  /** 解码并校验分页 cursor：绑定会话、长度与 JSON 合法性（非法显式拒绝）。 */
  decodeDetailCursor(conversationId: number, encoded: string): unknown {
    if (encoded.length > DETAIL_CURSOR_MAX_LENGTH) {
      throw new HelmError('validation_error', 'cursor 超过最大长度', 400)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      throw new HelmError('validation_error', 'cursor 不是合法的 base64url JSON', 400)
    }
    const shape = decoded as { conversationId?: unknown; cursor?: unknown }
    if (
      shape === null ||
      typeof shape !== 'object' ||
      Number(shape.conversationId) !== conversationId ||
      typeof shape.cursor !== 'object' ||
      shape.cursor === null
    ) {
      throw new HelmError(
        'validation_error',
        `cursor 不属于会话 ${conversationId} 或结构非法`,
        400,
      )
    }
    return shape.cursor
  }

  /** FTS 重建（宿主 rebuildFts 委托；rewind 覆盖条目绝不重新索引）。 */
  async rebuildFts(listConversationIds: () => Array<{ id: number; title: string }>): Promise<void> {
    await this.host.store.rebuildFts(async (index) => {
      for (const conv of listConversationIds()) {
        const conversation = await this.host.harness.conversation(conv.id as never, BACKGROUND_CONTEXT)
        if (!conversation) continue
        // 全量扫描后按 helm.rewind 闭区间 [from, through] 过滤被覆盖条目：
        // 它们已不再活跃，重建 FTS 时绝不重新索引；同一区间公式与
        // collectRewindIntervals / 详情投影共用闭区间。
        const rewindCuts: RewindInterval[] = []
        const indexed: Array<{ id: number; text: string }> = []
        let cursor: unknown = undefined
        for (;;) {
          const page = await conversation.entries(
            { order: 'ascending' },
            50,
            cursor as never,
            BACKGROUND_CONTEXT,
          )
          for (const entry of page.items) {
            const record = entry as { id: number; kind: string; data?: unknown }
            if (record.kind === 'helm.rewind') {
              const interval = rewindIntervalOf(record)
              if (interval !== undefined) rewindCuts.push(interval)
              continue
            }
            const text = entryModelText(entry as never)
            if (text) indexed.push({ id: Number(record.id), text })
          }
          if (!page.next) break
          cursor = page.next
        }
        for (const item of indexed) {
          if (coveredByRewind(item.id, rewindCuts)) continue
          index(conv.id, `entry:${item.id}`, conv.title, this.host.stash.redact(item.text))
        }
      }
    })
  }
}
