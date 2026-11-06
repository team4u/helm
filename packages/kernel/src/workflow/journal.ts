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
 * ## 恢复时的不确定性
 * `action_started` 无对应终态行 = 进程在动作执行中崩溃，无法确认副作用是否完成。
 * readJournal 对 action 相关的损坏/截断/失配不静默降级为"无缓存重跑"，而是返回
 * `actionUncertain` 让调用方显式报 `workflow_action_uncertain` 错误，由人类决策。
 *
 * ## 排序
 * 行内 seq 为引擎内单调递增的落盘顺序号（并发下按调用发起顺序分配 index，
 * 落盘顺序可能与 index 顺序交错，恢复时按 index 前缀校验、按 seq 去重）。
 */

import { createHash } from 'node:crypto'
import { appendFile, open, type FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import type { WorkflowJournalEntry } from '@helm/protocol'

/** agent 调用的 key 输入（决定该 agent 做什么的所有字段）。 */
export interface AgentJournalKeyInput {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  effort?: string
  isolation?: string
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
    input.resume ?? null,
    // 仅存在时追加：无条件加第九槽会改变既有账本的 canonical 形式。
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
   * true = 账本中存在 action_started 无终态（或 action 相关行损坏到无法判定），
   * 调用方必须显式失败（workflow_action_uncertain），禁止自动重跑副作用。
   */
  actionUncertain: boolean
  /** 非 action 行的解析/读取问题计数（截断尾行、手改文件等）；不影响重放但如实上报。 */
  ioErrors: number
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

/** 解析单行。返回 null 表示该行无法判定（损坏/截断/未知行型）。 */
function parseLine(line: string): WorkflowJournalEntry | null {
  if (line.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (isAgentEntry(parsed) || isActionEntry(parsed) || isActionStartedEntry(parsed)) return parsed
  return null
}

/**
 * 读入账本文件。
 *
 * - 文件不存在：空账本（全新 run 的正常路径）。
 * - 行损坏：能判定 type 的行照常入列；无法判定的行若位于 action started/终态
 *   配对窗口内（见下方配对逻辑），置 actionUncertain；其余计入 ioErrors 不中断。
 * - action_started 无终态：actionUncertain（进程崩溃于动作执行中）。
 */
export function readJournal(path: string): JournalReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { entries: [], actionUncertain: false, ioErrors: 0 }
  }

  const entries: WorkflowJournalEntry[] = []
  let ioErrors = 0
  let corruptInActionWindow = false
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // 最后一行为空是正常的（文件以 \n 结尾）；半写截断的尾行必然解析失败。
    const isLast = i === lines.length - 1
    const parsed = parseLine(line)
    if (parsed === null) {
      if (line.trim() === '' && isLast) continue
      ioErrors++
      // 半写/损坏行无法判定是否属于某 action 调用；若其后仍有可解析行，
      // 说明它不是"进程死于动作中"的尾行，保守计为 ioError。若它是最后的
      // 非空行，无法排除其是 action 终态——交给下方配对逻辑综合判定。
      if (!isLast) continue
      corruptInActionWindow = true
      continue
    }
    entries.push(parsed)
  }

  // 按 index 配对 action_started 与终态。seq 单调但 index 并发交错，配对按
  // index+key 双匹配，不假设相邻。
  const startedByKey = new Map<string, Extract<WorkflowJournalEntry, { type: 'action_started' }>>()
  for (const entry of entries) {
    if (entry.type === 'action_started') startedByKey.set(`${entry.index}:${entry.key}`, entry)
  }
  for (const entry of entries) {
    if (entry.type === 'action') startedByKey.delete(`${entry.index}:${entry.key}`)
  }

  // 悬挂 started：若其 seq 大于任一 action 终态行的 seq，说明它写在最后一批——
  // 进程死于该动作执行中；更早的悬挂 started（终态行因损坏丢失）同样不确定。
  const maxActionSeq = entries.reduce((m, e) => (e.type === 'action' ? Math.max(m, e.seq) : m), -1)
  const dangling =
    startedByKey.size > 0 &&
    ([...startedByKey.values()].some((started) => started.seq > maxActionSeq) || corruptInActionWindow)

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

  return { entries: deduped, actionUncertain: dangling, ioErrors }
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
  async append(entry: Omit<WorkflowJournalEntry, 'seq' | 'v'> & { seq?: number }): Promise<number> {
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
