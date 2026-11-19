/**
 * Generic streaming fact contracts for ConversationLive.generation (zero rate-calculation policy in kernel):
 *
 * 1. Pure functions: liveGenerationOf / deriveConversationLive perform bounded projection --
 *    taskId (from live.run.taskId) and positive integer attempt; message keeps only
 *    text/thinking/toolCall (name+arguments) and provider cumulative usage.output, stripping other
 *    fields (timestamp/model metadata/invalid chunks); omits projection when taskId is missing
 *    (identity is never fabricated);
 * 2. EventHub boundary: conversation.live accepts valid generation payloads and explicitly rejects
 *    invalid shapes (non-positive-integer taskId/attempt, non-array message.content, invalid usage,
 *    unknown fields) without advancing seq; conversation.entry.taskId is optional but must be valid;
 * 3. Real SDK layer (faux provider driving ConversationTracker): live frames during streaming turns
 *    carry generation (taskId + attempt + cumulative message including toolCall arguments); frames
 *    continue streaming during pure tool-call argument deltas (fingerprint includes generation), and
 *    generation disappears on terminal flush; assistant entry taskId (byTaskId) links to the same
 *    streaming generation.taskId source.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import type { ConversationEntry, ConversationLive, HelmxEventFrame, HelmxSnapshot } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, liveGenerationOf } from '../src/runtime/entries.js'
import { EventHub } from '../src/runtime/events.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { HelmxStore, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

// ---------------------------------------------------------------------------
// 1. Pure functions: bounded projection
// ---------------------------------------------------------------------------

describe('liveGenerationOf: bounded projection (generic facts, zero policy)', { timeout: 60_000 }, () => {
  it('valid taskId+attempt with missing/empty message omits message', { timeout: 60_000 }, () => {
    assert.deepEqual(liveGenerationOf({ attempt: 1 }, 7), { taskId: 7, attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 3, message: { content: [] } }, 7), { taskId: 7, attempt: 3 })
    assert.deepEqual(liveGenerationOf({ attempt: 2, message: undefined }, 7), { taskId: 7, attempt: 2 })
  })

  it('projects text / thinking / toolCall (name+arguments) and provider cumulative usage', { timeout: 60_000 }, () => {
    const generation = liveGenerationOf(
      {
        attempt: 1,
        message: {
          content: [
            { type: 'thinking', thinking: 'reasoning' },
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
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'answer text' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: { output: 42 },
      },
    })
  })

  it('filters invalid/unknown chunks or omits projection wholesale without fabricating', { timeout: 60_000 }, () => {
    // Non-positive-integer attempt / taskId: omits entire generation (never fabricates identity; LiveStateShape guard).
    assert.equal(liveGenerationOf({ attempt: 0 }, 7), undefined)
    assert.equal(liveGenerationOf({ attempt: Number.NaN }, 7), undefined)
    assert.equal(liveGenerationOf(undefined, 7), undefined)
    assert.equal(liveGenerationOf({ attempt: 1 }, 0), undefined, 'non-positive-integer taskId skips projection')
    assert.equal(liveGenerationOf({ attempt: 1 }, Number.NaN), undefined)
    assert.equal(liveGenerationOf({ attempt: 1 }, undefined), undefined, 'missing run.taskId skips projection')
    // Non-array content / non-object message: omits message.
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: 'bad' }, 7), { taskId: 7, attempt: 1 })
    assert.deepEqual(liveGenerationOf({ attempt: 1, message: { content: 'bad' } }, 7), { taskId: 7, attempt: 1 })
    // Unknown chunk types and invalid fields are stripped; omits message if nothing valid remains.
    assert.deepEqual(
      liveGenerationOf({ attempt: 1, message: { content: [{ type: 'image', data: 'x' }, { type: 'text', text: 42 }] } }, 7),
      { taskId: 7, attempt: 1 },
    )
    // Non-positive / non-numeric usage.output: omits usage (never estimates to fill provider omissions).
    const noUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: 0 } } }, 7)
    assert.equal(noUsage?.message?.usage, undefined)
    const nanUsage = liveGenerationOf({ attempt: 1, message: { content: [{ type: 'text', text: 'a' }], usage: { output: Number.NaN } } }, 7)
    assert.equal(nanUsage?.message?.usage, undefined)
  })

  it('deriveConversationLive reads generation (taskId comes from live.run; missing run skips projection)', { timeout: 60_000 }, () => {
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
    // Missing run.taskId: generation fact is not projected (text rendering remains unaffected).
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
// 2. EventHub boundary shape validation
// ---------------------------------------------------------------------------

describe('conversation.live generation event boundary validation', { timeout: 60_000 }, () => {
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
      } as HelmxSnapshot),
    })
  }

  const baseLive = { conversationId: 1, text: '', tools: [], updatedAt: 1 }

  it('valid generation (taskId+attempt-only or full projection) passes publishTransientLive; durable publish rejects live and validates entry.taskId', { timeout: 60_000 }, () => {
    const hub = hubOf()
    try {
      const received: number[] = []
      hub.subscribeTransientLive((f) => received.push(f.live.generation?.attempt ?? 0))

      assert.throws(
        () => hub.publish('conversation.live', { live: { ...baseLive, generation: { taskId: 1, attempt: 1 } } }),
        (error: unknown) => error instanceof HelmxError && error.code === 'invalid_event',
      )

      hub.publishTransientLive({ ...baseLive, generation: { taskId: 1, attempt: 1 } })
      hub.publishTransientLive({
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
      })
      assert.equal(hub.seq, 0, 'transient live generation broadcasts must not advance EventHub.seq')
      assert.deepEqual(received, [1, 2])

      hub.publish('conversation.entry', {
        conversationId: 1,
        entry: { id: '9', kind: 'pi.assistant', taskId: 3, model: [] },
      })
      hub.publish('conversation.entry', {
        conversationId: 1,
        entry: { id: '10', kind: 'pi.assistant', model: [] },
      })
      assert.equal(hub.seq, 2)
    } finally {
      hub.close()
    }
  })

  it('invalid generation / entry.taskId rejects explicitly without advancing seq (never silently degrades)', { timeout: 60_000 }, () => {
    const hub = hubOf()
    try {
      const rejects: unknown[] = [
        { attempt: 0 }, // non-positive integer
        { attempt: 1.5 }, // non-integer
        { attempt: '1' }, // non-number
        { attempt: 1 }, // missing taskId (cannot publish without identity)
        { taskId: 1 }, // missing attempt
        { taskId: 0, attempt: 1 }, // non-positive integer taskId
        { taskId: 1.5, attempt: 1 }, // non-integer taskId
        { taskId: 1, attempt: 1, extra: true }, // unknown field
        { taskId: 1, attempt: 1, message: null }, // non-object message
        { taskId: 1, attempt: 1, message: { content: 'bad' } }, // non-array content
        { taskId: 1, attempt: 1, message: { content: [{ type: 'unknown' }] } }, // unknown chunk type
        { taskId: 1, attempt: 1, message: { content: [{ type: 'text', text: 1 }] } }, // invalid chunk field
        { taskId: 1, attempt: 1, message: { content: [{ type: 'text', text: 'a', extra: 1 }] } }, // unknown chunk field
        { taskId: 1, attempt: 1, message: { content: [], usage: 'bad' } }, // invalid usage
        { taskId: 1, attempt: 1, message: { content: [], usage: { output: 0 } } }, // non-positive output
        { taskId: 1, attempt: 1, message: { content: [], usage: { output: 5, input: 1 } } }, // unknown usage field
      ]
      for (const generation of rejects) {
        assert.throws(
          () => hub.publishTransientLive({ ...baseLive, generation } as never),
          (error: unknown) => error instanceof HelmxError,
          `must reject ${JSON.stringify(generation)}`,
        )
      }
      assert.throws(
        () => hub.publish('conversation.entry', { conversationId: 1, entry: { id: '9', kind: 'pi.assistant', taskId: 0, model: [] } }),
        (error: unknown) => error instanceof HelmxError,
        'entry.taskId may be omitted but must be valid if present',
      )
      assert.equal(hub.seq, 0, 'rejected events must not advance seq')
    } finally {
      hub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Real SDK: live frames during streaming carry generation facts
// ---------------------------------------------------------------------------

describe('ConversationTracker real SDK: live frame generation facts', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helmx-live-generation-')
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
    const database = await openHelmxDatabase(dir)
    const store = new HelmxStore(database)
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
        if (err !== undefined) throw new HelmxError('store_flush_failed', String(err), 500)
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

  it('text streaming: live frames carry generation (taskId/attempt, monotonic cumulative message, cleared on settle; matches entry.taskId)', { timeout: 60_000 }, async () => {
    // Throttled stream (faux tokensPerSecond): partial commit cadence (100ms) yields multiple cumulative snapshots.
    const { tracker, harness, lives, entries, faux, close } = await openTracker({ tokensPerSecond: 20 })
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      const store = (tracker as unknown as { store: HelmxStore }).store
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      faux.setResponses([fauxAssistantMessage('one two three four five six seven eight nine ten')])
      await conv.submit({ type: 'input', content: 'prompt' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => lives.some((live) => live.generation !== undefined))

      const withGeneration = lives.filter((live) => live.generation !== undefined)
      assert.ok(withGeneration.length >= 1, 'live frames carrying generation must be emitted during streaming')
      const generationTaskIds = new Set<number>()
      for (const live of withGeneration) {
        const generation = live.generation!
        assert.equal(typeof generation.taskId, 'number')
        assert.ok(Number.isInteger(generation.taskId) && generation.taskId >= 1)
        generationTaskIds.add(generation.taskId)
        assert.equal(typeof generation.attempt, 'number')
        assert.ok(generation.attempt >= 1)
        if (generation.message !== undefined) {
          // Bounded projection: no extra fields leak outside content and usage.
          for (const block of generation.message.content) {
            assert.ok(block.type === 'text' || block.type === 'thinking' || block.type === 'toolCall')
          }
        }
      }
      // Single turn, single request: all frames share the same taskId (stable generation identity).
      assert.equal(generationTaskIds.size, 1)
      // On settlement: assistant entry exposes taskId via byTaskId, correlating with streaming generation.taskId
      // (completing the loop for rate accounting).
      const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
      assert.ok(assistant !== undefined, 'pi.assistant entry must be persisted at turn end')
      assert.equal(assistant.taskId, [...generationTaskIds][0], 'entry.taskId and generation.taskId belong to the same generation task')
      // Message snapshots are monotonically cumulative (text character count never regresses).
      const textLengths = withGeneration.map(
        (live) => (live.generation?.message?.content ?? []).reduce((acc, b) => acc + (b.type === 'text' ? b.text.length : 0), 0),
      )
      for (let i = 1; i < textLengths.length; i += 1) {
        assert.ok(textLengths[i]! >= textLengths[i - 1]!, `cumulative snapshot must be monotonic: ${textLengths.join(',')}`)
      }
      // Settled flush frame (after turn ends) clears generation.
      await waitFor(() => lives[lives.length - 1]?.text === '' && lives[lives.length - 1]?.tools.length === 0)
      assert.equal(lives[lives.length - 1]?.generation, undefined, 'generation clears on terminal frame')
    } finally {
      await close()
    }
  })

  it('pure tool-call streaming: live frames still flow as arguments grow (fingerprint includes generation) with bounded argument projection', { timeout: 60_000 }, async () => {
    const { tracker, harness, lives, faux, close } = await openTracker({ tokensPerSecond: 20 })
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      const store = (tracker as unknown as { store: HelmxStore }).store
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one two three four five six seven eight nine ten' })], { stopReason: 'toolUse' }),
      ])
      await conv.submit({ type: 'input', content: 'run command' }, BACKGROUND_CONTEXT)
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      // bash is not registered: invocation produces a tool_unavailable error result without affecting generation observation.
      await waitFor(() => lives.some((live) => live.generation?.message !== undefined))

      const argFrames = lives.filter(
        (live) => (live.generation?.message?.content ?? []).some((b) => b.type === 'toolCall'),
      )
      assert.ok(argFrames.length >= 1, 'tool-call argument streaming must appear in live frame bounded projection')
      const call = argFrames[argFrames.length - 1]!.generation!.message!.content.find((b) => b.type === 'toolCall') as {
        type: 'toolCall'
        name: string
        arguments?: unknown
      }
      assert.equal(call.name, 'bash')
      // Arguments arrive as parsed JSON values (passed through bounded projection for downstream rate accounting).
      assert.ok(call.arguments !== undefined)
    } finally {
      await close()
    }
  })
})
