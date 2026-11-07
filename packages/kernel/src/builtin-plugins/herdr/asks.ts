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
 * 4. 去重键 = herdr:<machine|local>:<paneId>:<stateChangeSeq>（Ask 预分配 ID
 *    同形）；条目内含结算通道，双路径（socket 事件与 spawn wait）中先到者
 *    成为 owner 负责 createAsk，后到者等待同一结算 promise。
 * 5. 取消/事件处理错误经显式通道上抛（通知或传回 spawn），不 catch 空吞。
 */

import { HelmError } from '@helm/protocol'

export type AskPhase = 'creating' | 'pending' | 'sent' | 'settled'

/** Ask 终态（与 AskResult 对齐的插件内形状）。 */
export interface AskOutcome {
  status: 'answered' | 'cancelled' | 'superseded'
  answers: Record<string, string>
}

export interface AskEntry {
  readonly key: string
  readonly askId: string
  readonly machine: string | undefined
  readonly paneId: string
  readonly seq: number
  phase: AskPhase
  /** 已执行过一次 send_keys（同 seq 绝不重发）。 */
  keysSent: boolean
  /** 结算完成时间戳（settled 保留至 seq 推进，防重建/防重发）。 */
  settledAt?: number
}

/** 终端权威状态变化（agent.get 或事件驱动探测）。 */
export interface AuthorityUpdate {
  paneId: string
  machine?: string
  seq: number
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
}

/**
 * beginBlocked 的结果：
 * - owner：调用方赢得创建权（负责 createAsk 并 settle）；
 * - duplicate：该 (pane,seq) 已处理或正处理（不重建、不重发、不再创建）。
 */
export type BeginBlockedResult = { owner: AskEntry } | { duplicate: true }

/**
 * 条目级结算通道：owner 创建后注入；等待方（spawn 路径）经 settlement()
 * 等待同一终态。通道由 owner 域外持有（协调器只存条目元数据）。
 */
export class AskSettlement {
  private resolveFn?: (outcome: AskOutcome) => void
  readonly promise: Promise<AskOutcome>

  constructor() {
    this.promise = new Promise<AskOutcome>((resolve) => {
      this.resolveFn = resolve
    })
  }

  settle(outcome: AskOutcome): void {
    this.resolveFn?.(outcome)
    this.resolveFn = undefined
  }
}

export class AskCoordinator {
  private readonly entries_map = new Map<string, AskEntry>()
  /** askId（同 key 形）-> 结算通道；与 entries_map 键空间不同（防 NaN 误查）。 */
  private readonly settlements = new Map<string, AskSettlement>()
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /**
   * 终端权威状态更新（事件路径 / wait 返回 / 远端轮询）：
   * seq 推进时清除同 pane 全部旧条目（含已结算保留项）并兜底结算其通道，
   * 返回仍 pending 的被作废条目（调用方对其实施 cancelAsk superseded）。
   */
  observeAuthority(update: AuthorityUpdate): AskEntry[] {
    const superseded: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId !== update.paneId || entry.machine !== update.machine) continue
      if (update.seq === entry.seq) continue
      this.removeEntry(entry)
      if (entry.phase === 'pending' || entry.phase === 'creating') superseded.push(entry)
    }
    this.onChange()
    return superseded
  }

  /** pane 关闭：清除全部条目（含保留项），兜底结算通道为 superseded。 */
  paneClosed(paneId: string, machine?: string): AskEntry[] {
    const removed: AskEntry[] = []
    for (const entry of [...this.entries_map.values()]) {
      if (entry.paneId === paneId && entry.machine === machine) {
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
  beginBlocked(machine: string | undefined, paneId: string, seq: number): BeginBlockedResult {
    const key = askKey(machine, paneId, seq)
    if (this.entries_map.has(key)) return { duplicate: true }
    const entry: AskEntry = {
      key,
      askId: key,
      machine,
      paneId,
      seq,
      phase: 'creating',
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
  settle(entry: AskEntry, outcome: { keysSent: boolean }): void {
    if (this.entries_map.get(entry.key) !== entry) return
    entry.phase = 'settled'
    entry.keysSent = outcome.keysSent
    entry.settledAt = Date.now()
    this.onChange()
  }

  /** 创建失败（IO/宿主错误/销单确认）：条目移除（允许后续重试），错误由调用方上抛。 */
  failCreate(entry: AskEntry): void {
    if (this.entries_map.get(entry.key) !== entry) {
      // 已被事件路径销单清除：仍兜底结算其通道，等待方不得悬挂。
      this.settleChannelOf(entry)
      return
    }
    this.removeEntry(entry)
    this.onChange()
  }

  /** owner 绑定结算通道（此后等待方可等）。 */
  bindSettlement(entry: AskEntry): AskSettlement {
    let channel = this.settlements.get(entry.askId)
    if (!channel) {
      channel = new AskSettlement()
      this.settlements.set(entry.askId, channel)
    }
    return channel
  }

  /** 等待方获取结算通道（未绑定时返回 undefined——owner 尚未就绪，调用方重试）。 */
  settlementOf(entry: AskEntry): AskSettlement | undefined {
    return this.settlements.get(entry.askId)
  }

  get(machine: string | undefined, paneId: string, seq: number): AskEntry | undefined {
    return this.entries_map.get(askKey(machine, paneId, seq))
  }

  /**
   * CAS seq 解析器（异步权威版）：askId -> 该 Ask 目标 pane 的**当前真实**
   * state_change_seq（agent.get 现查，绝不返回创建时的 entry.seq——CAS 的
   * 意义正是发现「创建后终端已按键推进」）。归属校验：askId 三段必须与
   * 条目 (machine, paneId, seq) 完全一致，防止伪造 id 越权探测他人窗格。
   */
  seqResolver(
    askId: string,
    authority: (machine: string | undefined, paneId: string) => Promise<number | undefined>,
  ): Promise<number | undefined> {
    const parsed = parseAskId(askId)
    if (parsed === undefined) return Promise.resolve(undefined)
    const entry = this.entries_map.get(askKey(parsed.machine, parsed.paneId, parsed.seq))
    if (entry === undefined || entry.askId !== askId) return Promise.resolve(undefined)
    return authority(parsed.machine, parsed.paneId)
  }

  /** 该 (pane,seq) 是否已发过键（防重发判断）。 */
  keysSent(machine: string | undefined, paneId: string, seq: number): boolean {
    return this.entries_map.get(askKey(machine, paneId, seq))?.keysSent === true
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

  /** 概览（overview doc；machine undefined 折叠为 'local' 保证 JSON-safe）。 */
  describe(): Array<{ paneId: string; machine: string; seq: number; phase: AskPhase }> {
    return [...this.entries_map.values()].map((e) => ({
      paneId: e.paneId,
      machine: e.machine ?? 'local',
      seq: e.seq,
      phase: e.phase,
    }))
  }

  /** 全部条目兜底结算（stop 清理路径：等待方不得悬挂）。 */
  settleAllAsSuperseded(): void {
    for (const channel of this.settlements.values()) channel.settle({ status: 'superseded', answers: {} })
    this.settlements.clear()
  }

  private settleChannelOf(entry: AskEntry): void {
    const channel = this.settlements.get(entry.askId)
    if (channel) {
      channel.settle({ status: 'superseded', answers: {} })
      this.settlements.delete(entry.askId)
    }
  }

  private removeEntry(entry: AskEntry): void {
    this.entries_map.delete(entry.key)
    this.settleChannelOf(entry)
  }
}

export function askKey(machine: string | undefined, paneId: string, seq: number): string {
  return `herdr:${machine ?? 'local'}:${paneId}:${seq}`
}

/** askId 即 askKey 字面量；machine 段原样保留（不折叠 local，防解析歧义）。 */
function parseAskId(askId: string): { machine: string | undefined; paneId: string; seq: number } | undefined {
  if (!askId.startsWith('herdr:')) return undefined
  const rest = askId.slice('herdr:'.length)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon <= 0) return undefined
  const panePart = rest.slice(0, lastColon)
  const seqPart = rest.slice(lastColon + 1)
  const seq = Number(seqPart)
  if (!Number.isSafeInteger(seq) || seq < 0 || seqPart !== String(seq)) return undefined
  const paneColon = panePart.indexOf(':')
  if (paneColon <= 0) return undefined
  const machine = panePart.slice(0, paneColon)
  const paneId = panePart.slice(paneColon + 1)
  if (paneId === '') return undefined
  return { machine: machine === 'local' ? undefined : machine, paneId, seq }
}

/**
 * 同 seq blocked 的「等待真实进展」：不 busy spin——watchdog 探针周期或
 * socket 事件驱动会推进权威 seq；本函数只提供可取消的退避等待，供 wait
 * 循环在收到重复同 seq blocked 时使用（避免立刻再投 agent.wait 打满通道）。
 */
export async function backoffForDuplicateBlocked(signal: AbortSignal, attempt: number): Promise<void> {
  const ms = Math.min(500 * 2 ** Math.min(attempt, 4), 4_000)
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
