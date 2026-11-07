/**
 * usePluginContext：插件 client.tsx 组件消费的宿主上下文。
 * 由 <PluginUiView /> 依当前插槽注入；callAction/openScreen/openSplitScreen/
 * getPluginDoc 全部转发真实宿主能力（store.invokePluginAction / openTarget /
 * ensurePluginDoc），无任何 mock。
 */
import { createContext, useContext } from 'react'
import type { PluginClientContext as PluginClientContextType } from '@helm/protocol'
import type { HelmStoreValue } from './types.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return ctx
}

/** 从宿主 store 构造绑定插件 ID 的上下文实现（PluginUiView 内部使用）。 */
export function createPluginClientContext(
  store: HelmStoreValue,
  pluginId: string,
  conversationId: number | undefined,
): PluginClientContextType {
  return {
    pluginId,
    callAction: (actionId, input) => store.invokePluginAction(pluginId, actionId, input, conversationId),
    openScreen: (target) => store.openTarget(target),
    openSplitScreen: (target) => store.openTarget(target, { split: true }),
    getPluginDoc: (docName) => store.ensurePluginDoc(pluginId, docName),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: store.theme,
  }
}
