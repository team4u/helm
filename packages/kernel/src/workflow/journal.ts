/**
 * journal.ts — 工作流运行的私有前缀重放账本。
 *
 * 基于 @tintinweb/pi-subagents v0.23.1 (MIT) journal.ts 移植并按 helm 语义加固：
 *
 * ## 前缀重放，不是查表
 * 每行同时按调用发起位次（index，agent 与 action 共享同一全序）与调用载荷哈希
 * （key）双重校验；首次失配起全部转 live 执行。乱序复用后续匹配等于复用在不同
 * 上游条件下产生的结果——另一场 run 的第 12 位 prompt 不是同一份工作。
 *
 * ## agent 与 action 的不同失败语义
 * - agent 失败行照记（断链后下次 live 重试）；I/O 写失败不阻断运行（账本只是
 *   未来 resume 的优化），但计数暴露 `ioErrors` 供宿主诊断，绝不隐瞒。
 * - action 有副作用：`action_started` 意图行必须 append+fsync 成功后才允许执行
 *   handler；`action` 终态行落盘后才 resolve 调用 promise。二者任一写失败都是
 *   fatal——继续跑等于在无法记账的状态下执行副作用，账本将失去意义。
 *
 * ## 恢复时的不确定性（保守优先）
 * 以下任一情况都无法证明"副作用未发生或已完整发生"，readJournal 一律置
 * `actionUncertain`，由调用方显式拒绝自动恢复、交人类决策：
 * - `action_started` 无对应终态行（不论其 seq 位置——终态行因任何原因丢失，
 *   该动作的执行结果即不可判定，不能按"写在最后"启发放行）；
 * - 损坏行无法判定类型：本引擎写出的行 type 恒为首键，只有能从残余文本中
 *   读出**完整** `"type":"agent"` 前缀才敢归为 agent 行（ioError）；其余
 *   （含可解析但形状未知的行）一律保守 uncertain，绝不靠字符串包含 "action"
 *   之类的猜测放行；
 * - 存在 ok:false 的 action 终态行（handler 抛错≠零副作用，自动重试可能重复
 *   扣款/发送，计数经 `failedActions` 上报）；
 * - 文件本身不可读（权限/I-O 错误，`readFailed` 上报；ENOENT 视为空账本）。
 *
 * ## 排序
 * 行内 seq 为引擎内单调递增的落盘顺序号（并发下按调用发起顺序分配 index，
 * 落盘顺序可能与 index 顺序交错，恢复时按 index 前缀校验、按 seq 去重）。
 */

import { createHash } from 'node:crypto'
import { appendFile, open, type FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import type { WorkflowJournalEntry } from '@helm/protocol'

/**
 * 追加写入的输入（seq/v 由写入器分配）。
 * 显式按 variant 声明而非 `Omit<Union, 'v'|'seq'>`——Omit 不分布，会把
 * agent/action 各自的合法字段（ok/text/result…）从联合上剥掉。
 */
export type JournalWriteInput =
  | { type: 'agent'; index: number; key: string; ok: boolean; text?: string; resumed?: true; seq?: number }
  | { type: 'action_started'; index: number; key: string; seq?: number }
  | {
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      seq?: number
    }

/** agent 调用的 key 输入（决定该 agent 做什么的所有字段）。 */
export interface AgentJournalKeyInput {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  effort?: string
  isolation?: string
  /** gate 验收命令：命令变化即不同调用，不得命中旧缓存。固定槽不与无标签变长槽互撞。 */
  gate?: string
  resume?: string
  /** agent({ schema }) 的序列化形式。 */
  schema?: string
}

export function agentJournalKey(input: AgentJournalKeyInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    // 仅存在时追加：无条件加第十槽会改变既有账本的 canonical 形式。
    ...(input.schema !== undefined ? [input.schema] : []),
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** action 调用的 key：全限定 actionId + 序列化 input。 */
export function actionJournalKey(actionId: string, serializedInput: string): string {
  return createHash('sha256').update(JSON.stringify(['action', actionId, serializedInput])).digest('hex').slice(0, 32)
}

/** readJournal 的结构化结果：绝不静默吞掉影响 action 完成判定的损坏。 */
export interface JournalReadResult {
  entries: WorkflowJournalEntry[]
  /**
   * true = 账本无法证明安全重放（悬挂 started / 不可判定损坏行 / 失败 action /
   * 文件不可读），调用方必须显式失败（workflow_action_uncertain /
   * journal_read_failed），禁止自动重跑副作用。
   */
  actionUncertain: boolean
  /** 非 action 行的解析/读取问题计数（截断尾行、手改文件等）；不影响重放但如实上报。 */
  ioErrors: number
  /** ok:false 的 action 终态行数（副作用可能已发生，恢复必须拒绝自动重试）。 */
  failedActions: number
  /** 文件存在但不可读（权限/I-O）。ENOENT 不在此列（正常空账本）。 */
  readFailed?: { code: string; message: string }
}

function isAgentEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'agent' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['type'] === 'agent' &&
    Number.isInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    (e['text'] === undefined || typeof e['text'] === 'string') &&
    (e['resumed'] === undefined || e['resumed'] === true)
  )
}

function isActionStartedEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action_started' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return e['type'] === 'action_started' && Number.isInteger(e['index']) && (e['index'] as number) >= 0 && typeof e['key'] === 'string'
}

function isActionEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['type'] === 'action' &&
    Number.isInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean'
  )
}

type LineVerdict =
  | { kind: 'entry'; entry: WorkflowJournalEntry }
  /** 损坏但可判定为 agent 行：计 ioError，不阻断重放。 */
  | { kind: 'agentCorrupt' }
  /** 无法判定类型：保守视为可能涉及 action。 */
  | { kind: 'uncertain' }

/** 本引擎写出的行 type 恒为首键；只有完整的 "type":"agent" 前缀才判为 agent 损坏行。 */
const AGENT_LINE_PREFIX = /^\s*\{\s*"type"\s*:\s*"agent"/

function classifyLine(line: string): LineVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return AGENT_LINE_PREFIX.test(line) ? { kind: 'agentCorrupt' } : { kind: 'uncertain' }
  }
  if (isAgentEntry(parsed)) return { kind: 'entry', entry: parsed }
  if (isActionStartedEntry(parsed) || isActionEntry(parsed)) return { kind: 'entry', entry: parsed }
  // 可解析但形状未知：能读出 type 字段且为 agent 时按 agent 损坏行处理，
  // 其余（未知 type / 缺 type / 字段残缺）一律保守 uncertain。
  if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'agent') {
    return { kind: 'agentCorrupt' }
  }
  return { kind: 'uncertain' }
}

/**
 * 读入账本文件。
 *
 * - 文件不存在（ENOENT）：空账本（全新 run 的正常路径）。
 * - 文件不可读（权限/I-O）：readFailed + actionUncertain，绝不假扮空账本。
 * - 行损坏：见文件头"恢复时的不确定性"；空行（尾部换行）跳过。
 */
export function readJournal(path: string): JournalReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      return { entries: [], actionUncertain: false, ioErrors: 0, failedActions: 0 }
    }
    return {
      entries: [],
      actionUncertain: true,
      ioErrors: 0,
      failedActions: 0,
      readFailed: { code: err.code ?? 'EIO', message: err.message },
    }
  }

  const entries: WorkflowJournalEntry[] = []
  let ioErrors = 0
  let corruptUncertain = false
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const verdict = classifyLine(line)
    if (verdict.kind === 'entry') {
      entries.push(verdict.entry)
      continue
    }
    ioErrors++
    if (verdict.kind === 'uncertain') corruptUncertain = true
  }

  // 按 index+key 配对 action_started 与终态。seq 单调但 index 并发交错，配对按
  // index+key 双匹配，不假设相邻。任何悬挂 started（不论 seq 位置）都不确定：
  // 终态行可能因损坏丢失，"started 落盘后 handler 被允许执行"是唯一事实。
  const startedByKey = new Map<string, Extract<WorkflowJournalEntry, { type: 'action_started' }>>()
  for (const entry of entries) {
    if (entry.type === 'action_started') startedByKey.set(`${entry.index}:${entry.key}`, entry)
  }
  for (const entry of entries) {
    if (entry.type === 'action') startedByKey.delete(`${entry.index}:${entry.key}`)
  }
  const dangling = startedByKey.size > 0

  const failedActions = entries.filter((e) => e.type === 'action' && !e.ok).length

  // 落盘顺序稳定化：seq 严格升序（去重：同 seq 以首行为准），index 顺序由前缀
  // 匹配逻辑按需检查。
  entries.sort((a, b) => a.seq - b.seq)
  const deduped: WorkflowJournalEntry[] = []
  let lastSeq = -1
  for (const entry of entries) {
    if (entry.seq === lastSeq) continue
    lastSeq = entry.seq
    deduped.push(entry)
  }

  return {
    entries: deduped,
    actionUncertain: dangling || corruptUncertain || failedActions > 0,
    ioErrors,
    failedActions,
  }
}

/**
 * 追加写入器：持有打开的 FileHandle，action 路径 append 后 fsync。
 *
 * agent 行写失败仅计数（resume 优化损失，不阻断运行）；action started/终态
 * 行写失败抛 JournalWriteError（fatal）。
 */
export class JournalWriter {
  private seq = 0
  private handle?: FileHandle
  /** 置位后所有 append（含 agent 行）都抛错：run 已因 action 账本失效而终止。 */
  private poisoned = false
  agentIoErrors = 0

  constructor(
    private readonly path: string,
    private readonly fsyncActions: boolean = true,
  ) {
    // 打开是异步的但构造需同步；推迟到首次 append（见 ensure()）。open 失败
    // 时 agent 行退化为计数、action 行显式抛错，语义与同步版本一致。
  }

  private opening?: Promise<FileHandle | undefined>

  private async ensure(): Promise<FileHandle | undefined> {
    if (this.handle !== undefined) return this.handle
    if (this.opening === undefined) {
      this.opening = open(this.path, 'a')
        .then((h) => {
          this.handle = h
          return h
        })
        .catch(() => {
          this.opening = undefined
          return undefined
        })
    }
    return this.opening
  }

  /**
   * 追加一行。action 相关行（started/终态）fsync 成功后才返回；
   * agent 行尽力而为，失败计入 agentIoErrors。
   * @throws JournalWriteError action 行写失败或 writer 已 poisoned。
   */
  async append(entry: JournalWriteInput): Promise<number> {
    const full = { ...entry, v: 1, seq: entry.seq ?? this.seq++ } as WorkflowJournalEntry
    const isActionLine = full.type === 'action_started' || full.type === 'action'
    if (!isActionLine && this.poisoned) {
      // run 已因账本失效终止；后续行无意义。
      return full.seq
    }
    const handle = await this.ensure()
    if (handle === undefined) {
      if (isActionLine) {
        this.poisoned = true
        throw new JournalWriteError(`workflow journal unavailable: cannot open ${this.path}`)
      }
      this.agentIoErrors++
      return full.seq
    }
    try {
      await appendFile(handle, `${JSON.stringify(full)}\n`, 'utf-8')
      if (isActionLine && this.fsyncActions) {
        // started 落盘（fsync）之前不得执行 handler；终态落盘之前不得 resolve。
        await handle.sync()
      }
    } catch (error) {
      if (isActionLine) {
        this.poisoned = true
        throw new JournalWriteError(
          `workflow journal write failed (${full.type}): ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.agentIoErrors++
    }
    return full.seq
  }

  /** 账本是否已因 action 写失败失效。 */
  get isPoisoned(): boolean {
    return this.poisoned
  }

  async close(): Promise<void> {
    try {
      await this.handle?.close()
    } catch {
      // 关闭失败不影响正确性；下一次 open 以追加模式继续。
    }
  }
}

export class JournalWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalWriteError'
  }
}

/** 便捷：文件是否存在（resume 探测用）。 */
export function journalExists(path: string): boolean {
  return existsSync(path)
}
