/**
 * 会话失败诊断展示回归测试。
 *
 * 覆盖：
 * 1. ConversationTimeline SSR：status=error 时渲染 role=alert 内联错误块，
 *    内容包含 ConversationSummary.lastError 的具体原因；
 * 2. lastError 空缺时显示明确通用文案，不编造详情；非 error 状态不渲染；
 * 3. 失败卡为最近一条可编辑 human 输入提供「编辑并重发」快捷操作
 *   （复用 lastEditableHumanInput 的安全锚点解析：无可靠锚点时不提供）；
 * 4. conversationStatusTooltip：error 附带 lastError（侧栏红点 tooltip 同源）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { emptyLiveState } from '../src/lib/live-state.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { getSessionDocState, subscribeSessionDoc } from '../src/lib/session-docs.js'
import { conversationStatusTooltip } from '../src/shell/sidebar-model.js'

// 与 edit-resend SSR 测试一致：为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

function baseConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function renderTimelineHtml(conversation: ConversationSummary, entries: ConversationEntry[]): string {
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
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
    subscribeSessionDoc: subscribeSessionDoc,
    getSessionDocState,
    getPluginSessionDoc: asyncNoop,
    retrySessionDoc: noop,
  }
  const editTargets: unknown[] = []
  const html = renderToString(React.createElement(HelmStoreContext.Provider, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries,
      onRequestEdit: (target) => { editTargets.push(target) },
    }),
  ))
  return html
}

test('timeline SSR：error 状态渲染 role=alert 错误块并展示具体 lastError', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    baseConversation({ status: 'error', lastError: 'model_error: provider 503 quota exceeded' }),
    [{ id: '1', kind: 'helm.input', data: { text: '人类提问', origin: 'human' } }],
  )
  // role=alert 可访问错误块存在。
  assert.match(html, /role="alert"/)
  // 内容包含权威 lastError 的具体原因。
  assert.match(html, /本回合失败/)
  assert.match(html, /model_error: provider 503 quota exceeded/)
})

test('timeline SSR：lastError 空缺时仅显示明确通用文案，不编造详情', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    baseConversation({ status: 'error' }),
    [{ id: '1', kind: 'helm.input', data: { text: '人类提问', origin: 'human' } }],
  )
  assert.match(html, /role="alert"/)
  assert.match(html, /本回合失败/)
  assert.match(html, /模型或服务请求未成功/)
})

test('timeline SSR：非 error 状态不渲染失败诊断块', { timeout: 60_000 }, () => {
  const html = renderTimelineHtml(
    baseConversation({ status: 'done' }),
    [{ id: '1', kind: 'helm.input', data: { text: '人类提问', origin: 'human' } }],
  )
  assert.doesNotMatch(html, /本回合失败/)
  assert.doesNotMatch(html, /role="alert"/)
})

test('timeline SSR：失败卡为最近可编辑 human 输入提供编辑并重发；无可靠锚点时不提供', { timeout: 60_000 }, () => {
  // 有可靠 human 输入锚点：提供快捷操作。
  const withHuman = renderTimelineHtml(
    baseConversation({ status: 'error', lastError: 'model_error: boom' }),
    [{ id: '5', kind: 'helm.input', data: { text: '想重发的问题', origin: 'human' } }],
  )
  assert.match(withHuman, /编辑并重发最近一条消息/)

  // 无任何可编辑 human 输入（仅 agent 汇报）：不提供快捷操作，不误编辑旧消息。
  const withoutHuman = renderTimelineHtml(
    baseConversation({ status: 'error', lastError: 'model_error: boom' }),
    [{ id: '5', kind: 'helm.input', data: { text: 'Worker 已完成', origin: 'agent' } }],
  )
  assert.doesNotMatch(withoutHuman, /编辑并重发最近一条消息/)
  assert.match(withoutHuman, /role="alert"/)
})

test('conversationStatusTooltip：error 附带 lastError 诊断摘要', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusTooltip('error'), '异常')
  assert.equal(
    conversationStatusTooltip('error', undefined, 'model_error: provider 503'),
    '异常: model_error: provider 503',
  )
  // 非 error 状态不消费 lastError；working 仍以 doing 为准。
  assert.equal(conversationStatusTooltip('idle', undefined, 'model_error: x'), '空闲')
  assert.equal(conversationStatusTooltip('working', 'bash: running', 'model_error: x'), '运行中: bash: running')
  // lastError 仅空白时不拼接空 detail。
  assert.equal(conversationStatusTooltip('error', undefined, '   '), '异常')
})
