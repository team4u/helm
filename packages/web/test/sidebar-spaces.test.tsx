/**
 * 双层导航与话题切换器交互测试（happy-dom + 真实 React 事件）：
 * - Sidebar：对话/Views space切换、搜索过滤智能体、智能体行导航；
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
import { HostStoreProviders } from './helpers/host-store.js'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// happy-dom 全局就绪后再加载 react-dom/client（静态导入会捕获注册前的 Node 全局）
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
;(globalThis as Record<string, unknown>).React = React
const { Sidebar } = await import('../src/shell/Sidebar.js')

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
}: {
  base: HelmStoreValue
  apiRef: { current: { update?: (patch: Partial<HelmStoreValue>) => void } }
}): React.ReactElement {
  const [store, setStore] = React.useState<HelmStoreValue>(base)
  apiRef.current.update = (patch) => setStore((current) => ({ ...current, ...patch }))
  return e(HostStoreProviders, { value: store }, e(Sidebar))
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

test('Sidebar 空间切换：对话空间默认渲染智能体，Views space渲染 screen 贡献', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(SpaceAwareSidebar, { base: store }))
  await act(async () => {})

  const body = document.body
  assert.ok(body.querySelector('.activity-rail'), '应渲染 Activity Rail')
  assert.ok(body.textContent!.includes('个人助理'), '对话空间渲染智能体行')
  assert.ok(!body.textContent!.includes('Herdr 终端'), '默认不渲染Views space项')

  // 切换到Views space
  const viewsBtn = body.querySelector('button[aria-label="Views space"]') as HTMLButtonElement
  assert.ok(viewsBtn, 'Views space切换按钮存在')
  await act(async () => {
    viewsBtn.click()
  })
  assert.ok(body.textContent!.includes('Herdr 终端'), 'Views space渲染 screen 贡献')
  assert.ok(!body.textContent!.includes('个人助理'), 'Views space不渲染智能体分组')
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

