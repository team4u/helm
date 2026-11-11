import {
  HelmError,
  type HelmPluginContext,
} from '@helm/protocol'
import {
  parseMutedSources,
  ROUTER_BLOCKED_TOOL_NAMES,
  WORKER_REPORT_RENDERER,
  WORKER_TAG,
  type RecallNode,
  type SuperAgentCoordinator,
} from './contracts.js'
import { recallHasNode, updateRecallDoc } from './recall.js'
import { collectWorkerSettlement, escapeXmlAttribute } from './settlement.js'

export function activeWorkersSection(
  ctx: HelmPluginContext,
  coordinator: SuperAgentCoordinator,
): string {
  const workers = coordinator.readIndex().workers
  if (workers.length === 0) return '<active_workers>\n（当前无活跃后台 Worker）\n</active_workers>'
  const lines = workers.map((w) => {
    let status = 'unknown'
    let doing = ''
    try {
      const summary = ctx.host.getConversation(w.conversationId)
      status = summary.status
      doing = summary.doing ?? ''
    } catch (err) {
      if (err instanceof HelmError && err.code === 'not_found') status = 'deleted'
      else throw err
    }
    const detail = doing !== '' ? ` doing="${escapeXmlAttribute(ctx.host.redact(doing))}"` : ''
    return `<worker id="${w.conversationId}" profile="${escapeXmlAttribute(w.profileId)}" status="${status}"${detail} />`
  })
  return `<active_workers>\n${lines.join('\n')}\n</active_workers>`
}

export function registerSuperAgentHooks(
  ctx: HelmPluginContext,
  coordinator: SuperAgentCoordinator,
): void {
  const {
    isActive,
    isShutdown,
    getConfig,
    getRouterConversationId,
    getWatchdogConversationId,
    readIndex,
    readSubscriptions,
    updateSubscriptions,
    isRegisteredWorker,
    readConversationOrUndefined,
    reportError,
    settlingWorkers,
    rewindEpochs,
    getDocs,
  } = coordinator

  // ------------------------------------------------------------------
  // trigger：L0 确定性路由
  // ------------------------------------------------------------------
  ctx.hook.onTrigger((envelope) => {
    if (!isActive()) return
    const config = getConfig()
    if (parseMutedSources(config.mutedSources).has(envelope.source)) {
      return { action: 'handled' }
    }
    if (envelope.threadKey !== undefined && envelope.threadKey !== '') {
      const sub = readSubscriptions().subscriptions.find((s) => s.threadKey === envelope.threadKey)
      if (sub !== undefined) {
        if (isRegisteredWorker(sub.workerConversationId)) {
          return { action: 'transform', value: { ...envelope, targetConversationId: sub.workerConversationId } }
        }
        updateSubscriptions((doc) => ({
          ...doc,
          subscriptions: doc.subscriptions.filter((s) => s.threadKey !== envelope.threadKey),
        }))
      }
    }
    if (envelope.targetConversationId !== undefined) return
    const target = getRouterConversationId()
    if (target === undefined || ctx.host.isClosing) return
    return { action: 'transform', value: { ...envelope, targetConversationId: target } }
  })

  // ------------------------------------------------------------------
  // before_turn：中枢工具收敛 + active_workers 态势；tool_call 二次守卫
  // ------------------------------------------------------------------
  ctx.hook.onBeforeTurn((turn) => {
    if (!isActive()) return
    if (turn.conversation.id !== getRouterConversationId()) return
    if (!getConfig().routerMode) return
    const tools = turn.tools.filter((t) => !ROUTER_BLOCKED_TOOL_NAMES.has(t.name))
    const sections = [...turn.sections, { id: 'superagent.active_workers', text: activeWorkersSection(ctx, coordinator) }]
    return { action: 'transform', value: { ...turn, tools, sections } }
  })

  ctx.hook.onToolCall((payload) => {
    if (!isActive()) return
    if (payload.conversationId !== getRouterConversationId()) return
    if (!getConfig().routerMode) return
    if (!ROUTER_BLOCKED_TOOL_NAMES.has(payload.toolName)) return
    return {
      action: 'block',
      reason: `中枢路由模式已剥离重度阻塞工具 ${payload.toolName}；请改用 dispatch_worker 派工执行`,
    }
  })

  // ------------------------------------------------------------------
  // turn_settled：origin 汇报 + RecallGraph（三态统一）
  // ------------------------------------------------------------------
  ctx.hook.onTurnSettled(async (payload) => {
    if (!isActive()) return
    const conversation = payload.conversation
    if (conversation.id === getRouterConversationId()) return
    if (conversation.id === getWatchdogConversationId()) return
    if (!readIndex().workers.some((w) => w.conversationId === conversation.id)) return
    const current = readConversationOrUndefined(conversation.id)
    if (current === undefined || !current.tags.includes(WORKER_TAG)) return

    const nodeId = `${conversation.id}:${conversation.completionSeq}`
    if (recallHasNode(getDocs().recall.get(), nodeId)) return

    settlingWorkers.set(conversation.id, (settlingWorkers.get(conversation.id) ?? 0) + 1)
    try {
      const hasAgentOrTrigger = payload.inputs.some((i) => i.origin === 'agent' || i.origin === 'trigger')
      const inputIds = [...new Set(payload.inputs.map((i) => i.id))]
      const epochAtStart = rewindEpochs.get(conversation.id) ?? 0
      const { summary, artifacts, keywords } = await collectWorkerSettlement(ctx.host, payload)
      if ((rewindEpochs.get(conversation.id) ?? 0) !== epochAtStart) return
      const node: RecallNode = {
        id: nodeId,
        conversationId: conversation.id,
        profileId: conversation.profileId,
        completionSeq: conversation.completionSeq,
        inputIds,
        outcome: payload.outcome,
        summary,
        artifacts,
        keywords,
        createdAt: Date.now(),
      }
      if (!updateRecallDoc(getDocs().recall, node)) return

      if (!hasAgentOrTrigger) return
      const workerStillActive =
        readIndex().workers.some((w) => w.conversationId === conversation.id) &&
        readConversationOrUndefined(conversation.id)?.tags.includes(WORKER_TAG) === true
      if (!workerStillActive) return
      if ((rewindEpochs.get(conversation.id) ?? 0) !== epochAtStart) return
      const target = getRouterConversationId()
      if (target === undefined || isShutdown() || ctx.host.isClosing) return
      try {
        await ctx.host.submitInput(target, node.summary, {
          origin: 'agent',
          whenBusy: 'followUp',
          meta: {
            renderer: WORKER_REPORT_RENDERER,
            workerId: conversation.id,
            profileId: conversation.profileId,
            outcome: node.outcome,
            completionSeq: node.completionSeq,
            summary: node.summary,
            artifacts: node.artifacts.map((a) => ({ id: a.id, name: a.name, size: a.size })),
          },
        })
      } catch (err) {
        reportError(`Worker #${conversation.id} 汇报投递失败`, err)
      }
    } finally {
      const remaining = (settlingWorkers.get(conversation.id) ?? 1) - 1
      if (remaining === 0) settlingWorkers.delete(conversation.id)
      else settlingWorkers.set(conversation.id, remaining)
    }
  })
}
