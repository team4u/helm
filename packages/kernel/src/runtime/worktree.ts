/**
 * 跨节点通用 WorktreeAllocator：isolation: 'worktree' 的机制层。
 *
 * 职责（机制与策略分离：本模块只提供受管 worktree 的创建/登记/校验/清理
 * 机制，策略由调用方（原生 spawn、外部运行时插件）决定）：
 * - `allocate`：在目标节点 (EnvFabric envFor) 对源 cwd 执行真实 git 命令，
 *   在仓库同级 `.helm-worktrees/<repo>-<shortId>` 建独立 worktree 与
 *   `helm/spawn-<shortId>` 分支（基于 HEAD），如实记录 dirtySource；
 * - `registerExternal`：外部运行时（如 builtin:herdr 的 worktree.create）
 *   回传的 worktree 统一登记（cleanup 只清理已登记记录，绝不碰人类目录）；
 * - `verifyForResume`：resume 续接前校验 worktree 仍在（目录被删/已被清理
 *   显式报 worktree_missing；resume 改写 cwd 显式报 resume_cwd_conflict）；
 * - `cleanup`：占用检查（子会话运行中/路径被引用拒绝）+ 脏工作区保护
 *   （未提交修改或未合入提交且未显式 force 时拒绝，绝不静默丢数据）+
 *   per-repo 串行锁（防 parallel() 抢 .git/config.lock）+ 真实
 *   `git worktree remove` / `git branch -d|-D`，登记记录置 removed；
 * - `createCleanupWorktreeTool`：内核工具 `cleanup_worktree`（模型可调用）。
 *
 * 诚实性纪律：非 Git 仓库、git 失败、目录缺失均带真实输出显式抛 HelmError，
 * 绝不静默降级、绝不伪造 fallback 数据；清理仅针对 docStore 已登记记录，
 * 分支名严格校验 helm/spawn-* | helm/wf-* 前缀（绝不误删人类分支/目录）。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, int, obj, opt, str } from '@earendil-works/pi-schema'
import { randomUUID } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type { EnvFabric } from '../env/fabric.js'
import { pathRulesForShape, targetPathShape } from './tools.js'

/** 受管 worktree 持久化 key（docStore 命名空间 'runtime/worktrees'）。 */
const DOC_KEY = 'runtime/worktrees'

/** 持久化文档形状（版本化，向后不兼容时整体重建——开发阶段无迁移）。 */
interface WorktreeDoc {
  version: 1
  records: ManagedWorktreeRecord[]
}

/** 单条受管 worktree 记录。 */
export interface ManagedWorktreeRecord {
  /** 唯一标识（`${nodeId}:${path}`）。 */
  id: string
  nodeId: string
  repoRoot: string
  path: string
  branch: string
  baseCommit: string
  dirtySource: boolean
  parentConversationId: number
  conversationId?: number
  executionId?: string
  origin: 'native' | 'external'
  status: 'active' | 'removed'
  createdAt: number
  removedAt?: number
}

export interface WorktreeAllocatorDeps {
  /** 跨节点执行底座（allocate/verify/cleanup 的 git 命令经目标节点执行）。 */
  envFabric: Pick<EnvFabric, 'envFor'>
  /** 持久化文档存储（get/set 同步；与 PluginDocStore 同契约）。 */
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void }
  /** 文本脱敏（git 输出进错误诊断前过一遍；缺省原样）。 */
  redact?: (text: string) => string
  /** 子会话是否仍在运行（cleanup 占用检查；缺省视为不在运行）。 */
  isConversationWorking?: (conversationId: number) => boolean
  /** worktree 路径是否仍被引用（cleanup 占用检查；缺省视为未被引用）。 */
  isPathInUse?: (nodeId: string, path: string) => boolean
}

export interface AllocateInput {
  nodeId: string
  sourceCwd: string
  parentConversationId: number
  /** 人类可读标签提示（暂未参与命名；预留）。 */
  labelHint?: string
  signal?: AbortSignal
}

export interface RegisterExternalInput {
  nodeId: string
  path: string
  branch: string
  parentConversationId: number
  conversationId?: number
  executionId?: string
  /** 外部运行时的源 cwd（repoRoot 未知时先记录，清理时解析）。 */
  sourceCwd?: string
}

export interface CleanupInput {
  conversationId?: number
  path?: string
  deleteBranch?: boolean
  force?: boolean
  signal?: AbortSignal
}

export interface CleanupResult {
  removed: boolean
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}

/** 允许清理的分支前缀（helm 受管命名空间；绝不碰人类分支）。 */
const MANAGED_BRANCH_PREFIXES = ['helm/spawn-', 'helm/wf-'] as const

/** 单条 git 命令的执行超时（秒）。 */
const GIT_TIMEOUT_SECONDS = 120

/** POSIX shell 安全引用（单引号包裹，内部单引号转义；跨节点 shell 同构）。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

/** 外部 AbortSignal 挂到 SDK Context（预 aborted 时 exec 直接拒绝 spawn）。 */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/** 在目标节点执行单条 git 命令；非零退出显式失败（绝不静默吞 stderr）。 */
async function gitExec(
  deps: WorktreeAllocatorDeps,
  nodeId: string,
  cwd: string,
  command: string,
  signal?: AbortSignal,
): Promise<{ ok: true; output: string } | { ok: false; output: string; exitCode: number | null }> {
  const redact = deps.redact ?? ((t: string) => t)
  const env = deps.envFabric.envFor(nodeId, cwd)
  let combined = ''
  const result = await env.exec(
    command,
    {
      cwd,
      timeout: GIT_TIMEOUT_SECONDS,
      onOutput: (text: string) => {
        combined += text
      },
    },
    contextWithSignal(signal),
  )
  if (!result.ok) {
    return {
      ok: false,
      output: redact(combined + (combined === '' ? '' : '\n') + `[git ${result.error.code}: ${result.error.message}]`),
      exitCode: null,
    }
  }
  if (result.value.exitCode !== 0) {
    return { ok: false, output: redact(combined), exitCode: result.value.exitCode }
  }
  return { ok: true, output: combined }
}

export class WorktreeAllocator {
  /** per-repo 进程内串行队列尾（同仓库 git worktree add/remove 串行，防 config.lock 竞争）。 */
  private readonly repoLocks = new Map<string, Promise<unknown>>()

  private readonly redact: (text: string) => string

  constructor(private readonly deps: WorktreeAllocatorDeps) {
    this.redact = deps.redact ?? ((t: string) => t)
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------

  private loadDoc(): WorktreeDoc {
    const doc = this.deps.docStore.get<WorktreeDoc>(DOC_KEY, { version: 1, records: [] })
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) {
      // 开发阶段不迁移：损坏文档显式失败，绝不静默当空表（丢失已登记记录
      // 会让 cleanup 误判“未登记”而拒绝清理，或误把人类目录当可清理）。
      throw new HelmError('worktree_doc_corrupted', `受管 worktree 文档 '${DOC_KEY}' 损坏（records 非数组）`, 500)
    }
    return doc
  }

  private saveDoc(doc: WorktreeDoc): void {
    this.deps.docStore.set(DOC_KEY, doc)
  }

  private updateRecord(id: string, mutate: (record: ManagedWorktreeRecord) => ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) {
      throw new HelmError('not_found', `受管 worktree 记录 ${id} 不存在（文档状态不一致）`, 404, { id })
    }
    doc.records[index] = mutate(doc.records[index]!)
    this.saveDoc(doc)
  }

  // ------------------------------------------------------------------
  // per-repo mutex
  // ------------------------------------------------------------------

  /** 同一 (nodeId, repoRoot) 的操作串行执行（进程内 Promise 链尾拼接）。 */
  private async withRepoLock<T>(nodeId: string, repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = `${nodeId}\u0000${repoRoot}`
    const previous = this.repoLocks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    // 链尾自愈：fn 抛错不让后续等待者永久失败（错误由各自调用方如实处理）。
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.repoLocks.set(key, tail)
    void tail.then(() => {
      if (this.repoLocks.get(key) === tail) this.repoLocks.delete(key)
    })
    return run
  }

  // ------------------------------------------------------------------
  // allocate（原生 isolation: 'worktree'）
  // ------------------------------------------------------------------

  async allocate(input: AllocateInput): Promise<ManagedWorktreeRecord> {
    const { nodeId, sourceCwd } = input
    // Step A：定位仓库根（非 Git 目录显式失败，绝不猜测）。
    const toplevel = await gitExec(this.deps, nodeId, sourceCwd, 'git rev-parse --show-toplevel', input.signal)
    if (!toplevel.ok) {
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）不是 Git 仓库（git rev-parse --show-toplevel 失败）：\n${toplevel.output.trim()}`,
        400,
        { nodeId, sourceCwd, output: toplevel.output.slice(0, 2000) },
      )
    }
    const repoRoot = toplevel.output.trim()
    if (repoRoot === '') {
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）的 git rev-parse --show-toplevel 输出为空`,
        400,
        { nodeId, sourceCwd },
      )
    }
    return this.withRepoLock(nodeId, repoRoot, async () => {
      // Step B：基准提交与源工作区脏状态（任一失败显式 worktree_failed）。
      const head = await gitExec(this.deps, nodeId, repoRoot, 'git rev-parse HEAD', input.signal)
      if (!head.ok) {
        throw new HelmError(
          'worktree_failed',
          `读取仓库 ${repoRoot}（节点 ${nodeId}）HEAD 失败：\n${head.output.trim()}`,
          502,
          { nodeId, repoRoot, output: head.output.slice(0, 2000) },
        )
      }
      const baseCommit = head.output.trim()
      if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
        throw new HelmError(
          'worktree_failed',
          `仓库 ${repoRoot}（节点 ${nodeId}）HEAD 输出非提交哈希：${JSON.stringify(baseCommit)}`,
          502,
          { nodeId, repoRoot, head: baseCommit },
        )
      }
      const status = await gitExec(this.deps, nodeId, repoRoot, 'git status --porcelain', input.signal)
      if (!status.ok) {
        throw new HelmError(
          'worktree_failed',
          `读取仓库 ${repoRoot}（节点 ${nodeId}）状态失败：\n${status.output.trim()}`,
          502,
          { nodeId, repoRoot, output: status.output.slice(0, 2000) },
        )
      }
      const dirtySource = status.output.trim().length > 0

      // 隔离路径与分支名：按 repoRoot 自身形状的纯路径规则（POSIX/Windows）。
      const pathRules = pathRulesForShape(targetPathShape(repoRoot))
      const repoName = pathRules.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
      const shortId = randomUUID().replaceAll('-', '').slice(0, 8)
      const branch = `helm/spawn-${shortId}`
      const worktreeBase = pathRules.join(pathRules.dirname(repoRoot), '.helm-worktrees')
      const worktreePath = pathRules.join(worktreeBase, `${repoName}-${shortId}`)

      // git worktree add 自建父目录（含中间层级）；shellQuote 防路径空格/特殊字符注入。
      const add = await gitExec(
        this.deps,
        nodeId,
        repoRoot,
        `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)} HEAD`,
        input.signal,
      )
      if (!add.ok) {
        throw new HelmError(
          'worktree_failed',
          `在仓库 ${repoRoot}（节点 ${nodeId}）创建 worktree ${worktreePath} 失败：\n${add.output.trim()}`,
          502,
          { nodeId, repoRoot, path: worktreePath, branch, output: add.output.slice(0, 2000) },
        )
      }
      const now = Date.now()
      const record: ManagedWorktreeRecord = {
        id: `${nodeId}:${worktreePath}`,
        nodeId,
        repoRoot,
        path: worktreePath,
        branch,
        baseCommit,
        dirtySource,
        parentConversationId: input.parentConversationId,
        origin: 'native',
        status: 'active',
        createdAt: now,
      }
      const doc = this.loadDoc()
      doc.records.push(record)
      this.saveDoc(doc)
      return record
    })
  }

  // ------------------------------------------------------------------
  // 登记 / 查询
  // ------------------------------------------------------------------

  /** 子会话创建后把 conversationId 关联写回记录。 */
  bindConversation(worktreePath: string, nodeId: string, conversationId: number): void {
    const id = `${nodeId}:${worktreePath}`
    const existing = this.loadDoc().records.find((r) => r.id === id)
    if (existing === undefined) {
      throw new HelmError(
        'not_found',
        `受管 worktree 记录 ${id} 不存在，无法绑定会话 ${conversationId}`,
        404,
        { id, conversationId },
      )
    }
    this.updateRecord(id, (r) => ({ ...r, conversationId }))
  }

  /** 外部运行时（如 builtin:herdr）回传 worktree 时统一登记/更新。 */
  registerExternal(input: RegisterExternalInput): ManagedWorktreeRecord {
    const id = `${input.nodeId}:${input.path}`
    const doc = this.loadDoc()
    const existing = doc.records.find((r) => r.id === id)
    if (existing !== undefined) {
      const updated: ManagedWorktreeRecord = {
        ...existing,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      }
      this.updateRecord(id, () => updated)
      return updated
    }
    const record: ManagedWorktreeRecord = {
      id,
      nodeId: input.nodeId,
      // 外部运行时可能不回传主仓路径：先记 sourceCwd（清理时解析真实 repoRoot）。
      repoRoot: input.sourceCwd ?? '',
      path: input.path,
      branch: input.branch,
      baseCommit: '',
      dirtySource: false,
      parentConversationId: input.parentConversationId,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      origin: 'external',
      status: 'active',
      createdAt: Date.now(),
    }
    doc.records.push(record)
    this.saveDoc(doc)
    return record
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

  /** 按会话或路径查询 active 记录（path 查找不区分节点：路径本身全局唯一）。 */
  findActive(query: { conversationId?: number; path?: string }): ManagedWorktreeRecord | undefined {
    return this.loadDoc().records.find(
      (r) => r.status === 'active' && ((query.conversationId !== undefined && r.conversationId === query.conversationId) || r.path === query.path),
    )
  }

  // ------------------------------------------------------------------
  // resume 校验
  // ------------------------------------------------------------------

  /**
   * resume 续接校验：cwd 冲突显式拒绝（不中途搬家）；记录已清理或目录缺失
   * 显式 worktree_missing（经目标节点真实探测，绝不凭记录断言存在）。
   */
  async verifyForResume(
    record: ManagedWorktreeRecord,
    explicitCwd?: string,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeRecord> {
    if (explicitCwd !== undefined && explicitCwd !== record.path) {
      throw new HelmError(
        'resume_cwd_conflict',
        `子会话已绑定隔离 worktree '${record.path}'，不支持在 resume 时改写 cwd 为 '${explicitCwd}'`,
        409,
        { existingCwd: record.path, requestedCwd: explicitCwd },
      )
    }
    if (record.status === 'removed') {
      throw new HelmError(
        'worktree_missing',
        `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`,
        409,
        { path: record.path, branch: record.branch },
      )
    }
    // 真实探测：repoRoot 未知的 external 记录从 worktree 自身向上解析主仓。
    const probeCwd = record.repoRoot !== '' ? record.repoRoot : pathRulesForShape(targetPathShape(record.path)).dirname(record.path)
    const probe = await gitExec(
      this.deps,
      record.nodeId,
      probeCwd,
      `git -C ${shellQuote(record.path)} rev-parse --is-inside-work-tree`,
      signal,
    )
    if (!probe.ok || probe.output.trim() !== 'true') {
      throw new HelmError(
        'worktree_missing',
        `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）已不存在或不是工作树：\n${probe.output.trim()}`,
        409,
        { path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    return record
  }

  // ------------------------------------------------------------------
  // cleanup
  // ------------------------------------------------------------------

  /** 解析记录的 repoRoot（external 记录未知时经 `git rev-parse --git-common-dir` 现场解析）。 */
  private async resolveRepoRoot(record: ManagedWorktreeRecord, signal?: AbortSignal): Promise<string> {
    if (record.repoRoot !== '') return record.repoRoot
    // worktree 目录内 .git 是文件，指向主仓 .git；git-common-dir 是权威主仓路径。
    const result = await gitExec(
      this.deps,
      record.nodeId,
      record.path,
      `git -C ${shellQuote(record.path)} rev-parse --path-format=absolute --git-common-dir`,
      signal,
    )
    const commonDir = result.ok ? result.output.trim() : ''
    if (commonDir === '') {
      throw new HelmError(
        'worktree_missing',
        `worktree '${record.path}'（节点 ${record.nodeId}）已不存在，无法解析主仓路径：\n${result.output.trim()}`,
        409,
        { path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    // git-common-dir 指向 <repoRoot>/.git；剥最后一节得 repoRoot。
    const rules = pathRulesForShape(targetPathShape(commonDir))
    const repoRoot = rules.dirname(rules.dirname(commonDir))
    this.updateRecord(record.id, (r) => ({ ...r, repoRoot }))
    return repoRoot
  }

  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    if (input.conversationId === undefined && input.path === undefined) {
      throw new HelmError('validation_error', 'cleanup 需提供 conversationId 或 path 之一', 400)
    }
    // 仅操作已登记记录（绝不清理未登记的人类目录）。
    const record = input.conversationId !== undefined ? this.getForConversation(input.conversationId) : this.findActive({ path: input.path })
    if (record === undefined) {
      throw new HelmError(
        'not_found',
        `未找到受管 worktree 记录（conversationId=${input.conversationId ?? '未提供'} path=${input.path ?? '未提供'}）；cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录`,
        404,
        { conversationId: input.conversationId, path: input.path },
      )
    }
    if (!MANAGED_BRANCH_PREFIXES.some((prefix) => record.branch.startsWith(prefix))) {
      throw new HelmError(
        'validation_error',
        `受管 worktree '${record.path}' 的分支 '${record.branch}' 不在 helm 受管前缀（helm/spawn- | helm/wf-）内，拒绝清理`,
        400,
        { path: record.path, branch: record.branch },
      )
    }
    if (record.status === 'removed') {
      // 幂等：已清理记录直接返回 removed: false。
      return { removed: false, path: record.path, branch: record.branch, nodeId: record.nodeId, branchDeleted: false }
    }
    // 占用检查：子会话运行中或路径仍被引用时拒绝（绝不杀运行中的子代理）。
    if (record.conversationId !== undefined && this.deps.isConversationWorking?.(record.conversationId) === true) {
      throw new HelmError(
        'worktree_in_use',
        `worktree '${record.path}' 关联的子代理仍在运行中，拒绝清理`,
        409,
        { path: record.path, conversationId: record.conversationId },
      )
    }
    if (this.deps.isPathInUse?.(record.nodeId, record.path) === true) {
      throw new HelmError(
        'worktree_in_use',
        `worktree '${record.path}'（节点 ${record.nodeId}）仍被引用，拒绝清理`,
        409,
        { path: record.path, nodeId: record.nodeId },
      )
    }

    const repoRoot = await this.resolveRepoRoot(record, input.signal)

    // 脏工作区保护：未提交修改或未合入提交时显式拒绝（除非 force）。
    let dirtyFiles: string[] = []
    let unmergedCommits = 0
    if (input.force !== true) {
      const status = await gitExec(
        this.deps,
        record.nodeId,
        record.path,
        'git status --porcelain',
        input.signal,
      )
      // 目录已不在：status 失败视为 missing，走 prune 收尾路径（不阻塞清理）。
      if (status.ok) {
        dirtyFiles = status.output
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
      }
      if (record.baseCommit !== '') {
        const unmerged = await gitExec(
          this.deps,
          record.nodeId,
          repoRoot,
          `git rev-list HEAD..${shellQuote(record.branch)} --count`,
          input.signal,
        )
        if (unmerged.ok) unmergedCommits = Number.parseInt(unmerged.output.trim(), 10) || 0
      }
      if (dirtyFiles.length > 0 || unmergedCommits > 0) {
        throw new HelmError(
          'worktree_dirty',
          `worktree '${record.path}' (branch: ${record.branch}) 含未提交修改或未合入提交；请先检视/合入，或显式传 force: true 强制清理`,
          409,
          { path: record.path, branch: record.branch, dirtyFiles, unmergedCommits },
        )
      }
    }

    // per-repo 串行执行真实删除（防并发 config.lock 竞争）。
    await this.withRepoLock(record.nodeId, repoRoot, async () => {
      const forceFlag = input.force === true ? '--force ' : ''
      const remove = await gitExec(
        this.deps,
        record.nodeId,
        repoRoot,
        `git -C ${shellQuote(repoRoot)} worktree remove ${forceFlag}${shellQuote(record.path)}`,
        input.signal,
      )
      if (!remove.ok) {
        // 目录已被外部删掉（git 报 already exists/不存在等）：prune 收尾后视为移除。
        const stillThere = await gitExec(
          this.deps,
          record.nodeId,
          record.path,
          `git -C ${shellQuote(record.path)} rev-parse --is-inside-work-tree`,
          input.signal,
        )
        if (stillThere.ok && stillThere.output.trim() === 'true') {
          throw new HelmError(
            'worktree_remove_failed',
            `移除 worktree '${record.path}'（节点 ${record.nodeId}）失败：\n${remove.output.trim()}`,
            502,
            { path: record.path, branch: record.branch, output: remove.output.slice(0, 2000) },
          )
        }
        await gitExec(this.deps, record.nodeId, repoRoot, 'git worktree prune', input.signal)
      }
    })

    let branchDeleted = false
    if (input.deleteBranch === true) {
      const flag = input.force === true ? '-D' : '-d'
      const del = await gitExec(
        this.deps,
        record.nodeId,
        repoRoot,
        `git -C ${shellQuote(repoRoot)} branch ${flag} ${shellQuote(record.branch)}`,
        input.signal,
      )
      if (!del.ok) {
        throw new HelmError(
          'branch_delete_failed',
          `worktree '${record.path}' 已移除，但删除分支 ${record.branch} 失败：\n${del.output.trim()}`,
          502,
          { path: record.path, branch: record.branch, output: del.output.slice(0, 2000) },
        )
      }
      branchDeleted = true
    }

    this.updateRecord(record.id, (r) => ({ ...r, status: 'removed', removedAt: Date.now() }))
    return { removed: true, path: record.path, branch: record.branch, nodeId: record.nodeId, branchDeleted }
  }
}

// ---------------------------------------------------------------------------
// cleanup_worktree 内核工具
// ---------------------------------------------------------------------------

const cleanupWorktreeParameters = obj({
  conversationId: opt(int({ minimum: 1, description: '子会话 ID（与 path 择一）' })),
  path: opt(str({ description: 'worktree 绝对路径（与 conversationId 择一）' })),
  deleteBranch: opt(bool({ description: '同时删除 helm/spawn-* 分支（默认保留）' })),
  force: opt(bool({ description: '强制清理（含未提交修改或未合入提交的工作区；默认拒绝脏清理）' })),
})

/**
 * 内核工具 cleanup_worktree：清理受管隔离 worktree（模型可调用）。
 * 仅清理 WorktreeAllocator 登记的 helm/* 分支 worktree；脏工作区与占用中
 * 显式拒绝（错误消息指导先检视/合入或传 force）。
 */
export function createCleanupWorktreeTool(allocator: WorktreeAllocator): ToolRegistration<typeof cleanupWorktreeParameters, never> {
  return defineTool({
    name: 'cleanup_worktree',
    description:
      "清理一个受管的隔离 Git Worktree（isolation: 'worktree' 派生的子会话工作区）。按 conversationId 或 worktree 路径定位；工作区含未提交修改或未合入提交时默认拒绝（先检视/合入，或显式 force: true）；可选 deleteBranch: true 一并删除 helm/spawn-* 分支。仅清理 helm 登记的受管 worktree，绝不触碰未登记目录。",
    parameters: cleanupWorktreeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        removed: { type: 'boolean' },
        path: { type: 'string' },
        branch: { type: 'string' },
        nodeId: { type: 'string' },
        branchDeleted: { type: 'boolean' },
      },
      required: ['ok', 'removed', 'path', 'branch', 'nodeId', 'branchDeleted'],
    } as never,
    async execute(args, _api, context) {
      try {
        const result = await allocator.cleanup({
          ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.deleteBranch !== undefined ? { deleteBranch: args.deleteBranch } : {}),
          ...(args.force !== undefined ? { force: args.force } : {}),
          signal: context.abortSignal,
        })
        const summary = result.removed
          ? `已移除受管 worktree ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}）`
          : `受管 worktree ${result.path} 此前已清理（幂等跳过；branch: ${result.branch}）`
        return {
          output: [{ type: 'text', text: summary }],
          structuredOutput: { ok: true, ...result } as never,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `cleanup_worktree 失败：${message}` }],
          isError: true,
        }
      }
    },
  }) as ToolRegistration<typeof cleanupWorktreeParameters, never>
}
