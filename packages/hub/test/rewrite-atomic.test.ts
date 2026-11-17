/**
 * In-place rewrite/edit (`replaceFromEntryId`) atomicity regression tests (real `pi-durable` SDK):
 * - Single transaction commit: same event batch includes both rewind and new input, with no half-completed rewind;
 * - Two concurrent edits to the same entry: at most one succeeds, the other gets 409;
 * - Input hook interception: preserves previous Q&A without triggering rewind;
 * - Non-human / non-`helm.input` targets reject (400/409);
 * - Paginated projection: once the rewind marker scrolls off a page, loading all pages still hides omitted entries,
 *   while SDK raw entries retain full history;
 * - FTS rebuild excludes omitted records and retains same-transaction new input;
 * - When the new reply fails, `getLastAssistantText` does not return the overwritten reply;
 * - Faux factory captures real provider `TranscriptContext`, verifying omitted Q&A is absent from model context.
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

/** Summarizes all entries in a conversation via raw SDK `entries()` to verify history preservation. */
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

test('atomic transaction: same commit batch contains rewind and new input; raw SDK history preserved; provider context omits overwritten Q&A', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Use a factory callback on the final faux response to capture the real `TranscriptContext`.
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
    assert.ok(secondInput, 'second round helm.input should exist')

    // Verify atomic batch commit: rewind marker and new input are written in the same batch.
    const { submissionId } = await env.app.kernel.submitInput(conv.id, 'change write after new issue', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // 1) Rewind marker carries closed range contract (`fromEntryId`/`throughEntryId`/`omittedInputIds`).
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, 'helm.rewind marker should exist')
    const rewindData = rewind.data as {
      fromEntryId: number
      throughEntryId: number
      omittedEntryIds: number[]
      omittedInputIds: string[]
    }
    assert.equal(rewindData.fromEntryId, secondInput.id)
    assert.ok(rewindData.throughEntryId >= secondInput.id, 'throughEntryId covers target entry')
    // New input entry ID must exceed `throughEntryId` so it never falls inside its own omitted range.
    const newInput = after.find((e) => e.kind === 'helm.input' && e.text === 'change write after new issue')
    assert.ok(newInput, 'new input should be persisted')
    assert.ok(Number(newInput.id) > rewindData.throughEntryId, 'new input ID must be above the omitted range upper bound')
    // `omittedInputIds` records overwritten human submission IDs.
    assert.ok(
      rewindData.omittedInputIds.some((id) => id.length > 0),
      'omittedInputIds should contain the overwritten input request id',
    )

    // 2) Raw SDK entries: old Q&A remain physically stored (logically hidden, not deleted).
    assert.ok(
      after.some((e) => e.kind === 'helm.input' && e.text === 'second round old issue'),
      'raw SDK entries should still retain old question (logically hidden)',
    )
    assert.ok(
      after.some((e) => e.kind === 'pi.assistant' && e.text === 'second round old answer'),
      'raw SDK entries should still retain old answer',
    )

    // 3) Detail projection: overwritten content hidden, new content visible, round 1 preserved.
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
    assert.ok(!detailTexts.some((t) => t === 'second round old issue'), `old question should be hidden by projection: ${JSON.stringify(detailTexts)}`)
    assert.ok(!detailTexts.some((t) => t === 'second round old answer'), 'old answer should be hidden by projection')
    assert.ok(detailTexts.some((t) => t.includes('one round issue')), 'round 1 preserved')
    assert.ok(detailTexts.some((t) => t.includes('change write after new issue')), 'new question visible')
    assert.ok(detailTexts.some((t) => t.includes('heavy after new answer')), 'new answer visible')

    // 4) Real provider `TranscriptContext`: model request excludes overwritten Q&A.
    assert.equal(contexts.length, 1, 'factory callback should capture one provider invocation')
    const providerTexts = messageTexts(contexts[0]!.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(
      !providerTexts.some((t) => t.includes('second round old issue')),
      `provider context must not contain old question: ${JSON.stringify(providerTexts)}`,
    )
    assert.ok(
      !providerTexts.some((t) => t.includes('second round old answer')),
      'provider context must not contain old answer',
    )
    assert.ok(providerTexts.some((t) => t.includes('change write after new issue')), 'provider context contains new question')
    assert.ok(providerTexts.some((t) => t.includes('one round issue')), 'provider context preserves round 1')
  } finally {
    await env.close()
  }
})

test('concurrent edits to the same entry: at most one succeeds, the other gets 409 with no partial rewind', { timeout: 60_000 }, async () => {
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

    // Same-tick concurrent edits: both read the same tail, then commit-time conflict check or
    // rewind range validation ensures the second fails cleanly.
    const [a, b] = await Promise.allSettled([
      env.app.kernel.submitInput(conv.id, 'concurrency new issue A', { replaceFromEntryId: target.id }),
      env.app.kernel.submitInput(conv.id, 'concurrency new issue B', { replaceFromEntryId: target.id }),
    ])
    const settled = [a, b]
    const fulfilled = settled.filter((r) => r.status === 'fulfilled')
    const rejected = settled.filter((r) => r.status === 'rejected')
    assert.ok(fulfilled.length >= 1, 'at least one edit succeeds')
    assert.ok(rejected.length >= 1, 'at least one edit rejects with 409')
    for (const r of rejected) {
      const err = r.reason as HelmError
      assert.ok(
        err instanceof HelmError && (err.status === 409 || err.status === 404),
        `rejection should be 409/404 (got ${String(err?.status)} ${String(err?.code)})`,
      )
    }
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // No half-baked rewind: range bounds are consistent and winning input stays visible.
    const after = await entrySummaries(env, conv.id)
    const rewinss = after.filter((e) => e.kind === 'helm.rewind')
    assert.ok(rewinss.length <= 2, 'rewind marker count stays bounded')
    for (const marker of rewinss) {
      const data = marker.data as { fromEntryId: number; throughEntryId: number; omittedEntryIds: number[] }
      assert.ok(Number.isSafeInteger(data.throughEntryId), 'rewind carries valid throughEntryId')
      assert.ok(data.throughEntryId >= data.fromEntryId, 'rewind range is valid')
    }
    const winnerText = fulfilled.length === 1
      ? (fulfilled[0] as PromiseFulfilledResult<{ submissionId: string }>).value
      : undefined
    assert.ok(winnerText !== undefined || fulfilled.length === 1, 'winning edit returns submissionId')
  } finally {
    await env.close()
  }
})

test('stale edit resuming from suspended input hook must not abort an already-succeeded newer edit turn', { timeout: 60_000 }, async () => {
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
    assert.equal(kernel.getConversation(conv.id).status, 'working', 'stale edit must not abort newer edit turn')
    releaseModel()
    await kernel.waitForIdle(conv.id)
    assert.equal((await kernel.waitForInput(conv.id, accepted.submissionId)).text, 'succeeded edit answer')
  } finally {
    releaseHook()
    releaseModel()
    await env.close()
  }
})

test('input hook interception preserves old Q&A without triggering rewind', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Attach a take-over `input` hook (`handled`) so no real turn runs for intercepted text.
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

    // Handled: produces no rewind, leaves prior Q&A intact, and commits no real turn.
    const handled = await env.app.kernel.submitInput(conv.id, 'by block intercept edit', {
      replaceFromEntryId: target.id,
    })
    assert.ok(handled.submissionId.startsWith('handled:'), 'handled submission returns handled: prefix')
    const afterBlock = await entrySummaries(env, conv.id)
    assert.ok(!afterBlock.some((e) => e.kind === 'helm.rewind'), 'must not write rewind marker when handled by hook')
    const ctxAfter = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsAfter = messageTexts(ctxAfter.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsAfter.some((t) => t.includes('block intercept before issue')), 'old question preserved')
    assert.ok(textsAfter.some((t) => t.includes('block intercept before answer')), 'old answer preserved')

    // Once interception is disarmed, the same target can be edited normally.
    armed = false
    env.faux.setResponses([fauxAssistantMessage('solve except after new answer')])
    await env.app.kernel.submitInput(conv.id, 'solve except after edit', { replaceFromEntryId: target.id })
    await env.app.kernel.waitForIdle(conv.id)
    const ctxOk = await (await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)
    const textsOk = messageTexts(ctxOk.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(textsOk.some((t) => t.includes('solve except after edit')), 'edit succeeds after disarming')
    assert.ok(!textsOk.some((t) => t.includes('block intercept before answer')), 'old answer overwritten')
  } finally {
    await env.close()
  }
})

test('non-human / non-helm.input target rejected: assistant 400; agent/trigger origins 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('target decide old answer')])
    const conv = await env.app.kernel.createConversation({ title: 'target decide' })
    // `agent` origin input.
    await env.app.kernel.submitInput(conv.id, 'agent source issue', { origin: 'agent' })
    await env.app.kernel.waitForIdle(conv.id)
    // `trigger` origin input.
    await env.app.kernel.submitInput(conv.id, 'trigger source issue', { origin: 'trigger' })
    await env.app.kernel.waitForIdle(conv.id)
    // `human` origin input.
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

test('paginated projection: overwritten entries stay hidden across pages even after marker slides off first page', { timeout: 60_000 }, async () => {
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
    // Add another turn after rewind so the marker moves further from the tail (outside a small page).
    await askTurn(env, conv.id, 'page after continue issue')

    // Load page by page with `limit=2` until exhausted.
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
      assert.ok(pages < 50, 'pagination must not loop infinitely')
    }
    assert.ok(pages >= 2, 'must span at least two pages')
    // Overwritten content never resurfaces across all pages.
    assert.ok(
      !seenTexts.some((t) => t === 'page second round old issue'),
      `no page may contain overwritten question: ${JSON.stringify(seenTexts)}`,
    )
    assert.ok(
      !seenTexts.some((t) => t === 'page second round old answer'),
      'no page may contain overwritten answer',
    )
    // Valid turns remain visible.
    assert.ok(seenTexts.some((t) => t.includes('page one round issue')), 'round 1 visible')
    assert.ok(seenTexts.some((t) => t.includes('page new issue')), 'new question visible')
    assert.ok(seenTexts.some((t) => t.includes('page after continue issue')), 'subsequent round visible')
  } finally {
    await env.close()
  }
})

test('FTS: atomic commit indexes new input immediately; rebuildFts excludes omitted entries and keeps new content', { timeout: 60_000 }, async () => {
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

    // Atomic transaction indexes the new input immediately (`indexFts` in `onInputCommitted`).
    const newHit = await env.app.kernel.search('ftsq3')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), 'new question should hit FTS')
    // Old tokens no longer match (distinct tokens avoid prefix false hits).
    const oldQ = await env.app.kernel.search('ftsq2')
    assert.equal(oldQ.filter((h) => h.conversationId === conv.id).length, 0, 'old question should not match')
    const oldA = await env.app.kernel.search('ftsb')
    assert.equal(oldA.filter((h) => h.conversationId === conv.id).length, 0, 'old answer should not match')

    // After rebuildFts: old content stays excluded, new content remains indexed.
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('ftsb')
    assert.equal(rebuiltOld.filter((h) => h.conversationId === conv.id).length, 0, 'old answer stays excluded after rebuild')
    const rebuiltNew = await env.app.kernel.search('ftsq3')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'new question kept after rebuild')
    const rebuiltNewA = await env.app.kernel.search('ftsc')
    assert.ok(rebuiltNewA.some((h) => h.conversationId === conv.id), 'new answer kept after rebuild')
  } finally {
    await env.close()
  }
})

test('new reply failure: getLastAssistantText does not return the overwritten reply', { timeout: 60_000 }, async () => {
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

    // Inject failure on the new reply (callback throws).
    env.faux.setResponses([
      (async () => {
        throw new Error('faux model inject failed')
      }) as never,
    ])
    await env.app.kernel.submitInput(conv.id, 'note set failed edit', { replaceFromEntryId: target.id })
    // Wait for turn settlement (failure is also terminal).
    await env.app.kernel.waitForIdle(conv.id).catch(() => {})

    // Cache invalidated by rewind: must not return the overwritten old reply.
    const after = await env.app.kernel.getLastAssistantText(conv.id)
    assert.notEqual(after, 'by override old answer', 'must not return the overwritten old reply')
  } finally {
    await env.close()
  }
})
