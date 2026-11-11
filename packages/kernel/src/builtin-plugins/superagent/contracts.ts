import {
  HelmError,
  type ArtifactMetadata,
  type ConversationEntryEvent,
  type ConversationScope,
  type ConversationSummary,
  type HelmPluginContext,
  type MaybePromise,
  type PluginDocHandle,
  type TurnOutcome,
} from '@helm/protocol'

/*
 * SuperAgentDependencies 已删除：业务依赖全部经公开 ctx.host 端口
 *（profiles/skills/getConversationDetail/listArtifacts/abortConversation/
 * getConversationOwnership/getConversationActivity/redact/isClosing/
 * setConfig/onEvent('conversation.entry')），不再有组合层私有 DI 面。
 */

// ---------------------------------------------------------------------------
// 常量定义
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
export const ROUTER_BLOCKED_TOOL_NAMES = new Set(['edit', 'write', 'bash', 'subagent', 'SubagentWorkflow'])

/** 中枢工具/动作的会话作用域：仅 superagent Profile 会话可见/可执行。 */
export const ROUTER_TOOL_SCOPE: ConversationScope = { profileIds: [SUPERAGENT_PROFILE_ID] }

export const DEFAULT_CONFIG: SuperAgentConfig = {
  routerMode: true,
  mutedSources: '',
  watchdogEnabled: true,
  stalledAfterMs: 300_000,
  abortAfterMs: 1_800_000,
  errorThreshold: 3,
}

/** 启用补偿分页读取页面大小（详情 API 上限 500，一次拉满减少往返）。 */
export const REWIND_REPLAY_PAGE_SIZE = 500

// ---------------------------------------------------------------------------
// 领域模型契约
// ---------------------------------------------------------------------------

export interface SuperAgentConfig {
  routerMode: boolean
  /** 逗号或换行分隔的精确事件源名称。 */
  mutedSources: string
  watchdogEnabled: boolean
  stalledAfterMs: number
  abortAfterMs: number
  errorThreshold: number
}

export interface SuperAgentWorker {
  conversationId: number
  parentConversationId: number
  profileId: string
  createdAt: number
}

export interface SuperAgentIndexDoc {
  version: 1
  routerConversationId?: number
  watchdogConversationId?: number
  workers: SuperAgentWorker[]
}

export interface ThreadSubscription {
  threadKey: string
  workerConversationId: number
  createdAt: number
}

export interface ThreadSubscriptionDoc {
  version: 1
  subscriptions: ThreadSubscription[]
}

export interface RecallNode {
  /** 会话 ID 与 completionSeq 组成的稳定结算标识。 */
  id: string
  conversationId: number
  profileId: string
  completionSeq: number
  /** 本回合消费的输入 ID（去重；helm.rewind omittedInputIds 命中即删节点）。 */
  inputIds: string[]
  outcome: TurnOutcome
  summary: string
  artifacts: ArtifactMetadata[]
  keywords: string[]
  createdAt: number
}

export interface RecallGraphDoc {
  version: 1
  nodes: RecallNode[]
}

/** 路由模式公开只读镜像（UI pill 数据源；由真实配置回写，不作为配置来源）。 */
export interface RouterModeDoc {
  version: 1
  routerMode: boolean
}

export interface SuperAgentDocs {
  index: PluginDocHandle<SuperAgentIndexDoc>
  subscriptions: PluginDocHandle<ThreadSubscriptionDoc>
  recall: PluginDocHandle<RecallGraphDoc>
  routing: PluginDocHandle<RouterModeDoc>
}

/** Watchdog 共用插件生命周期；所有脱离 Hook 的异步任务必须被跟踪。 */
export interface SuperAgentWatchdogRuntime {
  getConfig(): SuperAgentConfig
  getRouterConversationId(): number | undefined
  getWatchdogConversationId(): number | undefined
  track<T>(label: string, task: () => MaybePromise<T>): Promise<T>
}

export type RegisterSuperAgentWatchdog = (
  ctx: HelmPluginContext,
  runtime: SuperAgentWatchdogRuntime,
) => void

/** 模块间协作协调器契约（解耦 superagent.ts 与 actions/hooks 子模块）。 */
export interface SuperAgentCoordinator {
  isActive(): boolean
  isShutdown(): boolean
  getConfig(): SuperAgentConfig
  getRouterConversationId(): number | undefined
  getWatchdogConversationId(): number | undefined
  getDocs(): SuperAgentDocs
  readIndex(): SuperAgentIndexDoc
  readSubscriptions(): ThreadSubscriptionDoc
  updateIndex(fn: (doc: SuperAgentIndexDoc) => SuperAgentIndexDoc): SuperAgentIndexDoc
  updateSubscriptions(fn: (doc: ThreadSubscriptionDoc) => ThreadSubscriptionDoc): ThreadSubscriptionDoc
  isRegisteredWorker(conversationId: number): boolean
  readConversationOrUndefined(id: number | undefined): ConversationSummary | undefined
  reportError(title: string, detail: unknown): void
  syncRoutingDoc(): void
  enqueueDispatch<T>(task: () => Promise<T>): Promise<T>
  settlingWorkers: Map<number, number>
  rewindEpochs: Map<number, number>
}

// ---------------------------------------------------------------------------
// 边界守卫与工具纯函数
// ---------------------------------------------------------------------------

/**
 * conversation.entry 事件载荷边界守卫：公开 ConversationEntryEvent 形状
 *（type + conversationId 正整数 + entry.id/kind 非空字符串）；非法返回
 * undefined（调用方丢弃并诊断），绝不粗 as 信任。
 */
export function asConversationEntryEvent(payload: unknown): ConversationEntryEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const p = payload as Record<string, unknown>
  if (p['type'] !== 'conversation.entry') return undefined
  const conversationId = p['conversationId']
  if (typeof conversationId !== 'number' || !Number.isInteger(conversationId) || conversationId <= 0) return undefined
  const entry = p['entry']
  if (typeof entry !== 'object' || entry === null) return undefined
  const e = entry as Record<string, unknown>
  if (typeof e['id'] !== 'string' || e['id'] === '') return undefined
  if (typeof e['kind'] !== 'string' || e['kind'] === '') return undefined
  return payload as ConversationEntryEvent
}

/**
 * 跨平台绝对路径判定（插件纯函数；与内核工具同语义）：POSIX `/` 开头、
 * Windows 盘符 `C:\\...`/`C:/...` 或 UNC `\\\\server\\share`。
 * 目标节点可能与 Hub 异平台，不得用宿主 node:path 规则判定。
 */
export function isAbsoluteTargetPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 正整数会话 ID（> 0；无保留会话概念，常驻/worker 只需正整数）。 */
export function isPosIntId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** 非负有限 Unix 毫秒时间戳。 */
export function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

const docCorrupt = (detail: string): HelmError =>
  new HelmError('superagent_doc_corrupt', `插件 doc ${INDEX_DOC_NAME} ${detail}`, 500, { pluginId: SUPERAGENT_PLUGIN_ID })

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
