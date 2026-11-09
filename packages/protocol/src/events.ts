/**
 * `GET /api/events` SSE 契约：首帧 snapshot + seq 水位线，随后增量事件流。
 * 客户端断线重连后凭首帧 snapshot 自动对齐状态，绝不丢帧。
 */

import type { AskSpec } from './ask.js'
import type { ConversationEntry, ConversationLive, ConversationSummary } from './conversation.js'
import type { NodeInfo } from './env-rpc.js'
import type { PluginSummary, PublicPluginDoc } from './plugin.js'
import type { PluginUiContribution } from './ui.js'
import type { WorkflowRunSummary } from './workflow.js'

/** SSE 全局事件序号（水位线）。 */
export type HelmEventSeq = number

/** 连接建立时原子读取的全量快照（首帧 `event: snapshot`）。 */
export interface HelmSnapshot {
  seq: HelmEventSeq
  conversations: ConversationSummary[]
  /** 当前待答 AskDoc（status = pending）。 */
  pendingAsks: AskSpec[]
  plugins: PluginSummary[]
  /** 启用插件的公共 UI 贡献（全部扩展点）。 */
  ui: PluginUiContribution[]
  /** 已知工作流 run 摘要（含运行中与终态）。 */
  workflowRuns: WorkflowRunSummary[]
  /** 已启用插件的公共文档快照（首帧直投，免额外拉取）。 */
  pluginDocs?: PublicPluginDoc[]
  /** 活跃会话实时视图（working/blocked run 或仍有 queued 输入；重连首帧恢复时间线尾部胶囊）。 */
  conversationLives?: ConversationLive[]
  /** 已知计算节点列表（含 local 与 BYOM 节点）。 */
  nodes?: NodeInfo[]
}

/** 增量事件类型（`event:` 名）；未知类型客户端应原样保留。 */
export type HelmEventType =
  | 'conversation.upsert'
  | 'conversation.deleted'
  | 'conversation.entry'
  | 'conversation.live'
  | 'ask.upsert'
  | 'ask.resolved'
  | 'plugin.changed'
  | 'plugin.doc.updated'
  | 'models.changed'
  | 'workflow.updated'
  | 'node.changed'
  | 'notification'

export interface ConversationUpsertEvent {
  type: 'conversation.upsert'
  conversation: ConversationSummary
}

export interface ConversationDeletedEvent {
  type: 'conversation.deleted'
  conversationId: number
}

/** 新时间线条目落库。 */
export interface ConversationEntryEvent {
  type: 'conversation.entry'
  conversationId: number
  entry: ConversationEntry
}

/** 会话实时增量（零 Token 文本与工具卡状态）。 */
export interface ConversationLiveEvent {
  type: 'conversation.live'
  live: ConversationLive
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
  /** 该插件当前的 UI 贡献；停用或卸载时为空，客户端据此替换其贡献。 */
  ui: PluginUiContribution[]
}

/** 插件公共文档变更（仅 public doc；发布前已逐值校验/脱敏）。 */
export interface PluginDocUpdatedEvent {
  type: 'plugin.doc.updated'
  doc: PublicPluginDoc
}

/** 模型配置或动态目录已更新；客户端重新读取模型与供应商目录。 */
export interface ModelsChangedEvent {
  type: 'models.changed'
  /** 空列表表示整个目录；采用 EventHub 通用 payload 信封。 */
  payload: { providers: string[] }
}

/** 工作流 run 状态/节点更新（含终态）。 */
export interface WorkflowUpdatedEvent {
  type: 'workflow.updated'
  run: WorkflowRunSummary
}

/** 计算节点状态变更（上线/离线/注册/移除）。 */
export interface NodeChangedEvent {
  type: 'node.changed'
  node: NodeInfo
  /** 当节点从 Hub 签发表移除时为 true，客户端据此从已知节点列表中移除该项。 */
  removed?: boolean
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
 * 不与 core 类型冲突（宿主在边界校验）。
 */
export interface CustomHelmEvent {
  type: string
  payload: unknown
}

export type HelmEvent =
  | ConversationUpsertEvent
  | ConversationDeletedEvent
  | ConversationEntryEvent
  | ConversationLiveEvent
  | AskUpsertEvent
  | AskResolvedEvent
  | PluginChangedEvent
  | PluginDocUpdatedEvent
  | ModelsChangedEvent
  | WorkflowUpdatedEvent
  | NodeChangedEvent
  | NotificationEvent
  | CustomHelmEvent

/** SSE 增量事件帧：`data: JSON.stringify({ seq, event })`。 */
export interface HelmEventFrame {
  seq: HelmEventSeq
  event: HelmEvent
}
