/**
 * 会话级 contextUsage 同步缓存与异步刷新链（自 conversations.ts 拆出）。
 *
 * 状态分两层：
 * - 同步可读缓存（cache/keys/entryWatermark/waiters）：随 stopObserving 清理
 *   （waiters 先 resolve 再清，防永久挂起）；迟到刷新经观察代数守护丢弃；
 * - 刷新链生命周期（pending/dirty）：在途刷新可跨越停观（stopObserving 不清
 *   pending——finally 兜底清理，新触发照常 dirty 追加），因此不进
 *   ConversationMirror（见 conversation-mirror.ts 的例外清单）。
 *
 * 帧纪律（迁移前语义原样保持）：
 * - 首次填充静默（快照/HTTP 读自然可见），唯一例外：填充即携带 compacting
 *   必须发布（否则订阅方永远看不到该状态）；
 * - run 活跃期间仅 compacting / contextWindow 变化发帧（token 瞬态等结算帧）；
 * - 发布不推进 stateChangeSeq（CAS 水位线专属，派生展示数据不得污染）。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ContextView, ConversationView, Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { ConversationContextUsage, ConversationSummary } from '@helm/protocol'
import type { LiveStateShape } from './conversation-mirror.js'
import type { ConvMeta, HelmStore } from './store.js'
import { knownContextWindowOf } from './models.js'
import {
  assembleContextUsage,
  compactionLiveKeyOf,
  compactingOf,
  contextUsageKeyOf,
  estimateContextUsage,
} from './context-usage.js'
import type { EntryRecordLike } from './entries.js'

/** 刷新链对宿主（ConversationTracker）的最小端口。 */
export interface ContextUsageHost {
  readonly harness: Harness
  readonly store: HelmStore
  /** 摘要推送（conversation.upsert 语义帧）。 */
  onSummaryChanged(summary: ConversationSummary): void
  /** 当前 Models 集合现读（缺省不解析：contextWindow 省略，绝不伪造）。 */
  modelsOf(): Models | undefined
  /** 观察代数现读（迟到刷新结果丢弃判定）。 */
  generationOf(conversationId: number): symbol | undefined
  /** live 镜像现读（压缩状态与 run 活跃判定）。 */
  liveOf(conversationId: number): LiveStateShape | undefined
  /** 权威摘要现读（发布帧构造；内部回读本模块缓存，不形成调度环）。 */
  summaryOf(conversationId: number): ConversationSummary
  /** 宿主关停守卫（harness.close 先行关闭后阻断对已关闭 Harness 的无谓刷新）。 */
  isClosing?(): boolean
}

export class ContextUsageRefresh {
  /** 会话 -> 当前缓存值（summaryOf 同步读取；undefined = 尚未计算）。 */
  private readonly cache = new Map<number, ConversationContextUsage>()
  /** 会话 -> 最近一次已发布指纹（相同不重发 conversation.upsert）。 */
  private readonly keys = new Map<number, string>()
  /** 会话 -> 上下文触发已扫描到的最大 entry id（独立推进：无 sink 时也能去重）。 */
  private readonly entryWatermark = new Map<number, number>()
  /** 会话 -> 刷新链 settle 等待者（ensureContextUsage 唤醒用；停观兜底 resolve）。 */
  private readonly waiters = new Map<number, Array<() => void>>()
  /** 刷新在途的会话（防止重复刷新；新触发置 dirty 待重跑）。 */
  private readonly pending = new Set<number>()
  /** 在途期间收到新触发信号的会话（完成后重跑一次）。 */
  private readonly dirty = new Set<number>()

  constructor(private readonly host: ContextUsageHost) {}

  /** 同步读缓存（不调度）。 */
  peek(conversationId: number): ConversationContextUsage | undefined {
    return this.cache.get(conversationId)
  }

  /** 已缓存会话清单（onModelsChanged 定向迫齐目标之一）。 */
  cachedConversationIds(): number[] {
    return [...this.cache.keys()]
  }

  /** 同步读缓存；缺失时调度一次性后台刷新（去重：在途置 dirty、已缓存不重跑）。 */
  cachedOrSchedule(conversationId: number): ConversationContextUsage | undefined {
    const cached = this.cache.get(conversationId)
    if (cached !== undefined) return cached
    this.schedule(conversationId)
    return undefined
  }

  /** 调度异步上下文用量刷新（fire-and-forget；observe 回调内同步调用不可 await）。 */
  schedule(conversationId: number): void {
    if (this.host.isClosing?.()) return
    if (!this.host.store.getConv(conversationId)) return
    if (this.pending.has(conversationId)) {
      this.dirty.add(conversationId)
      return
    }
    this.pending.add(conversationId)
    void this.refreshOnce(conversationId)
      .catch((error: unknown) => {
        if (this.host.isClosing?.()) return
        // 刷新失败如实记录：缓存保持旧值（绝不静默伪造），不阻断观察主路径。
        console.error(`[helm] 会话 ${conversationId} 上下文用量刷新失败:`, error)
      })
      .finally(() => {
        this.pending.delete(conversationId)
        // 在途期间又有真实变化（新回合结算/压缩/rewind）：重跑一次迫齐。
        if (this.dirty.delete(conversationId)) {
          this.schedule(conversationId)
        }
        // 唤醒等待方（ensureContextUsage）：自行复查缓存/在途状态决定返回或续等。
        const waiters = this.waiters.get(conversationId)
        if (waiters !== undefined) {
          this.waiters.delete(conversationId)
          for (const resolve of waiters) resolve()
        }
      })
  }

  /** 确保该会话 contextUsage 缓存已填充且刷新链归寂（首个详情读等同步可见路径）。
   *
   * - 已缓存且无在途刷新：立即返回（已缓存的分页读零开销，不重复刷新）；
   * - 缺失或在途：等待刷新链 settle（多调用方合并同一次刷新；dirty 重跑链
   *   同样等待到归寂，避免「缓存已设但链未完」时读到即将被迫齐的旧值）；
   * - 每轮等待都由真实「刷新链 settle」事件推进（无轮询无 sleep）；上限
   *   8 轮仅防御病态链（持续被代数守护丢弃且不断有新触发）。
   */
  async ensure(conversationId: number): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      if (this.cache.has(conversationId) && !this.pending.has(conversationId)) {
        return
      }
      if (!this.host.store.getConv(conversationId)) return
      if (!this.pending.has(conversationId)) {
        this.schedule(conversationId)
        // 调度被拒（会话恰好被删）：不再等待，如实返回。
        if (!this.pending.has(conversationId)) return
      }
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(conversationId) ?? []
        list.push(resolve)
        this.waiters.set(conversationId, list)
      })
    }
  }

  /** adoptInitial 水位线对齐：初始快照内的历史标记条目（pi.compaction 等）
   * 不触发后续 adopt 的重复刷新（与 lastEmittedEntry 同一初值来源）。 */
  advanceWatermarkTo(conversationId: number, value: number): void {
    const current = this.entryWatermark.get(conversationId) ?? 0
    if (value > current) this.entryWatermark.set(conversationId, value)
  }

  /** 上下文边界扫描：仅超过旧水位线的新条目中出现 pi.compaction /
   * pi.reset / helm.rewind，或 pi.live 压缩状态（compactions/compactionFailure）
   * 指纹变化时才触发刷新。历史标记条目不重复触发（否则流式期间每次快照都
   * 重调度，写放大）；水位线单调推进。独立水位线（与 onEntryCommitted 无关）：
   * 无 entry sink 的观察者同样去重。 */
  noteBoundary(
    id: number,
    view: ConversationView,
    prev: LiveStateShape | undefined,
    live: LiveStateShape | undefined,
  ): void {
    const old = this.entryWatermark.get(id) ?? 0
    let watermark = old
    let boundary = false
    for (const raw of view.entries as never as ReadonlyArray<EntryRecordLike>) {
      const numeric = Number(raw.id)
      if (!Number.isFinite(numeric) || numeric <= old) continue
      if (numeric > watermark) watermark = numeric
      const kind = (raw as { kind?: unknown }).kind
      if (kind === 'pi.compaction' || kind === 'pi.reset' || kind === 'helm.rewind') boundary = true
    }
    this.entryWatermark.set(id, watermark)
    // prev 恒为对象镜像（live 归一为 ?? {}）；live 原始 doc 缺失时归一为空对象，
    // 避免「无 pi.live doc 的快照」首帧因 undefined vs {} 指纹差异误触发刷新。
    if (boundary || compactionLiveKeyOf(prev) !== compactionLiveKeyOf(live ?? {})) {
      this.schedule(id)
    }
  }

  /** stopObserving：清缓存/指纹/脏标/水位线并唤醒等待者（醒来后自查缓存/
   * 元数据并退出）；pending 刻意保留（在途刷新的 finally 兜底清理，跨越停观
   * 的迟到结果经代数守护丢弃，不复活）。 */
  clearConversation(conversationId: number): void {
    this.cache.delete(conversationId)
    this.keys.delete(conversationId)
    this.dirty.delete(conversationId)
    this.entryWatermark.delete(conversationId)
    const waiters = this.waiters.get(conversationId)
    if (waiters !== undefined) {
      this.waiters.delete(conversationId)
      for (const resolve of waiters) resolve()
    }
  }

  /** 单次刷新：读真实 ContextView + 模型窗口 + live 压缩状态，变化才发布。 */
  private async refreshOnce(conversationId: number): Promise<void> {
    const meta = this.host.store.getConv(conversationId)
    if (!meta) return
    // 代数守护：await 前捕获；未观察（undefined）同样参与比较——刷新期间并发
    // observe（换代）/stopObserving（删除令牌）都会改变当前值，迟到结果丢弃。
    const generation = this.host.generationOf(conversationId)
    const conversation = await this.host.harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
    if (!conversation) return
    const view = await conversation.context(BACKGROUND_CONTEXT)
    if (this.host.generationOf(conversationId) !== generation) return
    // 会话可能在 await 期间被删除：迟到结果不得复活缓存或发事件。
    if (!this.host.store.getConv(conversationId)) return
    this.apply(conversationId, meta, view)
  }

  /** 应用刷新结果：组装 -> 指纹比对 -> 缓存 + 发布（不推进 stateChangeSeq）。 */
  private apply(conversationId: number, meta: ConvMeta, view: ContextView): void {
    const live = this.host.liveOf(conversationId)
    const slash = meta.model.indexOf('/')
    const models = this.host.modelsOf()
    const model =
      slash > 0 && slash < meta.model.length - 1 && models !== undefined
        ? models.getModel(meta.model.slice(0, slash), meta.model.slice(slash + 1))
        : undefined
    // 窗口来源诚实性：模型不在当前 Models 集合，或窗口是静态保守缺省
    // （compat 网关 / Magpie 目录缺上游窗口，helmContextWindowKnown === false）
    // 时不携带 contextWindow——绝不把 128k 缺省冒充真实窗口。
    const contextWindow = knownContextWindowOf(model)
    const compacting = compactingOf(live?.compactions)
    const usage = assembleContextUsage({
      estimate: estimateContextUsage(view),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(compacting !== undefined ? { compacting } : {}),
    })
    const key = contextUsageKeyOf(usage)
    const previous = this.cache.get(conversationId)
    const previousKey = this.keys.get(conversationId)
    // 缓存先行更新：HTTP / SSE 快照读立即看到新值（事件是否另发见下）。
    this.cache.set(conversationId, usage)
    this.keys.set(conversationId, key)
    // 首次填充默认静默：值经快照 / HTTP 读自然可见，不发事件（避免启动期每
    // 会话一帧噪声，维持「终态后无重复语义帧」的既有帧纪律）。唯一例外：
    // 填充时已携带压缩进行中状态（compacting，如启动期恢复进行中压缩、首次
    // 刷新落在手动压缩窗口内）必须发布——否则没有任何后续语义帧会携带它，
    // 订阅方将永远看不到该状态。
    if (previousKey === undefined) {
      if (usage.compacting !== undefined) {
        this.host.onSummaryChanged(this.host.summaryOf(conversationId))
      }
      return
    }
    if (key === previousKey) return
    // run 活跃期间：仅压缩实时状态（compacting）与上下文窗口（contextWindow）
    // 变化才发帧；token 变化是瞬态，等本回合结算帧携带（emitSettled 附加
    // 缓存值），避免 working 期间重复 doing 语义帧（帧纪律：不逐 token 发
    // 摘要）。窗口变化是目录刷新/模型切换带来的语义事实，不是逐 token 噪声，
    // 不得静默到回合结束；同样不推进 stateChangeSeq。
    if (this.host.liveOf(conversationId)?.run !== undefined) {
      const compactionChanged = (previous?.compacting ?? null) !== (usage.compacting ?? null)
      const windowChanged = (previous?.contextWindow ?? null) !== (usage.contextWindow ?? null)
      if (!compactionChanged && !windowChanged) return
    }
    // 发布摘要（携带新 usage）：不推进 stateChangeSeq——水位线专属状态机/
    // doing/Ask 的 CAS 语义，派生展示数据不得污染（否则 pending Ask 会被伪
    // superseded、guarded 提交被伪 409）。摘要语义指纹不含 usage，无需重登记。
    this.host.onSummaryChanged(this.host.summaryOf(conversationId))
  }
}
