/**
 * builtin:superagent 插件 client 组件的纯数据模型（无组件导出，保 Fast Refresh 契约）。
 *
 * doc 形状只在此处声明（与 superagent/contracts.ts 服务端契约同构）；
 * 边界宽容解析：doc 尚未到达（undefined）或字段缺失时返回安全缺省，
 * 不虚构数据。
 */
import type { TimelineRendererProps, ToolViewProps } from '@helm/protocol'

/** SuperAgentIndexDoc（public doc 'index'）。 */
export interface SuperAgentIndexDoc {
  version: 1
  routerConversationId?: number
  watchdogConversationId?: number
  workers: Array<{ conversationId: number; parentConversationId: number; profileId: string; createdAt: number }>
}

/** ThreadSubscriptionDoc（public doc 'subscriptions'）。 */
export interface ThreadSubscriptionDoc {
  version: 1
  subscriptions: Array<{ threadKey: string; workerConversationId: number; createdAt: number }>
}

/** RecallGraphDoc（public doc 'recall-graph'）。 */
export interface RecallGraphDoc {
  version: 1
  nodes: Array<{
    id: string
    conversationId: number
    profileId: string
    completionSeq: number
    outcome: string
    summary: string
    artifacts: Array<{ id: string; name: string; size: number }>
    createdAt: number
  }>
}

/** RouterModeDoc（public doc 'routing'）。 */
export interface RouterModeDoc {
  version: 1
  routerMode: boolean
}

/** 读 doc 并宽容解析 workers 数组（undefined → 空表，不虚构）。 */
export function parseWorkers(doc: SuperAgentIndexDoc | undefined): SuperAgentIndexDoc['workers'] {
  return Array.isArray(doc?.workers) ? doc!.workers : []
}

export function parseSubscriptions(doc: ThreadSubscriptionDoc | undefined): ThreadSubscriptionDoc['subscriptions'] {
  return Array.isArray(doc?.subscriptions) ? doc!.subscriptions : []
}

export function parseRecallNodes(doc: RecallGraphDoc | undefined): RecallGraphDoc['nodes'] {
  return Array.isArray(doc?.nodes) ? doc!.nodes : []
}

export function parseRouterMode(doc: RouterModeDoc | undefined): boolean | undefined {
  return typeof doc?.routerMode === 'boolean' ? doc!.routerMode : undefined
}

/** worker-report 时间线 entry.data.meta 形状（服务端 submitInput meta 投影）。 */
export interface WorkerReportMeta {
  renderer?: string
  workerId?: number
  profileId?: string
  outcome?: string
  completionSeq?: number
  summary?: string
  artifacts?: Array<{ id: string; name: string; size: number }>
}

/** 从 TimelineRendererProps.entry 提取 worker 汇报 meta（缺失字段如实 undefined）。 */
export function workerReportMeta(props: TimelineRendererProps): WorkerReportMeta {
  const data = props.entry.data as { meta?: WorkerReportMeta } | undefined
  return data?.meta ?? {}
}

/** dispatch_worker 工具调用 input 形状。 */
export interface DispatchToolInput {
  prompt?: string
  profileId?: string
  title?: string
  threadKey?: string
}

/** 宽容解析 dispatch_worker 工具 input。 */
export function dispatchInput(props: ToolViewProps): DispatchToolInput {
  const input = props.input
  if (typeof input !== 'object' || input === null) return {}
  const raw = input as Record<string, unknown>
  const out: DispatchToolInput = {}
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt
  if (typeof raw.profileId === 'string') out.profileId = raw.profileId
  if (typeof raw.title === 'string') out.title = raw.title
  if (typeof raw.threadKey === 'string') out.threadKey = raw.threadKey
  return out
}

/** dispatch_worker 工具结果中的 workerConversationId（done 才有；缺失如实 undefined）。 */
export function dispatchedWorkerId(props: ToolViewProps): number | undefined {
  const raw = props.structuredOutput as { workerConversationId?: unknown } | undefined
  const id = raw?.workerConversationId
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
}

/** 终态徽章色调：completed→ok，failed→err，aborted→warn，其他→neutral。 */
export function outcomeTone(outcome: string | undefined): 'ok' | 'err' | 'warn' | 'neutral' {
  if (outcome === 'completed') return 'ok'
  if (outcome === 'failed') return 'err'
  if (outcome === 'aborted') return 'warn'
  return 'neutral'
}

/** 终态展示文本（缺失时如实返回原值或占位）。 */
export function outcomeLabel(outcome: string | undefined): string {
  if (outcome === undefined || outcome === '') return '未知'
  return outcome
}
