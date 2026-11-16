/**
 * profiles --skills/--all-skills CLI test: temporary HTTP server simulated Hub contract.
 * override:create/update blank name single write,[] disable,--all-skills delete key restore all,
 * mutual exclusion and illegal list local reject, merge base bottom keep node/cwd/runtime/tags,
 * --input whole replace and combine override,--json output and --help help.
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

/** simulated Hub side already has Profile(contains runtime/tags/nodeId/cwd and old skills blank name single). */
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

test('profiles create --skills: blank name single write body;[] means without skill', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['profiles', 'create', 'reviewer', '--name', 'review member', '--skills', '["git-commit"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/profiles')!
  assert.deepEqual(hit.body, { id: 'reviewer', name: 'review member', skills: ['git-commit'] })
  assert.deepEqual(JSON.parse(r.out), { id: 'reviewer', name: 'review member', skills: ['git-commit'] })

  // empty array = explicit disable all skill (key must store in and is [], must not by discard or rotate undefined)
  const empty = await runCliCaptured(['profiles', 'create', 'minimal', '--skills', '[]', '--json'], env)
  assert.equal(empty.code, 0, empty.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { id: 'minimal', skills: [] })
})

test('profiles update --skills:GET merge after only replace skills,nodeId/cwd/runtime/tags all keep', { timeout: 60_000 }, async (t) => {
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
  // GET carries back system all text do not back pass (strip rule do not change;MEMORY.md by builtin:memory manage)
  const body = put.body as Record<string, unknown>
  assert.equal('system' in body, false)
})

test('profiles update --skills "[]": empty array pass-through (disable all, do not lose key)', { timeout: 60_000 }, async (t) => {
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
  // the rest bind set field still in
  assert.equal((put.body as Record<string, unknown>).nodeId, 'node-a')
  assert.equal((put.body as Record<string, unknown>).cwd, '/srv/work')
})

test('profiles update --all-skills: delete merge after skills key restore all available skill', { timeout: 60_000 }, async (t) => {
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
  assert.equal('skills' in body, false, 'skills key must by delete (undefined = all skill)')
  assert.equal(body.nodeId, 'node-a')
  assert.equal(body.cwd, '/srv/work')
  assert.deepEqual(body.runtime, EXISTING_WORKER.runtime)
  assert.deepEqual(body.tags, ['ci'])
})

test('--skills and --all-skills mutual exclusion:create/update all local reject conflicting_flags(do not request)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const create = await runCliCaptured(['profiles', 'create', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(create.code, 1)
  assert.equal(parseCliError(create).code, 'conflicting_flags')
  assert.equal(hub.hits.filter((h) => h.path === '/api/profiles').length, 0, 'mutual exclusion error must in request before reject')

  const update = await runCliCaptured(['profiles', 'update', 'x', '--skills', '["a"]', '--all-skills', '--json'], env)
  assert.equal(update.code, 1)
  assert.equal(parseCliError(update).code, 'conflicting_flags')
})

test('illegal --skills list local reject: non- string array / non- array JSON', { timeout: 60_000 }, async (t) => {
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

test('--input whole replace semantics keep:skills key original pass-through; and semantics flag combine when override for should field', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'PUT /api/profiles/solo': (body) => ({ body }) }, { autoRegisterCleanup: t })

  // --input separate use: all amount replace,skills original (contains undefined semantics: do not carries skills key)
  const whole = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"name":"Solo","nodeId":"node-b","cwd":"/w"}', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(whole.code, 0, whole.err)
  const put = hub.hits.find((h) => h.method === 'PUT')!
  assert.deepEqual(put.body, { name: 'Solo', nodeId: 'node-b', cwd: '/w', id: 'solo' })
  assert.equal(hub.hits.some((h) => h.method === 'GET'), false, 'pure --input does not trigger GET merge')

  // --input carry skills and --skills same to: semantics flag override for should field
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

  // --input carry skills and --all-skills same to: merge layer first assignment, semantics layer delete key, eventually without skills
  const withAll = await runCliCaptured(
    ['profiles', 'update', 'solo', '--input', '{"skills":["from-input"]}', '--all-skills', '--json'],
    env2,
  )
  assert.equal(withAll.code, 0, withAll.err)
  const put3 = hub2.hits.filter((h) => h.method === 'PUT').at(-1)!
  assert.equal('skills' in (put3.body as Record<string, unknown>), false)
})

test('--help and --json output: help render --skills/--all-skills,JSON output Hub back visible', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-profiles-skills-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const createHelp = await runCliCaptured(['profiles', 'create', '--help'], env)
  assert.equal(createHelp.code, 0)
  assert.match(createHelp.out, /--skills <json>/)
  assert.match(createHelp.out, /--all-skills <boolean>/)
  assert.match(createHelp.out, /mutual exclusion/)

  const updateHelp = await runCliCaptured(['profiles', 'update', '--help'], env)
  assert.equal(updateHelp.code, 0)
  assert.match(updateHelp.out, /--skills <json>/)
  assert.match(updateHelp.out, /--all-skills <boolean>/)

  // --json pattern output Hub response original text (contains skills field)
  const r = await runCliCaptured(['profiles', 'create', 'bot', '--skills', '["git-commit","herdr"]', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { id: 'bot', skills: ['git-commit', 'herdr'] })
})
