/**
 * RuntimeTriggerDispatcher default target resolution contracts:
 * - TOCTOU window between resolveDefaultTriggerTarget and submitInput (target deleted mid-flight):
 *   re-resolves once on not_found and delivers via full routing policy (not retrying the same gone target);
 * - expired explicit targets still throw not_found (never masked by re-routing);
 * - creates new target on demand when none exists, deduplicating concurrent creations via single-flight;
 * - busy policy: every trigger delivery (explicit / default / TOCTOU retry) submits with
 *   whenBusy=steer (followUp stays an explicit caller choice).
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HelmError, type ExternalTriggerEnvelope } from '@helm/protocol'
import { RuntimeTriggerDispatcher } from '../src/runtime/runtime-triggers.js'

interface ConvMeta {
  id: number
  profileId: string
  parentConversationId?: number
  updatedAt: number
}

interface SubmitCall {
  id: number
  origin?: string
  whenBusy?: string
}

function makeDispatcher(over: {
  listConvs(): ConvMeta[]
  getConversation(id: number): { id: number }
  createConversation(init: { title?: string; profileId?: string }): Promise<{ id: number }>
  submitInput(id: number, text: string): Promise<void>
}) {
  const calls: SubmitCall[] = []
  const dispatcher = new RuntimeTriggerDispatcher({
    store: { listConvs: over.listConvs } as never,
    hookBridge: { runHookChain: async () => undefined } as never,
    getConversation: over.getConversation as never,
    getConversationOwnership: () => 'human' as const,
    createConversation: over.createConversation as never,
    submitInput: (async (id: number, text: string, opts?: { origin?: string; whenBusy?: string }) => {
      calls.push({ id, origin: opts?.origin, whenBusy: opts?.whenBusy })
      return await over.submitInput(id, text)
    }) as never,
  })
  return { dispatcher, calls }
}

const envelope = (over: Partial<ExternalTriggerEnvelope> = {}): ExternalTriggerEnvelope => ({
  id: 'cron:j1:1',
  source: 'cron:j1',
  text: 'payload',
  createdAt: 1,
  ...over,
})

test('default target TOCTOU: target deleted between resolve and submit triggers single re-resolve and delivers to new target', { timeout: 60_000 }, async () => {
  // #5 exists during resolve (human-owned assistant, no parent); deleted before submitInput runs.
  let convs: ConvMeta[] = [{ id: 5, profileId: 'assistant', updatedAt: 1 }]
  const submitted: number[] = []
  let created = 0
  const { dispatcher, calls } = makeDispatcher({
    listConvs: () => convs,
    getConversation: (id) => {
      if (id !== 9) throw new HelmError('not_found', `conversation not found: ${id}`, 404)
      return { id: 9 }
    },
    createConversation: async () => {
      created += 1
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async (id) => {
      if (id === 5) {
        convs = [] // #5 deleted after resolve, before submit
        throw new HelmError('not_found', 'conversation not found: 5', 404)
      }
      submitted.push(id)
    },
  })
  await dispatcher.dispatchTrigger(envelope())
  assert.deepEqual(submitted, [9], 're-resolves and delivers to new target without losing trigger payload')
  assert.equal(created, 1)
  // Busy policy: both the stale-target attempt and the TOCTOU retry delivery use steer.
  assert.deepEqual(
    calls.map((c) => ({ id: c.id, origin: c.origin, whenBusy: c.whenBusy })),
    [
      { id: 5, origin: 'trigger', whenBusy: 'steer' },
      { id: 9, origin: 'trigger', whenBusy: 'steer' },
    ],
  )
})

test('default target still fails after re-resolve: rethrows not_found without unbounded retries', { timeout: 60_000 }, async () => {
  let convs: ConvMeta[] = []
  const { dispatcher } = makeDispatcher({
    listConvs: () => convs,
    getConversation: () => ({ id: 9 }),
    createConversation: async () => {
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async () => {
      convs = [] // newly created target deleted before submit in extreme race window
      throw new HelmError('not_found', 'conversation not found: 9', 404)
    },
  })
  await assert.rejects(dispatcher.dispatchTrigger(envelope()), (err: unknown) => {
    assert.ok(err instanceof HelmError && err.code === 'not_found')
    return true
  })
})

test('explicit target expired by submit time: rethrows not_found without masking via default re-routing', { timeout: 60_000 }, async () => {
  const submitted: number[] = []
  const { dispatcher, calls } = makeDispatcher({
    listConvs: () => [{ id: 5, profileId: 'assistant', updatedAt: 1 }],
    getConversation: () => ({ id: 5 }), // pre-validation (pre-hook) passes
    createConversation: async () => {
      throw new HelmError('unsupported', 'explicit target path must not create a new conversation', 501)
    },
    submitInput: async (id) => {
      submitted.push(id)
      throw new HelmError('not_found', `conversation not found: ${id}`, 404)
    },
  })
  await assert.rejects(
    dispatcher.dispatchTrigger(envelope({ targetConversationId: 5 })),
    (err: unknown) => err instanceof HelmError && err.code === 'not_found',
  )
  assert.deepEqual(submitted, [5], 'only tries the explicit target once')
  // Busy policy: explicit-target delivery also defaults to steer.
  assert.equal(calls[0]!.origin, 'trigger')
  assert.equal(calls[0]!.whenBusy, 'steer')
})

test('no existing default target: concurrent triggers coalesce into single on-demand creation (single-flight)', { timeout: 60_000 }, async () => {
  let convs: ConvMeta[] = []
  let creations = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { dispatcher, calls } = makeDispatcher({
    listConvs: () => convs,
    getConversation: (id) => ({ id }),
    createConversation: async () => {
      creations += 1
      await gate
      convs = [{ id: 11, profileId: 'assistant', updatedAt: 2 }]
      return { id: 11 }
    },
    submitInput: async () => {},
  })
  const a = dispatcher.dispatchTrigger(envelope({ id: 'a' }))
  const b = dispatcher.dispatchTrigger(envelope({ id: 'b' }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(creations, 1, 'concurrent default triggers only initiate one on-demand creation')
  release()
  await Promise.all([a, b])
  assert.equal(creations, 1)
  // Busy policy: on-demand-created default target deliveries also use steer.
  assert.deepEqual(
    calls.map((c) => ({ id: c.id, origin: c.origin, whenBusy: c.whenBusy })),
    [
      { id: 11, origin: 'trigger', whenBusy: 'steer' },
      { id: 11, origin: 'trigger', whenBusy: 'steer' },
    ],
  )
})
