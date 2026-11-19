/**
 * worktree 隔离生命周期编排门面（`builtin:worktree` 自有资产）：
 * - 单一 `WorktreeStore` 承载受管记录、durable 租约、agentId 绑定与占用判定，
 *   `WorktreeIsolation -> WorktreeAllocator -> WorktreeStore` 单向依赖、零循环回调；
 * - 节点命令执行直接透传 `ctx.host.execEnv`（无二次 Result 包装）；
 * - `aroundSpawn` 编排新建 / resume / reattach / 外部运行时回填；
 * - `pruneConversation` 在会话删除时裁剪绑定与已 `removed` 记录（保留 `active` 记录与租约）。
 */
import { HelmxError, type AgentExecutionInfo, type AgentSpawnRequest, type NodePathUsage } from '@helmx/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { FileError, type ExecutionEnv, type Result } from '@earendil-works/pi-durable/env'
import { WorktreeAllocator, type ManagedWorktreeRecord } from './worktree.js'
import { WorktreeStore, type WorktreeLeaseRecord } from './worktree-store.js'
import type { WorktreeExecOptions, WorktreeExecResult } from './worktree-git.js'
import {
  reattachWithWorktree,
  resumeWithWorktree,
  spawnWithWorktree,
  trackWithoutPreallocation,
  type IsolationSpawnContext,
} from './isolation-spawn.js'

export type { WorktreeLeaseRecord }

export interface AcquireWorktreeInput {
  conversationId: number
  parentConversationId: number
  profileId?: string
  requestCwd?: string
  fork?: boolean
  hold: {
    pluginId: string
    holdId: string
    label: string
  }
}

export interface AcquireWorktreeResult {
  worktreeId: string
  path: string
  branch: string
  baseCommit: string
  nodeId: string
}

function isExternalRuntimeAgentType(agentType: string | undefined): boolean {
  return agentType !== undefined && agentType.includes(':')
}

export interface WorktreeIsolationDeps {
  host: {
    resolveSpawnTarget(input: {
      parentConversationId: number
      profileId?: string
      requestCwd?: string
      fork?: boolean
    }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
    execEnv(
      req: { command: string | string[]; nodeId?: string; cwd?: string; timeoutMs?: number },
      opts?: { signal?: AbortSignal },
    ): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }>
    executionEnv(nodeId: string, cwd: string): ExecutionEnv
    inspectNodePathUsage(input: { nodeId: string; path: string; signal?: AbortSignal }): Promise<NodePathUsage>
    listActiveSpawnExecutions(): AgentExecutionInfo[]
    redact(text: string): string
    getConversation(id: number): { cwd: string; nodeId?: string; status: string; profileId?: string }
    profiles?: {
      get(id: string): Promise<{ runtime?: unknown } | undefined>
    }
    readonly isClosing?: boolean
  }
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void; flush(): Promise<void> }
}

export class WorktreeIsolation {
  readonly allocator: WorktreeAllocator
  private readonly store: WorktreeStore

  constructor(private readonly deps: WorktreeIsolationDeps) {
    const redact = (text: string) => deps.host.redact(text)
    this.store = new WorktreeStore({
      docStore: deps.docStore,
      redact,
      host: deps.host,
    })
    this.allocator = new WorktreeAllocator({
      store: this.store,
      docStore: deps.docStore,
      exec: (nodeId, cwd, args, options) => this.execGit(nodeId, cwd, args, options),
      nodeExists: (nodeId, path) => this.probeFs(nodeId, path, 'exists') as Promise<Result<boolean, FileError>>,
      nodeCanonicalPath: (nodeId, path) => this.probeFs(nodeId, path, 'canonicalPath') as Promise<Result<string, FileError>>,
      inspectPathUsage: (nodeId, path, signal) => deps.host.inspectNodePathUsage({ nodeId, path, signal }),
      redact,
    })
  }

  private spawnCtx(): IsolationSpawnContext {
    return { deps: this.deps, allocator: this.allocator, store: this.store }
  }

  private async execGit(
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options?: WorktreeExecOptions,
  ): Promise<WorktreeExecResult> {
    try {
      return await this.deps.host.execEnv(
        {
          command: [...args],
          nodeId,
          cwd,
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
        options?.signal !== undefined ? { signal: options.signal } : undefined,
      )
    } catch (error) {
      return {
        ok: false,
        exitCode: null,
        output: `execEnv 调用失败：${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      }
    }
  }

  private async probeFs(
    nodeId: string,
    path: string,
    op: 'exists' | 'canonicalPath',
  ): Promise<Result<boolean | string, FileError>> {
    if (typeof nodeId !== 'string' || nodeId === '') {
      return { ok: false, error: new FileError('unknown', 'probeFs 需要非空 nodeId', path) }
    }
    if (typeof path !== 'string' || path === '') {
      return { ok: false, error: new FileError('unknown', 'probeFs 需要非空 path', path) }
    }
    try {
      const env = this.deps.host.executionEnv(nodeId, path)
      return op === 'exists'
        ? await env.exists(path, BACKGROUND_CONTEXT)
        : await env.canonicalPath(path, BACKGROUND_CONTEXT)
    } catch (error) {
      return {
        ok: false,
        error: new FileError('unknown', error instanceof Error ? error.message : String(error), path),
      }
    }
  }

  async aroundSpawn(
    request: AgentSpawnRequest,
    next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    if (request.fork !== undefined && typeof request.fork !== 'boolean') {
      throw new HelmxError('validation_error', `fork 必须为 boolean（收到 ${typeof request.fork}）`, 400, {
        fork: request.fork,
      })
    }
    if (request.fork === true && request.resume !== undefined) {
      throw new HelmxError(
        'validation_error',
        'fork 与 resume 互斥：不能同时从父会话分叉并续接既有子会话',
        400,
        { resume: request.resume },
      )
    }
    if (request.reattach !== undefined) {
      if (request.reattach.conversationId !== undefined && request.reattach.executionId === undefined) {
        const existing = this.allocator.getForConversation(request.reattach.conversationId)
        if (existing !== undefined) {
          return reattachWithWorktree(this.spawnCtx(), request, existing, next)
        }
        return trackWithoutPreallocation(this.spawnCtx(), { ...request, isolation: undefined }, next)
      }
      return trackWithoutPreallocation(this.spawnCtx(), request, next)
    }
    const resumeChildId = request.resume !== undefined ? this.store.resolveResumeChildId(request) : undefined
    if (resumeChildId !== undefined) {
      const existing = this.allocator.getForConversation(resumeChildId)
      if (existing !== undefined) {
        return resumeWithWorktree(this.spawnCtx(), request, resumeChildId, existing, next)
      }
      if (request.isolation === 'worktree') {
        throw new HelmxError(
          'resume_cwd_conflict',
          `子会话 ${request.resume} 创建时未启用 worktree 隔离，不支持在 resume 时中途切换为 worktree 隔离`,
          409,
          { resume: request.resume },
        )
      }
    }
    if (request.isolation === 'worktree') {
      if (isExternalRuntimeAgentType(request.agentType)) {
        if (request.fork === true) {
          throw new HelmxError(
            'unsupported_runtime',
            `fork 仅支持原生 Profile 子会话，不支持外部运行时 '${request.agentType}'`,
            400,
            { agentType: request.agentType },
          )
        }
        return trackWithoutPreallocation(this.spawnCtx(), request, next)
      }
      if (this.deps.host.profiles !== undefined) {
        const targetProfileId =
          request.agentType ||
          (request.fork === true
            ? (this.deps.host.getConversation(request.parentConversationId).profileId ?? 'assistant')
            : 'assistant')
        const profile = await this.deps.host.profiles.get(targetProfileId)
        if (profile?.runtime !== undefined) {
          if (request.fork === true) {
            throw new HelmxError(
              'unsupported_runtime',
              `Profile '${targetProfileId}' 声明外部运行时，fork 仅支持原生 Profile 子会话`,
              400,
              { agentType: targetProfileId },
            )
          }
          return trackWithoutPreallocation(this.spawnCtx(), request, next)
        }
      }
      if (request.resume !== undefined && resumeChildId === undefined) {
        return trackWithoutPreallocation(this.spawnCtx(), request, next)
      }
      return spawnWithWorktree(this.spawnCtx(), request, next)
    }
    return trackWithoutPreallocation(this.spawnCtx(), request, next)
  }

  reconcileStoppedNativeLeases(): Promise<number> {
    return this.store.reconcileStoppedNativeLeases()
  }

  assertNoUnknownExecution(nodeId: string, path: string): void {
    this.store.assertNoUnknownExecution(nodeId, path)
  }

  async cleanup(
    input: Omit<Parameters<WorktreeAllocator['cleanup']>[0], 'signal'>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<WorktreeAllocator['cleanup']>>> {
    const record = this.allocator.findActive({
      ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    })
    if (record !== undefined && record.hold === undefined) {
      this.store.assertNoUnknownExecution(record.nodeId, record.path)
    }
    return this.allocator.cleanup({ ...input, signal })
  }

  /** 查询目标节点路径是否仍被在途 spawn、持久租约或活跃持有锁占用。 */
  isPathInUse(nodeId: string, path: string): boolean {
    return this.store.isPathInUse(nodeId, path)
  }

  /**
   * 分配受管隔离工作树并原子挂载跨回合持久持有锁：
   * resolveSpawnTarget -> openPendingLease -> allocator.allocate ->
   * bindConversation -> 脱敏/密检写入 hold -> 释放临时 pending 租约并 flush。
   */
  async acquireWorktree(input: AcquireWorktreeInput, signal?: AbortSignal): Promise<AcquireWorktreeResult> {
    if (!Number.isSafeInteger(input.conversationId) || input.conversationId < 1) {
      throw new HelmxError('validation_error', 'conversationId 必须为正整数', 400, {
        conversationId: input.conversationId,
      })
    }
    if (!Number.isSafeInteger(input.parentConversationId) || input.parentConversationId < 1) {
      throw new HelmxError('validation_error', 'parentConversationId 必须为正整数', 400, {
        parentConversationId: input.parentConversationId,
      })
    }
    if (input.profileId !== undefined && (typeof input.profileId !== 'string' || input.profileId.trim() === '')) {
      throw new HelmxError('validation_error', 'profileId 必须为非空字符串', 400, { profileId: input.profileId })
    }
    if (input.requestCwd !== undefined && (typeof input.requestCwd !== 'string' || input.requestCwd.trim() === '')) {
      throw new HelmxError('validation_error', 'requestCwd 必须为非空字符串', 400, { requestCwd: input.requestCwd })
    }
    if (input.fork !== undefined && typeof input.fork !== 'boolean') {
      throw new HelmxError('validation_error', `fork 必须为 boolean（收到 ${typeof input.fork}）`, 400, {
        fork: input.fork,
      })
    }
    // 在任何远端解析与 git 副作用前先做 hold 形状校验与机密检查，防遗留孤儿工作树。
    this.allocator.prepareHold(input.hold, {
      parentConversationId: input.parentConversationId,
      conversationId: input.conversationId,
    })

    const target = await this.deps.host.resolveSpawnTarget({
      parentConversationId: input.parentConversationId,
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.requestCwd !== undefined ? { requestCwd: input.requestCwd } : {}),
      ...(input.fork !== undefined ? { fork: input.fork } : {}),
    })

    let leaseToken = ''
    let holdPersisted = false
    try {
      const record = await this.allocator.allocate({
        nodeId: target.nodeId,
        sourceCwd: target.sourceCwd,
        parentConversationId: input.parentConversationId,
        signal,
        beforeCreate: async (pending) => {
          leaseToken = await this.store.openPendingLease({ nodeId: pending.nodeId, path: pending.path })
        },
      })
      this.allocator.bindConversation(record.path, record.nodeId, input.conversationId)
      this.allocator.setHold(record.id, input.hold, {
        parentConversationId: input.parentConversationId,
        conversationId: input.conversationId,
      })
      holdPersisted = true
      if (leaseToken !== '') {
        await this.store.settleLease(leaseToken, false, true)
      } else {
        await this.deps.docStore.flush()
      }
      return {
        worktreeId: record.id,
        path: record.path,
        branch: record.branch,
        baseCommit: record.baseCommit,
        nodeId: record.nodeId,
      }
    } catch (error) {
      if (leaseToken !== '' && !holdPersisted) {
        await this.store.settleLease(leaseToken, false, true).catch(() => {})
      }
      throw error
    }
  }

  /**
   * 释放受管工作树的持久持有锁：缺失或无锁幂等返回 { released: false }，
   * pluginId/holdId 不一致显式抛 409 worktree_hold_mismatch，匹配则清除并 flush。
   */
  async releaseWorktreeHold(input: {
    worktreeId: string
    pluginId: string
    holdId: string
  }): Promise<{ released: boolean }> {
    const released = this.allocator.releaseHold(input.worktreeId, input.pluginId, input.holdId)
    if (released) {
      await this.deps.docStore.flush()
    }
    return { released }
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.allocator.getForConversation(conversationId)
  }

  pruneConversation(conversationId: number): void {
    this.store.pruneConversation(conversationId)
  }
}
