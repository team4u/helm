/**
 * Single-flight blocked <-> AskDoc coordinator (inFlightAsks).
 *
 * Key designs against feedback loops and races (all from real incident feedback):
 * 1. Settled entries are kept until "seq advances or the pane closes": when send_keys was sent but the terminal
 *    is briefly still blocked on the same seq plus a duplicate socket event, do not rebuild the same-ID Ask nor
 *    re-send keys; a wait briefly returning the same blocked seq is likewise swallowed directly (wait for real progress).
 * 2. Register the entry before starting createAsk: ask.upsert may call back synchronously (terminal handles it first ->
 *    cancelAsk); registration must precede any visible side effect.
 * 3. createAsk 404 race (the ask is cancelled by the event path before storage): the event-path cancellation only clears
 *    the coordinator entry; if the owner's createAsk then succeeds, markPending rebuilds the entry and the
 *    host settle channel finishes it; never leave an unclaimed pending Ask.
 * 4. Dedup key = herdr:<nodeId|local>:<paneId>:<stateChangeSeq> (same shape as the Ask's pre-allocated ID);
 *    across the dual paths (socket event and spawn wait), the first to register the entry becomes the owner
 *    responsible for createAsk; the later one reuses the same entry via duplicate; never rebuild the same-ID Ask.
 * 5. Cancellation/event-handling errors surface through explicit channels (notify or propagate to spawn); no empty catches.
 * 6. Authoritative observations are directional: only a strict seq advance voids old entries; a seq regression only voids
 *    already-settled tombstones (after a Herdr restart resets seq to zero, tombstones must not suppress re-asking),
 *    never voiding pending/creating live entries (a stale out-of-order observation from a concurrent agent.get must not
 *    fake-destroy an AskDoc the human is looking at).
 */

import { HelmError } from '@helm/protocol'

export type AskPhase = 'creating' | 'pending' | 'sent' | 'settled'

export interface AskEntry {
  readonly key: string
  askId: string
  readonly nodeId: string | undefined
  readonly paneId: string
  readonly seq: number
  phase: AskPhase
  /** Which approval attempt under the current seq (0-based; at 0 askId === key, on retry N askId === `${key}:r${N}`). */
  attempt: number
  /** send_keys has been executed once in the current attempt. */
  keysSent: boolean
  /** The most recently sent keystroke sequence (to hint the human when a retry happens due to an uncleared block). */
  lastSentKeys?: string[]
  /** Timestamp when the current attempt settled. */
  settledAt?: number
}

/** Authoritative terminal state change (agent.get or event-driven probing). */
export interface AuthorityUpdate {
  paneId: string
  nodeId?: string
  seq: number
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
}

/**
 * beginBlocked result:
 * - owner: the caller won creation rights (responsible for createAsk and settle);
 * - duplicate: this (pane,seq) is already handled or being handled (no rebuild, no re-send, no new creation).
 */
export type BeginBlockedResult = { owner: AskEntry } | { duplicate: true }

export class AskCoordinator {
  private readonly entries_map = new Map<string, AskEntry>()
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /**
   * Authoritative terminal state update (event path / wait return / remote polling):
   * - seq strictly advanced: clear all old entries of the pane (incl. kept settled ones);
   * - seq regressed (Herdr restart reset seq to zero): void only settled tombstones (so they don't suppress
   *   re-asking at the same seq later); pending/creating live entries are not voided -- a stale out-of-order observation
   *   must not fake-destroy an AskDoc the human is looking at (a real restart is finalized by the execution loop's authoritative recheck).
   * Returns still-pending voided entries (the caller applies cancelAsk superseded to them).
   */
  observeAuthority(update: AuthorityUpdate): AskEntry[] {
    const superseded: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId !== update.paneId || entry.nodeId !== update.nodeId) continue
      if (update.seq === entry.seq) continue
      if (update.seq < entry.seq && entry.phase !== 'settled') continue
      this.removeEntry(entry)
      if (entry.phase === 'pending' || entry.phase === 'creating') superseded.push(entry)
    }
    this.onChange()
    return superseded
  }

  /** Pane closed: clear all entries (incl. kept ones). */
  paneClosed(paneId: string, nodeId?: string): AskEntry[] {
    const removed: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId === paneId && entry.nodeId === nodeId) {
        this.removeEntry(entry)
        removed.push(entry)
      }
    }
    this.onChange()
    return removed
  }

  /**
   * Register the blocked state (completed before any await):
   * - no entry for this (pane,seq) -> owner (responsible for createAsk + settle);
   * - an entry exists (any of creating/pending/sent/settled phases) -> duplicate;
   *   never rebuild the same-ID Ask, never re-send keys.
   */
  beginBlocked(nodeId: string | undefined, paneId: string, seq: number): BeginBlockedResult {
    const key = askKey(nodeId, paneId, seq)
    if (this.entries_map.has(key)) return { duplicate: true }
    const entry: AskEntry = {
      key,
      askId: key,
      nodeId,
      paneId,
      seq,
      phase: 'creating',
      attempt: 0,
      keysSent: false,
    }
    this.entries_map.set(key, entry)
    this.onChange()
    return { owner: entry }
  }

  /**
   * The createAsk call has really been issued (after the first await returns).
   * The creation path may have had its entry cleared by the event path's cancellation (404 race): if the host createAsk actually
   * succeeded (did not throw 404), rebuild the entry as pending -- the later host terminal-state callback has something to claim;
   * if the caller then confirms the ask was cancelled (cancelAsk 404), clear it with failCreate.
   */
  markPending(entry: AskEntry): void {
    const existing = this.entries_map.get(entry.key)
    if (existing !== undefined && existing !== entry) return
    this.entries_map.set(entry.key, entry)
    if (entry.phase === 'creating') {
      entry.phase = 'pending'
      this.onChange()
    }
  }

  /** Terminal state landed (answered/superseded/cancelled): the entry is kept until seq advances. */
  settle(entry: AskEntry, outcome: { keysSent: boolean; sentKeys?: string[] }): void {
    if (this.entries_map.get(entry.key) !== entry) return
    entry.phase = 'settled'
    entry.keysSent = outcome.keysSent
    entry.lastSentKeys = outcome.sentKeys
    entry.settledAt = Date.now()
    this.onChange()
  }

  /**
   * Reopen the approval when the same seq stays blocked: send_keys was sent but the terminal still sits blocked on the same
   * (nodeId, paneId, seq) (keystrokes not accepted), or the entry already settled (incl. superseded/cancelled,
   * keysSent=false) while the terminal is stuck on the same seq -- both need a reopen so the human can re-choose,
   * otherwise the backoff loop never escapes. The attempt increments to a new askId (`<key>:r<N>`, avoiding the host's
   * ask_id_conflict) and the entry returns to creating; when reopen conditions aren't met (no entry / not settled) returns undefined.
   */
  reopenUnresolved(nodeId: string | undefined, paneId: string, seq: number): AskEntry | undefined {
    const key = askKey(nodeId, paneId, seq)
    const entry = this.entries_map.get(key)
    if (entry === undefined || entry.phase !== 'settled') return undefined
    entry.attempt += 1
    entry.askId = `${entry.key}:r${entry.attempt}`
    entry.phase = 'creating'
    entry.keysSent = false
    entry.settledAt = undefined
    this.onChange()
    return entry
  }

  /**
   * When a host AskDoc ID collides (e.g. an existing AskDoc at the same seq across restarts),
   * advance the retry suffix (:r<N>) and return to creating phase (supported by parseAskId & seqResolver).
   */
  advanceRetryOnConflict(entry: AskEntry): void {
    if (this.entries_map.get(entry.key) !== entry) return
    entry.attempt += 1
    entry.askId = `${entry.key}:r${entry.attempt}`
    entry.phase = 'creating'
    this.onChange()
  }

  /** Creation failed (IO/host error/cancellation confirmed): entry removed (later retries allowed); the error propagates to the caller. */
  failCreate(entry: AskEntry): void {
    this.removeEntry(entry)
  }

  get(nodeId: string | undefined, paneId: string, seq: number): AskEntry | undefined {
    return this.entries_map.get(askKey(nodeId, paneId, seq))
  }

  /**
   * CAS seq resolver (async authoritative version): askId -> the target pane's **current real**
   * state_change_seq (agent.get live query; never return the creation-time entry.seq -- the whole point of CAS
   * is discovering "the terminal already advanced by keystrokes after creation"). Ownership check: the askId's
   * three segments must exactly match the entry's (nodeId, paneId, seq), preventing forged ids from probing others' panes.
   */
  seqResolver(
    askId: string,
    authority: (nodeId: string | undefined, paneId: string) => Promise<number | undefined>,
  ): Promise<number | undefined> {
    const parsed = parseAskId(askId)
    if (parsed === undefined) return Promise.resolve(undefined)
    const entry = this.entries_map.get(askKey(parsed.nodeId, parsed.paneId, parsed.seq))
    if (entry === undefined || entry.askId !== askId) return Promise.resolve(undefined)
    return authority(parsed.nodeId, parsed.paneId)
  }

  /** Whether keys were already sent for this (pane,seq) (for the re-send guard). */
  keysSent(nodeId: string | undefined, paneId: string, seq: number): boolean {
    return this.entries_map.get(askKey(nodeId, paneId, seq))?.keysSent === true
  }

  pendingCount(): number {
    let n = 0
    for (const entry of this.entries_map.values()) {
      if (entry.phase === 'pending' || entry.phase === 'creating') n += 1
    }
    return n
  }

  entries(): AskEntry[] {
    return [...this.entries_map.values()]
  }

  /** Overview (overview doc; nodeId undefined folds to 'local' to stay JSON-safe). */
  describe(): Array<{ paneId: string; nodeId: string; seq: number; phase: AskPhase }> {
    return [...this.entries_map.values()].map((e) => ({
      paneId: e.paneId,
      nodeId: e.nodeId ?? 'local',
      seq: e.seq,
      phase: e.phase,
    }))
  }

  /** Disable-time liquidation: clear all entries (the caller's stopResources already cancelled the host Asks;
   *  entries surviving across enable cycles would fake pendingAsk ghost data and misjudge duplicates). */
  settleAllAsSuperseded(): void {
    this.entries_map.clear()
    this.onChange()
  }

  private removeEntry(entry: AskEntry): void {
    if (this.entries_map.get(entry.key) !== entry) return
    this.entries_map.delete(entry.key)
    this.onChange()
  }
}

export function askKey(nodeId: string | undefined, paneId: string, seq: number): string {
  return `herdr:${nodeId ?? 'local'}:${paneId}:${seq}`
}

/**
 * The askId is the askKey literal (optional ':r<positive int>' retry suffix); the nodeId segment is preserved as-is
 * (not folding local, to avoid parse ambiguity). Example: both herdr:local:wR:p2:3916 and
 * herdr:local:wR:p2:3916:r1 parse to { nodeId: undefined, paneId: 'wR:p2', seq: 3916 }.
 *
 * Parse order: first strip a trailing well-formed ':r[1-9][0-9]*' retry suffix (r0/r01/oversized/forged
 * shapes are rejected wholesale, never falling back to seq parsing), then parse by the unambiguous "last colon = seq"
 * rule; a paneId containing colons is unaffected.
 */
function parseAskId(askId: string): { nodeId: string | undefined; paneId: string; seq: number } | undefined {
  if (!askId.startsWith('herdr:')) return undefined
  let rest = askId.slice('herdr:'.length)
  // Strip the well-formed ':r<positive int, no leading zeros>' retry suffix; an ill-formed suffix makes the later seq
  // parse fail (e.g. '...:3916:r01' or '...:3916:r0' cannot match ^\d+$; rejected wholesale).
  const retrySuffix = /:r([1-9][0-9]*)$/.exec(rest)
  if (retrySuffix !== null) {
    // Oversized retry integers (beyond safe integer) are likewise rejected, the same honesty standard as seq.
    const retry = Number(retrySuffix[1])
    if (!Number.isSafeInteger(retry)) return undefined
    rest = rest.slice(0, rest.length - retrySuffix[0].length)
  }
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return undefined
  const panePart = rest.slice(0, lastColon)
  const seqPart = rest.slice(lastColon + 1)
  if (!/^\d+$/.test(seqPart)) return undefined
  const seq = Number(seqPart)
  if (!Number.isSafeInteger(seq) || seq < 0 || seqPart !== String(seq)) return undefined
  const paneColon = panePart.indexOf(':')
  if (paneColon <= 0) return undefined
  const nodeId = panePart.slice(0, paneColon)
  const paneId = panePart.slice(paneColon + 1)
  if (paneId === '') return undefined
  return { nodeId: nodeId === 'local' ? undefined : nodeId, paneId, seq }
}

/**
 * "Wait for real progress" for the same-seq blocked: no busy spin -- the watchdog probe period or
 * socket event-driven updates advance the authoritative seq; this function only provides a cancellable backoff wait for the wait
 * loop to use upon receiving a duplicate same-seq blocked (avoiding immediately re-issuing agent.wait and saturating the channel).
 */
export async function backoffForDuplicateBlocked(signal: AbortSignal, attempt: number, baseMs = 500, capMs = 4_000): Promise<void> {
  const ms = Math.min(baseMs * 2 ** Math.min(attempt, 4), capMs)
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new HelmError('aborted', 'cancelled while waiting for terminal progress', 409))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new HelmError('aborted', 'cancelled while waiting for terminal progress', 409))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
