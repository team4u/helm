/**
 * builtin:workflow 插件数据 hooks（与宿主共享同一 store，零私有依赖）。
 * models.ts 只保留纯函数；hook 依赖集中在本文件，供 index.tsx 组件消费。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRunSummary } from '@helm/protocol'
import { useConversation, useConversations, usePluginContext, usePluginDoc, usePluginSessionDoc } from '@helm/plugin-client'
import { isScrolledToBottom } from './model-format.ts'
import { parseSavedWorkflowList } from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'

/** 只在用户仍贴底时跟随流式输出；上滚阅读历史后不抢回滚动位置。 */
export function useStreamFollow(content: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const onScroll = useCallback(() => {
    if (ref.current !== null) follow.current = isScrolledToBottom(ref.current)
  }, [])
  useEffect(() => {
    if (follow.current && ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight
  }, [content])
  return { ref, onScroll }
}

/** 订阅 builtin:workflow 公开文档 runs（会话分片，仅当前会话的 run 列表）。 */
export function useWorkflowRunsDoc<T = { runs: WorkflowRunSummary[] }>(docName: string, conversationId: number | undefined): T | undefined {
  return usePluginSessionDoc<T>(docName, conversationId !== undefined ? { conversationId } : undefined)
}

/** 运行中秒表：SSR 首帧不启动时钟，仅客户端 useEffect 定时推进（确定性渲染）。 */
export function useElapsedNowMs(active: boolean): number | undefined {
  const [nowMs] = useElapsedState(active)
  return nowMs
}

/** 工作流库加载状态：list 动作 + 代数竞争保护（刷新不串合旧响应）。 */
export interface WorkflowLibraryState {
  items: SavedWorkflowView[] | undefined
  error: string | undefined
  loading: boolean
  reload: () => Promise<void>
}

/** 加载已保存工作流目录（list 动作；严格解析，结构非法显式报错不伪造）。 */
export function useWorkflowLibrary(): WorkflowLibraryState {
  const ctx = usePluginContext()
  const [items, setItems] = useState<SavedWorkflowView[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('list')
      if (generation.current !== current) return
      const parsed = parseSavedWorkflowList(raw)
      if (parsed === undefined) {
        setError('工作流目录返回结构不合法（动作返回非预期形状）')
      } else {
        setItems(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [ctx])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, error, loading, reload }
}

function useElapsedState(active: boolean): [number | undefined, (v: number) => void] {
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    const timer = globalThis.setInterval?.(() => setNowMs(Date.now()), 1000)
    return () => {
      if (timer !== undefined) globalThis.clearInterval?.(timer)
    }
  }, [active])
  return [nowMs, setNowMs]
}

export { useConversation, useConversations, usePluginContext, usePluginDoc, usePluginSessionDoc }
