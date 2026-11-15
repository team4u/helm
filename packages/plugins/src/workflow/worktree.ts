/**
 * 跨节点通用 WorktreeAllocator：isolation: 'worktree' 的机制层。
 *
 * 职责（机制与策略分离：本模块只提供受管 worktree 的创建/登记/校验/清理
 * 机制，策略由调用方（原生 spawn、外部运行时插件）决定）：
 * - `allocate`：在目标节点 (EnvFabric envFor) 对源 cwd 执行真实 git 命令
 *   （argv 数组直跑，无 shell quoting，跨 POSIX/Windows 同构），从
 *   `git worktree list --porcelain -z` 的权威登记确定主工作树（从已有
 *   worktree 再派生也定位到真正主仓，绝不以 dirname 猜根、绝不嵌套
 *   .helm-worktrees），在主工作树同级 `.helm-worktrees/<repo>-<shortId>`
 *   建独立 worktree 与 `helm/spawn-<shortId>` 分支（基于记录的
 *   baseCommit 而非易变 HEAD），如实记录源 cwd 的 dirtySource；
 * - `registerExternal`：外部运行时（如 builtin:herdr 的 worktree.create）
 *   回传的 worktree 统一登记（cleanup 只清理已登记记录，绝不碰人类目录）；
 * - `verifyForResume`：resume 续接前经节点真实 fs 探测 + git 探测校验
 *   worktree 仍在（探测失败与目录缺失显式区分，绝不把节点离线/权限/
 *   超时当作缺失）；
 * - `list` / `inspect`：只读检视面（登记列表 + 目标节点真实 git 只读命令
 *   的状态/统计/有上限 diff 预览；仅登记记录可检视，命令固定白名单
 *   `git -C <登记路径>`，不接受任意目录）。检视输出在采集阶段即受限
 *   （绝不无限聚合内存；状态行保留真实总数计数），diff 固定
 *   `--no-ext-diff --no-textconv`（绝不触发用户自定义驱动）且仅覆盖
 *   tracked 改动（untracked 不进 diff、仍见于状态清单）；成功返回的
 *   diff/status 文本与错误诊断同样经 redact 脱敏；
 * - `cleanup`：选择器（worktreeId | conversationId | path[+nodeId]）解析
 *   已登记记录 + 占用检查（子会话运行中/路径被引用拒绝）+ per-repo
 *   canonical git common-dir 串行锁（同仓库不同 worktree 也串行，防
 *   parallel() 抢 .git/config.lock）+ 锁内重读记录、权威 worktree list
 *   的 path/branch/head 归属匹配、realpath canonical 校验（禁止清除主
 *   工作树、拒绝软链跳树、拒绝 locked/prunable/分支被替换的登记路径）+
 *   脏工作区保护（未提交修改或相对主工作树当前 HEAD 未合入提交且未显式
 *   force 时拒绝，external 记录同样检查；状态命令失败显式报错，绝不假
 *   成功）+ 真实 `git worktree remove` / `git branch -d|-D`（分支删除
 *   部分失败先固化 worktree 已 removed 事实，保留 branchDeleted 状态与
 *   诊断、可重试）；目录缺失经节点真实 fs stat 证明时显式
 *   worktree_missing 并保留登记（绝不全仓 prune 他人的登记）；
 *
 * 诚实性纪律：非 Git 仓库、裸仓库/--separate-git-dir 等非常规布局、git
 * 失败、目录缺失均带真实输出显式抛 HelmError，绝不静默降级、绝不伪造
 * fallback 数据、绝不把节点离线/权限/超时当作目录缺失；持久化元数据
 * （路径/分支/仓路径）含已登记机密时显式 worktree_metadata_secret 拒绝
 * 落库（诊断仅用脱敏值）；清理仅针对 docStore 已登记记录，分支名严格
 * 校验 helm/spawn-* | helm/wf-* 前缀（绝不误删人类分支/目录）。
 *
 * 模块拆分（职责单一）：节点侧 git 命令执行 / porcelain 解析 / 路径与
 * 状态计算在 worktree-git.ts（纯函数 + 显式端口）；登记持久化、记录校验
 * 与选择器查询在 worktree-store.ts（WorktreeStore）。本文件只保留核心
 * 状态机：allocate/registerExternal/inspect/verifyForResume/cleanup 的
 * 编排、per-repo 串行锁与策略校验（受管分支前缀、占用与脏工作区保护）。
 */

import type { Context } from '@earendil-works/chord'
import type { ExecutionError, FileError, Result, ShellExecResult } from '@earendil-works/pi-durable/env'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, pathRulesForShape, targetPathShape, type NodePathUsage } from '@helm/protocol'
import {
  canonicalPathOnNode,
  countUnmergedCommits,
  deleteManagedBranch,
  dirExistsOnNode,
  gitExec,
  matchWorktreeEntry,
  normalizePathValue,
  resolveMergeReferenceHead,
  resolveRepoAuthority,
  type GitCapture,
  type GitOkResult,
  type RepoAuthority,
} from './worktree-git.js'
import { WorktreeStore, type ManagedWorktreeRecord } from './worktree-store.js'

/** 单条受管 worktree 记录（登记形状与持久化见 worktree-store.ts）。 */
export type { ManagedWorktreeRecord } from './worktree-store.js'

export interface WorktreeAllocatorDeps {
  /**
   * 目标节点执行端口（allocate/verify/cleanup 的 git 命令经目标节点真实执行）。
   * exec：argv 数组直跑（与原 EnvFabric.exec 同契约——无 shell 解析、
   * onOutput 逐块聚合、timeout 秒）；exists/canonicalPath：节点真实 fs 探测。
   * 插件层用 ctx.host.execEnv + fs RPC 构造（本模块零内核依赖）。
   */
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options: { cwd: string; timeout: number; onOutput: (text: string) => void },
    context: Context,
  ) => Promise<Result<ShellExecResult, ExecutionError>>
  nodeExists: (nodeId: string, path: string, context: Context) => Promise<Result<boolean, FileError>>
  nodeCanonicalPath: (nodeId: string, path: string, context: Context) => Promise<Result<string, FileError>>
  /** 持久化文档存储（get/set 同步；与 PluginDocStore 同契约；原始 JSON 落库不自动脱敏）。 */
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void }
  /** 文本脱敏（git 输出进错误诊断前过一遍；缺省原样）。 */
  redact?: (text: string) => string
  /** 子会话是否仍在运行（cleanup 占用检查；缺省视为不在运行）。 */
  isConversationWorking?: (conversationId: number) => boolean
  /** worktree 路径是否仍被引用（cleanup 占用检查；缺省视为未被引用）。 */
  isPathInUse?: (nodeId: string, path: string) => boolean
  /**
   * 删除前进程占用快照探测（目标节点 cwd/fd 引用 worktree 或其子目录；
   * 路径分量边界匹配——'/a' 不匹配 '/ab'）。必须提供：缺失时 cleanup
   * fail-closed 拒绝（worktree_process_check_failed，不能证明 0 占用就不能
   * 删除）。快照非互斥：扫描后新启动的进程不在保护范围（并发竞争如实
   * 存在）；命中仅拒绝与诊断，绝不自动终止进程。
   */
  inspectPathUsage: (
    nodeId: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<NodePathUsage>
}

export interface AllocateInput {
  nodeId: string
  sourceCwd: string
  parentConversationId: number
  /** 人类可读标签提示（暂未参与命名；预留）。 */
  labelHint?: string
  signal?: AbortSignal
  /**
   * create 副作用（git worktree add）前回调（已在 repo 锁内、机密检查后）：
   * 调用方可在此做持久占位登记（如 durable lease），保证「分配已开始」
   * 这一事实先于任何 Git 副作用落盘；抛错则中止分配（不产生副作用）。
   */
  beforeCreate?: (pending: {
    nodeId: string
    repoRoot: string
    path: string
    branch: string
    baseCommit: string
    dirtySource: boolean
  }) => Promise<void>
}

export interface RegisterExternalInput {
  nodeId: string
  path: string
  branch: string
  parentConversationId: number
  conversationId?: number
  executionId?: string
  /** 外部运行时的源 cwd（repoRoot 未知时先记录，清理时经权威登记解析主工作树）。 */
  sourceCwd?: string
}

export interface CleanupInput {
  /** 受管 worktree 登记 ID（`${nodeId}:${path}`；与 conversationId/path 互斥）。 */
  worktreeId?: string
  conversationId?: number
  /** worktree 绝对路径（多节点同名路径时必须另附 nodeId 消歧）。 */
  path?: string
  /** 目标节点 ID（仅可与 path 搭配）。 */
  nodeId?: string
  /** 指定已合入的目标分支或提交（缺省优先用记录里的 baseBranch，再回退到主工作树 HEAD）。 */
  mergedInto?: string
  deleteBranch?: boolean
  force?: boolean
  signal?: AbortSignal
}

/** 只读检视选择器（与 CleanupInput 同款互斥规则；仅登记记录可检视）。 */
export interface WorktreeInspectInput {
  /** 受管 worktree 登记 ID（`${nodeId}:${path}`；与 conversationId/path 互斥）。 */
  worktreeId?: string
  conversationId?: number
  /** worktree 绝对路径（多节点同名路径时必须另附 nodeId 消歧）。 */
  path?: string
  /** 目标节点 ID（仅可与 path 搭配）。 */
  nodeId?: string
  /** 是否包含 diff 预览（默认包含；登记元数据与统计始终返回）。 */
  diff?: boolean
  signal?: AbortSignal
}

/** 只读检视结果：登记元数据 + 节点真实 git 只读探测（全部有上限）。 */
export interface WorktreeInspectResult {
  /** 登记元数据（与持久记录同构；含已 removed 记录）。 */
  record: ManagedWorktreeRecord
  /** 节点真实 fs 探测：目录是否仍存在（探测失败显式抛错，绝不猜）。 */
  exists: boolean
  /** 无法执行 git 探测的显式原因（登记已清理 / 目录缺失）。 */
  unavailableReason?: 'removed' | 'directory_missing'
  /** 权威当前分支（`git rev-parse --abbrev-ref HEAD`）。 */
  currentBranch?: string
  currentHead?: string
  /** 权威分支与登记分支不一致（工作树可能已被改签/替换）。 */
  branchChanged?: boolean
  /** 未提交/未跟踪文件行（`git status --porcelain` 原行——保留 XY 首列状态码；上限截断）。 */
  dirtyFiles: string[]
  /** 非空状态行真实总数（不因 dirtyFiles 保留上限截断而失真）。 */
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  /** 相对登记 baseCommit 的领先提交数（external 记录无 baseCommit 时缺省）。 */
  commitsAhead?: number
  /** diff 统计摘要（`git diff --stat <base>`；超出采集上限时末尾附截断说明，非完整统计）。 */
  diffStat?: string
  /** diff 预览（有上限截断；仅覆盖 tracked 改动，untracked 文件内容不进 diff、仍完整见于 dirtyFiles）。 */
  diffPreview?: string
  diffTruncated: boolean
  /** diff 基线：登记 baseCommit，或 external 记录退化用的 HEAD。 */
  diffBase: 'baseCommit' | 'HEAD'
}

export interface CleanupResult {
  removed: boolean
  worktreeId: string
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}

/** 允许清理的分支前缀（helm 受管命名空间；绝不碰人类分支）。 */
const MANAGED_BRANCH_PREFIXES = ['helm/spawn-', 'helm/wf-'] as const

/** inspect 未提交文件行上限（超出截断，dirtyFileCount 保留真实计数）。 */
const INSPECT_DIRTY_FILES_LIMIT = 200
/** inspect diff 预览字符上限（超出截断并标记 diffTruncated）。 */
const INSPECT_DIFF_PREVIEW_LIMIT = 16_384
/** inspect diff 统计摘要字符上限（超出时末尾附截断说明，不假装完整）。 */
const INSPECT_DIFF_STAT_LIMIT = 4_096
/** inspect 短探测命令（rev-parse/rev-list）输出上限（截断即显式失败，不把残缺哈希/计数当真值）。 */
const INSPECT_PROBE_LIMIT = 4_096
/** inspect git 失败诊断进入错误消息的字符上限（details.output 同限）。 */
const INSPECT_ERROR_DIAGNOSTIC_LIMIT = 2_000

export class WorktreeAllocator {
  /** per-repo 进程内串行队列尾（键为 canonical git common-dir：同仓库不同 worktree 也串行）。 */
  private readonly repoLocks = new Map<string, Promise<unknown>>()

  private readonly redact: (text: string) => string

  /** 登记持久层（docStore 读写 + 记录校验 + 选择器查询；见 worktree-store.ts）。 */
  private readonly store: WorktreeStore

  constructor(private readonly deps: WorktreeAllocatorDeps) {
    this.redact = deps.redact ?? ((t: string) => t)
    this.store = new WorktreeStore(deps.docStore, this.redact)
  }

  // ------------------------------------------------------------------
  // per-repo mutex（canonical git common-dir）
  // ------------------------------------------------------------------

  /** 同一 (nodeId, canonical common-dir) 的操作串行执行（进程内 Promise 链尾拼接）。 */
  private async withRepoLock<T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>): Promise<T> {
    const key = `${nodeId}\u0000${canonicalCommonDir}`
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
    const { nodeId, sourceCwd, signal } = input
    // Step A：源目录必须是工作树（非 Git 目录与裸仓库显式区分，绝不猜测）。
    const toplevel = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--show-toplevel'], signal)
    if (!toplevel.ok || toplevel.output.trim() === '') {
      const bare = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--is-bare-repository'], signal)
      if (bare.ok && bare.output.trim() === 'true') {
        throw new HelmError(
          'worktree_unsupported_layout',
          `目录 ${sourceCwd}（节点 ${nodeId}）是裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
          400,
          { nodeId, sourceCwd },
        )
      }
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）不是 Git 仓库（git rev-parse --show-toplevel 失败）：\n${toplevel.output.trim()}`,
        400,
        { nodeId, sourceCwd, output: toplevel.output.slice(0, 2000) },
      )
    }
    const sourceToplevel = toplevel.output.trim()
    const bare = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--is-bare-repository'], signal)
    if (bare.ok && bare.output.trim() === 'true') {
      throw new HelmError(
        'worktree_unsupported_layout',
        `目录 ${sourceCwd}（节点 ${nodeId}）位于裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
        400,
        { nodeId, sourceCwd },
      )
    }

    // Step B：权威 repo 信息（主工作树来自 `git worktree list` 首条登记——
    // 从已有隔离 worktree 再派生也定位到真正主仓；锁键为 canonical
    // common-dir，同仓库不同 worktree 的操作同样串行）。
    const authority = await resolveRepoAuthority(this.deps, nodeId, sourceToplevel, signal)

    // Step C：baseCommit 与 dirtySource 取实际 sourceCwd（父隔离工作树已
    // 提交的改动不丢失；不从主工作树取 HEAD）。
    const head = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', 'HEAD'], signal)
    if (!head.ok) {
      throw new HelmError(
        'worktree_failed',
        `读取目录 ${sourceCwd}（节点 ${nodeId}）HEAD 失败：\n${head.output.trim()}`,
        502,
        { nodeId, sourceCwd, output: head.output.slice(0, 2000) },
      )
    }
    const baseCommit = head.output.trim()
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
      throw new HelmError(
        'worktree_failed',
        `目录 ${sourceCwd}（节点 ${nodeId}）HEAD 输出非提交哈希：${JSON.stringify(baseCommit)}`,
        502,
        { nodeId, sourceCwd, head: baseCommit },
      )
    }
    // 源目录当前检出的本地分支（多级派生时即父 Worktree 分支，如
    // 'helm/spawn-12ab34cd'）；detached HEAD（symbolic-ref 非零退出）不记录。
    const symbolic = await gitExec(this.deps, nodeId, sourceCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
    const baseBranch = symbolic.ok && symbolic.output.trim() !== '' ? symbolic.output.trim() : undefined
    const status = await gitExec(this.deps, nodeId, sourceCwd, ['status', '--porcelain'], signal)
    if (!status.ok) {
      throw new HelmError(
        'worktree_failed',
        `读取目录 ${sourceCwd}（节点 ${nodeId}）状态失败：\n${status.output.trim()}`,
        502,
        { nodeId, sourceCwd, output: status.output.slice(0, 2000) },
      )
    }
    const dirtySource = status.output.trim().length > 0

    // Step D：隔离路径与分支名（基于主工作树同级：嵌套派生不反复嵌套
    // .helm-worktrees；路径规则按主工作树自身形状 POSIX/Windows）。
    const pathRules = pathRulesForShape(targetPathShape(authority.mainPath))
    const repoName = pathRules.basename(authority.mainPath).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
    const shortId = randomUUID().replaceAll('-', '').slice(0, 8)
    const branch = `helm/spawn-${shortId}`
    const worktreeBase = pathRules.join(pathRules.dirname(authority.mainPath), '.helm-worktrees')
    const worktreePath = pathRules.join(worktreeBase, `${repoName}-${shortId}`)

    // Step E：机密检查（git worktree add 之前拦截全部将落库的持久字段）。
    this.store.assertMetadataSecretFree(
      {
        repoRoot: authority.mainPath,
        path: worktreePath,
        branch,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
      },
      { nodeId, parentConversationId: input.parentConversationId },
    )

    // Step F：per-repo 串行；worktree add 以记录的 baseCommit 为起点
    //（不追易变 HEAD——锁内创建瞬间主仓 HEAD 可能已被推进）。
    // beforeCreate（若声明）在 git 副作用前执行：持久占位先于树创建落盘。
    return this.withRepoLock(nodeId, authority.canonicalCommonDir, async () => {
      // 锁内从当前活跃登记查找父 Worktree（源目录本身是受管隔离树时
      // 记录其登记 ID，建立多级派生父子关系；多条同路径活跃记录取最新）。
      const parent = this.store
        .records()
        .filter(
          (r) =>
            r.status === 'active' &&
            r.nodeId === nodeId &&
            normalizePathValue(r.path) === normalizePathValue(sourceToplevel),
        )
        .reduce<ManagedWorktreeRecord | undefined>(
          (a, b) => (a === undefined || b.createdAt >= a.createdAt ? b : a),
          undefined,
        )
      const parentWorktreeId = parent?.id
      if (parentWorktreeId !== undefined) {
        this.store.assertMetadataSecretFree({ parentWorktreeId }, { nodeId, parentConversationId: input.parentConversationId })
      }
      if (input.beforeCreate !== undefined) {
        await input.beforeCreate({
          nodeId,
          repoRoot: authority.mainPath,
          path: worktreePath,
          branch,
          baseCommit,
          dirtySource,
        })
      }
      const add = await gitExec(
        this.deps,
        nodeId,
        authority.mainPath,
        ['worktree', 'add', '-b', branch, worktreePath, baseCommit],
        signal,
      )
      if (!add.ok) {
        throw new HelmError(
          'worktree_failed',
          `在仓库 ${authority.mainPath}（节点 ${nodeId}）创建 worktree ${worktreePath} 失败：\n${add.output.trim()}`,
          502,
          { nodeId, repoRoot: authority.mainPath, path: worktreePath, branch, baseCommit, output: add.output.slice(0, 2000) },
        )
      }
      const now = Date.now()
      const record: ManagedWorktreeRecord = {
        id: `${nodeId}:${worktreePath}`,
        nodeId,
        repoRoot: authority.mainPath,
        path: worktreePath,
        branch,
        baseCommit,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
        ...(parentWorktreeId !== undefined ? { parentWorktreeId } : {}),
        dirtySource,
        parentConversationId: input.parentConversationId,
        origin: 'native',
        status: 'active',
        createdAt: now,
      }
      // 登记持久化失败：如实报 worktree_register_failed 并保留已创建资源
      // 坐标（不擅自回收——调用方可能已基于该 worktree 派生子会话）。
      try {
        this.store.append(record)
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        throw new HelmError(
          'worktree_register_failed',
          `worktree ${worktreePath}（分支 ${branch}，节点 ${nodeId}）已创建，但登记持久化失败（资源坐标保留在 details，未擅自回收；请人工核对后清理或重新登记）：${cause}`,
          502,
          { nodeId, repoRoot: this.redact(authority.mainPath), path: this.redact(worktreePath), branch, baseCommit, cause },
        )
      }
      return record
    })
  }

  // ------------------------------------------------------------------
  // 登记 / 查询
  // ------------------------------------------------------------------

  /** 子会话创建后把 conversationId 关联写回记录。 */
  bindConversation(worktreePath: string, nodeId: string, conversationId: number): void {
    const id = `${nodeId}:${worktreePath}`
    const existing = this.store.findById(id)
    if (existing === undefined) {
      throw new HelmError(
        'not_found',
        `受管 worktree 记录 ${id} 不存在，无法绑定会话 ${conversationId}`,
        404,
        { id, conversationId },
      )
    }
    this.store.updateRecord(id, (r) => ({ ...r, conversationId }))
  }

  /** 外部运行时（如 builtin:herdr）回传 worktree 时统一登记/更新（同 (nodeId,path) 去重）。 */
  registerExternal(input: RegisterExternalInput): ManagedWorktreeRecord {
    const id = `${input.nodeId}:${input.path}`
    this.store.assertMetadataSecretFree(
      { path: input.path, branch: input.branch, repoRoot: input.sourceCwd ?? '', nodeId: input.nodeId, executionId: input.executionId ?? '' },
      { nodeId: this.redact(input.nodeId), parentConversationId: input.parentConversationId, conversationId: input.conversationId, executionId: input.executionId !== undefined ? this.redact(input.executionId) : undefined },
    )
    const existing = this.store.findById(id)
    if (existing !== undefined) {
      const updated: ManagedWorktreeRecord = {
        ...existing,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      }
      this.store.updateRecord(id, () => updated)
      return updated
    }
    // 机密检查：docStore 原始 JSON 落库不自动脱敏，含已登记 secret 的
    // 路径/分支/仓路径显式拒绝（诊断仅用脱敏值 + 非机密定位字段，绝不
    // raw 落库；拒绝时尚未登记，不产生任何 onResolved 副作用）。
    const record: ManagedWorktreeRecord = {
      id,
      nodeId: input.nodeId,
      // 外部运行时可能不回传主仓路径：先记 sourceCwd（清理时经权威登记解析）。
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
    this.store.append(record)
    return record
  }

  /** 查询会话当前绑定的受管 worktree（最新优先；无绑定返回 undefined）。 */
  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.store.getForConversation(conversationId)
  }

  /** 全部登记记录（新建在前；含已 removed，供只读检视/列表消费）。 */
  list(): ManagedWorktreeRecord[] {
    return this.store.list()
  }

  /**
   * 按 worktreeId / 会话 / 路径（可附 nodeId 消歧）查询 active 记录。
   * 同一路径在多个节点有 active 登记且未指定 nodeId 时显式 validation_error
   * （绝不任选首条静默清理别的节点）。
   */
  findActive(query: { worktreeId?: string; conversationId?: number; path?: string; nodeId?: string }): ManagedWorktreeRecord | undefined {
    return this.store.findActive(query)
  }

  // ------------------------------------------------------------------
  // inspect（只读检视：登记元数据 + 节点真实 git 只读探测）
  // ------------------------------------------------------------------

  /**
   * 只读检视一个受管 worktree：登记元数据 + 在目标节点真实执行的 git 只读
   * 命令（全部 `git -C <登记路径>`，命令固定白名单，不接受任意目录/cwd）。
   * - 目录存在性仅由节点真实 fs 探测证明；探测失败 fail closed 抛
   *   worktree_check_failed（节点离线/权限/超时不当作缺失）；
   * - 已 removed 登记或目录缺失：返回元数据 + unavailableReason，不跑 git；
   * - git 命令失败（非零退出/超时）显式 worktree_check_failed 并附截断的
   *   真实输出诊断（经 redact 脱敏）；绝不伪造空统计、绝不当作成功；
   * - 受限采集：diff 预览/统计/状态清单在 onOutput 阶段即限内存（不完整
   *   聚合后 slice）；diff 超上限置 diffTruncated、统计末尾附截断说明，
   *   状态行保留 XY 首列原行且 dirtyFileCount 始终为真实总数；
   * - diff 固定 `--no-ext-diff --no-textconv`（受管只读检视绝不触发用户
   *   自定义 diff/textconv 驱动）；仅覆盖 tracked 改动（基线为登记
   *   baseCommit，external 记录退化 HEAD；基线失效显式报错、无 fallback），
   *   untracked 文件内容不进 diff、仍完整见于 dirtyFiles/dirtyFileCount；
   * - 成功返回的分支/哈希/状态行/diff 文本与错误诊断同样经 redact 脱敏
   *   （与项目既有机密约定一致，不因检视面绕过）。
   */
  async inspect(input: WorktreeInspectInput, signal?: AbortSignal): Promise<WorktreeInspectResult> {
    if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
      throw new HelmError('validation_error', 'inspect 需提供 worktreeId、conversationId 或 path 之一', 400)
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

    const record = this.store.resolveInspectRecord(input)
    const diffBase: WorktreeInspectResult['diffBase'] = record.baseCommit !== '' ? 'baseCommit' : 'HEAD'
    const metadata: Pick<WorktreeInspectResult, 'record' | 'diffBase'> = { record, diffBase }
    if (record.status === 'removed') {
      return {
        ...metadata,
        exists: false,
        unavailableReason: 'removed',
        dirtyFiles: [],
        dirtyFileCount: 0,
        dirtyFilesTruncated: false,
        diffTruncated: false,
      }
    }
    if (!(await dirExistsOnNode(this.deps, record.nodeId, record.path))) {
      return {
        ...metadata,
        exists: false,
        unavailableReason: 'directory_missing',
        dirtyFiles: [],
        dirtyFileCount: 0,
        dirtyFilesTruncated: false,
        diffTruncated: false,
      }
    }

    const run = async (args: readonly string[], capture?: GitCapture): Promise<GitOkResult> => {
      const result = await gitExec(this.deps, record.nodeId, record.path, ['-C', record.path, ...args], signal, capture)
      if (!result.ok) {
        const diagnostic = result.output.trim().slice(0, INSPECT_ERROR_DIAGNOSTIC_LIMIT)
        const cut =
          result.output.trim().length > INSPECT_ERROR_DIAGNOSTIC_LIMIT || result.truncated
            ? '…（诊断已截断）'
            : ''
        throw new HelmError(
          'worktree_check_failed',
          `无法在节点 ${record.nodeId} 只读检视 worktree '${record.path}'（git ${args[0]} 失败，检视中止）：\n${diagnostic}${cut}`,
          502,
          { worktreeId: record.id, path: record.path, nodeId: record.nodeId, output: result.output.slice(0, INSPECT_ERROR_DIAGNOSTIC_LIMIT) },
        )
      }
      return result
    }
    /** 短探测命令（rev-parse/rev-list）取完整输出：受限采集下截断即显式失败，绝不把残缺哈希/计数当真值。 */
    const probe = async (args: readonly string[]): Promise<string> => {
      const result = await run(args, { kind: 'chars', limit: INSPECT_PROBE_LIMIT })
      if (result.truncated) {
        throw new HelmError(
          'worktree_check_failed',
          `检视探测命令 git ${args.join(' ')} 输出超出采集上限（${INSPECT_PROBE_LIMIT} 字符），结果不可信，检视中止`,
          502,
          { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
        )
      }
      return result.output.trim()
    }

    const branch = await probe(['rev-parse', '--abbrev-ref', 'HEAD'])
    const head = await probe(['rev-parse', 'HEAD'])
    // 状态清单：流式按行受限采集——保留前 200 条原行（含 XY 首列，不 trim），
    // 非空行总数为真实值（不因保留上限截断而失真 dirtyFileCount）。
    const statusResult = await run(['status', '--porcelain', '--untracked-files=all'], {
      kind: 'lines',
      maxLines: INSPECT_DIRTY_FILES_LIMIT,
    })

    let commitsAhead: number | undefined
    if (record.baseCommit !== '') {
      const aheadRaw = await probe(['rev-list', '--count', `${record.baseCommit}..${head}`])
      const ahead = Number.parseInt(aheadRaw, 10)
      if (!Number.isFinite(ahead)) {
        throw new HelmError(
          'worktree_check_failed',
          `检视无法解析领先提交数（git rev-list --count 输出 ${JSON.stringify(this.redact(aheadRaw))}，检视中止）`,
          502,
          { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
        )
      }
      commitsAhead = ahead
    }
    const diffRef = record.baseCommit !== '' ? record.baseCommit : 'HEAD'
    // diff 固定禁用外部 diff 驱动与 textconv 过滤器（受管只读检视绝不触发
    // 用户自定义驱动）；仅覆盖 tracked 改动，untracked 内容不进 diff。
    const statResult = await run(['diff', '--no-ext-diff', '--no-textconv', '--stat', diffRef], {
      kind: 'chars',
      limit: INSPECT_DIFF_STAT_LIMIT,
    })
    let diffStat: string | undefined
    const statText = statResult.output.trim()
    if (statText !== '') {
      // 统计被采集上限截断时末尾附文字说明，不假装完整统计。
      diffStat =
        this.redact(statText) +
        (statResult.truncated ? `\n…（diff 统计超出检视上限 ${INSPECT_DIFF_STAT_LIMIT} 字符已截断，非完整统计）` : '')
    }

    let diffPreview: string | undefined
    let diffTruncated = false
    if (input.diff !== false) {
      const diffResult = await run(['diff', '--no-ext-diff', '--no-textconv', diffRef], {
        kind: 'chars',
        limit: INSPECT_DIFF_PREVIEW_LIMIT,
      })
      diffTruncated = diffResult.truncated
      diffPreview = diffResult.output === '' ? undefined : this.redact(diffResult.output)
    }

    return {
      ...metadata,
      exists: true,
      currentBranch: this.redact(branch),
      currentHead: this.redact(head),
      ...(branch !== record.branch ? { branchChanged: true } : {}),
      dirtyFiles: statusResult.lines.map((line) => this.redact(line)),
      dirtyFileCount: statusResult.totalNonEmptyLines,
      dirtyFilesTruncated: statusResult.truncated,
      ...(commitsAhead !== undefined ? { commitsAhead } : {}),
      ...(diffStat !== undefined ? { diffStat } : {}),
      ...(diffPreview !== undefined ? { diffPreview } : {}),
      diffTruncated,
    }
  }

  // ------------------------------------------------------------------
  // resume 校验
  // ------------------------------------------------------------------

  /**
   * resume 续接校验：cwd 冲突显式拒绝（不中途搬家）；记录已清理或目录缺失
   * 显式 worktree_missing（目录缺失经节点真实 fs stat 证明；节点离线/
   * 权限/超时等探测失败显式 worktree_check_failed，绝不当作缺失）。
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
    if (!(await dirExistsOnNode(this.deps, record.nodeId, record.path))) {
      throw new HelmError(
        'worktree_missing',
        `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）`,
        409,
        { path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    const probe = await gitExec(
      this.deps,
      record.nodeId,
      record.path,
      ['-C', record.path, 'rev-parse', '--is-inside-work-tree'],
      signal,
    )
    if (!probe.ok) {
      throw new HelmError(
        'worktree_check_failed',
        `无法确认 worktree '${record.path}'（节点 ${record.nodeId}）仍是 Git 工作树（不当作缺失，续接中止）：\n${probe.output.trim()}`,
        502,
        { path: record.path, branch: record.branch, nodeId: record.nodeId, output: probe.output.slice(0, 2000) },
      )
    }
    if (probe.output.trim() !== 'true') {
      throw new HelmError(
        'worktree_missing',
        `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）已不是 Git 工作树（可能已被替换）`,
        409,
        { path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    return record
  }

  // ------------------------------------------------------------------
  // cleanup
  // ------------------------------------------------------------------

  /** 归属不匹配的显式拒绝（登记路径上的工作树已被替换/挪用，force 也不可越过）。 */
  private ownerMismatch(record: ManagedWorktreeRecord, reason: string, detail: string, extra?: Record<string, unknown>): HelmError {
    return new HelmError(
      'worktree_owner_mismatch',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）${detail}（reason: ${reason}）：登记路径上的工作树已不归属本记录，拒绝清理（force 也不可越过归属校验）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId, reason, ...extra },
    )
  }

  /**
   * 删除前进程占用快照检查（per-repo 锁内、真实 git worktree remove 前的
   * 最后一道屏障；force 不可绕过）：
   * - 探测端口缺失 / 探测失败（节点离线、守护进程版本不支持、平台不支持、
   *   权限、超时）→ worktree_process_check_failed（不能证明 0 占用就不能
   *   删除，绝不静默跳过、绝不当作干净）；
   * - 无命中的不完整快照最多复查两次（进程 exec/退出期间可能瞬时拒读）；
   *   只有新的完整零占用快照可放行，持续不完整仍携带 diagnostics 拒绝；
   * - 命中（cwd / 打开 fd 引用 worktree 或其子目录）→ worktree_process_in_use
   *   （409，含 PID/进程名/引用路径，路径与诊断均经 redact 脱敏；进程名
   *   与 PID 非机密）；只诊断与拒绝，绝不自动 kill/发键；命中且快照同时
   *   不完整时仍报 in_use（占用事实已成立），details 附 complete 状态。
   * 快照是删除前一次性观测而非跨进程互斥：扫描之后新启动的进程不在
   * 保护范围（并发竞争如实存在，由调用方文档口径承担）。
   */
  private async assertPathUnusedByProcesses(record: ManagedWorktreeRecord, signal?: AbortSignal): Promise<void> {
    const probe = this.deps.inspectPathUsage
    if (probe === undefined) {
      throw new HelmError(
        'worktree_process_check_failed',
        `worktree '${record.path}'（节点 ${record.nodeId}）未装配进程占用探测端口，无法证明无进程占用，清理中止（force 也不可绕过）`,
        502,
        { worktreeId: record.id, path: this.redact(record.path), nodeId: record.nodeId },
      )
    }
    let usage: NodePathUsage
    try {
      usage = await probe(record.nodeId, record.path, signal)
      // /proc 的 exec/退出窗口可能短暂拒读；复查必须重新取得完整快照，
      // 不能凭重试次数、进程身份或延时把未知占用当作安全。实际命中立即拒绝。
      for (
        let attempt = 0;
        attempt < 2 && usage.complete !== true && usage.matchedTotal === 0 && usage.processes.length === 0;
        attempt += 1
      ) {
        await delay(25 * (attempt + 1), undefined, { signal })
        usage = await probe(record.nodeId, record.path, signal)
      }
    } catch (error) {
      const cause = error instanceof HelmError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
      throw new HelmError(
        'worktree_process_check_failed',
        `无法完成 worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描（${this.redact(cause)}），不能证明 0 占用，清理中止（force 也不可绕过）`,
        502,
        { worktreeId: record.id, nodeId: record.nodeId, path: this.redact(record.path), cause: this.redact(cause) },
      )
    }
    if (usage.matchedTotal > 0 || usage.processes.length > 0) {
      const shown = usage.processes.map((p) => `${p.pid}${p.name !== undefined ? `(${p.name})` : ''}`)
      throw new HelmError(
        'worktree_process_in_use',
        `worktree '${record.path}'（节点 ${record.nodeId}）被 ${usage.matchedTotal} 个进程的工作目录或打开文件引用（${shown.join('、')}${usage.matchedTotal > shown.length ? ` 等 ${usage.matchedTotal} 个` : ''}${usage.processesTruncated ? '；清单截断' : ''}）；这是删除前快照，不会自动终止任何进程，请先在目标节点处理后再清理（force 也不可绕过）`,
        409,
        {
          worktreeId: record.id,
          path: this.redact(record.path),
          nodeId: record.nodeId,
          pids: usage.processes.map((p) => p.pid),
          processes: usage.processes.map((p) => ({
            pid: p.pid,
            ...(p.name !== undefined ? { name: p.name } : {}),
            source: p.source,
            path: this.redact(p.path),
          })),
          matchedTotal: usage.matchedTotal,
          processesTruncated: usage.processesTruncated,
          complete: usage.complete,
        },
      )
    }
    if (usage.complete !== true) {
      throw new HelmError(
        'worktree_process_check_failed',
        `worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描不完整（${usage.diagnostics.map((d) => this.redact(d)).join('；') || '原因未知'}），不能证明 0 占用，清理中止（force 也不可绕过）`,
        502,
        {
          worktreeId: record.id,
          nodeId: record.nodeId,
          path: this.redact(record.path),
          diagnostics: usage.diagnostics.map((d) => this.redact(d)),
        },
      )
    }
  }

  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    // 选择器校验：worktreeId 单用；conversationId/path 择一；nodeId 仅搭 path。
    if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
      throw new HelmError('validation_error', 'cleanup 需提供 worktreeId、conversationId 或 path 之一', 400)
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
    // mergedInto 严格形状校验（argv 直跑无 shell 注入面，但必须拒绝范围
    // 操作符与以 - 开头的值，防止意外解析成其他引用或选项）。
    if (input.mergedInto !== undefined) {
      if (
        typeof input.mergedInto !== 'string' ||
        input.mergedInto === '' ||
        /[\s\u0000-\u001f]/.test(input.mergedInto) ||
        input.mergedInto.includes('..') ||
        input.mergedInto.includes('~') ||
        input.mergedInto.includes('^') ||
        input.mergedInto.includes(':') ||
        input.mergedInto.startsWith('-')
      ) {
        throw new HelmError(
          'validation_error',
          `mergedInto 必须是不含空白与范围操作符（.. ~ ^ :）且不以 - 开头的非空分支/提交名`,
          400,
          { mergedInto: input.mergedInto },
        )
      }
    }

    const record = this.store.resolveCleanupRecord(input)
    if (!MANAGED_BRANCH_PREFIXES.some((prefix) => record.branch.startsWith(prefix))) {
      throw new HelmError(
        'validation_error',
        `受管 worktree '${record.path}' 的分支 '${record.branch}' 不在 helm 受管前缀（helm/spawn- | helm/wf-）内，拒绝清理`,
        400,
        { path: record.path, branch: record.branch },
      )
    }

    // 幂等：已清理记录直接 removed:false；分支删除曾部分失败且本次要求
    // deleteBranch 时可重试（branchDeleted 状态与诊断保留在记录上）。
    if (record.status === 'removed') {
      let branchDeleted = record.branchDeleted === true
      if (input.deleteBranch === true && !branchDeleted) {
        if (record.repoRoot === '') {
          throw new HelmError(
            'branch_delete_failed',
            `记录 ${record.id} 缺少主仓路径，无法重试删除分支 ${record.branch}（请人工核对）`,
            502,
            { worktreeId: record.id, branch: record.branch },
          )
        }
        const authority = await resolveRepoAuthority(this.deps, record.nodeId, record.repoRoot, input.signal)
        await this.withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
          // 与主路径同规则解析「已合入」参考（显式 mergedInto 优先，不存在
          // 显式拒绝；其次 baseBranch；再主 HEAD）；确认已全部合入时统一 -D
          // 删除（参考非 main 时 git branch -d 的上游合入检查会拒绝）。
          const referenceHead = await resolveMergeReferenceHead(
            this.deps,
            record.nodeId,
            authority.mainPath,
            authority.entries[0]!.head,
            input.mergedInto,
            record.baseBranch,
            input.signal,
          )
          const mergedIntoReference =
            (await countUnmergedCommits(this.deps, record.nodeId, authority.mainPath, referenceHead, record.branch, input.signal)) === 0
          const del = await deleteManagedBranch(
            this.deps,
            record.nodeId,
            authority.mainPath,
            record.branch,
            input.force === true || mergedIntoReference,
            input.signal,
          )
          branchDeleted = del.deleted
          if (del.deleted) {
            this.store.updateRecord(record.id, (r) => {
              const { branchDeleteError: _previousError, ...clean } = r
              return { ...clean, branchDeleted: true }
            })
          } else {
            this.store.updateRecord(record.id, (r) => ({ ...r, branchDeleted: false, branchDeleteError: (del.failureOutput ?? '').slice(0, 2000) }))
            throw new HelmError(
              'branch_delete_failed',
              `重试删除分支 ${record.branch} 失败（登记保持 removed，可再次重试）：\n${(del.failureOutput ?? '').trim()}`,
              502,
              { worktreeId: record.id, branch: record.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
            )
          }
        })
      }
      return { removed: false, worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId, branchDeleted }
    }

    // 占用检查（锁外快速失败；锁内还会以最新记录复查）。
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

    // 目录存在性证明：仅节点真实 fs stat（或后续权威 worktree 登记）可证明
    // 缺失；探测失败 fail closed。缺失时显式 worktree_missing 并保留登记
    //（绝不全仓 prune 其他节点的登记，也绝不假成功）。
    if (!(await dirExistsOnNode(this.deps, record.nodeId, record.path))) {
      throw new HelmError(
        'worktree_missing',
        `受管 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）；登记保留，请人工核对后处理（不自动 prune）`,
        409,
        { worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }

    // 权威 repo 信息（external 记录首次清理时解析并持久化主工作树）。
    let authority: RepoAuthority
    if (record.repoRoot !== '') {
      authority = await resolveRepoAuthority(this.deps, record.nodeId, record.repoRoot, input.signal)
    } else {
      authority = await resolveRepoAuthority(this.deps, record.nodeId, record.path, input.signal)
      this.store.assertMetadataSecretFree({ repoRoot: authority.mainPath }, { nodeId: record.nodeId, executionId: record.executionId })
      this.store.updateRecord(record.id, (r) => ({ ...r, repoRoot: authority.mainPath }))
    }

    let outcome: { removed: boolean; branchDeleted: boolean } | undefined
    await this.withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
      // 锁内以最新记录为准（并发清理/状态变更在此收敛）。
      const fresh = this.store.findById(record.id)
      if (fresh === undefined) {
        throw new HelmError('not_found', `受管 worktree 记录 ${record.id} 不存在（文档状态不一致）`, 404, { id: record.id })
      }
      if (fresh.status === 'removed') {
        outcome = { removed: false, branchDeleted: fresh.branchDeleted === true }
        return
      }
      // 在用复查（锁内最新事实；force 不可越过）。
      if (fresh.conversationId !== undefined && this.deps.isConversationWorking?.(fresh.conversationId) === true) {
        throw new HelmError(
          'worktree_in_use',
          `worktree '${fresh.path}' 关联的子代理仍在运行中，拒绝清理`,
          409,
          { path: fresh.path, conversationId: fresh.conversationId },
        )
      }
      if (this.deps.isPathInUse?.(fresh.nodeId, fresh.path) === true) {
        throw new HelmError(
          'worktree_in_use',
          `worktree '${fresh.path}'（节点 ${fresh.nodeId}）仍被引用，拒绝清理`,
          409,
          { path: fresh.path, nodeId: fresh.nodeId },
        )
      }

      // 锁内重新取证权威登记，做 path/branch/head 归属匹配。
      const locked = await resolveRepoAuthority(this.deps, fresh.nodeId, fresh.repoRoot !== '' ? fresh.repoRoot : fresh.path, input.signal)
      const entries = locked.entries
      const mainEntry = entries[0]!
      const match = matchWorktreeEntry(entries, fresh.path)
      if (match === undefined) {
        throw this.ownerMismatch(
          fresh,
          'not_in_worktree_list',
          `不在权威 worktree 登记中（目录仍存在：路径上的内容已不受本仓库管理）`,
          { registeredEntries: entries.map((e) => this.redact(e.path)).slice(0, 20) },
        )
      }
      if (match === mainEntry || normalizePathValue(match.path) === normalizePathValue(mainEntry.path)) {
        throw this.ownerMismatch(fresh, 'main_worktree', '指向主工作树（主工作树绝不清除）', { mainPath: this.redact(mainEntry.path) })
      }
      if (match.locked) {
        // locked 是所有者显式加锁：force 只能越过 dirty/unmerged，不可越过。
        throw new HelmError(
          'worktree_locked',
          `worktree '${fresh.path}'（节点 ${fresh.nodeId}）已被 git worktree lock 锁定${match.lockedReason !== undefined ? `（${this.redact(match.lockedReason)}）` : ''}，拒绝清理（请先解锁）`,
          409,
          { worktreeId: fresh.id, path: fresh.path, nodeId: fresh.nodeId, ...(match.lockedReason !== undefined ? { lockedReason: this.redact(match.lockedReason) } : {}) },
        )
      }
      if (match.prunable) {
        throw this.ownerMismatch(
          fresh,
          'prunable',
          `的 gitdir 链接已断（${match.prunableReason !== undefined ? this.redact(match.prunableReason) : 'prunable'}：登记路径上的目录可能已被替换）`,
        )
      }
      if (match.branch !== `refs/heads/${fresh.branch}`) {
        throw this.ownerMismatch(
          fresh,
          'branch_changed',
          `的权威登记分支为 ${match.branch ?? (match.detached ? 'detached' : '未知')}，与登记分支 ${fresh.branch} 不一致（工作树可能已被用户替换或改签分支）`,
          { authorityBranch: this.redact(match.branch ?? '') },
        )
      }
      if (match.head === '' || /^0+$/.test(match.head)) {
        throw this.ownerMismatch(fresh, 'head_unreadable', '的权威登记 HEAD 缺失（工作树状态不可信）', { authorityHead: match.head })
      }

      // realpath canonical 校验：登记路径不得经软链跳到主工作树或其他工作树。
      const canonicalRecord = await canonicalPathOnNode(this.deps, fresh.nodeId, fresh.path)
      const canonicalMain = await canonicalPathOnNode(this.deps, fresh.nodeId, mainEntry.path)
      if (canonicalRecord === canonicalMain) {
        throw this.ownerMismatch(fresh, 'main_worktree', `经真实路径解析指向主工作树 ${this.redact(mainEntry.path)}`, {
          mainPath: this.redact(mainEntry.path),
        })
      }
      for (const other of entries) {
        if (other === match) continue
        const canonicalOther = await canonicalPathOnNode(this.deps, fresh.nodeId, other.path)
        if (canonicalRecord === canonicalOther) {
          throw this.ownerMismatch(
            fresh,
            'symlink_redirect',
            `经真实路径解析指向其他工作树 ${this.redact(other.path)}（登记路径可能已被软链替换）`,
            { redirectedTo: this.redact(other.path) },
          )
        }
      }

      // 脏工作区保护（force=false；external 记录同样检查；合入参考优先
      // 显式 mergedInto，其次记录 baseBranch，再主工作树 HEAD——不以
      // baseCommit 缺失为由跳过）。ignored 文件也计入：实测 git worktree remove 无
      // --force 也会删除仅含 ignored 内容（.env 等）的 worktree，默认检查
      // 必须显式拦下（force 允许显式清除）。状态命令失败显式报错，绝不
      // 当作干净或目录缺失。
      let dirtyFiles: string[] = []
      let unmergedCommits = 0
      if (input.force !== true) {
        const status = await gitExec(
          this.deps,
          fresh.nodeId,
          fresh.path,
          ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
          input.signal,
        )
        if (!status.ok) {
          throw new HelmError(
            'worktree_check_failed',
            `无法确认 worktree '${fresh.path}' 的工作区状态（git status 失败；绝不当作干净或目录缺失，清理中止）：\n${status.output.trim()}`,
            502,
            { worktreeId: fresh.id, path: fresh.path, output: status.output.slice(0, 2000) },
          )
        }
        dirtyFiles = status.output
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        const referenceHead = await resolveMergeReferenceHead(
          this.deps,
          fresh.nodeId,
          locked.mainPath,
          mainEntry.head,
          input.mergedInto,
          fresh.baseBranch,
          input.signal,
        )
        unmergedCommits = await countUnmergedCommits(this.deps, fresh.nodeId, locked.mainPath, referenceHead, fresh.branch, input.signal)
        if (dirtyFiles.length > 0 || unmergedCommits > 0) {
          throw new HelmError(
            'worktree_dirty',
            `worktree '${fresh.path}' (branch: ${fresh.branch}) 含未提交修改、未跟踪/被忽略文件或未合入提交（相对参考提交 ${referenceHead}）；请先检视/合入，或显式传 force: true 强制清理`,
            409,
            { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, dirtyFiles: dirtyFiles.slice(0, 200), unmergedCommits, referenceHead },
          )
        }
      }

      // 删除前进程占用快照（per-repo 锁内、真实 remove 前的最后一道屏障；
      // force 不可绕过——force 只授权丢弃文件，不授权拆除运行中进程脚下的
      // 目录）。只诊断与拒绝，绝不自动终止进程。
      await this.assertPathUnusedByProcesses(fresh, input.signal)

      // 真实移除（不 prune、不猜测缺失；失败显式报错）。
      const remove = await gitExec(
        this.deps,
        fresh.nodeId,
        locked.mainPath,
        ['worktree', 'remove', ...(input.force === true ? ['--force'] : []), fresh.path],
        input.signal,
      )
      if (!remove.ok) {
        throw new HelmError(
          'worktree_remove_failed',
          `移除 worktree '${fresh.path}'（节点 ${fresh.nodeId}）失败：\n${remove.output.trim()}`,
          502,
          { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: remove.output.slice(0, 2000) },
        )
      }

      // 分支删除：锁内已确认相对 referenceHead 全部合入（unmergedCommits
      // === 0；force 路径恒为 0）或显式 force 时统一 -D——referenceHead 非
      // main 时 git branch -d 的上游/HEAD 合入检查不认参考，会拒绝实际已
      // 合入的分支。部分失败先固化 worktree 已 removed 事实（branchDeleted
      // 状态与诊断保留，可重试），再显式报错——绝不把已消失的树永远留在
      // active，也不掩盖分支删除失败。
      let branchDeleted = false
      if (input.deleteBranch === true) {
        const del = await deleteManagedBranch(
          this.deps,
          fresh.nodeId,
          locked.mainPath,
          fresh.branch,
          input.force === true || unmergedCommits === 0,
          input.signal,
        )
        branchDeleted = del.deleted
        if (!del.deleted) {
          this.store.updateRecord(fresh.id, (r) => ({
            ...r,
            status: 'removed' as const,
            removedAt: Date.now(),
            branchDeleted: false,
            branchDeleteError: (del.failureOutput ?? '').slice(0, 2000),
          }))
          throw new HelmError(
            'branch_delete_failed',
            `worktree '${fresh.path}' 已移除，但删除分支 ${fresh.branch} 失败（登记已置 removed，可重试 cleanup 传 deleteBranch:true）：\n${(del.failureOutput ?? '').trim()}`,
            502,
            { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
          )
        }
      }
      this.store.updateRecord(fresh.id, (r) => {
        if (input.deleteBranch !== true) return { ...r, status: 'removed' as const, removedAt: Date.now() }
        const { branchDeleteError: _previousError, ...clean } = r
        return { ...clean, status: 'removed' as const, removedAt: Date.now(), branchDeleted: true }
      })
      outcome = { removed: true, branchDeleted }
    })

    const result = outcome
    if (result === undefined) {
      throw new HelmError('worktree_check_failed', '清理未产生结果（内部状态不一致）', 500, { worktreeId: record.id })
    }
    return {
      removed: result.removed,
      worktreeId: record.id,
      path: record.path,
      branch: record.branch,
      nodeId: record.nodeId,
      branchDeleted: result.branchDeleted,
    }
  }
}
