/**
 * Runtime activity snapshot semantics (`activitySnapshot` / `onActivityBusyEntered`): the kernel's
 * aggregate busy predicate that backs the Hub's activity heartbeat (the launcher update
 * busy-gate). Locked-down semantics:
 *
 * - idle runtime reports all-zero counts;
 * - an active run counts the conversation once (`activeConversations`), and the idle→busy
 *   transition fires the registered listener synchronously exactly once (not per token);
 * - an approval-blocked run (pendingAsk > 0 while the run is still in flight) stays counted —
 *   blocked-with-live-run is protected work;
 * - a pending approval whose run already ended is durable AskDoc state, not live work — excluded;
 * - queued (followUp) input counts its conversation even before a run admits it;
 * - in-flight turn settlement counts (`settlingConversations`) — observed synchronously inside
 *   the `turn.settled` event frame, which is dispatched within the settle window.
 *
 * Driven by a real KernelRuntime (faux provider + real SQLite + real observer pipeline).
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { HelmEventFrame } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

let root = ''

before(async () => {
  root = await makeTempDir('helm-activity-snap-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(name: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: join(root, name),
    cwd: join(root, name),
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

const zeroCounts = () => ({
  activeConversations: 0,
  activeCompactions: 0,
  queuedConversations: 0,
  settlingConversations: 0,
})

describe('activity snapshot', { timeout: 60_000 }, () => {
  it('reports zero counts on an idle runtime', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('idle')
    try {
      await kernel.start()
      assert.deepEqual(kernel.activitySnapshot(), zeroCounts())
    } finally {
      await kernel.close()
    }
  })

  it('counts an active run once and fires the busy listener exactly once per transition', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-active')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    kernel.__faux.setResponses([
      async () => {
        await responseGate
        return fauxAssistantMessage('answer one')
      },
    ])
    let transitions = 0
    const unsubscribe = kernel.onActivityBusyEntered(() => {
      transitions += 1
    })
    try {
      const submitted = kernel.submitInput(1, 'single turn')
      await waitFor(() => kernel.activitySnapshot().activeConversations === 1, 5_000)
      assert.equal(transitions, 1, 'busy entered fires exactly once for the run start')
      // Still exactly one conversation while the turn is in flight (no double counting).
      assert.equal(kernel.activitySnapshot().activeConversations, 1)
      releaseResponse()
      await submitted.catch(() => {})
      await kernel.waitForIdle(1).catch(() => {})
      await waitFor(() => kernel.activitySnapshot().activeConversations === 0, 5_000)
      assert.equal(transitions, 1, 'no further busy entries during the same turn')
    } finally {
      releaseResponse()
      unsubscribe()
      await kernel.close()
    }
  })

  it('settling counts while turn_settled dispatch is in flight (observed inside the event frame)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('settling')
    let settlingObserved: number | undefined
    const unsubscribeEvents = kernel.events.subscribe((frame: HelmEventFrame) => {
      if (frame.event.type !== 'turn.settled') return
      // The frame is dispatched inside the settle window: the snapshot must still see it.
      settlingObserved = kernel.activitySnapshot().settlingConversations
    })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage([{ type: 'text', text: 'done' }], { stopReason: 'stop' })])
      await kernel.submitInput(1, 'complete me')
      await kernel.waitForIdle(1).catch(() => {})
      await waitFor(() => settlingObserved !== undefined, 5_000)
      assert.ok(settlingObserved! >= 1, 'turn.settled dispatch must overlap the settling window')
      assert.equal(kernel.activitySnapshot().settlingConversations, 0, 'settling drains after dispatch')
    } finally {
      unsubscribeEvents()
      await kernel.close()
    }
  })

  it('a blocked run (pendingAsk with the run still in flight) stays counted; an orphaned ask does not', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('blocked')
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 2' })], { stopReason: 'toolUse' }),
      ])
      void kernel.submitInput(1, 'prompt triggering approval').catch(() => {})
      await waitFor(() => kernel.getConversation(1).status === 'working', 5_000)
      assert.equal(kernel.activitySnapshot().activeConversations, 1)

      // Pending ask while the tool is in flight: blocked-with-live-run keeps the conversation busy.
      const askPromise = kernel.createAsk({
        conversationId: 1,
        title: 'test approval',
        fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
      })
      void askPromise.catch(() => {})
      await waitFor(() => kernel.getConversation(1).status === 'blocked', 5_000)
      assert.equal(kernel.activitySnapshot().activeConversations, 1, 'blocked-with-live-run is protected work')

      // Abort the run but leave the ask pending: the run is gone, only durable AskDoc state
      // remains — excluded from the busy predicate (survives restart by design).
      await kernel.abortConversation(1).catch(() => {})
      await kernel.waitForIdle(1).catch(() => {})
      await waitFor(() => kernel.activitySnapshot().activeConversations === 0, 5_000)
      assert.ok(kernel.getConversation(1).pendingAskCount > 0, 'the ask itself must still be pending')
      const pending = kernel.listAsks('pending')
      if (pending.length > 0) await kernel.answerAsk(pending[0]!.id, { confirm: 'true' }).catch(() => {})
    } finally {
      await kernel.close()
    }
  })

  it('queued followUp input counts its conversation before the run admits it', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('queued')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    kernel.__faux.setResponses([
      async () => {
        await responseGate
        return fauxAssistantMessage('first answer')
      },
    ])
    try {
      void kernel.submitInput(1, 'first turn').catch(() => {})
      await waitFor(() => kernel.activitySnapshot().activeConversations === 1, 5_000)
      void kernel.submitInput(1, 'queued follow up', { whenBusy: 'followUp' }).catch(() => {})
      await waitFor(() => kernel.activitySnapshot().queuedConversations === 1, 5_000)
      // Releasing the gate lets the first turn complete; the queued follow-up is admitted into the
      // next run and drains — the aggregate returns to all zeros on its own (no abort needed).
      kernel.__faux.appendResponses([fauxAssistantMessage('second answer')])
      releaseResponse()
      await waitFor(
        () => {
          const snapshot = kernel.activitySnapshot()
          return snapshot.activeConversations === 0 && snapshot.queuedConversations === 0 && snapshot.settlingConversations === 0
        },
        15_000,
      )
    } finally {
      releaseResponse()
      await kernel.close()
    }
  })
})
