/**
 * `GET /api/events` SSE contract: a first-frame snapshot (or a resume frame
 * `resumed`) + a seq watermark, followed by the incremental event stream. Short
 * reconnects may carry `?afterSeq=<seq>&bootId=<bootId>` to resume: when both
 * credentials validate, the first frame becomes `resumed` and the gap frames are
 * replayed; across generations (server restart), out-of-range seq or a cache gap
 * always fall back to a full snapshot alignment — never a fake success across a gap.
 */

import type { AskSpec } from './ask.js'
import type { Profile } from './assets.js'
import type { ConversationEntry, ConversationLive, ConversationSummary } from './conversation.js'
import type { NodeInfo } from './env-rpc.js'
import { HelmxError } from './error.js'
import type { PluginSummary, PublicPluginDoc, PublicPluginSessionDoc } from './plugin-dto.js'
import type { PluginUiContribution } from './ui.js'

/** SSE global event sequence number (watermark). */
export type HelmxEventSeq = number

/**
 * Server-side event generation identifier (randomly generated per EventHub
 * instance): seq is only contiguous and comparable within a generation; across
 * generations (server restart swaps the instance) a full snapshot is mandatory —
 * never resume on a bare seq.
 */
export type HelmxBootId = string

/** Full snapshot read atomically at connection establishment (first frame `event: snapshot`). */
export interface HelmxSnapshot {
  /** Current event generation: the client records it as one of its reconnect resume credentials. */
  bootId: HelmxBootId
  seq: HelmxEventSeq
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

/**
 * Durable incremental event types (`event:` names); clients should preserve unknown types as-is.
 * Transient `conversation.live` updates use `HelmxTransientLiveFrame` directly and do not consume
 * `HelmxEventSeq` or enter the replay ring buffer.
 */
export type HelmxEventType =
  | 'conversation.upsert'
  | 'conversation.deleted'
  | 'conversation.entry'
  | 'ask.upsert'
  | 'ask.resolved'
  | 'plugin.changed'
  | 'plugin.doc.updated'
  | 'plugin.session_doc.updated'
  | 'models.changed'
  | 'node.changed'
  | 'profile.changed'
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

/**
 * Non-sequential transient conversation live frame (`event: conversation.live`,
 * `data: JSON.stringify({ live })`). Never advances `EventHub.seq` and never
 * enters the bounded replay ring buffer, preventing high-frequency streaming
 * updates from evicting durable events during short-disconnect resume.
 */
export interface HelmxTransientLiveFrame {
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

/** First frame of a session doc subscription; subsequent updates use HelmxEventFrame. */
export interface PluginSessionDocSnapshot {
  seq: HelmxEventSeq
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

/**
 * Profile created/updated/deleted (covers HTTP/CLI writes and plugin bootstrap):
 * clients re-read the profile catalog (sidebar role list, profile center).
 * On delete the payload carries the last known profile shape plus `removed: true`.
 */
export interface ProfileChangedEvent {
  type: 'profile.changed'
  profile: Profile
  /** True when the profile was deleted. */
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
export interface CustomHelmxEvent {
  type: string
  payload: unknown
}

export type HelmxEvent =
  | ConversationUpsertEvent
  | ConversationDeletedEvent
  | ConversationEntryEvent
  | AskUpsertEvent
  | AskResolvedEvent
  | PluginChangedEvent
  | PluginDocUpdatedEvent
  | PluginSessionDocUpdatedEvent
  | ModelsChangedEvent
  | NodeChangedEvent
  | ProfileChangedEvent
  | NotificationEvent
  | CustomHelmxEvent

/** SSE incremental event frame: `data: JSON.stringify({ seq, event })`. */
export interface HelmxEventFrame {
  seq: HelmxEventSeq
  event: HelmxEvent
}

/**
 * Resume control first frame (`event: resumed`): sent after both `?afterSeq` +
 * `?bootId` credentials validate; then the cached frames of `(afterSeq, headSeq]`
 * are replayed in seq order before the live increment continues. The client must
 * verify the bootId matches its own watermark and that it has caught up to headSeq
 * before considering itself live again.
 */
export interface HelmxResumedFrame {
  /** The server's current event generation (matching the request; the server sends a snapshot instead when across generations). */
  bootId: HelmxBootId
  /** The client watermark the server acknowledged for the resume (equal to the request's afterSeq). */
  seq: HelmxEventSeq
  /** Server event head watermark sampled at connection time; the client is live only after replaying past this value. */
  headSeq: HelmxEventSeq
  /**
   * Live views of active conversations (working/blocked runs or still-queued input)
   * sampled at resume time, reconciling transient `conversation.live` state that is
   * excluded from the durable replay ring buffer.
   */
  conversationLives?: ConversationLive[]
}

// ---------------------------------------------------------------------------
// Multiplexed SessionDoc SSE contract & `?sub=` query codec
// ---------------------------------------------------------------------------

/** Subscription tuple identifying one public plugin session doc stream. */
export interface SessionDocSubscription {
  pluginId: string
  name: string
  conversationId: number
}

/** Action carried by a multiplexed session-doc SSE frame. */
export type SessionDocMultiplexAction = 'snapshot' | 'updated' | 'deleted'

/**
 * Frame delivered over a multiplexed session-doc SSE stream: carries the target
 * subscription tuple (`pluginId`, `name`, `conversationId`), explicit action
 * (`snapshot` resets the per-tuple seq baseline; `updated` and `deleted` apply
 * monotonic updates, where `deleted` carries `doc.deleted === true` and
 * `doc.value` reset to the registered initial value), stream `seq`, and `doc`.
 */
export interface SessionDocMultiplexFrame extends SessionDocSubscription, PluginSessionDocSnapshot {
  action: SessionDocMultiplexAction
}

const SESSION_DOC_SUB_PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION_DOC_SUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SESSION_DOC_SUB_CONVERSATION_ID_PATTERN = /^[1-9]\d{0,15}$/
const SESSION_DOC_SUB_MAX_RAW_LENGTH = 274

function assertValidSessionDocSubscription(sub: SessionDocSubscription): void {
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) {
    throw new HelmxError('validation_error', 'session doc subscription must be an object', 400)
  }
  const { pluginId, name, conversationId } = sub
  if (
    typeof pluginId !== 'string' ||
    !SESSION_DOC_SUB_PLUGIN_ID_PATTERN.test(pluginId) ||
    pluginId.includes('..')
  ) {
    throw new HelmxError('validation_error', 'session doc subscription pluginId is invalid', 400)
  }
  if (
    typeof name !== 'string' ||
    !SESSION_DOC_SUB_NAME_PATTERN.test(name) ||
    name.includes('..')
  ) {
    throw new HelmxError('validation_error', 'session doc subscription name is invalid', 400)
  }
  if (
    typeof conversationId !== 'number' ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0
  ) {
    throw new HelmxError(
      'validation_error',
      'session doc subscription conversationId must be a positive safe integer',
      400,
    )
  }
}

/**
 * Encode a `SessionDocSubscription` into the canonical `?sub=<pluginId>/<name>/<conversationId>`
 * query parameter value shared by `@helmx/kernel` and `@helmx/web`. Strictly validates
 * all three fields and serializes nothing else, preventing parameter injection and token leakage.
 */
export function encodeSessionDocSubParam(sub: SessionDocSubscription): string {
  assertValidSessionDocSubscription(sub)
  return `${sub.pluginId}/${sub.name}/${sub.conversationId}`
}

/**
 * Parse and strictly validate a single `?sub=` query parameter value into a
 * `SessionDocSubscription`. Rejects malformed segment counts, invalid pluginId/name
 * characters, traversal (`..`), percent-escapes, whitespace, query/fragment delimiters,
 * and non-positive or unsafe conversation IDs without echoing raw input.
 */
export function parseSessionDocSubParam(raw: string): SessionDocSubscription {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > SESSION_DOC_SUB_MAX_RAW_LENGTH) {
    throw new HelmxError(
      'validation_error',
      'sub query parameter must be a non-empty string within length limit',
      400,
    )
  }
  const parts = raw.split('/')
  if (parts.length !== 3) {
    throw new HelmxError(
      'validation_error',
      'sub query parameter must have format <pluginId>/<name>/<conversationId>',
      400,
    )
  }
  const [pluginId, name, convRaw] = parts as [string, string, string]
  if (!SESSION_DOC_SUB_CONVERSATION_ID_PATTERN.test(convRaw)) {
    throw new HelmxError(
      'validation_error',
      'session doc subscription conversationId must be a positive safe integer',
      400,
    )
  }
  const conversationId = Number(convRaw)
  const sub: SessionDocSubscription = { pluginId, name, conversationId }
  assertValidSessionDocSubscription(sub)
  return sub
}
