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
import type { ConversationDetail, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import { toConversationEntry } from './entries.js'
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

    const entries = collected
      .reverse()
      .map((raw) => toConversationEntry(raw as { id: number; kind: string }))
    return {
      ...summary,
      entries,
      ...(nextCursor !== undefined ? { nextCursor: this.encodeDetailCursor(id, nextCursor as Readonly<Record<string, unknown>>) } : {}),
    }
  }

  /** SDK descending 分页读取 + rewind 过滤（详情主体循环；每页精确取 remaining）。 */
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
        // 覆盖区间的旧条目全部隐藏。
        const numericId = Number(raw.id)
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
