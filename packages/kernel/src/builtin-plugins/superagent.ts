/**
 * builtin:superagent：实验性双层中枢（Router + Worker + RecallGraph）。
 *
 * 模块化拆分架构：
 * - ./superagent/contracts.ts: 领域模型、状态机契约、边界守卫与配置校验
 * - ./superagent/recall.ts: RecallGraph 记忆图谱断言、增删检与 rewind 联动
 * - ./superagent/settlement.ts: Worker 回合终态摘要提取、时间线摘要与脱敏
 * - ./superagent/actions.ts: 派工、检视、召回、订阅、归档动作与中枢模型工具
 * - ./superagent/hooks.ts: L0 确定性路由、L1 认知路由与结算汇报 Hook
 * - ./superagent/ui.ts: 前端侧栏、挂件、药丸、工具视图与全屏视图声明
 * - ./superagent/watchdog.ts: 两层巡检看门狗与人类审批桥
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmError,
  type ConversationDetail,
  type ConversationSummary,
  type HelmHostApi,
  type MaybePromise,
  type PluginDefinition,
} from '@helm/protocol'
import { registerSuperAgentWatchdog } from './superagent/watchdog.js'
import {
  DEFAULT_CONFIG,
  INDEX_DOC_NAME,
  RECALL_DOC_NAME,
  REWIND_REPLAY_PAGE_SIZE,
  ROUTING_DOC_NAME,
  SUBSCRIPTIONS_DOC_NAME,
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  SUPERAGENT_PROFILE_IDS,
  WATCHDOG_PROFILE_ID,
  assertIndexDoc,
  assertSubscriptionsDoc,
  resolveSuperAgentConfig,
  type RecallGraphDoc,
  type RouterModeDoc,
  type SuperAgentConfig,
  type SuperAgentCoordinator,
  type SuperAgentDocs,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './superagent/contracts.js'
import {
  SUPERAGENT_PROFILE_ASSET,
  WATCHDOG_PLAYBOOK_SKILL_ASSET,
  WATCHDOG_PROFILE_ASSET,
  ensureProfileDir,
  ensureSkillDir,
  type AssetHostPorts,
} from './superagent/assets.js'
import {
  assertRecallDoc,
  removeRecallNodesByInputs,
  rewindOmittedInputIds,
} from './superagent/recall.js'
import { registerSuperAgentActions } from './superagent/actions.js'
import { registerSuperAgentHooks } from './superagent/hooks.js'
import { registerSuperAgentUi } from './superagent/ui.js'
import { asConversationEntryEvent } from './superagent/contracts.js'

// ---------------------------------------------------------------------------
// 自举资产
// ---------------------------------------------------------------------------

/** 自举 superagent/watchdog Profile 与 watchdog-playbooks 技能包（逐文件幂等）。 */
async function bootstrapAssets(host: Pick<HelmHostApi, 'profiles' | 'skills'> & AssetHostPorts): Promise<void> {
  await ensureProfileDir(host, SUPERAGENT_PROFILE_ASSET)
  await ensureProfileDir(host, WATCHDOG_PROFILE_ASSET)
  await ensureSkillDir(host, WATCHDOG_PLAYBOOK_SKILL_ASSET)
  for (const id of SUPERAGENT_PROFILE_IDS) {
    if ((await host.profiles.get(id)) === undefined) {
      throw new HelmError(
        'superagent_bootstrap_failed',
        `自举后 Profile ${id} 仍不可读（profile.json 缺失或损坏）`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID, profileId: id },
      )
    }
  }
}

/** clientRoot 兼容 src / dist 运行路径（与 workflow/herdr/memory 插件同机制）。 */
function resolveSuperAgentClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'superagent', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'superagent', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'superagent_plugin_client_missing',
    `内置插件 ${SUPERAGENT_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

// ---------------------------------------------------------------------------
// 插件工厂
// ---------------------------------------------------------------------------

export function createSuperAgentPlugin(): PluginDefinition {
  return {
    id: SUPERAGENT_PLUGIN_ID,
    name: 'SuperAgent 中枢',
    description: '双层中枢：总控路由点名专家 Profile 派生后台 Worker，附归档汇报与两层巡检看门狗。',
    icon: 'sparkles',
    version: '0.1.0',
    clientRoot: resolveSuperAgentClientRoot(),
    definePlugin(ctx) {
      let active = false
      let shutdown = false
      let dispatchChain: Promise<unknown> = Promise.resolve()
      let docs: SuperAgentDocs | undefined
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
          throw new HelmError('plugin_disabled', `builtin:superagent 已停用，拒绝后台任务 ${label}`, 409, {
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
            await ctx.host.submitInput(target, body, { origin: 'agent', whenBusy: 'followUp' })
          } catch (err) {
            logDiagnostic(`superagent 错误报告投递失败：${err instanceof Error ? err.message : String(err)}`)
          }
        })
      }

      const getConfig = (): SuperAgentConfig =>
        resolveSuperAgentConfig(ctx.getConfig() as Record<string, unknown>)
      const getRouterConversationId = (): number | undefined => routerId
      const getWatchdogConversationId = (): number | undefined => watchdogId

      docs = {
        index: ctx.doc<SuperAgentIndexDoc>(INDEX_DOC_NAME, { version: 1, workers: [] }, { public: true }),
        subscriptions: ctx.doc<ThreadSubscriptionDoc>(SUBSCRIPTIONS_DOC_NAME, { version: 1, subscriptions: [] }, { public: true }),
        recall: ctx.doc<RecallGraphDoc>(RECALL_DOC_NAME, { version: 1, nodes: [] }, { public: true }),
        routing: ctx.doc<RouterModeDoc>(ROUTING_DOC_NAME, { version: 1, routerMode: DEFAULT_CONFIG.routerMode }, { public: true }),
      }

      let routingConfigSnapshot = ''
      const syncRoutingDoc = (): void => {
        const raw = ctx.getConfig() as Record<string, unknown>
        const snapshot = JSON.stringify(raw)
        if (snapshot === routingConfigSnapshot) return
        docs!.routing.set({ version: 1, routerMode: resolveSuperAgentConfig(raw).routerMode })
        routingConfigSnapshot = snapshot
      }

      const readIndex = (): SuperAgentIndexDoc => assertIndexDoc(docs!.index.get())
      const readSubscriptions = (): ThreadSubscriptionDoc => assertSubscriptionsDoc(docs!.subscriptions.get())

      const updateIndex = (fn: (doc: SuperAgentIndexDoc) => SuperAgentIndexDoc): SuperAgentIndexDoc => {
        const next = fn(readIndex())
        assertIndexDoc(next)
        docs!.index.set(next)
        return next
      }

      const updateSubscriptions = (fn: (doc: ThreadSubscriptionDoc) => ThreadSubscriptionDoc): ThreadSubscriptionDoc => {
        const next = fn(readSubscriptions())
        assertSubscriptionsDoc(next)
        docs!.subscriptions.set(next)
        return next
      }

      const isRegisteredWorker = (conversationId: number): boolean => {
        if (!readIndex().workers.some((w) => w.conversationId === conversationId)) return false
        try {
          return ctx.host.getConversation(conversationId).tags.includes('worker')
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') return false
          throw err
        }
      }

      const readConversationOrUndefined = (id: number | undefined): ConversationSummary | undefined => {
        if (!Number.isInteger(id) || (id as number) <= 0) return undefined
        try {
          return ctx.host.getConversation(id as number)
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') return undefined
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
            throw new HelmError(
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
            new HelmError(
              'superagent_rewind_payload_invalid',
              `会话 #${conversationId} 的 helm.rewind 标记载荷非法（omittedInputIds 缺失或含非字符串项），已跳过 RecallGraph 清理，请人工核对`,
              500,
              { pluginId: SUPERAGENT_PLUGIN_ID, conversationId, entryId: entry.id },
            ),
          )
          return
        }
        rewindEpochs.set(conversationId, (rewindEpochs.get(conversationId) ?? 0) + 1)
        try {
          const removed = removeRecallNodesByInputs(docs!.recall, conversationId, new Set(omitted))
          if (removed.length > 0) {
            logDiagnostic(`helm.rewind 联动删除 RecallGraph 节点 ${removed.join(', ')}（会话 #${conversationId}）`)
          }
        } catch (err) {
          reportError(`RecallGraph rewind 联动失败（会话 #${conversationId}）`, err)
        }
      }

      const replayMissedRewinds = async (): Promise<void> => {
        const doc = docs!.recall.get()
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
              if (err instanceof HelmError && err.code === 'not_found') break
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
          const removed = removeRecallNodesByInputs(docs!.recall, conversationId, omitted)
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
        getDocs: () => docs!,
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

      // 注册子模块能力
      registerSuperAgentActions(ctx, coordinator)
      registerSuperAgentHooks(ctx, coordinator)
      registerSuperAgentUi(ctx)

      // 注册配置 Schema
      ctx.configSchema({
        routerMode: {
          type: 'boolean',
          label: '中枢路由收敛模式',
          description: '开启后中枢会话剥离重度阻塞工具，仅保留派工与记忆工具',
          default: true,
        },
        mutedSources: {
          type: 'string',
          label: '静默事件源',
          description: '逗号或换行分隔的精确 source 名称，命中即 0-Token 丢弃',
          default: '',
        },
        watchdogEnabled: { type: 'boolean', label: '启用看门狗', description: '关闭后不执行 Watchdog 巡检策略', default: true },
        stalledAfterMs: { type: 'number', label: '停滞判定（毫秒）', description: '超过此时长视为停滞', default: 300_000 },
        abortAfterMs: { type: 'number', label: '自动中止（毫秒）', description: '必须大于等于停滞判定', default: 1_800_000 },
        errorThreshold: { type: 'number', label: '连续报错阈值', description: '达到阈值唤醒看门狗', default: 3 },
      })

      // 注册核心服务
      ctx.service({
        id: 'superagent-core',
        liveTasks() {
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
              if (err instanceof HelmError && err.code === 'not_found') continue
              throw err
            }
          }
          return labels
        },
        async start() {
          shutdown = false
          await bootstrapAssets({
            profileDirectory: (id) => ctx.host.profiles.directory(id),
            skillDirectory: (id) => ctx.host.skills.directory(id),
            atomicWriteFile: (path, content) => ctx.host.atomicWriteFile(path, content),
            profiles: ctx.host.profiles,
            skills: ctx.host.skills,
          })
          assertRecallDoc(docs!.recall.get())
          readSubscriptions()
          const index = readIndex()
          const router = await ensureResidentConversation('router', SUPERAGENT_PROFILE_ID, index.routerConversationId)
          const watchdog = await ensureResidentConversation('watchdog', WATCHDOG_PROFILE_ID, index.watchdogConversationId)
          releases.push(ctx.host.manageConversation(router))
          releases.push(ctx.host.manageConversation(watchdog))
          ctx.host.markConversationOwnership(router, 'helm')
          ctx.host.markConversationOwnership(watchdog, 'helm')
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
            if (event.entry.kind !== 'helm.rewind') return
            handleRewindMarker(event.conversationId, event.entry)
          })
          syncRoutingDoc()
          active = true
        },
        async stop() {
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
      })

      // 挂载 Watchdog
      registerSuperAgentWatchdog(ctx, {
        getConfig,
        getRouterConversationId,
        getWatchdogConversationId,
        track,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 契约与纯函数重导出（保证所有公开消费方与单元测试 100% 契约保真）
// ---------------------------------------------------------------------------

export {
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  WATCHDOG_PROFILE_ID,
  WORKER_TAG,
  WORKER_ARCHIVED_TAG,
  RECALL_DOC_NAME,
  WORKER_REPORT_RENDERER,
  INDEX_DOC_NAME,
  SUBSCRIPTIONS_DOC_NAME,
  ROUTING_DOC_NAME,
  SUPERAGENT_PROFILE_IDS,
  REWIND_REPLAY_PAGE_SIZE,
  asConversationEntryEvent,
  isAbsoluteTargetPath,
  parseMutedSources,
  resolveSuperAgentConfig,
  assertIndexDoc,
  assertSubscriptionsDoc,
} from './superagent/contracts.js'

export {
  assertRecallDoc,
  rewindOmittedInputIds,
  removeRecallNodesByInputs,
  recallHasNode,
  updateRecallDoc,
  searchRecallNodes,
  type RecallNodeInput,
} from './superagent/recall.js'

export {
  collectWorkerSettlement,
  recentEntrySummaries,
} from './superagent/settlement.js'
