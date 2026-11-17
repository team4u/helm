/**
 * `HelmStore`: synchronous read/write mirror for helm-owned SQLite tables + FTS5 derived index.
 *
 * All SQL runs through the single `NodeSqliteDatabase` adapter (sharing a transaction queue with `pi_` tables);
 * never open a second connection. The in-memory mirror supports synchronous reads (`listConvs`, etc.); writes
 * update the mirror first and enqueue persistence onto a strictly FIFO promise tail chain (zero polling).
 * Persistence honesty contract:
 * - First persistence error is recorded and reported explicitly (never swallowed or faked as success);
 * - `flushPublic` throws `HelmError` whenever any unsettled persistence error exists (allowing callers to block downstream side effects);
 * - Subsequent writes fail closed once in failed state (no fake enqueuing);
 * - `close()` awaits full drain of in-flight flushes and returns the first persistence error to callers.
 */

import type { ArtifactKind, ConversationStatus, ConversationSummary } from '@helm/protocol'
import { HelmError, isArtifactKind } from '@helm/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { emitDiagnostic, type KernelDiagnosticSink } from './diagnostics.js'
import type { HelmDatabase } from './sqlite.js'

export interface ConvMeta {
  id: number
  title: string
  profileId: string
  tags: string[]
  parentConversationId?: number
  /** Parent conversation's tool call ID that spawned or most recently resumed this child (live execution correlation). */
  parentToolCallId?: string
  /** Bound compute node ID (defaults to `'local'`). */
  nodeId: string
  cwd: string
  /** Resolved effective model snapshot (empty string when unconfigured; display-only). */
  model: string
  /** Explicit model override (`'provider/model'`); `undefined` = inherit Profile/global. */
  modelOverride?: string
  /** Reasoning effort snapshot (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`; empty string = unset). */
  thinkingLevel: string
  /** Explicit reasoning effort override; `undefined` = inherit Profile/global. */
  thinkingLevelOverride?: string
  unread: boolean
  pinned: boolean
  stateChangeSeq: number
  completionSeq: number
  /** Latest visible timeline entry ID (`0` when none; hydrated by tracker.observe/adopt and maintained in memory). */
  lastEntryId?: number
  createdAt: number
  updatedAt: number
}

export interface AskRow {
  id: string
  conversationId: number
  ownerPluginId?: string
  specJson: string
  status: 'pending' | 'answered' | 'cancelled' | 'superseded'
  resultJson?: string
  expectedStateSeq?: number
  createdAt: number
  settledAt?: number
}

export interface ArtifactRow {
  id: string
  conversationId: number
  kind: ArtifactKind
  name: string
  path: string
  mimeType: string
  size: number
  createdAt: number
}

export interface PluginDocRow {
  pluginId: string
  name: string
  valueJson: string
}

export interface PluginSessionDocRow {
  pluginId: string
  name: string
  conversationId: number
  valueJson: string
}

type Deferred = () => Promise<void>

export interface HelmStoreOptions {
  /** Instance-level persistence failure callback (e.g., `KernelRuntime` fatal storage closure hook); falls back to diagnostic channel. */
  readonly onError?: (error: unknown) => void
  /** Diagnostic channel sink (fallback when `onError` is unset; defaults to `console.error`). */
  readonly onDiagnostic?: KernelDiagnosticSink
  /** Diagnostic redaction function (defaults to `ftsRedact`). */
  readonly redact?: (text: string) => string
}

export class HelmStore {
  private readonly db: NodeSqliteDatabase
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly onDiagnostic: KernelDiagnosticSink | undefined
  private readonly redactFn: ((text: string) => string) | undefined
  private readonly convs = new Map<number, ConvMeta>()
  private readonly asks = new Map<string, AskRow>()
  private readonly artifacts = new Map<string, ArtifactRow>()
  private readonly pluginDocs = new Map<string, string>() // pluginId\0name -> json
  /** Per-conversation plugin document mirror: `pluginId\0name\0conversationId -> json`. */
  private readonly pluginSessionDocs = new Map<string, string>()
  /** Logical deletion tombstones: prevents re-importing SDK-retained history after restarts. */
  private readonly tombstones = new Set<number>()
  /**
   * Persistence tail chain: all enqueued writes execute serially in FIFO order.
   * The chain itself never rejects (errors are caught and recorded internally), so `flushPublic`/`close` simply await it.
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  /** First persistence error; once set, the store enters failed state and rejects subsequent writes. */
  private firstError: unknown = undefined
  private eventSeq = 0
  /** Text redaction hook for FTS indexing (runtime injects `stash.redact`). */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmDatabase, options: HelmStoreOptions = {}) {
    this.db = database.db
    this.onError = options.onError
    this.onDiagnostic = options.onDiagnostic
    this.redactFn = options.redact
  }

  /** First persistence failure error (read-only; `undefined` when healthy). */
  get error(): unknown {
    return this.firstError
  }

  /** Load all mirrors from SQLite at startup; throws explicitly on corrupted persisted JSON (never fabricates empty values). */
  async load(): Promise<void> {
    for (const row of await this.db.all<{
      id: number
      title: string
      profile_id: string
      tags: string
      parent_conversation_id: number | null
      node_id: string | null
      cwd: string
      model: string
      model_override: string | null
      thinking_level: string | null
      thinking_level_override: string | null
      unread: number
      pinned: number
      state_change_seq: number
      completion_seq: number
      created_at: number
      updated_at: number
    }>(
      'SELECT id, title, profile_id, tags, parent_conversation_id, node_id, cwd, model, model_override, thinking_level, thinking_level_override, unread, pinned, state_change_seq, completion_seq, created_at, updated_at FROM helm_conversations',
    )) {
      this.convs.set(row.id, {
        id: row.id,
        title: row.title,
        profileId: row.profile_id,
        tags: parseStoredJson<string[]>(`helm_conversations#${row.id}.tags`, row.tags),
        parentConversationId: row.parent_conversation_id ?? undefined,
        nodeId: row.node_id || 'local',
        cwd: row.cwd,
        model: row.model,
        modelOverride: row.model_override ?? undefined,
        thinkingLevel: row.thinking_level ?? '',
        thinkingLevelOverride: row.thinking_level_override ?? undefined,
        unread: row.unread === 1,
        pinned: row.pinned === 1,
        stateChangeSeq: row.state_change_seq,
        completionSeq: row.completion_seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }
    // Parent tool-call correlation is stored in a separate table (`helm_conversation_tool_links`): read second
    // and merge into the mirror so existing `helm_conversations` schemas require no changes.
    for (const row of await this.db.all<{ conversation_id: number; parent_tool_call_id: string }>(
      'SELECT conversation_id, parent_tool_call_id FROM helm_conversation_tool_links',
    )) {
      const meta = this.convs.get(row.conversation_id)
      if (meta !== undefined) meta.parentToolCallId = row.parent_tool_call_id
    }
    for (const row of await this.db.all<{
      id: string
      conversation_id: number
      owner_plugin_id: string | null
      spec: string
      status: string
      result: string | null
      expected_state_seq: number | null
      created_at: number
      settled_at: number | null
    }>(
      'SELECT id, conversation_id, owner_plugin_id, spec, status, result, expected_state_seq, created_at, settled_at FROM helm_asks',
    )) {
      parseStoredJson<unknown>(`helm_asks#${row.id}.spec`, row.spec)
      if (row.result !== null) parseStoredJson<unknown>(`helm_asks#${row.id}.result`, row.result)
      this.asks.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        ownerPluginId: row.owner_plugin_id ?? undefined,
        specJson: row.spec,
        status: row.status as AskRow['status'],
        resultJson: row.result ?? undefined,
        expectedStateSeq: row.expected_state_seq ?? undefined,
        createdAt: row.created_at,
        settledAt: row.settled_at ?? undefined,
      })
    }
    for (const row of await this.db.all<{
      id: string
      conversation_id: number
      kind: string
      name: string
      path: string
      mime_type: string
      size: number
      created_at: number
    }>('SELECT id, conversation_id, kind, name, path, mime_type, size, created_at FROM helm_artifacts')) {
      if (!isArtifactKind(row.kind)) {
        throw new HelmError(
          'store_data_corrupted',
          `Persisted data corrupted (helm_artifacts#${row.id}.kind): invalid artifact kind '${String(row.kind)}'`,
          500,
          { id: row.id, kind: row.kind },
        )
      }
      this.artifacts.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind,
        name: row.name,
        path: row.path,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
      })
    }
    for (const row of await this.db.all<{ plugin_id: string; name: string; value: string }>(
      'SELECT plugin_id, name, value FROM helm_plugin_docs',
    )) {
      parseStoredJson<unknown>(`helm_plugin_docs#${row.plugin_id}:${row.name}.value`, row.value)
      this.pluginDocs.set(row.plugin_id + '\0' + row.name, row.value)
    }
    for (const row of await this.db.all<{ plugin_id: string; name: string; conversation_id: number; value: string }>(
      'SELECT plugin_id, name, conversation_id, value FROM helm_plugin_session_docs',
    )) {
      parseStoredJson<unknown>(
        `helm_plugin_session_docs#${row.plugin_id}:${row.name}#${row.conversation_id}.value`,
        row.value,
      )
      this.pluginSessionDocs.set(`${row.plugin_id}\0${row.name}\0${row.conversation_id}`, row.value)
    }
    const seqRow = await this.db.get<{ value: number }>(
      "SELECT value FROM helm_seq WHERE key = 'events'",
    )
    this.eventSeq = seqRow?.value ?? 0
    for (const row of await this.db.all<{ id: number }>('SELECT id FROM helm_tombstones')) {
      this.tombstones.add(row.id)
    }
  }

  isDeleted(id: number): boolean {
    return this.tombstones.has(id)
  }

  get eventSeqNow(): number {
    return this.eventSeq
  }

  /**
   * Persist event sequence: accepts non-negative safe integers only and never regresses monotonically.
   * Enqueued on the FIFO tail chain so DB writes match queue order and stale writes cannot rewind the sequence.
   */
  setEventSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HelmError('invalid_event_seq', `Event sequence must be a non-negative safe integer, received: ${seq}`, 500, {
        seq,
      })
    }
    if (seq < this.eventSeq) return // Reject regression: keep the higher watermark
    this.eventSeq = seq
    this.enqueue(() =>
      this.db.run(
        "INSERT INTO helm_seq (key, value) VALUES ('events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        seq,
      ),
    )
  }

  // ---------------- conversations ----------------

  listConvs(): ConvMeta[] {
    return [...this.convs.values()].map(cloneConv).sort((a, b) => b.id - a.id)
  }

  getConv(id: number): ConvMeta | undefined {
    const meta = this.convs.get(id)
    return meta ? cloneConv(meta) : undefined
  }

  /** Update the in-memory `lastEntryId` watermark for a conversation without emitting a SQLite write. */
  setLastEntryId(id: number, lastEntryId: number): void {
    if (!Number.isSafeInteger(lastEntryId) || lastEntryId < 0) {
      throw new HelmError(
        'validation_error',
        `lastEntryId must be a non-negative safe integer, received: ${String(lastEntryId)}`,
        400,
      )
    }
    const existing = this.convs.get(id)
    if (existing !== undefined) {
      existing.lastEntryId = lastEntryId
    }
  }

  upsertConv(meta: ConvMeta): void {
    this.assertWritable()
    const prev = this.convs.get(meta.id)
    const titleChanged = prev?.title !== meta.title
    // Deep-copy snapshot: SQL parameters bind to snapshot values so subsequent caller mutations cannot affect queued writes.
    const snap = cloneConv(meta)
    if (snap.lastEntryId === undefined && prev?.lastEntryId !== undefined) {
      snap.lastEntryId = prev.lastEntryId
    }
    this.convs.set(snap.id, snap)
    this.enqueue(async () => {
      await this.db.run(
        `INSERT INTO helm_conversations (id, title, profile_id, tags, parent_conversation_id, node_id, cwd, model, model_override, thinking_level, thinking_level_override, unread, pinned, state_change_seq, completion_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, profile_id=excluded.profile_id, tags=excluded.tags, parent_conversation_id=excluded.parent_conversation_id, node_id=excluded.node_id, cwd=excluded.cwd, model=excluded.model, model_override=excluded.model_override, thinking_level=excluded.thinking_level, thinking_level_override=excluded.thinking_level_override, unread=excluded.unread, pinned=excluded.pinned, state_change_seq=excluded.state_change_seq, completion_seq=excluded.completion_seq, updated_at=excluded.updated_at`,
        snap.id,
        snap.title,
        snap.profileId,
        JSON.stringify(snap.tags),
        snap.parentConversationId ?? null,
        snap.nodeId || 'local',
        snap.cwd,
        snap.model,
        snap.modelOverride ?? null,
        snap.thinkingLevel || '',
        snap.thinkingLevelOverride ?? null,
        snap.unread ? 1 : 0,
        snap.pinned ? 1 : 0,
        snap.stateChangeSeq,
        snap.completionSeq,
        snap.createdAt,
        snap.updatedAt,
      )
      // Separate table for parent tool-call link: upsert when set, delete when unset (prevents orphaned/stale links).
      if (snap.parentToolCallId !== undefined && snap.parentToolCallId !== '') {
        await this.db.run(
          `INSERT INTO helm_conversation_tool_links (conversation_id, parent_tool_call_id) VALUES (?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET parent_tool_call_id=excluded.parent_tool_call_id`,
          snap.id,
          snap.parentToolCallId,
        )
      } else {
        await this.db.run(
          'DELETE FROM helm_conversation_tool_links WHERE conversation_id = ?',
          snap.id,
        )
      }
      // Title changes must update the title column across every FTS row for this conversation (not just one).
      if (titleChanged) {
        await this.db.run(
          'UPDATE helm_conversation_fts SET title = ? WHERE conversation_id = ?',
          this.ftsRedact(snap.title),
          snap.id,
        )
      }
    })
  }

  /**
   * Delete conversation: tombstone + row cleanup execute atomically in **the same transaction** (prevents crash windows
   * where rows are deleted without a tombstone, causing resurrection on restart). Synchronously cleans up in-memory
   * asks/artifacts mirrors; settled Ask history is purged alongside the conversation so mirrors stay consistent.
   */
  deleteConv(id: number): void {
    this.assertWritable()
    this.convs.delete(id)
    this.tombstones.add(id)
    for (const [askId, row] of this.asks) {
      if (row.conversationId === id) this.asks.delete(askId)
    }
    for (const [artifactId, row] of this.artifacts) {
      if (row.conversationId === id) this.artifacts.delete(artifactId)
    }
    // Synchronously purge per-conversation document mirror (DB rows deleted in the same transaction below to avoid orphans).
    for (const key of [...this.pluginSessionDocs.keys()]) {
      const convId = Number(key.split('\0')[2])
      if (convId === id) this.pluginSessionDocs.delete(key)
    }
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        await tx.run(
          'INSERT OR IGNORE INTO helm_tombstones (id, deleted_at) VALUES (?, ?)',
          id,
          Date.now(),
        )
        await tx.run('DELETE FROM helm_conversations WHERE id = ?', id)
        await tx.run('DELETE FROM helm_conversation_tool_links WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_asks WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_artifacts WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_conversation_fts WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_plugin_session_docs WHERE conversation_id = ?', id)
      }),
    )
  }

  // ---------------- asks ----------------

  listAsks(status?: string): AskRow[] {
    return [...this.asks.values()]
      .filter((a) => (status ? a.status === status : true))
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getAsk(id: string): AskRow | undefined {
    const row = this.asks.get(id)
    return row ? { ...row } : undefined
  }

  /**
   * UPSERT all columns (including `spec` / `expected_state_seq` / `owner` / `created_at`):
   * settling must write back `specJson` (containing terminal `status`), otherwise `listAsks` restores stale `pending` after restart.
   */
  putAsk(row: AskRow): void {
    this.assertWritable()
    this.asks.set(row.id, { ...row })
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_asks (id, conversation_id, owner_plugin_id, spec, status, result, expected_state_seq, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id=excluded.conversation_id,
           owner_plugin_id=excluded.owner_plugin_id,
           spec=excluded.spec,
           status=excluded.status,
           result=excluded.result,
           expected_state_seq=excluded.expected_state_seq,
           created_at=excluded.created_at,
           settled_at=excluded.settled_at`,
        row.id,
        row.conversationId,
        row.ownerPluginId ?? null,
        row.specJson,
        row.status,
        row.resultJson ?? null,
        row.expectedStateSeq ?? null,
        row.createdAt,
        row.settledAt ?? null,
      ),
    )
  }

  // ---------------- artifacts ----------------

  listArtifacts(conversationId?: number): ArtifactRow[] {
    return [...this.artifacts.values()]
      .filter((a) => (conversationId === undefined ? true : a.conversationId === conversationId))
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getArtifact(id: string): ArtifactRow | undefined {
    const row = this.artifacts.get(id)
    return row ? { ...row } : undefined
  }

  putArtifact(row: ArtifactRow): void {
    this.assertWritable()
    if (!isArtifactKind(row.kind)) {
      throw new HelmError('validation_error', `Invalid artifact kind: ${String(row.kind)}`, 400, { id: row.id, kind: row.kind })
    }
    this.artifacts.set(row.id, { ...row })
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, path=excluded.path, mime_type=excluded.mime_type, size=excluded.size`,
        row.id,
        row.conversationId,
        row.kind,
        row.name,
        row.path,
        row.mimeType,
        row.size,
        row.createdAt,
      ),
    )
  }

  deleteArtifactsByConversation(conversationId: number): string[] {
    this.assertWritable()
    const removed: string[] = []
    for (const [id, row] of this.artifacts) {
      if (row.conversationId === conversationId) {
        removed.push(id)
        this.artifacts.delete(id)
      }
    }
    this.enqueue(() =>
      this.db.run('DELETE FROM helm_artifacts WHERE conversation_id = ?', conversationId),
    )
    return removed
  }

  // ---------------- plugin docs ----------------

  getPluginDoc(pluginId: string, name: string): string | undefined {
    return this.pluginDocs.get(pluginId + '\0' + name)
  }

  /** `valueJson` must be valid JSON: rejects explicitly rather than persisting unreadable data. */
  putPluginDoc(pluginId: string, name: string, valueJson: string): void {
    this.assertWritable()
    parseStoredJson<unknown>(`helm_plugin_docs#${pluginId}:${name}.value`, valueJson)
    this.pluginDocs.set(pluginId + '\0' + name, valueJson)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_plugin_docs (plugin_id, name, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        valueJson,
        Date.now(),
      ),
    )
  }

  /**
   * Delete all global documents belonging to a plugin (unload cleanup).
   *
   * Global documents live under `__global` with `name = '${pluginId}:${docName}'`. Since `pluginId` itself may
   * contain colons (e.g. `foo:bar`) while `docName` forbids colons (`assertValidId`), plain prefix matching would
   * delete across plugins (`foo` matching `foo:bar:doc`); precise matching requires `${pluginId}:` prefix AND no colon in remainder.
   */
  deleteGlobalPluginDocs(pluginId: string): void {
    this.assertWritable()
    const prefix = `${pluginId}:`
    const rowPrefix = `__global\0${prefix}`
    for (const key of [...this.pluginDocs.keys()]) {
      if (!key.startsWith(rowPrefix)) continue
      if (key.slice(rowPrefix.length).includes(':')) continue
      this.pluginDocs.delete(key)
    }
    this.enqueue(() =>
      this.db.run(
        `DELETE FROM helm_plugin_docs
         WHERE plugin_id = '__global' AND substr(name, 1, ?) = ? AND instr(substr(name, ?), ':') = 0`,
        prefix.length,
        prefix,
        prefix.length + 1,
      ),
    )
  }

  // ---------------- plugin session docs ----------------

  /** Read per-conversation document mirror (returns `undefined` if unwritten; caller falls back to initial value). */
  getPluginSessionDoc(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.pluginSessionDocs.get(`${pluginId}\0${name}\0${conversationId}`)
  }

  /** Write per-conversation document (`valueJson` must be valid JSON; rejects malformed payloads explicitly). */
  putPluginSessionDoc(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.assertWritable()
    parseStoredJson<unknown>(
      `helm_plugin_session_docs#${pluginId}:${name}#${conversationId}.value`,
      valueJson,
    )
    this.pluginSessionDocs.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_plugin_session_docs (plugin_id, name, conversation_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, name, conversation_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        conversationId,
        valueJson,
        Date.now(),
      ),
    )
  }

  deletePluginSessionDoc(pluginId: string, name: string, conversationId: number): void {
    this.assertWritable()
    this.pluginSessionDocs.delete(`${pluginId}\0${name}\0${conversationId}`)
    this.enqueue(() =>
      this.db.run(
        'DELETE FROM helm_plugin_session_docs WHERE plugin_id = ? AND name = ? AND conversation_id = ?',
        pluginId,
        name,
        conversationId,
      ),
    )
  }

  /** Delete all per-conversation documents belonging to a plugin (unload cleanup; dedicated `plugin_id` column ensures exact match). */
  deletePluginSessionDocs(pluginId: string): void {
    this.assertWritable()
    for (const key of [...this.pluginSessionDocs.keys()]) {
      if (key.startsWith(pluginId + '\0')) this.pluginSessionDocs.delete(key)
    }
    this.enqueue(() =>
      this.db.run('DELETE FROM helm_plugin_session_docs WHERE plugin_id = ?', pluginId),
    )
  }

  /** List all conversation IDs (ascending) for which a plugin document has been persisted. */
  listPluginSessionDocConversations(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of this.pluginSessionDocs.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const convId = Number(key.split('\0')[2])
      if (Number.isSafeInteger(convId) && convId > 0) out.push(convId)
    }
    return out.sort((a, b) => a - b)
  }

  // ---------------- FTS ----------------

  /**
   * Index conversation text (input/answer/tool summary); body is redacted before storing.
   * `(conversation_id, entry_id)` idempotent: repeated indexing of the same entry (e.g., observer replay)
   * deletes then inserts inside one transaction so FTS5 (which lacks unique constraints) never gets duplicate rows.
   */
  indexFts(conversationId: number, entryId: string, title: string, body: string): void {
    this.assertWritable()
    const safeTitle = this.ftsRedact(title)
    const safeBody = this.ftsRedact(body)
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        await tx.run(
          'DELETE FROM helm_conversation_fts WHERE conversation_id = ? AND entry_id = ?',
          conversationId,
          entryId,
        )
        await tx.run(
          'INSERT INTO helm_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
          conversationId,
          entryId,
          safeTitle,
          safeBody,
        )
      }),
    )
  }

  /** Full-text search index (rebuildable derived index; never touches `pi_` table semantics). */
  async search(
    query: string,
    limit = 20,
  ): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    // Wait for queued writes to drain completely (throws on errors) so queries observe persisted latest state.
    await this.flushPublic()
    const rows = await this.db.all<{
      conversation_id: number
      entry_id: string
      snippet: string
    }>(
      `SELECT conversation_id, entry_id, snippet(helm_conversation_fts, 3, '', '...', ' ', 24) AS snippet
       FROM helm_conversation_fts WHERE helm_conversation_fts MATCH ? LIMIT ?`,
      ftsMatchExpr(query),
      limit,
    )
    // Defensive deduplication: return at most one entry per `(conversation_id, entry_id)`.
    const seen = new Set<string>()
    const out: Array<{ conversationId: number; entryId: string; snippet: string }> = []
    for (const r of rows) {
      const key = `${r.conversation_id}\0${r.entry_id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ conversationId: r.conversation_id, entryId: r.entry_id, snippet: r.snippet })
    }
    return out
  }

  /**
   * Delete specific FTS entries in a conversation (cleans truncated entries' derived index on in-place overwrite).
   * Touches only `helm_conversation_fts` derived table without affecting `pi_` semantics; no-ops on empty list.
   */
  removeFtsEntries(conversationId: number, entryIds: ReadonlyArray<string>): void {
    if (entryIds.length === 0) return
    this.assertWritable()
    const ids = [...entryIds]
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        for (const entryId of ids) {
          await tx.run(
            'DELETE FROM helm_conversation_fts WHERE conversation_id = ? AND entry_id = ?',
            conversationId,
            entryId,
          )
        }
      }),
    )
  }

  /**
   * FTS is a rebuildable derived index: clearing + replaying all conversation text runs inside **the same transaction**,
   * rolling back atomically on failure (preserving the previous index rather than dropping it and faking success).
   */
  async rebuildFts(
    replay: (
      index: (conversationId: number, entryId: string, title: string, body: string) => void,
    ) => Promise<void>,
  ): Promise<void> {
    await this.flushPublic()
    const batch = new Map<string, [number, string, string, string]>()
    await replay((conversationId, entryId, title, body) => {
      batch.set(`${conversationId}\0${entryId}`, [conversationId, entryId, title, body])
    })
    await this.db.transaction(async (tx) => {
      await tx.exec('DELETE FROM helm_conversation_fts')
      for (const [conversationId, entryId, title, body] of batch.values()) {
        await tx.run(
          'INSERT INTO helm_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
          conversationId,
          entryId,
          this.ftsRedact(title),
          this.ftsRedact(body),
        )
      }
    })
  }

  // ---------------- flush ----------------

  /**
   * External flush port (used by `documentStore.flush`): awaits full drain of the tail chain (real drain,
   * zero polling, no early return); throws `HelmError` if any persistence error occurred so callers (e.g.
   * Workflow `state.flush`) can halt downstream side effects instead of falsely assuming success.
   */
  async flushPublic(): Promise<void> {
    await this.tail
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `Persistence queue contains failed writes; data integrity is not guaranteed: ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private enqueue(fn: Deferred): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore is already closed; rejecting new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `Persistence already failed; rejecting new write (refusing false success): ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
    // Serial tail chain: errors are caught and recorded inside the chain so it stays unbroken and strictly FIFO.
    this.tail = this.tail.then(fn).catch((error: unknown) => {
      const isFirst = this.firstError === undefined
      this.markFailed(error)
      if (isFirst) this.reportError(error)
    })
  }

  private reportError(error: unknown): void {
    if (this.onError !== undefined) {
      try {
        this.onError(error)
      } catch {
        /* reporting itself must not throw */
      }
      return
    }
    emitDiagnostic(this.onDiagnostic, (text) => (this.redactFn ?? this.ftsRedact)(text), {
      level: 'error',
      source: 'store',
      message: 'store persistence error',
      error,
    })
  }

  /** Pre-write check: reject explicitly when closed or failed, never pretending an enqueue succeeded. */
  private assertWritable(): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore is already closed; rejecting new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `Persistence already failed; rejecting new write (refusing false success): ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private markFailed(error: unknown): void {
    if (this.firstError === undefined) this.firstError = error
  }

  /** Await full completion of in-flight flushes before exit; returns the first persistence error (honest reporting, never swallowed). */
  async close(): Promise<unknown> {
    await this.tail
    this.closed = true
    return this.firstError
  }
}

function cloneConv(meta: ConvMeta): ConvMeta {
  return { ...meta, tags: [...meta.tags] }
}

/** Validate persisted JSON: fails explicitly on corruption (with location context) rather than falling back to empty values. */
function parseStoredJson<T>(what: string, raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new HelmError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): JSON parse failed: ${String(cause)}`,
      500,
      { what, raw: raw.slice(0, 200), cause: String(cause) },
    )
  }
}

function ftsMatchExpr(query: string): string {
  // Convert user query into an FTS5 prefix OR query, quoting each token to prevent syntax injection.
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`)
  return tokens.join(' OR ') || '""'
}

export function convStatusOf(
  meta: ConvMeta,
  sdkLive: { run?: unknown; runFailure?: unknown },
  pendingAskCount: number,
): ConversationStatus {
  // `blocked` (pending AskDoc) takes precedence over `working`: AskDoc is a human decision point,
  // so awaiting human input must remain visible in the state machine even if the model is still running.
  if (pendingAskCount > 0) return 'blocked'
  if (sdkLive.run) return 'working'
  if (sdkLive.runFailure) return 'error'
  return meta.unread ? 'done' : 'idle'
}

export function summaryOf(
  meta: ConvMeta,
  status: ConversationStatus,
  pendingAskCount: number,
  doing?: string,
  lastError?: string,
  lastEntryId?: number,
): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    parentConversationId: meta.parentConversationId,
    ...(meta.parentToolCallId !== undefined && meta.parentToolCallId !== ''
      ? { parentToolCallId: meta.parentToolCallId }
      : {}),
    nodeId: meta.nodeId || 'local',
    cwd: meta.cwd,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    ...(meta.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: meta.thinkingLevelOverride } : {}),
    status,
    doing,
    ...(lastError !== undefined && lastError !== '' ? { lastError } : {}),
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    lastEntryId: lastEntryId ?? meta.lastEntryId ?? 0,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
