import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationDetail, ConversationSummary, HelmSnapshot } from '@helm/protocol'
import { applyEventFrame, applySnapshot, emptyLiveState, entryMatchesReference, mergeConversationDetail, SseParser } from '../src/lib/live-state.js'
import { normalizeModelCatalogInfo } from '../src/lib/api.js'

const conv: ConversationSummary = { id: 1, title: '助理', profileId: 'assistant', cwd: '/tmp', model: '', thinkingLevel: '', status: 'idle', tags: [], stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: true, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }
const snapshot: HelmSnapshot = { seq: 10, conversations: [conv], pendingAsks: [], plugins: [], ui: [], workflowRuns: [] }

test('SSE 分段 CRLF、多 data 行与注释不能丢帧', { timeout: 60_000 }, () => {
  const messages: Array<{ event: string; data: string }> = []
  const parser = new SseParser((message) => messages.push(message))
  parser.push(': heartbeat\r')
  parser.push('\nevent: snapshot\r\ndata: {"seq":\r')
  parser.push('\ndata: 10}\r\n\r')
  parser.push('\nevent: notification\ndata: {"text":"中文"}\n\n')
  assert.deepEqual(messages, [{ event: 'snapshot', data: '{"seq":\n10}' }, { event: 'notification', data: '{"text":"中文"}' }])
})

test('重连快照撤下过时插件文档和详情，重复帧忽略而缺帧要求重新同步', { timeout: 60_000 }, () => {
  const before = { ...emptyLiveState(), pluginDocs: { 'p/index': { old: true } }, conversationDetails: { 1: { ...conv, entries: [] } } }
  const next = applySnapshot(before, snapshot)
  assert.deepEqual(next.pluginDocs, {})
  assert.deepEqual(next.conversationDetails, {})
  assert.equal(applyEventFrame(next, { seq: 10, event: { type: 'conversation.deleted', conversationId: 1 } }), next)
  assert.throws(() => applyEventFrame(next, { seq: 12, event: { type: 'notification', level: 'info', title: 'lost' } }), /不连续/)
  assert.equal(applyEventFrame(next, { seq: 11, event: { type: 'custom', payload: 1 } }).seq, 11)
})

test('HTTP 详情返回时不得覆盖已收到的 SSE 新消息与摘要，历史游标能耗尽', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), snapshot)
  const detail: ConversationDetail = { ...conv, entries: [{ id: '2', kind: 'helm.input' }], nextCursor: 'older' }
  state = mergeConversationDetail(state, detail)
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.entry', conversationId: 1, entry: { id: '3', kind: 'pi.assistant' } } })
  state = applyEventFrame(state, { seq: 12, event: { type: 'conversation.upsert', conversation: { ...conv, title: '新标题' } } })
  state = mergeConversationDetail(state, detail)
  assert.deepEqual(state.conversationDetails[1]?.entries.map((entry) => entry.id), ['2', '3'])
  assert.equal(state.conversationDetails[1]?.title, '新标题')
  state = mergeConversationDetail(state, { ...conv, entries: [{ id: '1', kind: 'helm.input' }] }, true)
  assert.deepEqual(state.conversationDetails[1]?.entries.map((entry) => entry.id), ['1', '2', '3'])
  assert.equal(state.conversationDetails[1]?.nextCursor, undefined)
})

test('同一批到达的 ask.upsert/resolved 记录准确，插件停用清除公开文档', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), snapshot)
  const ask = { id: 'a', conversationId: 1, title: '确认', fields: [], status: 'pending', createdAt: 1 } as const
  state = applyEventFrame(state, { seq: 11, event: { type: 'ask.upsert', ask: { ...ask, fields: [] } } })
  state = applyEventFrame(state, { seq: 12, event: { type: 'ask.resolved', askId: 'a', status: 'superseded' } })
  assert.deepEqual(state.pendingAsks, [])
  assert.equal(state.resolvedAsksByConv[1]?.[0]?.status, 'superseded')
  state = { ...state, pluginDocs: { 'p/doc': { secret: false } } }
  const plugin = { id: 'p', name: 'P', version: '1', enabled: false, locked: false, hooks: [], actions: [], tools: [] }
  state = applyEventFrame(state, { seq: 13, event: { type: 'plugin.changed', plugin, ui: [] } })
  assert.deepEqual(state.pluginDocs, {})
})

test('SSE 消息先于首次 HTTP 详情返回时，补齐详情后仍保留新回复', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), snapshot)
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.entry', conversationId: 1, entry: { id: '5', kind: 'pi.assistant' } } })
  state = mergeConversationDetail(state, { ...conv, entries: [{ id: '4', kind: 'helm.input' }] })
  assert.deepEqual(state.conversationDetails[1]?.entries.map((entry) => entry.id), ['4', '5'])
  assert.deepEqual(state.pendingEntries, {})
})

test('FTS input:/entry: 引用映射到真实时间线 entryId', { timeout: 60_000 }, () => {
  assert.equal(entryMatchesReference({ id: '4', kind: 'helm.input', data: { id: 'submission-1' } }, 'input:submission-1'), true)
  assert.equal(entryMatchesReference({ id: '5', kind: 'pi.assistant' }, 'entry:5'), true)
  assert.equal(entryMatchesReference({ id: '4', kind: 'helm.input', data: { id: 'other' } }, 'input:submission-1'), false)
})

test('模型菜单按真实 /api/models 契约组成 provider/model，思考档位缺省为 off', { timeout: 60_000 }, () => {
  const catalog = normalizeModelCatalogInfo({ models: [
    { provider: 'gateway', modelId: 'family/model', available: true },
    { provider: 'anthropic', modelId: 'claude', available: false },
  ], thinkingLevels: { 'gateway/family/model': ['off', 'low', 'high'] } })
  assert.deepEqual(catalog.models, [
    { id: 'gateway/family/model', provider: 'gateway', modelId: 'family/model', available: true, thinkingLevels: ['off', 'low', 'high'] },
    { id: 'anthropic/claude', provider: 'anthropic', modelId: 'claude', available: false, thinkingLevels: ['off'] },
  ])
  assert.equal(catalog.defaultModel, undefined)
  assert.throws(() => normalizeModelCatalogInfo({ models: [{ id: 'fake' }] }), /无效/)
  assert.throws(() => normalizeModelCatalogInfo([1, 2]), /无效/)
  assert.equal(normalizeModelCatalogInfo({ models: [] }).models.length, 0)
})

test('模型目录携带全局默认模型', { timeout: 60_000 }, () => {
  const catalog = normalizeModelCatalogInfo({ models: [], thinkingLevels: {}, defaultModel: 'magpie/group/smart' })
  assert.equal(catalog.defaultModel, 'magpie/group/smart')
})
