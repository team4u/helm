/**
 * 排队消息胶囊（steer / followUp）与生成式 UI 按钮闭环测试。
 *
 * 覆盖：
 * 1. buildTimelineItems：live.queuedInputs 尾部胶囊、input.id 去重（原地转正
 *    时 key 不变不重复）、queuedMode 与 origin 透传。
 * 2. ConversationTimeline SSR：steer / followUp 胶囊文案与样式类名。
 * 3. resolveSpecAction：target 省略 / 'current' 用 defaultConversationId；
 *    whenBusy 透传；无默认会话时显式 invalid。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationStatus, ConversationSummary } from '@helm/protocol'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import type { HumanInputItem } from '../src/conversation/timeline-model.js'
import { emptyLiveState } from '../src/lib/live-state.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { parseSendTarget, resolveSpecAction } from '../src/ui/spec-action.js'

// 与现有 SSR 测试一致，为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

// ---------------------------------------------------------------------------
// 1. buildTimelineItems：queuedInputs 尾部胶囊与去重
// ---------------------------------------------------------------------------

test('buildTimelineItems: live.queuedInputs 渲染为尾部胶囊（queuedMode 透传）', { timeout: 60_000 }, () => {
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 99,
    queuedInputs: [
      { id: 'fu-1', submissionId: '31', text: '排队的消息', mode: 'followUp', origin: 'human', createdAt: 2 },
      { id: 'st-1', submissionId: '32', text: '插话的消息', mode: 'steer', origin: 'trigger', createdAt: 3 },
    ],
  }
  const items = buildTimelineItems([], { live })
  const queued = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(queued.length, 2)
  assert.equal(queued[0]!.queuedMode, 'followUp')
  assert.equal(queued[0]!.key, 'human:id:fu-1')
  assert.equal(queued[0]!.entryId, 'queued:31')
  assert.equal(queued[0]!.inputId, 'fu-1')
  assert.equal(queued[0]!.fallback, false)
  assert.equal(queued[1]!.queuedMode, 'steer')
  assert.equal(queued[1]!.origin, 'trigger')
})

test('buildTimelineItems: 排队项落入正式 entries 后按 input.id 去重（原地转正不重复）', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    {
      id: '41',
      kind: 'helm.input',
      data: { id: 'q-1', text: '已转正的排队消息', origin: 'human', createdAt: 2 },
    },
  ]
  const live: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 99,
    // 交接瞬间：同一 input.id 同时出现在 entries 与 queuedInputs。
    queuedInputs: [
      { id: 'q-1', submissionId: '40', text: '已转正的排队消息', mode: 'steer', origin: 'human', createdAt: 2 },
    ],
  }
  const items = buildTimelineItems(entries, { live })
  const humans = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(humans.length, 1, '同 input.id 不重复渲染')
  assert.equal(humans[0]!.key, 'human:id:q-1', '正式 entry 与 queued 共用同一 key（原地转正零闪烁）')
  assert.equal(humans[0]!.queuedMode, undefined, '已落入正式 entries 后不再标记 queuedMode')
  assert.equal(humans[0]!.entryId, '41')
})

test('buildTimelineItems: 无 data.id 的历史 helm.input 仍用 entry.id 作 key', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '7', kind: 'helm.input', data: { text: '旧输入', origin: 'human' } },
  ]
  const items = buildTimelineItems(entries, {})
  const humans = items.filter((i): i is HumanInputItem => i.kind === 'human')
  assert.equal(humans.length, 1)
  assert.equal(humans[0]!.key, 'human:7')
  assert.equal(humans[0]!.inputId, undefined)
})

// ---------------------------------------------------------------------------
// 2. ConversationTimeline SSR：steer / followUp 胶囊
// ---------------------------------------------------------------------------

function renderTimeline(
  status: ConversationStatus,
  live?: ConversationLive,
  entries: ConversationEntry[] = [],
): string {
  const conversation: ConversationSummary = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status, stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => undefined
  const store: HelmStoreValue = {
    ...emptyLiveState(),
    conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, groupedUi: groupUiContributions([]),
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark',
    profiles: [], models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'tasks', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
  }
  return renderToString(React.createElement(HelmStoreContext.Provider, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries,
      ...(live ? { live } : {}), onRequestEdit: noop,
    }),
  ))
}

test('ConversationTimeline: steer 与 followUp 胶囊文案、状态标记与虚线样式类', { timeout: 60_000 }, () => {
  const live: ConversationLive = {
    conversationId: 1,
    text: '流式中',
    tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }],
    updatedAt: 5,
    queuedInputs: [
      { id: 'st-1', submissionId: '10', text: '先看这个报错', mode: 'steer', origin: 'human', createdAt: 1 },
      { id: 'fu-1', submissionId: '11', text: '顺便再跑一次测试', mode: 'followUp', origin: 'human', createdAt: 2 },
    ],
  }
  const html = renderTimeline('working', live)
  assert.match(html, /插话引导 · 待当前步骤后注入/)
  assert.match(html, /排队中 · 待当前回合结束后发送/)
  assert.match(html, /msg-human-pill-queued/)
  assert.match(html, /先看这个报错/)
  assert.match(html, /顺便再跑一次测试/)
  // 待生效胶囊不渲染分叉按钮（无正式 entryId）。
  assert.doesNotMatch(html, /从此消息分叉新会话/)
})

test('ConversationTimeline: 正式消息无 queued 样式，分叉按钮保留', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '9', kind: 'helm.input', data: { id: 'k-1', text: '正式消息', origin: 'human', createdAt: 1 } },
  ]
  const html = renderTimeline('idle', undefined, entries)
  assert.doesNotMatch(html, /msg-human-pill-queued/)
  assert.match(html, /正式消息/)
  assert.match(html, /从此消息分叉新会话/)
})

// ---------------------------------------------------------------------------
// 3. resolveSpecAction：默认当前会话与 whenBusy
// ---------------------------------------------------------------------------

test('parseSendTarget: 仅缺省与显式 current 使用默认会话；空串/空白显式拒绝', { timeout: 60_000 }, () => {
  // 字段缺省（undefined）或显式 current 才回退默认会话；null 是显式提供的非法值。
  assert.equal(parseSendTarget(undefined, 12), 12)
  assert.equal(parseSendTarget('current', 12), 12)
  assert.equal(parseSendTarget('conversation:current', 12), 12)
  assert.equal(parseSendTarget(' conversation:current ', 12), 12)
  assert.equal(parseSendTarget(7, undefined), 7)
  assert.equal(parseSendTarget('conversation:42', undefined), 42)
  assert.equal(parseSendTarget('42', undefined), 42)
  // 空串/空白串（模板求值失败产物）绝不路由到默认会话：发错会话风险。
  assert.equal(parseSendTarget('', 12), null)
  assert.equal(parseSendTarget('   ', 12), null)
  // 无默认会话时省略 target / current 显式拒绝。
  assert.equal(parseSendTarget(undefined, undefined), null)
  assert.equal(parseSendTarget('current', undefined), null)
  assert.equal(parseSendTarget(0, 12), null)
  assert.equal(parseSendTarget(1.5, 12), null)
  assert.equal(parseSendTarget('conversation:abc', 12), null)
  // 非安全整数拒绝。
  assert.equal(parseSendTarget(2 ** 53, 12), null)
  assert.equal(parseSendTarget(Number.MAX_SAFE_INTEGER, undefined), Number.MAX_SAFE_INTEGER)
})

test('resolveSpecAction: helm:send 省略 target 默认当前会话；whenBusy 透传', { timeout: 60_000 }, () => {
  const omitted = resolveSpecAction({ type: 'helm:send', text: '巡检一下' }, {}, 33)
  assert.equal(omitted.kind, 'send')
  if (omitted.kind === 'send') {
    assert.equal(omitted.conversationId, 33)
    assert.equal(omitted.text, '巡检一下')
    assert.equal(omitted.whenBusy, undefined)
  }
  const current = resolveSpecAction({ type: 'helm:send', target: 'current', text: '再来一轮' }, {}, 33)
  assert.equal(current.kind, 'send')
  if (current.kind === 'send') assert.equal(current.conversationId, 33)
  const busy = resolveSpecAction(
    { type: 'helm:send', target: 'current', text: '插话', whenBusy: 'steer' },
    {},
    33,
  )
  assert.equal(busy.kind, 'send')
  if (busy.kind === 'send') assert.equal(busy.whenBusy, 'steer')
  // 显式 target 仍优先生效；非法 whenBusy 显式 invalid（拼写错误不静默丢弃）。
  const explicit = resolveSpecAction(
    { type: 'helm:send', target: 'conversation:9', text: 'x', whenBusy: 'later' },
    {},
    33,
  )
  assert.equal(explicit.kind, 'invalid')
  if (explicit.kind === 'invalid') assert.match(explicit.message, /whenBusy 无效/)
  const legalExplicit = resolveSpecAction({ type: 'helm:send', target: 'conversation:9', text: 'x' }, {}, 33)
  assert.equal(legalExplicit.kind, 'send')
  if (legalExplicit.kind === 'send') assert.equal(legalExplicit.whenBusy, undefined)
  // 模板求值产生空串 target（如 'conversation:{$row.missing}' 求值后路径缺失）：
  // 显式 invalid，绝不静默路由到默认会话（发错会话风险）。
  const blankTarget = resolveSpecAction(
    { type: 'helm:send', target: 'conversation:{$row.missing}', text: 'x' },
    {},
    33,
  )
  assert.equal(blankTarget.kind, 'invalid')
  if (blankTarget.kind === 'invalid') assert.match(blankTarget.message, /target 求值后无效/)
  // 整串模板表达式路径缺失（求值出 undefined）：声明里明确提供了 target，
  // 不得当作省略回退默认会话（浏览器实测 bug：会发错会话）。
  const undefinedTarget = resolveSpecAction(
    { type: 'helm:send', target: '{$row.missing}', text: 'x' },
    {},
    33,
  )
  assert.equal(undefinedTarget.kind, 'invalid')
  if (undefinedTarget.kind === 'invalid') assert.match(undefinedTarget.message, /求值后无效/)
  // 无默认会话且 target 省略：显式 invalid（不猜测 #1）。
  const invalid = resolveSpecAction({ type: 'helm:send', text: 'x' }, {})
  assert.equal(invalid.kind, 'invalid')
  if (invalid.kind === 'invalid') assert.match(invalid.message, /无默认会话/)
})

test('helm:send 显式提供 target 求值失败时绝不回退默认会话（浏览器实测回归）', { timeout: 60_000 }, () => {
  // 场景：卡片声明写了 target: '{$data.missing}'，$data 中无该路径，
  // evaluateSpecValue 整串表达式求值出 undefined。旧实现把它当字段省略
  // 回退 defaultConversationId，导致「不可发送」的消息发到了当前 #7。
  const bug = resolveSpecAction(
    { type: 'helm:send', target: '{$data.missing}', text: '不可发送' },
    {},
    7,
  )
  assert.equal(bug.kind, 'invalid')
  if (bug.kind === 'invalid') {
    assert.match(bug.message, /target 求值后无效/)
    assert.match(bug.message, /undefined/)
  }
  // 同类变体：显式 target 为 null / 空串 / 空白串 / 非法字符串，一律 invalid。
  assert.equal(resolveSpecAction({ type: 'helm:send', target: null, text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: '', text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: '   ', text: 'x' }, {}, 7).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:send', target: 'conversation:', text: 'x' }, {}, 7).kind, 'invalid')
  // 对比：字段真正省略与显式 current 仍回退默认会话。
  assert.equal(resolveSpecAction({ type: 'helm:send', text: 'x' }, {}, 7).kind, 'send')
  const cur = resolveSpecAction({ type: 'helm:send', target: 'current', text: 'x' }, {}, 7)
  assert.equal(cur.kind, 'send')
  if (cur.kind === 'send') assert.equal(cur.conversationId, 7)
  // 求值成功的模板（路径存在，值为正整数）仍正常定向。
  const ok = resolveSpecAction(
    { type: 'helm:send', target: '{$data.targetId}', text: 'x' },
    { $data: { targetId: 9 } },
    7,
  )
  assert.equal(ok.kind, 'send')
  if (ok.kind === 'send') assert.equal(ok.conversationId, 9)
})
