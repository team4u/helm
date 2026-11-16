/**
 * kernel guarded mutation(automatically human hard rule) determinism race test.
 *
 * background:watchdog plugin layer check ownership after, old link invoke ordinary abortConversation /
 * submitInput- - kernel internal first `await harness.conversation(...)` only then produce side effect,
 * the await let out during markOwnership translate rotate is human still will execute action (TOCTOU).
 *
 * verify way (deferred barrier, determinism while non- polling):
 * - use barrier precise hang in harness.conversation  await window on, in window inside
 *   ownership translate rotate is human, again let through;
 * - compare group verify the same barrier in old implement (ordinary abortConversation) window inside and
 *   old semantics indeed still will abort (test is not empty rotate);
 * - guarded API(abortConversationGuarded / submitInputGuarded) in fully identical
 *   when order under must reject (409 ownership_conflict) and underlying SDK action not by start;
 * - also override succeeded path,stateSeq expired 409, ownership does not match 409, target missing 404,
 *   illegal guard 400, and ordinary person class API(submitInput / abortConversation)
 *   in human ownership under behavior do not change.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'
import { KernelRuntime } from '../src/runtime/index.js'

type RuntimeWithFaux = KernelRuntime & { __faux: ReturnType<typeof makeFauxModels>['faux'] }

async function openRuntime(dir: string): Promise<RuntimeWithFaux> {
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(kernel, { __faux: faux })
}

type ConversationFn = (id: never, ctx: unknown) => Promise<unknown>

/**
 * in harness.conversation  await point hang determinism barrier: install after under once (and after continue)
 * conversation() invoke all stop in gate on, until release; release after pass-through real handle.
 * old implement (ordinary abort/submit) in the await after without condition execute action - -barrier during
 * translate rotate ownership i.e. hit old race window.
 */
function barrierConversationHandle(kernel: KernelRuntime): { release: () => void } {
  const harness = (kernel as unknown as { harness: { conversation: ConversationFn } }).harness
  const real = harness.conversation.bind(harness) as ConversationFn
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  harness.conversation = ((id: never, ctx: unknown) =>
    new Promise((resolve, reject) => {
      void gate.then(
        () => {
          void real(id, ctx).then(resolve, reject)
        },
        reject,
      )
    })) as ConversationFn
  return { release }
}

/** micro task conflict refresh: let by test Promise before enter to harness.conversation suspended point. */
async function flushToBarrier(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function isHelmError(code: string, status: number) {
  return (err: unknown): boolean => err instanceof HelmError && err.code === code && err.status === status
}

let root: string

test.before(async () => {
  root = await makeTempDir('helm-guarded-')
})

test.after(async () => {
  await cleanupDir(root)
})

// ---------------------------------------------------------------------------
// 1. race core:await window inside ownership translate rotate
// ---------------------------------------------------------------------------

test('guarded abort:await window inside translate rotate human → 409 ownership_conflict,SDK abort not start', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('do not the need to second answer'),
    ])
    void kernel.submitInput(1, 'will by guard reject abort issue').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await flushToBarrier()
    // old implement await window inside: person class take over.
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmError('ownership_conflict', 409))

    // SDK abort not by start: in-flight turn continue store (if by abort then immediately compute is idle).
    assert.equal(kernel.getConversation(1).status, 'working', 'guarded reject after turn must not by abort')

    // ordinary person class API do not regression:human ownership under human abort per common takes effect.
    await kernel.abortConversation(1)
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
    assert.equal(kernel.getConversation(1).completionSeq, 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('compare group: the same barrier hit old window, ordinary abortConversation in human translate rotate after still will abort (old semantics keep)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-abort-window')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('do not the need to second answer'),
    ])
    void kernel.submitInput(1, 'verify barrier in old window inside').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversation(1)
    await flushToBarrier()
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    // ordinary API without guard: translate rotate after per common abort (this correct is guarded API want close window).
    await attempt
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded submit: prepare work window inside translate rotate human → 409, zero commit side effect (without title derive/without input item)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('do not the appear')])

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.submitInputGuarded(conv.id, 'automatically input', { origin: 'agent' }, { expectedOwnership: 'bot' })
    await flushToBarrier()
    kernel.markConversationOwnership(conv.id, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmError('ownership_conflict', 409))

    // zero commit side effect: title not derive, without helm.input item, conversation still idle.
    const after = kernel.getConversation(conv.id)
    assert.equal(after.status, 'idle')
    assert.equal(after.title, '')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    assert.equal(detail.entries.filter((e) => e.kind === 'helm.input').length, 0, 'must not produce input item')
    // faux response not by consume (model from not by invoke).
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 2. succeeded path and determinism reject
// ---------------------------------------------------------------------------

test('guarded steer whenIdle=reject: idle conversation atomic reject, do not start new turn or input item', { timeout: 60_000 }, async () => {
  const kernel = await openRuntime(join(root, 't-guarded-steer-idle'))
  try {
    const conversation = await kernel.createConversation({ title: 'idle automatically conversation' })
    kernel.markConversationOwnership(conversation.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('must not execute')])
    await assert.rejects(
      kernel.submitInputGuarded(conversation.id, 'only course-correct in-flight task', {
        origin: 'agent', whenBusy: 'steer', whenIdle: 'reject',
      }, { expectedOwnership: 'bot', expectedStateSeq: kernel.getConversation(conversation.id).stateChangeSeq }),
      isHelmError('conversation_idle', 409),
    )
    const detail = await kernel.getConversationDetail(conversation.id)
    assert.equal(detail.entries.filter((entry) => entry.kind === 'helm.input').length, 0)
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
    assert.equal(kernel.getConversation(conversation.id).status, 'idle')
  } finally {
    await kernel.close()
  }
})

test('guarded abort succeeded path:bot conversation in-flight turn by authorization abort', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-ok')
  const kernel = await openRuntime(dir)
  try {
    kernel.markConversationOwnership(1, 'bot')
kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
    ])
    void kernel.submitInput(1, 'will by authorization abort issue').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    await kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await kernel.waitForIdle(1).catch(() => {})
    const conv = kernel.getConversation(1)
    assert.equal(conv.status, 'idle')
    assert.equal(conv.completionSeq, 1, 'aborted exactly compute once')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit succeeded path:bot conversation agent source commit real column and complete turn', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-ok')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('restore complete')])
    const { submissionId } = await kernel.submitInputGuarded(conv.id, 'restore hint', { origin: 'agent', whenBusy: 'steer' }, { expectedOwnership: 'bot' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(kernel.getConversation(conv.id).status, 'done')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 10 })
    const input = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(input, 'helm.input item should store in')
    assert.equal(kernel.__faux.getPendingResponseCount(), 0)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded reject matrix:human ownership / ownership does not match / watermark expired / target missing / illegal guard', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reject-matrix')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'human')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, {}),
      isHelmError('ownership_conflict', 409),
      'human hard hard rule',
    )
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, {}),
      isHelmError('ownership_conflict', 409),
      'human hard hard rule (commit)',
    )

    kernel.markConversationOwnership(conv.id, 'helm')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'bot' }),
      isHelmError('ownership_conflict', 409),
      'ownership precise does not match',
    )

    const seq = kernel.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: seq + 100 }),
      isHelmError('state_seq_conflict', 409),
      'watermark expired CAS',
    )

    await assert.rejects(
      kernel.abortConversationGuarded(999_999, {}),
      isHelmError('not_found', 404),
      'explicit target missing do not by by default routing mask',
    )
    await assert.rejects(
      kernel.submitInputGuarded(999_999, 'x', { origin: 'agent' }, {}),
      isHelmError('not_found', 404),
    )

    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'human' as never }),
      isHelmError('validation_error', 400),
      'expectedOwnership strictly forbidden human',
    )
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: -1 }),
      isHelmError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit unsupported replaceFromEntryId(automatically do not heavy write history)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-no-rewrite')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent', replaceFromEntryId: 1 }, {}),
      isHelmError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 3. ordinary person class API do not regression
// ---------------------------------------------------------------------------

test('ordinary API semantics do not change:human ownership under submitInput / abortConversation per common available', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-api-regression')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    // not mark record ownership (by default human).
kernel.__faux.setResponses([fauxAssistantMessage('person class answer')])
    const { submissionId } = await kernel.submitInput(conv.id, 'person class issue', { origin: 'human' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(await kernel.getLastAssistantText(conv.id), 'person class answer')
    // idle conversation human abort:no-op do not fabricate terminal state, also do not throw guard error.
    await kernel.abortConversation(conv.id)
    assert.equal(kernel.getConversation(conv.id).completionSeq, 1)
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. per-conversation serial gate: same conversation guarded change has order, different conversation mutual non-blocking
// ---------------------------------------------------------------------------

test('guarded change serial gate: same conversation queue up has order execute; before order failed do not block assert after continue', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-gate')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
kernel.__faux.setResponses([fauxAssistantMessage('one answer'), fauxAssistantMessage('second answer')])

    // before order guarded commit failed (watermark expired 400/409) must not toxic serial gate.
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, { expectedStateSeq: 1_000_000 }),
      isHelmError('state_seq_conflict', 409),
    )
    const first = await kernel.submitInputGuarded(conv.id, 'a', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    const second = await kernel.submitInputGuarded(conv.id, 'second', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    assert.ok(first.submissionId)
    assert.ok(second.submissionId)
    await kernel.waitForIdle(conv.id)
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    const inputs = detail.entries.filter((e) => e.kind === 'helm.input')
    assert.equal(inputs.length, 2, 'two guarded input all should column')
  } finally {
    await kernel.close().catch(() => {})
  }
})
