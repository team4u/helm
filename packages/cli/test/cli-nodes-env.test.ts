/**
 * Core CLI tests for nodes / env exec / api escape hatch / conversations --node /
 * profiles semantic flags / plugins config --set / dynamic-action fault isolation.
 * Uses a real HTTP server mock Hub contract (matching cli.test.ts conventions) to verify
 * paths, methods, request bodies, exit code semantics, and --json / human-readable output.
 * Every test specifies an explicit timeout: 60_000.
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

test('nodes list: GET /api/nodes; --json raw array, human-readable tabular output', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

test('nodes list --json: passes through node health snapshots (local and online BYOM; no health key when offline)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: NODE_LIST }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['nodes', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const nodes = JSON.parse(r.out) as Array<{ id: string; health?: Record<string, unknown> }>
  // Local node: passes through full health snapshot verbatim.
  const local = nodes.find((n) => n.id === 'local')!
  assert.deepEqual(local.health, LOCAL_HEALTH, 'local health snapshot must pass through verbatim (including disk fields)')
  // Online BYOM node: passes through heartbeat/register snapshot verbatim (must not fabricate missing disk fields).
  const byom = nodes.find((n) => n.id === 'gpu-box')!
  assert.deepEqual(byom.health, BYOM_HEALTH, 'online BYOM health snapshot must pass through verbatim')
  assert.equal('diskFreeBytes' in (byom.health ?? {}), false, 'unreported disk fields must not be fabricated')
  // Offline node: leaves no stale health field.
  const offline = nodes.find((n) => n.id === 'laptop')!
  assert.equal(offline.health, undefined, 'offline node must not retain stale health')
  assert.equal('health' in offline, false)
})

test('nodes issue: POST /api/nodes/issue {nodeId}; --json prints full object, human mode outputs token', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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
  assert.match(human.out, /helmx-node connect/)

  // Missing positional argument fails explicitly
  const missing = await runCliCaptured(['nodes', 'issue', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_id')
})

test('nodes remove: DELETE /api/nodes/:id; rejects extra positional arguments', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

test('env exec: maps --node/--cwd/--timeout/--current to body; exits 0 on success', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['env', 'exec', '--node', 'gpu-box', '--cwd', '/workspace', '--timeout', '5000', '--current', '--', 'pytest', '-q'],
    makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '9' }),
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

  // --json prints the full JSON response (--json must precede --; tokens after -- belong to the command)
  const json = await runCliCaptured(['env', 'exec', '--json', '--', 'true'], makeCliEnv(hub.url, dir))
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false })
})

test('env exec: failed command (exitCode !== 0) propagates non-zero exit code; timeout / ok=false also fail', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

test('env exec: passes through single command string (with spaces); rejects missing command or invalid timeout', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

  // Tokens after -- (including flag-like ones such as --json) belong to the command, not global flags
  const literal = await runCliCaptured(['env', 'exec', '--', 'echo', '--json'], env)
  assert.equal(literal.code, 0, literal.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['echo', '--json'] })

  const missing = await runCliCaptured(['env', 'exec', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_command_target')

  const badTimeout = await runCliCaptured(['env', 'exec', '--json', '--timeout', '-5', '--', 'true'], env)
  assert.equal(badTimeout.code, 1)
  assert.equal(parseCliError(badTimeout).code, 'invalid_flag_value')

  // Values above the 600000 ms cap (aligned with POST /api/env/exec) are rejected client-side with validation_error (exit code 2)
  const overTimeout = await runCliCaptured(['env', 'exec', '--json', '--timeout', '600001', '--', 'true'], env)
  assert.equal(overTimeout.code, 2)
  assert.equal(parseCliError(overTimeout).code, 'validation_error')
  assert.match(overTimeout.err, /600000/)
  // Request never reaches Hub (caught at the CLI boundary)
  assert.ok(!hub.hits.some((h) => h.path === '/api/env/exec' && (h.body as { timeoutMs?: number } | undefined)?.timeoutMs === 600001))

  // Exactly 600000 is allowed (inclusive upper bound)
  const boundary = await runCliCaptured(['env', 'exec', '--json', '--timeout', '600000', '--', 'true'], env)
  assert.equal(boundary.code, 0, boundary.err)
  assert.equal((hub.hits.filter((h) => h.path === '/api/env/exec').at(-1)?.body as { timeoutMs?: number }).timeoutMs, 600000)
})

test('env exec --current: omits nodeId when --node is unset so Hub resolves the conversation binding', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: 'ok\n', timedOut: false } }),
    },
    { autoRegisterCleanup: t },
  )
  const envWithConv = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '12' })

  // With --current and without --node: body includes only command and conversationId (never forces nodeId:'local')
  const r = await runCliCaptured(['env', 'exec', '--current', '--', 'git', 'status'], envWithConv)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
  assert.deepEqual(hit.body, { command: ['git', 'status'], conversationId: 12 })
  assert.ok(!('nodeId' in (hit.body as Record<string, unknown>)), 'must not force nodeId (including local) when --node is omitted')
  assert.ok(!('cwd' in (hit.body as Record<string, unknown>)), 'must not override conversation cwd when --cwd is omitted')

  // Explicit --node still takes precedence over conversation binding
  const explicit = await runCliCaptured(['env', 'exec', '--current', '--node', 'gpu-box', '--', 'nvidia-smi'], envWithConv)
  assert.equal(explicit.code, 0, explicit.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['nvidia-smi'], nodeId: 'gpu-box', conversationId: 12 })

  // Without --current or --node: omits nodeId (Hub defaults to local)
  const plain = await runCliCaptured(['env', 'exec', '--', 'ls'], makeCliEnv(hub.url, dir))
  assert.equal(plain.code, 0, plain.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { command: ['ls'] })
})

test('env exec --stream: consumes NDJSON chunk by chunk without buffering the full response; propagates exitCode on failure', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  // Stream multiple chunks over the socket to verify the CLI does not wait for the entire response before printing
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

  // Propagates non-zero exitCode from the terminal exit frame
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

test('env exec --stream --json: emits one JSON line per frame including terminal exit frame', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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
  // Streaming request carries stream: true in body
  assert.equal((hub.hits.find((h) => h.path === '/api/env/exec')?.body as { stream?: boolean }).stream, true)
})

// ---------------------------------------------------------------------------
// 3. conversations create/update --node
// ---------------------------------------------------------------------------

test('conversations create/update: --node maps to body.nodeId while preserving existing flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

  // Existing flags preserve their semantics (--tags/--model/--profile-id)
  const full = await runCliCaptured(
    ['conversations', 'create', '--profile-id', 'worker', '--model', 'openai/gpt', '--tags', 'a,b', '--json'],
    env,
  )
  assert.equal(full.code, 0, full.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { profileId: 'worker', model: 'openai/gpt', tags: ['a', 'b'] })

  const updated = await runCliCaptured(['conversations', 'update', '7', '--node', 'gpu-box', '--json'], env)
  assert.equal(updated.code, 0, updated.err)
  assert.deepEqual(hub.hits.find((h) => h.method === 'PATCH')?.body, { nodeId: 'gpu-box' })

  // update --node combines cleanly with other fields
  const combo = await runCliCaptured(['conversations', 'update', '7', '--node', 'laptop', '--cwd', '/x', '--pinned', '--json'], env)
  assert.equal(combo.code, 0, combo.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'laptop', cwd: '/x', pinned: true })
})

// ---------------------------------------------------------------------------
// 4. profiles semantic flags
// ---------------------------------------------------------------------------

test('profiles create: semantic flags (--name/--model/--node/--cwd) construct Profile directly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(
    ['profiles', 'create', 'worker', '--name', 'Worker', '--model', 'openai/gpt-4o', '--node', 'gpu-box', '--cwd', '/workspace', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), {
    id: 'worker',
    name: 'Worker',
    model: 'openai/gpt-4o',
    nodeId: 'gpu-box',
    cwd: '/workspace',
  })
})

test('profiles create: --system-file reads content into body; semantic flags override matching fields in --input', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const systemFile = path.join(dir, 'SYSTEM.md')
  await fsp.writeFile(systemFile, '# system\nYou are a worker.')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['profiles', 'create', 'worker', '--system-file', systemFile, '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as Record<string, unknown>
  assert.equal(body['system'], '# system\nYou are a worker.')

  // --input acts as base object; semantic flags override matching fields while preserving others (e.g., cwd)
  const merged = await runCliCaptured(
    [
      'profiles', 'create',
      '--input', '{"id":"x","name":"base","model":"old/m","cwd":"/base","extra":1}',
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

  // Missing all fields rejects explicitly
  const none = await runCliCaptured(['profiles', 'create', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_update_fields')
})

test('profiles update: semantic flags GET existing profile then merge into PUT (prevents dropping fields on full replace)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  // Existing profile config: includes nodeId/cwd/tags/runtime bindings plus full system text
  const existing = {
    id: 'worker',
    name: 'old name',
    model: 'old/m',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['a', 'b'],
    runtime: { kind: 'herdr', agent: 'agy' },
    system: '# full system prompt',
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

  // Only updating --model: GET before PUT ensures PUT retains all binding fields (nodeId/cwd/tags/runtime)
  const r = await runCliCaptured(['profiles', 'update', 'worker', '--model', 'anthropic/sonnet', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const getHit = hub.hits.find((h) => h.method === 'GET' && h.path === '/api/profiles/worker')
  const putHit = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')
  assert.ok(getHit, 'semantic flag path must GET full profile first')
  assert.ok(putHit, 'must PUT merged result')
  assert.ok(hub.hits.indexOf(getHit!) < hub.hits.indexOf(putHit!), 'GET must precede PUT')
  assert.deepEqual(putBody, {
    id: 'worker',
    name: 'old name',
    model: 'anthropic/sonnet',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['a', 'b'],
    runtime: { kind: 'herdr', agent: 'agy' },
  })
  // System prompt returned by GET must not be echoed back when not explicitly modified
  assert.ok(!('system' in (putBody as Record<string, unknown>)))

  // Renaming only --name must likewise preserve nodeId (prevents conversations from falling back to local)
  const rename = await runCliCaptured(['profiles', 'update', 'worker', '--name', 'new name', '--json'], env)
  assert.equal(rename.code, 0, rename.err)
  const lastPut = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.equal(lastPut['name'], 'new name')
  assert.equal(lastPut['nodeId'], 'gpu-box')
  assert.equal(lastPut['cwd'], '/workspace')
  assert.ok(!('system' in lastPut))
})

test('profiles update: explicit --system enters body; --input and semantic flags merge deterministically', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const existing = {
    id: 'worker',
    name: 'base name',
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

  // Explicit --system override (MEMORY.md is managed by builtin:memory, not via Profile)
  const r = await runCliCaptured(
    ['profiles', 'update', 'worker', '--system', 'new system prompt', '--node', 'laptop', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const body = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.equal(body['system'], 'new system prompt')
  assert.equal(body['nodeId'], 'laptop')
  assert.equal(body['name'], 'base name')

  // Combining --input + semantic flags: layers GET base -> --input overrides -> semantic flag overrides without dropping fields
  const merged = await runCliCaptured(
    [
      'profiles', 'update', 'worker',
      '--input', '{"name":"custom name","cwd":"/new-cwd"}',
      '--model', 'new/m',
      '--json',
    ],
    env,
  )
  assert.equal(merged.code, 0, merged.err)
  const body2 = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
  assert.deepEqual(body2, {
    id: 'worker',
    name: 'custom name',
    model: 'new/m',
    nodeId: 'gpu-box', // Preserved from GET base
    cwd: '/new-cwd', // Overridden by --input
  })
})

test('profiles update --input standalone: full-replace semantics (skips GET); rethrows GET 404 verbatim', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      'PUT /api/profiles/worker': (body) => ({ body }),
      'GET /api/profiles/ghost': () => ({ status: 404, body: { error: { code: 'not_found', message: 'profile not found' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // Standalone --input = explicit full replace: no GET; body is --input + id
  const whole = await runCliCaptured(
    ['profiles', 'update', 'worker', '--input', '{"name":"full replace","model":"m"}', '--json'],
    env,
  )
  assert.equal(whole.code, 0, whole.err)
  assert.ok(!hub.hits.some((h) => h.method === 'GET' && h.path === '/api/profiles/worker'), 'standalone --input must not GET')
  assert.deepEqual(hub.hits.at(-1)?.body, { name: 'full replace', model: 'm', id: 'worker' })

  // Missing target with semantic flags: rethrows GET 404 verbatim without fabricating a base object
  const ghost = await runCliCaptured(['profiles', 'update', 'ghost', '--name', 'x', '--json'], env)
  assert.equal(ghost.code, 1)
  assert.equal(parseCliError(ghost).code, 'not_found')

  // Rejects when no fields are given
  const none = await runCliCaptured(['profiles', 'update', 'worker', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_update_fields')
})

// ---------------------------------------------------------------------------
// 5. plugins config --set
// ---------------------------------------------------------------------------

test('plugins config --set: allows repeated key=value pairs with scalar parsing and overrides matching keys in --input', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
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

  // --set overrides matching keys from --input while preserving the rest
  const merged = await runCliCaptured(
    ['plugins', 'config', 'builtin:herdr', '--input', '{"retries":9,"other":"keep"}', '--set', 'retries=1', '--json'],
    env,
  )
  assert.equal(merged.code, 0, merged.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { values: { retries: 1, other: 'keep' } })

  // Without --set or --input: keeps GET semantics
  const get = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--json'], env)
  assert.equal(get.code, 0, get.err)
  assert.equal(hub.hits.at(-1)?.method, 'GET')
  assert.deepEqual(JSON.parse(get.out), { values: { retries: 3 }, schema: {} })

  // Invalid --set (missing =) fails explicitly
  const bad = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--set', 'novalue', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

// ---------------------------------------------------------------------------
// 6. api escape hatch
// ---------------------------------------------------------------------------

test('api GET: case-insensitive method, auto-prepends leading / on path, builds POST body from --field', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      'GET /api/nodes': () => ({ body: NODE_LIST }),
      'POST /api/nodes/issue': () => ({ body: { nodeId: 'dev-1', token: 'dev-1:s', createdAt: 1 } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // Lowercase method + path with leading /
  const list = await runCliCaptured(['api', 'get', '/api/nodes', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.deepEqual(JSON.parse(list.out), NODE_LIST)

  // Mixed-case method + path without leading /
  const list2 = await runCliCaptured(['api', 'Get', 'api/nodes', '--json'], env)
  assert.equal(list2.code, 0, list2.err)
  assert.equal(hub.hits.at(-1)?.method, 'GET')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes')

  const issue = await runCliCaptured(['api', 'POST', '/api/nodes/issue', '--field', 'nodeId=dev-1', '--json'], env)
  assert.equal(issue.code, 0, issue.err)
  assert.equal(hub.hits.at(-1)?.method, 'POST')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/issue')
  assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'dev-1' })

  // Invalid HTTP method fails explicitly
  const bad = await runCliCaptured(['api', 'TRACE', '/api/nodes', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('api PUT: parses --field scalars (number/boolean/string) and passes through whole --input body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      'PUT /api/profiles/p1': (body) => ({ body }),
      'PUT /api/providers': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const fields = await runCliCaptured(
    ['api', 'put', 'api/profiles/p1', '--field', 'n=42', '--field', 'ok=false', '--field', 's=plain text', '--json'],
    env,
  )
  assert.equal(fields.code, 0, fields.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { n: 42, ok: false, s: 'plain text' })

  const whole = await runCliCaptured(['api', 'PUT', '/api/providers', '--input', '[{"id":"g"}]', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.hits.at(-1)?.body, [{ id: 'g' }])
})

// ---------------------------------------------------------------------------
// 7. Dynamic-action fault isolation: core commands remain 100% available when /api/actions returns 500
// ---------------------------------------------------------------------------

test('dynamic-action fault isolation: core commands (nodes/env/plugins) work normally when GET /api/actions returns 500', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub(
    {
      // Manifest endpoint fails (simulating a broken plugin dragging down all actions)
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

  // Core commands match and execute directly without touching /api/actions
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

  // api escape hatch is likewise unaffected
  const api = await runCliCaptured(['api', 'GET', '/api/nodes', '--json'], env)
  assert.equal(api.code, 0, api.err)

  // Only genuine dynamic command paths fetch /api/actions and pass through the 500 error
  const dynamic = await runCliCaptured(['some', 'plugin', 'action', '--json'], env)
  assert.equal(dynamic.code, 1)
  assert.equal(parseCliError(dynamic).code, 'internal_error')
})

test('env exec --stream: abort propagates immediately — arrived frames consumed, non-zero exit, server detects disconnect immediately', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const seenDisconnect = { value: false }
  // NDJSON endpoint stalls after sending one frame; triggers close on abort (verifying CLI closes stream immediately without reading further)
  const hub = await startMockHub(
    {
      'POST /api/env/exec': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'frame-1\n' })}\n`)
        res.on('close', () => {
          seenDisconnect.value = true
        })
        return null // Never closes proactively: only closed when client aborts
      },
    },
    { autoRegisterCleanup: t },
  )
  const ac = new AbortController()
  // Inject AbortSignal via fetch wrapper and abort immediately after consuming the first frame (equivalent to SIGINT abort path)
  const r = await runCliCaptured(['env', 'exec', '--stream', '--', 'sleep', '10'], makeCliEnv(hub.url, dir), {
    onStdout: (chunk) => {
      if (chunk.includes('frame-1')) queueMicrotask(() => ac.abort())
    },
    fetch: (input, init) => fetch(input, { ...init, signal: ac.signal }),
  })
  assert.equal(r.code, 130, `exit code must be 130 (SIGINT convention), got ${r.code}, stderr=${r.err}`)
  assert.equal(r.out, 'frame-1\n', 'frames received before cancellation must already be consumed (true unbuffered streaming)')
  assert.match(r.err, /cancelled/)
  await waitFor(() => seenDisconnect.value, {
    timeoutMs: 2_000,
    intervalMs: 10,
    message: 'cancellation must close the stream immediately without continuing to read',
  })
})

test('help text describes nodes/env/api commands; nodes subcommands do not collide with dynamic commands', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /nodes list/)
  assert.match(help.out, /nodes issue/)
  assert.match(help.out, /nodes remove/)
  assert.match(help.out, /env exec/)
  assert.match(help.out, /api <method> <path>/)

  // nodes list executes through core dispatch even if a dynamic manifest shares the same path (also covered by fault isolation test)
  const nodes = await runCliCaptured(['nodes', 'list'], env)
  assert.equal(nodes.code, 0, nodes.err)
  assert.match(nodes.out, /\(empty\)/)
})

// ---------------------------------------------------------------------------
// 8. Static command table uniqueness assertion (prevents future commands from being shadowed by matchCommand)
// ---------------------------------------------------------------------------

test('static command table: coreCommands paths are unique and prefix-free', { timeout: 60_000 }, () => {
  const commands = coreCommands() // Validates internally; duplicates or prefix conflicts throw command_table_conflict
  const paths = commands.map((c) => c.path.join(' '))
  assert.equal(new Set(paths).size, paths.length, `duplicate static command path: ${JSON.stringify(paths)}`)
  // Prefix-free: a shorter path must never be a prefix of any longer path
  for (const cmd of commands) {
    for (const other of commands) {
      if (cmd === other || other.path.length >= cmd.path.length) continue
      const isPrefix = other.path.every((seg, i) => seg === cmd.path[i])
      assert.equal(isPrefix, false, `command prefix conflict: "${cmd.path.join(' ')}" would shadow "${other.path.join(' ')}"`)
    }
  }
})

// ---------------------------------------------------------------------------
// 9. cli-token lock race: grace window retries empty/truncated lock files; stale leftovers reported as corrupt
// ---------------------------------------------------------------------------

/**
 * Deterministic simulated holder release. A one-shot `rm` can transiently fail on Windows CI
 * (EBUSY/EPERM from antivirus scans or delete-pending handles); a swallowed single failure would
 * strand a live-PID lock and degrade the scenario into the 10s lock-wait timeout instead of the
 * intended "succeeds after holder completes" path. Retry until the file is gone within the budget
 * (kept well below the 10s lock deadline so recovered releases still acquire in time).
 */
async function releaseLockEventually(lockFile: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      await fsp.rm(lockFile, { force: true })
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('cli-token lock: freshly created empty lock file waits during grace window instead of falsely reporting corruption; stale empty lock throws credentials_lock_broken', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const lockFile = path.join(dir, 'cli-token.lock')
  // Scenario 1: simulates legacy fallback where a slow holder creates an empty file first and writes content later:
  // holds empty lock (fresh mtime), writes full owner line at 150ms (spanning at least one 100ms backoff cycle), and releases at 350ms.
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const holderOwner = `${process.pid} holder-uuid`
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${holderOwner}\n`).catch(() => {}) }, 150)
  let releaseErr: unknown
  const releaseTimer = setTimeout(() => { void releaseLockEventually(lockFile).catch((err: unknown) => { releaseErr = err }) }, 350)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:1', token: 'tok' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  if (releaseErr !== undefined) {
    assert.fail(`simulated holder could not release the lock: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok')
  // No leftover lock or temp files remain
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])

  // Scenario 2: stale empty lock (mtime older than grace window with no writer filling it) -> throws credentials_lock_broken rather than pretending lock-free
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await fsp.utimes(lockFile, old, old)
  await assert.rejects(
    updateCliCredentials(dir, { token: 'tok2' }),
    (err: unknown) => err instanceof CliError && err.code === 'credentials_lock_broken',
  )
})

test('cli-token lock: truncated lock content is also protected by grace window and succeeds after holder completes', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-nodes-')
  const lockFile = path.join(dir, 'cli-token.lock')
  // Truncated content (first token is non-PID) + slow holder completing full owner line within grace window before releasing
  await fsp.writeFile(lockFile, 'garbage ', { mode: 0o600 })
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${process.pid} filler\n`).catch(() => {}) }, 150)
  let releaseErr: unknown
  const releaseTimer = setTimeout(() => { void releaseLockEventually(lockFile).catch((err: unknown) => { releaseErr = err }) }, 300)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-half' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  if (releaseErr !== undefined) {
    assert.fail(`simulated holder could not release the lock: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-half')
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})
