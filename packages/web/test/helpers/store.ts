import * as React from 'react'
import { HelmStoreContext } from '../../src/lib/store-context.js'
import { PluginClientContext, createPluginClientContext } from '../../src/lib/plugin-client-context.js'
import { groupUiContributions, spaceForTarget, type HelmStoreValue } from '../../src/lib/types.js'
import {
  getSessionDocState,
  subscribeSessionDoc,
  type SessionDocKey,
} from '../../src/lib/session-docs.js'

export function makeTestStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  const noop = () => {}
  const asyncNoop = async () => undefined
  const store: HelmStoreValue = {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'system',
    conversations: [], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [],
    groupedUi: groupUiContributions([]), pluginDocs: {}, nodes: [], profiles: [], assetsLoaded: true, models: [],
    providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', sidebarSpace: 'conversations', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, syncPlugins: noop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setSidebarSpace: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc: (key: SessionDocKey, listener: () => void) => subscribeSessionDoc(key, listener),
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
    ...overrides,
  }
  // 侧栏空间缺省跟随主屏隐含空间（与真实 Provider 的对齐行为一致），可显式覆写。
  if (overrides.sidebarSpace === undefined) store.sidebarSpace = spaceForTarget(store.primaryTarget)
  return store
}

/** 同时注入真实宿主 store 与 SDK 上下文，不替换 hooks 或组件事件。 */
export function TestStoreProvider({ value, children }: { value: HelmStoreValue; children?: React.ReactNode }): React.ReactNode {
  return React.createElement(HelmStoreContext.Provider, { value },
    React.createElement(PluginClientContext.Provider, { value: createPluginClientContext(value, 'builtin:workflow', 1) }, children))
}
