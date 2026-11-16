/**
 * durable 租约持久化与占用判定（isolation.ts 拆分模块）。
 *
 * 承载 WorktreeIsolation 的租约/绑定持久层（'worktree-leases' 与
 * 'worktree-agent-bindings' 两个 doc）：租约读写与终态收敛（listLeases /
 * saveLeases / openPendingLease / updateLease / settleLease /
 * settleLeaseAfterNextFailure / clearStaleLeases）、会话存活与路径占用判定
 * （contains / isConversationWorking / isPathInUse / leasePathOf）、resume ref
 * 解析与 agentId 绑定（resolveResumeChildId / recordAgentBinding）、cleanup
 * 前置未知执行检查（assertNoUnknownExecution）。
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
 * 诚实性纪律：会话状态读取错误不当作安全（fail-closed，如实上抛）；机密
 * 元数据拒绝落库。
 */
import { HelmError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { extractWorkflowExecutionMeta } from '../contracts.js'
import type { WorktreeAllocator } from './worktree.js'
import type { WorktreeIsolationDeps } from './isolation.js'

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

const LEASES_DOC_KEY = 'worktree-leases'
const AGENT_BINDINGS_DOC_KEY = 'worktree-agent-bindings'

/**
 * 租约/绑定持久层。allocator 以延迟引用注入：WorktreeIsolation 构造期
 * allocator 与本存储互引（allocator 的占用检查引用本存储，本存储的路径
 * 解析引用 allocator 记录），首次占用判定发生时两者均已构造完成。
 */
export class WorktreeLeaseStore {
  constructor(
    private readonly docStore: WorktreeIsolationDeps['docStore'],
    private readonly host: WorktreeIsolationDeps['host'],
    private readonly allocator: () => WorktreeAllocator,
  ) {}
  // ------------------------------------------------------------------
  // 占用判定（cleanup 拒绝清理在途树；fail-closed）
  // ------------------------------------------------------------------

  contains(path: string, candidate: string): boolean {
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
  isConversationWorking(id: number): boolean {
    const conv = this.host.getConversation(id)
    return conv.status === 'working' || conv.status === 'blocked'
  }

  /**
   * 路径占用：宿主在途 spawn 执行坐标 + 本插件租约（按 worktreeId 关联
   * allocator 记录定位路径，pending 占位同样计入）。
   */
  isPathInUse(nodeId: string, path: string): boolean {
    // 1) 宿主在途 spawn 执行（含外部运行时回传坐标）。
    for (const info of this.host.listActiveSpawnExecutions()) {
      if (info.nodeId !== nodeId) continue
      if (info.effectiveCwd !== undefined && this.contains(path, info.effectiveCwd)) return true
      const wt = extractWorkflowExecutionMeta(info).worktree
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
  leasePathOf(lease: WorktreeLeaseRecord, nodeId: string): string | undefined {
    const record = this.allocator().findActive({ worktreeId: lease.worktreeId })
    if (record !== undefined) return record.nodeId === nodeId ? record.path : undefined
    const prefix = `${nodeId}:`
    return lease.worktreeId.startsWith(prefix) ? lease.worktreeId.slice(prefix.length) : undefined
  }

  // ------------------------------------------------------------------
  // durable 租约
  // ------------------------------------------------------------------

  listLeases(): Map<string, WorktreeLeaseRecord> {
    const raw = this.docStore.get<Record<string, WorktreeLeaseRecord>>(LEASES_DOC_KEY, {})
    return new Map(Object.entries(raw))
  }

  saveLeases(map: Map<string, WorktreeLeaseRecord>): void {
    this.docStore.set(LEASES_DOC_KEY, Object.fromEntries(map))
  }

  /**
   * 占位租约（分配路径专用）：git worktree add 副作用之前登记（经
   * allocator.beforeCreate 回调，先于任何 Git 副作用）并 flush 落盘。
   * worktreeId 即 `${nodeId}:${path}`（与 allocator 登记同构）。
   */
  async openPendingLease(worktreeId: string): Promise<string> {
    const token = randomUUID()
    const map = this.listLeases()
    map.set(token, {
      phase: 'pending',
      info: { nodeId: worktreeId.slice(0, worktreeId.indexOf(':')) || '' },
      worktreeId,
      createdAt: Date.now(),
    })
    this.saveLeases(map)
    await this.docStore.flush()
    return token
  }

  /** onResolved 回填：升级为 running 并记录真实执行坐标（幂等取最新）。 */
  updateLease(token: string, info: AgentExecutionInfo): void {
    const map = this.listLeases()
    const lease = map.get(token)
    if (lease === undefined) return
    map.set(token, { ...lease, phase: 'running', info })
    this.saveLeases(map)
  }

  /**
   * 终态收敛。释放仅限两种确认状态（安全红线）：
   * 1) succeeded = true（执行确认成功，或原生子会话回合确认停止）；
   * 2) neverStarted = true（next 从未被调用/尚未进入执行链就抛错——此时
   *    占位租约自身可证明无执行）。
   * 其余（onResolved 失败、外部进程已启动但未回填 executionId、未知状态）
   * 一律保留租约（fail-closed：不能证明停止就不能允许清理）。
   */
  async settleLease(token: string, succeeded: boolean, neverStarted: boolean): Promise<void> {
    if (!succeeded && !neverStarted) return
    const map = this.listLeases()
    if (!map.has(token)) return
    map.delete(token)
    this.saveLeases(map)
    await this.docStore.flush()
  }

  /**
   * next 抛错后的原生子会话租约释放判定：仅当 onResolved 已回传原生子会话
   * （conversationId 存在且无 executionId——runNativeSpawn 的 finally 已在
   * next 返回前释放会话锁，子会话回合确定已停止）且该会话当前确认不在
   * 运行时释放本次运行租约（保留 Worktree 记录与 agentId 绑定，供下一轮
   * resume 或 cleanup_worktree 使用）；onResolved 未触发、外部执行
   * （executionId）或会话状态不可读一律保留（fail-closed）。
   */
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

  /** 清除指定 worktree 下全部残留租约（resume 确认成功后调用；旧租约只会误阻塞后续 cleanup）。 */
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
    await this.docStore.flush()
  }

  /**
   * 判断租约是否命中宿主当前仍在执行的 spawn（executionId/conversationId 键
   * 或活动路径重叠，防止误删同进程并发重建中的 pending 占位租约）。
   */
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
      if (info.effectiveCwd !== undefined && this.contains(leasePath, info.effectiveCwd)) return true
      const wt = extractWorkflowExecutionMeta(info).worktree
      if (wt !== undefined && this.contains(leasePath, wt.path)) return true
    }
    return false
  }

  /**
   * 启动后回收已确认停止的原生 Worktree 崩溃租约（由 runtime.started 在
   * awaitPreparedChildrenSettled 之后调用）：
   * - 外部运行时租约（executionId !== undefined）与活跃执行保持 fail-closed；
   * - 仅清理两类可证明已无执行的原生租约：
   *   1) phase === 'pending' && executionId === undefined；
   *   2) phase === 'running' && executionId === undefined && conversationId !== undefined，
   *      且底层会话确认非工作态（status !== 'working' && status !== 'blocked'，
   *      或 getConversation 抛 HelmError('not_found')）。
   * 保留 WorktreeAllocator 记录与 agentId 绑定供后续 resume / cleanup_worktree。
   */
  async reconcileStoppedNativeLeases(): Promise<number> {
    const map = this.listLeases()
    if (map.size === 0) return 0
    const activeInfos = this.host.listActiveSpawnExecutions()
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
            // 其余存储读取异常 fail-closed 保留租约，不误清理。
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
    await this.docStore.flush()
    return removed
  }

  // ------------------------------------------------------------------
  // agentId 绑定（resume ref 解析）
  // ------------------------------------------------------------------

  /** resume ref -> childConversationId（纯数字直转；agentId 经绑定表）。 */
  resolveResumeChildId(request: AgentSpawnRequest): number | undefined {
    if (request.resume === undefined) return undefined
    if (/^\d+$/.test(request.resume)) return Number(request.resume)
    const bindings = this.docStore.get<Record<string, number>>(AGENT_BINDINGS_DOC_KEY, {})
    return bindings[request.resume]
  }

  /** agentId -> childId 绑定（spawn 的 onResolved 后记录）。 */
  recordAgentBinding(agentId: string | undefined, childId: number | undefined): void {
    if (agentId === undefined || agentId === '' || childId === undefined) return
    const bindings = this.docStore.get<Record<string, number>>(AGENT_BINDINGS_DOC_KEY, {})
    if (bindings[agentId] === childId) return
    bindings[agentId] = childId
    this.docStore.set(AGENT_BINDINGS_DOC_KEY, bindings)
  }

  /**
   * cleanup 前置租约检查：存在「重启中断或未确认停止」的执行租约时显式
   * worktree_execution_unknown（不能证明外部执行已停止就不能清理）。
   * 在途（宿主 activeSpawnExecutions 命中）的租约由 allocator 的
   * isPathInUse 拒绝（worktree_in_use）。
   */
  assertNoUnknownExecution(nodeId: string, path: string): void {
    const active = new Set(
      this.host.listActiveSpawnExecutions().map((info) => `${info.executionId ?? ''}\u0000${info.conversationId ?? ''}`),
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
}
