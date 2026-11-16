/**
 * input redaction regression test (align1 because fix most small real regression).
 *
 * background:core-alignment.integration.test.ts:292 real failed - -submitInput only for
 * meta redaction,text/effectiveText original enter SDK content and helm.input.data,
 * leads to already register secret (managed Token,SecretStash marker) plaintext enter model context and
 * state.sqlite.
 *
 * this file with real KernelRuntime + faux provider + temporary dataDir verify:
 * 1. directly input contains managed token / stash secret → model request,helm.input entry,
 *    automatically title,FTS,state.sqlite all chain only see marker/placeholder;
 * 2. input hook transform artifact contains secret → same all chain redaction (transform semantics keep:
 *    transform after text/origin takes effect).
 *
 * honest: all assertion based on real SQLite file and faux catch model request, without mock assertion.
 * runner: tsx --test; each items explicit timeout: 60_000.
 */
import { test } from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

import assert from 'node:assert/strict'

/** initial conversation id(SDK keep #1 bear load; ordinary conversation semantics, without produce product level special right). */
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
  assert.ok(managedToken, 'runtime ctor should create managed process token')
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

/** sqlite all table scan: contains needle table name set (and core-alignment same method). */
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

test('directly input contains managed token and stash secret:text/meta/title/entry/FTS/SQLite all chain redaction', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-input-redact-direct-')
  try {
    // conversation level stash secret (marker form:redact after is [REDACTED:stash:<uuid>]).
    const conversation = await env.kernel.createConversation()
    const placeholder = env.kernel.stash.put(conversation.id, 'API_KEY', 'sk-secret-plain-value-9f3k')
    assert.ok(placeholder.startsWith('[REDACTED:stash:'))

    const requests: string[] = []
    env.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('receives')
      },
    ])

    await env.kernel.submitInput(
      conversation.id,
      `credentials is ${env.managedToken} and sk-secret-plain-value-9f3k, additionally meta also carries`,
      { meta: { token: env.managedToken, key: 'sk-secret-plain-value-9f3k' } },
    )
    await env.kernel.waitForIdle(conversation.id)

    // 1) model request (SDK content) must not contains any plaintext.
    assert.equal(requests.length, 1, 'should catch once model request')
    assert.ok(!requests[0]!.includes(env.managedToken), 'model request must not contains managed Token plaintext')
    assert.ok(!requests[0]!.includes('sk-secret-plain-value-9f3k'), 'model request must not contains stash secret plaintext')
    // redaction value real enter model (non-empty shell).
    assert.ok(requests[0]!.includes('[REDACTED]'), 'managed token should with [REDACTED] marker enter model')
    assert.ok(requests[0]!.includes(placeholder), 'stash secret should with placeholder enter model')

    // 2) all store scan: any table must not store plaintext (contains helm.input entry, title column,FTS).
    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'state.sqlite must not contains managed Token plaintext')
    assert.deepEqual(sqliteTablesContaining(dbPath, 'sk-secret-plain-value-9f3k'), [], 'state.sqlite must not contains stash secret plaintext')

    // 3) title redaction (first input automatically title take effectiveText).
    const conv = env.kernel.getConversation(conversation.id)
    assert.ok(conv.title.includes('[REDACTED]'), 'first input should generate contains redaction text title')
    assert.ok(!conv.title.includes(env.managedToken), 'automatically title must not contains managed Token plaintext')
    const detail = await env.kernel.getConversationDetail(conversation.id)
    const input = detail.entries.find((entry) => entry.kind === 'helm.input')?.data as
      { text: string; meta: Record<string, unknown> } | undefined
    assert.ok(input, 'detail situation should keep real input item')
    assert.equal(input.text, `credentials is [REDACTED] and ${placeholder}, additionally meta also carries`)
    assert.deepEqual(input.meta, { token: '[REDACTED]', key: placeholder })

    // 4) FTS inspect index obtain to redaction text while non- plaintext.
    const hits = await env.kernel.search('[REDACTED]')
    assert.ok(hits.length >= 1, 'redaction text should can by FTS inspect index')
    for (const hit of hits) {
      assert.ok(!JSON.stringify(hit).includes(env.managedToken), 'FTS result must not back visible plaintext')
    }
  } finally {
    await env.close()
  }
})

test('input hook transform artifact contains secret: same all chain redaction,transform semantics keep', { timeout: 60_000 }, async () => {
  const env = await makeEnv('helm-input-redact-transform-')
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
        return fauxAssistantMessage('receives transform input')
      },
    ])

    await env.kernel.submitInput(ROOT_CONVERSATION_ID, 'original input')
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.equal(requests.length, 1, 'should catch once model request')
    assert.ok(!requests[0]!.includes(env.managedToken), 'transform artifact must not managed Token plaintext send model')
    // transform semantics keep: change write after text and origin real takes effect.
    assert.ok(requests[0]!.includes('additional secret'), 'transform append text should take effect')
    assert.ok(requests[0]!.includes('[REDACTED]'), 'transform artifact in secret should with marker enter model')

    const dbPath = join(env.dataDir, 'state.sqlite')
    assert.deepEqual(sqliteTablesContaining(dbPath, env.managedToken), [], 'transform artifact must not in state.sqlite plaintext')

    // turn_settled input manifest in text same is redaction value (hook payload from entry rebuild).
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
    await env.kernel.submitInput(ROOT_CONVERSATION_ID, `again come once ${env.managedToken}`)
    await env.kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(settledTexts.length >= 1, 'should catch turn_settled')
    for (const text of settledTexts) {
      assert.ok(!text.includes(env.managedToken), 'turn_settled inputs.text must not contains plaintext')
    }
  } finally {
    await env.close()
  }
})
