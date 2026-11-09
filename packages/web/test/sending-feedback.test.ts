import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationStatus, ConversationSummary } from '@helm/protocol'
import { sendingPendingVisible } from '../src/conversation/composer-model.js'
import { emptyLiveState } from '../src/lib/live-state.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'

// 与现有 SSR 测试一致，为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

function renderTimeline(status: ConversationStatus, sending: boolean, entries: ConversationEntry[] = [], live?: ConversationLive): string {
  const conversation: ConversationSummary = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status, stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: status === 'blocked' ? 1 : 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => {}
  const store: HelmStoreValue = {
    ...emptyLiveState(),
    conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, groupedUi: groupUiContributions([]),
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark',
    profiles: [], models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
  }
  return renderToString(React.createElement(HelmStoreContext.Provider, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries, sendingPending: sendingPendingVisible(sending, status),
      ...(live ? { live } : {}), onRequestEdit: noop,
    }),
  ))
}

function waitingCount(html: string): number {
  return (html.match(/正在等待响应…/g) ?? []).length
}

test('首条输入请求在途时立即显示一次等待，隐藏空会话引导', { timeout: 60_000 }, () => {
  const html = renderTimeline('idle', true)
  assert.equal(waitingCount(html), 1)
  assert.match(html, /role="status"/)
  assert.doesNotMatch(html, /向助理描述目标/)
  assert.doesNotMatch(html, /msg-human-pill/)
})

test('服务端接管后只保留运行反馈，审批时不显示响应等待', { timeout: 60_000 }, () => {
  assert.equal(waitingCount(renderTimeline('working', true)), 1)
  assert.equal(waitingCount(renderTimeline('working', false)), 1)
  assert.equal(waitingCount(renderTimeline('blocked', true)), 0)
})

test('发送失败或回合结束后不残留等待提示', { timeout: 60_000 }, () => {
  for (const status of ['idle', 'done', 'error'] as const) {
    assert.equal(waitingCount(renderTimeline(status, false)), 0, status)
  }
})

test('工具结束等待下一轮响应时提示持续，回合结束后消失', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ] }] },
    { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call-1',
      toolName: 'bash', content: [{ type: 'text', text: '/tmp' }], isError: false }] },
  ]
  assert.equal(waitingCount(renderTimeline('working', false, entries)), 1)
  assert.equal(waitingCount(renderTimeline('done', false, entries)), 0)
})

test('流式正文按收到的全文显示，运行反馈不重复', { timeout: 60_000 }, () => {
  const html = renderTimeline('working', true, [], {
    conversationId: 1, text: '已收到的完整流式正文', tools: [], updatedAt: 1,
  })
  assert.match(html, /已收到的完整流式正文/)
  assert.equal(waitingCount(html), 1)
})
