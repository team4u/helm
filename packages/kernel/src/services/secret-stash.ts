/**
 * In-memory SecretStash: secrets live only in process memory and are never persisted to disk or injected into model context.
 * The model and durability layers only ever see `[REDACTED:stash:<uuid>]` placeholders.
 *
 * Lifecycle (stopping injection != stopping redaction):
 * - put supports optional SecretLifetime: once ttlMs expires or a scope 'turn' turn settles, the secret is removed from the
 *   active env bucket (envFor/has), while byUuid permanently retains the old value to keep redacting all outputs
 *   (including streaming across chunks); overwriting the same name likewise keeps redacting the previous value; only clear(conversationId)
 *   (conversation deletion or full reset) reclaims them.
 * - Lazy TTL evaluation: expiresAt is computed on put and checked against clock on read paths (envFor/has/stats),
 *   with no extra timers; clock is injectable (fake clocks in tests).
 * - turn scope attribution by creation settle sequence: put records the number of settled turns at that moment,
 *   and settleTurn advances the counter before clearing secrets created before the new counter—secrets registered during
 *   the active run belong to the current turn, while those registered after settlement (async approvals / late hooks) belong to the next turn and are never prematurely swept;
 *   idle never sweeps (no timers).
 * - Honest boundary: TTL / turn end cannot revoke environment variables already injected into already-started child processes;
 *   it only guarantees subsequent spawns will no longer inject them.
 *
 * addRedaction registers global value-based redaction (e.g. kernel-managed HELM_TOKEN): not an env var,
 * excluded from stats, and not cleared by clear(conversationId); multiple registrations for the same value stack
 * and redaction stops only once all handles are disposed; clear() removes everything including global redactions.
 *
 * Honest boundary (explicitly stated): stash cannot prevent shell commands or in-process plugin code from reading
 * process environment variables or memory—that is an inherent privilege of trusted code, and this module does not promise zero leakage.
 */
import { randomUUID } from 'node:crypto'
import { HelmError, type SecretLifetime } from '@helm/protocol'

export const REDACTED_PREFIX = '[REDACTED:stash:'
export const REDACTED_MARKER = '[REDACTED]'

/** TTL cap: 24 hours (safety upper bound to prevent accidental near-permanent TTL values). */
export const MAX_SECRET_TTL_MS = 24 * 60 * 60 * 1000

export interface StashedSecret {
  readonly conversationId: number
  readonly uuid: string
  readonly placeholder: string
  readonly value: string
  readonly name: string
  /** TTL expiration timestamp (epoch ms; computed on put using the injected clock and checked lazily on read paths). */
  readonly expiresAt?: number
  /** Creation settle sequence for scope 'turn' (settled turns completed when created; undefined = conversation-scoped). */
  readonly bornSettlement?: number
}

/** Valid environment variable name: starts with an ASCII letter or underscore, contains only alphanumerics and underscores, non-empty and bounded in length. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
}

/**
 * SecretLifetime boundary validation (shared by AskDoc spec and stash.put):
 * plain object allowing only ttlMs/scope keys (typos must be rejected explicitly rather than silently dropping TTL),
 * ttlMs must be a finite positive safe integer within the cap, and scope only allows the two enum values.
 */
export function validateSecretLifetime(lifetime: SecretLifetime, context: string): SecretLifetime {
  if (
    lifetime === null || typeof lifetime !== 'object' || Array.isArray(lifetime) ||
    (Object.getPrototypeOf(lifetime) !== Object.prototype && Object.getPrototypeOf(lifetime) !== null)
  ) {
    throw new HelmError('validation_error', `${context} must be an object (received ${typeof lifetime})`, 400)
  }
  const keys = Object.keys(lifetime)
  for (const key of keys) {
    if (key !== 'ttlMs' && key !== 'scope') {
      throw new HelmError('validation_error', `${context} contains unknown key '${key}' (only allows ttlMs / scope)`, 400, { key })
    }
  }
  const ttlMs = (lifetime as { ttlMs?: unknown }).ttlMs
  if (ttlMs !== undefined) {
    if (
      typeof ttlMs !== 'number' ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_SECRET_TTL_MS
    ) {
      throw new HelmError(
        'validation_error',
        `${context}.ttlMs must be a positive safe integer not exceeding ${MAX_SECRET_TTL_MS} (received ${String(ttlMs)})`,
        400,
        { ttlMs },
      )
    }
  }
  const scope = (lifetime as { scope?: unknown }).scope
  if (scope !== undefined && scope !== 'conversation' && scope !== 'turn') {
    throw new HelmError(
      'validation_error',
      `${context}.scope only allows 'conversation' | 'turn' (received ${String(scope)})`,
      400,
      { scope },
    )
  }
  return { ...(ttlMs !== undefined ? { ttlMs } : {}), ...(scope !== undefined ? { scope } : {}) } as SecretLifetime
}

/** Placeholder <-> text conversion helpers (reused by ArtifactService spill redaction). */
export function makePlaceholder(uuid: string): string {
  return `${REDACTED_PREFIX}${uuid}]`
}

export function parsePlaceholder(text: string): string | null {
  if (!text.startsWith(REDACTED_PREFIX) || !text.endsWith(']')) return null
  const uuid = text.slice(REDACTED_PREFIX.length, -1)
  return /^[0-9a-f-]{36}$/.test(uuid) ? uuid : null
}

export class SecretStash {
  /** key: conversationId -> envName -> secret. Isolated per conversation to prevent cross-conversation leakage. */
  private readonly byConversation = new Map<number, Map<string, StashedSecret>>()
  /** key: uuid -> secret (fast redact index; includes old values whose injection stopped—redaction never stops). */
  private readonly byUuid = new Map<string, StashedSecret>()
  /** conversation -> completed turn settlement count (baseline for turn-scoped creation sequence). */
  private readonly turnSettlements = new Map<number, number>()
  /** Global value-based redactions: value -> reference count (multiple registrations stack until all are disposed). */
  private readonly globalRedactions = new Map<string, number>()
  private redactionEpoch = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Store a secret and return a `[REDACTED:stash:<uuid>]` placeholder.
   * Repeated puts for the same (conversationId, name) overwrite the env var while retaining the old value for redaction.
   * Optional lifetime: ttlMs expiry / scope 'turn' settlement stops injection only; redaction continues.
   */
  put(conversationId: number, name: string, value: string, lifetime?: SecretLifetime): string {
    if (!isValidEnvName(name)) {
      throw new Error(`secret name must be a valid environment variable name: ${name}`)
    }
    const normalized = lifetime !== undefined ? validateSecretLifetime(lifetime, `lifetime of secret '${name}'`) : undefined
    let bucket = this.byConversation.get(conversationId)
    if (bucket === undefined) {
      bucket = new Map()
      this.byConversation.set(conversationId, bucket)
    }
    const uuid = randomUUID()
    const secret: StashedSecret = {
      conversationId,
      uuid,
      placeholder: makePlaceholder(uuid),
      value,
      name,
      ...(normalized?.ttlMs !== undefined ? { expiresAt: this.now() + normalized.ttlMs } : {}),
      ...(normalized?.scope === 'turn' ? { bornSettlement: this.turnSettlements.get(conversationId) ?? 0 } : {}),
    }
    bucket.set(name, secret)
    this.byUuid.set(uuid, secret)
    return secret.placeholder
  }

  /** Lazy TTL check: removes expired entry from the active bucket (byUuid keeps old values for redaction). */
  private isExpired(secret: StashedSecret): boolean {
    return secret.expiresAt !== undefined && this.now() >= secret.expiresAt
  }

  /**
   * Export all active secrets for the conversation as environment variables (for child process injection);
   * samples clock once per call so every entry is evaluated against the same instant (no mid-batch TTL drift),
   * and lazily reclaims expired entries. When names is provided, only those names are included (missing names are
   * silently skipped; callers decide existence checks from the returned keys).
   */
  envFor(conversationId: number, names?: readonly string[]): Record<string, string> {
    const now = this.now()
    const bucket = this.byConversation.get(conversationId)
    const env: Record<string, string> = {}
    if (bucket === undefined) return env
    for (const [name, secret] of bucket) {
      if (secret.expiresAt !== undefined && now >= secret.expiresAt) {
        bucket.delete(name)
        continue
      }
      if (names !== undefined && !names.includes(name)) continue
      // An env var name can legitimately be '__proto__'; define an own property instead of triggering Object.prototype setter.
      Object.defineProperty(env, name, { value: secret.value, enumerable: true, writable: true, configurable: true })
    }
    return env
  }

  /**
   * Turn settlement hook (unified for completed | failed | aborted): advances the settle counter first, then reclaims
   * turn-scoped secrets created before the new counter (byUuid retains old values for redaction). Turn secrets registered
   * after settlement get bornSettlement = new counter, belonging to the next turn and untouched by this sweep.
   */
  settleTurn(conversationId: number): void {
    const next = (this.turnSettlements.get(conversationId) ?? 0) + 1
    this.turnSettlements.set(conversationId, next)
    const bucket = this.byConversation.get(conversationId)
    if (bucket === undefined) return
    for (const [name, secret] of bucket) {
      if (secret.bornSettlement !== undefined && secret.bornSettlement < next) bucket.delete(name)
    }
  }

  /**
   * Register a global value-based redaction: redact() replaces this value with `[REDACTED]` (active across all conversations).
   * Not an env var, excluded from envFor/stats; the same value can be registered multiple times and stops being redacted
   * only once all returned disposers have been called.
   */
  addRedaction(value: string): () => void {
    if (typeof value !== 'string' || value === '') throw new Error('addRedaction requires a non-empty string')
    this.globalRedactions.set(value, (this.globalRedactions.get(value) ?? 0) + 1)
    const epoch = this.redactionEpoch
    let removed = false
    return () => {
      if (removed || epoch !== this.redactionEpoch) return
      removed = true
      const count = this.globalRedactions.get(value) ?? 0
      if (count <= 1) this.globalRedactions.delete(value)
      else this.globalRedactions.set(value, count - 1)
    }
  }

  /** Whether an active secret exists (isolated by conversation; false after lazy TTL eviction). */
  has(conversationId: number, name: string): boolean {
    const bucket = this.byConversation.get(conversationId)
    const secret = bucket?.get(name)
    if (secret === undefined) return false
    if (this.isExpired(secret)) {
      bucket!.delete(name)
      return false
    }
    return true
  }

  /** Replace registered secrets with placeholders; existing placeholders always stay redacted. */
  redact(text: string, conversationId?: number): string {
    const values = new Map<string, string>()
    // Global value redactions take precedence over stash placeholders so managed tokens and host secrets cannot be echoed in any conversation.
    for (const value of this.globalRedactions.keys()) {
      values.set(value, REDACTED_MARKER)
    }
    for (const secret of this.byUuid.values()) {
      if (secret.value && !values.has(secret.value) && (conversationId === undefined || secret.conversationId === conversationId)) {
        values.set(secret.value, secret.placeholder)
      }
    }
    if (values.size === 0) return text
    const escaped = [...values.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`\\[REDACTED(?::stash:[0-9a-f-]{36})?\\]|${escaped.join('|')}`, 'g')
    return text.replace(pattern, (value) => values.get(value) ?? value)
  }

  /** Streaming redaction: buffers only the longest suffix that could still complete a secret, avoiding splitting full matches on fixed boundaries. */
  createStreamingRedactor(): { push(text: string): string; flush(): string } {
    let pending = ''
    const prefixes = new Map<string, number[]>()
    const overlap = (value: string, text: string): number => {
      let prefix = prefixes.get(value)
      if (!prefix) {
        prefix = new Array<number>(value.length).fill(0)
        for (let i = 1, j = 0; i < value.length; i++) {
          while (j > 0 && value[i] !== value[j]) j = prefix[j - 1]!
          if (value[i] === value[j]) j++
          prefix[i] = j
        }
        prefixes.set(value, prefix)
      }
      let matched = 0
      const tail = text.slice(-Math.max(value.length - 1, 0))
      for (let index = 0; index < tail.length; index++) {
        const char = tail[index]!
        while (matched > 0 && char !== value[matched]) matched = prefix[matched - 1]!
        if (char === value[matched]) matched++
        if (matched === value.length) matched = prefix[matched - 1]!
      }
      return matched
    }
    return {
      push: (text) => {
        pending += text
        let keep = 0
        const values = new Set([...this.globalRedactions.keys(), ...[...this.byUuid.values()].map((secret) => secret.value)])
        for (const value of values) if (value) keep = Math.max(keep, overlap(value, pending))
        const last = pending.charCodeAt(pending.length - 1)
        if (last >= 0xd800 && last <= 0xdbff) keep = Math.max(keep, 1)
        let cut = pending.length - keep
        const escaped = [...values].filter(Boolean).sort((a, b) => b.length - a.length)
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        if (escaped.length) {
          const pattern = new RegExp(`\\[REDACTED(?::stash:[0-9a-f-]{36})?\\]|${escaped.join('|')}`, 'g')
          for (const match of pending.matchAll(pattern)) {
            if (match.index < cut && match.index + match[0].length > cut) { cut = match.index; break }
            if (match.index >= cut) break
          }
        }
        const safe = this.redact(pending.slice(0, cut))
        pending = pending.slice(cut)
        return safe
      },
      flush: () => {
        const safe = this.redact(pending)
        pending = ''
        return safe
      },
    }
  }

  /** Clear all secrets for the specified conversation (including old values kept for redaction); if omitted, clear the entire stash (including global redactions). */
  clear(conversationId?: number): void {
    if (conversationId === undefined) {
      this.byConversation.clear()
      this.byUuid.clear()
      this.turnSettlements.clear()
      this.globalRedactions.clear()
      this.redactionEpoch += 1
      return
    }
    for (const [uuid, secret] of this.byUuid) {
      if (secret.conversationId === conversationId) this.byUuid.delete(uuid)
    }
    this.byConversation.delete(conversationId)
    this.turnSettlements.delete(conversationId)
  }

  /** Debug stats: active conversation count and total active secrets (single clock sample; never outputs secret values). */
  stats(): { conversations: number; secrets: number } {
    const now = this.now()
    let secrets = 0
    for (const bucket of this.byConversation.values()) {
      for (const [name, secret] of bucket) {
        if (secret.expiresAt !== undefined && now >= secret.expiresAt) bucket.delete(name)
        else secrets += 1
      }
    }
    return { conversations: this.byConversation.size, secrets }
  }
}
