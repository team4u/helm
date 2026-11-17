/**
 * Boundary field validation: mechanical type/shape/unknown-field rules use JSON Schema
 * (AJV, sharing the @helm/protocol validator used by plugin action inputs); complex cross-field
 * semantics and per-item business assertions remain hand-written. Invalid input always fails
 * with 400 validation_error.
 *
 * Never use `as` assertions as validation—type narrowing after schema validation is documented
 * with its justification.
 */
import { HelmError, validateOrThrow, type JsonSchema } from '@helm/protocol'
import {
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
  type ProfileStarterPrompt,
} from '@helm/protocol'
import type {
  ConversationInit,
  ConversationPatch,
  InputOrigin,
  Profile,
  ProfileRuntime,
  ProviderConfig,
  WhenBusy,
} from '@helm/protocol'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** JSON Schema pattern form of ID_PATTERN (compiled by AJV as ECMA-262 with identical semantics). */
const ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
/** Node ID rule (starts with an ASCII letter or digit; may contain . _ -, length 1..128). */
export const NODE_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
/** Safe positive integer upper bound: matches Number.isSafeInteger (schema integer does not check safe bounds). */
const MAX_SAFE_INTEGER = 9007199254740991

export class ValidationError extends HelmError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details)
  }
}

/**
 * JSON Schema body validation: reuses @helm/protocol's AJV wrapper (compiled schema cache,
 * $async rejection, field-path diagnostics) and translates failures into HTTP-boundary
 * ValidationError (same 400 validation_error contract; message includes instancePath, details
 * carries the AJV error list). Schemas only check mechanical shape (types/lengths/enums/unknown
 * fields); semantic rules (cross-field exclusions, trim semantics, path absoluteness, etc.)
 * stay hand-written at callers.
 */
export function assertBodySchema(schema: JsonSchema, value: unknown, what: string): void {
  try {
    validateOrThrow(schema, value, what)
  } catch (error) {
    if (error instanceof HelmError && error.code === 'validation_error') {
      throw new ValidationError(error.message, error.details)
    }
    throw error
  }
}

/** JSON Schema measures length in code points; these fields are capped in UTF-16 code units and must be checked separately. */
export function requireUtf16LengthAtMost(field: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new ValidationError(`${field} length must be <= ${maxLength}`)
  }
}

export function requireString(body: Record<string, unknown>, field: string, opts?: { maxLength?: number; minLength?: number }): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`)
  }
  if (opts?.minLength !== undefined && value.length < opts.minLength) {
    throw new ValidationError(`${field} length must be >= ${opts.minLength}`)
  }
  if (opts?.maxLength !== undefined && value.length > opts.maxLength) {
    throw new ValidationError(`${field} length must be <= ${opts.maxLength}`)
  }
  return value
}

export function optionalString(body: Record<string, unknown>, field: string, opts?: { maxLength?: number; minLength?: number }): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined
  return requireString(body, field, opts)
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`)
  }
  return value
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`)
  }
  return value
}

export function optionalEnum<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be ${allowed.join(' | ')}`)
  }
  return value as T
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be a string array`)
  }
  return value as string[]
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

/**
 * Optional nodeId field: non-empty string matching node ID format (starts with alphanumeric, may contain . _ -).
 * Shared between conversation init/patch and Profile body (deduplicated from two copies).
 */
export function optionalNodeId(body: Record<string, unknown>): string | undefined {
  const value = body['nodeId']
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ValidationError('nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (starts with an alphanumeric character, may contain . _ -)')
  }
  return value
}

// ---------------------------------------------------------------------------
// Conversation bodies (init / patch / input / reset / compact / fork / withdraw)
// ---------------------------------------------------------------------------

/** Optional fields shared by init and patch (title/profileId/tags/nodeId/cwd follow identical rules; merged from two copies). */
function parseConversationCommonFields(body: Record<string, unknown>): ConversationInit {
  const out: ConversationInit = {}
  const title = optionalString(body, 'title', { maxLength: 200, minLength: 1 })
  if (title !== undefined) out.title = title
  const profileId = optionalString(body, 'profileId')
  if (profileId !== undefined) {
    if (!ID_PATTERN.test(profileId)) throw new ValidationError('profileId must be a valid identifier')
    out.profileId = profileId
  }
  const tags = optionalStringArray(body, 'tags')
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) {
      throw new ValidationError('each tags item must be 1-64 characters')
    }
    out.tags = tags
  }
  const nodeId = optionalNodeId(body)
  if (nodeId !== undefined) out.nodeId = nodeId
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined) {
    if (!isCrossPlatformAbsolutePath(cwd)) {
      throw new ValidationError('cwd must be an absolute path (POSIX /..., Windows drive C:\\..., or UNC \\\\server\\share)')
    }
    out.cwd = cwd
  }
  return out
}

export function parseConversationInit(body: Record<string, unknown>): ConversationInit {
  const init = parseConversationCommonFields(body)
  const parent = optionalNumber(body, 'parentConversationId')
  if (parent !== undefined) {
    if (!Number.isInteger(parent) || parent <= 0) {
      throw new ValidationError('parentConversationId must be a positive integer')
    }
    init.parentConversationId = parent
  }
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new ValidationError('model must be in provider/model format')
    init.model = model
  }
  rejectUnknownKeys(body, new Set([...Object.keys(init), 'nodeId']))
  return init
}

export function parseConversationPatch(body: Record<string, unknown>): ConversationPatch {
  const patch: ConversationPatch = parseConversationCommonFields(body)
  const model = optionalString(body, 'model')
  if (model !== undefined) {
    // PATCH-only semantics: '' = clear explicit override (recompute Profile/global inheritance chain);
    // create (parseConversationInit) still requires provider/model and rejects empty strings.
    if (model !== '' && !/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new ValidationError('model must be in provider/model format or an empty string (empty string clears override)')
    }
    patch.model = model
  }
  const thinkingLevel = optionalEnum(body, 'thinkingLevel', ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
  if (thinkingLevel !== undefined) patch.thinkingLevel = thinkingLevel
  const unread = optionalBoolean(body, 'unread')
  if (unread !== undefined) patch.unread = unread
  const pinned = optionalBoolean(body, 'pinned')
  if (pinned !== undefined) patch.pinned = pinned
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('PATCH body must contain at least one updatable field')
  }
  rejectUnknownKeys(body, new Set(['title', 'profileId', 'tags', 'nodeId', 'cwd', 'model', 'thinkingLevel', 'unread', 'pinned']))
  return patch
}

const INPUT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    whenBusy: { enum: ['steer', 'followUp', 'reject'] },
    origin: { enum: ['human', 'agent', 'trigger'] },
    meta: { type: 'object' },
    attachments: { type: 'array', items: { type: 'string', pattern: ID_PATTERN_SOURCE } },
    replaceFromEntryId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
  },
  required: ['text'],
  additionalProperties: false,
}

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
  assertBodySchema(INPUT_BODY_SCHEMA, body, 'input body')
  requireUtf16LengthAtMost('text', body.text as string, 512 * 1024)
  const meta = parseMetaObject(body.meta)
  const attachments = parseAttachmentIds(body.attachments)
  return {
    text: body.text as string,
    ...(body.whenBusy !== undefined ? { whenBusy: body.whenBusy as WhenBusy } : {}),
    ...(body.origin !== undefined ? { origin: body.origin as InputOrigin } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(body.replaceFromEntryId !== undefined ? { replaceFromEntryId: body.replaceFromEntryId as number } : {}),
  }
}

/** Attachment ID list: ID_PATTERN per item is enforced by schema; this only deduplicates and treats [] as omitted. */
function parseAttachmentIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = [...new Set(raw as string[])]
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

const ASK_ANSWER_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answers: { type: 'object', additionalProperties: { type: 'string' } },
    expectedStateSeq: { type: 'integer', minimum: 0 },
  },
  required: ['answers'],
  additionalProperties: false,
}

export function parseAskAnswerBody(body: Record<string, unknown>): {
  answers: Record<string, string>
  expectedStateSeq?: number
} {
  assertBodySchema(ASK_ANSWER_BODY_SCHEMA, body, 'ask answer body')
  return {
    answers: { ...(body.answers as Record<string, string>) },
    ...(body.expectedStateSeq !== undefined ? { expectedStateSeq: body.expectedStateSeq as number } : {}),
  }
}

// ---------------------------------------------------------------------------
// Conversation context operation bodies (reset / compact / fork / withdraw): pure mechanical shapes use schema
// ---------------------------------------------------------------------------

const CONVERSATION_RESET_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { handoff: { type: 'string' } },
  additionalProperties: false,
}

/** POST /api/conversations/:id/reset: optional handoff text. */
export function parseConversationResetBody(body: Record<string, unknown>): { handoff?: string } {
  assertBodySchema(CONVERSATION_RESET_BODY_SCHEMA, body, 'reset body')
  if (body.handoff !== undefined) requireUtf16LengthAtMost('handoff', body.handoff as string, 512 * 1024)
  return body.handoff !== undefined ? { handoff: body.handoff as string } : {}
}

const CONVERSATION_COMPACT_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { instructions: { type: 'string' } },
  additionalProperties: false,
}

/** POST /api/conversations/:id/compact: optional instructions text. */
export function parseConversationCompactBody(body: Record<string, unknown>): { instructions?: string } {
  assertBodySchema(CONVERSATION_COMPACT_BODY_SCHEMA, body, 'compact body')
  if (body.instructions !== undefined) requireUtf16LengthAtMost('instructions', body.instructions as string, 512 * 1024)
  return body.instructions !== undefined ? { instructions: body.instructions as string } : {}
}

const CONVERSATION_FORK_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entryId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
    title: { type: 'string', minLength: 1 },
  },
  required: ['entryId'],
  additionalProperties: false,
}

/** POST /api/conversations/:id/fork: entryId is a required safe positive integer; title is optional 1..200 UTF-16 code units. */
export function parseConversationForkBody(body: Record<string, unknown>): { entryId: number; title?: string } {
  assertBodySchema(CONVERSATION_FORK_BODY_SCHEMA, body, 'fork body')
  if (body.title !== undefined) requireUtf16LengthAtMost('title', body.title as string, 200)
  return {
    entryId: body.entryId as number,
    ...(body.title !== undefined ? { title: body.title as string } : {}),
  }
}

const CONVERSATION_WITHDRAW_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { submissionId: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER } },
  required: ['submissionId'],
  additionalProperties: false,
}

/** POST /api/conversations/:id/withdraw: submissionId is a required safe positive integer. */
export function parseConversationWithdrawBody(body: Record<string, unknown>): { submissionId: number } {
  assertBodySchema(CONVERSATION_WITHDRAW_BODY_SCHEMA, body, 'withdraw body')
  return { submissionId: body.submissionId as number }
}

// ---------------------------------------------------------------------------
// Profile body (heavy cross-field semantics, kept as hand-written validation)
// ---------------------------------------------------------------------------

export function parseProfileBody(body: Record<string, unknown>, opts: { requireId: boolean }): Profile {
  const id = opts.requireId ? requireValidId(body, 'id') : optionalValidId(body, 'id')
  const name = optionalString(body, 'name')
  const model = optionalString(body, 'model')
  const thinkingLevel = optionalEnum(body, 'thinkingLevel', ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
  const tags = optionalStringArray(body, 'tags')
  // Skill allowlist: string array of valid skill IDs, deduplicated; unknown or not-yet-installed IDs
  // are allowed on save (runtime skill directories may be installed later, matching ProfileService.validateProfileInput).
  const skillsRaw = optionalStringArray(body, 'skills')
  let skills: string[] | undefined
  if (skillsRaw !== undefined) {
    const seen = new Set<string>()
    for (const skillId of skillsRaw) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(skillId)) {
        throw new ValidationError(`each skills item must be a valid skill id (starts with an alphanumeric character, may contain . _ -, length 1-64): ${skillId}`)
      }
      seen.add(skillId)
    }
    skills = [...seen]
  }
  const runtime = parseProfileRuntime(body.runtime)
  const managedByPlugin = optionalString(body, 'managedByPlugin')
  if (managedByPlugin !== undefined && managedByPlugin.trim() === '') {
    throw new ValidationError('managedByPlugin must be a non-empty plugin ID')
  }
  const humanSelectable = optionalBoolean(body, 'humanSelectable')
  const starters = parseProfileStarters(body.starters)
  const system = optionalString(body, 'system', { maxLength: 512 * 1024 })
  rejectUnknownKeys(body, new Set(['id', 'name', 'model', 'thinkingLevel', 'nodeId', 'cwd', 'tags', 'skills', 'starters', 'runtime', 'managedByPlugin', 'humanSelectable', 'system']))
  const nodeId = optionalNodeId(body)
  const cwd = optionalString(body, 'cwd')
  if (cwd !== undefined && cwd.length === 0) throw new ValidationError('cwd must be a non-empty string')
  const profile: Profile = { ...(id !== undefined ? { id } : {}) } as Profile
  if (name !== undefined) profile.name = name
  if (model !== undefined) {
    if (model !== '' && !/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new ValidationError('model must be in provider/model format or an empty string')
    }
    if (model !== '') profile.model = model
  }
  if (thinkingLevel !== undefined && thinkingLevel !== '') profile.thinkingLevel = thinkingLevel
  if (nodeId !== undefined) profile.nodeId = nodeId
  if (cwd !== undefined) profile.cwd = cwd
  if (tags !== undefined) {
    if (tags.some((t) => t.length === 0 || t.length > 64)) throw new ValidationError('each tags item must be 1-64 characters')
    profile.tags = tags
  }
  if (runtime !== undefined) profile.runtime = runtime
  if (skills !== undefined) profile.skills = skills
  if (managedByPlugin !== undefined) profile.managedByPlugin = managedByPlugin
  if (humanSelectable !== undefined) profile.humanSelectable = humanSelectable
  if (starters !== undefined) profile.starters = starters
  if (system !== undefined) profile.system = system
  return profile
}

/**
 * Profile starters boundary validation, matching ProfileService.validateProfileInput
 * (never discard invalid items at the HTTP layer—the service layer rejects rather than mutates).
 */
function parseProfileStarters(raw: unknown): ProfileStarterPrompt[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new ValidationError('starters must be an array of { label, prompt } objects')
  if (raw.length > PROFILE_STARTERS_MAX_ITEMS) {
    throw new ValidationError(`starters at most ${PROFILE_STARTERS_MAX_ITEMS} items`)
  }
  const pointLength = (text: string): number => {
    let count = 0
    for (const _ of text) count += 1
    return count
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`starters[${index}] must be { label, prompt } object`)
    }
    if (Object.keys(item).some((key) => key !== 'label' && key !== 'prompt')) {
      throw new ValidationError(`starters[${index}] may only accept label and prompt fields`)
    }
    const { label, prompt } = item as Record<string, unknown>
    if (typeof label !== 'string') throw new ValidationError(`starters[${index}].label must be a string`)
    if (typeof prompt !== 'string') throw new ValidationError(`starters[${index}].prompt must be a string`)
    const trimmed = label.trim()
    if (pointLength(trimmed) === 0) throw new ValidationError(`starters[${index}].label cannot be empty after trimming`)
    if (pointLength(trimmed) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].label at most ${PROFILE_STARTER_LABEL_MAX_LENGTH} Unicode code points`)
    }
    if (prompt.trim() === '') throw new ValidationError(`starters[${index}].prompt cannot be pure whitespace`)
    if (pointLength(prompt) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
      throw new ValidationError(`starters[${index}].prompt at most ${PROFILE_STARTER_PROMPT_MAX_LENGTH} Unicode code points`)
    }
    return { label: trimmed, prompt }
  })
}

function parseProfileRuntime(raw: unknown): ProfileRuntime | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('runtime must be an object')
  }
  const runtime = raw as Record<string, unknown>
  rejectUnknownKeys(runtime, new Set(['kind', 'agent', 'args', 'nodeId', 'workspace', 'env']))
  // Kernel has zero hardcoded plugin enums: kind only checks the external runtime identifier format;
  // plugin takeover of specific runtimes is decided by the agent_spawn hook pipeline (matches services/profiles-skills.ts).
  if (
    typeof runtime.kind !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(runtime.kind)
  ) {
    throw new ValidationError('runtime.kind must be a valid external runtime identifier (starts with a lowercase letter, may contain a-z 0-9 _ -, length 1..32)')
  }
  if (typeof runtime.agent !== 'string' || runtime.agent.length === 0) {
    throw new ValidationError('runtime.agent must be a non-empty string')
  }
  const args = runtime.args
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    throw new ValidationError('runtime.args must be a string array')
  }
  // nodeId / workspace: non-empty string (omitted = unrestricted; empty string rejected)
  const nodeId = runtime.nodeId
  if (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId.length === 0)) {
    throw new ValidationError('runtime.nodeId must be a non-empty string')
  }
  const workspace = runtime.workspace
  if (workspace !== undefined) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new ValidationError('runtime.workspace must be a non-empty string')
    }
    if (!isCrossPlatformAbsolutePath(workspace)) {
      throw new ValidationError('runtime.workspace must be a cross-platform absolute path (POSIX /, Windows drive, or UNC)')
    }
  }
  // env: string -> string map; non-empty keys, all values must be strings
  const env = runtime.env
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new ValidationError('runtime.env must be a string map object')
    }
    for (const [key, value] of Object.entries(env)) {
      if (key.length === 0) throw new ValidationError('runtime.env key must be a non-empty string')
      if (typeof value !== 'string') throw new ValidationError(`runtime.env.${key} must be a string`)
    }
  }
  return {
    kind: runtime.kind as string,
    agent: runtime.agent,
    ...(args !== undefined ? { args } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(env !== undefined ? { env: { ...(env as Record<string, string>) } } : {}),
  }
}

function requireValidId(body: Record<string, unknown>, field: string): string {
  const id = requireString(body, field)
  if (!ID_PATTERN.test(id)) throw new ValidationError(`${field} must be a valid identifier`)
  return id
}

function optionalValidId(body: Record<string, unknown>, field: string): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined
  return requireValidId(body, field)
}

// ---------------------------------------------------------------------------
// providers / credentials / actions / plugin config bodies
// ---------------------------------------------------------------------------

const PROVIDERS_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: ID_PATTERN_SOURCE },
          protocol: { enum: ['openai', 'anthropic'] },
          baseUrl: { type: 'string', pattern: '^https?://' },
          models: { type: 'array', items: { type: 'string' } },
          label: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'protocol', 'baseUrl', 'models', 'enabled'],
        additionalProperties: false,
      },
    },
  },
  required: ['providers'],
  additionalProperties: false,
}

/**
 * providers PUT body (object form): `{ providers: [...] }`. Array form is wrapped by the route layer
 * (`parseProvidersBodyValue`, preserving the CLI raw-array convention) before reusing this helper,
 * so both forms share the same per-item schema validation.
 */
export function parseProvidersBody(body: Record<string, unknown>): ProviderConfig[] {
  assertBodySchema(PROVIDERS_BODY_SCHEMA, body, 'providers body')
  const items = body.providers as Record<string, unknown>[]
  return items.map((p) => ({
    id: p.id as string,
    protocol: p.protocol as 'openai' | 'anthropic',
    baseUrl: p.baseUrl as string,
    models: p.models as string[],
    ...(p.label !== undefined ? { label: p.label as string } : {}),
    enabled: p.enabled as boolean,
  }))
}

const CREDENTIAL_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { value: { type: 'string', minLength: 1 } },
  required: ['value'],
  additionalProperties: false,
}

export function parseCredentialBody(body: Record<string, unknown>): string {
  assertBodySchema(CREDENTIAL_BODY_SCHEMA, body, 'credential body')
  requireUtf16LengthAtMost('value', body.value as string, 64 * 1024)
  return body.value as string
}

const ACTION_INVOKE_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    // input can be any JSON value (including null); only key presence is required.
    input: true,
    conversationId: { type: 'integer', minimum: 1 },
  },
  required: ['input'],
  additionalProperties: false,
}

export function parseActionInvokeBody(body: Record<string, unknown>): {
  input: unknown
  conversationId?: number
} {
  assertBodySchema(ACTION_INVOKE_BODY_SCHEMA, body, 'action invoke body')
  return {
    input: body.input,
    ...(body.conversationId !== undefined ? { conversationId: body.conversationId as number } : {}),
  }
}

const PLUGIN_CONFIG_BODY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    values: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
  },
  required: ['values'],
  additionalProperties: false,
}

export function parsePluginConfigBody(body: Record<string, unknown>): Record<string, unknown> {
  assertBodySchema(PLUGIN_CONFIG_BODY_SCHEMA, body, 'plugin config body')
  return { ...(body.values as Record<string, unknown>) }
}

/** For hand-written composite validators (cross-field rules not covered by schema): reject unknown fields. */
export function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((k) => !allowed.has(k))
  if (unknown.length > 0) {
    throw new ValidationError(`unsupported field(s): ${unknown.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Query parsing (GET /api/conversations/:id)
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
