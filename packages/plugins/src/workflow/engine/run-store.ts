/**
 * run-store.ts -- the persistence layer for run records / the run index (an internal module split out of WorkflowService).
 *
 * Responsibilities:
 * - Single-store design: the run index lives in the injected state store (a namespace doc of the
 *   @helm/kernel's single state.sqlite); full RunRecords land atomically in files (same directory
 *   dataDir/artifacts/<convId>/workflow-<runId>.record.json);
 * - Shape-validation discipline: the index and records are persistence-layer external input;
 *   readers validate explicitly, and corruption is always workflow_index_corrupt /
 *   workflow_record_corrupt (500); corrupted data is never coerced into empty arrays or valid records;
 * - Takeover-marker adjudication (inspectTakeoverMarker): in-process liveness facts are injected by
 *   the caller (reserved set / active table); on-disk facts (index + record/ledger files) are checked here.
 *
 * Summary derivation / redaction / progress folding projections live in run-summary.ts (pure
 * functions, orthogonal to this persistence layer). Write-order discipline lives in write():
 * read-validate the index first, then write the file, then update the index.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import type {
  WorkflowProgressEntry,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '../../contracts.js'

/**
 * The persistence layer for the run index and summaries: a namespace-doc view of the kernel's single
 * state.sqlite (isomorphic to PluginDocStore, without depending on the plugins module). get/set are
 * synchronous; flush is optional (a no-op when SQLite persists pages immediately).
 */
export interface WorkflowStateStore {
  get<T>(key: string, initial: T): T
  set<T>(key: string, value: T): void
  flush?(): Promise<void>
}

const INDEX_KEY = 'workflow/runs'

/** run id: wf_ + 12 hex (upstream format kept for recognizability). */
export function newRunId(): string {
  return `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export interface RunIndexEntry {
  id: string
  conversationId: number
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  /** Background-start marker (inherited by resume'd new runs; used by diagnostics/probe decisions). */
  notifyParentOnSettle?: boolean
  /** Current cumulative auto-resume count (initial default = 0; +1 on each resumeFromRunId takeover). */
  autoResumeCount?: number
  /** The new run ID that took over this failed run (prevents duplicate resumption; default = not taken over). */
  resumedByRunId?: string
}

/** The full per-run doc in the state store (summary + bibliography info needed for recovery). */
export interface RunRecord {
  id: string
  name: string
  conversationId: number
  /** The parent conversation's tool-call ID that triggered this run (kernel-trusted injection; not user input). */
  parentToolCallId?: string
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
  nodes?: WorkflowRunSummary['nodes']
  progress?: WorkflowProgressEntry[]
  /** The script source for resume (inline script or file path, exactly one). */
  script?: string
  scriptPath?: string
  /** A named workflow in the saved directory. */
  savedName?: string
  /** The script's meta.description (persisted after redaction). */
  description?: string
  /** The script's meta.phases blueprint (persisted after redaction). */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /** The run's actual args (safe JSON; resume reuses them by default). */
  args?: unknown
  journalPath: string
  replayedFrom?: string
  /**
   * Ledger accounting failure diagnostics (agent-row write failure / missing rows in a resumed old ledger),
   * persisted after redaction; they do not affect terminal-state decisions and exist only for honest
   */
  journalIoErrors?: string[]
  /** Run kind: DSL workflow (default) or trusted background single-subagent (startBackgroundAgent). */
  kind?: 'workflow' | 'subagent'
  /**
   * Background-start marker: after terminal settlement, a notification must be delivered to the parent
   * conversation (notifiedAt prevents duplicate delivery; init() outbox re-delivers). subagent runs are
   * always background; workflow runs set it only when started via the tool's background flag -- it also
   * decides restart-recovery semantics (isBackgroundRecord: in-flight sub-conversations first get abort
   */
  notifyParentOnSettle?: boolean
  notifiedAt?: number
  /** The background subagent's Profile and execution-environment metadata (completed after onResolved returns). */
  subagentMeta?: { agentType?: string; execution?: AgentExecutionInfo }
  /**
   * Foreground-synchronous marker: runs started via the synchronous tool (background:false / automation
   * default). The parent turn's tool call blocks waiting (engine foregroundWaiters) and can be atomically
   * moved to the background by the detach action (detaching sets notifyParentOnSettle + detachedAt).
   */
  syncForeground?: boolean
  /** Detach-to-background timestamp (idempotent marker: an already-detached run rejects another detach). */
  detachedAt?: number
  /**
   * Private recovery metadata: the set of sub-conversation IDs this run derived (persisted as onResolved
   * registers them; writeRecord merges from the active run's childConversations uniformly, preventing stale
   * copies from overwriting). Background-run crash recovery (prepareRecovery/init guarded aborts) uses this
   * persistent ID set as the authoritative coordinates -- the real run's runtime nodes are only flushed at
   */
  childConversationIds?: number[]
  /**
   * Shutdown-time pending-child-cleanup marker: when the host shuts down (harness.close before
   * pluginHost.dispose), a run already terminally settled as aborted may have its sub-conversations
   * reverted to pending via writeAtClose(); setting true tells the next startup's prepareRecovery()/init()
   */
  pendingChildCleanup?: boolean
  /** Current cumulative auto-resume count (+1 on resume takeover; kept in sync with the index). */
  autoResumeCount?: number
  /** The new run ID that took over this failed run (prevents duplicate resumption; in sync with the index). */
  resumedByRunId?: string
}

/** Printable form of persistence-layer read errors (for store exception diagnostics). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Minimal shape validation of the run index: non-array, null entries, invalid required fields are all
 * persistence-layer corruption (the old implementation accessed entry.id directly per item; null entries
 * would TypeError). Validates only the current RunIndexEntry contract, with no old-format adaptation.
 * Returns undefined when legal; returns the problem description + an identifiable runId when corrupted
 */
function runIndexProblem(raw: unknown): { problem: string; runId: string } | undefined {
  if (!Array.isArray(raw)) return { problem: `index is not an array (${raw === null ? 'null' : typeof raw})`, runId: '#root' }
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { problem: `entry ${i} is not an object (${entry === null ? 'null' : typeof entry})`, runId: `#${i}` }
    }
    const e = entry as Record<string, unknown>
    const at = `#${i}`
    if (typeof e['id'] !== 'string' || e['id'] === '') {
      return { problem: `entry ${i} id is not a string`, runId: at }
    }
    const runId = e['id'] as string
    if (!Number.isInteger(e['conversationId']) || (e['conversationId'] as number) < 1) {
      return { problem: `entry ${i} conversationId is not a positive integer`, runId }
    }
    if (!RUN_STATUSES.includes(e['status'] as WorkflowRunStatus)) {
      return { problem: `entry ${i} status is invalid (${JSON.stringify(e['status'])})`, runId }
    }
    if (typeof e['createdAt'] !== 'number' || !Number.isFinite(e['createdAt'])) {
      return { problem: `entry ${i} createdAt is not a finite number`, runId }
    }
    if (typeof e['updatedAt'] !== 'number' || !Number.isFinite(e['updatedAt'])) {
      return { problem: `entry ${i} updatedAt is not a finite number`, runId }
    }
    if (e['notifyParentOnSettle'] !== undefined && typeof e['notifyParentOnSettle'] !== 'boolean') {
      return { problem: `entry ${i} notifyParentOnSettle is not a boolean`, runId }
    }
    if (
      e['autoResumeCount'] !== undefined &&
      (!Number.isInteger(e['autoResumeCount']) || (e['autoResumeCount'] as number) < 0)
    ) {
      return { problem: `entry ${i} autoResumeCount is not a non-negative integer`, runId }
    }
    if (e['resumedByRunId'] !== undefined && (typeof e['resumedByRunId'] !== 'string' || e['resumedByRunId'] === '')) {
      return { problem: `entry ${i} resumedByRunId is not a non-empty string`, runId }
    }
  }
  return undefined
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'completed', 'failed', 'aborted']

export function isNonRetryableWorkflowError(error: string | undefined): boolean {
  if (error === undefined) return false
  const normalized = error.toLowerCase()
  return normalized.includes('workflow_action_uncertain') ||
    normalized.includes('[validation_error]') ||
    normalized.includes('workflow script has a syntax error')
}

/**
 * Minimal shape validation of persisted records: checks only the required fields of the current
 * RunRecord contract (what the summary face needs), with no old-format adaptation and no deep
 * validation of optional sections (nodes/progress tolerate at their consumers). Returns the first
 */
function runRecordProblem(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return `not an object structure (${typeof record})`
  }
  const r = record as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'] === '') return 'id is not a string'
  if (typeof r['name'] !== 'string') return 'name is not a string'
  if (!Number.isInteger(r['conversationId']) || (r['conversationId'] as number) < 1) {
    return 'conversationId is not a positive integer'
  }
  if (!RUN_STATUSES.includes(r['status'] as WorkflowRunStatus)) {
    return `status is invalid (${JSON.stringify(r['status'])})`
  }
  if (!Number.isFinite(r['createdAt']) || typeof r['createdAt'] !== 'number') return 'createdAt is not a number'
  if (!Number.isFinite(r['updatedAt']) || typeof r['updatedAt'] !== 'number') return 'updatedAt is not a number'
  if (typeof r['journalPath'] !== 'string') return 'journalPath is not a string'
  const childIds = r['childConversationIds']
  if (
    childIds !== undefined &&
    (!Array.isArray(childIds) || !childIds.every((id) => Number.isInteger(id) && id >= 1))
  ) {
    return 'childConversationIds is invalid (expected a positive-integer array)'
  }
  if (r['error'] !== undefined && typeof r['error'] !== 'string') return 'error is not a string'
  if (r['syncForeground'] !== undefined && typeof r['syncForeground'] !== 'boolean') {
    return 'syncForeground is not a boolean'
  }
  if (
    r['detachedAt'] !== undefined &&
    (typeof r['detachedAt'] !== 'number' || !Number.isFinite(r['detachedAt']) || r['detachedAt'] < 0)
  ) {
    return 'detachedAt is not a non-negative finite number'
  }
  if (
    r['autoResumeCount'] !== undefined &&
    (!Number.isInteger(r['autoResumeCount']) || (r['autoResumeCount'] as number) < 0)
  ) {
    return 'autoResumeCount is not a non-negative integer'
  }
  if (r['resumedByRunId'] !== undefined && (typeof r['resumedByRunId'] !== 'string' || r['resumedByRunId'] === '')) {
    return 'resumedByRunId is not a non-empty string'
  }
  if (r['syncForeground'] !== undefined && typeof r['syncForeground'] !== 'boolean') {
    return 'syncForeground is not a boolean'
  }
  if (
    r['detachedAt'] !== undefined &&
    (typeof r['detachedAt'] !== 'number' || !Number.isFinite(r['detachedAt'] as number))
  ) {
    return 'detachedAt is not a finite number'
  }
  if (r['pendingChildCleanup'] !== undefined && typeof r['pendingChildCleanup'] !== 'boolean') {
    return 'pendingChildCleanup is not a boolean'
  }
  return undefined
}

/**
 * The in-flight sub-conversation coordinates needed for background-run recovery: childConversationIds
 * is the authoritative face persisted in real time; subagentMeta/nodes coordinates are the existing
 * redundant projections (subagent paths/terminal states flushed); recovery merges and dedups them,
 */
export function backgroundChildIds(record: RunRecord): number[] {
  const ids = new Set<number>()
  for (const id of record.childConversationIds ?? []) ids.add(id)
  const known = record.subagentMeta?.execution?.conversationId
  if (known !== undefined) ids.add(known)
  for (const node of record.nodes ?? []) {
    if (node.conversationId !== undefined) ids.add(node.conversationId)
  }
  return [...ids]
}

/**
 * Background-form detection (for recovery semantics): kind=subagent is always background;
 * kind=workflow is recovered as background only when notifyParentOnSettle=true (started via the tool's
 * background flag) -- after restart its in-flight sub-conversations must first get abort markers
 * (prepareRecovery) then guarded aborts, then failed(interrupted) plus re-delivered notifications;
 * otherwise background workflow sub-conversations would be left behind. Regular synchronous
 * workflows (no notify) keep ledger-recovery semantics: sub-conversations are not aborted; a
 */
export function isBackgroundRecord(record: RunRecord): boolean {
  return record.kind === 'subagent' || record.notifyParentOnSettle === true
}

export interface RunStoreOptions {
  dataDir: string
  /** The run index's SQLite doc store (the main app injects KernelRuntime.documentStore). */
  state: WorkflowStateStore
}

export class RunStore {
  private readonly dataDir: string
  private readonly state: WorkflowStateStore

  constructor(options: RunStoreOptions) {
    this.dataDir = options.dataDir
    this.state = options.state
  }

  artifactsDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  journalPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.jsonl`)
  }

  /** File path of the full RunRecord (same directory as the ledger: dataDir/artifacts/<convId>/). */
  recordPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.record.json`)
  }

  /**
   * Write a run record (§4.3): the full RunRecord lands atomically in a file (.tmp + fsync + rename),
   * and the records doc only maintains a lightweight index (id/conversationId/status/createdAt/updatedAt/
   * notifyParentOnSettle/autoResumeCount/resumedByRunId). Order discipline: read-validate the index
   * first, then write the file, then update the index -- when the index is corrupted, never continue
   * writing files (avoiding overwriting persisted facts under an unknown global state, which only adds
   * inconsistency surfaces); on file-write failure the index is untouched (no intermediate state where
   * the index points to a missing file; load explicitly reports workflow_record_corrupt for missing
   */
  write(record: RunRecord): void {
    const index = this.readIndex()
    this.writeFile(record)
    const entry: RunIndexEntry = {
      id: record.id,
      conversationId: record.conversationId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.notifyParentOnSettle === true ? { notifyParentOnSettle: true } : {}),
      ...(record.autoResumeCount !== undefined ? { autoResumeCount: record.autoResumeCount } : {}),
      ...(record.resumedByRunId !== undefined ? { resumedByRunId: record.resumedByRunId } : {}),
    }
    const at = index.findIndex((candidate) => candidate.id === record.id)
    if (at >= 0) index[at] = entry
    else index.push(entry)
    this.state.set(INDEX_KEY, index)
  }

  /** Atomically write the full RunRecord: temp file in the same directory + fsync + rename (readers only ever see a complete old/new version). */
  private writeFile(record: RunRecord): void {
    const dir = this.artifactsDir(record.conversationId)
    mkdirSync(dir, { recursive: true })
    const target = this.recordPathFor(record.conversationId, record.id)
    const tmp = join(dir, `.record-${record.id}-${randomUUID()}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, JSON.stringify(record), null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, target)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // already consumed by rename, or never existed
      }
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `failed to write workflow run record ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  load(runId: string): RunRecord {
    // The index is the single entry point (dev period has no migration: no old per-run doc reads);
    // index-level failures are uniformly workflow_index_corrupt (same contract as all other index
    let index: RunIndexEntry[]
    try {
      index = this.readIndex()
    } catch (error) {
      if (error instanceof HelmError && error.code === 'workflow_index_corrupt') {
        throw new HelmError(
          error.code,
          `failed to read the run index needed for workflow run ${runId}: ${error.message}`,
          500,
          { runId, key: INDEX_KEY },
        )
      }
      throw error
    }
    const entry = index.find((candidate) => candidate.id === runId)
    if (entry === undefined) {
      throw new HelmError('not_found', `workflow run ${runId} does not exist`, 404, { runId })
    }
    const path = this.recordPathFor(entry.conversationId, runId)
    let record: unknown
    try {
      record = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        // Index points to a missing file: persistence-layer inconsistency; never silently degrade as a ledger gap.
        throw new HelmError(
          'workflow_record_corrupt',
          `workflow run ${runId}'s record file is missing (index points to ${path}); check dataDir integrity`,
          500,
          { runId, path },
        )
      }
      throw new HelmError(
        'workflow_record_corrupt',
        `failed to read workflow run ${runId}'s record file: ${errorMessage(error)}`,
        500,
        { runId, path },
      )
    }
    // Verify it's an object before accessing id: null/primitives/arrays must never TypeError on record.id.
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new HelmError(
        'workflow_record_corrupt',
        `workflow run ${runId}'s record file is corrupted (not an object structure: ${Array.isArray(record) ? 'array' : typeof record})`,
        500,
        { runId, path },
      )
    }
    const asRecord = record as Record<string, unknown>
    if (asRecord['id'] !== runId) {
      // Index hit but the file's id was tampered with: persistence-layer inconsistency; never disguise it as "not found".
      throw new HelmError(
        'workflow_record_corrupt',
        `workflow run ${runId}'s record file is corrupted (id mismatch)`,
        500,
        { runId, path },
      )
    }
    // Boundary shape validation: the persistence layer is external input (a state.sqlite namespace doc);
    // TS coercion would treat wrong structures as valid summaries. Missing key fields / invalid status
    // means workflow_record_corrupt (500), distinguished from the 404 of "run not found"; only the current
    // RunRecord contract is validated, with no old-format adaptation.
    const problem = runRecordProblem(record)
    if (problem !== undefined) {
      throw new HelmError(
        'workflow_record_corrupt',
        `workflow run ${runId}'s persisted record is corrupted (${problem})`,
        500,
        { runId, problem },
      )
    }
    return record as RunRecord
  }

  /**
   * Uniformly read and validate the run index (shared by all entry points: list/get/prepare/init/write):
   * store throws and shape corruption are uniformly workflow_index_corrupt (500, with key and an
   * identifiable runId); corrupted data is never treated as an empty array, and callers never coerce then TypeError.
   */
  readIndex(): RunIndexEntry[] {
    let raw: unknown
    try {
      raw = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
    } catch (error) {
      throw new HelmError(
        'workflow_index_corrupt',
        `failed to read the workflow run index: ${errorMessage(error)}`,
        500,
        { key: INDEX_KEY },
      )
    }
    const broken = runIndexProblem(raw)
    if (broken !== undefined) throw this.indexCorruptError(broken.runId, broken.problem)
    return raw as RunIndexEntry[]
  }

  /** Index-corruption diagnostics (no automatic index/record deletion: repairs are human-confirmed). */
  indexCorruptError(runId: string, reason: string): HelmError {
    return new HelmError(
      'workflow_index_corrupt',
      `workflow run index is corrupted (${reason}); check the state store (the index and records are not auto-deleted)`,
      500,
      { key: INDEX_KEY, runId },
    )
  }

  /**
   * Takeover-marker adjudication: ghost=true means the takeover run left no trace in any of the four
   * faces -- the in-process reserved set (the concurrent window where the marker was flushed but the
   * snapshot was not), the active table, the run index, and disk (same-conversation record and ledger
   * files) -- the new run never persisted any fact, so re-takeover is allowed; otherwise the
   * non-approval reason is returned. A corrupted takeover record (index points to an unreadable/invalid
   * file) propagates workflow_record_corrupt honestly: corruption means no side-effect freedom can be
   * confirmed; never approve. In-process liveness facts (live.reserved = the takeover reserved set /
   */
  inspectTakeoverMarker(
    takeoverRunId: string,
    conversationId: number,
    live: { reserved: boolean; active: boolean },
  ): { ghost: true } | { ghost: false; reason: string } {
    if (live.reserved) {
      return { ghost: false, reason: 'the takeover run marker is flushed but the snapshot is not yet (concurrent start window)' }
    }
    if (live.active) return { ghost: false, reason: 'the takeover run is still running' }
    try {
      this.load(takeoverRunId)
      return { ghost: false, reason: 'the takeover run's record still exists' }
    } catch (error) {
      if (!(error instanceof HelmError && error.code === 'not_found')) throw error
    }
    // The index no longer has this run: on-disk files are the last side-effect facts (a missing index
    // may be corruption/rebuild; if files exist, conservatively treat side effects as produced).
    const traces: string[] = []
    const recordPath = this.recordPathFor(conversationId, takeoverRunId)
    const journalPath = this.journalPathFor(conversationId, takeoverRunId)
    for (const [path, label] of [[recordPath, 'record file'], [journalPath, 'journal']] as const) {
      try {
        lstatSync(path)
        traces.push(`${label} ${path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new HelmError('io_error', `cannot confirm the ${label} of takeover run ${takeoverRunId}: ${errorMessage(error)}`, 500, {
          runId: takeoverRunId, path,
        })
      }
    }
    if (traces.length > 0) return { ghost: false, reason: `the takeover run's ${traces.join(', ')} still exist on disk` }
    return { ghost: true }
  }
}
