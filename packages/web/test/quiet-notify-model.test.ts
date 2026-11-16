/**
 * 按根会话树独立结算的后台浏览器通知纯函数层测试：
 * - resolveActivitySnapshot：按根归并机器活动（working ∪ 后台 accent 角标 ∪
 *   上下文精简）与等待人类（blocked），多根树互相隔离，badgeUnknown 为全局未知门控；
 * - composeTreeCompletionNotification：单根树完成与结束（error → 「Helm 会话已结束」
 *   并附「有失败」），派生子会话归并到当前存活最高祖先（环/缺失父摘要有限终止），
 *   累计为空不产生通知；
 * - composeTreeBlockedNotification：等待处理通知（「Helm 等待你的处理」），同树多
 *   blocked 按根去重并跳转 updatedAt 最新会话，累计有 error 时如实标注「有失败」；
 * - getBlockedWatermark：seq 与 pendingAskCount 任一推进即产生新水位；
 * - shouldDeliverQuietNotification：认证/偏好/权限/连接/页面非前台活跃（!pageActive）门控矩阵。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import {
  COMPLETED_NOTIFICATION_TITLE,
  composeTreeBlockedNotification,
  composeTreeCompletionNotification,
  ENDED_NOTIFICATION_TITLE,
  getBlockedWatermark,
  resolveActivitySnapshot,
  shouldDeliverQuietNotification,
  WAITING_NOTIFICATION_TITLE,
} from '../src/shell/quiet-notify-model.js'
import {
  summarizeConversationBackgroundActivity,
  type ConversationBackgroundIndex,
} from '../src/shell/background-activity-model.js'

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

const NO_BACKGROUND: ConversationBackgroundIndex = new Map()
const NO_PENDING = new Set<string>()

// ---------------------------------------------------------------------------
// resolveActivitySnapshot：按根会话树隔离 / 机器活动 / blocked / badgeUnknown
// ---------------------------------------------------------------------------

test('全 idle/done 且无后台在途 → 活动树集合为空且 badgeUnknown=false', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1 }), conv({ id: 2, status: 'done' })],
    background: NO_BACKGROUND,
  })
  assert.equal(snap.trees.size, 0)
  assert.equal(snap.badgeUnknown, false)
})

test('多根树隔离：working 与 blocked 分别归并到各自根树；blocked 不计入机器活动', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [
      conv({ id: 1, status: 'working' }),
      conv({ id: 11, parentConversationId: 1, status: 'idle' }),
      conv({ id: 2, status: 'idle' }),
      conv({ id: 21, parentConversationId: 2, status: 'blocked', pendingAskCount: 1 }),
      conv({ id: 3, status: 'done' }),
    ],
    background: NO_BACKGROUND,
  })
  assert.equal(snap.trees.size, 2)
  const tree1 = snap.trees.get(1)
  assert.ok(tree1)
  assert.deepEqual([...tree1.activeConversationIds], [1])
  assert.deepEqual([...tree1.blockedConversationIds], [])

  const tree2 = snap.trees.get(2)
  assert.ok(tree2)
  assert.deepEqual([...tree2.activeConversationIds], [])
  assert.deepEqual([...tree2.blockedConversationIds], [21])
  assert.equal(snap.trees.has(3), false)
})

test('父会话 idle 但名下存在后台在途（accent 角标）归并为该根树机器活动', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[7, { active: true, summary: '2 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 7, status: 'idle' })], background })
  const tree7 = snap.trees.get(7)
  assert.ok(tree7)
  assert.deepEqual([...tree7.activeConversationIds], [7])
  assert.deepEqual([...tree7.blockedConversationIds], [])
})

test('blocked 会话名下后台仍在跑（accent）：同树同时记录 active 与 blocked', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[4, { active: true, summary: '1 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 4, status: 'blocked' })], background })
  const tree4 = snap.trees.get(4)
  assert.ok(tree4)
  assert.deepEqual([...tree4.activeConversationIds], [4])
  assert.deepEqual([...tree4.blockedConversationIds], [4])
})

test('error / done 会话不计入机器活动；后台索引 active=false（历史计数/失败汇总）不构成在途', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[3, { active: false, summary: '3 失败' }]])
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'error', lastError: 'model_error' }), conv({ id: 2, status: 'done' }), conv({ id: 3 })],
    background,
  })
  assert.equal(snap.trees.size, 0)
})

test('badge doc 未完成首次加载时 badgeUnknown=true（trees 仍如实反映已观测事实）', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1 })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: new Set(['builtin:workflow/run-badges']),
  })
  assert.equal(snap.badgeUnknown, true)
  assert.equal(snap.trees.size, 0)

  const known = resolveActivitySnapshot({
    conversations: [conv({ id: 1 })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: NO_PENDING,
  })
  assert.equal(known.badgeUnknown, false)
  assert.equal(known.trees.size, 0)

  const workingWithUnknown = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'working' })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: new Set(['builtin:workflow/run-badges']),
  })
  assert.equal(workingWithUnknown.badgeUnknown, true)
  assert.deepEqual([...(workingWithUnknown.trees.get(1)?.activeConversationIds ?? [])], [1])
})

test('contextUsage.compacting=true 计入该根树机器活动，精简完成后移出活动树并可组装完成通知', { timeout: 60_000 }, () => {
  const compactingConvs = [
    conv({ id: 7, title: '长会话', status: 'idle', contextUsage: { tokens: 4000, compacting: true }, updatedAt: 1000 }),
  ]
  const busySnap = resolveActivitySnapshot({
    conversations: compactingConvs,
    background: summarizeConversationBackgroundActivity({
      panels: [],
      conversations: compactingConvs,
      pluginDocs: {},
    }),
  })
  assert.deepEqual([...(busySnap.trees.get(7)?.activeConversationIds ?? [])], [7])

  const blockedCompacting = [
    conv({ id: 8, title: '待审批且精简', status: 'blocked', contextUsage: { tokens: 4000, compacting: true } }),
  ]
  const blockedSnap = resolveActivitySnapshot({
    conversations: blockedCompacting,
    background: summarizeConversationBackgroundActivity({
      panels: [],
      conversations: blockedCompacting,
      pluginDocs: {},
    }),
  })
  assert.deepEqual([...(blockedSnap.trees.get(8)?.activeConversationIds ?? [])], [8])
  assert.deepEqual([...(blockedSnap.trees.get(8)?.blockedConversationIds ?? [])], [8])

  const finishedConvs = [
    conv({ id: 7, title: '长会话', status: 'idle', contextUsage: { tokens: 1200, compacting: false }, updatedAt: 2000 }),
  ]
  const quietSnap = resolveActivitySnapshot({
    conversations: finishedConvs,
    background: summarizeConversationBackgroundActivity({
      panels: [],
      conversations: finishedConvs,
      pluginDocs: {},
    }),
  })
  assert.equal(quietSnap.trees.size, 0)

  const draft = composeTreeCompletionNotification({
    rootId: 7,
    accumulatedConversationIds: busySnap.trees.get(7)!.activeConversationIds,
    conversations: finishedConvs,
  })
  assert.ok(draft)
  assert.equal(draft.title, COMPLETED_NOTIFICATION_TITLE)
  assert.equal(draft.body, '#7 长会话')
  assert.equal(draft.primaryConversationId, 7)
})

// ---------------------------------------------------------------------------
// composeTreeCompletionNotification：单根树完成 / 失败如实区分
// ---------------------------------------------------------------------------

test('累计参与者为空（机器从未活动）不产生完成通知', { timeout: 60_000 }, () => {
  const draft = composeTreeCompletionNotification({
    rootId: 1,
    accumulatedConversationIds: new Set(),
    conversations: [conv({ id: 1 })],
  })
  assert.equal(draft, null)
})

test('单根树成功完成：标题「Helm 会话已完成」，正文「#id 标题」，跳转根会话', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 2, title: '重构侧栏', updatedAt: 9_000, status: 'done' }),
    conv({ id: 1, title: '并行中的另一棵树', updatedAt: 5_000, status: 'working' }),
  ]
  const draft = composeTreeCompletionNotification({
    rootId: 2,
    accumulatedConversationIds: new Set([2]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, COMPLETED_NOTIFICATION_TITLE)
  assert.equal(draft.title, 'Helm conversation completed')
  assert.equal(draft.body, '#2 重构侧栏')
  assert.equal(draft.primaryConversationId, 2)
})

test('纯后台在途结束（父会话全程 idle）同样产生完成通知并罗列根会话', { timeout: 60_000 }, () => {
  const draft = composeTreeCompletionNotification({
    rootId: 7,
    accumulatedConversationIds: new Set([7]),
    conversations: [conv({ id: 7, title: '大规模重构', status: 'idle' })],
  })
  assert.ok(draft)
  assert.equal(draft.title, COMPLETED_NOTIFICATION_TITLE)
  assert.equal(draft.body, '#7 大规模重构')
  assert.equal(draft.primaryConversationId, 7)
})

test('派生子会话归并到根会话：子会话不单独列出也不抢主要跳转', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '大规模重构', updatedAt: 100 }),
    conv({ id: 12, parentConversationId: 5, updatedAt: 900, title: '子代理 12', status: 'done' }),
    conv({ id: 13, parentConversationId: 5, updatedAt: 800, title: '子代理 13', status: 'done' }),
    conv({ id: 131, parentConversationId: 13, updatedAt: 700, title: '孙代理 131', status: 'done' }),
  ]
  const draft = composeTreeCompletionNotification({
    rootId: 5,
    accumulatedConversationIds: new Set([12, 13, 131]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, COMPLETED_NOTIFICATION_TITLE)
  assert.equal(draft.body, '#5 大规模重构')
  assert.equal(draft.primaryConversationId, 5)
})

test('任一累计参与者（根或子会话）处于 error 态：标题改为「Helm 会话已结束」并标注「有失败」', { timeout: 60_000 }, () => {
  const childFailed = composeTreeCompletionNotification({
    rootId: 1,
    accumulatedConversationIds: new Set([1, 12]),
    conversations: [
      conv({ id: 1, title: '父会话', status: 'done', updatedAt: 100 }),
      conv({ id: 12, parentConversationId: 1, title: '失败子代理', status: 'error', updatedAt: 200 }),
    ],
  })
  assert.ok(childFailed)
  assert.equal(childFailed.title, ENDED_NOTIFICATION_TITLE)
  assert.equal(childFailed.title, 'Helm conversation finished')
  assert.equal(childFailed.body, '#1 父会话 · Has failures')
  assert.equal(childFailed.primaryConversationId, 1)

  const rootFailed = composeTreeCompletionNotification({
    rootId: 2,
    accumulatedConversationIds: new Set([2]),
    conversations: [conv({ id: 2, title: '失败主会话', status: 'error', updatedAt: 300 })],
  })
  assert.ok(rootFailed)
  assert.equal(rootFailed.title, ENDED_NOTIFICATION_TITLE)
  assert.equal(rootFailed.body, '#2 失败主会话 · Has failures')
})

test('父链中途被删除与父链环：沿存活祖先有限归并；整树均被删除则 primary 为空', { timeout: 60_000 }, () => {
  const partial = [
    conv({ id: 11, title: '中间层', updatedAt: 50 }),
    conv({ id: 111, parentConversationId: 11, title: '孤儿链', updatedAt: 60 }),
  ]
  const snapPartial = resolveActivitySnapshot({
    conversations: [partial[0]!, { ...partial[1]!, status: 'working' }],
    background: NO_BACKGROUND,
  })
  assert.ok(snapPartial.trees.has(11))

  const draftPartial = composeTreeCompletionNotification({
    rootId: 5,
    accumulatedConversationIds: new Set([111]),
    conversations: partial,
  })
  assert.ok(draftPartial)
  assert.equal(draftPartial.body, '#11 中间层')
  assert.equal(draftPartial.primaryConversationId, 11)

  const cyclic = [
    conv({ id: 1, parentConversationId: 2, title: '环 A', status: 'working' }),
    conv({ id: 2, parentConversationId: 1, title: '环 B' }),
    conv({ id: 3, parentConversationId: 2, title: '环外会话', status: 'working' }),
  ]
  const cyclicSnap = resolveActivitySnapshot({ conversations: cyclic, background: NO_BACKGROUND })
  assert.ok(cyclicSnap.trees.size > 0, '环链必须有限终止并返回活动树')

  const deletedDraft = composeTreeCompletionNotification({
    rootId: 9,
    accumulatedConversationIds: new Set([9]),
    conversations: [],
  })
  assert.ok(deletedDraft)
  assert.equal(deletedDraft.title, COMPLETED_NOTIFICATION_TITLE)
  assert.equal(deletedDraft.body, 'Conversation finished')
  assert.equal(deletedDraft.primaryConversationId, null)
})

// ---------------------------------------------------------------------------
// getBlockedWatermark 与 composeTreeBlockedNotification
// ---------------------------------------------------------------------------

test('getBlockedWatermark：stateChangeSeq 或 pendingAskCount 任一推进即生成新水位', { timeout: 60_000 }, () => {
  const base = getBlockedWatermark({ stateChangeSeq: 3, pendingAskCount: 1 })
  assert.equal(base, '3:1')
  assert.notEqual(getBlockedWatermark({ stateChangeSeq: 4, pendingAskCount: 1 }), base)
  assert.notEqual(getBlockedWatermark({ stateChangeSeq: 3, pendingAskCount: 2 }), base)
})

test('树内单个 blocked 会话：标题「Helm 等待你的处理」，跳转该会话', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '部署检查', status: 'blocked', pendingAskCount: 1, updatedAt: 500 }),
  ]
  const draft = composeTreeBlockedNotification({
    rootId: 1,
    blockedConversationIds: new Set([1]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, 'Pending input/approvals: #1 部署检查')
  assert.equal(draft.primaryConversationId, 1)
})

test('blocked 子代理会话：正文列根会话标题，跳转直达子代理会话本身', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '大规模重构', status: 'idle', updatedAt: 100 }),
    conv({ id: 12, parentConversationId: 5, title: '审批子代理', status: 'blocked', pendingAskCount: 1, updatedAt: 900 }),
  ]
  const draft = composeTreeBlockedNotification({
    rootId: 5,
    blockedConversationIds: new Set([12]),
    accumulatedConversationIds: new Set([5, 12]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, 'Pending input/approvals: #5 大规模重构')
  assert.equal(draft.primaryConversationId, 12)
})

test('同树内多个 blocked 会话按根去重；跳转 updatedAt 最新的 blocked 会话；累计 error 时如实标注', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '大规模重构', status: 'idle', updatedAt: 100 }),
    conv({ id: 51, parentConversationId: 5, title: '子代理甲', status: 'blocked', pendingAskCount: 1, updatedAt: 800 }),
    conv({ id: 52, parentConversationId: 5, title: '子代理乙', status: 'blocked', pendingAskCount: 1, updatedAt: 950 }),
    conv({ id: 53, parentConversationId: 5, title: '失败子代理', status: 'error', updatedAt: 700 }),
  ]
  const draft = composeTreeBlockedNotification({
    rootId: 5,
    blockedConversationIds: new Set([51, 52]),
    accumulatedConversationIds: new Set([5, 51, 52, 53]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, 'Pending input/approvals: #5 大规模重构 · Has failures')
  assert.equal(draft.primaryConversationId, 52)
})

test('blocked 会话均已被删除时返回 null', { timeout: 60_000 }, () => {
  const draft = composeTreeBlockedNotification({
    rootId: 1,
    blockedConversationIds: new Set([2]),
    conversations: [conv({ id: 1, title: '正常根会话', status: 'done' })],
  })
  assert.equal(draft, null)
})

// ---------------------------------------------------------------------------
// shouldDeliverQuietNotification：投递门控
// ---------------------------------------------------------------------------

const GRANTED_INPUT = {
  authenticated: true,
  preferenceEnabled: true,
  permission: 'granted' as const,
  connected: true,
  pageActive: false,
}

test('门控矩阵：认证/偏好/权限/连接任一缺失即拒绝', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification(GRANTED_INPUT), true)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, authenticated: false }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, preferenceEnabled: false }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'denied' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'default' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'unsupported' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, connected: false }), false)
})

test('页面前台活跃聚焦（pageActive=true）不投递；离开前台或失焦（pageActive=false）即投递', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageActive: true }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageActive: false }), true)
})
