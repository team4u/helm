/**
 * ConversationLive.generation through use streaming fact contract (kernel zero rate compute):
 *
 * 1. pure function layer:liveGenerationOf / deriveConversationLive subject to limit throw shadow - -
 *    taskId(from live.run.taskId) and attempt positive integer,message only contains
 *    text/thinking/toolCall(name+arguments) and provider cumulative usage.output, the rest
 *    field (timestamp/model metadata/illegal chunk) do not outside leak; without taskId do not throw shadow (identity cannot fabricate);
 * 2. EventHub boundary:conversation.live carry legal generation via, illegal shape
 *    (taskId/attempt non- positive integer / message.content non- array / usage non- correct /
 *    unknown field) explicit reject and do not push enter seq;conversation.entry  taskId can missing cannot wrong;
 * 3. real SDK layer (faux provider drive ConversationTracker): streaming turn during
 *    live frame carry generation(taskId + attempt + cumulative message, contains toolCall parameter),
 *    pure tool-call parameter streaming during frame still stream motion (refer grain contains generation), terminal state conflict refresh frame
 *    generation disappear;assistant entry  taskId(byTaskId) and streaming
 *    generation.taskId same source can related.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import type { ConversationEntry, ConversationLive, HelmEventFrame, HelmSnapshot } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, liveGenerationOf } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// 1. pure function: subject to limit throw shadow
// ---------------------------------------------------------------------------

describe('liveGenerationOf: subject to limit throw shadow (through use fact, zero policy)', { timeout: 60_000 }, () => {
  it('taskId+attempt(message default/without content) legal:message omit', { timeout: 60_000 }, () => {
    assert.deepEqual(liveGenerationOf({ attempt: 1 }, 7), { taskId: 7, attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 3, message: { content: [] } }, 7), { taskId: 7, attempt: 3 })
    assert.deepEqual(liveGenerationOf({ attempt: 2, message: undefined }, 7), { taskId: 7, attempt: 2 })
  })

  it('text / thinking / toolCall(name+arguments) and provider cumulative usage throw shadow', { timeout: 60_000 }, () => {
    const generation = liveGenerationOf(
      {
        attempt: 1,
        message: {
          content: [
            { type: 'thinking', thinking: 'push in' },
            { type: 'text', text: 'answer text' },
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
          ],
          usage: { input: 100, output: 42, cacheRead: 0, cacheWrite: 0 },
          timestamp: 123,
          model: 'faux/faux-1',
        },
      },
      9,
    )
    assert.deepEqual(generation, {
      taskId: 9,
      attempt: 1,
      message: {
        content: [
          { type: 'thinking', thinking: 'push in' },
          { type: 'text', text: 'answer text' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: { output: 42 },
      },
    })
  })

  it('illegal / unknown chunk shape by filter or whole omit, do not fabricate', { timeout: 60_000 }, () => {
    // attempt / taskId non- positive integer: whole omit (identity cannot fabricate,LiveStateShape guard against defend).
    assert.equal(liveGenerationOf({ attempt: 0 }, 7), undefined)
    assert.equal(liveGenerationOf({ attempt: Number.NaN }, 7), undefined)
    assert.equal(liveGenerationOf(undefined, 7), undefined)
    assert.equal(liveGenerationOf({ attempt: 1 }, 0), undefined, 'taskId non- positive integer do not throw shadow')
    assert.equal(liveGenerationOf({ attempt: 1 }, Number.NaN), undefined)
    assert.equal(liveGenerationOf({ attempt: 1 }, undefined), undefined, 'without run.taskId do not throw shadow')
    // content non- array / message non- object:message omit.
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: 'bad' }, 7), { taskId: 7, attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: { content: 'bad' } }, 7), { taskId: 7, attempt: 1 })
    // unknown chunk type and illegal field by filter; all invalid when message omit.
    assert.deepEqual(
      liveGenerationOf({ attempt: 1, message: { content: [{ type: 'image', data: 'x' }, { type: 'text', text: 42 }] } }, 7),
      { taskId: 7, attempt: 1 },
    )
    // usage.output non- correct / non- count:usage omit (do not use estimate compute smoke fill provider on report).
    const noUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: 0 } } }, 7)
    assert.equal(noUsage?.message?.usage, undefined)
    const nanUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: Number.NaN } } }, 7)
    assert.equal(nanUsage?.message?.usage, undefined)
  })

  it('deriveConversationLive:generation reference and derive (taskId take self run; without run do not throw shadow)', { timeout: 60_000 }, () => {
    const live = deriveConversationLive(
      7,
      {
        run: { taskId: 12 },
        generation: { attempt: 1, message: { content: [{ type: 'text', text: '你好' }] } },
      },
      123,
    )
    assert.equal(live.conversationId, 7)
    assert.equal(live.text, '你好')
    assert.deepEqual(live.generation, {
      taskId: 12,
      attempt: 1,
      message: { content: [{ type: 'text', text: '你好' }] },
    })
    // without run.taskId:generation fact do not throw shadow (text render do not subject to affect).
    const anonymous = deriveConversationLive(
      7,
      { generation: { attempt: 1, message: { content: [{ type: 'text', text: '你好' }] } } },
      123,
    )
    assert.equal(anonymous.text, '你好')
    assert.equal(anonymous.generation, undefined)
    const idle = deriveConversationLive(7, { generation: undefined }, 456)
    assert.equal(idle.generation, undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. EventHub boundary shape validate
// ---------------------------------------------------------------------------

describe('conversation.live generation event boundary validate', { timeout: 60_000 }, () => {
  function hubOf(): EventHub {
    return new EventHub({
      initialSeq: 0,
      snapshot: () => ({
        bootId: 'test-boot',
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

  it('legal generation(taskId+attempt-only / all amount throw shadow) via;entry.taskId can missing cannot wrong', { timeout: 60_000 }, () => {
    const hub = hubOf()
    hub.publish('conversation.live', { live: { ...baseLive, generation: { taskId: 1, attempt: 1 } } })
    hub.publish('conversation.live', {
      live: {
        ...baseLive,
        generation: {
          taskId: 1,
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
    hub.publish('conversation.entry', {
      conversationId: 1,
      entry: { id: '9', kind: 'pi.assistant', taskId: 3, model: [] },
    })
    hub.publish('conversation.entry', {
      conversationId: 1,
      entry: { id: '10', kind: 'pi.assistant', model: [] },
    })
    assert.equal(hub.seq, 4)
  })

  it('illegal generation / entry.taskId explicit reject and do not push enter seq(not silently fall back)', { timeout: 60_000 }, () => {
    const hub = hubOf()
    const rejects: unknown[] = [
      { attempt: 0 }, // non- positive integer
      { attempt: 1.5 }, // non- integer
      { attempt: '1' }, // non- number
      { attempt: 1 }, // missing taskId(identity do not cannot publish)
      { taskId: 1 }, // missing attempt
      { taskId: 0, attempt: 1 }, // taskId non- positive integer
      { taskId: 1.5, attempt: 1 }, // taskId non- integer
      { taskId: 1, attempt: 1, extra: true }, // unknown field
      { taskId: 1, attempt: 1, message: null }, // message non- object
      { taskId: 1, attempt: 1, message: { content: 'bad' } }, // content non- array
      { taskId: 1, attempt: 1, message: { content: [{ type: 'unknown' }] } }, // unknown chunk type
      { taskId: 1, attempt: 1, message: { content: [{ type: 'text', text: 1 }] } }, // chunk field illegal
      { taskId: 1, attempt: 1, message: { content: [{ type: 'text', text: 'a', extra: 1 }] } }, // chunk unknown field
      { taskId: 1, attempt: 1, message: { content: [], usage: 'bad' } }, // usage illegal
      { taskId: 1, attempt: 1, message: { content: [], usage: { output: 0 } } }, // non- correct output
      { taskId: 1, attempt: 1, message: { content: [], usage: { output: 5, input: 1 } } }, // usage unknown field
    ]
    for (const generation of rejects) {
      assert.throws(
        () => hub.publish('conversation.live', { live: { ...baseLive, generation } }),
        (error: unknown) => error instanceof HelmError,
        `must reject ${JSON.stringify(generation)}`,
      )
    }
    assert.throws(
      () => hub.publish('conversation.entry', { conversationId: 1, entry: { id: '9', kind: 'pi.assistant', taskId: 0, model: [] } }),
      (error: unknown) => error instanceof HelmError,
      'entry.taskId can missing cannot wrong',
    )
    assert.equal(hub.seq, 0, 'reject do not push enter seq')
  })
})

// ---------------------------------------------------------------------------
// 3. real SDK: streaming turn live frame carry generation
// ---------------------------------------------------------------------------

describe('ConversationTracker real SDK:live frame generation fact', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-live-generation-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  async function openTracker(options?: { tokensPerSecond?: number }): Promise<{
    tracker: ConversationTracker
    harness: Harness
    lives: ConversationLive[]
    entries: ConversationEntry[]
    faux: ReturnType<typeof makeFauxModels>['faux']
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels({ tokensPerSecond: options?.tokensPerSecond })
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry },
      BACKGROUND_CONTEXT,
    )
    harness.resume()
    const lives: ConversationLive[] = []
    const entries: ConversationEntry[] = []
    const events: TrackerEvents = {
      onSummaryChanged: () => {},
      onInputCommitted: () => {},
      onAssistantText: () => {},
      onTurnSettled: () => {},
      onLiveChanged: (live) => lives.push(live),
      onEntryCommitted: (_id, entry) => entries.push(entry),
    }
    const tracker = new ConversationTracker({ harness, store, events })
    return {
      tracker,
      harness,
      lives,
      entries,
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
      title: `conversation ${id}`,
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

  it('text streaming: frame carry generation(taskId/attempt pass increase snapshot,message cumulative, terminal state frame disappear;entry.taskId same source can related)', { timeout: 60_000 }, async () => {
    // slow fast stream (faux tokensPerSecond):partial commit node stream (100ms) visible multiple cumulative snapshot.
    const { tracker, harness, lives, entries, faux, close } = await openTracker({ tokensPerSecond: 20 })
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      const store = (tracker as unknown as { store: HelmStore }).store
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      faux.setResponses([fauxAssistantMessage('one two three four five six seven eight nine ten')])
      await conv.submit({ type: 'input', content: 'issue' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => lives.some((live) => live.generation !== undefined))

      const withGeneration = lives.filter((live) => live.generation !== undefined)
      assert.ok(withGeneration.length >= 1, 'streaming during must out carry generation  live frame')
      const generationTaskIds = new Set<number>()
      for (const live of withGeneration) {
        const generation = live.generation!
        assert.equal(typeof generation.taskId, 'number')
        assert.ok(Number.isInteger(generation.taskId) && generation.taskId >= 1)
        generationTaskIds.add(generation.taskId)
        assert.equal(typeof generation.attempt, 'number')
        assert.ok(generation.attempt >= 1)
        if (generation.message !== undefined) {
          // subject to limit throw shadow: content and usage of outside without field leak leak.
          for (const block of generation.message.content) {
            assert.ok(block.type === 'text' || block.type === 'thinking' || block.type === 'toolCall')
          }
        }
      }
      // single round single request: all frame the same taskId(generate task identity stable).
      assert.equal(generationTaskIds.size, 1)
      // terminal state:assistant entry fold byTaskId throw shadow taskId, and streaming generation.taskId
      // same source can related (rate for account connect key closed ring).
      const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
      assert.ok(assistant !== undefined, 'turn end must written to the database pi.assistant entry')
      assert.equal(assistant.taskId, [...generationTaskIds][0], 'entry.taskId and generation.taskId the same generate task')
      // message cumulative snapshot single tune (text chunk character count does not fall back).
      const textLengths = withGeneration.map(
        (live) => (live.generation?.message?.content ?? []).reduce((acc, b) => acc + (b.type === 'text' ? b.text.length : 0), 0),
      )
      for (let i = 1; i < textLengths.length; i += 1) {
        assert.ok(textLengths[i]! >= textLengths[i - 1]!, `cumulative snapshot single tune:${textLengths.join(',')}`)
      }
      // terminal state conflict refresh frame (turn after end) no longer carry generation.
      await waitFor(() => lives[lives.length - 1]?.text === '' && lives[lives.length - 1]?.tools.length === 0)
      assert.equal(lives[lives.length - 1]?.generation, undefined, 'terminal state frame generation disappear')
    } finally {
      await close()
    }
  })

  it('pure tool-call streaming: parameter increase long during frame still stream motion (refer grain contains generation), parameter enter subject to limit throw shadow', { timeout: 60_000 }, async () => {
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
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one two three four five six seven eight nine ten' })], { stopReason: 'toolUse' }),
      ])
      await conv.submit({ type: 'input', content: 'run command' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      // bash not registered: invoke with tool_unavailable error result compute (does not affect generation observe).
      await waitFor(() => lives.some((live) => live.generation?.message !== undefined))

      const argFrames = lives.filter(
        (live) => (live.generation?.message?.content ?? []).some((b) => b.type === 'toolCall'),
      )
      assert.ok(argFrames.length >= 1, 'tool-call parameter streaming must appear in live frame subject to limit throw shadow in')
      const call = argFrames[argFrames.length - 1]!.generation!.message!.content.find((b) => b.type === 'toolCall') as {
        type: 'toolCall'
        name: string
        arguments?: unknown
      }
      assert.equal(call.name, 'bash')
      // parameter is parse in JSON value (subject to limit throw shadow pass-through, rate policy based on this count cost).
      assert.ok(call.arguments !== undefined)
    } finally {
      await close()
    }
  })
})
