/**
 * runtime.ts — 工作流 run 的宿主半边。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植，helm 适配点：
 * - 新增 `action()` 原语的宿主侧处理：与 agent 共享同一全序前缀账本（index 按
 *   调用发起顺序分配）；`action_started` 追加+fsync 成功后才执行 handler，
 *   终态行落盘后才 resolve 调用 promise；任一写失败即 fatal（不可在无法记账
 *   的状态下继续执行副作用）。恢复时 started 无终态由上层显式报
 *   `workflow_action_uncertain`，绝不自动重跑。
 * - spawn 接缝面向 helm `WorkflowServiceHost`（agent_spawn 钩子管道的注入式
 *   适配在 service.ts），runtime 本体保持零内核依赖、可独立测试。
 * - worker 线程 + vm 双层边界：terminate 可杀死循环脚本；vm 禁动态代码生成与
 *   非确定 API（见 worker-source.ts）。这是可终止/确定性边界，不是恶意代码
 *   安全沙箱。
 */

import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import {
  actionJournalKey,
  agentJournalKey,
  type AgentJournalKeyInput,
  JournalWriteError,
} from './journal.js'
import { type CompiledSchema, compileJsonSchema } from './json-schema.js'
import { extractMeta, type WorkflowMeta } from './meta.js'
import type { WorkflowActionEntry, WorkflowAgentEntry, WorkflowEntry } from './progress.js'
import { WORKER_SOURCE } from './worker-source.js'

/** 脚本长度上限（512KB）。 */
export const MAX_SCRIPT_LENGTH = 524_288

/** 单个 run 允许调度的 agent 总数上限。 */
export const WORKFLOW_AGENT_CAP = 1000

/** 单次 parallel()/pipeline() 的 item 数上限。 */
export const WORKFLOW_ITEM_CAP = 4096

/** 嵌套 workflow() 调用总数上限。 */
export const WORKFLOW_NESTED_CAP = 256

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
  /** run 内调用位次（agent 与 action 共享同一全序），进度条目的稳定身份。 */
  index: number
  prompt: string
  label: string
  agentType: string
  model?: string
  effort?: string
  isolation?: 'worktree'
  /** 宿主在子会话创建后回报（会话 id / 实际模型等），进度行就地更新。 */
  onResolved?(info: {
    conversationId?: number
    modelName?: string
    modelId?: string
    thinking?: string
    requestedThinking?: string
    requestedModel?: string
  }): void
  /** 由脚本 agent({ schema }) 编译出的结构化输出契约。 */
  schema?: CompiledSchema
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
}

/** gate 命令结果；output 是失败时展示给用户的输出。 */
export interface WorkflowGateResult {
  ok: boolean
  output: string
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
    onResolved?: WorkflowSpawnRequest['onResolved'],
  ): Promise<WorkflowSpawnResult>
  /**
   * 执行 gate 命令并报告是否通过。cwd 为子会话工作目录（如有）。
   * 缺省宿主让 runtime 显式失败该调用——静默不跑的 gate 等于把未验证工作
   * 标记为已验证。
   */
  runGate?(command: string, options: { agentId: string; cwd?: string }): Promise<WorkflowGateResult>
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

/** run 进行中可施加的控制（暂停/跳过/重试），全部幂等 best-effort。 */
export interface WorkflowControl {
  pause(): void
  resume(): void
  isPaused(): boolean
  skip(index: number): boolean
  retry(index: number): boolean
}

/** 账本追加输入（seq/v 由写入器分配）。 */
export type JournalWriteInput =
  | { type: 'agent'; index: number; key: string; ok: boolean; text?: string; resumed?: true }
  | { type: 'action_started'; index: number; key: string }
  | { type: 'action'; index: number; key: string; ok: boolean; result?: unknown; error?: string }

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
    entries?: readonly import('@helm/protocol').WorkflowJournalEntry[]
    append?(entry: JournalWriteInput): Promise<void> | void
  }
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

interface AgentCallPayload {
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
}

interface ActionCallPayload {
  actionId: string
  input: unknown
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

function derivedLabel(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.trim()
  return line.length <= 60 ? line || 'agent' : `${line.slice(0, 59)}…`
}

/** resume 可复活的子代理，按 label 记忆。 */
interface CompletedChild {
  agentId: string
  label: string
  agentType: string
  model?: string
  isolation?: 'worktree'
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
  runGate: NonNullable<WorkflowHost['runGate']>,
): Promise<WorkflowSpawnResult> {
  const outcome =
    result.gate ??
    (await runGate(command, {
      agentId,
      ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
    }))
  const { gate: _ran, ...kept } = result
  if (outcome.ok) return kept
  const { text: _discarded, ...rest } = kept
  const output = outcome.output.trim()
  return { ...rest, ok: false, error: output === '' ? `Gate command failed: ${command}` : output }
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

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { script, host } = options

  assertBoundarySafe(options.args, 'args')

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
  const journalResumes = journalEntries.some((entry) => entry.type === 'agent' && entry.resumed)
  let prefixIntact = journalEntries.length > 0 && !journalResumes
  let replayedCount = 0

  /** index → 该位次的终态行（agent 或 action；started 行不参与前缀匹配）。 */
  const settledByIndex = new Map<
    number,
    import('@helm/protocol').WorkflowJournalEntry
  >()
  for (const entry of journalEntries) {
    if (entry.type === 'agent' || entry.type === 'action') settledByIndex.set(entry.index, entry)
  }

  /**
   * 该 index 是否命中可复用前缀；失配即断链（此后全部 live）。
   * 类型必须与调用种类一致：agent 槽位撞上 action 行视同失配。
   */
  function replayAt(index: number, key: string, kind: 'agent' | 'action') {
    if (!prefixIntact) return undefined
    const entry = settledByIndex.get(index)
    if (
      entry === undefined ||
      entry.index !== index ||
      entry.key !== key ||
      entry.type !== kind ||
      !entry.ok
    ) {
      prefixIntact = false
      return undefined
    }
    return entry
  }

  /** agent 行记账尽力而为：写失败只计数，不中断 run（resume 优化损失）。 */
  async function recordAgent(entry: Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type'>): Promise<void> {
    if (appendJournal === undefined) return
    try {
      await appendJournal({ ...entry, type: 'agent' })
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
      argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
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
        resolve({ ...result, meta, progress, agentCount, replayedCount })
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
      void runGate
      void resumeAgent

      let resumed: CompletedChild | undefined
      if (payload.resume !== undefined) {
        resumed = completedByLabel.get(payload.resume)
        if (resumed === undefined) {
          const known = [...completedByLabel.keys()]
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

      if (agentCount >= agentCap) {
        respond(callId, false, undefined, `Workflow exceeded its cap of ${agentCap} agents.`, true)
        return
      }
      // 调用位次在发起时分配（agent 与 action 共享全序）；并发完成顺序不参与。
      const index = callIndex++
      agentCount++
      const agentId = resumed?.agentId ?? `wf-agent-${index}`
      const label = payload.label ?? resumed?.label ?? derivedLabel(payload.prompt)
      const agentType = resumed?.agentType ?? payload.agentType ?? 'general-purpose'
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
        ...(model !== undefined ? { model } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
        ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
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
        resume: payload.resume,
        schema: payload.schema !== undefined ? JSON.stringify(payload.schema) : undefined,
      }
      let replayed = replayAt(index, agentJournalKey(keyInput), 'agent')
      if (replayed !== undefined && compiledSchema !== undefined) {
        const recheck = applySchema({ ok: true, text: replayed.type === 'agent' ? replayed.text ?? '' : '' }, compiledSchema)
        if (!recheck.ok) {
          prefixIntact = false
          replayed = undefined
        }
      }
      if (replayed !== undefined && replayed.type === 'agent') {
        replayedCount++
        const replayedText = replayed.text ?? ''
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
        await recordAgent({ index, key: replayed.key, ok: true, text: replayedText })
        respond(callId, true, replayedText)
        return
      }

      const key = agentJournalKey(keyInput)
      const resumeMark = payload.resume !== undefined ? ({ resumed: true } as const) : {}

      const settleSkipped = (extra: Partial<WorkflowAgentEntry>) => {
        void recordAgent({ index, key, ok: false, ...resumeMark })
        emit([{ ...base, queuedAt, ...extra, state: 'error', skipped: true, error: 'Skipped by user.' }])
        respond(callId, true, null)
      }

      const live: LiveAgent = { agentId, started: false }
      liveAgents.set(index, live)
      const intent = (): LiveAgent['intent'] => live.intent
      let attempt = 1
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

          const attemptMark = attempt > 1 ? { attempt } : {}

          const startedAt = Date.now()
          emit([{ ...base, queuedAt, startedAt, ...attemptMark }])

          const onResolved: NonNullable<WorkflowSpawnRequest['onResolved']> = (info) => {
            if (info.conversationId !== undefined) base.conversationId = info.conversationId
            if (info.modelName !== undefined) base.model = info.modelName
            if (info.thinking !== undefined) base.thinking = info.thinking
            if (info.requestedThinking !== undefined) base.requestedThinking = info.requestedThinking
            if (info.requestedModel !== undefined) base.requestedModel = info.requestedModel
            if (!inflight.has(agentId)) return
            emit([{ ...base, queuedAt, startedAt, ...attemptMark, lastProgressAt: Date.now() }])
          }
          live.started = true
          inflight.add(agentId)

          let result: WorkflowSpawnResult
          try {
            result =
              resumed !== undefined && resumeAgent !== undefined
                ? await resumeAgent(resumed.agentId, payload.prompt!, onResolved)
                : await host.spawnAgent({
                    agentId,
                    index,
                    prompt: payload.prompt!,
                    label,
                    agentType,
                    ...(model !== undefined ? { model } : {}),
                    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
                    ...(compiledSchema !== undefined ? { schema: compiledSchema } : {}),
                    ...(isolation !== undefined ? { isolation } : {}),
                    ...(payload.phaseIndex !== undefined ? { phaseIndex: payload.phaseIndex } : {}),
                    ...(payload.phaseTitle !== undefined ? { phaseTitle: payload.phaseTitle } : {}),
                    ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
                    onResolved,
                  })
            if (result.ok) {
              completedByLabel.set(label, {
                agentId,
                label,
                agentType,
                ...(model !== undefined ? { model } : {}),
                ...(isolation !== undefined ? { isolation } : {}),
              })
              if (compiledSchema !== undefined && result.ok) {
                result = applySchema(result, compiledSchema)
              }
              if (result.ok && payload.gate !== undefined && runGate !== undefined) {
                result = await applyGate(result, payload.gate, agentId, runGate)
              }
            }
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) }
          } finally {
            inflight.delete(agentId)
            live.started = false
            semaphore.release()
          }

          if (settled) return

          if (intent() === 'retry' && !aborted) {
            live.intent = undefined
            attempt++
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
            await recordAgent({ index, key, ok: true, text, ...resumeMark })
            respond(callId, true, text)
            return
          }
          await recordAgent({ index, key, ok: false, ...resumeMark })
          emit([
            {
              ...common,
              state: 'error',
              error: result.error ?? 'Agent failed.',
              ...(result.skipped ? { skipped: true } : {}),
            },
          ])
          respond(callId, true, null)
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
      const index = callIndex++
      openLaunches.set(callId, payload.actionId)
      const queuedAt = Date.now()

      const base: WorkflowActionEntry = {
        type: 'workflow_action',
        index,
        actionId: payload.actionId,
        state: 'start',
        queuedAt,
      }
      emit([{ ...base }])

      let serializedInput: string
      try {
        assertBoundarySafe(payload.input, `action('${payload.actionId}') input`)
        serializedInput = JSON.stringify(payload.input ?? {})
      } catch (error) {
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

      const replayed = replayAt(index, key, 'action')
      if (replayed !== undefined && replayed.type === 'action') {
        replayedCount++
        const at = Date.now()
        const resultText = JSON.stringify(replayed.result ?? null)
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
        // 只补记终态行（无副作用发生，无需 started 守护行）。
        try {
          await appendJournal?.({ type: 'action', index, key, ok: true, result: replayed.result })
        } catch {
          // 重放补记失败无副作用风险；按 agent 行语义容忍。
        }
        respond(callId, true, replayed.result ?? null)
        return
      }

      // 执行前落 started 意图行；append 抛错（含 fsync 失败）即 fatal。
      try {
        await appendJournal?.({ type: 'action_started', index, key })
      } catch (error) {
        const message =
          error instanceof JournalWriteError
            ? error.message
            : `workflow journal append failed: ${error instanceof Error ? error.message : String(error)}`
        respond(callId, false, undefined, `workflow_action_uncertain: ${message}`, true)
        return
      }

      const startedAt = Date.now()
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
      }

      const finishedAt = Date.now()
      // 终态行落盘（fsync）之后才 respond；写失败 = 已执行但无法记账，显式不确定。
      try {
        await appendJournal?.(
          outcome.ok
            ? { type: 'action', index, key, ok: true, result: outcome.result }
            : { type: 'action', index, key, ok: false, error: outcome.error },
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
            void handleLoadWorkflow(message.callId, message.payload)
            break
          }
          if (message.method === 'action') {
            void handleAction(message.callId, message.payload)
            break
          }
          void handleAgent(message.callId, message.payload)
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
