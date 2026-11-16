/**
 * builtin:triggers -- the cron scheduling module.
 *
 * Responsibilities: scheduled delivery driven by standard five-field cron expressions (cron-parser).
 * - Runtime state persists in the public doc `crons` (pure JSON; lastRunAt/nextRunAt advance with claims);
 * - Persistent claim: at a schedule point, first advance nextRunAt and await doc.flush() for a real
 *   flush, then deliver. At most one delivery attempt per schedule point; a crash after the claim is
 *   flushed but before delivery completes loses that attempt (honest semantics: persistent claim and
 *   async input submission do not form an atomic transaction; exactly-once is not promised);
 * - catchUp:true merges missed intervals into one catch-up run after restart;
 *   false jumps to a future point (the jump also claims+flushes, preventing recompute-back after restart);
 * - single-flight: only one in-flight tick per concurrent job;
 * - dispatch failures write lastError honestly and emit a notification event, never faking success;
 *   no retry within the schedule point (at-mostast-once semantics); the next point schedules normally;
 * - Error-path invariant: a timer is consumed the moment it fires; any tick exception (evaluation/flush)
 *   must reschedule via finally -- a job never permanently stalls on a transient fault before restart;
 *
 * Timers are managed solely through the ctx.service lifecycle; the kernel is untouched.
 */

import { CronExpressionParser } from 'cron-parser'
import { randomUUID } from 'node:crypto'
import { HelmError, type ExternalTriggerEnvelope, type HelmPluginContext } from '@helm/protocol'

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

export const CRON_DOC_NAME = 'crons'

/** Five-field cron; the ID charset is tightened (dots forbidden, avoiding ambiguity with fully-qualified action names). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** setTimeout cap (2^31-1 ms ~= 24.8 days); larger delays fire in the window first, then reschedule. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Retry backoff floor after a scheduling-decision failure: with a persistently broken expression etc.,
 * rescheduling by an expired nextRunAt degrades into a hot loop spamming notifications; retry after one floor interval, auto-recovering once fixed. */
const DECISION_RETRY_FLOOR_MS = 60_000

export interface CronJob {
  id: string
  /**
   * Creation generation (randomUUID): claim/lastError write-backs are checked against (id, rev),
   * preventing an in-flight tick from polluting a same-id job rebuilt after delete. A rebuild changes the generation.
   */
  rev: string
  description?: string
  /** Standard five-field cron expression (min hour day month weekday). */
  schedule: string
  /** IANA timezone, default 'UTC'. */
  timezone: string
  /** Text payload delivered at trigger time. */
  text: string
  enabled: boolean
  /** true: catch up missed intervals once after restart; false: jump to a future point. */
  catchUp: boolean
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
  /** The planned time of the most recent claim (the schedule point, not delivery completion). */
  lastRunAt?: number
  /** The next planned trigger time (epoch ms). */
  nextRunAt?: number
  /** Explicit diagnostics of the most recent delivery failure. */
  lastError?: string
}

export interface CronDoc {
  version: 1
  jobs: CronJob[]
}

export interface CronDeps {
  /** Delivery entry (shared dispatch helper: validates the Profile, resolves/creates the conversation, then enters the trigger pipeline). */
  dispatchTrigger(event: ExternalTriggerEnvelope, targetProfileId?: string): Promise<void>
}

/** Timer primitive abstraction (tests inject a controllable clock; defaults to Date.now/setTimeout+unref). */
export interface CronClock {
  now(): number
  setTimeout(fn: () => void, ms: number): CronTimerHandle
}

export interface CronTimerHandle {
  clear(): void
}

/** Internal handle returned by register (for tests; business code must not rely on it). */
export interface CronRuntime {
  /** Run one scheduling scan of all enabled jobs immediately (without waiting for timers). */
  tickNow(): Promise<void>
  /** Wait for all in-flight ticks to finish (test teardown after driving timers). */
  settle(): Promise<void>
}

// ---------------------------------------------------------------------------
// Pure functions: validation / time computation / doc parsing (exported for tests)
// ---------------------------------------------------------------------------

/** Validate a five-field cron expression and IANA timezone; invalid throws HelmError (cron-parser messages pass through). */
export function assertValidSchedule(schedule: string, timezone: string): void {
  if (typeof schedule !== 'string' || schedule.trim().length === 0) {
    throw new HelmError('validation_error', 'cron schedule must not be empty (standard five fields: min hour day month weekday)', 400, {
      field: 'schedule',
    })
  }
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new HelmError(
      'validation_error',
      `cron schedule must be standard five fields (min hour day month weekday); got ${fields.length}: ${schedule}`,
      400,
      { field: 'schedule', schedule },
    )
  }
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new HelmError('validation_error', 'cron timezone must not be empty (an IANA zone name; defaults to UTC)', 400, {
      field: 'timezone',
    })
  }
  try {
    // cron-parser defers invalid-timezone errors to evaluation (CronDate Invalid Date), and
    // hasNext() silently returns false for a bad timezone -- the validation boundary must evaluate one point directly
    CronExpressionParser.parse(schedule, { tz: timezone }).next()
  } catch (err) {
    throw new HelmError(
      'validation_error',
      `invalid cron schedule: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { field: 'schedule', schedule, timezone },
    )
  }
}

/** Compute the next planned time strictly after afterMs; undefined when there is no future point. */
export function nextFireTime(schedule: string, timezone: string, afterMs: number): number | undefined {
  try {
    const iter = CronExpressionParser.parse(schedule, { currentDate: new Date(afterMs), tz: timezone })
    if (!iter.hasNext()) return undefined
    return iter.next().getTime()
  } catch (err) {
    throw new HelmError(
      'cron_next_time_unavailable',
      `failed to compute the next cron time (schedule=${schedule} tz=${timezone}): ${err instanceof Error ? err.message : String(err)}`,
      500,
      { schedule, timezone, afterMs },
    )
  }
}

/** Normalize creation input into a CronJob (pure; no doc writes or time computation). */
export function normalizeCronInput(input: {
  id: string
  schedule: string
  text: string
  description?: string
  timezone?: string
  enabled?: boolean
  catchUp?: boolean
  targetConversationId?: number
  targetProfileId?: string
  threadKey?: string
}): CronJob {
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    throw new HelmError(
      'validation_error',
      `invalid cron id (1..64 chars, alphanumeric _ - allowed, dots forbidden): ${String(input.id)}`,
      400,
      { field: 'id' },
    )
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new HelmError('validation_error', 'cron text must not be empty (the payload text delivered at trigger time)', 400, { field: 'text' })
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
    throw new HelmError('validation_error', 'cron description must be a string of at most 500 chars', 400, {
      field: 'description',
    })
  }
  const timezone = input.timezone ?? 'UTC'
  assertValidSchedule(input.schedule, timezone)

  const hasConv = input.targetConversationId !== undefined
  const hasProfile = input.targetProfileId !== undefined
  if (hasConv && hasProfile) {
    throw new HelmError(
      'validation_error',
      'targetConversationId and targetProfileId are mutually exclusive: direct conversation delivery and per-Profile resolution cannot both be set',
      400,
      { field: 'targetConversationId/targetProfileId' },
    )
  }
  if (hasConv && (!Number.isInteger(input.targetConversationId) || (input.targetConversationId as number) <= 0)) {
    throw new HelmError('validation_error', 'targetConversationId must be a positive integer conversation ID', 400, {
      field: 'targetConversationId',
    })
  }
  if (hasProfile && (typeof input.targetProfileId !== 'string' || input.targetProfileId.length === 0)) {
    throw new HelmError('validation_error', 'targetProfileId must be a non-empty string', 400, { field: 'targetProfileId' })
  }
  if (input.threadKey !== undefined && (typeof input.threadKey !== 'string' || input.threadKey.length === 0)) {
    throw new HelmError('validation_error', 'threadKey must be a non-empty string', 400, { field: 'threadKey' })
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new HelmError('validation_error', 'enabled must be a boolean', 400, { field: 'enabled' })
  }
  if (input.catchUp !== undefined && typeof input.catchUp !== 'boolean') {
    throw new HelmError('validation_error', 'catchUp must be a boolean', 400, { field: 'catchUp' })
  }

  return {
    id: input.id,
    rev: randomUUID(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    schedule: input.schedule.trim(),
    timezone,
    text: input.text,
    enabled: input.enabled ?? true,
    catchUp: input.catchUp ?? false,
    ...(hasConv ? { targetConversationId: input.targetConversationId } : {}),
    ...(hasProfile ? { targetProfileId: input.targetProfileId } : {}),
    ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
  }
}

/**
 * Strictly validate the persisted doc: bad data throws HelmError explicitly (cron_doc_corrupt); never silently resets.
 * Unknown fields are ignored (forward evolution); known-field type/constraint errors must be rejected.
 */
export function parseCronDoc(raw: unknown): CronDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError('cron_doc_corrupt', 'crons doc corrupted: the root must be an object', 500, { actual: String(raw) })
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: invalid version: ${String(doc.version)} (expected 1)`, 500, {
      version: doc.version,
    })
  }
  if (!Array.isArray(doc.jobs)) {
    throw new HelmError('cron_doc_corrupt', 'crons doc corrupted: jobs must be an array', 500, { actual: typeof doc.jobs })
  }
  const seen = new Set<string>()
  const jobs = doc.jobs.map((rawJob, index) => parseCronJob(rawJob, index, seen))
  return { version: 1, jobs }
}

function parseCronJob(rawJob: unknown, index: number, seen: Set<string>): CronJob {
  const where = `jobs[${index}]`
  if (rawJob === null || typeof rawJob !== 'object' || Array.isArray(rawJob)) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} must be an object`, 500, { index })
  }
  const job = rawJob as Record<string, unknown>
  if (typeof job.id !== 'string' || !ID_PATTERN.test(job.id)) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: invalid ${where}.id: ${String(job.id)}`, 500, { index })
  }
  if (typeof job.rev !== 'string' || job.rev.length === 0) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) is missing the creation generation rev`, 500, {
      index,
      id: job.id,
    })
  }
  if (seen.has(job.id)) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: duplicate ${where}.id: ${job.id}`, 500, { index })
  }
  seen.add(job.id)
  if (typeof job.schedule !== 'string' || typeof job.text !== 'string') {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) is missing schedule/text`, 500, {
      index,
      id: job.id,
    })
  }
  if (typeof job.timezone !== 'string' || job.timezone.length === 0) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) has an invalid timezone`, 500, {
      index,
      id: job.id,
    })
  }
  if (typeof job.enabled !== 'boolean' || typeof job.catchUp !== 'boolean') {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) enabled/catchUp must be booleans`, 500, {
      index,
      id: job.id,
    })
  }
  for (const field of ['description', 'targetProfileId', 'threadKey', 'lastError'] as const) {
    if (job[field] !== undefined && typeof job[field] !== 'string') {
      throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) has an invalid ${field} type`, 500, {
        index,
        id: job.id,
        field,
      })
    }
  }
  if (
    job.targetConversationId !== undefined &&
    (!Number.isInteger(job.targetConversationId) || (job.targetConversationId as number) <= 0)
  ) {
    throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) has an invalid targetConversationId`, 500, {
      index,
      id: job.id,
    })
  }
  if (job.targetConversationId !== undefined && job.targetProfileId !== undefined) {
    throw new HelmError(
      'cron_doc_corrupt',
      `crons doc corrupted: ${where} (${job.id}) targetConversationId and targetProfileId are mutually exclusive`,
      500,
      { index, id: job.id },
    )
  }
  for (const field of ['lastRunAt', 'nextRunAt'] as const) {
    if (job[field] !== undefined && (typeof job[field] !== 'number' || !Number.isFinite(job[field]))) {
      throw new HelmError('cron_doc_corrupt', `crons doc corrupted: ${where} (${job.id}) ${field} must be finite numbers`, 500, {
        index,
        id: job.id,
        field,
      })
    }
  }
  return {
    id: job.id,
    rev: job.rev,
    ...(job.description !== undefined ? { description: job.description as string } : {}),
    schedule: job.schedule,
    timezone: job.timezone,
    text: job.text,
    enabled: job.enabled,
    catchUp: job.catchUp,
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId as number } : {}),
    ...(job.targetProfileId !== undefined ? { targetProfileId: job.targetProfileId as string } : {}),
    ...(job.threadKey !== undefined ? { threadKey: job.threadKey as string } : {}),
    ...(job.lastRunAt !== undefined ? { lastRunAt: job.lastRunAt as number } : {}),
    ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt as number } : {}),
    ...(job.lastError !== undefined ? { lastError: job.lastError as string } : {}),
  }
}

// ---------------------------------------------------------------------------
// Pure functions: scheduling decisions and envelope construction (exported for tests)
// ---------------------------------------------------------------------------

/** One job's decision within a tick. */
export type TickDecision =
  | { action: 'fire'; at: number }
  | { action: 'skip-to-future'; from: number; to: number }
  | { action: 'noop' }

/**
 * Decide a job's action at now:
 * - disabled / nextRunAt missing or in the future: noop;
 * - due (nextRunAt <= now):
 *   - only one interval missed (the next point after nextRunAt is still in the future, incl. on-time firing) -> fire
 *     that planned point (catchUp semantics likewise fire);
 *   - multiple intervals missed (downtime) and catchUp=false -> jump to the first point after now;
 *   - multiple intervals missed and catchUp=true -> still catch up only the most recent one (at=nextRunAt),
 *     then advanceAfterFire jumps to the future; history is not replayed interval by interval.
 */
export function decideTick(job: CronJob, now: number): TickDecision {
  if (!job.enabled) return { action: 'noop' }
  const next = job.nextRunAt
  if (next === undefined || next > now) return { action: 'noop' }
  const subsequent = nextFireTime(job.schedule, job.timezone, next)
  const missedMultiple = subsequent !== undefined && subsequent <= now
  if (!missedMultiple || job.catchUp) return { action: 'fire', at: next }
  const future = nextFireTime(job.schedule, job.timezone, now)
  if (future === undefined || future <= now) {
    // nextFireTime strictly increases, so this is theoretically unreachable; defensively error explicitly instead of silence
    throw new HelmError(
      'cron_schedule_stalled',
      `cron job ${job.id} cannot jump to a future point (schedule=${job.schedule} tz=${job.timezone})`,
      500,
      { id: job.id, schedule: job.schedule, timezone: job.timezone },
    )
  }
  return { action: 'skip-to-future', from: next, to: future }
}

/**
 * The next planned point after a fire: candidate = the first point after fireAt; if it still falls before now
 * (multiple intervals missed during downtime), jump to the first point after now -- catchUp runs once only,
 * never replaying history interval by interval.
 */
export function advanceAfterFire(schedule: string, timezone: string, fireAt: number, now: number): number | undefined {
  const candidate = nextFireTime(schedule, timezone, fireAt)
  if (candidate === undefined) return undefined
  if (candidate > now) return candidate
  return nextFireTime(schedule, timezone, now)
}

/** Envelope construction (pure): source is fixed 'cron:<id>'; the id embeds the planned point (stable per point). */
export function buildCronEnvelope(job: CronJob, fireAt: number): ExternalTriggerEnvelope {
  return {
    id: `cron:${job.id}:${fireAt}`,
    source: `cron:${job.id}`,
    text: job.text,
    createdAt: fireAt,
    ...(job.threadKey !== undefined ? { threadKey: job.threadKey } : {}),
    ...(job.targetConversationId !== undefined ? { targetConversationId: job.targetConversationId } : {}),
  }
}

/** Clear the lastError field (cannot assign undefined: the doc storage rejects undefined-valued keys). */
function clearLastError(job: CronJob): CronJob {
  const { lastError: _ignored, ...rest } = job
  void _ignored
  return rest as CronJob
}

// ---------------------------------------------------------------------------
// Registration entry
// ---------------------------------------------------------------------------

/**
 * Register cron scheduling: the public doc + 4 actions (cron_list/create/delete/trigger) +
 * the timer service. The main plugin calls it inside definePlugin; deps.dispatchTrigger is the shared
 * delivery helper (validates the Profile, resolves/creates the conversation, then enters
 * ctx.host.dispatchTrigger -- already defanged by the kernel).
 */
export function registerCron(ctx: HelmPluginContext, deps: CronDeps): CronRuntime {
  return createCronScheduler(ctx, deps, defaultClock())
}

/** Internal test entry: controllable clock injection (runtime has no injection need; defaults to the real clock). */
export function createCronScheduler(ctx: HelmPluginContext, deps: CronDeps, clock: CronClock): CronRuntime {
  const doc = ctx.doc<CronDoc>(CRON_DOC_NAME, { version: 1, jobs: [] }, { public: true })

  let stopping = false
  /** single-flight: job id -> in-flight scheduling Promise. */
  const inflight = new Map<string, Promise<void>>()
  const timers = new Map<string, CronTimerHandle>()

  const logDiagnostic = (message: string): void => {
    console.error(`[cron] ${message}`)
  }

  /** Explicit error reporting: a notification event + stderr (each best-effort; failures do not recurse). */
  const emitError = (title: string, detail: unknown): void => {
    const message = detail instanceof Error ? detail.message : String(detail)
    try {
      ctx.host.emitEvent('notification', { type: 'notification', level: 'error', title, body: `[cron] ${message}` })
    } catch (eventErr) {
      logDiagnostic(`notification event publish failed: ${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
    }
    logDiagnostic(`${title}：${message}`)
  }

  /** Read and strictly validate the doc; bad data throws explicitly, never silently resetting. */
  const readDoc = (): CronDoc => parseCronDoc(doc.get())

  /** Write back + really flush (doc.flush drains this store's queued writes); persistence failures throw explicitly. */
  const writeDoc = async (next: CronDoc): Promise<void> => {
    doc.set(next)
    await doc.flush()
  }

  /**
   * Write a single job back by (id, rev) and flush: a missing id or rev mismatch (rebuilt after delete with a new
   * generation) refuses the write and returns false -- an old tick's claim/lastError never pollutes or revives a
   * new job. The read-modify-write completes within the synchronous segment (no await before doc.set),
   * naturally serialized within the event loop.
   */
  const tryUpdateJob = async (
    id: string,
    rev: string,
    mutate: (job: CronJob) => CronJob,
  ): Promise<boolean> => {
    const current = readDoc()
    const index = current.jobs.findIndex((j) => j.id === id)
    if (index < 0 || current.jobs[index]!.rev !== rev) return false
    const jobs = [...current.jobs]
    jobs[index] = mutate(jobs[index]!)
    await writeDoc({ version: 1, jobs })
    return true
  }

  /**
   * One scheduling pass for one job (single-flight guaranteed by tickJob).
   * Order: persistent claim (advance lastRunAt/nextRunAt + flush) -> dispatch;
   * a failed claim flush never delivers (otherwise the crash window duplicates deliveries).
   * Invariant: the timer is consumed by timers.delete at the start of the fire callback; every exit of this
   * method (incl. escaping exceptions) must reschedule -- guaranteed uniformly by finally (decision failures take
   * the backoff floor, preventing a hot loop on an expired nextRunAt); otherwise one transient evaluation/flush
   * exception permanently stalls the job (a single notification, no recovery before restart). Deleted/disabled/
   * shutting-down jobs naturally do not schedule as scheduleJob re-reads the doc; delete/disable semantics are unaffected.
   */
  const runJobTick = async (id: string): Promise<void> => {
    if (stopping) return
    // When the decision-failure path already reschedules with backoff, finally does not reschedule again by nextRunAt.
    let rescheduledByBackoff = false
    try {
      let job: CronJob | undefined
      let decision: TickDecision
      try {
        job = readDoc().jobs.find((j) => j.id === id)
        if (!job) return
        decision = decideTick(job, clock.now())
      } catch (err) {
        emitError(`cron job ${id} scheduling decision failed`, err)
        rescheduledByBackoff = true
        scheduleJob(id, clock.now() + DECISION_RETRY_FLOOR_MS)
        return
      }
      if (decision.action === 'noop') return
      if (decision.action === 'skip-to-future') {
        // catchUp=false: missed intervals jump straight to the future; also claim+flush against restart-jump-back.
        // lastRunAt stays (no real delivery happened; no fabricated run record).
        // When tryUpdateJob throws (flush failure), the exception propagates and the timer callback notifies as a
        // backstop; the doc.set mirror has advanced, and finally reschedules by the next point -- the job does not stall.
        await tryUpdateJob(id, job.rev, (j) => ({ ...j, nextRunAt: decision.to }))
        return
      }
      // fire: claim (clear lastError, record lastRunAt, advance nextRunAt) -> flush -> dispatch
      const fireAt = decision.at
      let claimed: boolean
      try {
        claimed = await tryUpdateJob(
          id,
          job.rev,
          (j) =>
            clearLastError({
              ...j,
              lastRunAt: fireAt,
              nextRunAt: advanceAfterFire(j.schedule, j.timezone, fireAt, clock.now()),
            }),
        )
      } catch (err) {
        // Claim not flushed: never deliver (otherwise the crash window duplicates deliveries)
        emitError(`cron job ${id} claim persistence failed; not delivering this time`, err)
        return
      }
      if (!claimed || stopping) return
      // The task may be deleted or rebuilt while flush yields; re-check the creation generation before delivering.
      if (!readDoc().jobs.some((current) => current.id === id && current.rev === job.rev && current.enabled)) return
      try {
        await deps.dispatchTrigger(buildCronEnvelope(job, fireAt), job.targetProfileId)
      } catch (err) {
        // Delivery failure: write lastError + notification honestly; no retry within this point; the next point proceeds normally.
        // (id, rev) check: if the job was deleted and rebuilt during dispatch, never write the old failure onto the new job.
        const message = err instanceof Error ? err.message : String(err)
        try {
          const written = await tryUpdateJob(id, job.rev, (j) => ({
            ...j,
            lastError: `delivery failed @${new Date(fireAt).toISOString()}: ${message}`,
          }))
          if (!written) {
            logDiagnostic(`cron job ${id} delivery failed, but the job was deleted/rebuilt; lastError not written back (generation changed)`)
          }
        } catch (writeErr) {
          // A lastError flush failure does not mask the original delivery failure (rescheduling is guaranteed by finally; nothing escapes).
          logDiagnostic(
            `cron job ${id} delivery failed and the lastError flush also failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          )
        }
        emitError(`cron job ${id} delivery failed`, err)
      }
    } finally {
      if (!rescheduledByBackoff) scheduleJob(id)
    }
  }

  /** single-flight: concurrent ticks of one job run only one; later arrivals reuse the in-flight Promise. */
  const tickJob = (id: string): Promise<void> => {
    const existing = inflight.get(id)
    if (existing) return existing
    const task = runJobTick(id).finally(() => inflight.delete(id))
    inflight.set(id, task)
    return task
  }

  /** Reschedule one job's timer; disabled/deleted jobs do not schedule; notBefore is the lower bound of the trigger time
   * (for decision-failure backoff, preventing a hot loop on an expired nextRunAt). */
  const scheduleJob = (id: string, notBefore?: number): void => {
    if (stopping) return
    timers.get(id)?.clear()
    timers.delete(id)
    let job: CronJob | undefined
    try {
      job = readDoc().jobs.find((j) => j.id === id)
    } catch (err) {
      emitError(`cron job ${id} failed to read scheduling state`, err)
      return
    }
    if (!job || !job.enabled) return
    if (job.nextRunAt === undefined) {
      emitError(
        `cron job ${id} has no next time`,
        new HelmError('cron_no_next_time', `schedule=${job.schedule} has no future matching point in ${job.timezone}`, 500, {
          id,
          schedule: job.schedule,
        }),
      )
      return
    }
    const at = notBefore === undefined ? job.nextRunAt : Math.max(job.nextRunAt, notBefore)
    const delayMs = Math.max(0, at - clock.now())
    // Ultra-long delays wake within the safe window first, then reschedule (an undued decision is a noop reschedule); unref'd so it never blocks exit
    const handle = clock.setTimeout(() => {
      timers.delete(id)
      void tickJob(id).catch((err) => emitError(`cron job ${id} tick exception`, err))
    }, Math.min(delayMs, MAX_TIMEOUT_MS))
    timers.set(id, handle)
  }

  // ---- actions: HTTP / CLI / Agent Tool / Workflow -- equal on five ends ----

  ctx.action({
    id: 'cron_list',
    description: 'List all cron jobs (incl. lastRunAt/nextRunAt/lastError scheduling state)',
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { jobs: { type: 'array', items: { type: 'object' } } },
      required: ['jobs'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'list'] },
    handler: () => ({ jobs: readDoc().jobs.map((job) => jsonClone(job)) }),
  })

  ctx.action({
    id: 'cron_create',
    description: 'Create a cron job (standard five fields: min hour day month weekday; id/schedule/text required; timezone defaults to UTC)',
    promptGuidelines: [
      'schedule is a standard five-field periodic cron (min hour day month weekday, e.g. "*/30 * * * *"), not an arbitrary shell timer: triggering only delivers the text to the target conversation',
      'timezone uses an IANA zone name (e.g. Asia/Shanghai; defaults to UTC); set targetConversationId or targetProfileId per the user intent (mutually exclusive); when unspecified, trigger routing resolves the target',
      'text will be delivered to the target conversation in the future; spell out the task content and necessary conditions, avoiding reliance on implicit here-and-now information',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        schedule: { type: 'string' },
        text: { type: 'string', minLength: 1 },
        description: { type: 'string', maxLength: 500 },
        timezone: { type: 'string' },
        enabled: { type: 'boolean' },
        catchUp: { type: 'boolean' },
        targetConversationId: { type: 'integer', minimum: 1 },
        targetProfileId: { type: 'string', minLength: 1 },
        threadKey: { type: 'string', minLength: 1 },
      },
      required: ['id', 'schedule', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { job: { type: 'object' } },
      required: ['job'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'create'] },
    handler: async (input: Record<string, unknown>) => {
      const job = normalizeCronInput(input as Parameters<typeof normalizeCronInput>[0])
      const now = clock.now()
      const nextRunAt = nextFireTime(job.schedule, job.timezone, now)
      if (nextRunAt === undefined) {
        throw new HelmError(
          'cron_no_next_time',
          `cron schedule has no future matching point in ${job.timezone}; creation refused: ${job.schedule}`,
          400,
          { id: job.id, schedule: job.schedule, timezone: job.timezone },
        )
      }
      const current = readDoc()
      if (current.jobs.some((j) => j.id === job.id)) {
        throw new HelmError('cron_duplicate_id', `cron job already exists: ${job.id}`, 409, { id: job.id })
      }
      const created: CronJob = { ...job, nextRunAt }
      await writeDoc({ version: 1, jobs: [...current.jobs, created] })
      if (created.enabled) scheduleJob(created.id)
      return { job: jsonClone(created) }
    },
  })

  ctx.action({
    id: 'cron_delete',
    description: 'Delete a cron job (in-flight deliveries end naturally; nothing revives)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'delete'] },
    handler: async (input: { id: string }) => {
      const current = readDoc()
      if (!current.jobs.some((j) => j.id === input.id)) {
        throw new HelmError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      }
      // Stop the timer first, then persist the deletion; a concurrent tick's (id, rev) check silently ends on a
      // generation change -- a deleted job can never revive
      timers.get(input.id)?.clear()
      timers.delete(input.id)
      await writeDoc({ version: 1, jobs: current.jobs.filter((j) => j.id !== input.id) })
      return { deleted: true }
    },
  })

  ctx.action({
    id: 'cron_trigger',
    description: 'Manually trigger a cron job once now (a real delivery; failures throw without affecting later scheduled runs)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { triggered: { type: 'boolean' } },
      required: ['triggered'],
      additionalProperties: false,
    },
    cli: { command: ['cron', 'trigger'] },
    handler: async (input: { id: string }) => {
      // Manual triggering only reads a snapshot + delivers for real, writing no doc: no claim/lastError write-back,
      // hence no delete+create same-id pollution surface; the deletion race is backstopped by the read-time existence check.
      const job = readDoc().jobs.find((j) => j.id === input.id)
      if (!job) throw new HelmError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      const envelope = { ...buildCronEnvelope(job, clock.now()), id: `cron:${job.id}:manual:${randomUUID()}` }
      await deps.dispatchTrigger(envelope, job.targetProfileId)
      return { triggered: true }
    },
  })

  // ---- service: timer lifecycle (stop cancels timers and waits for in-flight deliveries) ----

  ctx.service({
    id: 'cron-scheduler',
    liveTasks() {
      return [...inflight.keys()].map((id) => `cron-dispatch:${id}`)
    },
    /** Persistent occupancy declaration: enabled cron jobs are occupancy items of the disable precheck (plugin_in_use). */
    inUse() {
      const jobs = parseCronDoc(doc.get()).jobs.filter((j) => j.enabled)
      return jobs.map((j) => ({
        kind: 'cron_job',
        id: j.id,
        label: `cron job "${j.id}" (${j.schedule})`,
      }))
    },
    async start() {
      stopping = false
      try {
        const current = readDoc()
        // Validate all plans at the startup boundary; on failure publish no timer and never pretend enablement succeeded.
        for (const job of current.jobs) {
          assertValidSchedule(job.schedule, job.timezone)
          if (job.enabled && job.nextRunAt === undefined) {
            throw new HelmError('cron_doc_corrupt', `enabled cron job ${job.id} is missing nextRunAt`, 500, { id: job.id })
          }
        }
        const now = clock.now()
        for (const job of current.jobs) {
          // Restart and ordinary timer jitter handled separately: catchUp=false catches up none of the missed points.
          if (job.enabled && !job.catchUp && job.nextRunAt !== undefined && job.nextRunAt < now) {
            const nextRunAt = nextFireTime(job.schedule, job.timezone, now)
            if (nextRunAt === undefined) {
              throw new HelmError('cron_no_next_time', `cron job ${job.id} has no future matching point`, 500, { id: job.id })
            }
            await tryUpdateJob(job.id, job.rev, (value) => ({ ...value, nextRunAt }))
          }
        }
        for (const job of current.jobs) scheduleJob(job.id)
      } catch (err) {
        emitError('cron scheduling failed to start', err)
        throw err
      }
    },
    async stop() {
      stopping = true
      for (const handle of timers.values()) handle.clear()
      timers.clear()
      // Wait for in-flight dispatches to finish within bounds (liveTasks already made the host 409-block before disable;
      // this is a backstop wait, eliminating post-stop deliveries)
      const pending = [...inflight.values()]
      if (pending.length > 0) await Promise.allSettled(pending)
    },
  })

  return {
    async tickNow() {
      const current = readDoc()
      await Promise.all(current.jobs.filter((j) => j.enabled).map((j) => tickJob(j.id)))
    },
    async settle() {
      // Loop-wait until nothing is in flight (yielding one macrotask per round, covering the chained async segments
      // dispatch -> lastError write-back -> reschedule in failure paths)
      for (let i = 0; i < 100 && inflight.size > 0; i++) {
        await Promise.allSettled([...inflight.values()])
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultClock(): CronClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return { clear: () => clearTimeout(timer) }
    },
  }
}
