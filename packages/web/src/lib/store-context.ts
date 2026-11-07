import { createContext, useContext, useEffect } from 'react'
import type { HelmStoreValue } from './types.js'

export const HelmStoreContext = createContext<HelmStoreValue | null>(null)

export function useHelmStore(): HelmStoreValue {
  const ctx = useContext(HelmStoreContext)
  if (ctx === null) {
    throw new Error('useHelmStore 必须在 <HelmStoreProvider> 内调用')
  }
  return ctx
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
