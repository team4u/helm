/**
 * RuntimeTriggerDispatcher default target parse contract:
 * - resolveDefaultTriggerTarget and submitInput between TOCTOU window (target by delete):
 *   default path not_found when heavy parse once again delivery (complete routing decide policy, non- same target delivery retry);
 * - explicit target expires still explicit not_found on throw (must not by heavy routing mask);
 * - without choose when on demand creates new and merge concurrency create (defaultTriggerTargetCreation single fly);
 * - busy policy: every trigger delivery (explicit / default / TOCTOU retry) submits with
 *   whenBusy=steer (followUp stays an explicit caller choice).
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
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

test('default target TOCTOU:resolve and submit between target by delete → not_found heavy parse once after delivery new target', { timeout: 60_000 }, async () => {
  // parse when #5 store in (human-owned assistant, without parent chain);submitInput when already by delete.
  let convs: ConvMeta[] = [{ id: 5, profileId: 'assistant', updatedAt: 1 }]
  const submitted: number[] = []
  let created = 0
  const { dispatcher, calls } = makeDispatcher({
    listConvs: () => convs,
    getConversation: (id) => {
      if (id !== 9) throw new HelmError('not_found', `conversation missing:${id}`, 404)
      return { id: 9 }
    },
    createConversation: async () => {
      created += 1
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async (id) => {
      if (id === 5) {
        convs = [] // #5 in resolve after,submit before by delete
        throw new HelmError('not_found', 'conversation missing:5', 404)
      }
      submitted.push(id)
    },
  })
  await dispatcher.dispatchTrigger(envelope())
  assert.deepEqual(submitted, [9], 'heavy parse after delivery to new target (the time trigger payload without losing)')
  assert.equal(created, 1)
  // Busy policy: the stale-target attempt and the TOCTOU retry delivery both use steer.
  assert.deepEqual(
    calls.map((c) => ({ id: c.id, origin: c.origin, whenBusy: c.whenBusy })),
    [
      { id: 5, origin: 'trigger', whenBusy: 'steer' },
      { id: 9, origin: 'trigger', whenBusy: 'steer' },
    ],
  )
})

test('default target heavy parse after still failed: such as on throw not_found(do not unbounded retry)', { timeout: 60_000 }, async () => {
  let convs: ConvMeta[] = []
  const { dispatcher } = makeDispatcher({
    listConvs: () => convs,
    getConversation: () => ({ id: 9 }),
    createConversation: async () => {
      convs = [{ id: 9, profileId: 'assistant', updatedAt: 2 }]
      return { id: 9 }
    },
    submitInput: async () => {
      convs = [] // heavy parse hit new target in submit before again by delete (extreme window)
      throw new HelmError('not_found', 'conversation missing:9', 404)
    },
  })
  await assert.rejects(dispatcher.dispatchTrigger(envelope()), (err: unknown) => {
    assert.ok(err instanceof HelmError && err.code === 'not_found')
    return true
  })
})

test('explicit target in submit when expires:not_found such as on throw, do not by default heavy routing mask', { timeout: 60_000 }, async () => {
  const submitted: number[] = []
  const { dispatcher, calls } = makeDispatcher({
    listConvs: () => [{ id: 5, profileId: 'assistant', updatedAt: 1 }],
    getConversation: () => ({ id: 5 }), // pre- validate (hook before) via
    createConversation: async () => {
      throw new HelmError('unsupported', 'explicit target path must not creates new conversation', 501)
    },
    submitInput: async (id) => {
      submitted.push(id)
      throw new HelmError('not_found', `conversation missing:${id}`, 404)
    },
  })
  await assert.rejects(
    dispatcher.dispatchTrigger(envelope({ targetConversationId: 5 })),
    (err: unknown) => err instanceof HelmError && err.code === 'not_found',
  )
  assert.deepEqual(submitted, [5], 'only attempt explicit target once')
  // Busy policy: explicit-target delivery also defaults to steer.
  assert.equal(calls[0]!.origin, 'trigger')
  assert.equal(calls[0]!.whenBusy, 'steer')
})

test('default target without choose: concurrency trigger merge once on demand create (single fly)', { timeout: 60_000 }, async () => {
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
  assert.equal(creations, 1, 'concurrency default trigger only start once on demand create')
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
