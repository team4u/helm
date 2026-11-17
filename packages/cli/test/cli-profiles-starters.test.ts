/**
 * Tests for `helm profiles --starters` semantic flag:
 * - create/update sends starters array and update merge preserves untouched fields;
 * - [] clears starters explicitly (writes empty array rather than deleting key);
 * - invalid values (non-array / wrong shape / over limit) reject locally before sending HTTP requests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

test('profiles create --starters: writes array to body and prints JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(
    [
      'profiles', 'create', 'helper', '--name', 'Assistant',
      '--starters', '[{"label":"Daily report","prompt":"Please write today\'s daily report"}]',
      '--json',
    ],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  const posted = hub.hits.find((h) => h.method === 'POST')?.body as Record<string, unknown>
  assert.deepEqual(posted.starters, [{ label: 'Daily report', prompt: "Please write today's daily report" }])
  assert.equal(posted.name, 'Assistant')
})

test('profiles update --starters: GET-merges while keeping runtime/nodeId/tags; [] clears explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const existing = {
    id: 'worker',
    name: 'Worker',
    model: 'openai/gpt-4o',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy' },
    starters: [{ label: 'Old starter', prompt: 'Old prompt' }],
  }
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: existing }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // Semantic flag path: GET-merge before PUT, replaces starters and preserves runtime/nodeId/tags
  const r = await runCliCaptured(
    ['profiles', 'update', 'worker', '--starters', '[{"label":"New starter","prompt":"New prompt"}]', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(put.starters, [{ label: 'New starter', prompt: 'New prompt' }])
  assert.deepEqual(put.runtime, existing.runtime)
  assert.equal(put.nodeId, 'gpu-box')
  assert.deepEqual(put.tags, ['worker'])

  // [] clears starters: explicitly writes empty array (neither deletes key nor keeps old value)
  hub.hits.length = 0
  const clear = await runCliCaptured(['profiles', 'update', 'worker', '--starters', '[]', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  const putClear = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putClear.starters, [])
  assert.deepEqual(putClear.runtime, existing.runtime)

  // Other flags preserve existing starters via GET merge
  hub.hits.length = 0
  const rename = await runCliCaptured(['profiles', 'update', 'worker', '--name', 'New Name', '--json'], env)
  assert.equal(rename.code, 0, rename.err)
  const putRename = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putRename.starters, [{ label: 'Old starter', prompt: 'Old prompt' }])
  assert.equal(putRename.name, 'New Name')
})

test('profiles --starters: invalid values reject locally before any HTTP calls', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { id: 'worker' } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
      'POST /api/profiles': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const bad: Array<[string[], RegExp]> = [
    [['profiles', 'create', 'w', '--starters', '{"label":"x","prompt":"y"}'], /--starters must be a JSON array/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x"}]'], /prompt must be a string/],
    [['profiles', 'create', 'w', '--starters', '[{"label":" ","prompt":"y"}]'], /label cannot be empty after trimming/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x","prompt":""}]'], /prompt cannot be whitespace-only/],
    [
      ['profiles', 'create', 'w', '--starters', JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `s${i}`, prompt: 'p' })))],
      /--starters supports at most 6 items/,
    ],
    [['profiles', 'update', 'w', '--starters', '[{"label":"x","prompt":"y","extra":1}]'], /only accepts label and prompt fields/],
  ]
  for (const [argv, pattern] of bad) {
    const r = await runCliCaptured(argv, env)
    assert.notEqual(r.code, 0, `expected non-zero exit: ${argv.join(' ')}`)
    assert.match(r.err, pattern)
  }
  // Validation runs before HTTP requests: zero Hub hits
  assert.equal(hub.hits.length, 0, `validation should run before HTTP, got ${JSON.stringify(hub.hits)}`)
})
