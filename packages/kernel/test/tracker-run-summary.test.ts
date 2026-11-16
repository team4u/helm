/**
 * ConversationTracker run leap during real-time summary push regression.
 *
 * defect background (this file lock fix):
 * - old implement adopt() update liveViews after do not push onSummaryChanged; only emitSettled and
 *   setPendingAskCount push summary. first token before (run already start, still without any token/tool)
 *   state machine long time stop old value, send after long phase idle and without hint.
 *
 * now contract (emitRunSummary):
 * 1. run start (snapshot first time appear live.run): push working summary (doing='thinking...');
 * 2. doing semantics change (tool start/end) push new summary; pure streaming token push enter (doing do not change)
 *    do not push - - by semantics refer grain (status|doing|pendingAsk) dedupe, do not one by one token frame;
 * 3. terminal state (completed/failed/aborted) still by emitSettled exactly once negative duty;adopt does not repeat
 *    compute, does not fall back terminal state; same snapshot run1 end + run2 start collapse when order correct;
 * 4. blocked(pendingAsk>0 override working) do not by emitRunSummary fall back is working;
 * 5. stateChangeSeq follow real state change single tune push enter (protocol contract), idle snapshot do not push enter.
 *
 * via real KernelRuntime(faux provider + real SQLite + real observer link) drive,
 * event via kernel.events subscribe collect (and SSE the same exit).
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
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
  root = await makeTempDir('helm-run-summary-')
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

/** subscribe kernel.events(SSE same source exit), collect designate conversation upsert summary timeline. */
function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: RecordedUpsert[]
  stop: () => void
} {
  const frames: RecordedUpsert[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
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

describe('emitRunSummary:run start and doing semantics change real-time summary', { timeout: 60_000 }, () => {
  it('first token before run start i.e. push working(doing=thinking...); terminal state completed exactly once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-start')
    let releaseResponse = () => {}
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    try {
      // keep first token not return, avoid use fixed extend when guess model and observer scheduling order.
      kernel.__faux.setResponses([
        async () => {
          await responseGate
          return fauxAssistantMessage('answer one')
        },
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        const before = kernel.getConversation(1).stateChangeSeq
        const submitP = kernel.submitInput(1, 'first token before issue')
        await waitFor(() => recorded.frames.some((f) => f.status === 'working'))
        assert.equal(kernel.getConversation(1).status, 'working', 'run after startup state machine should already working')
        const workingBeforeFirstToken = recorded.frames.filter((f) => f.status === 'working')
        assert.ok(
          workingBeforeFirstToken.length >= 1,
          `first token before should at least push once working summary, actual:${JSON.stringify(recorded.frames)}`,
        )
        assert.equal(workingBeforeFirstToken[0]!.doing, 'thinking...')
        releaseResponse()
        await submitP
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.some((f) => f.status === 'done'))
        // completed terminal state exactly once:done frame do not because after continue idle snapshot duplicate (context use amount refresh
        // frame and compute frame same seq, by seq dedupe do not count is new terminal state).
        const doneFrames = recorded.frames.filter((f) => f.status === 'done')
        assert.equal(
          new Set(doneFrames.map((f) => f.seq)).size,
          1,
          `completed terminal state exactly once, actual:${JSON.stringify(recorded.frames)}`,
        )
        // stateChangeSeq all process single tune does not fall back (usage-only frame same seq do not push enter).
        const seqs = recorded.frames.map((f) => f.seq)
        for (let i = 1; i < seqs.length; i += 1) {
          assert.ok(seqs[i]! >= seqs[i - 1]!, `stateChangeSeq single tune does not fall back:${JSON.stringify(seqs)}`)
        }
        assert.ok(seqs[0]! > before, 'run start summary push enter stateChangeSeq')
      } finally {
        recorded.stop()
      }
    } finally {
      releaseResponse()
      await kernel.close()
    }
  })

  it('doing change dedupe:thinking -> tool running -> tool done each exactly once, streaming token do not extra frame', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('doing-dedup')
    try {
      // long text streaming answer:faux tokensPerSecond by default split many token,doing always thinking....
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
        // the same doing semantics never connect continue duplicate push (streaming token push enter, same state snapshot duplicate all do not heavy).
        for (let i = 1; i < doings.length; i += 1) {
          assert.ok(
            doings[i] !== doings[i - 1],
            `the same doing semantics connect continue duplicate push:${JSON.stringify(workings)}`,
          )
        }
        assert.ok(doings.includes('thinking...'), `run start doing should contains thinking...:${JSON.stringify(doings)}`)
        assert.ok(
          doings.some((d) => d.startsWith('bash:')),
          `tool round doing should contains bash:...:${JSON.stringify(doings)}`,
        )
        // streaming token do not extra frame:thinking... frame count exactly is run start time count (two run each one).
        // second run long text streaming (20 character one by one token) during doing constant thinking...,
        // must not because token push enter duplicate push.
        const thinkingCount = doings.filter((d) => d === 'thinking...').length
        assert.equal(thinkingCount, 2, `thinking... exactly two frame (two run start each one):${JSON.stringify(workings)}`)
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('followUp connect continue turn working and completed update eventually converge, leaves no residue run state', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('run-switch')
    try {
      // followUp queue up:run1(tool round) in-flight when commit second,SDK in run1 after end immediately
      // consume run2(observer may with same snapshot see to run1 disappear + run2 appear collapse form).
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('run1 answer'),
        fauxAssistantMessage('run2 answer'),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'run1 issue')
        await new Promise((r) => setTimeout(r, 200))
        assert.equal(kernel.getConversation(1).status, 'working')
        void kernel.submitInput(1, 'run2 queue up issue', { whenBusy: 'followUp' }).catch(() => {})
        await kernel.waitForIdle(1)
        await waitFor(() => recorded.frames.filter((f) => f.status === 'done').length >= 1)
        // event order legal: any working frame after allows done;done after new one round working
        // belongs to run2(followUp consume) - - but eventually state must converge is done(run2 also complete).
        await new Promise((r) => setTimeout(r, 400))
        const last = recorded.frames[recorded.frames.length - 1]!
        assert.equal(
          kernel.getConversation(1).status,
          'done',
          `two run all after end terminal state done, actual ${kernel.getConversation(1).status}`,
        )
        assert.ok(
          ['done', 'idle'].includes(last.status),
          `eventually frame should be terminal state, actual:${JSON.stringify(last)}`,
        )
        // missing terminal state after fall back working and again without terminal state pending:working frame after eventually frame must is terminal state.
        const lastWorking = recorded.frames.map((f) => f.status).lastIndexOf('working')
        assert.ok(
          recorded.frames.slice(lastWorking + 1).some((f) => f.status === 'done' || f.status === 'idle'),
          `finally once working after must again reach terminal state:${JSON.stringify(recorded.frames)}`,
        )
      } finally {
        recorded.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('failed / aborted terminal state:emitSettled exactly once,adopt does not repeat compute', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('failed-aborted')
    try {
      // failed:faux report model error.
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        await kernel.submitInput(1, 'will failed issue').catch(() => {})
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded.frames.some((f) => f.status === 'error'))
        const errorFrames = recorded.frames.filter((f) => f.status === 'error')
        assert.equal(errorFrames.length, 1, `failed terminal state exactly once:${JSON.stringify(recorded.frames)}`)
        // idle snapshot no longer push (without re-): terminal state after allows late to frame only limit usage-only
        // (same state, same seq, do not push enter watermark line), state machine must not re- or fall back.
        const frozenAt = recorded.frames.length
        const frozenLast = recorded.frames[frozenAt - 1]!
        await new Promise((r) => setTimeout(r, 250))
        for (const late of recorded.frames.slice(frozenAt)) {
          assert.equal(late.status, frozenLast.status, `terminal state after new frame only can is usage-only:${JSON.stringify(recorded.frames.slice(frozenAt))}`)
          assert.equal(late.seq, frozenLast.seq, 'usage-only frame do not push enter stateChangeSeq')
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
        void kernel.submitInput(1, 'will by abort issue').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        await kernel.abortConversation(1)
        await kernel.waitForIdle(1).catch(() => {})
        await waitFor(() => recorded2.frames.some((f) => f.status === 'idle'))
        // aborted terminal state is idle;working frame store in (run start push) and exactly converge once idle.
        assert.ok(
          recorded2.frames.some((f) => f.status === 'working'),
          `abort before should has working summary:${JSON.stringify(recorded2.frames)}`,
        )
        const idleAfterAbort = recorded2.frames.filter((f) => f.status === 'idle')
        assert.equal(idleAfterAbort.length, 1, `aborted terminal state exactly once:${JSON.stringify(recorded2.frames)}`)
      } finally {
        recorded2.stop()
      }
    } finally {
      await kernel.close()
    }
  })

  it('blocked override working:pendingAsk summary do not by emitRunSummary fall back', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('blocked-no-regress')
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 3' })], { stopReason: 'toolUse' }),
      ])
      const recorded = recordUpserts(kernel, 1)
      try {
        void kernel.submitInput(1, 'trigger approval issue').catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'working')
        // tool in-flight when create pending Ask:setPendingAskCount push blocked.
        const askPromise = kernel.createAsk({
          conversationId: 1,
          title: 'test approval',
          fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
        })
        void askPromise.catch(() => {})
        await waitFor(() => kernel.getConversation(1).status === 'blocked')
        // tool continue in-flight (sleep 3s): during snapshot push enter many time,blocked must not by fall back working.
        await new Promise((r) => setTimeout(r, 800))
        assert.equal(
          kernel.getConversation(1).status,
          'blocked',
          'pendingAsk store in when after continue snapshot must not fall back is working',
        )
        const blockedFrames = recorded.frames.filter((f) => f.status === 'blocked')
        assert.ok(blockedFrames.length >= 1, 'blocked summary already push')
        // blocked after frame disallows again appear working(run still in-flight also does not fall back).
        const afterBlocked = recorded.frames.slice(recorded.frames.findIndex((f) => f.status === 'blocked'))
        assert.ok(
          !afterBlocked.some((f) => f.status === 'working'),
          `blocked after must not fall back working:${JSON.stringify(recorded.frames)}`,
        )
        // clean up: answer Ask and abort in-flight run.
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
