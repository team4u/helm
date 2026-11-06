/**
 * service.ts — WorkflowService：工作流引擎对内核/HTTP 层的唯一出口。
 *
 * 职责：
 * - 请求校验（name/script/scriptPath 恰一、512KB 上限、安全 name）；
 * - run 生命周期（后台启动立即返回 summary、wait/abort/getRun）；
 * - 持久化（单库设计）：run 索引与每 run summary 存入注入的 state store
 *   （@helm/kernel 唯一 state.sqlite 的命名空间 doc），启动恢复时把遗留
 *   running 显式标 failed(interrupted)。唯一文件例外是统一前缀重放账本
 *   dataDir/artifacts/<convId>/workflow-<runId>.jsonl——副作用重放语义要求
 *   append+fsync，SQLite 不适配；
 * - host 适配：runtime.ts 的 WorkflowHost（引擎接缝）↔ WorkflowServiceHost
 *   （KernelRuntime 注入：spawnAgent=agent_spawn 管道、invokeAction=PluginHost
 *   动作总线、getConversation/abortConversation、emitEvent、可选 runGate）；
 * - 恢复语义：resumeFromRunId 重放 journal；started 无终态的 action 调用显式报
 *   workflow_action_uncertain（409），由人类确认，绝不自动重跑副作用。
 *
 * 引擎本体（runtime.ts）零内核依赖；本文件是唯一 import kernel 侧类型的适配层。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  HelmError,
  type ActionManifest,
  type AgentSpawnRequest,
  type ConversationSummary,
  type WorkflowJournalEntry,
  type WorkflowProgressEntry,
  type WorkflowRunRequest,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { JournalWriter, readJournal } from './journal.js'
import { extractMeta, hasMetaDeclaration } from './meta.js'
import { collapse, type WorkflowEntry } from './progress.js'
import {
  MAX_SCRIPT_LENGTH,
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
   * gate 门禁执行（KernelRuntime.runGate：shell + SecretStash env 合并 + 超时）。
   * 可选：缺省宿主让带 gate 的 agent 调用显式失败——静默跳过的 gate 等于把
   * 未验证的工作标记为已验证。cwd 传子会话工作目录（如有），否则父会话 cwd。
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
  journalPath: string
  replayedFrom?: string
}

interface ActiveRun {
  runId: string
  conversationId: number
  abort: AbortController
  /** run 结束（含 abort）后 resolve。 */
  done: Promise<void>
  summary: WorkflowRunSummary
  journalPath: string
  writer: JournalWriter
  progress: WorkflowEntry[]
  timeline: WorkflowProgressEntry[]
}

export class WorkflowService {
  private readonly dataDir: string
  private readonly host: WorkflowServiceHost
  private readonly state: WorkflowStateStore
  private readonly caps: Pick<WorkflowServiceOptions, 'concurrency' | 'agentCap' | 'itemCap' | 'nestedCap'>
  private readonly active = new Map<string, ActiveRun>()
  private closed = false
  private recovered = false

  constructor(options: WorkflowServiceOptions) {
    this.dataDir = options.dataDir
    this.host = options.host
    this.state = options.state
    this.caps = {
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.agentCap !== undefined ? { agentCap: options.agentCap } : {}),
      ...(options.itemCap !== undefined ? { itemCap: options.itemCap } : {}),
      ...(options.nestedCap !== undefined ? { nestedCap: options.nestedCap } : {}),
    }
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
   * 启动恢复：把跨重启遗留的 running run 显式标 failed。
   * 幂等；run() 首次调用前自动执行，也可由宿主显式调用。
   */
  async init(): Promise<void> {
    if (this.recovered) return
    this.recovered = true
    const index = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
    let changed = false
    for (const entry of index) {
      const record = this.state.get<RunRecord | null>(runKey(entry.id), null)
      if (record === null || record.status !== 'running') continue
      record.status = 'failed'
      record.updatedAt = Date.now()
      record.error =
        `run interrupted by process restart（账本完好，可经 resumeFromRunId 恢复）：${record.error ?? ''}`.trim()
      this.state.set(runKey(entry.id), record)
      changed = true
      this.host.emitEvent('workflow.updated', this.toSummary(record))
    }
    if (changed) await this.state.flush?.()
  }

  // ------------------------------------------------------------------
  // list：已保存工作流目录
  // ------------------------------------------------------------------

  /** 列出 dataDir/workflows 下可复用的工作流脚本（仅 meta 声明合法的 .js 文件）。 */
  list(): Array<{ name: string; path: string }> {
    const dir = this.workflowsDir()
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const out: Array<{ name: string; path: string }> = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.js')) continue
      const name = entry.slice(0, -3)
      if (!SAFE_NAME.test(name)) continue
      const path = join(dir, entry)
      let source: string
      try {
        source = readFileSync(path, 'utf-8')
      } catch {
        continue
      }
      // 非 workflow 的普通 .js（构建产物、草稿）不应出现在列表里。
      if (!hasMetaDeclaration(source)) continue
      out.push({ name, path })
    }
    return out
  }

  // ------------------------------------------------------------------
  // run
  // ------------------------------------------------------------------

  /**
   * 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。
   * @throws HelmError validation_error / not_found / workflow_action_uncertain。
   */
  async run(request: WorkflowRunRequest): Promise<WorkflowRunSummary> {
    this.assertNotClosed()
    await this.init()

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

    // --- journal（resume 重放 + 本 run 记账） -------------------------
    const runId = newRunId()
    mkdirSync(this.artifactsDir(conversationId), { recursive: true })
    const journalPath = this.journalPathFor(conversationId, runId)

    let replayEntries: readonly WorkflowJournalEntry[] = []
    if (replayFrom !== undefined) {
      const journal = readJournal(replayFrom.journalPath)
      if (journal.actionUncertain) {
        // 上一 run 死于动作执行中：副作用是否发生不可判定，显式交人类决策。
        throw new HelmError(
          'workflow_action_uncertain',
          `工作流 ${replayFrom.id} 的账本存在已开始但未确认完成的动作调用，无法安全恢复；` +
            '请人工确认该动作副作用后，从其 journal 中移除对应 action_started 行或放弃 resume',
          409,
          { priorRunId: replayFrom.id, journalPath: replayFrom.journalPath },
        )
      }
      replayEntries = journal.entries
    }

    const abort = new AbortController()
    const createdAt = Date.now()
    const metaName = this.peekMetaName(script)

    const record: RunRecord = {
      id: runId,
      name: metaName ?? scriptPath ?? runId,
      conversationId,
      status: 'running',
      createdAt,
      updatedAt: createdAt,
      ...(scriptPath === undefined ? { script } : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
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
    }
    this.active.set(runId, run)

    // 先落 running 快照（state store）：进程若死于此 run，重启后 init() 显式发现并标 failed。
    this.writeRecord(record, { index: true })
    await this.state.flush?.()
    this.host.emitEvent('workflow.updated', { ...run.summary })

    const engineHost = this.makeEngineHost(run, parent)

    run.done = (async () => {
      let result: WorkflowRunResult | undefined
      try {
        result = await runWorkflow({
          script,
          ...(request.args !== undefined ? { args: request.args } : {}),
          host: engineHost,
          signal: abort.signal,
          ...this.caps,
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
            run.summary.updatedAt = Date.now()
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
        run.summary.status = 'failed'
        run.summary.error = error instanceof Error ? error.message : String(error)
        run.summary.updatedAt = Date.now()
      } finally {
        await run.writer.close()
      }

      if (result !== undefined) {
        record.status = result.status === 'killed' ? 'aborted' : result.status
        if (result.error !== undefined) record.error = result.error
        if (result.value !== undefined) record.result = result.value
      }
      record.updatedAt = Date.now()
      record.nodes = this.nodesFromProgress(run.progress)
      record.progress = run.timeline

      run.summary = this.toSummary(record)
      this.writeRecord(record)
      await this.state.flush?.()
      this.active.delete(runId)
      this.host.emitEvent('workflow.updated', { ...run.summary })
    })()

    return { ...run.summary }
  }

  // ------------------------------------------------------------------
  // getRun / wait / abort
  // ------------------------------------------------------------------

  /** 内存优先，回落 state store（跨重启 inspect）。 */
  getRun(runId: string): WorkflowRunSummary {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      return { ...activeRun.summary, nodes: this.nodesFromProgress(activeRun.progress) }
    }
    return this.toSummary(this.loadRecord(runId))
  }

  /** 等待 run 完成并返回其结果（历史 run 直接返回 result）。 */
  async wait(runId: string): Promise<unknown> {
    const activeRun = this.active.get(runId)
    if (activeRun !== undefined) {
      await activeRun.done
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
    await activeRun.done
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
    /** agentId → 子会话 id（onCreated 建立；abort/gate 使用）。 */
    const conversationByAgent = new Map<string, number>()

    return {
      async spawnAgent(request: WorkflowSpawnRequest): Promise<WorkflowSpawnResult> {
        return service.invokeSpawn(run, parent, conversationByAgent, request, false)
      },
      async resumeAgent(agentId, prompt, onResolved): Promise<WorkflowSpawnResult> {
        return service.invokeSpawn(
          run,
          parent,
          conversationByAgent,
          {
            agentId,
            index: -1,
            prompt,
            label: agentId,
            agentType: '',
            ...(onResolved !== undefined ? { onResolved } : {}),
          },
          true,
        )
      },
      abortAgent(agentId: string): void {
        const convId = conversationByAgent.get(agentId)
        if (convId === undefined) return
        // 只中止本 run 派生的子会话；不存在（已结束）时静默幂等。
        void service.host.abortConversation(convId).catch(() => {})
      },
      ...(service.host.runGate !== undefined
        ? {
            runGate: async (command: string, options: { agentId: string; cwd?: string }) => {
              const convId = conversationByAgent.get(options.agentId)
              return service.host.runGate!(command, {
                // gate 在子会话 cwd 内执行（如有），否则父会话 cwd。
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

    let gateCwd: string | undefined
    const proto: AgentSpawnRequest = {
      parentConversationId: run.conversationId,
      prompt: request.prompt,
      agentId: request.agentId,
      // gate 不下传：执行权在本服务 runGate（对齐决策：恰好执行一次）。
      ...(request.agentType !== '' ? { agentType: request.agentType } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
      ...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
      ...(isResume ? { resume: request.agentId } : {}),
      cwd: parent.cwd,
      onCreated: (conversationId: number) => {
        conversationByAgent.set(request.agentId, conversationId)
        // 子会话真实 cwd 供 gate 使用（若与父不同）。
        try {
          const child = this.host.getConversation(conversationId)
          if (child.cwd !== parent.cwd) gateCwd = child.cwd
        } catch {
          // 会话查询失败不阻断 spawn；gate 回退父 cwd。
        }
        request.onResolved?.({ conversationId })
      },
      signal: run.abort.signal,
    }

    try {
      const raw = await this.host.spawnAgent(proto)
      // native 返回：有 schema → 已校验对象（转 JSON 交引擎复核）；无 schema → 文本。
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      return {
        ok: true,
        text,
        ...(gateCwd !== undefined ? { cwd: gateCwd } : {}),
      }
    } catch (error) {
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
    return join(this.workflowsDir(), `${name}.js`)
  }

  private resolveExplicitPath(scriptPath: string): string {
    return resolve(scriptPath)
  }

  private readScriptFile(path: string): string {
    let source: string
    try {
      source = readFileSync(path, 'utf-8')
    } catch {
      throw new HelmError('not_found', `工作流脚本文件不可读：${path}`, 404, { path })
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

  /** 快速提取 meta.name（失败回退 undefined，完整校验在引擎 validateScript）。 */
  private peekMetaName(script: string): string | undefined {
    try {
      return extractMeta(script).meta.name
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
    const record = this.state.get<RunRecord | null>(runKey(runId), null)
    if (record === null || record.id !== runId) {
      throw new HelmError('not_found', `工作流运行 ${runId} 不存在`, 404, { runId })
    }
    return record
  }

  private toSummary(record: RunRecord): WorkflowRunSummary {
    return {
      id: record.id,
      name: record.name,
      conversationId: record.conversationId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.nodes !== undefined ? { nodes: record.nodes } : {}),
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
    }
  }

  // ------------------------------------------------------------------
  // progress → nodes 折叠（inspect 视图）
  // ------------------------------------------------------------------

  private nodesFromProgress(progress: readonly WorkflowEntry[]): WorkflowRunSummary['nodes'] {
    const collapsed = collapse(progress)
    const nodes: NonNullable<WorkflowRunSummary['nodes']> = []
    for (const agent of collapsed.agents) {
      nodes.push({
        id: `agent-${agent.index}`,
        kind: 'agent',
        status:
          agent.state === 'done'
            ? 'done'
            : agent.state === 'error'
              ? agent.skipped
                ? 'skipped'
                : 'failed'
              : 'running',
        ...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(agent.lastProgressAt !== undefined ? { settledAt: agent.lastProgressAt } : {}),
        ...(agent.state === 'done' && agent.resultPreview !== undefined ? { output: agent.resultPreview } : {}),
        ...(agent.error !== undefined ? { error: agent.error } : {}),
      })
    }
    for (const action of collapsed.actions) {
      nodes.push({
        id: `action-${action.index}`,
        kind: 'action',
        status: action.state === 'done' ? 'done' : action.state === 'error' ? 'failed' : 'running',
        ...(action.startedAt !== undefined ? { startedAt: action.startedAt } : {}),
        ...(action.lastProgressAt !== undefined ? { settledAt: action.lastProgressAt } : {}),
        ...(action.state === 'done' && action.resultPreview !== undefined ? { output: action.resultPreview } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      })
    }
    return nodes
  }

  private assertNotClosed(): void {
    if (this.closed) throw new HelmError('closed', 'WorkflowService 已关闭', 409)
  }
}
