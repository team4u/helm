/**
 * runtime.ts -- the host half of a workflow run (execution orchestration).
 *
 * Ported from @tintinweb/pi-subagents v0.23.1 (MIT); helm adaptation points:
 * - Added host-side handling of the `action()` primitive: shares the same totally-ordered prefix
 *   ledger with agent (index assigned by call-initiation order); the handler only runs after
 *   `action_started` append+fsync succeeds, and the call promise resolves only after the terminal
 *   row is persisted; any write failure is fatal (side effects must not continue in an unaccountable
 *   state). On recovery, started-without-terminal is explicitly reported as `workflow_action_uncertain`; never auto-rerun.
 * - Prefix replay matches item by item (index+key+kind+ok): resumed rows no longer disable the prefix
 *   wholesale; confirmed-successful actions/agents are always reused, zero duplicate side effects.
 *   Cached sub-results can serve as the prefix source for later resume calls of the same script,
 *   but there is no live session: after a prefix mismatch, fail explicitly; never fabricate live continuation.
 * - The spawn seam faces helm's `WorkflowServiceHost` (the injectable agent_spawn hook adaptation
 *   lives in service.ts); the runtime itself keeps zero kernel dependencies and is independently testable.
 * - worker thread + vm double boundary: terminate can kill looping scripts; the vm bans dynamic code
 *   generation and non-deterministic APIs (see worker-source.ts). This is a terminability/determinism
 *   boundary, not a malicious-code security sandbox.
 * - label/resume handles are namespaced by scopeId (root = 0; omitted counts as root): nested
 *   workflow() same-named labels never interfere; a failed call registers a resume handle as soon
 *   as it has a conversationId / executionId; maxAttempts > 1 reuses the same attempt ring, retrying
 *   via resumeAgent, with the failure reason appended as an incremental block into the next attempt's prompt.
 *
 * Responsibility split (this file keeps only orchestration; the public export surface unchanged):
 * - runtime-types.ts: all type contracts (host seam / run options / worker message surface);
 * - runtime-validation.ts: boundary validation / args normalization / script validation and other pure
 *   functions and constants;
 * - runtime-control.ts: the concurrency semaphore + pause/skip/retry control board;
 * - runtime-recorder.ts: the best-effort agent-row ledger writer (ioErrors diagnostics);
 * - runtime-agent-handler.ts / runtime-action-handler.ts: the big handlers of the two call kinds (explicit dependency injection, semantics line-identical to before the split).
 */

import { Worker } from 'node:worker_threads'
import type { WorkflowJournalEntry } from './journal.js'
import type { WorkflowEntry } from './progress.js'
import { WORKER_SOURCE } from './worker-source.js'
import { JournalReplay } from './replay.js'
import {
  assertBoundarySafe,
  normalizeWorkflowArgs,
  unawaitedLaunchMessage,
  validateScript,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  workflowConcurrency,
} from './runtime-validation.js'
import { Semaphore } from './runtime-control.js'
import { AgentJournalRecorder } from './runtime-recorder.js'
import { handleAgentCall, type AgentCallContext } from './runtime-agent-handler.js'
import { handleActionCall, type ActionCallContext } from './runtime-action-handler.js'
import type {
  CompletedChild,
  RunWorkflowOptions,
  WorkflowRunResult,
  WorkflowScriptRef,
  WorkflowScriptSource,
  WorkerMessage,
} from './runtime-types.js'

/* Public surface re-exported as-is (existing import paths runtime.js / index.js unchanged). */
export {
  WorkflowRuntimeError,
  workflowConcurrency,
  assertBoundarySafe,
  normalizeWorkflowArgs,
  redactPlainValue,
  validateScript,
  precheckScriptSyntax,
  MAX_SCRIPT_LENGTH,
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  WORKFLOW_NESTED_CAP,
  MAX_AGENT_ATTEMPTS,
  scopedResumeKey,
  agentRetryPrompt,
} from './runtime-validation.js'
export type {
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
  WorkflowGateResult,
  WorkflowScriptRef,
  WorkflowScriptSource,
  WorkflowHost,
  ResumeAgentOptions,
  RunWorkflowOptions,
  WorkflowRunResult,
} from './runtime-types.js'

/** Ledger append input -- see journal.ts for the authoritative definition (this legacy alias only serves references inside this file). */
export type { JournalWriteInput } from './journal.js'

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options

  const normalizedArgs = normalizeWorkflowArgs(options.args)
  assertBoundarySafe(normalizedArgs, 'args')

  const { meta, body } = validateScript(script)
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP
  const semaphore = new Semaphore(options.concurrency ?? workflowConcurrency())

  const progress: WorkflowEntry[] = []
  const inflight = new Set<string>()
  const completedByLabel = new Map<string, CompletedChild>()
  const openLaunches = new Map<number, string>()
  /** Run-level shared counters (agent/action handlers and respond/finish read/write the same object). */
  const counters = { agentCount: 0, replayedCount: 0, spentOutputTokens: 0 }
  let callIndex = 0
  let aborted = false
  let settled = false

  /* --- resume state ---------------------------------------------------- */

  const journalEntries: readonly WorkflowJournalEntry[] = options.journal?.entries ?? []
  const inPlaceResume = options.journal?.inPlaceResume === true
  const appendJournal = options.journal?.append
  const redactText = options.redact ?? ((text: string) => text)
  const replay = new JournalReplay(journalEntries)
  const recorder = new AgentJournalRecorder(appendJournal, redactText)
  const unsettledNativeCoords = new Set<string>(
    inPlaceResume
      ? replay
          .unsettledStartedAgents()
          .filter((e) => e.execution.conversationId !== undefined && e.execution.executionId === undefined)
          .map((e) => JSON.stringify([e.scopePath, e.scopeCallIndex, e.attempt ?? 1]))
      : [],
  )
  let reattachHorizonFired = false
  const fireReattachHorizon = () => {
    if (reattachHorizonFired) return
    reattachHorizonFired = true
    options.onReattachHorizon?.()
  }
  const markNativeReattachResolved = (coordKey: string) => {
    unsettledNativeCoords.delete(coordKey)
    if (unsettledNativeCoords.size === 0) fireReattachHorizon()
  }
  if (unsettledNativeCoords.size === 0) fireReattachHorizon()

  const allocateIndex = () => callIndex++

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaJson: JSON.stringify(meta),
      argsJson: normalizedArgs === undefined ? undefined : JSON.stringify(normalizedArgs),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  })

  return await new Promise<WorkflowRunResult>((resolve) => {
    const emit = (entries: WorkflowEntry[]) => {
      if (entries.length === 0) return
      progress.push(...entries)
      options.onProgress?.(entries)
    }

    const respond = (
      callId: number,
      ok: boolean,
      value?: unknown,
      error?: string,
      fatal?: boolean,
    ) => {
      openLaunches.delete(callId)
      if (settled) return
      // Fatal errors belong to the whole run; the script must not catch them, and later concurrent messages must not bypass side-effect protection.
      if (fatal) {
        finish({ status: 'failed', error: error ?? 'Fatal workflow error.' })
        return
      }
      worker.postMessage({ type: 'response', callId, ok, value, error, fatal, spent: counters.spentOutputTokens })
    }

    const isSuspended = () => options.isSuspended?.() === true

    const finish = (
      result: Omit<WorkflowRunResult, 'meta' | 'progress' | 'agentCount' | 'replayedCount'>,
    ) => {
      if (settled) return
      settled = true
      fireReattachHorizon()
      options.signal?.removeEventListener('abort', onAbort)
      if (!isSuspended()) {
        for (const agentId of inflight) host.abortAgent(agentId)
      }
      inflight.clear()
      semaphore.drain()
      const settle = () =>
        resolve({ ...result, meta, progress, agentCount: counters.agentCount, replayedCount: counters.replayedCount, ...(recorder.ioErrors.length > 0 ? { journalIoErrors: [...recorder.ioErrors] } : {}) })
      void worker.terminate().then(settle, settle)
    }

    function onAbort() {
      aborted = true
      // terminate() is why the worker layer exists: it can stop a script even while it spins or is stuck mid-await.
      finish({ status: 'killed', error: isSuspended() ? 'Workflow suspended.' : 'Workflow aborted.' })
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const runState = { isAborted: () => aborted, isSettled: () => settled, isSuspended }

    const agentCtx: AgentCallContext = {
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      inPlaceResume,
      host,
      agentCap,
      retryFailedCalls: options.journal?.retryFailedCalls === true,
      runState,
      emit,
      respond,
      allocateIndex,
      recordAgent: (entry) => recorder.record(entry),
      recordAgentStarted: (entry) => recorder.recordStarted(entry),
      markNativeReattachResolved,
      inflight,
      semaphore,
      completedByLabel,
      openLaunches,
      replay,
      counters,
      redactText,
    }
    const actionCtx: ActionCallContext = {
      host,
      signal: options.signal,
      inPlaceResume,
      runState,
      emit,
      respond,
      allocateIndex,
      openLaunches,
      replay,
      semaphore,
      counters,
      appendJournal,
      redactText,
    }

    async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
      const loadWorkflow = host.loadWorkflow?.bind(host)
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run nested workflows.', true)
        return
      }
      let source: WorkflowScriptSource
      try {
        source = await loadWorkflow(ref)
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
        return
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message)
        return
      }
      try {
        const child = validateScript(source.script)
        respond(callId, true, {
          name: child.meta.name,
          metaJson: JSON.stringify(child.meta),
          body: child.body,
        })
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
      }
    }

    worker.on('message', (message: WorkerMessage) => {
      if (settled) return
      try {
      switch (message.type) {
        case 'progress':
          emit(message.entries)
          break
        case 'call':
          if (message.method === 'workflow') {
            void handleLoadWorkflow(message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          if (message.method === 'action') {
            void handleActionCall(actionCtx, message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          void handleAgentCall(agentCtx, message.callId, message.payload).catch((error: unknown) => {
            finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
          })
          break
        case 'complete': {
          const unawaited = [...openLaunches.values()]
          if (unawaited.length > 0) {
            finish({ status: 'failed', error: unawaitedLaunchMessage(unawaited) })
            break
          }
          finish({
            status: 'completed',
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          })
          break
        }
        case 'error':
          finish({ status: 'failed', error: message.message })
          break
      }
      } catch (outerError) {
        process.stderr.write(
          `WORKER-MSG-THROW: ${outerError instanceof Error ? outerError.stack : String(outerError)}\n`,
        )
        finish({
          status: 'failed',
          error: outerError instanceof Error ? outerError.message : String(outerError),
        })
      }
    })

    worker.on('error', (error) => {
      finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })

    worker.on('exit', () => {
      finish({ status: 'failed', error: 'Workflow worker exited before completing.' })
    })
  })
}
