/**
 * spawn 执行元数据（AgentExecutionInfo / AgentGateResult）边界校验（protocol
 * 公共契约）：onResolved / onGateResult 是插件（外部产物）回调，任何消费方
 * （内核 runtime / builtin 插件 / 外部插件）都必须在边界逐字段校验形状——
 * conversationId 正整数、executionId 非空字符串、effectiveCwd 绝对路径、
 * meta 为 JSON-safe 命名空间对象 —— 非法显式失败，绝不依赖 TS。
 *
 * 内核 envelope 不解释 meta 命名空间内部结构（worktree / 控制引用等业务
 * 形状由所有方插件在自身边界用其 schema 校验，见内核插件侧共享契约模块）。
 *
 * 本文件零运行时依赖（仅 HelmError）；内外插件平权使用。
 */
import { HelmError } from './error.js'
import { sanitizeAgentNamespacedMeta } from './meta.js'
import type { AgentExecutionInfo, AgentGateResult } from './plugin.js'

/** 目标路径是否绝对（POSIX / 开头、Windows 盘符绝对或 UNC / 根反斜杠）。 */
export function isAbsoluteAgentPath(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(p)
  )
}

function executionInfoError(agentId: string, reason: string): HelmError {
  return new HelmError(
    'execution_info_invalid',
    `agent '${agentId}' 的 onResolved 回传非法：${reason}`,
    502,
    { agentId, reason },
  )
}

/** 校验并克隆插件回传的 AgentExecutionInfo（拒绝多余/畸形字段，防注入）。 */
export function sanitizeAgentExecutionInfo(
  value: unknown,
  context: { agentId: string },
): AgentExecutionInfo {
  const source = value as Partial<AgentExecutionInfo> | null
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw executionInfoError(context.agentId, '回调载荷必须是对象')
  }
  const known = ['nodeId', 'conversationId', 'executionId', 'effectiveCwd', 'meta'] as const
  for (const key of Object.keys(source)) {
    if (!(known as readonly string[]).includes(key)) {
      throw executionInfoError(context.agentId, `未知字段 "${key}"`)
    }
  }
  const out: AgentExecutionInfo = {}
  if (source.nodeId !== undefined) {
    if (typeof source.nodeId !== 'string' || source.nodeId.trim() === '') {
      throw executionInfoError(context.agentId, 'nodeId 必须是非空字符串')
    }
    out.nodeId = source.nodeId
  }
  if (source.conversationId !== undefined) {
    const id = source.conversationId
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      throw executionInfoError(context.agentId, 'conversationId 必须是正整数')
    }
    out.conversationId = id
  }
  if (source.executionId !== undefined) {
    if (typeof source.executionId !== 'string' || source.executionId.length === 0) {
      throw executionInfoError(context.agentId, 'executionId 必须是非空字符串')
    }
    out.executionId = source.executionId
  }
  if (source.effectiveCwd !== undefined) {
    if (typeof source.effectiveCwd !== 'string' || !isAbsoluteAgentPath(source.effectiveCwd)) {
      throw executionInfoError(context.agentId, 'effectiveCwd 必须是绝对路径')
    }
    out.effectiveCwd = source.effectiveCwd
  }
  if (source.meta !== undefined) {
    out.meta = sanitizeAgentNamespacedMeta(source.meta, {
      agentId: context.agentId,
      field: 'onResolved meta',
    })
  }
  if (out.conversationId === undefined && out.executionId === undefined) {
    throw executionInfoError(context.agentId, '至少回传 conversationId 或 executionId 之一')
  }
  return out
}

/**
 * 校验并克隆插件回传的 AgentGateResult（拒绝多余/畸形字段，防注入）。
 * exitCode 可选（整数或 null：超时/被杀无退出码可考）；timedOut 可选布尔。
 */
export function sanitizeAgentGateResult(
  value: unknown,
  context: { agentId: string },
): AgentGateResult {
  const source = value as Partial<AgentGateResult> | null
  const allowed = ['ok', 'output', 'exitCode', 'timedOut'] as const
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.ok !== 'boolean' ||
    typeof source.output !== 'string' ||
    Object.keys(source).some((key) => !(allowed as readonly string[]).includes(key))
  ) {
    throw new HelmError(
      'gate_result_invalid',
      `agent '${context.agentId}' 的 onGateResult 回传必须是 ` +
        `{ ok: boolean, output: string, exitCode?: number | null, timedOut?: boolean }，` +
        `且不得携带未知字段`,
      502,
      { agentId: context.agentId },
    )
  }
  if (
    source.exitCode !== undefined &&
    source.exitCode !== null &&
    (typeof source.exitCode !== 'number' || !Number.isInteger(source.exitCode))
  ) {
    throw new HelmError(
      'gate_result_invalid',
      `agent '${context.agentId}' 的 onGateResult 回传 exitCode 必须是整数或 null，` +
        `收到 ${String(source.exitCode)}`,
      502,
      { agentId: context.agentId, field: 'exitCode' },
    )
  }
  if (source.timedOut !== undefined && typeof source.timedOut !== 'boolean') {
    throw new HelmError(
      'gate_result_invalid',
      `agent '${context.agentId}' 的 onGateResult 回传 timedOut 必须是布尔值`,
      502,
      { agentId: context.agentId, field: 'timedOut' },
    )
  }
  const out: AgentGateResult = { ok: source.ok, output: source.output }
  if (source.exitCode !== undefined) out.exitCode = source.exitCode === null ? null : source.exitCode
  if (source.timedOut !== undefined) out.timedOut = source.timedOut
  return out
}

/** gate 回传缺失的显式错误（外部执行环境已执行但未回报；不本机猜 cwd 补跑）。 */
export function agentGateResultMissingError(context: {
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
