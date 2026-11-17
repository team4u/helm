import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationDetail, ConversationLive, ConversationSummary, HelmSnapshot } from '@helm/protocol'
import { applyConversationEntry, applyEventFrame, applyResumedFrame, applySnapshot, applyTransientLiveFrame, emptyLiveState, entryMatchesReference, mergeConversationDetail, sortNodes, sseClientTimings, SseParser } from '../src/lib/live-state.js'
import { normalizeModelCatalogInfo } from '../src/lib/api.js'
import type { NodeInfo } from '@helm/protocol'

const conv: ConversationSummary = { id: 1, title: '助理', profileId: 'assistant', cwd: '/tmp', model: '', thinkingLevel: '', status: 'idle', tags: [], stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: true, pendingAskCount: 0, createdAt: 0, updatedAt: 0 }
const snapshot: HelmSnapshot = { bootId: 'test-boot', seq: 10, conversations: [conv], pendingAsks: [], plugins: [], ui: [] }

test('SSE 分段 CRLF、多 data 行与注释不能丢帧', { timeout: 60_000 }, () => {
  const messages: Array<{ event: string; data: string }> = []
  const parser = new SseParser((message) => messages.push(message))
  parser.push(': heartbeat\r')
  parser.push('\nevent: snapshot\r\ndata: {"seq":\r')
  parser.push('\ndata: 10}\r\n\r')
  parser.push('\nevent: notification\ndata: {"text":"中文"}\n\n')
  assert.deepEqual(messages, [{ event: 'snapshot', data: '{"seq":\n10}' }, { event: 'notification', data: '{"text":"中文"}' }])
})

test('重连快照 SWR 保活存在会话的详情并清理已删会话与过时插件文档，重复帧忽略而缺帧要求重新同步', { timeout: 60_000 }, () => {
  const existingDetail: ConversationDetail = {
    ...conv,
    entries: [{ id: '1', kind: 'helm.input', data: { text: 'hi' } }],
    nextCursor: 'cur-1',
    contextUsage: { tokens: 1200, contextWindow: 8000 },
  }
  const deletedConv: ConversationSummary = { ...conv, id: 99, title: '已删会话' }
  const before = {
    ...emptyLiveState(),
    pluginDocs: { 'p/index': { old: true } },
    conversationDetails: {
      1: existingDetail,
      99: { ...deletedConv, entries: [{ id: '2', kind: 'pi.assistant' }] },
    },
  }
  const next = applySnapshot(before, {
    ...snapshot,
    conversations: [{ ...conv, title: '新标题' }],
  })
  assert.deepEqual(next.pluginDocs, {})
  assert.equal(next.conversationDetails[99], undefined, '已删除会话的 detail 必须清理')
  assert.equal(next.conversationDetails[1]?.entries.length, 1, '仍存在会话的 detail 条目必须 SWR 保活')
  assert.equal(next.conversationDetails[1]?.nextCursor, 'cur-1')
  assert.equal(next.conversationDetails[1]?.title, '新标题', '同步合并最新摘要字段')
  assert.deepEqual(next.conversationDetails[1]?.contextUsage, { tokens: 1200, contextWindow: 8000 })
  assert.equal(applyEventFrame(next, { seq: 10, event: { type: 'conversation.deleted', conversationId: 1 } }), next)
  assert.throws(() => applyEventFrame(next, { seq: 12, event: { type: 'notification', level: 'info', title: 'lost' } }), /sequence gap/)
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
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, pluginDocs: 'bad' as unknown as HelmSnapshot['pluginDocs'] }), /[Ii]nvalid/)
  assert.throws(
    () => applySnapshot(emptyLiveState(), { ...snapshot, pluginDocs: [{ pluginId: 1, name: 'x', value: null } as unknown as NonNullable<HelmSnapshot['pluginDocs']>[number]] }),
    /[Ii]nvalid/,
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

test('列表摘要缺 contextUsage 时，HTTP 详情首读带回的用量补进列表与详情（内核首次填充静默不发 SSE 帧）', { timeout: 60_000 }, () => {
  let state = applySnapshot(emptyLiveState(), snapshot) // 重启后快照：摘要无 contextUsage
  const usage = { tokens: 25_000, contextWindow: 100_000 }
  state = mergeConversationDetail(state, { ...conv, entries: [], contextUsage: usage })
  // ConversationPane 向 Composer 传 summary ?? detail：列表摘要必须带用量，胶囊才能渲染
  assert.deepEqual(state.conversations.find((c) => c.id === 1)?.contextUsage, usage)
  assert.deepEqual(state.conversationDetails[1]?.contextUsage, usage)
})

test('列表摘要已有 contextUsage 时保留 SSE 权威值，旧 HTTP 详情不得回退', { timeout: 60_000 }, () => {
  const fresh = { tokens: 50_000 }
  let state = applySnapshot(emptyLiveState(), snapshot)
  state = applyEventFrame(state, { seq: 11, event: { type: 'conversation.upsert', conversation: { ...conv, contextUsage: fresh } } })
  state = mergeConversationDetail(state, { ...conv, entries: [], contextUsage: { tokens: 12_000 } })
  assert.deepEqual(state.conversations.find((c) => c.id === 1)?.contextUsage, fresh)
  assert.deepEqual(state.conversationDetails[1]?.contextUsage, fresh)
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
  assert.throws(() => normalizeModelCatalogInfo({ models: [{ id: 'fake' }] }), /[Ii]nvalid/)
  assert.throws(() => normalizeModelCatalogInfo([1, 2]), /[Ii]nvalid/)
  assert.equal(normalizeModelCatalogInfo({ models: [] }).models.length, 0)
})

test('模型目录携带全局默认模型', { timeout: 60_000 }, () => {
  const catalog = normalizeModelCatalogInfo({
    models: [],
    thinkingLevels: {},
    defaultModel: 'magpie/group/smart',
    defaultCompactionModel: 'openai/gpt-4o-mini',
  })
  assert.equal(catalog.defaultModel, 'magpie/group/smart')
  assert.equal(catalog.defaultCompactionModel, 'openai/gpt-4o-mini')
})

test('模型目录窗口字段：真实已知正数透传，未知省略，非法值显式拒绝', { timeout: 60_000 }, () => {
  // 已知正数窗口：透传到 ModelDescriptor
  const known = normalizeModelCatalogInfo({ models: [
    { provider: 'magpie', modelId: 'glm-4.6', available: true, contextWindow: 200_000 },
  ] })
  assert.equal(known.models[0]?.contextWindow, 200_000)

  // 未知窗口：省略字段，不推测、不补缺省
  const unknown = normalizeModelCatalogInfo({ models: [
    { provider: 'magpie', modelId: 'kimi-k2', available: true },
  ] })
  assert.equal('contextWindow' in (unknown.models[0] ?? {}), false)

  // 非法窗口（0 / 负数 / 非有限数 / 非数字）：边界显式拒绝，不静默丢弃
  for (const bad of [0, -128_000, Number.POSITIVE_INFINITY, '200000']) {
    assert.throws(
      () => normalizeModelCatalogInfo({ models: [
        { provider: 'magpie', modelId: 'bad-window', available: true, contextWindow: bad as number },
      ] }),
      /[Ii]nvalid/,
      `contextWindow=${String(bad)} 必须显式拒绝`,
    )
  }
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
    { id: 'req-1', submissionId: '12', text: 'Steer的', mode: 'steer', origin: 'human', createdAt: 3 },
  ],
  updatedAt: 50,
}

test('快照 conversationLives 重建 live/queue，旧项清理不残留，后续瞬态增量一致', { timeout: 60_000 }, () => {
  // 旧状态带残留 live（会话 2），新快照不含它：重建后清旧不残留。
  const before = { ...emptyLiveState(), conversationLives: { 2: { ...queuedLive, conversationId: 2 } } }
  const restored = applySnapshot(before, { ...snapshot, conversationLives: [queuedLive] })
  assert.deepEqual(Object.keys(restored.conversationLives), ['1'])
  assert.equal(restored.conversationLives[1]?.queuedInputs?.[0]?.id, 'req-1')
  // 随后瞬态 conversation.live 帧正常覆盖，且不推进 seq。
  const next = applyTransientLiveFrame(restored, {
    live: { ...queuedLive, queuedInputs: [], updatedAt: 90 },
  })
  assert.equal(next.seq, restored.seq, '瞬态 live 帧不改变 seq')
  assert.deepEqual(next.conversationLives[1]?.queuedInputs, [])
  // conversation.deleted 仍移除 live。
  const removed = applyEventFrame(next, { seq: 11, event: { type: 'conversation.deleted', conversationId: 1 } })
  assert.deepEqual(removed.conversationLives, {})
})

test('applyTransientLiveFrame 与 applyResumedFrame：瞬态更新校验与 resumed live 对账', { timeout: 60_000 }, () => {
  assert.equal(sseClientTimings.idleTimeoutMs, 30_000, 'SSE 默认空闲超时对齐后端 15s keepalive 收敛至 30s')
  const base = applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [queuedLive] })
  assert.throws(() => applyTransientLiveFrame(base, { live: { conversationId: 'bad' } } as never), /[Ii]nvalid/)

  const live2: ConversationLive = { conversationId: 2, text: '恢复中的流', tools: [], updatedAt: 120 }
  // resumed 未携带 conversationLives 时保留已有状态
  assert.equal(applyResumedFrame(base, { bootId: 'test-boot', seq: 10, headSeq: 10 }), base)
  // resumed 携带 conversationLives 时对账替换，清理已结束的旧瞬态视图
  const reconciled = applyResumedFrame(base, {
    bootId: 'test-boot',
    seq: 10,
    headSeq: 11,
    conversationLives: [live2],
  })
  assert.equal(reconciled.conversationLives[1], undefined)
  assert.equal(reconciled.conversationLives[2]?.text, '恢复中的流')
  assert.throws(() => applyResumedFrame(base, { bootId: 'test-boot', seq: 10, headSeq: 10, conversationLives: 'bad' as never }), /[Ii]nvalid/)
})

test('快照 conversationLives 缺省时回退为空，非法形状显式拒绝', { timeout: 60_000 }, () => {
  const state = applySnapshot(emptyLiveState(), snapshot)
  assert.deepEqual(state.conversationLives, {})
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: [{ bad: true } as unknown as ConversationLive] }), /[Ii]nvalid/)
  assert.throws(() => applySnapshot(emptyLiveState(), { ...snapshot, conversationLives: 'x' as unknown as ConversationLive[] }), /[Ii]nvalid/)
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
  // 后续 queued 输入被消费（新 run 或 queue 清空帧）：瞬态 live 被真实帧替换/清理。
  state = applyTransientLiveFrame(state, {
    live: { conversationId: 1, text: '下一轮', tools: [], updatedAt: 100 },
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

// ---------------------------------------------------------------------------
// 单条目回填（applyConversationEntry）：SSE 事件与截断全文回填共用语义
// ---------------------------------------------------------------------------

test('applyConversationEntry 同 id 原位替换保序，不动分页游标', { timeout: 60_000 }, () => {
  const e1 = { id: '1', kind: 'pi.user' }
  const e2 = { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '预览' }], truncated: true }] }
  const e3 = { id: '3', kind: 'pi.assistant' }
  const detail: ConversationDetail = { ...conv, entries: [e1, e2, e3], nextCursor: 'cursor-1' }
  const state = { ...emptyLiveState(), conversationDetails: { 1: detail } }

  const full = { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '完整原文'.repeat(50) }] }] }
  const next = applyConversationEntry(state, 1, full)
  const entries = next.conversationDetails[1]!.entries
  assert.deepEqual(entries.map((entry) => entry.id), ['1', '2', '3'], '回填不得把条目挪到队尾（时间线依赖时间正序）')
  assert.equal(entries[1], full, '同 id 原位替换')
  assert.equal(next.conversationDetails[1]!.nextCursor, 'cursor-1', '分页游标不受回填影响')
  assert.equal(applyConversationEntry(next, 1, full), next, '幂等：重复回填同一对象不产生新状态')
})

test('applyConversationEntry 详情未加载时落 pendingEntries，新 id 追加队尾', { timeout: 60_000 }, () => {
  const state = emptyLiveState()
  const entry = { id: '7', kind: 'pi.assistant' }
  const withPending = applyConversationEntry(state, 5, entry)
  assert.deepEqual(withPending.pendingEntries[5], [entry])
  const later = applyConversationEntry(withPending, 5, { id: '8', kind: 'pi.tool-result' })
  assert.deepEqual(later.pendingEntries[5]!.map((item) => item.id), ['7', '8'])
})

test('conversation.entry 事件复用回填语义：同 id 原位替换而非挪尾', { timeout: 60_000 }, () => {
  const e1 = { id: '1', kind: 'pi.user' }
  const e2 = { id: '2', kind: 'pi.assistant' }
  const detail: ConversationDetail = { ...conv, entries: [e1, e2] }
  let state: ReturnType<typeof emptyLiveState> = { ...emptyLiveState(), seq: 0, conversationDetails: { 1: detail } }
  state = applyEventFrame(state, { seq: 1, event: { type: 'conversation.entry', conversationId: 1, entry: { id: '3', kind: 'pi.tool-result' } } })
  state = applyEventFrame(state, { seq: 2, event: { type: 'conversation.entry', conversationId: 1, entry: { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c', content: [] }] } } })
  assert.deepEqual(state.conversationDetails[1]!.entries.map((entry) => entry.id), ['1', '2', '3'])
})

test('回填的全文条目在更早页重合并时保留（current 优先于新页）', { timeout: 60_000 }, () => {
  const truncated = { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '预览' }], truncated: true }] }
  const full = { id: '2', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '完整原文' }] }] }
  const first: ConversationDetail = { ...conv, entries: [truncated], nextCursor: 'cur' }
  let state = mergeConversationDetail(emptyLiveState(), first)
  state = applyConversationEntry(state, 1, full)
  // 服务端分页再次返回同一批条目（仍是截断预览）：已回填的全文不得被预览回退
  const pageAgain: ConversationDetail = { ...conv, entries: [truncated], nextCursor: 'cur2' }
  const merged = mergeConversationDetail(state, pageAgain, true)
  assert.equal(merged.conversationDetails[1]!.entries.find((entry) => entry.id === '2'), full, 'current 中的全文回填优先于新页预览')
})
