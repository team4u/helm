/**
 * builtin:superagent Watchdog 会话活动统计（真实事件驱动；停用随订阅解除，无 timer）。
 *
 * - conversation.live：内核已按内容指纹去重（重复快照不发帧），此处再按
 *   「run 进度字段」（文本/思考/工具状态）过滤——仅 queuedInputs 变化的帧
 *   （排队胶囊出入队，非 run 进度）不刷新时钟，与原内核活动指纹同口径；
 * - conversation.upsert（status=working）：run 启动与 doing 语义翻转各恰一帧
 *   （内核按语义指纹去重）；这是首字前（纯 thinking 阶段）的唯一活动信号；
 * - conversation.deleted：统计彻底清理（目标消亡，无从停滞/失败）。载荷非法
 *   仅丢弃（不粗 as 信任）；残留统计随会话不再进入探针，无泄漏面；
 * - turn_settled（onTurnSettled）：回合终态即活动时钟终点；failed 递增、
 *   completed 归零、aborted 保持（非模型失败）。
 *
 * 绝不用每帧心跳假活动；重启后无活动记录时不报停滞（保守，不伪造时钟起点）。
 */

import type { ConversationSummary, HelmPluginContext, TurnOutcome } from '@helm/protocol'
import {
  asConversationDeletedEvent,
  asConversationLiveEvent,
  asConversationUpsertEvent,
} from './contracts.js'

export class ConversationActivityTracker {
  /** 会话 -> 最近一次真实活动时刻（内核事件权威时间戳；无记录不报停滞）。 */
  private readonly lastActivityAt = new Map<number, number>()
  /** 会话 -> 连续失败回合数（failed 递增，completed 归零，aborted 保持）。 */
  private readonly consecutiveErrorCounts = new Map<number, number>()
  /** 会话 -> 上次 live 帧的 run 进度指纹（重复帧不刷新时钟，防每帧心跳假活动）。 */
  private readonly liveProgressKeys = new Map<number, string>()

  /** 订阅真实事件（PluginHost 生命周期内自动随插件停用解除）。 */
  subscribe(ctx: HelmPluginContext): void {
    ctx.host.onEvent('conversation.live', (raw) => {
      const live = asConversationLiveEvent(raw)
      if (live === undefined) return
      const key = JSON.stringify([
        live.text,
        live.thinking ?? '',
        live.tools.map((t) => `${t.callId}:${t.status}`),
      ])
      if (this.liveProgressKeys.get(live.conversationId) === key) return
      this.liveProgressKeys.set(live.conversationId, key)
      this.lastActivityAt.set(live.conversationId, live.updatedAt)
    })

    ctx.host.onEvent('conversation.upsert', (raw) => {
      const conversation = asConversationUpsertEvent(raw)
      if (conversation === undefined) return
      if (conversation.status === 'working') {
        this.lastActivityAt.set(conversation.id, conversation.updatedAt)
      }
    })

    ctx.host.onEvent('conversation.deleted', (raw) => {
      const conversationId = asConversationDeletedEvent(raw)
      if (conversationId === undefined) return
      this.lastActivityAt.delete(conversationId)
      this.consecutiveErrorCounts.delete(conversationId)
      this.liveProgressKeys.delete(conversationId)
    })
  }

  /**
   * 活动事实：仅 working 会话报 stalledMs（空闲非停滞）；重启后无活动记录
   * 不伪造时钟起点（undefined，保守不报）。
   */
  activityOf(summary: ConversationSummary): {
    stalledMs?: number
    consecutiveErrors: number
  } {
    const consecutiveErrors = this.consecutiveErrorCounts.get(summary.id) ?? 0
    if (summary.status !== 'working') return { consecutiveErrors }
    const at = this.lastActivityAt.get(summary.id)
    if (at === undefined) return { consecutiveErrors }
    return { stalledMs: Date.now() - at, consecutiveErrors }
  }

  /** turn_settled 统计段（全部会话，先于自激过滤执行）。 */
  onTurnSettled(conversationId: number, outcome: TurnOutcome): void {
    this.lastActivityAt.delete(conversationId)
    this.liveProgressKeys.delete(conversationId)
    if (outcome === 'failed') {
      this.consecutiveErrorCounts.set(
        conversationId,
        (this.consecutiveErrorCounts.get(conversationId) ?? 0) + 1,
      )
    } else if (outcome === 'completed') {
      this.consecutiveErrorCounts.set(conversationId, 0)
    }
  }
}
