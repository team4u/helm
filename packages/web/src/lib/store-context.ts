import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import type { SessionDocKey } from './session-docs.js'
import { getSessionDocState, subscribeSessionDoc } from './session-docs.js'
import type { HelmStoreValue } from './types.js'

export const HelmStoreContext = createContext<HelmStoreValue | null>(null)

export function useHelmStore(): HelmStoreValue {
  const ctx = useContext(HelmStoreContext)
  if (ctx === null) {
    throw new Error('useHelmStore must be called inside <HelmStoreProvider>')
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 会话级插件文档（sessionDoc）批量订阅 hooks（宿主专用）：
// 单值 / 诊断订阅见 @helm/plugin-client 的 usePluginSessionDocValue /
// usePluginSessionDocState（端口驱动，插件与宿主共享同一实现）。
// ref-count 共享专用 SSE 流，仅实际挂载引用才连接；详见 lib/session-docs.ts。
// ---------------------------------------------------------------------------

/**
 * 批量订阅同一插件同一会话的多个会话级文档，返回 `{ [docName]: value }`。
 * 任一文档出错时对应键缺失，并在快照上如实暴露错误（不静默空表）。
 */
export function usePluginSessionDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
  conversationId: number | undefined,
): Record<string, unknown> {
  // 仅依赖稳定的具名函数：store 对象本身随全局 SSE 状态频繁换引用。
  const { subscribeSessionDoc, getSessionDocState } = useHelmStore()
  const namesKey = JSON.stringify(docNames ?? [])
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!pluginId || conversationId === undefined) return () => {}
      const unsubs = (JSON.parse(namesKey) as string[]).map((name) =>
        subscribeSessionDoc({ pluginId, docName: name, conversationId }, listener))
      return () => { for (const off of unsubs) off() }
    },
    [pluginId, namesKey, conversationId, subscribeSessionDoc],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => {
      if (!pluginId || conversationId === undefined) return EMPTY_SESSION_DOCS_MAP
      const names = JSON.parse(namesKey) as string[]
      if (names.length === 0) return EMPTY_SESSION_DOCS_MAP
      const map: Record<string, unknown> = {}
      let error: string | undefined
      for (const name of names) {
        const s = getSessionDocState({ pluginId, docName: name, conversationId })
        // delete 帧 value=initial（reset 语义）照常入表；仅不存在/出错才缺失。
        if (s.error !== undefined) error = s.error
        else if (s.hasValue) map[name] = s.value
      }
      // 快照引用稳定：键集与值与错误都未变化时复用上次对象，避免无限重渲染
      const cached = snapshotCache.get(subscribe)
      if (
        cached !== undefined && cached.pluginId === pluginId && cached.conversationId === conversationId &&
        cached.error === error && cacheSame(cached.map, map)
      ) {
        return cached.result
      }
      snapshotCache.set(subscribe, { pluginId, conversationId, map, error, result: map })
      return map
    },
    () => EMPTY_SESSION_DOCS_MAP,
  )
  return state
}

const EMPTY_SESSION_DOCS_MAP: Record<string, unknown> = {}
interface SessionDocsMapCache { pluginId?: string; conversationId?: number; map: Record<string, unknown>; error?: string; result: Record<string, unknown> }
const snapshotCache = new WeakMap<(listener: () => void) => () => void, SessionDocsMapCache>()

/** 键集（按实际自有键）与对应值逐一相同才认为未变化；不要求覆盖全部 names。 */
function cacheSame(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) return false
  }
  return true
}

/**
 * 批量订阅同一插件的多个公开文档，返回 `{ [docName]: docValue }` 映射表。
 */
export function usePluginDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
): Record<string, unknown> {
  const store = useHelmStore()

  const { authenticated, ensurePluginDoc, pluginDocs } = store
  const namesKey = JSON.stringify(docNames ?? [])
  useEffect(() => {
    if (!pluginId || !authenticated) return
    for (const name of JSON.parse(namesKey) as string[]) {
      if (!Object.hasOwn(pluginDocs, `${pluginId}/${name}`)) void ensurePluginDoc(pluginId, name)
    }
  }, [pluginId, namesKey, authenticated, ensurePluginDoc, pluginDocs])

  if (!pluginId || !docNames || docNames.length === 0) return {}
  const map: Record<string, unknown> = {}
  for (const name of docNames) {
    const key = `${pluginId}/${name}`
    if (key in store.pluginDocs) {
      map[name] = store.pluginDocs[key]
    }
  }
  return map
}

export type { SessionDocKey }
