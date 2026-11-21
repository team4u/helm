/**
 * CLI tests for `skills list/read` scoping flags (`--current`, `--node`+`--cwd`):
 * - No scope flags keeps the Hub global semantics (GET /api/skills, no action calls).
 * - --current reads HELMX_CONVERSATION_ID, resolves the conversation's (nodeId, cwd) via
 *   GET /api/conversations/:id, then posts explicit coordinates only — the action call
 *   never carries conversationId; missing env / missing workspace cwd fail explicitly.
 * - Explicit --node+--cwd travel in the action input verbatim (trusted CLI surface).
 * - Local validation: --node/--cwd pair enforcement, mutual exclusion with --current, empty values.
 * - Boundary validation: malformed skill_catalog/skill_read responses fail explicitly.
 * - Human vs --json rendering for the scoped catalog (scope line, shadowed ids, nodeUnavailable).
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

const CATALOG_ROUTE = 'POST /api/actions/builtin%3Aprofile/skill_catalog'
const READ_ROUTE = 'POST /api/actions/builtin%3Aprofile/skill_read'
const CONVERSATION_42 = 'GET /api/conversations/42?limit=1'
const CONVERSATION_42_BODY = { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' }

const CATALOG_OK = {
  nodeId: 'local',
  cwd: '/srv/work',
  skills: [
    { id: 'helmx-cli', name: 'Helmx CLI', references: [], source: 'data' },
    { id: 'deploy', name: 'Deploy', references: ['refs/runbook.md'], source: 'node' },
  ],
  shadowedNodeSkillIds: ['demo'],
}

test('skills list without scope flags keeps Hub global GET semantics', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills': () => ({ body: [{ id: 'helmx-cli', name: 'Helmx CLI', references: [] }] }),
      [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  // HELMX_CONVERSATION_ID present must NOT reroute an unflagged call
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const actionHits = hub.hits.filter((h) => h.path.includes('/api/actions/'))
  assert.equal(actionHits.length, 0)
  assert.deepEqual(JSON.parse(r.out), [{ id: 'helmx-cli', name: 'Helmx CLI', references: [] }])
})

test('skills list --current resolves conversation coordinates and posts them explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/42?limit=1': () => ({ body: { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' } }),
      [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/actions/builtin%3Aprofile/skill_catalog')!
  assert.ok(hit, 'skill_catalog action must be called')
  // Explicit coordinates only: the action call never carries conversation context
  assert.deepEqual(hit.body, { input: { nodeId: 'node-a', cwd: '/srv/work' } })
  assert.deepEqual(JSON.parse(r.out), CATALOG_OK)
})

test('skills list --current defaults a missing conversation nodeId to local', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/5?limit=1': () => ({ body: { id: 5, title: 'local chat', cwd: '/home/me/proj' } }),
      [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '5' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST')!
  assert.deepEqual(hit.body, { input: { nodeId: 'local', cwd: '/home/me/proj' } })
})

test('skills list --current fails explicitly when the conversation has no bound cwd', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7?limit=1': () => ({ body: { id: 7, title: 'bare', cwd: '' } }),
      [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'conversation_without_cwd')
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/actions/')).length, 0)
})

test('skills list --current without HELMX_CONVERSATION_ID fails explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({ [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'current_conversation_missing')
  assert.equal(hub.hits.length, 0)
})

test('skills list --node+--cwd posts explicit coordinates without conversationId', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({ [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }) }, { autoRegisterCleanup: t })
  // Even inside a managed turn, explicit coordinates never attach conversation context
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '9' })
  const r = await runCliCaptured(['skills', 'list', '--node', 'node-a', '--cwd', '/srv/work', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST')!
  assert.deepEqual(hit.body, { input: { nodeId: 'node-a', cwd: '/srv/work' } })
})

test('skills list --node and --cwd must appear as a pair', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({ [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
  const onlyNode = await runCliCaptured(['skills', 'list', '--node', 'node-a', '--json'], env)
  assert.equal(parseCliError(onlyNode).code, 'missing_required_flag')
  const onlyCwd = await runCliCaptured(['skills', 'list', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(onlyCwd).code, 'missing_required_flag')
  assert.equal(hub.hits.length, 0)
})

test('skills list --current conflicts with explicit --node/--cwd', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({ [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--node', 'node-a', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(r).code, 'conflicting_flags')
  assert.equal(hub.hits.length, 0)
})

test('skills list rejects empty --node/--cwd values locally', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({ [CATALOG_ROUTE]: () => ({ body: CATALOG_OK }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['skills', 'list', '--node', '  ', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(r).code, 'invalid_flag_value')
  assert.equal(hub.hits.length, 0)
})

test('skills list human output renders scope, shadowed ids, and nodeUnavailable diagnostics', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      [CATALOG_ROUTE]: () => ({ body: { ...CATALOG_OK, nodeUnavailable: 'node node-a is offline' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes('scope: node=local cwd=/srv/work'), r.out)
  assert.ok(r.out.includes('deploy'), 'merged skill table must list node skills')
  assert.ok(r.out.includes('node skills shadowed by same-name Hub/agents versions: demo'), r.out)
  assert.ok(r.out.includes('node skill library unavailable: node node-a is offline'), r.out)
})

test('skills list fails explicitly on malformed skill_catalog responses', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      [CATALOG_ROUTE]: () => ({ body: { nodeId: 'local', cwd: '/w', skills: 'nope', shadowedNodeSkillIds: [] } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'invalid_response')
})

test('skills read --current posts resolved coordinates with skillId and prints text', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/42?limit=1': () => ({ body: { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' } }),
      [READ_ROUTE]: () => ({ body: { text: '# node skill manual' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'deploy', '--current'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith('# node skill manual'))
  const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/actions/builtin%3Aprofile/skill_read')!
  assert.deepEqual(hit.body, { input: { nodeId: 'node-a', cwd: '/srv/work', skillId: 'deploy' } })
})

test('skills read --node+--cwd passes path in the action input; --json echoes {text}', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    { [READ_ROUTE]: () => ({ body: { text: 'runbook content' } }) },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(
    ['skills', 'read', 'deploy', '--path', 'refs/runbook.md', '--node', 'node-a', '--cwd', '/srv/work', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'POST')!
  assert.deepEqual(hit.body, {
    input: { nodeId: 'node-a', cwd: '/srv/work', skillId: 'deploy', path: 'refs/runbook.md' },
  })
  assert.deepEqual(JSON.parse(r.out), { text: 'runbook content' })
})

test('skills read scoped fails explicitly on malformed skill_read responses', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      [READ_ROUTE]: () => ({ body: { text: 42 } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'deploy', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'invalid_response')
})

test('skills read stays on GET /api/skills/:id when no scope flags are passed', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills/demo': () => ({ body: { text: 'hub skill' } }),
      [READ_ROUTE]: () => ({ body: { text: 'node skill' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'demo'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith('hub skill'))
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/actions/')).length, 0)
})
