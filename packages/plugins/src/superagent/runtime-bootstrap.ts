/**
 * builtin:superagent runtime bootstrap (loaded dynamically on enable / service prepare+start).
 *
 * Keeps heavy runtime modules (actions, hooks, assets with sync fs reads, watchdog + 8 submodules)
 * out of superagent.ts top-level imports so disabled registrations incur minimal parse/eval cost.
 */

import {
  HelmxError,
  type BeforeTurnHookPayload,
  type ConversationDetail,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type HelmxHostApi,
  type HelmxPluginContext,
  type HookHandler,
  type HookResult,
  type MaybePromise,
  type PluginActionContext,
  type PluginDocHandle,
  type PluginServiceSpec,
  type PluginToolContext,
  type ToolCallHookPayload,
  type TurnSettledPayload,
} from '@helmx/protocol'
import { registerSuperAgentActions } from './actions.js'
import {
  SUPERAGENT_PROFILE_ASSET,
  WATCHDOG_PLAYBOOK_SKILL_ASSET,
  WATCHDOG_PROFILE_ASSET,
  ensureProfileDir,
  ensureSkillDir,
  type AssetHostPorts,
} from './assets.js'
import {
  REWIND_REPLAY_PAGE_SIZE,
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  SUPERAGENT_PROFILE_IDS,
  WATCHDOG_PROFILE_ID,
  asConversationEntryEvent,
  assertIndexDoc,
  assertSubscriptionsDoc,
  resolveSuperAgentConfig,
  type SuperAgentConfig,
  type SuperAgentCoordinator,
  type SuperAgentDocs,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './contracts.js'
import { registerSuperAgentHooks } from './hooks.js'
import {
  assertRecallDoc,
  removeRecallNodesByInputs,
  rewindOmittedInputIds,
} from './recall.js'
import type { WatchdogDedupDoc } from './watchdog-dedup.js'
import { registerSuperAgentWatchdog } from './watchdog.js'

/** 自举 superagent/watchdog Profile 与 watchdog-playbooks 技能包（逐文件幂等）。 */
async function bootstrapAssets(host: Pick<HelmxHostApi, 'profiles' | 'skills'> & AssetHostPorts): Promise<void> {
  await ensureProfileDir(host, SUPERAGENT_PROFILE_ASSET)
  await ensureProfileDir(host, WATCHDOG_PROFILE_ASSET)
  await ensureSkillDir(host, WATCHDOG_PLAYBOOK_SKILL_ASSET)
  for (const id of SUPERAGENT_PROFILE_IDS) {
    if ((await host.profiles.get(id)) === undefined) {
      throw new HelmxError(
        'superagent_bootstrap_failed',
        `自举后 Profile ${id} 仍不可读（profile.json 缺失或损坏）`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID, profileId: id },
      )
    }
  }
}

export interface SuperAgentRuntimeController {
  coreLiveTasks(): string[]
  startCore(): Promise<void>
  stopCore(): Promise<void>
  watchdogLiveTasks(): string[]
  startWatchdog(): Promise<void>
  stopWatchdog(): Promise<void>
  invokeAction(id: string, input: unknown, context: PluginActionContext): MaybePromise<unknown>
  executeTool(name: string, input: unknown, context: PluginToolContext): MaybePromise<unknown>
  runTrigger(envelope: ExternalTriggerEnvelope): MaybePromise<HookResult<ExternalTriggerEnvelope> | void>
  runCoreBeforeTurn(turn: BeforeTurnHookPayload): MaybePromise<HookResult<BeforeTurnHookPayload> | void>
  runCoreToolCall(payload: ToolCallHookPayload): MaybePromise<HookResult<ToolCallHookPayload> | void>
  runCoreTurnSettled(payload: TurnSettledPayload): MaybePromise<HookResult<TurnSettledPayload> | void>
  runWatchdogTurnSettled(payload: TurnSettledPayload): MaybePromise<HookResult<TurnSettledPayload> | void>
  runWatchdogBeforeTurn(turn: BeforeTurnHookPayload): MaybePromise<HookResult<BeforeTurnHookPayload> | void>
  runWatchdogToolCall(payload: ToolCallHookPayload): MaybePromise<HookResult<ToolCallHookPayload> | void>
}

interface CreateSuperAgentRuntimeOptions {
  ctx: HelmxPluginContext
  docs: SuperAgentDocs
  watchdogDedupDoc: PluginDocHandle<WatchdogDedupDoc>
}

export function createSuperAgentRuntime(
  options: CreateSuperAgentRuntimeOptions,
): SuperAgentRuntimeController {
  const { ctx, docs, watchdogDedupDoc } = options

  let active = false
  let shutdown = false
  let dispatchChain: Promise<unknown> = Promise.resolve()
  let releases: Array<() => void> = []
  const liveTasks = new Map<string, number>()
  let routerId: number | undefined
  let watchdogId: number | undefined
  const settlingWorkers = new Map<number, number>()
  const rewindEpochs = new Map<number, number>()
  let entriesUnsubscribe: (() => void) | undefined

  const countLabel = (label: string, delta: number): void => {
    const next = (liveTasks.get(label) ?? 0) + delta
    if (next > 0) liveTasks.set(label, next)
    else liveTasks.delete(label)
  }

  async function track<T>(label: string, task: () => MaybePromise<T>): Promise<T> {
    if (shutdown) {
      throw new HelmxError('plugin_disabled', `builtin:superagent 已停用，拒绝后台任务 ${label}`, 409, {
        pluginId: SUPERAGENT_PLUGIN_ID,
      })
    }
    countLabel(label, +1)
    try {
      return await task()
    } finally {
      countLabel(label, -1)
    }
  }

  const logDiagnostic = (message: string): void => {
    console.error(`[superagent] ${ctx.host.redact(message)}`)
  }

  const reportError = (title: string, detail: unknown): void => {
    const message = detail instanceof Error ? detail.message : String(detail)
    const body = ctx.host.redact(`${title}：${message}`)
    try {
      ctx.host.emitEvent('notification', { type: 'notification', level: 'error', title: ctx.host.redact(title), body })
    } catch (eventErr) {
      logDiagnostic(`superagent 事件上报失败：${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
    }
    const target = routerId
    if (target === undefined || shutdown || ctx.host.isClosing) return
    void track('report-error', async () => {
      try {
        await ctx.host.submitInput(target, body, { origin: 'agent', whenBusy: 'steer' })
      } catch (err) {
        logDiagnostic(`superagent 错误报告投递失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const getConfig = (): SuperAgentConfig =>
    resolveSuperAgentConfig(ctx.getConfig() as Record<string, unknown>)
  const getRouterConversationId = (): number | undefined => routerId
  const getWatchdogConversationId = (): number | undefined => watchdogId

  let routingConfigSnapshot = ''
  const syncRoutingDoc = (): void => {
    const raw = ctx.getConfig() as Record<string, unknown>
    const snapshot = JSON.stringify(raw)
    if (snapshot === routingConfigSnapshot) return
    docs.routing.set({ version: 1, routerMode: resolveSuperAgentConfig(raw).routerMode })
    routingConfigSnapshot = snapshot
  }

  const readIndex = (): SuperAgentIndexDoc => assertIndexDoc(docs.index.get())
  const readSubscriptions = (): ThreadSubscriptionDoc => assertSubscriptionsDoc(docs.subscriptions.get())

  const updateIndex = (fn: (doc: SuperAgentIndexDoc) => SuperAgentIndexDoc): SuperAgentIndexDoc => {
    const next = fn(readIndex())
    assertIndexDoc(next)
    docs.index.set(next)
    return next
  }

  const updateSubscriptions = (fn: (doc: ThreadSubscriptionDoc) => ThreadSubscriptionDoc): ThreadSubscriptionDoc => {
    const next = fn(readSubscriptions())
    assertSubscriptionsDoc(next)
    docs.subscriptions.set(next)
    return next
  }

  const isRegisteredWorker = (conversationId: number): boolean => {
    if (!readIndex().workers.some((w) => w.conversationId === conversationId)) return false
    try {
      return ctx.host.getConversation(conversationId).tags.includes('worker')
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'not_found') return false
      throw err
    }
  }

  const readConversationOrUndefined = (id: number | undefined): ConversationSummary | undefined => {
    if (!Number.isInteger(id) || (id as number) <= 0) return undefined
    try {
      return ctx.host.getConversation(id as number)
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'not_found') return undefined
      throw err
    }
  }

  const ensureResidentConversation = async (
    kind: 'router' | 'watchdog',
    profileId: string,
    recordedId: number | undefined,
  ): Promise<number> => {
    const existing = readConversationOrUndefined(recordedId)
    if (existing !== undefined) {
      if (existing.profileId !== profileId) {
        throw new HelmxError(
          'superagent_resident_conversation_conflict',
          `插件常驻会话（${kind}）记录为 #${recordedId}，但该会话当前 profileId 是 '${existing.profileId}'（期望 '${profileId}'）；拒绝占用，请人工核对该会话或修正插件 doc index`,
          409,
          {
            pluginId: SUPERAGENT_PLUGIN_ID,
            kind,
            conversationId: recordedId,
            expectedProfileId: profileId,
            actualProfileId: existing.profileId,
          },
        )
      }
      return existing.id
    }
    const created = await ctx.host.createConversation({
      title: kind === 'router' ? 'SuperAgent 中枢' : '巡检看门狗',
      profileId,
    })
    updateIndex((doc) => ({
      ...doc,
      ...(kind === 'router' ? { routerConversationId: created.id } : { watchdogConversationId: created.id }),
    }))
    return created.id
  }

  const handleRewindMarker = (conversationId: number, entry: { id: string; kind: string; data?: unknown }): void => {
    const omitted = rewindOmittedInputIds(entry as unknown as Parameters<typeof rewindOmittedInputIds>[0])
    if (omitted === undefined) {
      reportError(
        'RecallGraph rewind 联动失败',
        new HelmxError(
          'superagent_rewind_payload_invalid',
          `会话 #${conversationId} 的 helmx.rewind 标记载荷非法（omittedInputIds 缺失或含非字符串项），已跳过 RecallGraph 清理，请人工核对`,
          500,
          { pluginId: SUPERAGENT_PLUGIN_ID, conversationId, entryId: entry.id },
        ),
      )
      return
    }
    rewindEpochs.set(conversationId, (rewindEpochs.get(conversationId) ?? 0) + 1)
    try {
      const removed = removeRecallNodesByInputs(docs.recall, conversationId, new Set(omitted))
      if (removed.length > 0) {
        logDiagnostic(`helmx.rewind 联动删除 RecallGraph 节点 ${removed.join(', ')}（会话 #${conversationId}）`)
      }
    } catch (err) {
      reportError(`RecallGraph rewind 联动失败（会话 #${conversationId}）`, err)
    }
  }

  const replayMissedRewinds = async (): Promise<void> => {
    const doc = docs.recall.get()
    assertRecallDoc(doc)
    const conversationIds = [...new Set(doc.nodes.map((n) => n.conversationId))]
    for (const conversationId of conversationIds) {
      let cursor: string | undefined = undefined
      const omitted = new Set<string>()
      for (;;) {
        let page: ConversationDetail
        try {
          page = await ctx.host.getConversationDetail(conversationId, {
            limit: REWIND_REPLAY_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          })
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') break
          throw err
        }
        for (const entry of page.entries) {
          const ids = rewindOmittedInputIds(entry)
          if (ids !== undefined) for (const id of ids) omitted.add(id)
        }
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      if (omitted.size === 0) continue
      rewindEpochs.set(conversationId, (rewindEpochs.get(conversationId) ?? 0) + 1)
      const removed = removeRecallNodesByInputs(docs.recall, conversationId, omitted)
      if (removed.length > 0) {
        logDiagnostic(`启用补偿：会话 #${conversationId} 停用期间 rewind 删除节点 ${removed.join(', ')}`)
      }
    }
  }

  const coordinator: SuperAgentCoordinator = {
    isActive: () => active,
    isShutdown: () => shutdown,
    getConfig,
    getRouterConversationId,
    getWatchdogConversationId,
    getDocs: () => docs,
    readIndex,
    readSubscriptions,
    updateIndex,
    updateSubscriptions,
    isRegisteredWorker,
    readConversationOrUndefined,
    reportError,
    syncRoutingDoc,
    enqueueDispatch: <T>(fn: () => Promise<T>): Promise<T> => {
      const task = dispatchChain.then(fn, fn)
      dispatchChain = task.catch(() => undefined)
      return task
    },
    settlingWorkers,
    rewindEpochs,
  }

  // Capture action/tool/hook/watchdog-service handlers registered by existing submodules without duplicating logic.
  const actionHandlers = new Map<string, (input: unknown, context: PluginActionContext) => unknown>()
  const toolExecutors = new Map<string, (input: unknown, context: PluginToolContext) => unknown>()
  const triggerHooks: Array<HookHandler<'trigger'>> = []
  const beforeTurnHooks: Array<HookHandler<'before_turn'>> = []
  const toolCallHooks: Array<HookHandler<'tool_call'>> = []
  const turnSettledHooks: Array<HookHandler<'turn_settled'>> = []
  let watchdogService: PluginServiceSpec | undefined

  const unexpectedRegistration = (what: string): never => {
    throw new HelmxError('superagent_internal_error', `Unexpected runtime registration during lazy bootstrap: ${what}`, 500)
  }

  const captureCtx: HelmxPluginContext = {
    pluginId: ctx.pluginId,
    dataDir: ctx.dataDir,
    getConfig: () => ctx.getConfig(),
    host: ctx.host,
    configSchema: () => unexpectedRegistration('configSchema'),
    route: () => unexpectedRegistration('route'),
    provider: () => unexpectedRegistration('provider'),
    sessionDoc: () => unexpectedRegistration('sessionDoc'),
    ui: new Proxy({} as HelmxPluginContext['ui'], {
      get: (_target, prop) => () => unexpectedRegistration(`ui.${String(prop)}`),
    }),
    doc: ((name: string) => {
      if (name === 'watchdog-dedup') return watchdogDedupDoc
      return unexpectedRegistration(`doc:${name}`)
    }) as HelmxPluginContext['doc'],
    action: (spec) => {
      actionHandlers.set(spec.id, spec.handler as (input: unknown, context: PluginActionContext) => unknown)
    },
    tool: (spec) => {
      toolExecutors.set(spec.name, spec.execute as (input: unknown, context: PluginToolContext) => unknown)
    },
    hook: {
      onTrigger: (fn) => { triggerHooks.push(fn) },
      onInput: () => unexpectedRegistration('hook.onInput'),
      onBeforeTurn: (fn) => { beforeTurnHooks.push(fn) },
      onToolCall: (fn) => { toolCallHooks.push(fn) },
      onToolResult: () => unexpectedRegistration('hook.onToolResult'),
      onAgentSpawn: () => unexpectedRegistration('hook.onAgentSpawn'),
      onTurnSettled: (fn) => { turnSettledHooks.push(fn) },
    },
    service: (spec) => {
      watchdogService = spec
    },
  }

  registerSuperAgentActions(captureCtx, coordinator)
  registerSuperAgentHooks(captureCtx, coordinator)
  registerSuperAgentWatchdog(captureCtx, {
    getConfig,
    getRouterConversationId,
    getWatchdogConversationId,
    track,
  })

  if (
    watchdogService === undefined ||
    triggerHooks.length !== 1 ||
    beforeTurnHooks.length !== 2 ||
    toolCallHooks.length !== 2 ||
    turnSettledHooks.length !== 2
  ) {
    throw new HelmxError('superagent_internal_error', 'Incomplete SuperAgent lazy runtime initialization', 500)
  }

  const capturedWatchdogService = watchdogService
  const coreTriggerHook = triggerHooks[0]!
  const coreBeforeTurnHook = beforeTurnHooks[0]!
  const watchdogBeforeTurnHook = beforeTurnHooks[1]!
  const coreToolCallHook = toolCallHooks[0]!
  const watchdogToolCallHook = toolCallHooks[1]!
  const coreTurnSettledHook = turnSettledHooks[0]!
  const watchdogTurnSettledHook = turnSettledHooks[1]!

  return {
    coreLiveTasks(): string[] {
      const labels = [...liveTasks.keys()]
      if (!active) return labels
      const busyIds = new Set<number>()
      for (const w of readIndex().workers) busyIds.add(w.conversationId)
      for (const resident of [routerId, watchdogId]) {
        if (resident !== undefined) busyIds.add(resident)
      }
      for (const id of busyIds) {
        try {
          const s = ctx.host.getConversation(id)
          if (s.status === 'working' || s.status === 'blocked') labels.push(`worker-run:${id}`)
        } catch (err) {
          if (err instanceof HelmxError && err.code === 'not_found') continue
          throw err
        }
      }
      return labels
    },
    async startCore(): Promise<void> {
      shutdown = false
      await bootstrapAssets({
        profileDirectory: (id) => ctx.host.profiles.directory(id),
        skillDirectory: (id) => ctx.host.skills.directory(id),
        atomicWriteFile: (path, content) => ctx.host.atomicWriteFile(path, content),
        profiles: ctx.host.profiles,
        skills: ctx.host.skills,
      })
      assertRecallDoc(docs.recall.get())
      readSubscriptions()
      const index = readIndex()
      const router = await ensureResidentConversation('router', SUPERAGENT_PROFILE_ID, index.routerConversationId)
      const watchdog = await ensureResidentConversation('watchdog', WATCHDOG_PROFILE_ID, index.watchdogConversationId)
      releases.push(ctx.host.manageConversation(router))
      releases.push(ctx.host.manageConversation(watchdog))
      ctx.host.markConversationOwnership(router, 'helmx')
      ctx.host.markConversationOwnership(watchdog, 'helmx')
      routerId = router
      watchdogId = watchdog
      await replayMissedRewinds()
      entriesUnsubscribe = ctx.host.onEvent('conversation.entry', (payload) => {
        if (!active || shutdown) return
        const event = asConversationEntryEvent(payload)
        if (event === undefined) {
          logDiagnostic(`conversation.entry 事件载荷非法被丢弃：${JSON.stringify(payload)?.slice(0, 120)}`)
          return
        }
        if (event.entry.kind !== 'helmx.rewind') return
        handleRewindMarker(event.conversationId, event.entry)
      })
      syncRoutingDoc()
      active = true
    },
    async stopCore(): Promise<void> {
      shutdown = true
      active = false
      entriesUnsubscribe?.()
      entriesUnsubscribe = undefined
      for (const release of releases) release()
      releases = []
      routerId = undefined
      watchdogId = undefined
      settlingWorkers.clear()
      rewindEpochs.clear()
    },
    watchdogLiveTasks(): string[] {
      return capturedWatchdogService.liveTasks?.() ?? []
    },
    async startWatchdog(): Promise<void> {
      await capturedWatchdogService.start()
    },
    async stopWatchdog(): Promise<void> {
      await capturedWatchdogService.stop()
    },
    invokeAction(id: string, input: unknown, context: PluginActionContext): MaybePromise<unknown> {
      const handler = actionHandlers.get(id)
      if (handler === undefined) {
        throw new HelmxError('not_found', `Unknown superagent action: ${id}`, 404, { pluginId: SUPERAGENT_PLUGIN_ID, id })
      }
      return handler(input, context)
    },
    executeTool(name: string, input: unknown, context: PluginToolContext): MaybePromise<unknown> {
      const execute = toolExecutors.get(name)
      if (execute === undefined) {
        throw new HelmxError('not_found', `Unknown superagent tool: ${name}`, 404, { pluginId: SUPERAGENT_PLUGIN_ID, name })
      }
      return execute(input, context)
    },
    runTrigger: (envelope) => coreTriggerHook(envelope),
    runCoreBeforeTurn: (turn) => coreBeforeTurnHook(turn),
    runCoreToolCall: (payload) => coreToolCallHook(payload),
    runCoreTurnSettled: (payload) => coreTurnSettledHook(payload),
    runWatchdogTurnSettled: (payload) => watchdogTurnSettledHook(payload),
    runWatchdogBeforeTurn: (turn) => watchdogBeforeTurnHook(turn),
    runWatchdogToolCall: (payload) => watchdogToolCallHook(payload),
  }
}

export type SuperAgentRuntimeModule = {
  createSuperAgentRuntime: typeof createSuperAgentRuntime
}
