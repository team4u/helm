/**
 * builtin:herdr 的 diagnostics.collect 探针采集（从 herdr.ts 拆出）。
 *
 * 巡检发起方（builtin:superagent Watchdog service）采集原生事实后经宿主
 * 内部事件追加本插件自有窗格的真实 probes（含远端轮询）。事件在宿主
 * await，采集失败如实上抛给发起方，绝不静默吞。
 * human 归属红线：非自有 pane 一律不产生 probe；总览重取为只读采集。
 */

import {
  DIAGNOSTICS_COLLECT_EVENT,
  appendProbes,
  parseCollection,
} from '../diagnostics.js'
import type { AskCoordinator, AskEntry } from './asks.js'
import type { HerdrTarget, HerdrTransport } from './contracts.js'
import type { HerdrExecutor } from './executor.js'
import type { OverviewProjector } from './overview.js'
import { nodeIdOf, scopeKey, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult } from './rpc.js'

/** 探针采集对插件主干（herdr.ts）的最小依赖面。 */
export interface HerdrProbeDeps {
  asks: AskCoordinator
  /** registry 现值（停用后 undefined：采集直接返回，不触达服务器）。 */
  registry(): PaneRegistry | undefined
  overview(): OverviewProjector | undefined
  executor(): HerdrExecutor | undefined
  transport(): HerdrTransport
  /** 本启用周期冻结的本机连接目标。 */
  localTarget(): HerdrTarget
  /** 本启用周期的连接 abort signal。 */
  signal(): AbortSignal
  /** 权威归属不符/窗格消失时的结算对齐（registry settled + executor 释放 + 缓存回收）。 */
  settleUnmanaged(pane: ManagedPane): void
  /** Ask 销单（404 静默；其余失败如实通知）。 */
  cancelAskQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void>
}

/**
 * 探针采集器：事件监听 + 单窗格探针构造（停滞水位维护与 facts 口径）。
 *
 * 观察水位（本启用周期；scopeKey(nodeId, paneId) 键）：
 * stalledMs 口径 = 「最近一次观察到 (status, seq) 变化的时点」至今的时长——
 * 首次观测从 0 起，水位或状态变化重置；探测失败（unreachable）不变更
 * 水位（读失败不是进展证据，停滞继续累计）。注意该口径只反映状态变迁，
 * 不含工作活动（长时间无状态翻转的活跃任务会如实表现为停滞递增）。
 */
export class HerdrProbeCollector {
  private readonly observations = new Map<string, { status: string; seq: number | undefined; since: number }>()
  /** 连续探测失败计数（agent.get 成功即清零；仅诊断事实，不触发自动动作）。 */
  private readonly failures = new Map<string, number>()

  constructor(private readonly deps: HerdrProbeDeps) {}

  /** 窗格从 registry 结算移除时同步回收观察水位/失败计数（防长驻泄漏）。 */
  forget(nodeId: string | undefined, paneId: string): void {
    const scope = scopeKey(nodeId, paneId)
    this.observations.delete(scope)
    this.failures.delete(scope)
  }

  /** 停用清空：水位与失败计数随启用周期作废（新周期从首次观测重新起算）。 */
  reset(): void {
    this.observations.clear()
    this.failures.clear()
  }

  /** 注册 diagnostics.collect 监听（与拆分前同：definePlugin 期一次注册，停用靠 registry 空值守卫）。 */
  register(host: { onEvent(type: string, listener: (payload: unknown) => Promise<void> | void): () => void }): void {
    host.onEvent(DIAGNOSTICS_COLLECT_EVENT, async (raw) => {
      await this.collect(raw)
    })
  }

  /** 单轮采集：入口边界校验 -> 总览重取 -> 并发探针 -> 追加（失败如实上抛给发起方）。 */
  private async collect(raw: unknown): Promise<void> {
    // 事件入口边界校验：非法载荷显式抛错给发布方（await 语义），不猜不吞。
    const collection = parseCollection(raw)
    const registry = this.deps.registry()
    if (!registry) return
    const overview = this.deps.overview()
    if (overview !== undefined) {
      // cwd/seen 等无事件变化（官方 actions.rs:1780 只改 cwd 不发事件）
      // 依赖本 tick 重取快照对齐；单飞合并，不新增独立定时器。
      await overview.refresh(registry, this.deps.asks, this.deps.localTarget())
    }
    const now = Date.now()
    const activePanes = registry.all().filter((pane) => pane.outcome !== 'settled')
    // 并发探针：单窗格 agent.get 带 5s 短超时且 Promise.all 并发采集，
    // 防止单个慢/挂节点串行卡死采集预算。
    const probes = await Promise.all(
      activePanes.map(async (pane): Promise<ReturnType<HerdrProbeCollector['buildProbe']> | undefined> => {
        const scope = scopeKey(nodeIdOf(pane), pane.paneId)
        let status = 'unknown'
        let authoritySeq: number | undefined
        try {
          const info = parseAgentResult(
            await this.deps.transport().call(
              pane.target,
              'agent.get',
              { target: pane.paneId },
              { signal: this.deps.signal(), timeoutMs: 5_000 },
            ),
            'agent.get',
            'agent_info',
          )
          if (info.name !== pane.agentName || info.tabId !== pane.tabId) {
            this.deps.settleUnmanaged(pane)
            return undefined
          }
          for (const superseded of this.deps.asks.observeAuthority({
            paneId: pane.paneId,
            nodeId: nodeIdOf(pane),
            seq: info.stateChangeSeq,
            status: info.agentStatus,
          })) {
            await this.deps.cancelAskQuietly(superseded, 'superseded')
          }
          status = info.agentStatus
          authoritySeq = info.stateChangeSeq
          this.failures.delete(scope)
        } catch {
          status = 'unreachable'
          // 权威不可达：绝不猜造 seq；水位不变更（停滞继续累计），
          // 连续失败计数如实递增。
          this.failures.set(scope, (this.failures.get(scope) ?? 0) + 1)
        }
        return this.buildProbe(pane, status, authoritySeq, now)
      }),
    )
    appendProbes(collection, probes.filter((probe) => probe !== undefined))
  }

  /** 单窗格探针构造（停滞水位维护与 facts 口径；采集事件主体）。 */
  private buildProbe(
    pane: ManagedPane,
    status: string,
    authoritySeq: number | undefined,
    now: number,
  ) {
    const scope = scopeKey(nodeIdOf(pane), pane.paneId)
    // 停滞水位：首次观测从 0 起；(status, seq) 任一变化重置；
    // unreachable 保持旧水位累计（读失败不是进展证据，不用总运行时长
    // 冒充停滞，也不因探测失败归零重跑）。
    const prev = this.observations.get(scope)
    let stalledMs = 0
    if (status === 'unreachable') {
      // 读失败：沿用旧观测点继续累计（无旧观测时从当下起算，不伪造进展）。
      if (prev !== undefined) {
        stalledMs = now - prev.since
      } else {
        this.observations.set(scope, { status, seq: undefined, since: now })
      }
    } else if (prev === undefined || prev.status !== status || prev.seq !== authoritySeq) {
      this.observations.set(scope, { status, seq: authoritySeq, since: now })
    } else {
      stalledMs = now - prev.since
    }
    const pendingAskCount = this.deps.asks
      .entries()
      .filter(
        (e) =>
          e.paneId === pane.paneId &&
          e.nodeId === nodeIdOf(pane) &&
          (e.phase === 'pending' || e.phase === 'creating'),
      ).length
    return {
      targetId: pane.paneId,
      targetKind: 'external' as const,
      nodeId: nodeIdOf(pane) ?? 'local',
      ownedBy: 'helm' as const,
      status,
      ...(authoritySeq !== undefined ? { stateChangeSeq: authoritySeq } : {}),
      stalledMs,
      ...(status === 'unreachable' ? { consecutiveErrors: this.failures.get(scope) ?? 1 } : {}),
      facts: {
        kind: 'herdr',
        agentName: pane.agentName,
        outcome: pane.outcome,
        effectiveCwd: pane.effectiveCwd,
        parentConversationId: pane.parentConversationId,
        pendingAskCount,
        // 口径如实：stalledMs 基于状态/水位变化观察时点，不含工作活动。
        stalledBasis: 'since-last-state-change',
      },
    }
  }
}
