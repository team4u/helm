/**
 * 插件 client.tsx 模块加载器（纯逻辑，无组件导出）：
 * - Bearer fetch 拉取编译产物（token 绝不进 URL）→ Blob URL 动态 import → 释放 URL；
 * - 按 (pluginId, module, contentHash) 缓存模块命名空间（含已解析 resolved 快路径）；
 *   插件停用/卸载（uiContributions 移除）时失效缓存；
 * - 导出不存在 / HTTP 错误 / import 抛错均显式报错，绝不静默空白。
 */
import type { ComponentType } from 'react'
import { getStoredToken } from './api.js'

export interface LoadedClientModule {
  module: Record<string, unknown>
  contentHash: string
}

interface CacheEntry {
  contentHash: string
  namespaced: Promise<Record<string, unknown>>
  /** 动态 import 完成后写入的已解析模块命名空间（同步快路径与 SSR 测试用）。 */
  resolved?: Record<string, unknown>
}

const cache = new Map<string, CacheEntry>()

const cacheKey = (pluginId: string, moduleRef: string): string => `${pluginId}::${moduleRef}`

/** 插件 UI 贡献变化时调用：移除该插件全部缓存模块（停用/卸载后不残留）。 */
export function evictPluginClientCache(pluginId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${pluginId}::`)) cache.delete(key)
  }
}

/** 全量重建（如登出）：清空所有插件 client 模块缓存。 */
export function resetPluginClientCache(): void {
  cache.clear()
}

export class PluginClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'PluginClientError'
    this.code = code
    this.status = status
  }
}

async function fetchModuleText(pluginId: string, moduleRef: string): Promise<{ code: string; contentHash: string }> {
  const headers: Record<string, string> = {}
  const token = getStoredToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const url = `/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    throw new PluginClientError(
      'client_module_fetch_failed',
      `加载插件 ${pluginId} client 模块 ${moduleRef} 失败：${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      if (body?.error?.message) message = body.error.message
    } catch {
      /* 非 JSON 错误体：保留 HTTP 状态描述 */
    }
    throw new PluginClientError('client_module_http_error', `插件 ${pluginId} client 模块 ${moduleRef}：${message}`, res.status)
  }
  const contentHash = res.headers.get('x-helm-client-hash') ?? ''
  return { code: await res.text(), contentHash }
}

/**
 * 加载（或复用缓存）插件 client 模块命名空间。
 * contentHash 变化（源已改）时重新拉取；同 hash 并发请求共享同一 Promise。
 */
export async function loadPluginClientModule(pluginId: string, moduleRef: string): Promise<LoadedClientModule> {
  const key = cacheKey(pluginId, moduleRef)
  const { code, contentHash } = await fetchModuleText(pluginId, moduleRef)
  const cached = cache.get(key)
  if (cached && cached.contentHash === contentHash) {
    return { module: await cached.namespaced, contentHash }
  }
  const namespaced = (async () => {
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    try {
      return (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>
    } catch (err) {
      throw new PluginClientError(
        'client_module_import_failed',
        `插件 ${pluginId} client 模块 ${moduleRef} 导入失败：${err instanceof Error ? err.message : String(err)}`,
        0,
      )
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  })()
  const entry: CacheEntry = { contentHash, namespaced }
  // 已解析模块落缓存：后续挂载（含时间线重渲染）经 getCachedClientComponent 同步命中，零闪烁。
  void namespaced.then(
    (mod) => {
      entry.resolved = mod
    },
    () => {
      /* 加载失败保留无 resolved 状态；错误由 loadPluginClientModule 调用方显式展示 */
    },
  )
  cache.set(key, entry)
  return { module: await namespaced, contentHash }
}

/**
 * 同步取已解析缓存模块的具名导出组件：缓存命中且导出为函数时直接返回，
 * 避免 PluginUiView 重复挂载（时间线重渲染 / SSR）时闪烁 loading 态。
 * 未加载完成或导出非函数时返回 undefined（调用方走异步加载轨道）。
 */
export function getCachedClientComponent(
  pluginId: string,
  moduleRef: string,
  exportName: string,
): ComponentType<Record<string, unknown>> | undefined {
  const cached = cache.get(cacheKey(pluginId, moduleRef))
  const mod = cached?.resolved
  if (mod === undefined || typeof mod[exportName] !== 'function') return undefined
  return mod[exportName] as ComponentType<Record<string, unknown>>
}

/**
 * 直接注入已解析的模块命名空间（测试与预加载用）：以 contentHash='seeded'
 * 写入缓存，后续 getCachedClientComponent / loadPluginClientModule 同 hash 复用。
 */
export function seedPluginClientModule(
  pluginId: string,
  moduleRef: string,
  moduleNamespace: Record<string, unknown>,
  contentHash = 'seeded',
): void {
  cache.set(cacheKey(pluginId, moduleRef), {
    contentHash,
    namespaced: Promise.resolve(moduleNamespace),
    resolved: moduleNamespace,
  })
}

/** 取具名导出；不存在时显式报错（含可用导出清单，便于插件作者排查）。 */
export function requireClientExport(
  pluginId: string,
  moduleRef: string,
  exportName: string,
  module: Record<string, unknown>,
): unknown {
  if (!Object.hasOwn(module, exportName)) {
    const available = Object.keys(module).filter((k) => k !== 'default' && k !== '__esModule')
    throw new PluginClientError(
      'client_export_missing',
      `插件 ${pluginId} 模块 ${moduleRef} 不存在导出 ${exportName}${available.length > 0 ? `（可用导出：${available.join(', ')}）` : '（模块无任何导出）'}`,
      0,
    )
  }
  return module[exportName]
}
