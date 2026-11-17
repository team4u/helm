/**
 * worktree 隔离生命周期编排门面（`builtin:workflow` 自有资产）：
 * - 单一 `WorktreeStore` 承载受管记录、durable 租约、agentId 绑定与占用判定，
 *   `WorktreeIsolation -> WorktreeAllocator -> WorktreeStore` 单向依赖、零循环回调；
 * - 节点命令执行直接透传 `ctx.host.execEnv`（无二次 Result 包装）；
 * - `aroundSpawn` 编排新建 / resume / reattach / 外部运行时回填；
 * - `pruneConversation` 在会话删除时裁剪绑定与已 `removed` 记录（保留 `active` 记录与租约）。
 */
import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest, type NodePathUsage } from '@helm/protocol'
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
      throw new HelmError('validation_error', `fork 必须为 boolean（收到 ${typeof request.fork}）`, 400, {
        fork: request.fork,
      })
    }
    if (request.fork === true && request.resume !== undefined) {
      throw new HelmError(
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
        throw new HelmError(
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
          throw new HelmError(
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
            throw new HelmError(
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
    if (record !== undefined) this.store.assertNoUnknownExecution(record.nodeId, record.path)
    return this.allocator.cleanup({ ...input, signal })
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.allocator.getForConversation(conversationId)
  }

  pruneConversation(conversationId: number): void {
    this.store.pruneConversation(conversationId)
  }
}
