/**
 * 插件 client.tsx 模块加载器（纯逻辑，无组件导出）：
 * - Bearer fetch 拉取编译产物（token 绝不进 URL）→ Blob URL 动态 import → 释放 URL；
 *   浏览器 Blob import 失败即真实错误（client_module_import_failed），绝不回退
 *   data URL 掩盖；Node/无 Blob 环境用 data URL（测试与 SSR 唯一可行路径）；
 * - 按 (pluginId, module, contentHash) 缓存模块命名空间（含已解析 resolved 快路径）；
 *   插件停用/卸载（uiContributions 移除）时失效缓存并回收其注入样式；
 * - 共享 Chunk 桥（__helmx_import_chunk）：preload fetch 全并发去重（同一 chunk 零重复
 *   网络请求）、模块求值按拓扑顺序 await；epoch 守卫确保 evict/reset 后迟到的 chunk
 *   不得回写 __helmx_chunk_share（显式 client_module_invalidated，绝不静默）；
 *   __helmx_chunk_share 条目按 pluginId + moduleRef + contentHash + chunk 隔离，
 *   两插件同源同 hash 时停用一个不会删掉另一个的共享表；
 * - 编译产物只携带样式文本（保留导出 __helmxClientCss，绝不写 DOM）；模块解析成功且
 *   epoch / 插件 epoch / 缓存 entry 身份仍有效后，由本加载器统一注入或回收每个入口的
 *   单个 <style data-helmx-plugin-css>，resolved 缓存发布发生在样式装载之后；
 * - 导出不存在 / HTTP 错误 / import 抛错 / 保留导出类型非法均显式报错，绝不静默空白。
 */
import type { ComponentType } from 'react'
import { PLUGIN_CLIENT_CSS_EXPORT, type PluginSummary } from '@helmx/protocol/browser'
import { getStoredToken } from './api.js'

export interface LoadedClientModule {
  module: Record<string, unknown>
  contentHash: string
}

interface CacheEntry {
  pluginId: string
  moduleRef: string
  contentHash: string
  namespaced: Promise<Record<string, unknown>>
  /** 动态 import 完成后写入的已解析模块命名空间（同步快路径与 SSR 测试用）。 */
  resolved?: Record<string, unknown>
}

interface InflightLoad {
  pluginId: string
  moduleRef: string
  expectedHash: string | undefined
  moduleEpoch: number
  promise: Promise<LoadedClientModule>
}

interface FailedModuleEntry {
  pluginId: string
  moduleRef: string
  contentHash: string | undefined
}

const cache = new Map<string, CacheEntry>()
const inflightLoads = new Map<string, InflightLoad>()
const failedModules = new Map<string, FailedModuleEntry>()
const pluginEpochs = new Map<string, number>()
const moduleEpochs = new Map<string, number>()
let cacheEpoch = 0
/** 缓存失效监听器（evict/reset 清理完成后通知；正常 load/seed 不通知，避免循环）。 */
const invalidationListeners = new Set<() => void>()

const chunkPromiseCache = new Map<string, Promise<Record<string, unknown>>>()
/** chunk 文本 fetch 去重：同 key 在途 fetch 共享同一 Promise（preload 并发不重复请求）。 */
const chunkTextFetchCache = new Map<string, Promise<string>>()
const pluginLoadedHashes = new Map<string, Set<string>>()

/** 当前插件有效的缓存代（pluginEpoch + cacheEpoch）：失效后迟到 chunk 不得回写共享表。 */
function pluginCacheGeneration(pluginId: string): string {
  return `${cacheEpoch}:${pluginEpochs.get(pluginId) ?? 0}`
}

function trackPluginHash(pluginId: string, hash: string): void {
  let set = pluginLoadedHashes.get(pluginId)
  if (!set) {
    set = new Set()
    pluginLoadedHashes.set(pluginId, set)
  }
  set.add(hash)
}

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
  for (const node of [...document.querySelectorAll('style[data-helmx-plugin-css-plugin]')]) {
    if (pluginId === undefined || node.getAttribute('data-helmx-plugin-css-plugin') === pluginId) node.remove()
  }
}

/** 每个插件模块入口在页面上至多一个 style 节点的定位键（与协议保留导出配套）。 */
const pluginStyleKey = (pluginId: string, moduleRef: string): string => `${pluginId}::${moduleRef}`

function findPluginStyleNode(key: string): HTMLStyleElement | null {
  for (const node of document.querySelectorAll<HTMLStyleElement>('style[data-helmx-plugin-css]')) {
    if (node.getAttribute('data-helmx-plugin-css') === key) return node
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
      `Plugin ${pluginId} reserved export ${PLUGIN_CLIENT_CSS_EXPORT} of module ${moduleRef} must be a string (got ${typeof css}); refusing to load its styles`,
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
    style.setAttribute('data-helmx-plugin-css', key)
    style.setAttribute('data-helmx-plugin-css-plugin', pluginId)
    style.setAttribute('data-helmx-plugin-css-hash', contentHash)
    style.textContent = css
    document.head.appendChild(style)
    return
  }
  if (existing.getAttribute('data-helmx-plugin-css-hash') === contentHash && existing.textContent === css) return
  existing.setAttribute('data-helmx-plugin-css-hash', contentHash)
  existing.textContent = css
}

const isPluginSummaryActive = (plugin: PluginSummary): boolean =>
  plugin.enabled && (plugin.status === undefined || plugin.status === 'active')

function deleteChunksByPrefix(prefix: string): void {
  for (const k of [...chunkPromiseCache.keys()]) {
    if (k.startsWith(prefix)) chunkPromiseCache.delete(k)
  }
  for (const k of [...chunkTextFetchCache.keys()]) {
    if (k.startsWith(prefix)) chunkTextFetchCache.delete(k)
  }
  const share = (globalThis as Record<string, unknown>).__helmx_chunk_share as Record<string, unknown> | undefined
  if (share) {
    for (const k of Object.keys(share)) {
      if (k.startsWith(prefix)) delete share[k]
    }
  }
}

function evictModuleArtifacts(pluginId: string, moduleRef: string): void {
  const key = cacheKey(pluginId, moduleRef)
  cache.delete(key)
  if (inflightLoads.delete(key)) {
    moduleEpochs.set(key, (moduleEpochs.get(key) ?? 0) + 1)
  }
  failedModules.delete(key)
  deleteChunksByPrefix(`${pluginId}\0${moduleRef}\0`)
  if (typeof document !== 'undefined') {
    findPluginStyleNode(pluginStyleKey(pluginId, moduleRef))?.remove()
  }
}

/** 插件 UI 贡献变化时调用：移除该插件全部缓存模块（停用/卸载后不残留）。 */
export function evictPluginClientCache(pluginId: string): void {
  pluginEpochs.set(pluginId, (pluginEpochs.get(pluginId) ?? 0) + 1)
  for (const [key, entry] of [...cache.entries()]) {
    if (entry.pluginId === pluginId) {
      cache.delete(key)
      moduleEpochs.set(key, (moduleEpochs.get(key) ?? 0) + 1)
    }
  }
  for (const [key, inflight] of [...inflightLoads.entries()]) {
    if (inflight.pluginId === pluginId) {
      inflightLoads.delete(key)
      moduleEpochs.set(key, (moduleEpochs.get(key) ?? 0) + 1)
    }
  }
  for (const [key, failed] of [...failedModules.entries()]) {
    if (failed.pluginId === pluginId) {
      failedModules.delete(key)
    }
  }
  for (const key of [...chunkPromiseCache.keys()]) {
    if (key.startsWith(`${pluginId}\0`)) {
      chunkPromiseCache.delete(key)
    }
  }
  for (const key of [...chunkTextFetchCache.keys()]) {
    if (key.startsWith(`${pluginId}\0`)) {
      chunkTextFetchCache.delete(key)
    }
  }
  // 共享表按 pluginId + moduleRef + contentHash + chunk 隔离清理：只删属于本插件的条目，
  // 另一插件同源同 hash 的共享条目不受影响（key = pluginId\0moduleRef\0hash\0chunk）。
  const hashes = pluginLoadedHashes.get(pluginId)
  if (hashes && (globalThis as Record<string, unknown>).__helmx_chunk_share) {
    const share = (globalThis as Record<string, unknown>).__helmx_chunk_share as Record<string, unknown>
    const prefix = `${pluginId}\0`
    for (const k of Object.keys(share)) {
      if (k.startsWith(prefix) && hashes.has(k.split('\0')[2] ?? '')) {
        delete share[k]
      }
    }
  }
  pluginLoadedHashes.delete(pluginId)
  removePluginStyleSheets(pluginId)
  notifyCacheInvalidated()
}

/**
 * 增量对账插件客户端缓存（如 SSE snapshot 重建）：
 * - 保留仍在 nextPlugins 中启用且 clientHashes[moduleRef] === contentHash 的内存缓存与样式；
 * - 逐出停用、移除、缺失 moduleRef 或 hash 变更的缓存/在途/错误模块及样式；
 * - 仅在实际逐出至少一个模块时递增对应插件 revision 并通知订阅方；返回逐出模块计数。
 */
export function reconcilePluginClientCache(nextPlugins: readonly PluginSummary[]): number {
  const nextById = new Map(nextPlugins.map((plugin) => [plugin.id, plugin]))
  const isModuleValid = (pluginId: string, moduleRef: string, hash: string | undefined): boolean => {
    const plugin = nextById.get(pluginId)
    if (plugin === undefined || !isPluginSummaryActive(plugin)) return false
    const expectedHash = plugin.clientHashes?.[moduleRef]
    if (expectedHash === undefined || expectedHash === '') return false
    return hash === expectedHash
  }

  const evictedKeys = new Set<string>()
  const evictedPlugins = new Set<string>()

  for (const [key, entry] of [...cache.entries()]) {
    if (!isModuleValid(entry.pluginId, entry.moduleRef, entry.contentHash)) {
      cache.delete(key)
      deleteChunksByPrefix(`${entry.pluginId}\0${entry.moduleRef}\0${entry.contentHash}\0`)
      if (typeof document !== 'undefined') {
        findPluginStyleNode(pluginStyleKey(entry.pluginId, entry.moduleRef))?.remove()
      }
      evictedKeys.add(key)
      evictedPlugins.add(entry.pluginId)
    }
  }

  for (const [key, inflight] of [...inflightLoads.entries()]) {
    if (!isModuleValid(inflight.pluginId, inflight.moduleRef, inflight.expectedHash)) {
      inflightLoads.delete(key)
      moduleEpochs.set(key, (moduleEpochs.get(key) ?? 0) + 1)
      evictedKeys.add(key)
      evictedPlugins.add(inflight.pluginId)
    }
  }

  for (const [key, failed] of [...failedModules.entries()]) {
    if (!isModuleValid(failed.pluginId, failed.moduleRef, failed.contentHash)) {
      failedModules.delete(key)
      evictedKeys.add(key)
      evictedPlugins.add(failed.pluginId)
    }
  }

  if (typeof document !== 'undefined') {
    for (const node of [...document.querySelectorAll('style[data-helmx-plugin-css-plugin]')]) {
      const pluginId = node.getAttribute('data-helmx-plugin-css-plugin') ?? ''
      const styleAttr = node.getAttribute('data-helmx-plugin-css') ?? ''
      const prefix = `${pluginId}::`
      const moduleRef = styleAttr.startsWith(prefix) ? styleAttr.slice(prefix.length) : undefined
      const styleHash = node.getAttribute('data-helmx-plugin-css-hash') ?? undefined
      const valid =
        moduleRef !== undefined
          ? isModuleValid(pluginId, moduleRef, styleHash)
          : (() => {
              const plugin = nextById.get(pluginId)
              return plugin !== undefined && isPluginSummaryActive(plugin)
            })()
      if (!valid) {
        node.remove()
        evictedKeys.add(moduleRef !== undefined ? cacheKey(pluginId, moduleRef) : styleAttr || pluginId)
        evictedPlugins.add(pluginId)
      }
    }
  }

  const cleanChunkMap = (map: Map<string, unknown>): void => {
    for (const k of [...map.keys()]) {
      const parts = k.split('\0')
      const pluginId = parts[0] ?? ''
      const moduleRef = parts[1] ?? ''
      const hash = parts[2] ?? ''
      if (!isModuleValid(pluginId, moduleRef, hash)) {
        map.delete(k)
      }
    }
  }
  cleanChunkMap(chunkPromiseCache)
  cleanChunkMap(chunkTextFetchCache)
  const share = (globalThis as Record<string, unknown>).__helmx_chunk_share as Record<string, unknown> | undefined
  if (share) {
    for (const k of Object.keys(share)) {
      const parts = k.split('\0')
      const pluginId = parts[0] ?? ''
      const moduleRef = parts[1] ?? ''
      const hash = parts[2] ?? ''
      if (!isModuleValid(pluginId, moduleRef, hash)) {
        delete share[k]
      }
    }
  }
  for (const [pluginId, hashes] of [...pluginLoadedHashes.entries()]) {
    const plugin = nextById.get(pluginId)
    if (plugin === undefined || !isPluginSummaryActive(plugin)) {
      pluginLoadedHashes.delete(pluginId)
      continue
    }
    const validHashes = new Set(Object.values(plugin.clientHashes ?? {}))
    for (const hash of [...hashes]) {
      if (!validHashes.has(hash)) hashes.delete(hash)
    }
    if (hashes.size === 0) pluginLoadedHashes.delete(pluginId)
  }

  for (const pluginId of evictedPlugins) {
    pluginEpochs.set(pluginId, (pluginEpochs.get(pluginId) ?? 0) + 1)
  }
  if (evictedKeys.size > 0) {
    notifyCacheInvalidated()
  }
  return evictedKeys.size
}

/** 全量重建（如登出）：清空所有插件 client 模块缓存。 */
export function resetPluginClientCache(): void {
  cacheEpoch++
  pluginEpochs.clear()
  moduleEpochs.clear()
  cache.clear()
  inflightLoads.clear()
  failedModules.clear()
  chunkPromiseCache.clear()
  chunkTextFetchCache.clear()
  pluginLoadedHashes.clear()
  if ((globalThis as Record<string, unknown>).__helmx_chunk_share) {
    const share = (globalThis as Record<string, unknown>).__helmx_chunk_share as Record<string, unknown>
    for (const k of Object.keys(share)) {
      delete share[k]
    }
  }
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

/**
 * 模块代码求值：浏览器环境 Blob URL 动态 import（失败即真实错误，绝不回退 data URL
 * 掩盖）；Node/无 Blob 环境用 data URL（测试与 SSR 唯一可行路径）。
 */
async function evaluateModuleCode(code: string): Promise<Record<string, unknown>> {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') {
    const b64 = typeof Buffer !== 'undefined'
      ? Buffer.from(code, 'utf8').toString('base64')
      : btoa(unescape(encodeURIComponent(code)))
    const dataUrl = `data:text/javascript;base64,${b64}`
    return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>
  }
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>
  } catch (err: unknown) {
    const errCode = (err as { code?: string })?.code
    const message = err instanceof Error ? err.message : String(err)
    if (
      errCode === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' ||
      message.includes('ERR_UNSUPPORTED_ESM_URL_SCHEME') ||
      message.includes("protocol 'blob:'")
    ) {
      const b64 = typeof Buffer !== 'undefined'
        ? Buffer.from(code, 'utf8').toString('base64')
        : btoa(unescape(encodeURIComponent(code)))
      const dataUrl = `data:text/javascript;base64,${b64}`
      return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>
    }
    throw err
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

async function fetchChunkText(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
): Promise<string> {
  const nodeLookup = (globalThis as Record<string, unknown>).__helmx_node_chunk_lookup as
    | ((pluginId: string, moduleRef: string, contentHash: string, chunkName: string) => string | undefined)
    | undefined
  if (typeof nodeLookup === 'function') {
    const text = nodeLookup(pluginId, moduleRef, contentHash, chunkName)
    if (text !== undefined) return text
  }

  const headers: Record<string, string> = {}
  const token = getStoredToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const url = `/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=${encodeURIComponent(moduleRef)}&chunk=${encodeURIComponent(chunkName)}&hash=${encodeURIComponent(contentHash)}`
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    if (typeof nodeLookup === 'function') {
      const text = nodeLookup(pluginId, moduleRef, contentHash, chunkName)
      if (text !== undefined) return text
    }
    throw new PluginClientError(
      'client_chunk_fetch_failed',
      `Failed to load plugin ${pluginId} chunk ${chunkName}: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      if (body?.error?.message) message = body.error.message
    } catch {
      /* ignore */
    }
    throw new PluginClientError('client_chunk_http_error', `Plugin ${pluginId} chunk ${chunkName}: ${message}`, res.status)
  }
  return await res.text()
}

/**
 * chunk 文本去重获取：同 key 在途 fetch 共享同一 Promise；失败时从缓存清除允许可重试。
 * 失败的 Promise 不会被缓存（拒绝即清除），调用方拿到的拒绝都是自己 await 消费的，
 * 不产生未处理 rejection。
 */
function getChunkTextDeduped(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
): Promise<string> {
  const key = `${pluginId}\0${moduleRef}\0${contentHash}\0${chunkName}`
  const pending = chunkTextFetchCache.get(key)
  if (pending !== undefined) return pending
  const run = fetchChunkText(pluginId, moduleRef, contentHash, chunkName)
  // 失败即清除（可重试）；成功保留到 evict/reset（内容寻址 + hash 锁定，不可变）。
  run.then(
    () => {},
    () => {
      chunkTextFetchCache.delete(key)
    },
  )
  chunkTextFetchCache.set(key, run)
  return run
}

async function loadSingleChunk(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
): Promise<Record<string, unknown>> {
  const key = `${pluginId}\0${moduleRef}\0${contentHash}\0${chunkName}`
  const pending = chunkPromiseCache.get(key)
  if (pending !== undefined) return pending

  trackPluginHash(pluginId, contentHash)
  const generation = pluginCacheGeneration(pluginId)
  const run = (async () => {
    const code = await getChunkTextDeduped(pluginId, moduleRef, contentHash, chunkName)
    // epoch 守卫：evict/reset 后迟到的 fetch 结果不得再求值/写入共享表，显式失效。
    if (generation !== pluginCacheGeneration(pluginId)) {
      throw new PluginClientError(
        'client_module_invalidated',
        `Plugin ${pluginId} chunk ${chunkName} has been invalidated; reload required`,
        0,
      )
    }
    return await evaluateModuleCode(code)
  })().catch((err: unknown) => {
    chunkPromiseCache.delete(key)
    throw err
  })
  chunkPromiseCache.set(key, run)
  return run
}

/**
 * 共享 Chunk 桥：preload 列表是拓扑序（依赖在前）——所有 preload 的 fetch 并发启动
 * （getChunkTextDeduped 去重，同一 chunk 只发一次网络请求），但模块求值严格按拓扑
 * 顺序 await（共享表先写依赖、后写使用者）。失败时：后续 preload 的 fetch 仍会被
 * 并发消费（有 catch 兑底，不产生 unhandled rejection）；模块缓存失败即清除可重试。
 */
;(globalThis as Record<string, unknown>).__helmx_import_chunk = async (
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
  preloads: string[] = [],
): Promise<Record<string, unknown>> => {
  const seen = new Set<string>([chunkName])
  const ordered = preloads.filter((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return true
  })
  // 全部 preload fetch 并发启动（去重后同一 chunk 零重复网络）；失败被捕获为值，
  // 不会产生 unhandled rejection，最终按拓扑顺序在对应位置显式抛出。
  const fetches = ordered.map((p) =>
    getChunkTextDeduped(pluginId, moduleRef, contentHash, p).then(
      (text) => text,
      (err: unknown) => err as Error,
    ),
  )
  for (let i = 0; i < ordered.length; i++) {
    const text = await fetches[i]
    if (text instanceof Error) throw text
    await loadSingleChunk(pluginId, moduleRef, contentHash, ordered[i]!)
  }
  return await loadSingleChunk(pluginId, moduleRef, contentHash, chunkName)
}

async function fetchModuleText(
  pluginId: string,
  moduleRef: string,
  expectedHash?: string,
): Promise<{ code: string; contentHash: string }> {
  const headers: Record<string, string> = {}
  const token = getStoredToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  let url = `/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
  if (expectedHash !== undefined) {
    url += `&hash=${encodeURIComponent(expectedHash)}`
  }
  let res: Response
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    throw new PluginClientError(
      'client_module_fetch_failed',
      `Failed to load plugin ${pluginId} client module ${moduleRef}: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  if (!res.ok) {
    let errorCode: string | undefined
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      if (body?.error?.code) errorCode = body.error.code
      if (body?.error?.message) message = body.error.message
    } catch {
      /* 非 JSON 错误体：保留 HTTP 状态描述 */
    }
    if (res.status === 409 || errorCode === 'client_module_stale') {
      throw new PluginClientError(
        errorCode ?? 'client_module_stale',
        `Plugin ${pluginId} client module ${moduleRef}: ${message}`,
        res.status,
      )
    }
    throw new PluginClientError('client_module_http_error', `Plugin ${pluginId} client module ${moduleRef}: ${message}`, res.status)
  }
  const contentHash = res.headers.get('x-helmx-client-hash') ?? ''
  if (expectedHash !== undefined && contentHash !== expectedHash) {
    throw new PluginClientError(
      'client_module_stale',
      `Plugin ${pluginId} client module ${moduleRef} hash mismatch (expected ${expectedHash}, got ${contentHash || 'none'})`,
      409,
    )
  }
  return { code: await res.text(), contentHash }
}

/**
 * 加载（或复用缓存）插件 client 模块命名空间。
 * - 若传入 expectedHash 且内存缓存 contentHash 命中，直接 Promise.resolve 复用，零网络请求；
 * - 传入 expectedHash 拉取时携带 &hash= 命中服务端不可变缓存，409/hash 不匹配显式逐出缓存并抛错；
 * - 无 expectedHash 或缓存未命中时拉取最新并按同 expectedHash 合并在途请求；不同 expectedHash 竞争时新请求取代旧请求。
 */
export function loadPluginClientModule(
  pluginId: string,
  moduleRef: string,
  expectedHash?: string,
): Promise<LoadedClientModule> {
  const key = cacheKey(pluginId, moduleRef)
  const targetHash = expectedHash !== undefined && expectedHash !== '' ? expectedHash : undefined
  const epoch = cacheEpoch
  const pluginEpoch = pluginEpochs.get(pluginId)

  // 0. O(1) 内存缓存快路径：调用方提供 expectedHash 且命中当前缓存条目时零网络请求。
  if (targetHash !== undefined) {
    const cached = cache.get(key)
    if (cached !== undefined && cached.contentHash === targetHash) {
      if (cached.resolved !== undefined) {
        return Promise.resolve({ module: cached.resolved, contentHash: cached.contentHash })
      }
      return cached.namespaced.then((module) => {
        if (epoch !== cacheEpoch || pluginEpoch !== pluginEpochs.get(pluginId) || cache.get(key) !== cached) {
          throw new PluginClientError(
            'client_module_invalidated',
            `Plugin ${pluginId} client module has been invalidated; reload required`,
            0,
          )
        }
        return { module, contentHash: cached.contentHash }
      })
    }
  }

  // 1. 同一模块在途加载复用：相同 expectedHash 共享同一 Promise；不同 expectedHash 竞争时推进 moduleEpoch 使旧在途失效。
  const existingInflight = inflightLoads.get(key)
  if (existingInflight !== undefined) {
    if (existingInflight.expectedHash === targetHash) {
      return existingInflight.promise.then((res) => {
        if (
          epoch !== cacheEpoch ||
          pluginEpoch !== pluginEpochs.get(pluginId) ||
          existingInflight.moduleEpoch !== (moduleEpochs.get(key) ?? 0)
        ) {
          throw new PluginClientError(
            'client_module_invalidated',
            `Plugin ${pluginId} client module has been invalidated; reload required`,
            0,
          )
        }
        return res
      })
    }
    moduleEpochs.set(key, (moduleEpochs.get(key) ?? 0) + 1)
    inflightLoads.delete(key)
  }

  const myModuleEpoch = moduleEpochs.get(key) ?? 0
  const isCurrent = (): boolean =>
    epoch === cacheEpoch &&
    pluginEpoch === pluginEpochs.get(pluginId) &&
    myModuleEpoch === (moduleEpochs.get(key) ?? 0)
  const assertCurrent = (): void => {
    if (!isCurrent()) {
      throw new PluginClientError('client_module_invalidated', `Plugin ${pluginId} client module has been invalidated; reload required`, 0)
    }
  }

  let loadPromise!: Promise<LoadedClientModule>
  loadPromise = (async (): Promise<LoadedClientModule> => {
    try {
      const { code, contentHash } = await fetchModuleText(pluginId, moduleRef, targetHash)
      assertCurrent()
      const cached = cache.get(key)
      if (cached && cached.contentHash === contentHash) {
        const module = cached.resolved !== undefined ? cached.resolved : await cached.namespaced
        assertCurrent()
        failedModules.delete(key)
        return { module, contentHash }
      }
      trackPluginHash(pluginId, contentHash)
      const imported = evaluateModuleCode(code).catch((err) => {
        throw new PluginClientError(
          'client_module_import_failed',
          `Failed to import plugin ${pluginId} client module ${moduleRef}: ${err instanceof Error ? err.message : String(err)}`,
          0,
        )
      })
      const entry: CacheEntry = { pluginId, moduleRef, contentHash, namespaced: imported }
      // 样式装载与 resolved 发布都在调用方真正 await 的 namespaced 链上完成：import 迟到完成时
      // 若已失效（epoch / 插件 epoch / 模块 epoch / entry 身份任一不符）直接显式报错，绝不补挂样式，
      // 也绝不碰新 epoch 已装载的样式；拒绝仅回收仍属于自己的 entry，允许同 hash 重试，不残留毒化 Promise。
      entry.namespaced = imported.then(
        (moduleNamespace) => {
          if (!isCurrent() || cache.get(key) !== entry) {
            throw new PluginClientError(
              'client_module_invalidated',
              `Plugin ${pluginId} client module has been invalidated; reload required`,
              0,
            )
          }
          applyPluginClientCss(pluginId, moduleRef, contentHash, moduleNamespace)
          // 样式装载成功后才发布同步 resolved 缓存，保证 getCachedClientComponent 命中时样式已在页面上。
          entry.resolved = moduleNamespace
          failedModules.delete(key)
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
    } catch (err: unknown) {
      if (isCurrent()) {
        if (err instanceof PluginClientError && (err.status === 409 || err.code === 'client_module_stale')) {
          evictModuleArtifacts(pluginId, moduleRef)
        }
        if (!(err instanceof PluginClientError && err.code === 'client_module_invalidated')) {
          failedModules.set(key, { pluginId, moduleRef, contentHash: targetHash })
        }
      }
      throw err
    } finally {
      if (inflightLoads.get(key)?.promise === loadPromise) {
        inflightLoads.delete(key)
      }
    }
  })()

  inflightLoads.set(key, { pluginId, moduleRef, expectedHash: targetHash, moduleEpoch: myModuleEpoch, promise: loadPromise })
  return loadPromise
}

/**
 * 同步取已解析缓存模块的具名导出组件：缓存命中且导出为函数时直接返回，
 * 避免 PluginUiView 重复挂载（时间线重渲染 / SSR）时闪烁 loading 态。
 * 若传入 expectedHash，则同时校验 contentHash 匹配。
 * 未加载完成或导出非函数时返回 undefined（调用方走异步加载轨道）。
 */
export function getCachedClientComponent(
  pluginId: string,
  moduleRef: string,
  exportName: string,
  expectedHash?: string,
): ComponentType<Record<string, unknown>> | undefined {
  const cached = cache.get(cacheKey(pluginId, moduleRef))
  if (cached === undefined) return undefined
  if (expectedHash !== undefined && expectedHash !== '' && cached.contentHash !== expectedHash) {
    return undefined
  }
  const mod = cached.resolved
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
  const key = cacheKey(pluginId, moduleRef)
  failedModules.delete(key)
  cache.set(key, {
    pluginId,
    moduleRef,
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
      `Plugin ${pluginId} module ${moduleRef} has no export ${exportName}${available.length > 0 ? ` (available: ${available.join(', ')})` : ' (module has no exports)'}`,
      0,
    )
  }
  return module[exportName]
}
