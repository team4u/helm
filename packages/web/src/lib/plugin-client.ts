/**
 * 插件 client.tsx 模块加载器（纯逻辑，无组件导出）：
 * - Bearer fetch 拉取编译产物（token 绝不进 URL）→ Blob URL 动态 import → 释放 URL；
 * - 按 (pluginId, module, contentHash) 缓存模块命名空间（含已解析 resolved 快路径）；
 *   插件停用/卸载（uiContributions 移除）时失效缓存并回收其注入样式；
 * - 编译产物只携带样式文本（保留导出 __helmClientCss，绝不写 DOM）；模块解析成功且
 *   epoch / 插件 epoch / 缓存 entry 身份仍有效后，由本加载器统一注入或回收每个入口的
 *   单个 <style data-helm-plugin-css>，resolved 缓存发布发生在样式装载之后；
 * - 导出不存在 / HTTP 错误 / import 抛错 / 保留导出类型非法均显式报错，绝不静默空白。
 */
import type { ComponentType } from 'react'
import { PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol'
import { getStoredToken } from './api.js'

export interface LoadedClientModule {
  module: Record<string, unknown>
  contentHash: string
}

interface CacheEntry {
  pluginId: string
  contentHash: string
  namespaced: Promise<Record<string, unknown>>
  /** 动态 import 完成后写入的已解析模块命名空间（同步快路径与 SSR 测试用）。 */
  resolved?: Record<string, unknown>
}

const cache = new Map<string, CacheEntry>()
const pluginEpochs = new Map<string, number>()
let cacheEpoch = 0
/** 缓存失效监听器（evict/reset 清理完成后通知；正常 load/seed 不通知，避免循环）。 */
const invalidationListeners = new Set<() => void>()

/**
 * 订阅插件 client 缓存失效（evict/reset 清理完成后触发）。
 * 供仍挂载的组件经 useSyncExternalStore 感知缓存被整体回收后需重新加载，返回退订函数。
 */
export function subscribePluginClientCacheInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

/**
 * 取某插件缓存身份的稳定 revision 原始值（全局 cacheEpoch 与该插件 epoch 组合）：
 * 仅在 evict/reset 失效时变化，供 useSyncExternalStore 的 getSnapshot 判定缓存代际。
 */
export function getPluginClientCacheRevision(pluginId: string): string {
  return `${cacheEpoch}:${pluginEpochs.get(pluginId) ?? 0}`
}

function notifyCacheInvalidated(): void {
  for (const listener of [...invalidationListeners]) listener()
}

const cacheKey = (pluginId: string, moduleRef: string): string => JSON.stringify([pluginId, moduleRef])

/** 移除某插件注入的样式表（停用/卸载后不留全局样式泄漏）。 */
function removePluginStyleSheets(pluginId: string | undefined): void {
  if (typeof document === 'undefined') return
  for (const node of [...document.querySelectorAll('style[data-helm-plugin-css-plugin]')]) {
    if (pluginId === undefined || node.getAttribute('data-helm-plugin-css-plugin') === pluginId) node.remove()
  }
}

/** 每个插件模块入口在页面上至多一个 style 节点的定位键（与协议保留导出配套）。 */
const pluginStyleKey = (pluginId: string, moduleRef: string): string => `${pluginId}::${moduleRef}`

function findPluginStyleNode(key: string): HTMLStyleElement | null {
  for (const node of document.querySelectorAll<HTMLStyleElement>('style[data-helm-plugin-css]')) {
    if (node.getAttribute('data-helm-plugin-css') === key) return node
  }
  return null
}

/**
 * 装载（或按新 hash 原位更新）某入口的插件样式，是唯一的样式挂载点：
 * - 保留导出缺失或为空串：移除该入口旧样式（新版无样式不得残留旧样式）；
 * - 保留导出存在但非 string：显式契约错误，绝不静默忽略；
 * - 同入口同 hash 复用现有节点（不重复标签、不闪烁），新 hash 原位替换文本，不累积；
 * - SSR（无 document）合法跳过注入。
 */
function applyPluginClientCss(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  moduleNamespace: Record<string, unknown>,
): void {
  const css = Object.hasOwn(moduleNamespace, PLUGIN_CLIENT_CSS_EXPORT)
    ? moduleNamespace[PLUGIN_CLIENT_CSS_EXPORT]
    : ''
  if (typeof css !== 'string') {
    throw new PluginClientError(
      'client_module_css_invalid',
      `插件 ${pluginId} 模块 ${moduleRef} 的保留导出 ${PLUGIN_CLIENT_CSS_EXPORT} 必须为 string（实际为 ${typeof css}），已拒绝装载其样式`,
      0,
    )
  }
  if (typeof document === 'undefined') return
  const key = pluginStyleKey(pluginId, moduleRef)
  const existing = findPluginStyleNode(key)
  if (css === '') {
    existing?.remove()
    return
  }
  if (existing === null) {
    const style = document.createElement('style')
    style.setAttribute('data-helm-plugin-css', key)
    style.setAttribute('data-helm-plugin-css-plugin', pluginId)
    style.setAttribute('data-helm-plugin-css-hash', contentHash)
    style.textContent = css
    document.head.appendChild(style)
    return
  }
  if (existing.getAttribute('data-helm-plugin-css-hash') === contentHash && existing.textContent === css) return
  existing.setAttribute('data-helm-plugin-css-hash', contentHash)
  existing.textContent = css
}

/** 插件 UI 贡献变化时调用：移除该插件全部缓存模块（停用/卸载后不残留）。 */
export function evictPluginClientCache(pluginId: string): void {
  pluginEpochs.set(pluginId, (pluginEpochs.get(pluginId) ?? 0) + 1)
  for (const [key, entry] of cache) {
    if (entry.pluginId === pluginId) cache.delete(key)
  }
  removePluginStyleSheets(pluginId)
  notifyCacheInvalidated()
}

/** 全量重建（如登出）：清空所有插件 client 模块缓存。 */
export function resetPluginClientCache(): void {
  cacheEpoch++
  pluginEpochs.clear()
  cache.clear()
  removePluginStyleSheets(undefined)
  notifyCacheInvalidated()
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
  const epoch = cacheEpoch
  const pluginEpoch = pluginEpochs.get(pluginId)
  const assertCurrent = () => {
    if (epoch !== cacheEpoch || pluginEpoch !== pluginEpochs.get(pluginId)) {
      throw new PluginClientError('client_module_invalidated', `插件 ${pluginId} 的 client 模块加载已失效，请重新加载`, 0)
    }
  }
  const { code, contentHash } = await fetchModuleText(pluginId, moduleRef)
  assertCurrent()
  const cached = cache.get(key)
  if (cached && cached.contentHash === contentHash) {
    const module = await cached.namespaced
    assertCurrent()
    return { module, contentHash }
  }
  const imported = (async () => {
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
  const entry: CacheEntry = { pluginId, contentHash, namespaced: imported }
  // 样式装载与 resolved 发布都在调用方真正 await 的 namespaced 链上完成：import 迟到完成时
  // 若已失效（epoch / 插件 epoch / entry 身份任一不符）直接显式报错，绝不补挂样式，也绝不
  // 碰新 epoch 已装载的样式；拒绝（import 失败 / 失效 / 样式契约非法）仅回收仍属于自己的
  // entry（身份守卫确保不误删新 epoch 条目），允许同 hash 重试，不残留毒化 Promise。
  entry.namespaced = imported.then(
    (moduleNamespace) => {
      if (epoch !== cacheEpoch || pluginEpoch !== pluginEpochs.get(pluginId) || cache.get(key) !== entry) {
        throw new PluginClientError(
          'client_module_invalidated',
          `插件 ${pluginId} 的 client 模块加载已失效，请重新加载`,
          0,
        )
      }
      applyPluginClientCss(pluginId, moduleRef, contentHash, moduleNamespace)
      // 样式装载成功后才发布同步 resolved 缓存，保证 getCachedClientComponent 命中时样式已在页面上。
      entry.resolved = moduleNamespace
      return moduleNamespace
    },
  ).catch((err: unknown) => {
    if (cache.get(key) === entry) cache.delete(key)
    throw err
  })
  cache.set(key, entry)
  const module = await entry.namespaced
  assertCurrent()
  return { module, contentHash }
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
 * 样式装载契约与动态加载一致：先装载该入口样式（SSR 无 document 合法跳过），
 * 成功后才发布缓存；保留导出类型非法时显式报错且不污染缓存。
 */
export function seedPluginClientModule(
  pluginId: string,
  moduleRef: string,
  moduleNamespace: Record<string, unknown>,
  contentHash = 'seeded',
): void {
  applyPluginClientCss(pluginId, moduleRef, contentHash, moduleNamespace)
  cache.set(cacheKey(pluginId, moduleRef), {
    pluginId,
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
    // 保留 CSS 导出是宿主与编译器之间的样式契约，不属于插件作者可用的组件导出，错误清单中隐藏。
    const available = Object.keys(module).filter((k) => k !== 'default' && k !== '__esModule' && k !== PLUGIN_CLIENT_CSS_EXPORT)
    throw new PluginClientError(
      'client_export_missing',
      `插件 ${pluginId} 模块 ${moduleRef} 不存在导出 ${exportName}${available.length > 0 ? `（可用导出：${available.join(', ')}）` : '（模块无任何导出）'}`,
      0,
    )
  }
  return module[exportName]
}
