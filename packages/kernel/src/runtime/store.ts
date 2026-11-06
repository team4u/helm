/**
 * HelmStore：helm 自有表的同步读写镜像 + FTS5 派生索引。
 *
 * 一切 SQL 经同一 NodeSqliteDatabase adapter（与 pi_ 表共享事务队列），绝不另开连接。
 * 内存镜像保证同步读（listConvs 等）；写路径「先镜像后排队持久化」，排队经
 * promise 尾链严格串行（FIFO，无轮询）。持久化错误的诚实性契约：
 * - 首个错误被记录并上报（不静默吞错，绝不虚称持久化成功）；
 * - flushPublic 在有任何未决错误时显式抛 HelmError（调用方可据此阻断副作用）；
 * - 出错后新写一律拒绝（fail 状态，不再假成功）；
 * - close 等待在途 flush 彻底结束，并把首个错误返回给调用方上报。
 */

import type { ConversationStatus, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { HelmDatabase } from './sqlite.js'

export interface ConvMeta {
  id: number
  title: string
  profileId: string
  tags: string[]
  parentConversationId?: number
  cwd: string
  /** 生效模型镜像（解析链结果；无配置时为空串，仅展示用）。 */
  model: string
  /** 显式模型覆盖（'provider/model'）；undefined = 继承 profile/全局。 */
  modelOverride?: string
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
  /**
   * 持久化尾链：所有排队写严格按入队顺序串行执行。
   * 链永不出错（错误在链内捕获并记录），flushPublic/close 只需 await 它。
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  /** 首个持久化错误；一旦置位即进入 fail 状态，拒绝后续新写。 */
  private firstError: unknown = undefined
  private eventSeq = 0
  /** FTS 入队文本的脱敏钩子（运行时注入 stash.redactText）。 */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmDatabase) {
    this.db = database.db
  }

  /** 启动时从 sqlite 装载全部镜像；持久 JSON 损坏时显式报错（绝不假空值）。 */
  async load(): Promise<void> {
    for (const row of await this.db.all<{
      id: number
      title: string
      profile_id: string
      tags: string
      parent_conversation_id: number | null
      cwd: string
      model: string
      model_override: string | null
      unread: number
      pinned: number
      state_change_seq: number
      completion_seq: number
      created_at: number
      updated_at: number
    }>(
      'SELECT id, title, profile_id, tags, parent_conversation_id, cwd, model, model_override, unread, pinned, state_change_seq, completion_seq, created_at, updated_at FROM helm_conversations',
    )) {
      this.convs.set(row.id, {
        id: row.id,
        title: row.title,
        profileId: row.profile_id,
        tags: parseStoredJson<string[]>(`helm_conversations#${row.id}.tags`, row.tags),
        parentConversationId: row.parent_conversation_id ?? undefined,
        cwd: row.cwd,
        model: row.model,
        modelOverride: row.model_override ?? undefined,
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
      parseStoredJson<unknown>(`helm_plugin_docs#${row.plugin_id}:${row.name}.value`, row.value)
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
      if (row.result !== null) parseStoredJson<unknown>(`helm_workflow_runs#${row.id}.result`, row.result)
      if (row.nodes !== null) parseStoredJson<unknown>(`helm_workflow_runs#${row.id}.nodes`, row.nodes)
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

  /**
   * 持久化事件序号：只接受非负安全整数，且单调不回退（旧值不覆盖更高水位）。
   * 排队经 FIFO 尾链，落库顺序与入队顺序一致，不会因旧队列写回退序号。
   */
  setEventSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HelmError('invalid_event_seq', `事件序号必须是非负安全整数，收到：${seq}`, 500, {
        seq,
      })
    }
    if (seq < this.eventSeq) return // 拒绝回退：保留更高水位
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
    // 快照深拷贝：排队 SQL 绑定快照值，调用方后续原地突变不影响已入队写。
    const snap = cloneConv(meta)
    this.convs.set(snap.id, snap)
    this.enqueue(async () => {
      await this.db.run(
        `INSERT INTO helm_conversations (id, title, profile_id, tags, parent_conversation_id, cwd, model, model_override, unread, pinned, state_change_seq, completion_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, profile_id=excluded.profile_id, tags=excluded.tags, parent_conversation_id=excluded.parent_conversation_id, cwd=excluded.cwd, model=excluded.model, model_override=excluded.model_override, unread=excluded.unread, pinned=excluded.pinned, state_change_seq=excluded.state_change_seq, completion_seq=excluded.completion_seq, updated_at=excluded.updated_at`,
        snap.id,
        snap.title,
        snap.profileId,
        JSON.stringify(snap.tags),
        snap.parentConversationId ?? null,
        snap.cwd,
        snap.model,
        snap.modelOverride ?? null,
        snap.unread ? 1 : 0,
        snap.pinned ? 1 : 0,
        snap.stateChangeSeq,
        snap.completionSeq,
        snap.createdAt,
        snap.updatedAt,
      )
      // 标题变更需更新该会话全部 FTS 行的 title 列（不只第一行）。
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
   * 删除会话：tombstone + 行清理在**同一事务**内原子落库（崩溃不会出现
   * 「行已删而墓碑缺失」的半态导致重启复活）。内存侧同步清 asks/artifacts
   * 镜像；终态 Ask 历史随会话一并清理（镜像与库保持一致，绝不残留 pending）。
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
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        await tx.run(
          'INSERT OR IGNORE INTO helm_tombstones (id, deleted_at) VALUES (?, ?)',
          id,
          Date.now(),
        )
        await tx.run('DELETE FROM helm_conversations WHERE id = ?', id)
        await tx.run('DELETE FROM helm_asks WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_artifacts WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helm_conversation_fts WHERE conversation_id = ?', id)
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
   * UPSERT 全量列（含 spec / expected_state_seq / owner / created_at）：
   * 结算写回的 specJson（内含终态 status）必须落库，否则重启后
   * spec 仍是 pending、listAsks 恢复出错。
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

  /** valueJson 必须是合法 JSON：显式拒绝（绝不静默落一份读不回来的数据）。 */
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

  deletePluginDocs(pluginId: string): void {
    this.assertWritable()
    for (const key of [...this.pluginDocs.keys()]) {
      if (key.startsWith(pluginId + '\0')) this.pluginDocs.delete(key)
    }
    this.enqueue(() => this.db.run('DELETE FROM helm_plugin_docs WHERE plugin_id = ?', pluginId))
  }

  // ---------------- workflow runs ----------------

  getWorkflowRun(id: string): WorkflowRunRow | undefined {
    const row = this.workflowRuns.get(id)
    return row ? { ...row } : undefined
  }

  upsertWorkflowRun(row: WorkflowRunRow): void {
    this.assertWritable()
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

  /**
   * 索引一条会话文本（输入/回答/工具摘要）；body 脱敏后入库。
   * (conversation_id, entry_id) 幂等：同一 entry 重复索引（observer 重放等）
   * 在同一事务内先删后插替换，绝不产生重复行（FTS5 无 unique 约束）。
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

  /** FTS 全文检索（可重建派生索引，不触碰 pi_ 表语义）。 */
  async search(
    query: string,
    limit = 20,
  ): Promise<Array<{ conversationId: number; entryId: string; snippet: string }>> {
    // 先等待队列真实排空（含错误即抛）：读到的是承诺持久化的最新数据。
    await this.flushPublic()
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
    // 防御性去重：同一 (conversation_id, entry_id) 只返回一条。
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
   * FTS 是可重建的派生索引：清空 + 重放全部会话文本在**同一事务**内完成，
   * 失败整体回滚（旧索引保留，绝不因重建失败丢掉派生索引后假成功）。
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
   * 对外冲刷端口（documentStore.flush 用）：等待尾链彻底排空（真实 drain，
   * 无轮询、不早返回）；存在任何持久化错误时抛 HelmError——
   * 调用方（如 Workflow state.flush）据此阻断后续副作用，绝不虚称成功。
   */
  async flushPublic(): Promise<void> {
    await this.tail
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `持久化队列存在失败写，不保证数据完整：${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private enqueue(fn: Deferred): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore 已关闭，拒绝新写', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `持久化已失败，拒绝新写（不假成功）：${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
    // 尾链串行：链内错误被捕获记录（链不死），顺序与入队严格一致。
    this.tail = this.tail.then(fn).catch((error: unknown) => {
      this.markFailed(error)
      reportStoreError(error)
    })
  }

  /** 写前检查：closed / fail 状态下显式拒绝，绝不假装入队成功。 */
  private assertWritable(): void {
    if (this.closed) throw new HelmError('store_closed', 'HelmStore 已关闭，拒绝新写', 409)
    if (this.firstError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `持久化已失败，拒绝新写（不假成功）：${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private markFailed(error: unknown): void {
    if (this.firstError === undefined) this.firstError = error
  }

  /** 退出前等待在途 flush 彻底结束；返回首个持久化错误（诚实上报，不吞）。 */
  async close(): Promise<unknown> {
    await this.tail
    this.closed = true
    return this.firstError
  }
}

function cloneConv(meta: ConvMeta): ConvMeta {
  return { ...meta, tags: [...meta.tags] }
}

/** 持久 JSON 校验：损坏即显式错误（带位置上下文），绝不假空值继续。 */
function parseStoredJson<T>(what: string, raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new HelmError(
      'store_data_corrupted',
      `持久化数据损坏（${what}）：JSON 解析失败：${String(cause)}`,
      500,
      { what, raw: raw.slice(0, 200), cause: String(cause) },
    )
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

export function convStatusOf(
  meta: ConvMeta,
  sdkLive: { run?: unknown; runFailure?: unknown },
  pendingAskCount: number,
): ConversationStatus {
  // blocked（有待答 AskDoc）优先于 working：AskDoc 是人类决策点，
  // 即使模型仍在跑也必须把「等待人类」暴露到状态机上。
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
): ConversationSummary {
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
