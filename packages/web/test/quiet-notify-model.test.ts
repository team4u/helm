/**
 * Pure-layer tests for background browser notifications settled independently
 * per root-conversation tree:
 * - resolveActivitySnapshot: machine activity merged by root (working ∪
 *   background accent badges ∪ context compaction) and waiting-on-human
 *   (blocked); multiple root trees isolated from each other; badgeUnknown as
 *   the global unknown gate;
 * - composeTreeCompletionNotification: single-tree completion and finish (any
 *   error → "Helm conversation finished" plus "Has failures"); spawned child
 *   conversations merge to the highest surviving ancestor (cycles / missing
 *   parent summaries terminate finitely); an empty accumulation produces no
 *   notice;
 * - composeTreeBlockedNotification: waiting notices ("Helm is waiting for
 *   you"); multiple blocked conversations in one tree dedupe by root and jump
 *   to the most recently updated one; accumulated errors flagged honestly;
 * - getBlockedWatermark: any advance of seq or pendingAskCount yields a new
 *   watermark;
 * - shouldDeliverQuietNotification: the auth/preference/permission/connection/
 *   page-not-foreground-active (!pageActive) gate matrix.
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
// resolveActivitySnapshot: root-tree isolation / machine activity / blocked / badgeUnknown
// ---------------------------------------------------------------------------

test('all idle/done with no background in flight -> empty activity-tree set and badgeUnknown=false', { timeout: 60_000 }, () => {
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1 }), conv({ id: 2, status: 'done' })],
    background: NO_BACKGROUND,
  })
  assert.equal(snap.trees.size, 0)
  assert.equal(snap.badgeUnknown, false)
})

test('multi-root isolation: working and blocked merge into their own root trees; blocked never counts as machine activity', { timeout: 60_000 }, () => {
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

test('an idle parent with background in flight (accent badge) under it merges as that root tree machine activity', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[7, { active: true, summary: '2 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 7, status: 'idle' })], background })
  const tree7 = snap.trees.get(7)
  assert.ok(tree7)
  assert.deepEqual([...tree7.activeConversationIds], [7])
  assert.deepEqual([...tree7.blockedConversationIds], [])
})

test('background still running under a blocked conversation (accent): the same tree records both active and blocked', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[4, { active: true, summary: '1 运行中' }]])
  const snap = resolveActivitySnapshot({ conversations: [conv({ id: 4, status: 'blocked' })], background })
  const tree4 = snap.trees.get(4)
  assert.ok(tree4)
  assert.deepEqual([...tree4.activeConversationIds], [4])
  assert.deepEqual([...tree4.blockedConversationIds], [4])
})

test('error / done conversations never count as machine activity; background index active=false (history counts/failure summaries) is not in flight', { timeout: 60_000 }, () => {
  const background: ConversationBackgroundIndex = new Map([[3, { active: false, summary: '3 失败' }]])
  const snap = resolveActivitySnapshot({
    conversations: [conv({ id: 1, status: 'error', lastError: 'model_error' }), conv({ id: 2, status: 'done' }), conv({ id: 3 })],
    background,
  })
  assert.equal(snap.trees.size, 0)
})

test('with a badge doc still awaiting its first load, badgeUnknown=true (trees still honestly reflect the observed facts)', { timeout: 60_000 }, () => {
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

test('contextUsage.compacting=true counts as that root tree machine activity; once compaction ends it leaves the activity tree and a completion notice can be composed', { timeout: 60_000 }, () => {
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
// composeTreeCompletionNotification: single-tree completion / honest failure distinction
// ---------------------------------------------------------------------------

test('an empty accumulated participant set (machine never active) produces no completion notice', { timeout: 60_000 }, () => {
  const draft = composeTreeCompletionNotification({
    rootId: 1,
    accumulatedConversationIds: new Set(),
    conversations: [conv({ id: 1 })],
  })
  assert.equal(draft, null)
})

test('single-tree successful completion: title "Helm conversation completed", body "#id title", jumps to the root conversation', { timeout: 60_000 }, () => {
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

test('a purely-background cycle ending (parent idle throughout) still produces a completion notice listing the root conversation', { timeout: 60_000 }, () => {
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

test('spawned child conversations merge into the root: children are neither listed separately nor steal the primary jump', { timeout: 60_000 }, () => {
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

test('any accumulated participant (root or child) in error: the title becomes "Helm conversation finished" flagged "Has failures"', { timeout: 60_000 }, () => {
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

test('mid-chain deleted parents and parent cycles: finite merging along surviving ancestors; a fully deleted tree leaves primary null', { timeout: 60_000 }, () => {
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
  assert.ok(cyclicSnap.trees.size > 0, 'a cyclic chain must terminate finitely and return activity trees')

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
// getBlockedWatermark and composeTreeBlockedNotification
// ---------------------------------------------------------------------------

test('getBlockedWatermark: any advance of stateChangeSeq or pendingAskCount yields a new watermark', { timeout: 60_000 }, () => {
  const base = getBlockedWatermark({ stateChangeSeq: 3, pendingAskCount: 1 })
  assert.equal(base, '3:1')
  assert.notEqual(getBlockedWatermark({ stateChangeSeq: 4, pendingAskCount: 1 }), base)
  assert.notEqual(getBlockedWatermark({ stateChangeSeq: 3, pendingAskCount: 2 }), base)
})

test('one blocked conversation in a tree: title "Helm is waiting for you", jumps to that conversation', { timeout: 60_000 }, () => {
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

test('a blocked child agent conversation: the body lists the root title while the jump goes straight to the child itself', { timeout: 60_000 }, () => {
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

test('multiple blocked conversations in one tree dedupe by root; jump to the most recently updated blocked one; accumulated errors flagged honestly', { timeout: 60_000 }, () => {
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

test('returns null when every blocked conversation was already deleted', { timeout: 60_000 }, () => {
  const draft = composeTreeBlockedNotification({
    rootId: 1,
    blockedConversationIds: new Set([2]),
    conversations: [conv({ id: 1, title: '正常根会话', status: 'done' })],
  })
  assert.equal(draft, null)
})

// ---------------------------------------------------------------------------
// shouldDeliverQuietNotification: delivery gating
// ---------------------------------------------------------------------------

const GRANTED_INPUT = {
  authenticated: true,
  preferenceEnabled: true,
  permission: 'granted' as const,
  connected: true,
  pageActive: false,
}

test('gate matrix: any missing auth/preference/permission/connection denies delivery', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification(GRANTED_INPUT), true)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, authenticated: false }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, preferenceEnabled: false }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'denied' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'default' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, permission: 'unsupported' }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, connected: false }), false)
})

test('page foreground-active and focused (pageActive=true) delivers nothing; leaving the foreground or losing focus (pageActive=false) delivers', { timeout: 60_000 }, () => {
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageActive: true }), false)
  assert.equal(shouldDeliverQuietNotification({ ...GRANTED_INPUT, pageActive: false }), true)
})
