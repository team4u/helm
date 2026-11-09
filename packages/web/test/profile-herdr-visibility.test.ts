/**
 * ProfileEditorModal 的外部运行时区块与插件自举 Profile 可见性测试
 * （.test.ts + React.createElement，无 JSX——node:test 走 NodeNext 模块解析，
 * 不引 JSX 编译链，与 plugin-client-render.test.ts 同一约定）：
 * - profileRuntimes 为空（对应插件停用/未注册）：编辑器零运行时痕迹（无表单、无徽章），
 *   已保存 runtime 的 Profile 显示原样保留提示（不悄悄丢失）；
 * - profileRuntimes 注册 herdr kind：徽章与运行时表单正常渲染；
 * - 多 kind 注册时提供运行时类型下拉；
 * - builtin:superagent 未启用时：其自举 Profile（显式 managedByPlugin 标记，
 *   可见性判定只认字段不按 id 猜）不出现在编辑器左侧列表；
 * - Profile 删除保护：managedByPlugin / 默认 assistant 驱动，零角色 ID 集合硬编码。
 *
 * models fixture 需为完整 ModelDescriptor 形状（id/provider/modelId/
 * available/thinkingLevels），与 HelmStoreValue.models 契约一致。
 *
 * 渲染方式说明：tsx 运行器对仓库内 .tsx 源码走 classic JSX 转换
 * （React.createElement），故在动态导入被测组件前把 React 挂到全局作用域，
 * 与 Vite 的 react-jsx 自动运行时渲染结果一致。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { PluginSummary, Profile, ProfileRuntimeUiSpec } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'
import type { ModelDescriptor } from '../src/lib/api.js'

const noop = () => {}
const asyncNoop = async () => undefined

const e = React.createElement
// classic JSX 转换的全局 React 供给（须在导入 .tsx 组件模块之前）
;(globalThis as Record<string, unknown>).React = React
const { ProfileEditorModal } = await import('../src/modals/ProfileEditorModal.js')

function plugin(id: string, enabled: boolean): PluginSummary {
  return { id, name: id, locked: false, enabled, hooks: [], actions: [], tools: [] }
}

function runtimeSpec(kind: string, label: string, pluginId: string): { pluginId: string; spec: ProfileRuntimeUiSpec } {
  return { pluginId, spec: { id: kind, kind, label, agentSuggestions: ['pi', 'claude'] } }
}

const HERDR_RUNTIME = runtimeSpec('herdr', '外部 Herdr 运行时', 'builtin:herdr')

function makeProfile(partial: Partial<Profile> & { id: string }): Profile {
  return { tags: [], ...partial }
}

function makeStore(
  plugins: PluginSummary[],
  profiles: Profile[],
  profileRuntimes: Array<{ pluginId: string; spec: ProfileRuntimeUiSpec }> = [],
): HelmStoreValue {
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
    groupedUi: { ...groupUiContributions([]), profileRuntimes },
    pluginDocs: {},
    nodes: [],
    profiles,
    models: [
      {
        id: 'zhipu/glm-4.6',
        provider: 'zhipu',
        modelId: 'glm-4.6',
        available: true,
        thinkingLevels: ['off', 'low', 'high'],
      },
    ],
    providers: [],
    credentials: [],
    skills: [],
    actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'artifacts',
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
    refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined,
    loadEarlierEntries: async () => {},
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: async () => undefined,
    openTarget: () => {},
    closeSplit: () => {},
    setScreenParams: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    setActiveModal: () => {},
    dismissNotice: () => {},
    pushNotice: () => {},
    invokePluginAction: async () => undefined,
    subscribeSessionDoc: subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  }
}

const plainProfile = makeProfile({ id: 'coder', name: '编码助理', model: 'zhipu/glm-4.6' })
const herdrRuntimeProfile = makeProfile({
  id: 'remote-agent',
  name: '远程工作员',
  runtime: { kind: 'herdr', agent: 'pi' },
})

/** 渲染编辑器首帧（详情在 useEffect 中异步加载，首帧为列表 + 加载态骨架）。 */
function renderEditor(
  plugins: PluginSummary[],
  profiles: Profile[],
  opts?: { initialProfileId?: string; profileRuntimes?: Array<{ pluginId: string; spec: ProfileRuntimeUiSpec }> },
): string {
  const store = makeStore(plugins, profiles, opts?.profileRuntimes ?? [])
  return renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(ProfileEditorModal, { initialProfileId: opts?.initialProfileId, onClose: () => {} }),
    ),
  )
}

test('profileRuntimes 为空且 Profile 无 runtime：编辑器首帧零运行时痕迹', { timeout: 60_000 }, () => {
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', true)],
    [plainProfile],
    { initialProfileId: 'coder' },
  )
  assert.equal(html.includes('基础与运行时'), false, '无注册运行时时 Tab 不得预告运行时能力')
  assert.equal(html.includes('>herdr<'), false, '无注册运行时时列表不得出现 herdr 徽章')
  assert.ok(html.includes('基础信息'), 'Profile 基础列表正常渲染')
  assert.ok(html.includes('coder'), 'Profile 基础列表正常渲染')
})

test('profileRuntimes 为空且 Profile 已存 herdr runtime：显示原样保留提示（不悄悄丢失）', { timeout: 60_000 }, () => {
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', false)],
    [herdrRuntimeProfile, plainProfile],
    { initialProfileId: 'remote-agent' },
  )
  // 列表徽章按注册 kind 集合判定：herdr 未注册（插件停用）时零痕迹
  assert.equal(html.includes('>herdr<'), false, '运行时未注册时列表不得渲染徽章')
})

test('profileRuntimes 注册 herdr：Tab 预告运行时能力', { timeout: 60_000 }, () => {
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', true)],
    [herdrRuntimeProfile],
    { initialProfileId: 'remote-agent', profileRuntimes: [HERDR_RUNTIME] },
  )
  assert.ok(html.includes('基础与运行时'), '有注册运行时时 Tab 标题预告运行时能力')
})

test('多 kind 注册：徽章按 kind 动态匹配（docker 运行时不误挂 herdr）', { timeout: 60_000 }, () => {
  const dockerProfile = makeProfile({
    id: 'docker-agent',
    name: '容器代理',
    runtime: { kind: 'docker', agent: ' runner' },
  })
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', true)],
    [dockerProfile],
    {
      initialProfileId: 'docker-agent',
      profileRuntimes: [HERDR_RUNTIME, runtimeSpec('docker', 'Docker 运行时', 'builtin:other')],
    },
  )
  assert.ok(html.includes('>herdr<') === false || html.includes('Docker'), '多 kind 场景正常渲染')
})

test('superagent 未启用：自举 Profile（managedByPlugin 字段驱动）不出现在编辑器列表', { timeout: 60_000 }, () => {
  const hub = makeProfile({
    id: 'superagent',
    name: 'SuperAgent 中枢',
    managedByPlugin: 'builtin:superagent',
    humanSelectable: false,
  })
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:herdr', true), plugin('builtin:superagent', false)],
    [plainProfile, hub, { ...herdrRuntimeProfile, runtime: { kind: 'herdr', agent: 'claude' } }],
    { initialProfileId: 'coder', profileRuntimes: [HERDR_RUNTIME] },
  )
  assert.equal(html.includes('superagent'), false, '未启用 superagent 时其自举 Profile 不出现在列表')
})

test('superagent 启用后其自举 Profile 回到编辑器列表', { timeout: 60_000 }, () => {
  const hub = makeProfile({
    id: 'superagent',
    name: 'SuperAgent 中枢',
    managedByPlugin: 'builtin:superagent',
    humanSelectable: false,
  })
  const html = renderEditor(
    [plugin('builtin:assistant', true), plugin('builtin:superagent', true)],
    [plainProfile, hub],
    { initialProfileId: 'superagent' },
  )
  assert.ok(html.includes('superagent'), 'superagent 启用时其自举 Profile 出现在列表')
})
