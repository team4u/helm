/**
 * run-store.ts — run 记录 / run 索引持久层（自 WorkflowService 拆出的内部模块）。
 *
 * 职责：
 * - 单库设计：run 索引存注入的 state store（@helm/kernel 唯一 state.sqlite
 *   的命名空间 doc），完整 RunRecord 原子落文件（与账本同目录
 *   dataDir/artifacts/<convId>/workflow-<runId>.record.json）；
 * - 形状校验纪律：索引与记录是持久层外部输入，读取端显式校验，损坏一律
 *   workflow_index_corrupt / workflow_record_corrupt（500），绝不把损坏数据
 *   当空数组或有效记录强转使用；
 * - 接管标记甄别（inspectTakeoverMarker）：进程内活性事实由调用方注入
 *   （保留集合/活跃表），磁盘事实（索引 + 记录/账本文件）由本模块核查。
 *
 * summary 派生 / 脱敏 / progress 折叠投影见 run-summary.ts（纯函数，与
 * 本持久层正交）。写入顺序纪律见 write()：先读校验索引、再写文件、最后
 * 更新索引。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import type {
  WorkflowProgressEntry,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '../../contracts.js'

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

const INDEX_KEY = 'workflow/runs'

/** run id：wf_ + 12 hex（沿用上游格式便于识别）。 */
export function newRunId(): string {
  return `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export interface RunIndexEntry {
  id: string
  conversationId: number
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  /** 后台启动标记（resume 新 run 继承；诊断/探针判定用）。 */
  notifyParentOnSettle?: boolean
  /** 当前累计自动续跑次数（初始缺省 = 0；每次 resumeFromRunId 接管时 +1）。 */
  autoResumeCount?: number
  /** 已接替本失败 run 的新 run ID（防重复续跑；缺省 = 未被接管）。 */
  resumedByRunId?: string
}

/** state store 中的每 run 完整 doc（summary + 恢复所需书目信息）。 */
export interface RunRecord {
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
  /**
   * 账本记账失败诊断（agent 行写失败 / resume 旧账本損行），脱敏后持久；
   * 不影响终态判定，仅为如实可见（summary 面透传）。
   */
  journalIoErrors?: string[]
  /** run 种类：DSL 工作流（缺省）或受信后台单子代理（startBackgroundAgent）。 */
  kind?: 'workflow' | 'subagent'
  /**
   * 后台启动标记：终态结算后须向父会话投递通知（notifiedAt 防重复投递，
   * init() outbox 补发）。subagent run 恒为后台；workflow run 仅在经工具
   * background 启动时置位——它同时决定重启恢复语义（isBackgroundRecord：
   * 在途子会话先落 abort 标记并守卫中止）。同步 workflow 不置位、不通知。
   */
  notifyParentOnSettle?: boolean
  notifiedAt?: number
  /** 后台子代理的 Profile 与执行环境元数据（onResolved 回传后补全）。 */
  subagentMeta?: { agentType?: string; execution?: AgentExecutionInfo }
  /**
   * 前台同步标记：经同步工具（background:false / 自动化缺省）启动的 run。
   * 父回合工具调用阻塞等待（引擎 foregroundWaiters），可被 detach 动作
   * 原子转入后台（转后台即置 notifyParentOnSettle + detachedAt）。
   */
  syncForeground?: boolean
  /** detach 转后台时间戳（幂等标记：已转后台的 run 拒绝再次 detach）。 */
  detachedAt?: number
  /**
   * 私有恢复元数据：本 run 派生过的子会话 ID 集（onResolved 登记即持久；
   * writeRecord 统一从活跃 run 的 childConversations 合入，杜绝旧副本覆盖）。
   * 后台 run 崩溃恢复（prepareRecovery/init 守卫中止）以这组持久 IDs 为权威
   * 坐标——真实 run 运行期 nodes 要到 settleRun 才落盘，不能作为恢复依据。
   */
  childConversationIds?: number[]
  /** 当前累计自动续跑次数（resume 接管时 +1；与索引同步）。 */
  autoResumeCount?: number
  /** 已接替本失败 run 的新 run ID（防重复续跑；与索引同步）。 */
  resumedByRunId?: string
}

/** 持久层读出的错误可打印形态（store 异常诊断用）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * run 索引最低限度形状校验：非数组、null 项、必需字段非法都是持久层损坏
 * （旧实现对每项直接 entry.id 访问，null 项会 TypeError）。只校验现行
 * RunIndexEntry 契约，无旧格式适配。合法返回 undefined；损坏返回问题描述
 * + 可辨识 runId（id 非法时用 `#位置` 定位）。
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
    if (!RUN_STATUSES.includes(e['status'] as WorkflowRunStatus)) {
      return { problem: `第 ${i} 项 status 非法（${JSON.stringify(e['status'])}）`, runId }
    }
    if (typeof e['createdAt'] !== 'number' || !Number.isFinite(e['createdAt'])) {
      return { problem: `第 ${i} 项 createdAt 非有限数值`, runId }
    }
    if (typeof e['updatedAt'] !== 'number' || !Number.isFinite(e['updatedAt'])) {
      return { problem: `第 ${i} 项 updatedAt 非有限数值`, runId }
    }
    if (e['notifyParentOnSettle'] !== undefined && typeof e['notifyParentOnSettle'] !== 'boolean') {
      return { problem: `第 ${i} 项 notifyParentOnSettle 非布尔`, runId }
    }
    if (
      e['autoResumeCount'] !== undefined &&
      (!Number.isInteger(e['autoResumeCount']) || (e['autoResumeCount'] as number) < 0)
    ) {
      return { problem: `第 ${i} 项 autoResumeCount 非负整数`, runId }
    }
    if (e['resumedByRunId'] !== undefined && (typeof e['resumedByRunId'] !== 'string' || e['resumedByRunId'] === '')) {
      return { problem: `第 ${i} 项 resumedByRunId 非非空字符串`, runId }
    }
  }
  return undefined
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'completed', 'failed', 'aborted']

export function isNonRetryableWorkflowError(error: string | undefined): boolean {
  if (error === undefined) return false
  const normalized = error.toLowerCase()
  return normalized.includes('workflow_action_uncertain') ||
    normalized.includes('[validation_error]') ||
    normalized.includes('workflow script has a syntax error')
}

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
  const childIds = r['childConversationIds']
  if (
    childIds !== undefined &&
    (!Array.isArray(childIds) || !childIds.every((id) => Number.isInteger(id) && id >= 1))
  ) {
    return 'childConversationIds 非法（需正整数数组）'
  }
  if (r['error'] !== undefined && typeof r['error'] !== 'string') return 'error 非字符串'
  if (
    r['autoResumeCount'] !== undefined &&
    (!Number.isInteger(r['autoResumeCount']) || (r['autoResumeCount'] as number) < 0)
  ) {
    return 'autoResumeCount 非负整数'
  }
  if (r['resumedByRunId'] !== undefined && (typeof r['resumedByRunId'] !== 'string' || r['resumedByRunId'] === '')) {
    return 'resumedByRunId 非非空字符串'
  }
  return undefined
}

/**
 * 后台 run 恢复所需的在途子会话坐标：childConversationIds 是运行期即时持久
 * 的权威面；subagentMeta/nodes 坐标是既有冗余投影（子代理路径/终态落盘），
 * 恢复时合并去重，不做旧格式迁移读取。
 */
export function backgroundChildIds(record: RunRecord): number[] {
  const ids = new Set<number>()
  for (const id of record.childConversationIds ?? []) ids.add(id)
  const known = record.subagentMeta?.execution?.conversationId
  if (known !== undefined) ids.add(known)
  for (const node of record.nodes ?? []) {
    if (node.conversationId !== undefined) ids.add(node.conversationId)
  }
  return [...ids]
}

/**
 * 后台形态判定（恢复语义用）：kind=subagent 恒后台；kind=workflow 仅在
 * notifyParentOnSettle=true（经工具 background 启动）时按后台恢复——重启后
 * 其在途子会话须先落 abort 标记（prepareRecovery）再守卫中止，随后
 * failed(interrupted) 并补发通知，否则后台工作流子会话会遗留。常规同步
 * workflow（无 notify）沿用账本恢复语义：不中止子会话，报
 * resumeFromRunId 提示，通知 outbox 与它无关。
 */
export function isBackgroundRecord(record: RunRecord): boolean {
  return record.kind === 'subagent' || record.notifyParentOnSettle === true
}

export interface RunStoreOptions {
  dataDir: string
  /** run 索引的 SQLite doc store（主 app 注入 KernelRuntime.documentStore）。 */
  state: WorkflowStateStore
}

export class RunStore {
  private readonly dataDir: string
  private readonly state: WorkflowStateStore

  constructor(options: RunStoreOptions) {
    this.dataDir = options.dataDir
    this.state = options.state
  }

  artifactsDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  journalPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.jsonl`)
  }

  /** 完整 RunRecord 的文件路径（与账本同目录：dataDir/artifacts/<convId>/）。 */
  recordPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.record.json`)
  }

  /**
   * 写 run 记录（§4.3）：完整 RunRecord 原子落文件（.tmp + fsync + rename），
   * records doc 只维护轻量索引（id/conversationId/status/createdAt/updatedAt/
   * notifyParentOnSettle/autoResumeCount/resumedByRunId）。顺序纪律：先读校验
   * 索引、再写文件、最后更新索引——索引已损坏时绝不继续写文件（避免在未知
   * 全局状态下覆盖持久事实，徒增不一致面）；文件写失败时索引未动（不会出现
   * 索引指向缺失文件的中间态；load 对缺失文件显式报
   * workflow_record_corrupt，绝不假装记录存在）。
   */
  write(record: RunRecord): void {
    const index = this.readIndex()
    this.writeFile(record)
    const entry: RunIndexEntry = {
      id: record.id,
      conversationId: record.conversationId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.notifyParentOnSettle === true ? { notifyParentOnSettle: true } : {}),
      ...(record.autoResumeCount !== undefined ? { autoResumeCount: record.autoResumeCount } : {}),
      ...(record.resumedByRunId !== undefined ? { resumedByRunId: record.resumedByRunId } : {}),
    }
    const at = index.findIndex((candidate) => candidate.id === record.id)
    if (at >= 0) index[at] = entry
    else index.push(entry)
    this.state.set(INDEX_KEY, index)
  }

  /** 原子写完整 RunRecord：同目录临时文件 + fsync + rename（读端任一时刻只见完整旧/新版本）。 */
  private writeFile(record: RunRecord): void {
    const dir = this.artifactsDir(record.conversationId)
    mkdirSync(dir, { recursive: true })
    const target = this.recordPathFor(record.conversationId, record.id)
    const tmp = join(dir, `.record-${record.id}-${randomUUID()}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, JSON.stringify(record), null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, target)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // 已被 rename 消费或本就不存在
      }
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `写入工作流运行记录 ${target} 失败：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  load(runId: string): RunRecord {
    // 索引是唯一入口（开发期无迁移：无旧 per-run doc 读取）；索引级故障
    // 统一 workflow_index_corrupt（与其他全部索引入口同契约），附 runId 上下文。
    let index: RunIndexEntry[]
    try {
      index = this.readIndex()
    } catch (error) {
      if (error instanceof HelmError && error.code === 'workflow_index_corrupt') {
        throw new HelmError(
          error.code,
          `读取工作流运行 ${runId} 所需的 run 索引失败：${error.message}`,
          500,
          { runId, key: INDEX_KEY },
        )
      }
      throw error
    }
    const entry = index.find((candidate) => candidate.id === runId)
    if (entry === undefined) {
      throw new HelmError('not_found', `工作流运行 ${runId} 不存在`, 404, { runId })
    }
    const path = this.recordPathFor(entry.conversationId, runId)
    let record: unknown
    try {
      record = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        // 索引指向但文件缺失：持久层不一致，绝不假账本缺口静默降级。
        throw new HelmError(
          'workflow_record_corrupt',
          `工作流运行 ${runId} 的记录文件缺失（索引指向 ${path}）；请检查 dataDir 完整性`,
          500,
          { runId, path },
        )
      }
      throw new HelmError(
        'workflow_record_corrupt',
        `读取工作流运行 ${runId} 记录文件失败：${errorMessage(error)}`,
        500,
        { runId, path },
      )
    }
    // 先验证是对象再访问 id：null/原始值/数组绝不 record.id TypeError。
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new HelmError(
        'workflow_record_corrupt',
        `工作流运行 ${runId} 记录文件损坏（非对象结构：${Array.isArray(record) ? 'array' : typeof record}）`,
        500,
        { runId, path },
      )
    }
    const asRecord = record as Record<string, unknown>
    if (asRecord['id'] !== runId) {
      // 索引命中但文件内容 id 篡改：持久层不一致，绝不伪装「不存在」。
      throw new HelmError(
        'workflow_record_corrupt',
        `工作流运行 ${runId} 记录文件损坏（id 不匹配）`,
        500,
        { runId, path },
      )
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

  /**
   * 统一读取并校验 run 索引（list/get/prepare/init/write 全部入口共用）：
   * store 抛错与形状损坏一律 workflow_index_corrupt（500，带 key 与可辨识
   * runId），绝不把损坏数据当空数组、绝不让调用方强转后 TypeError。
   */
  readIndex(): RunIndexEntry[] {
    let raw: unknown
    try {
      raw = this.state.get<RunIndexEntry[]>(INDEX_KEY, [])
    } catch (error) {
      throw new HelmError(
        'workflow_index_corrupt',
        `读取工作流 run 索引失败：${errorMessage(error)}`,
        500,
        { key: INDEX_KEY },
      )
    }
    const broken = runIndexProblem(raw)
    if (broken !== undefined) throw this.indexCorruptError(broken.runId, broken.problem)
    return raw as RunIndexEntry[]
  }

  /** 索引损坏诊断（不自动删索引或记录：修复由人类确认）。 */
  indexCorruptError(runId: string, reason: string): HelmError {
    return new HelmError(
      'workflow_index_corrupt',
      `工作流 run 索引损坏（${reason}）；请检查 state store（不自动删除索引或记录）`,
      500,
      { key: INDEX_KEY, runId },
    )
  }

  /**
   * 接管标记甄别：ghost=true 表示接管 run 在进程内保留（标记已落盘、快照
   * 未落盘的并发窗口）、活跃表、run 索引与磁盘（同会话的记录文件与账本
   * 文件）四面都无任何痕迹——新 run 从未落任何持久事实，允许重接管；
   * 否则返回不放行原因。接管记录损坏（索引指向但文件不可读/形状非法）
   * 如实上抛 workflow_record_corrupt：损坏即无法确证无副作用，绝不放行。
   * 进程内活性事实（live.reserved = 接管保留集合 / live.active = 活跃表）
   * 由调用方现查注入。
   */
  inspectTakeoverMarker(
    takeoverRunId: string,
    conversationId: number,
    live: { reserved: boolean; active: boolean },
  ): { ghost: true } | { ghost: false; reason: string } {
    if (live.reserved) {
      return { ghost: false, reason: '接管 run 标记已落盘、快照尚未落盘（并发启动窗口）' }
    }
    if (live.active) return { ghost: false, reason: '接管 run 仍在运行' }
    try {
      this.load(takeoverRunId)
      return { ghost: false, reason: '接管 run 的记录仍存在' }
    } catch (error) {
      if (!(error instanceof HelmError && error.code === 'not_found')) throw error
    }
    // 索引已无此 run：磁盘文件是最后的副作用事实（索引缺失可能是损坏/重建，
    // 文件在即按已产生副作用保守处理）。
    const traces: string[] = []
    const recordPath = this.recordPathFor(conversationId, takeoverRunId)
    const journalPath = this.journalPathFor(conversationId, takeoverRunId)
    for (const [path, label] of [[recordPath, '记录文件'], [journalPath, '账本']] as const) {
      try {
        lstatSync(path)
        traces.push(`${label} ${path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new HelmError('io_error', `无法确认接管运行 ${takeoverRunId} 的${label}：${errorMessage(error)}`, 500, {
          runId: takeoverRunId, path,
        })
      }
    }
    if (traces.length > 0) return { ghost: false, reason: `磁盘仍存在接管 run 的${traces.join('、')}` }
    return { ghost: true }
  }
}
