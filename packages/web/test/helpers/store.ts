/**
 * 测试 store 替身工厂（纯 web 模块，不引入 @helm/plugin-client 的 Radix 依赖图）：
 * happy-dom 环境下需要交互式展开 Radix 浮层的测试遵循「GlobalRegistrator.register()
 * 之后再动态加载」约定；本模块可被静态导入而不破坏该约定。
 * Provider 栈见 helpers/host-store.ts（静态引入 SDK，需按约定动态加载）。
 */
import { HelmStoreContext } from '../../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../../src/lib/types.js'
import {
  getSessionDocState,
  subscribeSessionDoc,
  type SessionDocKey,
} from '../../src/lib/session-docs.js'

export { HelmStoreContext }

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
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, syncPlugins: noop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, openSpace: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc: (key: SessionDocKey, listener: () => void) => subscribeSessionDoc(key, listener),
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
    ...overrides,
  }
  return store
}
