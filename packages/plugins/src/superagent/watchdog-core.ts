/**
 * builtin:superagent Watchdog 公共基座：常量、私有类型与纯辅助函数。
 *
 * 各 watchdog-* 子模块（activity / dedup / classify / ops / tick / guards /
 * tools）共用的零内部依赖基石；策略语义与安全红线注释见 watchdog.ts
 * （组合根）与各子模块头注释。
 */

import {
  HelmError,
  escapeXml,
  isJsonObject,
  type GuardedMutationExpectation,
  type HelmHostApi,
} from '@helm/protocol'
import type { WatchdogOwnership } from '../diagnostics.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export { WATCHDOG_PROFILE_ID } from './contracts.js'

export const WATCHDOG_TOOL_INSPECT = 'watchdog_inspect'
export const WATCHDOG_TOOL_RECOVER = 'watchdog_recover'
export const WATCHDOG_TOOL_ABORT = 'watchdog_abort'

/**
 * watchdog 会话（含同 profile 直聊）的 before_turn 工具白名单：
 * 只读 / 记忆 / 专属巡检工具；其余（含 bash/edit/write/subagent/
 * SubagentWorkflow/run_action 与未知第三方工具）一律剥离，#1 与普通 Bot 不受影响。
 */
export const WATCHDOG_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_artifact',
  'load_skill',
  'update_memory',
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  WATCHDOG_TOOL_ABORT,
])

/** 仅实际 watchdog 会话可用的专属工具（同 profile 直聊不可得）。 */
export const WATCHDOG_EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set([
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  WATCHDOG_TOOL_ABORT,
])

/** 外部目标（无权威 seq，以哨兵水位去重）的同类动作再触发间隔。 */
export const EXTERNAL_REFRACTORY_MS = 60 * 60 * 1000

/**
 * workflow_run 失败自动续跑冷却退避表（按 autoResumeCount 索引：
 * 第 0 次失败后等 2 分钟、第 1 次后 5 分钟、第 2 次后 15 分钟）。
 * 网关则恢复时避免立刻重放大工作流把接口再次打挂。
 */
export const WORKFLOW_RESUME_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000]

/** 自动续跑次数上限：autoResumeCount 达 3 后不再自动续跑，交人类处置。 */
export const WORKFLOW_RESUME_MAX_COUNT = 3

/** 续跑调用失败后的内存重试推迟（跨重启重置；防止每 tick 重试刷屏）。 */
export const WORKFLOW_RESUME_RETRY_DEFER_MS = 10 * 60_000

/** 定时巡检间隔（毫秒；与原内核 watchdog 定时器口径一致）。 */
export const TICK_INTERVAL_MS = 15_000

/** stop 等待在途 tick 的有界上限（跨插件采集不可取消，防与慢监听方互挂死）。 */
export const STOP_TICK_WAIT_MS = 30_000

/**
 * 运行期单轮采集的有界上限（与 stop 口径一致）：跨插件 diagnostics.collect
 * 监听器不可取消且可能永不 settle；不设上限会令 singleflight 永久占用，
 * 后续巡检（定时与手动）全部静默复用挂死轮。超时按本轮采集失败处理，
 * 放行下一轮。
 */
export const TICK_COLLECT_TIMEOUT_MS = 30_000

/** seq 缺失（外部/读不到权威水位）时的哨兵；与任何真实 seq（>=0）必然不等。 */
export const SENTINEL_SEQ = -1

// ---------------------------------------------------------------------------
// 共享类型
// ---------------------------------------------------------------------------

/** 单个异常事实（L2 投递与通知共用的最小形状）。 */
export interface Finding {
  key: string
  targetKind: 'conversation' | 'external'
  nodeId?: string
  targetId: string
  conversationId?: number
  ownedBy: WatchdogOwnership
  status: string
  stateChangeSeq?: number
  stalledMs?: number
  consecutiveErrors?: number
  pendingAskCount?: number
  parentConversationId?: number
  /** 人类可读的证据描述（发出前统一 redact）。 */
  evidence: string
  /** 0-Token 层已定处置，供 L2 知晓上下文。 */
  disposition: string
  /** workflow_run 探针事实（严格校验后的权威续跑参数；仅 resume 链路使用）。 */
  workflowRun?: {
    runId: string
    conversationId: number
    failedAt: number
    autoResumeCount: number
  }
}

export type PlannedOp =
  | { type: 'notify'; finding: Finding; refractoryMs: number }
  | { type: 'wake'; finding: Finding; refractoryMs: number }
  | { type: 'abort'; finding: Finding }
  | { type: 'bridge'; finding: Finding }
  | { type: 'resume'; finding: Finding }

/** 通知函数形状（组合根构造，各子模块共用；生命周期关闭后静默丢弃）。 */
export type WatchdogNotify = (
  level: 'info' | 'warning' | 'error',
  title: string,
  body: string,
  conversationId?: number,
) => void

// ---------------------------------------------------------------------------
// 纯辅助：探针字段归一 / 键编码 / 文本转义 / 错误描述
// ---------------------------------------------------------------------------

export function asNonNegativeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}

export function asNonNegativeFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** 去重键：JSON 数组三元组，杜绝冒号拼接碰撞（如 targetId 含 ':'）。 */
export function targetKey(kind: string, nodeId: string | undefined, targetId: string): string {
  return JSON.stringify([kind, nodeId ?? 'local', targetId])
}

/** 去重键（JSON 数组三元组）还原为 {kind, nodeId, targetId}；非目标形状返回 undefined。 */
export function parseTargetKey(key: string): { kind: string; nodeId?: string; targetId: string } | undefined {
  try {
    const parsed = JSON.parse(key) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [kind, nodeId, targetId] = parsed as [string, string, string]
    if (typeof kind !== 'string' || typeof targetId !== 'string') return undefined
    return { kind, ...(nodeId !== 'local' ? { nodeId } : {}), targetId }
  } catch {
    return undefined
  }
}

/** HelmError 附带稳定错误码（内核守卫拒绝的通知可被程序化判别）。 */
export function describeError(err: unknown): string {
  return err instanceof HelmError ? `[${err.code}] ${err.message}` : err instanceof Error ? err.message : String(err)
}

/** 内核守卫拒绝（目标已变）与真实失败区分：冲突/缺失是确定性放弃，可重试。 */
export function isGuardConflict(err: unknown): boolean {
  return (
    err instanceof HelmError &&
    (err.code === 'ownership_conflict' || err.code === 'state_seq_conflict' || err.code === 'not_found')
  )
}

/** 探针事实 → 内核 guarded 变更期望（ownedBy 仅取自动化域；human 走不到这里）。 */
export function guardOf(
  finding: Finding,
  extra: { withSeq?: boolean } = {},
): GuardedMutationExpectation {
  return {
    ...(finding.ownedBy === 'bot' || finding.ownedBy === 'helm' ? { expectedOwnership: finding.ownedBy } : {}),
    ...(extra.withSeq === true && finding.stateChangeSeq !== undefined
      ? { expectedStateSeq: finding.stateChangeSeq }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 通知构造（生命周期关闭后不再追加事件写入）
// ---------------------------------------------------------------------------

export function createWatchdogNotifier(
  host: Pick<HelmHostApi, 'emitEvent' | 'redact'>,
  isClosing: () => boolean,
): WatchdogNotify {
  return (level, title, body, conversationId) => {
    if (isClosing()) return // 生命周期后不再追加事件写入
    try {
      host.emitEvent('notification', {
        type: 'notification',
        level,
        title: host.redact(title),
        body: host.redact(body),
        ...(conversationId !== undefined ? { conversationId } : {}),
      })
    } catch (err) {
      console.error(`[superagent-watchdog] ${host.redact(`通知发送失败：${err instanceof Error ? err.message : String(err)}`)}`)
    }
  }
}
