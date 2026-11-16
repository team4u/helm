/**
 * Composer / Standby pi 单键快捷键、队列撤回、Ctrl+L 跨组件联动、
 * COMPOSER_DOCK_SLOT 与移动端双按钮单元测试。
 *
 * 严格遵循一功能一快捷键与单键肌肉记忆，测试覆盖：
 * 1. keybindings-model 纯逻辑（Shift+Tab / ↑ / Enter / Mod+Enter / panel 匹配 / 索引循环，无多键别名）；
 * 2. Ctrl+L（helm:shortcut）分屏精准路由 + 搜索框 autoFocus + ↑↓Enter 选型 + Esc 焦点回还 + 无冒泡阻断；
 * 3. Shift+Tab 立即 preventDefault() 并循环切换 thinkingLevel（不响应 Ctrl+T 别名）；
 * 4. ↑（空草稿且位于首行）优先从 live.queuedInputs 撤回最新人类排队项并回填（不触发历史警告），
 *    无人类排队项时才回退历史编辑，拒绝 Alt+Up 别名；
 * 5. Esc 层级优先级（关闭浮层 + stopPropagation -> 取消编辑态 + stopPropagation -> 交外层双 Esc）；
 * 6. COMPOSER_DOCK_SLOT 直出在 <AskDock /> 正上方并传递 ComposerScopeProps（不收进移动端 more 菜单）；
 * 7. 移动端（<=680px）忙时显式渲染 [插话] + [排队] 双按钮，桌面端角标统一携带 .kbd-hint；
 * 8. Standby 待命页全局默认模型继承、Shift+Tab、Ctrl+L 与静态 '/' 技能补全；
 * 9. 零 Emoji 与 Fast Refresh 检查。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { ensureHappyDom, jsonResponse } from './helpers/dom-harness.js'
import type {
  ComposerScopeProps,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  Profile,
  QueuedConversationInput,
  SkillSummary,
} from '@helm/protocol'
import { COMPOSER_DOCK_SLOT } from '@helm/protocol'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  canRecallOnArrowUp,
  HELM_SHORTCUT_EVENT,
  initialModelActiveIndex,
  isCaretAtFirstLine,
  isComposerSubmitEnterEvent,
  isPlainArrowUpEvent,
  isShiftTabEvent,
  isShortcutPanelMatch,
  latestHumanQueuedInput,
  nextThinkingLevel,
  resolveEffectiveThinkingLevel,
  resolveElementPanel,
  stepActiveIndex,
} from '../src/conversation/keybindings-model.js'
import { resolveStandbyEffectiveModel, resolveStandbyThinkingLevel, resetStandbyDrafts } from '../src/conversation/standby-model.js'

ensureHappyDom()

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { conversationsApi, assetsApi } = await import('../src/lib/api.js')
const { seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { usePluginContext } = await import('@helm/plugin-client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { makeTestStore } = await import('./helpers/store.js')
const { Composer } = await import('../src/conversation/Composer.js')
const { ComposerSendControls } = await import('../src/conversation/ComposerSendControls.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. 纯逻辑测试：keybindings-model
// ---------------------------------------------------------------------------

test('keybindings-model：一功能一快捷键严格匹配，禁止 Alt+Up / Alt+Enter / Ctrl+T 别名', { timeout: 60_000 }, () => {
  const base = { key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }

  assert.equal(isShiftTabEvent({ ...base, key: 'Tab', shiftKey: true }), true)
  assert.equal(isShiftTabEvent({ ...base, key: 'Tab' }), false)
  assert.equal(isShiftTabEvent({ ...base, key: 't', ctrlKey: true }), false, '禁止 Ctrl+T 别名')
  assert.equal(isShiftTabEvent({ ...base, key: 'Tab', shiftKey: true, ctrlKey: true }), false)

  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp' }), true)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', altKey: true }), false, '禁止 Alt+Up 别名')
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', ctrlKey: true }), false)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', metaKey: true }), false)
  assert.equal(isPlainArrowUpEvent({ ...base, key: 'ArrowUp', shiftKey: true }), false)

  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: false, altKey: false }), true)
  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: true, altKey: false }), false, 'Shift+Enter 仅换行')
  assert.equal(isComposerSubmitEnterEvent({ key: 'Enter', shiftKey: false, altKey: true }), false, '禁止 Alt+Enter 别名')
})

test('keybindings-model：canRecallOnArrowUp 仅空草稿且位于首行放行', { timeout: 60_000 }, () => {
  assert.equal(isCaretAtFirstLine('', 0), true)
  assert.equal(isCaretAtFirstLine('hello', 3), true)
  assert.equal(isCaretAtFirstLine('line1\nline2', 6), false)
  assert.equal(canRecallOnArrowUp('', 0), true)
  assert.equal(canRecallOnArrowUp('', null), true)
  assert.equal(canRecallOnArrowUp('draft', 0), false)
  assert.equal(canRecallOnArrowUp('\nsecond', 1), false)
})

test('keybindings-model：latestHumanQueuedInput 忽略 agent/trigger 并取最新人类排队项', { timeout: 60_000 }, () => {
  const q = (id: string, sub: string, origin: QueuedConversationInput['origin'], createdAt: number): QueuedConversationInput => ({
    id, submissionId: sub, text: `msg-${id}`, mode: 'followUp', origin, createdAt,
  })
  assert.equal(latestHumanQueuedInput(undefined), undefined)
  assert.equal(latestHumanQueuedInput([]), undefined)
  assert.equal(latestHumanQueuedInput([q('a1', '1', 'agent', 10), q('t1', '2', 'trigger', 20)]), undefined)

  // 不同时间取 createdAt 最大的人类输入，忽略更新的 agent 项
  const picked = latestHumanQueuedInput([
    q('h1', '10', 'human', 100),
    q('h2', '11', 'human', 200),
    q('a1', '12', 'agent', 300),
  ])
  assert.equal(picked?.id, 'h2')

  // createdAt 相等时取队尾项
  const tiePicked = latestHumanQueuedInput([
    q('h1', '10', 'human', 50),
    q('h2', '11', 'human', 50),
  ])
  assert.equal(tiePicked?.id, 'h2')
})

test('keybindings-model：nextThinkingLevel 循环步进与不支持思考时的保护', { timeout: 60_000 }, () => {
  const levels = ['off', 'low', 'medium', 'high']
  assert.equal(nextThinkingLevel(levels, 'off'), 'low')
  assert.equal(nextThinkingLevel(levels, 'low'), 'medium')
  assert.equal(nextThinkingLevel(levels, 'high'), 'off', '到达末尾回绕至首项')
  assert.equal(nextThinkingLevel(levels, 'unknown'), 'off')
  assert.equal(nextThinkingLevel(['off'], 'off'), null)
  assert.equal(nextThinkingLevel([], 'off'), null)
  assert.equal(resolveEffectiveThinkingLevel(['minimal', 'high'], 'max'), 'minimal')
})

test('keybindings-model：initialModelActiveIndex / stepActiveIndex 与面板匹配', { timeout: 60_000 }, () => {
  const items = [{ id: 'a/1' }, { id: 'b/2' }, { id: 'c/3' }]
  assert.equal(initialModelActiveIndex(items, 'b/2'), 1)
  assert.equal(initialModelActiveIndex(items, 'missing'), 0)
  assert.equal(initialModelActiveIndex([], 'a/1'), -1)
  assert.equal(stepActiveIndex(2, 3, 1), 0)
  assert.equal(stepActiveIndex(0, 3, -1), 2)

  const splitWrap = document.createElement('div')
  splitWrap.setAttribute('data-helm-panel', 'split')
  const child = document.createElement('span')
  splitWrap.appendChild(child)
  assert.equal(resolveElementPanel(child), 'split')
  assert.equal(isShortcutPanelMatch(child, 'split'), true)
  assert.equal(isShortcutPanelMatch(child, 'primary'), false)

  const drawer = document.createElement('div')
  drawer.className = 'conversation-drawer'
  const drawerChild = document.createElement('span')
  drawer.appendChild(drawerChild)
  assert.equal(isShortcutPanelMatch(drawerChild, 'primary'), false, '抽屉内未挂 data-helm-panel 不误响主屏快捷键')
})

// ---------------------------------------------------------------------------
// 测试夹具与清理
// ---------------------------------------------------------------------------

const originalPatch = conversationsApi.patch
const originalSubmitInput = conversationsApi.submitInput
const originalWithdraw = conversationsApi.withdraw
const originalAbort = conversationsApi.abort
const originalGetDefaultModel = assetsApi.getDefaultModel
const originalMatchMedia = window.matchMedia

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = []

afterEach(() => {
  for (const item of mountedRoots.splice(0)) {
    act(() => {
      item.root.unmount()
    })
    item.host.remove()
  }
  document.body.innerHTML = ''
  conversationsApi.patch = originalPatch
  conversationsApi.submitInput = originalSubmitInput
  conversationsApi.withdraw = originalWithdraw
  conversationsApi.abort = originalAbort
  assetsApi.getDefaultModel = originalGetDefaultModel
  window.matchMedia = originalMatchMedia
  resetStandbyDrafts()
})

function makeConv(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 1,
    title: '测试会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/m2',
    thinkingLevel: 'off',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeModels() {
  return [
    { id: 'faux/m1', provider: 'faux', modelId: 'm1', available: true, thinkingLevels: ['off', 'low', 'high'] },
    { id: 'faux/m2', provider: 'faux', modelId: 'm2', available: true, thinkingLevels: ['off', 'low', 'medium', 'high'] },
    { id: 'faux/m3', provider: 'faux', modelId: 'm3', available: true, thinkingLevels: ['off', 'max'] },
  ]
}

function mountTree(node: React.ReactNode, panel?: 'primary' | 'split'): HTMLElement {
  const host = document.createElement('div')
  if (panel !== undefined) host.setAttribute('data-helm-panel', panel)
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  mountedRoots.push({ root, host })
  return host
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function stubMatchMedia(isMobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 680px') ? isMobile : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// ---------------------------------------------------------------------------
// 2. Ctrl+L 跨组件联动 + 搜索框 autoFocus + 键盘选型 + Esc 回传焦点
// ---------------------------------------------------------------------------

test('Ctrl+L：分屏匹配 data-helm-panel 精准开关 ModelPicker，自动聚焦搜索框并支持 ↑↓Enter 选型', { timeout: 60_000 }, async () => {
  const patched: Array<{ id: number; body: Record<string, unknown> }> = []
  conversationsApi.patch = (async (id, body) => {
    patched.push({ id, body: body as Record<string, unknown> })
    return makeConv({ id, ...body })
  }) as typeof conversationsApi.patch

  const primaryConv = makeConv({ id: 1, model: 'faux/m2' })
  const splitConv = makeConv({ id: 2, model: 'faux/m2' })
  const store = makeTestStore({
    conversations: [primaryConv, splitConv],
    models: makeModels(),
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: { kind: 'conversation', conversationId: 2 },
  })

  const primaryHost = mountTree(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: primaryConv, prefill: null })),
    'primary',
  )
  const splitHost = mountTree(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: splitConv, prefill: null })),
    'split',
  )

  const primaryTa = primaryHost.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  const splitTa = splitHost.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // 在 textarea 上按 Ctrl+L 绝不调用 stopPropagation 阻断外层全局监听
  let bubbledToWindow = false
  const windowSpy = (ev: KeyboardEvent): void => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 'l') bubbledToWindow = true
  }
  window.addEventListener('keydown', windowSpy)
  try {
    act(() => {
      splitTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(bubbledToWindow, true, 'Composer 不吞掉或阻断 Ctrl+L 冒泡')
  } finally {
    window.removeEventListener('keydown', windowSpy)
  }

  // 全局派发 helm:shortcut (panel='split')：仅右屏 ModelPicker 打开，左屏保持关闭
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })

  assert.equal(primaryHost.querySelector('button.composer-model-button')?.getAttribute('aria-expanded'), 'false', '主屏不响应 split 快捷键')
  assert.equal(splitHost.querySelector('button.composer-model-button')?.getAttribute('aria-expanded'), 'true', '分屏 ModelPicker 打开')

  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover, 'ModelPicker 浮层已渲染')
  const searchInput = popover.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')
  assert.ok(searchInput !== null, '搜索输入框存在')
  assert.ok(document.activeElement === searchInput, '打开时自动聚焦搜索输入框（非首项重置按钮）')

  // 初始高亮指向当前模型 faux/m2（索引 1）
  const modelBtns = Array.from(popover.querySelectorAll<HTMLButtonElement>('button.popover-item[title^="faux/"]'))
  assert.equal(modelBtns.length, 3)
  assert.equal(modelBtns[1]!.classList.contains('popover-item-active'), true, '初始高亮指向当前生效模型 m2')

  // 搜索框内 ArrowDown 移动到 m3，Enter 选中关闭并调用 patch
  await act(async () => {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  assert.equal(modelBtns[2]!.classList.contains('popover-item-active'), true, 'ArrowDown 移动高亮至 m3')

  await act(async () => {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(patched.length, 1)
  assert.deepEqual(patched[0], { id: 2, body: { model: 'faux/m3' } })
  assert.ok(document.body.querySelector('.composer-model-popover') === null, 'Enter 选中后关闭浮层')
  assert.ok(document.activeElement === splitTa, '关闭后焦点归还当前面板 Composer textarea')

  // 再次 Ctrl+L 打开，再按一次 Ctrl+L 关闭并归还焦点
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') !== null)
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null, '再次 Ctrl+L 关闭浮层')
  assert.ok(document.activeElement === splitTa, 'Ctrl+L 关闭后焦点回到分屏 textarea')

  // 再次 Ctrl+L 打开并通过 Esc 关闭：必须 stopPropagation 防止触发外层双 Esc 中断，且归还焦点
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover'))

  let escLeakedToWindow = false
  const escWindowSpy = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') escLeakedToWindow = true
  }
  window.addEventListener('keydown', escWindowSpy)
  try {
    await act(async () => {
      document.body.querySelector('input[aria-label="搜索模型"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    assert.ok(document.body.querySelector('.composer-model-popover') === null, 'Esc 关闭 ModelPicker')
    assert.equal(escLeakedToWindow, false, 'ModelPicker Esc 必须 stopPropagation 防触发外层双 Esc')
    assert.ok(document.activeElement === splitTa, 'Esc 关闭后焦点回到分屏 textarea')
    assert.ok(document.activeElement !== primaryTa)
  } finally {
    window.removeEventListener('keydown', escWindowSpy)
  }
})

// ---------------------------------------------------------------------------
// 3. Shift+Tab 思考深度切换（含严格无 Ctrl+T 别名）
// ---------------------------------------------------------------------------

test('Shift+Tab：立即 preventDefault() 并循环切换 thinkingLevel；Ctrl+T 不生效', { timeout: 60_000 }, async () => {
  const patched: Array<Record<string, unknown>> = []
  conversationsApi.patch = (async (_id, body) => {
    patched.push(body as Record<string, unknown>)
    return makeConv(body)
  }) as typeof conversationsApi.patch

  const conv = makeConv({ id: 1, model: 'faux/m2', thinkingLevel: 'off' })
  const store = makeTestStore({ conversations: [conv], models: makeModels() })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Ctrl+T 不得触发思考档位切换
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
    ta.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, false)
  })
  assert.equal(patched.length, 0)

  // Shift+Tab 立即 preventDefault 并顺序循环 off -> low -> medium -> high -> off
  for (const expected of ['low', 'medium', 'high', 'off']) {
    await act(async () => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      ta.dispatchEvent(ev)
      assert.equal(ev.defaultPrevented, true, 'Shift+Tab 必须立即 preventDefault')
    })
    assert.equal(patched.at(-1)?.thinkingLevel, expected)
  }
})

// ---------------------------------------------------------------------------
// 4. ↑ 优先撤回 queuedInputs 最新人类排队项 -> 无排队时回退历史编辑
// ---------------------------------------------------------------------------

test('↑（空草稿首行）：优先撤回 queuedInputs 最新人类排队项并回填，不触发历史回滚横幅', { timeout: 60_000 }, async () => {
  const withdrawCalls: Array<{ id: number; subId: string | number }> = []
  conversationsApi.withdraw = (async (id, subId) => {
    withdrawCalls.push({ id, subId })
    return { status: 'withdrawn' }
  }) as typeof conversationsApi.withdraw

  const conv = makeConv({ id: 7, status: 'working' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [
      { id: '1', kind: 'helm.input', data: { text: '更早的历史提问', origin: 'human' } },
    ],
  }
  const live: ConversationLive = {
    conversationId: 7,
    text: '正在输出',
    tools: [],
    updatedAt: 100,
    queuedInputs: [
      { id: 'q-1', submissionId: '21', text: '第一条排队', mode: 'followUp', origin: 'human', createdAt: 10 },
      {
        id: 'q-2',
        submissionId: '22',
        text: '最新人类插话',
        mode: 'steer',
        origin: 'human',
        createdAt: 20,
        attachments: [{ id: 'art-9', name: 'spec.md', mimeType: 'text/markdown', size: 128 }],
      },
      { id: 'q-3', submissionId: '23', text: 'agent 后台汇报', mode: 'followUp', origin: 'agent', createdAt: 30 },
    ],
  }

  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 7: detail },
    conversationLives: { 7: live },
  })

  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Alt+ArrowUp 绝不触发撤回
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(withdrawCalls.length, 0, '严禁 Alt+Up 别名')

  // 草稿非空时不触发撤回
  await act(async () => {
    typeInto(ta, '正在输入的新草稿')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  assert.equal(withdrawCalls.length, 0, '非空草稿 ↑ 不撤回队列')

  // 清空草稿后按单键 ↑：撤回最新人类排队项 q-2（submissionId='22'）
  await act(async () => {
    typeInto(ta, '')
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  await act(async () => {})

  assert.deepEqual(withdrawCalls, [{ id: 7, subId: '22' }])
  assert.equal(ta.value, '最新人类插话', '回填排队消息正文')
  assert.ok(host.textContent?.includes('spec.md'), '同时回填排队附件')
  assert.ok(host.querySelector('.composer-edit-banner') === null, '撤回排队不触发历史回滚横幅')
})

test('↑（无人类排队项时）：回退编辑上一条历史人类消息', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 8, status: 'idle' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [
      { id: '5', kind: 'helm.input', data: { text: '历史提问五', origin: 'human' } },
    ],
  }
  const live: ConversationLive = {
    conversationId: 8,
    text: '',
    tools: [],
    updatedAt: 50,
    queuedInputs: [
      { id: 'q-agent', submissionId: '31', text: '仅后台触发', mode: 'followUp', origin: 'trigger', createdAt: 40 },
    ],
  }
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { 8: detail },
    conversationLives: { 8: live },
  })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '历史提问五')
  assert.ok(host.querySelector('.composer-edit-banner') !== null, '无人类排队项时回退历史编辑并显示横幅')
})

// ---------------------------------------------------------------------------
// 5. Esc 层级处理（浮层 -> 取消编辑态 -> 冒泡给外层双 Esc）
// ---------------------------------------------------------------------------

test('Esc 层级：关闭斜杠浮层与取消历史编辑均 stopPropagation，空闲无浮层时才冒泡外层', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 9, status: 'working' })
  const detail: ConversationDetail = {
    ...conv,
    entries: [{ id: '2', kind: 'helm.input', data: { text: '旧消息', origin: 'human' } }],
  }
  const store = makeTestStore({ conversations: [conv], conversationDetails: { 9: detail } })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  let windowEscCount = 0
  const onWinEsc = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') windowEscCount++
  }
  window.addEventListener('keydown', onWinEsc)
  try {
    // 1) 历史编辑态按 Esc：取消编辑且 stopPropagation
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-edit-banner') !== null)
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-edit-banner') === null, 'Esc 退出历史编辑态')
    assert.equal(ta.value, '')
    assert.equal(windowEscCount, 0, '取消编辑时 stopPropagation，不触发外层双 Esc 计数')

    // 2) 斜杠浮层打开时按 Esc：关闭浮层且 stopPropagation
    await act(async () => {
      typeInto(ta, '/')
    })
    assert.ok(host.querySelector('.composer-popover') !== null)
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-popover') === null)
    assert.equal(windowEscCount, 0, '关闭斜杠浮层时 stopPropagation')

    // 3) 无浮层且非编辑态按 Esc：正常冒泡到 window 供外层双 Esc 中断处理
    await act(async () => {
      typeInto(ta, '')
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(windowEscCount, 1, '无浮层非编辑态时 Esc 正常冒泡到外层')
  } finally {
    window.removeEventListener('keydown', onWinEsc)
  }
})

// ---------------------------------------------------------------------------
// 6. COMPOSER_DOCK_SLOT 在 <AskDock /> 正上方直出且双端可见
// ---------------------------------------------------------------------------

test('COMPOSER_DOCK_SLOT：位于 AskDock 正上方直出渲染，接收 ComposerScopeProps，移动端不收进 more 菜单', { timeout: 60_000 }, async () => {
  stubMatchMedia(true) // 模拟移动端视口
  function DockProbe(props: ComposerScopeProps) {
    const ctx = usePluginContext()
    return e(
      'div',
      { className: 'dock-probe', 'data-probe': 'dock' },
      `dock-conv:${props.conversation.id}:ctx:${ctx.composer !== undefined}`,
    )
  }
  seedPluginClientModule('builtin:workflow', 'tray.tsx', { DockProbe })

  const conv = makeConv({ id: 12, status: 'working' })
  const store = makeTestStore({
    conversations: [conv],
    pendingAsks: [
      {
        id: 'ask-1',
        conversationId: 12,
        title: '需要审批',
        fields: [],
        status: 'pending',
        createdAt: 1,
      },
    ],
    groupedUi: groupUiContributions([
      {
        pluginId: 'builtin:workflow',
        surface: 'plugin.slot',
        spec: {
          id: 'active-tray',
          target: COMPOSER_DOCK_SLOT,
          client: { module: 'tray.tsx', export: 'DockProbe' },
        },
      },
    ]),
  })

  const html = renderToStaticMarkup(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })),
  )
  const dockAt = html.indexOf('composer-dock-slot')
  const askAt = html.indexOf('ask-dock-stack')
  const extrasAt = html.indexOf('composer-extras')
  assert.ok(dockAt >= 0, 'COMPOSER_DOCK_SLOT 必须直出渲染')
  assert.ok(askAt > dockAt, 'COMPOSER_DOCK_SLOT 必须位于 AskDock 正上方')
  assert.ok(extrasAt < 0 || dockAt < extrasAt, '不得收进移动端 more 菜单')
  assert.match(html, /dock-conv:12:ctx:true/, '正确传递 ComposerScopeProps')
})

// ---------------------------------------------------------------------------
// 7. 移动端忙时双按钮 [插话] + [排队] 与桌面 .kbd-hint
// ---------------------------------------------------------------------------

test('ComposerSendControls：移动端忙时有输入显式渲染 [插话] 与 [排队] 双独立按钮；桌面端保留下拉与 .kbd-hint', { timeout: 60_000 }, async () => {
  const sent: Array<string | undefined> = []
  const send = async (mode?: 'steer' | 'followUp' | 'reject') => {
    sent.push(mode)
  }
  const abortTurn = async () => {}
  const blocker = { blocked: false, reason: null }

  // 移动端忙时：同时显式渲染 [插话] 与 [排队] 两个独立按钮，无窄缝下拉触发器
  const mobileHost = mountTree(
    e(ComposerSendControls, {
      working: true,
      editingEntryId: null,
      sending: false,
      uploading: 0,
      envBlocker: blocker,
      text: '测试指令',
      isMobile: true,
      send,
      abortTurn,
    }),
  )
  assert.ok(mobileHost.querySelector('.composer-split-trigger') === null, '移动端不渲染窄缝下拉触发器')
  const steerBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-steer-btn')
  const queueBtn = mobileHost.querySelector<HTMLButtonElement>('button.composer-mobile-queue-btn')
  assert.ok(steerBtn && steerBtn.textContent?.includes('插话'), '移动端显示 [插话] 按钮')
  assert.ok(queueBtn && queueBtn.textContent?.includes('排队'), '移动端显示 [排队] 按钮')

  await act(async () => {
    steerBtn.click()
    queueBtn.click()
  })
  assert.deepEqual(sent, ['steer', 'followUp'])

  // 桌面端：渲染分体下拉，菜单项角标带 .kbd-hint 类
  const desktopHost = mountTree(
    e(ComposerSendControls, {
      working: true,
      editingEntryId: null,
      sending: false,
      uploading: 0,
      envBlocker: blocker,
      text: '桌面指令',
      isMobile: false,
      send,
      abortTurn,
    }),
  )
  assert.ok(desktopHost.querySelector('.composer-busy-mobile-actions') === null)
  const trigger = desktopHost.querySelector<HTMLButtonElement>('button.composer-split-trigger')
  assert.ok(trigger, '桌面端保留分体下拉触发器')
})

// ---------------------------------------------------------------------------
// 8. Standby 待命页：默认模型继承、Shift+Tab、Ctrl+L 与静态 '/' 技能补全
// ---------------------------------------------------------------------------

test('Standby 待命页：继承全局默认模型 glm-5.3·max，支持 Shift+Tab / Ctrl+L 与静态 /skill 补全', { timeout: 60_000 }, async () => {
  // 纯函数校验
  assert.equal(resolveStandbyEffectiveModel(undefined, undefined, 'magpie/auto/glm-5.3'), 'magpie/auto/glm-5.3')
  assert.equal(resolveStandbyEffectiveModel(undefined, 'p/m1', 'magpie/auto/glm-5.3'), 'p/m1')
  assert.equal(resolveStandbyEffectiveModel('d/m2', 'p/m1', 'magpie/auto/glm-5.3'), 'd/m2')
  assert.equal(resolveStandbyThinkingLevel(['off', 'high', 'max'], undefined, undefined, 'max'), 'max')

  const profile: Profile = { id: 'assistant', name: '个人助理' }
  const skills: SkillSummary[] = [
    { id: 'review', name: '代码审查', references: [] },
    { id: 'herdr-only', name: '终端工具', references: [], managedByPlugin: 'builtin:herdr' },
  ]
  const store = makeTestStore({
    profiles: [profile],
    skills,
    plugins: [
      { id: 'builtin:profile', name: 'profile', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
      { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: false, hooks: [], actions: [], tools: [] },
    ],
    models: [
      {
        id: 'magpie/auto/glm-5.3',
        provider: 'magpie',
        modelId: 'auto/glm-5.3',
        available: true,
        thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
      },
    ],
    defaultModelInfo: { defaultModel: 'magpie/auto/glm-5.3', defaultThinkingLevel: 'max' },
    uiContributions: [
      {
        pluginId: 'builtin:memory',
        surface: 'composer.completer',
        spec: { id: 'mem', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'refs', itemsField: 'items' } },
      },
    ],
    groupedUi: groupUiContributions([
      {
        pluginId: 'builtin:memory',
        surface: 'composer.completer',
        spec: { id: 'mem', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'refs', itemsField: 'items' } },
      },
    ]),
    pluginDocs: {
      'builtin:memory/refs': { items: [{ id: 'm-1', label: '@memory', insertText: '@memory ' }] },
    },
  })

  const host = mountTree(
    e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant', isSplit: true })),
    'split',
  )

  const modelBtn = host.querySelector<HTMLButtonElement>('button.composer-model-button')!
  assert.match(modelBtn.textContent ?? '', /glm-5\.3/, '首屏继承全局默认模型短名')
  assert.match(modelBtn.textContent ?? '', /· max/, '首屏继承全局默认思考档位')

  // Shift+Tab 在待命页循环思考档位（max -> off）
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    ta.dispatchEvent(ev)
    assert.equal(ev.defaultPrevented, true)
  })
  assert.ok(host.querySelector('.composer-model-level') === null, 'max 下一档为 off，角标隐藏')
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(host.querySelector('.composer-model-level')?.textContent, '· low', '继续 Shift+Tab 切至 low')

  // Ctrl+L 仅命中 split 面板打开 StandbyModelPicker 并自动聚焦搜索框
  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'primary' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null, 'primary 事件不打开 split 待命选择器')

  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover !== null, 'split Ctrl+L 打开待命模型浮层')
  assert.ok(popover.querySelector('button.composer-model-refresh-btn') !== null, '待命模型浮层补齐动态刷新按钮')
  assert.ok(document.activeElement === popover.querySelector('input[aria-label="搜索模型"]'), '自动聚焦搜索输入框')

  await act(async () => {
    window.dispatchEvent(new CustomEvent(HELM_SHORTCUT_EVENT, { detail: { action: 'toggle-model-picker', panel: 'split' } }))
  })
  assert.ok(document.body.querySelector('.composer-model-popover') === null)

  // 静态 '/' 技能补全：过滤停用插件托管技能，选中 /skill:review 插入文本
  await act(async () => {
    typeInto(ta, '/rev')
  })
  const slashPopover = host.querySelector<HTMLElement>('.composer-popover')
  assert.ok(slashPopover, '待命页输入 / 弹出静态命令与技能菜单')
  assert.match(slashPopover.textContent ?? '', /\/skill:review/)
  assert.doesNotMatch(slashPopover.textContent ?? '', /herdr-only/)

  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '/skill:review ', '选中技能仅回填触发词，不创建会话')

  // 通用 '@' 补全浮层在待命页同步工作（与 '/' 技能补全、Ctrl+L、Shift+Tab 共存无冲突）
  await act(async () => {
    typeInto(ta, '/skill:review @mem')
  })
  await act(async () => {})
  const atPopover = host.querySelector<HTMLElement>('.composer-completion-popover')
  assert.ok(atPopover, '待命页输入 @ 应弹出 CompletionPopover')
  assert.match(atPopover.textContent ?? '', /@memory/)
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(ta.value, '/skill:review @memory ', 'Enter 选中 @ 候选仅补全触发文本，不创建会话')
})

test('Composer 提交键位：Enter steer、Ctrl/Cmd+Enter followUp、Shift+Enter 换行、Alt+Enter 禁止别名', { timeout: 60_000 }, async () => {
  const submitted: Array<Record<string, unknown>> = []
  conversationsApi.submitInput = (async (_id, payload) => {
    submitted.push(payload as unknown as Record<string, unknown>)
    return { submissionId: 's-1' }
  }) as typeof conversationsApi.submitInput

  const conv = makeConv({ id: 20, status: 'working' })
  const store = makeTestStore({ conversations: [conv] })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  // Shift+Enter 与 Alt+Enter 绝不触发提交
  await act(async () => { typeInto(ta, '待验证') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.length, 0, 'Shift+Enter 与 Alt+Enter 均不发送')

  // Enter -> steer
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'steer')

  // Ctrl+Enter -> followUp
  await act(async () => { typeInto(ta, '排队一') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'followUp')

  // Meta+Enter -> followUp
  await act(async () => { typeInto(ta, '排队二') })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  })
  assert.equal(submitted.at(-1)?.whenBusy, 'followUp')
})

test('CompletionPopover：Esc 关闭补全浮层且 stopPropagation 不触达外层', { timeout: 60_000 }, async () => {
  const conv = makeConv({ id: 21, status: 'working' })
  const store = makeTestStore({
    conversations: [conv],
    uiContributions: [
      {
        pluginId: 'p1',
        surface: 'composer.completer',
        spec: { id: 'c1', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'cat', itemsField: 'items' } },
      },
    ],
    groupedUi: groupUiContributions([
      {
        pluginId: 'p1',
        surface: 'composer.completer',
        spec: { id: 'c1', label: '记忆', trigger: '@', source: { kind: 'doc', name: 'cat', itemsField: 'items' } },
      },
    ]),
    pluginDocs: { 'p1/cat': { items: [{ id: 'm1', label: '@记忆', insertText: '@记忆 ' }] } },
  })
  const host = mountTree(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill: null })))
  const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

  let leakedEsc = 0
  const spy = (ev: KeyboardEvent) => { if (ev.key === 'Escape') leakedEsc++ }
  window.addEventListener('keydown', spy)
  try {
    await act(async () => { typeInto(ta, '@') })
    await act(async () => {})
    assert.ok(host.querySelector('.composer-completion-popover'), '补全浮层打开')
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(host.querySelector('.composer-completion-popover') === null, 'Esc 关闭补全浮层')
    assert.equal(leakedEsc, 0, 'Esc 已 stopPropagation 防外层双 Esc 误触发')
  } finally {
    window.removeEventListener('keydown', spy)
  }
})

test('ModelPickerControl 运行时过滤不可用与禁用模型，刷新按钮触发 /api/models/refresh 与 refreshAssets', { timeout: 60_000 }, async () => {
  const { ModelPickerControl } = await import('../src/conversation/ModelPicker.js')
  const originalFetch = globalThis.fetch
  let refreshPostCount = 0
  let refreshAssetsCount = 0
  const notices: Array<{ level: string; title: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/models/refresh' && init?.method === 'POST') {
      refreshPostCount += 1
      return jsonResponse({ errors: {} })
    }
    return jsonResponse({})
  }) as typeof fetch

  const store = makeTestStore({
    models: [
      { id: 'faux/enabled-model', provider: 'faux', modelId: 'enabled-model', available: true, thinkingLevels: ['off'] },
      { id: 'faux/disabled-model', provider: 'faux', modelId: 'disabled-model', available: true, disabled: true, thinkingLevels: ['off'] },
      { id: 'faux/unavailable-model', provider: 'faux', modelId: 'unavailable-model', available: false, thinkingLevels: ['off'] },
    ],
    refreshAssets: async () => {
      refreshAssetsCount += 1
    },
    pushNotice: (n) => notices.push({ level: n.level, title: n.title }),
  })

  try {
    const host = mountTree(
      <HostStoreProviders value={store}>
        <ModelPickerControl
          effectiveModel="faux/enabled-model"
          selectedModel={undefined}
          activeThinkingLevel="off"
          resetLabel="跟随默认"
          resetTitle="恢复默认"
          buttonTitle="切换模型"
          onPickModel={() => {}}
          onResetDefault={() => {}}
          onPickThinking={() => {}}
        />
      </HostStoreProviders>,
    )

    const btn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(btn)
    await act(async () => {
      btn.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover)
    const items = [...popover.querySelectorAll<HTMLButtonElement>('button.popover-item')]
    assert.ok(items.some((el) => el.textContent?.includes('enabled-model')), '可用且未禁用模型应展示')
    assert.equal(items.some((el) => el.textContent?.includes('disabled-model')), false, 'disabled 模型不得作为可选项')
    assert.equal(items.some((el) => el.textContent?.includes('unavailable-model')), false, '不可用模型不得作为可选项')

    const refreshBtn = popover.querySelector<HTMLButtonElement>('button.composer-model-refresh-btn')
    assert.ok(refreshBtn, '存在刷新动态模型目录按钮')
    await act(async () => {
      refreshBtn.click()
    })
    assert.equal(refreshPostCount, 1, '点击刷新按钮触发 POST /api/models/refresh')
    assert.equal(refreshAssetsCount, 1, '刷新完成后同步 refreshAssets')
    assert.equal(notices.some((n) => n.title === '已刷新模型目录'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
