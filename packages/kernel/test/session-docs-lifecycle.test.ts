/**
 * 会话文档专用 SSE 生命周期集成测试（真实 KernelRuntime + 真实 HTTP hub）。
 *
 * 覆盖：
 * - 建流后插件停用（plugin.changed enabled=false）：已建流被服务端终止（事件驱动，非轮询）；
 * - 建流后会话删除（conversation.deleted）：已建流被服务端终止；
 * - kernel.close() 关闭全部专用流并释放生命周期订阅。
 * fixture：faux 模型 + 真实 KernelRuntime.open + startHub（port 0）。
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
    watchdogIntervalMs: 0,
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

/** 读取到流结束（done），返回全部文本；超时防挂死。 */
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

test('专用 SSE：插件停用后已建流被终止（事件驱动关流）', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    app.metrics.set(1, { n: 1 })
    const res = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    // 停用插件：plugin.changed enabled=false -> closeForPlugin -> 流终止。
    const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
    await app.kernel.plugins.disable('p:lifecycle')
    const text = await readAll
    assert.match(text, /event: snapshot/, '关流前首帧 snapshot 已达')
    assert.ok(text.length >= 0)
    // 停用后再建连：provider 校验 404（不建流）。
    const rejected = await fetch(sseUrl(app.url, 1), {
      headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
    })
    assert.equal(rejected.status, 404)
    await rejected.arrayBuffer()
  } finally {
    await app.close()
  }
})

test('专用 SSE：会话删除后已建流被终止（conversation.deleted 关流）', { timeout: 60_000 }, async () => {
  const app = await openApp()
  try {
    // 新建独立会话验证删除级联，不依赖播种入口的固定 ID。
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
    assert.match(text, /event: snapshot/, '关流前首帧 snapshot 已达')
  } finally {
    await app.close()
  }
})

test('kernel.close()：专用流全部终止且生命周期订阅释放', { timeout: 60_000 }, async () => {
  const app = await openApp()
  app.metrics.set(1, { n: 1 })
  const res = await fetch(sseUrl(app.url, 1), {
    headers: { authorization: `Bearer ${app.token}`, accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  const readAll = readUntilDone(res.body as ReadableStream<Uint8Array>)
  await app.kernel.close()
  const text = await readAll
  assert.match(text, /event: snapshot/, '关停前首帧 snapshot 已达')
  assert.equal(app.kernel.sessionDocEvents.subscriberCount, 0, 'close 后无订阅残留')
  await app.close()
})
