/**
 * 插件 client.tsx 组件的宿主上下文与共享 hooks。
 *
 * 本模块同时服务两个消费方（同一实现，绝不打包第二份 React）：
 * 1. 宿主自身：`<PluginUiView />` import createPluginClientContext / PluginClientContext；
 * 2. 插件编译产物：源码里 `import { usePluginContext, usePluginDoc } from '@helm/plugin-client'`，
 *    编译器把该说明符虚拟化为 `module.exports = globalThis.__helm_shared_plugin_client`
 *    （HelmStoreProvider 挂载本模块导出），运行时取到的就是这里导出的同一批函数。
 *
 * 全部能力转发真实宿主 store（invokePluginAction / openTarget / ensurePluginDoc /
 * usePluginDoc），无任何 mock。
 */
import { createContext, useContext } from 'react'
import type { PluginClientContext as PluginClientContextType } from '@helm/protocol'
import { usePluginDoc as usePluginDocFromStore } from './store-context.js'
import type { HelmStoreValue } from './types.js'

export const PluginClientContext = createContext<PluginClientContextType | null>(null)

export function usePluginContext(): PluginClientContextType {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginContext 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return ctx
}

/**
 * 响应式订阅当前插件的 public doc：首次自动 GET，随后随 SSE
 * `plugin.doc.updated` 实时重渲染（与宿主 usePluginDoc 同一 store，非 Promise 轮询）。
 * 必须在 <PluginUiView> 内的插件组件中调用（从 ctx.pluginId 解析当前插件）。
 *
 * 导出两个名字：插件源码 `import { usePluginDoc } from '@helm/plugin-client'`
 * （共享模块契约名）；宿主内部引用用 useClientPluginDoc 避免与
 * store-context 的 usePluginDoc(pluginId, docName) 混淆。
 */
export const usePluginDoc = useClientPluginDocInternal
export { useClientPluginDocInternal as useClientPluginDoc }

function useClientPluginDocInternal<T = unknown>(docName: string): T | undefined {
  const ctx = useContext(PluginClientContext)
  if (ctx === null) {
    throw new Error('usePluginDoc 必须在 <PluginUiView> 内的插件组件中调用')
  }
  return usePluginDocFromStore<T>(ctx.pluginId, docName)
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
    openArtifact: (artifactId) => store.setActiveModal({ kind: 'artifact-preview', artifactId, conversationId }),
    openWorkbench: (panelId) => {
      store.setWorkbenchOpen(true)
      if (panelId) store.setWorkbenchTab(panelId)
    },
    closeWorkbench: () => store.setWorkbenchOpen(false),
    notify: (message, tone = 'info') =>
      store.pushNotice({
        type: 'notification',
        level: tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'info',
        title: message,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
    getPluginDoc: (docName) => store.ensurePluginDoc(pluginId, docName),
    ...(conversationId !== undefined ? { conversationId } : {}),
    theme: store.theme,
  }
}
