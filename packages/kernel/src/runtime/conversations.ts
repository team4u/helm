/**
 * ConversationTracker：pi-durable 会话的 helm 视图层。
 *
 * 核心机制：observeConversation 同步观察者（advance 内禁止 await，只做记录），
 * 在快照推进时同步维护内存镜像与排队副作用（SSE 推送在微任务中发出）。
 *
 * turn_settled 精确捕获（主代理核对点）：
 * - busy 期间 submit 把 submissionId -> ConversationInput 记入 pendingInputs；
 * - 观察 pi.live：
 *   - run.inputs 变化 -> 记录「本回合消费的 submissionId 集」（只增不减，完成期
 *     inputs 清空不丢失已消费记录）；
 *   - runFailure.inputs -> 失败回合的真实消费输入；
 * - run 消失（完成或失败）时一次性结算 turn_settled(completed|failed)；
 * - abort 由 runtime.abortConversation 显式结算（aborted）；
 * - 绝不用全会话 pendingInputs 估计消费来源。
 */

import type {
  ConversationInput,
  ConversationStatus,
  ConversationSummary,
  TurnOutcome,
  TurnSettledPayload,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness, ConversationView, Observation, Observer } from '@earendil-works/pi-durable'
import type { ConvMeta, HelmStore } from './store.js'
import { summaryOf } from './store.js'

interface LiveStateShape {
  run?: { taskId: number; inputs: number[]; turns?: number }
  generation?: unknown
  tools?: Array<{ callId: string; name: string; status: string; output?: string }>
  runFailure?: { taskId: number; inputs: number[]; reason: string; detail?: string }
}

export interface TurnSettledListener {
  (payload: TurnSettledPayload, consumedInputs: ConversationInput[]): void
}

export interface TrackerEvents {
  onSummaryChanged(summary: ConversationSummary): void
  onInputCommitted(conversationId: number, input: ConversationInput): void
  onAssistantText(conversationId: number, entryId: number, text: string): void
  onTurnSettled: TurnSettledListener
}

export class ConversationTracker {
  private readonly harness: Harness
  private readonly store: HelmStore
  private readonly events: TrackerEvents
  /** SDK 观察者返回的 detach 集合。 */
  private readonly detach = new Map<number, () => void>()
  /** 会话 -> 当前 live 镜像（最近一次 advance 值）。 */
  private readonly liveViews = new Map<number, LiveStateShape>()
  /** submissionId -> input（提交时登记，run 消费后转移）。 */
  private readonly pendingInputs = new Map<number, Map<number, ConversationInput>>()
  /** 本回合已消费 submissionId -> input（run 存续期间累计）。 */
  private readonly consumedInputs = new Map<number, Map<number, ConversationInput>>()
  /** 当前 run 的 taskId（用于区分新旧回合）。 */
  private readonly runTaskIds = new Map<number, number>()
  /** 已结算的 run（防 done+failure 双报）。 */
  private readonly settledRuns = new Set<string>()

  constructor(options: { harness: Harness; store: HelmStore; events: TrackerEvents }) {
    this.harness = options.harness
    this.store = options.store
    this.events = options.events
  }

  /** 挂接指定会话的同步观察者。 */
  async observe(id: number): Promise<void> {
    if (this.detach.has(id)) return
    const observer: Observer<ConversationView> = {
      advance: (call) => {
        if (call.kind !== 'value') return
        this.adopt(id, call.value)
      },
      end: () => {
        this.detach.delete(id)
      },
    }
    const observation: Observation<ConversationView> = await this.harness.observeConversation(
      id as never,
      observer,
      BACKGROUND_CONTEXT,
    )
    this.detach.set(id, () => observation.detach())
    this.adopt(id, observation.value)
  }

  stopObserving(id: number): void {
    this.detach.get(id)?.()
    this.detach.delete(id)
    this.liveViews.delete(id)
  }

  /** 提交前登记 input 元数据（submissionId 在 submit 返回后回填）。 */
  registerInput(conversationId: number, input: ConversationInput): number {
    const map = this.pendingInputs.get(conversationId) ?? new Map()
    const key = nextInputKey()
    map.set(key, input)
    this.pendingInputs.set(conversationId, map)
    return key
  }

  /** submit 返回后绑定真实 submissionId（ HelmError 时移除登记）。 */
  bindSubmission(conversationId: number, key: number, submissionId: number): void {
    const map = this.pendingInputs.get(conversationId)
    const input = map?.get(key)
    if (!map || !input) return
    map.delete(key)
    map.set(submissionId, input)
  }

  dropInput(conversationId: number, key: number): void {
    this.pendingInputs.get(conversationId)?.delete(key)
  }

  /** abort 结算（runtime.abortConversation 调用；run 观察路径不覆盖 aborted）。 */
  settleAborted(conversationId: number): void {
    const consumed = this.takeConsumed(conversationId)
    const queued = [...(this.pendingInputs.get(conversationId)?.values() ?? [])]
    const all = [...consumed, ...queued]
    this.pendingInputs.delete(conversationId)
    this.consumedInputs.delete(conversationId)
    this.runTaskIds.delete(conversationId)
    this.emitSettled(conversationId, 'aborted', all, undefined)
  }

  private adopt(id: number, view: ConversationView): void {
    const live = view.docs['pi.live'] as LiveStateShape | undefined
    const prev = this.liveViews.get(id)
    this.liveViews.set(id, live ?? {})

    // 新 assistant 文本：从窗口尾部提取（entry kind pi.assistant，model 首块文本）。
    for (let i = view.entries.length - 1; i >= 0; i -= 1) {
      const entry = view.entries[i] as
        | { kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }
        | undefined
      if (entry !== undefined && entry.kind === 'pi.assistant') {
        const text = assistantTextOf(entry)
        if (text !== '') {
          this.events.onAssistantText(id, entry.id, text)
          break
        }
      }
    }

    // 新输入 entry 落盘：helm.input 数据在 entry.model（pi.user），这里只索引正文。
    if (live?.run) {
      const runKey = `${id}:${live.run.taskId}`
      if (this.runTaskIds.get(id) !== live.run.taskId) {
        // 新 run 开始：重置本回合消费集。
        this.runTaskIds.set(id, live.run.taskId)
        this.consumedInputs.set(id, new Map())
        this.settledRuns.delete(runKey)
      }
      for (const submissionId of live.run.inputs) {
        this.markConsumed(id, submissionId)
      }
      // 完成期（answered，inputs 已清空）不动 consumedInputs——保留已消费记录。
    }

    if (!live?.run && prev?.run) {
      // run 结束：成功 or 失败。
      const prevRun = prev.run
      const runKey = `${id}:${prevRun.taskId}`
      if (!this.settledRuns.has(runKey)) {
        this.settledRuns.add(runKey)
        const failure = live?.runFailure
        if (failure && failureInputsInclude(failure, prevRun)) {
          // 失败：消费输入来自 runFailure.inputs（精确清单）。
          for (const submissionId of failure.inputs) this.markConsumed(id, submissionId)
          const consumed = this.takeConsumed(id)
          this.pendingInputs.delete(id)
          this.emitSettled(id, 'failed', consumed, `${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`)
        } else {
          // 完成。
          const consumed = this.takeConsumed(id)
          this.pendingInputs.delete(id)
          this.emitSettled(id, 'completed', consumed, undefined)
        }
        this.consumedInputs.delete(id)
        this.runTaskIds.delete(id)
      }
    }
  }

  private markConsumed(conversationId: number, submissionId: number): void {
    const pending = this.pendingInputs.get(conversationId)
    const input = pending?.get(submissionId)
    if (!pending || !input) return
    pending.delete(submissionId)
    const consumed = this.consumedInputs.get(conversationId) ?? new Map()
    consumed.set(submissionId, input)
    this.consumedInputs.set(conversationId, consumed)
    this.events.onInputCommitted(conversationId, input)
  }

  private takeConsumed(conversationId: number): ConversationInput[] {
    const map = this.consumedInputs.get(conversationId)
    const out = map ? [...map.values()] : []
    this.consumedInputs.delete(conversationId)
    return out
  }

  private emitSettled(
    conversationId: number,
    outcome: TurnOutcome,
    inputs: ConversationInput[],
    error: string | undefined,
  ): void {
    const summary = this.summaryOf(conversationId, outcome)
    const payload: TurnSettledPayload = {
      conversation: summary,
      inputs,
      outcome,
      error,
      settledAt: Date.now(),
    }
    // completionSeq 推进 + unread 置位（human 显式 patch 才清零）。
    const meta = this.store.getConv(conversationId)
    if (meta) {
      const updated: ConvMeta = {
        ...meta,
        unread: outcome === 'completed',
        completionSeq: meta.completionSeq + 1,
        stateChangeSeq: meta.stateChangeSeq + 1,
        updatedAt: Date.now(),
      }
      this.store.upsertConv(updated)
      this.events.onSummaryChanged(summaryOf(updated, updated.unread && outcome === 'completed' ? 'done' : statusNow(updated, outcome), 0))
    }
    this.events.onTurnSettled(payload, inputs)
  }

  /** 由 store meta + live 镜像派生五态。 */
  summaryOf(conversationId: number, pendingAskOverride?: number | TurnOutcome): ConversationSummary {
    const meta = this.store.getConv(conversationId)
    if (!meta) throw new HelmError('not_found', `会话不存在：${conversationId}`, 404)
    const live = this.liveViews.get(conversationId)
    const pendingAsks =
      typeof pendingAskOverride === 'number'
        ? pendingAskOverride
        : (this.pendingAskCounts.get(conversationId) ?? 0)
    let status: ConversationStatus
    if (pendingAskOverride === 'aborted') {
      status = 'idle'
    } else if (live?.run) {
      status = 'working'
    } else if (pendingAsks > 0) {
      status = 'blocked'
    } else if (live?.runFailure) {
      status = 'error'
    } else {
      status = meta.unread ? 'done' : 'idle'
    }
    const doing = live?.run
      ? live.tools && live.tools.length > 0
        ? `${live.tools[live.tools.length - 1]?.name}: running`
        : 'thinking…'
      : undefined
    return summaryOf(meta, status, pendingAsks, doing)
  }

  private readonly pendingAskCounts = new Map<number, number>()

  setPendingAskCount(conversationId: number, count: number): void {
    this.pendingAskCounts.set(conversationId, count)
    this.events.onSummaryChanged(this.summaryOf(conversationId, count))
  }

  /** 观察到的最新 assistant 文本（getLastAssistantText 数据源）。 */
  private readonly lastAssistant = new Map<number, { entryId: number; text: string }>()

  recordAssistantText(conversationId: number, entryId: number, text: string): void {
    this.lastAssistant.set(conversationId, { entryId, text })
  }

  getLastAssistantText(conversationId: number): string | undefined {
    return this.lastAssistant.get(conversationId)?.text
  }
}

function failureInputsInclude(
  failure: NonNullable<LiveStateShape['runFailure']>,
  prevRun: NonNullable<LiveStateShape['run']>,
): boolean {
  // 同一 task 结束且带 runFailure：失败终态。
  return failure.taskId === prevRun.taskId || failure.inputs.length > 0
}
function statusNow(meta: ConvMeta, outcome: TurnOutcome): ConversationStatus {
  if (outcome === 'failed') return 'error'
  if (outcome === 'aborted') return 'idle'
  return meta.unread ? 'done' : 'idle'
}

// 输入登记的临时 key 使用负数，避免与 submissionId 冲突。
let inputKeySeq = -1
function nextInputKey(): number {
  inputKeySeq -= 1
  return inputKeySeq
}

/** 提取 assistant entry 的文本块内容。 */
function assistantTextOf(entry: {
  model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }>
}): string {
  const blocks = entry.model?.[0]?.content
  if (!blocks) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export { deriveTitle }

/** 首输入标题：剥离代码块与换行，取前 36 个有效字符。 */
function deriveTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 36) || '新会话'
}
