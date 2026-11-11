/**
 * 双层导航与话题切换器交互测试（happy-dom + 真实 React 事件）：
 * - Sidebar：对话/视图空间切换、搜索过滤智能体、智能体行导航；
 * - TopicPicker：打开 Popover、搜索话题、切换主屏/分屏目标。
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
const { TopicPicker } = await import('../src/conversation/conversation-topic-picker.js')

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

test('Sidebar 系统中心直达：Rail 点击插件中心调用 openTarget', { timeout: 60_000 }, async () => {
  const store = makeStore()
  render(store, e(Sidebar))
  await act(async () => {})

  const pluginsBtn = document.body.querySelector('button[aria-label="插件中心"]') as HTMLButtonElement
  assert.ok(pluginsBtn, '插件中心 Rail 按钮存在')
  await act(async () => {
    pluginsBtn.click()
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

  // 普通模式：智能体行点击打开主会话，不渲染会话子树
  assert.ok(!document.body.querySelector('.agent-conversations-list'), '普通模式无会话子树')
  const row = document.body.querySelector('.agent-standing .nav-item-main') as HTMLButtonElement
  await act(async () => {
    row.click()
  })
  const call = store.openTargetCalls[0]
  assert.deepEqual(call?.target, { kind: 'conversation', conversationId: 40 })
})

test('TopicPicker 交互：打开 Popover、搜索并切换主屏目标', { timeout: 60_000 }, async () => {
  const store = makeStore()
  const conversation = store.conversations[0]!
  render(store, e(TopicPicker, { conversation }))
  await act(async () => {})

  const trigger = document.body.querySelector('.topic-picker-trigger') as HTMLButtonElement
  assert.ok(trigger, '触发器存在')
  assert.ok(trigger.textContent!.includes('个人助理'), '触发器展示当前话题身份')

  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  const searchInput = document.body.querySelector('.topic-picker-search-input') as HTMLInputElement
  assert.ok(searchInput, 'Popover 打开后渲染搜索框')

  // 当前项激活态：#1 是当前话题
  const activeItem = document.body.querySelector('.topic-picker-item-active') as HTMLElement
  assert.ok(activeItem, '当前话题有激活态')
  assert.ok(activeItem.textContent!.includes('个人助理'), '激活项为当前话题')

  // 搜索并切换
  await act(async () => {
    setInputValue(searchInput, '周末')
  })
  const items = [...document.body.querySelectorAll('.topic-picker-item')] as HTMLElement[]
  assert.equal(items.length, 1, '搜索过滤后仅剩一项')
  await act(async () => {
    items[0]!.click()
  })
  assert.deepEqual(store.openTargetCalls, [{ target: { kind: 'conversation', conversationId: 10 }, split: undefined }])
})

test('TopicPicker 分屏窗格：切换写入 split 目标', { timeout: 60_000 }, async () => {
  const store = makeStore()
  const conversation = store.conversations[0]!
  render(store, e(TopicPicker, { conversation, isSplit: true }))
  await act(async () => {})

  const trigger = document.body.querySelector('.topic-picker-trigger') as HTMLButtonElement
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  const item = document.body.querySelector('.topic-picker-item:not(.topic-picker-item-active)') as HTMLElement
  assert.ok(item, '存在其他可切换话题')
  await act(async () => {
    item.click()
  })
  assert.deepEqual(store.openTargetCalls.map((c) => c.split), [true])
})
