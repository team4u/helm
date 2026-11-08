/**
 * ProfileEditorModal 的 Herdr 运行时区块与插件自举 Profile 可见性测试
 * （.test.ts + React.createElement，无 JSX——node:test 走 NodeNext 模块解析，
 * 不引 JSX 编译链，与 plugin-client-render.test.ts 同一约定）：
 * - builtin:herdr 未启用时：普通 Profile 编辑器零 Herdr 痕迹（无运行时卡片、无 herdr 徽章）；
 * - builtin:herdr 启用时：herdr 徽章正常渲染；
 * - builtin:superagent 未启用时：其自举 Profile 不出现在编辑器左侧列表。
 *
 * 渲染方式说明：tsx 运行器对仓库内 .tsx 源码走 classic JSX 转换
 * （React.createElement），故在动态导入被测组件前把 React 挂到全局作用域，
 * 与 Vite 的 react-jsx 自动运行时渲染结果一致。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { PluginSummary, Profile } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'

const e = React.createElement
// classic JSX 转换的全局 React 供给（须在导入 .tsx 组件模块之前）
;(globalThis as Record<string, unknown>).React = React
const { ProfileEditorModal } = await import('../src/modals/ProfileEditorModal.js')

function plugin(id: string, enabled: boolean): PluginSummary {
  return { id, name: id, locked: false, enabled, hooks: [], actions: [], tools: [] }
}

function makeProfile(partial: Partial<Profile> & { id: string }): Profile {
  return { tags: [], ...partial }
}

function makeStore(plugins: PluginSummary[], profiles: Profile[]): HelmStoreValue {
  return {
    authReady: true,
    authConfigured: true,
    authenticated: true,
    authError: null,
    connectionError: null,
    loadErrors: {},
    sseConnected: true,
    theme: 'dark',
    themePreference: 'system',
    conversations: [],
    conversationDetails: {},
    conversationLives: {},
    conversationArtifacts: {},
    pendingAsks: [],
    resolvedAsksByConv: {},
    plugins,
    uiContributions: [],
    groupedUi: {
      sidebarItems: [],
      sidebarSections: [],
      screens: [],
      timelineRenderers: [],
      toolViews: [],
      composerPills: [],
      composerWidgets: [],
      workbenchPanels: [],
      commands: [],
      settingsPanels: [],
    },
    pluginDocs: {},
    workflowRuns: [],
    profiles,
    models: [{ id: 'zhipu/glm-4.6' }],
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'tasks',
    activeModal: null,
    highlightedEntry: null,
    notices: [],
    setTheme: () => {},
    setThemePreference: () => {},
    toggleTheme: () => {},
    checkAuth: async () => {},
    onAuthenticated: async () => {},
    logout: () => {},
    refreshAssets: async () => {},
    loadConversationDetail: async () => undefined,
    loadEarlierEntries: async () => {},
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: async () => undefined,
    openTarget: () => {},
    closeSplit: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    setActiveModal: () => {},
    dismissNotice: () => {},
    pushNotice: () => {},
    invokePluginAction: async () => undefined,
  }
}

const plainProfile = makeProfile({ id: 'coder', name: '编码助理', model: 'zhipu/glm-4.6' })
const herdrRuntimeProfile = makeProfile({
  id: 'remote-agent',
  name: '远程工作员',
  runtime: { kind: 'herdr', agent: 'pi' },
})

/** 渲染编辑器首帧（详情在 useEffect 中异步加载，首帧为列表 + 加载态骨架）。 */
function renderEditor(plugins: PluginSummary[], profiles: Profile[], initialProfileId?: string): string {
  const store = makeStore(plugins, profiles)
  return renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(ProfileEditorModal, { initialProfileId, onClose: () => {} }),
    ),
  )
}

test('herdr 未启用且 Profile 无 runtime：编辑器首帧零 Herdr 痕迹', { timeout: 60_000 }, () => {
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', false)],
    [plainProfile],
    'coder',
  )
  assert.equal(html.includes('外部 Herdr 运行时'), false, '未启用 herdr 时不得渲染运行时卡片标题')
  assert.equal(html.includes('>herdr<'), false, '未启用 herdr 时列表不得出现 herdr 徽章')
  assert.ok(html.includes('coder'), 'Profile 基础列表正常渲染')
})

test('herdr 启用且 Profile 带 runtime：列表渲染 herdr 徽章', { timeout: 60_000 }, () => {
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', true)],
    [herdrRuntimeProfile],
    'remote-agent',
  )
  assert.ok(html.includes('>herdr<'), 'herdr 启用时列表渲染 herdr 徽章')
})

test('herdr 未启用时徽章隐藏；superagent 自举 Profile 不进入编辑器列表', { timeout: 60_000 }, () => {
  const hub = makeProfile({ id: 'superagent', name: 'SuperAgent 中枢' })
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', false), plugin('builtin:superagent', false)],
    [plainProfile, hub, { ...herdrRuntimeProfile, runtime: { kind: 'herdr', agent: 'claude' } }],
    'coder',
  )
  assert.equal(html.includes('superagent'), false, '未启用 superagent 时其自举 Profile 不出现在列表')
  assert.equal(html.includes('>herdr<'), false, '未启用 herdr 时 runtime Profile 的徽章也不渲染')
})

test('superagent 启用后其自举 Profile 回到编辑器列表', { timeout: 60_000 }, () => {
  const hub = makeProfile({ id: 'superagent', name: 'SuperAgent 中枢' })
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:superagent', true)],
    [plainProfile, hub],
    'superagent',
  )
  assert.ok(html.includes('superagent'), 'superagent 启用时其自举 Profile 出现在列表')
})
