/**
 * helm profiles --starters semantics flag test:
 * - create/update carry starters array,update merge do not lose other field;
 * - [] empty semantics (explicit write empty array, non- delete key);
 * - illegal value (non- array/shape error/over limit) in HTTP before local reject (hub without hit).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

test('profiles create --starters: array enter body;--json same right output', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(
    [
      'profiles', 'create', 'helper', '--name', 'assist manually',
      '--starters', '[{"label":"write day report","prompt":"please generate now day day report"}]',
      '--json',
    ],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  const posted = hub.hits.find((h) => h.method === 'POST')?.body as Record<string, unknown>
  assert.deepEqual(posted.starters, [{ label: 'write day report', prompt: 'please generate now day day report' }])
  assert.equal(posted.name, 'assist manually')
})

test('profiles update --starters: first GET merge, not trigger and field (runtime/nodeId/tags) do not lose,[] explicit empty', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const existing = {
    id: 'worker',
    name: 'work person',
    model: 'openai/gpt-4o',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy' },
    starters: [{ label: 'old quote lead', prompt: 'old hint' }],
  }
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: existing }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // semantics flag path:GET merge after PUT,starters replace,runtime/nodeId/tags keep
  const r = await runCliCaptured(
    ['profiles', 'update', 'worker', '--starters', '[{"label":"new quote lead","prompt":"new hint"}]', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(put.starters, [{ label: 'new quote lead', prompt: 'new hint' }])
  assert.deepEqual(put.runtime, existing.runtime)
  assert.equal(put.nodeId, 'gpu-box')
  assert.deepEqual(put.tags, ['worker'])

  // [] empty: explicit write empty array (is not delete key, is not restore old value)
  hub.hits.length = 0
  const clear = await runCliCaptured(['profiles', 'update', 'worker', '--starters', '[]', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  const putClear = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putClear.starters, [])
  assert.deepEqual(putClear.runtime, existing.runtime)

  // other flag do not lose starters:GET base bottom merge keep
  hub.hits.length = 0
  const rename = await runCliCaptured(['profiles', 'update', 'worker', '--name', 'new name', '--json'], env)
  assert.equal(rename.code, 0, rename.err)
  const putRename = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putRename.starters, [{ label: 'old quote lead', prompt: 'old hint' }])
  assert.equal(putRename.name, 'new name')
})

test('profiles --starters: illegal value in HTTP before reject (without hub hit)', { timeout: 60_000 }, async (t) => {
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
    [['profiles', 'create', 'w', '--starters', '{"label":"x","prompt":"y"}'], /--starters must be JSON array/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x"}]'], /prompt must be a string/],
    [['profiles', 'create', 'w', '--starters', '[{"label":" ","prompt":"y"}]'], /label cannot be empty after trimming/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x","prompt":""}]'], /prompt cannot be pure whitespace/],
    [
      ['profiles', 'create', 'w', '--starters', JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `s${i}`, prompt: 'p' })))],
      /--starters at most 6 items/,
    ],
    [['profiles', 'update', 'w', '--starters', '[{"label":"x","prompt":"y","extra":1}]'], /only accept label and prompt field/],
  ]
  for (const [argv, pattern] of bad) {
    const r = await runCliCaptured(argv, env)
    assert.notEqual(r.code, 0, `should non-zero exit: ${argv.join(' ')}`)
    assert.match(r.err, pattern)
  }
  // validation failed occur in HTTP before:hub zero hit
  assert.equal(hub.hits.length, 0, `validate should occur in HTTP before, actual hit ${JSON.stringify(hub.hits)}`)
})
