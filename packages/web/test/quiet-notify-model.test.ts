/**
 * 「全部空闲 / 等待你的处理」浏览器通知纯函数层测试：
 * - resolveActivitySnapshot：机器活动 = working ∪ 后台 accent 角标（blocked 是
 *   等待人类而非机器活动，不阻止安静）；badge doc 未加载时保持未知不宣称安静；
 * - composeQuietNotification：忙碌周期累计集合 + 最新会话事实组装——子会话沿
 *   parentConversationId 归并到当前存在的最顶层会话（环/缺失父摘要有限终止），
 *   blocked 优先改发「等待你的处理」并跳转最新 blocked 会话，失败如实标注，
 *   机器从未活动（累计为空）不产生通知；
 * - shouldDeliverQuietNotification：偏好/权限/连接/页面失焦门控矩阵。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import {
  composeQuietNotification,
  QUIET_NOTIFICATION_TITLE,
  resolveActivitySnapshot,
  shouldDeliverQuietNotification,
  WAITING_NOTIFICATION_TITLE,
} from '../src/shell/quiet-notify-model.js'
import type { ConversationBackgroundIndex } from '../src/shell/background-activity-model.js'

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
// resolveActivitySnapshot：机器活动 / 等待人类 / badge doc 未知
// ---------------------------------------------------------------------------

test('全 idle 且无后台在途 → 机器安静', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1 }), conv({ id: 2, status: 'done' })],
    background: NO_BACKGROUND,
  })
  assert.equal(snap.quiet, true)
  assert.equal(snap.activeConversationIds.size, 0)
  assert.equal(snap.blockedConversationIds.size, 0)
})

test('working 计入机器活动；blocked 不计入——blocked 是等待人类，不阻止机器停下', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'working' }), conv({ id: 2, status: 'blocked' })],
    background: NO_BACKGROUND,
  })
  assert.deepEqual([...snap.activeConversationIds], [1])
  assert.deepEqual([...snap.blockedConversationIds], [2])
})

test('仅存在 blocked 会话时机器仍是安静（等待人类 ≠ 机器在忙）', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 3, status: 'blocked', pendingAskCount: 1 })],
    background: NO_BACKGROUND,
  })
  assert.equal(snap.quiet, true)
  assert.deepEqual([...snap.blockedConversationIds], [3])
})

test('父会话 idle 但存在后台在途（accent 角标）仍是机器活动——核心场景', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[7, { active: true, summary: '2 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 7, status: 'idle' })], background })
  assert.equal(snap.quiet, false)
  assert.deepEqual([...snap.activeConversationIds], [7])
})

test('blocked 会话名下后台仍在跑（accent）时机器仍在途：后台事实优先于等待人类', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[4, { active: true, summary: '1 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 4, status: 'blocked' })], background })
  assert.equal(snap.quiet, false)
  assert.deepEqual([...snap.activeConversationIds], [4])
  assert.deepEqual([...snap.blockedConversationIds], [4])
})

test('error / done 会话不计入机器活动；后台索引 active=false（历史计数/失败汇总）不构成在途', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[3, { active: false, summary: '3 失败' }]])
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'error', lastError: 'model_error' }), conv({ id: 2, status: 'done' }), conv({ id: 3 })],
    background,
  })
  assert.equal(snap.quiet, true)
})

test('badge doc 未完成首次加载时保持未知：不得据此宣称机器安静', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1 })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: new Set(['builtin:workflow/run-badges']),
  })
  assert.equal(snap.quiet, false)
  assert.equal(snap.activeConversationIds.size, 0, '未知不等于在途，只是无法证明安静')
  const known = resolveActivitySnapshot({
    conversations: [conv({ id: 1 })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: NO_PENDING,
  })
  assert.equal(known.quiet, true)
})

test('badge doc 未知与会话 working 并存时机器确实在途（正向事实优先于未知）', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'working' })],
    background: NO_BACKGROUND,
    pendingBadgeDocs: new Set(['builtin:workflow/run-badges']),
  })
  assert.equal(snap.quiet, false)
  assert.deepEqual([...snap.activeConversationIds], [1])
})

// ---------------------------------------------------------------------------
// composeQuietNotification：全部空闲（无 blocked）
// ---------------------------------------------------------------------------

test('忙碌周期累计为空（机器从未活动，如打开页面即安静）不产生通知', { timeout: 60_000 }, () => {
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set(),
    blockedConversationIds: new Set(),
    conversations: [conv({ id: 1 })],
  })
  assert.equal(draft, null)
})

test('多阶段收尾：整个周期累计的会话都在正文中列出（不只有最后一帧活跃者），primary 取最新安静者', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '修复构建失败', updatedAt: 5_000 }),
    conv({ id: 2, title: '重构侧栏', updatedAt: 9_000, status: 'done' }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1, 2]),
    blockedConversationIds: new Set(),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, QUIET_NOTIFICATION_TITLE)
  assert.equal(draft.body, '#2 重构侧栏 · #1 修复构建失败')
  assert.equal(draft.primaryConversationId, 2)
})

test('纯后台在途结束（父会话全程 idle）同样产生通知并罗列父会话', { timeout: 60_000 }, () => {
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([7]),
    blockedConversationIds: new Set(),
    conversations: [conv({ id: 7, title: '大规模重构', status: 'idle' })],
  })
  assert.ok(draft)
  assert.equal(draft.body, '#7 大规模重构')
  assert.equal(draft.primaryConversationId, 7)
})

test('派生子会话归并到当前存在的最顶层会话：正文不重复列子会话，不抢主要跳转', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '大规模重构', updatedAt: 100 }),
    conv({ id: 12, parentConversationId: 5, updatedAt: 900, title: '子代理 12' }),
    conv({ id: 13, parentConversationId: 5, updatedAt: 800, title: '子代理 13' }),
    conv({ id: 131, parentConversationId: 13, updatedAt: 700, title: '孙代理 131' }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([12, 13, 131]),
    blockedConversationIds: new Set(),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.body, '#5 大规模重构', '三个层级的派生会话归并为唯一根会话条目')
  assert.equal(draft.primaryConversationId, 5)
})

test('父链中途被删除：归并到当前存在的最顶层祖先；祖先全部消失则该会话自身为根', { timeout: 60_000 }, () => {
  const partial = [conv({ id: 11, title: '中间层', updatedAt: 50 }), conv({ id: 111, parentConversationId: 11, title: '孤儿链', updatedAt: 60 })]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([111]),
    blockedConversationIds: new Set(),
    conversations: partial,
  })
  assert.ok(draft)
  assert.equal(draft.body, '#11 中间层')
  assert.equal(draft.primaryConversationId, 11)

  const orphan = composeQuietNotification({
    accumulatedConversationIds: new Set([111]),
    blockedConversationIds: new Set(),
    conversations: [conv({ id: 111, parentConversationId: 11, title: '孤儿链', updatedAt: 60 })],
  })
  assert.ok(orphan)
  assert.equal(orphan.body, '#111 孤儿链')
  assert.equal(orphan.primaryConversationId, 111)
})

test('父链环（脏数据）有限终止：归并到链上某个存在会话，不无限递归', { timeout: 60_000 }, () => {
  const cyclic = [
    conv({ id: 1, parentConversationId: 2, title: '环 A' }),
    conv({ id: 2, parentConversationId: 1, title: '环 B' }),
    conv({ id: 3, parentConversationId: 2, title: '环外会话' }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([3]),
    blockedConversationIds: new Set(),
    conversations: cyclic,
  })
  assert.ok(draft, '环链必须正常返回而非挂死')
  assert.equal(draft.body, '#1 环 A', '归并结果落在环上确定的存在会话（根在前取首个存在者）')
})

test('超过 3 个根会话折叠为「等 N 个会话」（N 为归并后的根会话总数）', { timeout: 60_000 }, () => {
  const conversations = [1, 2, 3, 4, 5].map((id) => conv({ id, updatedAt: id * 100 }))
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1, 2, 3, 4, 5]),
    blockedConversationIds: new Set(),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.body, '#5 会话 5 · #4 会话 4 · #3 会话 3 · 等 5 个会话')
})

test('任一累计会话（含被归并的子会话）为 error 态时正文标注「有失败」', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '父会话', status: 'idle', updatedAt: 100 }),
    conv({ id: 12, parentConversationId: 1, title: '失败子代理', status: 'error', updatedAt: 200 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([12]),
    blockedConversationIds: new Set(),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.body, '#1 父会话 · 有失败')
})

test('累计会话在周期内被删除：通知仍成立但不罗列未知标题，primary 为空', { timeout: 60_000 }, () => {
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([9]),
    blockedConversationIds: new Set(),
    conversations: [],
  })
  assert.ok(draft)
  assert.equal(draft.body, '所有会话与后台任务已结束')
  assert.equal(draft.primaryConversationId, null)
})

// ---------------------------------------------------------------------------
// composeQuietNotification：等待你的处理（存在 blocked）
// ---------------------------------------------------------------------------

test('机器停下但存在 blocked 会话：改发「等待你的处理」，正文明确待处理输入/审批并跳转该会话', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '部署检查', status: 'blocked', pendingAskCount: 1, updatedAt: 500 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1]),
    blockedConversationIds: new Set([1]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, '待处理输入/审批：#1 部署检查')
  assert.equal(draft.primaryConversationId, 1)
})

test('blocked 目标优先于普通根会话：即使累计刚安静的是别的会话，跳转仍给最新 blocked 会话', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '刚收尾的大任务', status: 'done', updatedAt: 900 }),
    conv({ id: 2, title: '等待审批', status: 'blocked', updatedAt: 400 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1]),
    blockedConversationIds: new Set([2]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, '待处理输入/审批：#2 等待审批')
  assert.equal(draft.primaryConversationId, 2, 'blocked 优先于更新更晚的普通根会话')
})

test('blocked 子代理会话：正文归并列根会话，跳转直达子代理会话本身（提问所在处）', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '大规模重构', status: 'idle', updatedAt: 100 }),
    conv({ id: 12, parentConversationId: 5, title: '审批子代理', status: 'blocked', pendingAskCount: 1, updatedAt: 900 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([5, 12]),
    blockedConversationIds: new Set([12]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, WAITING_NOTIFICATION_TITLE)
  assert.equal(draft.body, '待处理输入/审批：#5 大规模重构')
  assert.equal(draft.primaryConversationId, 12)
})

test('多个 blocked 会话按根去重罗列并折叠；跳转给 updatedAt 最新的 blocked 会话', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 5, title: '根甲', status: 'idle', updatedAt: 100 }),
    conv({ id: 51, parentConversationId: 5, title: '甲的子代理', status: 'blocked', updatedAt: 800 }),
    conv({ id: 6, title: '根乙', status: 'blocked', updatedAt: 300 }),
    conv({ id: 7, title: '根丙', status: 'blocked', updatedAt: 500 }),
    conv({ id: 8, title: '根丁', status: 'blocked', updatedAt: 700 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([6]),
    blockedConversationIds: new Set([51, 6, 7, 8]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.body, '待处理输入/审批：#5 根甲 · #8 根丁 · #7 根丙 · 等 4 个待处理')
  assert.equal(draft.primaryConversationId, 51, '最新更新的 blocked 会话（甲的子代理）优先')
})

test('等待处理正文同样如实保留失败：累计会话 error 时标注「有失败」', { timeout: 60_000 }, () => {
  const conversations = [
    conv({ id: 1, title: '失败任务', status: 'error' }),
    conv({ id: 2, title: '等待输入', status: 'blocked', pendingAskCount: 1 }),
  ]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1]),
    blockedConversationIds: new Set([2]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.body, '待处理输入/审批：#2 等待输入 · 有失败')
})

test('blocked 会话在结算前被删除：不再构成等待处理，回落到全部空闲', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1, title: '刚收尾', status: 'done', updatedAt: 900 })]
  const draft = composeQuietNotification({
    accumulatedConversationIds: new Set([1]),
    blockedConversationIds: new Set([2]),
    conversations,
  })
  assert.ok(draft)
  assert.equal(draft.title, QUIET_NOTIFICATION_TITLE)
  assert.equal(draft.primaryConversationId, 1)
})

// ---------------------------------------------------------------------------
// shouldDeliverQuietNotification：投递门控
// ---------------------------------------------------------------------------

const GRANTED_INPUT = {
  authenticated: true,
  preferenceEnabled: true,
  permission: 'granted' as const,
  connected: true,
  pageVisible: false,
  pageFocused: false,
}

test('门控矩阵：偏好/权限/连接任一缺失即拒绝', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification(GRANTED_INPUT), true)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, preferenceEnabled: false }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'denied' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'default' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'unsupported' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, connected: false }), false)
})

test('页面可见且聚焦（用户正看着页面）不投递；失焦或隐藏任一命中即投递', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageVisible: true, pageFocused: true }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageVisible: true, pageFocused: false }), true)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageVisible: false, pageFocused: true }), true)
})
