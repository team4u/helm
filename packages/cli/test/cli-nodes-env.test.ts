/**
 * new increase core command test:nodes / env exec / api escape generate cabin / conversations --node /
 * profiles semantics flag / plugins config --set / manage side fault isolated.
 * real HTTP server simulated Hub contract (cli.test.ts same style pattern), verify path, method,
 * request body, exit code semantics and --json / person class can read output. each items explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { coreCommands } from '../src/commands/index.js'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
  waitFor,
} from './helpers/cli-harness.js'

const LOCAL_HEALTH = {
  collectedAt: 1730000000000,
  uptimeSec: 86400,
  loadAvg: [0.5, 0.25, 0.125],
  memFreeBytes: 8 * 1024 ** 3,
  memTotalBytes: 32 * 1024 ** 3,
  diskFreeBytes: 100 * 1024 ** 3,
  diskTotalBytes: 512 * 1024 ** 3,
}

const BYOM_HEALTH = {
  collectedAt: 1730000001000,
  uptimeSec: 43200,
  loadAvg: [1.5, 1.25, 1.125],
  memFreeBytes: 16 * 1024 ** 3,
  memTotalBytes: 64 * 1024 ** 3,
}

const NODE_LIST = [
  { id: 'local', kind: 'local', online: true, hostname: 'box-a', platform: 'linux', health: LOCAL_HEALTH },
  {
    id: 'gpu-box',
    kind: 'byom',
    online: true,
    hostname: 'gpu',
    platform: 'linux',
    connectedAt: 1,
    lastSeenAt: 2,
    health: BYOM_HEALTH,
  },
  { id: 'laptop', kind: 'byom', online: false, hostname: 'mbp', platform: 'darwin' },
]

// ---------------------------------------------------------------------------
// 1. nodes list / issue / remove
// ---------------------------------------------------------------------------

test('nodes list:GET /api/nodes;--json original array, person class pattern key list format', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: NODE_LIST }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['nodes', 'list', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), NODE_LIST)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes')
  assert.equal(hub.hits.at(-1)?.method, 'GET')

  const human = await runCliCaptured(['nodes', 'list'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /gpu-box/)
  assert.match(human.out, /byom/)
  assert.match(human.out, /false/)
  assert.match(human.out, /hostname/)
  assert.match(human.out, /platform/)
})

test('nodes list --json: pass-through node health health snapshot (local and online BYOM; offline node without health key)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: NODE_LIST }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['nodes', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const nodes = JSON.parse(r.out) as Array<{ id: string; health?: Record<string, unknown> }>
  // local node: complete health snapshot original pass-through.
  const local = nodes.find((n) => n.id === 'local')!
  assert.deepEqual(local.health, LOCAL_HEALTH, 'local health snapshot must original pass-through (contains disk field)')
  // online BYOM node: heartbeat/register incidentally snapshot original pass-through (missing disk field when must not fabricate).
  const byom = nodes.find((n) => n.id === 'gpu-box')!
  assert.deepEqual(byom.health, BYOM_HEALTH, 'online BYOM health snapshot must original pass-through')
  assert.equal('diskFreeBytes' in (byom.health ?? {}), false, 'not on report disk field must not fabricate')
  // offline node: leaves no residue expired health.
  const offline = nodes.find((n) => n.id === 'laptop')!
  assert.equal(offline.health, undefined, 'offline node must not leftover expired health')
  assert.equal('health' in offline, false)
})

test('nodes issue:POST /api/nodes/issue {nodeId};--json all amount, person class pattern sudden out token', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const issued = { nodeId: 'dev-1', token: 'dev-1:sec-abc', createdAt: 123 }
  const hub = await startMockHub({ 'POST /api/nodes/issue': () => ({ body: issued }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['nodes', 'issue', 'dev-1', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), issued)
  assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'dev-1' })

  const human = await runCliCaptured(['nodes', 'issue', 'dev-1'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /dev-1:sec-abc/)
  assert.match(human.out, /helm-node connect/)

  // missing location parameter explicit errors
  const missing = await runCliCaptured(['nodes', 'issue', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_id')
})

test('nodes remove:DELETE /api/nodes/:id; redundant location parameter reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub({ 'DELETE /api/nodes/gpu-box': () => ({ status: 204 }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['nodes', 'remove', 'gpu-box', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.at(-1)?.method, 'DELETE')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box')
  assert.equal(hub.hits.at(-1)?.body, undefined)

  const stray = await runCliCaptured(['nodes', 'remove', 'gpu-box', 'extra', '--json'], env)
  assert.equal(stray.code, 1)
  assert.equal(parseCliError(stray).code, 'unexpected_positional')
})

// ---------------------------------------------------------------------------
// 2. env exec
// ---------------------------------------------------------------------------

test('env exec:--node/--cwd/--timeout/--current all amount mapping body; succeeded exit code 0', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['env', 'exec', '--node', 'gpu-box', '--cwd', '/workspace', '--timeout', '5000', '--current', '--', 'pytest', '-q'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }),
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, '3 passed\n')
  const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
  assert.equal(hit.method, 'POST')
  assert.deepEqual(hit.body, {
    command: ['pytest', '-q'],
    nodeId: 'gpu-box',
    cwd: '/workspace',
    timeoutMs: 5000,
    conversationId: 9,
  })

  // --json output complete JSON response (--json must in -- before:-- after all is command term items)
  const json = await runCliCaptured(['env', 'exec', '--json', '--', 'true'], makeCliEnv(hub.url, dir))
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false })
})

test('env exec: failed command (exitCode!==0) non-zero exit code;timeout / ok=false same failed', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': (body) => {
        const cmd = (body as { command: string[] }).command
        if (cmd[0] === 'failing') return { body: { ok: true, exitCode: 2, output: 'boom\n', timedOut: false } }
        if (cmd[0] === 'timeout-cmd') return { body: { ok: false, exitCode: null, output: '', timedOut: true } }
        return { body: { ok: true, exitCode: 0, output: 'fine\n', timedOut: false } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const failed = await runCliCaptured(['env', 'exec', '--', 'failing', 'x'], env)
  assert.equal(failed.code, 2)
  assert.equal(failed.out, 'boom\n')
  assert.match(failed.err, /exitCode=2/)

  const failedJson = await runCliCaptured(['env', 'exec', '--json', '--', 'failing'], env)
  assert.equal(failedJson.code, 2)
  assert.equal(JSON.parse(failedJson.out).exitCode, 2)
  assert.equal(parseCliError(failedJson).code, 'env_exec_failed')

  const timedOut = await runCliCaptured(['env', 'exec', '--', 'timeout-cmd'], env)
  assert.equal(timedOut.code, 1)
  assert.match(timedOut.err, /timeout/)

  const ok = await runCliCaptured(['env', 'exec', '--', 'true'], env)
  assert.equal(ok.code, 0)
})

test('env exec: single command string (contains space) original pass-through; missing command/illegal timeout explicit errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: '', timedOut: false } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const shell = await runCliCaptured(['env', 'exec', '--', 'echo hello && echo world'], env)
  assert.equal(shell.code, 0, shell.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: 'echo hello && echo world' })

  // -- after term items (contains --json style token) all is command one part, do not by when act global switch
  const literal = await runCliCaptured(['env', 'exec', '--', 'echo', '--json'], env)
  assert.equal(literal.code, 0, literal.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['echo', '--json'] })

  const missing = await runCliCaptured(['env', 'exec', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_command_target')

  const badTimeout = await runCliCaptured(['env', 'exec', '--json', '--timeout', '-5', '--', 'true'], env)
  assert.equal(badTimeout.code, 1)
  assert.equal(parseCliError(badTimeout).code, 'invalid_flag_value')

  // exceeds cap 600000(and backend POST /api/env/exec validate align) in CLI side directly reject:validation_error + exit code 2
  const overTimeout = await runCliCaptured(['env', 'exec', '--json', '--timeout', '600001', '--', 'true'], env)
  assert.equal(overTimeout.code, 2)
  assert.equal(parseCliError(overTimeout).code, 'validation_error')
  assert.match(overTimeout.err, /600000/)
  // request not to Hub(CLI side first row intercept)
  assert.ok(!hub.hits.some((h) => h.path === '/api/env/exec' && (h.body as { timeoutMs?: number } | undefined)?.timeoutMs === 600001))

  // exactly 600000 legal (boundary contains end)
  const boundary = await runCliCaptured(['env', 'exec', '--json', '--timeout', '600000', '--', 'true'], env)
  assert.equal(boundary.code, 0, boundary.err)
  assert.equal((hub.hits.filter((h) => h.path === '/api/env/exec').at(-1)?.body as { timeoutMs?: number }).timeoutMs, 600000)
})

test('env exec --current: not pass --node when request body do not strong stuff nodeId, by Hub by conversation bind set parse', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: 'ok\n', timedOut: false } }),
    },
    { autoRegisterCleanup: t },
  )
  const envWithConv = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' })

  // --current and without --node:body only contains command and conversationId, absolute without nodeId:'local'(guard against mistakenly run Hub local machine)
  const r = await runCliCaptured(['env', 'exec', '--current', '--', 'git', 'status'], envWithConv)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
  assert.deepEqual(hit.body, { command: ['git', 'status'], conversationId: 12 })
  assert.ok(!('nodeId' in (hit.body as Record<string, unknown>)), 'not pass --node when must not strong stuff nodeId(contains local)')
  assert.ok(!('cwd' in (hit.body as Record<string, unknown>)), 'not pass --cwd when must not override conversation bind set cwd')

  // explicit --node still takes precedence (override conversation bind set)
  const explicit = await runCliCaptured(['env', 'exec', '--current', '--node', 'gpu-box', '--', 'nvidia-smi'], envWithConv)
  assert.equal(explicit.code, 0, explicit.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['nvidia-smi'], nodeId: 'gpu-box', conversationId: 12 })

  // without --current without --node: same do not strong stuff (Hub default local)
  const plain = await runCliCaptured(['env', 'exec', '--', 'ls'], makeCliEnv(hub.url, dir))
  assert.equal(plain.code, 0, plain.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['ls'] })
})

test('env exec --stream:NDJSON one by one chunk consume (do not buffer all response); failed exitCode pass broadcast', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  // one by one chunk write out many frame (multiple chunk write socket, verify CLI do not etc. all response only then start consume)
  const hub = await startMockHub(
    {
      'POST /api/env/exec': (body, _req, res) => {
        assert.equal((body as { stream?: boolean }).stream, true)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'line1\n' })}\n`)
        res.write(`${JSON.stringify({ type: 'output', stream: 'stderr', text: 'warn\n' })}\n`)
        setTimeout(() => {
          res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'line2\n' })}\n`)
          res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false })}\n`)
        }, 25)
        return null
      },
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['env', 'exec', '--stream', '--node', 'gpu-box', '--', 'build'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'line1\nwarn\nline2\n')
  const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
  assert.deepEqual(hit.body, { command: ['build'], nodeId: 'gpu-box', stream: true })
  await hub.close()

  // failed exitCode via exit frame pass broadcast is non-zero exit code
  const hub2 = await startMockHub(
    {
      'POST /api/env/exec': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 3, timedOut: false })}\n`)
        return null
      },
    },
    { autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['env', 'exec', '--stream', '--', 'failing'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 3)
  assert.equal(failed.out, '')
  assert.match(failed.err, /exitCode=3/)
})

test('env exec --stream --json: output frame one by one row JSON, terminal state frame all amount;SIGINT cancel pass broadcast', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'step1\n' })}\n`)
        res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false })}\n`)
        return null
      },
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['env', 'exec', '--stream', '--json', '--', 'build'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const lines = r.out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(lines[0], { type: 'output', stream: 'stdout', text: 'step1\n' })
  assert.deepEqual(lines[1], { type: 'exit', ok: true, exitCode: 0, timedOut: false })
  // streaming request body carry stream: true
  assert.equal((hub.hits.find((h) => h.path === '/api/env/exec')?.body as { stream?: boolean }).stream, true)
})

// ---------------------------------------------------------------------------
// 3. conversations create/update --node
// ---------------------------------------------------------------------------

test('conversations create/update:--node mapping body.nodeId; original has flag do not subject to affect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': (body) => ({ body: { id: 7, ...(body as object) } }),
      'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...(body as object) } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const created = await runCliCaptured(
    ['conversations', 'create', '--node', 'gpu-box', '--cwd', '/workspace', '--title', 'train', '--json'],
    env,
  )
  assert.equal(created.code, 0, created.err)
  assert.deepEqual(hub.hits.find((h) => h.path === '/api/conversations')?.body, {
    nodeId: 'gpu-box',
    cwd: '/workspace',
    title: 'train',
  })

  // original flag combine keep original semantics (--tags/--model/--profile-id)
  const full = await runCliCaptured(
    ['conversations', 'create', '--profile-id', 'worker', '--model', 'openai/gpt', '--tags', 'a,b', '--json'],
    env,
  )
  assert.equal(full.code, 0, full.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { profileId: 'worker', model: 'openai/gpt', tags: ['a', 'b'] })

  const updated = await runCliCaptured(['conversations', 'update', '7', '--node', 'gpu-box', '--json'], env)
  assert.equal(updated.code, 0, updated.err)
  assert.deepEqual(hub.hits.find((h) => h.method === 'PATCH')?.body, { nodeId: 'gpu-box' })

  // update --node and other field can combine
  const combo = await runCliCaptured(['conversations', 'update', '7', '--node', 'laptop', '--cwd', '/x', '--pinned', '--json'], env)
  assert.equal(combo.code, 0, combo.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'laptop', cwd: '/x', pinned: true })
})

// ---------------------------------------------------------------------------
// 4. profiles semantics flag
// ---------------------------------------------------------------------------

test('profiles create: semantics flag(--name/--model/--node/--cwd) directly construct Profile', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(
    ['profiles', 'create', 'worker', '--name', 'work person', '--model', 'openai/gpt-4o', '--node', 'gpu-box', '--cwd', '/workspace', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), {
    id: 'worker',
    name: 'work person',
    model: 'openai/gpt-4o',
    nodeId: 'gpu-box',
    cwd: '/workspace',
  })
})

test('profiles create:--system-file all text enter body; semantics flag override --input same name segment', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const systemFile = path.join(dir, 'SYSTEM.md')
  await fsp.writeFile(systemFile, '# system\nyou is work person.')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['profiles', 'create', 'worker', '--system-file', systemFile, '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as Record<string, unknown>
  assert.equal(body['system'], '# system\nyou is work person.')

  // --input is base bottom, semantics flag override for should field (name/model by override,cwd keep)
  const merged = await runCliCaptured(
    [
      'profiles', 'create',
      '--input', '{"id":"x","name":"base bottom","model":"old/m","cwd":"/base","extra":1}',
      '--name', 'override name', '--model', 'new/m',
      '--json',
    ],
    env,
  )
  assert.equal(merged.code, 0, merged.err)
  assert.deepEqual(JSON.parse(merged.out), {
    id: 'x',
    name: 'override name',
    model: 'new/m',
    cwd: '/base',
    extra: 1,
  })

  // all missing errors
  const none = await runCliCaptured(['profiles', 'create', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_update_fields')
})

test('profiles update: semantics flag first GET merge after PUT(whole replace contract guard against lose field)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  // since has complete config: contains nodeId/cwd/tags/runtime etc. bind set field and system/memory all text
  const existing = {
    id: 'worker',
    name: 'old name',
    model: 'old/m',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['a', 'b'],
    runtime: { kind: 'herdr', agent: 'agy' },
    system: '# system prompt all text',
  }
  let putBody: unknown
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: existing }),
      'PUT /api/profiles/worker': (body) => {
        putBody = body
        return { body }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // only change --model:GET first at PUT, and PUT body keep all bind set field (nodeId/cwd/tags/runtime)
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--model', 'anthropic/sonnet', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const getHit = hub.hits.find((h) => h.method === 'GET' && h.path === '/api/profiles/worker')
  const putHit = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')
  assert.ok(getHit, 'semantics flag path must first GET complete Profile')
  assert.ok(putHit, 'then PUT merge result')
  assert.ok(hub.hits.indexOf(getHit!) < hub.hits.indexOf(putHit!), 'GET must first at PUT')
  assert.deepEqual(putBody, {
    id: 'worker',
    name: 'old name',
    model: 'anthropic/sonnet',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['a', 'b'],
    runtime: { kind: 'herdr', agent: 'agy' },
  })
  // GET carries back system all text must not back pass (not explicit to out when)
  assert.ok(!('system' in (putBody as Record<string, unknown>)))

  // only change --name same do not lose nodeId(guard against conversation mistakenly run local regression key)
  const rename = await runCliCaptured(['profiles', 'update', 'worker', '--name', 'new name', '--json'], env)
  assert.equal(rename.code, 0, rename.err)
  const lastPut = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.equal(lastPut['name'], 'new name')
  assert.equal(lastPut['nodeId'], 'gpu-box')
  assert.equal(lastPut['cwd'], '/workspace')
  assert.ok(!('system' in lastPut))
})

test('profiles update: explicit --system enter body;--input and semantics flag combine stable merge', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const existing = {
    id: 'worker',
    name: 'base bottom',
    model: 'old/m',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    system: 'old system prompt',
  }
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: existing }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // explicit --system override (MEMORY.md by builtin:memory plugin manage, do not via Profile)
  const r = await runCliCaptured(
    ['profiles', 'update', 'worker', '--system', 'new system prompt', '--node', 'laptop', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const body = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.equal(body['system'], 'new system prompt')
  assert.equal(body['nodeId'], 'laptop')
  assert.equal(body['name'], 'base bottom')

  // --input + semantics flag combine: with GET base bottom + --input override + flag override, field do not lose
  const merged = await runCliCaptured(
    [
      'profiles', 'update', 'worker',
      '--input', '{"name":"Chinese name","cwd":"/new-cwd"}',
      '--model', 'new/m',
      '--json',
    ],
    env,
  )
  assert.equal(merged.code, 0, merged.err)
  const body2 = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.deepEqual(body2, {
    id: 'worker',
    name: 'Chinese name',
    model: 'new/m',
    nodeId: 'gpu-box', // GET base bottom keep, not lose
    cwd: '/new-cwd', // --input override
  })
})

test('profiles update --input separate use: all amount replace semantics (without GET);GET 404 such as on throw', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'PUT /api/profiles/worker': (body) => ({ body }),
      'GET /api/profiles/ghost': () => ({ status: 404, body: { error: { code: 'not_found', message: 'without this Profile' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // --input separate use = explicit all amount replace: do not GET,body i.e. --input + id
  const whole = await runCliCaptured(
    ['profiles', 'update', 'worker', '--input', '{"name":"all amount","model":"m"}', '--json'],
    env,
  )
  assert.equal(whole.code, 0, whole.err)
  assert.ok(!hub.hits.some((h) => h.method === 'GET' && h.path === '/api/profiles/worker'), 'pure --input must not GET')
  assert.deepEqual(hub.hits.at(-1)?.body, { name: 'all amount', model: 'm', id: 'worker' })

  // semantics flag target missing:GET 404 error message seal such as on throw (do not fabricate base bottom blind change)
  const ghost = await runCliCaptured(['profiles', 'update', 'ghost', '--name', 'x', '--json'], env)
  assert.equal(ghost.code, 1)
  assert.equal(parseCliError(ghost).code, 'not_found')

  // all missing errors
  const none = await runCliCaptured(['profiles', 'update', 'worker', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_update_fields')
})

// ---------------------------------------------------------------------------
// 5. plugins config --set
// ---------------------------------------------------------------------------

test('plugins config --set:key=value can duplicate, mark amount semantics parse; and --input shared store override same key', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/builtin%3Aherdr/config': () => ({ body: { values: { retries: 3 }, schema: {} } }),
      'PUT /api/plugins/builtin%3Aherdr/config': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(
    ['plugins', 'config', 'builtin:herdr', '--set', 'retries=5', '--set', 'verbose=true', '--set', 'label=herdr host', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.at(-1)?.method, 'PUT')
  assert.deepEqual(hub.hits.at(-1)?.body, {
    values: { retries: 5, verbose: true, label: 'herdr host' },
  })

  // --set override --input same key, keep the rest key
  const merged = await runCliCaptured(
    ['plugins', 'config', 'builtin:herdr', '--input', '{"retries":9,"other":"keep"}', '--set', 'retries=1', '--json'],
    env,
  )
  assert.equal(merged.code, 0, merged.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { values: { retries: 1, other: 'keep' } })

  // without --set and without --input: keep GET semantics
  const get = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--json'], env)
  assert.equal(get.code, 0, get.err)
  assert.equal(hub.hits.at(-1)?.method, 'GET')
  assert.deepEqual(JSON.parse(get.out), { values: { retries: 3 }, schema: {} })

  // illegal --set(without =) explicit errors
  const bad = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--set', 'novalue', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

// ---------------------------------------------------------------------------
// 6. api escape generate cabin
// ---------------------------------------------------------------------------

test('api GET: large small write do not sensitive,path automatically patch complete before lead /;--field construct POST body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'GET /api/nodes': () => ({ body: NODE_LIST }),
      'POST /api/nodes/issue': () => ({ body: { nodeId: 'dev-1', token: 'dev-1:s', createdAt: 1 } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // method small write + path carries before lead /
  const list = await runCliCaptured(['api', 'get', '/api/nodes', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.deepEqual(JSON.parse(list.out), NODE_LIST)

  // method mixed large small write + path do not carries before lead /
  const list2 = await runCliCaptured(['api', 'Get', 'api/nodes', '--json'], env)
  assert.equal(list2.code, 0, list2.err)
  assert.equal(hub.hits.at(-1)?.method, 'GET')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes')

  const issue = await runCliCaptured(['api', 'POST', '/api/nodes/issue', '--field', 'nodeId=dev-1', '--json'], env)
  assert.equal(issue.code, 0, issue.err)
  assert.equal(hub.hits.at(-1)?.method, 'POST')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/issue')
  assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'dev-1' })

  // illegal method explicit errors
  const bad = await runCliCaptured(['api', 'TRACE', '/api/nodes', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('api PUT --field mark amount semantics (number/boolean/string);--input whole body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      'PUT /api/profiles/p1': (body) => ({ body }),
      'PUT /api/providers': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const fields = await runCliCaptured(
    ['api', 'put', 'api/profiles/p1', '--field', 'n=42', '--field', 'ok=false', '--field', 's=pure text', '--json'],
    env,
  )
  assert.equal(fields.code, 0, fields.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { n: 42, ok: false, s: 'pure text' })

  const whole = await runCliCaptured(['api', 'PUT', '/api/providers', '--input', '[{"id":"g"}]', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.hits.at(-1)?.body, [{ id: 'g' }])
})

// ---------------------------------------------------------------------------
// 7. manage side fault isolated:/api/actions 500 when core command still 100% available
// ---------------------------------------------------------------------------

test('manage side fault isolated:GET /api/actions 500 when nodes/env/plugins etc. core command per common execute', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub(
    {
      // manifest end point blast (simulated broken plugin drag collapse action total line)
      'GET /api/actions': () => ({ status: 500, body: { error: { code: 'internal_error', message: 'broken plugin manifest' } } }),
      'GET /api/nodes': () => ({ body: NODE_LIST }),
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: 'ok\n', timedOut: false } }),
      'POST /api/plugins/builtin%3Aevil/disable': () => ({ body: { ok: true } }),
      'GET /api/conversations': () => ({ body: [] }),
      'GET /api/profiles': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // core command precise match i.e. execute: never because /api/actions 500 block assert
  const nodes = await runCliCaptured(['nodes', 'list', '--json'], env)
  assert.equal(nodes.code, 0, nodes.err)
  assert.deepEqual(JSON.parse(nodes.out), NODE_LIST)

  const exec = await runCliCaptured(['env', 'exec', '--', 'echo', 'hi'], env)
  assert.equal(exec.code, 0, exec.err)
  assert.equal(exec.out, 'ok\n')

  const disable = await runCliCaptured(['plugins', 'disable', 'builtin:evil', '--json'], env)
  assert.equal(disable.code, 0, disable.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

  const convs = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(convs.code, 0, convs.err)
  assert.deepEqual(JSON.parse(convs.out), [])

  const profiles = await runCliCaptured(['profiles', 'list', '--json'], env)
  assert.equal(profiles.code, 0, profiles.err)

  // api escape generate cabin same do not subject to affect
  const api = await runCliCaptured(['api', 'GET', '/api/nodes', '--json'], env)
  assert.equal(api.code, 0, api.err)

  // only truly motion state command path only then pull /api/actions and explicit errors (error message seal pass-through 500)
  const dynamic = await runCliCaptured(['some', 'plugin', 'action', '--json'], env)
  assert.equal(dynamic.code, 1)
  assert.equal(parseCliError(dynamic).code, 'internal_error')
})

test('env exec --stream: cancel pass broadcast - - already to frame already consume,aborted non-zero exit, server side immediately aware disconnect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const seenDisconnect = { value: false }
  // NDJSON end point: first out one frame after suspended; connect disconnect immediately placement (verify CLI cancel i.e. assert stream, do not continue pull)
  const hub = await startMockHub(
    {
      'POST /api/env/exec': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'frame-1\n' })}\n`)
        res.on('close', () => {
          seenDisconnect.value = true
        })
        return null // forever do not actively end: only client cancel only then assert
      },
    },
    { autoRegisterCleanup: t },
  )
  const ac = new AbortController()
  // via Io.fetchImpl inject replace body: first frame consume after immediately abort(etc. price SIGINT  aborted error path)
  const r = await runCliCaptured(['env', 'exec', '--stream', '--', 'sleep', '10'], makeCliEnv(hub.url, dir), {
    onStdout: (chunk) => {
      if (chunk.includes('frame-1')) queueMicrotask(() => ac.abort())
    },
    fetch: (input, init) => fetch(input, { ...init, signal: ac.signal }),
  })
  assert.equal(r.code, 130, `exit code must be 130(SIGINT convention), got ${r.code},stderr=${r.err}`)
  assert.equal(r.out, 'frame-1\n', 'cancel before already to frame must already consume (true one by one chunk, non- buffer)')
  assert.match(r.err, /cancelled/)
  await waitFor(() => seenDisconnect.value, {
    timeoutMs: 2_000,
    intervalMs: 10,
    message: 'cancel must immediately assert stream, do not continue pull',
  })
})

test('help text contains nodes/env/api command note;nodes command family do not and motion state command conflict', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /nodes list/)
  assert.match(help.out, /nodes issue/)
  assert.match(help.out, /nodes remove/)
  assert.match(help.out, /env exec/)
  assert.match(help.out, /api <method> <path>/)

  // nodes list even if has same name motion state declaration (if manifest preempt) also by core execute - - already by fault isolated test override
  const nodes = await runCliCaptured(['nodes', 'list'], env)
  assert.equal(nodes.code, 0, nodes.err)
  assert.match(nodes.out, /\(empty\)/)
})

// ---------------------------------------------------------------------------
// 8. static command table uniqueness assertion (guard against not come new increase command collide path by matchCommand exact[0] static default swallow)
// ---------------------------------------------------------------------------

test('static command table:coreCommands path all etc. unique and mutual do not is prefix conflict', { timeout: 60_000 }, () => {
  const commands = coreCommands() // internal already validate, duplicate/prefix conflict will throw command_table_conflict
  const paths = commands.map((c) => c.path.join(' '))
  assert.equal(new Set(paths).size, paths.length, `static command path duplicate:${JSON.stringify(paths)}`)
  // mutual do not is prefix: relatively short path must not is any relatively long path header sequence
  for (const cmd of commands) {
    for (const other of commands) {
      if (cmd === other || other.path.length >= cmd.path.length) continue
      const isPrefix = other.path.every((seg, i) => seg === cmd.path[i])
      assert.equal(isPrefix, false, `command prefix conflict:"${cmd.path.join(' ')}" will obscure "${other.path.join(' ')}"`)
    }
  }
})

// ---------------------------------------------------------------------------
// 9. cli-token lock race: empty/half truncate lock file wide limit heavy read, stale leftover such as judge corrupt
// ---------------------------------------------------------------------------

test('cli-token lock: empty lock file just create do not long treated as holder is now write, wait for after succeeded; stale empty lock such as report credentials_lock_broken', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const lockFile = path.join(dir, 'cli-token.lock')
  // scenario 1: simulated old platform fallback first create empty file after write content slow holder: occupy empty lock (fresh mtime),
  // 150ms after holder write full owner row (override at least one round 100ms wide limit backoff),350ms after release. competition way in wide limit window inside wait for heavy read, never mistakenly kill concurrency.
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const holderOwner = `${process.pid} holder-uuid`
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${holderOwner}\n`).catch(() => {}) }, 150)
  const releaseTimer = setTimeout(() => { void fsp.rm(lockFile, { force: true }).catch(() => {}) }, 350)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:1', token: 'tok' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok')
  // lock and temp file leaves no residue
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])

  // scenario 2: stale empty lock (mtime exceeds wide limit window and without person patch write)→ such as throw credentials_lock_broken, never static default when without lock
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await fsp.utimes(lockFile, old, old)
  await assert.rejects(
    updateCliCredentials(dir, { token: 'tok2' }),
    (err: unknown) => err instanceof CliError && err.code === 'credentials_lock_broken',
  )
})

test('cli-token lock: half truncate lock content same subject to wide limit window protect, wait for holder after completion succeeded', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-nodes-')
  const lockFile = path.join(dir, 'cli-token.lock')
  // half truncate content (first token non- PID)+ slow holder in wide limit window inside patch write complete owner row then release
  await fsp.writeFile(lockFile, 'garbage ', { mode: 0o600 })
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${process.pid} filler\n`).catch(() => {}) }, 150)
  const releaseTimer = setTimeout(() => { void fsp.rm(lockFile, { force: true }).catch(() => {}) }, 300)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-half' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-half')
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})
