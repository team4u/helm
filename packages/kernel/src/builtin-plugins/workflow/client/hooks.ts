/**
 * builtin:workflow 插件数据 hooks（与宿主共享同一 store，零私有依赖）。
 * models.ts 只保留纯函数；hook 依赖集中在本文件，供 index.tsx 组件消费。
 */
import { useEffect, useState } from 'react'
import type { WorkflowRunSummary } from '@helm/protocol'
import { useConversation, useConversations, usePluginDoc } from '@helm/plugin-client'

/** 订阅 builtin:workflow 公开文档 runs（WorkflowRunsDocState）。 */
export function useWorkflowRunsDoc<T = { runs: WorkflowRunSummary[] }>(docName: string): T | undefined {
  return usePluginDoc<T>(docName)
}

/** 运行中秒表：SSR 首帧不启动时钟，仅客户端 useEffect 定时推进（确定性渲染）。 */
export function useElapsedNowMs(active: boolean): number | undefined {
  const [nowMs] = useElapsedState(active)
  return nowMs
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

export { useConversation, useConversations, usePluginDoc }
