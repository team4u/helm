/**
 * AskService:AskDoc lifecycle + CAS optimistic locking + secret  stash + external seq resolver register.
 *
 * key semantics (honest takes precedence):
 * - createAsk first complete validate (field type/name unique/secret env name legal/pre- allocate id shape and
 *   uniqueness/conversation store in via validateConversation port), invalid input in write store before reject;
 * - createAsk return AskResult:answered/cancelled/superseded three state all resolve
 *   (cancel/superseded  answers is {}, cancel never smoke fill user batch allow); only
 *   verify/IO/host failed only then reject;
 * - waiter first at everything visible side effect (putAsk/publish) register:ask.upsert subscribe in
 *   event call back inside sync cancel/answer when promise also can compute (once because first publish after register
 *   leads to store already settled while promise forever long pending); publish/failed to write sync reclaim waiter,
 *   do not pending wait for, do not false succeeded;
 * - real persist boundary in store tail chain: create and terminal state compute in resolve/publish terminal state event before
 *   await store.flushPublic(),SQL failed (mirror already write but failed) with explicit
 *   store_flush_failed reject compute createAsk- - never return false answered;
 *   terminal state putAsk(contains sync mirror reject)//call back/event publish any one failed, all extract and
 *   empty waiters one by one {failure} compute (do not pending, do not false terminal state) after such as on throw;
 *   cancelByConversation attempt cancel all, any one failed such as reject(not silently swallow IO);
 * - envName keep declaration original (do not toUpperCase merge collapse), same conversation inside mapping after collision explicit reject;
 * - answer validate unknown field/non- string/select out of bounds/confirm illegal value;secret null value do not stash
 *   (null value stash will produce invalid redaction item);
 * - CAS with durable spec.expectedStateSeq is allow: client provide different seq return 409
 *   (not silently override watermark), target when before seq any inconsistent (contains fall back) all superseded;
 *   has CAS watermark but without resolver register -> ask_state_unavailable(do not install act validate via);
 * - after restart pending asks keep concurrency out diagnose notify;secret stash reference across restarts expires,
 *   notify in such as note (does not pretend to be still can take back plaintext).
 */

import type { AskCreateSpec, AskFieldSpec, AskResult, AskSpec } from '@helm/protocol'
import { HelmError, type MaybePromise } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { isValidEnvName, validateSecretLifetime } from '../services/secret-stash.js'
import type { HelmStore } from './store.js'
import type { SecretStash } from '../services/secret-stash.js'

/** external target seq parse (such as herdr plugin register):askId -> target when before seq. can is async (real watermark must remote IO). */
export type AskSeqResolver = (askId: string) => MaybePromise<number | undefined>

export interface AskSettled {
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers?: Record<string, string>
}

/** waiter compute channel: normal terminal state or host side failed (IO/persist), on failure createAsk reject. */
type WaiterOutcome = AskSettled | { failure: unknown }

export class AskService {
  private readonly store: HelmStore
  private readonly stash: SecretStash
  private readonly seqResolvers = new Set<AskSeqResolver>()
  private readonly waiters = new Map<string, Array<(outcome: WaiterOutcome) => void>>()
  private readonly onEvent: (type: string, payload: unknown) => void
  private readonly onConvPendingChanged: (conversationId: number) => void
  /** conversation store in validate port (host inject; default skip - - pure AskService single test use). */
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

  /** herdr etc. external component register CAS target seq parse. */
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
   * create AskDoc and wait for terminal state. three state all resolve is AskResult(answered  answers in
   * secret field is stash marker;cancel/superseded  answers is {}, caller with
   * status zone, cancel never smoke fill batch allow). only verify/IO/host failed reject.
   *
   * spec.id can pre- allocate (external related and dedupe), does not override any already has ID(contains already compute approval).
   */
  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    validateAskSpec(spec)
    if (this.validateConversation) {
      const ok = await this.validateConversation(spec.conversationId)
      if (!ok) {
        throw new HelmError('not_found', `conversation missing:${spec.conversationId}`, 404)
      }
    }
    const id = spec.id ?? randomUUID()
    // pre- allocate ID must not override any already has AskDoc(contains pending and already compute approval).
    if (this.store.getAsk(id) !== undefined) {
      const existing = this.store.getAsk(id)!
      throw new HelmError(
        'ask_id_conflict',
        `AskDoc ID '${id}' already exists (state ${existing.status}), cannot override old approval`,
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

    // waiter must first at everything visible side effect register:ask.upsert subscribe may in event call back inside
    // sync cancel/answer(settle i.e. moment queue up notify), late register will let promise forever long pending.
    // push once self remove: normal terminal state resolve,failure(put//failed to publish)reject
    // the same error - - do not swallow caller error, also produces no not observe rejection.
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

    // async failed to initialize with the same error reject settled(caller from createAsk return
    // promise receives failed, do not pending, do not false succeeded);settled by return observe without leaking.
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
        // real boundary:putAsk only write mirror + queue SQL;flushPublic on failure mirror already write
        // but data do not guarantee complete, must explicit failed (do not publish ask.upsert, do not false succeeded).
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
   * commit answer proposal:CAS check -> value validate -> secret  stash -> compute.
   * resolver can is async (real watermark must remote IO): wait for return after, write any terminal state side effect before
   * heavy read row, wait for during by concurrency compute/change write then by when before right threat state reject or heavy estimate.
   */
  async answerAsk(
    id: string,
    answers: Record<string, string>,
    expectedStateSeq?: number,
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmError('not_found', `AskDoc missing:${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc already where at ${row.status} state`, 409)
    }

    // client carry seq and durable watermark different -> 409 expired view, not silently override bypass CAS.
    if (expectedStateSeq !== undefined && row.expectedStateSeq !== undefined && expectedStateSeq !== row.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `expectedStateSeq=${expectedStateSeq} and AskDoc durable watermark ${row.expectedStateSeq} inconsistent (client view expired)`,
        409,
        { askId: id, clientSeq: expectedStateSeq, storedSeq: row.expectedStateSeq },
      )
    }

    // CAS: with durable spec.expectedStateSeq is allow inspect target when before seq.resolver may async,
    // wait for during store in real concurrency window: return after must heavy read row, everything with when before right threat state is allow.
    let spec: AskSpec
    if (row.expectedStateSeq !== undefined) {
      const current = await this.resolveTargetSeq(id)
      const fresh = this.recheckPendingRow(id, row)
      if (fresh.expectedStateSeq !== undefined) {
        if (current === undefined) {
          // has CAS watermark but without resolver hit: target state cannot know, cannot install act validate via.
          throw new HelmError(
            'ask_state_unavailable',
            `AskDoc ${id} declaration expectedStateSeq=${fresh.expectedStateSeq} but without registered seq resolver hit, cannot validate target state`,
            409,
            { askId: id, expectedStateSeq: fresh.expectedStateSeq },
          )
        }
        // target seq any inconsistent (contains fall back) all superseded: target state already bias leave create when assume.
        if (current !== fresh.expectedStateSeq) {
          return this.settle(id, 'superseded')
        }
      }
      spec = JSON.parse(fresh.specJson) as AskSpec
    } else {
      // without CAS ask and all sync resolver when without any await between gap: keep original sync behavior.
      spec = JSON.parse(row.specJson) as AskSpec
    }

    validateAnswersAgainstFields(spec, answers)

    // secret value stash(null value do not:stash empty plaintext will let redaction expires); durable and event only store marker.
    // secretLifetime original pass-through:TTL/turn effect domain by stash unify execute (stop inject after old value still redaction).
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
    if (!row) throw new HelmError('not_found', `AskDoc missing:${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmError('ask_already_settled', `AskDoc already where at ${row.status} state`, 409)
    }
    return this.settle(id, reason)
  }

  /** restart diagnose: legacy pending asks  notification(not silently swallow);secret reference expires such as note. */
  reportOrphans(): void {
    const pending = this.listAsks('pending')
    for (const ask of pending) {
      const hasSecret = ask.fields.some((f) => f.secret)
      this.onEvent('notification', {
        level: 'warning',
        title: 'after restart legacy await answer AskDoc',
        body:
          `AskDoc ${ask.id}(conversation ${ask.conversationId}) in process restart before not compute, keep pending supply human handle` +
          (hasSecret ? '; note: its secret field answer proposal stash reference follow restart expires, re- act answer before old marker cannot take back plaintext' : ''),
        conversationId: ask.conversationId,
      })
    }
  }

  /**
   * by conversation cancel all pending(delete conversation level join use): attempt cancel all, any one failed such as
   * reject(not silently swallow IO failed); failed ask  waiter already by settle with failure compute.
   */
  async cancelByConversation(conversationId: number, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<void> {
    const pending = this.listPendingByConversation(conversationId)
    await Promise.all(pending.map((ask) => this.settle(ask.id, reason)))
  }

  /** wait for async resolver after row heavy read: row by delete -> 404; already non- pending -> 409. */
  private recheckPendingRow(id: string, stale: { expectedStateSeq?: number }): { expectedStateSeq?: number; specJson: string } {
    const now = this.store.getAsk(id)
    if (!now) throw new HelmError('not_found', `AskDoc missing:${id}`, 404)
    if (now.status !== 'pending') {
      throw new HelmError('ask_already_settled', `wait for seq resolver during AskDoc already by compute is ${now.status}`, 409, {
        askId: id,
        settledStatus: now.status,
      })
    }
    if (stale.expectedStateSeq !== now.expectedStateSeq) {
      throw new HelmError(
        'ask_state_conflict',
        `wait for seq resolver during AskDoc durable watermark already from ${stale.expectedStateSeq} change is ${now.expectedStateSeq}, with new right threat condition is allow`,
        409,
        { askId: id, previousSeq: stale.expectedStateSeq, storedSeq: now.expectedStateSeq },
      )
    }
    return now
  }

  private async resolveTargetSeq(askId: string): Promise<number | undefined> {
    for (const resolver of this.seqResolvers) {
      // resolver return illegal value (NaN/negative/decimal/unsafe/broken type) explicit failed:seq is CAS 
      // right threat fact, never truncate, do not by default 0, not silently skip install act without parse.
      const value = await resolver(askId)
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
        throw new HelmError(
          'ask_seq_resolver_invalid',
          `seq resolver for AskDoc ${askId} return illegal watermark (must non- negative safe integer)`,
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
    if (!row) throw new HelmError('not_found', `AskDoc missing:${id}`, 404)
    try {
      const spec = JSON.parse(row.specJson) as AskSpec
      const settledSpec: AskSpec = { ...spec, status }
      // cancel/superseded do not write false answers(result only answered has value).
      const answers = status === 'answered' ? (options.answers ?? {}) : undefined
      this.store.putAsk({
        ...row,
        status,
        specJson: JSON.stringify(settledSpec),
        resultJson: answers !== undefined ? JSON.stringify(answers) : undefined,
        settledAt: Date.now(),
      })
      // terminal state must real after only then publish event/notify waiter:SQL on failure never return false terminal state.
      await this.store.flushPublic()
      this.onConvPendingChanged(spec.conversationId)
      this.onEvent('ask.resolved', { askId: id, status })
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ askId: id, status, answers })
      return settledSpec
    } catch (error) {
      // putAsk(contains sync mirror reject)//call back/event publish any one failed: extract and empty
      // waiters one by one failure compute (do not pending, do not false terminal state), error such as on throw.
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ failure: error })
      throw error
    }
  }
}

/** secret field environment variable name: keep declaration original (field.name); illegal i.e. reject (not silently specification merge). */
function envNameOf(field: AskFieldSpec): string {
  if (!isValidEnvName(field.name)) {
    throw new HelmError(
      'validation_error',
      `secret field '${field.name}' name is not legal environment variable name (must [A-Za-z_][A-Za-z0-9_]*, not silently rotate large write merge)`,
      400,
    )
  }
  return field.name
}

/** AskCreateSpec complete boundary validate (write store before reject everything illegal shape). */
function validateAskSpec(spec: AskCreateSpec): void {
  if (spec === null || typeof spec !== 'object') {
    throw new HelmError('validation_error', 'AskDoc spec must be an object')
  }
  // caller ID must be non-empty string, not silently specification.
  if (spec.id !== undefined) {
    if (typeof spec.id !== 'string' || spec.id === '' || spec.id.trim() === '') {
      throw new HelmError('validation_error', 'AskDoc id must be a non-empty string')
    }
  }
  if (!Number.isInteger(spec.conversationId) || (spec.conversationId ?? 0) <= 0) {
    throw new HelmError('validation_error', 'AskDoc need to conversationId(positive integer)')
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    throw new HelmError('validation_error', 'AskDoc need to title(non-empty string)')
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
    throw new HelmError('validation_error', 'AskDoc need to at least a field')
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
      throw new HelmError('validation_error', `field.name duplicate:${field.name}`)
    }
    names.add(field.name)
    if (typeof field.label !== 'string' || field.label === '') {
      throw new HelmError('validation_error', `field '${field.name}' label must be a non-empty string`)
    }
    if (field.type !== 'text' && field.type !== 'select' && field.type !== 'confirm') {
      throw new HelmError(
        'validation_error',
        `field '${field.name}' type illegal:${String(field.type)}(only text | select | confirm)`,
      )
    }
    if (field.type === 'select') {
      if (
        !Array.isArray(field.options) ||
        field.options.length === 0 ||
        field.options.some((o) => o === null || typeof o !== 'object' || typeof o.value !== 'string' || o.value === '')
      ) {
        throw new HelmError('validation_error', `select field '${field.name}' need to non-empty options(value all is non-empty string)`)
      }
    }
    if (field.secret === true) {
      // declaration boundary i.e. validate env name available (envName or name two take one).
      envNameOf(field)
    }
    // secretLifetime only secret field allows; shape/enumeration/cap in boundary explicit reject (not silently fall back).
    if (field.secretLifetime !== undefined) {
      if (field.secret !== true) {
        throw new HelmError(
          'validation_error',
          `field '${field.name}' declaration secretLifetime but not mark record secret: true(lifecycle only constraint secret field)`,
          400,
        )
      }
      validateSecretLifetime(field.secretLifetime, `field '${field.name}'  secretLifetime`)
    }
  }
  // same conversation secret env name collision explicit reject (keep declaration original when 'api_key' and 'API_KEY' is two name).
  const secretEnvNames = new Map<string, string>()
  for (const field of spec.fields) {
    if (field.secret !== true) continue
    const env = envNameOf(field)
    const existing = secretEnvNames.get(env)
    if (existing !== undefined) {
      throw new HelmError(
        'validation_error',
        `secret field '${existing}' and '${field.name}' mapping the same environment variable name '${env}': reject merge override`,
      )
    }
    secretEnvNames.set(env, field.name)
  }
}

/** answer proposal boundary validate: unknown field / non- string / select out of bounds / confirm illegal value. */
function validateAnswersAgainstFields(spec: AskSpec, answers: Record<string, string>): void {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new HelmError('validation_error', 'answers must be an object')
  }
  const byName = new Map(spec.fields.map((f) => [f.name, f]))
  for (const key of Object.keys(answers)) {
    const value = answers[key]
    if (!byName.has(key)) {
      throw new HelmError('validation_error', `unknown answer proposal field:${key}(AskDoc not declaration)`)
    }
    if (typeof value !== 'string') {
      throw new HelmError('validation_error', `answer proposal field ${key} must be string(actual ${typeof value})`)
    }
  }
  for (const field of spec.fields) {
    const value = answers[field.name]
    if (field.required && (value === undefined || value === '')) {
      throw new HelmError('validation_error', `required field missing:${field.name}`)
    }
    if (value === undefined || value === '') continue
    if (field.type === 'select') {
      const valid = (field.options ?? []).some((o) => o.value === value)
      if (!valid) {
        throw new HelmError(
          'validation_error',
          `select field '${field.name}' answer proposal '${value}' do not in choose inside`,
        )
      }
    }
    if (field.type === 'confirm' && value !== 'true' && value !== 'false') {
      throw new HelmError(
        'validation_error',
        `confirm field '${field.name}' answer proposal must be 'true' | 'false'(actual '${value}')`,
      )
    }
  }
}
