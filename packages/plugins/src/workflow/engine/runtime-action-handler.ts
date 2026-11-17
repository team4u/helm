/**
 * runtime-action-handler.ts -- the host-side handler for `action(actionId, input)` calls.
 *
 * Extracted from runtime.ts's handleAction closure into an explicit dependency-injection module (semantics preserved line by line).
 *
 * Ordering contract: index is assigned at call initiation; the handler only runs after action_started
 * append+fsync succeeds; respond only after the terminal row (success result / failure error) is persisted.
 * Any ledger write failure is returned to the script as a fatal error -- side effects must not continue
 * in an unaccountable state. Completed (ok) action calls are replayed by reusing the result directly, never re-executed.
 *
 * action rows do not go through AgentJournalRecorder (agent rows are the best-effort face): here,
 * appendJournal rejections = JournalWriteError semantics, explicitly fatal at each write point.
 */

import { actionJournalKey, JournalWriteError, type JournalWriteInput } from './journal.js'
import type { WorkflowActionEntry, WorkflowEntry } from './progress.js'
import type { JournalReplay } from './replay.js'
import type { ActionCallPayload, ActionJournalInput, WorkflowHost } from './runtime-types.js'
import { assertBoundarySafe, preview, readCallScope, redactPlainValue } from './runtime-validation.js'
import { Semaphore } from './runtime-control.js'

/** All dependencies of handleActionCall (constructed by runWorkflow; field meanings in runWorkflow). */
export interface ActionCallContext {
  host: WorkflowHost
  signal: AbortSignal | undefined
  inPlaceResume?: boolean
  runState: { isAborted(): boolean; isSettled(): boolean; isSuspended?(): boolean }
  emit(entries: WorkflowEntry[]): void
  respond(callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void
  allocateIndex(): number
  openLaunches: Map<number, string>
  replay: JournalReplay
  semaphore: Semaphore
  /** Run-level counters shared with the agent handler (action only touches replayedCount). */
  counters: { replayedCount: number }
  /** The ledger append injected as-is (write failures throw JournalWriteError -> explicitly fatal here). */
  appendJournal: ((entry: JournalWriteInput) => Promise<void> | void) | undefined
  redactText: (text: string) => string
}

export async function handleActionCall(ctx: ActionCallContext, callId: number, payload: ActionCallPayload): Promise<void> {
  const scope = readCallScope(payload)
  const recordAction = (entry: ActionJournalInput) => ctx.appendJournal?.({ ...entry, ...scope })
  const index = ctx.allocateIndex()
  ctx.openLaunches.set(callId, payload.actionId)
  const queuedAt = Date.now()

  const base: WorkflowActionEntry = {
    type: 'workflow_action',
    index,
    actionId: payload.actionId,
    state: 'start',
    queuedAt,
    ...(payload.label !== undefined ? { label: payload.label } : {}),
    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
  }
  ctx.emit([{ ...base }])

  try {
    let serializedInput: string
    try {
      assertBoundarySafe(payload.input, `action('${payload.actionId}') input`)
      serializedInput = JSON.stringify(payload.input ?? {})
    } catch (error) {
      ctx.openLaunches.delete(callId)
      ctx.respond(
        callId,
        false,
        undefined,
        `action('${payload.actionId}') input is not JSON-safe: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      )
      return
    }
    const key = actionJournalKey(payload.actionId, serializedInput)

    const replayed = ctx.replay.match(scope, key, 'action')
    if (replayed.conflictError !== undefined) {
      ctx.openLaunches.delete(callId)
      ctx.respond(callId, false, undefined, replayed.conflictError, true)
      return
    }

    if (replayed.hit && replayed.entry !== undefined && replayed.entry.type === 'action') {
      ctx.counters.replayedCount++
      const at = Date.now()
      const resultText = JSON.stringify(replayed.entry.result ?? null)
      ctx.emit([
        {
          ...base,
          startedAt: at,
          lastProgressAt: at,
          durationMs: 0,
          state: 'done',
          cached: true,
          resultPreview: preview(resultText),
        },
      ])
      ctx.openLaunches.delete(callId)
      // Only backfill the terminal row (no side effect happened; no started guard row needed).
      // A backfill failure is fatal: silently tolerating it would leave the new run's ledger missing
      // this action's terminal state -- the next resume could not reuse it and might re-execute side effects.
      // An unwritable ledger = unsafely accountable = cannot continue.
      const effectiveReplayedIdempotent = payload.idempotent ?? (replayed.entry.idempotent === true)
      if (ctx.inPlaceResume !== true) {
        try {
          await recordAction({
            type: 'action',
            index,
            key,
            ok: true,
            result: redactPlainValue(replayed.entry.result, ctx.redactText),
            ...(effectiveReplayedIdempotent ? { idempotent: true } : {}),
          })
        } catch (error) {
          const message =
            error instanceof JournalWriteError
              ? error.message
              : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
          ctx.respond(
            callId,
            false,
            undefined,
            `workflow journal replay bookkeeping failed; aborting to keep the run resumable: ${message}`,
            true,
          )
          return
        }
      }
      ctx.replay.consumeAction(replayed.entry)
      ctx.respond(callId, true, replayed.entry.result ?? null)
      return
    }

    // Cache miss: must wait for a concurrency permit before live execution (cache hits do not occupy the semaphore)
    await ctx.semaphore.acquire()
    if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
      ctx.semaphore.release()
      ctx.openLaunches.delete(callId)
      ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
      return
    }

    try {
      if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
        ctx.openLaunches.delete(callId)
        ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }

      // Pre-flight checks
      let prepared: { pluginId: string; actionId: string; idempotent?: boolean } | undefined
      if (ctx.host.prepareAction !== undefined) {
        try {
          prepared = await ctx.host.prepareAction(payload.actionId, payload.input ?? {}, {
            index,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          })
        } catch (error) {
          if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
            ctx.openLaunches.delete(callId)
            ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
            return
          }
          const errMsg = error instanceof Error ? error.message : String(error)
          try {
            await recordAction({
              type: 'action',
              index,
              key,
              ok: false,
              idempotent: true,
              error: ctx.redactText(errMsg),
            })
          } catch (jErr) {
            const message =
              jErr instanceof JournalWriteError
                ? jErr.message
                : `workflow journal append failed: ${jErr instanceof Error ? jErr.message : String(jErr)}`
            ctx.openLaunches.delete(callId)
            ctx.respond(callId, false, undefined, `workflow_action_uncertain: ${message}`, true)
            return
          }
          const finishedAt = Date.now()
          ctx.emit([
            {
              ...base,
              startedAt: queuedAt,
              lastProgressAt: finishedAt,
              durationMs: finishedAt - queuedAt,
              state: 'error',
              error: errMsg,
            },
          ])
          ctx.openLaunches.delete(callId)
          ctx.respond(callId, true, null)
          return
        }
      }

      if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
        ctx.openLaunches.delete(callId)
        ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }

      const effectiveIdempotent = payload.idempotent ?? (prepared?.idempotent === true)

      // Only record startedAt and persist the started intent row after the permit is acquired and preflight completes
      const startedAt = Date.now()
      try {
        await recordAction({
          type: 'action_started',
          index,
          key,
          ...(effectiveIdempotent ? { idempotent: true } : {}),
        })
      } catch (error) {
        const message =
          error instanceof JournalWriteError
            ? error.message
            : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
        ctx.openLaunches.delete(callId)
        ctx.respond(callId, false, undefined, `workflow_action_uncertain: ${message}`, true)
        return
      }

      if (ctx.runState.isAborted() || ctx.runState.isSettled()) return
      ctx.emit([{ ...base, startedAt, lastProgressAt: startedAt }])

      let outcome: { ok: true; result: unknown } | { ok: false; error: string }
      try {
        const invoked = await ctx.host.invokeAction(payload.actionId, payload.input ?? {}, {
          index,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        assertBoundarySafe(invoked.result, `action('${payload.actionId}') result`)
        outcome = { ok: true, result: invoked.result }
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        ctx.openLaunches.delete(callId)
      }

      if (ctx.runState.isSettled() || (ctx.runState.isSuspended?.() === true && !outcome.ok)) {
        return
      }
      const finishedAt = Date.now()
      // respond only after the terminal row is persisted (fsync); a write failure = executed but unaccountable, explicitly uncertain.
      try {
        await recordAction(
          outcome.ok
            ? {
                type: 'action',
                index,
                key,
                ok: true,
                result: redactPlainValue(outcome.result, ctx.redactText),
                ...(effectiveIdempotent ? { idempotent: true } : {}),
              }
            : {
                type: 'action',
                index,
                key,
                ok: false,
                error: ctx.redactText(outcome.error),
                ...(effectiveIdempotent ? { idempotent: true } : {}),
              },
        )
      } catch (error) {
        const message =
          error instanceof JournalWriteError
            ? error.message
            : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
        ctx.respond(
          callId,
          false,
          undefined,
          outcome.ok
            ? `workflow_action_uncertain: action executed but its outcome could not be journaled (${message}). The side effect may have happened; do not re-run blindly.`
            : `workflow_action_uncertain: action failed and the failure could not be journaled (${message}).`,
          true,
        )
        return
      }

      if (outcome.ok) {
        const resultText = JSON.stringify(outcome.result)
        ctx.emit([
          {
            ...base,
            startedAt,
            lastProgressAt: finishedAt,
            durationMs: finishedAt - startedAt,
            state: 'done',
            resultPreview: preview(resultText),
          },
        ])
        ctx.respond(callId, true, outcome.result)
        return
      }
      ctx.emit([
        {
          ...base,
          startedAt,
          lastProgressAt: finishedAt,
          durationMs: finishedAt - startedAt,
          state: 'error',
          error: outcome.error,
        },
      ])
      // Failures fold into null per agent semantics (pipeline/parallel swallow errors into null).
      ctx.respond(callId, true, null)
    } finally {
      ctx.semaphore.release()
    }
  } catch (unhandledError) {
    ctx.openLaunches.delete(callId)
    ctx.respond(
      callId,
      false,
      undefined,
      `Action execution unexpected error: ${unhandledError instanceof Error ? unhandledError.message : String(unhandledError)}`,
      true,
    )
  }
}
