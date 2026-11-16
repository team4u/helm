/**
 * original ground override heavy (replaceFromEntryId) atomicity regression test (real pi-durable SDK):
 * - single transaction commit: same batch event also contains rewind and new input, without half into product rewind;
 * - concurrency two time edit the same entry: at most once succeeded, another time 409;
 * - input hook block intercept: keep old question answer (do not rewind);
 * - non- human / non- helm.input target reject (400/409);
 * - page throw shadow:marker slide out one page after old record does not resurrect (load all page still excludes old content),
 *   also SDK raw entries verify history still save;
 * - FTS rebuild exclude old record and keep same transaction new input;
 * - new answer on failure getLastAssistantText do not return by override answer proposal;
 * - faux factory catch real provider TranscriptContext, verify excludes by override old question answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { openHubTestEnv, type FauxProviderHandle, type HubTestApp } from './helpers/hub-test-env.js'

interface Env {
  dataDir: string
  faux: FauxProviderHandle
  app: HubTestApp
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const env = await openHubTestEnv({ prefix: 'helm-rewind-atomic-', swallowCloseError: true })
  return {
    dataDir: env.dataDir,
    faux: env.faux,
    app: env.app,
    close: env.close,
  }
}

function harnessOf(env: Env): Harness {
  return (env.app.kernel as unknown as { harness: Harness }).harness
}

function messageTexts(messages: ReadonlyArray<{ role: string; content: unknown }>): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string; text?: string }>) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out
}

interface TurnEntry {
  id: number
  kind: string
  text: string
  data?: unknown
}

/** conversation all amount item summary (SDK raw entries; verify history still save). */
async function entrySummaries(env: Env, convId: number): Promise<TurnEntry[]> {
  const conv = await harnessOf(env).conversation(convId as never, BACKGROUND_CONTEXT)
  assert.ok(conv)
  const out: TurnEntry[] = []
  let cursor: unknown = undefined
  for (;;) {
    const page = await conv.entries({ order: 'ascending' }, 100, cursor as never, BACKGROUND_CONTEXT)
    for (const raw of page.items as never as Array<{ id: number; kind: string; model?: unknown[]; data?: unknown }>) {
      let text = ''
      const model = raw.model as Array<{ content?: unknown }> | undefined
      const content = model?.[0]?.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = (content as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
      }
      if (raw.kind === 'helm.input') {
        const data = raw.data as { text?: unknown } | undefined
        if (typeof data?.text === 'string') text = data.text
      }
      out.push({ id: Number(raw.id), kind: raw.kind, text, data: raw.data })
    }
    if (!page.next) break
    cursor = page.next
  }
  return out
}

async function askTurn(env: Env, convId: number, text: string): Promise<void> {
  await env.app.kernel.submitInput(convId, text)
  await env.app.kernel.waitForIdle(convId)
}

test('atomic transaction: same batch commit event contains rewind and new input;SDK raw history still save;provider context excludes old question answer', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // finally once faux response use work vendor function catch real TranscriptContext.
    const contexts: TranscriptContext[] = []
    env.faux.setResponses([
      fauxAssistantMessage('one round answer'),
      fauxAssistantMessage('second round old answer'),
      (async (ctx: TranscriptContext) => {
        contexts.push(ctx)
        return fauxAssistantMessage('heavy after new answer')
      }) as never,
    ])
    const conv = await env.app.kernel.createConversation({ title: 'atomic heavy' })
    await askTurn(env, conv.id, 'one round issue')
    await askTurn(env, conv.id, 'second round old issue')

    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'second round old issue')
    assert.ok(secondInput, 'should store in second round helm.input')

    // observe same batch commit event:rewind and new input should in the same batch entry written to the database in.
    const { submissionId } = await env.app.kernel.submitInput(conv.id, 'change write after new issue', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // 1) rewind mark record carry closed zone between contract (fromEntryId/throughEntryId/omittedInputIds).
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, 'should store in helm.rewind mark record')
    const rewindData = rewind.data as {
      fromEntryId: number
      throughEntryId: number
      omittedEntryIds: number[]
      omittedInputIds: string[]
    }
    assert.equal(rewindData.fromEntryId, secondInput.id)
    assert.ok(rewindData.throughEntryId >= secondInput.id, 'throughEntryId override target')
    // new input item ID must > throughEntryId(do not by self household zone between mistakenly delete).
    const newInput = after.find((e) => e.kind === 'helm.input' && e.text === 'change write after new issue')
    assert.ok(newInput, 'new input should written to the database')
    assert.ok(Number(newInput.id) > rewindData.throughEntryId, 'new input ID high at override zone between on boundary')
    // omittedInputIds collect by override person class input request id.
    assert.ok(
      rewindData.omittedInputIds.some((id) => id.length > 0),
      'omittedInputIds should contain by override input request id',
    )

    // 2) SDK raw entries: old question answer still thing save (logic hide while non- delete).
    assert.ok(
      after.some((e) => e.kind === 'helm.input' && e.text === 'second round old issue'),
      'SDK raw entries should still save old mention question (logic hide)',
    )
    assert.ok(
      after.some((e) => e.kind === 'pi.assistant' && e.text === 'second round old answer'),
      'SDK raw entries should still save old answer',
    )

    // 3) detail situation throw shadow: old content hide, new content appear, one round keep.
    const detail = await env.app.kernel.getConversationDetail(conv.id, { limit: 200 })
    const detailTexts = detail.entries
      .map((e) => {
        const dataText = (e.data as { text?: unknown } | undefined)?.text
        if (typeof dataText === 'string' && e.kind === 'helm.input') return dataText
        const model = e.model as Array<{ content?: unknown }> | undefined
        const content = model?.[0]?.content
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
          return (content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('\n')
        }
        return ''
      })
      .filter((t) => t !== '')
    assert.ok(!detailTexts.some((t) => t === 'second round old issue'), `old mention question should by throw shadow hide:${JSON.stringify(detailTexts)}`)
    assert.ok(!detailTexts.some((t) => t === 'second round old answer'), 'old answer should by throw shadow hide')
    assert.ok(detailTexts.some((t) => t.includes('one round issue')), 'one round keep')
    assert.ok(detailTexts.some((t) => t.includes('change write after new issue')), 'new mention question appear')
    assert.ok(detailTexts.some((t) => t.includes('heavy after new answer')), 'new answer appear')

    // 4) real provider TranscriptContext: model request excludes by override old question answer.
    assert.equal(contexts.length, 1, 'work vendor function should catch once provider invoke')
    const providerTexts = messageTexts(contexts[0]!.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(
      !providerTexts.some((t) => t.includes('second round old issue')),
      `provider context must not contains old mention question:${JSON.stringify(providerTexts)}`,
    )
    assert.ok(
      !providerTexts.some((t) => t.includes('second round old answer')),
      'provider context must not contains old answer',
    )
    assert.ok(providerTexts.some((t) => t.includes('change write after new issue')), 'provider context contains new mention question')
    assert.ok(providerTexts.some((t) => t.includes('one round issue')), 'provider context keep one round')
  } finally {
    await env.close()
  }
})

test('concurrency two time edit the same entry: at most once succeeded, another time 409, without half into product rewind', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('concurrency old answer'),
      fauxAssistantMessage('concurrency new answer A'),
      fauxAssistantMessage('concurrency new answer B'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'concurrency heavy' })
    await askTurn(env, conv.id, 'concurrency old issue')
    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === 'concurrency old issue')
    assert.ok(target)

    // the same tick concurrency two time edit: two transaction all read the same tail part, after rewind zone between
    // core verify (first already by override) or submit conflict must failed.
    const [a, b] = await Promise.allSettled([
      env.app.kernel.submitInput(conv.id, 'concurrency new issue A', { replaceFromEntryId: target.id }),
      env.app.kernel.submitInput(conv.id, 'concurrency new issue B', { replaceFromEntryId: target.id }),
    ])
    const settled = [a, b]
    const fulfilled = settled.filter((r) => r.status === 'fulfilled')
    const rejected = settled.filter((r) => r.status === 'rejected')
    assert.ok(fulfilled.length >= 1, 'at least once succeeded')
    assert.ok(rejected.length >= 1, 'at least once 409 reject')
    for (const r of rejected) {
      const err = r.reason as HelmError
      assert.ok(
        err instanceof HelmError && (err.status === 409 || err.status === 404),
        `reject should be 409/404(actual ${String(err?.status)} ${String(err?.code)})`,
      )
    }
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // without half into product rewind: succeeded zone between complete, and succeeded new input still visible.
    const after = await entrySummaries(env, conv.id)
    const rewinss = after.filter((e) => e.kind === 'helm.rewind')
    assert.ok(rewinss.length <= 2, 'rewind mark record amount subject to control')
    for (const marker of rewinss) {
      const data = marker.data as { fromEntryId: number; throughEntryId: number; omittedEntryIds: number[] }
      assert.ok(Number.isSafeInteger(data.throughEntryId), 'rewind carry throughEntryId')
      assert.ok(data.throughEntryId >= data.fromEntryId, 'override zone between legal')
    }
    const winnerText = fulfilled.length === 1
      ? (fulfilled[0] as PromiseFulfilledResult<{ submissionId: string }>).value
      : undefined
    assert.ok(winnerText !== undefined || fulfilled.length === 1, 'succeeded return submissionId')
  } finally {
    await env.close()
  }
})

test('stale edit in input hook suspended after restore: reject when must not abort already succeeded edit new turn', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let releaseHook!: () => void
  let enteredHook!: () => void
  let releaseModel!: () => void
  let startedModel!: () => void
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
  const hookEntered = new Promise<void>((resolve) => { enteredHook = resolve })
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
  const modelStarted = new Promise<void>((resolve) => { startedModel = resolve })
  try {
    const kernel = env.app.kernel
    env.faux.setResponses([
      fauxAssistantMessage('old answer'),
      async () => {
        startedModel()
        await modelGate
        return fauxAssistantMessage('succeeded edit answer')
      },
    ])
    const conv = await kernel.createConversation({ title: 'latency edit race' })
    await askTurn(env, conv.id, 'old issue')
    const target = (await entrySummaries(env, conv.id)).find((entry) => entry.kind === 'helm.input')!
    await kernel.plugins.register({
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
    const stale = kernel.submitInput(conv.id, 'stale edit', { replaceFromEntryId: target.id })
      .then(() => undefined, (error: unknown) => error)
    await hookEntered
    const accepted = await kernel.submitInput(conv.id, 'succeeded edit', { replaceFromEntryId: target.id })
    await modelStarted
    releaseHook()
    const error = await stale
    assert.ok(error instanceof HelmError && error.status === 409)
    assert.equal(kernel.getConversation(conv.id).status, 'working', 'stale edit cannot abort succeeded')
    releaseModel()
    await kernel.waitForIdle(conv.id)
    assert.equal((await kernel.waitForInput(conv.id, accepted.submissionId)).text, 'succeeded edit answer')
  } finally {
    releaseHook()
    releaseModel()
    await env.close()
  }
})

test('input hook block intercept: old question answer keep (without rewind side effect)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // via kernel plugin host hang a take over type input hook: for take over text produces no real turn
    //(input hook semantics:handled take over;AGENTS.md in block belong tool_call).
    let armed = true
    await env.app.kernel.plugins.register({
      id: 'test:input-block',
      definePlugin(ctx) {
        ctx.hook.onInput((payload: { input: { text: string } }) => {
          if (armed && payload.input.text === 'by block intercept edit') {
            return { action: 'handled', result: 'test take over' }
          }
          return undefined
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('block intercept before answer')])
    const conv = await env.app.kernel.createConversation({ title: 'hook block intercept' })
    await askTurn(env, conv.id, 'block intercept before issue')

    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === 'block intercept before issue')
    assert.ok(target)

    // take over: produces no rewind, old question answer completely well, without real turn commit.
    const handled = await env.app.kernel.submitInput(conv.id, 'by block intercept edit', {
      replaceFromEntryId: target.id,
    })
    assert.ok(handled.submissionId.startsWith('handled:'), 'take over commit return handled: prefix')
    const afterBlock = await entrySummaries(env, conv.id)
    assert.ok(!afterBlock.some((e) => e.kind === 'helm.rewind'), 'block intercept after must not has rewind')
    const ctxAfter = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsAfter = messageTexts(ctxAfter.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsAfter.some((t) => t.includes('block intercept before issue')), 'old mention question keep')
    assert.ok(textsAfter.some((t) => t.includes('block intercept before answer')), 'old answer keep')

    // solve except block intercept after the same target can normal edit.
    armed = false
    env.faux.setResponses([fauxAssistantMessage('solve except after new answer')])
    await env.app.kernel.submitInput(conv.id, 'solve except after edit', { replaceFromEntryId: target.id })
    await env.app.kernel.waitForIdle(conv.id)
    const ctxOk = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsOk = messageTexts(ctxOk.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsOk.some((t) => t.includes('solve except after edit')), 'solve except after edit takes effect')
    assert.ok(!textsOk.some((t) => t.includes('block intercept before answer')), 'old answer by override')
  } finally {
    await env.close()
  }
})

test('non- human / non- helm.input target reject:assistant 400;agent/trigger source 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('target decide old answer')])
    const conv = await env.app.kernel.createConversation({ title: 'target decide' })
    // agent source input.
    await env.app.kernel.submitInput(conv.id, 'agent source issue', { origin: 'agent' })
    await env.app.kernel.waitForIdle(conv.id)
    // trigger source input.
    await env.app.kernel.submitInput(conv.id, 'trigger source issue', { origin: 'trigger' })
    await env.app.kernel.waitForIdle(conv.id)
    // human source input.
    await askTurn(env, conv.id, 'human source issue')

    const entries = await entrySummaries(env, conv.id)
    const agentInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'agent source issue')
    const triggerInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'trigger source issue')
    const assistant = entries.find((e) => e.kind === 'pi.assistant')
    assert.ok(agentInput && triggerInput && assistant)

    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: assistant.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 400)
        assert.equal(err.code, 'entry_not_editable')
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: agentInput.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 409)
        assert.equal(err.code, 'entry_not_editable')
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'x', { replaceFromEntryId: triggerInput.id }),
      (err: unknown) => err instanceof HelmError && err.status === 409 && err.code === 'entry_not_editable',
    )
  } finally {
    await env.close()
  }
})

test('page throw shadow: small limit across page and marker slide out one page, load all page still excludes old content', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('page one round answer'),
      fauxAssistantMessage('page second round old answer'),
      fauxAssistantMessage('page new answer'),
      fauxAssistantMessage('page after continue answer'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'page throw shadow' })
    await askTurn(env, conv.id, 'page one round issue')
    await askTurn(env, conv.id, 'page second round old issue')

    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'page second round old issue')
    assert.ok(secondInput)
    await env.app.kernel.submitInput(conv.id, 'page new issue', { replaceFromEntryId: secondInput.id })
    await env.app.kernel.waitForIdle(conv.id)
    // rewind after again patch one round normal dialog, marker push obtain leave tail part more far (slide out small page).
    await askTurn(env, conv.id, 'page after continue issue')

    // limit=2 one by one page load until exhausted.
    const seenTexts: string[] = []
    let cursor: string | undefined = undefined
    let pages = 0
    for (;;) {
      const page = await env.app.kernel.getConversationDetail(conv.id, {
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      pages += 1
      for (const e of page.entries) {
        if (e.kind === 'helm.input') {
          const dataText = (e.data as { text?: unknown } | undefined)?.text
          if (typeof dataText === 'string') seenTexts.push(dataText)
        } else if (e.kind === 'pi.assistant') {
          const model = e.model as Array<{ content?: unknown }> | undefined
          const content = model?.[0]?.content
          if (typeof content === 'string') seenTexts.push(content)
          else if (Array.isArray(content)) {
            const t = (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (t !== '') seenTexts.push(t)
          }
        }
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
      assert.ok(pages < 50, 'page must not infinite loop')
    }
    assert.ok(pages >= 2, 'at least across two page')
    // all page load completely: by override old content never re-.
    assert.ok(
      !seenTexts.some((t) => t === 'page second round old issue'),
      `all page must not contains by override old mention question:${JSON.stringify(seenTexts)}`,
    )
    assert.ok(
      !seenTexts.some((t) => t === 'page second round old answer'),
      'all page must not contains by override old answer',
    )
    // valid content all in manual (new question answer and before after round keep).
    assert.ok(seenTexts.some((t) => t.includes('page one round issue')), 'one round visible')
    assert.ok(seenTexts.some((t) => t.includes('page new issue')), 'new mention question visible')
    assert.ok(seenTexts.some((t) => t.includes('page after continue issue')), 'after continue round visible')
  } finally {
    await env.close()
  }
})

test('FTS: atomic transaction new input immediately can inspect index;rebuildFts exclude old record and keep new content', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('ftsa one round answer'),
      fauxAssistantMessage('ftsb old answer body text'),
      fauxAssistantMessage('ftsc new answer body text'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'FTS heavy' })
    await askTurn(env, conv.id, 'ftsq1 one round mention question')
    await askTurn(env, conv.id, 'ftsq2 old mention question body text')
    const entries = await entrySummaries(env, conv.id)
    const second = entries.find((e) => e.kind === 'helm.input' && e.text === 'ftsq2 old mention question body text')
    assert.ok(second)
    await env.app.kernel.submitInput(conv.id, 'ftsq3 solely has new mention question', { replaceFromEntryId: second.id })
    await env.app.kernel.waitForIdle(conv.id)

    // atomic transaction new input index (observe path indexFts onInputCommitted).
    const newHit = await env.app.kernel.search('ftsq3')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), 'new mention question should hit FTS')
    // old content no longer hit (unique token, avoid prefix mistakenly hit other item).
    const oldQ = await env.app.kernel.search('ftsq2')
    assert.equal(oldQ.filter((h) => h.conversationId === conv.id).length, 0, 'old mention question do not hit')
    const oldA = await env.app.kernel.search('ftsb')
    assert.equal(oldA.filter((h) => h.conversationId === conv.id).length, 0, 'old answer do not hit')

    // rebuildFts after: old content still do not hit, new content keep.
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('ftsb')
    assert.equal(rebuiltOld.filter((h) => h.conversationId === conv.id).length, 0, 'rebuild after old answer do not hit')
    const rebuiltNew = await env.app.kernel.search('ftsq3')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'rebuild after new mention question keep')
    const rebuiltNewA = await env.app.kernel.search('ftsc')
    assert.ok(rebuiltNewA.some((h) => h.conversationId === conv.id), 'rebuild after new answer keep')
  } finally {
    await env.close()
  }
})

test('new answer failed:getLastAssistantText do not return by override answer proposal', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('failed before one round answer'),
      fauxAssistantMessage('by override old answer'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'failed cache' })
    await askTurn(env, conv.id, 'failed before one round issue')
    await askTurn(env, conv.id, 'by override issue')

    const before = await env.app.kernel.getLastAssistantText(conv.id)
    assert.equal(before, 'by override old answer')

    const entries = await entrySummaries(env, conv.id)
    const target = entries.find((e) => e.kind === 'helm.input' && e.text === 'by override issue')
    assert.ok(target)

    // new answer inject failed:faux work vendor throws (faux.setResponses empty → fails path).
    env.faux.setResponses([
      (async () => {
        throw new Error('faux model inject failed')
      }) as never,
    ])
    await env.app.kernel.submitInput(conv.id, 'note set failed edit', { replaceFromEntryId: target.id })
    // wait for turn compute (failed also is terminal state).
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // cache already by rewind expires: do not return by override old answer proposal.
    const after = await env.app.kernel.getLastAssistantText(conv.id)
    assert.notEqual(after, 'by override old answer', 'must not return by override old answer proposal')
  } finally {
    await env.close()
  }
})
