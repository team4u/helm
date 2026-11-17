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
// Batch conversation-scoped plugin document (sessionDoc) subscription hooks
// (host-only): single-value / diagnostics subscriptions live in
// @helm/plugin-client as usePluginSessionDocValue / usePluginSessionDocState
// (port-driven; plugins and the host share one implementation).
// Ref-counted dedicated SSE streams connect only while mounted refs exist;
// see lib/session-docs.ts.
// ---------------------------------------------------------------------------

/**
 * Batch-subscribe multiple conversation-scoped docs of one plugin in one
 * conversation, returning `{ [docName]: value }`. A failing doc omits its key
 * and surfaces the error honestly on the snapshot (never a silent empty map).
 */
export function usePluginSessionDocsMap(
  pluginId: string | undefined,
  docNames: string[] | undefined,
  conversationId: number | undefined,
): Record<string, unknown> {
  // Depend only on the stable named functions: the store object itself swaps references on every global SSE state change.
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
        // delete frames carry value=initial (reset semantics) and still enter the map; only missing/errored docs are absent.
        if (s.error !== undefined) error = s.error
        else if (s.hasValue) map[name] = s.value
      }
      // Stable snapshot reference: reuse the previous object when keys, values and error are unchanged, preventing infinite re-renders
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

/** Unchanged only when the key set (by own keys) and every value match one by one; covering all names is not required. */
function cacheSame(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const prevKeys = Object.keys(prev)
  if (prevKeys.length !== Object.keys(next).length) return false
  for (const key of prevKeys) {
    if (!Object.hasOwn(next, key) || prev[key] !== next[key]) return false
  }
  return true
}

/**
 * Batch-subscribe multiple public docs of one plugin, returning a `{ [docName]: docValue }` map.
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
