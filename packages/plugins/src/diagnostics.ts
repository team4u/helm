/**
 * 插件间巡检/诊断共享契约（非 protocol 核心）。
 *
 * watchdog_tick 钩子已从内核移除：定时巡检完全归 builtin:superagent 的
 * ctx.service，外部事实（如 Herdr 终端窗格探针）经宿主内部事件
 * 'diagnostics.collect'（broadcast:false）由采集方追加。本模块是这条
 * 插件间契约的唯一权威定义，protocol/plugin.ts 不再承载任何 watchdog
 * 专用类型。
 */

/** 探针归属权：'human' 会话/终端窗格严禁发送按键或中止指令，仅允许只读诊断与通知。 */
export type WatchdogOwnership = 'helm' | 'bot' | 'human'

/** 探针目标类别：conversation = 原生会话；external = 外部运行时目标（如 Herdr 窗格）。 */
export type WatchdogTargetKind = 'conversation' | 'external'

/** 单个巡检探针采集到的事实。 */
export interface WatchdogProbe {
  /** 探针目标：会话 ID 或 Herdr 窗格 ID 等外部标识。 */
  targetId: string
  /** 目标类别；未声明类别的探针不作为自动干预授权。 */
  targetKind?: WatchdogTargetKind
  /** targetKind 为 conversation 时的原生目标会话 ID（仅目标本身；外部 pane 的父会话不得冒充此字段）。 */
  conversationId?: number
  /** targetKind 为 external 时的目标节点 ID（'local' 或 BYOM 节点 ID）。 */
  nodeId?: string
  ownedBy: WatchdogOwnership
  /** 目标当前状态（通用字符串，容纳会话五态与 Herdr 窗格状态）。 */
  status: string
  /** 权威状态变化序号（会话 stateChangeSeq / 外部 state_change_seq）；无法读取权威值时必须省略，绝不猜造。 */
  stateChangeSeq?: number
  /** 停滞毫秒数。 */
  stalledMs?: number
  /** 连续报错次数。 */
  consecutiveErrors?: number
  /** 附加事实（如终端尾部快照摘要）。 */
  facts?: Record<string, unknown>
}

/** 原生会话引用（巡检消费的最小字段；完整摘要由采集发起方自读宿主）。 */
export interface DiagnosticsConversationRef {
  id: number
  profileId: string
}

/** 单轮巡检快照：原生会话事实 + 外部采集方追加的探针。 */
export interface DiagnosticsCollection {
  timestamp: number
  /** 原生会话引用快照（采集发起方现读）。 */
  conversations: ReadonlyArray<DiagnosticsConversationRef>
  /** 探针集合：采集发起方先填原生会话探针，'diagnostics.collect' 监听方再追加外部探针。 */
  probes: WatchdogProbe[]
}

/** 宿主内部采集事件类型名（ctx.host.emitEvent(type, payload, { broadcast: false })）。 */
export const DIAGNOSTICS_COLLECT_EVENT = 'diagnostics.collect'

// ---------------------------------------------------------------------------
// 边界校验：事件入口 / 追加入口 / 终态复验三层同源（诚实性纪律）
// ---------------------------------------------------------------------------

import { HelmError } from '@helm/protocol'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 校验单个探针形状；返回错误描述（null = 合法）。与原 hooks.ts watchdog_tick 校验同构。 */
export function probeViolation(p: unknown): string | null {
  if (
    !isPlainObject(p) ||
    typeof p['targetId'] !== 'string' ||
    p['targetId'].length === 0 ||
    (p['targetKind'] !== undefined && !['conversation', 'external'].includes(String(p['targetKind']))) ||
    (p['conversationId'] !== undefined &&
      !(typeof p['conversationId'] === 'number' && Number.isInteger(p['conversationId']) && (p['conversationId'] as number) > 0)) ||
    (p['nodeId'] !== undefined && (typeof p['nodeId'] !== 'string' || p['nodeId'].length === 0)) ||
    !['helm', 'bot', 'human'].includes(String(p['ownedBy'])) ||
    typeof p['status'] !== 'string' ||
    (p['stateChangeSeq'] !== undefined &&
      !(typeof p['stateChangeSeq'] === 'number' && Number.isInteger(p['stateChangeSeq']) && (p['stateChangeSeq'] as number) >= 0)) ||
    (p['stalledMs'] !== undefined &&
      !(typeof p['stalledMs'] === 'number' && Number.isFinite(p['stalledMs']) && (p['stalledMs'] as number) >= 0)) ||
    (p['consecutiveErrors'] !== undefined &&
      !(typeof p['consecutiveErrors'] === 'number' && Number.isFinite(p['consecutiveErrors']) && (p['consecutiveErrors'] as number) >= 0)) ||
    (p['facts'] !== undefined && !isPlainObject(p['facts']))
  ) {
    return '字段 probes 的每项必须是 WatchdogProbe（targetKind/conversationId/nodeId/stateChangeSeq/stalledMs/consecutiveErrors 若存在必须类型合法且非负）'
  }
  return null
}

/** 校验 collection 整体形状（事件入口与终态复验共用）；返回错误描述（null = 合法）。 */
export function collectionViolation(value: unknown): string | null {
  if (!isPlainObject(value)) return '必须是 DiagnosticsCollection 对象'
  if (!(typeof value['timestamp'] === 'number' && Number.isFinite(value['timestamp']) && (value['timestamp'] as number) >= 0)) {
    return '字段 timestamp 必须是非负有限数'
  }
  const conversations = value['conversations']
  if (!Array.isArray(conversations)) return '字段 conversations 必须是数组'
  for (const ref of conversations) {
    if (!isPlainObject(ref) || typeof ref['id'] !== 'number' || !Number.isInteger(ref['id']) || (ref['id'] as number) <= 0 || typeof ref['profileId'] !== 'string') {
      return '字段 conversations 的每项必须是 { id: 正整数, profileId: string }'
    }
  }
  if (!Array.isArray(value['probes'])) return '字段 probes 必须是数组'
  for (const probe of value['probes']) {
    const violation = probeViolation(probe)
    if (violation !== null) return violation
  }
  return null
}

/**
 * 采集事件入口解析：监听方用它解析宿主事件载荷，形状非法立即显式抛错
 * （绝不把未知载荷当空 collection 静默继续）。
 */
export function parseCollection(payload: unknown): DiagnosticsCollection {
  const violation = collectionViolation(payload)
  if (violation !== null) {
    throw new HelmError('invalid_diagnostics_collection', `diagnostics.collect 载荷校验失败：${violation}`, 400, {
      violation,
    })
  }
  return payload as DiagnosticsCollection
}

/**
 * 追加探针入口：采集监听方向 collection 注入事实。同时复验 collection 自身
 * 形状与每个追加探针，非法立即显式抛错。
 */
export function appendProbes(collection: DiagnosticsCollection, probes: unknown[]): void {
  const violation = collectionViolation(collection)
  if (violation !== null) {
    throw new HelmError('invalid_diagnostics_collection', `diagnostics.collect 追加前校验失败：${violation}`, 400, {
      violation,
    })
  }
  for (const probe of probes) {
    const probeIssue = probeViolation(probe)
    if (probeIssue !== null) {
      throw new HelmError('invalid_diagnostics_probe', `diagnostics.collect 探针校验失败：${probeIssue}`, 400, {
        violation: probeIssue,
        probe,
      })
    }
    collection.probes.push(probe as WatchdogProbe)
  }
}

/** 终态断言（采集发起方在事件返回后复验；监听方绕过 appendProbes 直接改写时兜底拦截）。 */
export function assertValidCollection(collection: DiagnosticsCollection): void {
  const violation = collectionViolation(collection)
  if (violation !== null) {
    throw new HelmError('invalid_diagnostics_collection', `diagnostics.collect 终态校验失败：${violation}`, 500, {
      violation,
    })
  }
}
