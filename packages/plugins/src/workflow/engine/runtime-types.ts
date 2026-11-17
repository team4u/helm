/**
 * runtime-types.ts -- the type contracts of the workflow runtime (pure types, zero runtime code).
 */

import type { AgentExecutionInfo, AgentGateResult, AgentSpawnRequest } from '@helm/protocol'
import type { CompiledSchema } from './json-schema.js'
import type { WorkflowMeta } from './meta.js'
import type { JournalWriteInput, WorkflowJournalEntry } from './journal.js'
import type { WorkflowEntry } from './progress.js'
import type { ReplayScope } from './replay.js'

/** One agent call requested by a script. `agentId` is the host-side abort/resume handle. */
export interface WorkflowSpawnRequest {
  agentId: string
  /** This attempt's ledger position; progress entries are still identified by the owning call's first position. */
  index: number
  prompt: string
  label: string
  agentType: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  /** The execution handle from the ledger, carried across restart recovery. */
  resumeRef?: string
  /** 跨重启幂等提交键（如 `"helm:spawn:" + runId + ":" + scopePath + ":" + scopeCallIndex + ":" + attempt`）。 */
  requestId?: string
  /** 跨重启原位重挂目标（与 resume / fork 互斥）。 */
  reattach?: AgentSpawnRequest['reattach']
  /**
   * Returned once the execution environment is determined (applies to both native sub-conversations
   * and external runtimes): conversationId / executionId / effectiveCwd / worktree and other metadata
   * plus the actual model info. The engine writes the metadata into progress rows (never mixed into business output).
   */
  onResolved?(info: AgentExecutionInfo & {
    modelName?: string
    modelId?: string
    thinking?: string
    requestedThinking?: string
    requestedModel?: string
  }): void
  /** The gate result reported back after the gate has run exactly once inside the execution environment (exempt from a second run). */
  onGateResult?(result: AgentGateResult): void
  /** The structured output contract compiled from the script's agent({ schema }). */
  schema?: CompiledSchema
  /** The artifact ID list passed by the script's agent({ attachments }) (passed through as-is; the host validates existence/authorization). */
  attachments?: string[]
  /**
   * The secret environment variable names passed by the script's agent({ secretNames }): explicitly
   * granted to external runtimes for injecting parent-conversation stash secrets (no secrets carried by
   * default; name existence is validated at the kernel spawn boundary). Participates in the journal
   * fingerprint: a grant change means a different call.
   */
  secretNames?: string[]
  /**
   * Explicitly sets this agent subagent's absolute depth cap in the task tree (1..HARD_MAX_SUBAGENT_DEPTH);
   * defaults to inheriting the parent conversation's effective cap. Participates in the journal fingerprint:
   * an authorization change mismatches this call and the following prefix, avoiding reusing cached results
   * under different dispatch permissions; the real spawn is still re-validated by the host.
   */
  maxSubagentDepth?: number
  phaseIndex?: number
  phaseTitle?: string
  /**
   * The gate command for this agent. Execution belongs to the host's runGate (exactly once); the spawn
   * adaptation layer must not pass gate into the agent_spawn pipeline (avoiding double execution).
   */
  gate?: string
}

export interface WorkflowSpawnResult {
  ok: boolean
  text?: string
  error?: string
  skipped?: boolean
  tokens?: number
  outputTokens?: number
  structuredRetried?: boolean
  toolCalls?: number
  cwd?: string
  /** Returned by the host when gate already ran in the child process's working directory; applyGate does not run it again. */
  gate?: WorkflowGateResult
  /**
   * Execution-environment metadata snapshot (the parts already determined when spawn completed;
   * onResolved may arrive earlier). The engine uses it only for progress rows, never mixed into user return values.
   */
  executionInfo?: AgentExecutionInfo
  timedOut?: boolean
}

/** Gate command result; output is shown to the user on failure. */
export interface WorkflowGateResult {
  ok: boolean
  output: string
  /** The gate process exit code (null = killed by signal or unknowable). */
  exitCode?: number | null
  /** Whether the gate command was terminated due to timeout (runShell process group SIGTERM->SIGKILL). */
  timedOut?: boolean
}

export interface WorkflowScriptRef {
  name?: string
  scriptPath?: string
}

export type WorkflowScriptSource =
  | { ok: true; script: string; path?: string }
  | { ok: false; message: string }

/** The runtime's single seam to the outside world (injectable; tests can swap in a deterministic fake). */
export interface WorkflowHost {
  spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>
  /** For each in-flight agent call when the run aborts. */
  abortAgent(agentId: string): void
  /** Resume an existing subagent of this run (keeping its agent type/model/context). Rejects resume when absent. */
  resumeAgent?(
    agentId: string,
    prompt: string,
    options?: ResumeAgentOptions,
  ): Promise<WorkflowSpawnResult>
  /**
   * Run the gate command and report whether it passed. cwd is the sub-conversation's working directory (if any).
   * Host-run fallback: when the execution environment did not report a gate (no onGateResult/result.gate),
   * this engine honors it. A default host makes the runtime fail that call explicitly -- a silently un-run gate
   * equals marking unverified work as verified.
   */
  runGate?(command: string, options: { agentId: string; cwd?: string; gateTimeoutMs?: number }): Promise<WorkflowGateResult>
  /**
   * Action pre-flight (zero side effects): called before persisting `action_started`.
   * Used to validate actionId existence/unambiguity, plugin enablement, conversation scope and inputSchema,
   * and to return the action definition's default `idempotent` attribute.
   * If it throws, the handler never ran at all (zero side effects) and the engine writes no `action_started`.
   */
  prepareAction?(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }> | { pluginId: string; actionId: string; idempotent?: boolean }
  /**
   * Invoke a plugin action (the helm action primitive). pluginId/actionId are resolved precisely by the
   * host per manifest; input/output are both safe JSON. context.signal follows run aborts.
   */
  invokeAction(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; result: unknown }>
  /** Resolve a nested workflow() reference to source. A default host rejects workflow() outright. */
  loadWorkflow?(ref: WorkflowScriptRef): Promise<WorkflowScriptSource> | WorkflowScriptSource
}

/** The optional capability pass-through surface of resumeAgent (the engine hands over the actual execution environment verbatim on resume calls). */
export interface ResumeAgentOptions {
  /** The resumed turn's structured output contract (compiled from the script's agent({ resume, schema })). */
  schema?: CompiledSchema
  /** The resumed turn's gate command (reported via onGateResult after exactly one execution in the real environment). */
  gate?: string
  /** The artifact ID list carried by the resumed turn (only this submission's; the original task's attachments are not inherited). */
  attachments?: string[]
  /** Explicitly adjust the subtree cap on resume, still constrained by the initiator's inherited cap. */
  maxSubagentDepth?: number
  timeoutMs?: number
  gateTimeoutMs?: number
  /** The persistent execution handle used for cross-restart recovery; defaults to the agentId mapping. */
  resumeRef?: string
  onResolved?: WorkflowSpawnRequest['onResolved']
  onGateResult?: WorkflowSpawnRequest['onGateResult']
}

/** Ledger append input -- see journal.ts for the authoritative definition (legacy alias for engine-internal reference compatibility). */
export type JournalAppendInput = JournalWriteInput

export type ActionJournalInput =
  | Omit<Extract<JournalAppendInput, { type: 'action' }>, keyof ReplayScope>
  | Omit<Extract<JournalAppendInput, { type: 'action_started' }>, keyof ReplayScope>

export interface RunWorkflowOptions {
  /** 所属 run 标识（用于派生确定性幂等 requestId）。 */
  runId?: string
  script: string
  args?: unknown
  host: WorkflowHost
  signal?: AbortSignal
  /** 宿主关停优雅挂起判断：为 true 时不向内核发送守卫中止，也不落盘伪失败终态行。 */
  isSuspended?(): boolean
  /** 同 runId 原位恢复且所有未决原生 agent_started 均完成 onResolved 重挂（或提前终结）时触发。 */
  onReattachHorizon?(): void
  onProgress?(entries: readonly WorkflowEntry[]): void
  concurrency?: number
  agentCap?: number
  itemCap?: number
  nestedCap?: number
  /**
   * Replay and accounting (fs injected by the caller; runtime tests need no filesystem).
   * `append` may be a Promise: the handler must not run before action_started resolves,
   * and the call must not resolve before the action's terminal row is persisted. When append throws
   * JournalWriteError, the action path is fatal; the agent path only counts diagnostics without
   * interrupting the run.
   */
  journal?: {
    entries?: readonly WorkflowJournalEntry[]
    /** 同文件原位恢复（in-place resume）：命中已落盘终态时零 Token 重放且不重复追加终态行，未决 agent_started 触发 reattach。 */
    inPlaceResume?: boolean
    /** Failed source runs get a fresh budget for their terminal failed goals. */
    retryFailedCalls?: boolean
    append?(entry: JournalWriteInput): Promise<void> | void
  }
  /**
   * Persistent-face (journal values / progress previews) redaction hook: string values pass through
   * this before landing on disk. Defaults to as-is. Note: worker returns and the script runtime still
   * use raw values; replay can only retrieve redacted values (secrets must travel via env / action
   * input markers; never rely on replay to restore them).
   */
  redact?(text: string): string
}

export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'killed'
  meta: WorkflowMeta
  /** The script's return value (JSON-checked at the boundary). */
  value?: unknown
  error?: string
  /** Append-only log (emission order). */
  progress: WorkflowEntry[]
  /** Total agents scheduled (incl. failures). */
  agentCount: number
  /** Of which the count from ledger replay. */
  replayedCount: number
  /**
   * Diagnostic details of agent-row accounting failures (the best-effort face: the run is not interrupted;
   * errors are carried here honestly). Empty array/omitted = no accounting failures. Consumers: service
   * prints to stderr at settlement and merges into run diagnostics.
   */
  journalIoErrors?: string[]
}

/* ------------------------------------------------------------------------- *
 * worker -> host message surface (payloads come from the untrusted worker thread; re-validated at the boundary)
 * ------------------------------------------------------------------------- */

interface AgentCallPayload extends ReplayScope {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  isolation?: 'worktree'
  phaseIndex?: number
  phaseTitle?: string
  gate?: string
  resume?: string
  effort?: string
  schema?: unknown
  attachments?: string[]
  /** The derivation depth cap explicitly granted to this agent subtree (validated on the worker side; re-validated at the host boundary). */
  maxSubagentDepth?: number
  /** Parent-conversation secret env var names explicitly granted for external runtime injection (re-validated at the host boundary; sent down only on fresh spawns). */
  secretNames?: string[]
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  /** The workflow scope issuing the call (assigned by the worker's makeScope; root = 0, omitted counts as root). label/resume are namespaced by it. */
  scopeId?: number
  /** Auto-retry cap (1..MAX_AGENT_ATTEMPTS, default 1): on failure with a registered resume handle, retries via the attempt ring. */
  maxAttempts?: number
  withMeta?: boolean
}

interface ActionCallPayload extends ReplayScope {
  actionId: string
  input: unknown
  label?: string
  idempotent?: boolean
  phaseIndex?: number
  phaseTitle?: string
}

type WorkerMessage =
  | { type: 'call'; callId: number; method: 'agent'; payload: AgentCallPayload }
  | { type: 'call'; callId: number; method: 'action'; payload: ActionCallPayload }
  | { type: 'call'; callId: number; method: 'workflow'; payload: WorkflowScriptRef }
  | { type: 'progress'; entries: WorkflowEntry[] }
  | { type: 'complete'; resultJson?: string }
  | { type: 'error'; message: string; stack?: string }

/** Shared by worker message payloads and host-side dispatch (the runtime.ts message surface); payloads are untrusted, re-validated at the boundary. */
export type { AgentCallPayload, ActionCallPayload, WorkerMessage }

/** Subagents revivable by resume, remembered by scopedResumeKey. */
export interface CompletedChild {
  agentId: string
  label: string
  agentType: string
  model?: string
  isolation?: 'worktree'
  /** The scope the entry belonged to at registration (root = 0; used to filter known-label hints within the same scope). */
  scopeId?: number
  /**
   * This child came from ledger cache (replayed): text result only, no live session to resume.
   * A later agent({ resume }) hitting the ledger can return the cached text directly, but after a prefix
   * mismatch, a real continuation must fail explicitly; never fabricate a live continuation.
   */
  replayed?: true
  /** The native/external execution handle restored from the ledger for cross-process recovery. */
  resumeRef?: string
}
