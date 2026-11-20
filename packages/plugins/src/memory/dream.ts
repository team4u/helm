/**
 * builtin:memory -- the daily Dream (memory consolidation) engine.
 *
 * Division of labor (mechanism vs policy; kernel stays memory-unaware):
 * - The host only provides generic mechanisms: completeText (single-shot no-tools completion,
 *   no conversation turn is ever created or submitted), withFileLock (via MemoryStore),
 *   listConversations/getConversationDetail, redact, and the private ctx.doc;
 * - this module owns the whole dream policy: candidate collection caps/redaction, the daily
 *   schedule (one ctx.service timer, restart recovery by the persisted nextRunAt, catch-up once
 *   after downtime), strict model-output validation, and the CAS write-back via MemoryStore.
 *
 * Honesty and safety invariants:
 * - candidates come only from settled turns' bounded real text: the human inputs of the turn plus
 *   an optional bounded final-assistant-text excerpt (tool outputs / thinking / code dumps are
 *   filtered); the full conversation is never read or persisted;
 * - every persisted byte passes host redaction and is bounded per item, per profile count and
 *   TTL; candidates live only under the plugin-private dataDir, never in any public doc/SSE;
 * - the dream itself runs no conversation turn (completeText only), so it can never re-enter the
 *   turn_settled collector -- the dream cannot feed itself;
 * - model resolution binds completeText to a real existing top-level human-owned conversation of
 *   the very profile; with no such conversation the dream is a legal no-op with an explicit
 *   status reason (never a hidden conversation);
 * - model output is strictly validated (a single JSON object {"memory": string}, non-blank, within
 *   the hard 64k cap and the dream budget); anything else is rejected without writing back,
 *   keeping candidates and a diagnostic snapshot;
 * - write-back is a CAS: MemoryStore.commitDreamMemory re-reads and re-hashes inside the same
 *   file lock; a concurrent human edit aborts the write (conflict), never clobbers;
 * - service stop aborts in-flight model calls (AbortController) and waits for all in-flight
 *   work; liveTasks exposes both dream runs and collector appends so plugin disable is blocked
 *   while work is in flight.
 */

import { CronExpressionParser } from 'cron-parser'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  type ConversationDetail,
  type ConversationEntry,
  type ConversationListFilter,
  type ConversationSummary,
  type PluginDocHandle,
  type TurnSettledPayload,
} from '@helmx/protocol'
import { MAX_MEMORY_CHARS } from './store.js'

// ---------------------------------------------------------------------------
// Constants (all bounds of the dream pipeline; single place, no magic numbers below)
// ---------------------------------------------------------------------------

/** Soft target for the consolidated MEMORY.md (prompted; the dream should converge here). */
export const DREAM_TARGET_CHARS = 4_000

/**
 * Hard budget gate for a dream output: max(2x target, current length + 1000). A consolidation
 * that roughly doubles a small memory or grows a large one has clearly left the "organize"
 * contract and is rejected (the hard 64k file cap still applies on top).
 */
export function dreamBudgetChars(currentLength: number): number {
  return Math.max(DREAM_TARGET_CHARS * 2, currentLength + 1_000)
}

/** Overall deadline for one profile's model call (stop aborts earlier). */
export const DREAM_MODEL_TIMEOUT_MS = 300_000

/** Per-candidate excerpt bounds. */
export const MAX_CANDIDATE_HUMAN_CHARS = 1_500
export const MAX_CANDIDATE_ASSISTANT_CHARS = 800
export const MAX_CANDIDATE_TITLE_CHARS = 120

/** Per-profile candidate count cap and TTL (oldest dropped on both axes). */
export const MAX_CANDIDATES_PER_PROFILE = 64
export const CANDIDATE_TTL_MS = 14 * 24 * 3600 * 1_000

/** Diagnostic snapshot retention (count and age). */
export const MAX_DREAM_SNAPSHOTS = 5
export const DREAM_SNAPSHOT_TTL_MS = 14 * 24 * 3600 * 1_000

/** Raw model output kept in a rejected-dream diagnostic snapshot. */
export const MAX_SNAPSHOT_MODEL_OUTPUT_CHARS = 128_000

/** Default daily hour (low-peak) when no explicit config exists. */
export const DEFAULT_DREAM_HOUR = 3

/** setTimeout cap (2^31-1 ms ~= 24.8 days); larger delays fire within the window first. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Persisted run-record cap (per-profile map pruned to this many newest entries). */
const MAX_RUN_RECORDS = 50

/** Profile IDs are directory names here; enforce the same charset the profile service enforces. */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9-]+$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Global dream configuration (one schedule for all profiles). */
export interface DreamConfig {
  enabled: boolean
  /** Local hour-of-day (0..23) in `timezone` at which the daily dream runs. */
  hour: number
  timezone: string
}

/** One collected candidate: bounded redacted excerpts of a settled human turn. */
export interface DreamCandidate {
  id: string
  conversationId: number
  conversationTitle: string
  /** Concatenated bounded human inputs of the turn (redacted). */
  humanText: string
  /** Bounded final assistant text of the turn (redacted; optional auxiliary context). */
  assistantText?: string
  collectedAt: number
}

/** Compact per-profile record of the most recent dream attempt (private doc). */
export interface DreamProfileRunRecord {
  lastRunAt: number
  /** false = legal skip (reason explains). */
  ran: boolean
  reason?: string
  applied?: boolean
  conflict?: boolean
  candidateCount?: number
  beforeChars?: number
  afterChars?: number
  /** Redacted short diagnostic of the most recent failure. */
  error?: string
}

/** Private persistent doc of the dream engine (compact state only; no full text, no candidates). */
export interface DreamDoc {
  version: 1
  config: DreamConfig
  nextRunAt?: number
  runs: Record<string, DreamProfileRunRecord>
}

/** Result summary of one dream attempt for one profile (action output / internal). */
export interface DreamRunSummary {
  profileId: string
  ran: boolean
  reason?: string
  applied?: boolean
  conflict?: boolean
  /** Candidates present before the attempt. */
  candidateCount: number
  beforeChars?: number
  afterChars?: number
  /** Candidates folded into memory (equals candidateCount on success). */
  consumed?: number
}

/** Diagnostic snapshot written per dream attempt (bounded retention). */
export interface DreamSnapshot {
  ranAt: number
  profileId: string
  candidateCount: number
  candidateIds: string[]
  beforeChars: number
  afterChars?: number
  sourceHash: string
  applied?: boolean
  conflict?: boolean
  reason?: string
  error?: string
  /** Raw model output, kept only for rejected dreams (bounded). */
  modelOutput?: string
}

/** The MemoryStore surface the dream engine consumes (kept structural for tests). */
export interface MemoryDreamStorePort {
  readMemoryWithHash(profileId: string): Promise<{ content: string; hash: string }>
  commitDreamMemory(profileId: string, expectedHash: string, next: string): Promise<{ applied: boolean }>
}

/** Host ports the dream engine needs (assembled from ctx.host / MemoryStore by memory.ts). */
export interface DreamHostPorts {
  dataDir: string
  doc: PluginDocHandle<DreamDoc>
  redact(text: string): string
  completeText(input: {
    conversationId: number
    systemPrompt: string
    text: string
    signal?: AbortSignal
  }): Promise<string>
  listConversations(filter?: ConversationListFilter): ConversationSummary[]
  getConversationDetail(id: number, options?: { limit?: number }): Promise<ConversationDetail>
  store: MemoryDreamStorePort
  profiles: { list(): Promise<Array<{ id: string }>> }
  isMemoryEnabled(profileId: string): boolean
  /** Best-effort error reporting (notification event + stderr); failures must not recurse. */
  emitError(title: string, detail: unknown): void
}

/** Timer primitive abstraction (tests inject a controllable clock). */
export interface DreamClock {
  now(): number
  setTimeout(fn: () => void, ms: number): { clear(): void }
}

export interface DreamRuntime {
  /** turn_settled collector entry (lightweight, bounded, best-effort assistant excerpt). */
  collectFromSettledTurn(payload: TurnSettledPayload): Promise<void>
  /** Run (or join) the dream for one profile; throws on real failures, returns skips honestly. */
  dreamFor(profileId: string): Promise<DreamRunSummary>
  /** Status view across all candidate-bearing profiles. */
  status(): Promise<DreamStatusView>
  /** Apply a config patch; validates, persists and reschedules. */
  configure(patch: { enabled?: unknown; hour?: unknown; timezone?: unknown }): Promise<DreamConfig & { nextRunAt?: number }>
  /** Service lifecycle: start (restart recovery), stop (abort + wait). */
  start(): Promise<void>
  stop(): Promise<void>
  /** liveTasks labels for the plugin disable gate. */
  liveTasks(): string[]
  /** Test hook: wait until no dream/collect work is in flight. */
  settle(): Promise<void>
}

export interface DreamStatusView {
  config: DreamConfig
  nextRunAt?: number
  running: string[]
  profiles: Array<{
    profileId: string
    candidateCount: number
    /** null = MEMORY.md absent (dream would skip with memory_missing). */
    memoryChars: number | null
    lastRun?: DreamProfileRunRecord
  }>
}

// ---------------------------------------------------------------------------
// Pure functions (exported for tests)
// ---------------------------------------------------------------------------

/** Default timezone: the host system's IANA zone (honest local-time semantics; configurable). */
export function defaultDreamTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return tz === undefined || tz === '' ? 'UTC' : tz
}

export function defaultDreamDoc(): DreamDoc {
  return {
    version: 1,
    config: { enabled: true, hour: DEFAULT_DREAM_HOUR, timezone: defaultDreamTimezone() },
    runs: {},
  }
}

/** Strictly parse and validate the persisted private doc (bad data errors explicitly). */
export function parseDreamDoc(raw: unknown): DreamDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultDreamDoc()
  }
  const doc = raw as Partial<DreamDoc> & Record<string, unknown>
  if (doc.version !== 1) return defaultDreamDoc()
  const config = doc.config as Partial<DreamConfig> | undefined
  if (
    config === undefined ||
    typeof config !== 'object' ||
    typeof config.enabled !== 'boolean' ||
    !Number.isInteger(config.hour) ||
    (config.hour as number) < 0 ||
    (config.hour as number) > 23 ||
    typeof config.timezone !== 'string' ||
    config.timezone === ''
  ) {
    throw new HelmxError('dream_doc_corrupt', 'dream doc corrupted: invalid config shape', 500, {})
  }
  const runs: Record<string, DreamProfileRunRecord> = {}
  if (doc.runs !== undefined && typeof doc.runs === 'object' && !Array.isArray(doc.runs)) {
    for (const [profileId, record] of Object.entries(doc.runs as Record<string, unknown>)) {
      if (record !== null && typeof record === 'object' && typeof (record as DreamProfileRunRecord).lastRunAt === 'number') {
        runs[profileId] = record as DreamProfileRunRecord
      }
    }
  }
  const nextRunAt =
    typeof doc.nextRunAt === 'number' && Number.isFinite(doc.nextRunAt) ? (doc.nextRunAt as number) : undefined
  return { version: 1, config: config as DreamConfig, ...(nextRunAt !== undefined ? { nextRunAt } : {}), runs }
}

/** Next wall-clock occurrence of hour:00 in `timezone` strictly after afterMs (daily schedule). */
export function nextDailyRunAt(hour: number, timezone: string, afterMs: number): number {
  try {
    const iter = CronExpressionParser.parse(`0 ${hour} * * *`, {
      currentDate: new Date(afterMs),
      tz: timezone,
    })
    if (!iter.hasNext()) {
      // A daily expression always has a next point; defensive explicit error instead of silence.
      throw new Error('daily expression has no next point')
    }
    return iter.next().getTime()
  } catch (err) {
    if (err instanceof HelmxError) throw err
    throw new HelmxError(
      'validation_error',
      `invalid dream schedule (hour=${hour} tz=${timezone}): ${err instanceof Error ? err.message : String(err)}`,
      400,
      { hour, timezone },
    )
  }
}

/**
 * Extract the bounded final assistant text of a settled turn from the newest page of visible
 * entries: only `pi.assistant` entries' text blocks are used; thinking / toolCall blocks and all
 * other kinds (tool results, user echo, bookkeeping) are structurally dropped.
 */
export function extractFinalAssistantText(entries: ConversationEntry[], cap: number): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry === null || entry === undefined || entry.kind !== 'pi.assistant' || !Array.isArray(entry.model)) continue
    const message = entry.model[0] as { content?: unknown } | undefined
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    return text.length > cap ? `${text.slice(0, cap)}…[truncated]` : text
  }
  return undefined
}

const CODE_LINE_PATTERN =
  /^\s*(?:\$|>|#|\+|at\s+[^\s]+|(?:const|let|var|import|export|function|class|def|return|if|for|while|switch)\s|\{|\}|\/\/|\/\*|\*)/
const PURE_COMMAND_PATTERN =
  /^(?:\$|>)?\s*(?:helmx|pnpm|npm|yarn|npx|git|docker|kubectl|cd|ls|ll|cat|rg|grep|sed|awk|find|curl|wget|ssh|scp|tar|zip|python3?|pip3?|node|tsx|pytest|jest|vitest|make|cmake|cargo|gcc|mkdir|rm|cp|mv|touch|chmod|chown|echo|export|source|sudo|apt|brew|systemctl)\b/
const HAS_CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

/**
 * Conservative mechanical low-value filter for human inputs (the dream model makes the final
 * value judgment): slash commands, tiny acks, and predominantly code/log dumps are dropped.
 */
export function looksLikeLowValueHumanInput(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 6) return true
  if (trimmed.startsWith('/')) return true
  const lines = trimmed.split('\n').filter((line) => line.trim() !== '')
  if (lines.length >= 3) {
    const codeish = lines.filter((line) => CODE_LINE_PATTERN.test(line)).length
    if (codeish / lines.length >= 0.7) return true
  }
  if (lines.length === 1 && PURE_COMMAND_PATTERN.test(trimmed) && !HAS_CJK.test(trimmed)) return true
  return false
}

/** System prompt of the consolidation call (strict JSON contract; facts only). */
export const DREAM_SYSTEM_PROMPT = [
  'You are the long-term memory consolidation engine of a personal assistant.',
  'You receive the current MEMORY.md of one profile and a chronological list of candidate excerpts collected from settled conversation turns (bounded, secret-redacted human inputs and final assistant replies).',
  'Your task: produce the consolidated MEMORY.md that best serves future conversations.',
  '',
  'Output contract (strict):',
  '- Reply with a single JSON object and nothing else: {"memory":"<full new MEMORY.md content>"}.',
  '- "memory" is the complete new file content in Markdown, not a diff.',
  '',
  'Content rules:',
  '- Base every kept fact on the current memory or the candidates; never invent facts, never guess.',
  '- Keep: stable user preferences, corrections and long-term conventions (the newest statement wins over contradicted older ones), durable project context, unfinished cross-conversation matters that are still relevant.',
  '- Drop: one-off task chatter, commands, code, stack traces, troubleshooting details, transient status, secret-like tokens, anything without long-term value; dropped facts are simply absent.',
  '- Remove duplicates and merge related items; keep the user\'s language and a concise Markdown structure (# Memory heading style).',
  `- Length budget: aim for about ${DREAM_TARGET_CHARS} characters; never exceed ${MAX_MEMORY_CHARS} characters.`,
].join('\n')

/** Build the dream user text: current memory + candidates (oldest first, bounded upstream). */
export function buildDreamUserText(memory: string, candidates: DreamCandidate[]): string {
  const lines = [
    `Current MEMORY.md (${memory.length} chars):`,
    memory,
    '',
    `Candidates (oldest first, ${candidates.length}):`,
  ]
  for (const candidate of candidates) {
    const when = new Date(candidate.collectedAt).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(`- [${when}Z] conversation "${candidate.conversationTitle}" (#${candidate.conversationId})`)
    lines.push(`  human: ${candidate.humanText}`)
    if (candidate.assistantText !== undefined) lines.push(`  assistant: ${candidate.assistantText}`)
  }
  return lines.join('\n')
}

export type DreamOutputRejectionReason = 'not_json' | 'shape' | 'blank' | 'over_cap' | 'over_budget'

/**
 * Strictly validate the model output of a dream: a single JSON object with exactly one string
 * field "memory", non-blank, within the hard 64k cap and the computed budget. Anything else
 * throws HelmxError('dream_output_invalid', 502) with the machine-readable reason -- the caller
 * never writes an invalid result back.
 */
export function parseDreamModelOutput(raw: string, budget: number): { memory: string } {
  let text = raw.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence !== null) text = fence[1]!.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw dreamOutputError(
      'not_json',
      `model output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw dreamOutputError('shape', 'model output must be a single JSON object {"memory": string}')
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'memory' || typeof record.memory !== 'string') {
    throw dreamOutputError('shape', 'model output must be a single JSON object {"memory": string}')
  }
  const memory = record.memory
  if (memory.trim() === '') {
    throw dreamOutputError(
      'blank',
      'refusing to write back a blank memory; clearing memory requires an explicit replace',
    )
  }
  if (memory.length > MAX_MEMORY_CHARS) {
    throw dreamOutputError(
      'over_cap',
      `consolidated memory is ${memory.length} chars, over the hard cap of ${MAX_MEMORY_CHARS}`,
    )
  }
  if (memory.length > budget) {
    throw dreamOutputError(
      'over_budget',
      `consolidated memory is ${memory.length} chars, over the dream budget of ${budget}; a dream must consolidate, not expand`,
    )
  }
  return { memory }
}

function dreamOutputError(reason: DreamOutputRejectionReason, message: string): HelmxError {
  return new HelmxError('dream_output_invalid', `dream model output rejected (${reason}): ${message}`, 502, {
    reason,
  })
}

function boundExcerpt(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…[truncated]` : text
}

// ---------------------------------------------------------------------------
// Private file storage: candidates + snapshots (plugin dataDir only, never public docs)
// ---------------------------------------------------------------------------

interface CandidatesFile {
  version: 1
  candidates: DreamCandidate[]
}

function assertDreamDirProfileId(profileId: string): void {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new HelmxError('validation_error', `invalid profile id for dream storage: ${String(profileId)}`, 400, {
      profileId,
    })
  }
}

/** Bounded per-profile file store under `<pluginDataDir>/dream/<profileId>/`. */
export class DreamFiles {
  constructor(private readonly dataDir: string) {}

  private root(): string {
    return join(this.dataDir, 'dream')
  }

  private dir(profileId: string): string {
    assertDreamDirProfileId(profileId)
    return join(this.dataDir, 'dream', profileId)
  }

  /** All profile IDs that have a dream directory (sorted, deterministic). */
  async profileIds(): Promise<string[]> {
    try {
      const names = await readdir(this.root(), { withFileTypes: true })
      return names
        .filter((e) => e.isDirectory() && PROFILE_ID_PATTERN.test(e.name))
        .map((e) => e.name)
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async listCandidates(profileId: string, now: number): Promise<DreamCandidate[]> {
    const path = join(this.dir(profileId), 'candidates.json')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Corrupted candidates are lost dream input, not a hub failure: reset the file honestly
      // (MEMORY.md untouched) and report loudly.
      await writeFile(path, JSON.stringify({ version: 1, candidates: [] }), 'utf8')
      throw new HelmxError(
        'dream_candidates_corrupt',
        `candidates file of profile '${profileId}' is corrupted; it has been reset (dream input lost, MEMORY.md untouched)`,
        500,
        { profileId },
      )
    }
    const file = parsed as CandidatesFile
    if (file === null || typeof file !== 'object' || !Array.isArray(file.candidates)) {
      throw new HelmxError('dream_candidates_corrupt', `candidates file of profile '${profileId}' has an invalid shape`, 500, {
        profileId,
      })
    }
    // TTL applies as a read-side view (stale entries drop out of dreams; the file rewrites on append).
    return file.candidates.filter(
      (c): c is DreamCandidate =>
        c !== null &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        typeof c.humanText === 'string' &&
        now - (c.collectedAt ?? 0) < CANDIDATE_TTL_MS,
    )
  }

  /**
   * Append one candidate: dedup by (conversationId, humanText), TTL-prune, cap the count (oldest
   * dropped), atomic-enough write. Concurrency is serialized by the engine's collector chain.
   */
  async appendCandidate(profileId: string, candidate: DreamCandidate, now: number): Promise<number> {
    const dir = this.dir(profileId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'candidates.json')
    let current: DreamCandidate[] = []
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as CandidatesFile
      if (Array.isArray(parsed?.candidates)) current = parsed.candidates
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (current.some((c) => c.conversationId === candidate.conversationId && c.humanText === candidate.humanText)) {
      return current.length
    }
    const next = [...current.filter((c) => now - (c.collectedAt ?? 0) < CANDIDATE_TTL_MS), candidate]
    while (next.length > MAX_CANDIDATES_PER_PROFILE) next.shift()
    await writeFile(path, JSON.stringify({ version: 1, candidates: next }), 'utf8')
    return next.length
  }

  async clearCandidates(profileId: string): Promise<void> {
    await mkdir(this.dir(profileId), { recursive: true })
    await writeFile(join(this.dir(profileId), 'candidates.json'), JSON.stringify({ version: 1, candidates: [] }), 'utf8')
  }

  /**
   * Remove exactly the consumed candidate ids (dream success path): candidates collected while the
   * dream was running survive untouched, so consumption never swallows fresh signal even without
   * cross-call locking. Callers serialize this against appends per profile.
   */
  async removeCandidates(profileId: string, ids: string[]): Promise<number> {
    const path = join(this.dir(profileId), 'candidates.json')
    let current: DreamCandidate[] = []
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as CandidatesFile
      if (Array.isArray(parsed?.candidates)) current = parsed.candidates
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return 0
    }
    const consumed = new Set(ids)
    const next = current.filter((c) => !consumed.has(c.id))
    if (next.length === current.length) return next.length
    await writeFile(path, JSON.stringify({ version: 1, candidates: next }), 'utf8')
    return next.length
  }

  /** Write one diagnostic snapshot and prune the retention window (count + age). */
  async writeSnapshot(profileId: string, snapshot: DreamSnapshot, now: number): Promise<void> {
    const dir = join(this.dir(profileId), 'snapshots')
    await mkdir(dir, { recursive: true })
    const name = `${snapshot.ranAt}-${randomUUID().slice(0, 8)}.json`
    const bounded: DreamSnapshot =
      snapshot.modelOutput !== undefined && snapshot.modelOutput.length > MAX_SNAPSHOT_MODEL_OUTPUT_CHARS
        ? { ...snapshot, modelOutput: `${snapshot.modelOutput.slice(0, MAX_SNAPSHOT_MODEL_OUTPUT_CHARS)}…[truncated]` }
        : snapshot
    await writeFile(join(dir, name), JSON.stringify(bounded), 'utf8')
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
      const stale = names.filter((n, index) => {
        if (index < names.length - MAX_DREAM_SNAPSHOTS) return true
        const ranAt = Number.parseInt(n.split('-')[0] ?? '', 10)
        return Number.isFinite(ranAt) && now - ranAt > DREAM_SNAPSHOT_TTL_MS
      })
      await Promise.all(stale.map((n) => rm(join(dir, n), { force: true })))
    } catch {
      // Retention pruning is best-effort housekeeping; the snapshot itself is already durable.
    }
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface DreamEngineOptions {
  clock?: DreamClock
  modelTimeoutMs?: number
}
export type { DreamEngineOptions }

/** Assemble the dream runtime (service, collector and actions all call into this). */
export function createDreamEngine(ports: DreamHostPorts, options: DreamEngineOptions = {}): DreamRuntime {
  const clock = options.clock ?? defaultClock()
  const modelTimeoutMs = options.modelTimeoutMs ?? DREAM_MODEL_TIMEOUT_MS
  const files = new DreamFiles(ports.dataDir)

  let stopping = false
  let timer: { clear(): void } | undefined
  /** Per-profile single-flight dream runs. */
  const inflight = new Map<string, Promise<DreamRunSummary>>()
  /** In-flight collector appends keyed by conversationId (liveTasks labels + stop convergence). */
  const collecting = new Map<number, Promise<void>>()
  /** Abort controllers of in-flight dream runs (stop aborts them all). */
  const runControllers = new Map<string, AbortController>()
  /**
   * Per-profile serialization of candidate-file mutations (append / consume): a collector append
   * and a dream's consumption for the same profile can never interleave their read-modify-write.
   */
  const profileChains = new Map<string, Promise<unknown>>()

  const serialized = <T>(profileId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = profileChains.get(profileId) ?? Promise.resolve()
    const task = prev.then(fn, fn)
    profileChains.set(
      profileId,
      task.catch(() => undefined),
    )
    return task
  }

  /** Post-commit bookkeeping must never mask the committed result; failures report best-effort. */
  const bestEffort = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      ports.emitError(`memory dream ${label} failed (result stays committed)`, err)
    }
  }

  const readDoc = (): DreamDoc => parseDreamDoc(ports.doc.get())

  const writeDoc = async (next: DreamDoc): Promise<void> => {
    ports.doc.set(next)
    await ports.doc.flush()
  }

  const recordRun = async (profileId: string, record: DreamProfileRunRecord): Promise<void> => {
    const current = readDoc()
    const runs = { ...current.runs, [profileId]: record }
    const keys = Object.keys(runs)
    if (keys.length > MAX_RUN_RECORDS) {
      for (const key of [...keys].sort((a, b) => (runs[a]!.lastRunAt ?? 0) - (runs[b]!.lastRunAt ?? 0))) {
        delete runs[key]
        if (Object.keys(runs).length <= MAX_RUN_RECORDS) break
      }
    }
    await writeDoc({ ...current, runs })
  }

  const scheduleNext = (): void => {
    timer?.clear()
    timer = undefined
    if (stopping) return
    const current = readDoc()
    if (!current.config.enabled) return
    let at = current.nextRunAt
    if (at === undefined || !Number.isFinite(at)) {
      at = nextDailyRunAt(current.config.hour, current.config.timezone, clock.now())
      ports.doc.set({ ...current, nextRunAt: at })
    }
    const delayMs = Math.max(0, at - clock.now())
    timer = clock.setTimeout(() => {
      timer = undefined
      void sweep().catch((err) => ports.emitError('memory dream sweep failed', err))
    }, Math.min(delayMs, MAX_TIMEOUT_MS))
  }

  /** Daily sweep: dream every eligible profile sequentially, then advance the schedule. */
  const sweep = async (): Promise<void> => {
    if (stopping) return
    const current = readDoc()
    if (!current.config.enabled) return
    const profileIds = await files.profileIds()
    const existing = new Set((await ports.profiles.list()).map((p) => p.id))
    for (const profileId of profileIds) {
      if (stopping) return
      if (!existing.has(profileId) || !ports.isMemoryEnabled(profileId)) continue
      try {
        await dreamFor(profileId)
      } catch (err) {
        // Per-profile failures are recorded inside runDream; only truly unexpected escapees land here.
        ports.emitError(`memory dream of profile '${profileId}' failed unexpectedly`, err)
      }
    }
    const after = readDoc()
    const nextRunAt = nextDailyRunAt(after.config.hour, after.config.timezone, clock.now())
    await writeDoc({ ...after, nextRunAt })
    scheduleNext()
  }

  /** Bind completeText to a real existing top-level human-owned conversation of this profile. */
  const resolveModelConversation = (profileId: string): ConversationSummary | undefined => {
    const candidates = ports
      .listConversations({ profileId, topLevelOnly: true })
      .filter((c) => c.parentConversationId === undefined && (c.ownedBy ?? 'human') === 'human')
    if (candidates.length === 0) return undefined
    return candidates.reduce((best, c) =>
      c.updatedAt > best.updatedAt || (c.updatedAt === best.updatedAt && c.id > best.id) ? c : best,
    )
  }

  const dreamFor = (profileId: string): Promise<DreamRunSummary> => {
    const existing = inflight.get(profileId)
    if (existing) return existing
    const task = runDream(profileId).finally(() => {
      inflight.delete(profileId)
      runControllers.delete(profileId)
    })
    inflight.set(profileId, task)
    return task
  }

  const runDream = async (profileId: string): Promise<DreamRunSummary> => {
    const now = clock.now()
    // The abort controller is registered BEFORE any await: a stop arriving during the file-read
    // phase still aborts this run (checkpoints below re-check; the model port rejects on an
    // already-aborted signal too), so stop() can never wait on an unabortable dream.
    const controller = new AbortController()
    runControllers.set(profileId, controller)

    // 1) Current memory + CAS baseline (missing file = legal skip; before_turn lazily initializes).
    let memory: { content: string; hash: string }
    try {
      memory = await ports.store.readMemoryWithHash(profileId)
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'not_found') {
        await recordRun(profileId, { lastRunAt: now, ran: false, reason: 'memory_missing' })
        return { profileId, ran: false, reason: 'memory_missing', candidateCount: 0 }
      }
      throw err
    }
    controller.signal.throwIfAborted()

    // 2) Candidates (TTL-pruned view); zero candidates = legal skip, no model call.
    const candidates = await files.listCandidates(profileId, now)
    const snapshotBase: DreamSnapshot = {
      ranAt: now,
      profileId,
      candidateCount: candidates.length,
      candidateIds: candidates.map((c) => c.id),
      beforeChars: memory.content.length,
      sourceHash: memory.hash,
    }
    if (candidates.length === 0) {
      await recordRun(profileId, { lastRunAt: now, ran: false, reason: 'no_candidates', beforeChars: memory.content.length })
      return { profileId, ran: false, reason: 'no_candidates', candidateCount: 0, beforeChars: memory.content.length }
    }

    // 3) Model resolution: a real existing top-level human-owned conversation of this profile;
    //    none = legal skip with an explicit reason (never a hidden conversation).
    const modelConversation = resolveModelConversation(profileId)
    if (modelConversation === undefined) {
      await files.writeSnapshot(profileId, { ...snapshotBase, reason: 'no_conversation_for_model' }, now)
      await recordRun(profileId, {
        lastRunAt: now,
        ran: false,
        reason: 'no_conversation_for_model',
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
      })
      return {
        profileId,
        ran: false,
        reason: 'no_conversation_for_model',
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
      }
    }

    // 4) Consolidation call (single-shot, no conversation turn; stop aborts; bounded deadline).
    controller.signal.throwIfAborted()
    const deadline = setTimeout(() => controller.abort(), modelTimeoutMs)
    deadline.unref?.()
    let raw = ''
    let failure: HelmxError | undefined
    try {
      raw = await ports.completeText({
        conversationId: modelConversation.id,
        systemPrompt: DREAM_SYSTEM_PROMPT,
        text: buildDreamUserText(memory.content, candidates),
        signal: controller.signal,
      })
    } catch (err) {
      failure =
        err instanceof HelmxError
          ? err
          : new HelmxError('dream_model_failed', redactedCause(ports, err), 502, { cause: err instanceof Error ? err.name : undefined })
    } finally {
      clearTimeout(deadline)
    }

    if (failure !== undefined) {
      await files.writeSnapshot(profileId, { ...snapshotBase, error: failure.code, ...(raw === '' ? {} : { modelOutput: raw }) }, now)
      await recordRun(profileId, {
        lastRunAt: now,
        ran: true,
        applied: false,
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
        error: `${failure.code}: ${failure.message}`.slice(0, 300),
      })
      throw failure
    }

    // 5) Strict output validation; an invalid output never writes back (candidates + snapshot kept).
    let nextMemory: string
    try {
      nextMemory = parseDreamModelOutput(raw, dreamBudgetChars(memory.content.length)).memory
    } catch (err) {
      const rejection =
        err instanceof HelmxError ? err : new HelmxError('dream_output_invalid', 'unknown parse failure', 502)
      await files.writeSnapshot(profileId, { ...snapshotBase, error: rejection.code, modelOutput: raw }, now)
      await recordRun(profileId, {
        lastRunAt: now,
        ran: true,
        applied: false,
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
        error: `${rejection.code}: ${rejection.message}`.slice(0, 300),
      })
      throw rejection
    }

    // 6) CAS write-back: MemoryStore re-reads and re-hashes inside the same file lock.
    controller.signal.throwIfAborted()
    const committed = await ports.store.commitDreamMemory(profileId, memory.hash, nextMemory)
    if (!committed.applied) {
      await bestEffort('conflict journal', () =>
        files.writeSnapshot(profileId, { ...snapshotBase, conflict: true }, now),
      )
      await recordRun(profileId, {
        lastRunAt: now,
        ran: true,
        applied: false,
        conflict: true,
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
        error:
          'memory_changed_during_dream: MEMORY.md was edited while the dream ran; write-back abandoned, candidates kept',
      })
      return {
        profileId,
        ran: true,
        applied: false,
        conflict: true,
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
      }
    }

    // 7) MEMORY.md is committed. Post-commit bookkeeping (consume exactly the folded candidates,
    //    journal, record) is best-effort: a failure here must not misreport the applied dream as
    //    failed -- unconsumed candidates simply re-fold harmlessly on the next dream (the model
    //    deduplicates against the memory that already contains them).
    const consumedIds = candidates.map((c) => c.id)
    await bestEffort('candidate consumption', () =>
      serialized(profileId, () => files.removeCandidates(profileId, consumedIds)),
    )
    await bestEffort('result journal', () =>
      files.writeSnapshot(profileId, { ...snapshotBase, applied: true, afterChars: nextMemory.length }, now),
    )
    await bestEffort('run record', () =>
      recordRun(profileId, {
        lastRunAt: now,
        ran: true,
        applied: true,
        candidateCount: candidates.length,
        beforeChars: memory.content.length,
        afterChars: nextMemory.length,
      }),
    )
    return {
      profileId,
      ran: true,
      applied: true,
      candidateCount: candidates.length,
      consumed: candidates.length,
      beforeChars: memory.content.length,
      afterChars: nextMemory.length,
    }
  }

  const collectFromSettledTurn = async (payload: TurnSettledPayload): Promise<void> => {
    if (stopping) return
    if (payload.outcome !== 'completed') return
    const conversation = payload.conversation
    if (conversation.parentConversationId !== undefined) return
    if ((conversation.ownedBy ?? 'human') !== 'human') return
    if (!ports.isMemoryEnabled(conversation.profileId)) return

    const humanText = payload.inputs
      .filter((input) => input.origin === 'human' && typeof input.text === 'string')
      .map((input) => input.text.trim())
      .filter((text) => text !== '' && !looksLikeLowValueHumanInput(text))
      .join('\n')
      .trim()
    if (humanText === '') return

    const task = (async (): Promise<void> => {
      const now = clock.now()
      const candidate: DreamCandidate = {
        id: randomUUID(),
        conversationId: conversation.id,
        conversationTitle: ports.redact(boundExcerpt(conversation.title ?? '', MAX_CANDIDATE_TITLE_CHARS)),
        humanText: ports.redact(boundExcerpt(humanText, MAX_CANDIDATE_HUMAN_CHARS)),
        collectedAt: now,
      }
      // Optional bounded final-assistant-text excerpt (auxiliary context for the dream model);
      // tool outputs / thinking are structurally excluded by extractFinalAssistantText.
      try {
        const detail = await ports.getConversationDetail(conversation.id, { limit: 6 })
        const text = extractFinalAssistantText(detail.entries, MAX_CANDIDATE_ASSISTANT_CHARS)
        if (text !== undefined && text !== '') candidate.assistantText = ports.redact(text)
      } catch {
        // The excerpt is auxiliary enrichment; the human input stays a valid candidate without it.
        candidate.assistantText = undefined
      }
      // Serialized against the same profile's dream consumption (never interleaved RMW).
      await serialized(conversation.profileId, () => files.appendCandidate(conversation.profileId, candidate, now))
    })()
    collecting.set(conversation.id, task)
    try {
      await task
    } finally {
      if (collecting.get(conversation.id) === task) collecting.delete(conversation.id)
    }
  }

  const status = async (): Promise<DreamStatusView> => {
    const current = readDoc()
    const now = clock.now()
    const view: DreamStatusView = {
      config: current.config,
      ...(current.nextRunAt !== undefined ? { nextRunAt: current.nextRunAt } : {}),
      running: [...inflight.keys()].sort(),
      profiles: [],
    }
    for (const profileId of await files.profileIds()) {
      let candidateCount = 0
      try {
        candidateCount = (await files.listCandidates(profileId, now)).length
      } catch {
        candidateCount = 0
      }
      let memoryChars: number | null = null
      try {
        memoryChars = (await ports.store.readMemoryWithHash(profileId)).content.length
      } catch {
        memoryChars = null
      }
      view.profiles.push({
        profileId,
        candidateCount,
        memoryChars,
        ...(current.runs[profileId] !== undefined ? { lastRun: current.runs[profileId] } : {}),
      })
    }
    return view
  }

  const configure = async (
    patch: { enabled?: unknown; hour?: unknown; timezone?: unknown },
  ): Promise<DreamConfig & { nextRunAt?: number }> => {
    const current = readDoc()
    const provided: string[] = []
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') {
        throw new HelmxError('validation_error', 'enabled must be a boolean', 400, { field: 'enabled' })
      }
      provided.push('enabled')
    }
    if (patch.hour !== undefined) {
      if (!Number.isInteger(patch.hour) || (patch.hour as number) < 0 || (patch.hour as number) > 23) {
        throw new HelmxError('validation_error', 'hour must be an integer between 0 and 23 (local hour-of-day)', 400, {
          field: 'hour',
        })
      }
      provided.push('hour')
    }
    if (patch.timezone !== undefined) {
      if (typeof patch.timezone !== 'string' || patch.timezone.trim() === '') {
        throw new HelmxError('validation_error', 'timezone must be a non-empty IANA zone name', 400, { field: 'timezone' })
      }
      provided.push('timezone')
    }
    if (provided.length === 0) {
      throw new HelmxError('validation_error', 'provide at least one of enabled / hour / timezone', 400, {})
    }
    const nextConfig: DreamConfig = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.config.enabled,
      hour: patch.hour !== undefined ? (patch.hour as number) : current.config.hour,
      timezone: typeof patch.timezone === 'string' ? patch.timezone : current.config.timezone,
    }
    // Validate the resulting schedule eagerly (a bad tz/hour fails here, never at timer time).
    const nextRunAt = nextDailyRunAt(nextConfig.hour, nextConfig.timezone, clock.now())
    // Pausing clears the persisted next run point (no stale schedule survives re-enable).
    const { nextRunAt: _stale, ...rest } = current
    void _stale
    const next: DreamDoc = {
      ...rest,
      config: nextConfig,
      ...(nextConfig.enabled ? { nextRunAt } : {}),
    }
    await writeDoc(next)
    scheduleNext()
    return { ...nextConfig, ...(next.nextRunAt !== undefined ? { nextRunAt: next.nextRunAt } : {}) }
  }

  return {
    collectFromSettledTurn,
    dreamFor,
    status,
    configure,
    async start() {
      stopping = false
      const current = readDoc()
      // Restart recovery: a persisted nextRunAt that already passed (downtime) catches up once
      // now; otherwise the timer resumes at the persisted point (no drift-back recompute).
      // The catch-up point is persisted (set + flush) BEFORE any timer is scheduled, so a crash
      // between the two can neither lose nor duplicate the recovery decision.
      if (current.config.enabled && (current.nextRunAt === undefined || current.nextRunAt <= clock.now())) {
        await writeDoc({ ...current, nextRunAt: clock.now() + 1 })
      }
      scheduleNext()
    },
    async stop() {
      stopping = true
      timer?.clear()
      timer = undefined
      for (const controller of runControllers.values()) controller.abort()
      const pending = [...inflight.values(), ...collecting.values()]
      if (pending.length > 0) await Promise.allSettled(pending)
      await Promise.allSettled([...profileChains.values()])
    },
    liveTasks() {
      return [
        ...[...inflight.keys()].map((profileId) => `memory-dream:${profileId}`),
        ...[...collecting.keys()].map((conversationId) => `memory-dream-collect:${conversationId}`),
      ]
    },
    async settle() {
      for (let i = 0; i < 100 && (inflight.size > 0 || collecting.size > 0); i += 1) {
        await Promise.allSettled([...inflight.values(), ...collecting.values()])
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
  }
}

function redactedCause(ports: DreamHostPorts, err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return ports.redact(message).slice(0, 300)
}

function defaultClock(): DreamClock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return { clear: () => clearTimeout(t) }
    },
  }
}
