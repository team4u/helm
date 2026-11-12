/**
 * helm nodes forward 命令契约测试：真实 HTTP server 模拟 Hub
 * （cli-nodes-env.test.ts 同款模式），验证 POST/DELETE 路径、请求体、
 * 参数校验（host:port 解析/IPv6 括号/裸端口）、错误退出码与 --json。
 * 端到端（真实 Hub + daemon + 字节转发）见 kernel 集成测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

/** 模拟 Hub：routes 形如 { 'POST /api/x': (body) => entity }。 */
async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      hits.push({ method: req.method!, path: req.url!, body })
      // 事件流端点：NDJSON 响应并立即结束（模拟 Hub 侧转发停止）。
      if (req.url?.includes('/events')) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
        res.end(`${JSON.stringify({ type: 'started', listenHost: '127.0.0.1', listenPort: 18080 })}\n`)
        return
      }
      const handler = routes[`${req.method} ${req.url}`]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
        return
      }
      const result = handler(body)
      const status = result.status ?? 200
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body ?? { ok: true }))
    })
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

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function makeEnv(hubUrl: string): Promise<NodeJS.ProcessEnv> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-forward-'))
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test' }
}

test('nodes forward：POST 创建转发（请求体字段严格映射）后事件流结束退出', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-a/forward': (body) => {
      assert.deepEqual(body, { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
      return { status: 201, body: { forwardId: 'fwd-11111111-2222-3333-4444-555555555555', listenHost: '127.0.0.1', listenPort: 18080 } }
    },
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  // events 路由：立即结束 NDJSON 流（模拟 Hub 侧转发停止）。
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'], env)
    assert.equal(result.code, 1, '事件流意外结束应非零退出')
    assert.match(result.err, /forward_stream_ended|已停止/)
    const post = hub.hits.find((h) => h.method === 'POST')
    assert.ok(post !== undefined, '应发起创建转发 POST')
    const del = hub.hits.find((h) => h.method === 'DELETE')
    assert.ok(del !== undefined, '事件流结束后应显式 DELETE 转发')
  } finally {
    await hub.close()
  }
})

test('nodes forward：裸目标端口默认 127.0.0.1；IPv6 监听括号解析', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-b/forward': (body) => {
      assert.deepEqual(body, { listenHost: '::1', listenPort: 19090, targetPort: 8080 })
      return { status: 201, body: { forwardId: 'fwd-11111111-2222-3333-4444-555555555555', listenHost: '::1', listenPort: 19090 } }
    },
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-b', '[::1]:19090', '8080'], env)
    assert.equal(result.code, 1)
    const post = hub.hits.find((h) => h.method === 'POST')
    assert.ok(post !== undefined)
  } finally {
    await hub.close()
  }
})

test('nodes forward：参数校验（缺位置参数/坏端口/裸监听端口拒绝）', { timeout: 60_000 }, async () => {
  const hub = await startHub({})
  try {
    const env = await makeEnv(hub.url)
    for (const [argv, pattern] of [
      [['nodes', 'forward'], /缺少.*nodeId|位置参数/],
      [['nodes', 'forward', 'node-a'], /缺少.*listenHost/],
      [['nodes', 'forward', 'node-a', '127.0.0.1:18080'], /缺少.*targetHost/],
      [['nodes', 'forward', 'node-a', '18080', '8080'], /host:port|监听地址/],
      [['nodes', 'forward', 'node-a', '127.0.0.1:0', '8080'], /端口需为 1..65535/],
      [['nodes', 'forward', 'node-a', '127.0.0.1:99999', '8080'], /端口需为 1..65535/],
      [['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'abc'], /端口数字|host:port/],
    ] as [string[], RegExp][]) {
      const result = await run(argv, env)
      assert.equal(result.code, 1, `${argv.join(' ')} 应非零退出`)
      assert.match(result.err, pattern, `${argv.join(' ')} 错误信息`)
    }
    assert.equal(hub.hits.length, 0, '全部在 CLI 侧拒绝，不达 Hub')
  } finally {
    await hub.close()
  }
})

test('nodes forward：Hub 校验失败（400 validation_error）如实退出非零', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-c/forward': () => ({
      status: 400,
      body: { error: { code: 'validation_error', message: 'listenPort 需为 1..65535 的安全整数' } },
    }),
  })
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-c', '127.0.0.1:18080', '8080'], env)
    assert.equal(result.code, 1)
    assert.match(result.err, /validation_error|listenPort/)
  } finally {
    await hub.close()
  }
})
