/**
 * CLI 插件文档命令测试：plugins doc --conversation/--current/--watch。
 * 模拟 Hub HTTP 契约（真实 fetch 边界 + 真实 SSE 响应），验证：
 * - 路径/查询参数拼装与 --json 同权；
 * - --conversation 与 --current 互斥；
 * - --current 读 HELM_CONVERSATION_ID；
 * - --watch 消费专用 SSE（snapshot + 增量帧）；
 * - 404 结构化错误原样透出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  authorization?: string
}

async function startHub(routes: Record<string, () => { status?: number; body?: unknown; type?: 'json' | 'sse' }>): Promise<{
  url: string
  hits: Hit[]
  close: () => Promise<void>
}> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const full = `${req.method} ${req.url}`
    hits.push({ method: req.method!, path: req.url!, authorization: req.headers['authorization'] })
    const handler = routes[full]
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
      return
    }
    const result = handler()
    if (result.type === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: snapshot\ndata: ${JSON.stringify(result.body)}\n\n`)
      res.write(`event: plugin.session_doc.updated\ndata: ${JSON.stringify({ seq: 2, event: { type: 'plugin.session_doc.updated', doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 2 } } } })}\n\n`)
      res.end()
      return
    }
    const status = result.status ?? 200
    if (result.body === undefined) {
      res.writeHead(status)
      res.end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function makeEnv(hubUrl: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-sd-')
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

test('plugins doc --conversation：拼装 conversationId 查询串且 --json 原样输出', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/plugins/p%3Asd/docs/metrics?conversationId=7': () => ({
      body: { pluginId: 'p:sd', name: 'metrics', conversationId: 7, value: { n: 3 } },
    }),
  })
  try {
    const env = await makeEnv(hub.url)
    const code = await runCli(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--json'], { env })
    assert.equal(code, 0)
    assert.equal(hub.hits.length, 1)
    assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=7')
    assert.equal(hub.hits[0]!.authorization, 'Bearer t-test')
  } finally {
    await hub.close()
  }
})

test('plugins doc --current：读 HELM_CONVERSATION_ID；与 --conversation 互斥报错', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/plugins/p%3Asd/docs/metrics?conversationId=42': () => ({
      body: { pluginId: 'p:sd', name: 'metrics', conversationId: 42, value: 'text-value' },
    }),
  })
  try {
    const env = await makeEnv(hub.url, { HELM_CONVERSATION_ID: '42' })
    const code = await runCli(['plugins', 'doc', 'p:sd', 'metrics', '--current', '--json'], { env })
    assert.equal(code, 0)
    assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=42')

    // 互斥：显式非零退出码
    const conflict = await runCli(
      ['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--current', '--json'],
      { env },
    )
    assert.notEqual(conflict, 0)
    assert.equal(hub.hits.length, 1, '互斥失败不产生额外请求')
  } finally {
    await hub.close()
  }
})

test('plugins doc --watch：订阅专用 SSE，snapshot 与增量帧均输出（NDJSON）', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/plugins/p%3Asd/docs/metrics/events?conversationId=1': () => ({
      type: 'sse' as const,
      body: { seq: 1, doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 1 } } },
    }),
  })
  try {
    const env = await makeEnv(hub.url, { HELM_CONVERSATION_ID: '1' })
    const chunks: string[] = []
    const code = await runCli(
      ['plugins', 'doc', 'p:sd', 'metrics', '--current', '--watch', '--json'],
      { env, stdout: (t) => chunks.push(t) },
    )
    assert.equal(code, 0)
    assert.equal(hub.hits.length, 1)
    assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics/events?conversationId=1')
    const out = chunks.join('')
    assert.match(out, /"event":"snapshot"|"seq":1/)
    assert.match(out, /plugin\.session_doc\.updated/)
    assert.match(out, /"n":2/)
  } finally {
    await hub.close()
  }
})

test('plugins doc --watch 缺会话目标：显式报错不建连', { timeout: 60_000 }, async () => {
  const hub = await startHub({})
  try {
    const env = await makeEnv(hub.url)
    const code = await runCli(['plugins', 'doc', 'p:sd', 'metrics', '--watch', '--json'], { env })
    assert.notEqual(code, 0)
    assert.equal(hub.hits.length, 0)
  } finally {
    await hub.close()
  }
})

test('plugins doc 404 结构化错误透出（插件停用/会话删除：CLI 停止重试依据）', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/plugins/p%3Asd/docs/metrics?conversationId=9': () => ({
      status: 404,
      body: { error: { code: 'plugin_doc_not_found', message: '插件 p:sd 无公共会话文档 metrics' } },
    }),
  })
  try {
    const env = await makeEnv(hub.url)
    const code = await runCli(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '9', '--json'], { env })
    assert.notEqual(code, 0)
    assert.equal(hub.hits.length, 1)
  } finally {
    await hub.close()
  }
})
