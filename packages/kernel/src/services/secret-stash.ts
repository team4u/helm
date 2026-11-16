/**
 * in-memory SecretStash: secret only store in process memory, never, never enter model context.
 * model and durable layer only see to `[REDACTED:stash:<uuid>]` placeholder.
 *
 * lifecycle (stop inject != stop redaction):
 * - put optional SecretLifetime:ttlMs expires or scope 'turn' turn compute after, secret from
 *   active env bucket(envFor/has) remove, but byUuid forever long keep old value used to all output
 *   redaction (contains across chunk streaming); same name override old value same continue redaction; only clear(conversationId)
 *   (conversation delete/all clean) only then reclaim;
 * - TTL lazy decide:put when compute expiresAt, read path (envFor/has/stats) for table clock,
 *   do not set extra timer;clock can inject (test use fake clock);
 * - turn effect domain by out generate compute order precise ownership:put record when when completed turn compute count,
 *   settleTurn first push enter counter again clear out generate order less than new counter secret - -run store continue phase register
 *   belong this turn, compute after register (async approval persisted/late hook) belong under one turn, never mistakenly scan;
 * idle do not clean scan (without timer);
 * - honest boundary:TTL/turn end cannot from already start child process withdraw back already inject environment variable,
 *   only guarantee after continue spawn no longer inject.
 *
 * addRedaction register global one by one value redaction (such as kernel managed HELM_TOKEN): non- environment variable,
 * do not count stats, do not follow clear(conversationId) clear; multiple register can stack put the same value,
 * all solve except after only then stop redaction;clear() all clean when one and remove.
 *
 * honest boundary (such as declaration):stash cannot guard against defend same process inside shell command and plugin code
 * read environment variable or process memory - - that is can message code solid has permission, this module does not promise zero leak leak.
 */
import { randomUUID } from 'node:crypto'
import { HelmError, type SecretLifetime } from '@helm/protocol'

export const REDACTED_PREFIX = '[REDACTED:stash:'
export const REDACTED_MARKER = '[REDACTED]'

/** TTL cap:24 small when (security cap, guard against manually slide config into forever however phase amount level). */
export const MAX_SECRET_TTL_MS = 24 * 60 * 60 * 1000

export interface StashedSecret {
  readonly conversationId: number
  readonly uuid: string
  readonly placeholder: string
  readonly value: string
  readonly name: string
  /** TTL expires moment (epoch ms;put when by inject clock compute out, read path lazy decide). */
  readonly expiresAt?: number
  /** scope 'turn' out generate compute order (when when completed turn compute count;undefined = conversation level). */
  readonly bornSettlement?: number
}

/** legal environment variable name: character parent or underscore open head, only character parent number underscore, non-empty and do not too long. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
}

/**
 * SecretLifetime boundary validate (AskDoc spec and stash.put shared use):
 * flat side object, only allows ttlMs/scope two key (piece together write wrong leak must explicit reject while non- static default without TTL),
 * ttlMs is finite correct safe integer and do not over cap,scope only two kinds of enumeration.
 */
export function validateSecretLifetime(lifetime: SecretLifetime, context: string): SecretLifetime {
  if (
    lifetime === null || typeof lifetime !== 'object' || Array.isArray(lifetime) ||
    (Object.getPrototypeOf(lifetime) !== Object.prototype && Object.getPrototypeOf(lifetime) !== null)
  ) {
    throw new HelmError('validation_error', `${context} must be an object (receives ${typeof lifetime})`, 400)
  }
  const keys = Object.keys(lifetime)
  for (const key of keys) {
    if (key !== 'ttlMs' && key !== 'scope') {
      throw new HelmError('validation_error', `${context} contains unknown key '${key}'(only allows ttlMs / scope)`, 400, { key })
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
        `${context}.ttlMs must be do not over ${MAX_SECRET_TTL_MS} correct safe integer(receives ${String(ttlMs)})`,
        400,
        { ttlMs },
      )
    }
  }
  const scope = (lifetime as { scope?: unknown }).scope
  if (scope !== undefined && scope !== 'conversation' && scope !== 'turn') {
    throw new HelmError(
      'validation_error',
      `${context}.scope only allows 'conversation' | 'turn'(receives ${String(scope)})`,
      400,
      { scope },
    )
  }
  return { ...(ttlMs !== undefined ? { ttlMs } : {}), ...(scope !== undefined ? { scope } : {}) } as SecretLifetime
}

/** placeholder ↔ text mutual rotate tool (ArtifactService spill redaction re- use). */
export function makePlaceholder(uuid: string): string {
  return `${REDACTED_PREFIX}${uuid}]`
}

export function parsePlaceholder(text: string): string | null {
  if (!text.startsWith(REDACTED_PREFIX) || !text.endsWith(']')) return null
  const uuid = text.slice(REDACTED_PREFIX.length, -1)
  return /^[0-9a-f-]{36}$/.test(uuid) ? uuid : null
}

export class SecretStash {
  /** key: conversationId → envName → secret. by conversation isolated, guard against across conversation string use. */
  private readonly byConversation = new Map<number, Map<string, StashedSecret>>()
  /** key: uuid → secret(redact fast index; contains already stop inject old value, redaction forever do not stop). */
  private readonly byUuid = new Map<string, StashedSecret>()
  /** conversation → completed turn compute count (turn effect domain out generate order base allow). */
  private readonly turnSettlements = new Map<number, number>()
  /** global one by one value redaction register:value → reference counter (many register stack put, all solve except only then stop). */
  private readonly globalRedactions = new Map<string, number>()
  private redactionEpoch = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * store secret, return `[REDACTED:stash:<uuid>]` placeholder.
   * the same (conversationId, name) duplicate put will override environment variable, old value still keep used to redaction.
   * lifetime optional:ttlMs expires / scope 'turn' turn compute after only stop inject, redaction continue.
   */
  put(conversationId: number, name: string, value: string, lifetime?: SecretLifetime): string {
    if (!isValidEnvName(name)) {
      throw new Error(`secret name must be legal environment variable name: ${name}`)
    }
    const normalized = lifetime !== undefined ? validateSecretLifetime(lifetime, `secret '${name}'  lifetime`) : undefined
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

  /** TTL lazy expires: expires i.e. from active bucket remove (byUuid keep old value used to redaction). */
  private isExpired(secret: StashedSecret): boolean {
    return secret.expiresAt !== undefined && this.now() >= secret.expiresAt
  }

  /**
   * gather out the conversation all leap secret is environment variable (inject child process use); each time invoke only sampling once
   * clock, all item by the same moment decide (TTL boundary inside will not same batch across boundary).TTL expires in this
   * lazy reclaim. optional names only take designate name (explicit grant external runtime use; missing seat name static default
   * skip, store in decide by caller based on actual return key negative duty).
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
      // environment variable name can legal ground is __proto__; define self has field, avoid trigger Object prototype setter.
      Object.defineProperty(env, name, { value: secret.value, enumerable: true, writable: true, configurable: true })
    }
    return env
  }

  /**
   * turn compute hook (completed | failed | aborted unify): first push enter compute counter, again reclaim
   * out generate order early at new counter turn effect domain secret (byUuid keep old value used to redaction). compute after new
   * register turn secret out generate order = new counter, belong under one turn, do not subject to this time clear affect.
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
   * register global one by one value redaction:redact() the value replace is `[REDACTED]`(any conversation context all
   * takes effect). non- environment variable, does not enter envFor/stats; the same value can duplicate register, return solve except
   * function reference counter reset to zero after only then stop redaction.
   */
  addRedaction(value: string): () => void {
    if (typeof value !== 'string' || value === '') throw new Error('addRedaction need to non-empty string')
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

  /** is otherwise store in the leap secret (by conversation isolated decide;TTL expires lazy reclaim after is false). */
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

  /** already register secret replace is placeholder; already has placeholder always keep redaction. */
  redact(text: string, conversationId?: number): string {
    const values = new Map<string, string>()
    // global one by one value redaction takes precedence at stash placeholder: managed token etc. host secret cannot by any conversation back visible
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

  /** incremental redaction: only keep still may group into secret suffix, do not by fixed length cut open complete match. */
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

  /** empty designate conversation all secret (contains redaction old value); omit conversationId then empty the whole stash(contains global redaction register). */
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

  /** tune try count: conversation count and leap secret total count (single time clock sampling decide; never output value itself). */
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
