/**
 * 手动上下文精简期间的输入排队、空跳过兑齐、失败保队、中止清理与原地重发守护集成测试。
 *
 * 覆盖（真实 KernelRuntime + SQLite + fauxProvider 门闩控时）：
 * 1. 手动精简期间 submitInput（steer / followUp）进入 pi.inbox 排队（live.queuedInputs 可见）；
 *    whenBusy='reject' 报 409 conversation_busy；精简落盘摘要后 pi.compaction 先于
 *    helm.input 落库，且助手基于精简后的摘要上下文回答；
 * 2. 手动精简期间 withdrawQueuedInput 干净撤回排队输入；
 * 3. 手动精简期间 abortConversation 中止精简任务、撤回排队输入且不误报「当前上下文无需精简」；
 * 4. 空跳过手动精简（短上下文 < 20000 tokens 与 beforeCompact decline 门闩双覆盖）：
 *    发出「当前上下文无需精简」info 通知；期间排队输入通过 continue 自动接续并获助手回答；
 * 5. 手动精简失败且存在排队输入：发出「上下文精简失败」error 通知，不运行未精简上下文的
 *    排队输入，且 queuedInputs 保持完整；
 * 6. 手动精简期间 replaceFromEntryId 原地覆盖重发：中止精简任务并成功重写提交，不报 409。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { CompactionTask, defineExtension, hook } from '@earendil-works/pi-durable'
import type { ConversationLive, HelmEventFrame } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface CapturedNotice {
  level: string
  title: string
  body?: string
  conversationId?: number
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 15))
  }
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

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-compact-queue-'))
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function openRuntime(name: string): Promise<{
    kernel: KernelRuntime
    faux: FauxHandle
    dir: string
  }> {
    const dir = join(root, name)
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
      externalSkillRoots: [],
    })
    return { kernel, faux, dir }
  }

  /** 构造超过 keepRecentTokens(20000) 的大上下文（3 轮对话），使手动压缩产生真实摘要。 */
  async function seedLargeContext(kernel: KernelRuntime, faux: FauxHandle): Promise<void> {
    const bigInput = '大规模上下文历史素材。'.repeat(5_000)
    faux.setResponses([
      fauxAssistantMessage('大历史答一'),
      fauxAssistantMessage('大历史答二'),
      fauxAssistantMessage('大历史答三'),
    ])
    for (const marker of ['第一轮独特标记', '第二轮独特标记', '第三轮独特标记']) {
      await kernel.submitInput(1, `${marker}：${bigInput}`)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
  }

  it('手动精简期间 steer/followUp 入队、reject 报 409；摘要落盘后 pi.compaction 先于 helm.input 且助手运行于精简后上下文', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('这是精简后的历史摘要内容')
        },
        async (ctx) => {
          seenAssistantPrompts.push(ctx.messages.map((m) => extractText(m.content)))
          return fauxAssistantMessage('基于精简摘要的回答')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      // whenBusy='reject' 在精简期间必须明确 409 拒绝，不得静默入队或启动新 run。
      await assert.rejects(
        () => kernel.submitInput(1, '精简期间被拒绝的输入', { whenBusy: 'reject' }),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_busy' && err.status === 409,
      )

      // 精简期间提交 followUp 与 steer，必须进入 pi.inbox 排队并反映在 live.queuedInputs。
      const subFu = await kernel.submitInput(1, '精简后补充问题 followUp', { whenBusy: 'followUp' })
      const subSt = await kernel.submitInput(1, '精简后插话指令 steer', { whenBusy: 'steer' })
      assert.ok(Number(subFu.submissionId) > 0)
      assert.ok(Number(subSt.submissionId) > 0)

      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 2, 10_000)
      const queued = findLive(kernel, 1)!.queuedInputs!
      assert.deepEqual(
        queued.map((q) => ({ text: q.text, mode: q.mode })),
        [
          { text: '精简后插话指令 steer', mode: 'steer' },
          { text: '精简后补充问题 followUp', mode: 'followUp' },
        ],
      )

      // 精简未完成前，两条排队输入均不得提前落库或触发模型请求。
      const midDetail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(midDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        midDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '精简后补充问题 followUp',
        ),
        false,
      )

      // 释放摘要门闩：摘要落盘并接续排队输入启动助手回合。
      releaseSummary()
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 15_000)

      const finalDetail = await kernel.getConversationDetail(1, { limit: 100 })
      const compactionIdx = finalDetail.entries.findIndex((e) => e.kind === 'pi.compaction')
      const steerIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '精简后插话指令 steer',
      )
      const followUpIdx = finalDetail.entries.findIndex(
        (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '精简后补充问题 followUp',
      )
      assert.ok(compactionIdx >= 0, 'pi.compaction 条目必须落库')
      assert.ok(steerIdx > compactionIdx, 'pi.compaction 必须先于排队的 steer helm.input 落库')
      assert.ok(followUpIdx > compactionIdx, 'pi.compaction 必须先于排队的 followUp helm.input 落库')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('基于精简摘要的回答'),
        ),
        '助手必须针对精简期间排队的输入完成回复',
      )
      assert.equal(seenAssistantPrompts.length, 1, '助手只应运行一次（合并消费排队输入）')
      const joinedPrompt = seenAssistantPrompts[0]!.join('\n')
      assert.ok(joinedPrompt.includes('这是精简后的历史摘要内容'), '助手请求必须携带精简摘要')
      assert.equal(joinedPrompt.includes('第一轮独特标记'), false, '已被精简压缩的早期历史不得再注入助手上下文')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('手动精简期间 withdrawQueuedInput 干净撤回排队输入', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('精简摘要')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      const { submissionId } = await kernel.submitInput(1, '精简期间待撤回输入', { whenBusy: 'followUp' })
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
      assert.ok(detail.entries.some((e) => e.kind === 'pi.compaction'), '压缩应正常完成')
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '精简期间待撤回输入',
        ),
        false,
        '已撤回输入不得落库执行',
      )
      assert.equal(faux.state.callCount, 4, '不应多出助手回答的模型调用（3 轮造历史 + 1 次摘要）')
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('手动精简期间 abortConversation 中止精简、撤回排队输入且不误发「当前上下文无需精简」', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('不应该完成')
        },
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await kernel.submitInput(1, '中止时一并撤回的输入', { whenBusy: 'steer' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      await kernel.abortConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await waitFor(() => {
        const live = findLive(kernel, 1)
        return live === undefined || (live.queuedInputs?.length ?? 0) === 0
      }, 10_000)
      await new Promise((r) => setTimeout(r, 80))

      assert.equal(
        recorder.notices.some((n) => n.title === '当前上下文无需精简'),
        false,
        '被中止的精简绝不得误发「当前上下文无需精简」',
      )
      assert.equal(
        recorder.notices.some((n) => n.title === '上下文精简失败'),
        false,
        '主动中止不应产生失败通知',
      )
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '中止时一并撤回的输入',
        ),
        false,
      )
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('空跳过手动精简（< 20000 tokens）发出「当前上下文无需精简」通知；门闩期间排队输入通过 continue 自动回复', { timeout: 60_000 }, async () => {
    // 4a. 真实短上下文（< 20000 tokens）：selectCut === undefined 跳过，发 info 通知
    {
      const { kernel, faux } = await openRuntime('empty-skip-short')
      const recorder = recordNotifications(kernel, 1)
      try {
        faux.setResponses([fauxAssistantMessage('短对话回答')])
        await kernel.submitInput(1, '短问题')
        await kernel.waitForIdle(1)

        await kernel.compactConversation(1)
        await waitFor(() => recorder.notices.some((n) => n.title === '当前上下文无需精简'), 10_000)
        const notice = recorder.notices.find((n) => n.title === '当前上下文无需精简')!
        assert.equal(notice.level, 'info')
        assert.equal(notice.conversationId, 1)
        assert.match(notice.body ?? '', /未生成新的摘要/)
      } finally {
        recorder.stop()
        await kernel.close()
      }
    }

    // 4b. 门闩控时（beforeCompact decline -> 与 selectCut===undefined 同走 complete() 无摘要分支）：
    //     精简进行中排队输入 -> 空跳过结束后自动 continue 并获助手回答。
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

        faux.setResponses([fauxAssistantMessage('空跳过后自动继续的回答')])
        await kernel.compactConversation(1)
        await enteredPromise
        await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 10_000)

        await kernel.submitInput(1, '空跳过精简期间排队的提问', { whenBusy: 'followUp' })
        await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

        releaseHook()

        await waitFor(() => recorder.notices.some((n) => n.title === '当前上下文无需精简'), 15_000)
        await kernel.waitForIdle(1)
        await waitFor(() => {
          const live = findLive(kernel, 1)
          return live === undefined || (live.queuedInputs?.length ?? 0) === 0
        }, 15_000)

        const detail = await kernel.getConversationDetail(1, { limit: 100 })
        assert.equal(detail.entries.some((e) => e.kind === 'pi.compaction'), false, '空跳过不应写入 pi.compaction')
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '空跳过精简期间排队的提问',
          ),
          '排队输入应通过 continue 落库执行',
        )
        assert.ok(
          detail.entries.some(
            (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('空跳过后自动继续的回答'),
          ),
          '助手必须完成对排队输入的回复',
        )
      } finally {
        recorder.stop()
        releaseHook()
        await kernel.close()
      }
    }
  })

  it('手动精简失败且存在排队输入：发「上下文精简失败」error 通知、不运行排队输入且保留 queuedInputs', { timeout: 60_000 }, async () => {
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
          return fauxAssistantMessage('摘要失败', { stopReason: 'error', errorMessage: 'mock compact error' })
        },
        fauxAssistantMessage('不该被执行到的回答'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise

      await kernel.submitInput(1, '失败后应保留在队列的输入', { whenBusy: 'followUp' })
      await waitFor(() => (findLive(kernel, 1)?.queuedInputs?.length ?? 0) === 1, 10_000)

      releaseSummary()
      await waitFor(() => recorder.notices.some((n) => n.title === '上下文精简失败'), 15_000)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === undefined, 15_000)
      await new Promise((r) => setTimeout(r, 80))

      const failNotice = recorder.notices.find((n) => n.title === '上下文精简失败')!
      assert.equal(failNotice.level, 'error')
      assert.match(failNotice.body ?? '', /mock compact error/)
      assert.equal(
        recorder.notices.some((n) => n.title === '当前上下文无需精简'),
        false,
        '精简失败不得发出无需精简通知',
      )

      const live = findLive(kernel, 1)
      assert.equal(live?.queuedInputs?.length, 1, '排队输入必须完好保留在 queuedInputs 中')
      assert.equal(live?.queuedInputs?.[0]?.text, '失败后应保留在队列的输入')

      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      assert.equal(
        detail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '失败后应保留在队列的输入',
        ),
        false,
        '失败后不得在未精简上下文上擅自运行排队输入',
      )
      assert.equal(faux.state.callCount, 4, '不得多出助手调用（3 轮造历史 + 1 次失败摘要）')
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })

  it('手动精简期间 replaceFromEntryId 原地覆盖重发：中止精简任务并成功重写提交（不报 409）', { timeout: 60_000 }, async () => {
    const { kernel, faux } = await openRuntime('rewind-during-compact')
    let releaseSummary = () => {}
    const recorder = recordNotifications(kernel, 1)
    try {
      await seedLargeContext(kernel, faux)

      const preDetail = await kernel.getConversationDetail(1, { limit: 50 })
      const lastHumanEntry = [...preDetail.entries].reverse().find((e) => e.kind === 'helm.input')
      assert.ok(lastHumanEntry, '必须存在可原地编辑的 helm.input 条目')
      const targetEntryId = Number(lastHumanEntry!.id)

      let summaryEntered!: () => void
      const enteredPromise = new Promise<void>((resolve) => { summaryEntered = resolve })
      const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
      faux.setResponses([
        async (_ctx, opts) => {
          summaryEntered()
          await waitForGateOrAbort(summaryGate, opts?.signal)
          return fauxAssistantMessage('不应该完成')
        },
        fauxAssistantMessage('原地覆盖重发后的新回答'),
      ])

      await kernel.compactConversation(1)
      await enteredPromise
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 15_000)

      await kernel.submitInput(1, '精简期间原地覆盖的新问题', { replaceFromEntryId: targetEntryId })
      await kernel.waitForIdle(1)
      await new Promise((r) => setTimeout(r, 80))

      const finalDetail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(finalDetail.entries.some((e) => e.kind === 'helm.rewind'), '必须写入 helm.rewind 截断标记')
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'helm.input' && (e.data as { text?: string } | undefined)?.text === '精简期间原地覆盖的新问题',
        ),
        '必须落库覆盖后的新输入',
      )
      assert.ok(
        finalDetail.entries.some(
          (e) => e.kind === 'pi.assistant' && extractText(e.model?.[0] && (e.model[0] as { content?: unknown }).content).includes('原地覆盖重发后的新回答'),
        ),
        '必须获得重发后的新回答',
      )
      assert.equal(finalDetail.entries.some((e) => e.kind === 'pi.compaction'), false)
      assert.equal(
        recorder.notices.some((n) => n.title === '当前上下文无需精简'),
        false,
        '被 rewind 中止的精简不得误报无需精简',
      )
    } finally {
      recorder.stop()
      releaseSummary()
      await kernel.close()
    }
  })
})
