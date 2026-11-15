/**
 * 「全部空闲」浏览器通知纯函数层测试：
 * - resolveActivitySnapshot：五态与会话后台在途索引 → 全局忙碌/安静快照
 *   （blocked 计入忙碌——等待人类输入时系统并未安静）；
 * - composeQuietNotification：仅「忙碌 → 安静」转移产生通知，正文罗列刚
 *   安静会话（折叠、删除不罗列、失败标注、primary 取最新更新）；
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
  type ActivitySnapshot,
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

const QUIET: ActivitySnapshot = { busyConversationIds: new Set(), backgroundConversationIds: new Set(), quiet: true }

function snapshot(partial: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  const merged = { ...QUIET, ...partial }
  const quiet = partial.quiet ?? (merged.busyConversationIds.size === 0 && merged.backgroundConversationIds.size === 0)
  return { ...merged, quiet }
}

// ---------------------------------------------------------------------------
// resolveActivitySnapshot：忙碌判定
// ---------------------------------------------------------------------------

test('全 idle 且无后台在途 → 全局安静', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map()
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 1 }), conv({ id: 2, status: 'done' })], background })
  assert.equal(snap.quiet, true)
  assert.equal(snap.busyConversationIds.size, 0)
  assert.equal(snap.backgroundConversationIds.size, 0)
})

test('working / blocked 主回合均计入忙碌（blocked 是等待人类输入，不算安静）', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map()
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'working' }), conv({ id: 2, status: 'blocked' })],
    background,
  })
  assert.equal(snap.quiet, false)
  assert.deepEqual([...snap.busyConversationIds].sort(), [1, 2])
})

test('父会话 idle 但存在后台在途（accent 角标）仍为忙碌——核心场景', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[7, { active: true, summary: '2 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 7, status: 'idle' })], background })
  assert.equal(snap.quiet, false)
  assert.deepEqual([...snap.backgroundConversationIds], [7])
  assert.deepEqual([...snap.busyConversationIds], [])
})

test('error / done 会话不计入忙碌（回合已结束，失败由通知正文标注）', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map()
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'error', lastError: 'model_error' }), conv({ id: 2, status: 'done' })],
    background,
  })
  assert.equal(snap.quiet, true)
})

test('后台索引标记 active=false（历史计数/失败汇总）不构成在途', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[3, { active: false, summary: '3 失败' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 3 })], background })
  assert.equal(snap.quiet, true)
})

// ---------------------------------------------------------------------------
// composeQuietNotification：转移与文案
// ---------------------------------------------------------------------------

test('仅忙碌 → 安静转移产生通知：安静 → 安静与忙碌 → 忙碌均返回 null', { timeout: 60_000 }, () => {
  const conversations = [conv({ id: 1 })]
  assert.equal(composeQuietNotification(QUIET, QUIET, conversations), null)
  const busy = snapshot({ busyConversationIds: new Set([1]) })
  assert.equal(composeQuietNotification(busy, snapshot({ busyConversationIds: new Set([2]) }), conversations), null)
})

test('主回合安静转移：罗列刚安静会话，primary 取 updatedAt 最新者', { timeout: 60_000 }, () => {
  const prev = snapshot({ busyConversationIds: new Set([1, 2]) })
  const next = QUIET
  const conversations = [
    conv({ id: 1, title: '修复构建失败', updatedAt: 5_000 }),
    conv({ id: 2, title: '重构侧栏', updatedAt: 9_000, status: 'done' }),
  ]
  const draft = composeQuietNotification(prev, next, conversations)
  assert.ok(draft)
  assert.equal(draft.title, QUIET_NOTIFICATION_TITLE)
  assert.equal(draft.body, '#2 重构侧栏 · #1 修复构建失败')
  assert.equal(draft.primaryConversationId, 2)
})

test('纯后台在途结束（主会话全程 idle）同样产生通知并罗列父会话', { timeout: 60_000 }, () => {
  const prev = snapshot({ backgroundConversationIds: new Set([7]) })
  const draft = composeQuietNotification(prev, QUIET, [conv({ id: 7, title: '大规模重构', status: 'idle' })])
  assert.ok(draft)
  assert.equal(draft.body, '#7 大规模重构')
  assert.equal(draft.primaryConversationId, 7)
})

test('超过 3 个刚安静会话折叠为「等 N 个会话」（N 为总数）', { timeout: 60_000 }, () => {
  const prev = snapshot({ busyConversationIds: new Set([1, 2, 3, 4, 5]) })
  const conversations = [1, 2, 3, 4, 5].map((id) => conv({ id, updatedAt: id * 100 }))
  const draft = composeQuietNotification(prev, QUIET, conversations)
  assert.ok(draft)
  assert.equal(draft.body, '#5 会话 5 · #4 会话 4 · #3 会话 3 · 等 5 个会话')
})

test('任一刚安静会话为 error 态时正文标注「有失败」', { timeout: 60_000 }, () => {
  const prev = snapshot({ busyConversationIds: new Set([1, 2]) })
  const conversations = [
    conv({ id: 1, title: '成功任务', status: 'done' }),
    conv({ id: 2, title: '失败任务', status: 'error' }),
  ]
  const draft = composeQuietNotification(prev, QUIET, conversations)
  assert.ok(draft)
  assert.ok(draft.body.includes('有失败'))
})

test('忙碌会话在窗口内被删除：转移仍成立但不罗列未知标题', { timeout: 60_000 }, () => {
  const prev = snapshot({ busyConversationIds: new Set([9]) })
  const draft = composeQuietNotification(prev, QUIET, [])
  assert.ok(draft)
  assert.equal(draft.body, '所有会话与后台任务已结束')
  assert.equal(draft.primaryConversationId, null)
})

// ---------------------------------------------------------------------------
// shouldDeliverQuietNotification：投递门控
// ---------------------------------------------------------------------------

const GRANTED_INPUT = {
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
