/**
 * 原地覆盖重写（replaceFromEntryId）原子性与投影回归测试（真实 pi-durable SDK，共享单实例 createHelm）：
 * - 单事务提交（rewind + 新输入同批入库）、SDK raw 历史保留、详情投影隐藏、真实 provider TranscriptContext 排除旧问答；
 * - 首轮全量截断（保留前导 system）与错误边界（404 / 非法 entryId 400 / 重复覆盖 409 entry_already_rewound / 越过 reset 409 entry_before_context_head）；
 * - 并发双改同一条目至多一次成功，无半成品 rewind；
 * - 迟到 stale 编辑在 input hook 恢复后拒绝且不中止已生效新回合；
 * - input hook handled 接管不产生 rewind 副作用，解除后正常覆盖；
 * - 非 human / 非 helm.input 目标拒绝（assistant 400；agent/trigger 409）；
 * - 小分页跨页投影（marker 滑出单页后旧记录永不重现）；
 * - FTS 即时索引与 rebuildFts 排除被覆盖旧问答；新回合失败不回退旧缓存答案。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { HelmError } from '@helm/protocol'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  messageTextsOf,
  openHubTestEnv,
  sdkEntrySummaries,
  type HubTestEnv,
} from './helpers/hub-test-env.js'

let env: HubTestEnv

before(async () => {
  env = await openHubTestEnv({ prefix: 'helm-rewind-atomic-', swallowCloseError: true })
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

function harnessOf(): Harness {
  return (env.kernel as unknown as { harness: Harness }).harness
}

async function askTurn(convId: number, text: string): Promise<void> {
  await env.kernel.submitInput(convId, text)
  await env.kernel.waitForIdle(convId)
}

test('原子事务：rewind 与新输入同批提交、SDK 原始历史保留、详情投影与真实 provider 上下文排除旧问答', { timeout: 60_000 }, async () => {
  const contexts: TranscriptContext[] = []
  env.faux.setResponses([
    fauxAssistantMessage('one round answer'),
    fauxAssistantMessage('second round old answer'),
    (async (ctx: TranscriptContext) => {
      contexts.push(ctx)
      return fauxAssistantMessage('heavy after new answer')
    }) as never,
  ])
  const conv = await env.kernel.createConversation({ title: 'atomic heavy' })
  await askTurn(conv.id, 'one round issue')
  await askTurn(conv.id, 'second round old issue')

  const secondInput = (await sdkEntrySummaries(env.kernel, conv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'second round old issue',
  )!
  const { submissionId } = await env.kernel.submitInput(conv.id, 'change write after new issue', {
    replaceFromEntryId: secondInput.id,
  })
  assert.ok(Number.isInteger(Number(submissionId)))
  await env.kernel.waitForIdle(conv.id)

  const afterEntries = await sdkEntrySummaries(env.kernel, conv.id)
  const rewind = afterEntries.find((e) => e.kind === 'helm.rewind')!
  const rewindData = rewind.data as {
    fromEntryId: number
    throughEntryId: number
    omittedEntryIds: number[]
    omittedInputIds: string[]
  }
  assert.equal(rewindData.fromEntryId, secondInput.id)
  assert.ok(rewindData.throughEntryId >= secondInput.id)
  const newInput = afterEntries.find((e) => e.kind === 'helm.input' && e.text === 'change write after new issue')!
  assert.ok(Number(newInput.id) > rewindData.throughEntryId)
  assert.ok(rewindData.omittedInputIds.some((id) => id.length > 0))
  assert.ok(afterEntries.some((e) => e.kind === 'helm.input' && e.text === 'second round old issue'))
  assert.ok(afterEntries.some((e) => e.kind === 'pi.assistant' && e.text === 'second round old answer'))

  const detail = await env.kernel.getConversationDetail(conv.id, { limit: 200 })
  const detailBlob = JSON.stringify(detail.entries)
  assert.ok(!detailBlob.includes('second round old issue') && !detailBlob.includes('second round old answer'))
  assert.ok(
    detailBlob.includes('one round issue') &&
      detailBlob.includes('change write after new issue') &&
      detailBlob.includes('heavy after new answer'),
  )

  assert.equal(contexts.length, 1)
  const providerTexts = messageTextsOf(contexts[0]!.messages as never)
  assert.ok(!providerTexts.some((t) => t.includes('second round old issue') || t.includes('second round old answer')))
  assert.ok(providerTexts.some((t) => t.includes('change write after new issue')))
  assert.ok(providerTexts.some((t) => t.includes('one round issue')))
})

test('首轮覆盖与错误边界：全量截断保留 system；404 / 非法 entryId 400 / 重复覆盖 409 / 越过 reset 409', { timeout: 60_000 }, async () => {
  env.faux.setResponses([
    fauxAssistantMessage('old one round answer'),
    fauxAssistantMessage('all new one round answer'),
  ])
  const conv = await env.kernel.createConversation({ title: 'override one round and boundaries' })
  await askTurn(conv.id, 'old one round issue')

  await assert.rejects(
    env.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: 999999 }),
    (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
  )
  await assert.rejects(
    env.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: -1 }),
    (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
  )

  const firstInput = (await sdkEntrySummaries(env.kernel, conv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'old one round issue',
  )!
  await env.kernel.submitInput(conv.id, 'all new one round issue', { replaceFromEntryId: firstInput.id })
  await env.kernel.waitForIdle(conv.id)

  const sdkConv = await harnessOf().conversation(conv.id as never, BACKGROUND_CONTEXT)
  const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
  const texts = messageTextsOf(ctx.messages as never)
  assert.ok(!texts.some((t) => t.includes('old one round issue') || t.includes('old one round answer')))
  assert.ok(texts.some((t) => t.includes('all new one round issue')) && texts.some((t) => t.includes('all new one round answer')))
  assert.equal((ctx.messages[0] as { role: string }).role, 'system')

  await assert.rejects(
    env.kernel.submitInput(conv.id, 'again heavy', { replaceFromEntryId: firstInput.id }),
    (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_already_rewound',
  )

  const activeInput = (await sdkEntrySummaries(env.kernel, conv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'all new one round issue',
  )!
  env.faux.setResponses([fauxAssistantMessage('reset after answer')])
  await env.kernel.resetConversation(conv.id, { handoff: 'reset handover' })
  await env.kernel.waitForIdle(conv.id)
  await assert.rejects(
    env.kernel.submitInput(conv.id, 'out of bounds heavy', { replaceFromEntryId: activeInput.id }),
    (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_before_context_head',
  )
})

test('并发双改同一条目：至多一次成功，另一次 409/404，无半成品 rewind', { timeout: 60_000 }, async () => {
  env.faux.setResponses([
    fauxAssistantMessage('concurrency old answer'),
    fauxAssistantMessage('concurrency new answer A'),
    fauxAssistantMessage('concurrency new answer B'),
  ])
  const conv = await env.kernel.createConversation({ title: 'concurrency heavy' })
  await askTurn(conv.id, 'concurrency old issue')
  const target = (await sdkEntrySummaries(env.kernel, conv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'concurrency old issue',
  )!

  const settled = await Promise.allSettled([
    env.kernel.submitInput(conv.id, 'concurrency new issue A', { replaceFromEntryId: target.id }),
    env.kernel.submitInput(conv.id, 'concurrency new issue B', { replaceFromEntryId: target.id }),
  ])
  assert.ok(settled.filter((r) => r.status === 'fulfilled').length >= 1)
  const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  assert.ok(rejected.length >= 1)
  for (const r of rejected) {
    assert.ok(r.reason instanceof HelmError && (r.reason.status === 409 || r.reason.status === 404))
  }
  await env.kernel.waitForIdle(conv.id).catch(() => {})

  const rewinds = (await sdkEntrySummaries(env.kernel, conv.id)).filter((e) => e.kind === 'helm.rewind')
  assert.ok(rewinds.length <= 2)
  for (const marker of rewinds) {
    const data = marker.data as { fromEntryId: number; throughEntryId: number }
    assert.ok(Number.isSafeInteger(data.throughEntryId) && data.throughEntryId >= data.fromEntryId)
  }
})

test('迟到编辑在 input hook 挂起恢复后拒绝（409），且绝不中止已生效编辑的新回合', { timeout: 60_000 }, async () => {
  let releaseHook!: () => void
  let enteredHook!: () => void
  let releaseModel!: () => void
  let startedModel!: () => void
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
  const hookEntered = new Promise<void>((resolve) => { enteredHook = resolve })
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
  const modelStarted = new Promise<void>((resolve) => { startedModel = resolve })
  await env.kernel.plugins.register({
    id: 'test:delayed-edit',
    definePlugin(ctx) {
      ctx.hook.onInput(async (payload) => {
        if (payload.input.text === 'stale edit') {
          enteredHook()
          await hookGate
        }
      })
    },
  }, { enabled: true })
  try {
    env.faux.setResponses([
      fauxAssistantMessage('old answer'),
      async () => {
        startedModel()
        await modelGate
        return fauxAssistantMessage('succeeded edit answer')
      },
    ])
    const conv = await env.kernel.createConversation({ title: 'latency edit race' })
    await askTurn(conv.id, 'old issue')
    const target = (await sdkEntrySummaries(env.kernel, conv.id)).find((entry) => entry.kind === 'helm.input')!
    const stale = env.kernel.submitInput(conv.id, 'stale edit', { replaceFromEntryId: target.id })
      .then(() => undefined, (error: unknown) => error)
    await hookEntered
    const accepted = await env.kernel.submitInput(conv.id, 'succeeded edit', { replaceFromEntryId: target.id })
    await modelStarted
    releaseHook()
    const error = await stale
    assert.ok(error instanceof HelmError && error.status === 409)
    assert.equal(env.kernel.getConversation(conv.id).status, 'working')
    releaseModel()
    await env.kernel.waitForIdle(conv.id)
    assert.equal((await env.kernel.waitForInput(conv.id, accepted.submissionId)).text, 'succeeded edit answer')
  } finally {
    releaseHook()
    releaseModel()
    await env.kernel.plugins.disable('test:delayed-edit')
  }
})

test('input hook 接管拦截不产生 rewind 副作用；非 human / 非 helm.input 目标显式拒绝', { timeout: 60_000 }, async () => {
  let armed = true
  await env.kernel.plugins.register({
    id: 'test:input-block',
    definePlugin(ctx) {
      ctx.hook.onInput((payload: { input: { text: string } }) =>
        armed && payload.input.text === 'by block intercept edit'
          ? { action: 'handled', result: 'test take over' }
          : undefined,
      )
    },
  })
  try {
    env.faux.setResponses([fauxAssistantMessage('block intercept before answer')])
    const conv = await env.kernel.createConversation({ title: 'hook block intercept' })
    await askTurn(conv.id, 'block intercept before issue')
    const target = (await sdkEntrySummaries(env.kernel, conv.id)).find(
      (e) => e.kind === 'helm.input' && e.text === 'block intercept before issue',
    )!

    const handled = await env.kernel.submitInput(conv.id, 'by block intercept edit', { replaceFromEntryId: target.id })
    assert.ok(handled.submissionId.startsWith('handled:'))
    assert.ok(!(await sdkEntrySummaries(env.kernel, conv.id)).some((e) => e.kind === 'helm.rewind'))

    armed = false
    env.faux.setResponses([fauxAssistantMessage('solve except after new answer')])
    await env.kernel.submitInput(conv.id, 'solve except after edit', { replaceFromEntryId: target.id })
    await env.kernel.waitForIdle(conv.id)
    const textsOk = messageTextsOf(
      (await (await harnessOf().conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)).messages as never,
    )
    assert.ok(textsOk.some((t) => t.includes('solve except after edit')))
    assert.ok(!textsOk.some((t) => t.includes('block intercept before answer')))
  } finally {
    await env.kernel.plugins.disable('test:input-block')
  }

  // 非 human / 非 helm.input 目标拒绝
  env.faux.setResponses([
    fauxAssistantMessage('a1'),
    fauxAssistantMessage('a2'),
    fauxAssistantMessage('a3'),
  ])
  const guardConv = await env.kernel.createConversation({ title: 'target decide' })
  await env.kernel.submitInput(guardConv.id, 'agent source issue', { origin: 'agent' })
  await env.kernel.waitForIdle(guardConv.id)
  await env.kernel.submitInput(guardConv.id, 'trigger source issue', { origin: 'trigger' })
  await env.kernel.waitForIdle(guardConv.id)
  await askTurn(guardConv.id, 'human source issue')

  const entries = await sdkEntrySummaries(env.kernel, guardConv.id)
  const agentInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'agent source issue')!
  const triggerInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'trigger source issue')!
  const assistant = entries.find((e) => e.kind === 'pi.assistant')!

  await assert.rejects(
    env.kernel.submitInput(guardConv.id, 'x', { replaceFromEntryId: assistant.id }),
    (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'entry_not_editable',
  )
  await assert.rejects(
    env.kernel.submitInput(guardConv.id, 'x', { replaceFromEntryId: agentInput.id }),
    (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_not_editable',
  )
  await assert.rejects(
    env.kernel.submitInput(guardConv.id, 'x', { replaceFromEntryId: triggerInput.id }),
    (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_not_editable',
  )
})

test('小分页投影、FTS 索引重建与新回合失败缓存失效', { timeout: 60_000 }, async () => {
  // 1. 小 limit 跨页且 marker 滑出单页后旧内容仍不复现 + FTS 即时与 rebuildFts 均排除旧记录
  env.faux.setResponses([
    fauxAssistantMessage('ftsa page one round answer'),
    fauxAssistantMessage('ftsb page second round old answer'),
    fauxAssistantMessage('ftsc page new answer'),
    fauxAssistantMessage('ftsd page after continue answer'),
  ])
  const conv = await env.kernel.createConversation({ title: 'page and FTS' })
  await askTurn(conv.id, 'ftsq1 page one round issue')
  await askTurn(conv.id, 'ftsq2 page second round old issue')

  const secondInput = (await sdkEntrySummaries(env.kernel, conv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'ftsq2 page second round old issue',
  )!
  await env.kernel.submitInput(conv.id, 'ftsq3 page new issue', { replaceFromEntryId: secondInput.id })
  await env.kernel.waitForIdle(conv.id)
  await askTurn(conv.id, 'ftsq4 page after continue issue')

  const seenBlobs: string[] = []
  let cursor: string | undefined
  let pages = 0
  for (;;) {
    const page = await env.kernel.getConversationDetail(conv.id, {
      limit: 2,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    pages += 1
    seenBlobs.push(JSON.stringify(page.entries))
    if (page.nextCursor === undefined) break
    cursor = page.nextCursor
    assert.ok(pages < 50)
  }
  assert.ok(pages >= 2)
  const allPaged = seenBlobs.join('\n')
  assert.ok(!allPaged.includes('ftsq2 page second round old issue') && !allPaged.includes('ftsb page second round old answer'))
  assert.ok(allPaged.includes('ftsq1') && allPaged.includes('ftsq3') && allPaged.includes('ftsq4'))

  assert.ok((await env.kernel.search('ftsq3')).some((h) => h.conversationId === conv.id))
  assert.equal((await env.kernel.search('ftsq2')).filter((h) => h.conversationId === conv.id).length, 0)
  assert.equal((await env.kernel.search('ftsb')).filter((h) => h.conversationId === conv.id).length, 0)

  await env.kernel.rebuildFts()
  assert.equal((await env.kernel.search('ftsb')).filter((h) => h.conversationId === conv.id).length, 0)
  assert.ok((await env.kernel.search('ftsq3')).some((h) => h.conversationId === conv.id))
  assert.ok((await env.kernel.search('ftsc')).some((h) => h.conversationId === conv.id))

  // 2. 新回答失败时 getLastAssistantText 不返回被覆盖的旧答案
  env.faux.setResponses([
    fauxAssistantMessage('failed before one round answer'),
    fauxAssistantMessage('by override old answer'),
  ])
  const failConv = await env.kernel.createConversation({ title: 'failed cache' })
  await askTurn(failConv.id, 'failed before one round issue')
  await askTurn(failConv.id, 'by override issue')
  assert.equal(await env.kernel.getLastAssistantText(failConv.id), 'by override old answer')

  const failTarget = (await sdkEntrySummaries(env.kernel, failConv.id)).find(
    (e) => e.kind === 'helm.input' && e.text === 'by override issue',
  )!
  env.faux.setResponses([
    (async () => {
      throw new Error('faux model inject failed')
    }) as never,
  ])
  await env.kernel.submitInput(failConv.id, 'note set failed edit', { replaceFromEntryId: failTarget.id })
  await env.kernel.waitForIdle(failConv.id).catch(() => {})
  assert.notEqual(await env.kernel.getLastAssistantText(failConv.id), 'by override old answer')
})
