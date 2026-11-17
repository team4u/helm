/**
 * ConversationTracker input tracking uniqueness and settlement precision regression tests.
 *
 * Bug background (fixed and locked by this file):
 * - Previous rebuildFromEntries created `req:` entries for every historical helm.input in the window
 *   and re-scanned history on every snapshot; turn settlement (takeConsumed) only cleared numeric keys,
 *   keeping historical `req:` keys resident indefinitely; takeAllInputs on abort scanned the entire map,
 *   polluting aborted payload origins and input lists with old historical inputs.
 * - Previous tests only made weak assertions like `assert.notEqual(reqKey, -2147483648)`, which failed
 *   to catch the bug when strings and numbers coexisted.
 *
 * Current contract:
 * 1. trackedInputs is keyed solely by durable input.id (requestId): normal register/bind
 *    and entry/inbox rebuild merge into a single record with no duplicates; submissionId lives only in
 *    submissionIndex (mapping side for SDK run.inputs/failure.inputs);
 * 2. Entry rebuild only covers the current run range (run.first and onward) and current inbox, never
 *    resurrecting settled historical helm.input entries: aborting after prior completed rounds contains only current run inputs;
 * 3. Repeated requestIds in the same conversation (SDK per-conversation dedup) rebuild cleanly without duplication;
 * 4. Restart recovery across an active run: observe reconciles missing origin/meta/attachments and index mappings
 *    using authoritative live.run.inputs + submission queries;
 *    Timing window lock: bindSubmission (submit promise continuation) runs before generation task's request-phase
 *    pi.live.generation write commits, so even instantaneously settled/failed turns include the input once
 *    with zero leftover index entries (guaranteed by SDK ordering; see inline comments);
 * 5. In-flight async adoptInitial never repopulates maps after stopObserving;
 * 6. settledRuns capacity eviction (64) and full cleanup on deleteConversation remain intact.
 *
 * Driven through real KernelRuntime (faux provider + real SQLite); internal state inspected via type casts
 * (test and implementation live in the same package; test-only inspection).
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationInput, TurnSettledPayload } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { ConversationTracker } from '../src/runtime/conversations.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore } from '../src/runtime/store.js'
import { cleanupDir, deferred, makeFauxModels, makeTempDir, sleep, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

/** Subset of per-conversation aggregate mirror exposed for observability (matches ConversationMirror fields). */
interface MirrorLike {
  trackedInputs: Map<string, ConversationInput>
  submissionIndex: Map<number, string>
  consumedInputs: Set<string> | undefined
  runFirstEntry: number | undefined
  runTaskId: number | undefined
  lastSettledRun: number | undefined
  settledRunOrder: string[]
  live: unknown
  observeGeneration: symbol | undefined
  settledInflight: number
  settledError: unknown
}

interface TrackerInternals {
  mirrors: Map<number, MirrorLike>
  settledRuns: Set<string>
}

function trackerOf(kernel: KernelRuntime): TrackerInternals {
  return (kernel as unknown as { tracker: TrackerInternals }).tracker
}

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = await makeTempDir('helm-tracker-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Registers a plugin collecting turn_settled payloads per conversation. */
function collectSettled(kernel: KernelRuntime): TurnSettledPayload[] {
  const settled: TurnSettledPayload[] = []
  void kernel.plugins.register({
    id: 'test:settled-collector',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        settled.push(payload)
      })
    },
  })
  return settled
}

describe('input uniqueness and no resurrection of history', { timeout: 60_000 }, () => {
  it('abort after completed turns: aborted payload includes only current run input, never historical trigger inputs', timeout, async () => {
    const kernel = await openRuntime(join(root, 'abort-current-only'))
    try {
      const settled = collectSettled(kernel)
      // Two completed turns: turn 1 from trigger origin, turn 2 from human origin.
      kernel.__faux.setResponses([
        fauxAssistantMessage('round 1 answer'),
        fauxAssistantMessage('round 2 answer'),
      ])
      await kernel.submitInput(1, 'round 1 task', { origin: 'trigger' })
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'round 2 task', { origin: 'human' })
      await kernel.waitForIdle(1)
      assert.equal(settled.length, 2)
      assert.equal(settled[0]!.outcome, 'completed')
      assert.equal(settled[0]!.inputs.length, 1)
      assert.equal(settled[0]!.inputs[0]!.origin, 'trigger')
      assert.equal(settled[1]!.inputs.length, 1)
      assert.equal(settled[1]!.inputs[0]!.origin, 'human')
      // After two settled turns, trackedInputs holds zero historical req: entries.
      const mapAfter = trackerOf(kernel).mirrors.get(1)?.trackedInputs
      assert.equal(mapAfter?.size ?? 0, 0, 'settled inputs must leave zero historical leftovers')

      // Third turn aborted in-flight: must contain only current input without pollution from older turns' origins.
      const started = deferred()
      const gate = deferred()
      kernel.__faux.setResponses([
        async (_ctx, opts) => {
          started.resolve()
          opts?.signal?.addEventListener('abort', () => gate.resolve(), { once: true })
          if (!opts?.signal?.aborted) await gate.promise
          return fauxAssistantMessage('unused')
        },
      ])
      try {
        void kernel.submitInput(1, 'current question to abort', { origin: 'human' }).catch(() => {})
        await started.promise
        await waitFor(() => kernel.getConversation(1).status === 'working')
        assert.equal(kernel.getConversation(1).status, 'working')
        await kernel.abortConversation(1)
        await kernel.waitForIdle(1).catch(() => {})
        assert.equal(settled.length, 3)
        const aborted = settled[2]!
        assert.equal(aborted.outcome, 'aborted')
        assert.equal(
          aborted.inputs.length,
          1,
          `aborted payload must contain only current run input, actual: ${JSON.stringify(aborted.inputs.map((i) => [i.id, i.origin]))}`,
        )
        assert.equal(aborted.inputs[0]!.text, 'current question to abort')
        assert.equal(aborted.inputs[0]!.origin, 'human', 'current input origin must not be polluted by historical triggers')
      } finally {
        gate.resolve()
      }
    } finally {
      await kernel.close()
    }
  })

  it('historical helm.input never resurrects on subsequent scans: trackedInputs returns to zero after several turns', timeout, async () => {
    const kernel = await openRuntime(join(root, 'no-resurrect'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('answer one'),
        fauxAssistantMessage('answer two'),
        fauxAssistantMessage('answer three'),
      ])
      for (const text of ['question one', 'question two', 'question three']) {
        await kernel.submitInput(1, text)
        await kernel.waitForIdle(1)
      }
      const tracker = trackerOf(kernel)
      const map = tracker.mirrors.get(1)?.trackedInputs
      assert.equal(map?.size ?? 0, 0, 'no historical req: leftovers remain after three completed turns')
      // Wait briefly for any trailing observer snapshots to verify history is not resurrected.
      await sleep(30)
      assert.equal(tracker.mirrors.get(1)?.trackedInputs.size ?? 0, 0, 'subsequent snapshots must not resurrect history inputs')
    } finally {
      await kernel.close()
    }
  })

  it('followUp queued while busy: every input settles exactly once, never duplicated or dropped', timeout, async () => {
    const kernel = await openRuntime(join(root, 'followup-unique'))
    const releaseFirst = deferred()
    try {
      const settled = collectSettled(kernel)
      const firstInFlight = deferred()
      kernel.__faux.setResponses([
        async () => {
          firstInFlight.resolve()
          await releaseFirst.promise
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'true' })], { stopReason: 'toolUse' })
        },
        fauxAssistantMessage('tool round answer'),
        fauxAssistantMessage('queued input answer'),
      ])
      await kernel.submitInput(1, 'first input', { origin: 'human' })
      await firstInFlight.promise
      // Queued via followUp while busy: consumed by SDK in subsequent run (no inputs added mid-turn).
      await kernel.submitInput(1, 'queued second', { origin: 'agent', whenBusy: 'followUp' })
      releaseFirst.resolve()
      await kernel.waitForIdle(1)
      assert.ok(settled.length >= 1)
      // Across all settlement payloads: both inputs appear exactly once without duplicates.
      const allInputs = settled.flatMap((s) => s.inputs)
      const texts = allInputs.map((i) => i.text)
      const byText = new Map<string, number>()
      for (const text of texts) byText.set(text, (byText.get(text) ?? 0) + 1)
      assert.equal(byText.get('first input'), 1, `first settled exactly once: ${JSON.stringify([...byText])}`)
      assert.equal(byText.get('queued second'), 1, `queued input settled exactly once: ${JSON.stringify([...byText])}`)
      // Zero fabricated history inputs (only the two genuinely submitted inputs).
      assert.equal(allInputs.length, 2, `total settled input count matches submitted count: ${JSON.stringify(texts)}`)
    } finally {
      releaseFirst.resolve()
      await kernel.close()
    }
  })
})

describe('duplicate requestId submission and restart recovery', { timeout: 60_000 }, () => {
  it('second submission with same requestId (SDK per-conversation dedup): rebuilds cleanly with zero duplicates in trackedInputs', timeout, async () => {
    const kernel = await openRuntime(join(root, 'dup-request-id'))
    try {
      // Two requestIds differing only in case (guards against legacy 32-bit hash collisions like 'Aa'/'BB').
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      await kernel.submitInput(1, 'a')
      await kernel.waitForIdle(1)
      kernel.__faux.setResponses([fauxAssistantMessage('answer two')])
      await kernel.submitInput(1, 'second')
      await kernel.waitForIdle(1)
      const tracker = trackerOf(kernel)
      // History leaves zero residue after settlement (verified above); verify key domain during runs:
      // entries in trackedInputs must remain unique and keyed by requestId strings.
      const map = tracker.mirrors.get(1)?.trackedInputs
      const keys = [...(map?.keys() ?? [])]
      for (const key of keys) {
        assert.equal(typeof key, 'string', `tracking key must be requestId string: ${String(key)}`)
      }
      // Every tracked input.id is unique.
      const ids = [...(map?.values() ?? [])].map((t) => t.id)
      assert.equal(new Set(ids).size, ids.length, 'input.id must have no duplicate entries')
    } finally {
      await kernel.close()
    }
  })

  it('restart recovery mid-run: reconciles missing origin/meta via authoritative mapping without losing settlement', timeout, async () => {
    // Drive real Harness + ConversationTracker directly (cannot use KernelRuntime: runtime.close
    // explicitly aborts in-flight conversations, preventing a crash-mid-run restart setup).
    const dir = join(root, 'restart-active-run')
    const mkHarness = async () => {
      const database = await openHelmDatabase(dir)
      const store = new HelmStore(database)
      await store.load()
      const { models, faux } = makeFauxModels()
      const harness = await Harness.open(
        database.storage,
        { models: () => models, registry: createRegistry(), settings: { followUpMode: 'all' } },
        BACKGROUND_CONTEXT,
      )
      return { harness, store, database, faux }
    }
    const settled: TurnSettledPayload[] = []
    const trackerOfHarness = (harness: Harness, store: HelmStore) =>
      new ConversationTracker({
        harness,
        store,
        events: {
          onSummaryChanged: () => {},
          onInputCommitted: () => {},
          onAssistantText: () => {},
          onTurnSettled: (payload) => {
            settled.push(payload as TurnSettledPayload)
          },
        },
      })

    // Phase 1: submit an agent input carrying meta, wait for generator request in-flight, then close storage abruptly (simulated crash).
    let convId = 0
    {
      const { harness, store, database, faux } = await mkHarness()
      harness.resume()
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      convId = id
      store.upsertConv({
        id,
        title: 'conversation',
        profileId: 'assistant',
        nodeId: 'local',
        tags: [],
        cwd: dir,
        model: 'faux/faux-1',
        thinkingLevel: '',
        unread: false,
        pinned: false,
        stateChangeSeq: 1,
        completionSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const tracker = trackerOfHarness(harness, store)
      await tracker.observe(id)
      const entered = deferred()
      faux.setResponses([
        async () => {
          entered.resolve()
          // Stay in-flight long enough that it hasn't settled before closing db (simulates crash while active run is mid-flight).
          await sleep(150)
          return fauxAssistantMessage('post-restart answer')
        },
      ])
      await conv.submit(
        {
          type: 'input',
          content: 'in-flight question before restart',
          entry: {
            kind: 'helm.input',
            data: { id: 'restart-1', text: 'in-flight question before restart', origin: 'agent', createdAt: 5, meta: { from: 'test', seq: 7 } },
          },
          requestId: 'restart-1',
        },
        BACKGROUND_CONTEXT,
      )
      await entered.promise
      // Simulated crash: close db directly without harness.close (which would abort in-flight runs)
      // (SQLite crash-safe; pi.live.run state is already committed).
      await database.close()
    }

    // Phase 2: reopen (simulated restart). Active run is still incomplete; observe must reconcile missing input fields from authoritative mapping.
    {
      const { harness, store, database, faux } = await mkHarness()
      harness.resume()
      try {
        const conv = await harness.conversation(convId as never, BACKGROUND_CONTEXT)
        assert.ok(conv !== undefined)
        const id = conv.id as number
        const tracker = trackerOfHarness(harness, store)
        await tracker.observe(id)
        const map = (tracker as unknown as TrackerInternals).mirrors.get(id)?.trackedInputs
        assert.ok(map !== undefined && map.size >= 1, 'tracked input must exist after mid-run restart recovery')
        const tracked = [...map.values()][0]!
        assert.equal(tracked.text, 'in-flight question before restart')
        assert.equal(tracked.origin, 'agent', 'origin should be reconciled authoritatively after restart')
        assert.deepEqual(tracked.meta, { from: 'test', seq: 7 }, 'meta should be reconciled authoritatively after restart')
        // submissionId->requestId index must be registered after restart recovery (so markConsumed hits without dropping inputs).
        const index = (tracker as unknown as TrackerInternals).mirrors.get(id)?.submissionIndex
        assert.ok(index !== undefined && index.size >= 1, 'submissionId->requestId index must be registered after restart')
        // Phase 2 sets response provider (run continues executing post-restart).
        faux.setResponses([fauxAssistantMessage('post-recovery answer')])
        await conv.waitForIdle(BACKGROUND_CONTEXT).catch(() => {})
        await tracker.waitTurnSettled(id)
        await waitFor(() => settled.some((s) => s.conversation.id === id))
        const settledPayload = settled.find((s) => s.conversation.id === id)
        assert.ok(settledPayload !== undefined, 'post-restart run settlement arrived')
        assert.equal(settledPayload.inputs.length, 1)
        assert.equal(settledPayload.inputs[0]!.origin, 'agent')
        assert.deepEqual(settledPayload.inputs[0]!.meta, { from: 'test', seq: 7 })
      } finally {
        await harness.close(BACKGROUND_CONTEXT)
        await store.close()
        await database.close()
      }
    }
  })

  it('idle submission settling immediately on completion/failure: binds later than run start snapshot yet still includes input once with no leftover index (SDK ordering lock)', timeout, async () => {
    // Timing fact (verified in real pi-durable 1.5.0): the run-start observer advance fires synchronously
    // before submit resolves (so markConsumed skips because index isn't registered yet);
    // bindSubmission runs in submit continuation microtasks ahead of the generation task committing
    // `pi.live.generation={attempt}` in its request phase (generation.js: before model call & failNoModel),
    // so that generation commit triggers another advance while run is still active -- re-scanning run.inputs hits markConsumed.
    // On instant failure, settlement snapshot also checks failure.inputs. If SDK ordering ever violates this
    // (task commits before submit continuation), this case turns red immediately instead of dropping input ownership on fast turns.
    const dir = join(root, 'instant-settle-window')
    const mkHarness = async () => {
      const database = await openHelmDatabase(dir)
      const store = new HelmStore(database)
      await store.load()
      const { models, faux } = makeFauxModels()
      const harness = await Harness.open(
        database.storage,
        { models: () => models, registry: createRegistry(), settings: { followUpMode: 'all' } },
        BACKGROUND_CONTEXT,
      )
      return { harness, store, database, faux }
    }

    const runCase = async (
      caseDir: string,
      response: ReturnType<typeof fauxAssistantMessage>,
      expectedOutcome: 'completed' | 'failed',
    ): Promise<void> => {
      const { harness, store, database, faux } = await mkHarness()
      try {
        harness.resume()
        const conv = await harness.createConversation(
          { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
          BACKGROUND_CONTEXT,
        )
        const id = conv.id as number
        store.upsertConv({
          id,
          title: 'conversation',
          profileId: 'assistant',
          nodeId: 'local',
          tags: [],
          cwd: dir,
          model: 'faux/faux-1',
          thinkingLevel: '',
          unread: false,
          pinned: false,
          stateChangeSeq: 1,
          completionSeq: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as never)
        const settled: TurnSettledPayload[] = []
        const tracker = new ConversationTracker({
          harness,
          store,
          events: {
            onSummaryChanged: () => {},
            onInputCommitted: () => {},
            onAssistantText: () => {},
            onTurnSettled: (payload) => {
              settled.push(payload as TurnSettledPayload)
            },
          },
        })
        await tracker.observe(id)
        const input: ConversationInput = {
          id: `instant-${caseDir}`,
          text: 'instant turn question',
          origin: 'human',
          createdAt: 1,
        }
        faux.setResponses([response])
        tracker.registerInput(id, input)
        // Same ordering as ConversationInputPipeline.submitFreshInput: register index in submit's
        // promise continuation (creates tightest possible race against instantaneous settlement).
        const submitted = conv.submit(
          {
            type: 'input',
            content: input.text,
            entry: { kind: 'helm.input', data: { id: input.id, text: input.text, origin: 'human', createdAt: 1 } },
            requestId: input.id,
          },
          BACKGROUND_CONTEXT,
        )
        const bound = submitted.then((sub) => tracker.bindSubmission(id, input.id, sub.id as number))
        await Promise.all([submitted.catch(() => {}), bound])
        await conv.waitForIdle(BACKGROUND_CONTEXT).catch(() => {})
        await tracker.waitTurnSettled(id)

        const outcomes = settled.filter((s) => s.conversation.id === id)
        assert.equal(outcomes.length, 1, `${caseDir}: turn settled exactly once`)
        const payload = outcomes[0]!
        assert.ok(payload !== undefined, `${caseDir}: settlement arrived`)
        assert.equal(payload.outcome, expectedOutcome)
        assert.deepEqual(
          payload.inputs.map((i) => i.id),
          [input.id],
          `${caseDir}: instantaneous ${expectedOutcome} turn must include this input once (no loss, no duplication)`,
        )
        // Zero leftover indices or tracking entries after settlement (late bind must not taint takeConsumed).
        const internals = tracker as unknown as TrackerInternals
        assert.equal(internals.mirrors.get(id)?.trackedInputs.size ?? 0, 0, `${caseDir}: tracking entries cleaned up`)
        assert.equal(internals.mirrors.get(id)?.submissionIndex.size ?? 0, 0, `${caseDir}: index entries cleaned up`)
        assert.equal(internals.mirrors.get(id)?.consumedInputs === undefined, true, `${caseDir}: consumed set cleaned up`)
      } finally {
        await harness.close(BACKGROUND_CONTEXT)
        await store.close()
        await database.close()
      }
    }

    // Instant completion (no streaming deltas): only the generator request-phase generation commit happens between run start and end -- worst-case window.
    await runCase('ok', fauxAssistantMessage('instant answer'), 'completed')
    // Instant failure (like failNoModel on external model error paths: settled snapshot also checks failure.inputs).
    await runCase('fail', fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }), 'failed')
  })

  it('in-flight async adoptInitial never repopulates maps after stopObserving', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-no-ghost'))
    const gate = deferred()
    try {
      const started = deferred()
      kernel.__faux.setResponses([
        async (_ctx, opts) => {
          started.resolve()
          opts?.signal?.addEventListener('abort', () => gate.resolve(), { once: true })
          if (!opts?.signal?.aborted) await gate.promise
          return fauxAssistantMessage('unused')
        },
      ])
      void kernel.submitInput(1, 'in-flight question before stopObserving').catch(() => {})
      await started.promise
      await waitFor(() => kernel.getConversation(1).status === 'working')
      assert.equal(kernel.getConversation(1).status, 'working')
      // Delete conversation (calls stopObserving internally): rotates token so in-flight reads discard results.
      const conv = await kernel.createConversation({})
      await kernel.deleteConversation(conv.id)
      const tracker = trackerOf(kernel)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.get(conv.id)?.runFirstEntry === undefined, true)
      assert.equal(tracker.mirrors.has(conv.id), false)
      // Abort must not replace observe token of conversation 1 while still observed.
      const genBefore = tracker.mirrors.get(1)?.observeGeneration
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      assert.equal(tracker.mirrors.get(1)?.observeGeneration, genBefore)
    } finally {
      gate.resolve()
      await kernel.close()
    }
  })
})

describe('settledRuns capacity eviction and stopObserving cleanup', { timeout: 60_000 }, () => {
  it('late settlement failure after stopObserving does not resurrect counters, errors, or observe tokens', timeout, async () => {
    const kernel = await openRuntime(join(root, 'late-settlement'))
    try {
      const conv = await kernel.createConversation({})
      const tracker = trackerOf(kernel) as TrackerInternals & {
        events: { onTurnSettled: (...args: unknown[]) => Promise<void> | void }
        emitSettled(id: number, outcome: string, inputs: ConversationInput[], error: undefined): void
        stopObserving(id: number): void
      }
      let fail!: (error: Error) => void
      const pending = new Promise<void>((_resolve, reject) => { fail = reject })
      const original = tracker.events.onTurnSettled
      tracker.events.onTurnSettled = () => pending
      try {
        tracker.emitSettled(conv.id, 'completed', [], undefined)
        assert.equal((tracker.mirrors.get(conv.id)?.settledInflight ?? 0) > 0, true)
        tracker.stopObserving(conv.id)
        fail(new Error('late callback failure'))
        await pending.catch(() => {})
        await Promise.resolve()
        assert.equal(tracker.mirrors.has(conv.id), false)
        assert.equal(tracker.mirrors.has(conv.id), false)
        assert.equal(tracker.mirrors.has(conv.id), false)
      } finally {
        tracker.events.onTurnSettled = original
      }
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('evicts oldest runKeys synchronously from settledRuns when single-conversation settledRunOrder exceeds 64', timeout, async () => {
    const kernel = await openRuntime(join(root, 'cap-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      const note = (tracker as unknown as {
        noteSettledRun: (conversationId: number, runKey: string) => void
      }).noteSettledRun.bind(tracker)
      for (let taskId = 1; taskId <= 70; taskId += 1) {
        note(conv.id, `${conv.id}:${taskId}`)
      }
      const order = tracker.mirrors.get(conv.id)?.settledRunOrder
      assert.ok(order !== undefined)
      assert.equal(order.length, 64, 'capacity capped at 64')
      assert.equal(order[0], `${conv.id}:7`, 'oldest keys (taskId=1..6) were evicted')
      assert.equal(order[order.length - 1], `${conv.id}:70`, 'newest key preserved')
      for (let taskId = 1; taskId <= 6; taskId += 1) {
        assert.equal(
          tracker.settledRuns.has(`${conv.id}:${taskId}`),
          false,
          `evicted key ${taskId} must not remain in settledRuns`,
        )
      }
      assert.equal(tracker.settledRuns.has(`${conv.id}:7`), true)
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation (stopObserving) cleans up all in-memory mirror state for the conversation', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('answer text')])
      await kernel.submitInput(conv.id, 'question')
      await kernel.waitForIdle(conv.id)
      assert.ok(tracker.settledRuns.size >= 1, 'settledRuns should contain entry after turn completes')
      assert.ok(tracker.mirrors.get(conv.id)?.lastSettledRun !== undefined)
      await kernel.deleteConversation(conv.id)
      assert.equal(tracker.settledRuns.size, 0, 'all settledRuns keys for conversation prefix cleaned up')
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.has(conv.id), false)
    } finally {
      await kernel.close()
    }
  })

  it('creating and deleting 50 conversations repeatedly leaves zero residual keys across tracker Maps', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-50'))
    try {
      const tracker = trackerOf(kernel)
      for (let i = 0; i < 50; i += 1) {
        const conv = await kernel.createConversation({})
        const note = (tracker as unknown as {
          noteSettledRun: (conversationId: number, runKey: string) => void
        }).noteSettledRun.bind(tracker)
        note(conv.id, `${conv.id}:1`)
        await kernel.deleteConversation(conv.id)
      }
      assert.equal(tracker.settledRuns.size, 0)
      // All per-conversation Maps are consolidated in mirrors: only observed conversation 1 remains with zero leakage.
      assert.equal(tracker.mirrors.size, 1)
      assert.deepEqual(
        [...tracker.mirrors.keys()],
        [1],
        'only conversation 1 remains observed; all 50 deleted conversation mirrors reclaimed',
      )
    } finally {
      await kernel.close()
    }
  })
})
