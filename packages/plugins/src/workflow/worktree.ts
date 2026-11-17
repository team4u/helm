/**
 * 跨节点通用 WorktreeAllocator：`isolation: 'worktree'` 机制层门面。
 *
 * - `allocate`：批量执行 git 预检（单次 `rev-parse` 取 bare/common-dir/toplevel +
 *   `worktree list --porcelain -z` 定位真正主仓 + 单次 `status --porcelain=v2 --branch`
 *   取 HEAD/分支/dirtySource），在主工作树同级 `.helm-worktrees/<repo>-<shortId>` 创建
 *   独立 worktree 与 `helm/spawn-<shortId>` 分支；
 * - `registerExternal`：外部运行时回传的 worktree 统一登记；
 * - `inspect` / `verifyForResume` / `cleanup`：转发至子模块并与统一 `WorktreeStore` 共享状态。
 */
import type { FileError, Result } from '@earendil-works/pi-durable/env'
import { randomUUID } from 'node:crypto'
import { HelmError, pathRulesForShape, targetPathShape, type NodePathUsage } from '@helm/protocol'
import {
  gitExec,
  normalizePathValue,
  parseStatusPorcelainV2,
  resolveRepoAuthority,
  type WorktreeExecOptions,
  type WorktreeExecResult,
} from './worktree-git.js'
import { WorktreeStore, type ManagedWorktreeRecord, type WorktreeRecordSelector } from './worktree-store.js'
import {
  inspectWorktree,
  verifyWorktreeForResume,
  type WorktreeInspectInput,
  type WorktreeInspectResult,
} from './worktree-inspect.js'
import { cleanupWorktree } from './worktree-cleanup.js'

/** 单条受管 worktree 记录与持久持有锁契约（登记形状与持久化见 worktree-store.ts）。 */
export type { ManagedWorktreeHold, ManagedWorktreeRecord } from './worktree-store.js'
export type { WorktreeInspectInput, WorktreeInspectResult } from './worktree-inspect.js'

export interface WorktreeAllocatorDeps {
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options?: WorktreeExecOptions,
  ) => Promise<WorktreeExecResult>
  nodeExists: (nodeId: string, path: string) => Promise<Result<boolean, FileError>>
  nodeCanonicalPath: (nodeId: string, path: string) => Promise<Result<string, FileError>>
  docStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush?: () => Promise<void>
  }
  /** 可选注入统一存储实例（WorktreeIsolation 共享同一存储，免循环引用）。 */
  store?: WorktreeStore
  redact?: (text: string) => string
  isConversationWorking?: (conversationId: number) => boolean
  isPathInUse?: (nodeId: string, path: string) => boolean
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
  labelHint?: string
  signal?: AbortSignal
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
  sourceCwd?: string
}

export interface CleanupInput {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
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
  private readonly repoLocks = new Map<string, Promise<unknown>>()
  private readonly redact: (text: string) => string
  private readonly store: WorktreeStore

  constructor(private readonly deps: WorktreeAllocatorDeps) {
    this.redact = deps.redact ?? ((t: string) => t)
    this.store = deps.store ?? new WorktreeStore({ docStore: deps.docStore, redact: this.redact })
  }

  private async withRepoLock<T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>): Promise<T> {
    const key = `${nodeId}\u0000${canonicalCommonDir}`
    const previous = this.repoLocks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
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

  async allocate(input: AllocateInput): Promise<ManagedWorktreeRecord> {
    const { nodeId, sourceCwd, signal } = input

    // Step A：单次批量 rev-parse 同时探测 bare、common-dir 与工作树根。
    const rev = await gitExec(
      this.deps,
      nodeId,
      sourceCwd,
      ['rev-parse', '--path-format=absolute', '--is-bare-repository', '--git-common-dir', '--show-toplevel'],
      signal,
    )
    if (!rev.ok) {
      const firstLine = rev.output.replace(/\r\n/g, '\n').split('\n')[0]?.trim()
      let isBare = firstLine === 'true'
      if (!isBare && !rev.output.toLowerCase().includes('not a git repository')) {
        const bare = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--is-bare-repository'], signal)
        isBare = bare.ok && bare.output.trim() === 'true'
      }
      if (isBare) {
        throw new HelmError(
          'worktree_unsupported_layout',
          `目录 ${sourceCwd}（节点 ${nodeId}）是裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
          400,
          { nodeId, sourceCwd },
        )
      }
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）不是 Git 仓库（git rev-parse --show-toplevel 失败）：\n${rev.output.trim()}`,
        400,
        { nodeId, sourceCwd, output: rev.output.slice(0, 2000) },
      )
    }

    const revLines = rev.output.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
    const [bareFlag = '', commonDir = '', sourceToplevel = ''] = revLines
    if (bareFlag.trim() === 'true') {
      throw new HelmError(
        'worktree_unsupported_layout',
        `目录 ${sourceCwd}（节点 ${nodeId}）位于裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
        400,
        { nodeId, sourceCwd },
      )
    }
    if (revLines.length < 3 || commonDir === '' || sourceToplevel === '') {
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）不是有效 Git 工作树：\n${rev.output.trim()}`,
        400,
        { nodeId, sourceCwd, output: rev.output.slice(0, 2000) },
      )
    }

    // Step B：复用 Step A 已解析的 commonDir 读取权威 worktree 列表并校验标准布局。
    const authority = await resolveRepoAuthority(this.deps, nodeId, sourceToplevel, signal, commonDir)

    // Step C：单次 status --porcelain=v2 --branch 同时获取 HEAD 提交哈希、检出分支与脏工作区事实。
    const status = await gitExec(this.deps, nodeId, sourceCwd, ['status', '--porcelain=v2', '--branch'], signal)
    if (!status.ok) {
      throw new HelmError(
        'worktree_failed',
        `读取目录 ${sourceCwd}（节点 ${nodeId}）状态失败：\n${status.output.trim()}`,
        502,
        { nodeId, sourceCwd, output: status.output.slice(0, 2000) },
      )
    }
    const parsedStatus = parseStatusPorcelainV2(status.output)
    const baseCommit = parsedStatus.oid
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
      throw new HelmError(
        'worktree_failed',
        `目录 ${sourceCwd}（节点 ${nodeId}）尚无有效 HEAD 提交（${JSON.stringify(baseCommit)}），无法派生隔离 worktree`,
        502,
        { nodeId, sourceCwd, head: baseCommit },
      )
    }
    const baseBranch = parsedStatus.branch
    const dirtySource = parsedStatus.dirty

    // Step D：基于主工作树同级 `.helm-worktrees` 构造路径与受管分支名（不嵌套）。
    const pathRules = pathRulesForShape(targetPathShape(authority.mainPath))
    const repoName = pathRules.basename(authority.mainPath).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
    const shortId = randomUUID().replaceAll('-', '').slice(0, 8)
    const branch = `helm/spawn-${shortId}`
    const worktreeBase = pathRules.join(pathRules.dirname(authority.mainPath), '.helm-worktrees')
    const worktreePath = pathRules.join(worktreeBase, `${repoName}-${shortId}`)

    // Step E：副作用前拦截含已登记机密的持久化字段。
    this.store.assertMetadataSecretFree(
      {
        repoRoot: authority.mainPath,
        path: worktreePath,
        branch,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
      },
      { nodeId, parentConversationId: input.parentConversationId },
    )

    // Step F：per-repo 串行锁内落盘 beforeCreate 占位租约并执行 `git worktree add`。
    return this.withRepoLock(nodeId, authority.canonicalCommonDir, async () => {
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
        createdAt: Date.now(),
      }
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

  bindConversation(worktreePath: string, nodeId: string, conversationId: number): void {
    const id = `${nodeId}:${worktreePath}`
    if (this.store.findById(id) === undefined) {
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

  registerExternal(input: RegisterExternalInput): ManagedWorktreeRecord {
    const id = `${input.nodeId}:${input.path}`
    this.store.assertMetadataSecretFree(
      {
        path: input.path,
        branch: input.branch,
        repoRoot: input.sourceCwd ?? '',
        nodeId: input.nodeId,
        executionId: input.executionId ?? '',
      },
      {
        nodeId: this.redact(input.nodeId),
        parentConversationId: input.parentConversationId,
        conversationId: input.conversationId,
        executionId: input.executionId !== undefined ? this.redact(input.executionId) : undefined,
      },
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
    const record: ManagedWorktreeRecord = {
      id,
      nodeId: input.nodeId,
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

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.store.getForConversation(conversationId)
  }

  list(): ManagedWorktreeRecord[] {
    return this.store.list()
  }

  findActive(query: WorktreeRecordSelector): ManagedWorktreeRecord | undefined {
    return this.store.findActive(query)
  }

  async inspect(input: WorktreeInspectInput, signal?: AbortSignal): Promise<WorktreeInspectResult> {
    return inspectWorktree(this.deps, this.store, this.redact, input, signal)
  }

  async verifyForResume(
    record: ManagedWorktreeRecord,
    explicitCwd?: string,
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeRecord> {
    return verifyWorktreeForResume(this.deps, record, explicitCwd, signal)
  }

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
