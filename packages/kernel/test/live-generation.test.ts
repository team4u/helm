/**
 * ConversationLive.generation 通用流式事实契约（内核零速率计算）：
 *
 * 1. 纯函数层：liveGenerationOf / deriveConversationLive 的受限投影——
 *    attempt 正整数、message 只含 text/thinking/toolCall(name+arguments) 与
 *    供应商累计 usage.output，其余字段（时间戳/模型元数据/非法块）不外泄；
 * 2. EventHub 边界：conversation.live 携带合法 generation 通过，非法形状
 *    （attempt 非正整数 / message.content 非数组 / usage 非正 / 未知字段）
 *    显式拒绝且不推进 seq；
 * 3. 真实 SDK 层（faux provider 驱动 ConversationTracker）：流式回合期间
 *    live 帧携带 generation（attempt + 累计 message，含 toolCall 参数），
 *    纯 tool-call 参数流式期间帧仍流动（指纹含 generation），终态冲刷帧
 *    generation 消失。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import type { ConversationLive, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, liveGenerationOf } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, type ConvMeta } from '../src/runtime/store.js'

// ---------------------------------------------------------------------------
// 1. 纯函数：受限投影
// ---------------------------------------------------------------------------

describe('liveGenerationOf：受限投影（通用事实，零策略）', { timeout: 60_000 }, () => {
  it('attempt-only（message 缺省/无内容）合法：message 省略', { timeout: 60_000 }, () => {
    assert.deepEqual(liveGenerationOf({ attempt: 1 }), { attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 3, message: { content: [] } }), { attempt: 3 })
    assert.deepEqual(liveGenerationOf({ attempt: 2, message: undefined }), { attempt: 2 })
  })

  it('text / thinking / toolCall(name+arguments) 与供应商累计 usage 投影', { timeout: 60_000 }, () => {
    const generation = liveGenerationOf({
      attempt: 1,
      message: {
        content: [
          { type: 'thinking', thinking: '推理中' },
          { type: 'text', text: '回答文本' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: { input: 100, output: 42, cacheRead: 0, cacheWrite: 0 },
        timestamp: 123,
        model: 'faux/faux-1',
      },
    })
    assert.deepEqual(generation, {
      attempt: 1,
      message: {
        content: [
          { type: 'thinking', thinking: '推理中' },
          { type: 'text', text: '回答文本' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: { output: 42 },
      },
    })
  })

  it('非法 / 未知块形状被过滤或整体省略，不伪造', { timeout: 60_000 }, () => {
    // attempt 非正整数：整体省略（LiveStateShape 防御，SDK 不产生此形状）。
    assert.equal(liveGenerationOf({ attempt: 0 }), undefined)
    assert.equal(liveGenerationOf({ attempt: Number.NaN }), undefined)
    assert.equal(liveGenerationOf(undefined), undefined)
    // content 非数组 / message 非 object：message 省略。
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: 'bad' }), { attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: { content: 'bad' } }), { attempt: 1 })
    // 未知块类型与非法字段被过滤；全部无效时 message 省略。
    assert.deepEqual(
      liveGenerationOf({ attempt: 1, message: { content: [{ type: 'image', data: 'x' }, { type: 'text', text: 42 }] } }),
      { attempt: 1 },
    )
    // usage.output 非正 / 非数：usage 省略（不用估算冒充供应商上报）。
    const noUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: 0 } } })
    assert.equal(noUsage?.message?.usage, undefined)
    const nanUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: Number.NaN } } })
    assert.equal(nanUsage?.message?.usage, undefined)
  })

  it('deriveConversationLive：generation 参与派生（与 text/tools 同帧）', { timeout: 60_000 }, () => {
    const live = deriveConversationLive(
      7,
      { generation: { attempt: 1, message: { content: [{ type: 'text', text: '你好' }] } } },
      123,
    )
    assert.equal(live.conversationId, 7)
    assert.equal(live.text, '你好')
    assert.deepEqual(live.generation, {
      attempt: 1,
      message: { content: [{ type: 'text', text: '你好' }] },
    })
    const idle = deriveConversationLive(7, { generation: undefined }, 456)
    assert.equal(idle.generation, undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. EventHub 边界形状校验
// ---------------------------------------------------------------------------

describe('conversation.live generation 事件边界校验', { timeout: 60_000 }, () => {
  function hubOf(): EventHub {
    return new EventHub({
      initialSeq: 0,
      snapshot: () => ({
        seq: 0,
        conversations: [],
        pendingAsks: [],
        plugins: [],
        ui: [],
        pluginDocs: [],
        conversationLives: [],
        nodes: [],
      } as HelmSnapshot),
    })
  }

  const baseLive = { conversationId: 1, text: '', tools: [], updatedAt: 1 }

  it('合法 generation（attempt-only / 全量投影）通过', { timeout: 60_000 }, () => {
    const hub = hubOf()
    hub.publish('conversation.live', { live: { ...baseLive, generation: { attempt: 1 } } })
    hub.publish('conversation.live', {
      live: {
        ...baseLive,
        generation: {
          attempt: 2,
          message: {
            content: [
              { type: 'text', text: 'a' },
              { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
            ],
            usage: { output: 5 },
          },
        },
      },
    })
    assert.equal(hub.seq, 2)
  })

  it('非法 generation 显式拒绝且不推进 seq（不静默降级）', { timeout: 60_000 }, () => {
    const hub = hubOf()
    const rejects: unknown[] = [
      { attempt: 0 }, // 非正整数
      { attempt: 1.5 }, // 非整数
      { attempt: '1' }, // 非数字
      { attempt: 1, extra: true }, // 未知字段
      { attempt: 1, message: null }, // message 非 object
      { attempt: 1, message: { content: 'bad' } }, // content 非数组
      { attempt: 1, message: { content: [{ type: 'unknown' }] } }, // 未知块类型
      { attempt: 1, message: { content: [{ type: 'text', text: 1 }] } }, // 块字段非法
      { attempt: 1, message: { content: [{ type: 'text', text: 'a', extra: 1 }] } }, // 块未知字段
      { attempt: 1, message: { content: [], usage: 'bad' } }, // usage 非法
      { attempt: 1, message: { content: [], usage: { output: 0 } } }, // 非正 output
      { attempt: 1, message: { content: [], usage: { output: 5, input: 1 } } }, // usage 未知字段
    ]
    for (const generation of rejects) {
      assert.throws(
        () => hub.publish('conversation.live', { live: { ...baseLive, generation } }),
        (error: unknown) => error instanceof HelmError,
        `必须拒绝 ${JSON.stringify(generation)}`,
      )
    }
    assert.equal(hub.seq, 0, '拒绝不推进 seq')
  })
})

// ---------------------------------------------------------------------------
// 3. 真实 SDK：流式回合的 live 帧携带 generation
// ---------------------------------------------------------------------------

describe('ConversationTracker 真实 SDK：live 帧 generation 事实', { timeout: 60_000 }, () => {
  let root = ''

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-live-generation-'))
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function openTracker(options?: { tokensPerSecond?: number }): Promise<{
    tracker: ConversationTracker
    harness: Harness
    lives: ConversationLive[]
    faux: ReturnType<typeof fauxProvider>
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const models = createModels()
    const faux = fauxProvider({ tokensPerSecond: options?.tokensPerSecond })
    models.setProvider(faux.provider)
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const lives: ConversationLive[] = []
    const events: TrackerEvents = {
      onSummaryChanged: () => {},
      onInputCommitted: () => {},
      onAssistantText: () => {},
      onTurnSettled: () => {},
      onLiveChanged: (live) => lives.push(live),
    }
    const tracker = new ConversationTracker({ harness, store, events })
    return {
      tracker,
      harness,
      lives,
      faux,
      close: async () => {
        for (const { id } of store.listConvs()) {
          await tracker.ensureContextUsage(id)
          tracker.stopObserving(id)
        }
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
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

  async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('waitFor 超时')
      await new Promise((r) => setTimeout(r, 15))
    }
  }

  it('文本流式：帧携带 generation（attempt 递增快照、message 累计、终态帧消失）', { timeout: 60_000 }, async () => {
    // 慢速流（faux tokensPerSecond）：partial 提交节流（100ms）可见多个累计快照。
    const { tracker, harness, lives, faux, close } = await openTracker({ tokensPerSecond: 20 })
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      const store = (tracker as unknown as { store: HelmStore }).store
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      faux.setResponses([fauxAssistantMessage('一二三四五六七八九十')])
      await conv.submit({ type: 'input', content: '问题' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => lives.some((live) => live.generation !== undefined))

      const withGeneration = lives.filter((live) => live.generation !== undefined)
      assert.ok(withGeneration.length >= 1, '流式期间必须发出携带 generation 的 live 帧')
      for (const live of withGeneration) {
        const generation = live.generation!
        assert.equal(typeof generation.attempt, 'number')
        assert.ok(generation.attempt >= 1)
        if (generation.message !== undefined) {
          // 受限投影：内容与 usage 之外无字段泄漏。
          for (const block of generation.message.content) {
            assert.ok(block.type === 'text' || block.type === 'thinking' || block.type === 'toolCall')
          }
        }
      }
      // message 累计快照单调（text 块字符数不回退）。
      const textLengths = withGeneration.map(
        (live) => (live.generation?.message?.content ?? []).reduce((acc, b) => acc + (b.type === 'text' ? b.text.length : 0), 0),
      )
      for (let i = 1; i < textLengths.length; i += 1) {
        assert.ok(textLengths[i]! >= textLengths[i - 1]!, `累计快照单调：${textLengths.join(',')}`)
      }
      // 终态冲刷帧（回合结束后）不再携带 generation。
      await waitFor(() => lives[lives.length - 1]?.text === '' && lives[lives.length - 1]?.tools.length === 0)
      assert.equal(lives[lives.length - 1]?.generation, undefined, '终态帧 generation 消失')
    } finally {
      await close()
    }
  })

  it('纯 tool-call 流式：参数增长期间帧仍流动（指纹含 generation），参数进受限投影', { timeout: 60_000 }, async () => {
    const { tracker, harness, lives, faux, close } = await openTracker({ tokensPerSecond: 20 })
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      const store = (tracker as unknown as { store: HelmStore }).store
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo 一二三四五六七八九十' })], { stopReason: 'toolUse' }),
      ])
      await conv.submit({ type: 'input', content: '跑个命令' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      // bash 未注册：调用以 tool_unavailable 错误结果结算（不影响 generation 观察）。
      await waitFor(() => lives.some((live) => live.generation?.message !== undefined))

      const argFrames = lives.filter(
        (live) => (live.generation?.message?.content ?? []).some((b) => b.type === 'toolCall'),
      )
      assert.ok(argFrames.length >= 1, 'tool-call 参数流式必须出现在 live 帧受限投影中')
      const call = argFrames[argFrames.length - 1]!.generation!.message!.content.find((b) => b.type === 'toolCall') as {
        type: 'toolCall'
        name: string
        arguments?: unknown
      }
      assert.equal(call.name, 'bash')
      // 参数是解析中的 JSON 值（受限投影透传，速率策略据此计费）。
      assert.ok(call.arguments !== undefined)
    } finally {
      await close()
    }
  })
})
