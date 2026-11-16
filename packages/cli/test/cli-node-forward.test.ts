/**
 * helm nodes forward 命令契约测试：真实 HTTP server 模拟 Hub
 * （cli-nodes-env.test.ts 同款模式），验证 POST/DELETE 路径、请求体、
 * 参数校验（host:port 解析/IPv6 括号/裸端口）、错误退出码与 --json。
 * 端到端（真实 Hub + daemon + 字节转发）见 kernel 集成测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
  type MockRouteHandler,
} from './helpers/cli-harness.js'

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

/** 默认转发事件流（started + stopped 正常终态，可被显式路由覆盖）。 */
const defaultForwardEventsRoute: Record<string, MockRouteHandler> = {
  [`GET /api/nodes/forward/${SESSION.forwardId}/events`]: () => ({
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    body: [
      JSON.stringify({ type: 'started', listenHost: '127.0.0.1', listenPort: 18080 }),
      JSON.stringify({ type: 'stopped' }),
    ]
      .map((line) => `${line}\n`)
      .join(''),
  }),
}

test('nodes forward：POST 创建转发（请求体字段严格映射）后事件流意外断流非零退出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-a/forward': (body) => {
        assert.deepEqual(body, { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
        return { status: 201, body: { ...SESSION } }
      },
      // events 覆写：仅 started 帧即断（无 stopped 终态——意外断流）。
      [`GET /api/nodes/forward/${SESSION.forwardId}/events`]: () => ({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        body: `${JSON.stringify({ type: 'started', listenHost: '127.0.0.1', listenPort: 18080 })}\n`,
      }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(
    ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(result.code, 1, '意外断流（无 stopped 终态）应非零退出')
  assert.match(result.err, /转发事件流已结束/)
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined, '应发起创建转发 POST')
  const del = hub.hits.find((h) => h.method === 'DELETE')
  assert.ok(del !== undefined, '断流后应显式 DELETE 转发')
})

test('nodes forward：裸目标端口默认 127.0.0.1；IPv6 监听括号解析', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-b/forward': (body) => {
        assert.deepEqual(body, { listenHost: '::1', listenPort: 19090, targetPort: 8080 })
        return { status: 201, body: { ...SESSION, nodeId: 'node-b', listenHost: '::1', listenPort: 19090, targetHost: '127.0.0.1', targetPort: 8080 } }
      },
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(['nodes', 'forward', 'node-b', '[::1]:19090', '8080'], makeCliEnv(hub.url, dir))
  assert.equal(result.code, 0, 'IPv6 监听 + 默认 stopped 终态正常退出 0')
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined)
})

test('nodes forward：参数校验（缺位置参数/坏端口/裸监听端口拒绝）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
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
    const result = await runCliCaptured(argv, env)
    assert.equal(result.code, 1, `${argv.join(' ')} 应非零退出`)
    assert.match(result.err, pattern, `${argv.join(' ')} 错误信息`)
  }
  assert.equal(hub.hits.length, 0, '全部在 CLI 侧拒绝，不达 Hub')
})

test('nodes forward：Hub 校验失败（400 validation_error）如实退出非零', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-c/forward': () => ({
        status: 400,
        body: { error: { code: 'validation_error', message: 'listenPort 需为 1..65535 的安全整数' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(['nodes', 'forward', 'node-c', '127.0.0.1:18080', '8080'], makeCliEnv(hub.url, dir))
  assert.equal(result.code, 1)
  assert.match(result.err, /validation_error|listenPort/)
})

test('nodes forward：收到 stopped 终态退出 0（人类与 --json 同权识别终态）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  for (const json of [false, true]) {
    const hub = await startMockHub({
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      // DELETE 返回 404（Hub 已停止转发，幂等）：CLI 必须容忍。
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: '转发不存在或已停止' } },
      }),
    })
    try {
      const argv = ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432', ...(json ? ['--json'] : [])]
      const result = await runCliCaptured(argv, makeCliEnv(hub.url, dir))
      assert.equal(result.code, 0, `stopped 终态应退出 0（json=${json}）`)
      if (json) assert.match(result.out, /"type":"stopped"/, '--json 仍输出 stopped 帧')
    } finally {
      await hub.close()
    }
  }
})

test('nodes forward：停止清理失败（非 404）显式非零，不伪报成功', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 502,
        body: { error: { code: 'node_tunnel_connect_failed', message: '节点失联' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(
    ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(result.code, 1, '清理失败须非零退出')
  assert.match(result.err, /forward_cleanup_failed|停止清理失败/, '显式诊断清理失败')
})

test('nodes forward：--current 从 HELM_NODE_ID 解析节点；与显式 nodeId 互斥', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/from-env/forward': () => ({ status: 201, body: { ...SESSION, nodeId: 'from-env' } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const base = makeCliEnv(hub.url, dir)
  const env = { ...base, HELM_NODE_ID: 'from-env' }
  const result = await runCliCaptured(['nodes', 'forward', '--current', '127.0.0.1:18080', 'db.internal:5432'], env)
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined && post.path.includes('from-env'), '--current 解析 HELM_NODE_ID')
  void result
  // 互斥：显式 nodeId 与 --current。
  const both = await runCliCaptured(['nodes', 'forward', 'node-a', '--current', '127.0.0.1:18080', '5432'], env)
  assert.equal(both.code, 1)
  assert.match(both.err, /互斥/)
  // 缺 HELM_NODE_ID。
  const missing = await runCliCaptured(['nodes', 'forward', '--current', '127.0.0.1:18080', '5432'], base)
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELM_NODE_ID/)
})

test('nodes forwards / forward-inspect / forward-stop：同权映射与 --json', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      'GET /api/nodes/forward': () => ({ status: 200, body: [{ ...SESSION }] }),
      [`GET /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ...SESSION } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // forwards 清单。
  const listJson = await runCliCaptured(['nodes', 'forwards', '--json'], env)
  assert.equal(listJson.code, 0)
  assert.match(listJson.out, /fwd-11111111/)
  const listHuman = await runCliCaptured(['nodes', 'forwards'], env)
  assert.equal(listHuman.code, 0)
  assert.match(listHuman.out, /forwardId/)

  // forward-inspect 详情。
  const inspectJson = await runCliCaptured(['nodes', 'forward-inspect', SESSION.forwardId, '--json'], env)
  assert.equal(inspectJson.code, 0)
  assert.match(inspectJson.out, /"forwardId"/)
  const inspectHuman = await runCliCaptured(['nodes', 'forward-inspect', SESSION.forwardId], env)
  assert.equal(inspectHuman.code, 0)
  assert.match(inspectHuman.err, /^$/)
  assert.match(inspectHuman.out, /db\.internal:5432/)

  // forward-stop。
  const stop = await runCliCaptured(['nodes', 'forward-stop', SESSION.forwardId], env)
  assert.equal(stop.code, 0)
  const del = hub.hits.find((h) => h.method === 'DELETE')
  assert.ok(del !== undefined)

  // 非法 forwardId 形式在 CLI 侧拒绝。
  const bad = await runCliCaptured(['nodes', 'forward-stop', 'not-a-uuid'], env)
  assert.equal(bad.code, 1)
  assert.match(bad.err, /fwd-<uuid>/)
})
