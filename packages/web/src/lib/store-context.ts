import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SessionDocKey } from './session-docs.js'
import { getSessionDocState, subscribeSessionDoc } from './session-docs.js'
import type { HelmStoreValue } from './types.js'

export const HelmStoreContext = createContext<HelmStoreValue | null>(null)

export function useHelmStore(): HelmStoreValue {
  const ctx = useContext(HelmStoreContext)
  if (ctx === null) {
    throw new Error('useHelmStore 必须在 <HelmStoreProvider> 内调用')
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 会话级插件文档（sessionDoc）订阅 hook：ref-count 共享专用 SSE 流，
// 仅实际挂载引用才连接；详见 lib/session-docs.ts。
// ---------------------------------------------------------------------------

/** useSyncExternalStore 快照形状（与 lib/session-docs.ts getSessionDocState 一致）。 */
interface SessionDocSnapshotRef {
  value?: unknown
  hasValue: boolean
  deleted: boolean
  error?: string
  connected: boolean
}

const EMPTY_SESSION_DOC: SessionDocSnapshotRef = { hasValue: false, deleted: false, connected: false }

/**
 * 响应式订阅会话级公开文档：(pluginId, docName, conversationId) 元组仅在
 * 有挂载订阅者时才开专用 SSE 流；返回当前值（未收到/已删除/出错时 undefined，
 * 错误经 diagnostics 可见）。conversationId 为 undefined 时返回 undefined 且不开流。
 */
export function usePluginSessionDoc<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const store = useHelmStore()
  const pluginId = options?.pluginId
  const conversationId = options?.conversationId
  const enabled = pluginId !== undefined && conversationId !== undefined && docName !== ''
  const key = useMemo<SessionDocKey | null>(
    () => (enabled ? { pluginId: pluginId!, docName, conversationId: conversationId! } : null),
    [enabled, pluginId, docName, conversationId],
  )
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : store.subscribeSessionDoc(key, listener)),
    [store, key],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY_SESSION_DOC : store.getSessionDocState(key)),
    () => EMPTY_SESSION_DOC,
  )
  if (state.deleted || !state.hasValue || state.error !== undefined) return undefined
  return state.value as T | undefined
}

/** 订阅诊断态（错误/连接状态/删除标记）：供宿主或高级组件显式展示，不静默降级。 */
export function usePluginSessionDocDiagnostics(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): SessionDocSnapshotRef {
  const store = useHelmStore()
  const pluginId = options?.pluginId
  const conversationId = options?.conversationId
  const key = useMemo<SessionDocKey | null>(
    () => (pluginId !== undefined && conversationId !== undefined && docName !== '' ? { pluginId, docName, conversationId } : null),
    [pluginId, docName, conversationId],
  )
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : store.subscribeSessionDoc(key, listener)),
    [store, key],
  )
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY_SESSION_DOC : store.getSessionDocState(key)),
    () => EMPTY_SESSION_DOC,
  )
}

/**
 * 批量订阅同一插件同一会话的多个会话级文档，返回 `{ [docName]: value }`，
 * 供 HelmSpecView 注入 `$sessionDocs` 求值上下文（声明式 sessionDocs 双轨集成）。
 */
export function usePluginSessionDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
  conversationId: number | undefined,
): Record<string, unknown> {
  const store = useHelmStore()
  const namesKey = JSON.stringify(docNames ?? [])
  const { subscribeSessionDoc: subscribeTuple, getSessionDocState: readState } = store
  // 逐文档订阅（每个元组独立 ref-count；任一更新触发本组件重渲染）
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!pluginId || conversationId === undefined) return () => {}
      const unsubs = (JSON.parse(namesKey) as string[]).map((name) =>
        subscribeTuple({ pluginId, docName: name, conversationId }, listener))
      return () => { for (const off of unsubs) off() }
    },
    [pluginId, namesKey, conversationId, subscribeTuple],
  )
  const state = useSyncExternalStore(
    subscribe,
    () => {
      if (!pluginId || conversationId === undefined) return EMPTY_SESSION_DOCS_MAP
      const names = JSON.parse(namesKey) as string[]
      if (names.length === 0) return EMPTY_SESSION_DOCS_MAP
      const map: Record<string, unknown> = {}
      let hasPartial = false
      for (const name of names) {
        const s = readState({ pluginId, docName: name, conversationId })
        if (!s.deleted && s.hasValue && s.error === undefined) map[name] = s.value
        else hasPartial = true
      }
      // 快照引用稳定：键集与值未变化时复用上次对象，避免无限重渲染
      const cached = snapshotCache.get(subscribe)
      if (cached !== undefined && cached.pluginId === pluginId && cached.conversationId === conversationId && cacheSame(cached.map, map, names)) {
        return cached.result
      }
      snapshotCache.set(subscribe, { pluginId, conversationId, map, result: map })
      return map
    },
    () => EMPTY_SESSION_DOCS_MAP,
  )
  return state
}

const EMPTY_SESSION_DOCS_MAP: Record<string, unknown> = {}
const snapshotCache = new WeakMap<(listener: () => void) => () => void, { pluginId?: string; conversationId?: number; map: Record<string, unknown>; result: Record<string, unknown> }>()

function cacheSame(prev: Record<string, unknown>, next: Record<string, unknown>, names: string[]): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const name of names) {
    if (!Object.hasOwn(prev, name) || prev[name] !== next[name]) return false
  }
  return true
}

/**
 * 订阅指定插件的公开文档（public doc），首次自动触发 GET /api/plugins/:id/docs/:name，
 * 随后随 SSE `plugin.doc.updated` 实时自动重渲染。
 */
export function usePluginDoc<T = unknown>(pluginId: string, docName: string): T | undefined {
  const store = useHelmStore()
  const key = `${pluginId}/${docName}`
  const value = store.pluginDocs[key] as T | undefined

  const { ensurePluginDoc, authenticated } = store
  useEffect(() => {
    if (value === undefined && authenticated) void ensurePluginDoc(pluginId, docName)
  }, [pluginId, docName, value, authenticated, ensurePluginDoc])

  return value
}

/**
 * 批量订阅同一插件的多个公开文档，返回 `{ [docName]: docValue }` 映射表，
 * 供 `<HelmSpecView />` 直接注入 `$docs` 求值上下文。
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
