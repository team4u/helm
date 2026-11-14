import {
  HelmError,
  type HelmPluginContext,
  type PluginToolContext,
} from '@helm/protocol'
import {
  ROUTER_TOOL_SCOPE,
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_IDS,
  WORKER_ARCHIVED_TAG,
  WORKER_TAG,
  isAbsoluteTargetPath,
  type SuperAgentCoordinator,
  type SuperAgentWorker,
} from './contracts.js'
import { searchRecallNodes } from './recall.js'
import { recentEntrySummaries } from './settlement.js'

export interface DispatchInput {
  prompt: string
  profileId?: string
  title?: string
  threadKey?: string
  cwd?: string
  nodeId?: string
}

/** 执行会话二次校验：scope 之外再核实际 router 会话（防同 Profile 人类直聊滥用）。 */
export function assertRouterAuthority(
  conversationId: number | undefined,
  routerConversationId: number | undefined,
): void {
  if (conversationId === undefined) return // 人工 HTTP/CLI 调用：无会话上下文放行
  if (conversationId !== routerConversationId) {
    throw new HelmError(
      'conversation_scope_violation',
      `该操作仅允许在 SuperAgent 中枢会话内执行，当前会话 #${conversationId} 不是中枢`,
      403,
      { pluginId: SUPERAGENT_PLUGIN_ID, conversationId },
    )
  }
}

export function assertThreadKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed === '' || trimmed.length > 200) {
    throw new HelmError('validation_error', `threadKey 非法（需 1..200 字符，收到：${key}）`, 400, {})
  }
  return trimmed
}

export function assertWorkerConversationId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HelmError('validation_error', `workerConversationId 必须是正整数（收到：${String(value)}）`, 400, {})
  }
  return value
}

/** Profile ID：非空、无空白、无路径分隔符（防目录穿越）；存在性由调用处核验。 */
export function assertProfileId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
    throw new HelmError('validation_error', `profileId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`, 400, {})
  }
  return trimmed
}

/** Worker 工作目录：显式给出则必须是跨平台绝对路径（POSIX `/`、
 * Windows 盘符 `C:\\...` / `C:/...`、UNC `\\\\server\\share`），
 * 目标节点可能与 Hub 异平台，不得用宿主 node:path 规则判定。 */
export function assertWorkerCwd(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || !isAbsoluteTargetPath(trimmed)) {
    throw new HelmError(
      'validation_error',
      `cwd 必须是跨平台绝对路径（POSIX / 开头、Windows 盘符或 UNC；收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}

/** Worker 绑定节点：非空、无空白、无路径分隔符（防目录注入）；
 * 存在性由 createConversation 靶点解析链处理，不在此硬编码节点清单。 */
export function assertWorkerNodeId(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
    throw new HelmError(
      'validation_error',
      `nodeId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`,
      400,
      {},
    )
  }
  return trimmed
}

/** workerConversationId 共享约束：正整数。 */
export const workerIdSchema: Record<string, unknown> = { type: 'integer', minimum: 1 }

export const workerIdInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: { workerConversationId: workerIdSchema },
  required: ['workerConversationId'],
  additionalProperties: false,
}

export const dispatchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1 },
    profileId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    threadKey: { type: 'string', minLength: 1, maxLength: 200 },
    cwd: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
  },
  required: ['prompt'],
  additionalProperties: false,
}

export function registerSuperAgentActions(
  ctx: HelmPluginContext,
  coordinator: SuperAgentCoordinator,
): void {
  const {
    getRouterConversationId,
    readIndex,
    readSubscriptions,
    updateIndex,
    updateSubscriptions,
    isRegisteredWorker,
    readConversationOrUndefined,
    reportError,
    syncRoutingDoc,
    enqueueDispatch,
    settlingWorkers,
  } = coordinator

  const dispatchWorker = async (
    input: DispatchInput,
    conversationId: number | undefined,
  ): Promise<{ workerConversationId: number }> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      throw new HelmError('validation_error', 'dispatch_worker 需要 prompt（非空文本）', 400, {})
    }
    const routerConversationId = getRouterConversationId()
    if (routerConversationId === undefined) {
      throw new HelmError('superagent_not_ready', 'SuperAgent 中枢尚未自举完成', 409, {
        pluginId: SUPERAGENT_PLUGIN_ID,
      })
    }
    const targetProfile = input.profileId === undefined ? 'assistant' : assertProfileId(input.profileId)
    if (SUPERAGENT_PROFILE_IDS.includes(targetProfile)) {
      throw new HelmError(
        'validation_error',
        `dispatch_worker 禁止派生中枢/看门狗 Profile（${targetProfile}），避免自激`,
        400,
        { profileId: targetProfile },
      )
    }
    if ((await ctx.host.profiles.get(targetProfile)) === undefined) {
      throw new HelmError('validation_error', `Profile 不存在：${targetProfile}`, 400, { profileId: targetProfile })
    }
    const threadKey = input.threadKey === undefined ? undefined : assertThreadKey(input.threadKey)
    const title =
      input.title !== undefined && input.title.trim() !== ''
        ? input.title.trim().slice(0, 80)
        : `Worker: ${input.prompt.slice(0, 24)}`
    const cwd = input.cwd === undefined ? undefined : assertWorkerCwd(input.cwd)
    const nodeId = input.nodeId === undefined ? undefined : assertWorkerNodeId(input.nodeId)

    return enqueueDispatch(async () => {
      if (threadKey !== undefined) {
        const existing = readSubscriptions().subscriptions.find((s) => s.threadKey === threadKey)
        if (existing !== undefined) {
          if (isRegisteredWorker(existing.workerConversationId)) {
            throw new HelmError(
              'superagent_thread_key_conflict',
              `threadKey '${threadKey}' 已被 Worker #${existing.workerConversationId} 订阅；如需改绑请先 archive_worker 解绑`,
              409,
              { threadKey, workerConversationId: existing.workerConversationId },
            )
          }
          updateSubscriptions((doc) => ({
            ...doc,
            subscriptions: doc.subscriptions.filter((s) => s.threadKey !== threadKey),
          }))
        }
      }
      const worker = await ctx.host.createConversation({
        title,
        profileId: targetProfile,
        tags: [WORKER_TAG],
        parentConversationId: routerConversationId,
        ...(nodeId !== undefined ? { nodeId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      })
      const workerEntry: SuperAgentWorker = {
        conversationId: worker.id,
        parentConversationId: routerConversationId,
        profileId: targetProfile,
        createdAt: Date.now(),
      }
      try {
        ctx.host.markConversationOwnership(worker.id, 'helm')
        updateIndex((doc) => ({ ...doc, workers: [...doc.workers, workerEntry] }))
        if (threadKey !== undefined) {
          updateSubscriptions((doc) => ({
            ...doc,
            subscriptions: [...doc.subscriptions, { threadKey, workerConversationId: worker.id, createdAt: Date.now() }],
          }))
        }
        await ctx.host.submitInput(worker.id, input.prompt, { origin: 'agent', whenBusy: 'followUp' })
      } catch (err) {
        reportError(`Worker #${worker.id} 派工提交失败（登记/提交阶段，回滚中）`, err)
        await rollbackFailedDispatch(worker.id, workerEntry, threadKey, err)
        throw err
      }
      return { workerConversationId: worker.id }
    })
  }

  const rollbackFailedDispatch = async (
    workerId: number,
    workerEntry: SuperAgentWorker,
    threadKey: string | undefined,
    cause: unknown,
  ): Promise<void> => {
    const failures: unknown[] = []
    try {
      updateIndex((doc) => ({ ...doc, workers: doc.workers.filter((w) => w.conversationId !== workerEntry.conversationId) }))
    } catch (err) {
      failures.push(err)
    }
    if (threadKey !== undefined) {
      try {
        updateSubscriptions((doc) => ({
          ...doc,
          subscriptions: doc.subscriptions.filter((s) => s.threadKey !== threadKey),
        }))
      } catch (err) {
        failures.push(err)
      }
    }
    try {
      const fresh = readConversationOrUndefined(workerId)
      const nextTags = [...(fresh?.tags.filter((t) => t !== WORKER_TAG) ?? []), WORKER_ARCHIVED_TAG]
      await ctx.host.updateConversation(workerId, { tags: nextTags })
    } catch (err) {
      failures.push(err)
    }
    if (failures.length > 0) {
      throw new HelmError(
        'superagent_dispatch_rollback_failed',
        `Worker #${workerId} 提交失败后回滚不完整（${failures.length} 项）：原始错误 ${cause instanceof Error ? cause.message : String(cause)}；回滚错误 ${failures.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}，请人工核对 index/subscriptions doc`,
        500,
        { workerId, threadKey, rollbackFailures: failures.map((e) => (e instanceof Error ? e.message : String(e))) },
      )
    }
  }

  const inspectWorker = async (
    input: { workerConversationId: number },
    conversationId: number | undefined,
  ): Promise<Record<string, unknown>> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    const workerId = assertWorkerConversationId(input.workerConversationId)
    if (!isRegisteredWorker(workerId)) {
      throw new HelmError('not_found', `会话 #${workerId} 不是已登记的后台 Worker`, 404, {
        workerConversationId: workerId,
      })
    }
    const detail = await ctx.host.getConversationDetail(workerId, { limit: 20 })
    const artifacts = await ctx.host.listArtifacts(workerId)
    const summaries = recentEntrySummaries(ctx.host, detail.entries)
    return {
      conversationId: detail.id,
      title: detail.title,
      profileId: detail.profileId,
      status: detail.status,
      doing: detail.doing ?? null,
      completionSeq: detail.completionSeq,
      artifacts: artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size })),
      recentEntries: summaries,
    }
  }

  const recallContext = async (
    input: { query?: string; limit?: number },
    conversationId: number | undefined,
  ): Promise<{ nodes: unknown[] }> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    const limit = input.limit === undefined ? 10 : input.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new HelmError('validation_error', `limit 必须是 1..100 整数（收到：${String(input.limit)}）`, 400, {})
    }
    const query = input.query === undefined ? '' : String(input.query)
    return { nodes: searchRecallNodes(coordinator.getDocs().recall.get(), query, limit) }
  }

  const subscribeThread = async (
    input: { threadKey: string; workerConversationId: number },
    conversationId: number | undefined,
  ): Promise<{ threadKey: string; workerConversationId: number }> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    const key = assertThreadKey(input.threadKey)
    const workerId = assertWorkerConversationId(input.workerConversationId)
    if (!isRegisteredWorker(workerId)) {
      throw new HelmError('not_found', `会话 #${workerId} 不是已登记的后台 Worker`, 404, {
        workerConversationId: workerId,
      })
    }
    return enqueueDispatch(async () => {
      if (!isRegisteredWorker(workerId)) {
        throw new HelmError('not_found', `会话 #${workerId} 已不是活跃 Worker`, 404, {
          workerConversationId: workerId,
        })
      }
      const existing = readSubscriptions().subscriptions.find((s) => s.threadKey === key)
      if (existing !== undefined) {
        if (existing.workerConversationId === workerId) {
          return { threadKey: key, workerConversationId: workerId } // 幂等重订
        }
        if (isRegisteredWorker(existing.workerConversationId)) {
          throw new HelmError(
            'superagent_thread_key_conflict',
            `threadKey '${key}' 已被 Worker #${existing.workerConversationId} 订阅，拒绝静默抢占`,
            409,
            { threadKey: key, currentWorkerConversationId: existing.workerConversationId },
          )
        }
        updateSubscriptions((doc) => ({
          ...doc,
          subscriptions: doc.subscriptions.filter((s) => s.threadKey !== key),
        }))
      }
      updateSubscriptions((doc) => ({
        ...doc,
        subscriptions: [...doc.subscriptions, { threadKey: key, workerConversationId: workerId, createdAt: Date.now() }],
      }))
      return { threadKey: key, workerConversationId: workerId }
    })
  }

  const archiveWorker = async (
    input: { workerConversationId: number },
    conversationId: number | undefined,
  ): Promise<{ archived: true }> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    const workerId = assertWorkerConversationId(input.workerConversationId)
    const summary = readConversationOrUndefined(workerId)
    const registered = readIndex().workers.some((w) => w.conversationId === workerId)
    if (summary === undefined || !registered || !summary.tags.includes(WORKER_TAG)) {
      throw new HelmError('not_found', `会话 #${workerId} 不是 builtin:superagent 登记的后台 Worker`, 404, {
        workerConversationId: workerId,
      })
    }
    if (summary.tags.includes(WORKER_ARCHIVED_TAG)) return { archived: true }
    if (summary.status === 'working' || summary.status === 'blocked' || settlingWorkers.has(workerId)) {
      throw new HelmError(
        'superagent_worker_busy',
        settlingWorkers.has(workerId) && summary.status !== 'working' && summary.status !== 'blocked'
          ? `Worker #${workerId} 正在结算上一回合（写记忆图谱/汇报中枢），拒绝归档`
          : `Worker #${workerId} 当前状态为 ${summary.status}，拒绝归档（先 abort 或等待回合结束）`,
        409,
        { workerConversationId: workerId, status: summary.status },
      )
    }
    return enqueueDispatch(async () => {
      const fresh = readConversationOrUndefined(workerId)
      if (fresh === undefined || !fresh.tags.includes(WORKER_TAG)) {
        throw new HelmError('not_found', `会话 #${workerId} 已不是活跃 Worker`, 404, { workerConversationId: workerId })
      }
      if (fresh.status === 'working' || fresh.status === 'blocked' || settlingWorkers.has(workerId)) {
        throw new HelmError(
          'superagent_worker_busy',
          `Worker #${workerId} 已进入运行（${fresh.status}）或正在结算，拒绝归档`,
          409,
          { workerConversationId: workerId, status: fresh.status },
        )
      }
      const nextTags = [...fresh.tags.filter((t) => t !== WORKER_TAG), WORKER_ARCHIVED_TAG]
      await ctx.host.updateConversation(workerId, { tags: nextTags })
      updateIndex((doc) => ({ ...doc, workers: doc.workers.filter((w) => w.conversationId !== workerId) }))
      updateSubscriptions((doc) => ({
        ...doc,
        subscriptions: doc.subscriptions.filter((s) => s.workerConversationId !== workerId),
      }))
      return { archived: true }
    })
  }

  const setRouterMode = async (
    input: { enabled: boolean },
    conversationId: number | undefined,
  ): Promise<{ routerMode: boolean }> => {
    assertRouterAuthority(conversationId, getRouterConversationId())
    if (typeof input.enabled !== 'boolean') {
      throw new HelmError('validation_error', 'enabled 必须是布尔值', 400, {})
    }
    await ctx.host.setConfig({ routerMode: input.enabled })
    const applied = coordinator.getConfig()
    syncRoutingDoc()
    return { routerMode: applied.routerMode }
  }

  // ---- ctx.tool：精确短名（scope + 执行期二次校验双保险） ----
  const registerRouterTool = <TIn>(spec: {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    execute: (input: TIn, context: PluginToolContext) => unknown
  }): void => {
    ctx.tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      scope: ROUTER_TOOL_SCOPE,
      execute: (input: never, context: PluginToolContext) => spec.execute(input as TIn, context),
    })
  }

  registerRouterTool({
    name: 'dispatch_worker',
    description:
      '非阻塞派生后台 Worker 会话执行任务（立即返回 workerConversationId，不等模型回合结束）。可选 profileId 点将专家 Profile、threadKey 绑定事件订阅。',
    inputSchema: dispatchInputSchema,
    execute: (input: DispatchInput, context) => dispatchWorker(input, context.conversationId),
  })
  registerRouterTool({
    name: 'inspect_worker',
    description: '读取后台 Worker 最近时间线摘要与产物列表。',
    inputSchema: workerIdInputSchema,
    execute: (input: { workerConversationId: number }, context) => inspectWorker(input, context.conversationId),
  })
  registerRouterTool({
    name: 'recall_context',
    description: '检索 RecallGraph 记忆图谱（按关键词过滤历史任务摘要节点，多词 AND）。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    execute: (input: { query?: string; limit?: number }, context) => recallContext(input, context.conversationId),
  })
  registerRouterTool({
    name: 'subscribe_thread',
    description: '将 threadKey 事件订阅绑定到指定后台 Worker（冲突显式拒绝，不抢占）。',
    inputSchema: {
      type: 'object',
      properties: { threadKey: { type: 'string', minLength: 1, maxLength: 200 }, workerConversationId: workerIdSchema },
      required: ['threadKey', 'workerConversationId'],
      additionalProperties: false,
    },
    execute: (input: { threadKey: string; workerConversationId: number }, context) =>
      subscribeThread(input, context.conversationId),
  })

  // ---- ctx.action：HTTP/CLI/Workflow 五端复用同 handler ----
  ctx.action({
    id: 'dispatch_worker',
    description: '非阻塞派生后台 Worker（中枢会话或人工 HTTP/CLI 调用）。',
    inputSchema: dispatchInputSchema,
    outputSchema: {
      type: 'object',
      properties: { workerConversationId: { type: 'number' } },
      required: ['workerConversationId'],
      additionalProperties: false,
    },
    handler: (input: DispatchInput, context) => dispatchWorker(input, context.conversationId),
  })
  ctx.action({
    id: 'inspect_worker',
    description: '读取后台 Worker 最近时间线摘要与产物列表。',
    idempotent: true,
    inputSchema: workerIdInputSchema,
    outputSchema: { type: 'object' },
    handler: (input: { workerConversationId: number }, context) => inspectWorker(input, context.conversationId),
  })
  ctx.action({
    id: 'recall_context',
    description: '检索 RecallGraph 记忆图谱。',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    handler: (input: { query?: string; limit?: number }, context) => recallContext(input, context.conversationId),
  })
  ctx.action({
    id: 'subscribe_thread',
    description: '将 threadKey 事件订阅绑定到指定后台 Worker。',
    inputSchema: {
      type: 'object',
      properties: { threadKey: { type: 'string', minLength: 1, maxLength: 200 }, workerConversationId: workerIdSchema },
      required: ['threadKey', 'workerConversationId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    handler: (input: { threadKey: string; workerConversationId: number }, context) =>
      subscribeThread(input, context.conversationId),
  })
  ctx.action({
    id: 'archive_worker',
    description: '归档已完成 Worker：解绑订阅并把 worker 标签换为 worker-archived（中枢会话或人工调用）。',
    inputSchema: workerIdInputSchema,
    outputSchema: {
      type: 'object',
      properties: { archived: { type: 'boolean' } },
      required: ['archived'],
      additionalProperties: false,
    },
    handler: (input: { workerConversationId: number }, context) => archiveWorker(input, context.conversationId),
  })
  ctx.action({
    id: 'set_router_mode',
    description: '持久修改中枢路由收敛模式（写入插件配置 routerMode，即时生效）。',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { routerMode: { type: 'boolean' } },
      required: ['routerMode'],
      additionalProperties: false,
    },
    handler: (input: { enabled: boolean }, context) => setRouterMode(input, context.conversationId),
  })
}
