/**
 * 单飞 blocked ↔ AskDoc 协调器（inFlightAsks）。
 *
 * 防反馈环与竞态的关键设计（均来自真实事故反馈）：
 * 1. 已结算条目保留至「seq 推进或 pane 关闭」才清除：send_keys 已发但终端
 *    状态短暂仍 blocked 同 seq + socket 重复事件时，不得重建同 ID Ask、不得
 *    重复发键；wait 短暂返回同 blocked seq 同理直接吞掉（等真实进展）。
 * 2. 先登记条目再启动 createAsk：ask.upsert 可能同步回调（终端先处理 →
 *    cancelAsk），登记必须先于任何可见副作用。
 * 3. createAsk 404 竞态（ask 未入库已被事件路径销单）：事件路径销单只清
 *    协调器条目；owner 若随后 createAsk 成功，markPending 重建条目后由
 *    宿主结算通道收尾，绝不留下无人认领的 pending Ask。
 * 4. 去重键 = herdr:<nodeId|local>:<paneId>:<stateChangeSeq>（Ask 预分配 ID
 *    同形）；双路径（socket 事件与 spawn wait）中先到者登记条目成为 owner
 *    负责 createAsk，后到者经 duplicate 复用同一条目，绝不重建同 ID Ask。
 * 5. 取消/事件处理错误经显式通道上抛（通知或传回 spawn），不 catch 空吞。
 * 6. 权威观测带方向：seq 严格推进才作废旧条目；seq 回退仅作废已结算的
 *    墓碑（Herdr 重启 seq 归零后墓碑不得压制重新询问），绝不作废
 *    pending/creating 活条目（并发 agent.get 乱序晚到的旧观测不能伪销毁
 *    人类正在看的 AskDoc）。
 */

import { HelmError } from '@helm/protocol'

export type AskPhase = 'creating' | 'pending' | 'sent' | 'settled'

export interface AskEntry {
  readonly key: string
  askId: string
  readonly nodeId: string | undefined
  readonly paneId: string
  readonly seq: number
  phase: AskPhase
  /** 当前 seq 下的第几次审批尝试（从 0 开始；0 时 askId === key，重试 N 时 askId === `${key}:r${N}`）。 */
  attempt: number
  /** 已在当前 attempt 执行过一次 send_keys。 */
  keysSent: boolean
  /** 最近一次发送的按键序列（供未解除阻塞重试时在描述中提示人类）。 */
  lastSentKeys?: string[]
  /** 当前 attempt 结算完成时间戳。 */
  settledAt?: number
}

/** 终端权威状态变化（agent.get 或事件驱动探测）。 */
export interface AuthorityUpdate {
  paneId: string
  nodeId?: string
  seq: number
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
}

/**
 * beginBlocked 的结果：
 * - owner：调用方赢得创建权（负责 createAsk 并 settle）；
 * - duplicate：该 (pane,seq) 已处理或正处理（不重建、不重发、不再创建）。
 */
export type BeginBlockedResult = { owner: AskEntry } | { duplicate: true }

export class AskCoordinator {
  private readonly entries_map = new Map<string, AskEntry>()
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /**
   * 终端权威状态更新（事件路径 / wait 返回 / 远端轮询）：
   * - seq 严格推进：清除同 pane 全部旧条目（含已结算保留项）；
   * - seq 回退（Herdr 重启 seq 归零）：仅作废已结算墓碑（防其压制后续同
   *   seq 重新询问）；pending/creating 活条目不作废——乱序晚到的旧观测
   *   不得伪销毁人类正在看的 AskDoc（真重启由执行循环的权威复核收尾）。
   * 返回仍 pending 的被作废条目（调用方对其实施 cancelAsk superseded）。
   */
  observeAuthority(update: AuthorityUpdate): AskEntry[] {
    const superseded: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId !== update.paneId || entry.nodeId !== update.nodeId) continue
      if (update.seq === entry.seq) continue
      if (update.seq < entry.seq && entry.phase !== 'settled') continue
      this.removeEntry(entry)
      if (entry.phase === 'pending' || entry.phase === 'creating') superseded.push(entry)
    }
    this.onChange()
    return superseded
  }

  /** pane 关闭：清除全部条目（含保留项）。 */
  paneClosed(paneId: string, nodeId?: string): AskEntry[] {
    const removed: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId === paneId && entry.nodeId === nodeId) {
        this.removeEntry(entry)
        removed.push(entry)
      }
    }
    this.onChange()
    return removed
  }

  /**
   * 登记 blocked 状态（任何 await 之前完成）：
   * - 该 (pane,seq) 无条目 -> owner（负责 createAsk + settle）；
   * - 已有条目（creating/pending/sent/settled 任一 phase）-> duplicate，
   *   绝不重建同 ID Ask、绝不重发键。
   */
  beginBlocked(nodeId: string | undefined, paneId: string, seq: number): BeginBlockedResult {
    const key = askKey(nodeId, paneId, seq)
    if (this.entries_map.has(key)) return { duplicate: true }
    const entry: AskEntry = {
      key,
      askId: key,
      nodeId,
      paneId,
      seq,
      phase: 'creating',
      attempt: 0,
      keysSent: false,
    }
    this.entries_map.set(key, entry)
    this.onChange()
    return { owner: entry }
  }

  /**
   * createAsk 调用已真实发出（首个 await 返回后）。
   * 创建路径可能已被事件路径销单清除条目（404 竞态）：若宿主 createAsk 实际
   * 成功（未抛 404），重建条目为 pending——后续宿主终态回调有处认领；
   * 若调用方随后确认 ask 已被销（cancelAsk 404），用 failCreate 清除。
   */
  markPending(entry: AskEntry): void {
    const existing = this.entries_map.get(entry.key)
    if (existing !== undefined && existing !== entry) return
    this.entries_map.set(entry.key, entry)
    if (entry.phase === 'creating') {
      entry.phase = 'pending'
      this.onChange()
    }
  }

  /** 终态落位（answered/superseded/cancelled）：条目保留至 seq 推进。 */
  settle(entry: AskEntry, outcome: { keysSent: boolean; sentKeys?: string[] }): void {
    if (this.entries_map.get(entry.key) !== entry) return
    entry.phase = 'settled'
    entry.keysSent = outcome.keysSent
    entry.lastSentKeys = outcome.sentKeys
    entry.settledAt = Date.now()
    this.onChange()
  }

  /**
   * 同 seq 未解除阻塞时重开审批：send_keys 已发出但终端仍停留在同一
   * (nodeId, paneId, seq) 的 blocked 状态（按键未被接受），或条目已结算
   * （含 superseded/cancelled，keysSent=false）但终端同 seq 卡死——两者都
   * 需要重开让人类重新选择，否则退避循环永不逃生。attempt 递增生成新
   * askId（`<key>:r<N>`，避开宿主 ask_id_conflict），条目重回 creating；
   * 不满足重开条件（无条目/未结算）返回 undefined。
   */
  reopenUnresolved(nodeId: string | undefined, paneId: string, seq: number): AskEntry | undefined {
    const key = askKey(nodeId, paneId, seq)
    const entry = this.entries_map.get(key)
    if (entry === undefined || entry.phase !== 'settled') return undefined
    entry.attempt += 1
    entry.askId = `${entry.key}:r${entry.attempt}`
    entry.phase = 'creating'
    entry.keysSent = false
    entry.settledAt = undefined
    this.onChange()
    return entry
  }

  /** 创建失败（IO/宿主错误/销单确认）：条目移除（允许后续重试），错误由调用方上抛。 */
  failCreate(entry: AskEntry): void {
    this.removeEntry(entry)
  }

  get(nodeId: string | undefined, paneId: string, seq: number): AskEntry | undefined {
    return this.entries_map.get(askKey(nodeId, paneId, seq))
  }

  /**
   * CAS seq 解析器（异步权威版）：askId -> 该 Ask 目标 pane 的**当前真实**
   * state_change_seq（agent.get 现查，绝不返回创建时的 entry.seq——CAS 的
   * 意义正是发现「创建后终端已按键推进」）。归属校验：askId 三段必须与
   * 条目 (nodeId, paneId, seq) 完全一致，防止伪造 id 越权探测他人窗格。
   */
  seqResolver(
    askId: string,
    authority: (nodeId: string | undefined, paneId: string) => Promise<number | undefined>,
  ): Promise<number | undefined> {
    const parsed = parseAskId(askId)
    if (parsed === undefined) return Promise.resolve(undefined)
    const entry = this.entries_map.get(askKey(parsed.nodeId, parsed.paneId, parsed.seq))
    if (entry === undefined || entry.askId !== askId) return Promise.resolve(undefined)
    return authority(parsed.nodeId, parsed.paneId)
  }

  /** 该 (pane,seq) 是否已发过键（防重发判断）。 */
  keysSent(nodeId: string | undefined, paneId: string, seq: number): boolean {
    return this.entries_map.get(askKey(nodeId, paneId, seq))?.keysSent === true
  }

  pendingCount(): number {
    let n = 0
    for (const entry of this.entries_map.values()) {
      if (entry.phase === 'pending' || entry.phase === 'creating') n += 1
    }
    return n
  }

  entries(): AskEntry[] {
    return [...this.entries_map.values()]
  }

  /** 概览（overview doc；nodeId undefined 折叠为 'local' 保证 JSON-safe）。 */
  describe(): Array<{ paneId: string; nodeId: string; seq: number; phase: AskPhase }> {
    return [...this.entries_map.values()].map((e) => ({
      paneId: e.paneId,
      nodeId: e.nodeId ?? 'local',
      seq: e.seq,
      phase: e.phase,
    }))
  }

  /** 停用清算：清空全部条目（调用方 stopResources 已先行销单宿主 Ask；
   *  条目跨启用周期残留会伪装 pendingAsk 幽灵数据并误判 duplicate）。 */
  settleAllAsSuperseded(): void {
    this.entries_map.clear()
    this.onChange()
  }

  private removeEntry(entry: AskEntry): void {
    if (this.entries_map.get(entry.key) !== entry) return
    this.entries_map.delete(entry.key)
    this.onChange()
  }
}

export function askKey(nodeId: string | undefined, paneId: string, seq: number): string {
  return `herdr:${nodeId ?? 'local'}:${paneId}:${seq}`
}

/**
 * askId 即 askKey 字面量（可选 `:r<正整数>` 重试后缀）；nodeId 段原样保留
 * （不折叠 local，防解析歧义）。例：herdr:local:wR:p2:3916 与
 * herdr:local:wR:p2:3916:r1 均解析出 { nodeId: undefined, paneId: 'wR:p2', seq: 3916 }。
 *
 * 解析顺序：先剥离结尾合法的 ':r[1-9][0-9]*' 重试后缀（r0/r01/超大值/伪造
 * 形状一律整体拒绝，不回退成 seq 解析），再按无歧义的「最后一个冒号 = seq」
 * 解析；paneId 自带冒号不受影响。
 */
function parseAskId(askId: string): { nodeId: string | undefined; paneId: string; seq: number } | undefined {
  if (!askId.startsWith('herdr:')) return undefined
  let rest = askId.slice('herdr:'.length)
  // 剥离合规范的 ':r<正整数，无前导零>' 重试后缀；不合法后缀让后续 seq
  // 解析失败（如 '...:3916:r01' 或 '...:3916:r0' 无法匹配 ^\d+$，整体拒绝）。
  const retrySuffix = /:r([1-9][0-9]*)$/.exec(rest)
  if (retrySuffix !== null) {
    // 超大重试整数（超出 safe integer）同样拒绝，与 seq 同一诚实性标准。
    const retry = Number(retrySuffix[1])
    if (!Number.isSafeInteger(retry)) return undefined
    rest = rest.slice(0, rest.length - retrySuffix[0].length)
  }
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return undefined
  const panePart = rest.slice(0, lastColon)
  const seqPart = rest.slice(lastColon + 1)
  if (!/^\d+$/.test(seqPart)) return undefined
  const seq = Number(seqPart)
  if (!Number.isSafeInteger(seq) || seq < 0 || seqPart !== String(seq)) return undefined
  const paneColon = panePart.indexOf(':')
  if (paneColon <= 0) return undefined
  const nodeId = panePart.slice(0, paneColon)
  const paneId = panePart.slice(paneColon + 1)
  if (paneId === '') return undefined
  return { nodeId: nodeId === 'local' ? undefined : nodeId, paneId, seq }
}

/**
 * 同 seq blocked 的「等待真实进展」：不 busy spin——watchdog 探针周期或
 * socket 事件驱动会推进权威 seq；本函数只提供可取消的退避等待，供 wait
 * 循环在收到重复同 seq blocked 时使用（避免立刻再投 agent.wait 打满通道）。
 */
export async function backoffForDuplicateBlocked(signal: AbortSignal, attempt: number, baseMs = 500, capMs = 4_000): Promise<void> {
  const ms = Math.min(baseMs * 2 ** Math.min(attempt, 4), capMs)
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new HelmError('aborted', '等待终端进展期间被取消', 409))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new HelmError('aborted', '等待终端进展期间被取消', 409))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
