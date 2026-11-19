/**
 * Deterministic race tests for kernel guarded mutations (automated human-ownership hard rule).
 *
 * Background: even after watchdog plugins verify ownership, calling plain abortConversation /
 * submitInput still awaits `harness.conversation(...)` internally before taking effect; during that
 * await gap markConversationOwnership could switch to human and cause TOCTOU execution.
 *
 * Verification strategy (deterministic deferred barrier, zero polling):
 * - Attach a barrier precisely at the `harness.conversation` await point, switch ownership to human
 *   inside the await window, and release;
 * - Control group confirms that the same barrier hits the old window under plain abortConversation,
 *   which still aborts after switching (proving the barrier tests the real window);
 * - Guarded APIs (abortConversationGuarded / submitInputGuarded) must reject under the exact same ordering
 *   (409 ownership_conflict) without starting underlying SDK actions;
 * - Also covers success paths, stale stateSeq 409, mismatched ownership 409, missing target 404,
 *   invalid guards 400, and unchanged human behavior on plain APIs (submitInput / abortConversation);
 * - Guarded context maintenance surface for plugin automation (resetConversationGuarded /
 *   compactConversationGuarded): same serial-domain re-check invariants — human flip inside the await
 *   window rejects before the SDK reset fires, rejected calls leave stateChangeSeq untouched, and
 *   success paths advance the watermark by exactly one (handoff / background compaction taskId).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmxError } from '@helmx/protocol'
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
 * Installs a one-shot deterministic barrier on `harness.conversation` await points: blocks the next
 * (and subsequent) conversation() call at a gate until released, then delegates to the real method.
 * Plain abort/submit used to execute unconditionally after that await -- flipping ownership during the
 * barrier deterministically hits that exact legacy race window.
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

/** Flushes microtasks/I-O ticks so the tested Promise suspends cleanly at harness.conversation. */
async function flushToBarrier(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function isHelmxError(code: string, status: number) {
  return (err: unknown): boolean => err instanceof HelmxError && err.code === code && err.status === status
}

let root: string

test.before(async () => {
  root = await makeTempDir('helmx-guarded-')
})

test.after(async () => {
  await cleanupDir(root)
})

// ---------------------------------------------------------------------------
// 1. Core race: ownership flips inside the await window
// ---------------------------------------------------------------------------

test('guarded abort: flipping ownership to human inside await window -> 409 ownership_conflict, SDK abort untouched', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('unneeded second answer'),
    ])
    void kernel.submitInput(1, 'question whose abort will be rejected by guard').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await flushToBarrier()
    // Simulated takeover inside the legacy await window: human takes over.
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))

    // SDK abort did not fire: in-flight turn keeps running (abort would have settled to idle immediately).
    assert.equal(kernel.getConversation(1).status, 'working', 'turn must not abort after guarded rejection')

    // Normal human API still works: human abort under human ownership settles cleanly.
    await kernel.abortConversation(1)
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
    assert.equal(kernel.getConversation(1).completionSeq, 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('control group: same barrier hits legacy window; plain abortConversation still aborts after flip to human (preserves legacy semantics)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-abort-window')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    kernel.markConversationOwnership(1, 'bot')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('unneeded second answer'),
    ])
    void kernel.submitInput(1, 'verify barrier lands inside legacy window').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.abortConversation(1)
    await flushToBarrier()
    kernel.markConversationOwnership(1, 'human')
    barrier.release()
    // Plain API has no guard: aborts as normal after ownership flip (the exact race guarded API closes).
    await attempt
    await kernel.waitForIdle(1).catch(() => {})
    assert.equal(kernel.getConversation(1).status, 'idle')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded submit: flipping to human inside preparation window -> 409, zero commit side effects (no title / no input entry)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('must never appear')])

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.submitInputGuarded(conv.id, 'automated input', { origin: 'agent' }, { expectedOwnership: 'bot' })
    await flushToBarrier()
    kernel.markConversationOwnership(conv.id, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))

    // Zero commit side effects: title un-derived, no helmx.input entry, conversation stays idle.
    const after = kernel.getConversation(conv.id)
    assert.equal(after.status, 'idle')
    assert.equal(after.title, '')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    assert.equal(detail.entries.filter((e) => e.kind === 'helmx.input').length, 0, 'must not insert input entry')
    // Faux response untouched (model never invoked).
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 2. Success paths and deterministic rejections
// ---------------------------------------------------------------------------

test('guarded steer whenIdle=reject: idle conversation atomically rejects without starting turn or inserting input entry', { timeout: 60_000 }, async () => {
  const kernel = await openRuntime(join(root, 't-guarded-steer-idle'))
  try {
    const conversation = await kernel.createConversation({ title: 'idle automated conversation' })
    kernel.markConversationOwnership(conversation.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('must not execute')])
    await assert.rejects(
      kernel.submitInputGuarded(conversation.id, 'steer only in-flight task', {
        origin: 'agent', whenBusy: 'steer', whenIdle: 'reject',
      }, { expectedOwnership: 'bot', expectedStateSeq: kernel.getConversation(conversation.id).stateChangeSeq }),
      isHelmxError('conversation_idle', 409),
    )
    const detail = await kernel.getConversationDetail(conversation.id)
    assert.equal(detail.entries.filter((entry) => entry.kind === 'helmx.input').length, 0)
    assert.equal(kernel.__faux.getPendingResponseCount(), 1)
    assert.equal(kernel.getConversation(conversation.id).status, 'idle')
  } finally {
    await kernel.close()
  }
})

test('guarded abort success path: bot conversation in-flight turn aborts when authorized', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-abort-ok')
  const kernel = await openRuntime(dir)
  try {
    kernel.markConversationOwnership(1, 'bot')
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
    ])
    void kernel.submitInput(1, 'question to authorize-abort').catch(() => {})
    await waitFor(() => kernel.getConversation(1).status === 'working')

    await kernel.abortConversationGuarded(1, { expectedOwnership: 'bot' })
    await kernel.waitForIdle(1).catch(() => {})
    const conv = kernel.getConversation(1)
    assert.equal(conv.status, 'idle')
    assert.equal(conv.completionSeq, 1, 'aborted turn settles once')
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit success path: bot conversation submits agent input and completes turn', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-submit-ok')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('recovery done')])
    const { submissionId } = await kernel.submitInputGuarded(conv.id, 'recovery prompt', { origin: 'agent', whenBusy: 'steer' }, { expectedOwnership: 'bot' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(kernel.getConversation(conv.id).status, 'done')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 10 })
    const input = detail.entries.find((e) => e.kind === 'helmx.input')
    assert.ok(input, 'helmx.input entry should exist')
    assert.equal(kernel.__faux.getPendingResponseCount(), 0)
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded rejection matrix: human ownership / ownership mismatch / stale seq / missing target / invalid guard', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reject-matrix')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'human')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, {}),
      isHelmxError('ownership_conflict', 409),
      'human ownership hard rule',
    )
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, {}),
      isHelmxError('ownership_conflict', 409),
      'human ownership hard rule (submit)',
    )

    kernel.markConversationOwnership(conv.id, 'helmx')
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'bot' }),
      isHelmxError('ownership_conflict', 409),
      'exact ownership mismatch',
    )

    const seq = kernel.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: seq + 100 }),
      isHelmxError('state_seq_conflict', 409),
      'stale watermark CAS',
    )

    await assert.rejects(
      kernel.abortConversationGuarded(999_999, {}),
      isHelmxError('not_found', 404),
      'missing explicit target must not fall back to default route',
    )
    await assert.rejects(
      kernel.submitInputGuarded(999_999, 'x', { origin: 'agent' }, {}),
      isHelmxError('not_found', 404),
    )

    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedOwnership: 'human' as never }),
      isHelmxError('validation_error', 400),
      'expectedOwnership forbids human',
    )
    await assert.rejects(
      kernel.abortConversationGuarded(conv.id, { expectedStateSeq: -1 }),
      isHelmxError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded submit rejects replaceFromEntryId (automation cannot rewrite history)', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-no-rewrite')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent', replaceFromEntryId: 1 }, {}),
      isHelmxError('validation_error', 400),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 3. Normal human APIs remain unaffected
// ---------------------------------------------------------------------------

test('normal API semantics unchanged: submitInput / abortConversation operate normally under human ownership', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-plain-api-regression')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    // Unmarked ownership defaults to human.
    kernel.__faux.setResponses([fauxAssistantMessage('human answer')])
    const { submissionId } = await kernel.submitInput(conv.id, 'human question', { origin: 'human' })
    assert.ok(submissionId)
    await kernel.waitForIdle(conv.id)
    assert.equal(await kernel.getLastAssistantText(conv.id), 'human answer')
    // Human abort on idle conversation: no-op without fabricating settlement or throwing guard error.
    await kernel.abortConversation(conv.id)
    assert.equal(kernel.getConversation(conv.id).completionSeq, 1)
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. Per-conversation serial gate: serialized per conversation, non-blocking across conversations
// ---------------------------------------------------------------------------

test('guarded mutation serial gate: serialized within conversation; early failures never poison subsequent calls', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-gate')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('answer 1'), fauxAssistantMessage('answer 2')])

    // Early guarded submit failure (stale watermark 400/409) must never poison the serial gate.
    await assert.rejects(
      kernel.submitInputGuarded(conv.id, 'x', { origin: 'agent' }, { expectedStateSeq: 1_000_000 }),
      isHelmxError('state_seq_conflict', 409),
    )
    const first = await kernel.submitInputGuarded(conv.id, 'a', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    const second = await kernel.submitInputGuarded(conv.id, 'second', { origin: 'agent', whenBusy: 'followUp' }, { expectedOwnership: 'bot' })
    assert.ok(first.submissionId)
    assert.ok(second.submissionId)
    await kernel.waitForIdle(conv.id)
    const detail = await kernel.getConversationDetail(conv.id, { limit: 50 })
    const inputs = detail.entries.filter((e) => e.kind === 'helmx.input')
    assert.equal(inputs.length, 2, 'both guarded inputs should be queued')
  } finally {
    await kernel.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// 4. Guarded context reset / compaction (plugin automation surface)
// ---------------------------------------------------------------------------

test('guarded reset: flipping ownership to human inside await window -> 409 ownership_conflict, SDK reset untouched', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reset-race')
  const kernel = await openRuntime(dir)
  let barrier: { release: () => void } | undefined
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('first answer')])
    await kernel.submitInput(conv.id, 'seed history')
    await kernel.waitForIdle(conv.id)
    const seqBefore = kernel.getConversation(conv.id).stateChangeSeq

    barrier = barrierConversationHandle(kernel)
    const attempt = kernel.resetConversationGuarded(conv.id, { handoff: 'next phase' }, { expectedOwnership: 'bot' })
    await flushToBarrier()
    // Simulated takeover inside the legacy await window: human takes over.
    kernel.markConversationOwnership(conv.id, 'human')
    barrier.release()
    await assert.rejects(attempt, isHelmxError('ownership_conflict', 409))

    // SDK reset never fired: stateChangeSeq unchanged and history is still readable.
    const after = kernel.getConversation(conv.id)
    assert.equal(after.stateChangeSeq, seqBefore, 'rejected guarded reset must not touch stateChangeSeq')
    const detail = await kernel.getConversationDetail(conv.id, { limit: 10 })
    assert.ok(detail.entries.some((e) => e.kind === 'helmx.input'), 'history must survive a rejected guarded reset')

    // Plain human API still works under human ownership.
    const resetSummary = await kernel.resetConversation(conv.id)
    assert.equal(resetSummary.stateChangeSeq, seqBefore + 1, 'human reset advances the watermark by exactly one')
  } finally {
    barrier?.release()
    await kernel.close().catch(() => {})
  }
})

test('guarded reset success path: bot conversation resets with handoff and advances stateChangeSeq', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-reset-success')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'bot')
    kernel.__faux.setResponses([fauxAssistantMessage('answer before reset')])
    await kernel.submitInput(conv.id, 'history to be cleared')
    await kernel.waitForIdle(conv.id)
    const seqBefore = kernel.getConversation(conv.id).stateChangeSeq
    const statusBefore = kernel.getConversation(conv.id).status

    const summary = await kernel.resetConversationGuarded(conv.id, { handoff: 'carry-on note' }, { expectedOwnership: 'bot' })
    assert.equal(summary.id, conv.id)
    assert.equal(summary.stateChangeSeq, seqBefore + 1, 'guarded reset advances the watermark by exactly one')
    assert.equal(summary.status, statusBefore, 'reset clears context, not the review/read state')

    // Missing explicit target must not fall back to default routing.
    await assert.rejects(
      kernel.resetConversationGuarded(999_999, {}, {}),
      isHelmxError('not_found', 404),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded compact: human rejected before enqueue; bot success returns taskId and advances watermark', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-compact')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'human')
    const seqBefore = kernel.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.compactConversationGuarded(conv.id, {}, {}),
      isHelmxError('ownership_conflict', 409),
      'human ownership hard rule (compact)',
    )
    assert.equal(
      kernel.getConversation(conv.id).stateChangeSeq,
      seqBefore,
      'rejected guarded compact must not touch stateChangeSeq',
    )

    kernel.markConversationOwnership(conv.id, 'helmx')
    const seqHuman = kernel.getConversation(conv.id).stateChangeSeq
    const result = await kernel.compactConversationGuarded(conv.id, { instructions: 'keep decisions' }, { expectedOwnership: 'helmx' })
    assert.ok(Number.isInteger(result.taskId) && result.taskId >= 0, 'compaction returns a background task id')
    assert.equal(result.conversation.id, conv.id)
    assert.equal(result.conversation.stateChangeSeq, seqHuman + 1, 'guarded compact advances the watermark by exactly one')

    // Stale watermark CAS and missing target.
    await assert.rejects(
      kernel.compactConversationGuarded(conv.id, {}, { expectedStateSeq: result.conversation.stateChangeSeq + 100 }),
      isHelmxError('state_seq_conflict', 409),
    )
    await assert.rejects(
      kernel.compactConversationGuarded(999_999, {}, {}),
      isHelmxError('not_found', 404),
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})

test('guarded reset/compact rejection matrix: ownership mismatch / invalid guards', { timeout: 60_000 }, async () => {
  const dir = join(root, 't-guarded-context-reject')
  const kernel = await openRuntime(dir)
  try {
    const conv = await kernel.createConversation({})
    kernel.markConversationOwnership(conv.id, 'helmx')
    await assert.rejects(
      kernel.resetConversationGuarded(conv.id, {}, { expectedOwnership: 'bot' }),
      isHelmxError('ownership_conflict', 409),
      'exact ownership mismatch (reset)',
    )
    await assert.rejects(
      kernel.compactConversationGuarded(conv.id, {}, { expectedOwnership: 'bot' }),
      isHelmxError('ownership_conflict', 409),
      'exact ownership mismatch (compact)',
    )
    const seq = kernel.getConversation(conv.id).stateChangeSeq
    await assert.rejects(
      kernel.resetConversationGuarded(conv.id, {}, { expectedStateSeq: seq + 100 }),
      isHelmxError('state_seq_conflict', 409),
      'stale watermark CAS (reset)',
    )
    await assert.rejects(
      kernel.resetConversationGuarded(conv.id, {}, { expectedOwnership: 'human' as never }),
      isHelmxError('validation_error', 400),
      'expectedOwnership forbids human (reset)',
    )
    await assert.rejects(
      kernel.compactConversationGuarded(conv.id, {}, { expectedStateSeq: -1 }),
      isHelmxError('validation_error', 400),
      'expectedStateSeq must be non-negative (compact)',
    )
  } finally {
    await kernel.close().catch(() => {})
  }
})
