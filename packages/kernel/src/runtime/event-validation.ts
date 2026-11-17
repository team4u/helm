/**
 * event payload boundary validate (pure function; self events.ts split out, can independent single test).
 *
 * discipline (migration before semantics original keep):
 * - publish side unify JSON validate + redaction (string and field name all redact),payload illegal
 *   directly throw HelmError, never static default fall back;core type reference also accept caller directly payload and
 *   complete event message seal (such as PluginHost emitEvent('plugin.changed', {type, plugin})),
 *   message seal only split package do not second embed set; unknown type away CustomHelmEvent {type, payload} original
 *   pass-through, does not pretend to be into notification;
 * - can missing cannot wrong: optional field store in i.e. validate, type do not symbol same throws, not silently fix correct
 *   (such as notification illegal level do not fold back 'info').
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
 * recursion remove value is undefined optional field.
 * only for plain object / array recursion; the rest value (contains Date/Map etc. illegal JSON value) original return,
 * by redactJsonValue in JSON boundary unify reject, does not static default convert.
 * already in access path on object original return (true loop to redactJsonValue explicit throws, do not in this in unbounded recursion).
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
 * conversation.upsert payload validate: event consumer (web live-state / cli / protocol type)
 * actual read ConversationSummary core field; optional field store in i.e. validate, type do not symbol same throws
 *(can missing cannot wrong).
 */
function assertConversationSummaryShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'conversation.upsert need to ConversationSummary shape conversation', 500)
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
      'conversation.upsert need to ConversationSummary shape conversation(id/title/profileId/tags/cwd/model/thinkingLevel/status/stateChangeSeq/completionSeq/unread/pinned/pendingAskCount/createdAt/updatedAt)',
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
      'conversation.upsert optional field (parentConversationId/parentToolCallId/ownedBy/nodeId/thinkingLevelOverride/doing/lastError/lastEntryId/contextUsage) store in when type must legal',
      500,
    )
  }
}

/** contextUsage shape validate (can missing cannot wrong; contract converge is tokens/contextWindow/compacting
 * three field, unknown field reject - - do not die field;tokens is null means context unknown; rate class
 * metric do not follow use amount carry, by optional plugin policy layer self row render). */
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

/** conversation.live through use streaming generation fact shape (can missing cannot wrong):
 * taskId / attempt positive integer (identity cannot fabricate);message.content is array and only contains
 * subject to limit chunk shape;usage.output correct finite count. illegal i.e. reject, not silently fall back. */
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

/** ask.upsert payload validate:AskSpec core field shape (business level rule by createAsk  validateAskSpec guard). */
function assertAskSpecShape(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    throw new HelmError('invalid_event', 'ask.upsert need to AskSpec shape ask', 500)
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
      'ask.upsert need to AskSpec shape ask(id/conversationId/title/fields/status/createdAt)',
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
      throw new HelmError('invalid_event', 'ask.upsert  field need to { name: string; label: string; type: text|select|confirm } shape', 500)
    }
    const f = field as Record<string, unknown>
    if (f['secretLifetime'] !== undefined) {
      if (f['secret'] !== true) throw new HelmError('invalid_event', 'ask.upsert  secretLifetime only allows used to secret field', 500)
      try {
        validateSecretLifetime(f['secretLifetime'] as SecretLifetime, 'ask.upsert field.secretLifetime')
      } catch (error) {
        throw new HelmError('invalid_event', error instanceof Error ? error.message : 'ask.upsert field.secretLifetime format invalid', 500)
      }
    }
    if (f['type'] === 'select' && (!Array.isArray(f['options']) || f['options'].length === 0)) {
      throw new HelmError('invalid_event', 'ask.upsert  select field need to non-empty options(and createAsk validate consistent)', 500)
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
      throw new HelmError('invalid_event', 'ask.upsert  field optional field (options/secret/required) store in when type must legal', 500)
    }
  }
  if (
    (ask['ownerPluginId'] !== undefined && typeof ask['ownerPluginId'] !== 'string') ||
    (ask['description'] !== undefined && typeof ask['description'] !== 'string') ||
    (ask['expectedStateSeq'] !== undefined && !Number.isInteger(ask['expectedStateSeq']))
  ) {
    throw new HelmError('invalid_event', 'ask.upsert optional field (ownerPluginId/description/expectedStateSeq) store in when type must legal', 500)
  }
}

/**
 *  (type, payload) group install is protocol HelmEvent; first prune optional undefined, again whole recursion
 * JSON redaction (string value and field name all redact).core type accept directly payload or complete
 * event message seal; unknown type away CustomHelmEvent {type, payload} original pass-through (do not fake report into
 * notification); any illegal JSON value (loop,Date,Map etc.) or core type field shape do not symbol
 * all throw HelmError not silently fall back, not silently fix correct.
 */
export function assembleHelmEvent(
  type: string,
  payload: unknown,
  redact: (text: string) => string,
): HelmEvent {
  if (typeof type !== 'string' || type.length === 0) {
    throw new HelmError('invalid_event', 'event type must be non-empty string', 500)
  }
  const clean = pruneUndefined(payload, new WeakSet())
  const redacted = redactJsonValue(clean, (t) => redact(t))
  const record =
    redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : undefined

  // complete event message seal (payload self carries same name type field): split package take each type dedicated belong field, do not second embed set.
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
        throw new HelmError('invalid_event', 'conversation.deleted need to number conversationId', 500)
      }
      return { type, conversationId }
    }
    case 'conversation.entry': {
      const source = (envelope ?? record) as Record<string, unknown> | undefined
      const conversationId = Number(source?.['conversationId'])
      const entry = source?.['entry']
      if (!Number.isInteger(conversationId)) {
        throw new HelmError('invalid_event', 'conversation.entry need to number conversationId', 500)
      }
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { kind?: unknown }).kind !== 'string'
      ) {
        throw new HelmError(
          'invalid_event',
          'conversation.entry need to { id: string; kind: string; ... } shape entry',
          500,
        )
      }
      const taskId = (entry as { taskId?: unknown }).taskId
      if (
        taskId !== undefined &&
        (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0)
      ) {
        throw new HelmError('invalid_event', 'conversation.entry  taskId must be positive integer (can missing cannot wrong)', 500)
      }
      return { type, conversationId, entry: entry as ConversationEntry }
    }
    case 'conversation.live': {
      // Transient live frames bypass EventHub.publish / seq / replay ring; callers must use publishTransientLive().
      throw new HelmError(
        'invalid_event',
        'conversation.live is transient and disallows entering durable EventHub.publish stream (use publishTransientLive)',
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
        throw new HelmError('invalid_event', 'ask.resolved need to string askId and legal status', 500)
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
          'plugin.changed need to { plugin: PluginSummary; ui: PluginUiContribution[] }(deactivate/unload when ui is empty array)',
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
          'plugin.doc.updated need to { pluginId: string; name: string; value } shape doc',
          500,
        )
      }
      return { type, doc: doc as PublicPluginDoc }
    }
    case 'plugin.session_doc.updated': {
      // global stream guard against defend reject: conversation document event only allows dedicated use stream (SessionDocEventHub),
      // mistakenly throw global broadcast belongs to contract violate about, explicit errors while is not fall back pass-through (guard against write put large regression).
      throw new HelmError(
        'invalid_event',
        'plugin.session_doc.updated disallows enter global event stream (only dedicated use conversation document SSE)',
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
          "node.changed need to { node: { id: string; kind: 'local' | 'byom'; online: boolean; ... } } shape (removed optional)",
          500,
        )
      }
      if (removed !== undefined && typeof removed !== 'boolean') {
        throw new HelmError('invalid_event', 'node.changed  removed if has must is boolean', 500)
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
        throw new HelmError('invalid_event', "notification need to level is 'info' | 'warning' | 'error'", 500)
      }
      if (typeof title !== 'string' || title === '') {
        throw new HelmError('invalid_event', 'notification need to title is non-empty string', 500)
      }
      if (body !== undefined && typeof body !== 'string') {
        throw new HelmError('invalid_event', 'notification  body if has must is string', 500)
      }
      if (conversationId !== undefined && (typeof conversationId !== 'number' || !Number.isInteger(conversationId))) {
        throw new HelmError('invalid_event', 'notification  conversationId if has must is integer', 500)
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
      // CustomHelmEvent: unknown type original pass-through, do not fake report into notification.
      const custom: CustomHelmEvent = { type: String(type), payload: redacted }
      return custom
    }
  }
}

/**
 * plugin.session_doc.updated payload boundary validate (SessionDocEventHub.dispatch use):
 * first do shape gate (doc is null/non- object when must not enter any field read), again validate three meta group
 * field and deleted constraint; return already verify doc(redaction by caller complete).
 */
export function assertSessionDocUpdateShape(payload: unknown): PublicPluginSessionDoc {
  const source = (payload ?? undefined) as { type?: unknown; doc?: unknown } | undefined
  const doc = source?.['doc']
  if (doc === null || typeof doc !== 'object') {
    throw new HelmError(
      'invalid_event',
      'plugin.session_doc.updated need to { pluginId: string; name: string; conversationId: number; value } shape doc',
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
      'plugin.session_doc.updated need to { pluginId: string; name: string; conversationId: number; value } shape doc',
      500,
    )
  }
  if (record['deleted'] !== undefined && record['deleted'] !== true) {
    throw new HelmError('invalid_event', 'plugin.session_doc.updated  deleted if has must is true', 500)
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
      'conversation.live need to { conversationId, text, tools, updatedAt } shape live',
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
      'conversation.live need to { conversationId, text, tools, updatedAt } shape live',
      500,
    )
  }
  if (live['thinking'] !== undefined && typeof live['thinking'] !== 'string') {
    throw new HelmError('invalid_event', 'conversation.live thinking must be string when present', 500)
  }
  if (live['queuedInputs'] !== undefined && !Array.isArray(live['queuedInputs'])) {
    throw new HelmError('invalid_event', 'conversation.live queuedInputs must be array when present', 500)
  }
  const generation = live['generation']
  if (generation !== undefined && !isLiveGenerationShape(generation)) {
    throw new HelmError(
      'invalid_event',
      'conversation.live  generation need to { taskId: positive integer, attempt: positive integer, message?: { content, usage? } } shape',
      500,
    )
  }
  return redacted as ConversationLive
}
