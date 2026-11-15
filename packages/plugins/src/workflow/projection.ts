/**
 * builtin:workflow run 投影与会话分片文档（自 workflow.ts 入口拆出）。
 *
 * 职责：
 * - 公共 `runs` 投影按会话分片（ctx.sessionDoc，每会话分片含自身及后代
 *   发起的 run——沿真实会话父链防环/缺父，run.conversationId 保持原始
 *   归属；不进全局首帧/全局 SSE，会话新增/删除经宿主事件重投影）；
 * - 全局仅保留紧凑 `run-badges` 角标文档（每会话聚合 count/tone/
 *   footerText，按 run.id 去重，无完整 run 摘要）；
 * - 值缓存幂等写入（值相等跳过，无写放大）；受控 stop 时序：stopping
 *   标记拦截运行期后台回调的投影刷新，stop 链内的最终同步走 syncFinal
 *   （不受拦截，失败如实上抛）。
 */
import type { PluginDocHandle, PluginSessionDocHandle } from '@helm/protocol'
import {
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
  type WorkflowRunSummary,
} from '../contracts.js'

/** runs 分片 + 角标投影（含 stopping 门与树变化指纹缓存）。 */
export interface RunsProjection {
  /** 运行期投影刷新（stopping 后为 no-op）。 */
  sync(): void
  /** 受控 stop 末尾的最终投影：禁止被 stopping 拦截；写失败上抛（不吞）。 */
  syncFinal(): void
  /** 置停止标记：stop 之后的引擎回调不再触碰 runs 投影（doc 句柄已交还）。 */
  beginStopping(): void
  isStopping(): boolean
  /** start 时从持久层快照已写分片的会话集合（此后增量维护）。 */
  adoptPersistedConversations(ids: Iterable<number>): void
  /** 会话树（id + 父链）变化后的重投影；树未变跳过（无写放大）。 */
  reprojectOnConversationTreeChange(): void
  /** 会话删除后的重投影（孤儿分片不重建）。 */
  reprojectOnConversationDeleted(): void
}

/**
 * 序列化稳定性键：runs 顺序即引擎返回顺序，JSON 直比（字段由引擎结构化产出）。
 */
function runsProjectionKey(runs: WorkflowRunSummary[]): string {
  return JSON.stringify(runs)
}

export function createRunsProjection(deps: {
  runsDoc: PluginSessionDocHandle<WorkflowRunSessionDocState>
  badgesDoc: PluginDocHandle<WorkflowRunBadgesDocState>
  listRuns: () => WorkflowRunSummary[]
  listConversations: () => Array<{ id: number; parentConversationId?: number }>
}): RunsProjection {
  const { runsDoc, badgesDoc } = deps

  /** 停止中标记：stop 之后的引擎回调不再触碰 runs 投影（doc 句柄已交还）。 */
  let stopping = false

  /** 上一轮已写分片的值缓存（值相等时跳过写入，不发重复事件）。 */
  const writtenRunsByConv = new Map<number, string>()
  /** 上一轮已写角标摘要（值相等时跳过写入）。 */
  let writtenBadgesJson = ''
  /**
   * 已持久化过 runs 分片的会话 ID 集合（start 时从持久层快照一次，此后
   * 增量维护）。不复用句柄 listConversationIds 的原因：受控 stop 窗口内
   * 该只读端口会被 assertNotDisposed 拒绝，而最终投影必须能在 stop 链内
   * 写入；快照语义等价（分片只由本插件写入）。
   */
  const persistedRunsConvs = new Set<number>()
  /** 会话树指纹缓存（conversation.upsert 高频：树未变则跳过重投影）。 */
  let conversationTreeFingerprint = ''

  function writeRunsDoc(): void {
    const runs = deps.listRuns()
    // 会话存在集合：删除的父会话不重建孤儿 doc（store 已级联清理）。
    const existing = new Map<number, { parentConversationId?: number }>()
    for (const conversation of deps.listConversations()) {
      existing.set(conversation.id, conversation)
    }

    /**
     * 发起会话的祖先链（仅含仍存在的会话）：沿真实会话 parent 链上行，
     * visited 防环（父链环按链断处理，不性深入），缺父即止（不虚构祖先）。
     */
    const ancestorChains = new Map<number, number[]>()
    const ancestorsOf = (id: number): number[] => {
      const cached = ancestorChains.get(id)
      if (cached !== undefined) return cached
      const chain: number[] = []
      const visited = new Set<number>([id])
      let current = existing.get(id)
      while (current !== undefined) {
        const parent = current.parentConversationId
        if (parent === undefined || visited.has(parent)) break
        visited.add(parent)
        if (!existing.has(parent)) break
        chain.push(parent)
        current = existing.get(parent)
      }
      ancestorChains.set(id, chain)
      return chain
    }

    // 1) 会话分片：自身 + 后代发起的 runs（run.conversationId 保持原始
    //    归属，不改写为投影目标）；按 run.id 去重（防御索引异常形状），
    //    顺序保持引擎全局序（createdAt 倒序）。发起会话已删除的 run 父链
    //    事实不可达（父链存在子会话上），不投影到任何分片。
    const runsByConversation = new Map<number, WorkflowRunSummary[]>()
    for (const run of runs) {
      if (!existing.has(run.conversationId)) continue
      const targets = new Set<number>([run.conversationId, ...ancestorsOf(run.conversationId)])
      for (const target of targets) {
        const list = runsByConversation.get(target) ?? []
        if (list.some((r) => r.id === run.id)) continue
        list.push(run)
        runsByConversation.set(target, list)
      }
    }
    for (const convId of persistedRunsConvs) {
      if (!existing.has(convId)) {
        persistedRunsConvs.delete(convId)
        continue
      }
      // 已持久会话：无可见 runs 时清到空（不保留旧投影）；尚未写入的不重建。
      if (!runsByConversation.has(convId)) runsByConversation.set(convId, [])
    }
    for (const [convId, convRuns] of runsByConversation) {
      const key = runsProjectionKey(convRuns)
      if (writtenRunsByConv.get(convId) === key) continue
      runsDoc.set(convId, { runs: convRuns })
      writtenRunsByConv.set(convId, key)
      persistedRunsConvs.add(convId)
    }

    // 2) 全局紧凑角标（有意全局：仅导航元数据，无完整 run 摘要）：与分片
    //    同源的后代聚合（分片本身已按 run.id 去重），幂等值比对写入。
    const byConversation: WorkflowRunBadgesDocState['byConversation'] = {}
    for (const [convId, convRuns] of runsByConversation) {
      if (convRuns.length === 0) continue
      const running = convRuns.filter((r) => r.status === 'running').length
      const failed = convRuns.filter((r) => r.status === 'failed').length
      byConversation[String(convId)] = {
        count: convRuns.length,
        tone: running > 0 ? 'accent' : failed > 0 ? 'warn' : 'neutral',
        footerText: [
          running > 0 ? `${running} 运行中` : '',
          failed > 0 ? `${failed} 失败` : '',
        ].filter((s) => s !== '').join(' · '),
      }
    }
    const badgesJson = JSON.stringify(byConversation)
    if (badgesJson !== writtenBadgesJson) {
      badgesDoc.set({ byConversation })
      writtenBadgesJson = badgesJson
    }
  }

  /**
   * 同步 runs 会话分片投影与全局紧凑角标（含按会话聚合的角标统计）。
   * stopping 拦截的只有运行期后台回调（引擎事件链里的投影刷新）；受控 stop
   * 链内的最终同步走 syncFinal（不受 stopping 拦截，写入经宿主受控停止
   * doc 作用域放行，失败如实上抛）。
   */
  function sync(): void {
    if (stopping) return
    writeRunsDoc()
  }

  function syncFinal(): void {
    writeRunsDoc()
  }

  function reprojectOnConversationTreeChange(): void {
    if (stopping) return
    try {
      const fingerprint = JSON.stringify(
        deps
          .listConversations()
          .map((c) => [c.id, c.parentConversationId ?? null] as const)
          .sort((a, b) => a[0] - b[0]),
      )
      if (fingerprint === conversationTreeFingerprint) return
      writeRunsDoc()
      conversationTreeFingerprint = fingerprint
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话树变化后的 runs 投影失败: ${message}\n`)
    }
  }

  function reprojectOnConversationDeleted(): void {
    if (stopping) return
    try {
      writeRunsDoc()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话删除后的 runs 投影失败: ${message}\n`)
    }
  }

  return {
    sync,
    syncFinal,
    beginStopping: () => {
      stopping = true
    },
    isStopping: () => stopping,
    adoptPersistedConversations: (ids) => {
      for (const convId of ids) persistedRunsConvs.add(convId)
    },
    reprojectOnConversationTreeChange,
    reprojectOnConversationDeleted,
  }
}
