/**
 * AskService: AskDoc lifecycle + CAS optimistic locking + secret stashing + external seq resolver registration.
 *
 * Key semantics (honesty first):
 * - createAsk performs full validation first (field types / unique names / valid secret env names / pre-allocated ID shape &
 *   uniqueness / conversation existence via validateConversation port), rejecting invalid input before writing to store;
 * - createAsk returns AskResult: all three terminal states (answered/cancelled/superseded) resolve
 *   (answers is {} on cancel/superseded, so cancellation never masquerades as user approval); only validation/IO/host failures reject;
 * - waiters register BEFORE any visible side effects (putAsk/publish): if an ask.upsert subscriber synchronously calls
 *   cancel/answer inside its callback, the promise still settles (previously registering after publish caused permanently hanging promises);
 *   on publish/write failure, waiters are reclaimed synchronously without leaving dangling promises or fake successes;
 * - true persistence boundary sits at the end of the store chain: create and settle await store.flushPublic() before resolving or
 *   publishing terminal events; if SQL fails (mirror written but flush failed), createAsk rejects explicitly with store_flush_failed—
 *   never returning a fake answered result. Any failure in terminal putAsk (including sync mirror rejection), flush, callback, or event
 *   publish extracts and settles all waiters with {failure} (no hangs, no fake terminal states) before rethrowing;
 *   cancelByConversation attempts to cancel all pending asks and rejects if any fails (never swallows IO errors);
 * - envName preserves declared casing (no toUpperCase folding); post-mapping collisions within a conversation are rejected explicitly;
 * - answer validation rejects unknown fields, non-strings, out-of-range select options, and invalid confirm values; empty secret values
 *   are not stashed (stashing empty plaintext would break redaction);
 * - CAS validates against persisted spec.expectedStateSeq: a mismatched seq from the client returns 409 (never silently overrides watermark),
 *   and any mismatch (including regression) against the target's current seq settles as superseded;
 *   a CAS watermark without a matching registered resolver yields ask_state_unavailable (never pretends verification passed);
 * - after restart, pending asks remain and emit diagnostic notifications; expired secret stash references are noted honestly
 *   (never pretending plaintext can still be recovered).
 */

import type { AskCreateSpec, AskFieldSpec, AskResult, AskSpec } from '@helm/protocol'
import { HelmError, type MaybePromise } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { isValidEnvName, validateSecretLifetime } from '../services/secret-stash.js'
import type { HelmStore } from './store.js'
import type { SecretStash } from '../services/secret-stash.js'

/** External target seq resolver (e.g., registered by herdr plugin): askId -> target current seq. May be async (real watermark requires remote IO). */
type AskSeqResolver = (askId: string) => MaybePromise<number | undefined>

interface AskSettled {
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers?: Record<string, string>
}

/** Waiter settlement outcome: normal terminal state or host-side failure (IO/persistence), causing createAsk to reject. */
type WaiterOutcome = AskSettled | { failure: unknown }

export class AskService {
  private readonly store: HelmStore
  private readonly stash: SecretStash
  private readonly seqResolvers = new Set<AskSeqResolver>()
  private readonly waiters = new Map<string, Array<(outcome: WaiterOutcome) => void>>()
  private readonly onEvent: (type: string, payload: unknown) => void
  private readonly onConvPendingChanged: (conversationId: number) => void
  /** Conversation existence validation port (injected by host; omitted in standalone AskService unit tests). */
  private readonly validateConversation?: (conversationId: number) => boolean | Promise<boolean>

  constructor(options: {
    store: HelmStore
    stash: SecretStash
    onEvent: (type: string, payload: unknown) => void
    onConvPendingChanged: (conversationId: number) => void
    validateConversation?: (conversationId: number) => boolean | Promise<boolean>
  }) {
    this.store = options.store
    this.stash = options.stash
    this.onEvent = options.onEvent
    this.onConvPendingChanged = options.onConvPendingChanged
    this.validateConversation = options.validateConversation
  }

  /** Register a CAS target seq resolver for external components such as herdr. */
  registerSeqResolver(resolver: AskSeqResolver): () => void {
    this.seqResolvers.add(resolver)
    return () => this.seqResolvers.delete(resolver)
  }

  listAsks(status?: string): AskSpec[] {
    return this.store.listAsks(status).map((row) => JSON.parse(row.specJson) as AskSpec)
  }

  listPendingByConversation(conversationId: number): AskSpec[] {
    return this.listAsks('pending').filter((a) => a.conversationId === conversationId)
  }

  pendingCount(conversationId: number): AskSpec[]['length'] {
    return this.listPendingByConversation(conversationId).length
  }

  getAsk(id: string): AskSpec | undefined {
    const row = this.store.getAsk(id)
    return row ? (JSON.parse(row.specJson) as AskSpec) : undefined
  }

  /**
   * Create an AskDoc and wait for its terminal state. All three states resolve to AskResult (for answered,
   * secret fields in answers hold stash markers; for cancelled/superseded, answers is {} so callers distinguish via
   * status and cancellations never impersonate approval). Rejects only on validation/IO/host failures.
   *
   * spec.id may be pre-allocated (for external correlation and deduplication) and never overwrites an existing ID (including settled approvals).
   */
  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    validateAskSpec(spec)
    if (this.validateConversation) {
      const ok = await this.validateConversation(spec.conversationId)
      if (!ok) {
        throw new HelmError('not_found', `conversation not found: ${spec.conversationId}`, 404)
      }
    }
    const id = spec.id ?? randomUUID()
    // A pre-allocated ID must never overwrite any existing AskDoc (whether pending or already settled).
    if (this.store.getAsk(id) !== undefined) {
      const existing = this.store.getAsk(id)!
      throw new HelmError(
        'ask_id_conflict',
        `AskDoc ID '${id}' already exists (status ${existing.status}); cannot overwrite existing approval`,
        409,
        { askId: id, existingStatus: existing.status },
      )
    }
    const createdAt = Date.now()
    const full: AskSpec = {
      ...spec,
      id,
      status: 'pending',
      createdAt,
      expectedStateSeq: spec.expectedStateSeq,
    }

    // Waiters must register before any visible side effects: an ask.upsert subscriber might synchronously cancel/answer
    // inside its event callback (settle notifies synchronously), so late registration would hang the promise forever.
    // push removes itself once: normal terminal states resolve, while failure (put/flush/publish error) rejects with
    // the exact error—preserving caller diagnostics without unhandled rejections.
    let push!: (outcome: WaiterOutcome) => void
    const settled = new Promise<AskResult>((resolve, reject) => {
      let done = false
      push = (outcome: WaiterOutcome) => {
        if (done) return
        done = true
        const current = this.waiters.get(id)
        if (current) {
          const index = current.indexOf(push)
          if (index >= 0) current.splice(index, 1)
          if (current.length === 0) this.waiters.delete(id)
        }
        if ('failure' in outcome) {
          reject(outcome.failure)
          return
        }
        resolve({
          id,
          status: outcome.status,
          answers: outcome.status === 'answered' ? (outcome.answers ?? {}) : {},
        })
      }
      const list = this.waiters.get(id) ?? []
      list.push(push)
      this.waiters.set(id, list)
    })

    // Propagate async initialization failure so the createAsk promise rejects (no hangs, no fake success);
    // settled is returned and observed directly without leaking an unhandled rejection.
    void (async () => {
      try {
        this.store.putAsk({
          id,
          conversationId: spec.conversationId,
          ownerPluginId: spec.ownerPluginId,
          specJson: JSON.stringify(full),
          status: 'pending',
          expectedStateSeq: spec.expectedStateSeq,
          createdAt,
        })
        // True persistence boundary: putAsk only updates the mirror and queues SQL; if flushPublic fails,
        // data is not guaranteed intact, so fail explicitly without publishing ask.upsert or faking success.
        await this.store.flushPublic()
        this.onConvPendingChanged(spec.conversationId)
        this.onEvent('ask.upsert', full)
      } catch (error) {
        push({ failure: error })
      }
    })()
    return settled
  }

  /**
   * Submit answers: CAS check -> value validation -> stash secrets -> settle.
   * Resolvers may be async (real watermarks require remote IO): after waiting, re-read the row before any terminal
   * side effect; concurrent settlement or edits during the await reject or re-evaluate against authoritative state.
   */
  async answerAsk(
    id: string,
    answers: Record<string, string>,
    expectedStateSeq?: number,
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc not found: ${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc is already in ${row.status} state`, 409)
    }

    // Client-supplied seq differs from persisted watermark -> 409 stale view (never silently overwrite to bypass CAS).
    if (expectedStateSeq !== undefined && row.expectedStateSeq !== undefined && expectedStateSeq !== row.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `expectedStateSeq=${expectedStateSeq} does not match persisted AskDoc watermark ${row.expectedStateSeq} (stale client view)`,
        409,
        { askId: id, clientSeq: expectedStateSeq, storedSeq: row.expectedStateSeq },
      )
    }

    // CAS: check target's current seq against persisted spec.expectedStateSeq. Since the resolver may be async,
    // an interleaving concurrency window exists—re-read the row on return and defer to current authoritative state.
    let spec: AskSpec
    if (row.expectedStateSeq !== undefined) {
      const current = await this.resolveTargetSeq(id)
      const fresh = this.recheckPendingRow(id, row)
      if (fresh.expectedStateSeq !== undefined) {
        if (current === undefined) {
          // CAS watermark declared but no resolver matched: target state is unknowable, so never pretend validation passed.
          throw new HelmError(
            'ask_state_unavailable',
            `AskDoc ${id} declares expectedStateSeq=${fresh.expectedStateSeq}, but no registered seq resolver matched; cannot validate target state`,
            409,
            { askId: id, expectedStateSeq: fresh.expectedStateSeq },
          )
        }
        // Any target seq mismatch (including regression) supersedes the ask: target state already diverged from creation.
        if (current !== fresh.expectedStateSeq) {
          return this.settle(id, 'superseded')
        }
      }
      spec = JSON.parse(fresh.specJson) as AskSpec
    } else {
      // No CAS watermark and fully synchronous path with zero awaits: preserve original synchronous behavior.
      spec = JSON.parse(row.specJson) as AskSpec
    }

    validateAnswersAgainstFields(spec, answers)

    // Stash secret values (skip empty values since empty plaintext breaks redaction); persistence and events store only markers.
    // Pass secretLifetime verbatim so SecretStash handles TTL/turn scope uniformly (keeps redacting old values after injection stops).
    const stored: Record<string, string> = {}
    for (const field of spec.fields) {
      const value = answers[field.name] ?? ''
      stored[field.name] =
        field.secret && value !== ''
          ? this.stash.put(spec.conversationId, envNameOf(field), value, field.secretLifetime)
          : value
    }
    return this.settle(id, 'answered', { answers: stored })
  }

  cancelAsk(id: string, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc not found: ${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc is already in ${row.status} state`, 409)
    }
    return this.settle(id, reason)
  }

  /** Startup diagnostics: emit notifications for leftover pending asks (never silently swallow); note expired secret references honestly. */
  reportOrphans(): void {
    const pending = this.listAsks('pending')
    for (const ask of pending) {
      const hasSecret = ask.fields.some((f) => f.secret)
      this.onEvent('notification', {
        level: 'warning',
        title: 'Pending AskDoc remaining after restart',
        body:
          `AskDoc ${ask.id} (conversation ${ask.conversationId}) did not settle before process restart and remains pending for manual action` +
          (hasSecret ? '; note: stash references for its secret fields expired across the restart, so old markers cannot recover plaintext until answered again' : ''),
        conversationId: ask.conversationId,
      })
    }
  }

  /**
   * Cancel all pending asks for a conversation (cascading conversation deletion): attempts to cancel every ask,
   * rejecting honestly if any fails (never swallows IO errors); failed asks have already settled their waiters with failure.
   */
  async cancelByConversation(conversationId: number, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<void> {
    const pending = this.listPendingByConversation(conversationId)
    await Promise.all(pending.map((ask) => this.settle(ask.id, reason)))
  }

  /** Re-read row after awaiting an async resolver: deleted -> 404; no longer pending -> 409. */
  private recheckPendingRow(id: string, stale: { expectedStateSeq?: number }): { expectedStateSeq?: number; specJson: string } {
    const now = this.store.getAsk(id)
    if (!now) throw new HelmError('not_found', `AskDoc not found: ${id}`, 404)
    if (now.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc was already settled as ${now.status} while waiting for seq resolver`, 409, {
        askId: id,
        settledStatus: now.status,
      })
    }
    if (stale.expectedStateSeq !== now.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `persisted AskDoc watermark changed from ${stale.expectedStateSeq} to ${now.expectedStateSeq} while waiting for seq resolver; deferring to new authoritative state`,
        409,
        { askId: id, previousSeq: stale.expectedStateSeq, storedSeq: now.expectedStateSeq },
      )
    }
    return now
  }

  private async resolveTargetSeq(askId: string): Promise<number | undefined> {
    for (const resolver of this.seqResolvers) {
      // Fail explicitly if resolver returns an invalid value (NaN/negative/fraction/unsafe/bad type): seq is authoritative
      // CAS state and must never be truncated, defaulted to 0, or silently treated as unresolved.
      const value = await resolver(askId)
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
        throw new HelmError(
          'ask_seq_resolver_invalid',
          `seq resolver returned an invalid watermark for AskDoc ${askId} (must be a non-negative safe integer)`,
          500,
          { askId, resolvedType: value === null ? 'null' : typeof value },
        )
      }
      return value
    }
    return undefined
  }

  private async settle(
    id: string,
    status: 'answered' | 'cancelled' | 'superseded',
    options: { answers?: Record<string, string> } = {},
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc not found: ${id}`, 404)
    try {
      const spec = JSON.parse(row.specJson) as AskSpec
      const settledSpec: AskSpec = { ...spec, status }
      // Never write fake answers on cancelled/superseded (result is populated only for answered).
      const answers = status === 'answered' ? (options.answers ?? {}) : undefined
      this.store.putAsk({
        ...row,
        status,
        specJson: JSON.stringify(settledSpec),
        resultJson: answers !== undefined ? JSON.stringify(answers) : undefined,
        settledAt: Date.now(),
      })
      // Terminal state must persist to disk before emitting events or notifying waiters; SQL failure must never fake a terminal state.
      await this.store.flushPublic()
      this.onConvPendingChanged(spec.conversationId)
      this.onEvent('ask.resolved', { askId: id, status })
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ askId: id, status, answers })
      return settledSpec
    } catch (error) {
      // Any failure in putAsk (incl. sync mirror rejection), flush, callback, or event publish: drain waiters and settle
      // each with failure (no hangs, no fake terminal states), then rethrow honestly.
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ failure: error })
      throw error
    }
  }
}

/** Env var name for a secret field: preserve declared field.name; reject invalid names instead of silently normalizing. */
function envNameOf(field: AskFieldSpec): string {
  if (!isValidEnvName(field.name)) {
    throw new HelmError(
      'validation_error',
      `secret field name '${field.name}' is not a valid environment variable name (requires [A-Za-z_][A-Za-z0-9_]*; never auto-uppercases or merges)`,
      400,
    )
  }
  return field.name
}

/** Full boundary validation for AskCreateSpec (rejects every invalid shape before persisting). */
function validateAskSpec(spec: AskCreateSpec): void {
  if (spec === null || typeof spec !== 'object') {
    throw new HelmError('validation_error', 'AskDoc spec must be an object')
  }
  // Caller-supplied ID must be a non-empty string without silent normalization.
  if (spec.id !== undefined) {
    if (typeof spec.id !== 'string' || spec.id === '' || spec.id.trim() === '') {
      throw new HelmError('validation_error', 'AskDoc id must be a non-empty string')
    }
  }
  if (!Number.isInteger(spec.conversationId) || (spec.conversationId ?? 0) <= 0) {
    throw new HelmError('validation_error', 'AskDoc requires conversationId (positive integer)')
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    throw new HelmError('validation_error', 'AskDoc requires title (non-empty string)')
  }
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    throw new HelmError('validation_error', 'AskDoc description must be a string')
  }
  if (spec.ownerPluginId !== undefined && typeof spec.ownerPluginId !== 'string') {
    throw new HelmError('validation_error', 'AskDoc ownerPluginId must be a string')
  }
  if (spec.expectedStateSeq !== undefined) {
    if (!Number.isInteger(spec.expectedStateSeq) || (spec.expectedStateSeq as number) < 0) {
      throw new HelmError('validation_error', 'expectedStateSeq must be a non-negative integer')
    }
  }
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new HelmError('validation_error', 'AskDoc requires at least one field')
  }
  const names = new Set<string>()
  for (const field of spec.fields) {
    if (field === null || typeof field !== 'object') {
      throw new HelmError('validation_error', 'field must be an object')
    }
    if (typeof field.name !== 'string' || field.name.trim() === '') {
      throw new HelmError('validation_error', 'field.name must be a non-empty string')
    }
    if (names.has(field.name)) {
      throw new HelmError('validation_error', `duplicate field.name: ${field.name}`)
    }
    names.add(field.name)
    if (typeof field.label !== 'string' || field.label === '') {
      throw new HelmError('validation_error', `field '${field.name}' label must be a non-empty string`)
    }
    if (field.type !== 'text' && field.type !== 'select' && field.type !== 'confirm') {
      throw new HelmError(
        'validation_error',
        `invalid type for field '${field.name}': ${String(field.type)} (only text | select | confirm)`,
      )
    }
    if (field.type === 'select') {
      if (
        !Array.isArray(field.options) ||
        field.options.length === 0 ||
        field.options.some((o) => o === null || typeof o !== 'object' || typeof o.value !== 'string' || o.value === '')
      ) {
        throw new HelmError('validation_error', `select field '${field.name}' requires non-empty options (each with a non-empty string value)`)
      }
    }
    if (field.secret === true) {
      // Validate env var name at declaration time (uses envName or name).
      envNameOf(field)
    }
    // secretLifetime is only permitted on secret fields; reject bad shape/enum/cap at boundary (no silent fallback).
    if (field.secretLifetime !== undefined) {
      if (field.secret !== true) {
        throw new HelmError(
          'validation_error',
          `field '${field.name}' declares secretLifetime without secret: true (lifetime only constrains secret fields)`,
          400,
        )
      }
      validateSecretLifetime(field.secretLifetime, `secretLifetime of field '${field.name}'`)
    }
  }
  // Explicitly reject secret env var collisions within a conversation (preserving casing keeps 'api_key' and 'API_KEY' distinct).
  const secretEnvNames = new Map<string, string>()
  for (const field of spec.fields) {
    if (field.secret !== true) continue
    const env = envNameOf(field)
    const existing = secretEnvNames.get(env)
    if (existing !== undefined) {
      throw new HelmError(
        'validation_error',
        `secret fields '${existing}' and '${field.name}' map to the same environment variable '${env}'; refusing merge/overwrite`,
      )
    }
    secretEnvNames.set(env, field.name)
  }
}

/** Answer boundary validation: unknown fields / non-strings / out-of-range select options / invalid confirm values. */
function validateAnswersAgainstFields(spec: AskSpec, answers: Record<string, string>): void {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new HelmError('validation_error', 'answers must be an object')
  }
  const byName = new Map(spec.fields.map((f) => [f.name, f]))
  for (const key of Object.keys(answers)) {
    const value = answers[key]
    if (!byName.has(key)) {
      throw new HelmError('validation_error', `unknown answer field: ${key} (not declared on AskDoc)`)
    }
    if (typeof value !== 'string') {
      throw new HelmError('validation_error', `answer field '${key}' must be a string (got ${typeof value})`)
    }
  }
  for (const field of spec.fields) {
    const value = answers[field.name]
    if (field.required && (value === undefined || value === '')) {
      throw new HelmError('validation_error', `missing required field: ${field.name}`)
    }
    if (value === undefined || value === '') continue
    if (field.type === 'select') {
      const valid = (field.options ?? []).some((o) => o.value === value)
      if (!valid) {
        throw new HelmError(
          'validation_error',
          `answer '${value}' for select field '${field.name}' is not among the allowed options`,
        )
      }
    }
    if (field.type === 'confirm' && value !== 'true' && value !== 'false') {
      throw new HelmError(
        'validation_error',
        `answer for confirm field '${field.name}' must be 'true' | 'false' (got '${value}')`,
      )
    }
  }
}
