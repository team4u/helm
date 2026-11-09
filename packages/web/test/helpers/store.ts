import * as React from 'react'
import { HelmStoreContext } from '../../src/lib/store-context.js'
import { PluginClientContext, createPluginClientContext } from '../../src/lib/plugin-client-context.js'
import { groupUiContributions, type HelmStoreValue } from '../../src/lib/types.js'

export function makeTestStore(overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'system',
    conversations: [], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {}, plugins: [], uiContributions: [],
    groupedUi: groupUiContributions([]), pluginDocs: {}, nodes: [], profiles: [], models: [],
    providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    ...overrides,
  }
}

/** 同时注入真实宿主 store 与 SDK 上下文，不替换 hooks 或组件事件。 */
export function TestStoreProvider({ value, children }: { value: HelmStoreValue; children?: React.ReactNode }): React.ReactNode {
  return React.createElement(HelmStoreContext.Provider, { value },
    React.createElement(PluginClientContext.Provider, { value: createPluginClientContext(value, 'builtin:workflow', 1) }, children))
}
