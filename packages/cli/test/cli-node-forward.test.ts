/**
 * Contract tests for `helmx nodes forward`: mock HTTP server simulating Hub
 * (same pattern as cli-nodes-env.test.ts), verifying POST/DELETE routes,
 * request bodies, argument validation (host:port parsing / IPv6 brackets / bare port),
 * error exit codes, and --json.
 * End-to-end forwarding (real Hub + daemon + byte relay) lives in kernel integration tests.
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

/** Complete forward session shape shared across mocks. */
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

/** Default forward event stream (started + stopped clean exit; overridden by explicit routes when needed). */
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

test('nodes forward: POST creates forward with exact body mapping; unexpected stream drop exits non-zero', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-a/forward': (body) => {
        assert.deepEqual(body, { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
        return { status: 201, body: { ...SESSION } }
      },
      // Override events route: ends right after started frame with no stopped terminal event.
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
  assert.equal(result.code, 1, 'unexpected stream drop without stopped frame must exit non-zero')
  assert.match(result.err, /forwarding event stream ended/)
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined, 'should send POST to create forward')
  const del = hub.hits.find((h) => h.method === 'DELETE')
  assert.ok(del !== undefined, 'should explicitly DELETE forward after stream drop')
})

test('nodes forward: bare target port defaults to 127.0.0.1; IPv6 bracketed listen address parsed', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
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
  assert.equal(result.code, 0, 'IPv6 listen + default stopped terminal frame exits 0')
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined)
})

test('nodes forward: argument validation rejects missing positionals, bad ports, and bare listen port', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
  for (const [argv, pattern] of [
    [['nodes', 'forward'], /missing node target|positional argument/],
    // No nodeId and no --current (first arg is listen address) -> missing node target.
    [['nodes', 'forward', '127.0.0.1:18080', '8080'], /missing node target|--current/],
    [['nodes', 'forward', 'node-a'], /missing.*listenHost/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:18080'], /missing.*targetHost/],
    [['nodes', 'forward', 'node-a', '18080', '8080'], /host:port|listen address/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:0', '8080'], /port must be in 1\.\.65535/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:99999', '8080'], /port must be in 1\.\.65535/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'abc'], /port number|host:port/],
  ] as [string[], RegExp][]) {
    const result = await runCliCaptured(argv, env)
    assert.equal(result.code, 1, `${argv.join(' ')} should exit non-zero`)
    assert.match(result.err, pattern, `${argv.join(' ')} error message`)
  }
  assert.equal(hub.hits.length, 0, 'all validation failures must happen on CLI before hitting Hub')
})

test('nodes forward: Hub validation error (400 validation_error) exits non-zero', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-c/forward': () => ({
        status: 400,
        body: { error: { code: 'validation_error', message: 'listenPort must be a safe integer in 1..65535' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(['nodes', 'forward', 'node-c', '127.0.0.1:18080', '8080'], makeCliEnv(hub.url, dir))
  assert.equal(result.code, 1)
  assert.match(result.err, /validation_error|listenPort/)
})

test('nodes forward: exits 0 on stopped terminal event (both human and --json modes)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  for (const json of [false, true]) {
    const hub = await startMockHub({
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      // DELETE returning 404 (Hub already stopped forwarding, idempotent): CLI must tolerate it.
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'forward does not exist or already stopped' } },
      }),
    })
    try {
      const argv = ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432', ...(json ? ['--json'] : [])]
      const result = await runCliCaptured(argv, makeCliEnv(hub.url, dir))
      assert.equal(result.code, 0, `stopped terminal state should exit 0 (json=${json})`)
      if (json) assert.match(result.out, /"type":"stopped"/, '--json still outputs stopped frame')
    } finally {
      await hub.close()
    }
  }
})

test('nodes forward: non-404 cleanup failure exits non-zero without falsely reporting success', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 502,
        body: { error: { code: 'node_tunnel_connect_failed', message: 'node disconnected' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(
    ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(result.code, 1, 'cleanup failure must exit non-zero')
  assert.match(result.err, /forward_cleanup_failed|cleanup failed/, 'explicitly reports cleanup failure')
})

test('nodes forward: --current resolves HELMX_NODE_ID; mutually exclusive with explicit nodeId', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/from-env/forward': () => ({ status: 201, body: { ...SESSION, nodeId: 'from-env' } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const base = makeCliEnv(hub.url, dir)
  const env = { ...base, HELMX_NODE_ID: 'from-env' }
  const result = await runCliCaptured(['nodes', 'forward', '--current', '127.0.0.1:18080', 'db.internal:5432'], env)
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined && post.path.includes('from-env'), '--current resolves HELMX_NODE_ID')
  void result
  // Mutual exclusion: explicit nodeId and --current.
  const both = await runCliCaptured(['nodes', 'forward', 'node-a', '--current', '127.0.0.1:18080', '5432'], env)
  assert.equal(both.code, 1)
  assert.match(both.err, /mutually exclusive/)
  // Missing HELMX_NODE_ID.
  const missing = await runCliCaptured(['nodes', 'forward', '--current', '127.0.0.1:18080', '5432'], base)
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELMX_NODE_ID/)
})

test('nodes forwards / forward-inspect / forward-stop: human output and --json', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-forward-')
  const hub = await startMockHub(
    {
      'GET /api/nodes/forward': () => ({ status: 200, body: [{ ...SESSION }] }),
      [`GET /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ...SESSION } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({ status: 200, body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // forwards list.
  const listJson = await runCliCaptured(['nodes', 'forwards', '--json'], env)
  assert.equal(listJson.code, 0)
  assert.match(listJson.out, /fwd-11111111/)
  const listHuman = await runCliCaptured(['nodes', 'forwards'], env)
  assert.equal(listHuman.code, 0)
  assert.match(listHuman.out, /forwardId/)

  // forward-inspect details.
  const inspectJson = await runCliCaptured(['nodes', 'forward-inspect', SESSION.forwardId, '--json'], env)
  assert.equal(inspectJson.code, 0)
  assert.match(inspectJson.out, /"forwardId"/)
  const inspectHuman = await runCliCaptured(['nodes', 'forward-inspect', SESSION.forwardId], env)
  assert.equal(inspectHuman.code, 0)
  assert.match(inspectHuman.err, /^$/)
  assert.match(inspectHuman.out, /db\.internal:5432/)

  // forward-stop.
  const stop = await runCliCaptured(['nodes', 'forward-stop', SESSION.forwardId], env)
  assert.equal(stop.code, 0)
  const del = hub.hits.find((h) => h.method === 'DELETE')
  assert.ok(del !== undefined)

  // Invalid forwardId format rejected on CLI side.
  const bad = await runCliCaptured(['nodes', 'forward-stop', 'not-a-uuid'], env)
  assert.equal(bad.code, 1)
  assert.match(bad.err, /fwd-<uuid>/)
})
