/**
 * Boundary validation for spawn execution metadata (AgentExecutionInfo / AgentGateResult)
 * (protocol public contract): onResolved / onGateResult are plugin (external product)
 * callbacks, and every consumer (kernel runtime / builtin plugins / external plugins)
 * must validate the shape field by field at the boundary — conversationId a positive
 * integer, executionId a non-empty string, effectiveCwd an absolute path, meta a
 * JSON-safe namespaced object — failing explicitly on invalid input, never trusting TS.
 *
 * The kernel envelope does not interpret the internal structure of meta namespaces
 * (business shapes such as worktree / control references are validated at their owner
 * plugin's own boundary with its schema; see the kernel-side shared contract module).
 *
 * This file has zero runtime dependencies (only HelmxError); internal and external plugins use it on equal footing.
 */
import { HelmxError } from './error.js'
import { sanitizeAgentNamespacedMeta } from './meta.js'
import type { AgentExecutionInfo, AgentGateResult } from './plugin-dto.js'

/** Whether the target path is absolute (POSIX leading /, Windows drive-absolute, or UNC leading backslash root). */
export function isAbsoluteAgentPath(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(p)
  )
}

function executionInfoError(agentId: string, reason: string): HelmxError {
  return new HelmxError(
    'execution_info_invalid',
    `onResolved callback from agent '${agentId}' is invalid: ${reason}`,
    502,
    { agentId, reason },
  )
}

/** Validate and clone the plugin-reported AgentExecutionInfo (rejects extra/malformed fields, preventing injection). */
export function sanitizeAgentExecutionInfo(
  value: unknown,
  context: { agentId: string },
): AgentExecutionInfo {
  const source = value as Partial<AgentExecutionInfo> | null
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw executionInfoError(context.agentId, 'callback payload must be an object')
  }
  const known = ['nodeId', 'conversationId', 'executionId', 'effectiveCwd', 'meta'] as const
  for (const key of Object.keys(source)) {
    if (!(known as readonly string[]).includes(key)) {
      throw executionInfoError(context.agentId, `unknown field "${key}"`)
    }
  }
  const out: AgentExecutionInfo = {}
  if (source.nodeId !== undefined) {
    if (typeof source.nodeId !== 'string' || source.nodeId.trim() === '') {
      throw executionInfoError(context.agentId, 'nodeId must be a non-empty string')
    }
    out.nodeId = source.nodeId
  }
  if (source.conversationId !== undefined) {
    const id = source.conversationId
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw executionInfoError(context.agentId, 'conversationId must be a positive integer')
    }
    out.conversationId = id
  }
  if (source.executionId !== undefined) {
    if (typeof source.executionId !== 'string' || source.executionId.length === 0) {
      throw executionInfoError(context.agentId, 'executionId must be a non-empty string')
    }
    out.executionId = source.executionId
  }
  if (source.effectiveCwd !== undefined) {
    if (typeof source.effectiveCwd !== 'string' || !isAbsoluteAgentPath(source.effectiveCwd)) {
      throw executionInfoError(context.agentId, 'effectiveCwd must be an absolute path')
    }
    out.effectiveCwd = source.effectiveCwd
  }
  if (source.meta !== undefined) {
    out.meta = sanitizeAgentNamespacedMeta(source.meta, {
      agentId: context.agentId,
      field: 'onResolved meta',
    })
  }
  if (out.conversationId === undefined && out.executionId === undefined) {
    throw executionInfoError(context.agentId, 'at least one of conversationId or executionId must be reported')
  }
  return out
}

/**
 * Validate and clone the plugin-reported AgentGateResult (rejects extra/malformed fields, preventing injection).
 * exitCode is optional (integer or null: timeout/kill leaves no knowable exit code); timedOut is an optional boolean.
 */
export function sanitizeAgentGateResult(
  value: unknown,
  context: { agentId: string },
): AgentGateResult {
  const source = value as Partial<AgentGateResult> | null
  const allowed = ['ok', 'output', 'exitCode', 'timedOut'] as const
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.ok !== 'boolean' ||
    typeof source.output !== 'string' ||
    Object.keys(source).some((key) => !(allowed as readonly string[]).includes(key))
  ) {
    throw new HelmxError(
      'gate_result_invalid',
      `onGateResult callback from agent '${context.agentId}' must be ` +
        `{ ok: boolean, output: string, exitCode?: number | null, timedOut?: boolean } ` +
        `and must not carry unknown fields`,
      502,
      { agentId: context.agentId },
    )
  }
  if (
    source.exitCode !== undefined &&
    source.exitCode !== null &&
    (typeof source.exitCode !== 'number' || !Number.isInteger(source.exitCode))
  ) {
    throw new HelmxError(
      'gate_result_invalid',
      `onGateResult callback from agent '${context.agentId}' must have exitCode as an integer or null, ` +
        `received ${String(source.exitCode)}`,
      502,
      { agentId: context.agentId, field: 'exitCode' },
    )
  }
  if (source.timedOut !== undefined && typeof source.timedOut !== 'boolean') {
    throw new HelmxError(
      'gate_result_invalid',
      `onGateResult callback from agent '${context.agentId}' must have timedOut as a boolean`,
      502,
      { agentId: context.agentId, field: 'timedOut' },
    )
  }
  const out: AgentGateResult = { ok: source.ok, output: source.output }
  if (source.exitCode !== undefined) out.exitCode = source.exitCode === null ? null : source.exitCode
  if (source.timedOut !== undefined) out.timedOut = source.timedOut
  return out
}

/** Explicit error for a missing gate report (the external execution environment ran but did not report; no local cwd-guessing re-run). */
export function agentGateResultMissingError(context: {
  agentId: string
  executionId?: string
  command: string
}): HelmxError {
  return new HelmxError(
    'gate_result_missing',
    `external execution environment (executionId='${context.executionId ?? 'unknown'}') did not report the gate result` +
      ` (agent '${context.agentId}', gate command: ${context.command.slice(0, 200)}); ` +
      'refusing to guess the remote working directory and re-run the gate locally — fix the external runtime to report onGateResult',
    502,
    { agentId: context.agentId, ...(context.executionId !== undefined ? { executionId: context.executionId } : {}), command: context.command },
  )
}
