/**
 * `GET /api/events` SSE 契约：首帧 snapshot + seq 水位线，随后增量事件流。
 * 客户端断线重连后凭首帧 snapshot 自动对齐状态，绝不丢帧。
 */

import type { AskSpec } from './ask.js'
import type { ConversationSummary } from './conversation.js'
import type { PluginSummary } from './plugin.js'

/** SSE 全局事件序号（水位线）。 */
export type HelmEventSeq = number

/** 连接建立时原子读取的全量快照（首帧 `event: snapshot`）。 */
export interface HelmSnapshot {
  seq: HelmEventSeq
  conversations: ConversationSummary[]
  /** 当前待答 AskDoc（status = pending）。 */
  pendingAsks: AskSpec[]
  plugins: PluginSummary[]
}

/** 增量事件类型（`event:` 名）；未知类型客户端应原样保留。 */
export type HelmEventType =
  | 'conversation.upsert'
  | 'conversation.deleted'
  | 'ask.upsert'
  | 'ask.resolved'
  | 'plugin.changed'
  | 'notification'

export interface ConversationUpsertEvent {
  type: 'conversation.upsert'
  conversation: ConversationSummary
}

export interface ConversationDeletedEvent {
  type: 'conversation.deleted'
  conversationId: number
}

export interface AskUpsertEvent {
  type: 'ask.upsert'
  ask: AskSpec
}

/** AskDoc 终态流转（answered / cancelled / superseded）。 */
export interface AskResolvedEvent {
  type: 'ask.resolved'
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
}

export interface PluginChangedEvent {
  type: 'plugin.changed'
  plugin: PluginSummary
}

/** 人类通知（如 Watchdog 只读诊断告警）。 */
export interface NotificationEvent {
  type: 'notification'
  level: 'info' | 'warning' | 'error'
  title: string
  body?: string
  /** 关联会话，便于点击跳转。 */
  conversationId?: number
}

/**
 * 插件/工作流自定义事件（`ctx.host.emitEvent` 的非 core type 出口）。
 * payload 原样透传（宿主已在发布侧统一 JSON 校验与脱敏）；type 为任意非空字符串，
 * 不与六个 core 类型冲突（宿主在边界校验）。
 */
export interface CustomHelmEvent {
  type: string
  payload: unknown
}

export type HelmEvent =
  | ConversationUpsertEvent
  | ConversationDeletedEvent
  | AskUpsertEvent
  | AskResolvedEvent
  | PluginChangedEvent
  | NotificationEvent
  | CustomHelmEvent

/** SSE 增量事件帧：`data: JSON.stringify({ seq, event })`。 */
export interface HelmEventFrame {
  seq: HelmEventSeq
  event: HelmEvent
}
