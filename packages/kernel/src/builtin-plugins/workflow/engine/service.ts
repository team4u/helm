/**
 * service.ts — WorkflowService：工作流引擎对内核/HTTP 层的唯一出口。
 *
 * 职责：
 * - 请求校验（name/script/scriptPath 恰一、512KB 上限、安全 name、caps 正数）；
 * - run 生命周期（后台启动立即返回 summary、wait/abort/getRun）；
 * - 持久化（单库设计）：run 索引与每 run summary 存入注入的 state store
 *   （@helm/kernel 唯一 state.sqlite 的命名空间 doc），启动恢复时把遗留
 *   running 显式标 failed(interrupted)。唯一文件例外是统一前缀重放账本
 *   dataDir/artifacts/<convId>/workflow-<runId>.jsonl——副作用重放语义要求
 *   append+fsync，SQLite 不适配；
 * - host 适配：runtime.ts 的 WorkflowHost（引擎接缝）↔ WorkflowServiceHost
 *   （KernelRuntime 注入：spawnAgent=agent_spawn 管道、invokeAction=PluginHost
 *   动作总线、getConversation/abortConversation、emitEvent、可选 runGate）；
 * - 恢复语义：resumeFromRunId 重放 journal；账本缺失/不可读/存在失败或悬挡
 *   action（副作用不可判定）一律显式拒绝，由人类确认，绝不自动重跑副作用。
 *
 * 引擎本体（runtime.ts）零内核依赖；本文件是唯一 import kernel 侧类型的适配层。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  HelmError,
  type ActionManifest,
  type AgentExecutionInfo,
  type AgentGateResult,
  type AgentSpawnRequest,
  type ConversationSummary,
  type SavedWorkflowSummary,
  type WorkflowProgressEntry,
  type WorkflowRunRequest,
  type WorkflowRunStatus,
  type WorkflowNodeState,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { JournalWriter, readJournal, type WorkflowJournalEntry } from './journal.js'
import { extractMeta, hasMetaDeclaration, type WorkflowMeta } from './meta.js'
import { collapse, type WorkflowEntry } from './progress.js'
import {
  gateResultMissingError,
  redactExecutionMetadata,
  redactGateResult,
  sanitizeExecutionInfo,
  sanitizeGateResult,
} from './spawn-exec.js'
import {
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  redactJsonValue,
  runWorkflow,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from './runtime.js'

/**
 * run 索引与 summary 的持久层：内核唯一 state.sqlite 的命名空间 doc 视图
 * （与 PluginDocStore 同构，但不依赖 plugins 模块）。get/set 同步；flush
 * 可选（SQLite 即时落页时可为空）。
 */
export interface WorkflowStateStore {
  get<T>(key: string, initial: T): T
  set<T>(key: string, value: T): void
  flush?(): Promise<void>
}

/** 引擎测试注入边界：宿主能力由 KernelRuntime 提供，测试可用确定性 fake 替换。 */
export interface WorkflowServiceHost {
  /** agent_spawn 管道入口（KernelRuntime.spawnAgent：hook 链 + 原生子会话默认行）。 */
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /** 恢复前只落 SDK abort 标记，不唤醒调度；必须早于插件服务启动。 */
  prepareInterruptedConversations?(conversationIds: number[]): Promise<void>
  /**
   * 插件动作调用（PluginHost.invokeAction：manifest 精确匹配 + 输入输出 schema
   * 边界校验）。返回值必须已是安全 JSON（上游 app 层做 stash redact）。
   */
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number; signal?: AbortSignal },
  ): Promise<unknown>
  listActions(): ActionManifest[]
  getConversation(id: number): ConversationSummary
  abortConversation(id: number): Promise<void>
  emitEvent(type: string, payload: unknown): void
  /**
   * run 终态结算通知（每 run 恰一次；wait/close 必须等待它结束）。宿主用它
   * 驱动 app->kernel 的工作流结算广播（onWorkflowSettled 监听器）。清理异常
   * 在 service 内如实上报为 failed/诊断，不破坏 journal 副作用保护。
   */
  onRunSettled?(summary: WorkflowRunSummary): Promise<void> | void
  /**
   * 后台单子代理（startBackgroundAgent）终态汇报回调：仅对 notifyParentOnSettle=true
   * 的后台子代理触发（不影响常规 SubagentWorkflow）。调用方（app/kernel）向父
   * 会话投递完成/失败/中止通知；恰一次（notifiedAt 防重复，init() 补发遗留）。
   */
  onBackgroundAgentSettled?(
    summary: WorkflowRunSummary,
    info: {
      parentConversationId: number
      agentType?: string
      execution?: AgentExecutionInfo
    },
  ): Promise<void> | void
  /**
   * gate 门禁执行（KernelRuntime.runGate：shell + SecretStash env 合并 + 超时）。
   * 这是宿主自跑 fallback：执行环境（native/herdr）已在实际 cwd 内执行过
   * gate 并经 onGateResult 回报时不会走到这里。缺省宿主让带 gate 的 agent
   * 调用显式失败——静默跳过的 gate 等于把未验证的工作标记为已验证。
   * cwd 传子会话工作目录（如有），否则父会话 cwd。
   */
  runGate?(
    command: string,
    options: { cwd?: string; conversationId?: number; signal?: AbortSignal },
  ): Promise<{ ok: boolean; output: string }>
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

/** 已保存工作流的安全名称：字母数字开头，限 [A-Za-z0-9._-]，防路径穿越。 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const INDEX_KEY = 'workflow/runs'
const runKey = (runId: string) => `workflow/run/${runId}`

/** run id：wf_ + 12 hex（沿用上游格式便于识别）。 */
function newRunId(): string {
  return `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

interface RunIndexEntry {
  id: string
  conversationId: number
  createdAt: number
}

/** state store 中的每 run 完整 doc（summary + 恢复所需书目信息）。 */
interface RunRecord {
  id: string
  name: string
  conversationId: number
  /** 触发本次 run 的父会话工具调用 ID（内核受信注入；非用户输入）。 */
  parentToolCallId?: string
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
  nodes?: WorkflowRunSummary['nodes']
  progress?: WorkflowProgressEntry[]
  /** resume 用的脚本源（inline script 或文件路径二选一）。 */
  script?: string
  scriptPath?: string
  /** 保存目录里的具名工作流。 */
  savedName?: string
  /** 脚本 meta.description（脱敏后持久）。 */
  description?: string
  /** 脚本 meta.phases 阶段蓝图（脱敏后持久）。 */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /** 本次运行的实际 args（安全 JSON；resume 缺省沿用）。 */
  args?: unknown
  journalPath: string
  replayedFrom?: string
  /** run 种类：DSL 工作流（缺省）或受信后台单子代理（startBackgroundAgent）。 */
  kind?: 'workflow' | 'subagent'
  /** 后台子代理终态是否须向父会话投递通知（notifiedAt 防重复投递）。 */
  notifyParentOnSettle?: boolean
  notifiedAt?: number
  /** 后台子代理的 Profile 与执行环境元数据（onResolved 回传后补全）。 */
  subagentMeta?: { agentType?: string; execution?: AgentExecutionInfo }
}

/** 持久层读出的错误可打印形态（store 异常诊断用）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * run 索引最低限度形状校验：非数组、null 项、id/conversationId/createdAt
 * 非法都是持久层损坏（旧实现对每项直接 entry.id 访问，null 项会 TypeError）。
 * 只校验现行 RunIndexEntry 契约，无旧格式适配。合法返回 undefined；损坏
 * 返回问题描述 + 可辨识 runId（id 非法时用 `#位置` 定位）。
 */
function runIndexProblem(raw: unknown): { problem: string; runId: string } | undefined {
  if (!Array.isArray(raw)) return { problem: `索引非数组（${raw === null ? 'null' : typeof raw}）`, runId: '#root' }
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { problem: `第 ${i} 项非对象（${entry === null ? 'null' : typeof entry}）`, runId: `#${i}` }
    }
    const e = entry as Record<string, unknown>
    const at = `#${i}`
    if (typeof e['id'] !== 'string' || e['id'] === '') {
      return { problem: `第 ${i} 项 id 非字符串`, runId: at }
    }
    const runId = e['id'] as string
    if (!Number.isInteger(e['conversationId']) || (e['conversationId'] as number) < 1) {
      return { problem: `第 ${i} 项 conversationId 非正整数`, runId }
    }
    if (typeof e['createdAt'] !== 'number' || !Number.isFinite(e['createdAt'])) {
      return { problem: `第 ${i} 项 createdAt 非有限数值`, runId }
    }
  }
  return undefined
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'completed', 'failed', 'aborted']

/**
 * 持久记录最低限度形状校验：只检查现行 RunRecord 契约的必需字段（summary
 * 面所需），不做旧格式适配、不深校验可选段（nodes/progress 由消费方各自
 * 容错）。返回首个问题描述，合法则 undefined。
 */
function runRecordProblem(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return `非对象结构（${typeof record}）`
  }
  const r = record as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'] === '') return 'id 非字符串'
  if (typeof r['name'] !== 'string') return 'name 非字符串'
  if (!Number.isInteger(r['conversationId']) || (r['conversationId'] as number) < 1) {
    return 'conversationId 非正整数'
  }
  if (!RUN_STATUSES.includes(r['status'] as WorkflowRunStatus)) {
    return `status 非法（${JSON.stringify(r['status'])}）`
  }
  if (!Number.isFinite(r['createdAt']) || typeof r['createdAt'] !== 'number') return 'createdAt 非数值'
  if (!Number.isFinite(r['updatedAt']) || typeof r['updatedAt'] !== 'number') return 'updatedAt 非数值'
  if (typeof r['journalPath'] !== 'string') return 'journalPath 非字符串'
  if (r['error'] !== undefined && typeof r['error'] !== 'string') return 'error 非字符串'
  return undefined
}

interface ActiveRun {
  runId: string
  conversationId: number
  abort: AbortController
  /** run 结束（含 abort、子会话中止收尾、终态落盘）后 resolve；绝不 reject。 */
  done: Promise<void>
  /** 终态落盘/flush 失败时由 wait() 原样抛出（done 不 reject，避免无人 await 时 unhandled）。 */
  settleError?: unknown
  summary: WorkflowRunSummary
  journalPath: string
  writer: JournalWriter
  progress: WorkflowEntry[]
  timeline: WorkflowProgressEntry[]
  /** 在途子会话的中止 promise（close/abort 需 await 后才算真正结束）。 */
  pendingAborts: Set<Promise<void>>
  /**
   * 中止时需经 host.abortConversation 显式中止的子会话（startBackgroundAgent
   * 的原生子会话：signal 桥只调 conversation.abort，不经 tracker 全量结算；
   * 这里补充与 runtime.abortConversation 同级的确定性中止）。
   */
  abortChildConversations?: Set<number>
  /** progress 持久化节流（timeline 非空后定期落盘）。 */
  lastPersistAt: number
  /** 节点开始/结束必须推送的 workflow.updated 事件（有界频率内的强制点）。 */
  lastNodeEventAt: number
  /** 250ms 窗口内节点边界事件的 trailing timer：窗口内启动绝不丢失。 */
  pendingEventTimer?: ReturnType<typeof setTimeout>
}

/** progress 持久化最小间隔：高频进度不逐条落库。 */
const PROGRESS_PERSIST_INTERVAL_MS = 1_000

/** workflow.updated 节点事件最小间隔：有界频率，但节点开始/结束强制推送。 */
const NODE_EVENT_INTERVAL_MS = 250

/** 单个脚本的元数据损坏不阻断整个目录；保留该条目并返回诊断。 */
function summaryFromSource(name: string, path: string, source: string): SavedWorkflowSummary {
  try {
    const { meta } = extractMeta(source)
    return {
      name,
      path,
      description: meta.description,
      ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
      ...(meta.phases !== undefined ? { phases: meta.phases } : {}),
    }
  } catch (error) {
    return { name, path, metadataError: error instanceof Error ? error.message : String(error) }
  }
}

export class WorkflowService {
  private readonly dataDir: string
  private readonly host: WorkflowServiceHost
  private readonly state: WorkflowStateStore
  private readonly caps: Pick<WorkflowServiceOptions, 'concurrency' | 'agentCap' | 'itemCap' | 'nestedCap'>
  private readonly redact: (text: string) => string
  private readonly active = new Map<string, ActiveRun>()
  private closed = false
  /** init 幂等标记：仅恢复完整成功后置位；失败可重试。 */
  private recovered = false
  private recoveryPrepared = false
  private initPromise?: Promise<void>

  constructor(options: WorkflowServiceOptions) {
    this.dataDir = options.dataDir
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
  }

  // ------------------------------------------------------------------
  // 目录布局（journal 是唯一文件持久化）
  // ------------------------------------------------------------------

  private workflowsDir(): string {
    return join(this.dataDir, 'workflows')
  }

  private artifactsDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  private journalPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.jsonl`)
  }

  /**
   * 启动恢复：把跨重启遗留的 running run 显式标 failed。幂等；run() 首次调用
   * 前自动执行，也可由宿主显式调用。失败可重试：initPromise 仅在恢复完整
   * 成功（含 flush）后保留，异常时清缓存，下一次 init()/run() 重新执行。
   */
  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    if (this.host.prepareInterruptedConversations === undefined) return
    const index = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
    const childIds = new Set<number>()
    for (const entry of index) {
      const record = this.loadRecord(entry.id)
      if (record.kind !== 'subagent' || record.status !== 'running') continue
      const known = record.subagentMeta?.execution?.conversationId
      if (known !== undefined) childIds.add(known)
      for (const node of record.nodes ?? []) if (node.conversationId !== undefined) childIds.add(node.conversationId)
    }
    if (childIds.size > 0) await this.host.prepareInterruptedConversations([...childIds])
    this.recoveryPrepared = true
  }

  async init(): Promise<void> {
    if (this.recovered) return
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = (async () => {
      try {
        await this.prepareRecovery()
        const index = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
        let changed = false
        // 通知 outbox 补发：崩溃前已达终态但 onBackgroundAgentSettled 未成功（或
        // 未及调用）的记录。回调失败不阻断 init（stderr 诊断，notifiedAt 不置位，
        // 下次 init 重试）。
        const pendingNotifies: Array<() => Promise<void>> = []
        for (const entry of index) {
          const record = this.state.get<RunRecord | null>(runKey(entry.id), null)
          if (record === null) continue
          if (
            record.kind === 'subagent' &&
            record.notifyParentOnSettle === true &&
            record.status !== 'running' &&
            record.notifiedAt === undefined
          ) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.host.onBackgroundAgentSettled === undefined) return
              await this.host.onBackgroundAgentSettled(this.toSummary(target), {
                parentConversationId: target.conversationId,
                ...(target.subagentMeta ?? {}),
              })
              target.notifiedAt = Date.now()
              this.writeRecord(target)
            })
          }
          if (record.status !== 'running') continue
          if (record.kind === 'subagent') {
            const children = new Set<number>()
            const known = record.subagentMeta?.execution?.conversationId
            if (known !== undefined) children.add(known)
            for (const node of record.nodes ?? []) if (node.conversationId !== undefined) children.add(node.conversationId)
            // 全部执行已在 prepareRecovery 持久标记取消；此处仅等待真实终态，
            // 不能先回报 interrupted 却让旧模型回合继续运行。
            await Promise.all([...children].map((id) => this.host.abortConversation(id)))
          }
          record.status = 'failed'
          record.updatedAt = Date.now()
          record.error =
            record.kind === 'subagent'
              ? 'subagent run interrupted by process restart（可凭 conversationId/executionId 通过 resume 续接）'
              : `run interrupted by process restart（账本完好，可经 resumeFromRunId 恢复）：${record.error ?? ''}`.trim()
          if (record.kind === 'subagent' && record.nodes !== undefined) {
            record.nodes = record.nodes.map((node) => node.status === 'running' || node.status === 'pending'
              ? { ...node, status: 'failed', settledAt: record.updatedAt, error: record.error }
              : node)
          }
          this.state.set(runKey(entry.id), record)
          changed = true
          // interrupted 的 subagent 同样须补发通知（通知内容即 failed 终态本身）。
          if (record.kind === 'subagent' && record.notifyParentOnSettle === true && record.notifiedAt === undefined) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.host.onBackgroundAgentSettled === undefined) return
              await this.host.onBackgroundAgentSettled(this.toSummary(target), {
                parentConversationId: target.conversationId,
                ...(target.subagentMeta ?? {}),
              })
              target.notifiedAt = Date.now()
              this.writeRecord(target)
            })
          }
          this.host.emitEvent('workflow.updated', { run: this.toSummary(record) })
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
  // list：已保存工作流目录
  // ------------------------------------------------------------------

  /** 列出带 meta 声明的工作流脚本；非法 meta 附 metadataError，文件读取错误显式失败。 */
  list(): SavedWorkflowSummary[] {
    const dir = this.workflowsDir()
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      // 目录尚不存在：空列表是事实，不是降级。
      if (err.code === 'ENOENT') return []
      throw new HelmError('io_error', `无法读取工作流目录 ${dir}：${err.message}`, 500, {
        path: dir,
        code: err.code,
      })
    }
    const out: SavedWorkflowSummary[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.js')) continue
      const name = entry.slice(0, -3)
      if (!SAFE_NAME.test(name)) continue
      const path = join(dir, entry)
      let source: string
      try {
        source = readFileSync(path, 'utf-8')
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        // 列表是尽力而为的目录视图：单个文件不可读跳过但不隐瞒。
        if (err.code === 'ENOENT') continue
        throw new HelmError('io_error', `无法读取工作流脚本 ${path}：${err.message}`, 500, {
          path,
          code: err.code,
        })
      }
      // 非 workflow 的普通 .js（构建产物、草稿）不应出现在列表里。
      if (!hasMetaDeclaration(source)) continue
      out.push(summaryFromSource(name, path, source))
    }
    return out
  }

  // ------------------------------------------------------------------
  // run
  // ------------------------------------------------------------------

  /**
   * 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。
   * context 由内核受信注入（工具链真实 callId），不是用户可写输入；
   * HTTP/CLI 不传（无关联）。
   * @throws HelmError validation_error / not_found / workflow_action_uncertain / journal_read_failed。
   */
  async run(
    request: WorkflowRunRequest,
    context?: { parentToolCallId?: string },
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

    const conversationId = request.conversationId ?? 1
    let parent: ConversationSummary
    try {
      parent = this.host.getConversation(conversationId)
    } catch {
      throw new HelmError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, {
        conversationId,
      })
    }

    // --- resume 目标解析 ---------------------------------------------
    let replayFrom: RunRecord | undefined
    if (request.resumeFromRunId !== undefined) {
      replayFrom = this.loadRecord(request.resumeFromRunId)
      if (replayFrom.kind === 'subagent') {
        throw new HelmError('validation_error', '后台子代理运行没有工作流重放脚本；请用 execution.conversationId/executionId 通过 subagent resume 续接', 400, { runId: replayFrom.id })
      }
      if (replayFrom.status === 'running' && !this.active.has(replayFrom.id)) {
        // init() 已把跨重启 running 标 failed；此处 running 只可能是同进程旧状态。
        replayFrom.status = 'failed'
        replayFrom.error = 'run interrupted（账本完好，可经 resumeFromRunId 恢复）'
        this.state.set(runKey(replayFrom.id), replayFrom)
        await this.state.flush?.()
      }
      if (this.active.has(replayFrom.id)) {
        throw new HelmError('conflict', `工作流 ${replayFrom.id} 仍在运行中`, 409, { runId: replayFrom.id })
      }
    }

    // --- 脚本源 ------------------------------------------------------
    let script: string
    let scriptPath: string | undefined
    let savedName: string | undefined

    if (request.script !== undefined) {
      script = request.script
    } else if (request.name !== undefined) {
      savedName = request.name
      scriptPath = this.resolveSavedName(request.name)
      script = this.readScriptFile(scriptPath)
    } else if (request.scriptPath !== undefined) {
      scriptPath = this.resolveExplicitPath(request.scriptPath)
      script = this.readScriptFile(scriptPath)
    } else if (replayFrom !== undefined) {
      if (replayFrom.script !== undefined) {
        script = replayFrom.script
      } else if (replayFrom.scriptPath !== undefined) {
        scriptPath = replayFrom.scriptPath
        script = this.readScriptFile(scriptPath)
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
    mkdirSync(this.artifactsDir(conversationId), { recursive: true })
    const journalPath = this.journalPathFor(conversationId, runId)

    let replayEntries: readonly WorkflowJournalEntry[] = []
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
    }

    const abort = new AbortController()
    const createdAt = Date.now()
    const meta = this.peekMeta(script)

    const record: RunRecord = {
      id: runId,
      name: meta?.name ?? scriptPath ?? runId,
      conversationId,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      status: 'running',
      createdAt,
      updatedAt: createdAt,
      kind: 'workflow',
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

    const run: ActiveRun = {
      runId,
      conversationId,
      abort,
      done: Promise.resolve(),
      summary: this.toSummary(record),
      journalPath,
      writer: new JournalWriter(journalPath),
      progress: [],
      timeline: [],
      pendingAborts: new Set(),
      lastPersistAt: createdAt,
      lastNodeEventAt: createdAt,
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
        record.updatedAt = Date.now()
        record.nodes = this.redactNodes(this.nodesFromProgress(run.progress))
        record.progress = run.timeline
        run.summary = this.toSummary(record)
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
        // close 失败/持久化失败同样必须摘除 active 并等待子会话中止结束。
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
        this.host.emitEvent('workflow.updated', { run: { ...run.summary } })
        if (settleFailure !== undefined && run.settleError === undefined) {
          run.settleError = settleFailure
        }
      }
    }

    // 先落 running 快照（state store）：进程若死于此 run，重启后 init() 显式发现并标 failed。
    try {
      this.writeRecord(record, { index: true })
      await this.state.flush?.()
    } catch (error) {
      // running 快照都没能落库：不启动执行，不留任何 active/writer。
      await run.writer.close().catch(() => {})
      this.active.delete(runId)
      throw error
    }
    this.host.emitEvent('workflow.updated', { run: this.redactSummaryNodes({ ...run.summary }) })

    const engineHost = this.makeEngineHost(run, parent)

    run.done = (async () => {
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
              this.host.emitEvent('workflow.updated', {
                run: this.redactSummaryNodes({
                  ...run.summary,
                  updatedAt: at,
                  nodes: this.nodesFromProgress(run.progress),
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
            append: async (entry) => {
              await run.writer.append(entry)
            },
          },
        })
      } catch (error) {
        // 引擎在 worker 启动前拒绝（坏 meta、超限等）：无进度可折叠，直接失败。
        failure = error
      }
      await settleRun(result, failure)
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

    mkdirSync(this.artifactsDir(request.parentConversationId), { recursive: true })
    const journalPath = this.journalPathFor(request.parentConversationId, runId)

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
      // done 立即挂后台兜底链：从创建第一刻起 wait/abort/close 都有可等的终点。
      done: doneGate.then(() => undefined),
      summary: this.toSummary(record),
      journalPath,
      writer: new JournalWriter(journalPath),
      progress: [],
      timeline: [],
      pendingAborts: new Set(),
      abortChildConversations: new Set(),
      lastPersistAt: createdAt,
      lastNodeEventAt: createdAt,
    }
    this.active.set(runId, run)

    // abort(runId)/close() → 取消本 run 信号（spawn 信号桥停子会话回合）+
    // 经 host.abortConversation 确定性中止已 onResolved 的子会话（tracker 全量
    // 结算；幂等，已结束的子会话静默）。注册进 pendingAborts：settle 前必等完。
    const onRunAbort = (): void => {
      for (const childId of [...(run.abortChildConversations ?? [])]) {
        const pending = this.host
          .abortConversation(childId)
          .catch((error: unknown) => {
            process.stderr.write(
              `workflow ${runId}: abort conversation ${childId} failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          })
          .then(() => {
            run.pendingAborts.delete(pending)
          })
        run.pendingAborts.add(pending)
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
        record.nodes = this.redactNodes([node])
        run.summary = this.toSummary(record)
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
                ? { execution: redactExecutionMetadata(executionInfo, this.redact) }
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
        this.host.emitEvent('workflow.updated', { run: { ...run.summary } })
        this.active.delete(runId)
        settled = true
        if (settleError !== undefined) run.settleError = settleError
        resolveDone()
      }
    }

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
      this.writeRecord(record, { index: true })
      await this.state.flush?.()
    } catch (persistError) {
      this.active.delete(runId)
      await run.writer.close().catch(() => {})
      resolveDone()
      throw persistError
    }
    this.host.emitEvent('workflow.updated', { run: this.redactSummaryNodes({ ...run.summary }) })

    // --- 组装 proto 并发起 spawn -----------------------------------------
    const proto: AgentSpawnRequest = {
      ...request,
      ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
      agentId: agentIdForProto,
      workflowRunId: runId,
      onResolved: (raw: unknown) => {
        const info = sanitizeExecutionInfo(raw, { agentId: agentIdForProto })
        executionInfo = info
        if (info.nodeId !== undefined) node.nodeId = info.nodeId
        if (info.conversationId !== undefined) {
          node.conversationId = info.conversationId
          run.abortChildConversations?.add(info.conversationId)
        }
        if (info.executionId !== undefined) node.executionId = info.executionId
        if (info.effectiveCwd !== undefined) node.effectiveCwd = info.effectiveCwd
        if (info.worktree !== undefined) node.worktree = info.worktree
        record.subagentMeta = {
          ...(request.agentType !== undefined && request.agentType !== ''
            ? { agentType: request.agentType }
            : {}),
          // 持久面统一脱敏（effectiveCwd/worktree 路径可能含秘密 token）。
          execution: redactExecutionMetadata(info, this.redact),
        }
        record.nodes = this.redactNodes([node])
        run.summary = this.toSummary(record)
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
              node.gate = { ok: gate.ok, output: this.redact(gate.output) }
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
    this.host.emitEvent('workflow.updated', { run: this.redactSummaryNodes({ ...run.summary }) })

    return {
      run: this.redactSummaryNodes({ ...run.summary }),
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
        activeRun.progress.length > 0 ? this.nodesFromProgress(activeRun.progress) : activeRun.summary.nodes
      return this.redactSummaryNodes({
        ...activeRun.summary,
        ...(collapsed !== undefined ? { nodes: collapsed } : {}),
        ...(activeRun.timeline.length > 0 ? { progress: [...activeRun.timeline] } : {}),
      })
    }
    return this.toSummary(this.loadRecord(runId))
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
    let raw: unknown
    try {
      raw = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
    } catch (error) {
      // 索引本体读不出来：与单条记录故障同级的持久层服务故障。
      throw new HelmError(
        'workflow_index_corrupt',
        `读取工作流 run 索引失败：${errorMessage(error)}`,
        500,
        { key: INDEX_KEY },
      )
    }
    // 索引是持久层外部输入：非数组/null 项/字段非法显式报损坏（带 key 与可
    // 辨识 runId），绝不强转后拿 entry.id TypeError 或当有效列表。
    const broken = runIndexProblem(raw)
    if (broken !== undefined) {
      throw new HelmError(
        'workflow_index_corrupt',
        `工作流 run 索引损坏（${broken.problem}）`,
        500,
        { key: INDEX_KEY, runId: broken.runId },
      )
    }
    const index = raw as RunIndexEntry[]
    const out: WorkflowRunSummary[] = []
    const seen = new Set<string>()
    for (const active of this.active.values()) {
      seen.add(active.runId)
      const collapsed =
        active.progress.length > 0 ? this.nodesFromProgress(active.progress) : active.summary.nodes
      out.push(
        this.redactSummaryNodes({
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
        out.push(this.toSummary(this.loadRecord(entry.id)))
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') {
          throw this.indexCorruptError(entry.id, `记录缺失或 ID 不符：${error.message}`)
        }
        if (error instanceof HelmError && error.code === 'workflow_record_corrupt') throw error
        throw this.indexCorruptError(entry.id, `记录损坏：${errorMessage(error)}`)
      }
    }
    // 新建在前契约是全局的：active.values() 是旧先新后的插入序，较早创建的
    // 活跃 run 不能排在较新的终态历史之前——合并去重后统一 createdAt 倒序。
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
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

  /** 中止 run：强杀 worker 线程 + 取消在途子会话；不遗留 worker。 */
  async abort(runId: string): Promise<void> {
    const activeRun = this.active.get(runId)
    if (activeRun === undefined) {
      // 历史 run 幂等：不存在的才报错。
      this.getRun(runId)
      return
    }
    activeRun.abort.abort()
    // 启动期（尚未 onResolved）也必须等待真实退出：与运行期同一 done 通道
    //（startBackgroundAgent 在 onResolved 前后都把收尾挂到 run.done），
    // 返回时 run 已终态、active 已移除、无未处理 rejection。
    await activeRun.done
    if (activeRun.settleError !== undefined) throw activeRun.settleError
  }

  async close(): Promise<void> {
    this.closed = true
    const inFlight = [...this.active.values()]
    for (const run of inFlight) run.abort.abort()
    await Promise.all(inFlight.map((run) => run.done))
    await this.state.flush?.()
  }

  // ------------------------------------------------------------------
  // host 适配：引擎 WorkflowHost <-> WorkflowServiceHost
  // ------------------------------------------------------------------

  private makeEngineHost(run: ActiveRun, parent: ConversationSummary): WorkflowHost {
    const service = this
    /** agentId → 子会话 id（onResolved 建立；abort 使用）。 */
    const conversationByAgent = new Map<string, number>()

    return {
      async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
        return service.invokeSpawn(run, parent, conversationByAgent, request, false)
      },
      async resumeAgent(agentId, prompt, options): Promise<WorkflowSpawnResult> {
        return service.invokeSpawn(
          run,
          parent,
          conversationByAgent,
          {
            agentId,
            index: -1,
            prompt,
            label: agentId,
            // resume 缺省不携带 agentType（不重配原子会话 Profile）；
            // schema/gate/回调由引擎续接调用原样下传。
            agentType: '',
            ...(options?.schema !== undefined ? { schema: options.schema } : {}),
            ...(options?.gate !== undefined ? { gate: options.gate } : {}),
            ...(options?.onResolved !== undefined ? { onResolved: options.onResolved } : {}),
            ...(options?.onGateResult !== undefined ? { onGateResult: options.onGateResult } : {}),
          },
          true,
        )
      },
      abortAgent(agentId: string): void {
        const convId = conversationByAgent.get(agentId)
        if (convId === undefined) return
        // 只中止本 run 派生的子会话。fire-and-forget 会让 abort/close 返回时子会话
        // 仍在跑——记入 pendingAborts 由 done 收尾统一 await；不存在（已结束）时
        // abortConversation 幂等静默，但 rejection 仍须诊断，绝不吞。
        const pending = service.host
          .abortConversation(convId)
          .catch((error: unknown) => {
            process.stderr.write(
              `workflow ${run.runId}: abort conversation ${convId} failed: ${error instanceof Error ? error.message : String(error)}\n`,
            )
          })
          .then(() => {
            run.pendingAborts.delete(pending)
          })
        // 先注册再执行：catch 链已保证 pending 不 reject，then 删除自引用安全。
        run.pendingAborts.add(pending)
      },
      ...(service.host.runGate !== undefined
        ? {
            runGate: async (command: string, options: { agentId: string; cwd?: string }) => {
              const convId = conversationByAgent.get(options.agentId)
              // cwd 只用引擎确认过的值（result.cwd / 回传元数据）；缺省父会话
              // cwd，绝不猜测远端工作目录。
              return service.host.runGate!(command, {
                ...(options.cwd !== undefined ? { cwd: options.cwd } : { cwd: parent.cwd }),
                ...(convId !== undefined ? { conversationId: convId } : { conversationId: parent.id }),
                signal: run.abort.signal,
              })
            },
          }
        : {}),
      async invokeAction(actionId, input, context) {
        const resolved = service.resolveActionId(actionId)
        const result = await service.host.invokeAction(resolved.pluginId, resolved.actionId, input, {
          conversationId: run.conversationId,
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        })
        return { pluginId: resolved.pluginId, actionId: resolved.actionId, result }
      },
      loadWorkflow: (ref) => service.loadWorkflowRef(ref),
    }
  }

  /** 单次 agent/resume 调用：组装 protocol AgentSpawnRequest 投 agent_spawn 管道。 */
  private async invokeSpawn(
    run: ActiveRun,
    parent: ConversationSummary,
    conversationByAgent: Map<string, number>,
    request: WorkflowSpawnRequest,
    isResume: boolean,
  ): Promise<WorkflowSpawnResult> {
    if (this.closed || run.abort.signal.aborted) {
      return { ok: false, error: 'Workflow aborted.' }
    }

    // 引擎内 agentId（wf-agent-N）跨 run 重复；全局 agentSessions 是进程级
    // Map，两个同 parent 的并行 run 会互相覆盖对方的映射，resume 可能续接错
    // child。投给 native 的稳定 ID加 runId 命名空间；引擎内部 ID/label 不变。
    const nativeAgentId = `${run.runId}:${request.agentId}`
    // resume 严格续接：优先用本 run 内 spawn 时记录的 convId；仅当本 run 未见
    // 过（如 resume 自重放账本的 agent）才退回 native 全局映射。
    const knownConvId = conversationByAgent.get(request.agentId)
    const resumeRef = isResume ? String(knownConvId ?? nativeAgentId) : undefined

    /** 已 sanitized 的执行元数据（onResolved 可能与 spawn 返回前多次回调——幂等只记最新）。 */
    let executionInfo: AgentExecutionInfo | undefined
    /** 已 sanitized 的 gate 回报（执行环境内恰好一次执行后的结果）。 */
    let gateResult: AgentGateResult | undefined

    const proto: AgentSpawnRequest = {
      parentConversationId: run.conversationId,
      prompt: request.prompt,
      agentId: nativeAgentId,
      // gate 原样下传：执行权在实际执行环境（native 子会话 cwd / herdr 窗格），
      // 经 onGateResult 回报后引擎免二次执行。
      ...(request.gate !== undefined ? { gate: request.gate } : {}),
      ...(request.agentType !== '' ? { agentType: request.agentType } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
      ...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
      ...(resumeRef !== undefined ? { resume: resumeRef } : {}),
      // cwd 不注入：执行行按自身链解析（原生 request>Profile>parent镜像>Hub；
      // herdr request>Profile.workspace>parent>Hub）。引擎层注入会压过 Profile
      // 路由，resume 时更会把已建子会话/Worktree 的实际 cwd 重置回父目录。
      workflowRunId: run.runId,
      onResolved: (raw: unknown) => {
        const info = sanitizeExecutionInfo(raw, { agentId: nativeAgentId })
        executionInfo = info
        if (info.conversationId !== undefined) {
          conversationByAgent.set(request.agentId, info.conversationId)
        }
        request.onResolved?.(info)
      },
      ...(request.gate !== undefined
        ? {
            onGateResult: (raw: unknown) => {
              gateResult = sanitizeGateResult(raw, { agentId: nativeAgentId })
              request.onGateResult?.(gateResult)
            },
          }
        : {}),
      signal: run.abort.signal,
    }

    try {
      const raw = await this.host.spawnAgent(proto)
      // native 返回：有 schema → 已校验对象（转 JSON 交引擎复核）；无 schema → 文本。
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      // 外部执行环境（executionId 存在）必须回报 gate；缺失即显式失败，
      // 绝不在本机猜远端工作目录补跑。
      if (request.gate !== undefined && gateResult === undefined && executionInfo?.executionId !== undefined) {
        throw gateResultMissingError({
          agentId: nativeAgentId,
          executionId: executionInfo.executionId,
          command: request.gate,
        })
      }
      return {
        ok: true,
        text,
        ...(executionInfo !== undefined ? { executionInfo } : {}),
        ...(gateResult !== undefined ? { gate: gateResult } : {}),
      }
    } catch (error) {
      if (error instanceof HelmError) {
        // 错误码随消息透传（节点 error 面向用户，码即诊断锚点）。
        return {
          ok: false,
          error: `[${error.code}] ${error.message}`,
          ...(gateResult !== undefined ? { gate: gateResult } : {}),
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /**
   * 全限定 actionId 解析：以 listActions() 的 manifest 精确匹配。
   * pluginId 含 ':'（builtin:assistant），actionId 理论上可含 '.'，简单 split
   * 会在坏点号上错位——只信 manifest。
   */
  private resolveActionId(qualified: string): { pluginId: string; actionId: string } {
    const manifests = this.host.listActions()
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

  /** 嵌套 workflow() 引用解析：仅允许保存目录安全名或显式本地路径。 */
  private loadWorkflowRef(
    ref: { name?: string; scriptPath?: string },
  ): { ok: true; script: string; path?: string } | { ok: false; message: string } {
    try {
      if (ref.name !== undefined) {
        const path = this.resolveSavedName(ref.name)
        return { ok: true, script: this.readScriptFile(path), path }
      }
      if (ref.scriptPath !== undefined) {
        const path = this.resolveExplicitPath(ref.scriptPath)
        return { ok: true, script: this.readScriptFile(path), path }
      }
      return { ok: false, message: 'workflow() 引用需要 name 或 scriptPath' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // ------------------------------------------------------------------
  // 脚本源解析
  // ------------------------------------------------------------------

  private resolveSavedName(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `工作流名称 "${name}" 非法：需匹配 ${SAFE_NAME.source}（防路径穿越）`,
        400,
        { name },
      )
    }
    // SAFE_NAME 已排除 '/'，但 symlink 可能把名字重新指到目录外：realpath 校验
    // 解析后的真实路径仍在 workflows 目录内。
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    try {
      const real = realpathSync(target)
      const realDir = realpathSync(dir)
      if (real !== join(realDir, `${name}.js`)) {
        throw new HelmError(
          'validation_error',
          `工作流 "${name}" 是指向目录外的符号链接（${real}），已拒绝`,
          400,
          { name, real },
        )
      }
      return target
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return target // 不存在：readScriptFile 报 not_found
      throw new HelmError('io_error', `无法解析工作流路径 ${target}：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  private resolveExplicitPath(scriptPath: string): string {
    // 显式用户文件路径：可读即用，不承诺沙箱（与文档一致）。
    return resolve(scriptPath)
  }

  private readScriptFile(path: string): string {
    let source: string
    try {
      const st = statSync(path)
      if (!st.isFile()) {
        throw new HelmError('not_found', `工作流脚本不是常规文件：${path}`, 404, { path })
      }
      source = readFileSync(path, 'utf-8')
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('not_found', `工作流脚本文件不可读（${err.code ?? 'unknown'}）：${path}`, 404, {
        path,
        code: err.code,
      })
    }
    if (source.length > MAX_SCRIPT_LENGTH) {
      throw new HelmError(
        'validation_error',
        `工作流脚本 ${source.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`,
        400,
        { path },
      )
    }
    return source
  }

  /** 提取完整 meta（失败回退 undefined，完整校验在引擎 validateScript）。 */
  private peekMeta(script: string): WorkflowMeta | undefined {
    try {
      return extractMeta(script).meta
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------
  // state store 读写（单库）
  // ------------------------------------------------------------------

  /** 写 run doc；新 run 同时追加索引。 */
  private writeRecord(record: RunRecord, options: { index?: boolean } = {}): void {
    this.state.set(runKey(record.id), record)
    if (options.index === true) {
      const index = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
      index.push({ id: record.id, conversationId: record.conversationId, createdAt: record.createdAt })
      this.state.set(INDEX_KEY, index)
    }
  }

  private loadRecord(runId: string): RunRecord {
    let record: unknown
    try {
      record = this.state.get<RunRecord | null>(runKey(runId), null)
    } catch (error) {
      // store 抛错（IO/解析）是持久层故障，绝不 TS 强转后当 not_found 混过。
      throw new HelmError(
        'workflow_record_corrupt',
        `读取工作流运行 ${runId} 持久记录失败：${errorMessage(error)}`,
        500,
        { runId, key: runKey(runId) },
      )
    }
    // 先验证是对象再访问 id：null/原始值/数组绝不 record.id TypeError。
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      if (record === null) {
        throw new HelmError('not_found', `工作流运行 ${runId} 不存在`, 404, { runId })
      }
      throw new HelmError(
        'workflow_record_corrupt',
        `工作流运行 ${runId} 持久记录损坏（非对象结构：${Array.isArray(record) ? 'array' : typeof record}）`,
        500,
        { runId },
      )
    }
    const asRecord = record as Record<string, unknown>
    if (asRecord['id'] !== runId) {
      throw new HelmError('not_found', `工作流运行 ${runId} 不存在`, 404, { runId })
    }
    // 边界形状校验：持久层是外部输入（state.sqlite 命名空间 doc），TS 强转
    // 会把错误结构当有效摘要。缺关键字段/状态非法即 workflow_record_corrupt
    // （500），与「run 不存在」的 404 区分；只校验现行 RunRecord 契约，无旧
    // 格式适配。
    const problem = runRecordProblem(record)
    if (problem !== undefined) {
      throw new HelmError(
        'workflow_record_corrupt',
        `工作流运行 ${runId} 持久记录损坏（${problem}）`,
        500,
        { runId, problem },
      )
    }
    return record as RunRecord
  }

  /** listRuns 索引损坏诊断（不自动删索引或记录：修复由人类确认）。 */
  private indexCorruptError(runId: string, reason: string): HelmError {
    return new HelmError(
      'workflow_index_corrupt',
      `工作流 run 索引损坏（${reason}）；列表无法完整呈现，请检查 state store`,
      500,
      { runId },
    )
  }

  private toSummary(record: RunRecord): WorkflowRunSummary {
    return {
      id: record.id,
      name: record.name,
      conversationId: record.conversationId,
      ...(record.kind !== undefined ? { kind: record.kind } : {}),
      ...(record.description !== undefined ? { description: record.description } : {}),
      ...(record.phases !== undefined ? { phases: record.phases } : {}),
      ...(record.parentToolCallId !== undefined && record.parentToolCallId !== ''
        ? { parentToolCallId: record.parentToolCallId }
        : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.nodes !== undefined ? { nodes: record.nodes } : {}),
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
      ...(record.replayedFrom !== undefined ? { replayedFrom: record.replayedFrom } : {}),
    }
  }

  /** summary 出口统一逐值脱敏（nodes 里的元数据不能漏 Token）。 */
  private redactSummaryNodes(summary: WorkflowRunSummary): WorkflowRunSummary {
    if (summary.nodes === undefined) return summary
    return { ...summary, nodes: summary.nodes.map((node) => this.redactNode(node)) }
  }

  /** progress 折叠后的节点元数据逐值脱敏（落库/事件前）。 */
  private redactNodes(nodes: NonNullable<WorkflowRunSummary['nodes']>): NonNullable<WorkflowRunSummary['nodes']> {
    return nodes.map((node) => this.redactNode(node))
  }

  private redactNode(node: NonNullable<WorkflowRunSummary['nodes']>[number]): NonNullable<WorkflowRunSummary['nodes']>[number] {
    const redacted = redactJsonValue(node, this.redact) as NonNullable<WorkflowRunSummary['nodes']>[number]
    if (redacted.label !== undefined) redacted.label = this.redact(redacted.label)
    if (redacted.prompt !== undefined) redacted.prompt = this.redact(redacted.prompt)
    if (redacted.effectiveCwd !== undefined) redacted.effectiveCwd = this.redact(redacted.effectiveCwd)
    if (redacted.worktree !== undefined) {
      redacted.worktree = redactJsonValue(redacted.worktree, this.redact) as NonNullable<AgentExecutionInfo['worktree']>
    }
    if (redacted.gate !== undefined) {
      redacted.gate = { ok: redacted.gate.ok, output: this.redact(redacted.gate.output) }
    }
    if (redacted.gateCommand !== undefined) redacted.gateCommand = this.redact(redacted.gateCommand)
    if (redacted.model !== undefined) redacted.model = this.redact(redacted.model)
    if (redacted.error !== undefined) redacted.error = this.redact(redacted.error)
    if (redacted.output !== undefined) redacted.output = redactJsonValue(redacted.output, this.redact)
    return redacted
  }

  // ------------------------------------------------------------------
  // progress → nodes 折叠（inspect 视图）
  // ------------------------------------------------------------------

  private nodesFromProgress(progress: readonly WorkflowEntry[]): NonNullable<WorkflowRunSummary['nodes']> {
    const collapsed = collapse(progress)
    // agent 与 action 共享同一全序位次：混合调用时必须按 index 升序输出，
    // 先遍历 agents 再遍历 actions 会把两类节点拆散重排。
    const merged: Array<{ index: number; node: NonNullable<WorkflowRunSummary['nodes']>[number] }> = []
    for (const agent of collapsed.agents) {
      merged.push({
        index: agent.index,
        node: {
          id: `agent-${agent.index}`,
          kind: 'agent',
          status:
            agent.state === 'done'
              ? 'done'
              : agent.state === 'error'
                ? agent.skipped
                  ? 'skipped'
                  : 'failed'
                : agent.queuedAt !== undefined && agent.startedAt === undefined
                  ? 'pending'
                  : 'running',
          ...(agent.cached !== undefined ? { cached: agent.cached } : {}),
          ...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
          ...(agent.label !== undefined ? { label: agent.label } : {}),
          ...(agent.nodeId !== undefined ? { nodeId: agent.nodeId } : {}),
          ...(agent.conversationId !== undefined ? { conversationId: agent.conversationId } : {}),
          ...(agent.executionId !== undefined ? { executionId: agent.executionId } : {}),
          ...(agent.effectiveCwd !== undefined ? { effectiveCwd: agent.effectiveCwd } : {}),
          ...(agent.worktree !== undefined ? { worktree: agent.worktree } : {}),
          ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
          ...(agent.phaseTitle !== undefined ? { phaseTitle: agent.phaseTitle } : {}),
          ...(agent.gateCommand !== undefined ? { gateCommand: agent.gateCommand } : {}),
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
          ...(agent.prompt !== undefined ? { prompt: agent.prompt } : {}),
          ...(agent.schema !== undefined ? { schema: agent.schema } : {}),
          ...(agent.gate !== undefined ? { gate: agent.gate } : {}),
          ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
          ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
          ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
          ...(agent.lastProgressAt !== undefined ? { settledAt: agent.lastProgressAt } : {}),
          ...(agent.state === 'done' && agent.resultPreview !== undefined ? { output: agent.resultPreview } : {}),
          ...(agent.error !== undefined ? { error: agent.error } : {}),
        },
      })
    }
    for (const action of collapsed.actions) {
      merged.push({
        index: action.index,
        node: {
          id: `action-${action.index}`,
          kind: 'action',
          label: action.actionId,
          status:
            action.state === 'done'
              ? 'done'
              : action.state === 'error'
                ? 'failed'
                : action.queuedAt !== undefined && action.startedAt === undefined
                  ? 'pending'
                  : 'running',
          ...(action.cached !== undefined ? { cached: action.cached } : {}),
          ...(action.phaseIndex !== undefined ? { phaseIndex: action.phaseIndex } : {}),
          ...(action.phaseTitle !== undefined ? { phaseTitle: action.phaseTitle } : {}),
          ...(action.startedAt !== undefined ? { startedAt: action.startedAt } : {}),
          ...(action.lastProgressAt !== undefined ? { settledAt: action.lastProgressAt } : {}),
          ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
          ...(action.state === 'done' && action.resultPreview !== undefined ? { output: action.resultPreview } : {}),
          ...(action.error !== undefined ? { error: action.error } : {}),
        },
      })
    }
    merged.sort((a, b) => a.index - b.index)
    return merged.map((entry) => entry.node)
  }

  private assertNotClosed(): void {
    if (this.closed) throw new HelmError('closed', 'WorkflowService 已关闭', 409)
  }
}
