/**
 * ProfileEditorModal 外部运行时表单动态化交互测试（happy-dom + createRoot + act）：
 * - 多 kind 注册：运行时类型下拉出现，切换 kind 重建空白配置；
 * - 单 kind 注册：无下拉，直接开关；
 * - kind 未注册（插件停用）：已保存 runtime 显示「原样保留 / 清除」提示，不悄悄丢失；
 * - agentSuggestions：按选中 kind 的 spec 注入 datalist。
 *
 * 数据经真实组件树（HelmStoreContext.Provider + ProfileEditorModal）渲染；
 * assetsApi.getProfile / getDefaultModel 经 fetch 模拟返回真实 Profile 形状。
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginSummary, Profile, ProfileRuntimeUiSpec } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { ProfileEditorModal } = await import('../src/modals/ProfileEditorModal.js')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})

function plugin(id: string, enabled: boolean): PluginSummary {
  return { id, name: id, locked: false, enabled, hooks: [], actions: [], tools: [] }
}

function runtimeSpec(kind: string, label: string, pluginId: string): { pluginId: string; spec: ProfileRuntimeUiSpec } {
  return { pluginId, spec: { id: kind, kind, label, agentSuggestions: [kind === 'herdr' ? 'pi' : 'runner'] } }
}

const HERDR = runtimeSpec('herdr', '外部 Herdr 运行时', 'builtin:herdr')
const DOCKER = runtimeSpec('docker', 'Docker 运行时', 'builtin:other')

function makeStore(profileRuntimes: Array<{ pluginId: string; spec: ProfileRuntimeUiSpec }>): HelmStoreValue {
  const noop = () => {}
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
    plugins: [plugin('builtin:assistant', true), plugin('builtin:herdr', true)],
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
      profileRuntimes,
      conversationHeaderActions: [],
      conversationRowActions: [],
      timelineEntryActions: [],
      pluginSlots: [],
    },
    pluginDocs: {},
    nodes: [],
    profiles: [],
    models: [],
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
    subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: async () => undefined,
    retrySessionDoc: noop,
    setScreenParams: noop,
    setTheme: noop,
    setThemePreference: noop,
    toggleTheme: noop,
    checkAuth: async () => {},
    onAuthenticated: async () => {},
    logout: noop,
    refreshAssets: async () => {},
    refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined,
    loadEarlierEntries: async () => {},
    loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: async () => undefined,
    openTarget: noop,
    closeSplit: noop,
    setWorkbenchOpen: noop,
    setWorkbenchTab: noop,
    setActiveModal: noop,
    dismissNotice: noop,
    pushNotice: noop,
    invokePluginAction: async () => undefined,
  }
}

/** 挂载编辑器并等待 Profile 详情异步加载完成（加载态消失）。 */
async function mountEditor(
  store: HelmStoreValue,
  detail: Profile,
): Promise<{ root: Root; host: HTMLElement }> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url === '/api/models/default') return json({ defaultModel: '', defaultThinkingLevel: '' })
    if (url.startsWith('/api/profiles/')) return json({ tags: [], ...detail })
    return new Response('{}", { status: 404 }' as unknown as BodyInit, { status: 404 })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(HelmStoreContext.Provider, { value: store }, e(ProfileEditorModal, { initialProfileId: detail.id, onClose: () => {} })))
  })
  // 等待详情 useEffect 完成（加载态文本消失）
  for (let i = 0; i < 50 && document.body.textContent?.includes('正在读取') === true; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
  }
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  assert.ok(dialog, '编辑器通过统一 Dialog Portal 挂载')
  return { root, host: dialog }
}

test('多 kind 注册：运行时类型下拉出现且按 spec 注入 agent 候选', { timeout: 60_000 }, async () => {
  const detail: Profile = { id: 'remote-agent', name: '远程', tags: [], runtime: { kind: 'herdr', agent: 'pi' } }
  const { root, host } = await mountEditor(makeStore([HERDR, DOCKER]), detail)
  try {
    // 自定义 Select（WAI-ARIA combobox）：触发器列出全部 kind 选项
    const kindTrigger = host.querySelector('#helm-runtime-kind') as HTMLElement | null
    assert.ok(kindTrigger, '多 kind 时渲染运行时类型选择器')
    const triggerText = kindTrigger!.textContent ?? ''
    assert.ok(triggerText.includes('外部 Herdr 运行时'), '当前选中项为 herdr 的 spec label')

    // datalist 候选来自选中 kind 的 spec（herdr -> pi）
    const datalist = host.querySelector('#helm-runtime-agents') as HTMLDataListElement | null
    assert.ok(datalist, 'agent 候选 datalist 存在')
    assert.deepEqual([...datalist!.options].map((o) => o.value), ['pi'])
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('单 kind 注册：无下拉，开关直接管理', { timeout: 60_000 }, async () => {
  const detail: Profile = { id: 'remote-agent', name: '远程', tags: [], runtime: { kind: 'herdr', agent: 'pi' } }
  const { root, host } = await mountEditor(makeStore([HERDR]), detail)
  try {
    assert.equal(host.querySelector('#helm-runtime-kind'), null, '单 kind 时不渲染类型下拉')
    assert.ok(host.querySelector('#helm-runtime-agent'), 'agent 输入框直接渲染')
    assert.ok(host.textContent?.includes('外部 Herdr 运行时'), '开关标题用 spec label')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('kind 未注册（插件停用）：显示原样保留提示，不悄悄丢失', { timeout: 60_000 }, async () => {
  const detail: Profile = { id: 'remote-agent', name: '远程', tags: [], runtime: { kind: 'herdr', agent: 'pi' } }
  const { root, host } = await mountEditor(makeStore([]), detail)
  try {
    assert.equal(host.querySelector('#helm-runtime-kind'), null, '无注册运行时时不渲染表单')
    assert.equal(host.querySelector('#helm-runtime-agent'), null, '无注册运行时时不渲染 agent 输入')
    assert.ok(host.textContent?.includes('所属插件未启用'), '已保存 runtime 显示原样保留提示')
    // 清除按钮存在（显式选择，不悄悄丢失）
    const clearBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('清除'))
    assert.ok(clearBtn, '清除按钮存在')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

test('无 runtime Profile + 注册运行时：开关开启后以默认 kind 建立空白配置', { timeout: 60_000 }, async () => {
  const detail: Profile = { id: 'plain', name: '普通', tags: [] }
  const { root, host } = await mountEditor(makeStore([HERDR]), detail)
  try {
    assert.ok(host.textContent?.includes('基础与运行时'), 'Tab 标题预告运行时能力')
    const switchBtn = host.querySelector('button[role="switch"]') as HTMLButtonElement | null
    assert.ok(switchBtn, '运行时开关存在')
    assert.equal(switchBtn!.getAttribute('aria-checked'), 'false')
    await act(async () => {
      switchBtn!.click()
    })
    const agentInput = host.querySelector('#helm-runtime-agent') as HTMLInputElement | null
    assert.ok(agentInput, '开启后渲染 agent 输入')
    assert.equal(agentInput!.value, '', '新建配置 agent 为空')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})
