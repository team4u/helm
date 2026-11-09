import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationDetail, ConversationLive, ConversationSummary, HelmSnapshot } from '@helm/protocol'
import { applyEventFrame, applySnapshot, emptyLiveState, entryMatchesReference, mergeConversationDetail, sortNodes, SseParser } from '../src/lib/live-state.js'
import { normalizeModelCatalogInfo } from '../src/lib/api.js'
import type { NodeInfo } from '@helm/protocol'

const conv: ConversationSummary = { id: 1, title: '助理', profileId: 'assistant', cwd: '/tmp', model: '', thinkingLevel: '', status: 'idle', tags: [], stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: true, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }
const snapshot: HelmSnapshot = { seq: 10, conversations: [conv], pendingAsks: [], plugins: [], ui: [] }

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

test('快照 pluginDocs 直投写入 pluginDocs 映射，非法形状显式拒绝', { timeout: 60_000 }, () => {
  const state = applySnapshot(emptyLiveState(), {
    ...snapshot,
    pluginDocs: [
      { pluginId: 'builtin:workflow', name: 'runs', value: { runs: [] } },
      { pluginId: 'p2', name: 'index', value: 42 },
    ],
  })
  assert.deepEqual(state.pluginDocs, {
    'builtin:workflow/runs': { runs: [] },
    'p2/index': 42,
  })
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, pluginDocs: 'bad' as unknown }), /无效/)
  assert.throws(
    () => applySnapshot(emptyLiveState(), { ...snapshot, pluginDocs: [{ pluginId: 1, name: 'x', value: null } as unknown] }),
    /无效/,
  )
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

const localNode: NodeInfo = { id: 'local', kind: 'local', online: true }
const gpuNode: NodeInfo = { id: 'gpu-box', kind: 'byom', online: false }

const nodesSnapshot: HelmSnapshot = {
  ...snapshot,
  nodes: [gpuNode, localNode],
}

test('快照 nodes 写入 live.nodes，local 恒在首项且其余按 id 稳定排列', { timeout: 60_000 }, () => {
  const state = applySnapshot(emptyLiveState(), nodesSnapshot)
  assert.deepEqual(state.nodes.map((n) => n.id), ['local', 'gpu-box'])
  // 缺 nodes 字段时不报错，回退为空。
  const bare = applySnapshot(emptyLiveState(), snapshot)
  assert.deepEqual(bare.nodes, [])
  // sortNodes：local 置顶、其余稳定。
  const bNode: NodeInfo = { id: 'b', kind: 'byom', online: false }
  const aNode: NodeInfo = { id: 'a', kind: 'byom', online: false }
  assert.deepEqual(sortNodes([bNode, localNode, aNode]).map((n) => n.id), ['local', 'a', 'b'])
})

test('node.changed 事件：上线 upsert、离线更新、removed 移除', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), nodesSnapshot)
  // 上线：upsert 并保留 local 首项。
  state = applyEventFrame(state, {
    seq: 11,
    event: { type: 'node.changed', node: { ...gpuNode, online: true, hostname: 'gpu' } },
  })
  assert.deepEqual(state.nodes.map((n) => n.id), ['local', 'gpu-box'])
  assert.equal(state.nodes[1]?.online, true)
  assert.equal(state.nodes[1]?.hostname, 'gpu')
  // 离线（无 removed）：仍在列表中。
  state = applyEventFrame(state, {
    seq: 12,
    event: { type: 'node.changed', node: { ...gpuNode, online: false } },
  })
  assert.equal(state.nodes.length, 2)
  assert.equal(state.nodes[1]?.online, false)
  // removed: true：从列表移除。
  state = applyEventFrame(state, {
    seq: 13,
    event: { type: 'node.changed', node: { id: 'gpu-box', kind: 'byom', online: false }, removed: true },
  })
  assert.deepEqual(state.nodes.map((n) => n.id), ['local'])
  // 新节点注册：追加并保持 local 首项。
  state = applyEventFrame(state, {
    seq: 14,
    event: { type: 'node.changed', node: { id: 'macbook-pro', kind: 'byom', online: true } },
  })
  assert.equal(state.nodes[0]?.id, 'local')
  assert.deepEqual(state.nodes.map((n) => n.id), ['local', 'macbook-pro'])
})

// ---------------------------------------------------------------------------
// snapshot.conversationLives：重连恢复与终态交接边界
// ---------------------------------------------------------------------------

const queuedLive: ConversationLive = {
  conversationId: 1,
  text: '',
  tools: [],
  queuedInputs: [
    { id: 'req-1', submissionId: '12', text: '插话引导的', mode: 'steer', origin: 'human', createdAt: 3 },
  ],
  updatedAt: 50,
}

test('快照 conversationLives 重建 live/queue，旧项清理不残留，后续增量一致', { timeout: 60_000 }, () => {
  // 旧状态带残留 live（会话 2），新快照不含它：重建后清旧不残留。
  const before = { ...emptyLiveState(), conversationLives: { 2: { ...queuedLive, conversationId: 2 } } }
  const restored = applySnapshot(before, { ...snapshot, conversationLives: [queuedLive] })
  assert.deepEqual(Object.keys(restored.conversationLives), ['1'])
  assert.equal(restored.conversationLives[1]?.queuedInputs?.[0]?.id, 'req-1')
  // 随后 conversation.live 增量正常覆盖（与快照重建衔接一致）。
  const next = applyEventFrame(restored, {
    seq: 11,
    event: { type: 'conversation.live', live: { ...queuedLive, queuedInputs: [], updatedAt: 90 } },
  })
  assert.deepEqual(next.conversationLives[1]?.queuedInputs, [])
  // conversation.deleted 仍移除 live。
  const removed = applyEventFrame(next, { seq: 12, event: { type: 'conversation.deleted', conversationId: 1 } })
  assert.deepEqual(removed.conversationLives, {})
})

test('快照 conversationLives 缺省时回退为空，非法形状显式拒绝', { timeout: 60_000 }, () => {
  const state = applySnapshot(emptyLiveState(), snapshot)
  assert.deepEqual(state.conversationLives, {})
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [{ bad: true } as unknown as ConversationLive] }), /无效/)
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: 'x' as unknown as ConversationLive[] }), /无效/)
})

test('终态交接：live 含 queue -> upsert done 保留 queue-only live，等真实出队帧清理', { timeout: 60_000 }, () => {
  // working 帧：流式正文 + 工具 + queued。
  const workingLive: ConversationLive = {
    conversationId: 1,
    text: '流式中',
    thinking: '思考中',
    tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }],
    queuedInputs: queuedLive.queuedInputs,
    updatedAt: 60,
  }
  let state = applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [workingLive] })
  assert.equal(state.conversationLives[1]?.text, '流式中')
  // 终态 upsert（done）：清流式正文/工具/思考，但保留 queue-only live。
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.upsert', conversation: { ...conv, status: 'done' } } })
  const afterSettled = state.conversationLives[1]
  assert.ok(afterSettled, '权威 queue 仍在时保留 live')
  assert.equal(afterSettled!.text, '')
  assert.equal(afterSettled!.thinking, undefined)
  assert.deepEqual(afterSettled!.tools, [])
  assert.equal(afterSettled!.queuedInputs?.[0]?.id, 'req-1')
  // 后续 queued 输入被消费（新 run 或 queue 清空帧）：live 被真实帧替换/清理。
  state = applyEventFrame(state, {
    seq: 12,
    event: { type: 'conversation.live', live: { conversationId: 1, text: '下一轮', tools: [], updatedAt: 100 } },
  })
  assert.equal(state.conversationLives[1]?.text, '下一轮')
  assert.equal(state.conversationLives[1]?.queuedInputs, undefined)
})

test('终态交接：queue 为空时 upsert done 原样删除 live（不让 done 显示旧回复 working）', { timeout: 60_000 }, () => {
  const doneLive: ConversationLive = { conversationId: 1, text: '已完成的回答', tools: [], updatedAt: 70 }
  let state = applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [doneLive] })
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.upsert', conversation: { ...conv, status: 'done' } } })
  assert.equal(state.conversationLives[1], undefined)
  // 空 queuedInputs 数组同样视为无队列（与 undefined 同义）。
  let state2 = applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [{ ...doneLive, queuedInputs: [] }] })
  state2 = applyEventFrame(state2, { seq: 11, event: { type: 'conversation.upsert', conversation: { ...conv, status: 'done' } } })
  assert.equal(state2.conversationLives[1], undefined)
})

test('working/blocked upsert 不删 live（仅终态清理）', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [queuedLive] })
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.upsert', conversation: { ...conv, status: 'working' } } })
  assert.ok(state.conversationLives[1])
  state = applyEventFrame(state, { seq: 12, event: { type: 'conversation.upsert', conversation: { ...conv, status: 'blocked' } } })
  assert.ok(state.conversationLives[1])
})
