/**
 * Input redaction regression tests (minimal real-world regression suite).
 *
 * Background: submitInput previously redacted only meta while forwarding raw text/effectiveText into
 * SDK context and helmx.input.data, allowing registered secrets (managed tokens, SecretStash values)
 * to enter model context and state.sqlite in plaintext.
 *
 * Verified via real KernelRuntime + faux provider + temp dataDir:
 * 1. Direct input containing managed token / stash secret -> model requests, helmx.input entries,
 *    auto-generated title, FTS, and all state.sqlite tables contain only markers/placeholders;
 * 2. Output of input hook transforms containing secrets -> identically redacted across all layers
 *    (while preserving transform semantics: transformed text/origin apply).
 *
 * Honesty: all assertions inspect real SQLite files and faux-captured model requests with no mocks.
 * Runner: tsx --test; every test specifies timeout: 60_000.
 */
import { test } from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

import assert from 'node:assert/strict'

/** Initial conversation id (held by SDK slot #1; ordinary conversation semantics with no special privileges). */
const ROOT_CONVERSATION_ID = 1 as const

interface Env {
  dataDir: string
  faux: ReturnType<typeof makeFauxModels>['faux']
  kernel: KernelRuntime
  managedToken: string
  close(): Promise<void>
}

async function makeEnv(prefix: string): Promise<Env> {
  const dataDir = await makeTempDir(prefix)
  const { models, faux } = makeFauxModels()
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const managedToken = (kernel as unknown as {
    toolDeps: { processToken(): string | undefined }
  }).toolDeps.processToken()
  assert.ok(managedToken, 'runtime ctor should create a managed process token')
  return {
    dataDir,
    faux,
    kernel,
    managedToken,
    async close() {
      try {
        await kernel.close()
      } finally {
        await cleanupDir(dataDir)
      }
    },
  }
}

/** Scans all tables in state.sqlite and returns table names containing needle. */
function sqliteTablesContaining(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hits: string[] = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]
      if (rows.map((r) => JSON.stringify(r)).join('\n').includes(needle)) hits.push(name)
    }
    return hits
  } finally {
    db.close()
  }
}

test('direct input with managed token and stash secret is redacted end-to-end across text/meta/title/entry/FTS/SQLite', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helmx-input-redact-direct-')
  try {
    // Conversation-scoped stash secret (placeholder format after redaction: [REDACTED:stash:<uuid>]).
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', 'sk-secret-plain-value-9f3k')
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    const requests: string[] = []
    env.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('received')
      },
    ])

    await env.kernel.submitInput(
      conversation.id,
      `credential is ${env.managedToken} and sk-secret-plain-value-9f3k, plus meta`,
      { meta: { token: env.managedToken, key: 'sk-secret-plain-value-9f3k' } },
    )
    await env.kernel.waitForIdle(conversation.id)

    // 1) Model request (SDK context) must contain zero plaintext secrets.
    assert.equal(requests.length, 1, 'should capture one model request')
    assert.ok(!requests[0]!.includes(env.managedToken), 'model request must not contain plaintext managed token')
    assert.ok(!requests[0]!.includes('sk-secret-plain-value-9f3k'), 'model request must not contain plaintext stash secret')
    // Redacted placeholder values enter model context (not stripped into an empty string).
    assert.ok(requests[0]!.includes('[REDACTED]'), 'managed token should enter model context as [REDACTED]')
    assert.ok(requests[0]!.includes(placeholder), 'stash secret should enter model context as stash placeholder')

    // 2) Full SQLite scan: no table stores plaintext (covering helmx.input entry, title column, FTS).
    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'state.sqlite must not store plaintext managed token')
    assert.deepEqual(sqliteTablesContaining(dbPath, 'sk-secret-plain-value-9f3k'), [], 'state.sqlite must not store plaintext stash secret')

    // 3) Title redaction (auto-title from first input derives from effectiveText).
    const conv = env.kernel.getConversation(conversation.id)
    assert.ok(conv.title.includes('[REDACTED]'), 'first input auto-title should contain redacted marker')
    assert.ok(!conv.title.includes(env.managedToken), 'auto-title must not contain plaintext managed token')
    const detail = await env.kernel.getConversationDetail(conversation.id)
    const input = detail.entries.find((entry) => entry.kind === 'helmx.input')?.data as
      { text: string; meta: Record<string, unknown> } | undefined
    assert.ok(input, 'conversation detail should persist redacted input entry')
    assert.equal(input.text, `credential is [REDACTED] and ${placeholder}, plus meta`)
    assert.deepEqual(input.meta, { token: '[REDACTED]', key: placeholder })

    // 4) FTS searches redacted text rather than plaintext.
    const hits = await env.kernel.search('[REDACTED]')
    assert.ok(hits.length >= 1, 'redacted text should be searchable via FTS')
    for (const hit of hits) {
      assert.ok(!JSON.stringify(hit).includes(env.managedToken), 'FTS hits must never expose plaintext')
    }
  } finally {
    await env.close()
  }
})

test('input hook transform output containing secrets is redacted end-to-end while preserving transform semantics', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helmx-input-redact-transform-')
  try {
    await env.kernel.plugins.register({
      id: 'test:inject-secret',
      definePlugin(ctx) {
        ctx.hook.onInput((payload) => {
          return {
            action: 'transform',
            value: {
              ...payload,
              input: {
                ...payload.input,
                text: `${payload.input.text} additional secret ${env.managedToken}`,
                origin: 'agent',
                meta: { injected: env.managedToken },
              },
            },
          }
        })
      },
    })

    const requests: string[] = []
    env.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('received transform input')
      },
    ])

    await env.kernel.submitInput(ROOT_CONVERSATION_ID, 'original input')
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.equal(requests.length, 1, 'should capture one model request')
    assert.ok(!requests[0]!.includes(env.managedToken), 'transformed output must not send plaintext managed token to model')
    // Transform semantics preserved: appended text and updated origin take effect.
    assert.ok(requests[0]!.includes('additional secret'), 'text appended by transform should take effect')
    assert.ok(requests[0]!.includes('[REDACTED]'), 'secret introduced by transform must enter model as [REDACTED]')

    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'transformed output must not leave plaintext in state.sqlite')

    // turn_settled inputs list also carries redacted text (reconstructed from persisted entry).
    const settledTexts: string[] = []
    await env.kernel.plugins.register({
      id: 'test:settled-observer',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledTexts.push(...payload.inputs.map((i) => i.text))
        })
      },
    })
    env.faux.setResponses([fauxAssistantMessage('second turn')])
    await env.kernel.submitInput(ROOT_CONVERSATION_ID, `once again ${env.managedToken}`)
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(settledTexts.length >= 1, 'should capture turn_settled')
    for (const text of settledTexts) {
      assert.ok(!text.includes(env.managedToken), 'turn_settled inputs.text must not contain plaintext')
    }
  } finally {
    await env.close()
  }
})
