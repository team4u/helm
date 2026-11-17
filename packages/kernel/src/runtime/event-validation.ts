/**
 * Event payload boundary validation (pure functions split out from events.ts for isolated unit testing).
 *
 * Discipline (original semantics preserved):
 * - Publish side performs unified JSON validation + redaction (both strings and keys are redacted); invalid payloads
 *   throw HelmError immediately without silent fallbacks. Core types accept either a raw payload or a full event envelope
 *   (e.g., PluginHost emitEvent('plugin.changed', {type, plugin})), unwrapping envelopes without double-nesting.
 *   Unknown event types pass through verbatim as CustomHelmEvent {type, payload} without masquerading as notifications.
 * - "May be omitted, must never be wrong": optional fields are validated whenever present and mismatched types
 *   likewise throw rather than being silently coerced (e.g., an invalid notification level never falls back to 'info').
 */

import { HelmError } from '@helm/protocol'
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CustomHelmEvent,
  HelmEvent,
  HelmSnapshot,
  NodeInfo,
  PublicPluginDoc,
  PublicPluginSessionDoc,
  SecretLifetime,
} from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { validateSecretLifetime } from '../services/secret-stash.js'

const CONVERSATION_STATUSES = new Set(['working', 'blocked', 'done', 'idle', 'error'])
const ASK_STATUSES = new Set(['pending', 'answered', 'cancelled', 'superseded'])
const ASK_FIELD_TYPES = new Set(['text', 'select', 'confirm'])

/**
 * Recursively strip optional fields whose value is undefined.
 * Recurses only into plain objects and arrays; all other values (including non-JSON types like Date/Map) are returned
 * verbatim so redactJsonValue rejects them explicitly at the JSON boundary without silent conversion.
 * Objects already on the active traversal path are returned verbatim (true cycles are caught explicitly by redactJsonValue
 * instead of triggering unbounded recursion here).
 */
export function pruneUndefined(value: unknown, visiting: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      return value.map((v) => pruneUndefined(v, visiting))
    } finally {
      visiting.delete(value)
    }
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (visiting.has(value)) return value
    visiting.add(value)
    try {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[k] = pruneUndefined(v, visiting)
      }
      return out
    } finally {
      visiting.delete(value)
    }
  }
  return value
}

/**
 * conversation.upsert payload validation: covers the core ConversationSummary fields read by consumers
 * (web live-state / cli / protocol types); optional fields are validated whenever present and fail on wrong types.
 */
function assertConversationSummaryShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'conversation.upsert requires a ConversationSummary-shaped conversation', 500)
  }
  const conv = value as Record<string, unknown>
  if (
    !Number.isInteger(conv['id']) ||
    typeof conv['title'] !== 'string' ||
    typeof conv['profileId'] !== 'string' ||
    !Array.isArray(conv['tags']) ||
    !conv['tags'].every((tag) => typeof tag === 'string') ||
    typeof conv['cwd'] !== 'string' ||
    typeof conv['model'] !== 'string' ||
    typeof conv['thinkingLevel'] !== 'string' ||
    !CONVERSATION_STATUSES.has(conv['status'] as string) ||
    !Number.isInteger(conv['stateChangeSeq']) ||
    !Number.isInteger(conv['completionSeq']) ||
    typeof conv['unread'] !== 'boolean' ||
    typeof conv['pinned'] !== 'boolean' ||
    !Number.isInteger(conv['pendingAskCount']) ||
    !Number.isFinite(conv['createdAt']) ||
    !Number.isFinite(conv['updatedAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert requires a ConversationSummary-shaped conversation (id/title/profileId/tags/cwd/model/thinkingLevel/status/stateChangeSeq/completionSeq/unread/pinned/pendingAskCount/createdAt/updatedAt)',
      500,
    )
  }
  if (
    (conv['parentConversationId'] !== undefined && !Number.isInteger(conv['parentConversationId'])) ||
    (conv['parentToolCallId'] !== undefined && typeof conv['parentToolCallId'] !== 'string') ||
    (conv['ownedBy'] !== undefined &&
      conv['ownedBy'] !== 'human' &&
      conv['ownedBy'] !== 'helm' &&
      conv['ownedBy'] !== 'bot') ||
    (conv['nodeId'] !== undefined && typeof conv['nodeId'] !== 'string') ||
    (conv['thinkingLevelOverride'] !== undefined && typeof conv['thinkingLevelOverride'] !== 'string') ||
    (conv['doing'] !== undefined && typeof conv['doing'] !== 'string') ||
    (conv['lastError'] !== undefined && typeof conv['lastError'] !== 'string') ||
    (conv['lastEntryId'] !== undefined &&
      (typeof conv['lastEntryId'] !== 'number' ||
        !Number.isSafeInteger(conv['lastEntryId']) ||
        conv['lastEntryId'] < 0)) ||
    (conv['contextUsage'] !== undefined && !isContextUsageShape(conv['contextUsage']))
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.upsert optional fields (parentConversationId/parentToolCallId/ownedBy/nodeId/thinkingLevelOverride/doing/lastError/lastEntryId/contextUsage) must have valid types when present',
      500,
    )
  }
}

/** contextUsage shape validation (optional fields must still be valid; contract narrows to tokens/contextWindow/compacting
 * with unknown keys rejected—no dead fields; null tokens means context unknown; throughput metrics stay out of usage and belong to optional plugin UI). */
function isContextUsageShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const usage = value as Record<string, unknown>
  if (
    !Object.keys(usage).every(
      (key) => key === 'tokens' || key === 'contextWindow' || key === 'compacting',
    )
  ) {
    return false
  }
  if (
    usage['tokens'] !== null &&
    (typeof usage['tokens'] !== 'number' || !Number.isFinite(usage['tokens']) || usage['tokens'] < 0)
  ) {
    return false
  }
  if (
    usage['contextWindow'] !== undefined &&
    (typeof usage['contextWindow'] !== 'number' ||
      !Number.isFinite(usage['contextWindow']) ||
      usage['contextWindow'] <= 0)
  ) {
    return false
  }
  if (usage['compacting'] !== undefined && typeof usage['compacting'] !== 'boolean') {
    return false
  }
  return true
}

/** Streaming generation shape for conversation.live (must be valid when present):
 * positive integer taskId / attempt (unforgeable identity); message.content is an array of constrained block shapes;
 * usage.output is a positive finite number. Invalid shapes are rejected without silent fallback. */
function isLiveGenerationShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const generation = value as Record<string, unknown>
  if (
    !Object.keys(generation).every(
      (key) => key === 'taskId' || key === 'attempt' || key === 'message',
    )
  ) {
    return false
  }
  if (
    typeof generation['taskId'] !== 'number' ||
    !Number.isInteger(generation['taskId']) ||
    generation['taskId'] <= 0
  ) {
    return false
  }
  if (
    typeof generation['attempt'] !== 'number' ||
    !Number.isInteger(generation['attempt']) ||
    generation['attempt'] <= 0
  ) {
    return false
  }
  const message = generation['message']
  if (message === undefined) return true
  if (message === null || typeof message !== 'object') return false
  const m = message as Record<string, unknown>
  if (!Object.keys(m).every((key) => key === 'content' || key === 'usage')) return false
  if (!Array.isArray(m['content'])) return false
  for (const block of m['content']) {
    if (block === null || typeof block !== 'object') return false
    const b = block as Record<string, unknown>
    if (b['type'] === 'text') {
      if (typeof b['text'] !== 'string' || !Object.keys(b).every((k) => k === 'type' || k === 'text')) return false
    } else if (b['type'] === 'thinking') {
      if (typeof b['thinking'] !== 'string' || !Object.keys(b).every((k) => k === 'type' || k === 'thinking')) return false
    } else if (b['type'] === 'toolCall') {
      if (
        typeof b['name'] !== 'string' ||
        !Object.keys(b).every((k) => k === 'type' || k === 'name' || k === 'arguments')
      ) {
        return false
      }
    } else {
      return false
    }
  }
  const usage = m['usage']
  if (usage === undefined) return true
  if (usage === null || typeof usage !== 'object') return false
  const u = usage as Record<string, unknown>
  if (!Object.keys(u).every((key) => key === 'output')) return false
  return typeof u['output'] === 'number' && Number.isFinite(u['output']) && u['output'] > 0
}

/** ask.upsert payload validation: core AskSpec shape (business rules are enforced by validateAskSpec in createAsk). */
function assertAskSpecShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'ask.upsert requires an AskSpec-shaped ask', 500)
  }
  const ask = value as Record<string, unknown>
  if (
    typeof ask['id'] !== 'string' ||
    ask['id'] === '' ||
    !Number.isInteger(ask['conversationId']) ||
    typeof ask['title'] !== 'string' ||
    ask['title'] === '' ||
    !Array.isArray(ask['fields']) ||
    ask['fields'].length === 0 ||
    !ASK_STATUSES.has(ask['status'] as string) ||
    !Number.isFinite(ask['createdAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'ask.upsert requires an AskSpec-shaped ask (id/conversationId/title/fields/status/createdAt)',
      500,
    )
  }
  for (const field of ask['fields']) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof (field as Record<string, unknown>)['name'] !== 'string' ||
      typeof (field as Record<string, unknown>)['label'] !== 'string' ||
      !ASK_FIELD_TYPES.has((field as Record<string, unknown>)['type'] as string)
    ) {
      throw new HelmError('invalid_event', 'ask.upsert field requires { name: string; label: string; type: text|select|confirm } shape', 500)
    }
    const f = field as Record<string, unknown>
    if (f['secretLifetime'] !== undefined) {
      if (f['secret'] !== true) throw new HelmError('invalid_event', 'ask.upsert secretLifetime is only allowed on secret fields', 500)
      try {
        validateSecretLifetime(f['secretLifetime'] as SecretLifetime, 'ask.upsert field.secretLifetime')
      } catch (error) {
        throw new HelmError('invalid_event', error instanceof Error ? error.message : 'ask.upsert field.secretLifetime has invalid format', 500)
      }
    }
    if (f['type'] === 'select' && (!Array.isArray(f['options']) || f['options'].length === 0)) {
      throw new HelmError('invalid_event', 'ask.upsert select field requires non-empty options (consistent with createAsk validation)', 500)
    }
    if (
      (f['options'] !== undefined &&
        (!Array.isArray(f['options']) ||
          !f['options'].every(
            (o) => o !== null && typeof o === 'object' && typeof (o as Record<string, unknown>)['label'] === 'string' && typeof (o as Record<string, unknown>)['value'] === 'string',
          ))) ||
      (f['secret'] !== undefined && typeof f['secret'] !== 'boolean') ||
      (f['required'] !== undefined && typeof f['required'] !== 'boolean')
    ) {
      throw new HelmError('invalid_event', 'ask.upsert field optional fields (options/secret/required) must have valid types when present', 500)
    }
  }
  if (
    (ask['ownerPluginId'] !== undefined && typeof ask['ownerPluginId'] !== 'string') ||
    (ask['description'] !== undefined && typeof ask['description'] !== 'string') ||
    (ask['expectedStateSeq'] !== undefined && !Number.isInteger(ask['expectedStateSeq']))
  ) {
    throw new HelmError('invalid_event', 'ask.upsert optional fields (ownerPluginId/description/expectedStateSeq) must have valid types when present', 500)
  }
}

/**
 * Assemble (type, payload) into a protocol HelmEvent; prunes optional undefined values first, then applies recursive
 * JSON redaction across both string values and keys. Core types accept a raw payload or a full event envelope;
 * unknown types pass through verbatim as CustomHelmEvent {type, payload} (never masquerading as notification);
 * any invalid JSON value (cycles, Date, Map, etc.) or mismatched core shape throws HelmError with no silent fallback or coercion.
 */
export function assembleHelmEvent(
  type: string,
  payload: unknown,
  redact: (text: string) => string,
): HelmEvent {
  if (typeof type !== 'string' || type.length === 0) {
    throw new HelmError('invalid_event', 'event type must be a non-empty string', 500)
  }
  const clean = pruneUndefined(payload, new WeakSet())
  const redacted = redactJsonValue(clean, (t) => redact(t))
  const record =
    redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : undefined

  // Full event envelope (payload already carries a matching type field): unwrap type-specific fields without double-nesting.
  const envelope = record !== undefined && record['type'] === type ? record : undefined

  switch (type) {
    case 'conversation.upsert': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversation = source?.['conversation'] ?? source
      assertConversationSummaryShape(conversation)
      return { type, conversation: conversation as ConversationSummary }
    }
    case 'conversation.deleted': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversationId = Number(source?.['conversationId'])
      if (!Number.isInteger(conversationId)) {
        throw new HelmError('invalid_event', 'conversation.deleted requires numeric conversationId', 500)
      }
      return { type, conversationId }
    }
    case 'conversation.entry': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversationId = Number(source?.['conversationId'])
      const entry = source?.['entry']
      if (!Number.isInteger(conversationId)) {
        throw new HelmError('invalid_event', 'conversation.entry requires numeric conversationId', 500)
      }
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { kind?: unknown }).kind !== 'string'
      ) {
        throw new HelmError(
          'invalid_event',
          'conversation.entry requires { id: string; kind: string; ... }-shaped entry',
          500,
        )
      }
      const taskId = (entry as { taskId?: unknown }).taskId
      if (
        taskId !== undefined &&
        (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0)
      ) {
        throw new HelmError('invalid_event', 'conversation.entry taskId must be a positive integer when present', 500)
      }
      return { type, conversationId, entry: entry as ConversationEntry }
    }
    case 'conversation.live': {
      // Transient live frames bypass EventHub.publish / seq / replay ring; callers must use publishTransientLive().
      throw new HelmError(
        'invalid_event',
        'conversation.live is transient and cannot enter the durable EventHub.publish stream (use publishTransientLive)',
        500,
      )
    }
    case 'ask.upsert': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const ask = source?.['ask'] ?? source
      assertAskSpecShape(ask)
      return { type, ask: ask as AskSpec }
    }
    case 'ask.resolved': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const askId = source?.['askId']
      const status = source?.['status']
      if (typeof askId !== 'string' || (status !== 'answered' && status !== 'cancelled' && status !== 'superseded')) {
        throw new HelmError('invalid_event', 'ask.resolved requires string askId and valid status', 500)
      }
      return { type, askId, status }
    }
    case 'plugin.changed': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const plugin = source?.['plugin']
      const ui = source?.['ui']
      if (
        plugin === null ||
        typeof plugin !== 'object' ||
        typeof (plugin as { id?: unknown }).id !== 'string' ||
        !Array.isArray(ui)
      ) {
        throw new HelmError(
          'invalid_event',
          'plugin.changed requires { plugin: PluginSummary; ui: PluginUiContribution[] } (ui is [] when disabled/uninstalled)',
          500,
        )
      }
      return { type, plugin: plugin as HelmSnapshot['plugins'][number], ui: ui as HelmSnapshot['ui'] }
    }
    case 'plugin.doc.updated': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const doc = source?.['doc']
      if (
        doc === null ||
        typeof doc !== 'object' ||
        typeof (doc as { pluginId?: unknown }).pluginId !== 'string' ||
        typeof (doc as { name?: unknown }).name !== 'string' ||
        !('value' in (doc as Record<string, unknown>))
      ) {
        throw new HelmError(
          'invalid_event',
          'plugin.doc.updated requires { pluginId: string; name: string; value }-shaped doc',
          500,
        )
      }
      return { type, doc: doc as PublicPluginDoc }
    }
    case 'plugin.session_doc.updated': {
      // Defensive rejection on the global stream: session doc events belong exclusively on the dedicated SessionDocEventHub stream;
      // routing them to the global broadcast violates the contract and fails explicitly rather than passing through (prevents write amplification).
      throw new HelmError(
        'invalid_event',
        'plugin.session_doc.updated cannot enter the global event stream (dedicated session-doc SSE stream only)',
        500,
      )
    }
    case 'node.changed': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const node = source?.['node']
      const removed = source?.['removed']
      if (
        node === null ||
        typeof node !== 'object' ||
        typeof (node as { id?: unknown }).id !== 'string' ||
        (node as { id?: unknown }).id === '' ||
        ((node as { kind?: unknown }).kind !== 'local' && (node as { kind?: unknown }).kind !== 'byom') ||
        typeof (node as { online?: unknown }).online !== 'boolean'
      ) {
        throw new HelmError(
          'invalid_event',
          "node.changed requires { node: { id: string; kind: 'local' | 'byom'; online: boolean; ... } } shape (removed optional)",
          500,
        )
      }
      if (removed !== undefined && typeof removed !== 'boolean') {
        throw new HelmError('invalid_event', 'node.changed removed must be a boolean when present', 500)
      }
      return {
        type,
        node: node as NodeInfo,
        ...(typeof removed === 'boolean' ? { removed } : {}),
      }
    }
    case 'notification': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const level = source?.['level']
      const title = source?.['title']
      const body = source?.['body']
      const conversationId = source?.['conversationId']
      if (level !== 'info' && level !== 'warning' && level !== 'error') {
        throw new HelmError('invalid_event', "notification requires level to be 'info' | 'warning' | 'error'", 500)
      }
      if (typeof title !== 'string' || title === '') {
        throw new HelmError('invalid_event', 'notification requires a non-empty string title', 500)
      }
      if (body !== undefined && typeof body !== 'string') {
        throw new HelmError('invalid_event', 'notification body must be a string when present', 500)
      }
      if (conversationId !== undefined && (typeof conversationId !== 'number' || !Number.isInteger(conversationId))) {
        throw new HelmError('invalid_event', 'notification conversationId must be an integer when present', 500)
      }
      return {
        type,
        level,
        title,
        ...(body !== undefined ? { body } : {}),
        ...(conversationId !== undefined ? { conversationId } : {}),
      }
    }
    default: {
      // CustomHelmEvent: pass unknown types through verbatim without masquerading as notifications.
      const custom: CustomHelmEvent = { type: String(type), payload: redacted }
      return custom
    }
  }
}

/**
 * Boundary validation for plugin.session_doc.updated payloads (used by SessionDocEventHub.dispatch):
 * shape gate first (never read fields if doc is null or non-object), then validate the triple
 * key and deleted constraint; returns the validated doc (redaction is handled by caller).
 */
export function assertSessionDocUpdateShape(payload: unknown): PublicPluginSessionDoc {
  const source = (payload ?? undefined) as { type?: unknown; doc?: unknown } | undefined
  const doc = source?.['doc']
  if (doc === null || typeof doc !== 'object') {
    throw new HelmError(
      'invalid_event',
      'plugin.session_doc.updated requires { pluginId: string; name: string; conversationId: number; value }-shaped doc',
      500,
    )
  }
  const record = doc as Record<string, unknown>
  const pluginId = record['pluginId']
  const name = record['name']
  const conversationId = record['conversationId']
  if (
    typeof pluginId !== 'string' ||
    pluginId === '' ||
    typeof name !== 'string' ||
    name === '' ||
    typeof conversationId !== 'number' ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0 ||
    !('value' in record)
  ) {
    throw new HelmError(
      'invalid_event',
      'plugin.session_doc.updated requires { pluginId: string; name: string; conversationId: number; value }-shaped doc',
      500,
    )
  }
  if (record['deleted'] !== undefined && record['deleted'] !== true) {
    throw new HelmError('invalid_event', 'plugin.session_doc.updated deleted must be true when present', 500)
  }
  return doc as PublicPluginSessionDoc
}

/**
 * Transient `conversation.live` boundary validation and secret redaction (shared by
 * `EventHub.publishTransientLive`). Prunes optional `undefined` fields, applies recursive
 * JSON redaction, and rejects malformed `ConversationLive` shapes without falling back.
 */
export function validateAndRedactConversationLive(
  payload: unknown,
  redact: (text: string) => string,
): ConversationLive {
  const clean = pruneUndefined(payload, new WeakSet())
  const redacted = redactJsonValue(clean, (t) => redact(t))
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
    throw new HelmError(
      'invalid_event',
      'conversation.live requires a { conversationId, text, tools, updatedAt }-shaped live payload',
      500,
    )
  }
  const live = redacted as Record<string, unknown>
  if (
    typeof live['conversationId'] !== 'number' ||
    !Number.isSafeInteger(live['conversationId']) ||
    live['conversationId'] <= 0 ||
    typeof live['text'] !== 'string' ||
    !Array.isArray(live['tools']) ||
    typeof live['updatedAt'] !== 'number' ||
    !Number.isFinite(live['updatedAt'])
  ) {
    throw new HelmError(
      'invalid_event',
      'conversation.live requires a { conversationId, text, tools, updatedAt }-shaped live payload',
      500,
    )
  }
  if (live['thinking'] !== undefined && typeof live['thinking'] !== 'string') {
    throw new HelmError('invalid_event', 'conversation.live thinking must be a string when present', 500)
  }
  if (live['queuedInputs'] !== undefined && !Array.isArray(live['queuedInputs'])) {
    throw new HelmError('invalid_event', 'conversation.live queuedInputs must be an array when present', 500)
  }
  const generation = live['generation']
  if (generation !== undefined && !isLiveGenerationShape(generation)) {
    throw new HelmError(
      'invalid_event',
      'conversation.live generation requires { taskId: positive integer, attempt: positive integer, message?: { content, usage? } } shape',
      500,
    )
  }
  return redacted as ConversationLive
}
