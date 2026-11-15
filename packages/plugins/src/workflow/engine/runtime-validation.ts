/**
 * runtime-validation.ts — runtime 的纯函数层：边界校验 / 参数标准化 /
 * 脚本校验 / 无状态辅助与运行限制常量。
 *
 * 自 runtime.ts 拆出（语义逐行保持，零状态、零 worker 依赖、确定性、
 * 可独立单测）。这些函数同时承担三重角色：
 * - host 侧 JSON 边界（worker 消息面不可信，二次校验在 handler 边界用）；
 * - 调用参数标准化与脚本保存前预检（validateScript / precheckScriptSyntax）；
 * - 持久面前的值级脱敏、预览截断与账本 key / resume 句柄等派生工具。
 */

import { cpus } from 'node:os'
import { Script } from 'node:vm'
import { hasValidScopeIdentity, type JournalAgentExecution } from './journal.js'
import type { CompiledSchema } from './json-schema.js'
import { extractMeta, type WorkflowMeta } from './meta.js'
import type { WorkflowAgentEntry } from './progress.js'
import type { ReplayScope } from './replay.js'
import type { WorkflowGateResult, WorkflowHost, WorkflowSpawnResult } from './runtime-types.js'

/** 脚本长度上限（512KB）。 */
export const MAX_SCRIPT_LENGTH = 524_288

/** 单个 run 允许调度的 agent 总数上限。 */
export const WORKFLOW_AGENT_CAP = 1000

/** 单次 parallel()/pipeline() 的 item 数上限。 */
export const WORKFLOW_ITEM_CAP = 4096

/** 嵌套 workflow() 调用总数上限。 */
export const WORKFLOW_NESTED_CAP = 256

/** 单次 agent() 调用自动重试上限（设计 §2.2：1..10；缺省 1 = 不自动重试）。 */
export const MAX_AGENT_ATTEMPTS = 10

/** UI 保留的 prompt/result 预览长度。 */
const PREVIEW_LENGTH = 200

export class WorkflowRuntimeError extends Error {}

/**
 * 并发 agent 数：给宿主线程留两个核。`Math.max(1,…)` 不是装饰——单双核机器
 * 上裸 `min(16, cpus-2)` 为 0，零许可信号量会让 run 在第一个 agent 之前挂死。
 */
export function workflowConcurrency(cpuCount: number = cpus().length): number {
  return Math.max(1, Math.min(16, cpuCount - 2))
}

/* ------------------------------------------------------------------------- *
 * JSON 边界（宿主侧）
 * ------------------------------------------------------------------------- */

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(`Cannot pass ${what} across the workflow VM boundary (at ${path}).`)
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw boundaryError('a non-finite number', path)
    return
  }
  if (kind === 'undefined') {
    if (path === 'args') return
    throw boundaryError('undefined', path)
  }
  if (kind === 'bigint') throw boundaryError('a BigInt', path)
  if (kind === 'symbol') throw boundaryError('a symbol', path)
  if (kind === 'function') throw boundaryError('a function', path)
  if (kind !== 'object') throw boundaryError(`a ${kind}`, path)

  const object = value as object
  if (seen.has(object)) throw boundaryError('a circular structure', path)
  seen.add(object)

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError('an object with symbol keys', path)
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError('a sparse array', `${path}[${i}]`)
      walk(object[i], `${path}[${i}]`, seen)
    }
    seen.delete(object)
    return
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError('a non-plain object', path)
  }
  for (const [key, entry] of Object.entries(object)) {
    walk(entry, `${path}.${key}`, seen)
  }
  seen.delete(object)
}

/** 拒绝无法在 worker 往返与重放账本中存活 的值。 */
export function assertBoundarySafe(value: unknown, path: string): void {
  walk(value, path, new Set())
}

/**
 * 规范化工作流 args：
 * 模型在调用工具时常将 object/array 参数序列化为 JSON 字符串（如 '{"topics": ["a"]}'）。
 * 若不反序列化，进入 worker 经 JSON.stringify + realmParse 闭环后仍为 string，
 * 导致脚本内 args.items.map 报 TypeError。
 *
 * 此函数安全地将 JSON 对象/数组字符串解包为真实对象/数组；
 * 标量（数字、布尔、普通字符串）及真对象/数组原样保持。
 */
export function normalizeWorkflowArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw
  let current = raw
  // 最多解包 2 层，防御模型端可能产生的双重 JSON 序列化
  for (let i = 0; i < 2 && typeof current === 'string'; i++) {
    const trimmed = current.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        current = JSON.parse(trimmed)
      } catch {
        break
      }
    } else if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        current = JSON.parse(trimmed)
      } catch {
        break
      }
    } else {
      break
    }
  }
  return current
}

/**
 * 持久面值级脱敏（宽松遍历，仅限引擎内部已过边界校验的值）：
 * 递归克隆并把每个字符串值经 redactText 替换（如 stash secret → marker）。
 * 绝不做 stringify 后整体替换——嵌套深处的秘密必须同样被处理。
 * 边界安全值（纯对象/数组/标量）之外的原样返回。
 *
 * 与 @helm/protocol redactJsonValue（严格版，拒绝循环/稀疏/非纯对象并
 * 脱敏键名）语义不同：本函数面向引擎内部已信任的持久面，不脱敏键名、
 * 非纯对象原样返回。命名区分避免误用。
 */
export function redactPlainValue(value: unknown, redactText: (text: string) => string): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactPlainValue(item, redactText))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redactPlainValue(entry, redactText)
    return out
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * 调用载荷派生工具（handler 边界共用）
 * ------------------------------------------------------------------------- */

/** 除 tab/newline/cr 外的全部 0x20 以下字符与 DEL。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** 进度行保留的 prompt/result 预览（超长截断加省略号）。 */
export const preview = (text: string) =>
  text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`

export function readCallScope(payload: ReplayScope): ReplayScope {
  if (!hasValidScopeIdentity(payload)) throw new WorkflowRuntimeError('Workflow call scope identity is invalid.')
  return { scopePath: payload.scopePath, scopeCallIndex: payload.scopeCallIndex }
}

export function derivedLabel(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim()
  return line.length <= 60 ? line || 'agent' : `${line.slice(0, 59)}…`
}

/**
 * host 边界的 attachments 形状校验：字符串数组且每项非空非纯空白；空数组合法。
 * worker 层已有同构拒绝；此处不信任消息面再拦一道（非法值 fatal，不下发宿主）。
 */
export function isValidAttachments(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((id) => typeof id === 'string' && id.trim() !== '')
}

/** secretNames 同构边界校验：非空字符串数组（环境变量名形状由内核 spawn 边界统一校验）。 */
export function isValidSecretNames(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((name) => typeof name === 'string' && name.trim() !== '')
}

/**
 * scopeId 命名空间的 resume 登记键（根 scope = 0；未传 scopeId 视为根，与
 * 旧版裸 label 语义一致——不带 scope 的调用全部落在根命名空间）。
 */
export function scopedResumeKey(scopeId: number | undefined, label: string): string {
  return `${scopeId ?? 0}:${label}`
}

/**
 * 自动重试时下次尝试的 prompt：原文 + 增量失败块。续接的是同一子会话，
 * 历史失败已在会话上下文里，只追加最新一次的原因，不累计。
 */
export function agentRetryPrompt(originalPrompt: string, failedAttempt: number, reason: string): string {
  return `${originalPrompt}\n\n[attempt ${failedAttempt} failed]\n${reason}\nFix the problem above and complete the original task.`
}

/** 从进度行提取持久面 execution 元数据（无任何字段时返回 undefined）。 */
export function executionInfoForMeta(base: WorkflowAgentEntry): JournalAgentExecution | undefined {
  if (base.nodeId === undefined && base.conversationId === undefined && base.executionId === undefined && base.effectiveCwd === undefined && base.worktree === undefined) return undefined
  return {
    ...(base.nodeId !== undefined ? { nodeId: base.nodeId } : {}),
    ...(base.conversationId !== undefined ? { conversationId: base.conversationId } : {}),
    ...(base.executionId !== undefined ? { executionId: base.executionId } : {}),
    ...(base.effectiveCwd !== undefined ? { effectiveCwd: base.effectiveCwd } : {}),
    ...(base.worktree !== undefined ? { worktree: base.worktree } : {}),
  }
}

/** 结构化输出契约复检（缓存命中与新鲜结果同一标准）。 */
export function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.text ?? '')
  } catch {
    return {
      ...result,
      ok: false,
      error: 'The agent did not return structured output: its answer was not JSON.',
    }
  }
  const verdict = compiled.check(parsed)
  if (verdict === true) return result
  return {
    ...result,
    ok: false,
    error: `The agent's answer did not match the requested schema: ${verdict}`,
  }
}

/**
 * gate 恰好一次的宿主侧兑现：优先执行环境已回报（onGateResult → reported /
 * result.gate），否则宿主自跑 fallback；结论写回进度行并按需改写调用结果。
 */
export async function applyGate(
  result: WorkflowSpawnResult,
  command: string,
  agentId: string,
  runGate: NonNullable<WorkflowHost['runGate']> | undefined,
  reported?: WorkflowGateResult,
  gateTimeoutMs?: number,
  effectiveCwd?: string,
): Promise<WorkflowSpawnResult> {
  const outcome =
    reported ??
    result.gate ??
    (await runGate!(command, {
      agentId,
      ...((result.cwd ?? effectiveCwd) !== undefined ? { cwd: result.cwd ?? effectiveCwd } : {}),
      ...(gateTimeoutMs !== undefined ? { gateTimeoutMs } : {}),
    }))
  const kept = { ...result, gate: outcome, ...(outcome.timedOut === true ? { timedOut: true } : {}) }
  if (outcome.ok) return kept
  const { text: _discarded, ...rest } = kept
  const output = outcome.output.trim()
  if (output !== '') return { ...rest, ok: false, error: output }
  // 输出为空时用结构化原因区分超时/退出码，供重试 prompt 与用户诊断使用。
  const detail =
    outcome.timedOut === true
      ? `Gate command timed out: ${command}`
      : outcome.exitCode !== undefined && outcome.exitCode !== null
        ? `Gate command failed with exit code ${outcome.exitCode}: ${command}`
        : `Gate command failed: ${command}`
  return { ...rest, ok: false, error: detail }
}

export function unawaitedLaunchMessage(labels: readonly string[]): string {
  const list = labels.map((label) => `'${label}'`).join(', ')
  return `workflow script completed with unawaited launch(es): ${list}. Await or return each launch.`
}

/* ------------------------------------------------------------------------- *
 * 脚本校验（顶层 run 与嵌套 workflow() 同一标准）
 * ------------------------------------------------------------------------- */

/** 脚本编译前必须满足的一切（顶层 run 与嵌套 workflow() 同一标准）。 */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new WorkflowRuntimeError(
      `Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`,
    )
  }
  if (CONTROL_CHARACTERS.test(script)) {
    throw new WorkflowRuntimeError(
      'Workflow script contains control characters. Only tab, carriage return and newline are allowed.',
    )
  }
  return extractMeta(script)
}

/**
 * 保存定义前的纯语法预检（确定性、零副作用）：
 * - validateScript 全量边界（长度 / 控制字符 / meta 纯字面量）；
 * - 与 worker 完全相同的包装形状做 compile-only 编译检查——只 new Script 不
 *   runInContext，不执行任何脚本体语句，不产生副作用。PRELUDE 是固定合法
 * 前缀且与 body 以换行分隔，去掉后不改变 body 自身的语法判定。
 */
export function precheckScriptSyntax(script: string): { meta: WorkflowMeta; body: string } {
  const { meta, body } = validateScript(script)
  try {
    new Script(`(async () => {\n${body}\n})()`, {
      filename: 'workflow-syntax-precheck.js',
      lineOffset: -1,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkflowRuntimeError(`Workflow script has a syntax error: ${detail}`)
  }
  return { meta, body }
}
