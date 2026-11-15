/**
 * useQuietNotifier 真实 React 装配测试（createRoot + act，happy-dom，真实
 * 计时器以 quietNotifyTimings.settleMs 缩短驱动；stub 全局 Notification）：
 * - 「忙碌 → 安静」转移防抖满窗后投递一次（主回合与后台在途两种来源）；
 * - 防抖窗口内活动恢复即取消，随后再次安静重新计窗；
 * - 页面聚焦（用户正看着页面）/ 偏好关闭 / 打开页面即安静 均不投递；
 * - 通知点击：聚焦窗口并跳转 primary 会话；
 * - 卸载清理防抖计时器。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary, PluginUiContribution, WorkbenchPanelSpec } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
import { useQuietNotifier, quietNotifyTimings } from '../src/shell/use-quiet-notifier.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 捕获投递的通知实例（title/options/onclick）。 */
interface CapturedNotification {
  title: string
  options: NotificationOptions
  onclick: ((event: Event) => void) | null
}

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

const WORKFLOW_PANEL_SPEC: WorkbenchPanelSpec = {
  id: 'tasks',
  label: '工作流与子代理',
  badge: { doc: 'run-badges', byConversationField: 'byConversation' },
}

const PANEL_CONTRIBUTION: PluginUiContribution = {
  pluginId: 'builtin:workflow',
  surface: 'workbench.panel',
  spec: WORKFLOW_PANEL_SPEC,
}

interface HarnessOptions {
  quietNotifyEnabled?: boolean
  conversations: ConversationSummary[]
  pluginDocs?: Record<string, unknown>
}

interface Harness {
  rerender: (options: HarnessOptions) => void
  unmount: () => void
  openTargetCalls: Array<{ kind: string; conversationId?: number }>
}

function Probe(): React.ReactNode {
  useQuietNotifier()
  return e('div', null, 'probe')
}

function mountHarness(options: HarnessOptions): Harness {
  const calls: Array<{ kind: string; conversationId?: number }> = []
  const buildStore = (next: HarnessOptions): HelmStoreValue =>
    makeTestStore({
      quietNotifyEnabled: next.quietNotifyEnabled ?? true,
      conversations: next.conversations,
      pluginDocs: next.pluginDocs ?? {},
      uiContributions: [PANEL_CONTRIBUTION],
      groupedUi: groupUiContributions([PANEL_CONTRIBUTION]),
      openTarget: (target) => {
        calls.push(typeof target === 'string' ? { kind: target } : { kind: target.kind, conversationId: 'conversationId' in target ? target.conversationId : undefined })
      },
    })
  let currentStore = buildStore(options)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  const renderTree = (): React.ReactElement => e(HelmStoreContext.Provider, { value: currentStore }, e(Probe))
  act(() => {
    root = createRoot(host)
    root.render(renderTree())
  })
  return {
    rerender: (next: HarnessOptions) => {
      currentStore = buildStore(next)
      act(() => {
        root!.render(renderTree())
      })
    },
    unmount: () => {
      act(() => {
        root!.unmount()
      })
      host.remove()
    },
    openTargetCalls: calls,
  }
}

/** happy-dom 默认聚焦（document.hasFocus()=true 会抑制投递）：测试统一改为失焦。 */
function setPageFocus(focused: boolean): () => void {
  const original = document.hasFocus
  document.hasFocus = () => focused
  return () => {
    document.hasFocus = original
  }
}

function installGrantedNotification(): { notifications: CapturedNotification[]; restore: () => void } {
  const notifications: CapturedNotification[] = []
  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    onclick: ((event: Event) => void) | null = null
    title: string
    options: NotificationOptions
    constructor(title: string, options: NotificationOptions) {
      this.title = title
      this.options = options
      notifications.push(this)
    }
  }
  ;(globalThis as Record<string, unknown>).Notification = FakeNotification
  return { notifications, restore: () => delete (globalThis as Record<string, unknown>).Notification }
}

/** 缩短防抖窗口（真实计时器）：返回恢复函数。 */
function shrinkSettleMs(ms: number): () => void {
  const original = quietNotifyTimings.settleMs
  quietNotifyTimings.settleMs = ms
  return () => {
    quietNotifyTimings.settleMs = original
  }
}

test('主回合忙碌 → 安静：防抖满窗投递一次，点击聚焦并跳转 primary 会话', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  const focusedSpy: boolean[] = []
  const originalFocus = window.focus
  window.focus = () => focusedSpy.push(true)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, title: '修复构建失败', status: 'working' })] })
    harness.rerender({ conversations: [conv({ id: 5, title: '修复构建失败', status: 'done', updatedAt: 9_000 })] })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, 'Helm 已全部空闲')
    assert.equal(notifications[0]!.options.body, '#5 修复构建失败')
    assert.equal(notifications[0]!.options.tag, 'helm-quiet')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(focusedSpy, [true])
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 5 }])
    harness.unmount()
  } finally {
    window.focus = originalFocus
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('后台在途结束（父会话全程 idle，accent 角标归零）同样投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const running = { 'builtin:workflow/run-badges': { byConversation: { '7': { count: 2, tone: 'accent', footerText: '2 运行中' } } } }
    const harness = mountHarness({ conversations: [conv({ id: 7, title: '大规模重构' })], pluginDocs: running })
    harness.rerender({ conversations: [conv({ id: 7, title: '大规模重构' })], pluginDocs: {} })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#7 大规模重构')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('防抖窗口内活动恢复即取消；再次安静重新计窗投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })] })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })] })
    await sleep(20)
    harness.rerender({ conversations: [conv({ id: 5, status: 'working', updatedAt: 2_000 })] })
    await sleep(120)
    assert.equal(notifications.length, 0, '窗口内恢复忙碌不得投递')
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 3_000 })] })
    await sleep(160)
    assert.equal(notifications.length, 1)
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('页面聚焦（用户正看着页面）不投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(true)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })] })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })] })
    await sleep(120)
    assert.equal(notifications.length, 0)
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('偏好关闭或打开页面即安静：均不投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const disabled = mountHarness({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'working' })] })
    disabled.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'idle' })] })
    await sleep(120)
    assert.equal(notifications.length, 0, '偏好关闭不得投递')
    disabled.unmount()

    const initialQuiet = mountHarness({ conversations: [conv({ id: 6, status: 'idle' })] })
    await sleep(120)
    assert.equal(notifications.length, 0, '打开页面即安静不构成转移')
    initialQuiet.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('卸载清理：防抖窗口内卸载不投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })] })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })] })
    harness.unmount()
    await sleep(160)
    assert.equal(notifications.length, 0)
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})
