/**
 * module four test: conversation context operation (reset / compact / fork).
 * real createHelm combine (true pi-durable SQLite + faux provider):
 * - reset:SDK original generate reset(handoff), context empty,handoff as first user message,
 *   stateChangeSeq push enter,SSE conversation.upsert broadcast;
 * - compact:SDK original generate compact(instructions) return background task ID, summary context;
 * - fork: item store in validate (missing 404),SDK fork new conversation,helm mirror register
 *   (parent chain/inherit profile/cwd/model/title(fork)), model align;
 * - HTTP/CLI end-to-end:POST /reset /compact /fork status code and error message seal.
 *
 * original ground override heavy (replaceFromEntryId) and queue up withdraw back (withdraw):
 * - replaceFromEntryId:helm.rewind truncate mark record + edits omit re- use pi-durable original generate
 *   semantics, model messages excludes by override old mention question/old answer, before lead system keep,FTS5
 *   inspect index and rebuildFts all no longer hit old content;
 * - withdraw:faux work vendor function suspended keep conversation busy, queue up followUp commit can withdraw back
 *   (status: withdrawn), queue up items from pi.inbox disappear and no longer execute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { HelmError } from '@helm/protocol'
import { startHub } from '../../kernel/src/http/index.js'
import { openHubTestEnv, type FauxProviderHandle, type HubTestApp } from './helpers/hub-test-env.js'

interface Env {
  dataDir: string
  faux: FauxProviderHandle
  app: HubTestApp
  hubUrl: string
  hubToken?: string
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const base = await openHubTestEnv({ prefix: 'helm-ctx-ops-', swallowCloseError: true })
  const hub = await startHub({ kernel: base.kernel, port: 0 })
  return {
    dataDir: base.dataDir,
    faux: base.faux,
    app: base.app,
    hubUrl: hub.url,
    async close() {
      await hub.close().catch(() => {})
      await base.close()
    },
  }
}

async function authCall(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${env.hubUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(env.hubToken !== undefined ? { authorization: `Bearer ${env.hubToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

test.before(async () => {})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test('reset: context empty,handoff enter new context,seq push enter and broadcast', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('one round answer')])
    const conv = await env.app.kernel.createConversation({ title: 'reset test' })
    await env.app.kernel.submitInput(conv.id, 'one round issue')
    await env.app.kernel.waitForIdle(conv.id)
    const before = env.app.kernel.getConversation(conv.id)
    const userTextsBefore = (await env.app.kernel.getConversationDetail(conv.id)).entries.filter(
      (e) => e.kind === 'helm.input',
    ).length
    assert.ok(userTextsBefore >= 1, 'reset before should has input item')

    const events: unknown[] = []
    const unsubscribe = (env.app.kernel.events as unknown as {
      subscribe(l: (frame: { event: { type: string } }) => void): () => void
    }).subscribe((frame) => {
      if (frame.event.type === 'conversation.upsert') events.push(frame)
    })

    const after = await env.app.kernel.resetConversation(conv.id, { handoff: 'reset after handover note' })
    await env.app.kernel.waitForIdle(conv.id)
    unsubscribe()

    assert.ok(after.stateChangeSeq > before.stateChangeSeq, 'stateChangeSeq single tune push enter')
    assert.ok(events.length > 0, 'conversation.upsert already broadcast')
    // new context with handoff user message start (pi.reset entry  model message carry handoff).
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const resetEntry = detail.entries.find((e) => e.kind === 'pi.reset')
    assert.ok(resetEntry !== undefined, 'reset after should store in pi.reset item')
    const userContent = (resetEntry.model ?? []).map(
      (m) => (m as { content?: unknown }).content,
    )
    const handoffSeen = userContent.some((c) =>
      typeof c === 'string' ? c === 'reset after handover note' : JSON.stringify(c).includes('reset after handover note'),
    )
    assert.ok(handoffSeen, 'handoff text should as new context first user message')
  } finally {
    await env.close()
  }
})

test('reset: without handoff also legal; missing conversation 404; close after 503 by combine layer guarantee', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ title: 'empty reset' })
    const summary = await env.app.kernel.resetConversation(conv.id)
    assert.equal(summary.id, conv.id)
    await assert.rejects(
      env.app.kernel.resetConversation(9999),
      (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

test('compact: return background task ID; summary task real enter SDK scheduling', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('ordinary answer one')])
    const conv = await env.app.kernel.createConversation({ title: 'compress test' })
    await env.app.kernel.submitInput(conv.id, 'one segment enough long dialog content 1')
    await env.app.kernel.waitForIdle(conv.id)

    const { taskId, conversation } = await env.app.kernel.compactConversation(conv.id, {
      instructions: 'please sudden out key decide policy',
    })
    assert.ok(Number.isInteger(taskId) && taskId > 0, 'taskId is positive integer (SDK TaskId)')
    assert.equal(conversation.id, conv.id)
    assert.ok(conversation.stateChangeSeq >= 1)
  } finally {
    await env.close()
  }
})

test('compact: missing conversation 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      env.app.kernel.compactConversation(424242),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

test('fork: from since has item fork - - mirror register (parent chain/inherit), model align, by default title', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('source conversation answer')])
    const source = await env.app.kernel.createConversation({ title: 'source conversation' })
    await env.app.kernel.submitInput(source.id, 'source conversation one question')
    await env.app.kernel.waitForIdle(source.id)
    const detail = await env.app.kernel.getConversationDetail(source.id)
    assert.ok(detail.entries.length > 0, 'source conversation should has item')
    const entryId = Number(detail.entries[0]!.id)
    assert.ok(Number.isInteger(entryId) && entryId > 0, `entryId should be number (actual ${detail.entries[0]!.id})`)

    const forked = await env.app.kernel.forkConversation(source.id, { entryId })
    assert.notEqual(forked.id, source.id)
    assert.equal(forked.parentConversationId, source.id)
    assert.equal(forked.title, 'source conversation (fork)')
    assert.equal(forked.profileId, source.profileId)
    assert.equal(forked.cwd, source.cwd)
    assert.equal(forked.model, source.model, 'fork inherit source conversation takes effect model')
    // self define title + redaction: title in secret by erase.
    const forked2 = await env.app.kernel.forkConversation(source.id, {
      entryId,
      title: `  self define title  `,
    })
    assert.equal(forked2.title, 'self define title')
  } finally {
    await env.close()
  }
})

test('fork: missing item 404(contains diagnose details); illegal entryId 400; missing conversation 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const conv = await env.app.kernel.createConversation({ title: 'empty source' })
    await assert.rejects(
      env.app.kernel.forkConversation(conv.id, { entryId: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 404)
        assert.equal(err.code, 'not_found')
        const details = err.details as { conversationId: number; entryId: number }
        assert.equal(details.conversationId, conv.id)
        assert.equal(details.entryId, 99999)
        return true
      },
    )
    await assert.rejects(
      env.app.kernel.forkConversation(conv.id, { entryId: -1 }),
      (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
    )
    await assert.rejects(
      env.app.kernel.forkConversation(777777, { entryId: 1 }),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// HTTP end-to-end
// ---------------------------------------------------------------------------

test('HTTP reset/compact/fork: status code and body validate; error message seal (404/400)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // setup authentication
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_ops}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    env.faux.setResponses([fauxAssistantMessage('http path answer')])
    const conv = await env.app.kernel.createConversation({ title: 'HTTP context' })
    await env.app.kernel.submitInput(conv.id, 'http path one question')
    await env.app.kernel.waitForIdle(conv.id)
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const entryId = Number(detail.entries[0]!.id)

    // reset: empty body and JSON body all legal
    const resetEmpty = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`)
    assert.equal(resetEmpty.status, 200)
    assert.equal(resetEmpty.body.id, conv.id)
    const resetHandoff = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`, {
      handoff: 'second time reset',
    })
    assert.equal(resetHandoff.status, 200)

    // compact:202 + { taskId, conversation }
    const compact = await authCall(env, 'POST', `/api/conversations/${conv.id}/compact`, {
      instructions: 'http compress instruction',
    })
    assert.equal(compact.status, 202)
    assert.ok(Number.isInteger(compact.body.taskId) && compact.body.taskId > 0)
    assert.equal(compact.body.conversation.id, conv.id)

    // fork:201 + new conversation summary
    const fork = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, {
      entryId,
      title: 'HTTP fork',
    })
    assert.equal(fork.status, 201)
    assert.equal(fork.body.title, 'HTTP fork')
    assert.equal(fork.body.parentConversationId, conv.id)

    // error path
    const forkMissing = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, {
      entryId: 987654,
    })
    assert.equal(forkMissing.status, 404)
    assert.equal(forkMissing.body.error.code, 'not_found')
    const forkBad = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, { entryId: 0 })
    assert.equal(forkBad.status, 400)
    assert.equal(forkBad.body.error.code, 'validation_error')
    const forkUnsafe = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, { entryId: Number.MAX_SAFE_INTEGER + 1 })
    assert.equal(forkUnsafe.status, 400)
    assert.equal(forkUnsafe.body.error.code, 'validation_error')
    const missing = await authCall(env, 'POST', '/api/conversations/88888/reset')
    assert.equal(missing.status, 404)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// original ground override heavy (replaceFromEntryId)
// ---------------------------------------------------------------------------

/** polling wait for condition into establish (guard against hang die, total timeout explicit). */
async function pollUntil(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pollUntil timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** from kernel take SDK harness(test dedicated use;harness is runtime private). */
function harnessOf(env: Env): Harness {
  return (env.app.kernel as unknown as { harness: Harness }).harness
}

/** model messages in all text content (user/assistant/system all contains). */
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
}

/** conversation all amount item summary (id/kind/first segment text). */
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
      out.push({ id: Number(raw.id), kind: raw.kind, text })
    }
    if (!page.next) break
    cursor = page.next
  }
  return out
}

test('replaceFromEntryId: override second round mention question - - old question answer out context,FTS do not hit, before lead system keep', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('第一轮回答'),
      fauxAssistantMessage('第二轮回答'),
      fauxAssistantMessage('改写后的新回答'),
    ])
    const conv = await env.app.kernel.createConversation({ title: '覆盖重写' })
    await env.app.kernel.submitInput(conv.id, '第一轮问题')
    await env.app.kernel.waitForIdle(conv.id)
    await env.app.kernel.submitInput(conv.id, '第二轮原始问题')
    await env.app.kernel.waitForIdle(conv.id)

    // found second round helm.input entry id.
    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === '第二轮原始问题')
    assert.ok(secondInput, 'should store in second round helm.input')

    // original ground override heavy second round.
    const { submissionId } = await env.app.kernel.submitInput(conv.id, '改写后的第二轮问题', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // model context: excludes old second round question answer, contains new question answer; before lead system keep.
    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    assert.ok(sdkConv)
    const ctx = await sdkConv.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t === '第二轮原始问题'), `old mention question must not in context:${JSON.stringify(texts)}`)
    assert.ok(!texts.some((t) => t === '第二轮回答'), `old answer must not in context:${JSON.stringify(texts)}`)
    assert.ok(texts.some((t) => t.includes('第一轮问题')), 'one round context keep')
    assert.ok(texts.some((t) => t.includes('第一轮回答')), 'one round answer keep')
    assert.ok(texts.some((t) => t.includes('改写后的第二轮问题')), 'new mention question in context')
    assert.ok(texts.some((t) => t.includes('改写后的新回答')), 'new answer in context')
    // before lead system completely well (messages[0] is system).
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', 'messages[0] should be before lead system')

    // helm.rewind truncate mark record written to the database.
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, 'should store in helm.rewind truncate mark record')

    // FTS: old content no longer hit, new content hit.
    const oldHit = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      oldHit.filter((h) => h.conversationId === conv.id).length,
      0,
      'old mention question must not again hit FTS',
    )
    const oldAnswerHit = await env.app.kernel.search('第二轮回答')
    assert.equal(
      oldAnswerHit.filter((h) => h.conversationId === conv.id).length,
      0,
      'old answer must not again hit FTS',
    )
    const newHit = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), 'new mention question should hit FTS')
    const newAnswerHit = await env.app.kernel.search('改写后的新回答')
    assert.ok(newAnswerHit.some((h) => h.conversationId === conv.id), 'new answer should hit FTS')

    // rebuildFts after still do not hit old content.
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('第二轮回答')
    assert.equal(
      rebuiltOld.filter((h) => h.conversationId === conv.id).length,
      0,
      'rebuildFts after old answer must not hit',
    )
    const rebuiltOldQ = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      rebuiltOldQ.filter((h) => h.conversationId === conv.id).length,
      0,
      'rebuildFts after old mention question must not hit',
    )
    const rebuiltNew = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'rebuildFts after new mention question still hit')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId: override one round mention question - - all amount truncate after context only new question answer', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('old one round answer'),
      fauxAssistantMessage('all new one round answer'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'override one round' })
    await env.app.kernel.submitInput(conv.id, 'old one round issue')
    await env.app.kernel.waitForIdle(conv.id)

    const entries = await entrySummaries(env, conv.id)
    const firstInput = entries.find((e) => e.kind === 'helm.input' && e.text === 'old one round issue')
    assert.ok(firstInput)

    await env.app.kernel.submitInput(conv.id, 'all new one round issue', {
      replaceFromEntryId: firstInput.id,
    })
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    assert.ok(sdkConv)
    const ctx = await sdkConv.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('old one round issue')), 'old mention question must not in context')
    assert.ok(!texts.some((t) => t.includes('old one round answer')), 'old answer must not in context')
    assert.ok(texts.some((t) => t.includes('all new one round issue')), 'new mention question in context')
    assert.ok(texts.some((t) => t.includes('all new one round answer')), 'new answer in context')
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', 'before lead system keep')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId error path: missing 404; duplicate override 409 entry_already_rewound; exceeds reset 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('answer one'),
      fauxAssistantMessage('heavy after answer'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'override error path' })
    await env.app.kernel.submitInput(conv.id, 'issue one')
    await env.app.kernel.waitForIdle(conv.id)

    // missing item 404.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 404)
        assert.equal(err.code, 'not_found')
        return true
      },
    )
    // illegal entryId 400.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: -1 }),
      (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
    )

    // normal override once.
    const entries = await entrySummaries(env, conv.id)
    const input1 = entries.find((e) => e.kind === 'helm.input' && e.text === 'issue one')
    assert.ok(input1)
    await env.app.kernel.submitInput(conv.id, 'change write issue one', { replaceFromEntryId: input1.id })
    await env.app.kernel.waitForIdle(conv.id)

    // duplicate override the same already by override item:409 entry_already_rewound.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'again heavy', { replaceFromEntryId: input1.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 409)
        assert.equal(err.code, 'entry_already_rewound')
        return true
      },
    )

    // reset after heavy reset before item:409 entry_before_context_head.
    env.faux.setResponses([fauxAssistantMessage('reset after answer')])
    await env.app.kernel.resetConversation(conv.id, { handoff: 'reset handover' })
    await env.app.kernel.waitForIdle(conv.id)
    const afterReset = await entrySummaries(env, conv.id)
    const beforeReset = afterReset.find((e) => e.kind === 'helm.input' && Number(e.id) < (afterReset.find((r) => r.kind === 'pi.reset')?.id ?? Infinity))
    if (beforeReset !== undefined) {
      await assert.rejects(
        env.app.kernel.submitInput(conv.id, 'out of bounds heavy', { replaceFromEntryId: beforeReset.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.status, 409)
          assert.equal(err.code, 'entry_before_context_head')
          return true
        },
      )
    }
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId HTTP:body field pass-through and error message seal', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_replace}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    env.faux.setResponses([fauxAssistantMessage('http heavy answer')])
    const conv = await env.app.kernel.createConversation({ title: 'HTTP heavy' })
    await env.app.kernel.submitInput(conv.id, 'http issue')
    await env.app.kernel.waitForIdle(conv.id)
    const entries = await entrySummaries(env, conv.id)
    const input = entries.find((e) => e.kind === 'helm.input' && e.text === 'http issue')
    assert.ok(input)

    const ok = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'http override heavy',
      replaceFromEntryId: input.id,
    })
    assert.equal(ok.status, 202)
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('http issue')))
    assert.ok(texts.some((t) => t.includes('http override heavy')))

    const bad = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'x',
      replaceFromEntryId: 0,
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'validation_error')
    const notFound = await authCall(env, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'x',
      replaceFromEntryId: 88888,
    })
    assert.equal(notFound.status, 404)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// queue up withdraw back (withdrawQueuedInput / POST /withdraw)
// ---------------------------------------------------------------------------

test('withdraw:busy conversation queue up followUp can withdraw back, queue up items from inbox disappear and no longer execute', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // work vendor function suspended: first question run keep busy until gate resolve.
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    env.faux.setResponses([
      (async () => {
        await firstGate
        return fauxAssistantMessage('first question answer')
      }) as never,
      fauxAssistantMessage('queue up input answer'),
    ])

    const conv = await env.app.kernel.createConversation({ title: 'withdraw back queue up' })
    await env.app.kernel.submitInput(conv.id, 'first question')
    // etc. run truly start (tracker hasLiveWork).
    await pollUntil(() => (env.app.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id))

    // busy in commit followUp(enter pi.inbox queue up).
    const queued = await env.app.kernel.submitInput(conv.id, 'queue up in input', {
      whenBusy: 'followUp',
    })
    const submissionId = Number(queued.submissionId)
    assert.ok(Number.isInteger(submissionId) && submissionId > 0)

    // withdraw back before queue up items in inbox in visible (queuedInputs derive).
    const snapshot = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live = snapshot.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.ok(
      live?.queuedInputs?.some((q) => q.submissionId === queued.submissionId),
      'queue up items should in queuedInputs in visible',
    )

    // withdraw back:status withdrawn.
    const result = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.deepEqual(result, { status: 'withdrawn' })

    // queue up items from inbox disappear.
    const snapshot2 = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live2 = snapshot2.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.equal(
      live2?.queuedInputs?.some((q) => q.submissionId === queued.submissionId) ?? false,
      false,
      'withdraw back after queue up items should disappear',
    )

    // release first question run, wait for idle: by withdraw back input no longer execute (context only contains first question question answer).
    releaseFirst?.()
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('queue up in input')), 'by withdraw back input must not execute enter context')
    assert.ok(texts.some((t) => t.includes('first question answer')), 'first question answer normal complete')

    // again withdraw back the same commit: already compute (unanswered), return settled.
    const again = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.equal(again.status, 'settled')

    // missing commit 404.
    await assert.rejects(
      env.app.kernel.withdrawQueuedInput(conv.id, { submissionId: 999999 }),
      (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    await env.close()
  }
})

test('withdraw HTTP:POST /api/conversations/:id/withdraw status code and body', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '{{SECRET_ctx_withdraw}}' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    env.faux.setResponses([
      (async () => {
        await gate
        return fauxAssistantMessage('http withdraw back first question answer')
      }) as never,
    ])

    const conv = await env.app.kernel.createConversation({ title: 'HTTP withdraw back' })
    await env.app.kernel.submitInput(conv.id, 'http withdraw back first question')
    await pollUntil(() => (env.app.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id))
    const queued = await env.app.kernel.submitInput(conv.id, 'http queue up withdraw back items', {
      whenBusy: 'followUp',
    })

    const ok = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: Number(queued.submissionId),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { status: 'withdrawn' })

    // illegal body.
    const bad = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 0,
    })
    assert.equal(bad.status, 400)
    const unknownField = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 1,
      bogus: 1,
    })
    assert.equal(unknownField.status, 400)
    // missing commit 404.
    const nf = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 987654,
    })
    assert.equal(nf.status, 404)
    assert.equal(nf.body.error.code, 'not_found')
    // missing conversation 404.
    const nfConv = await authCall(env, 'POST', '/api/conversations/777777/withdraw', {
      submissionId: 1,
    })
    assert.equal(nfConv.status, 404)

    release?.()
    await env.app.kernel.waitForIdle(conv.id)
  } finally {
    await env.close()
  }
})
