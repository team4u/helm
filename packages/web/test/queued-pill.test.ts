/**
 * 排队消息胶囊（steer / followUp）测试。
 *
 * 覆盖：
 * 1. buildTimelineItems：live.queuedInputs 尾部胶囊、input.id 去重（原地转正
 *    时 key 不变不重复）、queuedMode 与 origin 透传。
 * 2. ConversationTimeline SSR：steer / followUp 胶囊文案与样式类名。
 *（helm:send 求值测试已迁 packages/kernel/test/json-render-send-target.test.ts）
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
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'

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
    profiles: [], assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, openSpace: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc: subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
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
