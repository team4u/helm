/**
 * runtime.ts — 工作流 run 的宿主半边。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植，helm 适配点：
 * - 新增 `action()` 原语的宿主侧处理：与 agent 共享同一全序前缀账本（index 按
 *   调用发起顺序分配）；`action_started` 追加+fsync 成功后才执行 handler，
 *   终态行落盘后才 resolve 调用 promise；任一写失败即 fatal（不可在无法记账
 *   的状态下继续执行副作用）。恢复时 started 无终态由上层显式报
 *   `workflow_action_uncertain`，绝不自动重跑。
 * - 前缀重放逐项匹配（index+key+kind+ok）：resumed 行不再整体禁用前缀，
 *   已确认成功的 action/agent 一律复用，副作用零重复。缓存子结果可作为同一
 *   脚本后续 resume 调用的前缀来源，但无活会话：前缀失配后需要真正续接时
 *   显式失败，绝不伪造 live 续接。
 * - spawn 接缝面向 helm `WorkflowServiceHost`（agent_spawn 钩子管道的注入式
 *   适配在 service.ts），runtime 本体保持零内核依赖、可独立测试。
 * - worker 线程 + vm 双层边界：terminate 可杀死循环脚本；vm 禁动态代码生成与
 *   非确定 API（见 worker-source.ts）。这是可终止/确定性边界，不是恶意代码
 *   安全沙箱。
 * - label/resume 句柄按 scopeId 命名空间隔离（根 = 0，未传视为根）：嵌套
 *   workflow() 的同名 label 互不干扰；失败调用只要拿到 conversationId /
 *   executionId 即登记续接句柄；maxAttempts > 1 复用同一 attempt 环，经
 *   resumeAgent 续接重试，失败原因以增量块追加进下次尝试 prompt。
 */

import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { Script } from 'node:vm'
import {
  actionJournalKey,
  agentJournalKey,
  type AgentJournalKeyInput,
  hasValidScopeIdentity,
  type JournalAgentExecution,
  redactJournalEntry,
  JournalWriteError,
  type JournalWriteInput,
  type WorkflowJournalEntry,
} from './journal.js'
import { type CompiledSchema, compileJsonSchema } from './json-schema.js'
import { extractMeta, type WorkflowMeta } from './meta.js'
import type { AgentExecutionInfo, AgentGateResult } from '@helm/protocol'
import { extractWorkflowExecutionMeta, HARD_MAX_SUBAGENT_DEPTH } from '../../contracts.js'
import type { WorkflowActionEntry, WorkflowAgentEntry, WorkflowEntry } from './progress.js'
import { WORKER_SOURCE } from './worker-source.js'
import { JournalReplay, type ReplayScope } from './replay.js'

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

/** 脚本请求的一个 agent 调用。`agentId` 是宿主侧 abort/resume 的句柄。 */
export interface WorkflowSpawnRequest {
  agentId: string
  /** 本次尝试的账本位次；进度条目仍以所属调用的首位次标识。 */
  index: number
  prompt: string
  label: string
  agentType: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  /** 跨重启恢复时传递账本中的 execution handle。 */
  resumeRef?: string
  /**
   * 执行环境确定后回传（原生子会话或外部运行时均适用）：conversationId /
   * executionId / effectiveCwd / worktree 等元数据 + 实际模型信息。引擎把
   * 元数据写入进度行（不混入业务输出）。
   */
  onResolved?(info: AgentExecutionInfo & {
    modelName?: string
    modelId?: string
    thinking?: string
    requestedThinking?: string
    requestedModel?: string
  }): void
  /** gate 已在执行环境内恰好一次执行后的结果回报（免二次执行）。 */
  onGateResult?(result: AgentGateResult): void
  /** 由脚本 agent({ schema }) 编译出的结构化输出契约。 */
  schema?: CompiledSchema
  /** 由脚本 agent({ attachments }) 传入的产物 ID 列表（原样透传，宿主做存在性/授权校验）。 */
  attachments?: string[]
  /**
   * 由脚本 agent({ secretNames }) 传入的机密环境变量名列表：显式授予外部
   * 运行时注入父会话 stash 机密（缺省不携带任何机密；名字存在性由内核
   * spawn 边界校验）。参与 journal 指纹：授予变化即不同调用。
   */
  secretNames?: string[]
  /**
   * 显式设置该 agent 子代理在任务树中的绝对深度上限（1..HARD_MAX_SUBAGENT_DEPTH）；
   * 缺省继承父会话生效上限。该字段参与 journal 指纹：授权变化使该调用及后续
   * 前缀失配，避免复用不同派工权限下的缓存结果；真实 spawn 仍由宿主重新校验。
   */
  maxSubagentDepth?: number
  phaseIndex?: number
  phaseTitle?: string
  /**
   * 该 agent 的 gate 命令。执行权在宿主 runGate（恰好一次）；spawn 适配层
   * 不得把 gate 传给 agent_spawn 管道（避免双执行）。
   */
  gate?: string
}

export interface WorkflowSpawnResult {
  ok: boolean
  text?: string
  error?: string
  skipped?: boolean
  tokens?: number
  outputTokens?: number
  structuredRetried?: boolean
  toolCalls?: number
  cwd?: string
  /** 宿主已在子进程工作目录内执行过 gate 时回传，applyGate 不再重复执行。 */
  gate?: WorkflowGateResult
  /**
   * 执行环境元数据快照（spawn 完成时已确定的部分；onResolved 可能更早）。
   * 引擎仅用于进度行，绝不混入用户返回值。
   */
  executionInfo?: AgentExecutionInfo
  timedOut?: boolean
}

/** gate 命令结果；output 是失败时展示给用户的输出。 */
export interface WorkflowGateResult {
  ok: boolean
  output: string
  /** gate 进程退出码（null = 被信号杀死或不可知）。 */
  exitCode?: number | null
  /** gate 命令是否因超时被终止（runShell 进程组 SIGTERM→SIGKILL）。 */
  timedOut?: boolean
}

export interface WorkflowScriptRef {
  name?: string
  scriptPath?: string
}

export type WorkflowScriptSource =
  | { ok: true; script: string; path?: string }
  | { ok: false; message: string }

/** runtime 与外部世界的唯一接缝（注入式，测试可替换为确定性 fake）。 */
export interface WorkflowHost {
  spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult>
  /** run 中止时对每个在途 agent 调用。 */
  abortAgent(agentId: string): void
  /** 续接本 run 内既有子代理（保持其 agent 类型/模型/上下文）。缺省则拒绝 resume。 */
  resumeAgent?(
    agentId: string,
    prompt: string,
    options?: ResumeAgentOptions,
  ): Promise<WorkflowSpawnResult>
  /**
   * 执行 gate 命令并报告是否通过。cwd 为子会话工作目录（如有）。
   * 宿主自跑 fallback：执行环境未回报 gate（无 onGateResult/result.gate）时
   * 由本引擎兑现。缺省宿主让 runtime 显式失败该调用——静默不跑的 gate
   * 等于把未验证工作标记为已验证。
   */
  runGate?(command: string, options: { agentId: string; cwd?: string; gateTimeoutMs?: number }): Promise<WorkflowGateResult>
  /**
   * 动作前置预检（Pre-flight，零副作用）：在落盘 `action_started` 之前调用。
   * 用于校验 actionId 存在性/无歧义、插件启用、会话 scope 及 inputSchema，
   * 并返回动作定义端的默认 `idempotent` 属性。
   * 若抛错，说明 handler 完全未执行（零副作用），引擎不写 `action_started`。
   */
  prepareAction?(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }> | { pluginId: string; actionId: string; idempotent?: boolean }
  /**
   * 调用插件动作（helm action 原语）。pluginId/actionId 由宿主按 manifest
   * 精确解析后传入；input/output 均为安全 JSON。context.signal 随 run 中止。
   */
  invokeAction(
    actionId: string,
    input: unknown,
    context: { index: number; signal?: AbortSignal },
  ): Promise<{ pluginId: string; actionId: string; result: unknown }>
  /** 解析嵌套 workflow() 引用到源码。缺省宿主直接拒绝 workflow()。 */
  loadWorkflow?(ref: WorkflowScriptRef): Promise<WorkflowScriptSource> | WorkflowScriptSource
}

/** resumeAgent 的可选能力下传面（引擎在续接调用时原样转交实际执行环境）。 */
export interface ResumeAgentOptions {
  /** 续接回合的结构化输出契约（脚本 agent({ resume, schema }) 编译产物）。 */
  schema?: CompiledSchema
  /** 续接回合的 gate 命令（在实际执行环境内恰好一次执行后经 onGateResult 回报）。 */
  gate?: string
  /** 续接回合携带的产物 ID 列表（仅属本轮提交，不自动沿用原任务附件）。 */
  attachments?: string[]
  /** 续接时显式调整子树上限，仍受发起方继承上限约束。 */
  maxSubagentDepth?: number
  timeoutMs?: number
  gateTimeoutMs?: number
  /** 跨重启恢复时使用的持久 execution handle；缺省沿用 agentId 映射。 */
  resumeRef?: string
  onResolved?: WorkflowSpawnRequest['onResolved']
  onGateResult?: WorkflowSpawnRequest['onGateResult']
}

/** run 进行中可施加的控制（暂停/跳过/重试），全部幂等 best-effort。 */
export interface WorkflowControl {
  pause(): void
  resume(): void
  isPaused(): boolean
  skip(index: number): boolean
  retry(index: number): boolean
}

/** 账本追加输入见 journal.ts 的权威定义（此处旧别名仅为兼容本文件内引用）。 */
export type { JournalWriteInput } from './journal.js'

type JournalAppendInput = import('./journal.js').JournalWriteInput

type ActionJournalInput =
  | Omit<Extract<JournalAppendInput, { type: 'action' }>, keyof ReplayScope>
  | Omit<Extract<JournalAppendInput, { type: 'action_started' }>, keyof ReplayScope>

export interface RunWorkflowOptions {
  script: string
  args?: unknown
  host: WorkflowHost
  signal?: AbortSignal
  onProgress?(entries: readonly WorkflowEntry[]): void
  concurrency?: number
  agentCap?: number
  itemCap?: number
  onControl?(control: WorkflowControl): void
  nestedCap?: number
  /**
   * 重放与记账（fs 由调用方注入，runtime 测试无需文件系统）。
   * `append` 可为 Promise：action_started 在 resolve 之前不得执行 handler，
   * action 终态行落盘之前不得 resolve 调用。append 抛 JournalWriteError 时
   * action 路径 fatal；agent 路径仅诊断计数、不中断 run。
   */
  journal?: {
    entries?: readonly WorkflowJournalEntry[]
    append?(entry: JournalWriteInput): Promise<void> | void
  }
  /**
   * 持久面（journal 值 / 进度预览）脱敏钩子：字符串值先经此替换再落盘。
   * 缺省原样。注意：worker 回传与脚本运行时仍用原始值，重放只能取回脱敏值
   * （秘密须经 env / action 输入 marker 传递，不得依赖重放还原）。
   */
  redact?(text: string): string
}

export interface WorkflowRunResult {
  status: 'completed' | 'failed' | 'killed'
  meta: WorkflowMeta
  /** 脚本返回值（边界处已做 JSON 检查）。 */
  value?: unknown
  error?: string
  /** append-only 日志（发射顺序）。 */
  progress: WorkflowEntry[]
  /** 调度过的 agent 总数（含失败）。 */
  agentCount: number
  /** 其中来自账本重放的数量。 */
  replayedCount: number
  /**
   * agent 行记账失败的诊断明细（尽力而为面：run 不中断，错误在此如实携带）。
   * 空数组/缺省 = 无记账失败。消费方：service 结算时打 stderr 并入 run 诊断。
   */
  journalIoErrors?: string[]
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
 * Semaphore
 * ------------------------------------------------------------------------- */

class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    // 直接把许可递给下一个等待者；先减后加会让一波 release 放行超限并发。
    if (next) next()
    else this.active--
  }

  drain(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.()
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Messages
 * ------------------------------------------------------------------------- */

interface AgentCallPayload extends ReplayScope {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  isolation?: 'worktree'
  phaseIndex?: number
  phaseTitle?: string
  gate?: string
  resume?: string
  effort?: string
  schema?: unknown
  attachments?: string[]
  /** 显式授予该 agent 子树的派生深度上限（worker 侧已验证；宿主边界二次校验）。 */
  maxSubagentDepth?: number
  /** 显式授予外部运行时注入的父会话机密环境变量名（宿主边界二次校验；仅新鲜 spawn 下发）。 */
  secretNames?: string[]
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  /** 发起调用的 workflow scope（worker makeScope 分配；根 = 0，缺省视为根）。label/resume 按它命名空间隔离。 */
  scopeId?: number
  /** 自动重试上限（1..MAX_AGENT_ATTEMPTS，缺省 1）：失败且已登记续接句柄时按 attempt 环自动续接重试。 */
  maxAttempts?: number
  withMeta?: boolean
}

interface ActionCallPayload extends ReplayScope {
  actionId: string
  input: unknown
  label?: string
  idempotent?: boolean
  phaseIndex?: number
  phaseTitle?: string
}

type WorkerMessage =
  | { type: 'call'; callId: number; method: 'agent'; payload: AgentCallPayload }
  | { type: 'call'; callId: number; method: 'action'; payload: ActionCallPayload }
  | { type: 'call'; callId: number; method: 'workflow'; payload: WorkflowScriptRef }
  | { type: 'progress'; entries: WorkflowEntry[] }
  | { type: 'complete'; resultJson?: string }
  | { type: 'error'; message: string; stack?: string }

/** 除 tab/newline/cr 外的全部 0x20 以下字符与 DEL。 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

const preview = (text: string) =>
  text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`

function readCallScope(payload: ReplayScope): ReplayScope {
  if (!hasValidScopeIdentity(payload)) throw new WorkflowRuntimeError('Workflow call scope identity is invalid.')
  return { scopePath: payload.scopePath, scopeCallIndex: payload.scopeCallIndex }
}

function derivedLabel(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim()
  return line.length <= 60 ? line || 'agent' : `${line.slice(0, 59)}…`
}

/**
 * host 边界的 attachments 形状校验：字符串数组且每项非空非纯空白；空数组合法。
 * worker 层已有同构拒绝；此处不信任消息面再拦一道（非法值 fatal，不下发宿主）。
 */
function isValidAttachments(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((id) => typeof id === 'string' && id.trim() !== '')
}

/** secretNames 同构边界校验：非空字符串数组（环境变量名形状由内核 spawn 边界统一校验）。 */
function isValidSecretNames(value: unknown): value is string[] {
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

/** resume 可复活的子代理，按 scopedResumeKey 键记忆。 */
interface CompletedChild {
  agentId: string
  label: string
  agentType: string
  model?: string
  isolation?: 'worktree'
  /** 登记时所属 scope（根 = 0；用于同 scope 的已知 label 提示过滤）。 */
  scopeId?: number
  /**
   * 该 child 来自账本缓存（replayed）：只有文本结果，无活会话可续接。
   * 后续 agent({ resume }) 命中账本时可直接返回缓存文本，但前缀失配后
   * 需要真正续接时必须显式失败，绝不伪造 live 续接。
   */
  replayed?: true
  /** 跨进程恢复时从账本还原的原生/外部执行句柄。 */
  resumeRef?: string
}

function executionInfoForMeta(base: WorkflowAgentEntry): JournalAgentExecution | undefined {
  if (base.nodeId === undefined && base.conversationId === undefined && base.executionId === undefined && base.effectiveCwd === undefined && base.worktree === undefined) return undefined
  return {
    ...(base.nodeId !== undefined ? { nodeId: base.nodeId } : {}),
    ...(base.conversationId !== undefined ? { conversationId: base.conversationId } : {}),
    ...(base.executionId !== undefined ? { executionId: base.executionId } : {}),
    ...(base.effectiveCwd !== undefined ? { effectiveCwd: base.effectiveCwd } : {}),
    ...(base.worktree !== undefined ? { worktree: base.worktree } : {}),
  }
}

function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
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

async function applyGate(
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

function unawaitedLaunchMessage(labels: readonly string[]): string {
  const list = labels.map((label) => `'${label}'`).join(', ')
  return `workflow script completed with unawaited launch(es): ${list}. Await or return each launch.`
}

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

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options

  const normalizedArgs = normalizeWorkflowArgs(options.args)
  assertBoundarySafe(normalizedArgs, 'args')

  const { meta, body } = validateScript(script)
  const agentCap = options.agentCap ?? WORKFLOW_AGENT_CAP
  const itemCap = options.itemCap ?? WORKFLOW_ITEM_CAP
  const semaphore = new Semaphore(options.concurrency ?? workflowConcurrency())

  const progress: WorkflowEntry[] = []
  const inflight = new Set<string>()
  const completedByLabel = new Map<string, CompletedChild>()
  const openLaunches = new Map<number, string>()
  let callIndex = 0
  let agentCount = 0
  let aborted = false
  let settled = false

  /* --- resume state ---------------------------------------------------- */

  const journalEntries = options.journal?.entries ?? []
  const appendJournal = options.journal?.append
  const redactText = options.redact ?? ((text: string) => text)
  const replay = new JournalReplay(journalEntries)
  let replayedCount = 0

  const allocateIndex = () => callIndex++

  /**
   * agent 行记账尽力而为：写失败不中断 run（resume 优化损失），错误记入
   * journalIoErrors 随 WorkflowRunResult 暴露，绝不隐瞒。
   */
  async function recordAgent(entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq'>): Promise<void> {
    if (appendJournal === undefined) return
    try {
      await appendJournal(redactJournalEntry({ ...entry, type: 'agent' }, redactText))
    } catch (error) {
      journalIoErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const journalIoErrors: string[] = []

  /* --- live control ---------------------------------------------------- */

  interface LiveAgent {
    agentId: string
    started: boolean
    intent?: 'skip' | 'retry'
    wake?: () => void
  }
  const liveAgents = new Map<number, LiveAgent>()

  let spentOutputTokens = 0

  let paused = false
  const isPaused = () => paused
  const pauseWaiters = new Set<() => void>()
  function releasePause(): void {
    for (const wake of [...pauseWaiters]) wake()
    pauseWaiters.clear()
  }
  function pauseGate(live: LiveAgent): Promise<void> {
    if (!paused || aborted || settled) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        pauseWaiters.delete(wake)
        live.wake = undefined
        resolve()
      }
      live.wake = wake
      pauseWaiters.add(wake)
    })
  }

  function actionPauseGate(): Promise<void> {
    if (!paused || aborted || settled) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = () => {
        pauseWaiters.delete(wake)
        resolve()
      }
      pauseWaiters.add(wake)
    })
  }

  options.onControl?.({
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
      releasePause()
    },
    isPaused: () => paused,
    skip: (index) => {
      const live = liveAgents.get(index)
      if (live === undefined || live.intent !== undefined) return false
      live.intent = 'skip'
      if (live.started) host.abortAgent(live.agentId)
      else live.wake?.()
      return true
    },
    retry: (index) => {
      const live = liveAgents.get(index)
      if (live === undefined || !live.started || live.intent !== undefined) return false
      live.intent = 'retry'
      host.abortAgent(live.agentId)
      return true
    },
  })

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaJson: JSON.stringify(meta),
      argsJson: normalizedArgs === undefined ? undefined : JSON.stringify(normalizedArgs),
      itemCap,
      nestedCap: options.nestedCap ?? WORKFLOW_NESTED_CAP,
    },
  })

  return await new Promise<WorkflowRunResult>((resolve) => {
    const emit = (entries: WorkflowEntry[]) => {
      if (entries.length === 0) return
      progress.push(...entries)
      options.onProgress?.(entries)
    }

    const respond = (
      callId: number,
      ok: boolean,
      value?: unknown,
      error?: string,
      fatal?: boolean,
    ) => {
      openLaunches.delete(callId)
      if (settled) return
      // 致命错误属于整个 run，不能让脚本 catch 或后续并发消息绕过副作用保护。
      if (fatal) {
        finish({ status: 'failed', error: error ?? 'Fatal workflow error.' })
        return
      }
      worker.postMessage({ type: 'response', callId, ok, value, error, fatal, spent: spentOutputTokens })
    }

    const finish = (
      result: Omit<WorkflowRunResult, 'meta' | 'progress' | 'agentCount' | 'replayedCount'>,
    ) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      releasePause()
      for (const agentId of inflight) host.abortAgent(agentId)
      inflight.clear()
      semaphore.drain()
      const settle = () =>
        resolve({ ...result, meta, progress, agentCount, replayedCount, ...(journalIoErrors.length > 0 ? { journalIoErrors: [...journalIoErrors] } : {}) })
      void worker.terminate().then(settle, settle)
    }

    function onAbort() {
      aborted = true
      // terminate() 是 worker 层存在的理由：它能在脚本自旋或卡在 await 中途时停下。
      finish({ status: 'killed', error: 'Workflow aborted.' })
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    async function handleAgent(callId: number, payload: AgentCallPayload): Promise<void> {
      const runGate = host.runGate?.bind(host)
      const resumeAgent = host.resumeAgent?.bind(host)
      if (payload.gate !== undefined && runGate === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
        return
      }
      if (payload.resume !== undefined && resumeAgent === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
        return
      }
      for (const [name, value, upper] of [
        ['timeoutMs', payload.timeoutMs, 3_600_000],
        ['gateTimeoutMs', payload.gateTimeoutMs, 600_000],
      ] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 1_000 || value > upper)) {
          respond(callId, false, undefined, `agent() opts.${name} must be an integer between 1000 and ${upper}.`, true)
          return
        }
      }
      if (payload.gateTimeoutMs !== undefined && payload.gate === undefined) {
        respond(callId, false, undefined, 'agent() opts.gateTimeoutMs requires opts.gate.', true)
        return
      }

      // scopeId 是 scope 命名空间字段（worker makeScope 分配，根 = 0）。
      // 非法形状在边界显式拒绝：不信任 worker 消息面，也不静默钳制。
      if (payload.scopeId !== undefined && (!Number.isInteger(payload.scopeId) || payload.scopeId < 0)) {
        respond(callId, false, undefined, 'agent() opts.scopeId must be a non-negative integer.', true)
        return
      }
      const scopeId = payload.scopeId ?? 0
      const scope = readCallScope(payload)
      const { scopePath, scopeCallIndex } = scope

      let resumed: CompletedChild | undefined
      if (payload.resume !== undefined) {
        resumed = completedByLabel.get(scopedResumeKey(scopeId, payload.resume))
        if (resumed === undefined) {
          const known = [...completedByLabel.values()]
            .filter((child) => (child.scopeId ?? 0) === scopeId)
            .map((child) => child.label)
          respond(
            callId,
            false,
            undefined,
            replayedCount > 0
              ? `agent() opts.resume: "${payload.resume}" was replayed from the resume journal, not run, so there is ` +
                  'no conversation in this run to continue. Re-run without resumeFromRunId.'
              : `agent() opts.resume: no agent has completed under the label "${payload.resume}" in this run. ${
                  known.length === 0
                    ? 'No agent has completed yet.'
                    : `Known labels: ${known.map((label) => `"${label}"`).join(', ')}.`
                }`,
            true,
          )
          return
        }
        // 先匹配账本；只有真正需要执行时，才拒绝无活会话的缓存续接。
      }

      let compiledSchema: CompiledSchema | undefined
      if (payload.schema !== undefined) {
        const compilation = compileJsonSchema(payload.schema)
        if (!compilation.ok) {
          respond(callId, false, undefined, compilation.message, true)
          return
        }
        compiledSchema = compilation.compiled
      }

      // host 边界二次校验（不信任 worker 消息面）：非法 attachments 是 fatal，
      // 绝不带病下发到真实宿主 spawn/resume 端口。
      if (payload.attachments !== undefined && !isValidAttachments(payload.attachments)) {
        respond(callId, false, undefined, 'agent() opts.attachments must be an array of non-empty string artifact IDs.', true)
        return
      }
      // 同上：secretNames 是机密授予字段，非法形状在边界显式拒绝（不静默丢弃）。
      if (payload.secretNames !== undefined && !isValidSecretNames(payload.secretNames)) {
        respond(callId, false, undefined, 'agent() opts.secretNames must be an array of non-empty string secret env names.', true)
        return
      }
      // 同上：maxSubagentDepth 是策略授予字段，非法值在边界显式拒绝（不钳制、
      // 不静默丢弃）；仅对新鲜 spawn 下发，resume 续接沿用登记表既有事实。
      if (
        payload.maxSubagentDepth !== undefined &&
        (!Number.isInteger(payload.maxSubagentDepth) ||
          payload.maxSubagentDepth < 1 ||
          payload.maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH)
      ) {
        respond(
          callId,
          false,
          undefined,
          `agent() opts.maxSubagentDepth must be an integer between 1 and ${HARD_MAX_SUBAGENT_DEPTH}.`,
          true,
        )
        return
      }
      // 同上：maxAttempts 是自动重试策略字段，非法值显式拒绝（策略值被静默
      // 改写会让重试语义失真）。
      if (
        payload.maxAttempts !== undefined &&
        (!Number.isInteger(payload.maxAttempts) ||
          payload.maxAttempts < 1 ||
          payload.maxAttempts > MAX_AGENT_ATTEMPTS)
      ) {
        respond(
          callId,
          false,
          undefined,
          `agent() opts.maxAttempts must be an integer between 1 and ${MAX_AGENT_ATTEMPTS}.`,
          true,
        )
        return
      }

      if (agentCount >= agentCap) {
        respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true)
        return
      }
      // 调用位次在发起时分配（agent 与 action 共享全序）；并发完成顺序不参与。
      const index = allocateIndex()
      const recordAttempt = (entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq' | 'scopePath' | 'scopeCallIndex'>) =>
        recordAgent({ ...entry, ...scope, invocationIndex: index })
      agentCount++
      const maxAttempts = payload.maxAttempts ?? 1
      const logicalId = scopePath === 'root' ? String(scopeCallIndex) : `${scopePath}:${scopeCallIndex}`
      const agentId = resumed?.agentId ?? `wf-agent-${logicalId}`
      const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt)
      // agentType 缺省 'assistant'：helm 的 agentType 是 Profile ID，宿主
      // ProfileService.ensureDefault 保证 assistant 存在（root 同源）。绝不沿用
      // 上游 'general-purpose'——helm 没有该 profile，NativeSpawn 严格校验会硬失败。
      const agentType = resumed?.agentType ?? payload.agentType ?? 'assistant'
      const model = resumed !== undefined ? resumed.model : payload.model
      const isolation = resumed !== undefined ? resumed.isolation : payload.isolation
      openLaunches.set(callId, label)

      const base: WorkflowAgentEntry = {
        type: 'workflow_agent',
        index,
        label,
        state: 'start',
        agentId,
        agentType,
        promptPreview: preview(payload.prompt),
        prompt: payload.prompt,
        ...(compiledSchema !== undefined ? { schema: compiledSchema.schema } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
        ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
        ...(payload.gate !== undefined ? { gateCommand: payload.gate } : {}),
      }

      const queuedAt = Date.now()
      emit([{ ...base, queuedAt }])

      const keyInput: AgentJournalKeyInput = {
        prompt: payload.prompt,
        label: payload.label,
        model: payload.model,
        agentType: payload.agentType,
        effort: payload.effort,
        isolation: payload.isolation,
        gate: payload.gate,
        resume: payload.resume,
        attachments: payload.attachments,
        maxSubagentDepth: payload.maxSubagentDepth,
        secretNames: payload.secretNames,
        cwd: payload.cwd,
        schema: payload.schema !== undefined ? JSON.stringify(payload.schema) : undefined,
      }
      const firstAttemptKey = agentJournalKey(keyInput)
      const firstHistory = replay.history(scope)
      const replayed = replay.match(scope, firstAttemptKey, 'agent', {
        attempt: 1,
        allowFailure: maxAttempts > 1 || (firstHistory?.type === 'agent' && (firstHistory.retryKind === 'manual' || firstHistory.skipped === true)),
        resumed: payload.resume !== undefined,
      })
      if (replayed.conflictError !== undefined) {
        respond(callId, false, undefined, replayed.conflictError, true)
        return
      }
      let replayedEntry = replayed.hit ? replayed.entry : undefined
      let attempt = 1
      let attemptIndex = index
      let attemptPrompt = payload.prompt!
      let attemptKey = firstAttemptKey
      let resumeTarget: CompletedChild | undefined = resumed
      while (replayedEntry?.type === 'agent' && !replayedEntry.ok) {
        const failed = replayedEntry
        const execution = failed.execution
        if (execution !== undefined) {
          base.nodeId = execution.nodeId
          base.conversationId = execution.conversationId
          base.executionId = execution.executionId
          base.effectiveCwd = execution.effectiveCwd
          base.worktree = execution.worktree as WorkflowAgentEntry['worktree']
        }
        base.gate = failed.gate
        const { v: _version, seq: _seq, type: _type, ...recorded } = failed
        replayedCount++
        await recordAttempt({ ...recorded, index: attemptIndex })
        emit([{
          ...base, queuedAt, state: 'error', cached: true,
          attempt, error: failed.error ?? 'Agent failed.',
          ...(failed.skipped === true ? { skipped: true } : {}),
        }])
        const persistedHandle = execution?.executionId ??
          (execution?.conversationId !== undefined ? String(execution.conversationId) : undefined)
        const manualRetry = failed.retryKind === 'manual'
        const canRetry = failed.skipped !== true && (manualRetry ||
          (attempt < maxAttempts && persistedHandle !== undefined && resumeAgent !== undefined))
        if (!canRetry) {
          if (replay.history(scope, attempt + 1) !== undefined) {
            const conflict = replay.miss(scope)
            if (conflict.conflictError !== undefined) {
              respond(callId, false, undefined, conflict.conflictError, true)
              return
            }
          }
          if (persistedHandle !== undefined) completedByLabel.set(scopedResumeKey(scopeId, label), {
            agentId, label, agentType, scopeId, resumeRef: persistedHandle,
            ...(model !== undefined ? { model } : {}),
            ...(isolation !== undefined ? { isolation } : {}),
          })
          respond(callId, true, payload.withMeta === true ? {
            ok: false, output: null, attempts: attempt, error: failed.error ?? 'Agent failed.',
            ...(failed.timedOut === true ? { timedOut: true } : {}),
            ...(execution !== undefined ? { execution } : {}),
            ...(failed.gate !== undefined ? { gate: failed.gate } : {}),
          } : null)
          return
        }
        if (!manualRetry) resumeTarget = {
          agentId, label, agentType, scopeId, resumeRef: persistedHandle!,
          ...(model !== undefined ? { model } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
        }
        attemptPrompt = manualRetry ? payload.prompt :
          agentRetryPrompt(payload.prompt, attempt, failed.error ?? 'Agent failed.')
        attempt++
        attemptIndex = allocateIndex()
        attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt,
          resume: resumeTarget === undefined ? payload.resume : agentId })
        const next = replay.match(scope, attemptKey, 'agent', {
          attempt, allowFailure: true, resumed: resumeTarget !== undefined,
        })
        if (next.conflictError !== undefined) {
          respond(callId, false, undefined, next.conflictError, true)
          return
        }
        replayedEntry = next.entry
      }
      if (replayedEntry !== undefined && replayedEntry.type === 'agent' && replayedEntry.ok && compiledSchema !== undefined) {
        const recheck = applySchema({ ok: true, text: replayedEntry.type === 'agent' ? replayedEntry.text ?? '' : '' }, compiledSchema)
        if (!recheck.ok) {
          replayedEntry = undefined
          const conflict = replay.miss(scope)
          if (conflict.conflictError !== undefined) {
            respond(callId, false, undefined, conflict.conflictError, true)
            return
          }
        }
      }
      if (replayedEntry !== undefined && replayedEntry.type === 'agent' && replayedEntry.ok) {
        const execution = replayedEntry.execution
        if (execution !== undefined) {
          base.nodeId = execution.nodeId
          base.conversationId = execution.conversationId
          base.executionId = execution.executionId
          base.effectiveCwd = execution.effectiveCwd
          base.worktree = execution.worktree as WorkflowAgentEntry['worktree']
        }
        base.gate = replayedEntry.gate
        base.prompt = replayedEntry.prompt ?? attemptPrompt
        base.promptPreview = preview(base.prompt)
        base.attempt = replayedEntry.attempt ?? attempt
        replayedCount++
        const replayedText = replayedEntry.text ?? ''
        // 缓存节点也登记为可 resume 的 child（标 replayed）：同一脚本内后续
        // 匹配账本的 resume 调用可直接返回缓存文本；但它无活会话，前缀失配
        // 后需要真正续接时由上方 replayed 守卫显式失败。
        completedByLabel.set(scopedResumeKey(scopeId, label), {
          agentId,
          label,
          agentType,
          ...(model !== undefined ? { model } : {}),
          ...(isolation !== undefined ? { isolation } : {}),
          scopeId,
          replayed: true,
        })
        const at = Date.now()
        emit([
          {
            ...base,
            queuedAt,
            startedAt: at,
            lastProgressAt: at,
            durationMs: 0,
            state: 'done',
            cached: true,
            resultPreview: preview(replayedText),
          },
        ])
        openLaunches.delete(callId)
        // 缓存分支记账保留 resumed 标记：原始调用是 resume 的，新账本必须如实。
        await recordAttempt({
          index: attemptIndex,
          key: replayedEntry.key,
          ok: true,
          text: replayedText,
          ...(replayedEntry.type === 'agent' && replayedEntry.resumed === true ? { resumed: true } : {}),
          ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution } : {}),
          ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
          ...(replayedEntry.attempt !== undefined ? { attempt: replayedEntry.attempt } : {}),
          ...(replayedEntry.invocationIndex !== undefined ? { invocationIndex: replayedEntry.invocationIndex } : {}),
          ...(replayedEntry.prompt !== undefined ? { prompt: replayedEntry.prompt } : {}),
        })
        respond(callId, true, payload.withMeta === true ? {
          ok: true,
          output: replayedText,
          attempts: replayedEntry.attempt ?? 1,
          ...(replayedEntry.execution !== undefined ? { execution: replayedEntry.execution } : {}),
          ...(replayedEntry.gate !== undefined ? { gate: replayedEntry.gate } : {}),
        } : replayedText)
        return
      }

      // 前缀失配（含本调用新增导致账本无此位次）而 resume 目标只存在于缓存子
      // 结果：无活会话可续接。显式失败，绝不伪造续接、也不重跑之前 action
      // 重建上下文。
      if (resumed?.replayed === true) {
        respond(
          callId,
          false,
          undefined,
          `agent() opts.resume: "${payload.resume}" only exists as a replayed (cached) context with no live ` +
            'conversation in this run to continue; a replayed context cannot be resumed. ' +
            'Re-run the workflow without resumeFromRunId.',
          true,
        )
        return
      }

      const settleSkipped = async (extra: Partial<WorkflowAgentEntry>) => {
        await recordAttempt({
          index: attemptIndex, key: attemptKey,
          prompt: attemptPrompt, ok: false, attempt, skipped: true, error: 'Skipped by user.',
          ...(resumeTarget !== undefined ? { resumed: true } : {}),
        })
        emit([{ ...base, queuedAt, ...extra, state: 'error', skipped: true, error: 'Skipped by user.' }])
        respond(callId, true, payload.withMeta === true ? {
          ok: false, output: null, attempts: attempt, error: 'Skipped by user.',
        } : null)
      }

      const live: LiveAgent = { agentId, started: false }
      liveAgents.set(index, live)
      const intent = (): LiveAgent['intent'] => live.intent

      /** 吸收执行环境元数据到进度行；失败分支同样吸收——conversationId/executionId 是登记续接句柄的依据。 */
      const absorbExecutionInfo = (info: AgentExecutionInfo): void => {
        if (info.nodeId !== undefined) base.nodeId = info.nodeId
        if (info.conversationId !== undefined) base.conversationId = info.conversationId
        if (info.executionId !== undefined) base.executionId = info.executionId
        if (info.effectiveCwd !== undefined) base.effectiveCwd = info.effectiveCwd
        const wfExecMeta = extractWorkflowExecutionMeta(info)
        if (wfExecMeta.worktree !== undefined) base.worktree = wfExecMeta.worktree
      }
      try {
        for (;;) {
          await pauseGate(live)
          if (intent() === 'skip') return settleSkipped({})

          await semaphore.acquire()
          if (aborted || settled) {
            semaphore.release()
            respond(callId, false, undefined, 'Workflow aborted.', true)
            return
          }
          if (isPaused() && !aborted && !settled) {
            semaphore.release()
            continue
          }
          if (intent() === 'skip') {
            semaphore.release()
            return settleSkipped({})
          }

          const attemptMark = { attempt }
          base.prompt = attemptPrompt
          base.promptPreview = preview(attemptPrompt)
          // 跨尝试不沿用旧 gate 回报：每次尝试的 gate 结论必须来自本次执行，
          // 旧失败/旧成功冒充新结果都会失真。
          if (attempt > 1) base.gate = undefined

          const startedAt = Date.now()
          emit([{ ...base, queuedAt, startedAt, ...attemptMark }])

          const onResolved: NonNullable<WorkflowSpawnRequest['onResolved']> = (info) => {
            if (info.nodeId !== undefined) base.nodeId = info.nodeId
            if (info.conversationId !== undefined) base.conversationId = info.conversationId
            if (info.executionId !== undefined) base.executionId = info.executionId
            if (info.effectiveCwd !== undefined) base.effectiveCwd = info.effectiveCwd
            const wfExecMeta = extractWorkflowExecutionMeta(info)
            if (wfExecMeta.worktree !== undefined) base.worktree = wfExecMeta.worktree
            if (info.modelName !== undefined) base.model = info.modelName
            if (info.thinking !== undefined) base.thinking = info.thinking
            if (info.requestedThinking !== undefined) base.requestedThinking = info.requestedThinking
            if (info.requestedModel !== undefined) base.requestedModel = info.requestedModel
            if (!inflight.has(agentId)) return
            emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }])
          }
          const onGateResult: NonNullable<WorkflowSpawnRequest['onGateResult']> = (gateResult) => {
            base.gate = gateResult
            if (!inflight.has(agentId)) return
            emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }])
          }
          live.started = true
          inflight.add(agentId)

          let result: WorkflowSpawnResult
          try {
            result =
              resumeTarget !== undefined && resumeAgent !== undefined
                ? await resumeAgent(resumeTarget.agentId, attemptPrompt, {
                    ...(resumeTarget.resumeRef !== undefined ? { resumeRef: resumeTarget.resumeRef } : {}),
                    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                    ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                    ...(payload.maxSubagentDepth !== undefined ? { maxSubagentDepth: payload.maxSubagentDepth } : {}),
                    ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
                    ...(payload.gateTimeoutMs !== undefined ? { gateTimeoutMs: payload.gateTimeoutMs } : {}),
                    onResolved,
                    ...(payload.gate !== undefined ? { onGateResult } : {}),
                  })
                : await host.spawnAgent({
                    agentId,
                    index: attemptIndex,
                    prompt: attemptPrompt,
                    label,
                    agentType,
                    ...(model !== undefined ? { model } : {}),
                    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                    ...(payload.maxSubagentDepth !== undefined ? { maxSubagentDepth: payload.maxSubagentDepth } : {}),
                    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                    ...(isolation !== undefined ? { isolation } : {}),
                    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                    ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                    ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
                    ...(payload.secretNames !== undefined ? { secretNames: payload.secretNames } : {}),
                    ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
                    ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
                    ...(payload.gateTimeoutMs !== undefined ? { gateTimeoutMs: payload.gateTimeoutMs } : {}),
                    onResolved,
                    ...(payload.gate !== undefined ? { onGateResult } : {}),
                  })
            if (result.ok) {
              completedByLabel.set(scopedResumeKey(scopeId, label), {
                agentId,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
                scopeId,
              })
              if (result.executionInfo !== undefined) absorbExecutionInfo(result.executionInfo)
              if (result.gate !== undefined && base.gate === undefined) base.gate = result.gate
              if (compiledSchema !== undefined && result.ok) {
                result = applySchema(result, compiledSchema)
              }
              if (result.ok && payload.gate !== undefined) {
                // gate 恰好一次：优先 onGateResult/result.gate 已回报结果；
                // 否则宿主自跑 fallback（仍缺 runGate 则上方前置检查已 fatal）。
                result = await applyGate(result, payload.gate, agentId, runGate, base.gate, payload.gateTimeoutMs, base.effectiveCwd)
                if (result.gate !== undefined) base.gate = result.gate
              }
            } else {
              // 失败分支同样吸收 executionInfo（§2.3：service 失败时保留元数据
              // 回传），供失败句柄登记与进度行使用。
              if (result.executionInfo !== undefined) absorbExecutionInfo(result.executionInfo)
              if (payload.gate !== undefined && result.gate !== undefined && base.gate === undefined) {
                base.gate = result.gate
              }
            }
            if (base.gate?.timedOut === true) result = { ...result, timedOut: true }
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) }
          } finally {
            inflight.delete(agentId)
            live.started = false
            semaphore.release()
          }

          if (settled) return
          if (intent() === 'skip') return settleSkipped({})

          if (intent() === 'retry' && !aborted) {
            live.intent = undefined
            const retryError = redactText(result.error ?? 'Agent failed.')
            const retryExecution = executionInfoForMeta(base)
            await recordAttempt({
              index: attemptIndex,
              key: attemptKey,
              ok: false,
              ...(resumeTarget !== undefined ? { resumed: true } : {}),
              attempt,
              invocationIndex: index,
              prompt: attemptPrompt,
              retryKind: 'manual',
              error: retryError,
              ...(result.timedOut === true ? { timedOut: true } : {}),
              ...(retryExecution !== undefined ? { execution: retryExecution } : {}),
              ...(base.gate !== undefined ? { gate: base.gate } : {}),
            })
            attempt++
            attemptIndex = allocateIndex()
            attemptPrompt = payload.prompt
            attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt,
              resume: resumeTarget === undefined ? payload.resume : agentId })
            emit([{ ...base, queuedAt, attempt }])
            continue
          }

          spentOutputTokens += result.outputTokens ?? 0

          const finishedAt = Date.now()
          const common = {
            ...base,
            queuedAt,
            startedAt,
            ...attemptMark,
            lastProgressAt: finishedAt,
            durationMs: finishedAt - startedAt,
            ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
            ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
          }
          if (result.ok) {
            const text = result.text ?? ''
            emit([{ ...common, state: 'done', resultPreview: preview(text) }])
            const execution = executionInfoForMeta(base)
            await recordAttempt({
              index: attemptIndex,
              key: attemptKey,
              ok: true,
              text,
              ...(resumeTarget !== undefined ? { resumed: true } : {}),
              attempt,
              invocationIndex: index,
              prompt: attemptPrompt,
              ...(execution !== undefined ? { execution } : {}),
              ...(base.gate !== undefined ? { gate: base.gate } : {}),
            })
            respond(callId, true, payload.withMeta === true ? {
              ok: true, output: text, attempts: attempt,
              ...(execution !== undefined ? { execution } : {}),
              ...(base.gate !== undefined ? { gate: base.gate } : {}),
            } : text)
            return
          }
          // 失败但已观察到执行环境（conversationId/executionId，含 service 失败
          // 分支回传的 executionInfo）：登记续接句柄。同 scope 后续
          // agent({ resume: label }) 可续接该子会话与其 Worktree（设计 §2.3）。
          const failureHandle: CompletedChild | undefined =
            base.conversationId !== undefined || base.executionId !== undefined
              ? {
                  agentId,
                  label,
                  agentType,
                  ...(model !== undefined ? { model } : {}),
                  ...(isolation !== undefined ? { isolation } : {}),
                  scopeId,
                }
              : undefined
          if (failureHandle !== undefined) {
            completedByLabel.set(scopedResumeKey(scopeId, label), failureHandle)
          }
          // maxAttempts 自动重试（与手动 control.retry 共用同一 attempt 环）：
          // 失败原因以增量块追加进下次尝试 prompt，经 resumeAgent 续接同一
          // 子会话继续修改，而非另起新会话重跑。
          if (failureHandle !== undefined && attempt < maxAttempts && resumeAgent !== undefined) {
            const failedError = redactText(result.error ?? 'Agent failed.')
            const execution = executionInfoForMeta(base)
            await recordAttempt({
              index: attemptIndex,
              key: attemptKey,
              ok: false,
              ...(resumeTarget !== undefined ? { resumed: true } : {}),
              attempt,
              invocationIndex: index,
              prompt: attemptPrompt,
              error: failedError,
              ...(result.timedOut === true ? { timedOut: true } : {}),
              ...(execution !== undefined ? { execution } : {}),
              ...(base.gate !== undefined ? { gate: base.gate } : {}),
            })
            attemptPrompt = agentRetryPrompt(payload.prompt!, attempt, failedError)
            attempt++
            resumeTarget = {
              ...failureHandle,
              ...(base.executionId !== undefined ? { resumeRef: base.executionId } : {}),
            }
            attemptIndex = allocateIndex()
            attemptKey = agentJournalKey({ ...keyInput, prompt: attemptPrompt, resume: agentId })
            emit([{ ...base, queuedAt, attempt }])
            continue
          }
          const execution = executionInfoForMeta(base)
          await recordAttempt({
            index: attemptIndex,
            key: attemptKey,
            ok: false,
            ...(resumeTarget !== undefined ? { resumed: true } : {}),
            attempt,
            invocationIndex: index,
            prompt: attemptPrompt,
            error: result.error ?? 'Agent failed.',
            ...(result.timedOut === true ? { timedOut: true } : {}),
            ...(execution !== undefined ? { execution } : {}),
            ...(base.gate !== undefined ? { gate: base.gate } : {}),
          })
          emit([
            {
              ...common,
              state: 'error',
              error: result.error ?? 'Agent failed.',
              ...(result.skipped ? { skipped: true } : {}),
            },
          ])
          respond(callId, true, payload.withMeta === true ? {
            ok: false,
            output: null,
            attempts: attempt,
            error: result.error ?? 'Agent failed.',
            ...(result.timedOut === true ? { timedOut: true } : {}),
            ...(execution !== undefined ? { execution } : {}),
            ...(base.gate !== undefined ? { gate: base.gate } : {}),
          } : null)
          return
        }
      } finally {
        liveAgents.delete(index)
      }
    }

    /**
     * action(actionId, input) 的宿主侧。
     *
     * 顺序契约：index 于调用发起时分配；action_started 追加+fsync 成功后才执行
     * handler；终态行（成功 result / 失败 error）落盘后才 respond。任何账本写
     * 失败都以 fatal 错误回给脚本——副作用不可在无法记账的状态下继续。
     * 已完成（ok）的 action 调用重放时直接复用 result，绝不重执行。
     */
    async function handleAction(callId: number, payload: ActionCallPayload): Promise<void> {
      const scope = readCallScope(payload)
      const recordAction = (entry: ActionJournalInput) => appendJournal?.({ ...entry, ...scope })
      const index = allocateIndex()
      openLaunches.set(callId, payload.actionId)
      const queuedAt = Date.now()

      const base: WorkflowActionEntry = {
        type: 'workflow_action',
        index,
        actionId: payload.actionId,
        state: 'start',
        queuedAt,
        ...(payload.label !== undefined ? { label: payload.label } : {}),
        ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
        ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
      }
      emit([{ ...base }])

      try {
        let serializedInput: string
        try {
          assertBoundarySafe(payload.input, `action('${payload.actionId}') input`)
          serializedInput = JSON.stringify(payload.input ?? {})
        } catch (error) {
          openLaunches.delete(callId)
          respond(
            callId,
            false,
            undefined,
            `action('${payload.actionId}') input is not JSON-safe: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
          )
          return
        }
        const key = actionJournalKey(payload.actionId, serializedInput)

        const replayed = replay.match(scope, key, 'action')
        if (replayed.conflictError !== undefined) {
          openLaunches.delete(callId)
          respond(callId, false, undefined, replayed.conflictError, true)
          return
        }

        if (replayed.hit && replayed.entry !== undefined && replayed.entry.type === 'action') {
          replayedCount++
          const at = Date.now()
          const resultText = JSON.stringify(replayed.entry.result ?? null)
          emit([
            {
              ...base,
              startedAt: at,
              lastProgressAt: at,
              durationMs: 0,
              state: 'done',
              cached: true,
              resultPreview: preview(resultText),
            },
          ])
          openLaunches.delete(callId)
          // 只补记终态行（无副作用发生，无需 started 守护行）。补记失败即 fatal：
          // 默默容忍会让新 run 账本缺失该 action 终态——下次 resume 无法复用，
          // 可能重执行副作用。账本不可写 = 不可安全记账 = 不可继续。
          const effectiveReplayedIdempotent = payload.idempotent ?? (replayed.entry.idempotent === true)
          try {
            await recordAction({
              type: 'action',
              index,
              key,
              ok: true,
              result: redactPlainValue(replayed.entry.result, redactText),
              ...(effectiveReplayedIdempotent ? { idempotent: true } : {}),
            })
          } catch (error) {
            const message =
              error instanceof JournalWriteError
                ? error.message
                : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
            respond(
              callId,
              false,
              undefined,
              `workflow journal replay bookkeeping failed; aborting to keep the run resumable: ${message}`,
              true,
            )
            return
          }
          replay.consumeAction(replayed.entry)
          respond(callId, true, replayed.entry.result ?? null)
          return
        }

        // 未命中缓存：必须等待并发许可后 live 执行（缓存命中不占 semaphore）
        for (;;) {
          await actionPauseGate()
          await semaphore.acquire()
          if (aborted || settled) {
            semaphore.release()
            openLaunches.delete(callId)
            respond(callId, false, undefined, 'Workflow aborted.', true)
            return
          }
          if (isPaused() && !aborted && !settled) {
            semaphore.release()
            continue
          }
          break
        }

        try {
          if (aborted || settled) {
            openLaunches.delete(callId)
            respond(callId, false, undefined, 'Workflow aborted.', true)
            return
          }

          // Pre-flight 预检
          let prepared: { pluginId: string; actionId: string; idempotent?: boolean } | undefined
          if (host.prepareAction !== undefined) {
            try {
              prepared = await host.prepareAction(payload.actionId, payload.input ?? {}, {
                index,
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
              })
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error)
              try {
                await recordAction({
                  type: 'action',
                  index,
                  key,
                  ok: false,
                  idempotent: true,
                  error: redactText(errMsg),
                })
              } catch (jErr) {
                const message =
                  jErr instanceof JournalWriteError
                    ? jErr.message
                    : `workflow journal append failed: ${jErr instanceof Error ? jErr.message : String(jErr)}`
                openLaunches.delete(callId)
                respond(callId, false, undefined, `workflow_action_uncertain: ${message}`, true)
                return
              }
              const finishedAt = Date.now()
              emit([
                {
                  ...base,
                  startedAt: queuedAt,
                  lastProgressAt: finishedAt,
                  durationMs: finishedAt - queuedAt,
                  state: 'error',
                  error: errMsg,
                },
              ])
              openLaunches.delete(callId)
              respond(callId, true, null)
              return
            }
          }

          if (aborted || settled) {
            openLaunches.delete(callId)
            respond(callId, false, undefined, 'Workflow aborted.', true)
            return
          }

          const effectiveIdempotent = payload.idempotent ?? (prepared?.idempotent === true)

          // 许可取得并完成 preflight 后才记 startedAt 与落 started 意图行
          const startedAt = Date.now()
          try {
            await recordAction({
              type: 'action_started',
              index,
              key,
              ...(effectiveIdempotent ? { idempotent: true } : {}),
            })
          } catch (error) {
            const message =
              error instanceof JournalWriteError
                ? error.message
                : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
            openLaunches.delete(callId)
            respond(callId, false, undefined, `workflow_action_uncertain: ${message}`, true)
            return
          }

          if (aborted || settled) return
          emit([{ ...base, startedAt, lastProgressAt: startedAt }])

          let outcome: { ok: true; result: unknown } | { ok: false; error: string }
          try {
            const invoked = await host.invokeAction(payload.actionId, payload.input ?? {}, {
              index,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            })
            assertBoundarySafe(invoked.result, `action('${payload.actionId}') result`)
            outcome = { ok: true, result: invoked.result }
          } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
          } finally {
            openLaunches.delete(callId)
          }

          const finishedAt = Date.now()
          // 终态行落盘（fsync）之后才 respond；写失败 = 已执行但无法记账，显式不确定。
          try {
            await recordAction(
              outcome.ok
                ? {
                    type: 'action',
                    index,
                    key,
                    ok: true,
                    result: redactPlainValue(outcome.result, redactText),
                    ...(effectiveIdempotent ? { idempotent: true } : {}),
                  }
                : {
                    type: 'action',
                    index,
                    key,
                    ok: false,
                    error: redactText(outcome.error),
                    ...(effectiveIdempotent ? { idempotent: true } : {}),
                  },
            )
          } catch (error) {
            const message =
              error instanceof JournalWriteError
                ? error.message
                : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
            respond(
              callId,
              false,
              undefined,
              outcome.ok
                ? `workflow_action_uncertain: action executed but its outcome could not be journaled (${message}). The side effect may have happened; do not re-run blindly.`
                : `workflow_action_uncertain: action failed and the failure could not be journaled (${message}).`,
              true,
            )
            return
          }

          if (outcome.ok) {
            const resultText = JSON.stringify(outcome.result)
            emit([
              {
                ...base,
                startedAt,
                lastProgressAt: finishedAt,
                durationMs: finishedAt - startedAt,
                state: 'done',
                resultPreview: preview(resultText),
              },
            ])
            respond(callId, true, outcome.result)
            return
          }
          emit([
            {
              ...base,
              startedAt,
              lastProgressAt: finishedAt,
              durationMs: finishedAt - startedAt,
              state: 'error',
              error: outcome.error,
            },
          ])
          // 失败照 agent 语义折叠为 null（pipeline/parallel 吞错为 null）。
          respond(callId, true, null)
        } finally {
          semaphore.release()
        }
      } catch (unhandledError) {
        openLaunches.delete(callId)
        respond(
          callId,
          false,
          undefined,
          `Action execution unexpected error: ${unhandledError instanceof Error ? unhandledError.message : String(unhandledError)}`,
          true,
        )
      }
    }

    async function handleLoadWorkflow(callId: number, ref: WorkflowScriptRef): Promise<void> {
      const loadWorkflow = host.loadWorkflow?.bind(host)
      if (loadWorkflow === undefined) {
        respond(callId, false, undefined, 'This workflow host cannot run nested workflows.', true)
        return
      }
      let source: WorkflowScriptSource
      try {
        source = await loadWorkflow(ref)
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
        return
      }
      if (!source.ok) {
        respond(callId, false, undefined, source.message)
        return
      }
      try {
        const child = validateScript(source.script)
        respond(callId, true, {
          name: child.meta.name,
          metaJson: JSON.stringify(child.meta),
          body: child.body,
        })
      } catch (error) {
        respond(callId, false, undefined, error instanceof Error ? error.message : String(error))
      }
    }

    worker.on('message', (message: WorkerMessage) => {
      if (settled) return
      try {
      switch (message.type) {
        case 'progress':
          emit(message.entries)
          break
        case 'call':
          if (message.method === 'workflow') {
            void handleLoadWorkflow(message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          if (message.method === 'action') {
            void handleAction(message.callId, message.payload).catch((error: unknown) => {
              finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
            break
          }
          void handleAgent(message.callId, message.payload).catch((error: unknown) => {
            finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
          })
          break
        case 'complete': {
          const unawaited = [...openLaunches.values()]
          if (unawaited.length > 0) {
            finish({ status: 'failed', error: unawaitedLaunchMessage(unawaited) })
            break
          }
          finish({
            status: 'completed',
            ...(message.resultJson === undefined ? {} : { value: JSON.parse(message.resultJson) }),
          })
          break
        }
        case 'error':
          finish({ status: 'failed', error: message.message })
          break
      }
      } catch (outerError) {
        process.stderr.write(
          `WORKER-MSG-THROW: ${outerError instanceof Error ? outerError.stack : String(outerError)}\n`,
        )
        finish({
          status: 'failed',
          error: outerError instanceof Error ? outerError.message : String(outerError),
        })
      }
    })

    worker.on('error', (error) => {
      finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    })

    worker.on('exit', () => {
      finish({ status: 'failed', error: 'Workflow worker exited before completing.' })
    })
  })
}
