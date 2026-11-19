import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationStatus, ConversationSummary } from '@helmx/protocol'
import { sendingPendingVisible } from '../src/conversation/composer-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

// Provide React for the classic JSX transform in .tsx, same as the existing SSR tests.
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
  const store = makeTestStore({
conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, uiContributions: [],
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark', locale: 'en', quietNotifyEnabled: false,
    profiles: [], profilesLoaded: true, assetsLoaded: true, models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: []
  })
  return renderToString(React.createElement(HostStoreProviders, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries, sendingPending: sendingPendingVisible(sending, status),
      ...(live ? { live } : {}), onRequestEdit: noop,
    }),
  ))
}

function waitingCount(html: string): number {
  return (html.match(/aria-label="Generating"/g) ?? []).length
}

test('shows one wait indicator while the first input request is in flight and hides the empty-conversation intro', { timeout: 60_000 }, () => {
  const html = renderTimeline('idle', true)
  assert.equal(waitingCount(html), 1)
  assert.match(html, /role="status"/)
  assert.match(html, /msg-live-waiting/)
  assert.match(html, /msg-live-dots/)
  assert.doesNotMatch(html, /spin-slow/)
  assert.match(html, /msg-live-label[^>]*>Generating</)
  assert.doesNotMatch(html, /正在等待响应…/)
  assert.doesNotMatch(html, /向助理描述目标/)
  assert.doesNotMatch(html, /timeline-center-slot/)
  assert.doesNotMatch(html, /msg-human-pill/)
})

test('keeps only the running feedback once the server takes over; no response wait during approvals', { timeout: 60_000 }, () => {
  assert.equal(waitingCount(renderTimeline('working', true)), 1)
  assert.equal(waitingCount(renderTimeline('working', false)), 1)
  assert.equal(waitingCount(renderTimeline('blocked', true)), 0)
})

test('no wait hint lingers after a failed send or a finished turn', { timeout: 60_000 }, () => {
  for (const status of ['idle', 'done', 'error'] as const) {
    assert.equal(waitingCount(renderTimeline(status, false)), 0, status)
  }
})

test('wait hint persists between a tool end and the next response, gone once the turn ends', { timeout: 60_000 }, () => {
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

test('streamed body shows the full received text; running feedback is not duplicated', { timeout: 60_000 }, () => {
  const html = renderTimeline('working', true, [], {
    conversationId: 1, text: '已收到的完整流式正文', tools: [], updatedAt: 1,
  })
  assert.match(html, /已收到的完整流式正文/)
  assert.equal(waitingCount(html), 1)
  assert.match(html, /msg-live-indicator/)
  assert.match(html, /msg-live-dots/)
  assert.doesNotMatch(html, /spin-slow/)
  assert.doesNotMatch(html, /msg-live-waiting/)
})
