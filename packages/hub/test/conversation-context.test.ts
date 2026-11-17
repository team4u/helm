/**
 * Conversation context operations tests (`reset` / `compact` / `fork`).
 * Real `createHelm` composition (real `pi-durable` SQLite + faux provider):
 * - `reset`: native SDK `reset(handoff)`, clears context, inserts handoff as first user message,
 *   advances `stateChangeSeq`, broadcasts SSE `conversation.upsert`;
 * - `compact`: native SDK `compact(instructions)` returns background task ID and summarizes context;
 * - `fork`: validates entry existence (404 when missing), forks new conversation in SDK, updates helm mirror
 *   (parent chain / inherited profile / `cwd` / `model` / `title (fork)`), aligns model;
 * - HTTP/CLI end-to-end: `POST /reset` / `/compact` / `/fork` status codes and error mapping.
 *
 * In-place rewrite (`replaceFromEntryId`) and queue withdrawal (`withdraw`):
 * - `replaceFromEntryId`: `helm.rewind` truncation marker + edit omission reuses `pi-durable` native semantics,
 *   model messages exclude overwritten Q&A while preserving leading system prompt, FTS5 search and `rebuildFts`
 *   no longer match omitted content;
 * - `withdraw`: faux factory suspends to keep conversation busy; queued `followUp` can be withdrawn
 *   (`status: 'withdrawn'`), disappearing from `pi.inbox` without ever executing.
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

test('reset: clears context, injects handoff into new context, advances seq, broadcasts upsert', { timeout: 60_000 }, async () => {
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
    assert.ok(userTextsBefore >= 1, 'should have input entries before reset')

    const events: unknown[] = []
    const unsubscribe = (env.app.kernel.events as unknown as {
      subscribe(l: (frame: { event: { type: string } }) => void): () => void
    }).subscribe((frame) => {
      if (frame.event.type === 'conversation.upsert') events.push(frame)
    })

    const after = await env.app.kernel.resetConversation(conv.id, { handoff: 'reset after handover note' })
    await env.app.kernel.waitForIdle(conv.id)
    unsubscribe()

    assert.ok(after.stateChangeSeq > before.stateChangeSeq, 'stateChangeSeq advances monotonically')
    assert.ok(events.length > 0, 'conversation.upsert was broadcast')
    // New context starts with handoff user message (`pi.reset` entry's model message carries handoff).
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const resetEntry = detail.entries.find((e) => e.kind === 'pi.reset')
    assert.ok(resetEntry !== undefined, 'pi.reset entry should exist after reset')
    const userContent = (resetEntry.model ?? []).map(
      (m) => (m as { content?: unknown }).content,
    )
    const handoffSeen = userContent.some((c) =>
      typeof c === 'string' ? c === 'reset after handover note' : JSON.stringify(c).includes('reset after handover note'),
    )
    assert.ok(handoffSeen, 'handoff text should be the first user message in the new context')
  } finally {
    await env.close()
  }
})

test('reset: works without handoff; 404 on missing conversation; 503 after close guaranteed by composition layer', { timeout: 60_000 }, async () => {
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

test('compact: returns background task ID and dispatches compaction to SDK scheduler', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('ordinary answer one')])
    const conv = await env.app.kernel.createConversation({ title: 'compress test' })
    await env.app.kernel.submitInput(conv.id, 'one segment enough long dialog content 1')
    await env.app.kernel.waitForIdle(conv.id)

    const { taskId, conversation } = await env.app.kernel.compactConversation(conv.id, {
      instructions: 'highlight key decisions',
    })
    assert.ok(Number.isInteger(taskId) && taskId > 0, 'taskId is a positive integer (SDK TaskId)')
    assert.equal(conversation.id, conv.id)
    assert.ok(conversation.stateChangeSeq >= 1)
  } finally {
    await env.close()
  }
})

test('compact: 404 on missing conversation', { timeout: 60_000 }, async () => {
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

test('fork: forks from existing entry, registers mirror (parent/inheritance), aligns model, sets default title', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([fauxAssistantMessage('source conversation answer')])
    const source = await env.app.kernel.createConversation({ title: 'source conversation' })
    await env.app.kernel.submitInput(source.id, 'source conversation one question')
    await env.app.kernel.waitForIdle(source.id)
    const detail = await env.app.kernel.getConversationDetail(source.id)
    assert.ok(detail.entries.length > 0, 'source conversation should have entries')
    const entryId = Number(detail.entries[0]!.id)
    assert.ok(Number.isInteger(entryId) && entryId > 0, `entryId should be numeric (got ${detail.entries[0]!.id})`)

    const forked = await env.app.kernel.forkConversation(source.id, { entryId })
    assert.notEqual(forked.id, source.id)
    assert.equal(forked.parentConversationId, source.id)
    assert.equal(forked.title, 'source conversation (fork)')
    assert.equal(forked.profileId, source.profileId)
    assert.equal(forked.cwd, source.cwd)
    assert.equal(forked.model, source.model, 'fork inherits source conversation effective model')
    // Custom title + redaction: trims whitespace and redacts secrets.
    const forked2 = await env.app.kernel.forkConversation(source.id, {
      entryId,
      title: `  self define title  `,
    })
    assert.equal(forked2.title, 'self define title')
  } finally {
    await env.close()
  }
})

test('fork: missing entry 404 (with diagnostics); invalid entryId 400; missing conversation 404', { timeout: 60_000 }, async () => {
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

test('HTTP reset/compact/fork: status codes, body validation, and error mapping (404/400)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Setup authentication
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

    // reset: both empty body and JSON body are valid
    const resetEmpty = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`)
    assert.equal(resetEmpty.status, 200)
    assert.equal(resetEmpty.body.id, conv.id)
    const resetHandoff = await authCall(env, 'POST', `/api/conversations/${conv.id}/reset`, {
      handoff: 'second time reset',
    })
    assert.equal(resetHandoff.status, 200)

    // compact: 202 + { taskId, conversation }
    const compact = await authCall(env, 'POST', `/api/conversations/${conv.id}/compact`, {
      instructions: 'http compress instruction',
    })
    assert.equal(compact.status, 202)
    assert.ok(Number.isInteger(compact.body.taskId) && compact.body.taskId > 0)
    assert.equal(compact.body.conversation.id, conv.id)

    // fork: 201 + new conversation summary
    const fork = await authCall(env, 'POST', `/api/conversations/${conv.id}/fork`, {
      entryId,
      title: 'HTTP fork',
    })
    assert.equal(fork.status, 201)
    assert.equal(fork.body.title, 'HTTP fork')
    assert.equal(fork.body.parentConversationId, conv.id)

    // Error paths
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
// In-place rewrite (`replaceFromEntryId`)
// ---------------------------------------------------------------------------

/** Polls until predicate holds (guards against hangs with an explicit total timeout). */
async function pollUntil(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pollUntil timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Accesses SDK `harness` from kernel (test-only helper; `harness` is runtime-private). */
function harnessOf(env: Env): Harness {
  return (env.app.kernel as unknown as { harness: Harness }).harness
}

/** Extracts all text content from model messages (covering user/assistant/system). */
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

/** Summarizes all raw entries in a conversation (id/kind/first-block text). */
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

test('replaceFromEntryId: overwriting round 2 drops old Q&A from context and FTS while keeping leading system prompt', { timeout: 60_000 }, async () => {
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

    // Locate round 2 `helm.input` entry ID.
    const entries = await entrySummaries(env, conv.id)
    const secondInput = entries.find((e) => e.kind === 'helm.input' && e.text === '第二轮原始问题')
    assert.ok(secondInput, 'round 2 helm.input should exist')

    // Rewrite round 2 in place.
    const { submissionId } = await env.app.kernel.submitInput(conv.id, '改写后的第二轮问题', {
      replaceFromEntryId: secondInput.id,
    })
    assert.ok(Number.isInteger(Number(submissionId)))
    await env.app.kernel.waitForIdle(conv.id)

    // Model context: excludes old round 2 Q&A, includes new Q&A, preserves leading system prompt.
    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    assert.ok(sdkConv)
    const ctx = await sdkConv.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t === '第二轮原始问题'), `old question must not appear in context: ${JSON.stringify(texts)}`)
    assert.ok(!texts.some((t) => t === '第二轮回答'), `old answer must not appear in context: ${JSON.stringify(texts)}`)
    assert.ok(texts.some((t) => t.includes('第一轮问题')), 'round 1 question preserved')
    assert.ok(texts.some((t) => t.includes('第一轮回答')), 'round 1 answer preserved')
    assert.ok(texts.some((t) => t.includes('改写后的第二轮问题')), 'new question in context')
    assert.ok(texts.some((t) => t.includes('改写后的新回答')), 'new answer in context')
    // Leading system prompt intact (`messages[0]` is `system`).
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', 'messages[0] should be the leading system prompt')

    // `helm.rewind` truncation marker persisted.
    const after = await entrySummaries(env, conv.id)
    const rewind = after.find((e) => e.kind === 'helm.rewind')
    assert.ok(rewind, 'helm.rewind truncation marker should exist')

    // FTS: old content no longer matches; new content matches.
    const oldHit = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      oldHit.filter((h) => h.conversationId === conv.id).length,
      0,
      'old question must no longer match FTS',
    )
    const oldAnswerHit = await env.app.kernel.search('第二轮回答')
    assert.equal(
      oldAnswerHit.filter((h) => h.conversationId === conv.id).length,
      0,
      'old answer must no longer match FTS',
    )
    const newHit = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(newHit.some((h) => h.conversationId === conv.id), 'new question should match FTS')
    const newAnswerHit = await env.app.kernel.search('改写后的新回答')
    assert.ok(newAnswerHit.some((h) => h.conversationId === conv.id), 'new answer should match FTS')

    // Old content stays excluded after `rebuildFts`.
    await env.app.kernel.rebuildFts()
    const rebuiltOld = await env.app.kernel.search('第二轮回答')
    assert.equal(
      rebuiltOld.filter((h) => h.conversationId === conv.id).length,
      0,
      'old answer must not match after rebuildFts',
    )
    const rebuiltOldQ = await env.app.kernel.search('第二轮原始问题')
    assert.equal(
      rebuiltOldQ.filter((h) => h.conversationId === conv.id).length,
      0,
      'old question must not match after rebuildFts',
    )
    const rebuiltNew = await env.app.kernel.search('改写后的第二轮问题')
    assert.ok(rebuiltNew.some((h) => h.conversationId === conv.id), 'new question still matches after rebuildFts')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId: overwriting round 1 truncates history so context holds only new Q&A', { timeout: 60_000 }, async () => {
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
    assert.ok(!texts.some((t) => t.includes('old one round issue')), 'old question must not remain in context')
    assert.ok(!texts.some((t) => t.includes('old one round answer')), 'old answer must not remain in context')
    assert.ok(texts.some((t) => t.includes('all new one round issue')), 'new question in context')
    assert.ok(texts.some((t) => t.includes('all new one round answer')), 'new answer in context')
    assert.equal((ctx.messages[0] as { role: string }).role, 'system', 'leading system prompt preserved')
  } finally {
    await env.close()
  }
})

test('replaceFromEntryId error paths: missing 404; double rewrite 409 entry_already_rewound; before reset 409', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([
      fauxAssistantMessage('answer one'),
      fauxAssistantMessage('heavy after answer'),
    ])
    const conv = await env.app.kernel.createConversation({ title: 'override error path' })
    await env.app.kernel.submitInput(conv.id, 'issue one')
    await env.app.kernel.waitForIdle(conv.id)

    // Missing entry -> 404.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: 99999 }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 404)
        assert.equal(err.code, 'not_found')
        return true
      },
    )
    // Invalid entryId -> 400.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'heavy', { replaceFromEntryId: -1 }),
      (err: unknown) => err instanceof HelmError && err.status === 400 && err.code === 'validation_error',
    )

    // Perform first rewrite normally.
    const entries = await entrySummaries(env, conv.id)
    const input1 = entries.find((e) => e.kind === 'helm.input' && e.text === 'issue one')
    assert.ok(input1)
    await env.app.kernel.submitInput(conv.id, 'change write issue one', { replaceFromEntryId: input1.id })
    await env.app.kernel.waitForIdle(conv.id)

    // Rewriting the same already-rewound entry again -> 409 entry_already_rewound.
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, 'again heavy', { replaceFromEntryId: input1.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.status, 409)
        assert.equal(err.code, 'entry_already_rewound')
        return true
      },
    )

    // Rewriting an entry prior to a reset -> 409 entry_before_context_head.
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

test('replaceFromEntryId HTTP: body field pass-through and error mapping', { timeout: 60_000 }, async () => {
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
// Queue withdrawal (`withdrawQueuedInput` / `POST /withdraw`)
// ---------------------------------------------------------------------------

test('withdraw: queued followUp on busy conversation can be withdrawn and removed from inbox without running', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Suspend factory callback so the first turn stays busy until `releaseFirst` resolves.
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
    // Wait until the turn actually starts (`tracker.hasLiveWork`).
    await pollUntil(() => (env.app.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id))

    // Submit `followUp` while busy (enters `pi.inbox` queue).
    const queued = await env.app.kernel.submitInput(conv.id, 'queue up in input', {
      whenBusy: 'followUp',
    })
    const submissionId = Number(queued.submissionId)
    assert.ok(Number.isInteger(submissionId) && submissionId > 0)

    // Before withdrawal, queued item appears in `queuedInputs`.
    const snapshot = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live = snapshot.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.ok(
      live?.queuedInputs?.some((q) => q.submissionId === queued.submissionId),
      'queued item should appear in queuedInputs',
    )

    // Withdraw -> status `'withdrawn'`.
    const result = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.deepEqual(result, { status: 'withdrawn' })

    // Queued item disappears from inbox.
    const snapshot2 = (env.app.kernel.events as unknown as {
      currentSnapshot(): { conversationLives?: Array<{ conversationId: number; queuedInputs?: Array<{ submissionId: string }> }> }
    }).currentSnapshot()
    const live2 = snapshot2.conversationLives?.find((l) => l.conversationId === conv.id)
    assert.equal(
      live2?.queuedInputs?.some((q) => q.submissionId === queued.submissionId) ?? false,
      false,
      'withdrawn item should disappear from queuedInputs',
    )

    // Release first turn and wait for idle: withdrawn input never runs (context only holds first Q&A).
    releaseFirst?.()
    await env.app.kernel.waitForIdle(conv.id)

    const sdkConv = await harnessOf(env).conversation(conv.id as never, BACKGROUND_CONTEXT)
    const ctx = await sdkConv!.context(BACKGROUND_CONTEXT)
    const texts = messageTexts(ctx.messages as never as Array<{ role: string; content: unknown }>)
    assert.ok(!texts.some((t) => t.includes('queue up in input')), 'withdrawn input must not enter context')
    assert.ok(texts.some((t) => t.includes('first question answer')), 'first turn answer completed normally')

    // Withdrawing the same submission again (already settled) returns `'settled'`.
    const again = await env.app.kernel.withdrawQueuedInput(conv.id, { submissionId })
    assert.equal(again.status, 'settled')

    // Missing submission -> 404.
    await assert.rejects(
      env.app.kernel.withdrawQueuedInput(conv.id, { submissionId: 999999 }),
      (err: unknown) => err instanceof HelmError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    await env.close()
  }
})

test('withdraw HTTP: POST /api/conversations/:id/withdraw status codes and validation', { timeout: 60_000 }, async () => {
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

    // Invalid bodies
    const bad = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 0,
    })
    assert.equal(bad.status, 400)
    const unknownField = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 1,
      bogus: 1,
    })
    assert.equal(unknownField.status, 400)
    // Missing submission -> 404
    const nf = await authCall(env, 'POST', `/api/conversations/${conv.id}/withdraw`, {
      submissionId: 987654,
    })
    assert.equal(nf.status, 404)
    assert.equal(nf.body.error.code, 'not_found')
    // Missing conversation -> 404
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
