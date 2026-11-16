/**
 * runtime-action-handler.ts — `action(actionId, input)` 调用的宿主侧 handler。
 *
 * 自 runtime.ts 的 handleAction 闭包提取为显式依赖注入模块（语义逐行保持）。
 *
 * 顺序契约：index 于调用发起时分配；action_started 追加+fsync 成功后才执行
 * handler；终态行（成功 result / 失败 error）落盘后才 respond。任何账本写
 * 失败都以 fatal 错误回给脚本——副作用不可在无法记账的状态下继续。
 * 已完成（ok）的 action 调用重放时直接复用 result，绝不重执行。
 *
 * action 行不走 AgentJournalRecorder（agent 行才是尽力而为面）：此处
 * appendJournal 的拒绝 = JournalWriteError 语义，由各写点显式 fatal。
 */

import { actionJournalKey, JournalWriteError, type JournalWriteInput } from './journal.js'
import type { WorkflowActionEntry, WorkflowEntry } from './progress.js'
import type { JournalReplay } from './replay.js'
import type { ActionCallPayload, ActionJournalInput, WorkflowHost } from './runtime-types.js'
import { assertBoundarySafe, preview, readCallScope, redactPlainValue } from './runtime-validation.js'
import { RuntimeControl, Semaphore } from './runtime-control.js'

/** handleActionCall 的全部依赖（由 runWorkflow 构造；字段含义见 runWorkflow）。 */
export interface ActionCallContext {
  host: WorkflowHost
  signal: AbortSignal | undefined
  runState: { isAborted(): boolean; isSettled(): boolean }
  emit(entries: WorkflowEntry[]): void
  respond(callId: number, ok: boolean, value?: unknown, error?: string, fatal?: boolean): void
  allocateIndex(): number
  openLaunches: Map<number, string>
  replay: JournalReplay
  semaphore: Semaphore
  control: RuntimeControl
  /** 与 agent handler 共享的 run 级计数（action 只动 replayedCount）。 */
  counters: { replayedCount: number }
  /** 原样注入的账本 append（写失败抛 JournalWriteError → 此处显式 fatal）。 */
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
      // 只补记终态行（无副作用发生，无需 started 守护行）。补记失败即 fatal：
      // 默默容忍会让新 run 账本缺失该 action 终态——下次 resume 无法复用，
      // 可能重执行副作用。账本不可写 = 不可安全记账 = 不可继续。
      const effectiveReplayedIdempotent = payload.idempotent ?? (replayed.entry.idempotent === true)
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
      ctx.replay.consumeAction(replayed.entry)
      ctx.respond(callId, true, replayed.entry.result ?? null)
      return
    }

    // 未命中缓存：必须等待并发许可后 live 执行（缓存命中不占 semaphore）
    for (;;) {
      await ctx.control.actionPauseGate()
      await ctx.semaphore.acquire()
      if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
        ctx.semaphore.release()
        ctx.openLaunches.delete(callId)
        ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }
      if (ctx.control.isPaused() && !ctx.runState.isAborted() && !ctx.runState.isSettled()) {
        ctx.semaphore.release()
        continue
      }
      break
    }

    try {
      if (ctx.runState.isAborted() || ctx.runState.isSettled()) {
        ctx.openLaunches.delete(callId)
        ctx.respond(callId, false, undefined, 'Workflow aborted.', true)
        return
      }

      // Pre-flight 预检
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

      // 许可取得并完成 preflight 后才记 startedAt 与落 started 意图行
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

      const finishedAt = Date.now()
      // 终态行落盘（fsync）之后才 respond；写失败 = 已执行但无法记账，显式不确定。
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
      // 失败照 agent 语义折叠为 null（pipeline/parallel 吞错为 null）。
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
