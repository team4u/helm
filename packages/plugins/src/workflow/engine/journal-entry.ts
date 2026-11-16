/**
 * journal-entry.ts -- ledger row contracts: row types, row-level shape validation and call key fingerprints.
 *
 * Split out of journal.ts (semantics preserved line by line): a pure-function, zero-file-IO type module --
 * - row types (JournalWriteInput / WorkflowJournalEntry etc.) are the single authoritative declaration
 *   of the engine's private ledger format; the row-level shape validators are reused by journal.ts's
 *   readJournal for row-by-row adjudication (hasValidScopeIdentity is also the shared validation face
 *   at the replay / handler boundaries);
 * - agentJournalKey / actionJournalKey compute the replay fingerprint of a call within its scope
 *   (the canonical fixed-slot versioning rule is in the agentJournalKey header comment).
 */

import { createHash } from 'node:crypto'

/**
 * Input for append writes (seq/v assigned by the writer).
 * Declared explicitly per variant rather than `Omit<Union, 'v'|'seq'>` -- Omit does not distribute
 * and would strip agent/action's own legal fields (ok/text/result...) off the union.
 */
export interface JournalScope {
  scopePath: string
  scopeCallIndex: number
}

export type JournalWriteInput = JournalScope & (
  | {
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      resumed?: true
      /** Execution metadata snapshot (agent.withMeta's preserved failure face): redacted via redactJournalEntry before flushing. */
      execution?: JournalAgentExecution
      /** Gate result (returned on gate failure/timeout): redacted via redactJournalEntry before flushing. */
      gate?: JournalGateResult
      /** Auto-retry attempt number; omitted means the first attempt. */
      attempt?: number
      /** The owning call's first index within this run, for auditing and progress folding. */
      invocationIndex?: number
      prompt?: string
      /** The current failure was retried manually. Auto retries follow maxAttempts. */
      retryKind?: 'manual'
      skipped?: boolean
      /** The failure reason (already redacted). */
      error?: string
      timedOut?: boolean
      seq?: number
    }
  | {
      type: 'action_started'
      index: number
      key: string
      seq?: number
      idempotent?: true
    }
  | {
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      seq?: number
      idempotent?: true
    }
)

/**
 * Execution metadata carried by agent rows (the persistent shape of AgentWithMetaResult['execution']).
 * worktree is a plugin contract object; the ledger only does JSON-object boundary validation without
 * interpreting business fields; on a replay cache hit it is restored to the caller as-is (values already redacted;
 */
export interface JournalAgentExecution {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: Record<string, unknown>
}

/** Gate result carried by agent rows (AgentGateResult's persistent shape; exitCode/timedOut are protocol-extension reserved slots). */
export interface JournalGateResult {
  ok: boolean
  output: string
  exitCode?: number | null
  timedOut?: boolean
}

/**
 * The engine's private prefix-replay ledger row (`dataDir/artifacts/<convId>/workflow-<runId>.jsonl`, one JSON object per line).
 *
 * This is the orchestration engine's recovery ledger, **not a public API data shape** (the former
 * protocol contract moved back into the engine):
 * - `seq` is the flush-order number (monotonically increasing within the engine); `index` is the
 *   call-initiation position (agent and action share the same total order).
 * - `scopePath` / `scopeCallIndex` are required recovery identity; `key` validates the actual payload;
 *   `attempt` distinguishes retries.
 *
 * - agent failure rows break the chain and live-retry (upstream semantics); confirmed action success/failure
 */
export type WorkflowJournalEntry = JournalScope & (
  | {
      v: 1
      seq: number
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      /** The call resumed an existing sub-conversation; actual resume semantics are validated at recovery. */
      resumed?: true
      /** Execution metadata snapshot (incl. worktree; redacted). Each maxAttempts attempt takes its own index row. */
      execution?: JournalAgentExecution
      /** Gate result (redacted). */
      gate?: JournalGateResult
      attempt?: number
      invocationIndex?: number
      prompt?: string
      retryKind?: 'manual'
      skipped?: boolean
      error?: string
      timedOut?: boolean
    }
  | {
      v: 1
      seq: number
      /** The action intent is flushed before execution (the handler may run only after fsync succeeds). */
      type: 'action_started'
      index: number
      key: string
      /** Declared-idempotent action: safe to rerun after interruption/failure; not counted as uncertain at recovery. */
      idempotent?: true
    }
  | {
      v: 1
      seq: number
      /** Action terminal row; when ok is true, result is the action output; when false, error is the failure reason. */
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      /** Consistent with the action_started row's idempotency declaration; recovery adjudication in readJournal. */
      idempotent?: true
    }
)

/** Key input of an agent call (all fields that determine what the agent does). */
export interface AgentJournalKeyInput {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  effort?: string
  isolation?: string
  /** Gate acceptance command: a changed command is a different call and must not hit an old cache. The fixed slot never collides with unlabeled variable slots. */
  gate?: string
  resume?: string
  /** The serialized form of agent({ schema }). */
  schema?: string
  /**
   * The artifact ID list of agent({ attachments }) (serialized as-is, no dedup or sort: different IDs or
   * order changes are different calls). Not provided differs from an empty array; no normalization. */
  attachments?: string[]
  /** A changed dispatch cap changes subagent behavior; cached results under the old grant must not replay. */
  maxSubagentDepth?: number
  /** A changed secret grant changes the external runtime environment; cached results under the old grant must not replay. */
  secretNames?: string[]
  /** Working directory (agent({ cwd })): a changed directory is a different execution context and must not hit an old cache. */
  cwd?: string
}

/**
 * The canonical version of agent call keys (v2 fixed slots).
 *
 * v1 (old ledgers) appended variable-length slots after the resume slot (an extra trailing slot when schema
 * was present). If attachments kept being appended at the tail, it would collide directly with v1's
 * schema tail slot: v1's `[p,l,m,t,e,i,g,r,schema]` and a hypothetical v2
 * `[p,l,m,t,e,i,g,r,schema?,attachments?]` would produce same-canonical-different-semantics collisions
 * across the four quadrants of schema present/absent x attachments present/absent.
 * Hence v2 converges in one step to versioned fixed slots: attachments always occupies slot 10 (null = not
 * provided), schema always slot 11 (null = not provided); any later new field may only be appended after
 * the version number. secretNames is appended as slot 13 (null = not provided; unconditionally slotted,
 * colliding with no old tail slot). v3 appends cwd as slot 14 (same unconditional rule): a changed cwd
 * changes the execution context (a child worktree can be spawned from that directory); cached results under
 * the old directory must not replay. Note: unconditional slotting makes **all call keys mismatch old
 * ledgers** after every version bump (including calls not carrying the new field) -- the dev period has no
 */
export function agentJournalKey(input: AgentJournalKeyInput): string {
  const canonical = JSON.stringify([
    'v3',
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    input.attachments !== undefined ? input.attachments : null,
    input.schema !== undefined ? input.schema : null,
    input.maxSubagentDepth ?? null,
    input.secretNames !== undefined ? input.secretNames : null,
    input.cwd !== undefined ? input.cwd : null,
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** The key of an action call: fully-qualified actionId + serialized input. */
export function actionJournalKey(actionId: string, serializedInput: string): string {
  return createHash('sha256').update(JSON.stringify(['action', actionId, serializedInput])).digest('hex').slice(0, 32)
}

function isAgentExecutionShape(value: unknown): value is JournalAgentExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'nodeId' && key !== 'conversationId' && key !== 'executionId' && key !== 'effectiveCwd' && key !== 'worktree') {
      return false
    }
  }
  if (e['nodeId'] !== undefined && typeof e['nodeId'] !== 'string') return false
  if (e['conversationId'] !== undefined && (!Number.isInteger(e['conversationId']) || (e['conversationId'] as number) < 1)) return false
  if (e['executionId'] !== undefined && typeof e['executionId'] !== 'string') return false
  if (e['effectiveCwd'] !== undefined && typeof e['effectiveCwd'] !== 'string') return false
  if (
    e['worktree'] !== undefined &&
    (typeof e['worktree'] !== 'object' || e['worktree'] === null || Array.isArray(e['worktree']))
  ) {
    return false
  }
  return true
}

function isAgentGateShape(value: unknown): value is JournalGateResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'ok' && key !== 'output' && key !== 'exitCode' && key !== 'timedOut') return false
  }
  if (typeof e['ok'] !== 'boolean' || typeof e['output'] !== 'string') return false
  if (e['exitCode'] !== undefined && e['exitCode'] !== null && !Number.isInteger(e['exitCode'])) return false
  if (e['timedOut'] !== undefined && typeof e['timedOut'] !== 'boolean') return false
  return true
}

export function hasValidScopeIdentity(value: unknown): value is JournalScope {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry['scopePath'] === 'string' && entry['scopePath'].length <= 4096 &&
    /^root(?:\/(?:0|[1-9][0-9]*))*$/.test(entry['scopePath']) &&
    Number.isSafeInteger(entry['scopeCallIndex']) && (entry['scopeCallIndex'] as number) >= 0
}

export function isAgentEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'agent' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'agent' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    (e['text'] === undefined || typeof e['text'] === 'string') &&
    (e['resumed'] === undefined || e['resumed'] === true) &&
    (e['attempt'] === undefined || (Number.isInteger(e['attempt']) && (e['attempt'] as number) >= 1)) &&
    (e['invocationIndex'] === undefined || (Number.isInteger(e['invocationIndex']) && (e['invocationIndex'] as number) >= 0 && (e['invocationIndex'] as number) <= (e['index'] as number))) &&
    (e['prompt'] === undefined || typeof e['prompt'] === 'string') &&
    (e['retryKind'] === undefined || e['retryKind'] === 'manual') &&
    (e['skipped'] === undefined || typeof e['skipped'] === 'boolean') &&
    (e['error'] === undefined || typeof e['error'] === 'string') &&
    (e['timedOut'] === undefined || typeof e['timedOut'] === 'boolean') &&
    (e['execution'] === undefined || isAgentExecutionShape(e['execution'])) &&
    (e['gate'] === undefined || isAgentGateShape(e['gate']))
  )
}

export function isActionStartedEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action_started' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'action_started' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    (e['idempotent'] === undefined || e['idempotent'] === true)
  )
}

export function isActionEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'action' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    (e['idempotent'] === undefined || e['idempotent'] === true)
  )
}
