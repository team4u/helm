import type {
  ArtifactMetadata,
  ConversationDetail,
  HelmPluginContext,
  MaybePromise,
  PluginDocHandle,
  TurnOutcome,
  WatchdogOwnership,
} from '@helm/protocol'
import type { ProfileService, SkillService } from '../../services/index.js'

/** 业务策略依赖由组合层注入，不扩张通用 ctx.host。 */
export interface SuperAgentDependencies {
  dataDir: string
  profiles: ProfileService
  skills: SkillService
  getConversationDetail(id: number, options?: { limit?: number; cursor?: string }): Promise<ConversationDetail>
  listArtifacts(conversationId: number): Promise<ArtifactMetadata[]>
  abortConversation(conversationId: number): Promise<void>
  getConversationOwnership(conversationId: number): WatchdogOwnership
  isClosing(): boolean
  setRouterMode(enabled: boolean): Promise<void>
  redact(text: string): string
}

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
  deps: SuperAgentDependencies,
  runtime: SuperAgentWatchdogRuntime,
) => void
