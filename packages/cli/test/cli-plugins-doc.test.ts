/**
 * CLI plugin document command test:plugins doc --conversation/--current/--watch.
 * simulated Hub HTTP contract (real fetch boundary + real SSE response), verify:
 * - path/query parameter piece together install and --json same right;
 * - --conversation and --current mutual exclusion;
 * - --current read HELM_CONVERSATION_ID;
 * - --watch consume dedicated use SSE(snapshot + incremental frame);
 * - 404 structure error original through out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

test('plugins doc --conversation: piece together install conversationId query string and --json original output', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const docBody = { pluginId: 'p:sd', name: 'metrics', conversationId: 7, value: { n: 3 } }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=7': () => ({ body: docBody }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), docBody)
  assert.equal(hub.hits.length, 1)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=7')
  assert.equal(hub.hits[0]!.authorization, 'Bearer t-test')
})

test('plugins doc --current: read HELM_CONVERSATION_ID; and --conversation mutual exclusion errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const docBody = { pluginId: 'p:sd', name: 'metrics', conversationId: 42, value: 'text-value' }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=42': () => ({ body: docBody }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '42' })
  const res = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--current', '--json'], env)
  assert.equal(res.code, 0, res.err)
  assert.deepEqual(JSON.parse(res.out), docBody)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=42')

  // mutual exclusion: explicit non-zero exit code
  const conflict = await runCliCaptured(
    ['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--current', '--json'],
    env,
  )
  assert.notEqual(conflict.code, 0)
  assert.equal(parseCliError(conflict).code, 'conflicting_flags')
  assert.equal(hub.hits.length, 1, 'mutual exclusion failed produces no extra request')
})

test('plugins doc --watch: subscribe dedicated use SSE,snapshot and incremental frame all output (NDJSON)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const snapshot = { seq: 1, doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 1 } } }
  const delta = { seq: 2, event: { type: 'plugin.session_doc.updated', doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 2 } } } }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics/events?conversationId=1': () => ({
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: plugin.session_doc.updated\ndata: ${JSON.stringify(delta)}\n\n`,
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '1' })
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--current', '--watch', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.length, 1)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics/events?conversationId=1')
  assert.match(r.out, /"event":"snapshot"|"seq":1/)
  assert.match(r.out, /plugin\.session_doc\.updated/)
  assert.match(r.out, /"n":2/)
})

test('plugins doc --watch missing conversation target: explicit errors do not create connect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--watch', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'missing_conversation_target')
  assert.equal(hub.hits.length, 0)
})

test('plugins doc 404 structure error through out (plugin deactivate/conversation delete:CLI stop retry based on)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=9': () => ({
        status: 404,
        body: { error: { code: 'plugin_doc_not_found', message: 'plugin p:sd without public conversation document metrics' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '9', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'plugin_doc_not_found')
  assert.equal(hub.hits.length, 1)
})
