/**
 * End-to-end tests for `queuedInputs` (steer / followUp pending-input pills).
 *
 * Covers:
 * 1. Pure function layer: `deriveConversationLive` derives `queuedInputs` from `pi.inbox` queued items
 *    (steer sorted first, invalid entries skipped, `origin`/`createdAt`/`attachments` edge cases).
 * 2. Real SDK layer: submitting steer and followUp while conversation runs causes `conversation.live`
 *    events to carry `queuedInputs` (steer before followUp), and removes them once consumed.
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

/** Returns the live state view for the target conversation from snapshot (`queuedInputs` truth source). */
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
// 1. Pure function: deriveConversationLive queuedInputs projection
// ---------------------------------------------------------------------------

describe('deriveConversationLive queuedInputs', { timeout: 60_000 }, () => {
  it('places steer ahead of followUp while preserving within-mode order and field mappings', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 11, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'fu-1', text: 'queued follow-up', origin: 'human', createdAt: 200 } } },
      { id: 12, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'st-1', text: 'steer instruction', origin: 'agent', createdAt: 100 } } },
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

  it('skips invalid items: write mode, non-helm.input, or missing id/text produce no queuedInput', { timeout: 60_000 }, () => {
    const inbox: InboxItemLike[] = [
      { id: 1, mode: 'write', entry: { kind: 'helm.note', data: { id: 'w', text: 'write' } } },
      { id: 2, mode: 'steer', entry: { kind: 'pi.user', data: { id: 'x', text: 'non-helm.input' } } },
      { id: 3, mode: 'followUp', entry: { kind: 'helm.input', data: { text: 'missing id' } } },
      { id: 4, mode: 'followUp', entry: { kind: 'helm.input', data: { id: 'no-text' } } },
      { id: 5, mode: 'steer', entry: { kind: 'helm.input', data: { id: 'ok-1', text: 'valid item' } } },
    ]
    const live = deriveConversationLive(1, undefined, 50, inbox)
    assert.deepEqual(live.queuedInputs?.map((q) => q.id), ['ok-1'])
    // Invalid origin falls back to human; invalid createdAt falls back to updatedAt.
    const q = live.queuedInputs![0]!
    assert.equal(q.origin, 'human')
    assert.equal(q.createdAt, 50)
  })

  it('keeps non-empty attachments, omits empty attachments, and omits queuedInputs when empty', { timeout: 60_000 }, () => {
    const withAttachments = deriveConversationLive(1, undefined, 10, [
      {
        id: 9,
        mode: 'steer',
        entry: {
          kind: 'helm.input',
          data: {
            id: 'q-1',
            text: 'with attachment',
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
// 2. Real SDK: queuing and consuming steer / followUp during a live run
// ---------------------------------------------------------------------------

describe('ConversationTracker queuedInputs real-time events', { timeout: 60_000 }, () => {
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
        // Stop observers first (canceling live stream timers) before closing SDK and database to avoid timer leaks.
        for (const id of [...trackedIds]) tracker.stopObserving(id)
        await harness.close(BACKGROUND_CONTEXT)
        const err = await store.close()
        await database.close()
        if (err !== undefined) throw new HelmError('store_flush_failed', String(err), 500)
      },
    }
  }
  const trackedIds = new Set<number>()

  it('queued steer and followUp while running appear in live (steer first) and disappear once consumed', { timeout: 60_000 }, async () => {
    const { tracker, harness, store, lives, faux, close } = await openTracker()
    try {
      const conv = await harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
        BACKGROUND_CONTEXT,
      )
      const id = conv.id as number
      trackedIds.add(id)
      // Tracker relies on store meta for summaries (emitRunSummary/summaryOf):
      // upsert conversation metadata before observe so getConv does not miss and skip summaries.
      store.upsertConv(convMeta(id))
      await tracker.observe(id)

      // Turn 1 runs while queued inputs are submitted (ensures the run stays active during submissions).
      faux.setResponses([fauxAssistantMessage('first turn answer')])
      await conv.submit(
        {
          type: 'input',
          content: 'first turn question',
          entry: { kind: 'helm.input', data: { id: 'base-1', text: 'first turn question', origin: 'human', createdAt: 1 } },
          requestId: 'base-1',
        },
        BACKGROUND_CONTEXT,
      )

      // Wait for run start (initial live frame arrives; observe notification arrives async via microtask/timer).
      await waitFor(() => lives.length >= 1 || tracker.hasLiveWork(id), 5_000)

      // Submit followUp first and steer second while active (steer still sorts ahead).
      await conv.submit(
        {
          type: 'input',
          content: 'queued follow-up input',
          whenBusy: 'followUp',
          entry: { kind: 'helm.input', data: { id: 'q-fu', text: 'queued follow-up input', origin: 'human', createdAt: 2 } },
          requestId: 'q-fu',
        },
        BACKGROUND_CONTEXT,
      )
      await conv.submit(
        {
          type: 'input',
          content: 'steer supplement input',
          whenBusy: 'steer',
          entry: { kind: 'helm.input', data: { id: 'q-st', text: 'steer supplement input', origin: 'human', createdAt: 3 } },
          requestId: 'q-st',
        },
        BACKGROUND_CONTEXT,
      )

      // queuedInputs arrive with steer first and followUp second (covers 0ms inbox coalesced refresh).
      await waitFor(() => lives.some((l) => (l.queuedInputs?.length ?? 0) >= 2), 5_000)
      const queuedFrame = lives.findLast((l) => (l.queuedInputs?.length ?? 0) >= 2)!
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.id), ['q-st', 'q-fu'])
      assert.deepEqual(queuedFrame.queuedInputs!.map((q) => q.mode), ['steer', 'followUp'])

      // After turn 1 finishes and followUp drains: new run writes helm.input entry and removes both items from queuedInputs.
      faux.appendResponses([fauxAssistantMessage('second turn answer')])
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      await waitFor(
        () => {
          const tail = lives[lives.length - 1]
          return tail === undefined || (tail.queuedInputs ?? []).every((q) => q.id !== 'q-st' && q.id !== 'q-fu')
        },
        5_000,
      )
      const tail = lives[lives.length - 1]!
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-st'), false, 'steer must be removed from queuedInputs once consumed')
      assert.equal((tail.queuedInputs ?? []).some((q) => q.id === 'q-fu'), false, 'followUp must be removed from queuedInputs once consumed')
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Real KernelRuntime: SSE snapshot recovery of queuedInputs (faux Promise gate)
// ---------------------------------------------------------------------------

describe('KernelRuntime snapshot conversationLives', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-queued-snap-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  it('queues followUp/steer mid-run so reconnect snapshots preserve queuedInputs without waiting for tokens', { timeout: 60_000 }, async () => {
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
      const submit1 = kernel.submitInput(conv.id, 'first turn question')
      await started
      // Run is in-flight (model request paused on gate): enqueue both steer and followUp.
      await Promise.all([
        kernel.submitInput(conv.id, 'queued follow-up input', { whenBusy: 'followUp' }),
        kernel.submitInput(conv.id, 'steer supplement input', { whenBusy: 'steer' }),
      ])
      // Once persisted, snapshot immediately exposes queued facts so reconnecting clients restore pills without waiting for new tokens.
      await waitFor(() => {
        const snap = kernel.events.currentSnapshot()
        const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const snap = kernel.events.currentSnapshot()
      const live = (snap.conversationLives ?? []).find((l) => l.conversationId === conv.id)
      assert.ok(live, 'snapshot must include live view for the conversation')
      // requestId is randomly generated by kernel, so assert queued inputs by text + mode.
      const queued = live!.queuedInputs!
      assert.equal(queued.length, 2)
      const byText = new Map(queued.map((q) => [q.text, q]))
      assert.equal(byText.get('steer supplement input')?.mode, 'steer')
      assert.equal(byText.get('queued follow-up input')?.mode, 'followUp')
      for (const q of queued) {
        assert.equal(typeof q.id === 'string' && q.id !== '', true, 'queued id must be non-empty')
        assert.equal(typeof q.submissionId === 'string' && q.submissionId !== '', true, 'queued submissionId must be non-empty')
        assert.equal(q.origin, 'human')
      }
      // Release gate: run completes, followUp drains, and queued list empties.
      answer(fauxAssistantMessage('first turn answer'))
      await submit1
      faux.appendResponses([fauxAssistantMessage('second turn answer')])
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const tail = (kernel.events.currentSnapshot().conversationLives ?? []).find((l) => l.conversationId === conv.id)
        return tail === undefined || (tail.queuedInputs?.length ?? 0) === 0
      }, 5_000)
    } finally {
      await kernel.close()
    }
  })

  it('omitted whenBusy defaults to steer while busy; explicit followUp queues and reject returns 409 conversation_busy', { timeout: 60_000 }, async () => {
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
      const conv = await kernel.createConversation({ title: 'default steer' })
      const submit1 = kernel.submitInput(conv.id, 'first turn question')
      await started
      // Run in-flight (model paused on gate): submit without whenBusy — assert directly via pi.inbox live state (not final answer guess).
      await kernel.submitInput(conv.id, 'omitted whenBusy supplement')
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 1
      }, 5_000)
      const omitQueued = findLive(kernel, conv.id)!.queuedInputs!
      assert.equal(omitQueued.length, 1)
      assert.equal(omitQueued[0]!.mode, 'steer', 'omitted whenBusy must queue as default steer')
      assert.equal(omitQueued[0]!.text, 'omitted whenBusy supplement')
      // Explicit followUp still queues (default policy change must not disable explicit modes).
      await kernel.submitInput(conv.id, 'explicit queued follow-up', { whenBusy: 'followUp' })
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live !== undefined && (live.queuedInputs?.length ?? 0) >= 2
      }, 5_000)
      const twoQueued = findLive(kernel, conv.id)!.queuedInputs!
      const byText = new Map(twoQueued.map((q) => [q.text, q]))
      assert.equal(byText.get('omitted whenBusy supplement')?.mode, 'steer')
      assert.equal(byText.get('explicit queued follow-up')?.mode, 'followUp')
      // Explicit reject fails 409 instead of silently queuing.
      await assert.rejects(
        () => kernel.submitInput(conv.id, 'input to be rejected', { whenBusy: 'reject' }),
        (err: unknown) => {
          const helmErr = err as { name?: string; code?: string; status?: number }
          return helmErr?.name === 'HelmError' && helmErr?.code === 'conversation_busy' && helmErr?.status === 409
        },
      )
      // Release gate: run completes and queued items drain.
      answer(fauxAssistantMessage('first turn answer'))
      faux.appendResponses([fauxAssistantMessage('follow-up answer')])
      await submit1
      await kernel.waitForIdle(conv.id)
      await waitFor(() => {
        const live = findLive(kernel, conv.id)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 5_000)
      // Persisted helm.input entry carries effective whenBusy ('steer' when omitted).
      const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
      const stored = detail.entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => (e.data ?? {}) as { text?: string; whenBusy?: string })
        .find((d) => d.text === 'omitted whenBusy supplement')
      assert.equal(stored?.whenBusy, 'steer', 'persisted helm.input entry must record effective default steer')
    } finally {
      await kernel.close()
    }
  })

  it('idle conversations omit empty live states from snapshot conversationLives', { timeout: 60_000 }, async () => {
    const dir = join(root, 'snap2')
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('single turn')])
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })
    try {
      const conv = await kernel.createConversation({ title: 'idle' })
      await kernel.submitInput(conv.id, 'question')
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
