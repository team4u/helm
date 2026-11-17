/**
 * 跨节点通用 WorktreeAllocator：isolation: 'worktree' 的机制层门面。
 *
 * 职责（机制与策略分离：本模块族只提供受管 worktree 的创建/登记/校验/清理
 * 机制，策略由调用方（原生 spawn、外部运行时插件）决定）：
 * - `allocate`：在目标节点 (EnvFabric envFor) 对源 cwd 执行真实 git 命令
 *   （argv 数组直跑，无 shell quoting，跨 POSIX/Windows 同构），从
 *   `git worktree list --porcelain -z` 的权威登记确定主工作树（从已有
 *   worktree 再派生也定位到真正主仓，绝不以 dirname 猜根、绝不嵌套
 *   .helm-worktrees），在主工作树同级 `.helm-worktrees/<repo>-<shortId>`
 *   建独立 worktree 与 `helm/spawn-<shortId>` 分支（基于记录的 baseCommit
 *   而非易变 HEAD），如实记录源 cwd 的 dirtySource；
 * - `registerExternal`：外部运行时（如 builtin:herdr 的 worktree.create）
 *   回传的 worktree 统一登记（cleanup 只清理已登记记录，绝不碰人类目录）；
 * - `inspect` / `verifyForResume` / `cleanup`：门面转发（实现与行为契约见
 *   worktree-inspect.ts / worktree-cleanup.ts）。
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
 * 与选择器查询在 worktree-store.ts（WorktreeStore）；只读检视与 resume
 * 续接校验在 worktree-inspect.ts；清理状态机与进程占用快照检查在
 * worktree-cleanup.ts。本文件只保留核心门面：allocate / registerExternal /
 * 登记/查询转发、per-repo 串行锁与策略校验（受管分支前缀、机密检查）。
 */
import type { Context } from '@earendil-works/chord/context'
import type { ExecutionError, FileError, Result, ShellExecResult } from '@earendil-works/pi-durable/env'
import { randomUUID } from 'node:crypto'
import { HelmError, pathRulesForShape, targetPathShape, type NodePathUsage } from '@helm/protocol'
import { gitExec, normalizePathValue, resolveRepoAuthority } from './worktree-git.js'
import { WorktreeStore, type ManagedWorktreeRecord } from './worktree-store.js'
import {
  inspectWorktree,
  verifyWorktreeForResume,
  type WorktreeInspectInput,
  type WorktreeInspectResult,
} from './worktree-inspect.js'
import { cleanupWorktree } from './worktree-cleanup.js'

/** 单条受管 worktree 记录与持久持有锁契约（登记形状与持久化见 worktree-store.ts）。 */
export type { ManagedWorktreeHold, ManagedWorktreeRecord } from './worktree-store.js'
/** 只读检视契约（受限采集/脱敏/命令白名单纪律见 worktree-inspect.ts）。 */
export type { WorktreeInspectInput, WorktreeInspectResult } from './worktree-inspect.js'

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

export interface CleanupResult {
  removed: boolean
  worktreeId: string
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}

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

  /** 预校验 hold 元数据合法性与机密边界（在产生 git 副作用前调用）。 */
  prepareHold(
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ) {
    return this.store.prepareHold(hold, identity)
  }

  /** 对已登记的活跃 worktree 写入持久持有锁（label 经 redact 脱敏与机密复核）。 */
  setHold(
    worktreeId: string,
    hold: { pluginId: string; holdId: string; label: string; acquiredAt?: number },
    identity: Record<string, string | number | undefined> = {},
  ): ManagedWorktreeRecord {
    return this.store.setHold(worktreeId, hold, identity)
  }

  /** 释放持久持有锁（缺失/无锁幂等返 false；归属不一致抛 409 worktree_hold_mismatch）。 */
  releaseHold(worktreeId: string, pluginId: string, holdId: string): boolean {
    return this.store.releaseHold(worktreeId, pluginId, holdId)
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
  // inspect / resume 校验 / cleanup（实现见 worktree-inspect.ts 与 worktree-cleanup.ts）
  // ------------------------------------------------------------------

  /** 只读检视（受限采集/脱敏/白名单纪律见 worktree-inspect.ts inspectWorktree）。 */
  async inspect(input: WorktreeInspectInput, signal?: AbortSignal): Promise<WorktreeInspectResult> {
    return inspectWorktree(this.deps, this.store, this.redact, input, signal)
  }

  /** resume 续接校验（探测失败与目录缺失显式区分；见 worktree-inspect.ts verifyWorktreeForResume）。 */
  async verifyForResume(
    record: ManagedWorktreeRecord,
    explicitCwd?: string,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeRecord> {
    return verifyWorktreeForResume(this.deps, record, explicitCwd, signal)
  }

  /** 清理（归属校验/脏工作区保护/进程占用检查见 worktree-cleanup.ts；per-repo 锁经 withRepoLock 注入）。 */
  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    return cleanupWorktree(
      this.deps,
      this.store,
      this.redact,
      (nodeId, canonicalCommonDir, fn) => this.withRepoLock(nodeId, canonicalCommonDir, fn),
      input,
    )
  }
}
