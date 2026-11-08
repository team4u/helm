/**
 * 时间线与实时视图真实链路测试。
 *
 * 三层各自用真实边界（不写镜像实现测试）：
 * 1. 纯函数层：toConversationEntry / deriveConversationLive 的契约
 *    （id 转 string、model 保留、JSON 可用校验拒绝非 JSON、不静默截断）。
 * 2. EventHub 层：conversation.entry / conversation.live / plugin.doc.updated /
 *    workflow.updated 四个 core 类型的直传与完整信封双形状、非法 payload 显式
 *    抛错、脱敏保持；snapshot 必填 ui/workflowRuns。
 * 3. 真实 SDK 层：faux provider 驱动 ConversationTracker —— observe 初始历史
 *    不重发 entry、新落库 entry 每 id 恰一次、live 节流（75ms 窗口）与终态
 *    冲刷、stopObserving 后无幽灵事件、meta 从 entry.data 重建贯通回
 *    turn_settled payload、getProbeFacts 基于真实活动变更。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness } from '@earendil-works/pi-durable'
import { createRegistry } from '@earendil-works/pi-durable'
import type { ConversationEntry, ConversationLive, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, toConversationEntry } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, summaryOf, type ConvMeta } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 轮询等待条件成立（防挂死，总超时显式）。 */
async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function convMeta(id: number): ConvMeta {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    nodeId: 'local',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    unread: false,
    pinned: false,
    stateChangeSeq: 1,
    completionSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 测试用 tracker 事件收集器。 */
interface Collector {
  entries: Array<{ conversationId: number; entry: ConversationEntry }>
  lives: ConversationLive[]
  summaries: number[]
}
function makeCollector(): Collector {
  return { entries: [], lives: [], summaries: [] }
}
function eventsOf(c: Collector): TrackerEvents {
  return {
    onSummaryChanged: (s) => c.summaries.push(s.id),
    onInputCommitted: () => {},
    onAssistantText: () => {},
    onTurnSettled: () => {},
    onEntryCommitted: (conversationId, entry) => c.entries.push({ conversationId, entry }),
    onLiveChanged: (live) => c.lives.push(live),
  }
}

// ---------------------------------------------------------------------------
// 1. 纯函数：toConversationEntry
// ---------------------------------------------------------------------------

describe('toConversationEntry', { timeout: 60_000 }, () => {
  it('id 转 string，kind/data/model 保留（model 是 assistant 文本载体）', () => {
    const entry = toConversationEntry({
      id: 42,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }],
    })
    assert.equal(entry.id, '42')
    assert.equal(entry.kind, 'pi.assistant')
    assert.equal(entry.data, undefined)
    assert.ok(Array.isArray(entry.model))
    assert.deepEqual(entry.model, [{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }])
  })

  it('data 原样保留；id 为 string 时不变形', () => {
    const entry = toConversationEntry({ id: '7', kind: 'helm.input', data: { origin: 'human' } })
    assert.equal(entry.id, '7')
    assert.deepEqual(entry.data, { origin: 'human' })
    assert.equal(entry.model, undefined)
  })

  it('非 JSON 值显式抛 HelmError：Date/Map/循环/undefined 字段都不静默转换', () => {
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: { at: new Date(0) } }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: new Map() }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', data: cyclic }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
    assert.throws(
      () => toConversationEntry({ id: 1, kind: 'x', model: [{ role: 'assistant', extra: undefined }] }),
      (e: unknown) => e instanceof HelmError && e.code === 'invalid_json_value',
    )
  })

  it('非法 id/kind 显式抛错（不伪造）', () => {
    assert.throws(() => toConversationEntry({ id: null, kind: 'x' } as never), HelmError)
    assert.throws(() => toConversationEntry({ id: 1, kind: 3 } as never), HelmError)
  })
})

// ---------------------------------------------------------------------------
// 2. 纯函数：deriveConversationLive
// ---------------------------------------------------------------------------

describe('deriveConversationLive', { timeout: 60_000 }, () => {
  it('text 为 generation.message 中 text 块的累计快照（多块按序拼接）', () => {
    const live = deriveConversationLive(
      5,
      {
        generation: {
          message: {
            content: [
              { type: 'thinking', thinking: '推理' },
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' },
            ],
          },
        },
      },
      123,
    )
    assert.equal(live.conversationId, 5)
    assert.equal(live.text, '第一段第二段')
    assert.equal(live.thinking, '推理')
    assert.deepEqual(live.tools, [])
    assert.equal(live.updatedAt, 123)
  })

  it('tools 与 nestedTools 统一生成工具卡：running/done 映射、input 保留', () => {
    const live = deriveConversationLive(
      1,
      {
        tools: [
          { callId: 'c1', name: 'bash', status: 'running', arguments: { command: 'ls' } },
          { callId: 'c2', name: 'read', status: 'done' },
        ],
        nestedTools: [{ callId: 'c1/1', name: 'grep', status: 'done', arguments: { pattern: 'x' } }],
      },
      9,
    )
    assert.equal(live.text, '')
    assert.equal(live.tools.length, 3)
    assert.deepEqual(live.tools[0], {
      callId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
      status: 'running',
    })
    assert.deepEqual(live.tools[1], { callId: 'c2', toolName: 'read', status: 'done' })
    assert.deepEqual(live.tools[2], {
      callId: 'c1/1',
      toolName: 'grep',
      input: { pattern: 'x' },
      status: 'done',
    })
  })

  it('undefined live 视图为空快照（不抛错）', () => {
    const live = deriveConversationLive(1, undefined, 1)
    assert.equal(live.text, '')
    assert.deepEqual(live.tools, [])
  })
})

// ---------------------------------------------------------------------------
// 3. EventHub：四个新 core 类型
// ---------------------------------------------------------------------------

describe('EventHub 新 core 事件类型', { timeout: 60_000 }, () => {
  function makeHub(snapshot?: Partial<HelmSnapshot>): { hub: EventHub; frames: HelmEventFrame[] } {
    const frames: HelmEventFrame[] = []
    const hub = new EventHub({
      initialSeq: 0,
      snapshot: () =>
        ({
          seq: 0,
          conversations: [],
          pendingAsks: [],
          plugins: [],
          ui: [],
          workflowRuns: [],
          ...snapshot,
        }) as HelmSnapshot,
    })
    hub.subscribe((f) => frames.push(f))
    return { hub, frames }
  }

  const entry: ConversationEntry = { id: '11', kind: 'pi.assistant', model: [{ role: 'assistant' }] }
  const live: ConversationLive = {
    conversationId: 3,
    text: '流式中',
    tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }],
    updatedAt: 111,
  }
  const doc = { pluginId: 'builtin:superagent', name: 'index', value: { next: 4 } }
  const run = {
    id: 'wf_abc',
    name: '巡检',
    conversationId: 2,
    status: 'running' as const,
    createdAt: 1,
    updatedAt: 2,
  }

  it('conversation.entry：直传 {conversationId,entry} 与完整信封 {type,...} 双形状', () => {
    const { hub, frames } = makeHub()
    hub.publish('conversation.entry', { conversationId: 3, entry })
    hub.publish('conversation.entry', { type: 'conversation.entry', conversationId: 4, entry })
    const [e1, e2] = frames.map((f) => f.event) as Array<{
      type: string
      conversationId: number
      entry: ConversationEntry
    }>
    assert.ok(e1 && e2)
    assert.equal(e1.type, 'conversation.entry')
    assert.equal(e1.conversationId, 3)
    assert.deepEqual(e1.entry, entry)
    assert.equal(e2.conversationId, 4)
    assert.deepEqual(e2.entry, entry)
  })

  it('conversation.live：双形状；live 原样携带不二次嵌套', () => {
    const { hub, frames } = makeHub()
    hub.publish('conversation.live', { live })
    hub.publish('conversation.live', { type: 'conversation.live', live })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ live: ConversationLive }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.live, live)
    assert.deepEqual(e2.live, live)
  })

  it('plugin.doc.updated：双形状；doc 三字段完整', () => {
    const { hub, frames } = makeHub()
    hub.publish('plugin.doc.updated', { doc })
    hub.publish('plugin.doc.updated', { type: 'plugin.doc.updated', doc })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ doc: typeof doc }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.doc, doc)
    assert.deepEqual(e2.doc, doc)
  })

  it('workflow.updated：双形状；run 原样', () => {
    const { hub, frames } = makeHub()
    hub.publish('workflow.updated', { run })
    hub.publish('workflow.updated', { type: 'workflow.updated', run })
    const [e1, e2] = frames.map((f) => f.event) as Array<{ run: typeof run }>
    assert.ok(e1 && e2)
    assert.deepEqual(e1.run, run)
    assert.deepEqual(e2.run, run)
  })

  it('非法 payload 显式抛 HelmError 且不推进 seq（不静默降级）', () => {
    const { hub, frames } = makeHub()
    // conversation.entry：缺 conversationId / entry 形状非法
    assert.throws(() => hub.publish('conversation.entry', { entry }), HelmError)
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 1, entry: { id: 1 } }),
      HelmError,
    )
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 'x', entry }),
      HelmError,
    )
    // conversation.live：缺字段
    assert.throws(() => hub.publish('conversation.live', { live: { conversationId: 1 } }), HelmError)
    assert.throws(() => hub.publish('conversation.live', {}), HelmError)
    // plugin.doc.updated：缺 value / pluginId
    assert.throws(
      () => hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n' } }),
      HelmError,
    )
    // workflow.updated：status 非 string
    assert.throws(
      () => hub.publish('workflow.updated', { run: { ...run, status: 3 } }),
      HelmError,
    )
    assert.equal(hub.seq, 0, '全部失败不推进序号')
    assert.equal(frames.length, 0)
  })

  it('publish 前统一脱敏保持：entry/live/doc 明文 secret 不漏', () => {
    const { hub, frames } = makeHub()
    hub.redactFn = (t) => t.replaceAll('sk-plain', '[REDACTED]')
    hub.publish('conversation.entry', {
      conversationId: 1,
      entry: { id: '1', kind: 'helm.input', data: { text: '上传 sk-plain 密钥' } },
    })
    hub.publish('plugin.doc.updated', { doc: { pluginId: 'p', name: 'n', value: 'token=sk-plain' } })
    const text = JSON.stringify(frames.map((f) => f.event))
    assert.ok(!text.includes('sk-plain'), '事件载荷不得漏明文 secret')
    assert.ok(text.includes('[REDACTED]'))
  })

  it('snapshot 必填 ui / workflowRuns 字段（新契约直出，无兼容缺省）', () => {
    const ui = [{ pluginId: 'p', surface: 'sidebar.item', spec: { id: 's1', label: 'X' } }]
    const runs = [run]
    const { hub } = makeHub({ ui, workflowRuns: runs })
    const snap = hub.currentSnapshot()
    assert.deepEqual(snap.ui, ui)
    assert.deepEqual(snap.workflowRuns, runs)
  })
})

// ---------------------------------------------------------------------------
// 4. 真实 SDK：faux provider 驱动 ConversationTracker
// ---------------------------------------------------------------------------

describe('ConversationTracker 真实 SDK 时间线与实时事件', { timeout: 60_000 }, () => {
  let root = ''

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-timeline-'))
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 真实 Harness + SQLite + faux provider + tracker（不伪造 KernelRuntime）。 */
  type FauxHandle = ReturnType<typeof fauxProvider>
  async function openTracker(): Promise<{
    tracker: ConversationTracker
    harness: Harness
    collector: Collector
    faux: FauxHandle
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const collector = makeCollector()
    const tracker = new ConversationTracker({
      harness,
      store,
      events: eventsOf(collector),
    })
    return {
      tracker,
      harness,
      collector,
      faux,
      close: async () => {
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
    }
  }

  it('faux 完成路径：初始 observe 不发 entry；新落库 entry 按 id 序恰一次；live 到达且终态冲刷', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number

      // 预置历史（observe 前落库一条 write）。
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 1 } } }, BACKGROUND_CONTEXT)
      await tracker.observe(id)
      assert.equal(collector.entries.length, 0, '初始 observe 历史条目不重发')

      // 真实 run：faux 文本回答 -> helm.input + pi.assistant 落库。
      // 经真实 tracker API 登记（registerInput -> bindSubmission，与 runtime 同路径）。
      faux.setResponses([fauxAssistantMessage('真实回答')])
      const key = tracker.registerInput(id, {
        id: 'in-1',
        text: '真实问题',
        origin: 'human',
        createdAt: 1,
      })
      await conv
        .submit(
          {
            type: 'input',
            content: '真实问题',
            entry: {
              kind: 'helm.input',
              data: { id: 'in-1', text: '真实问题', origin: 'human', createdAt: 1 },
            },
            requestId: 'in-1',
          },
          BACKGROUND_CONTEXT,
        )
        .then((sub) => tracker.bindSubmission(id, key, sub.id as number))
      await conv.waitForIdle(BACKGROUND_CONTEXT)

      // 等待观察者路径完成（advance 同步，但 run 结算在微任务内）。
      await waitFor(() => collector.entries.length >= 2, 5_000)
      const ids = collector.entries.map((e) => e.entry.id)
      assert.equal(new Set(ids).size, ids.length, '每条 entry 恰一次')
      assert.ok(ids.length >= 2)
      // id 数值序 = 提交顺序保持。
      const numeric = ids.map(Number)
      for (let i = 1; i < numeric.length; i += 1) {
        assert.ok(numeric[i]! > numeric[i - 1]!, 'entry 按提交顺序（id 单调）')
      }
      const kinds = collector.entries.map((e) => e.entry.kind)
      assert.ok(kinds.includes('helm.input'), 'helm.input entry 事件到达')
      assert.ok(kinds.some((k) => k.startsWith('pi.')), 'SDK 内部 entry 事件到达')
      // live 终态冲刷：最终一帧到达且 conversationId 正确。
      assert.ok(collector.lives.length >= 1, 'run 期间/终态至少一帧 live')
    } finally {
      await close()
    }
  })

  it('live 节流：run 期间快照合并、终态后停止；帧间隔不低于节流窗口量级', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      await tracker.observe(id)
      // 真实 run：faux 文本回答（流式 partial 经 pi.live.generation 驱动 live 派生）。
      faux.setResponses([fauxAssistantMessage('流式回答内容')])
      await conv.submit({ type: 'input', content: '跑一轮' }, BACKGROUND_CONTEXT)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      // 等待终态冲刷（emitSettled 同步路径）后帧数不再增长。
      await new Promise((r) => setTimeout(r, 150))
      const frozen = collector.lives.length
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(collector.lives.length, frozen, 'run 结束后无新 live 帧')
      // 节流正确性：任意相邻两帧的 updatedAt 间隔 >= 75ms 量级（同窗口被合并），
      // 或帧数为 0/1（单窗口）。不伪造帧数下限（取决于真实流式节奏）。
      for (let i = 1; i < collector.lives.length; i += 1) {
        const prev = collector.lives[i - 1]!
        const curr = collector.lives[i]!
        assert.ok(
          curr.updatedAt - prev.updatedAt >= 60,
          `相邻 live 帧间隔 ${curr.updatedAt - prev.updatedAt}ms 低于节流窗口（未合并同窗口快照）`,
        )
      }
      // 每帧 conversationId 正确。
      for (const frame of collector.lives) assert.equal(frame.conversationId, id)
    } finally {
      await close()
    }
  })

  it('stopObserving 清 timer 且不再产生 entry/live 事件（无幽灵事件）', { timeout: 60_000 }, async () => {
    const { tracker, harness, collector, close } = await openTracker()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      await tracker.observe(id)
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 2 } } }, BACKGROUND_CONTEXT)
      await waitFor(() => collector.entries.length === 1, 5_000)

      tracker.stopObserving(id)
      const entriesAfter = collector.entries.length
      const livesAfter = collector.lives.length
      // 停观后再写：不发事件。
      await conv.submit({ type: 'write', entry: { kind: 'helm.note', data: { n: 3 } } }, BACKGROUND_CONTEXT)
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(collector.entries.length, entriesAfter, '停观后无 entry 幽灵事件')
      assert.equal(collector.lives.length, livesAfter, '停观后无 live 幽灵事件')
    } finally {
      await close()
    }
  })

  it('meta 从 helm.input entry.data 重建贯通回 turn_settled payload', { timeout: 60_000 }, async () => {
    const settled: Array<{ inputs: Array<{ meta?: Record<string, unknown> }> }> = []
    const dir = join(root, `meta-${Date.now()}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('ok')])
    const models = createModels()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      store.upsertConv(convMeta(id))
      const tracker = new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: (payload) => {
            settled.push(payload as { inputs: Array<{ meta?: Record<string, unknown> }> })
          },
        },
      })
      await tracker.observe(id)
      const key = tracker.registerInput(id, {
        id: 'm-1',
        text: '带 meta 的问题',
        origin: 'agent',
        createdAt: 2,
        meta: { from: 'superagent', turn: 3 },
      })
      await conv
        .submit(
          {
            type: 'input',
            content: '带 meta 的问题',
            entry: {
              kind: 'helm.input',
              data: {
                id: 'm-1',
                text: '带 meta 的问题',
                origin: 'agent',
                createdAt: 2,
                meta: { from: 'superagent', turn: 3 },
              },
            },
            requestId: 'm-1',
          },
          BACKGROUND_CONTEXT,
        )
        .then((sub) => tracker.bindSubmission(id, key, sub.id as number))
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 1, 5_000)
      const inputs = settled[0]?.inputs ?? []
      const withMeta = inputs.find((i) => i.meta !== undefined)
      assert.ok(withMeta, 'turn_settled inputs 含 meta')
      assert.deepEqual(withMeta!.meta, { from: 'superagent', turn: 3 })
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })

  it('getProbeFacts：failed 递增、completed 归零；空闲无 stalledMs', { timeout: 60_000 }, async () => {
    const dir = join(root, `probe-${Date.now()}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all' } },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const collector = makeCollector()
    const tracker = new ConversationTracker({ harness, store, events: eventsOf(collector) })
    try {
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, BACKGROUND_CONTEXT)
      const id = conv.id as number
      store.upsertConv(convMeta(id))
      await tracker.observe(id)
      assert.equal(tracker.getProbeFacts(id).consecutiveErrors, 0, '初始零失败')
      assert.equal(tracker.getProbeFacts(id).stalledMs, undefined, '空闲不报 stalled')

      // 失败 run：faux 报 model error（runFailure -> emitSettled failed）。
      faux.setResponses([fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' })])
      await conv.submit({ type: 'input', content: 'q1' }, BACKGROUND_CONTEXT)
      await conv.waitForIdle(BACKGROUND_CONTEXT).catch(() => {})
      await waitFor(() => (tracker.getProbeFacts(id).consecutiveErrors ?? 0) === 1, 5_000)
      assert.equal(tracker.getProbeFacts(id).stalledMs, undefined, '失败后空闲仍不报 stalled')

      // 成功 run：completed 归零。
      faux.setResponses([fauxAssistantMessage('恢复的回答')])
      await conv.submit({ type: 'input', content: 'q2' }, BACKGROUND_CONTEXT)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => tracker.getProbeFacts(id).consecutiveErrors === 0, 5_000)
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
      await store.close()
      await database.close()
    }
  })
})
