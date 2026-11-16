/**
 * HelmStore:helm self has table sync read write mirror + FTS5 derive index.
 *
 * everything SQL via the same NodeSqliteDatabase adapter(and pi_ table sharing transaction queue), never another open connect.
 * memory mirror guarantee sync read (listConvs etc.); write path first mirror after queue up persist, queue up via
 * promise tail chain strictly serial (FIFO, without polling). persist error honest contract:
 * - first error by record and on report (not silently swallow wrong, never virtual call persist succeeded);
 * - flushPublic in has any not decide error when explicit throw HelmError(caller can based on this block assert side effect);
 * - fails after new write one rule reject (fail state, no longer false succeeded);
 * - close wait for in-flight flush completely end, and first error return to caller on report.
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
  /** derive or most near once resume this sub-conversation parent conversation tool invoke ID(run phase real-time related). */
  parentToolCallId?: string
  /** bind set compute node ID(default 'local'). */
  nodeId: string
  cwd: string
  /** takes effect model mirror (parse chain result; without config when is empty string, only render use). */
  model: string
  /** explicit model override ('provider/model');undefined = inherit profile/global. */
  modelOverride?: string
  /** think Profile mirror (off/minimal/low/medium/high/xhigh/max; empty string not settings). */
  thinkingLevel: string
  /** explicit think Profile override;undefined = inherit Profile/global. */
  thinkingLevelOverride?: string
  unread: boolean
  pinned: boolean
  stateChangeSeq: number
  completionSeq: number
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
  /** instance level persist failed call back (such as KernelRuntime mount lead to life store fault closed ring); default away diagnose channel. */
  readonly onError?: (error: unknown) => void
  /** diagnose channel sink(not provide onError when fall back output; default away console.error). */
  readonly onDiagnostic?: KernelDiagnosticSink
  /** diagnose redaction function (default re- use ftsRedact). */
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
  /** conversation document mirror:pluginId\0name\0conversationId -> json. */
  private readonly pluginSessionDocs = new Map<string, string>()
  /** logic delete tombstone: after restart do not re- import SDK keep internal history. */
  private readonly tombstones = new Set<number>()
  /**
   * persist tail chain: all queue up write strictly by queue order serial execute.
   * chain forever do not fails (error in chain inside catch and record),flushPublic/close only needs to await it.
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  /** first persist error; once placement i.e. enter fail state, reject after continue new write. */
  private firstError: unknown = undefined
  private eventSeq = 0
  /** FTS queue text redaction hook (runtime inject stash.redactText). */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmDatabase, options: HelmStoreOptions = {}) {
    this.db = database.db
    this.onError = options.onError
    this.onDiagnostic = options.onDiagnostic
    this.redactFn = options.redact
  }

  /** first persist failed error (only read; not fails is undefined). */
  get error(): unknown {
    return this.firstError
  }

  /** at startup from sqlite load all mirror; durable JSON corrupt when explicit errors (never false null value). */
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
    // parent tool invoke related independent into table (helm_conversation_tool_links): second read merge enter
    // mirror, existing helm_conversations row no need to any change.
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
          `persist data corrupt (helm_artifacts#${row.id}.kind): illegal artifact type ${String(row.kind)}`,
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
   * persist event ordinal: only accept non- negative security integer, and single tune does not fall back (old value does not override more high watermark).
   * queue up via FIFO tail chain, written to the database order and queue order consistent, will not because old queue write fall back ordinal.
   */
  setEventSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HelmError('invalid_event_seq', `event ordinal must be non- negative security integer, receives:${seq}`, 500, {
        seq,
      })
    }
    if (seq < this.eventSeq) return // reject fall back: keep more high watermark
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

  upsertConv(meta: ConvMeta): void {
    this.assertWritable()
    const prev = this.convs.get(meta.id)
    const titleChanged = prev?.title !== meta.title
    // snapshot deep copy: queue up SQL bind set snapshot value, caller after continue original ground sudden change does not affect already queue write.
    const snap = cloneConv(meta)
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
      // parent tool invoke related independent table: has value upsert, null value delete (do not orphan child/stale link).
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
      // title change must update the conversation all FTS row title column (do not only one row).
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
   * delete conversation:tombstone + row clean up in**the same transaction**inside atomic written to the database (crash will not appear
   * row already delete while tombstone missing half state leads to restart re-). memory side sync clean asks/artifacts
   * mirror; terminal state Ask history follow conversation one and clean up (mirror and store stay consistent, never leftover pending).
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
    // conversation document mirror sync clean up (store row in the same transaction inside delete, do not orphan child data).
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
   * UPSERT all amount column (contains spec / expected_state_seq / owner / created_at):
   * compute write back specJson(inside contains terminal state status) must written to the database, otherwise after restart
   * spec still is pending,listAsks restore fails.
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
      throw new HelmError('validation_error', `artifact type illegal: ${String(row.kind)}`, 400, { id: row.id, kind: row.kind })
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

  /** valueJson must be legal JSON: explicit reject (never static default a read do not back come data). */
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
   * delete global document store in a certain plugin all document (unload related clean up).
   *
   * global document unify hang in `__global` row under,name is `${pluginId}:${docName}`.
   * plugin id itself allows contains smoke number (such as `foo:bar`), pure prefix match will cross mistakenly delete
   * (delete `foo` will mistakenly in `foo:bar:doc`), while doc name forbid smoke number (assertValidId),
   * reason precise decide is: prefix `${pluginId}:` hit and remaining part excludes smoke number.
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

  /** conversation document mirror read (not write return undefined; caller fall back initial value). */
  getPluginSessionDoc(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.pluginSessionDocs.get(`${pluginId}\0${name}\0${conversationId}`)
  }

  /** write conversation document (valueJson must be legal JSON: explicit reject illegal data). */
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

  /** delete a certain plugin all conversation document (unload related clean up; table has independent plugin_id column, precise delete). */
  deletePluginSessionDocs(pluginId: string): void {
    this.assertWritable()
    for (const key of [...this.pluginSessionDocs.keys()]) {
      if (key.startsWith(pluginId + '\0')) this.pluginSessionDocs.delete(key)
    }
    this.enqueue(() =>
      this.db.run('DELETE FROM helm_plugin_session_docs WHERE plugin_id = ?', pluginId),
    )
  }

  /** column out a certain plugin a certain document persisted all conversation ID(rise order). */
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
   * index a conversation text (input/answer/tool summary);body redaction after store.
   * (conversation_id, entry_id) idempotent: the same entry duplicate index (observer replay etc.)
   * in the same transaction inside first delete after insert replace, never produce duplicate row (FTS5 without unique constraint).
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

  /** FTS all text inspect index (can rebuild derive index, do not trigger touch pi_ table semantics). */
  async search(
    query: string,
    limit = 20,
  ): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    // first wait for queue real arrange empty (contains error i.e. throw): read to is promise persist most new data.
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
    // guard against defend dedupe: the same (conversation_id, entry_id) only return a.
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
   * delete designate conversation in if dry FTS key (original ground override heavy when clean up by truncate purpose derive index).
   * only motion helm_conversation_fts derive table, do not trigger touch pi_ table semantics; empty list directly return.
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
   * FTS is can rebuild derive index: empty + replay all conversation text in**the same transaction**inside complete,
   * failed whole rollback (old index keep, never because rebuild failed lose derive index after false succeeded).
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
   * for outside conflict refresh port (documentStore.flush use): wait for tail chain completely arrange empty (real drain,
   * without polling, do not early return); store in any persist error when throw HelmError- -
   * caller (such as Workflow state.flush) based on this block assert after continue side effect, never virtual call succeeded.
   */
  async flushPublic(): Promise<void> {
    await this.tail
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `persist queue store in failed write, do not guarantee data complete:${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private enqueue(fn: Deferred): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore already close, reject new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `persist already failed, reject new write (do not false succeeded):${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
    // tail chain serial: chain inside error by catch record (chain do not die), order and queue strictly consistent.
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
        /* on report itself must not again throw */
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

  /** write before check:closed / fail state under explicit reject, never pretend queue succeeded. */
  private assertWritable(): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore already close, reject new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `persist already failed, reject new write (do not false succeeded):${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private markFailed(error: unknown): void {
    if (this.firstError === undefined) this.firstError = error
  }

  /** exit before wait for in-flight flush completely end; return first persist error (honest on report, do not swallow). */
  async close(): Promise<unknown> {
    await this.tail
    this.closed = true
    return this.firstError
  }
}

function cloneConv(meta: ConvMeta): ConvMeta {
  return { ...meta, tags: [...meta.tags] }
}

/** durable JSON validate: corrupt i.e. explicit error (carries location context), never false null value continue. */
function parseStoredJson<T>(what: string, raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new HelmError(
      'store_data_corrupted',
      `persist data corrupt (${what}):JSON failed to parse:${String(cause)}`,
      500,
      { what, raw: raw.slice(0, 200), cause: String(cause) },
    )
  }
}

function ftsMatchExpr(query: string): string {
  // user input rotate into FTS5 prefix OR query, avoid language method inject (quotes package wrap each token).
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
  // blocked(has await answer AskDoc) takes precedence at working:AskDoc is person class decide policy point,
  // even if model still in run also must wait for person class expose to state machine on.
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
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
