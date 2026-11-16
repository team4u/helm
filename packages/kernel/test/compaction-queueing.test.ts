/**
 * manually context streamline during input queue up, empty skip honor complete, failed keep queue, abort clean up and original ground heavy guard integration test.
 *
 * override (real KernelRuntime + SQLite + fauxProvider latch control when):
 * 1. manually streamline during submitInput(steer / followUp) enter pi.inbox queue up (live.queuedInputs visible);
 *    whenBusy='reject' report 409 conversation_busy; streamline summary after pi.compaction first at
 *    helm.input written to the database, and assist manually based on streamline after summary context answer;
 * 2. manually streamline during withdrawQueuedInput clean withdraw back queue up input;
 * 3. manually streamline during abortConversation abort streamline task, withdraw back queue up input and do not mistakenly report when before context no need to streamline;
 * 4. empty skip manually streamline (short context < 20000 tokens and beforeCompact decline latch double override):
 *    out when before context no need to streamlineinfo notify; during queue up input via continue automatically connect continue and obtain assist manually answer;
 * 5. manually streamline failed and store in queue up input: out context streamline failederror notify, do not run not streamline context
 *    queue up input, and queuedInputs keep complete;
 * 6. manually streamline during replaceFromEntryId original ground override heavy: abort streamline task and succeeded heavy write commit, do not report 409.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { CompactionTask, defineExtension, hook } from '@earendil-works/pi-durable'
import type { ConversationLive, HelmEventFrame } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface CapturedNotice {
  level: string
  title: string
  body?: string
  conversationId?: number
}

async function waitForGateOrAbort(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await Promise.race([
    gate,
    new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true })
    }),
  ])
}

function findLive(kernel: KernelRuntime, conversationId: number): ConversationLive | undefined {
  return (kernel.events.currentSnapshot().conversationLives ?? []).find(
    (l) => l.conversationId === conversationId,
  )
}

function recordNotifications(kernel: KernelRuntime, conversationId: number): {
  notices: CapturedNotice[]
  stop: () => void
} {
  const notices: CapturedNotice[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'notification') return
    const ev = frame.event as { level?: string; title?: string; body?: string; conversationId?: number }
    if (ev.conversationId !== conversationId) return
    notices.push({
      level: ev.level ?? '',
      title: ev.title ?? '',
      body: ev.body,
      conversationId: ev.conversationId,
    })
  })
  return { notices, stop: unsubscribe }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type?: string; text?: string } => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

describe('Compaction queueing, empty-skip reconciliation & rewind guard', { timeout: 60_000 }, () => {
  let root = ''

  before(async () => {
    root = await makeTempDir('helm-compact-queue-')
  })

  after(async () => {
    await cleanupDir(root)
  })

  async function openRuntime(name: string): Promise<{
    kernel: KernelRuntime
    faux: FauxHandle
    dir: string
  }> {
    const dir = join(root, name)
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      externalSkillRoots: [],
    })
    return { kernel, faux, dir }
  }

  /** construct exceeds keepRecentTokens(20000) large context (3 round dialog), make manually compress produce real summary. */
  async function seedLargeContext(kernel: KernelRuntime, faux: FauxHandle): Promise<void> {
    const bigInput = '大规模上下文历史素材。'.repeat(5_000)
    faux.setResponses([
      fauxAssistantMessage('large history answer one'),
      fauxAssistantMessage('large history answer two'),
      fauxAssistantMessage('large history answer three'),
    ])
    for (const marker of ['one round unique mark record', 'second round unique mark record', 'third round unique mark record']) {
      await kernel.submitInput(1, `${marker}：${bigInput}`)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
  }

  it('manually streamline during steer/followUp queue,reject report 409; summary after pi.compaction first at helm.input and assist manually run at streamline after context', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('queue-and-flush')
    let releaseSummary = () => {}
    try {
      await seedLargeContext(kernel, faux)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      const seenAssistantPrompts: string[][] = []

      faux.setResponses([
        async () => {
          summaryEntered()
          await summaryGate
          return fauxAssistantMessage('this is streamline after history summary content')
        },
        async (ctx) => {
          seenAssistantPrompts.push(ctx.messages.map((m) => extractText(m.content)))
          return fauxAssistantMessage('based on streamline summary answer')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      // whenBusy='reject' in streamline during must explicit 409 reject, must not static default queue or start new run.
      await assert.rejects(
        () => kernel.submitInput(1, 'streamline during by reject input', { whenBusy: 'reject' }),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_busy' && err.status === 409,
      )

      // streamline during commit followUp and steer, must enter pi.inbox queue up and reverse reflect in live.queuedInputs.
      const subFu = await kernel.submitInput(1, 'streamline after patch fill issue followUp', { whenBusy: 'followUp' })
      const subSt = await kernel.submitInput(1, 'streamline after insert speech instruction steer', { whenBusy: 'steer' })
      assert.ok(Number(subFu.submissionId) > 0)
      assert.ok(Number(subSt.submissionId) > 0)

      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 2, 10_000)
      const queued = findLive(kernel, 1)!.queuedInputs!
      assert.deepEqual(
        queued.map((q) => ({ text: q.text, mode: q.mode })),
        [
          { text: 'streamline after insert speech instruction steer', mode: 'steer' },
          { text: 'streamline after patch fill issue followUp', mode: 'followUp' },
        ],
      )

      // streamline not complete before, two queue up input all must not mention before written to the database or trigger model request.
      const midDetail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(midDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        midDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'streamline after patch fill issue followUp',
        ),
        false,
      )

      // release summary latch: summary and connect continue queue up input start assist manually turn.
      releaseSummary()
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 15_000)

      const finalDetail = await kernel.getConversationDetail(1, { limit: 100 })
      const compactionIdx = finalDetail.entries.findIndex((e) => e.kind === 'pi.compaction')
      const steerIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'streamline after insert speech instruction steer',
      )
      const followUpIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'streamline after patch fill issue followUp',
      )
      assert.ok(compactionIdx >= 0, 'pi.compaction item must written to the database')
      assert.ok(steerIdx > compactionIdx, 'pi.compaction must first at queue up steer helm.input written to the database')
      assert.ok(followUpIdx > compactionIdx, 'pi.compaction must first at queue up followUp helm.input written to the database')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('based on streamline summary answer'),
        ),
        'assist manually must for streamline during queue up input complete back re-',
      )
      assert.equal(seenAssistantPrompts.length, 1, 'assist manually only should run once (merge consume queue up input)')
      const joinedPrompt = seenAssistantPrompts[0]!.join('\n')
      assert.ok(joinedPrompt.includes('this is streamline after history summary content'), 'assist manually request must carry streamline summary')
      assert.equal(joinedPrompt.includes('one round unique mark record'), false, 'already by streamline compress early history must not again inject assist manually context')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('manually streamline during withdrawQueuedInput clean withdraw back queue up input', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('withdraw-during-compact')
    let releaseSummary = () => {}
    try {
      await seedLargeContext(kernel, faux)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async () => {
          summaryEntered()
          await summaryGate
          return fauxAssistantMessage('streamline summary')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      const { submissionId } = await kernel.submitInput(1, 'streamline during await withdraw back input', { whenBusy: 'followUp' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      const withdrawn = await kernel.withdrawQueuedInput(1, { submissionId: Number(submissionId) })
      assert.equal(withdrawn.status, 'withdrawn')

      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 10_000)

      releaseSummary()
      await kernel.waitForIdle(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)

      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.ok(detail.entries.some((e) => e.kind === 'pi.compaction'), 'compress should normal complete')
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'streamline during await withdraw back input',
        ),
        false,
        'already withdraw back input must not written to the database execute',
      )
      assert.equal(faux.state.callCount, 4, 'must not many out assist manually answer model invoke (3 round build history + 1 time summary)')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('manually streamline during abortConversation abort streamline, withdraw back queue up input and do not mistakenly when before context no need to streamline', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('abort-during-compact')
    let releaseSummary = () => {}
    const recorder = recordNotifications(kernel, 1)
    try {
      await seedLargeContext(kernel, faux)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async (_ctx, opts) => {
          summaryEntered()
          await waitForGateOrAbort(summaryGate, opts?.signal)
          return fauxAssistantMessage('must not the complete')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await kernel.submitInput(1, 'abort when one and withdraw back input', { whenBusy: 'steer' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      await kernel.abortConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 10_000)
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(
        recorder.notices.some((n) => n.title === 'when before context no need to streamline'),
        false,
        'by abort streamline never obtain mistakenly when before context no need to streamline',
      )
      assert.equal(
        recorder.notices.some((n) => n.title === 'context streamline failed'),
        false,
        'actively abort must not produce failed notify',
      )
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'abort when one and withdraw back input',
        ),
        false,
      )
      const tracker = (kernel as unknown as {
        tracker: {
          mirrors: Map<number, { trackedInputs: Map<string, unknown>; submissionIndex: Map<number, string> }>
        }
      }).tracker
      const mirror = tracker.mirrors.get(1)
      assert.equal(mirror?.trackedInputs.size ?? 0, 0, 'abort after non- run queue up append trace record must empty')
      assert.equal(mirror?.submissionIndex.size ?? 0, 0, 'abort after queue up submissionIndex must empty')
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('empty skip manually streamline (< 20000 tokens) out when before context no need to streamline notify; latch during queue up input via continue automatically back re-', { timeout: 60_000 }, async () => {
    // 4a. real short context (< 20000 tokens):selectCut === undefined skip, info notify
    {
      const { kernel, faux } = await openRuntime('empty-skip-short')
      const recorder = recordNotifications(kernel, 1)
      try {
        faux.setResponses([fauxAssistantMessage('short dialog answer')])
        await kernel.submitInput(1, 'short issue')
        await kernel.waitForIdle(1)

        await kernel.compactConversation(1)
        await waitFor(() => recorder.notices.some((n) => n.title === 'when before context no need to streamline'), 10_000)
        const notice = recorder.notices.find((n) => n.title === 'when before context no need to streamline')!
        assert.equal(notice.level, 'info')
        assert.equal(notice.conversationId, 1)
        assert.match(notice.body ?? '', /not generate new summary/)
      } finally {
        recorder.stop()
        await kernel.close()
      }
    }

    // 4b. latch control when (beforeCompact decline -> and selectCut===undefined same away complete() without summary branch):
    //     streamline in progress queue up input -> empty skip after end automatically continue and obtain assist manually answer.
    {
      const { kernel, faux } = await openRuntime('empty-skip-with-queued')
      const recorder = recordNotifications(kernel, 1)
      let releaseHook = () => {}
      try {
        let hookEntered!: () => void
        const enteredPromise = new Promise<void>((resolve) => { hookEntered = resolve })
        const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
        kernel.registry.install(
          defineExtension({
            name: 'test-decline-compact',
            hooks: [
              hook(CompactionTask, {
                beforeCompact: async () => {
                  hookEntered()
                  await hookGate
                  return { decline: true }
                },
              }),
            ],
          }),
        )

        await seedLargeContext(kernel, faux)

        faux.setResponses([fauxAssistantMessage('empty skip after automatically continue answer')])
        await kernel.compactConversation(1)
        await enteredPromise
        await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 10_000)

        await kernel.submitInput(1, 'empty skip streamline during queue up mention question', { whenBusy: 'followUp' })
        await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

        releaseHook()

        await waitFor(() => recorder.notices.some((n) => n.title === 'when before context no need to streamline'), 15_000)
        await kernel.waitForIdle(1)
        await waitFor(() => {
          const live = findLive(kernel, 1)
          return live === undefined || (live.queuedInputs?.length ?? 0) === 0
        }, 15_000)

        const detail = await kernel.getConversationDetail(1, { limit: 100 })
        assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false, 'empty skip must not write pi.compaction')
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'empty skip streamline during queue up mention question',
          ),
          'queue up input should via continue written to the database execute',
        )
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('empty skip after automatically continue answer'),
          ),
          'assist manually must complete for queue up input back re-',
        )
      } finally {
        recorder.stop()
        releaseHook()
        await kernel.close()
      }
    }
  })

  it('manually streamline failed and store in queue up input: context streamline failederror notify, do not run queue up input and keep queuedInputs', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('failed-compact-keeps-queue')
    let releaseSummary = () => {}
    const recorder = recordNotifications(kernel, 1)
    try {
      await seedLargeContext(kernel, faux)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async () => {
          summaryEntered()
          await summaryGate
          return fauxAssistantMessage('summary failed', { stopReason: 'error', errorMessage: 'mock compact error' })
        },
        fauxAssistantMessage('do not the by execute to answer'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      await kernel.submitInput(1, 'failed after should keep in queue input', { whenBusy: 'followUp' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      releaseSummary()
      await waitFor(() => recorder.notices.some((n) => n.title === 'context streamline failed'), 15_000)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await new Promise((r) => setTimeout(r, 80))

      const failNotice = recorder.notices.find((n) => n.title === 'context streamline failed')!
      assert.equal(failNotice.level, 'error')
      assert.match(failNotice.body ?? '', /mock compact error/)
      assert.equal(
        recorder.notices.some((n) => n.title === 'when before context no need to streamline'),
        false,
        'streamline failed must not out no need to streamline notify',
      )

      const live = findLive(kernel, 1)
      assert.equal(live?.queuedInputs?.length, 1, 'queue up input must completely well keep in queuedInputs in')
      assert.equal(live?.queuedInputs?.[0]?.text, 'failed after should keep in queue input')

      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'failed after should keep in queue input',
        ),
        false,
        'failed after must not in not streamline context on without permission run queue up input',
      )
      assert.equal(faux.state.callCount, 4, 'must not many out assist manually invoke (3 round build history + 1 time failed summary)')
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('manually streamline during replaceFromEntryId original ground override heavy: abort streamline task and succeeded heavy write commit (do not report 409)', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('rewind-during-compact')
    let releaseSummary = () => {}
    const recorder = recordNotifications(kernel, 1)
    try {
      await seedLargeContext(kernel, faux)

      const preDetail = await kernel.getConversationDetail(1, { limit: 50 })
      const lastHumanEntry = [...preDetail.entries].reverse().find((e) => e.kind === 'helm.input')
      assert.ok(lastHumanEntry, 'must store in can original ground edit helm.input item')
      const targetEntryId = Number(lastHumanEntry!.id)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async (_ctx, opts) => {
          summaryEntered()
          await waitForGateOrAbort(summaryGate, opts?.signal)
          return fauxAssistantMessage('must not the complete')
        },
        fauxAssistantMessage('original ground override heavy after new answer'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      await kernel.submitInput(1, 'streamline during original ground override new issue', { replaceFromEntryId: targetEntryId })
      await kernel.waitForIdle(1)
      await new Promise((r) => setTimeout(r, 80))

      const finalDetail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(finalDetail.entries.some((e) => e.kind === 'helm.rewind'), 'must write helm.rewind truncate mark record')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'streamline during original ground override new issue',
        ),
        'must written to the database override after new input',
      )
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('original ground override heavy after new answer'),
        ),
        'must obtain heavy after new answer',
      )
      assert.equal(finalDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        recorder.notices.some((n) => n.title === 'when before context no need to streamline'),
        false,
        'by rewind abort streamline must not mistakenly report no need to streamline',
      )
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })
})
