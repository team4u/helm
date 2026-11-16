/**
 * `GET /api/events` SSE contract: a first-frame snapshot (or a resume frame
 * `resumed`) + a seq watermark, followed by the incremental event stream. Short
 * reconnects may carry `?afterSeq=<seq>&bootId=<bootId>` to resume: when both
 * credentials validate, the first frame becomes `resumed` and the gap frames are
 * replayed; across generations (server restart), out-of-range seq or a cache gap
 * always fall back to a full snapshot alignment — never a fake success across a gap.
 */

import type { AskSpec } from './ask.js'
import type { ConversationEntry, ConversationLive, ConversationSummary } from './conversation.js'
import type { NodeInfo } from './env-rpc.js'
import type { PluginSummary, PublicPluginDoc, PublicPluginSessionDoc } from './plugin-dto.js'
import type { PluginUiContribution } from './ui.js'

/** SSE global event sequence number (watermark). */
export type HelmEventSeq = number

/**
 * Server-side event generation identifier (randomly generated per EventHub
 * instance): seq is only contiguous and comparable within a generation; across
 * generations (server restart swaps the instance) a full snapshot is mandatory —
 * never resume on a bare seq.
 */
export type HelmBootId = string

/** Full snapshot read atomically at connection establishment (first frame `event: snapshot`). */
export interface HelmSnapshot {
  /** Current event generation: the client records it as one of its reconnect resume credentials. */
  bootId: HelmBootId
  seq: HelmEventSeq
  conversations: ConversationSummary[]
  /** Currently pending AskDocs (status = pending). */
  pendingAsks: AskSpec[]
  plugins: PluginSummary[]
  /** Public UI contributions of enabled plugins (all extension points). */
  ui: PluginUiContribution[]
  /** Public doc snapshot of enabled plugins (delivered in the first frame, avoiding extra fetches). */
  pluginDocs?: PublicPluginDoc[]
  /** Live views of active conversations (working/blocked runs or still-queued input; reconnect first frame restores the timeline tail pills). */
  conversationLives?: ConversationLive[]
  /** Known compute node list (including local and BYOM nodes). */
  nodes?: NodeInfo[]
}

/** Incremental event types (`event:` names); clients should preserve unknown types as-is. */
export type HelmEventType =
  | 'conversation.upsert'
  | 'conversation.deleted'
  | 'conversation.entry'
  | 'conversation.live'
  | 'ask.upsert'
  | 'ask.resolved'
  | 'plugin.changed'
  | 'plugin.doc.updated'
  | 'plugin.session_doc.updated'
  | 'models.changed'
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

/** A new timeline entry persisted. */
export interface ConversationEntryEvent {
  type: 'conversation.entry'
  conversationId: number
  entry: ConversationEntry
}

/** Conversation live increment (zero-token text and tool card state). */
export interface ConversationLiveEvent {
  type: 'conversation.live'
  live: ConversationLive
}

export interface AskUpsertEvent {
  type: 'ask.upsert'
  ask: AskSpec
}

/** AskDoc terminal transition (answered / cancelled / superseded). */
export interface AskResolvedEvent {
  type: 'ask.resolved'
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
}

export interface PluginChangedEvent {
  type: 'plugin.changed'
  plugin: PluginSummary
  /** The plugin's current UI contributions; empty on disable or uninstall, and clients replace its contributions accordingly. */
  ui: PluginUiContribution[]
}

/** Plugin public doc change (public doc only; per-value validated/redacted before publishing). */
export interface PluginDocUpdatedEvent {
  type: 'plugin.doc.updated'
  doc: PublicPluginDoc
}

/** SSE stream scoped to a specific session doc; never broadcast on /api/events. */
export interface PluginSessionDocUpdatedEvent {
  type: 'plugin.session_doc.updated'
  doc: PublicPluginSessionDoc
}

/** First frame of a session doc subscription; subsequent updates use HelmEventFrame. */
export interface PluginSessionDocSnapshot {
  seq: HelmEventSeq
  doc: PublicPluginSessionDoc
}

/** Model config or dynamic catalog updated; clients re-read the model and provider catalogs. */
export interface ModelsChangedEvent {
  type: 'models.changed'
  /** An empty list means the whole catalog; uses the EventHub generic payload envelope. */
  payload: { providers: string[] }
}

/** Compute node state change (online/offline/registered/removed). */
export interface NodeChangedEvent {
  type: 'node.changed'
  node: NodeInfo
  /** True when the node is removed from the Hub's issuance table; clients remove it from the known node list accordingly. */
  removed?: boolean
}

/** Human notification (e.g. Watchdog read-only diagnostic alerts). */
export interface NotificationEvent {
  type: 'notification'
  level: 'info' | 'warning' | 'error'
  title: string
  body?: string
  /** Related conversation, for click-through navigation. */
  conversationId?: number
}

/**
 * Plugin/workflow custom events (the non-core-type outlet of `ctx.host.emitEvent`).
 * The payload passes through verbatim (the host already unifies JSON validation and
 * redaction on the publishing side); type is any non-empty string that must not
 * collide with core types (the host validates at the boundary).
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
  | PluginSessionDocUpdatedEvent
  | ModelsChangedEvent
  | NodeChangedEvent
  | NotificationEvent
  | CustomHelmEvent

/** SSE incremental event frame: `data: JSON.stringify({ seq, event })`. */
export interface HelmEventFrame {
  seq: HelmEventSeq
  event: HelmEvent
}

/**
 * Resume control first frame (`event: resumed`): sent after both `?afterSeq` +
 * `?bootId` credentials validate; then the cached frames of `(afterSeq, headSeq]`
 * are replayed in seq order before the live increment continues. The client must
 * verify the bootId matches its own watermark and that it has caught up to headSeq
 * before considering itself live again.
 */
export interface HelmResumedFrame {
  /** The server's current event generation (matching the request; the server sends a snapshot instead when across generations). */
  bootId: HelmBootId
  /** The client watermark the server acknowledged for the resume (equal to the request's afterSeq). */
  seq: HelmEventSeq
  /** Server event head watermark sampled at connection time; the client is live only after replaying past this value. */
  headSeq: HelmEventSeq
}
