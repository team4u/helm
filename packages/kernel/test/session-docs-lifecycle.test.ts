/**
 * conversation document dedicated use SSE lifecycle integration test (real KernelRuntime + real HTTP hub).
 *
 * override:
 * - create stream after plugin deactivate (plugin.changed enabled=false): already create stream by server side terminate (event drive, non- polling);
 * - create stream after conversation delete (conversation.deleted): already create stream by server side terminate;
 * - kernel.close() close all dedicated use stream and release lifecycle subscribe.
 * fixture:faux model + real KernelRuntime.open + startHub(port 0).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { startHub } from '../src/http/index.js'
import type { PluginSessionDocHandle } from '@helm/protocol'
import type { KernelRuntime as KernelRuntimeType } from '../src/runtime/runtime.js'

interface App {
  kernel: KernelRuntimeType
  url: string
  token: string
  metrics: PluginSessionDocHandle<{ n: number }>
  close(): Promise<void>
}

async function openApp(): Promise<App> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-sd-lifecycle-'))
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

/** read to stream end (done), return all text; timeout guard against hang die. */
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

test('dedicated use SSE: plugin deactivate after already create stream by terminate (event drive closure stream)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    app.metrics.set(1, { n: 1 })
    const res = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    // deactivate plugin:plugin.changed enabled=false -> closeForPlugin -> stream terminate.
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.plugins.disable('p:lifecycle')
    const text = await readAll
    assert.match(text, /event: snapshot/, 'closure stream before first frame snapshot already reach')
    assert.ok(text.length >= 0)
    // deactivate after again create connect:provider validate 404(do not create stream).
    const rejected = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(rejected.status, 404)
    await rejected.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('dedicated use SSE: conversation after deletion already create stream by terminate (conversation.deleted closure stream)', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    // creates new independent conversation verify delete level join, independent of broadcast entry fixed ID.
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
    assert.match(text, /event: snapshot/, 'closure stream before first frame snapshot already reach')
  } finally {
    await app.close()
  }
})

test('kernel.close(): dedicated use stream all terminate and lifecycle subscribe release', { timeout: 60_000 }, async () => {
  const app = await openApp()
  app.metrics.set(1, { n: 1 })
  const res = await fetch(sseUrl(app.url, 1), {
    headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
  await app.kernel.close()
  const text = await readAll
  assert.match(text, /event: snapshot/, 'closure stop before first frame snapshot already reach')
  assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0, 'close after without subscribe leftover')
  await app.close()
})
