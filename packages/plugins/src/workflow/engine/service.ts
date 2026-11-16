/**
 * service.ts — WorkflowService：工作流引擎对内核/HTTP 层的唯一出口（facade）。
 *
 * 内部职责按模块拆分（均在同目录）：library-store（已保存工作流文件库）、
 * run-store（run 记录/索引持久层）与 run-summary（summary 派生/脱敏/
 * progress 折叠投影）、cancellation-tracker（取消窗口与子树边界取消）、
 * host-adapter + host-action-adapter（引擎 WorkflowHost ↔ WorkflowServiceHost
 * 适配）、active-run（在途运行态与节流常量）、service-context（runner 共享
 * 上下文、caps 与选项装配）、service-run / run-settle / run-progress
 * （run() 启动主体、终态结算、进度事件策略）、background-agent-runner
 * （startBackgroundAgent）、service-recovery（启动恢复与自动续跑候选）。
 *
 * 本文件只保留门面：构造装配、各 runner 委托、查询面（getRun/listRuns/
 * wait/abort/close）、host 适配接缝与 state store 读写。持久化格式、错误码
 * 与行为契约不变。引擎本体（runtime.ts）零内核依赖；本文件是唯一 import
 * kernel 侧类型的适配层。
 */

import {
  HelmError,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type ConversationSummary,
} from '@helm/protocol'
import type {
  SavedWorkflowDetail,
  SavedWorkflowSummary,
  WorkflowDeleteResult,
  WorkflowRunRequest,
  WorkflowRunSummary,
  WorkflowSaveRequest,
  WorkflowSaveResult,
} from '../../contracts.js'
import type {
  WorkflowHost,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from './runtime.js'
import type { ActiveRun } from './active-run.js'
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
  errorMessage,
  type RunRecord,
  type WorkflowStateStore,
} from './run-store.js'
import { nodesFromProgress, redactSummaryNodes, toSummary } from './run-summary.js'
import {
  resolveCaps,
  type WorkflowCaps,
  type WorkflowServiceContext,
  type WorkflowServiceOptions,
} from './service-context.js'
import { StartupRecovery } from './service-recovery.js'
import { startWorkflowRun } from './service-run.js'
import { startBackgroundAgent as launchBackgroundAgent } from './background-agent-runner.js'
import { detachForegroundRun as detachRun, waitForegroundRun } from './run-detach.js'

export {
  BUILTIN_ENV_EXEC_PLUGIN,
  BUILTIN_ENV_EXEC_ACTION,
  type ValidatedEnvExecInput,
  type WorkflowServiceHost,
} from './host-adapter.js'
export type { WorkflowStateStore } from './run-store.js'
export type { WorkflowAutoResumeCandidate } from './service-recovery.js'
export type { WorkflowServiceOptions } from './service-context.js'

export class WorkflowService {
  private readonly host: WorkflowServiceHost
  private readonly state: WorkflowStateStore
  private readonly caps: WorkflowCaps
  private readonly redact: (text: string) => string
  private readonly runs: RunStore
  private readonly library: WorkflowLibrary
  private readonly cancellation: CancellationTracker
  private readonly active = new Map<string, ActiveRun>()
  /** 进程内接管保留（防并发双接管；完整语义见 service-run 的 resume 接管段）。 */
  private readonly takeoverReservations = new Set<string>()
  private readonly ctx: WorkflowServiceContext
  private readonly recovery: StartupRecovery
  private closed = false

  constructor(options: WorkflowServiceOptions) {
    this.host = options.host
    this.state = options.state
    this.caps = resolveCaps(options)
    this.redact = options.redact ?? ((text: string) => text)
    this.runs = new RunStore({ dataDir: options.dataDir, state: options.state })
    this.library = new WorkflowLibrary({
      dataDir: options.dataDir,
      loadRunRecord: (runId) => this.runs.load(runId),
    })
    this.cancellation = new CancellationTracker({
      active: this.active,
      parentConversationOf: (id) => this.host.getConversation(id).parentConversationId,
    })
    this.ctx = {
      host: this.host,
      state: this.state,
      runs: this.runs,
      library: this.library,
      cancellation: this.cancellation,
      active: this.active,
      takeoverReservations: this.takeoverReservations,
      redact: this.redact,
      caps: this.caps,
      isClosed: () => this.closed,
      assertNotClosed: () => this.assertNotClosed(),
      init: () => this.init(),
      writeRecord: (record) => this.writeRecord(record),
      emitEventSafe: (type, payload) => this.emitEventSafe(type, payload),
      makeEngineHost: (run, parent) => this.makeEngineHost(run, parent),
      abortChildConversation: (run, conversationId) => this.abortChildConversation(run, conversationId),
    }
    this.recovery = new StartupRecovery(this.ctx)
  }

  /** 启动恢复（阶段一屏障；实现位于 service-recovery）。幂等；run() 首次调用前自动执行。 */
  async prepareRecovery(): Promise<void> {
    return this.recovery.prepareRecovery()
  }

  /** 启动恢复（阶段二：interrupted 标记与通知 outbox 补发；实现位于 service-recovery）。 */
  async init(): Promise<void> {
    return this.recovery.init()
  }

  /** 启动后收敛（runtime.started 阶段：等待遗留子会话结算至 idle；幂等）。 */
  async awaitPreparedChildrenSettled(): Promise<void> {
    return this.recovery.awaitPreparedChildrenSettled()
  }

  // 工作流库：list / get / save / delete（实现位于 library-store）

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

  // run（实现位于 service-run / run-settle / run-progress）

  /**
   * 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。
   * context.foreground=true 标记前台同步 run（record.syncForeground，可被
   * detach 转后台）。
   * @throws HelmError validation_error / not_found / workflow_action_uncertain / journal_read_failed。
   */
  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean; foreground?: boolean },
  ): Promise<WorkflowRunSummary> {
    return startWorkflowRun(this.ctx, request, context)
  }

  // startBackgroundAgent：受信后台单子代理（实现位于 background-agent-runner）

  /**
   * 启动后台单子代理：复用 run 记录 / 持久化 / abort / wait / getRun /
   * onRunSettled / 重启恢复，但不经 DSL 引擎（时序纪律见 background-agent-runner）。
   * options.foreground=true 为前台同步模式（同步 subagent 工具）：record 标记
   * syncForeground、notifyParentOnSettle 缺省 false、父 signal 绑定至 detach/终态。
   */
  async startBackgroundAgent(
    request: AgentSpawnRequest,
    options?: {
      parentToolCallId?: string
      label?: string
      notifyParentOnSettle?: boolean
      foreground?: boolean
    },
  ): Promise<{
    run: WorkflowRunSummary
    execution?: AgentExecutionInfo
  }> {
    return launchBackgroundAgent(this.ctx, request, options)
  }

  // 前台同步 run 的 detach（实现位于 run-detach）

  /**
   * 前台同步等待（同步工具 execute 内使用）：resolve 为 'detached'（detach
   * 动作已转后台，工具立即返回后台句柄）或 'settled'（run 终态，settleError
   * 与 wait() 同语义抛出）。hooks.onDetached 在 detach 临界段同步执行
   * （工具侧解绑父 signal listener，转后台后父回合 signal 不再杀 run）。
   */
  async waitForeground(
    runId: string,
    hooks?: { onDetached?: () => void },
  ): Promise<'detached' | 'settled'> {
    return waitForegroundRun(this.ctx, runId, hooks)
  }

  /**
   * 把运行中的前台同步 run 原子转为后台（detach 动作入口；同步临界段实现
   * 见 run-detach）：置位 detachedAt/notifyParentOnSettle、持久化、解绑父
   * signal（引擎绑定 + 等待者 onDetached）并唤醒等待者，随后 await 状态
   * 存储 flush（失败如实抛 detach_flush_failed，不回滚已持久记录）。
   * 状态/前台标记不满足时显式拒绝。
   */
  async detachForegroundRun(runId: string): Promise<WorkflowRunSummary> {
    this.assertNotClosed()
    return detachRun(this.ctx, runId)
  }

  // getRun / wait / abort

  /** 内存优先，回落 state store（跨重启 inspect）。 */
  getRun(runId: string): WorkflowRunSummary {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      // 后台单子代理不经引擎 progress：直接用 record.nodes（实时维护）。
      const collapsed =
        activeRun.progress.length > 0 ? nodesFromProgress(activeRun.progress) : activeRun.summary.nodes
      return redactSummaryNodes(this.redact, {
        ...activeRun.summary,
        ...(collapsed !== undefined ? { nodes: collapsed } : {}),
        ...(activeRun.timeline.length > 0 ? { progress: [...activeRun.timeline] } : {}),
      })
    }
    return toSummary(this.runs.load(runId))
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
        active.progress.length > 0 ? nodesFromProgress(active.progress) : active.summary.nodes
      out.push(
        redactSummaryNodes(this.redact, {
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
        out.push(toSummary(this.runs.load(entry.id)))
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
   * 返回满足自动断点续跑条件的后台工作流（实现位于 service-recovery）。
   */
  listAutoResumeCandidates(maxAttempts = 3) {
    return this.recovery.listAutoResumeCandidates(maxAttempts)
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

  // host 适配：引擎 WorkflowHost <-> WorkflowServiceHost（实现位于 host-adapter）

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

  // state store 读写（单库；持久化实现位于 run-store）

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
