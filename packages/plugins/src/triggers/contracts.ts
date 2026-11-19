/**
 * builtin:triggers shared contracts: dependency ports, public doc shapes, and boundary validation.
 *
 * Design (§4.4):
 * - cron and webhook share one dispatchTrigger helper (target resolution in delivery.ts);
 * - The public doc stores metadata only (never the secret); the HMAC secret lands in credentials.json
 *   pluginSecrets['builtin:triggers']['webhook:<id>'] (0600, bound to this plugin's ID via
 *   ctx.host.secrets) and is globally redacted via secrets.addRedaction;
 * - Zero dependency injection at the composition layer: secrets / profiles / isClosing all consume
 *   the ctx.host public ports (HelmxHostApi) directly; no injected factory parameters.
 */
import { HelmxError, isJsonObject } from '@helmx/protocol'
import type { ConversationSummary } from '@helmx/protocol'

export const TRIGGERS_PLUGIN_ID = 'builtin:triggers'

/** The webhook secret's key name in credentials.json (inside the pluginSecrets namespace). */
export function webhookSecretKey(id: string): string {
  return `webhook:${id}`
}

/** Secret boundary validation: non-empty, length-capped, no control characters (an HMAC shared secret needs none). */
export function assertWebhookSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new HelmxError('validation_error', 'the webhook secret must not be empty', 400, {})
  }
  if (secret.length > 512) {
    throw new HelmxError('validation_error', `webhook secret too long (<=512 chars, got ${secret.length})`, 400, {})
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new HelmxError('validation_error', 'the webhook secret must not contain control characters', 400, {})
  }
  return secret
}

/** Trigger id: non-empty, length-capped, url-safe (shared by cron/webhook; allows a-z A-Z 0-9 _ -). */
export function assertTriggerId(kind: 'cron' | 'webhook', id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new HelmxError(
      'validation_error',
      `invalid ${kind} id (1..64 chars; only alphanumeric _ - allowed; got: ${JSON.stringify(id)})`,
      400,
      { kind, id: String(id) },
    )
  }
  return id
}

/** threadKey: 1..200 chars (consistent with the superagent subscription constraint). */
export function assertThreadKey(key: string): string {
  if (key.length === 0 || key.length > 200) {
    throw new HelmxError('validation_error', `invalid threadKey (1..200 chars, got ${key.length})`, 400, {})
  }
  return key
}

/** Description text cap (a doc readability boundary). */
export const MAX_DESCRIPTION = 500

export function assertDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION) {
    throw new HelmxError('validation_error', `description too long (<=${MAX_DESCRIPTION} chars)`, 400, {})
  }
  return description
}

/** Target-Profile existence port (the minimal face of ctx.host.profiles). */
export interface ProfileLookup {
  get(id: string): Promise<{ id: string } | undefined>
}

// ---------------------------------------------------------------------------
// Webhook public doc shape and boundary validation (no secret, metadata only)
// ---------------------------------------------------------------------------

export interface WebhookMeta {
  id: string
  /** Collaboration contract: a boolean expressing that the secret is configured (true); never the secret itself. */
  hasSecret: boolean
  description?: string
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  createdAt: number
}

export interface WebhooksDoc {
  webhooks: WebhookMeta[]
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

const docCorrupt = (detail: string): HelmxError =>
  new HelmxError('triggers_doc_corrupt', `plugin doc webhooks ${detail}`, 500, { pluginId: TRIGGERS_PLUGIN_ID })

function assertWebhookMeta(raw: unknown): void {
  if (!isJsonObject(raw)) throw docCorrupt('contains a non-object entry')
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) {
    throw docCorrupt(`invalid entry id: ${JSON.stringify(raw.id)}`)
  }
  // hasSecret contract: create writes true only; missing/false means an old dev doc or pollution --
  // the dev period has no old-doc compatibility, no migration; error explicitly (never silently backfill).
  if (raw.hasSecret !== true) {
    throw docCorrupt(`entry ${raw.id} is missing hasSecret: true (the doc expresses secret-configured as a boolean; old dev docs are incompatible, no migration)`)
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION)) {
    throw docCorrupt(`entry ${raw.id} description is not a string or exceeds ${MAX_DESCRIPTION} chars`)
  }
  if (raw.targetConversationId !== undefined && !isPosInt(raw.targetConversationId)) {
    throw docCorrupt(`entry ${raw.id} targetConversationId is not a positive integer`)
  }
  if (raw.targetProfileId !== undefined && (typeof raw.targetProfileId !== 'string' || raw.targetProfileId.length === 0 || raw.targetProfileId.length > 64)) {
    throw docCorrupt(`entry ${raw.id} targetProfileId is invalid (1..64 chars)`)
  }
  // Target mutual exclusion matches the creation-input contract (the delivery layer likewise rejects dual targets).
  if (raw.targetConversationId !== undefined && raw.targetProfileId !== undefined) {
    throw docCorrupt(`entry ${raw.id} must not carry both targetConversationId and targetProfileId`)
  }
  if (raw.threadKey !== undefined && (typeof raw.threadKey !== 'string' || raw.threadKey.length === 0 || raw.threadKey.length > 200)) {
    throw docCorrupt(`entry ${raw.id} threadKey is invalid (1..200 chars)`)
  }
  if (!isFiniteTime(raw.createdAt)) throw docCorrupt(`entry ${raw.id} createdAt is invalid`)
  // Secret red line: the doc never contains a secret field (validated on read; historical pollution errors explicitly)
  if ('secret' in raw) {
    throw docCorrupt(`entry ${raw.id} contains a secret field (the doc stores metadata only; secrets live in credentials.json)`)
  }
}

/** webhooks doc read-in boundary validation: corruption errors explicitly; never silently rebuilds. */
export function assertWebhooksDoc(value: unknown): WebhooksDoc {
  if (!isJsonObject(value) || !Array.isArray(value.webhooks)) {
    throw docCorrupt('invalid structure (expected { webhooks: [] })')
  }
  const seen = new Set<string>()
  for (const item of value.webhooks) {
    assertWebhookMeta(item)
    const id = (item as WebhookMeta).id
    if (seen.has(id)) throw docCorrupt(`duplicate entry id '${id}'`)
    seen.add(id)
  }
  return value as unknown as WebhooksDoc
}

/** Metadata redaction view: action/doc outputs strip through this uniformly (the current shape is the full set; the funnel anticipates future fields). */
export function webhookPublicMeta(meta: WebhookMeta): WebhookMeta {
  const { id, hasSecret, description, targetConversationId, targetProfileId, threadKey, createdAt } = meta
  return {
    id,
    hasSecret,
    ...(description !== undefined ? { description } : {}),
    ...(targetConversationId !== undefined ? { targetConversationId } : {}),
    ...(targetProfileId !== undefined ? { targetProfileId } : {}),
    ...(threadKey !== undefined ? { threadKey } : {}),
    createdAt,
  }
}

/** Conversation query port (the minimal face of ctx.host, for tests). */
export interface ConversationLookup {
  listConversations(filter?: { profileId?: string }): ConversationSummary[]
  getConversation(id: number): ConversationSummary
  createConversation(init: { title?: string; profileId?: string }): Promise<ConversationSummary>
}

/**
 * The host port face consumed by the delivery pure helper (explicit Pick semantics, not a cast bridge):
 * type-checked both by the call site (ctx.host passed inside definePlugin) and by test fixtures.
 */

