/**
 * helm nodes forward command contract test: real HTTP server simulated Hub
 * (cli-nodes-env.test.ts same style pattern), verify POST/DELETE path, request body,
 * parameter validate (host:port parse/IPv6 parentheses/bare port), error exit code and --json.
 * end-to-end (real Hub + daemon + byte forwarding) see kernel integration test.
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

/** complete forwarding conversation shape (mock unify use). */
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

/** by default forwarding event stream (started + stopped normal terminal state, can by explicit routing override). */
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

test('nodes forward:POST create forwarding (request body field strictly mapping) after event stream unexpected assert stream non-zero exit', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-a/forward': (body) => {
        assert.deepEqual(body, { listenHost: '127.0.0.1', listenPort: 18080, targetHost: 'db.internal', targetPort: 5432 })
        return { status: 201, body: { ...SESSION } }
      },
      // events override: only started frame i.e. assert (without stopped terminal state - - unexpected assert stream).
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
  assert.equal(result.code, 1, 'unexpected assert stream (without stopped terminal state) should non-zero exit')
  assert.match(result.err, /forwarding event stream already end/)
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined, 'should start create forwarding POST')
  const del = hub.hits.find((h) => h.method === 'DELETE')
  assert.ok(del !== undefined, 'assert stream after should explicit DELETE forwarding')
})

test('nodes forward: bare target port by default 127.0.0.1;IPv6 listen parentheses parse', { timeout: 60_000 }, async (t) => {
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
  assert.equal(result.code, 0, 'IPv6 listen + by default stopped terminal state normal exit 0')
  const post = hub.hits.find((h) => h.method === 'POST')
  assert.ok(post !== undefined)
})

test('nodes forward: parameter validate (missing location parameter/broken port/bare listen port reject)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
  for (const [argv, pattern] of [
    [['nodes', 'forward'], /missing node target|location parameter/],
    // without nodeId and without --current(first reference i.e. listen address)→ missing node target.
    [['nodes', 'forward', '127.0.0.1:18080', '8080'], /missing node target|--current/],
    [['nodes', 'forward', 'node-a'], /missing.*listenHost/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:18080'], /missing.*targetHost/],
    [['nodes', 'forward', 'node-a', '18080', '8080'], /host:port|listen address/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:0', '8080'], /port must be 1..65535/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:99999', '8080'], /port must be 1..65535/],
    [['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'abc'], /port number|host:port/],
  ] as [string[], RegExp][]) {
    const result = await runCliCaptured(argv, env)
    assert.equal(result.code, 1, `${argv.join(' ')} should non-zero exit`)
    assert.match(result.err, pattern, `${argv.join(' ')} error information`)
  }
  assert.equal(hub.hits.length, 0, 'all in CLI side reject, do not reach Hub')
})

test('nodes forward:Hub validation failed (400 validation_error) such as exit non-zero', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/node-c/forward': () => ({
        status: 400,
        body: { error: { code: 'validation_error', message: 'listenPort must be 1..65535 security integer' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(['nodes', 'forward', 'node-c', '127.0.0.1:18080', '8080'], makeCliEnv(hub.url, dir))
  assert.equal(result.code, 1)
  assert.match(result.err, /validation_error|listenPort/)
})

test('nodes forward: receives stopped terminal state exit 0(person class and --json same right identify terminal state)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  for (const json of [false, true]) {
    const hub = await startMockHub({
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      // DELETE return 404(Hub already stop forwarding, idempotent):CLI must contain tolerate.
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'forwarding missing or already stop' } },
      }),
    })
    try {
      const argv = ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432', ...(json ? ['--json'] : [])]
      const result = await runCliCaptured(argv, makeCliEnv(hub.url, dir))
      assert.equal(result.code, 0, `stopped terminal state should exit 0(json=${json})`)
      if (json) assert.match(result.out, /"type":"stopped"/, '--json still output stopped frame')
    } finally {
      await hub.close()
    }
  }
})

test('nodes forward: stop clean up failed (non- 404) explicit non-zero, do not fake report succeeded', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-forward-')
  const hub = await startMockHub(
    {
      ...defaultForwardEventsRoute,
      'POST /api/nodes/node-a/forward': () => ({ status: 201, body: { ...SESSION } }),
      [`DELETE /api/nodes/forward/${SESSION.forwardId}`]: () => ({
        status: 502,
        body: { error: { code: 'node_tunnel_connect_failed', message: 'node lose join' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const result = await runCliCaptured(
    ['nodes', 'forward', 'node-a', '127.0.0.1:18080', 'db.internal:5432'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(result.code, 1, 'clean up failed must non-zero exit')
  assert.match(result.err, /forward_cleanup_failed|stop clean up failed/, 'explicit diagnose clean up failed')
})

test('nodes forward:--current from HELM_NODE_ID parse node; and explicit nodeId mutual exclusion', { timeout: 60_000 }, async (t) => {
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
  assert.ok(post !== undefined && post.path.includes('from-env'), '--current parse HELM_NODE_ID')
  void result
  // mutual exclusion: explicit nodeId and --current.
  const both = await runCliCaptured(['nodes', 'forward', 'node-a', '--current', '127.0.0.1:18080', '5432'], env)
  assert.equal(both.code, 1)
  assert.match(both.err, /mutual exclusion/)
  // missing HELM_NODE_ID.
  const missing = await runCliCaptured(['nodes', 'forward', '--current', '127.0.0.1:18080', '5432'], base)
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELM_NODE_ID/)
})

test('nodes forwards / forward-inspect / forward-stop: same right mapping and --json', { timeout: 60_000 }, async (t) => {
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

  // forwards manifest.
  const listJson = await runCliCaptured(['nodes', 'forwards', '--json'], env)
  assert.equal(listJson.code, 0)
  assert.match(listJson.out, /fwd-11111111/)
  const listHuman = await runCliCaptured(['nodes', 'forwards'], env)
  assert.equal(listHuman.code, 0)
  assert.match(listHuman.out, /forwardId/)

  // forward-inspect detail situation.
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

  // illegal forwardId form in CLI side reject.
  const bad = await runCliCaptured(['nodes', 'forward-stop', 'not-a-uuid'], env)
  assert.equal(bad.code, 1)
  assert.match(bad.err, /fwd-<uuid>/)
})
