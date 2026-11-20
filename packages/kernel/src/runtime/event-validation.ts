/**
 * Event payload boundary validation (pure functions split out from events.ts for isolated unit testing).
 *
 * Discipline (original semantics preserved):
 * - Publish side performs unified JSON validation + redaction (both strings and keys are redacted); invalid payloads
 *   throw HelmxError immediately without silent fallbacks. Core types accept either a raw payload or a full event envelope
 *   (e.g., PluginHost emitEvent('plugin.changed', {type, plugin})), unwrapping envelopes without double-nesting.
 *   Unknown event types pass through verbatim as CustomHelmxEvent {type, payload} without masquerading as notifications.
 * - "May be omitted, must never be wrong": optional fields are validated whenever present via precompiled TypeBox
 *   schemas + explicit semantic checks and fail rather than being silently coerced.
 */
import { Type, type Static, type TSchema } from 'typebox'
import { Compile, type Validator } from 'typebox/compile'
import type { TLocalizedValidationError } from 'typebox/error'
import { HelmxError } from '@helmx/protocol'
import type {
  AskSpec,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  CustomHelmxEvent,
  HelmxEvent,
  HelmxSnapshot,
  NodeInfo,
  Profile,
  PublicPluginDoc,
  PublicPluginSessionDoc,
  SecretLifetime,
} from '@helmx/protocol'
import { redactJsonValue } from '../redact.js'
import { validateSecretLifetime } from '../services/secret-stash.js'

const NonEmptyString = Type.String({ minLength: 1 })
const SafePositiveInt = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const SafeNonNegativeInt = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

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

function formatTypeBoxErrors(errors: readonly TLocalizedValidationError[]): string {
  if (errors.length === 0) return 'invalid shape'
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`.trim())
    .join('; ')
}

function parseEventShape<T extends TSchema>(
  validator: Validator<Record<string, never>, T>,
  value: unknown,
  what: string,
): Static<T> {
  if (!validator.Check(value)) {
    throw new HelmxError('invalid_event', `${what}: ${formatTypeBoxErrors(validator.Errors(value))}`, 500)
  }
  return value as Static<T>
}

// ---------------------------------------------------------------------------
// Precompiled TypeBox event payload schemas
// ---------------------------------------------------------------------------

const CONTEXT_USAGE_SCHEMA = Type.Object(
  {
    tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    contextWindow: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    compacting: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const CONVERSATION_SUMMARY_SCHEMA = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  profileId: Type.String(),
  tags: Type.Array(Type.String()),
  cwd: Type.String(),
  model: Type.String(),
  thinkingLevel: Type.String(),
  status: Type.Enum(['working', 'blocked', 'done', 'idle', 'error'] as const),
  stateChangeSeq: Type.Integer(),
  completionSeq: Type.Integer(),
  unread: Type.Boolean(),
  pinned: Type.Boolean(),
  pendingAskCount: Type.Integer(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  parentConversationId: Type.Optional(Type.Integer()),
  parentToolCallId: Type.Optional(Type.String()),
  ownedBy: Type.Optional(Type.Enum(['human', 'helmx', 'bot'] as const)),
  nodeId: Type.Optional(Type.String()),
  thinkingLevelOverride: Type.Optional(Type.String()),
  doing: Type.Optional(Type.String()),
  lastError: Type.Optional(Type.String()),
  lastEntryId: Type.Optional(SafeNonNegativeInt),
  contextUsage: Type.Optional(CONTEXT_USAGE_SCHEMA),
})

const CONVERSATION_SUMMARY_CHECKER = Compile(CONVERSATION_SUMMARY_SCHEMA)

const LIVE_CONTENT_BLOCK_SCHEMA = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('thinking'), thinking: Type.String() }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('toolCall'), name: Type.String(), arguments: Type.Optional(Type.Unknown()) },
    { additionalProperties: false },
  ),
])

const LIVE_GENERATION_SCHEMA = Type.Object(
  {
    taskId: Type.Integer({ minimum: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    message: Type.Optional(
      Type.Object(
        {
          content: Type.Array(LIVE_CONTENT_BLOCK_SCHEMA),
          usage: Type.Optional(
            Type.Object({ output: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

const CONVERSATION_LIVE_CHECKER = Compile(
  Type.Object({
    conversationId: SafePositiveInt,
    text: Type.String(),
    tools: Type.Array(Type.Unknown()),
    updatedAt: Type.Number(),
    thinking: Type.Optional(Type.String()),
    queuedInputs: Type.Optional(Type.Array(Type.Unknown())),
    generation: Type.Optional(LIVE_GENERATION_SCHEMA),
  }),
)

const ASK_FIELD_SCHEMA = Type.Object({
  name: Type.String(),
  label: Type.String(),
  type: Type.Enum(['text', 'select', 'confirm'] as const),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))),
  secret: Type.Optional(Type.Boolean()),
  required: Type.Optional(Type.Boolean()),
  secretLifetime: Type.Optional(Type.Unknown()),
})

const ASK_SPEC_CHECKER = Compile(
  Type.Object({
    id: NonEmptyString,
    conversationId: Type.Integer(),
    title: NonEmptyString,
    fields: Type.Array(ASK_FIELD_SCHEMA, { minItems: 1 }),
    status: Type.Enum(['pending', 'answered', 'cancelled', 'superseded'] as const),
    createdAt: Type.Number(),
    ownerPluginId: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    expectedStateSeq: Type.Optional(Type.Integer()),
  }),
)

function assertAskSpecShape(value: unknown): AskSpec {
  const ask = parseEventShape(
    ASK_SPEC_CHECKER,
    value,
    'ask.upsert requires an AskSpec-shaped ask (id/conversationId/title/fields/status/createdAt)',
  )
  for (const field of ask.fields) {
    if (field.secretLifetime !== undefined) {
      if (field.secret !== true) {
        throw new HelmxError('invalid_event', 'ask.upsert secretLifetime is only allowed on secret fields', 500)
      }
      try {
        validateSecretLifetime(field.secretLifetime as SecretLifetime, 'ask.upsert field.secretLifetime')
      } catch (error) {
        throw new HelmxError(
          'invalid_event',
          error instanceof Error ? error.message : 'ask.upsert field.secretLifetime has invalid format',
          500,
        )
      }
    }
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      throw new HelmxError(
        'invalid_event',
        'ask.upsert select field requires non-empty options (consistent with createAsk validation)',
        500,
      )
    }
  }
  return ask as unknown as AskSpec
}

const CONVERSATION_DELETED_CHECKER = Compile(Type.Object({ conversationId: Type.Integer() }))

const CONVERSATION_ENTRY_CHECKER = Compile(
  Type.Object({
    conversationId: Type.Integer(),
    entry: Type.Object({
      id: Type.String(),
      kind: Type.String(),
      taskId: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  }),
)

const ASK_RESOLVED_CHECKER = Compile(
  Type.Object({
    askId: Type.String(),
    status: Type.Enum(['answered', 'cancelled', 'superseded'] as const),
  }),
)

const PLUGIN_CHANGED_CHECKER = Compile(
  Type.Object({
    plugin: Type.Object({ id: Type.String() }),
    ui: Type.Array(Type.Unknown()),
  }),
)

const PLUGIN_DOC_UPDATED_CHECKER = Compile(
  Type.Object({
    doc: Type.Object({
      pluginId: Type.String(),
      name: Type.String(),
      value: Type.Unknown(),
    }),
  }),
)

const NODE_CHANGED_CHECKER = Compile(
  Type.Object({
    node: Type.Object({
      id: NonEmptyString,
      kind: Type.Enum(['local', 'byom'] as const),
      online: Type.Boolean(),
    }),
    removed: Type.Optional(Type.Boolean()),
  }),
)

/**
 * profile.changed shape: the profile payload itself is normalized by ProfileService before publishing
 * (same discipline as plugin.changed's loose plugin object); the checker pins the identity field and
 * the optional scalar/array fields that clients rely on ("may be omitted, must never be wrong").
 */
const PROFILE_CHANGED_CHECKER = Compile(
  Type.Object({
    profile: Type.Object({
      id: NonEmptyString,
      name: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      nodeId: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      skills: Type.Optional(Type.Array(Type.String())),
      managedByPlugin: Type.Optional(Type.String()),
      humanSelectable: Type.Optional(Type.Boolean()),
      restrictToCwd: Type.Optional(Type.Boolean()),
    }),
    removed: Type.Optional(Type.Boolean()),
  }),
)

const NOTIFICATION_CHECKER = Compile(
  Type.Object({
    level: Type.Enum(['info', 'warning', 'error'] as const),
    title: NonEmptyString,
    body: Type.Optional(Type.String()),
    conversationId: Type.Optional(Type.Integer()),
    view: Type.Optional(NonEmptyString),
  }),
)

const SESSION_DOC_UPDATE_CHECKER = Compile(
  Type.Object({
    pluginId: NonEmptyString,
    name: NonEmptyString,
    conversationId: SafePositiveInt,
    value: Type.Unknown(),
    deleted: Type.Optional(Type.Literal(true)),
  }),
)

type CoreEventAssembler = (source: Record<string, unknown> | undefined) => HelmxEvent

/** Table-driven core event assemblers; custom/unknown event types pass through outside this table. */
const CORE_EVENT_ASSEMBLERS: Readonly<Record<string, CoreEventAssembler>> = {
  'conversation.upsert': (source) => {
    const conversation = parseEventShape(
      CONVERSATION_SUMMARY_CHECKER,
      source?.['conversation'] ?? source,
      'conversation.upsert requires a ConversationSummary-shaped conversation',
    )
    return { type: 'conversation.upsert', conversation: conversation as unknown as ConversationSummary }
  },
  'conversation.deleted': (source) => {
    const parsed = parseEventShape(
      CONVERSATION_DELETED_CHECKER,
      source,
      'conversation.deleted requires numeric conversationId',
    )
    return { type: 'conversation.deleted', conversationId: parsed.conversationId }
  },
  'conversation.entry': (source) => {
    const parsed = parseEventShape(
      CONVERSATION_ENTRY_CHECKER,
      source,
      'conversation.entry requires { conversationId: integer, entry: { id: string, kind: string, taskId?: positive integer } }',
    )
    return { type: 'conversation.entry', conversationId: parsed.conversationId, entry: parsed.entry as ConversationEntry }
  },
  'conversation.live': () => {
    // Transient live frames bypass EventHub.publish / seq / replay ring; callers must use publishTransientLive().
    throw new HelmxError(
      'invalid_event',
      'conversation.live is transient and cannot enter the durable EventHub.publish stream (use publishTransientLive)',
      500,
    )
  },
  'ask.upsert': (source) => ({
    type: 'ask.upsert',
    ask: assertAskSpecShape(source?.['ask'] ?? source),
  }),
  'ask.resolved': (source) => {
    const parsed = parseEventShape(ASK_RESOLVED_CHECKER, source, 'ask.resolved requires string askId and valid status')
    return { type: 'ask.resolved', askId: parsed.askId, status: parsed.status }
  },
  'plugin.changed': (source) => {
    const parsed = parseEventShape(
      PLUGIN_CHANGED_CHECKER,
      source,
      'plugin.changed requires { plugin: PluginSummary; ui: PluginUiContribution[] } (ui is [] when disabled/uninstalled)',
    )
    return {
      type: 'plugin.changed',
      plugin: parsed.plugin as HelmxSnapshot['plugins'][number],
      ui: parsed.ui as HelmxSnapshot['ui'],
    }
  },
  'plugin.doc.updated': (source) => {
    const parsed = parseEventShape(
      PLUGIN_DOC_UPDATED_CHECKER,
      source,
      'plugin.doc.updated requires { pluginId: string; name: string; value }-shaped doc',
    )
    return { type: 'plugin.doc.updated', doc: parsed.doc as PublicPluginDoc }
  },
  'plugin.session_doc.updated': () => {
    // Defensive rejection on the global stream: session doc events belong exclusively on SessionDocEventHub.
    throw new HelmxError(
      'invalid_event',
      'plugin.session_doc.updated cannot enter the global event stream (dedicated session-doc SSE stream only)',
      500,
    )
  },
  'node.changed': (source) => {
    const parsed = parseEventShape(
      NODE_CHANGED_CHECKER,
      source,
      "node.changed requires { node: { id: string; kind: 'local' | 'byom'; online: boolean }; removed?: boolean }",
    )
    return {
      type: 'node.changed',
      node: parsed.node as NodeInfo,
      ...(parsed.removed !== undefined ? { removed: parsed.removed } : {}),
    }
  },
  'profile.changed': (source) => {
    const parsed = parseEventShape(
      PROFILE_CHANGED_CHECKER,
      source,
      "profile.changed requires { profile: Profile (non-empty id); removed?: boolean }",
    )
    return {
      type: 'profile.changed',
      profile: parsed.profile as Profile,
      ...(parsed.removed !== undefined ? { removed: parsed.removed } : {}),
    }
  },
  notification: (source) => {
    const parsed = parseEventShape(
      NOTIFICATION_CHECKER,
      source,
      "notification requires { level: 'info' | 'warning' | 'error'; title: non-empty string; body?: string; conversationId?: integer; view?: non-empty string }",
    )
    return {
      type: 'notification',
      level: parsed.level,
      title: parsed.title,
      ...(parsed.body !== undefined ? { body: parsed.body } : {}),
      ...(parsed.conversationId !== undefined ? { conversationId: parsed.conversationId } : {}),
      ...(parsed.view !== undefined ? { view: parsed.view } : {}),
    }
  },
}

/**
 * Assemble (type, payload) into a protocol HelmxEvent; prunes optional undefined values first, then applies recursive
 * JSON redaction across both string values and keys. Core types accept a raw payload or a full event envelope;
 * unknown types pass through verbatim as CustomHelmxEvent {type, payload} (never masquerading as notification);
 * any invalid JSON value (cycles, Date, Map, etc.) or mismatched core shape throws HelmxError with no silent fallback or coercion.
 */
export function assembleHelmxEvent(
  type: string,
  payload: unknown,
  redact: (text: string) => string,
): HelmxEvent {
  if (typeof type !== 'string' || type.length === 0) {
    throw new HelmxError('invalid_event', 'event type must be a non-empty string', 500)
  }
  const clean = pruneUndefined(payload, new WeakSet())
  const redacted = redactJsonValue(clean, (t) => redact(t))
  const record =
    redacted !== null && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : undefined
  const envelope = record !== undefined && record['type'] === type ? record : undefined

  const assembler = Object.hasOwn(CORE_EVENT_ASSEMBLERS, type) ? CORE_EVENT_ASSEMBLERS[type] : undefined
  if (assembler !== undefined) {
    return assembler(envelope ?? record)
  }
  // CustomHelmxEvent: pass unknown types through verbatim without masquerading as notifications.
  const custom: CustomHelmxEvent = { type: String(type), payload: redacted }
  return custom
}

/**
 * Boundary validation for plugin.session_doc.updated payloads (used by SessionDocEventHub.dispatch):
 * validates the triple key and deleted constraint, returning the doc unchanged (redaction is handled by caller).
 */
export function assertSessionDocUpdateShape(payload: unknown): PublicPluginSessionDoc {
  const source = (payload ?? undefined) as { doc?: unknown } | undefined
  const doc = parseEventShape(
    SESSION_DOC_UPDATE_CHECKER,
    source?.['doc'],
    'plugin.session_doc.updated requires { pluginId: string; name: string; conversationId: number; value }-shaped doc',
  )
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
  const live = parseEventShape(
    CONVERSATION_LIVE_CHECKER,
    redacted,
    'conversation.live requires a { conversationId, text, tools, updatedAt, generation? }-shaped live payload',
  )
  return live as unknown as ConversationLive
}
