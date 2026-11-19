import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry, ConversationLive, ConversationSummary } from '@helmx/protocol'
import { buildTimelineItems } from '../src/conversation/timeline-model.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const queued: NonNullable<ConversationLive['queuedInputs']>[number] = {
  id: 'queued-1', submissionId: '10', text: '补充说明', mode: 'followUp', origin: 'human', createdAt: 1,
}
const entry: ConversationEntry = { id: '11', kind: 'helmx.input', data: { ...queued } }

function render(live: ConversationLive): string {
  const conversation: ConversationSummary = {
    id: 1, profileId: 'assistant', title: '测试', tags: [], cwd: '/tmp', model: 'faux/faux-1', thinkingLevel: 'off',
    status: 'working', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
  const store = makeTestStore({
    conversationDetails: { 1: { ...conversation, entries: [] } },
  })
  return renderToString(React.createElement(HostStoreProviders, { value: store },
    React.createElement(ConversationTimeline, { conversation, detailEntries: [], live, onRequestEdit: () => {} })))
}

test('实时回复后跟排队胶囊时只显示一次响应等待，不给队列制造第二个模型回合', { timeout: 60_000 }, () => {
  const html = render({ conversationId: 1, text: '当前回复', tools: [], queuedInputs: [queued], updatedAt: 1 })
  assert.equal((html.match(/aria-label="Generating"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /正在等待响应…/)
  assert.match(html, /Withdraw queue and edit/)
})

test('只有排队项尚无正文时仍显示一次执行等待', { timeout: 60_000 }, () => {
  const html = render({ conversationId: 1, text: '', tools: [], queuedInputs: [queued], updatedAt: 1 })
  assert.equal((html.match(/aria-label="Generating"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /正在等待响应…/)
})

test('输入被插件时间线接管后，同身份队列快照不重复显示', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([entry], {
    live: { conversationId: 1, text: '', tools: [], queuedInputs: [queued], updatedAt: 1 },
    timelineRenderers: [{ pluginId: 'test:render', spec: { id: 'input-card', kinds: ['helmx.input'], client: { module: 'index.tsx', export: 'InputCard' } } }],
  })
  assert.equal(items.filter((item) => item.kind === 'plugin-card').length, 1)
  assert.equal(items.filter((item) => item.kind === 'human').length, 0)
})

test('失败回合保留队列快照时不复活历史助手执行态', { timeout: 60_000 }, () => {
  const history: ConversationEntry[] = [{
    id: '9', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '此前回答' }] }],
  }]
  const items = buildTimelineItems(history, {
    working: false,
    live: { conversationId: 1, text: '', tools: [], queuedInputs: [queued], updatedAt: 1 },
  })
  const turn = items.find((item) => item.kind === 'assistant')
  assert.equal(turn?.live, false)
  assert.equal(items.filter((item) => item.kind === 'human').length, 1)
})

test('队列转为正式输入时稳定 key 相同，且保留两条文字相同但身份不同的输入', { timeout: 60_000 }, () => {
  const live: ConversationLive = { conversationId: 1, text: '', tools: [], queuedInputs: [queued], updatedAt: 1 }
  const before = buildTimelineItems([], { live })
  const during = buildTimelineItems([entry], { live })
  const after = buildTimelineItems([entry])
  assert.equal(before[0]?.key, during[0]?.key)
  assert.equal(during[0]?.key, after[0]?.key)
  assert.equal(during.length, 1)
  const sameText = buildTimelineItems([entry], { live: { ...live, queuedInputs: [{ ...queued, id: 'another-input', submissionId: '12' }] } })
  assert.equal(sameText.filter((item) => item.kind === 'human').length, 2)
})
