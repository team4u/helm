/**
 * 服务端截断结果全文取回（前端状态机 hook）。
 *
 * 契约：
 * - 仅当 ToolTrace 带服务端截断标记（resultTruncation）时可取回；按
 *   resultEntryId 精确请求 GET /api/conversations/:id/entries/:entryId；
 * - 成功：先做响应形状与 id 一致性校验（边界强校验，非法显式拒绝），
 *   再经 store.backfillConversationEntry 原位回填；上层时间线随 entries
 *   变化自然重建出全文 ToolTrace，本 hook 不另存文本副本（单一事实源）；
 * - 失败：phase=failed 且错误信息可见，绝不以预览冒充全文；
 * - 宿主 store 缺少回填方法（旧测试替身）时显式失败，不静默降级。
 */
import { useCallback, useRef, useState } from 'react'
import { conversationsApi } from '../lib/api.js'
import { useHelmStore } from '../lib/store-context.js'
import type { ToolTrace } from './timeline-model.js'

export type ToolResultFullTextPhase = 'preview' | 'loading' | 'failed' | 'complete'

export interface ToolResultFullTextState {
  phase: ToolResultFullTextPhase
  /** phase === 'failed' 时的错误说明（直呈 UI，不吞）。 */
  error?: string
  /** 触发取回全文；未截断、已在途或已完成时 no-op。 */
  load: () => void
}

/** ConversationEntry 最小形状校验（边界强校验：非法载荷显式拒绝，不猜测）。 */
function isConversationEntryShape(value: unknown): value is { id: string; kind: string } {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v['id'] === 'string' && v['id'] !== '' && typeof v['kind'] === 'string'
}

/** 条目 id 规范化：'042' 与 '42' 指向同一条目（数字字符串去前导零）；
 * 非法或非正整数返回 undefined。 */
function canonicalEntryId(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export function useToolResultFullText(tool: ToolTrace, conversationId: number): ToolResultFullTextState {
  const store = useHelmStore()
  const [phase, setPhase] = useState<ToolResultFullTextPhase>('preview')
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)

  const load = useCallback(() => {
    if (inFlight.current) return
    const truncation = tool.resultTruncation
    if (truncation === undefined) return
    const entryId = tool.resultEntryId
    const backfill = store.backfillConversationEntry
    if (entryId === undefined) {
      setPhase('failed')
      setError('截断标记缺少条目定位（resultEntryId），无法取回全文')
      return
    }
    if (backfill === undefined) {
      setPhase('failed')
      setError('当前宿主不支持条目回填')
      return
    }
    const requestedEntryId = entryId
    inFlight.current = true
    setPhase('loading')
    setError(undefined)
    void conversationsApi
      .getEntry(conversationId, requestedEntryId)
      .then((entry) => {
        // canonical 比较：请求 '042' 与服务端返回 '42' 是同一条目，不误判失败。
        const requested = canonicalEntryId(requestedEntryId)
        const returned = isConversationEntryShape(entry) ? canonicalEntryId(entry.id) : undefined
        if (requested === undefined || returned === undefined || requested !== returned) {
          setPhase('failed')
          setError('服务端返回的条目形状或 id 与请求不一致，已拒绝回填')
          return
        }
        backfill(conversationId, entry)
        setPhase('complete')
      })
      .catch((err: unknown) => {
        setPhase('failed')
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [conversationId, store, tool.resultTruncation, tool.resultEntryId])

  return { phase, ...(error !== undefined ? { error } : {}), load }
}
