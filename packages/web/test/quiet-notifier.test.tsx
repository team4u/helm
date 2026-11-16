/**
 * useQuietNotifier 真实 React 装配测试（createRoot + act，happy-dom，真实
 * 计时器以 quietNotifyTimings.settleMs / blockedSettleMs 缩短驱动；stub 全局 Notification）：
 * - 多根树并行隔离：树 A 仍在 working/后台跑，树 B 独立结算（tag: helm-conv-B）；
 *   树 A 后续结束亦以 helm-conv-A 通知，互不阻滞也不互相覆盖；
 * - badge doc 自洽发现：未知期间阻止任何树误报「已完成」，ensure 加载后在途
 *   accent 角标阻止完成通知，归零后才结算（blocked 通道不受未知门控阻滞）；
 * - 同树多阶段收尾与子代理归并：防抖窗口内子代理唤醒父会话取消并保留累计，
 *   存在 error 参与者时诚实报「Helm 会话已结束」并标注「有失败」；
 * - blocked 独立立即通道：树内有其他后台任务或 badgeUnknown 时仍经 blockedSettleMs
 *   立即通知；挂载/开启即 blocked 基线不误报；同水位不重复、推进再弹、前台已处理
 *   切后台不滞后补弹；短于防抖取消不误报；blocked 结算后取消不误报完成，人类回答
 *   重新 working → done 正常通知；
 * - SSE 断流挂起：完成通道与 blocked 通道均在断流到期时挂起，重连后按最新事实结算；
 * - 门控与清理：页面聚焦、偏好关闭/中途关闭、卸载清理均不误发。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, PluginUiContribution, WorkbenchPanelSpec } from '@helm/protocol'
import { ensureHappyDom, waitForCondition } from './helpers/dom-harness.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { makeTestStore } from './helpers/store.js'
import {
  registerBrowserNotificationServiceWorker,
  resetBrowserNotificationServiceWorkerForTest,
} from '../src/lib/browser-notification.js'
import { useQuietNotifier, quietNotifyTimings } from '../src/shell/use-quiet-notifier.js'
import {
  COMPLETED_NOTIFICATION_TITLE,
  ENDED_NOTIFICATION_TITLE,
  WAITING_NOTIFICATION_TITLE,
} from '../src/shell/quiet-notify-model.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const e = React.createElement

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
  authenticated?: boolean
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
  const buildStore = (next: HarnessOptions): HelmStoreValue =>
    makeTestStore({
      authenticated: next.authenticated ?? true,
      quietNotifyEnabled: next.quietNotifyEnabled ?? true,
      sseConnected: next.sseConnected ?? true,
      conversations: next.conversations,
      pluginDocs: next.pluginDocs ?? {},
      uiContributions: [PANEL_CONTRIBUTION],
      groupedUi: groupUiContributions([PANEL_CONTRIBUTION]),
      ensurePluginDoc: async (pluginId: string, name: string) => (next.pluginDocs ?? {})[`${pluginId}/${name}`],
      openTarget: (target) => {
        calls.push(
          typeof target === 'string'
            ? { kind: target }
            : { kind: target.kind, conversationId: 'conversationId' in target ? target.conversationId : undefined },
        )
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

/** happy-dom 默认聚焦（document.hasFocus()=true 会抑制投递）：测试可切换聚焦态。 */
function setPageFocus(focused: boolean): { set: (next: boolean) => void; restore: () => void } {
  const original = document.hasFocus
  let current = focused
  document.hasFocus = () => current
  return {
    set: (next: boolean) => {
      current = next
    },
    restore: () => {
      document.hasFocus = original
    },
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

/** 缩短完成/blocked 防抖窗口（真实计时器）：返回恢复函数。 */
function shrinkTimings(settleMs: number, blockedSettleMs = settleMs): () => void {
  const originalSettle = quietNotifyTimings.settleMs
  const originalBlocked = quietNotifyTimings.blockedSettleMs
  quietNotifyTimings.settleMs = settleMs
  quietNotifyTimings.blockedSettleMs = blockedSettleMs
  return () => {
    quietNotifyTimings.settleMs = originalSettle
    quietNotifyTimings.blockedSettleMs = originalBlocked
  }
}

test('主回合忙碌 → 完成：防抖满窗投递一次（tag=helm-conv-5），点击聚焦并跳转根会话', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
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
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#5 修复构建失败')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-5')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(focusedSpy, [true])
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 5 }])
    harness.unmount()
  } finally {
    window.focus = originalFocus
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('多根树并行隔离：树 A 仍在 working / 后台跑，树 B 结束后按时独立通知且 tag 互不覆盖', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const harness = mountHarness({
      conversations: [
        conv({ id: 1, title: '长任务 A', status: 'working' }),
        conv({ id: 2, title: '短任务 B', status: 'working' }),
        conv({ id: 3, title: '后台任务 C', status: 'idle' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(3) },
    })
    // 树 B 率先结束，树 A 仍在 working，树 C 仍有后台 accent 角标
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '长任务 A', status: 'working', updatedAt: 2_000 }),
        conv({ id: 2, title: '短任务 B', status: 'done', updatedAt: 3_000 }),
        conv({ id: 3, title: '后台任务 C', status: 'idle' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(3) },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1, '树 A/C 在途不得阻塞树 B 结算完成通知')
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#2 短任务 B')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-2')

    // 树 A 随后完成（失败结束），树 C 仍在后台跑
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '长任务 A', status: 'error', updatedAt: 5_000 }),
        conv({ id: 2, title: '短任务 B', status: 'done', updatedAt: 3_000 }),
        conv({ id: 3, title: '后台任务 C', status: 'idle' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(3) },
    })
    await waitForCondition(() => notifications.length === 2)
    assert.equal(notifications.length, 2)
    assert.equal(notifications[1]!.title, ENDED_NOTIFICATION_TITLE)
    assert.equal(notifications[1]!.options.body, '#1 长任务 A · 有失败')
    assert.equal(notifications[1]!.options.tag, 'helm-conv-1')

    // 树 C 后台归零
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '长任务 A', status: 'error', updatedAt: 5_000 }),
        conv({ id: 2, title: '短任务 B', status: 'done', updatedAt: 3_000 }),
        conv({ id: 3, title: '后台任务 C', status: 'idle', updatedAt: 7_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 3)
    assert.equal(notifications.length, 3)
    assert.equal(notifications[2]!.options.tag, 'helm-conv-3')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('后台在途结束（父会话全程 idle，accent 角标归零）同样投递', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 7, title: '大规模重构' })],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(7) },
    })
    harness.rerender({
      conversations: [conv({ id: 7, title: '大规模重构' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#7 大规模重构')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-7')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('防抖窗口内同树活动恢复即取消；再次安静重新计窗投递', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(45, 15)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 5, status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(10)
    harness.rerender({ conversations: [conv({ id: 5, status: 'working', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(60)
    assert.equal(notifications.length, 0, '窗口内恢复忙碌不得投递')
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 3_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.options.tag, 'helm-conv-5')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('同树多阶段收尾：子代理唤醒父会话取消防抖并保留早期失败参与者，最终报「已结束 · 有失败」', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(45, 15)
  try {
    const harness = mountHarness({
      conversations: [
        conv({ id: 5, title: '主控会话', status: 'idle' }),
        conv({ id: 12, parentConversationId: 5, title: '子代理甲', status: 'working' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    // 阶段一：子代理甲失败，防抖开始计时
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '主控会话', status: 'idle', updatedAt: 1_000 }),
        conv({ id: 12, parentConversationId: 5, title: '子代理甲', status: 'error', updatedAt: 2_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    // 防抖窗口内父会话被唤醒汇总：取消计时但保留 #12 失败参与者
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '主控会话', status: 'working', updatedAt: 3_000 }),
        conv({ id: 12, parentConversationId: 5, title: '子代理甲', status: 'error', updatedAt: 2_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    // 阶段二：父会话收尾 done，周期包含早期失败子代理 #12
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '主控会话', status: 'done', updatedAt: 4_000 }),
        conv({ id: 12, parentConversationId: 5, title: '子代理甲', status: 'error', updatedAt: 2_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, ENDED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#5 主控会话 · 有失败')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-5')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('派生子会话归并：子会话活动不污染正文、不抢跳转，通知只列根会话', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
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
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#5 大规模重构', '两个子代理归并为唯一根会话条目')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-5')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 5 }], '跳转根会话而非子代理会话')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('新进入 blocked：经 blockedSettleMs 投递「等待你的处理」（tag=helm-conv-3）并跳转该会话', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(60, 15)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 3, title: '部署检查', status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 3, title: '部署检查', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2, updatedAt: 5_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1, 'blocked 短防抖到期即通知，无需等待完成长防抖')
    assert.equal(notifications[0]!.title, WAITING_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '待处理输入/审批：#3 部署检查')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-3')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 3 }])
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('同树仍有并行后台任务且 badge doc 未知时，子会话 blocked 仍经 blockedSettleMs 立即弹出「等待你的处理」', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(80, 15)
  try {
    // 初始 badge doc 未知，根会话 5 本身仍在 working
    const harness = mountHarness({
      conversations: [
        conv({ id: 5, title: '多代理工作流', status: 'working' }),
        conv({ id: 51, parentConversationId: 5, title: '子代理 51', status: 'working' }),
      ],
      pluginDocs: {},
    })
    // 子代理 51 进入 blocked，同时根会话 5 与后台任务仍在跑、badge doc 仍未就绪
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '多代理工作流', status: 'working', updatedAt: 1_000 }),
        conv({ id: 51, parentConversationId: 5, title: '子代理 51', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2, updatedAt: 5_000 }),
      ],
      pluginDocs: {},
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, WAITING_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '待处理输入/审批：#5 多代理工作流')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-5')
    notifications[0]!.onclick?.({} as Event)
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 51 }], '点击跳转具体的 blocked 子会话')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('同树完成防抖窗口内新出现 blocked：取消完成计时改发「等待你的处理」；跨树互相独立', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(50, 15)
  try {
    const harness = mountHarness({
      conversations: [
        conv({ id: 1, title: '独立任务一', status: 'working' }),
        conv({ id: 5, title: '树五', status: 'working' }),
        conv({ id: 51, parentConversationId: 5, title: '树五子代理', status: 'idle' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    // 两棵树均进入完成防抖窗口
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '独立任务一', status: 'done', updatedAt: 9_000 }),
        conv({ id: 5, title: '树五', status: 'done', updatedAt: 8_000 }),
        conv({ id: 51, parentConversationId: 5, title: '树五子代理', status: 'idle' }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    // 窗口内树五子代理进入 blocked：打断树五完成结算，不影响树一
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '独立任务一', status: 'done', updatedAt: 9_000 }),
        conv({ id: 5, title: '树五', status: 'done', updatedAt: 8_000 }),
        conv({ id: 51, parentConversationId: 5, title: '树五子代理', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2, updatedAt: 10_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 2)
    assert.equal(notifications.length, 2)
    const conv5Notif = notifications.find((n) => n.options.tag === 'helm-conv-5')
    const conv1Notif = notifications.find((n) => n.options.tag === 'helm-conv-1')
    assert.ok(conv5Notif)
    assert.equal(conv5Notif.title, WAITING_NOTIFICATION_TITLE)
    assert.equal(conv5Notif.options.body, '待处理输入/审批：#5 树五')
    assert.ok(conv1Notif)
    assert.equal(conv1Notif.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(conv1Notif.options.body, '#1 独立任务一')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('blocked 水位防重与推进：同水位不重复；推进再提醒；前台已处理切后台不滞后补弹', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(true)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(50, 15)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 4, title: '审批会话', status: 'working', stateChangeSeq: 1 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    // 在前台时进入 blocked（2:1）：到期时不投递但水位已处理
    harness.rerender({
      conversations: [conv({ id: 4, title: '审批会话', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(30)
    assert.equal(notifications.length, 0, '前台时不得弹出')

    // 切到后台并触发一次无关重渲染：同一水位不得滞后补弹
    focus.set(false)
    harness.rerender({
      conversations: [conv({ id: 4, title: '审批会话', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2, updatedAt: 9_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(30)
    assert.equal(notifications.length, 0, '前台已处理的 blocked 水位切后台后不得滞后补弹')

    // 水位推进（新审批 3:2）：在后台时立即提醒一次，同水位再次渲染不重复
    harness.rerender({
      conversations: [conv({ id: 4, title: '审批会话', status: 'blocked', pendingAskCount: 2, stateChangeSeq: 3, updatedAt: 10_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, WAITING_NOTIFICATION_TITLE)

    harness.rerender({
      conversations: [conv({ id: 4, title: '审批会话', status: 'blocked', pendingAskCount: 2, stateChangeSeq: 3, updatedAt: 11_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(30)
    assert.equal(notifications.length, 1, '同一水位不得重复弹')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('blocked 基线与短时撤销：打开页面/重新开启时已 blocked 不误报；短于防抖撤销不误报', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(50, 25)
  try {
    // 1. 挂载初始即处于 blocked：登记基线，不误报
    const initialBlocked = mountHarness({
      conversations: [conv({ id: 1, title: '历史待审批', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 3 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(45)
    assert.equal(notifications.length, 0, '页面打开时本来就处于 blocked 不得误报')
    initialBlocked.unmount()

    // 2. 开关从关闭→开启时已处于 blocked：登记基线，不误报
    const toggled = mountHarness({
      quietNotifyEnabled: false,
      conversations: [conv({ id: 2, title: '关闭前已阻塞', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 4 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    toggled.rerender({
      quietNotifyEnabled: true,
      conversations: [conv({ id: 2, title: '关闭前已阻塞', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 4 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(45)
    assert.equal(notifications.length, 0, '从关闭开启时已存在 blocked 不得误报')
    toggled.unmount()

    // 3. 短于 blockedSettleMs 即离开 blocked：防抖取消不误报
    const transient = mountHarness({
      conversations: [conv({ id: 3, title: '瞬时阻塞', status: 'idle', stateChangeSeq: 1 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    transient.rerender({
      conversations: [conv({ id: 3, title: '瞬时阻塞', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(6)
    transient.rerender({
      conversations: [conv({ id: 3, title: '瞬时阻塞', status: 'idle', pendingAskCount: 0, stateChangeSeq: 3 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(45)
    assert.equal(notifications.length, 0, '短于 blockedSettleMs 被外部取消不得误报')
    transient.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('blocked 结算后清空完成累计：直接取消不误报完成；人类回答再 working → done 正常发完成通知', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(25, 12)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 8, title: '人工审批任务', status: 'working', stateChangeSeq: 1 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    // 转 blocked 并触发等待处理通知
    harness.rerender({
      conversations: [conv({ id: 8, title: '人工审批任务', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, WAITING_NOTIFICATION_TITLE)

    // 场景一：人类直接取消审批（blocked -> idle，未再 working）：不得误报「已完成」
    harness.rerender({
      conversations: [conv({ id: 8, title: '人工审批任务', status: 'idle', pendingAskCount: 0, stateChangeSeq: 3 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(40)
    assert.equal(notifications.length, 1, 'blocked 停下并直接取消不得误报已完成')

    // 场景二：重新发起新一轮 working -> done：正常发完成通知，tag 同为 helm-conv-8
    harness.rerender({
      conversations: [conv({ id: 8, title: '人工审批任务', status: 'working', stateChangeSeq: 4 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 8, title: '人工审批任务', status: 'done', stateChangeSeq: 5, updatedAt: 9_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 2)
    assert.equal(notifications.length, 2)
    assert.equal(notifications[1]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[1]!.options.tag, 'helm-conv-8')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('badge doc 未加载时保持未知：不弹假「已完成」；ensure 加载后在途 accent 阻止完成通知，归零后才结算', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, title: '后台任务', status: 'working' })], pluginDocs: {} })
    harness.rerender({ conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 2_000 })], pluginDocs: {} })
    await sleep(35)
    assert.equal(notifications.length, 0, 'badge doc 未知期间不得弹假「会话已完成」')

    harness.rerender({
      conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 2_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(5) },
    })
    await sleep(35)
    assert.equal(notifications.length, 0, '在途 accent 角标阻止完成通知')

    harness.rerender({
      conversations: [conv({ id: 5, title: '后台任务', status: 'done', updatedAt: 3_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#5 后台任务')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('SSE 断流时完成防抖到期不按陈旧状态投递；重连后按最新事实结算一次', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(45, 15)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 5, status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(10)
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: false })
    await sleep(60)
    assert.equal(notifications.length, 0, '断流期间状态陈旧，不投递也不静默丢掉周期')
    harness.rerender({ conversations: [conv({ id: 5, status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC }, sseConnected: true })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1, '重连后按最新事实结算投递一次')
    await sleep(35)
    assert.equal(notifications.length, 1, '不重复投递')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('blocked 断流挂起：到期时断流不投递，重连仍 blocked 补发一次，重连已解决则不误报等待', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(50, 30)
  try {
    // 场景一：断流挂起 → 重连仍 blocked → 立即补发一次
    const hold = mountHarness({
      conversations: [conv({ id: 9, title: '断流待审批', status: 'working', stateChangeSeq: 1 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    hold.rerender({
      conversations: [conv({ id: 9, title: '断流待审批', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    hold.rerender({
      conversations: [conv({ id: 9, title: '断流待审批', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: false,
    })
    await sleep(50)
    assert.equal(notifications.length, 0, '断流期间不得按陈旧态投递 blocked 通知')

    hold.rerender({
      conversations: [conv({ id: 9, title: '断流待审批', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: true,
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1, '重连仍 blocked 应立即补发一次')
    assert.equal(notifications[0]!.title, WAITING_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.tag, 'helm-conv-9')
    await sleep(45)
    assert.equal(notifications.length, 1, '不重复补发')
    hold.unmount()

    // 场景二：断流挂起期间审批已解决 → 重连后已成 done → 不弹等待通知，转为结算完成通知
    const resolvedOffline = mountHarness({
      conversations: [conv({ id: 10, title: '断流期间已解决', status: 'working', stateChangeSeq: 1 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    resolvedOffline.rerender({
      conversations: [conv({ id: 10, title: '断流期间已解决', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    resolvedOffline.rerender({
      conversations: [conv({ id: 10, title: '断流期间已解决', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: false,
    })
    await sleep(50)
    resolvedOffline.rerender({
      conversations: [conv({ id: 10, title: '断流期间已解决', status: 'done', pendingAskCount: 0, stateChangeSeq: 3, updatedAt: 9_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: true,
    })
    await waitForCondition(() => notifications.length === 2)
    assert.equal(notifications.length, 2)
    assert.equal(notifications[1]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[1]!.options.tag, 'helm-conv-10')
    resolvedOffline.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('断流挂起期间同树活动恢复：丢弃待结算、周期继续，下次停机完整结算', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(45, 15)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 1, title: '主任务', status: 'working' })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    harness.rerender({
      conversations: [conv({ id: 1, title: '主任务', status: 'done', updatedAt: 1_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await sleep(10)
    harness.rerender({
      conversations: [conv({ id: 1, title: '主任务', status: 'done', updatedAt: 1_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: false,
    })
    await sleep(60)
    assert.equal(notifications.length, 0)
    // 重连带回同树子代理继续工作（且失败）：丢弃旧待结算，保留累计
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '主任务', status: 'done', updatedAt: 1_000 }),
        conv({ id: 12, parentConversationId: 1, title: '子代理', status: 'working', updatedAt: 5_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: true,
    })
    await sleep(65)
    assert.equal(notifications.length, 0, '同树活动恢复后不得按旧周期投递')
    harness.rerender({
      conversations: [
        conv({ id: 1, title: '主任务', status: 'done', updatedAt: 1_000 }),
        conv({ id: 12, parentConversationId: 1, title: '子代理', status: 'error', updatedAt: 6_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
      sseConnected: true,
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, ENDED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#1 主任务 · 有失败')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-1')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('页面聚焦（用户正看着页面）不投递', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(true)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(35)
    assert.equal(notifications.length, 0)
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('偏好关闭、打开页面即安静、偏好中途关闭放弃周期：均不投递', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const disabled = mountHarness({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    disabled.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(35)
    assert.equal(notifications.length, 0, '偏好关闭不得投递')
    disabled.unmount()

    const initialQuiet = mountHarness({ conversations: [conv({ id: 6, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(35)
    assert.equal(notifications.length, 0, '打开页面即安静不构成转移')
    initialQuiet.unmount()

    const abandoned = mountHarness({ conversations: [conv({ id: 7, title: '被放弃的任务', status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: false, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    abandoned.rerender({ quietNotifyEnabled: true, conversations: [conv({ id: 7, title: '被放弃的任务', status: 'done', updatedAt: 2_000 })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    await sleep(35)
    assert.equal(notifications.length, 0, '被放弃的周期不得在重新开启后补发')
    abandoned.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('卸载清理：防抖窗口内卸载不投递', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(35, 20)
  try {
    const harness = mountHarness({ conversations: [conv({ id: 5, status: 'working' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.rerender({ conversations: [conv({ id: 5, status: 'idle' })], pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC } })
    harness.unmount()
    await sleep(55)
    assert.equal(notifications.length, 0)
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('插件热重载清空已加载 badge doc 时重新保持未知，直到新 doc 到达再结算', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { notifications, restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  try {
    const harness = mountHarness({
      conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle' })],
      pluginDocs: { [BADGE_DOC_KEY]: accentBadgeDoc(7) },
    })
    harness.rerender({ conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle' })], pluginDocs: {} })
    await sleep(35)
    assert.equal(notifications.length, 0, '重载期间 doc 缺失不得按安静结算')

    harness.rerender({
      conversations: [conv({ id: 7, title: '插件重载期间', status: 'idle', updatedAt: 2_000 })],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => notifications.length === 1)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.title, COMPLETED_NOTIFICATION_TITLE)
    assert.equal(notifications[0]!.options.body, '#7 插件重载期间')
    assert.equal(notifications[0]!.options.tag, 'helm-conv-7')
    harness.unmount()
  } finally {
    restoreTimings()
    restore()
    focus.restore()
  }
})

test('SW 激活时 completion 与 blocked 通知透传目标会话 url（/#/c/<id>）并可经点击消息跳转', { timeout: 60_000 }, async () => {
  const focus = setPageFocus(false)
  const { restore } = installGrantedNotification()
  const restoreTimings = shrinkTimings(15, 10)
  const originalSwDesc = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
  const shown: Array<{ title: string; options: NotificationOptions & { badge?: string; data?: { url?: string; clickId?: string } } }> = []
  const listeners = new Set<(event: MessageEvent) => void>()
  const fakeReg = {
    active: { state: 'activated' } as ServiceWorker,
    showNotification: async (title: string, options: NotificationOptions = {}) => {
      shown.push({
        title,
        options: options as NotificationOptions & { badge?: string; data?: { url?: string; clickId?: string } },
      })
    },
  } as unknown as ServiceWorkerRegistration
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: {
      register: async () => fakeReg,
      addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
        if (type === 'message') listeners.add(fn)
      },
      removeEventListener: (type: string, fn: (event: MessageEvent) => void) => {
        if (type === 'message') listeners.delete(fn)
      },
    },
  })

  try {
    await registerBrowserNotificationServiceWorker()
    const harness = mountHarness({
      conversations: [
        conv({ id: 5, title: '主任务', status: 'working', stateChangeSeq: 1 }),
        conv({ id: 51, parentConversationId: 5, title: '子会话', status: 'working', stateChangeSeq: 1 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })

    // 1) 子会话 blocked：通知 url 应指向具体 blocked 子会话 #/c/51
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '主任务', status: 'working', stateChangeSeq: 1 }),
        conv({ id: 51, parentConversationId: 5, title: '子会话', status: 'blocked', pendingAskCount: 1, stateChangeSeq: 2, updatedAt: 2_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => shown.length === 1)
    assert.equal(shown[0]!.options.icon, '/icon-192.png')
    assert.equal(shown[0]!.options.badge, '/notification-badge-96.png')
    assert.equal(shown[0]!.options.data?.url, '/#/c/51')
    for (const fn of listeners) {
      fn({ data: { type: 'helm:notification-click', url: '/#/c/51', clickId: shown[0]!.options.data?.clickId } } as MessageEvent)
    }
    assert.deepEqual(harness.openTargetCalls, [{ kind: 'conversation', conversationId: 51 }])

    // 2) 全部完成：通知 url 应指向根会话 #/c/5
    harness.rerender({
      conversations: [
        conv({ id: 5, title: '主任务', status: 'done', stateChangeSeq: 3, updatedAt: 4_000 }),
        conv({ id: 51, parentConversationId: 5, title: '子会话', status: 'done', pendingAskCount: 0, stateChangeSeq: 3, updatedAt: 3_000 }),
      ],
      pluginDocs: { [BADGE_DOC_KEY]: IDLE_BADGE_DOC },
    })
    await waitForCondition(() => shown.length === 2)
    assert.equal(shown[1]!.options.data?.url, '/#/c/5')
    for (const fn of listeners) {
      fn({ data: { type: 'helm:notification-click', url: '/#/c/5', clickId: shown[1]!.options.data?.clickId } } as MessageEvent)
    }
    assert.deepEqual(harness.openTargetCalls, [
      { kind: 'conversation', conversationId: 51 },
      { kind: 'conversation', conversationId: 5 },
    ])
    harness.unmount()
  } finally {
    resetBrowserNotificationServiceWorkerForTest()
    if (originalSwDesc !== undefined) {
      Object.defineProperty(navigator, 'serviceWorker', originalSwDesc)
    } else {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker
    }
    restoreTimings()
    restore()
    focus.restore()
  }
})
