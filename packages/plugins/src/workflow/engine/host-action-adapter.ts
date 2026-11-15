/**
 * host-action-adapter.ts — 引擎动作调用适配（自 host-adapter 拆出的内部
 * 模块）。
 *
 * 职责：
 * - resolveActionId：全限定 actionId 解析（manifest 精确匹配 + 内建
 *   env.exec 白名单；短 id 唯一允许、歧义拒绝）；
 * - validateEnvExecInput：内建 env.exec 入参边界校验（command/nodeId/cwd/
 *   env/timeoutMs/allowFailure，未知选项显式拒绝）；
 * - enginePrepareAction / engineInvokeAction：runtime WorkflowHost 的
 *   prepareAction / invokeAction 适配——env.exec 经宿主 execEnv 端口执行
 *   （计入 pendingExecs、输出脱敏、失败显式 env_exec_failed），其余动作走
 *   PluginHost 动作总线。
 *
 * 宿主能力与生命周期事实（EngineHostDeps / WorkflowServiceHost）定义在
 * host-adapter.ts，本模块只做动作面的解析、校验与调用。
 */

import { HelmError, isAbsoluteTargetPath, type EnvExecResponse } from '@helm/protocol'
import type { ActiveRun } from './active-run.js'
import type { EngineHostDeps, WorkflowServiceHost } from './host-adapter.js'

export const BUILTIN_ENV_EXEC_PLUGIN = 'env'
export const BUILTIN_ENV_EXEC_ACTION = 'exec'
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface ValidatedEnvExecInput {
  command: string | string[]
  nodeId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  allowFailure?: boolean
}

/**
 * 全限定 actionId 解析：以 listActions() 的 manifest 精确匹配，支持内建 env.exec。
 * pluginId 含 ':'（builtin:profile），actionId 理论上可含 '.'，简单 split
 * 会在坏点号上错位——只信 manifest 与内建白名单。
 */
export function resolveActionId(
  host: WorkflowServiceHost,
  qualified: string,
): { pluginId: string; actionId: string; builtin?: 'env.exec' } {
  if (qualified === `${BUILTIN_ENV_EXEC_PLUGIN}.${BUILTIN_ENV_EXEC_ACTION}`) {
    return {
      pluginId: BUILTIN_ENV_EXEC_PLUGIN,
      actionId: BUILTIN_ENV_EXEC_ACTION,
      builtin: 'env.exec',
    }
  }

  const manifests = host.listActions()
  if (qualified === BUILTIN_ENV_EXEC_ACTION) {
    const sameShort = manifests.filter((m) => m.id === BUILTIN_ENV_EXEC_ACTION)
    if (sameShort.length === 0) {
      return {
        pluginId: BUILTIN_ENV_EXEC_PLUGIN,
        actionId: BUILTIN_ENV_EXEC_ACTION,
        builtin: 'env.exec',
      }
    }
    throw new HelmError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个动作（含内建 env.exec），请用全限定 id：env.exec, ${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }

  // 1) 全限定精确匹配。
  for (const manifest of manifests) {
    if (`${manifest.pluginId}.${manifest.id}` === qualified) {
      return { pluginId: manifest.pluginId, actionId: manifest.id }
    }
  }
  // 2) 裸短 id：唯一时允许，歧义拒绝。
  const sameShort = manifests.filter((m) => m.id === qualified)
  if (sameShort.length === 1) {
    return { pluginId: sameShort[0]!.pluginId, actionId: sameShort[0]!.id }
  }
  if (sameShort.length > 1) {
    throw new HelmError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个插件，请用全限定 id：${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  throw new HelmError('unknown_action', `未注册的动作：${qualified}`, 404, { qualified })
}

export function validateEnvExecInput(host: WorkflowServiceHost, input: unknown): ValidatedEnvExecInput {
  if (host.execEnv === undefined) {
    throw new HelmError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HelmError('validation_error', 'env.exec 入参必须是 JSON 对象', 400)
  }
  const raw = input as Record<string, unknown>
  const allowedKeys = new Set(['command', 'nodeId', 'cwd', 'env', 'timeoutMs', 'allowFailure'])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new HelmError('validation_error', `env.exec 发现未知选项 "${key}"`, 400)
    }
  }

  const rawCommand = raw.command
  let command: string | string[]
  if (typeof rawCommand === 'string') {
    if (rawCommand.trim().length === 0) {
      throw new HelmError('validation_error', 'env.exec command 不能为空字符串', 400)
    }
    command = rawCommand
  } else if (Array.isArray(rawCommand)) {
    if (
      rawCommand.length === 0 ||
      !rawCommand.every((item) => typeof item === 'string') ||
      rawCommand[0]!.trim().length === 0
    ) {
      throw new HelmError('validation_error', 'env.exec command 数组必须非空且首项为非空字符串', 400)
    }
    command = rawCommand as string[]
  } else {
    throw new HelmError('validation_error', 'env.exec command 必须是非空字符串或非空字符串数组', 400)
  }

  let nodeId: string | undefined
  if (raw.nodeId !== undefined) {
    if (typeof raw.nodeId !== 'string' || !NODE_ID_RE.test(raw.nodeId)) {
      throw new HelmError(
        'validation_error',
        'env.exec nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（字母数字开头，可含 . _ -）',
        400,
      )
    }
    nodeId = raw.nodeId
  }

  let cwd: string | undefined
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.trim().length === 0 || !isAbsoluteTargetPath(raw.cwd)) {
      throw new HelmError(
        'validation_error',
        'env.exec cwd 必须为跨平台绝对路径（POSIX/Windows/UNC）',
        400,
      )
    }
    cwd = raw.cwd
  }

  let env: Record<string, string> | undefined
  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      throw new HelmError('validation_error', 'env.exec env 必须是键值对象', 400)
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') {
        throw new HelmError('validation_error', `env.exec env.${k} 必须为字符串`, 400)
      }
    }
    env = raw.env as Record<string, string>
  }

  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 600_000) {
      throw new HelmError('validation_error', 'env.exec timeoutMs 必须是 1 到 600000 之间的整数', 400)
    }
    timeoutMs = raw.timeoutMs
  }

  let allowFailure: boolean | undefined
  if (raw.allowFailure !== undefined) {
    if (typeof raw.allowFailure !== 'boolean') {
      throw new HelmError('validation_error', 'env.exec allowFailure 必须为 boolean', 400)
    }
    allowFailure = raw.allowFailure
  }

  return { command, nodeId, cwd, env, timeoutMs, allowFailure }
}

/** WorkflowHost.prepareAction 适配：动作前置预检（零副作用，env.exec 同步校验）。 */
export async function enginePrepareAction(
  deps: EngineHostDeps,
  run: ActiveRun,
  actionId: string,
  input: unknown,
): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }> {
  const resolved = resolveActionId(deps.host, actionId)
  if (resolved.builtin === 'env.exec') {
    validateEnvExecInput(deps.host, input)
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: false }
  }
  if (deps.host.prepareAction !== undefined) {
    const prep = deps.host.prepareAction(resolved.pluginId, resolved.actionId, input, {
      conversationId: run.conversationId,
    })
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: prep?.idempotent }
  }
  const manifests = deps.host.listActions()
  const manifest = manifests.find((m) => m.pluginId === resolved.pluginId && m.id === resolved.actionId)
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: manifest?.idempotent }
}

/** WorkflowHost.invokeAction 适配：内建 env.exec 走 execEnv 端口，其余走动作总线。 */
export async function engineInvokeAction(
  deps: EngineHostDeps,
  run: ActiveRun,
  actionId: string,
  input: unknown,
  context: { index: number; signal?: AbortSignal },
): Promise<{ pluginId: string; actionId: string; result: unknown }> {
  const resolved = resolveActionId(deps.host, actionId)
  if (resolved.builtin === 'env.exec') {
    const parsed = validateEnvExecInput(deps.host, input)
    const execPromise = deps.host.execEnv?.(
      {
        command: parsed.command,
        ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
        ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
        ...(parsed.env !== undefined ? { env: parsed.env } : {}),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        conversationId: run.conversationId,
      },
      context.signal,
    )
    if (execPromise === undefined) {
      throw new HelmError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
    }
    run.pendingExecs.add(execPromise)
    let res: EnvExecResponse
    try {
      res = await execPromise
    } finally {
      run.pendingExecs.delete(execPromise)
    }
    const redactedOutput = deps.redact(res.output)
    const succeeded = res.ok && res.exitCode === 0 && !res.timedOut
    if (!succeeded && parsed.allowFailure !== true) {
      const tail = redactedOutput.length > 2000 ? redactedOutput.slice(-2000) : redactedOutput
      throw new HelmError(
        'env_exec_failed',
        `命令执行失败${res.timedOut ? '（超时）' : ''}（exitCode=${String(res.exitCode)}）${tail ? ': ' + tail : ''}`,
        502,
        { exitCode: res.exitCode, timedOut: res.timedOut },
      )
    }
    return {
      pluginId: 'env',
      actionId: 'exec',
      result: {
        ok: succeeded,
        exitCode: res.exitCode,
        output: redactedOutput,
        timedOut: res.timedOut,
      },
    }
  }
  const result = await deps.host.invokeAction(resolved.pluginId, resolved.actionId, input, {
    conversationId: run.conversationId,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  })
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, result }
}
