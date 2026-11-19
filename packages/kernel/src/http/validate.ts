/**
 * Boundary field validation: mechanical type/shape/unknown-field rules use TypeBox schemas
 * compiled via AJV (sharing @helmx/protocol's `validateOrThrow` cache used by plugin action inputs);
 * complex cross-field semantics, UTF-16 code-unit caps, trim rules, and path absoluteness remain
 * hand-written. Invalid input always fails with 400 validation_error.
 *
 * Never use `as` assertions as validation—type narrowing happens only after schema validation.
 */
import { Type, type Static, type TSchema } from 'typebox'
import {
  HelmxError,
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
  validateOrThrow,
  type ConversationInit,
  type ConversationPatch,
  type InputOrigin,
  type JsonSchema,
  type Profile,
  type ProfileRuntime,
  type ProfileStarterPrompt,
  type ProviderConfig,
  type WhenBusy,
} from '@helmx/protocol'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** Node ID rule (starts with an ASCII letter or digit; may contain . _ -, length 1..128). */
export const NODE_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
/** Safe positive integer upper bound: matches Number.isSafeInteger (schema integer does not check safe bounds). */
const MAX_SAFE_INTEGER = 9007199254740991
const MODEL_REF_PATTERN = /^[^/\s]+\/[^\s]+$/
const SKILL_ID_PATTERN_SOURCE = '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'
const RUNTIME_KIND_PATTERN_SOURCE = '^[a-z][a-z0-9_-]{0,31}$'
const THINKING_LEVELS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Reusable TypeBox schema primitives (valid JSON Schema consumed by @helmx/protocol's AJV validator).
const IdString = Type.String({ pattern: ID_PATTERN.source })
const NodeIdString = Type.String({ pattern: NODE_ID_PATTERN_SOURCE })
const NonEmptyString = Type.String({ minLength: 1 })
const SafePositiveInt = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER })
const SafeNonNegativeInt = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER })
const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS)

export class ValidationError extends HelmxError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details)
  }
}

/**
 * JSON Schema body validation: reuses @helmx/protocol's AJV wrapper (compiled schema cache,
 * $async rejection, field-path diagnostics) and translates failures into HTTP-boundary
 * ValidationError (same 400 validation_error contract; message includes instancePath, details
 * carries the AJV error list). Rejects non-plain class instances (e.g. Date/Map) that AJV
 * would otherwise treat as empty objects.
 */
export function assertBodySchema(schema: JsonSchema, value: unknown, what: string): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(`${what} must be a plain JSON object`)
    }
  }
  try {
    validateOrThrow(schema, value, what)
  } catch (error) {
    if (error instanceof HelmxError && error.code === 'validation_error') {
      const ajvErrors = (
        error.details as { errors?: Array<{ keyword?: string; params?: { additionalProperty?: unknown } }> } | undefined
      )?.errors
      const extras = ajvErrors
        ?.filter((e) => e.keyword === 'additionalProperties' && typeof e.params?.additionalProperty === 'string')
        .map((e) => String(e.params!.additionalProperty))
      const suffix = extras && extras.length > 0 ? ` (unsupported field(s): ${[...new Set(extras)].join(', ')})` : ''
      throw new ValidationError(`${error.message}${suffix}`, error.details)
    }
    throw error
  }
}

/** Validates `value` against a TypeBox schema via `assertBodySchema` and returns the narrowed type. */
function parseBodyWithSchema<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  assertBodySchema(schema as unknown as JsonSchema, value, what)
  return value as Static<T>
}

/** JSON Schema measures length in code points; these fields are capped in UTF-16 code units and must be checked separately. */
export function requireUtf16LengthAtMost(field: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new ValidationError(`${field} length must be <= ${maxLength}`)
  }
}

/**
 * Cross-platform absolute path check: POSIX `/`, Windows drive `^[a-zA-Z]:[\\/]` and UNC `^\\\\[^\\]+\\[^\\]+`.
 * Matches `isAbsoluteTargetPath` in runtime/tools.ts (the kernel evaluates remote/Windows target
 * path shape independently of the host OS).
 */
function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

/** Numeric ID in route path params: non-numeric values fail immediately with 400 before reaching services. */
export function parseIdParam(raw: string, field = 'id'): number {
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return n
}

/** Identifier param (askId / pluginId / actionId / runId / profileId / artifactId). */
export function requireIdParam(raw: string, field: string): string {
  if (!ID_PATTERN.test(raw)) {
    throw new ValidationError(`${field} must be a valid identifier (must start with an alphanumeric character and may contain . _ : -)`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// Conversation bodies (init / patch / input / ask / reset / compact / fork / withdraw)
// ---------------------------------------------------------------------------

const CONVERSATION_COMMON_PROPS = {
  title: Type.Optional(NonEmptyString),
  profileId: Type.Optional(IdString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  nodeId: Type.Optional(NodeIdString),
  cwd: Type.Optional(Type.String()),
}

const CONVERSATION_INIT_SCHEMA = Type.Object(
  {
    ...CONVERSATION_COMMON_PROPS,
    parentConversationId: Type.Optional(SafePositiveInt),
    model: Type.Optional(Type.String({ pattern: MODEL_REF_PATTERN.source })),
  },
  { additionalProperties: false },
)

const CONVERSATION_PATCH_SCHEMA = Type.Object(
  {
    ...CONVERSATION_COMMON_PROPS,
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    unread: Type.Optional(Type.Boolean()),
    pinned: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

function extractConversationCommon(
  parsed: Static<typeof CONVERSATION_INIT_SCHEMA> | Static<typeof CONVERSATION_PATCH_SCHEMA>,
): ConversationInit {
  if (parsed.title !== undefined) requireUtf16LengthAtMost('title', parsed.title, 200)
  if (parsed.tags !== undefined && parsed.tags.some((t) => t.length > 64)) {
    throw new ValidationError('each tags item must be 1-64 characters')
  }
  if (parsed.cwd !== undefined && !isCrossPlatformAbsolutePath(parsed.cwd)) {
    throw new ValidationError('cwd must be an absolute path (POSIX /..., Windows drive C:\\..., or UNC \\\\server\\share)')
  }
  return {
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.profileId !== undefined ? { profileId: parsed.profileId } : {}),
    ...(parsed.tags !== undefined ? { tags: [...parsed.tags] } : {}),
    ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
  }
}

export function parseConversationInit(body: Record<string, unknown>): ConversationInit {
  const parsed = parseBodyWithSchema(CONVERSATION_INIT_SCHEMA, body, 'conversation init body')
  const init = extractConversationCommon(parsed)
  if (parsed.parentConversationId !== undefined) init.parentConversationId = parsed.parentConversationId
  if (parsed.model !== undefined) init.model = parsed.model
  return init
}

export function parseConversationPatch(body: Record<string, unknown>): ConversationPatch {
  const parsed = parseBodyWithSchema(CONVERSATION_PATCH_SCHEMA, body, 'conversation patch body')
  const patch: ConversationPatch = extractConversationCommon(parsed)
  if (parsed.model !== undefined) {
    // PATCH-only semantics: '' = clear explicit override (recompute Profile/global inheritance chain);
    // create (parseConversationInit) still requires provider/model and rejects empty strings.
    if (parsed.model !== '' && !MODEL_REF_PATTERN.test(parsed.model)) {
      throw new ValidationError('model must be in provider/model format or an empty string (empty string clears override)')
    }
    patch.model = parsed.model
  }
  if (parsed.thinkingLevel !== undefined) patch.thinkingLevel = parsed.thinkingLevel
  if (parsed.unread !== undefined) patch.unread = parsed.unread
  if (parsed.pinned !== undefined) patch.pinned = parsed.pinned
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('PATCH body must contain at least one updatable field')
  }
  return patch
}

const INPUT_BODY_SCHEMA = Type.Object(
  {
    text: Type.String(),
    whenBusy: Type.Optional(Type.Enum(['steer', 'followUp', 'reject'] as const)),
    origin: Type.Optional(Type.Enum(['human', 'agent', 'trigger'] as const)),
    meta: Type.Optional(Type.Object({}, { additionalProperties: true })),
    attachments: Type.Optional(Type.Array(IdString)),
    replaceFromEntryId: Type.Optional(SafePositiveInt),
  },
  { additionalProperties: false },
)

export function parseInputBody(body: Record<string, unknown>): {
  text: string
  whenBusy?: WhenBusy
  origin?: InputOrigin
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
} {
  // Mechanical shape (text type, enums, attachment ID pattern, unknown fields) uses schema;
  // UTF-16 length cap on text, recursive JSON-safe check on meta, and attachment dedupe/empty-array
  // semantics are original business rules kept hand-written.
  const parsed = parseBodyWithSchema(INPUT_BODY_SCHEMA, body, 'input body')
  requireUtf16LengthAtMost('text', parsed.text, 512 * 1024)
  const meta = parseMetaObject(parsed.meta)
  const attachments = parseAttachmentIds(parsed.attachments)
  return {
    text: parsed.text,
    ...(parsed.whenBusy !== undefined ? { whenBusy: parsed.whenBusy } : {}),
    ...(parsed.origin !== undefined ? { origin: parsed.origin } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(parsed.replaceFromEntryId !== undefined ? { replaceFromEntryId: parsed.replaceFromEntryId } : {}),
  }
}

/** Attachment ID list: ID_PATTERN per item is enforced by schema; this only deduplicates and treats [] as omitted. */
function parseAttachmentIds(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = [...new Set(raw)]
  return ids.length > 0 ? ids : undefined
}

/** Plain JSON object validation (rejects non-object JSON such as arrays/scalars); validates values recursively for JSON-safety. */
function parseMetaObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('meta must be a JSON object')
  }
  assertJsonSafe('meta', raw as Record<string, unknown>)
  return structuredClone(raw) as Record<string, unknown>
}

/** Recursive JSON-safe check: rejects undefined, functions, symbols, bigints, and cycles at the boundary. */
function assertJsonSafe(path: string, value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new ValidationError(`${path} contains non-JSON value (${typeof value})`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(`${path}[${i}]`, item))
    return
  }
  if (typeof value === 'object') {
    // Reject prototype-polluted/class objects: accept only plain objects and safely cloned values
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(`${path} only accepts plain JSON objects`)
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(`${path}.${key}`, item)
    }
  }
}

const ASK_ANSWER_BODY_SCHEMA = Type.Object(
  {
    answers: Type.Object({}, { additionalProperties: Type.String() }),
    expectedStateSeq: Type.Optional(SafeNonNegativeInt),
  },
  { additionalProperties: false },
)

export function parseAskAnswerBody(body: Record<string, unknown>): {
  answers: Record<string, string>
  expectedStateSeq?: number
} {
  const parsed = parseBodyWithSchema(ASK_ANSWER_BODY_SCHEMA, body, 'ask answer body')
  return {
    answers: { ...(parsed.answers as Record<string, string>) },
    ...(parsed.expectedStateSeq !== undefined ? { expectedStateSeq: parsed.expectedStateSeq } : {}),
  }
}

const CONVERSATION_RESET_BODY_SCHEMA = Type.Object(
  { handoff: Type.Optional(Type.String()) },
  { additionalProperties: false },
)

/** POST /api/conversations/:id/reset: optional handoff text. */
export function parseConversationResetBody(body: Record<string, unknown>): { handoff?: string } {
  const parsed = parseBodyWithSchema(CONVERSATION_RESET_BODY_SCHEMA, body, 'reset body')
  if (parsed.handoff !== undefined) requireUtf16LengthAtMost('handoff', parsed.handoff, 512 * 1024)
  return parsed.handoff !== undefined ? { handoff: parsed.handoff } : {}
}

const CONVERSATION_COMPACT_BODY_SCHEMA = Type.Object(
  { instructions: Type.Optional(Type.String()) },
  { additionalProperties: false },
)

/** POST /api/conversations/:id/compact: optional instructions text. */
export function parseConversationCompactBody(body: Record<string, unknown>): { instructions?: string } {
  const parsed = parseBodyWithSchema(CONVERSATION_COMPACT_BODY_SCHEMA, body, 'compact body')
  if (parsed.instructions !== undefined) requireUtf16LengthAtMost('instructions', parsed.instructions, 512 * 1024)
  return parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}
}

const CONVERSATION_FORK_BODY_SCHEMA = Type.Object(
  {
    entryId: Type.Optional(SafePositiveInt),
    title: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
)

/** POST /api/conversations/:id/fork: entryId is an optional safe positive integer; title is optional 1..200 UTF-16 code units. */
export function parseConversationForkBody(body: Record<string, unknown>): { entryId?: number; title?: string } {
  const parsed = parseBodyWithSchema(CONVERSATION_FORK_BODY_SCHEMA, body, 'fork body')
  if (parsed.title !== undefined) requireUtf16LengthAtMost('title', parsed.title, 200)
  return {
    ...(parsed.entryId !== undefined ? { entryId: parsed.entryId } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  }
}

const CONVERSATION_WITHDRAW_BODY_SCHEMA = Type.Object(
  { submissionId: SafePositiveInt },
  { additionalProperties: false },
)

/** POST /api/conversations/:id/withdraw: submissionId is a required safe positive integer. */
export function parseConversationWithdrawBody(body: Record<string, unknown>): { submissionId: number } {
  const parsed = parseBodyWithSchema(CONVERSATION_WITHDRAW_BODY_SCHEMA, body, 'withdraw body')
  return { submissionId: parsed.submissionId }
}

// ---------------------------------------------------------------------------
// Profile body (TypeBox mechanical shape + cross-field / trim / code-point semantics)
// ---------------------------------------------------------------------------

const PROFILE_STARTER_SCHEMA = Type.Object(
  {
    label: Type.String(),
    prompt: Type.String(),
  },
  { additionalProperties: false },
)

const PROFILE_RUNTIME_SCHEMA = Type.Object(
  {
    // Kernel has zero hardcoded plugin enums: kind only checks the external runtime identifier format.
    kind: Type.String({ pattern: RUNTIME_KIND_PATTERN_SOURCE }),
    agent: NonEmptyString,
    args: Type.Optional(Type.Array(Type.String())),
    nodeId: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    env: Type.Optional(
      Type.Object({}, { propertyNames: NonEmptyString, additionalProperties: Type.String() }),
    ),
  },
  { additionalProperties: false },
)

const PROFILE_COMMON_PROPS = {
  name: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  nodeId: Type.Optional(NodeIdString),
  cwd: Type.Optional(NonEmptyString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  skills: Type.Optional(Type.Array(Type.String({ pattern: SKILL_ID_PATTERN_SOURCE }))),
  starters: Type.Optional(Type.Array(PROFILE_STARTER_SCHEMA)),
  runtime: Type.Optional(PROFILE_RUNTIME_SCHEMA),
  managedByPlugin: Type.Optional(Type.String()),
  humanSelectable: Type.Optional(Type.Boolean()),
  restrictToCwd: Type.Optional(Type.Boolean()),
  system: Type.Optional(Type.String()),
}

const PROFILE_CREATE_BODY_SCHEMA = Type.Object(
  { id: IdString, ...PROFILE_COMMON_PROPS },
  { additionalProperties: false },
)

const PROFILE_UPDATE_BODY_SCHEMA = Type.Object(
  { id: Type.Optional(IdString), ...PROFILE_COMMON_PROPS },
  { additionalProperties: false },
)

export function parseProfileBody(body: Record<string, unknown>, opts: { requireId: boolean }): Profile {
  const parsed = opts.requireId
    ? parseBodyWithSchema(PROFILE_CREATE_BODY_SCHEMA, body, 'profile body')
    : parseBodyWithSchema(PROFILE_UPDATE_BODY_SCHEMA, body, 'profile body')

  if (parsed.managedByPlugin !== undefined && parsed.managedByPlugin.trim() === '') {
    throw new ValidationError('managedByPlugin must be a non-empty plugin ID')
  }
  if (parsed.system !== undefined) {
    requireUtf16LengthAtMost('system', parsed.system, 512 * 1024)
  }
  if (parsed.model !== undefined && parsed.model !== '' && !MODEL_REF_PATTERN.test(parsed.model)) {
    throw new ValidationError('model must be in provider/model format or an empty string')
  }
  if (parsed.tags !== undefined && parsed.tags.some((t) => t.length > 64)) {
    throw new ValidationError('each tags item must be 1-64 characters')
  }

  const starters = normalizeProfileStarters(parsed.starters)
  const runtime = normalizeProfileRuntime(parsed.runtime)

  const profile: Profile = { ...(parsed.id !== undefined ? { id: parsed.id } : {}) } as Profile
  if (parsed.name !== undefined) profile.name = parsed.name
  if (parsed.model !== undefined && parsed.model !== '') profile.model = parsed.model
  if (parsed.thinkingLevel !== undefined && parsed.thinkingLevel !== '') profile.thinkingLevel = parsed.thinkingLevel
  if (parsed.nodeId !== undefined) profile.nodeId = parsed.nodeId
  if (parsed.cwd !== undefined) profile.cwd = parsed.cwd
  if (parsed.tags !== undefined) profile.tags = [...parsed.tags]
  if (runtime !== undefined) profile.runtime = runtime
  if (parsed.skills !== undefined) profile.skills = [...new Set(parsed.skills)]
  if (parsed.managedByPlugin !== undefined) profile.managedByPlugin = parsed.managedByPlugin
  if (parsed.humanSelectable !== undefined) profile.humanSelectable = parsed.humanSelectable
  if (parsed.restrictToCwd !== undefined) profile.restrictToCwd = parsed.restrictToCwd
  if (starters !== undefined) profile.starters = starters
  if (parsed.system !== undefined) profile.system = parsed.system
  return profile
}

function countCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * Profile starters semantic checks matching ProfileService.validateProfileInput:
 * max item count, label trimming, non-whitespace prompt, and Unicode code-point limits.
 */
function normalizeProfileStarters(
  raw: Array<Static<typeof PROFILE_STARTER_SCHEMA>> | undefined,
): ProfileStarterPrompt[] | undefined {
  if (raw === undefined) return undefined
  if (raw.length > PROFILE_STARTERS_MAX_ITEMS) {
    throw new ValidationError(`starters at most ${PROFILE_STARTERS_MAX_ITEMS} items`)
  }
  return raw.map((item, index) => {
    const trimmed = item.label.trim()
    if (countCodePoints(trimmed) === 0) {
      throw new ValidationError(`starters[${index}].label cannot be empty after trimming`)
    }
    if (countCodePoints(trimmed) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].label at most ${PROFILE_STARTER_LABEL_MAX_LENGTH} Unicode code points`)
    }
    if (item.prompt.trim() === '') {
      throw new ValidationError(`starters[${index}].prompt cannot be pure whitespace`)
    }
    if (countCodePoints(item.prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].prompt at most ${PROFILE_STARTER_PROMPT_MAX_LENGTH} Unicode code points`)
    }
    return { label: trimmed, prompt: item.prompt }
  })
}

function normalizeProfileRuntime(
  runtime: Static<typeof PROFILE_RUNTIME_SCHEMA> | undefined,
): ProfileRuntime | undefined {
  if (runtime === undefined) return undefined
  if (runtime.workspace !== undefined && !isCrossPlatformAbsolutePath(runtime.workspace)) {
    throw new ValidationError('runtime.workspace must be a cross-platform absolute path (POSIX /, Windows drive, or UNC)')
  }
  return {
    kind: runtime.kind,
    agent: runtime.agent,
    ...(runtime.args !== undefined ? { args: [...runtime.args] } : {}),
    ...(runtime.nodeId !== undefined ? { nodeId: runtime.nodeId } : {}),
    ...(runtime.workspace !== undefined ? { workspace: runtime.workspace } : {}),
    ...(runtime.env !== undefined ? { env: { ...(runtime.env as Record<string, string>) } } : {}),
  }
}

// ---------------------------------------------------------------------------
// providers / credentials / actions / plugin config bodies
// ---------------------------------------------------------------------------

const PROVIDERS_BODY_SCHEMA = Type.Object(
  {
    providers: Type.Array(
      Type.Object(
        {
          id: IdString,
          protocol: Type.Enum(['openai', 'anthropic'] as const),
          baseUrl: Type.String({ pattern: '^https?://' }),
          models: Type.Array(Type.String()),
          label: Type.Optional(Type.String()),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

/**
 * providers PUT body (object form): `{ providers: [...] }`. Array form is wrapped by the route layer
 * (`parseProvidersBodyValue`, preserving the CLI raw-array convention) before reusing this helper,
 * so both forms share the same per-item schema validation.
 */
export function parseProvidersBody(body: Record<string, unknown>): ProviderConfig[] {
  const parsed = parseBodyWithSchema(PROVIDERS_BODY_SCHEMA, body, 'providers body')
  return parsed.providers.map((p) => ({
    id: p.id,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    models: [...p.models],
    ...(p.label !== undefined ? { label: p.label } : {}),
    enabled: p.enabled,
  }))
}

const CREDENTIAL_BODY_SCHEMA = Type.Object(
  { value: NonEmptyString },
  { additionalProperties: false },
)

export function parseCredentialBody(body: Record<string, unknown>): string {
  const parsed = parseBodyWithSchema(CREDENTIAL_BODY_SCHEMA, body, 'credential body')
  requireUtf16LengthAtMost('value', parsed.value, 64 * 1024)
  return parsed.value
}

const ACTION_INVOKE_BODY_SCHEMA = Type.Object(
  {
    // input can be any JSON value (including null); only key presence is required.
    input: Type.Unknown(),
    conversationId: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)

export function parseActionInvokeBody(body: Record<string, unknown>): {
  input: unknown
  conversationId?: number
} {
  const parsed = parseBodyWithSchema(ACTION_INVOKE_BODY_SCHEMA, body, 'action invoke body')
  return {
    input: parsed.input,
    ...(parsed.conversationId !== undefined ? { conversationId: parsed.conversationId } : {}),
  }
}

const PLUGIN_CONFIG_BODY_SCHEMA = Type.Object(
  {
    values: Type.Object(
      {},
      { additionalProperties: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]) },
    ),
  },
  { additionalProperties: false },
)

export function parsePluginConfigBody(body: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseBodyWithSchema(PLUGIN_CONFIG_BODY_SCHEMA, body, 'plugin config body')
  return { ...(parsed.values as Record<string, unknown>) }
}

// ---------------------------------------------------------------------------
// Query parsing (GET /api/conversations/:id) & param validation
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 500

/** Conversation detail pagination params: limit must be a positive integer <= max; cursor must be a non-empty opaque string. */
export function parseDetailPagination(url: URL): { limit?: number; cursor?: string } {
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(Number(limitRaw)) || Number(limitRaw) < 1) {
      throw new ValidationError('limit must be a positive integer')
    }
    limit = Number(limitRaw)
    if (limit > MAX_PAGE_LIMIT) {
      throw new ValidationError(`limit must be <= ${MAX_PAGE_LIMIT}`)
    }
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  if (cursor !== undefined && cursor.length === 0) {
    throw new ValidationError('cursor must be a non-empty string')
  }
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) }
}

/** Plugin public doc name (GET /api/plugins/:id/docs/:name): identifier constraint matches doc declaration. */
export function parseDocNameParam(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new ValidationError('doc name must be a valid identifier (starts with an alphanumeric character, may contain . _ -)')
  }
  return raw
}
