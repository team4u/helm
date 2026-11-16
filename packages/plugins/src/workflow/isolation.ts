/**
 * worktree 隔离生命周期编排（builtin:workflow 插件自有资产）。
 *
 * 职责（经 agent_spawn continuation 包裹完整生命周期）：
 * - 新建：resolveSpawnTarget 按真实最终节点（显式 profile.nodeId > 父会话
 *   绑定节点 > local）解析后，在目标节点对源 cwd 真实执行 git 派生隔离树
 *   （WorktreeAllocator），改写最终请求 cwd 为隔离树并清除 isolation 标记；
 * - resume：严格沿用旧绑定隔离树（无显式 isolation 也不忽略旧绑定）；中途
 *   迁移节点/cwd 显式拒绝；目录缺失经节点真实探测证明后显式失败；
 * - 外部运行时（namespace:kind 形式 agentType）：不预分配（外部运行时自行
 *   决定隔离方式，如 Herdr 的 worktree.create）；仅回填登记与租约。
 *
 * 模块拆分（职责单一）：durable 租约持久化、占用判定与绑定解析在
 * isolation-lease-store.ts（WorktreeLeaseStore）；三个生命周期流程（新建 /
 * resume / 外部回填）在 isolation-spawn.ts。本文件保留 WorktreeIsolation
 * 编排门面：节点端口适配（execGit / probeFs）、aroundSpawn 分发、cleanup
 * 与 getForConversation 入口，以及依赖契约（WorktreeIsolationDeps）。
 *
 * 诚实性纪律：Profile 读取 IO 错误如实上抛（仅 not_found 视为 Profile 不存在）；
 * 会话状态读取错误不当作安全（fail-closed）；节点探测失败不当作目录缺失；
 * 机密元数据拒绝落库。
 */
import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest, type NodePathUsage } from '@helm/protocol'
import { WorktreeAllocator, type ManagedWorktreeRecord } from './worktree.js'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { ExecutionError, FileError, type Result, type ShellExecResult } from '@earendil-works/pi-durable/env'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { WorktreeLeaseStore } from './isolation-lease-store.js'
import {
  resumeWithWorktree,
  spawnWithWorktree,
  trackWithoutPreallocation,
  type IsolationSpawnContext,
} from './isolation-spawn.js'

/** 持久租约记录（形状与 fail-closed 纪律见 isolation-lease-store.ts）。 */
export type { WorktreeLeaseRecord } from './isolation-lease-store.js'

/** 外部运行时 agentType 命名空间形态：'namespace:kind'（通用约定，零插件点名）。 */
function isExternalRuntimeAgentType(agentType: string | undefined): boolean {
  return agentType !== undefined && agentType.includes(':')
}

/** 隔离服务依赖（插件 definePlugin 闭包注入；全部为已启用周期内稳定引用）。 */
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
    /**
     * 目标节点真实执行环境（SDK ExecutionEnv；受控代理：周期守卫 + 在逖
     * 任务跟踪）：exists / canonicalPath 在目标节点真实执行，失败如实返回
     * Result error，绝不编造结果。
     */
    executionEnv(nodeId: string, cwd: string): ExecutionEnv
    /** 目标节点进程占用快照（通用机制面；语义见 protocol/plugin.ts 端口注释）。 */
    inspectNodePathUsage(input: { nodeId: string; path: string; signal?: AbortSignal }): Promise<NodePathUsage>
    listActiveSpawnExecutions(): AgentExecutionInfo[]
    /** 宿主统一文本脱敏（SecretStash：明文机密 -> 标记）。 */
    redact(text: string): string
    getConversation(id: number): { cwd: string; nodeId?: string; status: string; profileId?: string }
    profiles?: {
      get(id: string): Promise<{ runtime?: unknown } | undefined>
    }
  }
  /** 插件私有 doc（records 同层持久层；停用保留，重启可读）。 */
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void; flush(): Promise<void> }
}

export class WorktreeIsolation {
  readonly allocator: WorktreeAllocator

  private readonly leases: WorktreeLeaseStore

  constructor(private readonly deps: WorktreeIsolationDeps) {
    // allocator 与租约存储互引：allocator 的占用检查经本存储查租约并反查
    // 登记，本存储解析租约路径时引用 allocator 记录（延迟引用，首次占用
    // 判定发生时 allocator 已构造完成）。
    this.leases = new WorktreeLeaseStore(deps.docStore, deps.host, () => this.allocator)
    this.allocator = new WorktreeAllocator({
      exec: (nodeId, cwd, args, options, context) => this.execGit(nodeId, cwd, args, options, context),
      nodeExists: (nodeId, path) => this.probeFs(nodeId, path, 'exists') as Promise<Result<boolean, FileError>>,
      nodeCanonicalPath: (nodeId, path) => this.probeFs(nodeId, path, 'canonicalPath') as Promise<Result<string, FileError>>,
      inspectPathUsage: (nodeId, path, signal) => deps.host.inspectNodePathUsage({ nodeId, path, signal }),
      docStore: deps.docStore,
      redact: (text) => deps.host.redact(text),
      isConversationWorking: (id) => this.leases.isConversationWorking(id),
      isPathInUse: (nodeId, path) => this.leases.isPathInUse(nodeId, path),
    })
  }

  /** 生命周期流程上下文（isolation-spawn.ts 流程函数的最小依赖组装）。 */
  private spawnCtx(): IsolationSpawnContext {
    return { deps: this.deps, allocator: this.allocator, leases: this.leases }
  }

  // ------------------------------------------------------------------
  // 节点端口适配
  // ------------------------------------------------------------------

  /**
   * argv 直跑适配：deps.exec 收到的已是完整 argv（含 'git' 前缀，与原
   * EnvFabric.exec 同契约）；execEnv 对数组命令不经 shell 解析。output 已含
   * 聚合 stdout+stderr 且经宿主全局脱敏；非零退出、超时、节点不可达均
   * 映射为 ok:false（输出进诊断）；execEnv 自身异常同样映射，绝不吞。
   */
  private async execGit(
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options: { timeout: number; onOutput: (text: string) => void },
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    let res: { ok: boolean; exitCode: number | null; output: string; timedOut: boolean }
    try {
      res = await this.deps.host.execEnv(
        { command: [...args], nodeId, cwd, timeoutMs: Math.round(options.timeout * 1000) },
        { signal: context.abortSignal },
      )
    } catch (error) {
      return {
        ok: false,
        error: new ExecutionError('unknown', `execEnv 调用失败：${error instanceof Error ? error.message : String(error)}`),
      }
    }
    // onOutput 聚合：allocator 的 gitExec 依赖它收集 combined 输出（诊断用）。
    if (res.output !== '') options.onOutput(res.output)
    if (!res.ok || res.exitCode === null) {
      return {
        ok: false,
        error: new ExecutionError(
          res.timedOut ? 'timeout' : 'unknown',
          `命令执行失败${res.timedOut ? '（超时）' : ''}：${res.output.slice(-2000)}`,
        ),
      }
    }
    return { ok: true, value: { exitCode: res.exitCode } }
  }

  /**
   * 节点 fs 探测适配（真实 ExecutionEnv：目标节点真实执行 exists /
   * canonicalPath）：Result 形状与 allocator 依赖同构，失败（节点离线 /
   * 权限 / 不存在）如实透传（绝不编造结果、绝不把探测失败当目录缺失）；
   * 受控代理自带周期守卫与在逖任务跟踪。
   */
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
      // cwd 仅是执行环境坐标（exists/canonicalPath 用绝对 path，不依赖 cwd）；
      // 入参校验后直接取 env，用后即弃，绝不缓存。
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

  // ------------------------------------------------------------------
  // agent_spawn continuation（around 主流程）
  // ------------------------------------------------------------------

  /**
   * around 钩子主体：仅对需要隔离（isolation='worktree'）或已绑定隔离树的
   * resume 派生介入；其余直接 next 透传（零开销）。
   */
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
    const resumeChildId = request.resume !== undefined ? this.leases.resolveResumeChildId(request) : undefined
    // resume + 已绑定隔离树：严格沿用（无显式 isolation 也不忽略旧绑定）。
    if (resumeChildId !== undefined) {
      const existing = this.allocator.getForConversation(resumeChildId)
      if (existing !== undefined) {
        return resumeWithWorktree(this.spawnCtx(), request, resumeChildId, existing, next)
      }
      // resume 无旧绑定但请求 isolation：中途切换显式拒绝（诚实性）。
      if (request.isolation === 'worktree') {
        throw new HelmError(
          'resume_cwd_conflict',
          `子会话 ${request.resume} 创建时未启用 worktree 隔离，不支持在 resume 时中途切换为 worktree 隔离`,
          409,
          { resume: request.resume },
        )
      }
    }
    // 新建 + isolation：在任何 worktree 分配与租约副作用之前拦截外部运行时或非法 fork。
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
      return spawnWithWorktree(this.spawnCtx(), request, next)
    }
    // 其余（外部运行时带 isolation / 普通派生回传 worktree）：仅回填登记与租约。
    return trackWithoutPreallocation(this.spawnCtx(), request, next)
  }

  // ------------------------------------------------------------------
  // cleanup（插件动作/工具入口）
  // ------------------------------------------------------------------

  /** 启动后回收已确认停止的原生 Worktree 崩溃租约（转发 isolation-lease-store.ts）。 */
  reconcileStoppedNativeLeases(): Promise<number> {
    return this.leases.reconcileStoppedNativeLeases()
  }

  /**
   * cleanup 前置租约检查（转发 isolation-lease-store.ts）：存在「重启中断
   * 或未确认停止」的执行租约时显式 worktree_execution_unknown（不能证明
   * 外部执行已停止就不能清理）；在途（宿主 activeSpawnExecutions 命中）的
   * 租约由 allocator 的 isPathInUse 拒绝（worktree_in_use）。
   */
  assertNoUnknownExecution(nodeId: string, path: string): void {
    this.leases.assertNoUnknownExecution(nodeId, path)
  }

  /** cleanup 入口：先做未知占用 fail-closed 检查，再执行 allocator 清理。 */
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
    if (record !== undefined) this.leases.assertNoUnknownExecution(record.nodeId, record.path)
    return this.allocator.cleanup({ ...input, signal })
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.allocator.getForConversation(conversationId)
  }
}
