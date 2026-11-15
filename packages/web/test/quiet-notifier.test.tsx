/**
 * useQuietNotifier 真实 React 装配测试（createRoot + act，happy-dom，真实
 * 计时器以 quietNotifyTimings.settleMs 缩短驱动；stub 全局 Notification）：
 * - badge doc 自洽发现：无 doc 不弹假通知（保持未知），ensure 加载后在途
 *   accent 角标阻止通知，加载完成无在途才允许安静结算；
 * - 忙碌周期累积：多阶段收尾中早期会话不丢（跨被活动取消的防抖窗口保留），
 *   派生子会话归并到根会话（不重复列、不抢跳转）；
 * - blocked 语义：等待人类不阻止机器停下，机器停下有 blocked 会话时改发
 *   「等待你的处理」并跳转该会话；
 * - 防抖窗口内活动恢复即取消；页面聚焦 / 偏好关闭（含中途放弃周期）/
 *   打开页面即安静均不投递；
 * - SSE 断流时安静到期不按陈旧状态投递，重连后按最新事实结算一次不重复；
 * - 通知点击：聚焦窗口并跳转 primary 会话；卸载清理防抖计时器。
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

const BADGE_DOC_KEY = 'builtin:workflow/run-badges'

/** 无任何 accent 条目的 badge doc（已加载、无在途）。 */
const IDLE_BADGE_DOC = { byConversation: {} as Record<string, unknown> }

/** 带 accent 在途条目的 badge doc。 */
const accentBadgeDoc = (conversationId: number): Record<string, unknown> => ({
  byConversation: { [String(conversationId)]: { count: 1, tone: 'accent', footerText: '1 运行中' } },
})

interface HarnessOptions {
  quietNotifyEnabled?: boolean
  sseConnected?: boolean
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
  // ensurePluginDoc 与真实 store 同语义：doc 可取到返回其值（并视为已加载），
  // 取不到返回 undefined（保持未知）；test 通过 pluginDocs 控制可取性。
  const buildStore = (next: HarnessOptions): HelmStoreValue =>
    makeTestStore({
      quietNotifyEnabled: next.quietNotifyEnabled ?? true,
      sseConnected: next.sseConnected ?? true,
      conversations: next.conversations,
      pluginDocs: next.pluginDocs ?? {},
      uiContributions: [PANEL_CONTRIBUTION],
      groupedUi: groupUiContributions([PANEL_CONTRIBUTION]),
      ensurePluginDoc: async (pluginId: string, name: string) => (next.pluginDocs ?? {})[`${pluginId}/${name}`],
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
    const harness = mountHarness({
      conversations: [conv({ id: 5, title: '修复构建失败', status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 5, title: '修复构建失败', status: 'done', updatedAt: 9_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
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
    const harness = mountHarness({
      conversations: [conv({ id: 7, title: '大规模重构' })],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(7) },
    })
    harness.rerender({
      conversations: [conv({ id: 7, title: '大规模重构' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
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
    const harness = mountHarness({
      conversations: [conv({ id: 5, status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(20)
    harness.rerender({ conversations: [conv({ id: 5, status: 'working', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 0, '窗口内恢复忙碌不得投递')
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 3_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(160)
    assert.equal(notifications.length, 1)
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('多阶段收尾：忙碌周期跨被取消的防抖窗口累积，早期会话不丢', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 1, title: '早期任务', status: 'working' }), conv({ id: 2, title: '晚期任务' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    // 阶段一收尾：#1 done，安静防抖开始计时
    harness.rerender({
      conversations: [conv({ id: 1, title: '早期任务', status: 'done', updatedAt: 1_000 }), conv({ id: 2, title: '晚期任务' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(20)
    // 防抖窗口内 #2 开始工作：取消计时，但 #1 保留在周期累计中
    harness.rerender({
      conversations: [conv({ id: 1, title: '早期任务', status: 'done', updatedAt: 1_000 }), conv({ id: 2, title: '晚期任务', status: 'working', updatedAt: 2_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(20)
    // 阶段二收尾：全部安静，最终结算必须包含早期参与者 #1
    harness.rerender({
      conversations: [conv({ id: 1, title: '早期任务', status: 'done', updatedAt: 1_000 }), conv({ id: 2, title: '晚期任务', status: 'done', updatedAt: 3_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(160)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#2 晚期任务 · #1 早期任务')
    assert.equal(notifications[0]!.options.tag, 'helm-quiet')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('派生子会话归并：子会话活动不污染正文、不抢跳转，通知只列根会话', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const harness = mountHarness({
      conversations: [
        conv({ id: 5, title: '大规模重构', updatedAt: 100 }),
        conv({ id: 12, title: '子代理 12', parentConversationId: 5, status: 'working', updatedAt: 900 }),
        conv({ id: 13, title: '子代理 13', parentConversationId: 5, status: 'working', updatedAt: 800 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '大规模重构', updatedAt: 100 }),
        conv({ id: 12, title: '子代理 12', parentConversationId: 5, status: 'done', updatedAt: 900 }),
        conv({ id: 13, title: '子代理 13', parentConversationId: 5, status: 'done', updatedAt: 800 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#5 大规模重构', '两个子代理归并为唯一根会话条目')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 5 }], '跳转根会话而非子代理会话')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('机器停下但会话 blocked：改发「等待你的处理」并跳转该会话', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 3, title: '部署检查', status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 3, title: '部署检查', status: 'blocked', pendingAskCount: 1, updatedAt: 5_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, 'Helm 等待你的处理')
    assert.equal(notifications[0]!.options.body, '待处理输入/审批：#3 部署检查')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 3 }])
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('防抖窗口内新出现的 blocked 不打断计窗；结算时 blocked 目标优先于普通根会话', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 1, title: '刚收尾的任务', status: 'working' }), conv({ id: 2, title: '等待输入' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 1, title: '刚收尾的任务', status: 'done', updatedAt: 9_000 }), conv({ id: 2, title: '等待输入' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(20)
    harness.rerender({
      conversations: [conv({ id: 1, title: '刚收尾的任务', status: 'done', updatedAt: 9_000 }), conv({ id: 2, title: '等待输入', status: 'blocked', pendingAskCount: 1, updatedAt: 4_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(160)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, 'Helm 等待你的处理')
    assert.equal(notifications[0]!.options.body, '待处理输入/审批：#2 等待输入')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 2 }], 'blocked 会话优先于更新更晚的普通根会话')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('badge doc 未加载时保持未知：不弹假通知；ensure 加载后在途 accent 阻止通知，归零后才结算', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    // 首次挂载：badge doc 缺失且 ensure 未取到——机器主回合在途（正向事实）
    const harness = mountHarness({ conversations: [conv({ id: 5, title: '后台任务', status: 'working' })], pluginDocs: {} })
    // 主回合收尾但 badge doc 仍未知：后台在途无法证伪，不得按安静投递
    harness.rerender({ conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 2_000 })], pluginDocs: {} })
    await sleep(120)
    assert.equal(notifications.length, 0, 'badge doc 未知期间不得弹假「全部空闲」')
    // ensure 完成加载：doc 显示 #5 名下仍有后台在途——继续阻止通知
    harness.rerender({ conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(5) } })
    await sleep(120)
    assert.equal(notifications.length, 0, '在途 accent 角标阻止安静通知')
    // 后台归零：现在才允许安静结算，且周期累计（主回合 + 后台阶段）都在
    harness.rerender({ conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 3_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#5 后台任务')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('SSE 断流时安静到期不按陈旧状态投递；重连后按最新事实结算一次', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 5, status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(10)
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: false })
    await sleep(150)
    assert.equal(notifications.length, 0, '断流期间状态陈旧，不投递也不静默丢掉周期')
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: true })
    await sleep(120)
    assert.equal(notifications.length, 1, '重连后按最新事实结算投递一次')
    await sleep(120)
    assert.equal(notifications.length, 1, '不重复投递')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('断流挂起期间活动恢复：丢弃待结算、周期继续，下次停机完整结算', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(60)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 1, title: '任务一', status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({ conversations: [conv({ id: 1, title: '任务一', status: 'done', updatedAt: 1_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(10)
    harness.rerender({ conversations: [conv({ id: 1, title: '任务一', status: 'done', updatedAt: 1_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: false })
    await sleep(150)
    assert.equal(notifications.length, 0)
    // 挂起期间机器又在途（重连带来的新事实）：丢弃待结算，周期继续累计
    harness.rerender({ conversations: [conv({ id: 1, title: '任务一', status: 'done', updatedAt: 1_000 }), conv({ id: 2, title: '任务二', status: 'working', updatedAt: 5_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: true })
    await sleep(150)
    assert.equal(notifications.length, 0, '活动恢复后不得按旧周期投递')
    harness.rerender({ conversations: [conv({ id: 1, title: '任务一', status: 'done', updatedAt: 1_000 }), conv({ id: 2, title: '任务二', status: 'done', updatedAt: 6_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: true })
    await sleep(160)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#2 任务二 · #1 任务一', '恢复后的周期结算包含全部累计会话')
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
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 0)
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('偏好关闭、打开页面即安静、偏好中途关闭放弃周期：均不投递', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const disabled = mountHarness({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    disabled.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 0, '偏好关闭不得投递')
    disabled.unmount()

    const initialQuiet = mountHarness({ conversations: [conv({ id: 6, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 0, '打开页面即安静不构成转移')
    initialQuiet.unmount()

    // 偏好中途关闭 = 明确放弃周期：关闭期间收尾的会话不进入重新开启后的通知
    const abandoned = mountHarness({ conversations: [conv({ id: 7, title: '被放弃的任务', status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: true, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(120)
    assert.equal(notifications.length, 0, '被放弃的周期不得在重新开启后补发')
    abandoned.unmount()
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
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.unmount()
    await sleep(160)
    assert.equal(notifications.length, 0)
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})

test('插件热重载清空已加载 badge doc 时重新保持未知，直到新 doc 到达再结算', { timeout: 60_000 }, async () => {
  const restoreFocus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkSettleMs(30)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle' })],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(7) },
    })
    harness.rerender({ conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle' })], pluginDocs: {} })
    await sleep(120)
    assert.equal(notifications.length, 0, '重载期间 doc 缺失不得按安静结算')

    harness.rerender({
      conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle', updatedAt: 2_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(120)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.body, '#7 插件重载期间')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    restoreFocus()
  }
})
