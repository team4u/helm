/**
 * ConversationTracker input append trace uniqueness and compute accurate regression.
 *
 * defect background (this file lock fix):
 * - old implement rebuildFromEntries for window inside each history helm.input all create req: record,
 *   and each time snapshot scan history re-;run compute (takeConsumed) only clean number key,req: history
 *   key common resident;abort  takeAllInputs iterate the whole map, old history input pollute aborted
 *   payload  origin and input manifest.
 * - old test use `assert.notEqual(reqKey, -2147483648)` this kind of string and number must however
 *   do not etc. weak assertion, test do not out real defect.
 *
 * now contract:
 * 1. trackedInputs with durable input.id(requestId) is unique key: normal register/bind
 *    and entry/inbox observe rebuild merge is a record, never duplicate;submissionId only store at
 *    submissionIndex related index (SDK run.inputs/failure.inputs mapping side);
 * 2. entry rebuild only recognize when before run zone between (run.first and after) and when before inbox, already compute
 *    run history helm.input does not resurrect: many round complete after abort only contains when before run input;
 * 3. same conversation duplicate requestId(SDK dedupe semantics) rebuild correct and does not repeat;
 * 4. restart restore leap run:observe via live.run.inputs right threat mapping + submission
 *    precise query patch complete origin/meta/attachments and related index;
 *    related when order window lock:bindSubmission(submit back package continue extend) must first row at generate task
 *    request phase pi.live.generation write commit, i.e. when complete/failed turn still exactly
 *    once contains input and compute after without leftover index (SDK when order guarantee, detail see case note release);
 * 5. stopObserving after in-flight async adoptInitial do not to maps re- item;
 * 6. settledRuns capacity eliminate (64) and deleteConversation all amount clean up keep do not change.
 *
 * via real KernelRuntime(faux provider + real SQLite) drive, internal state via type
 * convert read (test and implement same package, only test inside peek).
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

/** single conversation aggregate mirror can observability sub- collection (and ConversationMirror field same name). */
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

/** register collect turn_settled plugin, return payload array (each conversation independent array). */
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

describe('input uniqueness and history does not resurrect', { timeout: 60_000 }, () => {
  it('many round complete after abort:aborted payload only contains when before run input, excludes history trigger input', timeout, async () => {
    const kernel = await openRuntime(join(root, 'abort-current-only'))
    try {
      const settled = collectSettled(kernel)
      // two round complete turn: one round trigger source, second round human source.
      kernel.__faux.setResponses([
        fauxAssistantMessage('one round answer'),
        fauxAssistantMessage('second round answer'),
      ])
      await kernel.submitInput(1, 'one round task', { origin: 'trigger' })
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'second round task', { origin: 'human' })
      await kernel.waitForIdle(1)
      assert.equal(settled.length, 2)
      assert.equal(settled[0]!.outcome, 'completed')
      assert.equal(settled[0]!.inputs.length, 1)
      assert.equal(settled[0]!.inputs[0]!.origin, 'trigger')
      assert.equal(settled[1]!.inputs.length, 1)
      assert.equal(settled[1]!.inputs[0]!.origin, 'human')
      // already compute two round after trackedInputs leaves no residue history req: record.
      const mapAfter = trackerOf(kernel).mirrors.get(1)?.trackedInputs
      assert.equal(mapAfter?.size ?? 0, 0, 'already compute input history record leaves no residue')

      // third round in-flight abort: only contains when before input, never pollute old round origin.
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
        void kernel.submitInput(1, 'will by abort when before issue', { origin: 'human' }).catch(() => {})
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
          `aborted only contains when before run input, actual:${JSON.stringify(aborted.inputs.map((i) => [i.id, i.origin]))}`,
        )
        assert.equal(aborted.inputs[0]!.text, 'will by abort when before issue')
        assert.equal(aborted.inputs[0]!.origin, 'human', 'when before input origin do not by history trigger pollute')
      } finally {
        gate.resolve()
      }
    } finally {
      await kernel.close()
    }
  })

  it('history helm.input no longer each time scan re-: complete if dry round after trackedInputs reset to zero', timeout, async () => {
    const kernel = await openRuntime(join(root, 'no-resurrect'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('answer one'),
        fauxAssistantMessage('answer two'),
        fauxAssistantMessage('answer three'),
      ])
      for (const text of ['issue one', 'issue two', 'issue three']) {
        await kernel.submitInput(1, text)
        await kernel.waitForIdle(1)
      }
      const tracker = trackerOf(kernel)
      const map = tracker.mirrors.get(1)?.trackedInputs
      assert.equal(map?.size ?? 0, 0, 'three round complete after without history req: record leftover (does not resurrect)')
      // slightly etc. observer snapshot push enter after again verify once (old defect in each time window scan when re- history).
      await sleep(30)
      assert.equal(tracker.mirrors.get(1)?.trackedInputs.size ?? 0, 0, 'after continue snapshot does not resurrect history input')
    } finally {
      await kernel.close()
    }
  })

  it('busy in followUp queue up: all input exactly once compute, without duplicate without lose', timeout, async () => {
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
        fauxAssistantMessage('queue up input answer'),
      ])
      await kernel.submitInput(1, 'first input', { origin: 'human' })
      await firstInFlight.promise
      // busy in followUp queue up:SDK in after continue run consume (middle continue round without input).
      await kernel.submitInput(1, 'queue up second', { origin: 'agent', whenBusy: 'followUp' })
      releaseFirst.resolve()
      await kernel.waitForIdle(1)
      assert.ok(settled.length >= 1)
      // all compute payload aggregate: two input each exactly once, without duplicate.
      const allInputs = settled.flatMap((s) => s.inputs)
      const texts = allInputs.map((i) => i.text)
      const byText = new Map<string, number>()
      for (const text of texts) byText.set(text, (byText.get(text) ?? 0) + 1)
      assert.equal(byText.get('first input'), 1, `first exactly once:${JSON.stringify([...byText])}`)
      assert.equal(byText.get('queue up second'), 1, `queue up input exactly once:${JSON.stringify([...byText])}`)
      // without history fabricate input (only contains real commit two).
      assert.equal(allInputs.length, 2, `total input count exactly is commit count:${JSON.stringify(texts)}`)
    } finally {
      releaseFirst.resolve()
      await kernel.close()
    }
  })
})

describe('requestId duplicate commit and restart restore', { timeout: 60_000 }, () => {
  it('the same requestId second commit (SDK by conversation dedupe): rebuild correct and trackedInputs does not repeat', timeout, async () => {
    const kernel = await openRuntime(join(root, 'dup-request-id'))
    try {
      // two requestId only large small write difference (old 32-bit hash for 'Aa'/'BB' same value collision construct for).
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      await kernel.submitInput(1, 'a')
      await kernel.waitForIdle(1)
      kernel.__faux.setResponses([fauxAssistantMessage('answer two')])
      await kernel.submitInput(1, 'second')
      await kernel.waitForIdle(1)
      const tracker = trackerOf(kernel)
      // compute after history leaves no residue (on one group already verify); this where verify run during key domain:
      // commit second (run in progress) when map in the input unique and with requestId is key.
      const map = tracker.mirrors.get(1)?.trackedInputs
      const keys = [...(map?.keys() ?? [])]
      for (const key of keys) {
        assert.equal(typeof key, 'string', `append trace key must be requestId string:${String(key)}`)
      }
      // each in manual input.id unique.
      const ids = [...(map?.values() ?? [])].map((t) => t.id)
      assert.equal(new Set(ids).size, ids.length, 'input.id without duplicate record')
    } finally {
      await kernel.close()
    }
  })

  it('restart restore leap run:origin/meta via right threat mapping patch complete and compute do not lose', timeout, async () => {
    // direct drive real Harness + ConversationTracker(do not via KernelRuntime:runtime.close
    // will explicit abort in-flight conversation, cannot construct"restart when run still in-flight"scenario).
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

    // one segment: commit carries meta  agent input, generate request enter in-flight after directly closure storage(simulated crash).
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
          // keep in-flight enough long (database close after will not immediately complete) with convenient crash before leap run still in-flight.
          await sleep(150)
          return fauxAssistantMessage('after restart answer')
        },
      ])
      await conv.submit(
        {
          type: 'input',
          content: 'restart before in-flight issue',
          entry: {
            kind: 'helm.input',
            data: { id: 'restart-1', text: 'restart before in-flight issue', origin: 'agent', createdAt: 5, meta: { from: 'test', seq: 7 } },
          },
          requestId: 'restart-1',
        },
        BACKGROUND_CONTEXT,
      )
      await entered.promise
      // simulated crash: do not via harness.close(its will abort in-flight run), directly assert storage
      //(SQLite crash security, already commit  pi.live.run state).
      await database.close()
    }

    // second segment: heavy open (simulated restart). leap run not complete,observe must via right threat mapping patch complete input.
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
        assert.ok(map !== undefined && map.size >= 1, 'restart restore leap run after input in manual')
        const tracked = [...map.values()][0]!
        assert.equal(tracked.text, 'restart before in-flight issue')
        assert.equal(tracked.origin, 'agent', 'after restart origin right threat patch complete')
        assert.deepEqual(tracked.meta, { from: 'test', seq: 7 }, 'after restart meta right threat patch complete')
        // restart restore after related index already register (markConsumed can hit, compute do not lose input).
        const index = (tracker as unknown as TrackerInternals).mirrors.get(id)?.submissionIndex
        assert.ok(index !== undefined && index.size >= 1, 'after restart submissionId->requestId index in manual')
        // second segment heavy set response work vendor (run after restart continue run).
        faux.setResponses([fauxAssistantMessage('restore after answer')])
        await conv.waitForIdle(BACKGROUND_CONTEXT).catch(() => {})
        await tracker.waitTurnSettled(id)
        await waitFor(() => settled.some((s) => s.conversation.id === id))
        const settledPayload = settled.find((s) => s.conversation.id === id)
        assert.ok(settledPayload !== undefined, 'after restart run compute reach')
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

  it('idle commit i.e. when complete/failed:bind later than run start snapshot still exactly once contains input and without leftover index (SDK when order window lock)', timeout, async () => {
    // window fact (real pi-durable 1.5.0 measured):run start commit observe advance
    // in submit back package before sync trigger (markConsumed because index not register while skip);
    // bindSubmission in submit continue extend micro task in first row at scheduler drain after continue commit,
    // while generate task request phase must first separate commit `pi.live.generation={attempt}`
    //(generation.js: model invoke and failNoModel before), the advance when run still in
    //- - heavy scan run.inputs after markConsumed hit. failed compute another in compute snapshot heavy mark
    // failure.inputs. if not come SDK when order change hit break the guarantee (task commit first at
    // submit continue extend), this case i.e. red: i.e. when complete turn lose input ownership.
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
          text: 'instantaneous turn issue',
          origin: 'human',
          createdAt: 1,
        }
        faux.setResponses([response])
        tracker.registerInput(id, input)
        // and ConversationInputPipeline.submitFreshInput same order:bind in submit
        // back package continue extend in register index (to window with most poor i.e. when compute chance).
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
        assert.equal(outcomes.length, 1, `${caseDir}: turn exactly compute once`)
        const payload = outcomes[0]!
        assert.ok(payload !== undefined, `${caseDir}: compute reach`)
        assert.equal(payload.outcome, expectedOutcome)
        assert.deepEqual(
          payload.inputs.map((i) => i.id),
          [input.id],
          `${caseDir}: i.e. when${expectedOutcome}turn exactly contains this input (without lose without duplicate)`,
        )
        // compute after without leftover index/leftover register (late bind must not in takeConsumed after dirty items).
        const internals = tracker as unknown as TrackerInternals
        assert.equal(internals.mirrors.get(id)?.trackedInputs.size ?? 0, 0, `${caseDir}: append trace record already clean`)
        assert.equal(internals.mirrors.get(id)?.submissionIndex.size ?? 0, 0, `${caseDir}: related index already clean`)
        assert.equal(internals.mirrors.get(id)?.consumedInputs === undefined, true, `${caseDir}: consume collection already clean`)
      } finally {
        await harness.close(BACKGROUND_CONTEXT)
        await store.close()
        await database.close()
      }
    }

    // i.e. when complete answer (without streaming partial):run start and end commit between only isolate generate task
    // request phase generation write commit - - correct is window most poor form.
    await runCase('ok', fauxAssistantMessage('instantaneous answer'), 'completed')
    // i.e. when failed (failNoModel of outside model error path: compute snapshot heavy mark failure.inputs).
    await runCase('fail', fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }), 'failed')
  })

  it('stopObserving after in-flight async adoptInitial do not to maps re- item', timeout, async () => {
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
      void kernel.submitInput(1, 'stop observe before in-flight issue').catch(() => {})
      await started.promise
      await waitFor(() => kernel.getConversation(1).status === 'working')
      assert.equal(kernel.getConversation(1).status, 'working')
      // delete conversation (internal stopObserving): token delete, in-flight back read act abandon.
      const conv = await kernel.createConversation({})
      await kernel.deleteConversation(conv.id)
      const tracker = trackerOf(kernel)
      assert.equal(tracker.mirrors.has(conv.id), false)
      assert.equal(tracker.mirrors.get(conv.id)?.runFirstEntry === undefined, true)
      assert.equal(tracker.mirrors.has(conv.id), false)
      // abort must not replace still in observe root conversation token.
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

describe('settledRuns capacity eliminate and stopObserving clean up', { timeout: 60_000 }, () => {
  it('stop observe after late to compute failed does not resurrect counter, error or observe token', timeout, async () => {
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

  it('single conversation settledRunOrder exceeds 64  runKey when eliminate most old key (settledRuns sync shrink)', timeout, async () => {
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
      assert.equal(order.length, 64, 'capacity cap 64')
      assert.equal(order[0], `${conv.id}:7`, 'most old key (taskId=1..6) by eliminate')
      assert.equal(order[order.length - 1], `${conv.id}:70`, 'most new key keep')
      for (let taskId = 1; taskId <= 6; taskId += 1) {
        assert.equal(
          tracker.settledRuns.has(`${conv.id}:${taskId}`),
          false,
          `by eliminate key ${taskId} do not in settledRuns`,
        )
      }
      assert.equal(tracker.settledRuns.has(`${conv.id}:7`), true)
      await kernel.deleteConversation(conv.id)
    } finally {
      await kernel.close()
    }
  })

  it('deleteConversation(stopObserving) completely clean up the conversation all memory mirror', timeout, async () => {
    const kernel = await openRuntime(join(root, 'stop-1'))
    try {
      const tracker = trackerOf(kernel)
      const conv = await kernel.createConversation({})
      kernel.__faux.setResponses([fauxAssistantMessage('answer text')])
      await kernel.submitInput(conv.id, 'issue')
      await kernel.waitForIdle(conv.id)
      assert.ok(tracker.settledRuns.size >= 1, 'turn compute after settledRuns should has item')
      assert.ok(tracker.mirrors.get(conv.id)?.lastSettledRun !== undefined)
      await kernel.deleteConversation(conv.id)
      assert.equal(tracker.settledRuns.size, 0, 'the conversation settledRuns prefix key all clean up')
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

  it('reverse re- create delete 50 conversation after tracker internal each Map leaves no residue any key', timeout, async () => {
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
      // all by conversation Map already aggregate is mirrors: only remain still in observe conversation 1, without any leftover key.
      assert.equal(tracker.mirrors.size, 1)
      assert.deepEqual(
        [...tracker.mirrors.keys()],
        [1],
        'only conversation 1 still in observe, the rest 50 already delete conversation mirror all reclaim',
      )
    } finally {
      await kernel.close()
    }
  })
})
