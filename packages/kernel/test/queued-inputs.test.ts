/**
 * queuedInputs(steer / followUp await takes effect pill) real link test.
 *
 * override:
 * 1. pure function layer:deriveConversationLive from pi.inbox queue up items derive queuedInputs
 *    (steer takes precedence sort, illegal items skip,origin/createdAt/attachments boundary).
 * 2. real SDK layer: conversation working during commit steer and followUp,conversation.live
 *    event carry queuedInputs(steer in before followUp in after); queue up items consume
 *    entries after from queuedInputs remove.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Harness } from '@earendil-works/pi-durable'
import { createRegistry } from '@earendil-works/pi-durable'
import type { ConversationLive } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { ConversationTracker, type TrackerEvents } from '../src/runtime/conversations.js'
import { deriveConversationLive, type InboxItemLike } from '../src/runtime/entries.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { HelmStore, type ConvMeta } from '../src/runtime/store.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

/** snapshot in designate conversation real-time view (queuedInputs fact source). */
function findLive(kernel: KernelRuntime, conversationId: number): ConversationLive | undefined {
  return (kernel.events.currentSnapshot().conversationLives ?? []).find(
    (l) => l.conversationId === conversationId,
  )
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

// ---------------------------------------------------------------------------
// 1. pure function:deriveConversationLive queuedInputs derive
// ---------------------------------------------------------------------------

describe('deriveConversationLive queuedInputs', { timeout: 60_000 }, () => {
  it('steer arrange in followUp before (same mode keep original order), field mapping complete', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 11, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'fu-1', text: 'second queue up', origin: 'human', createdAt: 200 } } },
      { id: 12, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'st-1', text: 'insert speech quote lead', origin: 'agent', createdAt: 100 } } },
      { id: 13, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'st-2', text: 'second steer', origin: 'trigger', createdAt: 150 } } },
    ]
    const live = deriveConversationLive(7, undefined, 999, inbox)
    assert.deepEqual(live.queuedInputs?.map((q) => q.id), ['st-1', 'st-2', 'fu-1'])
    const [first, second, third] = live.queuedInputs!.map((q) => q)
    assert.ok(first && second && third)
    assert.equal(first!.submissionId, '12')
    assert.equal(first!.mode, 'steer')
    assert.equal(first!.origin, 'agent')
    assert.equal(first!.createdAt, 100)
    assert.equal(second!.origin, 'trigger')
    assert.equal(third!.mode, 'followUp')
    assert.equal(third!.createdAt, 200)
  })

  it('illegal items skip:write pattern, non- helm.input, missing id/text all produces no queuedInput', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 1, mode: 'write', entry: { kind: 'helm.note', data: { id: 'w', text: 'write' } } },
      { id: 2, mode: 'steer', entry: { kind: 'pi.user', data: { id: 'x', text: 'non- helm.input' } } },
      { id: 3, mode: 'followUp', entry: { kind: 'helm.input', data: { text: 'missing id' } } },
      { id: 4, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'no-text' } } },
      { id: 5, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'ok-1', text: 'legal items' } } },
    ]
    const live = deriveConversationLive(1, undefined, 50, inbox)
    assert.deepEqual(live.queuedInputs?.map((q) => q.id), ['ok-1'])
    // origin illegal fall back human;createdAt illegal take updatedAt.
    const q = live.queuedInputs![0]!
    assert.equal(q.origin, 'human')
    assert.equal(q.createdAt, 50)
  })

  it('attachments non-empty array keep, empty array omit; without queue up items when queuedInputs omit', { timeout: 60_000 }, () => {
    const withAttachments = deriveConversationLive(1, undefined, 10, [
      {
        id: 9,
        mode: 'steer',
        entry: {
          kind: 'helm.input',
          data: {
            id: 'q-1',
            text: 'carries attachment',
            attachments: [{ id: 'art_1', name: 'a.png', mimeType: 'image/png', size: 5 }],
          },
        },
      },
    ])
    assert.equal(withAttachments.queuedInputs?.[0]?.attachments?.length, 1)
    const emptyAttachments = deriveConversationLive(1, undefined, 10, [
      { id: 9, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'q-2', text: 'empty attachment', attachments: [] } } },
    ])
    assert.equal(emptyAttachments.queuedInputs?.[0]?.attachments, undefined)
    const none = deriveConversationLive(1, undefined, 10, [])
    assert.equal(none.queuedInputs, undefined)
  })
})

// ---------------------------------------------------------------------------
// 2. real SDK:working during steer / followUp queue and consume
// ---------------------------------------------------------------------------

describe('ConversationTracker queuedInputs real-time event', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-queued-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  type FauxHandle = ReturnType<typeof makeFauxModels>['faux']
  async function openTracker(): Promise<{
    tracker: ConversationTracker
    harness: Harness
    store: HelmStore
    lives: ConversationLive[]
    faux: FauxHandle
    close: () => Promise<void>
  }> {
    const dir = join(root, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const database = await openHelmDatabase(dir)
    const store = new HelmStore(database)
    await store.load()
    const { models, faux } = makeFauxModels()
    const registry = createRegistry()
    const harness = await Harness.open(
      database.storage,
      { models: () => models, registry, settings: { followUpMode: 'all', steeringMode: 'all' } },
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
      store,
      lives,
      faux,
      close: async () => {
        // first stop observe (clean live node stream timer), again closure SDK and database, guard against timer leak leak.
        for (const id of [...trackedIds]) tracker.stopObserving(id)
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
    }
  }
  const trackedIds = new Set<number>()

  it('working during commit steer and followUp:live carry queuedInputs(steer in before), consume after remove', { timeout: 60_000 }, async () => {
    const { tracker, harness, store, lives, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      trackedIds.add(id)
      // tracker dependency store meta derive summary (emitRunSummary/summaryOf):
      // observe before first register conversation mirror, otherwise getConv miss leads to summary path skip.
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      // one round run(long text streaming, guarantee commit queue up items when run still in enter row).
      faux.setResponses([fauxAssistantMessage('one round answer')])
      await conv.submit(
        {
          type: 'input',
          content: 'one round issue',
          entry: { kind: 'helm.input', data: { id: 'base-1', text: 'one round issue', origin: 'human', createdAt: 1 } },
          requestId: 'base-1',
        },
        BACKGROUND_CONTEXT,
      )

      // etc. run start (live one frame reach; observe push in micro task/timer after async reach).
      await waitFor(() => lives.length >= 1 || tracker.hasLiveWork(id), 5_000)

      // working in commit followUp(first queue) and steer(after queue but priority high).
      await conv.submit(
        {
          type: 'input',
          content: 'queue up after continue input',
          whenBusy: 'followUp',
          entry: { kind: 'helm.input', data: { id: 'q-fu', text: 'queue up after continue input', origin: 'human', createdAt: 2 } },
          requestId: 'q-fu',
        },
        BACKGROUND_CONTEXT,
      )
      await conv.submit(
        {
          type: 'input',
          content: 'insert speech quote lead patch fill',
          whenBusy: 'steer',
          entry: { kind: 'helm.input', data: { id: 'q-st', text: 'insert speech quote lead patch fill', origin: 'human', createdAt: 3 } },
          requestId: 'q-st',
        },
        BACKGROUND_CONTEXT,
      )

      // queuedInputs reach:steer in before,followUp in after (queue 0ms conflict refresh path).
      await waitFor(() => lives.some((l) => (l.queuedInputs?.length ?? 0) >= 2), 5_000)
      const queuedFrame = lives.findLast((l) => (l.queuedInputs?.length ?? 0) >= 2)!
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.id), ['q-st', 'q-fu'])
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.mode), ['steer', 'followUp'])

      // one round after end followUp consume: new run  helm.input entry written to the database,
      // queuedInputs remove (wait for finally one frame no longer carry this two queue up items).
      faux.appendResponses([fauxAssistantMessage('second round answer')])
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(
        () => {
          const tail = lives[lives.length - 1]
          return tail === undefined || (tail.queuedInputs ?? []).every((q) => q.id !== 'q-st' && q.id !== 'q-fu')
        },
        5_000,
      )
      const tail = lives[lives.length - 1]!
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-st'), false, 'steer consume after from queuedInputs remove')
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-fu'), false, 'followUp consume after from queuedInputs remove')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. real KernelRuntime:SSE snapshot restore queuedInputs(faux Promise gate control when)
// ---------------------------------------------------------------------------

describe('KernelRuntime snapshot conversationLives', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-queued-snap-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  it('run in progress followUp/steer queue after, reconnect snapshot carry queuedInputs(no need to again commit or again token)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'snap1')
    const { models, faux } = makeFauxModels()
    let entered!: () => void
    let answer!: (message: ReturnType<typeof fauxAssistantMessage>) => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { answer = resolve })
    faux.setResponses([async () => { entered(); return held }])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })
    try {
      const conv = await kernel.createConversation({ title: 'snapshot restore' })
      const submit1 = kernel.submitInput(conv.id, 'one round issue')
      await started
      // run already in-flight (model request by gate suspended): commit steer and followUp queue.
      await Promise.all([
        kernel.submitInput(conv.id, 'queue up after continue input', { whenBusy: 'followUp' }),
        kernel.submitInput(conv.id, 'insert speech quote lead patch fill', { whenBusy: 'steer' }),
      ])
      // queue fact written to the database after take snapshot: reconnect scenario under client rely on this one frame restore pill,
      // does not need again commit input or wait for under a model token.
      await waitFor(() => {
        const snap = kernel.events.currentSnapshot()
        const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const snap = kernel.events.currentSnapshot()
      const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
      assert.ok(live, 'snapshot should contain the conversation real-time view')
      // requestId by kernel random generate (cannot pre- know), by text+mode assertion two queue up fact.
      const queued = live!.queuedInputs!
      assert.equal(queued.length, 2)
      const byText = new Map(queued.map((q) => [q.text, q]))
      assert.equal(byText.get('insert speech quote lead patch fill')?.mode, 'steer')
      assert.equal(byText.get('queue up after continue input')?.mode, 'followUp')
      for (const q of queued) {
        assert.equal(typeof q.id === 'string' && q.id !== '', true, 'queued id non-empty')
        assert.equal(typeof q.submissionId === 'string' && q.submissionId !== '', true, 'queued submissionId non-empty')
        assert.equal(q.origin, 'human')
      }
      // release gate:run complete, after continue followUp consume, queue eventually empty.
      answer(fauxAssistantMessage('one round answer'))
      await submit1
      faux.appendResponses([fauxAssistantMessage('second round answer')])
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const tail = (kernel.events.currentSnapshot().conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return tail === undefined || (tail.queuedInputs?.length ?? 0) === 0
      }, 5_000)
    } finally {
      await kernel.close()
    }
  })

  it('busy in omit whenBusy by default steer; explicit followUp still queue up;reject report 409 conversation_busy', { timeout: 60_000 }, async () => {
    const dir = join(root, 'default-steer')
    const { models, faux } = makeFauxModels()
    let entered!: () => void
    let answer!: (message: ReturnType<typeof fauxAssistantMessage>) => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { answer = resolve })
    faux.setResponses([async () => { entered(); return held }])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })
    try {
      const conv = await kernel.createConversation({ title: 'by default insert speech' })
      const submit1 = kernel.submitInput(conv.id, 'one round issue')
      await started
      // run in-flight (model request by gate suspended): omit whenBusy commit - - by valid by default steer queue,
      // directly with pi.inbox fact assertion (do not based on eventually answer guess).
      await kernel.submitInput(conv.id, 'omit whenBusy patch fill')
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 1
      }, 5_000)
      const omitQueued = findLive(kernel, conv.id)!.queuedInputs!
      assert.equal(omitQueued.length, 1)
      assert.equal(omitQueued[0]!.mode, 'steer', 'omit whenBusy should by by default steer queue')
      assert.equal(omitQueued[0]!.text, 'omit whenBusy patch fill')
      // explicit followUp still queue up (do not because by default change while expires).
      await kernel.submitInput(conv.id, 'explicit queue up after continue', { whenBusy: 'followUp' })
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const twoQueued = findLive(kernel, conv.id)!.queuedInputs!
      const byText = new Map(twoQueued.map((q) => [q.text, q]))
      assert.equal(byText.get('omit whenBusy patch fill')?.mode, 'steer')
      assert.equal(byText.get('explicit queue up after continue')?.mode, 'followUp')
      // explicit reject: correct busy when reject (not silently queue).
      await assert.rejects(
        () => kernel.submitInput(conv.id, 'should by reject input', { whenBusy: 'reject' }),
        (err: unknown) => {
          const helmErr = err as { name?: string; code?: string; status?: number }
          return helmErr?.name === 'HelmError' && helmErr?.code === 'conversation_busy' && helmErr?.status === 409
        },
      )
      // release gate:run complete, queue consume after empty.
      answer(fauxAssistantMessage('one round answer'))
      faux.appendResponses([fauxAssistantMessage('after continue answer')])
      await submit1
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 5_000)
      // helm.input entry written to the database carry valid whenBusy(omit path solid is steer).
      const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
      const stored = detail.entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => (e.data ?? {}) as { text?: string; whenBusy?: string })
        .find((d) => d.text === 'omit whenBusy patch fill')
      assert.equal(stored?.whenBusy, 'steer', 'helm.input entry should record valid by default steer')
    } finally {
      await kernel.close()
    }
  })

  it('idle conversation does not resurrect idle empty live(snapshot excludes without content item)', { timeout: 60_000 }, async () => {
    const dir = join(root, 'snap2')
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('only one round')])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })
    try {
      const conv = await kernel.createConversation({ title: 'idle' })
      await kernel.submitInput(conv.id, 'issue')
      await kernel.waitForIdle(conv.id)
      const snap = kernel.events.currentSnapshot()
      assert.equal(
        (snap.conversationLives ?? []).some((l) => l.conversationId === conv.id),
        false,
        'idle conversation must not appear in snapshot conversationLives',
      )
    } finally {
      await kernel.close()
    }
  })
})
