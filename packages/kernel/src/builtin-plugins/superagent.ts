/**
 * builtin:superagent：实验性双层中枢（Router + Worker + RecallGraph）。
 *
 * 职界（设计文档 §4.3）：
 * - L0 确定性事件路由（trigger）：muted source 静默丢弃（handled）、threadKey
 *   命中活跃订阅直投 Worker（transform target）、其余进 SuperAgent 中枢，
 *   不打扰普通人类会话；订阅目标已删/归档时清理残留订阅并回退中枢；
 * - L1 中枢认知路由（before_turn）：仅实际 router 会话且 routerMode 开启时
 *   剥离重度阻塞工具并注入 <active_workers> 态势；tool_call 二次守卫阻止
 *   旧上下文绕过；
 * - 非阻塞派工 dispatch_worker（仅等会话创建 + 输入被 SDK 接受）、
 *   inspect_worker / recall_context / subscribe_thread / archive_worker /
 *   set_router_mode（工具精确短名 + ctx.action 五端复用同 handler）；
 * - turn_settled：仅 index 已登记且带 worker 标签的后台 Worker（排除
 *   router/watchdog 自身），completed/failed/aborted 三态统一处理；回合输入
 *   含 agent|trigger 即向中枢投递汇报卡（meta.renderer=superagent:worker-report），
 *   纯 human 回合仅静默写 RecallGraph；按 conversationId:completionSeq 稳定去重；
 * - 自举幂等（Profile / SYSTEM / MEMORY / watchdog-playbooks 逐文件补齐，
 *   不覆盖用户文件），常驻会话动态分配、持久复用，管理保护 + helm 归属
 *   随启停获取/释放；停用期间被删的常驻会话在下次启用时重建；
 * - Watchdog 巡检策略由 watchdog.ts 独立模块挂载（runtime 桥在此构造）。
 *
 * 诚实性纪律：
 * - 三个公开 doc（index / subscriptions / recall-graph）读入边界验证，
 *   持久损坏显式 error；配置非法显式拒绝，绝不悄悄取默认；
 * - 派工提交失败 / 汇报投递失败显式上报（notification + 错误报告入中枢），
 *   绝不返回假成功、不吞后台 rejection；
 * - 关停（service.stop）先置 shutdown 再释放资源，此后不再向 router 投递
 *   任何汇报（KernelRuntime.close 的 abort 回调不会在关停后无限唤醒中枢）。
 */
import { HelmError, type ConversationEntry, type PluginDefinition, type PluginToolContext } from '@helm/protocol'
import type {
  ConversationSummary,
  MaybePromise,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import type {
  ArtifactMetadata,
  ConversationDetail,
  ConversationScope,
} from '@helm/protocol'
import { withFileLock } from '../services/index.js'
import { redactJsonValue } from '../redact.js'
import { isAbsoluteTargetPath } from '../runtime/tools.js'
import { registerSuperAgentWatchdog } from './superagent/watchdog.js'
import type {
  RecallGraphDoc,
  RecallNode,
  RegisterSuperAgentWatchdog,
  RouterModeDoc,
  SuperAgentConfig,
  SuperAgentDependencies,
  SuperAgentDocs,
  SuperAgentIndexDoc,
  SuperAgentWorker,
  ThreadSubscriptionDoc,
} from './superagent/contracts.js'
import {
  SUPERAGENT_PROFILE_ASSET,
  WATCHDOG_PROFILE_ASSET,
  WATCHDOG_PLAYBOOK_SKILL_ASSET,
  ensureProfileDir,
  ensureSkillDir,
} from './superagent/assets.js'

// ---------------------------------------------------------------------------
// 常量与配置
// ---------------------------------------------------------------------------

export const SUPERAGENT_PLUGIN_ID = 'builtin:superagent'
export const SUPERAGENT_PROFILE_ID = 'superagent'
export const WATCHDOG_PROFILE_ID = 'watchdog'
export const WORKER_TAG = 'worker'
export const WORKER_ARCHIVED_TAG = 'worker-archived'
export const RECALL_DOC_NAME = 'recall-graph'
export const WORKER_REPORT_RENDERER = 'superagent:worker-report'
export const INDEX_DOC_NAME = 'index'
export const SUBSCRIPTIONS_DOC_NAME = 'subscriptions'
/** 路由模式公开只读镜像（UI 数据源；真实配置的唯一来源仍是插件配置）。 */
export const ROUTING_DOC_NAME = 'routing'

export const SUPERAGENT_PROFILE_IDS: readonly string[] = [SUPERAGENT_PROFILE_ID, WATCHDOG_PROFILE_ID]

/** before_turn 剥离 + tool_call 守卫的重度阻塞工具（精确名匹配）。 */
const ROUTER_BLOCKED_TOOL_NAMES = new Set(['edit', 'write', 'bash', 'subagent', 'SubagentWorkflow'])

/** 中枢工具/动作的会话作用域：仅 superagent Profile 会话可见/可执行。 */
const ROUTER_TOOL_SCOPE: ConversationScope = { profileIds: [SUPERAGENT_PROFILE_ID] }

const DEFAULT_CONFIG: SuperAgentConfig = {
  routerMode: true,
  mutedSources: '',
  watchdogEnabled: true,
  stalledAfterMs: 300_000,
  abortAfterMs: 1_800_000,
  errorThreshold: 3,
}

/** 启用补偿分页读取页面大小（详情 API 上限 500，一次拉满减少往返）。 */
export const REWIND_REPLAY_PAGE_SIZE = 500

/** mutedSources 逗号/换行分隔解析为精确 source 集合（空项剔除）。 */
export function parseMutedSources(raw: string): Set<string> {
  const out = new Set<string>()
  for (const part of raw.split(/[,\n]/)) {
    const name = part.trim()
    if (name !== '') out.add(name)
  }
  return out
}

/** 即时读取并严格校验配置：非法显式抛错，绝不悄悄取默认。 */
export function resolveSuperAgentConfig(raw: Record<string, unknown>): SuperAgentConfig {
  const err = (msg: string): HelmError =>
    new HelmError('superagent_config_invalid', `builtin:superagent 配置非法：${msg}`, 500, { pluginId: SUPERAGENT_PLUGIN_ID })
  const readBool = (key: 'routerMode' | 'watchdogEnabled'): boolean => {
    if (key in raw) {
      if (typeof raw[key] !== 'boolean') throw err(`字段 ${key} 必须是布尔值（实际：${typeof raw[key]}）`)
      return raw[key] as boolean
    }
    return DEFAULT_CONFIG[key]
  }
  const readPosInt = (key: 'stalledAfterMs' | 'abortAfterMs' | 'errorThreshold'): number => {
    if (key in raw) {
      const v = raw[key]
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isFinite(v)) {
        throw err(`字段 ${key} 必须是正有限整数（实际：${String(v)}）`)
      }
      return v
    }
    return DEFAULT_CONFIG[key]
  }
  let mutedSources = DEFAULT_CONFIG.mutedSources
  if ('mutedSources' in raw && raw.mutedSources !== undefined) {
    if (typeof raw.mutedSources !== 'string') throw err(`字段 mutedSources 必须是字符串（实际：${typeof raw.mutedSources}）`)
    mutedSources = raw.mutedSources
  }
  const config: SuperAgentConfig = {
    routerMode: readBool('routerMode'),
    mutedSources,
    watchdogEnabled: readBool('watchdogEnabled'),
    stalledAfterMs: readPosInt('stalledAfterMs'),
    abortAfterMs: readPosInt('abortAfterMs'),
    errorThreshold: readPosInt('errorThreshold'),
  }
  if (config.abortAfterMs < config.stalledAfterMs) {
    throw err(`abortAfterMs(${config.abortAfterMs}) 必须大于等于 stalledAfterMs(${config.stalledAfterMs})`)
  }
  return config
}

// ---------------------------------------------------------------------------
// doc 边界验证
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const SETTLED_OUTCOMES = new Set(['completed', 'failed', 'aborted'])

const docCorrupt = (detail: string): HelmError =>
  new HelmError('superagent_doc_corrupt', `插件 doc ${INDEX_DOC_NAME} ${detail}`, 500, { pluginId: SUPERAGENT_PLUGIN_ID })

/** 正整数会话 ID（> 0；无保留会话概念，常驻/worker 只需正整数）。 */
function isPosIntId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** 非负有限 Unix 毫秒时间戳。 */
function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function assertIndexDoc(value: unknown): SuperAgentIndexDoc {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.workers)) {
    throw new HelmError(
      'superagent_doc_corrupt',
      `插件 doc ${INDEX_DOC_NAME} 结构非法（期望 { version: 1, workers: [] }）`,
      500,
      { pluginId: SUPERAGENT_PLUGIN_ID },
    )
  }
  for (const key of ['routerConversationId', 'watchdogConversationId'] as const) {
    const id = value[key]
    if (id === undefined) continue // 常驻 ID 自举后写入；缺省合法
    if (!isPosIntId(id)) {
      throw docCorrupt(`${key} 必须是正整数（收到：${String(id)}）`)
    }
    if (id === value.routerConversationId && id === value.watchdogConversationId) {
      throw docCorrupt('routerConversationId 与 watchdogConversationId 不得相同')
    }
  }
  const seenWorkerIds = new Set<number>()
  for (const w of value.workers) {
    if (
      !isPlainObject(w) ||
      !isPosIntId(w.conversationId) ||
      !isPosIntId(w.parentConversationId) ||
      typeof w.profileId !== 'string' ||
      w.profileId.trim() === '' ||
      !isFiniteTime(w.createdAt)
    ) {
      throw new HelmError('superagent_doc_corrupt', `插件 doc ${INDEX_DOC_NAME}.workers 含非法条目`, 500, {
        pluginId: SUPERAGENT_PLUGIN_ID,
      })
    }
    if (seenWorkerIds.has(w.conversationId)) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${INDEX_DOC_NAME}.workers 重复登记会话 #${w.conversationId}`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    seenWorkerIds.add(w.conversationId)
  }
  return value as unknown as SuperAgentIndexDoc
}

export function assertSubscriptionsDoc(value: unknown): ThreadSubscriptionDoc {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.subscriptions)) {
    throw new HelmError(
      'superagent_doc_corrupt',
      `插件 doc ${SUBSCRIPTIONS_DOC_NAME} 结构非法（期望 { version: 1, subscriptions: [] }）`,
      500,
      { pluginId: SUPERAGENT_PLUGIN_ID },
    )
  }
  const seenKeys = new Set<string>()
  for (const s of value.subscriptions) {
    if (
      !isPlainObject(s) ||
      typeof s.threadKey !== 'string' ||
      s.threadKey.trim() === '' ||
      s.threadKey.length > 200 ||
      !isPosIntId(s.workerConversationId) ||
      !isFiniteTime(s.createdAt)
    ) {
      throw new HelmError('superagent_doc_corrupt', `插件 doc ${SUBSCRIPTIONS_DOC_NAME}.subscriptions 含非法条目`, 500, {
        pluginId: SUPERAGENT_PLUGIN_ID,
      })
    }
    if (seenKeys.has(s.threadKey)) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${SUBSCRIPTIONS_DOC_NAME}.subscriptions 重复订阅 threadKey '${s.threadKey}'`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    seenKeys.add(s.threadKey)
  }
  return value as unknown as ThreadSubscriptionDoc
}

const RECALL_ARTIFACT_KEYS = ['id', 'conversationId', 'name', 'path', 'mimeType', 'size', 'createdAt'] as const

export function assertRecallDoc(value: unknown): void {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.nodes)) {
    throw new HelmError(
      'superagent_doc_corrupt',
      `插件 doc ${RECALL_DOC_NAME} 结构非法（期望 { version: 1, nodes: [] }）`,
      500,
      { pluginId: SUPERAGENT_PLUGIN_ID },
    )
  }
  const seenIds = new Set<string>()
  for (const n of value.nodes) {
    if (
      !isPlainObject(n) ||
      typeof n.id !== 'string' ||
      n.id === '' ||
      !isPosIntId(n.conversationId) ||
      typeof n.profileId !== 'string' ||
      n.profileId.trim() === '' ||
      typeof n.completionSeq !== 'number' ||
      !Number.isInteger(n.completionSeq) ||
      n.completionSeq < 0 ||
      !Array.isArray(n.inputIds) ||
      n.inputIds.length === 0 ||
      n.inputIds.some((v) => typeof v !== 'string' || v === '') ||
      new Set(n.inputIds).size !== n.inputIds.length ||
      typeof n.outcome !== 'string' ||
      !SETTLED_OUTCOMES.has(n.outcome) ||
      typeof n.summary !== 'string' ||
      !Array.isArray(n.keywords) ||
      n.keywords.some((k) => typeof k !== 'string') ||
      !isFiniteTime(n.createdAt) ||
      !Array.isArray(n.artifacts) ||
      n.artifacts.some((a) => {
        if (!isPlainObject(a)) return true
        for (const key of RECALL_ARTIFACT_KEYS) {
          if (!Object.hasOwn(a, key)) return true
        }
        return (
          typeof a.id !== 'string' ||
          !isPosIntId(a.conversationId) ||
          typeof a.name !== 'string' ||
          typeof a.path !== 'string' ||
          typeof a.mimeType !== 'string' ||
          typeof a.size !== 'number' ||
          !Number.isFinite(a.size) ||
          a.size < 0 ||
          !isFiniteTime(a.createdAt)
        )
      })
    ) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${RECALL_DOC_NAME}.nodes 含非法节点（期望 RecallNode 真实契约）`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    if (seenIds.has(n.id)) {
      throw new HelmError(
        'superagent_doc_corrupt',
        `插件 doc ${RECALL_DOC_NAME}.nodes 重复节点 id '${n.id}'`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID },
      )
    }
    seenIds.add(n.id)
  }
}

// ---------------------------------------------------------------------------
// 自举资产
// ---------------------------------------------------------------------------

/** 自举 superagent/watchdog Profile 与 watchdog-playbooks 技能包（逐文件幂等）。 */
async function bootstrapAssets(deps: SuperAgentDependencies): Promise<void> {
  await ensureProfileDir(deps.dataDir, SUPERAGENT_PROFILE_ASSET)
  await ensureProfileDir(deps.dataDir, WATCHDOG_PROFILE_ASSET)
  await ensureSkillDir(deps.dataDir, WATCHDOG_PLAYBOOK_SKILL_ASSET)
  // 自举后经 ProfileService 真实读取校验（损坏/缺失显式上抛，不吞）。
  for (const id of SUPERAGENT_PROFILE_IDS) {
    if ((await deps.profiles.get(id)) === undefined) {
      throw new HelmError(
        'superagent_bootstrap_failed',
        `自举后 Profile ${id} 仍不可读（profile.json 缺失或损坏）`,
        500,
        { pluginId: SUPERAGENT_PLUGIN_ID, profileId: id },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 工厂入口
// ---------------------------------------------------------------------------

export function createSuperAgentPlugin(deps: SuperAgentDependencies): PluginDefinition {
  return {
    id: SUPERAGENT_PLUGIN_ID,
    name: 'SuperAgent 中枢',
    version: '0.1.0',
    definePlugin(ctx) {
      /** 本启用周期生命周期状态（每次 enable 重建）。 */
      let active = false
      let shutdown = false
      /** 派工/订阅互斥链：并发 dispatch 同 threadKey 串行检查/写入，防双写。 */
      let dispatchChain: Promise<unknown> = Promise.resolve()
      let docs: SuperAgentDocs | undefined
      /** 本周期显式获取的释放句柄（manageConversation；hostReleases 兜底）。 */
      let releases: Array<() => void> = []
      /** 在途后台任务标签（标签 -> 并发计数）；service.liveTasks 消费。 */
      const liveTasks = new Map<string, number>()
      let routerId: number | undefined
      let watchdogId: number | undefined
      /** 结算中的 Worker（turn_settled 自给至异步写图/汇报完成；防归档竞态丢末回合摘要）。 */
      const settlingWorkers = new Map<number, number>()
      /** 会话 -> 当前 rewind 纪元：helm.rewind 到达时递增；在途结算 await 后发现
       * 纪元已变即放弃写图/汇报（编辑重发不复活旧回合节点）。 */
      const rewindEpochs = new Map<number, number>()
      /** conversation.entry 订阅退订句柄（service.start 订阅 / stop 退订）。 */
      let entriesUnsubscribe: (() => void) | undefined

      const countLabel = (label: string, delta: number): void => {
        const next = (liveTasks.get(label) ?? 0) + delta
        if (next > 0) liveTasks.set(label, next)
        else liveTasks.delete(label)
      }

      /**
       * 受跟踪后台任务：计数入 liveTasks（阻止停用/卸载），rejection 由调用方
       * 显式上报；关停后拒绝新任务（不唤醒 router）。
       */
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

      /** 诊断日志始终 stderr（脱敏）：失败不可仅 HELM_DEBUG 才可见（静默诊断）。 */
      const logDiagnostic = (message: string): void => {
        console.error(`[superagent] ${deps.redact(message)}`)
      }

      /** 显式错误上报：notification 事件 + 尽力投递错误报告卡入中枢（各仅一次，不递归）。 */
      const reportError = (title: string, detail: unknown): void => {
        const message = detail instanceof Error ? detail.message : String(detail)
        const body = deps.redact(`${title}：${message}`)
        try {
          ctx.host.emitEvent('notification', { type: 'notification', level: 'error', title: deps.redact(title), body })
        } catch (eventErr) {
          logDiagnostic(`superagent 事件上报失败：${eventErr instanceof Error ? eventErr.message : String(eventErr)}`)
        }
        const target = routerId
        // 内核关闭中不再唤醒中枢（正常关机 abort 回调触发的失败仅通知 + stderr）。
        if (target === undefined || shutdown || deps.isClosing()) return
        void track('report-error', async () => {
          try {
            await ctx.host.submitInput(target, body, { origin: 'agent', whenBusy: 'followUp' })
          } catch (err) {
            // 错误报告自身投递失败：仅 stderr 诊断，不递归上报、不静默成功。
            logDiagnostic(`superagent 错误报告投递失败：${err instanceof Error ? err.message : String(err)}`)
          }
        })
      }

      const getConfig = (): SuperAgentConfig =>
        resolveSuperAgentConfig(ctx.getConfig() as Record<string, unknown>)
      const getRouterConversationId = (): number | undefined => routerId
      const getWatchdogConversationId = (): number | undefined => watchdogId

      // ---- docs：固定 index / subscriptions / recall-graph / routing，读入即验证 ----
      docs = {
        index: ctx.doc<SuperAgentIndexDoc>(INDEX_DOC_NAME, { version: 1, workers: [] }, { public: true }),
        subscriptions: ctx.doc<ThreadSubscriptionDoc>(SUBSCRIPTIONS_DOC_NAME, { version: 1, subscriptions: [] }, { public: true }),
        recall: ctx.doc<RecallGraphDoc>(RECALL_DOC_NAME, { version: 1, nodes: [] }, { public: true }),
        // 路由模式只读镜像：UI pill 数据源；由真实配置回写，不作为配置来源。
        routing: ctx.doc<RouterModeDoc>(ROUTING_DOC_NAME, { version: 1, routerMode: DEFAULT_CONFIG.routerMode }, { public: true }),
      }

      /** 配置签名：仅变化时回写 routing 镜像（读时自愈，写时不折腾）。 */
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

      /** worker 是否仍是本插件登记的活跃 worker（现读会话验证标签）。 */
      const isRegisteredWorker = (conversationId: number): boolean => {
        if (!readIndex().workers.some((w) => w.conversationId === conversationId)) return false
        try {
          return ctx.host.getConversation(conversationId).tags.includes(WORKER_TAG)
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

      // ------------------------------------------------------------------
      // 自举：常驻会话（service.start；Profile 资产先行）
      // ------------------------------------------------------------------

      /**
       * 常驻会话复用/重建：记录 ID 的会话仍存在且 Profile 正确则复用；被删
       * （停用期间清理）则重建；存在但 profileId 不符则显式诊断（不盲目占用）。
       */
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
        // 创建后立即持久化：半途失败（如 watchdog 建会话报错）时已建会话下次启用复用。
        updateIndex((doc) => ({
          ...doc,
          ...(kind === 'router' ? { routerConversationId: created.id } : { watchdogConversationId: created.id }),
        }))
        return created.id
      }

      // ------------------------------------------------------------------
      // trigger：L0 确定性路由
      // ------------------------------------------------------------------

      ctx.hook.onTrigger((envelope) => {
        if (!active) return
        const config = getConfig()
        if (parseMutedSources(config.mutedSources).has(envelope.source)) {
          return { action: 'handled' } // 精确静默：0-Token 丢弃
        }
        if (envelope.threadKey !== undefined && envelope.threadKey !== '') {
          const sub = readSubscriptions().subscriptions.find((s) => s.threadKey === envelope.threadKey)
          if (sub !== undefined) {
            if (isRegisteredWorker(sub.workerConversationId)) {
              return { action: 'transform', value: { ...envelope, targetConversationId: sub.workerConversationId } }
            }
            // 目标已删/已归档：清理残留订阅，原事件直接改投中枢（只投一次，
            // 不再额外投递通知——同一事件两次模型输入违反直通回退契约）。
            updateSubscriptions((doc) => ({
              ...doc,
              subscriptions: doc.subscriptions.filter((s) => s.threadKey !== envelope.threadKey),
            }))
          }
        }
        // 连接器声明的定向目标在订阅匹配之后生效，避免被缺省中枢路由覆盖。
        if (envelope.targetConversationId !== undefined) return
        const target = getRouterConversationId()
        if (target === undefined || deps.isClosing()) return // 自举未完成：交内核默认靶点解析
        return { action: 'transform', value: { ...envelope, targetConversationId: target } }
      })

      // ------------------------------------------------------------------
      // before_turn：中枢工具收敛 + active_workers 态势；tool_call 二次守卫
      // ------------------------------------------------------------------

      const activeWorkersSection = (): string => {
        const workers = readIndex().workers
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
          const detail = doing !== '' ? ` doing="${escapeXmlAttribute(deps.redact(doing))}"` : ''
          return `<worker id="${w.conversationId}" profile="${escapeXmlAttribute(w.profileId)}" status="${status}"${detail} />`
        })
        return `<active_workers>\n${lines.join('\n')}\n</active_workers>`
      }

      ctx.hook.onBeforeTurn((turn) => {
        if (!active) return
        if (turn.conversation.id !== getRouterConversationId()) return
        if (!getConfig().routerMode) return
        const tools = turn.tools.filter((t) => !ROUTER_BLOCKED_TOOL_NAMES.has(t.name))
        const sections = [...turn.sections, { id: 'superagent.active_workers', text: activeWorkersSection() }]
        return { action: 'transform', value: { ...turn, tools, sections } }
      })

      ctx.hook.onToolCall((payload) => {
        if (!active) return
        if (payload.conversationId !== getRouterConversationId()) return
        if (!getConfig().routerMode) return
        if (!ROUTER_BLOCKED_TOOL_NAMES.has(payload.toolName)) return
        return {
          action: 'block',
          reason: `中枢路由模式已剥离重度阻塞工具 ${payload.toolName}；请改用 dispatch_worker 派工执行`,
        }
      })

      // ------------------------------------------------------------------
      // 派工 / 检视 / 召回 / 订阅 / 归档 / 路由开关
      // ------------------------------------------------------------------

      interface DispatchInput {
        prompt: string
        profileId?: string
        title?: string
        threadKey?: string
        cwd?: string
        nodeId?: string
      }

      /** 执行会话二次校验：scope 之外再核实际 router 会话（防同 Profile 人类直聊滥用）。 */
      const assertRouterAuthority = (conversationId: number | undefined): void => {
        if (conversationId === undefined) return // 人工 HTTP/CLI 调用：无会话上下文放行
        if (conversationId !== getRouterConversationId()) {
          throw new HelmError(
            'conversation_scope_violation',
            `该操作仅允许在 SuperAgent 中枢会话内执行，当前会话 #${conversationId} 不是中枢`,
            403,
            { pluginId: SUPERAGENT_PLUGIN_ID, conversationId },
          )
        }
      }

      const assertThreadKey = (key: string): string => {
        const trimmed = key.trim()
        if (trimmed === '' || trimmed.length > 200) {
          throw new HelmError('validation_error', `threadKey 非法（需 1..200 字符，收到：${key}）`, 400, {})
        }
        return trimmed
      }

      const assertWorkerConversationId = (value: unknown): number => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new HelmError('validation_error', `workerConversationId 必须是正整数（收到：${String(value)}）`, 400, {})
        }
        return value
      }

      /** Profile ID：非空、无空白、无路径分隔符（防目录穿越）；存在性由调用处核验。 */
      const assertProfileId = (value: string): string => {
        const trimmed = value.trim()
        if (trimmed === '' || trimmed.length > 64 || /\s|[/\\]/.test(trimmed)) {
          throw new HelmError('validation_error', `profileId 非法（非空 1..64 字符，不含空白与路径分隔符，收到：${value}）`, 400, {})
        }
        return trimmed
      }

      /** Worker 工作目录：显式给出则必须是跨平台绝对路径（POSIX `/`、
       * Windows 盘符 `C:\\...` / `C:/...`、UNC `\\\\server\\share`），
       * 目标节点可能与 Hub 异平台，不得用宿主 node:path 规则判定。 */
      const assertWorkerCwd = (value: string): string => {
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
      const assertWorkerNodeId = (value: string): string => {
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
      const workerIdSchema: Record<string, unknown> = { type: 'integer', minimum: 1 }
      const workerIdInputSchema: Record<string, unknown> = {
        type: 'object',
        properties: { workerConversationId: workerIdSchema },
        required: ['workerConversationId'],
        additionalProperties: false,
      }

      const dispatchInputSchema: Record<string, unknown> = {
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

      const dispatchWorker = async (
        input: DispatchInput,
        conversationId: number | undefined,
      ): Promise<{ workerConversationId: number }> => {
        assertRouterAuthority(conversationId)
        if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
          throw new HelmError('validation_error', 'dispatch_worker 需要 prompt（非空文本）', 400, {})
        }
        const routerConversationId = getRouterConversationId()
        if (routerConversationId === undefined) {
          throw new HelmError('superagent_not_ready', 'SuperAgent 中枢尚未自举完成', 409, {
            pluginId: SUPERAGENT_PLUGIN_ID,
          })
        }
        // 显式给出即必须合法且真实存在；仅缺省（undefined）才回退 assistant。
        const targetProfile = input.profileId === undefined ? 'assistant' : assertProfileId(input.profileId)
        if (SUPERAGENT_PROFILE_IDS.includes(targetProfile)) {
          throw new HelmError(
            'validation_error',
            `dispatch_worker 禁止派生中枢/看门狗 Profile（${targetProfile}），避免自激`,
            400,
            { profileId: targetProfile },
          )
        }
        if ((await deps.profiles.get(targetProfile)) === undefined) {
          throw new HelmError('validation_error', `Profile 不存在：${targetProfile}`, 400, { profileId: targetProfile })
        }
        const threadKey = input.threadKey === undefined ? undefined : assertThreadKey(input.threadKey)
        const title =
          input.title !== undefined && input.title.trim() !== ''
            ? input.title.trim().slice(0, 80)
            : `Worker: ${input.prompt.slice(0, 24)}`
        const cwd = input.cwd === undefined ? undefined : assertWorkerCwd(input.cwd)
        const nodeId = input.nodeId === undefined ? undefined : assertWorkerNodeId(input.nodeId)

        const run = async (): Promise<{ workerConversationId: number }> => {
          // —— 互斥区内（dispatchChain）：订阅占位检查 + 建会话 + 登记 + 提交 ——
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
              // 订阅目标已失效（Worker 被删/归档）：清理残留后继续，不算抢占。
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
          // 非阻塞：仅等会话创建 + 输入被 SDK 接受（不等模型回合结束）。
          // 建会话之后的全部副作用（归属标记 / index 登记 / threadKey 绑定 /
          // 初始输入提交）任一步失败都统一收敛：上报原始错误 + 完整回滚登记与
          // 订阅绑定，并把空会话标记归档，绝不残留无回合僵尸 Worker、不锁死
          // threadKey。
          //
          // submitInput 失败语义（runtime 真实实现核实）：拒绝仅发生在输入未被
          // SDK 接受时（closed/not_found/model_not_configured/input_blocked/
          // SDK submit 拒绝——tracker 注册的输入在错误路径全部回滚，无
          // helm.input entry 落库），故回滚打归档标签不会误伤已接收输入的
          // 活跃任务；回滚不删除会话本身（保留审计痕迹，与 archive_worker
          // 同标签），不影响 human 会话（仅处置本插件刚建的 worker 会话）。
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
            // 先上报原始错误（回滚失败不掩盖提交/登记失败的上报），再尽力回滚；
            // 回滚自身失败如实叠加（superagent_dispatch_rollback_failed），
            // 由调用方一并暴露，不静默丢任何一侧。
            reportError(`Worker #${worker.id} 派工提交失败（登记/提交阶段，回滚中）`, err)
            await rollbackFailedDispatch(worker.id, workerEntry, threadKey, err)
            throw err
          }
          return { workerConversationId: worker.id }
        }
        const task = dispatchChain.then(run, run)
        dispatchChain = task.catch(() => undefined)
        return task
      }

      /**
       * 派工失败回滚（覆盖建会话后的全部副作用步骤）：移除 index worker 条目
       * 与 threadKey 绑定，空会话打上归档标签（不删除——会话本身无害且保留
       * 审计痕迹，与 archive_worker 同标签；各步均为幂等 best-effort，条目
       * 尚未写入时过滤为空操作）。回滚自身失败如实上抛（诚实性纪律），
       * 由调用方与 reportError 一并暴露。
       */
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
        assertRouterAuthority(conversationId)
        const workerId = assertWorkerConversationId(input.workerConversationId)
        if (!isRegisteredWorker(workerId)) {
          throw new HelmError('not_found', `会话 #${workerId} 不是已登记的后台 Worker`, 404, {
            workerConversationId: workerId,
          })
        }
        const detail = await deps.getConversationDetail(workerId, { limit: 20 })
        const artifacts = await deps.listArtifacts(workerId)
        const summaries = recentEntrySummaries(deps, detail.entries)
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
        assertRouterAuthority(conversationId)
        const limit = input.limit === undefined ? 10 : input.limit
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > 100) {
          throw new HelmError('validation_error', `limit 必须是 1..100 整数（收到：${String(input.limit)}）`, 400, {})
        }
        const query = input.query === undefined ? '' : String(input.query)
        // 只读检索工具：无 doc 写副作用（routing 镜像仅在启动与配置更新路径回写）。
        return { nodes: searchRecallNodes(docs!.recall.get(), query, limit) }
      }

      const subscribeThread = async (
        input: { threadKey: string; workerConversationId: number },
        conversationId: number | undefined,
      ): Promise<{ threadKey: string; workerConversationId: number }> => {
        assertRouterAuthority(conversationId)
        const key = assertThreadKey(input.threadKey)
        const workerId = assertWorkerConversationId(input.workerConversationId)
        if (!isRegisteredWorker(workerId)) {
          throw new HelmError('not_found', `会话 #${workerId} 不是已登记的后台 Worker`, 404, {
            workerConversationId: workerId,
          })
        }
        const run = async (): Promise<{ threadKey: string; workerConversationId: number }> => {
          // 互斥区内再次验证：排队期间 Worker 可能已被归档/删除。
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
            // 目标已失效：清理残留后改绑。
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
        }
        const task = dispatchChain.then(run, run)
        dispatchChain = task.catch(() => undefined)
        return task
      }

      const archiveWorker = async (
        input: { workerConversationId: number },
        conversationId: number | undefined,
      ): Promise<{ archived: true }> => {
        assertRouterAuthority(conversationId)
        const workerId = assertWorkerConversationId(input.workerConversationId)
        // 现读会话 + index：拒绝伪 worker 标签被接管；拒绝 busy 归档。
        const summary = readConversationOrUndefined(workerId)
        const registered = readIndex().workers.some((w) => w.conversationId === workerId)
        if (summary === undefined || !registered || !summary.tags.includes(WORKER_TAG)) {
          throw new HelmError('not_found', `会话 #${workerId} 不是 builtin:superagent 登记的后台 Worker`, 404, {
            workerConversationId: workerId,
          })
        }
        if (summary.tags.includes(WORKER_ARCHIVED_TAG)) return { archived: true } // 幂等
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
        // 互斥区内串行：防与 subscribe/turn_settled 并发读改写。
        const run = async (): Promise<{ archived: true }> => {
          // 互斥区内现读：排队期间可能开始新回合/进入结算，此时仍拒绝。
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
        }
        const task = dispatchChain.then(run, run)
        dispatchChain = task.catch(() => undefined)
        return task
      }

      const setRouterMode = async (
        input: { enabled: boolean },
        conversationId: number | undefined,
      ): Promise<{ routerMode: boolean }> => {
        assertRouterAuthority(conversationId)
        if (typeof input.enabled !== 'boolean') {
          throw new HelmError('validation_error', 'enabled 必须是布尔值', 400, {})
        }
        await deps.setRouterMode(input.enabled)
        // 成功后从真实配置回读更新镜像（配置单一来源；镜像不作为配置依据）。
        const applied = getConfig()
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

      // ---- ctx.action：HTTP/CLI/Workflow 五端复用同 handler（不 exposeAsTool，防重复工具） ----
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

      // ------------------------------------------------------------------
      // helm.rewind 联动：conversation.entry 订阅清理 RecallGraph
      // ------------------------------------------------------------------

      /**
       * rewind 截断标记到达：删除该会话中 inputIds 与 omittedInputIds 相交的
       * 节点（只清受影响回合；其他会话与前轮不受影响），并推进该会话 rewind
       * 纪元使在途结算不写旧节点。已向中枢发出的历史汇报是外部已消费副作用，
       * 不回滚篡改。
       */
      const handleRewindMarker = (conversationId: number, entry: ConversationEntry): void => {
        const omitted = rewindOmittedInputIds(entry)
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

      /**
       * 停用期间错过的 rewind 补偿：对已有 recall 节点的会话分页读详情，依据
       * 保留的 rewind 标记 omittedInputIds 清理已失效节点。页面大小 500，跟
       * nextCursor 翻到头；API 不可读显式抛出（service.start 显式失败），不伪成功。
       */
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
              page = await deps.getConversationDetail(conversationId, {
                limit: REWIND_REPLAY_PAGE_SIZE,
                ...(cursor !== undefined ? { cursor } : {}),
              })
            } catch (err) {
              // 会话已删：详情事实性不可得（not_found），该会话节点无法验证、
              // 保留原样（归档/删除 Worker 的历史仍可召回），不算 API 故障。
              // 其余失败如实上抛（service.start 显式失败，不伪成功）。
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

      // ------------------------------------------------------------------
      // turn_settled：origin 汇报 + RecallGraph（三态统一）
      // ------------------------------------------------------------------

      ctx.hook.onTurnSettled(async (payload) => {
        if (!active) return
        const conversation = payload.conversation
        if (conversation.id === getRouterConversationId()) return
        if (conversation.id === getWatchdogConversationId()) return
        if (!readIndex().workers.some((w) => w.conversationId === conversation.id)) return
        // 现读会话标签：归档竞态下 tag 已翻转为 worker-archived 则不再当活跃 worker。
        const current = readConversationOrUndefined(conversation.id)
        if (current === undefined || !current.tags.includes(WORKER_TAG)) return

        const nodeId = `${conversation.id}:${conversation.completionSeq}`
        // completionSeq 稳定去重（同步检查 + 写入时复查，双保险防并发重复结算）。
        if (recallHasNode(docs!.recall.get(), nodeId)) return

        // 结算期间禁止归档（防止 SSE 已 done、异步写图未完时被归档丢末回合摘要）。
        settlingWorkers.set(conversation.id, (settlingWorkers.get(conversation.id) ?? 0) + 1)
        try {
          const hasAgentOrTrigger = payload.inputs.some((i) => i.origin === 'agent' || i.origin === 'trigger')
          // 本回合消费的输入 ID（去重）：rewind omittedInputIds 命中即删本节点。
          const inputIds = [...new Set(payload.inputs.map((i) => i.id))]
          // 结算前纪元快照：await 期间发生 helm.rewind 即放弃写图/汇报，
          // 防止被覆盖的旧回合在编辑重发后复活进记忆图谱。
          const epochAtStart = rewindEpochs.get(conversation.id) ?? 0
          const { summary, artifacts, keywords } = await collectWorkerSettlement(deps, payload)
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
          if (!updateRecallDoc(docs!.recall, node)) return // 同 ID 已存在：不投第二份汇报

          if (!hasAgentOrTrigger) return // 纯 human 回合：仅静默更新记忆图谱
          // await 期间可能被并发归档：现查活跃性，防止向中枢写「幽灵汇报」。
          const workerStillActive =
            readIndex().workers.some((w) => w.conversationId === conversation.id) &&
            readConversationOrUndefined(conversation.id)?.tags.includes(WORKER_TAG) === true
          if (!workerStillActive) return
          // 汇报提交前再次校验纪元：await collectWorkerSettlement 期间可能刚发生
          // rewind（与写图同一保护窗口），旧回合汇报不再投递。
          if ((rewindEpochs.get(conversation.id) ?? 0) !== epochAtStart) return
          const target = getRouterConversationId()
          if (target === undefined || shutdown || deps.isClosing()) return
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
            // 显式上报，不吞；不因汇报失败阻塞结算管道其余插件。
            reportError(`Worker #${conversation.id} 汇报投递失败`, err)
          }
        } finally {
          const remaining = (settlingWorkers.get(conversation.id) ?? 1) - 1
          if (remaining === 0) settlingWorkers.delete(conversation.id)
          else settlingWorkers.set(conversation.id, remaining)
        }
      })

      // ------------------------------------------------------------------
      // config schema + service（自举/托管/watchdog 挂载）
      // ------------------------------------------------------------------

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

      ctx.service({
        id: 'superagent-core',
        liveTasks() {
          // 受跟踪后台任务（派工提交/汇报/通知）+ 现场扫描 index 中仍在
          // working/blocked 的 Worker + 两个常驻会话自身（中枢/看门狗在模型
          // 回合中时停用会撤掉在用工具与保护，必须阻塞）。同步现读，空闲
          // 值守会话不计入，也不残留计数；归档/删除后 index 移除即自然出清。
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
          await bootstrapAssets(deps)
          // 三个 doc 读入即验证（持久损坏显式 error，不静默重建）。
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
          // 停用期间错过的 helm.rewind 补偿（分页读详情；API 不可读则本 start
          // 显式失败，绝不伪成功）。
          await replayMissedRewinds()
          // conversation.entry 订阅：实时 helm.rewind 联动（退订句柄随本周期）。
          entriesUnsubscribe = deps.subscribeConversationEntries((conversationId, entry) => {
            if (!active || shutdown) return
            if (entry.kind !== 'helm.rewind') return
            handleRewindMarker(conversationId, entry)
          })
          // 启动时以真实配置校准 routing 镜像（停用期间可能被 helm plugins config 修改）。
          syncRoutingDoc()
          active = true
        },
        async stop() {
          // 先置位阻止新汇报/通知（关停后的 abort 回调不再唤醒 router），
          // 再释放托管与归属状态；hostReleases 由宿主兜底释放（幂等）。
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

      // ------------------------------------------------------------------
      // Watchdog 独立模块挂载（同步声明于 definePlugin 阶段：hook/tool/service
      // 生命周期归属本启用周期；其 service.start 后于 superagent-core，getter
      // 可实时读取 router/watchdog 会话 ID，无需自举时序耦合）
      // ------------------------------------------------------------------
      registerSuperAgentWatchdog(ctx, deps, {
        getConfig,
        getRouterConversationId,
        getWatchdogConversationId,
        track,
      })

      // ------------------------------------------------------------------
      // UI 贡献（@json-render 声明式；无 Emoji；icon 用 lucide 线性名）
      // ------------------------------------------------------------------

      ctx.ui.sidebarItem({
        id: 'superagent-router',
        label: 'SuperAgent 中枢',
        icon: 'network',
        target: `conversation:profile:${SUPERAGENT_PROFILE_ID}`,
        order: 10,
      })
      ctx.ui.sidebarItem({
        id: 'superagent-watchdog',
        label: '巡检看门狗',
        icon: 'shield',
        target: `conversation:profile:${WATCHDOG_PROFILE_ID}`,
        order: 11,
      })
      ctx.ui.sidebarItem({
        id: 'superagent-recall',
        label: '记忆与订阅图谱',
        icon: 'git-fork',
        target: `screen:${SUPERAGENT_PLUGIN_ID}/${RECALL_DOC_NAME}`,
        order: 12,
      })
      ctx.ui.sidebarSection({
        id: 'superagent-workers',
        label: '后台 Worker',
        icon: 'boxes',
        filterTag: WORKER_TAG,
        order: 20,
      })
      ctx.ui.sidebarSection({
        id: 'archived-workers',
        label: '已归档 Worker',
        icon: 'archive',
        filterTag: WORKER_ARCHIVED_TAG,
        collapsible: true,
        defaultCollapsed: true,
        order: 90,
      })
      ctx.ui.composerWidget({
        id: 'superagent-router-status',
        title: '中枢态势',
        scope: ROUTER_TOOL_SCOPE,
        docs: [INDEX_DOC_NAME, SUBSCRIPTIONS_DOC_NAME],
        json: {
          component: 'Card',
          children: [
            { component: 'Text', variant: 'title', text: '中枢态势' },
            { component: 'Text', variant: 'muted', text: '活跃 Worker {$docs.index.workers.length} 个；事件订阅 {$docs.subscriptions.subscriptions.length} 条。' },
            {
              component: 'Table',
              columns: [
                { key: 'conversationId', label: 'Worker' },
                { key: 'profileId', label: 'Profile' },
              ],
              rows: '{$docs.index.workers}',
              rowActions: [{ label: '打开', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}' } }],
            },
          ],
        },
      })
      ctx.ui.composerPill({
        id: 'superagent-router-mode',
        label: '中枢路由',
        title: '中枢路由收敛模式',
        scope: ROUTER_TOOL_SCOPE,
        docs: [ROUTING_DOC_NAME],
        json: {
          component: 'Switch',
          label: '中枢路由',
          value: '{$docs.routing.routerMode}',
          action: { type: 'helm:action', actionId: 'set_router_mode', input: { enabled: '{$value}' } },
        },
      })
      ctx.ui.toolView({
        id: 'superagent-dispatch',
        title: '派工状态',
        toolNames: ['dispatch_worker'],
        docs: [INDEX_DOC_NAME],
        json: {
          component: 'Card',
          children: [
            { component: 'Text', variant: 'title', text: '后台 Worker 派工' },
            {
              component: 'Table',
              columns: [
                { key: 'conversationId', label: '会话' },
                { key: 'profileId', label: 'Profile' },
              ],
              rows: '{$docs.index.workers}',
              rowActions: [
                { label: '查看', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}' } },
                { label: '归档', action: { type: 'helm:action', actionId: 'archive_worker', input: { workerConversationId: '{$row.conversationId}' } } },
              ],
            },
          ],
        },
      })
      ctx.ui.timelineRenderer({
        id: 'superagent-worker-report',
        title: 'Worker 汇报卡',
        matchMeta: { renderer: WORKER_REPORT_RENDERER },
        json: {
          component: 'Card',
          children: [
            { component: 'Badge', tone: 'accent', icon: 'bot', text: 'Worker 汇报' },
            { component: 'Text', variant: 'body', text: '{$data.entry.data.meta.summary}' },
            {
              component: 'ActionBar',
              actions: [{ label: '在右屏并排打开', action: { type: 'helm:open', target: 'conversation:{$data.entry.data.meta.workerId}', split: true } }],
            },
          ],
        },
      })
      ctx.ui.screen({
        id: RECALL_DOC_NAME,
        label: '记忆与订阅图谱',
        icon: 'git-fork',
        docs: [RECALL_DOC_NAME, SUBSCRIPTIONS_DOC_NAME],
        json: {
          component: 'Stack',
          children: [
            { component: 'Text', variant: 'title', text: 'RecallGraph 记忆图谱' },
            {
              component: 'Table',
              columns: [
                { key: 'conversationId', label: '会话' },
                { key: 'profileId', label: 'Profile' },
                { key: 'outcome', label: '终态' },
                { key: 'summary', label: '摘要' },
              ],
              rows: '{$docs["recall-graph"].nodes}',
              rowActions: [{ label: '打开会话', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}' } }],
            },
            { component: 'Text', variant: 'title', text: '事件订阅' },
            {
              component: 'Table',
              columns: [
                { key: 'threadKey', label: 'ThreadKey' },
                { key: 'workerConversationId', label: 'Worker' },
              ],
              rows: '{$docs.subscriptions.subscriptions}',
              rowActions: [{ label: '打开 Worker', action: { type: 'helm:open', target: 'conversation:{$row.workerConversationId}' } }],
            },
          ],
        },
      })
      ctx.ui.settingsPanel({
        id: 'superagent-settings',
        label: 'SuperAgent 中枢',
        order: 30,
        docs: [INDEX_DOC_NAME],
        json: {
          component: 'Stack',
          children: [
            { component: 'Text', variant: 'title', text: 'SuperAgent 中枢' },
            {
              component: 'Text',
              variant: 'muted',
              text: '修改路由开关、静默事件源与看门狗参数请前往本插件的配置项设置；本面板只读展示托管状态。',
            },
            {
              component: 'KeyValueList',
              items: [
                { key: '/$docs/index/routerConversationId', label: '中枢会话' },
                { key: '/$docs/index/watchdogConversationId', label: '看门狗会话' },
              ],
            },
          ],
        },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// RecallGraph 纯函数（导出供测试复用）
// ---------------------------------------------------------------------------

/** helm.rewind 截断标记携带的被覆盖输入 ID（omittedInputIds）；载荷非法返回 undefined。 */
export function rewindOmittedInputIds(entry: ConversationEntry): string[] | undefined {
  if (entry.kind !== 'helm.rewind') return undefined
  const data = entry.data as { omittedInputIds?: unknown } | undefined
  const raw = data?.omittedInputIds
  if (!Array.isArray(raw)) return undefined
  const ids: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || v === '') return undefined
    ids.push(v)
  }
  return ids
}

/**
 * 从 RecallGraph 删除指定会话中 inputIds 与给定集合相交的节点（原地 doc 写回）。
 * 返回被删除的节点 ID（供诊断与测试断言）；doc 无相交节点时零写回。
 */
export function removeRecallNodesByInputs(
  handle: { get(): unknown; set(value: unknown): void },
  conversationId: number,
  omittedInputIds: ReadonlySet<string>,
): string[] {
  if (omittedInputIds.size === 0) return []
  const doc = handle.get()
  assertRecallDoc(doc)
  const nodes = (doc as RecallGraphDoc).nodes
  const removed: string[] = []
  const kept = nodes.filter((n) => {
    if (n.conversationId !== conversationId) return true
    const hit = n.inputIds.some((id) => omittedInputIds.has(id))
    if (hit) removed.push(n.id)
    return !hit
  })
  if (removed.length > 0) handle.set({ version: 1, nodes: kept })
  return removed
}

/** recall doc 是否已含指定节点 ID（读入即验证）。 */
export function recallHasNode(docRaw: unknown, nodeId: string): boolean {
  assertRecallDoc(docRaw)
  return (docRaw as { nodes: Array<{ id: string }> }).nodes.some((n) => n.id === nodeId)
}

/** updateRecallDoc 输入：RecallNode 的结构化形状（不要求索引签名）。 */
export interface RecallNodeInput {
  id: string
  conversationId: number
  profileId: string
  completionSeq: number
  inputIds: string[]
  outcome: TurnOutcome | string
  summary: string
  artifacts: unknown[]
  keywords: string[]
  createdAt: number
}

/** 去重写入：同 id 节点已存在返回 false（不重复追加）；写入时复查防并发。 */
export function updateRecallDoc(
  handle: { get(): unknown; set(value: unknown): void },
  node: RecallNodeInput,
): boolean {
  const doc = handle.get()
  assertRecallDoc(doc)
  if (!SETTLED_OUTCOMES.has(node.outcome)) {
    throw new HelmError('validation_error', `outcome 必须是 completed|failed|aborted（收到 ${node.outcome}）`, 400, {})
  }
  const current = doc as { version: 1; nodes: Array<{ id: string }> }
  if (current.nodes.some((n) => n.id === node.id)) return false
  // 写入前对产物节点整体校验：破损节点在边界显式拒绝，绝不落库读不回的数据。
  assertRecallDoc({ version: 1, nodes: [...current.nodes, node] })
  handle.set({ version: 1, nodes: [...current.nodes, node] })
  return true
}

/** 关键词检索：query 分词（空白/逗号），全部命中（AND）才返回；倒序（新在前）。 */
export function searchRecallNodes(docRaw: unknown, query: string, limit: number): unknown[] {
  assertRecallDoc(docRaw)
  const nodes = (docRaw as { nodes: unknown[] }).nodes
  const terms = query.split(/[\s,]+/).filter((t) => t !== '')
  const matched =
    terms.length === 0
      ? nodes
      : nodes.filter((n) => {
          const node = n as { id?: string; profileId?: string; summary?: string; keywords?: string[] }
          const haystack = [node.id ?? '', node.profileId ?? '', node.summary ?? '', ...(node.keywords ?? [])]
            .join('\n')
            .toLowerCase()
          return terms.every((t) => haystack.includes(t.toLowerCase()))
        })
  return matched.slice(-limit).reverse()
}

/** 从真实会话详情与产物列表收集结算摘要（不调用模型）。 */
export async function collectWorkerSettlement(
  deps: SuperAgentDependencies,
  payload: TurnSettledPayload,
): Promise<{ summary: string; artifacts: ArtifactMetadata[]; keywords: string[] }> {
  const id = payload.conversation.id
  const [detail, artifacts] = await Promise.all([
    deps.getConversationDetail(id, { limit: 10 }),
    deps.listArtifacts(id),
  ])
  const lastText = lastAssistantText(detail.entries)
  const outcome: TurnOutcome = payload.outcome
  const head =
    outcome === 'completed'
      ? lastText !== ''
        ? lastText
        : `Worker #${id}（${payload.conversation.profileId}）回合完成`
      : outcome === 'failed'
        ? `Worker #${id}（${payload.conversation.profileId}）回合失败${payload.error !== undefined ? `：${payload.error}` : ''}`
        : `Worker #${id}（${payload.conversation.profileId}）回合被中止`
  const summary = truncate(deps.redact(head), 600)
  const keywords = [payload.conversation.profileId, outcome, detail.title]
    .filter((k) => k !== '')
    .map((k) => deps.redact(k))
  const redactedArtifacts = redactJsonValue(artifacts, (t) => deps.redact(t)) as ArtifactMetadata[]
  return { summary, artifacts: redactedArtifacts, keywords }
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** 时间线条目受控摘要：assistant 取真实文本，其余取 JSON 概要（脱敏 + 截断）。 */
export function recentEntrySummaries(
  deps: SuperAgentDependencies,
  entries: Array<{ id: string; kind: string; data?: unknown; model?: unknown }>,
  maxEntries = 20,
): Array<{ id: string; kind: string; text: string }> {
  const redacted = redactJsonValue(entries.slice(-maxEntries), (t) => deps.redact(t)) as typeof entries
  return redacted.map((e) => ({
    id: e.id,
    kind: e.kind,
    text: truncate(entryDigestText(e), 400),
  }))
}

/** 单条 entry 摘要文本：优先 assistant 文本，否则有界 JSON 概要（不伪造内容）。 */
function entryDigestText(entry: { kind: string; data?: unknown; model?: unknown }): string {
  const assistant = lastAssistantText([entry])
  if (assistant !== '') return assistant
  if (entry.data !== undefined) {
    const json = JSON.stringify(entry.data)
    return json.length > 400 ? `${json.slice(0, 399)}…` : json
  }
  return ''
}

/** entry.model 首条 assistant 文本（协议形状：model[].content[].text）。 */
function lastAssistantText(entries: Array<{ kind?: string; model?: unknown }>): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const model = entries[i]!.model
    if (!Array.isArray(model)) continue
    for (let j = model.length - 1; j >= 0; j -= 1) {
      const blocks = (model[j] as { content?: unknown } | undefined)?.content
      if (!Array.isArray(blocks)) continue
      const texts = blocks
        .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    }
  }
  return ''
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function escapeXmlAttribute(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
