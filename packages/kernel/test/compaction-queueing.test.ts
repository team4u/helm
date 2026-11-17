/**
 * Integration tests for input queueing during manual compaction, empty-skip reconciliation,
 * failure queue preservation, abort cleanup, and in-place rewind preemption.
 *
 * Covers (real KernelRuntime + SQLite + fauxProvider latches):
 * 1. submitInput (steer / followUp) during manual compaction enters pi.inbox queue (visible in live.queuedInputs);
 *    whenBusy='reject' returns 409 conversation_busy; post-compaction pi.compaction persists before
 *    helm.input, and assistant runs against the compacted summary context;
 * 2. withdrawQueuedInput cleanly withdraws queued input during manual compaction;
 * 3. abortConversation aborts active compaction, withdraws queued input, and never misreports unnecessary compaction;
 * 4. Empty-skip manual compaction (both short context <20000 tokens and beforeCompact decline latch):
 *    emits info notice 'Current context does not need compaction'; queued inputs proceed automatically;
 * 5. Failed manual compaction with queued inputs: emits 'Context compaction failed' error notice, does not execute
 *    queued inputs on uncompacted context, and keeps queuedInputs intact;
 * 6. In-place overwrite (replaceFromEntryId) during manual compaction aborts compaction and succeeds cleanly without 409.
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

  /** Build a large context exceeding keepRecentTokens (20000) across 3 turns so manual compaction produces a real summary. */
  async function seedLargeContext(kernel: KernelRuntime, faux: FauxHandle): Promise<void> {
    const bigInput = '大规模上下文历史素材。'.repeat(5_000)
    faux.setResponses([
      fauxAssistantMessage('large history answer one'),
      fauxAssistantMessage('large history answer two'),
      fauxAssistantMessage('large history answer three'),
    ])
    for (const marker of ['round-1-unique-marker', 'round-2-unique-marker', 'round-3-unique-marker']) {
      await kernel.submitInput(1, `${marker}: ${bigInput}`)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
  }

  it('queues steer/followUp during compaction, rejects 409 when reject, and commits pi.compaction before helm.input', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('compacted summary of prior history')
        },
        async (ctx) => {
          seenAssistantPrompts.push(ctx.messages.map((m) => extractText(m.content)))
          return fauxAssistantMessage('reply based on compacted summary')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      // whenBusy='reject' must explicitly fail with 409 during compaction rather than silently queueing or starting a run.
      await assert.rejects(
        () => kernel.submitInput(1, 'rejected input during compaction', { whenBusy: 'reject' }),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_busy' && err.status === 409,
      )

      // followUp and steer submitted during compaction enter pi.inbox and appear in live.queuedInputs.
      const subFu = await kernel.submitInput(1, 'follow-up question after compaction', { whenBusy: 'followUp' })
      const subSt = await kernel.submitInput(1, 'steer instruction after compaction', { whenBusy: 'steer' })
      assert.ok(Number(subFu.submissionId) > 0)
      assert.ok(Number(subSt.submissionId) > 0)

      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 2, 10_000)
      const queued = findLive(kernel, 1)!.queuedInputs!
      assert.deepEqual(
        queued.map((q) => ({ text: q.text, mode: q.mode })),
        [
          { text: 'steer instruction after compaction', mode: 'steer' },
          { text: 'follow-up question after compaction', mode: 'followUp' },
        ],
      )

      // Before compaction completes, queued inputs must neither persist nor trigger model calls.
      const midDetail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(midDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        midDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'follow-up question after compaction',
        ),
        false,
      )

      // Release summary gate: summary persists and assistant runs the queued turn automatically.
      releaseSummary()
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 15_000)

      const finalDetail = await kernel.getConversationDetail(1, { limit: 100 })
      const compactionIdx = finalDetail.entries.findIndex((e) => e.kind === 'pi.compaction')
      const steerIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'steer instruction after compaction',
      )
      const followUpIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'follow-up question after compaction',
      )
      assert.ok(compactionIdx >= 0, 'pi.compaction entry must be persisted')
      assert.ok(steerIdx > compactionIdx, 'pi.compaction must persist before queued steer helm.input')
      assert.ok(followUpIdx > compactionIdx, 'pi.compaction must persist before queued followUp helm.input')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('reply based on compacted summary'),
        ),
        'assistant must complete response to inputs queued during compaction',
      )
      assert.equal(seenAssistantPrompts.length, 1, 'assistant should run once consuming merged queued inputs')
      const joinedPrompt = seenAssistantPrompts[0]!.join('\n')
      assert.ok(joinedPrompt.includes('compacted summary of prior history'), 'assistant call must include compacted summary')
      assert.equal(joinedPrompt.includes('round-1-unique-marker'), false, 'compacted early history must no longer appear in prompt')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('withdrawQueuedInput cleanly withdraws queued input during manual compaction', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('compacted summary')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      const { submissionId } = await kernel.submitInput(1, 'input to withdraw during compaction', { whenBusy: 'followUp' })
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
      assert.ok(detail.entries.some((e) => e.kind === 'pi.compaction'), 'compaction should still finish normally')
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'input to withdraw during compaction',
        ),
        false,
        'withdrawn input must never persist or execute',
      )
      assert.equal(faux.state.callCount, 4, 'no extra assistant reply call (3 seed turns + 1 summary call)')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('abortConversation aborts manual compaction, clears queued input, and never misreports unnecessary compaction', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('must not finish')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await kernel.submitInput(1, 'input dropped upon abort', { whenBusy: 'steer' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      await kernel.abortConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 10_000)
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(
        recorder.notices.some((n) => n.title === 'Current context does not need compaction'),
        false,
        'aborted compaction must never misreport unnecessary compaction',
      )
      assert.equal(
        recorder.notices.some((n) => n.title === 'Context compaction failed'),
        false,
        'explicit abort must not emit failure notice',
      )
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'input dropped upon abort',
        ),
        false,
      )
      const tracker = (kernel as unknown as {
        tracker: {
          mirrors: Map<number, { trackedInputs: Map<string, unknown>; submissionIndex: Map<number, string> }>
        }
      }).tracker
      const mirror = tracker.mirrors.get(1)
      assert.equal(mirror?.trackedInputs.size ?? 0, 0, 'trackedInputs must be empty after abort cleanup')
      assert.equal(mirror?.submissionIndex.size ?? 0, 0, 'submissionIndex must be empty after abort cleanup')
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('empty-skip manual compaction (<20000 tokens) emits notice and reconciles queued inputs automatically', { timeout: 60_000 }, async () => {
    // 4a. Naturally short context (<20000 tokens): selectCut === undefined skips, emits info notice
    {
      const { kernel, faux } = await openRuntime('empty-skip-short')
      const recorder = recordNotifications(kernel, 1)
      try {
        faux.setResponses([fauxAssistantMessage('short dialog answer')])
        await kernel.submitInput(1, 'short issue')
        await kernel.waitForIdle(1)

        await kernel.compactConversation(1)
        await waitFor(() => recorder.notices.some((n) => n.title === 'Current context does not need compaction'), 10_000)
        const notice = recorder.notices.find((n) => n.title === 'Current context does not need compaction')!
        assert.equal(notice.level, 'info')
        assert.equal(notice.conversationId, 1)
        assert.match(notice.body ?? '', /no new summary was generated/)
      } finally {
        recorder.stop()
        await kernel.close()
      }
    }

    // 4b. Latched case (beforeCompact decline -> same zero-summary completed() branch as selectCut === undefined):
    //     queued input during compaction auto-resumes after empty-skip and gets assistant response.
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

        faux.setResponses([fauxAssistantMessage('auto-resumed reply after empty skip')])
        await kernel.compactConversation(1)
        await enteredPromise
        await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 10_000)

        await kernel.submitInput(1, 'queued question during empty-skip compaction', { whenBusy: 'followUp' })
        await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

        releaseHook()

        await waitFor(() => recorder.notices.some((n) => n.title === 'Current context does not need compaction'), 15_000)
        await kernel.waitForIdle(1)
        await waitFor(() => {
          const live = findLive(kernel, 1)
          return live === undefined || (live.queuedInputs?.length ?? 0) === 0
        }, 15_000)

        const detail = await kernel.getConversationDetail(1, { limit: 100 })
        assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false, 'empty skip must not write pi.compaction')
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'queued question during empty-skip compaction',
          ),
          'queued input should execute and persist via continue',
        )
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('auto-resumed reply after empty skip'),
          ),
          'assistant must complete reply for queued input',
        )
      } finally {
        recorder.stop()
        releaseHook()
        await kernel.close()
      }
    }
  })

  it('failed manual compaction with queued inputs emits error notice, skips running queue, and preserves queuedInputs', { timeout: 60_000 }, async () => {
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
        fauxAssistantMessage('reply that must never execute'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      await kernel.submitInput(1, 'input kept in queue after failure', { whenBusy: 'followUp' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      releaseSummary()
      await waitFor(() => recorder.notices.some((n) => n.title === 'Context compaction failed'), 15_000)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await new Promise((r) => setTimeout(r, 80))

      const failNotice = recorder.notices.find((n) => n.title === 'Context compaction failed')!
      assert.equal(failNotice.level, 'error')
      assert.match(failNotice.body ?? '', /mock compact error/)
      assert.equal(
        recorder.notices.some((n) => n.title === 'Current context does not need compaction'),
        false,
        'failed compaction must not emit unnecessary-compaction notice',
      )

      const live = findLive(kernel, 1)
      assert.equal(live?.queuedInputs?.length, 1, 'queued input must remain intact in queuedInputs')
      assert.equal(live?.queuedInputs?.[0]?.text, 'input kept in queue after failure')

      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'input kept in queue after failure',
        ),
        false,
        'must not execute queued input on uncompacted context after failure',
      )
      assert.equal(faux.state.callCount, 4, 'must not trigger extra assistant calls (3 seed turns + 1 failed summary)')
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('replaceFromEntryId in-place overwrite during manual compaction aborts compaction and commits cleanly without 409', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('rewind-during-compact')
    let releaseSummary = () => {}
    const recorder = recordNotifications(kernel, 1)
    try {
      await seedLargeContext(kernel, faux)

      const preDetail = await kernel.getConversationDetail(1, { limit: 50 })
      const lastHumanEntry = [...preDetail.entries].reverse().find((e) => e.kind === 'helm.input')
      assert.ok(lastHumanEntry, 'must contain editable helm.input entry')
      const targetEntryId = Number(lastHumanEntry!.id)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async (_ctx, opts) => {
          summaryEntered()
          await waitForGateOrAbort(summaryGate, opts?.signal)
          return fauxAssistantMessage('must not finish')
        },
        fauxAssistantMessage('new reply after in-place overwrite'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      await kernel.submitInput(1, 'new issue replacing history during compaction', { replaceFromEntryId: targetEntryId })
      await kernel.waitForIdle(1)
      await new Promise((r) => setTimeout(r, 80))

      const finalDetail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(finalDetail.entries.some((e) => e.kind === 'helm.rewind'), 'must persist helm.rewind marker')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === 'new issue replacing history during compaction',
        ),
        'must persist replacement input',
      )
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('new reply after in-place overwrite'),
        ),
        'must receive new reply after rewind',
      )
      assert.equal(finalDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        recorder.notices.some((n) => n.title === 'Current context does not need compaction'),
        false,
        'compaction aborted by rewind must not misreport unnecessary compaction',
      )
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('uses global compactionModel when set (clamping reasoning/maxTokens, persisting across restart), and falls back to current model when cleared; never silently falls back when disabled', { timeout: 60_000 }, async () => {
    const dir = join(root, 'global-compaction-model')
    const { models, faux } = makeFauxModels({
      models: [
        { id: 'faux-1', reasoning: true, maxTokens: 16_384, contextWindow: 128_000 },
        { id: 'faux-2', reasoning: false, maxTokens: 2_048, contextWindow: 128_000 },
      ],
    })
    let kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      externalSkillRoots: [],
    })
    const seenSummaryCalls: Array<{ modelId: string; maxTokens?: number; reasoning?: unknown }> = []
    try {
      await kernel.setDefaultModel(undefined, 'high', 'faux/faux-2')
      assert.equal((await kernel.listModels()).defaultCompactionModel, 'faux/faux-2')

      await seedLargeContext(kernel, faux)

      faux.setResponses([
        async (_ctx, opts, _state, model) => {
          seenSummaryCalls.push({ modelId: model.id, maxTokens: opts?.maxTokens, reasoning: opts?.reasoning })
          return fauxAssistantMessage('summary from faux-2')
        },
      ])

      await kernel.compactConversation(1)
      await waitFor(
        () => seenSummaryCalls.length === 1 && kernel.getConversation(1).contextUsage?.compacting === undefined,
        20_000,
      )
      assert.equal(seenSummaryCalls[0]?.modelId, 'faux-2', 'compaction must use configured compactionModel')
      assert.equal(seenSummaryCalls[0]?.reasoning, undefined, 'non-reasoning compaction model must not receive reasoning option')
      assert.ok((seenSummaryCalls[0]?.maxTokens ?? 0) <= 2_048, 'maxTokens must be clamped to compaction model limit')

      // Restart and verify compactionModel persisted in config.json.
      await kernel.close()
      const reloaded = makeFauxModels({
        models: [
          { id: 'faux-1', reasoning: true, maxTokens: 16_384, contextWindow: 128_000 },
          { id: 'faux-2', reasoning: false, maxTokens: 2_048, contextWindow: 128_000 },
        ],
      })
      kernel = await KernelRuntime.open({
        dataDir: dir,
        cwd: dir,
        model: 'faux/faux-1',
        models: reloaded.models,
        externalSkillRoots: [],
      })
      assert.equal((await kernel.listModels()).defaultCompactionModel, 'faux/faux-2')

      // Disabling the configured compactionModel must fail compaction explicitly instead of silently falling back.
      await kernel.setDisabledModels('faux', ['faux-2'])
      await seedLargeContext(kernel, reloaded.faux)
      const recorder = recordNotifications(kernel, 1)
      try {
        reloaded.faux.setResponses([fauxAssistantMessage('must not fall back to faux-1')])
        await kernel.compactConversation(1)
        await waitFor(
          () => recorder.notices.some((n) => n.level === 'error' && n.title === 'Context compaction failed'),
          15_000,
        )
        assert.equal(reloaded.faux.getPendingResponseCount(), 1, 'must not invoke faux-1 as a silent fallback')
      } finally {
        recorder.stop()
      }

      // Clearing compactionModel restores using the conversation's current model (faux-1).
      await kernel.setDisabledModels('faux', [])
      await kernel.setDefaultModel(undefined, undefined, '')
      assert.equal((await kernel.listModels()).defaultCompactionModel, undefined)
      const clearedCalls: string[] = []
      reloaded.faux.setResponses([
        async (_ctx, _opts, _state, model) => {
          clearedCalls.push(model.id)
          return fauxAssistantMessage('summary from current model faux-1')
        },
      ])
      await kernel.compactConversation(1)
      await waitFor(
        () => clearedCalls.length === 1 && kernel.getConversation(1).contextUsage?.compacting === undefined,
        20_000,
      )
      assert.equal(clearedCalls[0], 'faux-1', 'clearing compactionModel must revert to current conversation model')
    } finally {
      await kernel.close()
    }
  })
})
