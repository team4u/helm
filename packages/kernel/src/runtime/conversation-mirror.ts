/**
 * 单会话内存镜像（ConversationMirror）：ConversationTracker 全部按会话
 * 生命周期的运行态聚合。
 *
 * Why 聚合：此前 30+ 个 Map<number,…> 字段各自为政，stopObserving 需手工
 * 逐 map 删除约 40 行，漏删即泄漏（反复建删会话的进程随时间无限累积残留）。
 * 聚合后 stopObserving 一次 delete 即整体回收；字段语义与迁移前逐一对应。
 *
 * 生命周期：观察建立（observe）或首次写入时创建；observer.end 只清 detach
 * （其余镜像保留，供重观察与摘要派生）；stopObserving 整体删除。
 * 例外（不进镜像，仍归 tracker 顶层）：
 * - settledRuns：跨会话去重集合（`${conversationId}:${taskId}` 前缀键全局唯一）；
 * - notifiedCompactionFailures：不随 stopObserving 清除（同 runtime 内重观察
 *   不得再报同一压缩失败）；
 * - contextUsage 缓存/刷新链：独立生命周期（在途刷新可跨越停观），见
 *   context-usage-refresh.ts。
 */

import type { ConversationInput, ConversationLive, InputOrigin, WhenBusy } from '@helm/protocol'
import type { LiveCompactionFailureShape, LiveCompactionShape } from './context-usage.js'

/** SDK pi.live 文档的结构子集（tracker 观察形状）。 */
export interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number; first?: number }
  generation?: { attempt?: unknown; message?: unknown; retry?: unknown; deferred?: unknown }
  tools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  nestedTools?: Array<{ callId: string; name: string; status: string; arguments?: unknown; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
  /** 进行中的压缩任务（taskId 序；SDK CompactionStatus 的结构子集）。 */
  compactions?: LiveCompactionShape[]
  /** 最近一次压缩失败（SDK CompactionFailure 的结构子集）。 */
  compactionFailure?: LiveCompactionFailureShape
}

/** pi.inbox 文档的结构子集（queued 提交：submissionId -> entry 载荷）。 */
export interface InboxItemShape {
  id: number
  mode: 'steer' | 'followUp' | 'write'
  entry?: { kind?: string; data?: unknown }
}

/** helm.input entry / inbox item 的元数据载荷形状。 */
export interface HelmInputMeta {
  id?: string
  text?: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: unknown
}

/** 单会话聚合镜像：字段与迁移前的同名 Map 条目一一对应。 */
export interface ConversationMirror {
  /** SDK 观察者返回的 detach（观察存续期；observer.end / stopObserving 清除）。 */
  detach: (() => void) | undefined
  /** 当前 pi.live 镜像（最近一次 advance 值；adopt/adoptInitial 归一为对象）。 */
  live: LiveStateShape | undefined
  /** 当前 pi.inbox 排队项镜像（queuedInputs 派生与实时推送用）。 */
  inbox: ReadonlyArray<InboxItemShape> | undefined
  /** requestId（= input.id）-> 输入元数据（唯一追踪身份；提交登记与 entry/inbox
   * 观察重建按 requestId 幂等合并为唯一记录）。 */
  trackedInputs: Map<string, ConversationInput>
  /** submissionId -> requestId：SDK 接口关联索引（live.run.inputs /
   * runFailure.inputs / withdraw 均以 submissionId 表达，经此映射回追踪身份）。
   *
   * 写入来源：bindSubmission（submit 返回）、adoptInputsFromInbox（inbox 项
   * id 即 submissionId）、重启恢复的 submission 精确查询；结算/撤回时清理。 */
  submissionIndex: Map<number, string>
  /** 输入重建下界 entry id（单调不回退：新 run 取 run.first 向上推，run 结束
   * 不清除——窗口内已结算的 helm.input 不再被下一快照复活）。 */
  runFirstEntry: number | undefined
  /** 本回合已消费 requestId 集（run 存续期间累计，新 taskId 重置）。 */
  consumedInputs: Set<string> | undefined
  /** 当前 run 的 taskId（多 tool round 不变；变化才重置消费集）。 */
  runTaskId: number | undefined
  /** 已结算 runKey 插入序（容量淘汰用，与全局 settledRuns 同步维护）。 */
  settledRunOrder: string[]
  /** 最近一个已结算 run 的 taskId（显式 abort 防重入）。 */
  lastSettledRun: number | undefined
  /** 在途 turn_settled 回调计数（waitForIdle 按会话等待）。 */
  settledInflight: number
  /** 回调链首个错误（计数归零后的新链清除；waitForIdle 重放抛出）。 */
  settledError: unknown
  /** 在途 turn_settled 回调链等待者（计数归零时全部唤醒）。 */
  settledWaiters: Array<() => void>
  /** 已发过 conversation.entry 的最大 entry id（观察窗口内单调）。 */
  lastEmittedEntry: number
  /** 待发 live 快照（节流窗口内的最新值；终态时强制冲刷）。 */
  pendingLive: ConversationLive | undefined
  /** 节流冲刷 timer（stopObserving/close 必须清理，防删除后幽灵事件）。 */
  liveTimer: ReturnType<typeof setTimeout> | undefined
  /** 上次 live 内容指纹（相同快照不重复发帧）。 */
  lastLiveKey: string | undefined
  /** 上次已发 queuedInputs 指纹（入队/出队 0ms 冲刷判定；未登记视为 '[]'）。 */
  lastQueuedLiveKey: string | undefined
  /** 最近一次已推送摘要的语义指纹（status|doing|pendingAsk；相同不重发）。 */
  lastSummaryKey: string | undefined
  /** 每次观察独立令牌；停观即随镜像删除，迟到异步结果不得复活状态。 */
  observeGeneration: symbol | undefined
  /** 最新 assistant 文本缓存（getLastAssistantText 数据源）。 */
  lastAssistant: { entryId: number; text: string } | undefined
  /** 待答 Ask 计数（blocked 态派生与 CAS 水位线）。 */
  pendingAskCount: number
}

export function createConversationMirror(): ConversationMirror {
  return {
    detach: undefined,
    live: undefined,
    inbox: undefined,
    trackedInputs: new Map(),
    submissionIndex: new Map(),
    runFirstEntry: undefined,
    consumedInputs: undefined,
    runTaskId: undefined,
    settledRunOrder: [],
    lastSettledRun: undefined,
    settledInflight: 0,
    settledError: undefined,
    settledWaiters: [],
    lastEmittedEntry: 0,
    pendingLive: undefined,
    liveTimer: undefined,
    lastLiveKey: undefined,
    lastQueuedLiveKey: undefined,
    lastSummaryKey: undefined,
    observeGeneration: undefined,
    lastAssistant: undefined,
    pendingAskCount: 0,
  }
}

/** 从 helm.input entry / inbox 载荷重建 ConversationInput（缺省字段不伪造）。 */
export function inputFromMeta(meta: HelmInputMeta): ConversationInput {
  return {
    id: meta.id!,
    text: meta.text!,
    origin: meta.origin ?? 'human',
    ...(typeof meta.whenBusy === 'string' ? { whenBusy: meta.whenBusy } : {}),
    createdAt: meta.createdAt ?? Date.now(),
    // meta 从 entry.data 重建贯通回 turn_settled payload（边界已校验
    // 为普通对象；非对象形状不伪造，直接丢弃该字段）。
    ...(isPlainRecord(meta.meta) ? { meta: meta.meta } : {}),
    ...(Array.isArray(meta.attachments)
      ? { attachments: meta.attachments as ConversationInput['attachments'] }
      : {}),
  }
}

/** 合并两份同 input.id 的元数据：重建值优先，内存中更完整的字段不丢失。 */
export function mergeInputMeta(existing: ConversationInput, rebuilt: ConversationInput): ConversationInput {
  return {
    ...rebuilt,
    ...(existing.meta !== undefined && rebuilt.meta === undefined ? { meta: existing.meta } : {}),
    ...(existing.attachments !== undefined && rebuilt.attachments === undefined
      ? { attachments: existing.attachments }
      : {}),
    ...(existing.whenBusy !== undefined && rebuilt.whenBusy === undefined
      ? { whenBusy: existing.whenBusy }
      : {}),
  }
}

/** 普通对象判定（null 与非对象不算；类实例不算）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
