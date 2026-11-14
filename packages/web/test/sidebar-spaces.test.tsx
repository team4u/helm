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
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, spaceForTarget, type HelmStoreValue, type ResolvedTarget, type SidebarSpace } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
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
  return e(HelmStoreContext.Provider, { value: store }, e(Sidebar))
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
  return e(HelmStoreContext.Provider, { value: store }, e(Sidebar))
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
  root.render(e(HelmStoreContext.Provider, { value: store }, element))
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
  const viewsBtn = body.querySelector('button[aria-label="视图空间"]') as HTMLButtonElement
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
  const settingsBtn = document.body.querySelector('button[aria-label="设置空间"]') as HTMLButtonElement
  assert.ok(settingsBtn, '设置空间按钮存在')
  await act(async () => {
    settingsBtn.click()
  })
  assert.ok(document.body.querySelector('.settings-nav'), '设置空间渲染系统中心列表')

  // 点击插件中心列表项（行主体 nav-item-main）
  const items = [...document.body.querySelectorAll('.settings-nav-item .nav-item-main')] as HTMLButtonElement[]
  const pluginsItem = items.find((el) => el.textContent!.includes('插件中心'))
  assert.ok(pluginsItem, '插件中心设置项存在')
  await act(async () => {
    pluginsItem!.click()
  })
  assert.deepEqual(store.openTargetCalls, [{ target: { kind: 'plugins' }, split: undefined }])
})

test('Sidebar 智能体搜索：输入关键字过滤智能体行', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  const input = document.body.querySelector('.sidebar-search-input') as HTMLInputElement
  assert.ok(input, '搜索输入存在')
  await act(async () => {
    setInputValue(input, '编码')
  })
  assert.ok(document.body.textContent!.includes('编码专员'), '命中智能体保留')
  assert.ok(!document.body.textContent!.includes('个人助理</span>'), '未命中智能体过滤')

  // 命中智能体点击行主体进入待命态（名称是稳定入口，首次发送才落库）
  const row = document.body.querySelector('.agent-standing .nav-item-main') as HTMLButtonElement
  await act(async () => {
    row.click()
  })
  const call = store.openTargetCalls[0]
  assert.deepEqual(call?.target, { kind: 'agent', profileId: 'coder' })
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

test('Sidebar 智能体行无折叠按钮：展开由当前目标唯一推导', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  // 折叠展开按钮已移除：展开只跟随当前目标，点击名称是唯一入口
  assert.equal(document.body.querySelectorAll('.agent-collapse-btn').length, 0, '不渲染折叠展开按钮')
  const lists = document.body.querySelectorAll('.agent-conversations-list')
  assert.equal(lists.length, 1, '仅当前目标所属智能体展开话题列表')
  assert.ok(lists[0]!.textContent!.includes('周末计划'), '展开的是当前会话所属智能体的话题')

  // 父强子弱（参考 magpie）：站位行（父）与当前会话子行（子）同时点亮
  const header = [...document.body.querySelectorAll('.agent-standing-row')]
    .find((r) => r.textContent!.includes('个人助理'))!
  assert.ok(header.className.includes('nav-item-active'), '当前会话所属智能体站位行点亮（父）')
  const sub = document.body.querySelector('.nav-item-sub.nav-item-active')
  assert.ok(sub?.textContent!.includes('个人助理'), '当前会话子行同时点亮（子）')
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

  assert.equal(document.body.querySelector('.sidebar-idle-group'), null, '不渲染闲置智能体折叠区')
  const labels = [...document.body.querySelectorAll('.agent-standing-row .nav-item-label')].map((el) => el.textContent)
  assert.deepEqual(labels, ['个人助理', '编码专员', '写作助手'], '0 会话智能体与活跃智能体稳定平铺在同一列表')
})

