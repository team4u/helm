/**
 * runtime-types.ts — 工作流 runtime 的类型契约（纯类型，零运行时代码）。
 *
 * 自 runtime.ts 拆出（行为零变化）：公共接缝类型（WorkflowHost /
 * WorkflowControl / RunWorkflowOptions 等）与 runtime 内部消息面类型
 * （worker → host 调用载荷、resume 登记形状）。runtime.ts 原样 re-export
 * 公共类型，既有导入路径（runtime.js / index.js）与形状完全不变。
 *
 * 拆分动机：handler / control / recorder 等内部模块共享这些形状，
 * 集中在单一类型模块可让它们互不依赖、只依赖 journal/replay/progress
 * 等底层模块，保持 engine 内部依赖无环。
 */

import type { AgentExecutionInfo, AgentGateResult } from '@helm/protocol'
import type { CompiledSchema } from './json-schema.js'
import type { WorkflowMeta } from './meta.js'
import type { JournalWriteInput, WorkflowJournalEntry } from './journal.js'
import type { WorkflowEntry } from './progress.js'
import type { ReplayScope } from './replay.js'

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

/** 账本追加输入见 journal.ts 的权威定义（旧别名仅为引擎内部引用兼容）。 */
export type JournalAppendInput = JournalWriteInput

export type ActionJournalInput =
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
    /** Failed source runs get a fresh budget for their terminal failed goals. */
    retryFailedCalls?: boolean
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
 * worker → host 消息面（载荷来自不可信的 worker 线程，边界处二次校验）
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

/** worker 消息载荷与 host 侧分发共享（runtime.ts 消息面）；载荷不可信，边界处二次校验。 */
export type { AgentCallPayload, ActionCallPayload, WorkerMessage }

/** resume 可复活的子代理，按 scopedResumeKey 键记忆。 */
export interface CompletedChild {
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
