/**
 * 双层导航与话题切换器交互测试（happy-dom + 真实 React 事件）：
 * - Sidebar：对话/视图空间切换、搜索过滤智能体、智能体行导航；
 * - 双层导航与单展开：仅当前目标所属智能体展开话题子列表（无折叠钮，
 *   点击智能体名称进入待命态并随之展开），切换目标自动收起原智能体。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary, PluginUiContribution } from '@helm/protocol'
import { groupUiContributions, spaceForTarget, type HelmStoreValue, type ResolvedTarget, type SidebarSpace } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// happy-dom 全局就绪后再加载 react-dom/client 与 SDK Provider 栈（静态导入会捕获注册前的 Node 全局）
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
;(globalThis as Record<string, unknown>).React = React
const { Sidebar } = await import('../src/shell/Sidebar.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')
const { ScreenHost } = await import('../src/screens/ScreenHost.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const HERDR_VIEW = {
  pluginId: 'builtin:herdr',
  surface: 'sidebar.item',
  spec: { id: 'herdr', label: 'Herdr 终端', icon: 'terminal', target: 'screen:builtin:herdr/overview' },
} as const satisfies PluginUiContribution

interface NavSpyStore extends HelmStoreValue {
  openTargetCalls: Array<{ target: ResolvedTarget; split?: boolean }>
}

function makeStore(): NavSpyStore {
  const openTargetCalls: NavSpyStore['openTargetCalls'] = []
  const store = makeTestStore({
    conversations: [
      conv({ id: 1, title: '个人助理' }),
      conv({ id: 10, title: '周末计划', updatedAt: 9000 }),
      conv({ id: 11, title: '代码审查', updatedAt: 8000 }),
      conv({ id: 40, title: '重构方案', profileId: 'coder', updatedAt: 7000 }),
    ],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
    ],
    uiContributions: [HERDR_VIEW],
    groupedUi: groupUiContributions([HERDR_VIEW]),
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    openTarget: (target, opts) => {
      const resolved = typeof target === 'string' ? null : target
      if (resolved) openTargetCalls.push({ target: resolved, split: opts?.split })
    },
  })
  return { ...store, openTargetCalls }
}

let root: ReturnType<typeof createRoot> | null = null
const container = () => document.body.querySelector('#test-root') as HTMLElement

/** React 受控输入赋值：绕过 value tracker 才能触发 onChange。 */
function setInputValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 可变 store 挂具：同一挂载内模拟 Provider 在 SSE/导航后产出新 store 引用。 */
function MutableStoreSidebar({
  base,
  apiRef,
  onClose,
}: {
  base: HelmStoreValue
  apiRef: { current: { update?: (patch: Partial<HelmStoreValue>) => void } }
  onClose?: () => void
}): React.ReactElement {
  const [store, setStore] = React.useState<HelmStoreValue>(base)
  apiRef.current.update = (patch) => setStore((current) => ({ ...current, ...patch }))
  return e(
    HostStoreProviders,
    { value: store },
    onClose ? e(Sidebar as React.ComponentType<{ onClose?: () => void }>, { onClose }) : e(Sidebar),
  )
}

/** 空间代表目标（模拟真实 Provider 的空间回跳：views 取首个可用 screen，settings 缺省角色中心）。
 * 空间高亮由 primaryTarget 经 spaceForTarget 推导，不再有独立的 sidebarSpace 状态。 */
const SPACE_REPRESENTATIVE: Record<SidebarSpace, ResolvedTarget> = {
  conversations: { kind: 'conversation', conversationId: 1 },
  views: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
  settings: { kind: 'profiles' },
}

/** 侧栏空间挂具：真实 Sidebar 经 store.openSpace（唯一导航机制）切换空间——主屏目标
 * 直接切到该空间代表目标，空间高亮由 primaryTarget 推导，验证 Rail 点击到空间
 * 切换的完整链路（与真实 Provider 的 openSpace 行为一致）。 */
function SpaceAwareSidebar({ base }: { base: HelmStoreValue }): React.ReactElement {
  const [primary, setPrimary] = React.useState<ResolvedTarget>(base.primaryTarget)
  const store = React.useMemo<HelmStoreValue>(() => ({
    ...base,
    primaryTarget: primary,
    openSpace: (space: SidebarSpace) => {
      if (spaceForTarget(primary) === space) return
      setPrimary(SPACE_REPRESENTATIVE[space])
    },
  }), [base, primary])
  return e(HostStoreProviders, { value: store }, e(Sidebar))
}

function render(store: HelmStoreValue, element: React.ReactElement): void {
  // 先卸载上一棵树：Popover Portal 挂在 body 上，直接重置 innerHTML 会让卸载阶段找不到节点
  if (root) {
    act(() => {
      root!.unmount()
    })
    root = null
  }
  document.body.innerHTML = '<div id="test-root"></div>'
  root = createRoot(container())
  root.render(e(HostStoreProviders, { value: store }, element))
}



test('Sidebar 空间切换：对话空间默认渲染智能体，视图空间渲染 screen 贡献', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(SpaceAwareSidebar, { base: store }))
  await act(async () => {})

  const body = document.body
  assert.ok(body.querySelector('.activity-rail'), '应渲染 Activity Rail')
  assert.ok(body.textContent!.includes('个人助理'), '对话空间渲染智能体行')
  assert.ok(!body.textContent!.includes('Herdr 终端'), '默认不渲染视图空间项')

  // 切换到视图空间
  const viewsBtn = body.querySelector('button[aria-label="Views space"]') as HTMLButtonElement
  assert.ok(viewsBtn, '视图空间切换按钮存在')
  await act(async () => {
    viewsBtn.click()
  })
  assert.ok(body.textContent!.includes('Herdr 终端'), '视图空间渲染 screen 贡献')
  assert.ok(!body.textContent!.includes('个人助理'), '视图空间不渲染智能体分组')
})

test('Sidebar 设置空间：点击设置空间按钮切换列表，点击插件中心调用 openTarget', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(SpaceAwareSidebar, { base: store }))
  await act(async () => {})

  // 切到设置空间
  const settingsBtn = document.body.querySelector('button[aria-label="Settings space"]') as HTMLButtonElement
  assert.ok(settingsBtn, '设置空间按钮存在')
  await act(async () => {
    settingsBtn.click()
  })
  assert.ok(document.body.querySelector('.settings-nav'), '设置空间渲染系统中心列表')

  // 点击插件中心列表项（行主体 nav-item-main）
  const items = [...document.body.querySelectorAll('.settings-nav-item .nav-item-main')] as HTMLButtonElement[]
  const pluginsItem = items.find((el) => el.textContent!.includes('Plugin Center'))
  assert.ok(pluginsItem, '插件中心设置项存在')
  await act(async () => {
    pluginsItem!.click()
  })
  assert.deepEqual(store.openTargetCalls, [{ target: { kind: 'plugins' }, split: undefined }])
})

test('Sidebar 智能体搜索：默认收起筛选栏，点击开启后支持过滤智能体与话题，清空或 Esc 收起', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 默认收起筛选栏，不渲染输入框
  assert.ok(document.body.querySelector('.sidebar-search-input') === null, '默认不渲染筛选输入框')
  const filterBtn = document.body.querySelector('button[aria-label="Filter agents and topics"]') as HTMLButtonElement
  assert.ok(filterBtn, '筛选切换按钮存在')
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'false')

  // 点击筛选按钮：显示输入框并自动聚焦
  await act(async () => {
    filterBtn.click()
  })
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'true')
  const input = document.body.querySelector('.sidebar-search-input') as HTMLInputElement
  assert.ok(input, '点击筛选按钮后显示输入框')
  assert.ok(document.activeElement === input, '展开筛选栏自动聚焦输入框')

  // 1) 按智能体名称过滤：命中智能体保留，未命中智能体过滤
  await act(async () => {
    setInputValue(input, '编码')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['编码专员'],
    '仅保留命中智能体行',
  )
  assert.ok(document.body.querySelector('.agent-conversations-list')?.textContent?.includes('重构方案'), '搜索时自动展开命中智能体话题')

  // 命中智能体点击行主体进入待命态（名称是稳定入口，首次发送才落库）
  const row = document.body.querySelector('.agent-standing .nav-item-main') as HTMLButtonElement
  await act(async () => {
    row.click()
  })
  assert.deepEqual(store.openTargetCalls[0]?.target, { kind: 'agent', profileId: 'coder' })

  // 2) 按会话标题关键词过滤：自动展开所属智能体并仅渲染命中子会话
  await act(async () => {
    setInputValue(input, '周末')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['个人助理'],
  )
  assert.deepEqual(
    [...document.body.querySelectorAll('.nav-item-sub .nav-item-label')].map((el) => el.textContent),
    ['周末计划'],
    '按话题标题过滤仅显示命中的子会话',
  )

  // 3) 按 #id 过滤非当前智能体下会话：自动展开对应智能体并精确定位命中子会话
  await act(async () => {
    setInputValue(input, '#40')
  })
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['编码专员'],
  )
  assert.deepEqual(
    [...document.body.querySelectorAll('.nav-item-sub .nav-item-label')].map((el) => el.textContent),
    ['重构方案'],
    '按 #id 过滤自动展开并仅显示命中子会话',
  )

  // 4) 点击清空按钮：清空输入并保持聚焦与恢复全量智能体
  const clearBtn = document.body.querySelector('button.sidebar-search-clear') as HTMLButtonElement
  assert.ok(clearBtn, '有关键词时显示清空按钮')
  await act(async () => {
    clearBtn.click()
  })
  assert.equal(input.value, '', '点击清空按钮清空关键词')
  assert.ok(document.body.querySelector('.sidebar-search-input'), '清空后筛选框保持展开')
  assert.ok(document.activeElement === input, '清空后输入框保持聚焦')
  assert.deepEqual(
    [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent),
    ['个人助理', '编码专员'],
  )

  // 5) 无匹配空态与 Esc 两段式清空/收起
  await act(async () => {
    setInputValue(input, '毫无匹配的关键词')
  })
  assert.equal(document.body.querySelector('.sidebar-search-empty')?.textContent, 'No matching agents or topics')

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.equal(input.value, '', '首次按 Esc 先清空筛选关键词')
  assert.ok(document.body.querySelector('.sidebar-search-input'), '首次按 Esc 仍保留输入框')

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  assert.ok(document.body.querySelector('.sidebar-search-input') === null, '空输入下再按 Esc 收起筛选栏')
  assert.equal(filterBtn.getAttribute('aria-pressed'), 'false')
})

test('Sidebar 手风琴单展开：仅当前会话所属智能体展开话题子列表，切换后自动收起', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 当前会话 #1 属于 assistant：默认仅它展开话题子列表
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅一个智能体展开话题列表')
  assert.ok(lists[0]!.textContent!.includes('周末计划'), '展开的话题列表包含当前智能体的会话')
  assert.ok(lists[0]!.textContent!.includes('个人助理'), '当前话题在列表内')

  // 点击另一个智能体（编码专员）行主体：进入其待命态（不再跳进旧会话）
  const rows = [...document.body.querySelectorAll('.agent-standing-row .nav-item-main')] as HTMLButtonElement[]
  const coderRow = rows.find((r) => r.textContent!.includes('编码专员'))!
  await act(async () => {
    coderRow.click()
  })
  assert.deepEqual(
    store.openTargetCalls.map((c) => c.target),
    [{ kind: 'agent', profileId: 'coder' }],
  )
})

test('Sidebar 智能体行无折叠按钮：展开由当前目标唯一推导，待命亮父行/进会话亮子行', { timeout: 60_000 }, async () => {
  const store = makeStore()
  const api: { current: { update?: (patch: Partial<HelmStoreValue>) => void } } = { current: {} }
  render(store, e(MutableStoreSidebar, { base: store, apiRef: api }))
  await act(async () => {})

  // 折叠展开按钮已移除：展开只跟随当前目标，点击名称是唯一入口
  assert.equal(document.body.querySelectorAll('.agent-collapse-btn').length, 0, '不渲染折叠展开按钮')
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅当前目标所属智能体展开话题列表')
  assert.ok(lists[0]!.textContent!.includes('周末计划'), '展开的是当前会话所属智能体的话题')

  // 会话态：仅当前子行 nav-item-active，父站位行呈 agent-standing-row-branch 弱态
  const header = [...document.body.querySelectorAll('.agent-standing-row')]
    .find((r) => r.textContent!.includes('个人助理'))!
  assert.ok(header.className.includes('agent-standing-row-branch'), '会话态父站位行仅呈分支弱态')
  assert.ok(!header.className.includes('nav-item-active'), '会话态父站位行不点亮激活底')
  assert.equal(header.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  const sub = document.body.querySelector('.nav-item-sub.nav-item-active')
  assert.ok(sub?.textContent!.includes('个人助理'), '会话态仅当前会话子行点亮（子）')
  assert.equal(sub?.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')

  // 待命态：仅父站位行 nav-item-active，子行均不点亮
  await act(async () => {
    api.current.update!({ primaryTarget: { kind: 'agent', profileId: 'assistant' } })
  })
  const standbyHeader = [...document.body.querySelectorAll('.agent-standing-row')]
    .find((r) => r.textContent!.includes('个人助理'))!
  assert.ok(standbyHeader.className.includes('nav-item-active'), '待命态父站位行唯一点亮')
  assert.ok(!standbyHeader.className.includes('agent-standing-row-branch'), '待命态父行不带分支弱态')
  assert.equal(standbyHeader.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.ok(document.body.querySelector('.nav-item-sub.nav-item-active') === null, '待命态任何子行均不点亮')
})

test('Sidebar 话题列表展开随目标切换：切换后自动收起原智能体，无关更新不扰动', { timeout: 60_000 }, async () => {
  const store = makeStore()
  const api: { current: { update?: (patch: Partial<HelmStoreValue>) => void } } = { current: {} }
  render(store, e(MutableStoreSidebar, { base: store, apiRef: api }))
  await act(async () => {})

  // 主屏切到另一智能体的会话：其话题列表自动展开，原智能体收起
  await act(async () => {
    api.current.update!({ primaryTarget: { kind: 'conversation', conversationId: 40 } })
  })
  let lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅新目标所属智能体展开')
  assert.ok(lists[0]!.textContent!.includes('重构方案'), '展开的是编码专员的话题')
  assert.ok(!lists[0]!.textContent!.includes('周末计划'), '原智能体话题已收起')

  // 模拟 SSE 常规更新（store 引用变化、目标未变）：展开保持稳定
  await act(async () => {
    api.current.update!({ conversations: store.conversations.map((c) => ({ ...c })) })
  })
  lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '展开不随无关 store 更新变化')
  assert.ok(lists[0]!.textContent!.includes('重构方案'))
})

test('Sidebar 智能体平铺：0 会话智能体直接平铺可见，不收进折叠闲置区', { timeout: 60_000 }, async () => {
  const store = makeTestStore({
    conversations: [conv({ id: 1, title: '个人助理', profileId: 'assistant' })],
    profiles: [
      { id: 'assistant', name: '个人助理' },
      { id: 'coder', name: '编码专员' },
      { id: 'writer', name: '写作助手' },
    ],
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
  render(store, e(Sidebar))
  await act(async () => {})

  assert.ok(document.body.querySelector('.sidebar-idle-group') === null, '不渲染闲置智能体折叠区')
  const labels = [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent)
  assert.deepEqual(labels, ['个人助理', '编码专员', '写作助手'], '0 会话智能体与活跃智能体稳定平铺在同一列表')
})

test('Sidebar 分屏协同展开与焦点高亮：双不同智能体均展开，主/分屏焦点切换同步高亮与主/分微标', { timeout: 60_000 }, async () => {
  const base = makeStore()
  const store: HelmStoreValue = {
    ...base,
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'conversation', conversationId: 40 },
    focusedPanel: 'primary',
  }
  const api: { current: { update?: (patch: Partial<HelmStoreValue>) => void } } = { current: {} }
  render(store, e(MutableStoreSidebar, { base: store, apiRef: api }))
  await act(async () => {})

  // 双不同智能体（assistant 与 coder）均展开话题列表，且站位父行均为分支弱态
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 2, '分屏打开两个不同智能体会话时双方均展开')
  const standingRows = [...document.body.querySelectorAll('.agent-standing-row')]
  assert.equal(standingRows.filter((r) => r.className.includes('agent-standing-row-branch')).length, 2)
  assert.equal(standingRows.filter((r) => r.className.includes('nav-item-active')).length, 0)

  const findConvRow = (title: string) =>
    [...document.body.querySelectorAll('.nav-item-sub')].find((el) =>
      el.querySelector('.nav-item-label')?.textContent === title,
    )!

  // 1) 主屏聚焦：会话 1 获 .nav-item-active.nav-item-focused + 「主」；会话 40 获 .nav-item-split + 「分」
  const conv1Primary = findConvRow('个人助理')
  const conv40Primary = findConvRow('重构方案')
  assert.ok(conv1Primary.className.includes('nav-item-active'))
  assert.ok(conv1Primary.className.includes('nav-item-focused'))
  assert.equal(conv1Primary.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(conv1Primary.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.ok(conv40Primary.className.includes('nav-item-split'))
  assert.ok(!conv40Primary.className.includes('nav-item-active'))
  assert.ok(!conv40Primary.className.includes('nav-item-focused'))
  assert.equal(conv40Primary.querySelector('.nav-item-main')?.getAttribute('aria-current'), null)
  assert.equal(conv40Primary.querySelector('.nav-pane-tag')?.textContent, 'Split')

  // 2) 焦点切到分屏：会话 40 切换为 .nav-item-active.nav-item-focused，会话 1 切换为 .nav-item-split；「主」「分」微标位置不变
  await act(async () => {
    api.current.update!({ focusedPanel: 'split' })
  })
  const conv1Split = findConvRow('个人助理')
  const conv40Split = findConvRow('重构方案')
  assert.ok(conv1Split.className.includes('nav-item-split'))
  assert.ok(!conv1Split.className.includes('nav-item-active'))
  assert.ok(!conv1Split.className.includes('nav-item-focused'))
  assert.equal(conv1Split.querySelector('.nav-pane-tag')?.textContent, 'Main')
  assert.ok(conv40Split.className.includes('nav-item-active'))
  assert.ok(conv40Split.className.includes('nav-item-focused'))
  assert.equal(conv40Split.querySelector('.nav-item-main')?.getAttribute('aria-current'), 'page')
  assert.equal(conv40Split.querySelector('.nav-pane-tag')?.textContent, 'Split')
})

test('Sidebar Rail 底部语言按钮紧邻主题按钮：三态菜单（auto/en/zh-CN），切换经 setLocalePreference（及 setLocale 兜底）且展示随 locale', { timeout: 60_000 }, async () => {
  const prefCalls: string[] = []
  const setLocaleCalls: string[] = []
  const base = makeStore()
  const store: HelmStoreValue = {
    ...base,
    locale: 'en',
    localePreference: 'auto',
    setLocalePreference: (pref) => { prefCalls.push(pref) },
    setLocale: (locale) => { setLocaleCalls.push(locale) },
  }
  const api = { current: {} as { update?: (patch: Partial<HelmStoreValue>) => void } }
  render(store, e(MutableStoreSidebar, { base: store, apiRef: api }))
  await act(async () => {})

  // 语言按钮位于 .activity-rail-footer 中紧邻 .sidebar-theme-toggle，不再放在 .sidebar-header
  const railFooter = document.body.querySelector('.activity-rail-footer')
  assert.ok(railFooter, 'Rail 底部区域应存在')
  const trigger = railFooter.querySelector('button.sidebar-locale-toggle') as HTMLButtonElement | null
  const themeBtn = railFooter.querySelector('button.sidebar-theme-toggle') as HTMLButtonElement | null
  assert.ok(trigger, 'Rail 底部应渲染语言切换按钮')
  assert.ok(themeBtn, 'Rail 底部应渲染主题切换按钮')
  assert.ok(document.body.querySelector('.sidebar-header .sidebar-locale-select') === null, '侧栏顶部不再渲染旧的语言 Select')
  assert.equal(trigger.getAttribute('aria-label'), 'Interface language')
  assert.equal(trigger.getAttribute('title'), 'Interface language (Auto)')

  // 键盘打开 Radix DropdownMenu，包含 Auto / English / 简体中文 三个选项
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[]
  assert.ok(items.some((el) => el.textContent?.includes('Auto')), '含 Auto 选项')
  assert.ok(items.some((el) => el.textContent?.includes('English')), '含 English 选项')
  assert.ok(items.some((el) => el.textContent?.includes('简体中文')), '含 简体中文 选项')
  const zhOption = items.find((el) => el.dataset.localeOption === 'zh-CN')
  assert.ok(zhOption, '下拉菜单中应包含 简体中文 项')

  await act(async () => {
    zhOption!.click()
  })
  assert.deepEqual(prefCalls, ['zh-CN'], '切换语言优先走 store.setLocalePreference')

  // store 更新为手动 zh-CN 后，触发器 title、aria-label 及侧栏文案随 locale 立即切换
  act(() => { api.current.update!({ locale: 'zh-CN', localePreference: 'zh-CN' }) })
  const triggerAfter = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.ok(triggerAfter)
  assert.equal(triggerAfter.getAttribute('aria-label'), '界面语言')
  assert.equal(triggerAfter.getAttribute('title'), '界面语言 (简体中文)')
  assert.ok(document.body.textContent?.includes('会话'), '侧栏空间标题随 locale 切换为中文')

  // 切回 auto + zh-CN：title 展示「界面语言 (自动)」
  act(() => { api.current.update!({ locale: 'zh-CN', localePreference: 'auto' }) })
  const triggerAutoZh = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.equal(triggerAutoZh?.getAttribute('title'), '界面语言 (自动)')

  // 当 test double 未提供 setLocalePreference 时，回落到 store.setLocale
  act(() => { api.current.update!({ locale: 'en', localePreference: 'en', setLocalePreference: undefined }) })
  const triggerFallback = document.body.querySelector('.activity-rail-footer button.sidebar-locale-toggle') as HTMLButtonElement | null
  assert.equal(triggerFallback?.getAttribute('title'), 'Interface language (English)')
  await act(async () => {
    triggerFallback!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const zhOpt2 = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => (el as HTMLElement).dataset.localeOption === 'zh-CN') as HTMLElement
  await act(async () => {
    zhOpt2.click()
  })
  assert.deepEqual(setLocaleCalls, ['zh-CN'], '无 setLocalePreference 时回落到 store.setLocale')
})

test('CommandPaletteModal 与 ScreenHost 双语本地化及语言循环命令（Auto -> English -> 简体中文）', { timeout: 60_000 }, async () => {
  const prefCalls: string[] = []
  const store = makeTestStore({
    locale: 'zh-CN',
    localePreference: 'auto',
    activeModal: { kind: 'command-palette' },
    setLocalePreference: (pref) => { prefCalls.push(pref) },
  })
  render(store, e(CommandPaletteModal, { onClose: () => {} }))
  await act(async () => {})

  const dialog = document.querySelector('.modal[aria-label="命令面板与全局搜索"]')
  assert.ok(dialog, 'zh-CN 下命令面板标题与搜索框使用中文文案')
  const searchInput = dialog.querySelector('input') as HTMLInputElement
  assert.equal(searchInput.placeholder, '搜索消息正文、跳转会话或执行命令...')
  assert.ok(dialog.textContent?.includes('新建会话'), '命令条目随 locale 本地化')
  assert.ok(dialog.textContent?.includes('打开插件中心'), '导航命令条目随 locale 本地化')

  // 点击语言切换命令：auto -> en
  const langRowAuto = [...dialog.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('切换语言为 English'),
  )
  assert.ok(langRowAuto, 'auto 模式下应提供切换语言为 English 命令')
  await act(async () => { langRowAuto!.click() })
  assert.deepEqual(prefCalls, ['en'])

  // en -> zh-CN
  render(
    makeTestStore({
      locale: 'en',
      localePreference: 'en',
      activeModal: { kind: 'command-palette' },
      setLocalePreference: (pref) => { prefCalls.push(pref) },
    }),
    e(CommandPaletteModal, { onClose: () => {} }),
  )
  await act(async () => {})
  const langRowEn = [...document.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('Switch language to 简体中文'),
  )
  assert.ok(langRowEn, 'en 模式下应提供 Switch language to 简体中文 命令')
  await act(async () => { langRowEn!.click() })
  assert.deepEqual(prefCalls, ['en', 'zh-CN'])

  // zh-CN -> auto
  render(
    makeTestStore({
      locale: 'zh-CN',
      localePreference: 'zh-CN',
      activeModal: { kind: 'command-palette' },
      setLocalePreference: (pref) => { prefCalls.push(pref) },
    }),
    e(CommandPaletteModal, { onClose: () => {} }),
  )
  await act(async () => {})
  const langRowZh = [...document.querySelectorAll<HTMLElement>('[data-idx].nav-item')].find((el) =>
    el.textContent?.includes('切换语言为自动（跟随浏览器）'),
  )
  assert.ok(langRowZh, 'zh-CN 模式下应提供切换语言为自动命令')
  await act(async () => { langRowZh!.click() })
  assert.deepEqual(prefCalls, ['en', 'zh-CN', 'auto'])

  // ScreenHost 缺失视图在 zh-CN 下使用本地化文案
  render(
    makeTestStore({
      locale: 'zh-CN',
      primaryTarget: { kind: 'screen', pluginId: 'ext:missing', screenId: 'overview' },
    }),
    e(ScreenHost, { pluginId: 'ext:missing', screenId: 'overview' }),
  )
  await act(async () => {})
  assert.ok(document.body.textContent?.includes('未找到视图 ext:missing/overview'))
  assert.ok(document.body.textContent?.includes('该视图不存在或所属插件已停用（ext:missing/overview）'))
})

test('Sidebar 移动端展开未展开智能体时不关闭抽屉，再点已展开行或子会话才关闭', { timeout: 60_000 }, async () => {
  const store = makeStore()
  const api: { current: { update?: (patch: Partial<HelmStoreValue>) => void } } = { current: {} }
  let closeCount = 0
  let shellBubbleCount = 0
  const baseOpenTarget = store.openTarget
  store.openTarget = (target, opts) => {
    baseOpenTarget(target, opts)
    if (typeof target !== 'string' && !opts?.split) {
      api.current.update?.({ primaryTarget: target })
    }
  }
  render(
    store,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) {
            shellBubbleCount += 1
          }
        },
      },
      e(MutableStoreSidebar, {
        base: store,
        apiRef: api,
        onClose: () => { closeCount += 1 },
      }),
    ),
  )
  await act(async () => {})

  // 1) 点击处于收起态且有历史会话的「编码专员」：展开其会话列表，但既不调用 onClose 也不冒泡到外层 .nav-item 关闭抽屉
  const coderBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.agent-standing-row .nav-item-main')]
    .find((el) => el.textContent?.includes('编码专员'))!
  await act(async () => {
    coderBtn.click()
  })
  assert.equal(closeCount, 0, '点击收起智能体展开会话列表时保持移动端抽屉打开')
  assert.equal(shellBubbleCount, 0, '不冒泡触发外层 .nav-item 关抽屉逻辑')
  assert.ok(document.body.querySelector('.agent-conversations-list')?.textContent?.includes('重构方案'), '展开后可见其会话列表')

  // 2) 点击已展开智能体下的具体子会话：导航并触发抽屉关闭
  const subBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.nav-item-sub .nav-item-main')]
    .find((el) => el.textContent?.includes('重构方案'))!
  await act(async () => {
    subBtn.click()
  })
  assert.equal(shellBubbleCount, 1, '选择具体会话后冒泡触发外层关闭抽屉')
  assert.deepEqual(store.openTargetCalls.at(-1)?.target, { kind: 'conversation', conversationId: 40 })

  // 3) 再次点击已展开的「编码专员」本身（进入待命撰写）：触发 onClose 与关闭抽屉
  const expandedCoderBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.agent-standing-row .nav-item-main')]
    .find((el) => el.textContent?.includes('编码专员'))!
  await act(async () => {
    expandedCoderBtn.click()
  })
  assert.equal(closeCount, 1, '再次点击已展开智能体进入待命时关闭抽屉')
})

test('Sidebar 批量模式 DOM 行为：勾选框仅在会话子项，站位头部行仅切换子列表展开且不关抽屉', { timeout: 60_000 }, async () => {
  const store = makeStore()
  let shellBubbleCount = 0
  render(
    store,
    e(
      'div',
      {
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          if ((event.target as HTMLElement).closest('.nav-item')) {
            shellBubbleCount += 1
          }
        },
      },
      e(HostStoreProviders, { value: store }, e(Sidebar)),
    ),
  )
  await act(async () => {})

  const bulkBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Manage conversations in bulk"]')!
  assert.ok(bulkBtn, '批量管理开关按钮存在')
  await act(async () => {
    bulkBtn.click()
  })

  const standingRows = [...document.body.querySelectorAll('.agent-standing-row')]
  assert.equal(standingRows.length, 2, '渲染两个智能体站位行')
  for (const row of standingRows) {
    assert.equal(
      row.querySelectorAll('.sidebar-batch-checkbox, [role="checkbox"], input[type="checkbox"]').length,
      0,
      '智能体站位行不得渲染任何勾选框',
    )
  }

  const subRows = [...document.body.querySelectorAll('.nav-item-sub')]
  assert.equal(subRows.length, 4, '批量模式展开全部智能体的会话子行')
  for (const sub of subRows) {
    assert.ok(sub.querySelector('.sidebar-batch-checkbox'), '每条会话子行都有批量勾选框')
  }

  // 点击第二个智能体站位行（编码专员）：仅折叠其子列表，不导航也不冒泡触发外层关抽屉
  const coderStanding = [...document.body.querySelectorAll('.agent-standing')].find((el) =>
    el.querySelector('.agent-standing-row')?.textContent?.includes('编码专员'),
  )!
  assert.ok(coderStanding.querySelector('.agent-conversations-list'), '点击前编码专员子列表已展开')
  const coderHeaderBtn = coderStanding.querySelector<HTMLButtonElement>('.agent-standing-row .nav-item-main')!
  await act(async () => {
    coderHeaderBtn.click()
  })
  assert.ok(coderStanding.querySelector('.agent-conversations-list') === null, '点击站位头部行折叠其会话子列表')
  assert.equal(store.openTargetCalls.length, 0, '批量模式下点击站位头部不触发路由跳转')
  assert.equal(shellBubbleCount, 0, '批量模式下点击站位头部不冒泡关闭抽屉')

  // 再次点击重新展开
  await act(async () => {
    coderHeaderBtn.click()
  })
  assert.ok(coderStanding.querySelector('.agent-conversations-list'), '再次点击站位头部重新展开会话子列表')
})
