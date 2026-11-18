/**
 * Regression tests for exact turn_settled tracking versus pi-durable run handOver.
 *
 * Bug background (locked down by this suite):
 * - The tracker treated ANY pi.live.run.taskId change as a run end. But pi-durable hands run control to a NEW
 *   generation task after every tool round (finishToolRound postTools boundary) and on onYield continuations:
 *   taskId changes while the run continues (`first` kept, inputs carried over). A turn with tool rounds therefore
 *   emitted one spurious turn_settled(completed) per round — mid-turn settlement consumers (swarm silent-exit
 *   detection, coordinator report flush, superagent watchdogs, workflow settlement) all misfired, and completionSeq
 *   was inflated per round.
 *
 * Current contract:
 * 1. A multi-round tool turn settles exactly once, at the true run end, with outcome completed;
 * 2. Back-to-back turns (new run after an answered run) each settle once — same-run handOver suppression must not
 *    swallow genuine new runs;
 * 3. isContinuedRun discriminates handOver (same first / inputs carry-over) from a replacement run (fresh first,
 *    disjoint inputs); ambiguity resolves to "new run".
 *
 * Driven by a real Harness (faux provider + real SQLite + real observer pipeline), same wiring as live-generation tests.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, isContinuedRun, type TrackerEvents } from '../src/runtime/conversations.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, type ConvMeta } from '../src/runtime/store.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

let root = ''

before(async () => {
  root = await makeTempDir('helm-tracker-settlement-')
})

after(async () => {
  await cleanupDir(root)
})

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

interface SettlementRecord {
  outcome: string
  error: string | undefined
  inputIds: string[]
}

async function openTracker(): Promise<{
  tracker: ConversationTracker
  harness: Harness
  settled: SettlementRecord[]
  faux: ReturnType<typeof makeFauxModels>['faux']
  conversationId: number
  close: () => Promise<void>
}> {
  const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const database = await openHelmDatabase(dir)
  const store = new HelmStore(database)
  await store.load()
  const { models, faux } = makeFauxModels()
  const harness = await Harness.open(
    database.storage,
    { models: () => models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  )
  harness.resume()
  const settled: SettlementRecord[] = []
  const events: TrackerEvents = {
    onSummaryChanged: () => {},
    onInputCommitted: () => {},
    onAssistantText: () => {},
    onTurnSettled: (payload, inputs) => {
      settled.push({ outcome: payload.outcome, error: payload.error, inputIds: inputs.map((i) => i.id) })
    },
    onLiveChanged: () => {},
  }
  const tracker = new ConversationTracker({ harness, store, events })
  const conv = await harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    BACKGROUND_CONTEXT,
  )
  const conversationId = conv.id as number
  store.upsertConv(convMeta(conversationId))
  await tracker.observe(conversationId)
  return {
    tracker,
    harness,
    settled,
    faux,
    conversationId,
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

// ---------------------------------------------------------------------------
// 1. Pure function: logical-run identity across handOver
// ---------------------------------------------------------------------------

describe('isContinuedRun: logical-run identity (generic facts, zero policy)', { timeout: 60_000 }, () => {
  it('same taskId is the same run', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1] }, { taskId: 7, inputs: [1] }))
  })

  it('handOver: taskId changed, first kept, inputs carried (equal or grown) is the same run', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [1], first: 10 }))
    assert.ok(
      isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [1, 2], first: 10 }),
      'steers admitted at the postTools boundary grow the carried inputs',
    )
  })

  it('replacement run: fresh first is a new run even when taskId changed in one collapsed snapshot', { timeout: 60_000 }, () => {
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [2], first: 12 }))
    assert.ok(
      !isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, { taskId: 9, inputs: [2] }),
      'a new run whose first was not recorded falls through to disjoint inputs',
    )
  })

  it('run disappearance is never a continuation', { timeout: 60_000 }, () => {
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1], first: 10 }, undefined))
  })

  it('first unrecorded on both sides falls back to inputs carry-over', { timeout: 60_000 }, () => {
    assert.ok(isContinuedRun({ taskId: 7, inputs: [1, 2] }, { taskId: 9, inputs: [1, 2, 3] }))
    assert.ok(!isContinuedRun({ taskId: 7, inputs: [1] }, { taskId: 9, inputs: [2] }))
    assert.ok(
      !isContinuedRun({ taskId: 7, inputs: [] }, { taskId: 9, inputs: [1] }),
      'no identity evidence resolves to a new run (settle), never a silent continuation',
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Runtime: exact settlement emission with real handOver rounds
// ---------------------------------------------------------------------------

describe('ConversationTracker settlement vs run handOver (real harness)', { timeout: 60_000 }, () => {
  it('a multi-round tool turn settles exactly once at the true run end', { timeout: 60_000 }, async () => {
    const { tracker, harness, settled, faux, close, conversationId } = await openTracker()
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined, 'conversation handle must resolve')
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo two' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('final answer'),
      ])
      tracker.registerInput(conversationId, { id: 'req-1', text: 'run then answer', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'run then answer' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-1', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length > 0)

      // Pre-fix this fired once per tool round (spurious mid-turn completions).
      assert.equal(settled.length, 1, `expected exactly one settlement, got ${JSON.stringify(settled)}`)
      assert.equal(settled[0]!.outcome, 'completed')
      assert.equal(settled[0]!.error, undefined)
      // The single input stays tracked across both tool-round handOvers and settles with the run.
      assert.deepEqual(settled[0]!.inputIds, ['req-1'])
    } finally {
      await close()
    }
  })

  it('back-to-back turns each settle once (suppression must not swallow new runs)', { timeout: 60_000 }, async () => {
    const { tracker, harness, settled, faux, close, conversationId } = await openTracker()
    try {
      const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT)
      assert.ok(conv !== undefined, 'conversation handle must resolve')
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo one' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('first answer'),
        fauxAssistantMessage('second answer'),
      ])
      tracker.registerInput(conversationId, { id: 'req-1', text: 'first turn', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'first turn' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-1', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      tracker.registerInput(conversationId, { id: 'req-2', text: 'second turn', origin: 'human', createdAt: Date.now() })
      await conv.submit(
        { type: 'input', content: 'second turn' },
        BACKGROUND_CONTEXT,
      ).then((submission) => tracker.bindSubmission(conversationId, 'req-2', submission.id as number))
      await harness.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(() => settled.length >= 2)

      assert.equal(settled.length, 2, `expected two settlements, got ${JSON.stringify(settled)}`)
      assert.ok(settled.every((s) => s.outcome === 'completed'))
      assert.deepEqual(settled[0]!.inputIds, ['req-1'])
      assert.deepEqual(settled[1]!.inputIds, ['req-2'])
    } finally {
      await close()
    }
  })
})
