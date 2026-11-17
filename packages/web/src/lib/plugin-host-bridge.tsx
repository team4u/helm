/**
 * SDK 宿主端口桥：把 external store 的 pluginHostPort 切片适配为 @helm/plugin-client
 * 宿主上下文。独立成模块以保持「无 react-dom 依赖」的静态导入图——测试 helper
 * （helpers/host-store.ts）静态引入本模块不会在 happy-dom 注册前加载 react-dom/client
 * （那会破坏受控输入的事件委托）；生产 HelmStoreProvider 与测试共用同一实现。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { PluginClientHostPort } from '@helm/plugin-client'
import { PluginClientHostContext } from '@helm/plugin-client'
import { createLocaleTranslator } from '@helm/protocol/browser'
import type { HelmExternalStore } from './helm-store.js'
import { createPluginClientHostPort } from './plugin-client-host.js'

export function PluginClientHostBridge({ store, children }: { store: HelmExternalStore; children: React.ReactNode }) {
  const subscribe = useCallback((listener: () => void) => store.subscribeDomain('pluginHostPort', listener), [store])
  const slice = useSyncExternalStore(subscribe, store.getPluginHostPortSlice, store.getPluginHostPortSlice)
  const port = useMemo<PluginClientHostPort>(
    () => ({
      ...createPluginClientHostPort({
        authenticated: slice.authenticated,
        theme: slice.theme,
        conversations: slice.conversations,
        conversationDetails: slice.conversationDetails,
        conversationLives: slice.conversationLives,
        pendingAsks: slice.pendingAsks,
        loadErrors: slice.loadErrors,
        plugins: slice.plugins,
        groupedUi: slice.groupedUi,
        pluginDocs: slice.pluginDocs,
        ensurePluginDoc: store.actions.ensurePluginDoc,
        getPluginSessionDoc: store.actions.getPluginSessionDoc,
        subscribeSessionDoc: store.actions.subscribeSessionDoc,
        getSessionDocState: store.actions.getSessionDocState,
        invokePluginAction: store.actions.invokePluginAction,
        openTarget: store.actions.openTarget,
        setActiveModal: store.actions.setActiveModal,
        setWorkbenchOpen: store.actions.setWorkbenchOpen,
        setWorkbenchTab: store.actions.setWorkbenchTab,
        pushNotice: store.actions.pushNotice,
        loadConversationDetail: store.actions.loadConversationDetail,
      }),
      locale: slice.locale,
      translate: createLocaleTranslator(slice.locale),
    }),
    [slice, store],
  )
  return <PluginClientHostContext.Provider value={port}>{children}</PluginClientHostContext.Provider>
}
