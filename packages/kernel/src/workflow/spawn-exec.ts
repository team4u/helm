/**
 * spawn-exec.ts — spawn 执行元数据（AgentExecutionInfo / AgentGateResult）的
 * 边界校验、脱敏与进度折叠辅助。
 *
 * 边界纪律：onResolved / onGateResult 是插件（外部产物）回调，运行时必须
 * 逐字段校验形状——conversationId 正整数、executionId 非空字符串、
 * effectiveCwd 绝对路径、worktree {path,branch} 形状、gate {ok,output} ——
 * 非法显式失败（gate_result_missing / execution_info_invalid），绝不依赖 TS。
 */

import { isAbsolute } from 'node:path'
import type { AgentExecutionInfo, AgentGateResult } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'

/** 校验并克隆插件回传的 AgentExecutionInfo（拒绝多余/畸形字段，防注入）。 */
export function sanitizeExecutionInfo(
  value: unknown,
  context: { agentId: string },
): AgentExecutionInfo {
  const source = value as Partial<AgentExecutionInfo> | null
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw executionInfoError(context.agentId, '回调载荷必须是对象')
  }
  const known = ['conversationId', 'executionId', 'effectiveCwd', 'worktree'] as const
  for (const key of Object.keys(source)) {
    if (!(known as readonly string[]).includes(key)) {
      throw executionInfoError(context.agentId, `未知字段 "${key}"`)
    }
  }
  const out: AgentExecutionInfo = {}
  let present = 0
  if (source.conversationId !== undefined) {
    const id = source.conversationId
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw executionInfoError(context.agentId, 'conversationId 必须是正整数')
    }
    out.conversationId = id
    present++
  }
  if (source.executionId !== undefined) {
    if (typeof source.executionId !== 'string' || source.executionId.length === 0) {
      throw executionInfoError(context.agentId, 'executionId 必须是非空字符串')
    }
    out.executionId = source.executionId
    present++
  }
  if (source.effectiveCwd !== undefined) {
    if (typeof source.effectiveCwd !== 'string' || !isAbsolute(source.effectiveCwd)) {
      throw executionInfoError(context.agentId, 'effectiveCwd 必须是绝对路径')
    }
    out.effectiveCwd = source.effectiveCwd
    present++
  }
  if (source.worktree !== undefined) {
    const worktree = source.worktree as { path?: unknown; branch?: unknown } | null
    if (
      worktree === null ||
      typeof worktree !== 'object' ||
      Array.isArray(worktree) ||
      typeof worktree.path !== 'string' ||
      worktree.path.length === 0 ||
      !isAbsolute(worktree.path) ||
      typeof worktree.branch !== 'string' ||
      worktree.branch.length === 0
    ) {
      throw executionInfoError(context.agentId, 'worktree 必须是 { path: 绝对路径, branch: 非空 }')
    }
    out.worktree = { path: worktree.path, branch: worktree.branch }
    present++
  }
  if (present === 0) {
    throw executionInfoError(context.agentId, '至少回传 conversationId 或 executionId 之一')
  }
  return out
}

function executionInfoError(agentId: string, reason: string): HelmError {
  return new HelmError(
    'execution_info_invalid',
    `agent '${agentId}' 的 onResolved 回传非法：${reason}`,
    502,
    { agentId, reason },
  )
}

/** 校验并克隆插件回传的 AgentGateResult。 */
export function sanitizeGateResult(
  value: unknown,
  context: { agentId: string },
): AgentGateResult {
  const source = value as Partial<AgentGateResult> | null
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.ok !== 'boolean' ||
    typeof source.output !== 'string' ||
    Object.keys(source).some((key) => key !== 'ok' && key !== 'output')
  ) {
    throw new HelmError(
      'gate_result_invalid',
      `agent '${context.agentId}' 的 onGateResult 回传必须是 { ok: boolean, output: string }`,
      502,
      { agentId: context.agentId },
    )
  }
  return { ok: source.ok, output: source.output }
}

/**
 * 持久面脱敏：executionInfo / gateResult 经逐值 redact 后再入
 * record/summary/事件（秘密绝不经 progress 新字段泄漏）。
 */
export function redactExecutionMetadata(
  info: AgentExecutionInfo,
  redactText: (text: string) => string,
): AgentExecutionInfo {
  return redactJsonValue(info, redactText) as AgentExecutionInfo
}

export function redactGateResult(
  gate: AgentGateResult,
  redactText: (text: string) => string,
): AgentGateResult {
  return redactJsonValue(gate, redactText) as AgentGateResult
}

/** gate 回传缺失的显式错误（外部执行环境已执行但未回报；不本机猜 cwd 补跑）。 */
export function gateResultMissingError(context: {
  agentId: string
  executionId?: string
  command: string
}): HelmError {
  return new HelmError(
    'gate_result_missing',
    `外部执行环境（executionId='${context.executionId ?? 'unknown'}'）未回报 gate 结果` +
      `（agent '${context.agentId}'，gate 命令：${context.command.slice(0, 200)}）；` +
      '拒绝在本机猜测远端工作目录补跑 gate——请修复外部运行时的 onGateResult 回报',
    502,
    { agentId: context.agentId, ...(context.executionId !== undefined ? { executionId: context.executionId } : {}), command: context.command },
  )
}
