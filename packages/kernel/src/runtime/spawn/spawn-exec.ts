/**
 * spawn-exec.ts — spawn 执行元数据边界校验/脱敏的内核侧薄层。
 *
 * 形状校验（sanitizeExecutionInfo / sanitizeGateResult / gateResultMissingError）
 * 已上提 protocol（agent-exec.ts，内外插件平权消费）；本文件保留内核内部
 * 既有导入路径的再导出，并承载需要内核脱敏设施的持久面脱敏 helper。
 */

import type { AgentExecutionInfo, AgentGateResult } from '@helm/protocol'
import {
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
} from '@helm/protocol'
import { redactJsonValue } from '../../redact.js'

export const sanitizeExecutionInfo = sanitizeAgentExecutionInfo
export const sanitizeGateResult = sanitizeAgentGateResult
export const gateResultMissingError = agentGateResultMissingError

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
