/**
 * spawn 执行元数据（AgentExecutionInfo / AgentGateResult）边界校验（protocol
 * 公共契约）：onResolved / onGateResult 是插件（外部产物）回调，任何消费方
 * （内核 runtime / builtin 插件 / 外部插件）都必须在边界逐字段校验形状——
 * conversationId 正整数、executionId 非空字符串、effectiveCwd 绝对路径、
 * worktree {path,branch} 形状、gate {ok,output} —— 非法显式失败，绝不依赖 TS。
 *
 * 本文件零运行时依赖（仅 HelmError）；内外插件平权使用。
 */
import { HelmError } from './error.js'
import type {
  AgentExecutionControls,
  AgentExecutionInfo,
  AgentGateResult,
} from './plugin.js'

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

/** 非空 trim 后仍非空的字符串字段校验（controls 坐标用）。 */
function requireTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 校验并克隆 controls（严格形状：拒绝未知键与非空 trim 字符串之外的任何值）。 */
function sanitizeControls(
  value: unknown,
  context: { agentId: string },
): AgentExecutionControls {
  const source = value as Partial<AgentExecutionControls> | null
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw executionInfoError(context.agentId, 'controls 必须是对象')
  }
  for (const key of Object.keys(source)) {
    if (key !== 'steer') {
      throw executionInfoError(context.agentId, `controls 未知字段 "${key}"`)
    }
  }
  const out: AgentExecutionControls = {}
  const steer = source.steer as Partial<NonNullable<AgentExecutionControls['steer']>> | undefined
  if (steer !== undefined) {
    if (steer === null || typeof steer !== 'object' || Array.isArray(steer)) {
      throw executionInfoError(context.agentId, 'controls.steer 必须是对象')
    }
    for (const key of Object.keys(steer)) {
      if (key !== 'pluginId' && key !== 'actionId') {
        throw executionInfoError(context.agentId, `controls.steer 未知字段 "${key}"`)
      }
    }
    const pluginId = requireTrimmedString(steer.pluginId)
    const actionId = requireTrimmedString(steer.actionId)
    if (pluginId === undefined || actionId === undefined) {
      throw executionInfoError(context.agentId, 'controls.steer.pluginId/actionId 必须是非空 trim 字符串')
    }
    out.steer = { pluginId, actionId }
  }
  if (out.steer === undefined) {
    throw executionInfoError(context.agentId, 'controls 至少包含 steer')
  }
  return out
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
  const known = ['nodeId', 'conversationId', 'executionId', 'effectiveCwd', 'worktree', 'controls'] as const
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
  if (source.worktree !== undefined) {
    const worktree = source.worktree as Partial<NonNullable<AgentExecutionInfo['worktree']>> | null
    if (
      worktree === null ||
      typeof worktree !== 'object' ||
      Array.isArray(worktree) ||
      typeof worktree.path !== 'string' ||
      worktree.path.length === 0 ||
      !isAbsoluteAgentPath(worktree.path) ||
      typeof worktree.branch !== 'string' ||
      worktree.branch.length === 0
    ) {
      throw executionInfoError(context.agentId, 'worktree 必须是 { path: 绝对路径, branch: 非空 }')
    }
    out.worktree = { path: worktree.path, branch: worktree.branch }
    for (const key of ['id', 'repoRoot', 'baseCommit'] as const) {
      const field = worktree[key]
      if (field !== undefined) {
        if (typeof field !== 'string' || field === '' || (key === 'repoRoot' && !isAbsoluteAgentPath(field))) {
          throw executionInfoError(context.agentId, `worktree.${key} 非法`)
        }
        out.worktree[key] = field
      }
    }
    if (worktree.dirtySource !== undefined) {
      if (typeof worktree.dirtySource !== 'boolean') throw executionInfoError(context.agentId, 'worktree.dirtySource 必须是布尔值')
      out.worktree.dirtySource = worktree.dirtySource
    }
  }
  if (source.controls !== undefined) {
    out.controls = sanitizeControls(source.controls, context)
    // 孤立 controls 拒绝：控制引用只对外部执行有意义，必须同时携带
    // executionId + nodeId（原生执行的控制走内核 guarded 端口，不经 controls）。
    if (out.executionId === undefined || out.nodeId === undefined) {
      throw executionInfoError(
        context.agentId,
        'controls 必须与 executionId + nodeId 同时回传（孤立控制引用拒绝；原生执行不需要 controls）',
      )
    }
  }
  if (out.conversationId === undefined && out.executionId === undefined) {
    throw executionInfoError(context.agentId, '至少回传 conversationId 或 executionId 之一')
  }
  return out
}

/** 校验并克隆插件回传的 AgentGateResult。 */
export function sanitizeAgentGateResult(
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
