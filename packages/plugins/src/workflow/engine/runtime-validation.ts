/**
 * runtime-validation.ts -- the runtime's pure-function layer: boundary validation / parameter normalization /
 * script validation / stateless helpers and run-limit constants.
 *
 * Split out of runtime.ts (semantics preserved line by line; zero state, zero worker dependency,
 * deterministic, independently unit-testable). These functions serve three roles at once:
 * - the host-side JSON boundary (the worker message surface is untrusted; re-validate at the handler boundary);
 * - call-parameter normalization and pre-save script prechecks (validateScript / precheckScriptSyntax);
 * - value-level redaction before the persistent face, preview truncation, and derived tools like ledger keys / resume handles.
 */

import { cpus } from 'node:os'
import { Script } from 'node:vm'
import { hasValidScopeIdentity, type JournalAgentExecution } from './journal.js'
import type { CompiledSchema } from './json-schema.js'
import { extractMeta, type WorkflowMeta } from './meta.js'
import type { WorkflowAgentEntry } from './progress.js'
import type { ReplayScope } from './replay.js'
import type { WorkflowGateResult, WorkflowHost, WorkflowSpawnResult } from './runtime-types.js'

/** Script length cap (512KB). */
export const MAX_SCRIPT_LENGTH = 524_288

/** Cap on total agents schedulable by a single run. */
export const WORKFLOW_AGENT_CAP = 1000

/** Cap on item count per parallel()/pipeline(). */
export const WORKFLOW_ITEM_CAP = 4096

/** Cap on total nested workflow() calls. */
export const WORKFLOW_NESTED_CAP = 256

/** Auto-retry cap per agent() call (design §2.2: 1..10; default 1 = no auto retry). */
export const MAX_AGENT_ATTEMPTS = 10

/** Prompt/result preview length kept for the UI. */
const PREVIEW_LENGTH = 200

export class WorkflowRuntimeError extends Error {}

/**
 * Concurrent agents: leave two cores for the host thread. The `Math.max(1,…)` is not decoration --
 * on single/dual-core machines a bare `min(16, cpus-2)` is 0, and a zero-permit semaphore would deadlock the run before its first agent.
 */
export function workflowConcurrency(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(16, cpuCount - 2))
}

/* ------------------------------------------------------------------------- *
 * JSON boundary (host side)
 * ------------------------------------------------------------------------- */

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(`Cannot pass ${what} across the workflow VM boundary (at ${path}).`)
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw boundaryError('a non-finite number', path)
    return
  }
  if (kind === 'undefined') {
    if (path === 'args') return
    throw boundaryError('undefined', path)
  }
  if (kind === 'bigint') throw boundaryError('a BigInt', path)
  if (kind === 'symbol') throw boundaryError('a symbol', path)
  if (kind === 'function') throw boundaryError('a function', path)
  if (kind !== 'object') throw boundaryError(`a ${kind}`, path)

  const object = value as object
  if (seen.has(object)) throw boundaryError('a circular structure', path)
  seen.add(object)

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError('an object with symbol keys', path)
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError('a sparse array', `${path}[${i}]`)
      walk(object[i], `${path}[${i}]`, seen)
    }
    seen.delete(object)
    return
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError('a non-plain object', path)
  }
  for (const [key, entry] of Object.entries(object)) {
    walk(entry, `${path}.${key}`, seen)
  }
  seen.delete(object)
}

/** Reject values that cannot survive the worker round-trip and replay ledger. */
export function assertBoundarySafe(value: unknown, path: string): void {
  walk(value, path, new Set())
}

/**
 * Normalize workflow args:
 * Models often serialize object/array tool arguments as JSON strings (e.g. '{"topics": ["a"]}').
 * Without deserialization, the value stays a string through the JSON.stringify + realmParse round-trip in the worker,
 * making args.items.map throw a TypeError inside the script.
 *
 * This function safely unwraps JSON object/array strings into real objects/arrays;
 * scalars (numbers, booleans, plain strings) and real objects/arrays are kept as-is.
 */
export function normalizeWorkflowArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw
  let current = raw
  // Unwrap at most 2 layers, defending against possible double JSON serialization on the model side
  for (let i = 0; i < 2 && typeof current === 'string'; i++) {
    const trimmed = current.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        current = JSON.parse(trimmed)
      } catch {
        break
      }
    } else if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        current = JSON.parse(trimmed)
      } catch {
        break
      }
    } else {
      break
    }
  }
  return current
}

/**
 * Value-level redaction for the persistent face (lenient traversal, only for engine-internal values that passed boundary checks):
 * recursively clone and pass every string value through redactText (e.g. stash secret -> marker).
 * Never stringify-then-replace wholesale -- secrets nested deep must be treated equally.
 * Values outside the boundary-safe set (plain objects/arrays/scalars) are returned as-is.
 *
 * Semantics differ from @helmx/protocol's redactJsonValue (the strict version, which rejects
 * cycles/sparse/non-plain objects and redacts key names): this function targets the engine's
 * already-trusted internal persistent face, does not redact key names, and returns non-plain objects as-is.
 * Named distinctly to avoid misuse.
 */
export function redactPlainValue(value: unknown, redactText: (text: string) => string): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactPlainValue(item, redactText))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redactPlainValue(entry, redactText)
    return out
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * Call-payload derivation tools (shared at handler boundaries)
 * ------------------------------------------------------------------------- */

/** All characters below 0x20 except tab/newline/cr, plus DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Prompt/result preview kept in progress rows (truncated with an ellipsis when too long). */
export const preview = (text: string) =>
  text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`

export function readCallScope(payload: ReplayScope): ReplayScope {
  if (!hasValidScopeIdentity(payload)) throw new WorkflowRuntimeError('Workflow call scope identity is invalid.')
  return { scopePath: payload.scopePath, scopeCallIndex: payload.scopeCallIndex }
}

export function derivedLabel(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim()
  return line.length <= 60 ? line || 'agent' : `${line.slice(0, 59)}…`
}

/**
 * attachments shape validation at the host boundary: a string array whose items are non-empty and not pure whitespace; an empty array is legal.
 * The worker layer already rejects isomorphically; this is one more interception since the message surface is untrusted (invalid values are fatal, never sent to the host).
 */
export function isValidAttachments(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((id) => typeof id === 'string' && id.trim() !== '')
}

/** secretNames isomorphic boundary check: a non-empty string array (env-var name shape is uniformly validated at the kernel spawn boundary). */
export function isValidSecretNames(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((name) => typeof name === 'string' && name.trim() !== '')
}

/**
 * The resume registration key of the scopeId namespace (root scope = 0; an omitted scopeId counts as root,
 * consistent with the legacy bare-label semantics -- calls without a scope all land in the root namespace).
 */
export function scopedResumeKey(scopeId: number | undefined, label: string): string {
  return `${scopeId ?? 0}:${label}`
}

/**
 * The next attempt's prompt on auto retry: original text + an incremental failure block. The resumed
 * sub-conversation is the same one; historical failures are already in the conversation context, so only
 * the latest reason is appended, never accumulated.
 */
export function agentRetryPrompt(originalPrompt: string, failedAttempt: number, reason: string): string {
  return `${originalPrompt}\n\n[attempt ${failedAttempt} failed]\n${reason}\nFix the problem above and complete the original task.`
}

/** Extract persistent-face execution metadata from a progress row (undefined when no fields). */
export function executionInfoForMeta(base: WorkflowAgentEntry): JournalAgentExecution | undefined {
  if (base.nodeId === undefined && base.conversationId === undefined && base.executionId === undefined && base.effectiveCwd === undefined && base.worktree === undefined) return undefined
  return {
    ...(base.nodeId !== undefined ? { nodeId: base.nodeId } : {}),
    ...(base.conversationId !== undefined ? { conversationId: base.conversationId } : {}),
    ...(base.executionId !== undefined ? { executionId: base.executionId } : {}),
    ...(base.effectiveCwd !== undefined ? { effectiveCwd: base.effectiveCwd } : {}),
    ...(base.worktree !== undefined ? { worktree: base.worktree } : {}),
  }
}

/** Structured-output contract recheck (the same standard for cache hits and fresh results). */
export function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.text ?? '')
  } catch {
    return {
      ...result,
      ok: false,
      error: 'The agent did not return structured output: its answer was not JSON.',
    }
  }
  const verdict = compiled.check(parsed)
  if (verdict === true) return result
  return {
    ...result,
    ok: false,
    error: `The agent's answer did not match the requested schema: ${verdict}`,
  }
}

/**
 * Host-side honoring of gate-exactly-once: prefer the execution environment's report (onGateResult -> reported /
 * result.gate), otherwise the host runs the fallback itself; write the verdict back into the progress row
 * and rewrite the call result as needed.
 */
export async function applyGate(
  result: WorkflowSpawnResult,
  command: string,
  agentId: string,
  runGate: NonNullable<WorkflowHost['runGate']> | undefined,
  reported?: WorkflowGateResult,
  gateTimeoutMs?: number,
  effectiveCwd?: string,
): Promise<WorkflowSpawnResult> {
  const outcome =
    reported ??
    result.gate ??
    (await runGate!(command, {
      agentId,
      ...((result.cwd ?? effectiveCwd) !== undefined ? { cwd: result.cwd ?? effectiveCwd } : {}),
      ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
    }))
  const kept = { ...result, gate: outcome, ...(outcome.timedOut === true ? { timedOut: true } : {}) }
  if (outcome.ok) return kept
  const { text: _discarded, ...rest } = kept
  const output = outcome.output.trim()
  if (output !== '') return { ...rest, ok: false, error: output }
  // When output is empty, use a structured reason to distinguish timeout/exit code for retry prompts and user diagnostics.
  const detail =
    outcome.timedOut === true
      ? `Gate command timed out: ${command}`
      : outcome.exitCode !== undefined && outcome.exitCode !== null
        ? `Gate command failed with exit code ${outcome.exitCode}: ${command}`
        : `Gate command failed: ${command}`
  return { ...rest, ok: false, error: detail }
}

export function unawaitedLaunchMessage(labels: readonly string[]): string {
  const list = labels.map((label) => `'${label}'`).join(', ')
  return `workflow script completed with unawaited launch(es): ${list}. Await or return each launch.`
}

/* ------------------------------------------------------------------------- *
 * Script validation (the same standard for top-level runs and nested workflow())
 * ------------------------------------------------------------------------- */

/** Everything that must hold before a script compiles (same standard for top-level runs and nested workflow()). */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new WorkflowRuntimeError(
      `Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`,
    )
  }
  if (CONTROL_CHARACTERS.test(script)) {
    throw new WorkflowRuntimeError(
      'Workflow script contains control characters. Only tab, carriage return and newline are allowed.',
    )
  }
  return extractMeta(script)
}

/**
 * Pure syntax precheck before saving a definition (deterministic, zero side effects):
 * - validateScript's full boundary (length / control characters / meta pure literal);
 * - a compile-only compilation check with the exact wrapper shape used by the worker -- only new Script,
 *   no runInContext, executing no script body statements, producing no side effects. PRELUDE is a fixed
 *   legal prefix separated from the body by a newline; removing it does not change the body's own syntax verdict.
 */
export function precheckScriptSyntax(script: string): { meta: WorkflowMeta; body: string } {
  const { meta, body } = validateScript(script)
  try {
    new Script(`(async () => {\n${body}\n})()`, {
      filename: 'workflow-syntax-precheck.js',
      lineOffset: -1,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkflowRuntimeError(`Workflow script has a syntax error: ${detail}`)
  }
  return { meta, body }
}
