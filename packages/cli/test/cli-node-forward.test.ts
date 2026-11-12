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
      // 事件流端点：默认 started + stopped 两帧后结束（Hub 正常停止终态）；
      // 测试可显式注册 events 路由覆写（如仅 started 的意外断流）。
      if (req.url?.includes('/events')) {
        const override = routes[`${req.method} ${req.url}`]
        if (override !== undefined) {
          const result = override(body)
          const status = result.status ?? 200
          res.writeHead(status, { 'content-type': 'application/x-ndjson; charset=utf-8' })
          res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? ''))
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
        res.end([
          JSON.stringify({ type: 'started', listenHost: '127.0.0.1', listenPort: 18080 }),
          JSON.stringify({ type: 'stopped' }),
        ].map((line) => `${line}\n`).join(''))
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

test('nodes forward：POST 创建转发（请求体字段严格映射）后事件流意外断流非零退出', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-a/forward': (body) => {
      assert.deepEqual(body, { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
      return { status: 201, body: { forwardId: 'fwd-11111111-2222-3333-4444-555555555555', nodeId: 'node-a', listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432, activeConnections: 0, totalConnections: 0 } }
    },
    // events 覆写：仅 started 帧即断（无 stopped 终态——意外断流）。
    'GET /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555/events': () => ({
      status: 200,
      body: `${JSON.stringify({ type: 'started', listenHost: '127.0.0.1', listenPort: 18080 })}\n`,
    }),
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'], env)
    assert.equal(result.code, 1, '意外断流（无 stopped 终态）应非零退出')
    assert.match(result.err, /转发事件流已结束/)
    const post = hub.hits.find((h) => h.method === 'POST')
    assert.ok(post !== undefined, '应发起创建转发 POST')
    const del = hub.hits.find((h) => h.method === 'DELETE')
    assert.ok(del !== undefined, '断流后应显式 DELETE 转发')
  } finally {
    await hub.close()
  }
})

test('nodes forward：裸目标端口默认 127.0.0.1；IPv6 监听括号解析', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-b/forward': (body) => {
      assert.deepEqual(body, { listenHost: '::1', listenPort: 19090, targetPort: 8080 })
      return { status: 201, body: { forwardId: 'fwd-11111111-2222-3333-4444-555555555555', nodeId: 'node-b', listenHost: '::1', listenPort: 19090, targetHost: '127.0.0.1', targetPort: 8080, activeConnections: 0, totalConnections: 0 } }
    },
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-b', '[::1]:19090', '8080'], env)
    assert.equal(result.code, 0, 'IPv6 监听 + 默认 stopped 终态正常退出 0')
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
      [['nodes', 'forward'], /缺少节点目标|位置参数/],
      // 无 nodeId 且无 --current（首参即 listen 地址）→ 缺节点目标。
      [['nodes', 'forward', '127.0.0.1:18080', '8080'], /缺少节点目标|--current/],
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

/** 完整转发会话形状（mock 统一用）。 */
const SESSION = {
  forwardId: 'fwd-11111111-2222-3333-4444-555555555555',
  nodeId: 'node-a',
  listenHost: '127.0.0.1',
  listenPort: 18080,
  targetHost: 'db.internal',
  targetPort: 5432,
  activeConnections: 0,
  totalConnections: 0,
} as const

test('nodes forward：收到 stopped 终态退出 0（人类与 --json 同权识别终态）', { timeout: 60_000 }, async () => {
  for (const json of [false, true]) {
    const hub = await startHub({
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      // DELETE 返回 404（Hub 已停止转发，幂等）：CLI 必须容忍。
      'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: '转发不存在或已停止' } },
      }),
    })
    try {
      const env = await makeEnv(hub.url)
      const argv = ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432', ...(json ? ['--json'] : [])]
      const result = await run(argv, env)
      assert.equal(result.code, 0, `stopped 终态应退出 0（json=${json}）`)
      if (json) assert.match(result.out, /"type":"stopped"/, '--json 仍输出 stopped 帧')
    } finally {
      await hub.close()
    }
  }
})

test('nodes forward：停止清理失败（非 404）显式非零，不伪报成功', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({
      status: 502,
      body: { error: { code: 'node_tunnel_connect_failed', message: '节点失联' } },
    }),
  })
  try {
    const env = await makeEnv(hub.url)
    const result = await run(['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'], env)
    assert.equal(result.code, 1, '清理失败须非零退出')
    assert.match(result.err, /forward_cleanup_failed|停止清理失败/, '显式诊断清理失败')
  } finally {
    await hub.close()
  }
})

test('nodes forward：--current 从 HELM_NODE_ID 解析节点；与显式 nodeId 互斥', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/nodes/from-env/forward': () => ({ status: 201, body: { ...SESSION, nodeId: 'from-env' } }),
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  try {
    const base = await makeEnv(hub.url)
    const env = { ...base, HELM_NODE_ID: 'from-env' }
    const result = await run(['nodes', 'forward', '--current', '127.0.0.1:18080', 'db.internal:5432'], env)
    const post = hub.hits.find((h) => h.method === 'POST')
    assert.ok(post !== undefined && post.path.includes('from-env'), '--current 解析 HELM_NODE_ID')
    void result
    // 互斥：显式 nodeId 与 --current。
    const both = await run(['nodes', 'forward', 'node-a', '--current', '127.0.0.1:18080', '5432'], env)
    assert.equal(both.code, 1)
    assert.match(both.err, /互斥/)
    // 缺 HELM_NODE_ID。
    const missing = await run(['nodes', 'forward', '--current', '127.0.0.1:18080', '5432'], base)
    assert.equal(missing.code, 1)
    assert.match(missing.err, /HELM_NODE_ID/)
  } finally {
    await hub.close()
  }
})

test('nodes forwards / forward-inspect / forward-stop：同权映射与 --json', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/nodes/forward': () => ({ status: 200, body: [{ ...SESSION }] }),
    'GET /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ...SESSION } }),
    'DELETE /api/nodes/forward/fwd-11111111-2222-3333-4444-555555555555': () => ({ status: 200, body: { ok: true } }),
  })
  try {
    const env = await makeEnv(hub.url)
    // forwards 清单。
    const listJson = await run(['nodes', 'forwards', '--json'], env)
    assert.equal(listJson.code, 0)
    assert.match(listJson.out, /fwd-11111111/)
    const listHuman = await run(['nodes', 'forwards'], env)
    assert.equal(listHuman.code, 0)
    assert.match(listHuman.out, /forwardId/)
    // forward-inspect 详情。
    const inspectJson = await run(['nodes', 'forward-inspect', 'fwd-11111111-2222-3333-4444-555555555555', '--json'], env)
    assert.equal(inspectJson.code, 0)
    assert.match(inspectJson.out, /"forwardId"/)
    const inspectHuman = await run(['nodes', 'forward-inspect', 'fwd-11111111-2222-3333-4444-555555555555'], env)
    assert.equal(inspectHuman.code, 0)
    assert.match(inspectHuman.err, /^$/)
    assert.match(inspectHuman.out, /db\.internal:5432/)
    // forward-stop。
    const stop = await run(['nodes', 'forward-stop', 'fwd-11111111-2222-3333-4444-555555555555'], env)
    assert.equal(stop.code, 0)
    const del = hub.hits.find((h) => h.method === 'DELETE')
    assert.ok(del !== undefined)
    // 非法 forwardId 形式在 CLI 侧拒绝。
    const bad = await run(['nodes', 'forward-stop', 'not-a-uuid'], env)
    assert.equal(bad.code, 1)
    assert.match(bad.err, /fwd-<uuid>/)
  } finally {
    await hub.close()
  }
})
