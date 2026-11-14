/**
 * 插件公开文档 / 会话级文档的响应式订阅 hooks（宿主端口驱动）。
 *
 * - 插件面向（PLUGIN_CLIENT_SHARED_EXPORTS 契约名）：usePluginDoc(docName, pluginId?) /
 *   usePluginSessionDoc(docName, options?)——必须在 <PluginUiView> 内的插件组件中调用；
 * - 宿主面向（显式寻址，无需插件上下文）：usePluginDocValue / usePluginSessionDocState /
 *   usePluginSessionDocValue——供宿主组件与调试句柄复用同一实现。
 *
 * 会话级订阅走 (pluginId, docName, conversationId) 元组专用 SSE 流
 * （ref-count 共享；仅实际挂载引用才连接），不依赖全局事件。
 * 本文件无组件导出（Fast Refresh 友好）。
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PluginSessionDocKey, PluginSessionDocState } from './host-port.js'
import { usePluginClientHost } from './host-port.js'
import { usePluginContext } from './plugin-context.js'

// ---------------------------------------------------------------------------
// 公开文档（public doc）：首次自动 GET，随后随 SSE plugin.doc.updated 实时更新
// ---------------------------------------------------------------------------

/** 订阅指定插件的公开文档（显式寻址；插件组件内请用 usePluginDoc）。 */
export function usePluginDocValue<T = unknown>(pluginId: string, docName: string): T | undefined {
  const port = usePluginClientHost()
  const key = `${pluginId}/${docName}`
  const value = port.pluginDocs[key] as T | undefined

  const { ensurePluginDoc, authenticated } = port
  useEffect(() => {
    if (value === undefined && authenticated) void ensurePluginDoc(pluginId, docName)
  }, [pluginId, docName, value, authenticated, ensurePluginDoc])

  return value
}

/**
 * 响应式订阅公开文档：pluginId 省略时取当前 ctx.pluginId（本插件），
 * 传入时订阅其他插件的公开文档（跨插件寻址）。
 * 必须在 <PluginUiView> 内的插件组件中调用。
 */
export function usePluginDoc<T = unknown>(docName: string, pluginId?: string): T | undefined {
  const ctx = usePluginContext()
  return usePluginDocValue<T>(pluginId ?? ctx.pluginId, docName)
}

// ---------------------------------------------------------------------------
// 会话级公开文档（sessionDoc）：元组专用 SSE 流，ref-count 共享
// ---------------------------------------------------------------------------

const EMPTY_SESSION_DOC: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }

/** 订阅诊断态（错误/连接状态/删除标记）：供显式展示，不静默降级。 */
export function usePluginSessionDocState(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): PluginSessionDocState {
  const port = usePluginClientHost()
  // 仅依赖稳定的具名函数与 key：端口对象随宿主 SSE 状态频繁换引用，
  // 依赖它会导致每次全局事件都退订（refcount 归零清缓存）再重开流。
  const { subscribeSessionDoc, getSessionDocState } = port
  const pluginId = options?.pluginId
  const conversationId = options?.conversationId
  const key = useMemo<PluginSessionDocKey | null>(
    () => (pluginId !== undefined && conversationId !== undefined && docName !== '' ? { pluginId, docName, conversationId } : null),
    [pluginId, docName, conversationId],
  )
  const subscribe = useCallback(
    (listener: () => void) => (key === null ? () => {} : subscribeSessionDoc(key, listener)),
    [subscribeSessionDoc, key],
  )
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY_SESSION_DOC : getSessionDocState(key)),
    () => EMPTY_SESSION_DOC,
  )
}

/** 订阅取值：delete 帧（deleted=true）按协议携带 value=initial（reset 语义）照常返回；不存在/未初始化/出错返回 undefined。 */
export function usePluginSessionDocValue<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const state = usePluginSessionDocState(docName, options)
  if (!state.hasValue || state.error !== undefined) return undefined
  return state.value as T | undefined
}

/**
 * 响应式订阅会话级公开文档：pluginId 省略时取当前 ctx.pluginId，
 * conversationId 省略时继承当前槽位 ctx.conversationId；两者都缺省时
 * 无会话上下文，返回 undefined 且不发起订阅。
 * 必须在 <PluginUiView> 内的插件组件中调用。
 */
export function usePluginSessionDoc<T = unknown>(
  docName: string,
  options?: { conversationId?: number; pluginId?: string },
): T | undefined {
  const ctx = usePluginContext()
  return usePluginSessionDocValue<T>(docName, {
    pluginId: options?.pluginId ?? ctx.pluginId,
    conversationId: options?.conversationId ?? ctx.conversationId,
  })
}
