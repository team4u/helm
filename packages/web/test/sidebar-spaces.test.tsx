/**
 * 双层导航与话题切换器交互测试（happy-dom + 真实 React 事件）：
 * - Sidebar：对话/视图空间切换、搜索过滤智能体、智能体行导航；
 * - 手风琴单展开：仅当前智能体展开话题子列表，切换智能体自动收起。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary, PluginUiContribution } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue, type ResolvedTarget } from '../src/lib/types.js'
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
  render(store, e(Sidebar))
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
  render(store, e(Sidebar))
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

  // 命中智能体点击行主体打开主会话
  const row = document.body.querySelector('.agent-standing .nav-item-main') as HTMLButtonElement
  await act(async () => {
    row.click()
  })
  const call = store.openTargetCalls[0]
  assert.deepEqual(call?.target, { kind: 'conversation', conversationId: 40 })
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

  // 点击另一个智能体（编码专员）行主体：切换主会话并自动收起上一个
  const rows = [...document.body.querySelectorAll('.agent-standing-row .nav-item-main')] as HTMLButtonElement[]
  const coderRow = rows.find((r) => r.textContent!.includes('编码专员'))!
  await act(async () => {
    coderRow.click()
  })
  assert.deepEqual(
    store.openTargetCalls.map((c) => c.target),
    [{ kind: 'conversation', conversationId: 40 }],
  )
})

test('Sidebar 闲置智能体收纳：0 会话智能体进折叠区，默认不占主视野', { timeout: 60_000 }, async () => {
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

  // 0 会话的 coder/writer 收进折叠区，默认收起不占主视野
  const idle = document.body.querySelector('.sidebar-idle-group') as HTMLElement
  assert.ok(idle, '闲置智能体折叠区存在')
  assert.ok(idle.textContent!.includes('闲置智能体'), '折叠区标题')
  assert.ok(!idle.textContent!.includes('编码专员'), '收起时不平铺闲置智能体行')

  // 展开：平铺闲置智能体行（单行，无子列表）
  const toggle = idle.querySelector('.sidebar-idle-toggle') as HTMLButtonElement
  await act(async () => {
    toggle.click()
  })
  assert.ok(idle.textContent!.includes('编码专员'), '展开后显示闲置智能体')
  assert.ok(idle.textContent!.includes('写作助手'), '展开后显示全部闲置智能体')
})

