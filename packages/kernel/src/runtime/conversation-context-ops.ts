/**
 * 会话上下文操作模块：reset / compact / fork。
 *
 * 职责：
 * - 关停守卫与上下文前置校验；
 * - 会话上下文重置（reset，支持 handoff）；
 * - 会话历史手动压缩（compact，支持自定义 instructions）；
 * - 会话历史断点分叉（fork，继承源会话元数据并对齐模型）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SecretStash } from '../services/index.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import { requireConv } from './runtime-helpers.js'
import type { HelmStore } from './store.js'

export interface ConversationContextOpsHost {
  readonly harness: Harness
  readonly store: HelmStore
  readonly tracker: ConversationTracker
  readonly events: EventHub
  readonly stash: SecretStash
  readonly isClosed: () => boolean
  readonly alignConversationModel: (id: number) => Promise<void>
  readonly withOwnership: (summary: ConversationSummary) => ConversationSummary
}

export class ConversationContextOps {
  constructor(private readonly host: ConversationContextOpsHost) {}

  /** 内核关闭守卫（上下文操作共用）。 */
  assertOpen(): void {
    if (this.host.isClosed()) throw new HelmError('runtime_closed', '内核正在关闭，拒绝提交新输入', 503)
  }

  /** 取已存在的会话元数据与 SDK 句柄（不存在统一 404）。 */
  async conversationForContextOp(
    id: number,
  ): Promise<{ meta: NonNullable<ReturnType<HelmStore['getConv']>>; conversation: NonNullable<Awaited<ReturnType<Harness['conversation']>>> }> {
    const meta = requireConv(this.host.store, id)
    const conversation = await this.host.harness.conversation(id as never, BACKGROUND_CONTEXT)
    if (!conversation) throw new HelmError('not_found', `会话不存在：${id}`, 404)
    return { meta, conversation }
  }

  /** 重置会话上下文：SDK reset(handoff) 后推进 stateChangeSeq 并广播摘要。 */
  async resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeHandoff =
      opts?.handoff !== undefined && opts.handoff !== '' ? this.host.stash.redact(opts.handoff) : undefined
    await conversation.reset(safeHandoff, BACKGROUND_CONTEXT)
    this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return summary
  }

  /** 手动压缩：SDK compact(instructions) 返回后台任务 ID；返回 { taskId, conversation }。 */
  async compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<{ taskId: number; conversation: ConversationSummary }> {
    this.assertOpen()
    const { meta, conversation } = await this.conversationForContextOp(id)
    const safeInstructions =
      opts?.instructions !== undefined && opts.instructions !== ''
        ? this.host.stash.redact(opts.instructions)
        : undefined
    const taskId = await conversation.compact(safeInstructions, BACKGROUND_CONTEXT)
    this.host.store.upsertConv({ ...meta, stateChangeSeq: meta.stateChangeSeq + 1, updatedAt: Date.now() })
    const summary = this.host.tracker.summaryOf(id)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return { taskId: Number(taskId), conversation: summary }
  }

  /**
   * 从指定条目分叉新会话：SDK fork(entryId) 后登记 helm 镜像
   *（继承 profile/tags/cwd/model/override；父链指向源会话）并对齐模型。
   */
  async forkConversation(id: number, opts: { entryId: number; title?: string }): Promise<ConversationSummary> {
    this.assertOpen()
    if (!Number.isSafeInteger(opts.entryId) || opts.entryId <= 0) {
      throw new HelmError('validation_error', `entryId 需为安全正整数（收到 ${String(opts.entryId)}）`, 400, {
        entryId: opts.entryId,
      })
    }
    const { meta: sourceMeta, conversation: sourceConv } = await this.conversationForContextOp(id)
    // 条目存在性精确校验（min=max=entryId 取 1 条；不存在 404）。
    const page = await sourceConv.entries(
      { minEntryId: opts.entryId as never, maxEntryId: opts.entryId as never, order: 'ascending' },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    )
    if (page.items.length === 0 || (page.items[0] as { id: number }).id !== opts.entryId) {
      throw new HelmError('not_found', `条目 ${opts.entryId} 在会话 ${id} 中不存在`, 404, {
        conversationId: id,
        entryId: opts.entryId,
      })
    }
    const forked = await sourceConv.fork(
      opts.entryId as never,
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    )
    const newId = forked.id as number
    const now = Date.now()
    const baseTitle = sourceMeta.title !== '' ? sourceMeta.title : `会话 ${id}`
    const title =
      opts.title !== undefined && opts.title.trim() !== ''
        ? this.host.stash.redact(opts.title.trim())
        : `${baseTitle} (分叉)`
    this.host.store.upsertConv({
      id: newId,
      title,
      profileId: sourceMeta.profileId,
      tags: [...sourceMeta.tags],
      parentConversationId: id,
      nodeId: sourceMeta.nodeId ?? 'local',
      cwd: sourceMeta.cwd,
      model: sourceMeta.model,
      thinkingLevel: sourceMeta.thinkingLevel,
      thinkingLevelOverride: sourceMeta.thinkingLevelOverride,
      ...(sourceMeta.modelOverride !== undefined ? { modelOverride: sourceMeta.modelOverride } : {}),
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.host.alignConversationModel(newId)
    await this.host.tracker.observe(newId)
    const summary = this.host.tracker.summaryOf(newId)
    this.host.events.publish('conversation.upsert', this.host.withOwnership(summary))
    return summary
  }
}
