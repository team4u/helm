/**
 * Regression tests for real-time summary emission during active ConversationTracker runs.
 *
 * Bug background (locked down by this test suite):
 * - Previously, adopt() updated liveViews without emitting onSummaryChanged; only emitSettled and
 *   setPendingAskCount pushed summaries. Before the first token arrived (after a run started, before
 *   any token or tool), the state machine remained on the stale value, leaving an apparent idle gap
 *   with no status indicator right after submission.
 *
 * Current contract (emitRunSummary):
 * 1. Run start (when live.run first appears in a snapshot): emit a working summary (doing='thinking...');
 * 2. Semantic changes to `doing` (tool start/end) emit a new summary; pure streaming token progress
 *    (when `doing` does not change) does not emit -- deduplicated by semantic key
 *    (status|doing|pendingAsk) rather than emitting per token frame;
 * 3. Terminal states (completed/failed/aborted) remain owned by emitSettled (emitted exactly once);
 *    adopt neither recomputes nor regresses terminal states, and preserves ordering when run1 ends
 *    and run2 starts within the same collapsed snapshot;
 * 4. blocked (pendingAsk > 0 overriding working) is never regressed back to working by emitRunSummary;
 * 5. stateChangeSeq advances monotonically with real state transitions (protocol contract); idle
 *    snapshots do not advance it.
 *
 * Driven by a real KernelRuntime (faux provider + real SQLite + real observer pipeline); events are
 * collected via kernel.events subscription (sharing the exact same source as SSE).
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmxEventFrame } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface RecordedUpsert {
  status: ConversationSummary['status']
  doing: string | undefined
  seq: number
  at: number
}

let root = ''

before(async () => {
  root = await makeTempDir('helmx-run-summary-')
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

/** Subscribes to kernel.events (same source as SSE) and collects summary upsert timeline frames for the target conversation. */
function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: RecordedUpsert[]
  stop: () => void
} {
  const frames: RecordedUpsert[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmxEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id !== conversationId) return
    frames.push({
      status: conversation.status,
      doing: conversation.doing,
      seq: conversation.stateChangeSeq,
      at: frame.seq,
    })
  })
  return { frames, stop: unsubscribe }
}

describe('emitRunSummary: real-time summary on run start and doing semantic changes', { timeout: 60_000 }, () => {
  it('emits working(doing=thinking...) on run start before first token; terminal completed emitted once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-start')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    try {
      // Hold back the first token instead of using a fixed delay to guess model/observer scheduling order.
      kernel.__faux.setResponses([
        async () => {
          await responseGate
          return fauxAssistantMessage('answer one')
        },
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        const before = kernel.getConversation(1).stateChangeSeq
        const submitP = kernel.submitInput(1, 'prompt before first token')
        await waitFor(() => recorded.frames.some((f) => f.status === 'working'))
        assert.equal(kernel.getConversation(1).status, 'working', 'state machine should already be working after run starts')
        const workingBeforeFirstToken = recorded.frames.filter((f) => f.status === 'working')
        assert.ok(
          workingBeforeFirstToken.length >= 1,
          `should emit at least one working summary before first token, actual: ${JSON.stringify(recorded.frames)}`,
        )
        assert.equal(workingBeforeFirstToken[0]!.doing, 'thinking...')
        releaseResponse()
        await submitP
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        // completed terminal state emitted exactly once: trailing idle snapshots must not duplicate done
        // frames (context-usage refresh frames share the same seq and are deduplicated, not counted as a new terminal state).
        const doneFrames = recorded.frames.filter((f) => f.status === 'done')
        assert.equal(
          new Set(doneFrames.map((f) => f.seq)).size,
          1,
          `completed terminal state must be emitted once, actual: ${JSON.stringify(recorded.frames)}`,
        )
        // stateChangeSeq advances monotonically without regressing (usage-only frames share the same seq and do not advance it).
        const seqs = recorded.frames.map((f) => f.seq)
        for (let i = 1; i < seqs.length; i += 1) {
          assert.ok(seqs[i]! >= seqs[i - 1]!, `stateChangeSeq must be monotonic and never regress: ${JSON.stringify(seqs)}`)
        }
        assert.ok(seqs[0]! > before, 'run-start summary advances stateChangeSeq')
      } finally {
        recorded.stop()
      }
    } finally {
      releaseResponse()
      await kernel.close()
    }
  })

  it('deduplicates doing transitions: thinking -> tool running -> tool done once each, no extra frames per token', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('doing-dedup')
    try {
      // Long streaming text: faux tokensPerSecond emits multiple tokens while doing remains 'thinking...'.
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('one two three four five six seven eight nine ten one two three four five six seven eight nine ten'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'trigger tool round')
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        const workings = recorded.frames.filter((f) => f.status === 'working')
        const doings = workings.map((f) => f.doing ?? '')
        // Identical doing semantics must never be pushed twice in a row (neither on token streaming nor on repeated snapshots).
        for (let i = 1; i < doings.length; i += 1) {
          assert.ok(
            doings[i] !== doings[i - 1],
            `identical doing semantics pushed consecutively: ${JSON.stringify(workings)}`,
          )
        }
        assert.ok(doings.includes('thinking...'), `run-start doing should include thinking...: ${JSON.stringify(doings)}`)
        assert.ok(
          doings.some((d) => d.startsWith('bash:')),
          `tool round doing should include bash:...: ${JSON.stringify(doings)}`,
        )
        // Streaming tokens must not emit extra frames: thinking... appears once per run start (two runs total).
        // During the second run's 20-word token-by-token stream, doing stays thinking... and must not re-emit.
        const thinkingCount = doings.filter((d) => d === 'thinking...').length
        assert.equal(thinkingCount, 2, `thinking... must appear exactly twice (once per run start): ${JSON.stringify(workings)}`)
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('successive followUp runs emit working and completed updates and converge cleanly without stale run state', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-switch')
    try {
      // followUp queuing: while run1 (with a tool round) is in flight, a second input is submitted;
      // SDK consumes run2 immediately after run1 finishes (observer may collapse run1 ending and run2
      // starting into the same snapshot).
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('run1 answer'),
        fauxAssistantMessage('run2 answer'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'run1 prompt')
        await new Promise((r) => setTimeout(r, 200))
        assert.equal(kernel.getConversation(1).status, 'working')
        void kernel.submitInput(1, 'run2 follow-up prompt', { whenBusy: 'followUp' }).catch(() => {})
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.filter((f) => f.status === 'done').length >= 1)
        // Valid event ordering: done may follow working; another round of working may follow done
        // (for run2 consumed via followUp) -- but final status must converge to done (run2 completes).
        await new Promise((r) => setTimeout(r, 400))
        const last = recorded.frames[recorded.frames.length - 1]!
        assert.equal(
          kernel.getConversation(1).status,
          'done',
          `both runs should settle at terminal status done, actual ${kernel.getConversation(1).status}`,
        )
        assert.ok(
          ['done', 'idle'].includes(last.status),
          `final frame should be a terminal state, actual: ${JSON.stringify(last)}`,
        )
        // Guard against regressing to working after terminal state and getting stuck: after the last working
        // frame, a terminal frame must still follow.
        const lastWorking = recorded.frames.map((f) => f.status).lastIndexOf('working')
        assert.ok(
          recorded.frames.slice(lastWorking + 1).some((f) => f.status === 'done' || f.status === 'idle'),
          `a terminal frame must follow the final working frame: ${JSON.stringify(recorded.frames)}`,
        )
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('failed / aborted terminal states: emitSettled emits once, adopt does not recompute', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('failed-aborted')
    try {
      // failed: faux reports a model error.
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'failing prompt').catch(() => {})
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded.frames.some((f) => f.status === 'error'))
        const errorFrames = recorded.frames.filter((f) => f.status === 'error')
        assert.equal(errorFrames.length, 1, `failed terminal state must be emitted once: ${JSON.stringify(recorded.frames)}`)
        // Idle snapshots no longer emit (no re-emission): any trailing frame after terminal settlement can only be
        // usage-only (same status, same seq, watermark not advanced); state machine must never re-emit or regress.
        const frozenAt = recorded.frames.length
        const frozenLast = recorded.frames[frozenAt - 1]!
        await new Promise((r) => setTimeout(r, 250))
        for (const late of recorded.frames.slice(frozenAt)) {
          assert.equal(late.status, frozenLast.status, `post-terminal frames can only be usage-only: ${JSON.stringify(recorded.frames.slice(frozenAt))}`)
          assert.equal(late.seq, frozenLast.seq, 'usage-only frames must not advance stateChangeSeq')
        }
      } finally {
        recorded.stop()
      }

      // aborted: tool long turn in-flight explicit abort.
      const recorded2 = recordUpserts(kernel, 1)
      try {
        kernel.__faux.setResponses([
          fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
            stopReason: 'toolUse',
          }),
        ])
        void kernel.submitInput(1, 'prompt to be aborted').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        await kernel.abortConversation(1)
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded2.frames.some((f) => f.status === 'idle'))
        // Aborted terminal status is idle; a working frame existed (emitted on run start) and settled once to idle.
        assert.ok(
          recorded2.frames.some((f) => f.status === 'working'),
          `a working summary should precede abort: ${JSON.stringify(recorded2.frames)}`,
        )
        const idleAfterAbort = recorded2.frames.filter((f) => f.status === 'idle')
        assert.equal(idleAfterAbort.length, 1, `aborted terminal state must be emitted once: ${JSON.stringify(recorded2.frames)}`)
      } finally {
        recorded2.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('blocked overrides working: pendingAsk summary is not regressed by emitRunSummary', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('blocked-no-regress')
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 3' })], { stopReason: 'toolUse' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        void kernel.submitInput(1, 'prompt triggering approval').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        // Create pending Ask while tool is in flight: setPendingAskCount emits blocked.
        const askPromise = kernel.createAsk({
          conversationId: 1,
          title: 'test approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void askPromise.catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'blocked')
        // Tool keeps running (sleep 3s): snapshots keep arriving; blocked must not regress back to working.
        await new Promise((r) => setTimeout(r, 800))
        assert.equal(
          kernel.getConversation(1).status,
          'blocked',
          'subsequent snapshots while pendingAsk is open must not regress status back to working',
        )
        const blockedFrames = recorded.frames.filter((f) => f.status === 'blocked')
        assert.ok(blockedFrames.length >= 1, 'blocked summary was emitted')
        // No frame after blocked may revert to working (even while run remains in flight).
        const afterBlocked = recorded.frames.slice(recorded.frames.findIndex((f) => f.status === 'blocked'))
        assert.ok(
          !afterBlocked.some((f) => f.status === 'working'),
          `must not regress back to working after blocked: ${JSON.stringify(recorded.frames)}`,
        )
        // Clean up: answer Ask and abort in-flight run.
        const pending = kernel.listAsks('pending')
        if (pending.length > 0) await kernel.answerAsk(pending[0]!.id, { confirm: 'true' }).catch(() => {})
        await kernel.abortConversation(1).catch(() => {})
        await kernel.waitForIdle(1).catch(() => {})
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })
})
