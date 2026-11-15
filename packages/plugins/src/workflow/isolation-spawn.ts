/**
 * agent_spawn 隔离生命周期三个流程（isolation.ts 拆分模块；安全红线见
 * isolation-lease-store.ts 模块头）：
 * - `spawnWithWorktree`：新建 + isolation: 'worktree'（占位租约副作用前 ->
 *   分配 -> 改写 cwd -> next -> 终态收敛；next 前任何失败都标记
 *   neverStarted，next 后一律 fail-closed 保留）；
 * - `resumeWithWorktree`：resume + 旧绑定（严格沿用原树，禁止中途迁移
 *   节点/cwd；占位租约先于远端验证打开；目录缺失显式失败）；
 * - `trackWithoutPreallocation`：外部运行时 / 普通派生（不预分配；
 *   onResolved 回传 worktree 时登记 + 租约；请求了 isolation 但外部运行时
 *   未兑现：显式拒绝）。
 *
 * 诚实性纪律：Profile 读取 IO 错误如实上抛（仅 not_found 视为 Profile 不
 * 存在）；节点探测失败不当作目录缺失；机密元数据拒绝落库。
 */
import {
  HelmError,
  redactJsonValue,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
} from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { extractWorkflowExecutionMeta, workflowExecutionMeta, type WorktreeExecutionDescriptor } from '../contracts.js'
import { WorktreeLeaseStore } from './isolation-lease-store.js'
import type { ManagedWorktreeRecord, WorktreeAllocator } from './worktree.js'
import type { WorktreeIsolationDeps } from './isolation.js'

/** 生命周期流程所需的最小上下文（由 WorktreeIsolation 组装注入）。 */
export interface IsolationSpawnContext {
  deps: WorktreeIsolationDeps
  allocator: WorktreeAllocator
  leases: WorktreeLeaseStore
}

/**
 * 每次启动注入的 worktree 上下文（新建与 resume 均生效）：携带 worktree 元
 * 信息（worktreeId/path/branch/baseCommit/baseBranch/parentWorktreeId）与
 * dirtySource 诚实提示，提醒子代理在结束回合前 git add + git commit 提交
 * 全部改动（未提交内容会阻塞 cleanup 且不随树合入）。
 */
function worktreeContextPrompt(record: ManagedWorktreeRecord): string {
  const lines = [
    '当前工作目录为独立 Git Worktree：',
    `- worktreeId: ${record.id}`,
    `- path: ${record.path}`,
    `- branch: ${record.branch}`,
    ...(record.baseCommit !== '' ? [`- baseCommit: ${record.baseCommit.slice(0, 12)}`] : []),
    ...(record.baseBranch !== undefined && record.baseBranch !== '' ? [`- baseBranch: ${record.baseBranch}`] : []),
    ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
      ? [`- parentWorktreeId: ${record.parentWorktreeId}`]
      : []),
    record.dirtySource
      ? '- 注意：源工作区存在未提交修改，本隔离工作树基于源 HEAD 创建，不包含源工作区未提交的改动。'
      : '- 源工作区干净。',
    '请在结束回合前运行 git add 与 git commit 提交全部改动，保持工作区干净。',
  ]
  return `\n\n<worktree_context>\n${lines.join('\n')}\n</worktree_context>`
}

/**
 * 把受管 worktree 描述写进 execution meta 的 workflow 命名空间：合并保留
 * 信封其余字段、其他插件命名空间与 workflow 命名空间未提及的既有键（如
 * 外部运行时回传的 controls）；本层是原生路径 worktree 业务值的唯一生产方。
 */
function withWorktreeExecutionMeta(
  info: AgentExecutionInfo,
  worktree: WorktreeExecutionDescriptor,
): AgentExecutionInfo {
  return { ...info, meta: workflowExecutionMeta({ worktree }, info.meta) }
}

  /**
   * 新建 + isolation: 'worktree'：占位租约（副作用前）-> 分配 -> 改写 cwd ->
   * next -> 终态收敛。next 前任何失败都标记 neverStarted（占位可安全释放）；
   * next 后（含 next 抛错）一律 fail-closed 保留。
   */
export async function spawnWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  // 最终节点与源目录解析（内核权威：与原生执行行同构链；IO/不存在错误如实上抛）。
  const profileId = request.agentType || 'assistant'
  const target = await ctx.deps.host.resolveSpawnTarget({
    parentConversationId: request.parentConversationId,
    profileId,
    ...(request.cwd !== undefined ? { requestCwd: request.cwd } : {}),
  })
  const sourceCwd = target.sourceCwd
  let leaseToken = ''
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    const record = await ctx.allocator.allocate({
      nodeId: target.nodeId,
      sourceCwd,
      parentConversationId: request.parentConversationId,
      signal: request.signal,
      beforeCreate: async (pending) => {
        // git worktree add 之前持久占位（worktreeId 与 allocator 登记同构）。
        leaseToken = await ctx.leases.openPendingLease(`${pending.nodeId}:${pending.path}`)
      },
    })
    // 每次启动都注入 worktree 上下文（含元信息与 dirtySource 诚实提示；
    // 提醒结束回合前提交全部改动）。隔离树基于 HEAD 创建，不含源工作区
    // 未提交改动的事实由 dirtySource 行如实说明。
    const finalRequest: AgentSpawnRequest = {
      ...request,
      cwd: record.path,
      isolation: undefined,
      prompt: `${request.prompt}${worktreeContextPrompt(record)}`,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        const enriched: AgentExecutionInfo = withWorktreeExecutionMeta(
          { ...info, nodeId: info.nodeId ?? target.nodeId },
          {
            path: record.path,
            branch: record.branch,
            id: record.id,
            ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
            ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
            ...(record.baseBranch !== undefined && record.baseBranch !== '' ? { baseBranch: record.baseBranch } : {}),
            ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
              ? { parentWorktreeId: record.parentWorktreeId }
              : {}),
          },
        )
        if (info.conversationId !== undefined) {
          ctx.allocator.bindConversation(record.path, record.nodeId, info.conversationId)
          ctx.leases.recordAgentBinding(request.agentId, info.conversationId)
        }
        ctx.leases.updateLease(leaseToken, enriched)
        execution = enriched
        request.onResolved?.(enriched)
      },
    }
    enteredNext = true
    const result = await next(finalRequest)
    await ctx.leases.settleLease(leaseToken, true, false)
    return result
  } catch (error) {
    // next 前失败（分配失败/目标解析失败）：占位租约可证明无执行，安全释放。
    // next 后失败：原生子会话且已确认停止时同样释放（保留 Worktree 记录与
    // agentId 绑定供 resume/cleanup）；其余不确定状态保留租约 fail-closed。
    await (enteredNext
      ? ctx.leases.settleLeaseAfterNextFailure(leaseToken, execution)
      : ctx.leases.settleLease(leaseToken, false, true)
    ).catch(() => {})
    throw error
  }
}

  /** resume + 旧绑定：沿用原树（禁止中途迁移节点/cwd）；目录缺失显式失败。 */
export async function resumeWithWorktree(
  ctx: IsolationSpawnContext,
  request: AgentSpawnRequest,
  childId: number,
  record: ManagedWorktreeRecord,
  next: (finalRequest: AgentSpawnRequest) => Promise<unknown>,
): Promise<unknown> {
  if (record.status === 'removed') {
    throw new HelmError('worktree_missing', `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`, 409)
  }
  const conv = ctx.deps.host.getConversation(childId) // 错误如实上抛
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
  const leaseToken = await ctx.leases.openPendingLease(record.id)
  let enteredNext = false
  let execution: AgentExecutionInfo | undefined
  try {
    await ctx.allocator.verifyForResume(record, request.cwd, request.signal)
    // 每次启动都注入 worktree 上下文（与新建同构；resume 续接同样携带元
    // 信息与提交提醒）。
    const finalRequest: AgentSpawnRequest = {
      ...request,
      cwd: record.path,
      isolation: undefined,
      prompt: `${request.prompt}${worktreeContextPrompt(record)}`,
      onResolved: (raw) => {
        const info = sanitizeExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
        const enriched: AgentExecutionInfo = withWorktreeExecutionMeta(
          { ...info, nodeId: info.nodeId ?? record.nodeId },
          {
            path: record.path,
            branch: record.branch,
            id: record.id,
            ...(record.repoRoot !== '' ? { repoRoot: record.repoRoot } : {}),
            ...(record.baseCommit !== '' ? { baseCommit: record.baseCommit, dirtySource: record.dirtySource } : {}),
            ...(record.baseBranch !== undefined && record.baseBranch !== '' ? { baseBranch: record.baseBranch } : {}),
            ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
              ? { parentWorktreeId: record.parentWorktreeId }
              : {}),
          },
        )
        ctx.leases.updateLease(leaseToken, enriched)
        execution = enriched
        request.onResolved?.(enriched)
      },
    }
    enteredNext = true
    const result = await next(finalRequest)
    await ctx.leases.settleLease(leaseToken, true, false)
    // resume 确认成功：该 worktree 下此前失败/中断轮次残留的旧租约一并
    // 清除（本次执行已确认成功，残留租约只会以 worktree_execution_unknown
    // 误阻塞后续 cleanup）。清理失败不改变 resume 结果，stderr 如实诊断。
    await ctx.leases.clearStaleLeases(record.id).catch((error: unknown) => {
      process.stderr.write(
        `builtin:workflow: worktree ${record.id} 残留租约清理失败（后续 cleanup 可能被 worktree_execution_unknown 阻塞，可重试 resume 或人工核对）: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
    return result
  } catch (error) {
    // 与新建同构：next 前失败释放占位；next 后原生子会话确认停止即释放，
    // 其余不确定状态保留租约 fail-closed。
    await (enteredNext
      ? ctx.leases.settleLeaseAfterNextFailure(leaseToken, execution)
      : ctx.leases.settleLease(leaseToken, false, true)
    ).catch(() => {})
    throw error
  }
}

  /**
   * 外部运行时 / 普通派生：不预分配；onResolved 回传 worktree 时登记 + 租约。
   * 终态收敛：成功释放；失败保留（外部执行启动与否不可证明——onResolved
   * 未触发不等于未启动）。请求了 isolation 但外部运行时未兑现：显式拒绝。
   */
export async function trackWithoutPreallocation(
  ctx: IsolationSpawnContext,
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
      const externalWorktree = extractWorkflowExecutionMeta(info).worktree
      if (externalWorktree !== undefined) {
        if (info.nodeId === undefined) {
          throw new HelmError('execution_info_invalid', '隔离工作树必须回传实际 nodeId，不能推测外部运行时的节点', 502)
        }
        const managed =
          ctx.allocator.findActive({ path: externalWorktree.path, nodeId: info.nodeId }) ??
          ctx.allocator.registerExternal({
            nodeId: info.nodeId,
            path: externalWorktree.path,
            branch: externalWorktree.branch,
            parentConversationId: request.parentConversationId,
            ...(info.conversationId !== undefined ? { conversationId: info.conversationId } : {}),
            ...(info.executionId !== undefined ? { executionId: info.executionId } : {}),
          })
        // 机密检查：元数据将落库，含已登记机密显式拒绝。
        const safe = redactJsonValue(managed, (text) => ctx.deps.host.redact(text))
        if (JSON.stringify(safe) !== JSON.stringify(managed)) {
          throw new HelmError('worktree_metadata_secret', `隔离执行元数据包含已登记机密，拒绝持久化；执行标识 ${info.executionId ?? info.conversationId ?? '未知'}`, 400)
        }
        const enriched: AgentExecutionInfo = withWorktreeExecutionMeta(info, {
          ...externalWorktree,
          id: managed.id,
          ...(managed.repoRoot !== '' ? { repoRoot: managed.repoRoot } : {}),
          ...(managed.baseCommit !== '' ? { baseCommit: managed.baseCommit, dirtySource: managed.dirtySource } : {}),
        })
        if (info.conversationId !== undefined) {
          ctx.leases.recordAgentBinding(request.agentId, info.conversationId)
        }
        // 首次回填：开租约（running；后续多次回调幂等更新）。onResolved 是
        // 同步回调无法 await flush：落盘失败不能静默（租约是 crash 窗口内拒绝
        // cleanup 的唯一证据），也不撤销 staged 租约（同进程 isPathInUse 读
        // doc 现值，撤销立即打开清理窗口）——即时 stderr 诊断，结算写同一
        // doc 时会重试整页落盘（settleLease 的 flush 失败仍如实上抛）。
        if (leaseToken === undefined) {
          leaseToken = randomUUID()
          const map = ctx.leases.listLeases()
          map.set(leaseToken, { phase: 'running', info: enriched, worktreeId: managed.id, createdAt: Date.now() })
          ctx.leases.saveLeases(map)
          void ctx.deps.docStore.flush().catch((error: unknown) => {
            process.stderr.write(
              `builtin:workflow: worktree 租约 ${managed.id} 落盘失败（执行期间崩溃将失去清理保护，结算写会重试）: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          })
        } else {
          ctx.leases.updateLease(leaseToken, enriched)
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
    if (leaseToken !== undefined) await ctx.leases.settleLease(leaseToken, true, false)
    return result
  } catch (error) {
    // 外部执行启动与否不可证明（onResolved 未触发不等于未启动）：保留租约。
    if (leaseToken !== undefined) await ctx.leases.settleLease(leaseToken, false, false).catch(() => {})
    throw error
  }
}
