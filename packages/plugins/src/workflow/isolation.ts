/**
 * worktree 隔离生命周期（builtin:workflow 插件自有资产）。
 *
 * 职责（经 agent_spawn continuation 包裹完整生命周期）：
 * - 新建：resolveSpawnTarget 按真实最终节点（显式 profile.nodeId > 父会话
 *   绑定节点 > local）解析后，在目标节点对源 cwd 真实执行 git 派生隔离树
 *   （WorktreeAllocator），改写最终请求 cwd 为隔离树并清除 isolation 标记；
 * - resume：严格沿用旧绑定隔离树（无显式 isolation 也不忽略旧绑定）；中途
 *   迁移节点/cwd 显式拒绝；目录缺失经节点真实探测证明后显式失败；
 * - 外部运行时（namespace:kind 形式 agentType）：不预分配（外部运行时自行
 *   决定隔离方式，如 Herdr 的 worktree.create）；仅回填登记与租约；
 *
 * durable 租约（lease）安全红线（fail-closed）：
 * - 分配路径：git worktree add 副作用【之前】经 allocator.beforeCreate 持久
 *   登记占位（携带目标 nodeId/path/branch；executionId/conversationId 空），
 *   崩溃/重启后该占位仍存在且无在途执行 -> 显式 worktree_execution_unknown
 *   阻塞清理（不能证明停止就不能清理）；
 * - 释放条件（仅两种）：执行确认成功；或执行【确认从未启动】——next 前抛错
 *   （尚未进入执行链）。onResolved 失败、外部进程已启动但未回填 executionId、
 *   以及一切未知状态均保留租约（fail-closed）；
 * - 外部运行时回填路径：onResolved 首次回传 worktree 即登记租约；终态收敛
 *   同上（成功释放；失败且已回填 executionId 保留；未回填且 next 从未完成
 *   的未知状态保留——不能证明外部执行未启动）。
 *
 * 诚实性纪律：Profile 读取 IO 错误如实上抛（仅 not_found 视为 Profile 不存在）；
 * 会话状态读取错误不当作安全（fail-closed）；节点探测失败不当作目录缺失；
 * 机密元数据拒绝落库。
 */
import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest, type NodePathUsage } from '@helm/protocol'
import { sanitizeAgentExecutionInfo as sanitizeExecutionInfo } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { WorktreeAllocator, type ManagedWorktreeRecord } from './worktree.js'
import type { Context } from '@earendil-works/chord'
import { ExecutionError, FileError, type Result, type ShellExecResult } from '@earendil-works/pi-durable/env'
import { redactJsonValue } from '@helm/protocol'

/** 外部运行时 agentType 命名空间形态：'namespace:kind'（通用约定，零插件点名）。 */
function isExternalRuntimeAgentType(agentType: string | undefined): boolean {
  return agentType !== undefined && agentType.includes(':')
}

/**
 * 持久租约记录（'worktree-leases' doc）。
 * phase：'pending'（占位：副作用前/未启动确认）| 'running'（onResolved 已回填）。
 */
export interface WorktreeLeaseRecord {
  phase: 'pending' | 'running'
  /** 执行元数据（pending 阶段 executionId/conversationId 可能为空）。 */
  info: AgentExecutionInfo
  /** 关联的受管 worktree 登记 ID（`${nodeId}:${path}`；始终非空）。 */
  worktreeId: string
  /** 是否已确认执行从未启动（next 前抛错置 true；唯一安全释放条件之一）。 */
  neverStarted?: boolean
  createdAt: number
}

/** 隔离服务依赖（插件 definePlugin 闭包注入；全部为已启用周期内稳定引用）。 */
export interface WorktreeIsolationDeps {
  host: {
    resolveSpawnTarget(input: {
      parentConversationId: number
      profileId?: string
      requestCwd?: string
    }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }>
    execEnv(
      req: { command: string | string[]; nodeId?: string; cwd?: string; timeoutMs?: number },
      opts?: { signal?: AbortSignal },
    ): Promise<{ ok: boolean; exitCode: number | null; output: string; timedOut: boolean }>
    probeNodeFs(input: { nodeId: string; op: 'exists' | 'canonicalPath'; path: string }): Promise<{ value: string | boolean }>
    /** 目标节点进程占用快照（通用机制面；语义见 protocol/plugin.ts 端口注释）。 */
    inspectNodePathUsage(input: { nodeId: string; path: string; signal?: AbortSignal }): Promise<NodePathUsage>
    listActiveSpawnExecutions(): AgentExecutionInfo[]
    redactText(text: string): string
    getConversation(id: number): { cwd: string; nodeId?: string; status: string }
  }
  /** 插件私有 doc（records 同层持久层；停用保留，重启可读）。 */
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void; flush(): Promise<void> }
}

const LEASES_DOC_KEY = 'worktree-leases'
const AGENT_BINDINGS_DOC_KEY = 'worktree-agent-bindings'

export class WorktreeIsolation {
  readonly allocator: WorktreeAllocator

  constructor(private readonly deps: WorktreeIsolationDeps) {
    this.allocator = new WorktreeAllocator({
      exec: (nodeId, cwd, args, options, context) => this.execGit(nodeId, cwd, args, options, context),
      nodeExists: (nodeId, path) => this.probeFs(nodeId, path, 'exists') as Promise<Result<boolean, FileError>>,
      nodeCanonicalPath: (nodeId, path) => this.probeFs(nodeId, path, 'canonicalPath') as Promise<Result<string, FileError>>,
      inspectPathUsage: (nodeId, path, signal) => deps.host.inspectNodePathUsage({ nodeId, path, signal }),
      docStore: deps.docStore,
      redact: (text) => deps.host.redactText(text),
      isConversationWorking: (id) => this.isConversationWorking(id),
      isPathInUse: (nodeId, path) => this.isPathInUse(nodeId, path),
    })
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

  /** 节点 fs 探测适配：probeNodeFs 失败如实映射（绝不编造结果）。 */
  private async probeFs(nodeId: string, path: string, op: 'exists' | 'canonicalPath'): Promise<Result<boolean | string, FileError>> {
    try {
      const res = await this.deps.host.probeNodeFs({ nodeId, op, path })
      if (op === 'exists') {
        return typeof res.value === 'boolean'
          ? { ok: true, value: res.value }
          : { ok: false, error: new FileError('unknown', 'exists 返回非布尔值', path) }
      }
      return typeof res.value === 'string' && res.value !== ''
        ? { ok: true, value: res.value }
        : { ok: false, error: new FileError('unknown', 'canonicalPath 返回非字符串', path) }
    } catch (error) {
      return {
        ok: false,
        error: new FileError('unknown', error instanceof Error ? error.message : String(error), path),
      }
    }
  }

  // ------------------------------------------------------------------
  // 占用判定（cleanup 拒绝清理在途树；fail-closed）
  // ------------------------------------------------------------------

  private contains(path: string, candidate: string): boolean {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    const normalize = (value: string) => {
      const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
      return windows ? normalized.toLowerCase() : normalized
    }
    const base = normalize(path)
    const probe = normalize(candidate)
    return probe === base || probe.startsWith(`${base}/`)
  }

  /** 会话工作状态：读取错误如实上抛（不当作安全）；仅 working/blocked 视为占用。 */
  private isConversationWorking(id: number): boolean {
    const conv = this.deps.host.getConversation(id)
    return conv.status === 'working' || conv.status === 'blocked'
  }

  /**
   * 路径占用：宿主在途 spawn 执行坐标 + 本插件租约（按 worktreeId 关联
   * allocator 记录定位路径，pending 占位同样计入）。
   */
  private isPathInUse(nodeId: string, path: string): boolean {
    // 1) 宿主在途 spawn 执行（含外部运行时回传坐标）。
    for (const info of this.deps.host.listActiveSpawnExecutions()) {
      if (info.nodeId !== nodeId) continue
      if (info.effectiveCwd !== undefined && this.contains(path, info.effectiveCwd)) return true
      const wt = info.worktree
      if (wt !== undefined && this.contains(path, wt.path)) return true
    }
    // 2) 本插件租约：pending（占位）与 running 一视同仁——按 worktreeId 从
    //    allocator 记录解析路径（占位记录尚未登记 allocator 时直接用
    //    worktreeId 中的 path 部分解析）。
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath !== undefined && this.contains(path, leasePath)) return true
    }
    return false
  }

  /** 租约路径解析：优先 allocator 记录；无记录时从 worktreeId（node:path）解析。 */
  private leasePathOf(lease: WorktreeLeaseRecord, nodeId: string): string | undefined {
    const record = this.allocator.findActive({ worktreeId: lease.worktreeId })
    if (record !== undefined) return record.nodeId === nodeId ? record.path : undefined
    const prefix = `${nodeId}:`
    return lease.worktreeId.startsWith(prefix) ? lease.worktreeId.slice(prefix.length) : undefined
  }

  // ------------------------------------------------------------------
  // durable 租约
  // ------------------------------------------------------------------

  private listLeases(): Map<string, WorktreeLeaseRecord> {
    const raw = this.deps.docStore.get<Record<string, WorktreeLeaseRecord>>(LEASES_DOC_KEY, {})
    return new Map(Object.entries(raw))
  }

  private saveLeases(map: Map<string, WorktreeLeaseRecord>): void {
    this.deps.docStore.set(LEASES_DOC_KEY, Object.fromEntries(map))
  }

  /**
   * 占位租约（分配路径专用）：git worktree add 副作用之前登记（经
   * allocator.beforeCreate 回调，先于任何 Git 副作用）并 flush 落盘。
   * worktreeId 即 `${nodeId}:${path}`（与 allocator 登记同构）。
   */
  private async openPendingLease(worktreeId: string): Promise<string> {
    const token = randomUUID()
    const map = this.listLeases()
    map.set(token, {
      phase: 'pending',
      info: { nodeId: worktreeId.slice(0, worktreeId.indexOf(':')) || '' },
      worktreeId,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    await this.deps.docStore.flush()
    return token
  }

  /** onResolved 回填：升级为 running 并记录真实执行坐标（幂等取最新）。 */
  private updateLease(token: string, info: AgentExecutionInfo): void {
    const map = this.listLeases()
    const lease = map.get(token)
    if (lease === undefined) return
    map.set(token, { ...lease, phase: 'running', info })
    this.saveLeases(map)
  }

  /**
   * 终态收敛。释放仅限两种确认状态（安全红线）：
   * 1) succeeded = true（执行确认成功）；
   * 2) neverStarted = true（next 从未被调用/尚未进入执行链就抛错——此时
   *    占位租约自身可证明无执行）。
   * 其余（onResolved 失败、外部进程已启动但未回填 executionId、未知状态）
   * 一律保留租约（fail-closed：不能证明停止就不能允许清理）。
   */
  private async settleLease(token: string, succeeded: boolean, neverStarted: boolean): Promise<void> {
    if (!succeeded && !neverStarted) return
    const map = this.listLeases()
    if (!map.has(token)) return
    map.delete(token)
    this.saveLeases(map)
    await this.deps.docStore.flush()
  }

  // ------------------------------------------------------------------
  // agentId 绑定（resume ref 解析）
  // ------------------------------------------------------------------

  /** resume ref -> childConversationId（纯数字直转；agentId 经绑定表）。 */
  private resolveResumeChildId(request: AgentSpawnRequest): number | undefined {
    if (request.resume === undefined) return undefined
    if (/^\d+$/.test(request.resume)) return Number(request.resume)
    const bindings = this.deps.docStore.get<Record<string, number>>(AGENT_BINDINGS_DOC_KEY, {})
    return bindings[request.resume]
  }

  /** agentId -> childId 绑定（spawn 的 onResolved 后记录）。 */
  private recordAgentBinding(agentId: string | undefined, childId: number | undefined): void {
    if (agentId === undefined || agentId === '' || childId === undefined) return
    const bindings = this.deps.docStore.get<Record<string, number>>(AGENT_BINDINGS_DOC_KEY, {})
    if (bindings[agentId] === childId) return
    bindings[agentId] = childId
    this.deps.docStore.set(AGENT_BINDINGS_DOC_KEY, bindings)
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
    const resumeChildId = request.resume !== undefined ? this.resolveResumeChildId(request) : undefined
    // resume + 已绑定隔离树：严格沿用（无显式 isolation 也不忽略旧绑定）。
    if (resumeChildId !== undefined) {
      const existing = this.allocator.getForConversation(resumeChildId)
      if (existing !== undefined) {
        return this.resumeWithWorktree(request, resumeChildId, existing, next)
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
    // 新建 + isolation：解析最终节点后预分配（外部运行时不预分配）。
    if (request.isolation === 'worktree') {
      if (isExternalRuntimeAgentType(request.agentType)) {
        return this.trackWithoutPreallocation(request, next)
      }
      return this.spawnWithWorktree(request, next)
    }
    // 其余（外部运行时带 isolation / 普通派生回传 worktree）：仅回填登记与租约。
    return this.trackWithoutPreallocation(request, next)
  }

  /**
   * 新建 + isolation: 'worktree'：占位租约（副作用前）-> 分配 -> 改写 cwd ->
   * next -> 终态收敛。next 前任何失败都标记 neverStarted（占位可安全释放）；
   * next 后（含 next 抛错）一律 fail-closed 保留。
   */
  private async spawnWithWorktree(
    request: AgentSpawnRequest,
    next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    // 最终节点与源目录解析（内核权威：与原生执行行同构链；IO/不存在错误如实上抛）。
    const profileId = request.agentType || 'assistant'
    const target = await this.deps.host.resolveSpawnTarget({
      parentConversationId: request.parentConversationId,
      profileId,
      ...(request.cwd !== undefined ? { requestCwd: request.cwd } : {}),
    })
    const sourceCwd = target.sourceCwd
    let leaseToken = ''
    let enteredNext = false
    let execution: AgentExecutionInfo | undefined
    try {
      const record = await this.allocator.allocate({
        nodeId: target.nodeId,
        sourceCwd,
        parentConversationId: request.parentConversationId,
        signal: request.signal,
        beforeCreate: async (pending) => {
          // git worktree add 之前持久占位（worktreeId 与 allocator 登记同构）。
          leaseToken = await this.openPendingLease(`${pending.nodeId}:${pending.path}`)
        },
      })
      // Dirty 源仓库诚实提示：隔离树基于 HEAD 创建，不含源工作区未提交改动。
      const isolationNotice =
        record.dirtySource
          ? `\n\n<worktree_isolation_notice>\n当前工作目录为独立 Git Worktree (${record.path}，分支 ${record.branch}，基于提交 ${record.baseCommit.slice(0, 12)})。注意：源工作区存在未提交修改，本隔离工作树基于 HEAD 创建，不包含源工作区未提交的改动。\n</worktree_isolation_notice>`
          : ''
      const finalRequest: AgentSpawnRequest = {
        ...request,
        cwd: record.path,
        isolation: undefined,
        ...(isolationNotice !== '' ? { prompt: `${request.prompt}${isolationNotice}` } : {}),
        onResolved: (raw) => {
          const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
          const enriched: AgentExecutionInfo = {
            ...info,
            nodeId: info.nodeId ?? target.nodeId,
            worktree: {
              path: record.path,
              branch: record.branch,
              id: record.id,
              ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
              ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
            },
          }
          if (info.conversationId !== undefined) {
            this.allocator.bindConversation(record.path, record.nodeId, info.conversationId)
            this.recordAgentBinding(request.agentId, info.conversationId)
          }
          this.updateLease(leaseToken, enriched)
          execution = enriched
          request.onResolved?.(enriched)
        },
      }
      enteredNext = true
      const result = await next(finalRequest)
      await this.settleLease(leaseToken, true, false)
      return result
    } catch (error) {
      // next 前失败（分配失败/目标解析失败）：占位租约可证明无执行，安全释放。
      await this.settleLease(leaseToken, false, !enteredNext).catch(() => {})
      throw error
    }
  }

  /** resume + 旧绑定：沿用原树（禁止中途迁移节点/cwd）；目录缺失显式失败。 */
  private async resumeWithWorktree(
    request: AgentSpawnRequest,
    childId: number,
    record: ManagedWorktreeRecord,
    next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    if (record.status === 'removed') {
      throw new HelmError('worktree_missing', `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`, 409)
    }
    const conv = this.deps.host.getConversation(childId) // 错误如实上抛
    if ((conv.nodeId ?? 'local') !== record.nodeId) {
      throw new HelmError('resume_cwd_conflict', '隔离子会话必须在原节点和工作树上续接，不能切换节点', 409, { conversationId: childId, nodeId: record.nodeId })
    }
    if (request.cwd !== undefined && request.cwd !== record.path) {
      throw new HelmError('resume_cwd_conflict', `子会话已绑定隔离 worktree '${record.path}'，不支持在 resume 时改写 cwd 为 '${request.cwd}'`, 409, { existingCwd: record.path, requestedCwd: request.cwd })
    }
    // 占位租约先于远端验证打开：verifyForResume 的多次远端 git/fs 探测是秒级
    // await 窗口，期间子会话不 working、无在途执行、无租约——并发 cleanup 可
    // 通过全部占用检查移除树，resume 随后携 stale cwd 派生会话，并为已 removed
    // 记录留永久占位租约。租约前置后 isPathInUse 在验证期即拒绝 cleanup（与
    // spawnWithWorktree 的 beforeCreate 副作用前置同构）；验证失败走
    // neverStarted 释放，不留占位。
    const leaseToken = await this.openPendingLease(record.id)
    let enteredNext = false
    let execution: AgentExecutionInfo | undefined
    try {
      await this.allocator.verifyForResume(record, request.cwd, request.signal)
      const finalRequest: AgentSpawnRequest = {
        ...request,
        cwd: record.path,
        isolation: undefined,
        onResolved: (raw) => {
          const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
          const enriched: AgentExecutionInfo = {
            ...info,
            nodeId: info.nodeId ?? record.nodeId,
            worktree: {
              path: record.path,
              branch: record.branch,
              id: record.id,
              ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
              ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
            },
          }
          this.updateLease(leaseToken, enriched)
          execution = enriched
          request.onResolved?.(enriched)
        },
      }
      enteredNext = true
      const result = await next(finalRequest)
      await this.settleLease(leaseToken, true, false)
      return result
    } catch (error) {
      await this.settleLease(leaseToken, false, !enteredNext).catch(() => {})
      throw error
    }
  }

  /**
   * 外部运行时 / 普通派生：不预分配；onResolved 回传 worktree 时登记 + 租约。
   * 终态收敛：成功释放；失败保留（外部执行启动与否不可证明——onResolved
   * 未触发不等于未启动）。请求了 isolation 但外部运行时未兑现：显式拒绝。
   */
  private async trackWithoutPreallocation(
    request: AgentSpawnRequest,
    next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
  ): Promise<unknown> {
    if (request.onResolved === undefined) return next(request)
    let leaseToken: string | undefined
    let execution: AgentExecutionInfo | undefined
    const finalRequest: AgentSpawnRequest = {
      ...request,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        if (info.worktree !== undefined) {
          if (info.nodeId === undefined) {
            throw new HelmError('execution_info_invalid', '隔离工作树必须回传实际 nodeId，不能推测外部运行时的节点', 502)
          }
          const managed =
            this.allocator.findActive({ path: info.worktree.path, nodeId: info.nodeId }) ??
            this.allocator.registerExternal({
              nodeId: info.nodeId,
              path: info.worktree.path,
              branch: info.worktree.branch,
              parentConversationId: request.parentConversationId,
              ...(info.conversationId !== undefined ? { conversationId: info.conversationId } : {}),
              ...(info.executionId !== undefined ? { executionId: info.executionId } : {}),
            })
          // 机密检查：元数据将落库，含已登记机密显式拒绝。
          const safe = redactJsonValue(managed, (text) => this.deps.host.redactText(text))
          if (JSON.stringify(safe) !== JSON.stringify(managed)) {
            throw new HelmError('worktree_metadata_secret', `隔离执行元数据包含已登记机密，拒绝持久化；执行标识 ${info.executionId ?? info.conversationId ?? '未知'}`, 400)
          }
          const enriched: AgentExecutionInfo = {
            ...info,
            worktree: {
              ...info.worktree,
              id: managed.id,
              ...(managed.repoRoot !== '' ? { repoRoot: managed.repoRoot } : {}),
              ...(managed.baseCommit !== '' ? { baseCommit: managed.baseCommit, dirtySource: managed.dirtySource } : {}),
            },
          }
          if (info.conversationId !== undefined) {
            this.recordAgentBinding(request.agentId, info.conversationId)
          }
          // 首次回填：开租约（running；后续多次回调幂等更新）。onResolved 是
          // 同步回调无法 await flush：落盘失败不能静默（租约是 crash 窗口内拒绝
          // cleanup 的唯一证据），也不撤销 staged 租约（同进程 isPathInUse 读
          // doc 现值，撤销立即打开清理窗口）——即时 stderr 诊断，结算写同一
          // doc 时会重试整页落盘（settleLease 的 flush 失败仍如实上抛）。
          if (leaseToken === undefined) {
            leaseToken = randomUUID()
            const map = this.listLeases()
            map.set(leaseToken, { phase: 'running', info: enriched, worktreeId: managed.id, createdAt: Date.now() })
            this.saveLeases(map)
            void this.deps.docStore.flush().catch((error: unknown) => {
              process.stderr.write(
                `builtin:workflow: worktree 租约 ${managed.id} 落盘失败（执行期间崩溃将失去清理保护，结算写会重试）: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              )
            })
          } else {
            this.updateLease(leaseToken, enriched)
          }
          execution = enriched
          request.onResolved?.(enriched)
          return
        }
        execution = info
        request.onResolved?.(info)
      },
    }
    try {
      const result = await next(finalRequest)
      if (leaseToken !== undefined) await this.settleLease(leaseToken, true, false)
      return result
    } catch (error) {
      // 外部执行启动与否不可证明（onResolved 未触发不等于未启动）：保留租约。
      if (leaseToken !== undefined) await this.settleLease(leaseToken, false, false).catch(() => {})
      throw error
    }
  }

  // ------------------------------------------------------------------
  // cleanup（插件动作/工具入口）
  // ------------------------------------------------------------------

  /**
   * cleanup 前置租约检查：存在「重启中断或未确认停止」的执行租约时显式
   * worktree_execution_unknown（不能证明外部执行已停止就不能清理）。
   * 在途（宿主 activeSpawnExecutions 命中）的租约由 allocator 的
   * isPathInUse 拒绝（worktree_in_use）。
   */
  assertNoUnknownExecution(nodeId: string, path: string): void {
    const active = new Set(
      this.deps.host.listActiveSpawnExecutions().map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`),
    )
    for (const lease of this.listLeases().values()) {
      const leasePath = this.leasePathOf(lease, nodeId)
      if (leasePath === undefined || !this.contains(path, leasePath)) continue
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
    if (record !== undefined) this.assertNoUnknownExecution(record.nodeId, record.path)
    return this.allocator.cleanup({ ...input, signal })
  }

  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    return this.allocator.getForConversation(conversationId)
  }
}
