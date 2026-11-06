/**
 * HelmStore：helm 自有表的同步读写镜像 + FTS5 派生索引。
 *
 * 一切 SQL 经同一 NodeSqliteDatabase adapter（与 pi_ 表共享事务队列）。
 * 内存镜像保证同步读（listConversations 等）；写路径「先镜像后排队持久化」，
 * close 时 flush 并上报失败（不静默吞错）。
 */

import type { ConversationStatus, ConversationSummary } from '@helm/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { HelmDatabase } from './sqlite.js'

export interface ConvMeta {
  id: number
  title: string
  profileId: string
  tags: string[]
  parentConversationId?: number
  cwd: string
  model: string
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

export interface WorkflowRunRow {
  id: string
  name: string
  conversationId: number
  status: 'running' | 'completed' | 'failed' | 'aborted'
  resultJson?: string
  error?: string
  nodesJson?: string
  createdAt: number
  updatedAt: number
}

type Deferred = () => Promise<void>

export class HelmStore {
  private readonly db: NodeSqliteDatabase
  private readonly convs = new Map<number, ConvMeta>()
  private readonly asks = new Map<string, AskRow>()
  private readonly artifacts = new Map<string, ArtifactRow>()
  private readonly pluginDocs = new Map<string, string>() // pluginId\0name -> json
  private readonly workflowRuns = new Map<string, WorkflowRunRow>()
  /** 逻辑删除墓碑：重启后不重新导入 SDK 保留的内部历史。 */
  private readonly tombstones = new Set<number>()
  private queue: Array<Deferred> = []
  private flushing = false
  private closed = false
  private closeError: unknown = undefined
  private eventSeq = 0
  /** FTS 入队文本的脱敏钩子（运行时注入 stash.redactText）。 */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmDatabase) {
    this.db = database.db
  }

  /** 启动时从 sqlite 装载全部镜像。 */
  async load(): Promise<void> {
    for (const row of await this.db.all<{
      id: number
      title: string
      profile_id: string
      tags: string
      parent_conversation_id: number | null
      cwd: string
      model: string
      unread: number
      pinned: number
      state_change_seq: number
      completion_seq: number
      created_at: number
      updated_at: number
    }>(
      'SELECT id, title, profile_id, tags, parent_conversation_id, cwd, model, unread, pinned, state_change_seq, completion_seq, created_at, updated_at FROM helm_conversations',
    )) {
      this.convs.set(row.id, {
        id: row.id,
        title: row.title,
        profileId: row.profile_id,
        tags: JSON.parse(row.tags) as string[],
        parentConversationId: row.parent_conversation_id ?? undefined,
        cwd: row.cwd,
        model: row.model,
        unread: row.unread === 1,
        pinned: row.pinned === 1,
        stateChangeSeq: row.state_change_seq,
        completionSeq: row.completion_seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
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
    }>('SELECT * FROM helm_asks')) {
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
      name: string
      path: string
      mime_type: string
      size: number
      created_at: number
    }>('SELECT id, conversation_id, name, path, mime_type, size, created_at FROM helm_artifacts')) {
      this.artifacts.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
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
      this.pluginDocs.set(row.plugin_id + '\0' + row.name, row.value)
    }
    for (const row of await this.db.all<{
      id: string
      name: string
      conversation_id: number
      status: string
      result: string | null
      error: string | null
      nodes: string | null
      created_at: number
      updated_at: number
    }>(
      'SELECT id, name, conversation_id, status, result, error, nodes, created_at, updated_at FROM helm_workflow_runs',
    )) {
      this.workflowRuns.set(row.id, {
        id: row.id,
        name: row.name,
        conversationId: row.conversation_id,
        status: row.status as WorkflowRunRow['status'],
        resultJson: row.result ?? undefined,
        error: row.error ?? undefined,
        nodesJson: row.nodes ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
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

  setEventSeq(seq: number): void {
    this.eventSeq = seq
    this.enqueue(() => this.db.run(
      "INSERT INTO helm_seq (key, value) VALUES ('events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      seq,
    ))
  }

  // ---------------- conversations ----------------

  listConvs(): ConvMeta[] {
    return [...this.convs.values()].sort((a, b) => b.id - a.id)
  }

  getConv(id: number): ConvMeta | undefined {
    return this.convs.get(id)
  }

  upsertConv(meta: ConvMeta): void {
    this.convs.set(meta.id, { ...meta })
    this.enqueue(async () => {
      await this.db.run(
        `INSERT INTO helm_conversations (id, title, profile_id, tags, parent_conversation_id, cwd, model, unread, pinned, state_change_seq, completion_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, profile_id=excluded.profile_id, tags=excluded.tags, parent_conversation_id=excluded.parent_conversation_id, cwd=excluded.cwd, model=excluded.model, unread=excluded.unread, pinned=excluded.pinned, state_change_seq=excluded.state_change_seq, completion_seq=excluded.completion_seq, updated_at=excluded.updated_at`,
        meta.id,
        meta.title,
        meta.profileId,
        JSON.stringify(meta.tags),
        meta.parentConversationId ?? null,
        meta.cwd,
        meta.model,
        meta.unread ? 1 : 0,
        meta.pinned ? 1 : 0,
        meta.stateChangeSeq,
        meta.completionSeq,
        meta.createdAt,
        meta.updatedAt,
      )
      await this.updateFtsTitle(meta.id, meta.title)
    })
  }

  deleteConv(id: number): void {
    this.convs.delete(id)
    this.tombstones.add(id)
    this.enqueue(async () => {
      await this.db.run('INSERT OR IGNORE INTO helm_tombstones (id, deleted_at) VALUES (?, ?)', id, Date.now())
      await this.db.run('DELETE FROM helm_conversations WHERE id = ?', id)
      await this.db.run('DELETE FROM helm_artifacts WHERE conversation_id = ?', id)
      await this.db.run('DELETE FROM helm_conversation_fts WHERE conversation_id = ?', id)
    })
  }

  // ---------------- asks ----------------

  listAsks(status?: string): AskRow[] {
    return [...this.asks.values()]
      .filter((a) => (status ? a.status === status : true))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getAsk(id: string): AskRow | undefined {
    return this.asks.get(id)
  }

  putAsk(row: AskRow): void {
    this.asks.set(row.id, { ...row })
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_asks (id, conversation_id, owner_plugin_id, spec, status, result, expected_state_seq, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, result=excluded.result, settled_at=excluded.settled_at`,
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
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getArtifact(id: string): ArtifactRow | undefined {
    return this.artifacts.get(id)
  }

  putArtifact(row: ArtifactRow): void {
    this.artifacts.set(row.id, { ...row })
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_artifacts (id, conversation_id, name, path, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, mime_type=excluded.mime_type, size=excluded.size`,
        row.id,
        row.conversationId,
        row.name,
        row.path,
        row.mimeType,
        row.size,
        row.createdAt,
      ),
    )
  }

  deleteArtifactsByConversation(conversationId: number): string[] {
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

  putPluginDoc(pluginId: string, name: string, valueJson: string): void {
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

  deletePluginDocs(pluginId: string): void {
    for (const key of [...this.pluginDocs.keys()]) {
      if (key.startsWith(pluginId + '\0')) this.pluginDocs.delete(key)
    }
    this.enqueue(() => this.db.run('DELETE FROM helm_plugin_docs WHERE plugin_id = ?', pluginId))
  }

  // ---------------- workflow runs ----------------

  getWorkflowRun(id: string): WorkflowRunRow | undefined {
    return this.workflowRuns.get(id)
  }

  upsertWorkflowRun(row: WorkflowRunRow): void {
    this.workflowRuns.set(row.id, { ...row })
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helm_workflow_runs (id, name, conversation_id, status, result, error, nodes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, result=excluded.result, error=excluded.error, nodes=excluded.nodes, updated_at=excluded.updated_at`,
        row.id,
        row.name,
        row.conversationId,
        row.status,
        row.resultJson ?? null,
        row.error ?? null,
        row.nodesJson ?? null,
        row.createdAt,
        row.updatedAt,
      ),
    )
  }

  // ---------------- FTS ----------------

  /** 索引一条会话文本（输入/回答/工具摘要）；body 脱敏后入库。 */
  indexFts(conversationId: number, entryId: string, title: string, body: string): void {
    const safeBody = this.ftsRedact(body)
    const safeTitle = this.ftsRedact(title)
    this.enqueue(() =>
      this.db.run(
        'INSERT INTO helm_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
        conversationId,
        entryId,
        safeTitle,
        safeBody,
      ),
    )
  }

  private async updateFtsTitle(conversationId: number, title: string): Promise<void> {
    await this.db.run(
      "UPDATE helm_conversation_fts SET title = ? WHERE conversation_id = ? AND rowid = (SELECT rowid FROM helm_conversation_fts WHERE conversation_id = ? ORDER BY rowid LIMIT 1)",
      this.ftsRedact(title),
      conversationId,
      conversationId,
    )
  }

  /** FTS 全文检索（可重建派生索引，不触碰 pi_ 表语义）。 */
  async search(query: string, limit = 20): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    const rows = await this.db.all<{
      conversation_id: number
      entry_id: string
      snippet: string
    }>(
      `SELECT conversation_id, entry_id, snippet(helm_conversation_fts, 3, '', '…', ' ', 24) AS snippet
       FROM helm_conversation_fts WHERE helm_conversation_fts MATCH ? LIMIT ?`,
      ftsMatchExpr(query),
      limit,
    )
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      entryId: r.entry_id,
      snippet: r.snippet,
    }))
  }

  /** FTS 是可重建的派生索引：清空后由调用方重放全部会话文本。 */
  async rebuildFts(
    replay: (index: (conversationId: number, entryId: string, title: string, body: string) => void) => Promise<void>,
  ): Promise<void> {
    await this.flush()
    await this.db.exec('DELETE FROM helm_conversation_fts')
    const batch: Array<[number, string, string, string]> = []
    await replay((conversationId, entryId, title, body) => {
      batch.push([conversationId, entryId, title, body])
    })
    for (const [conversationId, entryId, title, body] of batch) {
      await this.db.run(
        'INSERT INTO helm_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
        conversationId,
        entryId,
        this.ftsRedact(title),
        this.ftsRedact(body),
      )
    }
  }

  // ---------------- flush ----------------

  /** 对外冲刷端口（documentStore.flush 用；等待队列清空）。 */
  async flushPublic(): Promise<void> {
    while (this.flushing || this.queue.length > 0) {
      if (this.flushing) {
        await new Promise<void>((r) => setTimeout(r, 0))
        continue
      }
      await this.flush()
    }
  }

  private enqueue(fn: Deferred): void {
    if (this.closed) throw new Error('helm_store_closed')
    this.queue.push(fn)
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue
        this.queue = []
        for (const fn of batch) {
          try {
            await fn()
          } catch (error) {
            this.closeError = error
            // 持久化失败不静默：记录并继续冲刷其余项，close() 时显式上报。
            reportStoreError(error)
          }
        }
      }
    } finally {
      this.flushing = false
    }
  }

  /** 退出前 flush；返回首个持久化错误（诚实上报，不吞）。 */
  async close(): Promise<unknown> {
    await this.flush()
    this.closed = true
    return this.closeError
  }
}

let errorReporter: (error: unknown) => void = (error) => {
  console.error('[helm] store persistence error:', error)
}

export function setStoreErrorReporter(fn: (error: unknown) => void): void {
  errorReporter = fn
}

function reportStoreError(error: unknown): void {
  try {
    errorReporter(error)
  } catch {
    /* 上报自身不得再抛 */
  }
}

function ftsMatchExpr(query: string): string {
  // 用户输入转成 FTS5 前缀 OR 查询，避免语法注入（引号包裹每个 token）。
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`)
  return tokens.join(' OR ') || '""'
}

export function convStatusOf(meta: ConvMeta, sdkLive: { run?: unknown; runFailure?: unknown }, pendingAskCount: number): ConversationStatus {
  if (sdkLive.run) return 'working'
  if (pendingAskCount > 0) return 'blocked'
  if (sdkLive.runFailure) return 'error'
  return meta.unread ? 'done' : 'idle'
}

export function summaryOf(meta: ConvMeta, status: ConversationStatus, pendingAskCount: number, doing?: string): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    parentConversationId: meta.parentConversationId,
    cwd: meta.cwd,
    model: meta.model,
    status,
    doing,
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
