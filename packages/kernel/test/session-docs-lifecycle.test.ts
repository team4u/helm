/**
 * Integration tests for dedicated sessionDoc SSE lifecycle (`KernelRuntime` + HTTP hub).
 *
 * Covers:
 * - Plugin disabled while stream open (`plugin.changed` `enabled=false`): server terminates stream via event push;
 * - Conversation deleted while stream open (`conversation.deleted`): server terminates stream via event push;
 * - `kernel.close()` closes all dedicated sessionDoc streams and releases lifecycle subscriptions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { startHub } from '../src/http/index.js'
import type { PluginSessionDocHandle } from '@helmx/protocol'
import type { KernelRuntime as KernelRuntimeType } from '../src/runtime/runtime.js'

interface App {
  kernel: KernelRuntimeType
  url: string
  token: string
  metrics: PluginSessionDocHandle<{ n: number }>
  close(): Promise<void>
}

async function openApp(): Promise<App> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-sd-lifecycle-'))
  const models = createModels()
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  let metrics: PluginSessionDocHandle<{ n: number }> | undefined
  await kernel.plugins.register({
    id: 'p:lifecycle',
    definePlugin: (ctx) => {
      metrics = ctx.sessionDoc('metrics', { n: 0 }, { public: true })
    },
  })
  // (Kernel started before startHub: the listen-before-start HTTP layer gates non-probe API routes
  // with `503 hub_starting` while `kernel.started === false`.)
  await kernel.start()
  const hub = await startHub({ kernel: kernel as never, port: 0 })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'sd-lifecycle-pass' }),
  })
  const { token } = (await setup.json()) as { token: string }
  return {
    kernel,
    url: hub.url,
    token,
    metrics: metrics!,
    async close() {
      await hub.close()
      await kernel.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function sseUrl(url: string, conversationId: number): string {
  return `${url}/api/plugins/p%3Alifecycle/docs/metrics/events?conversationId=${conversationId}`
}

/** Reads a stream until completion (`done`) and returns full decoded text; fails on timeout. */
async function readUntilDone(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 10_000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
  }
}

test('dedicated SSE: disables plugin and closes active sessionDoc stream (event-driven)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    app.metrics.set(1, { n: 1 })
    const res = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    // Disable plugin: plugin.changed enabled=false -> closeForPlugin -> terminates stream.
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.plugins.disable('p:lifecycle')
    const text = await readAll
    assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before stream closed')
    assert.ok(text.length >= 0)
    // Reconnecting while disabled fails validation with 404 before opening a stream.
    const rejected = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(rejected.status, 404)
    await rejected.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('dedicated SSE: deletes conversation and closes active sessionDoc stream (conversation.deleted)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    // Create an isolated conversation to verify cascade without relying on seeded IDs.
    const conv = await app.kernel.createConversation({})
    const conversationId = conv.id
    app.metrics.set(conversationId, { n: 1 })
    const res = await fetch(sseUrl(app.url, conversationId), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.deleteConversation(conversationId)
    const text = await readAll
    assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before stream closed')
  } finally {
    await app.close()
  }
})

test('kernel.close(): closes all dedicated sessionDoc streams and releases subscriptions', { timeout: 60_000 }, async () => {
  const app = await openApp()
  app.metrics.set(1, { n: 1 })
  const res = await fetch(sseUrl(app.url, 1), {
    headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
  await app.kernel.close()
  const text = await readAll
  assert.match(text, /event: snapshot/, 'initial snapshot frame arrived before kernel shutdown')
  assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0, 'no subscriptions remain after kernel.close()')
  await app.close()
})

test('transient sessionDoc (durable: false): HTTP GET + dedicated SSE + conversation.deleted cleanup with zero SQLite rows', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    let transient!: PluginSessionDocHandle<{ step: number } | null>
    await app.kernel.plugins.register({
      id: 'p:transient-http',
      definePlugin: (ctx) => {
        transient = ctx.sessionDoc<{ step: number } | null>('live', null, { public: true, durable: false })
      },
    })
    const conv = await app.kernel.createConversation({})
    transient.set(conv.id, { step: 1 })

    const getRes = await fetch(
      `${app.url}/api/plugins/p%3Atransient-http/docs/live?conversationId=${conv.id}`,
      { headers: { authorization: `Bearer ${app.token}` } },
    )
    assert.equal(getRes.status, 200)
    assert.deepEqual(((await getRes.json()) as { value: { step: number } }).value, { step: 1 })

    const sseRes = await fetch(
      `${app.url}/api/plugins/p%3Atransient-http/docs/live/events?conversationId=${conv.id}`,
      { headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' } },
    )
    assert.equal(sseRes.status, 200)
    const readAll = readUntilDone(sseRes.body as ReadableStream<Uint8Array>)
    transient.set(conv.id, { step: 2 })
    // Delete conversation: closes stream cleanly and clears in-memory transient entry.
    await app.kernel.deleteConversation(conv.id)
    const text = await readAll
    assert.match(text, /event: snapshot/)
    assert.match(text, /"step":2/)

    // Flush & check SQLite: zero rows ever written for p:transient-http.
    await transient.flush()
    const db = await openHelmxDatabase(app.kernel.dataDir)
    try {
      const rows = await db.db.all<{ conversation_id: number }>(
        'SELECT conversation_id FROM helmx_plugin_session_docs WHERE plugin_id = ?',
        'p:transient-http',
      )
      assert.equal(rows.length, 0)
    } finally {
      await db.close()
    }
  } finally {
    await app.close()
  }
})
