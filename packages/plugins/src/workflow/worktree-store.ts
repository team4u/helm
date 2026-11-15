/**
 * WorktreeAllocator 的登记持久层（docStore 读写 + 记录校验 + 记录查询）：
 * - 持久化：`runtime/worktrees` 文档（版本化；损坏显式 worktree_doc_corrupted，
 *   开发阶段不迁移——丢失已登记记录会让 cleanup 误判「未登记」而拒绝清理，
 *   或误把人类目录当可清理）；
 * - 校验：`assertMetadataSecretFree`（持久化元数据机密检查——docStore 原始
 *   JSON 落库不自动脱敏，路径/分支/仓路径含已登记机密即显式
 *   worktree_metadata_secret 拒绝，诊断仅用脱敏值）；
 * - 查询：会话/路径/ID 选择器解析（getForConversation / findActive /
 *   resolveInspectRecord / resolveCleanupRecord——同一路径多节点 active 登记
 *   歧义显式 validation_error，绝不任选首条静默操作别的节点）。
 *
 * 本模块零 git、零节点 IO、零状态机策略：只做记录的读、写、校验与选取。
 */

import { HelmError } from '@helm/protocol'

/** 受管 worktree 持久化 key（docStore 命名空间 'runtime/worktrees'）。 */
const DOC_KEY = 'runtime/worktrees'

/** 持久化文档形状（版本化，向后不兼容时整体重建——开发阶段无迁移）。 */
export interface WorktreeDoc {
  version: 1
  records: ManagedWorktreeRecord[]
}

/** 单条受管 worktree 记录。 */
export interface ManagedWorktreeRecord {
  /** 唯一标识（`${nodeId}:${path}`）。 */
  id: string
  nodeId: string
  /** 主工作树路径（权威 `git worktree list` 首条登记；external 首次清理时解析并持久化）。 */
  repoRoot: string
  path: string
  branch: string
  baseCommit: string
  /** 创建时源目录检出的本地分支名（detached HEAD 时缺省）。 */
  baseBranch?: string
  /** 源目录本身是受管 Worktree 时记录其登记 ID（多级派生父子关系）。 */
  parentWorktreeId?: string
  dirtySource: boolean
  parentConversationId: number
  conversationId?: number
  executionId?: string
  origin: 'native' | 'external'
  status: 'active' | 'removed'
  createdAt: number
  removedAt?: number
  /** 分支是否已删除（worktree 已移除但分支删除部分失败时为 false，可重试 cleanup deleteBranch）。 */
  branchDeleted?: boolean
  /** 分支删除失败的最后诊断（已脱敏；重试成功后清除）。 */
  branchDeleteError?: string
}

/** 只读记录选择器（worktreeId / conversationId / path[+nodeId]；互斥规则由调用方入口校验）。 */
export interface WorktreeRecordSelector {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
}

/** 受管 worktree 登记存储（同步 docStore；与 PluginDocStore 同契约，原始 JSON 落库不自动脱敏）。 */
export class WorktreeStore {
  constructor(
    private readonly docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void },
    private readonly redact: (text: string) => string,
  ) {}

  private loadDoc(): WorktreeDoc {
    const doc = this.docStore.get<WorktreeDoc>(DOC_KEY, { version: 1, records: [] })
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) {
      // 开发阶段不迁移：损坏文档显式失败，绝不静默当空表（丢失已登记记录
      // 会让 cleanup 误判“未登记”而拒绝清理，或误把人类目录当可清理）。
      throw new HelmError('worktree_doc_corrupted', `受管 worktree 文档 '${DOC_KEY}' 损坏（records 非数组）`, 500)
    }
    return doc
  }

  private saveDoc(doc: WorktreeDoc): void {
    this.docStore.set(DOC_KEY, doc)
  }

  /** 当前全部登记（同一 doc 快照；变更须经 append/updateRecord 落盘）。 */
  records(): ManagedWorktreeRecord[] {
    return this.loadDoc().records
  }

  /** 追加一条登记并落盘（原样透传 docStore 异常，由调用方如实诊断）。 */
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
   * 持久化元数据机密检查：docStore 原始 JSON 落库不自动脱敏，任何将保存的
   * 路径/分支/仓路径经 redact 后有差异（含已登记 secret）即显式拒绝登记
   * （诊断仅用脱敏值；绝不脱敏后再当真实路径使用，也绝不 raw 落库）。
   * identity 为非机密定位字段（nodeId/conversationId/executionId 等），
   * 原样进 message/details——拒绝后仍能定位对应的外部执行。
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

  /** 查询会话当前绑定的受管 worktree（最新优先；无绑定返回 undefined）。 */
  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.conversationId === conversationId)
    if (records.length === 0) return undefined
    // 多条（历史遗留）时取最新创建的 active 记录；无 active 取最新。
    const active = records.filter((r) => r.status === 'active')
    const pool = active.length > 0 ? active : records
    return pool.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
  }

  /** 全部登记记录（新建在前；含已 removed，供只读检视/列表消费）。 */
  list(): ManagedWorktreeRecord[] {
    return [...this.loadDoc().records].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 按 worktreeId / 会话 / 路径（可附 nodeId 消歧）查询 active 记录。
   * 同一路径在多个节点有 active 登记且未指定 nodeId 时显式 validation_error
   * （绝不任选首条静默清理别的节点）。
   */
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
   * 解析检视目标记录（选择器互斥规则与 cleanup 同构；含已 removed 记录——
   * 检视是只读面，元数据本身诚实可返）。未登记选择器显式 not_found：
   * 只检视 helm 登记的受管 worktree，绝不接受任意目录读文件。
   */
  resolveInspectRecord(input: WorktreeRecordSelector): ManagedWorktreeRecord {
    const records = this.loadDoc().records
    if (input.worktreeId !== undefined) {
      const record = records.find((r) => r.id === input.worktreeId)
      if (record === undefined) {
        throw new HelmError('not_found', `未找到受管 worktree 记录 ${input.worktreeId}`, 404, { worktreeId: input.worktreeId })
      }
      return record
    }
    if (input.conversationId !== undefined) {
      const record = this.getForConversation(input.conversationId)
      if (record === undefined) {
        throw new HelmError(
          'not_found',
          `未找到会话 ${input.conversationId} 绑定的受管 worktree 记录；inspect 仅检视 helm 登记的隔离 worktree`,
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
      throw new HelmError(
        'not_found',
        `未找到路径 ${input.path}${input.nodeId !== undefined ? `（节点 ${input.nodeId}）` : ''} 的受管 worktree 记录；inspect 仅检视 helm 登记的隔离 worktree，不支持任意目录`,
        404,
        { path: input.path, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) },
      )
    }
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

  /** 解析清理目标记录（选择器互斥：worktreeId 单用；nodeId 仅搭 path；conversationId/path 择一）。 */
  resolveCleanupRecord(input: WorktreeRecordSelector): ManagedWorktreeRecord {
    const records = this.loadDoc().records
    if (input.worktreeId !== undefined) {
      const record = records.find((r) => r.id === input.worktreeId)
      if (record === undefined) {
        throw new HelmError('not_found', `未找到受管 worktree 记录 ${input.worktreeId}`, 404, { worktreeId: input.worktreeId })
      }
      return record
    }
    if (input.conversationId !== undefined) {
      const record = this.getForConversation(input.conversationId)
      if (record === undefined) {
        throw new HelmError(
          'not_found',
          `未找到会话 ${input.conversationId} 绑定的受管 worktree 记录；cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录`,
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
      throw new HelmError(
        'not_found',
        `未找到路径 ${input.path}${input.nodeId !== undefined ? `（节点 ${input.nodeId}）` : ''} 的受管 worktree 记录；cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录`,
        404,
        { path: input.path, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) },
      )
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
    // 全部已 removed：幂等返回最新一条（供重复清理拿 removed:false）。
    return matches.reduce((a, b) => ((b.removedAt ?? b.createdAt) >= (a.removedAt ?? a.createdAt) ? b : a))
  }
}
