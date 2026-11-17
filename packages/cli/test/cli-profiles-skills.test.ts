/**
 * CLI tests for `profiles --skills/--all-skills`: mock HTTP server simulating Hub contract.
 * Covers allowlist writes in create/update, [] disabling all skills, --all-skills removing the key,
 * mutual exclusion and invalid list local validation, merge preserving node/cwd/runtime/tags,
 * --input full replacement vs merge, --json output, and --help text.
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

/** Mock existing Profile on Hub (includes runtime/tags/nodeId/cwd and prior skills allowlist). */
const EXISTING_WORKER = {
  id: 'worker',
  name: 'Worker',
  model: 'faux/model',
  thinkingLevel: 'medium',
  nodeId: 'node-a',
  cwd: '/srv/work',
  tags: ['ci'],
  runtime: { kind: 'herdr', agent: 'pi', nodeId: 'node-a', workspace: '/srv/work' },
  skills: ['git-commit', 'herdr'],
  system: '# SYSTEM',
}

test('profiles create --skills: writes allowlist to body; [] disables all skills', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['profiles', 'create', 'reviewer', '--name', 'Reviewer', '--skills', '["git-commit"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/profiles')!
  assert.deepEqual(hit.body, { id: 'reviewer', name: 'Reviewer', skills: ['git-commit'] })
  assert.deepEqual(JSON.parse(r.out), { id: 'reviewer', name: 'Reviewer', skills: ['git-commit'] })

  // Empty array = explicitly disable all skills (key must exist as [], never dropped or set undefined)
  const empty = await runCliCaptured(['profiles', 'create', 'minimal', '--skills', '[]', '--json'], env)
  assert.equal(empty.code, 0, empty.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { id: 'minimal', skills: [] })
})

test('profiles update --skills: GET-merges and replaces only skills while keeping nodeId/cwd/runtime/tags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--skills', '["git-commit"]', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')!
  assert.deepEqual(put.body, {
    id: 'worker',
    name: 'Worker',
    model: 'faux/model',
    thinkingLevel: 'medium',
    nodeId: 'node-a',
    cwd: '/srv/work',
    tags: ['ci'],
    runtime: EXISTING_WORKER.runtime,
    skills: ['git-commit'],
  })
  // Full system text returned by GET is stripped and not echoed back (MEMORY.md is managed by builtin:memory)
  const body = put.body as Record<string, unknown>
  assert.equal('system' in body, false)
})

test('profiles update --skills "[]": passes empty array through (disables all without dropping key)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--skills', '[]', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual((put.body as Record<string, unknown>).skills, [])
  // Remaining bindings are preserved
  assert.equal((put.body as Record<string, unknown>).nodeId, 'node-a')
  assert.equal((put.body as Record<string, unknown>).cwd, '/srv/work')
})

test('profiles update --all-skills: deletes merged skills key to restore all available skills', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--all-skills', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  const body = put.body as Record<string, unknown>
  assert.equal('skills' in body, false, 'skills key must be deleted (undefined = all skills)')
  assert.equal(body.nodeId, 'node-a')
  assert.equal(body.cwd, '/srv/work')
  assert.deepEqual(body.runtime, EXISTING_WORKER.runtime)
  assert.deepEqual(body.tags, ['ci'])
})

test('--skills and --all-skills mutual exclusion: create/update reject locally with conflicting_flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const create = await runCliCaptured(['profiles', 'create', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(create.code, 1)
  assert.equal(parseCliError(create).code, 'conflicting_flags')
  assert.equal(hub.hits.filter((h) => h.path === '/api/profiles').length, 0, 'mutual exclusion must reject before sending HTTP request')

  const update = await runCliCaptured(['profiles', 'update', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(update.code, 1)
  assert.equal(parseCliError(update).code, 'conflicting_flags')
})

test('invalid --skills list rejected locally: non-string array / non-array JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const numbers = await runCliCaptured(['profiles', 'create', 'x', '--skills', '[1,2]', '--json'], env)
  assert.equal(numbers.code, 1)
  assert.equal(parseCliError(numbers).code, 'invalid_flag_value')

  const mixed = await runCliCaptured(['profiles', 'create', 'x', '--skills', '["a",1]', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'invalid_flag_value')

  const notArray = await runCliCaptured(['profiles', 'create', 'x', '--skills', '"git-commit"', '--json'], env)
  assert.equal(notArray.code, 1)
  assert.equal(parseCliError(notArray).code, 'invalid_flag_value')

  const update = await runCliCaptured(['profiles', 'update', 'x', '--skills', '{"a":1}', '--json'], env)
  assert.equal(update.code, 1)
  assert.equal(parseCliError(update).code, 'invalid_flag_value')
})

test('--input preserves full-replacement semantics; semantic flags override matching fields when combined', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'PUT /api/profiles/solo': (body) => ({ body }) }, { autoRegisterCleanup: t })

  // --input alone: full replacement, skills passed as-is (omitting skills keeps it undefined)
  const whole = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"name":"Solo","nodeId":"node-b","cwd":"/w"}', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(whole.code, 0, whole.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual(put.body, { name: 'Solo', nodeId: 'node-b', cwd: '/w', id: 'solo' })
  assert.equal(hub.hits.some((h) => h.method === 'GET'), false, 'pure --input does not trigger GET merge')

  // --input with skills + --skills: semantic flag overrides matching field
  const hub2 = await startMockHub(
    {
      'GET /api/profiles/solo': () => ({ body: { id: 'solo', name: 'Solo', skills: ['old'] } }),
      'PUT /api/profiles/solo': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env2 = makeCliEnv(hub2.url, dir)
  const combined = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"name":"Solo","skills":["from-input"]}', '--skills', '["git-commit"]', '--json'],
    env2,
  )
  assert.equal(combined.code, 0, combined.err)
  const put2 = hub2.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual((put2.body as Record<string, unknown>).skills, ['git-commit'])

  // --input with skills + --all-skills: merge layer sets it, semantic layer deletes the key -> no skills key
  const withAll = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"skills":["from-input"]}', '--all-skills', '--json'],
    env2,
  )
  assert.equal(withAll.code, 0, withAll.err)
  const put3 = hub2.hits.filter((h) => h.method === 'PUT').at(-1)!
  assert.equal('skills' in (put3.body as Record<string, unknown>), false)
})

test('--help and --json output: help shows --skills/--all-skills, --json echoes Hub response', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const createHelp = await runCliCaptured(['profiles', 'create', '--help'], env)
  assert.equal(createHelp.code, 0)
  assert.match(createHelp.out, /--skills <json>/)
  assert.match(createHelp.out, /--all-skills <boolean>/)
  assert.match(createHelp.out, /mutually exclusive/)

  const updateHelp = await runCliCaptured(['profiles', 'update', '--help'], env)
  assert.equal(updateHelp.code, 0)
  assert.match(updateHelp.out, /--skills <json>/)
  assert.match(updateHelp.out, /--all-skills <boolean>/)

  // --json outputs raw Hub response (including skills field)
  const r = await runCliCaptured(['profiles', 'create', 'bot', '--skills', '["git-commit","herdr"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { id: 'bot', skills: ['git-commit', 'herdr'] })
})
