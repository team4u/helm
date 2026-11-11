/**
 * 插件 client.tsx 模块加载器（纯逻辑，无组件导出）：
 * - Bearer fetch 拉取编译产物（token 绝不进 URL）→ Blob URL 动态 import → 释放 URL；
 *   浏览器 Blob import 失败即真实错误（client_module_import_failed），绝不回退
 *   data URL 掩盖；Node/无 Blob 环境用 data URL（测试与 SSR 唯一可行路径）；
 * - 按 (pluginId, module, contentHash) 缓存模块命名空间（含已解析 resolved 快路径）；
 *   插件停用/卸载（uiContributions 移除）时失效缓存并回收其注入样式；
 * - 共享 Chunk 桥（__helm_import_chunk）：preload fetch 全并发去重（同一 chunk 零重复
 *   网络请求）、模块求值按拓扑顺序 await；epoch 守卫确保 evict/reset 后迟到的 chunk
 *   不得回写 __helm_chunk_share（显式 client_module_invalidated，绝不静默）；
 *   __helm_chunk_share 条目按 pluginId + moduleRef + contentHash + chunk 隔离，
 *   两插件同源同 hash 时停用一个不会删掉另一个的共享表；
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
const inflightLoads = new Map<string, Promise<LoadedClientModule>>()
const pluginEpochs = new Map<string, number>()
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
    if (entry.pluginId === pluginId) {
      cache.delete(key)
      inflightLoads.delete(key)
    }
  }
  for (const key of chunkPromiseCache) {
    if (key[0].startsWith(`${pluginId}\0`)) {
      chunkPromiseCache.delete(key[0])
    }
  }
  for (const key of chunkTextFetchCache) {
    if (key[0].startsWith(`${pluginId}\0`)) {
      chunkTextFetchCache.delete(key[0])
    }
  }
  // 共享表按 pluginId + moduleRef + contentHash + chunk 隔离清理：只删属于本插件的条目，
  // 另一插件同源同 hash 的共享条目不受影响（key = pluginId\0moduleRef\0hash\0chunk）。
  const hashes = pluginLoadedHashes.get(pluginId)
  if (hashes && (globalThis as Record<string, unknown>).__helm_chunk_share) {
    const share = (globalThis as Record<string, unknown>).__helm_chunk_share as Record<string, unknown>
    const prefix = `${pluginId}\0`
    for (const k of Object.keys(share)) {
      if (k.startsWith(prefix) && hashes.has(k.split('\0')[2] ?? '')) {
        delete share[k]
      }
    }
    pluginLoadedHashes.delete(pluginId)
  }
  removePluginStyleSheets(pluginId)
  notifyCacheInvalidated()
}

/** 全量重建（如登出）：清空所有插件 client 模块缓存。 */
export function resetPluginClientCache(): void {
  cacheEpoch++
  pluginEpochs.clear()
  cache.clear()
  inflightLoads.clear()
  chunkPromiseCache.clear()
  chunkTextFetchCache.clear()
  pluginLoadedHashes.clear()
  if ((globalThis as Record<string, unknown>).__helm_chunk_share) {
    const share = (globalThis as Record<string, unknown>).__helm_chunk_share as Record<string, unknown>
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
  const nodeLookup = (globalThis as Record<string, unknown>).__helm_node_chunk_lookup as
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
      `加载插件 ${pluginId} chunk ${chunkName} 失败：${err instanceof Error ? err.message : String(err)}`,
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
    throw new PluginClientError('client_chunk_http_error', `插件 ${pluginId} chunk ${chunkName}：${message}`, res.status)
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
        `插件 ${pluginId} 的 chunk ${chunkName} 加载已失效，请重新加载`,
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
;(globalThis as Record<string, unknown>).__helm_import_chunk = async (
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

  // 1. 同一模块在途加载复用：并发挂载（如一个会话内多个同类图表代码块）共享同一个加载 Promise，
  // 杜绝同时发起多次重复的 client.mjs 网络请求
  const pending = inflightLoads.get(key)
  if (pending !== undefined) {
    const res = await pending
    assertCurrent()
    return res
  }

  let loadPromise: Promise<LoadedClientModule> | null = null
  loadPromise = (async (): Promise<LoadedClientModule> => {
    try {
      const { code, contentHash } = await fetchModuleText(pluginId, moduleRef)
      assertCurrent()
      const cached = cache.get(key)
      if (cached && cached.contentHash === contentHash) {
        const module = await cached.namespaced
        assertCurrent()
        return { module, contentHash }
      }
      trackPluginHash(pluginId, contentHash)
      const imported = evaluateModuleCode(code).catch((err) => {
        throw new PluginClientError(
          'client_module_import_failed',
          `插件 ${pluginId} client 模块 ${moduleRef} 导入失败：${err instanceof Error ? err.message : String(err)}`,
          0,
        )
      })
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
    } finally {
      if (inflightLoads.get(key) === loadPromise) {
        inflightLoads.delete(key)
      }
    }
  })()

  inflightLoads.set(key, loadPromise)
  return await loadPromise
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
