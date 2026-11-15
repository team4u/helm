/**
 * service.ts — WorkflowService：工作流引擎对内核/HTTP 层的唯一出口（facade）。
 *
 * 内部职责按模块拆分（均在同目录）：
 * - library-store.ts：已保存工作流文件库（<dataDir>/workflows/<name>.js 的
 *   CRUD、路径解析与 symlink 防逃逸、meta 摘要）；
 * - run-store.ts：run 记录与 run 索引持久层（RunRecord/RunIndexEntry 原子
 *   读写、形状校验、接管标记甄别）与 summary 派生 / 脱敏 / progress 折叠；
 * - cancellation-tracker.ts：取消窗口（引用计数）与子树边界取消；
 * - host-adapter.ts：引擎 WorkflowHost ↔ WorkflowServiceHost 适配
 *   （spawnAgent/abortAgent/invokeAction/内建 env.exec/runGate）；
 * - active-run.ts：在途 run 的内存运行态（ActiveRun）与节流常量。
 *
 * 本文件保留服务的编排与生命周期：请求校验（name/script/scriptPath 恰一、
 * 512KB 上限、caps 正数）；run 生命周期（后台启动立即返回 summary、
 * wait/abort 级联、resume 重放与接管保留）；startBackgroundAgent（受信后台
 * 单子代理，不拼 DSL 脚本）；启动恢复（prepareRecovery/init 的 interrupted
 * 标记与通知 outbox 补发）。持久化格式、错误码与行为契约不变。
 *
 * 引擎本体（runtime.ts）零内核依赖；本文件是唯一 import kernel 侧类型的适配层。
 */

import { mkdirSync } from 'node:fs'
import {
  HelmError,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
} from '@helm/protocol'
import { redactJsonValue } from '@helm/protocol'
import {
  agentGateResultMissingError as gateResultMissingError,
  sanitizeAgentExecutionInfo as sanitizeExecutionInfo,
  sanitizeAgentGateResult as sanitizeGateResult,
} from '@helm/protocol'
import {
  extractWorkflowExecutionMeta,
  withWorkflowSpawnMeta,
  type SavedWorkflowDetail,
  type SavedWorkflowSummary,
  type WorkflowDeleteResult,
  type WorkflowNodeState,
  type WorkflowRunRequest,
  type WorkflowRunSummary,
  type WorkflowSaveRequest,
  type WorkflowSaveResult,
} from '../../contracts.js'
import {
  JournalWriter,
  readJournal,
  redactJournalEntry,
  type WorkflowJournalEntry,
} from './journal.js'
import {
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  runWorkflow,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from './runtime.js'
import {
  NODE_EVENT_INTERVAL_MS,
  PROGRESS_PERSIST_INTERVAL_MS,
  type ActiveRun,
} from './active-run.js'
import { CancellationTracker } from './cancellation-tracker.js'
import {
  abortChildConversation as abortChildViaHost,
  createEngineHost,
  invokeAgentSpawn,
  type EngineHostDeps,
  type WorkflowServiceHost,
} from './host-adapter.js'
import { WorkflowLibrary } from './library-store.js'
import {
  RunStore,
  backgroundChildIds,
  errorMessage,
  isBackgroundRecord,
  isNonRetryableWorkflowError,
  newRunId,
  type RunRecord,
  type WorkflowStateStore,
} from './run-store.js'

export {
  BUILTIN_ENV_EXEC_PLUGIN,
  BUILTIN_ENV_EXEC_ACTION,
  type ValidatedEnvExecInput,
  type WorkflowServiceHost,
} from './host-adapter.js'
export type { WorkflowStateStore } from './run-store.js'

export interface WorkflowAutoResumeCandidate {
  runId: string
  conversationId: number
  failedAt: number
  autoResumeCount: number
}

export interface WorkflowServiceOptions {
  dataDir: string
  host: WorkflowServiceHost
  /** run 索引与 summary 的 SQLite doc store（主 app 注入 KernelRuntime.documentStore）。 */
  state: WorkflowStateStore
  concurrency?: number
  agentCap?: number
  itemCap?: number
  nestedCap?: number
  /**
   * 持久面值级脱敏钩子（主 app 注入 kernel.stash.redact）：所有即将写入
   * state/journal 的字符串值（args/result/error/进度预览）先经此替换。值级
   * 递归，不做 stringify 后整体替换。运行时执行始终用原始脚本与值，持久版本
   * 脱敏后不可逆——重放取回的是脱敏值，秘密必须经 env / action 输入 marker
   * 传递，不得依赖 resume 还原 secret 原文。
   */
  redact?: (text: string) => string
}

export class WorkflowService {
  private readonly host: WorkflowServiceHost
  private readonly state: WorkflowStateStore
  private readonly caps: Pick<WorkflowServiceOptions, 'concurrency' | 'agentCap' | 'itemCap' | 'nestedCap'>
  private readonly redact: (text: string) => string
  private readonly runs: RunStore
  private readonly library: WorkflowLibrary
  private readonly cancellation: CancellationTracker
  private readonly active = new Map<string, ActiveRun>()
  /**
   * 进程内接管保留（防并发双接管）：resume 已在旧 record 落接管标记、新 run
   * 快照尚未落盘的窗口内，新 runId 在索引与磁盘上均无痕迹——幽灵检测会误
   * 判可重接管。保留集合在此窗口内占位（检测时保持 409）；快照落盘或启动
   * 失败即释放，不放宽到整个活跃期。
   */
  private readonly takeoverReservations = new Set<string>()
  private closed = false
  /** init 幂等标记：仅恢复完整成功后置位；失败可重试。 */
  private recovered = false
  private recoveryPrepared = false
  private initPromise?: Promise<void>

  constructor(options: WorkflowServiceOptions) {
    this.host = options.host
    this.state = options.state
    const capError = (field: string, value: number): HelmError =>
      new HelmError(
        'validation_error',
        `工作流 ${field} 必须是正整数（收到 ${value}；零或负值会让 run 在首个调度点死锁）`,
        400,
        { field, value },
      )
    const positiveOrThrow = (field: string, value: number | undefined): number | undefined => {
      if (value === undefined) return undefined
      if (!Number.isInteger(value) || value < 1) throw capError(field, value)
      return value
    }
    const concurrency = positiveOrThrow('concurrency', options.concurrency)
    const agentCap = positiveOrThrow('agentCap', options.agentCap)
    const itemCap = positiveOrThrow('itemCap', options.itemCap)
    const nestedCap = positiveOrThrow('nestedCap', options.nestedCap)
    this.caps = {
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(agentCap !== undefined ? { agentCap } : {}),
      ...(itemCap !== undefined ? { itemCap } : {}),
      ...(nestedCap !== undefined ? { nestedCap } : {}),
    }
    this.redact = options.redact ?? ((text: string) => text)
    this.runs = new RunStore({ dataDir: options.dataDir, state: options.state, redact: this.redact })
    this.library = new WorkflowLibrary({
      dataDir: options.dataDir,
      loadRunRecord: (runId) => this.runs.load(runId),
    })
    this.cancellation = new CancellationTracker({
      active: this.active,
      parentConversationOf: (id) => this.host.getConversation(id).parentConversationId,
    })
  }

  /**
   * 启动恢复（阶段一：全局服务 prepare 屏障，SDK 调度器仍 paused）：把跨
   * 重启遗留的 running run 的子会话经 host.abortConversationGuarded（paused
   * 相位：只落持久 abort 标记，不唤醒调度器、不等结算）逐个持久取消。
   * 幂等；run() 首次调用前自动执行，也可由宿主显式调用。失败可重试：
   * initPromise 仅在恢复完整成功（含 flush）后保留，异常时清缓存，下一次
   * init()/run() 重新执行。
   */
  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    const index = this.runs.readIndex()
    const childIds = new Set<number>()
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.runs.load(entry.id)
      } catch (error) {
        // 记录缺失（索引残留）：恢复只处理真实存在的记录；索引损坏诊断
        // 留给 listRuns（与 init 同契约，绝不删除索引掩盖）。
        if (error instanceof HelmError && error.code === 'not_found') continue
        throw error
      }
      if (record.status !== 'running' || !isBackgroundRecord(record)) continue
      for (const id of backgroundChildIds(record)) childIds.add(id)
    }
    // 逐会话守卫取消。仅两类确定性可接受失败可诊断后继续：not_found（会话
    // 已删除）/ ownership_conflict（human 接管，红线拒绝——human 绝不 abort）。
    // 其余失败（持久化 I/O、内核内部错误）必须上抛：恢复屏障被阻断，
    // recoveryPrepared 不置位（下次 prepare 重试），绝不带着未落取消标记
    // 启动调度器——“先落取消标记”的屏障优先于“容错继续”。
    for (const id of childIds) {
      try {
        await this.host.abortConversationGuarded(id)
      } catch (error) {
        if (
          error instanceof HelmError &&
          (error.code === 'not_found' || error.code === 'ownership_conflict')
        ) {
          process.stderr.write(
            `workflow prepareRecovery: skip conversation ${id}（${error.code}，确定性跳过不阻断屏障）: ${errorMessage(error)}\n`,
          )
          continue
        }
        throw error
      }
    }
    this.recoveryPrepared = true
  }

  async init(): Promise<void> {
    if (this.recovered) return
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = (async () => {
      try {
        await this.prepareRecovery()
        const index = this.runs.readIndex()
        let changed = false
        // 通知 outbox 补发：崩溃前已达终态但 onBackgroundAgentSettled 未成功（或
        // 未及调用）的记录。回调失败不阻断 init（stderr 诊断，notifiedAt 不置位，
        // 下次 init 重试）。
        const pendingNotifies: Array<() => Promise<void>> = []
        for (const entry of index) {
          let record: RunRecord
          try {
            record = this.runs.load(entry.id)
          } catch (error) {
            // 记录缺失（索引残留）：恢复只处理真实存在的记录；索引损坏诊断
            // 留给 listRuns（与 prepareRecovery 同契约，绝不删除索引掩盖）。
            if (error instanceof HelmError && error.code === 'not_found') continue
            throw error
          }
          if (
            record.notifyParentOnSettle === true &&
            record.status !== 'running' &&
            record.notifiedAt === undefined
          ) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.host.onBackgroundAgentSettled === undefined) return
              await this.host.onBackgroundAgentSettled(this.runs.toSummary(target), {
                parentConversationId: target.conversationId,
                ...(target.subagentMeta ?? {}),
              })
              target.notifiedAt = Date.now()
              this.writeRecord(target)
            })
          }
          if (record.status !== 'running') continue
          if (isBackgroundRecord(record)) {
            // 权威坐标 = 运行期即时持久化的 childConversationIds（合并 subagentMeta/
            // nodes 冗余投影）。全部执行已在 prepareRecovery 持久标记取消；此处仅
            // 等待真实终态，不能先回报 interrupted 却让旧模型回合继续运行。守卫
            // 中止逐个诊断：单个子会话拒绝（human 接管等红线事实）不阻断其余恢复。
            const children = new Set<number>(backgroundChildIds(record))
            await Promise.all([...children].map(async (id) => {
              try {
                await this.host.abortConversationGuarded(id)
              } catch (error) {
                process.stderr.write(
                  `workflow init: guarded abort conversation ${id} failed: ${errorMessage(error)}\n`,
                )
              }
            }))
          }
          record.status = 'failed'
          record.updatedAt = Date.now()
          record.error =
            record.kind === 'subagent'
              ? 'subagent run interrupted by process restart（可凭 conversationId/executionId 通过 resume 续接）'
              : `run interrupted by process restart（账本完好，可经 resumeFromRunId 恢复）：${record.error ?? ''}`.trim()
          if (isBackgroundRecord(record) && record.nodes !== undefined) {
            record.nodes = record.nodes.map((node) => node.status === 'running' || node.status === 'pending'
              ? { ...node, status: 'failed', settledAt: record.updatedAt, error: record.error }
              : node)
          }
          this.writeRecord(record)
          changed = true
          // interrupted 的后台 run（subagent 与后台 workflow）同样须补发通知
          //（通知内容即 failed 终态本身）。
          if (record.notifyParentOnSettle === true && record.notifiedAt === undefined) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.host.onBackgroundAgentSettled === undefined) return
              await this.host.onBackgroundAgentSettled(this.runs.toSummary(target), {
                parentConversationId: target.conversationId,
                ...(target.subagentMeta ?? {}),
              })
              target.notifiedAt = Date.now()
              this.writeRecord(target)
            })
          }
          this.emitEventSafe('workflow.updated', { run: this.runs.toSummary(record) })
        }
        if (changed) await this.state.flush?.()
        this.recovered = true
        // 先置 recovered 再补发：失败重试时上面循环不会重复处理（记录已非 running）。
        for (const notify of pendingNotifies) {
          try {
            await notify()
          } catch (error) {
            process.stderr.write(
              `workflow init: onBackgroundAgentSettled retry failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
        // notifiedAt 落盘失败仅意味着下次 init 可能重发（at-least-once），
        // 不阻断 init：恢复主体已在此前成功提交。
        if (pendingNotifies.length > 0) {
          try {
            await this.state.flush?.()
          } catch (error) {
            process.stderr.write(
              `workflow init: notifiedAt persist failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
      } finally {
        // 失败（flush 抛错等）时清缓存：下一次 init()/run() 重试，不永久贴 failed。
        if (!this.recovered) this.initPromise = undefined
      }
    })()
    return this.initPromise
  }

  // ------------------------------------------------------------------
  // 工作流库：list / get / save / delete（实现位于 library-store）
  // ------------------------------------------------------------------

  /** 列出带 meta 声明的工作流脚本；非法 meta 附 metadataError，文件读取错误显式失败。 */
  list(): SavedWorkflowSummary[] {
    return this.library.list()
  }

  /** 读取已保存工作流的完整定义（只读源码 + 元数据 + 真实文件事实）。 */
  get(name: string): SavedWorkflowDetail {
    return this.library.get(name)
  }

  /** 保存工作流定义（script / fromRunId 恰一；边界校验与原子写入见 library-store.save）。 */
  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    return this.library.save(request)
  }

  /** 删除已保存工作流定义文件（历史 run 记录不受影响；不存在显式 404）。 */
  delete(name: string): WorkflowDeleteResult {
    return this.library.delete(name)
  }

  // ------------------------------------------------------------------
  // run
  // ------------------------------------------------------------------

  /**
   * 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。
   * context 由内核受信注入（工具链真实 callId），不是用户可写输入；
   * 新 run 必须提供 conversationId；resume 未另指定时复用原 run 的会话。
   * @throws HelmError validation_error / not_found / workflow_action_uncertain / journal_read_failed。
   */
  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean },
  ): Promise<WorkflowRunSummary> {
    this.assertNotClosed()
    await this.init()

    // 内部元数据只经受信 context 进入：空串与非字符串一律视为无关联，
    // 绝不允许 HTTP body / DSL 冒充（request 里没有这个字段）。
    const parentToolCallId =
      typeof context?.parentToolCallId === 'string' && context.parentToolCallId !== ''
        ? context.parentToolCallId
        : undefined

    const sources = [request.name, request.script, request.scriptPath].filter((v) => v !== undefined)
    if (sources.length > 1) {
      throw new HelmError(
        'validation_error',
        'name、script、scriptPath 必须恰好提供一个（或 resumeFromRunId 时全部省略沿用旧脚本）',
        400,
        { provided: sources.length },
      )
    }

    // --- resume 目标解析 ---------------------------------------------
    let replayFrom: RunRecord | undefined
    if (request.resumeFromRunId !== undefined) {
      replayFrom = this.runs.load(request.resumeFromRunId)
      if (replayFrom.kind === 'subagent') {
        throw new HelmError('validation_error', '后台子代理运行没有工作流重放脚本；请用 execution.conversationId/executionId 通过 subagent resume 续接', 400, { runId: replayFrom.id })
      }
      if (replayFrom.status === 'running' && !this.active.has(replayFrom.id)) {
        // init() 已把跨重启 running 标 failed；此处 running 只可能是同进程旧状态。
        replayFrom.status = 'failed'
        replayFrom.error = 'run interrupted（账本完好，可经 resumeFromRunId 恢复）'
        this.writeRecord(replayFrom)
        await this.state.flush?.()
      }
      if (this.active.has(replayFrom.id)) {
        throw new HelmError('conflict', `工作流 ${replayFrom.id} 仍在运行中`, 409, { runId: replayFrom.id })
      }
    }

    const conversationId = request.conversationId ?? replayFrom?.conversationId
    if (conversationId === undefined) {
      throw new HelmError(
        'validation_error',
        '缺少工作流目标会话：提供 conversationId，或从 CLI 使用 --current；工具调用会使用当前会话',
        400,
      )
    }
    if (replayFrom !== undefined && request.conversationId !== undefined && request.conversationId !== replayFrom.conversationId) {
      throw new HelmError(
        'validation_error',
        `恢复目标不匹配：工作流 ${replayFrom.id} 属于会话 ${replayFrom.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
        400,
        { runId: replayFrom.id, recordedConversationId: replayFrom.conversationId, requestedConversationId: request.conversationId },
      )
    }

    let parent: ConversationSummary
    try {
      parent = this.host.getConversation(conversationId)
    } catch {
      throw new HelmError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, {
        conversationId,
      })
    }

    // --- 脚本源 ------------------------------------------------------
    let script: string
    let scriptPath: string | undefined
    let savedName: string | undefined

    if (request.script !== undefined) {
      script = request.script
    } else if (request.name !== undefined) {
      savedName = request.name
      scriptPath = this.library.resolveSavedName(request.name)
      script = this.library.readScriptFile(scriptPath)
    } else if (request.scriptPath !== undefined) {
      scriptPath = this.library.resolveExplicitPath(request.scriptPath)
      script = this.library.readScriptFile(scriptPath)
    } else if (replayFrom !== undefined) {
      if (replayFrom.script !== undefined) {
        script = replayFrom.script
      } else if (replayFrom.scriptPath !== undefined) {
        scriptPath = replayFrom.scriptPath
        script = this.library.readScriptFile(scriptPath)
        if (replayFrom.savedName !== undefined) savedName = replayFrom.savedName
      } else {
        throw new HelmError(
          'validation_error',
          `工作流 ${request.resumeFromRunId} 未持久化脚本源，无法 resume；请显式提供 script/scriptPath`,
          400,
          { runId: request.resumeFromRunId },
        )
      }
    } else {
      throw new HelmError('validation_error', '必须提供 name、script 或 scriptPath 之一', 400)
    }

    if (script.length > MAX_SCRIPT_LENGTH) {
      throw new HelmError(
        'validation_error',
        `工作流脚本 ${script.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`,
        400,
        { length: script.length },
      )
    }

    // --- args（resume 沿用原 args；显式提供才覆盖） --------------------
    let args: unknown
    if (request.args !== undefined) {
      args = normalizeWorkflowArgs(request.args)
    } else if (replayFrom?.args !== undefined) {
      args = replayFrom.args
    }

    // --- journal（resume 重放 + 本 run 记账） -------------------------
    const runId = newRunId()
    mkdirSync(this.runs.artifactsDir(conversationId), { recursive: true })
    const journalPath = this.runs.journalPathFor(conversationId, runId)

    let replayEntries: readonly WorkflowJournalEntry[] = []
    /** resume 读旧账本时的損行诊断（计数形态，结算时入 run 诊断面）。 */
    let resumeJournalIoErrors: string[] | undefined
    if (replayFrom !== undefined) {
      const journal = readJournal(replayFrom.journalPath)
      if (journal.readFailed !== undefined) {
        // 权限/I-O 错误：账本状态未知，假扮空账本等于自动重跑全部副作用。
        throw new HelmError(
          'journal_read_failed',
          `工作流 ${replayFrom.id} 的账本不可读（${journal.readFailed.code}），无法安全恢复；请修复文件权限后重试`,
          409,
          { priorRunId: replayFrom.id, journalPath: replayFrom.journalPath, ...journal.readFailed },
        )
      }
      if (journal.actionUncertain) {
        // 悬挂 started / 失败 action / 不可判定损坏行：副作用是否发生不可判定，
        // 显式交人类决策，绝不自动重跑。
        const why = journal.failedActions > 0 ? '存在失败（ok:false）的动作终态行' : '账本存在已开始但未确认完成或无法判定的动作调用'
        throw new HelmError(
          'workflow_action_uncertain',
          `工作流 ${replayFrom.id} 的${why}（failedActions=${journal.failedActions}），无法安全恢复；` +
            '请人工确认该动作副作用后，从其 journal 中移除对应 action 行或放弃 resume',
          409,
          { priorRunId: replayFrom.id, journalPath: replayFrom.journalPath, failedActions: journal.failedActions },
        )
      }
      replayEntries = journal.entries
      // 損行不影响安全重放（已由 actionUncertain 把关），但记入本 run 诊断面：
      // 账本健康度如实可见，绝不静默少重放。运行期 agent 行写失败由引擎经
      // WorkflowRunResult.journalIoErrors 补充，这里只覆盖 resume 时的存量損行。
      if (journal.ioErrors > 0) {
        resumeJournalIoErrors = [
          `journal ${replayFrom.id} has ${journal.ioErrors} corrupt/unreadable line(s) (replayed from ${replayFrom.journalPath})`,
        ]
      }
    }

    // --- resume 接管（§3.2）：账本可安全重放已验证，新 run 建立即标记原 run
    // 被接管（防重复续跑，重复 resume 显式 409），并让新记录继承
    // notifyParentOnSettle、累计 autoResumeCount +1。接管标记先于新 run 快照
    // 落盘：进程死在两写之间只会留下「指向不存在 run 的接管标记」（诊断
    // 可见），不会出现双 run 同时可续跑。
    /**
     * 接管保留释放（幂等）：新 run 快照落盘（磁盘成为接管事实的权威）或
     * 启动失败（标记是否幽灵交由磁盘事实判定）时调用。
     */
    let releaseTakeoverReservation: () => void = () => {}
    if (replayFrom !== undefined) {
      // 并发接管串行化（同步临界段）：终检用现读记录——本 run 入口 loadRecord
      // 后已经过 init()/flush 等 await 点，并发 resume 可能已抢先落标记；从
      // 现读检查到标记写入之间无 await（单线程事件循环），后到者必然读到先
      // 到者的标记并 409，不可能双双接管。
      const currentMarker = this.runs.load(replayFrom.id).resumedByRunId
      if (currentMarker !== undefined) {
        // 幽灵标记甄别：索引 not_found 不等于新 run 从未存在——接管 run 可能
        // 已写记录/账本后索引才丢失。只有进程内保留、活跃表、索引与磁盘
        // （同会话的记录与账本文件）四面都无痕迹才确证可重接管；仍有痕迹
        // （即使索引缺失）保持 409 诊断，防对已产生副作用的 run 重复续跑。
        // 接管记录损坏如实上抛。
        const takeover = this.runs.inspectTakeoverMarker(currentMarker, replayFrom.conversationId, {
          reserved: this.takeoverReservations.has(currentMarker),
          active: this.active.has(currentMarker),
        })
        if (!takeover.ghost) {
          throw new HelmError(
            'conflict',
            `工作流 ${replayFrom.id} 已被运行 ${currentMarker} 接管续跑（${takeover.reason}）；请从接管的 run 继续或人工核查`,
            409,
            { runId: replayFrom.id, resumedByRunId: currentMarker },
          )
        }
        process.stderr.write(
          `workflow resume: clearing orphaned takeover marker ${currentMarker} on ${replayFrom.id}（索引与磁盘均无接管痕迹，确证从未写记录/账本）\n`,
        )
        replayFrom.resumedByRunId = undefined
      }
      // 接管保留（防并发双接管）：从旧 record 标记落盘到新 run 快照落盘之间
      // 存在 await 窗口（flush 等），此间的幽灵检测在索引与磁盘上都看不到新
      // run——保留集合先占位，检测一律按「接管仍存在」409；绝不放宽整个
      // 活跃期，快照落盘或启动失败即释放。
      this.takeoverReservations.add(runId)
      let reservationHeld = true
      releaseTakeoverReservation = (): void => {
        if (reservationHeld) {
          reservationHeld = false
          this.takeoverReservations.delete(runId)
        }
      }
      try {
        replayFrom.resumedByRunId = runId
        replayFrom.updatedAt = Date.now()
        this.writeRecord(replayFrom)
        await this.state.flush?.()
      } catch (error) {
        releaseTakeoverReservation()
        throw error
      }
    }

    const abort = new AbortController()
    const createdAt = Date.now()
    const meta = this.library.peekMeta(script)

    const record: RunRecord = {
      id: runId,
      name: meta?.name ?? scriptPath ?? runId,
      conversationId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      status: 'running',
      createdAt,
      updatedAt: createdAt,
      kind: 'workflow',
      // 后台启动（工具 background）：结算后向父会话投递通知并参与重启恢复
      // 的守卫中止（isBackgroundRecord）；同步 run 不置位、不通知。resume 新
      // run 继承原记录的后台标记（自动续跑保持父会话通知链路）。
      ...(context?.notifyParentOnSettle === true || replayFrom?.notifyParentOnSettle === true
        ? { notifyParentOnSettle: true }
        : {}),
      ...(replayFrom !== undefined ? { autoResumeCount: (replayFrom.autoResumeCount ?? 0) + 1 } : {}),
      ...(meta?.description !== undefined ? { description: this.redact(meta.description) } : {}),
      ...(meta?.phases !== undefined
        ? { phases: redactJsonValue(meta.phases, this.redact) as RunRecord['phases'] }
        : {}),
      ...(scriptPath === undefined ? { script } : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
      ...(args !== undefined ? { args: redactJsonValue(args, this.redact) } : {}),
      journalPath,
      ...(replayFrom !== undefined ? { replayedFrom: replayFrom.id } : {}),
    }

    // done 自注册进 active 起即为真实终点（deferred gate，由下方结算链 resolve）：
    // 占位 Promise.resolve 会让「注册 → running 快照 flush → 结算链启动」之间
    // 的 await 窗口内并发 wait()/abort() 立即假返回，违背「返回时 run 已终态」
    // 契约（与 startBackgroundAgent 的 doneGate 同构）。
    let resolveRunDone: () => void = () => {}
    const doneGate = new Promise<void>((resolve) => {
      resolveRunDone = resolve
    })
    const run: ActiveRun = {
      runId,
      conversationId,
      abort,
      record,
      done: doneGate,
      summary: this.runs.toSummary(record),
      journalPath,
      writer: new JournalWriter(journalPath),
      progress: [],
      timeline: [],
      pendingAborts: new Set(),
      pendingExecs: new Set(),
      childConversations: new Set(),
      lastPersistAt: createdAt,
      lastNodeEventAt: createdAt,
    }
    // 停机屏障复查：入口检查后已经过 init() 与 resume 分支的 flush 等多个 await
    // 点，close() 只快照当下 active 集合——漏检会让 run 越过屏障继续派生子会话。
    // 本行到 active.set 之间无 await（单线程事件循环），此后 close 必然拍到本 run。
    // 同款复查取消窗口：经过脚本读取/账本重放等 await 后，目标会话可能已进入
    // 级联取消边界——在此拒绝，不留越过标记的漏网 run。拒绝时释放接管保留
    // （新 run 未落任何快照，标记交由磁盘事实判定）。
    try {
      this.assertNotClosed()
      this.cancellation.assertNotCancelling(conversationId)
    } catch (error) {
      releaseTakeoverReservation()
      throw error
    }
    this.active.set(runId, run)

    /**
     * run 收尾（唯一出口）：失败终态统一写入 record（内存 summary 只是镜像），
     * writer 必关、active 必删、在途子会话中止必等待、宿主 onRunSettled 必
     * 等待结束——任何一步失败都不留假 running。后台 promise 的 rejection
     * 被 done 吸收并由 record.error 如实上报，绝不 unhandled。
     */
    const settleRun = async (result: WorkflowRunResult | undefined, failure?: unknown): Promise<void> => {
      let settleFailure: unknown
      try {
        // 收尾前必须摘除 trailing timer：终态事件即将发布，窗口内补发会造成乱序。
        if (run.pendingEventTimer !== undefined) {
          clearTimeout(run.pendingEventTimer)
          run.pendingEventTimer = undefined
        }
        if (result !== undefined) {
          record.status = result.status === 'killed' ? 'aborted' : result.status
          if (result.error !== undefined) record.error = this.redact(result.error)
          if (result.value !== undefined) record.result = redactJsonValue(result.value, this.redact)
        } else {
          // runWorkflow 本身失败（坏 meta/语法/worker 启动异常/state 写失败续）。
          record.status = 'failed'
          const message = failure instanceof Error ? failure.message : failure !== undefined ? String(failure) : 'unknown workflow failure'
          record.error = this.redact(message)
        }
        // 账本记账失败诊断（保守面：run 不中断，但绝不隐瞒）。
        // 三路来源合一：引擎 agent 行写失败（result 携带）+ resume 旧账本損行 +
        // writer 层 agent 行写失败计数；脱敏后 stderr 可见 + 入 record 诊断面。
        const journalIoErrors = [
          ...(result?.journalIoErrors ?? []),
          ...(resumeJournalIoErrors ?? []),
          ...(run.writer.agentIoErrors > 0
            ? [`${run.writer.agentIoErrors} journal agent-line append(s) failed (journal: ${journalPath})`]
            : []),
        ]
        if (journalIoErrors.length > 0) {
          const redacted = journalIoErrors.map((message) => this.redact(message))
          // stderr 是宿主侧日志的最低保障可见面（与 persist/onRunSettled 失败同手法）。
          for (const message of redacted) {
            process.stderr.write(`workflow ${runId}: journal io error: ${message}\n`)
          }
          record.journalIoErrors = redacted
        }
        record.updatedAt = Date.now()
        // 只跟踪内建执行通道，不等待任意插件；取消后必须确认命令已退出，不能超时后假装完成清理。
        run.abort.abort()
        await Promise.allSettled([...run.pendingExecs])
        record.nodes = this.runs.redactNodes(this.runs.nodesFromProgress(run.progress))
        record.progress = run.timeline
        run.summary = this.runs.toSummary(record)
        try {
          this.writeRecord(record)
          await this.state.flush?.()
        } catch (persistError) {
          // 持久化失败必须如实浮出（吞掉 = 下次读回假 running），但仍先完成清理。
          const persistMessage = persistError instanceof Error ? persistError.message : String(persistError)
          process.stderr.write(`workflow ${runId}: terminal state persist failed: ${persistMessage}\n`)
          run.summary = {
            ...run.summary,
            status: record.status,
            error: `${record.error ?? ''}\n[persist failed: ${persistMessage}]`.trim(),
          }
          run.settleError = persistError
        }
      } catch (settleError) {
        settleFailure = settleError
      } finally {
        try {
          await run.writer.close()
        } catch (closeError) {
          process.stderr.write(
            `workflow ${runId}: journal close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
          )
        }
        // close 失败/持久化失败同样必须取消命令并等待执行通道和子会话中止结束。
        run.abort.abort()
        await Promise.allSettled([...run.pendingExecs])
        this.active.delete(runId)
        if (run.pendingAborts.size > 0) {
          await Promise.allSettled([...run.pendingAborts])
        }
        // 宿主结算通知：每 run 恰一次；wait/close 经 done 等待它结束。
        if (this.host.onRunSettled !== undefined) {
          try {
            await this.host.onRunSettled({ ...run.summary })
          } catch (settledError) {
            // 结算清理失败显式进入诊断与 settleError，不破坏已落盘终态。
            const message = settledError instanceof Error ? settledError.message : String(settledError)
            process.stderr.write(`workflow ${runId}: onRunSettled failed: ${message}\n`)
            run.summary = {
              ...run.summary,
              error: `${run.summary.error ?? ''}\n[onRunSettled failed: ${message}]`.trim(),
            }
            record.error = `${record.error ?? ''}\n[onRunSettled failed: ${message}]`.trim()
            try {
              this.writeRecord(record)
              const flushed = this.state.flush?.()
              if (flushed !== undefined) void flushed.catch(() => {})
            } catch {
              // 诊断补写尽力而为；settleError 已携带原始异常。
            }
            run.settleError = run.settleError ?? settledError
          }
        }
        // 后台启动的 workflow run（notifyParentOnSettle）：终态落盘后向父会话
        // 投递结算通知——与 startBackgroundAgent 同款 outbox 语义（恰一次，
        // notifiedAt 防重复；失败/关停窗口不置位，init() 下次启动补发）。
        if (
          !this.closed &&
          record.notifyParentOnSettle === true &&
          record.notifiedAt === undefined &&
          this.host.onBackgroundAgentSettled !== undefined
        ) {
          try {
            await this.host.onBackgroundAgentSettled({ ...run.summary }, {
              parentConversationId: conversationId,
            })
            record.notifiedAt = Date.now()
            this.writeRecord(record)
            await this.state.flush?.()
          } catch (notifyError) {
            const message = notifyError instanceof Error ? notifyError.message : String(notifyError)
            process.stderr.write(`workflow ${runId}: onBackgroundAgentSettled failed: ${message}\n`)
          }
        }
        this.emitEventSafe('workflow.updated', { run: { ...run.summary } })
        if (settleFailure !== undefined && run.settleError === undefined) {
          run.settleError = settleFailure
        }
      }
    }

    // 先落 running 快照（state store）：进程若死于此 run，重启后 init() 显式发现并标 failed。
    try {
      this.writeRecord(record)
      // 快照已原子落盘：接管事实以磁盘为权威（幽灵检测必见文件），进程内
      // 保留即可释放（幂等；flush 失败时文件仍在，同样不再需要保留）。
      releaseTakeoverReservation()
      await this.state.flush?.()
    } catch (error) {
      // running 快照都没能落库：不启动执行，不留任何 active/writer。
      // 快照未落盘时释放接管保留——此时标记是否幽灵交由磁盘事实判定
      // （无任何文件 = 真幽灵可重接管；写一半失败原子回滚不留文件）。
      releaseTakeoverReservation()
      // close() 快照可能已拍到本 run：gate 必须给终点，否则 close 永久挂起。
      await run.writer.close().catch(() => {})
      this.active.delete(runId)
      resolveRunDone()
      throw error
    }
    this.emitEventSafe('workflow.updated', { run: this.runs.redactSummaryNodes({ ...run.summary }) })

    const engineHost = this.makeEngineHost(run, parent)

    // 真实结算链：结束后 resolve doneGate（wait/abort/close 自 active.set 起
    // 等待的都是同一个 gate，再无占位窗口）。
    void (async () => {
      let result: WorkflowRunResult | undefined
      let failure: unknown
      try {
        result = await runWorkflow({
          script,
          ...(args !== undefined ? { args } : {}),
          host: engineHost,
          signal: abort.signal,
          ...this.caps,
          ...(this.redact !== undefined ? { redact: this.redact } : {}),
          onProgress: (entries) => {
            run.progress.push(...entries)
            const stamp = Date.now()
            for (const entry of entries) {
              if (entry.type === 'workflow_phase') {
                run.timeline.push({ at: stamp, kind: 'phase', index: entry.index, title: entry.title })
              } else if (entry.type === 'workflow_log') {
                run.timeline.push({ at: stamp, kind: 'log', message: entry.message })
              }
            }
            run.summary.updatedAt = stamp
            if (run.timeline.length > 0) run.summary.progress = [...run.timeline]

            // 立即推送判定：phase/log 必须零延迟；onResolved 回传元数据（会话/
            // 执行标识/worktree/gate）必须零延迟；节点边界在 250ms 窗口外强制。
            const hasPhaseOrLog = entries.some(
              (entry) => entry.type === 'workflow_phase' || entry.type === 'workflow_log',
            )
            const hasResolvedOrGate = entries.some(
              (entry) =>
                entry.type === 'workflow_agent' &&
                (entry.conversationId !== undefined ||
                  entry.executionId !== undefined ||
                  entry.worktree !== undefined ||
                  entry.gate !== undefined),
            )
            const nodeBoundary = entries.some(
              (entry) =>
                (entry.type === 'workflow_agent' || entry.type === 'workflow_action') &&
                (entry.state === 'start' || entry.state === 'done' || entry.state === 'error'),
            )
            const due = stamp - run.lastNodeEventAt >= NODE_EVENT_INTERVAL_MS

            // 周期性把时间线落库：长时间 run 的 phase/log 不必等终态才可见。
            if (
              run.timeline.length > 0 &&
              (due || (nodeBoundary && due) || hasPhaseOrLog) &&
              stamp - run.lastPersistAt >= PROGRESS_PERSIST_INTERVAL_MS
            ) {
              run.lastPersistAt = stamp
              record.updatedAt = stamp
              record.progress = run.timeline
              try {
                this.writeRecord(record)
                const flushed = this.state.flush?.()
                if (flushed !== undefined) void flushed.catch(() => {})
              } catch {
                // 尽力而为的观察面：失败不阻断 run，终态写入会再次尝试。
              }
            }

            const emitUpdated = (at: number): void => {
              this.emitEventSafe('workflow.updated', {
                run: this.runs.redactSummaryNodes({
                  ...run.summary,
                  updatedAt: at,
                  nodes: this.runs.nodesFromProgress(run.progress),
                  ...(run.timeline.length > 0 ? { progress: [...run.timeline] } : {}),
                }),
              })
            }

            if ((nodeBoundary && due) || hasPhaseOrLog || hasResolvedOrGate) {
              // 窗口内补发 timer 不再需要：本次已携最新状态发布。
              if (run.pendingEventTimer !== undefined) {
                clearTimeout(run.pendingEventTimer)
                run.pendingEventTimer = undefined
              }
              run.lastNodeEventAt = stamp
              emitUpdated(stamp)
            } else if (nodeBoundary && !due && run.pendingEventTimer === undefined) {
              // 250ms 窗口内的节点启动/完成：trailing timer 兜底补发，绝不丢失。
              const delay = Math.max(10, NODE_EVENT_INTERVAL_MS - (stamp - run.lastNodeEventAt))
              const timer = setTimeout(() => {
                run.pendingEventTimer = undefined
                if (!this.active.has(runId)) return
                const at = Date.now()
                run.lastNodeEventAt = at
                emitUpdated(at)
              }, delay)
              timer.unref?.()
              run.pendingEventTimer = timer
            }
          },
          journal: {
            ...(replayEntries.length > 0 ? { entries: replayEntries } : {}),
            retryFailedCalls: replayFrom?.status === 'failed',
            append: async (entry) => {
              // agent 行 execution/gate（effectiveCwd、worktree 路径、gate 输出
              // 可含机密 token）落盘前统一脱敏；幂等替换，重复脱敏无害。
              await run.writer.append(redactJournalEntry(entry, this.redact))
            },
          },
        })
      } catch (error) {
        // 引擎在 worker 启动前拒绝（坏 meta、超限等）：无进度可折叠，直接失败。
        failure = error
      }
      try {
        await settleRun(result, failure)
      } catch (error) {
        // settleRun 设计上吸收全部异常（终态落盘失败等经 settleError 如实浮出
        // 给 wait/abort）；此 catch 仅防御缩程错误逃逸：gate 仍必须 resolve，
        // 且不得留下 floating rejection。
        process.stderr.write(
          `workflow ${runId}: settle crashed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        run.settleError = run.settleError ?? error
      }
      resolveRunDone()
    })()

    return { ...run.summary }
  }

  // ------------------------------------------------------------------
  // startBackgroundAgent：受信后台单子代理（不拼 DSL 脚本）
  // ------------------------------------------------------------------

  /**
   * 启动后台单子代理：复用 run 记录 / 持久化 / abort / wait / getRun /
   * onRunSettled / 重启恢复，但不经 DSL 引擎（不伪造空 script），直接投
   * host.spawnAgent 受信通道。
   *
   * 时序纪律：
   * 1. durable running 快照与 active 登记**先于** spawnAgent 副作用——onResolved
   *    前进程崩溃也能由 init() 恢复发现并补发通知；
   * 2. 等 onResolved 地平线后立即返回 running（拿到真实 execution 元数据）；
   * 3. 前置错误（onResolved 前 spawn reject）当场同步 rethrow 原始错误——但
   *    durable 记录已存在，由后台兜底链将其结算为 failed（诚实终态，不删记录
   *    留僵尸 running，也不伪造成功）；
   * 4. 父 signal 仅在启动阶段（onResolved 前）传播取消，就绪即解绑——父回合
   *    结束后的 signal abort 不误杀后台子代理；此后只受 abort(runId)/close() 控制；
   * 5. 插件从不 onResolved 但 settle：execution 留空（绝不伪造），abort 无子会话
   *    可停，仅取消本 run；
   * 6. onBackgroundAgentSettled 失败不推翻终态：notifiedAt 不置位，init() 按
   *    outbox 语义补发（至少一次；父侧 reportBackgroundAgent 幂等去重）。
   */
  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
    },
  ): Promise<{
    run: WorkflowRunSummary
    execution?: AgentExecutionInfo
  }> {
    if (this.closed) {
      throw new HelmError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)
    }
    await this.init()
    if (this.closed) throw new HelmError('service_closed', 'WorkflowService 已关闭，拒绝启动新后台子代理', 503)

    // 父会话不存在时 getConversation 抛 not_found，原样透传给调用方。
    this.host.getConversation(request.parentConversationId)

    if (request.signal?.aborted) {
      throw new HelmError('aborted', 'spawn 请求在创建前已取消', 409)
    }

    const runId = newRunId()
    const createdAt = Date.now()
    const abort = new AbortController()
    const parentToolCallId =
      options?.parentToolCallId !== undefined && options.parentToolCallId !== ''
        ? options.parentToolCallId
        : request.parentToolCallId !== undefined && request.parentToolCallId !== ''
          ? request.parentToolCallId
          : undefined
    const name =
      options?.label !== undefined && options.label.trim() !== ''
        ? options.label.trim()
        : request.agentType !== undefined && request.agentType !== ''
          ? `subagent:${request.agentType}`
          : 'subagent'

    mkdirSync(this.runs.artifactsDir(request.parentConversationId), { recursive: true })
    const journalPath = this.runs.journalPathFor(request.parentConversationId, runId)

    const node: WorkflowNodeState = {
      id: 'subagent-0',
      kind: 'agent',
      label: name,
      status: 'running',
      startedAt: createdAt,
      ...(request.agentType !== undefined && request.agentType !== ''
        ? { agentType: request.agentType }
        : {}),
      ...(request.gate !== undefined ? { gateCommand: this.redact(request.gate) } : {}),
    }

    const record: RunRecord = {
      id: runId,
      name,
      conversationId: request.parentConversationId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      status: 'running',
      createdAt,
      updatedAt: createdAt,
      kind: 'subagent',
      notifyParentOnSettle: options?.notifyParentOnSettle ?? true,
      journalPath,
      nodes: [node],
    }

    let resolveDone: () => void = () => {}
    const doneGate = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const run: ActiveRun = {
      runId,
      conversationId: request.parentConversationId,
      abort,
      record,
      // done 立即挂后台兜底链：从创建第一刻起 wait/abort/close 都有可等的终点。
      done: doneGate.then(() => undefined),
      summary: this.runs.toSummary(record),
      journalPath,
      writer: new JournalWriter(journalPath),
      progress: [],
      timeline: [],
      pendingAborts: new Set(),
      pendingExecs: new Set(),
      childConversations: new Set(),
      lastPersistAt: createdAt,
      lastNodeEventAt: createdAt,
    }
    // 取消窗口复查（与 active.set 零 await 间隔）：入口检查后已经过 getConversation
    // 等多个 await 点，父会话可能已进入级联取消边界——在此拒绝，不留漏网 run。
    this.cancellation.assertNotCancelling(request.parentConversationId)
    this.active.set(runId, run)

    // abort(runId)/close()/级联取消 → 取消本 run 信号（spawn 信号桥停子会话回合）+
    // 经 host.abortConversationGuarded 守卫中止已 onResolved 的子会话（human
    // 红线由内核原子复核；幂等，已结束的子会话静默）。注册进 pendingAborts：
    // settle 前必等完。
    const onRunAbort = (): void => {
      for (const childId of [...run.childConversations]) {
        this.abortChildConversation(run, childId)
      }
    }
    abort.signal.addEventListener('abort', onRunAbort, { once: true })

    // --- 后台兜底结算链（唯一终态出口；绝不 reject，避免 unhandled） -------
    let settled = false
    let reportedSettleError = false
    let settleError: unknown
    const reportSettleError = (error: unknown): void => {
      if (!reportedSettleError) {
        reportedSettleError = true
        settleError = error
      }
    }

    /** 已 sanitized 执行元数据（onResolved 可能多次回调，幂等取最新）。 */
    let executionInfo: AgentExecutionInfo | undefined
    let gateResult: AgentGateResult | undefined
    /** onResolved 是否真实触发（与地平线 race 分开判定，防 spawnEarly 混淆）。 */
    let onResolvedFired = false
    let resolveHorizon: () => void = () => {}
    const horizonGate = new Promise<void>((resolve) => {
      resolveHorizon = resolve
    })

    const settle = async (
      outcome: { ok: true; raw: unknown } | { ok: false; error: unknown },
    ): Promise<void> => {
      // 同步置位幂等门：abort 快路径与 spawn 迟到终局竞态下二次进入直接
      // no-op（迟到结果只经 active 删除后的 records 事实可见，不翻终态）。
      if (settled) return
      settled = true
      try {
        const settledAt = Date.now()
        const aborted =
          !outcome.ok &&
          (abort.signal.aborted ||
            (outcome.error instanceof HelmError && outcome.error.code === 'aborted'))
        if (outcome.ok) {
          node.status = 'done'
          node.settledAt = settledAt
          node.durationMs = settledAt - createdAt
          node.output = redactJsonValue(outcome.raw, this.redact)
          record.status = 'completed'
          record.result = redactJsonValue(outcome.raw, this.redact)
        } else {
          node.status = aborted ? 'skipped' : 'failed'
          node.settledAt = settledAt
          node.durationMs = settledAt - createdAt
          const message =
            outcome.error instanceof HelmError
              ? `[${outcome.error.code}] ${outcome.error.message}`
              : outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
          node.error = this.redact(message)
          record.status = aborted ? 'aborted' : 'failed'
          record.error = this.redact(message)
        }
        record.updatedAt = settledAt
        record.nodes = this.runs.redactNodes([node])
        run.summary = this.runs.toSummary(record)
        try {
          this.writeRecord(record)
          await this.state.flush?.()
        } catch (persistError) {
          const message = persistError instanceof Error ? persistError.message : String(persistError)
          process.stderr.write(`workflow ${runId}: terminal state persist failed: ${message}\n`)
          run.summary = {
            ...run.summary,
            error: `${run.summary.error ?? ''}\n[persist failed: ${message}]`.trim(),
          }
          reportSettleError(persistError)
        }
      } finally {
        try {
          await run.writer.close()
        } catch (closeError) {
          process.stderr.write(
            `workflow ${runId}: journal close failed: ${
              closeError instanceof Error ? closeError.message : String(closeError)
            }\n`,
          )
        }
        if (run.pendingAborts.size > 0) {
          await Promise.allSettled([...run.pendingAborts])
        }
        if (this.host.onRunSettled !== undefined) {
          try {
            await this.host.onRunSettled({ ...run.summary })
          } catch (hookError) {
            const message = hookError instanceof Error ? hookError.message : String(hookError)
            process.stderr.write(`workflow ${runId}: onRunSettled failed: ${message}\n`)
            reportSettleError(hookError)
          }
        }
        if (
          !this.closed &&
          record.notifyParentOnSettle === true &&
          record.notifiedAt === undefined &&
          this.host.onBackgroundAgentSettled !== undefined
        ) {
          try {
            await this.host.onBackgroundAgentSettled({ ...run.summary }, {
              parentConversationId: request.parentConversationId,
              ...(request.agentType !== undefined && request.agentType !== ''
                ? { agentType: request.agentType }
                : {}),
              // 通知面向父会话输入（可进模型上下文）：与持久面同标准脱敏。
              ...(executionInfo !== undefined
                ? { execution: redactJsonValue(executionInfo, this.redact) as typeof executionInfo }
                : {}),
            })
            record.notifiedAt = Date.now()
            this.writeRecord(record)
            await this.state.flush?.()
          } catch (notifyError) {
            // 通知失败不推翻已落盘终态：notifiedAt 不置位，init() 按 outbox 补发。
            const message = notifyError instanceof Error ? notifyError.message : String(notifyError)
            process.stderr.write(`workflow ${runId}: onBackgroundAgentSettled failed: ${message}\n`)
          }
        }
        this.emitEventSafe('workflow.updated', { run: { ...run.summary } })
        this.active.delete(runId)
        if (settleError !== undefined) run.settleError = settleError
        resolveDone()
      }
    }

    // abort 快路径：取消即结算（不等 spawn 终局）。守卫拒绝（human 接管等
    // 红线事实）时 spawn 可能长期不返回，而 run 的终态绝不能依赖被保护
    // 子会话的完成；迟到 spawn 结果经 settle 的幂等门丢弃。
    abort.signal.addEventListener(
      'abort',
      () => {
        void settle({ ok: false, error: new HelmError('aborted', '后台子代理执行已取消', 409) }).catch(
          (error: unknown) => {
            reportSettleError(error)
          },
        )
      },
      { once: true },
    )

    const agentIdForProto = request.agentId ?? `${runId}:subagent-0`
    // spawn 终局透传：guarded 在下方组装后立刻接入（wireBackground），后台链
    // 从创建第一刻起即可等待（含 durable 快照写入前的窗口）。
    let wireBackground: (outcome: { ok: true; raw: unknown } | { ok: false; error: unknown }) => void = () => {}
    const backgroundWait = new Promise<{ ok: true; raw: unknown } | { ok: false; error: unknown }>((resolve) => {
      wireBackground = resolve
    })
    const background = (async () => {
      const outcome = await backgroundWait
      let effective = outcome
      if (effective.ok && abort.signal.aborted) {
        effective = { ok: false, error: new HelmError('aborted', '后台子代理执行已取消', 409) }
      }
      if (effective.ok && gateResult !== undefined && !gateResult.ok) {
        effective = { ok: false, error: new HelmError('gate_failed', gateResult.output, 502) }
      }
      if (
        effective.ok &&
        request.gate !== undefined &&
        gateResult === undefined &&
        executionInfo?.executionId !== undefined
      ) {
        // 外部执行环境（executionId 存在）必须回报 gate；缺失即显式失败，
        // 与 invokeSpawn 同款规则，绝不在本机猜远端工作目录补跑。
        effective = {
          ok: false,
          error: gateResultMissingError({
            agentId: agentIdForProto,
            executionId: executionInfo.executionId,
            command: request.gate,
          }),
        }
      }
      await settle(effective)
    })()
    void background.catch((error: unknown) => {
      process.stderr.write(
        `workflow ${runId}: background settle crashed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
      reportSettleError(error)
      if (!settled) void settle({ ok: false, error }).catch(() => {})
    })

    // --- durable running 快照（副作用 spawnAgent 之前！）------------------
    try {
      this.writeRecord(record)
      await this.state.flush?.()
    } catch (persistError) {
      this.active.delete(runId)
      await run.writer.close().catch(() => {})
      resolveDone()
      throw persistError
    }
    this.emitEventSafe('workflow.updated', { run: this.runs.redactSummaryNodes({ ...run.summary }) })

    // --- 组装 proto 并发起 spawn -----------------------------------------
    const proto: AgentSpawnRequest = {
      ...request,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      agentId: agentIdForProto,
      meta: withWorkflowSpawnMeta(undefined, { runId }),
      onResolved: (raw: unknown) => {
        const info = sanitizeExecutionInfo(raw, { agentId: agentIdForProto })
        executionInfo = info
        if (info.nodeId !== undefined) node.nodeId = info.nodeId
        if (info.conversationId !== undefined) {
          node.conversationId = info.conversationId
          run.childConversations.add(info.conversationId)
          // 迟到 onResolved 补杀：取消先于执行元数据落地时，onRunAbort 的快照
          // 看不到该子会话——在登记点立即补守卫中止，绝不因时序漏杀。
          if (abort.signal.aborted) this.abortChildConversation(run, info.conversationId)
        }
        if (info.executionId !== undefined) node.executionId = info.executionId
        if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
        // 业务扩展（worktree / 控制引用）在引擎边界用本插件契约校验并落到节点。
        const wfExecMeta = extractWorkflowExecutionMeta(info)
        if (wfExecMeta.worktree !== undefined) node.worktree = wfExecMeta.worktree
        if (wfExecMeta.controls !== undefined) node.controls = wfExecMeta.controls
        record.subagentMeta = {
          ...(request.agentType !== undefined && request.agentType !== ''
            ? { agentType: request.agentType }
            : {}),
          // 持久面统一脱敏（effectiveCwd/worktree 路径可能含秘密 token）。
          execution: redactJsonValue(info, this.redact) as typeof info,
        }
        record.nodes = this.runs.redactNodes([node])
        run.summary = this.runs.toSummary(record)
        this.writeRecord(record)
        onResolvedFired = true
        resolveHorizon()
        request.onResolved?.(info)
      },
      ...(request.gate !== undefined
        ? {
            onGateResult: (raw: unknown) => {
              const gate = sanitizeGateResult(raw, { agentId: agentIdForProto })
              gateResult = gate
              // exitCode/timedOut 是诊断事实（非机密），保留不丢弃。
              node.gate = {
                ok: gate.ok,
                output: this.redact(gate.output),
                ...(gate.exitCode !== undefined ? { exitCode: gate.exitCode } : {}),
                ...(gate.timedOut !== undefined ? { timedOut: gate.timedOut } : {}),
              }
              request.onGateResult?.(gate)
            },
          }
        : {}),
      signal: abort.signal,
    }

    // 父 signal 仅启动阶段传播（ready 前）；onResolved 即解绑。
    const parentSignal = request.signal
    const onParentAbort = (): void => {
      if (!onResolvedFired && !settled) abort.abort()
    }
    parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    const detachParentSignal = (): void => {
      parentSignal?.removeEventListener('abort', onParentAbort)
    }

    if (parentSignal?.aborted || this.closed) abort.abort()
    const spawnPromise = (async () => {
      if (abort.signal.aborted) throw new HelmError('aborted', '后台子代理启动期间已取消', 409)
      return this.host.spawnAgent(proto)
    })()
    // spawn 终局（guard 后绝不 reject）；onResolved 前失败在地平线 race 中
    // 同步透出给调用方，同时喂给后台链结算为 failed。
    let spawnOutcome: { ok: true; raw: unknown } | { ok: false; error: unknown } | undefined
    const guarded: Promise<{ ok: true; raw: unknown } | { ok: false; error: unknown }> = spawnPromise.then(
      (raw) => ({ ok: true as const, raw }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const spawnEarly = guarded.then((outcome) => {
      spawnOutcome = outcome
      wireBackground(outcome)
      resolveHorizon()
      return outcome
    })
    // 防御：spawnEarly 链自身异常不产生 unhandled rejection。
    void spawnEarly.catch(() => {})

    await Promise.race([horizonGate, spawnEarly.then((o) => o)])

    const preResolveFailure =
      spawnOutcome !== undefined && !spawnOutcome.ok && !onResolvedFired ? spawnOutcome.error : undefined
    if (preResolveFailure !== undefined) {
      // 情况 A：spawn 在 onResolved 之前就失败（Profile 不存在、参数非法、节点
      // 离线、非 Git 仓库建 worktree 失败等）。durable 记录已在副作用前登记，
      // 后台兜底链会把该失败结算为 failed（诚实终态，不留僵尸 running，也不
      // 伪造成功）；同时把原始错误当场同步 rethrow 给调用方。
      detachParentSignal()
      throw preResolveFailure
    }

    // 情况 B：onResolved 已触发（真实 execution 元数据），或外部插件未回
    // onResolved 但已同步 settle（execution 留空，绝不伪造）。
    detachParentSignal()

    try {
      this.writeRecord(record)
      await this.state.flush?.()
    } catch (persistError) {
      // running 快照已落盘；此处仅补 execution 元数据失败，不撤销 run。
      const message = persistError instanceof Error ? persistError.message : String(persistError)
      process.stderr.write(`workflow ${runId}: execution metadata persist failed: ${message}\n`)
    }
    this.emitEventSafe('workflow.updated', { run: this.runs.redactSummaryNodes({ ...run.summary }) })

    return {
      run: this.runs.redactSummaryNodes({ ...run.summary }),
      ...(executionInfo !== undefined ? { execution: executionInfo } : {}),
    }
  }
  // ------------------------------------------------------------------
  // getRun / wait / abort
  // ------------------------------------------------------------------

  /** 内存优先，回落 state store（跨重启 inspect）。 */
  getRun(runId: string): WorkflowRunSummary {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      // 后台单子代理不经引擎 progress：直接用 record.nodes（实时维护）。
      const collapsed =
        activeRun.progress.length > 0 ? this.runs.nodesFromProgress(activeRun.progress) : activeRun.summary.nodes
      return this.runs.redactSummaryNodes({
        ...activeRun.summary,
        ...(collapsed !== undefined ? { nodes: collapsed } : {}),
        ...(activeRun.timeline.length > 0 ? { progress: [...activeRun.timeline] } : {}),
      })
    }
    return this.runs.toSummary(this.runs.load(runId))
  }

  /**
   * 全部已持久 run 的 summary（新建在前）：活跃 run 实时折叠 nodes，
  // 终态 run 读 store；非保存脚本运行的 run 也列出（历史可 inspect）。
   *
   * 索引损坏（缺记录、ID 不符、形状非法）或 store 抛错是持久层服务故障，
   * 不是「少几项的正常列表」——静默吞掉会让 HTTP/CLI/snapshot 返回看似成功
   * 的残缺数据。此处显式抛 workflow_index_corrupt（500）并附 runId 诊断；
   * 单个 run 不存在的 404 语义仍由 getRun 保留。快照 provider 同走此路径，
   * 故障不会被 snapshot 再吞掉（throw 直接打断 SSE snapshot 组装）。
   */
  listRuns(): WorkflowRunSummary[] {
    // 索引读取与其他全部入口统一（readRunIndex）：store 抛错/形状损坏显式
    // workflow_index_corrupt（带 key 与可辨识 runId），绝不强转后拿 entry.id
    // TypeError 或当有效列表。
    const index = this.runs.readIndex()
    const out: WorkflowRunSummary[] = []
    const seen = new Set<string>()
    for (const active of this.active.values()) {
      seen.add(active.runId)
      const collapsed =
        active.progress.length > 0 ? this.runs.nodesFromProgress(active.progress) : active.summary.nodes
      out.push(
        this.runs.redactSummaryNodes({
          ...active.summary,
          ...(collapsed !== undefined ? { nodes: collapsed } : {}),
          ...(active.timeline.length > 0 ? { progress: [...active.timeline] } : {}),
        }),
      )
    }
    for (const entry of [...index].sort((a, b) => b.createdAt - a.createdAt)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      // loadRecord 对 not_found（普通不存在）抛 404：在 list 语境里这是索引
      // 指向缺失记录的服务故障，改报 workflow_index_corrupt；ID 不符同理。
      try {
        out.push(this.runs.toSummary(this.runs.load(entry.id)))
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') {
          throw this.runs.indexCorruptError(entry.id, `记录缺失或 ID 不符：${error.message}`)
        }
        if (error instanceof HelmError && error.code === 'workflow_record_corrupt') throw error
        throw this.runs.indexCorruptError(entry.id, `记录损坏：${errorMessage(error)}`)
      }
    }
    // 新建在前契约是全局的：active.values() 是旧先新后的插入序，较早创建的
    // 活跃 run 不能排在较新的终态历史之前——合并去重后统一 createdAt 倒序。
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  /**
   * 返回满足自动断点续跑条件的后台工作流。安全条件在引擎内读取并验证账本，
   * Watchdog 只消费明确候选，不自行推断 action 是否可能已执行。
   */
  listAutoResumeCandidates(maxAttempts = 3): WorkflowAutoResumeCandidate[] {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new HelmError('validation_error', 'maxAttempts 必须是正整数', 400, { maxAttempts })
    }
    // 索引读取与其他全部入口统一：损坏显式 workflow_index_corrupt，绝不静默
    // 当空索引返回空候选（那会让 Watchdog 误以为无事可做）。
    const index = this.runs.readIndex()
    const candidates: WorkflowAutoResumeCandidate[] = []
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.runs.load(entry.id)
      } catch (error) {
        // 单条损坏记录不能让所有其它候选静默消失；记录明确诊断后跳过，
        // Watchdog 仍可恢复账本完整的 Run。listRuns 继续对外严格失败。
        process.stderr.write(`workflow auto-resume: skip ${entry.id}: ${errorMessage(error)}\n`)
        continue
      }
      if (
        record.status !== 'failed' ||
        record.kind === 'subagent' ||
        record.notifyParentOnSettle !== true ||
        (record.autoResumeCount ?? 0) >= maxAttempts ||
        isNonRetryableWorkflowError(record.error)
      ) continue
      if (record.resumedByRunId !== undefined) {
        // 幽灵接管标记同规则甄别（与 resume 入口同一 helper）：接管 run 四面
        // 无痕（从未写记录/账本）才放行重接管；仍存在或损坏（含磁盘仍有
        // 文件、并发启动窗口）一律不放行。损坏诊断后跳过本条，不影响其他候选。
        try {
          const takeover = this.runs.inspectTakeoverMarker(record.resumedByRunId, record.conversationId, {
            reserved: this.takeoverReservations.has(record.resumedByRunId),
            active: this.active.has(record.resumedByRunId),
          })
          if (!takeover.ghost) continue
        } catch (error) {
          process.stderr.write(
            `workflow auto-resume: skip ${entry.id}: takeover ${record.resumedByRunId} unusable: ${errorMessage(error)}\n`,
          )
          continue
        }
      }
      const journal = readJournal(record.journalPath)
      const hasSafeReplayAnchor = journal.entries.some((line) =>
        line.type === 'action'
          ? line.ok
          : line.type === 'agent' && (line.ok || (
              line.attempt !== undefined && line.execution?.conversationId !== undefined && line.execution.executionId === undefined
            )),
      )
      if (journal.actionUncertain || !hasSafeReplayAnchor) continue
      candidates.push({
        runId: record.id,
        conversationId: record.conversationId,
        failedAt: record.updatedAt,
        autoResumeCount: record.autoResumeCount ?? 0,
      })
    }
    return candidates.sort((a, b) => a.failedAt - b.failedAt)
  }

  /** 等待 run 完成并返回其结果（历史 run 直接返回 result）。 */
  async wait(runId: string): Promise<unknown> {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      // done 绝不 reject；终态落盘/flush 失败经 settleError 原样抛出，不假成功。
      await activeRun.done
      if (activeRun.settleError !== undefined) throw activeRun.settleError
    }
    return this.getRun(runId).result
  }

  /**
   * 中止 run（级联）：本 run 自身 + 其子会话子树内的全部后代 run 与同步子会话
   * 一起取消；父会话的兄弟任务不受牵连。取消窗口内拒绝该子树新 run/spawn
   * （防取消期间又派新任务）；返回时全部涉及 run 已 settle、无未处理 rejection。
   */
  async abort(runId: string): Promise<void> {
    const activeRun = this.active.get(runId)
    if (activeRun === undefined) {
      // 历史 run 幂等：不存在的才报错。
      this.getRun(runId)
      return
    }
    const seeds = [...activeRun.childConversations]
    await this.cancellation.cancelBoundary(`run:${runId}`, seeds, (run, isWithin) => {
      if (run === activeRun) return true
      // 后代归属：run 的发起会话落在任一子会话子树内（沿真实会话父链）。
      for (const seed of seeds) {
        if (isWithin(run.conversationId, seed)) return true
      }
      return false
    })
    if (activeRun.settleError !== undefined) throw activeRun.settleError
  }

  /** 会话是否处于级联取消窗口（插件层据此跳过向被取消父会话的结算汇报投递）。 */
  isConversationCancelling(conversationId: number): boolean {
    return this.cancellation.isCancelling(conversationId)
  }

  /**
   * 取消会话子树（含自身发起）的全部在途 run：父会话被中止（turn aborted）
   * 后由插件层调用。幂等：同根并发调用共享同一次取消；全部 run settle 后
   * 才返回（各自子会话的守卫中止在 run 结算链内等待）。
   */
  async cancelRunsUnderConversation(conversationId: number): Promise<void> {
    await this.cancellation.cancelBoundary(`conv:${conversationId}`, [conversationId], (run, isWithin) =>
      isWithin(run.conversationId, conversationId),
    )
  }

  /**
   * 守卫中止一个 run 的子会话：经宿主守卫入口（human 红线由内核原子复核；
   * 拒绝/失败诊断不吞 stderr），绝不回退普通中止；完成前计入 pendingAborts
   * （settle 前必等完——迟到调用在结算后仅诊断，同样不阻断终态）。
   * 实现位于 host-adapter（引擎 abortAgent / 迟到 onResolved 补杀同款复用）。
   */
  private abortChildConversation(run: ActiveRun, conversationId: number): Promise<void> {
    return abortChildViaHost(this.host, run, conversationId)
  }

  async close(): Promise<void> {
    this.closed = true
    const inFlight = [...this.active.values()]
    for (const run of inFlight) run.abort.abort()
    await Promise.all(inFlight.map((run) => run.done))
    await this.state.flush?.()
  }

  // ------------------------------------------------------------------
  // host 适配：引擎 WorkflowHost <-> WorkflowServiceHost（实现位于 host-adapter）
  // ------------------------------------------------------------------

  private engineHostDeps(): EngineHostDeps {
    return {
      host: this.host,
      redact: this.redact,
      isClosed: () => this.closed,
      isCancelling: (conversationId) => this.cancellation.isCancelling(conversationId),
      persistChildConversationFact: (activeRun, conversationId) =>
        this.persistChildConversationFact(activeRun, conversationId),
      loadWorkflowRef: (ref) => this.loadWorkflowRef(ref),
    }
  }

  private makeEngineHost(run: ActiveRun, parent: ConversationSummary): WorkflowHost {
    return createEngineHost(this.engineHostDeps(), run, parent)
  }

  /**
   * 单次 agent/resume 调用（实现位于 host-adapter；保留私有接缝供建引擎
   * 适配与直测共用同一入口）。签名与历史版本一致。
   */
  private async invokeSpawn(
    run: ActiveRun,
    parent: ConversationSummary,
    conversationByAgent: Map<string, number>,
    request: WorkflowSpawnRequest,
    isResume: boolean,
  ): Promise<WorkflowSpawnResult> {
    return invokeAgentSpawn(this.engineHostDeps(), run, parent, conversationByAgent, request, isResume)
  }

  /** 嵌套 workflow() 引用解析：仅允许保存目录安全名或显式本地路径。 */
  private loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string } {
    try {
      if (ref.name !== undefined) {
        const path = this.library.resolveSavedName(ref.name)
        return { ok: true, script: this.library.readScriptFile(path), path }
      }
      if (ref.scriptPath !== undefined) {
        const path = this.library.resolveExplicitPath(ref.scriptPath)
        return { ok: true, script: this.library.readScriptFile(path), path }
      }
      return { ok: false, message: 'workflow() 引用需要 name 或 scriptPath' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // ------------------------------------------------------------------
  // state store 读写（单库；持久化实现位于 run-store）
  // ------------------------------------------------------------------

  /**
   * 写 run 记录：活跃 run 的在途子会话以内存 Set 为唯一真源，任何写入
   * （onResolved 即时 / progress 节流 / 终态）统一从 active 合入
   * childConversationIds，杜绝用旧 record 副本覆盖掉已登记的子会话事实；
   * 随后交 run store 原子落文件并更新索引（顺序纪律见 RunStore.write）。
   */
  private writeRecord(record: RunRecord): void {
    const active = this.active.get(record.id)
    if (active !== undefined && active.childConversations.size > 0) {
      record.childConversationIds = [...active.childConversations]
    }
    this.runs.write(record)
  }

  private assertNotClosed(): void {
    if (this.closed) throw new HelmError('closed', 'WorkflowService 已关闭', 409)
  }

  /**
   * 子会话事实即时持久（onResolved 登记点）：崩溃恢复（prepareRecovery/init
   * 守卫中止）依赖 running 记录里的 childConversationIds——晚到终态才落盘等于
   * 重启后子会话脱管。写入失败必须显式诊断（stderr）：静默吞掉会让下次恢复
   * 假装完备；内存 record 已登记，后续 progress/终态写入自动重试携带（终态
   * 写失败另有 settleError 如实浮出，不假装可恢复）。
   */
  private persistChildConversationFact(run: ActiveRun, conversationId: number): void {
    try {
      this.writeRecord(run.record)
      const flushed = this.state.flush?.()
      if (flushed !== undefined) {
        void flushed.catch((error: unknown) => {
          process.stderr.write(
            `workflow ${run.runId}: child conversation ${conversationId} persist flush failed: ${errorMessage(error)}\n`,
          )
        })
      }
    } catch (error) {
      process.stderr.write(
        `workflow ${run.runId}: child conversation ${conversationId} persist failed: ${errorMessage(error)}\n`,
      )
    }
  }

  /**
   * workflow.updated 事件的 fire-and-forget 收口：WorkflowServiceHost 的
   * emitEvent 签名是 void，但真实适配器（插件层）为 async——投影/广播失败
   * 只能诊断，不得逃逸为 unhandledRejection 拖垮进程（观察面失败不动摇
   * run 生命周期；持久终态以 state store 为准）。
   */
  private emitEventSafe(type: string, payload: unknown): void {
    const diagnose = (error: unknown): void => {
      process.stderr.write(
        `workflow: emitEvent ${type} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    try {
      void Promise.resolve(this.host.emitEvent(type, payload)).catch(diagnose)
    } catch (error) {
      diagnose(error)
    }
  }
}
