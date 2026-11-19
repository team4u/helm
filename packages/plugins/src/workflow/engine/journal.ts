/**
 * journal.ts -- the private prefix-replay ledger of workflow runs.
 *
 * Ported from @tintinweb/pi-subagents v0.23.1 (MIT) journal.ts and hardened per helmx semantics:
 *
 * ## Prefix replay, not table lookup
 * Each row matches by stable scope path, in-scope call position, attempt number and payload hash (key).
 * After one scope mismatches, its subsequent calls and child scopes go live; sibling scopes recover independently.
 * The global index is only for this run's auditing and progress, unconstrained by historical completion order.
 *
 * ## Different failure semantics for agent vs action
 * - agent failure rows are still recorded (the broken chain live-retries next time); I/O write failures do not
 *   halt the run (the ledger is only an optimization for future resume), but counts surface via `ioErrors`
 *   for host diagnostics, never concealed.
 * - actions have side effects: the `action_started` intent row must append+fsync successfully before the handler may run;
 *   the call promise resolves only after the `action` terminal row is persisted. A write failure of either is
 *   fatal -- continuing would mean executing side effects in an unaccountable state, and the ledger would
 *   lose its meaning.
 * ## Uncertainty at recovery (conservative first)
 * None of the following can prove "the side effect did not happen or happened completely"; readJournal uniformly
 * sets `actionUncertain`, and callers must explicitly refuse automatic recovery, deferring to humans:
 * - `action_started` without a matching terminal row (regardless of its seq position -- if the terminal row
 *   was lost for any reason, that action's outcome is undecidable; do not clear it on a "written-last" heuristic);
 * - corrupted rows whose type cannot be determined: rows written by this engine always have type as the first
 *   key; only when the **complete** `"type":"agent"` prefix can be read from the residual text may the row be
 *   classified as an agent row (ioError); everything else (incl. parseable rows with unknown shapes) is
 *   conservatively uncertain; never clear anything by guessing from string contains like "action";
 * - the presence of an ok:false action terminal row (a handler throw != zero side effects; auto-retry
 *   could double-charge/send; counted via `failedActions`);
 *
 * - the file itself unreadable (permission/I-O error, reported via `readFailed`; ENOENT counts as an empty ledger).
 * ## Ordering
 * A row's seq is the engine's monotonically increasing flush-order number (under concurrency, index is assigned
 *
 * by call-initiation order; flush order may interleave with index order; recovery validates the in-scope
 * prefix and dedups by seq).
 * Split note: row types / key fingerprints / row-level shape validation moved to journal-entry.ts (re-exported
 */

import { appendFile, open, type FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import {
  isActionEntry,
  isActionStartedEntry,
  isAgentEntry,
  isAgentStartedEntry,
  type JournalAgentExecution,
  type JournalWriteInput,
  type WorkflowJournalEntry,
} from './journal-entry.js'

export {
  actionJournalKey,
  agentJournalKey,
  hasValidScopeIdentity,
  isAgentStartedEntry,
  type AgentJournalKeyInput,
  type JournalAgentExecution,
  type JournalGateResult,
  type JournalScope,
  type JournalWriteInput,
  type WorkflowJournalEntry,
} from './journal-entry.js'

/** readJournal's structured result: corruption affecting action-outcome decisions is never silently swallowed. */
export interface JournalReadResult {
  entries: WorkflowJournalEntry[]
  /**
   * true = the ledger cannot prove safe replay (dangling started / undecidable corrupted rows / failed actions /
   * unreadable file); the caller must explicitly fail (workflow_action_uncertain / journal_read_failed);
   * auto-rerunning side effects is forbidden.
   */
  actionUncertain: boolean
  /** Count of parse/read problems in non-action rows (truncated tail rows, hand-edited files etc.); does not affect replay but is reported honestly. */
  ioErrors: number
  /** Count of ok:false action terminal rows (side effects may have happened; recovery must refuse auto-retry). */
  failedActions: number
  /** The file exists but is unreadable (permission/I-O). ENOENT is not included here (a normal empty ledger). */
  readFailed?: { code: string; message: string }
}

type LineVerdict =
  | { kind: 'entry'; entry: WorkflowJournalEntry }
  /** Corrupted but decidable as an agent row: counted as ioError, does not block replay. */
  | { kind: 'agentCorrupt' }
  /** Type undecidable: conservatively treated as possibly action-related. */
  | { kind: 'uncertain' }

/** Rows written by this engine always have type as the first key; only a complete "type":"agent" or "type":"agent_started" prefix counts as a corrupted agent row. */
const AGENT_LINE_PREFIX = /^\s*\{\s*"type"\s*:\s*"agent(?:_started)?"/

function classifyLine(line: string): LineVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return AGENT_LINE_PREFIX.test(line) ? { kind: 'agentCorrupt' } : { kind: 'uncertain' }
  }
  if (isAgentEntry(parsed) || isAgentStartedEntry(parsed)) return { kind: 'entry', entry: parsed }
  if (isActionStartedEntry(parsed) || isActionEntry(parsed)) return { kind: 'entry', entry: parsed }
  // Parseable but shape-unknown: when the type field reads as agent/agent_started, treat it as a corrupted agent row;
  // everything else (unknown type / missing type / mangled fields) is conservatively uncertain.
  if (typeof parsed === 'object' && parsed !== null) {
    const type = (parsed as { type?: unknown }).type
    if (type === 'agent' || type === 'agent_started') {
      return { kind: 'agentCorrupt' }
    }
  }
  return { kind: 'uncertain' }
}

/**
 * Read the ledger file.
 *
 * - File absent (ENOENT): an empty ledger (the normal path of a brand-new run).
 * - File unreadable (permission/I-O): readFailed + actionUncertain; never pretend to be an empty ledger.
 * - Row corruption: see "Uncertainty at recovery" in the file header; blank lines (trailing newline) are skipped.
 */
export function readJournal(path: string): JournalReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return { entries: [], actionUncertain: false, ioErrors: 0, failedActions: 0 }
    }
    return {
      entries: [],
      actionUncertain: true,
      ioErrors: 0,
      failedActions: 0,
      readFailed: { code: err.code ?? 'EIO', message: err.message },
    }
  }

  const entries: WorkflowJournalEntry[] = []
  let ioErrors = 0
  let corruptUncertain = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const verdict = classifyLine(line)
    if (verdict.kind === 'entry') {
      entries.push(verdict.entry)
      continue
    }
    ioErrors++
    if (verdict.kind === 'uncertain') corruptUncertain = true
  }

  // scope, call position, global index and key must all match to pair an intent with its terminal row.
  // Another scope's terminal row must not mask a dangling intent. Any dangling started is uncertain:
  // the terminal row may have been lost to corruption; "after started was flushed, the handler was allowed to run" is the only fact.
  const startedByKey = new Map<string, Extract<WorkflowJournalEntry, { type: 'action_started' }>>()
  for (const entry of entries) {
    if (entry.type === 'action_started') startedByKey.set(JSON.stringify([entry.scopePath, entry.scopeCallIndex, entry.index, entry.key]), entry)
  }
  for (const entry of entries) {
    if (entry.type === 'action') startedByKey.delete(JSON.stringify([entry.scopePath, entry.scopeCallIndex, entry.index, entry.key]))
  }
  let dangling = false
  for (const started of startedByKey.values()) {
    if (started.idempotent !== true) {
      dangling = true
      break
    }
  }

  const failedActions = entries.filter((e) => e.type === 'action' && !e.ok && e.idempotent !== true).length

  // Duplicate seqs are dedupable only when the whole row is identical. A conflict may have lost an
  // executed action; a post-dedup mangled ledger must not be treated as a safe prefix to execute side effects on.
  const bySeq = new Map<number, string>()
  for (const entry of entries) {
    const serialized = JSON.stringify(entry)
    const previous = bySeq.get(entry.seq)
    if (previous !== undefined && previous !== serialized) {
      corruptUncertain = true
      ioErrors++
    }
    bySeq.set(entry.seq, serialized)
  }
  // Flush-order stabilization: seq strictly increasing; fully identical duplicate rows kept once.
  // index order is checked on demand by the prefix-matching logic.
  entries.sort((a, b) => a.seq - b.seq)
  const deduped: WorkflowJournalEntry[] = []
  let lastSeq = -1
  for (const entry of entries) {
    if (entry.seq === lastSeq) continue
    lastSeq = entry.seq
    deduped.push(entry)
  }

  return {
    entries: deduped,
    actionUncertain: dangling || corruptUncertain || failedActions > 0,
    ioErrors,
    failedActions,
  }
}

/**
 * Append writer: holds an open FileHandle; the action path fsyncs after append.
 *
 * agent-row write failures only count (a resume-optimization loss, not halting the run); action
 * started/terminal row write failures throw JournalWriteError (fatal).
 */
export class JournalWriter {
  private seq = 0
  private handle?: FileHandle
  /** Once set, all appends (incl. agent rows) throw: the run already terminated due to a broken action ledger. */
  private poisoned = false
  private needsTailNewlineCheck: boolean
  agentIoErrors = 0

  constructor(
    private readonly path: string,
    private readonly fsyncActions: boolean = true,
    initialSeq: number = 0,
  ) {
    // Opening is async but the constructor must be synchronous; deferred to the first append (see ensure()).
    // On open failure, agent rows degrade to counting and action rows throw explicitly, matching the synchronous version.
    if (Number.isInteger(initialSeq) && initialSeq > 0) this.seq = initialSeq
    this.needsTailNewlineCheck = this.seq > 0
  }

  private opening?: Promise<FileHandle | undefined>

  private async ensure(): Promise<FileHandle | undefined> {
    if (this.handle !== undefined) return this.handle
    if (this.opening === undefined) {
      this.opening = open(this.path, 'a')
        .then(async (h) => {
          if (this.needsTailNewlineCheck) {
            this.needsTailNewlineCheck = false
            try {
              const existing = readFileSync(this.path)
              if (existing.length > 0 && existing[existing.length - 1] !== 0x0a) {
                await appendFile(h, '\n', 'utf-8')
              }
            } catch {
              // 忽略探测异常，保持原有写路径语义。
            }
          }
          this.handle = h
          return h
        })
        .catch(() => {
          this.opening = undefined
          return undefined
        })
    }
    return this.opening
  }

  /**
   * Append one row. Action-related rows (started/terminal) return only after fsync succeeds;
   * agent rows are best-effort, with failures counted into agentIoErrors.
   * @throws JournalWriteError on action-row write failure or when the writer is already poisoned.
   */
  async append(entry: JournalWriteInput): Promise<number> {
    const full = { ...entry, v: 1, seq: entry.seq ?? this.seq++ } as WorkflowJournalEntry
    const isActionLine = full.type === 'action_started' || full.type === 'action'
    if (!isActionLine && this.poisoned) {
      // The run already terminated due to a broken ledger; later rows are meaningless.
      return full.seq
    }
    const handle = await this.ensure()
    if (handle === undefined) {
      if (isActionLine) {
        this.poisoned = true
        throw new JournalWriteError(`workflow journal unavailable: cannot open ${this.path}`)
      }
      this.agentIoErrors++
      return full.seq
    }
    try {
      await appendFile(handle, `${JSON.stringify(full)}\n`, 'utf-8')
      if (isActionLine && this.fsyncActions) {
        // The handler must not run before started is flushed (fsync); the call must not resolve before the terminal row is.
        await handle.sync()
      }
    } catch (error) {
      if (isActionLine) {
        this.poisoned = true
        throw new JournalWriteError(
          `workflow journal write failed (${full.type}): ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.agentIoErrors++
    }
    return full.seq
  }

  /** Whether the ledger already broke due to an action write failure. */
  get isPoisoned(): boolean {
    return this.poisoned
  }

  async close(): Promise<void> {
    try {
      await this.handle?.close()
    } catch {
      // A close failure does not affect correctness; the next open continues in append mode.
    }
  }
}

export class JournalWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalWriteError'
  }
}

/** Convenience: whether the file exists (for resume probing). */
export function journalExists(path: string): boolean {
  return existsSync(path)
}

/** Value-level recursive redaction (per-value string replacement; arrays/objects recursed per layer; other values as-is). */
function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, redact)
    return out
  }
  return value
}

/**
 * Unified redaction before agent rows are flushed: text / execution (effectiveCwd, worktree paths may
 * contain tokens) / gate.output are per-value replaced before reaching JournalWriter. action rows are
 * handled by the engine layer itself (result/error are already safe JSON) and pass through here as-is.
 */
export function redactJournalEntry(
  entry: JournalWriteInput,
  redact: (text: string) => string,
): JournalWriteInput {
  if (entry.type === 'agent_started') {
    return {
      ...entry,
      execution: redactValue(entry.execution, redact) as JournalAgentExecution,
    }
  }
  if (entry.type !== 'agent') return entry
  const out: JournalWriteInput = { ...entry }
  if (out.text !== undefined) out.text = redact(out.text)
  if (out.prompt !== undefined) out.prompt = redact(out.prompt)
  if (out.execution !== undefined) out.execution = redactValue(out.execution, redact) as JournalAgentExecution
  if (out.error !== undefined) out.error = redact(out.error)
  if (out.gate !== undefined) {
    out.gate = { ...out.gate, output: redact(out.gate.output) }
  }
  return out
}
