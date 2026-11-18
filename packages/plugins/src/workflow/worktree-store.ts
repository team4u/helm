/**
 * 受管 Worktree 统一持久层（登记记录 + durable 租约 + agentId 绑定 + 占用判定）：
 * - `runtime/worktrees`：受管 worktree 版本化记录（损坏显式 `worktree_doc_corrupted`）；
 * - `worktree-leases`：fail-closed 执行租约（`beforeCreate` 副作用前落盘占位；仅确认成功或
 *   `neverStarted` 释放，崩溃/未知状态显式 `worktree_execution_unknown` 拒绝清理）；
 * - `worktree-agent-bindings`：`agentId -> { childId, parentConversationId }` 续接映射；
 * - 统一选择器解析（`resolveRecord` 合并 inspect/cleanup）、占用判定（无循环引用）与
 *   会话删除裁剪（`pruneConversation`：仅清理绑定与 `removed` 记录，绝不删 `active` 记录或租约）。
 */

import {
  HelmError,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
} from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import {
  extractWorkflowExecutionMeta,
  type ManagedWorktreeHold,
  type ManagedWorktreeRecord,
} from '../contracts.js'

export type { ManagedWorktreeHold, ManagedWorktreeRecord }

const WORKTREES_DOC_KEY = 'runtime/worktrees'
const LEASES_DOC_KEY = 'worktree-leases'
const AGENT_BINDINGS_DOC_KEY = 'worktree-agent-bindings'

/** 持久化文档形状（版本化，损坏显式拒绝）。 */
interface WorktreeDoc {
  version: 1
  records: ManagedWorktreeRecord[]
}

const ALLOWED_HOLD_KEYS = new Set(['pluginId', 'holdId', 'label', 'acquiredAt'])

function isNonEmptyNonWhitespaceString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function assertPersistedHoldValid(raw: unknown, recordId: unknown): asserts raw is ManagedWorktreeHold {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmError(
      'worktree_doc_corrupted',
      `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（记录 ${String(recordId)} 的 hold 非对象）`,
      500,
    )
  }
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_HOLD_KEYS.has(key)) {
      throw new HelmError(
        'worktree_doc_corrupted',
        `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（记录 ${String(recordId)} 的 hold 含未知字段 '${key}'）`,
        500,
      )
    }
  }
  if (
    !isNonEmptyNonWhitespaceString(obj['pluginId']) ||
    !isNonEmptyNonWhitespaceString(obj['holdId']) ||
    !isNonEmptyNonWhitespaceString(obj['label']) ||
    typeof obj['acquiredAt'] !== 'number' ||
    !Number.isFinite(obj['acquiredAt']) ||
    obj['acquiredAt'] < 0
  ) {
    throw new HelmError(
      'worktree_doc_corrupted',
      `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（记录 ${String(recordId)} 的 hold 字段非法）`,
      500,
    )
  }
}

/**
 * 持久租约记录（`worktree-leases` doc）。
 * `phase`：`'pending'`（副作用前占位）| `'running'`（`onResolved` 已回填）。
 */
export interface WorktreeLeaseRecord {
  phase: 'pending' | 'running'
  info: AgentExecutionInfo
  worktreeId: string
  nodeId?: string
  path?: string
  neverStarted?: boolean
  createdAt: number
}

/** `agentId` 续接绑定记录（同时记录父子会话以便任一方删除时精准裁剪）。 */
interface WorktreeAgentBinding {
  childId: number
  parentConversationId: number
}

/** 记录选择器（worktreeId / conversationId / path[+nodeId]）。 */
export interface WorktreeRecordSelector {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
}

type WorktreeResolveMode = 'inspect' | 'cleanup'

interface WorktreeStoreHostPorts {
  getConversation(id: number): { status: string }
  listActiveSpawnExecutions(): AgentExecutionInfo[]
}

interface WorktreeStoreDeps {
  docStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush?: () => Promise<void>
  }
  redact: (text: string) => string
  host?: WorktreeStoreHostPorts
}

/** 校验 inspect / cleanup 共享的选择器互斥规则。 */
export function validateWorktreeSelector(input: WorktreeRecordSelector, mode: WorktreeResolveMode): void {
  if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
    throw new HelmError('validation_error', `${mode} 需提供 worktreeId、conversationId 或 path 之一`, 400)
  }
  if (input.worktreeId !== undefined && (input.conversationId !== undefined || input.path !== undefined)) {
    throw new HelmError('validation_error', 'worktreeId 与 conversationId/path 互斥（worktreeId 单独使用）', 400)
  }
  if (input.nodeId !== undefined && input.path === undefined) {
    throw new HelmError('validation_error', 'nodeId 仅可与 path 搭配使用（跨节点同名路径消歧）', 400)
  }
  if (input.conversationId !== undefined && input.path !== undefined) {
    throw new HelmError('validation_error', 'conversationId 与 path 择一提供', 400)
  }
}

export class WorktreeStore {
  private readonly docStore: WorktreeStoreDeps['docStore']
  private readonly redact: (text: string) => string
  private readonly host: WorktreeStoreHostPorts | undefined

  constructor(deps: WorktreeStoreDeps) {
    this.docStore = deps.docStore
    this.redact = deps.redact
    this.host = deps.host
  }

  private async flush(): Promise<void> {
    if (this.docStore.flush !== undefined) await this.docStore.flush()
  }

  // ------------------------------------------------------------------
  // 受管 Worktree 登记（runtime/worktrees）
  // ------------------------------------------------------------------

  private loadDoc(): WorktreeDoc {
    const doc = this.docStore.get<WorktreeDoc>(WORKTREES_DOC_KEY, { version: 1, records: [] })
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) {
      throw new HelmError('worktree_doc_corrupted', `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（records 非数组）`, 500)
    }
    for (const record of doc.records) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new HelmError('worktree_doc_corrupted', `受管 worktree 文档 '${WORKTREES_DOC_KEY}' 损坏（record 非对象）`, 500)
      }
      if ((record as { hold?: unknown }).hold !== undefined) {
        assertPersistedHoldValid((record as { hold: unknown }).hold, (record as { id?: unknown }).id)
      }
    }
    return doc
  }

  private saveDoc(doc: WorktreeDoc): void {
    this.docStore.set(WORKTREES_DOC_KEY, doc)
  }

  records(): ManagedWorktreeRecord[] {
    return this.loadDoc().records
  }

  append(record: ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    doc.records.push(record)
    this.saveDoc(doc)
  }

  findById(id: string): ManagedWorktreeRecord | undefined {
    return this.loadDoc().records.find((r) => r.id === id)
  }

  updateRecord(id: string, mutate: (record: ManagedWorktreeRecord) => ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) {
      throw new HelmError('not_found', `受管 worktree 记录 ${id} 不存在（文档状态不一致）`, 404, { id })
    }
    doc.records[index] = mutate(doc.records[index]!)
    this.saveDoc(doc)
  }

  /**
   * 持久化元数据机密检查：docStore 原始 JSON 落库不自动脱敏，字段含已登记机密即显式拒绝
   *（诊断仅用脱敏值 + 非机密定位字段，绝不 raw 落库）。
   */
  assertMetadataSecretFree(
    fields: Record<string, string>,
    identity: Record<string, string | number | undefined>,
  ): void {
    const offenders: string[] = []
    for (const [name, value] of Object.entries(fields)) {
      if (value === '') continue
      const redacted = this.redact(value)
      if (redacted !== value) offenders.push(`${name}=${redacted}`)
    }
    if (offenders.length > 0) {
      const identityEntries = Object.entries(identity).filter(([, v]) => v !== undefined && v !== '')
      const identityText = identityEntries.map(([k, v]) => `${k}: ${String(v)}`).join('，')
      throw new HelmError(
        'worktree_metadata_secret',
        `受管 worktree 元数据疑似包含已登记机密，拒绝登记与原始落库（脱敏值：${offenders.join('；')}）${identityText !== '' ? `【定位：${identityText}】` : ''}；请调整路径/分支命名或先轮换机密`,
        400,
        {
          ...Object.fromEntries(identityEntries),
          redactedFields: offenders,
        },
      )
    }
  }

  /**
   * 边界校验并构造可安全持久化的 ManagedWorktreeHold：
   * - pluginId / holdId / label 必须为非空非空白字符串，acquiredAt（若传）必须为非负有限数；
   * - label 落库前经宿主 redact 脱敏；
   * - pluginId / holdId 属于匹配身份键，不得含已登记机密（经 assertMetadataSecretFree 拦截）。
   */
  prepareHold(
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ): ManagedWorktreeHold {
    if (hold === null || typeof hold !== 'object' || Array.isArray(hold)) {
      throw new HelmError('validation_error', 'hold 必须为对象', 400)
    }
    const raw = hold as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_HOLD_KEYS.has(key)) {
        throw new HelmError('validation_error', `hold 含未知字段 '${key}'`, 400, { key })
      }
    }
    if (!isNonEmptyNonWhitespaceString(raw['pluginId'])) {
      throw new HelmError('validation_error', 'hold.pluginId 必须为非空字符串', 400)
    }
    if (!isNonEmptyNonWhitespaceString(raw['holdId'])) {
      throw new HelmError('validation_error', 'hold.holdId 必须为非空字符串', 400)
    }
    if (!isNonEmptyNonWhitespaceString(raw['label'])) {
      throw new HelmError('validation_error', 'hold.label 必须为非空字符串', 400)
    }
    const acquiredAt = raw['acquiredAt'] ?? Date.now()
    if (typeof acquiredAt !== 'number' || !Number.isFinite(acquiredAt) || acquiredAt < 0) {
      throw new HelmError('validation_error', 'hold.acquiredAt 必须为非负有限数值', 400)
    }
    const safeLabel = this.redact(raw['label'].trim())
    if (!isNonEmptyNonWhitespaceString(safeLabel)) {
      throw new HelmError('validation_error', 'hold.label 脱敏后为空，拒绝登记', 400)
    }
    this.assertMetadataSecretFree(
      { holdPluginId: raw['pluginId'], holdId: raw['holdId'], holdLabel: safeLabel },
      identity,
    )
    return {
      pluginId: raw['pluginId'],
      holdId: raw['holdId'],
      label: safeLabel,
      acquiredAt,
    }
  }

  /** 对已登记的活跃 worktree 持久化写入 hold（label 经脱敏与机密复核）。 */
  setHold(
    id: string,
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ): ManagedWorktreeRecord {
    if (!isNonEmptyNonWhitespaceString(id)) {
      throw new HelmError('validation_error', 'worktreeId 必须为非空字符串', 400)
    }
    const normalized = this.prepareHold(hold, { worktreeId: id, ...identity })
    let updated: ManagedWorktreeRecord | undefined
    this.updateRecord(id, (record) => {
      if (record.status === 'removed') {
        throw new HelmError(
          'worktree_missing',
          `受管 worktree '${record.path}' 已被清理，无法挂载持久持有锁`,
          409,
          { worktreeId: id, path: record.path },
        )
      }
      updated = { ...record, hold: normalized }
      return updated
    })
    return updated!
  }

  /**
   * 释放受管 worktree 的持久持有锁：
   * - 记录不存在或当前无 hold：幂等返回 false；
   * - pluginId 或 holdId 与现有 hold 不一致：显式抛 409 worktree_hold_mismatch；
   * - 完全匹配：清除 hold 并写回 docStore，返回 true。
   */
  releaseHold(id: string, pluginId: string, holdId: string): boolean {
    if (!isNonEmptyNonWhitespaceString(id)) {
      throw new HelmError('validation_error', 'worktreeId 必须为非空字符串', 400)
    }
    if (!isNonEmptyNonWhitespaceString(pluginId)) {
      throw new HelmError('validation_error', 'pluginId 必须为非空字符串', 400)
    }
    if (!isNonEmptyNonWhitespaceString(holdId)) {
      throw new HelmError('validation_error', 'holdId 必须为非空字符串', 400)
    }
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) return false
    const record = doc.records[index]!
    if (record.hold === undefined) return false
    if (record.hold.pluginId !== pluginId || record.hold.holdId !== holdId) {
      throw new HelmError(
        'worktree_hold_mismatch',
        `受管 worktree '${record.path}' 当前持有锁归属不匹配（持有方 ${record.hold.pluginId}:${record.hold.holdId}，请求释放方 ${pluginId}:${holdId}）`,
        409,
        {
          worktreeId: record.id,
          path: record.path,
          expectedPluginId: pluginId,
          expectedHoldId: holdId,
          actualPluginId: record.hold.pluginId,
          actualHoldId: record.hold.holdId,
          label: this.redact(record.hold.label),
        },
      )
    }
    const { hold: _cleared, ...clean } = record
    doc.records[index] = clean
    this.saveDoc(doc)
    return true
  }

  /** 查询会话当前绑定的受管 worktree（最新优先；无绑定返回 undefined）。 */
  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.conversationId === conversationId)
    if (records.length === 0) return undefined
    const active = records.filter((r) => r.status === 'active')
    const pool = active.length > 0 ? active : records
    return pool.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
  }

  list(): ManagedWorktreeRecord[] {
    return [...this.loadDoc().records].sort((a, b) => b.createdAt - a.createdAt)
  }

  findActive(query: WorktreeRecordSelector): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.status === 'active')
    if (query.worktreeId !== undefined) return records.find((r) => r.id === query.worktreeId)
    if (query.conversationId !== undefined) {
      const byConversation = records.filter((r) => r.conversationId === query.conversationId)
      return byConversation.length === 0
        ? undefined
        : byConversation.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    }
    if (query.path !== undefined) {
      const byPath = records.filter(
        (r) => r.path === query.path && (query.nodeId === undefined || r.nodeId === query.nodeId),
      )
      const nodeIds = new Set(byPath.map((r) => r.nodeId))
      if (nodeIds.size > 1) {
        throw new HelmError(
          'validation_error',
          `路径 ${query.path} 在多个节点存在 active 登记（${[...nodeIds].join(', ')}），查询需指定 nodeId 消歧`,
          400,
          { path: query.path, nodeIds: [...nodeIds] },
        )
      }
      return byPath.length === 0 ? undefined : byPath.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    }
    return undefined
  }

  /**
   * 统一解析 inspect / cleanup 目标记录（含互斥校验、跨节点同名路径消歧与幂等回退）：
   * - `inspect`：跨节点同名路径对全部登记（含 removed）消歧，取最新创建记录；
   * - `cleanup`：跨节点同名路径对 active 登记消歧，优先取最新 active，否则取最新 removed。
   */
  resolveRecord(input: WorktreeRecordSelector, mode: WorktreeResolveMode): ManagedWorktreeRecord {
    validateWorktreeSelector(input, mode)
    const records = this.loadDoc().records
    const scopeHint =
      mode === 'inspect'
        ? 'inspect 仅检视 helm 登记的隔离 worktree'
        : 'cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录'

    if (input.worktreeId !== undefined) {
      const record = records.find((r) => r.id === input.worktreeId)
      if (record === undefined) {
        throw new HelmError('not_found', `未找到受管 worktree 记录 ${input.worktreeId}`, 404, {
          worktreeId: input.worktreeId,
        })
      }
      return record
    }
    if (input.conversationId !== undefined) {
      const record = this.getForConversation(input.conversationId)
      if (record === undefined) {
        throw new HelmError(
          'not_found',
          `未找到会话 ${input.conversationId} 绑定的受管 worktree 记录；${scopeHint}`,
          404,
          { conversationId: input.conversationId },
        )
      }
      return record
    }
    const matches = records.filter(
      (r) => r.path === input.path && (input.nodeId === undefined || r.nodeId === input.nodeId),
    )
    if (matches.length === 0) {
      const suffix = mode === 'inspect' ? `${scopeHint}，不支持任意目录` : scopeHint
      throw new HelmError(
        'not_found',
        `未找到路径 ${input.path}${input.nodeId !== undefined ? `（节点 ${input.nodeId}）` : ''} 的受管 worktree 记录；${suffix}`,
        404,
        { path: input.path, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) },
      )
    }
    if (mode === 'inspect') {
      const nodeIds = new Set(matches.map((r) => r.nodeId))
      if (nodeIds.size > 1) {
        throw new HelmError(
          'validation_error',
          `路径 ${input.path} 在多个节点存在登记（${[...nodeIds].join(', ')}），检视需指定 nodeId 消歧（或改用 worktreeId 精确指定）`,
          400,
          { path: input.path, nodeIds: [...nodeIds] },
        )
      }
      return matches.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    }
    const active = matches.filter((r) => r.status === 'active')
    const nodeIds = new Set(active.map((r) => r.nodeId))
    if (nodeIds.size > 1) {
      throw new HelmError(
        'validation_error',
        `路径 ${input.path} 在多个节点存在 active 登记（${[...nodeIds].join(', ')}），清理需指定 nodeId 消歧（或改用 worktreeId 精确指定）`,
        400,
        { path: input.path, nodeIds: [...nodeIds] },
      )
    }
    if (active.length > 0) return active.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    return matches.reduce((a, b) => ((b.removedAt ?? b.createdAt) >= (a.removedAt ?? a.createdAt) ? b : a))
  }

  // ------------------------------------------------------------------
  // 占用判定与未知执行守卫（直接访问同库记录，无循环引用）
  // ------------------------------------------------------------------

  containsPath(path: string, candidate: string): boolean {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    const normalize = (value: string) => {
      const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
      return windows ? normalized.toLowerCase() : normalized
    }
    const base = normalize(path)
    const probe = normalize(candidate)
    return probe === base || probe.startsWith(`${base}/`)
  }

  /** 会话工作状态：读取错误如实上抛（fail-closed）；未注入 host 时视为不在运行。 */
  isConversationWorking(id: number): boolean {
    if (this.host === undefined) return false
    const conv = this.host.getConversation(id)
    return conv.status === 'working' || conv.status === 'blocked'
  }

  /** 租约在指定节点上的隔离路径（优先显式字段，其次同库受管记录，最后回退 info 坐标）。 */
  leasePathOf(lease: WorktreeLeaseRecord, nodeId: string): string | undefined {
    if (lease.nodeId !== undefined && lease.path !== undefined) {
      return lease.nodeId === nodeId ? lease.path : undefined
    }
    const record = this.findById(lease.worktreeId)
    if (record !== undefined) {
      return record.nodeId === nodeId ? record.path : undefined
    }
    if (lease.info.nodeId === nodeId) {
      return lease.info.effectiveCwd ?? extractWorkflowExecutionMeta(lease.info).worktree?.path
    }
    return undefined
  }

  isPathInUse(nodeId: string, path: string): boolean {
    for (const info of this.host?.listActiveSpawnExecutions() ?? []) {
      if (info.nodeId !== nodeId) continue
      if (info.effectiveCwd !== undefined && this.containsPath(path, info.effectiveCwd)) return true
      const wt = extractWorkflowExecutionMeta(info).worktree
      if (wt !== undefined && this.containsPath(path, wt.path)) return true
    }
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath !== undefined && this.containsPath(path, leasePath)) return true
    }
    for (const record of this.loadDoc().records) {
      if (record.status !== 'active' || record.hold === undefined) continue
      if (record.nodeId !== nodeId) continue
      if (this.containsPath(path, record.path) || this.containsPath(record.path, path)) return true
    }
    return false
  }

  assertNoUnknownExecution(nodeId: string, path: string): void {
    const active = new Set(
      (this.host?.listActiveSpawnExecutions() ?? []).map(
        (info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`,
      ),
    )
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath === undefined || !this.containsPath(path, leasePath)) continue
      const key = `${lease.info.executionId ?? ''}\u0000${lease.info.conversationId ?? ''}`
      if (!active.has(key)) {
        throw new HelmError(
          'worktree_execution_unknown',
          '工作树存在重启中断或未确认停止的执行，不能清理；请先检视并续接收尾，或确认停止后在目标节点手动清理 Git 工作树',
          409,
          { nodeId, path, executionId: lease.info.executionId, conversationId: lease.info.conversationId, phase: lease.phase },
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // durable 租约（worktree-leases）
  // ------------------------------------------------------------------

  listLeases(): Map<string, WorktreeLeaseRecord> {
    const raw = this.docStore.get<Record<string, WorktreeLeaseRecord>>(LEASES_DOC_KEY, {})
    return new Map(Object.entries(raw))
  }

  saveLeases(map: Map<string, WorktreeLeaseRecord>): void {
    this.docStore.set(LEASES_DOC_KEY, Object.fromEntries(map))
  }

  /** `git worktree add` 或远端 resume 探测之前落盘占位租约。 */
  async openPendingLease(target: { nodeId: string; path: string; worktreeId?: string }): Promise<string> {
    const token = randomUUID()
    const worktreeId = target.worktreeId ?? `${target.nodeId}:${target.path}`
    const map = this.listLeases()
    map.set(token, {
      phase: 'pending',
      nodeId: target.nodeId,
      path: target.path,
      info: { nodeId: target.nodeId },
      worktreeId,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    await this.flush()
    return token
  }

  /** 同步回调内登记 running 租约（外部运行时首次回填专用；调用方自行触发异步 flush）。 */
  stageRunningLease(target: { worktreeId: string; nodeId: string; path: string; info: AgentExecutionInfo }): string {
    const token = randomUUID()
    const map = this.listLeases()
    map.set(token, {
      phase: 'running',
      nodeId: target.nodeId,
      path: target.path,
      info: target.info,
      worktreeId: target.worktreeId,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    return token
  }

  updateLease(token: string, info: AgentExecutionInfo): void {
    const map = this.listLeases()
    const lease = map.get(token)
    if (lease === undefined) return
    map.set(token, { ...lease, phase: 'running', info })
    this.saveLeases(map)
  }

  async acquireReattachLease(
    target: { worktreeId: string; nodeId: string; path: string },
    match: { conversationId?: number; executionId?: string },
    info: AgentExecutionInfo,
  ): Promise<string> {
    const map = this.listLeases()
    for (const [token, lease] of map) {
      if (lease.worktreeId !== target.worktreeId) continue
      const matchExec = match.executionId !== undefined && lease.info.executionId === match.executionId
      const matchConv = match.conversationId !== undefined && lease.info.conversationId === match.conversationId
      if (matchExec || matchConv) {
        map.set(token, {
          ...lease,
          phase: 'running',
          nodeId: target.nodeId,
          path: target.path,
          info: { ...lease.info, ...info },
        })
        this.saveLeases(map)
        await this.flush()
        return token
      }
    }
    const token = randomUUID()
    map.set(token, {
      phase: 'running',
      nodeId: target.nodeId,
      path: target.path,
      info,
      worktreeId: target.worktreeId,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    await this.flush()
    return token
  }

  findLeaseTokenByExecution(match: { executionId?: string; conversationId?: number }): string | undefined {
    for (const [token, lease] of this.listLeases()) {
      if (match.executionId !== undefined && lease.info.executionId === match.executionId) return token
      if (
        match.conversationId !== undefined &&
        lease.info.executionId === undefined &&
        lease.info.conversationId === match.conversationId
      ) {
        return token
      }
    }
    return undefined
  }

  async settleLease(token: string, succeeded: boolean, neverStarted: boolean): Promise<void> {
    if (!succeeded && !neverStarted) return
    const map = this.listLeases()
    if (!map.has(token)) return
    map.delete(token)
    this.saveLeases(map)
    await this.flush()
  }

  async settleLeaseAfterNextFailure(token: string, execution: AgentExecutionInfo | undefined): Promise<void> {
    if (execution === undefined) return
    if (execution.conversationId === undefined || execution.executionId !== undefined) return
    let working: boolean
    try {
      working = this.isConversationWorking(execution.conversationId)
    } catch {
      return
    }
    if (!working) await this.settleLease(token, true, false)
  }

  async clearStaleLeases(worktreeId: string): Promise<void> {
    const map = this.listLeases()
    let changed = false
    for (const [token, lease] of map) {
      if (lease.worktreeId === worktreeId) {
        map.delete(token)
        changed = true
      }
    }
    if (!changed) return
    this.saveLeases(map)
    await this.flush()
  }

  private isLeaseActiveInHost(
    lease: WorktreeLeaseRecord,
    activeInfos: readonly AgentExecutionInfo[],
    activeKeys: ReadonlySet<string>,
  ): boolean {
    if (lease.info.executionId !== undefined || lease.info.conversationId !== undefined) {
      const key = `${lease.info.executionId ?? ''}\u0000${lease.info.conversationId ?? ''}`
      if (activeKeys.has(key)) return true
    }
    for (const info of activeInfos) {
      if (info.nodeId === undefined) continue
      const leasePath = this.leasePathOf(lease, info.nodeId)
      if (leasePath === undefined) continue
      if (info.effectiveCwd !== undefined && this.containsPath(leasePath, info.effectiveCwd)) return true
      const wt = extractWorkflowExecutionMeta(info).worktree
      if (wt !== undefined && this.containsPath(leasePath, wt.path)) return true
    }
    return false
  }

  async reconcileStoppedNativeLeases(): Promise<number> {
    const map = this.listLeases()
    if (map.size === 0) return 0
    const activeInfos = this.host?.listActiveSpawnExecutions() ?? []
    const activeKeys = new Set(
      activeInfos.map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`),
    )
    let removed = 0
    for (const [token, lease] of map) {
      if (this.isLeaseActiveInHost(lease, activeInfos, activeKeys)) continue
      if (lease.info.executionId !== undefined) continue
      if (lease.phase === 'pending') {
        map.delete(token)
        removed += 1
        continue
      }
      if (lease.phase === 'running' && lease.info.conversationId !== undefined) {
        let stopped = false
        try {
          stopped = !this.isConversationWorking(lease.info.conversationId)
        } catch (error) {
          if (error instanceof HelmError && error.code === 'not_found') {
            stopped = true
          } else {
            process.stderr.write(
              `builtin:workflow reconcileStoppedNativeLeases: skip lease ${lease.worktreeId} (conv ${lease.info.conversationId} lookup failed): ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
        if (stopped) {
          map.delete(token)
          removed += 1
        }
      }
    }
    if (removed === 0) return 0
    this.saveLeases(map)
    await this.flush()
    return removed
  }

  // ------------------------------------------------------------------
  // agentId 绑定（worktree-agent-bindings）与会话删除裁剪
  // ------------------------------------------------------------------

  resolveResumeChildId(request: AgentSpawnRequest): number | undefined {
    if (request.resume === undefined) return undefined
    if (/^\d+$/.test(request.resume)) return Number(request.resume)
    const bindings = this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})
    return bindings[request.resume]?.childId
  }

  recordAgentBinding(
    agentId: string | undefined,
    childId: number | undefined,
    parentConversationId: number,
  ): void {
    if (agentId === undefined || agentId === '' || childId === undefined) return
    const bindings = this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})
    const existing = bindings[agentId]
    if (existing !== undefined && existing.childId === childId && existing.parentConversationId === parentConversationId) {
      return
    }
    bindings[agentId] = { childId, parentConversationId }
    this.docStore.set(AGENT_BINDINGS_DOC_KEY, bindings)
  }

  /**
   * 裁剪与已删除会话关联的持久化元数据：
   * 1) 删除 `worktree-agent-bindings` 中父会话或子会话命中 `conversationId` 的条目；
   * 2) 删除 `runtime/worktrees` 中关联 `conversationId` 且 `status === 'removed'`（且无任何租约引用）的记录；
   * 绝不删除 `status === 'active'` 的工作树登记或任何活跃/fail-closed 租约。
   */
  pruneConversation(conversationId: number): void {
    const bindings = this.docStore.get<Record<string, WorktreeAgentBinding>>(AGENT_BINDINGS_DOC_KEY, {})
    let bindingsChanged = false
    for (const [agentId, entry] of Object.entries(bindings)) {
      if (entry.childId === conversationId || entry.parentConversationId === conversationId) {
        delete bindings[agentId]
        bindingsChanged = true
      }
    }
    if (bindingsChanged) {
      this.docStore.set(AGENT_BINDINGS_DOC_KEY, bindings)
    }

    const doc = this.loadDoc()
    if (doc.records.length === 0) return
    const leasedIds = new Set(Array.from(this.listLeases().values(), (l) => l.worktreeId))
    const kept = doc.records.filter((r) => {
      if (r.status !== 'removed') return true
      if (r.hold !== undefined) return true
      if (leasedIds.has(r.id)) return true
      return r.conversationId !== conversationId && r.parentConversationId !== conversationId
    })
    if (kept.length !== doc.records.length) {
      this.saveDoc({ ...doc, records: kept })
    }
  }
}
