/**
 * SDK 宿主端口桥：把 external store 的 pluginHostPort 切片适配为 @helmx/plugin-client
 * 宿主上下文。独立成模块以保持「无 react-dom 依赖」的静态导入图——测试 helper
 * （helpers/host-store.ts）静态引入本模块不会在 happy-dom 注册前加载 react-dom/client
 * （那会破坏受控输入的事件委托）；生产 HelmxStoreProvider 与测试共用同一实现。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { PluginClientHostPort } from '@helmx/plugin-client'
import { PluginClientHostContext } from '@helmx/plugin-client'
import { createLocaleTranslator } from '@helmx/protocol/browser'
import type { HelmxExternalStore } from './helmx-store.js'
import { createPluginClientHostPort } from './plugin-client-host.js'
import { createWebTranslator } from '../i18n/catalog.js'
import {
  collectBackgroundBadgeDocs,
  summarizeConversationBackgroundActivity,
} from '../shell/background-activity-model.js'

export function PluginClientHostBridge({ store, children }: { store: HelmxExternalStore; children: React.ReactNode }) {
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
      // 插件 SDK 共享的宿主标准后台在途快照（与侧栏灯环同一聚合口径）：
      // badge doc 尚未首次加载时 unknown=true，插件必须渲染「未知」而非「无后台任务」。
      conversationBackground: {
        unknown: collectBackgroundBadgeDocs(slice.groupedUi.workbenchPanels, slice.conversations).some((ref) =>
          Object.hasOwn(slice.pluginDocs, `${ref.pluginId}/${ref.doc}`) === false,
        ),
        byConversation: summarizeConversationBackgroundActivity({
          panels: slice.groupedUi.workbenchPanels,
          conversations: slice.conversations,
          pluginDocs: slice.pluginDocs,
          t: createWebTranslator(slice.locale),
        }),
      },
    }),
    [slice, store],
  )
  return <PluginClientHostContext.Provider value={port}>{children}</PluginClientHostContext.Provider>
}
