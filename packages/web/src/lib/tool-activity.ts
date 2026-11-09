import { createContext, useContext, useEffect } from 'react'

export interface ToolActivityRegistry {
  activeToolCallIds: ReadonlySet<string>
  /** 每个挂载来源获得独立登记；返回值只释放本次来源，不清除同 callId 的其他来源。 */
  registerActivity(callId: string): () => void
}

export const ToolActivityContext = createContext<ToolActivityRegistry | undefined>(undefined)

/**
 * 向所在时间线回合报告工具的真实后台活动，控制该回合的复制/分叉展示。
 * callId 缺失或不在时间线 Provider 内时不登记，也不创建全局状态。
 * 状态变化、callId 变化和组件卸载时自动释放本来源；工作台中的组件不影响时间线。
 */
export function useToolActivity(callId: string | undefined, active: boolean): void {
  const register = useContext(ToolActivityContext)?.registerActivity
  useEffect(() => {
    if (register === undefined || callId === undefined || callId === '' || !active) return
    return register(callId)
  }, [register, callId, active])
}
