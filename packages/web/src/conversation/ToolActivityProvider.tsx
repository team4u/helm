import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ToolActivityContext } from '../lib/tool-activity.js'

/** 每个 assistant 回合独享注册表；token 区分同一 callId 的不同挂载来源。 */
export function ToolActivityProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<ReadonlyMap<symbol, string>>(() => new Map())
  const registerActivity = useCallback((callId: string) => {
    const token = Symbol(callId)
    setSources((previous) => new Map(previous).set(token, callId))
    return () => {
      setSources((previous) => {
        if (!previous.has(token)) return previous
        const next = new Map(previous)
        next.delete(token)
        return next
      })
    }
  }, [])
  const value = useMemo(() => ({ activeToolCallIds: new Set(sources.values()), registerActivity }), [sources, registerActivity])
  return <ToolActivityContext.Provider value={value}>{children}</ToolActivityContext.Provider>
}
