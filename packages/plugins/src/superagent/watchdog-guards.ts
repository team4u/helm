/**
 * builtin:superagent Watchdog 目标守卫与会话执行层强守卫。
 *
 * - 归属与目标守卫（isWatchdogSession / isProtectedTarget / assertOwnedTarget）：
 *   供 ops 与 tools 复用的纯判定 + mutation 前即时归属核对（ownedBy 一律以
 *   ctx.host.getConversationOwnership 现读为准，未标记一律 human）；
 * - turn_settled 自监控：Watchdog 自身 failed/aborted 仅通知（不进自身探针，
 *   靠分类排除 + 此处兜底），防自巡检死循环；统计段先行（全部会话）；
 * - before_turn 工具白名单 + tool_call 阻断：执行层强约束，不依赖 SYSTEM.md。
 */

import type {
  BeforeTurnHookPayload,
  HelmPluginContext,
  ToolCallHookPayload,
  TurnSettledPayload,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { SuperAgentWatchdogRuntime } from './contracts.js'
import type { ConversationActivityTracker } from './watchdog-activity.js'
import {
  WATCHDOG_ALLOWED_TOOLS,
  WATCHDOG_EXCLUSIVE_TOOLS,
  WATCHDOG_PROFILE_ID,
  type WatchdogNotify,
} from './watchdog-core.js'

/** 会话是否属于 watchdog（含同 profile 直聊）。 */
export function isWatchdogSession(
  runtime: SuperAgentWatchdogRuntime,
  id: number,
  profileId: string | undefined,
): boolean {
  if (runtime.getWatchdogConversationId() === id) return true
  return profileId === WATCHDOG_PROFILE_ID
}

/** 受保护目标：中枢 / watchdog 自身（防自激与误伤常驻入口）。 */
export function isProtectedTarget(runtime: SuperAgentWatchdogRuntime, conversationId: number): boolean {
  return (
    conversationId === runtime.getRouterConversationId() ||
    conversationId === runtime.getWatchdogConversationId()
  )
}

/**
 * mutation 前的即时归属核对：probe 携带的 ownedBy 可能已过期，
 * 一律以 ctx.host.getConversationOwnership 现读为准（未标记一律 human）。
 */
export function assertOwnedTarget(
  ctx: HelmPluginContext,
  runtime: SuperAgentWatchdogRuntime,
  conversationId: number,
): void {
  if (isProtectedTarget(runtime, conversationId)) {
    throw new HelmError(
      'watchdog_target_protected',
      `会话 ${conversationId} 受保护（中枢/巡检自身），拒绝 Watchdog 自动处置`,
      403,
      { conversationId },
    )
  }
  const ownedBy = ctx.host.getConversationOwnership(conversationId)
  if (ownedBy === 'human') {
    throw new HelmError(
      'watchdog_target_human',
      `会话 ${conversationId} 归属人类（ownedBy=human），仅允许只读诊断与通知`,
      403,
      { conversationId },
    )
  }
}

export interface WatchdogGuardDeps {
  activity: ConversationActivityTracker
  notify: WatchdogNotify
}

/**
 * 注册会话级 Hook：turn_settled（活动统计 + 自监控通知）、before_turn（工具
 * 白名单）、tool_call（未知/越权工具阻断）。#1 与普通 Bot 不受影响。
 */
export function registerWatchdogSessionGuards(
  ctx: HelmPluginContext,
  runtime: SuperAgentWatchdogRuntime,
  deps: WatchdogGuardDeps,
): void {
  ctx.hook.onTurnSettled(async (payload: TurnSettledPayload) => {
    // 活动统计先行（全部会话）：回合终态即活动时钟终点；failed 递增、
    // completed 归零、aborted 保持（非模型失败）。插件停用后订阅随钩子注册
    // 一并解除，无残留 observer。
    deps.activity.onTurnSettled(payload.conversation.id, payload.outcome)
    if (payload.outcome !== 'failed' && payload.outcome !== 'aborted') return
    const conversation = payload.conversation
    if (!isWatchdogSession(runtime, conversation.id, conversation.profileId)) return
    if (ctx.host.isClosing) return // 关闭中大量 abort 结算是预期行为，不告警不自激
    deps.notify(
      payload.outcome === 'failed' ? 'error' : 'warning',
      '巡检看门狗回合异常',
      `Watchdog 会话 #${conversation.id} 回合 ${payload.outcome}${
        payload.error ? `：${payload.error}` : ''
      }；按防自激策略仅通知，不触发自动巡检动作`,
      conversation.id,
    )
  })

  ctx.hook.onBeforeTurn(async (turn: BeforeTurnHookPayload) => {
    const conversation = turn.conversation
    if (!isWatchdogSession(runtime, conversation.id, conversation.profileId)) return // #1 与普通 Bot 不受影响
    const isActualWatchdog = conversation.id === runtime.getWatchdogConversationId()
    const tools = turn.tools.filter((tool) => {
      if (!WATCHDOG_ALLOWED_TOOLS.has(tool.name)) return false
      // 专属工具仅实际 watchdog 会话可得；同 profile 直聊在可见层即被剥离。
      if (WATCHDOG_EXCLUSIVE_TOOLS.has(tool.name) && !isActualWatchdog) return false
      return true
    })
    if (tools.length === turn.tools.length) return
    return { action: 'transform', value: { ...turn, tools } }
  })

  ctx.hook.onToolCall(async (payload: ToolCallHookPayload) => {
    const conversationId = payload.conversationId
    let profileId: string | undefined
    try {
      profileId = ctx.host.getConversation(conversationId).profileId
    } catch {
      profileId = undefined // 会话已消失：后续执行层自会显式报错，这里不伪造判断
    }
    if (!isWatchdogSession(runtime, conversationId, profileId)) return
    if (!WATCHDOG_ALLOWED_TOOLS.has(payload.toolName)) {
      return {
        action: 'block',
        reason: `巡检会话仅允许只读与记忆工具（${[...WATCHDOG_ALLOWED_TOOLS].join(', ')}），已阻断 ${payload.toolName}`,
      }
    }
    if (WATCHDOG_EXCLUSIVE_TOOLS.has(payload.toolName) && conversationId !== runtime.getWatchdogConversationId()) {
      return {
        action: 'block',
        reason: `watchdog 专属工具 ${payload.toolName} 仅限实际巡检会话使用（同 profile 直聊不可用）`,
      }
    }
    return undefined
  })
}
