/**
 * builtin:workflow run 投影与会话分片文档（自 workflow.ts 入口拆出）。
 *
 * 职责：
 * - 内存增量维护 `Map<string, WorkflowRunSummary>`：start / 显式动作通过
 *   sync/syncFinal 从持久层水合；运行期高频进度与结算走 upsertRun(summary)
 *   O(1) 内存单条更新并重投影，零磁盘读取；
 * - 公共 `runs` 投影按会话分片（ctx.sessionDoc，每会话分片含自身及后代
 *   发起的 run——沿真实会话父链防环/缺父，run.conversationId 保持原始归属）：
 *   单会话分片按 MAX_PROJECTED_RUNS_PER_CONVERSATION（100）滑窗截断（始终
 *   保留全部 running，剩余槽位按 createdAt 倒序取最新终态），并剥离原始
 *   result 仅保留 hasResult + resultPreview（完整 result 经 inspect 按需读取）；
 * - 全局仅保留紧凑 `run-badges` 角标文档（基于全量会话聚合计算准确 count/
 *   tone/footerText，按 run.id 去重，不受 100 条分片滑窗截断影响）；
 * - 值缓存幂等写入（值相等跳过，无写放大）；受控 stop 时序：stopping 标记
 *   拦截运行期后台回调，最终同步走 syncFinal（不受拦截，失败如实上抛）。
 */
import type { PluginDocHandle, PluginSessionDocHandle } from '@helm/protocol'
import {
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
  type WorkflowRunSummary,
} from '../contracts.js'

/** 单会话 runs 分片滑窗上限：始终保留全部 running，剩余槽位填充最新终态。 */
export const MAX_PROJECTED_RUNS_PER_CONVERSATION = 100

const RESULT_PREVIEW_MAX_CHARS = 200

/** runs 分片 + 角标投影（含内存增量更新、滑窗瘦身、stopping 门与树指纹缓存）。 */
export interface RunsProjection {
  /** 全量重读持久层并刷新投影（start / 显式控制动作入口；stopping 后为 no-op）。 */
  sync(): void
  /** 运行期单条 run O(1) 内存增量更新并重投影（零磁盘 I/O；stopping 后为 no-op）。 */
  upsertRun(run: WorkflowRunSummary): void
  /** 受控 stop 末尾的最终全量投影：禁止被 stopping 拦截；读写失败如实上抛（不吞）。 */
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

function truncateSingleLine(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function formatResultPreview(result: unknown): string {
  if (typeof result === 'string') {
    const firstLine = result.trim().split(/\r?\n/, 1)[0]!.trim()
    return truncateSingleLine(firstLine, RESULT_PREVIEW_MAX_CHARS)
  }
  const serialized = JSON.stringify(result) ?? String(result)
  return truncateSingleLine(serialized, RESULT_PREVIEW_MAX_CHARS)
}

function slimProjectedRun(run: WorkflowRunSummary): WorkflowRunSummary {
  const { result, ...rest } = run
  const hasResult = result !== undefined
  return {
    ...rest,
    hasResult,
    ...(hasResult ? { resultPreview: formatResultPreview(result) } : {}),
  }
}

function selectProjectedRuns(convRuns: WorkflowRunSummary[]): WorkflowRunSummary[] {
  if (convRuns.length <= MAX_PROJECTED_RUNS_PER_CONVERSATION) return convRuns
  const running = convRuns.filter((r) => r.status === 'running')
  if (running.length >= MAX_PROJECTED_RUNS_PER_CONVERSATION) {
    return running.slice(0, MAX_PROJECTED_RUNS_PER_CONVERSATION)
  }
  const remaining = MAX_PROJECTED_RUNS_PER_CONVERSATION - running.length
  const terminals = convRuns.filter((r) => r.status !== 'running').slice(0, remaining)
  return [...running, ...terminals].sort((a, b) => b.createdAt - a.createdAt)
}

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

  let stopping = false
  let hydrated = false
  const runsById = new Map<string, WorkflowRunSummary>()

  const writtenRunsByConv = new Map<number, string>()
  let writtenBadgesJson = ''
  const persistedRunsConvs = new Set<number>()
  let conversationTreeFingerprint = ''

  function hydrateFromListRuns(): void {
    const listed = deps.listRuns()
    runsById.clear()
    for (const run of listed) runsById.set(run.id, run)
    hydrated = true
  }

  function projectFromMemory(): void {
    const runs = [...runsById.values()].sort((a, b) => b.createdAt - a.createdAt)
    const existing = new Map<number, { parentConversationId?: number }>()
    for (const conversation of deps.listConversations()) {
      existing.set(conversation.id, conversation)
    }

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
        writtenRunsByConv.delete(convId)
        continue
      }
      if (!runsByConversation.has(convId)) runsByConversation.set(convId, [])
    }

    for (const [convId, convRuns] of runsByConversation) {
      const projectedRuns = selectProjectedRuns(convRuns).map(slimProjectedRun)
      const key = runsProjectionKey(projectedRuns)
      if (writtenRunsByConv.get(convId) === key) continue
      runsDoc.set(convId, { runs: projectedRuns })
      writtenRunsByConv.set(convId, key)
      persistedRunsConvs.add(convId)
    }

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

  function sync(): void {
    if (stopping) return
    hydrateFromListRuns()
    projectFromMemory()
  }

  function upsertRun(run: WorkflowRunSummary): void {
    if (stopping) return
    if (!hydrated) hydrateFromListRuns()
    runsById.set(run.id, run)
    projectFromMemory()
  }

  function syncFinal(): void {
    hydrateFromListRuns()
    projectFromMemory()
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
      if (!hydrated) hydrateFromListRuns()
      projectFromMemory()
      conversationTreeFingerprint = fingerprint
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话树变化后的 runs 投影失败: ${message}\n`)
    }
  }

  function reprojectOnConversationDeleted(): void {
    if (stopping) return
    try {
      if (!hydrated) hydrateFromListRuns()
      projectFromMemory()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`builtin:workflow: 会话删除后的 runs 投影失败: ${message}\n`)
    }
  }

  return {
    sync,
    upsertRun,
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
