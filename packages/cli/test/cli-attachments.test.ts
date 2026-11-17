/**
 * CLI command tests: `artifacts put` / `send --attach` / `conversations reset|compact|fork`.
 * Uses a real HTTP server mocking Hub contract (same pattern as cli.test.ts): verifies paths, methods,
 * headers (`x-artifact-filename` URL encoding, `x-artifact-mime-type`), binary body byte fidelity,
 * --json output, and error envelopes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

// ---------------------------------------------------------------------------
// artifacts put
// ---------------------------------------------------------------------------

test('artifacts put: binary stream upload (octet-stream + encoded filename + byte fidelity)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'data report.md')
  const content = Buffer.from('# title\ncontent line', 'utf8')
  await fsp.writeFile(file, content)
  const hub = await startMockHub(
    {
      'POST /api/conversations/3/artifacts': () => ({
        status: 201,
        body: { id: 'art-1', conversationId: 3, kind: 'upload', name: 'data report.md', size: content.byteLength, mimeType: 'text/markdown', createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '3', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).id, 'art-1')
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.path, '/api/conversations/3/artifacts')
  assert.equal(hit.headers['content-type'], 'application/octet-stream')
  assert.equal(hit.headers['x-artifact-filename'], encodeURIComponent('data report.md'))
  // Binary body bytes match file contents.
  assert.ok(hit.rawBody !== undefined)
  assert.deepEqual([...hit.rawBody!], [...content])
})

test('artifacts put: human output includes [Artifact] id=<id> name=<name> matching timeline detection', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'output.png')
  await fsp.writeFile(file, 'image-binary')
  const hub = await startMockHub(
    {
      'POST /api/conversations/3/artifacts': () => ({
        status: 201,
        body: { id: 'art-img-99', conversationId: 3, kind: 'upload', name: 'output.png', size: 12, mimeType: 'image/png', createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '3'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes('[Artifact] id=art-img-99 name=output.png\n'))
})

test('artifacts put: --name and --mime-type overrides; --current target conversation', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'plain.txt')
  await fsp.writeFile(file, 'abc')
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/artifacts': () => ({
        status: 201,
        body: { id: 'x', conversationId: 7, kind: 'upload', name: 'renamed.bin', path: 'artifacts/7/renamed.bin', mimeType: 'application/x-thing', size: 3, createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['artifacts', 'put', file, '--current', '--name', 'renamed.bin', '--mime-type', 'application/x-thing', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' }),
  )
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.path, '/api/conversations/7/artifacts')
  assert.equal(hit.headers['x-artifact-filename'], 'renamed.bin')
  assert.equal(hit.headers['x-artifact-mime-type'], 'application/x-thing')
})

test('artifacts put: missing file read_failed; directory read_failed; extra positional args error', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const missing = await runCliCaptured(['artifacts', 'put', path.join(dir, 'nope.bin'), '1'], env)
  assert.equal(missing.code, 1)
  assert.ok(missing.err.includes('failed to read upload file'), `stderr should include read diagnostic: ${missing.err}`)
  const dirTarget = await runCliCaptured(['artifacts', 'put', dir, '1'], env)
  assert.equal(dirTarget.code, 1)
  assert.ok(dirTarget.err.includes('is not a regular file'))
  const file = path.join(dir, 'ok.txt')
  await fsp.writeFile(file, 'x')
  const extra = await runCliCaptured(['artifacts', 'put', file, '1', 'junk'], env)
  assert.equal(extra.code, 1)
  assert.ok(extra.err.includes('unexpected positional argument'))
})

test('artifacts put: Hub 413 artifact_too_large envelope exits non-zero', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'big.bin')
  await fsp.writeFile(file, Buffer.alloc(1024))
  const hub = await startMockHub(
    {
      'POST /api/conversations/1/artifacts': () => ({
        status: 413,
        body: { error: { code: 'artifact_too_large', message: 'artifact size exceeds 15 MiB limit' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '1'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('artifact size exceeds 15 MiB limit'), `stderr should include Hub error message: ${r.err}`)
})

// ---------------------------------------------------------------------------
// send --attach
// ---------------------------------------------------------------------------

test('send --attach: comma-separated artifact IDs into body.attachments; empty entries ignored', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', 'inspect', '--attach', 'art-a, art-b ,,art-c', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: 'inspect', attachments: ['art-a', 'art-b', 'art-c'] })

  // --attach empty string: produces no attachments field.
  const r2 = await runCliCaptured(['send', '5', 'without attachment', '--attach', ' , ,', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  const hit2 = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit2.body, { text: 'without attachment' })
})

// ---------------------------------------------------------------------------
// send --replace-from / conversations withdraw
// ---------------------------------------------------------------------------

test('send --replace-from: sends positive integer in body.replaceFromEntryId; rejects invalid values; omitted by default', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', 'rewrite message', '--replace-from', '12', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: 'rewrite message', replaceFromEntryId: 12 })

  // Default: omits replaceFromEntryId.
  const r2 = await runCliCaptured(['send', '5', 'regular submission', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { text: 'regular submission' })

  // Invalid values: 0, negative integers, decimals.
  for (const bad of ['0', '-4', '2.5']) {
    const r3 = await runCliCaptured(['send', '5', 'x', '--replace-from', bad], env)
    assert.equal(r3.code, 1, `--replace-from ${bad} should exit non-zero`)
    assert.ok(r3.err.includes('--replace-from must be a positive integer'), `stderr should contain diagnostic: ${r3.err}`)
  }
})

test('conversations withdraw: requires --submission-id in body; supports --current; rejects invalid values', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/6/withdraw': () => ({ body: { status: 'withdrawn' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['conversations', 'withdraw', '6', '--submission-id', '33', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).status, 'withdrawn')
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.path, '/api/conversations/6/withdraw')
  assert.deepEqual(hit.body, { submissionId: 33 })

  // --current targets the conversation.
  const r2 = await runCliCaptured(
    ['conversations', 'withdraw', '--current', '--submission-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '6' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/6/withdraw')
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { submissionId: 8 })

  // Missing --submission-id: required option check.
  const r3 = await runCliCaptured(['conversations', 'withdraw', '6'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('missing required option --submission-id'))

  // Invalid values: 0 / decimal / negative.
  for (const bad of ['0', '1.5', '-2']) {
    const r4 = await runCliCaptured(['conversations', 'withdraw', '6', '--submission-id', bad], env)
    assert.equal(r4.code, 1, `--submission-id ${bad} should exit non-zero`)
    assert.ok(r4.err.includes('--submission-id must be a positive integer'), `stderr should contain diagnostic: ${r4.err}`)
  }
})

// ---------------------------------------------------------------------------
// conversations reset / compact / fork
// ---------------------------------------------------------------------------

test('conversations reset: sends handoff in body; supports --current; empty body allowed', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/9/reset': () => ({ body: { id: 9, status: 'idle' } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['conversations', 'reset', '9', '--handoff', 'handover text', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { handoff: 'handover text' })

  const r2 = await runCliCaptured(
    ['conversations', 'reset', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/9/reset')
  // Without handoff: body is an empty object.
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations compact: sends instructions in body; supports --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/12/compact': () => ({ status: 202, body: { taskId: 77, conversation: { id: 12 } } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['conversations', 'compact', '12', '--instructions', 'keep architectural decisions', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).taskId, 77)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { instructions: 'keep architectural decisions' })

  const r2 = await runCliCaptured(
    ['conversations', 'compact', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations fork: requires --entry-id in body; --title optional; supports --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/4/fork': () => ({ status: 201, body: { id: 44, title: 't (fork)' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['conversations', 'fork', '4', '--entry-id', '33', '--title', 'new fork', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 33, title: 'new fork' })

  const r2 = await runCliCaptured(
    ['conversations', 'fork', '--current', '--entry-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '4' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 8 })

  // Missing --entry-id: required option check.
  const r3 = await runCliCaptured(['conversations', 'fork', '4'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('missing required option --entry-id'))
})
